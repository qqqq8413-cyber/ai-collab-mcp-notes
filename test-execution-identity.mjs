// F02 regressions: one execution, one immutable pre-dispatch fact snapshot.
// Every transport is an in-memory fake; no provider is ever called.
import assert from 'node:assert/strict';
import {
  createClaudeExecutor,
  createOpenAIExecutor,
  createGeminiExecutor,
  resolveProviderBinding,
  snapshotExecutionInput,
} from './dist/execution/executors.js';

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (error) {
    console.log(`  FAIL ${name}: ${error.stack}`);
    failed++;
  }
}

const FACTORIES = [['claude', createClaudeExecutor], ['openai', createOpenAIExecutor], ['gemini', createGeminiExecutor]];

function request(provider, overrides = {}) {
  return {
    executionId: 'execution-1', attemptId: 'attempt-1', provider, requestedModel: 'model-A', input: 'offline prompt',
    parameters: { temperature: { value: 0.2 }, max_output_tokens: { value: 256 } },
    retrieval: { enabled: false }, systemInstruction: 'role', stage: 'round1_worker',
    origin: { runId: 'run-1', sourceRef: 'ref-1' },
    ...overrides,
  };
}
function admitted(requested, defaultModel = 'configured-default') {
  return {
    request: requested,
    binding: resolveProviderBinding(requested, defaultModel),
    authorization: { admissionId: 'admission-1', executionId: requested.executionId, attemptId: requested.attemptId },
  };
}

/**
 * A transport that parks until released. `entered` resolves once the executor
 * has dispatched; the test mutates the caller's input, then calls `release`.
 * Deterministic: no timers.
 */
function deferred(respond) {
  let enter, release;
  const entered = new Promise((resolve) => { enter = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const seen = [];
  const transport = async (prompt, options) => {
    seen.push({ prompt, options, modelAtDispatch: options.model, retrievalAtDispatch: structuredClone(options.retrieval) });
    enter();
    await gate;
    return respond(options);
  };
  return { transport, entered, release: () => release(), seen };
}
/** Waits for dispatch, failing (never hanging) if execute settles before the transport is entered. */
async function untilDispatched(pending, d) {
  const first = await Promise.race([d.entered.then(() => 'entered'), pending.then(() => 'settled', () => 'settled')]);
  if (first !== 'entered') {
    await pending;
    throw new Error('execute settled before the transport was entered');
  }
}
async function runWhilePending(create, input, respond, mutate) {
  const d = deferred(respond);
  const pending = create(d.transport).execute(input);
  await untilDispatched(pending, d);
  mutate(input, d.seen[0].options);
  d.release();
  return { result: await pending, seen: d.seen };
}
const success = (provider, model) => () => ({ outcome: 'SUCCESS', result: { provider, model, text: 'answer' } });
const failure = (outcome, provider, model) => () => ({
  outcome,
  error: { provider, model, category: outcome === 'KNOWN_FAILURE' ? 'PROVIDER_REJECTION' : 'TRANSPORT', message: 'synthetic failure',
    dispatchState: 'DISPATCHED', completionState: outcome === 'KNOWN_FAILURE' ? 'FAILED' : 'UNKNOWN' },
});
function assertIdentityA(result, provider) {
  assert.equal(result.executionId, 'execution-1');
  assert.equal(result.attemptId, 'attempt-1');
  assert.equal(result.requestedProvider, provider);
  assert.equal(result.requestedModel, 'model-A');
  assert.equal(result.effectiveProvider, provider);
  assert.equal(result.effectiveModel, 'model-A');
}
const toB = (input) => { input.binding.effectiveModel = 'model-B'; };

// ---------------------------------------------------------------- caller mutation during await
console.log('Caller mutation while the transport is pending');

await check('A: F02 reproduction -- binding mutated to B, transport returns B: fails closed, identity stays A', async () => {
  for (const [provider, create] of FACTORIES) {
    const { result, seen } = await runWhilePending(create, admitted(request(provider)), success(provider, 'model-B'), toB);
    assert.equal(seen[0].modelAtDispatch, 'model-A');
    assert.notEqual(result.outcome, 'SUCCESS', provider);
    assert.equal(result.outcome, 'UNCERTAIN');
    assert.equal(result.error.category, 'RESULT_MISMATCH');
    assert.equal(result.error.model, 'model-A');
    assertIdentityA(result, provider);
  }
});
await check('B: binding mutated to B, transport returns A: SUCCESS, identity stays A', async () => {
  for (const [provider, create] of FACTORIES) {
    const { result } = await runWhilePending(create, admitted(request(provider)), success(provider, 'model-A'), toB);
    assert.equal(result.outcome, 'SUCCESS', provider);
    assertIdentityA(result, provider);
  }
});
await check('C: binding requestedModel, resolutionBasis, and provider mutated while pending change nothing', async () => {
  for (const [provider, create] of FACTORIES) {
    const { result } = await runWhilePending(create, admitted(request(provider)), success(provider, 'model-A'), (input) => {
      input.binding.requestedModel = 'model-B';
      input.binding.resolutionBasis = 'DEFAULT';
      input.binding.provider = 'someone-else';
    });
    assert.equal(result.outcome, 'SUCCESS');
    assertIdentityA(result, provider);
  }
  const defaultInput = admitted(request('openai', { requestedModel: undefined }), 'default-model');
  const { result } = await runWhilePending(createOpenAIExecutor, defaultInput, success('openai', 'default-model'), (input) => {
    input.binding.requestedModel = 'model-B';
    input.binding.resolutionBasis = 'EXPLICIT';
    input.binding.effectiveModel = 'model-B';
  });
  assert.equal(result.outcome, 'SUCCESS');
  assert.equal(result.effectiveModel, 'default-model');
  assert.equal(Object.hasOwn(result, 'requestedModel'), false, 'a DEFAULT binding stays DEFAULT');
});
await check('D: request provider and requestedModel mutated while pending change neither matching nor identity', async () => {
  for (const [provider, create] of FACTORIES) {
    const input = admitted(request(provider));
    const mutate = (i) => { i.request.requestedModel = 'model-B'; i.request.provider = 'gemini' === provider ? 'claude' : 'gemini'; };
    const matched = await runWhilePending(create, input, success(provider, 'model-A'), mutate);
    assert.equal(matched.result.outcome, 'SUCCESS');
    assertIdentityA(matched.result, provider);
    const rebound = await runWhilePending(create, admitted(request(provider)), success(provider, 'model-B'), (i) => { mutate(i); toB(i); });
    assert.equal(rebound.result.outcome, 'UNCERTAIN');
    assertIdentityA(rebound.result, provider);
  }
});
await check('E: executionId and attemptId mutated while pending keep their original values in the result', async () => {
  for (const [provider, create] of FACTORIES) {
    for (const respond of [success(provider, 'model-A'), failure('KNOWN_FAILURE', provider, 'model-A'), () => { throw new Error('boom'); }]) {
      const { result } = await runWhilePending(create, admitted(request(provider)), respond, (input) => {
        input.request.executionId = 'execution-2';
        input.request.attemptId = 'attempt-2';
        input.authorization.executionId = 'execution-2';
      });
      assert.equal(result.executionId, 'execution-1');
      assert.equal(result.attemptId, 'attempt-1');
    }
  }
});
await check('F/G/H: nested temperature, max_output_tokens, and retrieval mutated while pending never reach the dispatched options', async () => {
  for (const [provider, create] of FACTORIES) {
    const input = admitted(request(provider));
    const callerRetrieval = input.request.retrieval;
    const { result, seen } = await runWhilePending(create, input, success(provider, 'model-A'), (i) => {
      i.request.parameters.temperature.value = 1.9;
      i.request.parameters.max_output_tokens.value = 1;
      i.request.retrieval.enabled = true;
      i.request.parameters.top_p = { value: 0.1 };
      i.request.systemInstruction = 'rewritten';
    });
    const options = seen[0].options;
    assert.equal(options.temperature, 0.2);
    assert.equal(options.maxTokens, 256);
    assert.deepEqual(options.retrieval, { enabled: false });
    assert.notEqual(options.retrieval, callerRetrieval, 'the transport never receives the caller-owned retrieval object');
    assert.equal(options.system, 'role');
    assert.equal(Object.hasOwn(options, 'topP'), false);
    assert.equal(result.outcome, 'SUCCESS');
  }
});

// ---------------------------------------------------------------- snapshot primitive (I, J)
console.log('Snapshot isolation: origin and authorization');

await check('I/J: the snapshot detaches request.origin and authorization at every depth, and is frozen', () => {
  const input = admitted(request('claude'));
  const snapshot = snapshotExecutionInput(input);
  input.request.origin.runId = 'run-2';
  input.request.origin = { runId: 'run-3' };
  input.authorization.admissionId = 'admission-2';
  input.authorization.executionId = 'execution-2';
  input.request.parameters.temperature.value = 9;
  assert.deepEqual(snapshot.request.origin, { runId: 'run-1', sourceRef: 'ref-1' });
  assert.deepEqual(snapshot.authorization, { admissionId: 'admission-1', executionId: 'execution-1', attemptId: 'attempt-1' });
  assert.equal(snapshot.request.parameters.temperature.value, 0.2);
  for (const node of [snapshot, snapshot.request, snapshot.request.origin, snapshot.request.parameters,
    snapshot.request.parameters.temperature, snapshot.request.retrieval, snapshot.binding, snapshot.authorization]) {
    assert.ok(Object.isFrozen(node));
  }
  assert.throws(() => { snapshot.binding.effectiveModel = 'model-B'; }, TypeError);
});
await check('the executor reads caller input only while snapshotting: zero reads of request, binding, or authorization after dispatch', async () => {
  for (const [provider, create] of FACTORIES) {
    let dispatched = false;
    let lateReads = 0;
    const watch = (target) => {
      const watched = {};
      for (const [key, value] of Object.entries(target)) {
        const inner = value !== null && typeof value === 'object' ? watch(value) : value;
        Object.defineProperty(watched, key, {
          enumerable: true,
          get() { if (dispatched) lateReads++; return inner; },
        });
      }
      return watched;
    };
    const input = watch(admitted(request(provider)));
    for (const respond of [success(provider, 'model-A'), failure('KNOWN_FAILURE', provider, 'model-A'),
      failure('UNCERTAIN', provider, 'model-B'), () => { throw new Error('boom'); }]) {
      dispatched = false;
      const { result } = await runWhilePending(create, input, respond, () => { dispatched = true; });
      assert.equal(result.executionId, 'execution-1');
    }
    assert.equal(lateReads, 0, `${provider}: caller input was read after dispatch`);
  }
});
await check('checked values are executed values: a binding getter that changes after its first read cannot split them', async () => {
  for (const [provider, create] of FACTORIES) {
    const base = admitted(request(provider));
    let reads = 0;
    const binding = { ...base.binding };
    Object.defineProperty(binding, 'effectiveModel', { enumerable: true, get() { reads++; return reads === 1 ? 'model-A' : 'model-B'; } });
    const d = deferred(success(provider, 'model-A'));
    const pending = create(d.transport).execute({ ...base, binding });
    await untilDispatched(pending, d);
    d.release();
    const result = await pending;
    assert.equal(reads, 1, 'effectiveModel is read exactly once');
    assert.equal(d.seen[0].modelAtDispatch, 'model-A');
    assert.equal(result.outcome, 'SUCCESS');
    assertIdentityA(result, provider);
  }
});
await check('input that is not plain cloneable data is refused before any transport call', async () => {
  for (const [provider, create] of FACTORIES) {
    let calls = 0;
    const executor = create(async () => { calls++; return success(provider, 'model-A')(); });
    for (const hostile of [
      { ...admitted(request(provider)), request: { ...request(provider), parameters: { temperature: { value: 0.2, toJSON() {} } } } },
      { ...admitted(request(provider)), authorization: new Proxy({}, {}) },
      { ...admitted(request(provider)), binding: undefined },
      null,
    ]) {
      await assert.rejects(() => executor.execute(hostile));
    }
    assert.equal(calls, 0);
  }
});

// ---------------------------------------------------------------- failure matching
console.log('KNOWN_FAILURE / UNCERTAIN matching uses the snapshot');

await check('KNOWN_FAILURE: a failure naming the mutated model B is a mismatch; one naming A is recorded as A', async () => {
  for (const [provider, create] of FACTORIES) {
    const mismatch = await runWhilePending(create, admitted(request(provider)), failure('KNOWN_FAILURE', provider, 'model-B'), toB);
    assert.equal(mismatch.result.outcome, 'UNCERTAIN');
    assert.equal(mismatch.result.error.category, 'RESULT_MISMATCH');
    assert.equal(mismatch.result.error.model, 'model-A');
    assertIdentityA(mismatch.result, provider);
    const matched = await runWhilePending(create, admitted(request(provider)), failure('KNOWN_FAILURE', provider, 'model-A'), toB);
    assert.equal(matched.result.outcome, 'KNOWN_FAILURE');
    assert.equal(matched.result.error.model, 'model-A');
    assertIdentityA(matched.result, provider);
  }
});
await check('UNCERTAIN: a transport-reported uncertain failure is matched against the snapshot too', async () => {
  for (const [provider, create] of FACTORIES) {
    const mismatch = await runWhilePending(create, admitted(request(provider)), failure('UNCERTAIN', provider, 'model-B'), toB);
    assert.equal(mismatch.result.outcome, 'UNCERTAIN');
    assert.equal(mismatch.result.error.category, 'RESULT_MISMATCH');
    assertIdentityA(mismatch.result, provider);
    const matched = await runWhilePending(create, admitted(request(provider)), failure('UNCERTAIN', provider, 'model-A'), toB);
    assert.equal(matched.result.outcome, 'UNCERTAIN');
    assert.equal(matched.result.error.category, 'TRANSPORT');
    assert.equal(matched.result.error.model, 'model-A');
  }
});
await check('a thrown transport error after a mutation is UNCERTAIN, attributed to A, and never exposes its message', async () => {
  for (const [provider, create] of FACTORIES) {
    const { result } = await runWhilePending(create, admitted(request(provider)), () => { throw new Error('secret token'); }, toB);
    assert.equal(result.outcome, 'UNCERTAIN');
    assert.equal(result.error.category, 'UNKNOWN');
    assert.equal(result.error.model, 'model-A');
    assert.doesNotMatch(result.error.message, /secret token/);
    assertIdentityA(result, provider);
  }
});

// ---------------------------------------------------------------- transport-side mutation
console.log('Transport-side mutation never reaches executor authority or the caller');

await check('transport rewriting options.model cannot rewrite matching or identity', async () => {
  for (const [provider, create] of FACTORIES) {
    const rewritten = await runWhilePending(create, admitted(request(provider)), (options) => {
      options.model = 'model-B';
      return { outcome: 'SUCCESS', result: { provider, model: options.model, text: 'x' } };
    }, () => {});
    assert.equal(rewritten.result.outcome, 'UNCERTAIN');
    assertIdentityA(rewritten.result, provider);
    const stillA = await runWhilePending(create, admitted(request(provider)), (options) => {
      options.model = 'model-B';
      return { outcome: 'SUCCESS', result: { provider, model: 'model-A', text: 'x' } };
    }, () => {});
    assert.equal(stillA.result.outcome, 'SUCCESS');
    assertIdentityA(stillA.result, provider);
  }
});
await check('transport mutating its options never writes back into the caller request', async () => {
  for (const [provider, create] of FACTORIES) {
    const input = admitted(request(provider));
    const { result } = await runWhilePending(create, input, (options) => {
      options.retrieval.enabled = true;
      options.temperature = 5;
      return success(provider, 'model-A')();
    }, () => {});
    assert.equal(result.outcome, 'SUCCESS', 'the transport owns the options it receives and may change them');
    assert.deepEqual(input.request.retrieval, { enabled: false });
    assert.equal(input.request.parameters.temperature.value, 0.2);
  }
});
await check('response facts are read once: a flipping usage.provider or result.model cannot split validation from the record', async () => {
  for (const [provider, create] of FACTORIES) {
    let usageReads = 0, modelReads = 0;
    const usage = { inputTokens: 3 };
    Object.defineProperty(usage, 'provider', { enumerable: true, get() { usageReads++; return usageReads === 1 ? provider : 'another-provider'; } });
    const result = { provider, text: 'x' };
    Object.defineProperty(result, 'model', { enumerable: true, get() { modelReads++; return modelReads === 1 ? 'model-A' : 'model-B'; } });
    const { result: normalized } = await runWhilePending(create, admitted(request(provider)), () => ({ outcome: 'SUCCESS', result, usage }), () => {});
    assert.equal(normalized.outcome, 'SUCCESS');
    assert.equal(normalized.usage.provider, provider);
    assert.equal(usageReads, 1);
    assert.equal(modelReads, 1);
    assertIdentityA(normalized, provider);
  }
});
await check('returned facts hold no alias to transport data: later transport mutation changes nothing recorded', async () => {
  for (const [provider, create] of FACTORIES) {
    const retrieval = { status: 'GROUNDED', queries: ['q1'], queryCount: 1, sources: [{ url: 'https://example.test', title: 'T' }], sourcesFound: 1 };
    const usage = { provider, inputTokens: 2, sourceFields: { inputTokens: 'prompt_tokens' } };
    const providerMetadata = { serviceTier: 'standard', region: 'r1' };
    const { result } = await runWhilePending(create, admitted(request(provider)),
      () => ({ outcome: 'SUCCESS', result: { provider, model: 'model-A', text: 'x', retrieval }, usage, providerMetadata }), () => {});
    retrieval.queries.push('q2'); retrieval.sources[0].url = 'https://evil.test'; retrieval.sources.push({ url: 'x' });
    usage.sourceFields.inputTokens = 'tampered'; usage.inputTokens = 99; providerMetadata.region = 'r2';
    assert.deepEqual(result.retrieval.queries, ['q1']);
    assert.deepEqual(result.retrieval.sources, [{ url: 'https://example.test', title: 'T' }]);
    assert.deepEqual(result.usage, { provider, inputTokens: 2, sourceFields: { inputTokens: 'prompt_tokens' } });
    assert.deepEqual(result.providerMetadata, { serviceTier: 'standard', region: 'r1' });
  }
});
await check('an execution identity mismatch is never reported as KNOWN_FAILURE', async () => {
  for (const [provider, create] of FACTORIES) {
    for (const respond of [success(provider, 'model-B'), failure('KNOWN_FAILURE', 'another-provider', 'model-A'), failure('KNOWN_FAILURE', provider, 'model-B')]) {
      const { result } = await runWhilePending(create, admitted(request(provider)), respond, toB);
      assert.equal(result.outcome, 'UNCERTAIN');
      assert.equal(result.error.category, 'RESULT_MISMATCH');
    }
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
