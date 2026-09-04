import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deriveExecutionPolicy } from './dist/agents/policy.js';
import { runOrchestrator, buildWorkerPrompt } from './dist/modes/orchestrator.js';
import { resolveRoster } from './dist/agents/registry.js';

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  PASS ${name}`);
    passed++;
  } catch (error) {
    console.log(`  FAIL ${name}\n      ${error.stack}`);
    failed++;
  }
}

const roster = [
  { id: 'w1', provider: 'claude', model: 'worker-a', role: 'Worker one' },
  { id: 'w2', provider: 'openai', model: 'worker-b', role: 'Worker two' },
  { id: 'research', provider: 'gemini', role: 'Research', evidenceCapable: true },
];
const raw = '\ufeff \t# Result\r\n\r\n| \u7d50\u679c | e\u0301 |\r\n  untouched  \n';
const final = 'Synthesized answer';
const task = 'Return the requested result without adding any explanation.';
const planFor = (complexity = 'simple', ids = ['w1']) => ({
  complexity,
  requiredCapabilities: ['reasoning'],
  assignments: ids.map((agentId) => ({ agentId, mission: `Mission for ${agentId}`, priority: 'high' })),
  requiresRedTeam: false,
  reason: 'Offline test plan',
});

async function run({ plan = planFor(), workers = roster, responses = {}, originalTask = task, budget, advance = () => {} } = {}) {
  const calls = [];
  const call = async (provider, prompt, options) => {
    const stage = calls.length === 0 ? 'planning' : options.system ? 'worker' : 'synthesis';
    calls.push({ stage, provider, prompt, options });
    advance(stage);
    if (stage === 'planning') return { provider, model: options.model, text: JSON.stringify(plan) };
    if (stage === 'synthesis') return { provider, model: options.model, text: final };
    const worker = workers.find((candidate) => candidate.role === options.system);
    assert.ok(worker, 'mock must identify the selected worker');
    const response = Object.hasOwn(responses, worker.id) ? responses[worker.id] : { text: raw };
    if (response instanceof Error) throw response;
    return { provider, model: options.model, ...response };
  };
  const result = await runOrchestrator({
    task: originalTask,
    orchestrator: { provider: 'openai', model: 'chief-model' },
    synthesizer: { provider: 'openai', model: 'synthesis-model' },
    workers,
    budget,
    call,
  });
  return { result, calls };
}

const facts = (overrides = {}) => ({
  complexity: 'simple',
  assignmentIds: ['w1'],
  status: 'SUCCESS',
  synthesisAllowed: true,
  retrievalRequired: false,
  workerResults: [{ agentId: 'w1', output: raw }],
  ...overrides,
});
const stages = (calls) => calls.map((call) => call.stage);
const retrieval = (status) => ({
  status,
  queries: ['offline query'],
  queryCount: 1,
  sources: status === 'GROUNDED' ? [{ url: 'https://example.com/source', title: 'Fixture' }] : [],
  sourcesFound: status === 'GROUNDED' ? 1 : 0,
});

console.log('\nExecution policy and direct delivery');

await check('SIMPLE uses only planning and one worker, preserving the Step 6.1 input', async () => {
  const { result, calls } = await run();
  assert.deepEqual(stages(calls), ['planning', 'worker']);
  assert.deepEqual(result.plan, planFor());
  assert.deepEqual(result.planningAdjustments, []);
  assert.equal(calls[1].prompt, buildWorkerPrompt(task, planFor().assignments[0].mission));
  assert.equal(calls[1].options.system, roster[0].role);
  assert.equal(calls[1].options.model, roster[0].model);
  assert.equal(calls[1].options.retrieval, undefined);
  assert.equal(result.report.status, 'SUCCESS');
  assert.equal(result.finalOutput, raw);
});

await check('direct delivery preserves exact text and UTF-8 bytes, including whitespace', async () => {
  const { result } = await run();
  assert.equal(result.finalOutput, result.workerResults[0].output);
  assert.deepEqual(Buffer.from(result.finalOutput), Buffer.from(raw));
});

await check('serialized report distinguishes direct delivery from failure', async () => {
  const { result } = await run();
  const report = JSON.parse(JSON.stringify(result.report));
  assert.equal(report.synthesisAllowed, true, 'legacy failure guard remains true');
  assert.deepEqual(report.policy, {
    topology: 'single', synthesize: false, reason: 'simple_single_specialist_direct_delivery',
  });
  assert.match(report.notes.join(' '), /Synthesis skipped: simple_single_specialist_direct_delivery/);
});

await check('fast path retains all timing fields and records zero synthesis time', async () => {
  const originalNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  try {
    const { result } = await run({ advance: (stage) => { now += { planning: 17, worker: 31, synthesis: 43 }[stage]; } });
    assert.deepEqual(result.timings, { planningMs: 17, workersMs: 31, synthesisMs: 0, totalMs: 48 });
  } finally {
    Date.now = originalNow;
  }
});

await check('abnormal SIMPLE with multiple assignments never takes the single fast path', () => {
  const input = facts({ assignmentIds: ['w1', 'w2'], workerResults: [{ agentId: 'w1', output: raw }, { agentId: 'w2', output: raw }] });
  const before = structuredClone(input);
  assert.deepEqual(deriveExecutionPolicy(input), { topology: 'collaborative', synthesize: true, reason: 'not_single_specialist' });
  assert.deepEqual(input, before, 'derivation must not mutate its facts');
});

await check('NORMAL with one specialist still synthesizes', async () => {
  const { result, calls } = await run({ plan: planFor('normal') });
  assert.deepEqual(stages(calls), ['planning', 'worker', 'synthesis']);
  assert.deepEqual(result.report.policy, { topology: 'single', synthesize: true, reason: 'non_simple_execution' });
  assert.equal(result.finalOutput, final);
  assert.ok(calls[2].prompt.includes(raw));
  assert.ok(calls[2].prompt.includes(task));
});

await check('DEEP with one specialist still synthesizes and retains the evidence banner', async () => {
  const { result, calls } = await run({ plan: planFor('deep') });
  assert.deepEqual(stages(calls), ['planning', 'worker', 'synthesis']);
  assert.equal(result.report.policy.synthesize, true);
  assert.equal(result.report.evidenceLabel, 'HYPOTHESIS');
  assert.match(result.finalOutput, /^> \*\*UNVERIFIED/);
  assert.ok(result.finalOutput.endsWith(final));
});

await check('DEEP capped to one specialist still synthesizes and records the cap', async () => {
  const { result, calls } = await run({ plan: planFor('deep', ['w1', 'w2']), budget: { maxSpecialists: 1 } });
  assert.equal(result.plan.assignments.length, 1);
  assert.match(result.planningAdjustments.join(' '), /Capped specialists at 1/);
  assert.deepEqual(stages(calls), ['planning', 'worker', 'synthesis']);
  assert.equal(result.report.policy.synthesize, true);
});

await check('NORMAL collaboration still calls both workers and synthesis', async () => {
  const { result, calls } = await run({ plan: planFor('normal', ['w1', 'w2']) });
  assert.deepEqual(stages(calls), ['planning', 'worker', 'worker', 'synthesis']);
  assert.equal(result.report.status, 'SUCCESS');
  assert.equal(result.report.policy.topology, 'collaborative');
  assert.equal(result.report.policy.synthesize, true);
});

await check('partial failure retains DEGRADED synthesis and its missing-worker warning', async () => {
  const { result, calls } = await run({ plan: planFor('normal', ['w1', 'w2']), responses: { w2: new Error('offline failure') } });
  assert.deepEqual(stages(calls), ['planning', 'worker', 'worker', 'synthesis']);
  assert.equal(result.report.status, 'DEGRADED');
  assert.equal(result.report.successfulWorkers, 1);
  assert.equal(result.report.failedWorkers, 1);
  assert.equal(result.report.policy.synthesize, true);
  assert.match(calls[3].prompt, /Do not invent their contribution/);
  assert.match(result.finalOutput, /DEGRADED/);
  assert.match(result.finalOutput, /Missing: w2/);
});

for (const [complexity, ids] of [['simple', ['w1']], ['normal', ['w1', 'w2']]]) {
  await check(`${complexity} all-worker failure returns null with an auditable failure policy`, async () => {
    const responses = Object.fromEntries(ids.map((id) => [id, new Error('offline failure')]));
    const { result, calls } = await run({ plan: planFor(complexity, ids), responses });
    assert.equal(calls.length, 1 + ids.length);
    assert.ok(!stages(calls).includes('synthesis'));
    assert.equal(result.report.status, 'FAILED');
    assert.equal(result.report.synthesisAllowed, false);
    assert.equal(result.report.policy.synthesize, false);
    assert.equal(result.report.policy.reason, 'no_successful_workers');
    assert.equal(result.finalOutput, null);
    assert.equal(result.timings.synthesisMs, 0);
  });
}

console.log('\nRetrieval boundary');
for (const status of ['GROUNDED', 'UNGROUNDED', 'FAILED', undefined]) {
  await check(`requested retrieval stays on synthesis even when metadata is ${status ?? 'absent'}`, async () => {
    const metadata = status === undefined ? undefined : retrieval(status);
    const { result, calls } = await run({ plan: planFor('simple', ['research']), responses: { research: { text: raw, retrieval: metadata } } });
    assert.deepEqual(stages(calls), ['planning', 'worker', 'synthesis']);
    assert.deepEqual(calls[1].options.retrieval, { enabled: true });
    assert.equal(result.report.status, 'SUCCESS');
    assert.equal(result.report.policy.reason, 'retrieval_not_eligible');
    assert.deepEqual(result.workerResults[0].retrieval, metadata);
    assert.equal(result.finalOutput, final);
  });
}

await check('DEEP grounding sources, counts and presentation survive synthesis unchanged', async () => {
  const metadata = retrieval('GROUNDED');
  const { result, calls } = await run({ plan: planFor('deep', ['research']), responses: { research: { text: raw, retrieval: metadata } } });
  assert.deepEqual(stages(calls), ['planning', 'worker', 'synthesis']);
  assert.deepEqual(calls[1].options.retrieval, { enabled: true });
  assert.equal(result.report.evidenceLabel, 'PARTIALLY_GROUNDED');
  assert.deepEqual(result.report.retrieval, { specialistsAsked: 1, specialistsGrounded: 1, sourcesFound: 1, queryCount: 1, sources: metadata.sources });
  assert.match(result.finalOutput, /PARTIALLY GROUNDED/);
  assert.ok(result.finalOutput.endsWith(final));
});

await check('an unselected retrieval-capable worker does not block an ordinary SIMPLE run', async () => {
  const { result, calls } = await run();
  assert.ok(roster.some((worker) => worker.evidenceCapable));
  assert.deepEqual(stages(calls), ['planning', 'worker']);
  assert.equal(result.report.policy.synthesize, false);
});

await check('unexpected retrieval metadata also prevents direct delivery', async () => {
  const { result, calls } = await run({ responses: { w1: { text: raw, retrieval: retrieval('GROUNDED') } } });
  assert.equal(calls[1].options.retrieval, undefined);
  assert.deepEqual(stages(calls), ['planning', 'worker', 'synthesis']);
  assert.equal(result.report.policy.reason, 'retrieval_not_eligible');
});

console.log('\nInvalid and ambiguous facts');
for (const [label, output] of [['empty', ''], ['whitespace', ' \n\t\u00a0'], ['missing', undefined], ['null', null], ['non-string', 42]]) {
  await check(`${label} output from an invalid adapter cannot take the direct path`, async () => {
    const { result, calls } = await run({ responses: { w1: { text: output } } });
    assert.deepEqual(stages(calls), ['planning', 'worker', 'synthesis']);
    assert.equal(result.report.policy.reason, 'invalid_worker_output');
    assert.equal(result.finalOutput, final);
    assert.equal(result.report.status, 'SUCCESS', 'do not redefine the legacy report for a broken adapter');
  });
}

for (const [label, overrides] of [
  ['zero assignments', { assignmentIds: [], workerResults: [] }],
  ['unknown complexity', { complexity: 'unknown' }],
  ['unknown retrieval requirement', { retrievalRequired: undefined }],
  ['unknown status', { status: 'unknown' }],
  ['missing result', { workerResults: [] }],
  ['extra result', { workerResults: [{ agentId: 'w1', output: raw }, { agentId: 'w2', output: raw }] }],
  ['mismatched result identity', { workerResults: [{ agentId: 'w2', output: raw }] }],
  ['output accompanied by an error', { workerResults: [{ agentId: 'w1', output: raw, error: 'failed' }] }],
]) {
  await check(`${label} preserves synthesis instead of assuming direct eligibility`, () => {
    assert.equal(deriveExecutionPolicy(facts(overrides)).synthesize, true);
  });
}

await check('changing worker provider/model does not change execution policy', async () => {
  for (const [provider, model] of [['openai', 'gpt-fixture'], ['claude', 'claude-fixture'], ['gemini', 'gemini-fixture']]) {
    const workers = [{ ...roster[0], provider, model }];
    const { result, calls } = await run({ workers });
    assert.deepEqual(stages(calls), ['planning', 'worker']);
    assert.equal(calls[1].provider, provider);
    assert.equal(calls[1].options.model, model);
    assert.equal(result.report.policy.reason, 'simple_single_specialist_direct_delivery');
  }
});

await check('policy has no provider/model identifiers or runtime imports', () => {
  const source = readFileSync(new URL('./src/agents/policy.ts', import.meta.url), 'utf8');
  const compiled = readFileSync(new URL('./dist/agents/policy.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:ProviderName|provider|model|openai|claude|gemini)\b/i);
  assert.doesNotMatch(compiled, /^import\s|\b(?:require|import)\s*\(/m);
});

console.log('\nRecorded readiness fixture replay (offline, no new benchmarks)');
for (const id of ['SIMPLE-2', 'SIMPLE-3']) {
  await check(`${id} recorded Worker is delivered verbatim with the original task context`, async () => {
    const fixture = JSON.parse(readFileSync(new URL(`./regressions/simple-readiness/2026-09-05/${id}.json`, import.meta.url), 'utf8'));
    const { workers } = resolveRoster(['business_strategist', 'market_researcher', 'brand_creative']);
    const recorded = fixture.result.workerResults[0];
    const { result, calls } = await run({ plan: fixture.result.plan, workers, originalTask: fixture.task, responses: { [recorded.agentId]: { text: recorded.output } } });
    assert.deepEqual(stages(calls), ['planning', 'worker']);
    assert.equal(calls[1].prompt, buildWorkerPrompt(fixture.task, recorded.mission));
    assert.equal(result.finalOutput, recorded.output);
    assert.equal(result.report.policy.reason, 'simple_single_specialist_direct_delivery');
  });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
