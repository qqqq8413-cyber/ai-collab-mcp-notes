import assert from 'node:assert/strict';
import { createExecutionBoundary } from './dist/execution/boundary.js';
import { createOpenAIExecutor, resolveProviderBinding } from './dist/execution/executors.js';
import { executionRequestFingerprint } from './dist/execution/fingerprint.js';
import { createD1ExecutionAuthority } from './dist/stress-test/execution-authority.js';
import {
  createSession, freezeInput, addFinding, createSemanticIssue, createDeliberationState,
  createUnresolvedQuestion, registerUnresolvedQuestion, planRouteForQuestion,
  recordRouteDecision, recordRouteAttemptStart, createInMemoryRouteExecutionCheckpointStore,
  createInMemoryDeliberationStateAccessPort, createStaticLiveExecutionPolicyResolver,
} from './dist/stress-test/index.js';

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`  PASS ${name}`); }
const executeAtBoundary = (request, deps) => createExecutionBoundary(deps).execute(request);
const request = (overrides = {}) => ({ executionId: 'execution-1', attemptId: 'attempt-1', provider: 'openai',
  requestedModel: 'synthetic-model', input: 'offline', parameters: {}, ...overrides });
const capability = (readiness = 'VERIFIED') => ({ providerSupport: 'SUPPORTED', runtimeEnablement: 'ENABLED', readiness,
  evidence: [{ source: 'synthetic' }] });
function source(options = {}) {
  return {
    getModelProfile: (provider, model) => options.unknownModel
      ? { status: 'UNKNOWN_MODEL', provider, model } : { status: 'FOUND', profile: { provider, model } },
    getCapabilityAssessment: () => ({ status: 'FOUND', assessment: options.capability ?? capability() }),
    getParameterAssessment: () => ({ status: 'FOUND', assessment: { readiness: 'VERIFIED',
      constraint: { kind: 'FIXED', value: 0, explicitTransmission: 'ALLOWED' }, evidence: [] } }),
  };
}
const claimed = (attemptId) => ({ kind: 'CLAIMED', attemptId,
  checkpoint: { phase: 'CLAIMED', attemptId, latencyLimitMs: 50, reservedLatencyMs: 50 } });
const terminal = (attemptId) => ({ kind: 'PRE_CALL_TERMINAL', attemptId,
  checkpoint: { phase: 'TERMINAL_FACT_READY', attemptId, reservedLatencyMs: 0,
    terminalFact: { kind: 'FAILED', actualLatencyMs: 0 } } });
function harness(options = {}) {
  const calls = { claim: 0, execute: 0, default: 0, inputs: [] };
  const authority = options.authority ?? { claim(attemptId) { calls.claim++; return claimed(attemptId); } };
  const executor = options.executor ?? { kind: 'MODEL_PROVIDER', provider: options.executorProvider ?? 'openai',
    async execute(input) {
      calls.execute++; calls.inputs.push(input);
      return options.result ?? { outcome: 'SUCCESS', executionId: input.request.executionId,
        attemptId: input.request.attemptId, requestedProvider: input.request.provider,
        requestedModel: input.request.requestedModel, effectiveProvider: input.binding.provider,
        effectiveModel: input.binding.effectiveModel, output: { text: 'answer' } };
    } };
  let tick = 100;
  return { calls, deps: { executor, authority, capabilitySource: options.capabilitySource ?? source(),
    defaultModelResolver: { resolveDefaultModel(provider) { calls.default++; assert.equal(provider, 'openai'); return options.defaultModel; } },
    monotonicNow: () => { const current = tick; tick += 7; return current; } } };
}

await check('invalid input and executor mismatch stop before authority or provider', async () => {
  const hidden = request(); Object.defineProperty(hidden, 'extra', { value: 1 });
  const prototypeKey = request(); Object.defineProperty(prototypeKey, '__proto__', { value: { injected: true }, enumerable: true });
  const symbol = request(); symbol[Symbol('extra')] = 1;
  const accessor = request(); Object.defineProperty(accessor, 'input', { get() { throw Error('must not run'); } });
  for (const malformed of [{ ...request(), extra: 1 }, { ...request(), parameters: { temperature: { value: NaN } } },
    hidden, prototypeKey, symbol, accessor]) {
    const h = harness(); await assert.rejects(() => executeAtBoundary(malformed, h.deps), TypeError);
    assert.equal(h.calls.claim, 0); assert.equal(h.calls.execute, 0);
  }
  const h = harness({ executorProvider: 'gemini' });
  await assert.rejects(() => executeAtBoundary(request(), h.deps), /Executor/);
  assert.equal(h.calls.claim, 0);
});
await check('explicit model exact; absent model uses composition default', async () => {
  const explicit = harness({ defaultModel: 'different-model' });
  const first = await executeAtBoundary(request(), explicit.deps);
  assert.equal(first.kind, 'EXECUTED'); assert.equal(first.binding.effectiveModel, 'synthetic-model');
  assert.equal(explicit.calls.default, 0);
  const fallback = harness({ defaultModel: 'configured-model' });
  const implicitRequest = request(); delete implicitRequest.requestedModel;
  const second = await executeAtBoundary(implicitRequest, fallback.deps);
  assert.equal(second.kind, 'EXECUTED'); assert.equal(second.binding.effectiveModel, 'configured-model');
  assert.equal(second.binding.resolutionBasis, 'DEFAULT'); assert.equal(fallback.calls.default, 1);
  const missing = harness();
  const third = await executeAtBoundary(implicitRequest, missing.deps);
  assert.equal(third.kind, 'NOT_ADMITTED'); assert.equal(missing.calls.claim, 0);
});
await check('unknown model and unverified capability never claim', async () => {
  const unknown = harness({ capabilitySource: source({ unknownModel: true }) });
  const first = await executeAtBoundary(request(), unknown.deps);
  assert.equal(first.kind, 'NOT_ADMITTED'); assert.equal(first.admission.status, 'UNRESOLVED');
  assert.equal(unknown.calls.claim, 0); assert.equal(unknown.calls.execute, 0);
  const wired = harness({ capabilitySource: source({ capability: capability('WIRED_UNVERIFIED') }) });
  const second = await executeAtBoundary(request({ systemInstruction: 'role' }), wired.deps);
  assert.equal(second.admission.status, 'UNRESOLVED'); assert.equal(wired.calls.claim, 0);
});
await check('known local rejection and unknown explicit parameter do not reserve D1 budget', async () => {
  const rejected = harness({ capabilitySource: source({ capability: {
    providerSupport: 'UNSUPPORTED', runtimeEnablement: 'DISABLED', readiness: 'UNSUPPORTED', evidence: [],
  } }) });
  const first = await executeAtBoundary(request({ systemInstruction: 'role' }), rejected.deps);
  assert.equal(first.admission.status, 'REJECTED'); assert.equal(rejected.calls.claim, 0); assert.equal(rejected.calls.execute, 0);
  const unknown = harness();
  unknown.deps.capabilitySource.getParameterAssessment = () => ({ status: 'MISSING_ASSESSMENT', provider: 'openai', model: 'synthetic-model' });
  const second = await executeAtBoundary(request({ parameters: { temperature: { value: 0 } } }), unknown.deps);
  assert.equal(second.admission.status, 'UNRESOLVED'); assert.equal(second.admission.parameters[0].disposition, 'UNKNOWN');
  assert.equal(unknown.calls.claim, 0); assert.equal(unknown.calls.execute, 0);
});
await check('authority refusal propagates without execution', async () => {
  const h = harness({ authority: { claim() { throw Error('policy denied'); } } });
  await assert.rejects(() => executeAtBoundary(request(), h.deps), /policy denied/);
  assert.equal(h.calls.execute, 0);
});
await check('canonical H1 Claude temperature is UNKNOWN with zero claim/calls', async () => {
  const h = harness(); h.deps.executor.provider = 'claude';
  delete h.deps.capabilitySource;
  const outcome = await executeAtBoundary(request({ provider: 'claude', requestedModel: 'claude-sonnet-5',
    parameters: { temperature: { value: 0 } } }), h.deps);
  assert.equal(outcome.kind, 'NOT_ADMITTED'); assert.equal(outcome.admission.status, 'UNRESOLVED');
  assert.equal(outcome.admission.parameters[0].disposition, 'UNKNOWN');
  assert.equal(h.calls.claim, 0); assert.equal(h.calls.execute, 0);
});
await check('pre-call terminal creates no authorization and does not execute', async () => {
  let original;
  const h = harness({ authority: { claim(attemptId) { original = terminal(attemptId); return original; } } });
  const outcome = await executeAtBoundary(request(), h.deps);
  assert.equal(outcome.kind, 'PRE_CALL_TERMINAL'); assert.equal(h.calls.execute, 0);
  assert.equal(Object.hasOwn(outcome, 'authorization'), false);
  original.checkpoint.terminalFact.kind = 'SUCCEEDED';
  assert.equal(outcome.checkpoint.terminalFact.kind, 'FAILED');
});
await check('claim mints one bound authorization; measured latency and success stay execution facts', async () => {
  const h = harness();
  const outcome = await executeAtBoundary(request(), h.deps);
  assert.equal(outcome.kind, 'EXECUTED'); assert.equal(outcome.executionLatencyMs, 7);
  assert.equal(h.calls.claim, 1); assert.equal(h.calls.execute, 1);
  assert.equal(outcome.result.outcome, 'SUCCESS');
  assert.equal(Object.hasOwn(outcome, 'routeOutcome'), false);
  assert.equal(Object.hasOwn(outcome, 'humanAdjudication'), false);
  const input = h.calls.inputs[0];
  assert.equal(input.authorization.executionId, input.request.executionId);
  assert.equal(input.authorization.attemptId, input.request.attemptId);
  assert.equal(input.authorization.provider, input.binding.provider);
  assert.equal(input.authorization.effectiveModel, input.binding.effectiveModel);
  assert.equal(input.authorization.requestFingerprint, executionRequestFingerprint(input.request, input.binding));
  assert.ok(input.authorization.admissionId);
  const again = await executeAtBoundary(request(), h.deps);
  assert.notEqual(input.authorization.admissionId, h.calls.inputs[1].authorization.admissionId);
  assert.equal(again.kind, 'EXECUTED');
});
await check('admitted boundary dispatches one fake transport through the real executor', async () => {
  let transports = 0;
  const executor = createOpenAIExecutor(async (_prompt, options) => {
    transports++;
    return { outcome: 'SUCCESS', result: { provider: 'openai', model: options.model, text: 'offline answer' } };
  });
  const h = harness({ executor });
  const outcome = await executeAtBoundary(request(), h.deps);
  assert.equal(outcome.kind, 'EXECUTED'); assert.equal(outcome.result.outcome, 'SUCCESS');
  assert.equal(outcome.result.output.text, 'offline answer'); assert.equal(transports, 1);
});
await check('caller and dependency mutations cannot rewrite recorded facts', async () => {
  const req = request({ parameters: { temperature: { value: 0 } } });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = harness();
  let entered;
  const entering = new Promise((resolve) => { entered = resolve; });
  let mutableResult;
  h.deps.executor.execute = async (input) => {
    h.calls.execute++; h.calls.inputs.push(input); entered(); await gate;
    mutableResult = { outcome: 'SUCCESS', executionId: input.request.executionId, attemptId: input.request.attemptId,
      requestedProvider: input.request.provider, requestedModel: input.request.requestedModel,
      effectiveProvider: input.binding.provider, effectiveModel: input.binding.effectiveModel, output: { text: 'answer' } };
    return mutableResult;
  };
  const pending = executeAtBoundary(req, h.deps);
  await entering;
  req.executionId = 'changed'; req.parameters.temperature.value = 4;
  const outcome = await (release(), pending);
  mutableResult.output.text = 'changed';
  assert.equal(outcome.result.executionId, 'execution-1'); assert.equal(outcome.result.output.text, 'answer');
  assert.equal(outcome.admission.parameters[0].effectiveValue, 0);
});
await check('KNOWN_FAILURE, UNCERTAIN and thrown executor outcome never retry', async () => {
  for (const state of ['KNOWN_FAILURE', 'UNCERTAIN']) {
    const h = harness(); h.deps.executor.execute = async (input) => {
      h.calls.execute++; return { outcome: state, executionId: input.request.executionId, attemptId: input.request.attemptId,
        requestedProvider: input.request.provider, requestedModel: input.request.requestedModel,
        effectiveProvider: input.binding.provider, effectiveModel: input.binding.effectiveModel,
        error: { provider: 'openai', model: input.binding.effectiveModel, category: 'TRANSPORT', message: 'offline',
          dispatchState: 'UNKNOWN', completionState: state === 'KNOWN_FAILURE' ? 'FAILED' : 'UNKNOWN' } };
    };
    const outcome = await executeAtBoundary(request(), h.deps);
    assert.equal(outcome.result.outcome, state); assert.equal(h.calls.execute, 1);
  }
  const thrown = harness(); thrown.deps.executor.execute = async () => { thrown.calls.execute++; throw Error('unknown'); };
  await assert.rejects(() => executeAtBoundary(request(), thrown.deps), /unknown/);
  assert.equal(thrown.calls.execute, 1);
});
await check('executor rejects stale authorization before fake transport', async () => {
  let calls = 0;
  const executor = createOpenAIExecutor(async () => { calls++; throw Error('should not dispatch'); });
  const req = request(); const binding = resolveProviderBinding(req, '');
  const authorization = { admissionId: 'a', executionId: req.executionId, attemptId: req.attemptId,
    provider: req.provider, effectiveModel: binding.effectiveModel,
    requestFingerprint: executionRequestFingerprint(req, binding) };
  for (const stale of [
    { request: { ...req, input: 'different' }, binding, authorization },
    { request: req, binding, authorization: { ...authorization, executionId: 'different' } },
    { request: req, binding, authorization: { ...authorization, attemptId: 'different' } },
    { request: req, binding, authorization: { ...authorization, provider: 'gemini' } },
    { request: req, binding, authorization: { ...authorization, effectiveModel: 'different' } },
  ]) await assert.rejects(() => executor.execute(stale), TypeError);
  assert.equal(calls, 0);
});

function d1Fixture(rootCause = 'STABILITY_QUESTION', latencyCeiling = 100, policy = { status: 'ENABLED', latencyLimitMs: 50 }) {
  let session = freezeInput(createSession('Fictional migration memo.'));
  session = addFinding(session, { reviewerRunId: 'synthetic-run', type: 'EXECUTION_RISK', title: 'Timeline',
    artifactLocation: 'paragraph 1', evidenceState: 'UNSUPPORTED_IN_MATERIAL', whyMaterial: 'Unverified timing',
    likelyRecipientChallenge: 'How is timing supported?', minimumBeforeSendAction: 'Verify timeline' });
  session = createSemanticIssue(session, { title: 'Timeline', description: 'Timing remains unverified',
    findingIds: Object.keys(session.findings), evidenceState: 'UNSUPPORTED_IN_MATERIAL' });
  let state = createDeliberationState(session, { costCeiling: 50, latencyCeiling });
  const question = createUnresolvedQuestion(session, { rootCause, materialityReason: 'Material unresolved timeline',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: Object.keys(session.semanticIssues)[0] }] });
  state = registerUnresolvedQuestion(session, state, question);
  const decision = planRouteForQuestion(session, state, question);
  state = recordRouteDecision(session, state, decision);
  state = recordRouteAttemptStart(session, state, decision.id);
  const attemptId = state.attempts[0].attemptId;
  const store = createInMemoryRouteExecutionCheckpointStore();
  const access = createInMemoryDeliberationStateAccessPort(state);
  const authority = createD1ExecutionAuthority(session, state, store, access, createStaticLiveExecutionPolicyResolver(policy));
  const h = harness({ authority });
  return { ...h, attemptId, store, state };
}
await check('actual D1-A claims one machine attempt and rejects second claim', async () => {
  const h = d1Fixture(); const req = request({ attemptId: h.attemptId });
  const outcome = await executeAtBoundary(req, h.deps);
  assert.equal(outcome.kind, 'EXECUTED'); assert.equal(h.store.getCheckpoint(h.attemptId).phase, 'CLAIMED');
  await assert.rejects(() => executeAtBoundary(req, h.deps), /not repeatable|already has an execution checkpoint/);
  assert.equal(h.calls.execute, 1);
});
await check('actual D1-A DISABLED and non-machine route refuse execution', async () => {
  const disabled = d1Fixture('STABILITY_QUESTION', 100, { status: 'DISABLED' });
  await assert.rejects(() => executeAtBoundary(request({ attemptId: disabled.attemptId }), disabled.deps), /DISABLED/);
  assert.equal(disabled.calls.execute, 0);
  const nonMachine = d1Fixture('CONTEXT_GAP');
  await assert.rejects(() => executeAtBoundary(request({ attemptId: nonMachine.attemptId }), nonMachine.deps));
  assert.equal(nonMachine.calls.execute, 0);
});
await check('actual D1-A malformed and over-budget latency produce canonical pre-call terminal', async () => {
  for (const [ceiling, policy] of [[100, { status: 'ENABLED', latencyLimitMs: undefined }],
    [20, { status: 'ENABLED', latencyLimitMs: 50 }]]) {
    const h = d1Fixture('STABILITY_QUESTION', ceiling, policy);
    const outcome = await executeAtBoundary(request({ attemptId: h.attemptId }), h.deps);
    assert.equal(outcome.kind, 'PRE_CALL_TERMINAL'); assert.equal(h.calls.execute, 0);
    assert.equal(h.store.getCheckpoint(h.attemptId).phase, 'TERMINAL_FACT_READY');
  }
});
console.log(`${passed} passed, 0 failed`);
