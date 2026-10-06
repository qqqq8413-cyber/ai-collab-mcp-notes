import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorkspaceConfig } from './dist/workspace/config.js';
import { API_ROUTES, HOST, startWorkspaceServer } from './dist/workspace/server.js';
import { createDemoSource } from './workspace-ui/demo.js';
import { createLiveSource } from './workspace-ui/live.js';
import { EMPTY_ROOM, EVENT_TYPES, NEEDS_EMPTY, collaborationRoom, decisionHTML, discussionHTML, eventHTML, evidenceHTML, exchangesOf, needsHTML,
  parseCollaborationEvents, participantsOf, roomHTML, summarizeCollaboration } from './workspace-ui/collaboration.js';

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
  assert.deepEqual(imports.sort(), ['./collaboration.js', './demo.js', './live.js']);
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
  assert.ok(html.includes(EMPTY_ROOM) && html.includes(NEEDS_EMPTY), 'LIVE shows both areas empty');
  assert.doesNotMatch(html, /示範資料|AI 協作摘要|class="ev /, 'no demo label, no summary, no event');
  assert.equal(API_ROUTES.length, 6, 'no collaboration API route was added');
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
  assert.match(html, /<dt>參與的 AI<\/dt><dd><span class="cn num">2<\/span><span class="cs-who">Codex（Reviewer）、Claude（Implementer）<\/span>/);
  assert.match(html, /<div class="cs-i open"><dt>尚未解決的分歧<\/dt><dd><span class="cn num">2<\/span>/);
  assert.match(html, /<div class="cs-i need"><dt>需要你決定<\/dt><dd><span class="cn num">1<\/span>/);
  assert.match(html, /<div class="cs-i"><dt>已記錄的共識<\/dt><dd><span class="cn num">3<\/span>/);
  assert.match(html, /<h3 class="lbl">已記錄的共識<\/h3>[\s\S]*不修改 database schema。[\s\S]*改在 authorization stage 拒絕。/);
  assert.ok(html.indexOf('AI 協作摘要') < html.indexOf('id="disc-h"') && html.indexOf('id="disc-h"') < html.indexOf('id="needs-h"'), 'summary, then AI 討論, then 需要你');
});

await check('WS-P1 event rendering: every type has its own mark and word; text is escaped; not a chat or a log', () => {
  const words = { PROPOSAL: '提案', QUESTION: '提問', CHALLENGE: '質疑', RESPONSE: '回應', HANDOFF: '交接', EVIDENCE: '證據', AGREEMENT: '同意', ESCALATION: '需要你', SYSTEM: '系統' };
  for (const type of EVENT_TYPES) {
    const [event] = parseCollaborationEvents('p', [ev({ type })]).events;
    const html = eventHTML(event);
    assert.match(html, new RegExp(`data-type="${type}"`));
    assert.match(html, new RegExp(`<span class="ev-t">${words[type]}</span>`), type);
    if (type !== 'SYSTEM') assert.match(html, new RegExp(`class="ev t-${type.toLowerCase()}"`));
  }
  const [hostile] = parseCollaborationEvents('p', [ev({ actor: '<img src=x onerror=alert(1)>', body: '<script>x()</script>\n第二行' })]).events;
  const html = eventHTML(hostile);
  assert.doesNotMatch(html, /<script>|<img/);
  assert.match(html, /&lt;script&gt;x\(\)&lt;\/script&gt;<br>第二行/);
  assert.match(html, /<b class="ev-a">&lt;img src=x onerror=alert\(1\)&gt;<\/b><span class="ev-m">Implementer · <time/);
  assert.doesNotMatch(roomHTML(collaborationRoom('p', { events: [ev()] })), /class="bubble|class="av|<pre|<textarea|<input|<form/, 'no chat bubbles, avatars, raw logs or input in the room');
  const css = read('styles.css');
  for (const type of ['proposal', 'question', 'challenge', 'response', 'handoff', 'evidence', 'agreement', 'escalation']) assert.match(css, new RegExp(`\\.t-${type} \\.ev-n\\{`), `${type} has its own node`);
  assert.match(css, /\.t-escalation \.ev-n\{[^}]*var\(--gold\)/, 'gold marks only the Human\'s escalation');
  assert.doesNotMatch(css.replace(/\.t-escalation[^{]*\{[^}]*\}|\.nr-i[^{]*\{[^}]*\}/g, '').match(/\.(t-|ev)[^{]*\{[^}]*\}/g)?.join('') ?? '', /--gold|--human/, 'no other event uses the Human\'s gold');
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
  assert.match(need, /<h2 class="nr-h" id="needs-h" tabindex="-1">需要你 <span class="num">1<\/span><\/h2>/);
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
  assert.doesNotMatch(empty, /class="ev|AI 協作摘要/, 'no placeholder messages');
  const stage = slice('function stageHTML', 'function homeView');
  assert.match(stage, /<dt>Chief 現在<\/dt><dd>\$\{first \? '排隊中 · 尚未開始執行' : '沒有工作'\}<\/dd>/, 'the canonical queued wording');
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
  assert.match(roomHTML(r), /<p class="demo-tag" role="note"><b>示範資料<\/b><span>這些不是真的 AI 協作紀錄/);
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
  for (const rule of [/\.ev\{[^}]*minmax\(0,1fr\)[^}]*min-width:0/, /\.ev-b\{min-width:0/, /\.ev-x\{[^}]*overflow-wrap:anywhere/, /\.evd dd\{[^}]*overflow-wrap:anywhere/,
    /\.evd code\{[^}]*overflow-wrap:anywhere/, /\.mt\{[^}]*max-width:100%;overflow-x:auto/, /\.journal\{[^}]*max-width:760px/, /\.hn-x\{[^}]*overflow-wrap:anywhere/,
    /\.bul li\{[^}]*overflow-wrap:anywhere/, /\.nr-q\{[^}]*overflow-wrap:anywhere/, /\.who li\{[^}]*max-width:100%/, /\.cs-who\{[^}]*overflow-wrap:anywhere/]) assert.match(css, rule);
  assert.match(css, /@media \(max-width:759px\)\{[\s\S]*\.dock\{max-width:none/, 'the phone composer spans the screen');
  assert.doesNotMatch(css, /\.view\.chief\[data-pane|\.mt button/, 'the old two-pane toggle is gone');
});

// ---------- WS-P2: 協作室 product refinement
const hrefs = { discussion: '#/p/p/collaboration', needs: '#/p/p/collaboration/needs' };
const record = (extra = []) => parseCollaborationEvents('p', [
  ev({ id: 's0', type: 'SYSTEM', actor: '系統', role: undefined, body: '開始協作。', timestamp: '2026-10-06T04:40:00.000Z' }),
  ev({ id: 'p1', type: 'PROPOSAL', actor: 'Gemini', role: 'Planner', body: '先改 middleware。', timestamp: '2026-10-06T04:41:00.000Z' }),
  ev({ id: 'q1', type: 'QUESTION', actor: 'Tool-X', role: 'Checker', body: '要保留舊行為嗎？', timestamp: '2026-10-06T04:42:00.000Z' }),
  ev({ id: 'a1', type: 'AGREEMENT', actor: 'Tool-X', role: 'Checker', body: '保留舊行為。', timestamp: '2026-10-06T04:43:00.000Z' }),
  ev({ id: 'c1', type: 'CHALLENGE', actor: 'Tool-X', role: 'Checker', body: '過期 token 被提前拒絕。', timestamp: '2026-10-06T04:44:00.000Z',
    evidence: [{ kind: 'FILE', path: 'src/auth.ts', lines: '84–112' }] }),
  ev({ id: 'r1', type: 'RESPONSE', actor: 'Gemini', role: 'Planner', body: '改在授權階段拒絕。', timestamp: '2026-10-06T04:45:00.000Z' }),
  ev({ id: 'e1', type: 'EVIDENCE', actor: 'Tool-X', role: 'Checker', body: '重新驗證。', timestamp: '2026-10-06T04:46:00.000Z', evidence: [{ kind: 'TESTS', passed: 18, failed: 0 }] }),
  ev({ id: 'a2', type: 'AGREEMENT', actor: 'Tool-X', role: 'Checker', body: '同意這個修正。', timestamp: '2026-10-06T04:47:00.000Z' }),
  ev({ id: 'h1', type: 'HANDOFF', actor: 'Gemini', role: 'Planner', goalId: 'g2', body: '交給下一個工作。', timestamp: '2026-10-06T04:48:00.000Z' }),
  ev({ id: 'c2', type: 'CHALLENGE', actor: 'Tool-X', role: 'Checker', goalId: 'g2', body: '還有一個問題。', timestamp: '2026-10-06T04:49:00.000Z' }),
  ev({ id: 'x1', type: 'ESCALATION', actor: 'Tool-X', role: 'Checker', goalId: 'g2', body: '要不要改 public API？', timestamp: '2026-10-06T04:50:00.000Z' }),
  ...extra,
]).events;

await check('WS-P2 two areas: AI 討論 and 需要你 side by side when the room is wide, one at a time behind [ 討論 ] [ 需要你 ] when narrow', () => {
  const room = collaborationRoom('p', { events: record() });
  const html = roomHTML(room, { area: 'discussion', hrefs });
  assert.match(html, /<div class="rg" data-area="discussion">\s*<section class="disc" aria-labelledby="disc-h">[\s\S]*<aside class="nrail has-need" aria-labelledby="needs-h">/);
  assert.match(html, /<nav class="rtabs" aria-label="協作室的區塊"><div class="mt"><a href="#\/p\/p\/collaboration" data-act="room-tab" data-v="discussion" aria-current="page">討論 <span class="tn num">11<\/span><\/a><a href="#\/p\/p\/collaboration\/needs" data-act="room-tab" data-v="needs" >需要你 <span class="tn num">1<\/span><span class="tneed"/);
  assert.match(roomHTML(room, { area: 'needs', hrefs }), /data-v="needs" aria-current="page"[\s\S]*<div class="rg" data-area="needs">/);
  const shell = [...read('index.html').matchAll(/class="([\w-]+)/g)].map((m) => m[1]);
  const used = new Set([...html.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)));
  assert.deepEqual(shell.filter((name) => used.has(name)), [], 'the room reuses no class of the page shell (a .rail once collided)');
  const css = read('styles.css');
  assert.match(css, /\.room-body\{[^}]*container:room\/inline-size/);
  assert.match(css, /\.rg\[data-area="discussion"\] \.nrail,\.rg\[data-area="needs"\] \.disc\{display:none\}/, 'narrow: one area at a time, never two squeezed columns');
  const wide = css.slice(css.indexOf('@container room (min-width:760px){'), css.indexOf('}\n.disc,.nrail'));
  assert.match(wide, /\.rtabs\{display:none\}/);
  assert.match(wide, /\.rg\{grid-template-columns:minmax\(0,1fr\) minmax\(240px,300px\)/);
  assert.match(wide, /\.rg\[data-area\] \.disc,\.rg\[data-area\] \.nrail\{display:block\}/);
  assert.match(wide, /\.nrail\{position:sticky;top:20px\}/, 'the rail stays in view beside a long discussion');
});

await check('WS-P2 areas have their own addresses; 需要你 links land on the 需要你 area', () => {
  const { parseRoute } = resolver;
  assert.deepEqual(parseRoute('#/p/cand/collaboration/needs'), { view: 'project', projectId: 'cand', pane: 'collaboration', area: 'needs', root: false });
  assert.deepEqual(parseRoute('#/p/cand/collaboration/discussion'), { view: 'project', projectId: 'cand', pane: 'collaboration', area: 'discussion', root: false });
  for (const root of ['#/p/cand/now/needs', '#/p/cand/collaboration/decide', '#/p/cand/collaboration/needs/x']) assert.equal(parseRoute(root).root, true, `${root} is the root`);
  const app = read('app.js');
  assert.match(app, /case 'room-tab': go\('project', S\.pid, \{ pane: 'collaboration', area: v \}\); document\.getElementById\(v === 'needs' \? 'needs-h' : 'disc-h'\)\?\.focus\(\); break;/);
  assert.match(slice('function stageHTML', 'function homeView'), /toRoom\('查看協作室', 'btn gold', 'needs'\)/);
  assert.match(slice('function homeView', 'function projectView'), /paneHref\(projectId, 'collaboration', 'needs'\)/);
  assert.match(slice('function projectView', 'function projectsView'), /roomHTML\(r, \{ demo: demoRoom\(\), area: S\.area, hrefs: \{ discussion: paneHref\(p\.projectId, 'collaboration'\), needs: paneHref\(p\.projectId, 'collaboration', 'needs'\) \} \}\)/);
});

await check('WS-P2 需要你 keeps its place when empty, with a calm empty state', () => {
  const quiet = collaborationRoom('p', { events: record().filter((e) => e.type !== 'ESCALATION') });
  const html = roomHTML(quiet, { hrefs });
  assert.match(html, /<aside class="nrail" aria-labelledby="needs-h"><h2 class="nr-h" id="needs-h" tabindex="-1">需要你 <span class="num">0<\/span><\/h2>/);
  assert.ok(html.includes(NEEDS_EMPTY));
  assert.match(NEEDS_EMPTY, /目前沒有需要你決定的事。[\s\S]*AI 之間無法自行決定的事，會出現在這裡。/);
  assert.doesNotMatch(html, /class="tneed"/, 'no attention dot without an escalation');
});

await check('WS-P2 exchanges: an opener leads, its replies follow, and an outcome appears only when the record shows one', () => {
  const events = record();
  const items = exchangesOf(events, summarizeCollaboration('p', events));
  assert.deepEqual(items.map((i) => i.kind === 'system' ? 'system' : `${i.opener.id}|${i.replies.map((r) => r.id).join(',')}|${i.outcome?.kind ?? 'none'}`),
    ['system', 'p1|q1,a1|agreed', 'c1|r1,e1,a2|agreed', 'h1||none', 'c2||open', 'x1||human'], 'a change of goal (h1) and each opener start a new exchange');
  const [, proposal, challenge] = items;
  assert.equal(proposal.outcome.by.id, 'a1', 'someone other than the proposer agreed inside it');
  assert.equal(challenge.outcome.by.id, 'a2', 'the challenger agreed later in the same goal');
  const self = parseCollaborationEvents('p', [ev({ id: 'p9', type: 'PROPOSAL' }), ev({ id: 'a9', type: 'AGREEMENT', timestamp: '2026-10-06T05:00:00.000Z' })]).events;
  assert.equal(exchangesOf(self, summarizeCollaboration('p', self))[0].outcome, null, 'agreeing with yourself is not an outcome');
  const html = discussionHTML(collaborationRoom('p', { events }), { hrefs });
  assert.equal((html.match(/class="ev [^"]* lead"/g) ?? []).length, 5, 'one lead per exchange');
  assert.match(html, /<p class="xg-out o-agreed"><span class="xg-k">已同意<\/span><span>Tool-X · Checker · <time/);
  assert.match(html, /<p class="xg-out o-open"><span class="xg-k">仍有分歧<\/span>/);
  assert.match(html, /<p class="xg-out o-human"><span class="xg-k">需要你決定<\/span><a href="#\/p\/p\/collaboration\/needs" data-act="room-tab" data-v="needs">在「需要你」查看<\/a><\/p>/);
  assert.match(html, /<li class="xg-sys" data-type="SYSTEM"><span class="ev-sl"><span class="ev-t">系統<\/span>開始協作。/);
});

await check('WS-P2 identity is display metadata: any actor, role and count from the record, never a live state', () => {
  const people = participantsOf(record());
  assert.deepEqual(people.map((p) => [p.actor, p.role, p.count, p.last]), [['Gemini', 'Planner', 3, '2026-10-06T04:48:00.000Z'], ['Tool-X', 'Checker', 7, '2026-10-06T04:50:00.000Z']]);
  const html = discussionHTML(collaborationRoom('p', { events: record() }), { hrefs });
  assert.match(html, /<ul class="who" aria-label="參與的 AI"><li><b>Gemini<\/b><span class="who-r">Planner<\/span><span class="who-c"><span class="num">3<\/span> 則 · 最後 <time/);
  assert.doesNotMatch(html, /正在|working|online|上線|typing|輸入中/i, 'no live presence');
  const codeOnly = (file) => read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
  for (const file of ['collaboration.js', 'app.js']) assert.doesNotMatch(codeOnly(file), /Claude|Codex/, `${file} names no particular agent`);
});

await check('WS-P2 evidence hangs off the event that attached it, ruled in that event\'s colour', () => {
  const [challenge] = parseCollaborationEvents('p', [ev({ type: 'CHALLENGE', evidence: [{ kind: 'FILE', path: 'src/auth.ts' }] })]).events;
  assert.match(eventHTML(challenge), /<li class="ev t-challenge"[\s\S]*<article class="ev-b"[\s\S]*<p class="ev-x">[^<]*<\/p><dl class="evd" aria-label="證據">[\s\S]*<\/dl><\/article><\/li>$/);
  const css = read('styles.css');
  assert.match(css, /\.evd\{[^}]*border-left:2px solid var\(--tone,var\(--ctl\)\)/);
  assert.match(css, /\.t-challenge\{--tone:var\(--ev-challenge\)\}/);
  assert.match(css, /\.t-agreement\{--tone:var\(--ev-agree\)\}/);
  assert.match(css, /\.evd::before\{content:"附上的證據"/);
});

await check('WS-P2 no per-agent control: 協作室 has no composer, input or "說給" anywhere', () => {
  const html = roomHTML(collaborationRoom('p', { events: record() }), { hrefs });
  assert.doesNotMatch(html, /<textarea|<input|<form|<select|說給|send to|contenteditable/i);
  const views = slice('function projectView', 'function projectsView');
  const branch = views.slice(views.indexOf("} else if (S.pane === 'collaboration')"), views.indexOf('} else {'));
  assert.doesNotMatch(branch, /composer|textarea|說給/);
  assert.doesNotMatch(read('app.js') + read('collaboration.js'), /說給/);
});

await check('WS-P2 chain-of-thought boundary: the rule is stated as a source obligation, not claimed as enforced', () => {
  const module = read('collaboration.js');
  assert.match(module, /CollaborationEventV1 represents only collaboration artifacts a participant\n\/\/ explicitly emitted: an agent message, a review comment, a hand-off, evidence, an operational event, or a summary of\n\/\/ the rationale for a decision\./);
  assert.match(module, /A future execution source MUST NOT put\n\/\/ hidden or private model reasoning into `body`/);
  assert.match(module, /it cannot tell what text a source puts into `body`/, 'the code says what it cannot prove');
  assert.doesNotMatch(module, /no source can put chain-of-thought|cannot smuggle/, 'the WS-P1 overclaim is gone');
  const app = read('app.js');
  assert.match(app, /參與工作的 AI 明確送出的提案、審查意見、交接、證據與決策理由摘要。這是工作紀錄，不是 AI 的思考過程。/);
  assert.doesNotMatch(app, /不包含 AI 的內部推理/, 'the room no longer promises what the projection cannot check');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
