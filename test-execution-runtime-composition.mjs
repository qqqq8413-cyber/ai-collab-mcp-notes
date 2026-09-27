import assert from 'node:assert/strict';
import { PROVIDERS } from './dist/config.js';
import { createExecutionBoundary } from './dist/execution/boundary.js';
import { createExecutorRegistry } from './dist/execution/registry.js';
import { createConfiguredDefaultModelResolver, createDefaultProviderRegistry, createExecutionRuntime } from './dist/execution/runtime.js';

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`  PASS ${name}`); }
const request = (overrides = {}) => ({ executionId: 'e', attemptId: 'a', provider: 'openai',
  requestedModel: 'synthetic', input: 'offline', parameters: {}, ...overrides });
const source = (readiness = 'VERIFIED') => ({
  getModelProfile: (provider, model) => ({ status: 'FOUND', profile: { provider, model } }),
  getCapabilityAssessment: () => ({ status: 'FOUND', assessment: { providerSupport: 'SUPPORTED', runtimeEnablement: 'ENABLED',
    readiness, evidence: [] } }),
  getParameterAssessment: () => ({ status: 'MISSING_ASSESSMENT', provider: 'openai', model: 'synthetic' }),
});
function fixture(provider = 'openai', executorId = 'mechanism') {
  const calls = { claim: 0, execute: 0, inputs: [] };
  const executor = { kind: 'MODEL_PROVIDER', provider, async execute(input) {
    calls.execute++; calls.inputs.push(input);
    return { outcome: 'SUCCESS', executionId: input.request.executionId, attemptId: input.request.attemptId,
      requestedProvider: input.request.provider, requestedModel: input.request.requestedModel,
      effectiveProvider: input.binding.provider, effectiveModel: input.binding.effectiveModel, output: { text: 'offline' } };
  } };
  const registry = createExecutorRegistry([{ kind: 'MODEL_PROVIDER', executorId, provider, executor }]);
  const authority = { claim(attemptId) { calls.claim++; return { kind: 'CLAIMED', attemptId,
    checkpoint: { phase: 'CLAIMED', attemptId, latencyLimitMs: 50, reservedLatencyMs: 50 } }; } };
  return { calls, registry, authority };
}

await check('boundary rejects caller-built registry lookalikes', () => {
  const f = fixture();
  assert.throws(() => createExecutionBoundary({ registry: { ...f.registry }, authority: f.authority,
    defaultModelResolver: { resolveDefaultModel: () => 'synthetic' } }), /ExecutorRegistry/);
});
await check('configured defaults and runtime resolver are composition snapshots', async () => {
  const original = PROVIDERS.openai.defaultModel;
  const configured = createConfiguredDefaultModelResolver();
  PROVIDERS.openai.defaultModel = 'changed-after-snapshot';
  assert.equal(configured.resolveDefaultModel('openai'), original);
  PROVIDERS.openai.defaultModel = original;
  const f = fixture();
  const mutable = { resolveDefaultModel: () => 'selected-at-composition' };
  const runtime = createExecutionRuntime({ ...f, defaultModelResolver: mutable, capabilitySource: source() });
  mutable.resolveDefaultModel = () => 'changed-later';
  const req = request(); delete req.requestedModel;
  const result = await runtime.execute(req);
  assert.equal(result.kind, 'EXECUTED'); assert.equal(result.binding.effectiveModel, 'selected-at-composition');
  assert.equal(f.calls.inputs[0].authorization.executorId, 'mechanism');
});
await check('default registry constructs three exact mechanisms without a provider call', () => {
  const registry = createDefaultProviderRegistry();
  assert.deepEqual(registry.list().map((item) => item.provider).sort(), ['claude', 'gemini', 'openai']);
  assert.equal(registry.resolveModelProvider('openai').executorId, 'model-provider:openai');
  assert.equal(registry.get('MCP', 'model-provider:openai'), undefined);
});
await check('missing OpenAI mechanism is distinct from admission and never falls back to Gemini', async () => {
  const f = fixture('gemini', 'gemini-only');
  const runtime = createExecutionRuntime({ ...f, capabilitySource: source() });
  const result = await runtime.execute(request());
  assert.equal(result.kind, 'EXECUTOR_UNAVAILABLE'); assert.equal(result.admission.status, 'ADMITTED');
  assert.equal(result.provider, 'openai'); assert.equal(f.calls.claim, 0); assert.equal(f.calls.execute, 0);
});
await check('unresolved and unsupported local admission never reach registry execution or D1', async () => {
  for (const readiness of ['WIRED_UNVERIFIED', 'UNKNOWN', 'UNSUPPORTED']) {
    const f = fixture();
    const result = await createExecutionRuntime({ ...f, capabilitySource: source(readiness) })
      .execute(request({ systemInstruction: 'role' }));
    assert.equal(result.kind, 'NOT_ADMITTED');
    assert.equal(result.admission.status, readiness === 'UNSUPPORTED' ? 'REJECTED' : 'UNRESOLVED');
    assert.equal(f.calls.claim, 0); assert.equal(f.calls.execute, 0);
  }
});
await check('caller JSON cannot name an executor or supply a per-call mechanism', async () => {
  const f = fixture(); const runtime = createExecutionRuntime({ ...f, capabilitySource: source() });
  await assert.rejects(() => runtime.execute(request({ executorId: 'another' })), TypeError);
  await assert.rejects(() => runtime.execute(request({ executor: { execute() {} } })), TypeError);
  assert.equal(f.calls.claim, 0); assert.equal(f.calls.execute, 0);
});
await check('registered execution returns only execution facts, never product authority', async () => {
  const f = fixture();
  const result = await createExecutionRuntime({ ...f, capabilitySource: source() }).execute(request());
  assert.equal(result.kind, 'EXECUTED'); assert.equal(result.result.outcome, 'SUCCESS');
  assert.equal(f.calls.claim, 1); assert.equal(f.calls.execute, 1);
  for (const key of ['routeOutcome', 'humanAdjudication', 'revisionAction', 'decisionRecord', 'questionDisposition']) {
    assert.equal(Object.hasOwn(result, key), false);
  }
});
await check('after D1 claim, async caller mutations cannot swap the captured mechanism', async () => {
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const atTransport = new Promise((resolve) => { entered = resolve; });
  let a = 0, b = 0, claims = 0;
  const mechanism = { kind: 'MODEL_PROVIDER', provider: 'openai', async execute(input) {
    a++; entered(); await gate;
    return { outcome: 'SUCCESS', executionId: input.request.executionId, attemptId: input.request.attemptId,
      requestedProvider: input.request.provider, requestedModel: input.request.requestedModel,
      effectiveProvider: input.binding.provider, effectiveModel: input.binding.effectiveModel, output: { text: 'A' } };
  } };
  const item = { kind: 'MODEL_PROVIDER', executorId: 'mechanism-A', provider: 'openai', executor: mechanism };
  const registrations = [item];
  const registry = createExecutorRegistry(registrations);
  const authority = { claim(attemptId) { claims++; return { kind: 'CLAIMED', attemptId,
    checkpoint: { phase: 'CLAIMED', attemptId, latencyLimitMs: 50, reservedLatencyMs: 50 } }; } };
  const runtime = createExecutionRuntime({ authority, registry, capabilitySource: source() });
  const caller = request();
  const pending = runtime.execute(caller);
  await atTransport;
  item.provider = 'gemini'; item.executorId = 'mechanism-B'; mechanism.provider = 'gemini';
  mechanism.execute = async () => { b++; throw Error('B must not run'); };
  registrations.splice(0, 1); caller.input = 'changed';
  release(); const result = await pending;
  assert.equal(result.kind, 'EXECUTED'); assert.equal(result.result.output.text, 'A');
  assert.equal(result.result.effectiveProvider, 'openai');
  assert.equal(claims, 1); assert.equal(a, 1); assert.equal(b, 0);
});

console.log(`${passed} passed, 0 failed`);
