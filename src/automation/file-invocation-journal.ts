import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync,
  unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  InvocationJournalIntegrityError, assertInvocationTransition, invocationIdOf, parseInvocationIdentity, parseInvocationRecord,
  serializeOutcome, sha256Hex, type ActorKind, type InvocationIdentity, type InvocationJournal, type InvocationRecord,
  type InvocationState, type StartResult, type StoredOutcome,
} from './invocation-journal.js';
import { isInstant } from './time.js';
import type { Clock } from './types.js';

// Version 1 bound one destination string that nothing enforced. It is never read as
// version 2: turning such a string into an egress set would manufacture network
// authority that was never proven, so a version 1 record fails closed as unsupported.
const VERSION = 2;
const RECORD_FILE = /^[0-9a-f]{64}\.json$/;

// Durability follows FileControllerStore: a checksummed envelope per invocation, one
// exclusive journal-wide writer lock (so budget counting and the STARTED write are one
// step), temp-write + fsync + rename + directory fsync, and full validation on every
// read. Malformed bytes fail closed; nothing is repaired.
export class FileInvocationJournal implements InvocationJournal {
  readonly #directory: string;
  readonly #clock: Clock;

  constructor(directory: string, clock: Clock) {
    if (typeof directory !== 'string' || !directory.trim()) throw new Error('Journal directory required');
    if (!clock || typeof clock.now !== 'function') throw new Error('Journal clock required');
    this.#directory = resolve(directory);
    this.#clock = clock;
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    Object.freeze(this);
  }

  #now(): string {
    const at = this.#clock.now();
    if (!isInstant(at)) throw new Error('Journal clock returned an invalid timestamp');
    return at;
  }
  #file(invocationId: string): string {
    if (typeof invocationId !== 'string' || !/^[0-9a-f]{64}$/.test(invocationId)) throw new Error('Invalid invocation id');
    return join(this.#directory, `${invocationId}.json`);
  }
  #load(invocationId: string): InvocationRecord | undefined {
    const file = this.#file(invocationId);
    if (!existsSync(file)) return undefined;
    let envelope: unknown;
    try { envelope = JSON.parse(readFileSync(file, 'utf8')); }
    catch { throw new InvocationJournalIntegrityError('Invocation journal file is not JSON'); }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
        Object.keys(envelope).sort().join(',') !== 'checksum,record,schemaVersion') {
      throw new InvocationJournalIntegrityError('Invalid invocation journal envelope');
    }
    const stored = envelope as { schemaVersion: unknown; checksum: unknown; record: unknown };
    if (stored.schemaVersion !== VERSION) {
      throw new InvocationJournalIntegrityError(`Unsupported invocation journal version ${JSON.stringify(stored.schemaVersion)}; records are never migrated`);
    }
    if (stored.checksum !== sha256Hex(JSON.stringify(stored.record))) throw new InvocationJournalIntegrityError('Invocation journal checksum mismatch');
    const record = parseInvocationRecord(stored.record);
    if (record.invocationId !== invocationId) throw new InvocationJournalIntegrityError('Invocation journal file holds another invocation');
    return record;
  }
  // A leftover lock is an uncertain writer. Never remove one this instance did not create.
  #locked<T>(action: () => T): T {
    const lock = join(this.#directory, '.journal.lock');
    const fd = openSync(lock, 'wx', 0o600);
    const identity = fstatSync(fd);
    try { return action(); }
    finally {
      closeSync(fd);
      const current = lstatSync(lock);
      if (current.dev !== identity.dev || current.ino !== identity.ino) throw new Error('Invocation journal lock ownership changed');
      unlinkSync(lock);
    }
  }
  #write(record: InvocationRecord): void {
    const target = this.#file(record.invocationId);
    const temp = `${target}.${randomUUID()}.tmp`;
    const payload = JSON.stringify(record);
    const serialized = JSON.stringify({ schemaVersion: VERSION, record: JSON.parse(payload), checksum: sha256Hex(payload) });
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
  #all(): InvocationRecord[] {
    return readdirSync(this.#directory).filter((name) => RECORD_FILE.test(name))
      .map((name) => this.#load(name.slice(0, -'.json'.length))!);
  }
  #advance(invocationId: string, state: InvocationState, extra: (current: InvocationRecord, at: string) => Partial<InvocationRecord> = () => ({}),
    note?: string): InvocationRecord {
    return this.#locked(() => {
      const current = this.#load(invocationId);
      if (!current) throw new Error('Unknown invocation');
      const at = this.#now();
      const next: InvocationRecord = { ...structuredClone(current), ...extra(current, at), state,
        history: [...structuredClone(current.history), { state, at, ...(note === undefined ? {} : { note: note.slice(0, 2000) }) }] };
      assertInvocationTransition(current, next);
      this.#write(next);
      return structuredClone(next);
    });
  }

  prepare(input: InvocationIdentity): InvocationRecord {
    const identity = parseInvocationIdentity(input);
    const invocationId = invocationIdOf(identity.runId, identity.occurrence.sequence, identity.actorKind);
    return this.#locked(() => {
      if (this.#load(invocationId)) throw new Error('Duplicate invocation identity: this occurrence and actor already have one');
      const record = parseInvocationRecord({ invocationId, identity, state: 'PREPARED', history: [{ state: 'PREPARED', at: this.#now() }] });
      this.#write(record);
      return structuredClone(record);
    });
  }
  get(invocationId: string): InvocationRecord | undefined {
    const record = this.#load(invocationId);
    return record && structuredClone(record);
  }
  find(runId: string, sequence: number, actorKind: ActorKind): InvocationRecord | undefined {
    return this.get(invocationIdOf(runId, sequence, actorKind));
  }
  list(runId: string): InvocationRecord[] {
    return this.#all().filter((record) => record.identity.runId === runId).map((record) => structuredClone(record));
  }
  start(invocationId: string, maxCalls: number): StartResult {
    if (!Number.isSafeInteger(maxCalls) || maxCalls < 0) throw new RangeError('maxCalls must be a non-negative integer');
    return this.#locked(() => {
      const current = this.#load(invocationId);
      if (!current) throw new Error('Unknown invocation');
      if (current.state !== 'PREPARED') return { status: 'NOT_PREPARED', record: structuredClone(current) };
      // Every call that ever started counts, whatever became of it; nothing resets this.
      const used = this.#all().filter((record) => record.identity.runId === current.identity.runId &&
        record.identity.packetId === current.identity.packetId && record.history.some((entry) => entry.state === 'STARTED')).length;
      if (used >= maxCalls) return { status: 'BUDGET_EXHAUSTED', used };
      const next: InvocationRecord = { ...structuredClone(current), state: 'STARTED',
        history: [...structuredClone(current.history), { state: 'STARTED', at: this.#now() }] };
      assertInvocationTransition(current, next);
      this.#write(next);
      return { status: 'STARTED', record: structuredClone(next) };
    });
  }
  complete(invocationId: string, outcome: StoredOutcome): InvocationRecord {
    const serialized = serializeOutcome(outcome);
    return this.#advance(invocationId, 'COMPLETED', (current, at) => ({ result: { serialized, sha256: sha256Hex(serialized), completedAt: at,
      metadata: { provider: current.identity.provider, model: current.identity.model,
        egressDestinations: [...current.identity.egressDestinations], authorizationId: current.identity.authorizationId } } }));
  }
  markUncertain(invocationId: string, note: string): InvocationRecord {
    return this.#advance(invocationId, 'UNCERTAIN', undefined, note);
  }
  abandon(invocationId: string, note: string): InvocationRecord {
    return this.#advance(invocationId, 'ABANDONED', undefined, note);
  }
  markApplied(invocationId: string, application: { sequence: number; action: string }): InvocationRecord {
    return this.#advance(invocationId, 'APPLIED', () => ({ application: { sequence: application.sequence, action: application.action } }));
  }
}
Object.freeze(FileInvocationJournal);
Object.freeze(FileInvocationJournal.prototype);
