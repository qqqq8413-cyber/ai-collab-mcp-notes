import type { AuditEntry, Clock, ControllerRun } from './types.js';
import {
  RunAdmissionIntegrityError, admissionDecision, admissionRecordOf, changeKeyOf, parseChangeIdentity, refuseSecondRun, type AdmissionRecord,
  type AdmissionRefusalRecord, type ChangeIdentity,
} from './admission.js';
import { assertFreshRun, assertTransition } from './lifecycle.js';
import { SYSTEM_CLOCK, isInstant } from './time.js';

export interface ControllerStore {
  /**
   * Creates a fresh run and admits it as the one ROOT run of its change (repository +
   * sliceId, exact) under CHIEF-GOV/1. Every implementation enforces admission itself, so
   * no create path can open a second run for a change: that throws
   * RunAdmissionRefusedError (SECOND_RUN_FOR_CHANGE) before the run exists.
   */
  create(run: ControllerRun): void;
  get(runId: string): ControllerRun | undefined;
  replace(run: ControllerRun): void;
  bindController(): (run: ControllerRun) => void;
  entries(runId: string): AuditEntry[];
}

// Only a controller that bound this store may append repository-authority actions.
// Direct store writes remain useful for testing the lifecycle but cannot impersonate
// a repository observation or clear a human-resume recheck flag.
const CONTROLLER_ONLY = new Set(['RECORD_REMOTE_SHA', 'BEGIN_REMOTE_ACCEPTANCE', 'ACCEPT_EXACT_SHA',
  'REJECT_EXACT_SHA', 'AUTHORIZE_PROMOTION', 'MARK_PROMOTING', 'RECORD_PROMOTED_MAIN',
  'RECOVER_PROMOTED_MAIN', 'CLOSE_VERIFIED_RUN', 'RECOVER_CLOSE', 'RECONCILE_PENDING', 'RECHECK_EXTERNAL_REALITY']);
export function requiresControllerWriter(action: unknown): boolean { return typeof action === 'string' && CONTROLLER_ONLY.has(action); }

// The store is a public write path of its own, so it enforces the same lifecycle as
// the controller rather than trusting its caller. Input is cloned first and only the
// clone is validated and kept: a getter or later mutation cannot change what was checked.
// Runs live in a true private field; a TypeScript `private` is still writable at runtime.
export class InMemoryControllerStore implements ControllerStore {
  readonly #runs = new Map<string, ControllerRun>();
  // CHIEF-GOV/1 admission with the file store's records and decisions. Check and set are
  // one synchronous step, so exactly one run per change can be admitted.
  readonly #admissions = new Map<string, AdmissionRecord>();
  readonly #refusals = new Map<string, AdmissionRefusalRecord[]>();
  // runId -> changeKey of the change it is ROOT of: a runId is the ROOT of at most one change.
  readonly #roots = new Map<string, string>();
  readonly #clock: Clock;
  #bound = false;

  constructor(clock: Clock = SYSTEM_CLOCK) {
    if (!clock || typeof clock.now !== 'function') throw new Error('Storage clock required');
    this.#clock = clock;
    Object.freeze(this);
  }
  create(input: ControllerRun): void {
    const run = structuredClone(input);
    if (this.#runs.has(run.runId)) throw new Error('Duplicate runId');
    assertFreshRun(run);
    const change = parseChangeIdentity(run);
    const changeKey = changeKeyOf(change);
    const record = this.#admissions.get(changeKey);
    if (!record) {
      const owner = this.#roots.get(run.runId);
      if (owner !== undefined && owner !== changeKey) {
        throw new RunAdmissionIntegrityError('ADMISSION_REGISTRY_MISMATCH', 'This runId is already the ROOT of another change', changeKey);
      }
      const admittedAt = this.#clock.now();
      if (!isInstant(admittedAt)) throw new Error('Storage clock returned an invalid timestamp');
      this.#admissions.set(changeKey, admissionRecordOf(change, run.runId, admittedAt));
      this.#roots.set(run.runId, changeKey);
    } else if (admissionDecision(record, change, run.runId) !== 'ROOT_PENDING') {
      refuseSecondRun(record, change, run.runId, this.#clock,
        (refusal) => { this.#refusals.set(changeKey, [...this.#refusals.get(changeKey) ?? [], refusal]); });
    }
    this.#runs.set(run.runId, run);
  }
  /** The admission record of a change, if it has one. Operational integrity data; it grants nothing. */
  admissionRecord(change: ChangeIdentity): AdmissionRecord | undefined {
    const record = this.#admissions.get(changeKeyOf(change));
    return record ? structuredClone(record) : undefined;
  }
  /** Recorded refusals of second runs for a change, oldest first. Operational evidence; it grants nothing. */
  admissionRefusals(change: ChangeIdentity): AdmissionRefusalRecord[] {
    return structuredClone(this.#refusals.get(changeKeyOf(change)) ?? []);
  }
  get(runId: string): ControllerRun | undefined {
    const run = this.#runs.get(runId);
    return run ? structuredClone(run) : undefined;
  }
  replace(input: ControllerRun): void {
    this.#replace(input, false);
  }
  bindController(): (run: ControllerRun) => void {
    if (this.#bound) throw new Error('Controller store already bound');
    this.#bound = true;
    return (run) => this.#replace(run, true);
  }
  #replace(input: ControllerRun, privileged: boolean): void {
    const run = structuredClone(input);
    if (!privileged && requiresControllerWriter(run.audit.at(-1)?.action)) throw new Error('Controller writer required');
    const current = this.#runs.get(run.runId);
    if (!current) throw new Error('Unknown runId');
    assertTransition(current, run);
    this.#runs.set(run.runId, run);
  }
  entries(runId: string): AuditEntry[] {
    const run = this.get(runId);
    if (!run) throw new Error('Unknown runId');
    return structuredClone(run.audit);
  }
}
Object.freeze(InMemoryControllerStore);
Object.freeze(InMemoryControllerStore.prototype);
