// 協作室 conversation windows (UI-C1, UI-C1-C1): which window is in front on a narrow screen, the demo-only replay, and
// the dots for messages that arrive while a record room is open.
// The replay runs only in a room marked data-replay="1", which collaboration.js gives only to demo-labelled data on the
// demo page. It reveals the record in order: the receivers see "<sender> 正在輸入", the message lands in the sender's
// window and, a moment later, in each receiver's window. It never runs on LIVE data and never claims that anything is
// happening now. Any other room is a plain record: everything in it is shown, including events that arrive later.
// While a record room stays open, a message that was not in it before lands with a dot on its window's tab (narrow
// screens); what the room held when it was opened is history and never gets one. Windows are followed by participant
// (data-p), not by position, and opening a window clears that window's dot only.
// No network, no storage, no imports; the DOM is touched only after attachConversation() is called.

const TYPE_MS = 1100;
const DELIVER_MS = 450;
const PAUSE_MS = 900;

/** Where a room starts: only a replay room (and not under reduced motion) starts empty; any other shows its whole record. */
export function replayStart({ replay, max, reducedMotion }) {
  const play = Boolean(replay) && !reducedMotion;
  return { replaying: play, sent: play ? 0 : max, delivered: play ? 0 : max };
}
/** Whether a message is shown yet: in its sender's window once sent, in a receiver's window once delivered. */
export const revealed = (seq, side, state) => seq <= (side === 'in' ? state.delivered : state.sent);
/**
 * A record room's new messages. `seen` is null when the room has just been opened: everything in it then is history
 * and nothing is new. Afterwards a (window, event) pair not seen before is new, and its window is unread unless it is
 * the window in front or every window is in view (wide). Pure; items are { w: participant, id: event id }.
 */
export function arrivals(seen, items, { active, wide, visible }) {
  const pair = (item) => `${item.w}\n${item.id}`;
  if (!seen) return { seen: new Set(items.map(pair)), fresh: [], unread: [] };
  const fresh = items.filter((item) => !seen.has(pair(item)));
  const unread = visible ? [...new Set(fresh.map((item) => item.w))].filter((w) => !visible.includes(w))
    : wide ? [] : [...new Set(fresh.map((item) => item.w))].filter((w) => w !== active);
  return { seen: new Set([...seen, ...fresh.map(pair)]), fresh, unread };
}
/** Opening one participant's window clears that window's dot and no other. */
export const opened = (unread, w) => new Set([...unread].filter((key) => key !== w));

/** Choose at most two real participants; narrow screens always show one. No participant is discarded. */
export function readerWindows(keys, { active, secondary, layout, wide }) {
  const first = keys.includes(active) ? active : keys[0];
  if (first === undefined) return [];
  if (!wide || layout === 'focus' || keys.length === 1) return [first];
  const second = secondary !== first && keys.includes(secondary) ? secondary : keys.find((key) => key !== first);
  return [first, second];
}

const S = { key: null, replay: false, replaying: false, max: 0, sent: 0, delivered: 0, typing: 0, timer: null, active: null, secondary: null, layout: 'split', unread: new Set(), shown: new Set(), seen: null };
let observer;
let positions = new Map();
const conv = () => document.querySelector('.conv');
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function stop() { clearTimeout(S.timer); S.timer = null; S.typing = 0; }
function later(ms, fn) { S.timer = setTimeout(fn, ms); }

function step() {
  const root = conv();
  if (!root || !S.replay || S.sent >= S.max) { stop(); S.replaying = false; apply(); return; }
  const next = S.sent + 1;
  const isSystem = !root.querySelector(`.cm[data-seq="${next}"]`);
  S.typing = isSystem ? 0 : next;
  apply();
  later(isSystem ? 300 : TYPE_MS, () => {
    S.typing = 0; S.sent = next; apply();
    later(DELIVER_MS, () => { S.delivered = next; apply(); later(PAUSE_MS, step); });
  });
}

// The window in front: the participant last opened, or the first window when that participant has none here.
function front(root) {
  const windows = [...root.querySelectorAll('.cw')];
  if (!windows.some((win) => win.dataset.p === S.active)) S.active = windows[0]?.dataset.p ?? null;
  return windows.find((win) => win.dataset.p === S.active);
}
function panels(root) {
  front(root);
  const windows = [...root.querySelectorAll('.cw')];
  const wide = root.clientWidth >= 820;
  const visible = readerWindows(windows.map((win) => win.dataset.p), { ...S, wide });
  root.dataset.layout = visible.length > 1 ? 'split' : 'focus';
  for (const win of windows) {
    const log = win.querySelector('.cw-log');
    const wasHidden = win.hidden;
    if (!wasHidden) positions.set(win.dataset.p, log.scrollTop);
    win.hidden = !visible.includes(win.dataset.p);
    if (wasHidden && !win.hidden) log.scrollTop = positions.get(win.dataset.p) ?? 0;
    const button = win.querySelector('[data-focus]');
    if (button) {
      button.hidden = !wide;
      const focused = S.layout === 'focus' && win.dataset.p === S.active;
      button.title = focused ? '還原雙欄' : '最大化此視窗';
      button.setAttribute('aria-label', `${focused ? '還原雙欄' : '最大化'} ${win.querySelector('.cw-n').textContent}`);
      button.setAttribute('aria-pressed', String(focused));
      button.firstElementChild.toggleAttribute('hidden', focused);
      button.querySelector('.reader-restore').hidden = !focused;
    }
  }
  for (const tab of root.querySelectorAll('[data-cw]')) tab.setAttribute('aria-pressed', String(visible.includes(tab.dataset.p)));
  for (const button of root.querySelectorAll('[data-reader-layout]')) {
    button.setAttribute('aria-pressed', String(button.dataset.readerLayout === root.dataset.layout));
    button.disabled = button.dataset.readerLayout === 'split' && !wide;
  }
  for (const key of visible) S.unread.delete(key);
  return visible;
}

function apply() {
  const root = conv();
  if (!root) return;
  root.querySelector('.chats').dataset.active = front(root)?.dataset.w ?? '1';
  const visibleWindows = panels(root);
  for (const win of S.replay ? root.querySelectorAll('.cw') : []) {
    let landed = false;
    for (const item of win.querySelectorAll('[data-seq]')) {
      const seq = Number(item.dataset.seq);
      const side = item.classList.contains('cm-in') ? 'in' : 'out';
      const visible = revealed(seq, side, S);
      item.classList.toggle('cm-off', !visible);
      item.classList.remove('cm-new');
      const id = `${win.dataset.p}\n${item.dataset.id}`;
      if (visible && !S.shown.has(id)) {
        S.shown.add(id);
        if (S.replaying) { item.classList.add('cm-new'); landed = true; }
      }
    }
    const typing = win.querySelector('.cm-typing');
    const from = S.typing ? root.querySelector(`.cm-out[data-seq="${S.typing}"]`)?.closest('.cw') : null;
    const receives = Boolean(S.typing && from && from !== win && win.querySelector(`.cm-in[data-seq="${S.typing}"]`));
    if (typing) {
      typing.classList.toggle('ty-on', receives);
      if (receives) typing.querySelector('.ty-n').textContent = `${from.querySelector('.cw-n').textContent} 正在輸入`;
    }
    if (landed || receives) {
      const log = win.querySelector('.cw-log');
      log.scrollTo({ top: log.scrollHeight, behavior: reduced() ? 'auto' : 'smooth' });
      if (landed && !visibleWindows.includes(win.dataset.p)) S.unread.add(win.dataset.p);
    }
  }
  for (const tab of root.querySelectorAll('[data-cw]')) tab.classList.toggle('cw-unread', S.unread.has(tab.dataset.p));
  if (!S.replay) return;
  const progress = root.querySelector('.cv-p');
  if (progress) progress.textContent = S.sent >= S.max ? `共 ${S.max} 則` : `第 ${S.sent} / ${S.max} 則`;
  // The 需要你 strip follows the replay: an escalation appears there once it has been sent.
  const strip = document.querySelector('.nstrip');
  if (!strip) return;
  const waiting = [...strip.querySelectorAll('.nr-i[data-seq]')];
  for (const item of waiting) item.hidden = !revealed(Number(item.dataset.seq), 'out', S);
  const open = waiting.filter((item) => !item.hidden).length;
  strip.classList.toggle('has-need', open > 0);
  strip.querySelector('.nr-c').textContent = String(open);
  strip.querySelector('.nr-empty').hidden = open > 0;
}

let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  document.addEventListener('keydown', (event) => {
    const tab = event.target.closest?.('[data-cw]');
    if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...conv().querySelectorAll('[data-cw]')];
    const index = buttons.indexOf(tab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    event.preventDefault(); buttons[next].click(); buttons[next].focus();
  });
  document.addEventListener('click', (event) => {
    if (!conv()) return;
    const tab = event.target.closest('[data-cw]');
    if (tab) {
      if (tab.dataset.p === S.secondary || !S.secondary) S.secondary = S.active;
      S.active = tab.dataset.p; S.unread = opened(S.unread, S.active); apply(); return;
    }
    const layout = event.target.closest('[data-reader-layout]');
    if (layout && !layout.disabled) { S.layout = layout.dataset.readerLayout; apply(); return; }
    const focus = event.target.closest('[data-focus]');
    if (focus) {
      S.layout = S.layout === 'focus' && S.active === focus.dataset.focus ? 'split' : 'focus';
      if (focus.dataset.focus !== S.active) S.secondary = S.active;
      S.active = focus.dataset.focus; apply(); return;
    }
    const control = event.target.closest('[data-replay]');
    if (!control || !S.replay) return;
    stop();
    if (control.dataset.replay === 'restart') { S.sent = S.delivered = 0; S.shown.clear(); S.replaying = true; apply(); later(400, step); }
    else { S.sent = S.delivered = S.max; S.replaying = false; S.unread.clear(); apply(); }
  });
}

/** Capture before app replaces the DOM; restore per participant, never force a reader to the latest message. */
export function captureConversation() {
  const root = conv();
  if (!root) return null;
  return { key: root.dataset.key,
    logs: [...root.querySelectorAll('.cw')].map((win) => {
      const log = win.querySelector('.cw-log');
      return { key: win.dataset.p, top: win.hidden ? positions.get(win.dataset.p) ?? 0 : log.scrollTop,
        atEnd: !win.hidden && log.scrollHeight - log.scrollTop - log.clientHeight < 48,
        open: [...win.querySelectorAll('.observation[open]')].map((details) => details.closest('[data-id]').dataset.id) };
    }), infoOpen: Boolean(root.closest('.room')?.querySelector('.room-info')?.open) };
}

/** Called after every render of the page. */
export function attachConversation(reading = null) {
  listen();
  observer?.disconnect();
  const root = conv();
  if (!root) { if (S.key !== null) { stop(); S.key = null; } return; }
  const replay = root.dataset.replay === '1';
  const key = `${replay ? 'replay' : 'record'}:${root.dataset.key}`;
  const max = Number(root.dataset.max);
  if (key !== S.key) {
    stop();
    Object.assign(S, { key, replay, max, active: null, secondary: null, layout: 'split', seen: null }, replayStart({ replay, max, reducedMotion: reduced() }));
    S.unread.clear(); S.shown.clear();
    positions = new Map();
    if (S.replaying) later(600, step);
  }
  S.max = max;
  if (!replay) {
    S.sent = S.delivered = max; // a record is always shown whole, including events that arrived since the last render
    const items = [...root.querySelectorAll('.cw [data-id]')].map((item) => ({ w: item.closest('.cw').dataset.p, id: item.dataset.id, item }));
    const now = arrivals(S.seen, items, { active: front(root)?.dataset.p ?? null, visible: panels(root) });
    S.seen = now.seen;
    for (const w of now.unread) S.unread.add(w);
    for (const { item } of now.fresh) item.classList.add('cm-new');
  }
  apply();
  if (reading?.key === root.dataset.key) {
    const info = root.closest('.room')?.querySelector('.room-info');
    if (info) info.open = reading.infoOpen;
    for (const win of root.querySelectorAll('.cw')) {
      const prior = reading.logs.find((entry) => entry.key === win.dataset.p);
      if (!prior) continue;
      for (const details of win.querySelectorAll('.observation')) details.open = prior.open.includes(details.closest('[data-id]').dataset.id);
      const log = win.querySelector('.cw-log');
      log.scrollTop = prior.atEnd ? log.scrollHeight : prior.top;
      positions.set(win.dataset.p, prior.top);
    }
  }
  observer = new ResizeObserver(() => apply());
  observer.observe(root);
}
