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
// E. RouteDecision
// ==================================================================
console.log('\nRouteDecision planning');

check('route is derived correctly from rootCause', () => {
  const { session, issueId } = buildFixtureWithIssue();
  const state = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const question = createUnresolvedQuestion(session, {
    rootCause: 'DECISION_SENSITIVE_CONFLICT',
    materialityReason: 'Two findings conflict on timeline feasibility, and the answer changes whether the memo can be sent as-is.',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  const decision = planRouteForQuestion(session, state, question);
  assert.equal(decision.route, 'TARGETED_PEER_CHALLENGE');
  assert.equal(decision.reason.rootCause, 'DECISION_SENSITIVE_CONFLICT');
  assert.deepEqual(decision.inputRefs, [{ kind: 'SEMANTIC_ISSUE', id: issueId }]);
});

check('an incompatible route/rootCause pairing is rejected by recordRouteDecision', () => {
  const { session, issueId } = buildFixtureWithIssue();
  const state = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const incompatible = {
    id: 'manual-1',
    route: 'ADD_REVIEWER',
    reason: { rootCause: 'EVIDENCE_GAP', materialityReason: 'x' },
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
    createdAt: new Date().toISOString(),
  };
  assert.throws(() => recordRouteDecision(session, state, incompatible), /inconsistent with rootCause/);
});

check('an empty materialityReason is rejected', () => {
  const { session, issueId } = buildFixtureWithIssue();
  assert.throws(
    () =>
      createUnresolvedQuestion(session, {
        rootCause: 'COVERAGE_GAP',
        materialityReason: '   ',
        inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
      }),
    /materialityReason must be a non-empty/
  );
});

check('a non-NONE question with no refs is rejected', () => {
  const { session } = buildFixtureWithIssue();
  assert.throws(
    () => createUnresolvedQuestion(session, { rootCause: 'COVERAGE_GAP', materialityReason: 'x', inputRefs: [] }),
    /at least one inputRef is required/
  );
});

check('planRouteForQuestion makes zero provider calls -- a pure function with no observable side effects', () => {
  const { session, issueId } = buildFixtureWithIssue();
  const state = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const question = createUnresolvedQuestion(session, {
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
// F. Terminal STOP behavior
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

  const anotherQuestion = createUnresolvedQuestion(session, {
    rootCause: 'COVERAGE_GAP',
    materialityReason: 'x',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  const anotherDecision = planRouteForQuestion(session, stopped, anotherQuestion);
  assert.throws(() => recordRouteDecision(session, stopped, anotherDecision), /already stopped/);
});

check('a non-STOP route does not terminate the deliberation', () => {
  const { session, issueId } = buildFixtureWithIssue();
  const state = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const question = createUnresolvedQuestion(session, {
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
  const state = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const question = createUnresolvedQuestion(session, {
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
// G. Immutability
// ==================================================================
console.log('\nImmutability');

check('the original StressTestSession is never mutated by any deliberation function', () => {
  const { session, issueId } = buildFixtureWithIssue();
  const before = JSON.parse(JSON.stringify(session));
  const state = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const question = createUnresolvedQuestion(session, {
    rootCause: 'COVERAGE_GAP',
    materialityReason: 'x',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  const decision = planRouteForQuestion(session, state, question);
  recordRouteDecision(session, state, decision);
  createContextRequest(session, state, {
    reason: { rootCause: 'CONTEXT_GAP', materialityReason: 'x' },
    sourceRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
    category: 'constraints',
    question: 'What is the actual contractor budget ceiling?',
    inferenceReason: 'This cannot be inferred from the artifact text alone.',
  });
  assert.deepEqual(session, before);
});

check('the previous DeliberationState is never mutated -- recordRouteDecision returns a new object', () => {
  const { session, issueId } = buildFixtureWithIssue();
  const state = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const question = createUnresolvedQuestion(session, {
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
// H. Budget accounting
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
// I. ContextRequest (ADD_CONTEXT output)
// ==================================================================
console.log('\nContextRequest (ADD_CONTEXT output)');

check('captures the originating session id and frozen hashes', () => {
  const { session, issueId } = buildFixtureWithIssue();
  const state = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const request = createContextRequest(session, state, {
    reason: {
      rootCause: 'CONTEXT_GAP',
      materialityReason: 'The memo does not say whether the budget figure is a hard ceiling or a planning assumption.',
    },
    sourceRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
    category: 'constraints',
    question: 'Is "no additional contractor budget" a hard constraint or a planning assumption that could change?',
    inferenceReason: "This cannot be inferred from the artifact text alone -- it depends on the author's actual authority.",
  });
  assert.equal(request.originatingSessionId, session.id);
  assert.equal(request.artifactHash, session.artifactHash);
  assert.equal(request.authorContextHash, session.authorContextHash);
});

check('validates its sourceRefs', () => {
  const { session } = buildFixtureWithIssue();
  const state = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  assert.throws(
    () =>
      createContextRequest(session, state, {
        reason: { rootCause: 'CONTEXT_GAP', materialityReason: 'x' },
        sourceRefs: [{ kind: 'SEMANTIC_ISSUE', id: 'not-a-real-id' }],
        category: 'constraints',
        question: 'x?',
        inferenceReason: 'x',
      }),
    /unknown SEMANTIC_ISSUE id/
  );
});

check('requires rootCause CONTEXT_GAP', () => {
  const { session, issueId } = buildFixtureWithIssue();
  const state = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  assert.throws(
    () =>
      createContextRequest(session, state, {
        reason: { rootCause: 'EVIDENCE_GAP', materialityReason: 'x' },
        sourceRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
        category: 'constraints',
        question: 'x?',
        inferenceReason: 'x',
      }),
    /requires rootCause CONTEXT_GAP/
  );
});

check('requires a non-empty question', () => {
  const { session, issueId } = buildFixtureWithIssue();
  const state = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  assert.throws(
    () =>
      createContextRequest(session, state, {
        reason: { rootCause: 'CONTEXT_GAP', materialityReason: 'x' },
        sourceRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
        category: 'constraints',
        question: '   ',
        inferenceReason: 'x',
      }),
    /question must be a non-empty string/
  );
});

check('requires a non-empty inferenceReason', () => {
  const { session, issueId } = buildFixtureWithIssue();
  const state = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  assert.throws(
    () =>
      createContextRequest(session, state, {
        reason: { rootCause: 'CONTEXT_GAP', materialityReason: 'x' },
        sourceRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
        category: 'constraints',
        question: 'x?',
        inferenceReason: '',
      }),
    /inferenceReason must be a non-empty string/
  );
});

check('does not change AuthorContext, session hashes, or create a new session', () => {
  const { session, issueId } = buildFixtureWithIssue();
  const state = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const before = JSON.parse(JSON.stringify(session));
  createContextRequest(session, state, {
    reason: { rootCause: 'CONTEXT_GAP', materialityReason: 'x' },
    sourceRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
    category: 'constraints',
    question: 'x?',
    inferenceReason: 'x',
  });
  assert.deepEqual(session, before, 'session must be byte-for-byte unchanged');
  assert.equal(session.authorContext.constraints.length, before.authorContext.constraints.length);
});

// ==================================================================
// J. Human authority invariant
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
  const state = createDeliberationState(session, { costCeiling: 5, latencyCeiling: 5 });
  const question = createUnresolvedQuestion(session, {
    rootCause: 'COVERAGE_GAP',
    materialityReason: 'x',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  const decision = planRouteForQuestion(session, state, question);
  recordRouteDecision(session, state, decision);
  createContextRequest(session, state, {
    reason: { rootCause: 'CONTEXT_GAP', materialityReason: 'x' },
    sourceRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
    category: 'constraints',
    question: 'x?',
    inferenceReason: 'x',
  });
  assert.deepEqual(session.adjudications, {});
  assert.deepEqual(session.revisionActions, {});
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
