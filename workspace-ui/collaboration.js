// 協作室 (WS-P1, WS-P2): the projection of observable AI-to-AI collaboration events, and how the Workspace shows them.
// Pure: no DOM, no storage, no network, no imports (tested directly in test-workspace-ui.mjs).
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
// The summary and the discussion's structure are derived here, deterministically, from the events alone. No model
// writes them.
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

// ---------- the discussion read as exchanges (derived, deterministic)
// A PROPOSAL, HANDOFF, CHALLENGE or ESCALATION opens an exchange, and so does a change of goal; the events after it
// (questions, responses, evidence, agreements) belong to it until the next opener. A SYSTEM event stands alone. The
// grouping follows order and type only; it does not claim that a reply answers its opener. An outcome is stated only
// when the record shows it:
//   CHALLENGE  → settled when its author later agrees within the same goal (the summary's rule), else still open;
//   ESCALATION → waits for the Human (no decision backend exists, so it never closes here);
//   otherwise  → agreed when someone other than the opener agrees inside the exchange, else no outcome at all.
const OPENERS = new Set(['PROPOSAL', 'HANDOFF', 'CHALLENGE', 'ESCALATION']);
export function exchangesOf(events, summary) {
  const items = [];
  let current = null;
  for (const event of events) {
    if (event.type === 'SYSTEM') { items.push({ kind: 'system', event }); current = null; continue; }
    if (!current || OPENERS.has(event.type) || event.goalId !== current.opener.goalId) {
      current = { kind: 'exchange', opener: event, replies: [] };
      items.push(current);
    } else {
      current.replies.push(event);
    }
  }
  const open = new Set(summary.disagreements.map((event) => event.id));
  return Object.freeze(items.map((item) => {
    if (item.kind === 'system') return Object.freeze(item);
    const { opener, replies } = item;
    let outcome = null;
    if (opener.type === 'ESCALATION') outcome = { kind: 'human' };
    else if (opener.type === 'CHALLENGE') {
      const after = events.slice(events.indexOf(opener) + 1);
      const settledBy = after.find((later) => later.type === 'AGREEMENT' && later.actor === opener.actor && later.goalId === opener.goalId);
      outcome = open.has(opener.id) || !settledBy ? { kind: 'open' } : { kind: 'agreed', by: settledBy };
    } else {
      const agreed = replies.filter((reply) => reply.type === 'AGREEMENT' && reply.actor !== opener.actor).at(-1);
      if (agreed) outcome = { kind: 'agreed', by: agreed };
    }
    return Object.freeze({ kind: 'exchange', opener, replies: Object.freeze(replies), outcome: outcome && Object.freeze(outcome) });
  }));
}

/** Who took part, from the record: role, how many things they said or did, and when last. Not a live state. */
export function participantsOf(events) {
  const people = new Map();
  for (const event of events) {
    if (event.type === 'SYSTEM') continue;
    const known = people.get(event.actor) ?? { actor: event.actor, role: event.role, count: 0, last: event.timestamp };
    known.count += 1;
    known.last = event.timestamp;
    people.set(event.actor, known);
  }
  return Object.freeze([...people.values()].map((person) => Object.freeze(person)));
}

// ---------- presentation (HTML strings; the page's strict content security policy allows no inline style)
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const para = (value) => esc(value).replace(/\n/g, '<br>');
const valid = (iso) => !Number.isNaN(new Date(iso).getTime());
const clock = (iso) => (valid(iso) ? new Date(iso).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false }) : '');
const stamp = (iso) => (valid(iso) ? new Date(iso).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '');
const when = (iso) => `<time class="num" datetime="${esc(iso)}" title="${esc(stamp(iso))}">${clock(iso)}</time>`;
const who = (event) => `${esc(event.actor)}${event.role ? ` · ${esc(event.role)}` : ''}`;

/** The reusable evidence block: file, tests, commit. Display only; it hangs off the event that attached it. */
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

const systemLine = (event) => `<span class="ev-sl"><span class="ev-t">${TYPE_LABEL.SYSTEM}</span>${para(event.body)} · ${when(event.timestamp)}</span>`;

/** One event. `lead` marks the event that opens an exchange. */
export function eventHTML(event, { lead = false } = {}) {
  if (event.type === 'SYSTEM') return `<li class="ev ev-sys" data-type="SYSTEM">${systemLine(event)}</li>`;
  return `<li class="ev t-${event.type.toLowerCase()}${lead ? ' lead' : ''}" data-type="${event.type}"><span class="ev-n" aria-hidden="true"></span>
    <article class="ev-b" aria-label="${esc(event.actor)}，${TYPE_LABEL[event.type]}">
      <header class="ev-h"><span class="ev-t">${TYPE_LABEL[event.type]}</span><b class="ev-a">${esc(event.actor)}</b><span class="ev-m">${event.role ? `${esc(event.role)} · ` : ''}${when(event.timestamp)}</span></header>
      <p class="ev-x">${para(event.body)}</p>${evidenceHTML(event.evidence)}</article></li>`;
}

function outcomeHTML(outcome, hrefs) {
  if (!outcome) return '';
  if (outcome.kind === 'human') {
    return `<p class="xg-out o-human"><span class="xg-k">需要你決定</span><a href="${esc(hrefs.needs)}" data-act="room-tab" data-v="needs">在「需要你」查看</a></p>`;
  }
  if (outcome.kind === 'open') return '<p class="xg-out o-open"><span class="xg-k">仍有分歧</span><span>提出質疑的一方還沒有同意</span></p>';
  return `<p class="xg-out o-agreed"><span class="xg-k">已同意</span><span>${who(outcome.by)} · ${when(outcome.by.timestamp)}</span></p>`;
}

/** AI 討論: who took part, then the exchanges, oldest first. */
export function discussionHTML(room, { hrefs }) {
  if (!room.events.length) return EMPTY_ROOM;
  const people = participantsOf(room.events);
  const items = exchangesOf(room.events, room.summary).map((item) => {
    if (item.kind === 'system') return `<li class="xg-sys" data-type="SYSTEM">${systemLine(item.event)}</li>`;
    const events = [eventHTML(item.opener, { lead: true }), ...item.replies.map((reply) => eventHTML(reply))].join('');
    return `<li class="xg x-${item.opener.type.toLowerCase()}${item.outcome ? ` o-${item.outcome.kind}` : ''}"><ol class="evs">${events}</ol>${outcomeHTML(item.outcome, hrefs)}</li>`;
  }).join('');
  return `<ul class="who" aria-label="參與的 AI">${people.map((person) => `<li><b>${esc(person.actor)}</b>${person.role ? `<span class="who-r">${esc(person.role)}</span>` : ''}<span class="who-c"><span class="num">${person.count}</span> 則 · 最後 ${when(person.last)}</span></li>`).join('')}</ul>
    <ol class="xgs">${items}</ol>`;
}

export function summaryHTML(summary) {
  const people = summary.activeParticipants;
  const need = summary.needsHuman.length;
  const fact = (label, count, extra = '', cls = '') => `<div class="cs-i${cls}"><dt>${label}</dt><dd><span class="cn num">${count}</span>${extra}</dd></div>`;
  const list = (events) => `<ul class="bul">${events.map((event) => `<li>${para(event.body)}<span class="bul-by">${who(event)}</span></li>`).join('')}</ul>`;
  return `<section class="csum" aria-labelledby="csum-h"><h2 class="lbl" id="csum-h">AI 協作摘要</h2>
    <dl class="cs-f">
      ${fact('參與的 AI', people.length, people.length ? `<span class="cs-who">${people.map((p) => `${esc(p.actor)}${p.role ? `（${esc(p.role)}）` : ''}`).join('、')}</span>` : '')}
      ${fact('尚未解決的分歧', summary.disagreements.length, '', summary.disagreements.length ? ' open' : '')}
      ${fact('需要你決定', need, '', need ? ' need' : '')}
      ${fact('已記錄的共識', summary.consensus.length)}
    </dl>
    ${summary.consensus.length || summary.disagreements.length ? `<div class="cs-l">
      ${summary.consensus.length ? `<div><h3 class="lbl">已記錄的共識</h3>${list(summary.consensus)}</div>` : ''}
      ${summary.disagreements.length ? `<div><h3 class="lbl">尚未解決的分歧</h3>${list(summary.disagreements)}</div>` : ''}</div>` : ''}</section>`;
}

/** 需要你: each open escalation shown, never answered; the only action opens a read-only explanation. */
export function needsHTML(summary) {
  const items = summary.needsHuman.map((event) => `<li class="nr-i"><p class="nr-q">${para(event.body)}</p>
      <p class="nr-m">${who(event)} · ${when(event.timestamp)} 提出</p>${evidenceHTML(event.evidence)}
      <button class="btn gold" type="button" data-act="decision" data-v="${esc(event.id)}">查看決策</button></li>`).join('');
  return `<h2 class="nr-h" id="needs-h" tabindex="-1">需要你 <span class="num">${summary.needsHuman.length}</span></h2>
    ${items ? `<ul class="nr">${items}</ul>` : NEEDS_EMPTY}`;
}

export const EMPTY_ROOM = `<div class="c-empty"><h3 class="ce-h">目前沒有 AI 協作紀錄</h3><p>這個專案尚未開始執行，<br>或目前沒有可顯示的協作事件。</p></div>`;
export const NEEDS_EMPTY = '<div class="nr-empty"><p>目前沒有需要你決定的事。</p><p>AI 之間無法自行決定的事，會出現在這裡。</p></div>';
const DEMO_TAG = '<p class="demo-tag" role="note"><b>示範資料</b><span>這些不是真的 AI 協作紀錄，只用來展示協作室的樣子。</span></p>';

/**
 * The room body: demo label, the summary (when there is a record), then two areas, AI 討論 and 需要你. Wide: side by
 * side. Narrow: one at a time behind [ 討論 ] [ 需要你 ], each its own address (`hrefs`), chosen by `area`.
 */
export function roomHTML(room, { demo = false, area = 'discussion', hrefs = { discussion: '', needs: '' } } = {}) {
  const tag = demo || room.provenance === 'DEMO_SAMPLE' ? DEMO_TAG : '';
  const left = room.rejected ? `<p class="c-left">有 <span class="num">${room.rejected}</span> 則事件格式不正確，沒有顯示。</p>` : '';
  const need = room.summary.needsHuman.length;
  const tab = (id, label, extra) => `<a href="${esc(hrefs[id])}" data-act="room-tab" data-v="${id}" ${area === id ? 'aria-current="page"' : ''}>${label}${extra}</a>`;
  return `${tag}${room.events.length ? summaryHTML(room.summary) : ''}
    <div class="room-body"><nav class="rtabs" aria-label="協作室的區塊"><div class="mt">${tab('discussion', '討論', ` <span class="tn num">${room.events.length}</span>`)}${tab('needs', '需要你', ` <span class="tn num">${need}</span>${need ? '<span class="tneed" aria-hidden="true"></span>' : ''}`)}</div></nav>
      <div class="rg" data-area="${area === 'needs' ? 'needs' : 'discussion'}">
        <section class="disc" aria-labelledby="disc-h"><h2 class="lbl disc-h" id="disc-h" tabindex="-1">AI 討論 <span class="num">${room.events.length}</span></h2>${discussionHTML(room, { hrefs })}</section>
        <aside class="nrail${need ? ' has-need' : ''}" aria-labelledby="needs-h">${needsHTML(room.summary)}</aside>
      </div></div>${left}`;
}

/** The read-only 查看決策 sheet body. There is no option, answer, approval or record: the backend does not exist. */
export function decisionHTML(event, { demo = false } = {}) {
  return `${demo ? DEMO_TAG : ''}<section><p class="lbl">要決定的事</p><p class="dec-q">${para(event.body)}</p>
      <p class="dec-m">${who(event)} · ${esc(stamp(event.timestamp))} 提出</p>${evidenceHTML(event.evidence)}</section>
    <section class="dec-na"><p>這個版本還沒有人類決策功能。你可以在這裡看清楚問題，但 Workspace 不能在這裡做決定，也不會記錄任何決定或授權。</p></section>`;
}
