import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NodeProcessExecutor, SyncNodeProcessExecutor, environmentFromAllowlist, isRefusedEnvironmentName, parseProcessRequest,
} from './dist/automation/process-executor.js';

// Local fixture processes only: this Node binary running inline scripts.
const NODE = process.execPath;
const tests = [];
const check = (name, fn) => tests.push([name, fn]);
const executor = new NodeProcessExecutor();
const sync = new SyncNodeProcessExecutor();
const env = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function withDir(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chief-process-'));
    try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
}
const request = (dir, script, overrides = {}) => ({ executable: NODE, args: ['-e', script], cwd: dir, timeoutMs: 10_000,
  maxStdoutBytes: 1_000_000, maxStderrBytes: 1_000_000, env, ...overrides });

check('argv is passed exactly, never through a shell', withDir(async (dir) => {
  const hostile = ['a b', '$(echo pwned)', '; touch pwned', '|cat', '`id`', '*', "'quoted'"];
  const result = await executor.run(request(dir, 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', { args: ['-e',
    'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...hostile] }));
  assert.deepEqual([result.outcome, result.exitCode], ['EXITED', 0]);
  assert.deepEqual(JSON.parse(result.stdout), hostile);
  assert.equal(existsSync(join(dir, 'pwned')), false);
  assert.deepEqual(JSON.parse(sync.runSync(request(dir, '', { args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...hostile] })).stdout), hostile);
}));
check('shell launchers and a shell option are refused before anything runs', withDir((dir) => {
  for (const executable of ['bash', '/bin/sh', 'zsh', '/usr/bin/env', 'pwsh', 'cmd.exe']) {
    assert.throws(() => parseProcessRequest(request(dir, '', { executable })), undefined, executable);
  }
  assert.throws(() => parseProcessRequest({ ...request(dir, ''), shell: true }));
  assert.throws(() => parseProcessRequest({ ...request(dir, ''), mode: 'shell' }));
}));
check('a timeout terminates the process and reports it', withDir(async (dir) => {
  const result = await executor.run(request(dir, 'setInterval(() => {}, 1000)', { timeoutMs: 300 }));
  assert.deepEqual([result.outcome, result.exitCode, result.signal], ['TIMED_OUT', null, 'SIGTERM']);
  assert.ok(result.durationMs < 5000);
}));
check('a process that ignores SIGTERM is hard-killed after the grace period', withDir(async (dir) => {
  const result = await executor.run(request(dir, 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)',
    { timeoutMs: 400, killGraceMs: 300 }));
  assert.deepEqual([result.outcome, result.signal], ['TIMED_OUT', 'SIGKILL']);
}));
check('a timed-out run is not retried, and its whole process group is terminated', withDir(async (dir) => {
  const starts = join(dir, 'starts'), late = join(dir, 'late');
  const script = `require('fs').appendFileSync(${JSON.stringify(starts)}, 'x');
    require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => require("fs").writeFileSync(${JSON.stringify(late)}, "alive"), 900)'], { stdio: 'ignore' });
    setInterval(() => {}, 1000);`;
  const result = await executor.run(request(dir, script, { timeoutMs: 400, killGraceMs: 100 }));
  assert.equal(result.outcome, 'TIMED_OUT');
  await sleep(1200);
  assert.equal(readFileSync(starts, 'utf8'), 'x');
  assert.equal(existsSync(late), false);
}));
check('stdout and stderr limits are enforced', withDir(async (dir) => {
  const out = await executor.run(request(dir, 'process.stdout.write("x".repeat(2_000_000)); setInterval(() => {}, 1000)', { maxStdoutBytes: 1000 }));
  assert.equal(out.outcome, 'OUTPUT_LIMIT');
  assert.ok(out.stdout.length <= 1000);
  const err = await executor.run(request(dir, 'process.stderr.write("y".repeat(2_000_000)); setInterval(() => {}, 1000)', { maxStderrBytes: 500 }));
  assert.equal(err.outcome, 'OUTPUT_LIMIT');
  assert.ok(err.stderr.length <= 500);
  const syncOut = sync.runSync(request(dir, 'process.stdout.write("x".repeat(200000))', { maxStdoutBytes: 1000 }));
  assert.equal(syncOut.outcome, 'OUTPUT_LIMIT');
  assert.ok(syncOut.stdout.length <= 1000);
}));
check('an invalid cwd, timeout, limit, or NUL is refused before spawning', withDir(async (dir) => {
  const file = join(dir, 'file');
  writeFileSync(file, '');
  for (const cwd of [join(dir, 'missing'), 'relative/dir', file]) assert.throws(() => parseProcessRequest(request(dir, '', { cwd })), undefined, cwd);
  for (const timeoutMs of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN, '100', 7 * 60 * 60 * 1000, undefined]) {
    assert.throws(() => parseProcessRequest(request(dir, '', { timeoutMs })), undefined, String(timeoutMs));
  }
  for (const limit of [0, -5, Number.POSITIVE_INFINITY, undefined]) {
    assert.throws(() => parseProcessRequest(request(dir, '', { maxStdoutBytes: limit })));
    assert.throws(() => parseProcessRequest(request(dir, '', { maxStderrBytes: limit })));
  }
  assert.throws(() => parseProcessRequest(request(dir, '', { args: ['-e', 'a\0b'] })));
  assert.throws(() => parseProcessRequest(request(dir, '', { executable: `${NODE}\0x` })));
  assert.throws(() => parseProcessRequest(request(dir, '', { env: { PATH: 'a\0b' } })));
  await assert.rejects(executor.run(request(dir, '', { cwd: join(dir, 'missing') })));
}));
check('the environment is exactly what the request states', withDir(async (dir) => {
  process.env.CHIEF_TEST_LEAK = 'inherited';
  process.env.CHIEF_TEST_API_KEY = 'sk-should-never-appear';
  try {
    const given = { PATH: env.PATH, CHIEF_VISIBLE: 'yes' };
    const result = await executor.run(request(dir, 'process.stdout.write(JSON.stringify(process.env))', { env: given }));
    const seen = JSON.parse(result.stdout);
    assert.equal(seen.CHIEF_VISIBLE, 'yes');
    assert.equal(seen.CHIEF_TEST_LEAK, undefined);
    assert.ok(!JSON.stringify(seen).includes('sk-should-never-appear'));
    assert.ok(Object.keys(seen).every((name) => name in given || name.startsWith('__CF')), Object.keys(seen).join());
  } finally {
    delete process.env.CHIEF_TEST_LEAK;
    delete process.env.CHIEF_TEST_API_KEY;
  }
}));
check('credential-bearing names are refused, even when named explicitly', withDir((dir) => {
  const refused = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CODEX_ACCESS_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN', 'AWS_SECRET_ACCESS_KEY',
    'AWS_REGION', 'SSH_AUTH_SOCK', 'MY_SERVICE_SECRET', 'DB_PASSWORD', 'NPM_AUTH', 'SESSION_COOKIE', 'NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES'];
  for (const name of refused) {
    assert.ok(isRefusedEnvironmentName(name), name);
    assert.throws(() => parseProcessRequest(request(dir, '', { env: { ...env, [name]: 'x' } })), undefined, name);
    assert.throws(() => environmentFromAllowlist({ [name]: 'x' }, [name]), undefined, name);
  }
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'TERM', 'KEYCHAIN_NAME']) assert.equal(isRefusedEnvironmentName(name), false, name);
  assert.deepEqual(environmentFromAllowlist({ PATH: '/bin', HOME: '/h', OTHER: 'o' }, ['PATH', 'HOME', 'LANG']), { PATH: '/bin', HOME: '/h' });
  assert.throws(() => environmentFromAllowlist({}, ['BAD NAME']));
}));
check('stdin is delivered and a missing executable is a spawn failure, not a crash', withDir(async (dir) => {
  const echoed = await executor.run(request(dir, 'process.stdin.pipe(process.stdout)', { stdin: 'prompt text' }));
  assert.equal(echoed.stdout, 'prompt text');
  const missing = await executor.run(request(dir, '', { executable: join(dir, 'no-such-binary') }));
  assert.equal(missing.outcome, 'SPAWN_FAILED');
  assert.equal(sync.runSync(request(dir, '', { executable: join(dir, 'no-such-binary') })).outcome, 'SPAWN_FAILED');
}));
check('the synchronous executor enforces the same timeout and reports it', withDir((dir) => {
  const result = sync.runSync(request(dir, 'setInterval(() => {}, 1000)', { timeoutMs: 300 }));
  assert.deepEqual([result.outcome, result.signal], ['TIMED_OUT', 'SIGKILL']);
}));
check('process-executor source has no shell path', () => {
  const source = readFileSync('src/automation/process-executor.ts', 'utf8');
  assert.match(source, /shell: false/);
  assert.doesNotMatch(source, /shell: true|\bexec(Sync)?\(|execFile|eval\(|bash -lc|process\.env/);
});

let passed = 0, failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`  PASS ${name}`); passed++; }
  catch (error) { console.error(`  FAIL ${name}: ${error.stack}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
