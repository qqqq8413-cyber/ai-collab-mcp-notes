import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorkspaceConfig } from './dist/workspace/config.js';
import { API_ROUTES, HOST, startWorkspaceServer } from './dist/workspace/server.js';

// WS-L1 local Workspace server: loopback only, same-origin mutations, SSE for queue changes.

const UI = join(process.cwd(), 'workspace-ui');
let passed = 0, failed = 0;
async function check(name, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'chief-ws-server-'));
  let ws;
  try {
    const config = parseWorkspaceConfig({ schemaVersion: 1, dataDirectory: join(dir, 'queues'), projects: [
      { projectId: 'cand', displayName: '候選人平台', repository: 'example-org/candidate-platform' },
      { projectId: 'site', displayName: '嶼光官網', repository: 'example-org/site' }] }, dir);
    ws = await startWorkspaceServer({ config, uiDirectory: UI, port: 0 });
    await fn(ws, { dir, config });
    console.log(`  PASS ${name}`); passed++;
  } catch (error) { console.error(`  FAIL ${name}: ${error.stack}`); failed++; }
  finally { if (ws) await ws.close(); rmSync(dir, { recursive: true, force: true }); }
}

function call(ws, method, path, { headers = {}, body, raw } = {}) {
  return new Promise((done, fail) => {
    const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const req = request({ host: HOST, port: ws.port, method, path, headers: { Host: `${HOST}:${ws.port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json; try { json = JSON.parse(text); } catch { json = undefined; }
        done({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', fail);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
// What the Workspace page itself sends.
const page = (ws, extra = {}) => ({ Origin: `http://${HOST}:${ws.port}`, 'X-Chief-Workspace': '1', 'Sec-Fetch-Site': 'same-origin', ...extra });
const add = (ws, text, projectId = 'cand') => call(ws, 'POST', `/api/v0/projects/${projectId}/goals`, { headers: page(ws, { 'Content-Type': 'application/json' }), body: { text } });

function openStream(ws) {
  return new Promise((done, fail) => {
    const events = [];
    const waiters = [];
    const req = request({ host: HOST, port: ws.port, path: '/api/v0/stream', headers: { Host: `${HOST}:${ws.port}`, Accept: 'text/event-stream' } }, (res) => {
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let cut;
        while ((cut = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, cut); buffer = buffer.slice(cut + 2);
          const name = /^event: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (name) { events.push({ name, data: JSON.parse(data) }); waiters.splice(0).forEach((wake) => wake()); }
        }
      });
      done({ status: res.statusCode, type: res.headers['content-type'], events,
        next: async (name) => {
          const deadline = Date.now() + 3000;
          for (;;) {
            const index = events.findIndex((event) => event.name === name);
            if (index !== -1) return events.splice(index, 1)[0].data;
            if (Date.now() > deadline) throw new Error(`no ${name} event`);
            await new Promise((wake) => { waiters.push(wake); setTimeout(wake, 200); });
          }
        },
        close: () => req.destroy() });
    });
    req.on('error', (error) => { if (error.code !== 'ECONNRESET') fail(error); });
    req.end();
  });
}

await check('the server listens on the IPv4 loopback address only', async (ws) => {
  const address = ws.server.address();
  assert.equal(address.address, '127.0.0.1');
  assert.equal(address.family, 'IPv4');
  assert.equal(ws.url, `http://127.0.0.1:${ws.port}/`);
});

await check('projects come from the explicit configuration', async (ws) => {
  const res = await call(ws, 'GET', '/api/v0/projects');
  assert.equal(res.status, 200);
  assert.equal(res.json.provenance, 'LOCAL_CONFIGURATION');
  assert.deepEqual(res.json.projects, [
    { projectId: 'cand', displayName: '候選人平台', repository: 'example-org/candidate-platform', queued: 0 },
    { projectId: 'site', displayName: '嶼光官網', repository: 'example-org/site', queued: 0 }]);
  assert.equal((await call(ws, 'GET', '/api/v0/projects/nope/goals')).status, 404);
});

await check('a goal is created, labelled non-authoritative, and read back', async (ws) => {
  const res = await add(ws, '繼續做候選人平台');
  assert.equal(res.status, 201);
  assert.equal(res.json.goal.text, '繼續做候選人平台');
  assert.equal(res.json.goal.execution, 'NOT_STARTED');
  assert.match(res.json.notice, /Non-authoritative/);
  const read = await call(ws, 'GET', '/api/v0/projects/cand/goals');
  assert.equal(read.json.authority, 'NON_AUTHORITATIVE');
  assert.equal(read.json.provenance, 'LOCAL_OPERATOR_INPUT');
  assert.deepEqual(read.json.goals.map((goal) => goal.text), ['繼續做候選人平台']);
  assert.doesNotMatch(read.text, /runId|changeId|authorizationId|packetId/);
});

await check('goals survive a server restart', async (ws, { config }) => {
  await add(ws, 'one'); await add(ws, 'two');
  await ws.close();
  const again = await startWorkspaceServer({ config, uiDirectory: UI, port: 0 });
  try {
    const read = await call(again, 'GET', '/api/v0/projects/cand/goals');
    assert.deepEqual(read.json.goals.map((goal) => goal.text), ['one', 'two']);
  } finally { await again.close(); }
});

await check('reorder and delete change the queue', async (ws) => {
  const a = (await add(ws, 'a')).json.goal.goalId;
  const b = (await add(ws, 'b')).json.goal.goalId;
  const reordered = await call(ws, 'POST', '/api/v0/projects/cand/goals/order', { headers: page(ws, { 'Content-Type': 'application/json' }), body: { order: [b, a], expectedRevision: 2 } });
  assert.equal(reordered.status, 200);
  assert.deepEqual(reordered.json.order, [b, a]);
  const stale = await call(ws, 'POST', '/api/v0/projects/cand/goals/order', { headers: page(ws, { 'Content-Type': 'application/json' }), body: { order: [a, b], expectedRevision: 2 } });
  assert.equal(stale.status, 409);
  const removed = await call(ws, 'DELETE', `/api/v0/projects/cand/goals/${b}`, { headers: page(ws) });
  assert.equal(removed.status, 200);
  assert.equal((await call(ws, 'DELETE', `/api/v0/projects/cand/goals/${b}`, { headers: page(ws) })).status, 404);
  const read = await call(ws, 'GET', '/api/v0/projects/cand/goals');
  assert.deepEqual(read.json.goals.map((goal) => goal.text), ['a']);
  assert.deepEqual(read.json.history.map((event) => event.kind), ['GOAL_ADDED', 'GOAL_ADDED', 'QUEUE_REORDERED', 'GOAL_REMOVED']);
});

await check('malformed mutations are refused and write nothing', async (ws) => {
  const json = page(ws, { 'Content-Type': 'application/json' });
  const cases = [
    [{ headers: json, raw: '{"text":' }, 400],
    [{ headers: json, raw: '[]' }, 400],
    [{ headers: json, raw: '"text"' }, 400],
    [{ headers: json, body: { text: '' } }, 400],
    [{ headers: json, body: { text: 7 } }, 400],
    [{ headers: json, body: { text: 'x', runId: 'run-1' } }, 400],
    [{ headers: json, body: { text: 'x'.repeat(2001) } }, 400],
    [{ headers: json, raw: JSON.stringify({ text: 'x'.repeat(20_000) }) }, 413],
    [{ headers: page(ws, { 'Content-Type': 'text/plain' }), body: { text: 'x' } }, 415],
    [{ headers: page(ws), body: { text: 'x' } }, 415],
  ];
  for (const [options, status] of cases) {
    const res = await call(ws, 'POST', '/api/v0/projects/cand/goals', options);
    assert.equal(res.status, status, JSON.stringify(options).slice(0, 80));
    assert.ok(res.json?.error?.code, 'every refusal says why');
  }
  const order = await call(ws, 'POST', '/api/v0/projects/cand/goals/order', { headers: json, body: { order: 'all' } });
  assert.equal(order.status, 400);
  assert.equal((await call(ws, 'GET', '/api/v0/projects/cand/goals')).json.revision, 0);
});

await check('requests from other origins, hosts, or without the Workspace header are refused', async (ws) => {
  const body = { text: 'x' };
  const cases = [
    [{ ...page(ws), Origin: 'http://evil.example', 'Content-Type': 'application/json' }, 403, 'WRONG_ORIGIN'],
    [{ 'X-Chief-Workspace': '1', 'Content-Type': 'application/json' }, 403, 'WRONG_ORIGIN'],
    [{ ...page(ws), 'X-Chief-Workspace': undefined, 'Content-Type': 'application/json' }, 403, 'MISSING_HEADER'],
    [{ ...page(ws), 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' }, 403, 'CROSS_SITE'],
    [{ ...page(ws), Host: 'evil.example', 'Content-Type': 'application/json' }, 421, 'WRONG_HOST'],
    [{ ...page(ws), Host: `0.0.0.0:${ws.port}`, 'Content-Type': 'application/json' }, 421, 'WRONG_HOST'],
  ];
  for (const [headers, status, code] of cases) {
    const clean = Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined));
    const res = await call(ws, 'POST', '/api/v0/projects/cand/goals', { headers: clean, body });
    assert.equal(res.status, status, code);
    assert.equal(res.json.error.code, code);
  }
  const rebinding = await call(ws, 'GET', '/api/v0/projects', { headers: { Host: 'attacker.example' } });
  assert.equal(rebinding.status, 421, 'a rebound host name cannot read the queue');
  assert.equal((await add(ws, 'from the 127.0.0.1 page')).status, 201);
  const viaLocalhost = await call(ws, 'POST', '/api/v0/projects/cand/goals', { body,
    headers: { Host: `localhost:${ws.port}`, Origin: `http://localhost:${ws.port}`, 'X-Chief-Workspace': '1', 'Content-Type': 'application/json' } });
  assert.equal(viaLocalhost.status, 201, 'the same page opened as localhost is accepted');
  assert.equal((await call(ws, 'GET', '/api/v0/projects/cand/goals')).json.goals.length, 2);
});

await check('no CORS: no allow-origin header and no preflight', async (ws) => {
  const preflight = await call(ws, 'OPTIONS', '/api/v0/projects/cand/goals', { headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(preflight.status, 405);
  for (const res of [preflight, await call(ws, 'GET', '/api/v0/projects', { headers: { Origin: 'http://evil.example' } }), await add(ws, 'x')]) {
    assert.equal(Object.keys(res.headers).some((name) => name.startsWith('access-control-')), false);
  }
});

await check('there is no route that could start, run, resume, or promote anything', async (ws) => {
  assert.equal(API_ROUTES.some((route) => /start|run|execute|resume|promote|create-run|packet|authoriz/i.test(route)), false);
  for (const path of ['/api/v0/projects/cand/goals/x/start', '/api/v0/projects/cand/start', '/api/v0/run', '/api/v0/execute',
    '/api/v0/projects/cand/goals/x/resume', '/api/v0/promote', '/api/v0/create-run']) {
    const res = await call(ws, 'POST', path, { headers: page(ws, { 'Content-Type': 'application/json' }), body: {} });
    assert.equal(res.status, 404, path);
  }
});

await check('the UI is served from the same origin with a strict content security policy', async (ws) => {
  const res = await call(ws, 'GET', '/', { headers: { 'Sec-Fetch-Site': 'none' } });
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.headers['content-security-policy'], /connect-src 'self'/);
  assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
  for (const path of ['/app.js', '/live.js', '/demo.js', '/collaboration.js', '/styles.css']) assert.equal((await call(ws, 'GET', path)).status, 200, path);
  for (const path of ['/../package.json', '/workspace.example.json', '/dist/workspace/server.js', '/.env']) assert.equal((await call(ws, 'GET', path)).status, 404, path);
});

await check('SSE: hello on connect, then goal.created, queue.reordered, goal.removed', async (ws) => {
  const stream = await openStream(ws);
  try {
    assert.equal(stream.status, 200);
    assert.match(stream.type, /text\/event-stream/);
    const hello = await stream.next('hello');
    assert.deepEqual(hello.revisions, { cand: 0, site: 0 });
    const a = (await add(ws, 'a')).json.goal.goalId;
    const created = await stream.next('goal.created');
    assert.equal(created.projectId, 'cand');
    assert.equal(created.revision, 1);
    assert.equal(created.goal.text, 'a');
    assert.equal(created.goal.execution, 'NOT_STARTED');
    const b = (await add(ws, 'b')).json.goal.goalId;
    await stream.next('goal.created');
    await call(ws, 'POST', '/api/v0/projects/cand/goals/order', { headers: page(ws, { 'Content-Type': 'application/json' }), body: { order: [b, a] } });
    assert.deepEqual((await stream.next('queue.reordered')).order, [b, a]);
    await call(ws, 'DELETE', `/api/v0/projects/cand/goals/${a}`, { headers: page(ws) });
    const removed = await stream.next('goal.removed');
    assert.equal(removed.goalId, a);
    assert.equal(removed.revision, 4);
  } finally { stream.close(); }
});

await check('a refused mutation emits no event', async (ws) => {
  const stream = await openStream(ws);
  try {
    await stream.next('hello');
    await call(ws, 'POST', '/api/v0/projects/cand/goals', { headers: page(ws, { Origin: 'http://evil.example', 'Content-Type': 'application/json' }), body: { text: 'x' } });
    await new Promise((wake) => setTimeout(wake, 150));
    assert.deepEqual(stream.events, []);
  } finally { stream.close(); }
});

await check('a fresh LIVE server holds no demo data', async (ws) => {
  for (const projectId of ['cand', 'site']) {
    const read = await call(ws, 'GET', `/api/v0/projects/${projectId}/goals`);
    assert.deepEqual(read.json.goals, []);
    assert.doesNotMatch(read.text, /demo|DEMO|示範/);
  }
  assert.doesNotMatch((await call(ws, 'GET', '/api/v0/projects')).text, /demo|DEMO|示範/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
