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
  createContextRequest(session, stateWithContext, {
    questionId: contextQuestion.id,
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

check('requires a registered question', () => {
  const session = buildReviewedFixtureSession();
  const state = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  assert.throws(
    () =>
      createContextRequest(session, state, {
        questionId: 'not-registered',
        category: 'constraints',
        question: 'x?',
        inferenceReason: 'x',
      }),
    /not a currently registered unresolved question/
  );
});

check('captures originatingQuestionId, originatingSessionId, and frozen hashes', () => {
  const session = buildReviewedFixtureSession();
  const itemId = session.authorContext.constraints[0].id;
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const { state, question } = buildRegisteredQuestion(session, state0, {
    rootCause: 'CONTEXT_GAP',
    materialityReason: 'The memo does not say whether the budget figure is a hard ceiling or a planning assumption.',
    inputRefs: [{ kind: 'AUTHOR_CONTEXT_ITEM', id: itemId }],
  });
  const request = createContextRequest(session, state, {
    questionId: question.id,
    category: 'constraints',
    question: 'Is "no additional contractor budget" a hard constraint or a planning assumption that could change?',
    inferenceReason: "This cannot be inferred from the artifact text alone -- it depends on the author's actual authority.",
  });
  assert.equal(request.originatingQuestionId, question.id);
  assert.equal(request.originatingSessionId, session.id);
  assert.equal(request.artifactHash, session.artifactHash);
  assert.equal(request.authorContextHash, session.authorContextHash);
});

check('sourceRefs are copied from the registered question, not caller-suppliable', () => {
  const session = buildReviewedFixtureSession();
  const itemId = session.authorContext.constraints[0].id;
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const { state, question } = buildRegisteredQuestion(session, state0, {
    rootCause: 'CONTEXT_GAP',
    materialityReason: 'x',
    inputRefs: [{ kind: 'AUTHOR_CONTEXT_ITEM', id: itemId }],
  });
  const request = createContextRequest(session, state, {
    questionId: question.id,
    category: 'constraints',
    question: 'x?',
    inferenceReason: 'x',
    // The API has no sourceRefs parameter at all -- an attempted override is
    // simply an extra, ignored key, never reaching request.sourceRefs.
    sourceRefs: [{ kind: 'FINDING', id: 'attacker-supplied' }],
  });
  assert.deepEqual(request.sourceRefs, question.inputRefs);
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

check('a non-CONTEXT_GAP registered question is rejected', () => {
  const { session, issueId } = buildFixtureWithIssue();
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const { state, question } = buildRegisteredQuestion(session, state0, {
    rootCause: 'EVIDENCE_GAP',
    materialityReason: 'x',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  assert.throws(
    () =>
      createContextRequest(session, state, {
        questionId: question.id,
        category: 'constraints',
        question: 'x?',
        inferenceReason: 'x',
      }),
    /not CONTEXT_GAP/
  );
});

check('an unknown questionId is rejected', () => {
  const session = buildReviewedFixtureSession();
  const state = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  assert.throws(
    () =>
      createContextRequest(session, state, {
        questionId: 'never-registered',
        category: 'constraints',
        question: 'x?',
        inferenceReason: 'x',
      }),
    /not a currently registered unresolved question/
  );
});

check('is rejected once the deliberation has stopped', () => {
  const session = buildReviewedFixtureSession();
  const itemId = session.authorContext.constraints[0].id;
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const { state: registered, question } = buildRegisteredQuestion(session, state0, {
    rootCause: 'CONTEXT_GAP',
    materialityReason: 'x',
    inputRefs: [{ kind: 'AUTHOR_CONTEXT_ITEM', id: itemId }],
  });

  const stopQuestion = createUnresolvedQuestion(session, { rootCause: 'NONE', materialityReason: 'x', inputRefs: [] });
  const stopDecision = planRouteForQuestion(session, registered, stopQuestion);
  const stopped = recordRouteDecision(session, registered, stopDecision, { stopReason: 'successful' });

  assert.throws(
    () =>
      createContextRequest(session, stopped, {
        questionId: question.id,
        category: 'constraints',
        question: 'x?',
        inferenceReason: 'x',
      }),
    /already stopped/
  );
});

check('requires a non-empty question and inferenceReason', () => {
  const session = buildReviewedFixtureSession();
  const itemId = session.authorContext.constraints[0].id;
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const { state, question } = buildRegisteredQuestion(session, state0, {
    rootCause: 'CONTEXT_GAP',
    materialityReason: 'x',
    inputRefs: [{ kind: 'AUTHOR_CONTEXT_ITEM', id: itemId }],
  });
  assert.throws(
    () =>
      createContextRequest(session, state, {
        questionId: question.id,
        category: 'constraints',
        question: '   ',
        inferenceReason: 'x',
      }),
    /question must be a non-empty string/
  );
  assert.throws(
    () =>
      createContextRequest(session, state, {
        questionId: question.id,
        category: 'constraints',
        question: 'x?',
        inferenceReason: '',
      }),
    /inferenceReason must be a non-empty string/
  );
});

check('does not change AuthorContext, session hashes, or create a new session', () => {
  const session = buildReviewedFixtureSession();
  const itemId = session.authorContext.constraints[0].id;
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const { state, question } = buildRegisteredQuestion(session, state0, {
    rootCause: 'CONTEXT_GAP',
    materialityReason: 'x',
    inputRefs: [{ kind: 'AUTHOR_CONTEXT_ITEM', id: itemId }],
  });
  const before = JSON.parse(JSON.stringify(session));
  createContextRequest(session, state, {
    questionId: question.id,
    category: 'constraints',
    question: 'x?',
    inferenceReason: 'x',
  });
  assert.deepEqual(session, before, 'session must be byte-for-byte unchanged');
  assert.equal(session.authorContext.constraints.length, before.authorContext.constraints.length);
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
  createContextRequest(session, stateWithContext, {
    questionId: contextQuestion.id,
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
      questionId: 'never-registered',
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
  const { session, issueId } = buildFixtureWithIssue();
  const state0 = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const { state, question } = buildRegisteredQuestion(session, state0, {
    rootCause: 'CONTEXT_GAP',
    materialityReason: 'x',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  const request = createContextRequest(session, state, {
    questionId: question.id,
    category: 'constraints',
    question: 'What is the actual notice period?',
    inferenceReason: 'x',
  });

  request.sourceRefs[0].id = 'mutated-id';
  request.sourceRefs[0].kind = 'FINDING';

  assert.deepEqual(state.unresolvedQuestions[0].inputRefs[0], { kind: 'SEMANTIC_ISSUE', id: issueId });
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

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
