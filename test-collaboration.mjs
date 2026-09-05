// Offline tests for Experimental Milestone 2-A (targeted peer challenge).
//
// No API calls. The dispatcher is injected and every call states its own stage, so call
// counts, ordering and failure paths are asserted directly rather than inferred.
import assert from 'node:assert/strict';
import { runOrchestrator, buildOutputBanner, buildRunReport } from './dist/modes/orchestrator.js';
import { deriveExecutionPolicy } from './dist/agents/policy.js';
import {
  parseGateOutput,
  validateIssues,
  selectIssue,
  buildPeerExcerpt,
  isRound2Eligible,
  segmentOutput,
  segmentAll,
  resolveSourceRef,
  DEFAULT_PEER_EXCERPT_CHARS,
} from './dist/agents/collaboration.js';
import { replaySynthesis } from './dist/modes/orchestrator.js';

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
  { id: 'ops', provider: 'openai', model: 'm-d', role: 'Operations' },
];
const TASK = 'Decide whether to open a second studio next year.';

const OUTPUT = {
  strategy: 'STRATEGY-OUTPUT: expand in Q2, payback in 14 months.',
  risk: 'RISK-OUTPUT: the lease term exceeds the revenue visibility.',
  brand: 'BRAND-OUTPUT: the second location dilutes the current positioning.',
  ops: 'OPS-OUTPUT: hiring lead time is four months.',
};

const planFor = (ids, complexity = 'deep') => ({
  complexity,
  requiredCapabilities: ['reasoning'],
  assignments: ids.map((agentId) => ({ agentId, mission: `Mission for ${agentId}`, priority: 'high' })),
  requiresRedTeam: false,
  reason: 'Offline fixture plan',
});

const issue = (over = {}) => ({
  targetAgentId: 'strategy',
  sourceRef: 'risk:p1',
  challenge: 'The payback figure ignores the lease term.',
  decisionSensitive: true,
  action: 'peer_challenge',
  ...over,
});

const block = (issues) => '\n\n```json\n' + JSON.stringify({ collaborationIssues: issues }) + '\n```';

const PROVISIONAL = 'PROVISIONAL-ANSWER: open the second studio in Q2.';
const DECISION = 'DECISION-ANSWER: defer to Q4 pending a shorter lease.';
const REVISED = 'REVISED-OUTPUT: payback moves to 19 months under the real lease term.';

/**
 * Drives a full run against a scripted dispatcher.
 * `fail` maps a stage to an Error the mock should throw for it.
 */
async function run({
  ids = ['strategy', 'risk', 'brand'],
  complexity = 'deep',
  workers = ROSTER,
  gateText = PROVISIONAL,
  outputs = OUTPUT,
  workerErrors = {},
  collaboration,
  fail = {},
  peerExcerptChars,
  disableRound2,
} = {}) {
  const plan = planFor(ids, complexity);
  const calls = [];
  const call = async (provider, prompt, options) => {
    const stage = options.stage;
    assert.ok(stage, 'every orchestrator call must declare its stage');
    calls.push({ stage, provider, prompt, options });
    if (fail[stage]) throw fail[stage];
    if (stage === 'planning') return { provider, model: options.model, text: JSON.stringify(plan) };
    if (stage === 'synthesis' || stage === 'synthesis_gate') {
      return { provider, model: options.model, text: gateText };
    }
    if (stage === 'decision_synthesis') return { provider, model: options.model, text: DECISION };
    if (stage === 'round2_worker') return { provider, model: options.model, text: REVISED };
    const worker = workers.find((w) => w.role === options.system);
    assert.ok(worker, 'mock must identify the worker from its role');
    if (workerErrors[worker.id]) throw workerErrors[worker.id];
    return { provider, model: options.model, text: outputs[worker.id] ?? `${worker.id}-output` };
  };

  const experimental =
    collaboration === undefined
      ? undefined
      : {
          collaboration: {
            enabled: collaboration,
            ...(peerExcerptChars ? { peerExcerptChars } : {}),
            ...(disableRound2 ? { disableRound2 } : {}),
          },
        };

  const result = await runOrchestrator({
    task: TASK,
    orchestrator: { provider: 'openai', model: 'chief' },
    synthesizer: { provider: 'openai', model: 'synth' },
    workers,
    call,
    ...(experimental ? { experimental } : {}),
  });
  return { result, calls, stages: calls.map((c) => c.stage) };
}

/* ==================================================== stage instrumentation */
console.log('\nStage instrumentation');

await check('collaboration off produces the pre-M2 stage sequence', async () => {
  const { stages } = await run({ collaboration: false });
  assert.deepEqual(stages, ['planning', 'round1_worker', 'round1_worker', 'round1_worker', 'synthesis']);
});

await check('an active gate is a distinct stage from ordinary synthesis', async () => {
  const { stages } = await run({ collaboration: true });
  assert.deepEqual(stages, ['planning', 'round1_worker', 'round1_worker', 'round1_worker', 'synthesis_gate']);
});

await check('the full collaboration path names all five stages', async () => {
  const { stages } = await run({ collaboration: true, gateText: PROVISIONAL + block([issue()]) });
  assert.deepEqual(stages, [
    'planning',
    'round1_worker',
    'round1_worker',
    'round1_worker',
    'synthesis_gate',
    'round2_worker',
    'decision_synthesis',
  ]);
});

await check('no stage is ever inferred from the presence of a system prompt', async () => {
  const { calls } = await run({ collaboration: true, gateText: PROVISIONAL + block([issue()]) });
  // A round 2 worker carries a system prompt and a decision synthesis does not; both are
  // synthesis-class or worker-class only because they say so.
  assert.equal(calls.find((c) => c.stage === 'round2_worker').options.system, 'Business strategy');
  assert.equal(calls.find((c) => c.stage === 'decision_synthesis').options.system, undefined);
  assert.ok(calls.every((c) => typeof c.options.stage === 'string'));
});

/* ========================================================= call-count ceiling */
console.log('\nLogical call ceiling');

await check('three specialists with no Round 2 cost N + 2', async () => {
  const { calls } = await run({ collaboration: true });
  assert.equal(calls.length, 3 + 2);
});

await check('three specialists with Round 2 cost N + 4 = 7', async () => {
  const { calls } = await run({ collaboration: true, gateText: PROVISIONAL + block([issue()]) });
  assert.equal(calls.length, 3 + 4);
});

await check('four specialists — the deep cap — cost N + 4 = 8 and never more', async () => {
  const { calls, stages } = await run({
    ids: ['strategy', 'risk', 'brand', 'ops'],
    collaboration: true,
    gateText: PROVISIONAL + block([issue()]),
  });
  assert.equal(calls.length, 8);
  assert.equal(stages.filter((s) => s === 'round1_worker').length, 4);
  assert.equal(stages.filter((s) => s === 'round2_worker').length, 1);
  assert.equal(stages.filter((s) => s === 'decision_synthesis').length, 1);
});

await check('several eligible issues still produce exactly one Round 2 call', async () => {
  const issues = [
    issue({ targetAgentId: 'brand', sourceRef: 'risk' }),
    issue({ targetAgentId: 'risk', sourceRef: 'strategy' }),
    issue({ targetAgentId: 'strategy', sourceRef: 'brand' }),
  ];
  const { stages, result } = await run({ collaboration: true, gateText: PROVISIONAL + block(issues) });
  assert.equal(stages.filter((s) => s === 'round2_worker').length, 1);
  assert.equal(result.collaboration.issues.eligible, 3);
});

await check('collaboration never adds a second round', async () => {
  const { stages } = await run({ collaboration: true, gateText: PROVISIONAL + block([issue()]) });
  assert.equal(stages.filter((s) => s === 'synthesis_gate').length, 1);
  assert.equal(stages.filter((s) => s === 'decision_synthesis').length, 1);
  assert.ok(!stages.includes('synthesis'));
});

/* ================================================== best-effort block parsing */
console.log('\nBest-effort parsing — the deliverable never depends on it');

await check('no block leaves the answer exactly as written', () => {
  const parsed = parseGateOutput(PROVISIONAL);
  assert.equal(parsed.answer, PROVISIONAL);
  assert.equal(parsed.status, 'absent');
  assert.deepEqual(parsed.rawIssues, []);
});

await check('a valid block is removed from the answer', () => {
  const parsed = parseGateOutput(PROVISIONAL + block([issue()]));
  assert.equal(parsed.answer, PROVISIONAL);
  assert.equal(parsed.status, 'parsed');
  assert.equal(parsed.rawIssues.length, 1);
});

await check('malformed JSON degrades to the answer plus a note, not a failure', () => {
  const parsed = parseGateOutput(PROVISIONAL + '\n\n```json\n{"collaborationIssues": [ {,, ]\n```');
  assert.equal(parsed.answer, PROVISIONAL);
  assert.equal(parsed.status, 'malformed');
  assert.deepEqual(parsed.rawIssues, []);
  assert.ok(parsed.note.includes('not valid JSON'));
});

await check('a JSON array instead of an object is schema_invalid', () => {
  const parsed = parseGateOutput(PROVISIONAL + '\n\n```json\n["collaborationIssues"]\n```');
  assert.equal(parsed.status, 'schema_invalid');
  assert.equal(parsed.answer, PROVISIONAL);
});

await check('an object without the issues array is schema_invalid', () => {
  const parsed = parseGateOutput(PROVISIONAL + '\n\n```json\n{"collaborationIssues": "none"}\n```');
  assert.equal(parsed.status, 'schema_invalid');
  assert.equal(parsed.answer, PROVISIONAL);
});

await check('a JSON code sample inside a real answer is not swallowed as metadata', () => {
  const answer = PROVISIONAL + '\n\nExample config:\n\n```json\n{"retries": 3}\n```';
  const parsed = parseGateOutput(answer);
  assert.equal(parsed.status, 'absent');
  assert.equal(parsed.answer, answer);
});

await check('an unfenced trailing block is still recognised', () => {
  const parsed = parseGateOutput(PROVISIONAL + '\n' + JSON.stringify({ collaborationIssues: [issue()] }));
  assert.equal(parsed.status, 'parsed');
  assert.equal(parsed.answer, PROVISIONAL);
  assert.equal(parsed.rawIssues.length, 1);
});

await check('a block with no answer in front of it still delivers text', () => {
  const only = '```json\n{"collaborationIssues": []}\n```';
  const parsed = parseGateOutput(only);
  assert.equal(parsed.answer, only);
  assert.notEqual(parsed.answer.trim(), '');
  assert.equal(parsed.status, 'schema_invalid');
});

await check('a malformed block in a live run still delivers the provisional answer', async () => {
  const { result, stages } = await run({
    collaboration: true,
    gateText: PROVISIONAL + '\n\n```json\n{"collaborationIssues": [ broken\n```',
  });
  assert.ok(result.finalOutput.endsWith(PROVISIONAL));
  assert.equal(result.collaboration.status, 'SKIPPED');
  assert.equal(result.collaboration.reason, 'block_malformed');
  assert.equal(result.collaboration.answerSource, 'round1_provisional');
  assert.ok(!stages.includes('round2_worker'));
});

/* ================================================ parser edge cases (required) */
console.log('\nParser edge cases, end to end');

await check('EDGE 1: a user-facing JSON example at the end is not stripped', async () => {
  const answer = PROVISIONAL + '\n\nUse this config:\n\n```json\n{"retries": 3, "timeout": 30}\n```';
  const { result, stages } = await run({ collaboration: true, gateText: answer });
  const banner = buildOutputBanner(result.report);
  assert.equal(result.finalOutput.slice(banner.length), answer, 'the answer must survive intact');
  assert.equal(result.collaboration.parse.status, 'absent');
  assert.ok(!stages.includes('round2_worker'));
});

await check('EDGE 2: a valid block is parsed, removed from the answer, and acted on', async () => {
  const { result, calls } = await run({ collaboration: true, gateText: PROVISIONAL + block([issue()]) });
  assert.equal(result.collaboration.parse.status, 'parsed');
  assert.equal(result.collaboration.provisionalAnswer, PROVISIONAL, 'answer preserved');
  assert.ok(!result.collaboration.provisionalAnswer.includes('collaborationIssues'), 'block removed');
  assert.ok(!result.finalOutput.includes('collaborationIssues'), 'block never reaches the user');
  assert.equal(result.collaboration.issues.emitted, 1);
  assert.equal(result.collaboration.issues.valid, 1);
  assert.equal(result.collaboration.status, 'COMPLETED');
  assert.ok(calls.some((c) => c.stage === 'round2_worker'));
});

await check('EDGE 3: a malformed collaboration-like block degrades without failing the run', async () => {
  const { result, stages } = await run({
    collaboration: true,
    gateText: PROVISIONAL + '\n\n```json\n{"collaborationIssues": [{"targetAgentId": "strategy",,,\n```',
  });
  const banner = buildOutputBanner(result.report);
  assert.equal(result.finalOutput.slice(banner.length), PROVISIONAL, 'provisional answer still delivered');
  assert.ok(!stages.includes('round2_worker'), 'no Round 2');
  assert.equal(result.collaboration.parse.status, 'malformed', 'parse failure recorded');
  assert.ok(result.collaboration.parse.note.includes('not valid JSON'));
  assert.equal(result.collaboration.status, 'SKIPPED');
  assert.equal(result.collaboration.reason, 'block_malformed');
  assert.equal(result.report.status, 'SUCCESS', 'the run itself is unaffected');
});

await check('EDGE 4: a block with no answer before it falls back gracefully', async () => {
  const only = '```json\n{"collaborationIssues": [' + JSON.stringify(issue()) + ']}\n```';
  const { result, stages } = await run({ collaboration: true, gateText: only });
  const banner = buildOutputBanner(result.report);
  assert.equal(result.finalOutput.slice(banner.length), only, 'the raw response is delivered, never an empty answer');
  assert.notEqual(result.finalOutput.slice(banner.length).trim(), '');
  assert.equal(result.collaboration.parse.status, 'schema_invalid');
  assert.ok(result.collaboration.parse.note.includes('no answer before it'));
  assert.ok(!stages.includes('round2_worker'));
  assert.equal(result.report.status, 'SUCCESS');
});

/* ==================================================== issue schema validation */
console.log('\nIssue validation');

const ctx = {
  successfulAgentIds: ['strategy', 'risk', 'brand'],
  chunksByAgent: segmentAll([
    { agentId: 'strategy', output: OUTPUT.strategy },
    { agentId: 'risk', output: OUTPUT.risk },
    { agentId: 'brand', output: OUTPUT.brand },
  ]),
};
const rejectionFor = (over) => validateIssues([issue(over)], ctx).rejected[0].reason;

await check('a well-formed issue validates', () => {
  const { valid, rejected } = validateIssues([issue()], ctx);
  assert.equal(valid.length, 1);
  assert.deepEqual(rejected, []);
});

await check('an unknown targetAgentId is rejected', () => {
  assert.match(rejectionFor({ targetAgentId: 'nobody' }), /not a successful Round 1 specialist/);
});

await check('an unknown sourceRef is rejected', () => {
  assert.match(rejectionFor({ sourceRef: 'nobody:p1' }), /does not name a successful Round 1 specialist/);
});

await check('an agent challenging itself is rejected as self-review', () => {
  assert.match(rejectionFor({ sourceRef: 'strategy:p1' }), /self-review, not a peer challenge/);
});

await check('an empty challenge is rejected', () => {
  assert.match(rejectionFor({ challenge: '   ' }), /challenge is missing or empty/);
});

await check('a non-boolean decisionSensitive is rejected', () => {
  assert.match(rejectionFor({ decisionSensitive: 'yes' }), /decisionSensitive is not a boolean/);
});

await check('an unknown action is rejected', () => {
  assert.match(rejectionFor({ action: 'escalate' }), /not a known action/);
});

await check('a non-object entry is rejected', () => {
  assert.match(validateIssues(['nope'], ctx).rejected[0].reason, /not a JSON object/);
});

await check('a failed specialist cannot be challenged', () => {
  const { rejected } = validateIssues([issue({ targetAgentId: 'ops' })], ctx);
  assert.match(rejected[0].reason, /not a successful Round 1 specialist/);
});

await check('valid and invalid issues are separated, not discarded together', () => {
  const { valid, rejected } = validateIssues([issue({ targetAgentId: 'nobody' }), issue()], ctx);
  assert.equal(valid.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].index, 0);
});

await check('only decision-sensitive peer challenges are eligible', () => {
  assert.equal(isRound2Eligible(issue()), true);
  assert.equal(isRound2Eligible(issue({ decisionSensitive: false })), false);
  assert.equal(isRound2Eligible(issue({ action: 'needs_evidence' })), false);
});

/* ====================================================== deterministic selection */
console.log('\nDeterministic selection');

const order = ['strategy', 'risk', 'brand'];

await check('selection follows assignment order of the challenged specialist', () => {
  const chosen = selectIssue(
    [issue({ targetAgentId: 'brand' }), issue({ targetAgentId: 'risk', sourceRef: 'brand' })],
    order
  );
  assert.equal(chosen.targetAgentId, 'risk');
});

await check('a tie on target is broken by the peer', () => {
  const chosen = selectIssue(
    [issue({ targetAgentId: 'brand', sourceRef: 'risk' }), issue({ targetAgentId: 'brand', sourceRef: 'strategy' })],
    order
  );
  assert.equal(chosen.sourceRef, 'strategy');
});

await check('a tie on both is broken by emission order', () => {
  const first = issue({ challenge: 'first' });
  const second = issue({ challenge: 'second' });
  assert.equal(selectIssue([first, second], order).challenge, 'first');
});

await check('selection is stable across repeated calls and input order', () => {
  const issues = [issue({ targetAgentId: 'brand' }), issue({ targetAgentId: 'risk', sourceRef: 'brand' }), issue()];
  const a = selectIssue(issues, order);
  const b = selectIssue(issues, order);
  assert.deepEqual(a, b);
  assert.deepEqual(selectIssue([...issues].reverse(), order), a);
});

await check('no eligible issue selects nothing', () => {
  assert.equal(selectIssue([issue({ decisionSensitive: false })], order), undefined);
  assert.equal(selectIssue([], order), undefined);
});

/* ============================================================== peer excerpt */
console.log('\nPeer excerpt — bounded, deterministic, auditable');

await check('a chunk within the limit is quoted whole', () => {
  const [chunk] = segmentOutput('short answer');
  const e = buildPeerExcerpt('risk', chunk, 100);
  assert.equal(e.text, 'short answer');
  assert.equal(e.truncated, false);
  assert.equal(e.chunkId, 'p1');
  assert.deepEqual([e.startChar, e.endChar], [0, 'short answer'.length]);
});

await check('an over-long chunk is truncated and says so', () => {
  const [chunk] = segmentOutput('x'.repeat(50));
  const e = buildPeerExcerpt('risk', chunk, 10);
  assert.equal(e.text.length, 10);
  assert.equal(e.truncated, true);
  assert.equal(e.endChar, 10);
  assert.equal(e.charLimit, 10);
});

await check('excerpt offsets point into the peer\'s full output, not into the chunk', () => {
  const output = 'first para\n\nsecond para that is challenged';
  const chunks = segmentOutput(output);
  const e = buildPeerExcerpt('risk', chunks[1], 500);
  assert.equal(e.chunkId, 'p2');
  assert.equal(output.slice(e.startChar, e.endChar), 'second para that is challenged');
});

await check('the excerpt limit is a recorded parameter, not a hidden constant', async () => {
  const { result } = await run({
    collaboration: true,
    peerExcerptChars: 25,
    gateText: PROVISIONAL + block([issue()]),
  });
  assert.equal(result.collaboration.round2.peerExcerpt.charLimit, 25);
  assert.equal(result.collaboration.round2.peerExcerpt.truncated, true);
});

await check('the default limit is recorded when the caller sets none', async () => {
  const { result } = await run({ collaboration: true, gateText: PROVISIONAL + block([issue()]) });
  assert.equal(result.collaboration.round2.peerExcerpt.charLimit, DEFAULT_PEER_EXCERPT_CHARS);
});

/* ======================================================== selective context */
console.log('\nSelective peer context');

await check('Round 2 sees the task, its own mission and output, one excerpt and one challenge', async () => {
  const { calls } = await run({ collaboration: true, gateText: PROVISIONAL + block([issue()]) });
  const prompt = calls.find((c) => c.stage === 'round2_worker').prompt;
  assert.ok(prompt.includes(TASK));
  assert.ok(prompt.includes('Mission for strategy'));
  assert.ok(prompt.includes(OUTPUT.strategy));
  assert.ok(prompt.includes(OUTPUT.risk));
  assert.ok(prompt.includes('The payback figure ignores the lease term.'));
});

await check('Round 2 is never given the other specialists it was not challenged from', async () => {
  const { calls } = await run({ collaboration: true, gateText: PROVISIONAL + block([issue()]) });
  const prompt = calls.find((c) => c.stage === 'round2_worker').prompt;
  assert.ok(!prompt.includes(OUTPUT.brand), 'brand output must not be broadcast into Round 2');
  assert.ok(!prompt.includes(PROVISIONAL), 'the provisional answer is not peer context');
});

await check('Round 2 keeps the challenged specialist in its own role', async () => {
  const { calls } = await run({ collaboration: true, gateText: PROVISIONAL + block([issue()]) });
  const round2 = calls.find((c) => c.stage === 'round2_worker');
  assert.equal(round2.provider, 'openai');
  assert.equal(round2.options.model, 'm-a');
  assert.equal(round2.options.system, 'Business strategy');
});

/* ============================================================ retrieval is off */
console.log('\nRound 2 retrieval is off');

await check('no Round 2 call requests retrieval, even for an evidence-capable specialist', async () => {
  const workers = ROSTER.map((w) => (w.id === 'strategy' ? { ...w, evidenceCapable: true } : w));
  const { calls } = await run({ workers, collaboration: true, gateText: PROVISIONAL + block([issue()]) });
  const round1 = calls.find((c) => c.stage === 'round1_worker' && c.options.system === 'Business strategy');
  const round2 = calls.find((c) => c.stage === 'round2_worker');
  assert.deepEqual(round1.options.retrieval, { enabled: true }, 'Round 1 retrieval is unchanged');
  assert.equal(round2.options.retrieval, undefined, 'Round 2 must not retrieve');
});

await check('needs_evidence is recorded and never acted on', async () => {
  const { result, stages } = await run({
    collaboration: true,
    gateText: PROVISIONAL + block([issue({ action: 'needs_evidence' })]),
  });
  assert.equal(result.collaboration.status, 'SKIPPED');
  assert.equal(result.collaboration.reason, 'no_decision_sensitive_peer_challenge');
  assert.equal(result.collaboration.issues.valid, 1);
  assert.equal(result.collaboration.issues.eligible, 0);
  assert.equal(result.collaboration.issues.recorded[0].action, 'needs_evidence');
  assert.ok(!stages.includes('round2_worker'));
  assert.ok(result.collaboration.notes.some((n) => n.includes('recorded only')));
});

/* ======================================================== failure semantics */
console.log('\nFailure semantics — the provisional answer is the floor');

await check('a failed Round 2 falls back to the provisional answer', async () => {
  const { result, stages } = await run({
    collaboration: true,
    gateText: PROVISIONAL + block([issue()]),
    fail: { round2_worker: new Error('provider exploded') },
  });
  assert.ok(result.finalOutput.endsWith(PROVISIONAL));
  assert.equal(result.collaboration.status, 'FAILED');
  assert.equal(result.collaboration.reason, 'round2_worker_failed');
  assert.equal(result.collaboration.answerSource, 'round1_provisional');
  assert.match(result.collaboration.round2.error, /provider exploded/);
  assert.ok(!stages.includes('decision_synthesis'));
  assert.equal(result.report.status, 'SUCCESS', 'RunStatus keeps its Round 1 meaning');
});

await check('a failed decision synthesis falls back and keeps the revision on record', async () => {
  const { result } = await run({
    collaboration: true,
    gateText: PROVISIONAL + block([issue()]),
    fail: { decision_synthesis: new Error('synth exploded') },
  });
  assert.ok(result.finalOutput.endsWith(PROVISIONAL));
  assert.equal(result.collaboration.status, 'FAILED');
  assert.equal(result.collaboration.reason, 'decision_synthesis_failed');
  assert.equal(result.collaboration.round2.output, REVISED);
  assert.equal(result.report.status, 'SUCCESS');
});

await check('a DEGRADED Round 1 never reaches the gate', async () => {
  const { result, calls, stages } = await run({
    collaboration: true,
    workerErrors: { brand: new Error('down') },
  });
  assert.equal(result.report.status, 'DEGRADED');
  assert.equal(result.collaboration.status, 'NOT_TRIGGERED');
  assert.equal(result.collaboration.reason, 'round1_status_degraded');
  assert.ok(stages.includes('synthesis'));
  assert.ok(!stages.includes('synthesis_gate'));
  assert.ok(!calls.find((c) => c.stage === 'synthesis').prompt.includes('collaborationIssues'));
});

await check('a FAILED Round 1 keeps the existing behaviour', async () => {
  const { result, stages } = await run({
    collaboration: true,
    workerErrors: { strategy: new Error('a'), risk: new Error('b'), brand: new Error('c') },
  });
  assert.equal(result.report.status, 'FAILED');
  assert.equal(result.finalOutput, null);
  assert.deepEqual(stages, ['planning', 'round1_worker', 'round1_worker', 'round1_worker']);
  assert.equal(result.collaboration, undefined, 'a failed run returns the pre-M2 shape');
});

await check('a non-deep run is never gated', async () => {
  const { result, stages } = await run({ ids: ['strategy', 'risk'], complexity: 'normal', collaboration: true });
  assert.equal(result.collaboration.status, 'NOT_TRIGGERED');
  assert.match(result.collaboration.reason, /complexity_not_deep/);
  assert.ok(stages.includes('synthesis'));
});

await check('a deep run with one specialist has no peer to challenge from', async () => {
  const { result, stages } = await run({ ids: ['strategy'], collaboration: true });
  assert.equal(result.collaboration.status, 'NOT_TRIGGERED');
  assert.equal(result.collaboration.reason, 'single_specialist_no_peer');
  assert.ok(!stages.includes('synthesis_gate'));
});

await check('an issue naming a valid but non-eligible pair skips cleanly', async () => {
  const { result } = await run({
    collaboration: true,
    gateText: PROVISIONAL + block([issue({ decisionSensitive: false })]),
  });
  assert.equal(result.collaboration.status, 'SKIPPED');
  assert.equal(result.collaboration.reason, 'no_decision_sensitive_peer_challenge');
});

await check('an unroutable issue skips and records why', async () => {
  const { result } = await run({
    collaboration: true,
    gateText: PROVISIONAL + block([issue({ targetAgentId: 'ghost' })]),
  });
  assert.equal(result.collaboration.status, 'SKIPPED');
  assert.equal(result.collaboration.reason, 'no_valid_issue');
  assert.equal(result.collaboration.issues.rejected.length, 1);
  assert.ok(result.collaboration.notes.some((n) => n.includes('was dropped')));
});

/* ================================================== evidence invariant */
console.log('\nEvidence invariant — collaboration cannot raise the label');

await check('the evidence label is identical with collaboration on and off', async () => {
  const off = await run({ collaboration: false });
  const on = await run({ collaboration: true, gateText: PROVISIONAL + block([issue()]) });
  assert.equal(off.result.report.evidenceLabel, on.result.report.evidenceLabel);
  assert.equal(on.result.report.evidenceLabel, 'HYPOTHESIS');
});

await check('the banner is identical with collaboration on and off', async () => {
  const off = await run({ collaboration: false });
  const on = await run({ collaboration: true, gateText: PROVISIONAL + block([issue()]) });
  assert.equal(buildOutputBanner(off.result.report), buildOutputBanner(on.result.report));
  assert.ok(on.result.finalOutput.startsWith(buildOutputBanner(on.result.report)));
});

await check("Round 2's answer never enters workerResults or the retrieval summary", async () => {
  const { result } = await run({ collaboration: true, gateText: PROVISIONAL + block([issue()]) });
  assert.equal(result.workerResults.length, 3);
  assert.ok(!result.workerResults.some((r) => r.output === REVISED));
  assert.equal(result.report.requestedWorkers, 3);
  assert.equal(result.report.successfulWorkers, 3);
  assert.equal(result.report.retrieval, undefined);
});

await check('no collaboration path can produce an EVIDENCE_BACKED label', async () => {
  const runs = [
    await run({ collaboration: true, gateText: PROVISIONAL + block([issue()]) }),
    await run({ collaboration: true, gateText: PROVISIONAL + block([issue({ action: 'needs_evidence' })]) }),
    await run({ collaboration: true }),
  ];
  for (const r of runs) {
    assert.notEqual(r.result.report.evidenceLabel, 'EVIDENCE_BACKED');
    assert.ok(!JSON.stringify(r.result).includes('EVIDENCE_BACKED'));
  }
});

await check('the decision synthesis is told the round gathered no evidence', async () => {
  const { calls } = await run({ collaboration: true, gateText: PROVISIONAL + block([issue()]) });
  const prompt = calls.find((c) => c.stage === 'decision_synthesis').prompt;
  assert.ok(prompt.includes('no new external evidence'));
  assert.ok(prompt.includes('Do not describe anything as verified'));
});

/* ============================================== default-off / payload parity */
console.log('\nDefault off');

await check('omitting experimental returns the pre-M2 payload shape', async () => {
  const { result } = await run({});
  assert.equal(result.collaboration, undefined);
  assert.deepEqual(Object.keys(result), ['plan', 'planningAdjustments', 'workerResults', 'report', 'finalOutput', 'timings']);
});

await check('enabled:false is identical to omitting it', async () => {
  const absent = await run({});
  const off = await run({ collaboration: false });
  assert.deepEqual(Object.keys(absent.result), Object.keys(off.result));
  assert.deepEqual(absent.stages, off.stages);
  assert.equal(absent.result.finalOutput, off.result.finalOutput);
});

await check('a disabled run never emits the gate appendix', async () => {
  const { calls } = await run({ collaboration: false });
  assert.ok(!calls.find((c) => c.stage === 'synthesis').prompt.includes('collaborationIssues'));
});

await check('an enabled run that completes reports its answer source', async () => {
  const { result } = await run({ collaboration: true, gateText: PROVISIONAL + block([issue()]) });
  assert.equal(result.collaboration.status, 'COMPLETED');
  assert.equal(result.collaboration.answerSource, 'round2_decision_synthesis');
  assert.ok(result.finalOutput.endsWith(DECISION));
  assert.equal(result.collaboration.selectedIssue.targetAgentId, 'strategy');
});

/* ================================================================== timings */
console.log('\nTimings');

await check('the existing timing fields keep their meaning and shape', async () => {
  const { result } = await run({ collaboration: true, gateText: PROVISIONAL + block([issue()]) });
  assert.deepEqual(Object.keys(result.timings), ['planningMs', 'workersMs', 'synthesisMs', 'totalMs']);
  for (const v of Object.values(result.timings)) assert.equal(typeof v, 'number');
});

await check('collaboration timings live in their own block', async () => {
  const { result } = await run({ collaboration: true, gateText: PROVISIONAL + block([issue()]) });
  const t = result.collaboration.timings;
  assert.equal(typeof t.gateMs, 'number');
  assert.equal(typeof t.round2Ms, 'number');
  assert.equal(typeof t.decisionSynthesisMs, 'number');
  assert.equal(typeof t.totalMs, 'number');
  assert.equal(t.gateMs, result.timings.synthesisMs, 'the gate is the run\'s synthesis call');
});

await check('collaboration totalMs accounts for the gate it added', async () => {
  const { result } = await run({ collaboration: true, gateText: PROVISIONAL + block([issue()]) });
  const t = result.collaboration.timings;
  assert.ok(
    t.totalMs >= t.gateMs + t.round2Ms + t.decisionSynthesisMs,
    'totalMs must not understate collaboration by leaving out the gate'
  );
  assert.ok(t.totalMs <= result.timings.totalMs);
});

await check('a run that never reaches the gate reports no gate time', async () => {
  const { result } = await run({ ids: ['strategy', 'risk'], complexity: 'normal', collaboration: true });
  assert.equal(result.collaboration.timings.gateMs, undefined);
  assert.ok(result.collaboration.timings.totalMs < 50, 'a non-triggered run costs no collaboration time');
});

await check('a skipped run still reports gate time and no round 2 time', async () => {
  const { result } = await run({ collaboration: true });
  assert.equal(typeof result.collaboration.timings.gateMs, 'number');
  assert.equal(result.collaboration.timings.round2Ms, undefined);
  assert.equal(result.collaboration.timings.decisionSynthesisMs, undefined);
});

/* ====================================================== chunk segmentation */
console.log('\nDeterministic chunk references');

const MULTI = {
  strategy: 'S-A: expand in Q2.\n\nS-B: payback in 14 months.\n\nS-C: hire two editors.',
  risk: 'R-A: the lease runs five years.\n\nR-B: revenue visibility is two quarters.',
  brand: 'B-A: positioning stays intact.',
};

await check('paragraphs become p1..pn in document order', () => {
  const chunks = segmentOutput(MULTI.strategy);
  assert.deepEqual(chunks.map((c) => c.id), ['p1', 'p2', 'p3']);
  assert.deepEqual(chunks.map((c) => c.index), [0, 1, 2]);
  assert.equal(chunks[1].text, 'S-B: payback in 14 months.');
});

await check('chunk offsets index the original output exactly', () => {
  for (const c of segmentOutput(MULTI.strategy)) {
    assert.equal(MULTI.strategy.slice(c.startChar, c.endChar), c.text);
  }
});

await check('segmentation is deterministic and free of empty chunks', () => {
  const messy = '\n\n  first  \n\n\n\n   \n\n second \n\n';
  const a = segmentOutput(messy);
  assert.deepEqual(a, segmentOutput(messy));
  assert.deepEqual(a.map((c) => c.text), ['first', 'second']);
});

await check('an answer with no blank line is a single chunk', () => {
  const chunks = segmentOutput('one line only');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].id, 'p1');
});

await check('an empty answer has no citable passage', () => {
  assert.deepEqual(segmentOutput('   \n\n  '), []);
});

const multiChunks = segmentAll([
  { agentId: 'strategy', output: MULTI.strategy },
  { agentId: 'risk', output: MULTI.risk },
  { agentId: 'brand', output: MULTI.brand },
]);

await check('a passage reference resolves to that passage', () => {
  const r = resolveSourceRef('risk:p2', multiChunks);
  assert.equal(r.ok, true);
  assert.equal(r.agentId, 'risk');
  assert.equal(r.chunk.text, 'R-B: revenue visibility is two quarters.');
});

await check('a bare agent id is rejected when the answer has several passages', () => {
  const r = resolveSourceRef('risk', multiChunks);
  assert.equal(r.ok, false);
  assert.match(r.reason, /names a specialist but no passage/);
});

await check('a bare agent id is accepted only when it is unambiguous', () => {
  const r = resolveSourceRef('brand', multiChunks);
  assert.equal(r.ok, true);
  assert.equal(r.chunk.id, 'p1');
});

await check('a passage id that does not exist is rejected with the available ones', () => {
  const r = resolveSourceRef('risk:p9', multiChunks);
  assert.equal(r.ok, false);
  assert.match(r.reason, /available: p1, p2/);
});

await check('an unknown agent in a reference is rejected', () => {
  assert.equal(resolveSourceRef('ghost:p1', multiChunks).ok, false);
});

await check('Round 2 receives the referenced passage, not the opening one', async () => {
  const { calls, result } = await run({
    collaboration: true,
    outputs: MULTI,
    gateText: PROVISIONAL + block([issue({ sourceRef: 'risk:p2' })]),
  });
  const prompt = calls.find((c) => c.stage === 'round2_worker').prompt;
  assert.ok(prompt.includes('R-B: revenue visibility is two quarters.'), 'the cited passage must be quoted');
  assert.ok(!prompt.includes('R-A: the lease runs five years.'), 'the opening passage must not be substituted');
  assert.equal(result.collaboration.round2.peerExcerpt.chunkId, 'p2');
});

await check('the audit trail records which passage was quoted', async () => {
  const { result } = await run({
    collaboration: true,
    outputs: MULTI,
    gateText: PROVISIONAL + block([issue({ sourceRef: 'risk:p2' })]),
  });
  const e = result.collaboration.round2.peerExcerpt;
  assert.deepEqual(
    { agentId: e.agentId, chunkId: e.chunkId, chunkIndex: e.chunkIndex, truncated: e.truncated },
    { agentId: 'risk', chunkId: 'p2', chunkIndex: 1, truncated: false }
  );
  assert.equal(MULTI.risk.slice(e.startChar, e.endChar), 'R-B: revenue visibility is two quarters.');
});

await check('the gate is shown the references it is allowed to use', async () => {
  const { calls, result } = await run({ collaboration: true, outputs: MULTI });
  const gate = calls.find((c) => c.stage === 'synthesis_gate').prompt;
  for (const ref of ['strategy:p1', 'strategy:p2', 'strategy:p3', 'risk:p1', 'risk:p2', 'brand:p1']) {
    assert.ok(gate.includes(ref), `gate prompt must offer ${ref}`);
  }
  assert.deepEqual(result.collaboration.chunkMap, {
    strategy: ['p1', 'p2', 'p3'],
    risk: ['p1', 'p2'],
    brand: ['p1'],
  });
});

/* ============================================== gate emits at most one challenge */
console.log('\nAt most one peer challenge');

await check('the gate is instructed to emit at most one peer challenge', async () => {
  const { calls } = await run({ collaboration: true });
  const gate = calls.find((c) => c.stage === 'synthesis_gate').prompt;
  assert.ok(gate.includes('At most one "peer_challenge" may be emitted.'));
  assert.ok(gate.includes('greatest effect on the final decision'));
});

await check('a gate that returns several is corrected deterministically and recorded', async () => {
  const issues = [
    issue({ targetAgentId: 'brand', sourceRef: 'risk:p1' }),
    issue({ targetAgentId: 'risk', sourceRef: 'brand:p1' }),
  ];
  const { result, stages } = await run({ collaboration: true, gateText: PROVISIONAL + block(issues) });
  assert.equal(stages.filter((s) => s === 'round2_worker').length, 1);
  assert.equal(result.collaboration.issues.eligible, 2);
  assert.ok(result.collaboration.notes.some((n) => n.includes('returned 2')));
  assert.equal(result.collaboration.selectedIssue.targetAgentId, 'risk');
});

await check('correcting the violation costs no extra model call', async () => {
  const issues = [issue({ targetAgentId: 'brand' }), issue({ targetAgentId: 'risk' }), issue()];
  const { calls } = await run({ collaboration: true, gateText: PROVISIONAL + block(issues) });
  assert.equal(calls.length, 3 + 4, 'no ranking call may be added');
});

/* =========================================== decision synthesis neutrality */
console.log('\nDecision synthesis neutrality');

await check('the decision contract refuses to privilege the revision', async () => {
  const { calls } = await run({ collaboration: true, gateText: PROVISIONAL + block([issue()]) });
  const prompt = calls.find((c) => c.stage === 'decision_synthesis').prompt;
  assert.ok(prompt.includes('not as inherently more correct because it is newer or revised'));
  assert.ok(prompt.includes('Revision, recency, or agreement between specialists is not evidence'));
  assert.ok(prompt.includes('against the original reasoning, the peer challenge, and the task constraints'));
});

await check('unresolved disagreement is still allowed to stand', async () => {
  const { calls } = await run({ collaboration: true, gateText: PROVISIONAL + block([issue()]) });
  const prompt = calls.find((c) => c.stage === 'decision_synthesis').prompt;
  assert.ok(prompt.includes('If the disagreement is unresolved, state it plainly'));
  assert.ok(!prompt.match(/reach (a )?consensus/i), 'consensus must never be required');
});

/* ================================================ B-prime and frozen replay */
console.log('\nArm B-prime and frozen Round 1 replay');

await check('disableRound2 runs the gate but never the peer exchange', async () => {
  const { result, stages } = await run({
    collaboration: true,
    gateText: PROVISIONAL + block([issue()]),
    disableRound2: true,
  });
  assert.deepEqual(stages, ['planning', 'round1_worker', 'round1_worker', 'round1_worker', 'synthesis_gate']);
  assert.equal(result.collaboration.status, 'SKIPPED');
  assert.equal(result.collaboration.reason, 'round2_disabled');
  assert.equal(result.collaboration.answerSource, 'round1_provisional');
  assert.ok(result.finalOutput.endsWith(PROVISIONAL));
});

await check('B-prime still records the issue it would have acted on', async () => {
  const { result } = await run({
    collaboration: true,
    gateText: PROVISIONAL + block([issue()]),
    disableRound2: true,
  });
  assert.equal(result.collaboration.selectedIssue.targetAgentId, 'strategy');
  assert.equal(result.collaboration.issues.eligible, 1);
});

// A frozen Round 1, replayed twice. Everything except the synthesis prompt is held still.
const snapshot = {
  task: TASK,
  complexity: 'deep',
  agentOrder: ['strategy', 'risk', 'brand'],
  workers: ROSTER,
  workerResults: ['strategy', 'risk', 'brand'].map((id) => ({
    agentId: id,
    provider: ROSTER.find((w) => w.id === id).provider,
    mission: `Mission for ${id}`,
    output: OUTPUT[id],
  })),
};

const replay = async (collaboration) => {
  const calls = [];
  const result = await replaySynthesis(snapshot, {
    synthesizer: { provider: 'openai', model: 'synth' },
    collaboration,
    call: async (provider, prompt, options) => {
      calls.push({ stage: options.stage, prompt });
      return { provider, model: options.model, text: PROVISIONAL + block([issue()]) };
    },
  });
  return { result, calls };
};

await check('a replay spends exactly one model call', async () => {
  const { calls } = await replay(undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].stage, 'synthesis');
});

await check('B and B-prime replay the same Round 1 and differ only by the appendix', async () => {
  const b = await replay(undefined);
  const bPrime = await replay({ enabled: true, disableRound2: true });
  assert.equal(bPrime.calls[0].stage, 'synthesis_gate');
  assert.ok(bPrime.calls[0].prompt.startsWith(b.calls[0].prompt), 'B-prime must extend B, not rewrite it');
  assert.ok(bPrime.calls[0].prompt.slice(b.calls[0].prompt.length).includes('collaborationIssues'));
});

await check('B-prime replay never fires a second round', async () => {
  const { calls, result } = await replay({ enabled: true, disableRound2: true });
  assert.equal(calls.length, 1);
  assert.equal(result.collaboration.reason, 'round2_disabled');
});

await check('a replay reproduces the run report from the frozen results', async () => {
  const { result } = await replay(undefined);
  assert.equal(result.report.status, 'SUCCESS');
  assert.equal(result.report.evidenceLabel, 'HYPOTHESIS');
  assert.equal(result.report.successfulWorkers, 3);
});

/* ============================================ paired provisional vs final */
console.log('\nPaired provisional / final capture');

await check('a completed run keeps both answers from the same task', async () => {
  const { result } = await run({ collaboration: true, gateText: PROVISIONAL + block([issue()]) });
  const banner = buildOutputBanner(result.report);
  assert.equal(result.collaboration.provisionalAnswer, PROVISIONAL);
  assert.equal(result.finalOutput.slice(banner.length), DECISION);
  assert.notEqual(result.collaboration.provisionalAnswer, result.finalOutput.slice(banner.length));
});

await check('a skipped run records the provisional answer it delivered', async () => {
  const { result } = await run({ collaboration: true });
  const banner = buildOutputBanner(result.report);
  assert.equal(result.collaboration.provisionalAnswer, PROVISIONAL);
  assert.equal(result.finalOutput.slice(banner.length), result.collaboration.provisionalAnswer);
});

await check('a failed round 2 records a provisional answer identical to what shipped', async () => {
  const { result } = await run({
    collaboration: true,
    gateText: PROVISIONAL + block([issue()]),
    fail: { round2_worker: new Error('boom') },
  });
  const banner = buildOutputBanner(result.report);
  assert.equal(result.finalOutput.slice(banner.length), result.collaboration.provisionalAnswer);
});

await check('a run that never reached the gate has no provisional answer to record', async () => {
  const { result } = await run({ ids: ['strategy', 'risk'], complexity: 'normal', collaboration: true });
  assert.equal(result.collaboration.provisionalAnswer, undefined);
  assert.equal(result.collaboration.chunkMap, undefined);
});

/* ============================================== control-arm prompt parity */
console.log('\nControl-arm parity');

// Arm B is the experiment's control. Extracting the prompt into variables to build the
// gate variant is exactly the kind of refactor that silently moves a newline, and a
// control that drifted is worse than no control -- every later C-vs-B difference would be
// partly this edit. Rebuilt here the pre-M2 way and compared byte for byte.
const preM2SynthesisPrompt = (task, succeeded, report) =>
  `Original task:
${task}

Results from each specialist:
${succeeded.map((r) => `### ${r.agentId}\nMission: ${r.mission}\nResult: ${r.output}`).join('\n\n')}
${
  report.status === 'DEGRADED'
    ? `\nNote: ${report.failedWorkers} specialist(s) failed and are missing from the above ` +
      `(${report.failures.map((f) => f.agentId).join(', ')}). Do not invent their contribution. ` +
      `Answer from what is present, and say plainly where the answer is thin because of it.\n`
    : ''
}
Synthesize these results into a single, coherent final answer to the original task.`;

await check('a disabled run sends the pre-M2 synthesis prompt byte for byte', async () => {
  const { calls, result } = await run({ collaboration: false });
  const actual = calls.find((c) => c.stage === 'synthesis').prompt;
  const succeeded = result.workerResults.filter((r) => r.output !== undefined);
  assert.equal(actual, preM2SynthesisPrompt(TASK, succeeded, result.report));
});

await check('a DEGRADED disabled run also sends the pre-M2 prompt byte for byte', async () => {
  const { calls, result } = await run({ collaboration: false, workerErrors: { brand: new Error('down') } });
  const actual = calls.find((c) => c.stage === 'synthesis').prompt;
  const succeeded = result.workerResults.filter((r) => r.output !== undefined);
  assert.equal(result.report.status, 'DEGRADED');
  assert.equal(actual, preM2SynthesisPrompt(TASK, succeeded, result.report));
});

await check('the gate prompt is the control prompt plus an appendix, nothing removed', async () => {
  const { calls, result } = await run({ collaboration: true });
  const gate = calls.find((c) => c.stage === 'synthesis_gate').prompt;
  const succeeded = result.workerResults.filter((r) => r.output !== undefined);
  const control = preM2SynthesisPrompt(TASK, succeeded, result.report);
  assert.ok(gate.startsWith(control), 'the gate must not alter the control prompt, only extend it');
  assert.ok(gate.slice(control.length).includes('collaborationIssues'));
});

/* ================================================ A/B/C/D experiment support */
console.log('\nSupport for the later A/B/C/D comparison');

await check('the banner can be stripped exactly, so arms can be compared blind', () => {
  // buildOutputBanner is pure over the report, and finalOutput is banner + text. An
  // evaluator can therefore recover the unlabelled answer deterministically. Without this
  // the comparison is unblinded: only arms B and C carry a run banner, so a rater can tell
  // which arm produced an answer from its first line.
  const report = buildRunReport('deep', [{ id: 'w1', provider: 'openai', role: 'r' }], [
    { agentId: 'w1', provider: 'openai', mission: 'm', output: 'x' },
  ]);
  const banner = buildOutputBanner(report);
  assert.notEqual(banner, '', 'an unevidenced deep run must carry a banner');
  const finalOutput = banner + 'ANSWER BODY';
  assert.equal(finalOutput.slice(banner.length), 'ANSWER BODY');
});

await check('a completed collaboration run strips to its answer body exactly', async () => {
  const { result } = await run({ collaboration: true, gateText: PROVISIONAL + block([issue()]) });
  const banner = buildOutputBanner(result.report);
  assert.equal(result.finalOutput.slice(banner.length), DECISION);
});

/* ============================================ direct delivery banner invariant */
console.log('\nDirect-delivery banner invariant');

await check('a direct-delivery-eligible report has an empty banner', () => {
  // Step 7's fast path returns worker text without a banner. That is safe only while the
  // policy admits nothing a banner would have had to warn about. This asserts the coupling
  // instead of trusting it, so a future policy change fails here rather than in production.
  const workers = [{ id: 'w1', provider: 'openai', role: 'Solo' }];
  const results = [{ agentId: 'w1', provider: 'openai', mission: 'm', output: 'answer' }];
  const report = buildRunReport('simple', workers, results);
  const policy = deriveExecutionPolicy({
    complexity: 'simple',
    assignmentIds: ['w1'],
    status: report.status,
    synthesisAllowed: report.synthesisAllowed,
    retrievalRequired: false,
    workerResults: results,
  });
  assert.equal(policy.synthesize, false, 'fixture must be direct-delivery eligible');
  assert.equal(buildOutputBanner({ ...report, policy }), '');
});

await check('direct delivery through the runtime carries no banner', async () => {
  const { result } = await run({ ids: ['strategy'], complexity: 'simple', collaboration: true });
  assert.equal(result.report.policy.synthesize, false);
  assert.equal(buildOutputBanner(result.report), '');
  assert.equal(result.finalOutput, OUTPUT.strategy);
  assert.equal(result.collaboration, undefined, 'direct delivery returns the pre-M2 shape');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
