import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getParameterAssessment } from './dist/models/capabilities.js';
import {
  createClaudeExecutor,
  createOpenAIExecutor,
  createGeminiExecutor,
  resolveProviderBinding,
} from './dist/execution/executors.js';
import { callProvider } from './dist/providers/index.js';
import { callClaude } from './dist/providers/claude.js';
import { callOpenAI } from './dist/providers/openai.js';
import { callGemini } from './dist/providers/gemini.js';

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

function request(provider, overrides = {}) {
  return {
    executionId: 'execution-1',
    attemptId: 'attempt-1',
    provider,
    input: 'offline prompt',
    parameters: {},
    ...overrides,
  };
}

function admitted(requested, defaultModel = 'configured-default') {
  return {
    request: requested,
    binding: resolveProviderBinding(requested, defaultModel),
    authorization: {
      admissionId: 'external-admission-1',
      executionId: requested.executionId,
      attemptId: requested.attemptId,
    },
  };
}

function successTransport(provider, calls, facts = {}) {
  return async (prompt, options) => {
    calls.push({ prompt, options });
    return {
      outcome: 'SUCCESS',
      result: { provider, model: options.model, text: 'answer' },
      ...facts,
    };
  };
}

const factories = [
  ['claude', createClaudeExecutor],
  ['openai', createOpenAIExecutor],
  ['gemini', createGeminiExecutor],
];

await check('request uses normalized parameter names and preserves absent versus explicit zero', async () => {
  const calls = [];
  const executor = createClaudeExecutor(successTransport('claude', calls));
  const absent = request('claude', { requestedModel: 'claude-sonnet-5' });
  const explicit = request('claude', {
    requestedModel: 'claude-sonnet-5',
    parameters: { temperature: { value: 0 }, max_output_tokens: { value: 128 } },
    systemInstruction: 'role',
    stage: 'round1_worker',
    retrieval: { enabled: false },
  });
  await executor.execute(admitted(absent));
  await executor.execute(admitted(explicit));
  assert.equal(Object.hasOwn(calls[0].options, 'temperature'), false);
  assert.equal(Object.hasOwn(calls[0].options, 'maxTokens'), false);
  assert.equal(calls[1].options.temperature, 0);
  assert.equal(calls[1].options.maxTokens, 128);
  assert.equal(calls[1].options.system, 'role');
  assert.equal(calls[1].options.stage, 'round1_worker');
  assert.deepEqual(calls[1].options.retrieval, { enabled: false });
  assert.equal(calls[1].prompt, 'offline prompt');
  assert.deepEqual(Object.keys(explicit.parameters).sort(), ['max_output_tokens', 'temperature']);
});

await check('binding distinguishes requested model from configured default', () => {
  const defaultBinding = resolveProviderBinding(request('openai'), 'configured-default');
  assert.equal(defaultBinding.requestedModel, undefined);
  assert.equal(defaultBinding.effectiveModel, 'configured-default');
  assert.equal(defaultBinding.resolutionBasis, 'DEFAULT');
  const explicitBinding = resolveProviderBinding(
    request('openai', { requestedModel: 'chosen-model' }), 'configured-default'
  );
  assert.equal(explicitBinding.requestedModel, 'chosen-model');
  assert.equal(explicitBinding.effectiveModel, 'chosen-model');
  assert.equal(explicitBinding.resolutionBasis, 'EXPLICIT');
  assert.throws(() => resolveProviderBinding(request('openai', { requestedModel: '' }), 'default'), TypeError);
});

await check('all three executors share identity and use fake transports once', async () => {
  for (const [provider, create] of factories) {
    const calls = [];
    const executor = create(successTransport(provider, calls));
    assert.equal(executor.kind, 'MODEL_PROVIDER');
    assert.equal(executor.provider, provider);
    const result = await executor.execute(admitted(request(provider, { requestedModel: 'chosen-model' })));
    assert.equal(result.outcome, 'SUCCESS');
    assert.equal(result.executionId, 'execution-1');
    assert.equal(result.attemptId, 'attempt-1');
    assert.equal(result.requestedProvider, provider);
    assert.equal(result.requestedModel, 'chosen-model');
    assert.equal(result.effectiveProvider, provider);
    assert.equal(result.effectiveModel, 'chosen-model');
    assert.equal(result.output.text, 'answer');
    assert.equal(calls.length, 1);
  }
});

await check('SUCCESS does not fabricate provider-reported model, usage, or retrieval', async () => {
  const result = await createGeminiExecutor(successTransport('gemini', [])).execute(
    admitted(request('gemini'), 'default-model')
  );
  assert.equal(result.outcome, 'SUCCESS');
  assert.equal(result.requestedModel, undefined);
  assert.equal(result.effectiveModel, 'default-model');
  assert.equal(result.providerReportedModel, undefined);
  assert.equal(Object.hasOwn(result, 'providerReportedModel'), false);
  assert.equal(result.usage, undefined);
  assert.equal(Object.hasOwn(result, 'usage'), false);
  assert.equal(result.retrieval, undefined);
  assert.equal(Object.hasOwn(result, 'retrieval'), false);
  assert.equal(result.finishReason, undefined);
  assert.equal(Object.hasOwn(result, 'finishReason'), false);
  assert.equal(result.providerRequestId, undefined);
  assert.equal(Object.hasOwn(result, 'providerRequestId'), false);
});

await check('reported model, optional native usage, finish reason, ID, and allowlisted metadata survive', async () => {
  const calls = [];
  const result = await createOpenAIExecutor(successTransport('openai', calls, {
    reportedModel: 'provider-reported-model',
    usage: {
      provider: 'openai',
      inputTokens: 7,
      reasoningOrThinkingTokens: 2,
      sourceFields: { inputTokens: 'prompt_tokens', reasoningOrThinkingTokens: 'completion_tokens_details.reasoning_tokens' },
      unwanted: 'ignored',
    },
    finishReason: 'stop',
    providerRequestId: 'request-123',
    providerMetadata: { serviceTier: 'standard', region: 'test-region', secret: 'ignored' },
  })).execute(admitted(request('openai')));
  assert.equal(result.outcome, 'SUCCESS');
  assert.equal(result.providerReportedModel, 'provider-reported-model');
  assert.equal(result.usage.inputTokens, 7);
  assert.equal(result.usage.reasoningOrThinkingTokens, 2);
  assert.equal(result.usage.outputTokens, undefined);
  assert.equal(result.usage.totalTokens, undefined);
  assert.equal(Object.hasOwn(result.usage, 'outputTokens'), false);
  assert.equal(Object.hasOwn(result.usage, 'totalTokens'), false);
  assert.equal(Object.hasOwn(result.usage, 'unwanted'), false);
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.providerRequestId, 'request-123');
  assert.deepEqual(result.providerMetadata, { serviceTier: 'standard', region: 'test-region' });
});

await check('retrieval facts survive without arbitrary raw SDK metadata', async () => {
  const executor = createGeminiExecutor(async (_prompt, options) => ({
    outcome: 'SUCCESS',
    result: {
      provider: 'gemini',
      model: options.model,
      text: 'grounded answer',
      retrieval: {
        status: 'GROUNDED',
        queries: ['query'],
        queryCount: 1,
        sources: [{ url: 'https://example.com', title: 'Example' }],
        sourcesFound: 1,
        raw: { secret: 'must not escape' },
      },
    },
  }));
  const result = await executor.execute(admitted(request('gemini', { retrieval: { enabled: true } })));
  assert.equal(result.outcome, 'SUCCESS');
  assert.equal(result.retrieval.status, 'GROUNDED');
  assert.equal(result.retrieval.queryCount, 1);
  assert.equal(Object.hasOwn(result.retrieval, 'raw'), false);
});

await check('KNOWN_FAILURE and UNCERTAIN retain distinct execution facts', async () => {
  const known = await createClaudeExecutor(async () => ({
    outcome: 'KNOWN_FAILURE',
    error: {
      provider: 'claude', model: 'chosen-model', category: 'PROVIDER_REJECTION',
      message: 'Provider rejected the call.', providerStatus: 400, providerCode: 'bad_request',
      providerRequestId: 'req-2', dispatchState: 'DISPATCHED', completionState: 'FAILED',
      rawSdkObject: { mustNotEscape: true },
    },
  })).execute(admitted(request('claude', { requestedModel: 'chosen-model' })));
  const uncertain = await createClaudeExecutor(async () => ({
    outcome: 'UNCERTAIN',
    error: {
      provider: 'claude', model: 'chosen-model', category: 'TRANSPORT',
      message: 'Connection lost after dispatch.', dispatchState: 'UNKNOWN', completionState: 'UNKNOWN',
    },
  })).execute(admitted(request('claude', { requestedModel: 'chosen-model' })));
  assert.equal(known.outcome, 'KNOWN_FAILURE');
  assert.equal(known.error.providerStatus, 400);
  assert.equal(known.error.providerRequestId, 'req-2');
  assert.equal(Object.hasOwn(known.error, 'rawSdkObject'), false);
  assert.equal(uncertain.outcome, 'UNCERTAIN');
  assert.equal(uncertain.error.completionState, 'UNKNOWN');
});

await check('an unclassified thrown error is uncertain and does not expose its message', async () => {
  let calls = 0;
  const executor = createOpenAIExecutor(async () => {
    calls++;
    throw new Error('secret token should not escape');
  });
  const result = await executor.execute(admitted(request('openai')));
  assert.equal(result.outcome, 'UNCERTAIN');
  assert.equal(result.error.dispatchState, 'UNKNOWN');
  assert.doesNotMatch(result.error.message, /secret token/);
  assert.equal(calls, 1);
});

await check('mismatched binding fails before transport; mismatched response is uncertain', async () => {
  let calls = 0;
  const executor = createClaudeExecutor(async () => {
    calls++;
    return { outcome: 'SUCCESS', result: { provider: 'claude', model: 'wrong-model', text: 'x' } };
  });
  const input = admitted(request('claude', { requestedModel: 'right-model' }));
  await assert.rejects(() => executor.execute({
    ...input,
    binding: { ...input.binding, effectiveModel: 'substitute-model' },
  }), /binding disagree/);
  assert.equal(calls, 0);
  const result = await executor.execute(input);
  assert.equal(result.outcome, 'UNCERTAIN');
  assert.equal(result.error.category, 'RESULT_MISMATCH');
  assert.equal(calls, 1);
});

await check('usage from a different provider is not attributed to this execution', async () => {
  const executor = createGeminiExecutor(async (_prompt, options) => ({
    outcome: 'SUCCESS',
    result: { provider: 'gemini', model: options.model, text: 'x' },
    usage: { provider: 'openai', inputTokens: 10 },
  }));
  const result = await executor.execute(admitted(request('gemini')));
  assert.equal(result.outcome, 'UNCERTAIN');
  assert.equal(result.error.category, 'RESULT_MISMATCH');
  assert.equal(Object.hasOwn(result, 'usage'), false);
});

await check('executor does not evaluate admission or acquire domain authority', async () => {
  const source = readFileSync('src/execution/executors.ts', 'utf8');
  assert.doesNotMatch(source, /from ['"]\.\.\/models\/capabilities/);
  assert.doesNotMatch(source, /from ['"]\.\.\/stress-test\//);
  const input = admitted(request('gemini'));
  input.authorization.admissionId = 'external-only';
  const result = await createGeminiExecutor(successTransport('gemini', [])).execute(input);
  assert.equal(result.outcome, 'SUCCESS');
  assert.equal(Object.hasOwn(result, 'adjudication'), false);
  assert.equal(Object.hasOwn(result, 'routeOutcome'), false);
});

await check('legacy provider exports remain available and H1 remains unresolved', async () => {
  assert.equal(typeof callProvider, 'function');
  assert.equal(typeof callClaude, 'function');
  assert.equal(typeof callOpenAI, 'function');
  assert.equal(typeof callGemini, 'function');
  const h1 = getParameterAssessment('claude', 'claude-sonnet-5', 'temperature');
  assert.equal(h1.status, 'FOUND');
  assert.equal(h1.assessment.readiness, 'WIRED_UNVERIFIED');
  assert.equal(h1.assessment.constraint.kind, 'UNKNOWN');
  assert.equal(h1.assessment.constraint.explicitTransmission, 'UNKNOWN');
  const calls = [];
  await createClaudeExecutor(successTransport('claude', calls)).execute(admitted(request('claude', {
    requestedModel: 'claude-sonnet-5',
    parameters: { temperature: { value: 0 } },
  })));
  assert.equal(calls[0].options.temperature, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
