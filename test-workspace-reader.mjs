import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { markdownHTML, readerIcon } from './workspace-ui/reader.generated.js';
import { readerWindows, arrivals } from './workspace-ui/conversation.js';
import { collaborationRoom, roomHTML } from './workspace-ui/collaboration.js';
import { API_ROUTES } from './dist/workspace/server.js';
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}: ${e.stack}`); failed++; }
}
check('Markdown headings, emphasis, lists, quotes, fenced code and tables render semantically', () => {
  const html = markdownHTML('# Heading\n\n**Bold** and `code`\n\n- one\n- two\n\n> quote\n\n```js\nconst x = 1;\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |');
  for (const tag of ['h1', 'strong', 'code', 'ul', 'li', 'blockquote', 'pre', 'table', 'th', 'td']) assert.match(html, new RegExp(`<${tag}[ >]`));
});
check('raw HTML, SVG, scripts, event attributes and frame payloads remain escaped text', () => {
  const html = markdownHTML('<script>alert(1)</script>\n<svg onload=alert(1)></svg>\n<img src=x onerror=alert(1)>\n<iframe srcdoc="bad"></iframe>\n<details open ontoggle=alert(1)>x</details>');
  assert.doesNotMatch(html, /<(script|svg|img|iframe|details)\b/);
  assert.match(html, /&lt;script&gt;/);
});
check('javascript, data, file, vbscript, credential-bearing, relative and protocol-relative links are refused', () => {
  for (const href of ['javascript:alert%281%29', 'JaVaScRiPt:alert%281%29', 'data:text/html,bad', 'file:///etc/passwd',
    'vbscript:msgbox%281%29', '//evil.example', '/api/v0/projects', 'https://name:password@example.com', 'java&#x73;cript:alert%281%29']) {
    assert.doesNotMatch(markdownHTML(`[link](${href})`), /<a\b/, href);
  }
});
check('safe HTTP links require a click, open separately and carry no opener or referrer', () => {
  const html = markdownHTML('[docs](https://example.com/docs?q=1&x=2)');
  assert.match(html, /href="https:\/\/example.com\/docs\?q=1&amp;x=2"/);
  assert.match(html, /target="_blank"/); assert.match(html, /rel="noopener noreferrer"/);
});
check('Markdown images never embed remote content; code does not become HTML', () => {
  const html = markdownHTML('![alt](https://tracker.example/pixel)\n\n```html\n<img src=x onerror=alert(1)>\n```');
  assert.doesNotMatch(html, /<img\b|src="https:/);
  assert.match(html, /class="md-image">alt<\/span>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});
check('single-agent, two-column, focused and narrow layouts choose only actual participants', () => {
  const select = (keys, changes = {}) => readerWindows(keys, { active: 'a', secondary: null, layout: 'split', wide: true, ...changes });
  assert.deepEqual(select([]), []); assert.deepEqual(select(['a']), ['a']);
  assert.deepEqual(select(['a', 'b', 'c']), ['a', 'b']);
  assert.deepEqual(select(['a', 'b', 'c'], { active: 'c', secondary: 'b' }), ['c', 'b']);
  assert.deepEqual(select(['a', 'b', 'c'], { active: 'c', layout: 'focus' }), ['c']);
  assert.deepEqual(select(['a', 'b', 'c'], { active: 'c', wide: false }), ['c']);
  assert.deepEqual(select(['a', 'b'], { active: 'missing', secondary: 'missing' }), ['a', 'b']);
});
check('a third hidden participant gets unread on desktop; displayed participants do not', () => {
  const seed = arrivals(null, [{ w: 'a', id: '1' }], { visible: ['a', 'b'] });
  const heard = arrivals(seed.seen, [{ w: 'a', id: '2' }, { w: 'b', id: '2' }, { w: 'c', id: '2' }], { visible: ['a', 'b'] });
  assert.deepEqual(heard.unread, ['c']);
});
check('one agent has no redundant controls; every multi-agent window stays selectable and can maximize', () => {
  const event = { id: 'e1', projectId: 'p', actor: 'A', actorId: 'a', type: 'RESPONSE', body: '**safe**', timestamp: '2026-10-20T00:00:00.000Z' };
  const one = roomHTML(collaborationRoom('p', { participants: [{ id: 'a', name: 'A' }], events: [event] }));
  assert.doesNotMatch(one, /reader-toolbar|data-reader-layout|data-focus=/);
  const many = roomHTML(collaborationRoom('p', { participants: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }], events: [event] }));
  assert.equal((many.match(/data-cw="/g) ?? []).length, 3);
  assert.equal((many.match(/data-focus="/g) ?? []).length, 3);
  assert.match(many, /data-reader-layout="split"/); assert.match(many, /data-reader-layout="focus"/);
  assert.match(many, /<strong>safe<\/strong>/);
});
check('reader uses locally bundled Lucide icons and no executable or external capability', () => {
  for (const name of ['split', 'focus', 'restore']) assert.match(readerIcon(name), /^<svg /);
  const renderer = readFileSync('workspace-ui/reader-source.js', 'utf8');
  assert.match(renderer, /html: false/); assert.match(renderer, /from 'markdown-it'/); assert.match(renderer, /from 'lucide'/);
  assert.doesNotMatch(renderer, /\bfetch\(|XMLHttpRequest|EventSource|eval\(|new Function|localStorage|document\./);
  assert.equal(API_ROUTES.length, 18);
});
check('room body has no outer scroll and no fixed chat height; text is at least 16px at 1.7 line height', () => {
  const app = readFileSync('workspace-ui/app.js', 'utf8');
  const view = app.slice(app.indexOf("} else if (S.pane === 'collaboration')"), app.indexOf('function projectsView'));
  assert.doesNotMatch(view.split('} else {')[0], /room-scroll|class="work"/);
  const css = readFileSync('workspace-ui/styles.css', 'utf8');
  assert.match(css, /\.bub\{[^}]*font-size:16px;line-height:1\.7;letter-spacing:0/);
  assert.doesNotMatch(css, /clamp\(420px/);
  assert.match(readFileSync('workspace-ui/conversation.js', 'utf8'), /export function captureConversation/);
  assert.match(app, /const reading = captureConversation\(\)/);
  assert.match(app, /attachConversation\(reading\)/);
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
