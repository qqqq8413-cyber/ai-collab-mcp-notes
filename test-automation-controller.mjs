import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AutomationController } from './dist/automation/controller.js';
import { InMemoryControllerStore } from './dist/automation/audit.js';
import { packetHash, parsePacket } from './dist/automation/packet.js';
import { evaluatePolicy, evaluateDiffWarnings, OPERATION_POLICY } from './dist/automation/policy.js';

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const T = '2026-09-26T00:00:00.000Z';
const G = { id: 'architect', role: 'GPT_ARCHITECT' };
const X = { id: 'implementer', role: 'CODEX_IMPLEMENTER' };
const H = { id: 'human', role: 'HUMAN' };
const K = { id: 'controller', role: 'CONTROLLER' };
const repo = 'synthetic/example';
const clock = { now: () => T };
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS ${name}`); passed++; }
  catch (error) { console.error(`  FAIL ${name}: ${error.stack}`); failed++; }
}
function packet(overrides = {}) {
  return {
    packetId: 'packet-1', packetVersion: 1, sliceId: 'slice-1', expectedBaseSha: A,
    targetBranch: 'work/synthetic-1', objective: 'Implement an offline test fixture',
    allowedAreas: ['src/automation'], forbiddenChanges: ['src/stress-test'],
    invariants: ['human authority retained'], acceptanceCriteria: ['offline checks pass'],
    validationCommands: [{ commandId: 'npm-test', executable: 'npm', args: ['test'], cwd: '.', classification: 'OFFLINE_VALIDATION' }],
    networkAuthorization: { level: 'WRITE_EXTERNAL', destinations: ['work/synthetic-1', 'main'], purpose: 'synthetic GitHub facts', budget: 1 },
    providerCallAuthorization: { allowed: false, providers: [], models: [], maxCalls: 0, budget: 0 },
    destructiveOperationAuthorization: { allowed: false },
    iterationBudget: { maxImplementationIterationsPerSlice: 3, maxAcceptanceFailuresPerSlice: 3,
      maxRuntimeMinutesPerIteration: 60, maxParallelImplementationAgents: 1 },
    ...overrides,
  };
}
function auth(role, operation, target, overrides = {}) {
  return { authorizationId: `auth-${operation}`, actorRole: role, operation, target,
    runId: 'run-1', packetId: 'packet-1', issuedAt: T, reason: 'synthetic authorization', ...overrides };
}
function make(initialPacket = packet()) {
  const store = new InMemoryControllerStore();
  const c = new AutomationController(clock, store);
  c.createRun('run-1', 'slice-1', repo);
  c.enterArchitecture('run-1', G);
  c.issuePacket('run-1', G, initialPacket);
  return { c, store };
}
function remote(sha = B, branch = 'work/synthetic-1') {
  return { repository: repo, branch, sha, observedAt: T, source: 'GITHUB' };
}
function ready(c, sha = B) {
  c.beginImplementation('run-1', X);
  c.completeImplementation('run-1', X, ['offline test result']);
  c.recordRemoteSha('run-1', X, remote(sha));
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
function accepted() { const { c } = make(); ready(c); c.decideAcceptance('run-1', G, decision(c)); return c; }
function policy(c, operation, actor, target, authorization) {
  return evaluatePolicy({ operation, target, actor, authorization,
    packet: c.get('run-1').activePacket, runId: 'run-1', now: T });
}

check('normal lifecycle reaches CLOSED only after remote review, human promotion, and CI facts', () => {
  const c = accepted();
  assert.equal(c.get('run-1').state, 'ACCEPTED');
  c.requestPromotion('run-1', H, preflight(), auth('HUMAN', 'FAST_FORWARD_MAIN', 'main'));
  c.beginPromotion('run-1', K);
  c.recordPromotedMain('run-1', K, remote(B, 'main'));
  c.close('run-1', K, { observedMainSha: B, expectedAcceptedSha: B, mainCiPassed: true,
    requiredCheckPassed: true, mainProtected: true });
  assert.equal(c.get('run-1').state, 'CLOSED');
});
check('illegal transition fails closed without mutation', () => {
  const { c } = make(); assert.throws(() => c.beginAcceptanceReview('run-1', G));
  assert.equal(c.get('run-1').state, 'PACKET_READY');
});
check('Codex cannot ACCEPT itself', () => {
  const { c } = make(); ready(c); assert.throws(() => c.decideAcceptance('run-1', X, decision(c)));
});
check('Controller cannot ACCEPT', () => {
  const { c } = make(); ready(c); assert.throws(() => c.decideAcceptance('run-1', K, decision(c)));
});
check('GPT ACCEPT binds exact remote SHA', () => {
  const { c } = make(); ready(c); c.decideAcceptance('run-1', G, decision(c));
  assert.equal(c.get('run-1').acceptance.reviewedSha, B);
});
check('different SHA cannot inherit acceptance', () => {
  const { c } = make(); ready(c); assert.throws(() => c.decideAcceptance('run-1', G, decision(c, 'ACCEPT', C)));
  assert.equal(c.get('run-1').state, 'ACCEPTANCE_REVIEW');
});
check('REJECT increments acceptance failure and enters correction', () => {
  const { c } = make(); ready(c); c.decideAcceptance('run-1', G, decision(c, 'REJECT'));
  assert.equal(c.get('run-1').acceptanceFailures, 1);
  assert.equal(c.get('run-1').state, 'CORRECTION_REQUIRED');
});
check('correction packet binds rejected SHA and original invariants', () => {
  const { c } = make(); ready(c); c.decideAcceptance('run-1', G, decision(c, 'REJECT'));
  const correction = { correctionPacketId: 'correction-1', originalPacketId: 'packet-1',
    originalPacketHash: c.get('run-1').activePacketHash, rejectedSha: B,
    reviewerFindings: ['synthetic finding'], allowedCorrectionAreas: ['src/automation'],
    unchangedInvariantReferences: ['human authority retained'], expectedBaseSha: B,
    correctionIteration: 2, maxCorrectionIteration: 3 };
  assert.throws(() => c.issueCorrection('run-1', G, { ...correction, rejectedSha: C }));
  assert.throws(() => c.issueCorrection('run-1', G, { ...correction, reviewerFindings: ['invented'] }));
  c.issueCorrection('run-1', G, correction);
  assert.equal(c.beginImplementation('run-1', X).state, 'IMPLEMENTING');
});
check('packet input and stored snapshot are immutable across IMPLEMENTING', () => {
  const { c } = make(); const input = packet(); c.beginImplementation('run-1', X);
  input.allowedAreas.push('other');
  c.get('run-1').activePacket.allowedAreas.push('other');
  assert.deepEqual(c.get('run-1').activePacket.allowedAreas, ['src/automation']);
  assert.throws(() => c.issuePacket('run-1', G, input));
});
check('packet hash ignores object key insertion order', () => {
  const p = packet(); assert.equal(packetHash(p), packetHash(Object.fromEntries(Object.entries(p).reverse())));
});
check('semantic packet change changes hash', () => assert.notEqual(packetHash(packet()), packetHash(packet({ objective: 'Different' }))));
check('strict packet validation rejects extra fields and higher budgets', () => {
  assert.throws(() => parsePacket(packet({ extra: 'not allowed' })));
  assert.throws(() => parsePacket(packet({ iterationBudget: { ...packet().iterationBudget, maxImplementationIterationsPerSlice: 4 } })));
});
check('unknown operation is DENIED', () => {
  const { c } = make(); assert.equal(policy(c, 'UNKNOWN', X, 'target').decision, 'DENIED');
});
check('REQUIRE_HUMAN cannot be satisfied by GPT authorization', () => {
  const { c } = make(); assert.notEqual(policy(c, 'FAST_FORWARD_MAIN', G, 'main', auth('GPT_ARCHITECT', 'FAST_FORWARD_MAIN', 'main')).decision, 'AUTHORIZED');
});
check('FORBIDDEN remains denied with human authorization', () => {
  const { c } = make(); assert.equal(policy(c, 'FORCE_PUSH', H, 'main', auth('HUMAN', 'FORCE_PUSH', 'main')).decision, 'DENIED');
});
check('FAST_FORWARD_MAIN requires exact HumanAuthorization', () => {
  const { c } = make(); assert.equal(policy(c, 'FAST_FORWARD_MAIN', H, 'main').decision, 'REQUIRE_HUMAN');
  assert.equal(policy(c, 'FAST_FORWARD_MAIN', H, 'main', auth('HUMAN', 'FAST_FORWARD_MAIN', 'main')).decision, 'AUTHORIZED');
  assert.notEqual(policy(c, 'FAST_FORWARD_MAIN', H, 'main', auth('HUMAN', 'FAST_FORWARD_MAIN', 'elsewhere')).decision, 'AUTHORIZED');
});
check('WRITE_EXTERNAL network level alone cannot authorize promotion', () => {
  const c = accepted(); assert.throws(() => c.requestPromotion('run-1', H, preflight(), undefined));
});
check('generic READ_WEB cannot authorize live model calls', () => {
  const { c } = make(); const p = packet({ networkAuthorization: { level: 'READ_WEB', destinations: ['model'], purpose: 'read', budget: 1 } });
  c.get('run-1').activePacket.networkAuthorization.level = 'READ_WEB';
  assert.equal(evaluatePolicy({ operation: 'LIVE_PROVIDER_MODEL_CALL', target: 'model', actor: H,
    packet: p, runId: 'run-1', authorization: auth('HUMAN', 'LIVE_PROVIDER_MODEL_CALL', 'model'), now: T }).decision, 'DENIED');
});
check('CASE_001_ACCESS denies absent or wrong-target authorization', () => {
  const { c } = make(); assert.notEqual(policy(c, 'CASE_001_ACCESS', H, 'case-synthetic').decision, 'AUTHORIZED');
  assert.notEqual(policy(c, 'CASE_001_ACCESS', H, 'case-synthetic', auth('HUMAN', 'CASE_001_ACCESS', 'other')).decision, 'AUTHORIZED');
});
check('generic repository action requires explicit ordinary classification', () => {
  const { c } = make(); const base = { operation: 'READ_REPOSITORY', target: 'synthetic-file',
    actor: X, packet: c.get('run-1').activePacket, runId: 'run-1', now: T };
  assert.equal(evaluatePolicy(base).decision, 'DENIED');
  assert.equal(evaluatePolicy({ ...base, resourceClassification: 'CASE_001' }).decision, 'DENIED');
  assert.equal(evaluatePolicy({ ...base, resourceClassification: 'ORDINARY' }).decision, 'AUTHORIZED');
});
check('implementation iteration budget exhaustion yields HUMAN_STOP', () => {
  const { c } = make(packet({ iterationBudget: { ...packet().iterationBudget, maxImplementationIterationsPerSlice: 2 } }));
  ready(c); c.decideAcceptance('run-1', G, decision(c, 'REJECT'));
  const correction = { correctionPacketId: 'c1', originalPacketId: 'packet-1', originalPacketHash: c.get('run-1').activePacketHash,
    rejectedSha: B, reviewerFindings: ['synthetic finding'], allowedCorrectionAreas: ['src/automation'],
    unchangedInvariantReferences: ['human authority retained'], expectedBaseSha: B,
    correctionIteration: 2, maxCorrectionIteration: 2 };
  c.issueCorrection('run-1', G, correction); c.beginImplementation('run-1', X);
  c.stop('run-1', K, 'SOFT_STOP', 'synthetic repair'); c.resumeSoft('run-1', K, 'repair evidence');
  assert.equal(c.get('run-1').implementationIterations, 2);
  c.completeImplementation('run-1', X, ['pass']); c.recordRemoteSha('run-1', X, remote(C));
  c.beginAcceptanceReview('run-1', G);
  c.decideAcceptance('run-1', G, { ...decision(c, 'REJECT', C), reviewId: 'review-2' });
  assert.equal(c.beginImplementation('run-1', X).state, 'HUMAN_STOP');
  assert.equal(c.get('run-1').implementationIterations, 2);
});
check('acceptance failure budget exhaustion yields HUMAN_STOP', () => {
  const p = packet({ iterationBudget: { ...packet().iterationBudget, maxAcceptanceFailuresPerSlice: 1 } });
  const { c } = make(p); ready(c); c.decideAcceptance('run-1', G, decision(c, 'REJECT'));
  assert.equal(c.get('run-1').acceptanceFailures, 1);
  assert.equal(c.get('run-1').state, 'HUMAN_STOP');
});
check('counters cannot be reset through returned run or packet', () => {
  const { c } = make(); c.beginImplementation('run-1', X);
  c.get('run-1').implementationIterations = 0;
  assert.equal(c.get('run-1').implementationIterations, 1);
});
check('SOFT_STOP resumes only to interrupted state', () => {
  const { c } = make(); c.beginImplementation('run-1', X); c.stop('run-1', K, 'SOFT_STOP', 'test');
  assert.equal(c.resumeSoft('run-1', K, 'fixed').state, 'IMPLEMENTING');
});
check('ARCHITECTURE_STOP must return through ARCHITECTURE and new packet version', () => {
  const { c } = make(); c.stop('run-1', K, 'ARCHITECTURE_STOP', 'conflict');
  assert.throws(() => c.beginImplementation('run-1', X));
  c.resumeArchitecture('run-1', G);
  assert.throws(() => c.issuePacket('run-1', G, packet()));
  c.issuePacket('run-1', G, packet({ packetId: 'packet-2', packetVersion: 2 }));
  assert.equal(c.get('run-1').state, 'PACKET_READY');
});
check('HUMAN_STOP requires exact human authorization', () => {
  const { c } = make(); c.stop('run-1', K, 'HUMAN_STOP', 'sensitive');
  const stopId = c.get('run-1').stopId;
  assert.throws(() => c.resumeHuman('run-1', H, auth('HUMAN', 'RESUME_HUMAN_STOP', 'wrong')));
  assert.equal(c.resumeHuman('run-1', H, auth('HUMAN', 'RESUME_HUMAN_STOP', stopId)).state, 'PACKET_READY');
  assert.equal(c.get('run-1').externalRecheckRequired, true);
});
check('FAILED_CLOSED cannot resume', () => {
  const { c } = make(); c.failClosed('run-1', K, 'unreconcilable');
  assert.throws(() => c.resumeArchitecture('run-1', G));
  assert.throws(() => c.beginImplementation('run-1', X));
});
check('audit sequence monotonic', () => {
  const { c } = make(); c.beginImplementation('run-1', X);
  assert.deepEqual(c.audit('run-1').map((e) => e.sequence), [1, 2, 3]);
});
check('audit entries returned are defensive copies', () => {
  const { c } = make(); c.audit('run-1')[0].action = 'tampered';
  assert.equal(c.audit('run-1')[0].action, 'ENTER_ARCHITECTURE');
});
check('store reads are defensive copies', () => {
  const { store } = make(); store.get('run-1').activePacket.objective = 'tampered';
  assert.equal(store.get('run-1').activePacket.objective, packet().objective);
});
check('store cannot replace frozen packet or lower counters', () => {
  const { c, store } = make(); c.beginImplementation('run-1', X);
  const changed = store.get('run-1');
  changed.activePacket.objective = 'substitution';
  changed.activePacketHash = packetHash(changed.activePacket);
  changed.audit.push({ ...changed.audit.at(-1), sequence: changed.audit.length + 1 });
  assert.throws(() => store.replace(changed));
  const lowered = store.get('run-1');
  lowered.implementationIterations = 0;
  lowered.audit.push({ ...lowered.audit.at(-1), sequence: lowered.audit.length + 1 });
  assert.throws(() => store.replace(lowered));
});
check('promotion preflight rejects moved main', () => {
  const c = accepted(); assert.equal(c.requestPromotion('run-1', H,
    preflight({ observedMainSha: C }), auth('HUMAN', 'FAST_FORWARD_MAIN', 'main')).state, 'ARCHITECTURE_STOP');
});
check('promotion preflight rejects behind or diverged SHA', () => {
  for (const facts of [preflight({ behindBy: 1 }), preflight({ hasMainOnlyCommits: true })]) {
    const c = accepted(); assert.equal(c.requestPromotion('run-1', H, facts,
      auth('HUMAN', 'FAST_FORWARD_MAIN', 'main')).state, 'ARCHITECTURE_STOP');
  }
});
check('promotion preflight rejects failed CI or required check', () => {
  for (const facts of [preflight({ acceptedShaCiPassed: false }), preflight({ requiredCheckPassed: false })]) {
    const c = accepted(); assert.equal(c.requestPromotion('run-1', H, facts,
      auth('HUMAN', 'FAST_FORWARD_MAIN', 'main')).state, 'ARCHITECTURE_STOP');
  }
});
check('post-promotion close requires main equals accepted SHA', () => {
  const c = accepted(); c.requestPromotion('run-1', H, preflight(), auth('HUMAN', 'FAST_FORWARD_MAIN', 'main'));
  c.beginPromotion('run-1', K); c.recordPromotedMain('run-1', K, remote(B, 'main'));
  assert.throws(() => c.close('run-1', K, { observedMainSha: C, expectedAcceptedSha: B,
    mainCiPassed: true, requiredCheckPassed: true, mainProtected: true }));
});
check('scope warning never automatically rejects', () => {
  const { c } = make(); assert.deepEqual(evaluateDiffWarnings(11, 501),
    ['SCOPE_WARNING_CHANGED_FILES', 'SCOPE_WARNING_DIFF_LINES']);
  assert.equal(c.get('run-1').state, 'PACKET_READY');
});
check('implementation runtime limit is measured from injected clock', () => {
  let now = T;
  const c = new AutomationController({ now: () => now });
  c.createRun('run-1', 'slice-1', repo); c.enterArchitecture('run-1', G);
  c.issuePacket('run-1', G, packet()); c.beginImplementation('run-1', X);
  now = '2026-09-26T01:00:01.000Z';
  assert.equal(c.completeImplementation('run-1', X, ['pass']).state, 'HUMAN_STOP');
});
check('work branch push needs exact destination and explicit classification', () => {
  const { c } = make(); const p = c.get('run-1').activePacket;
  assert.equal(evaluatePolicy({ operation: 'PUSH_WORK_BRANCH', target: p.targetBranch,
    actor: X, packet: p, runId: 'run-1', now: T, resourceClassification: 'ORDINARY' }).decision, 'AUTHORIZED');
  assert.equal(evaluatePolicy({ operation: 'PUSH_WORK_BRANCH', target: 'work/elsewhere',
    actor: X, packet: p, runId: 'run-1', now: T, resourceClassification: 'ORDINARY' }).decision, 'DENIED');
});
check('ordinary commit cannot target main', () => {
  const { c } = make(); const p = c.get('run-1').activePacket;
  assert.equal(evaluatePolicy({ operation: 'COMMIT_WORK_BRANCH', target: 'main', actor: X,
    packet: p, runId: 'run-1', now: T, resourceClassification: 'ORDINARY' }).decision, 'DENIED');
});
check('controller has no network, provider, subprocess, or side-effect imports', () => {
  for (const name of ['controller', 'policy', 'packet', 'audit', 'types']) {
    const source = readFileSync(`src/automation/${name}.ts`, 'utf8');
    assert.doesNotMatch(source, /from ['"](?:node:(?:http|https|net|child_process)|openai|@anthropic-ai|@google\/generative-ai|@octokit)/);
  }
  assert.equal(OPERATION_POLICY.FAST_FORWARD_MAIN, 'REQUIRE_HUMAN');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
