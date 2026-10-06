import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { PROJECT_ID, humanPrincipalSchema, parseHumanPrincipalV1, type HumanPrincipalV1 } from './config.js';

// The Workspace goal queue. A goal here is LOCAL OPERATOR INPUT submitted through
// the local Workspace. It is NON-AUTHORITATIVE and NOT STARTED. It carries no run,
// change, packet, or authorization identity, and nothing in this module can start
// execution. It is a separate store from the Controller's; it never reads or writes
// Controller files.
//
// One file per project holds the queue and its append-only history. The queue is
// derived from the history: every read replays the history and must arrive at exactly
// the stored queue, so a hand-edited or partially written file fails closed. Writes
// follow the Controller store's durability pattern: an exclusive lock file, a checksummed
// envelope written to a temporary file, fsync, rename, then a directory fsync.

const SCHEMA_VERSION = 1;
const KIND = 'chief.workspace.goal-queue';
export const MAX_GOAL_TEXT = 2000;
export const MAX_QUEUED_GOALS = 200;
const MAX_HISTORY = 10_000;

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const instant = z.string().refine((value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  new Date(value).toISOString() === value, 'must be a UTC ISO-8601 instant with milliseconds');
const goalId = z.string().regex(/^goal-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
// Running text: newlines and tabs are kept, other control characters are refused.
const goalText = z.string().refine((value) => value.trim().length > 0 && value.length <= MAX_GOAL_TEXT &&
  !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value), `goal text must be 1-${MAX_GOAL_TEXT} characters without control characters`);

const goalSchema = z.strictObject({
  goalId,
  projectId: z.string().regex(PROJECT_ID),
  text: goalText,
  createdAt: instant,
  status: z.literal('QUEUED'),
  classification: z.literal('LOCAL_OPERATOR_INPUT'),
  authority: z.literal('NON_AUTHORITATIVE'),
  execution: z.literal('NOT_STARTED'),
  submittedBy: humanPrincipalSchema.nullable().optional(),
});
export type GoalRecord = Omit<z.infer<typeof goalSchema>, 'submittedBy'> & { submittedBy: HumanPrincipalV1 | null };

const eventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ sequence: z.number().int().positive(), at: instant, kind: z.literal('GOAL_ADDED'),
    goal: z.strictObject({ goalId, text: goalText, createdAt: instant, submittedBy: humanPrincipalSchema.optional() }) }),
  z.strictObject({ sequence: z.number().int().positive(), at: instant, kind: z.literal('QUEUE_REORDERED'), order: z.array(goalId).max(MAX_QUEUED_GOALS) }),
  z.strictObject({ sequence: z.number().int().positive(), at: instant, kind: z.literal('GOAL_REMOVED'), goalId }),
]);
export type QueueEvent = z.infer<typeof eventSchema>;

const queueSchema = z.strictObject({
  kind: z.literal(KIND),
  projectId: z.string().regex(PROJECT_ID),
  revision: z.number().int().nonnegative(),
  goals: z.array(goalSchema).max(MAX_QUEUED_GOALS),
  history: z.array(eventSchema).max(MAX_HISTORY),
});
export type GoalQueue = Omit<z.infer<typeof queueSchema>, 'goals'> & { goals: GoalRecord[] };

/** The stored queue failed validation: unreadable, tampered with, or not replayable. Nothing is repaired. */
export class GoalStoreIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoalStoreIntegrityError';
  }
}

/** A request the queue refuses (unknown goal, wrong order, full queue). Nothing was written. */
export class GoalQueueRequestError extends Error {
  constructor(readonly code: 'UNKNOWN_GOAL' | 'BAD_ORDER' | 'QUEUE_FULL' | 'STALE_REVISION' | 'BAD_TEXT', message: string) {
    super(message);
    this.name = 'GoalQueueRequestError';
  }
}

function goalOf(projectId: string, added: Extract<QueueEvent, { kind: 'GOAL_ADDED' }>['goal']): GoalRecord {
  return { goalId: added.goalId, projectId, text: added.text, createdAt: added.createdAt, status: 'QUEUED',
    classification: 'LOCAL_OPERATOR_INPUT', authority: 'NON_AUTHORITATIVE', execution: 'NOT_STARTED',
    submittedBy: added.submittedBy ?? null };
}

/** The queue that a history produces, or why it cannot. Pure: the same history always gives the same queue. */
export function replayHistory(projectId: string, history: readonly QueueEvent[]): GoalRecord[] {
  let goals: GoalRecord[] = [];
  const seen = new Set<string>();
  let last = '';
  history.forEach((event, index) => {
    if (event.sequence !== index + 1) throw new GoalStoreIntegrityError(`history sequence ${event.sequence} at position ${index + 1}`);
    if (event.at < last) throw new GoalStoreIntegrityError(`history time goes backwards at sequence ${event.sequence}`);
    last = event.at;
    if (event.kind === 'GOAL_ADDED') {
      if (seen.has(event.goal.goalId)) throw new GoalStoreIntegrityError(`goal ${event.goal.goalId} added twice`);
      if (goals.length >= MAX_QUEUED_GOALS) throw new GoalStoreIntegrityError('queue exceeds its bound');
      seen.add(event.goal.goalId);
      goals.push(goalOf(projectId, event.goal));
    } else if (event.kind === 'QUEUE_REORDERED') {
      const current = goals.map((goal) => goal.goalId);
      if (!isPermutation(event.order, current)) throw new GoalStoreIntegrityError(`reorder at sequence ${event.sequence} is not a permutation of the queue`);
      const byId = new Map(goals.map((goal) => [goal.goalId, goal]));
      goals = event.order.map((id) => byId.get(id)!);
    } else {
      if (!goals.some((goal) => goal.goalId === event.goalId)) throw new GoalStoreIntegrityError(`removal of goal ${event.goalId} that is not queued`);
      goals = goals.filter((goal) => goal.goalId !== event.goalId);
    }
  });
  return goals;
}

function isPermutation(order: readonly string[], current: readonly string[]): boolean {
  return order.length === current.length && new Set(order).size === order.length && order.every((id) => current.includes(id));
}

function emptyQueue(projectId: string): GoalQueue {
  return { kind: KIND, projectId, revision: 0, goals: [], history: [] };
}

/** Full validation of a stored queue: schema, identity, revision, and a replay that must match the stored queue exactly. */
export function validateQueue(value: unknown, projectId: string): GoalQueue {
  const parsed = queueSchema.safeParse(value);
  if (!parsed.success) throw new GoalStoreIntegrityError(`queue does not match its schema: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  const queue = parsed.data;
  if (queue.projectId !== projectId) throw new GoalStoreIntegrityError('queue belongs to another project');
  if (queue.revision !== queue.history.length) throw new GoalStoreIntegrityError('queue revision does not match its history');
  const replayed = replayHistory(projectId, queue.history);
  const goals = queue.goals.map((goal) => ({ ...goal, submittedBy: goal.submittedBy ?? null }));
  if (JSON.stringify(replayed) !== JSON.stringify(goals)) throw new GoalStoreIntegrityError('queue does not equal the replay of its history');
  return { ...queue, goals };
}

export interface GoalStoreOptions {
  clock?: { now(): string };
  newGoalId?: () => string;
}

export interface QueueChange {
  queue: GoalQueue;
  event: QueueEvent;
}

export class FileGoalStore {
  readonly #directory: string;
  readonly #now: () => string;
  readonly #newGoalId: () => string;

  constructor(directory: string, options: GoalStoreOptions = {}) {
    if (typeof directory !== 'string' || !directory.trim()) throw new Error('Goal store directory required');
    this.#directory = resolve(directory);
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    const clock = options.clock;
    this.#now = () => instant.parse(clock ? clock.now() : new Date().toISOString());
    this.#newGoalId = options.newGoalId ?? (() => `goal-${randomUUID()}`);
    Object.freeze(this);
  }

  #file(projectId: string): string {
    if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId)) throw new Error('Invalid projectId');
    return join(this.#directory, `${projectId}.queue.json`);
  }

  #load(projectId: string): GoalQueue {
    const file = this.#file(projectId);
    if (!existsSync(file)) return emptyQueue(projectId);
    let envelope: unknown;
    try { envelope = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new GoalStoreIntegrityError('goal queue file is not JSON'); }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
        Object.keys(envelope).sort().join(',') !== 'checksum,queue,schemaVersion') {
      throw new GoalStoreIntegrityError('invalid goal queue envelope');
    }
    const stored = envelope as { schemaVersion: unknown; checksum: unknown; queue: unknown };
    if (stored.schemaVersion !== SCHEMA_VERSION) throw new GoalStoreIntegrityError('unsupported goal queue schema version');
    if (typeof stored.checksum !== 'string' || stored.checksum !== digest(JSON.stringify(stored.queue))) {
      throw new GoalStoreIntegrityError('goal queue checksum mismatch');
    }
    return validateQueue(stored.queue, projectId);
  }

  // A leftover lock is an uncertain writer: it is never removed by anyone but its creator.
  #locked<T>(projectId: string, action: () => T): T {
    const lock = `${this.#file(projectId)}.lock`;
    let fd: number;
    try { fd = openSync(lock, 'wx', 0o600); } catch { throw new GoalStoreIntegrityError('goal queue is locked by another writer'); }
    const identity = fstatSync(fd);
    try {
      return action();
    } finally {
      closeSync(fd);
      const current = lstatSync(lock);
      if (current.dev !== identity.dev || current.ino !== identity.ino) throw new GoalStoreIntegrityError('goal queue lock ownership changed');
      unlinkSync(lock);
    }
  }

  #write(projectId: string, queue: GoalQueue): void {
    const target = this.#file(projectId);
    const temp = `${target}.${randomUUID()}.tmp`;
    const payload = JSON.stringify(queue);
    const serialized = JSON.stringify({ schemaVersion: SCHEMA_VERSION, queue: JSON.parse(payload), checksum: digest(payload) });
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

  // Every mutation appends exactly one event to the history read under the lock, and the
  // result is validated by full replay before it is written.
  #append(projectId: string, build: (queue: GoalQueue, at: string) => QueueEvent, expectedRevision?: number): QueueChange {
    return this.#locked(projectId, () => {
      const current = this.#load(projectId);
      if (expectedRevision !== undefined && expectedRevision !== current.revision) {
        throw new GoalQueueRequestError('STALE_REVISION', `the queue changed (revision ${current.revision}); reload and try again`);
      }
      if (current.history.length >= MAX_HISTORY) throw new GoalQueueRequestError('QUEUE_FULL', 'the queue history is full');
      const at = this.#now();
      const previous = current.history.at(-1)?.at;
      const event = build(current, previous && previous > at ? previous : at);
      const history = [...current.history, event];
      const next = validateQueue({ kind: KIND, projectId, revision: history.length, goals: replayHistory(projectId, history), history }, projectId);
      this.#write(projectId, next);
      return { queue: structuredClone(next), event: structuredClone(event) };
    });
  }

  read(projectId: string): GoalQueue {
    return structuredClone(this.#load(projectId));
  }

  addGoal(projectId: string, text: unknown, submittedBy: HumanPrincipalV1): QueueChange {
    const parsed = goalText.safeParse(typeof text === 'string' ? text.trim() : text);
    if (!parsed.success) throw new GoalQueueRequestError('BAD_TEXT', parsed.error.issues[0]?.message ?? 'invalid goal text');
    const principal = parseHumanPrincipalV1(submittedBy);
    return this.#append(projectId, (queue, at) => {
      if (queue.goals.length >= MAX_QUEUED_GOALS) throw new GoalQueueRequestError('QUEUE_FULL', `a project can queue at most ${MAX_QUEUED_GOALS} goals`);
      const id = goalId.parse(this.#newGoalId());
      if (queue.history.some((event) => event.kind === 'GOAL_ADDED' && event.goal.goalId === id)) throw new Error('Goal id collision');
      return { sequence: queue.history.length + 1, at, kind: 'GOAL_ADDED',
        goal: { goalId: id, text: parsed.data, createdAt: at, submittedBy: principal } };
    });
  }

  reorder(projectId: string, order: unknown, expectedRevision?: number): QueueChange {
    const ids = z.array(goalId).max(MAX_QUEUED_GOALS).safeParse(order);
    if (!ids.success) throw new GoalQueueRequestError('BAD_ORDER', 'order must list goal ids');
    return this.#append(projectId, (queue, at) => {
      if (!isPermutation(ids.data, queue.goals.map((goal) => goal.goalId))) {
        throw new GoalQueueRequestError('BAD_ORDER', 'order must list every queued goal exactly once');
      }
      return { sequence: queue.history.length + 1, at, kind: 'QUEUE_REORDERED', order: [...ids.data] };
    }, expectedRevision);
  }

  /** Removes a goal that has never started. In WS-L1 no goal can start, so every queued goal qualifies. */
  removeGoal(projectId: string, id: unknown): QueueChange {
    const parsed = goalId.safeParse(id);
    if (!parsed.success) throw new GoalQueueRequestError('UNKNOWN_GOAL', 'unknown goal');
    return this.#append(projectId, (queue, at) => {
      const goal = queue.goals.find((item) => item.goalId === parsed.data);
      if (!goal) throw new GoalQueueRequestError('UNKNOWN_GOAL', 'unknown goal');
      if (goal.execution !== 'NOT_STARTED') throw new GoalQueueRequestError('UNKNOWN_GOAL', 'only a goal that never started can be removed');
      return { sequence: queue.history.length + 1, at, kind: 'GOAL_REMOVED', goalId: parsed.data };
    });
  }
}
Object.freeze(FileGoalStore);
Object.freeze(FileGoalStore.prototype);
