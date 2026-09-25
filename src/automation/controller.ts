import { z } from 'zod';
import { InMemoryControllerStore, type ControllerStore } from './audit.js';
import { PACKET_HASH, packetHash, parseCorrection, parsePacket, SHA, validateCorrection } from './packet.js';
import { evaluatePolicy, validAuthorization } from './policy.js';
import type {
  AcceptanceDecision, Actor, Clock, ControllerRun, ControllerState, CorrectionPacket,
  HumanAuthorization, ImplementationPacket, PostPromotionFacts, PromotionPreflightFacts,
  RemoteShaEvidence, StopClass,
} from './types.js';

// External SHA, CI, and authorization records are data-only in R1. A later
// adapter must authenticate issuers and verify facts before submitting them.

const text = z.string().trim().min(1);
const date = z.iso.datetime();
const remoteSchema = z.strictObject({ repository: text, branch: text, sha: SHA, observedAt: date, source: z.literal('GITHUB') });
const decisionSchema = z.strictObject({
  reviewId: text, actor: z.literal('GPT_ARCHITECT'), packetId: text, packetHash: PACKET_HASH,
  reviewedSha: SHA, decision: z.enum(['ACCEPT', 'REJECT']), findings: z.array(text),
  evidenceReferences: z.array(text).min(1), issuedAt: date,
});
const preflightSchema = z.strictObject({
  expectedMainSha: SHA, observedMainSha: SHA, acceptedSha: SHA,
  aheadBy: z.number().int().nonnegative(), behindBy: z.number().int().nonnegative(),
  hasMainOnlyCommits: z.boolean(), acceptedShaCiPassed: z.boolean(),
  requiredCheckPassed: z.boolean(), mainProtected: z.boolean(),
});
const postSchema = z.strictObject({
  observedMainSha: SHA, expectedAcceptedSha: SHA,
  mainCiPassed: z.boolean(), requiredCheckPassed: z.boolean(), mainProtected: z.boolean(),
});
const stops = new Set<ControllerState>(['SOFT_STOP', 'ARCHITECTURE_STOP', 'HUMAN_STOP']);
const terminal = new Set<ControllerState>(['CLOSED', 'FAILED_CLOSED']);

export class AutomationController {
  constructor(private readonly clock: Clock, private readonly store: ControllerStore = new InMemoryControllerStore()) {}

  createRun(runId: string, sliceId: string, repository: string): ControllerRun {
    text.parse(runId); text.parse(sliceId); text.parse(repository);
    const run: ControllerRun = { runId, sliceId, repository, state: 'IDLE',
      implementationIterations: 0, acceptanceFailures: 0, audit: [] };
    this.store.create(run);
    return this.get(runId);
  }
  get(runId: string): ControllerRun {
    const run = this.store.get(runId);
    if (!run) throw new Error('Unknown controller run');
    if (run.activePacket && (!run.activePacketHash || packetHash(run.activePacket) !== run.activePacketHash)) {
      throw new Error('Active packet substitution detected');
    }
    return run;
  }
  audit(runId: string) { return this.store.entries(runId); }

  private require(run: ControllerRun, state: ControllerState, actor: Actor, role: Actor['role']): void {
    if (run.state !== state || actor.role !== role || !actor.id) throw new Error(`Illegal transition from ${run.state}`);
  }
  private commit(run: ControllerRun, next: ControllerState, actor: Actor, action: string,
    extras: { authorizationReference?: string; resultingSHA?: string; acceptanceSHA?: string; stopReason?: string } = {}): ControllerRun {
    const previous = run.state;
    const timestamp = date.parse(this.clock.now());
    run.state = next;
    run.audit.push({ sequence: run.audit.length + 1, runId: run.runId, sliceId: run.sliceId,
      actor: actor.id, role: actor.role, action, timestamp, previousState: previous,
      nextState: next, repository: run.repository, branch: run.activePacket?.targetBranch,
      baseSHA: run.activePacket?.expectedBaseSha, resultingSHA: extras.resultingSHA,
      authorizationReference: extras.authorizationReference, packetId: run.activePacket?.packetId,
      packetHash: run.activePacketHash, acceptanceSHA: extras.acceptanceSHA, stopReason: extras.stopReason });
    this.store.replace(run);
    return this.get(run.runId);
  }

  enterArchitecture(runId: string, actor: Actor): ControllerRun {
    const run = this.get(runId);
    this.require(run, 'IDLE', actor, 'GPT_ARCHITECT');
    return this.commit(run, 'ARCHITECTURE', actor, 'ENTER_ARCHITECTURE');
  }
  issuePacket(runId: string, actor: Actor, input: unknown): ControllerRun {
    const run = this.get(runId);
    this.require(run, 'ARCHITECTURE', actor, 'GPT_ARCHITECT');
    const packet = parsePacket(input);
    if (packet.sliceId !== run.sliceId ||
        (run.activePacket && (packet.packetId === run.activePacket.packetId ||
          packet.packetVersion <= run.activePacket.packetVersion))) throw new Error('Packet identity/version mismatch');
    run.activePacket = structuredClone(packet);
    run.activePacketHash = packetHash(packet);
    run.correctionPacket = undefined;
    run.remoteSha = undefined;
    run.acceptance = undefined;
    return this.commit(run, 'PACKET_READY', actor, 'ISSUE_PACKET');
  }
  beginImplementation(runId: string, actor: Actor): ControllerRun {
    const run = this.get(runId);
    if (actor.role !== 'CODEX_IMPLEMENTER' || !actor.id ||
        !['PACKET_READY', 'CORRECTION_REQUIRED'].includes(run.state) || !run.activePacket) throw new Error('Illegal implementation start');
    if (run.implementationIterations >= run.activePacket.iterationBudget.maxImplementationIterationsPerSlice) {
      return this.stop(runId, { id: 'controller', role: 'CONTROLLER' }, 'HUMAN_STOP', 'implementation iteration budget exhausted');
    }
    if (run.state === 'CORRECTION_REQUIRED' &&
        (run.correctionPacket?.rejectedSha !== run.remoteSha?.sha ||
         run.correctionPacket?.correctionIteration !== run.implementationIterations + 1)) {
      throw new Error('Current rejection requires an exact correction packet');
    }
    run.implementationIterations += 1;
    run.iterationStartedAt = date.parse(this.clock.now());
    run.remoteSha = undefined;
    run.acceptance = undefined;
    return this.commit(run, 'IMPLEMENTING', actor, 'BEGIN_IMPLEMENTATION');
  }
  completeImplementation(runId: string, actor: Actor, validationEvidence: string[]): ControllerRun {
    const run = this.get(runId);
    this.require(run, 'IMPLEMENTING', actor, 'CODEX_IMPLEMENTER');
    z.array(text).min(1).parse(validationEvidence);
    if (!run.activePacket || !run.iterationStartedAt ||
        Date.parse(this.clock.now()) - Date.parse(run.iterationStartedAt) >
          run.activePacket.iterationBudget.maxRuntimeMinutesPerIteration * 60_000) {
      return this.stop(runId, { id: 'controller', role: 'CONTROLLER' }, 'HUMAN_STOP', 'implementation runtime budget exhausted');
    }
    return this.commit(run, 'IMPLEMENTATION_COMPLETE', actor, 'REPORT_IMPLEMENTATION_COMPLETE');
  }
  recordRemoteSha(runId: string, actor: Actor, input: unknown): ControllerRun {
    const run = this.get(runId);
    this.require(run, 'IMPLEMENTATION_COMPLETE', actor, 'CODEX_IMPLEMENTER');
    const evidence = remoteSchema.parse(input) as RemoteShaEvidence;
    if (evidence.repository !== run.repository || evidence.branch !== run.activePacket?.targetBranch ||
        evidence.observedAt > this.clock.now()) throw new Error('Remote SHA evidence mismatch');
    run.remoteSha = structuredClone(evidence);
    return this.commit(run, 'REMOTE_SHA_READY', actor, 'RECORD_REMOTE_SHA', { resultingSHA: evidence.sha });
  }
  beginAcceptanceReview(runId: string, actor: Actor): ControllerRun {
    const run = this.get(runId);
    this.require(run, 'REMOTE_SHA_READY', actor, 'GPT_ARCHITECT');
    if (!run.remoteSha) throw new Error('No remote SHA');
    return this.commit(run, 'ACCEPTANCE_REVIEW', actor, 'BEGIN_REMOTE_ACCEPTANCE');
  }
  decideAcceptance(runId: string, actor: Actor, input: unknown): ControllerRun {
    const run = this.get(runId);
    this.require(run, 'ACCEPTANCE_REVIEW', actor, 'GPT_ARCHITECT');
    const decision = decisionSchema.parse(input) as AcceptanceDecision;
    if (decision.packetId !== run.activePacket?.packetId || decision.packetHash !== run.activePacketHash ||
        decision.reviewedSha !== run.remoteSha?.sha || decision.issuedAt > this.clock.now() ||
        (decision.decision === 'REJECT' && decision.findings.length === 0)) throw new Error('Acceptance does not bind active remote SHA/packet');
    run.acceptance = structuredClone(decision);
    if (decision.decision === 'ACCEPT') {
      return this.commit(run, 'ACCEPTED', actor, 'ACCEPT_EXACT_SHA', { acceptanceSHA: decision.reviewedSha });
    }
    run.acceptanceFailures += 1;
    const rejected = this.commit(run, 'CORRECTION_REQUIRED', actor, 'REJECT_EXACT_SHA', { acceptanceSHA: decision.reviewedSha });
    if (rejected.acceptanceFailures >= rejected.activePacket!.iterationBudget.maxAcceptanceFailuresPerSlice) {
      return this.stop(runId, { id: 'controller', role: 'CONTROLLER' }, 'HUMAN_STOP', 'acceptance failure budget exhausted');
    }
    return rejected;
  }
  issueCorrection(runId: string, actor: Actor, input: unknown): ControllerRun {
    const run = this.get(runId);
    this.require(run, 'CORRECTION_REQUIRED', actor, 'GPT_ARCHITECT');
    if (run.correctionPacket?.rejectedSha === run.remoteSha?.sha || !run.activePacket || !run.activePacketHash ||
        run.acceptance?.decision !== 'REJECT' || !run.remoteSha) throw new Error('Correction already recorded or rejection missing');
    const correction = parseCorrection(input) as CorrectionPacket;
    validateCorrection(correction, run.activePacket, run.activePacketHash, run.remoteSha.sha,
      run.acceptance.findings,
      run.implementationIterations + 1);
    run.correctionPacket = structuredClone(correction);
    return this.commit(run, 'CORRECTION_REQUIRED', actor, 'ISSUE_CORRECTION_PACKET');
  }
  requestPromotion(runId: string, actor: Actor, input: unknown, auth: HumanAuthorization): ControllerRun {
    const run = this.get(runId);
    this.require(run, 'ACCEPTED', actor, 'HUMAN');
    const facts = preflightSchema.parse(input) as PromotionPreflightFacts;
    const verdict = evaluatePolicy({ operation: 'FAST_FORWARD_MAIN', target: 'main', actor,
      packet: run.activePacket, runId, authorization: auth, now: this.clock.now() });
    if (verdict.decision !== 'AUTHORIZED') throw new Error(`Promotion unauthorized: ${verdict.reason}`);
    if (facts.expectedMainSha !== run.activePacket?.expectedBaseSha ||
        facts.observedMainSha !== facts.expectedMainSha ||
        facts.acceptedSha !== run.acceptance?.reviewedSha || facts.acceptedSha !== run.remoteSha?.sha ||
        facts.aheadBy < 1 || facts.behindBy !== 0 || facts.hasMainOnlyCommits ||
        !facts.acceptedShaCiPassed || !facts.requiredCheckPassed || !facts.mainProtected) {
      return this.stop(runId, { id: 'controller', role: 'CONTROLLER' }, 'ARCHITECTURE_STOP', 'promotion preflight mismatch');
    }
    run.promotionAuthorization = structuredClone(auth);
    run.promotionPreflight = structuredClone(facts);
    return this.commit(run, 'PROMOTION_READY', actor, 'AUTHORIZE_PROMOTION',
      { authorizationReference: auth.authorizationId, acceptanceSHA: run.acceptance.reviewedSha });
  }
  beginPromotion(runId: string, actor: Actor): ControllerRun {
    const run = this.get(runId);
    this.require(run, 'PROMOTION_READY', actor, 'CONTROLLER');
    if (!run.promotionAuthorization || !run.promotionPreflight) throw new Error('Promotion preconditions missing');
    return this.commit(run, 'PROMOTING', actor, 'MARK_PROMOTING');
  }
  recordPromotedMain(runId: string, actor: Actor, input: unknown): ControllerRun {
    const run = this.get(runId);
    this.require(run, 'PROMOTING', actor, 'CONTROLLER');
    const evidence = remoteSchema.parse(input) as RemoteShaEvidence;
    if (evidence.repository !== run.repository || evidence.branch !== 'main' ||
        evidence.sha !== run.acceptance?.reviewedSha || evidence.observedAt > this.clock.now()) throw new Error('Promoted main evidence mismatch');
    run.observedPromotedMainSha = evidence.sha;
    return this.commit(run, 'CANONICAL_CI', actor, 'RECORD_PROMOTED_MAIN', { resultingSHA: evidence.sha });
  }
  close(runId: string, actor: Actor, input: unknown): ControllerRun {
    const run = this.get(runId);
    this.require(run, 'CANONICAL_CI', actor, 'CONTROLLER');
    const facts = postSchema.parse(input) as PostPromotionFacts;
    if (facts.observedMainSha !== run.acceptance?.reviewedSha ||
        facts.observedMainSha !== run.observedPromotedMainSha ||
        facts.expectedAcceptedSha !== run.acceptance?.reviewedSha ||
        !facts.mainCiPassed || !facts.requiredCheckPassed || !facts.mainProtected) throw new Error('Canonical CI or SHA verification failed');
    return this.commit(run, 'CLOSED', actor, 'CLOSE_VERIFIED_RUN', { acceptanceSHA: facts.expectedAcceptedSha });
  }
  stop(runId: string, actor: Actor, stopClass: StopClass, reason: string): ControllerRun {
    const run = this.get(runId);
    if (terminal.has(run.state) || stops.has(run.state) || !actor.id ||
        !['HUMAN', 'GPT_ARCHITECT', 'CONTROLLER'].includes(actor.role)) throw new Error('Illegal stop');
    text.parse(reason);
    run.interruptedState = run.state;
    run.stopReason = reason;
    return this.commit(run, stopClass, actor, 'STOP', { stopReason: reason });
  }
  resumeSoft(runId: string, actor: Actor, repairEvidence: string): ControllerRun {
    const run = this.get(runId);
    this.require(run, 'SOFT_STOP', actor, 'CONTROLLER');
    text.parse(repairEvidence);
    if (!run.interruptedState || !run.activePacket ||
        (run.interruptedState === 'IMPLEMENTING' && (!run.iterationStartedAt ||
          Date.parse(this.clock.now()) - Date.parse(run.iterationStartedAt) >
            run.activePacket.iterationBudget.maxRuntimeMinutesPerIteration * 60_000)) ||
        (run.interruptedState === 'PACKET_READY' &&
          run.implementationIterations >= run.activePacket.iterationBudget.maxImplementationIterationsPerSlice)) {
      return this.commit(run, 'HUMAN_STOP', actor, 'BUDGET_EXHAUSTED', { stopReason: 'implementation iteration budget exhausted' });
    }
    const target = run.interruptedState;
    run.interruptedState = undefined;
    run.stopReason = undefined;
    return this.commit(run, target, actor, 'RESUME_SOFT_WITH_REPAIR');
  }
  resumeArchitecture(runId: string, actor: Actor): ControllerRun {
    const run = this.get(runId);
    this.require(run, 'ARCHITECTURE_STOP', actor, 'GPT_ARCHITECT');
    run.interruptedState = undefined;
    run.stopReason = undefined;
    return this.commit(run, 'ARCHITECTURE', actor, 'RETURN_TO_ARCHITECTURE');
  }
  resumeHuman(runId: string, actor: Actor, auth: HumanAuthorization): ControllerRun {
    const run = this.get(runId);
    this.require(run, 'HUMAN_STOP', actor, 'HUMAN');
    if (!run.interruptedState || !validAuthorization(auth, 'RESUME_HUMAN_STOP', runId,
      runId, run.activePacket?.packetId, this.clock.now(), 'HUMAN')) throw new Error('Exact human resume authorization required');
    const target = run.interruptedState;
    run.interruptedState = undefined;
    run.stopReason = undefined;
    run.externalRecheckRequired = true;
    return this.commit(run, target, actor, 'RESUME_HUMAN_STOP', { authorizationReference: auth.authorizationId });
  }
  failClosed(runId: string, actor: Actor, reason: string): ControllerRun {
    const run = this.get(runId);
    if (terminal.has(run.state) || !actor.id || actor.role !== 'CONTROLLER') throw new Error('Illegal terminal failure');
    text.parse(reason);
    run.stopReason = reason;
    return this.commit(run, 'FAILED_CLOSED', actor, 'FAIL_CLOSED', { stopReason: reason });
  }
}
