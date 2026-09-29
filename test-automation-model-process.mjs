import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, copyFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FileEgressJournal } from './dist/automation/file-egress-journal.js';
import { NodeProcessExecutor } from './dist/automation/process-executor.js';
import {
  egressRefusal, proxyEnvironment, refusedModelEnvironmentName, verifyPinnedExecutable,
} from './dist/automation/live/model-process-isolation.js';
import { SeatbeltModelProcessExecutor, modelProcessProfile } from './dist/automation/live/seatbelt-model-process.js';
import { SANDBOX_EXEC } from './dist/automation/live/seatbelt-validation.js';

// G1-R3C LIVE MODEL PROCESS boundary. Unit checks run everywhere. The real capability
// checks run where macOS Seatbelt is present and are reported as skipped elsewhere. The
// "model CLI" is a harmless fixture script run by this Node binary; the "provider" is a
// local echo server on 127.0.0.1; hostnames reach the broker only through an injected
// deterministic resolver. No model, provider endpoint, public address, or credential is
// involved.

const T = '2026-09-29T00:00:00.000Z';
const clock = { now: () => T };
const tests = [];
const check = (name, fn, { requires } = {}) => tests.push([name, fn, requires]);
const seatbelt = process.platform === 'darwin' && existsSync(SANDBOX_EXEC) &&
  spawnSync(SANDBOX_EXEC, ['-p', '(version 1)(allow default)', '/usr/bin/true']).status === 0;
function withDir(fn) {
  return async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'chief-model-process-')));
    try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
}
const NODE = realpathSync(process.execPath);
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const NODE_SHA = sha(NODE);
const recorded = (id, counts = {}, allowlist = ['a.test:443']) => ({ isolation: 'ENFORCED', result: { outcome: 'EXITED', exitCode: 0, signal: null, stdout: '', stderr: '', durationMs: 1 },
  egress: { status: 'RECORDED', summary: { sessionId: id, allowlist, closed: true, connected: 1, denied: 0, connectFailed: 0, ...counts } } });

// ---------------------------------------------------------------- units (every platform)
check('the proxy environment points every scheme at the loopback broker and exempts nothing', () => {
  assert.deepEqual(proxyEnvironment(4312), { HTTP_PROXY: 'http://127.0.0.1:4312', HTTPS_PROXY: 'http://127.0.0.1:4312', ALL_PROXY: 'http://127.0.0.1:4312',
    NO_PROXY: '', http_proxy: 'http://127.0.0.1:4312', https_proxy: 'http://127.0.0.1:4312', all_proxy: 'http://127.0.0.1:4312', no_proxy: '' });
  for (const port of [0, 65_536, 1.5, Number.NaN, '4312']) assert.throws(() => proxyEnvironment(port), RangeError, String(port));
});
check('a caller may not set a proxy, reroute a provider, or change TLS trust for a model process', () => {
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'Https_Proxy',
    'ANTHROPIC_BASE_URL', 'ANTHROPIC_UNIX_SOCKET', 'OPENAI_BASE_URL', 'CODEX_REFRESH_TOKEN_URL_OVERRIDE', 'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_API_BASE_URL', 'CLAUDE_CODE_HTTPS_PROXY', 'CLAUDE_CODE_PROXY_RESOLVES_HOSTS', 'CLAUDE_CODE_CUSTOM_OAUTH_URL',
    'AWS_REGION', 'GOOGLE_CLOUD_PROJECT', 'VERTEX_REGION_CLAUDE_4', 'CLOUD_ML_REGION', 'AZURE_OPENAI_ENDPOINT', 'NODE_EXTRA_CA_CERTS',
    'NODE_TLS_REJECT_UNAUTHORIZED', 'SSL_CERT_FILE', 'GLOBAL_AGENT_HTTP_PROXY', 'NODE_USE_ENV_PROXY']) {
    assert.equal(refusedModelEnvironmentName({ PATH: '/bin', [name]: 'x' }), name, name);
  }
  assert.equal(refusedModelEnvironmentName({ PATH: '/bin', HOME: '/h', LANG: 'C', NO_COLOR: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', DISABLE_TELEMETRY: '1', GIT_TERMINAL_PROMPT: '0' }), undefined);
});
check('a pinned executable is checked by content: the same bytes pass; a changed byte, a script, or an unpinned path does not', withDir((dir) => {
  const binary = join(dir, 'cli');
  writeFileSync(binary, Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), randomBytes(3 * 1024 * 1024)]), { mode: 0o755 });
  const hash = sha(binary);
  assert.equal(verifyPinnedExecutable(binary, hash), binary);
  symlinkSync(binary, join(dir, 'alias'));
  assert.equal(verifyPinnedExecutable(join(dir, 'alias'), hash), binary, 'a link resolves to the pinned file it names');
  appendFileSync(binary, Buffer.from([0]));
  assert.throws(() => verifyPinnedExecutable(binary, hash), /hash mismatch/);
  writeFileSync(join(dir, 'launcher'), '#!/bin/sh\nexec real-codex "$@"\n', { mode: 0o755 });
  assert.throws(() => verifyPinnedExecutable(join(dir, 'launcher'), sha(join(dir, 'launcher'))), /script/);
  assert.throws(() => verifyPinnedExecutable('cli', hash), /absolute/);
  assert.throws(() => verifyPinnedExecutable(dir, hash), /regular file/);
  assert.throws(() => verifyPinnedExecutable(binary, hash.toUpperCase()), /SHA-256/);
  assert.throws(() => verifyPinnedExecutable(join(dir, 'missing'), hash), /ENOENT/);
}));
check('the model profile denies by default; its only network permission is TCP to the broker port on IPv4 loopback', () => {
  const { profile, parameters } = modelProcessProfile({ readTrees: ['/opt/cli'], writeTrees: ['/work', '/tmp/x'] }, 43127);
  const lines = profile.split('\n');
  assert.equal(lines[1], '(deny default)');
  assert.deepEqual(lines.filter((line) => /network/.test(line)), ['(allow network-outbound (remote tcp4 "localhost:43127"))']);
  assert.doesNotMatch(profile, /mach-lookup|mach-register|iokit|ipc-posix|\(allow default\)|network-inbound|network-bind|remote ip|remote tcp "|\*:/);
  assert.doesNotMatch(profile, /\/opt\/cli|\/work/, 'paths are parameters, never profile text');
  assert.ok(parameters.includes('R0=/opt/cli') && parameters.includes('W0=/work'));
  for (const port of [0, 65_536, 1.5, Number.NaN, '43127']) assert.throws(() => modelProcessProfile({ readTrees: [], writeTrees: [] }, port), RangeError, String(port));
});
check('broker evidence gates the result: exact closed session and allowlist, no refusal, and a connection behind any success', () => {
  const id = 'c'.repeat(64);
  const scope = { provider: 'p', model: 'm', egressDestinations: ['a.test:443'] };
  assert.equal(egressRefusal(recorded(id), scope, id), undefined);
  const failed = { ...recorded(id, { connected: 0 }), result: { outcome: 'EXITED', exitCode: 1, signal: null, stdout: '', stderr: '', durationMs: 1 } };
  assert.equal(egressRefusal(failed, scope, id), undefined, 'a failed run may have connected nowhere');
  for (const [outcome, pattern] of [[recorded(id, { connected: 0 }), /no broker-recorded/], [recorded(id, { denied: 1 }), /unauthorized/],
    [recorded(id, {}, ['a.test:443', 'b.test:443']), /allowlist differs/], [recorded(id, {}, ['a.test:8443']), /allowlist differs/],
    [recorded(id, { closed: false }), /does not close/], [recorded('d'.repeat(64)), /does not close/],
    [{ ...recorded(id), egress: { status: 'AMBIGUOUS', reason: 'x' } }, /ambiguous/], [{ ...recorded(id), egress: undefined }, /ambiguous/]]) {
    assert.match(egressRefusal(outcome, scope, id), pattern);
  }
});
check('without macOS Seatbelt, or without its journal, resolver, or an absolute search path, the boundary is not constructed', withDir((dir) => {
  const dependencies = { executor: new NodeProcessExecutor(), egressJournal: new FileEgressJournal(join(dir, 'e'), clock), resolver: { resolve: async () => [] } };
  for (const platform of ['linux', 'win32', 'freebsd']) {
    assert.throws(() => new SeatbeltModelProcessExecutor({ runtimeReadPaths: [], searchPath: '/usr/bin' }, { ...dependencies, platform }),
      /Model process isolation \(macOS Seatbelt\) is unavailable/, platform);
  }
  if (!seatbelt) return;
  assert.throws(() => new SeatbeltModelProcessExecutor({ runtimeReadPaths: [], searchPath: 'bin' }, dependencies), /absolute/);
  for (const missing of ['executor', 'egressJournal', 'resolver']) {
    assert.throws(() => new SeatbeltModelProcessExecutor({ runtimeReadPaths: [], searchPath: '/usr/bin' }, { ...dependencies, [missing]: undefined }), /requires/);
  }
}));

// ---------------------------------------------------------------- real capability (macOS Seatbelt, loopback fixtures only)
// The fixture "CLI": it follows a plan and reports what happened. It connects only by IP
// (to the loopback provider directly, or to the broker named in its proxy environment).
const CLI = `import { connect } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
const plan = JSON.parse(process.argv[2]);
const proxy = new URL(process.env.HTTPS_PROXY);
const attempt = (fn) => { try { return fn() ?? 'ok'; } catch (error) { return error.code ?? 'error'; } };
const direct = (port) => new Promise((resolve) => { const s = connect({ host: '127.0.0.1', port }); s.on('connect', () => { s.destroy(); resolve('CONNECTED'); }); s.on('error', (e) => resolve(e.code)); });
const viaBroker = (request, payload) => new Promise((resolve) => {
  const s = connect({ host: proxy.hostname, port: Number(proxy.port) });
  let text = '', tunnel = false;
  s.on('data', (chunk) => {
    text += chunk.toString('latin1');
    if (!tunnel && text.includes('\\r\\n\\r\\n')) {
      const status = Number(text.split(' ')[1]);
      if (status !== 200 || !payload) { s.destroy(); resolve({ status }); return; }
      tunnel = true; text = ''; s.write(payload);
    } else if (tunnel && text.length >= payload.length) { s.destroy(); resolve({ status: 200, echo: text }); }
  });
  s.on('error', (e) => resolve({ error: e.code }));
  s.on('close', () => resolve({ closed: true }));
  s.write(request);
});
const out = { env: { names: Object.keys(process.env).sort(), HTTPS_PROXY: process.env.HTTPS_PROXY, HTTP_PROXY: process.env.HTTP_PROXY, ALL_PROXY: process.env.ALL_PROXY,
  https_proxy: process.env.https_proxy, NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy, HOME: process.env.HOME } };
if (plan.marker) writeFileSync(plan.marker, 'ran');
if (plan.direct) out.direct = await direct(plan.direct);
if (plan.allowed) out.allowed = await viaBroker('CONNECT ' + plan.allowed + ' HTTP/1.1\\r\\nHost: ' + plan.allowed + '\\r\\n\\r\\n', 'PING-THROUGH-TUNNEL');
if (plan.denied) out.denied = await viaBroker('CONNECT ' + plan.denied + ' HTTP/1.1\\r\\nHost: ' + plan.denied + '\\r\\n\\r\\n');
if (plan.forward) out.forward = await viaBroker('GET ' + plan.forward + ' HTTP/1.1\\r\\nHost: x\\r\\n\\r\\n');
out.files = {};
for (const path of plan.read ?? []) out.files['read ' + path] = attempt(() => readFileSync(path, 'utf8').trim());
for (const path of plan.write ?? []) out.files['write ' + path] = attempt(() => { writeFileSync(path, 'written'); });
process.stdout.write(JSON.stringify(out));
`;
async function provider() {
  const server = createServer((socket) => { server.connections += 1; socket.on('data', (chunk) => socket.write(chunk)); socket.on('error', () => undefined); });
  server.connections = 0;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}
/** A real boundary over fixtures: a home with a credential directory, a workspace, an outside sentinel, the CLI, and the loopback provider. */
async function boundary(dir, { executor = new NodeProcessExecutor(), journal: wrap } = {}) {
  const home = join(dir, 'home'), work = join(dir, 'work'), outside = join(dir, 'outside'), cli = join(dir, 'cli'), answers = join(dir, 'answers');
  for (const path of [home, join(home, '.ssh'), work, outside, cli, answers]) mkdirSync(path, { recursive: true });
  writeFileSync(join(work, 'inside.txt'), 'inside\n');
  writeFileSync(join(outside, 'sentinel.txt'), 'OUTSIDE-SENTINEL\n');
  writeFileSync(join(cli, 'cli.mjs'), CLI);
  const upstream = await provider();
  const port = upstream.address().port;
  const base = new FileEgressJournal(join(dir, 'egress'), clock);
  const journal = wrap ? wrap(base) : base;
  const resolved = [];
  const resolver = { async resolve(hostname) { resolved.push(hostname); return [{ address: '127.0.0.1', family: 4 }]; } };
  const model = new SeatbeltModelProcessExecutor({ runtimeReadPaths: [dirname(dirname(NODE)), cli], searchPath: `${dirname(NODE)}:/usr/bin:/bin` },
    { executor, egressJournal: journal, resolver, home, brokerLimits: { closeGraceMs: 50, connectTimeoutMs: 5_000 } });
  const scope = { actorKind: 'IMPLEMENTATION', provider: 'fixture-provider', model: 'fixture-model-1', egressDestinations: [`allowed.test:${port}`] };
  const request = (plan, overrides = {}) => ({ invocationId: randomBytes(32).toString('hex'), actorKind: 'IMPLEMENTATION', scope, executable: NODE,
    executableSha256: NODE_SHA, args: [join(cli, 'cli.mjs'), JSON.stringify(plan)], cwd: work, workspace: { path: work, mode: 'READ_WRITE' },
    writablePaths: [], readOnlyPaths: [], env: { LANG: 'C' }, stdin: '', timeoutMs: 60_000, maxStdoutBytes: 1_000_000, maxStderrBytes: 1_000_000, ...overrides });
  return { model, request, upstream, port, scope, journal: base, resolved, work, outside, answers, home, stop: () => upstream.close() };
}
const report = (outcome) => { assert.equal(outcome.isolation, 'ENFORCED', outcome.reason); assert.equal(outcome.result.exitCode, 0, outcome.result.stderr); return JSON.parse(outcome.result.stdout); };

check('real Seatbelt A-D: direct provider egress is blocked; only an allowlisted CONNECT through the broker reaches it', withDir(async (dir) => {
  const b = await boundary(dir);
  process.env.CHIEF_PARENT_ONLY_MARKER = 'parent-only';
  try {
    const plan = { direct: b.port, allowed: `allowed.test:${b.port}`, denied: `denied.test:${b.port}`, forward: `http://allowed.test:${b.port}/v1/messages` };
    const request = b.request(plan);
    const outcome = await b.model.runModel(request);
    const seen = report(outcome);
    assert.equal(seen.direct, 'EPERM', 'A: the direct connection to the provider port is refused by the kernel');
    assert.deepEqual(seen.allowed, { status: 200, echo: 'PING-THROUGH-TUNNEL' }, 'B: the allowlisted tunnel works end to end');
    assert.deepEqual(seen.denied, { status: 403 }, 'C: an unallowlisted host is refused');
    assert.deepEqual(seen.forward, { status: 405 }, 'D: a forward-proxy request is refused');
    assert.equal(b.upstream.connections, 1, 'only the allowlisted tunnel reached the provider');
    assert.deepEqual(b.resolved, ['allowed.test'], 'only the allowlisted name was resolved, by the broker');
    const proxy = seen.env.HTTPS_PROXY;
    assert.match(proxy, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.deepEqual([seen.env.HTTP_PROXY, seen.env.ALL_PROXY, seen.env.https_proxy, seen.env.NO_PROXY, seen.env.no_proxy], [proxy, proxy, proxy, '', '']);
    assert.ok(!seen.env.names.includes('CHIEF_PARENT_ONLY_MARKER'), 'nothing is inherited from the parent');
    assert.ok(seen.env.HOME !== b.home && !seen.env.HOME.startsWith(b.home), 'HOME is the per-invocation temporary directory');
    assert.equal(existsSync(seen.env.HOME), false, 'the temporary directory is removed afterwards');
    // The durable evidence: what happened, exactly, and a verdict that stops for a human.
    assert.equal(outcome.egress.status, 'RECORDED');
    assert.deepEqual(outcome.egress.summary, { sessionId: request.invocationId, allowlist: b.scope.egressDestinations, closed: true, connected: 1, denied: 2, connectFailed: 0 });
    assert.deepEqual(b.journal.get(request.invocationId).events.map((event) => [event.result, event.reason, event.requested]),
      [['CONNECTED', 'ALLOWLISTED', `allowed.test:${b.port}`], ['DENIED', 'NOT_ALLOWLISTED', `denied.test:${b.port}`], ['DENIED', 'NOT_CONNECT', null]]);
    assert.match(egressRefusal(outcome, b.scope, request.invocationId), /2 unauthorized egress connection/);
    // A clean run: one allowlisted connection and nothing else is usable evidence.
    const clean = b.request({ allowed: `allowed.test:${b.port}` });
    const cleanOutcome = await b.model.runModel(clean);
    report(cleanOutcome);
    assert.equal(egressRefusal(cleanOutcome, b.scope, clean.invocationId), undefined);
    assert.deepEqual(cleanOutcome.egress.summary, { sessionId: clean.invocationId, allowlist: b.scope.egressDestinations, closed: true, connected: 1, denied: 0, connectFailed: 0 });
  } finally {
    delete process.env.CHIEF_PARENT_ONLY_MARKER;
    b.stop();
  }
}), { requires: 'seatbelt' });
check('real Seatbelt E: the model reads and writes only its workspace as its mode allows, and the stated paths', withDir(async (dir) => {
  const b = await boundary(dir);
  try {
    const sentinel = join(b.outside, 'sentinel.txt');
    const plan = { read: ['inside.txt', sentinel, join(b.home, '.ssh')], write: ['new.txt', join(b.outside, 'x.txt'), join(b.answers, 'answer.json')] };
    const writable = report(await b.model.runModel(b.request(plan, { writablePaths: [b.answers] })));
    assert.deepEqual(writable.files, { 'read inside.txt': 'inside', [`read ${sentinel}`]: 'EPERM', [`read ${join(b.home, '.ssh')}`]: 'EPERM',
      'write new.txt': 'ok', [`write ${join(b.outside, 'x.txt')}`]: 'EPERM', [`write ${join(b.answers, 'answer.json')}`]: 'ok' });
    const readOnly = report(await b.model.runModel(b.request({ read: ['inside.txt'], write: ['other.txt', 'inside.txt', join(b.answers, 'answer.json')] },
      { workspace: { path: b.work, mode: 'READ_ONLY' }, writablePaths: [b.answers] })));
    assert.deepEqual(readOnly.files, { 'read inside.txt': 'inside', 'write other.txt': 'EPERM', 'write inside.txt': 'EPERM',
      [`write ${join(b.answers, 'answer.json')}`]: 'ok' });
    assert.equal(readFileSync(join(b.work, 'inside.txt'), 'utf8'), 'inside\n');
    assert.equal(b.upstream.connections, 0);
  } finally { b.stop(); }
}), { requires: 'seatbelt' });
check('real Seatbelt: a caller proxy, provider route, or TLS trust override refuses the run before any session or process', withDir(async (dir) => {
  const spawned = [];
  const inner = new NodeProcessExecutor();
  const executor = { run(request) { spawned.push(request.args.at(-2) ?? request.args.at(-1)); return inner.run(request); } };
  const b = await boundary(dir, { executor });
  try {
    for (const env of [{ HTTPS_PROXY: 'http://127.0.0.1:1' }, { https_proxy: 'http://127.0.0.1:1' }, { NO_PROXY: '*' }, { ALL_PROXY: 'socks5://127.0.0.1:1' },
      { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' }, { OPENAI_BASE_URL: 'http://127.0.0.1:1' }, { NODE_EXTRA_CA_CERTS: '/tmp/ca.pem' }, { CLAUDE_CODE_USE_BEDROCK: '1' }]) {
      const request = b.request({ marker: join(b.work, 'ran') }, { env: { LANG: 'C', ...env } });
      const outcome = await b.model.runModel(request);
      assert.equal(outcome.isolation, 'UNAVAILABLE', JSON.stringify(env));
      assert.match(outcome.reason, /owned or refused by the model process boundary/);
      assert.equal(b.journal.get(request.invocationId), undefined, 'no egress session was opened');
    }
    assert.deepEqual([spawned, existsSync(join(b.work, 'ran'))], [[], false], 'no process of any kind ran');
  } finally { b.stop(); }
}), { requires: 'seatbelt' });
check('real Seatbelt: a pin that fails at dispatch, a profile that does not apply, or a broker that cannot start runs no CLI', withDir(async (dir) => {
  // The pinned binary is a private copy of this Node, so it can be changed between the probe and dispatch.
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const copy = join(bin, 'node');
  copyFileSync(NODE, copy);
  chmodSync(copy, 0o755);
  const copySha = sha(copy);
  const cli = [];
  const inner = new NodeProcessExecutor();
  let onProbe = () => undefined;
  const executor = { async run(request) {
    const probe = request.args.includes('/usr/bin/true');
    if (probe) return onProbe(request) ?? inner.run(request);
    cli.push(request);
    return inner.run(request);
  } };
  const b = await boundary(dir, { executor });
  try {
    const wrongPin = b.request({ marker: join(b.work, 'ran') }, { executable: copy, executableSha256: NODE_SHA === copySha ? 'e'.repeat(64) : NODE_SHA });
    const early = await b.model.runModel(wrongPin);
    assert.deepEqual([early.isolation, /hash mismatch/.test(early.reason), b.journal.get(wrongPin.invocationId)], ['UNAVAILABLE', true, undefined]);
    onProbe = () => { appendFileSync(copy, Buffer.from([0])); return undefined; };
    const changed = b.request({ marker: join(b.work, 'ran') }, { executable: copy, executableSha256: copySha });
    const late = await b.model.runModel(changed);
    assert.deepEqual([late.isolation, /hash mismatch/.test(late.reason)], ['UNAVAILABLE', true]);
    assert.equal(b.journal.get(changed.invocationId).state, 'CLOSED', 'the session opened for it is closed with no events');
    assert.deepEqual(b.journal.get(changed.invocationId).events, []);
    onProbe = () => ({ outcome: 'EXITED', exitCode: 71, signal: null, stdout: '', stderr: 'sandbox-exec: profile rejected', durationMs: 1 });
    const unapplied = await b.model.runModel(b.request({ marker: join(b.work, 'ran') }));
    assert.deepEqual([unapplied.isolation, /could not be applied/.test(unapplied.reason)], ['UNAVAILABLE', true]);
    assert.deepEqual([cli.length, existsSync(join(b.work, 'ran'))], [0, false], 'the CLI never ran');
  } finally { b.stop(); }
  const noBroker = await boundary(join(dir, 'nb'), { journal: (inner) => ({ open: (x) => inner.open(x), record: (i, e) => inner.record(i, e),
    close: (x) => inner.close(x), get: (x) => { const s = inner.get(x); return s && { ...s, state: s.state === 'OPEN' ? 'CLOSED' : s.state }; } }) });
  try {
    const request = noBroker.request({ marker: join(noBroker.work, 'ran') });
    const outcome = await noBroker.model.runModel(request);
    assert.deepEqual([outcome.isolation, /egress broker could not start/.test(outcome.reason), existsSync(join(noBroker.work, 'ran'))], ['UNAVAILABLE', true, false]);
  } finally { noBroker.stop(); }
}), { requires: 'seatbelt' });
check('real Seatbelt: evidence that is missing, unreadable, or incomplete is AMBIGUOUS, never a clean record', withDir(async (dir) => {
  const modes = { missing: (inner, closed) => (x) => (closed.has(x) ? undefined : inner.get(x)),
    corrupt: (inner, closed) => (x) => { if (closed.has(x)) throw new Error('Egress journal checksum mismatch'); return inner.get(x); } };
  for (const [label, get] of Object.entries(modes)) {
    const closed = new Set();
    const b = await boundary(join(dir, label), { journal: (inner) => ({ open: (x) => inner.open(x), record: (i, e) => inner.record(i, e),
      close: (x) => { const s = inner.close(x); closed.add(x); return s; }, get: get(inner, closed) }) });
    try {
      const request = b.request({ allowed: `allowed.test:${b.port}` });
      const outcome = await b.model.runModel(request);
      assert.equal(outcome.isolation, 'ENFORCED', label);
      assert.equal(outcome.egress.status, 'AMBIGUOUS', label);
      assert.match(egressRefusal(outcome, b.scope, request.invocationId), /missing or ambiguous/, label);
    } finally { b.stop(); }
  }
  const faulty = await boundary(join(dir, 'fault'), { journal: (inner) => ({ open: (x) => inner.open(x), get: (x) => inner.get(x), close: (x) => inner.close(x),
    record() { throw new Error('disk full'); } }) });
  try {
    const request = faulty.request({ allowed: `allowed.test:${faulty.port}` });
    const outcome = await faulty.model.runModel(request);
    assert.deepEqual([outcome.isolation, outcome.egress.status, /could not record 1/.test(outcome.egress.reason)], ['ENFORCED', 'AMBIGUOUS', true]);
    // CONNECTED is written only once the upstream socket exists; when that write fails, the socket is torn down and no tunnel is granted.
    assert.notEqual(JSON.parse(outcome.result.stdout).allowed.status, 200, 'an unrecorded connection is never tunnelled');
  } finally { faulty.stop(); }
}), { requires: 'seatbelt' });
check('real Seatbelt: an unconfinable workspace, cwd, or path refuses the run before anything is opened', withDir(async (dir) => {
  const b = await boundary(dir);
  try {
    for (const overrides of [{ cwd: b.outside }, { workspace: { path: b.home, mode: 'READ_WRITE' }, cwd: b.home }, { writablePaths: [join(b.home, '.ssh')] },
      { readOnlyPaths: ['/'] }, { workspace: { path: b.work, mode: 'BOTH' } }, { invocationId: 'not-an-id' },
      { scope: { ...b.scope, egressDestinations: ['allowed.test'] } }, { scope: { ...b.scope, egressDestinations: [] } },
      // G1-R3C-C1: the scope must be the requesting actor's own.
      { scope: { ...b.scope, actorKind: 'ARCHITECT_REVIEW' } }, { actorKind: 'ARCHITECT_REVIEW' }, { scope: { ...b.scope, actorKind: undefined } },
      { actorKind: 'CONTROLLER', scope: { ...b.scope, actorKind: 'CONTROLLER' } }]) {
      const request = b.request({ marker: join(b.work, 'ran') }, overrides);
      const outcome = await b.model.runModel(request);
      assert.equal(outcome.isolation, 'UNAVAILABLE', JSON.stringify(overrides));
      if (/^[0-9a-f]{64}$/.test(request.invocationId)) assert.equal(b.journal.get(request.invocationId), undefined);
    }
    assert.equal(existsSync(join(b.work, 'ran')), false);
  } finally { b.stop(); }
}), { requires: 'seatbelt' });

let passed = 0, failed = 0, skipped = 0;
for (const [name, fn, requires] of tests) {
  if (requires === 'seatbelt' && !seatbelt) { console.log(`  SKIP ${name} (macOS Seatbelt unavailable on this host)`); skipped++; continue; }
  try { await fn(); console.log(`  PASS ${name}`); passed++; }
  catch (error) { console.error(`  FAIL ${name}: ${error.stack}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
if (failed) process.exitCode = 1;
