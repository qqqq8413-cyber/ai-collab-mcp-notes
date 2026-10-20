import { z } from 'zod';

export const REPOSITORY = 'qqqq8413-cyber/ai-collab-mcp-notes';
export const LIMITS = Object.freeze({ tasks: 20, history: 500, changes: 500, ciRuns: 100, queue: 20,
  intervalMin: 60, intervalMax: 86400, timeoutMs: 60000, retriesMax: 2, snapshotRuns: 5,
  outputBytes: 2 * 1024 * 1024, githubReadsPerHour: 30, recommendedIntervalSeconds: 300 });
const instant = z.iso.datetime();
const id = z.string().uuid();
const text = z.string().trim().min(1).max(100).refine(v => !/[\u0000-\u001f\u007f]/.test(v));
export const taskInput = z.strictObject({ requestId: id, name: text,
  type: z.enum(['CI_WATCH', 'CI_REPORT']), mode: z.enum(['MANUAL', 'SCHEDULED', 'EVENT_DRIVEN']),
  intervalSeconds: z.number().int().min(LIMITS.intervalMin).max(LIMITS.intervalMax),
  maxRetries: z.number().int().min(0).max(LIMITS.retriesMax), sourceTaskId: id.optional(),
}).superRefine((v, ctx) => {
  if (v.mode === 'EVENT_DRIVEN' && (v.type !== 'CI_REPORT' || !v.sourceTaskId)) ctx.addIssue({ code: 'custom', message: 'Event mode requires a local CI report and a CI watch source' });
  if (v.type === 'CI_REPORT' && !v.sourceTaskId) ctx.addIssue({ code: 'custom', message: 'Report requires a CI watch source' });
  if (v.type === 'CI_WATCH' && v.sourceTaskId) ctx.addIssue({ code: 'custom', message: 'CI watch cannot name an upstream task' });
});
export const actionInput = z.strictObject({ action: z.enum(['RUN', 'ENABLE', 'PAUSE', 'STOP', 'CANCEL', 'RETRY']), requestId: id });
export const states = ['QUEUED', 'READY', 'RUNNING', 'DEFERRED', 'WAITING_FOR_HUMAN', 'COMPLETED', 'FAILED', 'CANCELLED', 'HOLD'] as const;
const deferral = z.strictObject({ reason: z.literal('GITHUB_READ_BUDGET'), since: instant, until: instant });
const status = z.string().min(1).max(100);
export const stepSchema = z.strictObject({ name: z.string().max(300), status, conclusion: status.nullable(), number: z.number().int() });
export const jobSchema = z.strictObject({ id: z.number().int().positive(), name: z.string().max(300), status,
  conclusion: status.nullable(), labels: z.array(z.string().max(100)).max(50),
  platform: z.enum(['UBUNTU', 'MACOS', 'OTHER']), url: z.string().url(), steps: z.array(stepSchema).max(100),
  requiredMacSkip: z.boolean() });
export const ciSchema = z.strictObject({ id: z.number().int().positive(), attempt: z.number().int().positive(),
  number: z.number().int().positive(), name: z.string().max(300), sha: z.string().regex(/^[a-f0-9]{40}$/),
  branch: z.string().min(1).max(300), status, conclusion: status.nullable(), event: status,
  updatedAt: instant, url: z.string().url(), jobs: z.array(jobSchema).max(200) });
export type CiRun = z.infer<typeof ciSchema>;
export const taskSchema = taskInput.safeExtend({ id, enabled: z.boolean(), createdAt: instant, updatedAt: instant,
  nextDueAt: instant.nullable(), lastRunId: id.nullable(), state: z.enum(states), pendingEventKey: z.string().max(100).nullable(),
  budgetDeferral: deferral.optional() });
export type Task = z.infer<typeof taskSchema>;
export const runSchema = z.strictObject({ id, taskId: id, occurrence: z.string().max(200),
  trigger: z.enum(['MANUAL', 'SCHEDULED', 'EVENT_DRIVEN', 'RETRY']), state: z.enum(states),
  createdAt: instant, startedAt: instant.nullable(), endedAt: instant.nullable(),
  retryOf: id.nullable(), retryCount: z.number().int().min(0).max(LIMITS.retriesMax),
  budgetDeferral: deferral.optional(),
  error: z.string().max(500).nullable(), steps: z.array(z.string().max(200)).max(10),
  result: z.strictObject({ source: z.enum(['GITHUB_ACTIONS', 'LOCAL_CI_OBSERVATIONS']), observedAt: instant,
    changed: z.number().int().nonnegative(), firstBaseline: z.boolean(), snapshot: z.array(ciSchema).max(LIMITS.snapshotRuns),
    failures: z.array(z.string().max(500)).max(100), sourceRunId: id.nullable(), sourceObservedAt: instant.nullable().optional() }).nullable() });
export type PilotRun = z.infer<typeof runSchema>;
export const changeSchema = z.strictObject({ id: z.string().regex(/^[a-f0-9]{64}$/), observedAt: instant,
  taskId: id, runId: id, ciRunId: z.number().int().positive(), kind: z.enum(['BASELINE', 'NEW_RUN', 'STATE_CHANGED']),
  before: z.string().max(150).nullable(), after: z.string().max(150) });
export const payloadSchema = z.strictObject({ projectId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/), revision: z.number().int().nonnegative(),
  tasks: z.array(taskSchema).max(LIMITS.tasks), runs: z.array(runSchema).max(LIMITS.history),
  changes: z.array(changeSchema).max(LIMITS.changes), ci: z.array(ciSchema).max(LIMITS.ciRuns),
  operations: z.array(z.strictObject({ requestId: id, taskId: id, action: z.string().max(30), at: instant })).max(LIMITS.history),
  readStarts: z.array(instant).max(LIMITS.githubReadsPerHour),
  baselinedTasks: z.array(id).max(LIMITS.tasks) });
export type PilotData = z.infer<typeof payloadSchema>;
export const envelopeSchema = z.strictObject({ schemaVersion: z.literal(1), checksum: z.string().regex(/^[a-f0-9]{64}$/), payload: payloadSchema });
