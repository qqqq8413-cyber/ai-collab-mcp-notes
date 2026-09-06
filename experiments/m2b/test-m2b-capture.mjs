/**
 * Offline acceptance tests for the M2-B Real Round 1 capture harness.
 *
 * Deterministic and provider-free: every dispatcher below is a stub, and the whole point
 * is that this suite runs to completion before a single live call is paid for.
 *
 * Two halves, testing two different kinds of guard:
 *
 *  - Recorder tests assert that a forbidden call is refused *before* the provider is
 *    reached. The assertion is always "and the provider was not called" — a guard that
 *    notices a violation after spending the money is not a guard.
 *  - Verifier tests assert that a specific tampering is caught by a specific check. A
 *    verifier is only worth its output if it fails when it should, so each one is proven
 *    by corrupting a legal capture and watching the named check go red.
 */
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createRecorder, ScopeViolation, RetrievalPolicyViolation, TemperaturePolicyViolation,
  CallBudgetExceeded, WorkerBindingError, ModelPinMismatch, DuplicateAttempt,
  ALLOWED_STAGES, GLOBAL_CALL_BUDGET,
} from './capture/recorder.mjs';
import { runCaptureSession } from './capture/session.mjs';
import { verifyCapture, verifySyntheticUnchanged } from './capture/capture-verify.mjs';
import {
  REAL_FIXTURE_IDS, PROVIDER_ALLOCATION, CHIEF_PIN, SOURCE_CANDIDATE,
  SYNTHETIC_ROOT, CANDIDATES_R2_ROOT, CANDIDATES_R3_ROOT, CANDIDATE_SETS, candidateSetFor, sourceTaskPath,
  REGISTERED_SPECIALISTS, buildWorkerRefs, canonical, sha256,
} from './capture/runner.mjs';

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

const SCRATCH = mkdtempSync(join(tmpdir(), 'm2b-capture-'));
const M2B = fileURLToPath(new URL('./', import.meta.url));
const FREEZE_MANIFEST = join(M2B, 'manifests', 'fixture-freeze-manifest.json');
const EVALUATION_ROOT = join(M2B, 'evaluation');

const META = {
  executionHead: 'stub-head',
  productionBoundaryCommit: 'd01043b6c520c29473e3960c60bad28aec9719ed',
  promptSourceCommit: { 'src/agents/chief.ts': 'stub', 'src/modes/orchestrator.ts': 'stub' },
  captureHarnessCommit: 'stub-harness',
  nodeVersion: 'stub-node',
};

const PARAGRAPHS = (agentId, n) =>
  Array.from({ length: n }, (_, i) => `${agentId} paragraph ${i + 1}: an offline stub answer with enough text to segment.`).join('\n\n');

/**
 * A stub provider that produces a capture which is legal by construction, with named
 * knobs for each way a capture can go wrong. Defaults are always the legal case.
 */
function stubCall(options = {}) {
  const {
    complexity = 'deep',
    assignIds = REGISTERED_SPECIALISTS,
    failFor = [],
    modelFor = null,
    providerFor = null,
    onCall = null,
  } = options;
  const seen = [];
  const call = async (provider, prompt, callOptions) => {
    seen.push({ provider, stage: callOptions.stage, model: callOptions.model, system: callOptions.system });
    if (onCall) onCall(provider, prompt, callOptions);
    const model = modelFor ? modelFor(callOptions) : callOptions.model;
    const resolvedProvider = providerFor ? providerFor(provider, callOptions) : provider;
    if (callOptions.stage === 'planning') {
      return {
        provider: resolvedProvider,
        model,
        text: JSON.stringify({
          complexity,
          requiredCapabilities: ['reasoning'],
          requiresRedTeam: false,
          reason: 'Offline stub plan',
          assignments: assignIds.map((agentId) => ({ agentId, mission: `Stub mission for ${agentId}`, priority: 'high' })),
        }),
      };
    }
    const agent = REGISTERED_SPECIALISTS.find((id) => callOptions.system?.includes(id.split('_')[0])) ?? 'unknown';
    const who = assignIds.find((id) => prompt.includes(`Stub mission for ${id}`)) ?? agent;
    if (failFor.includes(who)) throw new Error(`stub provider failure for ${who}`);
    return { provider: resolvedProvider, model, text: PARAGRAPHS(who, 4) };
  };
  call.seen = seen;
  return call;
}

/** Runs a complete four-candidate stub session into a fresh directory. */
async function stubSession(name, callOptions = {}, sessionOptions = {}) {
  const realRoot = join(SCRATCH, name);
  const call = stubCall(callOptions);
  const out = await runCaptureSession({
    call,
    realRoot,
    meta: META,
    now: () => new Date('2026-09-06T00:00:00.000Z'),
    ...sessionOptions,
  });
  return { ...out, realRoot, call };
}

const verifyAt = (realRoot, globalCallBudget = GLOBAL_CALL_BUDGET) => verifyCapture({
  realRoot,
  chiefPin: CHIEF_PIN,
  providerAllocation: PROVIDER_ALLOCATION,
  sourceCandidate: SOURCE_CANDIDATE,
  sourceTaskPathFor: sourceTaskPath,
  globalCallBudget,
});

/** Copies a legal capture, applies one tampering, and returns the verifier result. */
function tamper(sourceRoot, name, mutate) {
  const dest = join(SCRATCH, `tampered-${name}`);
  rmSync(dest, { recursive: true, force: true });
  cpSync(sourceRoot, dest, { recursive: true });
  mutate(dest);
  return verifyAt(dest);
}
const failedIds = (result) => result.failures.map((f) => f.id);
const someFailureMatches = (result, pattern) => result.failures.some((f) => String(f.id).includes(pattern));

const editJson = (path, mutate) => {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  mutate(value);
  writeFileSync(path, canonical(value), 'utf8');
};

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nRecording dispatcher — pre-call guards');

const RECORDER_WORKERS = REGISTERED_SPECIALISTS.map((id, i) => ({ id, role: `Role ${i} for ${id}`, provider: 'openai', model: 'gpt-5' }));
const PINS = { planning: CHIEF_PIN, round1_worker: { provider: 'openai', model: 'gpt-5' } };

function recorderFixture({ call, fixtureId = 'fxr-01', workers = RECORDER_WORKERS } = {}) {
  let calledProvider = 0;
  const underlying = call ?? (async (provider, prompt, options) => {
    calledProvider += 1;
    return { provider, model: options.model, text: 'stub' };
  });
  const recorder = createRecorder({ call: underlying, now: () => new Date('2026-09-06T00:00:00.000Z') });
  const dispatch = recorder.dispatcherFor(fixtureId, { pins: PINS, workers });
  return { recorder, dispatch, get providerCalls() { return calledProvider; } };
}

for (const stage of ['synthesis', 'synthesis_gate', 'round2_worker', 'decision_synthesis', 'self_review']) {
  await check(`a ${stage} call is refused before the provider is reached`, async () => {
    const f = recorderFixture();
    const err = await mustReject(() => f.dispatch('openai', 'p', { stage, model: 'gpt-5' }), stage);
    assert.ok(err instanceof ScopeViolation);
    assert.equal(err.code, 'SCOPE_VIOLATION_POST_ROUND1_CALL');
    assert.equal(f.providerCalls, 0, 'the provider must not have been called');
    assert.equal(f.recorder.liveCallCount, 0, 'a refused call is not a live call');
  });
}

await check('a call with no stage is refused', async () => {
  const f = recorderFixture();
  const err = await mustReject(() => f.dispatch('openai', 'p', { model: 'gpt-5' }), 'no stage');
  assert.ok(err instanceof ScopeViolation);
  assert.equal(f.providerCalls, 0);
});

await check('only planning and round1_worker are allowed stages', () => {
  assert.deepEqual([...ALLOWED_STAGES], ['planning', 'round1_worker']);
});

await check('a retrieval request aborts before the provider is reached', async () => {
  const f = recorderFixture();
  const err = await mustReject(
    () => f.dispatch('openai', 'p', { stage: 'round1_worker', model: 'gpt-5', system: RECORDER_WORKERS[0].role, retrieval: { enabled: true } }),
    'retrieval'
  );
  assert.ok(err instanceof RetrievalPolicyViolation);
  assert.equal(err.code, 'RETRIEVAL_POLICY_VIOLATION');
  assert.equal(f.providerCalls, 0);
});

await check('even a disabled retrieval object aborts, because all-off means absent', async () => {
  const f = recorderFixture();
  const err = await mustReject(
    () => f.dispatch('openai', 'p', { stage: 'round1_worker', model: 'gpt-5', system: RECORDER_WORKERS[0].role, retrieval: { enabled: false } }),
    'retrieval present'
  );
  assert.ok(err instanceof RetrievalPolicyViolation);
  assert.equal(f.providerCalls, 0);
});

await check('a temperature request aborts before the provider is reached', async () => {
  const f = recorderFixture();
  const err = await mustReject(
    () => f.dispatch('openai', 'p', { stage: 'planning', model: 'gpt-5', temperature: 0 }),
    'temperature'
  );
  assert.ok(err instanceof TemperaturePolicyViolation);
  assert.equal(f.providerCalls, 0);
});

await check('the global budget stops the seventeenth call before it is issued', async () => {
  let providerCalls = 0;
  const recorder = createRecorder({
    call: async (provider, prompt, options) => { providerCalls += 1; return { provider, model: options.model, text: 'stub' }; },
    now: () => new Date('2026-09-06T00:00:00.000Z'),
  });
  // Four candidates, four calls each, is exactly the budget.
  for (const fixtureId of REAL_FIXTURE_IDS) {
    const dispatch = recorder.dispatcherFor(fixtureId, { pins: PINS, workers: RECORDER_WORKERS });
    await dispatch('openai', 'p', { stage: 'planning', model: 'gpt-5' });
    for (const w of RECORDER_WORKERS) await dispatch('openai', 'p', { stage: 'round1_worker', model: 'gpt-5', system: w.role });
  }
  assert.equal(recorder.liveCallCount, GLOBAL_CALL_BUDGET);
  assert.equal(providerCalls, GLOBAL_CALL_BUDGET);
  const dispatch = recorder.dispatcherFor('fxr-05', { pins: PINS, workers: RECORDER_WORKERS });
  const err = await mustReject(() => dispatch('openai', 'p', { stage: 'planning', model: 'gpt-5' }), 'budget');
  assert.ok(err instanceof CallBudgetExceeded);
  assert.equal(err.code, 'CALL_BUDGET_EXCEEDED');
  assert.equal(providerCalls, GLOBAL_CALL_BUDGET, 'the seventeenth call must never reach a provider');
});

await check('the R3 budget stops a thirteenth call before it is issued', async () => {
  let providerCalls = 0;
  const recorder = createRecorder({
    call: async (provider, prompt, options) => { providerCalls += 1; return { provider, model: options.model, text: 'stub' }; },
    now: () => new Date('2026-09-06T00:00:00.000Z'),
    globalBudget: 12,
  });
  for (const fixtureId of CANDIDATE_SETS.R3.fixtureIds) {
    const dispatch = recorder.dispatcherFor(fixtureId, { pins: PINS, workers: RECORDER_WORKERS });
    await dispatch('openai', 'p', { stage: 'planning', model: 'gpt-5' });
    for (const w of RECORDER_WORKERS) await dispatch('openai', 'p', { stage: 'round1_worker', model: 'gpt-5', system: w.role });
  }
  const dispatch = recorder.dispatcherFor('fxr-r3-overflow', { pins: PINS, workers: RECORDER_WORKERS });
  const err = await mustReject(() => dispatch('openai', 'p', { stage: 'planning', model: 'gpt-5' }), 'R3 budget');
  assert.ok(err instanceof CallBudgetExceeded);
  assert.equal(providerCalls, 12, 'the thirteenth call must never reach a provider');
});

await check('concurrent worker dispatches cannot overshoot the global budget', async () => {
  // Production runs Round 1 workers through Promise.all, so every guard executes before
  // any response arrives. A budget counted from settled calls would see the same stale
  // count in all of them and let the whole batch through.
  let providerCalls = 0;
  const recorder = createRecorder({
    globalBudget: 2,
    now: () => new Date('2026-09-06T00:00:00.000Z'),
    call: async (provider, prompt, options) => {
      providerCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { provider, model: options.model, text: 'stub' };
    },
  });
  const dispatch = recorder.dispatcherFor('fxr-01', { pins: PINS, workers: RECORDER_WORKERS });
  const settled = await Promise.allSettled(
    RECORDER_WORKERS.map((w) => dispatch('openai', 'p', { stage: 'round1_worker', model: 'gpt-5', system: w.role }))
  );
  assert.equal(providerCalls, 2, 'exactly the budget may reach a provider, however concurrent the batch');
  assert.equal(settled.filter((r) => r.status === 'rejected').length, 1);
  assert.ok(settled.find((r) => r.status === 'rejected').reason instanceof CallBudgetExceeded);
  assert.equal(recorder.reservedCallCount, 2);
});

await check('the per-candidate budget stops a fifth call for one candidate', async () => {
  const f = recorderFixture();
  await f.dispatch('openai', 'p', { stage: 'planning', model: 'gpt-5' });
  for (const w of RECORDER_WORKERS) await f.dispatch('openai', 'p', { stage: 'round1_worker', model: 'gpt-5', system: w.role });
  const before = f.providerCalls;
  const err = await mustReject(() => f.dispatch('openai', 'p', { stage: 'planning', model: 'gpt-5' }), 'candidate budget');
  assert.ok(err instanceof CallBudgetExceeded);
  assert.equal(f.providerCalls, before);
});

await check('a second attempt at the same candidate is refused by protocol', async () => {
  const recorder = createRecorder({ call: async (p, _, o) => ({ provider: p, model: o.model, text: 'x' }) });
  recorder.dispatcherFor('fxr-01', { pins: PINS, workers: RECORDER_WORKERS });
  const err = await mustReject(async () => recorder.dispatcherFor('fxr-01', { pins: PINS, workers: RECORDER_WORKERS }), 'duplicate');
  assert.ok(err instanceof DuplicateAttempt);
  assert.equal(err.code, 'INVALID_BY_PROTOCOL');
});

await check('a worker call matching no specialist is refused, not guessed', async () => {
  const f = recorderFixture();
  const err = await mustReject(
    () => f.dispatch('openai', 'p', { stage: 'round1_worker', model: 'gpt-5', system: 'a role nobody has' }),
    'no match'
  );
  assert.ok(err instanceof WorkerBindingError);
  assert.equal(err.matches, 0);
  assert.equal(f.providerCalls, 0);
});

await check('a worker call matching two specialists is refused, not guessed', async () => {
  const ambiguous = [
    { id: 'a', role: 'Shared role', provider: 'openai', model: 'gpt-5' },
    { id: 'b', role: 'Shared role', provider: 'openai', model: 'gpt-5' },
  ];
  const f = recorderFixture({ workers: ambiguous });
  const err = await mustReject(
    () => f.dispatch('openai', 'p', { stage: 'round1_worker', model: 'gpt-5', system: 'Shared role' }),
    'ambiguous'
  );
  assert.ok(err instanceof WorkerBindingError);
  assert.equal(err.matches, 2);
  assert.equal(f.providerCalls, 0);
});

await check('a resolved model that differs from the pin preserves the raw response and invalidates the call', async () => {
  const recorder = createRecorder({
    call: async (provider, prompt, options) => ({ provider, model: 'some-other-model', text: 'text that must be preserved' }),
    now: () => new Date('2026-09-06T00:00:00.000Z'),
  });
  const dispatch = recorder.dispatcherFor('fxr-01', { pins: PINS, workers: RECORDER_WORKERS });
  const err = await mustReject(() => dispatch('openai', 'p', { stage: 'planning', model: 'gpt-5' }), 'model pin');
  assert.ok(err instanceof ModelPinMismatch);
  assert.equal(recorder.liveCallCount, 1, 'the call happened and must be recorded');
  const record = recorder.calls[0];
  assert.equal(record.responseText, 'text that must be preserved', 'raw text is evidence and must be kept');
  assert.equal(record.modelResolved, 'some-other-model');
  assert.equal(record.modelRequested, 'gpt-5');
  assert.equal(record.success, false, 'a pin mismatch is not a success');
  assert.equal(record.pinMismatch, true);
});

await check('a resolved provider that differs from the pin invalidates the call', async () => {
  const recorder = createRecorder({ call: async (p, _, o) => ({ provider: 'gemini', model: o.model, text: 'x' }) });
  const dispatch = recorder.dispatcherFor('fxr-01', { pins: PINS, workers: RECORDER_WORKERS });
  const err = await mustReject(() => dispatch('openai', 'p', { stage: 'planning', model: 'gpt-5' }), 'provider pin');
  assert.ok(err instanceof ModelPinMismatch);
  assert.equal(recorder.calls[0].providerResolved, 'gemini');
  assert.equal(recorder.calls[0].pinMismatch, true);
});

await check('startedAt is recorded before the call and is a UTC instant', async () => {
  let observedDuringCall = null;
  const recorder = createRecorder({
    call: async (p, _, o) => { observedDuringCall = recorder.calls.length; return { provider: p, model: o.model, text: 'x' }; },
    now: () => new Date('2026-09-06T12:34:56.000Z'),
  });
  const dispatch = recorder.dispatcherFor('fxr-01', { pins: PINS, workers: RECORDER_WORKERS });
  await dispatch('openai', 'p', { stage: 'planning', model: 'gpt-5' });
  assert.equal(observedDuringCall, 0, 'the record is journalled once the call settles, not before');
  assert.equal(recorder.calls[0].startedAt, '2026-09-06T12:34:56.000Z');
  assert.ok(recorder.calls[0].startedAt.endsWith('Z'), 'no local offsets');
});

await check('a provider failure is recorded rather than swallowed, and is not a success', async () => {
  const recorder = createRecorder({ call: async () => { throw new Error('network down'); } });
  const dispatch = recorder.dispatcherFor('fxr-01', { pins: PINS, workers: RECORDER_WORKERS });
  await mustReject(() => dispatch('openai', 'p', { stage: 'planning', model: 'gpt-5' }), 'network');
  assert.equal(recorder.liveCallCount, 1);
  assert.equal(recorder.calls[0].success, false);
  assert.match(recorder.calls[0].error, /network down/);
  assert.equal(recorder.calls[0].responseText, null);
});

await check('the write-ahead journal is appended after each call, not at the end', async () => {
  const dir = mkdtempSync(join(SCRATCH, 'journal-'));
  const journalPath = join(dir, 'journal.ndjson');
  writeFileSync(journalPath, '', 'utf8');
  const lengths = [];
  const recorder = createRecorder({
    journalPath,
    call: async (p, _, o) => {
      lengths.push(readFileSync(journalPath, 'utf8').split('\n').filter(Boolean).length);
      return { provider: p, model: o.model, text: 'x' };
    },
  });
  const dispatch = recorder.dispatcherFor('fxr-01', { pins: PINS, workers: RECORDER_WORKERS });
  await dispatch('openai', 'p', { stage: 'planning', model: 'gpt-5' });
  await dispatch('openai', 'p', { stage: 'round1_worker', model: 'gpt-5', system: RECORDER_WORKERS[0].role });
  assert.deepEqual(lengths, [0, 1], 'call N must already be on disk when call N+1 is issued');
  assert.equal(readFileSync(journalPath, 'utf8').split('\n').filter(Boolean).length, 2);
});

await check('no secret ever enters a call record', async () => {
  const recorder = createRecorder({ call: async (p, _, o) => ({ provider: p, model: o.model, text: 'x' }) });
  const dispatch = recorder.dispatcherFor('fxr-01', { pins: PINS, workers: RECORDER_WORKERS });
  await dispatch('openai', 'p', { stage: 'planning', model: 'gpt-5' });
  const keys = Object.keys(recorder.calls[0]);
  for (const forbidden of ['apiKey', 'authorization', 'headers', 'env', 'key', 'token']) {
    assert.ok(!keys.some((k) => k.toLowerCase().includes(forbidden)), `record must not carry ${forbidden}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nCapture runner — production binding');

await check('the runner pins every specialist of a candidate to one provider and model', () => {
  for (const fixtureId of REAL_FIXTURE_IDS) {
    const refs = buildWorkerRefs(fixtureId);
    assert.equal(refs.length, 3);
    assert.deepEqual(refs.map((r) => r.id), REGISTERED_SPECIALISTS);
    for (const ref of refs) {
      assert.equal(ref.provider, PROVIDER_ALLOCATION[fixtureId].provider);
      assert.equal(ref.model, PROVIDER_ALLOCATION[fixtureId].model);
      assert.equal(ref.providesEvidence, false, 'all-off retrieval is enforced structurally, not by prompt');
    }
  }
});

await check('the runner reads only task.txt from a source candidate', () => {
  // The R1 candidates' missions, Round 1 texts, roster and ground truth are archival. If
  // any of them reached the planner they could shape assignments or eligibility, which is
  // the contamination the whole re-capture exists to remove. Asserted structurally: one
  // resolver, one filename, and no other file read from a source directory.
  const source = readFileSync(join(M2B, 'capture', 'runner.mjs'), 'utf8');
  const resolver = source.split('export function sourceTaskPath')[1].split('\n}')[0];
  assert.ok(resolver.includes("'task.txt'"), 'the resolver names task.txt');
  for (const forbidden of ['roster.json', 'snapshot.json', 'conflict-labels', 'gold-issues', 'round1-', 'mission-', 'fixture-manifest']) {
    assert.ok(!resolver.includes(forbidden), `the resolver must not reach ${forbidden}`);
  }

  const body = source.split('export async function captureCandidate')[1];
  const reads = [...body.matchAll(/readFileSync\(([^,)]+)/g)].map((m) => m[1].trim());
  assert.deepEqual(reads, ['taskPath'], 'captureCandidate reads exactly one file, the task');
  assert.ok(/const taskPath = sourceTaskPath\(fixtureId\);/.test(body), 'and it gets that path from the resolver');

  // No source root may be dereferenced anywhere except inside the resolver.
  const outsideResolver = source.replace(resolver, '');
  for (const root of ['SYNTHETIC_ROOT', 'CANDIDATES_R2_ROOT']) {
    const uses = (outsideResolver.match(new RegExp(root, 'g')) ?? []).length;
    assert.equal(uses, 2, `${root} may only be declared and placed in a candidate set, not read directly`);
  }
});

await check('capture calls runRound1Stage and never runOrchestrator', () => {
  const source = readFileSync(join(M2B, 'capture', 'runner.mjs'), 'utf8');
  assert.ok(source.includes('runRound1Stage('), 'the capture must use the production Round 1 boundary');
  assert.ok(!/\brunOrchestrator\s*\(/.test(source), 'runOrchestrator would legitimately continue into synthesis');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nA legal stub capture verifies clean');

const legal = await stubSession('legal', {}, { fresh: true });

await check('a fully legal stub capture passes every check', () => {
  const result = verifyAt(legal.realRoot);
  assert.deepEqual(failedIds(result), [], 'a legal capture must have no failures');
  assert.ok(result.ok);
  assert.ok(result.checks.length >= 100, `expected a substantial check count, got ${result.checks.length}`);
});

await check('the legal stub capture spends exactly sixteen calls', () => {
  assert.equal(legal.session.globalLiveCallCount, 16);
  for (const attempt of legal.session.attempts) assert.equal(attempt.liveCallCount, 4);
});

await check('the legal stub capture records deep, SUCCESS and three specialists everywhere', () => {
  for (const attempt of legal.session.attempts) {
    assert.equal(attempt.complexity, 'deep');
    assert.equal(attempt.round1Status, 'SUCCESS');
    assert.equal(attempt.successfulWorkerCount, 3);
    assert.equal(attempt.captureStatus, 'CAPTURED');
  }
});

await check('no post-Round1 stage appears anywhere in the session journal', () => {
  const journal = readFileSync(join(legal.realRoot, 'journal.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(journal.length, 16);
  for (const record of journal) assert.ok(ALLOWED_STAGES.includes(record.stage), record.stage);
  for (const forbidden of ['synthesis', 'synthesis_gate', 'round2_worker', 'decision_synthesis', 'self_review']) {
    assert.equal(journal.filter((r) => r.stage === forbidden).length, 0);
  }
});

await check('a session refuses to run twice into the same directory', async () => {
  await mustReject(() => runCaptureSession({ call: stubCall(), realRoot: legal.realRoot, meta: META }), 'rerun');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nVerifier negative tests — each tampering is caught by its own check');

const NEGATIVES = [
  ['complexity-normal-but-manifest-says-deep', (dir) => {
    editJson(join(dir, 'fxr-01', 'planner-result.json'), (plan) => { plan.complexity = 'normal'; });
  }, '/10'],
  ['successful-workers-reduced-to-one', (dir) => {
    editJson(join(dir, 'fxr-01', 'snapshot.json'), (s) => {
      for (const r of s.workerResults.slice(1)) { delete r.output; r.error = 'stub failure'; }
    });
  }, '/12'],
  ['degraded-run-status', (dir) => {
    editJson(join(dir, 'fxr-01', 'snapshot.json'), (s) => { delete s.workerResults[2].output; s.workerResults[2].error = 'stub failure'; });
  }, '/13'],
  ['snapshot-provider-differs-from-raw', (dir) => {
    editJson(join(dir, 'fxr-01', 'available-roster.json'), (r) => { r.workers[0].provider = 'gemini'; });
  }, '/17'],
  ['requested-model-differs-from-resolved', (dir) => {
    editJson(join(dir, 'fxr-01', 'raw-calls.json'), (calls) => {
      for (const c of calls) if (c.stage === 'round1_worker') { c.modelResolved = 'gpt-4o'; break; }
    });
  }, '/18'],
  ['round1-output-altered-by-one-character', (dir) => {
    editJson(join(dir, 'fxr-01', 'snapshot.json'), (s) => { s.workerResults[0].output += '.'; });
  }, '/19'],
  ['mission-altered-by-one-character', (dir) => {
    editJson(join(dir, 'fxr-01', 'snapshot.json'), (s) => { s.workerResults[0].mission += '.'; });
  }, '/16'],
  ['agent-mapping-points-at-a-nonexistent-agent', (dir) => {
    editJson(join(dir, 'fxr-01', 'raw-calls.json'), (calls) => {
      for (const c of calls) if (c.stage === 'round1_worker') { c.systemPrompt = 'a role nobody has'; break; }
    });
  }, '/15'],
  ['role-mapping-is-ambiguous', (dir) => {
    editJson(join(dir, 'fxr-01', 'raw-calls.json'), (calls) => {
      const workers = calls.filter((c) => c.stage === 'round1_worker');
      workers[1].systemPrompt = workers[0].systemPrompt;
    });
  }, '/15'],
  ['retrieval-was-requested', (dir) => {
    editJson(join(dir, 'fxr-01', 'raw-calls.json'), (calls) => { calls[1].retrievalRequested = true; });
  }, '/20'],
  ['retrieval-result-is-not-null', (dir) => {
    editJson(join(dir, 'fxr-01', 'raw-calls.json'), (calls) => { calls[1].retrievalResult = { status: 'GROUNDED', sourcesFound: 3 }; });
  }, '/20b'],
  ['temperature-was-set', (dir) => {
    editJson(join(dir, 'fxr-01', 'raw-calls.json'), (calls) => { calls[0].temperatureRequested = 0; });
  }, '/21'],
  ['a-synthesis-call-appears', (dir) => {
    editJson(join(dir, 'fxr-01', 'raw-calls.json'), (calls) => { calls[1].stage = 'synthesis'; });
  }, '/26'],
  ['a-synthesis_gate-call-appears', (dir) => {
    editJson(join(dir, 'fxr-01', 'raw-calls.json'), (calls) => { calls[1].stage = 'synthesis_gate'; });
  }, '/27'],
  ['a-round2_worker-call-appears', (dir) => {
    editJson(join(dir, 'fxr-01', 'raw-calls.json'), (calls) => { calls[1].stage = 'round2_worker'; });
  }, '/28'],
  ['a-decision_synthesis-call-appears', (dir) => {
    editJson(join(dir, 'fxr-01', 'raw-calls.json'), (calls) => { calls[1].stage = 'decision_synthesis'; });
  }, '/29'],
  ['the-same-candidate-was-attempted-twice', (dir) => {
    editJson(join(dir, 'fxr-02', 'capture-manifest.json'), (m) => { m.sourceCandidateId = 'fx-01'; });
  }, '7'],
  ['more-than-sixteen-global-calls', (dir) => {
    editJson(join(dir, 'fxr-01', 'raw-calls.json'), (calls) => {
      calls.push({ ...calls[1], seq: 99 });
    });
  }, '/23'],
  ['snapshot-hash-mismatch', (dir) => {
    editJson(join(dir, 'fxr-01', 'capture-manifest.json'), (m) => { m.snapshotSha256 = 'deadbeef'; });
  }, '/3'],
  ['runtime-fingerprint-start-differs-from-end', (dir) => {
    editJson(join(dir, 'capture-session.json'), (s) => { s.runtimeFingerprintEndSha256 = 'deadbeef'; });
  }, '31'],
  ['an-evaluation-artifact-is-placed-in-the-runtime-fixture', (dir) => {
    writeFileSync(join(dir, 'fxr-01', 'gold-issues.json'), '[]', 'utf8');
  }, '/30'],
  ['the-planning-model-pin-was-not-honoured', (dir) => {
    editJson(join(dir, 'fxr-01', 'raw-calls.json'), (calls) => { calls[0].modelResolved = 'gpt-4o'; });
  }, '/9'],
  ['a-second-planning-call-appears', (dir) => {
    editJson(join(dir, 'fxr-01', 'raw-calls.json'), (calls) => { calls.push({ ...calls[0], seq: 98 }); });
  }, '/8'],
  ['the-task-text-was-changed', (dir) => {
    writeFileSync(join(dir, 'fxr-01', 'task.txt'), readFileSync(join(dir, 'fxr-01', 'task.txt'), 'utf8') + ' extra', 'utf8');
  }, '/1'],
  ['the-manifest-seal-was-broken', (dir) => {
    editJson(join(dir, 'fxr-01', 'capture-manifest.json'), (m) => { m.captureStatus = 'CAPTURED'; m.successfulWorkerCount = 99; });
  }, '/4'],
];

for (const [name, mutate, expectedCheck] of NEGATIVES) {
  await check(`verifier catches: ${name}`, () => {
    const result = tamper(legal.realRoot, name, mutate);
    assert.equal(result.ok, false, 'the verifier must reject this capture');
    assert.ok(someFailureMatches(result, expectedCheck),
      `expected check ${expectedCheck} to fail; failures were ${failedIds(result).join(', ')}`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nVerifier positive controls — a capture that legitimately fails F1/F2/F3');

await check('a normal-complexity capture fails F1 and is recorded as FAILED, not repaired', async () => {
  const run = await stubSession('normal-complexity', { complexity: 'normal' }, { fresh: true });
  const result = verifyAt(run.realRoot);
  assert.equal(result.ok, false);
  assert.ok(someFailureMatches(result, '/10b'), 'F1 must fail');
  for (const attempt of run.session.attempts) assert.equal(attempt.complexity, 'normal');
  // The manifest must follow the facts: eligibility bends to the result, never the reverse.
  for (const attempt of run.session.attempts) assert.equal(attempt.captureStatus, 'FAILED');
  const manifest = JSON.parse(readFileSync(join(run.realRoot, 'fxr-01', 'capture-manifest.json'), 'utf8'));
  assert.deepEqual(manifest.eligibility, { F1: false, F2: true, F3: true });
  assert.ok(manifest.failureReasons.some((r) => r.startsWith('F1:')), manifest.failureReasons.join('; '));
});

await check('a capture with one successful specialist fails F2', async () => {
  const run = await stubSession('one-worker', { failFor: ['market_researcher', 'brand_creative'] }, { fresh: true });
  const result = verifyAt(run.realRoot);
  assert.equal(result.ok, false);
  assert.ok(someFailureMatches(result, '/12b'), 'F2 must fail');
});

await check('a capture with one failed specialist is DEGRADED and fails F3', async () => {
  const run = await stubSession('degraded', { failFor: ['brand_creative'] }, { fresh: true });
  const result = verifyAt(run.realRoot);
  assert.equal(result.ok, false);
  assert.ok(someFailureMatches(result, '/13b'), 'F3 must fail');
  assert.equal(run.session.attempts[0].round1Status, 'DEGRADED');
});

await check('a worker whose model resolves differently becomes a Round 1 failure, not silent text', async () => {
  const run = await stubSession('pin-drift', {
    modelFor: (o) => (o.stage === 'round1_worker' ? 'some-other-model' : o.model),
  }, { fresh: true });
  const result = verifyAt(run.realRoot);
  assert.equal(result.ok, false);
  const snapshot = JSON.parse(readFileSync(join(run.realRoot, 'fxr-01', 'snapshot.json'), 'utf8'));
  for (const r of snapshot.workerResults) {
    assert.equal(r.output, undefined, 'text from an unpinned model must not enter the snapshot');
    assert.match(r.error, /MODEL_PIN_MISMATCH/);
  }
  const raw = JSON.parse(readFileSync(join(run.realRoot, 'fxr-01', 'raw-calls.json'), 'utf8'));
  const worker = raw.find((c) => c.stage === 'round1_worker');
  assert.ok(worker.responseText.length > 0, 'the raw response is still preserved as evidence');
  assert.equal(worker.pinMismatch, true);
});

await check('a violation raised inside a worker call is latched even when the caller swallows the throw', async () => {
  // Production catches each worker call's exception itself. A guard that relied on its
  // throw reaching the session would therefore be silently downgraded to a worker error.
  const recorder = createRecorder({
    call: async (p, _, o) => ({ provider: p, model: o.model, text: 'x' }),
    now: () => new Date('2026-09-06T00:00:00.000Z'),
  });
  const dispatch = recorder.dispatcherFor('fxr-01', { pins: PINS, workers: RECORDER_WORKERS });
  const swallow = async (fn) => { try { await fn(); } catch { /* exactly what production does */ } };
  await swallow(() => dispatch('openai', 'p', { stage: 'round1_worker', model: 'gpt-5', system: RECORDER_WORKERS[0].role, retrieval: { enabled: true } }));
  assert.ok(recorder.violation, 'the latch must survive the caller swallowing the throw');
  assert.equal(recorder.violation.code, 'RETRIEVAL_POLICY_VIOLATION');
  assert.equal(recorder.liveCallCount, 0, 'and the provider must not have been called');
});

await check('the session stops the round on a latched violation instead of attempting the next candidate', async () => {
  // A budget small enough that it runs out partway through the second candidate's workers,
  // which is inside production's per-worker catch — the swallow path, end to end.
  const run = await stubSession('budget-halt', {}, { fresh: true, globalBudget: 6 });
  assert.ok(run.session.roundEndingViolation, 'the violation must be recorded on the session');
  assert.equal(run.session.roundEndingViolation.code, 'CALL_BUDGET_EXCEEDED');
  assert.equal(run.session.roundEndingViolation.fixtureId, 'fxr-02');
  assert.equal(run.session.globalLiveCallCount, 6, 'no call may be issued past the budget');
  assert.deepEqual(run.session.attempts.map((a) => a.fixtureId), ['fxr-01', 'fxr-02'],
    'the violating candidate is kept as evidence; fxr-03 and fxr-04 are never attempted');
  assert.equal(run.session.attempts[1].captureStatus, 'FAILED');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nSuperseded synthetic material stays byte-unchanged');

await check('the frozen synthetic fixtures and archived ground truth still recompute their hashes', () => {
  const result = verifySyntheticUnchanged({
    syntheticRoot: SYNTHETIC_ROOT,
    evaluationRoot: EVALUATION_ROOT,
    freezeManifestPath: FREEZE_MANIFEST,
  });
  assert.deepEqual(result.failures.map((f) => f.id), []);
  assert.equal(result.checks.length, 36);
});

await check('the synthetic integrity check fails when a frozen fixture is edited', () => {
  const copy = join(SCRATCH, 'synthetic-copy');
  rmSync(copy, { recursive: true, force: true });
  mkdirSync(copy, { recursive: true });
  cpSync(SYNTHETIC_ROOT, join(copy, 'fixtures'), { recursive: true });
  cpSync(EVALUATION_ROOT, join(copy, 'evaluation'), { recursive: true });
  const victim = join(copy, 'fixtures', 'fx-01', 'round1-market_positioning.md');
  writeFileSync(victim, readFileSync(victim, 'utf8') + '\n\nan edit that must be caught', 'utf8');
  const result = verifySyntheticUnchanged({
    syntheticRoot: join(copy, 'fixtures'),
    evaluationRoot: join(copy, 'evaluation'),
    freezeManifestPath: FREEZE_MANIFEST,
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.id.includes('round1-market_positioning.md')));
});

await check('the synthetic integrity check fails when archived ground truth is edited', () => {
  const copy = join(SCRATCH, 'synthetic-copy-2');
  rmSync(copy, { recursive: true, force: true });
  mkdirSync(copy, { recursive: true });
  cpSync(SYNTHETIC_ROOT, join(copy, 'fixtures'), { recursive: true });
  cpSync(EVALUATION_ROOT, join(copy, 'evaluation'), { recursive: true });
  const victim = join(copy, 'evaluation', 'fx-01', 'gold-issues.json');
  writeFileSync(victim, readFileSync(victim, 'utf8') + ' ', 'utf8');
  const result = verifySyntheticUnchanged({
    syntheticRoot: join(copy, 'fixtures'),
    evaluationRoot: join(copy, 'evaluation'),
    freezeManifestPath: FREEZE_MANIFEST,
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.id.includes('gold-issues.json')));
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nReplacement set R2 — identity, isolation and frozen tasks');

await check('the candidate sets are disjoint and cover every known fixture id', () => {
  const seen = new Set();
  for (const set of Object.values(CANDIDATE_SETS)) {
    for (const id of set.fixtureIds) {
      assert.ok(!seen.has(id), `${id} appears in more than one candidate set`);
      seen.add(id);
    }
  }
  assert.deepEqual([...CANDIDATE_SETS.R1.fixtureIds], ['fxr-01', 'fxr-02', 'fxr-03', 'fxr-04']);
  assert.deepEqual([...CANDIDATE_SETS.R2.fixtureIds], ['fxr-05', 'fxr-06', 'fxr-07', 'fxr-08']);
});

await check('R2 writes to its own root, so R1 evidence cannot be overwritten', () => {
  assert.notEqual(CANDIDATE_SETS.R1.realRoot, CANDIDATE_SETS.R2.realRoot);
  assert.ok(CANDIDATE_SETS.R2.realRoot.includes('fixtures-real-r2'));
  assert.notEqual(CANDIDATE_SETS.R1.sourceRoot, CANDIDATE_SETS.R2.sourceRoot);
});

await check('R2 candidates resolve to the frozen replacement tasks, not the superseded synthetic ones', () => {
  for (const id of CANDIDATE_SETS.R2.fixtureIds) {
    const path = sourceTaskPath(id);
    assert.ok(path.startsWith(CANDIDATES_R2_ROOT), `${id} must read from candidates-r2, got ${path}`);
    assert.ok(!path.includes('/fixtures/'), `${id} must not read a synthetic fixture`);
    assert.ok(readFileSync(path, 'utf8').length > 400);
  }
});

await check('R2 provider allocation is the authorized Option 3-prime slot assignment', () => {
  assert.deepEqual(PROVIDER_ALLOCATION['fxr-05'], { provider: 'openai', model: 'gpt-5' });
  assert.deepEqual(PROVIDER_ALLOCATION['fxr-06'], { provider: 'claude', model: 'claude-sonnet-5' });
  assert.deepEqual(PROVIDER_ALLOCATION['fxr-07'], { provider: 'gemini', model: 'gemini-3.1-pro-preview' });
  assert.deepEqual(PROVIDER_ALLOCATION['fxr-08'], { provider: 'openai', model: 'gpt-5' });
  for (const id of CANDIDATE_SETS.R2.fixtureIds) {
    const refs = buildWorkerRefs(id);
    assert.deepEqual(refs.map((r) => r.id), REGISTERED_SPECIALISTS);
    for (const ref of refs) {
      assert.equal(ref.provider, PROVIDER_ALLOCATION[id].provider);
      assert.equal(ref.model, PROVIDER_ALLOCATION[id].model);
      assert.equal(ref.providesEvidence, false);
    }
  }
});

await check('the frozen R2 tasks match the hashes recorded in the candidate set manifest', () => {
  const manifest = JSON.parse(readFileSync(join(CANDIDATES_R2_ROOT, 'candidate-set-manifest.json'), 'utf8'));
  assert.equal(manifest.candidates.length, 4);
  for (const entry of manifest.candidates) {
    const task = readFileSync(sourceTaskPath(entry.fixtureId), 'utf8');
    assert.equal(sha256(task), entry.taskSha256, entry.fixtureId);
    assert.equal(SOURCE_CANDIDATE[entry.fixtureId], entry.candidateId);
  }
});

await check('no R2 task tells the planner what to conclude', () => {
  // A task that named the complexity, the roster size, or the intended archetype would make
  // the result a property of the prompt rather than of the decision under test.
  const forbidden = [
    /deep/i, /complexity/i, /specialist/i, /archetype/i, /negative control/i,
    /多位專家/, /至少兩位/, /控制組/, /負控/, /專家.{0,4}不同意/, /disagree/i,
  ];
  for (const id of CANDIDATE_SETS.R2.fixtureIds) {
    const task = readFileSync(sourceTaskPath(id), 'utf8');
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(task), `${id} leaks ${pattern} to the planner`);
    }
  }
});

await check('the intended archetype labels live only in provenance, never in a task', () => {
  const manifest = readFileSync(join(CANDIDATES_R2_ROOT, 'candidate-set-manifest.json'), 'utf8');
  for (const label of ['STRATEGY_CONFLICT', 'EXECUTION_CONSTRAINT_CONFLICT', 'EVIDENCE_INTERPRETATION_CONFLICT', 'NEGATIVE_CONTROL']) {
    assert.ok(manifest.includes(label), `${label} must be recorded in provenance`);
    for (const id of CANDIDATE_SETS.R2.fixtureIds) {
      assert.ok(!readFileSync(sourceTaskPath(id), 'utf8').includes(label), `${label} must not appear in a task`);
    }
  }
});

await check('a session refuses to mix candidates from two sets', async () => {
  await mustReject(
    () => runCaptureSession({
      call: stubCall(),
      realRoot: join(SCRATCH, 'mixed'),
      fixtureIds: ['fxr-01', 'fxr-05'],
      meta: META,
    }),
    'mixed sets'
  );
});

await check('a legal R2 stub capture verifies clean and is recorded under its own set', async () => {
  const realRoot = join(SCRATCH, 'legal-r2');
  const out = await runCaptureSession({
    call: stubCall(),
    realRoot,
    fixtureIds: CANDIDATE_SETS.R2.fixtureIds,
    meta: META,
    now: () => new Date('2026-09-06T00:00:00.000Z'),
    fresh: true,
  });
  assert.equal(out.session.candidateSet, 'R2');
  assert.deepEqual(out.session.attempts.map((a) => a.fixtureId), ['fxr-05', 'fxr-06', 'fxr-07', 'fxr-08']);
  assert.deepEqual(out.session.attempts.map((a) => a.sourceCandidateId), ['r2-01', 'r2-02', 'r2-03', 'r2-04']);
  const result = verifyAt(realRoot);
  assert.deepEqual(failedIds(result), []);
  assert.equal(out.session.globalLiveCallCount, 16);
});

await check('the R1 capture evidence on disk still verifies as four preserved failures', () => {
  const result = verifyAt(CANDIDATE_SETS.R1.realRoot);
  // Exactly the six eligibility failures, and nothing else: the R1 record must stay
  // readable as an honest failure, not be repaired into a pass or degraded into corruption.
  assert.deepEqual(failedIds(result).sort(), [
    'fxr-01/10b', 'fxr-02/10b', 'fxr-02/12b', 'fxr-03/10b', 'fxr-04/10b', 'fxr-04/12b',
  ]);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nReplacement set R3 — exact freeze, 12-call ceiling and isolation');

await check('R3 has exactly the three authorized fixture ids and its own roots', () => {
  assert.deepEqual([...CANDIDATE_SETS.R3.fixtureIds], ['fxr-09', 'fxr-10', 'fxr-11']);
  assert.equal(CANDIDATE_SETS.R3.globalCallBudget, 12);
  assert.ok(CANDIDATE_SETS.R3.sourceRoot.includes('candidates-r3'));
  assert.ok(CANDIDATE_SETS.R3.realRoot.includes('fixtures-real-r3'));
  assert.notEqual(CANDIDATE_SETS.R3.sourceRoot, CANDIDATE_SETS.R2.sourceRoot);
  assert.notEqual(CANDIDATE_SETS.R3.realRoot, CANDIDATE_SETS.R2.realRoot);
});

await check('R3 tasks and character counts match the frozen manifest', () => {
  const manifest = JSON.parse(readFileSync(join(CANDIDATES_R3_ROOT, 'candidate-set-manifest.json'), 'utf8'));
  assert.equal(manifest.candidates.length, 3);
  assert.equal(manifest.globalLiveCallBudget, 12);
  for (const entry of manifest.candidates) {
    const task = readFileSync(sourceTaskPath(entry.fixtureId), 'utf8');
    assert.equal(sha256(task), entry.taskSha256, entry.fixtureId);
    assert.equal([...task].length, entry.taskChars, entry.fixtureId);
    assert.equal(SOURCE_CANDIDATE[entry.fixtureId], entry.candidateId);
  }
});

await check('R3 uses the authorized positive provider rotation with retrieval disabled', () => {
  assert.deepEqual(PROVIDER_ALLOCATION['fxr-09'], { provider: 'openai', model: 'gpt-5' });
  assert.deepEqual(PROVIDER_ALLOCATION['fxr-10'], { provider: 'claude', model: 'claude-sonnet-5' });
  assert.deepEqual(PROVIDER_ALLOCATION['fxr-11'], { provider: 'gemini', model: 'gemini-3.1-pro-preview' });
  for (const id of CANDIDATE_SETS.R3.fixtureIds) {
    for (const ref of buildWorkerRefs(id)) {
      assert.equal(ref.provider, PROVIDER_ALLOCATION[id].provider);
      assert.equal(ref.model, PROVIDER_ALLOCATION[id].model);
      assert.equal(ref.providesEvidence, false);
    }
  }
});

await check('R3 task text does not expose experiment metadata to the planner', () => {
  const forbidden = [
    /complexity/i, /specialist/i, /archetype/i, /negative control/i,
    /多位專家/, /至少兩位/, /控制組/, /負控/, /專家.{0,4}不同意/, /disagree/i,
  ];
  for (const id of CANDIDATE_SETS.R3.fixtureIds) {
    const task = readFileSync(sourceTaskPath(id), 'utf8');
    for (const pattern of forbidden) assert.ok(!pattern.test(task), `${id} leaks ${pattern}`);
  }
});

await check('a legal R3 stub capture spends exactly twelve calls and verifies cleanly', async () => {
  const realRoot = join(SCRATCH, 'legal-r3');
  const out = await runCaptureSession({
    call: stubCall(),
    realRoot,
    fixtureIds: CANDIDATE_SETS.R3.fixtureIds,
    meta: META,
    now: () => new Date('2026-09-06T00:00:00.000Z'),
    fresh: true,
    globalBudget: CANDIDATE_SETS.R3.globalCallBudget,
  });
  assert.equal(out.session.candidateSet, 'R3');
  assert.equal(out.session.globalCallBudget, 12);
  assert.equal(out.session.globalLiveCallCount, 12);
  assert.deepEqual(out.session.attempts.map((a) => a.fixtureId), ['fxr-09', 'fxr-10', 'fxr-11']);
  const result = verifyAt(realRoot, CANDIDATE_SETS.R3.globalCallBudget);
  assert.deepEqual(failedIds(result), []);
});

await check('the R2 capture remains the same two F2 failures and nothing else', () => {
  const result = verifyAt(CANDIDATE_SETS.R2.realRoot, CANDIDATE_SETS.R2.globalCallBudget);
  assert.deepEqual(failedIds(result).sort(), ['fxr-05/12b', 'fxr-07/12b']);
});

rmSync(SCRATCH, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
