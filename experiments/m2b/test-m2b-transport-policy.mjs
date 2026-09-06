/**
 * Deterministic proof that one logical capture call is at most one HTTP attempt.
 *
 * ## What this exists to close
 *
 * The recorder counts logical dispatches, and a logical dispatch was being treated as the
 * unit a call budget buys. That is only true if the SDK underneath does not retry. Both
 * the OpenAI and Anthropic clients default to two retries, so before this the twelve-call
 * Wave ceiling bounded twelve dispatches and up to thirty-six requests, and the artifact
 * would have recorded the smaller number with no way to tell.
 *
 * ## Why it is written against the installed bytes
 *
 * Two of the three providers take an explicit option, so their behaviour is something this
 * codebase sets. Gemini's is not: `@google/generative-ai` has no retry knob because it has
 * no retry, which makes the property a fact about the installed package rather than about
 * our request. Documentation cannot establish that, and neither can a mock of the SDK. So
 * every case below drives the real adapter through the real client with only the transport
 * replaced, and `dependency-provenance.mjs` pins the versions this ran against so a live
 * capture on a different one is refused rather than assumed.
 *
 * Zero network. `globalThis.fetch` is replaced before the first call, which is also when
 * each client is constructed, so no request can leave the process. Credentials are fake.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Fake credentials, set before dist/config.js is imported and reads the environment. A
// real key must never be able to reach a stub whose job is to look like a provider.
process.env.OPENAI_API_KEY = 'test-openai-key-not-real';
process.env.ANTHROPIC_API_KEY = 'test-anthropic-key-not-real';
process.env.GEMINI_API_KEY = 'test-gemini-key-not-real';

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  PASS ${name}`); passed++; }
  catch (e) { console.log(`  FAIL ${name}\n      ${e.stack}`); failed++; }
}

/** Every request the process attempted, so a leak would be visible rather than silent. */
const attempts = [];
const realFetch = globalThis.fetch;

/** A retryable failure. 500 is retried by both SDK defaults, which is the point. */
const failingFetch = async (url, init) => {
  attempts.push({ url: String(url), method: init?.method ?? 'GET' });
  return new Response(JSON.stringify({ error: { message: 'stubbed upstream failure' } }), {
    status: 500,
    statusText: 'Internal Server Error',
    headers: { 'content-type': 'application/json' },
  });
};

globalThis.fetch = failingFetch;

const countAttempts = async (fn) => {
  const before = attempts.length;
  let thrown = null;
  try { await fn(); } catch (e) { thrown = e; }
  return { calls: attempts.length - before, thrown };
};

// Imported after the stub is installed and after the fake credentials are set.
const { callOpenAI } = await import('../../dist/providers/openai.js');
const { callClaude } = await import('../../dist/providers/claude.js');
const { callGemini } = await import('../../dist/providers/gemini.js');
const { TRANSPORT_MAX_RETRIES, TRANSPORT_RETRY_POLICY, createRecorder } = await import('./capture/recorder.mjs');
const { CHIEF_PIN, REGISTERED_SPECIALISTS } = await import('./capture/runner.mjs');
const { routingFor } = await import('./protocol/amendment-0-3.mjs');
const dependency = await import('./capture/dependency-provenance.mjs');

console.log('\nF / G / H — one logical call is at most one HTTP attempt');

await check('F: OpenAI with explicit no-retry makes exactly one transport attempt', async () => {
  const { calls, thrown } = await countAttempts(() =>
    callOpenAI('prompt', { model: 'gpt-5', transportMaxRetries: 0 }));
  assert.ok(thrown, 'a 500 must surface as an error, not be swallowed');
  assert.equal(calls, 1, `expected exactly one HTTP attempt, saw ${calls}`);
});

await check('G: Anthropic with explicit no-retry makes exactly one transport attempt', async () => {
  const { calls, thrown } = await countAttempts(() =>
    callClaude('prompt', { model: 'claude-sonnet-5', transportMaxRetries: 0 }));
  assert.ok(thrown);
  assert.equal(calls, 1, `expected exactly one HTTP attempt, saw ${calls}`);
});

await check('H: the installed Gemini SDK makes exactly one fetch per generateContent', async () => {
  // No option is passed, because there is none to pass. This asserts the property of the
  // package that the capture path depends on.
  const { calls, thrown } = await countAttempts(() =>
    callGemini('prompt', { model: 'gemini-3.1-pro-preview' }));
  assert.ok(thrown);
  assert.equal(calls, 1, `expected exactly one fetch, saw ${calls}`);
});

await check('H2: the Gemini SDK does not retry even when asked for no-retry explicitly', async () => {
  const { calls } = await countAttempts(() =>
    callGemini('prompt', { model: 'gemini-3.1-pro-preview', transportMaxRetries: 0 }));
  assert.equal(calls, 1);
});

await check('H3: the installed Gemini request path contains no retry loop', () => {
  // The behavioural assertions above are the proof; this pins why it holds, so a future
  // upgrade that adds retries fails here with an explanation rather than only a count.
  const source = readFileSync('node_modules/@google/generative-ai/dist/index.mjs', 'utf8');
  const makeRequest = source.slice(source.indexOf('async function makeRequest('), source.indexOf('function handleResponseError'));
  assert.ok(makeRequest.includes('await fetchFn(url, fetchOptions)'), 'expected the single fetch call site');
  assert.equal((makeRequest.match(/fetchFn\(/g) ?? []).length, 1, 'exactly one transport call site');
  for (const term of ['retry', 'retries', 'backoff', 'attempt']) {
    assert.ok(!makeRequest.toLowerCase().includes(term), `unexpected "${term}" in the request path`);
  }
});

console.log('\nJ — ordinary product calls keep their SDK retries');

await check('J: OpenAI without the option retries as the SDK default (3 attempts)', async () => {
  const { calls } = await countAttempts(() => callOpenAI('prompt', { model: 'gpt-5' }));
  assert.equal(calls, 3, `expected 1 + 2 default retries, saw ${calls}`);
});

await check('J: Anthropic without the option retries as the SDK default (3 attempts)', async () => {
  const { calls } = await countAttempts(() => callClaude('prompt', { model: 'claude-sonnet-5' }));
  assert.equal(calls, 3, `expected 1 + 2 default retries, saw ${calls}`);
});

await check('J: the no-retry option is request-scoped, not sticky on the client', async () => {
  // The same singleton client is reused across the process, so a capture call must not
  // change what a later product call does.
  const capture = await countAttempts(() => callOpenAI('p', { model: 'gpt-5', transportMaxRetries: 0 }));
  const ordinary = await countAttempts(() => callOpenAI('p', { model: 'gpt-5' }));
  assert.equal(capture.calls, 1);
  assert.equal(ordinary.calls, 3, 'the client default must survive a capture call');
});

console.log('\nA / B — the capture path injects the policy on every call');

const dispatchWith = async (recorderCall, stage, provider, model, system) => {
  const recorder = createRecorder({ call: recorderCall, now: () => new Date('2026-09-07T00:00:00.000Z') });
  const workers = REGISTERED_SPECIALISTS.map((id, i) => ({ id, role: `Role ${i} for ${id}`, ...routingFor(id) }));
  const dispatch = recorder.dispatcherFor('S3', { pins: { planning: CHIEF_PIN, round1_worker: routingFor }, workers });
  await dispatch(provider, 'p', { stage, model, ...(system ? { system } : {}) });
  return recorder;
};

await check('A: planning is dispatched with transportMaxRetries = 0', async () => {
  let seen = null;
  const recorder = await dispatchWith(
    async (provider, prompt, options) => { seen = options; return { provider, model: options.model, text: 'ok' }; },
    'planning', CHIEF_PIN.provider, CHIEF_PIN.model, null);
  assert.equal(seen.transportMaxRetries, 0, 'the option must reach the provider adapter');
  assert.equal(recorder.calls[0].transportMaxRetriesRequested, 0);
  assert.equal(recorder.calls[0].transportRetryPolicy, TRANSPORT_RETRY_POLICY);
});

await check('B: every round1_worker is dispatched with transportMaxRetries = 0', async () => {
  for (const id of REGISTERED_SPECIALISTS) {
    const pin = routingFor(id);
    let seen = null;
    const recorder = await dispatchWith(
      async (provider, prompt, options) => { seen = options; return { provider, model: options.model, text: 'ok' }; },
      'round1_worker', pin.provider, pin.model, `Role ${REGISTERED_SPECIALISTS.indexOf(id)} for ${id}`);
    assert.equal(seen.transportMaxRetries, 0, id);
    assert.equal(recorder.calls[0].agentId, id);
    assert.equal(recorder.calls[0].transportMaxRetriesRequested, 0, id);
  }
});

await check('the capture policy constants say what the artifacts record', () => {
  assert.equal(TRANSPORT_MAX_RETRIES, 0);
  assert.equal(TRANSPORT_RETRY_POLICY, 'explicit-no-retry');
});

console.log('\nI — dependency provenance is fail-closed before any call');

await check('I: a locked/installed version mismatch is refused', async () => {
  const record = await dependency.dependencyProvenance();
  const tampered = {
    ...record,
    packages: record.packages.map((p) => (p.name === 'openai' ? { ...p, installedVersion: '9.9.9' } : p)),
  };
  await assert.rejects(
    () => dependency.assertDependenciesMatchLock(tampered),
    (err) => err instanceof dependency.DependencyProvenanceError && /package-lock says/.test(String(err)),
  );
});

await check('I: an installed SDK that the transport proof never covered is refused', async () => {
  const record = await dependency.dependencyProvenance();
  const drifted = {
    ...record,
    packages: record.packages.map((p) => (p.name === '@google/generative-ai'
      ? { ...p, lockedVersion: '0.24.2', installedVersion: '0.24.2' }
      : p)),
  };
  await assert.rejects(
    () => dependency.assertDependenciesMatchLock(drifted),
    (err) => /transport no-retry test was proven against/.test(String(err)),
  );
});

await check('I: a missing provider SDK is refused', async () => {
  const record = await dependency.dependencyProvenance();
  const absent = {
    ...record,
    packages: record.packages.map((p) => (p.name === '@anthropic-ai/sdk' ? { ...p, installedVersion: null } : p)),
  };
  await assert.rejects(() => dependency.assertDependenciesMatchLock(absent), /is not installed/);
});

await check('the real installed tree passes the preflight and records what ran', async () => {
  const record = await dependency.assertDependenciesMatchLock();
  assert.equal(record.packageLockSha256.length, 64);
  for (const name of dependency.PROVIDER_PACKAGES) {
    const pkg = record.packages.find((p) => p.name === name);
    assert.equal(pkg.lockedVersion, pkg.installedVersion, name);
    assert.equal(pkg.installedVersion, dependency.TRANSPORT_PROVEN_VERSIONS[name], name);
    assert.equal(pkg.resolvedEntrypointSha256.length, 64, name);
  }
});

console.log('\nNo network');

await check('every attempted request went to the stub and none to a real endpoint', () => {
  assert.ok(attempts.length > 0, 'the suite must actually have exercised the transports');
  assert.notEqual(globalThis.fetch, realFetch, 'the stub must still be installed');
  for (const attempt of attempts) {
    assert.match(attempt.url, /^https:\/\/(api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com)\//, attempt.url);
  }
  console.log(`      ${attempts.length} stubbed attempts, 0 real requests`);
});

globalThis.fetch = realFetch;

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
