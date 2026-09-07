/**
 * Deterministic extraction of provisional CBRP candidates from the preserved raw
 * authoring responses. Offline: reads only what is already on disk.
 *
 * Scenario text is never altered. The only transformation permitted here is removing the
 * fenced-code wrapper around the declared JSON response format and reading the two
 * declared fields. No wording, grammar, category, length or content is touched, and no
 * structural judgement is made — those belong to the blinded reviewers.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));

/** The six frozen strata, with the codes used in provisional ids. Spelling is exact. */
const STRATA = new Map([
  ['Strategy / Commitment', 'SC'],
  ['Operations / Execution', 'OP'],
  ['Brand / Creative', 'BC'],
  ['Evidence Interpretation', 'EI'],
  ['Product / Service Design', 'PS'],
  ['Finance / Resource Allocation', 'FR'],
]);

/** Descriptive only. A hit is recorded as evidence for the reviewers, never acted on. */
const FORBIDDEN_LITERALS = [
  'claude', 'gemini', 'openai', 'gpt', 'anthropic', 'chatgpt', 'copilot', 'llm',
  'specialist', 'expert panel', 'ai assistant', 'language model',
];

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * Splits literal hits into whole-word matches and substring artifacts.
 *
 * A bare `includes` reports "llm" inside "fulfillment" and "anthropic" inside
 * "philanthropic", which would put false leakage evidence in front of a reviewer. Both
 * lists are kept: the artifacts are recorded so the scan itself stays auditable.
 */
function scanLiterals(text) {
  const wholeWord = [];
  const substringOnly = [];
  for (const term of FORBIDDEN_LITERALS) {
    if (!text.toLowerCase().includes(term)) continue;
    // Word-START boundary only, so inflections count ("specialists") while interior
    // coincidences do not ("fulfillment", "philanthropic").
    const boundary = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
    (boundary.test(text) ? wholeWord : substringOnly).push(term);
  }
  return { wholeWord, substringOnly };
}

const sessions = JSON.parse(fs.readFileSync(path.join(DIR, 'SESSIONS.json'), 'utf8'));

/** Strips a fenced wrapper if and only if the whole payload is one fenced block. */
function unwrap(raw) {
  const trimmed = raw.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*)\n```$/;
  const match = trimmed.match(fence);
  return match ? { text: match[1], unwrapped: true } : { text: trimmed, unwrapped: false };
}

const allCandidates = [];
const perSession = [];
const problems = [];

for (const session of sessions.sessions) {
  const sid = session.actualAuthorSessionId;
  const block = session.authorBlockId.replace('AUTHOR-', '');
  const raw = fs.readFileSync(path.join(DIR, 'raw', `${sid}.txt`), 'utf8');
  const { text: payload, unwrapped } = unwrap(raw);

  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    problems.push(`${sid}: JSON.parse failed — ${error.message}`);
    continue;
  }
  if (!Array.isArray(parsed)) {
    problems.push(`${sid}: payload is not a JSON array`);
    continue;
  }

  const counters = new Map();
  const candidates = [];
  parsed.forEach((entry, index) => {
    const declared = entry?.stratum;
    const taskText = entry?.text;
    if (typeof declared !== 'string' || typeof taskText !== 'string') {
      problems.push(`${sid}[${index}]: missing string stratum/text`);
      return;
    }
    const code = STRATA.get(declared);
    if (!code) {
      problems.push(`${sid}[${index}]: unknown stratum ${JSON.stringify(declared)}`);
      return;
    }
    // Numbered by order of appearance — the only outcome-blind ordering available.
    const n = (counters.get(code) ?? 0) + 1;
    counters.set(code, n);

    const literalHits = scanLiterals(taskText);
    candidates.push({
      taskCandidateId: `${block}-S00-${code}-${String(n).padStart(2, '0')}`,
      authorBlockId: session.authorBlockId,
      actualAuthorSessionId: sid,
      stratumDeclaredByAuthor: declared,
      stratumCode: code,
      indexInResponse: index,
      taskText,
      taskSha256: sha256(taskText),
      taskBytes: Buffer.byteLength(taskText, 'utf8'),
      wordCount: taskText.trim().split(/\s+/).length,
      forbiddenLiteralHits: literalHits.wholeWord,
      substringArtifacts: literalHits.substringOnly,
    });
  });

  fs.writeFileSync(
    path.join(DIR, 'candidates', `${sid}.json`),
    JSON.stringify({ actualAuthorSessionId: sid, unwrappedFence: unwrapped, candidates }, null, 2) + '\n',
    'utf8'
  );

  const counts = {};
  for (const [, code] of STRATA) counts[code] = candidates.filter((c) => c.stratumCode === code).length;
  perSession.push({ actualAuthorSessionId: sid, unwrappedFence: unwrapped, count: candidates.length, stratumCounts: counts });
  allCandidates.push(...candidates);
}

// ---- purely mechanical invariants; no structural judgement anywhere below ----
const ids = allCandidates.map((c) => c.taskCandidateId);
const globalStratumCounts = {};
for (const [, code] of STRATA) globalStratumCounts[code] = allCandidates.filter((c) => c.stratumCode === code).length;

for (const s of perSession) {
  if (s.count !== 12) problems.push(`${s.actualAuthorSessionId}: ${s.count} candidates, expected 12`);
  for (const [code, n] of Object.entries(s.stratumCounts)) {
    if (n !== 2) problems.push(`${s.actualAuthorSessionId}: ${code} has ${n}, expected 2`);
  }
}
if (allCandidates.length !== 60) problems.push(`total ${allCandidates.length}, expected 60`);
for (const [code, n] of Object.entries(globalStratumCounts)) {
  if (n !== 10) problems.push(`stratum ${code} has ${n}, expected 10`);
}
if (new Set(ids).size !== ids.length) problems.push('duplicate provisional candidate ids');
if (allCandidates.some((c) => !/^[0-9a-f]{64}$/.test(c.taskSha256))) problems.push('malformed taskSha256');

const duplicateTextHashes = Object.entries(
  allCandidates.reduce((acc, c) => ((acc[c.taskSha256] = (acc[c.taskSha256] ?? 0) + 1), acc), {})
).filter(([, n]) => n > 1);

const validation = {
  runId: 'CBRP-AUTHORING-ROUND-0',
  authoringBriefSha256: sessions.authoringBriefSha256,
  sessionsParsed: perSession.length,
  perSession,
  totalCandidates: allCandidates.length,
  globalStratumCounts,
  idsUnique: new Set(ids).size === ids.length,
  hashesComplete: allCandidates.every((c) => /^[0-9a-f]{64}$/.test(c.taskSha256)),
  byteIdenticalTextPairs: duplicateTextHashes.length,
  forbiddenLiteralWholeWordCount: allCandidates.filter((c) => c.forbiddenLiteralHits.length > 0).length,
  forbiddenLiteralWholeWordIds: allCandidates.filter((c) => c.forbiddenLiteralHits.length > 0)
    .map((c) => ({ id: c.taskCandidateId, hits: c.forbiddenLiteralHits })),
  substringArtifactCount: allCandidates.filter((c) => c.substringArtifacts.length > 0).length,
  literalScanDisposition:
    'DESCRIPTIVE EVIDENCE ONLY. Recorded for the blinded structural reviewers under ' +
    'CWP-9A §14. Claude Code made no admission, rejection or leakage judgement.',
  wordCountRange: [Math.min(...allCandidates.map((c) => c.wordCount)), Math.max(...allCandidates.map((c) => c.wordCount))],
  mechanicalStatus: problems.length === 0 ? 'PASS' : 'FAIL',
  problems,
};

fs.writeFileSync(path.join(DIR, 'VALIDATION.json'), JSON.stringify(validation, null, 2) + '\n', 'utf8');
fs.writeFileSync(
  path.join(DIR, 'CANDIDATES.json'),
  JSON.stringify({ runId: 'CBRP-AUTHORING-ROUND-0', status: 'PROVISIONAL / UNREVIEWED', candidates: allCandidates }, null, 2) + '\n',
  'utf8'
);

console.log(JSON.stringify({ ...validation, perSession: undefined }, null, 2));
process.exit(problems.length === 0 ? 0 : 1);
