import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createConsultationCoordinator } from './dist/consultation/coordinator.js';
import { createExecutionBoundary } from './dist/execution/boundary.js';
import { createOpenAIExecutor } from './dist/execution/executors.js';
import { createExecutorRegistry } from './dist/execution/registry.js';
import { createConsultationRouteBindingPort } from './dist/stress-test/consultation-binding.js';
import { createD1ExecutionAuthority } from './dist/stress-test/execution-authority.js';
import {
  createSession, freezeInput, addFinding, createSemanticIssue, createDeliberationState,
  createUnresolvedQuestion, registerUnresolvedQuestion, planRouteForQuestion,
  registerEvidenceSubject,
  recordRouteDecision, recordRouteAttemptStart, createInMemoryRouteExecutionCheckpointStore,
  createInMemoryDeliberationStateAccessPort, createStaticLiveExecutionPolicyResolver,
} from './dist/stress-test/index.js';

let passed = 0;
async function check(name, run) { await run(); passed++; console.log(`  PASS ${name}`); }
const request = (attemptId, overrides = {}) => ({ attemptId, consultantRoleId: 'independent-reviewer',
  provider: 'openai', requestedModel: 'synthetic-model', input: 'offline consultation', parameters: {}, ...overrides });
const capabilitySource = {
  getModelProfile: (provider, model) => ({ status: 'FOUND', profile: { provider, model } }),
  getCapabilityAssessment: () => ({ status: 'FOUND', assessment: { providerSupport: 'SUPPORTED',
    runtimeEnablement: 'ENABLED', readiness: 'VERIFIED', evidence: [] } }),
  getParameterAssessment: () => ({ status: 'FOUND', assessment: { readiness: 'VERIFIED',
    constraint: { kind: 'FIXED', value: 0, explicitTransmission: 'ALLOWED' }, evidence: [] } }),
};

function fixture(rootCause = 'COVERAGE_GAP', opts = {}) {
  let session = freezeInput(createSession('Fictional review document.'));
  session = addFinding(session, { reviewerRunId: 'prior-review', type: 'EXECUTION_RISK', title: 'Uncertain plan',
    artifactLocation: 'paragraph 1', evidenceState: 'UNSUPPORTED_IN_MATERIAL', whyMaterial: 'Unverified',
    likelyRecipientChallenge: 'Can this be defended?', minimumBeforeSendAction: 'Check it' });
  session = createSemanticIssue(session, { title: 'Uncertain plan', description: 'Needs review',
    findingIds: Object.keys(session.findings), evidenceState: 'UNSUPPORTED_IN_MATERIAL' });
  let state = createDeliberationState(session, { costCeiling: 20, latencyCeiling: opts.latencyCeiling ?? 500 });
  const refs = [{ kind: 'FINDING', id: Object.keys(session.findings)[0] },
    { kind: 'SEMANTIC_ISSUE', id: Object.keys(session.semanticIssues)[0] }];
  const question = createUnresolvedQuestion(session, { rootCause, materialityReason: 'A material gap remains', inputRefs: refs });
  state = registerUnresolvedQuestion(session, state, question);
  if (rootCause === 'EVIDENCE_GAP') {
    state = registerEvidenceSubject(session, state, { questionId: question.id,
      sourceRef: refs[0], originatingFindingId: refs[0].id,
      claimText: 'The fictional document does not substantiate its schedule.' }).deliberationState;
  }
  const decision = planRouteForQuestion(session, state, question);
  state = recordRouteDecision(session, state, decision);
  state = recordRouteAttemptStart(session, state, decision.id);
  const attemptId = state.attempts[0].attemptId;
  const access = createInMemoryDeliberationStateAccessPort(state);
  const store = createInMemoryRouteExecutionCheckpointStore();
  const actualAuthority = createD1ExecutionAuthority(session, state, store, access,
    createStaticLiveExecutionPolicyResolver(opts.policy ?? { status: 'ENABLED', latencyLimitMs: 50 }));
  const calls = { claim: 0, provider: 0, input: [] };
  const authority = { claim(id) { calls.claim++; return actualAuthority.claim(id); } };
  const executor = createOpenAIExecutor(async (_prompt, options) => {
    calls.provider++; calls.input.push(options);
    if (opts.transport) return opts.transport(options);
    return { outcome: 'SUCCESS', result: { provider: 'openai', model: options.model, text: 'raw offline text' } };
  });
  const registry = opts.noExecutor ? createExecutorRegistry([]) : createExecutorRegistry([
    { kind: 'MODEL_PROVIDER', executorId: 'offline-openai', provider: 'openai', executor },
  ]);
  const boundary = createExecutionBoundary({ authority, registry,
    capabilitySource: opts.unknownModel ? { ...capabilitySource, getModelProfile: (provider, model) =>
      ({ status: 'UNKNOWN_MODEL', provider, model }) } : capabilitySource,
    defaultModelResolver: { resolveDefaultModel: () => 'synthetic-model' }, monotonicNow: () => 1 });
  const bindingPort = createConsultationRouteBindingPort(session, access, state.id);
  return { session, state, access, store, attemptId, calls, bindingPort,
    coordinator: createConsultationCoordinator(bindingPort, boundary) };
}

await check('actual domain adapter resolves exact ADD_REVIEWER and REPLICATE bindings with ordered refs', async () => {
  for (const [cause, route] of [['COVERAGE_GAP', 'ADD_REVIEWER'], ['STABILITY_QUESTION', 'REPLICATE']]) {
    const h = fixture(cause);
    const b = h.bindingPort.resolve(h.attemptId);
    assert.equal(b.route, route); assert.equal(b.sessionId, h.session.id);
    assert.equal(b.deliberationStateId, h.state.id); assert.equal(b.attemptId, h.attemptId);
    assert.equal(b.decisionId, h.state.history[0].id); assert.equal(b.questionId, h.state.unresolvedQuestions[0].id);
    assert.deepEqual(b.inputRefs, h.state.unresolvedQuestions[0].inputRefs);
    assert.deepEqual(b.inputRefs.map((ref) => ref.kind), ['FINDING', 'SEMANTIC_ISSUE']);
  }
});

await check('actual adapter refuses unsupported routes without executing a provider', async () => {
  for (const [cause, route] of [['DECISION_SENSITIVE_CONFLICT', 'TARGETED_PEER_CHALLENGE'],
    ['EVIDENCE_GAP', 'SEEK_EVIDENCE'], ['CONTEXT_GAP', 'ADD_CONTEXT']]) {
    const h = fixture(cause);
    assert.equal(h.state.attempts[0].route, route);
    assert.throws(() => h.bindingPort.resolve(h.attemptId), /does not execute route/);
    await assert.rejects(() => h.coordinator.consult(request(h.attemptId)), /does not execute route/);
    assert.equal(h.calls.claim, 0); assert.equal(h.calls.provider, 0);
  }
});

await check('unknown or ambiguous attempt, outcome, stopped state, and broken binding fail before execution', async () => {
  const unknown = fixture();
  assert.throws(() => unknown.bindingPort.resolve('unknown'), /exactly one/);
  const duplicate = fixture(); const d = duplicate.access.current(); d.attempts.push(structuredClone(d.attempts[0]));
  duplicate.access.commitDeliberationState(d);
  assert.throws(() => duplicate.bindingPort.resolve(duplicate.attemptId), /exactly one/);
  const duplicateDecision = fixture(); const dd = duplicateDecision.access.current();
  dd.history.push(structuredClone(dd.history[0])); duplicateDecision.access.commitDeliberationState(dd);
  assert.throws(() => duplicateDecision.bindingPort.resolve(duplicateDecision.attemptId), /exactly once/);
  const duplicateQuestion = fixture(); const dq = duplicateQuestion.access.current();
  dq.unresolvedQuestions.push(structuredClone(dq.unresolvedQuestions[0])); duplicateQuestion.access.commitDeliberationState(dq);
  assert.throws(() => duplicateQuestion.bindingPort.resolve(duplicateQuestion.attemptId), /exactly once/);
  const terminal = fixture(); const t = terminal.access.current(); t.outcomes.push({ attemptId: terminal.attemptId });
  terminal.access.commitDeliberationState(t);
  assert.throws(() => terminal.bindingPort.resolve(terminal.attemptId), /RouteOutcome/);
  const stopped = fixture(); const s = stopped.access.current(); s.stopReason = 'budget';
  stopped.access.commitDeliberationState(s);
  assert.throws(() => stopped.bindingPort.resolve(stopped.attemptId), /stopped/);
  const hash = fixture(); const hs = hash.access.current(); hs.artifactHash = 'wrong';
  hash.access.commitDeliberationState(hs);
  assert.throws(() => hash.bindingPort.resolve(hash.attemptId), /artifactHash/);
  assert.throws(() => hash.bindingPort.resolve('unknown'), /artifactHash/);
  const lineage = fixture(); const ls = lineage.access.current(); ls.history[0].questionId = 'wrong';
  lineage.access.commitDeliberationState(ls);
  assert.throws(() => lineage.bindingPort.resolve(lineage.attemptId), /disagree/);
  for (const h of [unknown, duplicate, duplicateDecision, duplicateQuestion, terminal, stopped, hash, lineage]) {
    assert.equal(h.calls.claim, 0); assert.equal(h.calls.provider, 0);
  }
});

await check('actual D1 and R4 allow exactly one ADD_REVIEWER and one REPLICATE provider execution', async () => {
  const ids = [];
  for (const cause of ['COVERAGE_GAP', 'STABILITY_QUESTION']) {
    const expectedText = cause === 'STABILITY_QUESTION' ? 'REPRODUCED' : 'raw offline text';
    const h = fixture(cause, { transport: async (options) => ({ outcome: 'SUCCESS',
      result: { provider: 'openai', model: options.model, text: expectedText } }) });
    const rec = await h.coordinator.consult(request(h.attemptId, { parameters: { temperature: { value: 0 } } }));
    assert.equal(rec.provenanceStatus, 'STABLE'); assert.equal(rec.boundaryResult.kind, 'EXECUTED');
    assert.equal(rec.boundaryResult.result.outcome, 'SUCCESS');
    assert.equal(rec.boundaryResult.result.output.text, expectedText);
    assert.equal(rec.boundaryResult.result.effectiveProvider, 'openai');
    assert.equal(rec.boundaryResult.result.effectiveModel, 'synthetic-model');
    assert.equal(rec.boundaryResult.result.executionId, rec.executionId);
    assert.equal(rec.routeBinding.attemptId, h.attemptId);
    assert.equal(h.calls.claim, 1); assert.equal(h.calls.provider, 1);
    assert.equal(h.calls.input[0].temperature, 0);
    assert.equal(h.store.getCheckpoint(h.attemptId).phase, 'CLAIMED');
    await assert.rejects(() => h.coordinator.consult(request(h.attemptId)), /not repeatable|already has an execution checkpoint/);
    assert.equal(h.calls.claim, 2); assert.equal(h.calls.provider, 1);
    assert.equal(Object.hasOwn(rec, 'replicationResult'), false);
    assert.equal(Object.hasOwn(rec, 'reviewFinding'), false);
    ids.push([rec.consultationId, rec.executionId]);
  }
  assert.notEqual(ids[0][0], ids[1][0]); assert.notEqual(ids[0][1], ids[1][1]);
});

await check('R3 rejection and R4 missing mechanism consume no D1 claim', async () => {
  for (const opts of [{ unknownModel: true }, { noExecutor: true }]) {
    const h = fixture('COVERAGE_GAP', opts);
    const rec = await h.coordinator.consult(request(h.attemptId));
    assert.equal(rec.boundaryResult.kind, opts.unknownModel ? 'NOT_ADMITTED' : 'EXECUTOR_UNAVAILABLE');
    assert.equal(rec.provenanceStatus, 'STABLE');
    assert.equal(h.calls.claim, 0); assert.equal(h.calls.provider, 0);
    assert.equal(h.store.getCheckpoint(h.attemptId), undefined);
  }
});

await check('D1 DISABLED and pre-call terminal never call provider', async () => {
  const disabled = fixture('COVERAGE_GAP', { policy: { status: 'DISABLED' } });
  await assert.rejects(() => disabled.coordinator.consult(request(disabled.attemptId)), /DISABLED/);
  assert.equal(disabled.calls.claim, 1); assert.equal(disabled.calls.provider, 0);
  const terminal = fixture('STABILITY_QUESTION', { latencyCeiling: 20 });
  const rec = await terminal.coordinator.consult(request(terminal.attemptId));
  assert.equal(rec.boundaryResult.kind, 'PRE_CALL_TERMINAL'); assert.equal(rec.provenanceStatus, 'STABLE');
  assert.equal(terminal.calls.claim, 1); assert.equal(terminal.calls.provider, 0);
});

await check('actual current-state change during fake provider await preserves execution with uncertain provenance', async () => {
  let release; let enter;
  const gate = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { enter = resolve; });
  const h = fixture('COVERAGE_GAP', { transport: async (options) => {
    enter(); await gate;
    return { outcome: 'SUCCESS', result: { provider: 'openai', model: options.model, text: 'already executed' } };
  } });
  const pending = h.coordinator.consult(request(h.attemptId)); await entered;
  const current = h.access.current(); current.history[0].id = 'changed-while-awaiting';
  h.access.commitDeliberationState(current); release();
  const rec = await pending;
  assert.equal(h.calls.provider, 1); assert.equal(rec.boundaryResult.result.output.text, 'already executed');
  assert.equal(rec.boundaryResult.result.outcome, 'SUCCESS');
  assert.equal(rec.provenanceStatus, 'PROVENANCE_UNCERTAIN');
  assert.equal(rec.routeBinding.decisionId, h.state.history[0].id);
  assert.equal(h.access.current().outcomes.length, 0);
});

await check('actual R4 KNOWN_FAILURE and UNCERTAIN remain execution facts', async () => {
  for (const outcome of ['KNOWN_FAILURE', 'UNCERTAIN']) {
    const h = fixture('COVERAGE_GAP', { transport: async (options) => ({ outcome,
      error: { provider: 'openai', model: options.model, category: 'TRANSPORT', message: 'offline',
        dispatchState: 'UNKNOWN', completionState: outcome === 'KNOWN_FAILURE' ? 'FAILED' : 'UNKNOWN' } }) });
    const rec = await h.coordinator.consult(request(h.attemptId));
    assert.equal(rec.boundaryResult.kind, 'EXECUTED');
    assert.equal(rec.boundaryResult.result.outcome, outcome);
    assert.equal(rec.provenanceStatus, 'STABLE'); assert.equal(h.calls.provider, 1);
    assert.equal(h.access.current().outcomes.length, 0);
  }
});

await check('R5 production files have no product-semantic write path', async () => {
  const source = ['src/consultation/coordinator.ts', 'src/consultation/fingerprint.ts',
    'src/stress-test/consultation-binding.ts'].map((path) => readFileSync(path, 'utf8')).join('\n');
  for (const name of ['addFinding', 'createSemanticIssue', 'recordRouteOutcome', 'recordExecutionTerminalFact',
    'persistExecutionTerminalFactAsRouteOutcome', 'markExecutionOutcomeCommitted', 'recordQuestionDisposition',
    'adjudicate', 'planRevisionAction', 'implementRevisionAction']) {
    assert.equal(source.includes(name), false, `${name} must not appear in R5 production`);
  }
  assert.equal(source.includes('ContextPack'), false);
});

console.log(`${passed} passed, 0 failed`);
