import assert from 'node:assert/strict';
import {
  createSession,
  addAuthorContextItem,
  freezeInput,
  addFinding,
  createSemanticIssue,
  adjudicate,
  planRevisionAction,
  implementRevisionAction,
  completeSession,
  createDeliberationState,
  verifyDeliberationBinding,
  routeForRootCause,
  validateRouteInputRef,
  createUnresolvedQuestion,
  registerUnresolvedQuestion,
  planRouteForQuestion,
  recordRouteDecision,
  applyCostSpend,
  applyLatencySpend,
  createContextRequest,
  recordRouteAttemptStart,
  recordRouteOutcome,
  recordQuestionDisposition,
  isQuestionCurrent,
  createCrossSessionTransition,
  assertSessionVersionLineageChildIntegrity,
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

async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}\n      ${err.message.split('\n')[0]}`);
    failed++;
  }
}

// --- Synthetic, non-client fixture: a fictional vendor-consolidation memo. -----

const ARTIFACT_TEXT = `Vendor Consolidation Memo — Q1 Planning

We recommend consolidating from four project-management vendors down to one
by the end of Q1. The migration will be handled by the platform team over a
three-week window, with no additional contractor budget.`;

function buildFixtureSession() {
  let session = createSession(ARTIFACT_TEXT);
  session = addAuthorContextItem(session, 'confirmedFacts', {
    text: 'The three-week migration window was set by the platform team lead, not negotiated with vendors.',
    sourceType: 'AUTHOR',
  });
  session = addAuthorContextItem(session, 'constraints', {
    text: 'No additional contractor budget is available for the migration.',
    sourceType: 'ARTIFACT',
  });
  return session;
}

function buildReviewedFixtureSession() {
  let session = freezeInput(buildFixtureSession());
  session = addFinding(session, {
    reviewerRunId: 'run-1',
    type: 'EXECUTION_RISK',
    title: 'Three-week migration window may not account for vendor contract termination notice periods',
    artifactLocation: 'paragraph 1',
    evidenceState: 'UNSUPPORTED_IN_MATERIAL',
    whyMaterial: 'Standard vendor contracts often require 30-60 day notice; a three-week window may not be feasible.',
    likelyRecipientChallenge: 'Have the termination notice periods been checked?',
    minimumBeforeSendAction: 'Confirm notice periods with each vendor.',
  });
  session = addFinding(session, {
    reviewerRunId: 'run-1',
    type: 'CLAIM',
    title: 'Claim that the platform team can absorb migration work is unverified',
    artifactLocation: 'paragraph 1',
    evidenceState: 'UNSUPPORTED_IN_MATERIAL',
    whyMaterial: 'If the team cannot absorb the work, the timeline slips.',
    likelyRecipientChallenge: 'Has the platform team confirmed capacity?',
    minimumBeforeSendAction: 'Confirm capacity with the platform team lead.',
  });
  return session;
}

function buildFixtureWithIssue() {
  const session = buildReviewedFixtureSession();
  const findingIds = Object.keys(session.findings);
  const clustered = createSemanticIssue(session, {
    title: 'Migration timeline feasibility is unconfirmed',
    description: 'Both findings point at the same unconfirmed timeline dependency.',
    findingIds,
    evidenceState: 'UNSUPPORTED_IN_MATERIAL',
  });
  const issueId = Object.keys(clustered.semanticIssues)[0];
  return { session: clustered, issueId, findingIds };
}

function buildAdjudicatedFixture() {
  const { session, issueId, findingIds } = buildFixtureWithIssue();
  const adjudicated = adjudicate(session, {
    semanticIssueId: issueId,
    judgment: 'NEW_MATERIAL',
    actionChange: 'YES',
    note: 'Material timeline risk, not previously raised.',
  });
  return { session: adjudicated, issueId, findingIds };
}

function buildRevisionPlannedFixture() {
  const { session, issueId } = buildAdjudicatedFixture();
  const planned = planRevisionAction(session, {
    sourceRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
    description: 'Add vendor notice-period confirmation to the migration plan.',
    targetLocation: 'Migration Plan section',
  });
  return { session: planned, issueId };
}

function buildCompletedFixture() {
  const { session } = buildRevisionPlannedFixture();
  const actionId = Object.keys(session.revisionActions)[0];
  return completeSession(implementRevisionAction(session, actionId));
}

/** Convenience: build+register an UnresolvedQuestion in one step, returning the new state and the registered question. */
function buildRegisteredQuestion(session, state, input) {
  const question = createUnresolvedQuestion(session, input);
  const registered = registerUnresolvedQuestion(session, state, question);
  return { state: registered, question };
}

/** Convenience: register a question for the given rootCause, then plan+record its RouteDecision via the real API (never a raw history insert). */
function buildRecordedDecisionFixture(rootCause, costCeiling = 5, latencyCeiling = 5) {
  const { session, issueId, findingIds } = buildFixtureWithIssue();
  const state0 = createDeliberationState(session, { costCeiling, latencyCeiling });
  const { state: state1, question } = buildRegisteredQuestion(session, state0, {
    rootCause,
    materialityReason: `material ${rootCause}`,
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  const decision = planRouteForQuestion(session, state1, question);
  const state2 = recordRouteDecision(session, state1, decision);
  return { session, state: state2, decision, question, issueId, findingIds };
}

/** Convenience: same as buildRecordedDecisionFixture, then starts the RouteAttempt. */
function buildStartedAttemptFixture(rootCause, costCeiling = 5, latencyCeiling = 5) {
  const { session, state, decision, question, issueId, findingIds } = buildRecordedDecisionFixture(
    rootCause,
    costCeiling,
    latencyCeiling
  );
  const started = recordRouteAttemptStart(session, state, decision.id);
  return { session, state: started, decision, question, issueId, findingIds };
}

/** Convenience: registers a CONTEXT_GAP question, plans+records its ADD_CONTEXT RouteDecision, and starts the RouteAttempt -- ready for createContextRequest({attemptId}). */
function buildAddContextAttemptFixture(costCeiling = 5, latencyCeiling = 5) {
  const { session, state, decision, question, issueId, findingIds } = buildStartedAttemptFixture('CONTEXT_GAP', costCeiling, latencyCeiling);
  const attempt = state.attempts[0];
  return { session, state, decision, question, issueId, findingIds, attempt };
}

/** Convenience: a started ADD_CONTEXT attempt with its ContextRequest already recorded -- ready for a successful recordRouteOutcome(SUPPLIED|DECLINED). */
function buildAddContextRequestedFixture(costCeiling = 5, latencyCeiling = 5) {
  const base = buildAddContextAttemptFixture(costCeiling, latencyCeiling);
  const result = createContextRequest(base.session, base.state, {
    attemptId: base.attempt.attemptId,
    category: 'constraints',
    question: 'What is the actual budget ceiling?',
    inferenceReason: 'x',
  });
  return { ...base, state: result.deliberationState, contextRequest: result.contextRequest };
}

/** Convenience: a started ADD_CONTEXT attempt whose ContextRequest already has a recorded SUPPLIED RouteOutcome -- ready for createCrossSessionTransition({suppliedOutcomeAttemptId}). */
function buildAddContextSuppliedFixture(responseText = 'The actual budget ceiling is $50,000.', costCeiling = 5, latencyCeiling = 5) {
  const base = buildAddContextRequestedFixture(costCeiling, latencyCeiling);
  const next = recordRouteOutcome(base.session, base.state, {
    attemptId: base.attempt.attemptId,
    status: 'SUCCEEDED',
    latencyConsumed: 1,
    result: 'SUPPLIED',
    contextRequestId: base.contextRequest.id,
    responseText,
  });
  const outcome = next.outcomes.find((o) => o.attemptId === base.attempt.attemptId);
  return { ...base, state: next, outcome };
}

/** Convenience: builds a SECOND, independent CONTEXT_GAP -> ADD_CONTEXT -> SUPPLIED cycle on top of an already-built session/state (e.g. after a first CROSS_SESSION transition), for tests needing two independent ADD_CONTEXT histories in one DeliberationState. */
function extendWithSecondSuppliedCycle(session, state, responseText = 'A second, independent supplied response.') {
  const { state: state1, question } = buildRegisteredQuestion(session, state, {
    rootCause: 'CONTEXT_GAP',
    materialityReason: 'material CONTEXT_GAP (second cycle)',
    inputRefs: [{ kind: 'AUTHOR_CONTEXT_ITEM', id: session.authorContext.confirmedFacts[0].id }],
  });
  const decision = planRouteForQuestion(session, state1, question);
  const state2 = recordRouteDecision(session, state1, decision);
  const state3 = recordRouteAttemptStart(session, state2, decision.id);
  const attempt = state3.attempts.find((a) => a.decisionId === decision.id);
  const { deliberationState: state4, contextRequest } = createContextRequest(session, state3, {
    attemptId: attempt.attemptId,
    category: 'confirmedFacts',
    question: 'second independent request',
    inferenceReason: 'z',
  });
  const state5 = recordRouteOutcome(session, state4, {
    attemptId: attempt.attemptId,
    status: 'SUCCEEDED',
    latencyConsumed: 1,
    result: 'SUPPLIED',
    contextRequestId: contextRequest.id,
    responseText,
  });
  return { session, state: state5, attempt, question, contextRequest };
}

/** Convenience: adds one new ReviewFinding with the given reviewerRunId via the real addFinding API, returning the updated session and the new finding's id. */
function addReviewerFinding(session, reviewerRunId, overrides = {}) {
  const before = new Set(Object.keys(session.findings));
  const next = addFinding(session, {
    reviewerRunId,
    type: 'CLAIM',
    title: 'A reviewer-produced finding for ADD_REVIEWER outcome testing',
    artifactLocation: 'paragraph 1',
    evidenceState: 'UNSUPPORTED_IN_MATERIAL',
    whyMaterial: 'Testing ADD_REVIEWER RouteOutcome recording.',
    likelyRecipientChallenge: 'n/a',
    minimumBeforeSendAction: 'n/a',
    ...overrides,
  });
  const findingId = Object.keys(next.findings).find((id) => !before.has(id));
  return { session: next, findingId };
}

const NON_STOP_ROUTE_FIXTURES = [
  { rootCause: 'CONTEXT_GAP', route: 'ADD_CONTEXT' },
  { rootCause: 'EVIDENCE_GAP', route: 'SEEK_EVIDENCE' },
  { rootCause: 'STABILITY_QUESTION', route: 'REPLICATE' },
  { rootCause: 'COVERAGE_GAP', route: 'ADD_REVIEWER' },
  { rootCause: 'DECISION_SENSITIVE_CONFLICT', route: 'TARGETED_PEER_CHALLENGE' },
];

const VALID_FAILURE_FOR_DISPOSITION = { category: 'TRANSPORT', message: 'simulated failure for disposition testing' };

/** Convenience: full cycle through a generic FAILED RouteOutcome for the given rootCause. */
function buildFailedCycleFixture(rootCause, costCeiling = 5, latencyCeiling = 5) {
  const { session, state, decision, question, issueId, findingIds } = buildStartedAttemptFixture(rootCause, costCeiling, latencyCeiling);
  const attempt = state.attempts[0];
  const next = recordRouteOutcome(session, state, {
    attemptId: attempt.attemptId,
    status: 'FAILED',
    latencyConsumed: 1,
    failure: VALID_FAILURE_FOR_DISPOSITION,
  });
  return { session, state: next, decision, question, issueId, findingIds, attempt };
}

/** Convenience: full cycle through a successful ADD_REVIEWER RouteOutcome (COVERAGE_GAP), with one fresh finding. */
function buildAddReviewerSuccessCycleFixture(reviewerRunId = 'reviewer-run-cycle', costCeiling = 5, latencyCeiling = 5) {
  const { session: session0, state, decision, question } = buildStartedAttemptFixture('COVERAGE_GAP', costCeiling, latencyCeiling);
  const attempt = state.attempts[0];
  const added = addReviewerFinding(session0, reviewerRunId);
  const next = recordRouteOutcome(added.session, state, {
    attemptId: attempt.attemptId,
    status: 'SUCCEEDED',
    latencyConsumed: 1,
    reviewerRunId,
    findingIds: [added.findingId],
  });
  return { session: added.session, state: next, decision, question, attempt };
}

/** Convenience: full cycle through a successful REPLICATE RouteOutcome (STABILITY_QUESTION). */
function buildReplicateSuccessCycleFixture(result = 'REPRODUCED', costCeiling = 5, latencyCeiling = 5) {
  const { session, state, decision, question, issueId } = buildStartedAttemptFixture('STABILITY_QUESTION', costCeiling, latencyCeiling);
  const attempt = state.attempts[0];
  const next = recordRouteOutcome(session, state, {
    attemptId: attempt.attemptId,
    status: 'SUCCEEDED',
    latencyConsumed: 1,
    result,
    targetRef: { kind: 'SEMANTIC_ISSUE', id: issueId },
  });
  return { session, state: next, decision, question, attempt };
}

/** Builds two registered questions with one recorded decision each in the same state. */
function buildTwoQuestionDecisionFixture(costCeiling = 5, latencyCeiling = 5) {
  const { session, issueId } = buildFixtureWithIssue();
  let state = createDeliberationState(session, { costCeiling, latencyCeiling });

  const first = buildRegisteredQuestion(session, state, {
    rootCause: 'COVERAGE_GAP',
    materialityReason: 'first question needs an additional reviewer',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  state = first.state;
  const second = buildRegisteredQuestion(session, state, {
    rootCause: 'STABILITY_QUESTION',
    materialityReason: 'second question needs replication',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  state = second.state;

  const firstDecision = planRouteForQuestion(session, state, first.question);
  state = recordRouteDecision(session, state, firstDecision);
  const secondDecision = planRouteForQuestion(session, state, second.question);
  state = recordRouteDecision(session, state, secondDecision);

  return {
    session,
    state,
    firstQuestion: first.question,
    secondQuestion: second.question,
    firstDecision,
    secondDecision,
  };
}

// ==================================================================
// A. createDeliberationState
// ==================================================================
console.log('\ncreateDeliberationState');

check('succeeds for a valid REVIEWED frozen session', () => {
  const session = buildReviewedFixtureSession();
  const state = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 60000 });
  assert.equal(state.sessionId, session.id);
  assert.equal(state.artifactHash, session.artifactHash);
  assert.equal(state.authorContextHash, session.authorContextHash);
  assert.deepEqual(state.history, []);
  assert.equal(state.costBudget.spent, 0);
  assert.equal(state.costBudget.ceiling, 5);
  assert.equal(state.latencyBudget.spent, 0);
  assert.equal(state.latencyBudget.ceiling, 60000);
  assert.deepEqual(state.unresolvedQuestions, []);
  assert.equal(state.stopReason, null);
  assert.equal(typeof state.id, 'string');
  assert.equal(typeof state.createdAt, 'string');
});

check('rejects DRAFT', () => {
  const session = buildFixtureSession();
  assert.throws(() => createDeliberationState(session, { costCeiling: 1, latencyCeiling: 1 }), /must be REVIEWED/);
});

check('rejects INPUT_FROZEN before any finding is reviewed', () => {
  const session = freezeInput(buildFixtureSession());
  assert.throws(() => createDeliberationState(session, { costCeiling: 1, latencyCeiling: 1 }), /must be REVIEWED/);
});

check('rejects ADJUDICATED', () => {
  const { session } = buildAdjudicatedFixture();
  assert.throws(() => createDeliberationState(session, { costCeiling: 1, latencyCeiling: 1 }), /must be REVIEWED/);
});

check('rejects REVISION_PLANNED', () => {
  const { session } = buildRevisionPlannedFixture();
  assert.throws(() => createDeliberationState(session, { costCeiling: 1, latencyCeiling: 1 }), /must be REVIEWED/);
});

check('rejects COMPLETED', () => {
  const session = buildCompletedFixture();
  assert.throws(() => createDeliberationState(session, { costCeiling: 1, latencyCeiling: 1 }), /must be REVIEWED/);
});

check('rejects a session missing its frozen hashes', () => {
  const raw = { ...buildReviewedFixtureSession(), artifactHash: null };
  assert.throws(() => createDeliberationState(raw, { costCeiling: 1, latencyCeiling: 1 }), /missing/i);
});

check('rejects a NaN ceiling', () => {
  const session = buildReviewedFixtureSession();
  assert.throws(() => createDeliberationState(session, { costCeiling: NaN, latencyCeiling: 1 }), /finite number/);
  assert.throws(() => createDeliberationState(session, { costCeiling: 1, latencyCeiling: NaN }), /finite number/);
});

check('rejects an Infinity ceiling', () => {
  const session = buildReviewedFixtureSession();
  assert.throws(() => createDeliberationState(session, { costCeiling: Infinity, latencyCeiling: 1 }), /finite number/);
});

check('rejects a negative ceiling', () => {
  const session = buildReviewedFixtureSession();
  assert.throws(() => createDeliberationState(session, { costCeiling: -1, latencyCeiling: 1 }), /finite number/);
});

check('accepts an explicit zero ceiling', () => {
  const session = buildReviewedFixtureSession();
  const state = createDeliberationState(session, { costCeiling: 0, latencyCeiling: 0 });
  assert.equal(state.costBudget.ceiling, 0);
  assert.equal(state.latencyBudget.ceiling, 0);
});

// ==================================================================
// B. Binding
// ==================================================================
console.log('\nBinding');

check('matching sessionId/hashes succeeds', () => {
  const session = buildReviewedFixtureSession();
  const state = createDeliberationState(session, { costCeiling: 1, latencyCeiling: 1 });
  assert.doesNotThrow(() => verifyDeliberationBinding(session, state));
});

check('a wrong sessionId fails', () => {
  const session = buildReviewedFixtureSession();
  const state = createDeliberationState(session, { costCeiling: 1, latencyCeiling: 1 });
  const otherSession = buildReviewedFixtureSession();
  assert.throws(() => verifyDeliberationBinding(otherSession, state), /bound to session/);
});

check('a wrong artifactHash fails', () => {
  const session = buildReviewedFixtureSession();
  const state = createDeliberationState(session, { costCeiling: 1, latencyCeiling: 1 });
  const tamperedState = { ...state, artifactHash: 'not-the-real-hash' };
  assert.throws(() => verifyDeliberationBinding(session, tamperedState), /artifactHash/);
});

check('a wrong authorContextHash fails', () => {
  const session = buildReviewedFixtureSession();
  const state = createDeliberationState(session, { costCeiling: 1, latencyCeiling: 1 });
  const tamperedState = { ...state, authorContextHash: 'not-the-real-hash' };
  assert.throws(() => verifyDeliberationBinding(session, tamperedState), /authorContextHash/);
});

check('a tampered frozen artifact fails', () => {
  const session = buildReviewedFixtureSession();
  const state = createDeliberationState(session, { costCeiling: 1, latencyCeiling: 1 });
  const tamperedSession = { ...session, artifactText: session.artifactText + ' TAMPERED' };
  assert.throws(() => verifyDeliberationBinding(tamperedSession, state), /no longer matches its frozen artifactHash/);
});

check('a tampered frozen AuthorContext fails', () => {
  const session = buildReviewedFixtureSession();
  const state = createDeliberationState(session, { costCeiling: 1, latencyCeiling: 1 });
  const sneaked = { id: 'x', text: 'sneaked in', sourceType: 'AUTHOR', status: 'CURRENT', createdAt: new Date().toISOString() };
  const tamperedSession = {
    ...session,
    authorContext: { ...session.authorContext, constraints: [...session.authorContext.constraints, sneaked] },
  };
  assert.throws(() => verifyDeliberationBinding(tamperedSession, state), /no longer matches its frozen authorContextHash/);
});

// ==================================================================
// C. Root-cause -> route mapping
// ==================================================================
console.log('\nRoot-cause -> route mapping');

check('all six mappings are exact', () => {
  assert.equal(routeForRootCause('NONE'), 'STOP');
  assert.equal(routeForRootCause('CONTEXT_GAP'), 'ADD_CONTEXT');
  assert.equal(routeForRootCause('EVIDENCE_GAP'), 'SEEK_EVIDENCE');
  assert.equal(routeForRootCause('STABILITY_QUESTION'), 'REPLICATE');
  assert.equal(routeForRootCause('COVERAGE_GAP'), 'ADD_REVIEWER');
  assert.equal(routeForRootCause('DECISION_SENSITIVE_CONFLICT'), 'TARGETED_PEER_CHALLENGE');
});

check('an unrecognized root cause is rejected, never guessed', () => {
  assert.throws(() => routeForRootCause('NOT_A_ROOT_CAUSE'), /unhandled root cause/);
});

// ==================================================================
// D. RouteInputRef validation
// ==================================================================
console.log('\nRouteInputRef validation');

check('a valid FINDING ref is accepted', () => {
  const { session, findingIds } = buildFixtureWithIssue();
  assert.doesNotThrow(() => validateRouteInputRef(session, { kind: 'FINDING', id: findingIds[0] }));
});

check('a valid SEMANTIC_ISSUE ref is accepted', () => {
  const { session, issueId } = buildFixtureWithIssue();
  assert.doesNotThrow(() => validateRouteInputRef(session, { kind: 'SEMANTIC_ISSUE', id: issueId }));
});

check('a valid AUTHOR_CONTEXT_ITEM ref is accepted', () => {
  const session = buildReviewedFixtureSession();
  const itemId = session.authorContext.constraints[0].id;
  assert.doesNotThrow(() => validateRouteInputRef(session, { kind: 'AUTHOR_CONTEXT_ITEM', id: itemId }));
});

check('an unknown FINDING id is rejected', () => {
  const { session } = buildFixtureWithIssue();
  assert.throws(() => validateRouteInputRef(session, { kind: 'FINDING', id: 'not-a-real-id' }), /unknown FINDING id/);
});

check('an unknown SEMANTIC_ISSUE id is rejected', () => {
  const { session } = buildFixtureWithIssue();
  assert.throws(() => validateRouteInputRef(session, { kind: 'SEMANTIC_ISSUE', id: 'not-a-real-id' }), /unknown SEMANTIC_ISSUE id/);
});

check('an unknown AUTHOR_CONTEXT_ITEM id is rejected', () => {
  const session = buildReviewedFixtureSession();
  assert.throws(
    () => validateRouteInputRef(session, { kind: 'AUTHOR_CONTEXT_ITEM', id: 'not-a-real-id' }),
    /unknown AUTHOR_CONTEXT_ITEM id/
  );
});

check('kind is never inferred from id shape -- a FINDING id under kind AUTHOR_CONTEXT_ITEM is rejected, not resolved', () => {
  const { session, findingIds } = buildFixtureWithIssue();
  assert.throws(
    () => validateRouteInputRef(session, { kind: 'AUTHOR_CONTEXT_ITEM', id: findingIds[0] }),
    /unknown AUTHOR_CONTEXT_ITEM id/
  );
});

check('an invalid ref kind is rejected', () => {
  const { session } = buildFixtureWithIssue();
  assert.throws(() => validateRouteInputRef(session, { kind: 'NOT_A_KIND', id: 'whatever' }), /invalid ref kind/);
});

// ==================================================================
// E. Question registration
// ==================================================================
console.log('\nQuestion registration');

check('a valid non-NONE question registers', () => {
  const { session, issueId } = buildFixtureWithIssue();
  const state = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const question = createUnresolvedQuestion(session, {
    rootCause: 'COVERAGE_GAP',
    materialityReason: 'No reviewer has checked whether the vendor contracts allow early termination.',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  const next = registerUnresolvedQuestion(session, state, question);
  assert.equal(next.unresolvedQuestions.length, 1);
  assert.deepEqual(next.unresolvedQuestions[0], question);
});

check('registration is immutable -- the original DeliberationState is unchanged', () => {
  const { session, issueId } = buildFixtureWithIssue();
  const state = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const question = createUnresolvedQuestion(session, {
    rootCause: 'COVERAGE_GAP',
    materialityReason: 'x',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  const before = JSON.parse(JSON.stringify(state));
  const next = registerUnresolvedQuestion(session, state, question);
  assert.deepEqual(state, before, 'original state must be unchanged');
  assert.notEqual(next, state, 'a new object must be returned');
  assert.equal(state.unresolvedQuestions.length, 0);
  assert.equal(next.unresolvedQuestions.length, 1);
});

check('a duplicate question id is rejected, not replaced or merged', () => {
  const { session, issueId } = buildFixtureWithIssue();
  const state = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const question = createUnresolvedQuestion(session, {
    rootCause: 'COVERAGE_GAP',
    materialityReason: 'x',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  const registered = registerUnresolvedQuestion(session, state, question);
  assert.throws(() => registerUnresolvedQuestion(session, registered, question), /already registered/);
  assert.equal(registered.unresolvedQuestions.length, 1);
});

check('rootCause NONE is rejected at registration', () => {
  const session = buildReviewedFixtureSession();
  const state = createDeliberationState(session, { costCeiling: 1, latencyCeiling: 1 });
  const question = {
    id: 'q-none',
    rootCause: 'NONE',
    materialityReason: 'nothing material remains',
    inputRefs: [],
    createdAt: new Date().toISOString(),
  };
  assert.throws(() => registerUnresolvedQuestion(session, state, question), /rootCause NONE cannot be registered/);
});

check('an invalid rootCause string from a plain-JS caller is rejected', () => {
  const { session, issueId } = buildFixtureWithIssue();
  const state = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const question = {
    id: 'q-invalid',
    rootCause: 'NOT_A_ROOT_CAUSE',
    materialityReason: 'x',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
    createdAt: new Date().toISOString(),
  };
  assert.throws(() => registerUnresolvedQuestion(session, state, question), /invalid rootCause/);
});

check('an invalid ref is rejected at registration', () => {
  const session = buildReviewedFixtureSession();
  const state = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const question = {
    id: 'q-bad-ref',
    rootCause: 'COVERAGE_GAP',
    materialityReason: 'x',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: 'not-a-real-id' }],
    createdAt: new Date().toISOString(),
  };
  assert.throws(() => registerUnresolvedQuestion(session, state, question), /unknown SEMANTIC_ISSUE id/);
});

check('a non-NONE question with empty refs is rejected at registration', () => {
  const session = buildReviewedFixtureSession();
  const state = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const question = {
    id: 'q-empty-refs',
    rootCause: 'COVERAGE_GAP',
    materialityReason: 'x',
    inputRefs: [],
    createdAt: new Date().toISOString(),
  };
  assert.throws(() => registerUnresolvedQuestion(session, state, question), /at least one inputRef is required/);
});

check('registration is rejected once the deliberation has stopped', () => {
  const session = buildReviewedFixtureSession();
  const state = createDeliberationState(session, { costCeiling: 1, latencyCeiling: 1 });
  const stopQuestion = createUnresolvedQuestion(session, { rootCause: 'NONE', materialityReason: 'x', inputRefs: [] });
  const stopDecision = planRouteForQuestion(session, state, stopQuestion);
  const stopped = recordRouteDecision(session, state, stopDecision, { stopReason: 'successful' });

  const question = {
    id: 'q-after-stop',
    rootCause: 'COVERAGE_GAP',
    materialityReason: 'x',
    inputRefs: [],
    createdAt: new Date().toISOString(),
  };
  assert.throws(() => registerUnresolvedQuestion(session, stopped, question), /already stopped/);
});

// ==================================================================
// F. RouteDecision planning (registered-question binding)
// ==================================================================
console.log('\nRouteDecision planning');

check('a registered question plans successfully; route is derived and questionId is set', () => {
  const { session, issueId } = buildFixtureWithIssue();
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const { state, question } = buildRegisteredQuestion(session, state0, {
    rootCause: 'DECISION_SENSITIVE_CONFLICT',
    materialityReason: 'Two findings conflict on timeline feasibility, and the answer changes whether the memo can be sent as-is.',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  const decision = planRouteForQuestion(session, state, question);
  assert.equal(decision.route, 'TARGETED_PEER_CHALLENGE');
  assert.equal(decision.reason.rootCause, 'DECISION_SENSITIVE_CONFLICT');
  assert.equal(decision.questionId, question.id);
  assert.deepEqual(decision.inputRefs, [{ kind: 'SEMANTIC_ISSUE', id: issueId }]);
});

check('an unregistered question is rejected', () => {
  const { session, issueId } = buildFixtureWithIssue();
  const state = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const question = createUnresolvedQuestion(session, {
    rootCause: 'COVERAGE_GAP',
    materialityReason: 'x',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  assert.throws(() => planRouteForQuestion(session, state, question), /not a currently registered unresolved question/);
});

check('same id + changed rootCause is rejected', () => {
  const { session, issueId } = buildFixtureWithIssue();
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const { state, question } = buildRegisteredQuestion(session, state0, {
    rootCause: 'COVERAGE_GAP',
    materialityReason: 'x',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  const tampered = { ...question, rootCause: 'EVIDENCE_GAP' };
  assert.throws(() => planRouteForQuestion(session, state, tampered), /has rootCause .* not the supplied/);
});

check('same id + changed materialityReason is rejected', () => {
  const { session, issueId } = buildFixtureWithIssue();
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const { state, question } = buildRegisteredQuestion(session, state0, {
    rootCause: 'COVERAGE_GAP',
    materialityReason: 'original reason',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  const tampered = { ...question, materialityReason: 'a different reason' };
  assert.throws(() => planRouteForQuestion(session, state, tampered), /different materialityReason/);
});

check('same id + changed refs is rejected', () => {
  const { session, issueId, findingIds } = buildFixtureWithIssue();
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const { state, question } = buildRegisteredQuestion(session, state0, {
    rootCause: 'COVERAGE_GAP',
    materialityReason: 'x',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  const tampered = { ...question, inputRefs: [{ kind: 'FINDING', id: findingIds[0] }] };
  assert.throws(() => planRouteForQuestion(session, state, tampered), /different inputRefs/);
});

check('reordered refs are rejected -- ref comparison is order-sensitive', () => {
  const { session, findingIds } = buildFixtureWithIssue();
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const { state, question } = buildRegisteredQuestion(session, state0, {
    rootCause: 'COVERAGE_GAP',
    materialityReason: 'x',
    inputRefs: [
      { kind: 'FINDING', id: findingIds[0] },
      { kind: 'FINDING', id: findingIds[1] },
    ],
  });
  const reordered = { ...question, inputRefs: [question.inputRefs[1], question.inputRefs[0]] };
  assert.throws(() => planRouteForQuestion(session, state, reordered), /different inputRefs/);
});

check('planning is rejected once the deliberation has stopped', () => {
  const { session, issueId } = buildFixtureWithIssue();
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const { state } = buildRegisteredQuestion(session, state0, {
    rootCause: 'COVERAGE_GAP',
    materialityReason: 'x',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  const stopQuestion = createUnresolvedQuestion(session, { rootCause: 'NONE', materialityReason: 'x', inputRefs: [] });
  const stopDecision = planRouteForQuestion(session, state, stopQuestion);
  const stopped = recordRouteDecision(session, state, stopDecision, { stopReason: 'successful' });

  const anotherQuestion = createUnresolvedQuestion(session, {
    rootCause: 'COVERAGE_GAP',
    materialityReason: 'x',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  assert.throws(() => planRouteForQuestion(session, stopped, anotherQuestion), /already stopped/);
});

check('planRouteForQuestion still makes zero provider calls -- pure, no observable side effects', () => {
  const { session, issueId } = buildFixtureWithIssue();
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const { state, question } = buildRegisteredQuestion(session, state0, {
    rootCause: 'COVERAGE_GAP',
    materialityReason: 'No reviewer has checked whether the vendor contracts allow early termination.',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  const sessionBefore = JSON.parse(JSON.stringify(session));
  const stateBefore = JSON.parse(JSON.stringify(state));
  const decision = planRouteForQuestion(session, state, question);
  assert.deepEqual(session, sessionBefore, 'session must be unchanged');
  assert.deepEqual(state, stateBefore, 'deliberationState must be unchanged');
  assert.equal(decision.route, 'ADD_REVIEWER');
});

// ==================================================================
// G. STOP identity
// ==================================================================
console.log('\nSTOP identity');

check('NONE plans STOP with questionId=null', () => {
  const session = buildReviewedFixtureSession();
  const state = createDeliberationState(session, { costCeiling: 1, latencyCeiling: 1 });
  const question = createUnresolvedQuestion(session, {
    rootCause: 'NONE',
    materialityReason: 'nothing material remains',
    inputRefs: [],
  });
  const decision = planRouteForQuestion(session, state, question);
  assert.equal(decision.route, 'STOP');
  assert.equal(decision.questionId, null);
});

check('STOP records with questionId=null and a valid StopReason', () => {
  const session = buildReviewedFixtureSession();
  const state = createDeliberationState(session, { costCeiling: 1, latencyCeiling: 1 });
  const question = createUnresolvedQuestion(session, { rootCause: 'NONE', materialityReason: 'x', inputRefs: [] });
  const decision = planRouteForQuestion(session, state, question);
  const next = recordRouteDecision(session, state, decision, { stopReason: 'successful' });
  assert.equal(next.stopReason, 'successful');
  assert.equal(next.history[0].questionId, null);
});

check('a STOP decision with a non-null questionId is rejected', () => {
  const session = buildReviewedFixtureSession();
  const state = createDeliberationState(session, { costCeiling: 1, latencyCeiling: 1 });
  const manual = {
    id: 'manual-stop-bad',
    route: 'STOP',
    reason: { rootCause: 'NONE', materialityReason: 'x' },
    inputRefs: [],
    questionId: 'some-question-id',
    createdAt: new Date().toISOString(),
  };
  assert.throws(() => recordRouteDecision(session, state, manual, { stopReason: 'successful' }), /questionId=null/);
});

check('a non-STOP decision with a null questionId is rejected', () => {
  const { session, issueId } = buildFixtureWithIssue();
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const { state } = buildRegisteredQuestion(session, state0, {
    rootCause: 'COVERAGE_GAP',
    materialityReason: 'x',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  const manual = {
    id: 'manual-nonstop-bad',
    route: 'ADD_REVIEWER',
    reason: { rootCause: 'COVERAGE_GAP', materialityReason: 'x' },
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
    questionId: null,
    createdAt: new Date().toISOString(),
  };
  assert.throws(() => recordRouteDecision(session, state, manual), /requires a non-empty questionId/);
});

// ==================================================================
// H. Recording binding
// ==================================================================
console.log('\nRecording binding');

check('a valid registered-question decision records successfully', () => {
  const { session, issueId } = buildFixtureWithIssue();
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const { state, question } = buildRegisteredQuestion(session, state0, {
    rootCause: 'COVERAGE_GAP',
    materialityReason: 'x',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  const decision = planRouteForQuestion(session, state, question);
  const next = recordRouteDecision(session, state, decision);
  assert.equal(next.history.length, 1);
  assert.equal(next.history[0].questionId, question.id);
});

check('an unknown questionId is rejected', () => {
  const { session, issueId } = buildFixtureWithIssue();
  const state = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const manual = {
    id: 'manual-unknown-q',
    route: 'ADD_REVIEWER',
    reason: { rootCause: 'COVERAGE_GAP', materialityReason: 'x' },
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
    questionId: 'not-a-registered-id',
    createdAt: new Date().toISOString(),
  };
  assert.throws(() => recordRouteDecision(session, state, manual), /not a currently registered unresolved question/);
});

check("a decision whose rootCause disagrees with the registered question's is rejected", () => {
  const { session, issueId } = buildFixtureWithIssue();
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const { state, question } = buildRegisteredQuestion(session, state0, {
    rootCause: 'COVERAGE_GAP',
    materialityReason: 'x',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  const manual = {
    id: 'manual-wrong-rootcause',
    route: 'SEEK_EVIDENCE',
    reason: { rootCause: 'EVIDENCE_GAP', materialityReason: 'x' },
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
    questionId: question.id,
    createdAt: new Date().toISOString(),
  };
  assert.throws(() => recordRouteDecision(session, state, manual), /has rootCause .* not/);
});

check("a decision whose materialityReason disagrees with the registered question's is rejected", () => {
  const { session, issueId } = buildFixtureWithIssue();
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const { state, question } = buildRegisteredQuestion(session, state0, {
    rootCause: 'COVERAGE_GAP',
    materialityReason: 'original reason',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  const manual = {
    id: 'manual-wrong-materiality',
    route: 'ADD_REVIEWER',
    reason: { rootCause: 'COVERAGE_GAP', materialityReason: 'a different reason' },
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
    questionId: question.id,
    createdAt: new Date().toISOString(),
  };
  assert.throws(() => recordRouteDecision(session, state, manual), /different materialityReason/);
});

check("a decision whose inputRefs disagree with the registered question's is rejected", () => {
  const { session, issueId, findingIds } = buildFixtureWithIssue();
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const { state, question } = buildRegisteredQuestion(session, state0, {
    rootCause: 'COVERAGE_GAP',
    materialityReason: 'x',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  const manual = {
    id: 'manual-wrong-refs',
    route: 'ADD_REVIEWER',
    reason: { rootCause: 'COVERAGE_GAP', materialityReason: 'x' },
    inputRefs: [{ kind: 'FINDING', id: findingIds[0] }],
    questionId: question.id,
    createdAt: new Date().toISOString(),
  };
  assert.throws(() => recordRouteDecision(session, state, manual), /different inputRefs/);
});

check('a decision whose ref shares the registered id but claims the wrong kind is rejected, never coerced', () => {
  const { session, findingIds } = buildFixtureWithIssue();
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const { state, question } = buildRegisteredQuestion(session, state0, {
    rootCause: 'STABILITY_QUESTION',
    materialityReason: 'x',
    inputRefs: [{ kind: 'FINDING', id: findingIds[0] }],
  });
  const manual = {
    id: 'manual-wrong-kind',
    route: 'REPLICATE',
    reason: { rootCause: 'STABILITY_QUESTION', materialityReason: 'x' },
    inputRefs: [{ kind: 'AUTHOR_CONTEXT_ITEM', id: findingIds[0] }],
    questionId: question.id,
    createdAt: new Date().toISOString(),
  };
  assert.throws(() => recordRouteDecision(session, state, manual), /unknown AUTHOR_CONTEXT_ITEM id|different inputRefs/);
});

check('reordered inputRefs are rejected when recording', () => {
  const { session, findingIds } = buildFixtureWithIssue();
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const { state, question } = buildRegisteredQuestion(session, state0, {
    rootCause: 'COVERAGE_GAP',
    materialityReason: 'x',
    inputRefs: [
      { kind: 'FINDING', id: findingIds[0] },
      { kind: 'FINDING', id: findingIds[1] },
    ],
  });
  const manual = {
    id: 'manual-reordered',
    route: 'ADD_REVIEWER',
    reason: { rootCause: 'COVERAGE_GAP', materialityReason: 'x' },
    inputRefs: [
      { kind: 'FINDING', id: findingIds[1] },
      { kind: 'FINDING', id: findingIds[0] },
    ],
    questionId: question.id,
    createdAt: new Date().toISOString(),
  };
  assert.throws(() => recordRouteDecision(session, state, manual), /different inputRefs/);
});

// ==================================================================
// I. Terminal STOP behavior
// ==================================================================
console.log('\nTerminal STOP behavior');

check('STOP records a StopReason', () => {
  const session = buildReviewedFixtureSession();
  const state = createDeliberationState(session, { costCeiling: 1, latencyCeiling: 1 });
  const question = createUnresolvedQuestion(session, {
    rootCause: 'NONE',
    materialityReason: 'No material item remains unresolved.',
    inputRefs: [],
  });
  const decision = planRouteForQuestion(session, state, question);
  assert.equal(decision.route, 'STOP');
  const next = recordRouteDecision(session, state, decision, { stopReason: 'successful' });
  assert.equal(next.stopReason, 'successful');
  assert.equal(next.history.length, 1);
});

check('STOP without an explicit stopReason is rejected', () => {
  const session = buildReviewedFixtureSession();
  const state = createDeliberationState(session, { costCeiling: 1, latencyCeiling: 1 });
  const question = createUnresolvedQuestion(session, { rootCause: 'NONE', materialityReason: 'x', inputRefs: [] });
  const decision = planRouteForQuestion(session, state, question);
  assert.throws(() => recordRouteDecision(session, state, decision), /requires an explicit stopReason/);
});

check('no RouteDecision may be appended once stopped', () => {
  const { session, issueId } = buildFixtureWithIssue();
  const state = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const stopQuestion = createUnresolvedQuestion(session, { rootCause: 'NONE', materialityReason: 'x', inputRefs: [] });
  const stopDecision = planRouteForQuestion(session, state, stopQuestion);
  const stopped = recordRouteDecision(session, state, stopDecision, { stopReason: 'successful' });

  // Registration itself is already refused post-stop (Section E); confirm recording is refused too,
  // even for a decision that would otherwise be structurally valid.
  const anotherDecision = {
    id: 'manual-post-stop',
    route: 'ADD_REVIEWER',
    reason: { rootCause: 'COVERAGE_GAP', materialityReason: 'x' },
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
    questionId: 'irrelevant-since-already-stopped',
    createdAt: new Date().toISOString(),
  };
  assert.throws(() => recordRouteDecision(session, stopped, anotherDecision), /already stopped/);
});

check('a non-STOP route does not terminate the deliberation', () => {
  const { session, issueId } = buildFixtureWithIssue();
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const { state, question } = buildRegisteredQuestion(session, state0, {
    rootCause: 'STABILITY_QUESTION',
    materialityReason: 'x',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  const decision = planRouteForQuestion(session, state, question);
  const next = recordRouteDecision(session, state, decision);
  assert.equal(next.stopReason, null);
  assert.equal(next.history.length, 1);
});

check('a stopReason may only be supplied when route is STOP', () => {
  const { session, issueId } = buildFixtureWithIssue();
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const { state, question } = buildRegisteredQuestion(session, state0, {
    rootCause: 'COVERAGE_GAP',
    materialityReason: 'x',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  const decision = planRouteForQuestion(session, state, question);
  assert.throws(
    () => recordRouteDecision(session, state, decision, { stopReason: 'successful' }),
    /only be supplied when route is STOP/
  );
});

// ==================================================================
// J. Immutability
// ==================================================================
console.log('\nImmutability');

check('the original StressTestSession is never mutated by any deliberation function', () => {
  const { session, issueId } = buildFixtureWithIssue();
  const before = JSON.parse(JSON.stringify(session));
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const { state, question } = buildRegisteredQuestion(session, state0, {
    rootCause: 'COVERAGE_GAP',
    materialityReason: 'x',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  const decision = planRouteForQuestion(session, state, question);
  recordRouteDecision(session, state, decision);

  const itemId = session.authorContext.constraints[0].id;
  const { state: stateWithContext, question: contextQuestion } = buildRegisteredQuestion(session, state, {
    rootCause: 'CONTEXT_GAP',
    materialityReason: 'x',
    inputRefs: [{ kind: 'AUTHOR_CONTEXT_ITEM', id: itemId }],
  });
  const contextDecision = planRouteForQuestion(session, stateWithContext, contextQuestion);
  const stateWithContextDecision = recordRouteDecision(session, stateWithContext, contextDecision);
  const stateWithContextAttempt = recordRouteAttemptStart(session, stateWithContextDecision, contextDecision.id);
  const contextAttempt = stateWithContextAttempt.attempts.find((a) => a.decisionId === contextDecision.id);
  createContextRequest(session, stateWithContextAttempt, {
    attemptId: contextAttempt.attemptId,
    category: 'constraints',
    question: 'What is the actual contractor budget ceiling?',
    inferenceReason: 'This cannot be inferred from the artifact text alone.',
  });
  assert.deepEqual(session, before);
});

check('the previous DeliberationState is never mutated -- recordRouteDecision returns a new object', () => {
  const { session, issueId } = buildFixtureWithIssue();
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const { state, question } = buildRegisteredQuestion(session, state0, {
    rootCause: 'COVERAGE_GAP',
    materialityReason: 'x',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  const decision = planRouteForQuestion(session, state, question);
  const before = JSON.parse(JSON.stringify(state));
  const next = recordRouteDecision(session, state, decision);
  assert.deepEqual(state, before, 'the original state object must be unchanged');
  assert.notEqual(next, state, 'a new object must be returned');
  assert.equal(state.history.length, 0);
  assert.equal(next.history.length, 1);
});

check('applyCostSpend/applyLatencySpend return new objects without mutating the original', () => {
  const { session } = buildFixtureWithIssue();
  const state = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5000 });
  const afterCost = applyCostSpend(state, 1);
  assert.equal(state.costBudget.spent, 0);
  assert.equal(afterCost.costBudget.spent, 1);
  const afterLatency = applyLatencySpend(afterCost, 100);
  assert.equal(afterCost.latencyBudget.spent, 0);
  assert.equal(afterLatency.latencyBudget.spent, 100);
});

// ==================================================================
// K. Budget accounting
// ==================================================================
console.log('\nBudget accounting');

check('spending within the ceiling succeeds and increments spent', () => {
  const { session } = buildFixtureWithIssue();
  const state = createDeliberationState(session, { costCeiling: 3, latencyCeiling: 3000 });
  const s1 = applyCostSpend(state, 1);
  const s2 = applyCostSpend(s1, 1);
  assert.equal(s2.costBudget.spent, 2);
});

check('spending exactly the ceiling is accepted', () => {
  const { session } = buildFixtureWithIssue();
  const state = createDeliberationState(session, { costCeiling: 2, latencyCeiling: 2000 });
  const spent = applyCostSpend(state, 2);
  assert.equal(spent.costBudget.spent, 2);
});

check('spending over the ceiling is rejected', () => {
  const { session } = buildFixtureWithIssue();
  const state = createDeliberationState(session, { costCeiling: 1, latencyCeiling: 1000 });
  assert.throws(() => applyCostSpend(state, 2), /would exceed the cost ceiling/);
});

check('latency spending over the ceiling is rejected', () => {
  const { session } = buildFixtureWithIssue();
  const state = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 100 });
  assert.throws(() => applyLatencySpend(state, 101), /would exceed the latency ceiling/);
});

check('negative/NaN/Infinity spend amounts are rejected', () => {
  const { session } = buildFixtureWithIssue();
  const state = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5000 });
  assert.throws(() => applyCostSpend(state, -1), /finite number/);
  assert.throws(() => applyCostSpend(state, NaN), /finite number/);
  assert.throws(() => applyCostSpend(state, Infinity), /finite number/);
});

// ==================================================================
// L. ContextRequest (ADD_CONTEXT output, bound to a registered question)
// ==================================================================
console.log('\nContextRequest (ADD_CONTEXT output)');

// --- Initial state / legacy ledger ------------------------------------------

check('createDeliberationState initializes contextRequests=[]; no cache/index field exists', () => {
  const session = buildReviewedFixtureSession();
  const state = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  assert.deepEqual(state.contextRequests, []);
  assert.equal('contextRequestByAttempt' in state, false);
  assert.equal('requestIndex' in state, false);
  assert.equal('currentRequest' in state, false);
});

check('a legacy state missing contextRequests reads as []; a successful create returns a NEW state with the field materialized, leaving the original untouched', () => {
  const { session, state, attempt } = buildAddContextAttemptFixture();
  const legacyState = { ...state };
  delete legacyState.contextRequests;

  const result = createContextRequest(session, legacyState, {
    attemptId: attempt.attemptId,
    category: 'constraints',
    question: 'x?',
    inferenceReason: 'x',
  });
  assert.equal(result.deliberationState.contextRequests.length, 1);
  assert.equal('contextRequests' in legacyState, false);
});

// --- Happy path --------------------------------------------------------------

check('happy path: captures originatingAttemptId/originatingQuestionId/originatingSessionId/hashes/sourceRefs; ledger records exactly one request', () => {
  const { session, state, question, attempt } = buildAddContextAttemptFixture();
  const result = createContextRequest(session, state, {
    attemptId: attempt.attemptId,
    category: 'constraints',
    question: 'Is "no additional contractor budget" a hard constraint or a planning assumption that could change?',
    inferenceReason: "This cannot be inferred from the artifact text alone -- it depends on the author's actual authority.",
  });
  assert.equal(result.contextRequest.originatingAttemptId, attempt.attemptId);
  assert.equal(result.contextRequest.originatingQuestionId, question.id);
  assert.equal(result.contextRequest.originatingSessionId, session.id);
  assert.equal(result.contextRequest.artifactHash, session.artifactHash);
  assert.equal(result.contextRequest.authorContextHash, session.authorContextHash);
  assert.deepEqual(result.contextRequest.sourceRefs, question.inputRefs);
  assert.equal(typeof result.contextRequest.createdAt, 'string');
  assert.ok(!Number.isNaN(Date.parse(result.contextRequest.createdAt)));
  assert.equal(result.deliberationState.contextRequests.length, 1);
  assert.equal(result.deliberationState.contextRequests[0].id, result.contextRequest.id);
});

// --- Attempt binding / input shape -------------------------------------------

check('an unknown, blank, whitespace-only, null, or missing attemptId is rejected', () => {
  const { session, state } = buildAddContextAttemptFixture();
  for (const attemptId of ['not-a-real-attempt', '', '   ', null, undefined]) {
    assert.throws(
      () => createContextRequest(session, state, { attemptId, category: 'constraints', question: 'x?', inferenceReason: 'x' }),
      /must be a non-empty string|is not a currently recorded RouteAttempt/,
      `expected attemptId ${JSON.stringify(attemptId)} to be rejected`
    );
  }
});

check('a RouteDecision.id is not accepted in place of a RouteAttempt.attemptId', () => {
  const { session, state, decision } = buildAddContextAttemptFixture();
  assert.throws(
    () => createContextRequest(session, state, { attemptId: decision.id, category: 'constraints', question: 'x?', inferenceReason: 'x' }),
    /is not a currently recorded RouteAttempt/
  );
});

check('an attempt whose route is not ADD_CONTEXT is rejected', () => {
  for (const rootCause of ['COVERAGE_GAP', 'STABILITY_QUESTION', 'EVIDENCE_GAP', 'DECISION_SENSITIVE_CONFLICT']) {
    const { session, state, decision } = buildStartedAttemptFixture(rootCause);
    const attempt = state.attempts.find((a) => a.decisionId === decision.id);
    assert.throws(
      () => createContextRequest(session, state, { attemptId: attempt.attemptId, category: 'constraints', question: 'x?', inferenceReason: 'x' }),
      /not ADD_CONTEXT/,
      `expected rootCause ${rootCause} to be rejected`
    );
  }
});

check('the old questionId input and every derived/forbidden field are rejected as unexpected keys, never silently ignored', () => {
  const { session, state, attempt } = buildAddContextAttemptFixture();
  const forbiddenExtras = [
    { questionId: 'x' },
    { originatingAttemptId: 'x' },
    { originatingQuestionId: 'x' },
    { sourceRefs: [{ kind: 'FINDING', id: 'attacker-supplied' }] },
    { sessionId: 'x' },
    { artifactHash: 'x' },
    { authorContextHash: 'x' },
    { requestId: 'x' },
    { id: 'x' },
    { createdAt: new Date().toISOString() },
    { arbitraryField: 1 },
  ];
  for (const extra of forbiddenExtras) {
    assert.throws(
      () =>
        createContextRequest(session, state, {
          attemptId: attempt.attemptId,
          category: 'constraints',
          question: 'x?',
          inferenceReason: 'x',
          ...extra,
        }),
      /unexpected field/,
      `expected extra field ${JSON.stringify(Object.keys(extra))} to be rejected`
    );
  }
});

check('a CONTEXT_GAP question can never be registered with empty refs, so a ContextRequest can never lack provenance', () => {
  const session = buildReviewedFixtureSession();
  const state = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const emptyRefQuestion = {
    id: 'q-context-empty-refs',
    rootCause: 'CONTEXT_GAP',
    materialityReason: 'x',
    inputRefs: [],
    createdAt: new Date().toISOString(),
  };
  assert.throws(() => registerUnresolvedQuestion(session, state, emptyRefQuestion), /at least one inputRef is required/);
});

check('requires a non-empty question and inferenceReason', () => {
  const { session, state, attempt } = buildAddContextAttemptFixture();
  assert.throws(
    () => createContextRequest(session, state, { attemptId: attempt.attemptId, category: 'constraints', question: '   ', inferenceReason: 'x' }),
    /question must be a non-empty string/
  );
  assert.throws(
    () => createContextRequest(session, state, { attemptId: attempt.attemptId, category: 'constraints', question: 'x?', inferenceReason: '' }),
    /inferenceReason must be a non-empty string/
  );
});

check('is rejected once the deliberation has stopped; existing contextRequests remain unchanged', () => {
  const { session, state, attempt } = buildAddContextAttemptFixture();
  const stopQuestion = createUnresolvedQuestion(session, { rootCause: 'NONE', materialityReason: 'x', inputRefs: [] });
  const stopDecision = planRouteForQuestion(session, state, stopQuestion);
  const stopped = recordRouteDecision(session, state, stopDecision, { stopReason: 'successful' });
  assert.throws(
    () => createContextRequest(session, stopped, { attemptId: attempt.attemptId, category: 'constraints', question: 'x?', inferenceReason: 'x' }),
    /already stopped/
  );
  assert.deepEqual(stopped.contextRequests, []);
});

check('does not change AuthorContext, session hashes, or create a new session', () => {
  const { session, state, attempt } = buildAddContextAttemptFixture();
  const before = JSON.parse(JSON.stringify(session));
  createContextRequest(session, state, { attemptId: attempt.attemptId, category: 'constraints', question: 'x?', inferenceReason: 'x' });
  assert.deepEqual(session, before, 'session must be byte-for-byte unchanged');
  assert.equal(session.authorContext.constraints.length, before.authorContext.constraints.length);
});

// --- ONE attempt <= ONE request; ledger read integrity -----------------------

check('ONE attempt -> AT MOST ONE ContextRequest: a second request for the same attemptId is rejected, even with different category/question/inferenceReason', () => {
  const { session, state, attempt } = buildAddContextAttemptFixture();
  const first = createContextRequest(session, state, { attemptId: attempt.attemptId, category: 'constraints', question: 'first?', inferenceReason: 'x' });
  assert.throws(
    () =>
      createContextRequest(session, first.deliberationState, {
        attemptId: attempt.attemptId,
        category: 'knownRisks',
        question: 'second, different question?',
        inferenceReason: 'a different reason entirely',
      }),
    /already has a recorded ContextRequest/
  );
});

check('a tampered ledger with two ContextRequests sharing one id (for different attempts) fails closed at the next read/create boundary', () => {
  const { session, state, attempt } = buildAddContextAttemptFixture();
  const first = createContextRequest(session, state, { attemptId: attempt.attemptId, category: 'constraints', question: 'x?', inferenceReason: 'x' });
  const duplicateIdEntry = { ...first.contextRequest, originatingAttemptId: 'a-different-attempt-id-entirely' };
  const tampered = { ...first.deliberationState, contextRequests: [first.contextRequest, duplicateIdEntry] };
  assert.throws(
    () =>
      createContextRequest(session, tampered, {
        attemptId: attempt.attemptId,
        category: 'constraints',
        question: 'irrelevant, should reject before reaching this',
        inferenceReason: 'x',
      }),
    /duplicate ContextRequest\.id/
  );
});

check('a tampered ledger with two different ContextRequests for the SAME attemptId fails closed', () => {
  const { session, state, attempt } = buildAddContextAttemptFixture();
  const first = createContextRequest(session, state, { attemptId: attempt.attemptId, category: 'constraints', question: 'x?', inferenceReason: 'x' });
  const secondForSameAttempt = { ...first.contextRequest, id: 'second-request-id-for-same-attempt' };
  const tampered = { ...first.deliberationState, contextRequests: [first.contextRequest, secondForSameAttempt] };
  assert.throws(
    () =>
      createContextRequest(session, tampered, {
        attemptId: attempt.attemptId,
        category: 'constraints',
        question: 'irrelevant',
        inferenceReason: 'x',
      }),
    /more than one ContextRequest for attemptId/
  );
});

check('individually tampered originatingAttemptId/originatingQuestionId/originatingSessionId/artifactHash/authorContextHash/sourceRefs each fail closed on ledger validation', () => {
  const { session, state, attempt } = buildAddContextAttemptFixture();
  const first = createContextRequest(session, state, { attemptId: attempt.attemptId, category: 'constraints', question: 'x?', inferenceReason: 'x' });
  const base = first.deliberationState;

  const tamperCases = [
    ['originatingAttemptId', 'nonexistent-attempt', /does not resolve to exactly one RouteAttempt/],
    ['originatingQuestionId', 'nonexistent-question', /originatingQuestionId does not match/],
    ['originatingSessionId', 'wrong-session', /originatingSessionId does not match/],
    ['artifactHash', 'wrong-hash', /artifactHash does not match/],
    ['authorContextHash', 'wrong-hash', /authorContextHash does not match/],
    ['sourceRefs', [{ kind: 'FINDING', id: 'wrong-ref' }], /sourceRefs do not exactly match/],
  ];
  for (const [field, badValue, expected] of tamperCases) {
    const tamperedRequest = { ...first.contextRequest, [field]: badValue };
    const tamperedState = { ...base, contextRequests: [tamperedRequest] };
    assert.throws(
      () =>
        createContextRequest(session, tamperedState, {
          attemptId: attempt.attemptId,
          category: 'constraints',
          question: 'irrelevant',
          inferenceReason: 'x',
        }),
      expected,
      `expected field ${field} to be rejected`
    );
  }
});

// --- Attempt <-> DeliberationState binding (Slice 2D-C1 amendment) ---------

check('a self-consistent but state-inconsistent attempt/request pair (tampered sessionId, artifactHash, or authorContextHash) fails closed even though request and attempt mutually agree', () => {
  const tamperCases = [
    ['sessionId', 'originatingSessionId', 'BAD-SESSION', /attempt .* sessionId does not match the current DeliberationState binding/],
    ['artifactHash', 'artifactHash', 'BAD-ARTIFACT-HASH', /attempt .* artifactHash does not match the current DeliberationState binding/],
    ['authorContextHash', 'authorContextHash', 'BAD-AUTHOR-CONTEXT-HASH', /attempt .* authorContextHash does not match the current DeliberationState binding/],
  ];

  for (const [attemptField, requestField, badValue, expected] of tamperCases) {
    const cycle1 = buildAddContextAttemptFixture();
    const first = createContextRequest(cycle1.session, cycle1.state, {
      attemptId: cycle1.attempt.attemptId,
      category: 'constraints',
      question: 'x?',
      inferenceReason: 'x',
    });

    // A second, independent, otherwise-valid ADD_CONTEXT attempt in the same
    // state -- the boundary that invokes assertContextRequestLedgerIntegrity
    // for the whole ledger, including the tampered first entry below.
    const { state: state2, question: question2 } = buildRegisteredQuestion(cycle1.session, first.deliberationState, {
      rootCause: 'CONTEXT_GAP',
      materialityReason: 'a second, independent CONTEXT_GAP question',
      inputRefs: cycle1.question.inputRefs.map((ref) => ({ ...ref })),
    });
    const decision2 = planRouteForQuestion(cycle1.session, state2, question2);
    const state3 = recordRouteDecision(cycle1.session, state2, decision2);
    const state4 = recordRouteAttemptStart(cycle1.session, state3, decision2.id);
    const attempt2 = state4.attempts.find((a) => a.decisionId === decision2.id);

    // Tamper BOTH the attempt and the request so they still mutually agree,
    // while the DeliberationState itself remains canonical.
    const tamperedAttempts = state4.attempts.map((a) =>
      a.attemptId === cycle1.attempt.attemptId ? { ...a, [attemptField]: badValue } : a
    );
    const tamperedRequests = state4.contextRequests.map((r) =>
      r.originatingAttemptId === cycle1.attempt.attemptId ? { ...r, [requestField]: badValue } : r
    );
    const tampered = { ...state4, attempts: tamperedAttempts, contextRequests: tamperedRequests };

    assert.throws(
      () =>
        createContextRequest(cycle1.session, tampered, {
          attemptId: attempt2.attemptId,
          category: 'constraints',
          question: 'irrelevant, the ledger check must reject before this attempt is even considered',
          inferenceReason: 'x',
        }),
      expected,
      `expected tampered ${attemptField} to be rejected`
    );
  }
});

check('a valid historical ContextRequest does not block a fresh, independent ADD_CONTEXT attempt in the same DeliberationState from creating its own request', () => {
  const cycle1 = buildAddContextAttemptFixture();
  const first = createContextRequest(cycle1.session, cycle1.state, {
    attemptId: cycle1.attempt.attemptId,
    category: 'constraints',
    question: 'first question?',
    inferenceReason: 'x',
  });

  const { state: state2, question: question2 } = buildRegisteredQuestion(cycle1.session, first.deliberationState, {
    rootCause: 'CONTEXT_GAP',
    materialityReason: 'a second, independent CONTEXT_GAP question',
    inputRefs: cycle1.question.inputRefs.map((ref) => ({ ...ref })),
  });
  const decision2 = planRouteForQuestion(cycle1.session, state2, question2);
  const state3 = recordRouteDecision(cycle1.session, state2, decision2);
  const state4 = recordRouteAttemptStart(cycle1.session, state3, decision2.id);
  const attempt2 = state4.attempts.find((a) => a.decisionId === decision2.id);

  const second = createContextRequest(cycle1.session, state4, {
    attemptId: attempt2.attemptId,
    category: 'constraints',
    question: 'second, independent question?',
    inferenceReason: 'x',
  });

  assert.equal(second.deliberationState.contextRequests.length, 2);
  assert.notEqual(second.contextRequest.id, first.contextRequest.id);
});

// --- Active-cycle / currentness -----------------------------------------------

check('active-cycle binding: exactly one active cycle for the exact decision is required; 0, >1, or a different decision are all rejected', () => {
  // 0 active for A1: A1's own cycle is closed (STILL_OPEN disposed), and no fresh D2 exists yet.
  {
    const { session, state, attempt } = buildAddContextAttemptFixture();
    const outcome = recordRouteOutcome(session, state, {
      attemptId: attempt.attemptId,
      status: 'FAILED',
      latencyConsumed: 1,
      failure: VALID_FAILURE_FOR_DISPOSITION,
    });
    const afterStillOpen = recordQuestionDisposition(session, outcome, { attemptId: attempt.attemptId, disposition: 'STILL_OPEN', reason: 'x' });
    assert.throws(
      () => createContextRequest(session, afterStillOpen, { attemptId: attempt.attemptId, category: 'constraints', question: 'x?', inferenceReason: 'x' }),
      /has no active deliberation cycle/
    );
  }
  // >1 active for the question (legacy corruption): a second, unattempted decision injected directly into history.
  {
    const { session, state, question, attempt } = buildAddContextAttemptFixture();
    const d2 = planRouteForQuestionSafely(session, state, question);
    const corrupted = { ...state, history: [...state.history, d2] };
    assert.throws(
      () => createContextRequest(session, corrupted, { attemptId: attempt.attemptId, category: 'constraints', question: 'x?', inferenceReason: 'x' }),
      /more than one active deliberation cycle/
    );
  }
  // One active cycle exists, but it belongs to a fresh D2, not the decision attempt A1 belongs to.
  {
    const { session, state, question, attempt: attempt1 } = buildAddContextAttemptFixture();
    const outcome1 = recordRouteOutcome(session, state, {
      attemptId: attempt1.attemptId,
      status: 'FAILED',
      latencyConsumed: 1,
      failure: VALID_FAILURE_FOR_DISPOSITION,
    });
    const afterStillOpen = recordQuestionDisposition(session, outcome1, { attemptId: attempt1.attemptId, disposition: 'STILL_OPEN', reason: 'x' });
    const decision2 = planRouteForQuestion(session, afterStillOpen, question);
    const state2 = recordRouteDecision(session, afterStillOpen, decision2);
    assert.throws(
      () => createContextRequest(session, state2, { attemptId: attempt1.attemptId, category: 'constraints', question: 'x?', inferenceReason: 'x' }),
      /different RouteDecision than the one attempt/
    );
  }
});

check('a historical ADD_CONTEXT attempt belonging to a now-terminal question is rejected', () => {
  const { session, state, attempt } = buildAddContextAttemptFixture();
  const outcome = recordRouteOutcome(session, state, {
    attemptId: attempt.attemptId,
    status: 'FAILED',
    latencyConsumed: 1,
    failure: VALID_FAILURE_FOR_DISPOSITION,
  });
  const resolved = recordQuestionDisposition(session, outcome, { attemptId: attempt.attemptId, disposition: 'RESOLVED', reason: 'x' });
  assert.throws(
    () => createContextRequest(session, resolved, { attemptId: attempt.attemptId, category: 'constraints', question: 'x?', inferenceReason: 'x' }),
    /is not current/
  );
});

check('createContextRequest rejects a CONTEXT_GAP question with more than one active legacy cycle (regression)', () => {
  const { session, state, question, attempt } = buildAddContextAttemptFixture();
  const d2 = planRouteForQuestionSafely(session, state, question);
  const corrupted = { ...state, history: [...state.history, d2] };
  assert.throws(
    () => createContextRequest(session, corrupted, { attemptId: attempt.attemptId, category: 'constraints', question: 'x?', inferenceReason: 'x' }),
    /more than one active deliberation cycle/
  );
});

// --- Snapshot semantics; FAILED compatibility; success still blocked --------

check('the returned contextRequest is independently snapshotted from the stored ledger entry and from the caller input', () => {
  const { session, state, attempt, question } = buildAddContextAttemptFixture();
  const callerInput = { attemptId: attempt.attemptId, category: 'constraints', question: 'original text', inferenceReason: 'x' };
  const result = createContextRequest(session, state, callerInput);

  callerInput.question = 'mutated after the call, on the caller-owned input object';
  result.contextRequest.question = 'mutated on the returned object';
  result.contextRequest.sourceRefs[0].id = 'mutated-ref-id';
  result.contextRequest.sourceRefs[0].kind = 'FINDING';

  const stored = result.deliberationState.contextRequests[0];
  assert.equal(stored.question, 'original text');
  assert.deepEqual(stored.sourceRefs, question.inputRefs);
  assert.deepEqual(state.unresolvedQuestions[0].inputRefs[0], question.inputRefs[0]);
});

check('generic FAILED remains legal for ADD_CONTEXT both with zero and with one recorded ContextRequest', () => {
  {
    const { session, state, attempt } = buildAddContextAttemptFixture();
    const outcome = recordRouteOutcome(session, state, {
      attemptId: attempt.attemptId,
      status: 'FAILED',
      latencyConsumed: 1,
      failure: VALID_FAILURE_FOR_DISPOSITION,
    });
    assert.equal(outcome.outcomes.length, 1);
    assert.equal(outcome.contextRequests.length, 0);
  }
  {
    const { session, state, attempt } = buildAddContextAttemptFixture();
    const result = createContextRequest(session, state, { attemptId: attempt.attemptId, category: 'constraints', question: 'x?', inferenceReason: 'x' });
    const outcome = recordRouteOutcome(session, result.deliberationState, {
      attemptId: attempt.attemptId,
      status: 'FAILED',
      latencyConsumed: 1,
      failure: VALID_FAILURE_FOR_DISPOSITION,
    });
    assert.equal(outcome.outcomes.length, 1);
    assert.equal(outcome.contextRequests.length, 1);
  }
});

// ==================================================================
// M. Human authority invariant
// ==================================================================
console.log('\nHuman authority invariant');

await checkAsync('the deliberation module exposes no function that creates or mutates HumanAdjudication or RevisionAction', async () => {
  const deliberationModule = await import('./dist/stress-test/deliberation.js');
  const forbiddenNames = ['adjudicate', 'planRevisionAction', 'implementRevisionAction', 'rejectRevisionAction'];
  for (const name of forbiddenNames) {
    assert.equal(name in deliberationModule, false, `deliberation.js must not export ${name}`);
  }
});

check('recordRouteDecision and createContextRequest never touch session.adjudications or session.revisionActions', () => {
  const { session, issueId } = buildFixtureWithIssue();
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const { state, question } = buildRegisteredQuestion(session, state0, {
    rootCause: 'COVERAGE_GAP',
    materialityReason: 'x',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  const decision = planRouteForQuestion(session, state, question);
  recordRouteDecision(session, state, decision);

  const itemId = session.authorContext.constraints[0].id;
  const { state: stateWithContext, question: contextQuestion } = buildRegisteredQuestion(session, state, {
    rootCause: 'CONTEXT_GAP',
    materialityReason: 'x',
    inputRefs: [{ kind: 'AUTHOR_CONTEXT_ITEM', id: itemId }],
  });
  const contextDecision = planRouteForQuestion(session, stateWithContext, contextQuestion);
  const stateWithContextDecision = recordRouteDecision(session, stateWithContext, contextDecision);
  const stateWithContextAttempt = recordRouteAttemptStart(session, stateWithContextDecision, contextDecision.id);
  const contextAttempt = stateWithContextAttempt.attempts.find((a) => a.decisionId === contextDecision.id);
  createContextRequest(session, stateWithContextAttempt, {
    attemptId: contextAttempt.attemptId,
    category: 'constraints',
    question: 'x?',
    inferenceReason: 'x',
  });
  assert.deepEqual(session.adjudications, {});
  assert.deepEqual(session.revisionActions, {});
});

// ==================================================================
// N. Provenance & StopReason runtime hardening (regression, Slice 2A amendment)
// ==================================================================
console.log('\nProvenance & StopReason runtime hardening (regression)');

check('recordRouteDecision rejects a manually constructed ADD_REVIEWER + COVERAGE_GAP with inputRefs=[]', () => {
  const { session } = buildFixtureWithIssue();
  const state = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const sessionBefore = JSON.parse(JSON.stringify(session));
  const manual = {
    id: 'manual-add-reviewer',
    route: 'ADD_REVIEWER',
    reason: { rootCause: 'COVERAGE_GAP', materialityReason: 'material coverage gap' },
    inputRefs: [],
    questionId: 'irrelevant-fails-before-questionId-check',
    createdAt: new Date().toISOString(),
  };
  assert.throws(() => recordRouteDecision(session, state, manual), /at least one inputRef is required/);
  assert.deepEqual(session, sessionBefore, 'session must be unchanged after a rejected recordRouteDecision');
  assert.deepEqual(session.adjudications, {});
  assert.deepEqual(session.revisionActions, {});
});

check('recordRouteDecision rejects a manually constructed SEEK_EVIDENCE + EVIDENCE_GAP with inputRefs=[]', () => {
  const { session } = buildFixtureWithIssue();
  const state = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const manual = {
    id: 'manual-seek-evidence',
    route: 'SEEK_EVIDENCE',
    reason: { rootCause: 'EVIDENCE_GAP', materialityReason: 'an unverified external claim' },
    inputRefs: [],
    questionId: 'irrelevant-fails-before-questionId-check',
    createdAt: new Date().toISOString(),
  };
  assert.throws(() => recordRouteDecision(session, state, manual), /at least one inputRef is required/);
});

check('recordRouteDecision accepts STOP + NONE + inputRefs=[] + questionId=null with a valid StopReason', () => {
  const session = buildReviewedFixtureSession();
  const state = createDeliberationState(session, { costCeiling: 1, latencyCeiling: 1 });
  const manual = {
    id: 'manual-stop',
    route: 'STOP',
    reason: { rootCause: 'NONE', materialityReason: 'nothing material remains' },
    inputRefs: [],
    questionId: null,
    createdAt: new Date().toISOString(),
  };
  const next = recordRouteDecision(session, state, manual, { stopReason: 'successful' });
  assert.equal(next.stopReason, 'successful');
});

check('recordRouteDecision accepts a non-NONE decision with a valid provenance ref and a matching registered questionId', () => {
  const { session, issueId } = buildFixtureWithIssue();
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const { state, question } = buildRegisteredQuestion(session, state0, {
    rootCause: 'COVERAGE_GAP',
    materialityReason: 'material coverage gap',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  const manual = {
    id: 'manual-valid',
    route: 'ADD_REVIEWER',
    reason: { rootCause: 'COVERAGE_GAP', materialityReason: 'material coverage gap' },
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
    questionId: question.id,
    createdAt: new Date().toISOString(),
  };
  const next = recordRouteDecision(session, state, manual);
  assert.equal(next.history.length, 1);
  assert.equal(next.stopReason, null);
});

check('all six valid StopReason values succeed', () => {
  const validStopReasons = [
    'successful',
    'budget',
    'latency',
    'no_eligible_route',
    'unresolved_but_human_decidable',
    'failure_fallback',
  ];
  for (const stopReason of validStopReasons) {
    const session = buildReviewedFixtureSession();
    const state = createDeliberationState(session, { costCeiling: 1, latencyCeiling: 1 });
    const manual = {
      id: `manual-stop-${stopReason}`,
      route: 'STOP',
      reason: { rootCause: 'NONE', materialityReason: 'nothing material remains' },
      inputRefs: [],
      questionId: null,
      createdAt: new Date().toISOString(),
    };
    const next = recordRouteDecision(session, state, manual, { stopReason });
    assert.equal(next.stopReason, stopReason);
  }
});

check('invalid runtime StopReason values are rejected (reaching the allowlist check itself, not an earlier one)', () => {
  const invalidValues = ['UNKNOWN', '', 'Success', null];
  for (const stopReason of invalidValues) {
    const session = buildReviewedFixtureSession();
    const state = createDeliberationState(session, { costCeiling: 1, latencyCeiling: 1 });
    const manual = {
      id: 'manual-stop-invalid',
      route: 'STOP',
      reason: { rootCause: 'NONE', materialityReason: 'nothing material remains' },
      inputRefs: [],
      questionId: null,
      createdAt: new Date().toISOString(),
    };
    assert.throws(
      () => recordRouteDecision(session, state, manual, { stopReason }),
      /requires an explicit stopReason|invalid stopReason/,
      `expected stopReason ${JSON.stringify(stopReason)} to be rejected`
    );
  }
});

check('a stopReason is still rejected for a non-STOP route (reaching that check, not an earlier one)', () => {
  const { session, issueId } = buildFixtureWithIssue();
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const { state, question } = buildRegisteredQuestion(session, state0, {
    rootCause: 'COVERAGE_GAP',
    materialityReason: 'x',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  const manual = {
    id: 'manual-non-stop',
    route: 'ADD_REVIEWER',
    reason: { rootCause: 'COVERAGE_GAP', materialityReason: 'x' },
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
    questionId: question.id,
    createdAt: new Date().toISOString(),
  };
  assert.throws(
    () => recordRouteDecision(session, state, manual, { stopReason: 'successful' }),
    /only be supplied when route is STOP/
  );
});

check('session and DeliberationState remain immutable across the rejected regression cases above', () => {
  const { session, issueId } = buildFixtureWithIssue();
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const { state, question } = buildRegisteredQuestion(session, state0, {
    rootCause: 'CONTEXT_GAP',
    materialityReason: 'x',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  const sessionBefore = JSON.parse(JSON.stringify(session));
  const stateBefore = JSON.parse(JSON.stringify(state));

  try {
    recordRouteDecision(session, state, {
      id: 'x1',
      route: 'ADD_REVIEWER',
      reason: { rootCause: 'COVERAGE_GAP', materialityReason: 'x' },
      inputRefs: [],
      questionId: 'irrelevant',
      createdAt: new Date().toISOString(),
    });
  } catch {
    // expected
  }
  try {
    recordRouteDecision(
      session,
      state,
      {
        id: 'x2',
        route: 'STOP',
        reason: { rootCause: 'NONE', materialityReason: 'x' },
        inputRefs: [],
        questionId: null,
        createdAt: new Date().toISOString(),
      },
      { stopReason: 'UNKNOWN' }
    );
  } catch {
    // expected
  }
  try {
    createContextRequest(session, state, {
      attemptId: 'never-recorded',
      category: 'constraints',
      question: 'x?',
      inferenceReason: 'x',
    });
  } catch {
    // expected
  }

  assert.deepEqual(session, sessionBefore, 'session must be unchanged');
  assert.deepEqual(state, stateBefore, 'deliberationState must be unchanged');
  assert.deepEqual(session.adjudications, {});
  assert.deepEqual(session.revisionActions, {});
  assert.equal(issueId, session.semanticIssues[issueId].id, 'sanity check: the issue itself is untouched');
  assert.equal(question.rootCause, 'CONTEXT_GAP', 'sanity check: the registered question fixture itself is untouched');
});

// ==================================================================
// O. Alias-isolation hardening (regression, Slice 2B amendment)
// ==================================================================
console.log('\nAlias-isolation hardening (Slice 2B amendment)');

check('mutating the original question after registration does not alter the registered snapshot (rootCause/materialityReason)', () => {
  const { session, issueId } = buildFixtureWithIssue();
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const original = createUnresolvedQuestion(session, {
    rootCause: 'COVERAGE_GAP',
    materialityReason: 'original reason',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  const state = registerUnresolvedQuestion(session, state0, original);

  original.rootCause = 'EVIDENCE_GAP';
  original.materialityReason = 'mutated after registration';

  assert.equal(state.unresolvedQuestions[0].rootCause, 'COVERAGE_GAP');
  assert.equal(state.unresolvedQuestions[0].materialityReason, 'original reason');
});

check('mutating the original question.inputRefs array after registration does not alter the registered snapshot', () => {
  const { session, issueId } = buildFixtureWithIssue();
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const original = createUnresolvedQuestion(session, {
    rootCause: 'COVERAGE_GAP',
    materialityReason: 'x',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  const state = registerUnresolvedQuestion(session, state0, original);

  original.inputRefs.push({ kind: 'FINDING', id: 'not-real' });
  original.inputRefs[0] = { kind: 'FINDING', id: 'replaced' };

  assert.equal(state.unresolvedQuestions[0].inputRefs.length, 1);
  assert.deepEqual(state.unresolvedQuestions[0].inputRefs[0], { kind: 'SEMANTIC_ISSUE', id: issueId });
});

check('mutating the original question.inputRefs[0] fields after registration does not alter the registered snapshot', () => {
  const { session, issueId } = buildFixtureWithIssue();
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const original = createUnresolvedQuestion(session, {
    rootCause: 'COVERAGE_GAP',
    materialityReason: 'x',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  const state = registerUnresolvedQuestion(session, state0, original);

  original.inputRefs[0].id = 'mutated-id';
  original.inputRefs[0].kind = 'FINDING';

  assert.deepEqual(state.unresolvedQuestions[0].inputRefs[0], { kind: 'SEMANTIC_ISSUE', id: issueId });
});

check('mutating a planned decision does not alter the registered question it was planned from', () => {
  const { session, issueId } = buildFixtureWithIssue();
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const { state, question } = buildRegisteredQuestion(session, state0, {
    rootCause: 'COVERAGE_GAP',
    materialityReason: 'x',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  const decision = planRouteForQuestion(session, state, question);

  decision.reason.materialityReason = 'mutated after planning';
  decision.inputRefs[0].id = 'mutated-id';
  decision.inputRefs[0].kind = 'FINDING';

  assert.equal(state.unresolvedQuestions[0].materialityReason, 'x');
  assert.deepEqual(state.unresolvedQuestions[0].inputRefs[0], { kind: 'SEMANTIC_ISSUE', id: issueId });
});

check('mutating the original question after planning does not alter the returned decision', () => {
  const { session, issueId } = buildFixtureWithIssue();
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const { state, question } = buildRegisteredQuestion(session, state0, {
    rootCause: 'COVERAGE_GAP',
    materialityReason: 'x',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  const decision = planRouteForQuestion(session, state, question);

  question.materialityReason = 'mutated after planning';
  question.inputRefs[0].id = 'mutated-id';

  assert.equal(decision.reason.materialityReason, 'x');
  assert.deepEqual(decision.inputRefs[0], { kind: 'SEMANTIC_ISSUE', id: issueId });
});

check('mutating a recorded non-STOP decision does not alter DeliberationState history', () => {
  const { session, issueId } = buildFixtureWithIssue();
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const { state, question } = buildRegisteredQuestion(session, state0, {
    rootCause: 'COVERAGE_GAP',
    materialityReason: 'x',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  const decision = planRouteForQuestion(session, state, question);
  const next = recordRouteDecision(session, state, decision);

  decision.route = 'SEEK_EVIDENCE';
  decision.questionId = 'mutated';
  decision.reason.rootCause = 'EVIDENCE_GAP';
  decision.reason.materialityReason = 'mutated';
  decision.inputRefs.push({ kind: 'FINDING', id: 'not-real' });
  decision.inputRefs[0].id = 'mutated-id';

  const recorded = next.history[0];
  assert.equal(recorded.route, 'ADD_REVIEWER');
  assert.equal(recorded.questionId, question.id);
  assert.equal(recorded.reason.rootCause, 'COVERAGE_GAP');
  assert.equal(recorded.reason.materialityReason, 'x');
  assert.equal(recorded.inputRefs.length, 1);
  assert.deepEqual(recorded.inputRefs[0], { kind: 'SEMANTIC_ISSUE', id: issueId });
});

check('mutating a recorded STOP decision does not alter DeliberationState history', () => {
  const session = buildReviewedFixtureSession();
  const state = createDeliberationState(session, { costCeiling: 1, latencyCeiling: 1 });
  const stopDecision = {
    id: 'manual-stop-alias',
    route: 'STOP',
    reason: { rootCause: 'NONE', materialityReason: 'nothing material remains' },
    inputRefs: [],
    questionId: null,
    createdAt: new Date().toISOString(),
  };
  const next = recordRouteDecision(session, state, stopDecision, { stopReason: 'successful' });

  stopDecision.reason.materialityReason = 'mutated';
  stopDecision.questionId = 'mutated';

  assert.equal(next.history[0].reason.materialityReason, 'nothing material remains');
  assert.equal(next.history[0].questionId, null);
  assert.equal(next.stopReason, 'successful');
});

check('mutating a returned ContextRequest.sourceRefs does not alter the registered question', () => {
  const { session, state, question, attempt } = buildAddContextAttemptFixture();
  const result = createContextRequest(session, state, {
    attemptId: attempt.attemptId,
    category: 'constraints',
    question: 'What is the actual notice period?',
    inferenceReason: 'x',
  });

  result.contextRequest.sourceRefs[0].id = 'mutated-id';
  result.contextRequest.sourceRefs[0].kind = 'FINDING';

  assert.deepEqual(state.unresolvedQuestions[0].inputRefs[0], question.inputRefs[0]);
});

check('createUnresolvedQuestion rejects an invalid rootCause at construction time (plain-JS runtime guard)', () => {
  const { session } = buildFixtureWithIssue();
  assert.throws(
    () =>
      createUnresolvedQuestion(session, {
        rootCause: 'NOT_A_ROOT_CAUSE',
        materialityReason: 'x',
        inputRefs: [],
      }),
    /invalid rootCause/
  );
});

check('planRouteForQuestion rejects an empty/blank/null/missing question.id on a non-NONE route', () => {
  const { session, issueId } = buildFixtureWithIssue();
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const { state } = buildRegisteredQuestion(session, state0, {
    rootCause: 'COVERAGE_GAP',
    materialityReason: 'x',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  const base = {
    rootCause: 'COVERAGE_GAP',
    materialityReason: 'x',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
    createdAt: new Date().toISOString(),
  };
  for (const id of ['', '   ', null, undefined]) {
    assert.throws(
      () => planRouteForQuestion(session, state, { id, ...base }),
      /question\.id must be a non-empty string/,
      `expected id ${JSON.stringify(id)} to be rejected`
    );
  }
});

check('planRouteForQuestion rejects an empty/blank/null/missing question.id on the NONE/STOP path too', () => {
  const session = buildReviewedFixtureSession();
  const state = createDeliberationState(session, { costCeiling: 1, latencyCeiling: 1 });
  const base = {
    rootCause: 'NONE',
    materialityReason: 'nothing material remains',
    inputRefs: [],
    createdAt: new Date().toISOString(),
  };
  for (const id of ['', '   ', null, undefined]) {
    assert.throws(
      () => planRouteForQuestion(session, state, { id, ...base }),
      /question\.id must be a non-empty string/,
      `expected id ${JSON.stringify(id)} to be rejected on the NONE/STOP path`
    );
  }
});

// ==================================================================
// P. Route attempt start ledger (Slice 2D-A)
// ==================================================================
console.log('\nRoute attempt start ledger (Slice 2D-A)');

check('createDeliberationState initializes attempts=[]; existing fields unchanged', () => {
  const session = buildReviewedFixtureSession();
  const state = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  assert.deepEqual(state.attempts, []);
  assert.deepEqual(state.history, []);
  assert.deepEqual(state.unresolvedQuestions, []);
  assert.equal(state.stopReason, null);
  assert.equal(state.costBudget.spent, 0);
  assert.equal(state.latencyBudget.spent, 0);
});

for (const { rootCause, route } of NON_STOP_ROUTE_FIXTURES) {
  check(`a recorded ${route} RouteDecision starts exactly one RouteAttempt with correct fields`, () => {
    const { session, state, decision } = buildStartedAttemptFixture(rootCause);
    assert.equal(state.attempts.length, 1);
    const attempt = state.attempts[0];
    assert.equal(attempt.decisionId, decision.id);
    assert.equal(attempt.questionId, decision.questionId);
    assert.equal(attempt.route, route);
    assert.equal(attempt.sessionId, session.id);
    assert.equal(attempt.artifactHash, session.artifactHash);
    assert.equal(attempt.authorContextHash, session.authorContextHash);
    assert.equal(typeof attempt.attemptId, 'string');
    assert.ok(attempt.attemptId.length > 0);
    assert.equal(typeof attempt.startedAt, 'string');
    assert.ok(attempt.startedAt.length > 0);
    assert.equal('status' in attempt, false, 'RouteAttempt must not carry a status field');
    assert.equal('completedAt' in attempt, false, 'RouteAttempt must not carry a completedAt field');
    assert.equal('latency' in attempt, false, 'RouteAttempt must not carry a latency field');
    assert.equal('outcome' in attempt, false, 'RouteAttempt must not carry an outcome field');
  });
}

check('ADD_CONTEXT attempt has logicalCost=0 and does not increment costBudget.spent', () => {
  const { state } = buildStartedAttemptFixture('CONTEXT_GAP', 5);
  assert.equal(state.attempts[0].logicalCost, 0);
  assert.equal(state.costBudget.spent, 0);
});

for (const { rootCause, route } of NON_STOP_ROUTE_FIXTURES.filter((r) => r.route !== 'ADD_CONTEXT')) {
  check(`${route} attempt has logicalCost=1 and increments costBudget.spent by exactly 1`, () => {
    const { state } = buildStartedAttemptFixture(rootCause, 5);
    assert.equal(state.attempts[0].logicalCost, 1);
    assert.equal(state.costBudget.spent, 1);
  });
}

for (const { rootCause, route } of NON_STOP_ROUTE_FIXTURES.filter((r) => r.route !== 'ADD_CONTEXT')) {
  check(`${route} attempt is rejected when costCeiling=0, with no attempt or cost recorded`, () => {
    const { session, state, decision } = buildRecordedDecisionFixture(rootCause, 0);
    const before = JSON.parse(JSON.stringify(state));
    assert.throws(() => recordRouteAttemptStart(session, state, decision.id), /exceed the cost ceiling/);
    assert.deepEqual(state, before, 'original state unchanged after a rejected attempt start');
  });
}

check('ADD_CONTEXT attempt still succeeds when costCeiling=0 because its logical cost is 0', () => {
  const { state } = buildStartedAttemptFixture('CONTEXT_GAP', 0);
  assert.equal(state.attempts.length, 1);
  assert.equal(state.costBudget.spent, 0);
});

check('starting a second RouteAttempt for the same RouteDecision is rejected; the first attempt is unchanged', () => {
  const { session, state, decision } = buildStartedAttemptFixture('COVERAGE_GAP', 5);
  const before = JSON.parse(JSON.stringify(state));
  assert.throws(() => recordRouteAttemptStart(session, state, decision.id), /already has a RouteAttempt/);
  assert.deepEqual(state, before, 'no extra cost or attempt from the rejected duplicate');
});

check('a recorded STOP RouteDecision cannot start a RouteAttempt', () => {
  const session = buildReviewedFixtureSession();
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const stopDecision = planRouteForQuestion(session, state0, {
    id: 'stop-q',
    rootCause: 'NONE',
    materialityReason: 'nothing material remains',
    inputRefs: [],
    createdAt: new Date().toISOString(),
  });
  const state1 = recordRouteDecision(session, state0, stopDecision, { stopReason: 'successful' });
  const before = JSON.parse(JSON.stringify(state1));
  assert.throws(
    () => recordRouteAttemptStart(session, state1, stopDecision.id),
    /already stopped|STOP has no RouteAttempt/
  );
  assert.deepEqual(state1, before, 'no attempt or cost from the rejected STOP start');
});

check('recordRouteAttemptStart independently rejects a STOP RouteDecision even when stopReason is not yet set (defensive corruption test)', () => {
  const session = buildReviewedFixtureSession();
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const stopDecision = planRouteForQuestion(session, state0, {
    id: 'stop-q',
    rootCause: 'NONE',
    materialityReason: 'nothing material remains',
    inputRefs: [],
    createdAt: new Date().toISOString(),
  });
  // Intentionally bypasses recordRouteDecision to isolate recordRouteAttemptStart's
  // own STOP-route guard from the separate "already stopped" guard -- both
  // independently reject STOP once a decision is recorded through the real API.
  const corrupted = { ...state0, history: [...state0.history, stopDecision] };
  assert.throws(() => recordRouteAttemptStart(session, corrupted, stopDecision.id), /STOP has no RouteAttempt/);
});

check('an unknown decisionId is rejected', () => {
  const { session, state } = buildStartedAttemptFixture('COVERAGE_GAP', 5);
  assert.throws(
    () => recordRouteAttemptStart(session, state, 'not-a-real-decision-id'),
    /is not a currently recorded RouteDecision/
  );
});

check('an empty or whitespace-only decisionId is rejected', () => {
  const session = buildReviewedFixtureSession();
  const state = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  for (const decisionId of ['', '   ']) {
    assert.throws(
      () => recordRouteAttemptStart(session, state, decisionId),
      /decisionId must be a non-empty string/,
      `expected decisionId ${JSON.stringify(decisionId)} to be rejected`
    );
  }
});

check('a null/missing decisionId from a plain-JS caller is rejected', () => {
  const session = buildReviewedFixtureSession();
  const state = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  for (const decisionId of [null, undefined]) {
    assert.throws(
      () => recordRouteAttemptStart(session, state, decisionId),
      /decisionId must be a non-empty string/,
      `expected decisionId ${JSON.stringify(decisionId)} to be rejected`
    );
  }
});

check('a planned-but-never-recorded RouteDecision does not authorize an attempt', () => {
  const { session, issueId } = buildFixtureWithIssue();
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const { state: state1, question } = buildRegisteredQuestion(session, state0, {
    rootCause: 'COVERAGE_GAP',
    materialityReason: 'x',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  const plannedOnly = planRouteForQuestion(session, state1, question);
  assert.throws(
    () => recordRouteAttemptStart(session, state1, plannedOnly.id),
    /is not a currently recorded RouteDecision/
  );
});

check('recordRouteAttemptStart rejects a wrong session binding', () => {
  const { state, decision } = buildRecordedDecisionFixture('COVERAGE_GAP');
  const otherSession = buildReviewedFixtureSession();
  assert.throws(() => recordRouteAttemptStart(otherSession, state, decision.id), /bound to session/);
});

check('recordRouteAttemptStart rejects a tampered frozen artifact', () => {
  const { session, state, decision } = buildRecordedDecisionFixture('COVERAGE_GAP');
  const tamperedSession = { ...session, artifactText: session.artifactText + ' TAMPERED' };
  assert.throws(
    () => recordRouteAttemptStart(tamperedSession, state, decision.id),
    /no longer matches its frozen artifactHash/
  );
});

check('recordRouteAttemptStart rejects a tampered frozen AuthorContext', () => {
  const { session, state, decision } = buildRecordedDecisionFixture('COVERAGE_GAP');
  const sneaked = { id: 'x', text: 'sneaked in', sourceType: 'AUTHOR', status: 'CURRENT', createdAt: new Date().toISOString() };
  const tamperedSession = {
    ...session,
    authorContext: { ...session.authorContext, constraints: [...session.authorContext.constraints, sneaked] },
  };
  assert.throws(
    () => recordRouteAttemptStart(tamperedSession, state, decision.id),
    /no longer matches its frozen authorContextHash/
  );
});

check('recordRouteAttemptStart rejects a mismatched DeliberationState.artifactHash', () => {
  const { session, state, decision } = buildRecordedDecisionFixture('COVERAGE_GAP');
  const tamperedState = { ...state, artifactHash: 'not-the-real-hash' };
  assert.throws(() => recordRouteAttemptStart(session, tamperedState, decision.id), /artifactHash/);
});

check('a state already terminated by STOP rejects starting an old, previously-recorded non-STOP decision', () => {
  const { session, state, decision } = buildRecordedDecisionFixture('COVERAGE_GAP', 5);
  const stopDecision = planRouteForQuestion(session, state, {
    id: 'stop-q',
    rootCause: 'NONE',
    materialityReason: 'nothing material remains',
    inputRefs: [],
    createdAt: new Date().toISOString(),
  });
  const stopped = recordRouteDecision(session, state, stopDecision, { stopReason: 'budget' });
  assert.equal(stopped.stopReason, 'budget');
  const before = JSON.parse(JSON.stringify(stopped));
  assert.throws(() => recordRouteAttemptStart(session, stopped, decision.id), /already stopped/);
  assert.deepEqual(stopped, before, 'no attempt or cost from the rejected start');
});

check('starting an attempt leaves the original DeliberationState, session, and registered question unchanged; returns a new object', () => {
  const { session, state, decision, question } = buildRecordedDecisionFixture('COVERAGE_GAP');
  const sessionBefore = JSON.parse(JSON.stringify(session));
  const stateBefore = JSON.parse(JSON.stringify(state));
  const questionBefore = JSON.parse(JSON.stringify(question));

  const next = recordRouteAttemptStart(session, state, decision.id);

  assert.notEqual(next, state, 'a new object must be returned');
  assert.deepEqual(session, sessionBefore, 'session must be unchanged');
  assert.deepEqual(state, stateBefore, 'the original DeliberationState must be unchanged');
  assert.deepEqual(question, questionBefore, 'the registered question fixture object must be unchanged');
  assert.equal(next.history, state.history, 'history array reference is untouched by starting an attempt');
});

check('recordRouteAttemptStart never touches session.adjudications or session.revisionActions', () => {
  const { session, state, decision } = buildRecordedDecisionFixture('COVERAGE_GAP');
  recordRouteAttemptStart(session, state, decision.id);
  assert.deepEqual(session.adjudications, {});
  assert.deepEqual(session.revisionActions, {});
});

// ==================================================================
// Q. RouteOutcome ledger (Slice 2D-B1)
// ==================================================================
console.log('\nRouteOutcome ledger (Slice 2D-B1)');

const VALID_FAILURE = { category: 'TRANSPORT', message: 'The provider request could not be completed.' };

// --- Q1. State shape --------------------------------------------------

check('createDeliberationState initializes outcomes=[]; prior fields and RouteAttempt behavior unchanged', () => {
  const session = buildReviewedFixtureSession();
  const state = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  assert.deepEqual(state.outcomes, []);
  assert.deepEqual(state.history, []);
  assert.deepEqual(state.attempts, []);
  assert.deepEqual(state.unresolvedQuestions, []);
  assert.equal(state.stopReason, null);
});

// --- Q2. Generic FAILED, for every non-STOP route ----------------------

for (const { rootCause, route } of NON_STOP_ROUTE_FIXTURES) {
  check(`generic FAILED RouteOutcome records for ${route} with every field correct`, () => {
    const { session, state, decision } = buildStartedAttemptFixture(rootCause, 5, 5);
    const attempt = state.attempts[0];
    const preOutcomeCostSpent = state.costBudget.spent;

    const next = recordRouteOutcome(session, state, {
      attemptId: attempt.attemptId,
      status: 'FAILED',
      latencyConsumed: 2,
      failure: VALID_FAILURE,
    });

    assert.equal(next.outcomes.length, 1);
    const outcome = next.outcomes[0];
    assert.equal(outcome.attemptId, attempt.attemptId);
    assert.equal(outcome.decisionId, decision.id);
    assert.equal(outcome.originatingQuestionId, decision.questionId);
    assert.equal(outcome.route, route);
    assert.equal(outcome.sessionId, session.id);
    assert.equal(outcome.artifactHash, session.artifactHash);
    assert.equal(outcome.authorContextHash, session.authorContextHash);
    assert.equal(outcome.status, 'FAILED');
    assert.equal(outcome.logicalCost, attempt.logicalCost);
    assert.equal(outcome.latencyConsumed, 2);
    assert.equal(typeof outcome.completedAt, 'string');
    assert.ok(outcome.completedAt.length > 0);
    assert.deepEqual(outcome.failure, VALID_FAILURE);
    assert.equal(next.costBudget.spent, preOutcomeCostSpent, 'cost is unchanged by recording an outcome');
    assert.equal(next.latencyBudget.spent, 2, 'latency increments exactly once');
  });
}

// --- Q3. Failure validation ---------------------------------------------

check('an unknown FailureCategory is rejected', () => {
  const { session, state } = buildStartedAttemptFixture('COVERAGE_GAP');
  const attempt = state.attempts[0];
  assert.throws(
    () =>
      recordRouteOutcome(session, state, {
        attemptId: attempt.attemptId,
        status: 'FAILED',
        latencyConsumed: 1,
        failure: { category: 'NOT_A_CATEGORY', message: 'x' },
      }),
    /invalid FailureCategory/
  );
});

check('an empty or whitespace-only failure message is rejected', () => {
  const { session, state } = buildStartedAttemptFixture('COVERAGE_GAP');
  const attempt = state.attempts[0];
  for (const message of ['', '   ']) {
    assert.throws(
      () =>
        recordRouteOutcome(session, state, {
          attemptId: attempt.attemptId,
          status: 'FAILED',
          latencyConsumed: 1,
          failure: { category: 'TRANSPORT', message },
        }),
      /must be a non-empty string/
    );
  }
});

check('a failure message over 2000 characters is rejected, not truncated', () => {
  const { session, state } = buildStartedAttemptFixture('COVERAGE_GAP');
  const attempt = state.attempts[0];
  const tooLong = 'x'.repeat(2001);
  assert.throws(
    () =>
      recordRouteOutcome(session, state, {
        attemptId: attempt.attemptId,
        status: 'FAILED',
        latencyConsumed: 1,
        failure: { category: 'TRANSPORT', message: tooLong },
      }),
    /exceeds 2000 characters/
  );
});

check('a failure message of exactly 2000 characters is accepted', () => {
  const { session, state } = buildStartedAttemptFixture('COVERAGE_GAP');
  const attempt = state.attempts[0];
  const exactly2000 = 'x'.repeat(2000);
  const next = recordRouteOutcome(session, state, {
    attemptId: attempt.attemptId,
    status: 'FAILED',
    latencyConsumed: 1,
    failure: { category: 'TRANSPORT', message: exactly2000 },
  });
  assert.equal(next.outcomes[0].failure.message.length, 2000);
});

check('a null failure message, or a raw object in place of a message, is rejected', () => {
  const { session, state } = buildStartedAttemptFixture('COVERAGE_GAP');
  const attempt = state.attempts[0];
  for (const message of [null, { code: 'ECONNRESET' }]) {
    assert.throws(
      () =>
        recordRouteOutcome(session, state, {
          attemptId: attempt.attemptId,
          status: 'FAILED',
          latencyConsumed: 1,
          failure: { category: 'TRANSPORT', message },
        }),
      /must be a non-empty string/
    );
  }
});

check('extra keys on FailureInfo are rejected (stack/headers/raw/cause never persisted)', () => {
  const { session, state } = buildStartedAttemptFixture('COVERAGE_GAP');
  const attempt = state.attempts[0];
  for (const extra of [{ stack: 'at foo()' }, { headers: {} }, { raw: {} }, { cause: new Error('x') }]) {
    assert.throws(
      () =>
        recordRouteOutcome(session, state, {
          attemptId: attempt.attemptId,
          status: 'FAILED',
          latencyConsumed: 1,
          failure: { category: 'TRANSPORT', message: 'x', ...extra },
        }),
      /unexpected field/
    );
  }
});

check('a FAILED input carrying a route-specific success payload field is rejected', () => {
  const { session, state } = buildStartedAttemptFixture('COVERAGE_GAP');
  const attempt = state.attempts[0];
  for (const extra of [
    { reviewerRunId: 'x', findingIds: [] },
    { result: 'REPRODUCED', targetRef: { kind: 'SEMANTIC_ISSUE', id: 'x' } },
  ]) {
    assert.throws(
      () =>
        recordRouteOutcome(session, state, {
          attemptId: attempt.attemptId,
          status: 'FAILED',
          latencyConsumed: 1,
          failure: VALID_FAILURE,
          ...extra,
        }),
      /unexpected field/
    );
  }
});

check('caller-supplied logicalCost, completedAt, route, decisionId, or hashes are all rejected', () => {
  const { session, state, decision } = buildStartedAttemptFixture('COVERAGE_GAP');
  const attempt = state.attempts[0];
  const forbiddenExtras = [
    { logicalCost: 0 },
    { completedAt: new Date().toISOString() },
    { route: 'ADD_REVIEWER' },
    { decisionId: decision.id },
    { sessionId: session.id },
    { artifactHash: session.artifactHash },
    { authorContextHash: session.authorContextHash },
  ];
  for (const extra of forbiddenExtras) {
    assert.throws(
      () =>
        recordRouteOutcome(session, state, {
          attemptId: attempt.attemptId,
          status: 'FAILED',
          latencyConsumed: 1,
          failure: VALID_FAILURE,
          ...extra,
        }),
      /unexpected field/,
      `expected extra field ${JSON.stringify(Object.keys(extra))} to be rejected`
    );
  }
});

// --- Q4. Duplicate / attempt binding -------------------------------------

check('an unknown, blank, or missing attemptId is rejected', () => {
  const { session, state } = buildStartedAttemptFixture('COVERAGE_GAP');
  for (const attemptId of ['not-a-real-attempt', '', '   ', null, undefined]) {
    assert.throws(
      () => recordRouteOutcome(session, state, { attemptId, status: 'FAILED', latencyConsumed: 1, failure: VALID_FAILURE }),
      /must be a non-empty string|is not a currently recorded RouteAttempt/,
      `expected attemptId ${JSON.stringify(attemptId)} to be rejected`
    );
  }
});

check('a second RouteOutcome for the same attemptId is rejected; the first outcome is unchanged', () => {
  const { session, state } = buildStartedAttemptFixture('COVERAGE_GAP');
  const attempt = state.attempts[0];
  const next = recordRouteOutcome(session, state, {
    attemptId: attempt.attemptId,
    status: 'FAILED',
    latencyConsumed: 1,
    failure: VALID_FAILURE,
  });
  const before = JSON.parse(JSON.stringify(next));
  assert.throws(
    () => recordRouteOutcome(session, next, { attemptId: attempt.attemptId, status: 'FAILED', latencyConsumed: 1, failure: VALID_FAILURE }),
    /already has a RouteOutcome/
  );
  assert.deepEqual(next, before, 'no extra outcome or latency spend from the rejected duplicate');
});

check('recording is rejected once the deliberation has stopped', () => {
  const { session, state, decision } = buildStartedAttemptFixture('COVERAGE_GAP');
  const attempt = state.attempts[0];
  const stopDecision = planRouteForQuestion(session, state, {
    id: 'stop-q',
    rootCause: 'NONE',
    materialityReason: 'nothing material remains',
    inputRefs: [],
    createdAt: new Date().toISOString(),
  });
  const stopped = recordRouteDecision(session, state, stopDecision, { stopReason: 'budget' });
  assert.throws(
    () =>
      recordRouteOutcome(session, stopped, {
        attemptId: attempt.attemptId,
        status: 'FAILED',
        latencyConsumed: 1,
        failure: VALID_FAILURE,
      }),
    /already stopped/
  );
});

check('a tampered attempt (route/decisionId/questionId/sessionId/hashes/logicalCost) is rejected', () => {
  const { session, state } = buildStartedAttemptFixture('COVERAGE_GAP');
  const attempt = state.attempts[0];
  const tamperCases = [
    { route: 'REPLICATE' },
    { decisionId: 'not-a-real-decision' },
    { questionId: 'not-a-real-question' },
    { sessionId: 'not-the-real-session' },
    { artifactHash: 'not-the-real-hash' },
    { authorContextHash: 'not-the-real-hash' },
    { logicalCost: attempt.logicalCost + 1 },
  ];
  for (const tamper of tamperCases) {
    const tamperedState = { ...state, attempts: [{ ...attempt, ...tamper }] };
    assert.throws(
      () =>
        recordRouteOutcome(session, tamperedState, {
          attemptId: attempt.attemptId,
          status: 'FAILED',
          latencyConsumed: 1,
          failure: VALID_FAILURE,
        }),
      undefined,
      `expected tamper ${JSON.stringify(tamper)} to be rejected`
    );
  }
});

check('a malformed attempt.startedAt is rejected', () => {
  const { session, state } = buildStartedAttemptFixture('COVERAGE_GAP');
  const attempt = state.attempts[0];
  const tamperedState = { ...state, attempts: [{ ...attempt, startedAt: 'not-a-timestamp' }] };
  assert.throws(
    () =>
      recordRouteOutcome(session, tamperedState, {
        attemptId: attempt.attemptId,
        status: 'FAILED',
        latencyConsumed: 1,
        failure: VALID_FAILURE,
      }),
    /not a valid parseable timestamp/
  );
});

check('an attempt whose recorded decision is missing is rejected', () => {
  const { session, state } = buildStartedAttemptFixture('COVERAGE_GAP');
  const attempt = state.attempts[0];
  const tamperedState = { ...state, history: [] };
  assert.throws(
    () =>
      recordRouteOutcome(session, tamperedState, {
        attemptId: attempt.attemptId,
        status: 'FAILED',
        latencyConsumed: 1,
        failure: VALID_FAILURE,
      }),
    /is not a currently recorded RouteDecision/
  );
});

check('an attempt whose recorded decision has a mismatched route is rejected', () => {
  const { session, state, decision } = buildStartedAttemptFixture('COVERAGE_GAP');
  const attempt = state.attempts[0];
  const tamperedState = {
    ...state,
    history: [{ ...decision, route: 'REPLICATE', reason: { ...decision.reason, rootCause: 'STABILITY_QUESTION' } }],
  };
  assert.throws(
    () =>
      recordRouteOutcome(session, tamperedState, {
        attemptId: attempt.attemptId,
        status: 'FAILED',
        latencyConsumed: 1,
        failure: VALID_FAILURE,
      }),
    /recorded decision route does not match the attempt route/
  );
});

check('an attempt whose registered question provenance mismatches the decision is rejected', () => {
  const { session, state, question } = buildStartedAttemptFixture('COVERAGE_GAP');
  const attempt = state.attempts[0];
  const tamperedState = {
    ...state,
    unresolvedQuestions: [{ ...question, materialityReason: 'a different reason entirely' }],
  };
  assert.throws(
    () =>
      recordRouteOutcome(session, tamperedState, {
        attemptId: attempt.attemptId,
        status: 'FAILED',
        latencyConsumed: 1,
        failure: VALID_FAILURE,
      }),
    /materialityReason does not match/
  );
});

// --- Q5. Latency ----------------------------------------------------------

check('finite non-negative latencyConsumed, including zero, is accepted', () => {
  for (const latencyConsumed of [0, 3.5]) {
    const { session, state } = buildStartedAttemptFixture('COVERAGE_GAP');
    const attempt = state.attempts[0];
    const next = recordRouteOutcome(session, state, {
      attemptId: attempt.attemptId,
      status: 'FAILED',
      latencyConsumed,
      failure: VALID_FAILURE,
    });
    assert.equal(next.latencyBudget.spent, latencyConsumed);
  }
});

check('negative, NaN, or Infinity latencyConsumed is rejected', () => {
  const { session, state } = buildStartedAttemptFixture('COVERAGE_GAP');
  const attempt = state.attempts[0];
  for (const latencyConsumed of [-1, NaN, Infinity]) {
    assert.throws(() =>
      recordRouteOutcome(session, state, { attemptId: attempt.attemptId, status: 'FAILED', latencyConsumed, failure: VALID_FAILURE })
    );
  }
});

check('latency over the ceiling is rejected; no outcome appended, no extra spend, cost unaffected', () => {
  const { session, state } = buildStartedAttemptFixture('COVERAGE_GAP', 5, 1);
  const attempt = state.attempts[0];
  const before = JSON.parse(JSON.stringify(state));
  assert.throws(
    () =>
      recordRouteOutcome(session, state, { attemptId: attempt.attemptId, status: 'FAILED', latencyConsumed: 2, failure: VALID_FAILURE }),
    /exceed the latency ceiling/
  );
  assert.deepEqual(state, before, 'original state unchanged after a rejected recording');
});

check('a rejected duplicate outcome does not charge latency twice', () => {
  const { session, state } = buildStartedAttemptFixture('COVERAGE_GAP', 5, 3);
  const attempt = state.attempts[0];
  const next = recordRouteOutcome(session, state, {
    attemptId: attempt.attemptId,
    status: 'FAILED',
    latencyConsumed: 2,
    failure: VALID_FAILURE,
  });
  assert.equal(next.latencyBudget.spent, 2);
  try {
    recordRouteOutcome(session, next, { attemptId: attempt.attemptId, status: 'FAILED', latencyConsumed: 2, failure: VALID_FAILURE });
  } catch {
    // expected
  }
  assert.equal(next.latencyBudget.spent, 2, 'no second latency charge from a rejected duplicate');
});

// --- Q6. ADD_REVIEWER -------------------------------------------------------

check('ADD_REVIEWER succeeds with zero, one, and multiple findings', () => {
  for (const count of [0, 1, 2]) {
    const { session: session0, state, attempt } = (() => {
      const fixture = buildStartedAttemptFixture('COVERAGE_GAP');
      return { ...fixture, attempt: fixture.state.attempts[0] };
    })();
    let session = session0;
    const findingIds = [];
    for (let i = 0; i < count; i++) {
      const added = addReviewerFinding(session, 'reviewer-run-multi');
      session = added.session;
      findingIds.push(added.findingId);
    }
    const next = recordRouteOutcome(session, state, {
      attemptId: attempt.attemptId,
      status: 'SUCCEEDED',
      latencyConsumed: 1,
      reviewerRunId: 'reviewer-run-multi',
      findingIds,
    });
    const outcome = next.outcomes[0];
    assert.equal(outcome.status, 'SUCCEEDED');
    assert.equal(outcome.route, 'ADD_REVIEWER');
    assert.equal(outcome.reviewerRunId, 'reviewer-run-multi');
    assert.deepEqual(outcome.findingIds, findingIds);
    assert.notEqual(outcome.reviewerRunId, attempt.attemptId);
    assert.equal(Object.prototype.hasOwnProperty.call(outcome, 'reviewFindings'), false, 'no ReviewFinding objects are copied');
  }
});

check('ADD_REVIEWER rejects when the attempt route is not ADD_REVIEWER', () => {
  const { session, state } = buildStartedAttemptFixture('STABILITY_QUESTION');
  const attempt = state.attempts[0];
  assert.throws(
    () =>
      recordRouteOutcome(session, state, {
        attemptId: attempt.attemptId,
        status: 'SUCCEEDED',
        latencyConsumed: 1,
        reviewerRunId: 'x',
        findingIds: [],
      }),
    /not authorized in Slice 2D-B1|unexpected field/
  );
});

check('ADD_REVIEWER rejects a blank reviewerRunId, or reviewerRunId === attemptId', () => {
  const { session, state } = buildStartedAttemptFixture('COVERAGE_GAP');
  const attempt = state.attempts[0];
  for (const reviewerRunId of ['', '   ', attempt.attemptId]) {
    assert.throws(() =>
      recordRouteOutcome(session, state, { attemptId: attempt.attemptId, status: 'SUCCEEDED', latencyConsumed: 1, reviewerRunId, findingIds: [] })
    );
  }
});

check('ADD_REVIEWER rejects an unknown or duplicate findingId', () => {
  const { session, state } = buildStartedAttemptFixture('COVERAGE_GAP');
  const attempt = state.attempts[0];
  assert.throws(
    () =>
      recordRouteOutcome(session, state, {
        attemptId: attempt.attemptId,
        status: 'SUCCEEDED',
        latencyConsumed: 1,
        reviewerRunId: 'run-x',
        findingIds: ['not-a-real-finding'],
      }),
    /unknown findingId/
  );
  const added = addReviewerFinding(session, 'run-x');
  assert.throws(
    () =>
      recordRouteOutcome(added.session, state, {
        attemptId: attempt.attemptId,
        status: 'SUCCEEDED',
        latencyConsumed: 1,
        reviewerRunId: 'run-x',
        findingIds: [added.findingId, added.findingId],
      }),
    /duplicate findingId/
  );
});

check('ADD_REVIEWER rejects a findingId whose reviewerRunId does not match', () => {
  const { session, state } = buildStartedAttemptFixture('COVERAGE_GAP');
  const attempt = state.attempts[0];
  const added = addReviewerFinding(session, 'actual-run');
  assert.throws(
    () =>
      recordRouteOutcome(added.session, state, {
        attemptId: attempt.attemptId,
        status: 'SUCCEEDED',
        latencyConsumed: 1,
        reviewerRunId: 'claimed-run',
        findingIds: [added.findingId],
      }),
    /reviewerRunId does not match/
  );
});

check('ADD_REVIEWER rejects a finding with a malformed createdAt or createdAt before attempt.startedAt', () => {
  const { session, state } = buildStartedAttemptFixture('COVERAGE_GAP');
  const attempt = state.attempts[0];
  const malformed = addReviewerFinding(session, 'run-malformed', { createdAt: 'not-a-timestamp' });
  // addFinding always stamps its own createdAt (createdAt is not caller-overridable there), so this
  // exercises the case indirectly by tampering the session's stored finding instead.
  const tamperedSession = {
    ...malformed.session,
    findings: {
      ...malformed.session.findings,
      [malformed.findingId]: { ...malformed.session.findings[malformed.findingId], createdAt: 'not-a-timestamp' },
    },
  };
  assert.throws(
    () =>
      recordRouteOutcome(tamperedSession, state, {
        attemptId: attempt.attemptId,
        status: 'SUCCEEDED',
        latencyConsumed: 1,
        reviewerRunId: 'run-malformed',
        findingIds: [malformed.findingId],
      }),
    /unparseable createdAt/
  );

  const early = addReviewerFinding(session, 'run-early');
  const backdatedSession = {
    ...early.session,
    findings: {
      ...early.session.findings,
      [early.findingId]: { ...early.session.findings[early.findingId], createdAt: '2000-01-01T00:00:00.000Z' },
    },
  };
  assert.throws(
    () =>
      recordRouteOutcome(backdatedSession, state, {
        attemptId: attempt.attemptId,
        status: 'SUCCEEDED',
        latencyConsumed: 1,
        reviewerRunId: 'run-early',
        findingIds: [early.findingId],
      }),
    /before the attempt's startedAt/
  );
});

check('ADD_REVIEWER rejects a reviewerRunId already claimed by an earlier successful outcome', () => {
  const { session: session0, state } = buildStartedAttemptFixture('COVERAGE_GAP');
  const attempt = state.attempts[0];
  const added1 = addReviewerFinding(session0, 'shared-run');
  const afterFirst = recordRouteOutcome(added1.session, state, {
    attemptId: attempt.attemptId,
    status: 'SUCCEEDED',
    latencyConsumed: 1,
    reviewerRunId: 'shared-run',
    findingIds: [added1.findingId],
  });

  const { session: session2, state: state2 } = buildStartedAttemptFixture('COVERAGE_GAP');
  const attempt2 = state2.attempts[0];
  const mergedState = { ...state2, outcomes: afterFirst.outcomes };
  const added2 = addReviewerFinding(session2, 'shared-run');
  assert.throws(
    () =>
      recordRouteOutcome(added2.session, mergedState, {
        attemptId: attempt2.attemptId,
        status: 'SUCCEEDED',
        latencyConsumed: 1,
        reviewerRunId: 'shared-run',
        findingIds: [added2.findingId],
      }),
    /already claimed by an earlier successful ADD_REVIEWER RouteOutcome/
  );
});

check('ADD_REVIEWER rejects unexpected extra fields and leaves session findings unchanged on rejection', () => {
  const { session, state } = buildStartedAttemptFixture('COVERAGE_GAP');
  const attempt = state.attempts[0];
  const findingsBefore = JSON.parse(JSON.stringify(session.findings));
  assert.throws(
    () =>
      recordRouteOutcome(session, state, {
        attemptId: attempt.attemptId,
        status: 'SUCCEEDED',
        latencyConsumed: 1,
        reviewerRunId: 'run-x',
        findingIds: [],
        targetRef: { kind: 'SEMANTIC_ISSUE', id: 'x' },
      }),
    /unexpected field/
  );
  assert.deepEqual(session.findings, findingsBefore);
});

// --- Q7. REPLICATE ----------------------------------------------------------

for (const result of ['REPRODUCED', 'NOT_REPRODUCED', 'PARTIAL']) {
  check(`REPLICATE succeeds with result=${result}`, () => {
    const { session, state, issueId } = buildStartedAttemptFixture('STABILITY_QUESTION');
    const attempt = state.attempts[0];
    const targetRef = { kind: 'SEMANTIC_ISSUE', id: issueId };
    const next = recordRouteOutcome(session, state, {
      attemptId: attempt.attemptId,
      status: 'SUCCEEDED',
      latencyConsumed: 1,
      result,
      targetRef,
    });
    const outcome = next.outcomes[0];
    assert.equal(outcome.status, 'SUCCEEDED');
    assert.equal(outcome.route, 'REPLICATE');
    assert.equal(outcome.result, result);
    assert.deepEqual(outcome.targetRef, targetRef);
  });
}

check('REPLICATE rejects an invalid result string and status=INCONCLUSIVE', () => {
  const { session, state, issueId } = buildStartedAttemptFixture('STABILITY_QUESTION');
  const attempt = state.attempts[0];
  const targetRef = { kind: 'SEMANTIC_ISSUE', id: issueId };
  assert.throws(
    () => recordRouteOutcome(session, state, { attemptId: attempt.attemptId, status: 'SUCCEEDED', latencyConsumed: 1, result: 'NOT_A_RESULT', targetRef }),
    /invalid ReplicationResult/
  );
  assert.throws(
    () => recordRouteOutcome(session, state, { attemptId: attempt.attemptId, status: 'INCONCLUSIVE', latencyConsumed: 1, result: 'PARTIAL', targetRef }),
    /INCONCLUSIVE is not recordable/
  );
});

check('REPLICATE rejects when the attempt route is not REPLICATE', () => {
  const { session, state, issueId } = buildStartedAttemptFixture('COVERAGE_GAP');
  const attempt = state.attempts[0];
  assert.throws(
    () =>
      recordRouteOutcome(session, state, {
        attemptId: attempt.attemptId,
        status: 'SUCCEEDED',
        latencyConsumed: 1,
        result: 'REPRODUCED',
        targetRef: { kind: 'SEMANTIC_ISSUE', id: issueId },
      }),
    /not authorized in Slice 2D-B1|unexpected field/
  );
});

check('REPLICATE rejects an unknown targetRef, a ref absent from decision.inputRefs, and a same-id-wrong-kind ref', () => {
  const { session, state, issueId, findingIds } = buildStartedAttemptFixture('STABILITY_QUESTION');
  const attempt = state.attempts[0];

  assert.throws(
    () =>
      recordRouteOutcome(session, state, {
        attemptId: attempt.attemptId,
        status: 'SUCCEEDED',
        latencyConsumed: 1,
        result: 'REPRODUCED',
        targetRef: { kind: 'SEMANTIC_ISSUE', id: 'not-a-real-issue' },
      }),
    /unknown SEMANTIC_ISSUE id/
  );

  assert.throws(
    () =>
      recordRouteOutcome(session, state, {
        attemptId: attempt.attemptId,
        status: 'SUCCEEDED',
        latencyConsumed: 1,
        result: 'REPRODUCED',
        targetRef: { kind: 'FINDING', id: findingIds[0] },
      }),
    /must exactly match one of the recorded RouteDecision.inputRefs/
  );

  assert.throws(
    () =>
      recordRouteOutcome(session, state, {
        attemptId: attempt.attemptId,
        status: 'SUCCEEDED',
        latencyConsumed: 1,
        result: 'REPRODUCED',
        targetRef: { kind: 'FINDING', id: issueId },
      }),
    /unknown FINDING id/
  );
});

check('REPLICATE rejects an AUTHOR_CONTEXT_ITEM target and a malformed targetRef', () => {
  const { session, state } = buildStartedAttemptFixture('STABILITY_QUESTION');
  const attempt = state.attempts[0];
  const authorItemId = session.authorContext.constraints[0].id;
  assert.throws(
    () =>
      recordRouteOutcome(session, state, {
        attemptId: attempt.attemptId,
        status: 'SUCCEEDED',
        latencyConsumed: 1,
        result: 'REPRODUCED',
        targetRef: { kind: 'AUTHOR_CONTEXT_ITEM', id: authorItemId },
      }),
    /must be FINDING or SEMANTIC_ISSUE/
  );
  assert.throws(
    () =>
      recordRouteOutcome(session, state, {
        attemptId: attempt.attemptId,
        status: 'SUCCEEDED',
        latencyConsumed: 1,
        result: 'REPRODUCED',
        targetRef: { kind: 'NOT_A_KIND', id: 'x' },
      }),
    /invalid ref kind/
  );
});

check('REPLICATE rejects unexpected extra fields', () => {
  const { session, state, issueId } = buildStartedAttemptFixture('STABILITY_QUESTION');
  const attempt = state.attempts[0];
  assert.throws(
    () =>
      recordRouteOutcome(session, state, {
        attemptId: attempt.attemptId,
        status: 'SUCCEEDED',
        latencyConsumed: 1,
        result: 'REPRODUCED',
        targetRef: { kind: 'SEMANTIC_ISSUE', id: issueId },
        reviewerRunId: 'x',
      }),
    /unexpected field/
  );
});

check('REPLICATE targetRef is snapshot-isolated: mutating the caller-owned ref after recording does not alter the outcome', () => {
  const { session, state, issueId } = buildStartedAttemptFixture('STABILITY_QUESTION');
  const attempt = state.attempts[0];
  const targetRef = { kind: 'SEMANTIC_ISSUE', id: issueId };
  const next = recordRouteOutcome(session, state, {
    attemptId: attempt.attemptId,
    status: 'SUCCEEDED',
    latencyConsumed: 1,
    result: 'REPRODUCED',
    targetRef,
  });
  targetRef.id = 'mutated-after-recording';
  targetRef.kind = 'FINDING';
  assert.deepEqual(next.outcomes[0].targetRef, { kind: 'SEMANTIC_ISSUE', id: issueId });
});

// --- Q8. Blocked successful routes/results ---------------------------------

// ADD_CONTEXT SUPPLIED/DECLINED became recordable in Slice 2D-C2 (see
// Section U below for their own dedicated tests); NO_RESPONSE remains
// blocked but is tested there too, with a real ContextRequest present,
// rather than via this generic no-request loop.
const BLOCKED_SUCCESS_CASES = [
  { rootCause: 'EVIDENCE_GAP', extra: { citations: [] }, label: 'SEEK_EVIDENCE SUPPORTIVE' },
  { rootCause: 'EVIDENCE_GAP', extra: { citations: [] }, label: 'SEEK_EVIDENCE CONTRADICTORY' },
  { rootCause: 'EVIDENCE_GAP', extra: {}, label: 'SEEK_EVIDENCE INCONCLUSIVE' },
  {
    rootCause: 'DECISION_SENSITIVE_CONFLICT',
    extra: { targetRef: { kind: 'SEMANTIC_ISSUE', id: 'x' }, sourceRef: { kind: 'SEMANTIC_ISSUE', id: 'y' }, response: 'x' },
    label: 'TARGETED_PEER_CHALLENGE REBUTTAL',
  },
];

for (const { rootCause, extra, label } of BLOCKED_SUCCESS_CASES) {
  check(`SUCCEEDED recording is rejected for ${label} (route not authorized in Slice 2D-B1)`, () => {
    const { session, state } = buildStartedAttemptFixture(rootCause);
    const attempt = state.attempts[0];
    const before = JSON.parse(JSON.stringify(state));
    assert.throws(
      () => recordRouteOutcome(session, state, { attemptId: attempt.attemptId, status: 'SUCCEEDED', latencyConsumed: 1, ...extra }),
      /not authorized in Slice 2D-B1/
    );
    assert.deepEqual(state, before, 'no outcome or spend from a rejected blocked-route recording');
  });
}

check('generic FAILED still succeeds for ADD_CONTEXT, SEEK_EVIDENCE, and TARGETED_PEER_CHALLENGE attempts', () => {
  for (const rootCause of ['CONTEXT_GAP', 'EVIDENCE_GAP', 'DECISION_SENSITIVE_CONFLICT']) {
    const { session, state } = buildStartedAttemptFixture(rootCause);
    const attempt = state.attempts[0];
    const next = recordRouteOutcome(session, state, {
      attemptId: attempt.attemptId,
      status: 'FAILED',
      latencyConsumed: 1,
      failure: VALID_FAILURE,
    });
    assert.equal(next.outcomes[0].status, 'FAILED');
  }
});

// --- Q9. Snapshot / immutability --------------------------------------------

check('recording an outcome leaves the original DeliberationState/session unchanged and returns a new object', () => {
  const { session, state } = buildStartedAttemptFixture('COVERAGE_GAP');
  const attempt = state.attempts[0];
  const sessionBefore = JSON.parse(JSON.stringify(session));
  const stateBefore = JSON.parse(JSON.stringify(state));

  const next = recordRouteOutcome(session, state, {
    attemptId: attempt.attemptId,
    status: 'FAILED',
    latencyConsumed: 1,
    failure: VALID_FAILURE,
  });

  assert.notEqual(next, state);
  assert.deepEqual(session, sessionBefore, 'session must be unchanged');
  assert.deepEqual(state, stateBefore, 'the original DeliberationState must be unchanged');
  assert.deepEqual(next.attempts, state.attempts);
  assert.deepEqual(next.history, state.history);
  assert.deepEqual(next.unresolvedQuestions, state.unresolvedQuestions);
  assert.deepEqual(session.adjudications, {});
  assert.deepEqual(session.revisionActions, {});
});

check('mutating a caller-owned FailureInfo after recording does not alter the recorded outcome', () => {
  const { session, state } = buildStartedAttemptFixture('COVERAGE_GAP');
  const attempt = state.attempts[0];
  const failure = { category: 'TRANSPORT', message: 'original message' };
  const next = recordRouteOutcome(session, state, { attemptId: attempt.attemptId, status: 'FAILED', latencyConsumed: 1, failure });
  failure.message = 'mutated after recording';
  failure.category = 'VALIDATION';
  assert.deepEqual(next.outcomes[0].failure, { category: 'TRANSPORT', message: 'original message' });
});

check('mutating a caller-owned findingIds array after recording does not alter the recorded outcome', () => {
  const { session: session0, state } = buildStartedAttemptFixture('COVERAGE_GAP');
  const attempt = state.attempts[0];
  const added = addReviewerFinding(session0, 'run-snapshot');
  const findingIds = [added.findingId];
  const next = recordRouteOutcome(added.session, state, {
    attemptId: attempt.attemptId,
    status: 'SUCCEEDED',
    latencyConsumed: 1,
    reviewerRunId: 'run-snapshot',
    findingIds,
  });
  findingIds.push('sneaked-in-after-recording');
  assert.deepEqual(next.outcomes[0].findingIds, [added.findingId]);
});

// ==================================================================
// R. Question disposition & currentness (Slice 2D-B2-A)
// ==================================================================
console.log('\nQuestion disposition & currentness (Slice 2D-B2-A)');

// --- R1. State shape --------------------------------------------------

check('createDeliberationState initializes questionDispositions=[]; other fields unchanged; no current/active field exists', () => {
  const session = buildReviewedFixtureSession();
  const state = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  assert.deepEqual(state.questionDispositions, []);
  assert.deepEqual(state.history, []);
  assert.deepEqual(state.attempts, []);
  assert.deepEqual(state.outcomes, []);
  assert.equal('current' in state, false);
  assert.equal('active' in state, false);
  assert.equal('currentQuestions' in state, false);
  assert.equal('activeCycles' in state, false);
});

// --- R2. Basic disposition recording -----------------------------------

check('STILL_OPEN and RESOLVED record correctly for a FAILED outcome', () => {
  for (const disposition of ['STILL_OPEN', 'RESOLVED']) {
    const { session, state, question, attempt } = buildFailedCycleFixture('COVERAGE_GAP');
    const next = recordQuestionDisposition(session, state, { attemptId: attempt.attemptId, disposition, reason: 'independent re-evaluation' });
    assert.equal(next.questionDispositions.length, 1);
    const recorded = next.questionDispositions[0];
    assert.equal(recorded.attemptId, attempt.attemptId);
    assert.equal(recorded.questionId, question.id);
    assert.equal(recorded.sessionId, session.id);
    assert.equal(recorded.artifactHash, session.artifactHash);
    assert.equal(recorded.authorContextHash, session.authorContextHash);
    assert.equal(recorded.disposition, disposition);
    assert.equal(recorded.reason, 'independent re-evaluation');
    assert.equal(typeof recorded.createdAt, 'string');
    assert.ok(recorded.createdAt.length > 0);
    assert.equal('dispositionId' in recorded, false);
    assert.equal('replacementQuestion' in recorded, false);
  }
});

check('STILL_OPEN and RESOLVED record correctly for a successful ADD_REVIEWER outcome', () => {
  for (const disposition of ['STILL_OPEN', 'RESOLVED']) {
    const { session, state, question, attempt } = buildAddReviewerSuccessCycleFixture(`run-${disposition}`);
    const next = recordQuestionDisposition(session, state, { attemptId: attempt.attemptId, disposition, reason: 'independent re-evaluation' });
    const recorded = next.questionDispositions[0];
    assert.equal(recorded.attemptId, attempt.attemptId);
    assert.equal(recorded.questionId, question.id);
    assert.equal(recorded.disposition, disposition);
  }
});

check('STILL_OPEN and RESOLVED record correctly for a successful REPLICATE outcome', () => {
  for (const disposition of ['STILL_OPEN', 'RESOLVED']) {
    const { session, state, question, attempt } = buildReplicateSuccessCycleFixture('REPRODUCED');
    const next = recordQuestionDisposition(session, state, { attemptId: attempt.attemptId, disposition, reason: 'independent re-evaluation' });
    const recorded = next.questionDispositions[0];
    assert.equal(recorded.attemptId, attempt.attemptId);
    assert.equal(recorded.questionId, question.id);
    assert.equal(recorded.disposition, disposition);
  }
});

// --- R3. Disposition input validation -----------------------------------

check('an unknown, blank, or missing attemptId is rejected', () => {
  const { session, state } = buildFailedCycleFixture('COVERAGE_GAP');
  for (const attemptId of ['not-a-real-attempt', '', '   ', null, undefined]) {
    assert.throws(
      () => recordQuestionDisposition(session, state, { attemptId, disposition: 'STILL_OPEN', reason: 'x' }),
      /must be a non-empty string|does not resolve to any recorded RouteOutcome/,
      `expected attemptId ${JSON.stringify(attemptId)} to be rejected`
    );
  }
});

check('an empty, whitespace-only, or null reason is rejected', () => {
  const { session, state, attempt } = buildFailedCycleFixture('COVERAGE_GAP');
  for (const reason of ['', '   ', null]) {
    assert.throws(
      () => recordQuestionDisposition(session, state, { attemptId: attempt.attemptId, disposition: 'STILL_OPEN', reason }),
      /must be a non-empty string/
    );
  }
});

check('an invalid, unsupported, or missing disposition is rejected, never silently coerced', () => {
  // SUPERSEDED_RECLASSIFIED became recordable in Slice 2D-B2-B (see Section S
  // below for its own dedicated validation); it is intentionally no longer
  // in this "always invalid" list.
  const { session, state, attempt } = buildFailedCycleFixture('COVERAGE_GAP');
  for (const disposition of ['CROSS_SESSION', 'NOT_A_DISPOSITION', null, undefined]) {
    assert.throws(
      () => recordQuestionDisposition(session, state, { attemptId: attempt.attemptId, disposition, reason: 'x' }),
      /invalid or unsupported disposition/,
      `expected disposition ${JSON.stringify(disposition)} to be rejected`
    );
  }
});

check('caller-supplied derived fields (questionId/sessionId/hashes/createdAt/dispositionId/replacementQuestion) are all rejected', () => {
  const { session, state, question, attempt } = buildFailedCycleFixture('COVERAGE_GAP');
  const forbiddenExtras = [
    { questionId: question.id },
    { sessionId: session.id },
    { artifactHash: session.artifactHash },
    { authorContextHash: session.authorContextHash },
    { createdAt: new Date().toISOString() },
    { dispositionId: 'x' },
    { replacementQuestion: { id: 'x' } },
    { newSessionId: 'x' },
    { lineage: {} },
    { actionChange: 'YES' },
  ];
  for (const extra of forbiddenExtras) {
    assert.throws(
      () => recordQuestionDisposition(session, state, { attemptId: attempt.attemptId, disposition: 'STILL_OPEN', reason: 'x', ...extra }),
      /unexpected field/,
      `expected extra field ${JSON.stringify(Object.keys(extra))} to be rejected`
    );
  }
});

check('rejected disposition input never mutates the ledger', () => {
  const { session, state, attempt } = buildFailedCycleFixture('COVERAGE_GAP');
  const before = JSON.parse(JSON.stringify(state));
  try {
    recordQuestionDisposition(session, state, { attemptId: attempt.attemptId, disposition: 'RESOLVED', reason: 'x', extra: true });
  } catch {
    // expected
  }
  assert.deepEqual(state, before);
});

// --- R4. Duplicate disposition -------------------------------------------

check('a second disposition for the same RouteOutcome is rejected, including STILL_OPEN then RESOLVED', () => {
  const { session, state, attempt } = buildFailedCycleFixture('COVERAGE_GAP');
  const next = recordQuestionDisposition(session, state, { attemptId: attempt.attemptId, disposition: 'STILL_OPEN', reason: 'first' });
  assert.throws(
    () => recordQuestionDisposition(session, next, { attemptId: attempt.attemptId, disposition: 'RESOLVED', reason: 'second' }),
    /already has a QuestionDisposition/
  );
  assert.equal(next.questionDispositions.length, 1);
});

// --- R5. Currentness -------------------------------------------------------

check('a registered question with no disposition, or only STILL_OPEN, is current; RESOLVED makes it non-current', () => {
  const { session: s1, state: st1, question: q1 } = buildFailedCycleFixture('COVERAGE_GAP');
  assert.equal(isQuestionCurrent(st1, q1.id), true);

  const { session: s2, state: st2, question: q2, attempt: a2 } = buildFailedCycleFixture('COVERAGE_GAP');
  const afterStillOpen = recordQuestionDisposition(s2, st2, { attemptId: a2.attemptId, disposition: 'STILL_OPEN', reason: 'x' });
  assert.equal(isQuestionCurrent(afterStillOpen, q2.id), true);

  const { session: s3, state: st3, question: q3, attempt: a3 } = buildFailedCycleFixture('COVERAGE_GAP');
  const afterResolved = recordQuestionDisposition(s3, st3, { attemptId: a3.attemptId, disposition: 'RESOLVED', reason: 'x' });
  assert.equal(isQuestionCurrent(afterResolved, q3.id), false);
});

check('an unknown questionId fails closed across the current-gated APIs (registration is checked before currentness everywhere)', () => {
  const { session, issueId } = buildFixtureWithIssue();
  const deliberationState = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  assert.throws(
    () =>
      planRouteForQuestion(session, deliberationState, {
        id: 'never-registered',
        rootCause: 'COVERAGE_GAP',
        materialityReason: 'x',
        inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
        createdAt: new Date().toISOString(),
      }),
    /is not a currently registered unresolved question/
  );
});

check('a question stays physically registered in unresolvedQuestions after RESOLVED', () => {
  const { session, state, question, attempt } = buildFailedCycleFixture('COVERAGE_GAP');
  const next = recordQuestionDisposition(session, state, { attemptId: attempt.attemptId, disposition: 'RESOLVED', reason: 'x' });
  assert.ok(next.unresolvedQuestions.some((q) => q.id === question.id));
});

// --- R6/R7. Active-cycle stages & second-cycle block ------------------------

/** Builds a structurally valid, would-be "second RouteDecision" payload for the same registered question, for rejection testing at recordRouteDecision itself (never actually plannable through the real planRouteForQuestion, which rejects it first). */
function planRouteForQuestionSafely(session, state, question) {
  return {
    id: `manual-second-decision-${Math.random().toString(36).slice(2)}`,
    route: routeForRootCause(question.rootCause),
    reason: { rootCause: question.rootCause, materialityReason: question.materialityReason },
    inputRefs: question.inputRefs,
    questionId: question.id,
    createdAt: new Date().toISOString(),
  };
}

check('recordRouteDecision rejects a manually constructed second active decision at every unfinished stage; succeeds again only after STILL_OPEN', () => {
  // Stage A: decision-only.
  {
    const { session, state, question } = buildRecordedDecisionFixture('COVERAGE_GAP');
    const second = planRouteForQuestionSafely(session, state, question);
    assert.throws(() => recordRouteDecision(session, state, second), /already has an active deliberation cycle/);
    assert.throws(() => planRouteForQuestion(session, state, question), /already has an active deliberation cycle/);
  }
  // Stage B: attempt-open.
  {
    const { session, state, question } = buildStartedAttemptFixture('COVERAGE_GAP');
    const second = planRouteForQuestionSafely(session, state, question);
    assert.throws(() => recordRouteDecision(session, state, second), /already has an active deliberation cycle/);
    assert.throws(() => planRouteForQuestion(session, state, question), /already has an active deliberation cycle/);
  }
  // Stage C: outcome recorded, undisposed.
  {
    const { session, state, question } = buildFailedCycleFixture('COVERAGE_GAP');
    const second = planRouteForQuestionSafely(session, state, question);
    assert.throws(() => recordRouteDecision(session, state, second), /already has an active deliberation cycle/);
    assert.throws(() => planRouteForQuestion(session, state, question), /already has an active deliberation cycle/);
  }
  // After STILL_OPEN: a fresh cycle may begin.
  {
    const { session, state, question, attempt } = buildFailedCycleFixture('COVERAGE_GAP');
    const afterStillOpen = recordQuestionDisposition(session, state, { attemptId: attempt.attemptId, disposition: 'STILL_OPEN', reason: 'x' });
    const secondDecisionPlan = planRouteForQuestion(session, afterStillOpen, question);
    assert.equal(secondDecisionPlan.questionId, question.id);
    const recorded = recordRouteDecision(session, afterStillOpen, secondDecisionPlan);
    assert.equal(recorded.history.length, 2);
    assert.notEqual(recorded.history[1].id, recorded.history[0].id);
  }
});

// --- R8. Legacy parallel state ---------------------------------------------

check('a legacy fixture with two unfinished decisions for the same question rejects every progression, with no reconciliation or deletion', () => {
  const { session, state: state0, question } = buildRecordedDecisionFixture('COVERAGE_GAP');
  const d1 = state0.history[0];
  const d2 = planRouteForQuestionSafely(session, state0, question);
  // Intentionally corrupt: inject a second active decision directly into
  // history, bypassing recordRouteDecision's own gate -- the only way to
  // construct this legacy-inconsistent state for testing, per the packet's
  // own exception for corruption tests.
  const corrupted = { ...state0, history: [...state0.history, d2] };

  assert.throws(() => planRouteForQuestion(session, corrupted, question), /more than one active deliberation cycle/);
  assert.throws(() => recordRouteAttemptStart(session, corrupted, d1.id), /more than one active deliberation cycle/);
  assert.throws(() => recordRouteAttemptStart(session, corrupted, d2.id), /more than one active deliberation cycle/);

  // Advance d1 through to a recorded RouteOutcome inside the corrupted state.
  const started = recordRouteAttemptStart(session, { ...corrupted, history: [d1] }, d1.id);
  const withBothDecisions = { ...started, history: [...started.history, d2] };
  const attempt1 = withBothDecisions.attempts[0];
  assert.throws(
    () => recordRouteOutcome(session, withBothDecisions, { attemptId: attempt1.attemptId, status: 'FAILED', latencyConsumed: 1, failure: VALID_FAILURE_FOR_DISPOSITION }),
    /more than one active deliberation cycle/
  );

  // Fully corrupted state (both decisions recorded, no attempts yet) leaves history untouched by every rejection above.
  assert.deepEqual(corrupted.history.map((d) => d.id).sort(), [d1.id, d2.id].sort());
});

// --- R10. RouteDecision identity -------------------------------------------

check('recordRouteDecision rejects an empty, whitespace-only, null, or missing RouteDecision.id', () => {
  const { session, state } = buildRecordedDecisionFixture('COVERAGE_GAP');
  for (const id of ['', '   ', null, undefined]) {
    const manual = { id, route: 'STOP', reason: { rootCause: 'NONE', materialityReason: 'x' }, inputRefs: [], questionId: null, createdAt: new Date().toISOString() };
    assert.throws(
      () => recordRouteDecision(session, state, manual, { stopReason: 'successful' }),
      /must be a non-empty string/,
      `expected id ${JSON.stringify(id)} to be rejected`
    );
  }
});

check('recordRouteDecision rejects a duplicate RouteDecision.id, whether non-STOP->non-STOP or non-STOP->STOP; history unchanged after rejection', () => {
  const { session, state, question } = buildRecordedDecisionFixture('COVERAGE_GAP');
  const existingId = state.history[0].id;
  const before = JSON.parse(JSON.stringify(state));

  const duplicateNonStop = planRouteForQuestionSafely(session, state, question);
  duplicateNonStop.id = existingId;
  assert.throws(() => recordRouteDecision(session, state, duplicateNonStop), /is already recorded in history/);

  const duplicateStop = { id: existingId, route: 'STOP', reason: { rootCause: 'NONE', materialityReason: 'x' }, inputRefs: [], questionId: null, createdAt: new Date().toISOString() };
  assert.throws(() => recordRouteDecision(session, state, duplicateStop, { stopReason: 'successful' }), /is already recorded in history/);

  assert.deepEqual(state, before);
});

check('STOP still records with a unique id even while another question has an active cycle', () => {
  const { session, state, question } = buildRecordedDecisionFixture('COVERAGE_GAP');
  const stopDecision = planRouteForQuestion(session, state, { id: 'stop-q', rootCause: 'NONE', materialityReason: 'x', inputRefs: [], createdAt: new Date().toISOString() });
  const stopped = recordRouteDecision(session, state, stopDecision, { stopReason: 'successful' });
  assert.equal(stopped.stopReason, 'successful');
  assert.ok(isQuestionCurrent(stopped, question.id));
});

// --- R11. Legacy duplicate decision id -------------------------------------

check('a legacy history with two entries sharing one RouteDecision.id fails closed on downstream resolution, not first-match', () => {
  const { session, state: state0 } = buildRecordedDecisionFixture('COVERAGE_GAP');
  const original = state0.history[0];
  const duplicateEntry = { ...original, createdAt: new Date(Date.now() + 1000).toISOString() };
  const corrupted = { ...state0, history: [original, duplicateEntry] };

  const before = { costBudget: { ...corrupted.costBudget }, latencyBudget: { ...corrupted.latencyBudget } };
  assert.throws(() => recordRouteAttemptStart(session, corrupted, original.id), /matches more than one recorded RouteDecision/);
  assert.deepEqual(corrupted.costBudget, before.costBudget);
  assert.deepEqual(corrupted.latencyBudget, before.latencyBudget);
});

// --- R12. Current gates after RESOLVED --------------------------------------

check('after RESOLVED, every current-gated API rejects: planRouteForQuestion, recordRouteDecision, recordRouteAttemptStart, recordRouteOutcome, createContextRequest, recordQuestionDisposition', () => {
  const { session, state, question, attempt } = buildFailedCycleFixture('CONTEXT_GAP');
  const resolved = recordQuestionDisposition(session, state, { attemptId: attempt.attemptId, disposition: 'RESOLVED', reason: 'x' });

  assert.throws(() => planRouteForQuestion(session, resolved, question), /is not current/);

  const manualDecision = planRouteForQuestionSafely(session, resolved, question);
  assert.throws(() => recordRouteDecision(session, resolved, manualDecision), /is not current/);

  // recordRouteAttemptStart's own currentness rejection is only reachable
  // for a decision that does not yet have an attempt (the real D1 already
  // does) -- inject a legacy second decision, never recordable through the
  // real API once the question is resolved, to exercise it specifically.
  const legacyD2 = planRouteForQuestionSafely(session, resolved, question);
  const withLegacyD2 = { ...resolved, history: [...resolved.history, legacyD2] };
  assert.throws(() => recordRouteAttemptStart(session, withLegacyD2, legacyD2.id), /is not current/);

  assert.throws(
    () => recordRouteOutcome(session, resolved, { attemptId: attempt.attemptId, status: 'FAILED', latencyConsumed: 1, failure: VALID_FAILURE_FOR_DISPOSITION }),
    /already has a RouteOutcome/
  );

  assert.throws(
    () => createContextRequest(session, resolved, { attemptId: attempt.attemptId, category: 'constraints', question: 'x?', inferenceReason: 'x' }),
    /is not current/
  );

  assert.throws(
    () => recordQuestionDisposition(session, resolved, { attemptId: attempt.attemptId, disposition: 'STILL_OPEN', reason: 'x' }),
    /already has a QuestionDisposition/
  );
});

check('after RESOLVED, recordRouteOutcome against a *stale* still-open attempt on the same question rejects on currentness, not just duplication', () => {
  // Build a question with TWO historical attempts (legacy-style corruption),
  // resolve the first, then prove the second (still technically open) can
  // never record its own outcome once the question is RESOLVED.
  const { session, state: recordedState, question } = buildRecordedDecisionFixture('COVERAGE_GAP');
  const d1 = recordedState.history[0];
  const startedA = recordRouteAttemptStart(session, recordedState, d1.id);
  const attemptA = startedA.attempts[0];
  const resolvedViaA = recordRouteOutcome(session, startedA, { attemptId: attemptA.attemptId, status: 'FAILED', latencyConsumed: 1, failure: VALID_FAILURE_FOR_DISPOSITION });
  const disposedViaA = recordQuestionDisposition(session, resolvedViaA, { attemptId: attemptA.attemptId, disposition: 'RESOLVED', reason: 'x' });

  // A second, legacy decision/attempt for the same question, injected directly
  // (never possible through the now-hardened public API, hence direct injection).
  const d2 = planRouteForQuestionSafely(session, recordedState, question);
  const attemptB = { attemptId: 'legacy-attempt-b', decisionId: d2.id, questionId: question.id, route: d2.route, sessionId: session.id, artifactHash: session.artifactHash, authorContextHash: session.authorContextHash, startedAt: new Date().toISOString(), logicalCost: 1 };
  const legacyState = { ...disposedViaA, history: [...disposedViaA.history, d2], attempts: [...disposedViaA.attempts, attemptB] };

  assert.throws(
    () => recordRouteOutcome(session, legacyState, { attemptId: attemptB.attemptId, status: 'FAILED', latencyConsumed: 1, failure: VALID_FAILURE_FOR_DISPOSITION }),
    /is not current/
  );
  assert.ok(legacyState.attempts.some((a) => a.attemptId === attemptB.attemptId), 'the stale attempt remains present, never deleted');
});

// --- R13. STILL_OPEN re-entry, including wrong-cycle rejection on the old decision ---

check('after STILL_OPEN, Q1 remains current, a fresh D2/A2 cycle can start, and the old D1 can no longer start a new attempt', () => {
  const { session, state, question, attempt: attempt1 } = buildFailedCycleFixture('COVERAGE_GAP');
  const d1 = state.history[0];
  const afterStillOpen = recordQuestionDisposition(session, state, { attemptId: attempt1.attemptId, disposition: 'STILL_OPEN', reason: 'x' });
  assert.equal(isQuestionCurrent(afterStillOpen, question.id), true);

  const d2Plan = planRouteForQuestion(session, afterStillOpen, question);
  const withD2 = recordRouteDecision(session, afterStillOpen, d2Plan);
  assert.notEqual(d2Plan.id, d1.id);

  const startedA2 = recordRouteAttemptStart(session, withD2, d2Plan.id);
  assert.equal(startedA2.attempts.length, 2, 'the original attempt from the first cycle plus the new one for D2');
  assert.ok(startedA2.attempts.some((a) => a.decisionId === d2Plan.id));

  // The old, now-inactive D1 can never start a new attempt again.
  assert.throws(() => recordRouteAttemptStart(session, withD2, d1.id), /already has a RouteAttempt/);
});

// --- R14/R15/R16. STOP at each unfinished stage -----------------------------

check('STOP is recordable with a decision-only unfinished cycle; the old decision may never start an attempt afterward', () => {
  const { session, state, question } = buildRecordedDecisionFixture('COVERAGE_GAP');
  const d1 = state.history[0];
  const stopDecision = planRouteForQuestion(session, state, { id: 'stop-q', rootCause: 'NONE', materialityReason: 'x', inputRefs: [], createdAt: new Date().toISOString() });
  const stopped = recordRouteDecision(session, state, stopDecision, { stopReason: 'successful' });
  assert.equal(stopped.stopReason, 'successful');
  assert.throws(() => recordRouteAttemptStart(session, stopped, d1.id), /already stopped/);
  assert.equal(stopped.attempts.length, 0, 'no attempt fabricated');
});

check('STOP is recordable with an open RouteAttempt; the attempt may never record a RouteOutcome afterward', () => {
  const { session, state } = buildStartedAttemptFixture('COVERAGE_GAP');
  const attempt = state.attempts[0];
  const stopDecision = planRouteForQuestion(session, state, { id: 'stop-q', rootCause: 'NONE', materialityReason: 'x', inputRefs: [], createdAt: new Date().toISOString() });
  const stopped = recordRouteDecision(session, state, stopDecision, { stopReason: 'budget' });
  assert.equal(stopped.stopReason, 'budget');
  assert.throws(
    () => recordRouteOutcome(session, stopped, { attemptId: attempt.attemptId, status: 'FAILED', latencyConsumed: 1, failure: VALID_FAILURE_FOR_DISPOSITION }),
    /already stopped/
  );
  assert.ok(stopped.attempts.some((a) => a.attemptId === attempt.attemptId), 'the open attempt remains present');
  assert.equal(stopped.outcomes.length, 0, 'no outcome fabricated');
});

check('STOP is recordable with a terminal RouteOutcome pending disposition; the disposition may never be recorded afterward; the question remains current', () => {
  const { session, state, question, attempt } = buildFailedCycleFixture('COVERAGE_GAP');
  const stopDecision = planRouteForQuestion(session, state, { id: 'stop-q', rootCause: 'NONE', materialityReason: 'x', inputRefs: [], createdAt: new Date().toISOString() });
  const stopped = recordRouteDecision(session, state, stopDecision, { stopReason: 'latency' });
  assert.equal(stopped.stopReason, 'latency');
  assert.throws(
    () => recordQuestionDisposition(session, stopped, { attemptId: attempt.attemptId, disposition: 'STILL_OPEN', reason: 'x' }),
    /already stopped/
  );
  assert.deepEqual(stopped.questionDispositions, []);
  assert.equal(isQuestionCurrent(stopped, question.id), true, 'Q1 remains current -- STOP never fabricates a disposition');
});

// --- R17. STOP with legacy parallel cycles -----------------------------------

check('STOP remains recordable even with more than one unfinished legacy cycle for the same question; no progression follows', () => {
  const { session, state: state0, question } = buildRecordedDecisionFixture('COVERAGE_GAP');
  const d1 = state0.history[0];
  const d2 = planRouteForQuestionSafely(session, state0, question);
  const corrupted = { ...state0, history: [...state0.history, d2] };

  const stopDecision = planRouteForQuestion(session, corrupted, { id: 'stop-q', rootCause: 'NONE', materialityReason: 'x', inputRefs: [], createdAt: new Date().toISOString() });
  const stopped = recordRouteDecision(session, corrupted, stopDecision, { stopReason: 'unresolved_but_human_decidable' });
  assert.equal(stopped.stopReason, 'unresolved_but_human_decidable');

  assert.throws(() => recordRouteAttemptStart(session, stopped, d1.id), /already stopped/);
  assert.throws(() => recordRouteAttemptStart(session, stopped, d2.id), /already stopped/);
});

// --- R18. No automatic disposition inference ---------------------------------

check('SUCCEEDED, FAILED, and STOP never automatically create a QuestionDisposition -- only recordQuestionDisposition does', () => {
  const failed = buildFailedCycleFixture('COVERAGE_GAP');
  assert.deepEqual(failed.state.questionDispositions, []);

  const succeeded = buildAddReviewerSuccessCycleFixture('run-no-infer');
  assert.deepEqual(succeeded.state.questionDispositions, []);

  const { session, state, question } = buildRecordedDecisionFixture('COVERAGE_GAP');
  const stopDecision = planRouteForQuestion(session, state, { id: 'stop-q', rootCause: 'NONE', materialityReason: 'x', inputRefs: [], createdAt: new Date().toISOString() });
  const stopped = recordRouteDecision(session, state, stopDecision, { stopReason: 'successful' });
  assert.deepEqual(stopped.questionDispositions, []);
});

// --- R19. Snapshot / authority -------------------------------------------------

check('recording a disposition leaves the original session and state unchanged; returns a new object; mutating caller reason does not rewrite history', () => {
  const { session, state, attempt } = buildFailedCycleFixture('COVERAGE_GAP');
  const sessionBefore = JSON.parse(JSON.stringify(session));
  const stateBefore = JSON.parse(JSON.stringify(state));
  const input = { attemptId: attempt.attemptId, disposition: 'STILL_OPEN', reason: 'original reason' };

  const next = recordQuestionDisposition(session, state, input);

  input.reason = 'mutated after recording';
  input.disposition = 'RESOLVED';

  assert.notEqual(next, state);
  assert.deepEqual(session, sessionBefore);
  assert.deepEqual(state, stateBefore);
  assert.equal(next.questionDispositions[0].reason, 'original reason');
  assert.equal(next.questionDispositions[0].disposition, 'STILL_OPEN');
  assert.deepEqual(session.adjudications, {});
  assert.deepEqual(session.revisionActions, {});
  assert.deepEqual(next.history, state.history);
  assert.deepEqual(next.attempts, state.attempts);
  assert.deepEqual(next.outcomes, state.outcomes);
});

// --- Slice 2D-B2-A amendment: global identity & read integrity ---------------

check('active-cycle derivation rejects a RouteDecision id duplicated across different questions', () => {
  const { session, state, firstQuestion, firstDecision, secondDecision } = buildTwoQuestionDecisionFixture();
  const corrupted = {
    ...state,
    history: state.history.map((decision) =>
      decision.id === secondDecision.id ? { ...decision, id: firstDecision.id } : decision
    ),
  };

  assert.throws(
    () => planRouteForQuestion(session, corrupted, firstQuestion),
    /matches more than one recorded RouteDecision/
  );
});

check('a cross-question duplicate id cannot make another question\'s attempt belong to the target question', () => {
  const { session, state, firstQuestion, firstDecision, secondDecision } = buildTwoQuestionDecisionFixture();
  const started = recordRouteAttemptStart(session, state, secondDecision.id);
  const secondAttempt = started.attempts.find((attempt) => attempt.decisionId === secondDecision.id);
  const corrupted = {
    ...started,
    history: started.history.map((decision) =>
      decision.id === secondDecision.id ? { ...decision, id: firstDecision.id } : decision
    ),
    attempts: started.attempts.map((attempt) =>
      attempt.attemptId === secondAttempt.attemptId ? { ...attempt, decisionId: firstDecision.id } : attempt
    ),
  };

  const before = JSON.parse(JSON.stringify(corrupted));
  assert.throws(
    () => planRouteForQuestion(session, corrupted, firstQuestion),
    /matches more than one recorded RouteDecision/
  );
  assert.deepEqual(corrupted, before);
});

check('duplicate global decision identity rejects attempt start and outcome recording without spend or append', () => {
  const first = buildTwoQuestionDecisionFixture();
  const duplicateHistory = first.state.history.map((decision) =>
    decision.id === first.secondDecision.id ? { ...decision, id: first.firstDecision.id } : decision
  );
  const beforeStart = {
    ...first.state,
    history: duplicateHistory,
  };
  const beforeStartSnapshot = JSON.parse(JSON.stringify(beforeStart));

  assert.throws(
    () => recordRouteAttemptStart(first.session, beforeStart, first.firstDecision.id),
    /matches more than one recorded RouteDecision/
  );
  assert.deepEqual(beforeStart, beforeStartSnapshot);

  const started = recordRouteAttemptStart(first.session, first.state, first.secondDecision.id);
  const attempt = started.attempts.find((entry) => entry.decisionId === first.secondDecision.id);
  const beforeOutcome = {
    ...started,
    history: duplicateHistory,
    attempts: started.attempts.map((entry) =>
      entry.attemptId === attempt.attemptId ? { ...entry, decisionId: first.firstDecision.id } : entry
    ),
  };
  const beforeOutcomeSnapshot = JSON.parse(JSON.stringify(beforeOutcome));

  assert.throws(
    () => recordRouteOutcome(first.session, beforeOutcome, {
      attemptId: attempt.attemptId,
      status: 'FAILED',
      latencyConsumed: 1,
      failure: VALID_FAILURE_FOR_DISPOSITION,
    }),
    /matches more than one recorded RouteDecision/
  );
  assert.deepEqual(beforeOutcome, beforeOutcomeSnapshot);
});

check('duplicate global decision identity rejects disposition recording through the full audit chain', () => {
  const fixture = buildTwoQuestionDecisionFixture();
  const started = recordRouteAttemptStart(fixture.session, fixture.state, fixture.secondDecision.id);
  const attempt = started.attempts.find((entry) => entry.decisionId === fixture.secondDecision.id);
  const withOutcome = recordRouteOutcome(fixture.session, started, {
    attemptId: attempt.attemptId,
    status: 'FAILED',
    latencyConsumed: 1,
    failure: VALID_FAILURE_FOR_DISPOSITION,
  });
  const corrupted = {
    ...withOutcome,
    history: withOutcome.history.map((decision) =>
      decision.id === fixture.secondDecision.id ? { ...decision, id: fixture.firstDecision.id } : decision
    ),
    attempts: withOutcome.attempts.map((entry) =>
      entry.attemptId === attempt.attemptId ? { ...entry, decisionId: fixture.firstDecision.id } : entry
    ),
    outcomes: withOutcome.outcomes.map((outcome) =>
      outcome.attemptId === attempt.attemptId ? { ...outcome, decisionId: fixture.firstDecision.id } : outcome
    ),
  };
  const before = JSON.parse(JSON.stringify(corrupted));

  assert.throws(
    () => recordQuestionDisposition(fixture.session, corrupted, {
      attemptId: attempt.attemptId,
      disposition: 'STILL_OPEN',
      reason: 'must not resolve an ambiguous decision identity',
    }),
    /matches more than one recorded RouteDecision/
  );
  assert.deepEqual(corrupted, before);
});

check('isQuestionCurrent rejects duplicate STILL_OPEN dispositions for one outcome', () => {
  const { session, state, question, attempt } = buildFailedCycleFixture('COVERAGE_GAP');
  const disposed = recordQuestionDisposition(session, state, {
    attemptId: attempt.attemptId,
    disposition: 'STILL_OPEN',
    reason: 'first disposition',
  });
  const original = disposed.questionDispositions[0];
  const corrupted = {
    ...disposed,
    questionDispositions: [original, { ...original, reason: 'duplicate disposition' }],
  };

  assert.throws(
    () => isQuestionCurrent(corrupted, question.id),
    /has more than one QuestionDisposition/
  );
});

check('isQuestionCurrent rejects conflicting STILL_OPEN and RESOLVED dispositions for one outcome', () => {
  const { session, state, question, attempt } = buildFailedCycleFixture('COVERAGE_GAP');
  const disposed = recordQuestionDisposition(session, state, {
    attemptId: attempt.attemptId,
    disposition: 'STILL_OPEN',
    reason: 'first disposition',
  });
  const original = disposed.questionDispositions[0];
  const corrupted = {
    ...disposed,
    questionDispositions: [original, { ...original, disposition: 'RESOLVED', reason: 'conflicting disposition' }],
  };

  assert.throws(
    () => isQuestionCurrent(corrupted, question.id),
    /has more than one QuestionDisposition/
  );
});

check('current-gated planning shares duplicate-disposition ledger integrity with isQuestionCurrent', () => {
  const { session, state, question, attempt } = buildFailedCycleFixture('COVERAGE_GAP');
  const disposed = recordQuestionDisposition(session, state, {
    attemptId: attempt.attemptId,
    disposition: 'STILL_OPEN',
    reason: 'first disposition',
  });
  const original = disposed.questionDispositions[0];
  const corrupted = {
    ...disposed,
    questionDispositions: [original, { ...original, reason: 'duplicate disposition' }],
  };

  assert.throws(
    () => planRouteForQuestion(session, corrupted, question),
    /has more than one QuestionDisposition/
  );
});

check('two dispositions for one question remain valid when they belong to different attempts', () => {
  const { session, state, question, attempt: firstAttempt } = buildFailedCycleFixture('COVERAGE_GAP');
  let next = recordQuestionDisposition(session, state, {
    attemptId: firstAttempt.attemptId,
    disposition: 'STILL_OPEN',
    reason: 'first cycle remains open',
  });
  const secondDecision = planRouteForQuestion(session, next, question);
  next = recordRouteDecision(session, next, secondDecision);
  next = recordRouteAttemptStart(session, next, secondDecision.id);
  const secondAttempt = next.attempts.find((attempt) => attempt.decisionId === secondDecision.id);
  next = recordRouteOutcome(session, next, {
    attemptId: secondAttempt.attemptId,
    status: 'FAILED',
    latencyConsumed: 1,
    failure: VALID_FAILURE_FOR_DISPOSITION,
  });
  next = recordQuestionDisposition(session, next, {
    attemptId: secondAttempt.attemptId,
    disposition: 'RESOLVED',
    reason: 'second cycle resolved the question',
  });

  assert.equal(next.questionDispositions.length, 2);
  assert.notEqual(next.questionDispositions[0].attemptId, next.questionDispositions[1].attemptId);
  assert.equal(isQuestionCurrent(next, question.id), false);
});

// ==================================================================
// S. SUPERSEDED_RECLASSIFIED / derived question lineage (Slice 2D-B2-B)
// ==================================================================
console.log('\nSUPERSEDED_RECLASSIFIED / derived question lineage (Slice 2D-B2-B)');

/** Convenience: a valid, independently-constructed replacement question (Q2) for `cycle.question` (Q1), via the real createUnresolvedQuestion factory. */
function buildReplacementFor(cycle, overrides = {}) {
  return createUnresolvedQuestion(cycle.session, {
    rootCause: 'DECISION_SENSITIVE_CONFLICT',
    materialityReason: 'reclassified: two interpretations now materially conflict',
    inputRefs: cycle.question.inputRefs.map((ref) => ({ ...ref })),
    derivedFromQuestionId: cycle.question.id,
    ...overrides,
  });
}

// --- S1. Global duplicate question-id (packet §34) -------------------------

check('a duplicate UnresolvedQuestion.id anywhere fails closed, even with no derived lineage involved', () => {
  const { session, state, question } = buildRecordedDecisionFixture('COVERAGE_GAP');
  const duplicate = { ...question };
  const corrupted = { ...state, unresolvedQuestions: [...state.unresolvedQuestions, duplicate] };
  assert.throws(() => isQuestionCurrent(corrupted, question.id), /duplicate UnresolvedQuestion\.id/);
  assert.throws(
    () => planRouteForQuestion(session, corrupted, question),
    /duplicate UnresolvedQuestion\.id|is not current/
  );
});

// --- S2. SUPERSEDED positive test (packet §35) ------------------------------

check('SUPERSEDED_RECLASSIFIED atomically registers Q2 and terminally disposes Q1', () => {
  const cycle = buildFailedCycleFixture('COVERAGE_GAP');
  const { session, state, question, attempt } = cycle;
  const replacementQuestion = buildReplacementFor(cycle);
  const next = recordQuestionDisposition(session, state, {
    attemptId: attempt.attemptId,
    disposition: 'SUPERSEDED_RECLASSIFIED',
    reason: 'the real deficit is a decision conflict, not a coverage gap',
    replacementQuestion,
  });

  assert.equal(next.questionDispositions.length, 1);
  assert.equal(next.unresolvedQuestions.length, 2);
  const stored = next.questionDispositions[0];
  assert.equal(stored.disposition, 'SUPERSEDED_RECLASSIFIED');
  assert.equal(stored.questionId, question.id);
  assert.equal('replacementQuestionId' in stored, false);
  assert.equal('replacementQuestion' in stored, false);

  assert.ok(next.unresolvedQuestions.some((q) => q.id === question.id));
  assert.equal(isQuestionCurrent(next, question.id), false);

  const storedQ2 = next.unresolvedQuestions.find((q) => q.id === replacementQuestion.id);
  assert.ok(storedQ2);
  assert.equal(storedQ2.derivedFromQuestionId, question.id);
  assert.equal(isQuestionCurrent(next, storedQ2.id), true);
});

// --- S3. SUPERSEDED after FAILED / SUCCEEDED (packet §36) ------------------

check('SUPERSEDED_RECLASSIFIED is recordable after a FAILED, a successful ADD_REVIEWER, and a successful REPLICATE outcome', () => {
  const cycles = [
    buildFailedCycleFixture('COVERAGE_GAP'),
    buildAddReviewerSuccessCycleFixture('reviewer-run-supersede'),
    buildReplicateSuccessCycleFixture('REPRODUCED'),
  ];
  for (const cycle of cycles) {
    const { session, state, question, attempt } = cycle;
    const replacementQuestion = buildReplacementFor(cycle);
    const next = recordQuestionDisposition(session, state, {
      attemptId: attempt.attemptId,
      disposition: 'SUPERSEDED_RECLASSIFIED',
      reason: 'independent re-evaluation reclassified the deficit',
      replacementQuestion,
    });
    assert.equal(isQuestionCurrent(next, question.id), false);
    assert.equal(isQuestionCurrent(next, replacementQuestion.id), true);
  }
});

// --- S4. Invalid replacement tests (packet §37) -----------------------------

check('an invalid replacementQuestion is rejected in every case, with no partial write', () => {
  const cycle = buildFailedCycleFixture('COVERAGE_GAP');
  const { session, state: state0, question, attempt } = cycle;
  const extra = buildRegisteredQuestion(session, state0, {
    rootCause: 'STABILITY_QUESTION',
    materialityReason: 'an unrelated already-registered question',
    inputRefs: question.inputRefs.map((ref) => ({ ...ref })),
  });
  const state = extra.state;
  const otherRegisteredId = extra.question.id;
  const valid = buildReplacementFor({ ...cycle, state });

  const missingLineage = { ...valid };
  delete missingLineage.derivedFromQuestionId;

  const invalidCases = [
    ['null replacement', null],
    ['non-object replacement', 'not-an-object'],
    ['blank id', { ...valid, id: '' }],
    ['same id as Q1', { ...valid, id: question.id }],
    ['duplicate registered id', { ...valid, id: otherRegisteredId }],
    ['rootCause NONE', { ...valid, rootCause: 'NONE' }],
    ['invalid rootCause', { ...valid, rootCause: 'NOT_A_ROOT_CAUSE' }],
    ['blank materialityReason', { ...valid, materialityReason: '   ' }],
    ['empty inputRefs', { ...valid, inputRefs: [] }],
    ['invalid ref', { ...valid, inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: 'no-such-issue' }] }],
    ['malformed createdAt', { ...valid, createdAt: 'not-a-date' }],
    ['derivedFromQuestionId null', { ...valid, derivedFromQuestionId: null }],
    ['derivedFromQuestionId missing', missingLineage],
    ['derivedFromQuestionId wrong parent', { ...valid, derivedFromQuestionId: otherRegisteredId }],
    ['derivedFromQuestionId blank', { ...valid, derivedFromQuestionId: '   ' }],
  ];

  for (const [label, replacementQuestion] of invalidCases) {
    assert.throws(
      () =>
        recordQuestionDisposition(session, state, {
          attemptId: attempt.attemptId,
          disposition: 'SUPERSEDED_RECLASSIFIED',
          reason: 'x',
          replacementQuestion,
        }),
      `expected case "${label}" to be rejected`
    );
  }
  assert.equal(state.unresolvedQuestions.length, 2);
  assert.equal(state.questionDispositions.length, 0);
});

// --- S5. Input shape tests (packet §38) -------------------------------------

check('SUPERSEDED_RECLASSIFIED input rejects a missing replacementQuestion and every forbidden extra key', () => {
  const { session, state, attempt } = buildFailedCycleFixture('COVERAGE_GAP');
  assert.throws(
    () => recordQuestionDisposition(session, state, { attemptId: attempt.attemptId, disposition: 'SUPERSEDED_RECLASSIFIED', reason: 'x' }),
    /requires replacementQuestion/
  );

  const validReplacement = {
    id: 'input-shape-q2',
    rootCause: 'DECISION_SENSITIVE_CONFLICT',
    materialityReason: 'x',
    inputRefs: [],
    createdAt: new Date().toISOString(),
    derivedFromQuestionId: null,
  };
  const forbiddenExtras = [
    { replacementQuestionId: 'x' },
    { newQuestionId: 'x' },
    { parentId: 'x' },
    { lineage: {} },
    { newSessionId: 'x' },
    { actionChange: 'YES' },
    { arbitraryField: 1 },
  ];
  for (const extra of forbiddenExtras) {
    assert.throws(
      () =>
        recordQuestionDisposition(session, state, {
          attemptId: attempt.attemptId,
          disposition: 'SUPERSEDED_RECLASSIFIED',
          reason: 'x',
          replacementQuestion: validReplacement,
          ...extra,
        }),
      /unexpected field/,
      `expected extra field ${JSON.stringify(Object.keys(extra))} to be rejected`
    );
  }
  // A top-level derivedFromQuestionId (as opposed to one nested inside
  // replacementQuestion, which is required) is equally forbidden.
  assert.throws(
    () =>
      recordQuestionDisposition(session, state, {
        attemptId: attempt.attemptId,
        disposition: 'SUPERSEDED_RECLASSIFIED',
        reason: 'x',
        replacementQuestion: validReplacement,
        derivedFromQuestionId: 'x',
      }),
    /unexpected field/
  );
});

check('STILL_OPEN/RESOLVED input still rejects a replacementQuestion field (unchanged from Slice 2D-B2-A)', () => {
  const { session, state, attempt } = buildFailedCycleFixture('COVERAGE_GAP');
  for (const disposition of ['STILL_OPEN', 'RESOLVED']) {
    assert.throws(
      () => recordQuestionDisposition(session, state, { attemptId: attempt.attemptId, disposition, reason: 'x', replacementQuestion: { id: 'q2' } }),
      /unexpected field/
    );
  }
});

// --- S6. Ordinary registration tests (packet §39) ---------------------------

check('createUnresolvedQuestion + registerUnresolvedQuestion: omitted/null derivedFromQuestionId succeeds; non-null is rejected on the ordinary path', () => {
  const { session, issueId } = buildFixtureWithIssue();
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });

  const omitted = createUnresolvedQuestion(session, {
    rootCause: 'COVERAGE_GAP',
    materialityReason: 'x',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  assert.equal(omitted.derivedFromQuestionId, null);
  const afterOmitted = registerUnresolvedQuestion(session, state0, omitted);
  assert.equal(afterOmitted.unresolvedQuestions.length, 1);

  const explicitNull = createUnresolvedQuestion(session, {
    rootCause: 'COVERAGE_GAP',
    materialityReason: 'y',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
    derivedFromQuestionId: null,
  });
  assert.equal(explicitNull.derivedFromQuestionId, null);
  const afterExplicitNull = registerUnresolvedQuestion(session, afterOmitted, explicitNull);
  assert.equal(afterExplicitNull.unresolvedQuestions.length, 2);

  const derived = createUnresolvedQuestion(session, {
    rootCause: 'DECISION_SENSITIVE_CONFLICT',
    materialityReason: 'z',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
    derivedFromQuestionId: omitted.id,
  });
  assert.equal(derived.derivedFromQuestionId, omitted.id);
  assert.throws(
    () => registerUnresolvedQuestion(session, afterExplicitNull, derived),
    /atomic SUPERSEDED_RECLASSIFIED transition/
  );
});

check('the atomic SUPERSEDED path succeeds for the same derived question the ordinary path rejects', () => {
  const cycle = buildFailedCycleFixture('COVERAGE_GAP');
  const { session, state, attempt } = cycle;
  const derived = buildReplacementFor(cycle);
  assert.throws(() => registerUnresolvedQuestion(session, state, derived), /atomic SUPERSEDED_RECLASSIFIED transition/);
  const next = recordQuestionDisposition(session, state, {
    attemptId: attempt.attemptId,
    disposition: 'SUPERSEDED_RECLASSIFIED',
    reason: 'x',
    replacementQuestion: derived,
  });
  assert.ok(next.unresolvedQuestions.some((q) => q.id === derived.id));
});

// --- S7. Legacy missing-field compatibility (packet §40) -------------------

check('a legacy question object missing derivedFromQuestionId reads as a valid original, without mutation', () => {
  const { state, question } = buildRecordedDecisionFixture('COVERAGE_GAP');
  const legacyQuestion = { ...question };
  delete legacyQuestion.derivedFromQuestionId;
  const legacyState = {
    ...state,
    unresolvedQuestions: state.unresolvedQuestions.map((q) => (q.id === question.id ? legacyQuestion : q)),
  };
  const before = JSON.parse(JSON.stringify(legacyState));
  assert.equal(isQuestionCurrent(legacyState, question.id), true);
  assert.deepEqual(legacyState, before);
});

// --- S11. Missing-child test (packet §44) -----------------------------------
// (Numbered per the governing packet's own test list; placed here because it
// shares this section's "legacy compatibility never masks broken superseding
// lineage" theme, packet §40's closing requirement.)

check('a SUPERSEDED_RECLASSIFIED disposition with zero registered derived children fails lineage integrity', () => {
  const { session, state, question, attempt } = buildFailedCycleFixture('COVERAGE_GAP');
  const outcome = state.outcomes[0];
  const brokenState = {
    ...state,
    questionDispositions: [
      {
        attemptId: outcome.attemptId,
        questionId: question.id,
        sessionId: state.sessionId,
        artifactHash: state.artifactHash,
        authorContextHash: state.authorContextHash,
        disposition: 'SUPERSEDED_RECLASSIFIED',
        reason: 'legacy superseding with no recorded child',
        createdAt: new Date().toISOString(),
      },
    ],
  };
  assert.throws(() => isQuestionCurrent(brokenState, question.id), /registered direct children/);
});

// --- S8. Orphan test (packet §41) -------------------------------------------

check('a registered question claiming a nonexistent parent (orphan) fails lineage integrity, never silently treated as original', () => {
  const { session, state, question } = buildRecordedDecisionFixture('COVERAGE_GAP');
  const orphan = createUnresolvedQuestion(session, {
    rootCause: 'DECISION_SENSITIVE_CONFLICT',
    materialityReason: 'orphaned derived question',
    inputRefs: question.inputRefs.map((ref) => ({ ...ref })),
    derivedFromQuestionId: 'nonexistent-parent-id',
  });
  const corrupted = { ...state, unresolvedQuestions: [...state.unresolvedQuestions, orphan] };
  assert.throws(() => isQuestionCurrent(corrupted, question.id), /orphan derived question/);
});

// --- S9. Parent-not-superseded test (packet §42) ----------------------------

check('a derived question whose claimed parent has no disposition, or STILL_OPEN, or RESOLVED (never SUPERSEDED) fails lineage integrity', () => {
  for (const dispositionKind of [null, 'STILL_OPEN', 'RESOLVED']) {
    const { session, state, question, attempt } = buildFailedCycleFixture('COVERAGE_GAP');
    const withParentDisposition =
      dispositionKind === null
        ? state
        : recordQuestionDisposition(session, state, { attemptId: attempt.attemptId, disposition: dispositionKind, reason: 'x' });
    const child = createUnresolvedQuestion(session, {
      rootCause: 'DECISION_SENSITIVE_CONFLICT',
      materialityReason: 'claims a parent that was never superseded',
      inputRefs: question.inputRefs.map((ref) => ({ ...ref })),
      derivedFromQuestionId: question.id,
    });
    const corrupted = { ...withParentDisposition, unresolvedQuestions: [...withParentDisposition.unresolvedQuestions, child] };
    assert.throws(
      () => isQuestionCurrent(corrupted, question.id),
      /does not have exactly one terminal SUPERSEDED_RECLASSIFIED disposition/
    );
  }
});

// --- S10. Fork test (packet §43) --------------------------------------------

check('two questions both claiming the same superseded parent is a fork, rejected with no first/latest-child winner', () => {
  const cycle = buildFailedCycleFixture('COVERAGE_GAP');
  const { session, state, question, attempt } = cycle;
  const q2 = buildReplacementFor(cycle);
  const disposed = recordQuestionDisposition(session, state, {
    attemptId: attempt.attemptId,
    disposition: 'SUPERSEDED_RECLASSIFIED',
    reason: 'x',
    replacementQuestion: q2,
  });
  const q3 = createUnresolvedQuestion(session, {
    rootCause: 'DECISION_SENSITIVE_CONFLICT',
    materialityReason: 'a second, forking claimed replacement',
    inputRefs: question.inputRefs.map((ref) => ({ ...ref })),
    derivedFromQuestionId: question.id,
  });
  const forked = { ...disposed, unresolvedQuestions: [...disposed.unresolvedQuestions, q3] };
  assert.throws(() => isQuestionCurrent(forked, question.id), /fork in derived lineage/);
});

// --- S12. Cycle tests (packet §45) ------------------------------------------

check('self-reference, a two-node cycle, and a longer cycle in derived lineage are all rejected, without relying on timestamps', () => {
  {
    const { state, question } = buildRecordedDecisionFixture('COVERAGE_GAP');
    const selfCycled = { ...question, derivedFromQuestionId: question.id };
    const corrupted = {
      ...state,
      unresolvedQuestions: state.unresolvedQuestions.map((q) => (q.id === question.id ? selfCycled : q)),
    };
    assert.throws(() => isQuestionCurrent(corrupted, question.id), /self-referential lineage/);
  }
  {
    const { state, question } = buildRecordedDecisionFixture('COVERAGE_GAP');
    const q1Cycled = { ...question, derivedFromQuestionId: 'cycle-q2' };
    const q2 = { ...question, id: 'cycle-q2', derivedFromQuestionId: question.id };
    const corrupted = { ...state, unresolvedQuestions: [q1Cycled, q2] };
    assert.throws(() => isQuestionCurrent(corrupted, question.id), /derived lineage cycle detected/);
  }
  {
    const { state, question } = buildRecordedDecisionFixture('COVERAGE_GAP');
    const q1Cycled = { ...question, derivedFromQuestionId: 'cycle-q3' };
    const q2 = { ...question, id: 'cycle-q2', derivedFromQuestionId: question.id };
    const q3 = { ...question, id: 'cycle-q3', derivedFromQuestionId: 'cycle-q2' };
    const corrupted = { ...state, unresolvedQuestions: [q1Cycled, q2, q3] };
    assert.throws(() => isQuestionCurrent(corrupted, question.id), /derived lineage cycle detected/);
  }
});

// --- S13. Valid multi-generation test (packet §46) --------------------------

check('a real Q1 -> Q2 -> Q3 lineage chain: Q1 and Q2 non-current, Q3 current, no forks', () => {
  const cycle1 = buildFailedCycleFixture('COVERAGE_GAP');
  const { session, state: state0, question: q1, attempt: attempt1 } = cycle1;
  const q2 = buildReplacementFor(cycle1);
  const state1 = recordQuestionDisposition(session, state0, {
    attemptId: attempt1.attemptId,
    disposition: 'SUPERSEDED_RECLASSIFIED',
    reason: 'Q1 reclassified into Q2',
    replacementQuestion: q2,
  });

  const decision2 = planRouteForQuestion(session, state1, q2);
  const state2 = recordRouteDecision(session, state1, decision2);
  const state3 = recordRouteAttemptStart(session, state2, decision2.id);
  const attempt2 = state3.attempts.find((a) => a.decisionId === decision2.id);
  const state4 = recordRouteOutcome(session, state3, {
    attemptId: attempt2.attemptId,
    status: 'FAILED',
    latencyConsumed: 1,
    failure: VALID_FAILURE_FOR_DISPOSITION,
  });

  const q3 = createUnresolvedQuestion(session, {
    rootCause: 'DECISION_SENSITIVE_CONFLICT',
    materialityReason: 'Q2 further reclassified into Q3',
    inputRefs: q2.inputRefs.map((ref) => ({ ...ref })),
    derivedFromQuestionId: q2.id,
  });
  const state5 = recordQuestionDisposition(session, state4, {
    attemptId: attempt2.attemptId,
    disposition: 'SUPERSEDED_RECLASSIFIED',
    reason: 'Q2 reclassified into Q3',
    replacementQuestion: q3,
  });

  assert.equal(isQuestionCurrent(state5, q1.id), false);
  assert.equal(isQuestionCurrent(state5, q2.id), false);
  assert.equal(isQuestionCurrent(state5, q3.id), true);
  assert.equal(state5.unresolvedQuestions.length, 3);
});

// --- S14. Disposition cardinality (packet §47) ------------------------------

check('the same outcome cannot receive a second disposition of any kind, including SUPERSEDED_RECLASSIFIED', () => {
  for (const firstDisposition of ['STILL_OPEN', 'RESOLVED']) {
    const cycle = buildFailedCycleFixture('COVERAGE_GAP');
    const { session, state, attempt } = cycle;
    const once = recordQuestionDisposition(session, state, { attemptId: attempt.attemptId, disposition: firstDisposition, reason: 'x' });
    const replacementQuestion = buildReplacementFor({ ...cycle, state: once });
    assert.throws(
      () =>
        recordQuestionDisposition(session, once, {
          attemptId: attempt.attemptId,
          disposition: 'SUPERSEDED_RECLASSIFIED',
          reason: 'x',
          replacementQuestion,
        }),
      /already has a QuestionDisposition|is not current/
    );
  }
  {
    const cycle = buildFailedCycleFixture('COVERAGE_GAP');
    const { session, state, attempt } = cycle;
    const q2 = buildReplacementFor(cycle);
    const once = recordQuestionDisposition(session, state, {
      attemptId: attempt.attemptId,
      disposition: 'SUPERSEDED_RECLASSIFIED',
      reason: 'x',
      replacementQuestion: q2,
    });
    const q2b = buildReplacementFor(cycle, { materialityReason: 'a second attempted supersede of the same outcome' });
    assert.throws(
      () =>
        recordQuestionDisposition(session, once, {
          attemptId: attempt.attemptId,
          disposition: 'SUPERSEDED_RECLASSIFIED',
          reason: 'x',
          replacementQuestion: q2b,
        }),
      /already has a QuestionDisposition/
    );
  }
});

// --- S15. Active-cycle re-entry (packet §48) --------------------------------

check('after SUPERSEDED, Q1 rejects every current-gated API while Q2 routes normally, via existing transitive gates', () => {
  const cycle = buildFailedCycleFixture('CONTEXT_GAP');
  const { session, state, question: q1, attempt } = cycle;
  const q2 = buildReplacementFor(cycle);
  const disposed = recordQuestionDisposition(session, state, {
    attemptId: attempt.attemptId,
    disposition: 'SUPERSEDED_RECLASSIFIED',
    reason: 'x',
    replacementQuestion: q2,
  });

  assert.throws(() => planRouteForQuestion(session, disposed, q1), /is not current/);
  assert.throws(
    () =>
      createContextRequest(session, disposed, {
        attemptId: attempt.attemptId,
        category: 'constraints',
        question: 'still relevant?',
        inferenceReason: 'x',
      }),
    /is not current/
  );

  const decision2 = planRouteForQuestion(session, disposed, q2);
  assert.equal(decision2.questionId, q2.id);
  const recorded2 = recordRouteDecision(session, disposed, decision2);
  assert.equal(recorded2.history.some((d) => d.id === decision2.id), true);
});

// --- S16. Human authority (packet §49) --------------------------------------

check('SUPERSEDED_RECLASSIFIED never mutates the session (HumanAdjudication/findings/semanticIssues/artifact/context untouched)', () => {
  const cycle = buildFailedCycleFixture('COVERAGE_GAP');
  const { session, state, attempt } = cycle;
  const replacementQuestion = buildReplacementFor(cycle);
  const before = JSON.parse(JSON.stringify(session));
  recordQuestionDisposition(session, state, {
    attemptId: attempt.attemptId,
    disposition: 'SUPERSEDED_RECLASSIFIED',
    reason: 'x',
    replacementQuestion,
  });
  assert.deepEqual(session, before);
});

// --- S17. No CROSS_SESSION (packet §50) -------------------------------------

check('CROSS_SESSION remains rejected outright even after SUPERSEDED_RECLASSIFIED became recordable', () => {
  const { session, state, attempt } = buildFailedCycleFixture('COVERAGE_GAP');
  assert.throws(
    () => recordQuestionDisposition(session, state, { attemptId: attempt.attemptId, disposition: 'CROSS_SESSION', reason: 'x' }),
    /invalid or unsupported disposition/
  );
});

// ==================================================================
// T. Question-terminality ledger integrity (Slice 2D-B2-B amendment)
// ==================================================================
console.log('\nQuestion-terminality ledger integrity (Slice 2D-B2-B amendment)');

// --- T1. Valid STILL_OPEN then SUPERSEDED (packet §25) ---------------------

check('a prior STILL_OPEN cycle does not block a later SUPERSEDED_RECLASSIFIED cycle for the same question', () => {
  const cycle1 = buildFailedCycleFixture('COVERAGE_GAP');
  const { session, state: state0, question: q1, attempt: attempt1 } = cycle1;
  const afterStillOpen = recordQuestionDisposition(session, state0, {
    attemptId: attempt1.attemptId,
    disposition: 'STILL_OPEN',
    reason: 'first cycle remains open',
  });

  const decision2 = planRouteForQuestion(session, afterStillOpen, q1);
  const state2 = recordRouteDecision(session, afterStillOpen, decision2);
  const state3 = recordRouteAttemptStart(session, state2, decision2.id);
  const attempt2 = state3.attempts.find((a) => a.decisionId === decision2.id);
  const state4 = recordRouteOutcome(session, state3, {
    attemptId: attempt2.attemptId,
    status: 'FAILED',
    latencyConsumed: 1,
    failure: VALID_FAILURE_FOR_DISPOSITION,
  });
  const q2 = createUnresolvedQuestion(session, {
    rootCause: 'DECISION_SENSITIVE_CONFLICT',
    materialityReason: 'reclassified after a prior STILL_OPEN cycle',
    inputRefs: q1.inputRefs.map((ref) => ({ ...ref })),
    derivedFromQuestionId: q1.id,
  });
  const state5 = recordQuestionDisposition(session, state4, {
    attemptId: attempt2.attemptId,
    disposition: 'SUPERSEDED_RECLASSIFIED',
    reason: 'Q1 reclassified into Q2 on its second cycle',
    replacementQuestion: q2,
  });

  assert.equal(isQuestionCurrent(state5, q1.id), false);
  assert.equal(isQuestionCurrent(state5, q2.id), true);
});

// --- T2. Multiple STILL_OPEN then RESOLVED (packet §26) --------------------

check('multiple prior STILL_OPEN cycles do not block a later RESOLVED', () => {
  const cycle1 = buildFailedCycleFixture('COVERAGE_GAP');
  const { session, state: state0, question: q1, attempt: attempt1 } = cycle1;
  let state = recordQuestionDisposition(session, state0, {
    attemptId: attempt1.attemptId,
    disposition: 'STILL_OPEN',
    reason: 'cycle 1 remains open',
  });

  for (let i = 0; i < 2; i++) {
    const decision = planRouteForQuestion(session, state, q1);
    state = recordRouteDecision(session, state, decision);
    state = recordRouteAttemptStart(session, state, decision.id);
    const attempt = state.attempts.find((a) => a.decisionId === decision.id);
    state = recordRouteOutcome(session, state, {
      attemptId: attempt.attemptId,
      status: 'FAILED',
      latencyConsumed: 1,
      failure: VALID_FAILURE_FOR_DISPOSITION,
    });
    const disposition = i === 0 ? 'STILL_OPEN' : 'RESOLVED';
    state = recordQuestionDisposition(session, state, { attemptId: attempt.attemptId, disposition, reason: `cycle ${i + 2}` });
  }

  assert.equal(isQuestionCurrent(state, q1.id), false);
  assert.equal(state.questionDispositions.filter((d) => d.questionId === q1.id).length, 3);
});

// --- T3/T4. Two-terminal tamper, both orders (packet §27-28) ----------------

check('a tampered RESOLVED + SUPERSEDED_RECLASSIFIED pair for the same question fails closed in both append orders, even with an otherwise-valid Q2 child', () => {
  for (const order of ['RESOLVED-then-SUPERSEDED', 'SUPERSEDED-then-RESOLVED']) {
    const cycle1 = buildFailedCycleFixture('COVERAGE_GAP');
    const { session, state: state0, question: q1, attempt: attempt1 } = cycle1;

    const afterFirst = recordQuestionDisposition(session, state0, {
      attemptId: attempt1.attemptId,
      disposition: 'STILL_OPEN',
      reason: 'first cycle kept open so a second real cycle can be built',
    });
    const decision2 = planRouteForQuestion(session, afterFirst, q1);
    const state2 = recordRouteDecision(session, afterFirst, decision2);
    const state3 = recordRouteAttemptStart(session, state2, decision2.id);
    const attempt2 = state3.attempts.find((a) => a.decisionId === decision2.id);
    const state4 = recordRouteOutcome(session, state3, {
      attemptId: attempt2.attemptId,
      status: 'FAILED',
      latencyConsumed: 1,
      failure: VALID_FAILURE_FOR_DISPOSITION,
    });

    const q2 = createUnresolvedQuestion(session, {
      rootCause: 'DECISION_SENSITIVE_CONFLICT',
      materialityReason: 'an otherwise-valid derived child of a doubly-terminal Q1',
      inputRefs: q1.inputRefs.map((ref) => ({ ...ref })),
      derivedFromQuestionId: q1.id,
    });

    const resolvedDisposition = {
      attemptId: attempt1.attemptId,
      questionId: q1.id,
      sessionId: state4.sessionId,
      artifactHash: state4.artifactHash,
      authorContextHash: state4.authorContextHash,
      disposition: 'RESOLVED',
      reason: 'tampered: first terminal',
      createdAt: new Date().toISOString(),
    };
    const supersededDisposition = {
      attemptId: attempt2.attemptId,
      questionId: q1.id,
      sessionId: state4.sessionId,
      artifactHash: state4.artifactHash,
      authorContextHash: state4.authorContextHash,
      disposition: 'SUPERSEDED_RECLASSIFIED',
      reason: 'tampered: second terminal',
      createdAt: new Date().toISOString(),
    };
    const orderedDispositions =
      order === 'RESOLVED-then-SUPERSEDED' ? [resolvedDisposition, supersededDisposition] : [supersededDisposition, resolvedDisposition];

    const tampered = {
      ...state4,
      unresolvedQuestions: [...state4.unresolvedQuestions, q2],
      questionDispositions: orderedDispositions,
    };

    assert.throws(() => isQuestionCurrent(tampered, q1.id), /already has a terminal disposition/, `order ${order}`);
    assert.throws(
      () => planRouteForQuestion(session, tampered, q1),
      /already has a terminal disposition|is not current/,
      `order ${order}`
    );
  }
});

// --- T5. Terminal then STILL_OPEN (packet §29) ------------------------------

check('a terminal disposition followed by a later STILL_OPEN for the same question fails closed, for both RESOLVED and SUPERSEDED_RECLASSIFIED', () => {
  for (const terminalKind of ['RESOLVED', 'SUPERSEDED_RECLASSIFIED']) {
    const cycle1 = buildFailedCycleFixture('COVERAGE_GAP');
    const { session, state: state0, question, attempt: attempt1 } = cycle1;
    const afterFirst = recordQuestionDisposition(session, state0, {
      attemptId: attempt1.attemptId,
      disposition: 'STILL_OPEN',
      reason: 'first cycle kept open so a second real cycle can be built',
    });
    const decision2 = planRouteForQuestion(session, afterFirst, question);
    const state2 = recordRouteDecision(session, afterFirst, decision2);
    const state3 = recordRouteAttemptStart(session, state2, decision2.id);
    const attempt2 = state3.attempts.find((a) => a.decisionId === decision2.id);
    const state4 = recordRouteOutcome(session, state3, {
      attemptId: attempt2.attemptId,
      status: 'FAILED',
      latencyConsumed: 1,
      failure: VALID_FAILURE_FOR_DISPOSITION,
    });

    const terminalDisposition = {
      attemptId: attempt1.attemptId,
      questionId: question.id,
      sessionId: state4.sessionId,
      artifactHash: state4.artifactHash,
      authorContextHash: state4.authorContextHash,
      disposition: terminalKind,
      reason: 'terminal, tampered to appear first',
      createdAt: new Date().toISOString(),
    };
    const staleStillOpen = {
      attemptId: attempt2.attemptId,
      questionId: question.id,
      sessionId: state4.sessionId,
      artifactHash: state4.artifactHash,
      authorContextHash: state4.authorContextHash,
      disposition: 'STILL_OPEN',
      reason: 'stale STILL_OPEN, tampered to appear after a terminal',
      createdAt: new Date().toISOString(),
    };
    const tampered = { ...state4, questionDispositions: [terminalDisposition, staleStillOpen] };
    assert.throws(() => isQuestionCurrent(tampered, question.id), /already has a terminal disposition/, terminalKind);
  }
});

// --- T6. Multiple terminals of the same kind (packet §30) -------------------

check('two terminal dispositions of the SAME kind for one question also reject (per-attempt uniqueness alone is not sufficient)', () => {
  for (const terminalKind of ['RESOLVED', 'SUPERSEDED_RECLASSIFIED']) {
    const cycle1 = buildFailedCycleFixture('COVERAGE_GAP');
    const { session, state: state0, question, attempt: attempt1 } = cycle1;
    const afterFirst = recordQuestionDisposition(session, state0, {
      attemptId: attempt1.attemptId,
      disposition: 'STILL_OPEN',
      reason: 'first cycle kept open so a second real cycle can be built',
    });
    const decision2 = planRouteForQuestion(session, afterFirst, question);
    const state2 = recordRouteDecision(session, afterFirst, decision2);
    const state3 = recordRouteAttemptStart(session, state2, decision2.id);
    const attempt2 = state3.attempts.find((a) => a.decisionId === decision2.id);
    const state4 = recordRouteOutcome(session, state3, {
      attemptId: attempt2.attemptId,
      status: 'FAILED',
      latencyConsumed: 1,
      failure: VALID_FAILURE_FOR_DISPOSITION,
    });

    const makeDisposition = (attemptId) => ({
      attemptId,
      questionId: question.id,
      sessionId: state4.sessionId,
      artifactHash: state4.artifactHash,
      authorContextHash: state4.authorContextHash,
      disposition: terminalKind,
      reason: `duplicate ${terminalKind}`,
      createdAt: new Date().toISOString(),
    });
    const tampered = {
      ...state4,
      questionDispositions: [makeDisposition(attempt1.attemptId), makeDisposition(attempt2.attemptId)],
    };
    assert.throws(() => isQuestionCurrent(tampered, question.id), /already has a terminal disposition/, terminalKind);
  }
});

// --- T7. Terminality is per-questionId, not global (packet §31) ------------

check('terminality tracking is per-questionId, not global across all questions', () => {
  const cycleA = buildFailedCycleFixture('COVERAGE_GAP');
  const { session, state: stateA, question: qA, attempt: attemptA } = cycleA;
  const resolvedA = recordQuestionDisposition(session, stateA, {
    attemptId: attemptA.attemptId,
    disposition: 'RESOLVED',
    reason: 'A resolved',
  });

  const extra = buildRegisteredQuestion(session, resolvedA, {
    rootCause: 'STABILITY_QUESTION',
    materialityReason: 'question B, unrelated to A',
    inputRefs: qA.inputRefs.map((ref) => ({ ...ref })),
  });
  let state = extra.state;
  const qB = extra.question;
  const decisionB = planRouteForQuestion(session, state, qB);
  state = recordRouteDecision(session, state, decisionB);
  state = recordRouteAttemptStart(session, state, decisionB.id);
  const attemptB = state.attempts.find((a) => a.decisionId === decisionB.id);
  state = recordRouteOutcome(session, state, {
    attemptId: attemptB.attemptId,
    status: 'FAILED',
    latencyConsumed: 1,
    failure: VALID_FAILURE_FOR_DISPOSITION,
  });
  const qC = createUnresolvedQuestion(session, {
    rootCause: 'DECISION_SENSITIVE_CONFLICT',
    materialityReason: 'B reclassified into C',
    inputRefs: qB.inputRefs.map((ref) => ({ ...ref })),
    derivedFromQuestionId: qB.id,
  });
  state = recordQuestionDisposition(session, state, {
    attemptId: attemptB.attemptId,
    disposition: 'SUPERSEDED_RECLASSIFIED',
    reason: 'B reclassified into C',
    replacementQuestion: qC,
  });

  assert.equal(isQuestionCurrent(state, qA.id), false);
  assert.equal(isQuestionCurrent(state, qB.id), false);
  assert.equal(isQuestionCurrent(state, qC.id), true);
});

// ==================================================================
// U. ADD_CONTEXT SUPPLIED / DECLINED RouteOutcome (Slice 2D-C2)
// ==================================================================
console.log('\nADD_CONTEXT SUPPLIED / DECLINED RouteOutcome (Slice 2D-C2)');

check('SUPPLIED happy path: stored outcome carries exact contextRequestId/responseText/decision/question/session/hash/logicalCost/completedAt; ContextRequests and session unchanged', () => {
  const { session, state, attempt, question, decision, contextRequest } = buildAddContextRequestedFixture();
  const before = JSON.parse(JSON.stringify(session));
  const requestsBefore = JSON.parse(JSON.stringify(state.contextRequests));

  const next = recordRouteOutcome(session, state, {
    attemptId: attempt.attemptId,
    status: 'SUCCEEDED',
    latencyConsumed: 3,
    result: 'SUPPLIED',
    contextRequestId: contextRequest.id,
    responseText: 'The team confirmed capacity for the migration.',
  });

  assert.equal(next.outcomes.length, 1);
  const outcome = next.outcomes[0];
  assert.equal(outcome.route, 'ADD_CONTEXT');
  assert.equal(outcome.status, 'SUCCEEDED');
  assert.equal(outcome.result, 'SUPPLIED');
  assert.equal(outcome.contextRequestId, contextRequest.id);
  assert.equal(outcome.responseText, 'The team confirmed capacity for the migration.');
  assert.equal(outcome.attemptId, attempt.attemptId);
  assert.equal(outcome.decisionId, decision.id);
  assert.equal(outcome.originatingQuestionId, question.id);
  assert.equal(outcome.sessionId, session.id);
  assert.equal(outcome.artifactHash, session.artifactHash);
  assert.equal(outcome.authorContextHash, session.authorContextHash);
  assert.equal(outcome.logicalCost, attempt.logicalCost);
  assert.equal(outcome.latencyConsumed, 3);
  assert.equal(typeof outcome.completedAt, 'string');
  assert.ok(!Number.isNaN(Date.parse(outcome.completedAt)));

  assert.deepEqual(next.contextRequests, requestsBefore);
  assert.deepEqual(session, before);
});

check('DECLINED happy path: stored outcome has no responseText field', () => {
  const { session, state, attempt, contextRequest } = buildAddContextRequestedFixture();
  const next = recordRouteOutcome(session, state, {
    attemptId: attempt.attemptId,
    status: 'SUCCEEDED',
    latencyConsumed: 1,
    result: 'DECLINED',
    contextRequestId: contextRequest.id,
  });
  const outcome = next.outcomes[0];
  assert.equal(outcome.result, 'DECLINED');
  assert.equal(outcome.contextRequestId, contextRequest.id);
  assert.equal('responseText' in outcome, false);
});

check('zero ContextRequest for the attempt: both SUPPLIED and DECLINED are rejected, with no latency spend or outcome append', () => {
  for (const result of ['SUPPLIED', 'DECLINED']) {
    const { session, state, attempt } = buildAddContextAttemptFixture();
    const before = JSON.parse(JSON.stringify(state));
    const extra = result === 'SUPPLIED' ? { responseText: 'x' } : {};
    assert.throws(
      () =>
        recordRouteOutcome(session, state, {
          attemptId: attempt.attemptId,
          status: 'SUCCEEDED',
          latencyConsumed: 1,
          result,
          contextRequestId: 'no-request-exists-for-this-attempt',
          ...extra,
        }),
      /does not resolve to exactly one ContextRequest/
    );
    assert.deepEqual(state, before);
  }
});

check('a ContextRequest belonging to a DIFFERENT attempt is rejected, even with equivalent sourceRefs/session', () => {
  const cycle1 = buildAddContextRequestedFixture();
  const { state: state2, question: question2 } = buildRegisteredQuestion(cycle1.session, cycle1.state, {
    rootCause: 'CONTEXT_GAP',
    materialityReason: 'a second, independent CONTEXT_GAP question',
    inputRefs: cycle1.question.inputRefs.map((ref) => ({ ...ref })),
  });
  const decision2 = planRouteForQuestion(cycle1.session, state2, question2);
  const state3 = recordRouteDecision(cycle1.session, state2, decision2);
  const state4 = recordRouteAttemptStart(cycle1.session, state3, decision2.id);
  const attempt2 = state4.attempts.find((a) => a.decisionId === decision2.id);
  const second = createContextRequest(cycle1.session, state4, {
    attemptId: attempt2.attemptId,
    category: 'constraints',
    question: 'second question?',
    inferenceReason: 'x',
  });

  assert.throws(
    () =>
      recordRouteOutcome(cycle1.session, second.deliberationState, {
        attemptId: cycle1.attempt.attemptId,
        status: 'SUCCEEDED',
        latencyConsumed: 1,
        result: 'DECLINED',
        contextRequestId: second.contextRequest.id,
      }),
    /does not match the attempt being terminalized/
  );
  assert.equal(second.deliberationState.outcomes.length, 0);
});

check('a blank or entirely unknown contextRequestId is rejected', () => {
  const { session, state, attempt, contextRequest } = buildAddContextRequestedFixture();
  for (const bad of ['', '   ', null, undefined, 'totally-fictitious-id']) {
    assert.throws(
      () =>
        recordRouteOutcome(session, state, {
          attemptId: attempt.attemptId,
          status: 'SUCCEEDED',
          latencyConsumed: 1,
          result: 'DECLINED',
          contextRequestId: bad,
        }),
      /must be a non-empty string|does not resolve to exactly one ContextRequest/,
      `expected contextRequestId ${JSON.stringify(bad)} to be rejected`
    );
  }
  assert.equal(contextRequest.originatingAttemptId, attempt.attemptId);
});

check('a tampered ledger with a duplicate ContextRequest.id is rejected before any request is selected', () => {
  const { session, state, attempt, contextRequest } = buildAddContextRequestedFixture();
  const duplicateIdEntry = { ...contextRequest, originatingAttemptId: 'a-different-attempt-id-entirely' };
  const tampered = { ...state, contextRequests: [...state.contextRequests, duplicateIdEntry] };
  assert.throws(
    () =>
      recordRouteOutcome(session, tampered, {
        attemptId: attempt.attemptId,
        status: 'SUCCEEDED',
        latencyConsumed: 1,
        result: 'DECLINED',
        contextRequestId: contextRequest.id,
      }),
    /duplicate ContextRequest\.id/
  );
});

check('a self-consistent but state-inconsistent attempt/request pair ELSEWHERE in the ledger fails closed through the mandatory ledger check, even for an otherwise perfectly valid outcome (C1 amendment protection preserved)', () => {
  const cycle1 = buildAddContextRequestedFixture();
  const { state: state2, question: question2 } = buildRegisteredQuestion(cycle1.session, cycle1.state, {
    rootCause: 'CONTEXT_GAP',
    materialityReason: 'a second, independent CONTEXT_GAP question',
    inputRefs: cycle1.question.inputRefs.map((ref) => ({ ...ref })),
  });
  const decision2 = planRouteForQuestion(cycle1.session, state2, question2);
  const state3 = recordRouteDecision(cycle1.session, state2, decision2);
  const state4 = recordRouteAttemptStart(cycle1.session, state3, decision2.id);
  const attempt2 = state4.attempts.find((a) => a.decisionId === decision2.id);
  const second = createContextRequest(cycle1.session, state4, {
    attemptId: attempt2.attemptId,
    category: 'constraints',
    question: 'second question?',
    inferenceReason: 'x',
  });

  // Tamper A2/R2 (unrelated to the outcome being recorded) so they mutually
  // agree with each other but disagree with the current DeliberationState.
  const tamperedAttempts = second.deliberationState.attempts.map((a) =>
    a.attemptId === attempt2.attemptId ? { ...a, sessionId: 'BAD-SESSION' } : a
  );
  const tamperedRequests = second.deliberationState.contextRequests.map((r) =>
    r.originatingAttemptId === attempt2.attemptId ? { ...r, originatingSessionId: 'BAD-SESSION' } : r
  );
  const tampered = { ...second.deliberationState, attempts: tamperedAttempts, contextRequests: tamperedRequests };

  // A1/R1 (the ones actually named by this outcome) are themselves perfectly
  // valid -- validateAttemptProvenanceForOutcome for attempt1 would pass on
  // its own. The mandatory GLOBAL ledger check must still reject, because it
  // scans the COMPLETE ledger (including the tampered, unrelated A2/R2 pair),
  // never only the locally-selected request.
  assert.throws(
    () =>
      recordRouteOutcome(cycle1.session, tampered, {
        attemptId: cycle1.attempt.attemptId,
        status: 'SUCCEEDED',
        latencyConsumed: 1,
        result: 'DECLINED',
        contextRequestId: cycle1.contextRequest.id,
      }),
    /sessionId does not match the current DeliberationState binding/
  );
});

check('SUPPLIED requires a non-empty responseText; missing/null/empty/whitespace-only are all rejected', () => {
  const { session, state, attempt, contextRequest } = buildAddContextRequestedFixture();
  for (const bad of [undefined, null, '', '   ']) {
    const extra = bad === undefined ? {} : { responseText: bad };
    assert.throws(
      () =>
        recordRouteOutcome(session, state, {
          attemptId: attempt.attemptId,
          status: 'SUCCEEDED',
          latencyConsumed: 1,
          result: 'SUPPLIED',
          contextRequestId: contextRequest.id,
          ...extra,
        }),
      /must be a non-empty string/,
      `expected responseText ${JSON.stringify(bad)} to be rejected`
    );
  }
  const ok = recordRouteOutcome(session, state, {
    attemptId: attempt.attemptId,
    status: 'SUCCEEDED',
    latencyConsumed: 1,
    result: 'SUPPLIED',
    contextRequestId: contextRequest.id,
    responseText: 'a perfectly ordinary response',
  });
  assert.equal(ok.outcomes[0].responseText, 'a perfectly ordinary response');
});

check('DECLINED rejects a responseText field; its own exact payload passes', () => {
  const { session, state, attempt, contextRequest } = buildAddContextRequestedFixture();
  assert.throws(
    () =>
      recordRouteOutcome(session, state, {
        attemptId: attempt.attemptId,
        status: 'SUCCEEDED',
        latencyConsumed: 1,
        result: 'DECLINED',
        contextRequestId: contextRequest.id,
        responseText: 'should not be allowed here',
      }),
    /unexpected field/
  );
  const ok = recordRouteOutcome(session, state, {
    attemptId: attempt.attemptId,
    status: 'SUCCEEDED',
    latencyConsumed: 1,
    result: 'DECLINED',
    contextRequestId: contextRequest.id,
  });
  assert.equal(ok.outcomes[0].result, 'DECLINED');
});

check('NO_RESPONSE is rejected explicitly, even with a perfectly valid ContextRequest present -- no timeout/deadline mechanism is invented', () => {
  const { session, state, attempt, contextRequest } = buildAddContextRequestedFixture();
  assert.throws(
    () =>
      recordRouteOutcome(session, state, {
        attemptId: attempt.attemptId,
        status: 'SUCCEEDED',
        latencyConsumed: 1,
        result: 'NO_RESPONSE',
        contextRequestId: contextRequest.id,
      }),
    /NO_RESPONSE is not authorized/
  );
});

check('ADD_CONTEXT status INCONCLUSIVE is rejected, never reinterpreted as NO_RESPONSE', () => {
  const { session, state, attempt } = buildAddContextAttemptFixture();
  assert.throws(
    () => recordRouteOutcome(session, state, { attemptId: attempt.attemptId, status: 'INCONCLUSIVE', latencyConsumed: 1 }),
    /INCONCLUSIVE is not recordable/
  );
});

check('generic FAILED remains legal for ADD_CONTEXT with zero or one ContextRequest; extra ADD_CONTEXT-success keys are rejected on FAILED', () => {
  {
    const { session, state, attempt } = buildAddContextAttemptFixture();
    const outcomeState = recordRouteOutcome(session, state, {
      attemptId: attempt.attemptId,
      status: 'FAILED',
      latencyConsumed: 1,
      failure: VALID_FAILURE_FOR_DISPOSITION,
    });
    assert.equal(outcomeState.outcomes[0].status, 'FAILED');
  }
  {
    const { session, state, attempt } = buildAddContextRequestedFixture();
    const outcomeState = recordRouteOutcome(session, state, {
      attemptId: attempt.attemptId,
      status: 'FAILED',
      latencyConsumed: 1,
      failure: VALID_FAILURE_FOR_DISPOSITION,
    });
    assert.equal(outcomeState.outcomes[0].status, 'FAILED');
    assert.equal(outcomeState.contextRequests.length, 1);
  }
  {
    const { session, state, attempt } = buildAddContextAttemptFixture();
    assert.throws(
      () =>
        recordRouteOutcome(session, state, {
          attemptId: attempt.attemptId,
          status: 'FAILED',
          latencyConsumed: 1,
          failure: VALID_FAILURE_FOR_DISPOSITION,
          contextRequestId: 'x',
          result: 'SUPPLIED',
          responseText: 'x',
        }),
      /unexpected field/
    );
  }
});

check('recording SUPPLIED or DECLINED never mutates the ContextRequest ledger (no response/consumed field added)', () => {
  for (const result of ['SUPPLIED', 'DECLINED']) {
    const { session, state, attempt, contextRequest } = buildAddContextRequestedFixture();
    const before = JSON.parse(JSON.stringify(state.contextRequests));
    const extra = result === 'SUPPLIED' ? { responseText: 'x' } : {};
    const next = recordRouteOutcome(session, state, {
      attemptId: attempt.attemptId,
      status: 'SUCCEEDED',
      latencyConsumed: 1,
      result,
      contextRequestId: contextRequest.id,
      ...extra,
    });
    assert.deepEqual(next.contextRequests, before);
  }
});

check('recording DECLINED does not mutate the session (hashes/AuthorContext/findings/semanticIssues/adjudications/revisionActions untouched)', () => {
  const { session, state, attempt, contextRequest } = buildAddContextRequestedFixture();
  const before = JSON.parse(JSON.stringify(session));
  recordRouteOutcome(session, state, {
    attemptId: attempt.attemptId,
    status: 'SUCCEEDED',
    latencyConsumed: 1,
    result: 'DECLINED',
    contextRequestId: contextRequest.id,
  });
  assert.deepEqual(session, before);
});

check('SUPPLIED and DECLINED never automatically create a QuestionDisposition', () => {
  for (const result of ['SUPPLIED', 'DECLINED']) {
    const { session, state, attempt, question, contextRequest } = buildAddContextRequestedFixture();
    const extra = result === 'SUPPLIED' ? { responseText: 'x' } : {};
    const next = recordRouteOutcome(session, state, {
      attemptId: attempt.attemptId,
      status: 'SUCCEEDED',
      latencyConsumed: 1,
      result,
      contextRequestId: contextRequest.id,
      ...extra,
    });
    assert.deepEqual(next.questionDispositions, []);
    assert.equal(isQuestionCurrent(next, question.id), true);
  }
});

check('after a SUPPLIED outcome, recordQuestionDisposition(STILL_OPEN) and, from a fresh equivalent setup, RESOLVED are both structurally legal', () => {
  {
    const { session, state, attempt, contextRequest } = buildAddContextRequestedFixture();
    const outcomeState = recordRouteOutcome(session, state, {
      attemptId: attempt.attemptId,
      status: 'SUCCEEDED',
      latencyConsumed: 1,
      result: 'SUPPLIED',
      contextRequestId: contextRequest.id,
      responseText: 'x',
    });
    const disposed = recordQuestionDisposition(session, outcomeState, {
      attemptId: attempt.attemptId,
      disposition: 'STILL_OPEN',
      reason: 'still needs more',
    });
    assert.equal(disposed.questionDispositions.length, 1);
  }
  {
    const { session, state, attempt, contextRequest } = buildAddContextRequestedFixture();
    const outcomeState = recordRouteOutcome(session, state, {
      attemptId: attempt.attemptId,
      status: 'SUCCEEDED',
      latencyConsumed: 1,
      result: 'SUPPLIED',
      contextRequestId: contextRequest.id,
      responseText: 'x',
    });
    const disposed = recordQuestionDisposition(session, outcomeState, {
      attemptId: attempt.attemptId,
      disposition: 'RESOLVED',
      reason: 'now resolved',
    });
    assert.equal(isQuestionCurrent(disposed, disposed.unresolvedQuestions[0].id), false);
  }
});

check('mutating the caller input object after recording does not alter the stored outcome; no nested mutable request object exists in the outcome', () => {
  const { session, state, attempt, contextRequest } = buildAddContextRequestedFixture();
  const callerInput = {
    attemptId: attempt.attemptId,
    status: 'SUCCEEDED',
    latencyConsumed: 1,
    result: 'SUPPLIED',
    contextRequestId: contextRequest.id,
    responseText: 'original response',
  };
  const next = recordRouteOutcome(session, state, callerInput);
  callerInput.responseText = 'mutated after the call';
  assert.equal(next.outcomes[0].responseText, 'original response');
  assert.equal('contextRequest' in next.outcomes[0], false);
});

check('SUPPLIED and DECLINED both reject every caller-derived field (decisionId/originatingQuestionId/sessionId/artifactHash/authorContextHash/logicalCost/completedAt)', () => {
  const { session, state, attempt, question, contextRequest } = buildAddContextRequestedFixture();
  const forbiddenExtras = [
    { decisionId: 'x' },
    { originatingQuestionId: question.id },
    { sessionId: session.id },
    { artifactHash: session.artifactHash },
    { authorContextHash: session.authorContextHash },
    { logicalCost: 0 },
    { completedAt: new Date().toISOString() },
  ];
  for (const result of ['SUPPLIED', 'DECLINED']) {
    const base = {
      attemptId: attempt.attemptId,
      status: 'SUCCEEDED',
      latencyConsumed: 1,
      result,
      contextRequestId: contextRequest.id,
      ...(result === 'SUPPLIED' ? { responseText: 'x' } : {}),
    };
    for (const extra of forbiddenExtras) {
      assert.throws(
        () => recordRouteOutcome(session, state, { ...base, ...extra }),
        /unexpected field/,
        `expected ${result} + ${JSON.stringify(Object.keys(extra))} to be rejected`
      );
    }
  }
});

console.log('\nAtomic CROSS_SESSION transition runtime (Slice 2D-C3)');

check('createCrossSessionTransition: happy path produces Session B (INPUT_FROZEN), +1 CROSS_SESSION disposition, +1 lineage, atomically', () => {
  const { session, state, attempt, question, contextRequest } = buildAddContextSuppliedFixture();
  const result = createCrossSessionTransition(session, state, { suppliedOutcomeAttemptId: attempt.attemptId });

  assert.deepEqual(result.session, session);
  assert.equal(result.deliberationState.questionDispositions.length, 1);
  assert.equal(result.deliberationState.questionDispositions[0].disposition, 'CROSS_SESSION');
  assert.equal(result.deliberationState.questionDispositions[0].questionId, question.id);
  assert.equal(result.deliberationState.sessionVersionLineages.length, 1);

  assert.notEqual(result.childSession.id, session.id);
  assert.equal(result.childSession.state, 'INPUT_FROZEN');
  assert.equal(result.childSession.artifactText, session.artifactText);
  assert.equal(result.childSession.artifactHash, session.artifactHash);
  assert.notEqual(result.childSession.authorContextHash, session.authorContextHash);

  const lineage = result.lineage;
  assert.equal(lineage.parentSessionId, session.id);
  assert.equal(lineage.childSessionId, result.childSession.id);
  assert.equal(lineage.parentArtifactHash, session.artifactHash);
  assert.equal(lineage.childArtifactHash, result.childSession.artifactHash);
  assert.equal(lineage.parentAuthorContextHash, session.authorContextHash);
  assert.equal(lineage.childAuthorContextHash, result.childSession.authorContextHash);
  assert.equal(lineage.originatingQuestionId, question.id);
  assert.equal(lineage.suppliedOutcomeAttemptId, attempt.attemptId);
  assert.equal(lineage.contextRequestId, contextRequest.id);
  assert.deepEqual(result.deliberationState.sessionVersionLineages[0], lineage);

  assert.equal(isQuestionCurrent(result.deliberationState, question.id), false);
});

check('createCrossSessionTransition: parent session is never mutated', () => {
  const { session, state, attempt } = buildAddContextSuppliedFixture();
  const before = JSON.parse(JSON.stringify(session));
  createCrossSessionTransition(session, state, { suppliedOutcomeAttemptId: attempt.attemptId });
  assert.deepEqual(session, before);
});

check('createCrossSessionTransition: Session B starts with no findings/semanticIssues/adjudications/revisionActions', () => {
  const { session, state, attempt } = buildAddContextSuppliedFixture();
  assert.ok(Object.keys(session.findings).length > 0);
  const result = createCrossSessionTransition(session, state, { suppliedOutcomeAttemptId: attempt.attemptId });
  assert.deepEqual(result.childSession.findings, {});
  assert.deepEqual(result.childSession.semanticIssues, {});
  assert.deepEqual(result.childSession.adjudications, {});
  assert.deepEqual(result.childSession.revisionActions, {});
});

check('createCrossSessionTransition: child AuthorContext contains every parent item plus exactly one new supplied item, no omission/duplication', () => {
  const { session, state, attempt, contextRequest } = buildAddContextSuppliedFixture();
  const result = createCrossSessionTransition(session, state, { suppliedOutcomeAttemptId: attempt.attemptId });
  for (const category of ['confirmedFacts', 'knownRisks', 'openQuestions', 'constraints']) {
    const parentTexts = session.authorContext[category].map((i) => i.text);
    const childTexts = result.childSession.authorContext[category]
      .filter((i) => i.id !== result.lineage.addedAuthorContextItemId)
      .map((i) => i.text);
    assert.deepEqual(childTexts, parentTexts);
  }
  const added = result.childSession.authorContext[contextRequest.category].find(
    (i) => i.id === result.lineage.addedAuthorContextItemId
  );
  assert.ok(added);
});

check('createCrossSessionTransition: the new item carries the request category and outcome responseText exactly, sourceType AUTHOR, status CURRENT', () => {
  const responseText = 'The precise budget ceiling is $75,000 as confirmed by finance.';
  const { session, state, attempt, contextRequest } = buildAddContextSuppliedFixture(responseText);
  const result = createCrossSessionTransition(session, state, { suppliedOutcomeAttemptId: attempt.attemptId });
  const added = result.childSession.authorContext[contextRequest.category].find(
    (i) => i.id === result.lineage.addedAuthorContextItemId
  );
  assert.equal(added.text, responseText);
  assert.equal(added.sourceType, 'AUTHOR');
  assert.equal(added.status, 'CURRENT');
});

check('createCrossSessionTransition: a second call with the same suppliedOutcomeAttemptId is rejected -- no second child/lineage/disposition', () => {
  const { session, state, attempt } = buildAddContextSuppliedFixture();
  const result = createCrossSessionTransition(session, state, { suppliedOutcomeAttemptId: attempt.attemptId });
  assert.throws(() =>
    createCrossSessionTransition(result.session, result.deliberationState, { suppliedOutcomeAttemptId: attempt.attemptId })
  );
  assert.equal(result.deliberationState.sessionVersionLineages.length, 1);
});

check('createCrossSessionTransition: rejects DECLINED, FAILED ADD_CONTEXT, REPLICATE success, ADD_REVIEWER success, unknown/blank attemptId', () => {
  {
    const base = buildAddContextRequestedFixture();
    const declined = recordRouteOutcome(base.session, base.state, {
      attemptId: base.attempt.attemptId,
      status: 'SUCCEEDED',
      latencyConsumed: 1,
      result: 'DECLINED',
      contextRequestId: base.contextRequest.id,
    });
    assert.throws(() => createCrossSessionTransition(base.session, declined, { suppliedOutcomeAttemptId: base.attempt.attemptId }));
  }
  {
    const base = buildAddContextAttemptFixture();
    const failed = recordRouteOutcome(base.session, base.state, {
      attemptId: base.attempt.attemptId,
      status: 'FAILED',
      latencyConsumed: 1,
      failure: VALID_FAILURE_FOR_DISPOSITION,
    });
    assert.throws(() => createCrossSessionTransition(base.session, failed, { suppliedOutcomeAttemptId: base.attempt.attemptId }));
  }
  {
    const cycle = buildReplicateSuccessCycleFixture();
    assert.throws(() => createCrossSessionTransition(cycle.session, cycle.state, { suppliedOutcomeAttemptId: cycle.attempt.attemptId }));
  }
  {
    const cycle = buildAddReviewerSuccessCycleFixture();
    assert.throws(() => createCrossSessionTransition(cycle.session, cycle.state, { suppliedOutcomeAttemptId: cycle.attempt.attemptId }));
  }
  {
    const { session, state } = buildAddContextSuppliedFixture();
    assert.throws(() => createCrossSessionTransition(session, state, { suppliedOutcomeAttemptId: 'does-not-exist' }));
  }
  {
    const { session, state } = buildAddContextSuppliedFixture();
    assert.throws(() => createCrossSessionTransition(session, state, { suppliedOutcomeAttemptId: '' }));
  }
});

check('createCrossSessionTransition: a tampered SUPPLIED outcome fails closed through fresh read validation', () => {
  const fields = ['contextRequestId', 'originatingQuestionId', 'sessionId', 'artifactHash', 'authorContextHash', 'responseText'];
  for (const field of fields) {
    const { session, state, attempt } = buildAddContextSuppliedFixture();
    const badValue = field === 'responseText' ? '' : 'tampered-value';
    const tamperedOutcomes = state.outcomes.map((o) => (o.attemptId === attempt.attemptId ? { ...o, [field]: badValue } : o));
    const tamperedState = { ...state, outcomes: tamperedOutcomes };
    assert.throws(
      () => createCrossSessionTransition(session, tamperedState, { suppliedOutcomeAttemptId: attempt.attemptId }),
      undefined,
      `expected tampering ${field} to be rejected`
    );
  }
});

check('createCrossSessionTransition: mandatory global ContextRequest ledger integrity rejects when an unrelated ledger entry is corrupt', () => {
  const target = buildAddContextSuppliedFixture();
  const second = extendWithSecondSuppliedCycle(target.session, target.state);
  const corruptedRequests = second.state.contextRequests.map((r) =>
    r.originatingAttemptId === second.attempt.attemptId ? { ...r, sourceRefs: [] } : r
  );
  const corruptedState = { ...second.state, contextRequests: corruptedRequests };
  assert.throws(() =>
    createCrossSessionTransition(target.session, corruptedState, { suppliedOutcomeAttemptId: target.attempt.attemptId })
  );
});

check('createCrossSessionTransition: tampered existing SessionVersionLineage ledger entries poison the entire DeliberationState -- any subsequent currentness read fails closed (Slice 2D-C3-0 amendment)', () => {
  const tamperFns = [
    (l) => ({ ...l, lineageId: '' }),
    (l) => ({ ...l, childSessionId: l.parentSessionId }),
    (l) => ({ ...l, parentSessionId: 'wrong-session' }),
    (l) => ({ ...l, parentArtifactHash: 'wrong-hash' }),
    (l) => ({ ...l, originatingQuestionId: 'wrong-question' }),
    (l) => ({ ...l, contextRequestId: 'wrong-request' }),
    (l) => ({ ...l, suppliedOutcomeAttemptId: 'unknown-attempt' }),
  ];
  for (const tamper of tamperFns) {
    const first = buildAddContextSuppliedFixture();
    const firstResult = createCrossSessionTransition(first.session, first.state, { suppliedOutcomeAttemptId: first.attempt.attemptId });
    const questionId = firstResult.deliberationState.unresolvedQuestions[0].id;
    const tamperedState = { ...firstResult.deliberationState, sessionVersionLineages: [tamper(firstResult.lineage)] };
    assert.throws(
      () => isQuestionCurrent(tamperedState, questionId),
      undefined,
      `expected lineage tamper to be rejected: ${JSON.stringify(tamper(firstResult.lineage))}`
    );
    assert.throws(() => createCrossSessionTransition(firstResult.session, tamperedState, { suppliedOutcomeAttemptId: first.attempt.attemptId }));
  }
  {
    // Duplicate lineageId/childSessionId/suppliedOutcomeAttemptId in one shot.
    const first = buildAddContextSuppliedFixture();
    const firstResult = createCrossSessionTransition(first.session, first.state, { suppliedOutcomeAttemptId: first.attempt.attemptId });
    const questionId = firstResult.deliberationState.unresolvedQuestions[0].id;
    const tamperedState = {
      ...firstResult.deliberationState,
      sessionVersionLineages: [firstResult.lineage, { ...firstResult.lineage }],
    };
    assert.throws(() => isQuestionCurrent(tamperedState, questionId));
  }
});

check('revalidateSuppliedOutcomeProvenance (via createCrossSessionTransition): enforces full attempt/decision/question provenance parity with validateAttemptProvenanceForOutcome (Slice 2D-C3-0 amendment §5)', () => {
  {
    const { session, state, attempt } = buildAddContextSuppliedFixture();
    const tamperedAttempts = state.attempts.map((a) => (a.attemptId === attempt.attemptId ? { ...a, logicalCost: a.logicalCost + 1 } : a));
    assert.throws(() =>
      createCrossSessionTransition(session, { ...state, attempts: tamperedAttempts }, { suppliedOutcomeAttemptId: attempt.attemptId })
    );
  }
  {
    const { session, state, attempt } = buildAddContextSuppliedFixture();
    const tamperedAttempts = state.attempts.map((a) => (a.attemptId === attempt.attemptId ? { ...a, startedAt: 'not-a-date' } : a));
    assert.throws(() =>
      createCrossSessionTransition(session, { ...state, attempts: tamperedAttempts }, { suppliedOutcomeAttemptId: attempt.attemptId })
    );
  }
  {
    // route remains ADD_CONTEXT throughout -- proves the deeper decision/question checks, not the route check, are what reject this.
    const { session, state, attempt, decision } = buildAddContextSuppliedFixture();
    const tamperedHistory = state.history.map((d) =>
      d.id === decision.id ? { ...d, reason: { ...d.reason, rootCause: 'EVIDENCE_GAP' } } : d
    );
    assert.throws(() =>
      createCrossSessionTransition(session, { ...state, history: tamperedHistory }, { suppliedOutcomeAttemptId: attempt.attemptId })
    );
  }
  {
    const { session, state, attempt, decision } = buildAddContextSuppliedFixture();
    const tamperedHistory = state.history.map((d) =>
      d.id === decision.id ? { ...d, reason: { ...d.reason, materialityReason: 'a different materiality reason' } } : d
    );
    assert.throws(() =>
      createCrossSessionTransition(session, { ...state, history: tamperedHistory }, { suppliedOutcomeAttemptId: attempt.attemptId })
    );
  }
  {
    const { session, state, attempt, decision } = buildAddContextSuppliedFixture();
    const tamperedHistory = state.history.map((d) => (d.id === decision.id ? { ...d, inputRefs: [] } : d));
    assert.throws(() =>
      createCrossSessionTransition(session, { ...state, history: tamperedHistory }, { suppliedOutcomeAttemptId: attempt.attemptId })
    );
  }
});

check('revalidateSuppliedOutcomeProvenance (via createCrossSessionTransition): rejects a tampered RouteOutcome common envelope', () => {
  const tampers = [
    (o) => ({ ...o, logicalCost: o.logicalCost + 1 }),
    (o) => ({ ...o, latencyConsumed: -1 }),
    (o) => ({ ...o, completedAt: 'not-a-date' }),
  ];
  for (const tamper of tampers) {
    const { session, state, attempt } = buildAddContextSuppliedFixture();
    const tamperedOutcomes = state.outcomes.map((o) => (o.attemptId === attempt.attemptId ? tamper(o) : o));
    assert.throws(() =>
      createCrossSessionTransition(session, { ...state, outcomes: tamperedOutcomes }, { suppliedOutcomeAttemptId: attempt.attemptId })
    );
  }
});

check('isQuestionCurrent: an orphan CROSS_SESSION disposition (no matching SessionVersionLineage) throws, never returns false (Slice 2D-C3-0 amendment §9/§20)', () => {
  const { state, attempt, question } = buildAddContextSuppliedFixture();
  const orphanDisposition = {
    attemptId: attempt.attemptId,
    questionId: question.id,
    sessionId: state.sessionId,
    artifactHash: state.artifactHash,
    authorContextHash: state.authorContextHash,
    disposition: 'CROSS_SESSION',
    reason: 'orphan CROSS_SESSION with no lineage',
    createdAt: new Date().toISOString(),
  };
  assert.throws(() => isQuestionCurrent({ ...state, questionDispositions: [orphanDisposition] }, question.id));
});

check('isQuestionCurrent: a SessionVersionLineage with no matching CROSS_SESSION disposition throws (bijection reverse direction, Slice 2D-C3-0 amendment §10/§21)', () => {
  const { session, state, attempt, question } = buildAddContextSuppliedFixture();
  const result = createCrossSessionTransition(session, state, { suppliedOutcomeAttemptId: attempt.attemptId });
  const tamperedState = { ...result.deliberationState, questionDispositions: [] };
  assert.throws(() => isQuestionCurrent(tamperedState, question.id));
  assert.throws(() => createCrossSessionTransition(result.session, tamperedState, { suppliedOutcomeAttemptId: attempt.attemptId }));
});

check('isQuestionCurrent: a CROSS_SESSION disposition with a superficially matching but corrupted lineage throws -- existence alone is not sufficient (Slice 2D-C3-0 amendment §22)', () => {
  const { session, state, attempt, question } = buildAddContextSuppliedFixture();
  const result = createCrossSessionTransition(session, state, { suppliedOutcomeAttemptId: attempt.attemptId });
  const forgedLineage = { ...result.lineage, parentArtifactHash: 'forged-hash-still-matches-attemptId-and-questionId' };
  const tamperedState = { ...result.deliberationState, sessionVersionLineages: [forgedLineage] };
  assert.throws(() => isQuestionCurrent(tamperedState, question.id));
});

check('createCrossSessionTransition: a normal completed transition remains a valid bijection -- no regression (Slice 2D-C3-0 amendment §23)', () => {
  const { session, state, attempt, question } = buildAddContextSuppliedFixture();
  const result = createCrossSessionTransition(session, state, { suppliedOutcomeAttemptId: attempt.attemptId });
  assert.equal(isQuestionCurrent(result.deliberationState, question.id), false);
  assert.equal(result.deliberationState.sessionVersionLineages.length, 1);
  assert.equal(result.deliberationState.questionDispositions.filter((d) => d.disposition === 'CROSS_SESSION').length, 1);
});

check('isQuestionCurrent: Q2 is fine on its own, but throws when an unrelated historical CROSS_SESSION/lineage pair (Q1) in the same state is corrupt -- global before local (Slice 2D-C3-0 amendment §24)', () => {
  const first = buildAddContextSuppliedFixture();
  const firstResult = createCrossSessionTransition(first.session, first.state, { suppliedOutcomeAttemptId: first.attempt.attemptId });
  const second = extendWithSecondSuppliedCycle(firstResult.session, firstResult.deliberationState);
  assert.equal(isQuestionCurrent(second.state, second.question.id), true);

  const corruptedLineages = second.state.sessionVersionLineages.map((l) =>
    l.suppliedOutcomeAttemptId === first.attempt.attemptId ? { ...l, parentArtifactHash: 'corrupted-elsewhere-in-the-same-ledger' } : l
  );
  const corruptedState = { ...second.state, sessionVersionLineages: corruptedLineages };
  assert.throws(() => isQuestionCurrent(corruptedState, second.question.id));
});

check('assertSessionVersionLineageChildIntegrity: rejects a wrong/substituted parentSession, and a tampered childSession.artifactText (Slice 2D-C3-0 amendment §15)', () => {
  const { session, state, attempt, contextRequest, outcome } = buildAddContextSuppliedFixture();
  const result = createCrossSessionTransition(session, state, { suppliedOutcomeAttemptId: attempt.attemptId });
  const { lineage, childSession } = result;

  const wrongIdParent = { ...session, id: 'wrong-parent-id' };
  assert.throws(() => assertSessionVersionLineageChildIntegrity(wrongIdParent, lineage, childSession, outcome, contextRequest));

  const unrelated = buildAddContextSuppliedFixture('an unrelated fixture session');
  assert.throws(() => assertSessionVersionLineageChildIntegrity(unrelated.session, lineage, childSession, outcome, contextRequest));

  const tamperedChildText = { ...childSession, artifactText: `${childSession.artifactText} tampered` };
  assert.throws(() => assertSessionVersionLineageChildIntegrity(session, lineage, tamperedChildText, outcome, contextRequest));
});

check('assertSessionVersionLineageChildIntegrity: rejects a different SUPPLIED outcome or ContextRequest snapshot than the lineage actually names (Slice 2D-C3-0 amendment §16)', () => {
  const first = buildAddContextSuppliedFixture('first response text');
  const firstResult = createCrossSessionTransition(first.session, first.state, { suppliedOutcomeAttemptId: first.attempt.attemptId });
  const second = extendWithSecondSuppliedCycle(firstResult.session, firstResult.deliberationState, 'second response text');
  const secondOutcome = second.state.outcomes.find((o) => o.attemptId === second.attempt.attemptId);

  assert.throws(() =>
    assertSessionVersionLineageChildIntegrity(firstResult.session, firstResult.lineage, firstResult.childSession, secondOutcome, first.contextRequest)
  );
  assert.throws(() =>
    assertSessionVersionLineageChildIntegrity(
      firstResult.session,
      firstResult.lineage,
      firstResult.childSession,
      first.outcome,
      second.contextRequest
    )
  );
});

check('createCrossSessionTransition: after CROSS_SESSION, Q1 is permanently terminal -- no further routing may target it', () => {
  const { session, state, attempt, question } = buildAddContextSuppliedFixture();
  const result = createCrossSessionTransition(session, state, { suppliedOutcomeAttemptId: attempt.attemptId });
  assert.equal(isQuestionCurrent(result.deliberationState, question.id), false);
  assert.throws(() => planRouteForQuestion(result.session, result.deliberationState, question));
});

check('recordQuestionDisposition: CROSS_SESSION remains rejected -- only createCrossSessionTransition may write it', () => {
  const { session, state, attempt } = buildAddContextSuppliedFixture();
  assert.throws(
    () => recordQuestionDisposition(session, state, { attemptId: attempt.attemptId, disposition: 'CROSS_SESSION', reason: 'x' }),
    /invalid or unsupported disposition/
  );
});

check('assertSessionVersionLineageChildIntegrity: rejects a tampered actual child, individually, for every required field', () => {
  const { session, state, attempt, contextRequest, outcome } = buildAddContextSuppliedFixture();
  const result = createCrossSessionTransition(session, state, { suppliedOutcomeAttemptId: attempt.attemptId });
  const { lineage, childSession } = result;
  const addedCategory = contextRequest.category;

  const simpleTampers = [
    (c) => ({ ...c, id: 'wrong-id' }),
    (c) => ({ ...c, state: 'DRAFT' }),
    (c) => ({ ...c, artifactHash: 'wrong-hash' }),
    (c) => ({ ...c, authorContextHash: 'wrong-hash' }),
  ];
  for (const tamper of simpleTampers) {
    assert.throws(() => assertSessionVersionLineageChildIntegrity(session, lineage, tamper(childSession), outcome, contextRequest));
  }

  for (const fieldTamper of [{ text: 'tampered text' }, { sourceType: 'ARTIFACT' }, { status: 'RESOLVED' }]) {
    const tamperedChild = {
      ...childSession,
      authorContext: {
        ...childSession.authorContext,
        [addedCategory]: childSession.authorContext[addedCategory].map((i) =>
          i.id === lineage.addedAuthorContextItemId ? { ...i, ...fieldTamper } : i
        ),
      },
    };
    assert.throws(() => assertSessionVersionLineageChildIntegrity(session, lineage, tamperedChild, outcome, contextRequest));
  }

  const wrongCategory = addedCategory === 'knownRisks' ? 'openQuestions' : 'knownRisks';
  const addedItemObj = childSession.authorContext[addedCategory].find((i) => i.id === lineage.addedAuthorContextItemId);
  const withWrongCategoryItem = {
    ...childSession,
    authorContext: {
      ...childSession.authorContext,
      [addedCategory]: childSession.authorContext[addedCategory].filter((i) => i.id !== lineage.addedAuthorContextItemId),
      [wrongCategory]: [...childSession.authorContext[wrongCategory], addedItemObj],
    },
  };
  assert.throws(() => assertSessionVersionLineageChildIntegrity(session, lineage, withWrongCategoryItem, outcome, contextRequest));

  const someOtherCategoryWithItems = ['confirmedFacts', 'knownRisks', 'openQuestions', 'constraints'].find(
    (c) => c !== addedCategory && childSession.authorContext[c].length > 0
  );
  if (someOtherCategoryWithItems) {
    const withMissingParentItem = {
      ...childSession,
      authorContext: { ...childSession.authorContext, [someOtherCategoryWithItems]: [] },
    };
    assert.throws(() => assertSessionVersionLineageChildIntegrity(session, lineage, withMissingParentItem, outcome, contextRequest));
  }

  const withExtraItem = {
    ...childSession,
    authorContext: {
      ...childSession.authorContext,
      confirmedFacts: [
        ...childSession.authorContext.confirmedFacts,
        { id: 'extra-item', text: 'unexpected', sourceType: 'AUTHOR', status: 'CURRENT', createdAt: new Date().toISOString() },
      ],
    },
  };
  assert.throws(() => assertSessionVersionLineageChildIntegrity(session, lineage, withExtraItem, outcome, contextRequest));
});

check('createCrossSessionTransition: a DeliberationState predating sessionVersionLineages is read as [] without mutating the source; first transition returns an explicit canonical ledger', () => {
  const { session, state, attempt } = buildAddContextSuppliedFixture();
  const { sessionVersionLineages, ...legacyState } = state;
  assert.equal('sessionVersionLineages' in legacyState, false);
  const result = createCrossSessionTransition(session, legacyState, { suppliedOutcomeAttemptId: attempt.attemptId });
  assert.equal('sessionVersionLineages' in legacyState, false);
  assert.deepEqual(result.deliberationState.sessionVersionLineages, [result.lineage]);
});

check('createCrossSessionTransition: does not spend cost or latency budget', () => {
  const { session, state, attempt } = buildAddContextSuppliedFixture();
  const before = { cost: state.costBudget.spent, latency: state.latencyBudget.spent };
  const result = createCrossSessionTransition(session, state, { suppliedOutcomeAttemptId: attempt.attemptId });
  assert.equal(result.deliberationState.costBudget.spent, before.cost);
  assert.equal(result.deliberationState.latencyBudget.spent, before.latency);
});

check('createCrossSessionTransition: Session B receives no automatic findings/issues -- INPUT_FROZEN only', () => {
  const { session, state, attempt } = buildAddContextSuppliedFixture();
  const result = createCrossSessionTransition(session, state, { suppliedOutcomeAttemptId: attempt.attemptId });
  assert.equal(result.childSession.state, 'INPUT_FROZEN');
  assert.deepEqual(result.childSession.findings, {});
});

check('createCrossSessionTransition: mutating the returned lineage/childSession does not rewrite stored/parent state', () => {
  const { session, state, attempt } = buildAddContextSuppliedFixture();
  const result = createCrossSessionTransition(session, state, { suppliedOutcomeAttemptId: attempt.attemptId });
  const storedLineage = result.deliberationState.sessionVersionLineages[0];
  const originalLineageId = storedLineage.lineageId;
  result.lineage.lineageId = 'mutated-after-return';
  assert.equal(storedLineage.lineageId, originalLineageId);

  const parentConfirmedFactsBefore = session.authorContext.confirmedFacts.length;
  result.childSession.authorContext.confirmedFacts.push({
    id: 'injected',
    text: 'injected',
    sourceType: 'AUTHOR',
    status: 'CURRENT',
    createdAt: new Date().toISOString(),
  });
  assert.equal(session.authorContext.confirmedFacts.length, parentConfirmedFactsBefore);
});

check('createCrossSessionTransition: rejects every caller-derived/forbidden extra input key', () => {
  const { session, state, attempt, question, contextRequest } = buildAddContextSuppliedFixture();
  const forbiddenExtras = [
    { questionId: question.id },
    { contextRequestId: contextRequest.id },
    { responseText: 'x' },
    { childSessionId: 'x' },
    { lineageId: 'x' },
    { category: contextRequest.category },
    { artifactHash: session.artifactHash },
    { authorContextHash: session.authorContextHash },
    { reason: 'x' },
    { disposition: 'CROSS_SESSION' },
    { newSessionId: 'x' },
    { unexpectedKey: 'x' },
  ];
  for (const extra of forbiddenExtras) {
    assert.throws(
      () => createCrossSessionTransition(session, state, { suppliedOutcomeAttemptId: attempt.attemptId, ...extra }),
      /unexpected field/,
      `expected ${JSON.stringify(Object.keys(extra))} to be rejected`
    );
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
