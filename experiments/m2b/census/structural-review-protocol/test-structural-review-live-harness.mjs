/** Offline-only synthetic verification for CBRP-STRUCTURAL-REVIEW-LIVE-HARNESS-1. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  HARNESS_VERSION,
  MAX_OUTPUT_TOKENS,
  EXPECTED_RUNTIME,
  ROUND_ARTIFACT_DIR_NAMES,
  StructuralReviewStop,
  assertRuntimeSnapshot,
  validateCandidatePool,
  createArtifactStore,
  assertReviewRoute,
  executeReviewSession,
  runInitialStructuralReviewStage,
  runR3StructuralReviewStage,
} from './structural-review-live-harness-v1.mjs';
import {
  REVIEWER_PINS,
  GENERATION_ENVELOPES,
  computeInitialReviewPlan,
  computeR3Plan,
  dispatchLiveStructuralReview,
} from './structural-review-runner.mjs';
import {
  EXPECTED_RUBRIC_BYTE_COUNT,
  EXPECTED_RUBRIC_SHA256,
  loadFrozenRubricPasteBytes,
} from './structural-review-prompt-v1.mjs';
import { BOOLEAN_CHECK_KEYS, computeStructuralD3Selector } from './structural-review-decision-v1.mjs';

const SCRATCH = mkdtempSync(path.join(tmpdir(), 'cbrp-structural-harness-'));
const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(DIR, '../../../..');
const AUTHORIZED_BASE = 'a'.repeat(40);
const RUBRIC = loadFrozenRubricPasteBytes();
const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const HISTORICAL_ROUND_SEALS = Object.freeze({
  'structural-review-round-0': Object.freeze({
    fileCount: 247,
    sha256: '98471ecc1ba395ce36297b4da78f5a93364ed1fcd59adb237acfbcbf69853157',
  }),
  'structural-review-round-1': Object.freeze({
    fileCount: 7,
    sha256: 'b7dfa9d806b092043194a90d8c73fa69deb89a06c1039530885310ea6073daec',
  }),
  'structural-review-round-2': Object.freeze({
    fileCount: 376,
    sha256: 'acc074ca27aa0addf2529374c676c6c7c21b92830c8aa6597d72530424dacd5b',
  }),
});

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

function makePool() {
  const pool = [];
  for (const code of ['SC', 'OP', 'BC', 'EI', 'PS', 'FR']) {
    for (let index = 1; index <= 10; index += 1) {
      const taskText = `Synthetic ${code} scenario ${index}; behavior fixture only.`;
      pool.push({
        taskCandidateId: `SYN-${code}-${String(index).padStart(2, '0')}`,
        stratumCode: code,
        taskText,
        taskBytes: Buffer.byteLength(taskText, 'utf8'),
        taskSha256: sha256(taskText),
      });
    }
  }
  return pool;
}

function makeSnapshot(overrides = {}) {
  return {
    head: AUTHORIZED_BASE,
    nodeVersion: EXPECTED_RUNTIME.nodeVersion,
    packageLockSha256: EXPECTED_RUNTIME.packageLockSha256,
    anthropicSdkVersion: EXPECTED_RUNTIME.anthropicSdkVersion,
    geminiSdkVersion: EXPECTED_RUNTIME.geminiSdkVersion,
    rubricBytes: EXPECTED_RUBRIC_BYTE_COUNT,
    rubricSha256: EXPECTED_RUBRIC_SHA256,
    sourceHashes: { ...EXPECTED_RUNTIME.sourceHashes },
    workingTreePaths: [],
    unexpectedWorkingTreePaths: [],
    ...overrides,
  };
}

function validReview(blindTaskId, overallPass = true) {
  const checks = Object.fromEntries(BOOLEAN_CHECK_KEYS.map((key) => [key, true]));
  if (!overallPass) checks.realistic = false;
  return {
    taskId: blindTaskId,
    ...checks,
    overallPass,
    reasons: 'Synthetic review fixture only.',
  };
}

function fakeResponse(call, parsed = validReview(call.blindTaskId, true), overrides = {}) {
  return {
    text: JSON.stringify(parsed),
    raw: { synthetic: true, model: call.model },
    providerResolved: call.provider,
    modelResolved: call.model,
    stopReason: 'STOP',
    ...overrides,
  };
}

function makeTransport(responseFactory) {
  const calls = [];
  const transport = async (call) => {
    calls.push({ ...call });
    return responseFactory ? responseFactory(call, calls.length - 1) : fakeResponse(call);
  };
  return { calls, transport };
}

function artifactDir(label) {
  return path.join(SCRATCH, label);
}

function readJson(dir, name) {
  return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
}

function rawExists(dir, reviewSessionId) {
  return fs.existsSync(path.join(dir, 'raw', `${reviewSessionId}.txt`))
    && fs.existsSync(path.join(dir, 'raw', `${reviewSessionId}.response.json`));
}

function directorySeal(dirName) {
  const root = path.join(REPO_ROOT, 'experiments', 'm2b', 'census', dirName);
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else files.push(absolute);
    }
  };
  walk(root);
  files.sort();
  const manifest = files
    .map((absolute) => `${path.relative(root, absolute)}\t${sha256(fs.readFileSync(absolute))}`)
    .join('\n') + '\n';
  return { fileCount: files.length, sha256: sha256(manifest) };
}

async function expectInitialStop(label, options, expectedCode) {
  const calls = options.calls ?? [];
  await assert.rejects(
    () => runInitialStructuralReviewStage({
      authorizedBaseSha: AUTHORIZED_BASE,
      pool: makePool(),
      rubricPasteBytes: RUBRIC,
      artifactDir: artifactDir(label),
      credentials: { claude: 'synthetic-claude', gemini: 'synthetic-gemini' },
      revalidate: async () => makeSnapshot(),
      ...options,
    }),
    (error) => error instanceof StructuralReviewStop && error.code === expectedCode
  );
  return calls;
}

console.log('\n=== CBRP STRUCTURAL REVIEW LIVE HARNESS — SYNTHETIC ONLY ===');

console.log('\n--- Frozen identities and mechanical pool validation ---');

await check('harness and max-output-token values are fixed', () => {
  assert.equal(HARNESS_VERSION, 'CBRP-STRUCTURAL-REVIEW-LIVE-HARNESS-1');
  assert.equal(MAX_OUTPUT_TOKENS, 4096);
});

await check('every SOURCE_HASHES repository file matches its frozen expected hash', () => {
  for (const [relative, expected] of Object.entries(EXPECTED_RUNTIME.sourceHashes)) {
    const actual = sha256(fs.readFileSync(path.join(REPO_ROOT, relative)));
    assert.equal(actual, expected, `${relative} source-manifest drift`);
  }
});

await check('synthetic 60-task pool passes count, id, hash, byte and stratum checks', () => {
  const result = validateCandidatePool(makePool());
  assert.equal(result.candidateCount, 60);
  assert.deepEqual(result.stratumCounts, { SC: 10, OP: 10, BC: 10, EI: 10, PS: 10, FR: 10 });
});

await check('invalid pool stops before transport dispatch', async () => {
  const { calls, transport } = makeTransport();
  const pool = makePool();
  pool[0].taskSha256 = '0'.repeat(64);
  await assert.rejects(() => runInitialStructuralReviewStage({
    authorizedBaseSha: AUTHORIZED_BASE,
    pool,
    rubricPasteBytes: RUBRIC,
    artifactDir: artifactDir('invalid-pool'),
    transport,
    credentials: { claude: 'x', gemini: 'y' },
    revalidate: async () => makeSnapshot(),
  }), (error) => error.code === 'STOP_POOL_INVALID');
  assert.equal(calls.length, 0);
});

console.log('\n--- Pre-dispatch guards ---');

await check('wrong base SHA is blocked before provider dispatch', async () => {
  const { calls, transport } = makeTransport();
  await expectInitialStop('wrong-base', {
    transport,
    calls,
    revalidate: async () => assertRuntimeSnapshot(makeSnapshot({ head: 'b'.repeat(40) }), { authorizedBaseSha: AUTHORIZED_BASE }),
  }, 'STOP_BASE_SHA_MISMATCH');
  assert.equal(calls.length, 0);
});

await check('unexpected working-tree drift is blocked before provider dispatch', async () => {
  const { calls, transport } = makeTransport();
  await expectInitialStop('worktree-drift', {
    transport,
    calls,
    revalidate: async () => assertRuntimeSnapshot(makeSnapshot({
      workingTreePaths: ['src/index.ts'],
      unexpectedWorkingTreePaths: ['src/index.ts'],
    }), { authorizedBaseSha: AUTHORIZED_BASE }),
  }, 'STOP_WORKTREE_DRIFT');
  assert.equal(calls.length, 0);
});

await check('protocol/module hash drift is blocked before provider dispatch', async () => {
  const { calls, transport } = makeTransport();
  const sourceHashes = { ...EXPECTED_RUNTIME.sourceHashes };
  sourceHashes['experiments/m2b/census/CBRP_STRUCTURAL_REVIEW_PROTOCOL_1.md'] = '0'.repeat(64);
  await expectInitialStop('protocol-drift', {
    transport,
    calls,
    revalidate: async () => assertRuntimeSnapshot(makeSnapshot({ sourceHashes }), { authorizedBaseSha: AUTHORIZED_BASE }),
  }, 'STOP_SOURCE_DRIFT');
  assert.equal(calls.length, 0);
});

await check('rubric hash mismatch is blocked before provider dispatch', async () => {
  const { calls, transport } = makeTransport();
  await expectInitialStop('rubric-drift', {
    transport,
    calls,
    revalidate: async () => assertRuntimeSnapshot(makeSnapshot({ rubricSha256: '0'.repeat(64) }), { authorizedBaseSha: AUTHORIZED_BASE }),
  }, 'STOP_RUBRIC_DRIFT');
  assert.equal(calls.length, 0);
});

await check('missing required credential is blocked before provider dispatch', async () => {
  const { calls, transport } = makeTransport();
  await expectInitialStop('missing-credential', {
    transport,
    calls,
    credentials: { claude: '', gemini: 'synthetic-gemini' },
  }, 'STOP_CREDENTIAL_MISSING');
  assert.equal(calls.length, 0);
});

await check('wrong provider/model route is blocked before provider dispatch', () => {
  let dispatches = 0;
  const plan = computeInitialReviewPlan({ pool: makePool(), rubricPasteBytes: RUBRIC });
  const first = plan[0];
  assert.throws(() => assertReviewRoute({
    taskCandidateId: first.taskCandidateId,
    blindTaskId: first.blindTaskId,
    reviewSessionId: first.r1.reviewId,
    reviewRole: 'R1',
    provider: REVIEWER_PINS.R2.provider,
    model: REVIEWER_PINS.R2.model,
    modelFamily: REVIEWER_PINS.R2.modelFamily,
    prompt: first.r1.prompt,
  }), (error) => error.code === 'STOP_REVIEW_ROUTE_MISMATCH');
  assert.equal(dispatches, 0);
});

await check('unexpected reviewSessionId is blocked before provider dispatch', () => {
  let dispatches = 0;
  const plan = computeInitialReviewPlan({ pool: makePool(), rubricPasteBytes: RUBRIC });
  const first = plan[0];
  assert.throws(() => assertReviewRoute({
    taskCandidateId: first.taskCandidateId,
    blindTaskId: first.blindTaskId,
    reviewSessionId: `${first.taskCandidateId}-R1-DUPLICATE`,
    reviewRole: 'R1',
    provider: first.r1.provider,
    model: first.r1.model,
    modelFamily: first.r1.modelFamily,
    prompt: first.r1.prompt,
  }), (error) => error.code === 'STOP_REVIEW_SESSION_ID_INVALID');
  assert.equal(dispatches, 0);
});

await check('raw persistence readiness failure is blocked before provider dispatch', async () => {
  const dir = artifactDir('raw-readiness');
  const baseStore = createArtifactStore(dir);
  const store = { ...baseStore, assertRawPersistenceReady() { throw new Error('synthetic raw store unavailable'); } };
  const { calls, transport } = makeTransport();
  await assert.rejects(() => runInitialStructuralReviewStage({
    authorizedBaseSha: AUTHORIZED_BASE,
    pool: makePool(),
    rubricPasteBytes: RUBRIC,
    artifactDir: dir,
    transport,
    credentials: { claude: 'x', gemini: 'y' },
    revalidate: async () => makeSnapshot(),
    store,
  }), (error) => error.code === 'STOP_RAW_PERSISTENCE_UNAVAILABLE');
  assert.equal(calls.length, 0);
});

await check('duplicate/ambiguous durable reservation blocks redispatch after restart', async () => {
  const dir = artifactDir('ambiguous-reservation');
  const store = createArtifactStore(dir);
  store.initialize();
  const first = computeInitialReviewPlan({ pool: makePool(), rubricPasteBytes: RUBRIC })[0];
  store.reserve(first.r1.reviewId, { reviewSessionId: first.r1.reviewId, status: 'RESERVED_WITHOUT_SETTLEMENT' });
  const { calls, transport } = makeTransport();
  await expectInitialStop('unused', { store, artifactDir: dir, transport, calls }, 'STOP_AMBIGUOUS_OR_CONSUMED_RESERVATION');
  assert.equal(calls.length, 0);
});

await check('default LIVE entrypoint remains guarded and cannot dispatch', async () => {
  await assert.rejects(() => dispatchLiveStructuralReview(), /LIVE dispatch is not authorized/);
});

console.log('\n--- Raw-first post-dispatch STOP behavior ---');

await check('provider error stops after one attempt, with no retry or later call', async () => {
  const { calls, transport } = makeTransport(async () => { throw new Error('synthetic provider failure'); });
  await expectInitialStop('provider-error', { transport, calls }, 'STOP_PROVIDER_ERROR');
  assert.equal(calls.length, 1);
  assert.equal(readJson(artifactDir('provider-error'), 'VALIDATION.json').providerDispatches, 1);
});

await check('observable model mismatch preserves raw then stops all later calls', async () => {
  const { calls, transport } = makeTransport((call) => fakeResponse(call, undefined, { modelResolved: 'wrong-model' }));
  await expectInitialStop('model-mismatch', { transport, calls }, 'STOP_MODEL_PIN_MISMATCH');
  assert.equal(calls.length, 1);
  assert.equal(rawExists(artifactDir('model-mismatch'), calls[0].reviewSessionId), true);
});

await check('extractor rejection preserves raw then stops all later calls', async () => {
  const { calls, transport } = makeTransport((call) => fakeResponse(call, undefined, { text: 'not json' }));
  await expectInitialStop('malformed', { transport, calls }, 'STOP_MALFORMED_RESPONSE');
  assert.equal(calls.length, 1);
  assert.equal(rawExists(artifactDir('malformed'), calls[0].reviewSessionId), true);
});

await check('schema rejection preserves raw then stops all later calls', async () => {
  const { calls, transport } = makeTransport((call) => fakeResponse(call, { taskId: call.blindTaskId }));
  await expectInitialStop('schema-invalid', { transport, calls }, 'STOP_SCHEMA_VALIDATION_FAILED');
  assert.equal(calls.length, 1);
  assert.equal(rawExists(artifactDir('schema-invalid'), calls[0].reviewSessionId), true);
});

await check('blind task id mismatch preserves raw then stops all later calls', async () => {
  const { calls, transport } = makeTransport((call) => fakeResponse(call, validReview('SR-wrong', true)));
  await expectInitialStop('blind-mismatch', { transport, calls }, 'STOP_BLIND_TASK_ID_MISMATCH');
  assert.equal(calls.length, 1);
  assert.equal(rawExists(artifactDir('blind-mismatch'), calls[0].reviewSessionId), true);
});

await check('overallPass invariant mismatch preserves raw then stops all later calls', async () => {
  const { calls, transport } = makeTransport((call) => {
    const review = validReview(call.blindTaskId, true);
    review.realistic = false;
    return fakeResponse(call, review);
  });
  await expectInitialStop('overall-mismatch', { transport, calls }, 'STOP_OVERALL_PASS_INVARIANT_MISMATCH');
  assert.equal(calls.length, 1);
  assert.equal(rawExists(artifactDir('overall-mismatch'), calls[0].reviewSessionId), true);
});

await check('post-response raw write failure stops before extraction and no later call runs', async () => {
  const dir = artifactDir('raw-write-failure');
  const baseStore = createArtifactStore(dir);
  const store = { ...baseStore, persistRaw() { throw new Error('synthetic raw write failure'); } };
  const { calls, transport } = makeTransport();
  await assert.rejects(() => runInitialStructuralReviewStage({
    authorizedBaseSha: AUTHORIZED_BASE,
    pool: makePool(),
    rubricPasteBytes: RUBRIC,
    artifactDir: dir,
    transport,
    credentials: { claude: 'x', gemini: 'y' },
    revalidate: async () => makeSnapshot(),
    store,
  }), (error) => error.code === 'STOP_RAW_PERSISTENCE_FAILED');
  assert.equal(calls.length, 1);
});

console.log('\n--- Complete synthetic INITIAL and separately authorized R3 stages ---');

const successDir = artifactDir('success');
const pool = makePool();
const orderedIds = computeInitialReviewPlan({ pool, rubricPasteBytes: RUBRIC }).map((entry) => entry.taskCandidateId);
const disagreeingIds = new Set(orderedIds.filter((_, index) => index % 3 === 0));
const initialTransport = makeTransport((call) => {
  const shouldFail = call.reviewRole === 'R2'
    && disagreeingIds.has(call.reviewSessionId.replace(/-R2$/, ''));
  return fakeResponse(call, validReview(call.blindTaskId, !shouldFail));
});
let revalidationCount = 0;
const initialResult = await runInitialStructuralReviewStage({
  authorizedBaseSha: AUTHORIZED_BASE,
  pool,
  rubricPasteBytes: RUBRIC,
  artifactDir: successDir,
  transport: initialTransport.transport,
  credentials: { claude: 'synthetic-claude', gemini: 'synthetic-gemini' },
  revalidate: async () => {
    revalidationCount += 1;
    return { syntheticRuntimeSnapshotOrdinal: revalidationCount };
  },
});

await check('INITIAL makes exactly 120 fake calls in R1-then-R2 frozen task order', () => {
  assert.equal(initialTransport.calls.length, 120);
  assert.equal(revalidationCount, 120);
  assert.deepEqual(
    initialTransport.calls.map((call) => call.reviewSessionId),
    orderedIds.flatMap((id) => [`${id}-R1`, `${id}-R2`])
  );
  assert.equal(new Set(initialTransport.calls.map((call) => call.reviewSessionId)).size, 120);
});

await check('R1/R2 prompts are byte-identical per task and each call is stateless', () => {
  for (let i = 0; i < initialTransport.calls.length; i += 2) {
    assert.equal(initialTransport.calls[i].prompt, initialTransport.calls[i + 1].prompt);
    assert.notEqual(initialTransport.calls[i], initialTransport.calls[i + 1]);
    assert.equal(initialTransport.calls[i].maxOutputTokens, 4096);
    assert.equal(initialTransport.calls[i].temperature, null);
  }
});

await check('INITIAL preserves every valid raw response before recording 120 reviews', () => {
  const rawFiles = fs.readdirSync(path.join(successDir, 'raw')).filter((name) => !name.startsWith('.probe-'));
  assert.equal(rawFiles.length, 240);
  assert.equal(readJson(successDir, 'REVIEWS.json').reviews.length, 120);
});

await check('INITIAL materializes disagreements and never dispatches R3 automatically', () => {
  assert.equal(initialResult.status, 'INITIAL_COMPLETE');
  assert.equal(initialResult.calls, 120);
  assert.equal(initialResult.automaticR3Dispatched, false);
  assert.equal(initialTransport.calls.some((call) => call.reviewRole === 'R3'), false);
  assert.equal(initialResult.disagreements.length, disagreeingIds.size);
  assert.equal(readJson(successDir, 'VALIDATION.json').status, 'INITIAL_COMPLETE');
});

const promptByTask = new Map();
for (const call of initialTransport.calls) promptByTask.set(call.reviewSessionId.replace(/-R[12]$/, ''), call.prompt);
const r3Transport = makeTransport((call) => {
  const route = computeStructuralD3Selector(call.reviewSessionId.replace(/-R3$/, ''));
  assert.equal(call.provider, route.provider);
  assert.equal(call.model, route.model);
  assert.equal(call.prompt, promptByTask.get(call.reviewSessionId.replace(/-R3$/, '')));
  return fakeResponse(call, validReview(call.blindTaskId, true));
});
const r3Result = await runR3StructuralReviewStage({
  authorizedBaseSha: AUTHORIZED_BASE,
  artifactDir: successDir,
  transport: r3Transport.transport,
  credentials: { claude: 'synthetic-claude', gemini: 'synthetic-gemini' },
  revalidate: async () => ({ syntheticRuntimeSnapshot: true }),
});

await check('R3 call count exactly equals the frozen synthetic disagreement count', () => {
  assert.equal(r3Transport.calls.length, disagreeingIds.size);
  assert.equal(r3Result.calls, disagreeingIds.size);
});

await check('R3 uses CBRP-D3-v1 routing and the byte-identical R1/R2 prompt', () => {
  for (const call of r3Transport.calls) {
    const taskId = call.reviewSessionId.replace(/-R3$/, '');
    const route = computeStructuralD3Selector(taskId);
    assert.equal(call.provider, route.provider);
    assert.equal(call.model, route.model);
    assert.equal(call.prompt, promptByTask.get(taskId));
  }
});

await check('R3 requires a completed initial-stage artifact set', async () => {
  const { transport } = makeTransport();
  await assert.rejects(() => runR3StructuralReviewStage({
    authorizedBaseSha: AUTHORIZED_BASE,
    artifactDir: artifactDir('r3-without-initial'),
    transport,
    credentials: { claude: 'x', gemini: 'y' },
    revalidate: async () => makeSnapshot(),
  }), /INITIAL_COMPLETE|ENOENT/);
});

console.log('\n--- CWP-11F: R3 route manifest durability (protocol §9) ---');

async function runFreshInitialStage(label) {
  const dir = artifactDir(label);
  const { transport } = makeTransport((call) => {
    const shouldFail = call.reviewRole === 'R2'
      && disagreeingIds.has(call.reviewSessionId.replace(/-R2$/, ''));
    return fakeResponse(call, validReview(call.blindTaskId, !shouldFail));
  });
  await runInitialStructuralReviewStage({
    authorizedBaseSha: AUTHORIZED_BASE,
    pool,
    rubricPasteBytes: RUBRIC,
    artifactDir: dir,
    transport,
    credentials: { claude: 'synthetic-claude', gemini: 'synthetic-gemini' },
    revalidate: async () => ({ syntheticRuntimeSnapshot: true }),
  });
  return dir;
}

await check('R3_ROUTE_MANIFEST.json is durably persisted with every route before the first R3 transport call', () => {
  const manifest = readJson(successDir, 'R3_ROUTE_MANIFEST.json');
  assert.equal(manifest.harnessVersion, HARNESS_VERSION);
  assert.equal(manifest.roundId, 'ROUND_0');
  assert.equal(manifest.routeCount, disagreeingIds.size);
  assert.equal(manifest.routes.length, disagreeingIds.size);
  assert.deepEqual(
    new Set(manifest.routes.map((route) => route.taskCandidateId)),
    disagreeingIds
  );
});

await check('manifest route order equals the frozen filtered initial order', () => {
  const manifest = readJson(successDir, 'R3_ROUTE_MANIFEST.json');
  const expectedOrder = orderedIds.filter((id) => disagreeingIds.has(id));
  assert.deepEqual(manifest.routes.map((route) => route.taskCandidateId), expectedOrder);
});

await check('manifest provider/model/D3-selector fields equal an independent computeR3Plan() derivation', () => {
  const manifest = readJson(successDir, 'R3_ROUTE_MANIFEST.json');
  const reviewResultsByTaskId = new Map(orderedIds.map((id) => [id, {
    r1Review: { overallPass: true },
    r2Review: { overallPass: !disagreeingIds.has(id) },
  }]));
  const expectedPlan = computeR3Plan({
    initialPlan: computeInitialReviewPlan({ pool, rubricPasteBytes: RUBRIC }),
    reviewResultsByTaskId,
  });
  const expectedByTaskId = new Map(expectedPlan.map((entry) => [entry.taskCandidateId, entry]));
  assert.equal(manifest.routes.length, expectedPlan.length);
  for (const route of manifest.routes) {
    const expected = expectedByTaskId.get(route.taskCandidateId);
    assert.equal(route.provider, expected.r3.provider);
    assert.equal(route.model, expected.r3.model);
    assert.equal(route.modelFamily, expected.r3.modelFamily);
    assert.equal(route.d3Selector, expected.r3.d3Selector);
    assert.equal(route.d3SelectorInput, expected.r3.d3SelectorInput);
    assert.equal(route.reviewSessionId, `${route.taskCandidateId}-R3`);
    assert.equal(route.promptSha256, expected.r3.prompt.promptSha256);
  }
});

await check('a route-manifest persistence failure stops before any R3 transport call', async () => {
  const dir = await runFreshInitialStage('r3-manifest-persist-failure');
  const baseStore = createArtifactStore(dir);
  const store = { ...baseStore, writeJson(name, value) {
    if (name === 'R3_ROUTE_MANIFEST.json') throw new Error('synthetic manifest write failure');
    return baseStore.writeJson(name, value);
  } };
  const { calls, transport } = makeTransport();
  await assert.rejects(() => runR3StructuralReviewStage({
    authorizedBaseSha: AUTHORIZED_BASE,
    artifactDir: dir,
    transport,
    credentials: { claude: 'x', gemini: 'y' },
    revalidate: async () => ({ syntheticRuntimeSnapshot: true }),
    store,
  }), (error) => error.code === 'STOP_R3_ROUTE_MANIFEST_PERSISTENCE_FAILED');
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(path.join(dir, 'R3_ROUTE_MANIFEST.json')), false);
});

await check('an existing route manifest that mismatches the recomputed plan stops with 0 R3 calls and is never overwritten', async () => {
  const dir = await runFreshInitialStage('r3-manifest-mismatch');
  const store = createArtifactStore(dir);
  const forged = {
    harnessVersion: HARNESS_VERSION,
    protocolVersion: 'FORGED',
    d3Version: 'FORGED',
    roundId: 'ROUND_0',
    routeCount: 0,
    routes: [],
  };
  store.writeJson('R3_ROUTE_MANIFEST.json', forged);
  const { calls, transport } = makeTransport();
  await assert.rejects(() => runR3StructuralReviewStage({
    authorizedBaseSha: AUTHORIZED_BASE,
    artifactDir: dir,
    transport,
    credentials: { claude: 'x', gemini: 'y' },
    revalidate: async () => ({ syntheticRuntimeSnapshot: true }),
  }), (error) => error.code === 'STOP_R3_ROUTE_MANIFEST_MISMATCH');
  assert.equal(calls.length, 0);
  assert.deepEqual(readJson(dir, 'R3_ROUTE_MANIFEST.json'), forged);
});

await check('R3 route metadata (D3 selector, provider, model) never appears in the model-visible prompt', () => {
  const manifest = readJson(successDir, 'R3_ROUTE_MANIFEST.json');
  for (const route of manifest.routes) {
    const prompt = promptByTask.get(route.taskCandidateId);
    assert.equal(prompt.includes(route.d3Selector), false);
    assert.equal(prompt.includes(route.d3SelectorInput), false);
    assert.equal(prompt.includes(route.provider), false);
    assert.equal(prompt.includes(route.model), false);
  }
});

await check('existing R1/R2 review evidence is byte-identical after the R3 stage materializes its manifest', async () => {
  const dir = await runFreshInitialStage('r3-preserves-initial-evidence');
  const beforeR3 = readJson(dir, 'REVIEWS.json').reviews;
  const { transport } = makeTransport((call) => fakeResponse(call, validReview(call.blindTaskId, true)));
  await runR3StructuralReviewStage({
    authorizedBaseSha: AUTHORIZED_BASE,
    artifactDir: dir,
    transport,
    credentials: { claude: 'synthetic-claude', gemini: 'synthetic-gemini' },
    revalidate: async () => ({ syntheticRuntimeSnapshot: true }),
  });
  const afterR3 = readJson(dir, 'REVIEWS.json').reviews;
  assert.deepEqual(afterR3.slice(0, beforeR3.length), beforeR3);
  assert.equal(afterR3.length, beforeR3.length + disagreeingIds.size);
});

console.log('\n--- CWP-11B/CWP-11D: round generation envelopes ---');

await check('GENERATION_ENVELOPES.ROUND_0 matches the historical MAX_OUTPUT_TOKENS constant exactly', () => {
  assert.equal(GENERATION_ENVELOPES.ROUND_0.claude.maxOutputTokens, MAX_OUTPUT_TOKENS);
  assert.equal(GENERATION_ENVELOPES.ROUND_0.gemini.maxOutputTokens, MAX_OUTPUT_TOKENS);
  assert.equal(GENERATION_ENVELOPES.ROUND_0.claude.thinkingLevel, undefined);
  assert.equal(GENERATION_ENVELOPES.ROUND_0.gemini.thinkingLevel, undefined);
});

await check('ROUND_1 and ROUND_2 share the exact Amendment-1 provider envelopes', () => {
  assert.equal(GENERATION_ENVELOPES.ROUND_1.claude.maxOutputTokens, 4096);
  assert.equal(GENERATION_ENVELOPES.ROUND_1.gemini.maxOutputTokens, 32768);
  assert.equal(GENERATION_ENVELOPES.ROUND_1.gemini.thinkingLevel, 'medium');
  assert.equal(GENERATION_ENVELOPES.ROUND_2.amendmentVersion, GENERATION_ENVELOPES.ROUND_1.amendmentVersion);
  assert.deepEqual(GENERATION_ENVELOPES.ROUND_2.claude, GENERATION_ENVELOPES.ROUND_1.claude);
  assert.deepEqual(GENERATION_ENVELOPES.ROUND_2.gemini, GENERATION_ENVELOPES.ROUND_1.gemini);
});

await check('ROUND_1 dispatch: Claude (R1) call receives maxOutputTokens 4096, no thinkingLevel', async () => {
  const dir = artifactDir('round1-claude-envelope');
  const { calls, transport } = makeTransport();
  await runInitialStructuralReviewStage({
    authorizedBaseSha: AUTHORIZED_BASE,
    pool: makePool(),
    rubricPasteBytes: RUBRIC,
    artifactDir: dir,
    transport,
    credentials: { claude: 'x', gemini: 'y' },
    revalidate: async () => makeSnapshot(),
    roundId: 'ROUND_1',
  });
  const r1Calls = calls.filter((call) => call.reviewRole === 'R1');
  assert.equal(r1Calls.length, 60);
  for (const call of r1Calls) {
    assert.equal(call.maxOutputTokens, 4096);
    assert.equal(call.thinkingLevel, null);
  }
});

await check('ROUND_1 dispatch: Gemini (R2) call receives maxOutputTokens 32768 and thinkingLevel medium', async () => {
  const dir = artifactDir('round1-gemini-envelope');
  const { calls, transport } = makeTransport();
  await runInitialStructuralReviewStage({
    authorizedBaseSha: AUTHORIZED_BASE,
    pool: makePool(),
    rubricPasteBytes: RUBRIC,
    artifactDir: dir,
    transport,
    credentials: { claude: 'x', gemini: 'y' },
    revalidate: async () => makeSnapshot(),
    roundId: 'ROUND_1',
  });
  const r2Calls = calls.filter((call) => call.reviewRole === 'R2');
  assert.equal(r2Calls.length, 60);
  for (const call of r2Calls) {
    assert.equal(call.maxOutputTokens, 32768);
    assert.equal(call.thinkingLevel, 'medium');
  }
});

await check('ROUND_1 initial plan contains exactly 120 sessions (60 R1 + 60 R2), same as ROUND_0', async () => {
  const dir = artifactDir('round1-cardinality');
  const { calls, transport } = makeTransport();
  const result = await runInitialStructuralReviewStage({
    authorizedBaseSha: AUTHORIZED_BASE,
    pool: makePool(),
    rubricPasteBytes: RUBRIC,
    artifactDir: dir,
    transport,
    credentials: { claude: 'x', gemini: 'y' },
    revalidate: async () => makeSnapshot(),
    roundId: 'ROUND_1',
  });
  assert.equal(calls.length, 120);
  assert.equal(result.calls, 120);
  assert.equal(readJson(dir, 'VALIDATION.json').roundId, 'ROUND_1');
});

await check('ROUND_2 dispatch is recognized with 120 sessions and the unchanged ROUND_1 envelope', async () => {
  const dir = artifactDir('round2-cardinality-envelope');
  const { calls, transport } = makeTransport();
  const result = await runInitialStructuralReviewStage({
    authorizedBaseSha: AUTHORIZED_BASE,
    pool: makePool(),
    rubricPasteBytes: RUBRIC,
    artifactDir: dir,
    transport,
    credentials: { claude: 'x', gemini: 'y' },
    revalidate: async () => makeSnapshot(),
    roundId: 'ROUND_2',
  });
  assert.equal(ROUND_ARTIFACT_DIR_NAMES.ROUND_2, 'structural-review-round-2');
  assert.equal(calls.length, 120);
  assert.equal(result.calls, 120);
  assert.equal(readJson(dir, 'VALIDATION.json').roundId, 'ROUND_2');
  for (const call of calls.filter((entry) => entry.reviewRole === 'R1')) {
    assert.equal(call.maxOutputTokens, 4096);
    assert.equal(call.thinkingLevel, null);
  }
  for (const call of calls.filter((entry) => entry.reviewRole === 'R2')) {
    assert.equal(call.maxOutputTokens, 32768);
    assert.equal(call.thinkingLevel, 'medium');
  }
});

await check('an unrecognized roundId is refused before any transport dispatch', async () => {
  const { calls, transport } = makeTransport();
  await assert.rejects(() => runInitialStructuralReviewStage({
    authorizedBaseSha: AUTHORIZED_BASE,
    pool: makePool(),
    rubricPasteBytes: RUBRIC,
    artifactDir: artifactDir('round-invalid'),
    transport,
    credentials: { claude: 'x', gemini: 'y' },
    revalidate: async () => makeSnapshot(),
    roundId: 'ROUND_3',
  }), (error) => error.code === 'STOP_ROUND_INVALID');
  assert.equal(calls.length, 0);
});

console.log('\n--- CWP-11B: MAX_TOKENS fail-closed rule ---');

await check('a MAX_TOKENS-signaled response stops the session even though its truncated text is valid JSON', async () => {
  const dir = artifactDir('max-tokens-valid-json');
  const { calls, transport } = makeTransport((call) =>
    fakeResponse(call, undefined, {
      // Deliberately valid, complete JSON -- the packet is explicit that this
      // must still stop: apparent syntactic validity is not evidence of
      // completeness once the provider itself reports truncation.
      text: JSON.stringify(validReview(call.blindTaskId, true)),
      stopReason: 'MAX_TOKENS',
    })
  );
  await expectInitialStop('max-tokens-valid-json', { transport, calls }, 'STOP_MAX_TOKENS_TRUNCATED');
  assert.equal(calls.length, 1, 'no later session may be dispatched after a MAX_TOKENS stop');
  assert.equal(rawExists(dir, calls[0].reviewSessionId), true, 'raw evidence must be preserved before the STOP fires');
});

await check('Claude\'s lowercase stop_reason "max_tokens" is recognized identically to Gemini\'s uppercase form', async () => {
  const { calls, transport } = makeTransport((call) =>
    fakeResponse(call, undefined, { stopReason: 'max_tokens' })
  );
  await expectInitialStop('max-tokens-claude-case', { transport, calls }, 'STOP_MAX_TOKENS_TRUNCATED');
  assert.equal(calls.length, 1);
});

await check('a MAX_TOKENS stop records no extractorVersion/mechanicalValidation -- extraction never runs', async () => {
  const dir = artifactDir('max-tokens-no-extraction');
  const { transport } = makeTransport((call) =>
    fakeResponse(call, undefined, { text: JSON.stringify(validReview(call.blindTaskId, true)), stopReason: 'MAX_TOKENS' })
  );
  await assert.rejects(() => runInitialStructuralReviewStage({
    authorizedBaseSha: AUTHORIZED_BASE,
    pool: makePool(),
    rubricPasteBytes: RUBRIC,
    artifactDir: dir,
    transport,
    credentials: { claude: 'x', gemini: 'y' },
    revalidate: async () => makeSnapshot(),
  }), (error) => error.code === 'STOP_MAX_TOKENS_TRUNCATED');
  const sessions = readJson(dir, 'SESSIONS.json').sessions;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].extractorVersion, undefined);
  assert.equal(sessions[0].mechanicalValidation, undefined);
  assert.equal(readJson(dir, 'REVIEWS.json').reviews.length, 0, 'no review may be admitted from a MAX_TOKENS-truncated response');
});

console.log('\n--- Real-data blindness and real namespace guard ---');

await check('test source embeds no real CWP-10E candidate text', () => {
  const real = JSON.parse(fs.readFileSync(new URL('../authoring-v2p1-round-0/CANDIDATES.json', import.meta.url), 'utf8')).candidates;
  const source = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  for (const candidate of real) {
    assert.equal(source.includes(candidate.taskText), false);
  }
});

await check('structural-review-round-0 namespace is real, immutable ROUND_0 evidence, not something this test suite created', () => {
  // CWP-11B: ROUND_0 actually ran LIVE and FAILED_CLOSED (STOP_MALFORMED_RESPONSE
  // on a Gemini R2 MAX_TOKENS truncation, V21-B01-S00-EI-02-R2) -- so this
  // namespace legitimately exists now. This suite must never write into it; it
  // only reads VALIDATION.json to confirm the immutable outcome this amendment
  // is responding to, never as a fixture whose content this file defines.
  const validation = JSON.parse(fs.readFileSync(new URL('../structural-review-round-0/VALIDATION.json', import.meta.url), 'utf8'));
  assert.equal(validation.status, 'INITIAL_INCOMPLETE');
  assert.equal(validation.sessionsRecorded, 80);
  assert.equal(validation.reviewsValidated, 79);
  assert.deepEqual(directorySeal('structural-review-round-0'), HISTORICAL_ROUND_SEALS['structural-review-round-0']);
});

await check('structural-review-round-1 preserves the immutable zero-call STOP_SOURCE_DRIFT evidence', () => {
  const validation = JSON.parse(fs.readFileSync(new URL('../structural-review-round-1/VALIDATION.json', import.meta.url), 'utf8'));
  assert.equal(validation.status, 'INITIAL_INCOMPLETE');
  assert.equal(validation.stopCode, 'STOP_SOURCE_DRIFT');
  assert.equal(validation.providerDispatches, 0);
  assert.deepEqual(directorySeal('structural-review-round-1'), HISTORICAL_ROUND_SEALS['structural-review-round-1']);
});

await check('structural-review-round-2 preserves the immutable 122/122 R3_COMPLETE final evidence (CWP-11G)', () => {
  // CWP-11E ran ROUND_2 INITIAL LIVE (120 sessions, 2 disagreements) and CWP-11G
  // completed protocol-defined R3 LIVE (2 sessions, both resolved to finalPass=true).
  // This suite must never write into this namespace; it only reads the artifacts to
  // confirm the immutable final CLOSED evidence baseline.
  const validation = JSON.parse(fs.readFileSync(new URL('../structural-review-round-2/VALIDATION.json', import.meta.url), 'utf8'));
  assert.equal(validation.status, 'R3_COMPLETE');
  assert.equal(validation.roundId, 'ROUND_2');
  assert.equal(validation.sessionsRecorded, 122);
  assert.equal(validation.reviewsValidated, 122);
  assert.equal(validation.providerDispatches, 122);
  assert.equal(validation.disagreementCount, 2);
  assert.equal(validation.automaticR3Dispatched, false);
  assert.equal(validation.r3Expected, 2);
  assert.equal(validation.r3Dispatched, 2);
  assert.equal(validation.finalDecisionCount, 60);

  const disagreements = JSON.parse(fs.readFileSync(new URL('../structural-review-round-2/DISAGREEMENTS.json', import.meta.url), 'utf8'));
  assert.deepEqual(
    disagreements.disagreements.map((entry) => entry.taskCandidateId),
    ['V21-B05-S00-OP-02', 'V21-B01-S00-OP-01']
  );

  assert.equal(fs.existsSync(new URL('../structural-review-round-2/R3_ROUTE_MANIFEST.json', import.meta.url)), true);
  const r3RouteManifest = JSON.parse(fs.readFileSync(new URL('../structural-review-round-2/R3_ROUTE_MANIFEST.json', import.meta.url), 'utf8'));
  assert.equal(r3RouteManifest.routeCount, 2);

  const finalDecisions = JSON.parse(fs.readFileSync(new URL('../structural-review-round-2/FINAL_DECISIONS.json', import.meta.url), 'utf8'));
  assert.equal(finalDecisions.decisions.length, 60);
  assert.equal(finalDecisions.decisions.every((entry) => entry.status === 'FINAL'), true);
  assert.equal(finalDecisions.decisions.some((entry) => entry.status === 'PENDING_R3'), false);

  assert.deepEqual(directorySeal('structural-review-round-2'), HISTORICAL_ROUND_SEALS['structural-review-round-2']);
});

console.log(`\n${passed} passed, ${failed} failed`);
console.log(`synthetic initial calls: ${initialTransport.calls.length}`);
console.log(`synthetic R3 calls: ${disagreeingIds.size}/${r3Transport.calls.length}`);
console.log('0 provider calls. 0 structural reviews. 0 replacement sessions. 0 duplicate audits. 0 Chief calls.');

rmSync(SCRATCH, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
