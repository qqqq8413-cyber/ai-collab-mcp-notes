/**
 * Durable one-attempt registry for a CBRP census session — CENSUS-REQ-03.
 *
 * ## Why the reservation is written before the call
 *
 * The capture harness reserves a budget slot synchronously and journals the call once it
 * settles. That is enough to bound spend, and not enough here. If the process dies between
 * dispatch and settlement, a settled-only journal cannot tell "this task was never tried"
 * from "this task was tried and we lost the answer" — and a census whose rule is exactly
 * one attempt per task must never resolve that ambiguity by trying again.
 *
 * So the reservation is written and fsynced to disk *before* the provider boundary. After
 * a crash the three states are distinguishable from the filesystem alone:
 *
 *   never attempted            no record
 *   settled attempt            reserved + settled
 *   reserved but unsettled     reserved, no settlement  ->  AMBIGUOUS ATTEMPT CONSUMED
 *
 * ## Why the third state stops the session
 *
 * An unsettled reservation means an attempt may have been spent on a task whose result we
 * do not have. Retrying would be a second attempt; skipping would silently drop a task
 * from the denominator; replacing it would be outcome-informed substitution. All three
 * corrupt the study, so recovery refuses to continue and the session is INCOMPLETE.
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export const ATTEMPT_RESERVED = 'attempt_reserved';
export const ATTEMPT_SETTLED = 'attempt_settled';

export const NEVER_ATTEMPTED = 'NEVER_ATTEMPTED';
export const SETTLED = 'SETTLED';
export const RESERVED_UNSETTLED = 'RESERVED_UNSETTLED';

export const AMBIGUOUS_ATTEMPT_CONSUMED = 'AMBIGUOUS_ATTEMPT_CONSUMED';

export class AttemptRegistryError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AttemptRegistryError';
    this.code = code ?? 'ATTEMPT_REGISTRY_VIOLATION';
  }
}

/** A task's identity is its id *and* its frozen bytes; either alone can be reused. */
export const attemptKey = (taskId, taskSha256) => `${taskId}@${taskSha256}`;

/**
 * Append-only NDJSON with an fsync per record, and an fsync of the directory on create.
 *
 * Append-only because a rewritten file can lose earlier records to a crash mid-write; the
 * fsync because the whole guarantee is that the reservation survives a power failure that
 * happens one instruction later.
 */
export function openAttemptRegistry(registryPath) {
  mkdirSync(dirname(registryPath), { recursive: true });
  const existed = existsSync(registryPath);
  const fd = openSync(registryPath, 'a');
  if (!existed) {
    const dir = openSync(dirname(registryPath), 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  }

  const records = existed ? readRecords(registryPath) : [];
  let seq = records.length;

  const append = (record) => {
    const full = { seq: (seq += 1), ...record };
    writeSync(fd, `${JSON.stringify(full)}\n`);
    fsyncSync(fd);
    records.push(full);
    return full;
  };

  const stateOf = (taskId, taskSha256) => {
    const key = attemptKey(taskId, taskSha256);
    const mine = records.filter((r) => r.key === key);
    if (mine.length === 0) return NEVER_ATTEMPTED;
    return mine.some((r) => r.state === ATTEMPT_SETTLED) ? SETTLED : RESERVED_UNSETTLED;
  };

  return {
    path: registryPath,
    get records() { return [...records]; },
    stateOf,

    /**
     * Claims the single attempt for a task. Must be called before the provider boundary.
     */
    reserve(taskId, taskSha256, meta = {}) {
      const state = stateOf(taskId, taskSha256);
      if (state !== NEVER_ATTEMPTED) {
        throw new AttemptRegistryError(
          `${taskId} is already ${state}; one attempt per task and no retry.`,
          'DUPLICATE_ATTEMPT',
        );
      }
      return append({ key: attemptKey(taskId, taskSha256), taskId, taskSha256, state: ATTEMPT_RESERVED, ...meta });
    },

    /** Records the outcome, success or failure. A failure is still a consumed attempt. */
    settle(taskId, taskSha256, outcome) {
      const state = stateOf(taskId, taskSha256);
      if (state === NEVER_ATTEMPTED) {
        throw new AttemptRegistryError(`${taskId} was settled without a reservation.`, 'SETTLED_WITHOUT_RESERVATION');
      }
      if (state === SETTLED) {
        throw new AttemptRegistryError(`${taskId} is already settled.`, 'DUPLICATE_SETTLEMENT');
      }
      return append({
        key: attemptKey(taskId, taskSha256), taskId, taskSha256, state: ATTEMPT_SETTLED, ...outcome,
      });
    },

    close() { closeSync(fd); },
  };
}

export function readRecords(registryPath) {
  if (!existsSync(registryPath)) return [];
  return readFileSync(registryPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * Reads a registry from disk and decides whether a session may continue.
 *
 * Returns rather than throws, because the caller has to record the refusal in the session
 * artifact before stopping — a stop that leaves no evidence is indistinguishable from a
 * crash.
 */
export function recoverSession(registryPath) {
  const records = readRecords(registryPath);
  const byKey = new Map();
  for (const record of records) {
    const entry = byKey.get(record.key) ?? { taskId: record.taskId, taskSha256: record.taskSha256, reserved: false, settled: false };
    if (record.state === ATTEMPT_RESERVED) entry.reserved = true;
    if (record.state === ATTEMPT_SETTLED) entry.settled = true;
    byKey.set(record.key, entry);
  }

  const settled = [];
  const unsettled = [];
  for (const entry of byKey.values()) (entry.settled ? settled : unsettled).push(entry);

  if (unsettled.length > 0) {
    return {
      resumable: false,
      sessionStatus: 'INCOMPLETE',
      reason: AMBIGUOUS_ATTEMPT_CONSUMED,
      detail:
        `${unsettled.map((e) => e.taskId).join(', ')} reserved an attempt that never settled. `
        + 'The attempt may have been spent, so it may not be retried, replaced, or skipped.',
      settledTaskIds: settled.map((e) => e.taskId),
      unsettledTaskIds: unsettled.map((e) => e.taskId),
    };
  }

  return {
    resumable: true,
    sessionStatus: 'RESUMABLE',
    reason: null,
    detail: null,
    settledTaskIds: settled.map((e) => e.taskId),
    unsettledTaskIds: [],
  };
}

export { sha256 };
