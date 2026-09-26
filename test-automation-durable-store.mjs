import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutomationController } from './dist/automation/controller.js';
import { FileControllerStore } from './dist/automation/durable-store.js';

const A = 'a'.repeat(40), B = 'b'.repeat(40), T = '2026-09-26T00:00:00.000Z';
const G = { id: 'architect', role: 'GPT_ARCHITECT' }, X = { id: 'implementer', role: 'CODEX_IMPLEMENTER' };
const clock = { now: () => T };
let passed = 0, failed = 0;
function check(name, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'chief-r2-store-'));
  try { fn(dir); console.log(`  PASS ${name}`); passed++; }
  catch (error) { console.error(`  FAIL ${name}: ${error.stack}`); failed++; }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
function packet() {
  return { packetId: 'packet-1', packetVersion: 1, sliceId: 'slice-1', expectedBaseSha: A,
    targetBranch: 'work/synthetic-1', objective: 'Offline fixture', allowedAreas: ['src/automation'],
    forbiddenChanges: ['src/stress-test'], invariants: ['human authority'], acceptanceCriteria: ['checks pass'],
    validationCommands: [{ commandId: 'test', executable: 'npm', args: ['test'], cwd: '.', classification: 'OFFLINE_VALIDATION' }],
    networkAuthorization: { level: 'WRITE_EXTERNAL', destinations: ['main', 'work/synthetic-1'], purpose: 'fixture', budget: 1 },
    providerCallAuthorization: { allowed: false, providers: [], models: [], maxCalls: 0, budget: 0 },
    destructiveOperationAuthorization: { allowed: false },
    iterationBudget: { maxImplementationIterationsPerSlice: 3, maxAcceptanceFailuresPerSlice: 3,
      maxRuntimeMinutesPerIteration: 60, maxParallelImplementationAgents: 1 } };
}
function reality() {
  return { observeBranch(repository, branch) { return { repository, branch, sha: branch === 'main' ? A : B, observedAt: T }; },
    compare(repository, baseSha, headSha) { return { repository, baseSha, headSha, aheadBy: 1, behindBy: 0,
      hasBaseOnlyCommits: false, observedAt: T }; },
    observeCi(repository, branch, sha) { return { repository, branch, sha, workflowStatus: 'SUCCESS',
      requiredCheckName: 'test', requiredCheckStatus: 'SUCCESS', observedAt: T }; },
    observeProtection(repository, branch) { return { repository, branch, protected: true,
      requiredChecks: ['test'], observedAt: T }; } };
}
function start(dir) {
  const store = new FileControllerStore(dir);
  const c = new AutomationController(clock, store, reality());
  c.createRun('run-1', 'slice-1', 'synthetic/example');
  c.enterArchitecture('run-1', G); c.issuePacket('run-1', G, packet());
  return { c, store };
}
function canonical(dir) { return join(dir, readdirSync(dir).find((file) => file.endsWith('.json'))); }
function rewrite(dir, mutate, reseal = false) {
  const file = canonical(dir), envelope = JSON.parse(readFileSync(file, 'utf8'));
  mutate(envelope);
  if (reseal) envelope.checksum = createHash('sha256').update(JSON.stringify(envelope.run)).digest('hex');
  writeFileSync(file, JSON.stringify(envelope));
}

check('complete packet, audit, and counters survive new store and controller', (dir) => {
  const { c } = start(dir); c.beginImplementation('run-1', X);
  const before = c.get('run-1');
  const next = new AutomationController(clock, new FileControllerStore(dir), reality());
  assert.deepEqual(next.get('run-1'), before);
  assert.deepEqual(next.audit('run-1'), before.audit);
});
check('accepted state survives restart without new authority', (dir) => {
  const { c } = start(dir); c.beginImplementation('run-1', X); c.completeImplementation('run-1', X, ['pass']);
  c.recordRemoteSha('run-1', X); c.beginAcceptanceReview('run-1', G);
  const run = c.get('run-1');
  c.decideAcceptance('run-1', G, { reviewId: 'r1', actor: 'GPT_ARCHITECT', packetId: 'packet-1',
    packetHash: run.activePacketHash, reviewedSha: B, decision: 'ACCEPT', findings: [],
    evidenceReferences: ['fixture'], issuedAt: T });
  const next = new AutomationController(clock, new FileControllerStore(dir), reality());
  assert.equal(next.get('run-1').state, 'ACCEPTED');
  assert.throws(() => next.beginPromotion('run-1', { id: 'controller', role: 'CONTROLLER' }));
});
for (const [name, mutate, reseal] of [
  ['truncated JSON', () => {}, false],
  ['invalid state', (e) => { e.run.state = 'INVENTED'; }, true],
  ['broken audit sequence', (e) => { e.run.audit[0].sequence = 9; }, true],
  ['audit rewrite', (e) => { e.run.audit[0].action = 'MARK_PROMOTING'; }, true],
  ['packet/hash mismatch', (e) => { e.run.activePacket.objective = 'substituted'; }, true],
  ['lowered counters', (e) => { e.run.implementationIterations = 0; }, true],
  ['fabricated ACCEPTED', (e) => { e.run.state = 'ACCEPTED'; }, true],
  ['fabricated CLOSED', (e) => { e.run.state = 'CLOSED'; }, true],
  ['unknown run field', (e) => { e.run.extra = true; }, true],
  ['unsupported version', (e) => { e.schemaVersion = 2; }, false],
  ['tampered checksum', (e) => { e.run.repository = 'other'; }, false],
]) check(`corrupt ${name} fails closed`, (dir) => {
  const { c } = start(dir);
  if (name === 'lowered counters') c.beginImplementation('run-1', X);
  if (name === 'truncated JSON') writeFileSync(canonical(dir), '{"schemaVersion":1');
  else rewrite(dir, mutate, reseal);
  assert.throws(() => new FileControllerStore(dir).get('run-1'));
});
check('stale writer cannot overwrite a newer durable transition', (dir) => {
  const { c, store } = start(dir); const stale = store.get('run-1');
  const current = c.beginImplementation('run-1', X);
  stale.state = 'IMPLEMENTING'; stale.implementationIterations = 1; stale.iterationStartedAt = T;
  stale.audit.push(current.audit.at(-1));
  assert.throws(() => new FileControllerStore(dir).replace(stale));
  assert.deepEqual(store.get('run-1'), current);
});
check('two controller instances cannot commit from the same stale state', (dir) => {
  const { c } = start(dir);
  const other = new AutomationController(clock, new FileControllerStore(dir), reality());
  let fired = false;
  const racingClock = { now() { if (!fired) { fired = true; other.beginImplementation('run-1', X); } return T; } };
  const stale = new AutomationController(racingClock, new FileControllerStore(dir), reality());
  assert.throws(() => stale.beginImplementation('run-1', X));
  assert.equal(c.get('run-1').state, 'IMPLEMENTING');
  assert.equal(c.get('run-1').implementationIterations, 1);
});
check('input and output mutation cannot alter persisted state', (dir) => {
  const { c, store } = start(dir); const before = c.get('run-1');
  before.activePacket.objective = 'changed'; store.get('run-1').audit[0].action = 'changed';
  assert.equal(new FileControllerStore(dir).get('run-1').activePacket.objective, 'Offline fixture');
  assert.equal(new FileControllerStore(dir).get('run-1').audit[0].action, 'ENTER_ARCHITECTURE');
});
check('orphan temp artifact never replaces canonical state', (dir) => {
  const { c } = start(dir); const before = c.get('run-1');
  writeFileSync(`${canonical(dir)}.interrupted.tmp`, '{');
  assert.deepEqual(new FileControllerStore(dir).get('run-1'), before);
});
check('uncertain lock fails closed without deleting the lock', (dir) => {
  const { c } = start(dir); const lock = `${canonical(dir)}.lock`;
  writeFileSync(lock, 'uncertain');
  assert.throws(() => c.beginImplementation('run-1', X));
  assert.equal(readFileSync(lock, 'utf8'), 'uncertain');
  assert.equal(c.get('run-1').state, 'PACKET_READY');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
