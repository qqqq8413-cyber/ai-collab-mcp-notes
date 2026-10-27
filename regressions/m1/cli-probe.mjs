#!/usr/bin/env node
// M1-C non-paid probe of the REAL Claude Code CLI (not a synthetic executable).
//
// The pinned `claude` binary runs under Seatbelt with outbound network allowed to localhost only, an empty HOME and
// CLAUDE_CONFIG_DIR, no keychain access and a dummy API key, against a fake local Messages API that records every
// request. No real credential is readable and no provider is reachable, so no model call or charge is possible.
// It measures what one CLI invocation actually sends: flags accepted, requests per turn, retries, the turn limit.
//
//   node regressions/m1/cli-probe.mjs <claude executable> <out.json>
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [executableArg, out] = process.argv.slice(2);
if (!executableArg || !out) { console.error('usage: cli-probe.mjs <claude> <out.json>'); process.exit(2); }
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const { readerArguments, readerEnvironment, readerPrompt, READER_REPORT_SCHEMA } = await import(join(ROOT, 'dist/limited-worker/claude-code-reader.js'));
const { MODEL } = await import(join(ROOT, 'dist/limited-worker/contract.js'));
const executable = realpathSync(executableArg);
const sha256 = createHash('sha256').update(readFileSync(executable)).digest('hex');
const version = execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 20000, env: { PATH: '/usr/bin:/bin', HOME: tmpdir() } }).trim();
const README = execFileSync('/usr/bin/git', ['-C', ROOT, 'show', 'a3164fd12d6d3129978da32ea024854d6e9b5cdc:README.md']);
const DUMMY_KEY = 'sk-ant-api03-FAKE-LOCAL-PROBE-NOT-A-REAL-KEY';

// A contract-shaped object only for readerArguments/readerPrompt: the real argv the M0 transport would pass.
const contract = { agentId: 'claude-code-reader', maxTurns: 3, maxInputTokens: 200000, maxOutputTokens: 2048,
  quote: { inputMicroUsdPerToken: 1, outputMicroUsdPerToken: 5 }, maxCostMicroUsd: 1000000, totalCostMicroUsd: 1000000,
  sourceSha: 'a3164fd12d6d3129978da32ea024854d6e9b5cdc', sourceBytes: README.length, sourceHash: createHash('sha256').update(README).digest('hex') };

const sse = (events) => events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
const usage = { input_tokens: 1200, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
function message(id, blocks, stop) {
  const events = [['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: MODEL, content: [],
    stop_reason: null, stop_sequence: null, usage } }]];
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } }]);
    } else {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } }]);
    }
    events.push(['content_block_stop', { type: 'content_block_stop', index }]);
  });
  events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 40 } }]);
  events.push(['message_stop', { type: 'message_stop' }]);
  return sse(events);
}

/** One fake provider per scenario; `reply(n, body)` answers the n-th /v1/messages request (1-based). */
function provider(reply) {
  const log = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (b) => { raw += b; });
    req.on('end', () => {
      let body = null; try { body = JSON.parse(raw); } catch { /* not JSON */ }
      const entry = { method: req.method, path: req.url, apiKeyIsDummy: req.headers['x-api-key'] === DUMMY_KEY,
        authorizationHeader: req.headers.authorization ? 'PRESENT' : 'ABSENT', userAgent: String(req.headers['user-agent'] ?? '').slice(0, 80) };
      if (body) Object.assign(entry, { model: body.model, maxTokens: body.max_tokens, stream: body.stream === true, messages: body.messages?.length,
        tools: (body.tools ?? []).map((t) => t.name), toolChoice: body.tool_choice?.type ?? null, thinking: body.thinking?.type ?? null,
        systemBlocks: Array.isArray(body.system) ? body.system.length : body.system ? 1 : 0,
        cacheControl: JSON.stringify(body).includes('cache_control'), metadata: body.metadata ? Object.keys(body.metadata) : [] });
      log.push(entry);
      if (!/^\/v1\/messages(\?|$)/.test(req.url)) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"type":"error","error":{"type":"not_found_error","message":"probe"}}'); return; }
      const n = log.filter((e) => /^\/v1\/messages(\?|$)/.test(e.path)).length;
      const r0 = reply(n, body ?? {}), r = typeof r0 === 'string' ? { sse: r0 } : r0;
      if (r.empty) { res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': `req_probe_${n}` }); res.end(); return; }
      if (body && body.stream !== true && r.sse) { res.writeHead(200, { 'content-type': 'application/json', 'request-id': `req_probe_${n}` }); res.end(JSON.stringify(r.json ?? { type: 'error' })); return; }
      if (r.status) { res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers ?? {}) }); res.end(JSON.stringify({ type: 'error', error: { type: r.errorType, message: r.message ?? 'probe' } })); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': `req_probe_${n}` }); res.end(r.sse);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, log, port: server.address().port })));
}

const HOME = homedir();
const PROFILE = `(version 1)
(allow default)
(deny network-outbound)
(allow network-outbound (remote ip "localhost:*"))
(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd") (global-name "com.apple.security.agent"))
(deny process-exec (literal "/usr/bin/security"))
(deny file-read* (subpath "${HOME}/.claude") (literal "${HOME}/.claude.json") (subpath "${HOME}/Library/Keychains") (subpath "${HOME}/.config"))`;

async function scenario(name, { args, env = {}, reply, stdin }) {
  const fake = await provider(reply);
  const base = mkdtempSync(join(tmpdir(), 'chief-m1-cli-probe-')), home = join(base, 'home'), workspace = join(base, 'workspace');
  mkdirSync(home, { mode: 0o700 }); mkdirSync(workspace, { mode: 0o700 });
  writeFileSync(join(workspace, 'README.md'), README, { mode: 0o600 });
  const childEnv = { PATH: '/usr/bin:/bin', HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), TMPDIR: base,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${fake.port}`, ANTHROPIC_API_KEY: DUMMY_KEY, ...env };
  const started = Date.now();
  const result = await new Promise((resolve) => {
    const child = spawn('/usr/bin/sandbox-exec', ['-p', PROFILE, executable, ...args], { cwd: workspace, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
    child.stdout.on('data', (b) => { stdout += b; }); child.stderr.on('data', (b) => { stderr += b; });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    child.stdin.on('error', () => {}); child.stdin.end(stdin ?? 'ping\n');
  });
  fake.server.close(); rmSync(base, { recursive: true, force: true });
  let parsed = null; try { parsed = JSON.parse(result.stdout); } catch { /* not JSON */ }
  const summary = parsed && typeof parsed === 'object' ? { type: parsed.type, subtype: parsed.subtype, is_error: parsed.is_error, num_turns: parsed.num_turns,
    total_cost_usd: parsed.total_cost_usd, usage: parsed.usage ? { input_tokens: parsed.usage.input_tokens, output_tokens: parsed.usage.output_tokens,
      cache_creation_input_tokens: parsed.usage.cache_creation_input_tokens, cache_read_input_tokens: parsed.usage.cache_read_input_tokens } : null,
    modelUsage: parsed.modelUsage ? Object.keys(parsed.modelUsage) : null, structured_output: parsed.structured_output ?? null,
    result: typeof parsed.result === 'string' ? parsed.result.slice(0, 200) : null, errors: parsed.errors ?? null } : null;
  const messages = fake.log.filter((e) => /^\/v1\/messages(\?|$)/.test(e.path));
  return { name, exitCode: result.code, signal: result.signal, durationMs: Date.now() - started, messagesRequests: messages.length,
    otherRequests: fake.log.filter((e) => !/^\/v1\/messages(\?|$)/.test(e.path)).map((e) => `${e.method} ${e.path}`),
    requests: fake.log, stdoutJson: summary, stdoutHead: summary ? null : result.stdout.slice(0, 400), stderrHead: result.stderr.slice(0, 400) };
}

const READER_ARGS = readerArguments(contract), READER_ENV = readerEnvironment(contract), PROMPT = readerPrompt(contract, 'Summarise the README.');
const REPORT = JSON.stringify({ report: '# probe\nfake provider report' });
// The final answer: through the structured-output tool when the CLI offers one, else as JSON text.
const finalAnswer = (n, body) => {
  const tool = (body.tools ?? []).map((t) => t.name).find((t) => /structured/i.test(t));
  return tool ? message(`msg_probe_${n}`, [{ type: 'tool_use', id: `toolu_final_${n}`, name: tool, input: { report: '# probe\nfake provider report' } }], 'tool_use')
    : message(`msg_probe_${n}`, [{ type: 'text', text: REPORT }], 'end_turn');
};
const readTool = (n) => message(`msg_probe_${n}`, [{ type: 'tool_use', id: `toolu_read_${n}`, name: 'Read', input: { file_path: 'README.md' } }], 'tool_use');
const scenarios = [];
const STRICT = { ...READER_ENV, CLAUDE_CODE_MAX_RETRIES: '0', CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1', CLAUDE_CODE_DISABLE_THINKING: '1', MAX_THINKING_TOKENS: '0' };
const run = (name, env, reply) => scenario(name, { args: READER_ARGS, env, stdin: PROMPT, reply });
// 0. Calibration: an unknown flag is refused by the parser, before any request.
scenarios.push(await scenario('unknown-flag-calibration', { args: ['-p', '--output-format', 'json', '--chief-nonexistent-flag'], reply: (n, b) => finalAnswer(n, b) }));
// 1-3. The exact M0 argv and environment: direct answer, one Read turn, a tool request on every turn (turn limit).
scenarios.push(await run('m0-direct-answer', READER_ENV, (n, b) => finalAnswer(n, b)));
scenarios.push(await run('m0-one-read-turn', READER_ENV, (n, b) => n === 1 ? readTool(n) : finalAnswer(n, b)));
scenarios.push(await run('m0-always-tool', READER_ENV, (n) => readTool(n)));
// 4-5. Failures with the M0 environment: one 529 (default retries), and an empty 200 stream (non-streaming fallback).
scenarios.push(await run('m0-one-529', READER_ENV, (n, b) => n === 1 ? { status: 529, errorType: 'overloaded_error' } : finalAnswer(n, b)));
scenarios.push(await run('m0-empty-stream', READER_ENV, (n, b) => n === 1 ? { empty: true } : finalAnswer(n, b)));
// 6-10. The same with retries, the non-streaming fallback and thinking switched off by environment.
scenarios.push(await run('strict-direct-answer', STRICT, (n, b) => finalAnswer(n, b)));
scenarios.push(await run('strict-always-tool', STRICT, (n) => readTool(n)));
scenarios.push(await run('strict-one-529', STRICT, (n, b) => n === 1 ? { status: 529, errorType: 'overloaded_error' } : finalAnswer(n, b)));
scenarios.push(await run('strict-empty-stream', STRICT, (n, b) => n === 1 ? { empty: true } : finalAnswer(n, b)));
scenarios.push(await run('strict-always-500', STRICT, () => ({ status: 500, errorType: 'api_error' })));
// 11-13. Paths that could add requests inside one turn: output cut at max_tokens, an answer that skips the
// structured-output tool, and a prompt-too-long refusal (compaction).
const cut = (n) => message(`msg_probe_${n}`, [{ type: 'text', text: 'partial answer' }], 'max_tokens');
const plain = (n) => message(`msg_probe_${n}`, [{ type: 'text', text: 'plain text, no structured output tool' }], 'end_turn');
scenarios.push(await run('strict-max-tokens-stop', STRICT, (n, b) => n === 1 ? cut(n) : finalAnswer(n, b)));
scenarios.push(await run('strict-plain-text-answer', STRICT, (n) => plain(n)));
scenarios.push(await run('strict-prompt-too-long', STRICT, (n, b) => n === 1 ? { status: 400, errorType: 'invalid_request_error', message: 'prompt is too long: 250000 tokens > 200000 maximum' } : finalAnswer(n, b)));
scenarios.push(await run('m0-max-tokens-stop', READER_ENV, (n, b) => n === 1 ? cut(n) : finalAnswer(n, b)));
// 14-15. Caps: every answer cut at max_tokens, and every answer skipping the structured-output tool.
scenarios.push(await run('strict-always-max-tokens-stop', STRICT, (n) => cut(n)));
scenarios.push(await run('strict-always-plain-text', STRICT, (n) => plain(n)));

const report = { schema: 'chief-m1-cli-probe.v1', recordClass: 'OPERATIONAL_RECORD', evidenceClass: 'REAL_CLI_FAKE_LOCAL_PROVIDER',
  notice: 'Real Claude Code binary against a fake local Messages API; network limited to localhost by Seatbelt; dummy key; no provider reachable, no paid call.',
  at: new Date().toISOString(), platform: `${process.platform} ${process.arch}`, node: process.version,
  executable: { path: executable, sha256, version, bytes: readFileSync(executable).length }, model: MODEL,
  readerArguments: READER_ARGS, readerEnvironment: READER_ENV, readerReportSchema: READER_REPORT_SCHEMA, scenarios };
writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
for (const s of scenarios) console.log(`${s.name}: exit=${s.exitCode} messages=${s.messagesRequests} other=${s.otherRequests.length} turns=${s.stdoutJson?.num_turns ?? '-'} subtype=${s.stdoutJson?.subtype ?? '-'} ${s.stdoutJson ? '' : JSON.stringify((s.stdoutHead || s.stderrHead).slice(0, 160))}`);
