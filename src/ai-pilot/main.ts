#!/usr/bin/env node
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadTrustedWorkspaceHostConfig } from '../intake/workspace-host-config.js';
import { trustedIntakeIsolation } from '../intake/goal-run-admission-bridge.js';
import { trustedObservationPreflight } from '../intake/goal-execution-status-bridge.js';
import { startTrustedWorkspaceHost } from '../intake/workspace-host.js';
import { PilotEngine } from '../pilot/engine.js';
import { GitHubActionsReader } from '../pilot/github.js';
import { REPOSITORY } from '../pilot/model.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2), names = args.filter((_, i) => i % 2 === 0);
  if (new Set(names).size !== names.length) throw new Error('Duplicate arguments');
  for (let i = 0; i < args.length; i += 2) if (!['--host-config', '--port', '--github-helper'].includes(args[i]) || !args[i + 1]) throw new Error('Invalid preparation arguments');
  const arg = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const path = arg('--host-config'); if (!path) throw new Error('Pass --host-config');
  const port = Number(arg('--port') ?? '4874');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  const config = loadTrustedWorkspaceHostConfig(path);
  const root = join(dirname(fileURLToPath(import.meta.url)), '../..'), uiDirectory = join(root, 'workspace-ui');
  const roots = { config: config.workspace, changeRegistryDirectory: config.changeRegistryDirectory,
    controllerStoreDirectory: config.controllerStoreDirectory, uiDirectory };
  // The trusted host repeats these checks; the first pass is before even the read-only scheduler can write.
  trustedIntakeIsolation(roots);
  if (config.executionStatus) trustedObservationPreflight({ ...roots, ...config.executionStatus });
  const projects = config.workspace.projects.filter(p => p.repository === REPOSITORY).map(p => p.projectId);
  if (!projects.length) throw new Error('Requires exact CHIEF display repository');
  const helper = arg('--github-helper') ?? join(homedir(), '.config/gh-chief-ai/bin/chief-github');
  const engine = new PilotEngine({ dataDirectory: config.workspace.dataDirectory, projects, reader: new GitHubActionsReader(helper, root) });
  try {
    const server = await startTrustedWorkspaceHost({ config, uiDirectory, port, automation: engine, aiPreparation: true });
    engine.start();
    console.log(`CHIEF AUTO-P2 preparation: ${server.url} | EXE HOLD | no execution capability`);
    let stopping = false;
    const stop = () => {
      if (stopping) return; stopping = true;
      void engine.close().then(() => server.close()).then(() => process.exit(0)).catch(() => process.exit(1));
    };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  } catch (e) { await engine.close(); throw e; }
}
main().catch(() => { console.error('AI Pilot 準備服務無法啟動；請保留隔離／設定紀錄供檢查。EXE HOLD。'); process.exitCode = 1; });
