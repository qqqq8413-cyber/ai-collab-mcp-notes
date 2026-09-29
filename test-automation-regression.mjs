// G1-R1 acceptance-repair regressions: adversarial, offline, synthetic data only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AutomationController } from './dist/automation/controller.js';
import { InMemoryControllerStore } from './dist/automation/audit.js';
import { isCanonicalEgressDestination, isCanonicalEgressSet, sameEgressSet } from './dist/automation/egress-destination.js';
import { parsePacket, tryParsePacket } from './dist/automation/packet.js';
import {
  LIVE_PROVIDER_MODEL_CALL_TARGET, authorizeLiveModelCall, evaluatePolicy, OPERATION_POLICY, parseAuthorization,
} from './dist/automation/policy.js';
import { parseInstant } from './dist/automation/time.js';
import { NETWORK_LEVELS, ROLES, STATES, STOP_CLASSES } from './dist/automation/types.js';

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const T = '2026-09-26T00:00:00.000Z';
const G = { id: 'architect', role: 'GPT_ARCHITECT' };
const X = { id: 'implementer', role: 'CODEX_IMPLEMENTER' };
const H = { id: 'human', role: 'HUMAN' };
const K = { id: 'controller', role: 'CONTROLLER' };
const GH = { id: 'github', role: 'GITHUB' };
const ACTORS = [G, X, H, K, GH];
const repo = 'synthetic/example';
const DEST = 'api.synthetic-provider.test:443';
const AUTH_DEST = 'auth.synthetic-provider.test:443';
const EGRESS = Object.freeze([DEST, AUTH_DEST]);
const TARGET = 'live-provider-model-call';
const realities = new WeakMap();
function fakeReality() {
  return { workSha: B, mainSha: A, workBranch: 'work/synthetic-1', observedAt: T,
    aheadBy: 1, behindBy: 0, hasBaseOnlyCommits: false, workCi: 'SUCCESS', mainCi: 'SUCCESS',
    workCheck: 'SUCCESS', mainCheck: 'SUCCESS', protected: true,
    observeBranch(repository, branch) { return { repository, branch: branch === 'main' ? branch : this.workBranch,
      sha: branch === 'main' ? this.mainSha : this.workSha, observedAt: this.observedAt }; },
    compare(repository, baseSha, headSha) { return { repository, baseSha, headSha, aheadBy: this.aheadBy,
      behindBy: this.behindBy, hasBaseOnlyCommits: this.hasBaseOnlyCommits, observedAt: this.observedAt }; },
    observeCi(repository, branch, sha) { return { repository, branch, sha,
      workflowStatus: branch === 'main' ? this.mainCi : this.workCi, requiredCheckName: 'test',
      requiredCheckStatus: branch === 'main' ? this.mainCheck : this.workCheck, observedAt: this.observedAt }; },
    observeProtection(repository, branch) { return { repository, branch, protected: this.protected,
      requiredChecks: ['test'], observedAt: this.observedAt }; },
  };
}
const realityOf = (c) => realities.get(c);
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS ${name}`); passed++; }
  catch (error) { console.error(`  FAIL ${name}: ${error.stack}`); failed++; }
}
const NPM_TEST = { commandId: 'npm-test', executable: 'npm', args: ['test'], cwd: '.', classification: 'OFFLINE_VALIDATION' };
const DIFF_CHECK = { commandId: 'diff-check', executable: 'git', args: ['diff', '--check'], cwd: '.', classification: 'OFFLINE_VALIDATION' };
const CI_STATUS = { commandId: 'ci-status', executable: 'gh', args: ['run', 'view'], cwd: '.', classification: 'EXTERNAL_EFFECT' };
function packet(overrides = {}) {
  return {
    packetId: 'packet-1', packetVersion: 1, sliceId: 'slice-1', expectedBaseSha: A,
    targetBranch: 'work/synthetic-1', objective: 'Implement an offline test fixture',
    allowedAreas: ['src/automation'], forbiddenChanges: ['src/stress-test'],
    invariants: ['human authority retained'], acceptanceCriteria: ['offline checks pass'],
    validationCommands: [NPM_TEST, DIFF_CHECK, CI_STATUS],
    networkAuthorization: { level: 'WRITE_EXTERNAL', destinations: ['work/synthetic-1', 'main', DEST], purpose: 'synthetic GitHub facts', budget: 1 },
    providerCallAuthorization: { allowed: false, calls: [], maxCalls: 0, budget: 0 },
    destructiveOperationAuthorization: { allowed: false },
    iterationBudget: { maxImplementationIterationsPerSlice: 3, maxAcceptanceFailuresPerSlice: 3,
      maxRuntimeMinutesPerIteration: 60, maxParallelImplementationAgents: 1 },
    ...overrides,
  };
}
/** One packet call entry for the implementation actor, fresh each time. */
function implCall(overrides = {}) {
  return { actorKind: 'IMPLEMENTATION', provider: 'provider-a', model: 'model-a', egressDestinations: [...EGRESS], ...overrides };
}
function providerPacket(overrides = {}) {
  return packet({
    networkAuthorization: { level: 'READ_EXTERNAL_API', destinations: [...EGRESS], purpose: 'synthetic model call', budget: 1 },
    providerCallAuthorization: { allowed: true, calls: [implCall()], maxCalls: 1, budget: 1 },
    ...overrides,
  });
}
function auth(role, operation, target, overrides = {}) {
  return { authorizationId: `auth-${operation}-${target}`, actorRole: role, operation, target,
    runId: 'run-1', packetId: 'packet-1', issuedAt: T, reason: 'synthetic authorization', ...overrides };
}
function movableClock(iso = T) { return { value: iso, now() { return this.value; } }; }
function make(initialPacket = packet(), clock = movableClock()) {
  const store = new InMemoryControllerStore();
  const reality = fakeReality();
  const c = new AutomationController(clock, store, reality); realities.set(c, reality);
  c.createRun('run-1', 'slice-1', repo);
  c.enterArchitecture('run-1', G);
  c.issuePacket('run-1', G, initialPacket);
  return { c, store, clock, reality };
}
function remote(sha = B, branch = 'work/synthetic-1') {
  return { repository: repo, branch, sha, observedAt: T, source: 'GITHUB' };
}
function ready(c, sha = B) {
  realityOf(c).workSha = sha;
  c.beginImplementation('run-1', X);
  c.completeImplementation('run-1', X, ['offline test result']);
  c.recordRemoteSha('run-1', X);
  c.beginAcceptanceReview('run-1', G);
}
function decision(c, result = 'ACCEPT', sha = B) {
  return { reviewId: 'review-1', actor: 'GPT_ARCHITECT', packetId: 'packet-1',
    packetHash: c.get('run-1').activePacketHash, reviewedSha: sha,
    decision: result, findings: result === 'REJECT' ? ['synthetic finding'] : [],
    evidenceReferences: ['remote diff', 'CI'], issuedAt: T };
}
function preflight(overrides = {}) {
  return { expectedMainSha: A, observedMainSha: A, acceptedSha: B, aheadBy: 1, behindBy: 0,
    hasMainOnlyCommits: false, acceptedShaCiPassed: true, requiredCheckPassed: true,
    mainProtected: true, ...overrides };
}
function record(c, evidence = remote()) {
  const reality = realityOf(c);
  reality.workSha = evidence.sha; reality.workBranch = evidence.branch; reality.observedAt = evidence.observedAt;
  return c.recordRemoteSha('run-1', X);
}
function promote(c, facts, grant) {
  const reality = realityOf(c);
  reality.mainSha = facts.observedMainSha; reality.aheadBy = facts.aheadBy; reality.behindBy = facts.behindBy;
  reality.hasBaseOnlyCommits = facts.hasMainOnlyCommits;
  reality.workCi = facts.acceptedShaCiPassed ? 'SUCCESS' : 'FAILURE';
  reality.workCheck = facts.requiredCheckPassed ? 'SUCCESS' : 'FAILURE';
  reality.protected = facts.mainProtected;
  return c.requestPromotion('run-1', H, grant);
}
function recordMain(c, evidence = remote(B, 'main')) {
  realityOf(c).mainSha = evidence.sha;
  return c.recordPromotedMain('run-1', K);
}
function close(c, facts) {
  const reality = realityOf(c);
  reality.mainSha = facts.observedMainSha;
  reality.mainCi = facts.mainCiPassed ? 'SUCCESS' : 'FAILURE';
  reality.mainCheck = facts.requiredCheckPassed ? 'SUCCESS' : 'FAILURE';
  reality.protected = facts.mainProtected;
  return c.close('run-1', K);
}
function snapshot(c) { return JSON.stringify({ run: c.get('run-1'), audit: c.audit('run-1') }); }
function rejectedWithoutMutation(c, fn) {
  const before = snapshot(c);
  assert.throws(fn);
  assert.equal(snapshot(c), before);
}
function request(overrides = {}) {
  return { operation: 'RUN_OFFLINE_VALIDATION', target: 'npm-test', actor: X, packet: packet(),
    runId: 'run-1', now: T, command: { executable: 'npm', args: ['test'], cwd: '.' }, ...overrides };
}
function modelCall(overrides = {}, authOverrides = {}) {
  const scope = { actorKind: 'IMPLEMENTATION', provider: 'provider-a', model: 'model-a', egressDestinations: [...EGRESS] };
  return { operation: 'LIVE_PROVIDER_MODEL_CALL', target: TARGET, actor: H, packet: providerPacket(),
    runId: 'run-1', now: T, providerCall: scope,
    authorization: auth('HUMAN', 'LIVE_PROVIDER_MODEL_CALL', TARGET, { scope, ...authOverrides }), ...overrides };
}
const decide = (req) => evaluatePolicy(req).decision;

// ---------------------------------------------------------------- F01
console.log('F01 stop API runtime escape');
const INVALID_STOPS = ['ACCEPTED', 'CLOSED', 'PROMOTION_READY', 'FAILED_CLOSED', 'IMPLEMENTING', 'arbitrary',
  'soft_stop', ' SOFT_STOP', '', undefined, null, 0, {}, ['HUMAN_STOP'], { toString: () => 'HUMAN_STOP' }];
check('stop refuses every non-stop-class value, from every reachable pre-acceptance state', () => {
  for (const setup of [(c) => c, (c) => c.beginImplementation('run-1', X), (c) => ready(c)]) {
    for (const value of INVALID_STOPS) {
      const { c } = make(); setup(c);
      rejectedWithoutMutation(c, () => c.stop('run-1', K, value, 'reason'));
      assert.notEqual(c.get('run-1').state, 'ACCEPTED');
    }
  }
});
check('stop ACCEPTED from ACCEPTANCE_REVIEW leaves store, audit, counters, and interruptedState unchanged', () => {
  const { c, store } = make(); ready(c);
  const before = JSON.stringify(store.get('run-1'));
  assert.throws(() => c.stop('run-1', K, 'ACCEPTED', 'escape'));
  assert.throws(() => c.stop('run-1', G, 'CLOSED', 'escape'));
  assert.equal(JSON.stringify(store.get('run-1')), before);
  const run = c.get('run-1');
  assert.equal(run.state, 'ACCEPTANCE_REVIEW'); assert.equal(run.interruptedState, undefined);
  assert.equal(run.implementationIterations, 1); assert.equal(run.acceptanceFailures, 0);
});
check('the three stop classes still work and record a stop occurrence id', () => {
  for (const kind of STOP_CLASSES) {
    const { c } = make(); const run = c.stop('run-1', K, kind, 'synthetic');
    assert.equal(run.state, kind); assert.equal(run.interruptedState, 'PACKET_READY');
    assert.equal(run.stopId, `stop-${run.audit.length}`); assert.equal(run.audit.at(-1).stopId, run.stopId);
  }
});
check('stop refuses malformed actors and reasons without mutation', () => {
  const { c } = make();
  for (const actor of [null, undefined, 'CONTROLLER', { role: 'CONTROLLER' }, { id: '', role: 'CONTROLLER' },
    { id: 'x', role: 'ROOT' }, { id: 'x', role: 'CONTROLLER', extra: true }, { id: 7, role: 'CONTROLLER' }, X, GH]) {
    rejectedWithoutMutation(c, () => c.stop('run-1', actor, 'SOFT_STOP', 'reason'));
  }
  for (const reason of ['', '   ', undefined, null, 5]) rejectedWithoutMutation(c, () => c.stop('run-1', K, 'SOFT_STOP', reason));
});

// ---------------------------------------------------------------- cross-entry: ACCEPTED
console.log('Cross-entry: only GPT acceptance creates ACCEPTED');
const STOP_ESCAPES = [...INVALID_STOPS, ...STOP_CLASSES];
function attempts(c) {
  const id = 'run-1';
  const hostile = [undefined, null, {}, 'ACCEPTED', auth('HUMAN', 'RESUME_HUMAN_STOP', 'run-1')];
  const list = [];
  for (const actor of ACTORS) {
    list.push(() => c.enterArchitecture(id, actor), () => c.beginImplementation(id, actor),
      () => c.completeImplementation(id, actor, ['evidence']), () => c.recordRemoteSha(id, actor, remote()),
      () => c.beginAcceptanceReview(id, actor), () => c.beginPromotion(id, actor),
      () => c.recordPromotedMain(id, actor, remote(B, 'main')), () => c.resumeArchitecture(id, actor),
      () => c.resumeSoft(id, actor, 'repair'), () => c.failClosed(id, actor, 'reason'),
      () => c.requestPromotion(id, actor, preflight(), auth('HUMAN', 'FAST_FORWARD_MAIN', 'main')),
      () => c.close(id, actor, { observedMainSha: B, expectedAcceptedSha: B, mainCiPassed: true, requiredCheckPassed: true, mainProtected: true }));
    if (actor !== G) list.push(() => c.decideAcceptance(id, actor, decision(c)));
    for (const value of hostile) {
      list.push(() => c.issuePacket(id, actor, value), () => c.issueCorrection(id, actor, value),
        () => c.resumeHuman(id, actor, value));
      if (actor !== G) list.push(() => c.decideAcceptance(id, actor, value));
    }
    for (const kind of STOP_ESCAPES) list.push(() => c.stop(id, actor, kind, 'reason'));
  }
  list.push(() => c.decideAcceptance(id, G, decision(c, 'ACCEPT', C)),
    () => c.decideAcceptance(id, G, { ...decision(c), packetHash: 'f'.repeat(64) }),
    () => c.decideAcceptance(id, G, { ...decision(c), actor: 'CODEX_IMPLEMENTER' }));
  return list;
}
check('no public method other than GPT acceptance of the exact SHA reaches ACCEPTED, from any pre-acceptance state', () => {
  const setups = [
    () => make(), (s = make()) => (s.c.beginImplementation('run-1', X), s),
    (s = make()) => (s.c.beginImplementation('run-1', X), s.c.completeImplementation('run-1', X, ['e']), record(s.c), s),
    (s = make()) => (ready(s.c), s),
    (s = make()) => (ready(s.c), s.c.stop('run-1', K, 'SOFT_STOP', 'x'), s),
    (s = make()) => (ready(s.c), s.c.stop('run-1', K, 'HUMAN_STOP', 'x'), s),
    (s = make()) => (ready(s.c), s.c.decideAcceptance('run-1', G, decision(s.c, 'REJECT')), s),
  ];
  let tried = 0;
  for (const setup of setups) {
    const count = attempts(setup().c).length;
    for (let index = 0; index < count; index++) {
      const { c } = setup(); const attempt = attempts(c)[index];
      try { attempt(); } catch { /* refusal is the expected outcome for most attempts */ }
      assert.notEqual(c.get('run-1').state, 'ACCEPTED'); tried++;
    }
  }
  assert.ok(tried > 1000);
});
check('direct store writes cannot create ACCEPTED or skip the lifecycle', () => {
  const { c, store } = make(); ready(c);
  const before = JSON.stringify(store.get('run-1'));
  for (const [action, role] of [['ACCEPT_EXACT_SHA', 'CODEX_IMPLEMENTER'], ['ACCEPT_EXACT_SHA', 'CONTROLLER'],
    ['ACCEPT_EXACT_SHA', 'GPT_ARCHITECT'], ['STOP', 'CONTROLLER'], ['RESUME_SOFT_WITH_REPAIR', 'CONTROLLER'], ['INVENTED', 'HUMAN']]) {
    const run = store.get('run-1');
    run.state = 'ACCEPTED';
    run.audit.push({ ...run.audit.at(-1), sequence: run.audit.length + 1, action, role, actor: 'forger',
      previousState: 'ACCEPTANCE_REVIEW', nextState: 'ACCEPTED' });
    assert.throws(() => store.replace(run), undefined, `${action}/${role}`);
  }
  const skip = store.get('run-1');
  skip.state = 'PROMOTION_READY';
  skip.audit.push({ ...skip.audit.at(-1), sequence: skip.audit.length + 1, action: 'AUTHORIZE_PROMOTION', role: 'HUMAN',
    previousState: 'ACCEPTANCE_REVIEW', nextState: 'PROMOTION_READY' });
  assert.throws(() => store.replace(skip));
  assert.equal(JSON.stringify(store.get('run-1')), before);
});
check('store cannot be seeded with a non-fresh run', () => {
  const store = new InMemoryControllerStore();
  assert.throws(() => store.create({ runId: 'r', sliceId: 's', repository: repo, state: 'ACCEPTED',
    implementationIterations: 0, acceptanceFailures: 0, audit: [] }));
  assert.throws(() => store.create({ runId: 'r', sliceId: 's', repository: repo, state: 'IDLE',
    implementationIterations: 0, acceptanceFailures: 0, audit: [], acceptance: {} }));
  assert.equal(store.get('r'), undefined);
});
check('store rejects frame violations, counter resets, audit rewrites, and unknown fields', () => {
  const { c, store } = make(); ready(c); c.decideAcceptance('run-1', G, decision(c));
  promote(c, preflight(), auth('HUMAN', 'FAST_FORWARD_MAIN', 'main'));
  const before = JSON.stringify(store.get('run-1'));
  const next = (mutate) => {
    const run = store.get('run-1'); run.state = 'PROMOTING';
    run.audit.push({ ...run.audit.at(-1), sequence: run.audit.length + 1, action: 'MARK_PROMOTING', role: 'CONTROLLER',
      actor: 'controller', previousState: 'PROMOTION_READY', nextState: 'PROMOTING', authorizationReference: undefined, acceptanceSHA: undefined });
    mutate(run); return run;
  };
  assert.doesNotThrow(() => new InMemoryControllerStore()); // sanity
  for (const mutate of [
    (run) => { run.acceptance = { ...run.acceptance, reviewedSha: C }; run.remoteSha = { ...run.remoteSha, sha: C }; },
    (run) => { run.implementationIterations = 0; },
    (run) => { run.audit[0].action = 'tampered'; },
    (run) => { run.bogus = true; },
    (run) => { run.audit.at(-1).extra = 'x'; },
    (run) => { run.audit.at(-1).authorizationReference = 'auth-FAST_FORWARD_MAIN-main'; },
    (run) => { run.externalRecheckRequired = true; },
  ]) assert.throws(() => store.replace(next(mutate)));
  assert.equal(JSON.stringify(store.get('run-1')), before);
});
check('controller refuses evidence-less state from a custom store', () => {
  const inner = new InMemoryControllerStore();
  const writer = inner.bindController();
  const lying = { create: (r) => inner.create(r), replace: (r) => inner.replace(r), entries: (id) => inner.entries(id),
    bindController: () => writer,
    get(id) { const run = inner.get(id); if (!run) return run;
      run.state = 'ACCEPTED';
      run.audit.push({ ...run.audit.at(-1), sequence: run.audit.length + 1, nextState: 'ACCEPTED' }); return run; } };
  const c = new AutomationController(movableClock(), lying);
  assert.throws(() => c.createRun('run-1', 'slice-1', repo));
  assert.throws(() => c.get('run-1'));
});

// ---------------------------------------------------------------- F06
console.log('F06 validation command authorization');
check('exact packet-bound offline command is AUTHORIZED and the verdict carries that exact command', () => {
  const result = evaluatePolicy(request());
  assert.equal(result.decision, 'AUTHORIZED');
  assert.deepEqual(result.validationCommand, NPM_TEST);
  assert.equal(decide(request({ target: 'diff-check', command: { executable: 'git', args: ['diff', '--check'], cwd: '.' } })), 'AUTHORIZED');
});
check('a different command under an authorized id is DENIED', () => {
  for (const executable of ['curl', 'npx', 'node', 'NPM', 'npm ']) {
    assert.equal(decide(request({ command: { executable, args: ['test'], cwd: '.' } })), 'DENIED', executable);
  }
  assert.equal(decide(request({ target: 'unknown-command' })), 'DENIED');
  assert.equal(decide(request({ target: 'npm-test', command: { executable: 'git', args: ['diff', '--check'], cwd: '.' } })), 'DENIED');
});
check('added, removed, or reordered arguments are DENIED', () => {
  for (const args of [['test', '--', '--grep', 'x'], ['test', '--registry=https://evil.test'], [], ['run', 'test'], ['test ']]) {
    assert.equal(decide(request({ command: { executable: 'npm', args, cwd: '.' } })), 'DENIED', JSON.stringify(args));
  }
  assert.equal(decide(request({ target: 'diff-check', command: { executable: 'git', args: ['--check', 'diff'], cwd: '.' } })), 'DENIED');
  assert.equal(decide(request({ target: 'diff-check', command: { executable: 'git', args: ['diff', '--check', 'origin/main'], cwd: '.' } })), 'DENIED');
});
check('a different working directory is DENIED', () => {
  for (const cwd of ['src', './', '..', '/', '/tmp', 'src/../..', '']) {
    assert.equal(decide(request({ command: { executable: 'npm', args: ['test'], cwd } })), 'DENIED', cwd);
  }
});
check('an external-effect command is not authorized by the operation name', () => {
  assert.equal(decide(request({ target: 'ci-status', command: { executable: 'gh', args: ['run', 'view'], cwd: '.' } })), 'DENIED');
  assert.equal(decide(request({ target: 'curl http://evil.test', command: { executable: 'curl', args: ['http://evil.test'], cwd: '.' } })), 'DENIED');
  assert.equal(decide(request({ command: undefined })), 'DENIED');
  assert.equal(decide({ ...request(), command: undefined, target: 'npm test' }), 'DENIED');
});
check('command facts are refused on other operations, and non-automatic actors stay unauthorized', () => {
  assert.equal(decide(request({ operation: 'READ_REPOSITORY', target: 'file', resourceClassification: 'ORDINARY' })), 'DENIED');
  for (const actor of [G, H, GH]) assert.notEqual(decide(request({ actor })), 'AUTHORIZED');
});
check('packets refuse shell launchers, qualified executables, escaping cwd, and duplicate ids', () => {
  const bad = (command) => packet({ validationCommands: [{ ...NPM_TEST, ...command }] });
  for (const command of [{ executable: 'sh', args: ['-c', 'npm test'] }, { executable: 'bash' }, { executable: 'BASH.EXE' },
    { executable: 'env', args: ['npm', 'test'] }, { executable: 'pwsh' }, { executable: '/usr/bin/npm' }, { executable: './npm' },
    { executable: 'npm test', args: [] }, { cwd: '../outside' }, { cwd: '/abs' }, { cwd: 'src/../..' }, { cwd: '' },
    { classification: 'OFFLINE' }, { args: 'test' }, { extra: true }]) {
    assert.throws(() => parsePacket(bad(command)), undefined, JSON.stringify(command));
  }
  assert.throws(() => parsePacket(packet({ validationCommands: [NPM_TEST, { ...DIFF_CHECK, commandId: 'npm-test' }] })));
  assert.throws(() => parsePacket(packet({ validationCommands: ['npm test'] })));
});
check('mutating a returned validation command does not change the next verdict', () => {
  const first = evaluatePolicy(request());
  first.validationCommand.args.push('--grep'); first.validationCommand.executable = 'curl';
  assert.deepEqual(evaluatePolicy(request()).validationCommand, NPM_TEST);
});

// ---------------------------------------------------------------- F07
console.log('F07 runtime policy input validation');
check('INVALID network level is DENIED, even with a matching GPT grant', () => {
  const p = { ...packet(), networkAuthorization: { level: 'INVALID', destinations: ['d'], purpose: 'p', budget: 1 } };
  assert.equal(decide({ operation: 'READ_WEB', target: 'd', actor: G, packet: p, runId: 'run-1', now: T,
    authorization: auth('GPT_ARCHITECT', 'READ_WEB', 'd') }), 'DENIED');
  for (const level of [undefined, null, 99, 'offline', '__proto__', 'toString']) {
    assert.equal(decide(request({ packet: { ...packet(), networkAuthorization: { ...packet().networkAuthorization, level } } })), 'DENIED', String(level));
  }
});
check('malformed packets are DENIED', () => {
  const { packetId, ...missing } = packet();
  for (const p of [undefined, null, 'packet', 42, [], {}, missing, { ...packet(), extra: 1 },
    { ...packet(), validationCommands: [] }, { ...packet(), providerCallAuthorization: { allowed: 'yes' } },
    { ...packet(), iterationBudget: { ...packet().iterationBudget, maxImplementationIterationsPerSlice: 99 } }]) {
    assert.equal(decide(request({ packet: p })), 'DENIED');
  }
});
check('malformed actors are DENIED', () => {
  for (const actor of [undefined, null, 'CONTROLLER', {}, { role: 'CONTROLLER' }, { id: 'x' }, { id: '', role: 'CONTROLLER' },
    { id: ' x', role: 'CONTROLLER' }, { id: 'x', role: 'ROOT' }, { id: 'x', role: 'controller' },
    { id: 'x', role: 'CONTROLLER', admin: true }, { id: ['x'], role: 'CONTROLLER' }]) {
    assert.equal(decide(request({ actor })), 'DENIED', JSON.stringify(actor));
  }
});
check('malformed authorizations are DENIED rather than treated as absent', () => {
  const good = auth('HUMAN', 'FAST_FORWARD_MAIN', 'main');
  const base = { operation: 'FAST_FORWARD_MAIN', target: 'main', actor: H, packet: packet(), runId: 'run-1', now: T };
  assert.equal(decide({ ...base, authorization: good }), 'AUTHORIZED');
  const { reason, ...noReason } = good;
  for (const bad of [null, 'grant', 1, {}, noReason, { ...good, extra: 1 }, { ...good, actorRole: 'ADMIN' },
    { ...good, issuedAt: 'yesterday' }, { ...good, issuedAt: '2026-09-26' }, { ...good, expiresAt: '2026-02-30T00:00:00Z' },
    { ...good, expiresAt: '2026-09-25T00:00:00Z' }, { ...good, target: '*' }, { ...good, target: 'ma*n' },
    { ...good, target: ' main' }, { ...good, runId: '' }, { ...good, scope: {} }]) {
    assert.equal(decide({ ...base, authorization: bad }), 'DENIED', JSON.stringify(bad));
  }
});
check('malformed requests are DENIED and evaluatePolicy never throws', () => {
  const throwing = { get operation() { throw new Error('hostile getter'); } };
  const proxy = new Proxy({}, { get() { throw new Error('hostile proxy'); }, ownKeys() { throw new Error('hostile proxy'); } });
  for (const req of [undefined, null, 'x', 42, [], throwing, proxy, { ...request(), extra: 1 }, request({ target: '*' }),
    request({ target: ' npm-test' }), request({ now: 'now' }), request({ now: undefined }), request({ runId: '' }),
    request({ resourceClassification: 'SECRET' }), request({ operation: 5 })]) {
    assert.doesNotThrow(() => evaluatePolicy(req));
    assert.equal(decide(req), 'DENIED');
  }
});
check('inherited and polluted operation names are DENIED', () => {
  Object.prototype.POLLUTED = 'ALLOW_AUTOMATIC';
  try {
    for (const operation of ['POLLUTED', '__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      assert.equal(decide(request({ operation, target: 'x', command: undefined })), 'DENIED', operation);
    }
  } finally { delete Object.prototype.POLLUTED; }
});
check('controller rejects malformed inputs before any mutation', () => {
  const { c } = make();
  rejectedWithoutMutation(c, () => c.beginImplementation('run-1', { id: 'x', role: 'CODEX_IMPLEMENTER', extra: 1 }));
  rejectedWithoutMutation(c, () => c.beginImplementation('run-1', null));
  c.beginImplementation('run-1', X);
  rejectedWithoutMutation(c, () => c.completeImplementation('run-1', X, []));
  rejectedWithoutMutation(c, () => c.completeImplementation('run-1', X, 'evidence'));
  c.completeImplementation('run-1', X, ['e']);
  rejectedWithoutMutation(c, () => record(c, { ...remote(), sha: 'not-a-sha' }));
  rejectedWithoutMutation(c, () => record(c, { ...remote(), observedAt: '2026-09-26T00:00:00.001Z' }));
  record(c); c.beginAcceptanceReview('run-1', G);
  rejectedWithoutMutation(c, () => c.decideAcceptance('run-1', G, { ...decision(c), issuedAt: '2026-09-26T08:00:00.001+08:00' }));
  c.decideAcceptance('run-1', G, decision(c));
  for (const bad of [undefined, null, {}, { ...auth('HUMAN', 'FAST_FORWARD_MAIN', 'main'), extra: 1 },
    auth('HUMAN', 'FAST_FORWARD_MAIN', 'main', { issuedAt: 'soon' })]) {
    rejectedWithoutMutation(c, () => promote(c, preflight(), bad));
  }
  rejectedWithoutMutation(c, () => promote(c, { ...preflight(), aheadBy: -1 }, auth('HUMAN', 'FAST_FORWARD_MAIN', 'main')));
});
check('an invalid clock value fails closed without mutation', () => {
  const clock = movableClock(); const { c } = make(packet(), clock);
  for (const value of ['not-a-date', '', undefined, '2026-09-26T00:00:00', 1790000000000]) {
    clock.value = value;
    rejectedWithoutMutation(c, () => c.beginImplementation('run-1', X));
  }
});

// ---------------------------------------------------------------- F08
console.log('F08 immutable authorization policy');
check('assigning OPERATION_POLICY.FORCE_PUSH fails and FORCE_PUSH stays DENIED', () => {
  assert.throws(() => { OPERATION_POLICY.FORCE_PUSH = 'ALLOW_AUTOMATIC'; }, TypeError);
  assert.throws(() => Object.defineProperty(OPERATION_POLICY, 'FORCE_PUSH', { value: 'ALLOW_AUTOMATIC' }), TypeError);
  assert.throws(() => { delete OPERATION_POLICY.FORCE_PUSH; }, TypeError);
  assert.throws(() => { OPERATION_POLICY.NEW_OPERATION = 'ALLOW_AUTOMATIC'; }, TypeError);
  assert.throws(() => Object.setPrototypeOf(OPERATION_POLICY, { FORCE_PUSH: 'ALLOW_AUTOMATIC' }), TypeError);
  assert.equal(OPERATION_POLICY.FORCE_PUSH, 'FORBIDDEN');
  for (const actor of [X, K, H, G]) {
    assert.equal(decide({ operation: 'FORCE_PUSH', target: 'main', actor, packet: packet(), runId: 'run-1', now: T,
      resourceClassification: 'ORDINARY', authorization: auth(actor.role === 'HUMAN' ? 'HUMAN' : 'GPT_ARCHITECT', 'FORCE_PUSH', 'main') }), 'DENIED');
  }
});
check('inspection data is not the authority source', () => {
  const copy = { ...OPERATION_POLICY, FORCE_PUSH: 'ALLOW_AUTOMATIC', NEW_OPERATION: 'ALLOW_AUTOMATIC' };
  assert.equal(copy.FORCE_PUSH, 'ALLOW_AUTOMATIC');
  assert.equal(decide({ operation: 'FORCE_PUSH', target: 'main', actor: X, packet: packet(), runId: 'run-1', now: T }), 'DENIED');
  assert.equal(decide({ operation: 'NEW_OPERATION', target: 'x', actor: X, packet: packet(), runId: 'run-1', now: T }), 'DENIED');
  for (const [operation, classification] of Object.entries(OPERATION_POLICY)) {
    assert.equal(evaluatePolicy({ operation, target: 'x', actor: X, packet: packet(), runId: 'run-1', now: T }).classification, classification);
  }
});
check('exported runtime vocabularies are frozen', () => {
  for (const list of [STATES, STOP_CLASSES, ROLES, NETWORK_LEVELS]) {
    assert.ok(Object.isFrozen(list));
    assert.throws(() => list.push('ACCEPTED'), TypeError);
  }
  assert.equal(STOP_CLASSES.length, 3);
});
for (const name of ['audit', 'controller', 'lifecycle', 'packet', 'policy', 'time', 'types']) {
  const exported = await import(`./dist/automation/${name}.js`);
  check(`${name}.js exposes no mutable authority`, () => {
    for (const [key, value] of Object.entries(exported)) {
      assert.ok(typeof value === 'function' || Object.isFrozen(value), `${name}.${key}`);
    }
  });
}

// ---------------------------------------------------------------- F09
console.log('F09 authorization time and replay');
check('timestamps compare as instants across formats', () => {
  assert.equal(parseInstant('2026-09-26T08:00:00+08:00'), parseInstant(T));
  assert.equal(parseInstant('2026-09-25T19:30:00-04:30'), parseInstant(T));
  assert.equal(parseInstant('2026-09-26T00:00:00Z'), parseInstant(T));
  assert.ok(parseInstant('2026-09-26T00:00:00.9Z') > parseInstant('2026-09-26T00:00:00Z'));
  for (const bad of ['2026-02-30T00:00:00Z', '2026-09-26T24:00:00Z', '2026-09-26T00:00:60Z', '2026-09-26T00:00:00',
    '2026-09-26t00:00:00z', '2026-09-26T00:00:00.0001Z', '0050-01-01T00:00:00Z', '2026-09-26T00:00:00+24:00', ' 2026-09-26T00:00:00Z', 1]) {
    assert.equal(parseInstant(bad), undefined, String(bad));
  }
});
check('an expired grant is DENIED when its window is written in a different format', () => {
  const base = { operation: 'FAST_FORWARD_MAIN', target: 'main', actor: H, packet: packet(), runId: 'run-1' };
  const lexicalTrap = auth('HUMAN', 'FAST_FORWARD_MAIN', 'main', { issuedAt: '2026-09-25T23:59:59Z', expiresAt: '2026-09-26T00:00:00Z' });
  assert.equal(decide({ ...base, now: '2026-09-26T00:00:00.900Z', authorization: lexicalTrap }), 'REQUIRE_HUMAN');
  const offset = auth('HUMAN', 'FAST_FORWARD_MAIN', 'main', { issuedAt: '2026-09-26T07:00:00+08:00', expiresAt: '2026-09-26T08:00:00+08:00' });
  assert.equal(decide({ ...base, now: T, authorization: offset }), 'AUTHORIZED');
  assert.equal(decide({ ...base, now: '2026-09-26T00:00:00.001Z', authorization: offset }), 'REQUIRE_HUMAN');
  const future = auth('HUMAN', 'FAST_FORWARD_MAIN', 'main', { issuedAt: '2026-09-26T08:00:00.001+08:00' });
  assert.equal(decide({ ...base, now: T, authorization: future }), 'REQUIRE_HUMAN');
});
check('a promotion grant that expires before beginPromotion cannot start promotion', () => {
  const clock = movableClock(); const { c } = make(packet(), clock); ready(c); c.decideAcceptance('run-1', G, decision(c));
  promote(c, preflight(), auth('HUMAN', 'FAST_FORWARD_MAIN', 'main', { expiresAt: '2026-09-26T08:00:01+08:00' }));
  clock.value = '2026-09-26T00:00:01.001Z';
  rejectedWithoutMutation(c, () => c.beginPromotion('run-1', K));
  assert.equal(c.get('run-1').state, 'PROMOTION_READY');
  clock.value = '2026-09-26T00:00:01.000Z';
  assert.equal(c.beginPromotion('run-1', K).state, 'PROMOTING');
});
check('a promotion grant resumed after HUMAN_STOP is re-checked when promotion begins', () => {
  const clock = movableClock(); const { c } = make(packet(), clock); ready(c); c.decideAcceptance('run-1', G, decision(c));
  promote(c, preflight(), auth('HUMAN', 'FAST_FORWARD_MAIN', 'main', { expiresAt: '2026-09-26T00:01:00Z' }));
  c.stop('run-1', K, 'HUMAN_STOP', 'pause');
  clock.value = '2026-09-26T00:02:00Z';
  c.resumeHuman('run-1', H, auth('HUMAN', 'RESUME_HUMAN_STOP', c.get('run-1').stopId));
  rejectedWithoutMutation(c, () => c.beginPromotion('run-1', K));
});
check('a HUMAN_STOP resume grant is single-use and bound to one stop occurrence', () => {
  const { c } = make();
  c.stop('run-1', K, 'HUMAN_STOP', 'first');
  const stopA = c.get('run-1').stopId;
  const grantA = auth('HUMAN', 'RESUME_HUMAN_STOP', stopA);
  c.resumeHuman('run-1', H, grantA);
  c.stop('run-1', K, 'HUMAN_STOP', 'second');
  const stopB = c.get('run-1').stopId;
  assert.notEqual(stopA, stopB);
  rejectedWithoutMutation(c, () => c.resumeHuman('run-1', H, grantA));
  rejectedWithoutMutation(c, () => c.resumeHuman('run-1', H, { ...grantA, target: stopB }));
  assert.equal(c.resumeHuman('run-1', H, auth('HUMAN', 'RESUME_HUMAN_STOP', stopB)).state, 'PACKET_READY');
});
check('an unused grant for stop A cannot resume stop B', () => {
  const { c } = make();
  c.stop('run-1', K, 'HUMAN_STOP', 'first');
  const unusedForA = auth('HUMAN', 'RESUME_HUMAN_STOP', c.get('run-1').stopId, { authorizationId: 'unused-a' });
  c.resumeHuman('run-1', H, auth('HUMAN', 'RESUME_HUMAN_STOP', c.get('run-1').stopId, { authorizationId: 'used-a' }));
  c.reconcile('run-1', K);
  c.beginImplementation('run-1', X);
  c.stop('run-1', K, 'HUMAN_STOP', 'second');
  rejectedWithoutMutation(c, () => c.resumeHuman('run-1', H, unusedForA));
  assert.equal(c.get('run-1').interruptedState, 'IMPLEMENTING');
});
check('resume grants with wrong operation, target, run, packet, role, or window are rejected', () => {
  const clock = movableClock(); const { c } = make(packet(), clock);
  c.stop('run-1', K, 'HUMAN_STOP', 'gate');
  const stopId = c.get('run-1').stopId;
  const grant = (overrides) => auth('HUMAN', 'RESUME_HUMAN_STOP', stopId, overrides);
  for (const bad of [grant({ operation: 'FAST_FORWARD_MAIN' }), grant({ target: 'run-1' }), grant({ target: 'stop-1' }),
    grant({ runId: 'run-2' }), grant({ runId: undefined }), grant({ packetId: 'packet-2' }), grant({ packetId: undefined }),
    grant({ actorRole: 'GPT_ARCHITECT' }), grant({ expiresAt: '2026-09-25T23:59:59.999Z', issuedAt: '2026-09-25T00:00:00Z' }),
    grant({ issuedAt: '2026-09-26T00:00:00.001Z' }), grant({ scope: { actorKind: 'IMPLEMENTATION', provider: 'p', model: 'm', egressDestinations: ['api.p.test:443'] } })]) {
    rejectedWithoutMutation(c, () => c.resumeHuman('run-1', H, bad));
  }
  rejectedWithoutMutation(c, () => c.resumeHuman('run-1', G, grant()));
  assert.equal(c.resumeHuman('run-1', H, grant()).state, 'PACKET_READY');
});
check('a promotion grant cannot be reused once consumed', () => {
  const { c, store } = make(); ready(c); c.decideAcceptance('run-1', G, decision(c));
  const grant = auth('HUMAN', 'FAST_FORWARD_MAIN', 'main');
  promote(c, preflight(), grant);
  c.stop('run-1', K, 'HUMAN_STOP', 'pause');
  const before = JSON.stringify(store.get('run-1'));
  const replay = store.get('run-1'); replay.state = 'PROMOTION_READY';
  replay.interruptedState = undefined; replay.stopReason = undefined; replay.stopId = undefined; replay.externalRecheckRequired = true;
  replay.humanResumeAuthorization = { ...grant, operation: 'RESUME_HUMAN_STOP', target: c.get('run-1').stopId };
  replay.audit.push({ ...replay.audit.at(-1), sequence: replay.audit.length + 1, action: 'RESUME_HUMAN_STOP', role: 'HUMAN',
    actor: 'human', previousState: 'HUMAN_STOP', nextState: 'PROMOTION_READY', stopReason: undefined, stopId: undefined,
    authorizationReference: grant.authorizationId });
  assert.throws(() => store.replace(replay));
  assert.equal(JSON.stringify(store.get('run-1')), before);
});

// ---------------------------------------------------------------- provider / model / network
console.log('Provider, model, and network scope');
check('allowed provider, model, exact egress set, and exact human grant is AUTHORIZED', () => {
  assert.equal(decide(modelCall()), 'AUTHORIZED');
});
check('wrong provider is DENIED, even when the model is allowlisted', () => {
  assert.equal(decide(modelCall({ providerCall: { actorKind: 'IMPLEMENTATION', provider: 'provider-b', model: 'model-a', egressDestinations: [...EGRESS] } },
    { scope: { actorKind: 'IMPLEMENTATION', provider: 'provider-b', model: 'model-a', egressDestinations: [...EGRESS] } })), 'DENIED');
});
check('wrong model is DENIED, even when the provider is allowlisted', () => {
  assert.equal(decide(modelCall({ providerCall: { actorKind: 'IMPLEMENTATION', provider: 'provider-a', model: 'model-b', egressDestinations: [...EGRESS] } },
    { scope: { actorKind: 'IMPLEMENTATION', provider: 'provider-a', model: 'model-b', egressDestinations: [...EGRESS] } })), 'DENIED');
});
check('wrong egress set is DENIED, and the target is never a network destination', () => {
  const scope = { actorKind: 'IMPLEMENTATION', provider: 'provider-a', model: 'model-a', egressDestinations: ['api.other.test:443'] };
  assert.equal(decide(modelCall({ providerCall: scope }, { scope })), 'DENIED');
  for (const target of ['main', DEST, 'api.synthetic-provider.test', 'anthropic']) {
    assert.equal(decide(modelCall({ target }, { target })), 'DENIED', target);
  }
});
check('provider is never inferred from the model', () => {
  const inferred = { actorKind: 'IMPLEMENTATION', model: 'provider-a/model-a', egressDestinations: [...EGRESS] };
  assert.equal(decide(modelCall({ providerCall: inferred })), 'DENIED');
  assert.equal(decide(modelCall({ providerCall: { ...inferred, provider: '' } })), 'DENIED');
  const packetWithModelNamedAfterProvider = providerPacket({ providerCallAuthorization:
    { allowed: true, calls: [implCall({ provider: 'provider-b', model: 'provider-a-model' })], maxCalls: 1, budget: 1 } });
  assert.equal(decide(modelCall({ packet: packetWithModelNamedAfterProvider,
    providerCall: { actorKind: 'IMPLEMENTATION', provider: 'provider-a', model: 'provider-a-model', egressDestinations: [...EGRESS] } })), 'DENIED');
  assert.equal(decide(modelCall({ providerCall: undefined })), 'DENIED');
});
check('READ_WEB alone cannot authorize a model call', () => {
  const readWeb = providerPacket({ networkAuthorization: { level: 'READ_WEB', destinations: [...EGRESS], purpose: 'read', budget: 1 } });
  assert.equal(decide(modelCall({ packet: readWeb })), 'DENIED');
  assert.notEqual(decide(modelCall({}, { operation: 'READ_WEB' })), 'AUTHORIZED');
  assert.notEqual(decide({ operation: 'READ_WEB', target: DEST, actor: G, packet: readWeb, runId: 'run-1', now: T,
    providerCall: { actorKind: 'IMPLEMENTATION', provider: 'provider-a', model: 'model-a', egressDestinations: [...EGRESS] },
    authorization: auth('GPT_ARCHITECT', 'READ_WEB', DEST) }), 'AUTHORIZED');
});
check('the human grant must name the exact provider, model, and egress set', () => {
  for (const scope of [undefined, { actorKind: 'IMPLEMENTATION', provider: 'provider-b', model: 'model-a', egressDestinations: [...EGRESS] },
    { actorKind: 'IMPLEMENTATION', provider: 'provider-a', model: 'model-b', egressDestinations: [...EGRESS] }, { actorKind: 'IMPLEMENTATION', provider: 'provider-a', model: 'model-a', egressDestinations: [DEST] }]) {
    assert.notEqual(decide(modelCall({}, { scope })), 'AUTHORIZED', JSON.stringify(scope));
  }
  for (const overrides of [{ operation: 'FAST_FORWARD_MAIN' }, { target: 'main' }, { runId: 'run-2' }, { packetId: 'packet-2' },
    { actorRole: 'GPT_ARCHITECT' }, { expiresAt: '2026-09-25T23:00:00Z', issuedAt: '2026-09-25T22:00:00Z' }]) {
    assert.notEqual(decide(modelCall({}, overrides)), 'AUTHORIZED', JSON.stringify(overrides));
  }
  assert.notEqual(decide(modelCall({ actor: G })), 'AUTHORIZED');
  assert.notEqual(decide(modelCall({ actor: K })), 'AUTHORIZED');
});
check('packet-level provider gates hold: disabled calls, zero budget, and no wildcards', () => {
  assert.equal(decide(modelCall({ packet: providerPacket({ providerCallAuthorization: { allowed: false, calls: [], maxCalls: 0, budget: 0 } }) })), 'DENIED');
  assert.equal(decide(modelCall({ packet: providerPacket({ providerCallAuthorization: { allowed: true, calls: [implCall()], maxCalls: 0, budget: 1 } }) })), 'DENIED');
  const wildcard = providerPacket({ providerCallAuthorization: { allowed: true, calls: [implCall({ provider: '*', model: '*' })], maxCalls: 1, budget: 1 } });
  assert.equal(decide(modelCall({ packet: wildcard })), 'DENIED');
  assert.equal(decide(modelCall({ providerCall: { actorKind: 'IMPLEMENTATION', provider: '*', model: '*', egressDestinations: [...EGRESS] } },
    { scope: { actorKind: 'IMPLEMENTATION', provider: '*', model: '*', egressDestinations: [...EGRESS] } })), 'DENIED');
  for (const egressDestinations of [['*.synthetic-provider.test:443'], ['*:443'], ['api.synthetic-provider.test:*']]) {
    assert.equal(decide(modelCall({ providerCall: { actorKind: 'IMPLEMENTATION', provider: 'provider-a', model: 'model-a', egressDestinations } },
      { scope: { actorKind: 'IMPLEMENTATION', provider: 'provider-a', model: 'model-a', egressDestinations } })), 'DENIED', JSON.stringify(egressDestinations));
  }
});
check('provider-call facts are refused on other operations', () => {
  assert.equal(decide({ ...request(), providerCall: { actorKind: 'IMPLEMENTATION', provider: 'provider-a', model: 'model-a', egressDestinations: [...EGRESS] } }), 'DENIED');
});

// ---------------------------------------------------------------- G1-R3C: exact egress sets
console.log('G1-R3C: the live call binds an exact egress destination set');
const egressCall = (callSet, grantSet = callSet, packetSet = [...EGRESS], networkSet = [...EGRESS], extra = {}) => {
  const packetOverrides = { networkAuthorization: { level: 'READ_EXTERNAL_API', destinations: networkSet, purpose: 'synthetic model call', budget: 1 },
    providerCallAuthorization: { allowed: true, calls: [implCall({ egressDestinations: packetSet })], maxCalls: 1, budget: 1 } };
  return modelCall({ packet: providerPacket(packetOverrides), providerCall: { actorKind: 'IMPLEMENTATION', provider: 'provider-a', model: 'model-a', egressDestinations: callSet }, ...extra },
    { scope: { actorKind: 'IMPLEMENTATION', provider: 'provider-a', model: 'model-a', egressDestinations: grantSet } });
};
check('human grant set == packet set == call set is AUTHORIZED; the grant target is the fixed live-call target', () => {
  assert.equal(decide(egressCall([...EGRESS])), 'AUTHORIZED');
  assert.equal(TARGET, LIVE_PROVIDER_MODEL_CALL_TARGET);
  const verdict = authorizeLiveModelCall({ packet: providerPacket(), runId: 'run-1', now: T,
    scope: { actorKind: 'IMPLEMENTATION', provider: 'provider-a', model: 'model-a', egressDestinations: [...EGRESS] },
    authorization: auth('HUMAN', 'LIVE_PROVIDER_MODEL_CALL', TARGET, { scope: { actorKind: 'IMPLEMENTATION', provider: 'provider-a', model: 'model-a', egressDestinations: [...EGRESS] } }) });
  assert.equal(verdict.decision, 'AUTHORIZED');
});
check('a missing, an extra, or a wrong-port destination is DENIED, in the call and in the packet', () => {
  const extra = [...EGRESS, 'telemetry.synthetic-provider.test:443'].sort();
  const port = ['api.synthetic-provider.test:8443', AUTH_DEST];
  for (const [name, set] of [['missing', [DEST]], ['extra', extra], ['wrong port', port], ['empty', []]]) {
    assert.equal(decide(egressCall(set)), 'DENIED', `call ${name}`);
    if (set.length) assert.equal(decide(egressCall([...EGRESS], [...EGRESS], set, [...new Set([...EGRESS, ...set])].sort())), 'DENIED', `packet ${name}`);
  }
});
check('a human grant whose set differs by one destination or one port is not an authorization', () => {
  for (const set of [[DEST], [...EGRESS, 'telemetry.synthetic-provider.test:443'].sort(), ['api.synthetic-provider.test:8443', AUTH_DEST]]) {
    const result = evaluatePolicy(egressCall([...EGRESS], set));
    assert.equal(result.decision, 'REQUIRE_HUMAN', JSON.stringify(set));
    assert.match(result.reason, /missing exact HUMAN authorization/);
  }
  for (const overrides of [{ runId: 'run-2' }, { packetId: 'packet-2' }]) {
    assert.notEqual(decide(modelCall({}, overrides)), 'AUTHORIZED', JSON.stringify(overrides));
  }
  assert.equal(decide(modelCall({ runId: 'run-2' })), 'REQUIRE_HUMAN', 'a grant for run-1 does not bind run-2');
  assert.equal(decide(modelCall({ authorization: undefined })), 'REQUIRE_HUMAN', 'no human grant, no call');
});
check('every egress destination must also be a packet network destination', () => {
  assert.equal(decide(egressCall([...EGRESS], [...EGRESS], [...EGRESS], [DEST])), 'DENIED');
  assert.equal(decide(egressCall([...EGRESS], [...EGRESS], [...EGRESS], [AUTH_DEST, 'work/synthetic-1'])), 'DENIED');
  assert.equal(decide(egressCall([...EGRESS], [...EGRESS], [...EGRESS], [...EGRESS, 'work/synthetic-1'])), 'AUTHORIZED', 'other packet targets may coexist');
});
check('a logical label, a single-destination scope, or a non-canonical set is refused at ingress', () => {
  for (const set of [['anthropic'], ['openai'], ['claude-cli'], ['codex-cli'], ['provider-api'], ['api.synthetic-provider.test'],
    ['https://api.synthetic-provider.test:443'], ['user@api.synthetic-provider.test:443'], ['api.synthetic-provider.test:443/v1'],
    ['API.synthetic-provider.test:443'], ['api.synthetic-provider.test.:443'], ['127.0.0.1:443'], [AUTH_DEST, DEST], [DEST, DEST], [' api.x.test:443']]) {
    const packetRefused = tryParsePacket(providerPacket({ providerCallAuthorization: { allowed: true,
      calls: [implCall({ egressDestinations: set })], maxCalls: 1, budget: 1 } }));
    assert.equal(packetRefused, undefined, `packet ${JSON.stringify(set)}`);
    assert.equal(parseAuthorization(auth('HUMAN', 'LIVE_PROVIDER_MODEL_CALL', TARGET, { scope: { actorKind: 'IMPLEMENTATION', provider: 'provider-a', model: 'model-a', egressDestinations: set } })),
      undefined, `grant ${JSON.stringify(set)}`);
    assert.equal(decide(egressCall(set)), 'DENIED', `call ${JSON.stringify(set)}`);
  }
  const single = { actorKind: 'IMPLEMENTATION', provider: 'provider-a', model: 'model-a', destination: DEST };
  assert.equal(decide(modelCall({ providerCall: single }, { scope: single })), 'DENIED');
  assert.equal(parseAuthorization(auth('HUMAN', 'LIVE_PROVIDER_MODEL_CALL', TARGET, { scope: single })), undefined);
  assert.equal(tryParsePacket(providerPacket({ providerCallAuthorization: { allowed: true,
    calls: [{ actorKind: 'IMPLEMENTATION', provider: 'provider-a', model: 'model-a' }], maxCalls: 1, budget: 1 } })),
    undefined, 'a packet call entry must state its egress set');
  assert.equal(tryParsePacket(providerPacket({ providerCallAuthorization: { allowed: true,
    calls: [implCall({ egressDestinations: [] })], maxCalls: 1, budget: 1 } })), undefined, 'an entry binds a non-empty set');
  assert.equal(tryParsePacket(providerPacket({ providerCallAuthorization: { allowed: true, calls: [], maxCalls: 1, budget: 1 } })),
    undefined, 'allowed calls bind at least one entry');
  assert.equal(tryParsePacket(packet({ providerCallAuthorization: { allowed: false, calls: [implCall()], maxCalls: 0, budget: 0 } })),
    undefined, 'denied calls carry no call entries');
});
check('canonical destinations: exact spelling only, no normalization at any layer', () => {
  for (const good of ['api.anthropic.com:443', 'platform.claude.com:443', 'chatgpt.com:443', 'auth.openai.com:443', 'xn--bcher-kva.example:8443', 'a.b:1', 'a.b:65535']) {
    assert.ok(isCanonicalEgressDestination(good), good);
  }
  for (const bad of ['api.anthropic.com', 'api.anthropic.com:', ':443', 'api.anthropic.com:0', 'api.anthropic.com:65536', 'api.anthropic.com:0443',
    'API.anthropic.com:443', 'api.anthropic.com.:443', 'localhost:443', 'bücher.example:443', 'xn--zz.example:443', 'a..b:443', '-a.b:443', 'a-.b:443',
    '1.2.3.4:443', '[::1]:443', '::1:443', 'a.b:443 ', 'a.b:44\u00003', 'a.b:4 43', '*.a.b:443', 'a.*:443', 'http://a.b:443', 'u:p@a.b:443', 'a.b:443?x', 'a.b:443#f',
    'a.b/c:443', `${'a'.repeat(64)}.b:443`, 443, null, undefined, ['a.b:443']]) {
    assert.ok(!isCanonicalEgressDestination(bad), JSON.stringify(bad));
  }
  assert.ok(isCanonicalEgressSet([...EGRESS]) && !isCanonicalEgressSet([]) && isCanonicalEgressSet([], { allowEmpty: true }));
  assert.ok(!isCanonicalEgressSet([AUTH_DEST, DEST]) && !isCanonicalEgressSet([DEST, DEST]));
  assert.ok(sameEgressSet([...EGRESS], [...EGRESS]) && !sameEgressSet([...EGRESS], [DEST]) && !sameEgressSet([AUTH_DEST, DEST], [AUTH_DEST, DEST]));
});

// ---------------------------------------------------------------- G1-R3C-C1: actor-scoped authority
console.log('G1-R3C-C1: live-call authority is scoped to one actor');
const IMPL_SET = Object.freeze(['api.impl-provider.test:443', 'platform.impl-provider.test:443']);
const REVIEW_SET = Object.freeze(['auth.review-provider.test:443', 'chat.review-provider.test:443']);
const UNION = Object.freeze([...IMPL_SET, ...REVIEW_SET].sort());
const IMPL_SCOPE = Object.freeze({ actorKind: 'IMPLEMENTATION', provider: 'impl-provider', model: 'impl-model-1', egressDestinations: IMPL_SET });
const REVIEW_SCOPE = Object.freeze({ actorKind: 'ARCHITECT_REVIEW', provider: 'review-provider', model: 'review-model-1', egressDestinations: REVIEW_SET });
// Every destination of both actors is a packet network destination, so only the actor entry can refuse a borrowed one.
function actorPacket(calls = [IMPL_SCOPE, REVIEW_SCOPE]) {
  return packet({ networkAuthorization: { level: 'READ_EXTERNAL_API', destinations: [...UNION], purpose: 'two synthetic actors', budget: 2 },
    providerCallAuthorization: { allowed: true, calls: structuredClone(calls), maxCalls: 2, budget: 2 } });
}
const actorCall = (call, grant = call, livePacket = actorPacket()) => evaluatePolicy({ operation: 'LIVE_PROVIDER_MODEL_CALL', target: TARGET,
  actor: H, packet: livePacket, runId: 'run-1', now: T, providerCall: structuredClone(call),
  authorization: auth('HUMAN', 'LIVE_PROVIDER_MODEL_CALL', TARGET, { scope: structuredClone(grant) }) });
const liveGate = (scope, grant = scope, livePacket = actorPacket()) => authorizeLiveModelCall({ packet: livePacket, runId: 'run-1', now: T,
  scope: structuredClone(scope), authorization: auth('HUMAN', 'LIVE_PROVIDER_MODEL_CALL', TARGET, { scope: structuredClone(grant) }) });
check('C1-1/2: each actor with its own exact entry and its own exact human grant is eligible', () => {
  assert.equal(actorCall(IMPL_SCOPE).decision, 'AUTHORIZED');
  assert.equal(actorCall(REVIEW_SCOPE).decision, 'AUTHORIZED');
  assert.equal(liveGate(IMPL_SCOPE).decision, 'AUTHORIZED');
  assert.equal(liveGate(REVIEW_SCOPE).decision, 'AUTHORIZED');
});
check('C1-3/4: a call carrying the other actor\'s egress set is DENIED', () => {
  for (const [call, reason] of [[{ ...IMPL_SCOPE, egressDestinations: [...REVIEW_SET] }, 'implementation with review set'],
    [{ ...REVIEW_SCOPE, egressDestinations: [...IMPL_SET] }, 'review with implementation set']]) {
    const result = actorCall(call);
    assert.equal(result.decision, 'DENIED', reason);
    assert.match(result.reason, /egress destinations differ from the packet entry for this actor/, reason);
  }
});
check('C1-5/6: one actor\'s human grant never authorizes the other actor', () => {
  for (const [call, grant, name] of [[REVIEW_SCOPE, IMPL_SCOPE, 'implementation grant to review'],
    [IMPL_SCOPE, REVIEW_SCOPE, 'review grant to implementation']]) {
    const result = actorCall(call, grant);
    assert.equal(result.decision, 'REQUIRE_HUMAN', name);
    assert.match(result.reason, /missing exact HUMAN authorization/, name);
    assert.notEqual(liveGate(call, grant).decision, 'AUTHORIZED', name);
  }
  // Twin entries: both actors name the same provider, model, and set. Only actorKind tells the grants apart.
  const twinReview = { ...IMPL_SCOPE, actorKind: 'ARCHITECT_REVIEW' };
  const twins = actorPacket([IMPL_SCOPE, twinReview]);
  assert.equal(actorCall(IMPL_SCOPE, IMPL_SCOPE, twins).decision, 'AUTHORIZED');
  assert.equal(actorCall(twinReview, twinReview, twins).decision, 'AUTHORIZED');
  assert.equal(actorCall(twinReview, IMPL_SCOPE, twins).decision, 'REQUIRE_HUMAN', 'implementation grant to review twin');
  assert.equal(actorCall(IMPL_SCOPE, twinReview, twins).decision, 'REQUIRE_HUMAN', 'review grant to implementation twin');
  assert.equal(liveGate(twinReview, IMPL_SCOPE, twins).decision, 'REQUIRE_HUMAN');
  assert.equal(liveGate(IMPL_SCOPE, twinReview, twins).decision, 'REQUIRE_HUMAN');
});
check('C1-7/8: the union of both actors\' destinations is DENIED to either actor', () => {
  for (const scope of [IMPL_SCOPE, REVIEW_SCOPE]) {
    const union = { ...scope, egressDestinations: [...UNION] };
    assert.equal(actorCall(union).decision, 'DENIED', scope.actorKind);
    assert.equal(liveGate(union).decision, 'DENIED', scope.actorKind);
    assert.equal(actorCall(scope, union).decision, 'REQUIRE_HUMAN', `${scope.actorKind}: a union grant is not this actor's grant`);
  }
});
check('C1-9: one destination borrowed from the other actor is DENIED; so is a subset or another actor\'s provider or model', () => {
  const borrowed = [
    { ...IMPL_SCOPE, egressDestinations: [...IMPL_SET, REVIEW_SET[0]].sort() },
    { ...IMPL_SCOPE, egressDestinations: [IMPL_SET[0], REVIEW_SET[1]].sort() },
    { ...REVIEW_SCOPE, egressDestinations: [...REVIEW_SET, IMPL_SET[1]].sort() },
    { ...REVIEW_SCOPE, egressDestinations: [IMPL_SET[0], REVIEW_SET[1]].sort() },
    { ...IMPL_SCOPE, egressDestinations: [IMPL_SET[0]] },
    { ...IMPL_SCOPE, provider: REVIEW_SCOPE.provider },
    { ...IMPL_SCOPE, model: REVIEW_SCOPE.model },
    { ...REVIEW_SCOPE, provider: IMPL_SCOPE.provider, model: IMPL_SCOPE.model },
  ];
  for (const call of borrowed) assert.equal(actorCall(call).decision, 'DENIED', JSON.stringify(call));
});
check('C1: no fallback to another actor\'s entry; a one-actor packet authorizes only that actor', () => {
  const reviewOnly = actorPacket([REVIEW_SCOPE]);
  assert.equal(actorCall(REVIEW_SCOPE, REVIEW_SCOPE, reviewOnly).decision, 'AUTHORIZED');
  for (const call of [IMPL_SCOPE, { ...REVIEW_SCOPE, actorKind: 'IMPLEMENTATION' }]) {
    const result = actorCall(call, call, reviewOnly);
    assert.equal(result.decision, 'DENIED');
    assert.match(result.reason, /no packet call entry for this actor/);
  }
});
check('C1-10: a duplicate, out-of-order, or surplus actor entry is a malformed packet', () => {
  assert.ok(tryParsePacket(actorPacket()));
  for (const [calls, name] of [[[IMPL_SCOPE, IMPL_SCOPE], 'duplicate implementation'], [[REVIEW_SCOPE, REVIEW_SCOPE], 'duplicate review'],
    [[IMPL_SCOPE, { ...IMPL_SCOPE, egressDestinations: [...REVIEW_SET] }], 'duplicate implementation with another set'],
    [[REVIEW_SCOPE, IMPL_SCOPE], 'out of actor-kind order'], [[IMPL_SCOPE, REVIEW_SCOPE, IMPL_SCOPE], 'three entries']]) {
    assert.equal(tryParsePacket(actorPacket(calls)), undefined, name);
    assert.equal(actorCall(IMPL_SCOPE, IMPL_SCOPE, actorPacket(calls)).decision, 'DENIED', name);
  }
  for (const entry of [{ ...IMPL_SCOPE, provider: ' impl-provider' }, { ...IMPL_SCOPE, model: 'impl-model-1 ' }, { ...IMPL_SCOPE, extra: true },
    { ...IMPL_SCOPE, provider: 'impl\nprovider' }]) {
    assert.equal(tryParsePacket(actorPacket([entry, REVIEW_SCOPE])), undefined, JSON.stringify(entry));
  }
});
check('C1-11/12: a missing or unknown actorKind is refused in the packet, the call, and the grant', () => {
  const { actorKind: _omitted, ...noKind } = IMPL_SCOPE;
  for (const scope of [noKind, { ...IMPL_SCOPE, actorKind: 'REVIEW' }, { ...IMPL_SCOPE, actorKind: 'implementation' },
    { ...IMPL_SCOPE, actorKind: 'CONTROLLER' }, { ...IMPL_SCOPE, actorKind: '' }, { ...IMPL_SCOPE, actorKind: null }]) {
    const name = JSON.stringify(scope.actorKind);
    assert.equal(tryParsePacket(actorPacket([scope, REVIEW_SCOPE])), undefined, `packet ${name}`);
    assert.equal(tryParsePacket(actorPacket([scope])), undefined, `packet alone ${name}`);
    assert.equal(parseAuthorization(auth('HUMAN', 'LIVE_PROVIDER_MODEL_CALL', TARGET, { scope })), undefined, `grant ${name}`);
    assert.equal(actorCall(scope, IMPL_SCOPE).decision, 'DENIED', `call ${name}`);
    assert.equal(actorCall(IMPL_SCOPE, scope).decision, 'DENIED', `grant on call ${name}`);
  }
});
check('C1: the packet has one live-call authority; no packet-wide provider, model, or egress list is accepted', () => {
  for (const legacy of [{ providers: ['impl-provider'] }, { models: ['impl-model-1'] }, { egressDestinations: [...UNION] }]) {
    const livePacket = actorPacket();
    Object.assign(livePacket.providerCallAuthorization, legacy);
    assert.equal(tryParsePacket(livePacket), undefined, JSON.stringify(legacy));
  }
  const { calls: _calls, ...withoutCalls } = actorPacket().providerCallAuthorization;
  assert.equal(tryParsePacket(packet({ providerCallAuthorization: withoutCalls })), undefined);
});

// ---------------------------------------------------------------- cross-entry: transactional rejection
console.log('Cross-entry: rejected calls do not mutate');
check('refused lifecycle calls leave state, audit, and counters unchanged', () => {
  const { c } = make();
  rejectedWithoutMutation(c, () => c.beginAcceptanceReview('run-1', G));
  rejectedWithoutMutation(c, () => c.beginImplementation('run-1', G));
  rejectedWithoutMutation(c, () => c.issuePacket('run-1', G, packet({ packetId: 'packet-2', packetVersion: 2 })));
  c.beginImplementation('run-1', X); c.completeImplementation('run-1', X, ['e']);
  rejectedWithoutMutation(c, () => record(c, remote(B, 'work/other')));
  record(c); c.beginAcceptanceReview('run-1', G);
  rejectedWithoutMutation(c, () => c.decideAcceptance('run-1', X, decision(c)));
  rejectedWithoutMutation(c, () => c.decideAcceptance('run-1', G, { ...decision(c, 'REJECT'), findings: [] }));
  c.decideAcceptance('run-1', G, decision(c, 'REJECT'));
  rejectedWithoutMutation(c, () => c.beginImplementation('run-1', X));
  rejectedWithoutMutation(c, () => c.issueCorrection('run-1', G, { correctionPacketId: 'c' }));
  rejectedWithoutMutation(c, () => c.failClosed('run-1', G, 'not controller'));
  rejectedWithoutMutation(c, () => c.resumeSoft('run-1', K, 'not stopped'));
});
// ---------------------------------------------------------------- self-review additions
console.log('Self-review: runtime-private state and occurrence-bound promotion');
check('controller clock, store, and helpers are unreachable and the instance is frozen', () => {
  const { c, store } = make();
  for (const key of ['clock', 'store', 'commit', 'now', 'require', 'consumed', 'halt', 'runs']) {
    assert.equal(c[key], undefined, key); assert.equal(store[key], undefined, key);
  }
  assert.ok(Object.isFrozen(c) && Object.isFrozen(store));
  assert.throws(() => { c.clock = { now: () => '2020-01-01T00:00:00Z' }; }, TypeError);
  assert.throws(() => { c.decideAcceptance = () => undefined; }, TypeError);
  assert.throws(() => { store.replace = () => undefined; }, TypeError);
  assert.throws(() => { AutomationController.prototype.decideAcceptance = () => undefined; }, TypeError);
  assert.throws(() => { InMemoryControllerStore.prototype.replace = () => undefined; }, TypeError);
  assert.ok(Object.isFrozen(AutomationController.prototype) && Object.isFrozen(InMemoryControllerStore.prototype));
});
check('a promotion grant issued before the acceptance it would promote is refused', () => {
  const clock = movableClock(); const { c } = make(packet(), clock); ready(c);
  clock.value = '2026-09-26T00:10:00Z';
  c.decideAcceptance('run-1', G, decision(c));
  rejectedWithoutMutation(c, () => promote(c, preflight(), auth('HUMAN', 'FAST_FORWARD_MAIN', 'main')));
  const fresh = auth('HUMAN', 'FAST_FORWARD_MAIN', 'main', { authorizationId: 'fresh', issuedAt: '2026-09-26T08:10:00+08:00' });
  assert.equal(promote(c, preflight(), fresh).state, 'PROMOTION_READY');
});
check('a grant issued while a later-rejected SHA was under review cannot promote the SHA accepted after it', () => {
  const clock = movableClock(); const { c } = make(packet(), clock); ready(c, B);
  const early = auth('HUMAN', 'FAST_FORWARD_MAIN', 'main', { authorizationId: 'early' });
  c.decideAcceptance('run-1', G, decision(c, 'REJECT', B));
  c.issueCorrection('run-1', G, { correctionPacketId: 'c1', originalPacketId: 'packet-1',
    originalPacketHash: c.get('run-1').activePacketHash, rejectedSha: B, reviewerFindings: ['synthetic finding'],
    allowedCorrectionAreas: ['src/automation'], unchangedInvariantReferences: ['human authority retained'],
    expectedBaseSha: B, correctionIteration: 2, maxCorrectionIteration: 3 });
  clock.value = '2026-09-26T00:05:00Z';
  c.beginImplementation('run-1', X); c.completeImplementation('run-1', X, ['e']);
  record(c, remote(C)); c.beginAcceptanceReview('run-1', G);
  c.decideAcceptance('run-1', G, { ...decision(c, 'ACCEPT', C), reviewId: 'review-2' });
  rejectedWithoutMutation(c, () => promote(c, preflight({ acceptedSha: C }), early));
});
check('a stop cannot forge an interrupted state, and soft resume into ACCEPTED keeps the original GPT acceptance', () => {
  const { c, store } = make(); ready(c);
  const forged = store.get('run-1');
  forged.state = 'SOFT_STOP'; forged.interruptedState = 'ACCEPTED'; forged.stopReason = 'x';
  forged.stopId = `stop-${forged.audit.length + 1}`;
  forged.audit.push({ ...forged.audit.at(-1), sequence: forged.audit.length + 1, action: 'STOP', role: 'CONTROLLER',
    actor: 'controller', previousState: 'ACCEPTANCE_REVIEW', nextState: 'SOFT_STOP', stopReason: 'x', stopId: forged.stopId });
  assert.throws(() => store.replace(forged));
  c.decideAcceptance('run-1', G, decision(c));
  const acceptance = JSON.stringify(c.get('run-1').acceptance);
  c.stop('run-1', K, 'SOFT_STOP', 'synthetic'); c.resumeSoft('run-1', K, 'repair');
  assert.equal(c.get('run-1').state, 'ACCEPTED');
  assert.equal(JSON.stringify(c.get('run-1').acceptance), acceptance);
  assert.equal(c.audit('run-1').filter((entry) => entry.action === 'ACCEPT_EXACT_SHA').length, 1);
});
check('a stop raised inside an operation reuses its timestamp, so one clock read suffices', () => {
  const clock = movableClock();
  const { c } = make(packet({ iterationBudget: { ...packet().iterationBudget, maxAcceptanceFailuresPerSlice: 1 } }), clock);
  ready(c);
  clock.now = function oneShot() { const value = this.value; this.value = 'broken'; return value; };
  assert.equal(c.decideAcceptance('run-1', G, decision(c, 'REJECT')).state, 'HUMAN_STOP');
  assert.deepEqual(c.audit('run-1').slice(-2).map((entry) => [entry.action, entry.timestamp]),
    [['REJECT_EXACT_SHA', T], ['STOP', T]]);
});
check('automation modules import no network, subprocess, or provider code', () => {
  for (const name of ['lifecycle', 'time']) {
    const source = readFileSync(`src/automation/${name}.ts`, 'utf8');
    assert.doesNotMatch(source, /from ['"](?:node:(?:http|https|net|child_process)|openai|@anthropic-ai|@google\/generative-ai|@octokit)/);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
