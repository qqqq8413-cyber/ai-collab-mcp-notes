import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorityBundleSha256, approvalSigningBytes, verifyOfflineHumanApproval,
  humanApprovalMatches } from './dist/intake/human-approval.js';
import { createGoalActivationBridge } from './dist/intake/goal-activation-bridge.js';
import { createGoalExecutionStepBridge } from './dist/intake/goal-execution-step-bridge.js';
import { parseWorkspaceConfig } from './dist/workspace/config.js';
import { FileGoalStore } from './dist/workspace/goal-store.js';

// EXE-C4 safety contract. All keys, signatures and invocations are synthetic;
// neither provider calls nor Human-issued real authority are created.
let passed = 0;
function check(name, task) {
  task();
  console.log('  PASS ' + name);
  passed++;
}
const root = mkdtempSync(join(tmpdir(), 'chief-exe-c4-'));
try {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pinned = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const human = { schemaVersion: 1, kind: 'HUMAN', principalRef: 'human:fixture' };
  const config = parseWorkspaceConfig({ schemaVersion: 1, dataDirectory: join(root, 'queue'),
    humanPrincipal: { principalRef: human.principalRef },
    projects: [{ projectId: 'chief', displayName: 'CHIEF', repository: 'synthetic/fixture' }] }, root);
  const store = new FileGoalStore(config.dataDirectory);
  const goal = store.addGoal('chief', 'Synthetic approval test', human).queue.goals[0];
  const bundle = { implementationPacket: { authorityId: 'packet-fixture', issuer: { role: 'GPT_ARCHITECT',
    principalRef: 'architect:fixture' }, subject: { repository: 'synthetic/fixture', sliceId: 'slice-1' },
    body: { sliceId: 'slice-1' } }, liveCallAuthorizations: [] };
  const now = Date.now();
  const issuedAt = new Date(now - 60_000).toISOString(), expiresAt = new Date(now + 3_600_000).toISOString();
  const payload = { schemaVersion: 1, purpose: 'CHIEF_EXE_C4_HUMAN_APPROVAL', projectId: 'chief', goalId: goal.goalId,
    repository: 'synthetic/fixture', changeKey: 'change-fixture', runId: 'run-fixture',
    humanPrincipalRef: human.principalRef, issuedAt, expiresAt, bundleSha256: authorityBundleSha256(bundle) };
  const signEnvelope = (p, signer = privateKey) => ({
    payload: p, signatureBase64: sign(null, approvalSigningBytes(p), signer).toString('base64'),
  });
  const approved = verifyOfflineHumanApproval(signEnvelope(payload), pinned, bundle);
  const identity = { projectId: 'chief', goalId: goal.goalId, repository: 'synthetic/fixture',
    changeKey: 'change-fixture', runId: 'run-fixture', humanPrincipalRef: human.principalRef };
  const expectInvalid = (fn) => assert.throws(fn);
  check('offline Ed25519 proof accepts exact complete bundle, scope and live time window', () => {
    assert.ok(humanApprovalMatches(approved, identity, bundle, now));
    assert.equal(approved.payload.humanPrincipalRef, human.principalRef);
    assert.equal(approved.keyFingerprint.length, 64);
  });
  check('proof rejects forged bytes, unsigned envelope, wrong public key and wrong algorithm', () => {
    const forged = structuredClone(signEnvelope(payload)); forged.payload.runId = 'run-forged';
    expectInvalid(() => verifyOfflineHumanApproval(forged, pinned, bundle));
    expectInvalid(() => verifyOfflineHumanApproval(undefined, pinned, bundle));
    const stranger = generateKeyPairSync('ed25519');
    expectInvalid(() => verifyOfflineHumanApproval(signEnvelope(payload), stranger.publicKey.export({
      type: 'spki', format: 'pem' }).toString(), bundle));
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expectInvalid(() => verifyOfflineHumanApproval(signEnvelope(payload), rsa.publicKey.export({
      type: 'spki', format: 'pem' }).toString(), bundle));
    expectInvalid(() => verifyOfflineHumanApproval({ ...signEnvelope(payload), signatureBase64: 'AAAA' }, pinned, bundle));
  });
  check('proof rejects changed document content, grant list, ROOT Run, Change, Goal or Human', () => {
    expectInvalid(() => verifyOfflineHumanApproval(signEnvelope(payload), pinned, {
      ...bundle, liveCallAuthorizations: [{ kind: 'AUTHORIZATION', forged: true }],
    }));
    for (const field of ['goalId', 'runId', 'changeKey', 'humanPrincipalRef', 'repository', 'projectId']) {
      assert.equal(humanApprovalMatches(approved, { ...identity, [field]: 'attacker' }, bundle, now), false, field);
    }
    assert.equal(humanApprovalMatches(approved, identity, {
      ...bundle, implementationPacket: { ...bundle.implementationPacket, authorityId: 'swapped' },
    }, now), false);
  });
  check('proof refuses future issue time, expiry, overlong validity and replay after expiration', () => {
    assert.equal(humanApprovalMatches(approved, identity, bundle, Date.parse(issuedAt) - 1), false);
    assert.equal(humanApprovalMatches(approved, identity, bundle, Date.parse(expiresAt)), false);
    const inverted = { ...payload, expiresAt: issuedAt };
    const excessive = { ...payload, expiresAt: new Date(now + 8 * 86400_000).toISOString() };
    expectInvalid(() => verifyOfflineHumanApproval(signEnvelope(inverted), pinned, bundle));
    expectInvalid(() => verifyOfflineHumanApproval(signEnvelope(excessive), pinned, bundle));
  });
  const state = { position: 'IDLE', runId: 'run-fixture', changeKey: 'change-fixture', stepCalls: 0, activationCalls: 0,
    driverInspections: 0 };
  const status = { inspect() { return { status: state.position === 'IDLE' ? 'RUN_IDLE' : 'IN_PROGRESS',
    change: { repository: 'synthetic/fixture', changeKey: state.changeKey },
    run: { admission: 'ROOT', runId: state.runId, state: state.position === 'IDLE' ? 'IDLE' : 'PACKET_READY' },
    reason: null }; } };
  const activation = { inspect(target) { return { target, position: state.position,
    changeKey: state.changeKey, change: { changeId: 'slice-1' }, repository: 'synthetic/fixture',
    humanPrincipalRef: human.principalRef, state: state.position }; },
    activate(target) { state.activationCalls++; state.position = 'PACKET_READY';
      return { target, status: 'ACTIVATED', changeKey: state.changeKey }; } };
  const plan = { projectId: 'chief', goalId: goal.goalId, bundle, approval: approved };
  const activationPort = createGoalActivationBridge({ status, activation, store, plans: [plan],
    architectPrincipalRef: 'architect:fixture' });
  check('signed approval gates activation; a stale ROOT cannot re-use it', () => {
    assert.equal(activationPort.inspect('chief', goal.goalId, human).canActivate, true);
    state.runId = 'run-swapped';
    const stale = activationPort.inspect('chief', goal.goalId, human);
    assert.equal(stale.readiness, 'HUMAN_APPROVAL_INVALID');
    assert.equal(stale.canActivate, false);
    assert.equal(state.activationCalls, 0);
    state.runId = 'run-fixture';
    state.changeKey = 'change-swapped';
    assert.equal(activationPort.inspect('chief', goal.goalId, human).canActivate, false);
    state.changeKey = 'change-fixture';
  });
  const driver = { inspect(target) { state.driverInspections++;
    return { target, repository: 'synthetic/fixture', changeKey: state.changeKey,
      state: 'PACKET_READY', readiness: 'READY', reason: null }; },
    async step(target) { state.stepCalls++; return { target, status: 'STEPPED', runnerCalls: 1,
      runnerOutcome: 'ADVANCED', preState: 'PACKET_READY', postState: 'IMPLEMENTING' }; } };
  const gate = (subject) => humanApprovalMatches(approved, subject, bundle);
  const stepPort = createGoalExecutionStepBridge({ executionStatus: status, driver, approvalGate: gate });
  check('runner gate denies missing approval before driver inspection and dispatch', () => {
    const noGrant = createGoalExecutionStepBridge({ executionStatus: status, driver, approvalGate: () => false });
    assert.equal(noGrant.inspect('chief', goal.goalId, human).canStep, false);
    assert.equal(noGrant.inspect('chief', goal.goalId, human).readiness, 'HUMAN_APPROVAL_INVALID');
    assert.equal(state.stepCalls, 0); assert.equal(state.driverInspections, 0);
  });
  check('signed approval gates runner on exact change, run and Human', () => {
    assert.equal(stepPort.inspect('chief', goal.goalId, human).canStep, false); // still IDLE
    state.position = 'PACKET_READY';
    assert.equal(stepPort.inspect('chief', goal.goalId, human).canStep, true);
    state.changeKey = 'change-rebound';
    assert.equal(stepPort.inspect('chief', goal.goalId, human).canStep, false);
    state.changeKey = 'change-fixture'; state.runId = 'run-replaced';
    assert.equal(stepPort.inspect('chief', goal.goalId, human).canStep, false);
    state.runId = 'run-fixture';
    assert.equal(stepPort.inspect('chief', goal.goalId, human).canStep, true);
    assert.equal(state.stepCalls, 0);
  });
  // Validate the actual asynchronous dispatch boundary, not just UI inspection.
  state.runId = 'run-replaced';
  const blocked = await stepPort.step('chief', goal.goalId, human);
  assert.equal(blocked.status, 'NOT_STEPPED');
  assert.equal(blocked.runnerCalls, 0);
  assert.equal(state.stepCalls, 0);
  state.runId = 'run-fixture';
  const dispatched = await stepPort.step('chief', goal.goalId, human);
  assert.equal(dispatched.status, 'STEPPED');
  assert.equal(dispatched.runnerCalls, 1);
  assert.equal(state.stepCalls, 1);
  console.log('  PASS approved exact ROOT dispatches one synthetic step, stale ROOT dispatches none');
  passed++;
  console.log('\n' + passed + ' EXE-C4 offline safety checks passed (0 paid calls)');
} finally { rmSync(root, { recursive: true, force: true }); }
