import {
  ARCHITECT_REVIEW_ACTOR, IMPLEMENTATION_ACTOR, RUNNER_ACTOR, implementationInput, parseImplementationResult,
  parseReviewBundle, reviewInput, type ArchitectReviewPort, type ImplementationAgentPort,
} from './bridge.js';
import { AutomationController } from './controller.js';
import { isStopState, isTerminalState } from './lifecycle.js';
import type { AuditEntry, ControllerOccurrenceGuard, ControllerRun, ControllerState, StopClass } from './types.js';

// Drives an existing AutomationController through implementation and independent
// acceptance, one bounded step at a time. The controller owns every state, counter,
// budget, and validation; the runner only chooses which public controller method the
// current state calls for, and calls an external actor only from a state this runner
// instance itself entered. It stops at ACCEPTED: promotion is a human decision.
//
// An actor's result belongs to the exact audit occurrence the actor was called for.
// Every write that applies a result, or a stop decided from a run as observed, is
// bound to that occurrence through the controller's guarded entrypoints, so it can
// never land on a later or resumed occurrence of the same state.

export const RUNNER_OUTCOMES = Object.freeze([
  'ADVANCED', 'AWAITING_CORRECTION', 'EXTERNAL_RECHECK_REQUIRED', 'HUMAN_PROMOTION_REQUIRED', 'STOPPED',
  'TERMINAL', 'OUT_OF_SCOPE', 'ACTOR_RESULT_DISCARDED', 'STALE_OCCURRENCE', 'STEP_LIMIT_REACHED',
] as const);
export type RunnerOutcome = typeof RUNNER_OUTCOMES[number];

export interface RunnerResult {
  runId: string;
  outcome: RunnerOutcome;
  state: ControllerState;
  stopReason?: string;
  detail?: string;
  /** drive only: steps taken. */
  steps?: number;
}

/** The states this runner advances. Every other state is a wait point for someone else. */
const RUNNER_STATES = new Set<ControllerState>(['PACKET_READY', 'IMPLEMENTING', 'IMPLEMENTATION_COMPLETE',
  'REMOTE_SHA_READY', 'ACCEPTANCE_REVIEW', 'CORRECTION_REQUIRED']);

const RESTART_IMPLEMENTATION = 'uncertain implementation-agent side effect after runner restart; not replayed';
const RESTART_REVIEW = 'uncertain architect-review side effect after runner restart; not replayed';
const NO_IMPLEMENTATION_RESULT = 'implementation-agent call returned no result; uncertain side effect; not replayed';
const NO_REVIEW_RESULT = 'architect-review call returned no result; uncertain side effect; not replayed';
// A report the agent returned but the bridge or controller refuses still leaves its
// side effects unknown, so it goes to a human.
const UNUSABLE_IMPLEMENTATION = 'implementation-agent result is outside the bridge contract or was refused; not recorded';
// A review the bridge or controller refuses is an ambiguous acceptance, which the
// governance contract routes to the architect.
const UNUSABLE_REVIEW = 'architect review is malformed or does not bind the active packet and remote SHA; not recorded';
const LEFT_OCCURRENCE = 'the run left the occurrence this step was bound to; nothing was recorded';

function occurrenceOf(runId: string, entry: AuditEntry): ControllerOccurrenceGuard {
  return Object.freeze({ runId, sequence: entry.sequence, action: entry.action, timestamp: entry.timestamp });
}
function sameEntry(guard: ControllerOccurrenceGuard, entry: AuditEntry | undefined): boolean {
  return entry !== undefined && guard.sequence === entry.sequence && guard.action === entry.action &&
    guard.timestamp === entry.timestamp;
}
function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'non-Error value thrown';
}
async function settle(call: () => unknown): Promise<{ value: unknown } | { error: unknown }> {
  try {
    return { value: await call() };
  } catch (error) {
    return { error };
  }
}

/** The outcome for a run the runner does not advance now, or undefined when it may. */
function waitingOutcome(run: ControllerRun): RunnerOutcome | undefined {
  if (isStopState(run.state)) return 'STOPPED';
  if (isTerminalState(run.state)) return 'TERMINAL';
  if (run.state === 'ACCEPTED') return 'HUMAN_PROMOTION_REQUIRED';
  if (!RUNNER_STATES.has(run.state)) return 'OUT_OF_SCOPE';
  if (run.externalRecheckRequired === true) return 'EXTERNAL_RECHECK_REQUIRED';
  // Only the correction for the current rejection lets the next iteration begin; the
  // controller checks it again. The runner never writes one itself.
  if (run.state === 'CORRECTION_REQUIRED' && run.correctionPacket?.rejectedSha !== run.remoteSha?.sha) return 'AWAITING_CORRECTION';
  return undefined;
}

export class AutomationRunner {
  readonly #controller: AutomationController;
  readonly #execute: (input: unknown) => unknown;
  readonly #review: (input: unknown) => unknown;
  // The IMPLEMENTING or ACCEPTANCE_REVIEW occurrences this instance created and has not
  // yet acted on. Memory only: a new instance owns nothing, so it never replays a call.
  readonly #owned = new Map<string, ControllerOccurrenceGuard>();
  readonly #busy = new Set<string>();

  constructor(controller: AutomationController, implementation: ImplementationAgentPort, review: ArchitectReviewPort) {
    if (!(controller instanceof AutomationController)) throw new TypeError('AutomationRunner requires an AutomationController');
    const execute = implementation?.execute;
    const decide = review?.review;
    if (typeof execute !== 'function') throw new TypeError('AutomationRunner requires an ImplementationAgentPort');
    if (typeof decide !== 'function') throw new TypeError('AutomationRunner requires an ArchitectReviewPort');
    this.#controller = controller;
    // Captured once: replacing a port method later does not change what this runner calls.
    this.#execute = (input) => execute.call(implementation, input as never);
    this.#review = (input) => decide.call(review, input as never);
    Object.freeze(this);
  }

  /** One bounded step. At most one controller transition, or one actor call and the transition it reports. */
  async step(runId: string): Promise<RunnerResult> {
    if (this.#busy.has(runId)) throw new Error('A step is already in progress for this run');
    this.#busy.add(runId);
    try {
      return await this.#step(runId);
    } finally {
      this.#busy.delete(runId);
    }
  }

  /** Steps until a wait or terminal point, or until exactly `maxSteps` steps have run. There is no default. */
  async drive(runId: string, maxSteps: number): Promise<RunnerResult> {
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) throw new RangeError('drive requires a finite positive integer maxSteps');
    let last: RunnerResult | undefined;
    for (let steps = 1; steps <= maxSteps; steps += 1) {
      last = await this.step(runId);
      if (last.outcome !== 'ADVANCED') return Object.freeze({ ...last, steps });
    }
    return Object.freeze({ ...last!, outcome: 'STEP_LIMIT_REACHED', steps: maxSteps });
  }

  async #step(runId: string): Promise<RunnerResult> {
    const run = this.#controller.get(runId);
    const waiting = waitingOutcome(run);
    if (waiting) return this.#report(run, waiting);
    switch (run.state) {
      case 'PACKET_READY':
      case 'CORRECTION_REQUIRED':
        return this.#enter(run, this.#controller.beginImplementation(runId, IMPLEMENTATION_ACTOR), 'BEGIN_IMPLEMENTATION');
      case 'IMPLEMENTING':
        return this.#implement(run);
      case 'IMPLEMENTATION_COMPLETE':
        // The SHA is read by the controller from repository reality, never supplied here.
        return this.#report(this.#controller.recordRemoteSha(runId, IMPLEMENTATION_ACTOR));
      case 'REMOTE_SHA_READY':
        return this.#enter(run, this.#controller.beginAcceptanceReview(runId, ARCHITECT_REVIEW_ACTOR), 'BEGIN_REMOTE_ACCEPTANCE');
      case 'ACCEPTANCE_REVIEW':
        return this.#decide(run);
      default:
        throw new Error(`Runner has no step for ${run.state}`);
    }
  }

  // Entering the actor states is its own step, so a crash between entering and calling
  // leaves a state the next instance recognises as not its own. The owned occurrence is
  // the entry this call appended right after the run as observed; if another writer got
  // in first, that entry is not ours and nothing is owned.
  #enter(before: ControllerRun, after: ControllerRun, action: string): RunnerResult {
    const entry = after.audit[before.audit.length];
    if (entry && entry.action === action) this.#owned.set(after.runId, occurrenceOf(after.runId, entry));
    return this.#report(after);
  }

  /** Ownership is consumed whether or not it matches: one occurrence, at most one actor call. */
  #take(run: ControllerRun, action: string): ControllerOccurrenceGuard | undefined {
    const owned = this.#owned.get(run.runId);
    this.#owned.delete(run.runId);
    return owned && owned.action === action && sameEntry(owned, run.audit.at(-1)) ? owned : undefined;
  }

  async #implement(run: ControllerRun): Promise<RunnerResult> {
    const owned = this.#take(run, 'BEGIN_IMPLEMENTATION');
    if (!owned) return this.#haltAt(occurrenceOf(run.runId, run.audit.at(-1)!), 'HUMAN_STOP', RESTART_IMPLEMENTATION, 'STALE_OCCURRENCE');
    const discarded = 'ACTOR_RESULT_DISCARDED';
    const input = implementationInput(run);
    const called = await settle(() => this.#execute(input));
    if ('error' in called) return this.#haltAt(owned, 'HUMAN_STOP', NO_IMPLEMENTATION_RESULT, discarded, called.error);
    let result;
    try {
      result = parseImplementationResult(called.value);
    } catch (error) {
      return this.#haltAt(owned, 'HUMAN_STOP', UNUSABLE_IMPLEMENTATION, discarded, error);
    }
    if (result.status !== 'COMPLETED') {
      return this.#haltAt(owned, result.status, `implementation agent reported ${result.status}: ${result.reason}`, discarded);
    }
    const evidence = result.validationEvidence;
    const written = this.#attempt(owned,
      () => this.#controller.completeImplementationForOccurrence(owned.runId, IMPLEMENTATION_ACTOR, owned, evidence));
    if ('run' in written) return this.#report(written.run);
    if ('moved' in written) return this.#left(owned.runId, discarded);
    return this.#haltAt(owned, 'HUMAN_STOP', UNUSABLE_IMPLEMENTATION, discarded, written.error);
  }

  async #decide(run: ControllerRun): Promise<RunnerResult> {
    const owned = this.#take(run, 'BEGIN_REMOTE_ACCEPTANCE');
    if (!owned) return this.#haltAt(occurrenceOf(run.runId, run.audit.at(-1)!), 'HUMAN_STOP', RESTART_REVIEW, 'STALE_OCCURRENCE');
    const discarded = 'ACTOR_RESULT_DISCARDED';
    const input = reviewInput(run);
    const called = await settle(() => this.#review(input));
    if ('error' in called) return this.#haltAt(owned, 'HUMAN_STOP', NO_REVIEW_RESULT, discarded, called.error);
    let bundle;
    try {
      bundle = parseReviewBundle(called.value);
    } catch (error) {
      return this.#haltAt(owned, 'ARCHITECTURE_STOP', UNUSABLE_REVIEW, discarded, error);
    }
    const decision = bundle.decision;
    const decided = this.#attempt(owned,
      () => this.#controller.decideAcceptanceForOccurrence(owned.runId, ARCHITECT_REVIEW_ACTOR, owned, decision));
    if ('moved' in decided) return this.#left(owned.runId, discarded);
    if ('error' in decided) return this.#haltAt(owned, 'ARCHITECTURE_STOP', UNUSABLE_REVIEW, discarded, decided.error);
    // The decision is the entry right after the review occurrence; a correction from the
    // same review is bound to it, not to whatever CORRECTION_REQUIRED is current later.
    const rejection = decided.run.audit[owned.sequence];
    const correction = bundle.correction;
    if (correction === undefined || decided.run.state !== 'CORRECTION_REQUIRED' || rejection?.action !== 'REJECT_EXACT_SHA') {
      return this.#report(decided.run);
    }
    const guard = occurrenceOf(owned.runId, rejection);
    const issued = this.#attempt(guard,
      () => this.#controller.issueCorrectionForOccurrence(owned.runId, ARCHITECT_REVIEW_ACTOR, guard, correction));
    if ('run' in issued) return this.#report(issued.run);
    if ('moved' in issued) return this.#left(owned.runId, discarded);
    return this.#report(this.#controller.get(owned.runId), undefined, `correction refused by controller: ${describe(issued.error)}`);
  }

  /**
   * One controller write bound to `guard`. When it fails, the run is read again: if it
   * has left that occurrence, nothing was recorded (`moved`); the audit is append-only,
   * so it can never return to it. Any other failure is a refusal of this write.
   */
  #attempt(guard: ControllerOccurrenceGuard, write: () => ControllerRun):
    { run: ControllerRun } | { moved: true } | { error: unknown } {
    try {
      return { run: write() };
    } catch (error) {
      return sameEntry(guard, this.#controller.get(guard.runId).audit.at(-1)) ? { error } : { moved: true };
    }
  }

  /** A stop about one occurrence. If the run has left it, nothing is stopped: a later occurrence is not this step's to stop. */
  #haltAt(guard: ControllerOccurrenceGuard, kind: StopClass, reason: string, stale: RunnerOutcome, error?: unknown): RunnerResult {
    const stopped = this.#attempt(guard, () => this.#controller.stopForOccurrence(guard.runId, RUNNER_ACTOR, guard, kind, reason));
    if ('run' in stopped) return this.#report(stopped.run, undefined, error === undefined ? undefined : describe(error));
    if ('moved' in stopped) return this.#left(guard.runId, stale);
    throw stopped.error;
  }

  #left(runId: string, outcome: RunnerOutcome): RunnerResult {
    return this.#report(this.#controller.get(runId), outcome, LEFT_OCCURRENCE);
  }

  #report(run: ControllerRun, outcome: RunnerOutcome = waitingOutcome(run) ?? 'ADVANCED', detail?: string): RunnerResult {
    return Object.freeze({ runId: run.runId, outcome, state: run.state,
      ...(run.stopReason !== undefined ? { stopReason: run.stopReason } : {}),
      ...(detail !== undefined ? { detail } : {}) });
  }
}
Object.freeze(AutomationRunner);
Object.freeze(AutomationRunner.prototype);
