import { createGovernedLimitedWorker } from '../automation/live/governed-execution.js';
import { M1_SIGNATURE_POLICY, prospectiveActivationSet, type ProspectiveMember } from './activation-set.js';
import { assertLiveRequestBound, hash, maximumCost, packetFor, type Contract } from './contract.js';
import { draftRunDocuments, recordHashOf } from './governance.js';
import { packetHash } from '../automation/packet.js';
import { approvalWindow, attestationVerifier, challengeOf, parsePayload, readApprovalRecord, verifyAssertion, workerClassHash, writeApprovalRecord,
  type ApprovalPayloadV1, type Approver } from './run-approval.js';
import { WorkerStore } from './store.js';

// M1-B: the real Host's runtime. One trusted governed Worker per approved job (its two Human grants exist only after
// the Human's passkey approval of that exact run), plus one without grants for views. Under EXE HOLD the service
// refuses before any of this is called; nothing here lifts or bypasses EXE, H1–H9, the activation set, the final
// send guard or the single generation claim.

type Common = Omit<Parameters<typeof createGovernedLimitedWorker>[0], 'liveCallGrant' | 'limitedGrant' | 'signaturePolicy' | 'liveApproval'>;
type GovernedWorker = ReturnType<typeof createGovernedLimitedWorker>;
const fail = (code: string): never => { throw new Error(code); };

export interface ApprovalChallenge {
  challenge: string; rpId: 'localhost'; credentialId: string; timeoutMs: number; expiresAt: string; payload: ApprovalPayloadV1;
}
export interface ApprovalStatus {
  configured: boolean; policy: string; keyId: string | null; protection: Approver['protection'] | null;
  classAccepted: boolean; implementationAccepted: boolean; reviewRef: string | null; classHash: string;
  pending: ApprovalChallenge | null; consumed: boolean; refusal: string | null;
}

export function createLiveRuntime(common: Common, approver: Approver | null) {
  const base = createGovernedLimitedWorker({ ...common, liveCallGrant: null, limitedGrant: null });
  const store = new WorkerStore(common.resultDirectory);
  const verifier = approver ? attestationVerifier(common.resultDirectory, approver, () => common.clock.now()) : undefined;
  const workers = new Map<string, GovernedWorker>();
  const documentsOf = (c: Contract, window: { issuedAt: string; expiresAt: string; nonce: string }) => {
    const sliceId = base.inspect(c).driver.change?.changeId;
    if (!sliceId) return fail('RUN_NOT_ADMITTED');
    const packet = packetFor(c, sliceId);
    const documents = draftRunDocuments(c, packet, { architectPrincipalRef: common.architectPrincipalRef, humanPrincipalRef: common.humanPrincipalRef, ...window });
    const member = (d: (typeof documents)[number]): ProspectiveMember => ({ ...d, recordHash: recordHashOf(d) });
    const members: [ProspectiveMember, ProspectiveMember, ProspectiveMember] = [member(documents[0]), member(documents[1]), member(documents[2])];
    return { packet, documents, members };
  };
  const recordOf = (c: Contract) => { try { return readApprovalRecord(common.resultDirectory, hash(c)); } catch (error) {
    if (error instanceof Error && error.message === 'APPROVAL_RECORD_MISSING') return null; throw error; } };
  const jobOf = (c: Contract) => store.read().jobs.find((j) => j.id === hash(c)) ?? fail('UNKNOWN_JOB');
  /** Everything the approval binds, re-derived now: refuses when the configuration, the class or the run changed. */
  const bind = (c: Contract, payload: ApprovalPayloadV1) => {
    const { packet, documents, members } = documentsOf(c, payload);
    const { setHash } = prospectiveActivationSet({ contract: c, packet, signaturePolicy: M1_SIGNATURE_POLICY.version, documents: members });
    if (payload.setHash !== setHash || payload.contractHash !== hash(c) || payload.packetId !== packet.packetId || payload.packetHash !== packetHash(packet) || payload.runId !== c.runId ||
      payload.implementationSha !== c.implementationSha || payload.workerCodeHash !== c.workerCodeHash ||
      payload.grants[0].recordHash !== recordHashOf(documents[2]) || payload.grants[1].recordHash !== recordHashOf(documents[1]) ||
      payload.signerKeyId !== approver!.keyId || payload.classHash !== approver!.architectAcceptance.classHash) fail('APPROVAL_BINDING_MISMATCH');
    return documents;
  };
  /** The standing preconditions of any live approval: configured key, accepted class and implementation, bound request. */
  const eligible = (c: Contract): Approver => {
    if (!approver) return fail('APPROVER_NOT_CONFIGURED');
    assertLiveRequestBound(c);
    if (approver.humanPrincipalRef !== common.humanPrincipalRef || approver.architectAcceptance.architectPrincipalRef !== common.architectPrincipalRef) fail('APPROVER_PRINCIPAL_MISMATCH');
    if (workerClassHash(c) !== approver.architectAcceptance.classHash) fail('WORKER_CLASS_NOT_ACCEPTED');
    const identity = common.currentImplementation();
    if (c.implementationSha !== approver.architectAcceptance.implementationSha || !identity.clean || identity.sha !== c.implementationSha || identity.codeHash !== c.workerCodeHash) fail('IMPLEMENTATION_NOT_ACCEPTED');
    return approver;
  };
  const workerFor = (c: Contract): GovernedWorker | null => {
    const known = workers.get(hash(c)); if (known) return known;
    const record = recordOf(c); if (!record) return null;
    const documents = bind(c, record.payload);
    const worker = createGovernedLimitedWorker({ ...common, liveCallGrant: documents[1].body, limitedGrant: documents[2].body,
      signaturePolicy: M1_SIGNATURE_POLICY.version, liveApproval: verifier });
    workers.set(hash(c), worker);
    return worker;
  };
  const challengeFor = (payload: ApprovalPayloadV1): ApprovalChallenge => ({ challenge: challengeOf(payload).toString('base64url'), rpId: 'localhost',
    credentialId: approver!.passkey.credentialId, timeoutMs: Math.max(1, Math.min(120_000, Date.parse(payload.expiresAt) - Date.parse(common.clock.now()))),
    expiresAt: payload.expiresAt, payload });
  return Object.freeze({ transportKind: common.transport.kind,
    permit: (c: Contract) => (workerFor(c) ?? base).permit(c),
    inspect: (c: Contract) => base.inspect(c),
    resultConsistency: (c: Contract) => base.resultConsistency(c),
    cancel: (c: Contract) => (workers.get(hash(c)) ?? base).cancel(c),
    activateIssued(): never { return fail('LIVE_RUNTIME_ACTIVATES_ON_APPROVED_START'); },
    /** What the Workspace shows next to a job: whether a passkey approval can be asked for, is pending or was used. */
    approvalStatus(c: Contract): ApprovalStatus {
      let refusal: string | null = null;
      try { eligible(c); } catch (error) { refusal = error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : 'APPROVAL_UNAVAILABLE'; }
      let pending: ApprovalChallenge | null = null, consumed = false;
      try {
        const job = jobOf(c); consumed = Boolean(job.approval);
        if (approver && job.approvalRequest && !consumed) {
          const payload = parsePayload(job.approvalRequest.payload);
          if (Date.parse(payload.expiresAt) > Date.parse(common.clock.now())) pending = challengeFor(payload);
        }
      } catch { pending = null; }
      return { configured: Boolean(approver), policy: M1_SIGNATURE_POLICY.version, keyId: approver?.keyId ?? null, protection: approver?.protection ?? null,
        classAccepted: Boolean(approver) && approver!.architectAcceptance.classHash === workerClassHash(c),
        implementationAccepted: Boolean(approver) && approver!.architectAcceptance.implementationSha === c.implementationSha,
        reviewRef: approver?.architectAcceptance.reviewRef ?? null, classHash: workerClassHash(c), pending, consumed, refusal };
    },
    /** Build, store and return the exact payload the Human is asked to sign for this run (a fresh window each time). */
    requestApproval(c: Contract, approvedMaxReservationMicroUsd: number): ApprovalChallenge {
      const a = eligible(c), job = jobOf(c), now = common.clock.now();
      if (job.state !== 'PREPARED' || job.generationClaimed || job.reservedMicroUsd || job.approval || recordOf(c)) fail('WORK_ALREADY_STARTED_OR_TERMINAL');
      if (approvedMaxReservationMicroUsd !== maximumCost(c)) fail('APPROVAL_DOES_NOT_MATCH_COST');
      const window = approvalWindow(a, c, now), { packet, documents, members } = documentsOf(c, window);
      const { setHash } = prospectiveActivationSet({ contract: c, packet, signaturePolicy: M1_SIGNATURE_POLICY.version, documents: members });
      const payload = parsePayload({ payloadSchema: 'chief-activation-attestation.v1', policyVersion: M1_SIGNATURE_POLICY.version, setHash, runId: c.runId,
        repository: c.repository, contractHash: hash(c), packetId: packet.packetId, packetHash: packetHash(packet),
        implementationSha: c.implementationSha, workerCodeHash: c.workerCodeHash, operations: ['LIMITED_README_WORKER', 'LIVE_PROVIDER_MODEL_CALL'],
        grants: [{ operation: 'LIMITED_README_WORKER', authorityId: documents[2].authorityId, version: 1, recordHash: recordHashOf(documents[2]) },
          { operation: 'LIVE_PROVIDER_MODEL_CALL', authorityId: documents[1].authorityId, version: 1, recordHash: recordHashOf(documents[1]) }],
        classHash: a.architectAcceptance.classHash, agentId: c.agentId, model: c.model, maxModelRequests: 1, maxRetries: 0,
        approvedMaxReservationMicroUsd, signerKeyId: a.keyId, rpId: 'localhost', ...window });
      store.change(hash(c), (j) => { j.approvalRequest = { payload, createdAt: now }; j.events.push({ at: now, kind: 'PASSKEY_APPROVAL_REQUESTED' }); });
      return challengeFor(payload);
    },
    /**
     * START: verify and consume the Human's assertion for the pending payload (once: the record file is exclusive),
     * then activate the three documents it names under the M1 set policy and run the governed Worker. A Host that
     * stopped after consuming re-uses that same consumed approval for the same run and never accepts another.
     */
    async execute(c: Contract, passkey?: unknown) {
      const a = eligible(c);
      let record = recordOf(c);
      if (!record) {
        const job = jobOf(c), now = common.clock.now();
        if (job.state !== 'PREPARED' || job.generationClaimed || job.reservedMicroUsd || job.approval) fail('WORK_ALREADY_STARTED_OR_TERMINAL');
        if (!job.approvalRequest) fail('APPROVAL_NOT_REQUESTED');
        if (passkey === undefined) fail('PASSKEY_APPROVAL_REQUIRED');
        const payload = parsePayload(job.approvalRequest!.payload);
        if (Date.parse(payload.expiresAt) <= Date.parse(now)) fail('APPROVAL_EXPIRED');
        bind(c, payload);
        const challenge = challengeOf(payload), verified = verifyAssertion(a, passkey, challenge);
        writeApprovalRecord(common.resultDirectory, { jobId: hash(c), payload, challenge: challenge.toString('base64url'),
          assertion: passkey as never, assertionHash: verified.assertionHash, keyId: a.keyId, signCount: verified.signCount, verifiedAt: now });
        store.change(hash(c), (j) => { j.approval = { payloadHash: hash(payload), assertionHash: verified.assertionHash, keyId: a.keyId, consumedAt: now };
          j.events.push({ at: now, kind: 'PASSKEY_APPROVAL_VERIFIED_AND_CONSUMED' }); });
        record = recordOf(c) ?? fail('APPROVAL_RECORD_MISSING');
      }
      const documents = bind(c, record.payload), worker = workerFor(c) ?? fail('APPROVAL_RECORD_MISSING');
      const job = jobOf(c);
      if (job.state === 'PREPARED' && !job.reservedMicroUsd) {
        const staged = worker.activateIssued(c, { implementationPacket: documents[0], liveCallAuthorizations: [documents[1]] }, documents[2]) as { activationSet: { setHash: string } };
        if (staged.activationSet.setHash !== record.payload.setHash) fail('ACTIVATION_SET_NOT_APPROVED');
      }
      return worker.execute(c);
    } });
}
