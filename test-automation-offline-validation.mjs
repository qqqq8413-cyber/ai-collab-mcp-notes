import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FileInvocationJournal } from './dist/automation/file-invocation-journal.js';
import { invocationIdOf } from './dist/automation/invocation-journal.js';
import { packetHash } from './dist/automation/packet.js';
import { NodeProcessExecutor, parseProcessRequest } from './dist/automation/process-executor.js';
import { ClaudeCodeImplementationAdapter } from './dist/automation/live/claude-code-implementation.js';
import { SANDBOX_EXEC, SeatbeltOfflineValidationExecutor, confinedPath, seatbeltProfile } from './dist/automation/live/seatbelt-validation.js';
import { GovernanceStoreIsolation } from './dist/automation/governance-store-isolation.js';

// The OFFLINE_VALIDATION boundary. Profile and path rules are checked everywhere; the
// executor, and the real capability checks with harmless fixtures, run where macOS
// Seatbelt is present (they are reported as skipped elsewhere). No model, provider, or
// network destination is reached: the forbidden network attempt targets a listener this
// test owns on 127.0.0.1.

/** G1-R4T-1: the protected governance roots every Seatbelt boundary must know. Holds no store capability. */
const GOVERNANCE_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'chief-governance-')));
for (const name of ['controller', 'authority']) mkdirSync(join(GOVERNANCE_DIR, name), { mode: 0o700 });
process.on('exit', () => rmSync(GOVERNANCE_DIR, { recursive: true, force: true }));
const GOVERNANCE = GovernanceStoreIsolation.forLiveRoots({ controllerStoreDirectory: join(GOVERNANCE_DIR, 'controller'),
  authorityArchiveDirectory: join(GOVERNANCE_DIR, 'authority') });
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
    assert.throws(() => new SeatbeltOfflineValidationExecutor({ runtimeReadPaths: [], searchPath: '/usr/bin' }, { governance: GOVERNANCE, executor: {}, platform }), /unavailable/);
  }
  if (seatbelt) {
    assert.throws(() => new SeatbeltOfflineValidationExecutor({ runtimeReadPaths: [], searchPath: 'bin:/usr/bin' }, { governance: GOVERNANCE, executor: {} }), /absolute/);
  }
});
check('every command runs under sandbox-exec after a probe, with exactly the explicit environment', withDir(async (dir) => {
  const { home, work, temp, deps } = fixture(dir);
  const calls = [];
  const executor = { async run(request) { parseProcessRequest(request); calls.push(request); return ok(); } };
  const sandbox = new SeatbeltOfflineValidationExecutor({ runtimeReadPaths: [], searchPath: '/usr/bin:/bin' }, { governance: GOVERNANCE, executor, home });
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
  const sandbox = new SeatbeltOfflineValidationExecutor({ runtimeReadPaths: [], searchPath: '/usr/bin' }, { governance: GOVERNANCE, executor: failing, home });
  const probe = await sandbox.runOffline(request);
  assert.deepEqual([probe.isolation, /could not be applied/.test(probe.reason), calls.length], ['UNAVAILABLE', true, 1]);
  const none = { async run() { throw new Error('ran'); } };
  const strict = new SeatbeltOfflineValidationExecutor({ runtimeReadPaths: [], searchPath: '/usr/bin' }, { governance: GOVERNANCE, executor: none, home });
  for (const bad of [{ cwd: temp }, { workspace: home, cwd: home }, { readOnlyPaths: [join(home, '.ssh')] }, { readOnlyPaths: [dir] },
    { temporaryDirectory: join(dir, 'missing') }]) {
    assert.equal((await strict.runOffline({ ...request, ...bad })).isolation, 'UNAVAILABLE', JSON.stringify(bad));
  }
  const configured = new SeatbeltOfflineValidationExecutor({ runtimeReadPaths: [join(home, '.ssh')], searchPath: '/usr/bin' }, { governance: GOVERNANCE, executor: none, home });
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
      { governance: GOVERNANCE, executor: new NodeProcessExecutor() });
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
    { governance: GOVERNANCE, executor: new NodeProcessExecutor() });
  const request = { executable: 'node', args: ['check.mjs', deps], cwd: work, workspace: work, temporaryDirectory: temp, readOnlyPaths: [deps], env: {}, ...limits };
  const passed = await sandbox.runOffline(request);
  assert.deepEqual([passed.isolation, passed.result.outcome, passed.result.exitCode], ['ENFORCED', 'EXITED', 0], passed.result?.stderr);
  writeFileSync(join(work, 'fixture.txt'), 'changed\n');
  const failed = await sandbox.runOffline(request);
  assert.deepEqual([failed.isolation, failed.result.exitCode], ['ENFORCED', 3]);
}), { requires: 'seatbelt' });

// ---------------------------------------------------------------- packet-scoped validation view (real local Git)
const SENTINEL = 'OUTSIDE-TRACKED-SENTINEL';
const BRANCH = 'work/scoped-validation';
const EGRESS = Object.freeze(['api.anthropic.com:443', 'platform.claude.com:443']);
// The pinned executable is this Node binary: real bytes, not a script. The fake model process never runs it.
const CLAUDE = { executable: realpathSync(process.execPath), executableSha256: createHash('sha256').update(readFileSync(realpathSync(process.execPath))).digest('hex'),
  provider: 'anthropic', model: 'claude-opus-5-5', egressDestinations: [...EGRESS], timeoutMs: 600_000, maxTurns: 40, maxStdoutBytes: 1_000_000,
  maxStderrBytes: 1_000_000 };
// Validation code inside the packet scope that tries to see the rest of the repository.
const CHECK = `import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const attempt = (path) => { try { return readFileSync(path, 'utf8').trim(); } catch (error) { return error.code; } };
const view = [];
const walk = (dir, rel) => { for (const name of readdirSync(dir)) { const path = rel ? rel + '/' + name : name;
  if (lstatSync(join(dir, name)).isDirectory()) walk(join(dir, name), path); else view.push(path); } };
walk('..', '');
const seen = { input: attempt('input.txt'), code: attempt('code.js'), dependency: attempt('../node_modules/dep.txt'),
  relative: attempt('../outside/secret.txt'), absolute: process.argv.slice(2).map(attempt), view: view.sort() };
process.stdout.write(JSON.stringify(seen));
const leaked = [seen.relative, ...seen.absolute].some((value) => !/^E[A-Z]+$/.test(value));
process.exit(leaked ? 7 : seen.input === 'allowed input' && seen.code === 'export const value = 2;' ? 0 : 3);
`;
/** Every file under a directory whose content carries the sentinel; symlinks are not followed. */
function sentinelFiles(root) {
  if (!existsSync(root)) return [];
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stats = lstatSync(path);
      if (stats.isDirectory()) walk(path);
      else if (stats.isFile() && readFileSync(path, 'utf8').includes(SENTINEL)) hits.push(path);
    }
  };
  walk(root);
  return hits;
}
/**
 * One implementation iteration against a real local repository whose base commit tracks
 * allowed/{code.js,input.txt,check.mjs}, outside/{secret.txt,file.ts,leak.mjs}, .github, and a
 * package.json whose test script prints the secret. allowedAreas = ["allowed"]; the fake model
 * changes allowed/code.js. Git, worktree, commit, and push are real.
 */
async function scopedIteration(dir, { validation, commands, worktreesInClone = false }) {
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (cwd, ...args) => {
    const out = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'init.defaultBranch=main', ...args], { cwd, env, encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    return out.stdout.trim();
  };
  const origin = join(dir, 'origin.git'), seed = join(dir, 'seed'), clone = join(dir, 'clone'), deps = join(dir, 'deps');
  mkdirSync(seed);
  mkdirSync(deps);
  writeFileSync(join(deps, 'dep.txt'), 'dependency\n');
  const files = { 'allowed/code.js': 'export const value = 1;\n', 'allowed/input.txt': 'allowed input\n', 'allowed/check.mjs': CHECK,
    'outside/secret.txt': `${SENTINEL}\n`, 'outside/file.ts': 'export {};\n', 'outside/leak.mjs': "import { readFileSync } from 'node:fs'; console.log(readFileSync('outside/secret.txt', 'utf8'));\n",
    '.github/workflows/ci.yml': 'name: ci\n', 'package.json': '{"name":"fixture","private":true,"scripts":{"test":"node outside/leak.mjs"}}\n' };
  for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(seed, path)), { recursive: true }); writeFileSync(join(seed, path), content); }
  git(dir, 'init', '-q', '--bare', origin);
  git(seed, 'init', '-q');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'base');
  const base = git(seed, 'rev-parse', 'HEAD');
  git(seed, 'push', '-q', origin, 'HEAD:refs/heads/main');
  git(dir, 'clone', '-q', origin, clone);
  const worktreeRoot = worktreesInClone ? join(clone, '.worktrees') : join(dir, 'worktrees');
  mkdirSync(worktreeRoot);
  const worktree = join(worktreeRoot, invocationIdOf('run-1', 4, 'IMPLEMENTATION'));
  const packet = { packetId: 'packet-1', packetVersion: 1, sliceId: 'slice-1', expectedBaseSha: base, targetBranch: BRANCH,
    objective: 'Scoped validation fixture', allowedAreas: ['allowed'], forbiddenChanges: ['.github'], invariants: ['human authority retained'],
    acceptanceCriteria: ['offline checks pass'], validationCommands: commands({ worktree, clone }),
    networkAuthorization: { level: 'WRITE_EXTERNAL', destinations: [BRANCH, ...EGRESS], purpose: 'fixture', budget: 1 },
    providerCallAuthorization: { allowed: true, calls: [{ actorKind: 'IMPLEMENTATION', provider: CLAUDE.provider, model: CLAUDE.model,
      egressDestinations: [...EGRESS] }], maxCalls: 6, budget: 0 },
    destructiveOperationAuthorization: { allowed: false },
    iterationBudget: { maxImplementationIterationsPerSlice: 3, maxAcceptanceFailuresPerSlice: 3, maxRuntimeMinutesPerIteration: 60,
      maxParallelImplementationAgents: 1 } };
  const clock = { now: () => '2026-09-29T00:00:00.000Z' };
  const journal = new FileInvocationJournal(join(dir, 'journal'), clock);
  const invocationId = journal.prepare({ runId: 'run-1', sliceId: 'slice-1', packetId: packet.packetId, packetHash: packetHash(packet),
    occurrence: { sequence: 4, action: 'BEGIN_IMPLEMENTATION', timestamp: clock.now() }, actorKind: 'IMPLEMENTATION', provider: CLAUDE.provider,
    model: CLAUDE.model, egressDestinations: [...EGRESS], authorizationId: 'auth' }).invocationId;
  journal.start(invocationId, 10);
  const executor = new NodeProcessExecutor();
  // A fake egress-bound model process: it edits the model workspace and reports clean broker evidence.
  const model = { async runModel(request) {
    writeFileSync(join(request.cwd, 'allowed/code.js'), 'export const value = 2;\n');
    return { isolation: 'ENFORCED', egress: { status: 'RECORDED', summary: { sessionId: request.invocationId, allowlist: [...request.scope.egressDestinations],
      closed: true, connected: 1, denied: 0, connectFailed: 0 } },
    result: { outcome: 'EXITED', exitCode: 0, signal: null, stderr: '', durationMs: 1, stdout: JSON.stringify({ type: 'result', subtype: 'success',
      is_error: false, structured_output: { status: 'COMPLETED', reason: 'done' }, modelUsage: { [CLAUDE.model]: {} } }) } };
  } };
  const adapter = new ClaudeCodeImplementationAdapter({ claude: CLAUDE, environment: env, git: { executable: 'git', remote: 'origin', repositoryPath: clone,
    worktreeRoot, timeoutMs: 60_000, maxOutputBytes: 1_000_000, commitAuthor: { name: 'CHIEF automation', email: 'automation@example.invalid' },
    validationTimeoutMs: 120_000, validationMaxOutputBytes: 1_000_000, linkedDirectories: [{ path: 'node_modules', source: deps }] } },
  { executor, model, validation, journal, clock });
  const result = await adapter.execute({ runId: 'run-1', sliceId: 'slice-1', implementationIteration: 1, packet, packetHash: packetHash(packet), invocationId });
  const pushed = spawnSync('git', ['rev-parse', '--verify', '-q', `refs/heads/${BRANCH}`], { cwd: origin, env, encoding: 'utf8' }).stdout.trim();
  const leaks = [`${worktree}.validation`, `${worktree}.logs`, `${worktree}.tmp`, `${worktree}.model`].flatMap(sentinelFiles);
  const seen = () => JSON.parse(readFileSync(join(`${worktree}.logs`, 'validation-0.log'), 'utf8').split('--- stdout\n')[1].split('\n--- stderr')[0]);
  return { result, worktree, clone, pushed, leaks, seen };
}
const scopedCommand = (args = []) => ({ commandId: 'scoped', executable: 'node', args: ['check.mjs', ...args], cwd: 'allowed', classification: 'OFFLINE_VALIDATION' });
const EXPECTED_VIEW = ['allowed/check.mjs', 'allowed/code.js', 'allowed/input.txt', 'node_modules'];
// Runs each command directly in the view: this checks what the repository view holds, with no host boundary; the Seatbelt checks add that boundary.
const viewOnly = { async runOffline(request) {
  return { isolation: 'ENFORCED', result: await new NodeProcessExecutor().run({ executable: request.executable, args: [...request.args], cwd: request.cwd,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: request.temporaryDirectory, TMPDIR: request.temporaryDirectory }, ...limits }) };
} };
const seatbeltValidation = () => {
  const node = realpathSync(process.execPath);
  return new SeatbeltOfflineValidationExecutor({ runtimeReadPaths: [dirname(dirname(node))], searchPath: `${dirname(node)}:/usr/bin:/bin` },
    { governance: GOVERNANCE, executor: new NodeProcessExecutor() });
};

check('real git: the validation view holds only allowedAreas; the out-of-scope tracked sentinel is absent and allowed reads succeed', withDir(async (dir) => {
  const run = await scopedIteration(dir, { validation: viewOnly, commands: () => [scopedCommand()] });
  assert.equal(run.result.status, 'COMPLETED', run.result.reason);
  assert.ok(/^[0-9a-f]{40}$/.test(run.pushed), 'delivered');
  const seen = run.seen();
  assert.deepEqual(seen.view, EXPECTED_VIEW);
  assert.deepEqual([seen.input, seen.code, seen.dependency, seen.relative], ['allowed input', 'export const value = 2;', 'dependency', 'ENOENT']);
  for (const absent of ['.github/workflows/ci.yml', 'outside/file.ts', 'outside/secret.txt', 'package.json', '.git']) {
    assert.ok(!existsSync(join(`${run.worktree}.validation`, absent)), absent);
  }
  assert.deepEqual(run.leaks, []);
  assert.ok(!JSON.stringify(run.result).includes(SENTINEL));
}));
check('real git + Seatbelt: the out-of-scope sentinel is neither in the view nor reachable on the host', withDir(async (dir) => {
  const run = await scopedIteration(dir, { validation: seatbeltValidation(), worktreesInClone: true,
    commands: ({ worktree, clone }) => [scopedCommand([join(worktree, 'outside/secret.txt'), join(clone, 'outside/secret.txt')])] });
  assert.equal(run.result.status, 'COMPLETED', run.result.reason);
  const seen = run.seen();
  assert.deepEqual(seen.view, EXPECTED_VIEW);
  assert.deepEqual([seen.input, seen.code, seen.dependency, seen.relative], ['allowed input', 'export const value = 2;', 'dependency', 'ENOENT']);
  assert.deepEqual(seen.absolute, ['EPERM', 'EPERM'], 'the delivery worktree and the clone are outside the sandbox');
  assert.deepEqual(run.leaks, []);
  assert.ok(!JSON.stringify(run.result).includes(SENTINEL));
}), { requires: 'seatbelt' });
check('real git + Seatbelt: a project-wide command fails without widening the view or reaching the secret', withDir(async (dir) => {
  const run = await scopedIteration(dir, { validation: seatbeltValidation(), worktreesInClone: true,
    commands: () => [{ commandId: 'project', executable: 'npm', args: ['test'], cwd: '.', classification: 'OFFLINE_VALIDATION' }] });
  assert.equal(run.result.status, 'SOFT_STOP');
  assert.match(run.result.reason, /^validation project failed: EXITED exit \d+$/);
  assert.equal(run.pushed, '', 'nothing delivered');
  const view = `${run.worktree}.validation`;
  const listing = [];
  const walk = (path, rel) => { for (const name of readdirSync(path)) { const p = rel ? `${rel}/${name}` : name;
    if (lstatSync(join(path, name)).isDirectory()) walk(join(path, name), p); else listing.push(p); } };
  walk(view, '');
  assert.deepEqual(listing.sort(), EXPECTED_VIEW, 'the view was not widened');
  assert.deepEqual(run.leaks, []);
  assert.ok(!JSON.stringify(run.result).includes(SENTINEL));
}), { requires: 'seatbelt' });

let passed = 0, failed = 0, skipped = 0;
for (const [name, fn, requires] of tests) {
  if (requires === 'seatbelt' && !seatbelt) { console.log(`  SKIP ${name} (macOS Seatbelt unavailable on this host)`); skipped++; continue; }
  try { await fn(); console.log(`  PASS ${name}`); passed++; }
  catch (error) { console.error(`  FAIL ${name}: ${error.stack}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
if (failed) process.exitCode = 1;
