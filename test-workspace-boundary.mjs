import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

// WS-L1 boundary: the Workspace server and goal store may not reach run creation or
// model execution. Checked twice: statically over the import graph of src/workspace
// (every module it can transitively import, read the way the other source checks in
// this repository read imports, with dynamic import and require ruled out), and at
// runtime by recording every module Node actually loads while the server starts and
// handles requests.

const WHY = 'WS-L1 queue is non-authoritative and may not start execution';
const ROOT = process.cwd();
const ALLOWED_PACKAGES = new Set(['zod']);
// Node built-ins the Workspace needs. child_process, worker_threads, vm, and net clients are absent on purpose.
const ALLOWED_BUILTINS = new Set(['node:crypto', 'node:fs', 'node:path', 'node:http', 'node:net', 'node:url']);
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

/** Static imports of one module. Dynamic import, require, and createRequire are refused outright, so this is the whole list. */
function importsOf(file) {
  const source = readFileSync(file, 'utf8');
  assert.doesNotMatch(source, /\bimport\s*\(|\brequire\s*\(|createRequire/, `${WHY}: ${relative(ROOT, file)} loads modules dynamically`);
  return [...source.matchAll(/^\s*(?:import|export)\b[^'"]*?\bfrom\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm)].map((m) => m[1] ?? m[2]);
}

/** Every module reachable from src/workspace. */
function importGraph() {
  const start = readdirSync('src/workspace').filter((name) => name.endsWith('.ts')).map((name) => resolve('src/workspace', name));
  const seen = new Set();
  const external = new Map(); // specifier -> importing file
  const queue = [...start];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of importsOf(file)) {
      if (specifier.startsWith('.')) {
        const target = resolve(dirname(file), specifier.replace(/\.js$/, '.ts'));
        if (!existsSync(target)) throw new Error(`${relative(ROOT, file)} imports missing ${specifier}`);
        // Leaving src/workspace is already the violation; it is reported, not traversed.
        if (relative(ROOT, target).startsWith('src/workspace/')) queue.push(target); else seen.add(target);
      } else external.set(specifier, relative(ROOT, file));
    }
  }
  return { files: [...seen].map((file) => relative(ROOT, file)), external };
}

check('the static import graph of src/workspace stays inside src/workspace', () => {
  const { files, external } = importGraph();
  for (const file of files) {
    const hit = FORBIDDEN.find(([pattern]) => pattern.test(file));
    assert.ok(!hit, `${WHY}: src/workspace reaches ${file} (${hit?.[1]})`);
    assert.ok(file.startsWith('src/workspace/'), `${WHY}: src/workspace reaches ${file}`);
  }
  for (const [specifier, from] of external) {
    const ok = ALLOWED_PACKAGES.has(specifier) || ALLOWED_BUILTINS.has(specifier);
    assert.ok(ok, `${WHY}: ${from} imports ${specifier}, which is not an allowed Workspace dependency`);
  }
  assert.ok(files.length >= 4);
});

check('src/workspace names no run-creation or execution API', () => {
  const names = /\b(createRun|AutomationController|AutomationRunner|FileControllerStore|ControllerStore|createLiveAutomation|ClaudeCodeImplementationAdapter|CodexArchitectReviewAdapter|beginImplementation|issuePacket|resumeHuman|requestPromotion|child_process|spawn|execFile)\b/g;
  for (const name of readdirSync('src/workspace')) {
    // Comments may explain the boundary; code may not cross it.
    const code = readFileSync(join('src/workspace', name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    const hits = [...new Set([...code.matchAll(names)].map((m) => m[1]))];
    assert.deepEqual(hits, [], `${WHY}: src/workspace/${name} refers to ${hits.join(', ')}`);
  }
});

check('the guard itself catches a forbidden import', () => {
  const [specifier] = [..."import { AutomationRunner } from '../automation/runner.js';".matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const target = relative(ROOT, resolve('src/workspace', specifier.replace(/\.js$/, '.ts')));
  assert.ok(FORBIDDEN.some(([pattern]) => pattern.test(target)), 'the forbidden list must match automation/runner.ts');
});

check('at runtime the running server loads no automation, provider, or execution module', () => {
  const script = `
    import { registerHooks } from 'node:module';
    const loaded = new Set();
    registerHooks({ resolve(specifier, context, next) { const result = next(specifier, context); loaded.add(result.url); return result; } });
    const { parseWorkspaceConfig } = await import('./dist/workspace/config.js');
    const { startWorkspaceServer } = await import('./dist/workspace/server.js');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(tmpdir() + '/chief-ws-boundary-');
    const config = parseWorkspaceConfig({ schemaVersion: 1, dataDirectory: dir, projects: [{ projectId: 'cand', displayName: 'C', repository: 'r' }] }, dir);
    const ws = await startWorkspaceServer({ config, uiDirectory: 'workspace-ui', port: 0 });
    const headers = { Origin: 'http://127.0.0.1:' + ws.port, 'X-Chief-Workspace': '1', 'Content-Type': 'application/json' };
    const created = await (await fetch(ws.url + 'api/v0/projects/cand/goals', { method: 'POST', headers, body: JSON.stringify({ text: 'x' }) })).json();
    await fetch(ws.url + 'api/v0/projects/cand/goals/' + created.goal.goalId, { method: 'DELETE', headers });
    await ws.close();
    console.log(JSON.stringify([...loaded]));`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const loaded = JSON.parse(run.stdout.trim().split('\n').at(-1));
  const local = loaded.filter((url) => url.startsWith('file:')).map((url) => relative(ROOT, new URL(url).pathname));
  const bad = local.filter((file) => file.startsWith('dist/') && !file.startsWith('dist/workspace/'));
  assert.deepEqual(bad, [], `${WHY}: the running server loaded ${bad.join(', ')}`);
  assert.ok(!loaded.some((url) => /child_process|@anthropic-ai|\/openai\/|@google\/generative-ai|@modelcontextprotocol/.test(url)),
    `${WHY}: the running server loaded ${loaded.filter((url) => /child_process|anthropic|openai|generative-ai|modelcontextprotocol/.test(url)).join(', ')}`);
  assert.ok(local.includes('dist/workspace/server.js'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
