import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorkspaceConfig } from './dist/workspace/config.js';
import { FileGoalStore } from './dist/workspace/goal-store.js';
import { startWorkspaceServer } from './dist/workspace/server.js';
import { createGoalActivationBridge } from './dist/intake/goal-activation-bridge.js';
import { parseTrustedWorkspaceHostConfig } from './dist/intake/workspace-host-config.js';
import { validateActivationPlans } from './dist/intake/activation-plan-preflight.js';

// EXE-C2: only the Host can provision complete direct-authority documents.
// HTTP never accepts or echoes a packet, a Human grant, a model or a run identity.
const UI = join(process.cwd(), 'workspace-ui');
const HUMAN = { schemaVersion: 1, kind: 'HUMAN', principalRef: 'human:owner' };
const REPO = 'synthetic/governed';
let pass = 0, fail = 0;

function http(ws, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: ws.port, path, method,
      headers: { Host: '127.0.0.1:' + ws.port, ...(ws.cookie ? { Cookie: ws.cookie } : {}), ...headers } }, (res) => {
      const chunks = []; res.on('data', (data) => chunks.push(data));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const page = (ws) => ({ Origin: 'http://127.0.0.1:' + ws.port, 'X-Chief-Workspace': '1', 'Sec-Fetch-Site': 'same-origin' });
const route = (id) => '/api/v0/projects/chief/goals/' + id + '/activation';

async function check(name, test) {
  const dir = mkdtempSync(join(tmpdir(), 'chief-c2-'));
  const hosts = [];
  try {
    const config = parseWorkspaceConfig({ schemaVersion: 1, dataDirectory: join(dir, 'queue'),
      humanPrincipal: { principalRef: HUMAN.principalRef },
      projects: [{ projectId: 'chief', displayName: 'Chief', repository: REPO }] }, dir);
    const store = new FileGoalStore(config.dataDirectory);
    const goal = store.addGoal('chief', 'Governed activation fixture', HUMAN).queue.goals[0];
    const observed = { admitted: true, position: 'IDLE', calls: 0, lastTarget: null, bundle: null,
      repository: REPO, human: HUMAN.principalRef, fail: false };
    const status = { inspect(projectId, goalId, human) {
      assert.equal(projectId, 'chief'); assert.equal(goalId, goal.goalId); assert.deepEqual(human, HUMAN);
      const durable = store.read(projectId).goals[0];
      assert.equal(durable.goalId, goalId); assert.deepEqual(durable.submittedBy, human);
      return { status: observed.admitted ? 'RUN_IDLE' : 'RUN_NOT_ADMITTED',
        change: observed.admitted ? { changeKey: 'key-1', repository: REPO } : null,
        run: observed.admitted ? { runId: 'run-1', state: observed.position === 'IDLE' ? 'IDLE' : 'PACKET_READY', admission: 'ROOT' } : null,
        reason: null };
    } };
    const core = {
      inspect(target) {
        observed.lastTarget = target;
        return { position: observed.position, changeKey: 'key-1', change: { changeId: 'slice-1' },
          repository: observed.repository, humanPrincipalRef: observed.human,
          target, state: observed.position === 'IDLE' ? 'IDLE' : 'PACKET_READY' };
      },
      activate(target, bundle) {
        observed.calls++; observed.bundle = bundle; observed.lastTarget = target;
        if (observed.fail) throw Object.assign(new Error('refused'), { code: 'AUTHORITY_DOCUMENT_INVALID' });
        observed.position = 'PACKET_READY';
        return { target, status: 'ACTIVATED', changeKey: 'key-1' };
      },
    };
    const plan = { projectId: 'chief', goalId: goal.goalId,
      bundle: { implementationPacket: { authorityId: 'approved-packet',
        issuer: { role: 'GPT_ARCHITECT', principalRef: 'architect:synthetic' },
        subject: { repository: REPO, sliceId: 'slice-1' }, body: { sliceId: 'slice-1' } }, liveCallAuthorizations: [] } };
    const start = async (withPlans = true) => {
      const port = createGoalActivationBridge({ status, activation: core, store,
        architectPrincipalRef: 'architect:synthetic', plans: withPlans ? [plan] : [] });
      const ws = await startWorkspaceServer({ config, store, uiDirectory: UI, port: 0, goalActivation: port });
      hosts.push(ws);
      const bootstrap = await http(ws, 'GET', '/');
      return { ...ws, cookie: bootstrap.headers['set-cookie'][0].split(';')[0] };
    };
    await test({ dir, config, store, goal, observed, plan, status, core, start });
    console.log('  PASS ' + name); pass++;
  } catch (error) { console.error('  FAIL ' + name + ': ' + error.stack); fail++; }
  finally { for (const host of hosts) await host.close(); rmSync(dir, { recursive: true, force: true }); }
}

await check('no ROOT and no approved Host plan refuse activation without authority writes', async ({ goal, observed, start }) => {
  const ws = await start(false);
  const none = await http(ws, 'GET', route(goal.goalId));
  assert.deepEqual([none.status, none.json.readiness, none.json.canActivate], [200, 'NO_APPROVED_PLAN', false]);
  const denied = await http(ws, 'POST', route(goal.goalId), { headers: page(ws) });
  assert.deepEqual([denied.json.status, observed.calls], ['NOT_ACTIVATED', 0]);
  observed.admitted = false;
  const noRoot = await http(ws, 'GET', route(goal.goalId));
  assert.deepEqual([noRoot.json.readiness, noRoot.json.canActivate], ['NO_ROOT', false]);
});

await check('one exact Goal POST dispatches only the Host bundle and never the browser body', async ({ goal, observed, plan, start }) => {
  const ws = await start();
  const inspected = await http(ws, 'GET', route(goal.goalId));
  assert.deepEqual([inspected.json.readiness, inspected.json.canActivate, inspected.json.packetId], ['READY', true, 'approved-packet']);
  const result = await http(ws, 'POST', route(goal.goalId), { headers: page(ws) });
  assert.deepEqual([result.status, result.json.status, observed.calls], [200, 'ACTIVATED', 1]);
  assert.deepEqual(observed.lastTarget, { source: { kind: 'WORKSPACE_GOAL', projectId: 'chief', goalId: goal.goalId }, runId: 'run-1' });
  assert.equal(observed.bundle, plan.bundle);
  assert.doesNotMatch(JSON.stringify(result.json), /implementationPacket|liveCallAuthorizations|secret/);
  const again = await http(ws, 'POST', route(goal.goalId), { headers: page(ws) });
  assert.deepEqual([again.status, again.json.status, observed.calls], [200, 'ALREADY_ACTIVATED', 1]);
});

await check('query, forged Human session, hostile Origin, arbitrary body are denied before calling AP1', async ({ goal, observed, start }) => {
  const ws = await start();
  const path = route(goal.goalId);
  const denied = [
    await http(ws, 'POST', path + '?runId=run-forged', { headers: page(ws) }),
    await http(ws, 'POST', path, { headers: { ...page(ws), Origin: 'https://evil.example' } }),
    await http(ws, 'POST', path, { headers: { ...page(ws), Cookie: 'chief_workspace_session=forged' } }),
    await http(ws, 'POST', path, { headers: page(ws), body: '{"bundle":{"fake":"grant"}}' }),
  ];
  assert.deepEqual(denied.map((x) => x.status), [400, 403, 401, 400]);
  assert.equal(observed.calls, 0);
});

await check('unexpected principal, repository and authority refusal fail closed', async ({ goal, observed, start }) => {
  const ws = await start();
  observed.human = 'human:other';
  const mismatch = await http(ws, 'GET', route(goal.goalId));
  assert.deepEqual([mismatch.status, mismatch.json.error.code], [409, 'ACTIVATION_BINDING_CONFLICT']);
  observed.human = HUMAN.principalRef; observed.repository = 'other/repo';
  const badRepo = await http(ws, 'POST', route(goal.goalId), { headers: page(ws) });
  assert.deepEqual([badRepo.status, badRepo.json.error.code, observed.calls], [409, 'ACTIVATION_BINDING_CONFLICT', 0]);
  observed.repository = REPO; observed.fail = true;
  const refused = await http(ws, 'POST', route(goal.goalId), { headers: page(ws) });
  assert.deepEqual([refused.status, refused.json.error.code, observed.calls], [409, 'ACTIVATION_REFUSED', 1]);
});

await check('Host plan with a foreign Architect or Change subject never activates', async ({ goal, plan, observed, start }) => {
  const ws = await start();
  plan.bundle.implementationPacket.issuer.principalRef = 'architect:foreign';
  const foreign = await http(ws, 'GET', route(goal.goalId));
  assert.deepEqual([foreign.json.readiness, foreign.json.canActivate], ['PLAN_MISMATCH', false]);
  const result = await http(ws, 'POST', route(goal.goalId), { headers: page(ws) });
  assert.deepEqual([result.json.status, observed.calls], ['NOT_ACTIVATED', 0]);
  plan.bundle.implementationPacket.issuer.principalRef = 'architect:synthetic';
  plan.bundle.implementationPacket.subject.sliceId = 'slice-foreign';
  const wrongSlice = await http(ws, 'GET', route(goal.goalId));
  assert.deepEqual([wrongSlice.json.readiness, wrongSlice.json.canActivate], ['PLAN_MISMATCH', false]);
});

await check('Host without the injected activation capability returns 503', async ({ config, goal }) => {
  const host = await startWorkspaceServer({ config, uiDirectory: UI, port: 0 });
  try {
    const bootstrap = await http(host, 'GET', '/');
    const ws = { ...host, cookie: bootstrap.headers['set-cookie'][0].split(';')[0] };
    const result = await http(ws, 'POST', route(goal.goalId), { headers: page(ws) });
    assert.deepEqual([result.status, result.json.error.code], [503, 'ACTIVATION_UNAVAILABLE']);
  } finally { await host.close(); }
});

await check('invalid or duplicate Host-issued plans fail before a live capability is composed', async ({ dir, config, goal }) => {
  const base = { schemaVersion: 1, workspace: { schemaVersion: 1, dataDirectory: config.dataDirectory,
    humanPrincipal: { principalRef: HUMAN.principalRef }, projects: config.projects },
    governance: { changeRegistryDirectory: join(dir, 'registry'), controllerStoreDirectory: join(dir, 'controller'),
      repositories: [{ projectId: 'chief', repository: REPO }],
      executionStatus: { authorityArchiveDirectory: join(dir, 'archive'), architectPrincipalRef: 'architect:synthetic' },
      executionStep: { governedLive: {}, activationPlans: [] } } };
  const packet = { packetId: 'packet-1', packetVersion: 1, sliceId: 'goal-' + 'a'.repeat(64),
    expectedBaseSha: 'a'.repeat(40), targetBranch: 'work/synthetic-1', objective: 'fixture',
    allowedAreas: ['src/automation'], forbiddenChanges: ['src/stress-test'],
    invariants: ['Human authority'], acceptanceCriteria: ['offline tests'],
    validationCommands: [{ commandId: 'test', executable: 'npm', args: ['test'], cwd: '.', classification: 'OFFLINE_VALIDATION' }],
    networkAuthorization: { level: 'OFFLINE', destinations: [], purpose: 'fixture', budget: 0 },
    providerCallAuthorization: { allowed: false, calls: [], maxCalls: 0, budget: 0 },
    destructiveOperationAuthorization: { allowed: false },
    iterationBudget: { maxImplementationIterationsPerSlice: 3, maxAcceptanceFailuresPerSlice: 3,
      maxRuntimeMinutesPerIteration: 60, maxParallelImplementationAgents: 1 } };
  const document = { schemaVersion: 1, recordClass: 'DIRECT_AUTHORITY',
    kind: 'IMPLEMENTATION_PACKET', authorityId: 'packet-1', version: 1, issuedAt: '2026-10-14T00:00:00.000Z',
    issuer: { role: 'GPT_ARCHITECT', principalRef: 'architect:synthetic' },
    subject: { repository: REPO, sliceId: packet.sliceId }, supersedes: null, body: packet };
  const valid = structuredClone(base);
  valid.governance.executionStep.activationPlans = [{
    projectId: 'chief', goalId: goal.goalId,
    bundle: { implementationPacket: document, liveCallAuthorizations: [] },
  }];
  const accepted = parseTrustedWorkspaceHostConfig(valid, dir);
  assert.equal(validateActivationPlans(accepted.executionStep.activationPlans)[0].bundle.implementationPacket.authorityId, 'packet-1');
  const invalid = structuredClone(valid);
  invalid.governance.executionStep.activationPlans = [{
    projectId: 'chief', goalId: goal.goalId,
    bundle: { implementationPacket: { role: 'HUMAN', forged: true }, liveCallAuthorizations: [] },
  }];
  assert.throws(() => validateActivationPlans(parseTrustedWorkspaceHostConfig(invalid, dir).executionStep.activationPlans));
  const duplicate = structuredClone(valid);
  duplicate.governance.executionStep.activationPlans.push(structuredClone(duplicate.governance.executionStep.activationPlans[0]));
  assert.throws(() => parseTrustedWorkspaceHostConfig(duplicate, dir));
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exitCode = 1;
