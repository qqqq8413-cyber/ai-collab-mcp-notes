import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { MAX_FAILURE_DETAIL_CHARS, MAX_OBJECTIVE_CHARS, MAX_REPORT_BYTES, MAX_TASKS, TASK_STATES, type TaskState } from './contract.js';

// M2-0 task queue. One small ledger (ledger.json) in a private directory, shared by the Workspace (the Human adds
// and cancels tasks) and the CHIEF MCP server (Claude Code claims and finishes them). Every change is one locked,
// checksummed, atomically renamed write, so two processes never both claim a task: a claim moves PENDING to RUNNING
// and hands out a random claimId; only that claimId can complete or fail the task, and a finished task never changes.
// There is no automatic retry or re-offer: a RUNNING task stays RUNNING until its claimer finishes it or the Human
// cancels it. This store holds no credential, no Authority record and no governed (EXE) state.

const instant = z.iso.datetime();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const code = z.string().regex(/^[A-Z0-9_]{1,64}$/);
const sourceSchema = z.strictObject({
  repository: z.string().min(1).max(200),
  workingDirectory: z.string().min(1).max(1024).regex(/^\//),
  commitSha: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  readme: z.literal('README.md'),
});
export type TaskSource = z.infer<typeof sourceSchema>;
const taskSchema = z.strictObject({
  taskId: z.string().uuid(),
  projectId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  objective: z.string().min(1).max(MAX_OBJECTIVE_CHARS),
  state: z.enum(TASK_STATES),
  createdAt: instant,
  createdBy: z.string().min(1).max(200),
  source: sourceSchema,
  claim: z.strictObject({ claimId: z.string().uuid(), claimedAt: instant, worker: z.string().min(1).max(100) }).nullable(),
  finishedAt: instant.nullable(),
  report: z.string().nullable(),
  reportSha256: digest.nullable(),
  failure: z.strictObject({ code, detail: z.string().max(MAX_FAILURE_DETAIL_CHARS) }).nullable(),
  events: z.array(z.strictObject({ at: instant, kind: z.enum(['CREATED', 'CLAIMED', 'COMPLETED', 'FAILED', 'CANCELLED']) })).max(10),
});
export type SubscriptionTask = z.infer<typeof taskSchema>;
const payloadSchema = z.strictObject({ tasks: z.array(taskSchema).max(MAX_TASKS) });
type Payload = z.infer<typeof payloadSchema>;
const envelopeSchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('CHIEF_M2_SUBSCRIPTION_TASKS'), payload: payloadSchema, checksum: digest });

export class TaskStoreError extends Error {
  constructor(readonly code: string, readonly state?: TaskState) { super(code); }
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const checksum = (payload: Payload) => sha256(JSON.stringify(payload));
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const uid = () => process.getuid?.();

/** Read one of this store's own files without following a symlink: a regular, private file owned by this user. */
function readOwnFile(path: string, maxBytes: number): Buffer | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new TaskStoreError('TASK_STORE_INTEGRITY'); }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || (st.mode & 0o077) || (uid() !== undefined && st.uid !== uid()) || st.size > maxBytes) throw new TaskStoreError('TASK_STORE_INTEGRITY');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

export interface NewTask { projectId: string; objective: string; createdBy: string; source: TaskSource; at: string }

export class SubscriptionTaskStore {
  readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.#check();
  }
  #check() {
    const st = lstatSync(this.directory);
    if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077) || (uid() !== undefined && st.uid !== uid())) throw new TaskStoreError('TASK_STORE_UNSAFE');
  }
  /** A consistent snapshot (writes are atomic renames, so a reader never needs the lock). */
  read(): Payload {
    this.#check();
    const data = readOwnFile(join(this.directory, 'ledger.json'), 32 * 1024 * 1024);
    if (data === null) return { tasks: [] };
    try {
      const envelope = envelopeSchema.parse(JSON.parse(data.toString('utf8')));
      if (checksum(envelope.payload) !== envelope.checksum || new Set(envelope.payload.tasks.map((t) => t.taskId)).size !== envelope.payload.tasks.length) throw new Error('checksum');
      for (const task of envelope.payload.tasks) if (task.report !== null && (Buffer.byteLength(task.report) > MAX_REPORT_BYTES || sha256(task.report) !== task.reportSha256)) throw new Error('report');
      return envelope.payload;
    } catch { throw new TaskStoreError('TASK_STORE_INTEGRITY'); }
  }
  list(projectId?: string): SubscriptionTask[] {
    return this.read().tasks.filter((task) => projectId === undefined || task.projectId === projectId);
  }
  /**
   * One locked read-modify-write. The lock is an exclusive file; a busy lock is retried for up to two seconds, then
   * refused. A lock left by a process that died is never removed here (fail closed): the Human removes write.lock.
   */
  #update<T>(fn: (data: Payload) => T): T {
    this.#check();
    const lock = join(this.directory, 'write.lock');
    let fd: number | undefined;
    for (let waited = 0; fd === undefined; waited += 25) {
      try { fd = openSync(lock, 'wx', 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (waited >= 2000) throw new TaskStoreError('TASK_STORE_BUSY');
        sleep(25);
      }
    }
    const owner = fstatSync(fd);
    let temp: string | undefined;
    try {
      writeFileSync(fd, String(process.pid));
      const data = this.read(), result = fn(data), parsed = payloadSchema.parse(data);
      temp = join(this.directory, `${randomUUID()}.tmp`);
      const out = openSync(temp, 'wx', 0o600);
      try { writeFileSync(out, JSON.stringify({ schemaVersion: 1, kind: 'CHIEF_M2_SUBSCRIPTION_TASKS', payload: parsed, checksum: checksum(parsed) })); fsyncSync(out); }
      finally { closeSync(out); }
      renameSync(temp, join(this.directory, 'ledger.json')); temp = undefined;
      const dir = openSync(this.directory, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
      return result;
    } finally {
      if (temp) unlinkSync(temp);
      closeSync(fd);
      const st = lstatSync(lock);
      if (st.ino === owner.ino && st.dev === owner.dev) unlinkSync(lock);
    }
  }
  #find(data: Payload, taskId: string): SubscriptionTask {
    const task = data.tasks.find((t) => t.taskId === taskId);
    if (!task) throw new TaskStoreError('UNKNOWN_TASK');
    return task;
  }
  create(input: NewTask): SubscriptionTask {
    const objective = input.objective.trim();
    if (!objective) throw new TaskStoreError('OBJECTIVE_REQUIRED');
    if (objective.length > MAX_OBJECTIVE_CHARS) throw new TaskStoreError('OBJECTIVE_TOO_LONG');
    const task = taskSchema.parse({ taskId: randomUUID(), projectId: input.projectId, objective, state: 'PENDING', createdAt: input.at,
      createdBy: input.createdBy, source: input.source, claim: null, finishedAt: null, report: null, reportSha256: null, failure: null,
      events: [{ at: input.at, kind: 'CREATED' }] });
    return this.#update((data) => {
      if (data.tasks.length >= MAX_TASKS) throw new TaskStoreError('TASK_LIMIT');
      data.tasks.push(task);
      return structuredClone(task);
    });
  }
  /** The oldest PENDING task, or null. Read only: offering a task does not reserve it. */
  next(projectId?: string): SubscriptionTask | null {
    return this.list(projectId).find((task) => task.state === 'PENDING') ?? null;
  }
  /** PENDING -> RUNNING exactly once. Returns the task and the claimId that alone can finish it. */
  claim(taskId: string, worker: string, at: string): { task: SubscriptionTask; claimId: string } {
    return this.#update((data) => {
      const task = this.#find(data, taskId);
      if (task.state !== 'PENDING') throw new TaskStoreError('TASK_NOT_PENDING', task.state);
      const claimId = randomUUID();
      Object.assign(task, { state: 'RUNNING', claim: { claimId, claimedAt: at, worker } });
      task.events.push({ at, kind: 'CLAIMED' });
      return { task: structuredClone(task), claimId };
    });
  }
  #running(data: Payload, taskId: string, claimId: string): SubscriptionTask {
    const task = this.#find(data, taskId);
    if (task.state !== 'RUNNING') throw new TaskStoreError('TASK_NOT_RUNNING', task.state);
    if (task.claim?.claimId !== claimId) throw new TaskStoreError('CLAIM_MISMATCH', task.state);
    return task;
  }
  complete(taskId: string, claimId: string, report: string, at: string): SubscriptionTask {
    if (!report.trim()) throw new TaskStoreError('REPORT_REQUIRED');
    if (Buffer.byteLength(report) > MAX_REPORT_BYTES) throw new TaskStoreError('REPORT_TOO_LARGE');
    return this.#update((data) => {
      const task = this.#running(data, taskId, claimId);
      Object.assign(task, { state: 'COMPLETED', finishedAt: at, report, reportSha256: sha256(report) });
      task.events.push({ at, kind: 'COMPLETED' });
      return structuredClone(task);
    });
  }
  fail(taskId: string, claimId: string, reason: string, detail: string, at: string): SubscriptionTask {
    if (!/^[A-Z0-9_]{1,64}$/.test(reason)) throw new TaskStoreError('REASON_INVALID');
    return this.#update((data) => {
      const task = this.#running(data, taskId, claimId);
      Object.assign(task, { state: 'FAILED', finishedAt: at, failure: { code: reason, detail: detail.slice(0, MAX_FAILURE_DETAIL_CHARS) } });
      task.events.push({ at, kind: 'FAILED' });
      return structuredClone(task);
    });
  }
  /** The Human stops a task that has not finished. A later complete or fail with the old claimId is refused. */
  cancel(taskId: string, at: string): SubscriptionTask {
    return this.#update((data) => {
      const task = this.#find(data, taskId);
      if (task.state !== 'PENDING' && task.state !== 'RUNNING') throw new TaskStoreError('TASK_ALREADY_FINISHED', task.state);
      Object.assign(task, { state: 'CANCELLED', finishedAt: at });
      task.events.push({ at, kind: 'CANCELLED' });
      return structuredClone(task);
    });
  }
}
