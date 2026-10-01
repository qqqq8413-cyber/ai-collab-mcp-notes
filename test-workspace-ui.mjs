import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorkspaceConfig } from './dist/workspace/config.js';
import { API_ROUTES, HOST, startWorkspaceServer } from './dist/workspace/server.js';
import { createDemoSource } from './workspace-ui/demo.js';
import { createLiveSource } from './workspace-ui/live.js';

// WS-L1 Workspace UI data layer: LIVE talks only to /api/v0 on its own origin; demo is
// in-memory, labelled, and never reaches the server.

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  PASS ${name}`); passed++; }
  catch (error) { console.error(`  FAIL ${name}: ${error.stack}`); failed++; }
}
const read = (file) => readFileSync(join('workspace-ui', file), 'utf8');

await check('demo mode runs entirely in memory and never touches the network', async () => {
  const touched = [];
  const saved = { fetch: globalThis.fetch, EventSource: globalThis.EventSource };
  globalThis.fetch = (...args) => { touched.push(['fetch', args[0]]); throw new Error('network'); };
  globalThis.EventSource = class { constructor(url) { touched.push(['EventSource', url]); throw new Error('network'); } };
  try {
    const demo = createDemoSource({ now: () => '2026-10-01T09:00:00.000Z' });
    const events = [];
    let state;
    demo.subscribe((name, data) => events.push([name, data]), (value) => { state = value; });
    assert.equal(demo.mode, 'demo');
    assert.equal(state, 'demo');
    const { projects } = await demo.projects();
    assert.ok(projects.every((project) => project.projectId.startsWith('demo-') && project.displayName.startsWith('示範')));
    const added = await demo.addGoal('demo-candidate', '示範目標');
    assert.ok(added.goal.goalId.startsWith('demo-'));
    assert.equal(added.goal.classification, 'DEMO_SAMPLE');
    const queue = await demo.queue('demo-candidate');
    await demo.reorder('demo-candidate', [...queue.goals].reverse().map((goal) => goal.goalId));
    await demo.removeGoal('demo-candidate', added.goal.goalId);
    assert.deepEqual(events.map(([name]) => name), ['goal.created', 'queue.reordered', 'goal.removed']);
    assert.deepEqual(touched, []);
  } finally { Object.assign(globalThis, saved); }
});

await check('demo values never reach the LIVE server or the LIVE source', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chief-ws-ui-'));
  const config = parseWorkspaceConfig({ schemaVersion: 1, dataDirectory: join(dir, 'q'),
    projects: [{ projectId: 'cand', displayName: '候選人平台', repository: 'org/cand' }] }, dir);
  const ws = await startWorkspaceServer({ config, uiDirectory: 'workspace-ui', port: 0 });
  try {
    const demo = createDemoSource();
    await demo.addGoal('demo-candidate', 'only in demo');
    const requested = [];
    // The page's own fetch, as the browser sends it from the Workspace origin.
    const fetchImpl = (url, init) => { requested.push(`${init.method} ${url}`);
      return fetch(new URL(url, ws.url), { ...init, headers: { ...init.headers, Origin: `http://${HOST}:${ws.port}` } }); };
    const live = createLiveSource({ fetchImpl, EventSourceImpl: class {} });
    assert.equal(live.mode, 'live');
    const { projects } = await live.projects();
    assert.deepEqual(projects.map((project) => project.projectId), ['cand']);
    const added = await live.addGoal('cand', '繼續做候選人平台');
    assert.equal(added.goal.execution, 'NOT_STARTED');
    const queue = await live.queue('cand');
    assert.deepEqual(queue.goals.map((goal) => goal.text), ['繼續做候選人平台']);
    assert.doesNotMatch(JSON.stringify([projects, queue]), /demo|示範|only in demo/);
    await live.reorder('cand', [added.goal.goalId], queue.revision);
    await live.removeGoal('cand', added.goal.goalId);
    await assert.rejects(live.removeGoal('cand', added.goal.goalId), (error) => error.status === 404);
    assert.ok(requested.every((line) => / \/api\/v0\//.test(line)), requested.join('\n'));
  } finally { await ws.close(); rmSync(dir, { recursive: true, force: true }); }
});

await check('the LIVE module never loads demo data, and demo loads only on explicit request', () => {
  const app = read('app.js'), live = read('live.js'), demo = read('demo.js');
  assert.doesNotMatch(live, /\bimport\b/, 'the LIVE source imports nothing, demo data included');
  assert.doesNotMatch(demo, /fetch|EventSource|XMLHttpRequest|\/api\//);
  const imports = [...app.matchAll(/import\((['"])(.+?)\1\)|from\s+(['"])(.+?)\3/g)].map((m) => m[2] ?? m[4]);
  assert.deepEqual(imports.sort(), ['./demo.js', './live.js']);
  assert.match(app, /const DEMO = new URLSearchParams\(location\.search\)\.get\('demo'\) === '1';/);
  assert.match(app, /const source = DEMO \? \(await import\('\.\/demo\.js'\)\)\.createDemoSource\(\) : \(await import\('\.\/live\.js'\)\)\.createLiveSource\(\);/);
  assert.match(app, /示範模式/, 'demo mode is labelled on screen');
});

await check('the UI calls only the WS-L1 routes and shows no execution it does not have', () => {
  const live = read('live.js'), app = read('app.js');
  for (const route of ['/projects', '/goals', '/order', '/stream']) assert.match(live, new RegExp(route.replace('/', '\\/')));
  assert.doesNotMatch(live + app, /\/(start|run|execute|resume|promote|create-run)\b/);
  assert.equal(API_ROUTES.length, 6);
  assert.doesNotMatch(app, /Claude (正在|working)|Codex (正在|working)|Chief 正在檢查|測試執行中|tests running/);
  assert.match(app, /已收到這個目標。我已經把它加入/);
  assert.match(app, /排隊中/);
  assert.match(app, /尚未開始執行/);
  assert.match(app, /目前這個版本只會保存與排列工作，還不會自動啟動 AI 執行。/);
  assert.match(app, /無法連到對應的監看畫面/, 'Console deep link is stated as not available yet');
});

await check('the UI needs no inline style or script, so its strict content security policy holds', () => {
  for (const file of ['index.html', 'app.js']) {
    assert.doesNotMatch(read(file), /\sstyle="|<style\b|\son[a-z]+="|<script>(?!<\/script>)/, file);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
