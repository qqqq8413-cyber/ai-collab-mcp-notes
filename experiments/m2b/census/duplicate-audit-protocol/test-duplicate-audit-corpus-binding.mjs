/** Offline-only synthetic verification for the DUP-R00 corpus binding (CWP-12C). */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  BINDING_VERSION,
  CANONICAL_AUTHORING_RUN_ID,
  CANONICAL_CANDIDATE_COUNT,
  CANONICAL_STRUCTURAL_ROUND_ID,
  CANONICAL_STRUCTURAL_STATUS,
  CANONICAL_AUTHORING_PATH,
  CANONICAL_FINAL_DECISIONS_PATH,
  CANONICAL_VALIDATION_PATH,
  loadCanonicalDupR00Sources,
  loadCanonicalDupR00Corpus,
  validateCanonicalDupR00Corpus,
  assertDupR00ScopeInvariant,
} from './duplicate-audit-corpus-binding-v1.mjs';
import { computePairUniverse } from './duplicate-audit-order-v1.mjs';
import { buildDupR00PreflightManifest, PREFLIGHT_VERSION } from './duplicate-audit-preflight-v1.mjs';
import { CALL_BUDGET, DUP_R00_GENERATION_ENVELOPES } from './duplicate-audit-runner.mjs';
import {
  DUP_R00_ROUND_ID,
  dispatchLiveDuplicateAudit,
  D1D2_STAGE,
  D3_STAGE,
  DuplicateAuditStop,
} from './duplicate-audit-live-harness-v1.mjs';

const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
    passed += 1;
  } catch (error) {
    console.log(`  FAIL ${name}\n      ${error.stack}`);
    failed += 1;
  }
}

// --- Synthetic fixture builder -- independent of the real committed evidence ---

function makeFixture(n, overrides = {}) {
  const candidates = [];
  const decisions = [];
  for (let i = 0; i < n; i += 1) {
    const candidateId = `SYN-T-${String(i).padStart(3, '0')}`;
    const taskText = `Synthetic decision scenario ${i}; corpus-binding fixture only.`;
    candidates.push({
      taskCandidateId: candidateId,
      taskText,
      taskBytes: Buffer.byteLength(taskText, 'utf8'),
      taskSha256: sha256(taskText),
    });
    decisions.push({ taskCandidateId: candidateId, status: 'FINAL', finalPass: true });
  }
  return {
    authoring: { runId: CANONICAL_AUTHORING_RUN_ID, status: 'synthetic', candidates, ...(overrides.authoring ?? {}) },
    finalDecisions: { decisions, ...(overrides.finalDecisions ?? {}) },
    validation: {
      roundId: CANONICAL_STRUCTURAL_ROUND_ID,
      status: CANONICAL_STRUCTURAL_STATUS,
      finalDecisionCount: n,
      ...(overrides.validation ?? {}),
    },
  };
}

console.log('\n=== CBRP DUPLICATE AUDIT DUP-R00 CORPUS BINDING — SYNTHETIC + REAL-EVIDENCE-READ-ONLY ===');

console.log('\n--- Pure validator: synthetic fixtures only ---');

await check('a well-formed 60-candidate fixture validates and yields exactly 60 candidates', () => {
  const result = validateCanonicalDupR00Corpus(makeFixture(60));
  assert.equal(result.ok, true);
  assert.equal(result.corpusTasks.length, 60);
  assert.equal(result.corpusTaskIds.length, 60);
});

await check('the model-visible corpus contains only candidateId/taskText -- no other keys', () => {
  const result = validateCanonicalDupR00Corpus(makeFixture(60));
  for (const task of result.corpusTasks) {
    assert.deepEqual(Object.keys(task).sort(), ['candidateId', 'taskText']);
  }
});

await check('corpusTaskIds is sorted ascending lexicographically', () => {
  const result = validateCanonicalDupR00Corpus(makeFixture(60));
  const sorted = [...result.corpusTaskIds].sort();
  assert.deepEqual(result.corpusTaskIds, sorted);
});

await check('a 59-task source fails with STOP_CORPUS_COUNT_MISMATCH', () => {
  const result = validateCanonicalDupR00Corpus(makeFixture(59, { validation: { finalDecisionCount: 59 } }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'STOP_CORPUS_COUNT_MISMATCH');
});

await check('a 61-task source fails with STOP_CORPUS_COUNT_MISMATCH', () => {
  const result = validateCanonicalDupR00Corpus(makeFixture(61, { validation: { finalDecisionCount: 61 } }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'STOP_CORPUS_COUNT_MISMATCH');
});

await check('an altered taskText (not matching its committed taskSha256) fails with STOP_CORPUS_HASH_MISMATCH', () => {
  const fixture = makeFixture(60);
  fixture.authoring.candidates[10].taskText = 'This text was altered after the hash was committed.';
  const result = validateCanonicalDupR00Corpus(fixture);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'STOP_CORPUS_HASH_MISMATCH');
});

await check('an altered taskSha256 (not matching the real taskText) fails with STOP_CORPUS_HASH_MISMATCH', () => {
  const fixture = makeFixture(60);
  fixture.authoring.candidates[10].taskSha256 = '0'.repeat(64);
  const result = validateCanonicalDupR00Corpus(fixture);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'STOP_CORPUS_HASH_MISMATCH');
});

await check('an altered taskBytes fails with STOP_CORPUS_BYTES_MISMATCH', () => {
  const fixture = makeFixture(60);
  fixture.authoring.candidates[10].taskBytes += 1;
  const result = validateCanonicalDupR00Corpus(fixture);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'STOP_CORPUS_BYTES_MISMATCH');
});

await check('an empty taskText fails with STOP_CORPUS_TASK_TEXT_EMPTY', () => {
  const fixture = makeFixture(60);
  fixture.authoring.candidates[0].taskText = '';
  const result = validateCanonicalDupR00Corpus(fixture);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'STOP_CORPUS_TASK_TEXT_EMPTY');
});

await check('one decision with finalPass=false fails with STOP_CORPUS_DECISION_NOT_FINAL', () => {
  const fixture = makeFixture(60);
  fixture.finalDecisions.decisions[5].finalPass = false;
  const result = validateCanonicalDupR00Corpus(fixture);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'STOP_CORPUS_DECISION_NOT_FINAL');
});

await check('one decision with status=PENDING_R3 fails with STOP_CORPUS_DECISION_NOT_FINAL', () => {
  const fixture = makeFixture(60);
  fixture.finalDecisions.decisions[5].status = 'PENDING_R3';
  const result = validateCanonicalDupR00Corpus(fixture);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'STOP_CORPUS_DECISION_NOT_FINAL');
});

await check('a candidate-ID-set mismatch between authoring and FINAL_DECISIONS fails with STOP_CORPUS_DECISION_ID_MISMATCH', () => {
  const fixture = makeFixture(60);
  fixture.finalDecisions.decisions[0].taskCandidateId = 'SYN-NOT-IN-AUTHORING';
  const result = validateCanonicalDupR00Corpus(fixture);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'STOP_CORPUS_DECISION_ID_MISMATCH');
});

await check('non-unique authoring candidate IDs fail with STOP_CORPUS_ID_NOT_UNIQUE', () => {
  const fixture = makeFixture(60);
  fixture.authoring.candidates[1].taskCandidateId = fixture.authoring.candidates[0].taskCandidateId;
  const result = validateCanonicalDupR00Corpus(fixture);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'STOP_CORPUS_ID_NOT_UNIQUE');
});

await check('a wrong authoring runId fails with STOP_CORPUS_RUN_ID_MISMATCH', () => {
  const fixture = makeFixture(60, { authoring: { runId: 'SOME-OTHER-RUN' } });
  const result = validateCanonicalDupR00Corpus(fixture);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'STOP_CORPUS_RUN_ID_MISMATCH');
});

await check('a wrong structural roundId fails with STOP_STRUCTURAL_STATUS_INVALID', () => {
  const fixture = makeFixture(60, { validation: { roundId: 'ROUND_1' } });
  const result = validateCanonicalDupR00Corpus(fixture);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'STOP_STRUCTURAL_STATUS_INVALID');
});

await check('a structural status other than R3_COMPLETE fails with STOP_STRUCTURAL_STATUS_INVALID', () => {
  const fixture = makeFixture(60, { validation: { status: 'INITIAL_COMPLETE' } });
  const result = validateCanonicalDupR00Corpus(fixture);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'STOP_STRUCTURAL_STATUS_INVALID');
});

await check('validation.finalDecisionCount != 60 fails with STOP_STRUCTURAL_STATUS_INVALID', () => {
  const fixture = makeFixture(60, { validation: { finalDecisionCount: 59 } });
  const result = validateCanonicalDupR00Corpus(fixture);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'STOP_STRUCTURAL_STATUS_INVALID');
});

console.log('\n--- Real committed evidence (read-only) ---');

await check('loadCanonicalDupR00Corpus() against the real committed evidence yields exactly 60 candidates', () => {
  const result = loadCanonicalDupR00Corpus();
  assert.equal(result.corpusTaskIds.length, CANONICAL_CANDIDATE_COUNT);
  assert.equal(result.corpusTasks.length, CANONICAL_CANDIDATE_COUNT);
});

await check('every real candidate ID appears in FINAL_DECISIONS.json, independently re-read (not via the loader)', () => {
  const result = loadCanonicalDupR00Corpus();
  const independentDecisions = JSON.parse(fs.readFileSync(new URL('../structural-review-round-2/FINAL_DECISIONS.json', import.meta.url), 'utf8')).decisions;
  const independentIds = new Set(independentDecisions.map((d) => d.taskCandidateId));
  assert.equal(result.corpusTaskIds.length, independentIds.size);
  for (const id of result.corpusTaskIds) assert.equal(independentIds.has(id), true);
});

await check('the real Structural Review VALIDATION.json is ROUND_2 / R3_COMPLETE, independently re-read', () => {
  const independentValidation = JSON.parse(fs.readFileSync(new URL('../structural-review-round-2/VALIDATION.json', import.meta.url), 'utf8'));
  assert.equal(independentValidation.roundId, CANONICAL_STRUCTURAL_ROUND_ID);
  assert.equal(independentValidation.status, CANONICAL_STRUCTURAL_STATUS);
  assert.equal(independentValidation.finalDecisionCount, CANONICAL_CANDIDATE_COUNT);
});

await check('loadCanonicalDupR00Sources() reports sourceHashes for all three canonical paths, matching a fresh independent hash', () => {
  const { sourceHashes } = loadCanonicalDupR00Sources();
  for (const relPath of [CANONICAL_AUTHORING_PATH, CANONICAL_FINAL_DECISIONS_PATH, CANONICAL_VALIDATION_PATH]) {
    const independent = sha256Bytes(fs.readFileSync(new URL(`../../../../${relPath}`, import.meta.url)));
    assert.equal(sourceHashes[relPath], independent);
  }
});
function sha256Bytes(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

console.log('\n--- DUP-R00 scope invariant (§B) ---');

await check('the real canonical corpus satisfies the DUP-R00 scope invariant: 60/60/equal/1770 canonical pairs', () => {
  const { corpusTaskIds } = loadCanonicalDupR00Corpus();
  const auditScopeIds = corpusTaskIds;
  const pairUniverse = computePairUniverse({ corpusTaskIds, auditScopeIds });
  assert.equal(pairUniverse.length, 1770);
  assert.equal(assertDupR00ScopeInvariant({ corpusTaskIds, auditScopeIds, pairUniverse }), true);
});

await check('assertDupR00ScopeInvariant rejects a corpus count != 60', () => {
  assert.throws(
    () => assertDupR00ScopeInvariant({ corpusTaskIds: ['A', 'B'], auditScopeIds: ['A', 'B'], pairUniverse: [{ a: 'A', b: 'B' }] }),
    (error) => error.code === 'STOP_SCOPE_INVALID'
  );
});

await check('assertDupR00ScopeInvariant rejects a scope set that != the corpus set', () => {
  const ids60 = Array.from({ length: 60 }, (_, i) => `SYN-${String(i).padStart(2, '0')}`);
  const scopeMissingOne = [...ids60.slice(0, 59), 'SYN-EXTRA-NOT-IN-CORPUS'];
  assert.throws(
    () => assertDupR00ScopeInvariant({ corpusTaskIds: ids60, auditScopeIds: scopeMissingOne, pairUniverse: computePairUniverse({ corpusTaskIds: ids60, auditScopeIds: ids60 }) }),
    (error) => error.code === 'STOP_SCOPE_INVALID'
  );
});

await check('assertDupR00ScopeInvariant rejects a pair universe count != 1770', () => {
  const ids60 = Array.from({ length: 60 }, (_, i) => `SYN-${String(i).padStart(2, '0')}`);
  assert.throws(
    () => assertDupR00ScopeInvariant({ corpusTaskIds: ids60, auditScopeIds: ids60, pairUniverse: [{ a: 'SYN-00', b: 'SYN-01' }] }),
    (error) => error.code === 'STOP_SCOPE_INVALID'
  );
});

await check('assertDupR00ScopeInvariant rejects a non-canonically-ordered pair', () => {
  const ids60 = Array.from({ length: 60 }, (_, i) => `SYN-${String(i).padStart(2, '0')}`);
  const universe = computePairUniverse({ corpusTaskIds: ids60, auditScopeIds: ids60 });
  const corrupted = universe.map((p, i) => (i === 0 ? { a: p.b, b: p.a } : p));
  assert.throws(
    () => assertDupR00ScopeInvariant({ corpusTaskIds: ids60, auditScopeIds: ids60, pairUniverse: corrupted }),
    (error) => error.code === 'STOP_SCOPE_INVALID'
  );
});

console.log('\n--- DUP-R00 generation envelope (§E) ---');

await check('DUP_R00_GENERATION_ENVELOPES matches the frozen spec exactly for both providers', () => {
  assert.deepEqual(DUP_R00_GENERATION_ENVELOPES.claude, {
    provider: 'claude', model: 'claude-opus-5', maxOutputTokens: 32768, thinkingLevel: null, temperature: null,
  });
  assert.deepEqual(DUP_R00_GENERATION_ENVELOPES.gemini, {
    provider: 'gemini', model: 'gemini-3.8-flash', maxOutputTokens: 32768, thinkingLevel: 'medium', temperature: null,
  });
});

await check('the mandatory D1/D2 call budget is exactly 2', () => {
  assert.equal(CALL_BUDGET.mandatoryD1D2PerRound, 2);
});

console.log('\n--- Pre-live manifest (§F) ---');

await check('buildDupR00PreflightManifest() is deterministic: two calls produce byte-identical JSON', () => {
  const m1 = buildDupR00PreflightManifest();
  const m2 = buildDupR00PreflightManifest();
  assert.equal(JSON.stringify(m1), JSON.stringify(m2));
});

await check('the pre-live manifest reports every field CWP-12C §F requires, with the correct fixed values', () => {
  const manifest = buildDupR00PreflightManifest();
  assert.equal(manifest.preflightVersion, PREFLIGHT_VERSION);
  assert.equal(manifest.roundId, DUP_R00_ROUND_ID);
  assert.equal(manifest.candidateCount, 60);
  assert.equal(manifest.scopeCount, 60);
  assert.equal(manifest.pairUniverseCount, 1770);
  assert.equal(manifest.expectedMandatoryInitialCalls, 2);
  assert.equal(manifest.d3Calls, 'UNKNOWN_UNTIL_D1D2_COMPLETE');
  assert.equal(manifest.providerCallsPerformed, 0);
  assert.equal(manifest.d1.provider, 'claude');
  assert.equal(manifest.d2.provider, 'gemini');
  assert.deepEqual(manifest.generationEnvelope, DUP_R00_GENERATION_ENVELOPES);
});

await check('the committed DUP_R00_PRELIVE_MANIFEST.json matches a freshly rebuilt manifest exactly', () => {
  const committed = JSON.parse(fs.readFileSync(new URL('../duplicate-audit-preflight/DUP_R00_PRELIVE_MANIFEST.json', import.meta.url), 'utf8'));
  const fresh = buildDupR00PreflightManifest();
  assert.equal(JSON.stringify(committed), JSON.stringify(fresh));
});

await check('no real duplicate-audit-round-00 LIVE evidence directory exists (pre-live manifest is not round evidence)', () => {
  assert.equal(fs.existsSync(new URL('../duplicate-audit-round-00/', import.meta.url)), false);
});

console.log('\n--- Real LIVE entrypoint: DUP-R00 binding hardening (§B/§D/§E/§G) ---');

const VALID_FORMAT_BASE = 'a'.repeat(40);

await check('caller-supplied corpusTasks is rejected before any other check', async () => {
  await assert.rejects(
    () => dispatchLiveDuplicateAudit({ liveExecution: true, authorizedBaseSha: VALID_FORMAT_BASE, roundId: DUP_R00_ROUND_ID, corpusTasks: [] }),
    (error) => error instanceof DuplicateAuditStop && error.code === 'STOP_UNAUTHORIZED_OVERRIDE'
  );
});

await check('caller-supplied auditScopeIds is rejected', async () => {
  await assert.rejects(
    () => dispatchLiveDuplicateAudit({ liveExecution: true, authorizedBaseSha: VALID_FORMAT_BASE, roundId: DUP_R00_ROUND_ID, auditScopeIds: [] }),
    (error) => error instanceof DuplicateAuditStop && error.code === 'STOP_UNAUTHORIZED_OVERRIDE'
  );
});

await check('caller-supplied maxOutputTokens is rejected', async () => {
  await assert.rejects(
    () => dispatchLiveDuplicateAudit({ liveExecution: true, authorizedBaseSha: VALID_FORMAT_BASE, roundId: DUP_R00_ROUND_ID, maxOutputTokens: 999 }),
    (error) => error instanceof DuplicateAuditStop && error.code === 'STOP_UNAUTHORIZED_OVERRIDE'
  );
});

await check('caller-supplied thinkingLevel is rejected', async () => {
  await assert.rejects(
    () => dispatchLiveDuplicateAudit({ liveExecution: true, authorizedBaseSha: VALID_FORMAT_BASE, roundId: DUP_R00_ROUND_ID, thinkingLevel: 'high' }),
    (error) => error instanceof DuplicateAuditStop && error.code === 'STOP_UNAUTHORIZED_OVERRIDE'
  );
});

await check('caller-supplied temperature is rejected', async () => {
  await assert.rejects(
    () => dispatchLiveDuplicateAudit({ liveExecution: true, authorizedBaseSha: VALID_FORMAT_BASE, roundId: DUP_R00_ROUND_ID, temperature: 0.5 }),
    (error) => error instanceof DuplicateAuditStop && error.code === 'STOP_UNAUTHORIZED_OVERRIDE'
  );
});

await check('DUP-R01 is rejected by the real LIVE entrypoint -- authorized to understand only DUP-R00', async () => {
  await assert.rejects(
    () => dispatchLiveDuplicateAudit({ liveExecution: true, authorizedBaseSha: VALID_FORMAT_BASE, roundId: 'DUP-R01' }),
    (error) => error instanceof DuplicateAuditStop && error.code === 'STOP_ROUND_NOT_LIVE_READY'
  );
});

await check('an explicit D3 stage request is rejected -- D3 is never auto-chained and is not yet LIVE-ready via this entrypoint', async () => {
  await assert.rejects(
    () => dispatchLiveDuplicateAudit({ liveExecution: true, authorizedBaseSha: VALID_FORMAT_BASE, roundId: DUP_R00_ROUND_ID, stage: D3_STAGE }),
    (error) => error instanceof DuplicateAuditStop && error.code === 'STOP_STAGE_NOT_LIVE_READY'
  );
});

await check('the default stage (D1D2) and an explicit D1D2 stage both pass the stage gate -- proven by reaching a later gate, never STOP_STAGE_NOT_LIVE_READY', async () => {
  const savedClaude = process.env.ANTHROPIC_API_KEY;
  const savedGemini = process.env.GEMINI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    for (const options of [
      { liveExecution: true, authorizedBaseSha: VALID_FORMAT_BASE, roundId: DUP_R00_ROUND_ID },
      { liveExecution: true, authorizedBaseSha: VALID_FORMAT_BASE, roundId: DUP_R00_ROUND_ID, stage: D1D2_STAGE },
    ]) {
      await assert.rejects(
        () => dispatchLiveDuplicateAudit(options),
        (error) => error instanceof DuplicateAuditStop && error.code === 'STOP_CREDENTIAL_MISSING'
      );
    }
  } finally {
    if (savedClaude !== undefined) process.env.ANTHROPIC_API_KEY = savedClaude;
    if (savedGemini !== undefined) process.env.GEMINI_API_KEY = savedGemini;
  }
});

await check('no real duplicate-audit-round-00 namespace was created by any of the above rejected LIVE attempts', () => {
  assert.equal(fs.existsSync(new URL('../duplicate-audit-round-00/', import.meta.url)), false);
});

console.log('\n--- Identities ---');

await check('BINDING_VERSION is fixed', () => {
  assert.equal(BINDING_VERSION, 'CBRP-DUPLICATE-AUDIT-DUP-R00-CORPUS-BINDING-1');
});

console.log(`\n${passed} passed, ${failed} failed`);
console.log('0 provider calls. 0 duplicate audit rounds executed. 0 replacement sessions. 0 pool freezes. 0 Chief Census calls.');
process.exit(failed === 0 ? 0 : 1);
