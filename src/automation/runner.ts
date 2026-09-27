import {
  ARCHITECT_REVIEW_ACTOR, IMPLEMENTATION_ACTOR, RUNNER_ACTOR, implementationInput, parseImplementationResult,
  parseReviewBundle, reviewInput, type ArchitectReviewPort, type ImplementationAgentPort,
} from './bridge.js';
import { AutomationController } from './controller.js';
import { isStopState, isTerminalState } from './lifecycle.js';
import type { AuditEntry, ControllerRun, ControllerState, StopClass } from './types.js';

// Drives an existing AutomationController through implementation and independent
// acceptance, one bounded step at a time. The controller owns every state, counter,
// budget, and validation; the runner only chooses which public controller method the
// current state calls for, and calls an external actor only from a state this runner
// instance itself entered. It stops at ACCEPTED: promotion is a human decision.

export const RUNNER_OUTCOMES = Object.freeze([
  'ADVANCED', 'AWAITING_CORRECTION', 'EXTERNAL_RECHECK_REQUIRED', 'HUMAN_PROMOTION_REQUIRED', 'STOPPED',
  'TERMINAL', 'OUT_OF_SCOPE', 'ACTOR_RESULT_DISCARDED', 'STEP_LIMIT_REACHED',
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

interface OwnedEntry { sequence: number; action: string; timestamp: string }

function sameEntry(owned: OwnedEntry, entry: AuditEntry | undefined): boolean {
  return entry !== undefined && owned.sequence === entry.sequence && owned.action === entry.action &&
    owned.timestamp === entry.timestamp;
}
function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'non-Error value thrown';
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
  // The IMPLEMENTING or ACCEPTANCE_REVIEW entries this instance created and has not yet
  // acted on. Memory only: a new instance owns nothing, so it never replays a call.
  readonly #owned = new Map<string, OwnedEntry>();
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
        return this.#enter(this.#controller.beginImplementation(runId, IMPLEMENTATION_ACTOR), 'BEGIN_IMPLEMENTATION');
      case 'IMPLEMENTING':
        return this.#implement(run);
      case 'IMPLEMENTATION_COMPLETE':
        // The SHA is read by the controller from repository reality, never supplied here.
        return this.#report(this.#controller.recordRemoteSha(runId, IMPLEMENTATION_ACTOR));
      case 'REMOTE_SHA_READY':
        return this.#enter(this.#controller.beginAcceptanceReview(runId, ARCHITECT_REVIEW_ACTOR), 'BEGIN_REMOTE_ACCEPTANCE');
      case 'ACCEPTANCE_REVIEW':
        return this.#decide(run);
      default:
        throw new Error(`Runner has no step for ${run.state}`);
    }
  }

  // Entering the actor states is its own step, so a crash between entering and calling
  // leaves a state the next instance recognises as not its own.
  #enter(run: ControllerRun, action: string): RunnerResult {
    const entry = run.audit.at(-1);
    if (entry && entry.action === action) {
      this.#owned.set(run.runId, { sequence: entry.sequence, action: entry.action, timestamp: entry.timestamp });
    }
    return this.#report(run);
  }

  /** Ownership is consumed whether or not it matches: one entry, at most one actor call. */
  #take(run: ControllerRun, action: string): OwnedEntry | undefined {
    const owned = this.#owned.get(run.runId);
    this.#owned.delete(run.runId);
    return owned && owned.action === action && sameEntry(owned, run.audit.at(-1)) ? owned : undefined;
  }

  /**
   * Calls the actor, then records nothing unless the run is still exactly at the entry
   * this runner created: a result that returns after the run moved on belongs to a
   * state that no longer exists.
   */
  async #call(run: ControllerRun, owned: OwnedEntry, call: () => unknown, noResult: string):
    Promise<{ current: ControllerRun; value: unknown } | RunnerResult> {
    let value: unknown;
    let threw = false;
    let failure: unknown;
    try {
      value = await call();
    } catch (error) {
      threw = true;
      failure = error;
    }
    const current = this.#controller.get(run.runId);
    if (!sameEntry(owned, current.audit.at(-1))) {
      return this.#report(current, 'ACTOR_RESULT_DISCARDED', 'the run changed while the external actor ran; its result is not recorded');
    }
    if (threw) return this.#halt(run.runId, 'HUMAN_STOP', noResult, failure);
    return { current, value };
  }

  async #implement(run: ControllerRun): Promise<RunnerResult> {
    const owned = this.#take(run, 'BEGIN_IMPLEMENTATION');
    if (!owned) return this.#halt(run.runId, 'HUMAN_STOP', RESTART_IMPLEMENTATION);
    const input = implementationInput(run);
    const called = await this.#call(run, owned, () => this.#execute(input), NO_IMPLEMENTATION_RESULT);
    if (!('value' in called)) return called;
    let result;
    try {
      result = parseImplementationResult(called.value);
    } catch (error) {
      return this.#halt(run.runId, 'HUMAN_STOP', UNUSABLE_IMPLEMENTATION, error);
    }
    if (result.status !== 'COMPLETED') {
      return this.#halt(run.runId, result.status, `implementation agent reported ${result.status}: ${result.reason}`);
    }
    const evidence = result.validationEvidence;
    return this.#record(run.runId, () => this.#controller.completeImplementation(run.runId, IMPLEMENTATION_ACTOR, evidence),
      'HUMAN_STOP', UNUSABLE_IMPLEMENTATION);
  }

  async #decide(run: ControllerRun): Promise<RunnerResult> {
    const owned = this.#take(run, 'BEGIN_REMOTE_ACCEPTANCE');
    if (!owned) return this.#halt(run.runId, 'HUMAN_STOP', RESTART_REVIEW);
    const input = reviewInput(run);
    const called = await this.#call(run, owned, () => this.#review(input), NO_REVIEW_RESULT);
    if (!('value' in called)) return called;
    let bundle;
    try {
      bundle = parseReviewBundle(called.value);
    } catch (error) {
      return this.#halt(run.runId, 'ARCHITECTURE_STOP', UNUSABLE_REVIEW, error);
    }
    const decision = bundle.decision;
    const decided = this.#record(run.runId, () => this.#controller.decideAcceptance(run.runId, ARCHITECT_REVIEW_ACTOR, decision),
      'ARCHITECTURE_STOP', UNUSABLE_REVIEW);
    if (bundle.correction === undefined || decided.state !== 'CORRECTION_REQUIRED') return decided;
    try {
      return this.#report(this.#controller.issueCorrection(run.runId, ARCHITECT_REVIEW_ACTOR, bundle.correction));
    } catch (error) {
      return this.#report(this.#controller.get(run.runId), undefined, `correction refused by controller: ${describe(error)}`);
    }
  }

  #record(runId: string, write: () => ControllerRun, kind: StopClass, reason: string): RunnerResult {
    try {
      return this.#report(write());
    } catch (error) {
      return this.#halt(runId, kind, reason, error);
    }
  }

  #halt(runId: string, kind: StopClass, reason: string, error?: unknown): RunnerResult {
    const stopped = this.#controller.stop(runId, RUNNER_ACTOR, kind, reason);
    return this.#report(stopped, undefined, error === undefined ? undefined : describe(error));
  }

  #report(run: ControllerRun, outcome: RunnerOutcome = waitingOutcome(run) ?? 'ADVANCED', detail?: string): RunnerResult {
    return Object.freeze({ runId: run.runId, outcome, state: run.state,
      ...(run.stopReason !== undefined ? { stopReason: run.stopReason } : {}),
      ...(detail !== undefined ? { detail } : {}) });
  }
}
Object.freeze(AutomationRunner);
Object.freeze(AutomationRunner.prototype);
