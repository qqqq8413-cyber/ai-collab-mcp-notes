import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorkspaceConfig } from './dist/workspace/config.js';
import { FileGoalStore, GoalQueueRequestError, GoalStoreIntegrityError, replayHistory } from './dist/workspace/goal-store.js';

// WS-L1 goal queue: local operator input, non-authoritative, never started.

const T0 = '2026-10-01T09:00:00.000Z';
let passed = 0, failed = 0;
function check(name, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'chief-ws-store-'));
  try { fn(dir); console.log(`  PASS ${name}`); passed++; }
  catch (error) { console.error(`  FAIL ${name}: ${error.stack}`); failed++; }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
function clockFrom(start = T0) {
  let at = Date.parse(start);
  return { now: () => { const value = new Date(at).toISOString(); at += 1000; return value; } };
}
function ids() {
  let n = 0;
  return () => `goal-00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
}
const store = (dir) => new FileGoalStore(dir, { clock: clockFrom(), newGoalId: ids() });
const file = (dir, projectId = 'cand') => join(dir, `${projectId}.queue.json`);
const AUTHORITY_KEYS = /runId|changeId|authorizationId|packetId|packetHash|sliceId|invocationId|stopId|reviewId/i;

check('a new goal is stored as queued, not started, local operator input', (dir) => {
  const s = store(dir);
  const { queue, event } = s.addGoal('cand', '  繼續做候選人平台  ');
  assert.equal(event.kind, 'GOAL_ADDED');
  assert.equal(queue.revision, 1);
  assert.deepEqual(queue.goals, [{ goalId: 'goal-00000000-0000-4000-8000-000000000001', projectId: 'cand', text: '繼續做候選人平台',
    createdAt: T0, status: 'QUEUED', classification: 'LOCAL_OPERATOR_INPUT', authority: 'NON_AUTHORITATIVE', execution: 'NOT_STARTED' }]);
});

check('a goal record carries no run, change, packet, or authorization identity', (dir) => {
  const s = store(dir);
  s.addGoal('cand', 'one');
  const raw = readFileSync(file(dir), 'utf8');
  assert.doesNotMatch(raw, AUTHORITY_KEYS);
  assert.deepEqual(Object.keys(s.read('cand').goals[0]).sort(),
    ['authority', 'classification', 'createdAt', 'execution', 'goalId', 'projectId', 'status', 'text']);
});

check('goals survive a reload by a new store instance', (dir) => {
  const s = store(dir);
  s.addGoal('cand', 'one'); s.addGoal('cand', 'two');
  const again = new FileGoalStore(dir);
  assert.deepEqual(again.read('cand'), s.read('cand'));
  assert.deepEqual(again.read('cand').goals.map((goal) => goal.text), ['one', 'two']);
});

check('reorder accepts only an exact permutation and is recorded in history', (dir) => {
  const s = store(dir);
  const a = s.addGoal('cand', 'a').queue.goals[0].goalId;
  const b = s.addGoal('cand', 'b').queue.goals[1].goalId;
  for (const bad of [[a], [a, a], [a, b, b], [a, 'goal-00000000-0000-4000-8000-000000000099'], 'x', [1, 2]]) {
    assert.throws(() => s.reorder('cand', bad), GoalQueueRequestError);
  }
  assert.equal(s.read('cand').revision, 2, 'refused reorders write nothing');
  const { queue } = s.reorder('cand', [b, a]);
  assert.deepEqual(queue.goals.map((goal) => goal.text), ['b', 'a']);
  assert.deepEqual(queue.history.map((event) => event.kind), ['GOAL_ADDED', 'GOAL_ADDED', 'QUEUE_REORDERED']);
});

check('a stale expected revision is refused without writing', (dir) => {
  const s = store(dir);
  const a = s.addGoal('cand', 'a').queue.goals[0].goalId;
  const b = s.addGoal('cand', 'b').queue.goals[1].goalId;
  assert.throws(() => s.reorder('cand', [b, a], 1), (error) => error.code === 'STALE_REVISION');
  assert.equal(s.read('cand').revision, 2);
  assert.equal(s.reorder('cand', [b, a], 2).queue.revision, 3);
});

check('an unstarted goal can be removed; the history keeps that it existed', (dir) => {
  const s = store(dir);
  const a = s.addGoal('cand', 'a').queue.goals[0].goalId;
  s.addGoal('cand', 'b');
  const { queue } = s.removeGoal('cand', a);
  assert.deepEqual(queue.goals.map((goal) => goal.text), ['b']);
  assert.deepEqual(queue.history.map((event) => event.kind), ['GOAL_ADDED', 'GOAL_ADDED', 'GOAL_REMOVED']);
  assert.throws(() => s.removeGoal('cand', a), (error) => error.code === 'UNKNOWN_GOAL');
  assert.throws(() => s.removeGoal('cand', '../x'), (error) => error.code === 'UNKNOWN_GOAL');
});

check('goal text is validated before anything is written', (dir) => {
  const s = store(dir);
  for (const bad of ['', '   ', 'x'.repeat(2001), 'a\u0000b', 'bell\u0007', 42, null, undefined, ['x']]) {
    assert.throws(() => s.addGoal('cand', bad), GoalQueueRequestError);
  }
  assert.deepEqual(readdirSync(dir), []);
  assert.equal(s.addGoal('cand', 'line one\nline two\tindented').queue.goals[0].text, 'line one\nline two\tindented');
});

check('project ids that could escape the directory are refused', (dir) => {
  const s = store(dir);
  for (const bad of ['../x', 'A', '', 'a/b', '.hidden']) assert.throws(() => s.addGoal(bad, 'x'));
});

check('replay is deterministic and the stored queue must equal it', (dir) => {
  const s = store(dir);
  s.addGoal('cand', 'a'); s.addGoal('cand', 'b');
  const q = s.read('cand');
  assert.deepEqual(replayHistory('cand', q.history), replayHistory('cand', structuredClone(q.history)));
  assert.deepEqual(replayHistory('cand', q.history), q.goals);
});

check('a checksum mismatch fails closed', (dir) => {
  const s = store(dir);
  s.addGoal('cand', 'a');
  const envelope = JSON.parse(readFileSync(file(dir), 'utf8'));
  envelope.queue.goals[0].text = 'changed by hand';
  writeFileSync(file(dir), JSON.stringify(envelope));
  assert.throws(() => s.read('cand'), GoalStoreIntegrityError);
  assert.throws(() => s.addGoal('cand', 'b'), GoalStoreIntegrityError);
});

check('a resealed file whose queue does not match its history fails closed', (dir) => {
  const s = store(dir);
  s.addGoal('cand', 'a');
  const envelope = JSON.parse(readFileSync(file(dir), 'utf8'));
  envelope.queue.goals[0].text = 'not what history says';
  envelope.checksum = createHash('sha256').update(JSON.stringify(envelope.queue)).digest('hex');
  writeFileSync(file(dir), JSON.stringify(envelope));
  assert.throws(() => s.read('cand'), /replay of its history/);
});

check('authority fields smuggled into a stored goal are refused', (dir) => {
  const s = store(dir);
  s.addGoal('cand', 'a');
  const envelope = JSON.parse(readFileSync(file(dir), 'utf8'));
  envelope.queue.goals[0].runId = 'run-1';
  envelope.checksum = createHash('sha256').update(JSON.stringify(envelope.queue)).digest('hex');
  writeFileSync(file(dir), JSON.stringify(envelope));
  assert.throws(() => s.read('cand'), GoalStoreIntegrityError);
});

check('corrupt JSON and wrong schema version fail closed', (dir) => {
  const s = store(dir);
  s.addGoal('cand', 'a');
  writeFileSync(file(dir), '{"schemaVersion":1,');
  assert.throws(() => s.read('cand'), GoalStoreIntegrityError);
  writeFileSync(file(dir), JSON.stringify({ schemaVersion: 2, queue: {}, checksum: 'x' }));
  assert.throws(() => s.read('cand'), /schema version/);
});

check('a leftover lock fails closed and is not removed', (dir) => {
  const s = store(dir);
  s.addGoal('cand', 'a');
  writeFileSync(`${file(dir)}.lock`, 'uncertain');
  assert.throws(() => s.addGoal('cand', 'b'), /locked/);
  assert.equal(readFileSync(`${file(dir)}.lock`, 'utf8'), 'uncertain');
  assert.equal(s.read('cand').revision, 1);
});

check('an orphan temporary file never replaces the queue', (dir) => {
  const s = store(dir);
  s.addGoal('cand', 'a');
  const before = s.read('cand');
  writeFileSync(`${file(dir)}.interrupted.tmp`, '{');
  assert.deepEqual(new FileGoalStore(dir).read('cand'), before);
});

check('a clock that goes backwards never makes history go backwards', (dir) => {
  const times = ['2026-10-01T10:00:00.000Z', '2026-10-01T09:00:00.000Z'];
  const s = new FileGoalStore(dir, { clock: { now: () => times.shift() }, newGoalId: ids() });
  s.addGoal('cand', 'a');
  const { queue } = s.addGoal('cand', 'b');
  assert.equal(queue.history[1].at, '2026-10-01T10:00:00.000Z');
});

check('projects keep separate queues', (dir) => {
  const s = store(dir);
  s.addGoal('cand', 'a'); s.addGoal('site', 'b');
  assert.deepEqual(s.read('cand').goals.map((goal) => goal.text), ['a']);
  assert.deepEqual(s.read('site').goals.map((goal) => goal.text), ['b']);
  assert.deepEqual(s.read('empty').goals, []);
});

check('configuration lists projects explicitly and refuses anything else', (dir) => {
  const config = parseWorkspaceConfig({ schemaVersion: 1, dataDirectory: './queues',
    projects: [{ projectId: 'cand', displayName: '候選人平台', repository: 'org/cand' }] }, dir);
  assert.equal(config.dataDirectory, join(dir, 'queues'));
  assert.deepEqual(config.projects.map((project) => project.projectId), ['cand']);
  assert.ok(Object.isFrozen(config.projects[0]));
  const base = { schemaVersion: 1, dataDirectory: '/tmp/x', projects: [{ projectId: 'cand', displayName: 'C', repository: 'r' }] };
  for (const bad of [
    { ...base, schemaVersion: 2 },
    { ...base, projects: [] },
    { ...base, projects: [base.projects[0], base.projects[0]] },
    { ...base, projects: [{ ...base.projects[0], projectId: 'Bad Id' }] },
    { ...base, projects: [{ ...base.projects[0], runId: 'run-1' }] },
    { ...base, controllerStoreDirectory: '/tmp/c' },
  ]) assert.throws(() => parseWorkspaceConfig(bad, dir));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
