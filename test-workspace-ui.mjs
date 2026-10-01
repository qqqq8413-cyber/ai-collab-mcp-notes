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

await check('the material system fetches nothing and keeps the composer accessible (WS-VIS1A)', () => {
  const css = read('styles.css'), app = read('app.js');
  assert.doesNotMatch(css, /@import|@font-face|url\(\s*['"]?(https?:)?\/\//i, 'system font stacks only; no third-party request from the stylesheet');
  assert.doesNotMatch(read('index.html'), /<link[^>]+(https?:)?\/\//i);
  assert.doesNotMatch(app, /canvas|toDataURL/, 'no generated background texture: the black material is plain');
  assert.match(app, /<button class="send" type="submit" id="send"[^>]*><span class="sr">加入工作清單<\/span>/, 'the round send button keeps its words for screen readers');
  assert.match(app, /<div class="bubble"><span class="sr">你：<\/span>/, 'the Human bubble keeps the Human identity for screen readers');
});

await check('the stage shows one focal object and never fakes execution (WS-VIS1B)', () => {
  const app = read('app.js'), css = read('styles.css');
  assert.match(app, /aria-label="此刻"/, 'the stage is a labelled region');
  assert.match(app, /id="journal-h">往來</, 'the correspondence is a labelled region');
  const focal = app.slice(app.indexOf('function stageHTML'), app.indexOf('function chiefView'));
  assert.equal((focal.match(/class="card focal"/g) ?? []).length, 2, 'one focal card per branch (queued / empty), never both');
  assert.doesNotMatch(app, /class="pulse(?! idle)/, 'every Chief mark in WS-L1 is the idle one');
  assert.doesNotMatch(css, /\.pulse[^{]*\{[^}]*animation/, 'the Chief mark has no animation rule at all');
  assert.match(app, /在「此刻」/, 'the correspondence points at the stage instead of repeating the focal card');
});

// The entry resolver is a pure block inside app.js; it is evaluated on its own so the future-contract rules can be
// proved with plain fixtures, without any fake server execution data.
const resolver = (() => {
  const app = read('app.js');
  const block = app.slice(app.indexOf('// ---------- entry resolver'), app.indexOf('// ---------- end entry resolver'));
  return new Function(`${block}\nreturn { signalsOf, resolveEntry, homeProjects, defaultTarget, parseRoute, entryFor, homeTarget };`)();
})();
const sig = (projectId, order, extra = {}) => ({ projectId, order, queued: 0, working: false, humanRequired: false, humanRequiredSince: null, ...extra });

await check('current WS-L1: root opens Home, queued is never working, and LIVE has no Human-required gold', () => {
  const live = resolver.signalsOf([{ projectId: 'a', queued: 2 }, { projectId: 'b', queued: 0 }, { projectId: 'c' }]);
  assert.ok(live.every((s) => s.working === false && s.humanRequired === false && s.humanRequiredSince === null), 'WS-L1 has no execution or Human-required signal');
  assert.deepEqual(resolver.resolveEntry(live), { kind: 'home', attention: [] });
  assert.deepEqual(resolver.entryFor(resolver.parseRoute(''), live), { view: 'home' }, 'root entry in LIVE is Home');
  assert.deepEqual(resolver.homeProjects(live, null).map((s) => s.projectId), ['a'], 'only projects with queued goals; idle ones stay off Home');
  const app = read('app.js');
  const home = app.slice(app.indexOf('function homeView'), app.indexOf('function projectView'));
  assert.match(home, /排隊中 · 尚未開始執行/);
  assert.doesNotMatch(home, /正在|執行中|working/i, 'Home never calls a queued goal active');
  assert.doesNotMatch(app, /class="pulse need|humanRequired: true/, 'nothing in the page creates a Human-required state');
});

await check('Home composer: explicit visible target, writes to the selected project, and does not navigate', () => {
  const app = read('app.js');
  assert.match(app, /<label class="c-to" for="target">交給哪個專案<\/label><select id="target"/);
  const submit = app.slice(app.indexOf('async function submitGoal'), app.indexOf('async function move'));
  assert.match(submit, /const projectId = home \? S\.target : S\.pid;/);
  assert.match(submit, /source\.addGoal\(projectId, text\)/, 'the existing POST /projects/:projectId/goals path');
  assert.match(submit, /!byId\(projectId\)\) return;/, 'no unassigned or unknown-project goal');
  assert.doesNotMatch(submit, /\bgo\(|S\.view\s*=(?!=)/, 'a hand-over from Home stays on Home');
  assert.match(submit, /S\.homeAck = projectId/, 'Home acknowledges the target project');
});

await check('default target: working, then last viewed, then configured order; bad preferences fall back', () => {
  const { defaultTarget } = resolver;
  const idle = [sig('a', 0), sig('b', 1), sig('c', 2)];
  assert.equal(defaultTarget(idle, 'b'), 'b', 'last viewed sets the default target');
  assert.equal(defaultTarget(idle, null), 'a');
  assert.equal(defaultTarget(idle, 'deleted-project'), 'a', 'unknown last-viewed falls back to configured order');
  assert.equal(defaultTarget(idle, '{"corrupt"'), 'a');
  const working = [sig('a', 0), sig('b', 1, { working: true }), sig('c', 2, { working: true })];
  assert.equal(defaultTarget(working, 'a'), 'b', 'working beats last viewed');
  assert.equal(defaultTarget(working, 'c'), 'c', 'last viewed wins among working projects');
  assert.equal(defaultTarget([], null), null);
});

await check('entry resolver: Human-required beats Home at the root, oldest request wins, working never bypasses Home', () => {
  const { resolveEntry, homeProjects } = resolver;
  const signals = [
    sig('a', 0, { working: true }),
    sig('b', 1, { humanRequired: true, humanRequiredSince: '2026-10-01T10:00:00.000Z' }),
    sig('c', 2, { humanRequired: true, humanRequiredSince: '2026-10-01T09:00:00.000Z' }),
    sig('d', 3, { queued: 1 }),
  ];
  assert.deepEqual(resolveEntry(signals), { kind: 'project', projectId: 'c', focal: 'human-required', attention: ['c', 'b'] }, 'oldest request; the other stays marked');
  const tie = [sig('x', 0, { humanRequired: true, humanRequiredSince: '2026-10-01T09:00:00.000Z' }), sig('y', 1, { humanRequired: true, humanRequiredSince: '2026-10-01T09:00:00.000Z' })];
  assert.equal(resolveEntry([...tie].reverse()).projectId, 'x', 'equal times fall back to configured order, not array order');
  assert.equal(resolveEntry([sig('m', 0, { humanRequired: true }), sig('n', 1, { humanRequired: true, humanRequiredSince: '2026-10-01T09:00:00.000Z' })]).projectId, 'n', 'a missing request time is never treated as oldest');
  assert.deepEqual(resolveEntry([sig('a', 0, { working: true }), sig('b', 1, { queued: 2 })]), { kind: 'home', attention: [] }, 'working does not bypass Home');
  assert.deepEqual(homeProjects([sig('q', 0, { queued: 1 }), sig('w', 1, { working: true }), sig('v', 2, { working: true }), sig('z', 3)], 'v').map((s) => s.projectId), ['v', 'w', 'q'], 'working first (last viewed preferred within it), then queued, idle omitted');
});

await check('C1-A: attention-first routing runs only at the root; explicit routes, back/forward and SSE never redirect', () => {
  const { parseRoute, entryFor } = resolver;
  const attention = [sig('a', 0), sig('b', 1, { humanRequired: true, humanRequiredSince: '2026-10-01T09:00:00.000Z' }), sig('candidate-platform', 2)];
  for (const root of ['', '#', '#/', '#/unknown-route']) assert.deepEqual(entryFor(parseRoute(root), attention), { view: 'project', projectId: 'b', focal: 'human-required' }, `root ${JSON.stringify(root)} → oldest Human-required project`);
  assert.deepEqual(entryFor(parseRoute('#/p/candidate-platform'), attention), { view: 'project', projectId: 'candidate-platform' }, 'explicit project deep link kept');
  for (const view of ['projects', 'activity', 'advanced']) assert.deepEqual(entryFor(parseRoute(`#/${view}`), attention), { view, projectId: undefined }, `explicit #/${view} kept`);
  assert.deepEqual(parseRoute('#/p/%E5%B6%BC%E5%85%89'), { view: 'project', projectId: '嶼光', root: false });
  const app = read('app.js');
  assert.match(app, /addEventListener\('popstate', \(\) => \{ const route = parseRoute\(location\.hash\); go\(route\.view, route\.projectId\); \}\);/, 'back/forward goes straight to the route, never through the resolver');
  assert.equal((app.match(/entryFor\(/g) ?? []).length, 2, 'entryFor is defined once and called once, at boot');
  assert.equal((app.match(/resolveEntry\(/g) ?? []).length, 2, 'resolveEntry is defined once and called only from entryFor');
  const apply = app.slice(app.indexOf('function applyEvent'), app.indexOf('// ---------- pieces'));
  assert.doesNotMatch(apply, /\bgo\(|S\.view\s*=(?!=)|location\.|history\.(push|replace)State/, 'SSE updates never navigate');
});

await check('C1-B: the Home target is recomputed on entry to Home and kept while the Human stays there', () => {
  const { homeTarget } = resolver;
  const idle = [sig('a', 0), sig('b', 1), sig('c', 2)];
  assert.equal(homeTarget({ entering: true, current: 'a' }, idle, 'b'), 'b', 'visit B, return Home → B');
  assert.equal(homeTarget({ entering: true, current: 'a' }, idle, 'gone'), 'a', 'invalid last viewed → first configured');
  assert.equal(homeTarget({ entering: true, current: 'c' }, idle, null), 'a', 'entering again recomputes the default');
  assert.equal(homeTarget({ entering: false, current: 'c' }, idle, 'b'), 'c', 'a manual choice on Home survives render and SSE');
  assert.equal(homeTarget({ entering: false, current: 'removed' }, idle, 'b'), 'b', 'a choice naming a project that no longer exists is replaced');
  assert.equal(homeTarget({ entering: true, current: 'a' }, [sig('a', 0), sig('b', 1, { working: true })], 'a'), 'b', 'a working project beats last viewed');
  const app = read('app.js');
  assert.match(app, /if \(view === 'home'\) S\.target = homeTarget\(\{ entering: S\.view !== 'home' \|\| !booted, current: S\.target \}/, 'recomputed only on a transition into Home');
  assert.match(app, /S\.target = homeTarget\(\{ entering: false, current: S\.target \}/, 'a project reload keeps the choice');
  assert.equal((app.match(/S\.target = /g) ?? []).length, 3, 'only entry to Home, project reload and the Human\'s own selector change set the target');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
