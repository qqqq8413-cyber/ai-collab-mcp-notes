import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAiPilotPreparation } from './dist/ai-pilot/preparation.js';
import { PreparationStore } from './dist/ai-pilot/plans.js';
import { createGoalChangeBridge } from './dist/intake/goal-change-bridge.js';
import { createGoalRunAdmissionBridge } from './dist/intake/goal-run-admission-bridge.js';
import { createGoalExecutionStatusBridge } from './dist/intake/goal-execution-status-bridge.js';
import { parseTrustedWorkspaceHostConfig } from './dist/intake/workspace-host-config.js';
import { startTrustedWorkspaceHost } from './dist/intake/workspace-host.js';
import { openGovernedExecutionDriver } from './dist/automation/execution-driver.js';
import { FileInvocationJournal } from './dist/automation/file-invocation-journal.js';
import { digest } from './dist/pilot/store.js';
import { aiPlansHTML } from './workspace-ui/ai-pilot.js';

const HUMAN = { schemaVersion: 1, kind: 'HUMAN', principalRef: 'human:synthetic-p2-owner' };
const OTHER = { ...HUMAN, principalRef: 'human:synthetic-other' };
const ARCHITECT = 'architect:synthetic-p2';
const UI = join(process.cwd(), 'workspace-ui');
const clock = { now: () => new Date().toISOString() };
let passed = 0, failed = 0;
async function test(name, fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'chief-p2-')));
  try { await fn(dir); passed++; console.log('  PASS ' + name); }
  catch (e) { failed++; console.error('  FAIL ' + name + ': ' + e.stack); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
const provision = p => { mkdirSync(p, { mode: 0o700 }); chmodSync(p, 0o700); return p; };
function world(dir, extra = {}) {
  const registry = provision(join(dir, 'registry')), controller = provision(join(dir, 'controller')), authority = provision(join(dir, 'authority'));
  const config = parseTrustedWorkspaceHostConfig({ schemaVersion: 1, workspace: { schemaVersion: 1,
    dataDirectory: join(dir, 'workspace'), humanPrincipal: { principalRef: HUMAN.principalRef },
    projects: [{ projectId: 'chief', displayName: 'Synthetic P2 project', repository: 'synthetic/chief' }] },
    governance: { changeRegistryDirectory: registry, controllerStoreDirectory: controller,
      repositories: [{ projectId: 'chief', repository: 'synthetic/chief' }],
      executionStatus: { authorityArchiveDirectory: authority, architectPrincipalRef: ARCHITECT } } }, dir);
  const roots = { config: config.workspace, uiDirectory: UI, changeRegistryDirectory: registry, controllerStoreDirectory: controller,
    governedRepositories: config.governedRepositories };
  const bridge = createGoalChangeBridge(roots);
  const runAdmission = createGoalRunAdmissionBridge({ ...roots, store: bridge.store });
  const executionStatus = createGoalExecutionStatusBridge({ ...roots, store: bridge.store, authorityArchiveDirectory: authority, architectPrincipalRef: ARCHITECT });
  const opts = { dataDirectory: config.workspace.dataDirectory, repositories: { chief: 'synthetic/chief' }, store: bridge.store,
    governance: bridge.governance, runAdmission, executionStatus, ...extra };
  const service = createAiPilotPreparation(opts);
  const goal = bridge.store.addGoal('chief', 'Review only README.md; produce a bounded read-only findings report.', HUMAN).queue.goals.at(-1);
  const spec = { requestId: randomUUID(), goalId: goal.goalId, agentId: 'claude-code' };
  return { registry, controller, authority, config, roots, ...bridge, runAdmission, executionStatus, opts, service, goal, spec,
    create(input = spec, human = HUMAN) { return service.create('chief', input, human); },
    action(action = 'PREPARE', input = {}, human = HUMAN) { return service.action('chief', spec.requestId, { action, requestId: randomUUID(), ...input }, human); } };
}
const fileTree = root => existsSync(root) ? readdirSync(root, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).flatMap(e =>
  e.isDirectory() ? fileTree(join(root, e.name)).map(x => [e.name, x]) : [[e.name, readFileSync(join(root, e.name), 'base64')]]) : null;

await test('real Goal → GC1 mint → RA1 admission → WE1 IDLE, with no authority or model work', async dir => {
  const f = world(dir); const first = f.create().plans[0];
  assert.equal(first.execution.status, 'GOAL_NOT_GOVERNED');
  const p = (await f.action()).plans[0];
  assert.equal(p.governance.state, 'GOVERNED'); assert.equal(p.admission.state, 'ADMITTED');
  assert.equal(p.execution.status, 'RUN_IDLE'); assert.equal(p.execution.run.state, 'IDLE');
  assert.equal(p.modelCallsIssuedByPreparation, 0); assert.equal(p.authorityIssuedByPreparation, false);
  assert.deepEqual(readdirSync(f.authority), []); assert.equal(p.invocations, null);
} );
await test('draft and PREPARE are idempotent across service restart', async dir => {
  const f = world(dir); f.create(); await f.action(); const before = fileTree(dir);
  const service = createAiPilotPreparation(f.opts); service.create('chief', f.spec, HUMAN);
  await service.action('chief', f.spec.requestId, { action: 'PREPARE', requestId: randomUUID() }, HUMAN);
  assert.deepEqual(fileTree(dir), before); assert.equal(service.list('chief', HUMAN).plans.length, 1);
});
await test('request and goal rebinding cannot silently switch Agent or objective', dir => {
  const f = world(dir); f.create(); const before = fileTree(dir);
  assert.throws(() => f.create({ ...f.spec, agentId: 'codex' }), { code: 'PLAN_CONFLICT' });
  assert.throws(() => f.create({ ...f.spec, requestId: randomUUID(), agentId: 'codex' }), { code: 'PLAN_CONFLICT' });
  assert.deepEqual(fileTree(dir), before);
});
await test('START is refused before governance, controller, driver, journal or model invocation', async dir => {
  const f = world(dir); f.create(); const before = fileTree(dir);
  await assert.rejects(f.action('START'), { code: 'EXE_HOLD', status: 403 }); assert.deepEqual(fileTree(dir), before);
});
await test('START stays refused after actual IDLE admission', async dir => {
  const f = world(dir); f.create(); await f.action(); const before = fileTree(dir);
  await assert.rejects(f.action('START'), { code: 'EXE_HOLD' }); assert.deepEqual(fileTree(dir), before);
});
await test('real Driver and Invocation Journal inspections accept the actual Goal/run target, but cannot execute', async dir => {
  const f = world(dir); f.create(); const p = (await f.action()).plans[0]; let steps = 0;
  const journal = new FileInvocationJournal(join(dir, 'journal'), clock);
  const scope = (actorKind, provider) => ({ actorKind, provider, model: 'synthetic-model', egressDestinations: ['example.com:443'] });
  const driver = openGovernedExecutionDriver({ controllerStoreDirectory: f.controller, authorityArchiveDirectory: f.authority,
    changeRegistryDirectory: f.registry, runner: { step() { steps++; throw new Error('must not dispatch'); } },
    liveCallAuthorizations: {}, scopes: { IMPLEMENTATION: scope('IMPLEMENTATION', 'anthropic'), ARCHITECT_REVIEW: scope('ARCHITECT_REVIEW', 'openai') },
    architectPrincipalRef: ARCHITECT, clock });
  const service = createAiPilotPreparation({ ...f.opts, driverInspection: { inspect: t => driver.inspect(t) }, invocationInspection: { list: id => journal.list(id) } });
  const before = fileTree(dir), view = service.list('chief', HUMAN).plans[0];
  assert.equal(view.driverInspection.target.runId, p.admission.runId); assert.equal(view.driverInspection.state, 'IDLE');
  assert.deepEqual(view.invocations, []); assert.equal(view.driverInspection.readiness, 'WAITING_EXTERNAL_ACTOR');
  await assert.rejects(service.action('chief', f.spec.requestId, { action: 'START', requestId: randomUUID() }, HUMAN), { code: 'EXE_HOLD' });
  assert.equal(steps, 0); assert.deepEqual(fileTree(dir), before);
});
await test('isolated synthetic journal observation shows persisted model outcomes, not a fabricated live result', async dir => {
  const f = world(dir); f.create(); const p = (await f.action()).plans[0];
  const journal = new FileInvocationJournal(join(dir, 'synthetic-journal'), clock);
  const at = clock.now();
  const invocation = journal.prepare({ runId: p.admission.runId, sliceId: p.governance.change.changeId, packetId: 'synthetic-packet', packetHash: 'd'.repeat(64),
    occurrence: { sequence: 4, action: 'BEGIN_IMPLEMENTATION', timestamp: at }, actorKind: 'IMPLEMENTATION', provider: 'anthropic',
    model: 'synthetic-offline-port', egressDestinations: ['example.com:443'], authorizationId: 'synthetic-test-only' });
  journal.start(invocation.invocationId, 1); journal.complete(invocation.invocationId, { ok: true, value: { synthetic: true, report: 'OFFLINE_ONLY' } });
  const service = createAiPilotPreparation({ ...f.opts, invocationInspection: { list: id => journal.list(id) } });
  const result = service.list('chief', HUMAN).plans[0];
  assert.deepEqual(result.invocations, [{ invocationId: invocation.invocationId, state: 'COMPLETED' }]);
  assert.equal(result.modelCallsIssuedByPreparation, 0); assert.ok(!JSON.stringify(result).includes('OFFLINE_ONLY'));
  assert.equal(new FileInvocationJournal(join(dir, 'synthetic-journal'), clock).list(p.admission.runId)[0].state, 'COMPLETED');
});
await test('a fake READY inspection cannot bypass EXE HOLD or enable any writer', async dir => {
  const f = world(dir, { driverInspection: { inspect() { return { readiness: 'READY' }; } } }); f.create(); await f.action();
  assert.equal(f.service.list('chief', HUMAN).plans[0].readiness, 'BLOCKED');
  await assert.rejects(f.action('START'), { code: 'EXE_HOLD' }); assert.deepEqual(readdirSync(f.authority), []);
});
await test('different Human cannot create, act or read another Human’s draft', async dir => {
  const f = world(dir); f.create(); assert.throws(() => f.create(f.spec, OTHER), { code: 'GOAL_PRINCIPAL_MISMATCH' });
  await assert.rejects(f.action('PREPARE', {}, OTHER), { code: 'GOAL_PRINCIPAL_MISMATCH' });
  assert.deepEqual(f.service.list('chief', OTHER).plans, []);
});
await test('removing an ungoverned source preserves a blocked draft without breaking the remaining list', async dir => {
  const f = world(dir); f.create(); f.store.removeGoal('chief', f.goal.goalId);
  const another = f.store.addGoal('chief', 'Second bounded document review.', HUMAN).queue.goals.at(-1);
  f.service.create('chief', { requestId: randomUUID(), goalId: another.goalId, agentId: 'codex' }, HUMAN);
  const plans = f.service.list('chief', HUMAN).plans;
  assert.equal(plans.length, 2); assert.equal(plans[0].objective, null); assert.equal(plans[0].sourceMissing, true);
  assert.ok(plans[0].blockers.includes('SOURCE_GOAL_REMOVED')); assert.equal(plans[1].sourceMissing, false);
  await assert.rejects(f.action(), { code: 'UNKNOWN_GOAL' }); assert.deepEqual(readdirSync(f.authority), []);
  assert.match(aiPlansHTML(plans), /原始目標已移除/);
});
await test('cross-project and unknown goal/plan requests fail closed', async dir => {
  const f = world(dir); assert.throws(() => f.service.create('other', f.spec, HUMAN), { code: 'UNKNOWN_PROJECT' });
  assert.throws(() => f.create({ ...f.spec, goalId: 'goal-' + randomUUID() }), { code: 'UNKNOWN_GOAL' });
  await assert.rejects(f.action(), { code: 'UNKNOWN_PLAN' });
});
await test('client cannot inject grants, scope, pricing, model, tools or an unregistered Agent', dir => {
  const f = world(dir);
  for (const field of ['authorization', 'principalRef', 'model', 'tools', 'budget', 'repository', 'scope', 'pricing']) {
    assert.throws(() => f.create({ ...f.spec, [field]: 'forged' }), { code: 'INVALID_PLAN' });
  }
  assert.throws(() => f.create({ ...f.spec, agentId: 'unknown' }), { code: 'INVALID_PLAN' });
  assert.equal(f.service.list('chief', HUMAN).plans.length, 0);
});
await test('action body cannot smuggle Human authority or unsupported activation', async dir => {
  const f = world(dir); f.create();
  await assert.rejects(f.action('PREPARE', { authorization: 'forged' }), { code: 'INVALID_PLAN_ACTION' });
  await assert.rejects(f.action('APPROVE'), { code: 'INVALID_PLAN_ACTION' }); assert.deepEqual(readdirSync(f.authority), []);
});
await test('unconfigured preparation does not substitute synthetic governance or status', async dir => {
  const f = world(dir); const service = createAiPilotPreparation({ ...f.opts, governance: undefined, runAdmission: undefined, executionStatus: undefined });
  const view = service.create('chief', f.spec, HUMAN).plans[0];
  assert.equal(view.execution, null); assert.equal(view.governance, null); assert.equal(view.admission, null);
  await assert.rejects(service.action('chief', f.spec.requestId, { action: 'PREPARE', requestId: randomUUID() }, HUMAN), { code: 'PREPARATION_NOT_CONFIGURED' });
});
await test('requested model and price are explicitly unprobed/unknown; permit has no active validity or grant', dir => {
  const p = world(dir).create().plans[0];
  assert.equal(p.agent.modelSource, 'REPOSITORY_CONFIG_DEFAULT_NOT_PROBED'); assert.equal(p.permit.pricing, null);
  assert.equal(p.permit.costEnforced, false); assert.equal(p.permit.state, 'DRAFT_NOT_AUTHORITY');
  assert.equal(p.permit.validity.notBefore, null); assert.equal(p.permit.validity.expiresAt, null);
  assert.equal(p.permit.maxCalls, 1); assert.equal(p.permit.maxRetries, 0);
  assert.ok(p.blockers.includes('IMPLEMENTATION_ADAPTER_REQUIRES_BRANCH_WRITES'));
});
await test('Codex catalog exposes its review-role mismatch instead of claiming a universal worker', dir => {
  const f = world(dir); const p = f.create({ ...f.spec, agentId: 'codex' }).plans[0];
  assert.equal(p.agent.adapterRole, 'ARCHITECT_REVIEW'); assert.ok(p.blockers.includes('REVIEW_ADAPTER_REQUIRES_IMPLEMENTATION_LINEAGE'));
});
await test('checks are read-only, and failed admission retains honest partial governance', async dir => {
  const f = world(dir); f.create(); const before = fileTree(dir); await f.action('CHECK'); assert.deepEqual(fileTree(dir), before);
  const service = createAiPilotPreparation({ ...f.opts, runAdmission: { lookup: (...args) => f.runAdmission.lookup(...args), async admit() { throw new Error('SYNTHETIC_ADMISSION_FAILURE'); } } });
  await assert.rejects(service.action('chief', f.spec.requestId, { action: 'PREPARE', requestId: randomUUID() }, HUMAN), /SYNTHETIC_ADMISSION_FAILURE/);
  const p = service.list('chief', HUMAN).plans[0]; assert.equal(p.governance.state, 'GOVERNED'); assert.equal(p.admission.state, 'NOT_ADMITTED');
  assert.deepEqual(readdirSync(f.authority), []);
});
await test('tampered plan bytes and symlinked preparation storage fail closed without repair', dir => {
  const f = world(dir); f.create(); const file = join(f.config.workspace.dataDirectory, 'ai-preparation/chief.json');
  writeFileSync(file, readFileSync(file, 'utf8').replace('PERMIT_DRAFT', 'PERMIT_OTHER')); const bytes = readFileSync(file, 'utf8');
  assert.throws(() => f.service.list('chief', HUMAN), { code: 'PREPARATION_STORAGE' }); assert.equal(readFileSync(file, 'utf8'), bytes);
  const data = provision(join(dir, 'other-data')); symlinkSync(join(f.config.workspace.dataDirectory, 'ai-preparation'), join(data, 'ai-preparation'));
  assert.throws(() => new PreparationStore(data).read('chief'), { code: 'PREPARATION_STORAGE' });
});
await test('conflicting and uncertain plan locks are not removed or adopted', dir => {
  const f = world(dir), path = join(f.config.workspace.dataDirectory, 'ai-preparation'); mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'chief.json.lock'), 'uncertain owner');
  assert.throws(() => f.create(), { code: 'PREPARATION_BUSY' }); assert.equal(readFileSync(join(path, 'chief.json.lock'), 'utf8'), 'uncertain owner');
});
await test('full preparation storage refuses a new draft without removing prior evidence', dir => {
  const f = world(dir); f.create(); const file = join(f.config.workspace.dataDirectory, 'ai-preparation/chief.json');
  const envelope = JSON.parse(readFileSync(file, 'utf8')), first = envelope.payload.plans[0];
  envelope.payload.plans = Array.from({ length: 100 }, (_, i) => i ? { ...first, requestId: randomUUID(), goalId: 'goal-' + randomUUID() } : first);
  envelope.checksum = digest(envelope.payload); writeFileSync(file, JSON.stringify(envelope));
  const bytes = readFileSync(file, 'utf8'), goal = f.store.addGoal('chief', 'New bounded review.', HUMAN).queue.goals.at(-1);
  assert.throws(() => f.create({ ...f.spec, requestId: randomUUID(), goalId: goal.goalId }), { code: 'PLAN_LIMIT', status: 409 });
  assert.equal(readFileSync(file, 'utf8'), bytes);
});
await test('HTML output escapes goal, model, identifiers and permit values', dir => {
  const p = world(dir).create().plans[0]; const html = aiPlansHTML([{ ...p, objective: '<img src=x onerror=alert(1)>', requestedModel: '<script>x</script>' }]);
  assert.doesNotMatch(html, /<img|<script/); assert.match(html, /&lt;img/); assert.match(html, /disabled title="EXE HOLD/);
});
await test('production preparation has no Controller step, archive appender, process or Model Adapter path', () => {
  for (const file of ['src/ai-pilot/preparation.ts', 'src/ai-pilot/plans.ts']) {
    const code = readFileSync(file, 'utf8');
    assert.doesNotMatch(code, /\.step\(|openAuthorityArchiveAppender|new AutomationRunner|child_process|fetch\(|ImplementationAdapter|ArchitectReviewAdapter/);
  }
});

await test('real HTTP host enforces session/origin, persists preparation, and blocks START with EXE_HOLD', async dir => {
  const f = world(dir); const host = await startTrustedWorkspaceHost({ config: f.config, uiDirectory: UI, port: 0, aiPreparation: true });
  try {
    const endpoint = host.url + 'api/v0/projects/chief/ai-pilot';
    assert.equal((await fetch(endpoint)).status, 401);
    const first = await fetch(host.url); const cookie = first.headers.get('set-cookie').split(';')[0];
    const headers = { Cookie: cookie, Origin: new URL(host.url).origin, 'X-Chief-Workspace': '1', 'Content-Type': 'application/json' };
    const post = (url, body, h = headers) => fetch(url, { method: 'POST', headers: h, body: JSON.stringify(body) });
    assert.equal((await post(endpoint, f.spec, { ...headers, Origin: 'http://evil.example' })).status, 403);
    const create = await post(endpoint, f.spec); assert.equal(create.status, 201); assert.equal((await create.json()).plans.length, 1);
    const actions = endpoint + '/' + f.spec.requestId + '/actions';
    const prepare = await post(actions, { action: 'PREPARE', requestId: randomUUID() }); assert.equal(prepare.status, 200);
    assert.equal((await prepare.json()).plans[0].execution.status, 'RUN_IDLE');
    const start = await post(actions, { action: 'START', requestId: randomUUID() }); assert.equal(start.status, 403); assert.equal((await start.json()).error.code, 'EXE_HOLD');
    assert.equal((await fetch(endpoint + '?authorize=1', { headers: { Cookie: cookie } })).status, 400);
    assert.equal((await fetch(host.url + 'ai-pilot.js')).status, 200); assert.deepEqual(readdirSync(f.authority), []);
  } finally { await host.close(); }
});
await test('preparation is opt-in and host refuses overlapping authority storage before creating data', async dir => {
  const f = world(dir); const host = await startTrustedWorkspaceHost({ config: f.config, uiDirectory: UI, port: 0 });
  try {
    const first = await fetch(host.url), cookie = first.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(host.url + 'api/v0/projects/chief/ai-pilot', { headers: { Cookie: cookie } })).status, 503);
  } finally { await host.close(); }
  const before = fileTree(f.authority);
  const overlap = { ...f.config, workspace: { ...f.config.workspace, dataDirectory: join(f.authority, 'overlap') } };
  await assert.rejects(async () => startTrustedWorkspaceHost({ config: overlap, uiDirectory: UI, port: 0, aiPreparation: true }));
  assert.deepEqual(fileTree(f.authority), before);
});
console.log(`\n${passed} passed, ${failed} failed`); process.exitCode = failed ? 1 : 0;
