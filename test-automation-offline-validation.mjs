import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { NodeProcessExecutor, parseProcessRequest } from './dist/automation/process-executor.js';
import { SANDBOX_EXEC, SeatbeltOfflineValidationExecutor, confinedPath, seatbeltProfile } from './dist/automation/live/seatbelt-validation.js';

// The OFFLINE_VALIDATION boundary. Profile and path rules are checked everywhere; the
// executor, and the real capability checks with harmless fixtures, run where macOS
// Seatbelt is present (they are reported as skipped elsewhere). No model, provider, or
// network destination is reached: the forbidden network attempt targets a listener this
// test owns on 127.0.0.1.

const tests = [];
const check = (name, fn, { requires } = {}) => tests.push([name, fn, requires]);
const seatbelt = process.platform === 'darwin' && existsSync(SANDBOX_EXEC) &&
  spawnSync(SANDBOX_EXEC, ['-p', '(version 1)(allow default)', '/usr/bin/true']).status === 0;
function withDir(fn) {
  return async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'chief-offline-')));
    try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
}
const ok = () => ({ outcome: 'EXITED', exitCode: 0, signal: null, stdout: '', stderr: '', durationMs: 1 });
const limits = { timeoutMs: 60_000, maxStdoutBytes: 1_000_000, maxStderrBytes: 1_000_000 };
/** A fixture home with a credential directory, a validation workspace, a temporary directory, and a read-only dependency. */
function fixture(dir) {
  const home = join(dir, 'home'), work = join(dir, 'work'), temp = join(dir, 'tmp'), deps = join(dir, 'deps'), outside = join(dir, 'outside');
  for (const path of [home, join(home, '.ssh'), work, temp, deps, outside]) mkdirSync(path, { recursive: true });
  writeFileSync(join(work, 'fixture.txt'), 'inside\n');
  writeFileSync(join(deps, 'dep.txt'), 'dependency\n');
  writeFileSync(join(outside, 'sentinel.txt'), 'OUTSIDE-SENTINEL\n');
  return { home, work, temp, deps, sentinel: join(outside, 'sentinel.txt') };
}

check('the profile denies by default and allows no network, Mach service, IOKit, or IPC operation', () => {
  const { profile, parameters } = seatbeltProfile({ readTrees: ['/x/deps'], writeTrees: ['/x/work', '/x/tmp'] });
  const lines = profile.split('\n');
  assert.deepEqual(lines.slice(0, 2), ['(version 1)', '(deny default)']);
  assert.doesNotMatch(profile, /network|mach-|iokit|ipc-|allow default|file-write\* \(subpath "\/(usr|System|bin)|\(allow file-read\*\)/);
  assert.deepEqual(lines.filter((line) => line.startsWith('(allow')).map((line) => line.split(' ')[1].replace(/\)$/, '')),
    ['process-fork', 'process-exec', 'signal', 'sysctl-read', 'file-read-metadata', 'file-read*', 'file-write*']);
  const writes = lines.find((line) => line.startsWith('(allow file-write*'));
  assert.equal(writes, '(allow file-write* (literal "/dev/null") (subpath (param "W0")) (subpath (param "W1")))');
  assert.ok(!/\(param "R0"\)/.test(writes), 'a read-only dependency is never writable');
  assert.deepEqual(parameters, ['-D', 'R0=/x/deps', '-D', 'W0=/x/work', '-D', 'W1=/x/tmp', '-D', 'M0=/x']);
});
check('paths reach the profile only as parameters, never as profile text', () => {
  const odd = '/x/q"uote) (allow default';
  const { profile, parameters } = seatbeltProfile({ readTrees: [odd], writeTrees: ['/x/work'] });
  assert.ok(!profile.includes('uote') && parameters.includes(`R0=${odd}`));
  assert.throws(() => seatbeltProfile({ readTrees: ['relative'], writeTrees: [] }));
});
check('no configured path may be the root, contain the home directory, or overlap a credential location', withDir((dir) => {
  const { home, work } = fixture(dir);
  mkdirSync(join(home, 'project'));
  mkdirSync(join(home, '.ssh', 'keys'));
  assert.equal(confinedPath(join(home, 'project'), home), join(home, 'project'));
  assert.equal(confinedPath(work, home), work);
  for (const path of ['/', home, dir, join(home, '.ssh'), join(home, '.ssh', 'keys'), 'relative', join(dir, 'missing')]) {
    assert.throws(() => confinedPath(path, home), undefined, path);
  }
  for (const location of ['.aws', '.config', '.claude', '.codex', 'Library/Keychains']) {
    mkdirSync(join(home, location), { recursive: true });
    assert.throws(() => confinedPath(join(home, location), home), /credential/, location);
  }
  if (existsSync('/private/etc')) assert.throws(() => confinedPath('/private/etc', home), /credential/);
}));
check('without macOS Seatbelt the executor cannot be constructed; a relative search path is refused', () => {
  for (const platform of ['linux', 'win32']) {
    assert.throws(() => new SeatbeltOfflineValidationExecutor({ runtimeReadPaths: [], searchPath: '/usr/bin' }, { executor: {}, platform }), /unavailable/);
  }
  if (seatbelt) {
    assert.throws(() => new SeatbeltOfflineValidationExecutor({ runtimeReadPaths: [], searchPath: 'bin:/usr/bin' }, { executor: {} }), /absolute/);
  }
});
check('every command runs under sandbox-exec after a probe, with exactly the explicit environment', withDir(async (dir) => {
  const { home, work, temp, deps } = fixture(dir);
  const calls = [];
  const executor = { async run(request) { parseProcessRequest(request); calls.push(request); return ok(); } };
  const sandbox = new SeatbeltOfflineValidationExecutor({ runtimeReadPaths: [], searchPath: '/usr/bin:/bin' }, { executor, home });
  const outcome = await sandbox.runOffline({ executable: 'npm', args: ['test'], cwd: work, workspace: work, temporaryDirectory: temp,
    readOnlyPaths: [deps], env: { LANG: 'C', PATH: '/parent/path', HOME: '/parent/home' }, ...limits });
  assert.equal(outcome.isolation, 'ENFORCED');
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.executable, SANDBOX_EXEC);
    assert.deepEqual(call.env, { LANG: 'C', PATH: '/usr/bin:/bin', HOME: temp, TMPDIR: temp });
    assert.equal(call.cwd, work);
    assert.equal(call.args[call.args.indexOf('-p') + 1].split('\n')[1], '(deny default)');
  }
  assert.deepEqual(calls[0].args.slice(calls[0].args.indexOf('--') + 1), ['/usr/bin/true']);
  assert.deepEqual(calls[1].args.slice(calls[1].args.indexOf('--') + 1), ['npm', 'test']);
  assert.ok(calls[1].args.includes(`R0=${deps}`) && calls[1].args.includes(`W0=${work}`) && calls[1].args.includes(`W1=${temp}`));
}), { requires: 'seatbelt' });
check('an unavailable profile, a misplaced cwd, or an unconfinable path is UNAVAILABLE and nothing runs', withDir(async (dir) => {
  const { home, work, temp, deps } = fixture(dir);
  const request = { executable: 'npm', args: ['test'], cwd: work, workspace: work, temporaryDirectory: temp, readOnlyPaths: [deps], env: {}, ...limits };
  const calls = [];
  const failing = { async run(request) { calls.push(request); return { ...ok(), exitCode: 71, stderr: 'sandbox-exec: sandbox_apply: Operation not permitted' }; } };
  const sandbox = new SeatbeltOfflineValidationExecutor({ runtimeReadPaths: [], searchPath: '/usr/bin' }, { executor: failing, home });
  const probe = await sandbox.runOffline(request);
  assert.deepEqual([probe.isolation, /could not be applied/.test(probe.reason), calls.length], ['UNAVAILABLE', true, 1]);
  const none = { async run() { throw new Error('ran'); } };
  const strict = new SeatbeltOfflineValidationExecutor({ runtimeReadPaths: [], searchPath: '/usr/bin' }, { executor: none, home });
  for (const bad of [{ cwd: temp }, { workspace: home, cwd: home }, { readOnlyPaths: [join(home, '.ssh')] }, { readOnlyPaths: [dir] },
    { temporaryDirectory: join(dir, 'missing') }]) {
    assert.equal((await strict.runOffline({ ...request, ...bad })).isolation, 'UNAVAILABLE', JSON.stringify(bad));
  }
  const configured = new SeatbeltOfflineValidationExecutor({ runtimeReadPaths: [join(home, '.ssh')], searchPath: '/usr/bin' }, { executor: none, home });
  assert.equal((await configured.runOffline(request)).isolation, 'UNAVAILABLE');
}), { requires: 'seatbelt' });

// ---------------------------------------------------------------- real capability (harmless fixtures)
const PROBE = `import { readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
const [sentinel, port, deps] = process.argv.slice(2);
const attempt = (fn) => { try { return fn() ?? 'ok'; } catch (error) { return error.code ?? 'error'; } };
const out = {
  inside: attempt(() => readFileSync('fixture.txt', 'utf8').trim()),
  writeWorkspace: attempt(() => { writeFileSync('out.txt', 'x'); }),
  writeTemp: attempt(() => { writeFileSync(process.env.TMPDIR + '/out.txt', 'x'); }),
  dependency: attempt(() => readFileSync(deps + '/dep.txt', 'utf8').trim()),
  writeDependency: attempt(() => { writeFileSync(deps + '/dep.txt', 'poisoned'); }),
  sentinel: attempt(() => readFileSync(sentinel, 'utf8').trim()),
  environment: Object.keys(process.env).sort(),
};
out.network = await new Promise((resolve) => {
  const socket = connect({ host: '127.0.0.1', port: Number(port) });
  socket.on('connect', () => { socket.destroy(); resolve('CONNECTED'); });
  socket.on('error', (error) => resolve(error.code));
});
process.stdout.write(JSON.stringify(out));
`;
check('real Seatbelt: workspace and temp are usable; outside files, dependency writes, and the network are blocked', withDir(async (dir) => {
  const { work, temp, deps, sentinel } = fixture(dir);
  writeFileSync(join(work, 'probe.mjs'), PROBE);
  let connections = 0;
  const server = createServer((socket) => { connections += 1; socket.destroy(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.CHIEF_PARENT_ONLY_MARKER = 'parent-only';
  try {
    const node = realpathSync(process.execPath);
    const sandbox = new SeatbeltOfflineValidationExecutor({ runtimeReadPaths: [dirname(dirname(node))], searchPath: `${dirname(node)}:/usr/bin:/bin` },
      { executor: new NodeProcessExecutor() });
    const outcome = await sandbox.runOffline({ executable: 'node', args: ['probe.mjs', sentinel, String(server.address().port), deps], cwd: work,
      workspace: work, temporaryDirectory: temp, readOnlyPaths: [deps], env: { LANG: 'C' }, ...limits });
    assert.equal(outcome.isolation, 'ENFORCED', outcome.reason);
    assert.equal(outcome.result.exitCode, 0, outcome.result.stderr);
    const seen = JSON.parse(outcome.result.stdout);
    assert.deepEqual([seen.inside, seen.writeWorkspace, seen.writeTemp, seen.dependency], ['inside', 'ok', 'ok', 'dependency']);
    assert.deepEqual([seen.sentinel, seen.writeDependency], ['EPERM', 'EPERM'], 'outside read and dependency write are blocked');
    assert.notEqual(seen.network, 'CONNECTED');
    assert.equal(seen.network, 'EPERM', 'the local connection attempt is refused by the sandbox');
    assert.equal(connections, 0, 'nothing reached the listener');
    assert.ok(!seen.environment.includes('CHIEF_PARENT_ONLY_MARKER'), 'nothing is inherited from the parent');
    assert.deepEqual(seen.environment.filter((name) => !name.startsWith('__CF')), ['HOME', 'LANG', 'PATH', 'TMPDIR']);
  } finally {
    delete process.env.CHIEF_PARENT_ONLY_MARKER;
    server.close();
  }
}), { requires: 'seatbelt' });
check('real Seatbelt: a normal local fixture validation passes, a failing one fails, both enforced', withDir(async (dir) => {
  const { work, temp, deps } = fixture(dir);
  writeFileSync(join(work, 'check.mjs'), `import { readFileSync } from 'node:fs';
process.exit(readFileSync('fixture.txt', 'utf8') === 'inside\\n' && readFileSync(process.argv[2] + '/dep.txt', 'utf8') === 'dependency\\n' ? 0 : 3);`);
  const node = realpathSync(process.execPath);
  const sandbox = new SeatbeltOfflineValidationExecutor({ runtimeReadPaths: [dirname(dirname(node))], searchPath: `${dirname(node)}:/usr/bin:/bin` },
    { executor: new NodeProcessExecutor() });
  const request = { executable: 'node', args: ['check.mjs', deps], cwd: work, workspace: work, temporaryDirectory: temp, readOnlyPaths: [deps], env: {}, ...limits };
  const passed = await sandbox.runOffline(request);
  assert.deepEqual([passed.isolation, passed.result.outcome, passed.result.exitCode], ['ENFORCED', 'EXITED', 0], passed.result?.stderr);
  writeFileSync(join(work, 'fixture.txt'), 'changed\n');
  const failed = await sandbox.runOffline(request);
  assert.deepEqual([failed.isolation, failed.result.exitCode], ['ENFORCED', 3]);
}), { requires: 'seatbelt' });

let passed = 0, failed = 0, skipped = 0;
for (const [name, fn, requires] of tests) {
  if (requires === 'seatbelt' && !seatbelt) { console.log(`  SKIP ${name} (macOS Seatbelt unavailable on this host)`); skipped++; continue; }
  try { await fn(); console.log(`  PASS ${name}`); passed++; }
  catch (error) { console.error(`  FAIL ${name}: ${error.stack}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
if (failed) process.exitCode = 1;
