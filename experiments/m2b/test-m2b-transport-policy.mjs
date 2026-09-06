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
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

const sha256hex = (value) => createHash('sha256').update(value).digest('hex');

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

console.log('\nI — dependency provenance is fail-closed against a committed baseline');

const SCRATCH = mkdtempSync(join(tmpdir(), 'm2b-dep-'));
const baseRecord = await dependency.dependencyProvenance();
const withPackage = (name, patch) => ({
  ...baseRecord,
  packages: baseRecord.packages.map((p) => (p.name === name ? { ...p, ...patch } : p)),
});
const rejects = async (record, pattern) => {
  await assert.rejects(
    () => dependency.assertDependenciesMatchLock(record),
    (err) => {
      assert.ok(err instanceof dependency.DependencyProvenanceError, err?.name);
      assert.match(String(err), pattern);
      return true;
    },
  );
};

await check('the real installed tree matches the approved baseline exactly', async () => {
  const record = await dependency.assertDependenciesMatchLock();
  assert.equal(record.approvedBaselineMatched, true);
  assert.deepEqual(dependency.matchesApprovedBaseline(record), []);
  for (const name of dependency.PROVIDER_PACKAGES) {
    const pkg = record.packages.find((p) => p.name === name);
    const approved = dependency.APPROVED_DEPENDENCY_BASELINE.packages[name];
    assert.equal(pkg.lockIntegrity, approved.lockIntegrity, name);
    assert.equal(pkg.runtimePackageDigest, approved.runtimePackageDigest, name);
    assert.equal(pkg.runtimePackageFileCount, approved.runtimePackageFileCount, name);
    assert.equal(pkg.runtimeEntrypointRelative, approved.runtimeEntrypointRelative, name);
    assert.ok(!pkg.runtimeEntrypointRelative.includes('..'), 'entrypoint must be package-relative');
  }
});

await check('1: package-lock sha drift is refused even when every version is unchanged', async () => {
  await rejects({ ...baseRecord, packageLockSha256: sha256hex('a different lockfile') }, /package-lock\.json sha256 is/);
});

await check('2: lock integrity drift is refused', async () => {
  await rejects(withPackage('openai', { lockIntegrity: 'sha512-tampered==' }), /openai\.lockIntegrity/);
});

await check('3: installed package.json byte drift is refused even at the same version', async () => {
  await rejects(
    withPackage('@anthropic-ai/sdk', { installedManifestSha256: sha256hex('{"version":"0.123.0"}') }),
    /@anthropic-ai\/sdk\.installedManifestSha256/,
  );
});

await check('4: a runtime file edit changes the digest and is refused at the same version', () => {
  // Done on a real copied tree, so this tests the digest's sensitivity rather than only
  // the comparator: the package version string is untouched throughout.
  const root = join(SCRATCH, 'generative-ai');
  cpSync('node_modules/@google/generative-ai', root, { recursive: true });
  const before = dependency.packageRuntimeDigest(root);
  assert.equal(before.digest, dependency.APPROVED_DEPENDENCY_BASELINE.packages['@google/generative-ai'].runtimePackageDigest);

  const target = join(root, 'dist', 'index.mjs');
  writeFileSync(target, readFileSync(target, 'utf8') + '\n// a single added comment\n');
  const after = dependency.packageRuntimeDigest(root);
  assert.notEqual(after.digest, before.digest, 'a changed runtime file must change the digest');
  assert.equal(after.fileCount, before.fileCount, 'and it did so without adding a file');
  assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, '0.24.1', 'version string unchanged');
});

await check('4b: an added runtime file changes the digest and the count', () => {
  const root = join(SCRATCH, 'generative-ai-added');
  cpSync('node_modules/@google/generative-ai', root, { recursive: true });
  writeFileSync(join(root, 'dist', 'extra.mjs'), 'export const injected = true;\n');
  const after = dependency.packageRuntimeDigest(root);
  const approved = dependency.APPROVED_DEPENDENCY_BASELINE.packages['@google/generative-ai'];
  assert.notEqual(after.digest, approved.runtimePackageDigest);
  assert.equal(after.fileCount, approved.runtimePackageFileCount + 1);
});

await check('4c: the digest is stable across two reads of the same tree', () => {
  const root = join(SCRATCH, 'generative-ai-stable');
  cpSync('node_modules/@google/generative-ai', root, { recursive: true });
  assert.equal(dependency.packageRuntimeDigest(root).digest, dependency.packageRuntimeDigest(root).digest);
});

await check('5: an entrypoint that resolves outside the package root is refused', async () => {
  await rejects(
    withPackage('openai', { runtimeEntrypointRelative: null, runtimeEntrypointEscapedTo: '/elsewhere/index.mjs' }),
    /resolves outside the package root/,
  );
});

await check('5b: an entrypoint path drift is refused', async () => {
  await rejects(withPackage('openai', { runtimeEntrypointRelative: 'dist/index.mjs' }), /openai\.runtimeEntrypointRelative/);
});

await check('6: a runtimePackageDigest mismatch is refused', async () => {
  await rejects(
    withPackage('@google/generative-ai', { runtimePackageDigest: sha256hex('other bytes') }),
    /@google\/generative-ai\.runtimePackageDigest/,
  );
  await rejects(withPackage('openai', { runtimePackageFileCount: 2952 }), /openai\.runtimePackageFileCount/);
});

await check('7: a locked/installed version mismatch is refused', async () => {
  await rejects(withPackage('openai', { installedVersion: '7.10.1' }), /package-lock says 7\.10\.0, installed is 7\.10\.1/);
});

await check('7b: a package that is not installed is refused', async () => {
  await rejects(withPackage('@anthropic-ai/sdk', { installedVersion: null }), /is not installed/);
});

await check('7c: an install the transport proof never covered is refused', async () => {
  const approved = dependency.APPROVED_DEPENDENCY_BASELINE.packages['@google/generative-ai'];
  await rejects(
    withPackage('@google/generative-ai', { lockedVersion: '0.24.2', installedVersion: '0.24.2' }),
    /transport no-retry test was proven against/,
  );
  assert.equal(approved.transportProvenVersion, '0.24.1');
});

await check('the refusal tells the operator what to do and never offers to fix it', async () => {
  let message = '';
  try { await dependency.assertDependenciesMatchLock(withPackage('openai', { installedVersion: '9.9.9' })); }
  catch (err) { message = String(err); }
  assert.match(message, /Re-run experiments\/m2b\/test-m2b-transport-policy\.mjs/);
  assert.match(message, /do not adjust the baseline to match an unproven install/);
  assert.ok(!/npm install/.test(message), 'a preflight must not suggest repairing the tree for the operator');
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
rmSync(SCRATCH, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
