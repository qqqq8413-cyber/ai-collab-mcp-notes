// Chief Workspace (WS-L1): the real local shell. LIVE mode shows only what the local
// Workspace server holds: configured projects and their non-authoritative goal queues.
// Nothing in this page starts execution; the server has no route that could.
// Demo mode is opt-in (?demo=1), labelled, in-memory, and never mixed into LIVE state.

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

// ---------- state
const S = {
  view: 'chief', pid: null, projects: [], queues: {}, conn: 'connecting', pop: null, sheet: null,
  confirm: null, sending: false, loadError: null, stripOpen: false,
};
const project = () => S.projects.find((item) => item.projectId === S.pid);
const queue = () => S.queues[S.pid] ?? { revision: 0, goals: [], history: [] };

// ---------- data
async function loadProjects() {
  const data = await source.projects();
  S.projects = data.projects;
  let remembered = null;
  try { remembered = localStorage.getItem(`chief.workspace.${source.mode}.project`); } catch { remembered = null; }
  if (!S.projects.some((item) => item.projectId === S.pid)) {
    S.pid = S.projects.some((item) => item.projectId === remembered) ? remembered : S.projects[0]?.projectId ?? null;
  }
}
async function loadQueue(projectId) {
  const data = await source.queue(projectId);
  S.queues[projectId] = { revision: data.revision, goals: data.goals, history: data.history };
  const item = S.projects.find((p) => p.projectId === projectId);
  if (item) item.queued = data.goals.length;
}
async function reloadAll() {
  try {
    await loadProjects();
    await Promise.all(S.projects.map((item) => loadQueue(item.projectId)));
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
const statusLine = () => {
  const n = queue().goals.length;
  return n ? `${n} 個目標排隊中 · 尚未開始執行` : '工作清單是空的';
};
const connChip = () => {
  if (DEMO) return '';
  const label = { connecting: '正在連線', open: '即時更新', retrying: '重新連線中' }[S.conn] ?? '連線中';
  return `<span class="wl-conn" role="status" title="與本機 Workspace 伺服器的連線"><span class="dot ${S.conn === 'open' ? 'open' : S.conn === 'retrying' ? 'retrying' : ''}"></span><span class="lbltext">${label}</span></span>`;
};
const NOTE = `<p class="wl-note">${ic('info', 15)}<span>目前這個版本只會保存與排列工作，還不會自動啟動 AI 執行。</span></p>`;

function topHTML() {
  const p = project();
  return `<a class="brand" href="${DEMO ? '?demo=1' : '/'}" data-act="nav" data-v="chief" aria-label="CHIEF，回到首頁"><span class="mark" aria-hidden="true">C</span><span class="word">CHIEF</span></a><span class="vr" aria-hidden="true"></span>
    ${p ? `<button class="tbtn" data-act="pop" data-v="proj" aria-haspopup="true" aria-expanded="${S.pop === 'proj'}"><span class="dot" aria-hidden="true"></span><span class="pname">${esc(p.displayName)}</span>${ic('chev', 14)}</button>` : ''}
    <span class="sp"></span>${DEMO ? '<span class="proto" title="示範模式：資料只存在這個頁面">示範資料</span>' : ''}${connChip()}<span class="avatar" aria-hidden="true">你</span>`;
}
function railHTML() {
  const items = [['chief', 'chat', 'Chief'], ['projects', 'folder', '專案'], ['activity', 'pulse', '活動'], ['advanced', 'scope', '進階']];
  return `${items.map(([v, icon, label]) => `<button class="nav" data-act="nav" data-v="${v}" ${S.view === v ? 'aria-current="page"' : ''}>${ic(icon, 18)}<span class="nl">${label}</span>${v === 'projects' && S.projects.length > 1 ? '' : ''}</button>`).join('')}
    <span class="rsp"></span><p class="rail-foot">${DEMO ? '示範模式' : '本機 Workspace · 只保存工作清單'}</p>`;
}

function composerHTML(big) {
  const p = project();
  return `<form class="composer" id="composer-form" autocomplete="off"><label class="sr" for="composer">交給 Chief 的目標</label>
    <textarea id="composer" rows="${big ? 3 : 1}" maxlength="2000" placeholder="${p ? `告訴 Chief 你想完成的目標，會加入「${esc(p.displayName)}」的工作清單…` : '先在設定檔加入專案'}" ${p ? '' : 'disabled'}></textarea>
    <div class="c-row"><span class="c-hint">Enter 送出 · Shift + Enter 換行</span><button class="send" type="submit" id="send" title="加入工作清單" ${S.sending || !p ? 'disabled' : ''}><span class="sr">加入工作清單</span>${ic('up', 18)}</button></div></form>`;
}

function ackHTML(goal, removed, position) {
  const p = project();
  const pills = removed
    ? '<span class="wl-pill gone">已從工作清單移除</span>'
    : `<span class="wl-pill q">${ic('clock', 13)}排隊中</span><span class="wl-pill">尚未開始執行</span>${position ? `<span class="wl-pill">第 ${position} 個</span>` : ''}`;
  return `<div class="item m-human"><div class="bubble"><span class="sr">你：</span>${esc(goal.text).replace(/\n/g, '<br>')}</div><span class="meta num">${time(goal.createdAt)}</span></div>
    <div class="item m-chief"><span class="av" aria-hidden="true">C</span><div class="c-body"><div class="meta"><b>Chief</b></div>
      <div class="txt"><p>${removed ? '這個目標已經從工作清單移除。' : `已收到這個目標。我已經把它加入${esc(p?.displayName ?? '')}的工作清單。`}</p></div>
      <div class="wl-pills wl-after">${pills}</div></div></div>`;
}

function queueCardHTML() {
  const goals = queue().goals;
  const rows = goals.map((goal, index) => `<li data-goal="${esc(goal.goalId)}">
      <span class="qn">第 ${index + 1} 個</span>
      <span class="qt">${esc(goal.text)}<span class="qs">排隊中 · 尚未開始執行 · ${time(goal.createdAt)} 加入</span></span>
      <span class="qa"><button class="qb" data-act="up" data-v="${esc(goal.goalId)}" ${index === 0 ? 'disabled' : ''} aria-label="往前移：${esc(goal.text)}">${ic('up', 16)}</button><button class="qb" data-act="down" data-v="${esc(goal.goalId)}" ${index === goals.length - 1 ? 'disabled' : ''} aria-label="往後移：${esc(goal.text)}">${ic('down', 16)}</button><button class="qb" data-act="ask-remove" data-v="${esc(goal.goalId)}" aria-label="移除：${esc(goal.text)}">${ic('trash', 16)}</button></span>
      ${S.confirm === goal.goalId ? `<div class="wl-confirm"><span>要把「${esc(goal.text.slice(0, 40))}${goal.text.length > 40 ? '…' : ''}」從工作清單移除嗎？它還沒開始執行，移除後不會有其他影響。</span><button class="btn danger" data-act="remove" data-v="${esc(goal.goalId)}">移除</button><button class="btn quiet" data-act="cancel-remove">取消</button></div>` : ''}
    </li>`).join('');
  return `<section class="card wl-queue" aria-label="工作清單"><header class="card-h"><span class="ch-t">工作清單</span><span class="ch-s">${esc(project()?.displayName ?? '')}</span><span class="ch-r num">${goals.length} 個排隊</span></header>
    <div class="card-b">${goals.length ? `<ol>${rows}</ol>` : '<p class="wl-empty">目前沒有排隊的目標。在下面輸入目標，就會加入這裡。</p>'}</div>
    <footer class="card-f">${NOTE}</footer></section>`;
}

function chiefView() {
  const p = project();
  if (S.loadError) return `<div class="scroll"><div class="col page"><p class="wl-err">${esc(S.loadError)}</p></div></div>`;
  if (!p) return `<div class="scroll"><div class="col page"><header class="page-h"><h1>還沒有專案</h1><p>在 Workspace 設定檔的 projects 裡加入專案，重新啟動後就會出現在這裡。</p></header></div></div>`;
  const q = queue();
  const added = q.history.filter((event) => event.kind === 'GOAL_ADDED');
  if (!added.length) {
    const examples = [`繼續做${p.displayName}`, '整理目前進度，列出下一步', '檢查有沒有需要我決定的事'];
    return `<div class="scroll"><div class="col hero">
      <div class="h-who"><span class="av" aria-hidden="true">C</span><span><b>Chief</b> · ${esc(p.displayName)}</span></div>
      <h1>今天要我幫你<em>完成</em>什麼？</h1>
      ${composerHTML(true)}
      <div class="sec"><p class="lbl">可以這樣說</p><div class="ex">${examples.map((text) => `<button class="exb" data-act="fill" data-v="${esc(text)}">${esc(text)}</button>`).join('')}</div></div>
      ${NOTE}</div></div>`;
  }
  const removed = new Set(q.history.filter((event) => event.kind === 'GOAL_REMOVED').map((event) => event.goalId));
  const position = new Map(q.goals.map((goal, index) => [goal.goalId, index + 1]));
  const stream = q.history.map((event) => {
    if (event.kind === 'GOAL_ADDED') return ackHTML(event.goal, removed.has(event.goal.goalId), position.get(event.goal.goalId));
    if (event.kind === 'QUEUE_REORDERED') return `<div class="item m-sys"><span>你調整了工作清單的順序 · <span class="num">${time(event.at)}</span></span></div>`;
    return '';
  }).join('');
  return `<div class="stripbox">${stripHTML()}</div><div class="scroll" id="scroller"><div class="col"><div class="stream">${stream}${queueCardHTML()}</div></div></div>
    <div class="dock"><div class="col">${composerHTML(false)}</div></div>`;
}

function stripHTML() {
  return `<button class="strip" data-act="strip" aria-expanded="${S.stripOpen}"><span class="pulse idle" aria-hidden="true"></span><span class="sd">${esc(statusLine())}</span><span class="sn">不需要你</span>${ic('chev', 14)}</button>${S.stripOpen ? `<div class="stripx">${quadHTML()}</div>` : ''}`;
}

function quadHTML() {
  const goals = queue().goals;
  return `<dl class="q4">
    <div class="q"><dt>你交辦的</dt><dd>${goals.length ? esc(goals[0].text) : '還沒有排隊的目標'}</dd></div>
    <div class="q"><dt>Chief 正在</dt><dd>沒有正在執行的工作。這個版本只保存工作清單，不會啟動執行。</dd></div>
    <div class="q"><dt>需要你嗎</dt><dd>不需要</dd></div>
    <div class="q"><dt>工作清單</dt><dd class="num">${goals.length} 個目標排隊中</dd></div></dl>`;
}

function panelHTML() {
  const p = project();
  if (!p) return '';
  return `<div class="pn-h"><span class="lbl">目前工作</span><span class="fine">${esc(p.displayName)}</span></div>${quadHTML()}
    <dl class="ctx"><dt>專案</dt><dd>${esc(p.displayName)}</dd><dt>位置</dt><dd>${esc(p.repository)}</dd><dt>狀態</dt><dd><span class="stat"><span class="dot" aria-hidden="true"></span>尚未開始執行</span></dd></dl>
    <button class="adv" data-act="console">查看詳細監看 ${ic('ext', 13)}</button>`;
}

function projectsView() {
  return `<div class="scroll"><div class="col page"><header class="page-h"><h1>專案</h1><p>${DEMO ? '示範資料。' : '專案來自本機 Workspace 設定檔。'}每個專案一次只執行一個目標；這個版本只保存與排列工作清單。</p></header>
    <div class="pgrid">${S.projects.map((item) => `<button class="pcard ${item.projectId === S.pid ? 'cur' : ''}" data-act="switch" data-v="${esc(item.projectId)}">
      <div class="pc-top"><b>${esc(item.displayName)}</b><span class="spill">${item.queued ?? 0} 個排隊</span></div>
      <dl><dt>位置</dt><dd>${esc(item.repository)}</dd><dt>執行</dt><dd>尚未開始</dd></dl></button>`).join('')}</div></div></div>`;
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
  return `<div class="scroll"><div class="col page"><header class="page-h"><h1>活動</h1><p>${esc(project()?.displayName ?? '')}的工作清單紀錄。這裡只有你對工作清單做的事；這個版本沒有任何執行紀錄。</p></header>
    ${rows ? `<ol class="tl">${rows}</ol>` : '<p class="wl-empty">還沒有活動。</p>'}</div></div>`;
}

const CONSOLE_TEXT = `<p>進階監看（CHIEF Console）目前是凍結的設計稿，使用示範資料。</p>
  <p>工作清單裡的目標還沒有開始執行，也還沒有對應的執行編號，所以現在無法連到對應的監看畫面。等之後有真正的執行紀錄與共用的讀取模型，才會提供直接連結。</p>`;
function advancedView() {
  return `<div class="scroll"><div class="col page"><header class="page-h"><h1>進階</h1><p>給需要看細節的人。</p></header>
    <section class="adv-hero"><h2 class="wl-h2">查看詳細監看</h2>${CONSOLE_TEXT}<button class="btn" data-act="console">了解目前的狀況 ${ic('arrow', 15)}</button></section></div></div>`;
}

function popHTML() {
  if (S.pop !== 'proj') return '';
  const anchor = $('[data-act=pop][data-v=proj]');
  const box = anchor ? anchor.getBoundingClientRect() : { left: 12, bottom: 60 };
  return `<div class="pop" role="menu" aria-label="切換專案" data-left="${Math.round(box.left)}" data-top="${Math.round(box.bottom + 6)}"><p class="pop-h lbl">切換專案</p>
    ${S.projects.map((item) => `<button class="pitem" role="menuitemradio" aria-checked="${item.projectId === S.pid}" data-act="switch" data-v="${esc(item.projectId)}"><span class="dot" aria-hidden="true"></span><span><span class="pt">${esc(item.displayName)}</span><span class="ps">${item.queued ?? 0} 個排隊 · 尚未開始執行</span></span></button>`).join('')}</div>`;
}

function sheetHTML() {
  if (S.sheet !== 'console') return '';
  return `<div class="scrim" data-act="close-sheet"></div><section class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-t">
    <header class="sh-h"><h2 id="sheet-t">查看詳細監看</h2><button class="xbtn" data-act="close-sheet" aria-label="關閉">${ic('x', 18)}</button></header>
    <div class="sh-b"><section>${CONSOLE_TEXT}</section></div></section>`;
}

// ---------- render
function render() {
  const focusId = document.activeElement?.id;
  const draft = $('#composer')?.value ?? '';
  $('#banner').innerHTML = DEMO ? `<div class="wl-demo" role="note"><b>示範模式</b><span>以下都是示範資料，只存在這個頁面，不會儲存，也不會送到 Workspace 伺服器。</span><a href="/">回到正式模式</a></div>` : '';
  $('#top').innerHTML = topHTML();
  $('#rail').innerHTML = railHTML();
  $('#main').innerHTML = `<div class="view">${S.view === 'projects' ? projectsView() : S.view === 'activity' ? activityView() : S.view === 'advanced' ? advancedView() : chiefView()}</div>`;
  $('#panel').innerHTML = panelHTML();
  $('#panel').hidden = !project();
  $('#pop').innerHTML = popHTML();
  // Positioned through the CSSOM: the page's content security policy allows no inline style attributes.
  const pop = $('#pop .pop');
  if (pop) { pop.style.left = `${pop.dataset.left}px`; pop.style.top = `${pop.dataset.top}px`; }
  $('#sheet').innerHTML = sheetHTML();
  const composer = $('#composer');
  if (composer) { composer.value = draft; if (focusId === 'composer') composer.focus(); }
  if (focusId && focusId !== 'composer') document.getElementById(focusId)?.focus();
}

// ---------- actions
async function submitGoal() {
  const composer = $('#composer');
  const text = composer?.value.trim();
  if (!text || S.sending || !S.pid) return;
  S.sending = true;
  render();
  try {
    const data = await source.addGoal(S.pid, text);
    applyEvent('goal.created', data);
    $('#composer').value = '';
    announce('已加入工作清單，尚未開始執行。');
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

document.addEventListener('click', (event) => {
  const el = event.target.closest('[data-act]');
  if (!el) { if (S.pop && !event.target.closest('.pop')) { S.pop = null; render(); } return; }
  const { act, v } = el.dataset;
  if (el.tagName === 'A') event.preventDefault();
  switch (act) {
    case 'nav': S.view = v; S.pop = null; render(); break;
    case 'pop': S.pop = S.pop === v ? null : v; render(); break;
    case 'switch':
      S.pid = v; S.pop = null; S.confirm = null; S.view = 'chief';
      try { localStorage.setItem(`chief.workspace.${source.mode}.project`, v); } catch { /* optional */ }
      render(); break;
    case 'fill': { const composer = $('#composer'); if (composer) { composer.value = v; composer.focus(); } break; }
    case 'up': void move(v, -1); break;
    case 'down': void move(v, 1); break;
    case 'ask-remove': S.confirm = v; render(); break;
    case 'cancel-remove': S.confirm = null; render(); break;
    case 'remove': void remove(v); break;
    case 'console': S.sheet = 'console'; render(); break;
    case 'close-sheet': S.sheet = null; render(); break;
    case 'strip': S.stripOpen = !S.stripOpen; render(); break;
    default: break;
  }
});
document.addEventListener('submit', (event) => {
  if (event.target.id !== 'composer-form') return;
  event.preventDefault();
  void submitGoal();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && (S.pop || S.sheet)) { S.pop = null; S.sheet = null; render(); return; }
  if (event.target.id === 'composer' && event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void submitGoal();
  }
});

source.subscribe(applyEvent, (state) => { S.conn = state; if (!DEMO) render(); });
await reloadAll();
window.__WORKSPACE = Object.freeze({ mode: source.mode, state: () => structuredClone({ view: S.view, pid: S.pid, conn: S.conn, projects: S.projects, queues: S.queues }) });
