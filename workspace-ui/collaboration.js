// 協作室 (WS-P1, WS-P2, UI-C1): the projection of observable AI-to-AI collaboration events, and how the Workspace shows
// them. Pure: no DOM, no storage, no network, no imports (tested directly in test-workspace-ui.mjs).
//
// What an event is (canonical rule). CollaborationEventV1 represents only collaboration artifacts a participant
// explicitly emitted: an agent message, a review comment, a hand-off, evidence, an operational event, or a summary of
// the rationale for a decision. It is not a record of how a model reasoned. A future execution source MUST NOT put
// hidden or private model reasoning into `body` (or anywhere else in an event).
// What the code does and does not enforce. The projection refuses any event with a field outside the model, so a
// source cannot add a reasoning-shaped field; it cannot tell what text a source puts into `body`. Keeping private
// reasoning out of `body` is the source's obligation under the rule above, not something this module can prove.
// Event types name what happened, never which runtime did it; actor, role and runtime are display metadata only.
//
// The summary and the conversation windows are derived here, deterministically, from the events alone. No model
// writes them, and nothing here names a particular agent: every name shown comes from the record.
//
// There is no execution, so LIVE has no source of these events: live.js returns none and the room shows its empty
// state. Demo fixtures (demo.js, ?demo=1 only) are labelled as demo data wherever they appear. A Human decision
// cannot be made here: an escalation is shown, never answered, and nothing in this module records a decision.

export const EVENT_TYPES = Object.freeze(['PROPOSAL', 'QUESTION', 'CHALLENGE', 'RESPONSE', 'HANDOFF', 'EVIDENCE', 'AGREEMENT', 'ESCALATION', 'SYSTEM']);
export const EVIDENCE_KINDS = Object.freeze(['FILE', 'TESTS', 'COMMIT']);
export const TYPE_LABEL = Object.freeze({
  PROPOSAL: '提案', QUESTION: '提問', CHALLENGE: '質疑', RESPONSE: '回應', HANDOFF: '交接',
  EVIDENCE: '證據', AGREEMENT: '同意', ESCALATION: '需要你', SYSTEM: '系統',
});

// ---------- CollaborationEventV1
// { id, projectId, goalId?, actor, role?, runtime?, to?, type, body, timestamp, evidence? }
// to (UI-C1, optional): the participants a message was sent to, by the name they act under. Strict: 1–8 distinct
// names, never the sender itself, and never on SYSTEM (an operational line, not a message) or ESCALATION (addressed to
// the Human by its type). An event that breaks any of these is refused, never repaired.
// evidence: [{ kind: 'FILE', path, lines? } | { kind: 'TESTS', passed, failed?, label? } | { kind: 'COMMIT', sha }]
const EVENT_KEYS = ['id', 'projectId', 'goalId', 'actor', 'role', 'runtime', 'to', 'type', 'body', 'timestamp', 'evidence'];
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const MAX_EVIDENCE = 8;
const MAX_TO = 8;

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

function addresseesOf(value, actor, type) {
  if (type === 'SYSTEM' || type === 'ESCALATION') refuse(`${type} has no addressees`);
  if (!Array.isArray(value) || !value.length || value.length > MAX_TO) refuse('bad addressees');
  const names = value.map((name) => text(name, 40));
  if (new Set(names).size !== names.length) refuse('repeated addressee');
  if (names.includes(actor)) refuse('addressed to its own sender');
  return Object.freeze(names);
}

function eventOf(projectId, raw) {
  if (!isObject(raw)) refuse('event is not an object');
  only(raw, EVENT_KEYS);
  if (raw.projectId !== projectId) refuse('event belongs to another project');
  if (!EVENT_TYPES.includes(raw.type)) refuse('unknown type');
  if (typeof raw.timestamp !== 'string' || !Number.isFinite(Date.parse(raw.timestamp))) refuse('bad timestamp');
  if (raw.evidence !== undefined && (!Array.isArray(raw.evidence) || raw.evidence.length > MAX_EVIDENCE)) refuse('bad evidence list');
  const actor = text(raw.actor, 40);
  const role = optional(raw.role, 40);
  const runtime = optional(raw.runtime, 40);
  const to = raw.to === undefined ? undefined : addresseesOf(raw.to, actor, raw.type);
  return Object.freeze({
    id: id(raw.id), projectId, ...(raw.goalId === undefined ? {} : { goalId: id(raw.goalId) }),
    actor, ...(role === undefined ? {} : { role }), ...(runtime === undefined ? {} : { runtime }), ...(to === undefined ? {} : { to }),
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
//   needsHuman: every ESCALATION, oldest first. There is no Human decision backend, so none is ever resolved here.
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

// ---------- the conversation windows (UI-C1; derived, deterministic, strict about recipients)
// One window per participant: every actor who sent something (SYSTEM excluded) and every name a message was addressed
// to, in order of first appearance. None is dropped, none is invented, none is named in this code. A window holds
// what its participant sent ('out') and what was addressed to it by name ('in'). A message reaches a window only when
// the record names that window's participant in `to`: a message without `to` stays in its sender's window, shown as
// having no recorded addressee, and an ESCALATION goes to the Human (the 需要你 strip), never into another window;
// SYSTEM lines appear in all windows. `seq` is the event's place in the record (1-based).
export function conversationOf(events) {
  const order = [];
  for (const event of events) {
    if (event.type === 'SYSTEM') continue;
    for (const name of [event.actor, ...(event.to ?? [])]) if (!order.includes(name)) order.push(name);
  }
  const seq = new Map(events.map((event, index) => [event.id, index + 1]));
  return Object.freeze(order.map((actor) => {
    const role = events.find((event) => event.type !== 'SYSTEM' && event.actor === actor)?.role;
    const partners = [];
    const items = [];
    const meet = (name) => { if (!partners.includes(name)) partners.push(name); };
    for (const event of events) {
      const at = seq.get(event.id);
      if (event.type === 'SYSTEM') items.push(Object.freeze({ seq: at, side: 'system', event }));
      else if (event.actor === actor) { items.push(Object.freeze({ seq: at, side: 'out', event })); (event.to ?? []).forEach(meet); }
      else if (event.to?.includes(actor)) { items.push(Object.freeze({ seq: at, side: 'in', event })); meet(event.actor); }
    }
    return Object.freeze({ actor, ...(role ? { role } : {}), partners: Object.freeze(partners), items: Object.freeze(items) });
  }));
}

// ---------- presentation (HTML strings; the page's strict content security policy allows no inline style)
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const para = (value) => esc(value).replace(/\n/g, '<br>');
const valid = (iso) => !Number.isNaN(new Date(iso).getTime());
const clock = (iso) => (valid(iso) ? new Date(iso).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false }) : '');
const stamp = (iso) => (valid(iso) ? new Date(iso).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '');
const when = (iso) => `<time class="num" datetime="${esc(iso)}" title="${esc(stamp(iso))}">${clock(iso)}</time>`;
const who = (event) => `${esc(event.actor)}${event.role ? ` · ${esc(event.role)}` : ''}`;
const names = (list) => list.map(esc).join('、');

/** The reusable evidence block: file, tests, commit. Display only; it hangs off the escalation that attached it. */
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

/** Evidence inside a message: the same three kinds, as small attachments under the text. Display only. */
export function attachmentsHTML(evidence) {
  if (!evidence?.length) return '';
  return `<p class="att" aria-label="附件">${evidence.map((item) => {
    if (item.kind === 'FILE') return `<span><b>檔案</b><code>${esc(item.path)}${item.lines ? `:${esc(item.lines)}` : ''}</code></span>`;
    if (item.kind === 'TESTS') {
      return `<span><b>測試</b>${item.label ? `${esc(item.label)} ` : ''}<span class="num">${item.passed}</span> 項通過${item.failed === undefined ? '' : ` · <span class="num">${item.failed}</span> 項失敗`}</span>`;
    }
    return `<span><b>提交</b><code title="${esc(item.sha)}">${esc(item.sha.slice(0, 7))}</code></span>`;
  }).join('')}</p>`;
}

const tag = (event) => `<span class="cm-t">${TYPE_LABEL[event.type]}</span>`;
const sentTo = (event) => (event.type === 'ESCALATION' ? '給 你' : event.to ? `給 ${names(event.to)}` : '沒有記錄收件者');
const TYPING = '<li class="cm-typing" aria-hidden="true"><span class="ty-n"></span><span class="ty-d"><i></i><i></i><i></i></span></li>';

/** One message as its window shows it: sent (right) or received (left, under the sender's name). */
export function messageHTML(item, chat) {
  const { event, seq, side } = item;
  if (side === 'system') return `<li class="cm-sys" data-seq="${seq}">${para(event.body)} · ${when(event.timestamp)}</li>`;
  const kind = `t-${event.type.toLowerCase()}`;
  const body = `<div class="bub">${para(event.body)}${attachmentsHTML(event.evidence)}</div>`;
  if (side === 'out') return `<li class="cm cm-out ${kind}" data-seq="${seq}">${body}<p class="cm-m">${tag(event)} · ${sentTo(event)} · ${when(event.timestamp)}</p></li>`;
  const also = event.to.filter((name) => name !== chat.actor);
  return `<li class="cm cm-in ${kind}" data-seq="${seq}"><p class="cm-from">${esc(event.actor)}</p>${body}
    <p class="cm-m">${tag(event)}${also.length ? ` · 也給 ${names(also)}` : ''} · ${when(event.timestamp)}</p></li>`;
}

/**
 * 協作室 as conversations (UI-C1): one chat window per participant, side by side when the room is wide, one at a time
 * behind name tabs when it is narrow. Every message carries data-seq so a demo replay can reveal them in order; the
 * markup itself always holds the whole record. Only a replay room (`replay`) carries the replay bar, the typing row
 * and data-replay="1"; any other room is a plain record and claims nothing about what is happening now.
 */
export function conversationHTML(room, { replay = false } = {}) {
  if (!room.events.length) return EMPTY_ROOM;
  const chats = conversationOf(room.events);
  const windows = chats.map((chat, index) => `<section class="cw" id="cw-${index + 1}" data-w="${index + 1}" aria-label="${esc(chat.actor)} 的對話">
      <header class="cw-h"><b class="cw-n">${esc(chat.actor)}</b><span class="cw-r">${chat.role ? `${esc(chat.role)} · ` : ''}${chat.partners.length ? `和 ${names(chat.partners)} 對話` : '還沒有對話對象'}</span></header>
      <ol class="cw-log">${chat.items.map((item) => messageHTML(item, chat)).join('')}${replay ? TYPING : ''}</ol></section>`).join('');
  const tabs = chats.map((chat, index) => `<button type="button" role="tab" data-cw="${index + 1}" aria-controls="cw-${index + 1}" aria-selected="${index === 0}">${esc(chat.actor)}<span class="cw-dot" aria-hidden="true"></span></button>`).join('');
  const bar = replay ? `<div class="cv-bar"><span class="cv-k">示範重播</span><span class="cv-p num"></span>
      <button class="btn quiet" type="button" data-replay="restart">從頭播放</button><button class="btn quiet" type="button" data-replay="all">全部顯示</button></div>` : '';
  return `<div class="conv" data-key="${esc(room.projectId)}" data-max="${room.events.length}"${replay ? ' data-replay="1"' : ''}>${bar}
    <div class="cw-tabs" role="tablist" aria-label="切換對話視窗">${tabs}</div>
    <div class="chats${chats.length > 4 ? ' cw-many' : ''}" data-n="${Math.min(chats.length, 4)}" data-active="1">${windows}</div></div>`;
}

/** 需要你: each open escalation shown, never answered; the only action opens a read-only explanation. */
export function needsHTML(summary, { seqOf } = {}) {
  const items = summary.needsHuman.map((event) => `<li class="nr-i"${seqOf?.has(event.id) ? ` data-seq="${seqOf.get(event.id)}"` : ''}><p class="nr-q">${para(event.body)}</p>
      <p class="nr-m">${who(event)} · ${when(event.timestamp)} 提出</p>${evidenceHTML(event.evidence)}
      <button class="btn gold" type="button" data-act="decision" data-v="${esc(event.id)}">查看決策</button></li>`).join('');
  return `<h2 class="nr-h" id="needs-h" tabindex="-1">需要你 <span class="num nr-c">${summary.needsHuman.length}</span></h2>
    <ul class="nr">${items}</ul>${items ? NEEDS_EMPTY.replace('class="nr-empty"', 'class="nr-empty" hidden') : NEEDS_EMPTY}`;
}

export const EMPTY_ROOM = `<div class="c-empty"><h3 class="ce-h">目前沒有 AI 協作紀錄</h3><p>這個專案尚未開始執行，<br>或目前沒有可顯示的協作事件。</p></div>`;
export const NEEDS_EMPTY = '<div class="nr-empty"><p>目前沒有需要你決定的事。</p><p>AI 之間無法自行決定的事，會出現在這裡。</p></div>';
const DEMO_TAG = '<p class="demo-tag" role="note"><b>示範資料</b><span>這些不是真的 AI 對話，只用來展示協作室的樣子。</span></p>';

/**
 * The room body: demo label, the 需要你 strip (gold while something waits for the Human), then the conversation
 * windows. `replay` is the page's request to replay; it is honoured only for a room labelled as demo data, so a record
 * from any other source is never replayed.
 */
export function roomHTML(room, { demo = false, replay = false } = {}) {
  const isDemo = demo || room.provenance === 'DEMO_SAMPLE';
  const left = room.rejected ? `<p class="c-left">有 <span class="num">${room.rejected}</span> 則事件格式不正確，沒有顯示。</p>` : '';
  const need = room.summary.needsHuman.length;
  const seqOf = new Map(room.events.map((event, index) => [event.id, index + 1]));
  return `${isDemo ? DEMO_TAG : ''}
    <div class="room-body">
      <section class="nstrip${need ? ' has-need' : ''}" aria-labelledby="needs-h">${needsHTML(room.summary, { seqOf })}</section>
      <section class="disc" aria-label="AI 之間的對話">${conversationHTML(room, { replay: replay && isDemo })}</section>
    </div>${left}`;
}

/** The read-only 查看決策 sheet body. There is no option, answer, approval or record: the backend does not exist. */
export function decisionHTML(event, { demo = false } = {}) {
  return `${demo ? DEMO_TAG : ''}<section><p class="lbl">要決定的事</p><p class="dec-q">${para(event.body)}</p>
      <p class="dec-m">${who(event)} · ${esc(stamp(event.timestamp))} 提出</p>${evidenceHTML(event.evidence)}</section>
    <section class="dec-na"><p>這個版本還沒有人類決策功能。你可以在這裡看清楚問題，但 Workspace 不能在這裡做決定，也不會記錄任何決定或授權。</p></section>`;
}
