import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorkspaceConfig } from './dist/workspace/config.js';
import { FileGoalStore } from './dist/workspace/goal-store.js';
import { startWorkspaceServer, API_ROUTES } from './dist/workspace/server.js';
import { createGoalExecutionStepBridge } from './dist/intake/goal-execution-step-bridge.js';
import { parseTrustedWorkspaceHostConfig } from './dist/intake/workspace-host-config.js';

// EXE-C1: real localhost HTTP and browser session boundary; a controlled driver
// stands in for the already independently tested LD1/Runner. No model is ever called.
const UI = join(process.cwd(), 'workspace-ui');
const HUMAN = { schemaVersion: 1, kind: 'HUMAN', principalRef: 'human:exe-test' };
let passed = 0, failed = 0;
async function check(label, task) {
  const root = mkdtempSync(join(tmpdir(), 'chief-exe-c1-'));
  const closers = [];
  try {
    const config = parseWorkspaceConfig({ schemaVersion: 1, dataDirectory: join(root, 'queue'),
      humanPrincipal: { principalRef: HUMAN.principalRef },
      projects: [{ projectId: 'chief', displayName: 'Chief', repository: 'synthetic/test' }] }, root);
    const store = new FileGoalStore(config.dataDirectory);
    const goal = store.addGoal('chief', 'Test governed step', HUMAN).queue.goals.at(-1);
    const prepared = { enabled: false, readiness: 'READY', repository: 'synthetic/test',
      deferred: null, calls: 0, observed: [], failReadAfterStep: false, readBroken: false };
    const status = { inspect(projectId, goalId, human) {
      if (prepared.readBroken) throw new Error('simulated post-step read failure');
      assert.equal(projectId, 'chief');
      assert.deepEqual(human, HUMAN);
      const stored = store.read(projectId).goals.find((item) => item.goalId === goalId);
      if (!stored) throw new Error('unknown Goal');
      assert.deepEqual(stored.submittedBy, human);
      return { status: prepared.enabled ? 'IN_PROGRESS' : 'RUN_NOT_ADMITTED', reason: null,
        change: prepared.enabled ? { kind: 'SLICE', changeId: 'slice-1', repository: 'synthetic/test', changeKey: 'change-1' } : null,
        run: prepared.enabled ? { runId: 'run-exe-1', admission: 'ROOT', state: 'PACKET_READY' } : null };
    } };
    const driver = {
      inspect(target) {
        prepared.observed.push(target);
        return { target, repository: prepared.repository, changeKey: 'change-1',
          state: 'PACKET_READY', readiness: prepared.readiness, reason: prepared.readiness === 'READY' ? null : 'MISSING_GRANT' };
      },
      async step(target) {
        prepared.calls++;
        if (prepared.deferred) await prepared.deferred;
        if (prepared.failReadAfterStep) prepared.readBroken = true;
        return { target, runnerCalls: 1, status: 'STEPPED', runnerOutcome: 'ADVANCED',
          preState: 'PACKET_READY', postState: 'IMPLEMENTING' };
      },
    };
    const step = createGoalExecutionStepBridge({ executionStatus: status, driver });
    const running = await startWorkspaceServer({ config, uiDirectory: UI, port: 0, store,
      executionStatus: status, executionStep: step });
    closers.push(running);
    const bootstrap = await call(running, 'GET', '/');
    const ws = { ...running, cookie: bootstrap.headers['set-cookie']?.[0]?.split(';')[0] };
    assert.ok(ws.cookie);
    await task({ root, config, store, goal, ws, step, prepared, status, driver });
    console.log('  PASS ' + label); passed++;
  } catch (error) { console.error('  FAIL ' + label + ': ' + error.stack); failed++; }
  finally { for (const item of closers) await item.close(); rmSync(root, { recursive: true, force: true }); }
}
function call(ws, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: ws.port, path, method,
      headers: { Host: '127.0.0.1:' + ws.port, ...(ws.cookie ? { Cookie: ws.cookie } : {}), ...headers } }, (res) => {
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        let json; try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, json, text, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const route = (goalId) => '/api/v0/projects/chief/goals/' + goalId + '/step';
const page = (ws) => ({ Origin: 'http://127.0.0.1:' + ws.port,
  'X-Chief-Workspace': '1', 'Sec-Fetch-Site': 'same-origin' });

await check('route only handles one governed Goal and refuses an unadmitted run', async ({ ws, goal, prepared }) => {
  const read = await call(ws, 'GET', route(goal.goalId));
  assert.equal(read.status, 200);
  assert.deepEqual([read.json.canStep, read.json.readiness, read.json.runId], [false, 'RUN_NOT_ADMITTED', null]);
  const refused = await call(ws, 'POST', route(goal.goalId), { headers: page(ws) });
  assert.equal(refused.status, 200);
  assert.deepEqual([refused.json.status, refused.json.runnerCalls, prepared.calls], ['NOT_STEPPED', 0, 0]);
  assert.deepEqual(API_ROUTES.filter(x => x.endsWith('/step')).map(x => x.slice(0, 4)), ['GET ', 'POST']);
});

await check('governed READY step derives the run identity only on the trusted side and calls driver exactly once', async ({ ws, goal, prepared }) => {
  prepared.enabled = true;
  const read = await call(ws, 'GET', route(goal.goalId));
  assert.deepEqual([read.json.readiness, read.json.canStep, read.json.runId], ['READY', true, 'run-exe-1']);
  const response = await call(ws, 'POST', route(goal.goalId), { headers: page(ws) });
  assert.deepEqual([response.status, response.json.status, response.json.runnerCalls, prepared.calls], [200, 'STEPPED', 1, 1]);
  assert.deepEqual(prepared.observed[0], { source: { kind: 'WORKSPACE_GOAL', projectId: 'chief', goalId: goal.goalId }, runId: 'run-exe-1' });
  assert.equal(response.json.authority, 'NOT_EXECUTION_AUTHORITY');
});

await check('blocked driver readiness cannot call any actor', async ({ ws, goal, prepared }) => {
  prepared.enabled = true; prepared.readiness = 'BLOCKED_AUTHORITY';
  const view = await call(ws, 'GET', route(goal.goalId));
  assert.equal(view.json.canStep, false);
  const result = await call(ws, 'POST', route(goal.goalId), { headers: page(ws) });
  assert.deepEqual([result.json.status, result.json.runnerCalls, prepared.calls], ['NOT_STEPPED', 0, 0]);
});

await check('wrong-origin, missing header, session forgery, query and payload are refused before driver', async ({ ws, goal, prepared }) => {
  prepared.enabled = true;
  const url = route(goal.goalId);
  const bad = [
    await call(ws, 'POST', url, { headers: { ...page(ws), Origin: 'https://evil.example' } }),
    await call(ws, 'POST', url, { headers: { Origin: page(ws).Origin } }),
    await call(ws, 'POST', url, { headers: { ...page(ws), Cookie: 'chief_workspace_session=forged' } }),
    await call(ws, 'POST', url + '?runId=forged', { headers: page(ws) }),
    await call(ws, 'POST', url, { headers: { ...page(ws), 'Content-Type': 'application/json' }, body: '{"runId":"forged"}' }),
  ];
  assert.deepEqual(bad.map(r=>r.status), [403, 403, 401, 400, 400]);
  assert.equal(prepared.calls, 0);
});

await check('driver identity contradiction fails closed', async ({ ws, goal, prepared }) => {
  prepared.enabled = true; prepared.repository = 'other/repository';
  const read = await call(ws, 'GET', route(goal.goalId));
  assert.deepEqual([read.status, read.json.error.code], [409, 'STEP_BINDING_CONFLICT']);
  const rejected = await call(ws, 'POST', route(goal.goalId), { headers: page(ws) });
  assert.deepEqual([rejected.status, rejected.json.error.code, prepared.calls], [409, 'STEP_BINDING_CONFLICT', 0]);
});

await check('concurrent clicks on the same Goal cannot dispatch twice', async ({ ws, goal, prepared }) => {
  prepared.enabled = true;
  let finish;
  prepared.deferred = new Promise((resolve) => { finish = resolve; });
  const first = call(ws, 'POST', route(goal.goalId), { headers: page(ws) });
  await new Promise((resolve) => setTimeout(resolve, 40));
  const second = await call(ws, 'POST', route(goal.goalId), { headers: page(ws) });
  assert.deepEqual([second.status, second.json.error.code, prepared.calls], [409, 'STEP_BUSY', 1]);
  finish();
  const done = await first;
  assert.deepEqual([done.status, done.json.runnerCalls], [200, 1]);
});

await check('post-step observation failure preserves the one-call result and refuses blind retry', async ({ ws, goal, prepared }) => {
  prepared.enabled = true; prepared.failReadAfterStep = true;
  const result = await call(ws, 'POST', route(goal.goalId), { headers: page(ws) });
  assert.deepEqual([result.status, result.json.status, result.json.runnerCalls, prepared.calls], [200, 'STEPPED', 1, 1]);
  assert.deepEqual([result.json.readiness.readiness, result.json.readiness.canStep],
    ['POST_STEP_OBSERVATION_UNAVAILABLE', false]);
});

await check('default Workspace has no execution port, even with a Goal and valid session', async ({ ws, config, goal }) => {
  const independent = await startWorkspaceServer({ config, uiDirectory: UI, port: 0 });
  try {
    const bootstrap = await call(independent, 'GET', '/');
    const without = { ...independent, cookie: bootstrap.headers['set-cookie'][0].split(';')[0] };
    const result = await call(without, 'POST', route(goal.goalId), { headers: page(without) });
    assert.deepEqual([result.status, result.json.error.code], [503, 'EXECUTION_STEP_UNAVAILABLE']);
  } finally { await independent.close(); }
});

await check('trusted Host configuration refuses step without status before composing any live actor', async ({ root, config }) => {
  const raw = { schemaVersion: 1, workspace: { schemaVersion: 1, dataDirectory: config.dataDirectory,
    humanPrincipal: { principalRef: HUMAN.principalRef }, projects: config.projects },
  governance: { changeRegistryDirectory: join(root, 'registry'), controllerStoreDirectory: join(root, 'controller'),
    repositories: [{ projectId: 'chief', repository: 'synthetic/test' }],
    executionStep: { governedLive: {} } } };
  assert.throws(() => parseTrustedWorkspaceHostConfig(raw, root), /requires the existing read-only/);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
