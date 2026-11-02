import { z } from 'zod';
import type { HumanPrincipalV1 } from '../identity/canonical.js';
import { SubscriptionTaskRequestError, type SubscriptionTaskPort } from '../workspace/subscription-task-port.js';
import { MAX_OBJECTIVE_CHARS, MCP_SERVER_NAME, TOOL_NAMES } from './contract.js';
import { TaskStoreError, type SubscriptionTask, type SubscriptionTaskStore, type TaskSource } from './task-store.js';

// The Workspace side of the M2-0 queue: the Human adds a task, watches it, and may cancel it. Claude Code claims
// and finishes tasks only through the MCP server; nothing here can claim, complete or run anything.

export interface RunnerInstructions { processOnce: string; mcpAdd: string; interactive: string; loop: string; dataDirectory: string }
export interface SubscriptionPortOptions {
  store: SubscriptionTaskStore;
  projects: readonly string[];
  source(projectId: string): TaskSource;
  now(): string;
  runner: RunnerInstructions;
}

const createInput = z.strictObject({ objective: z.string().min(1).max(MAX_OBJECTIVE_CHARS) });
const actionInput = z.strictObject({ action: z.literal('CANCEL') });
const STATUS: Record<string, number> = { UNKNOWN_TASK: 404, TASK_NOT_PENDING: 409, TASK_NOT_RUNNING: 409, TASK_ALREADY_FINISHED: 409, TASK_LIMIT: 409,
  TASK_STORE_BUSY: 409, OBJECTIVE_REQUIRED: 400, OBJECTIVE_TOO_LONG: 400, TASK_STORE_INTEGRITY: 500, TASK_STORE_UNSAFE: 500 };

function view(task: SubscriptionTask) {
  return { taskId: task.taskId, objective: task.objective, state: task.state, createdAt: task.createdAt,
    claimedAt: task.claim?.claimedAt ?? null, worker: task.claim?.worker ?? null, finishedAt: task.finishedAt,
    report: task.report, reportSha256: task.reportSha256, failure: task.failure, source: task.source, events: task.events };
}

export function createSubscriptionTaskPort(options: SubscriptionPortOptions): SubscriptionTaskPort {
  const known = (projectId: string) => {
    if (!options.projects.includes(projectId)) throw new SubscriptionTaskRequestError('UNKNOWN_PROJECT', 404);
  };
  const run = <T>(fn: () => T): T => {
    try { return fn(); }
    catch (error) {
      if (error instanceof TaskStoreError) throw new SubscriptionTaskRequestError(error.code, STATUS[error.code] ?? 500);
      if (error instanceof z.ZodError) throw new SubscriptionTaskRequestError('INVALID_INPUT', 400);
      throw error;
    }
  };
  const read = (projectId: string) => ({
    readModelVersion: 'm2-0.v1', projectId,
    executor: { kind: 'CLAUDE_CODE_SUBSCRIPTION', billing: 'HUMAN_CLAUDE_SUBSCRIPTION_ONLY', apiCalls: 'NONE',
      mcpServer: MCP_SERVER_NAME, tools: [...TOOL_NAMES], runner: options.runner },
    tasks: options.store.list(projectId).map(view).reverse(),
  });
  return Object.freeze({
    read(projectId: string, _human: HumanPrincipalV1) { known(projectId); return run(() => read(projectId)); },
    create(projectId: string, input: unknown, human: HumanPrincipalV1) {
      known(projectId);
      return run(() => {
        const { objective } = createInput.parse(input);
        const task = options.store.create({ projectId, objective, createdBy: human.principalRef, source: options.source(projectId), at: options.now() });
        return { ...read(projectId), createdTaskId: task.taskId };
      });
    },
    action(projectId: string, taskId: string, input: unknown, _human: HumanPrincipalV1) {
      known(projectId);
      return run(() => {
        actionInput.parse(input);
        const task = options.store.list(projectId).find((t) => t.taskId === taskId);
        if (!task) throw new TaskStoreError('UNKNOWN_TASK');
        options.store.cancel(taskId, options.now());
        return read(projectId);
      });
    },
  });
}
