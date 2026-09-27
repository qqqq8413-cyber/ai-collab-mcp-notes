import {
  ARCHITECT_REVIEW_ACTOR, IMPLEMENTATION_ACTOR, RUNNER_ACTOR, implementationInput, parseImplementationResult,
  parseReviewBundle, reviewInput, type ArchitectReviewPort, type ImplementationAgentPort, type ImplementationResult,
  type ParsedReview,
} from './bridge.js';
import { AutomationController } from './controller.js';
import {
  canonicalJson, readStoredOutcome, serializeOutcome, type ActorKind, type InvocationJournal, type InvocationRecord,
  type StoredOutcome,
} from './invocation-journal.js';
import { isStopState, isTerminalState } from './lifecycle.js';
import { authorizeLiveModelCall, parseAuthorization } from './policy.js';
import type {
  AuditEntry, Clock, ControllerOccurrenceGuard, ControllerRun, ControllerState, ProviderCallScope, StopClass,
} from './types.js';

// Drives an existing AutomationController through implementation and independent
// acceptance, one bounded step at a time. The controller owns every state, counter,
// budget, and validation; the runner only chooses which public controller method the
// current state calls for, and calls an external actor only from a state it may act on.
// It stops at ACCEPTED: promotion is a human decision.
//
// An actor's result belongs to the exact audit occurrence the actor was called for.
// Every write that applies a result, or a stop decided from a run as observed, is
// bound to that occurrence through the controller's guarded entrypoints.
//
// With an invocation journal (live composition), every actor call is also journaled:
// PREPARED before anything, then the live-call policy gate and the call budget, then
// STARTED, durably, before the adapter runs; the result is stored COMPLETED before it
// is applied, and marked APPLIED after. A new runner continues from what the journal
// proves: it dispatches from PREPARED, applies a stored result without calling the
// actor again, and stops for a human on STARTED. It never replays a call.

export const RUNNER_OUTCOMES = Object.freeze([
  'ADVANCED', 'AWAITING_CORRECTION', 'EXTERNAL_RECHECK_REQUIRED', 'HUMAN_PROMOTION_REQUIRED', 'STOPPED',
  'TERMINAL', 'OUT_OF_SCOPE', 'ACTOR_RESULT_DISCARDED', 'STALE_OCCURRENCE', 'INVOCATION_CLAIMED', 'STEP_LIMIT_REACHED',
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

export interface RunnerJournalOptions {
  journal: InvocationJournal;
  /** The exact provider, model, and destination each actor's adapter calls. */
  scopes: Readonly<Record<ActorKind, ProviderCallScope>>;
  /** Caller-supplied live-call grants, one per actor kind, evaluated by the existing policy at every dispatch. */
  authorizations: Readonly<Partial<Record<ActorKind, unknown>>>;
  clock: Clock;
  /** Called immediately before each controller operation that reads repository reality. */
  observeRepository?: (run: ControllerRun) => void;
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
const NOT_AUTHORIZED = 'live model call not authorized by an exact current human grant; not dispatched';
const BUDGET_EXHAUSTED = 'live model call budget exhausted; not dispatched';
const JOURNAL_CONFLICT = 'invocation journal and controller disagree about this occurrence; nothing was dispatched or applied';

interface Spec { entering: string; state: ControllerState; restart: string; noResult: string }
const SPECS: Readonly<Record<ActorKind, Spec>> = Object.freeze({
  IMPLEMENTATION: { entering: 'BEGIN_IMPLEMENTATION', state: 'IMPLEMENTING', restart: RESTART_IMPLEMENTATION, noResult: NO_IMPLEMENTATION_RESULT },
  ARCHITECT_REVIEW: { entering: 'BEGIN_REMOTE_ACCEPTANCE', state: 'ACCEPTANCE_REVIEW', restart: RESTART_REVIEW, noResult: NO_REVIEW_RESULT },
});
// The halts the controller itself makes inside the guarded write that applies a result.
// It records them under its own internal actor id.
const CONTROLLER_HALTS: Readonly<Record<ActorKind, readonly string[]>> = Object.freeze({
  IMPLEMENTATION: ['implementation runtime budget exhausted'],
  ARCHITECT_REVIEW: ['work branch moved during acceptance'],
});

/**
 * Whether the entry right after an occurrence is the application of that occurrence's
 * result: the protocol actor's own transition, a stop this runner writes when applying
 * a result, or a controller halt inside the applying write. Anything else (another
 * writer's stop, a restart stop) means the result was never applied.
 */
function appliesResult(kind: ActorKind, entry: AuditEntry): boolean {
  if (entry.previousState !== SPECS[kind].state) return false;
  if (kind === 'IMPLEMENTATION' && entry.action === 'REPORT_IMPLEMENTATION_COMPLETE') return entry.actor === IMPLEMENTATION_ACTOR.id;
  if (kind === 'ARCHITECT_REVIEW' && (entry.action === 'ACCEPT_EXACT_SHA' || entry.action === 'REJECT_EXACT_SHA')) {
    return entry.actor === ARCHITECT_REVIEW_ACTOR.id;
  }
  if (entry.action !== 'STOP') return false;
  const reason = entry.stopReason ?? '';
  if (entry.actor === RUNNER_ACTOR.id) {
    return kind === 'IMPLEMENTATION'
      ? reason === UNUSABLE_IMPLEMENTATION || reason.startsWith('implementation agent reported ')
      : reason === UNUSABLE_REVIEW || reason.startsWith('architect review reported ');
  }
  return entry.actor === 'controller' && CONTROLLER_HALTS[kind].includes(reason);
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
interface Applied { result: RunnerResult; entry?: AuditEntry }

function occurrenceOf(runId: string, entry: AuditEntry): ControllerOccurrenceGuard {
  return Object.freeze({ runId, sequence: entry.sequence, action: entry.action, timestamp: entry.timestamp });
}
function sameEntry(guard: { sequence: number; action: string; timestamp: string }, entry: AuditEntry | undefined): boolean {
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
function parseImplementation(value: unknown): Parsed<ImplementationResult> {
  try { return { ok: true, value: parseImplementationResult(value) }; } catch (error) { return { ok: false, error: describe(error) }; }
}
function parseReview(value: unknown): Parsed<ParsedReview> {
  try { return { ok: true, value: parseReviewBundle(value) }; } catch (error) { return { ok: false, error: describe(error) }; }
}
/** The outcome as stored: bounded canonical plain data, or the reason it could not be. */
function storable(parsed: Parsed<unknown>): StoredOutcome {
  if (!parsed.ok) return { ok: false, error: parsed.error.slice(0, 4000) };
  try {
    serializeOutcome({ ok: true, value: parsed.value });
    return { ok: true, value: JSON.parse(canonicalJson(parsed.value)) };
  } catch (error) {
    return { ok: false, error: `result is not bounded plain data: ${describe(error)}`.slice(0, 4000) };
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

function snapshotJournalOptions(value: RunnerJournalOptions): RunnerJournalOptions {
  const journal = value?.journal;
  for (const method of ['prepare', 'get', 'find', 'list', 'start', 'complete', 'markUncertain', 'abandon', 'markApplied'] as const) {
    if (typeof journal?.[method] !== 'function') throw new TypeError('AutomationRunner journal options require an InvocationJournal');
  }
  if (typeof value.clock?.now !== 'function') throw new TypeError('AutomationRunner journal options require a clock');
  const scope = (input: unknown): ProviderCallScope => {
    const { provider, model, destination } = (input ?? {}) as ProviderCallScope;
    for (const part of [provider, model, destination]) {
      if (typeof part !== 'string' || !part || part.trim() !== part) throw new TypeError('Actor call scope needs exact provider, model, and destination');
    }
    return Object.freeze({ provider, model, destination });
  };
  const observe = value.observeRepository;
  if (observe !== undefined && typeof observe !== 'function') throw new TypeError('observeRepository must be a function');
  return Object.freeze({ journal, clock: value.clock,
    scopes: Object.freeze({ IMPLEMENTATION: scope(value.scopes?.IMPLEMENTATION), ARCHITECT_REVIEW: scope(value.scopes?.ARCHITECT_REVIEW) }),
    // Snapshotted: a grant changed after composition is not the grant that was supplied.
    authorizations: Object.freeze(structuredClone({ IMPLEMENTATION: value.authorizations?.IMPLEMENTATION,
      ARCHITECT_REVIEW: value.authorizations?.ARCHITECT_REVIEW })),
    ...(observe ? { observeRepository: observe } : {}) });
}

export class AutomationRunner {
  readonly #controller: AutomationController;
  readonly #execute: (input: unknown) => unknown;
  readonly #review: (input: unknown) => unknown;
  readonly #live: RunnerJournalOptions | undefined;
  // The IMPLEMENTING or ACCEPTANCE_REVIEW occurrences this instance created and has not
  // yet acted on. Memory only: a new instance owns nothing, so it never replays a call.
  readonly #owned = new Map<string, ControllerOccurrenceGuard>();
  readonly #busy = new Set<string>();

  constructor(controller: AutomationController, implementation: ImplementationAgentPort, review: ArchitectReviewPort,
    journal?: RunnerJournalOptions) {
    if (!(controller instanceof AutomationController)) throw new TypeError('AutomationRunner requires an AutomationController');
    const execute = implementation?.execute;
    const decide = review?.review;
    if (typeof execute !== 'function') throw new TypeError('AutomationRunner requires an ImplementationAgentPort');
    if (typeof decide !== 'function') throw new TypeError('AutomationRunner requires an ArchitectReviewPort');
    this.#controller = controller;
    // Captured once: replacing a port method later does not change what this runner calls.
    this.#execute = (input) => execute.call(implementation, input as never);
    this.#review = (input) => decide.call(review, input as never);
    this.#live = journal === undefined ? undefined : snapshotJournalOptions(journal);
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
    if (this.#live) this.#settleJournal(run);
    const waiting = waitingOutcome(run);
    if (waiting) return this.#report(run, waiting);
    switch (run.state) {
      case 'PACKET_READY':
      case 'CORRECTION_REQUIRED':
        return this.#enter(run, () => this.#controller.beginImplementation(runId, IMPLEMENTATION_ACTOR), 'IMPLEMENTATION');
      case 'IMPLEMENTING':
        return this.#actor(run, 'IMPLEMENTATION');
      case 'IMPLEMENTATION_COMPLETE':
        // The SHA is read by the controller from repository reality, never supplied here.
        this.#observe(run);
        return this.#report(this.#controller.recordRemoteSha(runId, IMPLEMENTATION_ACTOR));
      case 'REMOTE_SHA_READY':
        this.#observe(run);
        return this.#enter(run, () => this.#controller.beginAcceptanceReview(runId, ARCHITECT_REVIEW_ACTOR), 'ARCHITECT_REVIEW');
      case 'ACCEPTANCE_REVIEW':
        return this.#actor(run, 'ARCHITECT_REVIEW');
      default:
        throw new Error(`Runner has no step for ${run.state}`);
    }
  }

  #observe(run: ControllerRun): void {
    this.#live?.observeRepository?.(run);
  }

  // Entering an actor state is its own step, so a crash between entering and calling
  // leaves a state the next instance can tell apart. The owned occurrence is the entry
  // this call appended right after the run as observed; if another writer got in first,
  // that entry is not ours and nothing is owned. With a journal, intent is recorded now.
  #enter(before: ControllerRun, write: () => ControllerRun, kind: ActorKind): RunnerResult {
    const after = write();
    const entry = after.audit[before.audit.length];
    if (!entry || entry.action !== SPECS[kind].entering) return this.#report(after);
    const owned = occurrenceOf(after.runId, entry);
    this.#owned.set(after.runId, owned);
    if (this.#live && sameEntry(owned, after.audit.at(-1))) {
      const prepared = this.#prepare(after, kind, owned);
      if ('result' in prepared) return prepared.result;
    }
    return this.#report(after);
  }

  /** Ownership is consumed whether or not it matches: one occurrence, at most one actor call. */
  #take(run: ControllerRun, action: string): ControllerOccurrenceGuard | undefined {
    const owned = this.#owned.get(run.runId);
    this.#owned.delete(run.runId);
    return owned && owned.action === action && sameEntry(owned, run.audit.at(-1)) ? owned : undefined;
  }

  #call(kind: ActorKind, run: ControllerRun, invocationId?: string): unknown {
    return kind === 'IMPLEMENTATION'
      ? this.#execute(implementationInput(run, invocationId))
      : this.#review(reviewInput(run, invocationId));
  }
  #parse(kind: ActorKind, value: unknown): Parsed<unknown> {
    return kind === 'IMPLEMENTATION' ? parseImplementation(value) : parseReview(value);
  }
  #apply(kind: ActorKind, guard: ControllerOccurrenceGuard, parsed: Parsed<unknown>): Applied {
    return kind === 'IMPLEMENTATION'
      ? this.#applyImplementation(guard, parsed as Parsed<ImplementationResult>)
      : this.#applyReview(guard, parsed as Parsed<ParsedReview>);
  }

  async #actor(run: ControllerRun, kind: ActorKind): Promise<RunnerResult> {
    const spec = SPECS[kind];
    const last = run.audit.at(-1)!;
    const observed = occurrenceOf(run.runId, last);
    const owned = this.#take(run, spec.entering);
    if (!this.#live) {
      if (!owned) return this.#haltAt(observed, 'HUMAN_STOP', spec.restart, 'STALE_OCCURRENCE').result;
      const called = await settle(() => this.#call(kind, run));
      if ('error' in called) return this.#haltAt(owned, 'HUMAN_STOP', spec.noResult, 'ACTOR_RESULT_DISCARDED', called.error).result;
      return this.#apply(kind, owned, this.#parse(kind, called.value)).result;
    }
    // A resumed occurrence has no invocation of its own; nothing is dispatched for it.
    if (last.action !== spec.entering) return this.#haltAt(observed, 'HUMAN_STOP', spec.restart, 'STALE_OCCURRENCE').result;
    const journal = this.#live.journal;
    let record = journal.find(run.runId, last.sequence, kind);
    if (!record) {
      // Absence alone never proves no call happened; only this live instance's own entry does.
      if (!owned) return this.#haltAt(observed, 'HUMAN_STOP', spec.restart, 'STALE_OCCURRENCE').result;
      const prepared = this.#prepare(run, kind, observed);
      if ('result' in prepared) return prepared.result;
      record = prepared.record;
    }
    if (!sameEntry(record.identity.occurrence, last) || record.identity.packetHash !== run.activePacketHash) {
      return this.#haltAt(observed, 'ARCHITECTURE_STOP', JOURNAL_CONFLICT, 'STALE_OCCURRENCE').result;
    }
    switch (record.state) {
      case 'PREPARED':
        return this.#dispatch(run, kind, record, observed);
      case 'STARTED':
        this.#settleRecord(record, 'UNCERTAIN', 'STARTED for the current occurrence with no durable result; not replayed');
        return this.#haltAt(observed, 'HUMAN_STOP', spec.restart, 'STALE_OCCURRENCE').result;
      case 'UNCERTAIN':
        return this.#haltAt(observed, 'HUMAN_STOP', spec.restart, 'STALE_OCCURRENCE').result;
      case 'COMPLETED':
        return this.#applyStored(kind, record, observed);
      default:
        return this.#haltAt(observed, 'ARCHITECTURE_STOP', JOURNAL_CONFLICT, 'STALE_OCCURRENCE').result;
    }
  }

  #prepare(run: ControllerRun, kind: ActorKind, occurrence: ControllerOccurrenceGuard):
    { record: InvocationRecord } | { result: RunnerResult } {
    const live = this.#live!;
    const grant = parseAuthorization(live.authorizations[kind]);
    if (!grant) return { result: this.#haltAt(occurrence, 'HUMAN_STOP', NOT_AUTHORIZED, 'STALE_OCCURRENCE').result };
    const scope = live.scopes[kind];
    const record = live.journal.prepare({ runId: run.runId, sliceId: run.sliceId, packetId: run.activePacket!.packetId,
      packetHash: run.activePacketHash!, occurrence: { sequence: occurrence.sequence, action: occurrence.action, timestamp: occurrence.timestamp },
      actorKind: kind, provider: scope.provider, model: scope.model, destination: scope.destination, authorizationId: grant.authorizationId });
    return { record };
  }

  async #dispatch(run: ControllerRun, kind: ActorKind, record: InvocationRecord, observed: ControllerOccurrenceGuard):
    Promise<RunnerResult> {
    const live = this.#live!;
    const spec = SPECS[kind];
    const packet = run.activePacket!;
    const authorization = live.authorizations[kind];
    const gate = authorizeLiveModelCall({ packet, runId: run.runId, scope: live.scopes[kind], authorization, now: live.clock.now() });
    if (gate.decision !== 'AUTHORIZED' || parseAuthorization(authorization)?.authorizationId !== record.identity.authorizationId) {
      live.journal.abandon(record.invocationId, `not authorized: ${gate.reason}`);
      return this.#haltAt(observed, 'HUMAN_STOP', NOT_AUTHORIZED, 'STALE_OCCURRENCE', gate.reason).result;
    }
    if (!sameEntry(observed, this.#controller.get(run.runId).audit.at(-1))) {
      live.journal.abandon(record.invocationId, 'occurrence left before dispatch');
      return this.#left(run.runId, 'STALE_OCCURRENCE');
    }
    const started = live.journal.start(record.invocationId, packet.providerCallAuthorization.maxCalls);
    if (started.status === 'NOT_PREPARED') {
      return this.#report(this.#controller.get(run.runId), 'INVOCATION_CLAIMED', 'another runner holds this invocation; nothing was dispatched');
    }
    if (started.status === 'BUDGET_EXHAUSTED') {
      live.journal.abandon(record.invocationId, `call budget exhausted after ${started.used} calls`);
      return this.#haltAt(observed, 'HUMAN_STOP', BUDGET_EXHAUSTED, 'STALE_OCCURRENCE').result;
    }
    const dispatched = started.record;
    const called = await settle(() => this.#call(kind, run, dispatched.invocationId));
    if ('error' in called) {
      this.#settleRecord(dispatched, 'UNCERTAIN', `adapter returned no result: ${describe(called.error)}`);
      return this.#haltAt(observed, 'HUMAN_STOP', spec.noResult, 'ACTOR_RESULT_DISCARDED', called.error).result;
    }
    let completed: InvocationRecord;
    try {
      completed = live.journal.complete(dispatched.invocationId, storable(this.#parse(kind, called.value)));
    } catch (error) {
      // Settled by another runner while this call ran: the result is not this step's to apply.
      if (live.journal.get(dispatched.invocationId)?.state !== 'STARTED') return this.#left(run.runId, 'ACTOR_RESULT_DISCARDED');
      throw error;
    }
    return this.#applyStored(kind, completed, observed);
  }

  /** Applies a stored result through the guarded controller entrypoints. The actor is not called. */
  #applyStored(kind: ActorKind, record: InvocationRecord, observed: ControllerOccurrenceGuard): RunnerResult {
    const stored = readStoredOutcome(record);
    const parsed: Parsed<unknown> = stored.ok ? this.#parse(kind, stored.value) : { ok: false, error: stored.error };
    const applied = this.#apply(kind, observed, parsed);
    if (applied.entry) this.#settleRecord(record, 'APPLIED', 'applied', { sequence: applied.entry.sequence, action: applied.entry.action });
    else this.#settleRecord(record, 'ABANDONED', 'occurrence left before the result was applied');
    return applied.result;
  }

  /** Moves a record to a final state, unless another runner has already moved it on from `record.state`. */
  #settleRecord(record: InvocationRecord, state: 'UNCERTAIN' | 'ABANDONED' | 'APPLIED', note: string,
    application?: { sequence: number; action: string }): void {
    const journal = this.#live!.journal;
    try {
      if (state === 'UNCERTAIN') journal.markUncertain(record.invocationId, note);
      else if (state === 'APPLIED') journal.markApplied(record.invocationId, application!);
      else journal.abandon(record.invocationId, note);
    } catch (error) {
      if (journal.get(record.invocationId)?.state === record.state) throw error;
    }
  }

  /**
   * Settles journal records of occurrences the run has already left. Journal writes only:
   * nothing is dispatched and nothing is written to the controller. PREPARED was never
   * dispatched; STARTED has no durable result; COMPLETED was applied if the entry right
   * after its occurrence is its application, and abandoned otherwise.
   */
  #settleJournal(run: ControllerRun): void {
    const journal = this.#live!.journal;
    const last = run.audit.at(-1)!;
    for (const record of journal.list(run.runId)) {
      const occurrence = record.identity.occurrence;
      if (occurrence.sequence === last.sequence) continue;
      if (record.state === 'PREPARED') this.#settleRecord(record, 'ABANDONED', 'occurrence left before dispatch');
      else if (record.state === 'STARTED') this.#settleRecord(record, 'UNCERTAIN', 'occurrence left with no durable result; not replayed');
      else if (record.state === 'COMPLETED') {
        const entry = run.audit[occurrence.sequence];
        const applied = entry !== undefined && sameEntry(occurrence, run.audit[occurrence.sequence - 1]) &&
          appliesResult(record.identity.actorKind, entry);
        if (applied) this.#settleRecord(record, 'APPLIED', 'applied', { sequence: entry.sequence, action: entry.action });
        else this.#settleRecord(record, 'ABANDONED', 'occurrence left before the result was applied');
      }
    }
  }

  #applyImplementation(guard: ControllerOccurrenceGuard, parsed: Parsed<ImplementationResult>): Applied {
    const discarded = 'ACTOR_RESULT_DISCARDED';
    if (!parsed.ok) return this.#haltAt(guard, 'HUMAN_STOP', UNUSABLE_IMPLEMENTATION, discarded, parsed.error);
    const result = parsed.value;
    if (result.status !== 'COMPLETED') {
      return this.#haltAt(guard, result.status, `implementation agent reported ${result.status}: ${result.reason}`, discarded);
    }
    const evidence = result.validationEvidence;
    const written = this.#attempt(guard,
      () => this.#controller.completeImplementationForOccurrence(guard.runId, IMPLEMENTATION_ACTOR, guard, evidence));
    if ('run' in written) return { result: this.#report(written.run), entry: written.run.audit[guard.sequence] };
    if ('moved' in written) return { result: this.#left(guard.runId, discarded) };
    return this.#haltAt(guard, 'HUMAN_STOP', UNUSABLE_IMPLEMENTATION, discarded, written.error);
  }

  #applyReview(guard: ControllerOccurrenceGuard, parsed: Parsed<ParsedReview>): Applied {
    const discarded = 'ACTOR_RESULT_DISCARDED';
    if (!parsed.ok) return this.#haltAt(guard, 'ARCHITECTURE_STOP', UNUSABLE_REVIEW, discarded, parsed.error);
    const bundle = parsed.value;
    if ('stop' in bundle) return this.#haltAt(guard, bundle.stop, `architect review reported ${bundle.stop}: ${bundle.reason}`, discarded);
    const decision = bundle.decision;
    if (this.#live?.observeRepository) this.#observe(this.#controller.get(guard.runId));
    const decided = this.#attempt(guard,
      () => this.#controller.decideAcceptanceForOccurrence(guard.runId, ARCHITECT_REVIEW_ACTOR, guard, decision));
    if ('moved' in decided) return { result: this.#left(guard.runId, discarded) };
    if ('error' in decided) return this.#haltAt(guard, 'ARCHITECTURE_STOP', UNUSABLE_REVIEW, discarded, decided.error);
    // The decision is the entry right after the review occurrence; a correction from the
    // same review is bound to it, not to whatever CORRECTION_REQUIRED is current later.
    const entry = decided.run.audit[guard.sequence];
    const correction = bundle.correction;
    if (correction === undefined || decided.run.state !== 'CORRECTION_REQUIRED' || entry?.action !== 'REJECT_EXACT_SHA') {
      return { result: this.#report(decided.run), entry };
    }
    const rejection = occurrenceOf(guard.runId, entry);
    const issued = this.#attempt(rejection,
      () => this.#controller.issueCorrectionForOccurrence(guard.runId, ARCHITECT_REVIEW_ACTOR, rejection, correction));
    if ('run' in issued) return { result: this.#report(issued.run), entry };
    if ('moved' in issued) return { result: this.#left(guard.runId, discarded), entry };
    return { result: this.#report(this.#controller.get(guard.runId), undefined, `correction refused by controller: ${describe(issued.error)}`), entry };
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
  #haltAt(guard: ControllerOccurrenceGuard, kind: StopClass, reason: string, stale: RunnerOutcome, error?: unknown): Applied {
    const stopped = this.#attempt(guard, () => this.#controller.stopForOccurrence(guard.runId, RUNNER_ACTOR, guard, kind, reason));
    if ('run' in stopped) {
      return { result: this.#report(stopped.run, undefined, error === undefined ? undefined : describe(error)),
        entry: stopped.run.audit[guard.sequence] };
    }
    if ('moved' in stopped) return { result: this.#left(guard.runId, stale) };
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
