import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { FileCollaborationStore } from './dist/workspace/collaboration-store.js';
import { importClaudeTranscript } from './dist/event-source/claude-transcript.js';
import { parseWorkspaceConfig } from './dist/workspace/config.js';
import { startWorkspaceServer, API_ROUTES } from './dist/workspace/server.js';
import { collaborationRoom, roomHTML } from './workspace-ui/collaboration.js';

const sid = '11111111-1111-4111-8111-111111111111';
const eid = '22222222-2222-4222-8222-222222222222';
let passed = 0, failed = 0;
async function check(name, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'chief-src-c1-'));
  const f = { dir, file: join(dir, `${sid}.jsonl`), dataDirectory: join(dir, 'data'), sourceCwd: dir, projectId: 'chief' };
  f.row = (overrides = {}) => ({ type: 'assistant', uuid: eid, sessionId: sid, timestamp: '2026-10-20T03:00:00.000Z',
    cwd: dir, message: { role: 'assistant', content: [{ type: 'text', text: 'Offline synthetic test message.' }] }, ...overrides });
  f.write = (...rows) => writeFileSync(f.file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  f.import = (options = {}) => importClaudeTranscript({ ...f, now: '2026-10-20T04:00:00.000Z', ...options });
  f.store = () => new FileCollaborationStore(f.dataDirectory);
  try { await fn(f); console.log(`  PASS ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}: ${e.stack}`); failed++; }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

await check('public text only; private reasoning, tool inputs/results, user prompts and sidechains excluded', (f) => {
  f.write({ type: 'user', message: { content: 'PRIVATE_USER' } }, f.row({ message: { role: 'assistant', content: [
    { type: 'thinking', thinking: 'PRIVATE_THINKING' }, { type: 'tool_use', input: 'PRIVATE_TOOL' },
    { type: 'text', text: 'Public answer.' }, { type: 'tool_result', content: 'PRIVATE_RESULT' },
  ] } }), f.row({ uuid: '33333333-3333-4333-8333-333333333333', isSidechain: true }));
  assert.equal(f.import().added, 1);
  const events = f.store().read('chief');
  assert.equal(events[0].body, 'Public answer.');
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_/);
  assert.equal(events[0].observation.blockIndex, 2);
});
await check('source/session/event/time are stored, but never promoted to authority or run status', (f) => {
  f.write(f.row()); f.import();
  const e = f.store().read('chief')[0];
  assert.equal(e.observation.source, 'CLAUDE_CODE_LOCAL_TRANSCRIPT');
  assert.equal(e.observation.eventType, 'assistant.text');
  assert.equal(e.observation.eventId, eid); assert.equal(e.observation.sessionId, sid);
  assert.equal(e.observation.captureMode, 'HISTORY');
  assert.equal(e.timestamp, '2026-10-20T03:00:00.000Z');
  assert.equal(e.observation.receivedAt, '2026-10-20T04:00:00.000Z');
  for (const key of ['authority', 'runId', 'authorization', 'status', 'to']) assert.equal(key in e, false);
});
await check('reimport is byte-identical, and returned data cannot mutate storage', (f) => {
  f.write(f.row()); assert.equal(f.import().added, 1);
  const path = join(f.dataDirectory, 'collaboration/chief.events.json');
  const before = readFileSync(path);
  assert.deepEqual([f.import({ now: '2026-10-20T05:00:00.000Z' }).added, f.import().duplicates], [0, 1]);
  const snapshot = f.store().read('chief'); snapshot[0].body = 'mutated';
  assert.deepEqual(readFileSync(path), before);
});
await check('distinct events with equal text remain distinct; duplicate content change is refused atomically', (f) => {
  f.write(f.row(), f.row({ uuid: '33333333-3333-4333-8333-333333333333' }));
  assert.equal(f.import().added, 2);
  f.write(f.row({ message: { role: 'assistant', content: [{ type: 'text', text: 'Changed.' }] } }));
  assert.throws(() => f.import(), /Existing event changed/);
  assert.equal(f.store().read('chief').length, 2);
});
await check('historical bootstrap vs appended watcher arrival; restarting never relabels history', (f) => {
  f.write(f.row()); const first = f.import();
  appendFileSync(f.file, JSON.stringify(f.row({ uuid: '33333333-3333-4333-8333-333333333333' })) + '\n');
  assert.equal(f.import({ previous: first.cursor }).added, 1);
  assert.deepEqual(f.store().read('chief').map((e) => e.observation.captureMode), ['HISTORY', 'LIVE_TAIL']);
  assert.equal(f.import().duplicates, 2);
  assert.deepEqual(f.store().read('chief').map((e) => e.observation.captureMode), ['HISTORY', 'LIVE_TAIL']);
});
await check('partial trailing record waits for its terminating newline', (f) => {
  writeFileSync(f.file, JSON.stringify(f.row())); const first = f.import();
  assert.equal(first.added, 0); assert.ok(first.incompleteBytes > 0);
  appendFileSync(f.file, '\n'); assert.equal(f.import({ previous: first.cursor }).added, 1);
});
await check('watcher rejects rewritten, truncated or replaced sources', (f) => {
  f.write(f.row()); const first = f.import();
  f.write(f.row({ timestamp: '2026-10-20T03:01:00.000Z' }));
  assert.throws(() => f.import({ previous: first.cursor }), /rewritten/);
  writeFileSync(f.file, ''); assert.throws(() => f.import({ previous: first.cursor }), /truncated/);
  renameSync(f.file, `${f.file}.old`); f.write(f.row());
  assert.throws(() => f.import({ previous: first.cursor }), /replaced/);
});
await check('bad JSON, schema, timestamp, session and cwd refuse a whole batch without partial write', (f) => {
  for (const bad of [{}, f.row({ timestamp: 'yesterday' }), f.row({ uuid: 'bad' }), f.row({ sessionId: eid }),
    f.row({ cwd: tmpdir() }), f.row({ message: { role: 'assistant', content: [{ type: 'text', text: 7 }] } })]) {
    f.write(f.row(), bad); assert.throws(() => f.import()); assert.equal(f.store().read('chief').length, 0);
  }
  writeFileSync(f.file, JSON.stringify(f.row()) + '\nBAD\n');
  assert.throws(() => f.import(), /Malformed/); assert.equal(f.store().read('chief').length, 0);
});
await check('identity includes project and selected session; caller cannot traverse event paths', (f) => {
  f.write(f.row()); f.import(); f.import({ projectId: 'other' });
  assert.notEqual(f.store().read('chief')[0].id, f.store().read('other')[0].id);
  assert.throws(() => f.import({ projectId: '../outside' }));
});
await check('long unicode text is complete, segmented without surrogate splitting, and display transforms documented', (f) => {
  const text = '😀'.repeat(2500) + '\tline\r\nend';
  f.write(f.row({ message: { role: 'assistant', content: [{ type: 'text', text }] } })); f.import();
  const events = f.store().read('chief');
  assert.equal(events.length, 2);
  assert.equal(events.map((e) => e.body).join(''), text.replace(/\t/g, '    ').replace(/\r\n/g, '\n'));
  const room = collaborationRoom('chief', { participants: [{ id: 'claude-code', name: 'Claude Code' }], events });
  assert.equal(room.rejected, 0); assert.equal(room.identity, 'IDENTIFIED');
});
await check('control characters fail closed; HTML is escaped, never executed', (f) => {
  const row = (text) => f.row({ message: { role: 'assistant', content: [{ type: 'text', text }] } });
  f.write(row('bad\u0000text')); assert.throws(() => f.import());
  f.write(row('<script>alert(1)</script>')); f.import();
  const html = roomHTML(collaborationRoom('chief', { participants: [{ id: 'claude-code', name: 'Claude Code' }], events: f.store().read('chief') }));
  assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
});
await check('storage corruption, locks, symlink files/directories are not repaired or followed', (f) => {
  f.write(f.row()); f.import();
  const path = join(f.dataDirectory, 'collaboration/chief.events.json');
  const content = readFileSync(path, 'utf8');
  writeFileSync(`${path}.lock`, 'busy'); assert.throws(() => f.import(), /locked/); rmSync(`${path}.lock`);
  writeFileSync(path, content.replace('Offline', 'Altered')); assert.throws(() => f.store().read('chief'), /checksum/);
  rmSync(path); symlinkSync(f.file, path); assert.throws(() => f.store().read('chief'), /Invalid event file/);
  rmSync(join(f.dataDirectory, 'collaboration'), { recursive: true });
  symlinkSync(f.dir, join(f.dataDirectory, 'collaboration')); assert.throws(() => f.store().read('chief'), /real directory/);
});
await check('room shows provenance and history/tail, without typing, demo replay or claimed task completion', (f) => {
  f.write(f.row()); f.import();
  const room = collaborationRoom('chief', { provenance: 'LOCAL_SOURCE_OBSERVATION',
    participants: [{ id: 'claude-code', name: 'Claude Code' }], events: f.store().read('chief') });
  const html = roomHTML(room, { replay: true });
  assert.match(html, /歷史匯入/); assert.match(html, /Session ID/); assert.match(html, /Event ID/);
  assert.match(html, /不代表 AI 此刻仍在工作/); assert.doesNotMatch(html, /data-replay|cm-typing|示範重播/);
  const events = structuredClone(room.events); events[0].observation.captureMode = 'LIVE_TAIL';
  assert.match(roomHTML(collaborationRoom('chief', { participants: room.participants, events })), /監看收到/);
  events[0].observation.thinking = 'private';
  assert.equal(collaborationRoom('chief', { events }).rejected, 1);
});
await check('GET events requires D1, is project-scoped and read-only, survives a new server instance', async (f) => {
  f.write(f.row()); f.import();
  const config = parseWorkspaceConfig({ schemaVersion: 1, dataDirectory: f.dataDirectory,
    humanPrincipal: { principalRef: 'human:test' }, projects: [{ projectId: 'chief', displayName: 'CHIEF', repository: 'local' }] }, f.dir);
  const path = '/api/v0/projects/chief/collaboration';
  for (let i = 0; i < 2; i++) {
    const ws = await startWorkspaceServer({ config, uiDirectory: 'workspace-ui', port: 0 });
    try {
      const url = ws.url.slice(0, -1);
      assert.equal((await fetch(url + path)).status, 401);
      const page = await fetch(url); const cookie = page.headers.get('set-cookie').split(';')[0];
      const headers = { Cookie: cookie };
      const r = await fetch(url + path, { headers });
      const data = await r.json(); assert.equal(r.status, 200); assert.equal(data.events.length, 1);
      assert.equal(data.authority, 'NON_AUTHORITATIVE'); assert.equal(data.provenance, 'LOCAL_SOURCE_OBSERVATION');
      assert.equal(collaborationRoom('chief', data).rejected, 0);
      assert.equal((await fetch(url + path + '?file=secret', { headers })).status, 400);
      assert.equal((await fetch(url + path, { headers: { ...headers, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
      assert.equal((await fetch(url + path.replace('/chief/', '/other/'), { headers })).status, 404);
      assert.equal((await fetch(url + path, { method: 'POST', headers: { ...headers, Origin: url, 'X-Chief-Workspace': '1' } })).status, 404);
      assert.equal(f.store().read('chief').length, 1);
    } finally { await ws.close(); }
  }
  assert.deepEqual(API_ROUTES.filter((r) => r.endsWith('/collaboration')), ['GET /api/v0/projects/:projectId/collaboration']);
});
await check('CLI imports offline and rejects unknown projects/arguments without model or credential access', (f) => {
  f.write(f.row());
  const cfg = join(f.dir, 'workspace.json');
  writeFileSync(cfg, JSON.stringify({ schemaVersion: 1, dataDirectory: f.dataDirectory, humanPrincipal: { principalRef: 'human:test' },
    projects: [{ projectId: 'chief', displayName: 'CHIEF', repository: 'local' }] }));
  const args = ['dist/event-source/main.js', '--config', cfg, '--project', 'chief', '--session-file', f.file, '--source-cwd', f.dir];
  const run = spawnSync(process.execPath, args, { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(run.status, 0, run.stderr); assert.equal(JSON.parse(run.stdout).added, 1);
  assert.equal(spawnSync(process.execPath, [...args, '--unknown'], { encoding: 'utf8' }).status, 1);
  assert.equal(existsSync(join(f.dir, 'authority')), false);
});

await check('synthetic CLI watch process imports an appended event, then stops on bad data without storing it', async (f) => {
  f.write(f.row());
  const cfg = join(f.dir, 'workspace.json');
  writeFileSync(cfg, JSON.stringify({ schemaVersion: 1, dataDirectory: f.dataDirectory, humanPrincipal: { principalRef: 'human:test' },
    projects: [{ projectId: 'chief', displayName: 'CHIEF', repository: 'local' }] }));
  const child = spawn(process.execPath, ['dist/event-source/main.js', '--config', cfg, '--project', 'chief',
    '--session-file', f.file, '--source-cwd', f.dir, '--watch'], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH } });
  let out = '', err = '';
  child.stdout.on('data', (b) => { out += b; }); child.stderr.on('data', (b) => { err += b; });
  const closed = new Promise((done) => child.once('close', done));
  const until = async (condition) => {
    const end = Date.now() + 10_000;
    while (!condition()) {
      if (Date.now() > end) throw new Error(`watch timeout: ${out} ${err}`);
      await new Promise((done) => setTimeout(done, 50));
    }
  };
  try {
    await until(() => out.includes('觀察模式'));
    appendFileSync(f.file, JSON.stringify(f.row({ uuid: '33333333-3333-4333-8333-333333333333' })) + '\n');
    await until(() => f.store().read('chief').length === 2);
    assert.deepEqual(f.store().read('chief').map((e) => e.observation.captureMode), ['HISTORY', 'LIVE_TAIL']);
    appendFileSync(f.file, 'BAD\n');
    const code = await Promise.race([closed, new Promise((_, fail) => setTimeout(() => fail(new Error('watch did not stop')), 8000).unref())]);
    assert.equal(code, 1); assert.match(err, /Malformed complete source line/);
    assert.equal(f.store().read('chief').length, 2);
  } finally { if (child.exitCode === null) child.kill('SIGTERM'); await closed; }
});

await check('corrupt persisted events fail GET explicitly and are not mistaken for an empty successful room', async (f) => {
  f.write(f.row()); f.import();
  const path = join(f.dataDirectory, 'collaboration/chief.events.json');
  writeFileSync(path, 'broken');
  const config = parseWorkspaceConfig({ schemaVersion: 1, dataDirectory: f.dataDirectory,
    humanPrincipal: { principalRef: 'human:test' }, projects: [{ projectId: 'chief', displayName: 'CHIEF', repository: 'local' }] }, f.dir);
  const ws = await startWorkspaceServer({ config, uiDirectory: 'workspace-ui', port: 0 });
  try {
    const page = await fetch(ws.url); const cookie = page.headers.get('set-cookie').split(';')[0];
    const response = await fetch(`${ws.url}api/v0/projects/chief/collaboration`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 500); assert.equal((await response.json()).error.code, 'COLLABORATION_INTEGRITY');
    assert.equal(readFileSync(path, 'utf8'), 'broken');
  } finally { await ws.close(); }
});

await check('source CLI graph names no model/provider, execution, credential or authority capability', () => {
  for (const file of ['src/event-source/main.ts', 'src/event-source/claude-transcript.ts', 'src/workspace/collaboration-store.ts']) {
    const code = readFileSync(file, 'utf8');
    assert.doesNotMatch(code, /from ['"](?:.*(?:providers|automation|intake|execution)\/|node:(?:child_process|http|https|net|tls)|openai|@anthropic-ai)/);
    assert.doesNotMatch(code, /\bfetch\(|\bspawn\(|\.createRun\(|process\.env\.(?:GH_TOKEN|OPENAI_API_KEY)|gh-chief-ai/);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
