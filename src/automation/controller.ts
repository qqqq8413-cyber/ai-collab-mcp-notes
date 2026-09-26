import { z } from 'zod';
import { InMemoryControllerStore, type ControllerStore } from './audit.js';
import {
  assertRunInvariants, assertTransition, isActiveState, isStopState, isTerminalState, parseAcceptanceDecision,
  parsePostPromotion, parsePromotionPreflight, parseRemoteSha, preflightPasses,
} from './lifecycle.js';
import { packetHash, parseCorrection, parsePacket, validateCorrection } from './packet.js';
import { evaluatePolicy, matchAuthorization, parseAuthorization } from './policy.js';
import { parseInstant } from './time.js';
import {
  ROLES, STOP_CLASSES, type Actor, type Clock, type ControllerRun, type ControllerState, type StopClass,
} from './types.js';

// External SHA, CI, and authorization records are data-only in R1. A later
// adapter must authenticate issuers and verify facts before submitting them.

const text = z.string().trim().min(1);
const actorSchema = z.strictObject({ id: text, role: z.enum(ROLES) });
const stopClassSchema = z.enum(STOP_CLASSES);
const CONTROLLER: Actor = Object.freeze({ id: 'controller', role: 'CONTROLLER' });

interface Instant { at: number; iso: string }

export class AutomationController {
  constructor(private readonly clock: Clock, private readonly store: ControllerStore = new InMemoryControllerStore()) {}

  createRun(runId: string, sliceId: string, repository: string): ControllerRun {
    const run: ControllerRun = { runId: text.parse(runId), sliceId: text.parse(sliceId), repository: text.parse(repository),
      state: 'IDLE', implementationIterations: 0, acceptanceFailures: 0, audit: [] };
    this.store.create(run);
    return this.get(run.runId);
  }
  get(runId: string): ControllerRun {
    const run = this.store.get(runId);
    if (!run) throw new Error('Unknown controller run');
    assertRunInvariants(run);
    return run;
  }
  audit(runId: string) { return this.store.entries(runId); }

  // Runtime inputs are parsed, whatever their static type claims, and only the parsed
  // copies are used afterwards.
  private actor(input: unknown): Actor {
    return actorSchema.parse(input) as Actor;
  }
  private now(): Instant {
    const at = parseInstant(this.clock.now());
    if (at === undefined) throw new Error('Clock returned an invalid timestamp');
    return { at, iso: new Date(at).toISOString() };
  }
  private require(run: ControllerRun, state: ControllerState, actor: Actor, role: Actor['role']): void {
    if (run.state !== state || actor.role !== role) throw new Error(`Illegal transition from ${run.state}`);
  }
  private runtimeExceeded(run: ControllerRun, now: Instant): boolean {
    const started = parseInstant(run.iterationStartedAt);
    return !run.activePacket || started === undefined ||
      now.at - started > run.activePacket.iterationBudget.maxRuntimeMinutesPerIteration * 60_000;
  }
  private consumed(run: ControllerRun, authorizationId: string): boolean {
    return run.audit.some((entry) => entry.authorizationReference === authorizationId);
  }
  // Every state change goes through here and is checked against the shared lifecycle
  // before the store sees it; the store checks it again.
  private commit(run: ControllerRun, next: ControllerState, actor: Actor, action: string, now: Instant,
    extras: { authorizationReference?: string; resultingSHA?: string; acceptanceSHA?: string } = {}): ControllerRun {
    const before = this.get(run.runId);
    const previous = run.state;
    const sequence = run.audit.length + 1;
    run.state = next;
    run.stopId = isStopState(next) ? `stop-${sequence}` : undefined;
    const recordsStop = isStopState(next) || next === 'FAILED_CLOSED';
    run.audit.push({ sequence, runId: run.runId, sliceId: run.sliceId,
      actor: actor.id, role: actor.role, action, timestamp: now.iso, previousState: previous,
      nextState: next, repository: run.repository, branch: run.activePacket?.targetBranch,
      baseSHA: run.activePacket?.expectedBaseSha, resultingSHA: extras.resultingSHA,
      authorizationReference: extras.authorizationReference, packetId: run.activePacket?.packetId,
      packetHash: run.activePacketHash, acceptanceSHA: extras.acceptanceSHA,
      stopReason: recordsStop ? run.stopReason : undefined, stopId: run.stopId });
    assertTransition(before, run);
    this.store.replace(run);
    return this.get(run.runId);
  }

  enterArchitecture(runId: string, actor: Actor): ControllerRun {
    const who = this.actor(actor);
    const run = this.get(runId);
    this.require(run, 'IDLE', who, 'GPT_ARCHITECT');
    return this.commit(run, 'ARCHITECTURE', who, 'ENTER_ARCHITECTURE', this.now());
  }
  issuePacket(runId: string, actor: Actor, input: unknown): ControllerRun {
    const who = this.actor(actor);
    const run = this.get(runId);
    this.require(run, 'ARCHITECTURE', who, 'GPT_ARCHITECT');
    const packet = parsePacket(input);
    if (packet.sliceId !== run.sliceId ||
        (run.activePacket && (packet.packetId === run.activePacket.packetId ||
          packet.packetVersion <= run.activePacket.packetVersion))) throw new Error('Packet identity/version mismatch');
    run.activePacket = packet;
    run.activePacketHash = packetHash(packet);
    run.correctionPacket = undefined;
    run.remoteSha = undefined;
    run.acceptance = undefined;
    run.promotionAuthorization = undefined;
    run.promotionPreflight = undefined;
    run.observedPromotedMainSha = undefined;
    return this.commit(run, 'PACKET_READY', who, 'ISSUE_PACKET', this.now());
  }
  beginImplementation(runId: string, actor: Actor): ControllerRun {
    const who = this.actor(actor);
    const run = this.get(runId);
    if (who.role !== 'CODEX_IMPLEMENTER' ||
        !['PACKET_READY', 'CORRECTION_REQUIRED'].includes(run.state) || !run.activePacket) throw new Error('Illegal implementation start');
    if (run.implementationIterations >= run.activePacket.iterationBudget.maxImplementationIterationsPerSlice) {
      return this.stop(runId, CONTROLLER, 'HUMAN_STOP', 'implementation iteration budget exhausted');
    }
    if (run.state === 'CORRECTION_REQUIRED' &&
        (run.correctionPacket?.rejectedSha !== run.remoteSha?.sha ||
         run.correctionPacket?.correctionIteration !== run.implementationIterations + 1)) {
      throw new Error('Current rejection requires an exact correction packet');
    }
    const now = this.now();
    run.implementationIterations += 1;
    run.iterationStartedAt = now.iso;
    run.remoteSha = undefined;
    run.acceptance = undefined;
    return this.commit(run, 'IMPLEMENTING', who, 'BEGIN_IMPLEMENTATION', now);
  }
  completeImplementation(runId: string, actor: Actor, validationEvidence: string[]): ControllerRun {
    const who = this.actor(actor);
    const run = this.get(runId);
    this.require(run, 'IMPLEMENTING', who, 'CODEX_IMPLEMENTER');
    z.array(text).min(1).parse(validationEvidence);
    const now = this.now();
    if (this.runtimeExceeded(run, now)) {
      return this.stop(runId, CONTROLLER, 'HUMAN_STOP', 'implementation runtime budget exhausted');
    }
    return this.commit(run, 'IMPLEMENTATION_COMPLETE', who, 'REPORT_IMPLEMENTATION_COMPLETE', now);
  }
  recordRemoteSha(runId: string, actor: Actor, input: unknown): ControllerRun {
    const who = this.actor(actor);
    const run = this.get(runId);
    this.require(run, 'IMPLEMENTATION_COMPLETE', who, 'CODEX_IMPLEMENTER');
    const evidence = parseRemoteSha(input);
    const now = this.now();
    if (evidence.repository !== run.repository || evidence.branch !== run.activePacket?.targetBranch ||
        parseInstant(evidence.observedAt)! > now.at) throw new Error('Remote SHA evidence mismatch');
    run.remoteSha = evidence;
    return this.commit(run, 'REMOTE_SHA_READY', who, 'RECORD_REMOTE_SHA', now, { resultingSHA: evidence.sha });
  }
  beginAcceptanceReview(runId: string, actor: Actor): ControllerRun {
    const who = this.actor(actor);
    const run = this.get(runId);
    this.require(run, 'REMOTE_SHA_READY', who, 'GPT_ARCHITECT');
    if (!run.remoteSha) throw new Error('No remote SHA');
    return this.commit(run, 'ACCEPTANCE_REVIEW', who, 'BEGIN_REMOTE_ACCEPTANCE', this.now());
  }
  // The only path that creates ACCEPTED: an independent GPT decision bound to the
  // exact remote SHA and packet. Implementer and controller roles are refused.
  decideAcceptance(runId: string, actor: Actor, input: unknown): ControllerRun {
    const who = this.actor(actor);
    const run = this.get(runId);
    this.require(run, 'ACCEPTANCE_REVIEW', who, 'GPT_ARCHITECT');
    const decision = parseAcceptanceDecision(input);
    const now = this.now();
    if (decision.packetId !== run.activePacket?.packetId || decision.packetHash !== run.activePacketHash ||
        decision.reviewedSha !== run.remoteSha?.sha || parseInstant(decision.issuedAt)! > now.at ||
        (decision.decision === 'REJECT' && decision.findings.length === 0)) throw new Error('Acceptance does not bind active remote SHA/packet');
    run.acceptance = decision;
    if (decision.decision === 'ACCEPT') {
      return this.commit(run, 'ACCEPTED', who, 'ACCEPT_EXACT_SHA', now, { acceptanceSHA: decision.reviewedSha });
    }
    run.acceptanceFailures += 1;
    const rejected = this.commit(run, 'CORRECTION_REQUIRED', who, 'REJECT_EXACT_SHA', now, { acceptanceSHA: decision.reviewedSha });
    if (rejected.acceptanceFailures >= rejected.activePacket!.iterationBudget.maxAcceptanceFailuresPerSlice) {
      return this.stop(runId, CONTROLLER, 'HUMAN_STOP', 'acceptance failure budget exhausted');
    }
    return rejected;
  }
  issueCorrection(runId: string, actor: Actor, input: unknown): ControllerRun {
    const who = this.actor(actor);
    const run = this.get(runId);
    this.require(run, 'CORRECTION_REQUIRED', who, 'GPT_ARCHITECT');
    if (run.correctionPacket?.rejectedSha === run.remoteSha?.sha || !run.activePacket || !run.activePacketHash ||
        run.acceptance?.decision !== 'REJECT' || !run.remoteSha) throw new Error('Correction already recorded or rejection missing');
    const correction = parseCorrection(input);
    validateCorrection(correction, run.activePacket, run.activePacketHash, run.remoteSha.sha,
      run.acceptance.findings,
      run.implementationIterations + 1);
    run.correctionPacket = correction;
    return this.commit(run, 'CORRECTION_REQUIRED', who, 'ISSUE_CORRECTION_PACKET', this.now());
  }
  requestPromotion(runId: string, actor: Actor, input: unknown, auth: unknown): ControllerRun {
    const who = this.actor(actor);
    const run = this.get(runId);
    this.require(run, 'ACCEPTED', who, 'HUMAN');
    const facts = parsePromotionPreflight(input);
    const grant = parseAuthorization(auth);
    const now = this.now();
    const verdict = evaluatePolicy({ operation: 'FAST_FORWARD_MAIN', target: 'main', actor: who,
      packet: run.activePacket, runId: run.runId, authorization: grant, now: now.iso });
    if (!grant || verdict.decision !== 'AUTHORIZED') throw new Error(`Promotion unauthorized: ${grant ? verdict.reason : 'malformed authorization'}`);
    if (this.consumed(run, grant.authorizationId)) throw new Error('Promotion authorization already used');
    if (!preflightPasses(facts, run)) {
      return this.stop(runId, CONTROLLER, 'ARCHITECTURE_STOP', 'promotion preflight mismatch');
    }
    run.promotionAuthorization = grant as typeof run.promotionAuthorization;
    run.promotionPreflight = facts;
    return this.commit(run, 'PROMOTION_READY', who, 'AUTHORIZE_PROMOTION', now,
      { authorizationReference: grant.authorizationId, acceptanceSHA: run.acceptance!.reviewedSha });
  }
  beginPromotion(runId: string, actor: Actor): ControllerRun {
    const who = this.actor(actor);
    const run = this.get(runId);
    this.require(run, 'PROMOTION_READY', who, 'CONTROLLER');
    const now = this.now();
    // Re-checked now: a grant that expired after requestPromotion cannot start promotion.
    if (!matchAuthorization(run.promotionAuthorization, { role: 'HUMAN', operation: 'FAST_FORWARD_MAIN', target: 'main',
      runId: run.runId, packetId: run.activePacket?.packetId }, now.iso)) {
      throw new Error('Promotion authorization missing or no longer valid');
    }
    return this.commit(run, 'PROMOTING', who, 'MARK_PROMOTING', now);
  }
  recordPromotedMain(runId: string, actor: Actor, input: unknown): ControllerRun {
    const who = this.actor(actor);
    const run = this.get(runId);
    this.require(run, 'PROMOTING', who, 'CONTROLLER');
    const evidence = parseRemoteSha(input);
    const now = this.now();
    if (evidence.repository !== run.repository || evidence.branch !== 'main' ||
        evidence.sha !== run.acceptance?.reviewedSha || parseInstant(evidence.observedAt)! > now.at) throw new Error('Promoted main evidence mismatch');
    run.observedPromotedMainSha = evidence.sha;
    return this.commit(run, 'CANONICAL_CI', who, 'RECORD_PROMOTED_MAIN', now, { resultingSHA: evidence.sha });
  }
  close(runId: string, actor: Actor, input: unknown): ControllerRun {
    const who = this.actor(actor);
    const run = this.get(runId);
    this.require(run, 'CANONICAL_CI', who, 'CONTROLLER');
    const facts = parsePostPromotion(input);
    if (facts.observedMainSha !== run.acceptance?.reviewedSha ||
        facts.observedMainSha !== run.observedPromotedMainSha ||
        facts.expectedAcceptedSha !== run.acceptance?.reviewedSha ||
        !facts.mainCiPassed || !facts.requiredCheckPassed || !facts.mainProtected) throw new Error('Canonical CI or SHA verification failed');
    return this.commit(run, 'CLOSED', who, 'CLOSE_VERIFIED_RUN', this.now(), { acceptanceSHA: facts.expectedAcceptedSha });
  }
  // Accepts exactly the three operational stop classes at runtime; any other value,
  // including a lifecycle state such as ACCEPTED, is refused before anything changes.
  stop(runId: string, actor: Actor, stopClass: StopClass, reason: string): ControllerRun {
    const who = this.actor(actor);
    const kind = stopClassSchema.parse(stopClass);
    const why = text.parse(reason);
    const run = this.get(runId);
    if (!isActiveState(run.state) || !['HUMAN', 'GPT_ARCHITECT', 'CONTROLLER'].includes(who.role)) throw new Error('Illegal stop');
    run.interruptedState = run.state;
    run.stopReason = why;
    return this.commit(run, kind, who, 'STOP', this.now());
  }
  resumeSoft(runId: string, actor: Actor, repairEvidence: string): ControllerRun {
    const who = this.actor(actor);
    const run = this.get(runId);
    this.require(run, 'SOFT_STOP', who, 'CONTROLLER');
    text.parse(repairEvidence);
    const now = this.now();
    if (!run.interruptedState || !run.activePacket ||
        (run.interruptedState === 'IMPLEMENTING' && this.runtimeExceeded(run, now)) ||
        (run.interruptedState === 'PACKET_READY' &&
          run.implementationIterations >= run.activePacket.iterationBudget.maxImplementationIterationsPerSlice)) {
      run.stopReason = 'implementation iteration budget exhausted';
      return this.commit(run, 'HUMAN_STOP', who, 'BUDGET_EXHAUSTED', now);
    }
    const target = run.interruptedState;
    run.interruptedState = undefined;
    run.stopReason = undefined;
    return this.commit(run, target, who, 'RESUME_SOFT_WITH_REPAIR', now);
  }
  resumeArchitecture(runId: string, actor: Actor): ControllerRun {
    const who = this.actor(actor);
    const run = this.get(runId);
    this.require(run, 'ARCHITECTURE_STOP', who, 'GPT_ARCHITECT');
    run.interruptedState = undefined;
    run.stopReason = undefined;
    return this.commit(run, 'ARCHITECTURE', who, 'RETURN_TO_ARCHITECTURE', this.now());
  }
  // A resume grant names one stop occurrence (run.stopId) and is consumed on use, so it
  // cannot resume a later HUMAN_STOP of the same run.
  resumeHuman(runId: string, actor: Actor, auth: unknown): ControllerRun {
    const who = this.actor(actor);
    const run = this.get(runId);
    this.require(run, 'HUMAN_STOP', who, 'HUMAN');
    const now = this.now();
    const grant = matchAuthorization(auth, { role: 'HUMAN', operation: 'RESUME_HUMAN_STOP', target: run.stopId,
      runId: run.runId, packetId: run.activePacket?.packetId }, now.iso);
    if (!run.interruptedState || !grant || this.consumed(run, grant.authorizationId)) {
      throw new Error('Exact, unused human authorization for this HUMAN_STOP occurrence required');
    }
    const target = run.interruptedState;
    run.interruptedState = undefined;
    run.stopReason = undefined;
    run.externalRecheckRequired = true;
    run.humanResumeAuthorization = grant as typeof run.humanResumeAuthorization;
    return this.commit(run, target, who, 'RESUME_HUMAN_STOP', now, { authorizationReference: grant.authorizationId });
  }
  failClosed(runId: string, actor: Actor, reason: string): ControllerRun {
    const who = this.actor(actor);
    const why = text.parse(reason);
    const run = this.get(runId);
    if (isTerminalState(run.state) || who.role !== 'CONTROLLER') throw new Error('Illegal terminal failure');
    run.stopReason = why;
    return this.commit(run, 'FAILED_CLOSED', who, 'FAIL_CLOSED', this.now());
  }
}
