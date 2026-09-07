/**
 * Independent standard-library cross-check of CBRP-AUTHORING-V2P1-ROUND-0.
 *
 * Deliberately does NOT import extractCbrpAuthorResponse — it re-derives the candidate
 * set from the raw response bytes using only node:fs, node:crypto and JSON.parse, so
 * that a defect in the extractor module itself would not silently confirm its own
 * output. Read-only: writes CROSS_CHECK.json and touches nothing else.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const STRATA = new Set([
  'Strategy / Commitment', 'Operations / Execution', 'Brand / Creative',
  'Evidence Interpretation', 'Product / Service Design', 'Finance / Resource Allocation',
]);

/** From-scratch unwrap, independent of cbrp-author-extractor.mjs's own implementation. */
function independentUnwrap(raw) {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*)\r?\n```$/i);
  if (fenced) return { payload: fenced[1].trim(), form: 'FENCED' };
  return { payload: trimmed, form: 'PLAIN' };
}

const sessions = JSON.parse(fs.readFileSync(path.join(DIR, 'SESSIONS.json'), 'utf8'));
const officialCandidates = JSON.parse(fs.readFileSync(path.join(DIR, 'CANDIDATES.json'), 'utf8')).candidates;

const problems = [];
let recovered = 0;
const stratumTotals = {};

for (const s of sessions.sessions) {
  const sid = s.actualAuthorSessionId;
  const raw = fs.readFileSync(path.join(DIR, 'raw', `${sid}.txt`), 'utf8');
  if (sha256(raw) !== s.rawResponseSha256) problems.push(`${sid}: raw bytes do not match recorded rawResponseSha256`);

  const { payload } = independentUnwrap(raw);
  let arr;
  try { arr = JSON.parse(payload); }
  catch (e) { problems.push(`${sid}: independent JSON.parse failed: ${e.message}`); continue; }
  if (!Array.isArray(arr)) { problems.push(`${sid}: payload is not an array`); continue; }

  const official = officialCandidates.filter((c) => c.actualAuthorSessionId === sid);
  if (arr.length !== official.length) {
    problems.push(`${sid}: independent count ${arr.length} != official ${official.length}`);
  }
  arr.forEach((entry, i) => {
    recovered += 1;
    if (!STRATA.has(entry.stratum)) problems.push(`${sid}[${i}]: undeclared stratum ${JSON.stringify(entry.stratum)}`);
    stratumTotals[entry.stratum] = (stratumTotals[entry.stratum] ?? 0) + 1;
    const match = official[i];
    if (!match) { problems.push(`${sid}[${i}]: no official record at this index`); return; }
    if (entry.stratum !== match.stratumDeclaredByAuthor) problems.push(`${sid}[${i}]: stratum mismatch`);
    if (entry.text !== match.taskText) problems.push(`${sid}[${i}]: text mismatch`);
    if (sha256(entry.text) !== match.taskSha256) problems.push(`${sid}[${i}]: taskSha256 does not recompute`);
  });
}

const result = {
  runId: sessions.runId,
  method: 'independent re-implementation, no import of cbrp-author-extractor.mjs',
  officialCandidateCount: officialCandidates.length,
  independentlyRecoveredCount: recovered,
  countsMatch: recovered === officialCandidates.length,
  stratumTotals,
  problems,
  status: problems.length === 0 ? 'CROSS_CHECK_PASS' : 'CROSS_CHECK_FAIL',
};

fs.writeFileSync(path.join(DIR, 'CROSS_CHECK.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(result, null, 2));
process.exit(problems.length === 0 ? 0 : 1);
