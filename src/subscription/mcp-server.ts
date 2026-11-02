import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MAX_CLAIMS_PER_SESSION, MAX_FAILURE_DETAIL_CHARS, MAX_REPORT_BYTES, MCP_SERVER_NAME, MIN_POLL_INTERVAL_MS, TASK_RULES } from './contract.js';
import { TaskStoreError, type SubscriptionTask, type SubscriptionTaskStore } from './task-store.js';

// The CHIEF MCP server (M2-0): exactly four tools over the local task queue, for the Human's own official Claude Code.
// The tools take only task ids, a claimId, report text and a failure reason: no path, command, URL, credential,
// Authority, Git or deployment input exists, and the server itself reads and writes nothing but its task store.
// It never calls a model. If a billing variable is present in its environment it refuses every tool.

export interface ChiefTaskMcpOptions {
  store: SubscriptionTaskStore;
  now(): string;
  /** Names (never values) of billing variables present in this process's environment. */
  billingEnvPresent: readonly string[];
  /** Milliseconds clock for the poll limit (tests inject one). */
  monotonicMs?(): number;
  minPollIntervalMs?: number;
  maxClaimsPerSession?: number;
  projectId?: string;
}

type Result = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
const reply = (body: unknown, isError = false): Result => ({ content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], ...(isError ? { isError } : {}) });
const refuse = (code: string, extra: Record<string, unknown> = {}) => reply({ status: 'REFUSED', code, ...extra }, true);

/** What Claude Code sees of a task: the work and where to read, never the claimId of another session. */
function taskView(task: SubscriptionTask) {
  return { taskId: task.taskId, projectId: task.projectId, objective: task.objective, state: task.state, createdAt: task.createdAt,
    source: task.source, rules: TASK_RULES };
}

export function createChiefTaskMcpServer(options: ChiefTaskMcpOptions): McpServer {
  const { store } = options;
  const clock = options.monotonicMs ?? (() => performance.now());
  const minPoll = options.minPollIntervalMs ?? MIN_POLL_INTERVAL_MS, maxClaims = options.maxClaimsPerSession ?? MAX_CLAIMS_PER_SESSION;
  // The poll limit applies to idle polling: a poll right after this session claimed a task is always answered.
  let lastPoll: number | null = null, claimedSincePoll = false, claims = 0;
  const server = new McpServer({ name: MCP_SERVER_NAME, version: '0.1.0' });
  const guarded = <A>(fn: (args: A) => Result) => async (args: A): Promise<Result> => {
    if (options.billingEnvPresent.length) {
      return refuse('BILLING_GUARD_API_ENV_PRESENT', { variables: options.billingEnvPresent,
        message: '偵測到可能改用 API 計費的環境變數（只檢查是否存在，未讀取值）。請關閉 Claude Code，移除這些變數後，用訂閱登入重新啟動。' });
    }
    try { return fn(args); }
    catch (error) {
      if (error instanceof TaskStoreError) return refuse(error.code, error.state ? { state: error.state } : {});
      return refuse('CHIEF_TASK_STORE_ERROR');
    }
  };

  server.registerTool('chief_next_task', {
    title: 'CHIEF: next pending task',
    description: 'Returns the oldest PENDING task in the CHIEF queue (TASK_AVAILABLE), or NO_PENDING_TASK. Looking does not reserve the task: claim it with chief_claim_task before working. Idle polling is limited: without a claim in between, polls closer than a few seconds answer RATE_LIMITED.',
    inputSchema: {},
  }, guarded(() => {
    const now = clock();
    if (lastPoll !== null && !claimedSincePoll && now - lastPoll < minPoll) {
      return reply({ status: 'RATE_LIMITED', retryAfterSeconds: Math.ceil((minPoll - (now - lastPoll)) / 1000) });
    }
    lastPoll = now; claimedSincePoll = false;
    const task = store.next(options.projectId);
    return reply(task ? { status: 'TASK_AVAILABLE', task: taskView(task) } : { status: 'NO_PENDING_TASK' });
  }));

  server.registerTool('chief_claim_task', {
    title: 'CHIEF: claim a task',
    description: 'Claims one PENDING task (PENDING -> RUNNING) so no other session runs it. Returns the claimId needed to complete or fail it. A task that is not PENDING is refused (TASK_NOT_PENDING).',
    inputSchema: { taskId: z.string().uuid().describe('taskId from chief_next_task') },
  }, guarded(({ taskId }: { taskId: string }) => {
    if (claims >= maxClaims) return refuse('SESSION_TASK_LIMIT', { maxClaimsPerSession: maxClaims, message: '這個 Claude Code 工作階段已領取上限數量的任務；請結束後重新啟動。' });
    const { task, claimId } = store.claim(taskId, 'claude-code', options.now());
    claims += 1; claimedSincePoll = true;
    return reply({ status: 'CLAIMED', claimId, task: taskView(task) });
  }));

  server.registerTool('chief_complete_task', {
    title: 'CHIEF: complete a task with its report',
    description: 'Saves the finished report (Traditional Chinese Markdown) for a RUNNING task you claimed and marks it COMPLETED. CHIEF shows the report to the Human. Refused for a wrong claimId or a task that is not RUNNING.',
    inputSchema: {
      taskId: z.string().uuid(),
      claimId: z.string().uuid().describe('claimId returned by chief_claim_task'),
      report: z.string().min(1).max(MAX_REPORT_BYTES).describe('The complete report, Markdown, at most 64 KiB'),
    },
  }, guarded(({ taskId, claimId, report }: { taskId: string; claimId: string; report: string }) => {
    const task = store.complete(taskId, claimId, report, options.now());
    return reply({ status: 'COMPLETED', taskId: task.taskId, reportSha256: task.reportSha256 });
  }));

  server.registerTool('chief_fail_task', {
    title: 'CHIEF: record why a task stopped',
    description: 'Marks a RUNNING task you claimed as FAILED with a reason code (e.g. OUT_OF_SCOPE, SOURCE_UNREADABLE, CANNOT_COMPLETE) and a short explanation. The task is not retried.',
    inputSchema: {
      taskId: z.string().uuid(),
      claimId: z.string().uuid(),
      reason: z.string().regex(/^[A-Z0-9_]{1,64}$/).describe('Upper-case reason code'),
      detail: z.string().max(MAX_FAILURE_DETAIL_CHARS).describe('Short explanation for the Human'),
    },
  }, guarded(({ taskId, claimId, reason, detail }: { taskId: string; claimId: string; reason: string; detail: string }) => {
    const task = store.fail(taskId, claimId, reason, detail, options.now());
    return reply({ status: 'FAILED', taskId: task.taskId, reason });
  }));

  return server;
}
