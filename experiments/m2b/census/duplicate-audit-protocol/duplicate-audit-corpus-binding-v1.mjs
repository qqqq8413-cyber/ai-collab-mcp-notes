/**
 * CBRP-DUPLICATE-AUDIT-DUP-R00-CORPUS-BINDING-1
 *
 * Mechanically binds DUP-R00 to the exact canonical 60-task population that
 * passed Structural Review ROUND_2 -- closing the "LIVE accepts caller-
 * supplied corpus content" gap CWP-12C exists to close. Frozen by CWP-12C;
 * see CBRP_CORPUS_DUPLICATE_AUDIT_PROTOCOL_1.md §14's "Current DUP-R00 input
 * population" note.
 *
 * Two layers, deliberately separated:
 *
 *   validateCanonicalDupR00Corpus   pure function of already-loaded source
 *                                   data -- no filesystem access, so every
 *                                   failure mode (wrong count, altered hash,
 *                                   unresolved decision, ...) is testable
 *                                   with synthetic fixtures, never by
 *                                   mutating the real committed evidence.
 *
 *   loadCanonicalDupR00Corpus       reads the three real committed evidence
 *                                   files and calls the pure validator. This
 *                                   is what the real LIVE entrypoint calls;
 *                                   it has no parameters to override with,
 *                                   by construction.
 *
 * This module never calls a provider and never judges task content -- it
 * only mechanically verifies provenance and assembles the model-visible
 * {candidateId, taskText} pairs, exactly as §4.2 requires (no stratum, no
 * author identity, no review outcome, no hashes, in the pairs it returns).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const BINDING_VERSION = 'CBRP-DUPLICATE-AUDIT-DUP-R00-CORPUS-BINDING-1';
export const CANONICAL_AUTHORING_RUN_ID = 'CBRP-AUTHORING-V2P1-ROUND-0';
export const CANONICAL_CANDIDATE_COUNT = 60;
export const CANONICAL_STRUCTURAL_ROUND_ID = 'ROUND_2';
export const CANONICAL_STRUCTURAL_STATUS = 'R3_COMPLETE';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(DIR, '../../../..');

export const CANONICAL_AUTHORING_PATH = 'experiments/m2b/census/authoring-v2p1-round-0/CANDIDATES.json';
export const CANONICAL_FINAL_DECISIONS_PATH = 'experiments/m2b/census/structural-review-round-2/FINAL_DECISIONS.json';
export const CANONICAL_VALIDATION_PATH = 'experiments/m2b/census/structural-review-round-2/VALIDATION.json';

const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const sha256Bytes = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

/**
 * Reads the three real committed evidence files this repository's Structural
 * Review ROUND_2 actually produced. Pure I/O, no validation -- a read
 * failure (missing file, unparseable JSON) propagates as a thrown error,
 * matching this codebase's existing convention for evidence loaders
 * (`structural-review-live-harness-v1.mjs`'s `captureRuntimeSnapshot` does
 * not catch `fs` errors either).
 */
export function loadCanonicalDupR00Sources() {
  const authoringBuffer = fs.readFileSync(path.join(REPO_ROOT, CANONICAL_AUTHORING_PATH));
  const finalDecisionsBuffer = fs.readFileSync(path.join(REPO_ROOT, CANONICAL_FINAL_DECISIONS_PATH));
  const validationBuffer = fs.readFileSync(path.join(REPO_ROOT, CANONICAL_VALIDATION_PATH));
  return {
    authoring: JSON.parse(authoringBuffer.toString('utf8')),
    finalDecisions: JSON.parse(finalDecisionsBuffer.toString('utf8')),
    validation: JSON.parse(validationBuffer.toString('utf8')),
    sourceHashes: {
      [CANONICAL_AUTHORING_PATH]: sha256Bytes(authoringBuffer),
      [CANONICAL_FINAL_DECISIONS_PATH]: sha256Bytes(finalDecisionsBuffer),
      [CANONICAL_VALIDATION_PATH]: sha256Bytes(validationBuffer),
    },
  };
}

/**
 * The ten-point mechanical check (CWP-12C §A), pure: takes already-parsed
 * source data and returns `{ ok: false, code, reason }` on the first
 * violation, or `{ ok: true, corpusTasks, corpusTaskIds }` -- the model-
 * visible pairs, sorted ascending lexicographic by `candidateId` (§5),
 * containing only `candidateId`/`taskText` and nothing else -- once every
 * check has passed. No candidate can reach the returned `corpusTasks` except
 * by being a member of the exact intersection checks 3/7 already proved
 * identical (point 10: "no candidate outside that exact intersection enters
 * DUP-R00").
 *
 * @param {{ authoring: object, finalDecisions: object, validation: object }} sources
 */
export function validateCanonicalDupR00Corpus({ authoring, finalDecisions, validation }) {
  // 1. authoring run is the Protocol-2.1 population
  if (authoring?.runId !== CANONICAL_AUTHORING_RUN_ID) {
    return { ok: false, code: 'STOP_CORPUS_RUN_ID_MISMATCH', reason: `authoring runId ${JSON.stringify(authoring?.runId)} != ${JSON.stringify(CANONICAL_AUTHORING_RUN_ID)}` };
  }
  const candidates = authoring?.candidates;
  if (!Array.isArray(candidates)) {
    return { ok: false, code: 'STOP_CORPUS_SHAPE_INVALID', reason: 'authoring.candidates must be an array' };
  }
  // 2. exactly 60 candidates
  if (candidates.length !== CANONICAL_CANDIDATE_COUNT) {
    return { ok: false, code: 'STOP_CORPUS_COUNT_MISMATCH', reason: `candidate count ${candidates.length} != ${CANONICAL_CANDIDATE_COUNT}` };
  }
  // 3. candidate IDs are unique
  const authoringIds = candidates.map((c) => c.taskCandidateId);
  if (new Set(authoringIds).size !== authoringIds.length) {
    return { ok: false, code: 'STOP_CORPUS_ID_NOT_UNIQUE', reason: 'authoring candidate IDs are not unique' };
  }
  // 4/5/6. non-empty taskText, matching taskSha256, matching taskBytes
  for (const [i, c] of candidates.entries()) {
    if (typeof c.taskText !== 'string' || c.taskText.length === 0) {
      return { ok: false, code: 'STOP_CORPUS_TASK_TEXT_EMPTY', reason: `candidates[${i}] (${c.taskCandidateId}) has an empty/non-string taskText` };
    }
    if (sha256(c.taskText) !== c.taskSha256) {
      return { ok: false, code: 'STOP_CORPUS_HASH_MISMATCH', reason: `candidates[${i}] (${c.taskCandidateId}) taskText does not match its committed taskSha256` };
    }
    if (Buffer.byteLength(c.taskText, 'utf8') !== c.taskBytes) {
      return { ok: false, code: 'STOP_CORPUS_BYTES_MISMATCH', reason: `candidates[${i}] (${c.taskCandidateId}) taskText does not match its committed taskBytes` };
    }
  }

  const decisions = finalDecisions?.decisions;
  if (!Array.isArray(decisions)) {
    return { ok: false, code: 'STOP_CORPUS_SHAPE_INVALID', reason: 'finalDecisions.decisions must be an array' };
  }
  // 7. structural FINAL_DECISIONS contains exactly the same 60 candidate IDs
  const decisionIds = decisions.map((d) => d.taskCandidateId);
  const authoringIdSet = new Set(authoringIds);
  const decisionIdSet = new Set(decisionIds);
  if (decisionIds.length !== authoringIds.length
      || decisionIdSet.size !== decisionIds.length
      || authoringIds.some((id) => !decisionIdSet.has(id))
      || decisionIds.some((id) => !authoringIdSet.has(id))) {
    return { ok: false, code: 'STOP_CORPUS_DECISION_ID_MISMATCH', reason: 'FINAL_DECISIONS candidate ID set != authoring candidate ID set' };
  }
  // 8. all 60 decisions: status = FINAL, finalPass = true
  for (const [i, d] of decisions.entries()) {
    if (d.status !== 'FINAL' || d.finalPass !== true) {
      return { ok: false, code: 'STOP_CORPUS_DECISION_NOT_FINAL', reason: `decisions[${i}] (${d.taskCandidateId}) is not FINAL/finalPass=true (status=${JSON.stringify(d.status)}, finalPass=${JSON.stringify(d.finalPass)})` };
    }
  }
  // 9. Structural Review validation is ROUND_2 / R3_COMPLETE / 60 final / 0 pending
  if (validation?.roundId !== CANONICAL_STRUCTURAL_ROUND_ID) {
    return { ok: false, code: 'STOP_STRUCTURAL_STATUS_INVALID', reason: `validation.roundId ${JSON.stringify(validation?.roundId)} != ${JSON.stringify(CANONICAL_STRUCTURAL_ROUND_ID)}` };
  }
  if (validation?.status !== CANONICAL_STRUCTURAL_STATUS) {
    return { ok: false, code: 'STOP_STRUCTURAL_STATUS_INVALID', reason: `validation.status ${JSON.stringify(validation?.status)} != ${JSON.stringify(CANONICAL_STRUCTURAL_STATUS)}` };
  }
  if (validation?.finalDecisionCount !== CANONICAL_CANDIDATE_COUNT) {
    return { ok: false, code: 'STOP_STRUCTURAL_STATUS_INVALID', reason: `validation.finalDecisionCount ${JSON.stringify(validation?.finalDecisionCount)} != ${CANONICAL_CANDIDATE_COUNT}` };
  }
  const pendingCount = decisions.filter((d) => d.status !== 'FINAL').length;
  if (pendingCount !== 0) {
    return { ok: false, code: 'STOP_STRUCTURAL_STATUS_INVALID', reason: `${pendingCount} decision(s) are not FINAL (unresolved/pending)` };
  }

  // 10. no candidate outside the proven authoring<->decision intersection
  // enters DUP-R00 -- constructed only from `candidates`, already proven
  // identical in ID set to `decisions` above.
  const corpusTasks = [...candidates]
    .map((c) => ({ candidateId: c.taskCandidateId, taskText: c.taskText }))
    .sort((x, y) => (x.candidateId < y.candidateId ? -1 : x.candidateId > y.candidateId ? 1 : 0));
  const corpusTaskIds = corpusTasks.map((t) => t.candidateId);

  return { ok: true, corpusTasks, corpusTaskIds };
}

/**
 * Reads the real committed evidence and validates it. Throws (does not
 * return a fail-closed value) on any violation -- this is the function the
 * real LIVE entrypoint calls, and a thrown error there becomes a STOP before
 * any transport call, consistent with how `assertRuntimeSnapshot` and the
 * other pre-dispatch guards in `duplicate-audit-live-harness-v1.mjs` behave.
 */
export function loadCanonicalDupR00Corpus() {
  const sources = loadCanonicalDupR00Sources();
  const result = validateCanonicalDupR00Corpus(sources);
  if (!result.ok) {
    const error = new Error(`${result.code}: ${result.reason}`);
    error.code = result.code;
    throw error;
  }
  return { ...result, sourceHashes: sources.sourceHashes };
}

/**
 * Asserts the DUP-R00 scope invariant (§B): for DUP-R00 only, the audit
 * scope is the complete canonical set of all 60 candidate IDs -- corpus
 * count 60, scope count 60, scope set exactly equal to the corpus ID set,
 * and a pair universe of exactly 1770 canonical (`a < b`) pairs. Defense in
 * depth: by construction the real entrypoint always derives
 * `auditScopeIds` from `corpusTaskIds` directly, so this should never fail
 * in practice, but a future code change that broke that construction must
 * fail closed here rather than silently dispatch a narrower/wider scope.
 *
 * @param {{ corpusTaskIds: string[], auditScopeIds: string[],
 *           pairUniverse: Array<{a: string, b: string}> }} input
 */
export function assertDupR00ScopeInvariant({ corpusTaskIds, auditScopeIds, pairUniverse }) {
  if (corpusTaskIds.length !== CANONICAL_CANDIDATE_COUNT) {
    const error = new Error(`STOP_SCOPE_INVALID: corpus count ${corpusTaskIds.length} != ${CANONICAL_CANDIDATE_COUNT}`);
    error.code = 'STOP_SCOPE_INVALID';
    throw error;
  }
  if (auditScopeIds.length !== CANONICAL_CANDIDATE_COUNT) {
    const error = new Error(`STOP_SCOPE_INVALID: scope count ${auditScopeIds.length} != ${CANONICAL_CANDIDATE_COUNT}`);
    error.code = 'STOP_SCOPE_INVALID';
    throw error;
  }
  const corpusSet = new Set(corpusTaskIds);
  const scopeSet = new Set(auditScopeIds);
  const setsEqual = corpusSet.size === scopeSet.size && [...corpusSet].every((id) => scopeSet.has(id));
  if (!setsEqual) {
    const error = new Error('STOP_SCOPE_INVALID: auditScopeIds set != corpusTaskIds set');
    error.code = 'STOP_SCOPE_INVALID';
    throw error;
  }
  if (pairUniverse.length !== 1770) {
    const error = new Error(`STOP_SCOPE_INVALID: pair universe ${pairUniverse.length} != 1770`);
    error.code = 'STOP_SCOPE_INVALID';
    throw error;
  }
  for (const { a, b } of pairUniverse) {
    if (!(a < b)) {
      const error = new Error(`STOP_SCOPE_INVALID: pair (${a}, ${b}) is not canonically ordered`);
      error.code = 'STOP_SCOPE_INVALID';
      throw error;
    }
  }
  return true;
}
