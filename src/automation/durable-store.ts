import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  RunAdmissionIntegrityError, admissionDecision, admissionRecordOf, changeKeyOf, openAdmissionRecord,
  openAdmissionRefusalRecord, parseChangeIdentity, refuseSecondRun, sealAdmissionRecord, type AdmissionRecord,
  type AdmissionRefusalRecord, type ChangeIdentity,
} from './admission.js';
import { assertFreshRun, assertRunInvariants, assertTransition } from './lifecycle.js';
import { requiresControllerWriter, type ControllerStore } from './audit.js';
import { SYSTEM_CLOCK, isInstant, parseInstant } from './time.js';
import type { AuditEntry, Clock, ControllerRun } from './types.js';

const VERSION = 1;
const RUN_FILE = /^[0-9a-f]{64}\.json$/;
const CLAIM_FILE = RUN_FILE;
const REFUSAL_FILE = /^[0-9a-f-]{36}\.json$/;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** The file name a run is stored under: the runId is never a path. */
export function storedRunFileName(runId: string): string { return `${digest(runId)}.json`; }

/**
 * Opens one stored run envelope: the canonical read of a run file, shared by the store
 * and the read-only governed read model (G1-R4A0) so both apply one definition. Checks
 * the envelope, schema version, checksum, identity binding (`owns`) and every lifecycle
 * invariant; anything else throws. Pure: it reads and writes nothing.
 */
export function openStoredRun(text: string, owns: (runId: unknown) => boolean): ControllerRun {
  let envelope: unknown;
  try { envelope = JSON.parse(text); }
  catch { throw new Error('Corrupt controller storage JSON'); }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
      Object.keys(envelope).sort().join(',') !== 'checksum,run,schemaVersion') {
    throw new Error('Invalid controller storage envelope');
  }
  const stored = envelope as { schemaVersion: unknown; checksum: unknown; run: unknown };
  if (stored.schemaVersion !== VERSION) throw new Error('Unsupported controller storage schema version');
  if (typeof stored.checksum !== 'string' || stored.checksum !== digest(JSON.stringify(stored.run))) {
    throw new Error('Controller storage checksum mismatch');
  }
  if (!stored.run || typeof stored.run !== 'object' || !owns((stored.run as ControllerRun).runId)) {
    throw new Error('Controller storage identity mismatch');
  }
  assertRunInvariants(stored.run as ControllerRun);
  return stored.run as ControllerRun;
}

// Admission (CHIEF-GOV/1, G1-R4L-1) lives beside the runs. changes/<changeKey>.json is
// the write-once claim that makes one run the ROOT of its change; changes/refusals/
// <changeKey>/ holds best-effort evidence of refused second runs. Both are operational
// records, never authority.
//
// Filesystem contract: the directory must be on a LOCAL filesystem whose link(2)
// publishes a name atomically and exclusively (EEXIST when the name exists) and whose
// fsync makes a directory entry durable. Network, sync and remote filesystems are not
// supported. Where link publication is unavailable, admission fails closed; there is no
// weaker fallback.
export class FileControllerStore implements ControllerStore {
  readonly #directory: string;
  readonly #changes: string;
  readonly #clock: Clock;
  #bound = false;

  constructor(directory: string, clock: Clock = SYSTEM_CLOCK) {
    if (typeof directory !== 'string' || !directory.trim()) throw new Error('Storage directory required');
    if (!clock || typeof clock.now !== 'function') throw new Error('Storage clock required');
    this.#directory = resolve(directory);
    this.#changes = join(this.#directory, 'changes');
    this.#clock = clock;
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    mkdirSync(this.#changes, { recursive: true, mode: 0o700 });
    this.#sync(this.#directory);
    this.#assertIndexed();
    Object.freeze(this);
  }
  #file(runId: string): string {
    if (typeof runId !== 'string' || !runId.trim()) throw new Error('Invalid runId');
    return join(this.#directory, storedRunFileName(runId));
  }
  #sync(directory: string): void {
    const fd = openSync(directory, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  #load(runId: string): ControllerRun | undefined {
    const file = this.#file(runId);
    if (!existsSync(file)) return undefined;
    const run = this.#read(file, (stored) => stored === runId);
    this.#assertRoot(run);
    return run;
  }
  #read(file: string, owns: (runId: unknown) => boolean): ControllerRun {
    let text: string;
    try { text = readFileSync(file, 'utf8'); }
    catch { throw new Error('Corrupt controller storage JSON'); }
    return openStoredRun(text, owns);
  }
  // The store opens only when admissions and runs form one-to-one ROOT relations, checked
  // from both sides. Each admission's runId is the ROOT of that change alone, and a run
  // file under it belongs to that change; a pending ROOT (no run file yet) is valid. Each
  // run is the admitted ROOT of its change. A run that is not (created before admission
  // existed, or written around the store) fails closed: indexing it now would mean
  // guessing which run of its change came first, so nothing is backfilled or repaired.
  #assertIndexed(): void {
    const owners = new Set<string>();
    for (const record of this.#claims()) {
      if (owners.has(record.rootRunId)) {
        throw new RunAdmissionIntegrityError('ADMISSION_REGISTRY_MISMATCH', 'One runId is claimed as ROOT by two changes', record.changeKey);
      }
      owners.add(record.rootRunId);
      const file = this.#file(record.rootRunId);
      if (!existsSync(file)) continue;
      const run = this.#read(file, (stored) => stored === record.rootRunId);
      if (run.repository !== record.repository || run.sliceId !== record.sliceId) {
        throw new RunAdmissionIntegrityError('ADMISSION_REGISTRY_MISMATCH', 'An admitted ROOT run belongs to another change', record.changeKey);
      }
    }
    for (const name of readdirSync(this.#directory)) {
      if (!RUN_FILE.test(name)) continue;
      this.#assertRoot(this.#read(join(this.#directory, name), (stored) => typeof stored === 'string' && `${digest(stored)}.json` === name));
    }
  }
  #assertRoot(run: ControllerRun): void {
    let changeKey: string;
    try { changeKey = changeKeyOf(run); }
    catch { throw new RunAdmissionIntegrityError('LEGACY_UNINDEXED_RUN', 'Stored run has no canonical change identity; it predates admission'); }
    const record = this.#admission(changeKey);
    if (!record) throw new RunAdmissionIntegrityError('LEGACY_UNINDEXED_RUN', 'Stored run has no admission record', changeKey);
    if (record.rootRunId !== run.runId) {
      throw new RunAdmissionIntegrityError('ADMISSION_REGISTRY_MISMATCH', 'Stored run is not the admitted ROOT of its change', changeKey);
    }
  }
  #admissionFile(changeKey: string): string { return join(this.#changes, `${changeKey}.json`); }
  // Canonical claims only: temp names and refusal evidence never take part.
  #claims(): AdmissionRecord[] {
    return readdirSync(this.#changes).filter((name) => CLAIM_FILE.test(name))
      .map((name) => this.#admission(name.slice(0, -'.json'.length))!);
  }
  // A runId is the ROOT of at most one change. Runs under that runId's lock, and only a
  // writer holding it can publish a claim naming it, so no such claim can appear meanwhile.
  #assertRootUnclaimed(runId: string, changeKey: string): void {
    if (this.#claims().some((record) => record.rootRunId === runId && record.changeKey !== changeKey)) {
      throw new RunAdmissionIntegrityError('ADMISSION_REGISTRY_MISMATCH', 'This runId is already the ROOT of another change', changeKey);
    }
  }
  #admission(changeKey: string): AdmissionRecord | undefined {
    let text: string;
    try { text = readFileSync(this.#admissionFile(changeKey), 'utf8'); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return undefined;
      throw new RunAdmissionIntegrityError('ADMISSION_RECORD_INVALID', `Admission record is unreadable (${code ?? 'unknown error'})`, changeKey);
    }
    const record = openAdmissionRecord(text);
    if (record.changeKey !== changeKey) {
      throw new RunAdmissionIntegrityError('ADMISSION_REGISTRY_MISMATCH', 'Admission record is filed under another change', changeKey);
    }
    return record;
  }
  #now(): string {
    const at = this.#clock.now();
    if (!isInstant(at)) throw new Error('Storage clock returned an invalid timestamp');
    return at;
  }
  // Runs under the requested run's lock, so finishing a pending ROOT cannot race another
  // writer of that run, and no other run of the change gets past an existing claim.
  #admit(runId: string, change: ChangeIdentity): void {
    const changeKey = changeKeyOf(change);
    let record = this.#admission(changeKey);
    if (!record) {
      this.#assertRootUnclaimed(runId, changeKey);
      if (this.#claim(admissionRecordOf(change, runId, this.#now()))) return;
      // EEXIST: another writer owns the change. Its claim decides.
      record = this.#admission(changeKey);
      if (!record) throw new RunAdmissionIntegrityError('ADMISSION_REGISTRY_MISMATCH', 'A lost admission claim left no record', changeKey);
    }
    if (admissionDecision(record, change, runId) === 'ROOT_PENDING') {
      // A claim that outlived a crash before its run was written. Only this run may finish
      // it; the claim is made durable before the run is.
      this.#assertRootUnclaimed(runId, changeKey);
      this.#sync(this.#changes);
      return;
    }
    refuseSecondRun(record, change, runId, this.#clock, (refusal) => this.#recordRefusal(refusal));
  }
  // One link(2) publishes the complete record atomically and exclusively: the name is
  // either absent or names the whole claim. EEXIST means another writer owns the change.
  // No lock file is involved, so admission has no stale lock, and a crash leaves either
  // nothing or a whole claim. Any other failure means the primitive is unavailable here:
  // fail closed, never fall back to check-then-write, rename-over-existing or a lock.
  #claim(record: AdmissionRecord): boolean {
    const temp = join(this.#changes, `${record.changeKey}.${randomUUID()}.tmp`);
    const fd = openSync(temp, 'wx', 0o600);
    try {
      try {
        writeFileSync(fd, sealAdmissionRecord(record));
        fsyncSync(fd);
      } finally { closeSync(fd); }
      try { linkSync(temp, this.#admissionFile(record.changeKey)); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') return false;
        throw new RunAdmissionIntegrityError('ADMISSION_CLAIM_UNAVAILABLE',
          `Atomic admission claim is unavailable (${code ?? 'unknown error'}); no fallback is attempted`, record.changeKey);
      }
      this.#sync(this.#changes);
      return true;
    } finally {
      // Temp names are never read; one left behind by a crash is harmless.
      try { unlinkSync(temp); } catch { /* best effort */ }
    }
  }
  // Best-effort, append-only operational evidence. Never authority, never read by
  // admission, and never a condition of the refusal it records.
  #recordRefusal(refusal: AdmissionRefusalRecord): void {
    const directory = join(this.#changes, 'refusals', refusal.changeKey);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const target = join(directory, `${randomUUID()}.json`);
    const temp = `${target}.tmp`;
    const fd = openSync(temp, 'wx', 0o600);
    try {
      try {
        writeFileSync(fd, sealAdmissionRecord(refusal));
        fsyncSync(fd);
      } finally { closeSync(fd); }
      linkSync(temp, target);
    } finally {
      try { unlinkSync(temp); } catch { /* best effort */ }
    }
    this.#sync(directory);
  }
  #locked(runId: string, action: () => void): void {
    const lock = `${this.#file(runId)}.lock`;
    // A leftover lock is an uncertain writer. Never remove one we did not create.
    const fd = openSync(lock, 'wx', 0o600);
    const identity = fstatSync(fd);
    try { action(); }
    finally {
      closeSync(fd);
      const current = lstatSync(lock);
      if (current.dev !== identity.dev || current.ino !== identity.ino) throw new Error('Controller lock ownership changed');
      unlinkSync(lock);
    }
  }
  #write(runId: string, run: ControllerRun): void {
    const target = this.#file(runId);
    const temp = `${target}.${randomUUID()}.tmp`;
    const payload = JSON.stringify(run);
    const serialized = JSON.stringify({ schemaVersion: VERSION, run: JSON.parse(payload), checksum: digest(payload) });
    const fd = openSync(temp, 'wx', 0o600);
    try {
      writeFileSync(fd, serialized);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    try {
      renameSync(temp, target);
      const directoryFd = openSync(this.#directory, 'r');
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    } catch (error) {
      if (existsSync(temp)) unlinkSync(temp);
      throw error;
    }
  }
  create(input: ControllerRun): void {
    const run = structuredClone(input);
    assertFreshRun(run);
    const change = parseChangeIdentity(run);
    this.#locked(run.runId, () => {
      if (this.#load(run.runId)) throw new Error('Duplicate runId');
      this.#admit(run.runId, change);
      this.#write(run.runId, run);
    });
  }
  /** The admission record of a change, if it has one. Operational integrity data; it grants nothing. */
  admissionRecord(change: ChangeIdentity): AdmissionRecord | undefined {
    return this.#admission(changeKeyOf(change));
  }
  /** Recorded refusals of second runs for a change, oldest first. Operational evidence; it grants nothing. */
  admissionRefusals(change: ChangeIdentity): AdmissionRefusalRecord[] {
    const changeKey = changeKeyOf(change);
    const directory = join(this.#changes, 'refusals', changeKey);
    if (!existsSync(directory)) return [];
    return readdirSync(directory).filter((name) => REFUSAL_FILE.test(name)).map((name) => {
      const refusal = openAdmissionRefusalRecord(readFileSync(join(directory, name), 'utf8'));
      if (refusal.changeKey !== changeKey) {
        throw new RunAdmissionIntegrityError('ADMISSION_REGISTRY_MISMATCH', 'Refusal record is filed under another change', changeKey);
      }
      return refusal;
    }).sort((a, b) => parseInstant(a.refusedAt)! - parseInstant(b.refusedAt)!);
  }
  get(runId: string): ControllerRun | undefined {
    const run = this.#load(runId);
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
    this.#locked(run.runId, () => {
      const current = this.#load(run.runId);
      if (!current) throw new Error('Unknown runId');
      assertTransition(current, run);
      this.#write(run.runId, run);
    });
  }
  entries(runId: string): AuditEntry[] {
    const run = this.get(runId);
    if (!run) throw new Error('Unknown runId');
    return structuredClone(run.audit);
  }
}
Object.freeze(FileControllerStore);
Object.freeze(FileControllerStore.prototype);
