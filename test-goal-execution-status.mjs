import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync,
  writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAuthorityArchiveAppender } from './dist/automation/authority/file-archive.js';
import { AutomationController } from './dist/automation/controller.js';
import { FileControllerStore } from './dist/automation/durable-store.js';
import { GovernanceStoreIsolationError } from './dist/automation/governance-store-isolation.js';
import { packetHash } from './dist/automation/packet.js';
import { parseTrustedWorkspaceHostConfig } from './dist/intake/workspace-host-config.js';
import { startTrustedWorkspaceHost } from './dist/intake/workspace-host.js';
import { FileGoalStore } from './dist/workspace/goal-store.js';
import { API_ROUTES } from './dist/workspace/server.js';

// G1-WE1-R0 governed Workspace execution observability: a read-only status per Goal. Every store is real and
// local to a temporary directory; the trusted host is started for real; a test-held Controller and archive
// appender play the other actors (Architect, implementer, reviewer, Human). Every GET is checked to leave every
// governance root and the Goal Store byte-identical. Letters refer to the WE1-R0 packet.

const ROOT = process.cwd();
const UI = join(ROOT, 'workspace-ui');
const HUMAN = { schemaVersion: 1, kind: 'HUMAN', principalRef: 'human:test-owner' };
const OTHER_HUMAN = { ...HUMAN, principalRef: 'human:other' };
const ARCHITECT = 'architect:gpt-synthetic';
const A = { id: ARCHITECT, role: 'GPT_ARCHITECT' }, OTHER = { id: 'architect:other', role: 'GPT_ARCHITECT' };
const X = { id: 'implementer', role: 'CODEX_IMPLEMENTER' }, H = { id: 'human', role: 'HUMAN' }, K = { id: 'controller', role: 'CONTROLLER' };
const GOAL = 'goal-00000000-0000-4000-8000-000000000001';
const UNKNOWN = 'goal-00000000-0000-4000-8000-000000000002';
const SHA_A = 'a'.repeat(40), SHA_B = 'b'.repeat(40);
const EARLIER = '2026-01-01T00:00:00.000Z';
const clock = { now: () => new Date().toISOString() };
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
let passed = 0, failed = 0;
async function check(name, action) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'chief-we1-')));
  const running = [];
  try { await action(dir, running); console.log(`  PASS ${name}`); passed++; }
  catch (error) { console.error(`  FAIL ${name}: ${error.stack}`); failed++; }
  finally { for (const host of running) await host.close(); rmSync(dir, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------- fixtures
const provision = (path) => { mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700); return path; };
function fixture(dir, { status = true, principal = ARCHITECT } = {}) {
  const registry = provision(join(dir, 'registry')), controller = provision(join(dir, 'controller')), authority = provision(join(dir, 'authority'));
  const raw = { schemaVersion: 1, workspace: { schemaVersion: 1, dataDirectory: join(dir, 'goals'),
    humanPrincipal: { principalRef: HUMAN.principalRef },
    projects: [{ projectId: 'cand', displayName: 'Synthetic project', repository: 'display-only/path' }] },
  governance: { changeRegistryDirectory: registry, controllerStoreDirectory: controller,
    repositories: [{ projectId: 'cand', repository: 'synthetic/governed' }],
    ...(status ? { executionStatus: { authorityArchiveDirectory: authority, architectPrincipalRef: principal } } : {}) } };
  return { raw, registry, controller, authority, goals: join(dir, 'goals'), config: parseTrustedWorkspaceHostConfig(raw, dir) };
}
function add(f, human = HUMAN, id = GOAL) {
  return new FileGoalStore(f.config.workspace.dataDirectory, { newGoalId: () => id }).addGoal('cand', 'Exact governed objective.', human).queue.goals.at(-1);
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
const page = (host) => ({ Origin: `http://127.0.0.1:${host.port}`, 'X-Chief-Workspace': '1', 'Sec-Fetch-Site': 'same-origin' });
async function host(f, running) {
  const ws = await startTrustedWorkspaceHost({ config: f.config, uiDirectory: UI, port: 0 });
  running.push(ws);
  const bootstrap = await call(ws, 'GET', '/');
  return { ...ws, cookie: bootstrap.headers['set-cookie'][0].split(';')[0] };
}
const govern = (ws) => call(ws, 'POST', route(GOAL, '/govern'), { headers: page(ws) });
const admit = (ws) => call(ws, 'POST', route(GOAL, '/run'), { headers: page(ws) });

/** Every entry under the governance roots and the Goal Store: type, mode, inode, size, mtime and bytes. */
function tree(root) {
  if (!existsSync(root)) return null;
  const walk = (path, rel) => readdirSync(path).sort().flatMap((name) => {
    const child = join(path, name), key = rel ? `${rel}/${name}` : name, status = lstatSync(child, { bigint: true });
    const meta = [key, status.mode, status.ino, status.size, status.mtimeNs];
    if (status.isDirectory()) return [[...meta, 'dir'], ...walk(child, key)];
    return [[...meta, 'file', readFileSync(child).toString('base64')]];
  });
  return walk(root, '');
}
const roots = (f) => [f.registry, f.controller, f.authority, f.goals].map(tree);
/** GET /execution, proving the read wrote nothing anywhere: every governance root and the Goal Store byte-identical. */
async function execution(ws, f, id = GOAL, options = {}) {
  const before = roots(f);
  const res = await call(ws, 'GET', route(id, '/execution'), options);
  assert.deepEqual(roots(f), before, 'a status read changed a governance root or the Goal Store');
  return res;
}
const status = async (ws, f) => {
  const res = await execution(ws, f);
  assert.equal(res.status, 200, res.text);
  return res.json;
};
const registryRecord = (f) => JSON.parse(readFileSync(join(f.registry, 'records', readdirSync(join(f.registry, 'records'))[0]), 'utf8')).record;

/** A governed, admitted world (RA1 IDLE ROOT) with a test-held Controller and archive appender for the other actors. */
async function admitted(dir, running, options) {
  const f = fixture(dir, options);
  add(f);
  const ws = await host(f, running);
  assert.equal((await govern(ws)).status, 200);
  assert.equal((await admit(ws)).status, 200);
  const record = registryRecord(f);
  const runId = `run-${record.changeKey}`;
  const reality = { workSha: SHA_B, mainSha: SHA_A,
    observeBranch(repository, branch) { return { repository, branch, sha: branch === 'main' ? this.mainSha : this.workSha, observedAt: clock.now() }; },
    compare() { throw new Error('not used'); }, observeCi() { throw new Error('not used'); }, observeProtection() { throw new Error('not used'); } };
  const controller = new AutomationController(clock, new FileControllerStore(f.controller, clock), reality);
  let appender;
  const archive = (kind, body, { principalRef = ARCHITECT } = {}) => {
    const id = { IMPLEMENTATION_PACKET: body.packetId, CORRECTION_PACKET: body.correctionPacketId, ACCEPTANCE_DECISION: body.reviewId,
      AUTHORIZATION: body.authorizationId }[kind];
    const role = kind === 'AUTHORIZATION' ? 'HUMAN' : 'GPT_ARCHITECT';
    return (appender ??= openAuthorityArchiveAppender(f.authority)).append({ schemaVersion: 1, recordClass: 'DIRECT_AUTHORITY', kind,
      authorityId: id, version: 1, issuedAt: body.issuedAt ?? EARLIER, issuer: { role, principalRef: role === 'HUMAN' ? HUMAN.principalRef : principalRef },
      subject: { repository: record.repository, sliceId: record.sliceId }, supersedes: null, body });
  };
  const packet = (overrides = {}) => ({ packetId: 'packet-1', packetVersion: 1, sliceId: record.sliceId, expectedBaseSha: SHA_A,
    targetBranch: 'work/synthetic-1', objective: 'WE1-R0 fixture packet', allowedAreas: ['src/automation'], forbiddenChanges: ['src/stress-test'],
    invariants: ['human authority retained'], acceptanceCriteria: ['offline checks pass'],
    validationCommands: [{ commandId: 'test', executable: 'npm', args: ['test'], cwd: '.', classification: 'OFFLINE_VALIDATION' }],
    networkAuthorization: { level: 'OFFLINE', destinations: [], purpose: 'fixture', budget: 0 },
    providerCallAuthorization: { allowed: false, calls: [], maxCalls: 0, budget: 0 }, destructiveOperationAuthorization: { allowed: false },
    iterationBudget: { maxImplementationIterationsPerSlice: 3, maxAcceptanceFailuresPerSlice: 3, maxRuntimeMinutesPerIteration: 60,
      maxParallelImplementationAgents: 1 }, ...overrides });
  /** The AP1 lineage at the Controller: the bound entry and its guarded issue, both by `architect`. */
  const activate = (body = packet(), architect = A) => {
    const entered = controller.enterArchitectureForActivation(runId, architect, { packetId: body.packetId, packetHash: packetHash(body) }).audit[0];
    controller.issuePacketForOccurrence(runId, architect, { runId, sequence: entered.sequence, action: entered.action, timestamp: entered.timestamp }, body);
    return body;
  };
  const decision = (result, reviewId) => {
    const run = controller.get(runId);
    return { reviewId, actor: 'GPT_ARCHITECT', packetId: run.activePacket.packetId, packetHash: run.activePacketHash, reviewedSha: run.remoteSha.sha,
      decision: result, findings: result === 'REJECT' ? ['synthetic finding'] : [], evidenceReferences: ['diff'], issuedAt: EARLIER };
  };
  const correction = () => {
    const run = controller.get(runId);
    return { correctionPacketId: `correction-${run.implementationIterations + 1}`, originalPacketId: run.activePacket.packetId,
      originalPacketHash: run.activePacketHash, rejectedSha: run.remoteSha.sha, reviewerFindings: run.acceptance.findings,
      allowedCorrectionAreas: ['src/automation'], unchangedInvariantReferences: run.activePacket.invariants, expectedBaseSha: run.remoteSha.sha,
      correctionIteration: run.implementationIterations + 1, maxCorrectionIteration: 3 };
  };
  /** Through implementation and review to a REJECT by the configured Architect, archived. */
  const rejected = (reviewer = A) => {
    controller.beginImplementation(runId, X);
    controller.completeImplementation(runId, X, ['npm test: exit 0']);
    controller.recordRemoteSha(runId, X);
    controller.beginAcceptanceReview(runId, reviewer);
    const rejection = decision('REJECT', 'review-1');
    archive('ACCEPTANCE_DECISION', rejection);
    controller.decideAcceptance(runId, A, rejection);
  };
  return { f, ws, record, runId, controller, archive, packet, activate, rejected, correction };
}
const S = (json, expected, reason) => {
  assert.equal(json.status, expected, JSON.stringify(json));
  if (reason !== undefined) assert.equal(json.reason, reason, JSON.stringify(json));
  // Never a model READY: eligibility is never evaluated here, and no status names it.
  assert.equal(json.executionEligibility, 'EXECUTION_ELIGIBILITY_NOT_EVALUATED');
  assert.equal(json.authority, 'NOT_EXECUTION_AUTHORITY');
  assert.equal(json.recordClass, 'OPERATIONAL_RECORD');
  assert.doesNotMatch(JSON.stringify(json), /"READY"|"ELIGIBLE"|authorized to execute/);
  return json;
};

// ---------------------------------------------------------------- configuration and host
await check('A. disabled by default: no executionStatus, the route answers 503 and the Workspace keeps working', async (dir, running) => {
  const f = fixture(dir, { status: false });
  assert.equal(f.config.executionStatus, null);
  add(f);
  const ws = await host(f, running);
  const res = await execution(ws, f);
  assert.deepEqual([res.status, res.json.error.code], [503, 'EXECUTION_STATUS_UNAVAILABLE']);
  assert.equal((await call(ws, 'GET', '/api/v0/projects/cand/goals')).json.goals.length, 1);
  assert.equal((await govern(ws)).status, 200);
  assert.equal((await admit(ws)).status, 200);
  assert.equal(existsSync(join(f.authority, 'kinds')), false);
  // The browser asset is served either way, and the UI is useful without the feature.
  assert.equal((await call(ws, 'GET', '/execution-status.js')).status, 200);
});
await check('C. enabled mode requires an exact principal and pre-provisioned authority, controller and registry roots', async (dir) => {
  const base = fixture(dir);
  assert.deepEqual(base.config.executionStatus, { authorityArchiveDirectory: base.authority, architectPrincipalRef: ARCHITECT });
  const raw = (patch) => ({ ...base.raw, governance: { ...base.raw.governance, executionStatus: { ...base.raw.governance.executionStatus, ...patch } } });
  for (const bad of [{ authorityArchiveDirectory: 'relative/authority' }, { authorityArchiveDirectory: `${base.authority}/` }, { architectPrincipalRef: '' },
    { extra: true }]) assert.throws(() => parseTrustedWorkspaceHostConfig(raw(bad), dir), undefined, JSON.stringify(bad));
  assert.throws(() => parseTrustedWorkspaceHostConfig({ ...base.raw, governance: { ...base.raw.governance, executionStatus: { architectPrincipalRef: ARCHITECT } } }, dir));
  // Missing root, or an inexact principal: refused before listen, nothing created.
  for (const [patch, error] of [[{ authorityArchiveDirectory: join(dir, 'missing') }, GovernanceStoreIsolationError],
    [{ architectPrincipalRef: ' architect:spaced' }, TypeError]]) {
    const config = parseTrustedWorkspaceHostConfig(raw(patch), dir);
    await assert.rejects(startTrustedWorkspaceHost({ config, uiDirectory: UI, port: 0 }), error);
    assert.equal(existsSync(base.goals), false, 'a refused host created the Goal Store');
    assert.equal(existsSync(join(dir, 'missing')), false, 'a refused host provisioned the authority root');
  }
});
await check('D. unsafe or overlapping roots fail closed before listen and create nothing', async (dir) => {
  const base = fixture(dir);
  const raw = (patch, workspace = {}) => ({ ...base.raw, workspace: { ...base.raw.workspace, ...workspace },
    governance: { ...base.raw.governance, executionStatus: { ...base.raw.governance.executionStatus, ...patch } } });
  symlinkSync(base.authority, join(dir, 'authority-link'));
  const loose = provision(join(dir, 'loose')); chmodSync(loose, 0o777);
  const cases = [
    ['symlinked authority root', raw({ authorityArchiveDirectory: join(dir, 'authority-link') })],
    ['group/other-writable authority root', raw({ authorityArchiveDirectory: loose })],
    ['authority root inside the Controller store', raw({ authorityArchiveDirectory: provision(join(base.controller, 'authority')) })],
    ['authority root is the Change Registry', raw({ authorityArchiveDirectory: base.registry })],
    ['Goal Store inside the authority root', raw({}, { dataDirectory: join(base.authority, 'goals') })],
  ];
  for (const [label, config] of cases) {
    const before = [base.registry, base.controller, base.authority].map(tree);
    await assert.rejects(startTrustedWorkspaceHost({ config: parseTrustedWorkspaceHostConfig(config, dir), uiDirectory: UI, port: 0 }),
      GovernanceStoreIsolationError, label);
    assert.equal(existsSync(base.goals), false, `${label}: the Goal Store was created`);
    assert.equal(existsSync(join(base.authority, 'goals')), false, label);
    assert.deepEqual([base.registry, base.controller, base.authority].map(tree), before, `${label}: a protected root changed`);
  }
  // The UI directory itself is checked too.
  const ui = join(base.authority, 'ui');
  await assert.rejects(startTrustedWorkspaceHost({ config: base.config, uiDirectory: ui, port: 0 }), GovernanceStoreIsolationError);
});
// B / X: the runtime module and process probe.
const PROBE = (enabled) => `
  import { registerHooks, syncBuiltinESMExports } from 'node:module';
  import cp from 'node:child_process'; import net from 'node:net'; import https from 'node:https'; import tls from 'node:tls';
  const loaded = new Set(); const calls = [];
  registerHooks({ resolve(specifier, context, next) { const result = next(specifier, context); loaded.add(result.url); return result; } });
  const watch = (owner, name, label) => { const original = owner[name]; owner[name] = function (...args) {
    if (/dist\\//.test(new Error().stack)) calls.push(label); return original.apply(this, args); }; };
  for (const name of ['spawn', 'exec', 'execFile', 'fork', 'spawnSync', 'execSync', 'execFileSync']) watch(cp, name, 'child_process.' + name);
  watch(net, 'connect', 'net.connect'); watch(net, 'createConnection', 'net.createConnection'); watch(https, 'request', 'https.request');
  watch(tls, 'connect', 'tls.connect');
  syncBuiltinESMExports();
  const { parseTrustedWorkspaceHostConfig } = await import('./dist/intake/workspace-host-config.js');
  const { startTrustedWorkspaceHost } = await import('./dist/intake/workspace-host.js');
  const host = await startTrustedWorkspaceHost({ config: parseTrustedWorkspaceHostConfig(JSON.parse(process.argv[1]), process.cwd()),
    uiDirectory: process.argv[2], port: 0 });
  const page = await fetch(host.url); const cookie = page.headers.get('set-cookie').split(';')[0];
  const headers = { Cookie: cookie, Origin: host.url.slice(0, -1), 'X-Chief-Workspace': '1' };
  const base = host.url + 'api/v0/projects/cand/goals/${GOAL}';
  const statuses = [(await fetch(base + '/govern', { method: 'POST', headers })).status, (await fetch(base + '/run', { method: 'POST', headers })).status];
  const exec = await fetch(base + '/execution', { headers: { Cookie: cookie } });
  statuses.push(exec.status);
  const body = await exec.json();
  await host.close();
  console.log(JSON.stringify({ loaded: [...loaded], calls, statuses, body }));`;
function probe(f) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE(), JSON.stringify(f.raw), UI], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.trim().split('\n').at(-1));
  result.local = result.loaded.filter((url) => url.startsWith('file:')).map((url) => relative(ROOT, fileURLToPath(url)));
  return result;
}
// Never loaded by a status read: the runner, its actor bridge, LD1, activation, live adapters, the invocation and egress journal
// stores, model and validation processes, the authority preserver and review sink, and every provider or execution module.
// (dist/automation/invocation-journal.js itself is R4P's canonical JSON helper, which any R4A0 read loads; it opens no journal.)
const NEVER = /^dist\/(automation\/(runner|bridge|execution-driver|activation-core|live\/|authority\/(preserver|architect-review-authority)|process-executor|offline-validation|egress-journal|file-egress-journal|file-invocation-journal)|providers\/|execution\/|modes\/|agents\/|consultation\/|context\/|stress-test\/)/;
await check('B. disabled mode loads no status bridge, read model, runner, model process or provider, and spawns nothing', async (dir) => {
  const f = fixture(dir, { status: false }); add(f);
  const result = probe(f);
  assert.deepEqual(result.statuses, [200, 200, 503]);
  const forbidden = result.local.filter((file) => NEVER.test(file) || /^dist\/(intake\/goal-execution-status-bridge|automation\/(execution-readiness|read-model\/|authority\/))/.test(file));
  assert.deepEqual(forbidden, [], `the disabled host loaded ${forbidden.join(', ')}`);
  assert.ok(!result.loaded.some((url) => /@anthropic-ai|\/openai\/|@google\/generative-ai|@modelcontextprotocol/.test(url)), 'a provider package loaded');
  assert.deepEqual(result.calls, []);
});
await check('X. enabled mode answers from the read model alone: no runner, model, provider or outbound call, no spawn', async (dir) => {
  const f = fixture(dir); add(f);
  const result = probe(f);
  assert.deepEqual(result.statuses, [200, 200, 200]);
  assert.equal(result.body.status, 'RUN_IDLE');
  assert.ok(result.local.includes('dist/intake/goal-execution-status-bridge.js') && result.local.includes('dist/automation/read-model/governed-read-model.js'));
  const forbidden = result.local.filter((file) => NEVER.test(file));
  assert.deepEqual(forbidden, [], `the status host loaded ${forbidden.join(', ')}`);
  assert.ok(!result.loaded.some((url) => /@anthropic-ai|\/openai\/|@google\/generative-ai|@modelcontextprotocol/.test(url)), 'a provider package loaded');
  assert.deepEqual(result.calls, [], 'the host spawned a process or opened an outbound connection');
  assert.equal(existsSync(join(dir, 'journal')), false);
});

// ---------------------------------------------------------------- request binding
await check('F/G/H. unknown Goal or project, an unattributed Goal and another Human\'s Goal are refused, with nothing read into the answer', async (dir, running) => {
  const f = fixture(dir);
  add(f);
  add(f, OTHER_HUMAN, UNKNOWN.replace(/2$/, '3'));
  const ws = await host(f, running);
  const unknown = await execution(ws, f, UNKNOWN);
  assert.deepEqual([unknown.status, unknown.json.error.code], [404, 'UNKNOWN_GOAL']);
  const project = await call(ws, 'GET', '/api/v0/projects/nope/goals/' + GOAL + '/execution');
  assert.deepEqual([project.status, project.json.error.code], [404, 'UNKNOWN_PROJECT']);
  const malformed = await execution(ws, f, 'run-' + 'f'.repeat(64));
  assert.deepEqual([malformed.status, malformed.json.error.code], [404, 'UNKNOWN_GOAL'], 'a runId is not a goal');
  const foreign = await execution(ws, f, UNKNOWN.replace(/2$/, '3'));
  assert.deepEqual([foreign.status, foreign.json.error.code], [403, 'GOAL_PRINCIPAL_MISMATCH']);
  // A legacy unattributed Goal.
  const file = join(f.goals, 'cand.queue.json');
  const envelope = JSON.parse(readFileSync(file, 'utf8'));
  delete envelope.queue.goals[0].submittedBy; delete envelope.queue.history[0].goal.submittedBy;
  envelope.checksum = sha(JSON.stringify(envelope.queue));
  writeFileSync(file, JSON.stringify(envelope));
  const unattributed = await execution(ws, f);
  assert.deepEqual([unattributed.status, unattributed.json.error.code], [409, 'UNATTRIBUTED_GOAL']);
  // No session: refused before anything is read.
  const anonymous = await call({ port: ws.port }, 'GET', route(GOAL, '/execution'));
  assert.deepEqual([anonymous.status, anonymous.json.error.code], [401, 'NO_LOCAL_SESSION']);
});
await check('T/U. no query, body, header or path segment can name a run, actor or identity; the route is exactly one GET', async (dir, running) => {
  const { f, ws } = await admitted(dir, running);
  const expected = await status(ws, f);
  for (const query of ['?runId=run-x', '?actor=architect:other', '?architectPrincipalRef=x', '?changeKey=y', '?demo=1', '?']) {
    const res = await call(ws, 'GET', route(GOAL, `/execution${query}`));
    if (query === '?') { assert.equal(res.status, 200); continue; }
    assert.deepEqual([res.status, res.json.error.code], [400, 'UNKNOWN_FIELD'], query);
  }
  // Framed bodies (Content-Length or chunked): an unframed GET body is refused by the HTTP parser itself.
  for (const options of [{ headers: { 'Content-Type': 'application/json', 'Content-Length': '17' }, body: '{"runId":"run-x"}' },
    { headers: { 'Content-Length': '2' }, body: '{}' }, { headers: { 'Transfer-Encoding': 'chunked' }, body: 'x' }]) {
    const res = await execution(ws, f, GOAL, options);
    assert.deepEqual([res.status, res.json.error.code], [400, 'UNEXPECTED_BODY']);
  }
  const headed = await execution(ws, f, GOAL, { headers: { 'X-Run-Id': 'run-other', 'X-Actor': 'architect:other' } });
  assert.deepEqual(headed.json, expected, 'a header changed the answer');
  for (const path of [route(GOAL, '/execution/run-x'), route(GOAL, '/execution/step'), '/api/v0/projects/cand/execution', '/api/v0/execution']) {
    assert.equal((await call(ws, 'GET', path)).status, 404, path);
  }
  // Host and cross-site isolation are unchanged.
  assert.equal((await call(ws, 'GET', route(GOAL, '/execution'), { headers: { Host: 'evil.example' } })).status, 421);
  assert.equal((await call(ws, 'GET', route(GOAL, '/execution'), { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
});
await check('W/V. no POST, DELETE or other execution route exists; GETs never step, activate or recover a run', async (dir, running) => {
  const { f, ws, runId, controller, activate, archive } = await admitted(dir, running);
  archive('IMPLEMENTATION_PACKET', activate());
  for (const method of ['POST', 'DELETE', 'PUT', 'PATCH']) {
    const res = await call(ws, method, route(GOAL, '/execution'), { headers: page(ws) });
    assert.ok([404, 405].includes(res.status), `${method} /execution answered ${res.status}`);
  }
  for (const verb of ['step', 'execute', 'activate', 'resume', 'recover', 'correct', 'authorize', 'promote', 'drive', 'start']) {
    assert.equal((await call(ws, 'POST', route(GOAL, `/${verb}`), { headers: page(ws) })).status, 404, verb);
  }
  assert.deepEqual(API_ROUTES.filter((item) => /execution/.test(item)), ['GET /api/v0/projects/:projectId/goals/:goalId/execution']);
  assert.ok(!API_ROUTES.some((item) => /\/(step|execute|activate|resume|recover|correct|authoriz|promote|drive|start)\b/.test(item)));
  const audit = controller.audit(runId).length;
  for (let i = 0; i < 5; i++) S(await status(ws, f), 'WAITING_TO_START');
  assert.equal(controller.audit(runId).length, audit, 'a GET moved the run');
  assert.equal(controller.get(runId).state, 'PACKET_READY');
});

// ---------------------------------------------------------------- lifecycle projection
await check('I/J/K/L. not governed, not admitted, an interrupted admission and an IDLE ROOT are each shown truthfully and left as they are', async (dir, running) => {
  const f = fixture(dir);
  add(f);
  const ws = await host(f, running);
  const notGoverned = S(await status(ws, f), 'GOAL_NOT_GOVERNED');
  assert.deepEqual([notGoverned.attention, notGoverned.change, notGoverned.run], ['HUMAN', null, null]);
  const records = () => existsSync(join(f.registry, 'records')) ? readdirSync(join(f.registry, 'records')) : [];
  assert.deepEqual(records(), [], 'a status read minted');
  assert.equal((await govern(ws)).status, 200);
  const record = registryRecord(f);
  const change = { kind: 'SLICE', changeId: record.sliceId, changeKey: record.changeKey, repository: 'synthetic/governed' };
  const notAdmitted = S(await status(ws, f), 'RUN_NOT_ADMITTED');
  assert.deepEqual([notAdmitted.change, notAdmitted.run], [change, null]);
  const changes = join(f.controller, 'changes');
  assert.deepEqual([readdirSync(f.controller).filter((name) => name.endsWith('.json')), existsSync(changes) ? readdirSync(changes) : []], [[], []],
    'a status read admitted a run');
  assert.equal((await admit(ws)).status, 200);
  const runId = `run-${record.changeKey}`;
  const idle = S(await status(ws, f), 'RUN_IDLE', null);
  assert.deepEqual([idle.change, idle.run, idle.attention, idle.nextMoves], [change, { runId, state: 'IDLE', terminal: false, admission: 'ROOT' },
    'ARCHITECT', [{ action: 'ENTER_ARCHITECTURE', role: 'GPT_ARCHITECT' }]]);
  assert.deepEqual(idle.operationalProvenance, { recordClass: 'OPERATIONAL_RECORD', activationBound: false });
  // An interrupted admission: the R4L claim without its run. Shown, never completed by the read.
  unlinkSync(join(f.controller, `${sha(runId)}.json`));
  const pending = S(await status(ws, f), 'ROOT_PENDING');
  assert.deepEqual([pending.change, pending.run, pending.attention], [change, null, 'HUMAN']);
  assert.equal(existsSync(join(f.controller, `${sha(runId)}.json`)), false, 'a status read recovered the admission');
});
await check('M/N/S. no packet is never model READY; unarchived authority is BLOCKED_AUTHORITY; archived authority and operational provenance stay distinct', async (dir, running) => {
  const { f, ws, runId, controller, archive, packet } = await admitted(dir, running);
  const body = packet();
  controller.enterArchitectureForActivation(runId, A, { packetId: body.packetId, packetHash: packetHash(body) });
  const waiting = S(await status(ws, f), 'WAITING_PACKET', null);
  assert.deepEqual([waiting.attention, waiting.nextMoves, waiting.directAuthority], ['ARCHITECT', [{ action: 'ISSUE_PACKET', role: 'GPT_ARCHITECT' }], []]);
  const entered = controller.audit(runId)[0];
  controller.issuePacketForOccurrence(runId, A, { runId, sequence: entered.sequence, action: entered.action, timestamp: entered.timestamp }, body);
  const blocked = S(await status(ws, f), 'BLOCKED_AUTHORITY', 'AUTHORITY_UNRESOLVED');
  assert.deepEqual([blocked.attention, blocked.unresolvedAuthority, blocked.directAuthority],
    ['ARCHITECT', [{ kind: 'IMPLEMENTATION_PACKET', authorityId: 'packet-1', resolution: 'NOT_ARCHIVED' }], []]);
  archive('IMPLEMENTATION_PACKET', body);
  const progress = S(await status(ws, f), 'WAITING_TO_START');
  assert.deepEqual([progress.reason, progress.attention, progress.run.state, progress.nextMoves],
    [null, 'AUTOMATED_ACTOR', 'PACKET_READY', [{ action: 'BEGIN_IMPLEMENTATION', role: 'CODEX_IMPLEMENTER' }]]);
  assert.deepEqual(progress.directAuthority, [{ recordClass: 'DIRECT_AUTHORITY', kind: 'IMPLEMENTATION_PACKET', authorityId: 'packet-1', version: 1 }]);
  assert.deepEqual(progress.operationalProvenance, { recordClass: 'OPERATIONAL_RECORD', activationBound: true });
  const text = JSON.stringify(progress);
  await controller.beginImplementation(runId, X);
  const begun = S(await status(ws, f), 'IN_PROGRESS');
  assert.equal(begun.run.state, 'IMPLEMENTING');
  assert.equal(begun.executionEligibility, 'EXECUTION_ELIGIBILITY_NOT_EVALUATED');
  for (const secret of ['activationBinding', 'packetHash', 'recordHash', 'bodyHash', body.objective, f.authority, f.controller, f.registry, ARCHITECT,
    'checksum', 'validationEvidence']) assert.equal(text.includes(secret), false, `the status exposed ${secret}`);
});
await check('O/P/Q/R. foreign activation, a re-issued packet, a foreign review and a foreign correction are BLOCKED_PROVENANCE with bounded reasons', async (dir, running) => {
  const cases = [
    ['generic', 'ACTIVATION_LINEAGE_MISSING', (w) => { w.controller.enterArchitecture(w.runId, A); w.controller.issuePacket(w.runId, A, w.packet());
      w.archive('IMPLEMENTATION_PACKET', w.packet()); }],
    ['foreign-activation', 'ACTIVATION_LINEAGE_FOREIGN', (w) => w.archive('IMPLEMENTATION_PACKET', w.activate(w.packet(), OTHER))],
    ['reissued', 'PACKET_REISSUED', (w) => {
      w.archive('IMPLEMENTATION_PACKET', w.activate());
      w.controller.stop(w.runId, A, 'ARCHITECTURE_STOP', 'scope question');
      w.controller.resumeArchitecture(w.runId, A);
      const second = w.packet({ packetId: 'packet-2', packetVersion: 2 });
      w.controller.issuePacket(w.runId, A, second);
      w.archive('IMPLEMENTATION_PACKET', second);
    }],
    ['foreign-review', 'REVIEW_LINEAGE_FOREIGN', (w) => {
      w.archive('IMPLEMENTATION_PACKET', w.activate());
      w.controller.beginImplementation(w.runId, X);
      w.controller.completeImplementation(w.runId, X, ['npm test: exit 0']);
      w.controller.recordRemoteSha(w.runId, X);
      w.controller.beginAcceptanceReview(w.runId, OTHER);
    }],
    ['foreign-correction', 'CORRECTION_LINEAGE_FOREIGN', (w) => {
      w.archive('IMPLEMENTATION_PACKET', w.activate());
      w.rejected();
      const fix = w.correction();
      w.archive('CORRECTION_PACKET', fix);
      w.controller.issueCorrection(w.runId, OTHER, fix);
    }],
  ];
  for (const [label, reason, reach] of cases) {
    const w = await admitted(join(dir, label), running);
    reach(w);
    const blocked = S(await status(w.ws, w.f), 'BLOCKED_PROVENANCE', reason);
    assert.equal(blocked.attention, 'ARCHITECT', label);
    assert.equal(blocked.unresolvedAuthority.length, 0, `${label}: authority itself resolves; provenance is the blocker`);
    assert.equal(blocked.operationalProvenance.recordClass, 'OPERATIONAL_RECORD');
  }
});
await check('waiting, terminal and conflicting runs are shown as they are, never repaired or explained away', async (dir, running) => {
  const w = await admitted(join(dir, 'waiting'), running);
  w.archive('IMPLEMENTATION_PACKET', w.activate());
  w.rejected();
  const correction = S(await status(w.ws, w.f), 'WAITING_EXTERNAL_ACTOR', null);
  assert.deepEqual([correction.attention, correction.nextMoves], ['ARCHITECT', [{ action: 'ISSUE_CORRECTION_PACKET', role: 'GPT_ARCHITECT' }]]);
  w.controller.stop(w.runId, H, 'HUMAN_STOP', 'human pause');
  const human = S(await status(w.ws, w.f), 'WAITING_HUMAN', null);
  assert.deepEqual([human.attention, human.nextMoves], ['HUMAN', [{ action: 'RESUME_HUMAN_STOP', role: 'HUMAN' }]]);
  w.controller.failClosed(w.runId, K, 'integrity failure');
  const terminal = S(await status(w.ws, w.f), 'TERMINAL', null);
  assert.deepEqual([terminal.attention, terminal.run.state, terminal.run.terminal], ['NONE', 'FAILED_CLOSED', true]);
  // The durable Goal no longer matches its governed Change: a conflict, and nothing about a run is projected.
  const c = await admitted(join(dir, 'binding'), running);
  const file = join(c.f.goals, 'cand.queue.json');
  const envelope = JSON.parse(readFileSync(file, 'utf8'));
  envelope.queue.goals[0].text = 'Edited after governance.'; envelope.queue.history[0].goal.text = 'Edited after governance.';
  envelope.checksum = sha(JSON.stringify(envelope.queue));
  writeFileSync(file, JSON.stringify(envelope));
  const binding = S(await status(c.ws, c.f), 'GOVERNANCE_CONFLICT', 'CHANGE_SOURCE_BINDING_CONFLICT');
  assert.deepEqual([binding.attention, binding.run, binding.change], ['HUMAN', null, null]);
  // A corrupt run file fails the governed read closed; it is reported, not read around.
  const r = await admitted(join(dir, 'corrupt'), running);
  const runFile = join(r.f.controller, `${sha(r.runId)}.json`);
  writeFileSync(runFile, readFileSync(runFile, 'utf8').replace('"IDLE"', '"CLOSED"'));
  const corrupt = S(await status(r.ws, r.f), 'GOVERNANCE_CONFLICT');
  assert.match(corrupt.reason, /^READ_MODEL_/);
  assert.equal(corrupt.run, null);
});
await check('a GET answers from the Change\'s one ROOT runId only; another run of the same Change is a conflict, never adopted', async (dir, running) => {
  const w = await admitted(dir, running);
  // Plant a second, unadmitted run of the same Change beside the ROOT (bypassing R4L): never inferred, never adopted.
  const root = JSON.parse(readFileSync(join(w.f.controller, `${sha(w.runId)}.json`), 'utf8'));
  const other = { ...root.run, runId: 'run-sibling' };
  const payload = JSON.stringify(other);
  writeFileSync(join(w.f.controller, `${sha('run-sibling')}.json`), JSON.stringify({ schemaVersion: 1, run: other, checksum: sha(payload) }));
  const res = S(await status(w.ws, w.f), 'GOVERNANCE_CONFLICT');
  assert.equal(res.run, null);
  // Without the ROOT, the sibling is still not this Goal's run.
  unlinkSync(join(w.f.controller, `${sha(w.runId)}.json`));
  assert.equal((await status(w.ws, w.f)).status, 'GOVERNANCE_CONFLICT');
});

// ---------------------------------------------------------------- topology (static)
function sources(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? sources(child) : entry.name.endsWith('.ts') ? [child] : [];
  });
}
const SRC = sources(join(ROOT, 'src'));
const text = (path) => readFileSync(path, 'utf8');
const rel = (path) => relative(ROOT, path);
const BRIDGE = 'src/intake/goal-execution-status-bridge.ts', PORT = 'src/workspace/goal-execution-status-port.ts';
await check('Z/topology. the bridge is read-only and lives outside Workspace; Workspace gets only the inspect port; demo never reaches governance', async () => {
  const bridge = text(join(ROOT, BRIDGE));
  const imports = [...bridge.matchAll(/^import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'([^']+)';/gm)].map((m) => [m[2], m[1].replace(/\s+/g, ' ').trim()]);
  assert.deepEqual(Object.fromEntries(imports.filter(([from]) => from.includes('automation/'))), {
    '../automation/authority/document.js': 'isAuthorityPrincipalRef',
    '../automation/change-mint.js': 'ChangeMintError, type ChangeMintRecordV1',
    '../automation/change-registry.js': 'openChangeRegistryReader',
    '../automation/execution-readiness.js': 'assessGovernedRun, type GovernedRunAssessmentV1',
    '../automation/governance-store-isolation.js': 'GovernanceStoreIsolation, GovernanceStoreIsolationError',
    '../automation/read-model/governed-read-model.js': 'GovernedReadError, readGovernedModel, type GovernedReadModelV1',
    '../automation/root-run-admitter.js': 'rootRunIdOf',
    '../automation/time.js': 'SYSTEM_CLOCK',
    '../automation/types.js': 'Clock',
  });
  assert.doesNotMatch(bridge.replace(/\/\/.*$/gm, ''), /openChangeMinter|openRootRunAdmitter|AutomationController|AutomationRunner|FileControllerStore|createRun|openAuthorityArchive|DirectAuthorityPreserver|\.preserve\(|\.append\(|execution-driver|live\/|runner\.js|\.step\(|\.activate\(|withLockedGoal|addGoal|removeGoal|\.reorder\(|\.mint\(|\.admit\(/);
  assert.deepEqual(SRC.filter((path) => /createGoalExecutionStatusBridge|trustedObservationPreflight/.test(text(path)) && rel(path) !== BRIDGE).map(rel),
    ['src/intake/workspace-host.ts']);
  // The port: one method, inspect; it imports only the identity module.
  const port = text(join(ROOT, PORT)).replace(/\/\/.*$/gm, '');
  assert.match(port, /export interface GoalExecutionStatusPort \{\s*inspect\(projectId: string, goalId: string, sessionHuman: HumanPrincipalV1\): GoalExecutionStatusView;\s*\}/);
  assert.deepEqual([...port.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]), ['../identity/canonical.js']);
  for (const file of SRC.filter((path) => path.includes(`${join('src', 'workspace')}/`))) {
    assert.doesNotMatch(text(file), /goal-execution-status-bridge|execution-readiness|readGovernedModel|assessGovernedRun|openChangeRegistryReader|from ['"][^'"]*automation\//, rel(file));
  }
  const server = text(join(ROOT, 'src/workspace/server.ts'));
  assert.deepEqual([...server.matchAll(/executionStatus\.(\w+)\(/g)].map((m) => m[1]), ['inspect']);
  // Demo answers locally and has no network path at all.
  const demo = readFileSync(join(UI, 'demo.js'), 'utf8');
  assert.doesNotMatch(demo, /fetch|EventSource|XMLHttpRequest|\/api\//);
  assert.match(demo, /async executionStatus\(projectId\) \{\s*get\(projectId\);\s*return \{ provenance: 'DEMO_SAMPLE', demo: true \};/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
