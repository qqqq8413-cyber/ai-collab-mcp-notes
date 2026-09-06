/**
 * Acceptance tests for the production `runRound1Stage()` boundary.
 *
 * The point of the extraction: a caller can obtain a genuine production Round 1 and stop,
 * without any post-Round1 provider call ever being requested. Before it, every eligible
 * run — deep, successful, two or more specialists — necessarily continued into synthesis,
 * so a real Round 1 could not be captured without also spending a forbidden call.
 *
 * Deterministic and offline. Every dispatcher here is injected and every post-Round1 stage
 * throws on sight, so a boundary leak fails loudly rather than quietly costing a call.
 */
import assert from 'node:assert/strict';
import { runRound1Stage, runPlanningStage, runOrchestrator, toRound1Snapshot } from '../../dist/modes/orchestrator.js';
import { recheckControl, HISTORICAL_CONTROL_SHA256 } from './capture/control-recheck.mjs';

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  PASS ${name}`); passed++; }
  catch (e) { console.log(`  FAIL ${name}\n      ${e.stack}`); failed++; }
}
async function mustReject(fn, hint) {
  let thrown = null;
  try { await fn(); } catch (e) { thrown = e; }
  assert.ok(thrown, `expected a rejection (${hint}) but none happened`);
  return thrown;
}

const WORKERS = [
  { id: 'alpha', provider: 'openai', model: 'stub-alpha', role: 'Alpha role', evidenceCapable: false },
  { id: 'beta', provider: 'claude', model: 'stub-beta', role: 'Beta role', evidenceCapable: false },
  { id: 'gamma', provider: 'gemini', model: 'stub-gamma', role: 'Gamma role', evidenceCapable: true },
];
const TASK = 'Decide whether to open a second production studio next year.';
const POST_ROUND1 = ['synthesis', 'synthesis_gate', 'round2_worker', 'self_review', 'decision_synthesis'];

const plan = (complexity, ids) => ({
  complexity,
  requiredCapabilities: ['reasoning'],
  requiresRedTeam: false,
  reason: 'Offline boundary fixture',
  assignments: ids.map((agentId) => ({ agentId, mission: `Mission for ${agentId}`, priority: 'high' })),
});

/**
 * A dispatcher that treats any post-Round1 stage as a test failure.
 *
 * This is the assertion that matters: not "we did not observe synthesis", but "a synthesis
 * request would have been refused". A boundary that merely happens not to be crossed is
 * not a boundary.
 */
function round1OnlyCall(planObject, { failWorker } = {}) {
  const calls = [];
  const call = async (provider, prompt, options) => {
    const stage = options.stage;
    if (POST_ROUND1.includes(stage)) {
      throw new Error(`BOUNDARY VIOLATION: a post-Round1 stage "${stage}" was requested`);
    }
    calls.push({ stage, provider, model: options.model, system: options.system, retrieval: options.retrieval ?? null });
    if (stage === 'planning') return { provider, model: options.model, text: JSON.stringify(planObject) };
    if (stage === 'round1_worker') {
      const id = WORKERS.find((w) => w.role === options.system)?.id ?? 'unknown';
      if (failWorker === id) throw new Error(`offline worker failure: ${id}`);
      return { provider, model: options.model, text: `${id.toUpperCase()}-OUTPUT: first.\n\nSecond paragraph from ${id}.` };
    }
    throw new Error(`unexpected stage: ${stage}`);
  };
  return { calls, call };
}

const base = (planObject, opts) => {
  const d = round1OnlyCall(planObject, opts);
  return { d, input: { task: TASK, orchestrator: { provider: 'openai', model: 'stub-chief' }, workers: WORKERS, call: d.call } };
};

/* ======================================================== the boundary */
console.log('\nRound 1 boundary');

await check('DEEP / SUCCESS / N>=2 completes with no post-Round1 call requested', async () => {
  const { d, input } = base(plan('deep', ['alpha', 'beta']));
  const round1 = await runRound1Stage(input);
  assert.deepEqual(d.calls.map((c) => c.stage), ['planning', 'round1_worker', 'round1_worker']);
  assert.equal(round1.plan.complexity, 'deep');
  assert.equal(round1.report.status, 'SUCCESS');
  assert.equal(round1.workerResults.filter((r) => r.output !== undefined).length, 2);
  for (const stage of POST_ROUND1) {
    assert.ok(!d.calls.some((c) => c.stage === stage), `${stage} was called`);
  }
});

await check('the stage scales to whatever the planner assigned, still with no synthesis', async () => {
  const { d, input } = base(plan('deep', ['alpha', 'beta', 'gamma']));
  const round1 = await runRound1Stage(input);
  assert.deepEqual(d.calls.map((c) => c.stage), ['planning', 'round1_worker', 'round1_worker', 'round1_worker']);
  assert.equal(round1.report.status, 'SUCCESS');
  assert.equal(d.calls.filter((c) => c.stage === 'round1_worker').length, 3);
});

await check('the guard itself works: a synthesis request would have been refused', async () => {
  // Proves the previous tests are not passing because the dispatcher is lenient.
  const { d, input } = base(plan('deep', ['alpha', 'beta']));
  await runRound1Stage(input);
  await mustReject(() => d.call('openai', 'x', { stage: 'synthesis', model: 'm' }), 'synthesis must be refused');
  await mustReject(() => d.call('openai', 'x', { stage: 'synthesis_gate', model: 'm' }), 'gate must be refused');
});

await check('runOrchestrator on the same input DOES continue into synthesis', async () => {
  // The contrast that makes the boundary meaningful: same plan, same workers, and the
  // full orchestrator necessarily calls synthesis. That is exactly why the stage was
  // needed to capture a Round 1 without spending a post-Round1 call.
  const stages = [];
  await runOrchestrator({
    task: TASK,
    orchestrator: { provider: 'openai', model: 'stub-chief' },
    synthesizer: { provider: 'openai', model: 'stub-synth' },
    workers: WORKERS,
    call: async (provider, prompt, options) => {
      stages.push(options.stage);
      if (options.stage === 'planning') return { provider, model: options.model, text: JSON.stringify(plan('deep', ['alpha', 'beta'])) };
      return { provider, model: options.model, text: 'text' };
    },
  });
  assert.deepEqual(stages, ['planning', 'round1_worker', 'round1_worker', 'synthesis']);
});

/* =================================================== production objects */
console.log('\nProduction objects, not reconstructions');

await check('toRound1Snapshot accepts the stage output directly', async () => {
  const { input } = base(plan('deep', ['alpha', 'beta']));
  const round1 = await runRound1Stage(input);
  const snapshot = toRound1Snapshot(round1, TASK, WORKERS);

  assert.equal(snapshot.task, TASK);
  assert.equal(snapshot.complexity, round1.plan.complexity);
  assert.deepEqual(snapshot.agentOrder, round1.plan.assignments.map((a) => a.agentId));
  // Identity, not a copy: the snapshot carries the production objects themselves.
  assert.equal(snapshot.workerResults, round1.workerResults);
  assert.equal(snapshot.workers, WORKERS);
});

await check('the stage returns the production plan and report, not a second shape', async () => {
  const { input } = base(plan('deep', ['alpha', 'beta']));
  const round1 = await runRound1Stage(input);
  assert.ok(Array.isArray(round1.plan.assignments));
  assert.ok(Array.isArray(round1.planningAdjustments));
  assert.ok(round1.report.policy, 'the report must still carry the execution policy');
  assert.equal(round1.report.policy.synthesize, true);
  assert.equal(round1.report.policy.topology, 'collaborative');
  assert.ok('evidenceLabel' in round1.report && 'synthesisAllowed' in round1.report);
});

await check('retrieval is attached only to an evidenceCapable specialist', async () => {
  const { d, input } = base(plan('deep', ['alpha', 'gamma']));
  await runRound1Stage(input);
  const byRole = Object.fromEntries(d.calls.filter((c) => c.stage === 'round1_worker').map((c) => [c.system, c.retrieval]));
  assert.equal(byRole['Alpha role'], null);
  assert.deepEqual(byRole['Gamma role'], { enabled: true });
});

/* ======================================================= failure paths */
console.log('\nFailure semantics preserved');

await check('a failed worker becomes a WorkerRunResult error, not a thrown run', async () => {
  const { input } = base(plan('deep', ['alpha', 'beta']), { failWorker: 'beta' });
  const round1 = await runRound1Stage(input);
  const beta = round1.workerResults.find((r) => r.agentId === 'beta');
  assert.match(beta.error, /offline worker failure/);
  assert.equal(beta.output, undefined);
  assert.equal(round1.report.status, 'DEGRADED');
});

await check('zero successful workers keeps the existing report and policy', async () => {
  const { input } = base(plan('deep', ['alpha']), { failWorker: 'alpha' });
  const round1 = await runRound1Stage(input);
  assert.equal(round1.report.status, 'FAILED');
  assert.equal(round1.report.synthesisAllowed, false);
  assert.equal(round1.report.policy.synthesize, false);
  assert.equal(round1.report.policy.reason, 'no_successful_workers');
});

await check('a SIMPLE single specialist still resolves to direct delivery', async () => {
  const { input } = base(plan('simple', ['alpha']));
  const round1 = await runRound1Stage(input);
  assert.equal(round1.report.policy.synthesize, false);
  assert.equal(round1.report.policy.reason, 'simple_single_specialist_direct_delivery');
  assert.equal(round1.report.policy.topology, 'single');
});

await check('malformed planning fails the same way, before any worker runs', async () => {
  const calls = [];
  const error = await mustReject(
    () => runRound1Stage({
      task: TASK,
      orchestrator: { provider: 'openai', model: 'stub-chief' },
      workers: WORKERS,
      call: async (provider, prompt, options) => {
        calls.push(options.stage);
        if (options.stage === 'planning') return { provider, model: options.model, text: 'not json at all' };
        throw new Error('no worker should run after planning failed');
      },
    }),
    'malformed planning'
  );
  assert.match(String(error), /did not return a JSON object/);
  assert.deepEqual(calls, ['planning'], 'planning must fail before any worker call');
});

await check('an empty worker roster is rejected as before', async () => {
  const error = await mustReject(
    () => runRound1Stage({ task: TASK, orchestrator: { provider: 'openai', model: 'm' }, workers: [], call: async () => ({}) }),
    'empty roster'
  );
  assert.match(String(error), /at least one worker/);
});

/* ============================================================= timings */
console.log('\nTiming contract');

await check('the stage reports planning, workers and a Round 1 elapsed from one origin', async () => {
  const originalNow = Date.now;
  let tick = 1000;
  Date.now = () => (tick += 1000);
  try {
    const { input } = base(plan('deep', ['alpha', 'beta']));
    const round1 = await runRound1Stage(input);
    assert.ok(Number.isFinite(round1.planningMs) && round1.planningMs >= 0);
    assert.ok(Number.isFinite(round1.workersMs) && round1.workersMs >= 0);
    assert.ok(Number.isFinite(round1.round1Ms) && round1.round1Ms >= 0);
    assert.ok(Number.isFinite(round1.startedAt));
    // round1Ms spans the whole stage, so it cannot be shorter than either part.
    assert.ok(round1.round1Ms >= round1.planningMs, 'round1Ms must cover planning');
    assert.ok(round1.round1Ms >= round1.workersMs, 'round1Ms must cover the workers');
  } finally {
    Date.now = originalNow;
  }
});

await check('the stage reads the clock exactly as many times as the old inline code did', async () => {
  // Guards the parity capture: an extra clock read would shift every stepped-clock timing
  // and silently break before/after comparability.
  const originalNow = Date.now;
  let reads = 0;
  Date.now = () => { reads++; return 1000 + reads * 1000; };
  try {
    const { input } = base(plan('deep', ['alpha', 'beta']));
    await runRound1Stage(input);
    assert.equal(reads, 5, 'expected startedAt, planningStart, planningEnd, workersStart, workersEnd');
  } finally {
    Date.now = originalNow;
  }
});

/* =========================================== historical control integrity */
console.log('\nPlanning-stage extraction parity');

await check('the whole Round 1 output is unchanged after planning moved into its own stage', async () => {
  // Every field of the public contract, on a fixture that exercises the constraint layer:
  // one unknown agent, one over-long mission, and a priority order that is not input order.
  const raw = {
    complexity: 'deep',
    requiredCapabilities: ['reasoning', 'finance'],
    requiresRedTeam: true,
    reason: 'Offline parity fixture',
    assignments: [
      { agentId: 'nobody', mission: 'Mission for nobody', priority: 'high' },
      { agentId: 'alpha', mission: 'q'.repeat(603), priority: 'low' },
      { agentId: 'beta', mission: 'Mission for beta', priority: 'high' },
      { agentId: 'gamma', mission: 'Mission for gamma', priority: 'medium' },
    ],
  };
  const seen = [];
  const call = async (provider, prompt, options) => {
    seen.push({ provider, stage: options.stage, system: options.system, model: options.model });
    if (options.stage === 'planning') return { provider, model: options.model, text: JSON.stringify(raw) };
    return { provider, model: options.model, text: `output for ${options.system}` };
  };

  const originalNow = Date.now;
  let tick = 0;
  Date.now = () => (tick += 1000);
  let out;
  try {
    out = await runRound1Stage({ task: TASK, orchestrator: { provider: 'openai', model: 'stub-chief' }, workers: WORKERS, call });
  } finally {
    Date.now = originalNow;
  }

  // Plan and adjustments come through the extracted stage unchanged.
  assert.equal(out.plan.complexity, 'deep');
  assert.equal(out.plan.requiresRedTeam, true);
  assert.deepEqual(out.plan.requiredCapabilities, ['reasoning', 'finance']);
  assert.deepEqual(out.plan.assignments.map((a) => a.agentId), ['beta', 'gamma', 'alpha'],
    'priority order, not input order');
  assert.equal(out.plan.assignments.find((a) => a.agentId === 'alpha').mission.length, 600);
  assert.deepEqual(out.planningAdjustments, [
    'Dropped mission for unknown agentId "nobody".',
    'Truncated mission for "alpha" from 603 to 600 characters.',
  ]);

  // Worker results follow assignment order, one per assignment, with retrieval only where
  // the roster says the specialist is evidence-capable.
  assert.deepEqual(out.workerResults.map((r) => r.agentId), ['beta', 'gamma', 'alpha']);
  assert.deepEqual(out.workerResults.map((r) => r.provider), ['claude', 'gemini', 'openai']);
  assert.ok(out.workerResults.every((r) => typeof r.output === 'string' && !r.error));

  // Report and policy still derive from the same facts.
  assert.equal(out.report.status, 'SUCCESS');
  assert.equal(out.report.requestedWorkers, 3);
  assert.equal(out.report.successfulWorkers, 3);
  assert.ok(out.report.policy, 'execution policy is still attached');

  // Stepped-clock timings: five reads at 1000/2000/3000/4000/5000.
  assert.equal(out.startedAt, 1000);
  assert.equal(out.planningMs, 1000, 'planningEnd - planningStart');
  assert.equal(out.workersMs, 1000, 'workersEnd - workersStart');
  assert.equal(out.round1Ms, 4000, 'workersEnd - startedAt');

  // Provider call order: planning first, then the workers in assignment order.
  assert.deepEqual(seen.map((c) => c.stage), ['planning', 'round1_worker', 'round1_worker', 'round1_worker']);
  assert.deepEqual(seen.slice(1).map((c) => c.system), ['Beta role', 'Gamma role', 'Alpha role']);
  assert.deepEqual(seen.slice(1).map((c) => c.provider), ['claude', 'gemini', 'openai']);
});

await check('runRound1Stage and runPlanningStage agree on plan and adjustments', async () => {
  const raw = {
    complexity: 'normal',
    requiredCapabilities: ['reasoning'],
    requiresRedTeam: false,
    reason: 'Offline parity fixture',
    assignments: [
      { agentId: 'alpha', mission: 'Mission for alpha', priority: 'high' },
      { agentId: 'alpha', mission: 'Duplicate for alpha', priority: 'high' },
      { agentId: 'beta', mission: 'Mission for beta', priority: 'medium' },
    ],
  };
  const planningOnly = async (provider, prompt, options) => {
    assert.equal(options.stage, 'planning', 'runPlanningStage must not dispatch a worker');
    return { provider, model: options.model, text: JSON.stringify(raw) };
  };
  const both = async (provider, prompt, options) =>
    options.stage === 'planning'
      ? { provider, model: options.model, text: JSON.stringify(raw) }
      : { provider, model: options.model, text: 'worker output' };

  const orchestrator = { provider: 'openai', model: 'stub-chief' };
  const direct = await runPlanningStage({ task: TASK, orchestrator, workers: WORKERS, call: planningOnly });
  const viaRound1 = await runRound1Stage({ task: TASK, orchestrator, workers: WORKERS, call: both });

  assert.deepEqual(viaRound1.plan, direct.plan);
  assert.deepEqual(viaRound1.planningAdjustments, direct.planningAdjustments);
});

await check('an empty roster is still rejected before any clock read or provider call', async () => {
  const call = async () => { throw new Error('provider must not be reached'); };
  const originalNow = Date.now;
  let reads = 0;
  Date.now = () => { reads++; return 1000 + reads * 1000; };
  try {
    const err = await mustReject(
      () => runRound1Stage({ task: TASK, orchestrator: { provider: 'openai', model: 'stub-chief' }, workers: [], call }),
      'empty roster');
    assert.match(String(err), /Orchestrator requires at least one worker/);
    assert.equal(reads, 0, 'the rejection must precede startedAt');
  } finally {
    Date.now = originalNow;
  }
});

console.log('\nHistorical control integrity');

await check("the refactor did not move M2-A's disabled/omitted behaviour", () => {
  // Replay #4's verifier pins the runtime by hash, so an authorized production change
  // necessarily trips it — that is the fingerprint working, not a regression. This asks
  // the question the fingerprint stops short of: did the behaviour move? It re-runs the
  // sealed control harness verbatim, without touching or re-sealing the artifact.
  const result = recheckControl();
  assert.equal(result.cases, 16);
  assert.equal(result.sha256, HISTORICAL_CONTROL_SHA256,
    'the disabled/omitted path no longer reproduces the historical control — do not regenerate the artifact, this is a regression');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
