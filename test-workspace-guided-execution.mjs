import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync('workspace-ui/app.js', 'utf8');
const pure = app.slice(app.indexOf('function selectedGoalOf'), app.indexOf('const room ='));
if (!pure.includes('function selectedGoalOf') || pure.length < 2000) throw new Error('guided operations helpers not found');

let passed = 0, failed = 0;
async function check(label, run) {
  try { await run(); console.log('  PASS ' + label); passed++; }
  catch (error) { console.error('  FAIL ' + label + ': ' + error.stack); failed++; }
}

function fixture() {
  const goals = [
    { goalId: 'goal-1', text: 'First queued Goal' },
    { goalId: 'goal-2', text: 'Chosen second Goal' },
    { goalId: 'goal-3', text: 'Third Goal' },
  ];
  const state = {
    pid: 'chief', selectedGoal: { chief: 'goal-2' }, sheet: null,
    actionBusy: {}, actionIntent: null,
    exec: {
      'chief/goal-2': { state: 'ready', view: { status: 'IN_PROGRESS', run: { runId: 'run-2' } } },
    },
    steps: { 'chief/goal-2': { state: 'ready', view: {
      canStep: true, runId: 'run-2', readiness: 'READY', reason: null,
    } } },
    activation: {}, prepBusy: {}, prepResult: {}, stepBusy: {},
  };
  const calls = [];
  const gate = { canStep: true, runId: 'run-2', readiness: 'READY' };
  const activationGate = { canActivate: true, readiness: 'READY' };
  const status = { status: 'IN_PROGRESS', run: { runId: 'run-2' } };
  const source = {
    executionStatus: async (pid, id) => { calls.push(['inspect', pid, id]); return status; },
    executionStepInspect: async (pid, id) => { calls.push(['gate', pid, id]); return gate; },
    activationInspect: async (pid, id) => { calls.push(['activation', pid, id]); return activationGate; },
  };
  const deps = [
    state,
    () => ({ goals }),
    (pid, id) => pid + '/' + id,
    () => {},
    () => null,
    source,
    async (pid, id) => { calls.push(['step', pid, id]); },
    async (pid, id) => { calls.push(['activate', pid, id]); },
    async (pid, id, kind) => { calls.push(['prepare', pid, id, kind]); },
    async (pid, id) => { calls.push(['reload', pid, id]); },
    (text) => { calls.push(['toast', text]); },
  ];
  const code = new Function('S', 'queue', 'execKey', 'render', '$', 'source', 'stepOnce', 'activateGoal', 'prepareGoal', 'loadExecution', 'toast',
    pure + '\nreturn { selectedGoalOf, intentValid, permittedAction, requestAction, confirmAction };');
  return { goals, state, calls, gate, activationGate, status, ops: code(...deps) };
}

await check('a selected Goal belongs to this Project, without changing queue order', async () => {
  const f = fixture();
  assert.equal(f.ops.selectedGoalOf(f.goals, 'goal-2').goalId, 'goal-2');
  assert.equal(f.ops.selectedGoalOf(f.goals, 'missing').goalId, 'goal-1');
  assert.equal(f.ops.selectedGoalOf([], 'goal-2'), null);
  assert.deepEqual(f.goals.map(x => x.goalId), ['goal-1', 'goal-2', 'goal-3']);
});
await check('only the selected Goal can open a one-step confirmation; it binds the exact ROOT', async () => {
  const f = fixture();
  f.ops.requestAction('step');
  assert.equal(f.state.sheet, 'exec-confirm');
  assert.deepEqual(f.state.actionIntent, { action: 'step', projectId: 'chief', goalId: 'goal-2',
    status: 'IN_PROGRESS', runId: 'run-2', readiness: 'READY' });
  assert.deepEqual(f.calls, []);
});
await check('an explicit confirmation freshly re-inspects the exact selected Goal before one dispatch', async () => {
  const f = fixture();
  f.ops.requestAction('step');
  await f.ops.confirmAction();
  assert.deepEqual(f.calls, [['inspect', 'chief', 'goal-2'], ['gate', 'chief', 'goal-2'], ['step', 'chief', 'goal-2']]);
  assert.equal(f.state.sheet, null);
  assert.equal(f.state.actionIntent, null);
  assert.equal(f.state.actionBusy['chief/goal-2'], false);
});
await check('stale ROOT identity refuses the click without a Runner call', async () => {
  const f = fixture(); f.ops.requestAction('step');
  f.status.run.runId = 'run-foreign';
  await f.ops.confirmAction();
  assert.equal(f.calls.some(x => x[0] === 'step'), false);
  assert.equal(f.calls.some(x => x[0] === 'toast'), true);
  assert.equal(f.state.actionIntent, null);
});
await check('revoked or changed Runner readiness refuses the click before dispatch', async () => {
  const f = fixture(); f.ops.requestAction('step');
  f.gate.canStep = false;
  await f.ops.confirmAction();
  assert.equal(f.calls.some(x => x[0] === 'step'), false);
  assert.equal(f.calls.some(x => x[0] === 'toast'), true);
});
await check('a changed Goal selection cannot execute a previously confirmed Goal', async () => {
  const f = fixture(); f.ops.requestAction('step');
  f.state.selectedGoal.chief = 'goal-3';
  await f.ops.confirmAction();
  assert.deepEqual(f.calls, []);
  assert.equal(f.ops.intentValid(f.state.actionIntent), false);
});
await check('an unknown or non-ready action opens no confirmation and never requests execution', async () => {
  const f = fixture();
  f.ops.requestAction('unknown');
  assert.equal(f.state.sheet, null);
  f.gate.canStep = false;
  f.state.steps['chief/goal-2'].view.canStep = false;
  f.ops.requestAction('step');
  assert.equal(f.state.sheet, null);
  assert.deepEqual(f.calls, []);
});
await check('Change and ROOT admission require independent confirmed Goal-scoped requests', async () => {
  for (const [kind, status] of [['govern', 'GOAL_NOT_GOVERNED'], ['admit', 'RUN_NOT_ADMITTED']]) {
    const f = fixture();
    f.state.exec['chief/goal-2'].view = { status, run: null };
    f.status.status = status; f.status.run = null;
    f.ops.requestAction(kind);
    assert.equal(f.state.sheet, 'exec-confirm');
    await f.ops.confirmAction();
    assert.deepEqual(f.calls, [['inspect', 'chief', 'goal-2'], ['prepare', 'chief', 'goal-2', kind]]);
  }
});
await check('activation requires a fresh pre-provisioned gate and does not launch a model', async () => {
  const f = fixture();
  f.state.exec['chief/goal-2'].view.status = 'RUN_IDLE';
  f.status.status = 'RUN_IDLE';
  f.state.activation['chief/goal-2'] = { state: 'ready', view: { canActivate: true, readiness: 'READY' } };
  f.ops.requestAction('activate');
  await f.ops.confirmAction();
  assert.deepEqual(f.calls, [
    ['inspect', 'chief', 'goal-2'], ['activation', 'chief', 'goal-2'], ['activate', 'chief', 'goal-2'],
  ]);
  assert.equal(f.calls.some(x => x[0] === 'step'), false);
});
await check('missing approved activation readiness never issues the packet', async () => {
  const f = fixture();
  f.state.activation['chief/goal-2'] = { state: 'ready', view: { canActivate: false, readiness: 'NO_APPROVED_PLAN' } };
  f.ops.requestAction('activate');
  assert.equal(f.state.sheet, null);
  assert.deepEqual(f.calls, []);
});
await check('the Workspace click handler only requests a bound confirmation, never dispatches directly', async () => {
  const click = app.slice(app.indexOf("document.addEventListener('click'"), app.indexOf("document.addEventListener('submit'"));
  assert.ok(click.includes("case 'exec-select'"));
  assert.match(click, /S\.selectedGoal\[S\.pid\] = v/);
  assert.match(click, /requestAction\('step'\)/);
  assert.match(click, /requestAction\('activate'\)/);
  assert.match(click, /requestAction\(act === 'exec-govern'/);
  assert.doesNotMatch(click, /\bstepOnce\(|\bactivateGoal\(|\bprepareGoal\(/);
  const confirmation = app.slice(app.indexOf("if (S.sheet === 'exec-confirm')"), app.indexOf("if (S.sheet === 'decision')"));
  assert.match(confirmation, /exec-confirm|confirm-action/);
  assert.match(confirmation, /可能實際呼叫 AI 模型服務並產生費用/);
  assert.match(app, /aria-pressed="\$\{goal\.goalId === active\}"/);
  assert.doesNotMatch(app, /localStorage\.setItem\([^\n]*selectedGoal/);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
