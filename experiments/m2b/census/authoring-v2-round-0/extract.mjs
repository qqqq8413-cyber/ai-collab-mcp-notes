/** Mechanical extraction only. No scenario text or declared label is rewritten. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const RUN_ID = 'CBRP-AUTHORING-V2-ROUND-0';
const STRATA = new Map([
  ['Strategy / Commitment', 'SC'],
  ['Operations / Execution', 'OP'],
  ['Brand / Creative', 'BC'],
  ['Evidence Interpretation', 'EI'],
  ['Product / Service Design', 'PS'],
  ['Finance / Resource Allocation', 'FR'],
]);
const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const unwrap = (raw) => {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*)\r?\n```$/i);
  return { payload: match ? match[1] : trimmed, unwrappedFence: Boolean(match) };
};

const sessions = JSON.parse(fs.readFileSync(path.join(DIR, 'SESSIONS.json'), 'utf8'));

const allCandidates = [];
const perSession = [];
const problems = [];
for (const session of sessions.sessions) {
  const sid = session.actualAuthorSessionId;
  const blockMatch = sid.match(/^AUTHOR2-(B\d{2})-S00$/);
  if (!blockMatch) throw new Error(`invalid v2 initial session id: ${sid}`);
  const raw = fs.readFileSync(path.join(DIR, 'raw', `${sid}.txt`), 'utf8');
  if (sha256(raw) !== session.rawResponseSha256) problems.push(`${sid}: raw response hash mismatch`);
  const { payload, unwrappedFence } = unwrap(raw);
  let parsed;
  try { parsed = JSON.parse(payload); }
  catch (error) {
    problems.push(`${sid}: JSON.parse failed: ${error.message}`);
    perSession.push({ actualAuthorSessionId: sid, outcome: session.outcome, candidateCount: 0, extractionError: error.message });
    continue;
  }
  if (!Array.isArray(parsed)) { problems.push(`${sid}: payload is not an array`); continue; }

  const counters = new Map();
  const candidates = [];
  parsed.forEach((entry, index) => {
    if (typeof entry?.stratum !== 'string' || typeof entry?.text !== 'string') {
      problems.push(`${sid}[${index}]: missing string stratum/text`);
      return;
    }
    const code = STRATA.get(entry.stratum);
    if (!code) { problems.push(`${sid}[${index}]: invalid stratum ${JSON.stringify(entry.stratum)}`); return; }
    const number = (counters.get(code) ?? 0) + 1;
    counters.set(code, number);
    candidates.push({
      taskCandidateId: `V2-${blockMatch[1]}-S00-${code}-${String(number).padStart(2, '0')}`,
      authorBlockId: session.authorBlockId,
      actualAuthorSessionId: sid,
      stratumDeclaredByAuthor: entry.stratum,
      stratumCode: code,
      indexInResponse: index,
      taskText: entry.text,
      taskSha256: sha256(entry.text),
      taskBytes: Buffer.byteLength(entry.text, 'utf8'),
    });
  });

  const counts = Object.fromEntries([...STRATA.values()].map((code) => [code, candidates.filter((candidate) => candidate.stratumCode === code).length]));
  if (candidates.length !== 12) problems.push(`${sid}: ${candidates.length} candidates, expected 12`);
  for (const [code, count] of Object.entries(counts)) if (count !== 2) problems.push(`${sid}: ${code} count ${count}, expected 2`);
  fs.writeFileSync(path.join(DIR, 'candidates', `${sid}.json`), JSON.stringify({ actualAuthorSessionId: sid, unwrappedFence, candidates }, null, 2) + '\n', 'utf8');
  perSession.push({ actualAuthorSessionId: sid, outcome: session.outcome, unwrappedFence, candidateCount: candidates.length, stratumCounts: counts });
  allCandidates.push(...candidates);
}

const ids = allCandidates.map((candidate) => candidate.taskCandidateId);
const globalStratumCounts = Object.fromEntries([...STRATA.values()].map((code) => [code, allCandidates.filter((candidate) => candidate.stratumCode === code).length]));
if (allCandidates.length !== 60) problems.push(`total ${allCandidates.length}, expected 60`);
for (const [code, count] of Object.entries(globalStratumCounts)) if (count !== 10) problems.push(`${code} count ${count}, expected 10`);
if (new Set(ids).size !== ids.length) problems.push('candidate ids are not unique');
for (const candidate of allCandidates) {
  if (sha256(candidate.taskText) !== candidate.taskSha256) problems.push(`${candidate.taskCandidateId}: task hash mismatch`);
  if (Buffer.byteLength(candidate.taskText, 'utf8') !== candidate.taskBytes) problems.push(`${candidate.taskCandidateId}: task byte count mismatch`);
}

const validation = {
  runId: RUN_ID,
  protocolVersion: sessions.protocolVersion,
  briefVersion: sessions.briefVersion,
  promptSha256: sessions.promptSha256,
  promptBytes: sessions.promptBytes,
  sessionsParsed: perSession.length,
  perSession,
  totalCandidates: allCandidates.length,
  globalStratumCounts,
  candidateIdsUnique: new Set(ids).size === ids.length,
  candidateHashesComplete: allCandidates.every((candidate) => /^[0-9a-f]{64}$/.test(candidate.taskSha256)),
  rawToParsedPreservation: problems.length === 0 ? '60/60' : `${allCandidates.length}/${allCandidates.length} extracted candidates preserved; acquisition incomplete (${allCandidates.length}/60)`,
  scenarioTextRewritten: false,
  semanticJudgementsPerformed: false,
  literalScan: 'NOT_RUN',
  mechanicalStatus: problems.length === 0 ? 'PASS' : 'FAIL',
  problems,
};
fs.writeFileSync(path.join(DIR, 'CANDIDATES.json'), JSON.stringify({
  runId: RUN_ID,
  status: problems.length === 0
    ? '60 V2 PROVISIONAL / UNREVIEWED CANDIDATES'
    : 'INCOMPLETE / PARTIAL V2 PROVISIONAL EVIDENCE / UNREVIEWED / NOT ADMISSIBLE',
  candidates: allCandidates,
}, null, 2) + '\n', 'utf8');
fs.writeFileSync(path.join(DIR, 'VALIDATION.json'), JSON.stringify(validation, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(validation, null, 2));
process.exit(problems.length === 0 ? 0 : 1);
