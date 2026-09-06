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
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createRecorder, ScopeViolation, RetrievalPolicyViolation, TemperaturePolicyViolation,
  CallBudgetExceeded, WorkerBindingError, ModelPinMismatch, RequestPinMismatch, DuplicateAttempt,
  ALLOWED_STAGES, GLOBAL_CALL_BUDGET,
} from './capture/recorder.mjs';
import { runCaptureSession } from './capture/session.mjs';
import { verifyCapture, verifySyntheticUnchanged } from './capture/capture-verify.mjs';
import {
  REAL_FIXTURE_IDS, PROVIDER_ALLOCATION, HISTORICAL_PROVIDER_ALLOCATION, CHIEF_PIN, SOURCE_CANDIDATE,
  SYNTHETIC_ROOT, CANDIDATES_R2_ROOT, CANDIDATES_R3_ROOT, CANDIDATES_0_3_ROOT, P03_REAL_ROOT,
  CANDIDATE_SETS, candidateSetFor, sourceTaskPath, REGISTERED_SPECIALISTS, buildWorkerRefs,
  assertFrozenP03Pool, selectWaveSlots, waveCallBudget, waveOutputRoot, canonical, sha256,
  CAPTURE_VERSION, TRANSPORT_MAX_RETRIES, TRANSPORT_RETRY_POLICY,
} from './capture/runner.mjs';
import {
  ACQUISITION_POOL_SIZE, ARCHETYPE_SLOTS, ROLE_PROVIDER_MAP, WAVES,
  routingFor, cd1TargetInvariantHolds,
} from './protocol/amendment-0-3.mjs';

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

const verifyAt = (realRoot, globalCallBudget = GLOBAL_CALL_BUDGET, expectedFixtureIds = null) => verifyCapture({
  realRoot,
  chiefPin: CHIEF_PIN,
  providerAllocation: PROVIDER_ALLOCATION,
  sourceCandidate: SOURCE_CANDIDATE,
  sourceTaskPathFor: sourceTaskPath,
  globalCallBudget,
  expectedFixtureIds,
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

const RECORDER_WORKERS = REGISTERED_SPECIALISTS.map((id, i) => ({
  id,
  role: `Role ${i} for ${id}`,
  ...routingFor(id),
}));
const PINS = { planning: CHIEF_PIN, round1_worker: routingFor };

const dispatchWorker = (dispatch, worker, options = {}) => dispatch(
  options.provider ?? worker.provider,
  options.prompt ?? 'p',
  {
    stage: 'round1_worker',
    model: options.model ?? worker.model,
    system: worker.role,
    ...(options.retrieval === undefined ? {} : { retrieval: options.retrieval }),
  },
);

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
    for (const w of RECORDER_WORKERS) await dispatchWorker(dispatch, w);
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
    for (const w of RECORDER_WORKERS) await dispatchWorker(dispatch, w);
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
    RECORDER_WORKERS.map((w) => dispatchWorker(dispatch, w))
  );
  assert.equal(providerCalls, 2, 'exactly the budget may reach a provider, however concurrent the batch');
  assert.equal(settled.filter((r) => r.status === 'rejected').length, 1);
  assert.ok(settled.find((r) => r.status === 'rejected').reason instanceof CallBudgetExceeded);
  assert.equal(recorder.reservedCallCount, 2);
});

await check('the per-candidate budget stops a fifth call for one candidate', async () => {
  const f = recorderFixture();
  await f.dispatch('openai', 'p', { stage: 'planning', model: 'gpt-5' });
  for (const w of RECORDER_WORKERS) await dispatchWorker(f.dispatch, w);
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

await check('round1 worker expected pins are resolved per bound agent id', async () => {
  const recorder = createRecorder({
    call: async (provider, prompt, options) => ({ provider, model: options.model, text: prompt }),
  });
  const dispatch = recorder.dispatcherFor('fxr-01', { pins: PINS, workers: RECORDER_WORKERS });
  for (const worker of RECORDER_WORKERS) await dispatchWorker(dispatch, worker);
  assert.equal(recorder.calls.length, 3);
  for (const raw of recorder.calls) {
    assert.deepEqual(
      { provider: raw.providerRequested, model: raw.modelRequested },
      ROLE_PROVIDER_MAP[raw.agentId],
      raw.agentId,
    );
    assert.equal(raw.pinMismatch, false);
  }
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
  await dispatchWorker(dispatch, RECORDER_WORKERS[0]);
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
console.log('\nRequest-side pin guard — a mis-addressed request never reaches a provider');

await check('T-P1-1: a planning call to the wrong provider is refused before the provider is reached', async () => {
  const f = recorderFixture();
  const err = await mustReject(
    () => f.dispatch('claude', 'p', { stage: 'planning', model: CHIEF_PIN.model }),
    'planning provider mismatch',
  );
  assert.ok(err instanceof RequestPinMismatch);
  assert.equal(err.code, 'REQUEST_PIN_MISMATCH');
  assert.equal(err.expected, `${CHIEF_PIN.provider}/${CHIEF_PIN.model}`);
  assert.equal(err.requested, `claude/${CHIEF_PIN.model}`);
  assert.match(String(err), /Provider NOT called/);
  assert.equal(f.providerCalls, 0, 'the provider must not have been called');
  assert.equal(f.recorder.liveCallCount, 0);
  assert.equal(f.recorder.reservedCallCount, 0, 'a refused request claims no budget slot');
  assert.equal(f.recorder.violation.code, 'REQUEST_PIN_MISMATCH');
});

await check('T-P1-2: a planning call to the wrong model is refused before the provider is reached', async () => {
  const f = recorderFixture();
  const err = await mustReject(
    () => f.dispatch(CHIEF_PIN.provider, 'p', { stage: 'planning', model: 'wrong-model' }),
    'planning model mismatch',
  );
  assert.ok(err instanceof RequestPinMismatch);
  assert.equal(err.requested, `${CHIEF_PIN.provider}/wrong-model`);
  assert.equal(f.providerCalls, 0);
  assert.equal(f.recorder.liveCallCount, 0);
  assert.equal(f.recorder.reservedCallCount, 0);
});

await check('T-P1-3: a worker call to the wrong provider is refused after attribution, before the call', async () => {
  for (const worker of RECORDER_WORKERS) {
    const f = recorderFixture();
    const wrong = worker.provider === 'openai' ? 'claude' : 'openai';
    const err = await mustReject(() => dispatchWorker(f.dispatch, worker, { provider: wrong }), worker.id);
    assert.ok(err instanceof RequestPinMismatch, worker.id);
    // Attribution still happened: the error names the specialist it was addressed to.
    assert.equal(err.agentId, worker.id);
    assert.equal(err.expected, `${routingFor(worker.id).provider}/${routingFor(worker.id).model}`);
    assert.equal(f.providerCalls, 0, worker.id);
    assert.equal(f.recorder.liveCallCount, 0);
    assert.equal(f.recorder.reservedCallCount, 0);
  }
});

await check('T-P1-4: a worker call to the wrong model is refused before the provider is reached', async () => {
  for (const worker of RECORDER_WORKERS) {
    const f = recorderFixture();
    const err = await mustReject(() => dispatchWorker(f.dispatch, worker, { model: 'wrong-model' }), worker.id);
    assert.ok(err instanceof RequestPinMismatch, worker.id);
    assert.equal(err.requested, `${worker.provider}/wrong-model`);
    assert.equal(f.providerCalls, 0, worker.id);
    assert.equal(f.recorder.reservedCallCount, 0);
  }
});

await check('T-P1-5: a correctly addressed request still reaches the provider', async () => {
  const f = recorderFixture();
  await f.dispatch(CHIEF_PIN.provider, 'p', { stage: 'planning', model: CHIEF_PIN.model });
  assert.equal(f.providerCalls, 1);
  assert.equal(f.recorder.liveCallCount, 1);
  assert.equal(f.recorder.reservedCallCount, 1);
  assert.equal(f.recorder.violation, null, 'a legal call is not a violation');

  for (const worker of RECORDER_WORKERS) {
    const w = recorderFixture();
    await dispatchWorker(w.dispatch, worker);
    assert.equal(w.providerCalls, 1, worker.id);
    assert.equal(w.recorder.liveCallCount, 1);
    assert.equal(w.recorder.reservedCallCount, 1);
    assert.equal(w.recorder.calls[0].pinMismatch, false);
    assert.equal(w.recorder.calls[0].success, true);
  }
});

await check('T-P1-6: resolved-side drift is still post-call evidence, not a refusal', async () => {
  const f = recorderFixture({
    call: async (provider, prompt, options) => ({ provider: 'wrong-provider', model: options.model, text: 'stub' }),
  });
  const err = await mustReject(
    () => f.dispatch(CHIEF_PIN.provider, 'p', { stage: 'planning', model: CHIEF_PIN.model }),
    'resolved drift',
  );
  assert.ok(err instanceof ModelPinMismatch, 'the paid-for call keeps its own error type');
  assert.ok(!(err instanceof RequestPinMismatch));
  assert.equal(err.code, 'MODEL_PIN_MISMATCH');
  assert.equal(f.recorder.liveCallCount, 1, 'the call happened and is counted');
  assert.equal(f.recorder.reservedCallCount, 1);
  const record = f.recorder.calls[0];
  assert.equal(record.providerResolved, 'wrong-provider');
  assert.equal(record.responseText, 'stub', 'raw response preserved');
  assert.equal(record.pinMismatch, true);
  assert.equal(record.success, false);
  assert.match(record.error, /MODEL_PIN_MISMATCH/);
});

await check('T-P1-6b: a resolved model drift is caught the same way', async () => {
  const f = recorderFixture({
    call: async (provider) => ({ provider, model: 'some-other-model', text: 'stub' }),
  });
  const err = await mustReject(
    () => f.dispatch(CHIEF_PIN.provider, 'p', { stage: 'planning', model: CHIEF_PIN.model }),
    'resolved model drift',
  );
  assert.ok(err instanceof ModelPinMismatch);
  assert.equal(f.recorder.liveCallCount, 1);
  assert.equal(f.recorder.calls[0].modelResolved, 'some-other-model');
});

await check('T-P1-7: a refused request writes no live-call record to the journal', async () => {
  const journalPath = join(mkdtempSync(join(tmpdir(), 'm2b-p1-')), 'journal.ndjson');
  let calledProvider = 0;
  const recorder = createRecorder({
    call: async (provider, prompt, options) => { calledProvider += 1; return { provider, model: options.model, text: 'stub' }; },
    journalPath,
    now: () => new Date('2026-09-06T00:00:00.000Z'),
  });
  const dispatch = recorder.dispatcherFor('fxr-01', { pins: PINS, workers: RECORDER_WORKERS });
  await mustReject(() => dispatch('claude', 'p', { stage: 'planning', model: CHIEF_PIN.model }), 'refused');
  assert.equal(calledProvider, 0);
  assert.equal(recorder.liveCallCount, 0);
  assert.equal(existsSync(journalPath), false, 'nothing was appended, so the journal was never created');

  // And a legal call afterwards does write one, so the absence above is the guard, not a
  // broken journal path.
  await dispatch(CHIEF_PIN.provider, 'p', { stage: 'planning', model: CHIEF_PIN.model });
  const lines = readFileSync(journalPath, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).providerRequested, CHIEF_PIN.provider);
});

await check('T-P1-8: a refused request does not consume the budget it would have used', async () => {
  let calledProvider = 0;
  const recorder = createRecorder({
    call: async (provider, prompt, options) => { calledProvider += 1; return { provider, model: options.model, text: 'stub' }; },
    now: () => new Date('2026-09-06T00:00:00.000Z'),
    globalBudget: 1,
  });
  const dispatch = recorder.dispatcherFor('fxr-01', { pins: PINS, workers: RECORDER_WORKERS });
  await mustReject(() => dispatch('claude', 'p', { stage: 'planning', model: CHIEF_PIN.model }), 'refused');
  assert.equal(recorder.reservedCallCount, 0);

  await dispatch(CHIEF_PIN.provider, 'p', { stage: 'planning', model: CHIEF_PIN.model });
  assert.equal(calledProvider, 1, 'the one budgeted call is still available after a refusal');
  assert.equal(recorder.reservedCallCount, 1);
});

await check('T-P1-9: the violation latch survives a worker try/catch swallowing the throw', async () => {
  const f = recorderFixture();
  const worker = RECORDER_WORKERS[0];
  const wrong = worker.provider === 'openai' ? 'claude' : 'openai';
  // Exactly what production does around each Round 1 worker call.
  let swallowed = null;
  try {
    await dispatchWorker(f.dispatch, worker, { provider: wrong });
  } catch (e) {
    swallowed = e;
  }
  assert.ok(swallowed instanceof RequestPinMismatch);
  assert.equal(f.recorder.violation.code, 'REQUEST_PIN_MISMATCH', 'the round must still know');
  assert.match(f.recorder.violation.message, /Provider NOT called/);
  assert.equal(f.recorder.violation.stage, 'round1_worker');
  assert.equal(f.providerCalls, 0);
});

await check('T-P1-10: the earlier pre-call guards still fire, and still fire first', async () => {
  // Each of these is dispatched with a provider/model that would ALSO fail the new pin
  // guard, so a passing assertion proves the older guard still runs ahead of it.
  const wrong = { provider: 'claude', model: 'wrong-model' };

  const scope = recorderFixture();
  assert.ok(await mustReject(
    () => scope.dispatch(wrong.provider, 'p', { stage: 'synthesis', model: wrong.model }), 'scope',
  ) instanceof ScopeViolation);
  assert.equal(scope.providerCalls, 0);

  const retrieval = recorderFixture();
  assert.ok(await mustReject(
    () => retrieval.dispatch(wrong.provider, 'p', { stage: 'planning', model: wrong.model, retrieval: { enabled: false } }), 'retrieval',
  ) instanceof RetrievalPolicyViolation);

  const temperature = recorderFixture();
  assert.ok(await mustReject(
    () => temperature.dispatch(wrong.provider, 'p', { stage: 'planning', model: wrong.model, temperature: 0 }), 'temperature',
  ) instanceof TemperaturePolicyViolation);

  const binding = recorderFixture();
  assert.ok(await mustReject(
    () => binding.dispatch(wrong.provider, 'p', { stage: 'round1_worker', model: wrong.model, system: 'not a registered role' }), 'binding',
  ) instanceof WorkerBindingError);
  assert.equal(binding.providerCalls, 0);

  const budget = createRecorder({ call: async () => ({ provider: 'x', model: 'y', text: 't' }), globalBudget: 0 });
  const dispatch = budget.dispatcherFor('fxr-01', { pins: PINS, workers: RECORDER_WORKERS });
  assert.ok(await mustReject(
    () => dispatch(wrong.provider, 'p', { stage: 'planning', model: wrong.model }), 'budget',
  ) instanceof CallBudgetExceeded);
});

console.log('\nCapture runner — production binding');

await check('every registered specialist resolves through the accepted role-provider map', () => {
  const refs = buildWorkerRefs('fixture-id-cannot-affect-routing');
  assert.equal(refs.length, 3);
  assert.deepEqual(refs.map((r) => r.id), REGISTERED_SPECIALISTS);
  for (const ref of refs) {
    assert.deepEqual(
      { provider: ref.provider, model: ref.model },
      ROLE_PROVIDER_MAP[ref.id],
      ref.id,
    );
    assert.equal(ref.providesEvidence, false, 'all-off retrieval is enforced structurally, not by prompt');
  }
});

await check('one roster carries three heterogeneous provider/model pins at the same time', () => {
  const refs = buildWorkerRefs('same-fixture');
  assert.equal(new Set(refs.map((r) => `${r.provider}/${r.model}`)).size, 3);
});

await check('Chief planning remains pinned to openai/gpt-5', () => {
  assert.deepEqual(CHIEF_PIN, { provider: 'openai', model: 'gpt-5' });
});

await check('C and D1 resolve identically whenever they target the same agent id', () => {
  for (const agentId of REGISTERED_SPECIALISTS) {
    assert.equal(cd1TargetInvariantHolds(agentId), true, agentId);
    assert.deepEqual(routingFor(agentId), routingFor(agentId));
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

await check('a new capture records auditable heterogeneous allocation provenance', () => {
  const manifest = JSON.parse(readFileSync(join(legal.realRoot, 'fxr-01', 'capture-manifest.json'), 'utf8'));
  assert.equal(manifest.protocolVersion, 'M2B-PROTOCOL-0.3');
  assert.equal(manifest.captureVersion, CAPTURE_VERSION);
  assert.equal(CAPTURE_VERSION, 'M2B-REAL-ROUND1-CAPTURE-3', 'transport provenance is CAPTURE-3');
  assert.equal(manifest.providerAllocation.mode, 'role-based-heterogeneous');
  assert.deepEqual(manifest.providerAllocation.byAgent, ROLE_PROVIDER_MAP);
  for (const worker of manifest.workers) {
    assert.equal(worker.routingRole, worker.agentId);
    assert.deepEqual(
      { provider: worker.providerRequested, model: worker.modelRequested },
      ROLE_PROVIDER_MAP[worker.agentId],
    );
    assert.equal(worker.providerResolved, ROLE_PROVIDER_MAP[worker.agentId].provider);
    assert.equal(worker.modelResolved, ROLE_PROVIDER_MAP[worker.agentId].model);
  }
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
  ['role-allocation-manifest-differs-from-protocol', (dir) => {
    editJson(join(dir, 'fxr-01', 'capture-manifest.json'), (m) => {
      m.providerAllocation.byAgent.business_strategist.provider = 'openai';
    });
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
  assert.equal(run.session.globalLiveCallCount, 16, 'one planning plus three worker calls per fixture; no retry');
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

await check('a worker whose provider resolves differently preserves raw evidence with no retry or fallback', async () => {
  const run = await stubSession('provider-drift', {
    providerFor: (provider, options) => (options.stage === 'round1_worker' ? 'wrong-provider' : provider),
  }, { fresh: true });
  assert.equal(run.session.globalLiveCallCount, 16, 'mismatches do not add retry or fallback calls');
  for (const fixtureId of REAL_FIXTURE_IDS) {
    const raw = JSON.parse(readFileSync(join(run.realRoot, fixtureId, 'raw-calls.json'), 'utf8'));
    const workers = raw.filter((call) => call.stage === 'round1_worker');
    assert.equal(workers.length, 3);
    for (const call of workers) {
      assert.equal(call.providerResolved, 'wrong-provider');
      assert.ok(call.responseText.length > 0, 'raw response must be preserved');
      assert.equal(call.pinMismatch, true);
      assert.equal(call.success, false);
    }
  }
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
console.log('\nProtocol 0.3 candidate pool — frozen sources, waves and one-shot execution');

const P03_MANIFEST_PATH = join(CANDIDATES_0_3_ROOT, 'candidate-set-manifest.json');
const P03_PROVENANCE_PATH = join(CANDIDATES_0_3_ROOT, 'freeze-provenance.json');
const PROTOCOL_SLOT_IDS = Object.values(ARCHETYPE_SLOTS).flat();

await check('P03 registers exactly the nine accepted protocol slots', () => {
  assert.equal(CANDIDATE_SETS.P03.setId, 'P03');
  assert.equal(CANDIDATE_SETS.P03.fixtureIds.length, ACQUISITION_POOL_SIZE);
  assert.deepEqual([...CANDIDATE_SETS.P03.fixtureIds], PROTOCOL_SLOT_IDS);
  assert.equal(new Set(CANDIDATE_SETS.P03.fixtureIds).size, 9);
});

await check('S1, E1 and I1 resolve only to their frozen candidates-0-3 task paths', () => {
  for (const slotId of ['S1', 'E1', 'I1']) {
    const path = sourceTaskPath(slotId);
    assert.equal(path, join(CANDIDATES_0_3_ROOT, slotId, 'task.txt'));
    for (const historical of [SYNTHETIC_ROOT, CANDIDATES_R2_ROOT, CANDIDATES_R3_ROOT]) {
      assert.equal(path.startsWith(historical), false, `${slotId} must not resolve under ${historical}`);
    }
  }
});

await check('all nine P03 task hashes recompute against both frozen records', () => {
  const { manifest, provenance } = assertFrozenP03Pool();
  assert.deepEqual(provenance, JSON.parse(readFileSync(P03_PROVENANCE_PATH, 'utf8')));
  assert.equal(sha256(readFileSync(P03_MANIFEST_PATH, 'utf8')), provenance.candidateSetManifestSha256);
  for (const slotId of PROTOCOL_SLOT_IDS) {
    const actual = sha256(readFileSync(sourceTaskPath(slotId), 'utf8'));
    assert.equal(actual, manifest.taskSha256[slotId], slotId);
    assert.equal(actual, provenance.taskSha256[slotId], slotId);
  }
});

await check('Wave 1 resolves exactly S1, E1, I1 in protocol order', () => {
  assert.deepEqual(selectWaveSlots(1, []), ['S1', 'E1', 'I1']);
  assert.deepEqual(selectWaveSlots(1, []), [...WAVES[0]]);
});

await check('Wave 2 skips STRATEGY when that archetype is already filled', () => {
  assert.deepEqual(selectWaveSlots(2, ['STRATEGY']), ['E2', 'I2']);
});

await check('Wave 3 skips every slot when all archetypes are filled', () => {
  assert.deepEqual(
    selectWaveSlots(3, ['STRATEGY', 'EXECUTION_CONSTRAINT', 'EVIDENCE_INTERPRETATION']),
    [],
  );
});

await check('every selected wave preserves protocol order', () => {
  for (let wave = 1; wave <= WAVES.length; wave += 1) {
    const selected = selectWaveSlots(wave, ['STRATEGY']);
    assert.deepEqual(selected, WAVES[wave - 1].filter((slot) => !slot.startsWith('S')));
  }
});

await check('wave call budget is selected slot count times four', () => {
  assert.equal(waveCallBudget(selectWaveSlots(1, [])), 12);
  assert.equal(waveCallBudget(selectWaveSlots(2, ['STRATEGY'])), 8);
  assert.equal(waveCallBudget([]), 0);
});

await check('P03 output roots are isolated by protocol and wave', () => {
  assert.ok(P03_REAL_ROOT.includes('fixtures-real-0-3'));
  assert.equal(waveOutputRoot(1), join(P03_REAL_ROOT, 'wave-1'));
  for (const historical of Object.values(CANDIDATE_SETS).filter((set) => set.setId !== 'P03')) {
    assert.notEqual(P03_REAL_ROOT, historical.realRoot);
    assert.equal(waveOutputRoot(1).startsWith(historical.realRoot), false);
  }
});

await check('live CLI rejects fresh and overwrite semantics before any capture path can run', () => {
  for (const flag of ['--fresh', '--overwrite', '--delete-existing']) {
    const result = spawnSync(process.execPath, [
      join(M2B, 'capture', 'run-live.mjs'),
      '--set=P03',
      '--wave=1',
      flag,
      '--i-am-authorized-to-spend-live-calls',
    ], { encoding: 'utf8' });
    assert.equal(result.status, 2, flag);
    assert.match(result.stderr, /test-only/, flag);
  }
  const source = readFileSync(join(M2B, 'capture', 'run-live.mjs'), 'utf8');
  assert.ok(source.indexOf('if (existsSync(REAL_ROOT))') < source.indexOf('await runCaptureSession('));
  assert.equal(/fresh\s*:/.test(source), false, 'live CLI must never pass fresh to the session');
});

await check('an existing session journal refuses rerun before the stub provider is reached', async () => {
  const realRoot = join(SCRATCH, 'p03-existing-journal');
  mkdirSync(realRoot, { recursive: true });
  writeFileSync(join(realRoot, 'journal.ndjson'), '', 'utf8');
  let providerCalls = 0;
  const err = await mustReject(() => runCaptureSession({
    call: async () => { providerCalls += 1; throw new Error('must not run'); },
    realRoot,
    fixtureIds: ['S3'],
    meta: META,
    globalBudget: 4,
    waveNumber: 3,
    filledArchetypes: ['EXECUTION_CONSTRAINT', 'EVIDENCE_INTERPRETATION'],
  }), 'existing journal');
  assert.match(String(err), /already exists/);
  assert.equal(providerCalls, 0);
});

const P03_HISTORY_ROOT = join(SCRATCH, 'p03-history');
const P03_WAVE1_SLOTS = selectWaveSlots(1, []);
const P03_WAVE1_ROOT = join(P03_HISTORY_ROOT, 'wave-1');
let p03Wave1 = null;

await check('a legal P03 Wave 1 stub capture spends twelve calls and verifies cleanly', async () => {
  const call = stubCall();
  p03Wave1 = await runCaptureSession({
    call,
    realRoot: P03_WAVE1_ROOT,
    fixtureIds: P03_WAVE1_SLOTS,
    meta: META,
    now: () => new Date('2026-09-06T00:00:00.000Z'),
    globalBudget: waveCallBudget(P03_WAVE1_SLOTS),
    attemptHistoryRoot: P03_HISTORY_ROOT,
    waveNumber: 1,
    filledArchetypes: [],
  });
  assert.deepEqual(p03Wave1.session.attempts.map((a) => a.fixtureId), ['S1', 'E1', 'I1']);
  assert.equal(p03Wave1.session.candidateSet, 'P03');
  assert.equal(p03Wave1.session.protocolVersion, 'M2B-PROTOCOL-0.3');
  assert.equal(p03Wave1.session.globalCallBudget, 12);
  assert.equal(p03Wave1.session.globalLiveCallCount, 12);
  assert.equal(call.seen.length, 12);
  const result = verifyAt(P03_WAVE1_ROOT, 12, P03_WAVE1_SLOTS);
  assert.deepEqual(failedIds(result), []);
  for (const attempt of p03Wave1.session.attempts) {
    const manifest = JSON.parse(readFileSync(join(P03_WAVE1_ROOT, attempt.fixtureId, 'capture-manifest.json'), 'utf8'));
    assert.equal(manifest.providerAllocation.mode, 'role-based-heterogeneous');
    assert.deepEqual(manifest.providerAllocation.byAgent, ROLE_PROVIDER_MAP);
  }
});

await check('a gated P03 Wave 2 skips STRATEGY, adjusts budget and verifies cleanly', async () => {
  const selected = selectWaveSlots(2, ['STRATEGY']);
  const realRoot = join(P03_HISTORY_ROOT, 'wave-2');
  const call = stubCall();
  const out = await runCaptureSession({
    call,
    realRoot,
    fixtureIds: selected,
    meta: META,
    now: () => new Date('2026-09-06T00:00:00.000Z'),
    globalBudget: waveCallBudget(selected),
    attemptHistoryRoot: P03_HISTORY_ROOT,
    waveNumber: 2,
    filledArchetypes: ['STRATEGY'],
  });
  assert.deepEqual(out.session.attempts.map((a) => a.fixtureId), ['E2', 'I2']);
  assert.equal(out.session.globalCallBudget, 8);
  assert.equal(out.session.globalLiveCallCount, 8);
  assert.equal(call.seen.length, 8, 'no call is spent on skipped S2');
  assert.deepEqual(failedIds(verifyAt(realRoot, 8, selected)), []);
});

await check('a cross-wave duplicate slot is refused before any provider call', async () => {
  let providerCalls = 0;
  const err = await mustReject(() => runCaptureSession({
    call: async () => { providerCalls += 1; throw new Error('must not run'); },
    realRoot: join(P03_HISTORY_ROOT, 'duplicate-wave'),
    fixtureIds: P03_WAVE1_SLOTS,
    meta: META,
    globalBudget: 12,
    attemptHistoryRoot: P03_HISTORY_ROOT,
    waveNumber: 1,
  }), 'cross-wave duplicate');
  assert.match(String(err), /already attempted in a prior wave/);
  assert.equal(providerCalls, 0);
});

await check('P03 session rejects reordered or manually selected slots before any provider call', async () => {
  let providerCalls = 0;
  const err = await mustReject(() => runCaptureSession({
    call: async () => { providerCalls += 1; throw new Error('must not run'); },
    realRoot: join(SCRATCH, 'p03-manual-order'),
    fixtureIds: ['E1', 'S1', 'I1'],
    meta: META,
    globalBudget: 12,
    waveNumber: 1,
  }), 'manual wave order');
  assert.match(String(err), /slots must be S1, E1, I1/);
  assert.equal(providerCalls, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nTransport provenance — CAPTURE-3 records it, CAPTURE-2 is not judged by it');

await check('C/D: a legal CAPTURE-3 capture carries the transport policy on session, manifest and every call', () => {
  const session = JSON.parse(readFileSync(join(legal.realRoot, 'capture-session.json'), 'utf8'));
  assert.equal(session.captureVersion, CAPTURE_VERSION);
  assert.equal(session.transportRetryPolicy, TRANSPORT_RETRY_POLICY);
  assert.equal(session.transportMaxRetries, TRANSPORT_MAX_RETRIES);
  for (const fixtureId of REAL_FIXTURE_IDS) {
    const manifest = JSON.parse(readFileSync(join(legal.realRoot, fixtureId, 'capture-manifest.json'), 'utf8'));
    assert.equal(manifest.transportRetryPolicy, TRANSPORT_RETRY_POLICY, fixtureId);
    assert.equal(manifest.transportMaxRetries, 0, fixtureId);
    const raw = JSON.parse(readFileSync(join(legal.realRoot, fixtureId, 'raw-calls.json'), 'utf8'));
    assert.ok(raw.length > 0);
    for (const call of raw) {
      assert.equal(call.transportRetryPolicy, TRANSPORT_RETRY_POLICY, `${fixtureId}/${call.seq}`);
      assert.equal(call.transportMaxRetriesRequested, 0, `${fixtureId}/${call.seq}`);
    }
  }
  assert.deepEqual(failedIds(verifyAt(legal.realRoot)), []);
});

await check('C: NEGATIVE: a CAPTURE-3 call with no recorded retry policy is rejected', () => {
  const result = tamper(legal.realRoot, 'transport-policy-absent', (dir) => {
    const path = join(dir, 'fxr-01', 'raw-calls.json');
    const calls = JSON.parse(readFileSync(path, 'utf8'));
    delete calls[0].transportRetryPolicy;
    delete calls[0].transportMaxRetriesRequested;
    writeFileSync(path, canonical(calls));
  });
  assert.ok(someFailureMatches(result, '/34b'), failedIds(result).join(', '));
  assert.ok(someFailureMatches(result, '/34c'), failedIds(result).join(', '));
});

await check('D: NEGATIVE: a CAPTURE-3 call requesting a nonzero retry count is rejected', () => {
  const result = tamper(legal.realRoot, 'transport-retries-nonzero', (dir) => {
    const path = join(dir, 'fxr-02', 'raw-calls.json');
    const calls = JSON.parse(readFileSync(path, 'utf8'));
    calls[calls.length - 1].transportMaxRetriesRequested = 2;
    writeFileSync(path, canonical(calls));
  });
  assert.ok(someFailureMatches(result, '/34c'), failedIds(result).join(', '));
});

await check('D: NEGATIVE: a CAPTURE-3 manifest declaring a different policy is rejected', () => {
  const result = tamper(legal.realRoot, 'transport-manifest-policy', (dir) => {
    const path = join(dir, 'fxr-03', 'capture-manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.transportRetryPolicy = 'sdk-default';
    writeFileSync(path, canonical(manifest));
  });
  assert.ok(someFailureMatches(result, '/34'), failedIds(result).join(', '));
});

await check('NEGATIVE: a CAPTURE-3 session with no dependency provenance is rejected', () => {
  const result = tamper(legal.realRoot, 'dependency-absent', (dir) => {
    const path = join(dir, 'capture-session.json');
    const session = JSON.parse(readFileSync(path, 'utf8'));
    delete session.dependencyProvenance;
    writeFileSync(path, canonical(session));
  });
  assert.ok(someFailureMatches(result, '35b'), failedIds(result).join(', '));
  assert.ok(someFailureMatches(result, '35c'), failedIds(result).join(', '));
});

await check('NEGATIVE: a CAPTURE-3 session whose SDK drifted from the proven version is rejected', () => {
  const result = tamper(legal.realRoot, 'dependency-drift', (dir) => {
    const path = join(dir, 'capture-session.json');
    const session = JSON.parse(readFileSync(path, 'utf8'));
    session.dependencyProvenance.packages = session.dependencyProvenance.packages.map((pkg) =>
      (pkg.name === '@google/generative-ai' ? { ...pkg, lockedVersion: '0.24.9', installedVersion: '0.24.9' } : pkg));
    writeFileSync(path, canonical(session));
  });
  assert.ok(someFailureMatches(result, '35d'), failedIds(result).join(', '));
});

await check('E: CAPTURE-2 evidence stays verifiable and is never judged on transport provenance', () => {
  // Wave 1 and Wave 2 predate the field. Their silence must not be read as a policy, in
  // either direction: not as compliance, and not as a failure.
  for (const [label, root, budget] of [
    ['wave-1', waveOutputRoot(1), waveCallBudget(['S1', 'E1', 'I1'])],
    ['wave-2', waveOutputRoot(2), waveCallBudget(['S2', 'E2', 'I2'])],
  ]) {
    const session = JSON.parse(readFileSync(join(root, 'capture-session.json'), 'utf8'));
    assert.equal(session.captureVersion, 'M2B-REAL-ROUND1-CAPTURE-2', label);
    assert.equal(session.transportRetryPolicy, undefined, `${label} never recorded one`);
    const result = verifyAt(root, budget);
    for (const failure of result.failures) {
      assert.ok(!String(failure.id).includes('/34'), `${label}: ${failure.id} must not judge CAPTURE-2 on transport`);
      assert.ok(!String(failure.id).startsWith('35'), `${label}: ${failure.id} must not judge CAPTURE-2 on dependencies`);
    }
    // The only failures are the eligibility gates the run legitimately failed.
    assert.ok(result.failures.every((f) => /\/(10b|12b)$/.test(String(f.id))), failedIds(result).join(', '));
  }
});

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

await check('R2 preserves its historical Option 3-prime allocation provenance', () => {
  assert.deepEqual(HISTORICAL_PROVIDER_ALLOCATION['fxr-05'], { provider: 'openai', model: 'gpt-5' });
  assert.deepEqual(HISTORICAL_PROVIDER_ALLOCATION['fxr-06'], { provider: 'claude', model: 'claude-sonnet-5' });
  assert.deepEqual(HISTORICAL_PROVIDER_ALLOCATION['fxr-07'], { provider: 'gemini', model: 'gemini-3.1-pro-preview' });
  assert.deepEqual(HISTORICAL_PROVIDER_ALLOCATION['fxr-08'], { provider: 'openai', model: 'gpt-5' });
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
  assert.equal(result.checks.length, 180);
  assert.equal(result.checks.length - result.failures.length, 174);
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

await check('R3 preserves its historical positive provider rotation provenance', () => {
  assert.deepEqual(HISTORICAL_PROVIDER_ALLOCATION['fxr-09'], { provider: 'openai', model: 'gpt-5' });
  assert.deepEqual(HISTORICAL_PROVIDER_ALLOCATION['fxr-10'], { provider: 'claude', model: 'claude-sonnet-5' });
  assert.deepEqual(HISTORICAL_PROVIDER_ALLOCATION['fxr-11'], { provider: 'gemini', model: 'gemini-3.1-pro-preview' });
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
  assert.equal(result.checks.length, 180);
  assert.equal(result.checks.length - result.failures.length, 178);
});

await check('the R3 capture remains 149 of 149 with no reinterpreted provenance', () => {
  const result = verifyAt(CANDIDATE_SETS.R3.realRoot, CANDIDATE_SETS.R3.globalCallBudget);
  assert.deepEqual(failedIds(result), []);
  assert.equal(result.checks.length, 149);
});

console.log('\nCWP-4A evidence binding');

function copyWave(name) {
  const root = join(SCRATCH, `binding-${name}`);
  cpSync(P03_WAVE1_ROOT, root, { recursive: true });
  return root;
}
function editJournal(root, mutate) {
  const path = join(root, 'journal.ndjson');
  const records = readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
  mutate(records);
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
const verifyWave = (root) => verifyAt(root, 12, P03_WAVE1_SLOTS);

await check('journal content tampering fails 25b with count and sequence preserved', () => {
  const root = copyWave('content');
  editJournal(root, (records) => { records[0].prompt += ' altered'; });
  assert.deepEqual(failedIds(verifyWave(root)), ['25b']);
});

await check('journal physical order and object key order do not affect content binding', () => {
  const root = copyWave('physical-order');
  editJournal(root, (records) => {
    records.reverse();
    records[0] = Object.fromEntries(Object.entries(records[0]).reverse());
  });
  assert.deepEqual(failedIds(verifyWave(root)), []);
});

for (const [name, mutate] of [
  ['duplicate', (r) => { r[1].seq = r[0].seq; }],
  ['invalid', (r) => { r[0].seq = '1'; }],
  ['gap', (r) => { r[0].seq = 99; }],
  ['raw-only', (r) => { r.pop(); }],
  ['journal-only', (r) => { r.push({ ...r[0], seq: r.length + 1 }); }],
]) {
  await check(`journal ${name} breaks one-to-one binding`, () => {
    const root = copyWave(name);
    editJournal(root, mutate);
    assert.ok(failedIds(verifyWave(root)).includes('25b'));
  });
}

await check('same candidate set reordered fails only the wave-order guard', () => {
  const root = copyWave('reordered');
  editJson(join(root, 'capture-session.json'), (s) => { s.attempts.reverse(); });
  assert.deepEqual(failedIds(verifyWave(root)), ['7c']);
});

await check('unauthorized candidate insertion fails wave-order guard', () => {
  const root = copyWave('unauthorized');
  cpSync(join(P03_HISTORY_ROOT, 'wave-2', 'E2'), join(root, 'E2'), { recursive: true });
  editJson(join(root, 'capture-session.json'), (s) => { s.attempts.push({ fixtureId: 'E2' }); });
  assert.ok(failedIds(verifyWave(root)).includes('7c'));
});

await check('an actual runtime early stop retains its ordered prefix', async () => {
  const run = await stubSession('binding-actual-stop', {}, { globalBudget: 6 });
  const result = verifyAt(run.realRoot, 6, [...REAL_FIXTURE_IDS]);
  assert.equal(result.checks.find((c) => c.id === '7c').ok, true);
  assert.equal(result.checks.find((c) => c.id === '25b').ok, true);
  assert.deepEqual(failedIds(result), [
    'fxr-02/12b', 'fxr-02/13b',
    ...['market_researcher', 'brand_creative'].flatMap((id) =>
      ['15', '15b', '16b', '17', '18', '19', '19b'].map((n) => `fxr-02/${n}:${id}`)),
  ], 'preserve existing diagnostics for workers refused before dispatch');
});

for (const included of [true, false]) {
  await check(`P03 early-stop order accepts violating fixture ${included ? 'included' : 'not yet in attempts'}`, () => {
    const root = copyWave(`prefix-${included}`);
    editJson(join(root, 'capture-session.json'), (s) => {
      s.attempts = s.attempts.slice(0, included ? 2 : 1);
      s.roundEndingViolation = { fixtureId: 'E1', code: 'CALL_BUDGET_EXCEEDED' };
    });
    const result = verifyWave(root);
    assert.equal(result.checks.find((c) => c.id === '7c').ok, true);
    // Missing raw-call evidence must still fail binding, even for an ordered prefix.
    assert.ok(failedIds(result).includes('25b'));
  });
}

for (const [name, mutate] of [
  ['incomplete without violation', (s) => { s.attempts.pop(); }],
  ['skipped earlier slot', (s) => { s.attempts.shift(); s.roundEndingViolation = { fixtureId: 'I1', code: 'CALL_BUDGET_EXCEEDED' }; }],
  ['unknown violation', (s) => { s.attempts.pop(); s.roundEndingViolation = { fixtureId: 'E1', code: 'FAKE' }; }],
  ['violation at skipped slot', (s) => { s.attempts = []; s.roundEndingViolation = { fixtureId: 'E1', code: 'CALL_BUDGET_EXCEEDED' }; }],
]) {
  await check(`wave-order rejects ${name}`, () => {
    const root = copyWave(name);
    editJson(join(root, 'capture-session.json'), mutate);
    assert.ok(failedIds(verifyWave(root)).includes('7c'));
  });
}

rmSync(SCRATCH, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
