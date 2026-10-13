import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorkspaceConfig } from './dist/workspace/config.js';
import { API_ROUTES, HOST, startWorkspaceServer } from './dist/workspace/server.js';
import { createGoalChangeBridge } from './dist/intake/goal-change-bridge.js';
import { createDemoSource } from './workspace-ui/demo.js';
import { createLiveSource } from './workspace-ui/live.js';
import { BROADCAST_SENT, BROADCAST_SHOWN, EMPTY_ROOM, EVENT_TYPES, IDENTITY_RULES, NEEDS_EMPTY, attachmentsHTML, collaborationRoom, conversationHTML, conversationOf, decisionHTML, evidenceHTML,
  identityOf, labelsOf,
  messageHTML, needsHTML, parseCollaborationEvents, roomHTML, summarizeCollaboration } from './workspace-ui/collaboration.js';
import { arrivals, opened, replayStart, revealed } from './workspace-ui/conversation.js';
import { EXECUTION_LABELS, NOT_STARTED, PROVENANCE_EXPLAIN, executionNow, executionStatusHTML } from './workspace-ui/execution-status.js';

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
    humanPrincipal: { principalRef: 'human:local-owner' },
    projects: [{ projectId: 'cand', displayName: '候選人平台', repository: 'org/cand' }] }, dir);
  const registry = join(dir, 'registry'); mkdirSync(registry, { mode: 0o700 });
  const bridge = createGoalChangeBridge({ config, uiDirectory: 'workspace-ui', changeRegistryDirectory: registry,
    governedRepositories: [{ projectId: 'cand', repository: 'org/cand' }] });
  const ws = await startWorkspaceServer({ config, uiDirectory: 'workspace-ui', port: 0, ...bridge });
  try {
    const bootstrap = await fetch(ws.url);
    const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
    const demo = createDemoSource();
    await demo.addGoal('demo-candidate', 'only in demo');
    const requested = [];
    // The page's own fetch, as the browser sends it from the Workspace origin.
    const fetchImpl = (url, init) => { requested.push(`${init.method} ${url}`);
      return fetch(new URL(url, ws.url), { ...init,
        headers: { ...init.headers, Cookie: cookie, Origin: `http://${HOST}:${ws.port}` } }); };
    const live = createLiveSource({ fetchImpl, EventSourceImpl: class {} });
    assert.equal(live.mode, 'live');
    const { projects } = await live.projects();
    assert.deepEqual(projects.map((project) => project.projectId), ['cand']);
    const added = await live.addGoal('cand', '繼續做候選人平台');
    assert.equal(added.goal.execution, 'NOT_STARTED');
    assert.deepEqual(added.goal.submittedBy, { schemaVersion: 1, kind: 'HUMAN', principalRef: 'human:local-owner' });
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
  assert.deepEqual(imports.sort(), ['./collaboration.js', './conversation.js', './demo.js', './execution-status.js', './live.js']);
  assert.match(app, /const DEMO = new URLSearchParams\(location\.search\)\.get\('demo'\) === '1';/);
  assert.match(app, /const source = DEMO \? \(await import\('\.\/demo\.js'\)\)\.createDemoSource\(\) : \(await import\('\.\/live\.js'\)\)\.createLiveSource\(\);/);
  assert.match(app, /示範模式/, 'demo mode is labelled on screen');
});

await check('browser assets do not keep a Human session secret in JavaScript storage', () => {
  const assets = ['index.html', 'app.js', 'live.js', 'demo.js', 'collaboration.js', 'styles.css'].map(read).join('\n');
  assert.doesNotMatch(assets, /chief_workspace_session|humanPrincipal|principalRef/);
  assert.doesNotMatch(read('live.js'), /localStorage|sessionStorage|document\.cookie/);
});

await check('the UI calls only the WS-L1 routes and shows no execution it does not have', () => {
  const live = read('live.js'), app = read('app.js');
  for (const route of ['/projects', '/goals', '/order', '/stream']) assert.match(live, new RegExp(route.replace('/', '\\/')));
  assert.doesNotMatch(live + app, /\/(start|run|execute|resume|promote|create-run)\b/);
  assert.equal(API_ROUTES.length, 11);
  // G1-WE1-R0: exactly one read-only execution status route, GET only; the UI reads it and nothing else new.
  assert.deepEqual(API_ROUTES.filter((route) => /\/execution$/.test(route)), ['GET /api/v0/projects/:projectId/goals/:goalId/execution']);
  assert.match(live, /executionStatus: \(projectId, goalId\) => call\('GET', `\/projects\/\$\{enc\(projectId\)\}\/goals\/\$\{enc\(goalId\)\}\/execution`\)/);
  assert.equal((live.match(/\/execution/g) ?? []).length, 1);
  assert.doesNotMatch(app + live, /call\('(POST|DELETE)',[^)]*execution/);
  assert.deepEqual(API_ROUTES.filter((route) => /\/govern(ance)?$/.test(route)), [
    'POST /api/v0/projects/:projectId/goals/:goalId/govern',
    'GET /api/v0/projects/:projectId/goals/:goalId/governance',
  ], 'GC1 adds exactly its two operational routes');
  assert.deepEqual(API_ROUTES.filter((route) => /\/run$/.test(route)), [
    'POST /api/v0/projects/:projectId/goals/:goalId/run',
    'GET /api/v0/projects/:projectId/goals/:goalId/run',
  ], 'RA1 adds exactly its two Goal-scoped operational routes');
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
  const focal = app.slice(app.indexOf('function stageHTML'), app.indexOf('function homeView'));
  assert.equal((focal.match(/class="card focal( need)?"/g) ?? []).length, 3, 'one focal card per branch (需要你 / queued / empty), only one at a time');
  assert.match(focal, /const focal = needs\.length\s*\? `<section class="card focal need"[\s\S]*?: first\s*\? `<section class="card focal"/, 'the branches are exclusive: an escalation, else the queue, else empty');
  assert.doesNotMatch(app, /class="pulse(?! idle)/, 'every Chief mark in WS-L1 is the idle one');
  assert.doesNotMatch(css, /\.pulse[^{]*\{[^}]*animation/, 'the Chief mark has no animation rule at all');
  assert.match(app, /在「此刻」/, 'the correspondence points at the stage instead of repeating the focal card');
});

// The entry resolver is a pure block inside app.js; it is evaluated on its own so the future-contract rules can be
// proved with plain fixtures, without any fake server execution data.
const resolver = (() => {
  const app = read('app.js');
  const block = app.slice(app.indexOf('// ---------- entry resolver'), app.indexOf('// ---------- end entry resolver'));
  return new Function(`${block}\nreturn { signalsOf, resolveEntry, homeProjects, defaultTarget, parseRoute, entryFor, homeTarget, recentProjects, homeSections };`)();
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
  assert.doesNotMatch(app, /class="pulse need|humanRequired: true/, 'no hard-coded Human-required state');
  assert.match(app, /humanRequired: since !== null/, 'Human-required comes only from an escalation time (the collaboration room), which LIVE never has');
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
  assert.deepEqual(entryFor(parseRoute('#/p/candidate-platform'), attention), { view: 'project', projectId: 'candidate-platform', pane: 'now' }, 'explicit project deep link kept');
  assert.deepEqual(entryFor(parseRoute('#/p/candidate-platform/conversation'), attention), { view: 'project', projectId: 'candidate-platform', pane: 'conversation' }, 'explicit project view kept');
  for (const view of ['projects', 'activity', 'advanced']) assert.deepEqual(entryFor(parseRoute(`#/${view}`), attention), { view, projectId: undefined }, `explicit #/${view} kept`);
  assert.deepEqual(parseRoute('#/p/%E5%B6%BC%E5%85%89'), { view: 'project', projectId: '嶼光', pane: 'now', root: false });
  const app = read('app.js');
  assert.match(app, /addEventListener\('popstate', \(\) => \{ const route = parseRoute\(location\.hash\); go\(route\.view, route\.projectId, \{ pane: route\.pane, area: route\.area \}\); \}\);/, 'back/forward goes straight to the route, never through the resolver');
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

// ---------- WS-P1: three project views, Home sections, 協作室
const ev = (extra = {}) => ({ id: 'e1', projectId: 'p', goalId: 'g1', actor: 'Claude', role: 'Implementer', type: 'PROPOSAL',
  body: '我會先處理 auth middleware。', timestamp: '2026-10-06T04:41:00.000Z', ...extra });
const slice = (from, to) => { const app = read('app.js'); return app.slice(app.indexOf(from), app.indexOf(to)); };
// UI-C1-C1: a participant directory from [id, name] pairs (an identified room: every message carries actorId, `to` holds IDs).
const dir = (...pairs) => pairs.map(([id, name]) => ({ id, name }));

await check('WS-P1 routes: every project view has its own address; #/p/<id> is 此刻; anything else is the root', () => {
  const { parseRoute, entryFor } = resolver;
  for (const pane of ['now', 'conversation', 'collaboration']) {
    const area = pane === 'collaboration' ? { area: 'discussion' } : {};
    assert.deepEqual(parseRoute(`#/p/cand/${pane}`), { view: 'project', projectId: 'cand', pane, ...area, root: false });
    assert.deepEqual(entryFor(parseRoute(`#/p/cand/${pane}`), [sig('x', 0, { humanRequired: true, humanRequiredSince: '2026-10-01T09:00:00.000Z' })]),
      { view: 'project', projectId: 'cand', pane, ...area }, `explicit ${pane} is never replaced by attention`);
  }
  assert.deepEqual(parseRoute('#/p/cand'), { view: 'project', projectId: 'cand', pane: 'now', root: false });
  for (const root of ['#/p/cand/run', '#/p/cand/now/x', '#/p/', '#/p/%E5%B6']) assert.equal(parseRoute(root).root, true, `${root} is the root`);
  const app = read('app.js');
  assert.match(app, /const paneHref = \(projectId, pane, area\) => `#\/p\/\$\{encodeURIComponent\(projectId\)\}\/\$\{pane\}\$\{pane === 'collaboration' && area === 'needs' \? '\/needs' : ''\}`;/);
  assert.match(app, /const hashOf = \(\) => \(S\.view === 'project' \? paneHref\(S\.pid, S\.pane, S\.area\)/, 'the address follows the view shown');
  const views = slice('function projectView', 'function projectsView');
  for (const [pane, label] of [['now', '此刻'], ['conversation', '往來'], ['collaboration', '協作室']]) {
    assert.match(views, new RegExp(`tab\\('${pane}', '${label}'`), `${label} is a link to its own address`);
  }
  assert.match(views, /<a href="\$\{paneHref\(p\.projectId, pane\)\}" data-act="pane" data-v="\$\{pane\}" \$\{S\.pane === pane \? 'aria-current="page"' : ''\}>/);
  assert.match(app, /case 'pane': go\('project', S\.pid, \{ pane: v \}\); break;/, 'switching views goes through the same navigation as an address');
});

await check('WS-P1 project switching: a new project opens on 此刻 and closes a sheet that belonged to the old one', () => {
  const go = slice('function go(', "addEventListener('popstate'");
  assert.match(go, /if \(S\.pid !== projectId\) \{ S\.pane = 'now'; S\.area = 'discussion'; S\.sheet = null; S\.decision = null; \}/);
  assert.match(go, /if \(PANES\.includes\(pane\)\) \{ S\.pane = pane; if \(pane === 'collaboration'\) S\.area = AREAS\.includes\(area\) \? area : 'discussion'; \}/, 'only a known view and area name is accepted');
  assert.match(read('app.js'), /case 'room': go\('project', v, \{ pane: 'collaboration', area: 'needs' \}\);/, '需要你 links open that project\'s 協作室 needs area only when clicked');
});

await check('WS-P1 Home: 需要你 from escalations only, 目前的工作 empty without execution, 排隊中, 最近開啟 known projects only', () => {
  const { homeSections, recentProjects, signalsOf } = resolver;
  const live = signalsOf([{ projectId: 'a', queued: 1 }, { projectId: 'b', queued: 0 }, { projectId: 'c', queued: 2 }]);
  assert.deepEqual(homeSections(live, 'c', ['b', 'gone', 'b', 7, 'a']), { attention: [], current: [], queued: ['c', 'a'], recent: ['b', 'a'] });
  const attention = signalsOf([{ projectId: 'a' }, { projectId: 'b' }, { projectId: 'c' }], { c: '2026-10-06T04:00:00.000Z', a: '2026-10-06T05:00:00.000Z' });
  assert.deepEqual(homeSections(attention, null, []).attention, ['c', 'a'], 'oldest request first');
  assert.deepEqual(recentProjects(live, ['a', 'b', 'c', 'a', 'x', 'b']), ['a', 'b', 'c']);
  assert.deepEqual(recentProjects(live, '{"corrupt"'), [], 'a corrupt preference is ignored');
  assert.equal(recentProjects([sig('a', 0), sig('b', 1), sig('c', 2), sig('d', 3), sig('e', 4)], ['a', 'b', 'c', 'd', 'e']).length, 4);
  const home = slice('function homeView', 'function projectView');
  assert.match(home, /class="h-need"/);
  assert.match(home, /data-act="room"/, '需要你 is a link the Human chooses, never a redirect');
  assert.doesNotMatch(home, /\bgo\(|location\.|history\./, 'Home renders; it never navigates');
  assert.match(home, /id="hc-h">目前的工作<\/h2>[\s\S]*沒有進行中的工作。/);
  assert.match(home, /id="hw-h">排隊中<\/h2>/);
  assert.match(home, /id="hr-h">最近開啟<\/h2>/);
  assert.match(home, /<label class="c-to"|composerHTML\(true\)/, 'the Home composer keeps its explicit project target');
});

await check('WS-P1 signals: Human-required only from an escalation time; the LIVE source has no collaboration events at all', async () => {
  const { signalsOf } = resolver;
  const s = signalsOf([{ projectId: 'a' }, { projectId: 'constructor' }, { projectId: '__proto__' }], { a: '2026-10-06T04:00:00.000Z' });
  assert.deepEqual(s.map((x) => [x.humanRequired, x.humanRequiredSince]), [[true, '2026-10-06T04:00:00.000Z'], [false, null], [false, null]]);
  assert.ok(s.every((x) => x.working === false), 'nothing is ever working: there is no execution');
  const requested = [];
  const live = createLiveSource({ fetchImpl: (...args) => { requested.push(args); throw new Error('network'); }, EventSourceImpl: class {} });
  assert.deepEqual(await live.collaboration('cand'), { projectId: 'cand', provenance: 'NONE', events: [] });
  assert.deepEqual(requested, [], 'no request: there is no collaboration route or source');
  const r = collaborationRoom('cand', await live.collaboration('cand'));
  assert.equal(r.summary.needsHuman.length, 0);
  const html = roomHTML(r);
  assert.ok(html.includes(EMPTY_ROOM) && html.includes(NEEDS_EMPTY), 'LIVE shows the 需要你 strip and the room empty');
  assert.doesNotMatch(html, /示範資料|class="conv|class="cm|data-replay/, 'no demo label, no window, no message, no replay');
  assert.equal(API_ROUTES.filter((route) => !/\/(govern|governance|run|execution)$/.test(route)).length, 6, 'no collaboration API route was added');
});

await check('WS-P1 CollaborationEventV1: nine runtime-neutral types; anything outside the model is refused, never shown', () => {
  assert.deepEqual([...EVENT_TYPES], ['PROPOSAL', 'QUESTION', 'CHALLENGE', 'RESPONSE', 'HANDOFF', 'EVIDENCE', 'AGREEMENT', 'ESCALATION', 'SYSTEM']);
  assert.ok(EVENT_TYPES.every((type) => !/CLAUDE|CODEX|OPENAI|GPT/i.test(type)));
  const bad = [
    ev({ reasoning: 'hidden chain of thought' }), ev({ thinking: '...' }), ev({ type: 'CLAUDE_EDIT' }), ev({ projectId: 'other' }),
    ev({ timestamp: 'yesterday' }), ev({ body: '' }), ev({ actor: 'x\u0000y' }), ev({ evidence: [{ kind: 'URL', href: 'https://x' }] }),
    ev({ evidence: [{ kind: 'FILE', path: 'a.ts', raw: 'diff' }] }), ev({ evidence: [{ kind: 'COMMIT', sha: 'not-a-sha' }] }),
    ev({ evidence: [{ kind: 'TESTS', passed: -1 }] }), ev({ id: '../x' }), null, 'event',
  ].map((item, index) => (item && typeof item === 'object' && item.id === 'e1' ? { ...item, id: `bad-${index}` } : item));
  for (const field of ['reasoning', 'thinking', 'chainOfThought', 'raw']) {
    assert.equal(parseCollaborationEvents('p', [ev({ [field]: 'x' })]).rejected, 1, `an event carrying ${field} is refused, not trimmed`);
  }
  const parsed = parseCollaborationEvents('p', [ev({ id: 'late', timestamp: '2026-10-06T05:00:00.000Z' }), ev(), ev(), ...bad]);
  assert.deepEqual(parsed.events.map((e) => e.id), ['e1', 'late'], 'oldest first; the duplicate id is refused');
  assert.equal(parsed.rejected, bad.length + 1);
  assert.ok(Object.isFrozen(parsed.events[0]));
  assert.equal(parseCollaborationEvents('p', ev({ body: 'line 1\nline 2' })).events.length, 0, 'not a list → nothing');
  assert.equal(parseCollaborationEvents('p', [ev({ body: 'line 1\nline 2' })]).events[0].body, 'line 1\nline 2', 'newlines in a body are kept');
  assert.match(roomHTML(collaborationRoom('p', { events: [ev(), ev({ id: 'x', type: 'NOPE' })] })), /有 <span class="num">1<\/span> 則事件格式不正確，沒有顯示。/);
  const module = read('collaboration.js');
  assert.doesNotMatch(module, /\bimport\b|fetch|EventSource|XMLHttpRequest|localStorage|document\.|window\./, 'pure: no imports, network, storage or DOM');
});

await check('WS-P1 CollaborationSummaryV1: derived from the events alone', () => {
  const events = parseCollaborationEvents('p', [
    ev({ id: 's', type: 'SYSTEM', actor: '系統', role: undefined, body: '開始協作。', timestamp: '2026-10-06T04:40:00.000Z' }),
    ev({ id: 'a1', type: 'AGREEMENT', actor: 'Codex', role: 'Reviewer', body: '不修改 database schema。', timestamp: '2026-10-06T04:42:00.000Z' }),
    ev({ id: 'c1', type: 'CHALLENGE', actor: 'Codex', role: 'Reviewer', body: 'expired token 提前被拒絕。', timestamp: '2026-10-06T04:44:00.000Z' }),
    ev({ id: 'r1', type: 'RESPONSE', body: '同意，會修。', timestamp: '2026-10-06T04:45:00.000Z' }),
    ev({ id: 'c2', type: 'CHALLENGE', actor: 'Codex', role: 'Reviewer', goalId: 'g2', body: '另一個工作的問題。', timestamp: '2026-10-06T04:46:00.000Z' }),
    ev({ id: 'a2', type: 'AGREEMENT', actor: 'Codex', role: 'Reviewer', body: '改在 authorization stage 拒絕。', timestamp: '2026-10-06T04:49:00.000Z' }),
    ev({ id: 'x1', type: 'ESCALATION', actor: 'Codex', role: 'Reviewer', body: '要不要改 public API？', timestamp: '2026-10-06T04:52:00.000Z' }),
    ev({ id: 'c3', type: 'CHALLENGE', actor: 'Codex', role: 'Reviewer', goalId: 'g3', body: '第三個問題。', timestamp: '2026-10-06T04:53:00.000Z' }),
    ev({ id: 'a3', type: 'AGREEMENT', goalId: 'g3', body: '我同意我自己的做法。', timestamp: '2026-10-06T04:54:00.000Z' }),
  ]).events;
  const summary = summarizeCollaboration('p', events);
  assert.deepEqual(summary.activeParticipants, [{ actor: 'Codex', role: 'Reviewer' }, { actor: 'Claude', role: 'Implementer' }], 'system events are not participants');
  assert.deepEqual(summary.consensus.map((e) => e.id), ['a1', 'a2', 'a3'], 'consensus = the AGREEMENT events, verbatim');
  assert.deepEqual(summary.disagreements.map((e) => e.id), ['c2', 'c3'], 'c1 is settled by its author agreeing later in the same goal; c2 is in another goal; c3 was agreed only by the other side');
  assert.deepEqual(summary.needsHuman.map((e) => e.id), ['x1'], 'no Human decision backend: every escalation stays open');
  const html = roomHTML(collaborationRoom('p', { events }));
  assert.doesNotMatch(html, /AI 協作摘要|class="csum/, 'UI-C1: the summary card gave way to the windows; the summary still feeds 需要你');
  assert.ok(html.indexOf('id="needs-h"') < html.indexOf('<div class="conv"'), 'UI-C1: 需要你 first, then the conversation windows');
});

await check('WS-P1/UI-C1 message rendering: every type keeps its word; text is escaped; no raw log or input', () => {
  const words = { PROPOSAL: '提案', QUESTION: '提問', CHALLENGE: '質疑', RESPONSE: '回應', HANDOFF: '交接', EVIDENCE: '證據', AGREEMENT: '同意', ESCALATION: '需要你' };
  for (const type of EVENT_TYPES.filter((t) => t !== 'SYSTEM')) {
    const room = collaborationRoom('p', { participants: dir(['claude', 'Claude'], ['peer', 'Peer']),
      events: [ev({ type, actorId: 'claude', ...(type === 'ESCALATION' ? {} : { to: ['peer'] }) })] });
    const [window] = conversationOf(room);
    const html = messageHTML(window.items[0], window);
    assert.match(html, new RegExp(`^<li class="cm cm-out t-${type.toLowerCase()}" data-seq="1" data-id="e1"><div class="bub">`), type);
    assert.match(html, new RegExp(`<p class="cm-m"><span class="cm-t">${words[type]}</span> · `), type);
  }
  const system = parseCollaborationEvents('p', [ev({ type: 'SYSTEM', actor: '系統', role: undefined, body: '開始協作。' })]).events;
  assert.deepEqual(conversationOf(collaborationRoom('p', { events: system })), [], 'a SYSTEM event alone opens no window');
  const hostile = ev({ actor: '<img src=x onerror=alert(1)>', actorId: 'h', to: ['x'], body: '<script>x()</script>\n第二行' });
  const html = conversationHTML(collaborationRoom('p', { participants: dir(['h', '<img src=x onerror=alert(1)>'], ['x', '<b>x</b>']), events: [hostile] }));
  assert.doesNotMatch(html, /<script>|<img|<b>x/);
  assert.match(html, /<div class="bub">&lt;script&gt;x\(\)&lt;\/script&gt;<br>第二行<\/div>/);
  assert.match(html, /<b class="cw-n">&lt;img src=x onerror=alert\(1\)&gt;<\/b>/);
  assert.match(html, /<p class="cm-from">&lt;img src=x onerror=alert\(1\)&gt;<\/p>/, 'the receiving window escapes the sender too');
  assert.match(html, /給 &lt;b&gt;x&lt;\/b&gt;/, 'and the addressee');
  assert.doesNotMatch(roomHTML(collaborationRoom('p', { events: [ev()] })), /<pre|<textarea|<input|<form/, 'no raw log or input in the room');
});

await check('WS-P1 evidence: file, tests and commit as one reusable display-only block', () => {
  assert.equal(evidenceHTML(undefined), '');
  assert.equal(evidenceHTML([]), '');
  const html = evidenceHTML([{ kind: 'FILE', path: 'src/auth/middleware.ts', lines: '84–112' }, { kind: 'TESTS', label: 'auth', passed: 18, failed: 0 },
    { kind: 'TESTS', passed: 3 }, { kind: 'COMMIT', sha: '4820528f0be1ba' }]);
  assert.match(html, /^<dl class="evd" aria-label="證據">/);
  assert.match(html, /<dt>檔案<\/dt><dd><code>src\/auth\/middleware\.ts:84–112<\/code><\/dd>/);
  assert.match(html, /<dt>測試<\/dt><dd>auth · <span class="num">18<\/span> 項通過 · <span class="num">0<\/span> 項失敗<\/dd>/);
  assert.match(html, /<dt>測試<\/dt><dd><span class="num">3<\/span> 項通過<\/dd>/, 'no failure count is invented when none was given');
  assert.match(html, /<dt>提交<\/dt><dd><code title="4820528f0be1ba">4820528…<\/code><\/dd>/);
  assert.doesNotMatch(html, /<a |href=|https?:/, 'display only: no link to a repository or GitHub');
});

await check('WS-P1 escalation: 需要你 is shown and never answered; 查看決策 opens a read-only explanation', () => {
  const [event] = parseCollaborationEvents('p', [ev({ id: 'x1', type: 'ESCALATION', actor: 'Codex', role: 'Reviewer', body: 'Claude 與 Codex 無法自行決定\n是否修改 public API contract。',
    evidence: [{ kind: 'FILE', path: 'api/contract.ts' }] })]).events;
  const need = needsHTML(summarizeCollaboration('p', [event]));
  assert.match(need, /<h2 class="nr-h" id="needs-h" tabindex="-1">需要你 <span class="num nr-c">1<\/span><\/h2>/);
  assert.match(need, /<p class="nr-q">Claude 與 Codex 無法自行決定<br>是否修改 public API contract。<\/p>\s*<p class="nr-m">Codex · Reviewer · <time[^>]*>[^<]*<\/time> 提出<\/p><dl class="evd"/, 'question, who, when, optional evidence');
  assert.match(need, /<button class="btn gold" type="button" data-act="decision" data-v="x1">查看決策<\/button>/);
  assert.equal((need.match(/<button/g) ?? []).length, 1, 'one control, and it only opens the explanation');
  assert.doesNotMatch(need, /核准|拒絕|回覆|approve|reject|answer|<input|<textarea|<form/i, 'no approve, reject or answer');
  const sheet = decisionHTML(event);
  assert.match(sheet, /Workspace 不能在這裡做決定，也不會記錄任何決定或授權。/);
  assert.doesNotMatch(sheet, /<button|<input|<form|<select|data-act=/, 'no option, answer or approval control');
  assert.match(decisionHTML(event, { demo: true }), /示範資料/);
  const app = read('app.js');
  const sheetFn = slice('function sheetHTML', '// ---------- render');
  assert.deepEqual([...new Set([...sheetFn.matchAll(/data-act="([\w-]+)"/g)].map((m) => m[1]))], ['close-sheet'], 'the decision sheet can only be closed');
  assert.doesNotMatch(app, /source\.(decide|approve|authorize|answer)|\/decision|\/authoriz/, 'nothing sends a decision anywhere');
  const stage = slice('function stageHTML', 'function homeView');
  assert.match(stage, /h2 class="ch-t" id="focal-h">需要你<\/h2>/, 'an open escalation takes 此刻\'s focal slot');
});

await check('WS-P1 協作室 empty state, and 此刻 never shows execution that does not exist', () => {
  const empty = roomHTML(collaborationRoom('p', { events: [] }));
  assert.ok(empty.includes(EMPTY_ROOM) && empty.includes(NEEDS_EMPTY));
  assert.match(EMPTY_ROOM, /<h3 class="ce-h">目前沒有 AI 協作紀錄<\/h3><p>這個專案尚未開始執行，<br>或目前沒有可顯示的協作事件。<\/p>/);
  assert.doesNotMatch(empty, /class="cm|class="conv|AI 協作摘要/, 'no placeholder messages or windows');
  const stage = slice('function stageHTML', 'function homeView');
  // G1-WE1-R0: the queued wording stays until the governed status shows recorded execution (execution-status.js decides the words).
  assert.match(stage, /const now = first \? executionNow\(exec\) : '沒有工作';/);
  assert.match(stage, /<dt>Chief 現在<\/dt><dd>\$\{esc\(now\)\}<\/dd>/, 'the canonical queued wording');
  assert.doesNotMatch(stage, /正在處理|等待 AI 驗證|完成|失敗|elapsed|分鐘|進度|%/, 'no active, verifying, done, failed, elapsed time or progress');
  assert.match(stage, /r\.events\.length && !needs\.length[\s\S]*查看協作室/, '查看協作室 appears when the room has records');
});

await check('WS-P1 往來 keeps the Human ↔ Chief record and the docked composer; 協作室 has no composer', () => {
  const views = slice('function projectView', 'function projectsView');
  assert.match(views, /if \(S\.pane === 'conversation'\)[\s\S]*ackHTML\(event\.goal/, '往來 is the durable goal history, Human bubble and Chief reply');
  assert.match(views, /\$\{S\.pane === 'collaboration' \? '' : `<div class="dock">\$\{composerHTML\(false\)\}<\/div>`\}/);
  const submit = slice('async function submitGoal', 'async function move');
  assert.match(submit, /const projectId = home \? S\.target : S\.pid;/);
  assert.doesNotMatch(submit, /\bgo\(|S\.view\s*=(?!=)|S\.pane\s*=(?!=)/, 'submitting never changes the view');
});

await check('WS-P1 fixture boundary: demo collaboration is labelled, in memory and demo-only; app.js holds no fixture', async () => {
  const demo = createDemoSource({ now: () => '2026-10-06T05:00:00.000Z' });
  const candidate = await demo.collaboration('demo-candidate');
  assert.equal(candidate.provenance, 'DEMO_SAMPLE');
  assert.ok(candidate.events.length >= 6 && candidate.events.every((e) => e.id.startsWith('demo-') && e.projectId === 'demo-candidate'));
  const r = collaborationRoom('demo-candidate', candidate);
  assert.equal(r.rejected, 0, 'the fixture passes the same projection as any source');
  for (const type of ['PROPOSAL', 'CHALLENGE', 'RESPONSE', 'EVIDENCE', 'AGREEMENT', 'ESCALATION']) assert.ok(r.events.some((e) => e.type === type), `demo shows ${type}`);
  assert.match(roomHTML(r), /<p class="demo-tag" role="note"><b>示範資料<\/b><span>這些不是真的 AI 對話/);
  assert.equal(r.identity, 'IDENTIFIED', 'UI-C1-C1: the demo record carries stable participant IDs and a directory');
  assert.equal(r.unverified, 0);
  assert.deepEqual(r.participants.map((p) => p.id), ['demo-chief', 'demo-claude', 'demo-gpt']);
  assert.ok(r.events.every((e) => (e.type === 'SYSTEM' ? e.actorId === undefined : r.participants.some((p) => p.id === e.actorId))));
  assert.deepEqual(r.events.filter((e) => !['SYSTEM', 'ESCALATION'].includes(e.type) && !e.to).map((e) => e.id), ['demo-ev-02'], 'one compatibility broadcast');
  assert.deepEqual((await demo.collaboration('demo-site')).events, [], 'a demo project without a record shows the empty state');
  await assert.rejects(demo.collaboration('cand'), /示範資料裡沒有這個專案/);
  const app = read('app.js');
  assert.doesNotMatch(app, /auth middleware|refresh token|public API contract|demo-ev-/, 'no fixture text in the page');
  assert.match(app, /S\.collab\[projectId\] = collaborationRoom\(projectId, await source\.collaboration\(projectId\)\);/, 'every source goes through the projection');
  assert.match(app, /const demoRoom = \(projectId = S\.pid\) => DEMO \|\| room\(projectId\)\.provenance === 'DEMO_SAMPLE';/);
});

await check('WS-P1 SSE and loading never navigate', () => {
  const data = slice('// ---------- data', '// ---------- pieces');
  assert.doesNotMatch(data, /\bgo\(|S\.view\s*=(?!=)|S\.pane\s*=(?!=)|location\.|history\.(push|replace)State/, 'loading queues, rooms and SSE events changes data only');
  assert.match(data, /if \(name === 'hello'\) \{ void reloadAll\(\); return; \}/);
});

await check('WS-P1 responsive: the new blocks wrap inside their column instead of widening the page', () => {
  const css = read('styles.css');
  for (const rule of [/\.evd dd\{[^}]*overflow-wrap:anywhere/, /\.evd code\{[^}]*overflow-wrap:anywhere/, /\.mt\{[^}]*max-width:100%;overflow-x:auto/,
    /\.journal\{[^}]*max-width:760px/, /\.hn-x\{[^}]*overflow-wrap:anywhere/, /\.nr-q\{[^}]*overflow-wrap:anywhere/, /\.cw\{[^}]*min-width:0/,
    /\.cm\{[^}]*max-width:90%;min-width:0/, /\.bub\{[^}]*overflow-wrap:anywhere;min-width:0;max-width:100%/, /\.cw-n\{[^}]*overflow-wrap:anywhere/,
    /\.cw-r\{[^}]*overflow-wrap:anywhere/, /\.cm-m\{[^}]*overflow-wrap:anywhere/, /\.cm-from\{[^}]*overflow-wrap:anywhere/, /\.att code\{[^}]*overflow-wrap:anywhere/,
    /\.cw-tabs\{[^}]*max-width:100%;overflow-x:auto/]) assert.match(css, rule);
  assert.match(css, /@media \(max-width:759px\)\{[\s\S]*\.dock\{max-width:none/, 'the phone composer spans the screen');
  assert.doesNotMatch(css, /\.view\.chief\[data-pane|\.mt button/, 'the old two-pane toggle is gone');
});

// ---------- WS-P2 (still in force), UI-C1 and UI-C1-C1: 協作室 as conversation windows
const RECORD_DIR = dir(['gem', 'Gemini'], ['tx', 'Tool-X']);
const record = (extra = []) => parseCollaborationEvents('p', [
  ev({ id: 's0', type: 'SYSTEM', actor: '系統', role: undefined, body: '開始協作。', timestamp: '2026-10-06T04:40:00.000Z' }),
  ev({ id: 'p1', type: 'PROPOSAL', actor: 'Gemini', actorId: 'gem', role: 'Planner', to: ['tx'], body: '先改 middleware。', timestamp: '2026-10-06T04:41:00.000Z' }),
  ev({ id: 'q1', type: 'QUESTION', actor: 'Tool-X', actorId: 'tx', role: 'Checker', to: ['gem'], body: '要保留舊行為嗎？', timestamp: '2026-10-06T04:42:00.000Z' }),
  ev({ id: 'c1', type: 'CHALLENGE', actor: 'Tool-X', actorId: 'tx', role: 'Checker', to: ['gem'], body: '過期 token 被提前拒絕。', timestamp: '2026-10-06T04:44:00.000Z',
    evidence: [{ kind: 'FILE', path: 'src/auth.ts', lines: '84–112' }] }),
  ev({ id: 'e1', type: 'EVIDENCE', actor: 'Tool-X', actorId: 'tx', role: 'Checker', to: ['gem'], body: '重新驗證。', timestamp: '2026-10-06T04:46:00.000Z', evidence: [{ kind: 'TESTS', passed: 18, failed: 0 }] }),
  ev({ id: 'x1', type: 'ESCALATION', actor: 'Tool-X', actorId: 'tx', role: 'Checker', goalId: 'g2', body: '要不要改 public API？', timestamp: '2026-10-06T04:50:00.000Z',
    evidence: [{ kind: 'FILE', path: 'api/contract.ts' }] }),
  ...extra,
]).events;
// Four participants, one of whom never speaks; one message without addressees (a compatibility broadcast); one escalation.
const at = (minute) => `2026-10-06T04:${String(40 + minute).padStart(2, '0')}:00.000Z`;
const TALK_DIR = dir(['lead', 'Lead'], ['maker', 'Maker'], ['checker', 'Checker'], ['watcher', 'Watcher']);
const talkEvents = () => [
  ev({ id: 's0', type: 'SYSTEM', actor: '系統', role: undefined, body: '開始。', timestamp: at(0) }),
  ev({ id: 'h1', type: 'HANDOFF', actor: 'Lead', actorId: 'lead', role: '統籌', to: ['maker', 'checker'], body: '交給你們。', timestamp: at(1) }),
  ev({ id: 'p1', type: 'PROPOSAL', actor: 'Maker', actorId: 'maker', role: '實作', to: ['checker'], body: '先改 middleware。', timestamp: at(2) }),
  ev({ id: 'n1', type: 'RESPONSE', actor: 'Maker', actorId: 'maker', role: '實作', body: '沒有寫收件者的訊息。', timestamp: at(3) }),
  ev({ id: 'c1', type: 'CHALLENGE', actor: 'Checker', actorId: 'checker', role: '審查', to: ['maker'], body: '有問題。', timestamp: at(4), evidence: [{ kind: 'FILE', path: 'src/a.ts' }] }),
  ev({ id: 'w1', type: 'QUESTION', actor: 'Maker', actorId: 'maker', role: '實作', to: ['watcher'], body: '你看一下？', timestamp: at(5) }),
  ev({ id: 'x1', type: 'ESCALATION', actor: 'Lead', actorId: 'lead', role: '統籌', body: '需要你決定。', timestamp: at(6) }),
];
const talkRoom = (extra = {}) => collaborationRoom('p', { participants: TALK_DIR, events: talkEvents(), ...extra });
const shape = (windows) => windows.map((w) => `${w.actor}|${w.role ?? ''}|${w.partners.join(',')}|${w.items.map((i) => `${i.event.id}:${i.side}${i.broadcast ? '*' : ''}`).join(' ')}`);
const ring = (actors) => actors.map((actor, index, all) => ev({ id: `m${index}`, actor, actorId: actor.toLowerCase(), to: [all[(index + 1) % all.length].toLowerCase()], timestamp: at(index) }));
const ringDir = (actors) => dir(...actors.map((actor) => [actor.toLowerCase(), actor]));

await check('UI-C1-C1 CollaborationEventV1 identity and recipients: optional and strict; a bad one refuses the event, never repairs it', () => {
  const [plain] = parseCollaborationEvents('p', [ev()]).events;
  assert.equal(plain.to, undefined, 'without `to` the event is unchanged');
  assert.equal(plain.actorId, undefined, 'a historical event without actorId stays valid');
  const [sent] = parseCollaborationEvents('p', [ev({ actorId: 'claude-1', to: ['gpt-1', 'chief'] })]).events;
  assert.equal(sent.actorId, 'claude-1');
  assert.deepEqual(sent.to, ['gpt-1', 'chief'], 'participant IDs, kept in the order given');
  assert.ok(Object.isFrozen(sent.to));
  const bad = { 'not a list': 'gpt', 'an empty list': [], 'more than eight': ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'], 'a number': [7],
    'a blank ID': ['  '], 'a padded ID': [' gpt '], 'a display name, not an ID': ['GPT 審查'], 'a control character': ['g\u0007pt'], 'an ID over 80': ['x'.repeat(81)],
    'a repeated ID': ['gpt', 'gpt'], 'its own sender': ['claude-1'], 'an object': [{ id: 'gpt' }] };
  for (const [why, to] of Object.entries(bad)) assert.equal(parseCollaborationEvents('p', [ev({ actorId: 'claude-1', to })]).rejected, 1, `refused: ${why}`);
  assert.equal(parseCollaborationEvents('p', [ev({ to: ['gpt'] })]).rejected, 1, 'addressees need a sender identity: a historical record names none');
  for (const actorId of ['', ' claude', 'cl aude', 7, 'x'.repeat(81)]) assert.equal(parseCollaborationEvents('p', [ev({ actorId })]).rejected, 1, `bad actorId ${actorId}`);
  assert.equal(parseCollaborationEvents('p', [ev({ type: 'SYSTEM', actorId: 'sys' })]).rejected, 1, 'a SYSTEM line belongs to no participant');
  assert.equal(parseCollaborationEvents('p', [ev({ type: 'SYSTEM', actorId: 'a', to: ['b'] })]).rejected, 1, 'a SYSTEM line is addressed to no one');
  assert.equal(parseCollaborationEvents('p', [ev({ type: 'ESCALATION', actorId: 'a', to: ['b'] })]).rejected, 1, 'an escalation goes to the Human by its type');
  assert.equal(parseCollaborationEvents('p', [ev({ actorId: 'z', to: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] })]).events.length, 1, 'eight is allowed');
  for (const field of ['recipients', 'participantId', 'from', 'delivered']) {
    assert.equal(parseCollaborationEvents('p', [ev({ actorId: 'a', [field]: ['b'] })]).rejected, 1, `strict: ${field} is outside the model`);
  }
});

await check('UI-C1-C1 C1 omitted `to`: a compatibility broadcast to every other participant, from the one source event', () => {
  const room = talkRoom();
  assert.equal(room.identity, 'IDENTIFIED');
  const windows = conversationOf(room);
  assert.deepEqual(shape(windows), [
    'Lead|統籌|maker,checker|s0:system h1:out n1:in* x1:out',
    'Maker|實作|lead,checker,watcher|s0:system h1:in p1:out n1:out c1:in w1:out',
    'Checker|審查|lead,maker|s0:system h1:in p1:in n1:in* c1:out',
    'Watcher||maker|s0:system n1:in* w1:in',
  ], 'n1 (no `to`) is shown to Lead, Checker and Watcher, once each, and to its sender only as sent');
  const holding = (id) => windows.filter((w) => w.items.some((i) => i.event.id === id)).map((w) => w.key);
  assert.deepEqual(holding('n1'), ['lead', 'maker', 'checker', 'watcher']);
  assert.equal(windows.flatMap((w) => w.items).filter((i) => i.event.id === 'n1' && i.side === 'out').length, 1, 'the sender is excluded from its own broadcast');
  // No source event is made or copied: the room holds the input events, and every window refers to those same objects.
  assert.equal(room.events.length, talkEvents().length);
  const referenced = new Set(windows.flatMap((w) => w.items.map((i) => i.event)));
  assert.equal(referenced.size, room.events.length);
  assert.ok([...referenced].every((event) => room.events.includes(event)), 'every window item is one of the room\'s own events');
  assert.deepEqual(room.summary.needsHuman.map((e) => e.id), ['x1']);
  // SYSTEM and ESCALATION keep their own semantics.
  assert.ok(windows.every((w) => w.items[0].event.id === 's0' && w.items[0].side === 'system' && w.items[0].seq === 1), 'SYSTEM in every window, not as a message');
  assert.deepEqual(holding('x1'), ['lead'], 'an escalation reaches no other window, broadcast or not');
  const html = conversationHTML(room);
  assert.equal((html.match(/data-id="n1"/g) ?? []).length, 4);
  assert.match(html, /<li class="cm cm-out t-response" data-seq="4" data-id="n1"><div class="bub">沒有寫收件者的訊息。<\/div><p class="cm-m"><span class="cm-t">回應<\/span> · 未指定收件者 · 相容顯示給其他參與者 · <time/);
  assert.equal((html.match(/<li class="cm cm-in cm-bc t-response" data-seq="4" data-id="n1"><p class="cm-from">Maker<\/p><div class="bub">沒有寫收件者的訊息。<\/div>\s*<p class="cm-m"><span class="cm-t">回應<\/span> · 未指定收件者 · 相容顯示，不代表已送達 · <time/g) ?? []).length, 3);
  assert.equal(BROADCAST_SENT, '未指定收件者 · 相容顯示給其他參與者');
  assert.equal(BROADCAST_SHOWN, '未指定收件者 · 相容顯示，不代表已送達');
  assert.doesNotMatch((html + read('collaboration.js').replace(/\/\/.*$/gm, '')).replaceAll('不代表已送達', ''), /送達|delivered|已讀/, 'nothing claims a delivery');
  assert.doesNotMatch(html, /沒有記錄收件者/, 'the UI-C1 "stays with its sender" wording is gone');
});

await check('UI-C1-C1 C2 explicit `to` reaches only the participant IDs it names', () => {
  const room = talkRoom();
  const windows = conversationOf(room);
  const received = windows.flatMap((w) => w.items.filter((i) => i.side === 'in' && !i.broadcast).map((i) => [w.key, i.event]));
  assert.equal(received.length, room.events.reduce((n, e) => n + (e.to?.length ?? 0), 0), 'exactly one delivery per named addressee');
  assert.ok(received.every(([key, event]) => event.to.includes(key)), 'every addressed item is in a window the event names by ID');
  assert.deepEqual(windows.filter((w) => w.items.some((i) => i.event.id === 'w1')).map((w) => w.key), ['maker', 'watcher']);
  assert.deepEqual(conversationOf(collaborationRoom('p', { participants: ringDir(['A', 'B', 'C', 'D', 'E', 'F']), events: ring(['A', 'B', 'C', 'D', 'E', 'F']) })).map((w) => w.actor),
    ['A', 'B', 'C', 'D', 'E', 'F'], 'no participant is dropped');
  const extra = conversationOf(talkRoom({ participants: [...TALK_DIR, { id: 'auditor', name: 'Auditor' }] }));
  assert.equal(shape(extra).at(-1), 'Auditor||maker|s0:system n1:in*', 'a directory participant who neither spoke nor was named still receives the broadcast, and nothing else');
});

await check('UI-C1-C1 C2 two participants with one display name stay two: separate windows, told apart in every label', () => {
  const room = collaborationRoom('p', { participants: dir(['claude-a', 'Claude'], ['claude-b', 'Claude'], ['gpt', 'GPT']), events: [
    ev({ id: 'a1', actor: 'Claude', actorId: 'claude-a', to: ['gpt'], body: '我是 A。', timestamp: at(1) }),
    ev({ id: 'b1', actor: 'Claude', actorId: 'claude-b', to: ['gpt'], body: '我是 B。', timestamp: at(2) }),
    ev({ id: 'g1', actor: 'GPT', actorId: 'gpt', to: ['claude-b'], body: '只給 B。', timestamp: at(3) }),
  ] });
  assert.equal(room.unverified, 0);
  const windows = conversationOf(room);
  assert.deepEqual(shape(windows), ['Claude|Implementer|gpt|a1:out', 'GPT|Implementer|claude-a,claude-b|a1:in b1:in g1:out', 'Claude|Implementer|gpt|b1:out g1:in']);
  assert.deepEqual(windows.map((w) => w.actorId), ['claude-a', 'gpt', 'claude-b']);
  const label = labelsOf(room);
  assert.deepEqual(['claude-a', 'claude-b', 'gpt'].map(label), ['Claude · claude-a', 'Claude · claude-b', 'GPT'], 'only a shared name gets its ID beside it');
  const html = conversationHTML(room);
  assert.match(html, /<section class="cw" id="cw-1" data-w="1" data-p="claude-a" aria-label="Claude · claude-a 的對話">/);
  assert.match(html, /<section class="cw" id="cw-3" data-w="3" data-p="claude-b" aria-label="Claude · claude-b 的對話">/);
  assert.match(html, /data-cw="3" data-p="claude-b" aria-controls="cw-3" aria-selected="false">Claude · claude-b<span class="cw-dot"/);
  assert.match(html, /<li class="cm cm-out t-proposal" data-seq="3" data-id="g1"><div class="bub">只給 B。<\/div><p class="cm-m"><span class="cm-t">提案<\/span> · 給 Claude · claude-b · <time/);
  assert.match(html, /<p class="cm-from">Claude · claude-a<\/p><div class="bub">我是 A。/);
  assert.match(html, /<span class="cw-r">Implementer · 和 Claude · claude-a、Claude · claude-b 對話<\/span>/);
  assert.equal(summarizeCollaboration('p', room.events).activeParticipants.length, 3, 'the summary counts them apart too');
  // The legacy rule is the opposite, and the room says so: one name is one participant.
  const legacy = collaborationRoom('p', { events: [ev({ id: 'a1', actor: 'Claude', timestamp: at(1) }), ev({ id: 'b1', actor: 'Claude', timestamp: at(2) })] });
  assert.equal(conversationOf(legacy).length, 1);
});

await check('UI-C1-C1 C2 unknown or conflicting identities fail closed', () => {
  const base = (events, participants = TALK_DIR) => collaborationRoom('p', { participants, events: [talkEvents()[1], ...events] });
  const cases = {
    'an unknown recipient ID': ev({ id: 'u1', actor: 'Maker', actorId: 'maker', to: ['stranger'], timestamp: at(9) }),
    'one unknown among known recipients': ev({ id: 'u1', actor: 'Maker', actorId: 'maker', to: ['checker', 'stranger'], timestamp: at(9) }),
    'an unknown sender ID': ev({ id: 'u1', actor: 'Maker', actorId: 'maker-2', to: ['checker'], timestamp: at(9) }),
    'a sender whose name conflicts with the directory': ev({ id: 'u1', actor: 'Checker', actorId: 'maker', to: ['lead'], timestamp: at(9) }),
    'an escalation from an unknown sender': ev({ id: 'u1', type: 'ESCALATION', actor: 'Ghost', actorId: 'ghost', timestamp: at(9) }),
  };
  for (const [why, event] of Object.entries(cases)) {
    const room = base([event]);
    assert.equal(room.identity, 'IDENTIFIED', why);
    assert.deepEqual([room.events.map((e) => e.id), room.unverified], [['h1'], 1], `refused: ${why}`);
    assert.match(roomHTML(room), /有 <span class="num">1<\/span> 則事件的參與者身分無法確認，沒有顯示。/, why);
    assert.doesNotMatch(conversationHTML(room), /stranger|maker-2|Ghost|data-id="u1"/, `nothing of it is shown: ${why}`);
  }
  assert.deepEqual(base([cases['an escalation from an unknown sender']]).summary.needsHuman, [], 'an unverified escalation never reaches 需要你');
  // A directory that cannot be trusted is not used at all; it is never repaired.
  const directories = { missing: undefined, 'not a list': { lead: 'Lead' }, empty: [], 'a repeated ID': [...TALK_DIR, { id: 'lead', name: 'Lead 2' }],
    'an unknown field': [{ id: 'lead', name: 'Lead', role: '統籌' }, ...TALK_DIR.slice(1)], 'a bad ID': [{ id: 'le ad', name: 'Lead' }, ...TALK_DIR.slice(1)],
    'a blank name': [{ id: 'lead', name: ' ' }, ...TALK_DIR.slice(1)], 'over 32 entries': [...TALK_DIR, ...Array.from({ length: 29 }, (_, i) => ({ id: `p${i}`, name: `P${i}` }))] };
  for (const [why, participants] of Object.entries(directories)) {
    const room = talkRoom({ participants });
    assert.equal(room.identity, 'NO_DIRECTORY', why);
    assert.equal(conversationOf(room), null, `no window is guessed: ${why}`);
    assert.deepEqual(room.participants, []);
  }
});

await check('UI-C1-C1 C2 one rule per room: legacy records by name, said so; mixed records shown in order with a warning, nothing guessed', () => {
  // Legacy: historical events (no actorId, so no `to`) stay readable, told apart by name, and the room says so.
  const legacyEvents = [
    ev({ id: 's0', type: 'SYSTEM', actor: '系統', role: undefined, body: '開始。', timestamp: at(0) }),
    ev({ id: 'l1', actor: 'Codex', role: 'Reviewer', body: '先看測試。', timestamp: at(1) }),
    ev({ id: 'l2', actor: 'Claude', body: '好。', timestamp: at(2) }),
    ev({ id: 'l3', type: 'ESCALATION', actor: 'Codex', role: 'Reviewer', body: '需要你。', timestamp: at(3) }),
  ];
  const legacy = collaborationRoom('p', { events: legacyEvents, participants: TALK_DIR });
  assert.equal(legacy.identity, 'LEGACY', 'no message carries actorId: the directory is not used to match names');
  assert.equal(legacy.unverified, 0);
  assert.deepEqual(shape(conversationOf(legacy)), ['Codex|Reviewer|Claude|s0:system l1:out l2:in* l3:out', 'Claude|Implementer|Codex|s0:system l1:in* l2:out']);
  const legacyHTML = roomHTML(legacy);
  assert.match(legacyHTML, /<p class="c-note" role="note">這些是沒有參與者身分代號的舊紀錄：參與者以顯示名稱區分，同名的會被當成同一位。<\/p><div class="conv"/);
  assert.match(legacyHTML, /data-p="Codex"/);
  assert.doesNotMatch(roomHTML(talkRoom()), /c-note|c-warn/, 'an identified room needs no note');
  // Mixed: some messages carry actorId and some do not. No window, no addressee, no replay, a warning, the record in order.
  const mixed = collaborationRoom('p', { provenance: 'DEMO_SAMPLE', participants: TALK_DIR, events: [...talkEvents(), ev({ id: 'old', actor: 'Maker', body: '舊的。', timestamp: at(7) })] });
  assert.equal(mixed.identity, 'MIXED');
  assert.equal(conversationOf(mixed), null);
  assert.deepEqual(mixed.events.map((e) => e.id), ['s0', 'h1', 'p1', 'n1', 'c1', 'w1', 'x1', 'old'], 'the record is kept whole, in order');
  const html = roomHTML(mixed, { replay: true });
  assert.match(html, /<p class="c-warn" role="note">這個協作室同時有附身分代號和沒有身分代號的紀錄，無法確定誰是誰。以下依時間列出原始紀錄：不分對話視窗，也不推算收件者。<\/p>/);
  assert.equal((html.match(/<section class="cw"/g) ?? []).length, 1);
  assert.match(html, /<section class="cw" id="cw-1" data-w="1" data-p="" aria-label="原始紀錄"><header class="cw-h"><b class="cw-n">原始紀錄<\/b><span class="cw-r">未分視窗 · 不推算收件者<\/span><\/header>/);
  assert.match(html, /<p class="cm-from">Maker · maker<\/p>/);
  assert.match(html, /<p class="cm-from">Maker · 沒有身分代號<\/p>/);
  assert.doesNotMatch(html, /cw-tabs|data-replay|cv-bar|cm-typing|cm-out|cm-bc| 給 |也給|相容顯示|data-p="maker"/, 'nothing is routed, addressed or replayed');
  assert.match(html, /<h2 class="nr-h" id="needs-h" tabindex="-1">需要你 <span class="num nr-c">1<\/span>/, 'an escalation still reaches 需要你');
  const unlisted = roomHTML(talkRoom({ participants: undefined }));
  assert.match(unlisted, /<p class="c-warn" role="note">這些紀錄附有身分代號，但沒有可用的參與者名冊，無法確認誰是誰。/);
  assert.deepEqual(IDENTITY_RULES, ['IDENTIFIED', 'LEGACY', 'MIXED', 'NO_DIRECTORY']);
  assert.equal(identityOf([], null), 'LEGACY');
  assert.equal(identityOf(parseCollaborationEvents('p', [ev({ type: 'SYSTEM', actor: '系統' })]).events, null), 'LEGACY', 'SYSTEM lines never decide the rule');
});

await check('UI-C1 windows: sent on the right, received on the left under the sender\'s name; tabs for every window', () => {
  const html = conversationHTML(talkRoom());
  const win = (n) => html.slice(html.indexOf(`<section class="cw" id="cw-${n}"`), html.indexOf('</section>', html.indexOf(`<section class="cw" id="cw-${n}"`)));
  assert.match(win(2), /^<section class="cw" id="cw-2" data-w="2" data-p="maker" aria-label="Maker 的對話">\s*<header class="cw-h"><b class="cw-n">Maker<\/b><span class="cw-r">實作 · 和 Lead、Checker、Watcher 對話<\/span><\/header>/);
  assert.match(win(2), /<li class="cm cm-in t-handoff" data-seq="2" data-id="h1"><p class="cm-from">Lead<\/p><div class="bub">交給你們。<\/div>\s*<p class="cm-m"><span class="cm-t">交接<\/span> · 也給 Checker · <time/);
  assert.match(win(2), /<li class="cm cm-out t-proposal" data-seq="3" data-id="p1"><div class="bub">先改 middleware。<\/div><p class="cm-m"><span class="cm-t">提案<\/span> · 給 Checker · <time/);
  assert.match(win(2), /<li class="cm cm-in t-challenge" data-seq="5" data-id="c1"><p class="cm-from">Checker<\/p><div class="bub">有問題。<p class="att" aria-label="附件"><span><b>檔案<\/b><code>src\/a\.ts<\/code><\/span><\/p><\/div>/);
  assert.match(win(1), /<li class="cm cm-out t-escalation" data-seq="7" data-id="x1"><div class="bub">需要你決定。<\/div><p class="cm-m"><span class="cm-t">需要你<\/span> · 給 你 · <time/);
  assert.match(win(4), /<span class="cw-r">和 Maker 對話<\/span>/, 'no role is invented for a participant who never spoke');
  assert.equal((html.match(/<li class="cm-sys" data-seq="1" data-id="s0">/g) ?? []).length, 4);
  assert.equal((html.match(/class="cm cm-in /g) ?? []).length, 5 + 3, 'five addressed deliveries and one broadcast shown to three');
  assert.match(html, /<div class="cw-tabs" role="tablist" aria-label="切換對話視窗"><button type="button" role="tab" data-cw="1" data-p="lead" aria-controls="cw-1" aria-selected="true">Lead<span class="cw-dot" aria-hidden="true"><\/span><\/button>/);
  assert.equal((html.match(/role="tab"/g) ?? []).length, 4);
  assert.match(html, /<div class="chats" data-n="4" data-active="1">/);
  const wide = conversationHTML(collaborationRoom('p', { participants: ringDir(['A', 'B', 'C', 'D', 'E', 'F']), events: ring(['A', 'B', 'C', 'D', 'E', 'F']) }));
  assert.match(wide, /<div class="chats cw-many" data-n="4" data-active="1">/);
  assert.equal((wide.match(/<section class="cw"/g) ?? []).length, 6, 'more than four windows scroll sideways; none is dropped');
  assert.equal(attachmentsHTML(undefined), '');
  assert.match(attachmentsHTML([{ kind: 'TESTS', passed: 3 }, { kind: 'COMMIT', sha: '4820528f0be1ba' }]), /<b>測試<\/b><span class="num">3<\/span> 項通過<\/span><span><b>提交<\/b><code title="4820528f0be1ba">4820528<\/code>/, 'no failure count is invented');
});

await check('UI-C1 layout: the gold 需要你 strip, then the windows; side by side when wide, one at a time behind name tabs when narrow', () => {
  const room = collaborationRoom('p', { participants: RECORD_DIR, events: record() });
  const html = roomHTML(room);
  assert.match(html, /<div class="room-body">\s*<section class="nstrip has-need" aria-labelledby="needs-h"><h2 class="nr-h" id="needs-h" tabindex="-1">需要你 <span class="num nr-c">1<\/span><\/h2>/);
  assert.match(html, /<section class="disc" aria-label="AI 之間的對話"><div class="conv" data-key="p" data-max="6">/);
  const shell = [...read('index.html').matchAll(/class="([\w-]+)/g)].map((m) => m[1]);
  const demo = roomHTML(collaborationRoom('p', { provenance: 'DEMO_SAMPLE', participants: RECORD_DIR, events: record() }), { replay: true });
  const used = new Set([...(html + demo).matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)));
  assert.deepEqual(shell.filter((name) => used.has(name)), [], 'the room reuses no class of the page shell (a .rail once collided)');
  const css = read('styles.css');
  const block = css.slice(css.indexOf('/* 協作室 as conversations (UI-C1)'), css.indexOf('/* the project rail folds away'));
  assert.match(block, /\.room-body\{[^}]*container:room\/inline-size/);
  assert.match(block, /\.conv\{[^}]*container:conv\/inline-size/);
  assert.match(block, /\.cw\{display:none;/, 'narrow: one window at a time');
  assert.match(block, /\.chats\[data-active="1"\] \.cw\[data-w="1"\][\s\S]*\.chats\[data-active="8"\] \.cw\[data-w="8"\]\{display:flex\}/);
  const wide = block.slice(block.indexOf('@container conv (min-width:720px){'), block.indexOf('.cw-h{'));
  assert.match(wide, /\.cw-tabs\{display:none\}/);
  assert.match(wide, /\.chats\{grid-template-columns:repeat\(var\(--n,1\),minmax\(0,1fr\)\)\}/);
  assert.match(wide, /\.chats \.cw\{display:flex\}/);
  assert.match(block, /\.cm-out\{align-self:flex-end/);
  assert.match(block, /\.cm-in\{align-self:flex-start/);
  const gold = block.match(/[^{}]+\{[^}]*(--gold|--human)[^}]*\}/g).map((rule) => rule.trim().split('{')[0]);
  assert.deepEqual(gold, ['.nstrip.has-need .nr-h', '.cm.t-escalation .bub', '.cm.t-escalation .cm-t'], 'gold only for what needs the Human');
  assert.doesNotMatch(css, /\.rg\b|\.rtabs|\.xg|\.ev-n|\.csum/, 'the replaced two-area, exchange and summary styles are gone');
});

await check('WS-P2 addresses still work: 需要你 links land on 協作室 /needs, where the strip is the first thing', () => {
  const { parseRoute } = resolver;
  assert.deepEqual(parseRoute('#/p/cand/collaboration/needs'), { view: 'project', projectId: 'cand', pane: 'collaboration', area: 'needs', root: false });
  assert.deepEqual(parseRoute('#/p/cand/collaboration/discussion'), { view: 'project', projectId: 'cand', pane: 'collaboration', area: 'discussion', root: false });
  for (const root of ['#/p/cand/now/needs', '#/p/cand/collaboration/decide', '#/p/cand/collaboration/needs/x']) assert.equal(parseRoute(root).root, true, `${root} is the root`);
  const app = read('app.js');
  assert.match(app, /case 'room': go\('project', v, \{ pane: 'collaboration', area: 'needs' \}\); \$\('#needs-h'\)\?\.focus\(\); break;/);
  assert.doesNotMatch(app + read('collaboration.js'), /room-tab|disc-h/, 'no tab between areas is left: there is one room');
  assert.match(slice('function stageHTML', 'function homeView'), /toRoom\('查看協作室', 'btn gold', 'needs'\)/);
  assert.match(slice('function homeView', 'function projectView'), /paneHref\(projectId, 'collaboration', 'needs'\)/);
  assert.match(slice('function projectView', 'function projectsView'), /roomHTML\(r, \{ demo: demoRoom\(\), replay: DEMO \}\)/);
});

await check('WS-P2 需要你 keeps its place when empty, with a calm empty state', () => {
  const quiet = collaborationRoom('p', { participants: RECORD_DIR, events: record().filter((e) => e.type !== 'ESCALATION') });
  const html = roomHTML(quiet);
  assert.match(html, /<section class="nstrip" aria-labelledby="needs-h"><h2 class="nr-h" id="needs-h" tabindex="-1">需要你 <span class="num nr-c">0<\/span><\/h2>\s*<ul class="nr"><\/ul><div class="nr-empty">/);
  assert.ok(html.includes(NEEDS_EMPTY));
  assert.match(NEEDS_EMPTY, /目前沒有需要你決定的事。[\s\S]*AI 之間無法自行決定的事，會出現在這裡。/);
  assert.match(roomHTML(collaborationRoom('p', { participants: RECORD_DIR, events: record() })), /<div class="nr-empty" hidden>/, 'with an escalation the empty line is hidden, not removed');
  const css = read('styles.css');
  assert.match(css, /\.nstrip \[hidden\]\{display:none\}/);
  assert.doesNotMatch(css, /\.nstrip \.nr-empty\{[^}]*display:/, 'no rule may out-rank [hidden] on the empty line (it once showed beside a waiting escalation)');
});

await check('UI-C1 demo/LIVE separation: only demo data on the demo page replays; a record is never replayed', () => {
  const live = collaborationRoom('p', { provenance: 'NONE', participants: RECORD_DIR, events: record() });
  const demo = collaborationRoom('p', { provenance: 'DEMO_SAMPLE', participants: RECORD_DIR, events: record() });
  for (const [html, why] of [[roomHTML(live), 'LIVE'], [roomHTML(live, { replay: true }), 'LIVE even when the page asks'], [roomHTML(demo), 'demo data when the page did not ask']]) {
    assert.doesNotMatch(html, /data-replay|cv-bar|示範重播|cm-typing|正在輸入/, `no replay: ${why}`);
  }
  const replay = roomHTML(demo, { replay: true });
  assert.match(replay, /<div class="conv" data-key="p" data-max="6" data-replay="1"><div class="cv-bar"><span class="cv-k">示範重播<\/span>/);
  assert.match(replay, /<p class="demo-tag" role="note"><b>示範資料<\/b>/, 'a replay is always labelled as demo data');
  assert.match(replay, /<li class="nr-i" data-seq="6">/, 'the strip knows each escalation\'s place, so the replay can reveal it in turn');
  assert.doesNotMatch(roomHTML(collaborationRoom('p', { provenance: 'DEMO_SAMPLE', events: [...record(), ev({ id: 'old', timestamp: '2026-10-06T04:55:00.000Z' })] }), { replay: true }),
    /data-replay|cv-bar|cm-typing/, 'a room whose participants cannot be told apart is never replayed, demo or not');
  assert.match(slice('function projectView', 'function projectsView'), /replay: DEMO \}/, 'the page asks for a replay only in demo mode');
  assert.deepEqual(replayStart({ replay: false, max: 9, reducedMotion: false }), { replaying: false, sent: 9, delivered: 9 }, 'a record shows everything');
  assert.deepEqual(replayStart({ replay: true, max: 9, reducedMotion: true }), { replaying: false, sent: 9, delivered: 9 }, 'reduced motion: no replay');
  assert.deepEqual(replayStart({ replay: true, max: 9, reducedMotion: false }), { replaying: true, sent: 0, delivered: 0 });
  assert.equal(revealed(3, 'out', { sent: 3, delivered: 2 }), true);
  assert.equal(revealed(3, 'in', { sent: 3, delivered: 2 }), false, 'a receiver sees it a moment after it was sent');
  const module = read('conversation.js');
  assert.match(module, /const replay = root\.dataset\.replay === '1';/);
  assert.match(module, /if \(!replay\) \{\n    S\.sent = S\.delivered = max;/, 'a record keeps showing all of itself as it grows');
  assert.match(module, /if \(!control \|\| !S\.replay\) return;/, 'the replay controls do nothing outside a replay room');
  assert.match(module, /if \(!S\.replay\) return;\n[\s\S]*querySelector\('\.nstrip'\)/, 'only a replay touches the 需要你 strip');
  assert.doesNotMatch(module, /\bimport\b|fetch|EventSource|XMLHttpRequest|localStorage|sessionStorage|source\./, 'no network, storage, imports or source');
  assert.doesNotMatch(read('collaboration.js'), /正在輸入/, 'the record markup never says anyone is typing');
});

await check('UI-C1-C1 C3 LIVE unread: a message arriving while a record room is open marks its window; history, replay and the window in front never do', () => {
  const items = (events) => conversationOf(collaborationRoom('p', { provenance: 'NONE', participants: TALK_DIR, events }))
    .flatMap((w) => w.items.map((i) => ({ w: w.key, id: i.event.id })));
  const opening = items(talkEvents().slice(0, 4));
  const first = arrivals(null, opening, { active: 'lead', wide: false });
  assert.deepEqual([first.fresh, first.unread], [[], []], 'what the room held when it was opened is history: nothing in it is new');
  assert.equal(first.seen.size, opening.length);
  assert.deepEqual(arrivals(first.seen, opening, { active: 'lead', wide: false }).fresh, [], 'a re-render with nothing new marks nothing');
  const grown = items(talkEvents().slice(0, 6)); // c1 (checker → maker) and w1 (maker → watcher) arrive while the room is open
  const next = arrivals(first.seen, grown, { active: 'lead', wide: false });
  assert.deepEqual(next.fresh.map((i) => `${i.w}:${i.id}`), ['maker:c1', 'maker:w1', 'checker:c1', 'watcher:w1']);
  assert.deepEqual(next.unread, ['maker', 'checker', 'watcher'], 'every window that gained a message, except the one in front');
  assert.deepEqual(arrivals(first.seen, grown, { active: 'maker', wide: false }).unread, ['checker', 'watcher'], 'the window in front is being read');
  assert.deepEqual(arrivals(first.seen, grown, { active: 'lead', wide: true }).unread, [], 'side by side, every window is in view');
  assert.deepEqual(arrivals(next.seen, grown, { active: 'lead', wide: false }).fresh, [], 'a message is new once');
  const broadcast = ev({ id: 'n2', actor: 'Checker', actorId: 'checker', role: '審查', body: '大家注意。', timestamp: at(7) });
  const heard = arrivals(next.seen, items([...talkEvents().slice(0, 6), broadcast]), { active: 'lead', wide: false });
  assert.deepEqual(heard.fresh.map((i) => `${i.w}:${i.id}`), ['lead:n2', 'maker:n2', 'checker:n2', 'watcher:n2'], 'a new broadcast lands once in every window (its sender\'s as sent)');
  assert.deepEqual(heard.unread, ['maker', 'checker', 'watcher'], 'every window but the one in front gets a dot');
  assert.deepEqual([...opened(new Set(['maker', 'checker', 'watcher']), 'checker')], ['maker', 'watcher'], 'opening one window clears that window\'s dot only');
  // Wiring: only a record room (never a replay) tracks arrivals; windows are followed by participant, not by position.
  const module = read('conversation.js');
  assert.match(module, /if \(!replay\) \{[\s\S]*const now = arrivals\(S\.seen, items, \{ active: front\(root\)\?\.dataset\.p \?\? null, wide: wideRoom\(root\) \}\);/);
  assert.match(module, /Object\.assign\(S, \{ key, replay, max, active: null, seen: null \}/, 'a room opened again starts from its history');
  assert.match(module, /if \(tab\) \{ S\.active = tab\.dataset\.p; S\.unread = opened\(S\.unread, S\.active\); apply\(\); return; \}/);
  assert.match(module, /for \(const win of S\.replay \? root\.querySelectorAll\('\.cw'\) : \[\]\) \{/, 'the replay reveal, typing row and its dots run only in a replay room');
  assert.match(module, /tab\.classList\.toggle\('cw-unread', S\.unread\.has\(tab\.dataset\.p\)\)/);
  // LIVE never shows the demo typing effect, however the record grows and whatever the page asks for.
  const live = (events) => roomHTML(collaborationRoom('p', { provenance: 'NONE', participants: TALK_DIR, events }), { replay: true });
  for (const html of [live(talkEvents().slice(0, 4)), live(talkEvents())]) assert.doesNotMatch(html, /cm-typing|正在輸入|data-replay|cv-bar|示範/);
  assert.doesNotMatch(read('collaboration.js') + read('app.js'), /正在輸入/);
});

await check('UI-C1-C1 adds no execution or authority capability', () => {
  assert.equal(API_ROUTES.length, 11, 'no route');
  const app = read('app.js');
  assert.doesNotMatch(app, /source\.(send|post|deliver|ack|participants)\b/, 'the page asks the source for nothing new');
  for (const file of ['collaboration.js', 'conversation.js']) {
    assert.doesNotMatch(read(file), /\bimport\b|fetch\(|EventSource|XMLHttpRequest|localStorage|sessionStorage|\bsource\./, `${file}: no network, storage or source`);
  }
  assert.deepEqual(Object.keys(createLiveSource({ fetchImpl: async () => ({}), EventSourceImpl: class {} })).sort(),
    ['addGoal', 'collaboration', 'executionStatus', 'mode', 'projects', 'queue', 'removeGoal', 'reorder', 'subscribe'], 'LIVE source unchanged');
  assert.match(read('live.js'), /collaboration: async \(projectId\) => \(\{ projectId, provenance: 'NONE', events: \[\] \}\),/, 'LIVE still has no collaboration events and makes no request for them');
});

await check('UI-C1 identity is display metadata: windows and names come from the record; no code names an agent', () => {
  const html = roomHTML(collaborationRoom('p', { participants: RECORD_DIR, events: record() }));
  assert.match(html, /<b class="cw-n">Gemini<\/b><span class="cw-r">Planner · 和 Tool-X 對話<\/span>/);
  assert.doesNotMatch(html, /正在|working|online|上線|typing|輸入中/i, 'no live presence');
  const codeOnly = (file) => read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
  for (const file of ['collaboration.js', 'conversation.js', 'app.js']) assert.doesNotMatch(codeOnly(file), /Claude|Codex|GPT|Gemini|OpenAI/, `${file} names no particular agent`);
});

await check('UI-C1 evidence: attachments inside the message that carried them; the 需要你 strip keeps the evidence block', () => {
  const html = roomHTML(collaborationRoom('p', { participants: RECORD_DIR, events: record() }));
  assert.match(html, /<div class="bub">過期 token 被提前拒絕。<p class="att" aria-label="附件"><span><b>檔案<\/b><code>src\/auth\.ts:84–112<\/code><\/span><\/p><\/div>/);
  assert.match(html, /<div class="bub">重新驗證。<p class="att" aria-label="附件"><span><b>測試<\/b><span class="num">18<\/span> 項通過 · <span class="num">0<\/span> 項失敗<\/span><\/p><\/div>/);
  assert.match(html, /<li class="nr-i" data-seq="6"><p class="nr-q">要不要改 public API？<\/p>[\s\S]*<dl class="evd" aria-label="證據">/);
  assert.doesNotMatch(html, /<a |href=|https?:/, 'display only: no link to a repository or GitHub');
  const css = read('styles.css');
  assert.match(css, /\.nr-i \.evd\{width:100%;--tone:var\(--gold\)\}/);
  assert.match(css, /\.evd::before\{content:"附上的證據"/);
});

await check('UI-C1 rail: folds on wide layouts by button or [ key, kept across renders and reloads, never on narrow layouts', () => {
  const app = read('app.js');
  assert.match(app, /const RAIL = 'chief\.workspace\.rail';\nS\.railOff = \(\(\) => \{ try \{ return localStorage\.getItem\(RAIL\) === 'off'; \} catch \{ return false; \} \}\)\(\);/);
  const toggle = slice('function toggleRail', 'function railKey');
  assert.match(toggle, /try \{ localStorage\.setItem\(RAIL, S\.railOff \? 'off' : 'on'\); \} catch/);
  assert.doesNotMatch(toggle, /render\(\)|\bgo\(|location\.|history\./, 'folding changes the frame only: no re-render, no navigation');
  assert.match(toggle, /if \(leaving\) button\?\.focus\(\);/, 'focus inside the folding rail moves to the button');
  assert.match(slice('function render(', '// ---------- actions'), /\$\('#top'\)\.innerHTML = topHTML\(\);\n  \$\('#app'\)\.classList\.toggle\('rail-off', S\.railOff\);/, 'every render keeps the fold');
  assert.match(slice('function topHTML', 'function railHTML'), /<button class="rbtn" type="button" data-act="rail" aria-controls="rail" aria-expanded="\$\{!S\.railOff\}" aria-label="\$\{railLabel\(\)\}"/);
  const key = slice('function railKey', '// ---------- data');
  for (const guard of ['!event.metaKey', '!event.ctrlKey', '!event.altKey', '!event.isComposing', "getComputedStyle(button).display !== 'none'", "closest('input,textarea,select,[contenteditable]')"]) {
    assert.ok(key.includes(guard), `[ is ignored unless: ${guard}`);
  }
  assert.match(app, /case 'rail': toggleRail\(\); break;/);
  assert.match(app, /if \(railKey\(event\)\) \{ event\.preventDefault\(\); toggleRail\(\); return; \}/);
  assert.deepEqual([...app.matchAll(/localStorage\.setItem\((\w+)/g)].map((m) => m[1]).sort(), ['LAST', 'RAIL', 'RECENT'], 'the fold is the only new stored preference');
  const css = read('styles.css');
  const wide = css.slice(css.indexOf('@media (min-width:760px){'), css.indexOf('}\n', css.lastIndexOf('.rbtn[aria-expanded="false"]')) + 2);
  assert.equal((css.match(/rail-off/g) ?? []).length, (wide.match(/rail-off/g) ?? []).length, 'every fold rule lives inside the wide-layout media query');
  assert.match(css, /\n\.rbtn\{display:none\}\n@media \(min-width:760px\)\{/, 'no fold button unless the layout is wide');
  assert.match(wide, /\.app\.rail-off\{grid-template-columns:0 minmax\(0,1fr\)\}/);
  assert.match(wide, /\.app\.rail-off \.tbtn\{display:inline-flex\}/, 'the top bar\'s project switcher stands in for the folded rail');
});

await check('WS-P2 no per-agent control: 協作室 has no composer, input or "說給" anywhere', () => {
  const html = roomHTML(collaborationRoom('p', { provenance: 'DEMO_SAMPLE', participants: RECORD_DIR, events: record() }), { replay: true });
  assert.doesNotMatch(html, /<textarea|<input|<form|<select|說給|send to|contenteditable/i);
  assert.deepEqual([...new Set([...html.matchAll(/data-(act|cw|replay)="([\w-]+)"/g)].map((m) => `${m[1]}=${m[1] === 'cw' ? 'n' : m[2]}`))].sort(),
    ['act=decision', 'cw=n', 'replay=1', 'replay=all', 'replay=restart'], 'the room\'s only controls: open the read-only decision, switch window, replay demo');
  const views = slice('function projectView', 'function projectsView');
  const branch = views.slice(views.indexOf("} else if (S.pane === 'collaboration')"), views.indexOf('} else {'));
  assert.doesNotMatch(branch, /composer|textarea|說給/);
  assert.doesNotMatch(read('app.js') + read('collaboration.js') + read('conversation.js'), /說給/);
});

await check('WS-P2 chain-of-thought boundary: the rule is stated as a source obligation, not claimed as enforced', () => {
  const module = read('collaboration.js');
  assert.match(module, /CollaborationEventV1 represents only collaboration artifacts a participant\n\/\/ explicitly emitted: an agent message, a review comment, a hand-off, evidence, an operational event, or a summary of\n\/\/ the rationale for a decision\./);
  assert.match(module, /A future execution source MUST NOT put\n\/\/ hidden or private model reasoning into `body`/);
  assert.match(module, /it cannot tell what text a source puts into `body`/, 'the code says what it cannot prove');
  assert.doesNotMatch(module, /no source can put chain-of-thought|cannot smuggle/, 'the WS-P1 overclaim is gone');
  const app = read('app.js');
  assert.match(app, /參與工作的 AI 彼此明確送出的訊息，每個 AI 一個對話視窗：它送出的在右邊，寫給它的在左邊。「給」是紀錄寫的收件者；沒寫收件者的訊息會相容顯示在其他每個視窗。兩者都不代表訊息確實送達。這是它們送出的訊息，不是 AI 的思考過程。/);
  assert.doesNotMatch(app, /不包含 AI 的內部推理|真的送出/, 'the room promises nothing the projection cannot check');
});

// ---------------------------------------------------------------- G1-WE1-R0 read-only execution status
const statusView = (status, extra = {}) => ({ readModelVersion: 'goal-execution-status.v0', recordClass: 'OPERATIONAL_RECORD',
  authority: 'NOT_EXECUTION_AUTHORITY', status, reason: null, executionEligibility: 'EXECUTION_ELIGIBILITY_NOT_EVALUATED', attention: 'NONE',
  change: null, run: null, nextMoves: [], directAuthority: [], unresolvedAuthority: [], operationalProvenance: null, snapshotId: null,
  notice: 'n', ...extra });
await check('WE1-R0 UI: every status has its truthful Traditional Chinese label and offers no execution, recovery or authorization control', () => {
  assert.deepEqual(Object.keys(EXECUTION_LABELS).sort(), ['BLOCKED_AUTHORITY', 'BLOCKED_PROVENANCE', 'GOAL_NOT_GOVERNED', 'GOVERNANCE_CONFLICT',
    'IN_PROGRESS', 'ROOT_PENDING', 'RUN_IDLE', 'RUN_NOT_ADMITTED', 'TERMINAL', 'WAITING_EXTERNAL_ACTOR', 'WAITING_HUMAN', 'WAITING_PACKET']);
  assert.deepEqual([EXECUTION_LABELS.RUN_IDLE, EXECUTION_LABELS.WAITING_PACKET, EXECUTION_LABELS.BLOCKED_AUTHORITY, EXECUTION_LABELS.BLOCKED_PROVENANCE,
    EXECUTION_LABELS.WAITING_HUMAN, EXECUTION_LABELS.IN_PROGRESS, EXECUTION_LABELS.TERMINAL],
  ['執行任務已建立，尚未開始', '等待正式工作文件', '缺少必要授權', '工作來源無法確認，已停止執行', '需要人工處理', '工作已有執行紀錄', '工作流程已結束']);
  const module = read('execution-status.js');
  assert.doesNotMatch(module, /fetch|EventSource|XMLHttpRequest|\/api\/|localStorage|document\.|import /, 'pure: no network, storage or DOM');
  for (const status of Object.keys(EXECUTION_LABELS)) {
    const html = executionStatusHTML({ state: 'ready', view: statusView(status, { attention: 'HUMAN', nextMoves: [{ action: 'ISSUE_PACKET', role: 'GPT_ARCHITECT' }],
      run: { runId: 'run-x', state: 'PACKET_READY', terminal: status === 'TERMINAL', admission: 'ROOT' } }) });
    assert.ok(html.includes(EXECUTION_LABELS[status]), status);
    const buttons = [...html.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
    assert.deepEqual(buttons.map((b) => /data-act="exec-refresh"/.test(b)), [true], `${status}: only the read-only refresh`);
    assert.doesNotMatch(html, /執行此任務|開始執行|強制|繼續執行|恢復執行|授權此|批准|核准此|force|bypass|resume|start/i, status);
    // The one disclaimer that names activity says it is not happening.
    assert.doesNotMatch(html.replace('這不代表 AI 此刻正在運作。', ''), /正在(執行|處理|運作)|AI 正在|Claude|Codex|\d+\s*%|進度/,
      `${status}: no fabricated activity, agent or progress`);
    assert.match(html, /未評估：這裡沒有載入即時呼叫設定，不會宣稱可以執行/, `${status}: model eligibility is never claimed`);
    assert.match(html, /唯讀狀態，不是執行授權/);
  }
  assert.match(executionStatusHTML({ state: 'ready', view: statusView('TERMINAL', { run: { runId: 'r', state: 'CLOSED', terminal: true, admission: 'ROOT' } }) }),
    /流程結束不等於成果已交付或已驗收/, 'lifecycle completion is not deliverable completion');
  assert.match(executionStatusHTML({ state: 'ready', view: statusView('IN_PROGRESS') }), /這不代表 AI 此刻正在運作/);
});
await check('WE1-R0 UI: provenance blockers show bounded reasons and the recovery dead end, never a way past them', () => {
  assert.deepEqual(Object.keys(PROVENANCE_EXPLAIN).sort(), ['ACTIVATION_LINEAGE_FOREIGN', 'ACTIVATION_LINEAGE_MISSING', 'ACTIVATION_PACKET_MISMATCH',
    'CORRECTION_LINEAGE_FOREIGN', 'CORRECTION_LINEAGE_UNBOUND', 'PACKET_REISSUED', 'REVIEW_LINEAGE_FOREIGN']);
  for (const reason of Object.keys(PROVENANCE_EXPLAIN)) {
    const html = executionStatusHTML({ state: 'ready', view: statusView('BLOCKED_PROVENANCE', { reason, attention: 'ARCHITECT' }) });
    assert.ok(html.includes(PROVENANCE_EXPLAIN[reason]) && html.includes(`<code>${reason}</code>`), reason);
    assert.match(html, /這不是要自動修復的錯誤。要繼續，需要 Architect 另行決定一個能證明來源的恢復方式；這裡不提供強制繼續。/);
  }
  // Bounded and escaped: whatever the server says is text, never markup.
  const hostile = executionStatusHTML({ state: 'ready', view: statusView('GOVERNANCE_CONFLICT', { reason: '<img src=x onerror=alert(1)>',
    nextMoves: [{ action: '<b>x</b>', role: '<i>' }], unresolvedAuthority: [{ kind: 'AUTHORIZATION', authorityId: '<x>', resolution: 'NOT_ARCHIVED' }] }) });
  assert.doesNotMatch(hostile, /<img|<b>|<i>|<x>/);
  // Archived direct authority and operational provenance are told apart.
  const both = executionStatusHTML({ state: 'ready', view: statusView('IN_PROGRESS', { directAuthority: [{ recordClass: 'DIRECT_AUTHORITY',
    kind: 'IMPLEMENTATION_PACKET', authorityId: 'packet-1', version: 1 }], operationalProvenance: { recordClass: 'OPERATIONAL_RECORD', activationBound: true } }) });
  assert.match(both, /已封存的正式授權<\/dt><dd>正式工作文件 packet-1 第 1 版/);
  assert.match(both, /營運紀錄（不是授權）<\/dt><dd>有正式啟動綁定/);
});
await check('WE1-R0 UI: useful when disabled, unavailable or in demo; the stage keeps the queue wording until execution is recorded', async () => {
  assert.match(executionStatusHTML({ state: 'disabled' }), /沒有啟用執行狀態檢視。工作清單照常可用。/);
  assert.match(executionStatusHTML({ state: 'demo' }), /示範模式不讀取正式執行狀態/);
  assert.match(executionStatusHTML({ state: 'error', message: '<b>down</b>' }), /目前無法讀取執行狀態：&lt;b&gt;down&lt;\/b&gt;/);
  assert.match(executionStatusHTML(undefined), /讀取中…/);
  for (const status of NOT_STARTED) assert.equal(executionNow({ state: 'ready', view: statusView(status) }), '排隊中 · 尚未開始執行', status);
  assert.equal(executionNow({ state: 'ready', view: statusView('IN_PROGRESS') }), '工作已有執行紀錄');
  assert.equal(executionNow({ state: 'disabled' }), '排隊中 · 尚未開始執行');
  assert.equal(executionNow({ state: 'ready', view: statusView('MADE_UP') }), '排隊中 · 尚未開始執行', 'an unknown status is never shown as one');
  // Demo answers locally, labelled, and never reaches the server.
  const demo = createDemoSource();
  const [first] = (await demo.projects()).projects;
  const queue = await demo.queue(first.projectId);
  if (queue.goals[0]) assert.deepEqual(await demo.executionStatus(first.projectId, queue.goals[0].goalId), { provenance: 'DEMO_SAMPLE', demo: true });
  // LIVE asks with GET and no body.
  const requested = [];
  const live = createLiveSource({ fetchImpl: async (...args) => { requested.push(args); return { ok: true, json: async () => statusView('RUN_IDLE') }; },
    EventSourceImpl: class {} });
  assert.equal((await live.executionStatus('cand', 'goal-1')).status, 'RUN_IDLE');
  assert.deepEqual([requested[0][0], requested[0][1].method, requested[0][1].body], ['/api/v0/projects/cand/goals/goal-1/execution', 'GET', undefined]);
  const app = read('app.js');
  assert.match(app, /error\.status === 503 && error\.code === 'EXECUTION_STATUS_UNAVAILABLE' \? \{ state: 'disabled' \}/);
  assert.doesNotMatch(app, /setInterval\([^)]*loadExecution|setTimeout\([^)]*loadExecution/, 'never polled');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
