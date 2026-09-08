/** Offline-only synthetic verification for CBRP-DUPLICATE-AUDIT-LIVE-HARNESS-P2-1. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  PROTOCOL_2_VERSION,
  P2_HARNESS_VERSION,
  P2_ATTEMPT_BOUNDARY_VERSION,
  DUP_P2_R00_ROUND_ID,
  P2_ROUND_ID_PATTERN,
  P2_EXPECTED_RUNTIME,
  dupP2RoundSuffix,
  liveArtifactPathsP2,
  captureRuntimeSnapshotP2,
  assertRuntimeSnapshotP2,
  dispatchLiveDuplicateAuditP2,
  createArtifactStore,
  executeDuplicateAuditSession,
  DuplicateAuditStop,
  D1_PIN,
  D2_PIN,
  PROTOCOL_1_VERSION,
} from './duplicate-audit-live-harness-p2-v1.mjs';
import { runD1D2Stage, HARNESS_VERSION } from './duplicate-audit-live-harness-v1.mjs';
import { computeD1D2SessionPlan, computeD3RoutePlan, ROUND_STATES } from './duplicate-audit-runner.mjs';
import { loadFrozenLayerABytes, EXPECTED_LAYER_A_BYTE_COUNT, EXPECTED_LAYER_A_SHA256 } from './duplicate-audit-prompt-v1.mjs';
import { loadCanonicalDupR00Corpus } from './duplicate-audit-corpus-binding-v1.mjs';
import { buildP2R00PreflightManifest, P2_PREFLIGHT_VERSION } from './duplicate-audit-preflight-p2-v1.mjs';

const SCRATCH = mkdtempSync(path.join(tmpdir(), 'cbrp-duplicate-audit-p2-harness-'));
const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(DIR, '../../../..');
const AUTHORIZED_BASE = 'a'.repeat(40);
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

function artifactDir(label) {
  return path.join(SCRATCH, label);
}

function readJson(dir, name) {
  return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
}

function makeTasks(n, prefix = 'CBRP-T') {
  const tasks = [];
  for (let i = 0; i < n; i += 1) {
    tasks.push({ candidateId: `${prefix}-${String(i).padStart(2, '0')}`, taskText: `Synthetic decision scenario ${i}; behavior fixture only.` });
  }
  return tasks;
}

function makeSnapshotP2(overrides = {}) {
  return {
    head: AUTHORIZED_BASE,
    nodeVersion: P2_EXPECTED_RUNTIME.nodeVersion,
    packageLockSha256: P2_EXPECTED_RUNTIME.packageLockSha256,
    anthropicSdkVersion: P2_EXPECTED_RUNTIME.anthropicSdkVersion,
    geminiSdkVersion: P2_EXPECTED_RUNTIME.geminiSdkVersion,
    layerABytes: EXPECTED_LAYER_A_BYTE_COUNT,
    layerASha256: EXPECTED_LAYER_A_SHA256,
    sourceHashes: { ...P2_EXPECTED_RUNTIME.sourceHashes },
    workingTreePaths: [],
    unexpectedWorkingTreePaths: [],
    ...overrides,
  };
}

function fakeResponse(call, parsed, overrides = {}) {
  return {
    text: JSON.stringify(parsed),
    raw: { synthetic: true, model: call.model },
    providerResolved: call.provider,
    modelResolved: call.model,
    stopReason: 'end_turn',
    ...overrides,
  };
}

function makeTransport(responseFactory) {
  const calls = [];
  const transport = async (call) => {
    calls.push({ ...call });
    return responseFactory ? responseFactory(call, calls.length - 1) : fakeResponse(call, { duplicatePairs: [] });
  };
  return { calls, transport };
}

console.log('\n=== CBRP DUPLICATE AUDIT LIVE HARNESS — PROTOCOL-2 — SYNTHETIC ONLY ===');

console.log('\n--- Protocol identity ---');

await check('Protocol-2 version identifier is fixed and distinct from Protocol-1', () => {
  assert.equal(PROTOCOL_2_VERSION, 'CBRP-CORPUS-DUPLICATE-AUDIT-PROTOCOL-2');
  assert.equal(PROTOCOL_1_VERSION, 'CBRP-CORPUS-DUPLICATE-AUDIT-PROTOCOL-1');
  assert.notEqual(PROTOCOL_2_VERSION, PROTOCOL_1_VERSION);
});

await check('the P2 real entrypoint reuses the same execution engine (harness version), not a fork', () => {
  assert.equal(P2_HARNESS_VERSION, HARNESS_VERSION);
  assert.equal(P2_HARNESS_VERSION, 'CBRP-DUPLICATE-AUDIT-LIVE-HARNESS-1');
});

await check('DUP-P2-R00 is accepted by the pattern, DUP-R00 is not, DUP-P2-R01 is accepted by the pattern but not the current real entrypoint', () => {
  assert.equal(P2_ROUND_ID_PATTERN.test('DUP-P2-R00'), true);
  assert.equal(P2_ROUND_ID_PATTERN.test('DUP-R00'), false);
  assert.equal(P2_ROUND_ID_PATTERN.test('DUP-P2-R01'), true);
});

console.log('\n--- Session identity ---');

await check('D1/D2 session IDs follow ${roundId}-${role} for DUP-P2-R00', () => {
  const tasks = makeTasks(4);
  const layerA = loadFrozenLayerABytes();
  const plan = computeD1D2SessionPlan({ roundId: DUP_P2_R00_ROUND_ID, corpusTasks: tasks, auditScopeIds: tasks.map((t) => t.candidateId), layerABytes: layerA });
  assert.equal(plan.d1.sessionId, 'DUP-P2-R00-D1');
  assert.equal(plan.d2.sessionId, 'DUP-P2-R00-D2');
  assert.equal(plan.d1.provider, D1_PIN.provider);
  assert.equal(plan.d2.provider, D2_PIN.provider);
});

await check('D3 session IDs are DUP-P2-R00-D3-<a>__<b>, canonically ordered, for DUP-P2-R00', () => {
  const tasks = makeTasks(4);
  const layerA = loadFrozenLayerABytes();
  const taskById = new Map(tasks.map((t) => [t.candidateId, t]));
  const plan = computeD3RoutePlan({
    roundId: DUP_P2_R00_ROUND_ID,
    disagreementSet: [{ a: tasks[0].candidateId, b: tasks[1].candidateId }],
    taskById,
    layerABytes: layerA,
  });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].sessionId, `DUP-P2-R00-D3-${tasks[0].candidateId}__${tasks[1].candidateId}`);
});

console.log('\n--- Namespace mapping ---');

await check('DUP-P2-R00 maps to duplicate-audit-p2-round-00/, and the suffix mapping preserves leading zeroes', () => {
  assert.equal(dupP2RoundSuffix('DUP-P2-R00'), '00');
  assert.equal(dupP2RoundSuffix('DUP-P2-R01'), '01');
  assert.equal(dupP2RoundSuffix('DUP-P2-R09'), '09');
  assert.equal(dupP2RoundSuffix('DUP-P2-R10'), '10');
  assert.equal(liveArtifactPathsP2('DUP-P2-R00').relative, 'experiments/m2b/census/duplicate-audit-p2-round-00/');
  assert.equal(liveArtifactPathsP2('DUP-P2-R01').relative, 'experiments/m2b/census/duplicate-audit-p2-round-01/');
  assert.equal(liveArtifactPathsP2('DUP-P2-R09').relative, 'experiments/m2b/census/duplicate-audit-p2-round-09/');
  assert.equal(liveArtifactPathsP2('DUP-P2-R10').relative, 'experiments/m2b/census/duplicate-audit-p2-round-10/');
});

await check('a Protocol-1 roundId is never accepted by the P2 namespace mapping', () => {
  for (const roundId of ['DUP-R00', 'DUP-R01', 'DUP-R09']) {
    assert.throws(() => liveArtifactPathsP2(roundId), (error) => error instanceof DuplicateAuditStop && error.code === 'STOP_ROUND_INVALID');
  }
});

await check('no Protocol-2 namespace this mapping can produce is ever the historical or retired Protocol-1 namespace', () => {
  for (const roundId of ['DUP-P2-R00', 'DUP-P2-R01', 'DUP-P2-R09', 'DUP-P2-R99']) {
    const { relative } = liveArtifactPathsP2(roundId);
    assert.notEqual(relative, 'experiments/m2b/census/duplicate-audit-round-0/');
    assert.notEqual(relative, 'experiments/m2b/census/duplicate-audit-round-00/');
    assert.equal(relative.startsWith('experiments/m2b/census/duplicate-audit-p2-round-'), true);
  }
});

console.log('\n--- Model-visible prompt blindness (byte identity with Protocol-1) ---');

await check('the real canonical corpus produces a D1/D2 prompt with exactly the frozen byte count and hash, under either roundId', () => {
  const canonicalCorpus = loadCanonicalDupR00Corpus();
  const layerA = loadFrozenLayerABytes();
  const planP1 = computeD1D2SessionPlan({ roundId: 'DUP-R00', corpusTasks: canonicalCorpus.corpusTasks, auditScopeIds: canonicalCorpus.corpusTaskIds, layerABytes: layerA });
  const planP2 = computeD1D2SessionPlan({ roundId: DUP_P2_R00_ROUND_ID, corpusTasks: canonicalCorpus.corpusTasks, auditScopeIds: canonicalCorpus.corpusTaskIds, layerABytes: layerA });
  assert.equal(planP2.d1.prompt.promptBytes, 77147);
  assert.equal(planP2.d1.prompt.promptSha256, '40fc7509387777c010fee9016280b9f9e0120ee5276691540128bc68af725e2d');
  // The direct byte-comparison regression CWP-12F §D requires: Protocol-2's
  // D1/D2 modelVisiblePrompt, built through the SAME reused
  // computeD1D2SessionPlan/buildD1D2Prompt chain against the identical
  // corpus, is byte-for-byte identical to Protocol-1's -- because that
  // chain never takes roundId, protocol version, or session identity as an
  // input to the prompt bytes themselves.
  assert.equal(planP2.d1.prompt.modelVisiblePrompt, planP1.d1.prompt.modelVisiblePrompt);
  assert.equal(planP2.d2.prompt.modelVisiblePrompt, planP1.d2.prompt.modelVisiblePrompt);
  assert.equal(planP2.d1.prompt.modelVisiblePrompt, planP2.d2.prompt.modelVisiblePrompt);
});

await check('no Protocol-2/recovery/history/session-identity metadata appears inside the model-visible prompt', () => {
  const canonicalCorpus = loadCanonicalDupR00Corpus();
  const layerA = loadFrozenLayerABytes();
  const plan = computeD1D2SessionPlan({ roundId: DUP_P2_R00_ROUND_ID, corpusTasks: canonicalCorpus.corpusTasks, auditScopeIds: canonicalCorpus.corpusTaskIds, layerABytes: layerA });
  const prompt = plan.d1.prompt.modelVisiblePrompt;
  for (const forbidden of ['Protocol-2', 'PROTOCOL-2', 'DUP-P2', 'STOP_PROVIDER_ERROR', 'CWP-12', 'DUP-R00-D1', PROTOCOL_2_VERSION, plan.d1.sessionId, plan.d2.sessionId]) {
    assert.equal(prompt.includes(forbidden), false, `prompt must not contain ${JSON.stringify(forbidden)}`);
  }
});

console.log('\n--- Corpus binding (reused unchanged from Protocol-1) ---');

await check('Protocol-2 binds to exactly the same 60 candidate IDs/texts and 1770-pair universe as Protocol-1\'s canonical corpus', () => {
  const canonicalCorpus = loadCanonicalDupR00Corpus();
  assert.equal(canonicalCorpus.corpusTaskIds.length, 60);
  assert.equal(new Set(canonicalCorpus.corpusTaskIds).size, 60);
  const manifest = buildP2R00PreflightManifest();
  assert.equal(manifest.candidateCount, 60);
  assert.equal(manifest.pairUniverseCount, 1770);
  assert.equal(manifest.candidateIdListHash, sha256(JSON.stringify(canonicalCorpus.corpusTaskIds)));
});

console.log('\n--- Generation envelope ---');

await check('the frozen Claude/Gemini envelope values are exactly Protocol-1\'s, reused not re-declared', () => {
  const manifest = buildP2R00PreflightManifest();
  assert.deepEqual(manifest.d1.envelope, { provider: 'claude', model: 'claude-opus-5', maxOutputTokens: 32768, thinkingLevel: null, temperature: null });
  assert.deepEqual(manifest.d2.envelope, { provider: 'gemini', model: 'gemini-3.8-flash', maxOutputTokens: 32768, thinkingLevel: 'medium', temperature: null });
});

console.log('\n--- Attempt boundary (§8): pre-dispatch / reserved-ambiguous / transport-invoked ---');

await check('a STOP before any reservation exists does not create a reservation file (pre-dispatch failure, not consumed)', async () => {
  const tasks = makeTasks(4);
  const layerA = loadFrozenLayerABytes();
  const plan = computeD1D2SessionPlan({ roundId: DUP_P2_R00_ROUND_ID, corpusTasks: tasks, auditScopeIds: tasks.map((t) => t.candidateId), layerABytes: layerA });
  const store = createArtifactStore(artifactDir('p2-pre-dispatch-failure'));
  store.initialize();
  const state = { sessions: [], results: [] };
  const { calls, transport } = makeTransport();
  await assert.rejects(() => executeDuplicateAuditSession({
    session: { ...plan.d1, roundId: DUP_P2_R00_ROUND_ID }, store, state, transport,
    credentials: { claude: '', gemini: 'y' }, revalidate: async () => makeSnapshotP2(),
    corpusTaskIds: plan.corpusTaskIds, pairUniverse: plan.pairUniverse,
    envelopeForProvider: () => ({ maxOutputTokens: 4096, thinkingLevel: null }),
    protocolVersion: PROTOCOL_2_VERSION,
  }), (error) => error.code === 'STOP_CREDENTIAL_MISSING');
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(path.join(store.artifactDir, 'reservations', `${plan.d1.sessionId}.json`)), false);
});

await check('a reservation that already exists is treated as consumed/ambiguous and fails closed before transport', async () => {
  const tasks = makeTasks(4);
  const layerA = loadFrozenLayerABytes();
  const plan = computeD1D2SessionPlan({ roundId: DUP_P2_R00_ROUND_ID, corpusTasks: tasks, auditScopeIds: tasks.map((t) => t.candidateId), layerABytes: layerA });
  const store = createArtifactStore(artifactDir('p2-reservation-ambiguous'));
  store.initialize();
  store.reserve(plan.d1.sessionId, { status: 'RESERVED' });
  const state = { sessions: [], results: [] };
  const { calls, transport } = makeTransport();
  await assert.rejects(() => executeDuplicateAuditSession({
    session: { ...plan.d1, roundId: DUP_P2_R00_ROUND_ID }, store, state, transport,
    credentials: { claude: 'x', gemini: 'y' }, revalidate: async () => makeSnapshotP2(),
    corpusTaskIds: plan.corpusTaskIds, pairUniverse: plan.pairUniverse,
    envelopeForProvider: () => ({ maxOutputTokens: 4096, thinkingLevel: null }),
    protocolVersion: PROTOCOL_2_VERSION,
  }), (error) => error.code === 'STOP_AMBIGUOUS_OR_CONSUMED_RESERVATION');
  assert.equal(calls.length, 0);
});

await check('once transport is invoked the attempt is consumed even on a client-side rejection with 0 network bytes, and no retry is permitted', async () => {
  const tasks = makeTasks(4);
  const layerA = loadFrozenLayerABytes();
  const plan = computeD1D2SessionPlan({ roundId: DUP_P2_R00_ROUND_ID, corpusTasks: tasks, auditScopeIds: tasks.map((t) => t.candidateId), layerABytes: layerA });
  const dir = artifactDir('p2-transport-invoked-consumed');
  const store = createArtifactStore(dir);
  store.initialize();
  const state = { sessions: [], results: [] };
  const failingTransport = async () => { throw new Error('simulated client-side SDK rejection, 0 network bytes'); };

  await assert.rejects(() => executeDuplicateAuditSession({
    session: { ...plan.d1, roundId: DUP_P2_R00_ROUND_ID }, store, state, transport: failingTransport,
    credentials: { claude: 'x', gemini: 'y' }, revalidate: async () => makeSnapshotP2(),
    corpusTaskIds: plan.corpusTaskIds, pairUniverse: plan.pairUniverse,
    envelopeForProvider: () => ({ maxOutputTokens: 4096, thinkingLevel: null }),
    protocolVersion: PROTOCOL_2_VERSION,
  }), (error) => error.code === 'STOP_PROVIDER_ERROR');

  assert.equal(fs.existsSync(path.join(dir, 'reservations', `${plan.d1.sessionId}.json`)), true);
  const sessions = readJson(dir, 'SESSIONS.json').sessions;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].outcome, 'STOP_PROVIDER_ERROR');
  assert.equal(sessions[0].protocolVersion, PROTOCOL_2_VERSION);

  // No retry: a second attempt at the same session, even with a working transport, is refused before it ever runs.
  const { calls: secondCalls, transport: secondTransport } = makeTransport();
  await assert.rejects(() => executeDuplicateAuditSession({
    session: { ...plan.d1, roundId: DUP_P2_R00_ROUND_ID }, store, state, transport: secondTransport,
    credentials: { claude: 'x', gemini: 'y' }, revalidate: async () => makeSnapshotP2(),
    corpusTaskIds: plan.corpusTaskIds, pairUniverse: plan.pairUniverse,
    envelopeForProvider: () => ({ maxOutputTokens: 4096, thinkingLevel: null }),
    protocolVersion: PROTOCOL_2_VERSION,
  }), (error) => error.code === 'STOP_AMBIGUOUS_OR_CONSUMED_RESERVATION');
  assert.equal(secondCalls.length, 0);
});

console.log('\n--- D1/D2 sequencing (reused runD1D2Stage, composed with Protocol-2 identity) ---');

await check('runD1D2Stage dispatches exactly D1 then D2 for DUP-P2-R00 and persists Protocol-2\'s own protocolVersion, not Protocol-1\'s', async () => {
  const tasks = makeTasks(6);
  const dir = artifactDir('p2-d1d2-success');
  const { calls, transport } = makeTransport((call) => fakeResponse(call, { duplicatePairs: [] }));
  const result = await runD1D2Stage({
    authorizedBaseSha: AUTHORIZED_BASE,
    roundId: DUP_P2_R00_ROUND_ID,
    corpusTasks: tasks,
    auditScopeIds: tasks.map((t) => t.candidateId),
    artifactDir: dir,
    transport,
    credentials: { claude: 'x', gemini: 'y' },
    revalidate: async () => makeSnapshotP2(),
    envelopeForProvider: () => ({ maxOutputTokens: 4096, thinkingLevel: null }),
    protocolVersion: PROTOCOL_2_VERSION,
    roundIdPattern: P2_ROUND_ID_PATTERN,
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.role), ['D1', 'D2']);
  assert.equal(result.status, ROUND_STATES.D3_COMPLETE);
  const validation = readJson(dir, 'VALIDATION.json');
  assert.equal(validation.protocolVersion, PROTOCOL_2_VERSION);
  assert.notEqual(validation.protocolVersion, PROTOCOL_1_VERSION);
  assert.equal(validation.roundId, DUP_P2_R00_ROUND_ID);
  assert.equal(validation.d3Dispatched, false);
  const sessions = readJson(dir, 'SESSIONS.json').sessions;
  assert.equal(sessions[0].sessionId, 'DUP-P2-R00-D1');
  assert.equal(sessions[1].sessionId, 'DUP-P2-R00-D2');
  assert.equal(sessions.every((s) => s.protocolVersion === PROTOCOL_2_VERSION), true);
});

await check('Protocol-1\'s own runD1D2Stage call sites are unaffected: default protocolVersion/roundIdPattern still produce Protocol-1 evidence', async () => {
  const tasks = makeTasks(4);
  const dir = artifactDir('p1-default-unaffected');
  const { transport } = makeTransport((call) => fakeResponse(call, { duplicatePairs: [] }));
  await runD1D2Stage({
    authorizedBaseSha: AUTHORIZED_BASE,
    roundId: 'DUP-R00',
    corpusTasks: tasks,
    auditScopeIds: tasks.map((t) => t.candidateId),
    artifactDir: dir,
    transport,
    credentials: { claude: 'x', gemini: 'y' },
    revalidate: async () => makeSnapshotP2(),
    envelopeForProvider: () => ({ maxOutputTokens: 4096, thinkingLevel: null }),
    // protocolVersion/roundIdPattern deliberately omitted -- must default to Protocol-1's own.
  });
  const validation = readJson(dir, 'VALIDATION.json');
  assert.equal(validation.protocolVersion, PROTOCOL_1_VERSION);
});

await check('D2 is never dispatched when D1 STOPs (no automatic continuation)', async () => {
  const tasks = makeTasks(4);
  const dir = artifactDir('p2-d1-stops-blocks-d2');
  const { calls, transport } = makeTransport((call) => {
    if (call.role === 'D1') throw new Error('simulated D1 transport failure');
    return fakeResponse(call, { duplicatePairs: [] });
  });
  await assert.rejects(() => runD1D2Stage({
    authorizedBaseSha: AUTHORIZED_BASE,
    roundId: DUP_P2_R00_ROUND_ID,
    corpusTasks: tasks,
    auditScopeIds: tasks.map((t) => t.candidateId),
    artifactDir: dir,
    transport,
    credentials: { claude: 'x', gemini: 'y' },
    revalidate: async () => makeSnapshotP2(),
    envelopeForProvider: () => ({ maxOutputTokens: 4096, thinkingLevel: null }),
    protocolVersion: PROTOCOL_2_VERSION,
    roundIdPattern: P2_ROUND_ID_PATTERN,
  }), (error) => error.code === 'STOP_PROVIDER_ERROR');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].role, 'D1');
  const validation = readJson(dir, 'VALIDATION.json');
  assert.equal(validation.status, ROUND_STATES.FAILED_CLOSED);
});

await check('no D3 artifact of any kind is ever produced by the D1/D2 stage', async () => {
  const dir = artifactDir('p2-d1d2-success');
  assert.equal(fs.existsSync(path.join(dir, 'D3_ROUTE_MANIFEST.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'FINAL_DECISIONS.json')), false);
});

console.log('\n--- Guarded LIVE entrypoint (never actually called with liveExecution: true in this suite) ---');

await check('dispatchLiveDuplicateAuditP2 refuses without liveExecution: true', async () => {
  await assert.rejects(() => dispatchLiveDuplicateAuditP2({ authorizedBaseSha: AUTHORIZED_BASE, roundId: DUP_P2_R00_ROUND_ID, stage: 'D1D2' }),
    (error) => error.code === 'STOP_LIVE_FLAG_REQUIRED');
});

await check('dispatchLiveDuplicateAuditP2 refuses without a valid authorizedBaseSha even with liveExecution: true', async () => {
  await assert.rejects(() => dispatchLiveDuplicateAuditP2({ liveExecution: true, roundId: DUP_P2_R00_ROUND_ID, stage: 'D1D2' }),
    (error) => error.code === 'STOP_AUTHORIZED_BASE_REQUIRED');
  await assert.rejects(() => dispatchLiveDuplicateAuditP2({ liveExecution: true, authorizedBaseSha: 'not-a-sha', roundId: DUP_P2_R00_ROUND_ID, stage: 'D1D2' }),
    (error) => error.code === 'STOP_AUTHORIZED_BASE_REQUIRED');
});

await check('dispatchLiveDuplicateAuditP2 rejects every caller override (corpus/scope/envelope/provider/model/namespace)', async () => {
  const forbidden = ['corpusTasks', 'auditScopeIds', 'maxOutputTokens', 'thinkingLevel', 'temperature', 'provider', 'model', 'artifactDir'];
  for (const key of forbidden) {
    await assert.rejects(
      () => dispatchLiveDuplicateAuditP2({ liveExecution: true, authorizedBaseSha: AUTHORIZED_BASE, roundId: DUP_P2_R00_ROUND_ID, stage: 'D1D2', [key]: 'x' }),
      (error) => error.code === 'STOP_UNAUTHORIZED_OVERRIDE',
      `expected STOP_UNAUTHORIZED_OVERRIDE for forbidden key ${key}`
    );
  }
});

await check('dispatchLiveDuplicateAuditP2 rejects DUP-R00 (Protocol-1\'s own round, permanently closed)', async () => {
  await assert.rejects(() => dispatchLiveDuplicateAuditP2({ liveExecution: true, authorizedBaseSha: AUTHORIZED_BASE, roundId: 'DUP-R00', stage: 'D1D2' }),
    (error) => error.code === 'STOP_ROUND_INVALID');
});

await check('dispatchLiveDuplicateAuditP2 rejects DUP-P2-R01 (matches the pattern, not yet LIVE-ready)', async () => {
  await assert.rejects(() => dispatchLiveDuplicateAuditP2({ liveExecution: true, authorizedBaseSha: AUTHORIZED_BASE, roundId: 'DUP-P2-R01', stage: 'D1D2' }),
    (error) => error.code === 'STOP_ROUND_NOT_LIVE_READY');
});

await check('dispatchLiveDuplicateAuditP2 rejects an unrecognized roundId entirely', async () => {
  await assert.rejects(() => dispatchLiveDuplicateAuditP2({ liveExecution: true, authorizedBaseSha: AUTHORIZED_BASE, roundId: 'NOT-A-ROUND', stage: 'D1D2' }),
    (error) => error.code === 'STOP_ROUND_INVALID');
});

await check('dispatchLiveDuplicateAuditP2 rejects the D3 stage -- D3 is a separately authorized future stage, never auto-chained', async () => {
  await assert.rejects(() => dispatchLiveDuplicateAuditP2({ liveExecution: true, authorizedBaseSha: AUTHORIZED_BASE, roundId: DUP_P2_R00_ROUND_ID, stage: 'D3' }),
    (error) => error.code === 'STOP_STAGE_NOT_LIVE_READY');
});

console.log('\n--- Source drift / runtime revalidation (Protocol-2\'s own manifest) ---');

await check('P2 source-hash entries are fixed and match the real repository files, including every reused shared module', () => {
  for (const [relative, expected] of Object.entries(P2_EXPECTED_RUNTIME.sourceHashes)) {
    const actual = sha256(fs.readFileSync(path.join(REPO_ROOT, relative)));
    assert.equal(actual, expected, `${relative} P2 source-manifest drift`);
  }
});

await check('assertRuntimeSnapshotP2 passes on a snapshot matching every frozen P2 expectation', () => {
  assertRuntimeSnapshotP2(makeSnapshotP2(), { authorizedBaseSha: AUTHORIZED_BASE });
});

await check('drift on any P2-bound source (including the reused Protocol-1 corpus-binding/runner/harness modules) is rejected', () => {
  for (const relativePath of Object.keys(P2_EXPECTED_RUNTIME.sourceHashes)) {
    const sourceHashes = { ...P2_EXPECTED_RUNTIME.sourceHashes };
    sourceHashes[relativePath] = '0'.repeat(64);
    assert.throws(
      () => assertRuntimeSnapshotP2(makeSnapshotP2({ sourceHashes }), { authorizedBaseSha: AUTHORIZED_BASE }),
      (error) => error instanceof DuplicateAuditStop && error.code === 'STOP_SOURCE_DRIFT',
      `expected STOP_SOURCE_DRIFT for drift on ${relativePath}`
    );
  }
});

await check('wrong base SHA and Layer A drift are rejected identically to Protocol-1\'s own guard', () => {
  assert.throws(
    () => assertRuntimeSnapshotP2(makeSnapshotP2({ head: 'b'.repeat(40) }), { authorizedBaseSha: AUTHORIZED_BASE }),
    (error) => error instanceof DuplicateAuditStop && error.code === 'STOP_BASE_SHA_MISMATCH'
  );
  assert.throws(
    () => assertRuntimeSnapshotP2(makeSnapshotP2({ layerASha256: '0'.repeat(64) }), { authorizedBaseSha: AUTHORIZED_BASE }),
    (error) => error instanceof DuplicateAuditStop && error.code === 'STOP_RUBRIC_DRIFT'
  );
});

await check('captureRuntimeSnapshotP2 reads real repository facts (smoke check)', () => {
  const snapshot = captureRuntimeSnapshotP2(DUP_P2_R00_ROUND_ID);
  assert.equal(typeof snapshot.head, 'string');
  assert.equal(snapshot.head.length, 40);
  assert.equal(snapshot.layerABytes, EXPECTED_LAYER_A_BYTE_COUNT);
});

console.log('\n--- Pre-live manifest (offline evidence only) ---');

await check('buildP2R00PreflightManifest is a pure, reproducible function of committed evidence and reports 0 provider calls', () => {
  const first = buildP2R00PreflightManifest();
  const second = buildP2R00PreflightManifest();
  assert.deepEqual(first, second);
  assert.equal(first.preflightVersion, P2_PREFLIGHT_VERSION);
  assert.equal(first.attemptPolicyVersion, P2_ATTEMPT_BOUNDARY_VERSION);
  assert.equal(first.providerCallsPerformed, 0);
  assert.equal(first.d3Calls, 'UNKNOWN_UNTIL_D1D2_COMPLETE');
});

await check('the committed P2_R00_PRELIVE_MANIFEST.json matches the pure function\'s output exactly', () => {
  const committed = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'experiments/m2b/census/duplicate-audit-p2-preflight/P2_R00_PRELIVE_MANIFEST.json'), 'utf8'));
  assert.deepEqual(committed, buildP2R00PreflightManifest());
});

console.log('\n--- Real-data blindness and namespace guard ---');

await check('test source embeds no real CWP-10E/Protocol-2.1 candidate text', () => {
  const real = JSON.parse(fs.readFileSync(new URL('../authoring-v2p1-round-0/CANDIDATES.json', import.meta.url), 'utf8')).candidates;
  const source = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  for (const candidate of real) {
    assert.equal(source.includes(candidate.taskText), false);
  }
});

await check('no real duplicate-audit-p2-round-00 namespace was created by this offline suite', () => {
  assert.equal(fs.existsSync(new URL('../duplicate-audit-p2-round-00/', import.meta.url)), false);
});

await check('no real duplicate-audit-p2-round-* namespace of any kind was created by this offline suite', () => {
  const censusDir = fileURLToPath(new URL('..', import.meta.url));
  const entries = fs.readdirSync(censusDir);
  const p2RoundDirs = entries.filter((name) => /^duplicate-audit-p2-round-\d{2}$/.test(name));
  assert.deepEqual(p2RoundDirs, []);
});

console.log(`\n${passed} passed, ${failed} failed`);
console.log('0 real provider calls. 0 Protocol-2 duplicate audit rounds executed against real evidence.');

rmSync(SCRATCH, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
