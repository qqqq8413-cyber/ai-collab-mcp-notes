import { randomUUID } from 'node:crypto';
import { AutomationRequestError, type AutomationPort } from '../workspace/automation-port.js';
import { actionInput, ciSchema, LIMITS, REPOSITORY, taskInput, type CiRun, type PilotData, type PilotRun, type Task } from './model.js';
import { digest, PilotStore } from './store.js';
import type { CiReader } from './github.js';

function refuse(code: string, message: string, status = 409): never { throw new AutomationRequestError(code, status, message); }
const changedSignature = (run: CiRun) => digest({ ...run, updatedAt: null, jobs: [...run.jobs].sort((a, b) => a.id - b.id) });
const stateText = (r: CiRun) => `${r.status} / ${r.conclusion ?? '—'} | ${r.jobs.map(j => `${j.name}:${j.conclusion ?? j.status}`).join(', ')}`.slice(0, 150);
const failuresOf = (snapshot: CiRun[]): string[] => snapshot.flatMap(r => {
  const failed = r.jobs.filter(j => j.requiredMacSkip || ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure'].includes(j.conclusion ?? ''));
  const items = failed.map(j => `#${r.number} ${j.name}: ${j.conclusion ?? j.status}${j.requiredMacSkip ? ' (required macOS skip)' : ''}`.slice(0, 500));
  if (!items.length && r.status === 'completed' && r.conclusion !== 'success') items.push(`#${r.number}: ${r.conclusion ?? 'UNKNOWN_CONCLUSION'}`);
  return items;
}).slice(0, 100);

export class PilotEngine implements AutomationPort {
  readonly #store: PilotStore;
  readonly #release: () => void;
  readonly #projects: Set<string>;
  readonly #clock: () => number;
  readonly #reader: CiReader;
  readonly #timeoutMs: number;
  #timer?: ReturnType<typeof setInterval>;
  #active?: { projectId: string; runId: string; abort: AbortController };
  #draining?: Promise<void>;
  #closed = false;
  #fault: string | null = null;

  constructor(options: { dataDirectory: string; projects: string[]; reader: CiReader; clock?: () => number; timeoutMs?: number }) {
    this.#timeoutMs = options.timeoutMs ?? LIMITS.timeoutMs;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > LIMITS.timeoutMs) throw new Error('Invalid bounded timeout');
    this.#store = new PilotStore(options.dataDirectory);
    this.#projects = new Set(options.projects);
    this.#clock = options.clock ?? Date.now;
    this.#reader = options.reader;
    this.#release = this.#store.lease();
    try {
      for (const id of this.#projects) {
        const data = this.#store.read(id);
        let recovered = false;
        for (const run of data.runs.filter(r => r.state === 'RUNNING')) {
          run.state = 'FAILED'; run.error = 'PROCESS_INTERRUPTED_NO_AUTOMATIC_REPLAY'; run.endedAt = this.#now();
          this.#task(data, run.taskId).state = 'FAILED'; recovered = true;
        }
        if (recovered) this.#save(data);
      }
    } catch (e) { this.#release(); throw e; }
  }
  #now(): string { return new Date(this.#clock()).toISOString(); }
  #data(id: string): PilotData {
    if (!this.#projects.has(id)) refuse('UNKNOWN_PROJECT', '未知專案。', 404);
    return this.#store.read(id);
  }
  #task(data: PilotData, id: string): Task { return data.tasks.find(t => t.id === id) ?? refuse('UNKNOWN_TASK', '找不到自動化工作。', 404); }
  #save(data: PilotData): void {
    data.revision++;
    const terminal = data.runs.filter(r => r.state !== 'RUNNING' && r.state !== 'QUEUED');
    const remove = new Set(terminal.slice(0, Math.max(0, data.runs.length - LIMITS.history)).map(r => r.id));
    data.runs = data.runs.filter(r => !remove.has(r.id));
    data.changes = data.changes.slice(-LIMITS.changes);
    data.operations = data.operations.slice(-LIMITS.history);
    data.readStarts = data.readStarts.filter(at => Date.parse(at) > this.#clock() - 3600000);
    data.ci = data.ci.slice(-LIMITS.ciRuns);
    this.#store.write(data);
  }
  read(projectId: string): unknown {
    return { recordKind: 'OPERATIONAL_RECORD', authority: 'NON_AUTHORITATIVE', repository: REPOSITORY,
      exe: 'HOLD', aiExecution: 'LOCKED', modelCalls: 0, limits: LIMITS, fault: this.#fault,
      capabilities: { CI_WATCH: 'AUTHORIZED_READ_ONLY', CI_REPORT: 'AUTHORIZED_LOCAL_READ_ONLY', AI_WORK: 'HOLD' },
      ...this.#data(projectId) };
  }
  create(projectId: string, input: unknown): unknown {
    if (this.#closed || this.#fault) refuse('PILOT_STOPPED', '自動化已停止，請檢查服務。');
    const parsed = taskInput.safeParse(input);
    if (!parsed.success) refuse('INVALID_TASK', '工作類型、來源或設定不在允許範圍。', 400);
    const spec = parsed.data;
    const data = this.#data(projectId);
    const existing = data.tasks.find(t => t.id === spec.requestId);
    if (existing) {
      if (digest(taskInput.parse(Object.fromEntries(Object.keys(spec).map(k => [k, existing[k as keyof Task]])))) !== digest(spec)) refuse('REQUEST_CONFLICT', '相同請求識別對應不同設定。');
      return this.read(projectId);
    }
    if (data.tasks.length >= LIMITS.tasks) refuse('TASK_LIMIT', '工作數量已達上限。');
    if (spec.sourceTaskId && this.#task(data, spec.sourceTaskId).type !== 'CI_WATCH') refuse('INVALID_SOURCE', '報告只能使用同專案的 CI WATCH。', 400);
    const now = this.#now();
    data.tasks.push({ ...spec, id: spec.requestId, enabled: false, createdAt: now, updatedAt: now, nextDueAt: null, lastRunId: null, state: 'READY', pendingEventKey: null });
    data.operations.push({ requestId: spec.requestId, taskId: spec.requestId, action: 'CREATE', at: now });
    this.#save(data); return this.read(projectId);
  }
  #enqueue(data: PilotData, task: Task, occurrence: string, trigger: PilotRun['trigger'], retry?: PilotRun): PilotRun {
    const prior = data.runs.find(r => r.taskId === task.id && r.occurrence === occurrence);
    if (prior) return prior;
    if (data.runs.some(r => r.taskId === task.id && ['QUEUED', 'RUNNING'].includes(r.state))) refuse('TASK_BUSY', '同一工作已有待執行或執行中的紀錄。');
    if (data.runs.filter(r => r.state === 'QUEUED').length >= LIMITS.queue) refuse('QUEUE_LIMIT', '待執行工作已達上限。');
    const run: PilotRun = { id: randomUUID(), taskId: task.id, occurrence, trigger, state: 'QUEUED', createdAt: this.#now(),
      startedAt: null, endedAt: null, retryOf: retry?.id ?? null, retryCount: retry ? retry.retryCount + 1 : 0,
      error: null, steps: ['QUEUED'], result: null };
    data.runs.push(run); task.lastRunId = run.id; task.state = 'QUEUED'; task.updatedAt = this.#now();
    return run;
  }
  action(projectId: string, taskId: string, input: unknown): unknown {
    if (this.#closed || this.#fault) refuse('PILOT_STOPPED', '自動化已停止，請檢查服務。');
    const parsed = actionInput.safeParse(input);
    if (!parsed.success) refuse('INVALID_ACTION', '不允許的操作。', 400);
    const { action, requestId } = parsed.data;
    const data = this.#data(projectId), task = this.#task(data, taskId);
    const operation = data.operations.find(o => o.requestId === requestId);
    if (operation) {
      if (operation.action !== action || operation.taskId !== taskId) refuse('REQUEST_CONFLICT', '相同請求識別不能用於不同操作。');
      return this.read(projectId);
    }
    if (action === 'RUN' || action === 'RETRY') {
      const occurrence = `${action}:${requestId}`;
      if (data.runs.some(r => r.taskId === taskId && r.occurrence === occurrence)) return this.read(projectId);
      const retry = action === 'RETRY' ? data.runs.find(r => r.id === task.lastRunId) : undefined;
      if (action === 'RETRY' && (!retry || retry.state !== 'FAILED' || retry.retryCount >= task.maxRetries)) refuse('RETRY_REFUSED', '只允許在設定上限內手動重試失敗工作。');
      this.#enqueue(data, task, occurrence, action === 'RUN' ? 'MANUAL' : 'RETRY', retry);
    } else if (action === 'ENABLE') {
      if (task.mode === 'MANUAL') refuse('NO_SCHEDULE', '手動工作不需啟用排程。');
      if (task.enabled) return this.read(projectId);
      task.enabled = true;
      task.nextDueAt = task.mode === 'SCHEDULED' ? new Date(this.#clock() + task.intervalSeconds * 1000).toISOString() : null;
    } else if (action === 'PAUSE' || action === 'STOP') {
      task.enabled = false; task.nextDueAt = null; task.pendingEventKey = null;
      if (action === 'STOP' && this.#active?.projectId === projectId && data.runs.find(r => r.id === this.#active!.runId)?.taskId === taskId) {
        this.#active.abort.abort(new Error('USER_STOP'));
      }
    } else if (action === 'CANCEL') {
      for (const run of data.runs.filter(r => r.taskId === taskId && r.state === 'QUEUED')) {
        run.state = 'CANCELLED'; run.endedAt = this.#now(); run.error = 'QUEUED_WORK_CANCELLED'; task.state = 'CANCELLED';
      }
    }
    task.updatedAt = this.#now(); data.operations.push({ requestId, taskId, action, at: this.#now() }); this.#save(data);
    return this.read(projectId);
  }
  start(): void {
    if (this.#timer || this.#closed) return;
    this.#timer = setInterval(() => { void this.tick().catch(() => { this.#fault = 'PILOT_STORAGE_OR_SCHEDULER_FAILURE'; if (this.#timer) clearInterval(this.#timer); this.#active?.abort.abort(new Error('PILOT_FAULT')); }); }, 1000);
    this.#timer.unref();
  }
  async tick(): Promise<void> {
    if (this.#closed || this.#fault) return;
    for (const id of this.#projects) {
      const data = this.#data(id); let updated = false;
      for (const task of data.tasks.filter(t => t.enabled && t.mode === 'SCHEDULED' && t.nextDueAt && Date.parse(t.nextDueAt) <= this.#clock())) {
        // Skip missed slots, never catch up in a burst, and never queue a parallel occurrence.
        if (!data.runs.some(r => r.taskId === task.id && ['QUEUED', 'RUNNING'].includes(r.state))) {
          this.#enqueue(data, task, 'schedule:' + task.nextDueAt, 'SCHEDULED');
        }
        task.nextDueAt = new Date(this.#clock() + task.intervalSeconds * 1000).toISOString(); updated = true;
      }
      if (updated) this.#save(data);
    }
    await this.drain();
  }
  drain(): Promise<void> {
    if (this.#draining) return this.#draining;
    this.#draining = this.#work().finally(() => { this.#draining = undefined; });
    return this.#draining;
  }
  async #work(): Promise<void> {
    while (!this.#closed && !this.#fault) {
      let chosen: { projectId: string; runId: string } | undefined;
      for (const projectId of this.#projects) {
        const pending = this.#data(projectId); let updated = false;
        for (const task of pending.tasks.filter(t => t.enabled && t.mode === 'EVENT_DRIVEN' && t.pendingEventKey)) {
          if (pending.runs.some(r => r.taskId === task.id && ['QUEUED', 'RUNNING'].includes(r.state))) continue;
          this.#enqueue(pending, task, task.pendingEventKey!, 'EVENT_DRIVEN'); task.pendingEventKey = null; updated = true;
        }
        if (updated) this.#save(pending);
        const run = pending.runs.find(r => r.state === 'QUEUED');
        if (run) { chosen = { projectId, runId: run.id }; break; }
      }
      if (!chosen) return;
      const { projectId, runId } = chosen;
      const data = this.#data(projectId), run = data.runs.find(r => r.id === runId)!, task = this.#task(data, run.taskId);
      const usedReads = [...this.#projects].reduce((sum, p) => sum + this.#data(p).readStarts.filter(at => Date.parse(at) > this.#clock() - 3600000).length, 0);
      run.state = 'RUNNING'; run.startedAt = this.#now(); run.steps.push('STARTED_READ_ONLY'); task.state = 'RUNNING';
      if (task.type === 'CI_WATCH' && usedReads < LIMITS.githubReadsPerHour) data.readStarts.push(this.#now());
      this.#save(data);
      const abort = new AbortController(); this.#active = { projectId, runId, abort };
      const timeout = setTimeout(() => abort.abort(new Error('READ_TIMEOUT')), this.#timeoutMs);
      try {
        let snapshot: CiRun[], sourceRunId: string | null = null, sourceObservedAt: string | null = null;
        if (task.type === 'CI_WATCH') {
          if (usedReads >= LIMITS.githubReadsPerHour) throw new Error('GITHUB_READ_BUDGET_EXHAUSTED');
          snapshot = (await this.#reader.read(abort.signal)).map(r => ciSchema.parse(r));
        }
        else {
          const source = [...data.runs].reverse().find(r => r.taskId === task.sourceTaskId && r.state === 'COMPLETED' && r.result?.source === 'GITHUB_ACTIONS');
          if (!source?.result) throw new Error('NO_VERIFIED_CI_SOURCE');
          snapshot = structuredClone(source.result.snapshot); sourceRunId = source.id; sourceObservedAt = source.result.observedAt;
        }
        if (snapshot.length > LIMITS.snapshotRuns) throw new Error('GITHUB_RESPONSE_LIMIT');
        if (abort.signal.aborted) throw new Error('CANCELLED_OR_TIMEOUT');
        const current = this.#data(projectId), active = current.runs.find(r => r.id === runId)!;
        const previousSource = [...current.runs].reverse().find(r => r.taskId === task.id && r.id !== runId && r.state === 'COMPLETED' && r.result?.source === 'GITHUB_ACTIONS');
        // Each watch owns its baseline. A different task's earlier read must not consume this task's change event.
        const firstBaseline = task.type === 'CI_WATCH' && !previousSource;
        const changes: PilotData['changes'] = [];
        if (task.type === 'CI_WATCH') {
          for (const ci of snapshot) {
            const before = previousSource?.result?.snapshot.find(r => r.id === ci.id);
            if (!before || changedSignature(before) !== changedSignature(ci)) {
              changes.push({ id: digest([task.id, runId, ci.id, changedSignature(ci)]), observedAt: this.#now(), taskId: task.id, runId,
                ciRunId: ci.id, kind: firstBaseline ? 'BASELINE' : before ? 'STATE_CHANGED' : 'NEW_RUN',
                before: before ? stateText(before) : null, after: stateText(ci) });
            }
            current.ci = current.ci.filter(r => r.id !== ci.id); current.ci.push(ci);
          }
          if (firstBaseline && !current.baselinedTasks.includes(task.id)) current.baselinedTasks.push(task.id);
        }
        active.state = 'COMPLETED'; active.endedAt = this.#now(); active.steps.push('VALIDATED_SOURCE', 'PERSISTED_RESULT');
        active.result = { source: task.type === 'CI_WATCH' ? 'GITHUB_ACTIONS' : 'LOCAL_CI_OBSERVATIONS', observedAt: this.#now(),
          changed: changes.filter(c => c.kind !== 'BASELINE').length, firstBaseline, snapshot, failures: failuresOf(snapshot), sourceRunId,
          sourceObservedAt: task.type === 'CI_WATCH' ? this.#now() : sourceObservedAt };
        const currentTask = this.#task(current, task.id); currentTask.state = 'COMPLETED'; currentTask.updatedAt = this.#now(); current.changes.push(...changes);
        const events = changes.filter(c => c.kind !== 'BASELINE');
        if (events.length) for (const downstream of current.tasks.filter(t => t.enabled && t.mode === 'EVENT_DRIVEN' && t.sourceTaskId === task.id)) {
          downstream.pendingEventKey = 'event:' + digest(events.map(c => c.id));
        }
        this.#save(current);
      } catch (e) {
        const current = this.#data(projectId), active = current.runs.find(r => r.id === runId)!;
        const cancellation = abort.signal.aborted && abort.signal.reason instanceof Error ? abort.signal.reason.message : null;
        active.state = cancellation && cancellation !== 'READ_TIMEOUT' ? 'CANCELLED' : 'FAILED'; active.endedAt = this.#now();
        active.error = cancellation ?? (e instanceof Error && /^[A-Z_]{1,100}$/.test(e.message) ? e.message : 'READ_OR_VALIDATION_FAILED');
        active.steps.push(active.state); this.#task(current, task.id).state = active.state; this.#save(current);
      } finally { clearTimeout(timeout); this.#active = undefined; }
    }
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true; if (this.#timer) clearInterval(this.#timer);
    this.#active?.abort.abort(new Error('SERVICE_STOP'));
    try { await this.#draining; } finally { this.#release(); }
  }
}
