// Domain-integrity regressions for audit findings F03, F04, F05, and F10.
// Offline and synthetic only: no provider calls, no CASE-001 material.
import assert from 'node:assert/strict';
import { AGENT_REGISTRY, listAgents, resolveRoster, resolveWorker } from './dist/agents/registry.js';
import {
  createSession,
  addAuthorContextItem,
  freezeInput,
  addFinding,
  createSemanticIssue,
  adjudicate,
  planRevisionAction,
  implementRevisionAction,
  rejectRevisionAction,
  createRevisionSuccessorSession,
  recordRevisionVerification,
  assertHumanAdjudicationLedgerIntegrity,
  assertRevisionActionLedgerIntegrity,
  assertRevisionVerificationLedgerIntegrity,
  generateDecisionRecord,
  createDeliberationState,
  validateRouteInputRef,
  createUnresolvedQuestion,
  registerUnresolvedQuestion,
  planRouteForQuestion,
  recordRouteDecision,
  recordRouteAttemptStart,
  recordRouteOutcome,
  recordQuestionDisposition,
  isQuestionCurrent,
  createContextRequest,
  createCrossSessionTransition,
  registerEvidenceSubject,
  assertRouteOutcomeIntegrity,
  claimRouteExecution,
  performCoordinatedLatencyWrite,
  withCurrentDeliberationState,
  createInMemoryRouteExecutionCheckpointStore,
  createInMemoryDeliberationStateAccessPort,
  createStaticLiveExecutionPolicyResolver,
} from './dist/stress-test/index.js';

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}\n      ${err.message.split('\n')[0]}`);
    failed++;
  }
}

const INHERITED_IDS = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'];
const CLAIM_TEXT = 'The platform team can absorb the migration work without additional contractor budget.';
const CITATION = { sourceIdentifier: 'internal-doc-1', title: 'Budget memo', excerpt: 'The Q1 budget ceiling is confirmed at $50,000.' };
const ENABLED = (latencyLimitMs) => createStaticLiveExecutionPolicyResolver({ status: 'ENABLED', latencyLimitMs });

function findingInput(overrides = {}) {
  return {
    reviewerRunId: 'run-1', type: 'EXECUTION_RISK', title: 'Migration window may ignore notice periods',
    artifactLocation: 'paragraph 1', evidenceState: 'UNSUPPORTED_IN_MATERIAL',
    whyMaterial: 'Notice periods may exceed the window.', likelyRecipientChallenge: 'Were notice periods checked?',
    minimumBeforeSendAction: 'Confirm notice periods.', ...overrides,
  };
}
function reviewed() {
  let session = createSession('Synthetic memo: consolidate four vendors to one within a three-week window.');
  session = addAuthorContextItem(session, 'confirmedFacts', { text: 'The window was set by the platform lead.', sourceType: 'AUTHOR' });
  session = freezeInput(session);
  session = addFinding(session, findingInput());
  session = addFinding(session, findingInput({ type: 'CLAIM', title: 'Capacity claim is unverified' }));
  return { session, findingIds: Object.keys(session.findings) };
}
function withIssue() {
  const { session, findingIds } = reviewed();
  const clustered = createSemanticIssue(session, {
    title: 'Timeline feasibility is unconfirmed', description: 'Both findings share one dependency.',
    findingIds, evidenceState: 'UNSUPPORTED_IN_MATERIAL',
  });
  return { session: clustered, issueId: Object.keys(clustered.semanticIssues)[0], findingIds };
}
function registered(session, state, rootCause, inputRefs) {
  const question = createUnresolvedQuestion(session, { rootCause, materialityReason: `material ${rootCause}`, inputRefs });
  return { state: registerUnresolvedQuestion(session, state, question), question };
}
function startedAttempt(rootCause, { latencyCeiling = 5, costCeiling = 5 } = {}) {
  const { session, issueId, findingIds } = withIssue();
  const state0 = createDeliberationState(session, { costCeiling, latencyCeiling });
  const { state: state1, question } = registered(session, state0, rootCause, [{ kind: 'SEMANTIC_ISSUE', id: issueId }]);
  const decision = planRouteForQuestion(session, state1, question);
  const state2 = recordRouteAttemptStart(session, recordRouteDecision(session, state1, decision), decision.id);
  return { session, state: state2, decision, question, attempt: state2.attempts[0], issueId, findingIds };
}
function failedCycle(rootCause = 'STABILITY_QUESTION') {
  const base = startedAttempt(rootCause);
  const state = recordRouteOutcome(base.session, base.state, {
    attemptId: base.attempt.attemptId, status: 'FAILED', latencyConsumed: 1,
    failure: { category: 'TRANSPORT', message: 'simulated failure' },
  });
  return { ...base, state };
}
function replicateCycle() {
  const base = startedAttempt('STABILITY_QUESTION');
  const state = recordRouteOutcome(base.session, base.state, {
    attemptId: base.attempt.attemptId, status: 'SUCCEEDED', latencyConsumed: 1,
    result: 'REPRODUCED', targetRef: { kind: 'SEMANTIC_ISSUE', id: base.issueId },
  });
  return { ...base, state };
}
function addReviewerCycle() {
  const base = startedAttempt('COVERAGE_GAP');
  const before = new Set(Object.keys(base.session.findings));
  const session = addFinding(base.session, findingInput({ reviewerRunId: 'reviewer-run-cycle' }));
  const findingId = Object.keys(session.findings).find((id) => !before.has(id));
  const state = recordRouteOutcome(session, base.state, {
    attemptId: base.attempt.attemptId, status: 'SUCCEEDED', latencyConsumed: 1,
    reviewerRunId: 'reviewer-run-cycle', findingIds: [findingId],
  });
  return { ...base, session, state, findingId };
}
function suppliedCycle() {
  const { session, findingIds } = reviewed();
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const itemId = session.authorContext.confirmedFacts[0].id;
  const { state: state1, question } = registered(session, state0, 'CONTEXT_GAP', [{ kind: 'AUTHOR_CONTEXT_ITEM', id: itemId }]);
  const decision = planRouteForQuestion(session, state1, question);
  const state2 = recordRouteAttemptStart(session, recordRouteDecision(session, state1, decision), decision.id);
  const attempt = state2.attempts[0];
  const { deliberationState: state3, contextRequest } = createContextRequest(session, state2, {
    attemptId: attempt.attemptId, category: 'constraints', question: 'What is the budget ceiling?', inferenceReason: 'x',
  });
  const state = recordRouteOutcome(session, state3, {
    attemptId: attempt.attemptId, status: 'SUCCEEDED', latencyConsumed: 1,
    result: 'SUPPLIED', contextRequestId: contextRequest.id, responseText: 'The ceiling is $50,000.',
  });
  return { session, state, question, attempt, findingIds };
}
function throwsWithoutMutation(fn, ...inputs) {
  const before = inputs.map((value) => JSON.stringify(value));
  assert.throws(fn);
  inputs.forEach((value, index) => assert.equal(JSON.stringify(value), before[index], 'input was mutated by a rejected call'));
}

// ===========================================================================
console.log('\nF03 -- exact reference resolution');

check('registry: inherited, empty, and unknown ids never resolve as specialists', () => {
  for (const id of [...INHERITED_IDS, '', 'unknown_agent']) {
    assert.throws(() => resolveRoster([id]), /Unknown agent/, JSON.stringify(id));
    assert.throws(() => resolveWorker(id), /Unknown agent/, JSON.stringify(id));
  }
  for (const id of INHERITED_IDS) {
    assert.throws(() => resolveWorker({ id }), /Unknown agent/, `partial override of inherited ${id}`);
  }
  for (const ref of [null, undefined, 42, {}, { id: '' }, { id: 7 }]) assert.throws(() => resolveWorker(ref));
});
check('registry: valid ids still resolve, and a full inline definition is still an inline specialist', () => {
  const roster = resolveRoster(['business_strategist', 'market_researcher', 'brand_creative']);
  assert.deepEqual(roster.workers.map((w) => w.id), ['business_strategist', 'market_researcher', 'brand_creative']);
  const inline = resolveWorker({ id: 'constructor', provider: 'claude', role: 'Inline role supplied in full' });
  assert.equal(inline.role, 'Inline role supplied in full');
});
check('registry: returned agents are copies and the registry is frozen', () => {
  const [first] = listAgents();
  first.defaultProvider = 'openai'; first.role = 'tampered';
  assert.notEqual(listAgents()[0].role, 'tampered');
  assert.ok(Object.isFrozen(AGENT_REGISTRY) && Object.values(AGENT_REGISTRY).every(Object.isFrozen));
  assert.throws(() => { AGENT_REGISTRY.business_strategist.defaultProvider = 'gemini'; }, TypeError);
  assert.equal(resolveWorker('business_strategist').provider, 'claude');
});
check('validateRouteInputRef: inherited, unknown, mismatched, and malformed records are rejected; real ones resolve', () => {
  const { session, issueId, findingIds } = withIssue();
  for (const kind of ['FINDING', 'SEMANTIC_ISSUE']) {
    for (const id of [...INHERITED_IDS, 'no-such-id', '', 7, null]) {
      assert.throws(() => validateRouteInputRef(session, { kind, id }), undefined, `${kind} ${String(id)}`);
    }
  }
  const mismatched = { ...session, findings: { ...session.findings, [findingIds[0]]: { ...session.findings[findingIds[0]], id: 'other' } },
    semanticIssues: { ...session.semanticIssues, [issueId]: { ...session.semanticIssues[issueId], id: 'other' } } };
  assert.throws(() => validateRouteInputRef(mismatched, { kind: 'FINDING', id: findingIds[0] }));
  assert.throws(() => validateRouteInputRef(mismatched, { kind: 'SEMANTIC_ISSUE', id: issueId }));
  for (const malformed of [{ id: findingIds[0] }, null, [], 'record', { ...session.findings[findingIds[0]], title: 5 }]) {
    const broken = { ...session, findings: { ...session.findings, [findingIds[0]]: malformed } };
    assert.throws(() => validateRouteInputRef(broken, { kind: 'FINDING', id: findingIds[0] }), undefined, JSON.stringify(malformed));
  }
  const pollutedIssues = Object.create({ polluted: { id: 'polluted', title: 't', description: 'd', findingIds: [], evidenceState: 'x', status: 'OPEN' } });
  assert.throws(() => validateRouteInputRef({ ...session, semanticIssues: pollutedIssues }, { kind: 'SEMANTIC_ISSUE', id: 'polluted' }));
  validateRouteInputRef(session, { kind: 'FINDING', id: findingIds[0] });
  validateRouteInputRef(session, { kind: 'SEMANTIC_ISSUE', id: issueId });
});
check('a nonexistent FINDING cannot become a question, a route, or an execution claim', () => {
  const { session } = withIssue();
  const state = createDeliberationState(session, { costCeiling: 50, latencyCeiling: 100 });
  for (const id of INHERITED_IDS) {
    assert.throws(() => createUnresolvedQuestion(session, { rootCause: 'STABILITY_QUESTION', materialityReason: 'm', inputRefs: [{ kind: 'FINDING', id }] }));
    assert.throws(() => registerUnresolvedQuestion(session, state, {
      id: `manual-${id}`, rootCause: 'STABILITY_QUESTION', materialityReason: 'm', inputRefs: [{ kind: 'FINDING', id }],
      createdAt: new Date().toISOString(), derivedFromQuestionId: null,
    }));
  }
});
check('an execution claim re-resolves its references: a finding that no longer resolves blocks the claim', () => {
  const { session, findingIds } = withIssue();
  const state0 = createDeliberationState(session, { costCeiling: 50, latencyCeiling: 100 });
  const { state: state1, question } = registered(session, state0, 'STABILITY_QUESTION', [{ kind: 'FINDING', id: findingIds[0] }]);
  const decision = planRouteForQuestion(session, state1, question);
  const state = recordRouteAttemptStart(session, recordRouteDecision(session, state1, decision), decision.id);
  const tampered = { ...session, findings: { ...session.findings, [findingIds[0]]: { ...session.findings[findingIds[0]], id: 'constructor' } } };
  const store = createInMemoryRouteExecutionCheckpointStore();
  const port = createInMemoryDeliberationStateAccessPort(state);
  assert.throws(() => claimRouteExecution(tampered, state, store, port, ENABLED(50), { attemptId: state.attempts[0].attemptId }));
  assert.equal(store.getCheckpoint(state.attempts[0].attemptId), undefined, 'no claim was recorded');
  assert.equal(claimRouteExecution(session, state, store, port, ENABLED(50), { attemptId: state.attempts[0].attemptId }).phase, 'CLAIMED');
});
check('session writes refuse inherited, mismatched, and duplicate identities', () => {
  const { session, findingIds } = reviewed();
  for (const id of INHERITED_IDS) {
    throwsWithoutMutation(() => createSemanticIssue(session, { title: 't', description: 'd', findingIds: [id], evidenceState: 'UNSUPPORTED_IN_MATERIAL' }), session);
  }
  throwsWithoutMutation(() => createSemanticIssue(session, { title: 't', description: 'd', findingIds: [findingIds[0], findingIds[0]], evidenceState: 'UNSUPPORTED_IN_MATERIAL' }), session);
  const mismatched = { ...session, findings: { ...session.findings, [findingIds[0]]: { ...session.findings[findingIds[0]], id: findingIds[1] } } };
  assert.throws(() => createSemanticIssue(mismatched, { title: 't', description: 'd', findingIds: [findingIds[0]], evidenceState: 'UNSUPPORTED_IN_MATERIAL' }));
  const { session: withIssueSession, issueId } = withIssue();
  const adjudicated = adjudicate(withIssueSession, { semanticIssueId: issueId, judgment: 'NEW_MATERIAL', actionChange: 'YES' });
  for (const id of INHERITED_IDS) {
    throwsWithoutMutation(() => planRevisionAction(adjudicated, { sourceRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }, { kind: 'FINDING', id }],
      description: 'd', targetLocation: 'l' }), adjudicated);
  }
  const planned = planRevisionAction(adjudicated, { sourceRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }], description: 'd', targetLocation: 'l' });
  for (const id of INHERITED_IDS) {
    assert.throws(() => implementRevisionAction(planned, id));
    assert.throws(() => rejectRevisionAction(planned, id));
  }
});
check('ADD_REVIEWER payloads and EvidenceSubjects cannot cite an inherited finding', () => {
  const base = startedAttempt('COVERAGE_GAP');
  for (const id of INHERITED_IDS) {
    throwsWithoutMutation(() => recordRouteOutcome(base.session, base.state, { attemptId: base.attempt.attemptId, status: 'SUCCEEDED',
      latencyConsumed: 1, reviewerRunId: 'reviewer-run-x', findingIds: [id] }), base.state);
  }
  const { session, issueId } = withIssue();
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const { state, question } = registered(session, state0, 'EVIDENCE_GAP', [{ kind: 'SEMANTIC_ISSUE', id: issueId }]);
  for (const id of INHERITED_IDS) {
    throwsWithoutMutation(() => registerEvidenceSubject(session, state, { questionId: question.id,
      sourceRef: { kind: 'SEMANTIC_ISSUE', id: issueId }, originatingFindingId: id, claimText: CLAIM_TEXT }), state);
  }
});
check('EvidenceSubject ledger still reports a ReviewFinding map-key/id mismatch in its own words', () => {
  const { session, issueId, findingIds } = withIssue();
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const { state: state1, question } = registered(session, state0, 'EVIDENCE_GAP', [{ kind: 'SEMANTIC_ISSUE', id: issueId }]);
  const { deliberationState, evidenceSubject } = registerEvidenceSubject(session, state1, { questionId: question.id,
    sourceRef: { kind: 'SEMANTIC_ISSUE', id: issueId }, originatingFindingId: findingIds[0], claimText: CLAIM_TEXT });
  const decision = planRouteForQuestion(session, deliberationState, question);
  const started = recordRouteAttemptStart(session, recordRouteDecision(session, deliberationState, decision), decision.id);
  const tampered = { ...session, findings: { ...session.findings, [findingIds[0]]: { ...session.findings[findingIds[0]], id: 'different-id' } } };
  assert.throws(() => recordRouteOutcome(tampered, started, { attemptId: started.attempts[0].attemptId, status: 'SUCCEEDED',
    latencyConsumed: 1, result: 'SUPPORTIVE', evidenceSubjectId: evidenceSubject.id, citations: [CITATION] }), /does not agree with originatingFindingId/);
});
check('SemanticIssue evidence leaf rejects a map-key/id mismatch instead of trusting the key', () => {
  const { session, issueId, findingIds } = withIssue();
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const { state, question } = registered(session, state0, 'EVIDENCE_GAP', [{ kind: 'SEMANTIC_ISSUE', id: issueId }]);
  const { deliberationState } = registerEvidenceSubject(session, state, { questionId: question.id,
    sourceRef: { kind: 'SEMANTIC_ISSUE', id: issueId }, originatingFindingId: findingIds[0], claimText: CLAIM_TEXT });
  const swapped = { ...session, semanticIssues: { ...session.semanticIssues, [issueId]: { ...session.semanticIssues[issueId], id: 'some-other-issue' } } };
  assert.throws(() => planRouteForQuestion(swapped, deliberationState, question));
});
check('canonical ledgers reject adjudications and revision refs that name inherited or mismatched targets', () => {
  const { session, issueId, findingIds } = withIssue();
  const adjudicated = adjudicate(session, { semanticIssueId: issueId, judgment: 'NEW_MATERIAL', actionChange: 'YES' });
  const [adjudicationId] = Object.keys(adjudicated.adjudications);
  for (const id of INHERITED_IDS) {
    const forged = { ...adjudicated, adjudications: { [adjudicationId]: { ...adjudicated.adjudications[adjudicationId], semanticIssueId: id } } };
    assert.throws(() => assertHumanAdjudicationLedgerIntegrity(forged), /unknown semanticIssueId/, id);
    const forgedFinding = { ...adjudicated, adjudications: { [adjudicationId]: { id: adjudicationId, findingId: id, judgment: 'WRONG', actionChange: 'NO', note: '', adjudicatedAt: new Date().toISOString() } } };
    assert.throws(() => assertHumanAdjudicationLedgerIntegrity(forgedFinding), /unknown findingId/, id);
  }
  const mismatched = { ...adjudicated, semanticIssues: { ...adjudicated.semanticIssues, [issueId]: { ...adjudicated.semanticIssues[issueId], id: findingIds[0] } } };
  assert.throws(() => assertHumanAdjudicationLedgerIntegrity(mismatched), /differs/);
  const planned = planRevisionAction(adjudicated, { sourceRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }], description: 'd', targetLocation: 'l' });
  const [actionId] = Object.keys(planned.revisionActions);
  const refForged = { ...planned, revisionActions: { [actionId]: { ...planned.revisionActions[actionId],
    sourceRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }, { kind: 'FINDING', id: 'constructor' }] } } };
  assert.throws(() => assertRevisionActionLedgerIntegrity(refForged), /unknown finding/);
});

// ===========================================================================
console.log('\nF04 -- authoritative DeliberationState ownership');

function portFixture(latencyCeiling = 100) {
  const base = startedAttempt('STABILITY_QUESTION', { costCeiling: 50, latencyCeiling });
  return { ...base, store: createInMemoryRouteExecutionCheckpointStore(), port: createInMemoryDeliberationStateAccessPort(base.state) };
}
check('A/G: mutating the original input after port creation changes neither budget nor lineage, and cannot buy a larger claim', () => {
  const { session, state, store, port, attempt } = portFixture(100);
  const before = JSON.stringify(port.current());
  state.latencyBudget.ceiling = 1000;
  state.costBudget.ceiling = 1000;
  state.unresolvedQuestions[0].inputRefs[0].id = 'rewritten';
  state.history.push({ ...state.history[0], id: 'forged-decision' });
  state.sessionVersionLineages.push({ forged: true });
  assert.equal(JSON.stringify(port.current()), before);
  const claim = claimRouteExecution(session, state, store, port, ENABLED(500), { attemptId: attempt.attemptId });
  assert.notEqual(claim.phase, 'CLAIMED');
  assert.equal(claim.reservedLatencyMs, 0);
  assert.equal(port.current().latencyBudget.ceiling, 100);
});
check('B: mutating the value returned by current() changes nothing', () => {
  const { port } = portFixture();
  const before = JSON.stringify(port.current());
  const view = port.current();
  view.latencyBudget.ceiling = 1; view.latencyBudget.spent = 99; view.outcomes.push({ forged: true });
  view.unresolvedQuestions[0].inputRefs[0].kind = 'FINDING';
  assert.equal(JSON.stringify(port.current()), before);
  assert.notEqual(port.current(), port.current(), 'each read is an independent snapshot');
});
check('C: mutating the value returned by resolveCurrentDeliberationState changes nothing', () => {
  const { port, state } = portFixture();
  const before = JSON.stringify(port.current());
  const resolved = port.resolveCurrentDeliberationState(state.id);
  resolved.latencyBudget.ceiling = 5000; resolved.history.length = 0; resolved.attempts[0].route = 'ADD_REVIEWER';
  assert.equal(JSON.stringify(port.current()), before);
});
check('D/E: mutating a committed object afterwards, at any depth, changes nothing', () => {
  const { port, state } = portFixture();
  const next = structuredClone(state);
  next.costBudget.spent = 1;
  port.commitDeliberationState(next);
  const committed = JSON.stringify(port.current());
  next.costBudget.spent = 40; next.latencyBudget.ceiling = 9999;
  next.unresolvedQuestions[0].inputRefs.push({ kind: 'FINDING', id: 'constructor' });
  next.attempts[0].logicalCost = 0;
  assert.equal(JSON.stringify(port.current()), committed);
  assert.equal(port.current().costBudget.spent, 1);
});
check('the transaction callback receives a snapshot: mutating it without committing changes nothing', () => {
  const { port, store, state } = portFixture();
  const before = JSON.stringify(port.current());
  const result = withCurrentDeliberationState(store, port, state.id, (current) => {
    current.latencyBudget.ceiling = 7777;
    current.outcomes.push({ forged: true });
    return { result: 'read-only' };
  });
  assert.equal(result, 'read-only');
  assert.equal(JSON.stringify(port.current()), before);
});
check('F: authorized coordinated operations still commit normally', () => {
  const { session, state, store, port, attempt } = portFixture(100);
  const claim = claimRouteExecution(session, state, store, port, ENABLED(50), { attemptId: attempt.attemptId });
  assert.equal(claim.phase, 'CLAIMED');
  assert.equal(claim.reservedLatencyMs, 50);
  const { session: s2, state: st2, store: store2, port: port2 } = (() => {
    const base = suppliedCycleWithOpenRequest();
    return { ...base, store: createInMemoryRouteExecutionCheckpointStore(), port: createInMemoryDeliberationStateAccessPort(base.state) };
  })();
  performCoordinatedLatencyWrite(s2, st2, store2, port2, { kind: 'ADD_CONTEXT_NO_RESPONSE', input: { attemptId: st2.attempts[0].attemptId, latencyConsumed: 1 } });
  assert.equal(port2.current().latencyBudget.spent, 1);
});
check('commit still refuses a state with a different id, and a non-object', () => {
  const { port, state } = portFixture();
  assert.throws(() => port.commitDeliberationState({ ...structuredClone(state), id: 'other' }), /must carry the same id/);
  assert.throws(() => port.commitDeliberationState(null), /must carry the same id/);
  assert.throws(() => createInMemoryDeliberationStateAccessPort(null));
});
function suppliedCycleWithOpenRequest() {
  const { session } = reviewed();
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const itemId = session.authorContext.confirmedFacts[0].id;
  const { state: state1, question } = registered(session, state0, 'CONTEXT_GAP', [{ kind: 'AUTHOR_CONTEXT_ITEM', id: itemId }]);
  const decision = planRouteForQuestion(session, state1, question);
  const state2 = recordRouteAttemptStart(session, recordRouteDecision(session, state1, decision), decision.id);
  const { deliberationState } = createContextRequest(session, state2, {
    attemptId: state2.attempts[0].attemptId, category: 'constraints', question: 'What is the ceiling?', inferenceReason: 'x',
  });
  return { session, state: deliberationState };
}

// ===========================================================================
console.log('\nF05 -- canonical RouteOutcome parity for QuestionDisposition');

const outcomeOf = (state, attemptId) => state.outcomes.findIndex((o) => o.attemptId === attemptId);
function corrupt(fixture, mutate) {
  const state = structuredClone(fixture.state);
  mutate(state.outcomes[outcomeOf(state, fixture.attempt.attemptId)], state);
  return state;
}
const FAILED_CORRUPTIONS = {
  'failure.category INVALID': (o) => { o.failure.category = 'INVALID'; },
  'failure.message empty': (o) => { o.failure.message = ''; },
  'failure.message oversized': (o) => { o.failure.message = 'x'.repeat(100_000); },
  'failure extra key': (o) => { o.failure.stack = 'trace'; },
  'failure missing': (o) => { delete o.failure; },
  'outcome extra key': (o) => { o.result = 'REPRODUCED'; },
  'status not a status': (o) => { o.status = 'DONE'; },
  'logicalCost differs from attempt': (o) => { o.logicalCost += 1; },
  'latencyConsumed negative': (o) => { o.latencyConsumed = -1; },
  'completedAt unparseable': (o) => { o.completedAt = 'yesterday'; },
  'decisionId rebound': (o) => { o.decisionId = 'another-decision'; },
  'route rebound': (o) => { o.route = 'ADD_REVIEWER'; },
  'originatingQuestionId rebound': (o) => { o.originatingQuestionId = 'another-question'; },
  'sessionId provenance': (o) => { o.sessionId = 'another-session'; },
  'artifactHash provenance': (o) => { o.artifactHash = 'f'.repeat(64); },
};
const SUCCESS_CORRUPTIONS = {
  replicate: {
    'result not in vocabulary': (o) => { o.result = 'MAYBE'; },
    'targetRef inherited id': (o) => { o.targetRef = { kind: 'SEMANTIC_ISSUE', id: 'constructor' }; },
    'targetRef unknown kind': (o) => { o.targetRef = { kind: 'ISSUE', id: o.targetRef.id }; },
    'targetRef missing': (o) => { delete o.targetRef; },
    'success carries failure': (o) => { o.failure = { category: 'TRANSPORT', message: 'x' }; },
  },
  addReviewer: {
    'findingIds inherited id': (o) => { o.findingIds = ['constructor']; },
    'findingIds empty identity': (o) => { o.findingIds = ['']; },
    'reviewerRunId equals attemptId': (o) => { o.reviewerRunId = o.attemptId; },
    'reviewerRunId mismatched to findings': (o) => { o.reviewerRunId = 'someone-else'; },
  },
};
function dispositionInputs(fixture) {
  const replacement = createUnresolvedQuestion(fixture.session, {
    rootCause: 'STABILITY_QUESTION', materialityReason: 'reclassified', derivedFromQuestionId: fixture.question.id,
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: fixture.issueId }],
  });
  return [
    { attemptId: fixture.attempt.attemptId, disposition: 'RESOLVED', reason: 'settled' },
    { attemptId: fixture.attempt.attemptId, disposition: 'STILL_OPEN', reason: 'not settled' },
    { attemptId: fixture.attempt.attemptId, disposition: 'SUPERSEDED_RECLASSIFIED', reason: 'reclassified', replacementQuestion: replacement },
  ];
}
function assertParity(fixture, corruptions) {
  for (const [name, mutate] of Object.entries(corruptions)) {
    const state = corrupt(fixture, mutate);
    assert.throws(() => assertRouteOutcomeIntegrity(fixture.session, state, fixture.attempt.attemptId), undefined, `canonical should reject: ${name}`);
    for (const input of dispositionInputs(fixture)) {
      throwsWithoutMutation(() => recordQuestionDisposition(fixture.session, state, input), state);
    }
    assert.equal(isQuestionCurrent(state, fixture.question.id), true, `question stays current: ${name}`);
  }
}
check('meta-invariant (FAILED): whatever the canonical validator rejects, no disposition consumes', () => {
  assertParity(failedCycle(), FAILED_CORRUPTIONS);
});
check('meta-invariant (REPLICATE success): whatever the canonical validator rejects, no disposition consumes', () => {
  assertParity(replicateCycle(), SUCCESS_CORRUPTIONS.replicate);
});
check('meta-invariant (ADD_REVIEWER success): whatever the canonical validator rejects, no disposition consumes', () => {
  const fixture = addReviewerCycle();
  assertParity(fixture, SUCCESS_CORRUPTIONS.addReviewer);
});
check('attempt identity: an outcome whose attempt is duplicated or missing is not consumed', () => {
  const fixture = failedCycle();
  const duplicated = structuredClone(fixture.state);
  duplicated.attempts.push(structuredClone(duplicated.attempts[0]));
  const missing = structuredClone(fixture.state);
  missing.attempts = [];
  for (const state of [duplicated, missing]) {
    throwsWithoutMutation(() => recordQuestionDisposition(fixture.session, state, dispositionInputs(fixture)[0]), state);
  }
});
check('legitimate outcomes still resolve, keep open, or supersede a valid question', () => {
  for (const build of [failedCycle, replicateCycle, addReviewerCycle]) {
    const fixture = build();
    for (const input of dispositionInputs(fixture)) {
      const next = recordQuestionDisposition(fixture.session, fixture.state, input);
      assert.equal(next.questionDispositions.at(-1).disposition, input.disposition);
    }
  }
});
check('CROSS_SESSION: a SUPPLIED outcome the canonical validator rejects cannot open a cross-session transition', () => {
  const fixture = suppliedCycle();
  const valid = createCrossSessionTransition(fixture.session, fixture.state, { suppliedOutcomeAttemptId: fixture.attempt.attemptId });
  assert.equal(valid.deliberationState.questionDispositions.at(-1).disposition, 'CROSS_SESSION');
  for (const [name, mutate] of Object.entries({
    'outcome extra key': (o) => { o.failure = { category: 'TRANSPORT', message: 'x' }; },
    'status not a status': (o) => { o.status = 'DONE'; },
    'contextRequestId rebound': (o) => { o.contextRequestId = 'another-request'; },
  })) {
    const state = corrupt(fixture, mutate);
    assert.throws(() => assertRouteOutcomeIntegrity(fixture.session, state, fixture.attempt.attemptId), undefined, `canonical should reject: ${name}`);
    throwsWithoutMutation(() => createCrossSessionTransition(fixture.session, state, { suppliedOutcomeAttemptId: fixture.attempt.attemptId }), state);
  }
});

// ===========================================================================
console.log('\nF10 -- HumanAdjudication write/read parity');

check('invalid judgment, actionChange, or note is rejected before any write', () => {
  const { session, issueId } = withIssue();
  for (const input of [
    { semanticIssueId: issueId, judgment: 'INVALID', actionChange: 'YES' },
    { semanticIssueId: issueId, judgment: 'new_material', actionChange: 'YES' },
    { semanticIssueId: issueId, judgment: undefined, actionChange: 'YES' },
    { semanticIssueId: issueId, judgment: 'NEW_MATERIAL', actionChange: 'INVALID' },
    { semanticIssueId: issueId, judgment: 'NEW_MATERIAL', actionChange: true },
    { semanticIssueId: issueId, judgment: 'NEW_MATERIAL', actionChange: 'YES', note: 42 },
    { semanticIssueId: issueId, judgment: 'NEW_MATERIAL', actionChange: 'YES', note: null },
  ]) throwsWithoutMutation(() => adjudicate(session, input), session, input);
});
check('malformed, inherited, and mismatched targets are rejected', () => {
  const { session, issueId, findingIds } = withIssue();
  const good = { judgment: 'NEW_MATERIAL', actionChange: 'YES' };
  for (const target of [{}, { semanticIssueId: issueId, findingId: findingIds[0] }, { semanticIssueId: '' }, { semanticIssueId: 7 },
    { semanticIssueId: null }, { findingId: '' }, { findingId: ['id'] }, ...INHERITED_IDS.flatMap((id) => [{ semanticIssueId: id }, { findingId: id }])]) {
    throwsWithoutMutation(() => adjudicate(session, { ...target, ...good }), session);
  }
  const mismatched = { ...session, semanticIssues: { ...session.semanticIssues, [issueId]: { ...session.semanticIssues[issueId], id: 'other' } } };
  assert.throws(() => adjudicate(mismatched, { semanticIssueId: issueId, ...good }), /unknown semanticIssueId/);
  const findingMismatch = { ...session, findings: { ...session.findings, [findingIds[0]]: { ...session.findings[findingIds[0]], id: findingIds[1] } } };
  assert.throws(() => adjudicate(findingMismatch, { findingId: findingIds[0], ...good }), /unknown findingId/);
  for (const input of [null, undefined, 'NEW_MATERIAL']) assert.throws(() => adjudicate(session, input));
});
check('a second adjudication for the same exact target is rejected; the same id-string of the other kind is not a duplicate', () => {
  const { session, issueId, findingIds } = withIssue();
  const once = adjudicate(session, { semanticIssueId: issueId, judgment: 'NEW_MATERIAL', actionChange: 'YES' });
  throwsWithoutMutation(() => adjudicate(once, { semanticIssueId: issueId, judgment: 'WRONG', actionChange: 'NO' }), once);
  const finding = adjudicate(once, { findingId: findingIds[0], judgment: 'KNOWN_PRE_DISPATCH', actionChange: 'NO' });
  throwsWithoutMutation(() => adjudicate(finding, { findingId: findingIds[0], judgment: 'WRONG', actionChange: 'NO' }), finding);
});
check('every successful adjudication immediately passes the canonical ledger and the decision record', () => {
  const judgments = ['KNOWN_PRE_DISPATCH', 'NEW_NON_MATERIAL', 'NEW_MATERIAL', 'WRONG'];
  const changes = ['YES', 'NO'];
  let written = 0;
  for (const judgment of judgments) {
    for (const actionChange of changes) {
      for (const note of [undefined, '', 'reasoned note']) {
        const { session, issueId, findingIds } = withIssue();
        const issueLevel = adjudicate(session, { semanticIssueId: issueId, judgment, actionChange, ...(note === undefined ? {} : { note }) });
        const findingLevel = adjudicate(issueLevel, { findingId: findingIds[1], judgment, actionChange, ...(note === undefined ? {} : { note }) });
        for (const result of [issueLevel, findingLevel]) {
          assertHumanAdjudicationLedgerIntegrity(result);
          assertRevisionActionLedgerIntegrity(result);
          generateDecisionRecord(result);
          written++;
        }
      }
    }
  }
  assert.equal(written, 48);
});
check('write/read parity sweep: across hostile adjudication inputs, nothing written is later rejected', () => {
  const { session, issueId, findingIds } = withIssue();
  const targets = [{ semanticIssueId: issueId }, { findingId: findingIds[0] }, { semanticIssueId: 'constructor' }, { findingId: '__proto__' }, {}];
  const judgments = ['NEW_MATERIAL', 'INVALID', '', undefined, 1];
  const changes = ['YES', 'NO', 'MAYBE', undefined];
  const notes = [undefined, 'n', 5];
  let accepted = 0, refused = 0;
  for (const target of targets) for (const judgment of judgments) for (const actionChange of changes) for (const note of notes) {
    let result;
    try { result = adjudicate(session, { ...target, judgment, actionChange, note }); } catch { refused++; continue; }
    assertHumanAdjudicationLedgerIntegrity(result);
    generateDecisionRecord(result);
    accepted++;
  }
  assert.equal(accepted, 8, 'exactly 2 valid targets x 1 valid judgment x 2 valid actionChanges x 2 valid notes');
  assert.ok(refused > 0);
});
check('findings and issues are written only in a shape exact resolution will later accept', () => {
  const { session, findingIds } = reviewed();
  for (const overrides of [{ title: 5 }, { reviewerRunId: null }, { whyMaterial: undefined }, { rawText: 7 }, { artifactLocation: ['p1'] }]) {
    throwsWithoutMutation(() => addFinding(session, findingInput(overrides)), session);
  }
  for (const overrides of [{ title: 5 }, { description: null }, { evidenceState: undefined }]) {
    throwsWithoutMutation(() => createSemanticIssue(session, { title: 't', description: 'd', findingIds: [findingIds[0]],
      evidenceState: 'UNSUPPORTED_IN_MATERIAL', ...overrides }), session);
  }
  const next = addFinding(session, findingInput({ rawText: 'verbatim reviewer text' }));
  for (const id of Object.keys(next.findings)) validateRouteInputRef(next, { kind: 'FINDING', id });
  const clustered = createSemanticIssue(next, { title: 't', description: 'd', findingIds: Object.keys(next.findings), evidenceState: 'PARTIALLY_SUPPORTED' });
  for (const id of Object.keys(clustered.semanticIssues)) validateRouteInputRef(clustered, { kind: 'SEMANTIC_ISSUE', id });
});
check('the other session ledger writes also leave state their canonical validators accept', () => {
  const { session, issueId } = withIssue();
  const adjudicated = adjudicate(session, { semanticIssueId: issueId, judgment: 'NEW_MATERIAL', actionChange: 'YES' });
  const planned = planRevisionAction(adjudicated, { sourceRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }], description: 'd', targetLocation: 'l' });
  assertRevisionActionLedgerIntegrity(planned);
  const [actionId] = Object.keys(planned.revisionActions);
  const implemented = implementRevisionAction(planned, actionId);
  assertRevisionActionLedgerIntegrity(implemented);
  const { sourceSession, successorSession } = createRevisionSuccessorSession(implemented, 'Synthetic memo, revised with notice periods confirmed.');
  const verified = recordRevisionVerification(sourceSession, successorSession, { revisionActionId: actionId, verdict: 'VERIFIED_PRESENT', evidence: 'Section 2 now names notice periods.' });
  assertRevisionVerificationLedgerIntegrity(verified);
  for (const id of INHERITED_IDS) {
    assert.throws(() => recordRevisionVerification(sourceSession, successorSession, { revisionActionId: id, verdict: 'VERIFIED_PRESENT', evidence: 'e' }));
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
