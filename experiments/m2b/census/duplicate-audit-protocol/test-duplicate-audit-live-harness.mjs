/** Offline-only synthetic verification for CBRP-DUPLICATE-AUDIT-LIVE-HARNESS-1. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  HARNESS_VERSION,
  EXPECTED_RUNTIME,
  DuplicateAuditStop,
  captureRuntimeSnapshot,
  assertRuntimeSnapshot,
  createArtifactStore,
  assertSessionRoute,
  executeDuplicateAuditSession,
  runD1D2Stage,
  runD3Stage,
  finalizeRound,
  dispatchLiveDuplicateAudit,
} from './duplicate-audit-live-harness-v1.mjs';
import { loadFrozenLayerABytes, EXPECTED_LAYER_A_BYTE_COUNT, EXPECTED_LAYER_A_SHA256 } from './duplicate-audit-prompt-v1.mjs';
import { computeD1D2SessionPlan, ROUND_STATES } from './duplicate-audit-runner.mjs';
import { computeDuplicateD3Selector } from './duplicate-audit-decision-v1.mjs';

const SCRATCH = mkdtempSync(path.join(tmpdir(), 'cbrp-duplicate-audit-harness-'));
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

function rawExists(dir, sessionId) {
  return fs.existsSync(path.join(dir, 'raw', `${sessionId}.txt`))
    && fs.existsSync(path.join(dir, 'raw', `${sessionId}.response.json`));
}

function makeTasks(n, prefix = 'CBRP-T') {
  const tasks = [];
  for (let i = 0; i < n; i += 1) {
    tasks.push({ candidateId: `${prefix}-${String(i).padStart(2, '0')}`, taskText: `Synthetic decision scenario ${i}; behavior fixture only.` });
  }
  return tasks;
}

function makeSnapshot(overrides = {}) {
  return {
    head: AUTHORIZED_BASE,
    nodeVersion: EXPECTED_RUNTIME.nodeVersion,
    packageLockSha256: EXPECTED_RUNTIME.packageLockSha256,
    anthropicSdkVersion: EXPECTED_RUNTIME.anthropicSdkVersion,
    geminiSdkVersion: EXPECTED_RUNTIME.geminiSdkVersion,
    layerABytes: EXPECTED_LAYER_A_BYTE_COUNT,
    layerASha256: EXPECTED_LAYER_A_SHA256,
    sourceHashes: { ...EXPECTED_RUNTIME.sourceHashes },
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

console.log('\n=== CBRP DUPLICATE AUDIT LIVE HARNESS — SYNTHETIC ONLY ===');

console.log('\n--- Frozen identities and runtime snapshot ---');

await check('harness version and SOURCE_HASHES entries are fixed and match real repository files', () => {
  assert.equal(HARNESS_VERSION, 'CBRP-DUPLICATE-AUDIT-LIVE-HARNESS-1');
  for (const [relative, expected] of Object.entries(EXPECTED_RUNTIME.sourceHashes)) {
    const actual = sha256(fs.readFileSync(path.join(REPO_ROOT, relative)));
    assert.equal(actual, expected, `${relative} source-manifest drift`);
  }
});

await check('assertRuntimeSnapshot passes on a snapshot matching every frozen expectation', () => {
  assertRuntimeSnapshot(makeSnapshot(), { authorizedBaseSha: AUTHORIZED_BASE });
});

await check('wrong base SHA is rejected', () => {
  assert.throws(
    () => assertRuntimeSnapshot(makeSnapshot({ head: 'b'.repeat(40) }), { authorizedBaseSha: AUTHORIZED_BASE }),
    (error) => error instanceof DuplicateAuditStop && error.code === 'STOP_BASE_SHA_MISMATCH'
  );
});

await check('a missing/malformed authorizedBaseSha is rejected before anything else', () => {
  assert.throws(
    () => assertRuntimeSnapshot(makeSnapshot(), { authorizedBaseSha: 'not-a-sha' }),
    (error) => error instanceof DuplicateAuditStop && error.code === 'STOP_AUTHORIZED_BASE_REQUIRED'
  );
});

await check('protocol/module source hash drift is rejected (source/prompt drift STOP)', () => {
  const sourceHashes = { ...EXPECTED_RUNTIME.sourceHashes };
  sourceHashes['experiments/m2b/census/CBRP_CORPUS_DUPLICATE_AUDIT_PROTOCOL_1.md'] = '0'.repeat(64);
  assert.throws(
    () => assertRuntimeSnapshot(makeSnapshot({ sourceHashes }), { authorizedBaseSha: AUTHORIZED_BASE }),
    (error) => error instanceof DuplicateAuditStop && error.code === 'STOP_SOURCE_DRIFT'
  );
});

await check('CWP-12C: drift on any of the three canonical DUP-R00 evidence files (authoring/FINAL_DECISIONS/VALIDATION) is rejected before transport', () => {
  for (const relativePath of [
    'experiments/m2b/census/authoring-v2p1-round-0/CANDIDATES.json',
    'experiments/m2b/census/structural-review-round-2/FINAL_DECISIONS.json',
    'experiments/m2b/census/structural-review-round-2/VALIDATION.json',
  ]) {
    const sourceHashes = { ...EXPECTED_RUNTIME.sourceHashes };
    sourceHashes[relativePath] = '0'.repeat(64);
    assert.throws(
      () => assertRuntimeSnapshot(makeSnapshot({ sourceHashes }), { authorizedBaseSha: AUTHORIZED_BASE }),
      (error) => error instanceof DuplicateAuditStop && error.code === 'STOP_SOURCE_DRIFT',
      `expected STOP_SOURCE_DRIFT for drift on ${relativePath}`
    );
  }
});

await check('Layer A byte/hash drift is rejected', () => {
  assert.throws(
    () => assertRuntimeSnapshot(makeSnapshot({ layerASha256: '0'.repeat(64) }), { authorizedBaseSha: AUTHORIZED_BASE }),
    (error) => error instanceof DuplicateAuditStop && error.code === 'STOP_RUBRIC_DRIFT'
  );
});

await check('unexpected working-tree drift outside the live artifact namespace is rejected', () => {
  assert.throws(
    () => assertRuntimeSnapshot(makeSnapshot({
      workingTreePaths: ['src/index.ts'],
      unexpectedWorkingTreePaths: ['src/index.ts'],
    }), { authorizedBaseSha: AUTHORIZED_BASE }),
    (error) => error instanceof DuplicateAuditStop && error.code === 'STOP_WORKTREE_DRIFT'
  );
});

await check('captureRuntimeSnapshot reads real repository facts (smoke check, not asserted against authorization)', () => {
  const snapshot = captureRuntimeSnapshot('DUP-R00');
  assert.equal(typeof snapshot.head, 'string');
  assert.equal(snapshot.head.length, 40);
  assert.equal(snapshot.layerABytes, EXPECTED_LAYER_A_BYTE_COUNT);
});

console.log('\n--- Session route assertion ---');

await check('assertSessionRoute accepts the correctly pinned D1/D2/D3 sessions and rejects a mismatched one', () => {
  const tasks = makeTasks(4);
  const layerA = loadFrozenLayerABytes();
  const plan = computeD1D2SessionPlan({ roundId: 'DUP-R00', corpusTasks: tasks, auditScopeIds: tasks.map((t) => t.candidateId), layerABytes: layerA });
  assertSessionRoute({ ...plan.d1, roundId: 'DUP-R00' });
  assertSessionRoute({ ...plan.d2, roundId: 'DUP-R00' });
  assert.throws(
    () => assertSessionRoute({ ...plan.d1, roundId: 'DUP-R00', provider: 'gemini', model: 'gemini-3.8-flash', modelFamily: 'GEMINI_FAMILY' }),
    (error) => error instanceof DuplicateAuditStop && error.code === 'STOP_SESSION_ROUTE_MISMATCH'
  );
});

await check('a D3 session route must match the CBRP-D3-v1 derived route for its pair, not an arbitrary one', () => {
  const route = computeDuplicateD3Selector('CBRP-A-01', 'CBRP-A-02');
  const session = { sessionId: 'DUP-R00-D3-CBRP-A-01__CBRP-A-02', roundId: 'DUP-R00', role: 'D3', a: 'CBRP-A-01', b: 'CBRP-A-02', provider: route.provider, model: route.model, modelFamily: route.modelFamily };
  assertSessionRoute(session);
  assert.throws(
    () => assertSessionRoute({ ...session, provider: route.provider === 'claude' ? 'gemini' : 'claude', model: route.provider === 'claude' ? 'gemini-3.8-flash' : 'claude-opus-5', modelFamily: route.provider === 'claude' ? 'GEMINI_FAMILY' : 'CLAUDE_FAMILY' }),
    (error) => error instanceof DuplicateAuditStop && error.code === 'STOP_SESSION_ROUTE_MISMATCH'
  );
});

console.log('\n--- Artifact store durability ---');

await check('createArtifactStore persists JSON and text durably, and reservations are one-shot', () => {
  const dir = artifactDir('store-basics');
  const store = createArtifactStore(dir);
  store.initialize();
  store.writeJson('X.json', { a: 1 });
  assert.deepEqual(readJson(dir, 'X.json'), { a: 1 });
  store.reserve('SESSION-1', { status: 'RESERVED' });
  assert.equal(store.listReservations().length, 1);
  assert.throws(
    () => store.reserve('SESSION-1', { status: 'RESERVED' }),
    (error) => error instanceof DuplicateAuditStop && error.code === 'STOP_AMBIGUOUS_OR_CONSUMED_RESERVATION'
  );
});

await check('persistRaw writes both the raw text and the raw provider response before any parsing occurs', () => {
  const dir = artifactDir('store-raw');
  const store = createArtifactStore(dir);
  store.initialize();
  store.persistRaw('SESSION-1', 'raw text', { some: 'response' });
  assert.equal(rawExists(dir, 'SESSION-1'), true);
});

console.log('\n--- executeDuplicateAuditSession: raw-first STOP behavior ---');

await check('a provider transport error stops after one attempt, with no retry or later call', async () => {
  const dir = artifactDir('provider-error');
  const store = createArtifactStore(dir);
  store.initialize();
  const tasks = makeTasks(4);
  const layerA = loadFrozenLayerABytes();
  const plan = computeD1D2SessionPlan({ roundId: 'DUP-R00', corpusTasks: tasks, auditScopeIds: tasks.map((t) => t.candidateId), layerABytes: layerA });
  const state = { sessions: [], results: [] };
  const transport = async () => { throw new Error('synthetic transport failure'); };
  await assert.rejects(() => executeDuplicateAuditSession({
    session: { ...plan.d1, roundId: 'DUP-R00' }, store, state, transport,
    credentials: { claude: 'x', gemini: 'y' }, revalidate: async () => makeSnapshot(),
    corpusTaskIds: plan.corpusTaskIds, pairUniverse: plan.pairUniverse, envelopeForProvider: () => ({ maxOutputTokens: 4096, thinkingLevel: null }),
  }), (error) => error.code === 'STOP_PROVIDER_ERROR');
  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0].outcome, 'STOP_PROVIDER_ERROR');
});

await check('a MAX_TOKENS-signaled response stops even though the truncated text is valid JSON', async () => {
  const dir = artifactDir('max-tokens');
  const store = createArtifactStore(dir);
  store.initialize();
  const tasks = makeTasks(4);
  const layerA = loadFrozenLayerABytes();
  const plan = computeD1D2SessionPlan({ roundId: 'DUP-R00', corpusTasks: tasks, auditScopeIds: tasks.map((t) => t.candidateId), layerABytes: layerA });
  const state = { sessions: [], results: [] };
  const transport = async (call) => fakeResponse(call, { duplicatePairs: [] }, { stopReason: 'MAX_TOKENS' });
  await assert.rejects(() => executeDuplicateAuditSession({
    session: { ...plan.d1, roundId: 'DUP-R00' }, store, state, transport,
    credentials: { claude: 'x', gemini: 'y' }, revalidate: async () => makeSnapshot(),
    corpusTaskIds: plan.corpusTaskIds, pairUniverse: plan.pairUniverse, envelopeForProvider: () => ({ maxOutputTokens: 4096, thinkingLevel: null }),
  }), (error) => error.code === 'STOP_MAX_TOKENS_TRUNCATED');
  assert.equal(rawExists(dir, plan.d1.sessionId), true, 'raw evidence must be preserved before the STOP fires');
  assert.equal(state.results.length, 0, 'no result may be admitted from a MAX_TOKENS-truncated response');
});

await check('Claude\'s lowercase stop_reason "max_tokens" is recognized identically to Gemini\'s uppercase form', async () => {
  const dir = artifactDir('max-tokens-case');
  const store = createArtifactStore(dir);
  store.initialize();
  const tasks = makeTasks(4);
  const layerA = loadFrozenLayerABytes();
  const plan = computeD1D2SessionPlan({ roundId: 'DUP-R00', corpusTasks: tasks, auditScopeIds: tasks.map((t) => t.candidateId), layerABytes: layerA });
  const state = { sessions: [], results: [] };
  const transport = async (call) => fakeResponse(call, { duplicatePairs: [] }, { stopReason: 'max_tokens' });
  await assert.rejects(() => executeDuplicateAuditSession({
    session: { ...plan.d1, roundId: 'DUP-R00' }, store, state, transport,
    credentials: { claude: 'x', gemini: 'y' }, revalidate: async () => makeSnapshot(),
    corpusTaskIds: plan.corpusTaskIds, pairUniverse: plan.pairUniverse, envelopeForProvider: () => ({ maxOutputTokens: 4096, thinkingLevel: null }),
  }), (error) => error.code === 'STOP_MAX_TOKENS_TRUNCATED');
});

await check('a schema-invalid response stops after raw evidence is preserved', async () => {
  const dir = artifactDir('schema-violation');
  const store = createArtifactStore(dir);
  store.initialize();
  const tasks = makeTasks(4);
  const layerA = loadFrozenLayerABytes();
  const plan = computeD1D2SessionPlan({ roundId: 'DUP-R00', corpusTasks: tasks, auditScopeIds: tasks.map((t) => t.candidateId), layerABytes: layerA });
  const state = { sessions: [], results: [] };
  const transport = async (call) => fakeResponse(call, { duplicatePairs: [{ a: 'CBRP-GHOST', b: tasks[0].candidateId, reason: 'x' }] });
  await assert.rejects(() => executeDuplicateAuditSession({
    session: { ...plan.d1, roundId: 'DUP-R00' }, store, state, transport,
    credentials: { claude: 'x', gemini: 'y' }, revalidate: async () => makeSnapshot(),
    corpusTaskIds: plan.corpusTaskIds, pairUniverse: plan.pairUniverse, envelopeForProvider: () => ({ maxOutputTokens: 4096, thinkingLevel: null }),
  }), (error) => error.code === 'STOP_SCHEMA_VIOLATION');
  assert.equal(rawExists(dir, plan.d1.sessionId), true);
});

await check('a malformed (unparseable) response stops as STOP_MALFORMED_RESPONSE', async () => {
  const dir = artifactDir('malformed');
  const store = createArtifactStore(dir);
  store.initialize();
  const tasks = makeTasks(4);
  const layerA = loadFrozenLayerABytes();
  const plan = computeD1D2SessionPlan({ roundId: 'DUP-R00', corpusTasks: tasks, auditScopeIds: tasks.map((t) => t.candidateId), layerABytes: layerA });
  const state = { sessions: [], results: [] };
  const transport = async () => ({ text: 'not json at all', raw: {}, providerResolved: 'claude', modelResolved: 'claude-opus-5', stopReason: 'end_turn' });
  await assert.rejects(() => executeDuplicateAuditSession({
    session: { ...plan.d1, roundId: 'DUP-R00' }, store, state, transport,
    credentials: { claude: 'x', gemini: 'y' }, revalidate: async () => makeSnapshot(),
    corpusTaskIds: plan.corpusTaskIds, pairUniverse: plan.pairUniverse, envelopeForProvider: () => ({ maxOutputTokens: 4096, thinkingLevel: null }),
  }), (error) => error.code === 'STOP_MALFORMED_RESPONSE');
});

await check('duplicate/ambiguous reservation blocks redispatch of the same session after a restart', async () => {
  const dir = artifactDir('reservation-conflict');
  const store = createArtifactStore(dir);
  store.initialize();
  const tasks = makeTasks(4);
  const layerA = loadFrozenLayerABytes();
  const plan = computeD1D2SessionPlan({ roundId: 'DUP-R00', corpusTasks: tasks, auditScopeIds: tasks.map((t) => t.candidateId), layerABytes: layerA });
  store.reserve(plan.d1.sessionId, { status: 'RESERVED' });
  const state = { sessions: [], results: [] };
  const { transport } = makeTransport();
  await assert.rejects(() => executeDuplicateAuditSession({
    session: { ...plan.d1, roundId: 'DUP-R00' }, store, state, transport,
    credentials: { claude: 'x', gemini: 'y' }, revalidate: async () => makeSnapshot(),
    corpusTaskIds: plan.corpusTaskIds, pairUniverse: plan.pairUniverse, envelopeForProvider: () => ({ maxOutputTokens: 4096, thinkingLevel: null }),
  }), (error) => error.code === 'STOP_AMBIGUOUS_OR_CONSUMED_RESERVATION');
});

await check('missing required credential blocks dispatch before any transport call', async () => {
  const tasks = makeTasks(4);
  const layerA = loadFrozenLayerABytes();
  const plan = computeD1D2SessionPlan({ roundId: 'DUP-R00', corpusTasks: tasks, auditScopeIds: tasks.map((t) => t.candidateId), layerABytes: layerA });
  const store = createArtifactStore(artifactDir('missing-credential'));
  store.initialize();
  const state = { sessions: [], results: [] };
  const { calls, transport } = makeTransport();
  await assert.rejects(() => executeDuplicateAuditSession({
    session: { ...plan.d1, roundId: 'DUP-R00' }, store, state, transport,
    credentials: { claude: '', gemini: 'y' }, revalidate: async () => makeSnapshot(),
    corpusTaskIds: plan.corpusTaskIds, pairUniverse: plan.pairUniverse, envelopeForProvider: () => ({ maxOutputTokens: 4096, thinkingLevel: null }),
  }), (error) => error.code === 'STOP_CREDENTIAL_MISSING');
  assert.equal(calls.length, 0);
});

console.log('\n--- Complete synthetic D1/D2 + D3 round ---');

const tasks10 = makeTasks(10);
const ids10 = tasks10.map((t) => t.candidateId);
const successDir = artifactDir('success-round');
const confirmedPair = { a: ids10[0], b: ids10[1] };
const disagreePairs = [{ a: ids10[2], b: ids10[3] }, { a: ids10[4], b: ids10[5] }];

const d1d2Transport = makeTransport((call) => {
  if (call.role === 'D1') {
    return fakeResponse(call, { duplicatePairs: [
      { a: confirmedPair.a, b: confirmedPair.b, reason: 'shared decision, D1' },
      { a: disagreePairs[0].a, b: disagreePairs[0].b, reason: 'D1 only' },
    ] });
  }
  return fakeResponse(call, { duplicatePairs: [
    { a: confirmedPair.a, b: confirmedPair.b, reason: 'shared decision, D2' },
    { a: disagreePairs[1].a, b: disagreePairs[1].b, reason: 'D2 only' },
  ] });
});

const d1d2Result = await runD1D2Stage({
  authorizedBaseSha: AUTHORIZED_BASE,
  roundId: 'DUP-R00',
  corpusTasks: tasks10,
  auditScopeIds: ids10,
  artifactDir: successDir,
  transport: d1d2Transport.transport,
  credentials: { claude: 'x', gemini: 'y' },
  revalidate: async () => makeSnapshot(),
  envelopeForProvider: () => ({ maxOutputTokens: 4096, thinkingLevel: null }),
});

await check('runD1D2Stage dispatches exactly D1 then D2 and derives the correct outcome', () => {
  assert.equal(d1d2Transport.calls.length, 2);
  assert.deepEqual(d1d2Transport.calls.map((c) => c.role), ['D1', 'D2']);
  assert.equal(d1d2Result.status, ROUND_STATES.D3_REQUIRED);
  assert.equal(d1d2Result.outcome.confirmedPairs.length, 1);
  assert.equal(d1d2Result.outcome.disagreementSet.length, 2);
  assert.equal(readJson(successDir, 'VALIDATION.json').status, ROUND_STATES.D3_REQUIRED);
});

await check('D1 and D2 receive byte-identical prompts (same call, twice)', () => {
  assert.equal(d1d2Transport.calls[0].prompt, d1d2Transport.calls[1].prompt);
});

const d3Transport = makeTransport((call) => fakeResponse(call, { isDuplicate: true, reason: 'D3 says yes' }));
const d3Result = await runD3Stage({
  authorizedBaseSha: AUTHORIZED_BASE,
  roundId: 'DUP-R00',
  artifactDir: successDir,
  transport: d3Transport.transport,
  credentials: { claude: 'x', gemini: 'y' },
  revalidate: async () => makeSnapshot(),
  envelopeForProvider: () => ({ maxOutputTokens: 4096, thinkingLevel: null }),
});

await check('runD3Stage materializes a complete D3_ROUTE_MANIFEST.json and dispatches exactly the disagreement-set size', () => {
  assert.equal(d3Transport.calls.length, 2);
  const manifest = readJson(successDir, 'D3_ROUTE_MANIFEST.json');
  assert.equal(manifest.routeCount, 2);
  assert.deepEqual(manifest.routes.map((r) => `${r.a}__${r.b}`).sort(), disagreePairs.map((p) => `${p.a}__${p.b}`).sort());
});

await check('runD3Stage resolves all 10 tasks\' pairs to final decisions with majority-of-3 for disputed pairs', () => {
  const final = readJson(successDir, 'FINAL_DECISIONS.json').decisions;
  assert.equal(final.length, 45); // C(10,2)
  const disputed = final.filter((d) => d.source === 'D3_MAJORITY');
  assert.equal(disputed.length, 2);
  for (const d of disputed) assert.equal(d.finalIsDuplicate, true); // D1 or D2 true + D3 true -> majority true
  assert.equal(readJson(successDir, 'VALIDATION.json').status, ROUND_STATES.D3_COMPLETE);
});

await check('existing R1/R2-equivalent D1/D2 evidence is unchanged after the D3 stage runs (append-only)', () => {
  const sessions = readJson(successDir, 'SESSIONS.json').sessions;
  assert.equal(sessions.length, 4); // D1 + D2 + 2 D3
  assert.deepEqual(sessions.slice(0, 2).map((s) => s.sessionId), ['DUP-R00-D1', 'DUP-R00-D2']);
});

await check('finalizeRound applies round-0 retention (no incumbents) and reaches ROUND_COMPLETE', () => {
  const finalized = finalizeRound({ artifactDir: successDir, incumbents: [], focusSet: ids10 });
  assert.equal(finalized.status, ROUND_STATES.ROUND_COMPLETE);
  assert.equal(finalized.retention.rejected.length, 3); // 1 confirmed pair + 2 confirmed D3 pairs, each a 2-node component -> reject 1 each
  assert.equal(readJson(successDir, 'VALIDATION.json').status, ROUND_STATES.ROUND_COMPLETE);
});

console.log('\n--- D3 route manifest durability and fail-closed behavior (§8.4) ---');

async function runFreshD1D2NoDisagreement(label) {
  const dir = artifactDir(label);
  const tasks = makeTasks(6, `CBRP-${label}`);
  const ids = tasks.map((t) => t.candidateId);
  const { transport } = makeTransport((call) => fakeResponse(call, { duplicatePairs: [] }));
  await runD1D2Stage({
    authorizedBaseSha: AUTHORIZED_BASE, roundId: 'DUP-R00', corpusTasks: tasks, auditScopeIds: ids,
    artifactDir: dir, transport, credentials: { claude: 'x', gemini: 'y' }, revalidate: async () => makeSnapshot(), envelopeForProvider: () => ({ maxOutputTokens: 4096, thinkingLevel: null }),
  });
  return { dir, tasks, ids };
}

async function runFreshD1D2WithDisagreement(label) {
  const dir = artifactDir(label);
  const tasks = makeTasks(6, `CBRP-${label}`);
  const ids = tasks.map((t) => t.candidateId);
  const disputedPair = { a: ids[0], b: ids[1] };
  const { transport } = makeTransport((call) => {
    if (call.role === 'D1') return fakeResponse(call, { duplicatePairs: [{ a: disputedPair.a, b: disputedPair.b, reason: 'D1' }] });
    return fakeResponse(call, { duplicatePairs: [] });
  });
  await runD1D2Stage({
    authorizedBaseSha: AUTHORIZED_BASE, roundId: 'DUP-R00', corpusTasks: tasks, auditScopeIds: ids,
    artifactDir: dir, transport, credentials: { claude: 'x', gemini: 'y' }, revalidate: async () => makeSnapshot(), envelopeForProvider: () => ({ maxOutputTokens: 4096, thinkingLevel: null }),
  });
  return { dir, tasks, ids, disputedPair };
}

await check('D3 stage refuses to run when the D1/D2 stage found no disagreement (nothing to dispatch)', async () => {
  const { dir } = await runFreshD1D2NoDisagreement('d3-not-required');
  const { transport } = makeTransport();
  await assert.rejects(() => runD3Stage({
    authorizedBaseSha: AUTHORIZED_BASE, roundId: 'DUP-R00', artifactDir: dir, transport,
    credentials: { claude: 'x', gemini: 'y' }, revalidate: async () => makeSnapshot(), envelopeForProvider: () => ({ maxOutputTokens: 4096, thinkingLevel: null }),
  }), (error) => error.code === 'STOP_D1D2_STAGE_NOT_READY');
});

await check('a route-manifest persistence failure stops before any D3 transport call', async () => {
  const { dir } = await runFreshD1D2WithDisagreement('manifest-persist-failure');
  const baseStore = createArtifactStore(dir);
  const store = { ...baseStore, writeJson(name, value) {
    if (name === 'D3_ROUTE_MANIFEST.json') throw new Error('synthetic manifest write failure');
    return baseStore.writeJson(name, value);
  } };
  const { calls, transport } = makeTransport();
  await assert.rejects(() => runD3Stage({
    authorizedBaseSha: AUTHORIZED_BASE, roundId: 'DUP-R00', artifactDir: dir, transport,
    credentials: { claude: 'x', gemini: 'y' }, revalidate: async () => makeSnapshot(), store, envelopeForProvider: () => ({ maxOutputTokens: 4096, thinkingLevel: null }),
  }), (error) => error.code === 'STOP_D3_ROUTE_MANIFEST_PERSISTENCE_FAILED');
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(path.join(dir, 'D3_ROUTE_MANIFEST.json')), false);
});

await check('a reload mismatch after writing the manifest stops before any D3 transport call', async () => {
  const { dir } = await runFreshD1D2WithDisagreement('manifest-reload-mismatch');
  const baseStore = createArtifactStore(dir);
  let writeCount = 0;
  const store = { ...baseStore, readJson(name) {
    if (name === 'D3_ROUTE_MANIFEST.json' && writeCount > 0) return { corrupted: true };
    return baseStore.readJson(name);
  }, writeJson(name, value) {
    if (name === 'D3_ROUTE_MANIFEST.json') writeCount += 1;
    return baseStore.writeJson(name, value);
  } };
  const { calls, transport } = makeTransport();
  await assert.rejects(() => runD3Stage({
    authorizedBaseSha: AUTHORIZED_BASE, roundId: 'DUP-R00', artifactDir: dir, transport,
    credentials: { claude: 'x', gemini: 'y' }, revalidate: async () => makeSnapshot(), store, envelopeForProvider: () => ({ maxOutputTokens: 4096, thinkingLevel: null }),
  }), (error) => error.code === 'STOP_D3_ROUTE_MANIFEST_PERSISTENCE_FAILED');
  assert.equal(calls.length, 0);
});

await check('an existing route manifest that mismatches the recomputed plan stops with 0 D3 calls and is never overwritten', async () => {
  const { dir } = await runFreshD1D2WithDisagreement('manifest-mismatch');
  const store = createArtifactStore(dir);
  const forged = { protocolVersion: 'FORGED', d3Version: 'FORGED', roundId: 'DUP-R00', routeCount: 0, routes: [] };
  store.writeJson('D3_ROUTE_MANIFEST.json', forged);
  const { calls, transport } = makeTransport();
  await assert.rejects(() => runD3Stage({
    authorizedBaseSha: AUTHORIZED_BASE, roundId: 'DUP-R00', artifactDir: dir, transport,
    credentials: { claude: 'x', gemini: 'y' }, revalidate: async () => makeSnapshot(), envelopeForProvider: () => ({ maxOutputTokens: 4096, thinkingLevel: null }),
  }), (error) => error.code === 'STOP_D3_ROUTE_MANIFEST_MISMATCH');
  assert.equal(calls.length, 0);
  assert.deepEqual(readJson(dir, 'D3_ROUTE_MANIFEST.json'), forged);
});

await check('an existing route manifest that exactly matches the recomputed plan is accepted and dispatch proceeds', async () => {
  const { dir } = await runFreshD1D2WithDisagreement('manifest-exact-match');
  // Run D3 once for real to materialize the real manifest, using a throwaway store copy first.
  const probeStore = createArtifactStore(dir);
  const outcome = probeStore.readJson('D1D2_OUTCOME.json');
  const corpusTasks = probeStore.readJson('CORPUS_TASKS.json').corpusTasks;
  const taskById = new Map(corpusTasks.map((t) => [t.candidateId, t]));
  const layerA = loadFrozenLayerABytes();
  const { computeD3RoutePlan, buildD3RouteManifest } = await import('./duplicate-audit-runner.mjs');
  const plan = computeD3RoutePlan({ roundId: 'DUP-R00', disagreementSet: outcome.disagreementSet, taskById, layerABytes: layerA });
  const manifest = buildD3RouteManifest({ roundId: 'DUP-R00', d3RoutePlan: plan });
  probeStore.writeJson('D3_ROUTE_MANIFEST.json', manifest);

  const { calls, transport } = makeTransport((call) => fakeResponse(call, { isDuplicate: false, reason: 'no' }));
  const result = await runD3Stage({
    authorizedBaseSha: AUTHORIZED_BASE, roundId: 'DUP-R00', artifactDir: dir, transport,
    credentials: { claude: 'x', gemini: 'y' }, revalidate: async () => makeSnapshot(), envelopeForProvider: () => ({ maxOutputTokens: 4096, thinkingLevel: null }),
  });
  assert.equal(calls.length, 1, 'exactly one disputed pair in this fixture');
  assert.equal(result.status, ROUND_STATES.D3_COMPLETE);
  assert.deepEqual(readJson(dir, 'D3_ROUTE_MANIFEST.json'), manifest, 'the pre-existing manifest must not be overwritten');
});

await check('the complete route manifest is durably persisted before the first D3 transport call fires (not one route per call)', async () => {
  const dir = artifactDir('manifest-before-first-call');
  const tasks = makeTasks(8, 'CBRP-MBF');
  const ids = tasks.map((t) => t.candidateId);
  const disputed = [{ a: ids[0], b: ids[1] }, { a: ids[2], b: ids[3] }, { a: ids[4], b: ids[5] }];
  const { transport: d1d2t } = makeTransport((call) => {
    if (call.role === 'D1') return fakeResponse(call, { duplicatePairs: disputed.map((p) => ({ ...p, reason: 'D1' })) });
    return fakeResponse(call, { duplicatePairs: [] });
  });
  await runD1D2Stage({
    authorizedBaseSha: AUTHORIZED_BASE, roundId: 'DUP-R00', corpusTasks: tasks, auditScopeIds: ids,
    artifactDir: dir, transport: d1d2t, credentials: { claude: 'x', gemini: 'y' }, revalidate: async () => makeSnapshot(), envelopeForProvider: () => ({ maxOutputTokens: 4096, thinkingLevel: null }),
  });

  let manifestExistedBeforeFirstCall = null;
  const { transport: d3t } = makeTransport((call) => {
    if (manifestExistedBeforeFirstCall === null) {
      manifestExistedBeforeFirstCall = fs.existsSync(path.join(dir, 'D3_ROUTE_MANIFEST.json'));
      if (manifestExistedBeforeFirstCall) {
        const manifest = readJson(dir, 'D3_ROUTE_MANIFEST.json');
        assert.equal(manifest.routeCount, disputed.length, 'the manifest must already list every route, not just the first');
      }
    }
    return fakeResponse(call, { isDuplicate: false, reason: 'no' });
  });
  await runD3Stage({
    authorizedBaseSha: AUTHORIZED_BASE, roundId: 'DUP-R00', artifactDir: dir, transport: d3t,
    credentials: { claude: 'x', gemini: 'y' }, revalidate: async () => makeSnapshot(), envelopeForProvider: () => ({ maxOutputTokens: 4096, thinkingLevel: null }),
  });
  assert.equal(manifestExistedBeforeFirstCall, true);
});

console.log('\n--- Guarded LIVE entrypoint (never actually called with liveExecution: true in this suite) ---');

await check('dispatchLiveDuplicateAudit refuses without liveExecution: true', async () => {
  await assert.rejects(() => dispatchLiveDuplicateAudit({ authorizedBaseSha: AUTHORIZED_BASE, roundId: 'DUP-R00', stage: 'D1D2' }),
    (error) => error.code === 'STOP_LIVE_FLAG_REQUIRED');
});

await check('dispatchLiveDuplicateAudit refuses without a valid authorizedBaseSha even with liveExecution: true', async () => {
  await assert.rejects(() => dispatchLiveDuplicateAudit({ liveExecution: true, roundId: 'DUP-R00', stage: 'D1D2' }),
    (error) => error.code === 'STOP_AUTHORIZED_BASE_REQUIRED');
});

await check('dispatchLiveDuplicateAudit refuses an unrecognized roundId', async () => {
  await assert.rejects(() => dispatchLiveDuplicateAudit({ liveExecution: true, authorizedBaseSha: AUTHORIZED_BASE, roundId: 'NOT-A-ROUND', stage: 'D1D2' }),
    (error) => error.code === 'STOP_ROUND_INVALID');
});

console.log('\n--- Real-data blindness and namespace guard ---');

await check('test source embeds no real CWP-10E/Protocol-2.1 candidate text', () => {
  const real = JSON.parse(fs.readFileSync(new URL('../authoring-v2p1-round-0/CANDIDATES.json', import.meta.url), 'utf8')).candidates;
  const source = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  for (const candidate of real) {
    assert.equal(source.includes(candidate.taskText), false);
  }
});

await check('no real duplicate-audit-round-00 namespace was created by this offline suite', () => {
  assert.equal(fs.existsSync(new URL('../duplicate-audit-round-00/', import.meta.url)), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
console.log(`synthetic D1/D2 calls: ${d1d2Transport.calls.length}, synthetic D3 calls: ${d3Transport.calls.length}`);
console.log('0 real provider calls. 0 duplicate audit rounds executed against real evidence.');

rmSync(SCRATCH, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
