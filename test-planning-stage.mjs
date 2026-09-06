/**
 * Acceptance tests for the production `runPlanningStage()` boundary.
 *
 * The point of the extraction: a caller can obtain a genuine production plan — parsed,
 * schema-validated and constraint-enforced exactly as production does it — without a
 * single worker call. Before it, planning could only be reached through
 * `runRound1Stage()`, which necessarily dispatched every assigned specialist.
 *
 * These tests exist because the alternative was a caller re-implementing the parser and
 * the constraint layer. That was tried once, in a since-archived script, and its results
 * were never production-equivalent: a hand-rolled fence stripper agrees with the real one
 * right up until the case that matters. So every assertion below goes through the real
 * exported function, and the only thing injected is the dispatcher.
 *
 * Deterministic and offline. No provider is reachable from here.
 */
import assert from 'node:assert/strict';
import { runPlanningStage, runRound1Stage } from './dist/modes/orchestrator.js';
import { CHIEF_SYSTEM_PROMPT, MISSION_CHAR_LIMIT, SPECIALIST_CAP, buildPlanningPrompt } from './dist/agents/chief.js';

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
  { id: 'delta', provider: 'openai', model: 'stub-delta', role: 'Delta role', evidenceCapable: false },
];
const TASK = 'Decide whether to open a second production studio next year.';
const ORCHESTRATOR = { provider: 'openai', model: 'stub-chief' };

const assignment = (agentId, mission = `Mission for ${agentId}`, priority = 'high') => ({ agentId, mission, priority });
const rawPlan = (complexity, assignments, extra = {}) => ({
  complexity,
  requiredCapabilities: ['reasoning'],
  requiresRedTeam: false,
  reason: 'Offline planning fixture',
  assignments,
  ...extra,
});

/** Records every dispatch and answers the planning call with `text`. */
function stub(text) {
  const calls = [];
  const call = async (provider, prompt, options) => {
    calls.push({ provider, prompt, options });
    if (options?.stage !== 'planning') throw new Error(`unexpected non-planning stage: ${options?.stage}`);
    return { provider, model: options.model, text: typeof text === 'function' ? text() : text };
  };
  call.calls = calls;
  return call;
}
const planStub = (plan) => stub(JSON.stringify(plan));

const run = (call, overrides = {}) =>
  runPlanningStage({ task: TASK, orchestrator: ORCHESTRATOR, workers: WORKERS, call, ...overrides });

console.log('\nThe planning request');

await check('sends exactly one planning call with the production provider, model, system and stage', async () => {
  const call = planStub(rawPlan('deep', [assignment('alpha'), assignment('beta')]));
  await run(call);
  assert.equal(call.calls.length, 1, 'exactly one provider call');
  const [only] = call.calls;
  assert.equal(only.provider, 'openai');
  assert.equal(only.options.model, 'stub-chief');
  assert.equal(only.options.system, CHIEF_SYSTEM_PROMPT);
  assert.equal(only.options.stage, 'planning');
});

await check('sends exactly the production planning prompt', async () => {
  const call = planStub(rawPlan('normal', [assignment('alpha')]));
  await run(call);
  assert.equal(call.calls[0].prompt, buildPlanningPrompt(TASK, WORKERS, undefined));
});

await check('a budget reaches buildPlanningPrompt unchanged', async () => {
  const budget = { maxSpecialists: 2 };
  const call = planStub(rawPlan('deep', [assignment('alpha')]));
  await run(call, { budget });
  assert.equal(call.calls[0].prompt, buildPlanningPrompt(TASK, WORKERS, budget));
});

await check('systemPrompt override replaces the standing brief and nothing else', async () => {
  const call = planStub(rawPlan('normal', [assignment('alpha')]));
  await run(call, { orchestrator: { ...ORCHESTRATOR, systemPrompt: 'A different Chief.' } });
  assert.equal(call.calls[0].options.system, 'A different Chief.');
  assert.equal(call.calls[0].options.stage, 'planning');
  assert.equal(call.calls[0].prompt, buildPlanningPrompt(TASK, WORKERS, undefined));
});

await check('ZERO worker calls are issued, whatever the plan assigns', async () => {
  const call = planStub(rawPlan('deep', [assignment('alpha'), assignment('beta'), assignment('gamma')]));
  const { plan } = await run(call);
  assert.equal(plan.assignments.length, 3, 'the plan really did assign three specialists');
  assert.equal(call.calls.length, 1, 'and not one of them was dispatched');
  assert.deepEqual(call.calls.map((c) => c.options.stage), ['planning']);
});

console.log('\nParsing the planner response');

await check('plain JSON parses', async () => {
  const { plan } = await run(planStub(rawPlan('deep', [assignment('alpha')])));
  assert.equal(plan.complexity, 'deep');
  assert.deepEqual(plan.assignments.map((a) => a.agentId), ['alpha']);
});

await check('fenced JSON parses', async () => {
  const body = JSON.stringify(rawPlan('normal', [assignment('beta')]));
  const { plan } = await run(stub('```json\n' + body + '\n```'));
  assert.equal(plan.complexity, 'normal');
});

await check('JSON surrounded by prose parses', async () => {
  const body = JSON.stringify(rawPlan('simple', [assignment('alpha')]));
  const { plan } = await run(stub(`Here is my plan.\n\n${body}\n\nLet me know if you want changes.`));
  assert.equal(plan.complexity, 'simple');
});

await check('NEGATIVE: no braces is rejected with the raw output quoted', async () => {
  const err = await mustReject(() => run(stub('I would rather explain in prose.')), 'no braces');
  assert.match(String(err), /Chief did not return a JSON object/);
  assert.match(String(err), /I would rather explain in prose/);
});

await check('NEGATIVE: malformed JSON is rejected', async () => {
  await mustReject(() => run(stub('{ "complexity": "deep", ')), 'malformed');
});

await check('NEGATIVE: schema-invalid JSON is rejected', async () => {
  await mustReject(() => run(stub(JSON.stringify({ complexity: 'catastrophic', assignments: [assignment('alpha')] }))), 'bad enum');
  await mustReject(() => run(stub(JSON.stringify(rawPlan('deep', [])))), 'empty assignments violates min(1)');
  await mustReject(() => run(stub(JSON.stringify({ assignments: [assignment('alpha')] }))), 'missing complexity');
});

await check('schema defaults are applied for the optional fields', async () => {
  const { plan } = await run(stub(JSON.stringify({
    complexity: 'normal',
    assignments: [{ agentId: 'alpha', mission: 'Mission for alpha' }],
  })));
  assert.deepEqual(plan.requiredCapabilities, [], 'requiredCapabilities defaults to []');
  assert.equal(plan.requiresRedTeam, false, 'requiresRedTeam defaults to false');
  assert.equal(plan.reason, '', 'reason defaults to empty');
  assert.equal(plan.assignments[0].priority, 'high', 'priority defaults to high');
});

console.log('\nConstraint enforcement');

await check('an unknown agentId is dropped and recorded verbatim', async () => {
  const { plan, planningAdjustments } = await run(planStub(
    rawPlan('deep', [assignment('alpha'), assignment('nobody'), assignment('beta')])));
  assert.deepEqual(plan.assignments.map((a) => a.agentId), ['alpha', 'beta']);
  assert.deepEqual(planningAdjustments, ['Dropped mission for unknown agentId "nobody".']);
});

await check('a duplicate assignment keeps the first and records the drop', async () => {
  const { plan, planningAdjustments } = await run(planStub(rawPlan('deep', [
    assignment('alpha', 'First mission'),
    assignment('alpha', 'Second mission'),
  ])));
  assert.equal(plan.assignments.length, 1);
  assert.equal(plan.assignments[0].mission, 'First mission', 'the first survives');
  assert.deepEqual(planningAdjustments, [
    'Dropped extra mission for "alpha" (one coherent mission per specialist).',
  ]);
});

await check('NEGATIVE: every agentId unknown raises the existing error', async () => {
  const err = await mustReject(
    () => run(planStub(rawPlan('deep', [assignment('nobody'), assignment('nobody-else')]))),
    'all unknown');
  assert.match(String(err), /Planning produced no usable assignments after applying constraints\./);
});

await check('a mission is truncated at 600 UTF-16 units, counted in UTF-16 units', async () => {
  assert.equal(MISSION_CHAR_LIMIT, 600);
  const long = 'x'.repeat(MISSION_CHAR_LIMIT + 7);
  const { plan, planningAdjustments } = await run(planStub(rawPlan('deep', [assignment('alpha', long)])));
  assert.equal(plan.assignments[0].mission.length, MISSION_CHAR_LIMIT);
  assert.deepEqual(planningAdjustments, [
    `Truncated mission for "alpha" from ${MISSION_CHAR_LIMIT + 7} to ${MISSION_CHAR_LIMIT} characters.`,
  ]);
});

await check('the 600 limit counts UTF-16 units, so an astral character costs two', async () => {
  // 300 astral code points are 600 UTF-16 units and must pass untouched; 301 must not.
  const exact = '\u{1F600}'.repeat(300);
  assert.equal(exact.length, MISSION_CHAR_LIMIT);
  const kept = await run(planStub(rawPlan('deep', [assignment('alpha', exact)])));
  assert.deepEqual(kept.planningAdjustments, [], 'exactly at the limit is untouched');

  const over = '\u{1F600}'.repeat(301);
  const cut = await run(planStub(rawPlan('deep', [assignment('alpha', over)])));
  assert.equal(cut.plan.assignments[0].mission.length, MISSION_CHAR_LIMIT);
  assert.match(cut.planningAdjustments[0], new RegExp(`from ${over.length} to ${MISSION_CHAR_LIMIT} characters`));
});

await check('an empty mission is kept as-is, which is the current behaviour', async () => {
  const { plan, planningAdjustments } = await run(planStub(rawPlan('normal', [assignment('alpha', '')])));
  assert.equal(plan.assignments.length, 1);
  assert.equal(plan.assignments[0].mission, '');
  assert.deepEqual(planningAdjustments, [], 'no adjustment is recorded for an empty mission');
});

console.log('\nSpecialist caps and ordering');

for (const [complexity, cap] of Object.entries(SPECIALIST_CAP)) {
  await check(`${complexity} caps at ${cap} and records the dropped ids in order`, async () => {
    const ids = ['alpha', 'beta', 'gamma', 'delta'];
    const { plan, planningAdjustments } = await run(planStub(
      rawPlan(complexity, ids.map((id) => assignment(id)))));
    assert.equal(plan.assignments.length, Math.min(cap, ids.length));
    assert.deepEqual(plan.assignments.map((a) => a.agentId), ids.slice(0, cap));
    if (cap < ids.length) {
      assert.deepEqual(planningAdjustments, [
        `Capped specialists at ${cap} for complexity "${complexity}"; dropped: ${ids.slice(cap).join(', ')}.`,
      ]);
    } else {
      assert.deepEqual(planningAdjustments, []);
    }
  });
}

await check('a tighter budget.maxSpecialists wins over the complexity cap', async () => {
  const { plan, planningAdjustments } = await run(
    planStub(rawPlan('deep', ['alpha', 'beta', 'gamma', 'delta'].map((id) => assignment(id)))),
    { budget: { maxSpecialists: 2 } });
  assert.deepEqual(plan.assignments.map((a) => a.agentId), ['alpha', 'beta']);
  assert.deepEqual(planningAdjustments, [
    'Capped specialists at 2 for complexity "deep"; dropped: gamma, delta.',
  ]);
});

await check('a looser budget does not raise the complexity cap', async () => {
  const { plan } = await run(
    planStub(rawPlan('simple', ['alpha', 'beta'].map((id) => assignment(id)))),
    { budget: { maxSpecialists: 99 } });
  assert.equal(plan.assignments.length, SPECIALIST_CAP.simple);
});

await check('priority ordering is stable within a rank and high beats medium beats low', async () => {
  const { plan } = await run(planStub(rawPlan('deep', [
    assignment('alpha', 'a', 'low'),
    assignment('beta', 'b', 'high'),
    assignment('gamma', 'c', 'medium'),
    assignment('delta', 'd', 'high'),
  ])));
  assert.deepEqual(plan.assignments.map((a) => a.agentId), ['beta', 'delta', 'gamma', 'alpha'],
    'high in original order, then medium, then low');
});

await check('adjustments appear in enforcement order: drops, then truncation, then cap', async () => {
  const long = 'y'.repeat(MISSION_CHAR_LIMIT + 1);
  const { planningAdjustments } = await run(planStub(rawPlan('simple', [
    assignment('nobody'),
    assignment('alpha', long),
    assignment('alpha', 'duplicate'),
    assignment('beta'),
  ])));
  assert.deepEqual(planningAdjustments, [
    'Dropped mission for unknown agentId "nobody".',
    `Truncated mission for "alpha" from ${MISSION_CHAR_LIMIT + 1} to ${MISSION_CHAR_LIMIT} characters.`,
    'Dropped extra mission for "alpha" (one coherent mission per specialist).',
    'Capped specialists at 1 for complexity "simple"; dropped: beta.',
  ]);
});

await check('requiresRedTeam and the other planner fields survive enforcement', async () => {
  const { plan } = await run(planStub(rawPlan('deep', [assignment('alpha')], {
    requiresRedTeam: true,
    requiredCapabilities: ['reasoning', 'finance'],
    reason: 'Because the commitment is hard to reverse.',
  })));
  assert.equal(plan.requiresRedTeam, true);
  assert.deepEqual(plan.requiredCapabilities, ['reasoning', 'finance']);
  assert.equal(plan.reason, 'Because the commitment is hard to reverse.');
});

console.log('\nErrors, roster and clock');

await check('an empty roster is rejected before the provider is reached', async () => {
  const call = stub('{}');
  const err = await mustReject(() => run(call, { workers: [] }), 'empty roster');
  assert.match(String(err), /Orchestrator requires at least one worker/);
  assert.equal(call.calls.length, 0, 'the provider must not have been called');
});

await check('a provider error propagates unchanged', async () => {
  const boom = new Error('stub provider exploded');
  const err = await mustReject(() => run(async () => { throw boom; }), 'provider error');
  assert.equal(err, boom, 'the identical error object, not a wrapped one');
});

await check('the stage reads the clock exactly twice', async () => {
  const originalNow = Date.now;
  let reads = 0;
  Date.now = () => { reads++; return 1000 + reads * 1000; };
  try {
    const { planningMs } = await run(planStub(rawPlan('deep', [assignment('alpha')])));
    assert.equal(reads, 2, 'expected planningStart and planningEnd');
    assert.equal(planningMs, 1000, 'and the stepped clock difference');
  } finally {
    Date.now = originalNow;
  }
});

await check('an empty roster costs no clock read either', async () => {
  const originalNow = Date.now;
  let reads = 0;
  Date.now = () => { reads++; return 1000 + reads * 1000; };
  try {
    await mustReject(() => run(stub('{}'), { workers: [] }), 'empty roster');
    assert.equal(reads, 0, 'the rejection must precede the clock');
  } finally {
    Date.now = originalNow;
  }
});

console.log('\nParity with runRound1Stage');

await check('runRound1Stage plans identically to runPlanningStage on the same input', async () => {
  const raw = rawPlan('deep', [
    assignment('nobody'),
    assignment('alpha', 'z'.repeat(MISSION_CHAR_LIMIT + 3)),
    assignment('beta', 'b', 'low'),
    assignment('gamma', 'c', 'high'),
    assignment('delta', 'd', 'medium'),
  ]);
  const direct = await runPlanningStage({ task: TASK, orchestrator: ORCHESTRATOR, workers: WORKERS, call: planStub(raw) });

  const round1Call = async (provider, prompt, options) =>
    options.stage === 'planning'
      ? { provider, model: options.model, text: JSON.stringify(raw) }
      : { provider, model: options.model, text: `output from ${options.system}` };
  const viaRound1 = await runRound1Stage({ task: TASK, orchestrator: ORCHESTRATOR, workers: WORKERS, call: round1Call });

  assert.deepEqual(viaRound1.plan, direct.plan, 'same post-enforcement plan');
  assert.deepEqual(viaRound1.planningAdjustments, direct.planningAdjustments, 'same adjustments, same order');
});

await check('the post-enforcement assignment count is what a census would count', async () => {
  // The formal event source is the enforced plan, never the planner's raw JSON: the raw
  // response here asks for five specialists and production acts on four.
  const raw = rawPlan('deep', ['alpha', 'beta', 'gamma', 'delta'].map((id) => assignment(id))
    .concat([assignment('nobody')]));
  assert.equal(raw.assignments.length, 5, 'raw Chief JSON says five');
  const { plan } = await run(planStub(raw));
  assert.equal(plan.assignments.length, 4, 'production acts on four');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
