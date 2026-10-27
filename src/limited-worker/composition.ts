import { AutomationController } from '../automation/controller.js';
import { FileControllerStore } from '../automation/durable-store.js';
import { FileInvocationJournal } from '../automation/file-invocation-journal.js';
import { AutomationRunner } from '../automation/runner.js';
import { openGovernedExecutionDriver } from '../automation/execution-driver.js';
import { readGovernedModel } from '../automation/read-model/governed-read-model.js';
import { GovernanceStoreIsolation } from '../automation/governance-store-isolation.js';
import type { Clock } from '../automation/types.js';
import { LimitedReadmeWorker } from './adapter.js';
import { SCOPE, EXE, hash, assertInputReady, contractOf, type Contract } from './contract.js';
import { WorkerStore } from './store.js';
import type { WorkerTransport } from './transport.js';
import type { SignaturePolicyVersion } from './activation-set.js';
import { packetFor } from './contract.js';
import { verifyPermit, limitedActivationCandidate } from './governance.js';
import type { GovernedActivationCore } from '../automation/activation-core.js';
import { readStoredOutcome } from '../automation/invocation-journal.js';
import { parseImplementationResult } from '../automation/bridge.js';
import { packetHash } from '../automation/packet.js';

/**
 * R3-B: evidence, in the Controller store rather than the results directory, that a Worker store with this identity
 * was used: a governed run activated with a limited packet whose contract is bound to it. Activation requires the
 * job in the ledger, and every reservation and claim comes after activation. Read only when a ledger is missing.
 */
export function limitedLedgerEvidence(roots: { controllerStoreDirectory: string; authorityArchiveDirectory: string },
  clock: Clock): (storageIdentity: string) => string | null {
  return (storageIdentity) => {
    const controller = new FileControllerStore(roots.controllerStoreDirectory, clock);
    for (const { runId } of readGovernedModel(roots, clock).runs) {
      const packet = controller.get(runId)?.activePacket;
      if (!packet || !packet.packetId.startsWith('limited-')) continue;
      if (contractOf(packet).storageIdentity === storageIdentity) return 'CONTROLLER_ACTIVATED_LIMITED_RUN';
    }
    return null;
  };
}

export function composeLimitedWorker(options: {
  controllerStoreDirectory: string; authorityArchiveDirectory: string; changeRegistryDirectory: string;
  journalDirectory: string; resultDirectory: string; architectPrincipalRef: string; humanPrincipalRef: string;
  implementationSha: string; workerCodeHash: string; clock: Clock; transport: WorkerTransport;
  currentImplementation(): { sha: string; codeHash: string; clean: boolean };
  liveCallGrant: unknown; limitedGrant: unknown; readSource(c: Contract): { text: string; sha: string; path: string; bytes: number; hash: string };
  readGoal(c: Contract): string; deadlineMs?: number;
  /** M1-B (trusted Host only): the signing policy of this worker's sets and the passkey attestation verifier. */
  signaturePolicy?: SignaturePolicyVersion; liveApproval?(c: Contract, setHash: string): void;
}, trusted?: {createActivation(controller:AutomationController):GovernedActivationCore;
  preserveIssued:NonNullable<Parameters<typeof limitedActivationCandidate>[0]['preserveIssued']>}) {
  options = { ...options, liveCallGrant: structuredClone(options.liveCallGrant), limitedGrant: structuredClone(options.limitedGrant) };
  const isolation = GovernanceStoreIsolation.forLiveRoots(options);
  isolation.assertDisjoint('limited worker journal', options.journalDirectory);
  isolation.assertDisjoint('limited worker results', options.resultDirectory);
  const store = new WorkerStore(options.resultDirectory, { initializationEvidence: limitedLedgerEvidence(options, options.clock) });
  const journal = new FileInvocationJournal(options.journalDirectory, options.clock);
  const controller = new AutomationController(options.clock, new FileControllerStore(options.controllerStoreDirectory, options.clock), {
    observeBranch() { throw new Error('LIMITED_WORKER_HAS_NO_GIT_DELIVERY'); }, compare() { throw new Error('LIMITED_WORKER_HAS_NO_GIT_DELIVERY'); },
    observeCi() { throw new Error('LIMITED_WORKER_HAS_NO_GIT_DELIVERY'); }, observeProtection() { throw new Error('LIMITED_WORKER_HAS_NO_GIT_DELIVERY'); } });
  const readModel = () => readGovernedModel(options, options.clock);
  const adapter = new LimitedReadmeWorker({ ...options, store, journal, humanGrant: options.limitedGrant, liveGrant: options.liveCallGrant,
    now: () => options.clock.now(), readModel, readRun: id => controller.get(id), activationSetRoot: store.directory, requireActivationSet: Boolean(trusted) });
  const scopes = { IMPLEMENTATION: structuredClone(SCOPE), ARCHITECT_REVIEW: { actorKind: 'ARCHITECT_REVIEW' as const, provider: 'openai', model: 'NOT_AUTHORIZED', egressDestinations: ['api.openai.com:443'] } };
  const runner = new AutomationRunner(controller, adapter, { review() { throw new Error('SECOND_AGENT_FORBIDDEN'); } },
    { journal, clock: options.clock, authorizations: { IMPLEMENTATION: options.liveCallGrant }, scopes });
  const driver = openGovernedExecutionDriver({ ...options, runner, liveCallAuthorizations: { IMPLEMENTATION: options.liveCallGrant }, scopes });
  const target = (c: Contract) => ({ source: { kind: 'WORKSPACE_GOAL' as const, projectId: c.projectId, goalId: c.goalId }, runId: c.runId });
  const activation=trusted?limitedActivationCandidate({core:trusted.createActivation(controller),store,readModel,
    humanPrincipalRef:options.humanPrincipalRef,architectPrincipalRef:options.architectPrincipalRef,now:()=>options.clock.now(),
    identity:options.currentImplementation,readSource:options.readSource,readGoal:options.readGoal,preserveIssued:trusted.preserveIssued,
    signaturePolicy:options.signaturePolicy}):null;
  return Object.freeze({
    /** M0: OFFLINE_SYNTHETIC or LIVE_PROVIDER, so the Workspace service can say which kind of run a START would be. */
    transportKind: options.transport.kind,
    activateIssued(c:Contract,bundle:unknown,limitedDocument:unknown){
      if(!activation)throw new Error('TRUSTED_ACTIVATION_NOT_COMPOSED');
      return activation.stage(hash(c),bundle,limitedDocument);
    },
    resultConsistency(c:Contract) {
      try {
        const job=store.read().jobs.find(j=>j.id===hash(c)),run=controller.get(c.runId);
        if(!job||!store.reportIsValid(job)||run.state!=='IMPLEMENTATION_COMPLETE')return false;
        const record=job.invocationId?journal.get(job.invocationId):undefined;
        if(!record||record.state!=='APPLIED'||record.identity.runId!==c.runId||record.identity.actorKind!=='IMPLEMENTATION'||
          record.identity.packetHash!==packetHash(packetFor(c,run.sliceId))||run.activePacketHash!==record.identity.packetHash)return false;
        const begin=run.audit[record.identity.occurrence.sequence-1],applied=run.audit[(record.application?.sequence??0)-1];
        if(!begin||begin.action!=='BEGIN_IMPLEMENTATION'||begin.timestamp!==record.identity.occurrence.timestamp||
          record.application?.sequence!==begin.sequence+1||record.application.action!=='REPORT_IMPLEMENTATION_COMPLETE'||applied?.action!==record.application.action)return false;
        const outcome=readStoredOutcome(record);if(!outcome.ok)return false;
        const result=parseImplementationResult(outcome.value);
        return result.status==='COMPLETED'&&[`limited-worker:${job.id}`,`report-sha256:${job.reportHash}`,`evidence-class:${job.evidenceClass}`].every(e=>result.validationEvidence.includes(e));
      }catch{return false;}
    },
    inspect: (c: Contract) => ({ driver: driver.inspect(target(c)), journal: journal.list(c.runId).map(r => ({ invocationId: r.invocationId, state: r.state,
      appliedAt:r.history.find(e=>e.state==='APPLIED')?.at??null })),
      job: store.read().jobs.find(j => j.id === hash(c)) ?? null }),
    permit(c: Contract) {
      const model = readModel(), run = model.runs.find(r => r.runId === c.runId);
      if (!run) throw new Error('RUN_BINDING_MISMATCH');
      return verifyPermit(c, { grant: options.limitedGrant, liveGrant: options.liveCallGrant, model, packet: packetFor(c, run.sliceId),
        humanPrincipalRef: options.humanPrincipalRef,architectPrincipalRef:options.architectPrincipalRef, now: options.clock.now() });
    },
    async execute(c: Contract) {
      if (options.transport.kind === 'LIVE_PROVIDER' && EXE === 'HOLD') throw new Error('EXE_HOLD');
      if (c.inputPolicy || options.transport.kind === 'LIVE_PROVIDER') assertInputReady(c);
      const position = driver.inspect(target(c));
      if (!['PACKET_READY', 'IMPLEMENTING'].includes(position.state ?? '')) throw new Error('LIMITED_WORKER_NOT_AT_OWNED_STAGE');
      // Exactly two protocol steps, never Runner.drive: no remote-SHA, review, Git delivery or promotion step exists here.
      if (position.state === 'PACKET_READY') await driver.step(target(c));
      const result = await driver.step(target(c)); return result;
    },
    cancel: (c: Contract) => adapter.cancel(hash(c)),
  });
}
