import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AutomationController } from './dist/automation/controller.js';
import { InMemoryControllerStore } from './dist/automation/audit.js';
import {
  ARCHITECT_REVIEW_ACTOR, IMPLEMENTATION_ACTOR, RUNNER_ACTOR, implementationInput, parseImplementationResult,
  parseReviewBundle, reviewInput,
} from './dist/automation/bridge.js';
import { AutomationRunner } from './dist/automation/runner.js';

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40), HASH = 'd'.repeat(64);
const T = '2026-09-27T00:00:00.000Z';
const G = { id: 'architect', role: 'GPT_ARCHITECT' }, X = { id: 'implementer', role: 'CODEX_IMPLEMENTER' };
const repo = 'synthetic/example', branch = 'work/synthetic-1';
const clock = { now: () => T };
const tests = [];
const check = (name, fn) => tests.push([name, fn]);

function packet() {
  return { packetId: 'packet-1', packetVersion: 1, sliceId: 'slice-1', expectedBaseSha: A, targetBranch: branch,
    objective: 'Offline bridge fixture', allowedAreas: ['src/automation'], forbiddenChanges: ['src/stress-test'],
    invariants: ['human authority retained'], acceptanceCriteria: ['offline checks pass'],
    validationCommands: [{ commandId: 'npm-test', executable: 'npm', args: ['test'], cwd: '.', classification: 'OFFLINE_VALIDATION' }],
    networkAuthorization: { level: 'WRITE_EXTERNAL', destinations: [branch], purpose: 'synthetic', budget: 1 },
    providerCallAuthorization: { allowed: false, providers: [], models: [], maxCalls: 0, budget: 0 },
    destructiveOperationAuthorization: { allowed: false },
    iterationBudget: { maxImplementationIterationsPerSlice: 3, maxAcceptanceFailuresPerSlice: 3,
      maxRuntimeMinutesPerIteration: 60, maxParallelImplementationAgents: 1 } };
}
function reality() {
  return { workSha: B,
    observeBranch(repository, requested) { return { repository, branch: requested, sha: this.workSha, observedAt: T }; },
    compare() { throw new Error('not used'); }, observeCi() { throw new Error('not used'); },
    observeProtection() { throw new Error('not used'); } };
}
function make() {
  const port = reality();
  const c = new AutomationController(clock, new InMemoryControllerStore(), port);
  c.createRun('run-1', 'slice-1', repo); c.enterArchitecture('run-1', G); c.issuePacket('run-1', G, packet());
  return { c, port };
}
function toReview(c) {
  c.beginImplementation('run-1', X); c.completeImplementation('run-1', X, ['pass']);
  c.recordRemoteSha('run-1', X); c.beginAcceptanceReview('run-1', G);
}
function decision(overrides = {}) {
  return { reviewId: 'review-1', actor: 'GPT_ARCHITECT', packetId: 'packet-1', packetHash: HASH, reviewedSha: B,
    decision: 'ACCEPT', findings: [], evidenceReferences: ['remote diff'], issuedAt: T, ...overrides };
}
const completed = (extra = {}) => ({ status: 'COMPLETED', validationEvidence: ['npm test: pass'], ...extra });
function isDeepFrozen(value) {
  if (value === null || typeof value !== 'object') return true;
  return Object.isFrozen(value) && Object.values(value).every(isDeepFrozen);
}

check('COMPLETED requires non-empty validation evidence', () => {
  assert.deepEqual(parseImplementationResult(completed()), completed());
  for (const evidence of [[], [''], ['   '], [1], 'npm test: pass', undefined]) {
    assert.throws(() => parseImplementationResult({ status: 'COMPLETED', validationEvidence: evidence }));
  }
  assert.throws(() => parseImplementationResult({ status: 'COMPLETED' }));
});
check('each stop class needs a reason and carries nothing else; other statuses are refused', () => {
  for (const status of ['SOFT_STOP', 'ARCHITECTURE_STOP', 'HUMAN_STOP']) {
    assert.deepEqual(parseImplementationResult({ status, reason: 'blocked' }), { status, reason: 'blocked' });
    assert.throws(() => parseImplementationResult({ status }));
    assert.throws(() => parseImplementationResult({ status, reason: ' ' }));
    assert.throws(() => parseImplementationResult({ status, reason: 'blocked', validationEvidence: ['pass'] }));
  }
  for (const status of ['ACCEPTED', 'ACCEPT', 'CLOSED', 'PROMOTION_READY', 'REMOTE_SHA_READY', 'completed', undefined]) {
    assert.throws(() => parseImplementationResult({ status, reason: 'x', validationEvidence: ['pass'] }));
  }
});
check('an implementation result cannot state repository, acceptance, promotion, or human facts', () => {
  const authority = {
    remoteSha: { repository: repo, branch, sha: C, observedAt: T, source: 'GITHUB' }, sha: C, headSha: C,
    branch, mainSha: C, ci: 'SUCCESS', requiredCheck: 'SUCCESS', branchProtection: { protected: false },
    acceptance: decision(), decision: 'ACCEPT', promotion: { target: 'main' }, promotionAuthorization: {},
    humanAuthorization: { actorRole: 'HUMAN' }, authorization: {}, actor: { id: 'h', role: 'HUMAN' }, role: 'HUMAN',
    state: 'ACCEPTED', nextState: 'PROMOTION_READY',
  };
  for (const [key, value] of Object.entries(authority)) {
    assert.throws(() => parseImplementationResult(completed({ [key]: value })), undefined, key);
  }
});
check('implementation reports are bounded', () => {
  assert.equal(parseImplementationResult(completed({ validationEvidence: Array(50).fill('pass') })).validationEvidence.length, 50);
  assert.throws(() => parseImplementationResult(completed({ validationEvidence: Array(51).fill('pass') })));
  assert.throws(() => parseImplementationResult(completed({ validationEvidence: ['x'.repeat(2001)] })));
  assert.throws(() => parseImplementationResult({ status: 'SOFT_STOP', reason: 'x'.repeat(2001) }));
});
check('a parsed result is a detached copy; non-objects are refused', () => {
  const raw = completed();
  const parsed = parseImplementationResult(raw);
  raw.validationEvidence.push('added later');
  assert.deepEqual(parsed.validationEvidence, ['npm test: pass']);
  for (const value of [null, undefined, 'COMPLETED', [completed()], 7]) assert.throws(() => parseImplementationResult(value));
});
check('a review envelope cannot carry authority-bearing fields', () => {
  assert.equal(parseReviewBundle({ decision: decision() }).decision.decision, 'ACCEPT');
  for (const key of ['promote', 'promotion', 'mainSha', 'humanAuthorization', 'activePacket', 'packetHash',
    'remoteSha', 'actor', 'role', 'state']) {
    assert.throws(() => parseReviewBundle({ decision: decision(), [key]: 'x' }), undefined, key);
  }
  for (const value of [null, undefined, 'ACCEPT', [decision()], {}]) assert.throws(() => parseReviewBundle(value));
});
check('an ACCEPT carries no correction; a REJECT correction is left to the controller', () => {
  assert.throws(() => parseReviewBundle({ decision: decision(), correction: { any: 'thing' } }), /Only a REJECT/);
  const rejected = decision({ decision: 'REJECT', findings: ['f'] });
  // Not read here: even a malformed correction is passed on for the controller to refuse.
  assert.deepEqual(parseReviewBundle({ decision: rejected, correction: { bogus: true } }).correction, { bogus: true });
  assert.equal('correction' in parseReviewBundle({ decision: rejected }), false);
});
check('a decision is read with the controller schema, once, into plain data', () => {
  for (const change of [{ actor: 'HUMAN' }, { actor: 'CODEX_IMPLEMENTER' }, { packetHash: 'short' }, { reviewedSha: 'xyz' },
    { decision: 'MAYBE' }, { evidenceReferences: [] }, { promote: true }, { issuedAt: 'not-a-date' }]) {
    assert.throws(() => parseReviewBundle({ decision: decision(change) }), undefined, JSON.stringify(change));
  }
  let reads = 0;
  const shifting = decision({ findings: ['f'] });
  Object.defineProperty(shifting, 'decision', { enumerable: true, get: () => (reads++ === 0 ? 'REJECT' : 'ACCEPT') });
  const parsed = parseReviewBundle({ decision: shifting }).decision;
  assert.equal(Object.getOwnPropertyDescriptor(parsed, 'decision').value, 'REJECT');
  assert.equal(parsed.decision, 'REJECT');
});
check('actor inputs are detached, deeply frozen, and carry exactly the bound fields', () => {
  const { c } = make();
  c.beginImplementation('run-1', X);
  const run = c.get('run-1');
  const input = implementationInput(run);
  assert.deepEqual(Object.keys(input).sort(), ['implementationIteration', 'packet', 'packetHash', 'runId', 'sliceId']);
  assert.deepEqual(input.packet, run.activePacket);
  assert.equal(input.packetHash, run.activePacketHash);
  assert.notEqual(input.packet, run.activePacket);
  assert.ok(isDeepFrozen(input));
  assert.throws(() => { input.packet.allowedAreas.push('src/stress-test'); }, TypeError);
  assert.deepEqual(c.get('run-1').activePacket.allowedAreas, ['src/automation']);
  c.completeImplementation('run-1', X, ['pass']); c.recordRemoteSha('run-1', X); c.beginAcceptanceReview('run-1', G);
  const review = reviewInput(c.get('run-1'));
  assert.deepEqual(Object.keys(review).sort(),
    ['acceptanceFailures', 'implementationIteration', 'packet', 'packetHash', 'remoteSha', 'runId', 'sliceId']);
  assert.deepEqual(review.remoteSha, c.get('run-1').remoteSha);
  assert.equal(review.acceptanceFailures, 0);
  assert.ok(isDeepFrozen(review));
  assert.throws(() => { review.remoteSha.sha = C; }, TypeError);
});
check('a correction is given only to the iteration it governs', () => {
  const { c, port } = make(); toReview(c);
  const run = c.get('run-1');
  c.decideAcceptance('run-1', G, decision({ packetHash: run.activePacketHash, decision: 'REJECT', findings: ['f'] }));
  const correction = { correctionPacketId: 'c-2', originalPacketId: 'packet-1', originalPacketHash: run.activePacketHash,
    rejectedSha: B, reviewerFindings: ['f'], allowedCorrectionAreas: ['src/automation'],
    unchangedInvariantReferences: ['human authority retained'], expectedBaseSha: B, correctionIteration: 2, maxCorrectionIteration: 3 };
  c.issueCorrection('run-1', G, correction);
  c.beginImplementation('run-1', X);
  assert.deepEqual(implementationInput(c.get('run-1')).correction, correction);
  c.completeImplementation('run-1', X, ['pass']); port.workSha = C; c.recordRemoteSha('run-1', X); c.beginAcceptanceReview('run-1', G);
  const review = reviewInput(c.get('run-1'));
  assert.deepEqual(review.correction, correction);
  assert.equal(review.remoteSha.sha, C);
  assert.equal(review.acceptanceFailures, 1);
  const first = make(); first.c.beginImplementation('run-1', X);
  assert.equal('correction' in implementationInput(first.c.get('run-1')), false);
});
check('protocol actors are frozen composition constants and none is HUMAN', () => {
  assert.deepEqual([IMPLEMENTATION_ACTOR.role, ARCHITECT_REVIEW_ACTOR.role, RUNNER_ACTOR.role],
    ['CODEX_IMPLEMENTER', 'GPT_ARCHITECT', 'CONTROLLER']);
  for (const actor of [IMPLEMENTATION_ACTOR, ARCHITECT_REVIEW_ACTOR, RUNNER_ACTOR]) {
    assert.ok(Object.isFrozen(actor));
    assert.throws(() => { actor.role = 'HUMAN'; }, TypeError);
  }
});
check('the runner takes no actor and refuses an unverified composition', async () => {
  const { c } = make();
  const execute = () => completed();
  const review = () => ({ decision: decision() });
  // controller, two ports, and optional journal options; none of them is an actor.
  assert.equal(AutomationRunner.length, 4);
  assert.throws(() => new AutomationRunner({ get() {}, stop() {} }, { execute }, { review }), TypeError);
  assert.throws(() => new AutomationRunner(c, {}, { review }), TypeError);
  assert.throws(() => new AutomationRunner(c, { execute }, undefined), TypeError);
  const port = { calls: 0, execute() { port.calls += 1; return completed(); } };
  const runner = new AutomationRunner(c, port, { review });
  assert.ok(Object.isFrozen(runner) && Object.isFrozen(AutomationRunner) && Object.isFrozen(AutomationRunner.prototype));
  port.execute = () => { throw new Error('replaced after composition'); };
  await runner.step('run-1'); await runner.step('run-1');
  assert.equal(port.calls, 1);
  assert.equal(c.get('run-1').state, 'IMPLEMENTATION_COMPLETE');
});
check('bridge and runner sources are offline and cannot reach promotion or human authority', () => {
  const sources = Object.fromEntries(['bridge', 'runner'].map((name) => [name, readFileSync(`src/automation/${name}.ts`, 'utf8')]));
  const allowed = new Set(['zod', './types.js', './lifecycle.js', './controller.js', './bridge.js', './invocation-journal.js',
    './policy.js']);
  for (const [name, source] of Object.entries(sources)) {
    for (const [, specifier] of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) assert.ok(allowed.has(specifier), `${name}: ${specifier}`);
    assert.doesNotMatch(source, /\bimport\s*\(|\brequire\s*\(|node:|child_process|\bspawn\b|\bexec(?:File)?\s*\(|\bfetch\s*\(|process\./, name);
    assert.doesNotMatch(source, /requestPromotion|beginPromotion|recordPromotedMain|resumeHuman|resumeSoft|resumeArchitecture|failClosed|reconcile|issuePacket|enterArchitecture|\bclose\b/, name);
    assert.doesNotMatch(source, /['"`]HUMAN['"`]/, name);
  }
  const called = [...new Set([...sources.runner.matchAll(/#controller\.(\w+)/g)].map((match) => match[1]))].sort();
  // Every write that applies an actor result, or stops the run, is occurrence-guarded.
  assert.deepEqual(called, ['beginAcceptanceReview', 'beginImplementation', 'completeImplementationForOccurrence',
    'decideAcceptanceForOccurrence', 'get', 'issueCorrectionForOccurrence', 'recordRemoteSha', 'stopForOccurrence']);
  assert.doesNotMatch(sources.bridge, /controller\.\w/i);
  // The runner forwards reviewer output; it never writes a decision or a correction of its own.
  // (packetHash also names the journal's identity binding, so the decision is detected by reviewedSha.)
  assert.doesNotMatch(sources.runner, /['"]ACCEPT['"]|reviewedSha|findings\s*:|rejectedSha\s*:|correctionIteration\s*:|actor:\s*['"]GPT_ARCHITECT/);
});

let passed = 0, failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`  PASS ${name}`); passed++; }
  catch (error) { console.error(`  FAIL ${name}: ${error.stack}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
