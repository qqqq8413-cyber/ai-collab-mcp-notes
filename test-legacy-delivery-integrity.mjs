// Offline tests for F11 / F12 / F13: replay, Round 1 snapshots and delivery keep execution facts.
//
// No provider is called. Every dispatcher is an injected fake, and every concurrency case
// uses an explicit barrier rather than a timer.
import assert from 'node:assert/strict';
import {
  deriveRound1Report,
  replaySynthesis,
  runOrchestrator,
  runSynthesisStage,
  toRound1Snapshot,
} from './dist/modes/orchestrator.js';

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

const ROSTER = [
  { id: 'strategy', provider: 'openai', model: 'm-a', role: 'Business strategy' },
  { id: 'risk', provider: 'claude', model: 'm-b', role: 'Risk and legal' },
  { id: 'brand', provider: 'gemini', model: 'm-c', role: 'Brand and creative' },
  { id: 'research', provider: 'gemini', model: 'm-r', role: 'Market research', evidenceCapable: true },
];
const TASK = 'Decide whether to open a second studio next year.';
const OUTPUT = {
  strategy: 'STRATEGY-OUTPUT: expand in Q2, payback in 14 months.',
  risk: 'RISK-OUTPUT: the lease term exceeds the revenue visibility.',
  brand: 'BRAND-OUTPUT: the second location dilutes the current positioning.',
  research: 'RESEARCH-OUTPUT: two competitors opened second sites last year.',
};
const RAW = '﻿ \t# Result\r\n\r\n| 結果 | é |\r\n  untouched  \n';
const SYNTH = 'SYNTHESIZED-ANSWER';
const PROVISIONAL = 'PROVISIONAL-ANSWER: open the second studio in Q2.';
const REVISED = 'REVISED-OUTPUT: payback moves to 19 months.';
const DECISION = 'DECISION-ANSWER: defer to Q4.';
const TRUNCATED = {
  openai: { state: 'TRUNCATED', providerReason: 'length' },
  claude: { state: 'TRUNCATED', providerReason: 'max_tokens' },
  gemini: { state: 'TRUNCATED', providerReason: 'MAX_TOKENS' },
};
const partial = (id) => `PARTIAL-${id}: the answer stops mid`;
const truncated = (id) => ({ text: partial(id), completion: TRUNCATED[ROSTER.find((w) => w.id === id).provider] });

const issue = {
  targetAgentId: 'strategy',
  sourceRef: 'risk:p1',
  challenge: 'The payback figure ignores the lease term.',
  decisionSensitive: true,
  action: 'peer_challenge',
};
const GATE = PROVISIONAL + '\n\n```json\n' + JSON.stringify({ collaborationIssues: [issue] }) + '\n```';

const planFor = (ids, complexity) => ({
  complexity,
  requiredCapabilities: ['reasoning'],
  assignments: ids.map((agentId) => ({ agentId, mission: `Mission for ${agentId}`, priority: 'high' })),
  requiresRedTeam: false,
  reason: 'Offline fixture plan',
});

/** A scripted dispatcher. `workers` scripts Round 1 by agent id, `stages` every other stage. */
function dispatcher({ plan, workers = {}, stages = {}, hold = {} } = {}) {
  const calls = [];
  const call = async (provider, prompt, options) => {
    const stage = options.stage;
    assert.ok(stage, 'every call must declare its stage');
    calls.push({ stage, provider, prompt, options });
    if (hold[stage]) await hold[stage]();
    let response;
    if (stage === 'round1_worker') {
      const worker = ROSTER.find((w) => w.role === options.system);
      assert.ok(worker, 'the fake identifies the worker from its role');
      response = Object.hasOwn(workers, worker.id) ? workers[worker.id] : { text: OUTPUT[worker.id] };
    } else if (Object.hasOwn(stages, stage)) {
      response = stages[stage];
    } else {
      response = {
        planning: { text: JSON.stringify(plan) },
        synthesis: { text: SYNTH },
        synthesis_gate: { text: PROVISIONAL },
        round2_worker: { text: REVISED },
        decision_synthesis: { text: DECISION },
      }[stage];
    }
    if (response instanceof Error) throw response;
    return { provider, model: options.model, ...response };
  };
  return { call, calls };
}

async function live({ ids, complexity, workers, stages, collaboration } = {}) {
  const plan = planFor(ids, complexity);
  const { call, calls } = dispatcher({ plan, workers, stages });
  const result = await runOrchestrator({
    task: TASK,
    orchestrator: { provider: 'openai', model: 'chief' },
    synthesizer: { provider: 'openai', model: 'synth' },
    workers: ROSTER,
    call,
    ...(collaboration ? { experimental: { collaboration } } : {}),
  });
  return { result, calls };
}

async function replay(snapshot, { stages, collaboration, hold, synthesizer = { provider: 'openai', model: 'synth' } } = {}) {
  const { call, calls } = dispatcher({ stages, hold });
  const result = await replaySynthesis(snapshot, { synthesizer, collaboration, call });
  return { result, calls };
}

const synthesisStages = (calls) => calls.map((c) => c.stage).filter((s) => s !== 'planning' && s !== 'round1_worker');

function barrier() {
  let enter;
  let release;
  const entered = new Promise((resolve) => { enter = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  return { entered, release, hold: async () => { enter(); await gate; } };
}

/** Waits for the barrier, or for the run to settle first, so a rejected run cannot hang. */
const untilHeld = (pending, b) => Promise.race([b.entered, pending.then(() => {}, () => {})]);

const result = (agentId, fields) => ({
  agentId,
  provider: ROSTER.find((w) => w.id === agentId).provider,
  mission: `Mission for ${agentId}`,
  ...fields,
});
const snapshotOf = (complexity, ids, results) => ({
  task: TASK,
  complexity,
  agentOrder: ids,
  workers: ROSTER,
  workerResults: results,
});

/* ============================================================ F11 */
console.log('\nF11: replay synthesis eligibility is the live policy');

await check('replay of a Round 1 where every worker failed dispatches no synthesis', async () => {
  const snapshot = snapshotOf('normal', ['strategy', 'risk'], [
    result('strategy', { error: 'Error: boom' }),
    result('risk', { error: 'Error: boom' }),
  ]);
  const { result: r, calls } = await replay(snapshot);
  assert.equal(calls.length, 0);
  assert.equal(r.report.status, 'FAILED');
  assert.equal(r.report.synthesisAllowed, false);
  assert.deepEqual(r.report.policy, { topology: 'collaborative', synthesize: false, reason: 'no_successful_workers' });
  assert.equal(r.finalOutput, null);
  assert.equal(r.timings.synthesisMs, 0);
  assert.equal(Object.hasOwn(r, 'collaboration'), false);
  assert.match(r.report.notes.join(' '), /Synthesis skipped: no_successful_workers/);
});

const PARITY = [
  ['all workers failed', { ids: ['strategy', 'risk'], complexity: 'normal', workers: { strategy: new Error('boom'), risk: new Error('boom') } }, 0],
  ['all workers truncated', { ids: ['strategy', 'risk', 'brand'], complexity: 'normal', workers: { strategy: truncated('strategy'), risk: truncated('risk'), brand: truncated('brand') } }, 0],
  ['simple single-worker direct delivery', { ids: ['strategy'], complexity: 'simple', workers: { strategy: { text: RAW } } }, 0],
  ['simple single worker truncated', { ids: ['strategy'], complexity: 'simple', workers: { strategy: truncated('strategy') } }, 0],
  ['simple evidence worker is not direct-delivered', { ids: ['research'], complexity: 'simple', workers: { research: { text: RAW, retrieval: { status: 'UNGROUNDED', queries: [], sources: [], sourcesFound: 0 } } } }, 1],
  ['normal success', { ids: ['strategy', 'risk', 'brand'], complexity: 'normal' }, 1],
  ['deep success', { ids: ['strategy', 'risk', 'brand'], complexity: 'deep' }, 1],
  ['degraded with one usable worker', { ids: ['strategy', 'risk'], complexity: 'normal', workers: { risk: new Error('boom') } }, 1],
  ['one complete, one truncated', { ids: ['strategy', 'risk'], complexity: 'normal', workers: { risk: truncated('risk') } }, 1],
  ['all failed with collaboration enabled', { ids: ['strategy', 'risk'], complexity: 'deep', workers: { strategy: new Error('boom'), risk: new Error('boom') }, collaboration: { enabled: true } }, 0],
  ['direct delivery with collaboration enabled', { ids: ['strategy'], complexity: 'simple', workers: { strategy: { text: RAW } }, collaboration: { enabled: true } }, 0],
];

for (const [label, scenario, expectedSyntheses] of PARITY) {
  await check(`live and replay agree: ${label}`, async () => {
    const liveRun = await live(scenario);
    const snapshot = toRound1Snapshot(liveRun.result, TASK, ROSTER);
    const replayRun = await replay(snapshot, { collaboration: scenario.collaboration });
    assert.deepEqual(replayRun.result.report, liveRun.result.report, 'same Round 1 facts, same report and policy');
    assert.equal(replayRun.result.finalOutput, liveRun.result.finalOutput);
    assert.deepEqual(synthesisStages(replayRun.calls), synthesisStages(liveRun.calls));
    assert.equal(synthesisStages(liveRun.calls).length, expectedSyntheses);
    assert.equal(Object.hasOwn(replayRun.result, 'collaboration'), Object.hasOwn(liveRun.result, 'collaboration'));
    if (expectedSyntheses === 0) {
      assert.equal(liveRun.result.timings.synthesisMs, 0);
      assert.equal(replayRun.result.timings.synthesisMs, 0);
      assert.equal(Object.hasOwn(replayRun.result, 'collaboration'), false);
    }
  });
}

await check('direct-delivery replay returns the exact worker text without a synthesis call', async () => {
  const snapshot = snapshotOf('simple', ['strategy'], [result('strategy', { output: RAW })]);
  const { result: r, calls } = await replay(snapshot);
  assert.equal(calls.length, 0);
  assert.equal(r.finalOutput, RAW);
  assert.equal(r.report.policy.reason, 'simple_single_specialist_direct_delivery');
});

await check('normal and deep replays still synthesize exactly once', async () => {
  for (const complexity of ['normal', 'deep']) {
    const ids = ['strategy', 'risk', 'brand'];
    const snapshot = snapshotOf(complexity, ids, ids.map((id) => result(id, { output: OUTPUT[id] })));
    const { result: r, calls } = await replay(snapshot);
    assert.deepEqual(calls.map((c) => c.stage), ['synthesis']);
    assert.equal(r.report.policy.reason, 'non_simple_execution');
    assert.ok(r.finalOutput.endsWith(SYNTH));
  }
});

await check('a degraded replay synthesizes from the usable worker only', async () => {
  const snapshot = snapshotOf('normal', ['strategy', 'risk'], [
    result('strategy', { output: OUTPUT.strategy }),
    result('risk', { error: 'Error: boom' }),
  ]);
  const { result: r, calls } = await replay(snapshot);
  assert.equal(r.report.status, 'DEGRADED');
  assert.equal(r.report.policy.synthesize, true);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].prompt.includes(OUTPUT.strategy));
  assert.match(calls[0].prompt, /1 specialist\(s\) failed/);
});

await check('enabling collaboration cannot override a no-synthesis policy, live or replayed', async () => {
  for (const collaboration of [{ enabled: true }, { enabled: true, disableRound2: true }]) {
    const failedRound1 = snapshotOf('deep', ['strategy', 'risk'], [
      result('strategy', { error: 'Error: boom' }),
      result('risk', { error: 'Error: boom' }),
    ]);
    const direct = snapshotOf('simple', ['strategy'], [result('strategy', { output: RAW })]);
    for (const snapshot of [failedRound1, direct]) {
      const { result: r, calls } = await replay(snapshot, { collaboration });
      assert.equal(calls.length, 0);
      assert.equal(Object.hasOwn(r, 'collaboration'), false);
    }
    const { calls } = await live({ ids: ['strategy', 'risk'], complexity: 'deep', workers: { strategy: new Error('x'), risk: new Error('y') }, collaboration });
    assert.deepEqual(synthesisStages(calls), []);
  }
});

console.log('\nF11: the exported synthesis stage fails closed');

const stageInput = (complexity, ids, results, overrides = {}) => {
  const report = deriveRound1Report(complexity, ids, ROSTER, results);
  return {
    task: TASK,
    complexity,
    agentOrder: ids,
    workers: ROSTER,
    workerResults: results,
    report,
    synthesizer: { provider: 'openai', model: 'synth' },
    ...overrides,
  };
};

await check('an all-failed Round 1 passed straight to runSynthesisStage is refused with no call', async () => {
  const { call, calls } = dispatcher();
  const failedResults = [result('strategy', { error: 'x' }), result('risk', { error: 'y' })];
  await assert.rejects(runSynthesisStage({ ...stageInput('normal', ['strategy', 'risk'], failedResults), call }), /Synthesis refused/);
  assert.equal(calls.length, 0);
});

await check('a forged report cannot unlock synthesis over failed facts', async () => {
  const { call, calls } = dispatcher();
  const failedResults = [result('strategy', { error: 'x' }), result('risk', { error: 'y' })];
  const forged = { ...deriveRound1Report('normal', ['strategy', 'risk'], ROSTER, failedResults), status: 'SUCCESS', synthesisAllowed: true };
  forged.policy = { topology: 'collaborative', synthesize: true, reason: 'non_simple_execution' };
  await assert.rejects(runSynthesisStage({ ...stageInput('normal', ['strategy', 'risk'], failedResults), report: forged, call }), /Synthesis refused/);
  assert.equal(calls.length, 0);
});

await check('a report that forbids synthesis is honoured even when the facts would allow it', async () => {
  const { call, calls } = dispatcher();
  const ok = [result('strategy', { output: OUTPUT.strategy }), result('risk', { output: OUTPUT.risk })];
  const input = stageInput('normal', ['strategy', 'risk'], ok);
  for (const report of [
    { ...input.report, synthesisAllowed: false },
    { ...input.report, policy: { ...input.report.policy, synthesize: false } },
    { ...input.report, status: 'DEGRADED' },
  ]) {
    await assert.rejects(runSynthesisStage({ ...input, report, call }), /Synthesis refused/);
  }
  assert.equal(calls.length, 0);
});

await check('direct-delivery facts are not synthesized through the exported stage either', async () => {
  const { call, calls } = dispatcher();
  const input = stageInput('simple', ['strategy'], [result('strategy', { output: RAW })]);
  await assert.rejects(runSynthesisStage({ ...input, call }), /simple_single_specialist_direct_delivery/);
  assert.equal(calls.length, 0);
});

await check('eligible facts still synthesize through the exported stage', async () => {
  const { call, calls } = dispatcher();
  const ok = [result('strategy', { output: OUTPUT.strategy }), result('risk', { output: OUTPUT.risk })];
  const out = await runSynthesisStage({ ...stageInput('normal', ['strategy', 'risk'], ok), call });
  assert.equal(calls.length, 1);
  assert.equal(out.finalOutput, SYNTH);
});

await check('a replay naming an agent with no worker is refused before any call', async () => {
  const snapshot = snapshotOf('normal', ['strategy', 'ghost'], [result('strategy', { output: OUTPUT.strategy })]);
  const { call, calls } = dispatcher();
  await assert.rejects(replaySynthesis(snapshot, { synthesizer: { provider: 'openai', model: 'synth' }, call }), /not a known worker/);
  assert.equal(calls.length, 0);
});

/* ============================================================ F12 */
console.log('\nF12: a Round 1 snapshot is an independent fact set');

function sourceRun() {
  const workers = ROSTER.map((w) => ({ ...w }));
  const run = {
    plan: planFor(['strategy', 'research'], 'deep'),
    workerResults: [
      result('strategy', { output: OUTPUT.strategy }),
      result('research', {
        output: OUTPUT.research,
        retrieval: {
          status: 'GROUNDED',
          queries: ['second studio payback'],
          queryCount: 1,
          sources: [{ url: 'https://example.com/a', title: 'A' }],
          sourcesFound: 1,
          raw: { webSearchQueries: ['second studio payback'], groundingChunks: [{ web: { uri: 'https://example.com/a', title: 'A' } }] },
        },
      }),
    ],
  };
  return { run, workers };
}
const fingerprint = (snapshot) => JSON.stringify(snapshot);

await check('A: changing a source worker output does not move the snapshot', () => {
  const { run, workers } = sourceRun();
  const snapshot = toRound1Snapshot(run, TASK, workers);
  const before = fingerprint(snapshot);
  run.workerResults[0].output = 'MUTATED';
  run.workerResults[1].mission = 'MUTATED';
  assert.equal(snapshot.workerResults[0].output, OUTPUT.strategy);
  assert.equal(fingerprint(snapshot), before);
});

await check('B: changing a source worker provider, model or role does not move the snapshot', () => {
  const { run, workers } = sourceRun();
  const snapshot = toRound1Snapshot(run, TASK, workers);
  const before = fingerprint(snapshot);
  Object.assign(workers[0], { provider: 'gemini', model: 'other', role: 'other', evidenceCapable: true });
  run.workerResults[0].provider = 'gemini';
  assert.equal(snapshot.workers[0].provider, 'openai');
  assert.equal(fingerprint(snapshot), before);
});

await check('C: changing nested retrieval queries does not move the snapshot', () => {
  const { run, workers } = sourceRun();
  const snapshot = toRound1Snapshot(run, TASK, workers);
  const before = fingerprint(snapshot);
  run.workerResults[1].retrieval.queries.push('injected');
  run.workerResults[1].retrieval.queries[0] = 'rewritten';
  assert.deepEqual(snapshot.workerResults[1].retrieval.queries, ['second studio payback']);
  assert.equal(fingerprint(snapshot), before);
});

await check('D: changing nested retrieval source objects does not move the snapshot', () => {
  const { run, workers } = sourceRun();
  const snapshot = toRound1Snapshot(run, TASK, workers);
  const before = fingerprint(snapshot);
  run.workerResults[1].retrieval.sources[0].url = 'https://evil.example';
  run.workerResults[1].retrieval.sources.push({ url: 'https://extra.example' });
  run.workerResults[1].retrieval.status = 'FAILED';
  assert.equal(fingerprint(snapshot), before);
  assert.equal(deriveRound1Report('deep', snapshot.agentOrder, snapshot.workers, [...snapshot.workerResults]).evidenceLabel, 'PARTIALLY_GROUNDED');
});

await check('E: changing retrieval.raw does not move the snapshot; non-cloneable raw is refused', () => {
  const { run, workers } = sourceRun();
  const snapshot = toRound1Snapshot(run, TASK, workers);
  const before = fingerprint(snapshot);
  run.workerResults[1].retrieval.raw.groundingChunks[0].web.uri = 'https://evil.example';
  run.workerResults[1].retrieval.raw.webSearchQueries.length = 0;
  assert.equal(fingerprint(snapshot), before);

  const hostile = sourceRun();
  hostile.run.workerResults[1].retrieval.raw = { read: () => 'live handle' };
  assert.throws(() => toRound1Snapshot(hostile.run, TASK, hostile.workers), /plain data/);
});

await check('F: pushing to or splicing source arrays does not move the snapshot', () => {
  const { run, workers } = sourceRun();
  const snapshot = toRound1Snapshot(run, TASK, workers);
  const before = fingerprint(snapshot);
  workers.push({ id: 'intruder', provider: 'openai', role: 'x' });
  workers.splice(0, 2);
  run.workerResults.push(result('brand', { output: 'late' }));
  run.workerResults.splice(0, 1);
  run.plan.assignments.reverse();
  run.plan.assignments.push({ agentId: 'brand', mission: 'late', priority: 'high' });
  run.plan.complexity = 'simple';
  assert.deepEqual(snapshot.agentOrder, ['strategy', 'research']);
  assert.equal(snapshot.complexity, 'deep');
  assert.equal(fingerprint(snapshot), before);
});

await check('G: the returned snapshot is deep-frozen, so its facts cannot be rewritten', () => {
  const { run, workers } = sourceRun();
  const snapshot = toRound1Snapshot(run, TASK, workers);
  const before = fingerprint(snapshot);
  assert.throws(() => { snapshot.workerResults[0].output = 'x'; }, TypeError);
  assert.throws(() => { snapshot.workers.push({}); }, TypeError);
  assert.throws(() => { snapshot.agentOrder[0] = 'brand'; }, TypeError);
  assert.throws(() => { snapshot.workerResults[1].retrieval.raw.groundingChunks[0].web.uri = 'x'; }, TypeError);
  assert.throws(() => { snapshot.complexity = 'simple'; }, TypeError);
  assert.equal(fingerprint(snapshot), before);
});

await check('H: mutating the supplied snapshot and settings mid-replay changes nothing replayed', async () => {
  const ids = ['strategy', 'risk', 'brand'];
  const snapshot = snapshotOf('deep', ids, ids.map((id) => result(id, { output: OUTPUT[id] })));
  snapshot.workers = ROSTER.map((w) => ({ ...w }));
  const synthesizer = { provider: 'openai', model: 'synth' };
  const collaboration = { enabled: true };
  const b = barrier();
  const { call, calls } = dispatcher({ stages: { synthesis_gate: { text: GATE } }, hold: { synthesis_gate: b.hold } });
  const pending = replaySynthesis(snapshot, { synthesizer, collaboration, call });
  await untilHeld(pending, b);
  assert.equal(calls.length, 1, 'the gate call is pending');

  Object.assign(snapshot.workers[0], { provider: 'gemini', model: 'hijacked', role: 'hijacked' });
  snapshot.workerResults[0].output = 'MUTATED-PREVIOUS-OUTPUT';
  snapshot.workerResults[0].mission = 'MUTATED-MISSION';
  snapshot.workerResults[1].output = 'MUTATED-RISK';
  snapshot.agentOrder.reverse();
  snapshot.task = 'MUTATED-TASK';
  synthesizer.model = 'hijacked-synth';
  collaboration.disableRound2 = true;
  b.release();

  const r = await pending;
  assert.deepEqual(calls.map((c) => c.stage), ['synthesis_gate', 'round2_worker', 'decision_synthesis']);
  const round2 = calls[1];
  assert.equal(round2.provider, 'openai');
  assert.equal(round2.options.model, 'm-a');
  assert.equal(round2.options.system, 'Business strategy');
  assert.ok(round2.prompt.includes(OUTPUT.strategy));
  assert.ok(round2.prompt.includes(OUTPUT.risk.slice(0, 20)));
  assert.ok(round2.prompt.includes(TASK));
  for (const leaked of ['MUTATED', 'hijacked']) assert.ok(!round2.prompt.includes(leaked));
  assert.equal(calls[2].options.model, 'synth');
  assert.ok(!calls[2].prompt.includes('MUTATED'));
  assert.equal(r.collaboration.status, 'COMPLETED');
  assert.ok(r.finalOutput.endsWith(DECISION));
});

await check('H: the replay reads the supplied snapshot once, before the first await', async () => {
  const reads = new Map();
  const watched = (target, path) => new Proxy(target, {
    get(obj, key, receiver) {
      if (typeof key === 'string') reads.set(`${path}.${key}`, (reads.get(`${path}.${key}`) ?? 0) + 1);
      return Reflect.get(obj, key, receiver);
    },
  });
  const ids = ['strategy', 'risk'];
  const plain = snapshotOf('normal', ids, ids.map((id) => result(id, { output: OUTPUT[id] })));
  const snapshot = watched(plain, 'snapshot');
  const b = barrier();
  const { call } = dispatcher({ hold: { synthesis: b.hold } });
  const pending = replaySynthesis(snapshot, { synthesizer: { provider: 'openai', model: 'synth' }, call });
  await untilHeld(pending, b);
  const atDispatch = new Map(reads);
  b.release();
  await pending;
  assert.deepEqual(reads, atDispatch, 'no read of the caller snapshot after dispatch');
  for (const key of ['task', 'complexity', 'agentOrder', 'workers', 'workerResults']) {
    assert.equal(reads.get(`snapshot.${key}`), 1, `snapshot.${key} is read exactly once`);
  }
});

/* ============================================================ F13 */
console.log('\nF13: a proven truncated answer is never delivered as complete');

await check('a truncated simple worker is not direct-delivered', async () => {
  const { result: r, calls } = await live({ ids: ['strategy'], complexity: 'simple', workers: { strategy: truncated('strategy') } });
  assert.deepEqual(calls.map((c) => c.stage), ['planning', 'round1_worker']);
  assert.equal(r.report.status, 'FAILED');
  assert.equal(r.report.policy.synthesize, false);
  assert.equal(r.finalOutput, null);
  const worker = r.workerResults[0];
  assert.equal(Object.hasOwn(worker, 'output'), false);
  assert.equal(worker.truncatedOutput, partial('strategy'));
  assert.deepEqual(worker.completion, TRUNCATED.openai);
  assert.match(worker.error, /token limit \(length\)/);
});

await check('all workers truncated -> FAILED, zero synthesis calls', async () => {
  const ids = ['strategy', 'risk', 'brand'];
  const { result: r, calls } = await live({ ids, complexity: 'normal', workers: Object.fromEntries(ids.map((id) => [id, truncated(id)])) });
  assert.equal(r.report.status, 'FAILED');
  assert.deepEqual(synthesisStages(calls), []);
  assert.equal(r.finalOutput, null);
  assert.deepEqual(r.workerResults.map((w) => w.completion.providerReason), ['length', 'max_tokens', 'MAX_TOKENS']);
});

await check('one complete + one truncated -> DEGRADED, synthesis sees only the complete output', async () => {
  const { result: r, calls } = await live({ ids: ['strategy', 'risk'], complexity: 'normal', workers: { risk: truncated('risk') } });
  assert.equal(r.report.status, 'DEGRADED');
  assert.deepEqual(r.report.failures.map((f) => f.agentId), ['risk']);
  const synthesis = calls.find((c) => c.stage === 'synthesis');
  assert.ok(synthesis.prompt.includes(OUTPUT.strategy));
  assert.ok(!synthesis.prompt.includes(partial('risk')), 'the fragment never reaches the specialist block');
  assert.match(r.finalOutput, /DEGRADED — 1\/2 specialists returned/);
});

await check('a truncated evidence worker does not ground the answer; its retrieval stays on record', async () => {
  const grounded = { status: 'GROUNDED', queries: ['q'], queryCount: 1, sources: [{ url: 'https://example.com/a' }], sourcesFound: 1 };
  const { result: r } = await live({
    ids: ['strategy', 'research'],
    complexity: 'deep',
    workers: { research: { ...truncated('research'), retrieval: grounded } },
  });
  assert.equal(r.report.status, 'DEGRADED');
  assert.equal(r.report.evidenceLabel, 'CONDITIONAL');
  assert.equal(r.report.retrieval.specialistsAsked, 1);
  assert.equal(r.report.retrieval.specialistsGrounded, 0);
  assert.equal(r.workerResults[1].retrieval.status, 'GROUNDED');
});

await check('a truncated ordinary synthesis is refused, live and replayed', async () => {
  const stages = { synthesis: { text: 'PARTIAL-SYNTHESIS', completion: TRUNCATED.openai } };
  const ids = ['strategy', 'risk'];
  await assert.rejects(live({ ids, complexity: 'normal', stages }), (err) => {
    assert.match(err.message, /Synthesis output is incomplete: .*\(length\)/);
    assert.ok(!err.message.includes('PARTIAL-SYNTHESIS'));
    return true;
  });
  const snapshot = snapshotOf('normal', ids, ids.map((id) => result(id, { output: OUTPUT[id] })));
  await assert.rejects(replay(snapshot, { stages }), /Synthesis output is incomplete/);
});

await check('a truncated collaboration gate is neither delivered nor parsed for an issue', async () => {
  const stages = { synthesis_gate: { text: GATE, completion: TRUNCATED.openai } };
  const calls = [];
  const plan = planFor(['strategy', 'risk', 'brand'], 'deep');
  const fake = dispatcher({ plan, stages });
  await assert.rejects(
    runOrchestrator({ task: TASK, orchestrator: { provider: 'openai', model: 'chief' }, synthesizer: { provider: 'openai', model: 'synth' }, workers: ROSTER, call: async (...a) => { calls.push(a[2].stage); return fake.call(...a); }, experimental: { collaboration: { enabled: true } } }),
    /Synthesis output is incomplete/
  );
  assert.ok(calls.includes('synthesis_gate'));
  assert.ok(!calls.includes('round2_worker'), 'the partial issue block is not acted on');
  assert.ok(!calls.includes('decision_synthesis'));
});

await check('a truncated Round 2 takes the existing Round 2 failure fallback', async () => {
  const { result: r, calls } = await live({
    ids: ['strategy', 'risk', 'brand'],
    complexity: 'deep',
    collaboration: { enabled: true },
    stages: { synthesis_gate: { text: GATE }, round2_worker: { text: 'PARTIAL-REVISION', completion: TRUNCATED.openai } },
  });
  assert.deepEqual(synthesisStages(calls), ['synthesis_gate', 'round2_worker']);
  assert.equal(r.collaboration.status, 'FAILED');
  assert.equal(r.collaboration.reason, 'round2_worker_failed');
  assert.match(r.collaboration.round2.error, /Round 2 output is incomplete: .*\(length\)/);
  assert.ok(r.finalOutput.endsWith(PROVISIONAL));
  assert.ok(!r.finalOutput.includes('PARTIAL-REVISION'));
});

await check('a truncated decision synthesis takes the provisional-answer fallback', async () => {
  const { result: r, calls } = await live({
    ids: ['strategy', 'risk', 'brand'],
    complexity: 'deep',
    collaboration: { enabled: true },
    stages: { synthesis_gate: { text: GATE }, decision_synthesis: { text: 'PARTIAL-DECISION', completion: TRUNCATED.openai } },
  });
  assert.deepEqual(synthesisStages(calls), ['synthesis_gate', 'round2_worker', 'decision_synthesis']);
  assert.equal(r.collaboration.status, 'FAILED');
  assert.equal(r.collaboration.reason, 'decision_synthesis_failed');
  assert.equal(r.collaboration.answerSource, 'round1_provisional');
  assert.ok(r.finalOutput.endsWith(PROVISIONAL));
  assert.ok(!r.finalOutput.includes('PARTIAL-DECISION'));
});

await check('a truncated plan is refused before it is parsed or executed', async () => {
  const plan = planFor(['strategy'], 'simple');
  const { call, calls } = dispatcher({ plan, stages: { planning: { text: JSON.stringify(plan), completion: TRUNCATED.claude } } });
  await assert.rejects(
    runOrchestrator({ task: TASK, orchestrator: { provider: 'claude', model: 'chief' }, workers: ROSTER, call }),
    /planning output is incomplete: .*\(max_tokens\)/
  );
  assert.deepEqual(calls.map((c) => c.stage), ['planning']);
});

await check('COMPLETE, UNKNOWN and absent completion keep the existing delivery', async () => {
  for (const completion of [{ state: 'COMPLETE', providerReason: 'stop' }, { state: 'UNKNOWN', providerReason: 'content_filter' }, undefined]) {
    const response = completion ? { text: RAW, completion } : { text: RAW };
    const { result: r, calls } = await live({ ids: ['strategy'], complexity: 'simple', workers: { strategy: response } });
    assert.deepEqual(calls.map((c) => c.stage), ['planning', 'round1_worker']);
    assert.equal(r.finalOutput, RAW);
    assert.equal(r.report.status, 'SUCCESS');
    if (completion) assert.deepEqual(r.workerResults[0].completion, completion);
    else assert.equal(Object.hasOwn(r.workerResults[0], 'completion'), false, 'no fabricated completion fact');
  }
  const { result: r } = await live({ ids: ['strategy', 'risk'], complexity: 'normal', stages: { synthesis: { text: SYNTH, completion: { state: 'UNKNOWN', providerReason: 'tool_calls' } } } });
  assert.equal(r.finalOutput, SYNTH);
});

await check('a replayed snapshot that still carries truncated text is settled the same way as live', async () => {
  const ids = ['strategy', 'risk'];
  const snapshot = snapshotOf('normal', ids, [
    result('strategy', { output: OUTPUT.strategy }),
    result('risk', { output: partial('risk'), completion: TRUNCATED.claude }),
  ]);
  const { result: r, calls } = await replay(snapshot);
  assert.equal(r.report.status, 'DEGRADED');
  assert.ok(!calls[0].prompt.includes(partial('risk')));

  const allTruncated = snapshotOf('simple', ['strategy'], [result('strategy', { output: partial('strategy'), completion: TRUNCATED.openai })]);
  const single = await replay(allTruncated);
  assert.equal(single.calls.length, 0);
  assert.equal(single.result.finalOutput, null);
  assert.equal(single.result.report.status, 'FAILED');
});

await check('a Round 1 result carrying both output and error never enters the specialist block', async () => {
  const ids = ['strategy', 'risk'];
  const snapshot = snapshotOf('normal', ids, [
    result('strategy', { output: OUTPUT.strategy }),
    result('risk', { output: 'LEAKED-FAILED-OUTPUT', error: 'Error: failed' }),
  ]);
  const { result: r, calls } = await replay(snapshot);
  assert.equal(r.report.status, 'DEGRADED');
  assert.ok(!calls[0].prompt.includes('LEAKED-FAILED-OUTPUT'));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
