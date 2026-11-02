#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_CLAIMS_PER_SESSION, billingEnvPresent, processingPrompt } from './contract.js';
import { claudeArguments, subscriptionRefusal } from './launcher.js';
import { checkDataDirectory, m2Layout, parseArgs } from './layout.js';
import { SubscriptionTaskStore } from './task-store.js';

// M2-0 "process once": the Human runs this in their own Terminal to let their official Claude Code (signed in with
// their Claude subscription) work through the tasks waiting in CHIEF right now, then exit.
//   npm run m2:process-once -- --data-dir <absolute M2 data directory> [--max-tasks 3]
// Before Claude Code starts, three gates must pass, or nothing starts:
//   1. no billing variable is present (only presence is checked; values are never read or printed);
//   2. `claude auth status --json` shows a claude.ai subscription login (pro or max) on the first-party API, with no
//      API key source: anything else, or anything this cannot read, is refused (no silent switch to API billing);
//   3. there is at least one PENDING task (an empty queue starts nothing and uses no quota).
// Claude Code keeps its own permission system (launcher.ts): only Read/Glob/Grep exist as built-in tools, only the four
// CHIEF tools and reads inside this repository are pre-approved, everything else is denied without a prompt, and
// reads of common credential locations are denied. It is never started with --dangerously-skip-permissions, --bare
// or a key.

const RUN_TIMEOUT_MS = 30 * 60_000;

const say = (line: string) => console.log(line);
function stop(code: string, explain: string): never {
  console.error(`未啟動 Claude Code：${code}\n${explain}`);
  process.exit(2);
}

async function main() {
  const args = parseArgs(process.argv.slice(2), ['--data-dir', '--max-tasks']);
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const data = checkDataDirectory(args.get('--data-dir'), root);
  const maxTasks = Number(args.get('--max-tasks') ?? '3');
  if (!Number.isInteger(maxTasks) || maxTasks < 1 || maxTasks > MAX_CLAIMS_PER_SESSION) throw new Error('INVALID_MAX_TASKS');

  const present = billingEnvPresent(process.env);
  if (present.length) stop('BILLING_GUARD_API_ENV_PRESENT', `這些環境變數存在（只檢查名稱，沒有讀取值）：${present.join(', ')}\n請在一般的 macOS Terminal 視窗執行，或先 unset 這些變數；它們可能讓 Claude Code 改用 API 計費。`);

  const layout = m2Layout(data);
  if (!existsSync(layout.mcpConfig)) stop('MCP_CONFIG_MISSING', '找不到 MCP 設定。請先啟動 CHIEF M2 Host（npm run workspace:m2 -- --data-dir 同一個資料夾）。');
  const store = new SubscriptionTaskStore(layout.tasks);
  const pending = store.list().filter((t) => t.state === 'PENDING');
  if (!pending.length) { say('CHIEF 沒有待辦任務；沒有啟動 Claude Code，沒有使用額度。'); return; }

  const auth = spawnSync('claude', ['auth', 'status', '--json'], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] });
  if (auth.error) stop('CLAUDE_CODE_NOT_FOUND', '找不到官方 Claude Code（claude 指令）。請先安裝並用 claude auth login 以 Pro 訂閱登入。');
  let status: unknown = null;
  try { status = JSON.parse(auth.stdout); } catch { status = null; }
  const refusal = subscriptionRefusal(status);
  if (refusal) {
    const s = (status ?? {}) as Record<string, unknown>;
    stop(refusal, `Claude Code 登入狀態不是 Pro／Max 訂閱（authMethod=${String(s.authMethod)}，apiProvider=${String(s.apiProvider)}，subscriptionType=${String(s.subscriptionType)}${s.apiKeySource !== undefined ? '，偵測到 API key 來源' : ''}）。\n請執行 claude auth login，選擇用 Claude 訂閱帳號登入。`);
  }
  const subscription = String((status as Record<string, unknown>).subscriptionType);
  say(`登入方式：Claude ${subscription} 訂閱（claude.ai）；未偵測到 API 計費變數。`);
  say(`待辦任務 ${pending.length} 件；這次最多處理 ${maxTasks} 件。Claude Code 只能用 CHIEF 四個工具與 Read／Glob／Grep。`);

  const child = spawn('claude', claudeArguments(layout.mcpConfig), { cwd: root, stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.on('error', () => { /* Claude Code exited before reading the prompt: its exit code tells */ });
  child.stdin.end(processingPrompt(maxTasks));
  const timer = setTimeout(() => { console.error(`超過 ${RUN_TIMEOUT_MS / 60_000} 分鐘，停止 Claude Code。`); child.kill('SIGTERM'); }, RUN_TIMEOUT_MS);
  const code = await new Promise<number>((done) => {
    child.on('error', () => done(1));
    child.on('exit', (exit, signal) => done(exit ?? (signal ? 1 : 0)));
  });
  clearTimeout(timer);
  const ids = new Set(pending.map((t) => t.taskId));
  const after = store.list().filter((t) => ids.has(t.taskId));
  say('\n結果：');
  for (const t of after) say(`- ${t.state}  ${t.objective.slice(0, 60)}${t.failure ? `（${t.failure.code}）` : ''}`);
  const stuck = after.filter((t) => t.state === 'RUNNING');
  if (stuck.length) say(`有 ${stuck.length} 件任務仍是 RUNNING（Claude Code 沒有回報結果，例如額度用完或被中斷）。不會自動重做；請到 CHIEF 取消後重新建立。`);
  process.exitCode = code;
}
main().catch((error: unknown) => {
  console.error(error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : 'M2_PROCESS_ONCE_FAILED');
  process.exit(1);
});
