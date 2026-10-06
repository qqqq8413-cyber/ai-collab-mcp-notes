// 協作室 (WS-P1): the projection of observable AI-to-AI collaboration events, and how the Workspace shows them.
// Pure: no DOM, no storage, no network, no imports (tested directly in test-workspace-ui.mjs).
//
// An event is something a participant explicitly said or did (a proposal, question, challenge, response, hand-off,
// evidence, agreement or escalation) or an operational system event. The model has no field for hidden reasoning, and
// an event carrying any field outside the model is refused, so no source can put chain-of-thought into the room.
// Event types name what happened, never which runtime did it; the actor is a display name.
//
// The summary is derived here, deterministically, from the events alone. No model writes it.
//
// WS-P1 has no execution, so LIVE has no source of these events: live.js returns none and the room shows its empty
// state. Demo fixtures (demo.js, ?demo=1 only) are labelled as demo data wherever they appear. A Human decision
// cannot be made here: an escalation is shown, never answered, and nothing in this module records a decision.

export const EVENT_TYPES = Object.freeze(['PROPOSAL', 'QUESTION', 'CHALLENGE', 'RESPONSE', 'HANDOFF', 'EVIDENCE', 'AGREEMENT', 'ESCALATION', 'SYSTEM']);
export const EVIDENCE_KINDS = Object.freeze(['FILE', 'TESTS', 'COMMIT']);
export const TYPE_LABEL = Object.freeze({
  PROPOSAL: '提案', QUESTION: '提問', CHALLENGE: '質疑', RESPONSE: '回應', HANDOFF: '交接',
  EVIDENCE: '證據', AGREEMENT: '同意', ESCALATION: '需要你', SYSTEM: '系統',
});

// ---------- CollaborationEventV1
// { id, projectId, goalId?, actor, role?, runtime?, type, body, timestamp, evidence? }
// evidence: [{ kind: 'FILE', path, lines? } | { kind: 'TESTS', passed, failed?, label? } | { kind: 'COMMIT', sha }]
const EVENT_KEYS = ['id', 'projectId', 'goalId', 'actor', 'role', 'runtime', 'type', 'body', 'timestamp', 'evidence'];
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const MAX_EVIDENCE = 8;

class InvalidEvent extends Error {}
const refuse = (why) => { throw new InvalidEvent(why); };
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function only(value, keys) {
  const extra = Object.keys(value).find((key) => !keys.includes(key));
  if (extra !== undefined) refuse(`unknown field ${extra}`);
}
function text(value, max, { lines = false } = {}) {
  if (typeof value !== 'string') refuse('not text');
  const clean = value.trim();
  if (!clean || clean.length > max) refuse('empty or too long');
  if ((lines ? /[\u0000-\u0009\u000b-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(clean)) refuse('control character');
  return clean;
}
const optional = (value, max) => (value === undefined ? undefined : text(value, max));
const id = (value) => (typeof value === 'string' && ID.test(value) ? value : refuse('bad id'));
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : refuse('bad count'));

function evidenceOf(item) {
  if (!isObject(item)) refuse('evidence is not an object');
  if (item.kind === 'FILE') {
    only(item, ['kind', 'path', 'lines']);
    const lines = optional(item.lines, 24);
    return Object.freeze({ kind: 'FILE', path: text(item.path, 300), ...(lines === undefined ? {} : { lines }) });
  }
  if (item.kind === 'TESTS') {
    only(item, ['kind', 'passed', 'failed', 'label']);
    const label = optional(item.label, 80);
    return Object.freeze({ kind: 'TESTS', passed: count(item.passed), ...(item.failed === undefined ? {} : { failed: count(item.failed) }),
      ...(label === undefined ? {} : { label }) });
  }
  if (item.kind === 'COMMIT') {
    only(item, ['kind', 'sha']);
    if (typeof item.sha !== 'string' || !/^[0-9a-f]{7,40}$/.test(item.sha)) refuse('bad commit');
    return Object.freeze({ kind: 'COMMIT', sha: item.sha });
  }
  return refuse('unknown evidence kind');
}

function eventOf(projectId, raw) {
  if (!isObject(raw)) refuse('event is not an object');
  only(raw, EVENT_KEYS);
  if (raw.projectId !== projectId) refuse('event belongs to another project');
  if (!EVENT_TYPES.includes(raw.type)) refuse('unknown type');
  if (typeof raw.timestamp !== 'string' || !Number.isFinite(Date.parse(raw.timestamp))) refuse('bad timestamp');
  if (raw.evidence !== undefined && (!Array.isArray(raw.evidence) || raw.evidence.length > MAX_EVIDENCE)) refuse('bad evidence list');
  const role = optional(raw.role, 40);
  const runtime = optional(raw.runtime, 40);
  return Object.freeze({
    id: id(raw.id), projectId, ...(raw.goalId === undefined ? {} : { goalId: id(raw.goalId) }),
    actor: text(raw.actor, 40), ...(role === undefined ? {} : { role }), ...(runtime === undefined ? {} : { runtime }),
    type: raw.type, body: text(raw.body, 4000, { lines: true }), timestamp: raw.timestamp,
    ...(raw.evidence === undefined ? {} : { evidence: Object.freeze(raw.evidence.map(evidenceOf)) }),
  });
}

/** Valid events for one project, oldest first; anything malformed, foreign or duplicated is counted and left out. */
export function parseCollaborationEvents(projectId, raw) {
  const events = [];
  const seen = new Set();
  let rejected = 0;
  for (const item of Array.isArray(raw) ? raw : []) {
    try {
      const event = eventOf(projectId, item);
      if (seen.has(event.id)) refuse('duplicate id');
      seen.add(event.id);
      events.push(event);
    } catch (error) {
      if (!(error instanceof InvalidEvent)) throw error;
      rejected++;
    }
  }
  events.sort((a, b) => (Date.parse(a.timestamp) - Date.parse(b.timestamp)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return Object.freeze({ events: Object.freeze(events), rejected });
}

// ---------- CollaborationSummaryV1
// { projectId, activeParticipants, consensus, disagreements, needsHuman }
//   activeParticipants: each actor who said something (system events excluded), in order of first appearance;
//   consensus: the AGREEMENT events, verbatim;
//   disagreements: CHALLENGE events their own author has not later agreed to within the same goal;
//   needsHuman: every ESCALATION, oldest first. WS-P1 has no Human decision backend, so none is ever resolved here.
export function summarizeCollaboration(projectId, events) {
  const participants = new Map();
  for (const event of events) {
    if (event.type !== 'SYSTEM' && !participants.has(event.actor)) {
      participants.set(event.actor, Object.freeze({ actor: event.actor, ...(event.role ? { role: event.role } : {}) }));
    }
  }
  const settled = (challenge, index) => events.slice(index + 1)
    .some((later) => later.type === 'AGREEMENT' && later.actor === challenge.actor && later.goalId === challenge.goalId);
  return Object.freeze({
    projectId,
    activeParticipants: Object.freeze([...participants.values()]),
    consensus: Object.freeze(events.filter((event) => event.type === 'AGREEMENT')),
    disagreements: Object.freeze(events.filter((event, index) => event.type === 'CHALLENGE' && !settled(event, index))),
    needsHuman: Object.freeze(events.filter((event) => event.type === 'ESCALATION')),
  });
}

/** One project's room: validated events, how many were left out, and the derived summary. */
export function collaborationRoom(projectId, data) {
  const { events, rejected } = parseCollaborationEvents(projectId, data?.events);
  return Object.freeze({ projectId, provenance: data?.provenance ?? 'NONE', events, rejected, summary: summarizeCollaboration(projectId, events) });
}

// ---------- presentation (HTML strings; the page's strict content security policy allows no inline style)
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const para = (value) => esc(value).replace(/\n/g, '<br>');
const valid = (iso) => !Number.isNaN(new Date(iso).getTime());
const clock = (iso) => (valid(iso) ? new Date(iso).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false }) : '');
const stamp = (iso) => (valid(iso) ? new Date(iso).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '');
const when = (iso) => `<time class="num" datetime="${esc(iso)}" title="${esc(stamp(iso))}">${clock(iso)}</time>`;
const who = (event) => `${esc(event.actor)}${event.role ? ` · ${esc(event.role)}` : ''}`;

/** The reusable evidence block: file, tests, commit. Display only. */
export function evidenceHTML(evidence) {
  if (!evidence?.length) return '';
  const rows = evidence.map((item) => {
    if (item.kind === 'FILE') return `<div class="evd-r"><dt>檔案</dt><dd><code>${esc(item.path)}${item.lines ? `:${esc(item.lines)}` : ''}</code></dd></div>`;
    if (item.kind === 'TESTS') {
      return `<div class="evd-r"><dt>測試</dt><dd>${item.label ? `${esc(item.label)} · ` : ''}<span class="num">${item.passed}</span> 項通過${item.failed === undefined ? '' : ` · <span class="num">${item.failed}</span> 項失敗`}</dd></div>`;
    }
    return `<div class="evd-r"><dt>提交</dt><dd><code title="${esc(item.sha)}">${esc(item.sha.slice(0, 7))}…</code></dd></div>`;
  }).join('');
  return `<dl class="evd" aria-label="證據">${rows}</dl>`;
}

export function eventHTML(event) {
  if (event.type === 'SYSTEM') {
    return `<li class="ev ev-sys" data-type="SYSTEM"><span class="ev-sl"><span class="ev-t">${TYPE_LABEL.SYSTEM}</span>${para(event.body)} · ${when(event.timestamp)}</span></li>`;
  }
  return `<li class="ev t-${event.type.toLowerCase()}" data-type="${event.type}"><span class="ev-n" aria-hidden="true"></span>
    <article class="ev-b" aria-label="${esc(event.actor)}，${TYPE_LABEL[event.type]}">
      <header class="ev-h"><b class="ev-a">${esc(event.actor)}</b><span class="ev-m">${event.role ? `${esc(event.role)} · ` : ''}${when(event.timestamp)}</span><span class="ev-t">${TYPE_LABEL[event.type]}</span></header>
      <p class="ev-x">${para(event.body)}</p>${evidenceHTML(event.evidence)}</article></li>`;
}

export function summaryHTML(summary) {
  const people = summary.activeParticipants;
  const list = (events) => `<ul class="bul">${events.map((event) => `<li>${para(event.body)}<span class="bul-by">${who(event)}</span></li>`).join('')}</ul>`;
  const need = summary.needsHuman.length;
  return `<section class="csum" aria-labelledby="csum-h"><h2 class="lbl" id="csum-h">AI 協作摘要</h2>
    <ul class="csum-f">
      <li>目前 <span class="cn num">${people.length}</span> 個 AI 參與${people.length ? `<span class="csum-who">${people.map((p) => `${esc(p.actor)}${p.role ? `（${esc(p.role)}）` : ''}`).join('、')}</span>` : ''}</li>
      <li><span class="cn num">${summary.disagreements.length}</span> 個尚未解決的分歧</li>
      <li class="${need ? 'need' : ''}"><span class="cn num">${need}</span> 個需要你決定</li>
    </ul>
    <div class="csum-l"><h3 class="lbl">目前共識</h3>${summary.consensus.length ? list(summary.consensus) : '<p class="wl-empty">還沒有共識紀錄。</p>'}</div>
    ${summary.disagreements.length ? `<div class="csum-l"><h3 class="lbl">尚未解決的分歧</h3>${list(summary.disagreements)}</div>` : ''}</section>`;
}

/** An escalation, shown and never answered: the only action opens a read-only explanation. */
export function needHTML(event) {
  return `<section class="needb" aria-labelledby="need-${esc(event.id)}"><header class="needb-h"><span class="pulse idle need" aria-hidden="true"></span>
      <h2 id="need-${esc(event.id)}">需要你</h2><span class="needb-m">${who(event)} · ${when(event.timestamp)} 提出</span></header>
    <p class="needb-x">${para(event.body)}</p>
    <button class="btn gold" type="button" data-act="decision" data-v="${esc(event.id)}">查看決策</button></section>`;
}

export const EMPTY_ROOM = `<div class="c-empty"><h2 class="ce-h">目前沒有 AI 協作紀錄</h2><p>這個專案尚未開始執行，<br>或目前沒有可顯示的協作事件。</p></div>`;
const DEMO_TAG = '<p class="demo-tag" role="note"><b>示範資料</b><span>這些不是真的 AI 協作紀錄，只用來展示協作室的樣子。</span></p>';

/** The room body: demo label, then either the empty state or summary → 需要你 → the record, oldest first. */
export function roomHTML(room, { demo = false } = {}) {
  const tag = demo || room.provenance === 'DEMO_SAMPLE' ? DEMO_TAG : '';
  const left = room.rejected ? `<p class="c-left">有 <span class="num">${room.rejected}</span> 則事件格式不正確，沒有顯示。</p>` : '';
  if (!room.events.length) return `${tag}${EMPTY_ROOM}${left}`;
  return `${tag}${summaryHTML(room.summary)}${room.summary.needsHuman.map(needHTML).join('')}
    <section class="thread" aria-labelledby="thread-h"><h2 class="lbl" id="thread-h">協作紀錄 <span class="num">${room.events.length}</span></h2>
      <ol class="evs">${room.events.map(eventHTML).join('')}</ol></section>${left}`;
}

/** The read-only 查看決策 sheet body. There is no option, answer, approval or record: the backend does not exist. */
export function decisionHTML(event, { demo = false } = {}) {
  return `${demo ? DEMO_TAG : ''}<section><p class="lbl">要決定的事</p><p class="dec-q">${para(event.body)}</p>
      <p class="dec-m">${who(event)} · ${esc(stamp(event.timestamp))} 提出</p>${evidenceHTML(event.evidence)}</section>
    <section class="dec-na"><p>這個版本還沒有人類決策功能。你可以在這裡看清楚問題，但 Workspace 不能在這裡做決定，也不會記錄任何決定或授權。</p></section>`;
}
