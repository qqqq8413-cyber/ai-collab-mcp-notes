// Chief Workspace (WS-L1): the real local shell. LIVE mode shows only what the local
// Workspace server holds: configured projects and their non-authoritative goal queues.
// Nothing in this page starts execution; the server has no route that could.
// Demo mode is opt-in (?demo=1), labelled, in-memory, and never mixed into LIVE state.
// WS-P1: a project has three views, 此刻 / 往來 / 協作室, each with its own address.

import { collaborationRoom, decisionHTML, roomHTML } from './collaboration.js';

const DEMO = new URLSearchParams(location.search).get('demo') === '1';
const source = DEMO ? (await import('./demo.js')).createDemoSource() : (await import('./live.js')).createLiveSource();

// ---------- helpers
const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ICON = {
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  folder: '<path d="M3 6.5h6l2 2h10V19H3z"/>',
  pulse: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
  scope: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.3-4.3M8.5 11h5M11 8.5v5"/>',
  chev: '<path d="M6 9l6 6 6-6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  trash: '<path d="M4 7h16M10 7V4h4v3M6 7l1 13h10l1-13"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
};
const ic = (name, size = 16) => `<svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;
const time = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
};
const announce = (text) => { $('#sr').textContent = ''; setTimeout(() => { $('#sr').textContent = text; }, 30); };
let toastTimer;
const toast = (text) => {
  clearTimeout(toastTimer);
  $('#toast').innerHTML = `<div class="toast" role="status">${esc(text)}</div>`;
  toastTimer = setTimeout(() => { $('#toast').innerHTML = ''; }, 3600);
};

// ---------- entry resolver (pure: no DOM, no storage, no network; tested in test-workspace-ui.mjs)
// One signal per configured project, in configured order. There is no execution, so working is always false and
// queued goals never count as working. Human-required comes only from `attention` (projectId → the time of that
// project's oldest open escalation in its collaboration room); LIVE has no collaboration source in WS-P1, so in LIVE
// nothing is ever Human-required. Only a future, Architect-approved read model may supply more.
function signalsOf(projects, attention = {}) {
  return projects.map((item, order) => {
    const since = Object.hasOwn(attention, item.projectId) && typeof attention[item.projectId] === 'string' ? attention[item.projectId] : null;
    return { projectId: item.projectId, order, queued: item.queued ?? 0, working: false, humanRequired: since !== null, humanRequiredSince: since };
  });
}
function knownProject(signals, projectId) {
  return signals.some((signal) => signal.projectId === projectId) ? projectId : null;
}
// The oldest outstanding Human request first (by its own request time); ties and missing times fall back to configured order.
function byOldestRequest(a, b) {
  const at = (signal) => { const t = Date.parse(signal.humanRequiredSince ?? ''); return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t; };
  return (at(a) - at(b)) || (a.order - b.order);
}
// Root entry only: a Human-required item opens the project with the oldest outstanding request; otherwise Home.
// Working never bypasses Home. The project signal only chooses where to land and what to mark: the Human Decision
// itself (its question, options and content) will come from the approved governed read model into the stage's focal slot.
function resolveEntry(signals) {
  const attention = signals.filter((signal) => signal.humanRequired).sort(byOldestRequest).map((signal) => signal.projectId);
  if (attention.length) return { kind: 'project', projectId: attention[0], focal: 'human-required', attention };
  return { kind: 'home', attention };
}
// Routes: '', '#', '#/' and anything unknown are the root. Explicit destinations: '#/projects', '#/activity',
// '#/advanced', and a project view '#/p/<id>/now' (此刻), '#/p/<id>/conversation' (往來) or
// '#/p/<id>/collaboration' (協作室); '#/p/<id>' alone is 此刻.
const ROUTES = ['projects', 'activity', 'advanced'];
const PANES = ['now', 'conversation', 'collaboration'];
function parseRoute(hash) {
  const m = /^#\/p\/([^/]+)(?:\/([a-z]+))?$/.exec(hash);
  if (m && (m[2] === undefined || PANES.includes(m[2]))) {
    try { return { view: 'project', projectId: decodeURIComponent(m[1]), pane: m[2] ?? 'now', root: false }; } catch { return { view: 'home', root: true }; }
  }
  const v = /^#\/(\w+)$/.exec(hash)?.[1];
  if (ROUTES.includes(v)) return { view: v, root: false };
  return { view: 'home', root: true };
}
// Boot decision: only the root runs the attention resolver; an explicit destination is kept as it is.
function entryFor(route, signals) {
  if (!route.root) return { view: route.view, projectId: route.projectId, ...(route.pane ? { pane: route.pane } : {}) };
  const entry = resolveEntry(signals);
  return entry.kind === 'project' ? { view: 'project', projectId: entry.projectId, focal: entry.focal } : { view: 'home' };
}
// Home lists only relevant projects: working first, then those with queued goals; idle projects stay in the spines.
function homeProjects(signals, lastViewed) {
  const group = (list) => {
    const sorted = [...list].sort((a, b) => a.order - b.order);
    const last = sorted.findIndex((signal) => signal.projectId === lastViewed);
    return last > 0 ? [sorted[last], ...sorted.slice(0, last), ...sorted.slice(last + 1)] : sorted;
  };
  return [...group(signals.filter((signal) => signal.working)), ...group(signals.filter((signal) => !signal.working && signal.queued > 0))];
}
// The Home composer's default target: a working project (last viewed if it is one), else last viewed, else the first configured.
function defaultTarget(signals, lastViewed) {
  const last = knownProject(signals, lastViewed);
  const working = signals.filter((signal) => signal.working).sort((a, b) => a.order - b.order);
  if (working.length) return working.some((signal) => signal.projectId === last) ? last : working[0].projectId;
  return last ?? [...signals].sort((a, b) => a.order - b.order)[0]?.projectId ?? null;
}
// The target is recomputed only on an actual entry into Home; while the Human stays on Home their choice is kept
// (unless the project it names no longer exists).
function homeTarget({ entering, current }, signals, lastViewed) {
  return entering || !knownProject(signals, current) ? defaultTarget(signals, lastViewed) : current;
}
// 最近開啟: the projects the Human opened most recently (a local UI preference), newest first, known ones only, at most four.
function recentProjects(signals, recent) {
  const known = new Set(signals.map((signal) => signal.projectId));
  return [...new Set((Array.isArray(recent) ? recent : []).filter((projectId) => typeof projectId === 'string' && known.has(projectId)))].slice(0, 4);
}
// Home's sections: 需要你 (oldest request first), 目前的工作 (working; none exists in WS-P1), 排隊中 (queued and not
// working) and 最近開啟. Home only shows them; it never navigates because of them.
function homeSections(signals, lastViewed, recent) {
  return {
    attention: signals.filter((signal) => signal.humanRequired).sort(byOldestRequest).map((signal) => signal.projectId),
    current: homeProjects(signals.filter((signal) => signal.working), lastViewed).map((signal) => signal.projectId),
    queued: homeProjects(signals.filter((signal) => !signal.working), lastViewed).map((signal) => signal.projectId),
    recent: recentProjects(signals, recent),
  };
}
// ---------- end entry resolver

// ---------- state
// view: home (belongs to no project) | project (one project's 此刻 / 往來 / 協作室, by pane) | projects | activity | advanced
const S = {
  view: 'home', pid: null, target: null, homeAck: null, projects: [], queues: {}, collab: {}, conn: 'connecting', pop: null, sheet: null,
  decision: null, confirm: null, sending: false, loadError: null, pane: 'now',
};
const LAST = `chief.workspace.${source.mode}.project`; // last viewed project: a local, non-authoritative UI preference
const RECENT = `chief.workspace.${source.mode}.recent`; // recently opened projects, newest first: the same kind of preference
const readLastViewed = () => { try { return localStorage.getItem(LAST); } catch { return null; } };
const readRecent = () => { try { const list = JSON.parse(localStorage.getItem(RECENT) ?? '[]'); return Array.isArray(list) ? list : []; } catch { return []; } };
const writeLastViewed = (projectId) => {
  try {
    localStorage.setItem(LAST, projectId);
    localStorage.setItem(RECENT, JSON.stringify([projectId, ...readRecent().filter((item) => item !== projectId)].slice(0, 8)));
  } catch { /* optional */ }
};
const byId = (projectId) => S.projects.find((item) => item.projectId === projectId);
const project = () => S.projects.find((item) => item.projectId === S.pid);
const queue = () => S.queues[S.pid] ?? { revision: 0, goals: [], history: [] };
const room = (projectId = S.pid) => S.collab[projectId] ?? collaborationRoom(projectId, null);
const demoRoom = (projectId = S.pid) => DEMO || room(projectId).provenance === 'DEMO_SAMPLE';
// Project → the time of its oldest open escalation, from the validated collaboration rooms only.
const attentionOf = () => Object.fromEntries(Object.values(S.collab)
  .filter((item) => item.summary.needsHuman.length).map((item) => [item.projectId, item.summary.needsHuman[0].timestamp]));
const signals = () => signalsOf(S.projects, attentionOf());
const paneHref = (projectId, pane) => `#/p/${encodeURIComponent(projectId)}/${pane}`;

// ---------- data
async function loadProjects() {
  const data = await source.projects();
  S.projects = data.projects;
  const remembered = readLastViewed();
  if (!S.projects.some((item) => item.projectId === S.pid)) {
    S.pid = S.projects.some((item) => item.projectId === remembered) ? remembered : S.projects[0]?.projectId ?? null;
  }
  S.target = homeTarget({ entering: false, current: S.target }, signalsOf(S.projects), remembered);
}
async function loadQueue(projectId) {
  const data = await source.queue(projectId);
  S.queues[projectId] = { revision: data.revision, goals: data.goals, history: data.history };
  const item = S.projects.find((p) => p.projectId === projectId);
  if (item) item.queued = data.goals.length;
}
// 協作室: whatever the source returns goes through the CollaborationEventV1 projection; LIVE returns no events.
async function loadRoom(projectId) {
  S.collab[projectId] = collaborationRoom(projectId, await source.collaboration(projectId));
}
async function reloadAll() {
  try {
    await loadProjects();
    await Promise.all(S.projects.map((item) => Promise.all([loadQueue(item.projectId), loadRoom(item.projectId)])));
    S.loadError = null;
  } catch (error) {
    S.loadError = error.message;
  }
  render();
}
// A change is applied only when it is the next revision; anything else reloads that queue.
function applyEvent(name, data) {
  if (name === 'hello') { void reloadAll(); return; }
  const q = S.queues[data.projectId];
  if (!q) return;
  if (data.revision <= q.revision) return; // already applied (our own request, or a duplicate)
  if (data.revision !== q.revision + 1) { void loadQueue(data.projectId).then(render); return; }
  if (name === 'goal.created') {
    q.goals.push(data.goal);
    q.history.push({ sequence: data.revision, at: data.at, kind: 'GOAL_ADDED', goal: { goalId: data.goal.goalId, text: data.goal.text, createdAt: data.goal.createdAt } });
  } else if (name === 'queue.reordered') {
    const byId = new Map(q.goals.map((goal) => [goal.goalId, goal]));
    q.goals = data.order.map((id) => byId.get(id)).filter(Boolean);
    q.history.push({ sequence: data.revision, at: data.at, kind: 'QUEUE_REORDERED', order: data.order });
  } else if (name === 'goal.removed') {
    q.goals = q.goals.filter((goal) => goal.goalId !== data.goalId);
    q.history.push({ sequence: data.revision, at: data.at, kind: 'GOAL_REMOVED', goalId: data.goalId });
  }
  q.revision = data.revision;
  const item = S.projects.find((p) => p.projectId === data.projectId);
  if (item) item.queued = q.goals.length;
  render();
}

// ---------- pieces
// Structure (WS-VIS1B, WS-P1): 此刻 (the stage) answers what was asked, what Chief is doing, whether you are needed, how
// far it got and what comes next, around one focal object; 往來 (the correspondence) keeps the full Human ↔ Chief record;
// 協作室 shows what the AIs observably said and did to each other. The only true facts are queued goals, their order,
// that nothing has started, and (demo only) a labelled collaboration fixture: the views show exactly that.
const connChip = () => {
  if (DEMO) return '';
  const label = { connecting: '正在連線', open: '即時更新', retrying: '重新連線中' }[S.conn] ?? '連線中';
  return `<span class="wl-conn" role="status" title="與本機 Workspace 伺服器的連線"><span class="dot ${S.conn === 'open' ? 'open' : S.conn === 'retrying' ? 'retrying' : ''}"></span><span class="lbltext">${label}</span></span>`;
};
const NOTE = `<p class="wl-note">${ic('info', 15)}<span>目前這個版本只會保存與排列工作，還不會自動啟動 AI 執行。</span></p>`;
const VIEWS = [['home', 'chat', 'Chief'], ['projects', 'folder', '專案'], ['activity', 'pulse', '活動'], ['advanced', 'scope', '進階']];

function topHTML() {
  const p = project();
  return `<a class="brand" href="${DEMO ? '?demo=1#/' : '#/'}" data-act="nav" data-v="home" aria-label="CHIEF，回到首頁"><span class="mark" aria-hidden="true"></span><span class="word" aria-hidden="true">CHIEF</span></a>
    <nav class="tnav" aria-label="主要選單">${VIEWS.map(([v, , label]) => `<button class="tn-i" data-act="nav" data-v="${v}" ${S.view === v ? 'aria-current="page"' : ''}>${label}</button>`).join('')}</nav>
    ${S.projects.length ? `<button class="tbtn" data-act="pop" data-v="proj" aria-haspopup="true" aria-expanded="${S.pop === 'proj'}">${S.view === 'project' && p ? `<span class="sr">切換專案，目前是</span><span class="pname">${esc(p.displayName)}</span>` : '<span class="pname">選擇專案</span>'}${ic('chev', 14)}</button>` : ''}
    <span class="sp"></span>${DEMO ? '<span class="proto" title="示範模式：資料只存在這個頁面">示範資料</span>' : ''}${connChip()}<span class="avatar" aria-hidden="true">你</span>`;
}
// Projects as spines on wide layouts: the name and queue count stand in a tall tab, read in normal order by screen readers.
function railHTML() {
  const attention = new Set(signals().filter((signal) => signal.humanRequired).map((signal) => signal.projectId));
  return `<div class="spines">${S.projects.map((item) => {
    const on = S.view === 'project' && item.projectId === S.pid;
    const need = attention.has(item.projectId);
    return `<button class="spine${on ? ' on' : ''}" data-act="open" data-v="${esc(item.projectId)}" ${on ? 'aria-current="page"' : ''}>
      <span class="pulse idle${need ? ' need' : ''}" aria-hidden="true"></span><span class="sn">${esc(item.displayName)}</span><span class="sq num" aria-hidden="true">${item.queued ?? 0}</span><span class="sr">，${item.queued ?? 0} 個排隊${need ? '，需要你決定' : ''}</span></button>`;
  }).join('')}</div>`;
}
function tabsHTML() {
  return VIEWS.map(([v, icon, label]) => `<button class="nav" data-act="nav" data-v="${v}" ${S.view === v ? 'aria-current="page"' : ''}>${ic(icon, 18)}<span class="nl">${label}</span></button>`).join('');
}

// Home: the larger composer with a visible, changeable project target (a goal always belongs to exactly one project).
// Project: the docked composer adds to that project.
function composerHTML(home) {
  const p = home ? byId(S.target) : project();
  const target = home ? `<label class="c-to" for="target">交給哪個專案</label><select id="target" class="c-sel">${S.projects.map((item) => `<option value="${esc(item.projectId)}" ${item.projectId === S.target ? 'selected' : ''}>${esc(item.displayName)}</option>`).join('')}</select>` : '<span class="c-hint">Enter 送出 · Shift + Enter 換行</span>';
  return `<form class="composer" id="composer-form" autocomplete="off"><label class="sr" for="composer">交給 Chief 的目標</label>
    <textarea id="composer" rows="${home ? 3 : 1}" maxlength="2000" placeholder="${p ? (home ? '告訴 Chief 你想完成的目標…' : `告訴 Chief 你想完成的目標，會加入「${esc(p.displayName)}」的工作清單…`) : '先在設定檔加入專案'}" ${p ? '' : 'disabled'}></textarea>
    <div class="c-row">${target}<button class="send" type="submit" id="send" title="加入工作清單" ${S.sending || !p ? 'disabled' : ''}><span class="sr">加入工作清單</span>${ic('up', 18)}</button></div></form>`;
}

// 往來: one Human bubble and Chief's plain reply per goal. The goal on the stage gets a light pointer, not a second card.
function ackHTML(goal, removed, position) {
  const p = project();
  const pills = removed
    ? '<span class="wl-pill gone">已從工作清單移除</span>'
    : `<span class="wl-pill q">${ic('clock', 13)}排隊中</span><span class="wl-pill">尚未開始執行</span>${position ? `<span class="wl-pill">第 ${position} 個</span>` : ''}${position === 1 ? `<a class="wl-pill ptr" href="${paneHref(p.projectId, 'now')}" data-act="pane" data-v="now">在「此刻」</a>` : ''}`;
  return `<div class="item m-human"><div class="bubble"><span class="sr">你：</span>${esc(goal.text).replace(/\n/g, '<br>')}</div><span class="meta num">${time(goal.createdAt)}</span></div>
    <div class="item m-chief"><span class="av" aria-hidden="true"></span><div class="c-body"><div class="meta"><b>Chief</b></div>
      <div class="txt"><p>${removed ? '這個目標已經從工作清單移除。' : `已收到這個目標。我已經把它加入${esc(p?.displayName ?? '')}的工作清單。`}</p></div>
      <div class="wl-pills wl-after">${pills}</div></div></div>`;
}

// 工作順序: the ledger at the foot of the stage. Reorder and remove keep their confirmation.
function queueHTML() {
  const goals = queue().goals;
  const rows = goals.map((goal, index) => `<li data-goal="${esc(goal.goalId)}" class="${index === 0 ? 'qcur' : ''}">
      <span class="qn">${index === 0 ? '目前' : `第 ${index + 1} 個`}</span>
      <span class="qt">${esc(goal.text)}<span class="qs">排隊中 · 尚未開始執行 · ${time(goal.createdAt)} 加入</span></span>
      <span class="qa"><button class="qb" data-act="up" data-v="${esc(goal.goalId)}" ${index === 0 ? 'disabled' : ''} aria-label="往前移：${esc(goal.text)}">${ic('up', 16)}</button><button class="qb" data-act="down" data-v="${esc(goal.goalId)}" ${index === goals.length - 1 ? 'disabled' : ''} aria-label="往後移：${esc(goal.text)}">${ic('down', 16)}</button><button class="qb" data-act="ask-remove" data-v="${esc(goal.goalId)}" aria-label="移除：${esc(goal.text)}">${ic('trash', 16)}</button></span>
      ${S.confirm === goal.goalId ? `<div class="wl-confirm"><span>要把「${esc(goal.text.slice(0, 40))}${goal.text.length > 40 ? '…' : ''}」從工作清單移除嗎？它還沒開始執行，移除後不會有其他影響。</span><button class="btn danger" data-act="remove" data-v="${esc(goal.goalId)}">移除</button><button class="btn quiet" data-act="cancel-remove">取消</button></div>` : ''}
    </li>`).join('');
  return `<section class="queue" aria-labelledby="q-h"><h2 class="lbl" id="q-h">工作順序 <span class="num">${goals.length}</span></h2>
    ${goals.length ? `<ol>${rows}</ol>` : '<p class="wl-empty">目前沒有排隊的目標。在下面輸入目標，就會加入這裡。</p>'}</section>`;
}

// 此刻: the goal as the headline, Chief now / need, then exactly one focal object, then the ledger.
// The focal object is the oldest open escalation when there is one (the Human's decision comes first), else the queue
// state. There is no execution, so the state is never 正在處理, 等待 AI 驗證, 完成 or 失敗: those need execution facts
// that do not exist yet and are never inferred.
function stageHTML() {
  const p = project();
  const goals = queue().goals;
  const first = goals[0];
  const r = room();
  const needs = r.summary.needsHuman;
  const toRoom = (label, cls) => `<a class="${cls}" href="${paneHref(p.projectId, 'collaboration')}" data-act="pane" data-v="collaboration">${label}</a>`;
  const focal = needs.length
    ? `<section class="card focal need" aria-labelledby="focal-h"><header class="card-h"><span class="pulse idle need" aria-hidden="true"></span><h2 class="ch-t" id="focal-h">需要你</h2><span class="ch-s">${esc(needs[0].actor)} 在協作室提出${needs.length > 1 ? ` · 共 ${needs.length} 件` : ''}${demoRoom() ? ' · 示範資料' : ''}</span></header>
        <div class="card-b"><p class="need-x">${esc(needs[0].body).replace(/\n/g, '<br>')}</p>${toRoom('查看協作室', 'btn gold')}</div></section>`
    : first
      ? `<section class="card focal" aria-labelledby="focal-h"><header class="card-h"><span class="pulse idle" aria-hidden="true"></span><h2 class="ch-t" id="focal-h">已加入工作清單 · 排隊第 1 個</h2><span class="ch-s">尚未開始執行 · ${time(first.createdAt)} 加入</span></header>
        <div class="card-b">${NOTE}</div></section>`
      : `<section class="card focal" aria-labelledby="focal-h"><header class="card-h"><span class="pulse idle" aria-hidden="true"></span><h2 class="ch-t" id="focal-h">工作清單是空的</h2><span class="ch-s">目前沒有排隊的目標</span></header>
        <div class="card-b">${NOTE}</div></section>`;
  const records = r.events.length && !needs.length
    ? `<p class="to-room"><span>這個專案有 <span class="num">${r.events.length}</span> 則 AI 協作紀錄${demoRoom() ? '（示範資料）' : ''}</span>${toRoom(`查看協作室 ${ic('arrow', 13)}`, 'adv')}</p>` : '';
  return `<div class="work">
      <div class="sn-meta"><span class="sn-k">此刻</span><span>${esc(p.displayName)}</span><button class="adv" data-act="console">查看詳細監看 ${ic('ext', 13)}</button></div>
      <p class="lbl asked">你交辦的</p>
      <h1 class="goal" id="stage-h">${first ? esc(first.text) : '還沒有排隊的目標'}</h1>
      <dl class="now">
        <div class="nw"><dt>Chief 現在</dt><dd>${first ? '排隊中 · 尚未開始執行' : '沒有工作'}</dd></div>
        <div class="nw"><dt>需要你嗎</dt><dd>${needs.length ? toRoom(`需要，${needs.length} 件事等你決定`, 'need-a') : '不需要'}</dd></div>
      </dl>
      <div class="focus">${focal}${records}</div>
      <div class="ledger">${queueHTML()}
        <section aria-labelledby="ctx-h"><h2 class="lbl" id="ctx-h">專案</h2><dl class="ctx"><dt>專案</dt><dd>${esc(p.displayName)}</dd><dt>位置</dt><dd>${esc(p.repository)}</dd><dt>狀態</dt><dd><span class="stat"><span class="dot" aria-hidden="true"></span>尚未開始執行</span></dd></dl></section>
      </div>
    </div>`;
}

// Home belongs to no project. 需要你 first when a project has an open escalation (shown, never redirected to), then
// Chief's question, the larger composer with its project target, an acknowledgement after a hand-over (the Human
// stays here), and three calm sections: 目前的工作, 排隊中 (working first; idle projects are not listed) and 最近開啟.
function homeView() {
  if (S.loadError) return `<div class="view other"><div class="scroll"><div class="col page"><p class="wl-err">${esc(S.loadError)}</p></div></div></div>`;
  if (!S.projects.length) return `<div class="view other"><div class="scroll"><div class="col page"><header class="page-h"><h1>還沒有專案</h1><p>在 Workspace 設定檔的 projects 裡加入專案，重新啟動後就會出現在這裡。</p></header></div></div></div>`;
  const target = byId(S.target);
  const examples = [`繼續做${target?.displayName ?? ''}`, '整理目前進度，列出下一步', '檢查有沒有需要我決定的事'];
  const sections = homeSections(signals(), readLastViewed(), readRecent());
  const need = sections.attention.map((projectId) => {
    const item = byId(projectId);
    const needs = room(projectId).summary.needsHuman;
    return `<li><a class="hn" href="${paneHref(projectId, 'collaboration')}" data-act="room" data-v="${esc(projectId)}"><span class="pulse idle need" aria-hidden="true"></span>
      <span class="hn-b"><span class="hn-p">${esc(item.displayName)}${needs.length > 1 ? ` · ${needs.length} 件` : ''}${demoRoom(projectId) ? ' · 示範資料' : ''}</span><span class="hn-x">${esc(needs[0].body).replace(/\n/g, ' ')}</span></span>${ic('arrow', 16)}</a></li>`;
  }).join('');
  const row = (projectId) => {
    const item = byId(projectId);
    const goals = S.queues[projectId]?.goals ?? [];
    return `<li><button class="hp" data-act="open" data-v="${esc(projectId)}"><span class="pulse idle" aria-hidden="true"></span>
      <span class="hp-b"><span class="hp-n">${esc(item.displayName)}</span><span class="hp-g">${esc(goals[0]?.text ?? '')}</span><span class="hp-s">排隊中 · 尚未開始執行${goals.length > 1 ? ` · 共 ${goals.length} 個排隊` : ''}</span></span>${ic('arrow', 16)}</button></li>`;
  };
  const recent = sections.recent.map((projectId) => `<a class="rp" href="${paneHref(projectId, 'now')}" data-act="open" data-v="${esc(projectId)}">${esc(byId(projectId).displayName)}<span class="num">${byId(projectId).queued ?? 0}</span><span class="sr"> 個排隊</span></a>`).join('');
  const ack = S.homeAck && byId(S.homeAck);
  return `<div class="view chief idle home"><div class="scroll"><div class="col hero">
      ${need ? `<section class="h-need" aria-labelledby="hn-h"><h2 class="lbl" id="hn-h">需要你</h2><ul class="hn-l">${need}</ul></section>` : ''}
      <div class="h-who"><span class="av" aria-hidden="true"></span><span><b>Chief</b></span></div>
      <h1>今天要我幫你<em>完成</em>什麼？</h1>
      ${composerHTML(true)}
      ${ack ? `<p class="home-ack">${ic('check', 15)}<span>已加入「${esc(ack.displayName)}」的工作清單 · 排隊中 · 尚未開始執行</span><button class="adv" data-act="open" data-v="${esc(ack.projectId)}">打開「${esc(ack.displayName)}」</button></p>` : ''}
      <div class="sec"><p class="lbl">可以這樣說</p><div class="ex">${examples.map((text) => `<button class="exb" data-act="fill" data-v="${esc(text)}">${esc(text)}</button>`).join('')}</div></div>
      <div class="hsecs">
        <section class="hw" aria-labelledby="hc-h"><h2 class="lbl" id="hc-h">目前的工作</h2>${sections.current.length ? `<ol class="hlist">${sections.current.map(row).join('')}</ol>` : '<p class="wl-empty">沒有進行中的工作。</p>'}</section>
        <section class="hw" aria-labelledby="hw-h"><h2 class="lbl" id="hw-h">排隊中</h2>${sections.queued.length ? `<ol class="hlist">${sections.queued.map(row).join('')}</ol>` : '<p class="wl-empty">沒有排隊的目標。在上面輸入目標，就會加入所選專案的工作清單。</p>'}</section>
        ${recent ? `<section class="hw" aria-labelledby="hr-h"><h2 class="lbl" id="hr-h">最近開啟</h2><div class="recent">${recent}</div></section>` : ''}
      </div>
      ${NOTE}</div></div></div>`;
}

// One project: a view switch (此刻 / 往來 / 協作室, each its own address), the chosen view, and the docked composer
// under 此刻 and 往來. 協作室 has no composer: the Human talks to Chief, not into the AIs' record.
function projectView() {
  const p = project();
  if (S.loadError) return `<div class="view other"><div class="scroll"><div class="col page"><p class="wl-err">${esc(S.loadError)}</p></div></div></div>`;
  if (!p) return homeView();
  const q = queue();
  const r = room();
  const added = q.history.filter((event) => event.kind === 'GOAL_ADDED');
  const tab = (pane, label, extra = '') => `<a href="${paneHref(p.projectId, pane)}" data-act="pane" data-v="${pane}" ${S.pane === pane ? 'aria-current="page"' : ''}>${label}${extra}</a>`;
  const need = r.summary.needsHuman.length ? '<span class="tneed" aria-hidden="true"></span><span class="sr">，需要你</span>' : '';
  const tabs = `<nav class="mtabs" aria-label="${esc(p.displayName)}的檢視"><div class="mt">${tab('now', '此刻')}${tab('conversation', '往來', ` <span class="tn num">${added.length}</span>`)}${tab('collaboration', '協作室', r.events.length ? ` <span class="tn num">${r.events.length}</span>${need}` : '')}</div></nav>`;
  let pane;
  if (S.pane === 'conversation') {
    const removed = new Set(q.history.filter((event) => event.kind === 'GOAL_REMOVED').map((event) => event.goalId));
    const position = new Map(q.goals.map((goal, index) => [goal.goalId, index + 1]));
    const stream = q.history.map((event) => {
      if (event.kind === 'GOAL_ADDED') return ackHTML(event.goal, removed.has(event.goal.goalId), position.get(event.goal.goalId));
      if (event.kind === 'QUEUE_REORDERED') return `<div class="item m-sys"><span>你調整了工作清單的順序 · <span class="num">${time(event.at)}</span></span></div>`;
      return '';
    }).join('');
    pane = `<section class="journal" id="journal" aria-labelledby="journal-h"><h2 class="sr" id="journal-h">往來</h2>
        <div class="jscroll" id="scroller" tabindex="0" aria-label="和 Chief 的往來紀錄"><div class="stream">${stream || '<p class="wl-empty">還沒有往來紀錄。在下面輸入目標，就會加入這個專案的工作清單。</p>'}</div></div></section>`;
  } else if (S.pane === 'collaboration') {
    pane = `<section class="stage room" id="room" aria-label="協作室"><div class="scroll" id="room-scroll" tabindex="0" aria-label="協作室的內容"><div class="work">
        <div class="sn-meta"><span class="sn-k">協作室</span><span>${esc(p.displayName)}</span></div>
        <p class="room-lede">參與工作的 AI 之間實際發生的提案、審查、交接與證據。這裡不包含 AI 的內部推理。</p>
        ${roomHTML(r, { demo: demoRoom() })}</div></div></section>`;
  } else {
    pane = `<section class="stage" id="stage" aria-label="此刻"><div class="scroll" id="stage-scroll">${stageHTML()}</div></section>`;
  }
  return `<div class="view proj" data-pane="${S.pane}">${tabs}${pane}${S.pane === 'collaboration' ? '' : `<div class="dock">${composerHTML(false)}</div>`}</div>`;
}

function projectsView() {
  return `<div class="col page"><header class="page-h"><h1>專案</h1><p>${DEMO ? '示範資料。' : '專案來自本機 Workspace 設定檔。'}每個專案一次只執行一個目標；這個版本只保存與排列工作清單。</p></header>
    <div class="pgrid">${S.projects.map((item) => `<button class="pcard ${item.projectId === S.pid ? 'cur' : ''}" data-act="open" data-v="${esc(item.projectId)}">
      <div class="pc-top"><b>${esc(item.displayName)}</b><span class="spill">${item.queued ?? 0} 個排隊</span></div>
      <dl><dt>位置</dt><dd>${esc(item.repository)}</dd><dt>執行</dt><dd>尚未開始</dd></dl></button>`).join('')}</div></div>`;
}

function activityView() {
  const q = queue();
  const textOf = new Map(q.history.filter((event) => event.kind === 'GOAL_ADDED').map((event) => [event.goal.goalId, event.goal.text]));
  const rows = [...q.history].reverse().map((event) => {
    const label = event.kind === 'GOAL_ADDED' ? `你加入目標「${esc(event.goal.text)}」`
      : event.kind === 'QUEUE_REORDERED' ? '你調整了工作清單的順序'
        : `你移除了目標「${esc(textOf.get(event.goalId) ?? '')}」`;
    return `<li><span class="tm num">${time(event.at)}</span><span class="tk" aria-hidden="true"></span><span class="tx">${label}</span></li>`;
  }).join('');
  return `<div class="col page"><header class="page-h"><h1>活動</h1><p>${esc(project()?.displayName ?? '')}的工作清單紀錄。這裡只有你對工作清單做的事；這個版本沒有任何執行紀錄。</p></header>
    ${rows ? `<ol class="tl">${rows}</ol>` : '<p class="wl-empty">還沒有活動。</p>'}</div>`;
}

const CONSOLE_TEXT = `<p>進階監看（CHIEF Console）目前是凍結的設計稿，使用示範資料。</p>
  <p>工作清單裡的目標還沒有開始執行，也還沒有對應的執行編號，所以現在無法連到對應的監看畫面。等之後有真正的執行紀錄與共用的讀取模型，才會提供直接連結。</p>`;
function advancedView() {
  return `<div class="col page"><header class="page-h"><h1>進階</h1><p>給需要看細節的人。</p></header>
    <section class="adv-hero"><h2 class="wl-h2">查看詳細監看</h2>${CONSOLE_TEXT}<button class="btn" data-act="console">了解目前的狀況 ${ic('arrow', 15)}</button></section></div>`;
}

function popHTML() {
  if (S.pop !== 'proj') return '';
  const anchor = $('[data-act=pop][data-v=proj]');
  const box = anchor ? anchor.getBoundingClientRect() : { left: 12, bottom: 60 };
  return `<div class="pop" role="menu" aria-label="切換專案" data-left="${Math.round(box.left)}" data-top="${Math.round(box.bottom + 6)}"><p class="pop-h lbl">切換專案</p>
    ${S.projects.map((item) => `<button class="pitem" role="menuitemradio" aria-checked="${S.view === 'project' && item.projectId === S.pid}" data-act="open" data-v="${esc(item.projectId)}"><span class="dot" aria-hidden="true"></span><span><span class="pt">${esc(item.displayName)}</span><span class="ps">${item.queued ?? 0} 個排隊 · 尚未開始執行</span></span></button>`).join('')}</div>`;
}

// 查看決策: read-only. The Human decision backend does not exist in WS-P1, so the sheet explains the question and says
// that nothing can be decided or recorded here; its only control closes it.
function sheetHTML() {
  if (S.sheet === 'decision') {
    const event = room().summary.needsHuman.find((item) => item.id === S.decision);
    if (!event) return '';
    return `<div class="scrim" data-act="close-sheet"></div><section class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-t">
    <header class="sh-h"><h2 id="sheet-t">需要你決定</h2><button class="xbtn" data-act="close-sheet" aria-label="關閉">${ic('x', 18)}</button></header>
    <div class="sh-b">${decisionHTML(event, { demo: demoRoom() })}<button class="btn" data-act="close-sheet">關閉</button></div></section>`;
  }
  if (S.sheet !== 'console') return '';
  return `<div class="scrim" data-act="close-sheet"></div><section class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-t">
    <header class="sh-h"><h2 id="sheet-t">查看詳細監看</h2><button class="xbtn" data-act="close-sheet" aria-label="關閉">${ic('x', 18)}</button></header>
    <div class="sh-b"><section>${CONSOLE_TEXT}</section></div></section>`;
}

// ---------- render
let lastView = null;
function render() {
  const focusId = document.activeElement?.id;
  const draft = $('#composer')?.value ?? '';
  const at = S.view === 'project' ? `project:${S.pid}:${S.pane}` : S.view;
  const same = lastView === at; lastView = at;
  const keep = same ? { stage: $('#stage-scroll')?.scrollTop, journal: $('#scroller')?.scrollTop, room: $('#room-scroll')?.scrollTop, other: $('#other-scroll')?.scrollTop } : {};
  $('#banner').innerHTML = DEMO ? `<div class="wl-demo" role="note"><b>示範模式</b><span>以下都是示範資料，只存在這個頁面，不會儲存，也不會送到 Workspace 伺服器。</span><a href="/">回到正式模式</a></div>` : '';
  $('#top').innerHTML = topHTML();
  $('#rail').innerHTML = railHTML();
  $('#tabs').innerHTML = tabsHTML();
  $('#main').innerHTML = S.view === 'home' ? homeView() : S.view === 'project' ? projectView()
    : `<div class="view other"><div class="scroll" id="other-scroll" tabindex="0" aria-label="${{ projects: '專案', activity: '活動', advanced: '進階' }[S.view]}">${S.view === 'projects' ? projectsView() : S.view === 'activity' ? activityView() : advancedView()}</div></div>`;
  $('#pop').innerHTML = popHTML();
  // Positioned through the CSSOM: the page's content security policy allows no inline style attributes.
  const pop = $('#pop .pop');
  if (pop) { pop.style.left = `${pop.dataset.left}px`; pop.style.top = `${pop.dataset.top}px`; }
  $('#sheet').innerHTML = sheetHTML();
  const composer = $('#composer');
  if (composer) { composer.value = draft; if (focusId === 'composer') composer.focus(); }
  if (focusId && focusId !== 'composer') document.getElementById(focusId)?.focus();
  // Re-rendering keeps where you were reading; the correspondence opens at its latest entry.
  const journal = $('#scroller');
  if (journal) journal.scrollTop = keep.journal ?? journal.scrollHeight;
  if ($('#stage-scroll') && keep.stage !== undefined) $('#stage-scroll').scrollTop = keep.stage;
  if ($('#room-scroll') && keep.room !== undefined) $('#room-scroll').scrollTop = keep.room;
  if ($('#other-scroll') && keep.other !== undefined) $('#other-scroll').scrollTop = keep.other;
}

// ---------- actions
async function submitGoal() {
  const composer = $('#composer');
  const text = composer?.value.trim();
  // From Home the goal goes to the project chosen in 交給哪個專案; inside a project, to that project. Never to none.
  const home = S.view === 'home';
  const projectId = home ? S.target : S.pid;
  if (!text || S.sending || !byId(projectId)) return;
  S.sending = true;
  render();
  try {
    const data = await source.addGoal(projectId, text);
    applyEvent('goal.created', data);
    $('#composer').value = '';
    if (home) { S.homeAck = projectId; announce(`已加入「${byId(projectId).displayName}」的工作清單，尚未開始執行。`); } // the Human stays on Home
    else announce('已加入工作清單，尚未開始執行。');
    requestAnimationFrame(() => { const scroller = $('#scroller'); if (scroller) scroller.scrollTop = scroller.scrollHeight; });
  } catch (error) {
    toast(error.message);
  } finally {
    S.sending = false;
    render();
  }
}

async function move(goalId, delta) {
  const q = queue();
  const order = q.goals.map((goal) => goal.goalId);
  const index = order.indexOf(goalId);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= order.length) return;
  [order[index], order[target]] = [order[target], order[index]];
  try {
    const data = await source.reorder(S.pid, order, q.revision);
    applyEvent('queue.reordered', data);
    announce('已調整工作清單的順序。');
  } catch (error) {
    if (error.status === 409) { await loadQueue(S.pid); render(); toast('工作清單剛剛有變動，已重新載入。'); } else toast(error.message);
  }
}

async function remove(goalId) {
  S.confirm = null;
  try {
    const data = await source.removeGoal(S.pid, goalId);
    applyEvent('goal.removed', data);
    announce('已從工作清單移除。');
  } catch (error) {
    toast(error.message);
    render();
  }
}

// ---------- navigation: explicit Human navigation is always respected; the entry resolver runs once, at root entry.
const hashOf = () => (S.view === 'project' ? paneHref(S.pid, S.pane) : S.view === 'home' ? '#/' : `#/${S.view}`);
let booted = false;
// A project opens on 此刻 unless a view is named; switching projects closes a sheet that belonged to the old one.
function go(view, projectId, { replace = false, pane } = {}) {
  S.pop = null; S.confirm = null; S.homeAck = null;
  if (view === 'project') {
    if (!byId(projectId)) view = 'home';
    else {
      if (S.pid !== projectId) { S.pane = 'now'; S.sheet = null; S.decision = null; }
      if (PANES.includes(pane)) S.pane = pane;
      S.pid = projectId; writeLastViewed(projectId);
    }
  }
  if (view === 'home') S.target = homeTarget({ entering: S.view !== 'home' || !booted, current: S.target }, signals(), readLastViewed());
  S.view = view;
  if (location.hash !== hashOf()) history[replace ? 'replaceState' : 'pushState'](null, '', `${location.search}${hashOf()}`);
  render();
}
addEventListener('popstate', () => { const route = parseRoute(location.hash); go(route.view, route.projectId, { pane: route.pane }); });

document.addEventListener('change', (event) => {
  if (event.target.id === 'target') { S.target = event.target.value; render(); }
});
document.addEventListener('click', (event) => {
  const el = event.target.closest('[data-act]');
  if (!el) { if (S.pop && !event.target.closest('.pop')) { S.pop = null; render(); } return; }
  const { act, v } = el.dataset;
  if (el.tagName === 'A' && (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) return; // a new tab or window keeps the link
  if (el.tagName === 'A') event.preventDefault();
  switch (act) {
    case 'nav': go(v); break;
    case 'open': go('project', v); break;
    case 'room': go('project', v, { pane: 'collaboration' }); break;
    case 'pop': S.pop = S.pop === v ? null : v; render(); break;
    case 'fill': { const composer = $('#composer'); if (composer) { composer.value = v; composer.focus(); } break; }
    case 'up': void move(v, -1); break;
    case 'down': void move(v, 1); break;
    case 'ask-remove': S.confirm = v; render(); break;
    case 'cancel-remove': S.confirm = null; render(); break;
    case 'remove': void remove(v); break;
    case 'console': S.sheet = 'console'; render(); break;
    case 'decision': S.sheet = 'decision'; S.decision = v; render(); $('#sheet .xbtn')?.focus(); break;
    case 'close-sheet': S.sheet = null; S.decision = null; render(); break;
    case 'pane': go('project', S.pid, { pane: v }); break;
    default: break;
  }
});
document.addEventListener('submit', (event) => {
  if (event.target.id !== 'composer-form') return;
  event.preventDefault();
  void submitGoal();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && (S.pop || S.sheet)) { S.pop = null; S.sheet = null; S.decision = null; render(); return; }
  if (event.target.id === 'composer' && event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void submitGoal();
  }
});

source.subscribe(applyEvent, (state) => { S.conn = state; if (!DEMO) render(); });
await reloadAll();
// Entry: only the root runs the attention resolver (LIVE: always Home, since LIVE has no escalation); an explicit route
// is kept. Back/forward and clicks go straight to their destination, and SSE updates never navigate.
{
  const entry = entryFor(parseRoute(location.hash), signals());
  go(entry.view, entry.projectId, { replace: true, pane: entry.pane });
  booted = true;
}
window.__WORKSPACE = Object.freeze({ mode: source.mode, state: () => structuredClone({ view: S.view, pid: S.pid, pane: S.pane, target: S.target, conn: S.conn,
  projects: S.projects, queues: S.queues, collab: Object.fromEntries(Object.values(S.collab).map((item) => [item.projectId,
    { provenance: item.provenance, events: item.events.length, rejected: item.rejected, needsHuman: item.summary.needsHuman.length }])) }) });
