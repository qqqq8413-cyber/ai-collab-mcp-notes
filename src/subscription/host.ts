import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseWorkspaceConfig } from '../workspace/config.js';
import { startWorkspaceServer, type RunningWorkspace } from '../workspace/server.js';
import { MCP_SERVER_NAME, processingPrompt } from './contract.js';
import { m2Layout } from './layout.js';
import { SubscriptionTaskStore } from './task-store.js';
import { createSubscriptionTaskPort, type RunnerInstructions } from './workspace-port.js';

// M2-0 Host: the Workspace UI with the Claude Code task queue, on 127.0.0.1. It writes the MCP configuration for the
// Human's Claude Code and prints how to start it. It never starts Claude Code, calls a model, holds a credential, or
// composes the governed Worker (the M1 API path stays NO-GO; EXE stays HOLD).

export const M2_PROJECT = 'chief';
export const M2_HUMAN = 'human:local-workspace-operator';
export const M2_REPOSITORY = 'qqqq8413-cyber/ai-collab-mcp-notes';

export interface M2HostOptions {
  dataDirectory: string; port: number; repositoryRoot: string; uiDirectory: string;
  /** The checked-out commit, bound into each new task's source information (null when unknown). */
  commitSha(): string | null;
  now?(): string;
  /** The Node executable Claude Code should start the MCP server with (default: this one). */
  nodeExecutable?: string;
}
export interface M2Host { readonly url: string; readonly port: number; readonly workspace: RunningWorkspace; readonly mcpConfigPath: string; readonly runner: RunnerInstructions; close(): Promise<void> }

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export function mcpServerCommand(repositoryRoot: string, dataDirectory: string, node = process.execPath) {
  return { command: node, args: [join(repositoryRoot, 'dist', 'subscription', 'mcp-main.js'), '--data-dir', dataDirectory] };
}

export function runnerInstructions(repositoryRoot: string, dataDirectory: string, node = process.execPath): RunnerInstructions {
  const server = mcpServerCommand(repositoryRoot, dataDirectory, node);
  return {
    dataDirectory,
    processOnce: `cd ${quote(repositoryRoot)} && npm run m2:process-once -- --data-dir ${quote(dataDirectory)}`,
    mcpAdd: `cd ${quote(repositoryRoot)} && claude mcp add ${MCP_SERVER_NAME} --scope local -- ${[server.command, ...server.args].map(quote).join(' ')}`,
    interactive: `cd ${quote(repositoryRoot)} && claude`,
    loop: `/loop 10m ${processingPrompt(3).split('\n').join(' ')}`,
  };
}

/** Write the MCP configuration atomically, private to this user. */
function writeMcpConfig(path: string, repositoryRoot: string, dataDirectory: string, node?: string) {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { type: 'stdio', ...mcpServerCommand(repositoryRoot, dataDirectory, node) } } }, null, 2), { mode: 0o600, flag: 'wx' });
  renameSync(temp, path);
}

export async function startM2Host(options: M2HostOptions): Promise<M2Host> {
  const layout = m2Layout(options.dataDirectory), now = options.now ?? (() => new Date().toISOString());
  mkdirSync(layout.root, { recursive: true, mode: 0o700 });
  mkdirSync(layout.goals, { recursive: true, mode: 0o700 });
  const store = new SubscriptionTaskStore(layout.tasks);
  writeMcpConfig(layout.mcpConfig, options.repositoryRoot, options.dataDirectory, options.nodeExecutable);
  const runner = runnerInstructions(options.repositoryRoot, options.dataDirectory, options.nodeExecutable);
  const config = parseWorkspaceConfig({ schemaVersion: 1, dataDirectory: layout.goals, humanPrincipal: { principalRef: M2_HUMAN },
    projects: [{ projectId: M2_PROJECT, displayName: 'CHIEF', repository: M2_REPOSITORY }] }, options.dataDirectory);
  const subscriptionTasks = createSubscriptionTaskPort({ store, projects: [M2_PROJECT], now, runner,
    source: () => ({ repository: M2_REPOSITORY, workingDirectory: options.repositoryRoot, commitSha: options.commitSha(), readme: 'README.md' }) });
  const workspace = await startWorkspaceServer({ config, uiDirectory: options.uiDirectory, port: options.port, subscriptionTasks });
  return Object.freeze({ url: workspace.url, port: workspace.port, workspace, mcpConfigPath: layout.mcpConfig, runner, close: () => workspace.close() });
}
