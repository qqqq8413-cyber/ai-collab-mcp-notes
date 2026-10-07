#!/usr/bin/env node
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTrustedWorkspaceHostConfig } from './workspace-host-config.js';
import { startTrustedWorkspaceHost } from './workspace-host.js';

const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

async function main(): Promise<void> {
  const file = argument('--config') ?? process.env.CHIEF_WORKSPACE_HOST_CONFIG;
  if (!file) throw new Error('Usage: chief-workspace-host --config <host.json> [--port 4870]');
  const port = Number(argument('--port') ?? '4870');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid Workspace port');
  const config = loadTrustedWorkspaceHostConfig(file);
  const uiDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'workspace-ui');
  const running = await startTrustedWorkspaceHost({ config, uiDirectory, port });
  console.log(`Chief Workspace: ${running.url}`);
  const stop = () => { void running.close().then(() => process.exit(0)); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
