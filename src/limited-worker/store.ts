import { randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { parseContract, hash, type Contract } from './contract.js';
import { parsePreflight } from './transport.js';

const instant = z.iso.datetime(), digest = z.string().regex(/^[a-f0-9]{64}$/);
const jobSchema = z.strictObject({ id: digest, contract: z.unknown().transform(parseContract), createdAt: instant,
  state: z.enum(['PREPARED', 'RUNNING', 'COMPLETED', 'BLOCKED', 'CANCELLED', 'TIMED_OUT', 'UNCERTAIN', 'FAILED']),
  evidenceClass: z.enum(['LIVE_PROVIDER', 'OFFLINE_SYNTHETIC']), invocationId: digest.nullable(), reason: z.string().max(300).nullable(),
  reservedMicroUsd: z.number().int().nonnegative(), generationClaimed: z.boolean(),
  report: z.string().max(65536).nullable(), reportHash: digest.nullable(), actualCostMicroUsd: z.number().int().nonnegative().nullable(),
  modelPreflight: z.unknown().transform(parsePreflight).nullable().optional(), providerMessageId: z.string().min(1).max(200).nullable().optional(),
  usage: z.strictObject({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }).nullable(),
  events: z.array(z.strictObject({ at: instant, kind: z.string().max(100) })).max(100) });
export type Job = z.infer<typeof jobSchema>;
const observationSchema=z.strictObject({id:z.string().uuid(),projectId:z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),at:instant,
  kind:z.enum(['SETUP_OPENED','TASK_FORM_STARTED','PLAN_READY','PLAN_REUSED','CHECK','START_REFUSED','CANCEL','RECONCILIATION_REQUESTED','RUNTIME_START']),
  interactionId:z.string().uuid().nullable(),jobId:digest.nullable(),reason:z.string().regex(/^[A-Z0-9_]{1,100}$/).nullable(),
  evidenceClass:z.enum(['LOCAL_OBSERVATION','OFFLINE_SYNTHETIC']),clientElapsedMs:z.number().int().min(0).max(86400000).nullable()});
export type Observation=z.infer<typeof observationSchema>;
const payload = z.strictObject({ jobs: z.array(jobSchema).max(100), ceilingMicroUsd: z.literal(1000000),
  observations:z.array(observationSchema).max(2000).optional(),observationsDropped:z.number().int().nonnegative().optional() });
const envelope = z.strictObject({ schemaVersion: z.literal(1), payload, checksum: digest });
const leaseSchema = z.strictObject({ pid: z.number().int().min(1), nonce: z.string().uuid() });
/** Any live process with this pid counts, including a reused pid: such a lease is BUSY, never taken over. */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

export class WorkerStore {
  readonly directory: string;
  constructor(directory: string) {
    this.directory = directory; mkdirSync(directory, { recursive: true, mode: 0o700 }); this.#check();
  }
  #check() { const s = lstatSync(this.directory); if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o077)) throw new Error('WORKER_STORAGE_UNSAFE'); }
  identity(): string { this.#check(); const s = lstatSync(this.directory); return hash([realpathSync(this.directory), s.dev, s.ino]); }
  /**
   * The Host's exclusive runtime lease (S1). A held lease names its owner's pid and a random nonce, and it is always
   * complete: it is written to a private temp file, fsynced and published with one exclusive link(2), so a crash can
   * never leave an empty or partial lease. A lease whose owner is alive (or whose pid now belongs to any live process,
   * PID reuse included) is BUSY and is never touched. A lease whose owner is dead is taken over only by the one process
   * that wins that exact stale lease's takeover token (one exclusive file per stale nonce); the winner re-reads the
   * lease and replaces it only while it is still that same stale record, by an atomic rename, so no process can ever
   * remove or replace a lease another process has just acquired. Anything it cannot prove (an unreadable record, a
   * token left by a takeover that died) fails closed as BUSY or UNCERTAIN; nothing is forced. Release removes the lease
   * only while it still carries this holder's nonce. `hooks` exist only for deterministic interleaving tests.
   */
  lease(hooks?: { beforeTakeover?(): void }): () => void {
    this.#check();
    const file = join(this.directory, 'runtime.lock'), nonce = randomUUID();
    const temp = join(this.directory, `runtime.lock.${nonce}.tmp`);
    const out = openSync(temp, 'wx', 0o600);
    try { writeFileSync(out, JSON.stringify({ pid: process.pid, nonce })); fsyncSync(out); } finally { closeSync(out); }
    try {
      let acquired = false;
      try { linkSync(temp, file); acquired = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      if (!acquired) this.#takeOver(file, temp, hooks);
      const dir = openSync(this.directory, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
    } finally { try { unlinkSync(temp); } catch { /* already renamed into place */ } }
    return () => {
      let current: { nonce: string } | null;
      try { current = this.#leaseRecord(file); } catch { return; } // unreadable: left in place (fail closed)
      if (current?.nonce === nonce) unlinkSync(file);
    };
  }
  #takeOver(file: string, temp: string, hooks?: { beforeTakeover?(): void }) {
    const prior = this.#leaseRecord(file);
    // Missing: its holder released it between our link and this read. No waiting: the caller retries.
    if (!prior || alive(prior.pid)) throw new Error('WORKER_LEASE_BUSY');
    hooks?.beforeTakeover?.();
    const token = join(this.directory, `runtime.lock.takeover-${prior.nonce}`);
    let tokenFd: number;
    try { tokenFd = openSync(token, 'wx', 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('WORKER_LEASE_BUSY'); throw error; }
    // done: the stale lease was replaced, or it is already gone (only this token's holder can ever replace that exact
    // stale nonce, and a nonce is never reused), so the token guards nothing and is removed. Any other failure keeps
    // the token: that stale lease is then refused (fail closed) until a Human recovers it.
    let done = false;
    try {
      writeFileSync(tokenFd, readFileSync(temp)); fsyncSync(tokenFd);
      const current = this.#leaseRecord(file);
      if (current?.nonce !== prior.nonce) { done = true; throw new Error('WORKER_LEASE_BUSY'); }
      renameSync(temp, file); done = true;
    } finally {
      closeSync(tokenFd);
      if (done) unlinkSync(token);
    }
  }
  /** The lease record, or null when there is none. Anything unreadable or malformed is UNCERTAIN. */
  #leaseRecord(file: string): { pid: number; nonce: string } | null {
    let fd: number | undefined;
    try {
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > 500) throw new Error('WORKER_LEASE_UNCERTAIN');
      const parsed = leaseSchema.safeParse(JSON.parse(readFileSync(fd, 'utf8')));
      if (!parsed.success) throw new Error('WORKER_LEASE_UNCERTAIN');
      return parsed.data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('WORKER_LEASE_UNCERTAIN');
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  writeReport(c: Contract, report: string): string {
    if (c.storageIdentity !== this.identity() || Buffer.byteLength(report) > 65536) throw new Error('REPORT_SCOPE_LIMIT');
    const directory = join(this.directory, c.outputKey); mkdirSync(directory, { mode: 0o700 });
    const st = lstatSync(directory); if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('REPORT_SCOPE_LIMIT');
    const path = join(directory, 'report.md'), fd = openSync(path, 'wx', 0o600);
    try { writeFileSync(fd, report); fsyncSync(fd); } finally { closeSync(fd); }
    const dir = openSync(directory, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
    return hash(report);
  }
  reportIsValid(job: Job): boolean {
    if (!job.reportHash || typeof job.report!=='string' || hash(job.report)!==job.reportHash || job.contract.storageIdentity !== this.identity()) return false;
    let fd: number | undefined;
    try {
      const dir = join(this.directory, job.contract.outputKey), st = lstatSync(dir);
      if (!st.isDirectory() || st.isSymbolicLink()) return false;
      fd = openSync(join(dir, 'report.md'), constants.O_RDONLY | constants.O_NOFOLLOW);
      const file = fstatSync(fd); return file.isFile() && file.size <= 65536 && hash(readFileSync(fd)) === job.reportHash;
    } catch { return false; } finally { if (fd !== undefined) closeSync(fd); }
  }
  read():z.infer<typeof payload> {
    this.#check(); let fd: number | undefined;
    try {
      fd = openSync(join(this.directory, 'ledger.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
      const st = fstatSync(fd); if (!st.isFile() || st.size > 16 * 1024 * 1024) throw new Error('WORKER_STORAGE_INTEGRITY');
      const v = envelope.parse(JSON.parse(readFileSync(fd, 'utf8')));
      if (hash(v.payload) !== v.checksum || new Set(v.payload.jobs.map(j => j.id)).size !== v.payload.jobs.length ||
        v.payload.jobs.some(j => hash(j.contract) !== j.id) || v.payload.jobs.reduce((sum, j) => sum + j.reservedMicroUsd, 0) > 1000000) throw new Error('WORKER_STORAGE_INTEGRITY');
      return v.payload;
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { jobs: [], ceilingMicroUsd: 1000000 }; throw new Error('WORKER_STORAGE_INTEGRITY'); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  update<T>(fn: (data: ReturnType<WorkerStore['read']>) => T): T {
    this.#check(); const lock = join(this.directory, 'write.lock');
    // A held or leftover write.lock stops every ledger write (fail closed); it is never removed here. Recovery of a
    // leftover lock is a documented Human step (AUTO_P2_A4_P0_S1_ARCHITECT_REVIEW.md), never automatic.
    let fd: number;
    try { fd = openSync(lock, 'wx', 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('WORKER_STORE_WRITE_LOCK_HELD'); throw error; }
    const owner = fstatSync(fd);
    let temp: string | undefined;
    try {
      const data = this.read(), result = fn(data), parsed = payload.parse(data);
      if (parsed.jobs.reduce((s,j) => s + j.reservedMicroUsd, 0) > 1000000) throw new Error('TOTAL_COST_LIMIT');
      temp = join(this.directory, randomUUID() + '.tmp'); const out = openSync(temp, 'wx', 0o600);
      try { writeFileSync(out, JSON.stringify({ schemaVersion: 1, payload: parsed, checksum: hash(parsed) })); fsyncSync(out); } finally { closeSync(out); }
      renameSync(temp, join(this.directory, 'ledger.json')); temp = undefined;
      const dir = openSync(this.directory, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
      return result;
    } finally { if (temp) unlinkSync(temp); closeSync(fd); const st = lstatSync(lock); if (st.ino === owner.ino && st.dev === owner.dev) unlinkSync(lock); }
  }
  create(contract: Contract, at: string): Job {
    const id = hash(contract);
    return this.update(d => {
      const prior = d.jobs.find(j => j.id === id); if (prior) return structuredClone(prior);
      if (d.jobs.length >= 100) throw new Error('JOB_LIMIT');
      const job = jobSchema.parse({ id, contract, createdAt: at, state: 'PREPARED', evidenceClass: 'LIVE_PROVIDER', invocationId: null,
        reason: null, reservedMicroUsd: 0, generationClaimed: false, report: null, reportHash: null, usage: null, actualCostMicroUsd: null, modelPreflight: null, providerMessageId: null,
        events: [{ at, kind: 'PREPARED_NO_EXECUTION' }] }); d.jobs.push(job); return structuredClone(job);
    });
  }
  change(id: string, fn: (job: Job) => void) { return this.update(d => { const j = d.jobs.find(j => j.id === id); if (!j) throw new Error('UNKNOWN_JOB'); fn(j); return structuredClone(j); }); }
  observe(input:Observation) {
    const item=observationSchema.parse(input);
    return this.update(d=>{const observations=d.observations??=[];const prior=observations.find(o=>o.id===item.id);
      if(prior){const {at:_,...left}=prior,{at:__,...right}=item;if(hash(left)!==hash(right))throw new Error('OBSERVATION_ID_CONFLICT');return structuredClone(prior);}
      if(observations.length===2000){observations.shift();d.observationsDropped=(d.observationsDropped??0)+1;}
      observations.push(item);return structuredClone(item);
    });
  }
  reserve(id: string, amount: number, invocationId: string, at: string, synthetic: boolean) {
    return this.update(d => {
      const j = d.jobs.find(j => j.id === id); if (!j || j.state !== 'PREPARED' || j.invocationId || j.reservedMicroUsd) throw new Error('REQUEST_NOT_REPLAYABLE');
      if (j.contract.storageIdentity !== this.identity() || d.jobs.some(other => other.id !== id && other.contract.runId === j.contract.runId && other.invocationId)) throw new Error('RUN_ALREADY_CLAIMED_OR_STORAGE_MOVED');
      if (!Number.isSafeInteger(amount) || amount <= 0 || amount > j.contract.maxCostMicroUsd || d.jobs.reduce((s,j) => s+j.reservedMicroUsd,0)+amount > d.ceilingMicroUsd) throw new Error('TOTAL_COST_LIMIT');
      if (d.jobs.some(j => j.state === 'RUNNING')) throw new Error('SINGLE_WORKER_BUSY');
      Object.assign(j, { state: 'RUNNING', invocationId, reservedMicroUsd: amount, evidenceClass: synthetic ? 'OFFLINE_SYNTHETIC' : 'LIVE_PROVIDER' });
      j.events.push({ at, kind: 'WORST_CASE_RESERVED' }); return structuredClone(j);
    });
  }
  recover(at: string) {
    if (!this.read().jobs.some(j => j.state === 'RUNNING')) return;
    this.update(d => { for (const j of d.jobs.filter(j => j.state === 'RUNNING')) { j.state = 'UNCERTAIN'; j.reason = 'PROCESS_INTERRUPTED_NO_REPLAY'; j.events.push({ at, kind: 'UNCERTAIN_NO_REPLAY' }); } });
  }
}
