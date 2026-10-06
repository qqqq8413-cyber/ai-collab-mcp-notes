import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// WS-L1 automation boundary for the Node production code under src/workspace.
//
// MACHINE-ENFORCED here:
//   - module dependency isolation: the transitive import graph of src/workspace stays inside
//     src/workspace plus the pure canonical identity module, and every external import is an allowlisted capability;
//   - no Controller / AutomationRunner / Claude / Codex / provider adapter dependency, by import
//     graph, by API name, and by the modules Node actually loads at runtime;
//   - no child process (no child_process capability, none loaded, none spawned from workspace code);
//   - no outbound Node network client path: node:http is limited to its inbound server
//     primitives; node:net, node:https, node:tls, node:dgram, node:dns, node:http2, undici and
//     global fetch / WebSocket / XMLHttpRequest / EventSource are refused, and so are the ways
//     around an import (dynamic import, require, createRequire, process.getBuiltinModule,
//     process.binding, globalThis);
//   - no execution API route, and a loopback-only listener (test-workspace-server.mjs).
// NOT PROVEN by this guard: OS-level sandboxing; filesystem isolation from Controller authority
// storage (the goal store could still be pointed at any directory the OS lets it write);
// authenticated Human identity; R4T authority-store writable-root isolation. This is a source
// and module guard over src/workspace, not a security sandbox. The browser code in
// workspace-ui/ is outside it and may fetch its own same-origin /api/v0 routes.

const WHY = 'WS-L1 queue is non-authoritative and may not start execution';
const ROOT = process.cwd();
const CANONICAL_IDENTITY = 'src/identity/canonical.ts';

// The capabilities src/workspace may import, by exact named import. A default or namespace
// import of a built-in is refused because it would hand over the whole module (http.request,
// http.get, ...). Widening this list is an Architect decision.
const CAPABILITIES = Object.freeze({
  'node:crypto': ['createHash', 'randomUUID'],
  'node:fs': ['closeSync', 'existsSync', 'fstatSync', 'fsyncSync', 'lstatSync', 'mkdirSync', 'openSync', 'readFileSync',
    'renameSync', 'unlinkSync', 'writeFileSync'],
  'node:path': ['dirname', 'isAbsolute', 'join', 'resolve'],
  'node:url': ['fileURLToPath'],
  // Inbound server primitives only: no request, get, Agent, or globalAgent.
  'node:http': ['createServer', 'IncomingMessage', 'Server', 'ServerResponse'],
  zod: ['z'],
});
const NEVER = new Set(['node:net', 'node:tls', 'node:https', 'node:dgram', 'node:dns', 'node:child_process', 'node:worker_threads',
  'node:http2', 'node:cluster', 'node:vm', 'node:inspector', 'undici']);
// Ways to reach a module or the network without a static import.
const ESCAPES = [
  [/\bimport\s*\(/, 'dynamic import()'],
  [/\brequire\s*\(/, 'require()'],
  [/\bcreateRequire\b/, 'createRequire'],
  [/\bgetBuiltinModule\b/, 'process.getBuiltinModule'],
  [/\bprocess\s*\.\s*binding\b|\b_linkedBinding\b/, 'process.binding'],
  [/\bglobalThis\b|\bglobal\s*\./, 'globalThis'],
  [/(?<![\w$.-])fetch(?![\w$-])/, 'global fetch'],
  [/\b(XMLHttpRequest|WebSocket|EventSource)\b/, 'a global network client'],
];
// The surfaces that create runs or execute models, named so a failure says what was reached.
const FORBIDDEN = [
  [/^src\/automation\/(controller|durable-store|audit|runner|bridge|lifecycle|packet|policy)\.ts$/, 'Controller.createRun / ControllerStore.create / AutomationRunner step or drive'],
  [/^src\/automation\/live\//, 'Claude Code / Codex execution adapters or live run composition'],
  [/^src\/automation\//, 'automation runtime'],
  [/^src\/(providers|execution|modes|agents|consultation|context|stress-test)\//, 'provider SDK or model execution'],
];

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS ${name}`); passed++; }
  catch (error) { console.error(`  FAIL ${name}: ${error.message}`); failed++; }
}

/** Source with comments removed; comments may explain the boundary, code may not cross it. */
function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}
function normalize(specifier) {
  return !specifier.startsWith('node:') && builtinModules.includes(specifier.split('/')[0]) ? `node:${specifier}` : specifier;
}

/** Every import or re-export statement: its module and how it binds (named names, default, namespace, all, bare). */
function importsOf(source) {
  const found = [];
  const statement = /(?:^|[;\n])\s*(import|export)\s+(?:type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]|(?:^|[;\n])\s*import\s*['"]([^'"]+)['"]/g;
  for (const m of code(source).matchAll(statement)) {
    if (m[4]) { found.push({ specifier: m[4], bare: true, names: [] }); continue; }
    const clause = m[2].trim();
    const entry = { specifier: m[3], names: [], namespace: false, whole: false, defaultName: false };
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) {
      entry.names = braces[1].split(',').map((part) => part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim()).filter(Boolean);
    }
    const outside = clause.replace(/\{[^}]*\}/, '').replace(/,/g, ' ').trim();
    if (/\*/.test(outside)) { if (m[1] === 'export' && !/\bas\b/.test(outside)) entry.whole = true; else entry.namespace = true; }
    else if (outside) entry.defaultName = true;
    found.push(entry);
  }
  return found;
}

/**
 * The source rule. Returns every reason a src/workspace module breaks the boundary; empty when it holds.
 * Applied to the real files below, and to probes that show it refuses each forbidden path.
 */
function violations(source) {
  const out = [];
  const body = code(source);
  for (const [pattern, label] of ESCAPES) if (pattern.test(body)) out.push(`uses ${label}`);
  for (const entry of importsOf(source)) {
    const specifier = normalize(entry.specifier);
    if (specifier.startsWith('.')) continue; // the import graph check decides where relative imports may lead
    if (NEVER.has(specifier)) { out.push(`imports ${specifier}`); continue; }
    const allowed = CAPABILITIES[specifier];
    if (!allowed) { out.push(`imports ${specifier}, which is not an allowed Workspace capability`); continue; }
    if (entry.bare || entry.namespace || entry.whole || entry.defaultName) { out.push(`imports all of ${specifier} instead of named capabilities`); continue; }
    for (const name of entry.names) if (!allowed.includes(name)) out.push(`imports ${name} from ${specifier}`);
  }
  return out;
}

/** Every module reachable from src/workspace; leaving src/workspace is reported, not traversed. */
function importGraph() {
  const start = readdirSync('src/workspace').filter((name) => name.endsWith('.ts')).map((name) => resolve('src/workspace', name));
  const seen = new Set();
  const queue = [...start];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const { specifier } of importsOf(readFileSync(file, 'utf8'))) {
      if (!specifier.startsWith('.')) continue;
      const target = resolve(dirname(file), specifier.replace(/\.js$/, '.ts'));
      if (!existsSync(target)) throw new Error(`${relative(ROOT, file)} imports missing ${specifier}`);
      if (relative(ROOT, target).startsWith('src/workspace/') || relative(ROOT, target) === CANONICAL_IDENTITY) queue.push(target);
      else seen.add(target);
    }
  }
  return [...seen].map((file) => relative(ROOT, file));
}
const workspaceFiles = () => readdirSync('src/workspace').filter((name) => name.endsWith('.ts')).map((name) => join('src/workspace', name));
const guardedFiles = () => [...workspaceFiles(), CANONICAL_IDENTITY];

check('the static import graph of src/workspace stays inside src/workspace', () => {
  const files = importGraph();
  for (const file of files) {
    const hit = FORBIDDEN.find(([pattern]) => pattern.test(file));
    assert.ok(!hit, `${WHY}: src/workspace reaches ${file} (${hit?.[1]})`);
    assert.ok(file.startsWith('src/workspace/') || file === CANONICAL_IDENTITY, `${WHY}: src/workspace reaches ${file}`);
  }
  assert.ok(files.length >= 4);
});

check('every src/workspace module imports only allowlisted capabilities and has no outbound network path', () => {
  for (const file of guardedFiles()) {
    const found = violations(readFileSync(file, 'utf8'));
    assert.deepEqual(found, [], `${WHY}: ${file} ${found.join('; ')}`);
  }
});

check('node:http is used only for the inbound server', () => {
  const used = workspaceFiles().flatMap((file) => importsOf(readFileSync(file, 'utf8')))
    .filter((entry) => normalize(entry.specifier) === 'node:http').flatMap((entry) => entry.names);
  assert.ok(used.includes('createServer'), 'the Workspace server is built with createServer');
  assert.deepEqual(used.filter((name) => !['createServer', 'IncomingMessage', 'Server', 'ServerResponse'].includes(name)), []);
});

check('src/workspace names no run-creation or execution API', () => {
  const names = /\b(createRun|AutomationController|AutomationRunner|FileControllerStore|ControllerStore|createLiveAutomation|ClaudeCodeImplementationAdapter|CodexArchitectReviewAdapter|beginImplementation|issuePacket|resumeHuman|requestPromotion|child_process|spawn|execFile)\b/g;
  for (const file of workspaceFiles()) {
    const hits = [...new Set([...code(readFileSync(file, 'utf8')).matchAll(names)].map((m) => m[1]))];
    assert.deepEqual(hits, [], `${WHY}: ${file} refers to ${hits.join(', ')}`);
  }
});

// Regression: the same rule, given sources that cross the boundary, must refuse each of them.
check('the rule refuses each outbound or execution path and keeps the inbound server', () => {
  const server = readFileSync('src/workspace/server.ts', 'utf8');
  const refused = [
    ['node:net client import', "import { connect } from 'node:net';"],
    ['node:net type-only import', "import type { AddressInfo } from 'node:net';"],
    ['bare net import', "import { createConnection } from 'net';"],
    ['node:http request', "import { createServer, request } from 'node:http';"],
    ['node:http get', "import { get } from 'node:http';"],
    ['node:http Agent', "import { Agent } from 'node:http';"],
    ['node:http namespace', "import * as http from 'node:http';\nhttp.get('http://example.com');"],
    ['node:http default', "import http from 'node:http';"],
    ['node:http re-export', "export { request } from 'node:http';"],
    ['node:https client', "import { request } from 'node:https';"],
    ['node:tls client', "import { connect } from 'node:tls';"],
    ['node:dns lookup', "import { lookup } from 'node:dns';"],
    ['node:dgram socket', "import { createSocket } from 'node:dgram';"],
    ['child_process', "import { spawn } from 'node:child_process';"],
    ['worker_threads', "import { Worker } from 'node:worker_threads';"],
    ['undici', "import { request } from 'undici';"],
    ['global fetch call', "await fetch('https://example.com');"],
    ['global fetch reference', 'const send = fetch;'],
    ['globalThis.fetch', "globalThis.fetch('https://example.com');"],
    ['WebSocket', "new WebSocket('wss://example.com');"],
    ['dynamic import', "const m = await import('node:https');"],
    ['require', "const net = require('node:net');"],
    ['getBuiltinModule', "process.getBuiltinModule('node:https');"],
    ['an unlisted package', "import Anthropic from '@anthropic-ai/sdk';"],
  ];
  for (const [label, line] of refused) {
    assert.notDeepEqual(violations(`${line}\n${server}`), [], `the rule must refuse ${label}`);
  }
  const accepted = [
    ['inbound createServer', "import { createServer, type IncomingMessage } from 'node:http';"],
    ['the Sec-Fetch-Site header name', "const site = request.headers['sec-fetch-site'];"],
    ['a property named fetch', 'const x = cache.fetch;'],
  ];
  for (const [label, line] of accepted) assert.deepEqual(violations(line), [], `the rule must allow ${label}`);
  assert.deepEqual(violations(server), [], 'the real server passes the rule');
});

check('the import graph check catches a forbidden import', () => {
  const [{ specifier }] = importsOf("import { AutomationRunner } from '../automation/runner.js';");
  const target = relative(ROOT, resolve('src/workspace', specifier.replace(/\.js$/, '.ts')));
  assert.ok(FORBIDDEN.some(([pattern]) => pattern.test(target)), 'the forbidden list must match automation/runner.ts');
});

check('at runtime the server loads no automation, provider, or execution module and opens no outbound connection', () => {
  // Every outbound primitive is wrapped before the server loads; a call is charged to the Workspace
  // when dist/workspace is on its stack. The harness itself talks to the server with fetch.
  const script = `
    import { registerHooks, syncBuiltinESMExports } from 'node:module';
    import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import tls from 'node:tls';
    import dgram from 'node:dgram'; import dns from 'node:dns'; import cp from 'node:child_process';
    const loaded = new Set(); const outbound = [];
    registerHooks({ resolve(specifier, context, next) { const result = next(specifier, context); loaded.add(result.url); return result; } });
    const watch = (owner, name, label) => { const original = owner[name]; owner[name] = function (...args) {
      if (/dist\\/workspace\\//.test(new Error().stack)) outbound.push(label); return original.apply(this, args); }; };
    watch(http, 'request', 'http.request'); watch(http, 'get', 'http.get'); watch(https, 'request', 'https.request'); watch(https, 'get', 'https.get');
    watch(net, 'connect', 'net.connect'); watch(net, 'createConnection', 'net.createConnection'); watch(net.Socket.prototype, 'connect', 'socket.connect');
    watch(tls, 'connect', 'tls.connect'); watch(dgram, 'createSocket', 'dgram.createSocket');
    // Node's listen() resolves its own bind address through dns.lookup (lookupAndListen). That is the
    // inbound listener, so it is recorded separately and must be exactly 127.0.0.1; any other lookup is outbound.
    const binds = []; const lookup = dns.lookup;
    dns.lookup = function (host, ...rest) { const stack = new Error().stack;
      if (stack.includes('dist/workspace/')) (/lookupAndListen/.test(stack) ? binds : outbound).push(/lookupAndListen/.test(stack) ? host : 'dns.lookup ' + host);
      return lookup.call(this, host, ...rest); };
    for (const name of ['spawn', 'exec', 'execFile', 'fork', 'spawnSync', 'execSync', 'execFileSync']) watch(cp, name, 'child_process.' + name);
    watch(globalThis, 'fetch', 'fetch');
    syncBuiltinESMExports();
    const { parseWorkspaceConfig } = await import('./dist/workspace/config.js');
    const { startWorkspaceServer } = await import('./dist/workspace/server.js');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(tmpdir() + '/chief-ws-boundary-');
    const config = parseWorkspaceConfig({ schemaVersion: 1, dataDirectory: dir,
      humanPrincipal: { principalRef: 'human:local-owner' },
      projects: [{ projectId: 'cand', displayName: 'C', repository: 'r' }] }, dir);
    const ws = await startWorkspaceServer({ config, uiDirectory: 'workspace-ui', port: 0 });
    const bootstrap = await fetch(ws.url);
    const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
    const headers = { Origin: 'http://127.0.0.1:' + ws.port, 'X-Chief-Workspace': '1', 'Content-Type': 'application/json', Cookie: cookie };
    const created = await (await fetch(ws.url + 'api/v0/projects/cand/goals', { method: 'POST', headers, body: JSON.stringify({ text: 'x' }) })).json();
    const { 'Content-Type': _contentType, ...deleteHeaders } = headers;
    const removed = await fetch(ws.url + 'api/v0/projects/cand/goals/' + created.goal.goalId, { method: 'DELETE', headers: deleteHeaders });
    await ws.close();
    console.log(JSON.stringify({ loaded: [...loaded], outbound, binds, created: !!created.goal, removed: removed.status }));`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout.trim().split('\n').at(-1));
  assert.equal(result.created, true, 'goal create still works');
  assert.equal(result.removed, 200, 'goal delete still works');
  const local = result.loaded.filter((url) => url.startsWith('file:')).map((url) => relative(ROOT, fileURLToPath(url)));
  const bad = local.filter((file) => file.startsWith('dist/') && !file.startsWith('dist/workspace/') &&
    file !== 'dist/identity/canonical.js');
  assert.deepEqual(bad, [], `${WHY}: the running server loaded ${bad.join(', ')}`);
  assert.ok(!result.loaded.some((url) => /@anthropic-ai|\/openai\/|@google\/generative-ai|@modelcontextprotocol/.test(url)),
    `${WHY}: the running server loaded a provider or MCP package`);
  assert.deepEqual(result.outbound, [], `${WHY}: workspace code opened ${result.outbound.join(', ')}`);
  assert.deepEqual(result.binds, ['127.0.0.1'], 'the only address lookup is listen() resolving the loopback bind address');
  assert.ok(local.includes('dist/workspace/server.js'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
