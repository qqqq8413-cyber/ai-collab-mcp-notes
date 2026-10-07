import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync,
  statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { changeKeyOf } from './dist/automation/admission.js';
import { sourceKeyOf } from './dist/automation/change-mint.js';
import { AutomationController } from './dist/automation/controller.js';
import { FileControllerStore } from './dist/automation/durable-store.js';
import { readGovernedModel } from './dist/automation/read-model/governed-read-model.js';
import { openRootRunAdmitter, rootRunIdOf } from './dist/automation/root-run-admitter.js';
import { createGoalChangeBridge } from './dist/intake/goal-change-bridge.js';
import { createGoalRunAdmissionBridge } from './dist/intake/goal-run-admission-bridge.js';
import { parseTrustedWorkspaceHostConfig } from './dist/intake/workspace-host-config.js';
import { startTrustedWorkspaceHost } from './dist/intake/workspace-host.js';
import { FileGoalStore } from './dist/workspace/goal-store.js';
import { API_ROUTES, startWorkspaceServer } from './dist/workspace/server.js';

// G1-RA1 governed run admission: an already-governed Workspace Goal → its exact GC1 Change →
// one canonical CHIEF-GOV/1 ROOT run in IDLE → STOP. Letters refer to the RA1 packet.

const ROOT = process.cwd();
const UI = join(ROOT, 'workspace-ui');
const HUMAN = { schemaVersion: 1, kind: 'HUMAN', principalRef: 'human:test-owner' };
const OTHER = { ...HUMAN, principalRef: 'human:other' };
const GOAL = 'goal-00000000-0000-4000-8000-000000000001';
const UNKNOWN = 'goal-00000000-0000-4000-8000-000000000002';
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let passed = 0, failed = 0;
async function check(name, action) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'chief-ra1-')));
  const running = [];
  try { await action(dir, running); console.log(`  PASS ${name}`); passed++; }
  catch (error) { console.error(`  FAIL ${name}: ${error.stack}`); failed++; }
  finally { for (const host of running) await host.close(); rmSync(dir, { recursive: true, force: true }); }
}

const provision = (path) => { mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700); return path; };
function fixture(dir) {
  const registry = provision(join(dir, 'registry')), controller = provision(join(dir, 'controller'));
  const raw = { schemaVersion: 1, workspace: { schemaVersion: 1, dataDirectory: join(dir, 'goals'),
    humanPrincipal: { principalRef: HUMAN.principalRef },
    projects: [{ projectId: 'cand', displayName: 'Synthetic project', repository: 'display-only/path' }] },
  governance: { changeRegistryDirectory: registry, controllerStoreDirectory: controller,
    repositories: [{ projectId: 'cand', repository: 'synthetic/governed' }] } };
  return { raw, registry, controller, config: parseTrustedWorkspaceHostConfig(raw, dir) };
}
function add(config, text = 'Exact objective\nwith internal  spacing.', human = HUMAN) {
  return new FileGoalStore(config.workspace.dataDirectory, { newGoalId: () => GOAL }).addGoal('cand', text, human).queue.goals[0];
}
const gc1 = (config) => createGoalChangeBridge({ config: config.workspace, uiDirectory: UI,
  changeRegistryDirectory: config.changeRegistryDirectory, governedRepositories: config.governedRepositories });
const ra1 = (config, store = gc1(config).store) => createGoalRunAdmissionBridge({ config: config.workspace, uiDirectory: UI, store,
  changeRegistryDirectory: config.changeRegistryDirectory, controllerStoreDirectory: config.controllerStoreDirectory,
  governedRepositories: config.governedRepositories });
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
const admit = (host, id = GOAL, options = {}) => call(host, 'POST', route(id, '/run'), { ...options, headers: page(host, options.headers) });
const lookup = (host, id = GOAL) => call(host, 'GET', route(id, '/run'));
const govern = (host, id = GOAL) => call(host, 'POST', route(id, '/govern'), { headers: page(host) });
const remove = (host, id = GOAL) => call(host, 'DELETE', route(id), { headers: page(host) });
async function host(config, running, uiDirectory = UI) {
  const ws = await startTrustedWorkspaceHost({ config, uiDirectory, port: 0 });
  running.push(ws);
  const bootstrap = await call(ws, 'GET', '/');
  return { ...ws, cookie: bootstrap.headers['set-cookie'][0].split(';')[0] };
}
async function closeHost(ws, running) { await ws.close(); running.splice(running.findIndex((item) => item.port === ws.port), 1); }

// Controller store evidence, read from disk.
const runFiles = (controller) => readdirSync(controller).filter((name) => /^[0-9a-f]{64}\.json$/.test(name));
const claimFiles = (controller) => existsSync(join(controller, 'changes'))
  ? readdirSync(join(controller, 'changes')).filter((name) => /^[0-9a-f]{64}\.json$/.test(name)) : [];
const runOf = (controller, runId) => JSON.parse(readFileSync(join(controller, `${sha(runId)}.json`), 'utf8')).run;
const claimOf = (controller, changeKey) => JSON.parse(readFileSync(join(controller, 'changes', `${changeKey}.json`), 'utf8')).record;
const registryFiles = (registry) => existsSync(join(registry, 'records')) ? readdirSync(join(registry, 'records')).filter((name) => name.endsWith('.json')) : [];
const mint = (registry) => JSON.parse(readFileSync(join(registry, 'records', registryFiles(registry)[0]), 'utf8')).record;
const tree = (path) => existsSync(path) ? readdirSync(path, { recursive: true }).map(String).sort() : null;
function editGoal(config, edit) {
  const file = join(config.workspace.dataDirectory, 'cand.queue.json');
  const envelope = JSON.parse(readFileSync(file, 'utf8'));
  edit(envelope.queue.goals[0], envelope.queue.history[0].goal);
  envelope.checksum = sha(JSON.stringify(envelope.queue));
  writeFileSync(file, JSON.stringify(envelope));
}
function assertNoRun(f) {
  assert.deepEqual(runFiles(f.controller), [], 'a run file exists');
  assert.deepEqual(claimFiles(f.controller), [], 'an admission claim exists');
}
const EXECUTION_WORDS = /RUNNING|EXECUTING|Claude|Codex|authorized to execute|packet ready|PACKET_READY|ARCHITECTURE|architecture started/i;

// ---------------------------------------------------------------- canonical path
await check('A/B/N/O. an attributed governed Goal establishes exactly one ROOT run "run-" + changeKey, in IDLE', async (dir, running) => {
  const f = fixture(dir); add(f.config);
  const ws = await host(f.config, running);
  assert.equal((await govern(ws)).status, 200);
  const record = mint(f.registry);
  const before = await lookup(ws);
  assert.equal(before.status, 200);
  assert.deepEqual(before.json, { provenance: 'CONTROLLER_STORE', state: 'NOT_ADMITTED', rootClaim: 'NONE', runId: null,
    change: { kind: 'SLICE', changeId: record.sliceId }, changeKey: record.changeKey, repository: 'synthetic/governed',
    execution: 'NOT_STARTED' });
  assertNoRun(f);
  const res = await admit(ws);
  assert.equal(res.status, 200, res.text);
  const runId = `run-${record.changeKey}`;
  assert.equal(rootRunIdOf(record.changeKey), runId);
  assert.match(runId, /^run-[0-9a-f]{64}$/);
  assert.equal(record.changeKey, changeKeyOf({ repository: 'synthetic/governed', sliceId: record.sliceId }));
  assert.deepEqual(res.json, { provenance: 'CONTROLLER_STORE', state: 'ADMITTED', admission: 'ROOT', recordClass: 'OPERATIONAL_RECORD',
    runId, change: { kind: 'SLICE', changeId: record.sliceId }, changeKey: record.changeKey, repository: 'synthetic/governed',
    controllerState: 'IDLE', execution: 'NOT_STARTED', modelStarted: false, packetIssued: false, authorityGranted: false });
  assert.doesNotMatch(res.text, EXECUTION_WORDS);
  assert.ok(!res.text.includes(dir), 'a storage path leaked');
  assert.doesNotMatch(res.text, /principalRef|checksum|admittedAt|chief_workspace_session/);
  // N: the stored run is exactly a fresh IDLE run of this Change.
  assert.deepEqual(runFiles(f.controller), [`${sha(runId)}.json`]);
  assert.deepEqual(runOf(f.controller, runId), { runId, sliceId: record.sliceId, repository: 'synthetic/governed', state: 'IDLE',
    implementationIterations: 0, acceptanceFailures: 0, audit: [] });
  // O: the R4L claim is the ROOT of this exact Change.
  const claim = claimOf(f.controller, record.changeKey);
  assert.equal(claim.kind, 'CHANGE_ADMISSION'); assert.equal(claim.recordClass, 'OPERATIONAL_RECORD');
  assert.equal(claim.rootRunId, runId); assert.deepEqual(claim.lineage, [{ runId, relation: 'ROOT' }]);
  assert.equal(claim.repository, 'synthetic/governed'); assert.equal(claim.sliceId, record.sliceId);
  assert.deepEqual(claimFiles(f.controller), [`${record.changeKey}.json`]);
  assert.deepEqual((await lookup(ws)).json, res.json);
  // The Goal itself is unchanged: still non-authoritative local input.
  const queue = await call(ws, 'GET', '/api/v0/projects/cand/goals');
  assert.equal(queue.json.goals[0].authority, 'NON_AUTHORITATIVE'); assert.equal(queue.json.goals[0].execution, 'NOT_STARTED');
});

await check('C-G. the browser supplies no identity: bodies, Content-Types, transfer bodies and queries are refused', async (dir, running) => {
  const f = fixture(dir); add(f.config);
  const ws = await host(f.config, running); await govern(ws);
  for (const field of ['runId', 'repository', 'sliceId', 'changeKey', 'sourceKey', 'submittedBy', 'principalRef', 'createdAt',
    'objective', 'text', 'state', 'controllerState', 'authority', 'role', 'actor']) {
    const res = await admit(ws, GOAL, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [field]: 'forged' }) });
    assert.equal(res.status, 400, field); assert.equal(res.json.error.code, 'UNEXPECTED_BODY', field);
  }
  for (const options of [{ body: 'x' }, { headers: { 'Content-Type': 'application/json', 'Content-Length': '0' } },
    { headers: { 'Transfer-Encoding': 'chunked' } }, { headers: { 'Content-Type': 'text/plain' }, body: '' },
    { headers: { 'Content-Length': '5' }, body: 'run-x' }]) {
    const res = await admit(ws, GOAL, options);
    assert.equal(res.status, 400); assert.equal(res.json.error.code, 'UNEXPECTED_BODY');
  }
  for (const query of ['?runId=run-forged', '?repository=synthetic/forged', '?sliceId=x', '?changeKey=' + '0'.repeat(64), '?x']) {
    for (const res of [await call(ws, 'POST', route(GOAL, '/run' + query), { headers: page(ws) }),
      await call(ws, 'GET', route(GOAL, '/run' + query))]) {
      assert.equal(res.status, 400, query); assert.equal(res.json.error.code, 'UNKNOWN_FIELD');
    }
  }
  assert.deepEqual(runFiles(f.controller), []);
  // A runId in the path is not a route either.
  assert.equal((await call(ws, 'POST', route(GOAL, '/run/run-forged'), { headers: page(ws) })).status, 404);
  assertNoRun(f);
});

await check('H. a legacy unattributed Goal is refused without adoption or history change', async (dir, running) => {
  const f = fixture(dir); add(f.config);
  editGoal(f.config, (goal, event) => { delete goal.submittedBy; delete event.submittedBy; });
  const file = join(f.config.workspace.dataDirectory, 'cand.queue.json'), original = readFileSync(file, 'utf8');
  const ws = await host(f.config, running);
  for (const res of [await admit(ws), await lookup(ws)]) { assert.equal(res.status, 409); assert.equal(res.json.error.code, 'UNATTRIBUTED_GOAL'); }
  assert.equal(readFileSync(file, 'utf8'), original); assertNoRun(f); assert.deepEqual(registryFiles(f.registry), []);
});

await check("I. another Human's governed Goal is refused to the session Human", async (dir, running) => {
  const f = fixture(dir); add(f.config, 'Owned by another Human', OTHER);
  await gc1(f.config).governance.govern('cand', GOAL, OTHER);
  assert.equal(registryFiles(f.registry).length, 1);
  const ws = await host(f.config, running);
  for (const res of [await admit(ws), await lookup(ws)]) { assert.equal(res.status, 403); assert.equal(res.json.error.code, 'GOAL_PRINCIPAL_MISMATCH'); }
  assertNoRun(f);
  await assert.rejects(ra1(f.config).admit('cand', GOAL, HUMAN), (error) => error.code === 'GOAL_PRINCIPAL_MISMATCH');
  assertNoRun(f);
});

await check('J. unknown, malformed and unconfigured Goals create nothing', async (dir, running) => {
  const f = fixture(dir); add(f.config);
  const ws = await host(f.config, running); await govern(ws);
  for (const id of [UNKNOWN, 'not-a-goal']) {
    for (const res of [await admit(ws, id), await lookup(ws, id)]) { assert.equal(res.status, 404); assert.equal(res.json.error.code, 'UNKNOWN_GOAL'); }
  }
  assert.equal((await call(ws, 'POST', `/api/v0/projects/unconfigured/goals/${GOAL}/run`, { headers: page(ws) })).status, 404);
  assertNoRun(f);
});

await check('K. a Goal without its GC1 Change is GOAL_NOT_GOVERNED: no implicit mint and no run', async (dir, running) => {
  const f = fixture(dir); add(f.config);
  const ws = await host(f.config, running);
  const res = await admit(ws);
  assert.equal(res.status, 409); assert.equal(res.json.error.code, 'GOAL_NOT_GOVERNED');
  assert.deepEqual((await lookup(ws)).json, { provenance: 'CHANGE_REGISTRY', state: 'GOAL_NOT_GOVERNED', runId: null });
  assert.deepEqual(registryFiles(f.registry), []); assertNoRun(f);
  assert.equal((await call(ws, 'GET', route(GOAL, '/governance'))).json.state, 'NOT_GOVERNED');
});

await check('L. a durable Goal that no longer equals its exact Change binding is refused, and nothing is rewritten', async (dir, running) => {
  const f = fixture(dir); add(f.config);
  const ws = await host(f.config, running); await govern(ws);
  const record = readFileSync(join(f.registry, 'records', registryFiles(f.registry)[0]), 'utf8');
  const goalFile = join(f.config.workspace.dataDirectory, 'cand.queue.json'), sourceBytes = readFileSync(goalFile, 'utf8');
  for (const [field, value] of [['text', 'Changed exact objective'], ['createdAt', '2026-10-07T00:00:00.000Z']]) {
    writeFileSync(goalFile, sourceBytes);
    editGoal(f.config, (goal, event) => { goal[field] = value; event[field] = value; });
    for (const res of [await admit(ws), await lookup(ws)]) {
      assert.equal(res.status, 409, field); assert.equal(res.json.error.code, 'CHANGE_SOURCE_BINDING_CONFLICT', field);
    }
  }
  assert.equal(readFileSync(join(f.registry, 'records', registryFiles(f.registry)[0]), 'utf8'), record); assertNoRun(f);
});

await check('M. a governed repository binding changed after mint conflicts; the display repository has no identity role', async (dir, running) => {
  const f = fixture(dir); add(f.config);
  const first = await host(f.config, running); await govern(first); await closeHost(first, running);
  const changedBinding = structuredClone(f.raw); changedBinding.governance.repositories[0].repository = 'synthetic/other';
  const ws = await host(parseTrustedWorkspaceHostConfig(changedBinding, dir), running);
  for (const res of [await admit(ws), await lookup(ws)]) { assert.equal(res.status, 409); assert.equal(res.json.error.code, 'CHANGE_SOURCE_BINDING_CONFLICT'); }
  assertNoRun(f); await closeHost(ws, running);
  const changedDisplay = structuredClone(f.raw); changedDisplay.workspace.projects[0].repository = '/unrelated/display';
  const display = await host(parseTrustedWorkspaceHostConfig(changedDisplay, dir), running);
  const res = await admit(display);
  assert.equal(res.status, 200); assert.equal(res.json.repository, 'synthetic/governed');
});

await check('P/Q. repeated admission and host restart return the same run, ROOT and bytes', async (dir, running) => {
  const f = fixture(dir); add(f.config);
  const first = await host(f.config, running); await govern(first);
  const original = await admit(first);
  const key = original.json.changeKey;
  const runBytes = readFileSync(join(f.controller, `${sha(original.json.runId)}.json`), 'utf8');
  const claimBytes = readFileSync(join(f.controller, 'changes', `${key}.json`), 'utf8');
  for (let i = 0; i < 3; i++) assert.deepEqual((await admit(first)).json, original.json);
  await closeHost(first, running);
  const second = await host(f.config, running);
  assert.deepEqual((await lookup(second)).json, original.json);
  assert.deepEqual((await admit(second)).json, original.json);
  assert.equal(readFileSync(join(f.controller, `${sha(original.json.runId)}.json`), 'utf8'), runBytes);
  assert.equal(readFileSync(join(f.controller, 'changes', `${key}.json`), 'utf8'), claimBytes);
  assert.equal(runFiles(f.controller).length, 1); assert.equal(claimFiles(f.controller).length, 1);
  assert.equal(existsSync(join(f.controller, 'changes', 'refusals')), false, 'an identical retry was recorded as a refused second run');
});

await check('R. concurrent identical admissions in one process converge on one run', async (dir, running) => {
  const f = fixture(dir); add(f.config);
  const ws = await host(f.config, running); await govern(ws);
  const results = await Promise.all(Array.from({ length: 6 }, () => admit(ws)));
  for (const res of results) { assert.equal(res.status, 200, res.text); assert.deepEqual(res.json, results[0].json); }
  assert.equal(runFiles(f.controller).length, 1); assert.equal(claimFiles(f.controller).length, 1);
});

// ---------------------------------------------------------------- independent processes
const heldChildScript = `
  import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
  const [rawText, path, operation, held, release, ui] = process.argv.slice(1);
  const original = fs.openSync;
  let stopped = false;
  fs.openSync = function(target, ...args) {
    const fd = original.call(fs, target, ...args);
    if (!stopped && typeof target === 'string' && target.endsWith('cand.queue.json.lock')) {
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
    const response = await fetch(host.url + path.slice(1), { method: operation,
      headers: { Cookie: cookie, Origin: host.url.slice(0, -1), 'X-Chief-Workspace': '1' } });
    console.log(JSON.stringify({ status: response.status, json: await response.json() }));
  } finally { await host.close(); }
`;
function heldChild(f, dir, operation, path) {
  const held = join(dir, `held-${operation}`), release = join(dir, `release-${operation}`);
  const child = spawn(process.execPath, ['--input-type=module', '-e', heldChildScript, JSON.stringify(f.raw), path, operation, held, release, UI],
    { cwd: ROOT });
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
      while (!existsSync(held)) { if (Date.now() >= deadline || child.exitCode !== null) throw new Error('child did not acquire the project lock: ' + errors); await sleep(10); } } };
}

await check('S. two independent host processes admitting concurrently converge on one deterministic run', async (dir, running) => {
  const f = fixture(dir); add(f.config);
  const ws = await host(f.config, running); await govern(ws);
  const child = heldChild(f, dir, 'POST', route(GOAL, '/run'));
  try {
    await child.wait(); const pending = admit(ws); await sleep(30); child.release();
    const first = await child.done, second = await pending;
    assert.equal(first.status, 200, JSON.stringify(first)); assert.equal(second.status, 200, second.text);
    assert.deepEqual(second.json, first.json);
    assert.equal(first.json.runId, `run-${mint(f.registry).changeKey}`);
    assert.equal(runFiles(f.controller).length, 1); assert.equal(claimFiles(f.controller).length, 1);
  } finally { child.release(); await child.done.catch(() => {}); }
});

await check('AH. govern vs admit across processes: admit first sees no Change; govern first lets admission follow', async (dir, running) => {
  const f = fixture(dir); add(f.config);
  const ws = await host(f.config, running);
  // Admission holds the Goal lock before any mint: GOAL_NOT_GOVERNED, and governance proceeds after it.
  const admitChild = heldChild(f, dir, 'POST', route(GOAL, '/run'));
  try {
    await admitChild.wait(); const pending = govern(ws); await sleep(30); admitChild.release();
    const first = await admitChild.done;
    assert.equal(first.status, 409); assert.equal(first.json.error.code, 'GOAL_NOT_GOVERNED');
    assert.equal((await pending).status, 200);
    assertNoRun(f);
  } finally { admitChild.release(); await admitChild.done.catch(() => {}); }
  // Governance (already complete) first: a later admission establishes the run.
  assert.equal((await admit(ws)).status, 200);
  assert.equal(runFiles(f.controller).length, 1);
});

await check('AH. govern holding the lock first lets the waiting admission establish the run', async (dir, running) => {
  const f = fixture(dir); add(f.config);
  const ws = await host(f.config, running);
  const child = heldChild(f, dir, 'POST', route(GOAL, '/govern'));
  try {
    await child.wait(); const pending = admit(ws); await sleep(30); child.release();
    assert.equal((await child.done).status, 200);
    const res = await pending; assert.equal(res.status, 200, res.text); assert.equal(res.json.state, 'ADMITTED');
    assert.equal(runFiles(f.controller).length, 1); assert.equal(registryFiles(f.registry).length, 1);
  } finally { child.release(); await child.done.catch(() => {}); }
});

await check('AI/AJ. DELETE winning removes an ungoverned source and admission then creates nothing', async (dir, running) => {
  const f = fixture(dir); add(f.config);
  const ws = await host(f.config, running);
  const child = heldChild(f, dir, 'DELETE', route(GOAL));
  try {
    await child.wait(); const pending = admit(ws); await sleep(30); child.release();
    assert.equal((await child.done).status, 200);
    const res = await pending; assert.equal(res.status, 404); assert.equal(res.json.error.code, 'UNKNOWN_GOAL');
    assertNoRun(f); assert.deepEqual(registryFiles(f.registry), []);
  } finally { child.release(); await child.done.catch(() => {}); }
});

await check('AI/AJ. admission holding the lock blocks DELETE; the governed source is retained with its run', async (dir, running) => {
  const f = fixture(dir); add(f.config);
  const ws = await host(f.config, running); await govern(ws);
  assert.equal((await remove(ws)).json.error.code, 'GOAL_ALREADY_GOVERNED');
  const child = heldChild(f, dir, 'POST', route(GOAL, '/run'));
  try {
    await child.wait();
    const busy = await remove(ws); assert.equal(busy.status, 409); assert.equal(busy.json.error.code, 'GOAL_STORE_BUSY');
    child.release(); assert.equal((await child.done).status, 200);
  } finally { child.release(); await child.done.catch(() => {}); }
  const res = await remove(ws); assert.equal(res.status, 409); assert.equal(res.json.error.code, 'GOAL_ALREADY_GOVERNED');
  assert.equal(new FileGoalStore(f.config.workspace.dataDirectory).read('cand').goals.length, 1);
  assert.equal(runFiles(f.controller).length, 1);
  assert.equal((await lookup(ws)).json.state, 'ADMITTED');
});

await check('an abandoned Goal Store project lock is a bounded refusal and is never repaired', async (dir, running) => {
  const f = fixture(dir); add(f.config);
  const ws = await host(f.config, running); await govern(ws);
  const lock = join(f.config.workspace.dataDirectory, 'cand.queue.json.lock'); writeFileSync(lock, 'uncertain writer');
  const res = await admit(ws); assert.equal(res.status, 409); assert.equal(res.json.error.code, 'GOAL_STORE_BUSY');
  assert.equal(readFileSync(lock, 'utf8'), 'uncertain writer'); assertNoRun(f);
});

// ---------------------------------------------------------------- R4L semantics through the new surface
await check('T. R4L still refuses any second ROOT for the admitted Change; RA1 keeps reporting the one ROOT', async (dir, running) => {
  const f = fixture(dir); add(f.config);
  const ws = await host(f.config, running); await govern(ws);
  const admitted = (await admit(ws)).json, record = mint(f.registry);
  const store = new FileControllerStore(f.controller), controller = new AutomationController({ now: () => new Date().toISOString() }, store);
  assert.throws(() => controller.createRun('run-second', record.sliceId, record.repository), (error) => error.code === 'SECOND_RUN_FOR_CHANGE');
  assert.equal(store.get('run-second'), undefined);
  assert.deepEqual((await lookup(ws)).json, admitted); assert.deepEqual((await admit(ws)).json, admitted);
  assert.equal(runFiles(f.controller).length, 1);
});

await check('U. a crash after the R4L claim leaves ROOT_PENDING; the same deterministic runId completes it', async (dir, running) => {
  const f = fixture(dir); add(f.config); await gc1(f.config).governance.govern('cand', GOAL, HUMAN);
  // A real admission whose run write fails after the claim is published (a crash between the two).
  const script = `
    import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const [rawText, ui, controller] = process.argv.slice(1);
    const rename = fs.renameSync;
    fs.renameSync = function(from, to) {
      if (String(to).startsWith(controller + '/')) { const error = new Error('simulated crash'); error.code = 'EIO'; throw error; }
      return rename.call(fs, from, to);
    };
    syncBuiltinESMExports();
    const { parseTrustedWorkspaceHostConfig } = await import('./dist/intake/workspace-host-config.js');
    const { createGoalChangeBridge } = await import('./dist/intake/goal-change-bridge.js');
    const { createGoalRunAdmissionBridge } = await import('./dist/intake/goal-run-admission-bridge.js');
    const config = parseTrustedWorkspaceHostConfig(JSON.parse(rawText), process.cwd());
    const roots = { config: config.workspace, uiDirectory: ui, changeRegistryDirectory: config.changeRegistryDirectory,
      controllerStoreDirectory: config.controllerStoreDirectory, governedRepositories: config.governedRepositories };
    const runs = createGoalRunAdmissionBridge({ ...roots, store: createGoalChangeBridge(roots).store });
    try { await runs.admit('cand', ${JSON.stringify(GOAL)}, ${JSON.stringify(HUMAN)}); console.log('{"admitted":true}'); }
    catch (error) { console.log(JSON.stringify({ code: error.code, message: error.message })); }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(f.raw), UI, f.controller], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const crashed = JSON.parse(child.stdout);
  assert.equal(crashed.code, 'RUN_ADMISSION_UNCERTAIN'); assert.doesNotMatch(crashed.message, /simulated|controller|\//);
  const record = mint(f.registry), runId = `run-${record.changeKey}`;
  assert.deepEqual(runFiles(f.controller), []); assert.deepEqual(claimFiles(f.controller), [`${record.changeKey}.json`]);
  const claimBytes = readFileSync(join(f.controller, 'changes', `${record.changeKey}.json`), 'utf8');
  assert.equal(claimOf(f.controller, record.changeKey).rootRunId, runId);
  const ws = await host(f.config, running);
  const pending = await lookup(ws);
  assert.equal(pending.json.state, 'NOT_ADMITTED'); assert.equal(pending.json.rootClaim, 'ROOT_PENDING'); assert.equal(pending.json.runId, null);
  const res = await admit(ws);
  assert.equal(res.status, 200, res.text); assert.equal(res.json.runId, runId); assert.equal(res.json.controllerState, 'IDLE');
  assert.equal(readFileSync(join(f.controller, 'changes', `${record.changeKey}.json`), 'utf8'), claimBytes, 'the claim was rewritten');
  assert.equal(runOf(f.controller, runId).state, 'IDLE'); assert.equal(runFiles(f.controller).length, 1);
});

await check('V. a stale run lock from an uncertain writer fails closed and is never removed or repaired', async (dir, running) => {
  const f = fixture(dir); add(f.config);
  const ws = await host(f.config, running); await govern(ws);
  const runId = `run-${mint(f.registry).changeKey}`;
  const lock = join(f.controller, `${sha(runId)}.json.lock`); writeFileSync(lock, 'uncertain writer');
  for (let i = 0; i < 2; i++) {
    const res = await admit(ws);
    assert.equal(res.status, 409); assert.equal(res.json.error.code, 'RUN_ADMISSION_UNCERTAIN');
    assert.ok(!res.text.includes(dir) && !res.text.includes('.lock'), 'a lock path leaked');
  }
  assert.equal(readFileSync(lock, 'utf8'), 'uncertain writer'); assertNoRun(f);
  assert.equal((await lookup(ws)).json.state, 'NOT_ADMITTED');
});

await check('W. an existing ROOT under a different runId is RUN_IDENTITY_CONFLICT: never adopted, renamed or backfilled', async (dir, running) => {
  const f = fixture(dir); add(f.config); await gc1(f.config).governance.govern('cand', GOAL, HUMAN);
  const record = mint(f.registry);
  const store = new FileControllerStore(f.controller);
  new AutomationController({ now: () => new Date().toISOString() }, store).createRun('run-legacy', record.sliceId, record.repository);
  const before = tree(f.controller), claimBytes = readFileSync(join(f.controller, 'changes', `${record.changeKey}.json`), 'utf8');
  const ws = await host(f.config, running);
  for (const res of [await admit(ws), await lookup(ws), await admit(ws)]) {
    assert.equal(res.status, 409); assert.equal(res.json.error.code, 'RUN_IDENTITY_CONFLICT');
  }
  assert.deepEqual(tree(f.controller), before, 'the Controller store changed');
  assert.equal(readFileSync(join(f.controller, 'changes', `${record.changeKey}.json`), 'utf8'), claimBytes);
  assert.equal(existsSync(join(f.controller, `${sha(`run-${record.changeKey}`)}.json`)), false);
  assert.equal(store.get('run-legacy').state, 'IDLE');
});

await check('a run that has moved beyond admission is never reported as an admitted IDLE run', async (dir, running) => {
  const f = fixture(dir); add(f.config);
  const ws = await host(f.config, running); await govern(ws);
  const { runId } = (await admit(ws)).json;
  new AutomationController({ now: () => new Date().toISOString() }, new FileControllerStore(f.controller))
    .enterArchitecture(runId, { id: 'architect', role: 'GPT_ARCHITECT' });
  for (const res of [await lookup(ws), await admit(ws)]) {
    assert.equal(res.status, 409); assert.equal(res.json.error.code, 'RUN_BEYOND_ADMISSION');
  }
  assert.equal(runFiles(f.controller).length, 1);
});

await check('Controller store and registry corruption are explicit, path-free failures that never become success', async (dir, running) => {
  const f = fixture(dir); add(f.config);
  const ws = await host(f.config, running); await govern(ws);
  const { runId } = (await admit(ws)).json;
  const runFile = join(f.controller, `${sha(runId)}.json`), runBytes = readFileSync(runFile, 'utf8');
  writeFileSync(runFile, '{broken');
  for (const res of [await admit(ws), await lookup(ws)]) {
    assert.equal(res.status, 500); assert.equal(res.json.error.code, 'RUN_ADMISSION_INTEGRITY'); assert.ok(!res.text.includes(dir));
  }
  assert.equal(readFileSync(runFile, 'utf8'), '{broken', 'corruption was repaired');
  writeFileSync(runFile, runBytes);
  const recordFile = join(f.registry, 'records', registryFiles(f.registry)[0]); writeFileSync(recordFile, '{broken');
  for (const res of [await admit(ws), await lookup(ws)]) {
    assert.equal(res.status, 500); assert.equal(res.json.error.code, 'REGISTRY_INTEGRITY'); assert.ok(!res.text.includes(dir));
  }
});

await check('a protected root replaced after the host started fails closed before admission', async (dir, running) => {
  const f = fixture(dir); add(f.config);
  const ws = await host(f.config, running); await govern(ws);
  renameSync(f.controller, join(dir, 'original-controller')); provision(f.controller);
  const res = await admit(ws);
  assert.equal(res.status, 500); assert.equal(res.json.error.code, 'GOVERNANCE_STORE_ISOLATION'); assert.ok(!res.text.includes(dir));
  assert.deepEqual(readdirSync(f.controller), []);
});

// ---------------------------------------------------------------- protected roots before listen
await check('X-AE. Controller store overlap with the registry, Goal Store or UI (equal, contained, alias) is refused before listen', async (dir) => {
  let index = 0;
  for (const kind of ['controller-equals-registry', 'controller-inside-registry', 'registry-inside-controller', 'controller-equals-goals',
    'controller-inside-goals', 'goals-inside-controller', 'goals-symlink-alias', 'goals-ancestor-alias', 'ui-equals-controller',
    'ui-contains-controller', 'ui-symlink-alias', 'ui-asset-symlink']) {
    const base = provision(join(dir, String(index++)));
    const f = fixture(base);
    let ui = UI;
    const set = (key, value) => { f.raw.governance[key] = value; };
    if (kind === 'controller-equals-registry') set('controllerStoreDirectory', f.registry);
    if (kind === 'controller-inside-registry') set('controllerStoreDirectory', provision(join(f.registry, 'controller')));
    if (kind === 'registry-inside-controller') set('changeRegistryDirectory', provision(join(f.controller, 'registry')));
    if (kind === 'controller-equals-goals') f.raw.workspace.dataDirectory = f.controller;
    if (kind === 'controller-inside-goals') {
      const goals = provision(join(base, 'goal-root')); set('controllerStoreDirectory', provision(join(goals, 'controller')));
      f.raw.workspace.dataDirectory = goals;
    }
    if (kind === 'goals-inside-controller') f.raw.workspace.dataDirectory = join(f.controller, 'goals');
    if (kind === 'goals-symlink-alias') { const alias = join(base, 'alias'); symlinkSync(f.controller, alias); f.raw.workspace.dataDirectory = alias; }
    if (kind === 'goals-ancestor-alias') {
      // The configured Controller root is a real directory reached through a symlinked ancestor; the Goal Store names its real path.
      const real = provision(join(base, 'real-parent')), link = join(base, 'linked-parent'); symlinkSync(real, link);
      set('controllerStoreDirectory', provision(join(link, 'controller'))); f.raw.workspace.dataDirectory = join(real, 'controller', 'goals');
    }
    if (kind === 'ui-equals-controller') ui = f.controller;
    if (kind === 'ui-contains-controller') ui = base;
    if (kind === 'ui-symlink-alias') { ui = join(base, 'ui-alias'); symlinkSync(f.controller, ui); }
    if (kind === 'ui-asset-symlink') {
      ui = join(base, 'ui'); cpSync(UI, ui, { recursive: true });
      writeFileSync(join(f.controller, 'secret.json'), 'protected');
      unlinkSync(join(ui, 'app.js')); symlinkSync(join(f.controller, 'secret.json'), join(ui, 'app.js'));
    }
    const controllerRoot = f.raw.governance.controllerStoreDirectory;
    const before = [tree(controllerRoot), tree(f.raw.governance.changeRegistryDirectory)];
    const goalsExisted = existsSync(f.raw.workspace.dataDirectory);
    assert.throws(() => startTrustedWorkspaceHost({ config: parseTrustedWorkspaceHostConfig(f.raw, base), uiDirectory: ui, port: 0 }),
      (error) => error.code === 'GOVERNANCE_STORE_ISOLATION', kind);
    assert.deepEqual([tree(controllerRoot), tree(f.raw.governance.changeRegistryDirectory)], before, `${kind}: a root changed`);
    assert.equal(existsSync(f.raw.workspace.dataDirectory), goalsExisted, `${kind}: the Goal Store was created`);
  }
});

await check('AF/AG. a missing, symlinked, unsafe or foreign Controller root is refused without creating or repairing it', async (dir) => {
  const f = fixture(dir);
  const refused = (label) => {
    assert.throws(() => startTrustedWorkspaceHost({ config: parseTrustedWorkspaceHostConfig(f.raw, dir), uiDirectory: UI, port: 0 }),
      (error) => error.code === 'GOVERNANCE_STORE_ISOLATION', label);
    assert.equal(existsSync(f.config.workspace.dataDirectory), false, `${label}: the Goal Store was created`);
  };
  for (const mode of [0o777, 0o770, 0o720, 0o702]) {
    chmodSync(f.controller, mode); refused(`mode ${mode.toString(8)}`);
    assert.deepEqual(readdirSync(f.controller), []); assert.equal(statSync(f.controller).mode & 0o777, mode, 'permissions were repaired');
  }
  chmodSync(f.controller, 0o700);
  renameSync(f.controller, join(dir, 'target')); symlinkSync(join(dir, 'target'), f.controller);
  refused('symlinked root'); assert.deepEqual(readdirSync(join(dir, 'target')), []);
  unlinkSync(f.controller);
  refused('missing root'); assert.equal(existsSync(f.controller), false, 'the missing root was provisioned');
  writeFileSync(f.controller, 'not a directory'); refused('regular file');
  unlinkSync(f.controller);
  for (const value of ['./controller', '', `${f.controller}/`, `${dir}/x/../controller`]) {
    const raw = structuredClone(f.raw); raw.governance.controllerStoreDirectory = value;
    assert.throws(() => parseTrustedWorkspaceHostConfig(raw, dir), undefined, JSON.stringify(value));
  }
  const missingKey = structuredClone(f.raw); delete missingKey.governance.controllerStoreDirectory;
  assert.throws(() => parseTrustedWorkspaceHostConfig(missingKey, dir));
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    f.raw.governance.controllerStoreDirectory = '/usr'; refused('root owned by another account');
  }
});

await check('the narrow intake guard is not a model/validation isolation capability', async (dir) => {
  const { GovernanceStoreIsolation } = await import('./dist/automation/governance-store-isolation.js');
  const f = fixture(dir);
  const guard = GovernanceStoreIsolation.forTrustedIntake({ changeRegistryDirectory: f.registry, controllerStoreDirectory: f.controller });
  assert.equal(guard instanceof GovernanceStoreIsolation, false);
  assert.deepEqual(Object.keys(guard), ['assertDisjoint']);
  assert.ok(Object.isFrozen(guard));
  assert.throws(() => guard.assertDisjoint('probe', f.controller), /CONTROLLER_STORE/);
  assert.throws(() => guard.assertDisjoint('probe', f.registry), /CHANGE_REGISTRY/);
  guard.assertDisjoint('probe', join(dir, 'elsewhere'));
});

// ---------------------------------------------------------------- authority, execution and R4A0
await check('AR/AS. R4A0 sees no run before admission and exactly the admitted IDLE ROOT run after it', async (dir, running) => {
  const f = fixture(dir); add(f.config);
  const roots = { controllerStoreDirectory: f.controller, authorityArchiveDirectory: join(dir, 'authority-archive') };
  const ws = await host(f.config, running); await govern(ws);
  const before = readGovernedModel(roots);
  assert.deepEqual(before.runs, []); assert.deepEqual(before.changes, []); assert.deepEqual(before.anomalies, []);
  const admitted = (await admit(ws)).json, record = mint(f.registry);
  const after = readGovernedModel(roots);
  assert.equal(after.runs.length, 1); assert.equal(after.changes.length, 1); assert.deepEqual(after.anomalies, []);
  const [run] = after.runs, [change] = after.changes;
  assert.equal(run.runId, admitted.runId); assert.equal(run.state, 'IDLE'); assert.equal(run.sliceId, record.sliceId);
  assert.deepEqual(run.change, { kind: 'SLICE', changeId: record.sliceId }); assert.equal(run.changeKey, record.changeKey);
  assert.equal(run.admission.status, 'ROOT'); assert.equal(run.admission.rootRunId, admitted.runId);
  assert.equal(run.packet, null); assert.equal(run.audit.length, 0);
  assert.deepEqual(change.change, admitted.change); assert.equal(change.changeKey, admitted.changeKey);
  assert.deepEqual(change.runs.map((item) => [item.runId, item.state]), [[admitted.runId, 'IDLE']]);
  assert.deepEqual(after.authority, []); assert.equal(after.snapshot.authorityArchive, 'ABSENT');
  assert.equal(existsSync(roots.authorityArchiveDirectory), false);
});

await check('AO/AP/AQ. a real admission loads no runner, live adapter, authority archive, read model or provider and spawns nothing', async (dir) => {
  const f = fixture(dir); add(f.config);
  const script = `
    import { registerHooks, syncBuiltinESMExports } from 'node:module';
    import cp from 'node:child_process'; import net from 'node:net'; import https from 'node:https'; import dns from 'node:dns';
    const loaded = new Set(); const calls = [];
    registerHooks({ resolve(specifier, context, next) { const result = next(specifier, context); loaded.add(result.url); return result; } });
    const watch = (owner, name, label) => { const original = owner[name]; owner[name] = function (...args) {
      if (/dist\\//.test(new Error().stack)) calls.push(label); return original.apply(this, args); }; };
    for (const name of ['spawn', 'exec', 'execFile', 'fork', 'spawnSync', 'execSync', 'execFileSync']) watch(cp, name, 'child_process.' + name);
    watch(net, 'connect', 'net.connect'); watch(net, 'createConnection', 'net.createConnection'); watch(https, 'request', 'https.request');
    syncBuiltinESMExports();
    const { parseTrustedWorkspaceHostConfig } = await import('./dist/intake/workspace-host-config.js');
    const { startTrustedWorkspaceHost } = await import('./dist/intake/workspace-host.js');
    const host = await startTrustedWorkspaceHost({ config: parseTrustedWorkspaceHostConfig(JSON.parse(process.argv[1]), process.cwd()),
      uiDirectory: process.argv[2], port: 0 });
    const page = await fetch(host.url); const cookie = page.headers.get('set-cookie').split(';')[0];
    const headers = { Cookie: cookie, Origin: host.url.slice(0, -1), 'X-Chief-Workspace': '1' };
    const base = host.url + 'api/v0/projects/cand/goals/${GOAL}';
    const governed = await fetch(base + '/govern', { method: 'POST', headers });
    const admitted = await fetch(base + '/run', { method: 'POST', headers });
    await host.close();
    console.log(JSON.stringify({ loaded: [...loaded], calls, statuses: [governed.status, admitted.status], run: await admitted.json() }));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(f.raw), UI], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.trim().split('\n').at(-1));
  assert.deepEqual(result.statuses, [200, 200]); assert.equal(result.run.controllerState, 'IDLE');
  const local = result.loaded.filter((url) => url.startsWith('file:')).map((url) => relative(ROOT, fileURLToPath(url)));
  const forbidden = local.filter((file) => /^dist\/(automation\/(runner|bridge|live\/|authority\/|read-model\/|process-executor|offline-validation|egress-journal|file-egress-journal|invocation-journal|file-invocation-journal)|providers\/|execution\/|modes\/|agents\/|consultation\/|context\/|stress-test\/)/.test(file));
  assert.deepEqual(forbidden, [], `the host loaded ${forbidden.join(', ')}`);
  assert.ok(local.includes('dist/automation/root-run-admitter.js'));
  assert.ok(!result.loaded.some((url) => /@anthropic-ai|\/openai\/|@google\/generative-ai|@modelcontextprotocol/.test(url)), 'a provider package loaded');
  assert.deepEqual(result.calls, [], 'the host spawned a process or opened an outbound connection');
  assert.equal(existsSync(join(dir, 'authority')), false);
  assert.equal(runOf(f.controller, result.run.runId).audit.length, 0, 'a lifecycle transition followed admission');
});

await check('AX. the run routes keep D1 session, Host, origin, Fetch-Site and Workspace-header isolation', async (dir, running) => {
  const f = fixture(dir); add(f.config);
  const ws = await host(f.config, running); await govern(ws);
  for (const [headers, status, code] of [
    [{ Cookie: '' }, 401, 'NO_LOCAL_SESSION'], [{ Cookie: 'chief_workspace_session=forged' }, 401, 'NO_LOCAL_SESSION'],
    [{ Host: 'attacker.example' }, 421, 'WRONG_HOST'], [{ Origin: 'http://attacker.example' }, 403, 'WRONG_ORIGIN'],
    [{ Origin: '' }, 403, 'WRONG_ORIGIN'], [{ 'Sec-Fetch-Site': 'cross-site' }, 403, 'CROSS_SITE'],
    [{ 'Sec-Fetch-Site': 'same-site' }, 403, 'CROSS_SITE'], [{ 'X-Chief-Workspace': '0' }, 403, 'MISSING_HEADER'],
  ]) { const res = await admit(ws, GOAL, { headers }); assert.equal(res.status, status, code); assert.equal(res.json.error.code, code); }
  for (const [headers, status] of [[{ Cookie: '' }, 401], [{ Host: 'attacker.example' }, 421], [{ 'Sec-Fetch-Site': 'cross-site' }, 403]]) {
    assert.equal((await call(ws, 'GET', route(GOAL, '/run'), { headers })).status, status);
  }
  for (const method of ['PUT', 'PATCH', 'OPTIONS']) assert.equal((await call(ws, method, route(GOAL, '/run'), { headers: page(ws) })).status, 405);
  assert.equal((await call(ws, 'DELETE', route(GOAL, '/run'), { headers: page(ws) })).status, 404);
  assertNoRun(f);
});

await check('a Workspace without the injected port refuses run admission and holds no Controller capability', async (dir, running) => {
  const f = fixture(dir); add(f.config); await gc1(f.config).governance.govern('cand', GOAL, HUMAN);
  const raw = await startWorkspaceServer({ config: f.config.workspace, uiDirectory: UI, port: 0 }); running.push(raw);
  const ws = { ...raw, cookie: (await call(raw, 'GET', '/')).headers['set-cookie'][0].split(';')[0] };
  for (const res of [await admit(ws), await lookup(ws)]) { assert.equal(res.status, 503); assert.equal(res.json.error.code, 'RUN_ADMISSION_UNAVAILABLE'); }
  assertNoRun(f);
  assert.deepEqual(API_ROUTES.filter((item) => /\/run$/.test(item)), [
    'POST /api/v0/projects/:projectId/goals/:goalId/run', 'GET /api/v0/projects/:projectId/goals/:goalId/run']);
  assert.ok(!API_ROUTES.some((item) => /\/(start|execute)\b|^POST \/api\/v0\/run|create-run|packet|authoriz/.test(item)));
});

await check('the root-run admitter exposes only lookup and admit, derives the runId, and checks the exact changeKey', async (dir) => {
  const controller = provision(join(dir, 'controller'));
  const admitter = openRootRunAdmitter(controller);
  assert.deepEqual(Object.keys(admitter).sort(), ['admit', 'lookup']); assert.ok(Object.isFrozen(admitter));
  const change = { repository: 'synthetic/governed', sliceId: 'goal-slice' };
  const changeKey = changeKeyOf(change);
  assert.deepEqual(admitter.lookup({ ...change, changeKey }), { admission: 'NONE', runId: null });
  for (const forged of [{ ...change, changeKey: '0'.repeat(64) }, { ...change, changeKey: changeKey.toUpperCase() },
    { ...change, changeKey: changeKey.slice(0, 63) }, { repository: ' synthetic/governed', sliceId: 'goal-slice', changeKey },
    { ...change, sliceId: 'Goal-slice', changeKey }]) {
    assert.throws(() => admitter.admit(forged), (error) => error.code === 'RUN_ADMISSION_INTEGRITY', JSON.stringify(forged));
  }
  assert.deepEqual(runFiles(controller), []);
  const run = admitter.admit({ ...change, changeKey, runId: 'run-forged', state: 'ARCHITECTURE' });
  assert.equal(run.runId, `run-${changeKey}`); assert.equal(run.controllerState, 'IDLE');
  assert.throws(() => rootRunIdOf('not-a-key'), (error) => error.code === 'RUN_ADMISSION_INTEGRITY');
  assert.equal(sourceKeyOf({ kind: 'WORKSPACE_GOAL', projectId: 'cand', goalId: GOAL }).length, 64);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
