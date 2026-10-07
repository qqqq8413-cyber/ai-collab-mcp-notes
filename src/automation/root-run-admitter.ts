import { resolve } from 'node:path';
import { RunAdmissionIntegrityError, RunAdmissionRefusedError, changeKeyOf, parseChangeIdentity } from './admission.js';
import { AutomationController } from './controller.js';
import { FileControllerStore } from './durable-store.js';
import { assertFreshRun } from './lifecycle.js';
import { SYSTEM_CLOCK } from './time.js';
import type { Clock, ControllerRun } from './types.js';

// G1-RA1: the one production capability that establishes a governed Change's ROOT run.
//
// It holds the Controller and its store privately and exposes exactly two operations:
// read the Change's ROOT run, and admit it. Admission goes through
// AutomationController.createRun, so the R4L ControllerStore.create boundary decides it
// (one change, one ROOT run, ever); nothing here writes a claim or a run itself. The run
// is created empty in IDLE and no lifecycle method is reachable through this capability.
//
// The ROOT runId is not chosen by anyone: it is "run-" + the exact changeKey. Every retry of
// one Change, including the completion of a ROOT_PENDING claim left by a crash, names the
// same run, so R4L storage alone makes concurrent and repeated admissions converge.
//
// A run lock left behind by an uncertain writer is never removed or repaired: admission
// fails closed with RUN_ADMISSION_UNCERTAIN and recovery stays with the Human.

const HEX64 = /^[0-9a-f]{64}$/;

export type RootRunAdmissionErrorCode = 'RUN_IDENTITY_CONFLICT' | 'RUN_ADMISSION_INTEGRITY' | 'RUN_ADMISSION_UNCERTAIN' |
  'RUN_BEYOND_ADMISSION';

/** Admission could not be established or read truthfully. Fails closed; nothing is repaired, adopted or rewritten. */
export class RootRunAdmissionError extends Error {
  constructor(readonly code: RootRunAdmissionErrorCode, message: string) {
    super(message);
    this.name = 'RootRunAdmissionError';
  }
}

/** The exact identity of an existing governed Change (from the Change Registry). */
export interface GovernedChangeIdentity { repository: string; sliceId: string; changeKey: string }

/** The admitted ROOT run as the Controller store holds it: operational, IDLE, untouched since admission. */
export interface AdmittedRootRun {
  runId: string;
  repository: string;
  sliceId: string;
  changeKey: string;
  admission: 'ROOT';
  recordClass: 'OPERATIONAL_RECORD';
  controllerState: 'IDLE';
  admittedAt: string;
}
export type RootRunLookup = AdmittedRootRun | { admission: 'NONE' | 'ROOT_PENDING'; runId: null };

export interface RootRunAdmitter {
  lookup(change: GovernedChangeIdentity): RootRunLookup;
  admit(change: GovernedChangeIdentity): AdmittedRootRun;
}

/** The deterministic ROOT runId of a Change: "run-" + its exact changeKey. Never truncated or normalised. */
export function rootRunIdOf(changeKey: string): string {
  if (typeof changeKey !== 'string' || !HEX64.test(changeKey)) throw new RootRunAdmissionError('RUN_ADMISSION_INTEGRITY', 'Not a canonical changeKey');
  return `run-${changeKey}`;
}

const integrity = (message: string) => new RootRunAdmissionError('RUN_ADMISSION_INTEGRITY', message);

/** Opens the store (its internal layout only; the root itself must already be a checked protected root). */
export function openRootRunAdmitter(controllerStoreDirectory: string, clock: Clock = SYSTEM_CLOCK): RootRunAdmitter {
  const directory = resolve(controllerStoreDirectory);
  const store = new FileControllerStore(directory, clock);
  const controller = new AutomationController(clock, store);

  const identityOf = (change: GovernedChangeIdentity) => {
    let exact: { repository: string; sliceId: string };
    try { exact = parseChangeIdentity(change); }
    catch { throw integrity('The governed Change has no canonical R4L identity'); }
    if (change.changeKey !== changeKeyOf(exact)) throw integrity('The changeKey is not the exact R4L key of this Change');
    return { ...exact, changeKey: change.changeKey, runId: rootRunIdOf(change.changeKey) };
  };
  type Identity = ReturnType<typeof identityOf>;

  // What R4L storage holds for the Change, checked from both sides. The claim decides first:
  // a ROOT under another runId is never adopted, renamed or backfilled.
  const observe = (id: Identity): { admittedAt?: string; run?: ControllerRun } => {
    try {
      const record = store.admissionRecord({ repository: id.repository, sliceId: id.sliceId });
      if (record && record.rootRunId !== id.runId) {
        throw new RootRunAdmissionError('RUN_IDENTITY_CONFLICT', 'This Change already has a ROOT run under another runId; nothing was adopted');
      }
      if (record && (record.changeKey !== id.changeKey || record.repository !== id.repository || record.sliceId !== id.sliceId)) {
        throw integrity('The admission record does not name this exact Change');
      }
      const run = store.get(id.runId);
      if (!run) return { admittedAt: record?.admittedAt };
      if (!record || run.runId !== id.runId || run.repository !== id.repository || run.sliceId !== id.sliceId) {
        throw integrity('The stored run and its admission record disagree');
      }
      return { admittedAt: record.admittedAt, run };
    } catch (error) {
      if (error instanceof RootRunAdmissionError) throw error;
      throw integrity('The Controller store failed its admission integrity check; nothing was repaired');
    }
  };
  const admitted = (id: Identity, observed: { admittedAt?: string; run?: ControllerRun }): AdmittedRootRun => {
    // RA1 establishes and reports only a run still exactly as admitted: empty, in IDLE.
    try { assertFreshRun(observed.run!); }
    catch { throw new RootRunAdmissionError('RUN_BEYOND_ADMISSION', 'The ROOT run has moved beyond admission; this surface reports only an IDLE run'); }
    return Object.freeze({ runId: id.runId, repository: id.repository, sliceId: id.sliceId, changeKey: id.changeKey,
      admission: 'ROOT', recordClass: 'OPERATIONAL_RECORD', controllerState: 'IDLE', admittedAt: observed.admittedAt! });
  };

  return Object.freeze({
    lookup(change: GovernedChangeIdentity): RootRunLookup {
      const id = identityOf(change);
      const observed = observe(id);
      if (observed.run) return admitted(id, observed);
      return Object.freeze({ admission: observed.admittedAt === undefined ? 'NONE' : 'ROOT_PENDING', runId: null });
    },
    admit(change: GovernedChangeIdentity): AdmittedRootRun {
      const id = identityOf(change);
      const before = observe(id);
      if (before.run) return admitted(id, before);
      let failure: RootRunAdmissionError | undefined;
      try { controller.createRun(id.runId, id.sliceId, id.repository); }
      catch (error) {
        failure = error instanceof RunAdmissionIntegrityError ? integrity('R4L admission failed its integrity check; nothing was repaired')
          // A refusal names a different ROOT, which the re-read below reports as a conflict.
          : error instanceof RunAdmissionRefusedError ? integrity('R4L refused the ROOT run')
          // Anything else, including a run lock left by an uncertain writer (the store's exclusive
          // lock open fails), leaves the outcome unknown. The lock is never removed.
          : new RootRunAdmissionError('RUN_ADMISSION_UNCERTAIN', 'Run admission did not complete; nothing was repaired');
      }
      // Whatever happened, storage decides: an identical creator that won the race, or this
      // one, leaves the exact run; anything else fails closed.
      const after = observe(id);
      if (after.run) return admitted(id, after);
      throw failure ?? new RootRunAdmissionError('RUN_ADMISSION_UNCERTAIN', 'The admitted run is not in the Controller store');
    },
  });
}
