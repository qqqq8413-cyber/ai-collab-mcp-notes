import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PilotEngine } from './dist/pilot/engine.js';
import { PilotStore } from './dist/pilot/store.js';
import { REPOSITORY, LIMITS } from './dist/pilot/model.js';
import { GitHubActionsReader, safeGitHubUrl } from './dist/pilot/github.js';
import { parseWorkspaceConfig } from './dist/workspace/config.js';
import { startWorkspaceServer } from './dist/workspace/server.js';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  PASS ' + name); passed++; }
  catch (e) { console.error('  FAIL ' + name + ': ' + e.stack); failed++; }
}
const ci = (patch = {}) => ({ id: 101, attempt: 1, number: 124, name: 'CI', sha: 'a'.repeat(40), branch: 'work/unit-test',
  status: 'completed', conclusion: 'success', event: 'push', updatedAt: '2026-10-20T00:00:00Z',
  url: `https://github.com/${REPOSITORY}/actions/runs/101`, jobs: [{ id: 102, name: 'r4t-macos', status: 'completed', conclusion: 'success',
    labels: ['macos-latest'], platform: 'MACOS', url: `https://github.com/${REPOSITORY}/actions/runs/101/job/102`, steps: [], requiredMacSkip: false }], ...patch });
async function fixture(fn, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'chief-auto-p1-'));
  let now = Date.parse('2026-10-20T00:00:00Z'), calls = 0, snapshot = [ci()];
  const reader = options.reader ?? { async read() { calls++; return structuredClone(snapshot); } };
  const make = () => new PilotEngine({ dataDirectory: dir, projects: ['chief', 'other'], reader, clock: () => now, timeoutMs: options.timeoutMs });
  let engine = make();
  const ctx = { dir, get e() { return engine; }, get calls() { return calls; }, advance(ms) { now += ms; }, snapshot(v) { snapshot = v; },
    view(p = 'chief') { return engine.read(p); },
    task(patch = {}, p = 'chief') { const spec = { requestId: randomUUID(), name: 'CI WATCH', type: 'CI_WATCH', mode: 'MANUAL', intervalSeconds: 60, maxRetries: 1, ...patch }; engine.create(p, spec); return spec.requestId; },
    action(id, action = 'RUN', requestId = randomUUID(), p = 'chief') { return engine.action(p, id, { action, requestId }); },
    async restart() { await engine.close(); engine = make(); },
  };
  try { await fn(ctx); } finally { await engine.close(); rmSync(dir, { recursive: true, force: true }); }
}

await test('task creation is durable and schedules are OFF by default', () => fixture(async f => {
  const id = f.task({ mode: 'SCHEDULED' }); assert.equal(f.view().tasks[0].enabled, false);
  await f.restart(); assert.equal(f.view().tasks[0].id, id); await f.e.tick(); assert.equal(f.calls, 0);
}));
await test('duplicate create is idempotent and conflicting create is refused', () => fixture(f => {
  const id = f.task(), task = f.view().tasks[0];
  const spec = Object.fromEntries(['requestId', 'name', 'type', 'mode', 'intervalSeconds', 'maxRetries'].map(k => [k, task[k]]));
  f.e.create('chief', spec); assert.equal(f.view().tasks.length, 1);
  assert.throws(() => f.e.create('chief', { ...spec, name: 'changed' }), /相同請求/);
}));
await test('AI type and forged authority fields are refused without dispatch', () => fixture(f => {
  assert.throws(() => f.task({ type: 'AI_WORK' })); assert.throws(() => f.task({ authority: 'HUMAN' }));
  assert.equal(f.view().tasks.length, 0); assert.equal(f.calls, 0); assert.equal(f.view().exe, 'HOLD');
}));
await test('interval and retry resource limits are runtime validated', () => fixture(f => {
  for (const patch of [{ intervalSeconds: 1 }, { intervalSeconds: 86401 }, { maxRetries: 3 }, { maxRetries: -1 }]) assert.throws(() => f.task(patch));
}));
await test('source task is project-bound and must be a CI watch', () => fixture(f => {
  const id = f.task(); assert.throws(() => f.task({ type: 'CI_REPORT', sourceTaskId: id }, 'other'));
  assert.throws(() => f.task({ mode: 'EVENT_DRIVEN' }));
}));
await test('manual run traverses QUEUED -> RUNNING -> COMPLETED with real-source-shaped evidence', () => fixture(async f => {
  const id = f.task(); f.action(id); assert.equal(f.view().runs[0].state, 'QUEUED');
  await f.e.drain(); const run = f.view().runs[0]; assert.equal(run.state, 'COMPLETED'); assert.equal(f.calls, 1);
  assert.equal(run.result.source, 'GITHUB_ACTIONS'); assert.deepEqual(run.steps, ['QUEUED', 'STARTED_READ_ONLY', 'VALIDATED_SOURCE', 'PERSISTED_RESULT']);
}));
await test('manual duplicate requests do not run twice, including after restart', () => fixture(async f => {
  const id = f.task(), key = randomUUID(); f.action(id, 'RUN', key); f.action(id, 'RUN', key);
  await f.e.drain(); await f.restart(); f.action(id, 'RUN', key); await f.e.drain();
  assert.equal(f.calls, 1); assert.equal(f.view().runs.length, 1);
}));
await test('same task cannot queue unlimited parallel work', () => fixture(f => {
  const id = f.task(); f.action(id); assert.throws(() => f.action(id), /同一工作/); assert.equal(f.view().runs.length, 1);
}));
await test('operation request identity cannot be reused for a different action', () => fixture(f => {
  const id = f.task({ mode: 'SCHEDULED' }), key = randomUUID(); f.action(id, 'ENABLE', key);
  assert.throws(() => f.action(id, 'PAUSE', key), /相同請求/);
}));
await test('schedule triggers once per due slot, resumes after restart, and skips missed bursts', () => fixture(async f => {
  const id = f.task({ mode: 'SCHEDULED' }); f.action(id, 'ENABLE'); await f.restart();
  f.advance(60000); await f.e.tick(); await f.e.tick(); assert.equal(f.calls, 1);
  f.advance(600000); await f.e.tick(); assert.equal(f.calls, 2); assert.equal(f.view().runs[1].trigger, 'SCHEDULED');
}));
await test('pausing the schedule does not cancel already queued work', () => fixture(async f => {
  const id = f.task({ mode: 'SCHEDULED' }); f.action(id, 'ENABLE'); f.action(id); f.action(id, 'PAUSE');
  await f.e.drain(); f.advance(120000); await f.e.tick(); assert.equal(f.calls, 1); assert.equal(f.view().tasks[0].enabled, false);
}));
await test('cancelling queued work dispatches nothing and is distinct from stopping schedules', () => fixture(async f => {
  const id = f.task({ mode: 'SCHEDULED' }); f.action(id, 'ENABLE'); f.action(id); f.action(id, 'CANCEL');
  await f.e.drain(); assert.equal(f.calls, 0); assert.equal(f.view().runs[0].state, 'CANCELLED'); assert.equal(f.view().tasks[0].enabled, true);
}));
await test('stop aborts a running reader and disables future scheduling', async () => {
  let entered;
  const started = new Promise(r => { entered = r; });
  await fixture(async f => {
    const id = f.task({ mode: 'SCHEDULED' }); f.action(id, 'ENABLE'); f.action(id); const work = f.e.drain();
    await started; f.action(id, 'STOP'); await work;
    assert.equal(f.view().runs[0].state, 'CANCELLED'); assert.equal(f.view().tasks[0].enabled, false);
  }, { reader: { read(signal) { entered(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('CANCELLED')), { once: true })); } } });
});
await test('single global drain serializes different tasks', async () => {
  let concurrent = 0, max = 0;
  await fixture(async f => {
    const a = f.task(), b = f.task(); f.action(a); f.action(b); await Promise.all([f.e.drain(), f.e.drain()]);
    assert.equal(max, 1); assert.equal(f.view().runs.filter(r => r.state === 'COMPLETED').length, 2);
  }, { reader: { async read() { max = Math.max(max, ++concurrent); await new Promise(r => setTimeout(r, 10)); concurrent--; return [ci()]; } } });
});
await test('bounded deadline aborts a hung reader and distinguishes timeout from user cancellation', () => fixture(async f => {
  const id = f.task(); f.action(id); await f.e.drain(); assert.equal(f.view().runs[0].state, 'FAILED'); assert.equal(f.view().runs[0].error, 'READ_TIMEOUT');
}, { timeoutMs: 20, reader: { read(signal) { return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('CANCELLED_OR_TIMEOUT')), { once: true })); } } }));
await test('unchanged snapshots do not duplicate CI observations', () => fixture(async f => {
  const id = f.task(); f.action(id); await f.e.drain(); const before = f.view().changes.length;
  f.action(id); await f.e.drain(); assert.equal(f.view().ci.length, 1); assert.equal(f.view().changes.length, before); assert.equal(f.view().runs.length, 2);
}));
await test('event-driven reports run only on verified state change, not baseline or AI text', () => fixture(async f => {
  const watch = f.task(), report = f.task({ type: 'CI_REPORT', sourceTaskId: watch, mode: 'EVENT_DRIVEN' });
  f.action(report, 'ENABLE'); f.action(watch); await f.e.drain(); assert.equal(f.view().runs.length, 1);
  f.snapshot([ci({ status: 'in_progress', conclusion: null })]); f.action(watch); await f.e.drain();
  const r = f.view().runs.at(-1); assert.equal(r.taskId, report); assert.equal(r.trigger, 'EVENT_DRIVEN');
  assert.equal(r.result.source, 'LOCAL_CI_OBSERVATIONS'); assert.ok(r.result.sourceRunId); assert.equal(f.calls, 2);
  await f.restart(); await f.e.tick(); assert.equal(f.view().runs.length, 3);
}));
await test('job-only status changes trigger downstream local reporting', () => fixture(async f => {
  const watch = f.task(), report = f.task({ type: 'CI_REPORT', sourceTaskId: watch, mode: 'EVENT_DRIVEN' });
  f.action(report, 'ENABLE'); f.action(watch); await f.e.drain();
  const next = ci(); next.jobs[0].conclusion = 'failure'; next.jobs[0].requiredMacSkip = true;
  f.snapshot([next]); f.action(watch); await f.e.drain(); assert.equal(f.view().runs.at(-1).taskId, report);
  assert.ok(f.view().runs.at(-1).result.failures[0].includes('required macOS skip'));
}));
await test('different CI watch tasks cannot consume each other\'s baseline or downstream events', () => fixture(async f => {
  const a = f.task(), b = f.task(), report = f.task({ type: 'CI_REPORT', sourceTaskId: b, mode: 'EVENT_DRIVEN' });
  f.action(report, 'ENABLE'); f.action(a); f.action(b); await f.e.drain();
  f.snapshot([ci({ status: 'in_progress', conclusion: null })]);
  f.action(a); await f.e.drain(); f.action(b); await f.e.drain();
  assert.equal(f.view().runs.at(-1).taskId, report); assert.equal(f.view().runs.at(-1).trigger, 'EVENT_DRIVEN');
}));
await test('queued report coalesces a verified change without failing upstream', () => fixture(async f => {
  const watch = f.task(), report = f.task({ type: 'CI_REPORT', sourceTaskId: watch, mode: 'EVENT_DRIVEN' });
  f.action(report, 'ENABLE'); f.action(watch); await f.e.drain();
  f.snapshot([ci({ conclusion: 'failure' })]); f.action(watch); f.action(report); await f.e.drain();
  assert.ok(f.view().runs.every(r => r.state === 'COMPLETED')); assert.equal(f.view().tasks.find(t => t.id === report).pendingEventKey, null);
}));
await test('report without a successful upstream fails honestly', () => fixture(async f => {
  const watch = f.task(), report = f.task({ type: 'CI_REPORT', sourceTaskId: watch }); f.action(report); await f.e.drain();
  assert.equal(f.view().runs[0].error, 'NO_VERIFIED_CI_SOURCE'); assert.equal(f.calls, 0);
}));
await test('errors are persisted without leaking subprocess private output; retries are bounded', async () => {
  await fixture(async f => {
    const id = f.task(); f.action(id); await f.e.drain(); assert.equal(f.view().runs[0].state, 'FAILED');
    assert.equal(f.view().runs[0].error, 'READ_OR_VALIDATION_FAILED');
    f.action(id, 'RETRY'); await f.e.drain(); assert.throws(() => f.action(id, 'RETRY'), /上限/);
    await f.restart(); assert.equal(f.view().runs.length, 2); assert.ok(!JSON.stringify(f.view()).includes('private-secret'));
  }, { reader: { async read() { throw new Error('private-secret'); } } });
});
await test('malformed GitHub-shaped data is not COMPLETED', async () => fixture(async f => {
  const id = f.task(); f.action(id); await f.e.drain(); assert.equal(f.view().runs[0].state, 'FAILED'); assert.equal(f.view().ci.length, 0);
}, { reader: { async read() { return [{ fake: true }]; } } }));
await test('hourly read budget persists independently of run history', () => fixture(async f => {
  const id = f.task();
  for (let i = 0; i < LIMITS.githubReadsPerHour; i++) { f.action(id); await f.e.drain(); }
  await f.restart(); f.action(id); await f.e.drain(); assert.equal(f.calls, LIMITS.githubReadsPerHour);
  assert.equal(f.view().runs.at(-1).state, 'DEFERRED'); assert.equal(f.view().runs.at(-1).error, null);
  f.advance(3600001); await f.e.drain(); assert.equal(f.calls, LIMITS.githubReadsPerHour + 1);
}));
await test('restart marks interrupted RUNNING as failed and does not replay it', () => fixture(async f => {
  const id = f.task(); f.action(id); const store = new PilotStore(f.dir), data = store.read('chief');
  data.runs[0].state = 'RUNNING'; data.runs[0].startedAt = '2026-10-20T00:00:00Z'; store.write(data);
  await f.restart(); await f.e.drain(); assert.equal(f.calls, 0); assert.equal(f.view().runs[0].error, 'PROCESS_INTERRUPTED_NO_AUTOMATIC_REPLAY');
}));
await test('one live lease prevents competing schedulers for a data directory', () => fixture(f => {
  assert.throws(() => new PilotEngine({ dataDirectory: f.dir, projects: ['chief'], reader: { read: async () => [] } }), /已有自動化程序/);
}));
await test('checksum corruption fails closed without repairing or dispatching', () => fixture(f => {
  f.task(); const file = join(f.dir, 'auto-p1/chief.json'); const raw = JSON.parse(readFileSync(file)); raw.payload.tasks[0].name = 'tampered';
  writeFileSync(file, JSON.stringify(raw)); assert.throws(() => f.view(), /儲存/); assert.equal(f.calls, 0);
}));
await test('symlink storage is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chief-auto-p1-link-')), target = mkdtempSync(join(tmpdir(), 'chief-auto-target-'));
  try { symlinkSync(target, join(dir, 'auto-p1')); assert.throws(() => new PilotStore(dir)); }
  finally { rmSync(dir, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true }); }
});
await test('caller-owned returned objects cannot mutate persisted records', () => fixture(f => {
  f.task(); const v = f.view(); v.tasks[0].enabled = true; v.tasks[0].name = 'mutated'; assert.equal(f.view().tasks[0].enabled, false);
}));
await test('source URLs cannot redirect evidence links to another origin or repository', () => {
  for (const u of ['https://evil.test/x', 'https://github.com/other/repo/actions/runs/1', 'https://user@github.com/' + REPOSITORY + '/actions/runs/1', 'javascript:alert(1)']) assert.throws(() => safeGitHubUrl(u));
  assert.equal(safeGitHubUrl(ci().url), ci().url);
});
async function transport(fn, patch = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'chief-auto-transport-'));
  const data = { user: { login: 'chief-ai-bot' }, runs: { workflow_runs: [{ id: 101, run_attempt: 1, run_number: 124, name: 'CI',
    head_sha: 'a'.repeat(40), head_branch: 'work/unit-test', status: 'completed', conclusion: 'success', event: 'push',
    updated_at: '2026-10-20T00:00:00Z', html_url: ci().url, head_repository: { full_name: REPOSITORY } }] },
    jobs: { total_count: 1, jobs: [{ id: 102, run_id: 101, name: 'r4t-macos', status: 'completed', conclusion: 'skipped',
      labels: ['macos-latest'], html_url: ci().jobs[0].url, steps: [{ name: 'Require a working macOS Seatbelt', status: 'completed', conclusion: 'skipped', number: 1 }] }] }, ...patch };
  const helper = join(dir, 'fake-helper');
  // An isolated offline transport fixture, never a real credential helper or model call.
  writeFileSync(helper, '#!' + process.execPath + '\n' + `const d=${JSON.stringify(data)};const a=process.argv.slice(2);if(a[0]!=="api"||a[1]!=="--method"||a[2]!=="GET")process.exit(2);const p=a[3];console.log(JSON.stringify(p==="user"?d.user:p.includes("/attempts/")?d.jobs:d.runs));`, { mode: 0o700 });
  try { await fn(new GitHubActionsReader(helper, dir)); } finally { rmSync(dir, { recursive: true, force: true }); }
}
await test('offline transport parses exact attempt/job identity, OS and required macOS skip', () => transport(async reader => {
  const result = await reader.read(new AbortController().signal);
  assert.equal(result[0].jobs[0].platform, 'MACOS'); assert.equal(result[0].jobs[0].requiredMacSkip, true);
}));
await test('offline transport refuses non-bot identity before reading repository data', () => transport(async reader => {
  await assert.rejects(reader.read(new AbortController().signal), /BOT_IDENTITY_REQUIRED/);
}, { user: { login: 'owner-not-allowed' } }));
await test('offline transport refuses foreign repository identity', () => transport(async reader => {
  await assert.rejects(reader.read(new AbortController().signal));
}, { runs: { workflow_runs: [{ id: 1, head_repository: { full_name: 'other/repo' } }] } }));
await test('offline transport refuses incomplete job pagination rather than inventing success', () => transport(async reader => {
  await assert.rejects(reader.read(new AbortController().signal), /GITHUB_JOBS_INCOMPLETE/);
}, { jobs: { total_count: 1, jobs: [] } }));
await test('offline transport handles already-cancelled requests without launching', () => transport(async reader => {
  const abort = new AbortController(); abort.abort(); await assert.rejects(reader.read(abort.signal), /CANCELLED/);
}));
await test('task resource limit is enforced', () => fixture(f => {
  for (let i = 0; i < LIMITS.tasks; i++) f.task(); assert.throws(() => f.task(), /上限/);
}));

await test('Workspace API uses existing session/origin isolation, real queue, and rejects AI authority bypass', () => fixture(async f => {
  const config = parseWorkspaceConfig({ schemaVersion: 1, dataDirectory: f.dir, humanPrincipal: { principalRef: 'human:local-owner' },
    projects: [{ projectId: 'chief', displayName: 'CHIEF', repository: REPOSITORY }] }, f.dir);
  const server = await startWorkspaceServer({ config, uiDirectory: 'workspace-ui', port: 0, automation: f.e });
  try {
    const home = await fetch(server.url), cookie = home.headers.get('set-cookie').split(';')[0];
    const endpoint = server.url + 'api/v0/projects/chief/automations';
    assert.equal((await fetch(endpoint)).status, 401);
    const headers = { Cookie: cookie, Origin: server.url.slice(0, -1), 'X-Chief-Workspace': '1', 'Content-Type': 'application/json' };
    const spec = { requestId: randomUUID(), name: 'UI CI WATCH', type: 'CI_WATCH', mode: 'MANUAL', intervalSeconds: 60, maxRetries: 1 };
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...headers, Origin: 'https://evil.test' }, body: JSON.stringify(spec) })).status, 403);
    assert.equal((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ ...spec, authorization: 'HUMAN' }) })).status, 400);
    const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(spec) }); assert.equal(response.status, 201);
    const task = (await response.json()).tasks[0];
    assert.equal((await fetch(endpoint + '/' + task.id + '/actions', { method: 'POST', headers, body: JSON.stringify({ action: 'EXECUTE_AI', requestId: randomUUID() }) })).status, 400);
    const result = await fetch(endpoint + '/' + task.id + '/actions', { method: 'POST', headers, body: JSON.stringify({ action: 'RUN', requestId: randomUUID() }) }); assert.equal(result.status, 200);
    await f.e.drain(); const view = await (await fetch(endpoint, { headers: { Cookie: cookie } })).json();
    assert.equal(view.runs[0].state, 'COMPLETED'); assert.equal(view.authority, 'NON_AUTHORITATIVE'); assert.equal(view.exe, 'HOLD');
    const goal = await (await fetch(server.url + 'api/v0/projects/chief/goals', { method: 'POST', headers, body: JSON.stringify({ text: 'AI goal remains HOLD' }) })).json();
    assert.equal(goal.goal.execution, 'NOT_STARTED');
    for (const path of ['execute', 'authorize', 'resume', 'promote']) assert.equal((await fetch(endpoint + '/' + task.id + '/' + path, { method: 'POST', headers, body: '{}' })).status, 404);
  } finally { await server.close(); }
}));

await test('pilot module graph cannot reach Controller, Authority Archive, model adapters or invocation writes', () => {
  for (const file of ['model.ts', 'store.ts', 'github.ts', 'engine.ts', 'main.ts']) {
    const code = readFileSync('src/pilot/' + file, 'utf8');
    assert.doesNotMatch(code, /from ['"](?:\.\.\/)*(?:automation|providers|execution|agents|consultation)\//);
    assert.doesNotMatch(code, /createLiveAutomation|AutomationController|openAuthority|\.authorize\(/);
  }
  const gh = readFileSync('src/pilot/github.ts', 'utf8');
  assert.doesNotMatch(gh, /'POST'|'PATCH'|'PUT'|'DELETE'|shell: true|rerun|workflow_dispatch/);
  assert.match(gh, /user\.login !== 'chief-ai-bot'/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
