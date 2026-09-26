// Offline tests for F13 at the adapter layer: provider completion facts survive into CallResult,
// and the default E0-R2 transports keep them as finishReason.
//
// The real SDKs run against an in-memory fetch. Placeholder keys are set before any module
// loads, so dotenv never supplies real ones, and the OpenAI and Anthropic base URLs point at
// a closed local port, so even a request that escaped the stub could not reach a provider.
process.env.OPENAI_API_KEY = 'offline-placeholder';
process.env.ANTHROPIC_API_KEY = 'offline-placeholder';
process.env.GEMINI_API_KEY = 'offline-placeholder';
process.env.OPENAI_BASE_URL = 'http://127.0.0.1:9/v1';
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9';

const requests = [];
const script = {};
globalThis.fetch = async (input) => {
  const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
  let provider;
  if (url.host === '127.0.0.1:9' && url.pathname === '/v1/chat/completions') provider = 'openai';
  else if (url.host === '127.0.0.1:9' && url.pathname === '/v1/messages') provider = 'claude';
  else if (url.host === 'generativelanguage.googleapis.com' && url.pathname.endsWith(':generateContent')) provider = 'gemini';
  else throw new Error(`offline stub refused ${url.host}${url.pathname}`);
  requests.push(provider);
  if (!script[provider]) throw new Error(`no scripted ${provider} response`);
  return new Response(JSON.stringify(script[provider]), { status: 200, headers: { 'content-type': 'application/json' } });
};

const assert = (await import('node:assert/strict')).default;
const { callOpenAI } = await import('./dist/providers/openai.js');
const { callClaude } = await import('./dist/providers/claude.js');
const { callGemini } = await import('./dist/providers/gemini.js');
const { callProvider } = await import('./dist/providers/index.js');
const { classifyCompletion } = await import('./dist/providers/types.js');
const {
  createClaudeExecutor,
  createGeminiExecutor,
  createOpenAIExecutor,
  resolveProviderBinding,
} = await import('./dist/execution/executors.js');
const { executionRequestFingerprint } = await import('./dist/execution/fingerprint.js');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (error) {
    console.log(`  FAIL ${name}\n      ${error.stack}`);
    failed++;
  }
}

const body = {
  openai: (text, reason) => ({
    id: 'chatcmpl-offline',
    object: 'chat.completion',
    created: 0,
    model: 'gpt-fixture',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: reason, logprobs: null }],
  }),
  claude: (text, reason) => ({
    id: 'msg-offline',
    type: 'message',
    role: 'assistant',
    model: 'claude-fixture',
    content: [{ type: 'text', text }],
    stop_reason: reason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }),
  gemini: (text, reason, extra = {}) => ({
    candidates: [{ content: { role: 'model', parts: [{ text }] }, index: 0, ...(reason === null ? {} : { finishReason: reason }), ...extra }],
  }),
};
const adapters = { openai: callOpenAI, claude: callClaude, gemini: callGemini };

async function respond(provider, text, reason, options = {}, extra) {
  script[provider] = body[provider](text, reason, extra);
  const before = requests.length;
  const result = await adapters[provider]('offline prompt', { model: `${provider}-fixture`, ...options });
  assert.equal(requests.length - before, 1, 'exactly one request, no retry');
  return result;
}

const PARTIAL = 'The first half of an answer that stops mid';

console.log('\nF13: adapters keep the provider completion fact');

for (const [provider, reason] of [['openai', 'length'], ['claude', 'max_tokens'], ['gemini', 'MAX_TOKENS']]) {
  await check(`${provider}: non-empty text with ${reason} is TRUNCATED, reason kept exactly`, async () => {
    const result = await respond(provider, PARTIAL, reason);
    assert.deepEqual(result, {
      provider,
      model: `${provider}-fixture`,
      text: PARTIAL,
      completion: { state: 'TRUNCATED', providerReason: reason },
    });
  });
}

for (const [provider, reason] of [['openai', 'stop'], ['claude', 'end_turn'], ['gemini', 'STOP']]) {
  await check(`${provider}: ${reason} is COMPLETE`, async () => {
    const result = await respond(provider, 'A finished answer.', reason);
    assert.deepEqual(result.completion, { state: 'COMPLETE', providerReason: reason });
    assert.equal(result.text, 'A finished answer.');
  });
}

for (const [provider, reason] of [['openai', 'content_filter'], ['claude', 'stop_sequence'], ['claude', 'refusal'], ['gemini', 'OTHER'], ['gemini', 'BLOCKLIST'], ['gemini', 'FINISH_REASON_UNSPECIFIED']]) {
  await check(`${provider}: unclassified ${reason} is UNKNOWN, never COMPLETE`, async () => {
    const result = await respond(provider, 'Some text.', reason);
    assert.deepEqual(result.completion, { state: 'UNKNOWN', providerReason: reason });
  });
}

await check('claude: model_context_window_exceeded is a token-limit stop, so TRUNCATED', async () => {
  const result = await respond('claude', PARTIAL, 'model_context_window_exceeded');
  assert.deepEqual(result.completion, { state: 'TRUNCATED', providerReason: 'model_context_window_exceeded' });
});

for (const provider of ['openai', 'claude', 'gemini']) {
  await check(`${provider}: no reported reason leaves the fact absent rather than inventing COMPLETE`, async () => {
    const result = await respond(provider, 'Some text.', null);
    assert.equal(Object.hasOwn(result, 'completion'), false);
  });
}

await check('matching is exact: a differently cased reason is UNKNOWN, spelled as sent', async () => {
  const openai = await respond('openai', PARTIAL, 'LENGTH');
  assert.deepEqual(openai.completion, { state: 'UNKNOWN', providerReason: 'LENGTH' });
  const gemini = await respond('gemini', PARTIAL, 'max_tokens');
  assert.deepEqual(gemini.completion, { state: 'UNKNOWN', providerReason: 'max_tokens' });
});

await check('the native reason is bounded and classified before it is cut', () => {
  const long = 'x'.repeat(500);
  assert.deepEqual(classifyCompletion(long, { complete: ['stop'], truncated: [long] }), { state: 'TRUNCATED', providerReason: 'x'.repeat(64) });
  assert.equal(classifyCompletion(42, { complete: [], truncated: [] }), undefined);
  assert.equal(classifyCompletion('', { complete: [''], truncated: [] }), undefined);
  assert.equal(classifyCompletion({ toString: () => 'length' }, { complete: [], truncated: ['length'] }), undefined);
});

await check('completion is not inferred from text length', async () => {
  const short = await respond('openai', 'ok', 'length');
  assert.equal(short.completion.state, 'TRUNCATED');
  const long = await respond('openai', 'word '.repeat(4000), 'stop');
  assert.equal(long.completion.state, 'COMPLETE');
});

await check('retrieval results keep the completion fact alongside them', async () => {
  const openai = await respond('openai', PARTIAL, 'length', { retrieval: { enabled: true } });
  assert.equal(openai.retrieval.status, 'FAILED');
  assert.deepEqual(openai.completion, { state: 'TRUNCATED', providerReason: 'length' });
  const claude = await respond('claude', PARTIAL, 'max_tokens', { retrieval: { enabled: true } });
  assert.equal(claude.retrieval.status, 'FAILED');
  assert.equal(claude.completion.state, 'TRUNCATED');
  const gemini = await respond('gemini', PARTIAL, 'MAX_TOKENS', { retrieval: { enabled: true } }, {
    groundingMetadata: { webSearchQueries: ['q'], groundingChunks: [{ web: { uri: 'https://example.com/a', title: 'A' } }] },
  });
  assert.equal(gemini.retrieval.status, 'GROUNDED');
  assert.deepEqual(gemini.completion, { state: 'TRUNCATED', providerReason: 'MAX_TOKENS' });
});

await check('empty text still fails as before, whatever the reason', async () => {
  for (const [provider, reason] of [['openai', 'length'], ['claude', 'max_tokens'], ['gemini', 'MAX_TOKENS']]) {
    script[provider] = body[provider]('   ', reason);
    await assert.rejects(adapters[provider]('offline prompt', { model: `${provider}-fixture` }), /returned no text/);
  }
});

await check('callProvider passes the completion fact through unchanged', async () => {
  script.claude = body.claude(PARTIAL, 'max_tokens');
  const result = await callProvider('claude', 'offline prompt', { model: 'claude-fixture' });
  assert.deepEqual(result.completion, { state: 'TRUNCATED', providerReason: 'max_tokens' });
});

console.log('\nE0-R2: default transports keep the native reason as finishReason');

const factories = { claude: createClaudeExecutor, openai: createOpenAIExecutor, gemini: createGeminiExecutor };
function admitted(provider) {
  const request = { executionId: 'execution-1', attemptId: 'attempt-1', provider, input: 'offline prompt', parameters: {}, requestedModel: `${provider}-fixture` };
  const binding = resolveProviderBinding(request, 'configured-default');
  return {
    request,
    binding,
    authorization: { admissionId: 'external-admission-1', executionId: 'execution-1', attemptId: 'attempt-1',
      provider, effectiveModel: binding.effectiveModel,
      requestFingerprint: executionRequestFingerprint(request, binding) },
  };
}

for (const [provider, reason] of [['openai', 'length'], ['claude', 'max_tokens'], ['gemini', 'MAX_TOKENS']]) {
  await check(`${provider}: a truncated response stays SUCCESS with finishReason ${reason}`, async () => {
    script[provider] = body[provider](PARTIAL, reason);
    const before = requests.length;
    const result = await factories[provider]().execute(admitted(provider));
    assert.equal(requests.length - before, 1, 'one dispatch, no retry');
    assert.equal(result.outcome, 'SUCCESS', 'execution facts and delivery policy stay separate layers');
    assert.equal(result.finishReason, reason);
    assert.equal(result.output.text, PARTIAL);
    assert.equal(result.effectiveModel, `${provider}-fixture`);
  });
}

await check('a normal stop is carried the same way, and no reason stays absent', async () => {
  script.gemini = body.gemini('Done.', 'STOP');
  assert.equal((await createGeminiExecutor().execute(admitted('gemini'))).finishReason, 'STOP');
  script.openai = body.openai('Done.', null);
  const none = await createOpenAIExecutor().execute(admitted('openai'));
  assert.equal(none.outcome, 'SUCCESS');
  assert.equal(Object.hasOwn(none, 'finishReason'), false);
});

await check('every request in this file went to the in-memory stub', () => {
  assert.ok(requests.length > 0);
  assert.ok(requests.every((provider) => ['openai', 'claude', 'gemini'].includes(provider)));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
