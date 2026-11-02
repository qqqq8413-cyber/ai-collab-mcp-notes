import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BILLING_ENV_NAMES, CLAUDE_TOOL_NAMES, TOOL_NAMES, billingEnvPresent, processingPrompt } from './dist/subscription/contract.js';
import { ALLOWED_TOOLS, DENIED_TOOLS, claudeArguments, subscriptionRefusal } from './dist/subscription/launcher.js';
import { createChiefTaskMcpServer } from './dist/subscription/mcp-server.js';
import { SubscriptionTaskStore } from './dist/subscription/task-store.js';
import { M2_PROJECT, startM2Host } from './dist/subscription/host.js';
import { checkDataDirectory, m2Layout } from './dist/subscription/layout.js';
import { EXE } from './dist/limited-worker/contract.js';
import { parseWorkspaceConfig } from './dist/workspace/config.js';
import { startWorkspaceServer } from './dist/workspace/server.js';
import { SUB_LABELS, runnerHTML, subscriptionHTML, tasksHTML } from './workspace-ui/subscription-tasks.js';
import { createLiveSource } from './workspace-ui/live.js';

// M2-0 SUBSCRIPTION AUTOMATION, non-paid end to end. Claude Code is played by test MCP clients and by a stand-in
// `claude` executable on a private PATH; the real `claude` is never started, no model is called, no key exists.
const ROOT = process.cwd();
const ACCEPTANCE = '請閱讀這個 CHIEF 專案的 README，整理目前功能、尚未完成的功能，以及接下來最值得優先實作的三件事。輸出繁體中文報告。';
// A clean environment for every child: this test may itself run inside a Claude Code session whose variables
// (ANTHROPIC_BASE_URL and others) would trip the billing guard.
const CLEAN_ENV = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: process.env.HOME ?? tmpdir() };
const MCP_MAIN = join(ROOT, 'dist', 'subscription', 'mcp-main.js');
const PROCESS_ONCE = join(ROOT, 'dist', 'subscription', 'process-once.js');
const SECRET = 'sk-ant-TEST-VALUE-MUST-NEVER-APPEAR-1234567890';
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const SUBSCRIBED = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'person@example.invalid', orgName: 'ORG-NAME-HIDDEN', subscriptionType: 'pro' };

let passed = 0, failed = 0;
async function test(name, fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'chief-m2-')));
  try { await fn(dir); passed++; console.log('  PASS ' + name); }
  catch (e) { failed++; console.error('  FAIL ' + name + ': ' + e.stack); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

async function host(dir, extra = {}) {
  const data = join(dir, 'data');
  const h = await startM2Host({ dataDirectory: data, port: 0, repositoryRoot: ROOT, uiDirectory: join(ROOT, 'workspace-ui'), commitSha: () => 'c'.repeat(40), ...extra });
  const base = h.url.slice(0, -1);
  const cookie = (await fetch(h.url)).headers.get('set-cookie').split(';')[0];
  const call = async (method, path, body) => {
    const response = await fetch(base + '/api/v0' + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json', origin: base, 'x-chief-workspace': '1' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const tasks = async () => (await call('GET', `/projects/${M2_PROJECT}/subscription-tasks`)).body.tasks;
  const create = async (objective = ACCEPTANCE) => (await call('POST', `/projects/${M2_PROJECT}/subscription-tasks`, { objective })).body;
  return { h, data, call, tasks, create, close: () => h.close() };
}
/** A test MCP client playing Claude Code, over the real stdio MCP server process. */
async function mcpClient(data, env = CLEAN_ENV) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [MCP_MAIN, '--data-dir', data], env, stderr: 'pipe' });
  let stderr = ''; transport.stderr?.on('data', (d) => { stderr += d; });
  const client = new Client({ name: 'test-claude-code', version: '0' });
  await client.connect(transport);
  const raw = (name, args = {}) => client.callTool({ name, arguments: args });
  const call = async (name, args = {}) => { const r = await raw(name, args); return { ...JSON.parse(r.content[0].text), isError: r.isError === true, text: r.content[0].text }; };
  return { client, call, raw, stderr: () => stderr, close: () => client.close() };
}
/** The in-process server with an injected clock (poll limit and session limit). */
async function memoryClient(store, options = {}) {
  const server = createChiefTaskMcpServer({ store, now: () => new Date().toISOString(), billingEnvPresent: [], ...options });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'memory', version: '0' }); await client.connect(b);
  return async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); return { ...JSON.parse(r.content[0].text), isError: r.isError === true }; };
}
const source = { repository: 'qqqq8413-cyber/ai-collab-mcp-notes', workingDirectory: ROOT, commitSha: 'c'.repeat(40), readme: 'README.md' };
const newTask = (store, objective = ACCEPTANCE) => store.create({ projectId: M2_PROJECT, objective, createdBy: 'human:test', source, at: new Date().toISOString() });
/** What the test "Claude Code" writes after really reading the README (synthetic, labelled, no model). */
function readmeReport(workingDirectory) {
  const readme = readFileSync(join(workingDirectory, 'README.md'), 'utf8');
  const headings = readme.split('\n').filter((line) => /^#{1,3} /.test(line)).map((line) => `- ${line.replace(/^#+ /, '')}`);
  return { readme, report: ['# 測試報告（測試用 MCP client，不是模型）', '', `README ${Buffer.byteLength(readme)} bytes，sha256 ${sha256(readme)}`, '', '## 章節', ...headings].join('\n') };
}

// ---------------------------------------------------------------- the acceptance flow, end to end
await test('M2 E2E: UI task PENDING -> Claude Code (test MCP client) claims RUNNING -> reads README -> report written back -> UI COMPLETED with report', async (dir) => {
  const w = await host(dir), a = await mcpClient(w.data);
  try {
    const created = await w.create();
    assert.equal(created.tasks.length, 1);
    let [task] = await w.tasks();
    assert.equal(task.state, 'PENDING'); assert.equal(task.objective, ACCEPTANCE); assert.equal(task.claimedAt, null);
    assert.deepEqual(task.source, source);
    const next = await a.call('chief_next_task');
    assert.equal(next.status, 'TASK_AVAILABLE'); assert.equal(next.task.taskId, task.taskId); assert.equal(next.task.objective, ACCEPTANCE);
    assert.equal(next.task.source.workingDirectory, ROOT); assert.equal(next.task.source.readme, 'README.md'); assert.ok(next.task.rules.length >= 4);
    assert.equal(next.claimId, undefined); assert.equal(next.task.claimId, undefined);
    const claim = await a.call('chief_claim_task', { taskId: task.taskId });
    assert.equal(claim.status, 'CLAIMED'); assert.match(claim.claimId, /^[0-9a-f-]{36}$/);
    [task] = await w.tasks();
    assert.equal(task.state, 'RUNNING'); assert.ok(task.claimedAt); assert.equal(task.worker, 'claude-code'); assert.equal(task.claimId, undefined);
    const { readme, report } = readmeReport(claim.task.source.workingDirectory);
    assert.match(readme, /^# CHIEF/);
    const done = await a.call('chief_complete_task', { taskId: task.taskId, claimId: claim.claimId, report });
    assert.equal(done.status, 'COMPLETED'); assert.equal(done.reportSha256, sha256(report));
    [task] = await w.tasks();
    assert.equal(task.state, 'COMPLETED'); assert.equal(task.report, report); assert.equal(task.reportSha256, sha256(report)); assert.ok(task.finishedAt);
    assert.deepEqual(task.events.map((e) => e.kind), ['CREATED', 'CLAIMED', 'COMPLETED']);
    // The UI renders the state and the report.
    const html = tasksHTML({ tasks: [task] });
    assert.match(html, /COMPLETED · 已完成/); assert.match(html, /Claude Code 的報告/); assert.match(html, /<h2>章節<\/h2>/);
    // Nothing is offered again, and a finished task never changes.
    assert.equal((await a.call('chief_next_task')).status, 'NO_PENDING_TASK');
    const again = await a.call('chief_complete_task', { taskId: task.taskId, claimId: claim.claimId, report: 'other' });
    assert.equal(again.isError, true); assert.equal(again.code, 'TASK_NOT_RUNNING');
    const reclaim = await a.call('chief_claim_task', { taskId: task.taskId });
    assert.equal(reclaim.isError, true); assert.equal(reclaim.code, 'TASK_NOT_PENDING'); assert.equal(reclaim.state, 'COMPLETED');
    assert.equal((await w.tasks())[0].report, report);
  } finally { await a.close(); await w.close(); }
});

await test('M2 no duplicate execution: three Claude Code sessions race for one task; exactly one claims it, the others are refused and see nothing pending', async (dir) => {
  const w = await host(dir);
  const clients = await Promise.all([1, 2, 3].map(() => mcpClient(w.data)));
  try {
    const { createdTaskId } = await w.create();
    const offers = await Promise.all(clients.map((c) => c.call('chief_next_task')));
    assert.ok(offers.every((o) => o.status === 'TASK_AVAILABLE' && o.task.taskId === createdTaskId), 'looking does not reserve');
    const claims = await Promise.all(clients.map((c) => c.call('chief_claim_task', { taskId: createdTaskId })));
    assert.equal(claims.filter((c) => c.status === 'CLAIMED').length, 1);
    assert.deepEqual(claims.filter((c) => c.isError).map((c) => c.code), ['TASK_NOT_PENDING', 'TASK_NOT_PENDING']);
    const winner = claims.findIndex((c) => c.status === 'CLAIMED'), loser = clients[(winner + 1) % 3];
    // A loser cannot finish it, even with a guessed claimId.
    const stolen = await loser.call('chief_complete_task', { taskId: createdTaskId, claimId: '00000000-0000-4000-8000-000000000000', report: 'x' });
    assert.equal(stolen.code, 'CLAIM_MISMATCH');
    const steal = await loser.call('chief_fail_task', { taskId: createdTaskId, claimId: '00000000-0000-4000-8000-000000000000', reason: 'X', detail: '' });
    assert.equal(steal.code, 'CLAIM_MISMATCH');
    assert.equal((await w.tasks())[0].state, 'RUNNING');
    assert.equal((await clients[winner].call('chief_complete_task', { taskId: createdTaskId, claimId: claims[winner].claimId, report: '# ok' })).status, 'COMPLETED');
    const events = (await w.tasks())[0].events.map((e) => e.kind);
    assert.deepEqual(events, ['CREATED', 'CLAIMED', 'COMPLETED'], 'one claim, one completion');
  } finally { for (const c of clients) await c.close(); await w.close(); }
});

await test('M2 failure path: chief_fail_task records the reason; FAILED is terminal and shown; it is not retried or offered again', async (dir) => {
  const w = await host(dir), a = await mcpClient(w.data);
  try {
    const { createdTaskId } = await w.create('請推送到 main 並部署');
    const claim = await a.call('chief_claim_task', { taskId: createdTaskId });
    const fail = await a.call('chief_fail_task', { taskId: createdTaskId, claimId: claim.claimId, reason: 'OUT_OF_SCOPE', detail: '任務要求推送 Git 與部署，超出唯讀範圍。' });
    assert.equal(fail.status, 'FAILED');
    const [task] = await w.tasks();
    assert.equal(task.state, 'FAILED'); assert.deepEqual(task.failure, { code: 'OUT_OF_SCOPE', detail: '任務要求推送 Git 與部署，超出唯讀範圍。' }); assert.equal(task.report, null);
    assert.match(tasksHTML({ tasks: [task] }), /FAILED · 失敗[\s\S]*停止原因：OUT_OF_SCOPE/);
    assert.equal((await a.call('chief_complete_task', { taskId: createdTaskId, claimId: claim.claimId, report: 'late' })).code, 'TASK_NOT_RUNNING');
    assert.equal((await a.call('chief_next_task')).status, 'NO_PENDING_TASK');
    const bad = await a.raw('chief_fail_task', { taskId: createdTaskId, claimId: claim.claimId, reason: 'lower case', detail: '' });
    assert.equal(bad.isError, true, 'reason codes are validated by the tool schema');
  } finally { await a.close(); await w.close(); }
});

await test('M2 Human cancel: a cancelled PENDING task is never offered or claimed; a cancelled RUNNING task refuses the late report', async (dir) => {
  const w = await host(dir), a = await mcpClient(w.data);
  try {
    const first = await w.create('任務一'), second = await w.create('任務二');
    const cancelled = await w.call('POST', `/projects/${M2_PROJECT}/subscription-tasks/${first.createdTaskId}/actions`, { action: 'CANCEL' });
    assert.equal(cancelled.status, 200);
    const next = await a.call('chief_next_task');
    assert.equal(next.task.taskId, second.createdTaskId, 'the cancelled task is skipped');
    assert.equal((await a.call('chief_claim_task', { taskId: first.createdTaskId })).code, 'TASK_NOT_PENDING');
    const claim = await a.call('chief_claim_task', { taskId: second.createdTaskId });
    await w.call('POST', `/projects/${M2_PROJECT}/subscription-tasks/${second.createdTaskId}/actions`, { action: 'CANCEL' });
    assert.equal((await a.call('chief_complete_task', { taskId: second.createdTaskId, claimId: claim.claimId, report: 'late' })).code, 'TASK_NOT_RUNNING');
    const states = Object.fromEntries((await w.tasks()).map((t) => [t.objective, t.state]));
    assert.deepEqual(states, { 任務一: 'CANCELLED', 任務二: 'CANCELLED' });
    const again = await w.call('POST', `/projects/${M2_PROJECT}/subscription-tasks/${second.createdTaskId}/actions`, { action: 'CANCEL' });
    assert.equal(again.status, 409); assert.equal(again.body.error.code, 'TASK_ALREADY_FINISHED');
    const other = await w.call('POST', `/projects/${M2_PROJECT}/subscription-tasks/${second.createdTaskId}/actions`, { action: 'COMPLETE' });
    assert.equal(other.status, 400, 'the Workspace can only cancel');
  } finally { await a.close(); await w.close(); }
});

await test('M2 limited polling: idle polls closer than the interval answer RATE_LIMITED; back-to-back work is not throttled; a session claims at most its limit', async (dir) => {
  const store = new SubscriptionTaskStore(join(dir, 'tasks'));
  let ms = 0;
  const call = await memoryClient(store, { monotonicMs: () => ms, minPollIntervalMs: 5000, maxClaimsPerSession: 2 });
  assert.equal((await call('chief_next_task')).status, 'NO_PENDING_TASK');
  ms = 1000; const limited = await call('chief_next_task');
  assert.equal(limited.status, 'RATE_LIMITED'); assert.equal(limited.retryAfterSeconds, 4);
  ms = 5000; assert.equal((await call('chief_next_task')).status, 'NO_PENDING_TASK');
  for (const name of ['一', '二', '三']) newTask(store, name);
  ms = 10000; const n1 = await call('chief_next_task'); const c1 = await call('chief_claim_task', { taskId: n1.task.taskId });
  ms = 10001; const n2 = await call('chief_next_task');
  assert.equal(n2.status, 'TASK_AVAILABLE', 'a poll right after a claim is answered');
  await call('chief_claim_task', { taskId: n2.task.taskId });
  ms = 10002; const n3 = await call('chief_next_task');
  const limit = await call('chief_claim_task', { taskId: n3.task.taskId });
  assert.equal(limit.isError, true); assert.equal(limit.code, 'SESSION_TASK_LIMIT');
  assert.equal(store.list().filter((t) => t.state === 'PENDING').length, 1);
  assert.equal(c1.status, 'CLAIMED');
});

await test('M2 billing guard (MCP): with an API key variable present every tool refuses, names the variable, never shows its value', async (dir) => {
  const w = await host(dir);
  const a = await mcpClient(w.data, { ...CLEAN_ENV, ANTHROPIC_API_KEY: SECRET });
  try {
    const { createdTaskId } = await w.create();
    const answers = [await a.call('chief_next_task'), await a.call('chief_claim_task', { taskId: createdTaskId }),
      await a.call('chief_complete_task', { taskId: createdTaskId, claimId: '00000000-0000-4000-8000-000000000000', report: 'x' }),
      await a.call('chief_fail_task', { taskId: createdTaskId, claimId: '00000000-0000-4000-8000-000000000000', reason: 'X', detail: '' })];
    for (const r of answers) {
      assert.equal(r.isError, true); assert.equal(r.code, 'BILLING_GUARD_API_ENV_PRESENT'); assert.deepEqual(r.variables, ['ANTHROPIC_API_KEY']);
      assert.ok(!r.text.includes(SECRET));
    }
    assert.ok(a.stderr().includes('BILLING_GUARD_API_ENV_PRESENT') && !a.stderr().includes(SECRET));
    assert.equal((await w.tasks())[0].state, 'PENDING', 'nothing was claimed');
  } finally { await a.close(); await w.close(); }
  for (const name of BILLING_ENV_NAMES) assert.deepEqual(billingEnvPresent({ PATH: '/bin', [name]: '' }), [name], `${name}: presence alone counts`);
  assert.deepEqual(billingEnvPresent({ PATH: '/bin', HOME: '/x', CLAUDE_CODE_SESSION_ID: 's' }), []);
});

await test('M2 MCP surface: exactly four tools; inputs are only ids, claimId, report and reason; no admin, credential, path, command, Authority or deploy capability', async (dir) => {
  const w = await host(dir), a = await mcpClient(w.data);
  try {
    const { tools } = await a.client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort());
    const fields = new Set(tools.flatMap((t) => Object.keys(t.inputSchema.properties ?? {})));
    assert.deepEqual([...fields].sort(), ['claimId', 'detail', 'reason', 'report', 'taskId']);
    const surface = JSON.stringify(tools.map((t) => [t.name, t.title, t.description, t.inputSchema.properties]));
    assert.doesNotMatch(surface, /exec|shell|command|deploy|push|admin|authority|credential|apiKey|api_key|token|path|url/i);
  } finally { await a.close(); await w.close(); }
  // The module graph: the MCP server, store and Workspace port reach no model, provider SDK, governed Worker,
  // Authority Archive, Controller or child process; only the Human-run launcher and Host entry spawn anything.
  const dist = join(ROOT, 'dist', 'subscription');
  const imports = (file) => [...readFileSync(join(dist, file), 'utf8').matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  for (const file of readdirSync(dist).filter((f) => f.endsWith('.js'))) {
    for (const spec of imports(file)) {
      assert.doesNotMatch(spec, /automation|limited-worker|providers|execution|governance|authority|@anthropic-ai|openai|google|intake/, `${file} imports ${spec}`);
      assert.ok(/^(node:(crypto|fs|path|url|child_process)|zod|@modelcontextprotocol\/sdk\/server\/(mcp|stdio)\.js|\.\/[a-z-]+\.js|\.\.\/workspace\/(config|server|subscription-task-port)\.js)$/.test(spec), `${file}: ${spec}`);
    }
    if (!['process-once.js', 'main.js'].includes(file)) assert.ok(!imports(file).includes('node:child_process'), `${file} spawns nothing`);
    // Code only: comments may name what is refused.
    const text = readFileSync(join(dist, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
    assert.doesNotMatch(text, /process\.env\.(ANTHROPIC|CLAUDE)/, `${file} reads no billing variable value`);
    assert.doesNotMatch(text, /dangerously-skip-permissions|bypassPermissions'|--bare|api-key/, file);
  }
  assert.equal(EXE, 'HOLD', 'the M1 API path stays HOLD');
});

// ---------------------------------------------------------------- the Human-run launcher (stand-in claude only)
function stub(dir, authJson) {
  const bin = join(dir, 'bin'), log = join(dir, 'claude-calls.jsonl');
  mkdirSync(bin, { recursive: true });
  const client = join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client');
  // Behaves like `claude -p`: reads the prompt on stdin, starts the MCP server from --mcp-config, works the queue.
  writeFileSync(join(bin, 'claude'), `#!${process.execPath}
const fs = require('fs'), path = require('path');
const argv = process.argv.slice(2);
const names = Object.keys(process.env).filter((n) => /^(ANTHROPIC|CLAUDE_CODE_OAUTH|CLAUDE_CODE_USE)/.test(n));
if (argv[0] === 'auth') { fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, names }) + '\\n'); process.stdout.write(${JSON.stringify(JSON.stringify(authJson))}); process.exit(0); }
let prompt = ''; process.stdin.on('data', (d) => { prompt += d; }).on('end', async () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, cwd: process.cwd(), prompt, names }) + '\\n');
  const cfg = JSON.parse(fs.readFileSync(argv[argv.indexOf('--mcp-config') + 1], 'utf8')).mcpServers['chief-tasks'];
  const { Client } = await import(${JSON.stringify(join(client, 'index.js'))});
  const { StdioClientTransport } = await import(${JSON.stringify(join(client, 'stdio.js'))});
  const c = new Client({ name: 'stand-in-claude', version: '0' });
  await c.connect(new StdioClientTransport({ command: cfg.command, args: cfg.args, env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME } }));
  const call = async (name, args = {}) => JSON.parse((await c.callTool({ name, arguments: args })).content[0].text);
  for (;;) {
    const next = await call('chief_next_task'); if (next.status !== 'TASK_AVAILABLE') break;
    const claim = await call('chief_claim_task', { taskId: next.task.taskId }); if (claim.status !== 'CLAIMED') break;
    const readme = fs.readFileSync(path.join(claim.task.source.workingDirectory, 'README.md'), 'utf8');
    await call('chief_complete_task', { taskId: claim.task.taskId, claimId: claim.claimId, report: '# 替身報告（不是模型）\\n\\nREADME ' + Buffer.byteLength(readme) + ' bytes' });
  }
  await c.close(); console.log('stand-in claude done');
});
`);
  chmodSync(join(bin, 'claude'), 0o755);
  const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  return { bin, calls };
}
function processOnce(data, bin, extraEnv = {}) {
  const r = spawnSync(process.execPath, [PROCESS_ONCE, '--data-dir', data], { encoding: 'utf8', timeout: 60_000, cwd: ROOT,
    env: { ...CLEAN_ENV, PATH: `${bin}:${CLEAN_ENV.PATH}`, ...extraEnv } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

await test('M2 launcher refuses before Claude Code starts: billing variable present (value never printed), API-key or non-subscription login, or no pending task', async (dir) => {
  const w = await host(dir);
  try {
    let s = stub(join(dir, 'a'), SUBSCRIBED);
    // No pending task: nothing starts, no quota.
    let r = processOnce(w.data, s.bin);
    assert.equal(r.code, 0); assert.match(r.out, /沒有待辦任務；沒有啟動 Claude Code/); assert.deepEqual(s.calls(), []);
    await w.create();
    for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK']) {
      r = processOnce(w.data, s.bin, { [name]: SECRET });
      assert.equal(r.code, 2, name); assert.match(r.err, /BILLING_GUARD_API_ENV_PRESENT/); assert.ok(r.err.includes(name));
      assert.ok(!(r.out + r.err).includes(SECRET), `${name} value never printed`);
      assert.deepEqual(s.calls(), [], 'claude was not even asked for its login');
    }
    for (const [auth, code] of [[{ ...SUBSCRIBED, authMethod: 'api_key', subscriptionType: undefined }, 'AUTH_NOT_SUBSCRIPTION'],
      [{ ...SUBSCRIBED, authMethod: 'api_key_helper' }, 'AUTH_NOT_SUBSCRIPTION'], [{ ...SUBSCRIBED, apiKeySource: 'ANTHROPIC_API_KEY' }, 'AUTH_API_KEY_SOURCE_PRESENT'],
      [{ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }, 'CLAUDE_CODE_NOT_LOGGED_IN'], [{ ...SUBSCRIBED, apiProvider: 'bedrock' }, 'AUTH_NOT_FIRST_PARTY'],
      [{ ...SUBSCRIBED, subscriptionType: 'team' }, 'SUBSCRIPTION_NOT_PRO_OR_MAX'], [{ ...SUBSCRIBED, authMethod: 'oauth_token' }, 'AUTH_NOT_SUBSCRIPTION']]) {
      s = stub(join(dir, code + Math.random()), auth);
      r = processOnce(w.data, s.bin);
      assert.equal(r.code, 2, code); assert.match(r.err, new RegExp(code));
      assert.deepEqual(s.calls().map((c) => c.argv.slice(0, 2)), [['auth', 'status']], `${code}: only the login check ran`);
      assert.ok(!(r.out + r.err).includes('person@example.invalid') && !(r.out + r.err).includes('ORG-NAME-HIDDEN'), 'no account details printed');
    }
    assert.equal(subscriptionRefusal('not json'), 'AUTH_STATUS_UNREADABLE'); assert.equal(subscriptionRefusal(null), 'AUTH_STATUS_UNREADABLE');
    assert.equal(subscriptionRefusal(SUBSCRIBED), null); assert.equal(subscriptionRefusal({ ...SUBSCRIBED, subscriptionType: 'max' }), null);
    const missing = processOnce(join(dir, 'never-started'), s.bin);
    assert.equal(missing.code, 2); assert.match(missing.err, /MCP_CONFIG_MISSING/);
    assert.equal((await w.tasks())[0].state, 'PENDING');
  } finally { await w.close(); }
});

await test('M2 launcher E2E: a subscription login passes; Claude Code (stand-in) gets only read tools + the four CHIEF tools, no bypass, and the queue is worked to COMPLETED', async (dir) => {
  const w = await host(dir);
  try {
    await w.create(); await w.create('第二件：列出 README 的章節');
    const s = stub(join(dir, 'ok'), SUBSCRIBED);
    const r = processOnce(w.data, s.bin);
    assert.equal(r.code, 0, r.err); assert.match(r.out, /登入方式：Claude pro 訂閱/); assert.match(r.out, /stand-in claude done/);
    assert.ok(!r.out.includes('person@example.invalid') && !r.out.includes('ORG-NAME-HIDDEN'));
    const [auth, run] = s.calls();
    assert.deepEqual(auth.argv, ['auth', 'status', '--json']);
    assert.equal(run.cwd, ROOT); assert.equal(run.prompt, processingPrompt(3)); assert.deepEqual(run.names, []);
    assert.deepEqual(run.argv, claudeArguments(m2Layout(w.data).mcpConfig));
    const value = (flag) => run.argv[run.argv.indexOf(flag) + 1];
    assert.equal(run.argv[0], '-p'); assert.equal(value('--tools'), 'Read,Glob,Grep'); assert.equal(value('--permission-mode'), 'dontAsk');
    assert.equal(value('--permission-prompts'), 'none'); assert.ok(run.argv.includes('--restricted') && run.argv.includes('--strict-mcp-config'));
    assert.deepEqual(value('--allowedTools').split(','), [...CLAUDE_TOOL_NAMES, 'Read(./**)', 'Glob', 'Grep']);
    for (const tool of ['Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch']) assert.ok(value('--disallowedTools').split(',').includes(tool), tool);
    const settings = JSON.parse(value('--settings')).permissions;
    assert.equal(settings.disableBypassPermissionsMode, 'disable'); assert.deepEqual(settings.allow, [...ALLOWED_TOOLS]);
    for (const deny of ['Read(~/.ssh/**)', 'Read(~/.config/**)', 'Read(**/.env)', ...DENIED_TOOLS]) assert.ok(settings.deny.includes(deny), deny);
    assert.doesNotMatch(run.argv.join(' '), /dangerously|bypassPermissions |--bare|--api-key|ANTHROPIC/);
    const tasks = await w.tasks();
    assert.deepEqual(tasks.map((t) => t.state), ['COMPLETED', 'COMPLETED']);
    assert.ok(tasks.every((t) => /^# 替身報告（不是模型）\n\nREADME \d+ bytes$/.test(t.report)));
    assert.match(r.out, /結果：\n- COMPLETED/);
    // Run it again: nothing pending, Claude Code is not started again (no duplicate execution, no quota).
    const again = processOnce(w.data, s.bin);
    assert.match(again.out, /沒有待辦任務/); assert.equal(s.calls().length, 2);
  } finally { await w.close(); }
});

// ---------------------------------------------------------------- Host, store and UI
await test('M2 Host: private MCP config with absolute node + server path; data directory outside the repo; no governed Worker; queue routes only', async (dir) => {
  assert.throws(() => checkDataDirectory(join(ROOT, 'm2-data'), ROOT), /DATA_DIR_INSIDE_REPOSITORY/);
  assert.throws(() => checkDataDirectory(ROOT, ROOT), /DATA_DIR_INSIDE_REPOSITORY/);
  assert.throws(() => checkDataDirectory('relative/dir', ROOT), /DATA_DIR_MUST_BE_ABSOLUTE/);
  const w = await host(dir);
  try {
    const config = m2Layout(w.data).mcpConfig, st = statSync(config);
    assert.equal(st.mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(config, 'utf8')), { mcpServers: { 'chief-tasks': { type: 'stdio', command: process.execPath, args: [MCP_MAIN, '--data-dir', w.data] } } });
    assert.equal(statSync(m2Layout(w.data).tasks).mode & 0o777, 0o700);
    assert.equal((await w.call('GET', `/projects/${M2_PROJECT}/limited-worker`)).status, 503, 'the M1/M0 Worker is not composed');
    const view = (await w.call('GET', `/projects/${M2_PROJECT}/subscription-tasks`)).body;
    assert.equal(view.executor.billing, 'HUMAN_CLAUDE_SUBSCRIPTION_ONLY'); assert.equal(view.executor.apiCalls, 'NONE');
    assert.deepEqual(view.executor.tools, [...TOOL_NAMES]);
    assert.match(view.executor.runner.processOnce, /npm run m2:process-once -- --data-dir/);
    assert.match(view.executor.runner.mcpAdd, /^cd .* && claude mcp add chief-tasks --scope local -- /);
    assert.match(view.executor.runner.loop, /^\/loop 10m /);
    // Mutations need the Workspace origin and header; queries are refused; unknown projects are refused.
    const base = w.h.url.slice(0, -1), cookie = (await fetch(w.h.url)).headers.get('set-cookie').split(';')[0];
    const forged = await fetch(`${base}/api/v0/projects/${M2_PROJECT}/subscription-tasks`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ objective: 'x' }) });
    assert.equal(forged.status, 403);
    assert.equal((await w.call('GET', `/projects/other/subscription-tasks`)).status, 404);
    assert.equal((await w.call('POST', `/projects/${M2_PROJECT}/subscription-tasks`, { objective: 'x', extra: 1 })).status, 400);
    assert.equal((await w.call('POST', `/projects/${M2_PROJECT}/subscription-tasks`, { objective: 'x'.repeat(2001) })).status, 400);
    assert.equal((await fetch(w.h.url + 'subscription-tasks.js')).status, 200);
  } finally { await w.close(); }
  // A Workspace without the queue (M0 rehearsal, the trusted Host) answers 503 with the code the panel removes itself on.
  const plain = await startWorkspaceServer({ config: parseWorkspaceConfig({ schemaVersion: 1, dataDirectory: join(dir, 'plain'), humanPrincipal: { principalRef: 'human:test' },
    projects: [{ projectId: 'chief', displayName: 'CHIEF', repository: 'x/y' }] }, dir), uiDirectory: join(ROOT, 'workspace-ui'), port: 0 });
  try {
    const cookie = (await fetch(plain.url)).headers.get('set-cookie').split(';')[0];
    const r = await fetch(plain.url + 'api/v0/projects/chief/subscription-tasks', { headers: { cookie } });
    assert.equal(r.status, 503); assert.equal((await r.json()).error.code, 'SUBSCRIPTION_TASKS_UNAVAILABLE');
  } finally { await plain.close(); }
});

await test('M2 store: a tampered ledger is refused, a report over 64 KiB is refused, a leftover write lock fails closed, tasks survive a Host restart', async (dir) => {
  const store = new SubscriptionTaskStore(join(dir, 'tasks'));
  const task = newTask(store);
  const { claimId } = store.claim(task.taskId, 'claude-code', new Date().toISOString());
  assert.throws(() => store.complete(task.taskId, claimId, 'x'.repeat(65537), new Date().toISOString()), /REPORT_TOO_LARGE/);
  assert.throws(() => store.complete(task.taskId, claimId, '   ', new Date().toISOString()), /REPORT_REQUIRED/);
  store.complete(task.taskId, claimId, '# 報告', new Date().toISOString());
  const reopened = new SubscriptionTaskStore(join(dir, 'tasks'));
  assert.equal(reopened.list()[0].state, 'COMPLETED');
  const ledger = join(dir, 'tasks', 'ledger.json'), original = readFileSync(ledger, 'utf8');
  writeFileSync(ledger, original.replace('# 報告', '# 改過'));
  assert.throws(() => reopened.list(), /TASK_STORE_INTEGRITY/);
  writeFileSync(ledger, original);
  writeFileSync(join(dir, 'tasks', 'write.lock'), '99999', { mode: 0o600 });
  const started = Date.now();
  assert.throws(() => newTask(reopened), /TASK_STORE_BUSY/);
  assert.ok(Date.now() - started >= 1900, 'the lock is waited for, then refused');
  assert.equal(reopened.list().length, 1, 'nothing changed');
  rmSync(join(dir, 'tasks', 'write.lock'));
  chmodSync(join(dir, 'tasks'), 0o755);
  assert.throws(() => new SubscriptionTaskStore(join(dir, 'tasks')), /TASK_STORE_UNSAFE/);
});

await test('M2 UI: the panel shows PENDING / RUNNING / COMPLETED / FAILED, the report, and how to start Claude Code; no other Host shows it; no activation wording', async () => {
  const html = subscriptionHTML();
  assert.match(html, /交給 Claude Code/); assert.match(html, /CHIEF 不呼叫任何 API/);
  const at = '2026-11-02T00:00:00.000Z';
  const base = { objective: '<script>x</script>', createdAt: at, claimedAt: null, finishedAt: null, report: null, failure: null, source, events: [] };
  const view = tasksHTML({ tasks: [{ ...base, taskId: '11111111-1111-4111-8111-111111111111', state: 'PENDING' },
    { ...base, taskId: '22222222-2222-4222-8222-222222222222', state: 'RUNNING', claimedAt: at },
    { ...base, taskId: '33333333-3333-4333-8333-333333333333', state: 'COMPLETED', report: '## 結論\n\n<img src=x onerror=alert(1)>' },
    { ...base, taskId: '44444444-4444-4444-8444-444444444444', state: 'FAILED', failure: { code: 'OUT_OF_SCOPE', detail: '<b>x</b>' } }] });
  for (const state of ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED']) assert.ok(view.includes(`${state} · ${SUB_LABELS[state]}`), state);
  assert.doesNotMatch(view, /<script>|<img|<b>/, 'objective, report and failure are escaped or rendered as safe Markdown');
  assert.equal((view.match(/data-sub-cancel/g) ?? []).length, 2, 'cancel only for PENDING and RUNNING');
  assert.match(runnerHTML({ runner: { processOnce: 'P', mcpAdd: 'M', interactive: 'I', loop: '/loop 10m X' } }), /\/status[\s\S]*額外使用額度[\s\S]*P[\s\S]*M\nI[\s\S]*\/loop 10m X/);
  const ui = ['subscription-tasks.js', 'automation.js', 'live.js'].map((f) => readFileSync(join(ROOT, 'workspace-ui', f), 'utf8')).join('\n');
  assert.doesNotMatch(ui, /activation|\/authority/i);
  assert.match(readFileSync(join(ROOT, 'workspace-ui', 'subscription-tasks.js'), 'utf8'), /SUBSCRIPTION_TASKS_UNAVAILABLE'\) \{ clearInterval\(timer\); root\.remove\(\)/);
  const asked = [];
  const live = createLiveSource({ fetchImpl: async (url, init) => { asked.push([url, init.method]); return { ok: true, json: async () => ({}) }; }, EventSourceImpl: class {} });
  await live.subscriptionTasks('chief'); await live.createSubscriptionTask('chief', { objective: 'x' }); await live.subscriptionTaskAction('chief', 't', { action: 'CANCEL' });
  assert.deepEqual(asked, [['/api/v0/projects/chief/subscription-tasks', 'GET'], ['/api/v0/projects/chief/subscription-tasks', 'POST'], ['/api/v0/projects/chief/subscription-tasks/t/actions', 'POST']]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
