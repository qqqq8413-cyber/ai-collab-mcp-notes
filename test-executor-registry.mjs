import assert from 'node:assert/strict';
import { createExecutorRegistry } from './dist/execution/registry.js';
import { resolveProviderBinding } from './dist/execution/executors.js';
import { executionRequestFingerprint } from './dist/execution/fingerprint.js';

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`  PASS ${name}`); }
const executor = (provider = 'openai', execute = async () => {}) => ({ kind: 'MODEL_PROVIDER', provider, execute });
const registration = (id = 'openai-main', provider = 'openai', mechanism = executor(provider)) =>
  ({ kind: 'MODEL_PROVIDER', executorId: id, provider, executor: mechanism });
function input(executorId = 'openai-main') {
  const request = { executionId: 'execution-1', attemptId: 'attempt-1', provider: 'openai',
    requestedModel: 'model-A', input: 'offline', parameters: {} };
  const binding = resolveProviderBinding(request, 'unused');
  const authorization = { admissionId: 'admission-1', executionId: request.executionId,
    attemptId: request.attemptId, provider: 'openai', effectiveModel: binding.effectiveModel,
    requestFingerprint: executionRequestFingerprint(request, binding), executorId };
  return { request, binding, authorization };
}

await check('all four kinds register exact identity; future kinds have no execute', () => {
  const registry = createExecutorRegistry([
    registration(), { kind: 'MCP', executorId: 'mcp-one' },
    { kind: 'CLI_AGENT', executorId: 'cli-one' }, { kind: 'REMOTE_AGENT', executorId: 'remote-one' },
  ]);
  assert.equal(registry.list().length, 4);
  assert.deepEqual(registry.get('MCP', 'mcp-one'), { kind: 'MCP', executorId: 'mcp-one' });
  assert.equal(Object.hasOwn(registry.get('MCP', 'mcp-one'), 'execute'), false);
  assert.equal(registry.get('MODEL_PROVIDER', 'mcp-one'), undefined);
  assert.equal(registry.get('MCP', 'openai-main'), undefined);
  assert.equal(registry.resolveModelProvider('openai').executorId, 'openai-main');
  assert.equal(registry.resolveModelProvider('claude'), undefined);
});
await check('duplicate id and duplicate provider fail construction', () => {
  assert.throws(() => createExecutorRegistry([registration(), { kind: 'MCP', executorId: 'openai-main' }]), /Duplicate executorId/);
  assert.throws(() => createExecutorRegistry([registration(), registration('second-openai')]), /Duplicate MODEL_PROVIDER/);
});
await check('registration shape, kind, id, provider, and executor mismatches fail', () => {
  for (const registrations of [
    [{ kind: 'UNKNOWN', executorId: 'x' }], [{ kind: 'MCP', executorId: '' }],
    [{ kind: 'MCP', executorId: 'x', execute() {} }],
    [registration('x', 'openai', executor('gemini'))],
    [registration('x', 'openai', { kind: 'MCP', provider: 'openai', execute() {} })],
    [registration('x', 'unknown', executor('unknown'))],
    [null], [,],
  ]) assert.throws(() => createExecutorRegistry(registrations));
  const accessor = { kind: 'MCP', executorId: 'x' };
  Object.defineProperty(accessor, 'executorId', { get() { return 'x'; } });
  assert.throws(() => createExecutorRegistry([accessor]), /data fields/);
});
await check('inherited names never appear without exact registration', () => {
  const registry = createExecutorRegistry([{ kind: 'MCP', executorId: 'own' }]);
  for (const id of ['constructor', 'toString', '__proto__']) assert.equal(registry.get('MCP', id), undefined);
  assert.deepEqual(createExecutorRegistry([{ kind: 'MCP', executorId: '__proto__' }]).get('MCP', '__proto__'),
    { kind: 'MCP', executorId: '__proto__' });
});
await check('input, executor identity, returned descriptors, and list cannot mutate registry', async () => {
  let executed = 0;
  const mechanism = executor('openai', async () => { executed++; return { outcome: 'SUCCESS' }; });
  const item = registration('original', 'openai', mechanism);
  const registrations = [item];
  const registry = createExecutorRegistry(registrations);
  item.provider = 'gemini'; item.executorId = 'changed';
  mechanism.provider = 'gemini'; mechanism.kind = 'MCP';
  mechanism.execute = async () => { throw Error('replacement'); };
  registrations.push(registration('later', 'claude', executor('claude')));
  const descriptor = registry.get('MODEL_PROVIDER', 'original');
  descriptor.executorId = 'tampered'; descriptor.provider = 'claude';
  const list = registry.list(); list[0].executorId = 'tampered'; list.push({ kind: 'MCP', executorId: 'new' });
  assert.deepEqual(registry.get('MODEL_PROVIDER', 'original'), { kind: 'MODEL_PROVIDER', executorId: 'original', provider: 'openai' });
  assert.equal(registry.get('MODEL_PROVIDER', 'changed'), undefined);
  assert.equal(registry.get('MCP', 'new'), undefined);
  assert.equal(registry.resolveModelProvider('gemini'), undefined);
  await registry.resolveModelProvider('openai').execute(input('original'));
  assert.equal(executed, 1);
});
await check('authorization for mechanism A cannot run through B, even for same provider/model', async () => {
  let transports = 0;
  const execute = async () => { transports++; return { outcome: 'SUCCESS' }; };
  const a = createExecutorRegistry([registration('executor-A', 'openai', executor('openai', execute))]);
  const b = createExecutorRegistry([registration('executor-B', 'openai', executor('openai', execute))]);
  const authorizationA = input('executor-A');
  assert.throws(() => b.resolveModelProvider('openai').execute(authorizationA), /registered executor/);
  assert.equal(transports, 0);
  assert.throws(() => a.resolveModelProvider('openai').execute({ ...authorizationA,
    request: { ...authorizationA.request, provider: 'gemini' } }), /registered executor/);
  assert.equal(transports, 0);
  await a.resolveModelProvider('openai').execute(authorizationA);
  assert.equal(transports, 1);
});
await check('captured mechanism stays A across an async barrier and caller mutations', async () => {
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const enteredGate = new Promise((resolve) => { entered = resolve; });
  let a = 0, b = 0;
  const mechanism = executor('openai', async (fixed) => {
    a++; entered(); await gate;
    assert.equal(fixed.request.input, 'original prompt');
    assert.equal(fixed.authorization.executorId, 'stable');
    return { outcome: 'SUCCESS' };
  });
  const item = registration('stable', 'openai', mechanism);
  const source = [item];
  const registry = createExecutorRegistry(source);
  const caller = input('stable'); caller.request.input = 'original prompt';
  caller.authorization.requestFingerprint = executionRequestFingerprint(caller.request, caller.binding);
  const pending = registry.resolveModelProvider('openai').execute(caller);
  await enteredGate;
  item.provider = 'gemini'; mechanism.provider = 'gemini';
  mechanism.execute = async () => { b++; return { outcome: 'SUCCESS' }; };
  source.splice(0, 1, registration('replacement', 'gemini', executor('gemini')));
  caller.request.input = 'mutated prompt';
  release(); await pending;
  assert.equal(a, 1); assert.equal(b, 0);
  assert.equal(registry.resolveModelProvider('openai').executorId, 'stable');
  assert.equal(registry.resolveModelProvider('gemini'), undefined);
});

console.log(`${passed} passed, 0 failed`);
