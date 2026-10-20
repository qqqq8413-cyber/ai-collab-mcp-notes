import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PilotEngine } from './dist/pilot/engine.js';
import { PilotStore } from './dist/pilot/store.js';
import { readBudget } from './dist/pilot/read-budget.js';
import { LIMITS } from './dist/pilot/model.js';

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  PASS ' + name); } catch (e) { failed++; console.error('  FAIL ' + name + ': ' + e.stack); } }
async function world(fn) {
  const directory = mkdtempSync(join(tmpdir(), 'chief-p1-r1-'));
  let at = Date.parse('2026-10-20T00:59:30Z'), calls = 0;
  const reader = { async read() { calls++; return []; } };
  let e;
  const boot = () => new PilotEngine({ dataDirectory: directory, projects: ['chief', 'second'], reader, clock: () => at });
  e = boot();
  const f = { directory, get e() { return e; }, get calls() { return calls; }, get at() { return at; },
    advance(ms) { at += ms; }, view(id = 'chief') { return e.read(id); },
    task(extra = {}, project = 'chief') { const id = randomUUID(); e.create(project, { requestId: id, name: 'R1', type: 'CI_WATCH', mode: 'SCHEDULED', intervalSeconds: 60, maxRetries: 1, ...extra }); return id; },
    action(id, action = 'RUN', requestId = randomUUID(), project = 'chief') { return e.action(project, id, { action, requestId }); },
    exhaust() { const s = new PilotStore(directory), d = s.read('chief'); d.readStarts = Array(30).fill(new Date(at).toISOString()); s.write(d); },
    async restart() { await e.close(); e = boot(); },
  };
  try { await fn(f); } finally { await e.close(); rmSync(directory, { recursive: true, force: true }); }
}

await test('rolling hour is not reset by the calendar hour boundary', () => {
  const t = Date.parse('2026-10-20T00:59:30Z'); const starts = Array(30).fill(new Date(t).toISOString());
  assert.equal(readBudget(starts, t + 60000).remaining, 0);
  assert.equal(readBudget(starts, t + 60000).nextAvailableAt, '2026-10-20T01:59:30.000Z');
  assert.equal(readBudget(starts, t + 3600000).remaining, 30);
});
await test('staggered reads release one exact slot at a time', () => {
  const now = Date.parse('2026-10-20T01:30:00Z');
  const starts = Array.from({ length: 30 }, (_, n) => new Date(now - 1800000 + n * 1000).toISOString());
  assert.equal(readBudget(starts, now).nextAvailableAt, '2026-10-20T02:00:00.000Z');
  assert.equal(readBudget(starts, now + 1800000).remaining, 1);
});
await test('scheduled exhaustion persists one deferral and generates no FAILED or provider call', () => world(async f => {
  const id = f.task(); f.exhaust(); f.action(id, 'ENABLE'); f.advance(60000); await f.e.tick();
  const v = f.view(); assert.equal(v.tasks[0].state, 'DEFERRED'); assert.equal(v.runs.length, 0); assert.equal(f.calls, 0);
  assert.equal(v.tasks[0].nextDueAt, '2026-10-20T01:59:30.000Z'); assert.equal(v.budget.remaining, 0);
  const revision = v.revision; for (let i = 0; i < 100; i++) await f.e.tick();
  assert.equal(f.view().revision, revision); assert.equal(f.view().operations.filter(o => o.action === 'SYSTEM_BUDGET_DEFERRED').length, 1);
}));
await test('scheduled work resumes at the next available slot without a retry or backlog', () => world(async f => {
  const id = f.task(); f.exhaust(); f.action(id, 'ENABLE'); f.advance(60000); await f.e.tick();
  f.advance(3540000); await f.e.tick(); await f.e.tick();
  assert.equal(f.calls, 1); assert.equal(f.view().runs.length, 1); assert.equal(f.view().runs[0].state, 'COMPLETED');
  assert.equal(f.view().tasks[0].budgetDeferral, undefined); assert.equal(f.view().runs[0].retryCount, 0);
}));
await test('manual request is deferred before STARTED and retains idempotency across restart', () => world(async f => {
  const id = f.task({ mode: 'MANUAL' }), requestId = randomUUID(); f.exhaust(); f.action(id, 'RUN', requestId); await f.e.drain();
  assert.equal(f.view().runs[0].state, 'DEFERRED'); assert.equal(f.view().runs[0].startedAt, null); assert.equal(f.view().runs[0].error, null);
  await f.restart(); f.action(id, 'RUN', requestId); assert.equal(f.view().runs.length, 1);
  f.advance(3600000); await f.e.tick(); assert.equal(f.calls, 1); assert.equal(f.view().runs.length, 1);
}));
await test('deferred work is cancellable and never consumes a read slot', () => world(async f => {
  const id = f.task(); f.exhaust(); f.action(id); await f.e.drain(); f.action(id, 'CANCEL');
  assert.equal(f.view().runs[0].state, 'CANCELLED'); assert.equal(f.view().tasks[0].budgetDeferral, undefined);
  f.advance(3600000); await f.e.tick(); assert.equal(f.calls, 0);
}));
await test('STOP also cancels a deferred request, unlike pausing future triggers', () => world(async f => {
  const id = f.task(); f.exhaust(); f.action(id); await f.e.drain(); f.action(id, 'STOP');
  assert.equal(f.view().runs[0].error, 'USER_STOP'); f.advance(3600000); await f.e.tick(); assert.equal(f.calls, 0);
}));
await test('paused budget-delayed schedule does not run when capacity returns', () => world(async f => {
  const id = f.task(); f.exhaust(); f.action(id, 'ENABLE'); f.advance(60000); await f.e.tick(); f.action(id, 'PAUSE');
  assert.equal(f.view().tasks[0].budgetDeferral, undefined); assert.equal(f.view().tasks[0].nextDueAt, null);
  f.advance(3600000); await f.e.tick(); assert.equal(f.calls, 0);
}));
await test('restart preserves a future budget deferral and does not emit another observation', () => world(async f => {
  const id = f.task(); f.exhaust(); f.action(id, 'ENABLE'); f.advance(60000); await f.e.tick();
  const prior = f.view(); await f.restart(); await f.e.tick(); assert.deepEqual(f.view().tasks, prior.tasks); assert.equal(f.view().runs.length, 0);
}));
await test('long downtime skips missed scheduled slots rather than immediately replaying', () => world(async f => {
  const id = f.task(); f.action(id, 'ENABLE'); f.advance(8 * 3600000); await f.restart(); await f.e.tick();
  assert.equal(f.calls, 0); assert.ok(Date.parse(f.view().tasks[0].nextDueAt) > f.at);
  f.advance(60000); await f.e.tick(); assert.equal(f.calls, 1);
}));
await test('queued pre-restart schedule is cancelled with evidence, not replayed', () => world(async f => {
  const id = f.task(); f.action(id); const store = new PilotStore(f.directory), d = store.read('chief'); d.runs[0].trigger = 'SCHEDULED'; store.write(d);
  await f.restart(); await f.e.tick(); assert.equal(f.calls, 0); assert.equal(f.view().runs[0].error, 'SCHEDULE_SLOT_EXPIRED_NO_CATCHUP');
}));
await test('budget is shared across projects; local CI reports do not require a read slot', () => world(async f => {
  const a = f.task(); f.action(a); await f.e.drain();
  const report = f.task({ type: 'CI_REPORT', sourceTaskId: a, mode: 'MANUAL' }); f.exhaust();
  const b = f.task({ mode: 'MANUAL' }, 'second'); f.action(b, 'RUN', randomUUID(), 'second'); f.action(report); await f.e.drain();
  assert.equal(f.view('second').runs[0].state, 'DEFERRED'); assert.equal(f.view().runs.at(-1).state, 'COMPLETED'); assert.equal(f.calls, 1);
}));
await test('deferred state is not retryable as a failure; request input cannot forge budget metadata', () => world(async f => {
  const id = f.task(); f.exhaust(); f.action(id); await f.e.drain(); assert.throws(() => f.action(id, 'RETRY'));
  assert.throws(() => f.task({ budgetDeferral: { reason: 'GITHUB_READ_BUDGET' } }));
}));
await test('recommended interval is five minutes, without rewriting a stored 60-second setting', () => world(f => {
  f.task(); assert.equal(LIMITS.recommendedIntervalSeconds, 300); assert.equal(f.view().tasks[0].intervalSeconds, 60);
}));
await test('STOP cancels an ordinary queued request before any reader starts', () => world(async f => {
  const id = f.task(); f.action(id); f.action(id, 'STOP'); await f.e.tick();
  assert.equal(f.calls, 0); assert.equal(f.view().runs[0].state, 'CANCELLED'); assert.equal(f.view().runs[0].error, 'USER_STOP');
}));
await test('expired deferral after downtime becomes a future slot without catch-up or stale UI metadata', () => world(async f => {
  const id = f.task(); f.exhaust(); f.action(id, 'ENABLE'); f.advance(60000); await f.e.tick();
  f.advance(7200000); await f.restart(); await f.e.tick();
  assert.equal(f.calls, 0); assert.equal(f.view().tasks[0].state, 'READY'); assert.equal(f.view().tasks[0].budgetDeferral, undefined);
  f.advance(60000); await f.e.tick(); assert.equal(f.calls, 1);
}));
console.log(`\n${passed} passed, ${failed} failed`); process.exitCode = failed ? 1 : 0;
