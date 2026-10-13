// 協作室 conversation windows (UI-C1): which window is in front on a narrow screen, and the demo-only replay.
// The replay runs only in a room marked data-replay="1", which collaboration.js gives only to demo-labelled data on the
// demo page. It reveals the record in order: the receivers see "<sender> 正在輸入", the message lands in the sender's
// window and, a moment later, in each receiver's window. It never runs on LIVE data and never claims that anything is
// happening now. Any other room is a plain record: everything in it is shown, including events that arrive later.
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

const S = { key: null, replay: false, replaying: false, max: 0, sent: 0, delivered: 0, typing: 0, timer: null, active: '1', unread: new Set(), shown: new Set() };
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

function apply() {
  const root = conv();
  if (!root) return;
  root.querySelector('.chats').dataset.active = S.active;
  for (const tab of root.querySelectorAll('[data-cw]')) tab.setAttribute('aria-selected', String(tab.dataset.cw === S.active));
  const wide = getComputedStyle(root.querySelector('.cw-tabs')).display === 'none';
  for (const win of root.querySelectorAll('.cw')) {
    let landed = false;
    for (const item of win.querySelectorAll('[data-seq]')) {
      const seq = Number(item.dataset.seq);
      const side = item.classList.contains('cm-in') ? 'in' : 'out';
      const visible = revealed(seq, side, S);
      item.classList.toggle('cm-off', !visible);
      item.classList.remove('cm-new');
      const id = `${win.dataset.w}:${seq}:${side}`;
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
      if (landed && !wide && win.dataset.w !== S.active) S.unread.add(win.dataset.w);
    }
  }
  for (const tab of root.querySelectorAll('[data-cw]')) tab.classList.toggle('cw-unread', S.unread.has(tab.dataset.cw));
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
  document.addEventListener('click', (event) => {
    if (!conv()) return;
    const tab = event.target.closest('[data-cw]');
    if (tab) { S.active = tab.dataset.cw; S.unread.delete(S.active); apply(); return; }
    const control = event.target.closest('[data-replay]');
    if (!control || !S.replay) return;
    stop();
    if (control.dataset.replay === 'restart') { S.sent = S.delivered = 0; S.shown.clear(); S.replaying = true; apply(); later(400, step); }
    else { S.sent = S.delivered = S.max; S.replaying = false; S.unread.clear(); apply(); }
  });
}

/** Called after every render of the page. */
export function attachConversation() {
  listen();
  const root = conv();
  if (!root) { if (S.key !== null) { stop(); S.key = null; } return; }
  const replay = root.dataset.replay === '1';
  const key = `${replay ? 'replay' : 'record'}:${root.dataset.key}`;
  const max = Number(root.dataset.max);
  if (key !== S.key) {
    stop();
    Object.assign(S, { key, replay, max, active: '1' }, replayStart({ replay, max, reducedMotion: reduced() }));
    S.unread.clear(); S.shown.clear();
    if (S.replaying) later(600, step);
  }
  S.max = max;
  if (!replay) S.sent = S.delivered = max; // a record is always shown whole, including events that arrived since the last render
  apply();
  for (const log of root.querySelectorAll('.cw-log')) log.scrollTop = log.scrollHeight;
}
