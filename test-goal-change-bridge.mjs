import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync,
  symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changeKeyOf } from './dist/automation/admission.js';
import { objectiveHashOf, sourceKeyOf } from './dist/automation/change-mint.js';
import { openChangeRegistryReader } from './dist/automation/change-registry.js';
import { readGovernedModel } from './dist/automation/read-model/governed-read-model.js';
import { createGoalChangeBridge } from './dist/intake/goal-change-bridge.js';
import { parseTrustedWorkspaceHostConfig } from './dist/intake/workspace-host-config.js';
import { startTrustedWorkspaceHost } from './dist/intake/workspace-host.js';
import { FileGoalStore } from './dist/workspace/goal-store.js';
import { API_ROUTES, startWorkspaceServer } from './dist/workspace/server.js';

const UI = join(process.cwd(), 'workspace-ui');
const HUMAN = { schemaVersion: 1, kind: 'HUMAN', principalRef: 'human:test-owner' };
const GOAL = 'goal-00000000-0000-4000-8000-000000000001';
const UNKNOWN = 'goal-00000000-0000-4000-8000-000000000002';
const hash = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let passed = 0, failed = 0;
async function check(name, action) {
  const dir = mkdtempSync(join(tmpdir(), 'chief-gc1-'));
  const running = [];
  try { await action(dir, running); console.log(`  PASS ${name}`); passed++; }
  catch (error) { console.error(`  FAIL ${name}: ${error.stack}`); failed++; }
  finally { for (const host of running) await host.close(); rmSync(dir, { recursive: true, force: true }); }
}

function fixture(dir) {
  const registry = join(dir, 'registry'); mkdirSync(registry, { mode: 0o700 });
  // G1-RA1: the trusted host also requires its pre-provisioned Controller store root.
  const controller = join(dir, 'controller-store'); mkdirSync(controller, { mode: 0o700 });
  const raw = { schemaVersion: 1, workspace: { schemaVersion: 1, dataDirectory: join(dir, 'goals'),
    humanPrincipal: { principalRef: HUMAN.principalRef },
    projects: [{ projectId: 'cand', displayName: 'Synthetic project', repository: 'display-only/path' }] },
  governance: { changeRegistryDirectory: registry, controllerStoreDirectory: controller,
    repositories: [{ projectId: 'cand', repository: 'synthetic/governed' }] } };
  return { raw, registry, controller, config: parseTrustedWorkspaceHostConfig(raw, dir) };
}
const bridge = (config, uiDirectory = UI) => createGoalChangeBridge({ config: config.workspace, uiDirectory,
  changeRegistryDirectory: config.changeRegistryDirectory, governedRepositories: config.governedRepositories });
function add(config, text = 'Exact text\nwith  internal spacing and a tab\tretained.', human = HUMAN) {
  return new FileGoalStore(config.workspace.dataDirectory, { newGoalId: () => GOAL })
    .addGoal('cand', text, human).queue.goals[0];
}
const route = (id, tail = '') => `/api/v0/projects/cand/goals/${id}${tail}`;
function call(host, method, path, { headers = {}, body } = {}) {
  return new Promise((done, fail) => {
    const req = request({ hostname: '127.0.0.1', port: host.port, path, method,
      headers: { Host: `127.0.0.1:${host.port}`, ...(host.cookie ? { Cookie: host.cookie } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json; try { json = JSON.parse(text); } catch { /* static page */ }
        done({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', fail);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const page = (host, extra = {}) => ({ Origin: `http://127.0.0.1:${host.port}`, 'X-Chief-Workspace': '1',
  'Sec-Fetch-Site': 'same-origin', ...extra });
const govern = (host, id = GOAL, options = {}) => call(host, 'POST', route(id, '/govern'), {
  ...options, headers: page(host, options.headers) });
const remove = (host, id = GOAL) => call(host, 'DELETE', route(id), { headers: page(host) });
async function host(config, running, uiDirectory = UI) {
  const ws = await startTrustedWorkspaceHost({ config, uiDirectory, port: 0 });
  running.push(ws);
  const bootstrap = await call(ws, 'GET', '/');
  return { ...ws, cookie: bootstrap.headers['set-cookie'][0].split(';')[0] };
}
const files = (registry) => existsSync(join(registry, 'records')) ? readdirSync(join(registry, 'records')).filter((name) => name.endsWith('.json')) : [];
const mint = (registry) => JSON.parse(readFileSync(join(registry, 'records', files(registry)[0]), 'utf8')).record;
function editGoal(config, edit) {
  const file = join(config.workspace.dataDirectory, 'cand.queue.json');
  const envelope = JSON.parse(readFileSync(file, 'utf8'));
  edit(envelope.queue.goals[0], envelope.queue.history[0].goal);
  envelope.checksum = hash(JSON.stringify(envelope.queue));
  writeFileSync(file, JSON.stringify(envelope));
}

await check('A-C/N. trusted host mints only exact durable Goal facts and canonical CM1 identifiers', async (dir, running) => {
  const f = fixture(dir), goal = add(f.config);
  const ws = await host(f.config, running);
  const before = await call(ws, 'GET', route(GOAL, '/governance'));
  assert.deepEqual(before.json, { provenance: 'CHANGE_REGISTRY', state: 'NOT_GOVERNED' });
  const response = await govern(ws);
  assert.equal(response.status, 200);
  const record = mint(f.registry);
  const key = sourceKeyOf({ kind: 'WORKSPACE_GOAL', projectId: 'cand', goalId: GOAL });
  assert.equal(record.source.objectiveHash, objectiveHashOf(goal.text));
  assert.equal(record.source.createdAt, goal.createdAt);
  assert.deepEqual(record.source.submittedBy, HUMAN);
  assert.equal(record.sourceKey, key);
  assert.equal(record.sliceId, `goal-${key}`);
  assert.equal(record.changeKey, changeKeyOf({ repository: 'synthetic/governed', sliceId: record.sliceId }));
  assert.deepEqual(response.json.change, { kind: 'SLICE', changeId: record.sliceId });
  assert.equal(response.json.changeKey, record.changeKey);
  assert.equal(response.json.sourceKey, key);
  assert.equal(response.json.repository, 'synthetic/governed');
  assert.equal(response.json.recordClass, 'OPERATIONAL_RECORD');
  assert.equal(response.json.sourceClassification, 'LOCAL_OPERATOR_INPUT');
  assert.equal(response.json.execution, 'NOT_STARTED');
  assert.equal(response.json.runCreated, false);
  assert.doesNotMatch(response.text, /checksum|mintedAt|principalRef|authority|registryDirectory|chief_workspace_session/);
  assert.ok(!response.text.includes(ws.cookie.split('=')[1]));
  const queue = await call(ws, 'GET', '/api/v0/projects/cand/goals');
  assert.equal(queue.json.goals[0].authority, 'NON_AUTHORITATIVE');
  assert.equal(queue.json.goals[0].text, goal.text);
  assert.deepEqual((await call(ws, 'GET', route(GOAL, '/governance'))).json, response.json);
});

await check('D-H. every body, Content-Type and transfer body is refused before mint', async (dir, running) => {
  const f = fixture(dir); add(f.config);
  const ws = await host(f.config, running);
  for (const field of ['repository', 'submittedBy', 'principalRef', 'text', 'objective', 'createdAt', 'sourceKey', 'sliceId',
    'changeKey', 'authority', 'actorRole', 'issuer']) {
    const res = await govern(ws, GOAL, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [field]: 'forged' }) });
    assert.equal(res.status, 400, field);
    assert.equal(res.json.error.code, 'UNEXPECTED_BODY');
  }
  for (const options of [{ body: 'x' }, { headers: { 'Content-Type': 'application/json', 'Content-Length': '0' } },
    { headers: { 'Transfer-Encoding': 'chunked' } }, { headers: { 'Content-Type': 'text/plain' }, body: '' }]) {
    const res = await govern(ws, GOAL, options);
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, 'UNEXPECTED_BODY');
  }
  assert.equal((await call(ws, 'POST', route(GOAL, '/govern?repository=forged'), { headers: page(ws) })).status, 400);
  assert.deepEqual(files(f.registry), []);
});

await check('I. legacy unattributed Goals are refused without adopting or changing their history', async (dir, running) => {
  const f = fixture(dir); add(f.config);
  editGoal(f.config, (goal, event) => { delete goal.submittedBy; delete event.submittedBy; });
  const file = join(f.config.workspace.dataDirectory, 'cand.queue.json'), original = readFileSync(file, 'utf8');
  const ws = await host(f.config, running), res = await govern(ws);
  assert.equal(res.status, 409); assert.equal(res.json.error.code, 'UNATTRIBUTED_GOAL');
  assert.deepEqual(files(f.registry), []);
  assert.equal(readFileSync(file, 'utf8'), original);
});

await check('J. server-derived Human must equal stored attribution exactly', async (dir, running) => {
  const f = fixture(dir); add(f.config, 'Owned by another Human', { ...HUMAN, principalRef: 'human:other' });
  const ws = await host(f.config, running), res = await govern(ws);
  assert.equal(res.status, 403); assert.equal(res.json.error.code, 'GOAL_PRINCIPAL_MISMATCH');
  assert.deepEqual(files(f.registry), []);
});

await check('K/V. unknown, malformed and removed Goals mint nothing; pre-govern DELETE wins', async (dir, running) => {
  const f = fixture(dir); add(f.config);
  const ws = await host(f.config, running);
  assert.equal((await remove(ws)).status, 200);
  for (const id of [GOAL, UNKNOWN, 'not-a-goal']) {
    const res = await govern(ws, id);
    assert.equal(res.status, 404); assert.equal(res.json.error.code, 'UNKNOWN_GOAL');
  }
  assert.equal((await call(ws, 'POST', '/api/v0/projects/unconfigured/goals/' + GOAL + '/govern', { headers: page(ws) })).status, 404);
  assert.deepEqual(files(f.registry), []);
});

await check('L-M. identical retries and host restart retain byte-identical canonical evidence', async (dir, running) => {
  const f = fixture(dir); add(f.config);
  const firstHost = await host(f.config, running), first = await govern(firstHost);
  const file = join(f.registry, 'records', files(f.registry)[0]), original = readFileSync(file, 'utf8');
  assert.deepEqual((await govern(firstHost)).json, first.json);
  await firstHost.close(); running.splice(running.indexOf(running.find((ws) => ws.port === firstHost.port)), 1);
  const secondHost = await host(f.config, running);
  assert.deepEqual((await govern(secondHost)).json, first.json);
  assert.equal(readFileSync(file, 'utf8'), original);
  assert.equal(files(f.registry).length, 1);
});

await check('O-P. display repository has no identity role; governed repository changes conflict', async (dir, running) => {
  const f = fixture(dir); add(f.config);
  const ws = await host(f.config, running), first = await govern(ws);
  const changedDisplay = structuredClone(f.raw); changedDisplay.workspace.projects[0].repository = '/an/unrelated/display/path';
  const displayHost = await host(parseTrustedWorkspaceHostConfig(changedDisplay, dir), running);
  assert.deepEqual((await govern(displayHost)).json, first.json);
  const browserConfig = await call(displayHost, 'GET', '/api/v0/projects');
  assert.equal(browserConfig.json.projects[0].repository, '/an/unrelated/display/path');
  assert.doesNotMatch(browserConfig.text, /governedRepositories|changeRegistryDirectory|synthetic\/governed/);
  const changedBinding = structuredClone(f.raw); changedBinding.governance.repositories[0].repository = 'synthetic/other';
  const changedHost = await host(parseTrustedWorkspaceHostConfig(changedBinding, dir), running);
  const res = await govern(changedHost);
  assert.equal(res.status, 409); assert.equal(res.json.error.code, 'CHANGE_SOURCE_BINDING_CONFLICT');
  assert.equal((await call(changedHost, 'GET', route(GOAL, '/governance'))).json.error.code, 'CHANGE_SOURCE_BINDING_CONFLICT');
  assert.equal((await remove(changedHost)).status, 409);
  assert.equal(mint(f.registry).repository, 'synthetic/governed'); assert.equal(files(f.registry).length, 1);
});

await check('binding conflicts in exact stored text, timestamp and Human cannot overwrite a mint', async (dir) => {
  const f = fixture(dir); add(f.config);
  const b = bridge(f.config); await b.governance.govern('cand', GOAL, HUMAN);
  const file = join(f.registry, 'records', files(f.registry)[0]), original = readFileSync(file, 'utf8');
  const goalFile = join(f.config.workspace.dataDirectory, 'cand.queue.json'), sourceBytes = readFileSync(goalFile, 'utf8');
  for (const field of ['text', 'createdAt', 'submittedBy']) {
    writeFileSync(goalFile, sourceBytes);
    const value = field === 'text' ? 'Changed exact objective' : field === 'createdAt' ? '2026-10-07T00:00:00.000Z' : { ...HUMAN, principalRef: 'human:other' };
    editGoal(f.config, (goal, event) => { goal[field] = value; event[field] = value; });
    await assert.rejects(b.governance.govern('cand', GOAL, field === 'submittedBy' ? value : HUMAN), (error) => error.code === 'CHANGE_SOURCE_BINDING_CONFLICT');
    assert.equal(readFileSync(file, 'utf8'), original);
  }
});

await check('trusted configuration is exact, explicit, separate from browser display and immutable', async (dir) => {
  const f = fixture(dir);
  for (const raw of [
    { ...f.raw, governance: { ...f.raw.governance, changeRegistryDirectory: './registry' } },
    { ...f.raw, governance: { ...f.raw.governance, repositories: [] } },
    { ...f.raw, governance: { ...f.raw.governance, repositories: [{ projectId: 'cand', repository: ' synthetic/governed' }] } },
    { ...f.raw, governance: { ...f.raw.governance, repositories: [{ projectId: 'other', repository: 'synthetic/governed' }] } },
    { ...f.raw, governance: { ...f.raw.governance, repositories: [f.raw.governance.repositories[0], f.raw.governance.repositories[0]] } },
  ]) assert.throws(() => parseTrustedWorkspaceHostConfig(raw, dir));
  assert.ok(Object.isFrozen(f.config.governedRepositories[0]));
  assert.equal(f.config.workspace.projects[0].governedRepository, undefined);
  const b = bridge(f.config); add(f.config); f.raw.governance.repositories[0].repository = 'synthetic/forged';
  assert.equal((await b.governance.govern('cand', GOAL, HUMAN)).repository, 'synthetic/governed');
});

await check('Q-U. root containment and aliases fail before listening or opening a mint writer', async (dir) => {
  let index = 0;
  for (const kind of ['equal', 'goal-inside', 'registry-inside', 'goal-alias', 'ui-equal', 'ui-parent', 'ui-alias']) {
    const base = join(dir, String(index++)); mkdirSync(base, { mode: 0o700 });
    const f = fixture(base);
    let ui = UI;
    if (kind === 'equal') f.raw.workspace.dataDirectory = f.registry;
    if (kind === 'goal-inside') f.raw.workspace.dataDirectory = join(f.registry, 'goals');
    if (kind === 'registry-inside') f.raw.workspace.dataDirectory = base;
    if (kind === 'goal-alias') { const alias = join(base, 'alias'); symlinkSync(f.registry, alias); f.raw.workspace.dataDirectory = alias; }
    if (kind === 'ui-equal') ui = f.registry;
    if (kind === 'ui-parent') ui = base;
    if (kind === 'ui-alias') { ui = join(base, 'ui-alias'); symlinkSync(f.registry, ui); }
    const before = readdirSync(f.registry);
    assert.throws(() => startTrustedWorkspaceHost({ config: parseTrustedWorkspaceHostConfig(f.raw, base), uiDirectory: ui, port: 0 }),
      (error) => error.code === 'GOVERNANCE_STORE_ISOLATION', kind);
    assert.deepEqual(readdirSync(f.registry), before, kind);
    if (kind === 'goal-inside') assert.equal(existsSync(f.raw.workspace.dataDirectory), false);
  }
});

await check('a symlinked static asset cannot expose registry records through a disjoint UI directory', async (dir) => {
  const f = fixture(dir), ui = join(dir, 'ui'); cpSync(UI, ui, { recursive: true });
  unlinkSync(join(ui, 'app.js')); symlinkSync(join(f.registry, 'record.json'), join(ui, 'app.js'));
  writeFileSync(join(f.registry, 'record.json'), 'protected data');
  assert.throws(() => startTrustedWorkspaceHost({ config: f.config, uiDirectory: ui, port: 0 }),
    (error) => error.code === 'GOVERNANCE_STORE_ISOLATION');
  assert.deepEqual(readdirSync(f.registry), ['record.json']);
});

await check('an unprovisioned, symlinked or unsafe registry root is refused without repair', async (dir) => {
  const f = fixture(dir);
  chmodSync(f.registry, 0o777);
  assert.throws(() => bridge(f.config), (error) => error.code === 'GOVERNANCE_STORE_ISOLATION');
  assert.equal(existsSync(f.config.workspace.dataDirectory), false);
  chmodSync(f.registry, 0o700); renameSync(f.registry, join(dir, 'target')); symlinkSync(join(dir, 'target'), f.registry);
  assert.throws(() => bridge(f.config), (error) => error.code === 'GOVERNANCE_STORE_ISOLATION');
  unlinkSync(f.registry);
  assert.throws(() => bridge(f.config), (error) => error.code === 'GOVERNANCE_STORE_ISOLATION');
  assert.equal(existsSync(f.registry), false);
});

await check('W. post-govern DELETE refuses without changing the durable source or canonical mint', async (dir, running) => {
  const f = fixture(dir); add(f.config);
  const ws = await host(f.config, running); await govern(ws);
  const file = join(f.config.workspace.dataDirectory, 'cand.queue.json'), sourceBytes = readFileSync(file, 'utf8');
  const res = await remove(ws);
  assert.equal(res.status, 409); assert.equal(res.json.error.code, 'GOAL_ALREADY_GOVERNED');
  assert.equal(readFileSync(file, 'utf8'), sourceBytes); assert.equal(files(f.registry).length, 1);
});

await check('without an injected governance port the ordinary DELETE route fails closed', async (dir, running) => {
  const f = fixture(dir); add(f.config); await bridge(f.config).governance.govern('cand', GOAL, HUMAN);
  const raw = await startWorkspaceServer({ config: f.config.workspace, uiDirectory: UI, port: 0 }); running.push(raw);
  const bootstrap = await call(raw, 'GET', '/'), ws = { ...raw, cookie: bootstrap.headers['set-cookie'][0].split(';')[0] };
  const res = await remove(ws);
  assert.equal(res.status, 503); assert.equal(res.json.error.code, 'GOVERNANCE_UNAVAILABLE');
  assert.equal(new FileGoalStore(f.config.workspace.dataDirectory).read('cand').goals.length, 1);
});

const heldChildScript = `
  import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
  const [rawText, id, operation, held, release, ui] = process.argv.slice(1);
  const original = fs.openSync;
  let stopped = false;
  fs.openSync = function(path, ...args) {
    const fd = original.call(fs, path, ...args);
    if (!stopped && typeof path === 'string' && path.endsWith('cand.queue.json.lock')) {
      stopped = true; fs.writeFileSync(held, 'held');
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(release)) {
        if (Date.now() > deadline) throw new Error('test barrier timed out');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    return fd;
  };
  syncBuiltinESMExports();
  const { parseTrustedWorkspaceHostConfig } = await import('./dist/intake/workspace-host-config.js');
  const { startTrustedWorkspaceHost } = await import('./dist/intake/workspace-host.js');
  const host = await startTrustedWorkspaceHost({ config: parseTrustedWorkspaceHostConfig(JSON.parse(rawText), process.cwd()), uiDirectory: ui, port: 0 });
  try {
    const page = await fetch(host.url); const cookie = page.headers.get('set-cookie').split(';')[0];
    const response = await fetch(host.url + 'api/v0/projects/cand/goals/' + id + (operation === 'POST' ? '/govern' : ''),
      { method: operation, headers: { Cookie: cookie, Origin: host.url.slice(0, -1), 'X-Chief-Workspace': '1' } });
    console.log(JSON.stringify({ status: response.status, json: await response.json() }));
  } finally { await host.close(); }
`;
function heldChild(f, dir, operation) {
  const held = join(dir, 'held'), release = join(dir, 'release');
  const child = spawn(process.execPath, ['--input-type=module', '-e', heldChildScript, JSON.stringify(f.raw), GOAL, operation, held, release, UI],
    { cwd: process.cwd() });
  let output = '', errors = '';
  child.stdout.on('data', (data) => { output += data; }); child.stderr.on('data', (data) => { errors += data; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => { if (code !== 0) reject(new Error(errors || `child exited ${code}`));
      else { try { resolve(JSON.parse(output)); } catch { reject(new Error(output || errors)); } } });
  });
  done.catch(() => {});
  return { done, release: () => writeFileSync(release, 'release'),
    wait: async () => { const deadline = Date.now() + 5000;
      while (!existsSync(held)) { if (Date.now() >= deadline || child.exitCode !== null) throw new Error('child did not acquire project lock: ' + errors); await sleep(10); } } };
}

await check('X1. across real HTTP hosts, DELETE winning the storage lock prevents later governance', async (dir, running) => {
  const f = fixture(dir); add(f.config); const ws = await host(f.config, running);
  const child = heldChild(f, dir, 'DELETE');
  try {
    await child.wait(); const pending = govern(ws); await sleep(30); child.release();
    assert.equal((await child.done).status, 200);
    const res = await pending; assert.equal(res.status, 404); assert.equal(res.json.error.code, 'UNKNOWN_GOAL');
    assert.deepEqual(files(f.registry), []);
  } finally { child.release(); await child.done; }
});

await check('X2. across real HTTP hosts, govern winning blocks removal and other queue mutations', async (dir, running) => {
  const f = fixture(dir); add(f.config); const ws = await host(f.config, running);
  const child = heldChild(f, dir, 'POST');
  try {
    await child.wait();
    const busy = await remove(ws); assert.equal(busy.status, 409); assert.equal(busy.json.error.code, 'GOAL_STORE_BUSY');
    const order = await call(ws, 'POST', '/api/v0/projects/cand/goals/order', {
      headers: page(ws, { 'Content-Type': 'application/json' }), body: JSON.stringify({ order: [GOAL] }) });
    assert.equal(order.status, 409); assert.equal(order.json.error.code, 'GOAL_STORE_BUSY');
    child.release(); assert.equal((await child.done).status, 200);
    assert.equal((await remove(ws)).json.error.code, 'GOAL_ALREADY_GOVERNED');
    assert.equal(new FileGoalStore(f.config.workspace.dataDirectory).read('cand').goals.length, 1);
    assert.equal(files(f.registry).length, 1);
  } finally { child.release(); await child.done; }
});

await check('Y. two independent concurrent HTTP hosts return the same single canonical Change', async (dir, running) => {
  const f = fixture(dir); add(f.config); const ws = await host(f.config, running);
  const child = heldChild(f, dir, 'POST');
  try {
    await child.wait(); const pending = govern(ws); await sleep(30); child.release();
    const first = await child.done, second = await pending;
    assert.equal(first.status, 200); assert.equal(second.status, 200); assert.deepEqual(second.json, first.json);
    assert.equal(files(f.registry).length, 1);
  } finally { child.release(); await child.done; }
});

await check('an abandoned project lock yields a bounded refusal and is never repaired', async (dir, running) => {
  const f = fixture(dir); add(f.config); const ws = await host(f.config, running);
  const lock = join(f.config.workspace.dataDirectory, 'cand.queue.json.lock'); writeFileSync(lock, 'uncertain writer');
  const res = await govern(ws); assert.equal(res.status, 409); assert.equal(res.json.error.code, 'GOAL_STORE_BUSY');
  assert.equal(readFileSync(lock, 'utf8'), 'uncertain writer'); assert.deepEqual(files(f.registry), []);
});

await check('the stable Goal action retains its storage lock through completion and returns an isolated snapshot', async (dir) => {
  const f = fixture(dir), original = add(f.config), store = new FileGoalStore(f.config.workspace.dataDirectory);
  let release;
  const barrier = new Promise((done) => { release = done; });
  const pending = store.withLockedGoal('cand', GOAL, async (goal) => {
    goal.text = 'mutated snapshot'; await barrier; return goal;
  });
  assert.throws(() => store.removeGoal('cand', GOAL), /locked/);
  release(); await pending;
  assert.equal(store.read('cand').goals[0].text, original.text);
  assert.equal(store.removeGoal('cand', GOAL).queue.goals.length, 0);
});

await check('AK-AL. governance retains D1 session, Host, origin, Fetch-Site and Workspace-header isolation', async (dir, running) => {
  const f = fixture(dir); add(f.config); const ws = await host(f.config, running);
  for (const [headers, status, code] of [
    [{ Cookie: '' }, 401, 'NO_LOCAL_SESSION'], [{ Cookie: 'chief_workspace_session=forged' }, 401, 'NO_LOCAL_SESSION'],
    [{ Host: 'attacker.example' }, 421, 'WRONG_HOST'], [{ Origin: 'http://attacker.example' }, 403, 'WRONG_ORIGIN'],
    [{ 'Sec-Fetch-Site': 'cross-site' }, 403, 'CROSS_SITE'], [{ 'X-Chief-Workspace': '0' }, 403, 'MISSING_HEADER'],
  ]) { const res = await govern(ws, GOAL, { headers }); assert.equal(res.status, status); assert.equal(res.json.error.code, code); }
  assert.equal((await call(ws, 'GET', route(GOAL, '/governance'), { headers: { Cookie: '' } })).status, 401);
  assert.equal((await call(ws, 'GET', route(GOAL, '/governance'), { headers: { Host: 'attacker.example' } })).status, 421);
  assert.deepEqual(files(f.registry), []);
});

await check('registry corruption is an explicit path-free failure and cannot bypass source retention', async (dir, running) => {
  const f = fixture(dir); add(f.config); const ws = await host(f.config, running); await govern(ws);
  const file = join(f.registry, 'records', files(f.registry)[0]); writeFileSync(file, '{broken');
  for (const res of [await govern(ws), await call(ws, 'GET', route(GOAL, '/governance')), await remove(ws)]) {
    assert.equal(res.status, 500); assert.equal(res.json.error.code, 'REGISTRY_INTEGRITY');
    assert.ok(!res.text.includes(dir));
  }
  assert.equal(new FileGoalStore(f.config.workspace.dataDirectory).read('cand').goals.length, 1);
});

await check('root replacement is an explicit path-free isolation failure before a new mint', async (dir, running) => {
  const f = fixture(dir); add(f.config); const ws = await host(f.config, running);
  renameSync(f.registry, join(dir, 'original-registry')); mkdirSync(f.registry, { mode: 0o700 });
  const res = await govern(ws); assert.equal(res.status, 500); assert.equal(res.json.error.code, 'GOVERNANCE_STORE_ISOLATION');
  assert.ok(!res.text.includes(dir)); assert.deepEqual(readdirSync(f.registry), []);
});

await check('publication unavailability is explicit with no weaker fallback or leaked storage path', async (dir) => {
  const f = fixture(dir); add(f.config);
  const script = `
    import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    fs.linkSync = () => { const error = new Error('secret storage path'); error.code = 'EXDEV'; throw error; };
    syncBuiltinESMExports();
    const { createGoalChangeBridge } = await import('./dist/intake/goal-change-bridge.js');
    const { parseTrustedWorkspaceHostConfig } = await import('./dist/intake/workspace-host-config.js');
    const config = parseTrustedWorkspaceHostConfig(JSON.parse(process.argv[1]), process.cwd());
    const b = createGoalChangeBridge({ config: config.workspace, governedRepositories: config.governedRepositories,
      changeRegistryDirectory: config.changeRegistryDirectory, uiDirectory: process.argv[2] });
    try { await b.governance.govern('cand', ${JSON.stringify(GOAL)}, ${JSON.stringify(HUMAN)}); }
    catch (error) { console.log(JSON.stringify({ code: error.code, message: error.message })); }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(f.raw), UI], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout); assert.equal(result.code, 'PUBLICATION_UNAVAILABLE');
  assert.doesNotMatch(result.message, /secret|storage path/); assert.deepEqual(files(f.registry), []);
});

await check('AE-AF. mint-only evidence remains separate from the unchanged R4A0 projection', async (dir, running) => {
  const f = fixture(dir); add(f.config); const ws = await host(f.config, running); await govern(ws);
  assert.equal((await call(ws, 'GET', route(GOAL, '/governance'))).json.state, 'GOVERNED');
  const roots = { controllerStoreDirectory: join(dir, 'controller'), authorityArchiveDirectory: join(dir, 'authority') };
  const read = readGovernedModel(roots);
  assert.deepEqual(read.runs, []); assert.deepEqual(read.changes, []); assert.deepEqual(read.authority, []);
  assert.equal(existsSync(roots.controllerStoreDirectory), false); assert.equal(existsSync(roots.authorityArchiveDirectory), false);
  assert.equal(API_ROUTES.filter((route) => route.startsWith('POST') && /govern/.test(route)).length, 1);
  // G1-RA1 adds exactly the Goal-scoped run admission pair; governance itself still creates no run.
  assert.deepEqual(API_ROUTES.filter((route) => /\/run\b/.test(route)), ['POST /api/v0/projects/:projectId/goals/:goalId/run',
    'GET /api/v0/projects/:projectId/goals/:goalId/run']);
  assert.ok(!API_ROUTES.some((route) => /\/start|\/execute|create-run|authoriz|packet/.test(route)));
  assert.deepEqual(readGovernedModel({ controllerStoreDirectory: f.controller, authorityArchiveDirectory: roots.authorityArchiveDirectory }).runs, []);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
