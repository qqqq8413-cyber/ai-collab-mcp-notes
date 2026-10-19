import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { PROJECT_ID } from './config.js';

// Operational observations only. This store holds no goal, run or authority capability.
export const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const uuid = z.string().uuid();
const instant = z.iso.datetime();
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const observedEventSchema = z.strictObject({
  id: z.string().regex(/^src-[a-f0-9]{64}$/), projectId: z.string().regex(PROJECT_ID),
  actor: z.literal('Claude Code'), actorId: z.literal('claude-code'), runtime: z.literal('Claude Code'),
  type: z.literal('RESPONSE'),
  body: z.string().min(1).max(4000).refine((s) => s.trim().length > 0 && !/[\u0000-\u0009\u000b-\u001f\u007f]/.test(s)),
  timestamp: instant,
  observation: z.strictObject({
    source: z.literal('CLAUDE_CODE_LOCAL_TRANSCRIPT'), sessionId: uuid, eventId: uuid,
    eventType: z.literal('assistant.text'), receivedAt: instant,
    captureMode: z.enum(['HISTORY', 'LIVE_TAIL']),
    blockIndex: z.number().int().nonnegative(), partIndex: z.number().int().nonnegative(),
    partCount: z.number().int().positive(), textHash: sha,
  }),
});
export type ObservedEvent = z.infer<typeof observedEventSchema>;
const payloadSchema = z.strictObject({ projectId: z.string().regex(PROJECT_ID), events: z.array(observedEventSchema).max(10_000) });
const envelopeSchema = z.strictObject({ schemaVersion: z.literal(1), checksum: sha, payload: payloadSchema });
export class CollaborationStoreError extends Error {}

export function observationId(projectId: string, sessionId: string, eventId: string, blockIndex: number, partIndex: number): string {
  return `src-${hash(JSON.stringify([projectId, 'CLAUDE_CODE_LOCAL_TRANSCRIPT', sessionId, eventId, blockIndex, partIndex]))}`;
}

function eventOf(value: unknown, projectId: string): ObservedEvent {
  const result = observedEventSchema.safeParse(value);
  if (!result.success) throw new CollaborationStoreError('Invalid observed event');
  const e = result.data;
  const o = e.observation;
  if (e.projectId !== projectId || o.partIndex >= o.partCount ||
      e.id !== observationId(projectId, o.sessionId, o.eventId, o.blockIndex, o.partIndex)) {
    throw new CollaborationStoreError('Observed event identity mismatch');
  }
  return e;
}

export class FileCollaborationStore {
  readonly #directory: string;
  constructor(dataDirectory: string) { this.#directory = join(dataDirectory, 'collaboration'); }

  #file(projectId: string): string {
    if (!PROJECT_ID.test(projectId)) throw new CollaborationStoreError('Invalid project');
    return join(this.#directory, `${projectId}.events.json`);
  }

  #checkDirectory(): void {
    let s;
    try { s = lstatSync(this.#directory); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new CollaborationStoreError('Cannot inspect event directory');
    }
    if (!s.isDirectory() || s.isSymbolicLink()) throw new CollaborationStoreError('Event directory is not a real directory');
  }

  read(projectId: string): ObservedEvent[] {
    const file = this.#file(projectId);
    this.#checkDirectory();
    let s;
    try { s = lstatSync(file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new CollaborationStoreError('Cannot inspect event storage');
    }
    if (!s.isFile() || s.isSymbolicLink() || s.size > 64 * 1024 * 1024) throw new CollaborationStoreError('Invalid event file');
    let envelope;
    let fd: number | undefined;
    try {
      fd = openSync(file, 'r');
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.dev !== s.dev || opened.ino !== s.ino || opened.size > 64 * 1024 * 1024) {
        throw new CollaborationStoreError('Event file changed while reading');
      }
      envelope = envelopeSchema.parse(JSON.parse(readFileSync(fd, 'utf8')));
    }
    catch { throw new CollaborationStoreError('Event storage is unreadable or malformed'); }
    finally { if (fd !== undefined) closeSync(fd); }
    if (envelope.checksum !== hash(JSON.stringify(envelope.payload)) || envelope.payload.projectId !== projectId) {
      throw new CollaborationStoreError('Event checksum or project mismatch');
    }
    const seen = new Set<string>();
    return envelope.payload.events.map((raw) => {
      const event = eventOf(raw, projectId);
      if (seen.has(event.id)) throw new CollaborationStoreError('Repeated stored event identity');
      seen.add(event.id);
      return event;
    });
  }

  merge(projectId: string, input: readonly ObservedEvent[]): { added: number; duplicates: number } {
    const incoming = input.map((value) => eventOf(value, projectId));
    if (!incoming.length) { this.read(projectId); return { added: 0, duplicates: 0 }; }
    this.#checkDirectory();
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    this.#checkDirectory();
    const file = this.#file(projectId);
    const lock = `${file}.lock`;
    let fd: number;
    try { fd = openSync(lock, 'wx', 0o600); } catch { throw new CollaborationStoreError('Event store locked; nothing written'); }
    const owner = fstatSync(fd);
    let temp: string | undefined;
    try {
      const events = this.read(projectId);
      const byId = new Map(events.map((e) => [e.id, e]));
      const signature = (e: ObservedEvent) => JSON.stringify({ ...e, observation: { ...e.observation, receivedAt: null, captureMode: null } });
      let duplicates = 0;
      for (const e of incoming) {
        const prior = byId.get(e.id);
        if (prior) {
          if (signature(prior) !== signature(e)) throw new CollaborationStoreError('Existing event changed; nothing written');
          duplicates++;
        } else { byId.set(e.id, e); events.push(e); }
      }
      if (events.length > 10_000) throw new CollaborationStoreError('Event store limit reached');
      const actualAdded = incoming.length - duplicates;
      if (!actualAdded) return { added: 0, duplicates };
      const payload = payloadSchema.parse({ projectId, events });
      const serialized = JSON.stringify({ schemaVersion: 1, checksum: hash(JSON.stringify(payload)), payload });
      if (Buffer.byteLength(serialized) > 64 * 1024 * 1024) throw new CollaborationStoreError('Event store byte limit reached');
      temp = `${file}.${randomUUID()}.tmp`;
      const out = openSync(temp, 'wx', 0o600);
      try { writeFileSync(out, serialized); fsyncSync(out); }
      finally { closeSync(out); }
      renameSync(temp, file);
      temp = undefined;
      const directory = openSync(this.#directory, 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
      return { added: actualAdded, duplicates };
    } finally {
      if (temp) unlinkSync(temp);
      closeSync(fd);
      const current = lstatSync(lock);
      if (current.dev === owner.dev && current.ino === owner.ino) unlinkSync(lock);
    }
  }
}
