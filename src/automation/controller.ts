import { z } from 'zod';
import { InMemoryControllerStore, type ControllerStore } from './audit.js';
import {
  acceptedAt, assertRunInvariants, assertTransition, isActiveState, isStopState, isTerminalState, parseAcceptanceDecision,
  preflightPasses,
} from './lifecycle.js';
import { packetHash, parseCorrection, parsePacket, validateCorrection } from './packet.js';
import { evaluatePolicy, matchAuthorization, parseAuthorization } from './policy.js';
import { readBranch, readPostPromotion, readPreflight, unavailableRepositoryRealityPort,
  type RepositoryRealityPort } from './repository-reality.js';
import { parseInstant } from './time.js';
import {
  ROLES, STOP_CLASSES, type Actor, type Clock, type ControllerRun, type ControllerState, type StopClass,
} from './types.js';

// Authorization identity remains a later integration boundary. Repository facts
// are now read only from the injected reality port, never from method arguments.

const text = z.string().trim().min(1);
const actorSchema = z.strictObject({ id: text, role: z.enum(ROLES) });
const stopClassSchema = z.enum(STOP_CLASSES);
const CONTROLLER: Actor = Object.freeze({ id: 'controller', role: 'CONTROLLER' });

interface Instant { at: number; iso: string }

// Clock, store, and helpers are true private members and the instance is frozen: a
// TypeScript `private` or `readonly` is still writable at runtime, and swapping the
// clock or store after construction would move every authorization window and check.
export class AutomationController {
  readonly #clock: Clock;
  readonly #store: ControllerStore;
  readonly #write: (run: ControllerRun) => void;
  readonly #reality: RepositoryRealityPort;

  constructor(clock: Clock, store: ControllerStore = new InMemoryControllerStore(),
    reality: RepositoryRealityPort = unavailableRepositoryRealityPort()) {
    this.#clock = clock;
    this.#store = store;
    this.#write = store.bindController();
    this.#reality = reality;
    Object.freeze(this);
  }

  createRun(runId: string, sliceId: string, repository: string): ControllerRun {
    const run: ControllerRun = { runId: text.parse(runId), sliceId: text.parse(sliceId), repository: text.parse(repository),
      state: 'IDLE', implementationIterations: 0, acceptanceFailures: 0, audit: [] };
    this.#store.create(run);
    return this.get(run.runId);
  }
  get(runId: string): ControllerRun {
    const run = this.#store.get(runId);
    if (!run) throw new Error('Unknown controller run');
    assertRunInvariants(run);
    return run;
  }
  audit(runId: string) { return this.#store.entries(runId); }

  // Runtime inputs are parsed, whatever their static type claims, and only the parsed
  // copies are used afterwards.
  #actor(input: unknown): Actor {
    return actorSchema.parse(input) as Actor;
  }
  #now(): Instant {
    const at = parseInstant(this.#clock.now());
    if (at === undefined) throw new Error('Clock returned an invalid timestamp');
    return { at, iso: new Date(at).toISOString() };
  }
  #require(run: ControllerRun, state: ControllerState, actor: Actor, role: Actor['role']): void {
    if (run.state !== state || actor.role !== role) throw new Error(`Illegal transition from ${run.state}`);
  }
  #runtimeExceeded(run: ControllerRun, now: Instant): boolean {
    const started = parseInstant(run.iterationStartedAt);
    return !run.activePacket || started === undefined ||
      now.at - started > run.activePacket.iterationBudget.maxRuntimeMinutesPerIteration * 60_000;
  }
  #consumed(run: ControllerRun, authorizationId: string): boolean {
    return run.audit.some((entry) => entry.authorizationReference === authorizationId);
  }
  #workCurrent(run: ControllerRun, now: Instant): boolean {
    return readBranch(this.#reality, run.repository, run.activePacket!.targetBranch, now.at).sha === run.remoteSha?.sha;
  }
  #needsRecheck(run: ControllerRun): void {
    if (run.externalRecheckRequired === true) throw new Error('External reality recheck required');
  }
  // Every state change goes through here and is checked against the shared lifecycle
  // before the store sees it; the store checks it again.
  #commit(run: ControllerRun, next: ControllerState, actor: Actor, action: string, now: Instant,
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
    this.#write(run);
    return this.get(run.runId);
  }

  enterArchitecture(runId: string, actor: Actor): ControllerRun {
    const who = this.#actor(actor);
    const run = this.get(runId);
    this.#require(run, 'IDLE', who, 'GPT_ARCHITECT');
    return this.#commit(run, 'ARCHITECTURE', who, 'ENTER_ARCHITECTURE', this.#now());
  }
  issuePacket(runId: string, actor: Actor, input: unknown): ControllerRun {
    const who = this.#actor(actor);
    const run = this.get(runId);
    this.#require(run, 'ARCHITECTURE', who, 'GPT_ARCHITECT');
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
    return this.#commit(run, 'PACKET_READY', who, 'ISSUE_PACKET', this.#now());
  }
  beginImplementation(runId: string, actor: Actor): ControllerRun {
    const who = this.#actor(actor);
    const run = this.get(runId);
    if (who.role !== 'CODEX_IMPLEMENTER' ||
        !['PACKET_READY', 'CORRECTION_REQUIRED'].includes(run.state) || !run.activePacket) throw new Error('Illegal implementation start');
    this.#needsRecheck(run);
    const now = this.#now();
    if (run.implementationIterations >= run.activePacket.iterationBudget.maxImplementationIterationsPerSlice) {
      return this.#halt(run, CONTROLLER, 'HUMAN_STOP', 'implementation iteration budget exhausted', now);
    }
    if (run.state === 'CORRECTION_REQUIRED' &&
        (run.correctionPacket?.rejectedSha !== run.remoteSha?.sha ||
         run.correctionPacket?.correctionIteration !== run.implementationIterations + 1)) {
      throw new Error('Current rejection requires an exact correction packet');
    }
    run.implementationIterations += 1;
    run.iterationStartedAt = now.iso;
    run.remoteSha = undefined;
    run.acceptance = undefined;
    return this.#commit(run, 'IMPLEMENTING', who, 'BEGIN_IMPLEMENTATION', now);
  }
  completeImplementation(runId: string, actor: Actor, validationEvidence: string[]): ControllerRun {
    const who = this.#actor(actor);
    const run = this.get(runId);
    this.#require(run, 'IMPLEMENTING', who, 'CODEX_IMPLEMENTER');
    z.array(text).min(1).parse(validationEvidence);
    const now = this.#now();
    if (this.#runtimeExceeded(run, now)) {
      return this.#halt(run, CONTROLLER, 'HUMAN_STOP', 'implementation runtime budget exhausted', now);
    }
    return this.#commit(run, 'IMPLEMENTATION_COMPLETE', who, 'REPORT_IMPLEMENTATION_COMPLETE', now);
  }
  recordRemoteSha(runId: string, actor: Actor): ControllerRun {
    if (arguments.length !== 2) throw new Error('Caller-supplied remote facts are forbidden');
    const who = this.#actor(actor);
    const run = this.get(runId);
    this.#require(run, 'IMPLEMENTATION_COMPLETE', who, 'CODEX_IMPLEMENTER');
    const now = this.#now();
    this.#needsRecheck(run);
    const evidence = readBranch(this.#reality, run.repository, run.activePacket!.targetBranch, now.at);
    run.remoteSha = evidence;
    return this.#commit(run, 'REMOTE_SHA_READY', who, 'RECORD_REMOTE_SHA', now, { resultingSHA: evidence.sha });
  }
  beginAcceptanceReview(runId: string, actor: Actor): ControllerRun {
    const who = this.#actor(actor);
    const run = this.get(runId);
    this.#require(run, 'REMOTE_SHA_READY', who, 'GPT_ARCHITECT');
    if (!run.remoteSha) throw new Error('No remote SHA');
    const now = this.#now();
    this.#needsRecheck(run);
    if (!this.#workCurrent(run, now)) return this.#halt(run, CONTROLLER, 'ARCHITECTURE_STOP', 'work branch moved after remote SHA evidence', now);
    return this.#commit(run, 'ACCEPTANCE_REVIEW', who, 'BEGIN_REMOTE_ACCEPTANCE', now);
  }
  // The only path that creates ACCEPTED: an independent GPT decision bound to the
  // exact remote SHA and packet. Implementer and controller roles are refused.
  decideAcceptance(runId: string, actor: Actor, input: unknown): ControllerRun {
    const who = this.#actor(actor);
    const run = this.get(runId);
    this.#require(run, 'ACCEPTANCE_REVIEW', who, 'GPT_ARCHITECT');
    const decision = parseAcceptanceDecision(input);
    const now = this.#now();
    this.#needsRecheck(run);
    if (!this.#workCurrent(run, now)) return this.#halt(run, CONTROLLER, 'ARCHITECTURE_STOP', 'work branch moved during acceptance', now);
    if (decision.packetId !== run.activePacket?.packetId || decision.packetHash !== run.activePacketHash ||
        decision.reviewedSha !== run.remoteSha?.sha || parseInstant(decision.issuedAt)! > now.at ||
        (decision.decision === 'REJECT' && decision.findings.length === 0)) throw new Error('Acceptance does not bind active remote SHA/packet');
    run.acceptance = decision;
    if (decision.decision === 'ACCEPT') {
      return this.#commit(run, 'ACCEPTED', who, 'ACCEPT_EXACT_SHA', now, { acceptanceSHA: decision.reviewedSha });
    }
    run.acceptanceFailures += 1;
    const rejected = this.#commit(run, 'CORRECTION_REQUIRED', who, 'REJECT_EXACT_SHA', now, { acceptanceSHA: decision.reviewedSha });
    if (rejected.acceptanceFailures >= rejected.activePacket!.iterationBudget.maxAcceptanceFailuresPerSlice) {
      return this.#halt(rejected, CONTROLLER, 'HUMAN_STOP', 'acceptance failure budget exhausted', now);
    }
    return rejected;
  }
  issueCorrection(runId: string, actor: Actor, input: unknown): ControllerRun {
    const who = this.#actor(actor);
    const run = this.get(runId);
    this.#require(run, 'CORRECTION_REQUIRED', who, 'GPT_ARCHITECT');
    this.#needsRecheck(run);
    if (run.correctionPacket?.rejectedSha === run.remoteSha?.sha || !run.activePacket || !run.activePacketHash ||
        run.acceptance?.decision !== 'REJECT' || !run.remoteSha) throw new Error('Correction already recorded or rejection missing');
    const correction = parseCorrection(input);
    validateCorrection(correction, run.activePacket, run.activePacketHash, run.remoteSha.sha,
      run.acceptance.findings,
      run.implementationIterations + 1);
    run.correctionPacket = correction;
    return this.#commit(run, 'CORRECTION_REQUIRED', who, 'ISSUE_CORRECTION_PACKET', this.#now());
  }
  requestPromotion(runId: string, actor: Actor, auth: unknown): ControllerRun {
    if (arguments.length !== 3) throw new Error('Caller-supplied promotion facts are forbidden');
    const who = this.#actor(actor);
    const run = this.get(runId);
    this.#require(run, 'ACCEPTED', who, 'HUMAN');
    const grant = parseAuthorization(auth);
    const now = this.#now();
    this.#needsRecheck(run);
    const verdict = evaluatePolicy({ operation: 'FAST_FORWARD_MAIN', target: 'main', actor: who,
      packet: run.activePacket, runId: run.runId, authorization: grant, now: now.iso });
    if (!grant || verdict.decision !== 'AUTHORIZED') throw new Error(`Promotion unauthorized: ${grant ? verdict.reason : 'malformed authorization'}`);
    if (this.#consumed(run, grant.authorizationId)) throw new Error('Promotion authorization already used');
    const accepted = acceptedAt(run);
    if (accepted === undefined || parseInstant(grant.issuedAt)! < accepted) {
      throw new Error('Promotion authorization predates the acceptance it would promote');
    }
    if (!this.#workCurrent(run, now)) return this.#halt(run, CONTROLLER, 'ARCHITECTURE_STOP', 'work branch moved after acceptance', now);
    const facts = readPreflight(this.#reality, run, now.at);
    if (!preflightPasses(facts, run)) {
      return this.#halt(run, CONTROLLER, 'ARCHITECTURE_STOP', 'promotion preflight mismatch', now);
    }
    run.promotionAuthorization = grant as typeof run.promotionAuthorization;
    run.promotionPreflight = facts;
    return this.#commit(run, 'PROMOTION_READY', who, 'AUTHORIZE_PROMOTION', now,
      { authorizationReference: grant.authorizationId, acceptanceSHA: run.acceptance!.reviewedSha });
  }
  beginPromotion(runId: string, actor: Actor): ControllerRun {
    const who = this.#actor(actor);
    const run = this.get(runId);
    this.#require(run, 'PROMOTION_READY', who, 'CONTROLLER');
    const now = this.#now();
    this.#needsRecheck(run);
    // Re-checked now: a grant that expired after requestPromotion cannot start promotion.
    if (!matchAuthorization(run.promotionAuthorization, { role: 'HUMAN', operation: 'FAST_FORWARD_MAIN', target: 'main',
      runId: run.runId, packetId: run.activePacket?.packetId }, now.iso)) {
      throw new Error('Promotion authorization missing or no longer valid');
    }
    if (!this.#workCurrent(run, now) || !preflightPasses(readPreflight(this.#reality, run, now.at), run)) {
      return this.#halt(run, CONTROLLER, 'ARCHITECTURE_STOP', 'promotion preflight changed before begin', now);
    }
    return this.#commit(run, 'PROMOTING', who, 'MARK_PROMOTING', now);
  }
  recordPromotedMain(runId: string, actor: Actor): ControllerRun {
    if (arguments.length !== 2) throw new Error('Caller-supplied promoted-main facts are forbidden');
    const who = this.#actor(actor);
    const run = this.get(runId);
    this.#require(run, 'PROMOTING', who, 'CONTROLLER');
    const now = this.#now();
    this.#needsRecheck(run);
    const evidence = readBranch(this.#reality, run.repository, 'main', now.at);
    if (!this.#workCurrent(run, now)) {
      return this.#halt(run, CONTROLLER, 'ARCHITECTURE_STOP', 'work branch moved during promotion', now);
    }
    if (evidence.sha !== run.acceptance?.reviewedSha) throw new Error('Promoted main evidence mismatch');
    run.observedPromotedMainSha = evidence.sha;
    return this.#commit(run, 'CANONICAL_CI', who, 'RECORD_PROMOTED_MAIN', now, { resultingSHA: evidence.sha });
  }
  close(runId: string, actor: Actor): ControllerRun {
    if (arguments.length !== 2) throw new Error('Caller-supplied close facts are forbidden');
    const who = this.#actor(actor);
    const run = this.get(runId);
    this.#require(run, 'CANONICAL_CI', who, 'CONTROLLER');
    const now = this.#now();
    this.#needsRecheck(run);
    if (!this.#workCurrent(run, now)) return this.#halt(run, CONTROLLER, 'ARCHITECTURE_STOP', 'work branch moved after acceptance', now);
    const main = readBranch(this.#reality, run.repository, 'main', now.at);
    if (main.sha !== run.acceptance!.reviewedSha) return this.#halt(run, CONTROLLER, 'ARCHITECTURE_STOP', 'main moved during canonical CI', now);
    const { facts, pending, requiredCheckPresent, failed } = readPostPromotion(this.#reality, run, now.at);
    if (!facts.mainProtected || !requiredCheckPresent || failed) {
      return this.#halt(run, CONTROLLER, 'ARCHITECTURE_STOP', 'canonical CI, required check, or protection failed', now);
    }
    if (pending) return this.#commit(run, 'CANONICAL_CI', CONTROLLER, 'RECONCILE_PENDING', now);
    if (facts.observedMainSha !== run.acceptance?.reviewedSha ||
        facts.observedMainSha !== run.observedPromotedMainSha ||
        facts.expectedAcceptedSha !== run.acceptance?.reviewedSha ||
        !facts.mainCiPassed || !facts.requiredCheckPassed || !facts.mainProtected) throw new Error('Canonical CI or SHA verification failed');
    return this.#commit(run, 'CLOSED', who, 'CLOSE_VERIFIED_RUN', now, { acceptanceSHA: facts.expectedAcceptedSha });
  }
  /** Read-only restart reconciliation. It never retries a repository write. */
  reconcile(runId: string, actor: Actor): ControllerRun {
    if (arguments.length !== 2) throw new Error('Caller-supplied reconciliation facts are forbidden');
    const who = this.#actor(actor);
    if (who.role !== 'CONTROLLER') throw new Error('Only controller may reconcile');
    let run = this.get(runId);
    if (!isActiveState(run.state)) throw new Error('Only active runs may reconcile');
    const now = this.#now();
    if (run.remoteSha && !this.#workCurrent(run, now)) {
      return this.#halt(run, CONTROLLER, 'ARCHITECTURE_STOP', 'stored work SHA moved in repository', now);
    }
    if (run.state === 'PROMOTING') {
      const main = readBranch(this.#reality, run.repository, 'main', now.at);
      if (main.sha === run.activePacket!.expectedBaseSha) {
        return this.#halt(run, CONTROLLER, 'HUMAN_STOP', 'promotion side effect not observed; no automatic retry', now);
      }
      if (main.sha !== run.acceptance!.reviewedSha) {
        return this.#halt(run, CONTROLLER, 'ARCHITECTURE_STOP', 'main moved during promotion', now);
      }
      if (run.externalRecheckRequired === true) run = this.#clearRecheck(run, now);
      run.observedPromotedMainSha = main.sha;
      return this.#commit(run, 'CANONICAL_CI', CONTROLLER, 'RECOVER_PROMOTED_MAIN', now,
        { resultingSHA: main.sha });
    }
    if (run.state === 'CANONICAL_CI') {
      const main = readBranch(this.#reality, run.repository, 'main', now.at);
      if (main.sha !== run.acceptance!.reviewedSha) {
        return this.#halt(run, CONTROLLER, 'ARCHITECTURE_STOP', 'main moved during canonical CI', now);
      }
      const { facts, pending, requiredCheckPresent, failed } = readPostPromotion(this.#reality, run, now.at);
      if (!facts.mainProtected || !requiredCheckPresent || failed) {
        return this.#halt(run, CONTROLLER, 'ARCHITECTURE_STOP', 'canonical CI, required check, or protection failed', now);
      }
      if (run.externalRecheckRequired === true) run = this.#clearRecheck(run, now);
      if (pending) return this.#commit(run, 'CANONICAL_CI', CONTROLLER, 'RECONCILE_PENDING', now);
      return this.#commit(run, 'CLOSED', CONTROLLER, 'RECOVER_CLOSE', now,
        { acceptanceSHA: facts.expectedAcceptedSha });
    }
    if (run.externalRecheckRequired === true) {
      const main = readBranch(this.#reality, run.repository, 'main', now.at);
      if (run.activePacket && main.sha !== run.activePacket.expectedBaseSha) {
        return this.#halt(run, CONTROLLER, 'ARCHITECTURE_STOP', 'main changed before external recheck', now);
      }
      if (run.state === 'PROMOTION_READY' && !preflightPasses(readPreflight(this.#reality, run, now.at), run)) {
        return this.#halt(run, CONTROLLER, 'ARCHITECTURE_STOP', 'promotion preflight failed on recheck', now);
      }
      return this.#clearRecheck(run, now);
    }
    if (run.state === 'PROMOTION_READY' && !preflightPasses(readPreflight(this.#reality, run, now.at), run)) {
      return this.#halt(run, CONTROLLER, 'ARCHITECTURE_STOP', 'promotion preflight changed on restart', now);
    }
    return run;
  }
  #clearRecheck(run: ControllerRun, now: Instant): ControllerRun {
    run.externalRecheckRequired = false;
    return this.#commit(run, run.state, CONTROLLER, 'RECHECK_EXTERNAL_REALITY', now);
  }
  // Accepts exactly the three operational stop classes at runtime; any other value,
  // including a lifecycle state such as ACCEPTED, is refused before anything changes.
  stop(runId: string, actor: Actor, stopClass: StopClass, reason: string): ControllerRun {
    const who = this.#actor(actor);
    const kind = stopClassSchema.parse(stopClass);
    const why = text.parse(reason);
    const run = this.get(runId);
    if (!isActiveState(run.state) || !['HUMAN', 'GPT_ARCHITECT', 'CONTROLLER'].includes(who.role)) throw new Error('Illegal stop');
    return this.#halt(run, who, kind, why, this.#now());
  }
  // A stop raised inside another operation reuses that operation's timestamp, so the
  // triggering commit and its stop cannot straddle a clock failure.
  #halt(run: ControllerRun, who: Actor, kind: StopClass, reason: string, now: Instant): ControllerRun {
    run.interruptedState = run.state;
    run.stopReason = reason;
    return this.#commit(run, kind, who, 'STOP', now);
  }
  resumeSoft(runId: string, actor: Actor, repairEvidence: string): ControllerRun {
    const who = this.#actor(actor);
    const run = this.get(runId);
    this.#require(run, 'SOFT_STOP', who, 'CONTROLLER');
    text.parse(repairEvidence);
    const now = this.#now();
    if (!run.interruptedState || !run.activePacket ||
        (run.interruptedState === 'IMPLEMENTING' && this.#runtimeExceeded(run, now)) ||
        (run.interruptedState === 'PACKET_READY' &&
          run.implementationIterations >= run.activePacket.iterationBudget.maxImplementationIterationsPerSlice)) {
      run.stopReason = 'implementation iteration budget exhausted';
      return this.#commit(run, 'HUMAN_STOP', who, 'BUDGET_EXHAUSTED', now);
    }
    const target = run.interruptedState;
    run.interruptedState = undefined;
    run.stopReason = undefined;
    return this.#commit(run, target, who, 'RESUME_SOFT_WITH_REPAIR', now);
  }
  resumeArchitecture(runId: string, actor: Actor): ControllerRun {
    const who = this.#actor(actor);
    const run = this.get(runId);
    this.#require(run, 'ARCHITECTURE_STOP', who, 'GPT_ARCHITECT');
    run.interruptedState = undefined;
    run.stopReason = undefined;
    return this.#commit(run, 'ARCHITECTURE', who, 'RETURN_TO_ARCHITECTURE', this.#now());
  }
  // A resume grant names one stop occurrence (run.stopId) and is consumed on use, so it
  // cannot resume a later HUMAN_STOP of the same run.
  resumeHuman(runId: string, actor: Actor, auth: unknown): ControllerRun {
    const who = this.#actor(actor);
    const run = this.get(runId);
    this.#require(run, 'HUMAN_STOP', who, 'HUMAN');
    const now = this.#now();
    const grant = matchAuthorization(auth, { role: 'HUMAN', operation: 'RESUME_HUMAN_STOP', target: run.stopId,
      runId: run.runId, packetId: run.activePacket?.packetId }, now.iso);
    if (!run.interruptedState || !grant || this.#consumed(run, grant.authorizationId)) {
      throw new Error('Exact, unused human authorization for this HUMAN_STOP occurrence required');
    }
    const target = run.interruptedState;
    run.interruptedState = undefined;
    run.stopReason = undefined;
    run.externalRecheckRequired = true;
    run.humanResumeAuthorization = grant as typeof run.humanResumeAuthorization;
    return this.#commit(run, target, who, 'RESUME_HUMAN_STOP', now, { authorizationReference: grant.authorizationId });
  }
  failClosed(runId: string, actor: Actor, reason: string): ControllerRun {
    const who = this.#actor(actor);
    const why = text.parse(reason);
    const run = this.get(runId);
    if (isTerminalState(run.state) || who.role !== 'CONTROLLER') throw new Error('Illegal terminal failure');
    run.stopReason = why;
    return this.#commit(run, 'FAILED_CLOSED', who, 'FAIL_CLOSED', this.#now());
  }
}
Object.freeze(AutomationController);
Object.freeze(AutomationController.prototype);
