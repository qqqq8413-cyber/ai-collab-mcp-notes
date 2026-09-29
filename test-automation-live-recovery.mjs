import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutomationController } from './dist/automation/controller.js';
import { FileControllerStore } from './dist/automation/durable-store.js';
import { FileInvocationJournal } from './dist/automation/file-invocation-journal.js';
import { InvocationJournalIntegrityError, invocationIdOf, sha256Hex } from './dist/automation/invocation-journal.js';
import { AutomationRunner } from './dist/automation/runner.js';

// The runner with a durable invocation journal, across every crash window: a restart is
// a new controller, store, journal, and runner over the same directories. Ports are
// offline fakes that count their calls and check, at call time, that the journal shows
// their invocation STARTED.

const A = 'a'.repeat(40), B = 'b'.repeat(40);
const T = '2026-09-28T00:00:00.000Z';
const REPO = 'synthetic/example', BRANCH = 'work/synthetic-1';
const clock = { now: () => T };
const G = { id: 'architect', role: 'GPT_ARCHITECT' }, X = { id: 'implementer', role: 'CODEX_IMPLEMENTER' };
const H = { id: 'human', role: 'HUMAN' }, K = { id: 'controller', role: 'CONTROLLER' };
// Each actor has its own packet entry and its own exact egress set; neither sees the other's.
const IMPL_EGRESS = Object.freeze(['api.anthropic.com:443', 'platform.claude.com:443']);
const REVIEW_EGRESS = Object.freeze(['auth.openai.com:443', 'chatgpt.com:443']);
const ALL_EGRESS = Object.freeze([...IMPL_EGRESS, ...REVIEW_EGRESS].sort());
const IMPL = { actorKind: 'IMPLEMENTATION', provider: 'anthropic', model: 'claude-opus-5-5', egressDestinations: [...IMPL_EGRESS] };
const REVIEW = { actorKind: 'ARCHITECT_REVIEW', provider: 'openai', model: 'gpt-5.5-codex', egressDestinations: [...REVIEW_EGRESS] };
const callEntries = (implementation = IMPL, review = REVIEW) => [implementation, review].filter(Boolean).map((entry) => structuredClone(entry));
const TARGET = 'live-provider-model-call';
const tests = [];
const check = (name, fn) => tests.push([name, fn]);
function withDir(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chief-live-recovery-'));
    try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
}
function packet(overrides = {}) {
  return { packetId: 'packet-1', packetVersion: 1, sliceId: 'slice-1', expectedBaseSha: A, targetBranch: BRANCH,
    objective: 'Offline journal fixture', allowedAreas: ['src/automation'], forbiddenChanges: ['src/stress-test'],
    invariants: ['human authority retained'], acceptanceCriteria: ['offline checks pass'],
    validationCommands: [{ commandId: 'test', executable: 'npm', args: ['test'], cwd: '.', classification: 'OFFLINE_VALIDATION' }],
    networkAuthorization: { level: 'WRITE_EXTERNAL', destinations: [BRANCH, ...ALL_EGRESS], purpose: 'fixture', budget: 1 },
    providerCallAuthorization: { allowed: true, calls: callEntries(), maxCalls: 6, budget: 0 },
    destructiveOperationAuthorization: { allowed: false },
    iterationBudget: { maxImplementationIterationsPerSlice: 3, maxAcceptanceFailuresPerSlice: 3, maxRuntimeMinutesPerIteration: 60,
      maxParallelImplementationAgents: 1 }, ...overrides };
}
function grant(scope, overrides = {}) {
  return { authorizationId: `auth-${scope.provider}`, actorRole: 'HUMAN', operation: 'LIVE_PROVIDER_MODEL_CALL', target: TARGET,
    runId: 'run-1', packetId: 'packet-1', scope: { ...scope, egressDestinations: [...scope.egressDestinations] }, issuedAt: T,
    reason: 'fresh exact human grant', ...overrides };
}
const grants = (overrides = {}) => ({ IMPLEMENTATION: grant(IMPL), ARCHITECT_REVIEW: grant(REVIEW), ...overrides });
function reality() {
  return { workSha: B, mainSha: A,
    observeBranch(repository, branch) { return { repository, branch, sha: branch === 'main' ? this.mainSha : this.workSha, observedAt: T }; },
    compare() { throw new Error('not used'); }, observeCi() { throw new Error('not used'); }, observeProtection() { throw new Error('not used'); } };
}
/** Ports that record their calls and prove the journal says STARTED at the moment they run. */
function ports(journalOf, behaviour = {}) {
  const calls = { implementation: [], review: [] };
  const stateAtCall = (input) => journalOf().get(input.invocationId)?.state;
  const implementation = { execute(input) {
    calls.implementation.push([input.invocationId, stateAtCall(input)]);
    return (behaviour.implementation ?? (() => ({ status: 'COMPLETED', validationEvidence: ['npm test: exit 0'] })))(input);
  } };
  const review = { review(input) {
    calls.review.push([input.invocationId, stateAtCall(input)]);
    return (behaviour.review ?? ((i) => ({ decision: { reviewId: 'r1', actor: 'GPT_ARCHITECT', packetId: i.packet.packetId, packetHash: i.packetHash,
      reviewedSha: i.remoteSha.sha, decision: 'ACCEPT', findings: [], evidenceReferences: ['diff'], issuedAt: T } })))(input);
  } };
  return { calls, implementation, review };
}
/** One process's view: controller over a durable store, a journal, and a runner, all over `dir`. */
function open(dir, { authorizations = grants(), behaviour, store, journal: wrapJournal, packetOverrides, create = false } = {}) {
  const base = new FileInvocationJournal(join(dir, 'journal'), clock);
  const journal = wrapJournal ? wrapJournal(base) : base;
  const port = reality();
  const controller = new AutomationController(clock, store ?? new FileControllerStore(join(dir, 'store')), port);
  if (create) {
    controller.createRun('run-1', 'slice-1', REPO);
    controller.enterArchitecture('run-1', G);
    controller.issuePacket('run-1', G, packet(packetOverrides));
  }
  const p = ports(() => base, behaviour);
  const runner = new AutomationRunner(controller, p.implementation, p.review,
    { journal, clock, authorizations, scopes: { IMPLEMENTATION: IMPL, ARCHITECT_REVIEW: REVIEW } });
  return { controller, runner, journal: base, calls: p.calls, reality: port };
}
/** A durable store whose controller writes all fail while armed: the process "dies" at that write. */
function crashingStore(dir) {
  const inner = new FileControllerStore(join(dir, 'store'));
  const store = { armed: false, create: (run) => inner.create(run), get: (id) => inner.get(id), replace: (run) => inner.replace(run),
    entries: (id) => inner.entries(id),
    bindController() { const write = inner.bindController(); return (run) => { if (store.armed) throw new Error('crash during controller write'); write(run); }; } };
  return store;
}
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const actions = (controller) => controller.audit('run-1').map((entry) => entry.action);
const count = (controller, action) => actions(controller).filter((name) => name === action).length;
const implId = (sequence) => invocationIdOf('run-1', sequence, 'IMPLEMENTATION');

check('journaled path: STARTED is durable before each call, stored before it applies, APPLIED after', withDir(async (dir) => {
  const live = open(dir, { create: true });
  const result = await live.runner.drive('run-1', 10);
  assert.deepEqual([result.outcome, result.state], ['HUMAN_PROMOTION_REQUIRED', 'ACCEPTED']);
  assert.equal(live.calls.implementation.length, 1);
  assert.equal(live.calls.review.length, 1);
  assert.deepEqual([live.calls.implementation[0][1], live.calls.review[0][1]], ['STARTED', 'STARTED']);
  const records = live.journal.list('run-1');
  assert.deepEqual(records.map((record) => [record.identity.actorKind, record.history.map((entry) => entry.state).join('>'), record.application?.action]).sort(),
    [['ARCHITECT_REVIEW', 'PREPARED>STARTED>COMPLETED>APPLIED', 'ACCEPT_EXACT_SHA'], ['IMPLEMENTATION', 'PREPARED>STARTED>COMPLETED>APPLIED', 'REPORT_IMPLEMENTATION_COMPLETE']]);
  assert.deepEqual(records.map((record) => record.invocationId).sort(), [live.calls.implementation[0][0], live.calls.review[0][0]].sort());
  assert.deepEqual(records.map((record) => record.identity.authorizationId).sort(), ['auth-anthropic', 'auth-openai']);
}));
check('no exact current human grant, no dispatch: every mismatch stops for a human', withDir(async (dir) => {
  const cases = {
    'no grant': { authorizations: grants({ IMPLEMENTATION: undefined }) },
    'GPT grant': { authorizations: grants({ IMPLEMENTATION: grant(IMPL, { actorRole: 'GPT_ARCHITECT' }) }) },
    'other run': { authorizations: grants({ IMPLEMENTATION: grant(IMPL, { runId: 'run-2' }) }) },
    'other packet': { authorizations: grants({ IMPLEMENTATION: grant(IMPL, { packetId: 'packet-2' }) }) },
    'provider mismatch': { authorizations: grants({ IMPLEMENTATION: grant({ ...IMPL, provider: 'other' }) }) },
    'model mismatch': { authorizations: grants({ IMPLEMENTATION: grant({ ...IMPL, model: 'claude-other-1' }) }) },
    'egress set missing one': { authorizations: grants({ IMPLEMENTATION: grant({ ...IMPL, egressDestinations: ['api.anthropic.com:443'] }) }) },
    'egress set with one extra': { authorizations: grants({ IMPLEMENTATION: grant({ ...IMPL, egressDestinations: [...IMPL_EGRESS, 'statsig.anthropic.com:443'] }) }) },
    'egress wrong port': { authorizations: grants({ IMPLEMENTATION: grant({ ...IMPL, egressDestinations: ['api.anthropic.com:8443', 'platform.claude.com:443'] }) }) },
    'review grant supplied to implementation': { authorizations: grants({ IMPLEMENTATION: grant(REVIEW) }) },
    'grant naming the other actor kind': { authorizations: grants({ IMPLEMENTATION: grant({ ...IMPL, actorKind: 'ARCHITECT_REVIEW' }) }) },
    'grant without an actor kind': { authorizations: grants({ IMPLEMENTATION: grant(IMPL, { scope: { provider: IMPL.provider, model: IMPL.model, egressDestinations: [...IMPL_EGRESS] } }) }) },
    'union grant': { authorizations: grants({ IMPLEMENTATION: grant({ ...IMPL, egressDestinations: [...ALL_EGRESS] }) }) },
    'both grants swapped': { authorizations: { IMPLEMENTATION: grant(REVIEW), ARCHITECT_REVIEW: grant(IMPL) } },
    'host as target': { authorizations: grants({ IMPLEMENTATION: grant(IMPL, { target: 'api.anthropic.com:443' }) }) },
    'single-destination grant': { authorizations: grants({ IMPLEMENTATION: grant(IMPL, { scope: { actorKind: IMPL.actorKind, provider: IMPL.provider, model: IMPL.model, destination: 'api.anthropic.com' } }) }) },
    'unscoped grant': { authorizations: grants({ IMPLEMENTATION: grant(IMPL, { scope: undefined }) }) },
    'expired grant': { authorizations: grants({ IMPLEMENTATION: grant(IMPL, { issuedAt: '2026-09-27T00:00:00.000Z', expiresAt: '2026-09-27T23:59:59.000Z' }) }) },
    'future grant': { authorizations: grants({ IMPLEMENTATION: grant(IMPL, { issuedAt: '2026-09-28T00:00:01.000Z' }) }) },
    'wrong operation': { authorizations: grants({ IMPLEMENTATION: grant(IMPL, { operation: 'FAST_FORWARD_MAIN' }) }) },
    'packet entry names another provider': { packetOverrides: { providerCallAuthorization: { allowed: true, calls: callEntries({ ...IMPL, provider: 'anthropic-other' }), maxCalls: 6, budget: 0 } } },
    'packet entry names another model': { packetOverrides: { providerCallAuthorization: { allowed: true, calls: callEntries({ ...IMPL, model: 'claude-other-1' }), maxCalls: 6, budget: 0 } } },
    'packet egress set differs': { packetOverrides: { providerCallAuthorization: { allowed: true,
      calls: callEntries({ ...IMPL, egressDestinations: [...IMPL_EGRESS, 'statsig.anthropic.com:443'] }), maxCalls: 6, budget: 0 },
      networkAuthorization: { level: 'WRITE_EXTERNAL', destinations: [BRANCH, ...ALL_EGRESS, 'statsig.anthropic.com:443'], purpose: 'f', budget: 1 } } },
    'packet entry holds the union': { packetOverrides: { providerCallAuthorization: { allowed: true,
      calls: callEntries({ ...IMPL, egressDestinations: [...ALL_EGRESS] }), maxCalls: 6, budget: 0 } } },
    'packet has no implementation entry': { packetOverrides: { providerCallAuthorization: { allowed: true, calls: callEntries(null), maxCalls: 6, budget: 0 } } },
    'packet denies calls': { packetOverrides: { providerCallAuthorization: { allowed: false, calls: [], maxCalls: 0, budget: 0 } } },
    'destination outside packet': { packetOverrides: { networkAuthorization: { level: 'WRITE_EXTERNAL', destinations: [BRANCH, 'api.anthropic.com:443', ...REVIEW_EGRESS], purpose: 'f', budget: 1 } } },
    'network level too low': { packetOverrides: { networkAuthorization: { level: 'READ_WEB', destinations: [BRANCH, ...ALL_EGRESS], purpose: 'f', budget: 1 } } },
  };
  for (const [label, options] of Object.entries(cases)) {
    const live = open(join(dir, label.replace(/\W/g, '-')), { create: true, ...options });
    const result = await live.runner.drive('run-1', 5);
    assert.deepEqual([result.state, result.stopReason], ['HUMAN_STOP', 'live model call not authorized by an exact current human grant; not dispatched'], label);
    assert.equal(live.calls.implementation.length, 0, label);
    assert.ok(live.journal.list('run-1').every((record) => record.state === 'ABANDONED' &&
      !record.history.some((entry) => entry.state === 'STARTED')), label);
  }
}));
check('the call budget counts every started call across the run, and exhaustion stops before dispatch', withDir(async (dir) => {
  const live = open(dir, { create: true, packetOverrides: { providerCallAuthorization: { allowed: true, calls: callEntries(), maxCalls: 1, budget: 0 } } });
  const result = await live.runner.drive('run-1', 10);
  assert.deepEqual([result.state, result.stopReason], ['HUMAN_STOP', 'live model call budget exhausted; not dispatched']);
  assert.deepEqual([live.calls.implementation.length, live.calls.review.length], [1, 0]);
  assert.deepEqual(live.journal.list('run-1').map((record) => [record.identity.actorKind, record.state]).sort(),
    [['ARCHITECT_REVIEW', 'ABANDONED'], ['IMPLEMENTATION', 'APPLIED']]);
}));
check('crash after entering, before PREPARED: a new runner does not infer that no call happened', withDir(async (dir) => {
  const first = open(dir, { create: true });
  first.controller.beginImplementation('run-1', X);
  const restarted = open(dir);
  const result = await restarted.runner.step('run-1');
  assert.deepEqual([result.state, result.stopReason], ['HUMAN_STOP', 'uncertain implementation-agent side effect after runner restart; not replayed']);
  assert.deepEqual([restarted.calls.implementation.length, restarted.journal.list('run-1').length], [0, 0]);
}));
check('crash after PREPARED, before STARTED: a new runner dispatches exactly once', withDir(async (dir) => {
  const first = open(dir, { create: true });
  await first.runner.step('run-1');
  assert.equal(first.journal.find('run-1', 3, 'IMPLEMENTATION').state, 'PREPARED');
  const restarted = open(dir);
  assert.equal((await restarted.runner.step('run-1')).state, 'IMPLEMENTATION_COMPLETE');
  assert.deepEqual([first.calls.implementation.length, restarted.calls.implementation.length], [0, 1]);
  assert.equal(restarted.journal.find('run-1', 3, 'IMPLEMENTATION').state, 'APPLIED');
  const third = open(dir);
  await third.runner.drive('run-1', 2);
  assert.equal(third.calls.implementation.length, 0);
}));
check('crash after STARTED, before the process ran: a new runner stops for a human and never replays', withDir(async (dir) => {
  const first = open(dir, { create: true });
  await first.runner.step('run-1');
  first.journal.start(implId(3), 6);
  const restarted = open(dir);
  const result = await restarted.runner.step('run-1');
  assert.deepEqual([result.state, result.stopReason], ['HUMAN_STOP', 'uncertain implementation-agent side effect after runner restart; not replayed']);
  assert.deepEqual([first.calls.implementation.length, restarted.calls.implementation.length], [0, 0]);
  assert.equal(restarted.journal.get(implId(3)).state, 'UNCERTAIN');
  await restarted.runner.drive('run-1', 3);
  assert.equal(restarted.calls.implementation.length, 0);
}));
check('crash after the process returned, before COMPLETED: no replay, and the late result is discarded', withDir(async (dir) => {
  const pending = deferred();
  const first = open(dir, { create: true, behaviour: { implementation: () => pending.promise } });
  await first.runner.step('run-1');
  const inFlight = first.runner.step('run-1');
  const restarted = open(dir);
  assert.equal((await restarted.runner.step('run-1')).state, 'HUMAN_STOP');
  assert.equal(restarted.calls.implementation.length, 0);
  pending.resolve({ status: 'COMPLETED', validationEvidence: ['late'] });
  assert.equal((await inFlight).outcome, 'ACTOR_RESULT_DISCARDED');
  assert.equal(first.calls.implementation.length, 1);
  assert.equal(count(restarted.controller, 'REPORT_IMPLEMENTATION_COMPLETE'), 0);
  assert.equal(restarted.journal.get(implId(3)).state, 'UNCERTAIN');
}));
check('crash after COMPLETED, before applying: the stored result is applied once without another call', withDir(async (dir) => {
  const store = crashingStore(dir);
  const first = open(dir, { create: true, store });
  await first.runner.step('run-1');
  store.armed = true;
  await assert.rejects(first.runner.step('run-1'), /crash during controller write/);
  assert.equal(first.journal.get(implId(3)).state, 'COMPLETED');
  const restarted = open(dir);
  assert.equal((await restarted.runner.step('run-1')).state, 'IMPLEMENTATION_COMPLETE');
  assert.deepEqual([first.calls.implementation.length, restarted.calls.implementation.length], [1, 0]);
  assert.equal(count(restarted.controller, 'REPORT_IMPLEMENTATION_COMPLETE'), 1);
  assert.equal(restarted.journal.get(implId(3)).state, 'APPLIED');
}));
check('crash after COMPLETED review, before applying: the stored review is applied without another review', withDir(async (dir) => {
  const store = crashingStore(dir);
  const first = open(dir, { create: true, store });
  await first.runner.drive('run-1', 4);
  store.armed = true;
  await assert.rejects(first.runner.step('run-1'), /crash/);
  const reviewId = invocationIdOf('run-1', first.controller.audit('run-1').at(-1).sequence, 'ARCHITECT_REVIEW');
  assert.equal(first.journal.get(reviewId).state, 'COMPLETED');
  const restarted = open(dir);
  const result = await restarted.runner.step('run-1');
  assert.deepEqual([result.outcome, result.state], ['HUMAN_PROMOTION_REQUIRED', 'ACCEPTED']);
  assert.deepEqual([first.calls.review.length, restarted.calls.review.length], [1, 0]);
  assert.equal(count(restarted.controller, 'ACCEPT_EXACT_SHA'), 1);
  assert.equal(restarted.journal.get(reviewId).state, 'APPLIED');
}));
check('crash after the controller applied, before APPLIED: the next runner settles it without a second call or transition', withDir(async (dir) => {
  let armed = false;
  const failApplied = (journal) => new Proxy(journal, { get(target, name) {
    const value = Reflect.get(target, name);
    if (name === 'markApplied') return (...args) => { if (armed) throw new Error('crash before APPLIED'); return value.apply(target, args); };
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const first = open(dir, { create: true, journal: failApplied });
  await first.runner.step('run-1');
  armed = true;
  await assert.rejects(first.runner.step('run-1'), /crash before APPLIED/);
  assert.equal(first.controller.get('run-1').state, 'IMPLEMENTATION_COMPLETE');
  assert.equal(first.journal.get(implId(3)).state, 'COMPLETED');
  const restarted = open(dir);
  assert.equal((await restarted.runner.step('run-1')).state, 'REMOTE_SHA_READY');
  assert.deepEqual([first.calls.implementation.length, restarted.calls.implementation.length], [1, 0]);
  assert.equal(count(restarted.controller, 'REPORT_IMPLEMENTATION_COMPLETE'), 1);
  const settled = restarted.journal.get(implId(3));
  assert.deepEqual([settled.state, settled.application], ['APPLIED', { sequence: 4, action: 'REPORT_IMPLEMENTATION_COMPLETE' }]);
}));
check('COMPLETED for an occurrence the run has left is abandoned, never applied, and nothing is called', withDir(async (dir) => {
  const store = crashingStore(dir);
  const first = open(dir, { create: true, store });
  await first.runner.step('run-1');
  store.armed = true;
  await assert.rejects(first.runner.step('run-1'));
  const other = open(dir);
  other.controller.stop('run-1', K, 'HUMAN_STOP', 'interrupted');
  other.controller.resumeHuman('run-1', H, { authorizationId: 'resume-1', actorRole: 'HUMAN', operation: 'RESUME_HUMAN_STOP',
    target: other.controller.get('run-1').stopId, runId: 'run-1', packetId: 'packet-1', issuedAt: T, reason: 'resume' });
  other.controller.reconcile('run-1', K);
  const restarted = open(dir);
  const result = await restarted.runner.step('run-1');
  assert.equal(result.state, 'HUMAN_STOP');
  assert.equal(restarted.journal.get(implId(3)).state, 'ABANDONED');
  assert.equal(count(restarted.controller, 'REPORT_IMPLEMENTATION_COMPLETE'), 0);
  assert.equal(first.calls.implementation.length + restarted.calls.implementation.length, 1);
}));
check('a result whose occurrence moved during the call is abandoned, never applied to the new occurrence', withDir(async (dir) => {
  const pending = deferred();
  const live = open(dir, { create: true, behaviour: { implementation: () => pending.promise } });
  await live.runner.step('run-1');
  const inFlight = live.runner.step('run-1');
  live.controller.stop('run-1', K, 'HUMAN_STOP', 'interrupted');
  live.controller.resumeHuman('run-1', H, { authorizationId: 'resume-1', actorRole: 'HUMAN', operation: 'RESUME_HUMAN_STOP',
    target: live.controller.get('run-1').stopId, runId: 'run-1', packetId: 'packet-1', issuedAt: T, reason: 'resume' });
  live.controller.reconcile('run-1', K);
  pending.resolve({ status: 'COMPLETED', validationEvidence: ['late'] });
  assert.equal((await inFlight).outcome, 'ACTOR_RESULT_DISCARDED');
  assert.equal(live.controller.get('run-1').state, 'IMPLEMENTING');
  assert.equal(count(live.controller, 'REPORT_IMPLEMENTATION_COMPLETE'), 0);
  assert.equal(live.journal.get(implId(3)).state, 'ABANDONED');
}));
check('a corrupt journal or a tampered stored result fails closed: no call, no controller write', withDir(async (dir) => {
  const corrupt = open(join(dir, 'corrupt'), { create: true });
  await corrupt.runner.step('run-1');
  const file = join(dir, 'corrupt', 'journal', `${implId(3)}.json`);
  writeFileSync(file, readFileSync(file, 'utf8').replace('PREPARED', 'STARTED'));
  const length = corrupt.controller.audit('run-1').length;
  await assert.rejects(open(join(dir, 'corrupt')).runner.step('run-1'), InvocationJournalIntegrityError);
  assert.equal(corrupt.controller.audit('run-1').length, length);
  assert.equal(corrupt.calls.implementation.length, 0);

  const store = crashingStore(join(dir, 'tamper'));
  const tampered = open(join(dir, 'tamper'), { create: true, store });
  await tampered.runner.step('run-1');
  store.armed = true;
  await assert.rejects(tampered.runner.step('run-1'));
  const recordFile = join(dir, 'tamper', 'journal', `${implId(3)}.json`);
  const envelope = JSON.parse(readFileSync(recordFile, 'utf8'));
  envelope.record.result.serialized = envelope.record.result.serialized.replace('exit 0', 'exit 1');
  envelope.checksum = sha256Hex(JSON.stringify(envelope.record));
  writeFileSync(recordFile, JSON.stringify(envelope));
  const restarted = open(join(dir, 'tamper'));
  const before = restarted.controller.audit('run-1').length;
  await assert.rejects(restarted.runner.step('run-1'), /digest/);
  assert.deepEqual([restarted.controller.audit('run-1').length, restarted.calls.implementation.length], [before, 0]);
}));
check('two runners, one invocation: the one that did not start it never dispatches', withDir(async (dir) => {
  const pending = deferred();
  const first = open(dir, { create: true, behaviour: { implementation: () => pending.promise } });
  await first.runner.step('run-1');
  const inFlight = first.runner.step('run-1');
  const second = open(dir);
  assert.equal((await second.runner.step('run-1')).state, 'HUMAN_STOP');
  pending.resolve({ status: 'COMPLETED', validationEvidence: ['late'] });
  assert.equal((await inFlight).outcome, 'ACTOR_RESULT_DISCARDED');
  assert.deepEqual([first.calls.implementation.length, second.calls.implementation.length], [1, 0]);

  const racing = open(join(dir, 'race'), { create: true });
  await racing.runner.step('run-1');
  const winner = new FileInvocationJournal(join(dir, 'race', 'journal'), clock);
  const loser = open(join(dir, 'race'), { journal: (journal) => new Proxy(journal, { get(target, name) {
    const value = Reflect.get(target, name);
    if (name === 'start') return (...args) => { winner.start(...args); return value.apply(target, args); };
    return typeof value === 'function' ? value.bind(target) : value;
  } }) });
  const lost = await loser.runner.step('run-1');
  assert.deepEqual([lost.outcome, lost.state], ['INVOCATION_CLAIMED', 'IMPLEMENTING']);
  assert.equal(loser.calls.implementation.length, 0);
  assert.equal(loser.journal.get(implId(3)).history.filter((entry) => entry.state === 'STARTED').length, 1);
}));
check('a resumed occurrence has no invocation of its own: nothing is prepared or dispatched', withDir(async (dir) => {
  const live = open(dir, { create: true });
  await live.runner.step('run-1');
  live.controller.stop('run-1', K, 'SOFT_STOP', 'repair');
  live.controller.resumeSoft('run-1', K, 'repaired');
  const restarted = open(dir);
  assert.equal((await restarted.runner.step('run-1')).state, 'HUMAN_STOP');
  assert.equal(restarted.calls.implementation.length, 0);
  assert.equal(restarted.journal.list('run-1').length, 1);
  assert.equal(restarted.journal.get(implId(3)).state, 'ABANDONED');
}));

check('the runner snapshots each actor scope as an exact canonical egress set and refuses anything else at composition', withDir(async (dir) => {
  const base = open(dir, { create: true });
  const make = (scopes) => new AutomationRunner(base.controller, { execute() { throw new Error('ran'); } }, { review() { throw new Error('ran'); } },
    { journal: base.journal, clock, authorizations: grants(), scopes });
  for (const bad of [{ ...IMPL, egressDestinations: [...IMPL_EGRESS].reverse() }, { ...IMPL, egressDestinations: [] }, { ...IMPL, egressDestinations: ['anthropic'] },
    { ...IMPL, egressDestinations: undefined, destination: 'api.anthropic.com' }, { ...IMPL, egressDestinations: ['api.anthropic.com:443', 'api.anthropic.com:443'] }]) {
    assert.throws(() => make({ IMPLEMENTATION: bad, ARCHITECT_REVIEW: REVIEW }), TypeError, JSON.stringify(bad.egressDestinations));
  }
  // A scope changed after composition is not the scope that was composed: the call still binds the original set.
  const scopes = { IMPLEMENTATION: { ...IMPL, egressDestinations: [...IMPL_EGRESS] }, ARCHITECT_REVIEW: REVIEW };
  const runner = new AutomationRunner(base.controller, { execute: () => ({ status: 'COMPLETED', validationEvidence: ['x'] }) },
    { review() { throw new Error('not reached'); } }, { journal: base.journal, clock, authorizations: grants(), scopes });
  scopes.IMPLEMENTATION.egressDestinations.push('statsig.anthropic.com:443');
  const result = await runner.drive('run-1', 2);
  assert.equal(result.state, 'IMPLEMENTATION_COMPLETE');
  assert.deepEqual(base.journal.list('run-1').map((record) => [record.state, record.identity.egressDestinations]), [['APPLIED', [...IMPL_EGRESS]]]);
}));

check('C1: a scope that does not bind its own actor kind fails composition', withDir(async (dir) => {
  const base = open(dir, { create: true });
  const make = (scopes) => new AutomationRunner(base.controller, { execute() { throw new Error('ran'); } }, { review() { throw new Error('ran'); } },
    { journal: base.journal, clock, authorizations: grants(), scopes });
  const { actorKind: _omitted, ...noKind } = IMPL;
  for (const [scopes, name] of [[{ IMPLEMENTATION: REVIEW, ARCHITECT_REVIEW: IMPL }, 'both swapped'],
    [{ IMPLEMENTATION: { ...IMPL, actorKind: 'ARCHITECT_REVIEW' }, ARCHITECT_REVIEW: REVIEW }, 'implementation names review'],
    [{ IMPLEMENTATION: IMPL, ARCHITECT_REVIEW: { ...REVIEW, actorKind: 'IMPLEMENTATION' } }, 'review names implementation'],
    [{ IMPLEMENTATION: noKind, ARCHITECT_REVIEW: REVIEW }, 'no actor kind'],
    [{ IMPLEMENTATION: { ...IMPL, actorKind: 'implementation' }, ARCHITECT_REVIEW: REVIEW }, 'unknown actor kind']]) {
    assert.throws(() => make(scopes), TypeError, name);
  }
  assert.equal(base.journal.list('run-1').length, 0);
}));
check('C1: a review dispatched with the implementation grant is refused; implementation ran on its own grant only', withDir(async (dir) => {
  const live = open(dir, { create: true, authorizations: grants({ ARCHITECT_REVIEW: grant(IMPL) }) });
  const result = await live.runner.drive('run-1', 10);
  assert.deepEqual([result.state, result.stopReason], ['HUMAN_STOP', 'live model call not authorized by an exact current human grant; not dispatched']);
  assert.deepEqual([live.calls.implementation.length, live.calls.review.length], [1, 0]);
  assert.deepEqual(live.journal.list('run-1').map((record) => [record.identity.actorKind, record.state, record.identity.egressDestinations]).sort(),
    [['ARCHITECT_REVIEW', 'ABANDONED', [...REVIEW_EGRESS]], ['IMPLEMENTATION', 'APPLIED', [...IMPL_EGRESS]]]);
}));
check('C1: each journaled call carries only its own actor\'s exact scope', withDir(async (dir) => {
  const live = open(dir, { create: true });
  const result = await live.runner.drive('run-1', 10);
  assert.equal(result.state, 'ACCEPTED');
  const byKind = Object.fromEntries(live.journal.list('run-1').map((record) => [record.identity.actorKind, record.identity]));
  assert.deepEqual([byKind.IMPLEMENTATION.provider, byKind.IMPLEMENTATION.model, byKind.IMPLEMENTATION.egressDestinations],
    [IMPL.provider, IMPL.model, [...IMPL_EGRESS]]);
  assert.deepEqual([byKind.ARCHITECT_REVIEW.provider, byKind.ARCHITECT_REVIEW.model, byKind.ARCHITECT_REVIEW.egressDestinations],
    [REVIEW.provider, REVIEW.model, [...REVIEW_EGRESS]]);
}));
check('C1: the call budget stays packet-wide; switching actor kind does not reset it', withDir(async (dir) => {
  const rejectWithCorrection = (i) => ({
    decision: { reviewId: 'r1', actor: 'GPT_ARCHITECT', packetId: i.packet.packetId, packetHash: i.packetHash, reviewedSha: i.remoteSha.sha,
      decision: 'REJECT', findings: ['synthetic finding'], evidenceReferences: ['diff'], issuedAt: T },
    correction: { correctionPacketId: 'correction-2', originalPacketId: i.packet.packetId, originalPacketHash: i.packetHash,
      rejectedSha: i.remoteSha.sha, reviewerFindings: ['synthetic finding'], allowedCorrectionAreas: ['src/automation'],
      unchangedInvariantReferences: [...i.packet.invariants], expectedBaseSha: i.remoteSha.sha, correctionIteration: 2, maxCorrectionIteration: 3 } });
  const live = open(dir, { create: true, behaviour: { review: rejectWithCorrection },
    packetOverrides: { providerCallAuthorization: { allowed: true, calls: callEntries(), maxCalls: 2, budget: 0 } } });
  const result = await live.runner.drive('run-1', 20);
  assert.deepEqual([result.state, result.stopReason], ['HUMAN_STOP', 'live model call budget exhausted; not dispatched']);
  assert.deepEqual([live.calls.implementation.length, live.calls.review.length], [1, 1]);
  const records = live.journal.list('run-1');
  assert.deepEqual(records.map((record) => [record.identity.actorKind, record.state]).sort(),
    [['ARCHITECT_REVIEW', 'APPLIED'], ['IMPLEMENTATION', 'ABANDONED'], ['IMPLEMENTATION', 'APPLIED']]);
  assert.equal(records.filter((record) => record.history.some((entry) => entry.state === 'STARTED')).length, 2);
}));

let passed = 0, failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`  PASS ${name}`); passed++; }
  catch (error) { console.error(`  FAIL ${name}: ${error.stack}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
