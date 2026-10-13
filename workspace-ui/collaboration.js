// 協作室 (WS-P1, WS-P2, UI-C1, UI-C1-C1): the projection of observable AI-to-AI collaboration events, and how the Workspace shows
// them. Pure: no DOM, no storage, no network, no imports (tested directly in test-workspace-ui.mjs).
//
// What an event is (canonical rule). CollaborationEventV1 represents only collaboration artifacts a participant
// explicitly emitted: an agent message, a review comment, a hand-off, evidence, an operational event, or a summary of
// the rationale for a decision. It is not a record of how a model reasoned. A future execution source MUST NOT put
// hidden or private model reasoning into `body` (or anywhere else in an event).
// What the code does and does not enforce. The projection refuses any event with a field outside the model, so a
// source cannot add a reasoning-shaped field; it cannot tell what text a source puts into `body`. Keeping private
// reasoning out of `body` is the source's obligation under the rule above, not something this module can prove.
// Event types name what happened, never which runtime did it; actor, role and runtime are display metadata only. Who a
// participant is comes from its stable participant ID (actorId) and the room's participant directory, never from a name.
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
// { id, projectId, goalId?, actor, actorId?, role?, runtime?, to?, type, body, timestamp, evidence? }
// actor: the name the sender acts under (display metadata only).
// actorId (UI-C1-C1, optional): the sender's stable participant ID. Never on SYSTEM (an operational line, not a
// participant). An event without it is a historical record.
// to (UI-C1-C1, optional): the stable participant IDs a message was addressed to. Only beside actorId (a historical
// record names no addressee); 1–8 distinct IDs, never the sender's own, never on SYSTEM or ESCALATION (addressed to the
// Human by its type). Without `to`, an AI message is addressed to no one in particular (see conversationOf).
// An event that breaks any of these is refused, never repaired.
// evidence: [{ kind: 'FILE', path, lines? } | { kind: 'TESTS', passed, failed?, label? } | { kind: 'COMMIT', sha }]
const EVENT_KEYS = ['id', 'projectId', 'goalId', 'actor', 'actorId', 'role', 'runtime', 'to', 'type', 'body', 'timestamp', 'evidence'];
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const MAX_EVIDENCE = 8;
const MAX_TO = 8;
const MAX_PARTICIPANTS = 32;

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

function addresseesOf(value, actorId, type) {
  if (type === 'SYSTEM' || type === 'ESCALATION') refuse(`${type} has no addressees`);
  if (actorId === undefined) refuse('addressees without a sender identity');
  if (!Array.isArray(value) || !value.length || value.length > MAX_TO) refuse('bad addressees');
  const ids = value.map(id);
  if (new Set(ids).size !== ids.length) refuse('repeated addressee');
  if (ids.includes(actorId)) refuse('addressed to its own sender');
  return Object.freeze(ids);
}

function eventOf(projectId, raw) {
  if (!isObject(raw)) refuse('event is not an object');
  only(raw, EVENT_KEYS);
  if (raw.projectId !== projectId) refuse('event belongs to another project');
  if (!EVENT_TYPES.includes(raw.type)) refuse('unknown type');
  if (typeof raw.timestamp !== 'string' || !Number.isFinite(Date.parse(raw.timestamp))) refuse('bad timestamp');
  if (raw.evidence !== undefined && (!Array.isArray(raw.evidence) || raw.evidence.length > MAX_EVIDENCE)) refuse('bad evidence list');
  const actor = text(raw.actor, 40);
  if (raw.actorId !== undefined && raw.type === 'SYSTEM') refuse('a SYSTEM line has no sender identity');
  const actorId = raw.actorId === undefined ? undefined : id(raw.actorId);
  const role = optional(raw.role, 40);
  const runtime = optional(raw.runtime, 40);
  const to = raw.to === undefined ? undefined : addresseesOf(raw.to, actorId, raw.type);
  return Object.freeze({
    id: id(raw.id), projectId, ...(raw.goalId === undefined ? {} : { goalId: id(raw.goalId) }),
    actor, ...(actorId === undefined ? {} : { actorId }), ...(role === undefined ? {} : { role }), ...(runtime === undefined ? {} : { runtime }), ...(to === undefined ? {} : { to }),
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
//   activeParticipants: each sender (system events excluded), in order of first appearance, told apart by actorId when
//     the event has one and by name when it has none;
//   consensus: the AGREEMENT events, verbatim;
//   disagreements: CHALLENGE events their own author has not later agreed to within the same goal;
//   needsHuman: every ESCALATION, oldest first. There is no Human decision backend, so none is ever resolved here.
const senderOf = (event) => (event.actorId === undefined ? `name:${event.actor}` : `id:${event.actorId}`);
export function summarizeCollaboration(projectId, events) {
  const participants = new Map();
  for (const event of events) {
    if (event.type !== 'SYSTEM' && !participants.has(senderOf(event))) {
      participants.set(senderOf(event), Object.freeze({ actor: event.actor, ...(event.actorId ? { actorId: event.actorId } : {}), ...(event.role ? { role: event.role } : {}) }));
    }
  }
  const settled = (challenge, index) => events.slice(index + 1)
    .some((later) => later.type === 'AGREEMENT' && senderOf(later) === senderOf(challenge) && later.goalId === challenge.goalId);
  return Object.freeze({
    projectId,
    activeParticipants: Object.freeze([...participants.values()]),
    consensus: Object.freeze(events.filter((event) => event.type === 'AGREEMENT')),
    disagreements: Object.freeze(events.filter((event, index) => event.type === 'CHALLENGE' && !settled(event, index))),
    needsHuman: Object.freeze(events.filter((event) => event.type === 'ESCALATION')),
  });
}

// ---------- the participant directory and how a room tells participants apart (UI-C1-C1)
// participants: [{ id, name }] — who takes part in a room, by stable participant ID, with the name each acts under;
// supplied by the source beside its events. Strict: 1–32 entries, distinct IDs, no other field. One bad entry makes the
// whole directory unusable; it is never repaired. Two participants may share a name: they remain two participants.
function directoryOf(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_PARTICIPANTS) return null;
  try {
    const entries = raw.map((item) => {
      if (!isObject(item)) refuse('participant is not an object');
      only(item, ['id', 'name']);
      return Object.freeze({ id: id(item.id), name: text(item.name, 40) });
    });
    if (new Set(entries.map((entry) => entry.id)).size !== entries.length) refuse('repeated participant');
    return Object.freeze(entries);
  } catch (error) {
    if (!(error instanceof InvalidEvent)) throw error;
    return null;
  }
}

// One rule per room, never two at once (SYSTEM lines belong to no participant and never decide it):
//   IDENTIFIED    every message carries actorId and the room has a valid directory. Participants are directory IDs. A
//                 message whose sender or addressee is not in the directory, or whose actor is not the directory's name
//                 for its actorId, is refused (fail closed) and counted.
//   LEGACY        no message carries actorId (historical records). Participants are told apart by name, and the room
//                 says so; one name is one participant.
//   MIXED         some messages carry actorId and some do not.
//   NO_DIRECTORY  every message carries actorId, but there is no valid directory.
// In MIXED and NO_DIRECTORY nobody can be told apart safely, so nothing is guessed: the room shows the record in order
// with a warning, and opens no conversation windows at all.
export const IDENTITY_RULES = Object.freeze(['IDENTIFIED', 'LEGACY', 'MIXED', 'NO_DIRECTORY']);
export function identityOf(events, participants) {
  const messages = events.filter((event) => event.type !== 'SYSTEM');
  const withId = messages.filter((event) => event.actorId !== undefined).length;
  if (!withId) return 'LEGACY';
  if (withId < messages.length) return 'MIXED';
  return participants ? 'IDENTIFIED' : 'NO_DIRECTORY';
}

/** One project's room: validated events, how many were left out (and why), the participant rule, and the summary. */
export function collaborationRoom(projectId, data) {
  const parsed = parseCollaborationEvents(projectId, data?.events);
  const directory = directoryOf(data?.participants);
  const identity = identityOf(parsed.events, directory);
  const named = new Map((identity === 'IDENTIFIED' ? directory : []).map((entry) => [entry.id, entry.name]));
  const known = (event) => event.type === 'SYSTEM' || (named.get(event.actorId) === event.actor && (event.to ?? []).every((to) => named.has(to)));
  const events = identity === 'IDENTIFIED' ? Object.freeze(parsed.events.filter(known)) : parsed.events;
  return Object.freeze({
    projectId, provenance: data?.provenance ?? 'NONE', identity, participants: identity === 'IDENTIFIED' ? directory : Object.freeze([]),
    events, rejected: parsed.rejected, unverified: parsed.events.length - events.length, summary: summarizeCollaboration(projectId, events),
  });
}

// ---------- the conversation windows (UI-C1, corrected by UI-C1-C1; derived, deterministic)
// Only for a room whose rule is IDENTIFIED or LEGACY (anything else: null, no windows). A window's participant is a
// directory ID (IDENTIFIED) or a name (LEGACY); its `key` says which. Windows: every sender (SYSTEM excluded) and every
// addressee in order of first appearance, then (IDENTIFIED) any other directory participant. None is dropped, none is
// invented, none is named in this code. A window holds what its participant sent ('out') and what reached it ('in'):
//   - `to` given: the message reaches exactly the participants it names.
//   - no `to` (an AI message): a compatibility broadcast. It is shown in every other participant's window, never the
//     sender's twice, as the same event (no record is made or copied), marked `broadcast`. This is a way of showing
//     the record, not evidence that anything was delivered.
//   - ESCALATION goes to the Human (the 需要你 strip): only its sender's window shows it, never into any other.
//   - SYSTEM lines appear in all windows alike.
// `seq` is the event's place in the record (1-based).
export function conversationOf(room) {
  const { events, identity } = room;
  if (identity !== 'IDENTIFIED' && identity !== 'LEGACY') return null;
  const byId = identity === 'IDENTIFIED';
  const keyOf = (event) => (byId ? event.actorId : event.actor);
  const order = [];
  const add = (key) => { if (!order.includes(key)) order.push(key); };
  for (const event of events) if (event.type !== 'SYSTEM') [keyOf(event), ...(event.to ?? [])].forEach(add);
  if (byId) room.participants.forEach((entry) => add(entry.id));
  const nameOf = new Map(byId ? room.participants.map((entry) => [entry.id, entry.name]) : order.map((name) => [name, name]));
  const seq = new Map(events.map((event, index) => [event.id, index + 1]));
  return Object.freeze(order.map((key) => {
    const role = events.find((event) => event.type !== 'SYSTEM' && keyOf(event) === key)?.role;
    const partners = [];
    const items = [];
    const meet = (other) => { if (other !== key && !partners.includes(other)) partners.push(other); };
    for (const event of events) {
      const at = seq.get(event.id);
      if (event.type === 'SYSTEM') items.push(Object.freeze({ seq: at, side: 'system', event }));
      else if (keyOf(event) === key) {
        items.push(Object.freeze({ seq: at, side: 'out', event }));
        (event.to ?? (event.type === 'ESCALATION' ? [] : order)).forEach(meet);
      } else if (event.type === 'ESCALATION') continue;
      else if (!event.to) { items.push(Object.freeze({ seq: at, side: 'in', broadcast: true, event })); meet(keyOf(event)); }
      else if (event.to.includes(key)) { items.push(Object.freeze({ seq: at, side: 'in', event })); meet(keyOf(event)); }
    }
    return Object.freeze({ key, actor: nameOf.get(key), ...(byId ? { actorId: key } : {}), ...(role ? { role } : {}),
      partners: Object.freeze(partners), items: Object.freeze(items) });
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
// Compatibility broadcast wording (UI-C1-C1): it says the record named no addressee and that the window shows the
// message anyway; it never says the message was delivered. `給` names who the record says a message was addressed to.
export const BROADCAST_SENT = '未指定收件者 · 相容顯示給其他參與者';
export const BROADCAST_SHOWN = '未指定收件者 · 相容顯示，不代表已送達';
const sentTo = (event, label) => (event.type === 'ESCALATION' ? '給 你' : event.to ? `給 ${names(event.to.map(label))}` : BROADCAST_SENT);
const TYPING = '<li class="cm-typing" aria-hidden="true"><span class="ty-n"></span><span class="ty-d"><i></i><i></i><i></i></span></li>';
const plain = (key) => key;

/**
 * How a participant is written: its name, plus its ID when another directory participant has the same name, so two
 * participants are never shown as one. In a LEGACY room the key is the name.
 */
export function labelsOf(room) {
  if (room.identity !== 'IDENTIFIED') return plain;
  const count = new Map();
  for (const entry of room.participants) count.set(entry.name, (count.get(entry.name) ?? 0) + 1);
  const label = new Map(room.participants.map((entry) => [entry.id, count.get(entry.name) > 1 ? `${entry.name} · ${entry.id}` : entry.name]));
  return (key) => label.get(key) ?? key;
}

/** One message as its window shows it: sent (right) or received (left, under the sender's name). */
export function messageHTML(item, chat, label = plain) {
  const { event, seq, side } = item;
  const at = `data-seq="${seq}" data-id="${esc(event.id)}"`;
  if (side === 'system') return `<li class="cm-sys" ${at}>${para(event.body)} · ${when(event.timestamp)}</li>`;
  const kind = `t-${event.type.toLowerCase()}`;
  const body = `<div class="bub">${para(event.body)}${attachmentsHTML(event.evidence)}</div>`;
  if (side === 'out') return `<li class="cm cm-out ${kind}" ${at}>${body}<p class="cm-m">${tag(event)} · ${sentTo(event, label)} · ${when(event.timestamp)}</p></li>`;
  const from = esc(label(event.actorId ?? event.actor));
  if (item.broadcast) {
    return `<li class="cm cm-in cm-bc ${kind}" ${at}><p class="cm-from">${from}</p>${body}
    <p class="cm-m">${tag(event)} · ${BROADCAST_SHOWN} · ${when(event.timestamp)}</p></li>`;
  }
  const also = event.to.filter((key) => key !== chat.key).map(label);
  return `<li class="cm cm-in ${kind}" ${at}><p class="cm-from">${from}</p>${body}
    <p class="cm-m">${tag(event)}${also.length ? ` · 也給 ${names(also)}` : ''} · ${when(event.timestamp)}</p></li>`;
}

// MIXED / NO_DIRECTORY: the record in order, each message under the name and ID (if any) it carries, with no window,
// no addressee and no guess about who is who. Read-only like the rest of the room.
const UNSORTED = Object.freeze({
  MIXED: '這個協作室同時有附身分代號和沒有身分代號的紀錄，無法確定誰是誰。',
  NO_DIRECTORY: '這些紀錄附有身分代號，但沒有可用的參與者名冊，無法確認誰是誰。',
});
function recordHTML(room) {
  const items = room.events.map((event, index) => {
    const at = `data-seq="${index + 1}" data-id="${esc(event.id)}"`;
    if (event.type === 'SYSTEM') return `<li class="cm-sys" ${at}>${para(event.body)} · ${when(event.timestamp)}</li>`;
    return `<li class="cm cm-in t-${event.type.toLowerCase()}" ${at}><p class="cm-from">${esc(event.actor)} · ${event.actorId ? esc(event.actorId) : '沒有身分代號'}</p>
      <div class="bub">${para(event.body)}${attachmentsHTML(event.evidence)}</div><p class="cm-m">${tag(event)} · ${when(event.timestamp)}</p></li>`;
  }).join('');
  return `<p class="c-warn" role="note">${UNSORTED[room.identity]}以下依時間列出原始紀錄：不分對話視窗，也不推算收件者。</p>
    <div class="conv" data-key="${esc(room.projectId)}" data-max="${room.events.length}"><div class="chats" data-n="1" data-active="1">
      <section class="cw" id="cw-1" data-w="1" data-p="" aria-label="原始紀錄"><header class="cw-h"><b class="cw-n">原始紀錄</b><span class="cw-r">未分視窗 · 不推算收件者</span></header>
      <ol class="cw-log">${items}</ol></section></div></div>`;
}
const LEGACY_NOTE = '<p class="c-note" role="note">這些是沒有參與者身分代號的舊紀錄：參與者以顯示名稱區分，同名的會被當成同一位。</p>';

/**
 * 協作室 as conversations (UI-C1): one chat window per participant, side by side when the room is wide, one at a time
 * behind name tabs when it is narrow. Every message carries data-seq (its place in the record, for a demo replay) and
 * data-id (its event, for new-message dots); the markup itself always holds the whole record. Only a replay room
 * (`replay`) carries the replay bar, the typing row and data-replay="1"; any other room is a plain record and claims
 * nothing about what is happening now. A room whose participants cannot be told apart shows the record instead.
 */
export function conversationHTML(room, { replay = false } = {}) {
  if (!room.events.length) return EMPTY_ROOM;
  const chats = conversationOf(room);
  if (!chats) return recordHTML(room);
  const label = labelsOf(room);
  const windows = chats.map((chat, index) => `<section class="cw" id="cw-${index + 1}" data-w="${index + 1}" data-p="${esc(chat.key)}" aria-label="${esc(label(chat.key))} 的對話">
      <header class="cw-h"><b class="cw-n">${esc(label(chat.key))}</b><span class="cw-r">${chat.role ? `${esc(chat.role)} · ` : ''}${chat.partners.length ? `和 ${names(chat.partners.map(label))} 對話` : '還沒有對話對象'}</span></header>
      <ol class="cw-log">${chat.items.map((item) => messageHTML(item, chat, label)).join('')}${replay ? TYPING : ''}</ol></section>`).join('');
  const tabs = chats.map((chat, index) => `<button type="button" role="tab" data-cw="${index + 1}" data-p="${esc(chat.key)}" aria-controls="cw-${index + 1}" aria-selected="${index === 0}">${esc(label(chat.key))}<span class="cw-dot" aria-hidden="true"></span></button>`).join('');
  const bar = replay ? `<div class="cv-bar"><span class="cv-k">示範重播</span><span class="cv-p num"></span>
      <button class="btn quiet" type="button" data-replay="restart">從頭播放</button><button class="btn quiet" type="button" data-replay="all">全部顯示</button></div>` : '';
  return `${room.identity === 'LEGACY' ? LEGACY_NOTE : ''}<div class="conv" data-key="${esc(room.projectId)}" data-max="${room.events.length}"${replay ? ' data-replay="1"' : ''}>${bar}
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
 * from any other source is never replayed (nor is a room whose participants cannot be told apart: it has no windows).
 */
export function roomHTML(room, { demo = false, replay = false } = {}) {
  const isDemo = demo || room.provenance === 'DEMO_SAMPLE';
  const left = `${room.rejected ? `<p class="c-left">有 <span class="num">${room.rejected}</span> 則事件格式不正確，沒有顯示。</p>` : ''}${
    room.unverified ? `<p class="c-left">有 <span class="num">${room.unverified}</span> 則事件的參與者身分無法確認，沒有顯示。</p>` : ''}`;
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
