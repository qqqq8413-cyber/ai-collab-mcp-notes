import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync,
  writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  EgressJournalIntegrityError, MAX_EGRESS_EVENTS, assertEgressTransition, parseEgressEvent, parseEgressIdentity, parseEgressSession,
  type EgressEvent, type EgressEventInput, type EgressJournal, type EgressSession, type EgressSessionIdentity,
} from './egress-journal.js';
import { sha256Hex } from './invocation-journal.js';
import { isInstant } from './time.js';
import type { Clock } from './types.js';

const VERSION = 1;

// Durability follows FileInvocationJournal: a checksummed envelope per session, one
// exclusive journal-wide writer lock, temp-write + fsync + rename + directory fsync, full
// validation on every read, and every write checked as an append-only transition of the
// stored session. Malformed bytes fail closed; nothing is repaired.
export class FileEgressJournal implements EgressJournal {
  readonly #directory: string;
  readonly #clock: Clock;

  constructor(directory: string, clock: Clock) {
    if (typeof directory !== 'string' || !directory.trim()) throw new Error('Egress journal directory required');
    if (!clock || typeof clock.now !== 'function') throw new Error('Egress journal clock required');
    this.#directory = resolve(directory);
    this.#clock = clock;
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    Object.freeze(this);
  }

  #now(): string {
    const at = this.#clock.now();
    if (!isInstant(at)) throw new Error('Egress journal clock returned an invalid timestamp');
    return at;
  }
  #file(sessionId: string): string {
    if (typeof sessionId !== 'string' || !/^[0-9a-f]{64}$/.test(sessionId)) throw new Error('Invalid egress session id');
    return join(this.#directory, `${sessionId}.json`);
  }
  #load(sessionId: string): EgressSession | undefined {
    const file = this.#file(sessionId);
    if (!existsSync(file)) return undefined;
    let envelope: unknown;
    try { envelope = JSON.parse(readFileSync(file, 'utf8')); }
    catch { throw new EgressJournalIntegrityError('Egress journal file is not JSON'); }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
        Object.keys(envelope).sort().join(',') !== 'checksum,schemaVersion,session') {
      throw new EgressJournalIntegrityError('Invalid egress journal envelope');
    }
    const stored = envelope as { schemaVersion: unknown; checksum: unknown; session: unknown };
    if (stored.schemaVersion !== VERSION) throw new EgressJournalIntegrityError('Unsupported egress journal version');
    if (stored.checksum !== sha256Hex(JSON.stringify(stored.session))) throw new EgressJournalIntegrityError('Egress journal checksum mismatch');
    const session = parseEgressSession(stored.session);
    if (session.sessionId !== sessionId) throw new EgressJournalIntegrityError('Egress journal file holds another session');
    return session;
  }
  // A leftover lock is an uncertain writer. Never remove one this instance did not create.
  #locked<T>(action: () => T): T {
    const lock = join(this.#directory, '.egress.lock');
    const fd = openSync(lock, 'wx', 0o600);
    const identity = fstatSync(fd);
    try { return action(); }
    finally {
      closeSync(fd);
      const current = lstatSync(lock);
      if (current.dev !== identity.dev || current.ino !== identity.ino) throw new Error('Egress journal lock ownership changed');
      unlinkSync(lock);
    }
  }
  #write(session: EgressSession): void {
    const target = this.#file(session.sessionId);
    const temp = `${target}.${randomUUID()}.tmp`;
    const payload = JSON.stringify(session);
    const serialized = JSON.stringify({ schemaVersion: VERSION, session: JSON.parse(payload), checksum: sha256Hex(payload) });
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
  #advance(sessionId: string, next: (current: EgressSession, at: string) => EgressSession): EgressSession {
    return this.#locked(() => {
      const current = this.#load(sessionId);
      if (!current) throw new Error('Unknown egress session');
      const after = next(structuredClone(current), this.#now());
      assertEgressTransition(current, after);
      this.#write(after);
      return structuredClone(after);
    });
  }

  open(input: EgressSessionIdentity): EgressSession {
    const identity = parseEgressIdentity(input);
    return this.#locked(() => {
      if (existsSync(this.#file(identity.invocationId))) throw new Error('Duplicate egress session: this invocation already has one');
      const session = parseEgressSession({ sessionId: identity.invocationId, identity, state: 'OPEN', openedAt: this.#now(), events: [] });
      this.#write(session);
      return structuredClone(session);
    });
  }
  record(sessionId: string, input: EgressEventInput): EgressEvent {
    const after = this.#advance(sessionId, (current, at) => {
      if (current.events.length >= MAX_EGRESS_EVENTS) throw new EgressJournalIntegrityError('Egress session event bound reached');
      const event = parseEgressEvent(input, current.identity.egressDestinations);
      return { ...current, events: [...current.events, { sequence: current.events.length + 1, at, ...event }] };
    });
    return after.events.at(-1)!;
  }
  close(sessionId: string): EgressSession {
    return this.#advance(sessionId, (current, at) => ({ ...current, state: 'CLOSED', closedAt: at }));
  }
  get(sessionId: string): EgressSession | undefined {
    const session = this.#load(sessionId);
    return session && structuredClone(session);
  }
}
Object.freeze(FileEgressJournal);
Object.freeze(FileEgressJournal.prototype);
