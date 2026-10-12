import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync,
  writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAuthorityArchiveAppender } from './dist/automation/authority/file-archive.js';
import { openChangeMinter } from './dist/automation/change-registry.js';
import { AutomationController } from './dist/automation/controller.js';
import { FileControllerStore } from './dist/automation/durable-store.js';
import * as driverModule from './dist/automation/execution-driver.js';
import { FileInvocationJournal } from './dist/automation/file-invocation-journal.js';
import { GovernanceStoreIsolationError } from './dist/automation/governance-store-isolation.js';
import * as liveModule from './dist/automation/live/governed-execution.js';
import { openRootRunAdmitter } from './dist/automation/root-run-admitter.js';
import { AutomationRunner } from './dist/automation/runner.js';

const { openGovernedExecutionDriver } = driverModule;
const { createGovernedLiveExecutionDriver } = liveModule;

// G1-LD1 governed live execution driver. Every store is real and local to a temporary
// directory: the CM1 registry (minted by a test-held minter), the Controller store (the RA1
// root-run admitter creates the ROOT run; a test-held controller plays the other actors) and
// the R4P archive (a test-held appender). The runner is either a counting fake or the real
// AutomationRunner with a real invocation journal and offline model ports that count their
// calls. Nothing reaches a provider, a model CLI, GitHub or a repository.

const ROOT = dirname(fileURLToPath(import.meta.url));
const A = 'a'.repeat(40), B = 'b'.repeat(40);
const T = '2026-10-12T00:00:00.000Z';
const EARLIER = '2026-10-11T00:00:00.000Z', EXPIRED = '2026-10-11T12:00:00.000Z';
const REPO = 'synthetic/example', BRANCH = 'work/synthetic-1';
const clock = { now: () => T };
const G = { id: 'architect', role: 'GPT_ARCHITECT' }, X = { id: 'implementer', role: 'CODEX_IMPLEMENTER' };
const H = { id: 'human', role: 'HUMAN' }, K = { id: 'controller', role: 'CONTROLLER' };
const HUMAN = { schemaVersion: 1, kind: 'HUMAN', principalRef: 'human:local-owner' };
const goalId = (n) => `goal-00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sourceOf = (n = 1) => ({ kind: 'WORKSPACE_GOAL', projectId: 'chief', goalId: goalId(n) });
const IMPL_EGRESS = ['api.anthropic.com:443', 'platform.claude.com:443'];
const REVIEW_EGRESS = ['auth.openai.com:443', 'chatgpt.com:443'];
const IMPL = { actorKind: 'IMPLEMENTATION', provider: 'anthropic', model: 'claude-opus-5-5', egressDestinations: [...IMPL_EGRESS] };
const REVIEW = { actorKind: 'ARCHITECT_REVIEW', provider: 'openai', model: 'gpt-5.5-codex', egressDestinations: [...REVIEW_EGRESS] };
const SCOPES = { IMPLEMENTATION: IMPL, ARCHITECT_REVIEW: REVIEW };
const TARGET = 'live-provider-model-call';
const SECRET_REASON = 'exact human grant for this fixture';
const tests = [];
const check = (name, fn) => tests.push([name, fn]);

// ---------------------------------------------------------------- fixtures
function fakeReality() {
  return { workSha: B, mainSha: A,
    observeBranch(repository, branch) { return { repository, branch, sha: branch === 'main' ? this.mainSha : this.workSha, observedAt: T }; },
    compare(repository, baseSha, headSha) { return { repository, baseSha, headSha, aheadBy: 1, behindBy: 0, hasBaseOnlyCommits: false, observedAt: T }; },
    observeCi(repository, branch, sha) { return { repository, branch, sha, workflowStatus: 'SUCCESS', requiredCheckName: 'test',
      requiredCheckStatus: 'SUCCESS', observedAt: T }; },
    observeProtection(repository, branch) { return { repository, branch, protected: true, requiredChecks: ['test'], observedAt: T }; } };
}
const packetOf = (sliceId, overrides = {}) => ({
  packetId: 'packet-1', packetVersion: 1, sliceId, expectedBaseSha: A, targetBranch: BRANCH,
  objective: 'Offline LD1 fixture', allowedAreas: ['src/automation'], forbiddenChanges: ['src/stress-test'],
  invariants: ['human authority retained'], acceptanceCriteria: ['offline checks pass'],
  validationCommands: [{ commandId: 'test', executable: 'npm', args: ['test'], cwd: '.', classification: 'OFFLINE_VALIDATION' }],
  networkAuthorization: { level: 'WRITE_EXTERNAL', destinations: [BRANCH, 'main', ...IMPL_EGRESS, ...REVIEW_EGRESS].sort(), purpose: 'fixture', budget: 1 },
  providerCallAuthorization: { allowed: true, calls: [structuredClone(IMPL), structuredClone(REVIEW)], maxCalls: 6, budget: 0 },
  destructiveOperationAuthorization: { allowed: false },
  iterationBudget: { maxImplementationIterationsPerSlice: 3, maxAcceptanceFailuresPerSlice: 3, maxRuntimeMinutesPerIteration: 60,
    maxParallelImplementationAgents: 1 }, ...overrides });
function liveGrant(scope, runId, overrides = {}) {
  return { authorizationId: `auth-${scope.actorKind.toLowerCase().replace('_', '-')}`, actorRole: 'HUMAN', operation: 'LIVE_PROVIDER_MODEL_CALL',
    target: TARGET, runId, packetId: 'packet-1', scope: structuredClone(scope), issuedAt: EARLIER, reason: SECRET_REASON, ...overrides };
}
const humanGrant = (operation, target, runId, authorizationId) => ({ authorizationId, actorRole: 'HUMAN', operation, target, runId,
  packetId: 'packet-1', issuedAt: T, reason: 'synthetic authorization' });
const decision = (run, result, reviewId) => ({ reviewId, actor: 'GPT_ARCHITECT', packetId: run.activePacket.packetId,
  packetHash: run.activePacketHash, reviewedSha: run.remoteSha.sha, decision: result,
  findings: result === 'REJECT' ? ['synthetic finding'] : [], evidenceReferences: ['remote diff'], issuedAt: T });
const correctionOf = (run) => ({ correctionPacketId: `correction-${run.implementationIterations + 1}`, originalPacketId: run.activePacket.packetId,
  originalPacketHash: run.activePacketHash, rejectedSha: run.remoteSha.sha, reviewerFindings: run.acceptance.findings,
  allowedCorrectionAreas: ['src/automation'], unchangedInvariantReferences: run.activePacket.invariants, expectedBaseSha: run.remoteSha.sha,
  correctionIteration: run.implementationIterations + 1, maxCorrectionIteration: 3 });
function documentOf(kind, body, { repository = REPO, sliceId, version = 1, supersedes = null } = {}) {
  const id = { IMPLEMENTATION_PACKET: body.packetId, CORRECTION_PACKET: body.correctionPacketId, ACCEPTANCE_DECISION: body.reviewId,
    AUTHORIZATION: body.authorizationId }[kind];
  const role = kind === 'AUTHORIZATION' ? body.actorRole : 'GPT_ARCHITECT';
  return { schemaVersion: 1, recordClass: 'DIRECT_AUTHORITY', kind, authorityId: id, version, issuedAt: body.issuedAt ?? T,
    issuer: { role, principalRef: role === 'HUMAN' ? 'human:local-owner' : 'architect:synthetic' },
    subject: { repository, sliceId: kind === 'IMPLEMENTATION_PACKET' ? body.sliceId : sliceId }, supersedes, body };
}
/** Offline model ports: they count calls and record the journal state of their invocation at call time. */
function modelPorts(journalOf, behaviour = {}) {
  const calls = { implementation: [], review: [] };
  const stateAt = (input) => journalOf().get(input.invocationId)?.state;
  return { calls,
    implementation: { execute(input) {
      calls.implementation.push(stateAt(input));
      return (behaviour.implementation ?? (() => ({ status: 'COMPLETED', validationEvidence: ['npm test: exit 0'] })))(input);
    } },
    review: { review(input) {
      calls.review.push(stateAt(input));
      return (behaviour.review ?? ((i) => ({ decision: { reviewId: 'review-1', actor: 'GPT_ARCHITECT', packetId: i.packet.packetId,
        packetHash: i.packetHash, reviewedSha: i.remoteSha.sha, decision: 'ACCEPT', findings: [], evidenceReferences: ['diff'], issuedAt: T } })))(input);
    } } };
}

/**
 * One governed world: Goal n minted and (unless admit: false) admitted as its RA1 ROOT run.
 * `runner: 'fake'` gives a counting runner that changes nothing; otherwise the real runner.
 */
function world(dir, { goals = [1], admit = true, runner = 'real', grants, behaviour, stepHook } = {}) {
  const paths = { registry: join(dir, 'registry'), controller: join(dir, 'controller'), authority: join(dir, 'authority'), journal: join(dir, 'journal') };
  const minter = openChangeMinter(paths.registry, clock);
  const records = goals.map((n) => minter.mint({ repository: REPO, source: { schemaVersion: 1, ...sourceOf(n), createdAt: T,
    submittedBy: HUMAN, objective: `Governed fixture objective ${n}.` } }));
  const admitter = openRootRunAdmitter(paths.controller, clock);
  const runs = admit ? records.map((record) => admitter.admit({ repository: record.repository, sliceId: record.sliceId,
    changeKey: record.changeKey }).runId) : [];
  const [record] = records;
  const runId = runs[0] ?? `run-${record.changeKey}`;
  const reality = fakeReality();
  const controller = new AutomationController(clock, new FileControllerStore(paths.controller, clock), reality);
  const journal = new FileInvocationJournal(paths.journal, clock);
  const authorizations = grants === undefined
    ? { IMPLEMENTATION: liveGrant(IMPL, runId), ARCHITECT_REVIEW: liveGrant(REVIEW, runId) } : grants;
  const ports = modelPorts(() => journal, behaviour);
  const real = new AutomationRunner(controller, ports.implementation, ports.review,
    { journal, clock, authorizations, scopes: SCOPES });
  const counter = { runner: 0, args: [] };
  const port = { async step(...args) {
    counter.runner += 1;
    counter.args.push(structuredClone(args));
    if (stepHook) await stepHook(args);
    if (runner === 'fake') return { runId: args[0], outcome: 'ADVANCED', state: controller.get(args[0]).state };
    return real.step(...args);
  } };
  const driver = openGovernedExecutionDriver({ controllerStoreDirectory: paths.controller, authorityArchiveDirectory: paths.authority,
    changeRegistryDirectory: paths.registry, runner: port, liveCallAuthorizations: authorizations, scopes: SCOPES, clock });
  let appender;
  const sliceId = record.sliceId;
  const archive = (kind, body, options = {}) =>
    (appender ??= openAuthorityArchiveAppender(paths.authority)).append(documentOf(kind, body, { sliceId, ...options }));
  return { paths, records, record, runs, runId, sliceId, controller, journal, reality, ports, real, counter, driver, archive,
    authorizations, target: (n = 1, id = runId) => ({ source: sourceOf(n), runId: id }) };
}
const packetReady = (w, { archive = true, overrides } = {}) => {
  w.controller.enterArchitecture(w.runId, G);
  const body = packetOf(w.sliceId, overrides);
  w.controller.issuePacket(w.runId, G, body);
  if (archive) w.archive('IMPLEMENTATION_PACKET', body);
  return body;
};
const archiveGrants = (w, kinds = ['IMPLEMENTATION', 'ARCHITECT_REVIEW']) =>
  Object.fromEntries(kinds.map((kind) => [kind, w.archive('AUTHORIZATION', w.authorizations[kind])]));
/** Every entry under a root with type, inode, size, mtime and bytes; null when absent. */
function tree(root) {
  if (!existsSync(root)) return null;
  const walk = (path, rel) => readdirSync(path).sort().flatMap((name) => {
    const child = join(path, name), key = rel ? `${rel}/${name}` : name, status = lstatSync(child, { bigint: true });
    const meta = [key, status.mode, status.ino, status.size, status.mtimeNs];
    if (status.isSymbolicLink()) return [[...meta, 'link', readlinkSync(child)]];
    if (status.isDirectory()) return [[...meta, 'dir'], ...walk(child, key)];
    return [[...meta, 'file', readFileSync(child).toString('base64')]];
  });
  return walk(root, '');
}
const roots = (w) => [w.paths.registry, w.paths.controller, w.paths.authority, w.paths.journal].map(tree);
async function notStepped(w, readiness, reason) {
  const before = roots(w);
  const calls = w.counter.runner;
  const result = await w.driver.step(w.target());
  assert.equal(result.status, 'NOT_STEPPED');
  assert.equal(result.readiness.readiness, readiness, JSON.stringify(result.readiness));
  if (reason) assert.equal(result.readiness.reason, reason);
  assert.deepEqual([result.runnerCalls, result.runnerOutcome, result.postSnapshotId, result.postState], [0, null, null, null]);
  assert.equal(w.counter.runner, calls, 'the runner was called');
  assert.deepEqual(roots(w), before, 'a refused step changed a store');
  return result;
}
const readiness = (w, n, id) => w.driver.inspect(w.target(n, id));
const is = (view, value, reason) => {
  assert.equal(view.readiness, value, JSON.stringify(view));
  if (reason !== undefined) assert.equal(view.reason, reason, JSON.stringify(view));
  return view;
};
const sha = (text) => createHash('sha256').update(text).digest('hex');
function plantRun(w, run) {
  const payload = JSON.stringify(run);
  writeFileSync(join(w.paths.controller, `${sha(run.runId)}.json`), JSON.stringify({ schemaVersion: 1, run: JSON.parse(payload), checksum: sha(payload) }));
}

// ---------------------------------------------------------------- target
check('A. exact CM1 source + its RA1 ROOT run: inspect resolves the target from protected evidence, read only', (dir) => {
  const w = world(dir, { runner: 'fake' });
  const before = roots(w);
  const view = w.driver.inspect(w.target());
  assert.deepEqual(roots(w), before, 'inspect wrote to a store');
  is(view, 'WAITING_EXTERNAL_ACTOR', 'NOT_A_RUNNER_MOVE');
  assert.equal(view.recordClass, 'OPERATIONAL_RECORD');
  assert.deepEqual(view.target, { source: sourceOf(1), runId: w.runId });
  assert.deepEqual([view.change, view.changeKey, view.repository, view.state],
    [{ kind: 'SLICE', changeId: w.record.sliceId }, w.record.changeKey, REPO, 'IDLE']);
  assert.equal(w.runId, `run-${w.record.changeKey}`);
  assert.match(view.snapshotId, /^[0-9a-f]{64}$/);
  assert.deepEqual(view.nextMoves, [{ action: 'ENTER_ARCHITECTURE', role: 'GPT_ARCHITECT' }]);
  assert.equal(view.step, null);
  assert.ok(Object.isFrozen(view) && Object.isFrozen(view.target) && Object.isFrozen(view.nextMoves));
  assert.equal(w.counter.runner, 0);
});
check('A2. a target supplies only the source and the run; anything else, or a malformed source, is refused', (dir) => {
  const w = world(dir, { runner: 'fake' });
  const valid = w.target();
  for (const input of [undefined, null, 'x', [], {}, { source: valid.source }, { runId: w.runId },
    { ...valid, repository: REPO }, { ...valid, sliceId: w.sliceId }, { ...valid, changeKey: w.record.changeKey },
    { ...valid, runId: '' }, { ...valid, runId: ' run' }, { ...valid, runId: 'run/1' },
    { ...valid, source: { ...valid.source, kind: 'CHAT' } }, { ...valid, source: { ...valid.source, repository: REPO } },
    { ...valid, source: { ...valid.source, goalId: 'not-a-goal' } }]) {
    const view = is(w.driver.inspect(input), 'EXECUTION_TARGET_INVALID');
    assert.deepEqual([view.target, view.changeKey, view.snapshotId], [null, null, null]);
  }
  assert.equal(w.counter.runner, 0);
});
check('B. a run not backed by the supplied CM1 source is EXECUTION_TARGET_MISMATCH', async (dir) => {
  const w = world(dir, { goals: [1, 2], runner: 'fake' });
  const view = is(readiness(w, 1, w.runs[1]), 'EXECUTION_TARGET_MISMATCH', 'RUN_OF_ANOTHER_CHANGE');
  assert.equal(view.changeKey, w.records[0].changeKey, 'the Change is the supplied source\'s, never the run\'s');
  is(readiness(w, 2, w.runs[0]), 'EXECUTION_TARGET_MISMATCH');
  const result = await w.driver.step(w.target(1, w.runs[1]));
  assert.deepEqual([result.status, result.runnerCalls], ['NOT_STEPPED', 0]);
});
check('C. a CM1 source with no run is EXECUTION_RUN_NOT_FOUND; an unminted source is EXECUTION_CHANGE_NOT_FOUND', async (dir) => {
  const w = world(dir, { admit: false, runner: 'fake' });
  is(w.driver.inspect(w.target()), 'EXECUTION_RUN_NOT_FOUND', 'RUN_NOT_IN_STORE');
  is(w.driver.inspect(w.target(1, 'run-unknown')), 'EXECUTION_RUN_NOT_FOUND');
  const missing = is(w.driver.inspect(w.target(9)), 'EXECUTION_CHANGE_NOT_FOUND', 'CHANGE_NOT_MINTED');
  assert.equal(missing.snapshotId, null);
  await notStepped(w, 'EXECUTION_RUN_NOT_FOUND');
  assert.deepEqual(readdirSync(w.paths.controller).filter((name) => name.endsWith('.json')), [], 'the driver created a run');
});
check('D. a run that is not the admitted ROOT of its Change fails closed as EXECUTION_ADMISSION_INVALID', async (dir) => {
  const w = world(dir, { runner: 'fake' });
  packetReady(w);
  archiveGrants(w);
  plantRun(w, { runId: 'run-sibling', sliceId: w.sliceId, repository: REPO, state: 'IDLE', implementationIterations: 0,
    acceptanceFailures: 0, audit: [] });
  is(readiness(w, 1, 'run-sibling'), 'EXECUTION_ADMISSION_INVALID', 'ADMISSION_NOT_ROOT');
  const result = await w.driver.step(w.target(1, 'run-sibling'));
  assert.deepEqual([result.status, result.runnerCalls, w.counter.runner], ['NOT_STEPPED', 0, 0]);
  // The real ROOT is not stepped either: its Change now holds an unlinked sibling.
  is(readiness(w), 'EXECUTION_READ_MODEL_CONFLICT', 'GOVERNANCE_ANOMALY');
});
check('E. an R4A0 anomaly anywhere in the store, or an unreadable source, stops execution with no runner call', async (dir) => {
  const w = world(dir, { runner: 'fake' });
  packetReady(w);
  archiveGrants(w);
  is(readiness(w), 'READY');
  plantRun(w, { runId: 'legacy-1', sliceId: 'legacy-slice', repository: REPO, state: 'IDLE', implementationIterations: 0,
    acceptanceFailures: 0, audit: [] });
  const view = is(readiness(w), 'EXECUTION_READ_MODEL_CONFLICT', 'GOVERNANCE_ANOMALY');
  assert.deepEqual(view.conflicts.map((conflict) => [conflict.scope, conflict.code]), [['CONTROLLER_STORE', 'LEGACY_UNINDEXED_RUN']]);
  await notStepped(w, 'EXECUTION_READ_MODEL_CONFLICT');
  rmSync(join(w.paths.controller, `${sha('legacy-1')}.json`));
  is(readiness(w), 'READY');
  writeFileSync(join(w.paths.controller, `${sha('legacy-2')}.json`), '{"not":"a run"}');
  is(readiness(w), 'EXECUTION_READ_MODEL_CONFLICT', 'READ_MODEL_CONTROLLER_RUN_INVALID');
  await notStepped(w, 'EXECUTION_READ_MODEL_CONFLICT');
});

// ---------------------------------------------------------------- direct authority and the live-call grant
check('F. a required R4A0 authority reference that does not resolve is BLOCKED_AUTHORITY with no runner call', async (dir) => {
  const w = world(dir, { runner: 'fake' });
  packetReady(w, { archive: false });
  archiveGrants(w);
  const view = is(readiness(w), 'BLOCKED_AUTHORITY', 'AUTHORITY_UNRESOLVED');
  assert.deepEqual(view.conflicts, [{ scope: 'AUTHORITY', code: 'NOT_ARCHIVED', locator: `${w.runId}:activePacket` }]);
  await notStepped(w, 'BLOCKED_AUTHORITY');
  // A different body under the same packetId is never accepted, and no latest version stands in.
  w.archive('IMPLEMENTATION_PACKET', packetOf(w.sliceId, { objective: 'Another wording' }));
  is(readiness(w), 'BLOCKED_AUTHORITY', 'AUTHORITY_UNRESOLVED');
});
check('G. PACKET_READY with the exact packet and the exact IMPLEMENTATION Human grant archived is READY', (dir) => {
  const w = world(dir, { runner: 'fake' });
  packetReady(w);
  const refs = archiveGrants(w, ['IMPLEMENTATION']);
  const view = is(readiness(w), 'READY', null);
  assert.equal(view.state, 'PACKET_READY');
  assert.deepEqual(view.step, { moves: ['BEGIN_IMPLEMENTATION/CODEX_IMPLEMENTER/IMPLEMENTING'],
    liveCall: { actorKind: 'IMPLEMENTATION', authority: refs.IMPLEMENTATION } });
  assert.deepEqual(view.conflicts, []);
  assert.equal(w.counter.runner, 0, 'inspect never steps');
});
check('H. the same authorizationId archived with a different body is BLOCKED_AUTHORITY; no latest version stands in', (dir) => {
  const w = world(dir, { runner: 'fake' });
  packetReady(w);
  const first = w.archive('AUTHORIZATION', { ...w.authorizations.IMPLEMENTATION, reason: 'a different human statement' });
  is(readiness(w), 'BLOCKED_AUTHORITY', 'LIVE_CALL_GRANT_VERSION_NOT_FOUND');
  w.archive('AUTHORIZATION', { ...w.authorizations.IMPLEMENTATION, reason: 'revised again' }, { version: 2, supersedes: first });
  is(readiness(w), 'BLOCKED_AUTHORITY', 'LIVE_CALL_GRANT_VERSION_NOT_FOUND');
});
check('I. an unarchived or missing live-call grant is BLOCKED_AUTHORITY', async (dir) => {
  const w = world(dir, { runner: 'fake' });
  packetReady(w);
  is(readiness(w), 'BLOCKED_AUTHORITY', 'LIVE_CALL_GRANT_NOT_ARCHIVED');
  await notStepped(w, 'BLOCKED_AUTHORITY', 'LIVE_CALL_GRANT_NOT_ARCHIVED');
  const none = world(join(dir, 'none'), { runner: 'fake', grants: {} });
  packetReady(none);
  is(readiness(none), 'BLOCKED_AUTHORITY', 'LIVE_CALL_GRANT_MISSING');
  const malformed = world(join(dir, 'malformed'), { runner: 'fake', grants: { IMPLEMENTATION: { authorizationId: 'x' } } });
  packetReady(malformed);
  is(readiness(malformed), 'BLOCKED_AUTHORITY', 'LIVE_CALL_GRANT_MISSING');
});
check('J-O. a grant bound to another run, packet, actor, provider, model or egress set is BLOCKED even when archived', (dir) => {
  const cases = {
    'J wrong runId': (runId) => liveGrant(IMPL, `${runId}-other`),
    'K wrong packetId': (runId) => liveGrant(IMPL, runId, { packetId: 'packet-2' }),
    'L wrong actor kind': (runId) => liveGrant(IMPL, runId, { scope: { ...structuredClone(IMPL), actorKind: 'ARCHITECT_REVIEW' } }),
    'L2 the other actor\'s grant': (runId) => liveGrant(REVIEW, runId),
    'M wrong provider': (runId) => liveGrant(IMPL, runId, { scope: { ...structuredClone(IMPL), provider: 'openai' } }),
    'N wrong model': (runId) => liveGrant(IMPL, runId, { scope: { ...structuredClone(IMPL), model: 'claude-sonnet-5-5' } }),
    'O different egress set': (runId) => liveGrant(IMPL, runId, { scope: { ...structuredClone(IMPL), egressDestinations: ['api.anthropic.com:443'] } }),
    'O2 extra egress destination': (runId) => liveGrant(IMPL, runId, { scope: { ...structuredClone(IMPL),
      egressDestinations: [...IMPL_EGRESS, 'statsig.anthropic.com:443'].sort() } }),
    'GPT-issued grant': (runId) => liveGrant(IMPL, runId, { actorRole: 'GPT_ARCHITECT' }),
    'another operation': (runId) => liveGrant(IMPL, runId, { operation: 'READ_EXTERNAL_API' }),
    'another target': (runId) => liveGrant(IMPL, runId, { target: 'api.anthropic.com:443' }),
    'no scope': (runId) => { const { scope, ...rest } = liveGrant(IMPL, runId); void scope; return rest; },
  };
  let n = 0;
  for (const [label, make] of Object.entries(cases)) {
    const probe = world(join(dir, `probe-${n}`), { runner: 'fake' });
    const runId = probe.runId;
    const w = world(join(dir, `case-${n++}`), { runner: 'fake', grants: { IMPLEMENTATION: make(runId) } });
    assert.equal(w.runId, runId);
    packetReady(w);
    try { w.archive('AUTHORIZATION', w.authorizations.IMPLEMENTATION); } catch { /* the archive itself refused this body */ }
    is(readiness(w), 'BLOCKED_AUTHORITY', 'LIVE_CALL_GRANT_NOT_BOUND');
    assert.equal(w.counter.runner, 0, label);
  }
});
check('J2. an exact grant archived for another Change is BLOCKED_AUTHORITY (subject mismatch)', (dir) => {
  const w = world(dir, { runner: 'fake' });
  packetReady(w);
  w.archive('AUTHORIZATION', w.authorizations.IMPLEMENTATION, { sliceId: 'goal-other' });
  is(readiness(w), 'BLOCKED_AUTHORITY', 'LIVE_CALL_GRANT_SUBJECT_MISMATCH');
});
check('P. an archived but expired grant is READY at the gate; the runner\'s own dispatch policy still refuses: no bypass', async (dir) => {
  const runId = world(join(dir, 'probe'), { runner: 'fake' }).runId;
  const e = world(join(dir, 'expired'), { grants: { IMPLEMENTATION: liveGrant(IMPL, runId, { expiresAt: EXPIRED }) } });
  packetReady(e);
  archiveGrants(e, ['IMPLEMENTATION']);
  is(readiness(e), 'READY');
  const prepared = await e.driver.step(e.target());
  assert.deepEqual([prepared.status, prepared.runnerOutcome, prepared.postState], ['STEPPED', 'ADVANCED', 'IMPLEMENTING']);
  const refused = await e.driver.step(e.target());
  assert.deepEqual([refused.status, refused.runnerOutcome, refused.preState, refused.postState], ['STEPPED', 'STOPPED', 'IMPLEMENTING', 'HUMAN_STOP']);
  assert.equal(refused.readiness.readiness, 'WAITING_HUMAN');
  assert.equal(e.ports.calls.implementation.length, 0, 'an expired grant reached the model port');
  assert.deepEqual(e.journal.list(e.runId).map((record) => record.state), ['ABANDONED']);
  assert.equal(e.counter.runner, 2);
});

// ---------------------------------------------------------------- steps through the real runner
check('Q-R-T-U-AA. each step calls the runner exactly once; the post-step read decides what comes next', async (dir) => {
  const w = world(dir);
  packetReady(w);
  archiveGrants(w);
  const expectStep = async (from, to, outcome) => {
    const calls = w.counter.runner;
    const result = await w.driver.step(w.target());
    assert.equal(w.counter.runner, calls + 1, `${from}: one driver step must call the runner exactly once`);
    assert.deepEqual([result.status, result.runnerCalls, result.runnerOutcome, result.preState, result.postState],
      ['STEPPED', 1, outcome, from, to], JSON.stringify(result));
    assert.notEqual(result.preSnapshotId, result.postSnapshotId);
    assert.equal(result.postSnapshotId, result.readiness.snapshotId);
    assert.equal(result.changeKey, w.record.changeKey);
    assert.deepEqual(result.target, w.target());
    // The runner is bound to the exact audit position the gate read.
    const [runId, position] = w.counter.args.at(-1);
    const gated = w.controller.audit(w.runId).find((entry) => entry.sequence === position.sequence);
    assert.deepEqual([runId, position.state, position.action, position.timestamp], [w.runId, from, gated.action, gated.timestamp]);
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.readiness));
    return result;
  };
  await expectStep('PACKET_READY', 'IMPLEMENTING', 'ADVANCED');
  assert.deepEqual(w.ports.calls.implementation, [], 'entering IMPLEMENTING prepares, it never calls the model');
  assert.deepEqual(w.journal.list(w.runId).map((record) => [record.state, record.identity.authorizationId]), [['PREPARED', 'auth-implementation']]);
  await expectStep('IMPLEMENTING', 'IMPLEMENTATION_COMPLETE', 'ADVANCED');
  assert.deepEqual(w.ports.calls.implementation, ['STARTED']);
  await expectStep('IMPLEMENTATION_COMPLETE', 'REMOTE_SHA_READY', 'ADVANCED');
  await expectStep('REMOTE_SHA_READY', 'ACCEPTANCE_REVIEW', 'ADVANCED');
  assert.deepEqual(w.ports.calls.review, []);
  const accepted = await expectStep('ACCEPTANCE_REVIEW', 'ACCEPTED', 'HUMAN_PROMOTION_REQUIRED');
  assert.deepEqual(w.ports.calls.review, ['STARTED']);
  // AA. The review's decision is an operational copy until R4P holds it: the step happened, readiness is blocked.
  is(accepted.readiness, 'BLOCKED_AUTHORITY', 'AUTHORITY_UNRESOLVED');
  assert.deepEqual(accepted.readiness.conflicts, [{ scope: 'AUTHORITY', code: 'NOT_ARCHIVED', locator: `${w.runId}:acceptance` }]);
  await notStepped(w, 'BLOCKED_AUTHORITY');
  assert.equal(w.counter.runner, 5);
  // Y. Once the exact decision is archived, the next move is the Human's.
  w.archive('ACCEPTANCE_DECISION', w.controller.get(w.runId).acceptance);
  is(readiness(w), 'WAITING_HUMAN', 'NOT_A_RUNNER_MOVE');
  await notStepped(w, 'WAITING_HUMAN');
  assert.deepEqual(w.journal.list(w.runId).map((record) => record.state).sort(), ['APPLIED', 'APPLIED'], 'invocation records stay operational');
  assert.deepEqual([w.ports.calls.implementation.length, w.ports.calls.review.length], [1, 1]);
});
check('S. IMPLEMENTATION_COMPLETE needs no provider-call grant; REMOTE_SHA_READY then does', async (dir) => {
  const w = world(dir, { grants: {} });
  packetReady(w);
  w.controller.beginImplementation(w.runId, X);
  w.controller.completeImplementation(w.runId, X, ['npm test: exit 0']);
  const view = is(readiness(w), 'READY');
  assert.deepEqual(view.step, { moves: ['RECORD_REMOTE_SHA/CODEX_IMPLEMENTER/REMOTE_SHA_READY'], liveCall: null });
  const result = await w.driver.step(w.target());
  assert.deepEqual([result.status, result.postState], ['STEPPED', 'REMOTE_SHA_READY']);
  is(result.readiness, 'BLOCKED_AUTHORITY', 'LIVE_CALL_GRANT_MISSING');
});
check('T-U. REMOTE_SHA_READY and ACCEPTANCE_REVIEW require the archived ARCHITECT_REVIEW grant, not the implementation one', async (dir) => {
  const w = world(dir, { runner: 'fake' });
  packetReady(w);
  archiveGrants(w, ['IMPLEMENTATION']);
  w.controller.beginImplementation(w.runId, X);
  w.controller.completeImplementation(w.runId, X, ['npm test: exit 0']);
  w.controller.recordRemoteSha(w.runId, X);
  is(readiness(w), 'BLOCKED_AUTHORITY', 'LIVE_CALL_GRANT_NOT_ARCHIVED');
  await notStepped(w, 'BLOCKED_AUTHORITY');
  const refs = archiveGrants(w, ['ARCHITECT_REVIEW']);
  assert.deepEqual(is(readiness(w), 'READY').step.liveCall, { actorKind: 'ARCHITECT_REVIEW', authority: refs.ARCHITECT_REVIEW });
  w.controller.beginAcceptanceReview(w.runId, G);
  assert.deepEqual(is(readiness(w), 'READY').step, { moves: ['ACCEPT_EXACT_SHA/GPT_ARCHITECT/ACCEPTED',
    'REJECT_EXACT_SHA/GPT_ARCHITECT/CORRECTION_REQUIRED'], liveCall: { actorKind: 'ARCHITECT_REVIEW', authority: refs.ARCHITECT_REVIEW } });
  const missing = world(join(dir, 'missing'), { runner: 'fake', grants: { IMPLEMENTATION: liveGrant(IMPL, w.runId) } });
  packetReady(missing);
  archiveGrants(missing, ['IMPLEMENTATION']);
  missing.controller.beginImplementation(missing.runId, X);
  missing.controller.completeImplementation(missing.runId, X, ['npm test: exit 0']);
  missing.controller.recordRemoteSha(missing.runId, X);
  missing.controller.beginAcceptanceReview(missing.runId, G);
  is(readiness(missing), 'BLOCKED_AUTHORITY', 'LIVE_CALL_GRANT_MISSING');
});

// ---------------------------------------------------------------- every lifecycle state
check('V-W-X-Y-Z. across the whole lifecycle only runner-protocol moves are READY; every other position is reported, never taken', async (dir) => {
  const w = world(dir, { runner: 'fake' });
  const c = w.controller, id = w.runId;
  const waiting = async (expected, moves) => {
    const view = is(readiness(w), expected);
    if (moves) assert.deepEqual(view.nextMoves.map(({ action, role }) => `${action}/${role}`), moves);
    await notStepped(w, expected);
  };
  await waiting('WAITING_EXTERNAL_ACTOR', ['ENTER_ARCHITECTURE/GPT_ARCHITECT']);                                     // W
  c.enterArchitecture(id, G);
  await waiting('WAITING_EXTERNAL_ACTOR', ['ISSUE_PACKET/GPT_ARCHITECT']);                                           // X
  const body = packetOf(w.sliceId);
  c.issuePacket(id, G, body);
  w.archive('IMPLEMENTATION_PACKET', body);
  archiveGrants(w);
  is(readiness(w), 'READY');
  c.beginImplementation(id, X);
  is(readiness(w), 'READY');
  c.stop(id, K, 'SOFT_STOP', 'build failure');
  await waiting('WAITING_EXTERNAL_ACTOR', ['RESUME_SOFT_WITH_REPAIR/CONTROLLER', 'BUDGET_EXHAUSTED/CONTROLLER']);
  c.resumeSoft(id, K, 'repaired build');
  is(readiness(w), 'READY');
  c.completeImplementation(id, X, ['offline checks pass']);
  is(readiness(w), 'READY');
  c.recordRemoteSha(id, X);
  is(readiness(w), 'READY');
  c.stop(id, H, 'HUMAN_STOP', 'human pause');
  await waiting('WAITING_HUMAN', ['RESUME_HUMAN_STOP/HUMAN']);
  const resume = humanGrant('RESUME_HUMAN_STOP', c.get(id).stopId, id, 'auth-resume');
  c.resumeHuman(id, H, resume);
  is(readiness(w), 'BLOCKED_AUTHORITY', 'AUTHORITY_UNRESOLVED');
  w.archive('AUTHORIZATION', resume);
  await waiting('WAITING_EXTERNAL_ACTOR', ['RECHECK_EXTERNAL_REALITY/CONTROLLER']);
  c.reconcile(id, K);
  is(readiness(w), 'READY');
  c.beginAcceptanceReview(id, G);
  is(readiness(w), 'READY');
  const rejection = decision(c.get(id), 'REJECT', 'review-1');
  c.decideAcceptance(id, G, rejection);
  is(readiness(w), 'BLOCKED_AUTHORITY', 'AUTHORITY_UNRESOLVED');
  w.archive('ACCEPTANCE_DECISION', rejection);
  await waiting('WAITING_EXTERNAL_ACTOR', ['ISSUE_CORRECTION_PACKET/GPT_ARCHITECT']);                                 // V
  const fix = correctionOf(c.get(id));
  c.issueCorrection(id, G, fix);
  is(readiness(w), 'BLOCKED_AUTHORITY', 'AUTHORITY_UNRESOLVED');
  w.archive('CORRECTION_PACKET', fix);
  assert.deepEqual(is(readiness(w), 'READY').step.moves, ['BEGIN_IMPLEMENTATION/CODEX_IMPLEMENTER/IMPLEMENTING']);
  c.beginImplementation(id, X);
  c.completeImplementation(id, X, ['offline checks pass']);
  c.recordRemoteSha(id, X);
  c.beginAcceptanceReview(id, G);
  const acceptance = decision(c.get(id), 'ACCEPT', 'review-2');
  c.decideAcceptance(id, G, acceptance);
  await waiting('BLOCKED_AUTHORITY');                                                                                  // Y (unarchived)
  w.archive('ACCEPTANCE_DECISION', acceptance);
  await waiting('WAITING_HUMAN', ['AUTHORIZE_PROMOTION/HUMAN']);                                                      // Y
  const promotion = humanGrant('FAST_FORWARD_MAIN', 'main', id, 'auth-promote');
  c.requestPromotion(id, H, promotion);
  w.archive('AUTHORIZATION', promotion);
  await waiting('WAITING_EXTERNAL_ACTOR', ['MARK_PROMOTING/CONTROLLER']);
  c.beginPromotion(id, K);
  await waiting('WAITING_EXTERNAL_ACTOR');
  w.reality.mainSha = B;
  c.recordPromotedMain(id, K);
  await waiting('WAITING_EXTERNAL_ACTOR');
  c.close(id, K);
  await waiting('TERMINAL', []);                                                                                       // Z
  assert.equal(w.counter.runner, 0, 'no position in the walk was stepped');
});
check('X2-Z2. ARCHITECTURE_STOP, a spent iteration budget and FAILED_CLOSED are never stepped', async (dir) => {
  const w = world(dir, { runner: 'fake' });
  packetReady(w);
  archiveGrants(w);
  w.controller.stop(w.runId, G, 'ARCHITECTURE_STOP', 'scope question');
  await notStepped(w, 'WAITING_EXTERNAL_ACTOR');
  const spent = world(join(dir, 'spent'), { runner: 'fake' });
  packetReady(spent, { overrides: { iterationBudget: { maxImplementationIterationsPerSlice: 1, maxAcceptanceFailuresPerSlice: 3,
    maxRuntimeMinutesPerIteration: 60, maxParallelImplementationAgents: 1 } } });
  archiveGrants(spent);
  const c = spent.controller, id = spent.runId;
  c.beginImplementation(id, X);
  c.completeImplementation(id, X, ['ok']);
  c.recordRemoteSha(id, X);
  c.beginAcceptanceReview(id, G);
  const rejection = decision(c.get(id), 'REJECT', 'review-1');
  c.decideAcceptance(id, G, rejection);
  spent.archive('ACCEPTANCE_DECISION', rejection);
  // The iteration budget is spent: R4A0's next move is the controller halt, which the runner would take; LD1 does not.
  const view = is(readiness(spent), 'WAITING_EXTERNAL_ACTOR', 'NOT_A_RUNNER_MOVE');
  assert.deepEqual(view.nextMoves, [{ action: 'STOP', role: 'CONTROLLER' }]);
  await notStepped(spent, 'WAITING_EXTERNAL_ACTOR');
  const failed = world(join(dir, 'failed'), { runner: 'fake' });
  packetReady(failed);
  failed.controller.failClosed(failed.runId, K, 'integrity failure');
  await notStepped(failed, 'TERMINAL');
});

// ---------------------------------------------------------------- races, recovery, budget
check('AB. a run moved by another writer after the gate is never stepped: one runner call, no retry, STALE_OR_ADVANCED', async (dir) => {
  const other = { controller: undefined };
  const w = world(dir, { stepHook: async ([runId]) => { other.controller.beginImplementation(runId, X); } });
  other.controller = new AutomationController(clock, new FileControllerStore(w.paths.controller, clock), w.reality);
  packetReady(w);
  archiveGrants(w);
  const result = await w.driver.step(w.target());
  assert.deepEqual([result.status, result.runnerCalls, result.runnerOutcome, result.preState, result.postState],
    ['STALE_OR_ADVANCED', 1, 'STALE_OCCURRENCE', 'PACKET_READY', 'IMPLEMENTING']);
  assert.equal(w.counter.runner, 1);
  assert.deepEqual(w.journal.list(w.runId), [], 'the stale step prepared an invocation');
  assert.deepEqual(w.controller.audit(w.runId).filter((entry) => entry.action === 'BEGIN_IMPLEMENTATION').length, 1);
  assert.deepEqual([w.ports.calls.implementation.length, w.ports.calls.review.length], [0, 0]);
  // A runner that throws (another step in flight, a store refusal) is also a race, never retried.
  const busy = world(join(dir, 'busy'), { runner: 'fake', stepHook: async () => { throw new Error('A step is already in progress for this run'); } });
  packetReady(busy);
  archiveGrants(busy);
  const refused = await busy.driver.step(busy.target());
  assert.deepEqual([refused.status, refused.runnerCalls, refused.runnerOutcome, refused.postState], ['STALE_OR_ADVANCED', 1, 'RUNNER_REFUSED', 'PACKET_READY']);
  assert.equal(busy.counter.runner, 1);
});
check('AB2. the runner position guard: a stale position writes nothing, journal included; no guard keeps the old behaviour', async (dir) => {
  const w = world(dir);
  packetReady(w);
  const last = w.controller.audit(w.runId).at(-1);
  const before = roots(w);
  for (const position of [{ state: 'IMPLEMENTING', sequence: last.sequence, action: last.action, timestamp: last.timestamp },
    { state: 'PACKET_READY', sequence: last.sequence - 1, action: last.action, timestamp: last.timestamp },
    { state: 'PACKET_READY', sequence: last.sequence, action: 'ENTER_ARCHITECTURE', timestamp: last.timestamp },
    { state: 'PACKET_READY', sequence: last.sequence, action: last.action, timestamp: EARLIER }]) {
    const result = await w.real.step(w.runId, position);
    assert.deepEqual([result.outcome, result.state], ['STALE_OCCURRENCE', 'PACKET_READY']);
  }
  assert.deepEqual(roots(w), before);
  await assert.rejects(() => w.real.step(w.runId, { state: 'PACKET_READY' }), TypeError);
  const exact = await w.real.step(w.runId, { state: 'PACKET_READY', sequence: last.sequence, action: last.action, timestamp: last.timestamp });
  assert.deepEqual([exact.outcome, exact.state], ['ADVANCED', 'IMPLEMENTING']);
  const unguarded = world(join(dir, 'unguarded'));
  packetReady(unguarded);
  assert.equal((await unguarded.real.step(unguarded.runId)).state, 'IMPLEMENTING');
});
check('AV. an uncertain STARTED invocation is never replayed through the driver', async (dir) => {
  const w = world(dir);
  packetReady(w);
  archiveGrants(w);
  await w.driver.step(w.target());
  const [prepared] = w.journal.list(w.runId);
  assert.equal(w.journal.start(prepared.invocationId, 6).status, 'STARTED');
  // A new process: new controller, journal, runner and driver over the same roots.
  const journal = new FileInvocationJournal(w.paths.journal, clock);
  const controller = new AutomationController(clock, new FileControllerStore(w.paths.controller, clock), w.reality);
  const ports = modelPorts(() => journal);
  const runner = new AutomationRunner(controller, ports.implementation, ports.review, { journal, clock, authorizations: w.authorizations, scopes: SCOPES });
  let calls = 0;
  const driver = openGovernedExecutionDriver({ controllerStoreDirectory: w.paths.controller, authorityArchiveDirectory: w.paths.authority,
    changeRegistryDirectory: w.paths.registry, runner: { step: (...args) => { calls += 1; return runner.step(...args); } },
    liveCallAuthorizations: w.authorizations, scopes: SCOPES, clock });
  is(driver.inspect(w.target()), 'READY');
  const result = await driver.step(w.target());
  assert.deepEqual([result.status, result.runnerOutcome, result.postState, result.readiness.readiness], ['STEPPED', 'STOPPED', 'HUMAN_STOP', 'WAITING_HUMAN']);
  assert.deepEqual([calls, ports.calls.implementation.length], [1, 0]);
  assert.deepEqual(journal.list(w.runId).map((record) => record.state), ['UNCERTAIN']);
});
check('AU. the packet call budget still binds: an exhausted budget is not bypassed by an archived grant', async (dir) => {
  const w = world(dir);
  packetReady(w, { overrides: { providerCallAuthorization: { allowed: true, calls: [structuredClone(IMPL), structuredClone(REVIEW)],
    maxCalls: 1, budget: 0 } } });
  archiveGrants(w);
  for (let i = 0; i < 4; i++) await w.driver.step(w.target());
  assert.equal(w.controller.get(w.runId).state, 'ACCEPTANCE_REVIEW');
  const result = await w.driver.step(w.target());
  assert.deepEqual([result.runnerOutcome, result.postState], ['STOPPED', 'HUMAN_STOP']);
  assert.deepEqual([w.ports.calls.implementation.length, w.ports.calls.review.length], [1, 0]);
});

// ---------------------------------------------------------------- the capability surface
check('AC-AD-AE. the driver exposes inspect and step only: no Controller, runner, store, loop or drive', async (dir) => {
  const w = world(dir);
  assert.deepEqual(Object.keys(w.driver).sort(), ['inspect', 'step']);
  assert.ok(Object.isFrozen(w.driver));
  for (const name of ['drive', 'runUntilDone', 'startAutonomous', 'loop', 'resumeAutomatically', 'controller', 'runner', 'journal', 'store',
    'registry', 'reality', 'admit', 'mint']) assert.equal(w.driver[name], undefined, name);
  assert.deepEqual(Object.keys(driverModule).sort(), ['EXECUTION_READINESS', 'openGovernedExecutionDriver']);
  assert.deepEqual(Object.keys(liveModule), ['createGovernedLiveExecutionDriver']);
  packetReady(w);
  archiveGrants(w);
  const result = await w.driver.step(w.target());
  assert.equal(w.counter.runner, 1);
  // Operational evidence only: no path, no grant body, no Controller display text.
  const text = JSON.stringify(result);
  for (const secret of [dir, realpathSync(dir), SECRET_REASON, 'validationEvidence', 'npm test: exit 0', '"checksum"']) {
    assert.equal(text.includes(secret), false, secret);
  }
  assert.throws(() => openGovernedExecutionDriver({ controllerStoreDirectory: w.paths.controller, authorityArchiveDirectory: w.paths.authority,
    changeRegistryDirectory: w.paths.registry, liveCallAuthorizations: {}, scopes: SCOPES }), TypeError);
  assert.throws(() => openGovernedExecutionDriver({ controllerStoreDirectory: w.paths.controller, authorityArchiveDirectory: w.paths.authority,
    changeRegistryDirectory: w.paths.registry, runner: w.real, liveCallAuthorizations: {}, scopes: { IMPLEMENTATION: REVIEW, ARCHITECT_REVIEW: REVIEW } }), TypeError);
  // A grant changed after the driver was opened is not the grant that was supplied.
  const g = world(join(dir, 'snapshot'), { runner: 'fake' });
  packetReady(g);
  archiveGrants(g, ['IMPLEMENTATION']);
  g.authorizations.IMPLEMENTATION.runId = 'run-other';
  is(readiness(g), 'READY');
});

// ---------------------------------------------------------------- the live composition
const PINS = realpathSync(mkdtempSync(join(tmpdir(), 'chief-ld1-pins-')));
process.on('exit', () => rmSync(PINS, { recursive: true, force: true }));
const pinned = (name) => {
  const path = join(PINS, name);
  writeFileSync(path, `SYNTHETIC-${name.toUpperCase()}-BINARY\n`, { mode: 0o755 });
  return { executable: path, executableSha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
};
const directory = (path) => { mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700); return path; };
function liveConfig(dir, grants) {
  for (const path of ['repo', 'worktrees', 'deps']) directory(join(dir, path));
  const governance = join(dir, 'governance');
  return { repository: REPO, controllerStoreDirectory: directory(join(governance, 'controller')),
    authorityArchiveDirectory: directory(join(governance, 'authority')), changeRegistryDirectory: directory(join(governance, 'registry')),
    journalDirectory: join(dir, 'journal'), egressJournalDirectory: join(dir, 'egress'), environment: { allow: ['PATH'] },
    claude: { ...pinned('claude'), provider: IMPL.provider, model: IMPL.model, egressDestinations: [...IMPL_EGRESS], timeoutMs: 600_000, maxTurns: 40,
      maxStdoutBytes: 1_000_000, maxStderrBytes: 1_000_000 },
    codex: { ...pinned('codex'), provider: REVIEW.provider, model: REVIEW.model, egressDestinations: [...REVIEW_EGRESS], timeoutMs: 600_000,
      maxStdoutBytes: 1_000_000, maxStderrBytes: 1_000_000, maxResultBytes: 100_000, disabledFeatures: [] },
    git: { executable: 'git', remote: 'origin', repositoryPath: join(dir, 'repo'), worktreeRoot: join(dir, 'worktrees'), timeoutMs: 60_000,
      maxOutputBytes: 1_000_000, commitAuthor: { name: 'CHIEF automation', email: 'automation@example.invalid' }, validationTimeoutMs: 60_000,
      validationMaxOutputBytes: 1_000_000, linkedDirectories: [{ path: 'node_modules', source: join(dir, 'deps') }] },
    offlineValidation: { runtimeReadPaths: [], searchPath: '/usr/bin:/bin' }, modelProcess: { runtimeReadPaths: [], searchPath: '/usr/bin:/bin' },
    github: { executable: 'gh', workflowName: 'CI', requiredCheckName: 'test', timeoutMs: 10_000, maxOutputBytes: 1_000_000, maxObservationAgeMs: 60_000 },
    liveCallAuthorizations: grants };
}
function counted() {
  const count = { processes: 0 };
  const bump = async () => { count.processes += 1; };
  return { count, dependencies: { clock, environmentSource: { PATH: '/bin' }, executor: { run: bump }, syncExecutor: { runSync() { count.processes += 1; } },
    offlineValidation: { runOffline: bump }, modelProcess: { runModel: bump } } };
}
check('LIVE. the trusted composition returns only the driver, derives each actor scope from the live configuration, starts nothing', (dir) => {
  const base = realpathSync(dir);
  const probe = liveConfig(join(base, 'probe'), {});
  const minted = openChangeMinter(probe.changeRegistryDirectory, clock).mint({ repository: REPO, source: { schemaVersion: 1, ...sourceOf(1),
    createdAt: T, submittedBy: HUMAN, objective: 'Live composition fixture.' } });
  const runId = openRootRunAdmitter(probe.controllerStoreDirectory, clock).admit({ repository: REPO, sliceId: minted.sliceId, changeKey: minted.changeKey }).runId;
  const grants = { IMPLEMENTATION: liveGrant(IMPL, runId), ARCHITECT_REVIEW: liveGrant(REVIEW, runId) };
  const input = { ...probe, liveCallAuthorizations: grants };
  const { count, dependencies } = counted();
  const driver = createGovernedLiveExecutionDriver(input, dependencies);
  assert.deepEqual(Object.keys(driver).sort(), ['inspect', 'step']);
  const target = { source: sourceOf(1), runId };
  is(driver.inspect(target), 'WAITING_EXTERNAL_ACTOR');
  const controller = new AutomationController(clock, new FileControllerStore(probe.controllerStoreDirectory, clock), fakeReality());
  controller.enterArchitecture(runId, G);
  const body = packetOf(minted.sliceId);
  controller.issuePacket(runId, G, body);
  const appender = openAuthorityArchiveAppender(probe.authorityArchiveDirectory);
  appender.append(documentOf('IMPLEMENTATION_PACKET', body));
  appender.append(documentOf('AUTHORIZATION', grants.IMPLEMENTATION, { sliceId: minted.sliceId }));
  // The configuration was copied at composition: changing the caller's object changes nothing.
  input.liveCallAuthorizations.IMPLEMENTATION.packetId = 'packet-other';
  assert.deepEqual(is(driver.inspect(target), 'READY').step.liveCall.actorKind, 'IMPLEMENTATION');
  assert.equal(count.processes, 0, 'composing or inspecting started a process');
  // A grant scoped to the Codex adapter is not the Claude adapter's grant.
  const other = liveConfig(join(base, 'other'), {});
  const m2 = openChangeMinter(other.changeRegistryDirectory, clock).mint({ repository: REPO, source: { schemaVersion: 1, ...sourceOf(1),
    createdAt: T, submittedBy: HUMAN, objective: 'Live composition fixture.' } });
  const r2 = openRootRunAdmitter(other.controllerStoreDirectory, clock).admit({ repository: REPO, sliceId: m2.sliceId, changeKey: m2.changeKey }).runId;
  const swapped = createGovernedLiveExecutionDriver({ ...other, liveCallAuthorizations: { IMPLEMENTATION: liveGrant(REVIEW, r2) } }, counted().dependencies);
  const c2 = new AutomationController(clock, new FileControllerStore(other.controllerStoreDirectory, clock), fakeReality());
  c2.enterArchitecture(r2, G);
  c2.issuePacket(r2, G, packetOf(m2.sliceId));
  openAuthorityArchiveAppender(other.authorityArchiveDirectory).append(documentOf('IMPLEMENTATION_PACKET', packetOf(m2.sliceId)));
  is(swapped.inspect({ source: sourceOf(1), runId: r2 }), 'BLOCKED_AUTHORITY', 'LIVE_CALL_GRANT_NOT_BOUND');
});
check('LIVE2. an unsafe live configuration is refused by the unchanged live checks before anything is created', (dir) => {
  const base = realpathSync(dir);
  const config = liveConfig(join(base, 'unsafe'), {});
  const overlapping = { ...config, changeRegistryDirectory: join(config.controllerStoreDirectory, 'registry') };
  const watched = [config.controllerStoreDirectory, config.authorityArchiveDirectory, config.journalDirectory, config.egressJournalDirectory];
  const before = watched.map(tree);
  const { count, dependencies } = counted();
  assert.throws(() => createGovernedLiveExecutionDriver(overlapping, dependencies), GovernanceStoreIsolationError);
  const agentVisible = { ...config, git: { ...config.git, worktreeRoot: config.changeRegistryDirectory } };
  assert.throws(() => createGovernedLiveExecutionDriver(agentVisible, dependencies), GovernanceStoreIsolationError);
  assert.throws(() => createGovernedLiveExecutionDriver({ ...config, claude: { ...config.claude, model: 'claude-latest' } }, dependencies));
  assert.deepEqual(watched.map(tree), before, 'a refused composition created something');
  assert.equal(count.processes, 0);
});

// ---------------------------------------------------------------- production topology (static)
function sources(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? sources(child) : entry.name.endsWith('.ts') ? [child] : [];
  });
}
const SRC = sources(join(ROOT, 'src'));
const text = (path) => readFileSync(path, 'utf8');
const rel = (path) => relative(ROOT, path);
const code = (path) => text(path).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const DRIVER = 'src/automation/execution-driver.ts', LIVE = 'src/automation/live/governed-execution.ts';
const READ_MODEL = 'src/automation/read-model/governed-read-model.ts';
const users = (pattern, except = []) => SRC.filter((path) => !except.includes(rel(path)) && pattern.test(text(path))).map(rel).sort();
check('AF-AG-AH-AI. LD1 holds no appender; the archive reader stays in R4A0; R4A0 gains exactly the LD1 caller', () => {
  for (const file of [DRIVER, LIVE]) {
    assert.doesNotMatch(text(join(ROOT, file)), /AuthorityArchiveAppender|openAuthorityArchiveAppender|openAuthorityArchiveReader|file-archive/, file);
  }
  assert.deepEqual(users(/openAuthorityArchiveAppender|AuthorityArchiveAppender/, ['src/automation/authority/file-archive.ts']), []);
  assert.deepEqual(users(/openAuthorityArchiveReader/, ['src/automation/authority/file-archive.ts']), [READ_MODEL]);
  assert.deepEqual(users(/read-model\/governed-read-model\.js/), [DRIVER]);
  assert.deepEqual(users(/readGovernedModel\(/, [READ_MODEL]), [DRIVER]);
  assert.equal((code(join(ROOT, DRIVER)).match(/readGovernedModel\(/g) ?? []).length, 1);
  // From R4P the driver takes only the existing body hash.
  assert.match(text(join(ROOT, DRIVER)), /import \{ authorityBodyHash, type AuthorityRefV1, type JsonObject \} from '\.\/authority\/document\.js';/);
});
check('AJ-AK-AL. Change Mint stays GC1\'s, run creation stays RA1\'s; LD1 holds a registry reader and nothing that creates', () => {
  assert.deepEqual(users(/openChangeMinter|ChangeMinter/, ['src/automation/change-registry.ts']), ['src/intake/goal-change-bridge.ts']);
  assert.deepEqual(users(/\.createRun\(/, ['src/automation/controller.ts']), ['src/automation/root-run-admitter.ts']);
  assert.deepEqual(users(/openChangeRegistryReader\(/, ['src/automation/change-registry.ts']).sort(),
    [DRIVER, 'src/intake/goal-change-bridge.ts', 'src/intake/goal-run-admission-bridge.ts'].sort());
  const driver = code(join(ROOT, DRIVER)), live = code(join(ROOT, LIVE));
  for (const [file, source] of [[DRIVER, driver], [LIVE, live]]) {
    assert.doesNotMatch(source, /createRun|openRootRunAdmitter|root-run-admitter|\.mint\(|new AutomationController|new FileControllerStore|new AutomationRunner/, file);
    assert.doesNotMatch(source, /enterArchitecture|issuePacket|issueCorrection|requestPromotion|beginPromotion|recordPromotedMain|resumeHuman|resumeSoft|resumeArchitecture|\.close\(|\.stop\(|failClosed|\.drive\(/, file);
    assert.doesNotMatch(source, /invocation-journal|egress-journal|model-process|seatbelt|process-executor/, file);
  }
  // Exactly one call into the runner, its one-step entry.
  assert.equal((driver.match(/step\.call\(/g) ?? []).length, 1);
  // The live composition is the one production caller of createLiveAutomation, and nothing composes it yet.
  assert.deepEqual(users(/createLiveAutomation\(/, ['src/automation/live/composition.ts']), [LIVE]);
  assert.equal((code(join(ROOT, LIVE)).match(/createLiveAutomation\(/g) ?? []).length, 1);
  assert.deepEqual(users(/openGovernedExecutionDriver\(/, [DRIVER]), [LIVE]);
  assert.deepEqual(users(/createGovernedLiveExecutionDriver|governed-execution\.js|execution-driver\.js/, [DRIVER, LIVE]), []);
});
check('AM-AN-AO-AP. Workspace imports, routes, UI and events are unchanged: no execution reaches the product', () => {
  const workspace = SRC.filter((path) => rel(path).startsWith('src/workspace/'));
  assert.deepEqual(workspace.filter((path) => /execution-driver|governed-execution|read-model|AutomationRunner|createLiveAutomation/.test(text(path))).map(rel), []);
  assert.deepEqual(SRC.filter((path) => /['"`][^'"`]*\/(execute|step|drive|start)['"`]/.test(text(path))).map(rel), []);
  const server = text(join(ROOT, 'src/workspace/server.ts'));
  assert.doesNotMatch(server, /execut(e|ion)\b.*route|\/execute|\/step|\/drive/);
  const ui = readdirSync(join(ROOT, 'workspace-ui')).filter((name) => name.endsWith('.js') || name.endsWith('.html'))
    .map((name) => readFileSync(join(ROOT, 'workspace-ui', name), 'utf8')).join('\n');
  assert.doesNotMatch(ui, /\/run['"`]\s*,\s*\{\s*method:\s*['"]POST|\/execute|\/step\b|\/drive\b|execution-step|EXECUTION_STEP/);
  assert.doesNotMatch(server + ui, /event:\s*execution|['"]execution[._-](step|started|advanced)['"]/);
  assert.match(text(join(ROOT, 'src/workspace/goal-run-admission-port.ts')), /admit\(/);
  assert.doesNotMatch(text(join(ROOT, 'src/workspace/goal-run-admission-port.ts')), /step|execute|drive/i);
});

let passed = 0, failed = 0;
for (const [name, fn] of tests) {
  const dir = mkdtempSync(join(tmpdir(), 'chief-ld1-'));
  try { await fn(dir); console.log(`  PASS ${name}`); passed++; }
  catch (error) { console.error(`  FAIL ${name}: ${error.stack}`); failed++; }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
