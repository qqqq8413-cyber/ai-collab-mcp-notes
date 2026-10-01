#!/usr/bin/env node
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkspaceConfig } from './config.js';
import { startWorkspaceServer } from './server.js';

// chief-workspace: starts the local Workspace (WS-L1) on 127.0.0.1.
//   chief-workspace --config <workspace.json> [--port 4870]
// The configuration may also be given as CHIEF_WORKSPACE_CONFIG. Nothing here starts
// automation, reads Controller storage, or calls a model.

const DEFAULT_PORT = 4870;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const configPath = argument('--config') ?? process.env.CHIEF_WORKSPACE_CONFIG;
  if (!configPath) throw new Error('Usage: chief-workspace --config <workspace.json> [--port 4870]');
  const portText = argument('--port') ?? String(DEFAULT_PORT);
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid port ${portText}`);
  const config = loadWorkspaceConfig(configPath);
  const uiDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'workspace-ui');
  const running = await startWorkspaceServer({ config, uiDirectory, port });
  console.log(`Chief Workspace: ${running.url}`);
  console.log(`Goal queues: ${config.dataDirectory} (local operator input; nothing is executed)`);
  const stop = () => { void running.close().then(() => process.exit(0)); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
