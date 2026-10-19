#!/usr/bin/env node
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadWorkspaceConfig } from '../workspace/config.js';
import { startWorkspaceServer } from '../workspace/server.js';
import { PilotEngine } from './engine.js';
import { GitHubActionsReader } from './github.js';
import { REPOSITORY } from './model.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) if (!['--config', '--port', '--github-helper'].includes(args[i]) || !args[i + 1]) throw new Error('Invalid pilot arguments');
  const arg = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const path = arg('--config'); if (!path) throw new Error('Pass --config <workspace.json>');
  const port = Number(arg('--port') ?? '4873');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  const config = loadWorkspaceConfig(path);
  const projects = config.projects.filter(p => p.repository === REPOSITORY).map(p => p.projectId);
  if (!projects.length) throw new Error('Pilot requires the exact CHIEF repository in Workspace config');
  const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
  const helper = arg('--github-helper') ?? join(homedir(), '.config/gh-chief-ai/bin/chief-github');
  const engine = new PilotEngine({ dataDirectory: config.dataDirectory, projects, reader: new GitHubActionsReader(helper, root) });
  try {
    const server = await startWorkspaceServer({ config, uiDirectory: join(root, 'workspace-ui'), port, automation: engine });
    engine.start();
    console.log(`CHIEF AUTO-P1: ${server.url} | read-only CI watch | EXE HOLD`);
    let stopping = false;
    const stop = () => {
      if (stopping) return; stopping = true;
      void engine.close().then(() => server.close()).then(() => process.exit(0)).catch(() => process.exit(1));
    };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  } catch (e) { await engine.close(); throw e; }
}
main().catch(() => { console.error('AUTO-P1 無法啟動；請檢查唯讀 helper、資料目錄與連接埠。EXE 維持 HOLD。'); process.exitCode = 1; });
