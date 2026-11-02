#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDataDirectory, parseArgs } from './layout.js';
import { startM2Host } from './host.js';

// M2-0 Host: `npm run workspace:m2 -- --data-dir <absolute path outside the repo> [--port 4880]`.
// Serves the CHIEF Workspace with the Claude Code task queue (自動化 → 交給 Claude Code). No model, no credential.

function headSha(root: string): string | null {
  try {
    const sha = execFileSync('/usr/bin/git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' } }).trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch { return null; }
}

async function main() {
  const args = parseArgs(process.argv.slice(2), ['--data-dir', '--port']);
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const data = checkDataDirectory(args.get('--data-dir'), root);
  const port = Number(args.get('--port') ?? '4880');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('INVALID_PORT');
  const host = await startM2Host({ dataDirectory: data, port, repositoryRoot: root, uiDirectory: join(root, 'workspace-ui'), commitSha: () => headSha(root) });
  console.log(`CHIEF M2-0：${host.url.replace('127.0.0.1', 'localhost')}#/p/chief/automation`);
  console.log('在「自動化」頁的「交給 Claude Code」輸入任務。CHIEF 不呼叫任何 API；任務由你自己登入的 Claude Code 處理。');
  console.log(`\n一次處理目前所有待辦任務（另開一個 Terminal 視窗）：\n  ${host.runner.processOnce}`);
  console.log(`\n或在互動模式持續處理：\n  ${host.runner.mcpAdd}\n  ${host.runner.interactive}\n  然後在 Claude Code 輸入：${host.runner.loop}`);
  console.log(`\nMCP 設定檔：${host.mcpConfigPath}`);
  let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; void host.close().then(() => process.exit(0), () => process.exit(1)); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
main().catch((error: unknown) => {
  console.error(error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : 'M2_HOST_START_FAILED');
  process.exit(1);
});
