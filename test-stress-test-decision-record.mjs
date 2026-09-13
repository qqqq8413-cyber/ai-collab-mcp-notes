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
  createDeliberationState,
  createUnresolvedQuestion,
  registerUnresolvedQuestion,
  planRouteForQuestion,
  recordRouteDecision,
  recordRouteAttemptStart,
  recordRouteOutcome,
  recordQuestionDisposition,
  registerEvidenceSubject,
  generateIntegratedDecisionReport,
  generateDecisionRecord,
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

// --- Synthetic, non-client fixture: a fictional vendor memo. -----------------

const ARTIFACT_TEXT = `Project Comet — Vendor Consolidation Memo

We recommend consolidating all analytics tooling onto VendorX within Q1.
VendorX's pricing is stable for the first year at $12,000 total. Switching
away from VendorX later would require a full data-migration effort, but the
memo does not estimate that cost. The pilot with three teams over four weeks
showed no major issues.`;

function createFrozenSession() {
  let session = createSession(ARTIFACT_TEXT);
  session = addAuthorContextItem(session, 'confirmedFacts', {
    text: 'The $12,000 figure is a locked first-year rate, not a multi-year estimate.',
    sourceType: 'AUTHOR',
  });
  session = addAuthorContextItem(session, 'knownRisks', {
    text: 'Switching vendors after year one has historically taken 2-3 months.',
    sourceType: 'AUTHOR',
  });
  return freezeInput(session);
}

/** Adds one finding, returning the updated session and the new finding's id (never assumes insertion order). */
function addFindingTracked(session, overrides = {}) {
  const before = new Set(Object.keys(session.findings));
  const next = addFinding(session, {
    reviewerRunId: 'run-1',
    type: 'CLAIM',
    title: 'Vendor switching cost understated',
    artifactLocation: 'paragraph 2',
    evidenceState: 'UNSUPPORTED_IN_MATERIAL',
    whyMaterial: 'A locked-in vendor with unestimated exit cost changes the recommendation.',
    likelyRecipientChallenge: 'What does switching actually cost?',
    minimumBeforeSendAction: 'Estimate switching cost before sending.',
    ...overrides,
  });
  const findingId = Object.keys(next.findings).find((id) => !before.has(id));
  return { session: next, findingId };
}

/**
 * Builds the full authoritative chain the packet's own §21 requires:
 * ReviewFinding -> SemanticIssue -> UnresolvedQuestion -> RouteDecision ->
 * RouteAttempt -> RouteOutcome -> QuestionDisposition -> HumanAdjudication ->
 * RevisionAction, entirely through existing legal APIs.
 */
function buildFullChainFixture() {
  const base = addFindingTracked(createFrozenSession());
  let session = createSemanticIssue(base.session, {
    title: 'Vendor switching cost understated',
    description: 'The memo recommends a vendor without pricing in the cost of a future exit.',
    findingIds: [base.findingId],
    evidenceState: 'UNSUPPORTED_IN_MATERIAL',
  });
  const issueId = Object.keys(session.semanticIssues)[0];

  // createDeliberationState requires session.state === 'REVIEWED' -- must run
  // before adjudicate/planRevisionAction move the session past REVIEWED.
  let state = createDeliberationState(session, { costCeiling: 50, latencyCeiling: 100 });
  const question = createUnresolvedQuestion(session, {
    rootCause: 'STABILITY_QUESTION',
    materialityReason: 'The switching-cost claim needs replication before it can be trusted.',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  state = registerUnresolvedQuestion(session, state, question);
  const decision = planRouteForQuestion(session, state, question);
  state = recordRouteDecision(session, state, decision);
  state = recordRouteAttemptStart(session, state, decision.id);
  const attempt = state.attempts[0];
  state = recordRouteOutcome(session, state, {
    attemptId: attempt.attemptId,
    status: 'SUCCEEDED',
    latencyConsumed: 2,
    result: 'REPRODUCED',
    targetRef: { kind: 'SEMANTIC_ISSUE', id: issueId },
  });
  state = recordQuestionDisposition(session, state, {
    attemptId: attempt.attemptId,
    disposition: 'RESOLVED',
    reason: 'Replication confirmed the instability claim; the switching-cost gap is real.',
  });

  session = adjudicate(session, {
    semanticIssueId: issueId,
    judgment: 'NEW_MATERIAL',
    actionChange: 'YES',
    note: 'Must add a switching-cost estimate before sending.',
  });
  session = planRevisionAction(session, {
    sourceRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
    description: 'Add an estimated vendor-switching cost to paragraph 2.',
    targetLocation: 'paragraph 2',
  });
  const revisionActionId = Object.keys(session.revisionActions)[0];
  session = implementRevisionAction(session, revisionActionId);

  return { session, state, findingId: base.findingId, issueId, question, decision, attempt, revisionActionId };
}

/** A SEEK_EVIDENCE fixture, parameterized by result, wired through a real EvidenceSubject. */
function buildSeekEvidenceFixture(result) {
  const base = addFindingTracked(createFrozenSession(), {
    title: 'Pilot showed no major issues',
    artifactLocation: 'paragraph 3',
  });
  let session = createSemanticIssue(base.session, {
    title: 'Pilot showed no major issues',
    description: 'The claim of a clean pilot is asserted without supporting detail.',
    findingIds: [base.findingId],
    evidenceState: 'UNSUPPORTED_IN_MATERIAL',
  });
  const issueId = Object.keys(session.semanticIssues)[0];

  let state = createDeliberationState(session, { costCeiling: 50, latencyCeiling: 100 });
  const question = createUnresolvedQuestion(session, {
    rootCause: 'EVIDENCE_GAP',
    materialityReason: 'The clean-pilot claim needs independent evidence.',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  state = registerUnresolvedQuestion(session, state, question);
  const registered = registerEvidenceSubject(session, state, {
    questionId: question.id,
    sourceRef: { kind: 'SEMANTIC_ISSUE', id: issueId },
    originatingFindingId: base.findingId,
    claimText: 'The pilot with three teams over four weeks showed no major issues.',
  });
  state = registered.deliberationState;
  const evidenceSubject = registered.evidenceSubject;

  const decision = planRouteForQuestion(session, state, question);
  state = recordRouteDecision(session, state, decision);
  state = recordRouteAttemptStart(session, state, decision.id);
  const attempt = state.attempts[0];

  const citation = { sourceIdentifier: 'pilot-notes.txt', title: 'Pilot notes', excerpt: 'No incidents were logged during the pilot.' };
  const outcomeInput =
    result === 'INCONCLUSIVE'
      ? { attemptId: attempt.attemptId, status: 'INCONCLUSIVE', latencyConsumed: 3, result: 'INCONCLUSIVE', evidenceSubjectId: evidenceSubject.id, citations: [] }
      : { attemptId: attempt.attemptId, status: 'SUCCEEDED', latencyConsumed: 3, result, evidenceSubjectId: evidenceSubject.id, citations: [citation] };
  state = recordRouteOutcome(session, state, outcomeInput);

  return { session, state, issueId, findingId: base.findingId, question, attempt, evidenceSubject, citation };
}

// ==================================================================
// §21. Basic integration
// ==================================================================

check('generateIntegratedDecisionReport: joins the full chain (finding -> issue -> question -> decision -> attempt -> outcome -> disposition -> adjudication -> revision) through authoritative identities', () => {
  const { session, state, findingId, issueId, question, decision, attempt, revisionActionId } = buildFullChainFixture();
  const report = generateIntegratedDecisionReport(session, state);

  assert.equal(report.sessionId, session.id);
  assert.equal(report.artifactHash, session.artifactHash);
  assert.equal(typeof report.generatedAt, 'string');

  assert.equal(report.issues.length, 1);
  const issue = report.issues[0];
  assert.equal(issue.semanticIssueId, issueId);
  assert.deepEqual(issue.findingIds, [findingId]);
  assert.deepEqual(issue.artifactLocations, ['paragraph 2']);
  assert.equal(issue.evidenceState, 'UNSUPPORTED_IN_MATERIAL');

  assert.ok(issue.humanAdjudication);
  assert.equal(issue.humanAdjudication.judgment, 'NEW_MATERIAL');
  assert.equal(issue.humanAdjudication.actionChange, 'YES');

  assert.equal(issue.revisionActions.length, 1);
  assert.equal(issue.revisionActions[0].id, revisionActionId);
  assert.equal(issue.revisionActions[0].status, 'IMPLEMENTED');
  assert.equal(issue.revisionActions[0].statusLabel, 'Revision action marked implemented');

  assert.equal(issue.linkedQuestions.length, 1);
  const thread = issue.linkedQuestions[0];
  assert.equal(thread.unresolvedQuestionId, question.id);
  assert.equal(thread.rootCause, 'STABILITY_QUESTION');
  assert.equal(thread.isCurrent, false, 'the question was RESOLVED');

  assert.equal(thread.routeCycles.length, 1);
  const cycle = thread.routeCycles[0];
  assert.equal(cycle.routeDecisionId, decision.id);
  assert.equal(cycle.route, 'REPLICATE');
  assert.equal(cycle.attemptId, attempt.attemptId);
  assert.equal(cycle.attemptStatus, 'SUCCEEDED');
  assert.equal(cycle.resultSummary, 'REPRODUCED');
  assert.equal(cycle.failure, null);
  assert.equal(cycle.evidence, null);
  assert.equal(cycle.dispositions.length, 1);
  assert.equal(cycle.dispositions[0].disposition, 'RESOLVED');

  // The question was resolved, so it must not also appear as an unresolved risk.
  assert.equal(report.unresolvedRisks.length, 0);

  assert.equal(report.summary.reviewFindings, 1);
  assert.equal(report.summary.semanticIssues, 1);
  assert.equal(report.summary.adjudicatedIssues, 1);
  assert.equal(report.summary.actionChangeYes, 1);
  assert.equal(report.summary.revisionActionsImplemented, 1);
  assert.equal(report.summary.revisionActionsPlanned, 0);
  assert.equal(report.summary.unresolvedQuestions, 0);
  assert.equal(report.summary.resolvedQuestions, 1);
});

// ==================================================================
// §22. SEEK_EVIDENCE
// ==================================================================

for (const result of ['SUPPORTIVE', 'CONTRADICTORY', 'INCONCLUSIVE']) {
  check(`generateIntegratedDecisionReport: SEEK_EVIDENCE ${result} presents claimText, EvidenceSubject identity, citations, and status/result correctly`, () => {
    const { session, state, issueId, findingId, question, evidenceSubject, citation } = buildSeekEvidenceFixture(result);
    const report = generateIntegratedDecisionReport(session, state);

    const issue = report.issues.find((i) => i.semanticIssueId === issueId);
    assert.ok(issue);
    const thread = issue.linkedQuestions.find((t) => t.unresolvedQuestionId === question.id);
    assert.ok(thread);
    assert.equal(thread.routeCycles.length, 1);
    const cycle = thread.routeCycles[0];
    assert.equal(cycle.route, 'SEEK_EVIDENCE');
    assert.equal(cycle.attemptStatus, result === 'INCONCLUSIVE' ? 'INCONCLUSIVE' : 'SUCCEEDED');
    assert.equal(cycle.resultSummary, result);
    assert.ok(cycle.evidence);
    assert.equal(cycle.evidence.evidenceSubjectId, evidenceSubject.id);
    assert.equal(cycle.evidence.claimText, evidenceSubject.claimText);
    assert.equal(cycle.evidence.originatingFindingId, findingId);
    assert.deepEqual(cycle.evidence.sourceRef, { kind: 'SEMANTIC_ISSUE', id: issueId });
    if (result === 'INCONCLUSIVE') {
      assert.deepEqual(cycle.evidence.citations, []);
    } else {
      assert.deepEqual(cycle.evidence.citations, [citation]);
    }

    if (result === 'SUPPORTIVE') assert.equal(report.summary.evidenceSupportive, 1);
    if (result === 'CONTRADICTORY') assert.equal(report.summary.evidenceContradictory, 1);
    if (result === 'INCONCLUSIVE') assert.equal(report.summary.evidenceInconclusive, 1);
  });
}

// ==================================================================
// §23. No false join
// ==================================================================

check('generateIntegratedDecisionReport: two semantically-similar but identity-distinct issues are never cross-joined -- each links only its own question via recorded provenance', () => {
  const base = addFindingTracked(createFrozenSession(), { title: 'Budget claim unsupported', artifactLocation: 'paragraph 1' });
  const secondAdd = addFindingTracked(base.session, { title: 'Budget claim unsupported (separate)', artifactLocation: 'paragraph 1' });

  let session = createSemanticIssue(secondAdd.session, {
    title: 'Budget claim unsupported',
    description: 'First occurrence.',
    findingIds: [base.findingId],
    evidenceState: 'UNSUPPORTED_IN_MATERIAL',
  });
  const issueIdA = Object.keys(session.semanticIssues).find((id) => session.semanticIssues[id].description === 'First occurrence.');
  session = createSemanticIssue(session, {
    title: 'Budget claim unsupported',
    description: 'Second, textually identical title, distinct issue.',
    findingIds: [secondAdd.findingId],
    evidenceState: 'UNSUPPORTED_IN_MATERIAL',
  });
  const issueIdB = Object.keys(session.semanticIssues).find((id) => id !== issueIdA);

  let state = createDeliberationState(session, { costCeiling: 50, latencyCeiling: 100 });
  const questionA = createUnresolvedQuestion(session, {
    rootCause: 'STABILITY_QUESTION',
    materialityReason: 'Only issue A is routed for deliberation.',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueIdA }],
  });
  state = registerUnresolvedQuestion(session, state, questionA);
  const decision = planRouteForQuestion(session, state, questionA);
  state = recordRouteDecision(session, state, decision);

  const report = generateIntegratedDecisionReport(session, state);
  const issueA = report.issues.find((i) => i.semanticIssueId === issueIdA);
  const issueB = report.issues.find((i) => i.semanticIssueId === issueIdB);
  assert.equal(issueA.linkedQuestions.length, 1, 'issue A owns the question that actually names it');
  assert.equal(issueA.linkedQuestions[0].unresolvedQuestionId, questionA.id);
  assert.equal(issueB.linkedQuestions.length, 0, 'issue B must not inherit a question merely because titles/findings look similar');
  assert.deepEqual(issueA.findingIds, [base.findingId]);
  assert.deepEqual(issueB.findingIds, [secondAdd.findingId]);
});

// ==================================================================
// §24. Partial lifecycle
// ==================================================================

check('generateIntegratedDecisionReport: a question with no attempt yet is presented with an empty route cycle, no invented facts', () => {
  const base = addFindingTracked(createFrozenSession());
  let session = createSemanticIssue(base.session, {
    title: 'No attempt yet',
    description: 'd',
    findingIds: [base.findingId],
    evidenceState: 'UNSUPPORTED_IN_MATERIAL',
  });
  const issueId = Object.keys(session.semanticIssues)[0];
  let state = createDeliberationState(session, { costCeiling: 50, latencyCeiling: 100 });
  const question = createUnresolvedQuestion(session, {
    rootCause: 'STABILITY_QUESTION',
    materialityReason: 'm',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  state = registerUnresolvedQuestion(session, state, question);
  const decision = planRouteForQuestion(session, state, question);
  state = recordRouteDecision(session, state, decision);

  const report = generateIntegratedDecisionReport(session, state);
  const issue = report.issues[0];
  assert.equal(issue.linkedQuestions.length, 1);
  const cycle = issue.linkedQuestions[0].routeCycles[0];
  assert.equal(cycle.attemptId, null);
  assert.equal(cycle.attemptStatus, null);
  assert.equal(cycle.resultSummary, null);
  assert.equal(cycle.dispositions.length, 0);
  assert.equal(report.unresolvedRisks.length, 1);
  assert.equal(report.unresolvedRisks[0].unresolvedQuestionId, question.id);
});

check('generateIntegratedDecisionReport: an attempt with no outcome yet is presented with null status/result, no invented facts', () => {
  const base = addFindingTracked(createFrozenSession());
  let session = createSemanticIssue(base.session, {
    title: 'No outcome yet',
    description: 'd',
    findingIds: [base.findingId],
    evidenceState: 'UNSUPPORTED_IN_MATERIAL',
  });
  const issueId = Object.keys(session.semanticIssues)[0];
  let state = createDeliberationState(session, { costCeiling: 50, latencyCeiling: 100 });
  const question = createUnresolvedQuestion(session, {
    rootCause: 'STABILITY_QUESTION',
    materialityReason: 'm',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  state = registerUnresolvedQuestion(session, state, question);
  const decision = planRouteForQuestion(session, state, question);
  state = recordRouteDecision(session, state, decision);
  state = recordRouteAttemptStart(session, state, decision.id);
  const attempt = state.attempts[0];

  const report = generateIntegratedDecisionReport(session, state);
  const cycle = report.issues[0].linkedQuestions[0].routeCycles[0];
  assert.equal(cycle.attemptId, attempt.attemptId);
  assert.equal(cycle.attemptStatus, null);
  assert.equal(cycle.resultSummary, null);
  assert.equal(cycle.dispositions.length, 0);
});

check('generateIntegratedDecisionReport: an outcome with no disposition yet shows an empty dispositions list, and the question still counts as a current unresolved risk', () => {
  const base = addFindingTracked(createFrozenSession());
  let session = createSemanticIssue(base.session, {
    title: 'No disposition yet',
    description: 'd',
    findingIds: [base.findingId],
    evidenceState: 'UNSUPPORTED_IN_MATERIAL',
  });
  const issueId = Object.keys(session.semanticIssues)[0];
  let state = createDeliberationState(session, { costCeiling: 50, latencyCeiling: 100 });
  const question = createUnresolvedQuestion(session, {
    rootCause: 'STABILITY_QUESTION',
    materialityReason: 'm',
    inputRefs: [{ kind: 'SEMANTIC_ISSUE', id: issueId }],
  });
  state = registerUnresolvedQuestion(session, state, question);
  const decision = planRouteForQuestion(session, state, question);
  state = recordRouteDecision(session, state, decision);
  state = recordRouteAttemptStart(session, state, decision.id);
  const attempt = state.attempts[0];
  state = recordRouteOutcome(session, state, {
    attemptId: attempt.attemptId,
    status: 'SUCCEEDED',
    latencyConsumed: 1,
    result: 'REPRODUCED',
    targetRef: { kind: 'SEMANTIC_ISSUE', id: issueId },
  });

  const report = generateIntegratedDecisionReport(session, state);
  const cycle = report.issues[0].linkedQuestions[0].routeCycles[0];
  assert.equal(cycle.attemptStatus, 'SUCCEEDED');
  assert.equal(cycle.dispositions.length, 0);
  assert.equal(report.unresolvedRisks.length, 1, 'no disposition means the question is still current');
});

check('generateIntegratedDecisionReport: a semantic issue with no deliberation at all still reports, with an empty linkedQuestions list and no revision actions', () => {
  const base = addFindingTracked(createFrozenSession());
  const session = createSemanticIssue(base.session, {
    title: 'Never routed',
    description: 'd',
    findingIds: [base.findingId],
    evidenceState: 'UNSUPPORTED_IN_MATERIAL',
  });
  const state = createDeliberationState(session, { costCeiling: 50, latencyCeiling: 100 });

  const report = generateIntegratedDecisionReport(session, state);
  assert.equal(report.issues.length, 1);
  assert.deepEqual(report.issues[0].linkedQuestions, []);
  assert.deepEqual(report.issues[0].revisionActions, []);
  assert.equal(report.issues[0].humanAdjudication, null);
  assert.deepEqual(report.unresolvedRisks, []);
  assert.equal(report.summary.evidenceSupportive, 0);
  assert.equal(report.summary.evidenceContradictory, 0);
  assert.equal(report.summary.evidenceInconclusive, 0, 'no SEEK_EVIDENCE occurred anywhere');
});

// ==================================================================
// §25. IMPLEMENTED is not VERIFIED
// ==================================================================

check('generateIntegratedDecisionReport: a RevisionAction with status IMPLEMENTED never claims artifact verification, delivery confirmation, or final-artifact content', () => {
  const { session, state } = buildFullChainFixture();
  const report = generateIntegratedDecisionReport(session, state);
  const revision = report.issues[0].revisionActions[0];
  assert.equal(revision.status, 'IMPLEMENTED');
  assert.equal(revision.statusLabel, 'Revision action marked implemented');
  const serialized = JSON.stringify(revision).toLowerCase();
  assert.equal(serialized.includes('verified'), false);
  assert.equal(serialized.includes('confirmed'), false);
  assert.equal(serialized.includes('final artifact'), false);
});

// ==================================================================
// §26. Read-only
// ==================================================================

check('generateIntegratedDecisionReport: generation has no side effects -- session and DeliberationState are unchanged afterward', () => {
  const { session, state } = buildFullChainFixture();
  const sessionBefore = JSON.stringify(session);
  const stateBefore = JSON.stringify(state);
  generateIntegratedDecisionReport(session, state);
  assert.equal(JSON.stringify(session), sessionBefore);
  assert.equal(JSON.stringify(state), stateBefore);
});

// ==================================================================
// §27. Tampered provenance -- fails closed
// ==================================================================

check('generateIntegratedDecisionReport: a SEEK_EVIDENCE outcome whose evidenceSubjectId no longer resolves fails closed rather than silently omitting it', () => {
  const { session, state } = buildSeekEvidenceFixture('SUPPORTIVE');
  const tampered = {
    ...state,
    outcomes: state.outcomes.map((o) => (o.route === 'SEEK_EVIDENCE' ? { ...o, evidenceSubjectId: 'nonexistent-subject-id' } : o)),
  };
  assert.throws(() => generateIntegratedDecisionReport(session, tampered), /does not resolve to any recorded EvidenceSubject/);
});

check('generateIntegratedDecisionReport: a REPLICATE outcome whose targetRef no longer resolves fails closed', () => {
  const { session, state } = buildFullChainFixture();
  const tampered = {
    ...state,
    outcomes: state.outcomes.map((o) => (o.route === 'REPLICATE' ? { ...o, targetRef: { kind: 'SEMANTIC_ISSUE', id: 'nonexistent-issue-id' } } : o)),
  };
  assert.throws(() => generateIntegratedDecisionReport(session, tampered), /unknown SEMANTIC_ISSUE id/);
});

check('generateIntegratedDecisionReport: session/DeliberationState binding is re-verified -- a mismatched pair fails closed', () => {
  const a = buildFullChainFixture();
  const b = buildFullChainFixture();
  assert.throws(() => generateIntegratedDecisionReport(a.session, b.state), /DeliberationState is bound to session/);
});

// ==================================================================
// §19. Existing generateDecisionRecord is preserved
// ==================================================================

check('generateDecisionRecord: unaffected by this slice -- still generates from the session alone', () => {
  const { session } = buildFullChainFixture();
  const record = generateDecisionRecord(session);
  assert.equal(record.sessionId, session.id);
  assert.equal(record.issues.length, 1);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
