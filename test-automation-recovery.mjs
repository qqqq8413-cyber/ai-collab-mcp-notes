import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutomationController } from './dist/automation/controller.js';
import { FileControllerStore } from './dist/automation/durable-store.js';

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const T = '2026-09-26T00:00:00.000Z';
const G = { id: 'architect', role: 'GPT_ARCHITECT' }, X = { id: 'implementer', role: 'CODEX_IMPLEMENTER' };
const H = { id: 'human', role: 'HUMAN' }, K = { id: 'controller', role: 'CONTROLLER' };
const clock = { now: () => T }, repo = 'synthetic/example', branch = 'work/synthetic-1';
let passed = 0, failed = 0;
function check(name, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'chief-r2-recovery-'));
  try { fn(dir); console.log(`  PASS ${name}`); passed++; }
  catch (error) { console.error(`  FAIL ${name}: ${error.stack}`); failed++; }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
function packet() {
  return { packetId: 'packet-1', packetVersion: 1, sliceId: 'slice-1', expectedBaseSha: A,
    targetBranch: branch, objective: 'Offline fixture', allowedAreas: ['src/automation'],
    forbiddenChanges: ['src/stress-test'], invariants: ['human authority'], acceptanceCriteria: ['checks pass'],
    validationCommands: [{ commandId: 'test', executable: 'npm', args: ['test'], cwd: '.', classification: 'OFFLINE_VALIDATION' }],
    networkAuthorization: { level: 'WRITE_EXTERNAL', destinations: ['main', branch], purpose: 'fixture', budget: 1 },
    providerCallAuthorization: { allowed: false, providers: [], models: [], maxCalls: 0, budget: 0 },
    destructiveOperationAuthorization: { allowed: false },
    iterationBudget: { maxImplementationIterationsPerSlice: 3, maxAcceptanceFailuresPerSlice: 3,
      maxRuntimeMinutesPerIteration: 60, maxParallelImplementationAgents: 1 } };
}
function reality() {
  return { workSha: B, mainSha: A, aheadBy: 1, behindBy: 0, hasBaseOnlyCommits: false,
    workCi: 'SUCCESS', mainCi: 'SUCCESS', workCheck: 'SUCCESS', mainCheck: 'SUCCESS',
    protected: true, requiredChecks: ['test'], observedAt: T, observedRepo: repo, observedBranch: undefined,
    observeBranch(_repository, requested) { return { repository: this.observedRepo,
      branch: this.observedBranch ?? requested, sha: requested === 'main' ? this.mainSha : this.workSha,
      observedAt: this.observedAt }; },
    compare(_repository, baseSha, headSha) { return { repository: this.observedRepo, baseSha, headSha,
      aheadBy: this.aheadBy, behindBy: this.behindBy, hasBaseOnlyCommits: this.hasBaseOnlyCommits,
      observedAt: this.observedAt }; },
    observeCi(_repository, requested, sha) { return { repository: this.observedRepo, branch: requested, sha,
      workflowStatus: requested === 'main' ? this.mainCi : this.workCi, requiredCheckName: 'test',
      requiredCheckStatus: requested === 'main' ? this.mainCheck : this.workCheck, observedAt: this.observedAt }; },
    observeProtection(_repository, requested) { return { repository: this.observedRepo, branch: requested,
      protected: this.protected, requiredChecks: this.requiredChecks, observedAt: this.observedAt }; } };
}
function grant(operation, target) { return { authorizationId: `auth-${operation}-${target}`, actorRole: 'HUMAN',
  operation, target, runId: 'run-1', packetId: 'packet-1', issuedAt: T, reason: 'offline fixture' }; }
function make(dir) {
  const port = reality(); const c = new AutomationController(clock, new FileControllerStore(dir), port);
  c.createRun('run-1', 'slice-1', repo); c.enterArchitecture('run-1', G); c.issuePacket('run-1', G, packet());
  return { c, port, restart: () => new AutomationController(clock, new FileControllerStore(dir), port) };
}
function advance(c, state = 'PROMOTING') {
  c.beginImplementation('run-1', X); c.completeImplementation('run-1', X, ['pass']);
  c.recordRemoteSha('run-1', X);
  if (state === 'REMOTE_SHA_READY') return;
  c.beginAcceptanceReview('run-1', G);
  if (state === 'ACCEPTANCE_REVIEW') return;
  const run = c.get('run-1');
  c.decideAcceptance('run-1', G, { reviewId: 'r1', actor: 'GPT_ARCHITECT', packetId: 'packet-1',
    packetHash: run.activePacketHash, reviewedSha: B, decision: 'ACCEPT', findings: [],
    evidenceReferences: ['offline fixture'], issuedAt: T });
  if (state === 'ACCEPTED') return;
  c.requestPromotion('run-1', H, grant('FAST_FORWARD_MAIN', 'main'));
  if (state === 'PROMOTION_READY') return;
  c.beginPromotion('run-1', K);
  if (state === 'PROMOTING') return;
}

check('caller GitHub-looking JSON cannot record remote SHA', (dir) => {
  const { c } = make(dir); c.beginImplementation('run-1', X); c.completeImplementation('run-1', X, ['pass']);
  assert.throws(() => c.recordRemoteSha('run-1', X, { source: 'GITHUB', repository: repo, branch, sha: C, observedAt: T }));
  assert.equal(c.get('run-1').state, 'IMPLEMENTATION_COMPLETE');
  assert.equal(c.recordRemoteSha('run-1', X).remoteSha.sha, B);
});
check('caller promotion, promoted-main, and close facts are refused', (dir) => {
  const { c, port } = make(dir); advance(c, 'ACCEPTED');
  assert.throws(() => c.requestPromotion('run-1', H, {}, grant('FAST_FORWARD_MAIN', 'main')));
  c.requestPromotion('run-1', H, grant('FAST_FORWARD_MAIN', 'main')); c.beginPromotion('run-1', K);
  assert.throws(() => c.recordPromotedMain('run-1', K, { source: 'GITHUB', sha: B }));
  port.mainSha = B; c.recordPromotedMain('run-1', K);
  assert.throws(() => c.close('run-1', K, { mainCiPassed: true }));
  assert.equal(c.get('run-1').state, 'CANONICAL_CI');
});
check('malformed identity and future timestamps from port cannot advance', (dir) => {
  const { c, port } = make(dir); c.beginImplementation('run-1', X); c.completeImplementation('run-1', X, ['pass']);
  port.observedRepo = 'other'; assert.throws(() => c.recordRemoteSha('run-1', X));
  port.observedRepo = repo; port.observedBranch = 'work/other'; assert.throws(() => c.recordRemoteSha('run-1', X));
  port.observedBranch = undefined; port.observedAt = '2026-09-26T00:00:00.001Z';
  assert.throws(() => c.recordRemoteSha('run-1', X));
  port.observedAt = 'not-a-date'; assert.throws(() => c.recordRemoteSha('run-1', X));
  assert.equal(c.get('run-1').state, 'IMPLEMENTATION_COMPLETE');
});
for (const [label, change] of [
  ['moved main', (p) => { p.mainSha = C; }],
  ['behind accepted SHA', (p) => { p.behindBy = 1; }],
  ['diverged accepted SHA', (p) => { p.hasBaseOnlyCommits = true; }],
  ['failed exact SHA CI', (p) => { p.workCi = 'FAILURE'; }],
  ['missing required check', (p) => { p.requiredChecks = []; }],
  ['multiple unverified required checks', (p) => { p.requiredChecks = ['test', 'security']; }],
  ['unprotected main', (p) => { p.protected = false; }],
]) check(`promotion preflight rejects ${label}`, (dir) => {
  const { c, port } = make(dir); advance(c, 'ACCEPTED'); change(port);
  assert.equal(c.requestPromotion('run-1', H, grant('FAST_FORWARD_MAIN', 'main')).state, 'ARCHITECTURE_STOP');
});
check('beginPromotion rechecks preflight after authorization', (dir) => {
  const { c, port } = make(dir); advance(c, 'PROMOTION_READY'); port.mainSha = C;
  assert.equal(c.beginPromotion('run-1', K).state, 'ARCHITECTURE_STOP');
});
for (const state of ['REMOTE_SHA_READY', 'ACCEPTANCE_REVIEW', 'ACCEPTED']) {
  check(`${state} moved work branch stops and does not transfer evidence`, (dir) => {
    const { c, port, restart } = make(dir); advance(c, state); port.workSha = C;
    assert.equal(restart().reconcile('run-1', K).state, 'ARCHITECTURE_STOP');
  });
}
check('PROMOTING with accepted main observed recovers CANONICAL_CI', (dir) => {
  const { c, port, restart } = make(dir); advance(c); port.mainSha = B;
  const result = restart().reconcile('run-1', K);
  assert.equal(result.state, 'CANONICAL_CI');
  assert.equal(result.audit.at(-1).action, 'RECOVER_PROMOTED_MAIN');
});
check('PROMOTING with old main requires human; no retry', (dir) => {
  const { c, restart } = make(dir); advance(c);
  const result = restart().reconcile('run-1', K);
  assert.equal(result.state, 'HUMAN_STOP');
  assert.match(result.stopReason, /no automatic retry/);
  assert.equal(result.observedPromotedMainSha, undefined);
});
check('PROMOTING with unrelated main stops architecture', (dir) => {
  const { c, port, restart } = make(dir); advance(c); port.mainSha = C;
  assert.equal(restart().reconcile('run-1', K).state, 'ARCHITECTURE_STOP');
});
function canonical(dir) {
  const context = make(dir); advance(context.c); context.port.mainSha = B;
  context.c.recordPromotedMain('run-1', K); return context;
}
check('CANONICAL_CI restart closes only on exact successful facts', (dir) => {
  const { restart } = canonical(dir); const result = restart().reconcile('run-1', K);
  assert.equal(result.state, 'CLOSED'); assert.equal(result.audit.at(-1).action, 'RECOVER_CLOSE');
});
check('CANONICAL_CI pending remains unclosed', (dir) => {
  const { port, restart } = canonical(dir); port.mainCi = 'PENDING';
  const result = restart().reconcile('run-1', K);
  assert.equal(result.state, 'CANONICAL_CI'); assert.equal(result.audit.at(-1).action, 'RECONCILE_PENDING');
});
for (const [label, change] of [
  ['moved main', (p) => { p.mainSha = C; }],
  ['failed CI', (p) => { p.mainCi = 'FAILURE'; }],
  ['missing check', (p) => { p.requiredChecks = []; }],
  ['additional unverified check', (p) => { p.requiredChecks = ['test', 'security']; }],
  ['unprotected main', (p) => { p.protected = false; }],
]) check(`CANONICAL_CI ${label} cannot close`, (dir) => {
  const { port, restart } = canonical(dir); change(port);
  assert.equal(restart().reconcile('run-1', K).state, 'ARCHITECTURE_STOP');
});
check('human resume requires successful recheck before promotion begins', (dir) => {
  const { c, restart } = make(dir); advance(c, 'PROMOTION_READY');
  c.stop('run-1', K, 'HUMAN_STOP', 'pause');
  const resumed = restart(); resumed.resumeHuman('run-1', H, grant('RESUME_HUMAN_STOP', resumed.get('run-1').stopId));
  assert.equal(resumed.get('run-1').externalRecheckRequired, true);
  assert.throws(() => resumed.beginPromotion('run-1', K));
  const checked = resumed.reconcile('run-1', K);
  assert.equal(checked.externalRecheckRequired, false);
  assert.equal(checked.audit.at(-1).action, 'RECHECK_EXTERNAL_REALITY');
  assert.equal(resumed.beginPromotion('run-1', K).state, 'PROMOTING');
});
check('human resume with moved main stops without clearing recheck', (dir) => {
  const { c, port, restart } = make(dir); advance(c, 'PROMOTION_READY');
  c.stop('run-1', K, 'HUMAN_STOP', 'pause');
  const resumed = restart(); resumed.resumeHuman('run-1', H, grant('RESUME_HUMAN_STOP', resumed.get('run-1').stopId));
  port.mainSha = C;
  const result = resumed.reconcile('run-1', K);
  assert.equal(result.state, 'ARCHITECTURE_STOP'); assert.equal(result.externalRecheckRequired, true);
});
check('public store write cannot clear recheck or forge a repository transition', (dir) => {
  const { c } = make(dir); advance(c, 'PROMOTION_READY');
  c.stop('run-1', K, 'HUMAN_STOP', 'pause');
  c.resumeHuman('run-1', H, grant('RESUME_HUMAN_STOP', c.get('run-1').stopId));
  const store = new FileControllerStore(dir);
  const forged = store.get('run-1');
  forged.externalRecheckRequired = false;
  forged.audit.push({ ...forged.audit.at(-1), sequence: forged.audit.length + 1,
    actor: 'controller', role: 'CONTROLLER', action: 'RECHECK_EXTERNAL_REALITY',
    previousState: 'PROMOTION_READY', nextState: 'PROMOTION_READY', authorizationReference: undefined });
  assert.throws(() => store.replace(forged), /Controller writer required/);
  assert.equal(store.get('run-1').externalRecheckRequired, true);
});
check('port response is snapshotted, not retained by reference', (dir) => {
  const { c, port } = make(dir);
  const observed = { repository: repo, branch, sha: B, observedAt: T };
  port.observeBranch = () => observed;
  advance(c, 'REMOTE_SHA_READY');
  observed.sha = C;
  assert.equal(c.get('run-1').remoteSha.sha, B);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
