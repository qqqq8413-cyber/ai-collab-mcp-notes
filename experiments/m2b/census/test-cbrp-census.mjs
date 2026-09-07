/**
 * Offline rehearsal for a CBRP Phase 1 census session.
 *
 * ## The fixtures here are TEST-ONLY and are NOT CBRP CANDIDATES
 *
 * Every task below is machine-generated filler whose only job is to be sixty distinct
 * strings with stable hashes. They are deliberately not realistic decisions, so that none
 * of them can ever be promoted into the real pool: a task written while its author could
 * see the event definition is exactly what the blinded authoring procedure exists to
 * exclude, and these were written with the event definition in view.
 *
 * ## What the rehearsal is for
 *
 * Every failure path a live census could take is exercised here, with a stub dispatcher,
 * before a single provider call is ever authorized. The paths that matter most are the
 * ones that must NOT happen: a failure becoming Y = 0, an unsettled reservation being
 * retried, a worker call being merely budgeted rather than refused.
 *
 * Zero provider calls. Zero live execution.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPlanningStage } from '../../../dist/modes/orchestrator.js';
import {
  ATTEMPT_RESERVED, ATTEMPT_SETTLED, AMBIGUOUS_ATTEMPT_CONSUMED, NEVER_ATTEMPTED,
  RESERVED_UNSETTLED, SETTLED, AttemptRegistryError, attemptKey, openAttemptRegistry,
  readRecords, recoverSession,
} from './attempt-registry.mjs';
import {
  CENSUS_ALLOWED_STAGES, GLOBAL_LOGICAL_CALL_BUDGET, PER_TASK_LOGICAL_CALL_BUDGET,
  createPlanningRecorder,
} from './planning-recorder.mjs';
import { CENSUS_DEPENDENCY_BASELINE, censusDependencyProvenance, matchesCensusBaseline, assertCensusDependencies, CensusProvenanceError } from './census-provenance.mjs';
import { assertBuildBinding, buildBinding, BuildBindingError } from './build-binding.mjs';
import {
  EXPECTED_PLANNING_PIN, NO_STATISTICAL_VERDICT, SESSION_COMPLETE, SESSION_INCOMPLETE,
  STUDY_VERSION, deriveEvents, runCensusSession,
} from './census-session.mjs';
import { verifyCensus } from './census-verify.mjs';
import { CBRP_N, TOO_SPARSE, VIABLE, INCONCLUSIVE } from './statistics.mjs';

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  PASS ${name}`); passed++; }
  catch (e) { console.log(`  FAIL ${name}\n      ${e.stack}`); failed++; }
}
async function mustReject(fn, hint) {
  let thrown = null;
  try { await fn(); } catch (e) { thrown = e; }
  assert.ok(thrown, `expected a rejection (${hint}) but none happened`);
  return thrown;
}

const sha256 = (v) => createHash('sha256').update(v).digest('hex');
const SCRATCH = mkdtempSync(join(tmpdir(), 'cbrp-census-'));
let dirSeq = 0;
const freshDir = (name) => { const d = join(SCRATCH, `${name}-${dirSeq += 1}`); return d; };

/** TEST-ONLY fixtures. NOT CBRP CANDIDATES. Never promotable into the real pool. */
const STRATA = ['strategy', 'operations', 'brand', 'evidence', 'product', 'finance'];
const TEST_TASKS = Array.from({ length: CBRP_N }, (_, i) => {
  const text = `TEST-ONLY FIXTURE ${i + 1} — NOT A CBRP CANDIDATE. Placeholder decision text ${i + 1}.`;
  return { taskId: `T${String(i + 1).padStart(2, '0')}`, text, taskSha256: sha256(text), stratum: STRATA[i % 6] };
});
const TASK_MANIFEST_HASH = sha256(TEST_TASKS.map((t) => `${t.taskId}\n${t.taskSha256}`).join('\n'));

const WORKERS = [
  { id: 'alpha', provider: 'openai', model: 'stub-alpha', role: 'Alpha role', evidenceCapable: false },
  { id: 'beta', provider: 'claude', model: 'stub-beta', role: 'Beta role', evidenceCapable: false },
  { id: 'gamma', provider: 'gemini', model: 'stub-gamma', role: 'Gamma role', evidenceCapable: false },
];

const planJson = (complexity, ids) => JSON.stringify({
  complexity,
  requiredCapabilities: ['reasoning'],
  requiresRedTeam: false,
  reason: 'TEST-ONLY stub plan',
  assignments: ids.map((agentId) => ({ agentId, mission: `Mission for ${agentId}`, priority: 'high' })),
});

/** A dispatcher that answers each task according to `planFor`, with optional injected faults. */
function stubCall(planFor, { failOn = null, resolveAs = null } = {}) {
  let index = 0;
  const call = async (provider, prompt, options) => {
    const i = index; index += 1;
    if (failOn && failOn(i)) throw new Error(`stub provider failure at task ${i}`);
    const resolved = resolveAs ? resolveAs(i, provider, options.model) : { provider, model: options.model };
    return { provider: resolved.provider, model: resolved.model, text: planFor(i) };
  };
  return call;
}

const GOOD_BINDING = { match: true, executionHead: 'test-head', referenceDistDigest: 'a'.repeat(64), executionDistDigest: 'a'.repeat(64) };
const goodDeps = await censusDependencyProvenance();

const baseArgs = (overrides = {}) => ({
  tasks: TEST_TASKS,
  taskManifestHash: TASK_MANIFEST_HASH,
  runPlanningStage,
  workers: WORKERS,
  expectedPin: EXPECTED_PLANNING_PIN,
  executionHead: 'test-head',
  buildBinding: GOOD_BINDING,
  dependencyProvenance: goodDeps,
  runtimeFingerprintStart: 'fp-start',
  runtimeFingerprintEnd: 'fp-start',
  orderRule: { rule: 'test-only-manifest-order', seed: null },
  now: () => new Date('2026-09-07T00:00:00.000Z'),
  ...overrides,
});

/** k joint events among 60: the first `k` tasks are deep with two specialists. */
const planWithKEvents = (k) => (i) =>
  (i < k ? planJson('deep', ['alpha', 'beta']) : planJson('normal', ['alpha']));

console.log('\nStub rehearsal — sixty successful planning outcomes');

for (const [k, expectedZone] of [[0, TOO_SPARSE], [6, INCONCLUSIVE], [7, VIABLE]]) {
  await check(`a complete session with k = ${k} yields ${expectedZone}`, async () => {
    const outDir = freshDir(`k${k}`);
    const { session } = await runCensusSession(baseArgs({ outDir, call: stubCall(planWithKEvents(k)) }));
    assert.equal(session.studyVersion, STUDY_VERSION);
    assert.equal(session.sessionStatus, SESSION_COMPLETE);
    assert.equal(session.stopReason, null);
    assert.equal(session.attemptCount, CBRP_N);
    assert.equal(session.logicalCallCount, CBRP_N, 'exactly one planning call per task');
    assert.equal(session.k, k);
    assert.equal(session.statistics.zone, expectedZone);
    const verified = verifyCensus({ outDir, tasks: TEST_TASKS, expectedPin: EXPECTED_PLANNING_PIN });
    assert.deepEqual(verified.failures.map((f) => f.id), [], 'verifier must pass a legal session');
  });
}

await check('the recorder spends exactly one call per task and never a worker call', async () => {
  const outDir = freshDir('calls');
  const { session } = await runCensusSession(baseArgs({ outDir, call: stubCall(planWithKEvents(3)) }));
  assert.equal(session.calls.length, 60);
  assert.deepEqual([...new Set(session.calls.map((c) => c.stage))], ['planning']);
  for (const task of TEST_TASKS) {
    assert.equal(session.calls.filter((c) => c.taskId === task.taskId).length, 1, task.taskId);
  }
  assert.ok(session.calls.every((c) => c.transportMaxRetriesRequested === 0));
});

await check('events derive from the enforced plan, and a capped plan is counted as enforced', async () => {
  // The raw response asks for four specialists in a `simple` plan; production caps it at
  // one, so the event is false even though the raw count is >= 2.
  const outDir = freshDir('enforced');
  const raw = () => planJson('simple', ['alpha', 'beta', 'gamma']);
  const { session } = await runCensusSession(baseArgs({ outDir, call: stubCall(raw) }));
  assert.equal(session.sessionStatus, SESSION_COMPLETE);
  assert.equal(session.k, 0, 'raw asked for three, enforced kept one');
  assert.ok(session.results.every((r) => r.plan.assignments.length === 1));
  assert.ok(session.results.every((r) => r.eventAssignedGte2 === false));
});

console.log('\nFailure paths — none of these becomes Y = 0');

await check('a provider failure stops the session with no verdict', async () => {
  const outDir = freshDir('provider-fail');
  const { session } = await runCensusSession(baseArgs({
    outDir, call: stubCall(planWithKEvents(60), { failOn: (i) => i === 5 }),
  }));
  assert.equal(session.sessionStatus, SESSION_INCOMPLETE);
  assert.equal(session.stopReason, 'PROVIDER_FAILURE');
  assert.equal(session.k, null, 'no k from an incomplete session');
  assert.equal(session.statistics.verdict, NO_STATISTICAL_VERDICT);
  assert.equal(session.attemptCount, 6, 'the failed task consumed its attempt');
  const failedResult = session.results.at(-1);
  assert.equal(failedResult.failureCategory, 'PROVIDER_FAILURE');
  assert.equal(failedResult.eventJoint, null, 'a failure is not a non-event');
});

await check('a parse failure stops the session and is categorised, not scored', async () => {
  const outDir = freshDir('parse-fail');
  const { session } = await runCensusSession(baseArgs({
    outDir, call: stubCall((i) => (i === 2 ? 'I would rather answer in prose.' : planWithKEvents(60)(i))),
  }));
  assert.equal(session.sessionStatus, SESSION_INCOMPLETE);
  assert.equal(session.stopReason, 'PARSE_FAILURE');
  assert.equal(session.results.at(-1).eventJoint, null);
  assert.equal(session.k, null);
});

await check('a schema failure stops the session', async () => {
  const outDir = freshDir('schema-fail');
  const { session } = await runCensusSession(baseArgs({
    outDir, call: stubCall((i) => (i === 1 ? JSON.stringify({ complexity: 'catastrophic', assignments: [] }) : planWithKEvents(60)(i))),
  }));
  assert.equal(session.sessionStatus, SESSION_INCOMPLETE);
  assert.equal(session.stopReason, 'SCHEMA_FAILURE');
});

await check('a plan with no usable assignments stops the session', async () => {
  const outDir = freshDir('constraint-fail');
  const { session } = await runCensusSession(baseArgs({
    outDir, call: stubCall((i) => (i === 0 ? planJson('deep', ['nobody']) : planWithKEvents(60)(i))),
  }));
  assert.equal(session.sessionStatus, SESSION_INCOMPLETE);
  assert.equal(session.stopReason, 'CONSTRAINT_FAILURE');
  assert.equal(session.k, null);
});

await check('a resolved pin mismatch preserves the response and stops the session', async () => {
  const outDir = freshDir('resolved-pin');
  const { session } = await runCensusSession(baseArgs({
    outDir,
    call: stubCall(planWithKEvents(60), { resolveAs: (i, provider, model) => (i === 3 ? { provider: 'claude', model } : { provider, model }) }),
  }));
  assert.equal(session.sessionStatus, SESSION_INCOMPLETE);
  assert.equal(session.stopReason, 'RESOLVED_PIN_MISMATCH');
  const bad = session.calls.at(-1);
  assert.equal(bad.pinMismatch, true);
  assert.equal(bad.success, false);
  assert.ok(bad.rawResponseSha256, 'the raw response is preserved');
});

await check('a request pin mismatch is refused before the provider is reached', async () => {
  let reached = 0;
  const recorder = createPlanningRecorder({
    call: async (provider, prompt, options) => { reached += 1; return { provider, model: options.model, text: '{}' }; },
    expectedPin: EXPECTED_PLANNING_PIN,
  });
  const dispatch = recorder.dispatcherFor('T01');
  const err = await mustReject(() => dispatch('claude', 'p', { stage: 'planning', model: 'gpt-5' }), 'request pin');
  assert.match(String(err), /CENSUS_REQUEST_PIN_MISMATCH/);
  assert.match(String(err), /Provider NOT called/);
  assert.equal(reached, 0);
  assert.equal(recorder.reservedCallCount, 0, 'a refused request claims no budget');
  assert.equal(recorder.violation.code, 'CENSUS_REQUEST_PIN_MISMATCH');
});

console.log('\nScope, budget and duplicate dispatch');

await check('a worker-stage call is refused as out of scope, not merely budgeted', async () => {
  let reached = 0;
  const recorder = createPlanningRecorder({
    call: async () => { reached += 1; return { provider: 'openai', model: 'gpt-5', text: '{}' }; },
    expectedPin: EXPECTED_PLANNING_PIN,
  });
  const dispatch = recorder.dispatcherFor('T01');
  for (const stage of ['round1_worker', 'synthesis', 'synthesis_gate', 'round2_worker', 'decision_synthesis']) {
    const err = await mustReject(() => dispatch('openai', 'p', { stage, model: 'gpt-5' }), stage);
    assert.match(String(err), /CENSUS_SCOPE_VIOLATION/, stage);
  }
  assert.equal(reached, 0);
  assert.deepEqual([...CENSUS_ALLOWED_STAGES], ['planning']);
});

await check('the 61st logical call is refused', async () => {
  const recorder = createPlanningRecorder({
    call: async (provider, prompt, options) => ({ provider, model: options.model, text: '{}' }),
    expectedPin: EXPECTED_PLANNING_PIN,
  });
  for (let i = 0; i < GLOBAL_LOGICAL_CALL_BUDGET; i += 1) {
    await recorder.dispatcherFor(`T${i}`)('openai', 'p', { stage: 'planning', model: 'gpt-5' });
  }
  assert.equal(recorder.logicalCallCount, 60);
  const err = await mustReject(
    () => recorder.dispatcherFor('T-extra')('openai', 'p', { stage: 'planning', model: 'gpt-5' }), '61st');
  assert.match(String(err), /CENSUS_BUDGET_EXCEEDED/);
  assert.equal(recorder.logicalCallCount, 60, 'still sixty');
});

await check('a second call for the same task is refused by the per-task budget', async () => {
  const recorder = createPlanningRecorder({
    call: async (provider, prompt, options) => ({ provider, model: options.model, text: '{}' }),
    expectedPin: EXPECTED_PLANNING_PIN,
  });
  const dispatch = recorder.dispatcherFor('T01');
  await dispatch('openai', 'p', { stage: 'planning', model: 'gpt-5' });
  const err = await mustReject(() => dispatch('openai', 'p', { stage: 'planning', model: 'gpt-5' }), 'second call');
  assert.match(String(err), /CENSUS_BUDGET_EXCEEDED/);
  assert.equal(PER_TASK_LOGICAL_CALL_BUDGET, 1);
});

await check('a second dispatcher for the same task is refused', () => {
  const recorder = createPlanningRecorder({ call: async () => ({}), expectedPin: EXPECTED_PLANNING_PIN });
  recorder.dispatcherFor('T01');
  assert.throws(() => recorder.dispatcherFor('T01'), /CENSUS_DUPLICATE_DISPATCH|already dispatched/);
});

console.log('\nDurable attempt registry');

await check('the three recovery states are distinguishable from disk alone', () => {
  const path = join(freshDir('registry'), 'attempt-registry.ndjson');
  const registry = openAttemptRegistry(path);
  assert.equal(registry.stateOf('T01', TEST_TASKS[0].taskSha256), NEVER_ATTEMPTED);
  registry.reserve('T01', TEST_TASKS[0].taskSha256);
  assert.equal(registry.stateOf('T01', TEST_TASKS[0].taskSha256), RESERVED_UNSETTLED);
  registry.settle('T01', TEST_TASKS[0].taskSha256, { outcome: 'SUCCEEDED' });
  assert.equal(registry.stateOf('T01', TEST_TASKS[0].taskSha256), SETTLED);
  registry.close();

  // Read back from a new handle: the states survive process death.
  const reopened = openAttemptRegistry(path);
  assert.equal(reopened.stateOf('T01', TEST_TASKS[0].taskSha256), SETTLED);
  assert.equal(reopened.stateOf('T02', TEST_TASKS[1].taskSha256), NEVER_ATTEMPTED);
  reopened.close();
});

await check('the reservation is durably written BEFORE the call, so a crash is visible', async () => {
  const outDir = freshDir('crash');
  // The dispatcher throws a non-recoverable error to simulate the process dying mid-call;
  // the registry must already show the reservation.
  await runCensusSession(baseArgs({
    outDir, call: async () => { throw new Error('simulated crash during dispatch'); },
  }));
  const records = readRecords(join(outDir, 'attempt-registry.ndjson'));
  assert.ok(records.some((r) => r.state === ATTEMPT_RESERVED && r.taskId === 'T01'), 'reservation is on disk');
  const reservedRecord = records.find((r) => r.state === ATTEMPT_RESERVED);
  const settledRecord = records.find((r) => r.state === ATTEMPT_SETTLED);
  assert.ok(reservedRecord.seq < settledRecord.seq, 'reserved precedes settled in the journal');
});

await check('a reserved-but-unsettled attempt stops any resumption', async () => {
  const outDir = freshDir('unsettled');
  const path = join(outDir, 'attempt-registry.ndjson');
  const registry = openAttemptRegistry(path);
  registry.reserve('T01', TEST_TASKS[0].taskSha256);
  registry.close();

  const recovery = recoverSession(path);
  assert.equal(recovery.resumable, false);
  assert.equal(recovery.sessionStatus, SESSION_INCOMPLETE);
  assert.equal(recovery.reason, AMBIGUOUS_ATTEMPT_CONSUMED);
  assert.match(recovery.detail, /may not be retried, replaced, or skipped/);

  // And the session driver refuses to run at all.
  const { session } = await runCensusSession(baseArgs({ outDir, call: stubCall(planWithKEvents(0)) }));
  assert.equal(session.sessionStatus, SESSION_INCOMPLETE);
  assert.equal(session.stopReason, AMBIGUOUS_ATTEMPT_CONSUMED);
  assert.equal(session.attemptCount, 0, 'no new attempt was made');
  assert.equal(session.logicalCallCount, 0, 'no provider call was made');
  assert.equal(session.k, null);
});

await check('a duplicate reservation is refused', () => {
  const path = join(freshDir('dupe'), 'attempt-registry.ndjson');
  const registry = openAttemptRegistry(path);
  registry.reserve('T01', TEST_TASKS[0].taskSha256);
  registry.settle('T01', TEST_TASKS[0].taskSha256, { outcome: 'SUCCEEDED' });
  assert.throws(() => registry.reserve('T01', TEST_TASKS[0].taskSha256), AttemptRegistryError);
  assert.throws(() => registry.settle('T01', TEST_TASKS[0].taskSha256, {}), AttemptRegistryError);
  assert.throws(() => registry.settle('T99', 'deadbeef', {}), /settled without a reservation/);
  registry.close();
});

console.log('\nPre-dispatch structural refusals cost no attempt');

for (const [label, overrides, expectedReason] of [
  ['a dependency mismatch', { dependencyProvenance: { problems: ['zod digest drift'] } }, 'DEPENDENCY_MISMATCH'],
  ['a source/dist mismatch', { buildBinding: { ...GOOD_BINDING, match: false } }, 'BUILD_BINDING_MISMATCH'],
  ['a missing execution head', { executionHead: null }, 'EXECUTION_HEAD_MISSING'],
]) {
  await check(`${label} stops before any attempt is reserved`, async () => {
    const outDir = freshDir(label.replace(/\W+/g, '-'));
    const { session } = await runCensusSession(baseArgs({ outDir, call: stubCall(planWithKEvents(0)), ...overrides }));
    assert.equal(session.sessionStatus, SESSION_INCOMPLETE);
    assert.equal(session.stopReason, expectedReason);
    assert.equal(session.attemptCount, 0, 'no attempt claimed');
    assert.equal(session.logicalCallCount, 0, 'no provider call');
    assert.equal(readRecords(join(outDir, 'attempt-registry.ndjson')).length, 0, 'registry is empty');
  });
}

await check('a task whose text no longer hashes to its frozen value stops before dispatch', async () => {
  const outDir = freshDir('task-hash');
  const tampered = TEST_TASKS.map((t, i) => (i === 0 ? { ...t, text: `${t.text} edited` } : t));
  const { session } = await runCensusSession(baseArgs({ outDir, tasks: tampered, call: stubCall(planWithKEvents(0)) }));
  assert.equal(session.stopReason, 'TASK_HASH_MISMATCH');
  assert.equal(session.attemptCount, 0);
  assert.equal(session.logicalCallCount, 0);
});

console.log('\nProvenance guards');

await check('the real installed tree matches the census baseline, Zod included', async () => {
  const record = await assertCensusDependencies();
  assert.deepEqual(matchesCensusBaseline(record), []);
  const zod = record.packages.find((p) => p.name === 'zod');
  assert.equal(zod.installedVersion, CENSUS_DEPENDENCY_BASELINE.packages.zod.lockedVersion);
  assert.equal(zod.runtimePackageDigest, CENSUS_DEPENDENCY_BASELINE.packages.zod.runtimePackageDigest);
  assert.equal(zod.runtimePackageFileCount, CENSUS_DEPENDENCY_BASELINE.packages.zod.runtimePackageFileCount);
});

await check('NEGATIVE: a Zod byte drift at the same version is refused', async () => {
  const record = await censusDependencyProvenance();
  const drifted = { ...record, packages: record.packages.map((p) => (p.name === 'zod' ? { ...p, runtimePackageDigest: 'f'.repeat(64) } : p)) };
  const err = await mustReject(() => assertCensusDependencies(drifted), 'zod drift');
  assert.ok(err instanceof CensusProvenanceError);
  assert.match(String(err), /zod\.runtimePackageDigest/);
  assert.match(String(err), /may never be regenerated during a session/);
});

await check('the census baseline is its own object, not the capture one', async () => {
  const capture = await import('../capture/dependency-provenance.mjs');
  assert.notEqual(CENSUS_DEPENDENCY_BASELINE, capture.APPROVED_DEPENDENCY_BASELINE);
  assert.ok('zod' in CENSUS_DEPENDENCY_BASELINE.packages, 'census attests Zod');
  assert.ok(!('zod' in capture.APPROVED_DEPENDENCY_BASELINE.packages), 'capture does not, and is unchanged');
});

await check('the executable dist really was built from the authorized source', () => {
  const record = assertBuildBinding();
  assert.equal(record.match, true);
  assert.equal(record.referenceDistDigest, record.executionDistDigest);
  assert.ok(record.referenceDistFileCount > 0);
  assert.deepEqual(record.buildCommand, ['node_modules/.bin/tsc', '--project', 'tsconfig.json']);
});

await check('NEGATIVE: a dist digest that disagrees with the reference build is refused', () => {
  const record = buildBinding();
  const err = (() => { try { assertBuildBinding({ ...record, match: false }); } catch (e) { return e; } })();
  assert.ok(err instanceof BuildBindingError);
  assert.match(String(err), /was not built from the authorized source/);
  assert.match(String(err), /do not adjust the expectation/);
});

console.log('\nVerifier tamper tests');

const legalDir = freshDir('legal');
await runCensusSession(baseArgs({ outDir: legalDir, call: stubCall(planWithKEvents(7)) }));

const tamperVerify = (name, mutate) => {
  const dir = join(SCRATCH, `tampered-${name}`);
  const path = join(legalDir, 'census-session.json');
  const session = JSON.parse(readFileSync(path, 'utf8'));
  mutate(session);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'census-session.json'), JSON.stringify(session, null, 2));
  const registrySrc = join(legalDir, 'attempt-registry.ndjson');
  if (existsSync(registrySrc)) writeFileSync(join(dir, 'attempt-registry.ndjson'), readFileSync(registrySrc));
  const journalSrc = join(legalDir, 'planning-journal.ndjson');
  if (existsSync(journalSrc)) writeFileSync(join(dir, 'planning-journal.ndjson'), readFileSync(journalSrc));
  return verifyCensus({ outDir: dir, tasks: TEST_TASKS, expectedPin: EXPECTED_PLANNING_PIN });
};

await check('the legal session verifies clean', () => {
  const result = verifyCensus({ outDir: legalDir, tasks: TEST_TASKS, expectedPin: EXPECTED_PLANNING_PIN });
  assert.deepEqual(result.failures.map((f) => f.id), []);
  assert.ok(result.checks.length >= 20);
});

for (const [label, mutate, expectedId] of [
  ['an edited k', (s) => { s.k = 40; }, 14],
  ['an edited decision zone', (s) => { s.statistics.zone = TOO_SPARSE; }, '14c'],
  ['an edited event flag', (s) => { s.results[0].eventJoint = false; }, 13],
  ['an edited bound', (s) => { s.statistics.lower = 0.99; }, '14b'],
  ['a broken build binding', (s) => { s.buildBinding.match = false; }, 11],
  ['a dependency drift', (s) => { s.dependencyProvenance.packages = s.dependencyProvenance.packages.map((p) => (p.name === 'zod' ? { ...p, runtimePackageDigest: 'e'.repeat(64) } : p)); }, 12],
  ['an unexpected resolved pin', (s) => { s.calls[0].providerResolved = 'claude'; }, '9b'],
  ['a dropped transport policy', (s) => { delete s.calls[0].transportRetryPolicy; }, 10],
  ['a smuggled worker call', (s) => { s.calls.push({ ...s.calls[0], seq: s.calls.length + 1, stage: 'round1_worker' }); }, '7b'],
  ['a duplicated task result', (s) => { s.results.push({ ...s.results[0] }); }, '4b'],
]) {
  await check(`NEGATIVE: the verifier catches ${label}`, () => {
    const result = tamperVerify(label.replace(/\W+/g, '-'), mutate);
    assert.ok(result.failures.some((f) => String(f.id) === String(expectedId)),
      `expected ${expectedId}, got ${result.failures.map((f) => f.id).join(', ')}`);
  });
}

await check('NEGATIVE: any tamper breaks the session seal', () => {
  const result = tamperVerify('seal', (s) => { s.executionHead = 'a-different-head'; });
  assert.ok(result.failures.some((f) => f.id === 2), result.failures.map((f) => f.id).join(', '));
});

await check('an incomplete session is verified as producing no verdict', async () => {
  const outDir = freshDir('incomplete-verify');
  await runCensusSession(baseArgs({ outDir, call: stubCall(planWithKEvents(60), { failOn: (i) => i === 4 }) }));
  const result = verifyCensus({ outDir, tasks: TEST_TASKS, expectedPin: EXPECTED_PLANNING_PIN });
  assert.ok(result.checks.some((c) => c.id === 14 && c.ok), 'the no-verdict check must pass');
});

console.log('\nNo live execution');

await check('the rehearsal made zero provider calls and authored zero CBRP tasks', () => {
  for (const task of TEST_TASKS) {
    assert.match(task.text, /TEST-ONLY FIXTURE/, 'every fixture is marked TEST-ONLY');
    assert.match(task.text, /NOT A CBRP CANDIDATE/);
  }
  // Asserted on imports rather than mentions, so the check is not its own counter-example.
  const source = readFileSync(new URL(import.meta.url), 'utf8');
  const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  for (const forbidden of ['run-live', 'providers/index', 'dotenv', 'capture/session']) {
    assert.ok(!imports.some((i) => i.includes(forbidden)), `the rehearsal must not import ${forbidden}`);
  }
  assert.ok(imports.includes('../../../dist/modes/orchestrator.js'), 'production planning is the real one');
});

rmSync(SCRATCH, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
