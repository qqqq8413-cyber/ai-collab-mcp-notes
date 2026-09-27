import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutomationController } from './dist/automation/controller.js';
import { InMemoryControllerStore } from './dist/automation/audit.js';
import { FileControllerStore } from './dist/automation/durable-store.js';
import { AutomationRunner } from './dist/automation/runner.js';

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const T = '2026-09-27T00:00:00.000Z';
const G = { id: 'architect', role: 'GPT_ARCHITECT' }, X = { id: 'implementer', role: 'CODEX_IMPLEMENTER' };
const H = { id: 'human', role: 'HUMAN' }, K = { id: 'controller', role: 'CONTROLLER' };
const repo = 'synthetic/example', branch = 'work/synthetic-1';
const clock = { now: () => T };
const tests = [];
const check = (name, fn) => tests.push([name, fn]);

function packet(budget = {}) {
  return { packetId: 'packet-1', packetVersion: 1, sliceId: 'slice-1', expectedBaseSha: A, targetBranch: branch,
    objective: 'Offline runner fixture', allowedAreas: ['src/automation'], forbiddenChanges: ['src/stress-test'],
    invariants: ['human authority retained'], acceptanceCriteria: ['offline checks pass'],
    validationCommands: [{ commandId: 'npm-test', executable: 'npm', args: ['test'], cwd: '.', classification: 'OFFLINE_VALIDATION' }],
    networkAuthorization: { level: 'WRITE_EXTERNAL', destinations: [branch, 'main'], purpose: 'synthetic', budget: 1 },
    providerCallAuthorization: { allowed: false, providers: [], models: [], maxCalls: 0, budget: 0 },
    destructiveOperationAuthorization: { allowed: false },
    iterationBudget: { maxImplementationIterationsPerSlice: 3, maxAcceptanceFailuresPerSlice: 3,
      maxRuntimeMinutesPerIteration: 60, maxParallelImplementationAgents: 1, ...budget } };
}
function fakeReality() {
  const calls = [];
  return { calls, workSha: B, mainSha: A,
    observeBranch(repository, requested) { calls.push(`branch:${requested}`);
      return { repository, branch: requested, sha: requested === 'main' ? this.mainSha : this.workSha, observedAt: T }; },
    compare(repository, baseSha, headSha) { calls.push('compare');
      return { repository, baseSha, headSha, aheadBy: 1, behindBy: 0, hasBaseOnlyCommits: false, observedAt: T }; },
    observeCi(repository, requested, sha) { calls.push(`ci:${requested}`);
      return { repository, branch: requested, sha, workflowStatus: 'SUCCESS', requiredCheckName: 'test',
        requiredCheckStatus: 'SUCCESS', observedAt: T }; },
    observeProtection(repository, requested) { calls.push(`protection:${requested}`);
      return { repository, branch: requested, protected: true, requiredChecks: ['test'], observedAt: T }; } };
}
function make(budget, { store = new InMemoryControllerStore(), reality = fakeReality(), issue = true } = {}) {
  const c = new AutomationController(clock, store, reality);
  c.createRun('run-1', 'slice-1', repo);
  if (issue) { c.enterArchitecture('run-1', G); c.issuePacket('run-1', G, packet(budget)); }
  return { c, reality };
}
const completed = () => ({ status: 'COMPLETED', validationEvidence: ['npm run build: pass', 'npm test: pass'] });
function implementer(script = completed) {
  const port = { inputs: [], execute(input) { port.inputs.push(input); return script(input, port.inputs.length); } };
  return port;
}
function reviewer(script = (input) => ({ decision: accept(input) })) {
  const port = { inputs: [], review(input) { port.inputs.push(input); return script(input, port.inputs.length); } };
  return port;
}
function accept(input, overrides = {}) {
  return { reviewId: `review-${input.implementationIteration}`, actor: 'GPT_ARCHITECT', packetId: input.packet.packetId,
    packetHash: input.packetHash, reviewedSha: input.remoteSha.sha, decision: 'ACCEPT', findings: [],
    evidenceReferences: ['remote diff', 'branch CI'], issuedAt: T, ...overrides };
}
const reject = (input, overrides = {}) => accept(input, { decision: 'REJECT', findings: ['synthetic finding'], ...overrides });
function correctionFor(input, overrides = {}) {
  return { correctionPacketId: `correction-${input.implementationIteration + 1}`, originalPacketId: input.packet.packetId,
    originalPacketHash: input.packetHash, rejectedSha: input.remoteSha.sha, reviewerFindings: ['synthetic finding'],
    allowedCorrectionAreas: ['src/automation'], unchangedInvariantReferences: [...input.packet.invariants],
    expectedBaseSha: input.remoteSha.sha, correctionIteration: input.implementationIteration + 1,
    maxCorrectionIteration: 3, ...overrides };
}
function grant(operation, target) {
  return { authorizationId: `auth-${operation}-${target}`, actorRole: 'HUMAN', operation, target, runId: 'run-1',
    packetId: 'packet-1', issuedAt: T, reason: 'offline fixture' };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function withDir(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chief-g1-r3a-'));
    try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
}
const states = (c) => c.audit('run-1').map((entry) => entry.nextState);
const actions = (c) => c.audit('run-1').map((entry) => entry.action);

check('accept path: one controller transition per step, reality SHA, then the human gate', async () => {
  const { c, reality } = make(); const impl = implementer(); const rev = reviewer();
  const runner = new AutomationRunner(c, impl, rev);
  const seen = [];
  for (let index = 0; index < 5; index++) {
    const result = await runner.step('run-1');
    seen.push([result.outcome, result.state, impl.inputs.length, rev.inputs.length]);
  }
  // The agent is not called in the step that enters IMPLEMENTING, nor the reviewer in the one entering review.
  assert.deepEqual(seen, [['ADVANCED', 'IMPLEMENTING', 0, 0], ['ADVANCED', 'IMPLEMENTATION_COMPLETE', 1, 0],
    ['ADVANCED', 'REMOTE_SHA_READY', 1, 0], ['ADVANCED', 'ACCEPTANCE_REVIEW', 1, 0], ['HUMAN_PROMOTION_REQUIRED', 'ACCEPTED', 1, 1]]);
  const run = c.get('run-1');
  assert.equal(run.remoteSha.sha, B);
  assert.equal(run.acceptance.reviewedSha, B);
  assert.deepEqual(rev.inputs[0].remoteSha, run.remoteSha);
  assert.deepEqual(c.audit('run-1').slice(-5).map((entry) => [entry.action, entry.role, entry.actor]), [
    ['BEGIN_IMPLEMENTATION', 'CODEX_IMPLEMENTER', 'automation-implementation-agent'],
    ['REPORT_IMPLEMENTATION_COMPLETE', 'CODEX_IMPLEMENTER', 'automation-implementation-agent'],
    ['RECORD_REMOTE_SHA', 'CODEX_IMPLEMENTER', 'automation-implementation-agent'],
    ['BEGIN_REMOTE_ACCEPTANCE', 'GPT_ARCHITECT', 'automation-architect-review'],
    ['ACCEPT_EXACT_SHA', 'GPT_ARCHITECT', 'automation-architect-review']]);
  // Only the work branch was read; main, comparison, CI, and protection were never touched.
  assert.ok(reality.calls.length > 0 && reality.calls.every((call) => call === `branch:${branch}`), reality.calls.join());
});
check('an implementation-reported SHA is refused; recorded SHAs come only from repository reality', async () => {
  for (const extra of [{ remoteSha: { repository: repo, branch, sha: C, observedAt: T, source: 'GITHUB' } }, { sha: C }]) {
    const { c } = make(); const rev = reviewer();
    const runner = new AutomationRunner(c, implementer(() => ({ ...completed(), ...extra })), rev);
    await runner.step('run-1');
    const result = await runner.step('run-1');
    assert.equal(result.state, 'HUMAN_STOP');
    assert.match(result.stopReason, /outside the bridge contract/);
    assert.equal(c.get('run-1').remoteSha, undefined);
    assert.equal((await runner.drive('run-1', 5)).outcome, 'STOPPED');
    assert.equal(rev.inputs.length, 0);
  }
});
check('no implementation result can move the run past IMPLEMENTATION_COMPLETE', async () => {
  const results = [{ status: 'ACCEPTED' }, { status: 'PROMOTION_READY' }, { status: 'REMOTE_SHA_READY', validationEvidence: ['x'] },
    { ...completed(), acceptance: { decision: 'ACCEPT' } }, { ...completed(), state: 'ACCEPTED' },
    { ...completed(), promotion: { target: 'main' } }, { ...completed(), humanAuthorization: { actorRole: 'HUMAN' } },
    { ...completed(), mainSha: C }, { ...completed(), ci: 'SUCCESS' }, { ...completed(), branchProtection: { protected: true } }];
  for (const result of results) {
    const { c } = make(); const runner = new AutomationRunner(c, implementer(() => result), reviewer());
    const final = await runner.drive('run-1', 10);
    assert.equal(final.state, 'HUMAN_STOP', JSON.stringify(result));
    assert.ok(!states(c).some((state) => ['IMPLEMENTATION_COMPLETE', 'REMOTE_SHA_READY', 'ACCEPTED', 'PROMOTION_READY'].includes(state)));
  }
  const { c } = make(); const runner = new AutomationRunner(c, implementer(), reviewer());
  await runner.step('run-1');
  assert.equal((await runner.step('run-1')).state, 'IMPLEMENTATION_COMPLETE');
});
check('reject path: correction through the controller, new iteration and SHA, second review accepts', async () => {
  const { c, reality } = make();
  const impl = implementer((input) => { if (input.implementationIteration === 2) reality.workSha = C; return completed(); });
  const rev = reviewer((input, call) => call === 1 ? { decision: reject(input), correction: correctionFor(input) } : { decision: accept(input) });
  const result = await new AutomationRunner(c, impl, rev).drive('run-1', 20);
  assert.deepEqual([result.outcome, result.state, result.steps], ['HUMAN_PROMOTION_REQUIRED', 'ACCEPTED', 10]);
  const run = c.get('run-1');
  assert.deepEqual([run.implementationIterations, run.acceptanceFailures, run.remoteSha.sha, run.acceptance.reviewedSha], [2, 1, C, C]);
  assert.equal('correction' in impl.inputs[0], false);
  assert.deepEqual(impl.inputs[1].correction, run.correctionPacket);
  assert.deepEqual([rev.inputs[1].remoteSha.sha, rev.inputs[1].acceptanceFailures, rev.inputs[1].implementationIteration,
    rev.inputs[1].correction.correctionIteration], [C, 1, 2, 2]);
  assert.deepEqual(actions(c).filter((action) => ['REJECT_EXACT_SHA', 'ISSUE_CORRECTION_PACKET', 'BEGIN_IMPLEMENTATION',
    'ACCEPT_EXACT_SHA'].includes(action)), ['BEGIN_IMPLEMENTATION', 'REJECT_EXACT_SHA', 'ISSUE_CORRECTION_PACKET',
    'BEGIN_IMPLEMENTATION', 'ACCEPT_EXACT_SHA']);
});
check('budgets stay the controller\'s: exhausted acceptance failures stop for a human', async () => {
  const { c } = make({ maxAcceptanceFailuresPerSlice: 1 });
  const impl = implementer(); const rev = reviewer((input) => ({ decision: reject(input), correction: correctionFor(input) }));
  const runner = new AutomationRunner(c, impl, rev);
  const result = await runner.drive('run-1', 20);
  assert.deepEqual([result.outcome, result.state, result.stopReason], ['STOPPED', 'HUMAN_STOP', 'acceptance failure budget exhausted']);
  assert.equal(c.get('run-1').correctionPacket, undefined);
  await runner.drive('run-1', 5);
  assert.deepEqual([impl.inputs.length, rev.inputs.length, c.get('run-1').acceptanceFailures], [1, 1, 1]);
});
check('a REJECT without a correction waits; the runner never writes one', async () => {
  const { c } = make(); const impl = implementer();
  const rev = reviewer((input, call) => call === 1 ? { decision: reject(input) } : { decision: accept(input) });
  const runner = new AutomationRunner(c, impl, rev);
  assert.deepEqual([(await runner.drive('run-1', 20)).outcome, c.get('run-1').state], ['AWAITING_CORRECTION', 'CORRECTION_REQUIRED']);
  const length = c.audit('run-1').length;
  assert.equal((await runner.drive('run-1', 5)).outcome, 'AWAITING_CORRECTION');
  assert.deepEqual([c.audit('run-1').length, impl.inputs.length], [length, 1]);
  // A correction the architect issues through the controller itself lets the run continue.
  c.issueCorrection('run-1', G, correctionFor(rev.inputs[0]));
  assert.equal((await runner.drive('run-1', 20)).outcome, 'HUMAN_PROMOTION_REQUIRED');
  assert.equal(impl.inputs.length, 2);
});
check('a decision that does not bind the packet and remote SHA stops for the architect, never ACCEPTED', async () => {
  const variants = {
    'wrong packetId': (input) => accept(input, { packetId: 'packet-other' }),
    'wrong packetHash': (input) => accept(input, { packetHash: 'e'.repeat(64) }),
    'wrong reviewedSha': (input) => accept(input, { reviewedSha: C }),
    'REJECT without findings': (input) => reject(input, { findings: [] }),
    'future issuedAt': (input) => accept(input, { issuedAt: '2026-09-27T00:00:01.000Z' }),
    'malformed packetHash': (input) => accept(input, { packetHash: 'short' }),
    'human actor': (input) => accept(input, { actor: 'HUMAN' }),
  };
  for (const [label, decide] of Object.entries(variants)) {
    const { c } = make(); const rev = reviewer((input) => ({ decision: decide(input) }));
    const runner = new AutomationRunner(c, implementer(), rev);
    const result = await runner.drive('run-1', 20);
    assert.deepEqual([result.outcome, result.state], ['STOPPED', 'ARCHITECTURE_STOP'], label);
    assert.match(result.stopReason, /does not bind the active packet and remote SHA/, label);
    const run = c.get('run-1');
    assert.deepEqual([run.acceptance, run.acceptanceFailures, run.interruptedState], [undefined, 0, 'ACCEPTANCE_REVIEW'], label);
    assert.ok(!actions(c).includes('ACCEPT_EXACT_SHA'), label);
    await runner.drive('run-1', 5);
    assert.equal(rev.inputs.length, 1, label);
  }
});
check('a malformed correction is refused by the controller; the REJECT stands and the run waits', async () => {
  const variants = {
    'rejectedSha': { rejectedSha: C }, 'expectedBaseSha': { expectedBaseSha: C }, 'invented findings': { reviewerFindings: ['other'] },
    'skipped iteration': { correctionIteration: 3 }, 'repeated iteration': { correctionIteration: 1 },
    'area outside packet': { allowedCorrectionAreas: ['src/stress-test'] }, 'changed invariants': { unchangedInvariantReferences: ['none'] },
    'raised budget': { maxCorrectionIteration: 4 }, 'extra field': { promote: true }, 'other packet hash': { originalPacketHash: 'e'.repeat(64) },
  };
  for (const [label, change] of Object.entries(variants)) {
    const { c } = make(); const impl = implementer();
    const runner = new AutomationRunner(c, impl, reviewer((input) => ({ decision: reject(input), correction: correctionFor(input, change) })));
    const result = await runner.drive('run-1', 20);
    assert.deepEqual([result.outcome, result.state], ['AWAITING_CORRECTION', 'CORRECTION_REQUIRED'], label);
    assert.match(result.detail, /correction refused by controller/, label);
    assert.deepEqual([c.get('run-1').correctionPacket, c.get('run-1').acceptanceFailures], [undefined, 1], label);
    assert.equal((await runner.drive('run-1', 5)).outcome, 'AWAITING_CORRECTION', label);
    assert.equal(impl.inputs.length, 1, label);
  }
});
check('an unusable or contradictory review bundle never reaches ACCEPTED', async () => {
  const bundles = {
    'ACCEPT with correction': (input) => ({ decision: accept(input), correction: correctionFor(input) }),
    'promotion field': (input) => ({ decision: accept(input), promotion: { target: 'main' } }),
    'main SHA field': (input) => ({ decision: accept(input), mainSha: input.remoteSha.sha }),
    'human authorization': (input) => ({ decision: accept(input), humanAuthorization: { actorRole: 'HUMAN' } }),
    'packet override': (input) => ({ decision: accept(input), activePacket: { ...input.packet, objective: 'x' } }),
    'remote SHA override': (input) => ({ decision: accept(input), remoteSha: { ...input.remoteSha, sha: C } }),
    'bare decision': (input) => accept(input), 'null': () => null, 'text': () => 'ACCEPT',
  };
  for (const [label, bundle] of Object.entries(bundles)) {
    const { c } = make(); const runner = new AutomationRunner(c, implementer(), reviewer(bundle));
    const result = await runner.drive('run-1', 20);
    assert.deepEqual([result.state, c.get('run-1').acceptance], ['ARCHITECTURE_STOP', undefined], label);
    assert.ok(!states(c).includes('ACCEPTED'), label);
  }
});
check('actors cannot alter the packet, packet hash, or remote SHA evidence they are given', async () => {
  const { c } = make(); const before = c.get('run-1');
  const refused = [];
  const attempt = (fn) => { try { fn(); } catch (error) { refused.push(error instanceof TypeError); } };
  const impl = implementer((input) => {
    attempt(() => { input.packet.objective = 'widened'; }); attempt(() => { input.packet.allowedAreas.push('src/stress-test'); });
    attempt(() => { input.packetHash = 'e'.repeat(64); });
    return completed();
  });
  const rev = reviewer((input) => {
    attempt(() => { input.remoteSha.sha = C; }); attempt(() => { input.packet.invariants.length = 0; });
    attempt(() => { input.acceptanceFailures = 0; });
    return { decision: accept(input) };
  });
  assert.equal((await new AutomationRunner(c, impl, rev).drive('run-1', 20)).state, 'ACCEPTED');
  assert.deepEqual(refused, [true, true, true, true, true, true]);
  const run = c.get('run-1');
  assert.deepEqual([run.activePacket, run.activePacketHash, run.remoteSha.sha], [before.activePacket, before.activePacketHash, B]);
  assert.ok(!actions(c).includes('AUTHORIZE_PROMOTION'));
});
check('restart in IMPLEMENTING: a new runner never replays the implementation agent', withDir(async (dir) => {
  const reality = fakeReality();
  const { c } = make(undefined, { store: new FileControllerStore(dir), reality });
  const implA = implementer(); const runnerA = new AutomationRunner(c, implA, reviewer());
  assert.equal((await runnerA.step('run-1')).state, 'IMPLEMENTING');
  const restarted = new AutomationController(clock, new FileControllerStore(dir), reality);
  const implB = implementer(); const runnerB = new AutomationRunner(restarted, implB, reviewer());
  const result = await runnerB.step('run-1');
  assert.deepEqual([result.outcome, result.state], ['STOPPED', 'HUMAN_STOP']);
  assert.match(result.stopReason, /uncertain implementation-agent side effect after runner restart/);
  assert.deepEqual([implA.inputs.length, implB.inputs.length, restarted.get('run-1').interruptedState], [0, 0, 'IMPLEMENTING']);
  assert.equal((await runnerA.step('run-1')).outcome, 'STOPPED');
  assert.equal(implA.inputs.length, 0);
}));
check('restart in ACCEPTANCE_REVIEW: a new runner never replays the architect review', withDir(async (dir) => {
  const reality = fakeReality();
  const { c } = make(undefined, { store: new FileControllerStore(dir), reality });
  const revA = reviewer(); const runnerA = new AutomationRunner(c, implementer(), revA);
  assert.equal((await runnerA.drive('run-1', 4)).state, 'ACCEPTANCE_REVIEW');
  const restarted = new AutomationController(clock, new FileControllerStore(dir), reality);
  const revB = reviewer(); const runnerB = new AutomationRunner(restarted, implementer(), revB);
  const result = await runnerB.step('run-1');
  assert.deepEqual([result.outcome, result.state], ['STOPPED', 'HUMAN_STOP']);
  assert.match(result.stopReason, /uncertain architect-review side effect after runner restart/);
  assert.deepEqual([revA.inputs.length, revB.inputs.length, restarted.get('run-1').acceptance], [0, 0, undefined]);
  assert.equal((await runnerA.step('run-1')).outcome, 'STOPPED');
}));
check('restart at a state with no pending actor call continues from repository reality', withDir(async (dir) => {
  for (const [steps, expectedState, implCalls] of [[0, 'PACKET_READY', 1], [2, 'IMPLEMENTATION_COMPLETE', 0], [3, 'REMOTE_SHA_READY', 0]]) {
    rmSync(dir, { recursive: true, force: true });
    const reality = fakeReality();
    const { c } = make(undefined, { store: new FileControllerStore(dir), reality });
    if (steps) await new AutomationRunner(c, implementer(), reviewer()).drive('run-1', steps);
    assert.equal(c.get('run-1').state, expectedState);
    const implB = implementer(); const revB = reviewer();
    const restarted = new AutomationController(clock, new FileControllerStore(dir), reality);
    const result = await new AutomationRunner(restarted, implB, revB).drive('run-1', 10);
    assert.deepEqual([result.state, implB.inputs.length, revB.inputs.length], ['ACCEPTED', implCalls, 1], expectedState);
  }
}));
check('agent stop classes map exactly to controller stops, with no retry', async () => {
  for (const status of ['SOFT_STOP', 'ARCHITECTURE_STOP', 'HUMAN_STOP']) {
    const { c } = make(); const impl = implementer(() => ({ status, reason: 'blocked by synthetic defect' }));
    const runner = new AutomationRunner(c, impl, reviewer());
    const result = await runner.drive('run-1', 10);
    assert.deepEqual([result.outcome, result.state, c.get('run-1').interruptedState], ['STOPPED', status, 'IMPLEMENTING']);
    assert.equal(result.stopReason, `implementation agent reported ${status}: blocked by synthetic defect`);
    const last = c.audit('run-1').at(-1);
    assert.deepEqual([last.action, last.role, last.actor], ['STOP', 'CONTROLLER', 'automation-runner']);
    await runner.drive('run-1', 5);
    assert.equal(impl.inputs.length, 1);
  }
});
check('an actor call that throws or rejects stops for a human and is never replayed', async () => {
  const failures = { 'sync throw': () => { throw new Error('agent crashed'); }, 'rejected promise': () => Promise.reject(new Error('agent lost')) };
  for (const [label, fail] of Object.entries(failures)) {
    const { c } = make(); const impl = implementer(fail); const runner = new AutomationRunner(c, impl, reviewer());
    const result = await runner.drive('run-1', 10);
    assert.deepEqual([result.state, result.stopReason], ['HUMAN_STOP',
      'implementation-agent call returned no result; uncertain side effect; not replayed'], label);
    assert.match(result.detail, /agent (crashed|lost)/);
    await runner.drive('run-1', 5);
    assert.equal(impl.inputs.length, 1, label);
    const reviewed = make(); const rev = reviewer(fail);
    const stopped = await new AutomationRunner(reviewed.c, implementer(), rev).drive('run-1', 10);
    assert.deepEqual([stopped.state, stopped.stopReason, rev.inputs.length], ['HUMAN_STOP',
      'architect-review call returned no result; uncertain side effect; not replayed', 1], label);
  }
});
check('a work branch moved after SHA evidence stops before or during review, as the controller decides', async () => {
  const early = make(); const revEarly = reviewer();
  const runner = new AutomationRunner(early.c, implementer(), revEarly);
  await runner.drive('run-1', 3);
  early.reality.workSha = C;
  const result = await runner.step('run-1');
  assert.deepEqual([result.state, result.stopReason, revEarly.inputs.length],
    ['ARCHITECTURE_STOP', 'work branch moved after remote SHA evidence', 0]);
  const late = make();
  const moved = await new AutomationRunner(late.c, implementer(), reviewer((input) => {
    late.reality.workSha = C; return { decision: accept(input) };
  })).drive('run-1', 10);
  assert.deepEqual([moved.state, moved.stopReason, late.c.get('run-1').acceptance],
    ['ARCHITECTURE_STOP', 'work branch moved during acceptance', undefined]);
});
check('human gate: ACCEPTED is final for the runner', async () => {
  const { c, reality } = make(); const impl = implementer(); const rev = reviewer();
  const runner = new AutomationRunner(c, impl, rev);
  assert.equal((await runner.drive('run-1', 10)).outcome, 'HUMAN_PROMOTION_REQUIRED');
  const length = c.audit('run-1').length, reads = reality.calls.length;
  for (let index = 0; index < 5; index++) {
    assert.deepEqual([(await runner.step('run-1')).outcome, c.get('run-1').state], ['HUMAN_PROMOTION_REQUIRED', 'ACCEPTED']);
  }
  const driven = await runner.drive('run-1', 10);
  assert.deepEqual([driven.outcome, driven.steps], ['HUMAN_PROMOTION_REQUIRED', 1]);
  assert.deepEqual([c.audit('run-1').length, reality.calls.length, impl.inputs.length, rev.inputs.length], [length, reads, 1, 1]);
  assert.ok(!reality.calls.some((call) => call.includes('main')));
  assert.equal(c.get('run-1').promotionAuthorization, undefined);
});
check('bounded drive: a finite positive maxSteps only, and exhaustion is reported', async () => {
  const { c } = make(); const impl = implementer(); const runner = new AutomationRunner(c, impl, reviewer());
  for (const bad of [undefined, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '3', 2 ** 53]) {
    await assert.rejects(runner.drive('run-1', bad), RangeError, String(bad));
  }
  await assert.rejects(runner.drive('run-1'), RangeError);
  assert.deepEqual([c.get('run-1').state, impl.inputs.length], ['PACKET_READY', 0]);
  assert.deepEqual(Object.values(await runner.drive('run-1', 2)), ['run-1', 'STEP_LIMIT_REACHED', 'IMPLEMENTATION_COMPLETE', 2]);
  assert.deepEqual([(await runner.drive('run-1', 1)).outcome, c.get('run-1').state], ['STEP_LIMIT_REACHED', 'REMOTE_SHA_READY']);
  const done = await runner.drive('run-1', 10);
  assert.deepEqual([done.outcome, done.state, done.steps], ['HUMAN_PROMOTION_REQUIRED', 'ACCEPTED', 2]);
});
check('states outside the runner are left untouched', async () => {
  const idle = make(undefined, { issue: false });
  const impl = implementer(); const rev = reviewer();
  assert.equal((await new AutomationRunner(idle.c, impl, rev).step('run-1')).outcome, 'OUT_OF_SCOPE');
  idle.c.enterArchitecture('run-1', G);
  assert.equal((await new AutomationRunner(idle.c, impl, rev).step('run-1')).outcome, 'OUT_OF_SCOPE');
  const { c, reality } = make(); const runner = new AutomationRunner(c, impl, rev);
  await runner.drive('run-1', 10);
  const expect = async (outcome) => {
    const length = c.audit('run-1').length;
    assert.deepEqual([(await runner.step('run-1')).outcome, c.audit('run-1').length], [outcome, length], c.get('run-1').state);
  };
  c.requestPromotion('run-1', H, grant('FAST_FORWARD_MAIN', 'main')); await expect('OUT_OF_SCOPE');
  c.beginPromotion('run-1', K); await expect('OUT_OF_SCOPE');
  reality.mainSha = B; c.recordPromotedMain('run-1', K); await expect('OUT_OF_SCOPE');
  c.close('run-1', K); await expect('TERMINAL');
  const failed = make(); failed.c.failClosed('run-1', K, 'synthetic');
  assert.equal((await new AutomationRunner(failed.c, impl, rev).step('run-1')).outcome, 'TERMINAL');
  assert.deepEqual([impl.inputs.length, rev.inputs.length], [1, 1]);
});
check('a pending external recheck after a human resume is left to reconciliation', async () => {
  const { c } = make(); c.stop('run-1', K, 'HUMAN_STOP', 'pause');
  c.resumeHuman('run-1', H, grant('RESUME_HUMAN_STOP', c.get('run-1').stopId));
  const impl = implementer(); const length = c.audit('run-1').length;
  const result = await new AutomationRunner(c, impl, reviewer()).step('run-1');
  assert.deepEqual([result.outcome, result.state, c.audit('run-1').length, impl.inputs.length],
    ['EXTERNAL_RECHECK_REQUIRED', 'PACKET_READY', length, 0]);
});
check('a late actor result after the run moved on is discarded, never recorded', async () => {
  for (const resume of [false, true]) {
    const { c } = make(); const pending = deferred();
    const runnerA = new AutomationRunner(c, implementer(() => pending.promise), reviewer());
    await runnerA.step('run-1');
    const inFlight = runnerA.step('run-1');
    assert.equal((await new AutomationRunner(c, implementer(), reviewer()).step('run-1')).state, 'HUMAN_STOP');
    if (resume) c.resumeHuman('run-1', H, grant('RESUME_HUMAN_STOP', c.get('run-1').stopId));
    pending.resolve(completed());
    const result = await inFlight;
    assert.equal(result.outcome, 'ACTOR_RESULT_DISCARDED');
    assert.equal(c.get('run-1').state, resume ? 'IMPLEMENTING' : 'HUMAN_STOP');
    assert.ok(!actions(c).includes('REPORT_IMPLEMENTATION_COMPLETE'));
  }
});
check('one runner never runs two steps of the same run at once', async () => {
  const { c } = make(); const pending = deferred(); const impl = implementer(() => pending.promise);
  const runner = new AutomationRunner(c, impl, reviewer());
  await runner.step('run-1');
  const inFlight = runner.step('run-1');
  await assert.rejects(runner.step('run-1'), /already in progress/);
  pending.resolve(completed());
  assert.deepEqual([(await inFlight).state, impl.inputs.length], ['IMPLEMENTATION_COMPLETE', 1]);
});

// G1-R3A-A1: an actor result applies only to the exact audit occurrence it was called for.
/** Stop, human resume, and recheck through a legitimate controller: the same state, a later occurrence, no recheck pending. */
function interruptAndResume(controller) {
  controller.stop('run-1', K, 'HUMAN_STOP', 'interrupted by another writer');
  controller.resumeHuman('run-1', H, grant('RESUME_HUMAN_STOP', controller.get('run-1').stopId));
  return controller.reconcile('run-1', K);
}
/**
 * A FileControllerStore with one-shot hooks, so another writer can change the durable
 * run at an exact point inside a controller operation: before a read, just before the
 * store write, or just after it.
 */
function racingStore(dir) {
  const inner = new FileControllerStore(dir);
  const fire = (name) => { const hook = store[name]; if (!hook) return; if (hook.skip) { hook.skip -= 1; return; } store[name] = undefined; hook.run(); };
  const store = { beforeGet: undefined, beforeWrite: undefined, afterWrite: undefined,
    create: (run) => inner.create(run), replace: (run) => inner.replace(run), entries: (runId) => inner.entries(runId),
    get(runId) { fire('beforeGet'); return inner.get(runId); },
    bindController() {
      const write = inner.bindController();
      return (run) => { fire('beforeWrite'); write(run); fire('afterWrite'); };
    } };
  return store;
}
function racing(dir) {
  const reality = fakeReality(); const store = racingStore(dir);
  const { c } = make(undefined, { store, reality });
  return { c, store, other: new AutomationController(clock, new FileControllerStore(dir), reality) };
}

check('implementation race: result A never completes or stops a resumed IMPLEMENTING occurrence', async () => {
  const outcomes = { completed, 'stop class': () => ({ status: 'SOFT_STOP', reason: 'late' }),
    'malformed': () => ({ ...completed(), sha: C }), 'thrown': () => { throw new Error('late failure'); } };
  for (const [label, late] of Object.entries(outcomes)) {
    const { c } = make(); const pending = deferred();
    const impl = implementer(() => pending.promise.then(late));
    const runner = new AutomationRunner(c, impl, reviewer());
    await runner.step('run-1');
    const inFlight = runner.step('run-1');
    interruptAndResume(c);
    const length = c.audit('run-1').length;
    pending.resolve();
    const result = await inFlight;
    assert.deepEqual([result.outcome, result.state], ['ACTOR_RESULT_DISCARDED', 'IMPLEMENTING'], label);
    assert.deepEqual([c.audit('run-1').length, c.audit('run-1').at(-1).action], [length, 'RECHECK_EXTERNAL_REALITY'], label);
    assert.ok(!actions(c).includes('REPORT_IMPLEMENTATION_COMPLETE'), label);
    assert.equal(impl.inputs.length, 1, label);
  }
});
check('acceptance race: review result A never ACCEPTs, REJECTs, or stops a resumed ACCEPTANCE_REVIEW occurrence', async () => {
  const bundles = { accept: (input) => ({ decision: accept(input) }),
    'reject with correction': (input) => ({ decision: reject(input), correction: correctionFor(input) }),
    'malformed': (input) => ({ decision: accept(input, { reviewedSha: C }) }), 'thrown': () => { throw new Error('late failure'); } };
  for (const [label, late] of Object.entries(bundles)) {
    const { c } = make(); const pending = deferred();
    const rev = reviewer((input) => pending.promise.then(() => late(input)));
    const runner = new AutomationRunner(c, implementer(), rev);
    await runner.drive('run-1', 4);
    const inFlight = runner.step('run-1');
    interruptAndResume(c);
    const length = c.audit('run-1').length;
    pending.resolve();
    const result = await inFlight;
    assert.deepEqual([result.outcome, result.state], ['ACTOR_RESULT_DISCARDED', 'ACCEPTANCE_REVIEW'], label);
    const run = c.get('run-1');
    assert.deepEqual([c.audit('run-1').length, run.acceptance, run.acceptanceFailures, run.correctionPacket], [length, undefined, 0, undefined], label);
    assert.ok(!actions(c).some((action) => ['ACCEPT_EXACT_SHA', 'REJECT_EXACT_SHA'].includes(action)), label);
    assert.equal(rev.inputs.length, 1, label);
  }
});
check('store race: a writer inside the controller\'s write window makes the guarded write fail, never land', withDir(async (dir) => {
  const direct = racing(dir);
  direct.c.beginImplementation('run-1', X);
  const begun = direct.c.audit('run-1').at(-1);
  direct.store.beforeWrite = { run: () => interruptAndResume(direct.other) };
  assert.throws(() => direct.c.completeImplementationForOccurrence('run-1', X,
    { runId: 'run-1', sequence: begun.sequence, action: begun.action, timestamp: begun.timestamp }, ['pass']), /append-only/);
  assert.deepEqual([direct.other.get('run-1').state, direct.other.audit('run-1').at(-1).action], ['IMPLEMENTING', 'RECHECK_EXTERNAL_REALITY']);
  assert.ok(!actions(direct.other).includes('REPORT_IMPLEMENTATION_COMPLETE'));
}));
check('store race through the runner: completion and decision lose to the other writer and are discarded', withDir(async (dir) => {
  for (const phase of ['IMPLEMENTING', 'ACCEPTANCE_REVIEW']) {
    rmSync(dir, { recursive: true, force: true });
    const { c, store, other } = racing(dir); const impl = implementer(); const rev = reviewer();
    const runner = new AutomationRunner(c, impl, rev);
    await runner.drive('run-1', phase === 'IMPLEMENTING' ? 1 : 4);
    let length;
    store.beforeWrite = { run: () => { interruptAndResume(other); length = other.audit('run-1').length; } };
    const result = await runner.step('run-1');
    assert.deepEqual([result.outcome, result.state], ['ACTOR_RESULT_DISCARDED', phase]);
    assert.equal(other.audit('run-1').length, length, 'nothing written after the other writer, not even a stop');
    assert.ok(!actions(other).includes(phase === 'IMPLEMENTING' ? 'REPORT_IMPLEMENTATION_COMPLETE' : 'ACCEPT_EXACT_SHA'));
    assert.deepEqual([impl.inputs.length, rev.inputs.length], [1, phase === 'IMPLEMENTING' ? 0 : 1]);
  }
}));
check('a correction from review A is bound to A\'s rejection, not to a resumed CORRECTION_REQUIRED', withDir(async (dir) => {
  const { c, store, other } = racing(dir); const impl = implementer();
  const runner = new AutomationRunner(c, impl, reviewer((input) => ({ decision: reject(input), correction: correctionFor(input) })));
  await runner.drive('run-1', 4);
  // The REJECT commits; before the correction is read and written, another writer interrupts and resumes.
  store.afterWrite = { run: () => interruptAndResume(other) };
  const result = await runner.step('run-1');
  assert.deepEqual([result.outcome, result.state], ['ACTOR_RESULT_DISCARDED', 'CORRECTION_REQUIRED']);
  const run = other.get('run-1');
  assert.deepEqual([run.acceptanceFailures, run.correctionPacket, other.audit('run-1').at(-1).action], [1, undefined, 'RECHECK_EXTERNAL_REALITY']);
  assert.equal((await runner.drive('run-1', 3)).outcome, 'AWAITING_CORRECTION');
  assert.equal(impl.inputs.length, 1);
}));
check('a restart stop decided from an observed occurrence never stops a later one', withDir(async (dir) => {
  const { c, store, other } = racing(dir);
  await new AutomationRunner(other, implementer(), reviewer()).step('run-1');
  const impl = implementer(); const runner = new AutomationRunner(c, impl, reviewer());
  // Between this runner's read of IMPLEMENTING and the controller's read inside its stop, the owner completes.
  store.beforeGet = { skip: 1, run: () => other.completeImplementation('run-1', X, ['pass']) };
  const result = await runner.step('run-1');
  assert.deepEqual([result.outcome, result.state], ['STALE_OCCURRENCE', 'IMPLEMENTATION_COMPLETE']);
  assert.ok(!actions(other).includes('STOP'));
  assert.equal(impl.inputs.length, 0);
}));

let passed = 0, failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`  PASS ${name}`); passed++; }
  catch (error) { console.error(`  FAIL ${name}: ${error.stack}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
