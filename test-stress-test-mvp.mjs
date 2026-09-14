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
  rejectRevisionAction,
  completeSession,
  createRevisionSuccessorSession,
  assertRevisionSuccessorIntegrity,
  recordRevisionVerification,
  assertRevisionVerificationIntegrity,
  generateDecisionRecord,
  renderDecisionRecordMarkdown,
  sha256Text,
  sha256AuthorContext,
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

// --- Synthetic, non-client fixture: a fictional internal launch memo. --------

const ARTIFACT_TEXT = `Project Comet — Internal Launch Memo

We are rolling out TaskFlow Lite to all 500 employees over a two-week window.
Pilot testing with 20 employees ran for two weeks with no major issues.
Total budget for licensing is capped at $8,000, with no additional headcount
available for the rollout. IT will handle account provisioning as part of the
standard onboarding process.`;

function buildFixtureSession() {
  let session = createSession(ARTIFACT_TEXT);

  session = addAuthorContextItem(session, 'confirmedFacts', {
    text: 'The $8,000 figure is a pre-negotiated volume-license rate for 500 seats, not a retail per-seat estimate.',
    sourceType: 'AUTHOR',
  });
  session = addAuthorContextItem(session, 'confirmedFacts', {
    text: 'Pilot testing with 20 employees ran for two weeks with no major issues.',
    sourceType: 'ARTIFACT',
  });
  session = addAuthorContextItem(session, 'knownRisks', {
    text: 'IT has not yet confirmed it has capacity to provision 500 new accounts within the rollout window.',
    sourceType: 'AUTHOR',
  });
  session = addAuthorContextItem(session, 'openQuestions', {
    text: 'What happens if company-wide adoption is low after 30 days?',
    sourceType: 'AUTHOR',
  });
  session = addAuthorContextItem(session, 'constraints', {
    text: 'Total budget is capped at $8,000 with no additional headcount available.',
    sourceType: 'ARTIFACT',
  });

  return session;
}

console.log('\nSession creation');

check('creates a DRAFT session with a random id and no frozen hashes', () => {
  const session = createSession(ARTIFACT_TEXT);
  assert.equal(session.state, 'DRAFT');
  assert.equal(typeof session.id, 'string');
  assert.ok(session.id.length > 0);
  assert.equal(session.artifactHash, null);
  assert.equal(session.authorContextHash, null);
  assert.equal(session.frozenAt, null);
});

check('rejects an empty artifact', () => {
  assert.throws(() => createSession(''), /non-empty string/);
});

console.log('\nAuthor context distinction');

check('author context separates ARTIFACT-sourced from AUTHOR-sourced items', () => {
  const session = buildFixtureSession();
  assert.equal(session.authorContext.confirmedFacts.length, 2);
  const artifactSourced = session.authorContext.confirmedFacts.filter((f) => f.sourceType === 'ARTIFACT');
  const authorSourced = session.authorContext.confirmedFacts.filter((f) => f.sourceType === 'AUTHOR');
  assert.equal(artifactSourced.length, 1);
  assert.equal(authorSourced.length, 1);
  // The author-known fact is recorded, but nothing about its sourceType claims independent verification.
  assert.equal(authorSourced[0].text.includes('pre-negotiated'), true);
});

check('each author context item gets an id, default CURRENT status, and createdAt', () => {
  const session = addAuthorContextItem(createSession(ARTIFACT_TEXT), 'knownRisks', {
    text: 'x',
    sourceType: 'AUTHOR',
  });
  const item = session.authorContext.knownRisks[0];
  assert.equal(typeof item.id, 'string');
  assert.equal(item.status, 'CURRENT');
  assert.equal(typeof item.createdAt, 'string');
});

console.log('\nAuthor context item status');

check('AuthorContextItem accepts CURRENT, RESOLVED, and SUPERSEDED explicitly', () => {
  for (const status of ['CURRENT', 'RESOLVED', 'SUPERSEDED']) {
    const session = addAuthorContextItem(createSession(ARTIFACT_TEXT), 'knownRisks', {
      text: 'x',
      sourceType: 'AUTHOR',
      status,
    });
    assert.equal(session.authorContext.knownRisks[0].status, status);
  }
});

check('AuthorContextItem rejects the old OPEN status value', () => {
  assert.throws(
    () =>
      addAuthorContextItem(createSession(ARTIFACT_TEXT), 'knownRisks', {
        text: 'x',
        sourceType: 'AUTHOR',
        status: 'OPEN',
      }),
    /invalid status/
  );
});

console.log('\nInput freezing');

check('freezeInput moves DRAFT -> INPUT_FROZEN and records both hashes', () => {
  const session = freezeInput(buildFixtureSession());
  assert.equal(session.state, 'INPUT_FROZEN');
  assert.equal(typeof session.frozenAt, 'string');
  assert.equal(session.artifactHash, sha256Text(session.artifactText));
  assert.equal(session.authorContextHash, sha256AuthorContext(session.authorContext));
});

check('freezing twice is rejected', () => {
  const frozen = freezeInput(buildFixtureSession());
  assert.throws(() => freezeInput(frozen), /must be in DRAFT/);
});

console.log('\nFrozen hashes');

check('frozen artifact hash changes if the artifact text differs', () => {
  const a = freezeInput(createSession('text A'));
  const b = freezeInput(createSession('text B'));
  assert.notEqual(a.artifactHash, b.artifactHash);
});

check('canonical AuthorContext hash is equal for the same exact item records in different array order', () => {
  // Same item VALUES (identical id/text/sourceType/status/createdAt), not
  // independently constructed sessions -- addAuthorContextItem assigns a
  // fresh random id/createdAt per call, so comparing two independently-built
  // sessions never actually proves order-independence, only that both
  // hashes are strings. Constructing the AuthorContext directly is the only
  // way to hold every field constant except array order.
  const itemA = { id: 'aaa-fixed-id', text: 'alpha', sourceType: 'ARTIFACT', status: 'CURRENT', createdAt: '2026-01-01T00:00:00.000Z' };
  const itemB = { id: 'bbb-fixed-id', text: 'beta', sourceType: 'ARTIFACT', status: 'CURRENT', createdAt: '2026-01-01T00:00:01.000Z' };
  const context1 = { confirmedFacts: [], knownRisks: [], openQuestions: [], constraints: [itemA, itemB] };
  const context2 = { confirmedFacts: [], knownRisks: [], openQuestions: [], constraints: [itemB, itemA] };
  assert.equal(sha256AuthorContext(context1), sha256AuthorContext(context2));
});

check('canonical AuthorContext hash changes when an item value differs', () => {
  const itemA = { id: 'aaa-fixed-id', text: 'alpha', sourceType: 'ARTIFACT', status: 'CURRENT', createdAt: '2026-01-01T00:00:00.000Z' };
  const itemAModified = { ...itemA, text: 'alpha, but modified' };
  const context1 = { confirmedFacts: [], knownRisks: [], openQuestions: [], constraints: [itemA] };
  const context2 = { confirmedFacts: [], knownRisks: [], openQuestions: [], constraints: [itemAModified] };
  assert.notEqual(sha256AuthorContext(context1), sha256AuthorContext(context2));
});

check('prohibition against silently changing frozen input: mutating helpers refuse to run once frozen', () => {
  const frozen = freezeInput(buildFixtureSession());
  assert.throws(
    () => addAuthorContextItem(frozen, 'openQuestions', { text: 'late addition', sourceType: 'AUTHOR' }),
    /frozen/
  );
  const before = { artifactHash: frozen.artifactHash, authorContextHash: frozen.authorContextHash };
  try {
    addAuthorContextItem(frozen, 'openQuestions', { text: 'late addition', sourceType: 'AUTHOR' });
  } catch {
    // expected
  }
  // The original frozen object itself is never mutated by the rejected call.
  assert.equal(frozen.artifactHash, before.artifactHash);
  assert.equal(frozen.authorContextHash, before.authorContextHash);
});

check('findings cannot be added before input is frozen', () => {
  const draft = buildFixtureSession();
  assert.throws(
    () =>
      addFinding(draft, {
        reviewerRunId: 'run-1',
        type: 'CLAIM',
        title: 'x',
        artifactLocation: 'x',
        evidenceState: 'NOT_APPLICABLE',
        whyMaterial: 'x',
        likelyRecipientChallenge: 'x',
        minimumBeforeSendAction: 'NONE',
      }),
    /must be frozen first/
  );
});

console.log('\nEvidence-state validation');

check('a finding can be recorded with each evidence-state value, including SUPPORTED_IN_MATERIAL', () => {
  let session = freezeInput(buildFixtureSession());
  for (const evidenceState of ['SUPPORTED_IN_MATERIAL', 'PARTIALLY_SUPPORTED', 'UNSUPPORTED_IN_MATERIAL', 'NOT_APPLICABLE']) {
    session = addFinding(session, {
      reviewerRunId: 'run-1',
      type: 'CLAIM',
      title: `probe ${evidenceState}`,
      artifactLocation: 'memo',
      evidenceState,
      whyMaterial: 'probe',
      likelyRecipientChallenge: 'probe',
      minimumBeforeSendAction: 'NONE',
    });
  }
  const states = Object.values(session.findings).map((f) => f.evidenceState).sort();
  assert.deepEqual(states, ['NOT_APPLICABLE', 'PARTIALLY_SUPPORTED', 'SUPPORTED_IN_MATERIAL', 'UNSUPPORTED_IN_MATERIAL'].sort());
});

console.log('\nFinding creation');

check('addFinding transitions INPUT_FROZEN -> REVIEWED on the first finding', () => {
  let session = freezeInput(buildFixtureSession());
  assert.equal(session.state, 'INPUT_FROZEN');
  session = addFinding(session, {
    reviewerRunId: 'run-1',
    type: 'CLAIM',
    title: 'Pilot-user testing claim is directly supported by the memo',
    artifactLocation: 'paragraph 1',
    evidenceState: 'SUPPORTED_IN_MATERIAL',
    whyMaterial: 'The claim is checkable against the memo itself.',
    likelyRecipientChallenge: 'n/a',
    minimumBeforeSendAction: 'NONE',
  });
  assert.equal(session.state, 'REVIEWED');
  assert.equal(Object.keys(session.findings).length, 1);
});

check('reviewer findings do not carry a materiality field', () => {
  let session = freezeInput(buildFixtureSession());
  session = addFinding(session, {
    reviewerRunId: 'run-1',
    type: 'EXECUTION_RISK',
    title: 'x',
    artifactLocation: 'x',
    evidenceState: 'UNSUPPORTED_IN_MATERIAL',
    whyMaterial: 'x',
    likelyRecipientChallenge: 'x',
    minimumBeforeSendAction: 'NONE',
  });
  const finding = Object.values(session.findings)[0];
  assert.equal('materiality' in finding, false);
});

console.log('\nMultiple findings -> one semantic issue');

function buildReviewedFixtureSession() {
  let session = freezeInput(buildFixtureSession());

  session = addFinding(session, {
    reviewerRunId: 'run-A',
    type: 'CLAIM',
    title: 'Pilot-user testing claim is directly supported by the memo',
    artifactLocation: 'paragraph 1',
    evidenceState: 'SUPPORTED_IN_MATERIAL',
    whyMaterial: 'The claim is checkable against the memo itself and matches the recorded pilot fact.',
    likelyRecipientChallenge: 'n/a',
    minimumBeforeSendAction: 'NONE',
  });

  session = addFinding(session, {
    reviewerRunId: 'run-A',
    type: 'EXECUTION_RISK',
    title: 'IT capacity for 500-account provisioning is not confirmed',
    artifactLocation: 'paragraph 2 ("IT will handle account provisioning")',
    evidenceState: 'UNSUPPORTED_IN_MATERIAL',
    whyMaterial: 'A rollout to 500 employees can stall entirely if IT cannot provision accounts fast enough.',
    likelyRecipientChallenge: 'Has IT actually confirmed they can provision 500 accounts in this window?',
    minimumBeforeSendAction: 'Confirm IT provisioning capacity before committing to the two-week window.',
  });

  session = addFinding(session, {
    reviewerRunId: 'run-B',
    type: 'EXECUTION_RISK',
    title: 'Two-week timeline allocates no time for account provisioning at scale',
    artifactLocation: 'paragraph 1 ("two-week window")',
    evidenceState: 'UNSUPPORTED_IN_MATERIAL',
    whyMaterial: 'If provisioning 500 accounts takes longer than expected, the launch date itself is at risk.',
    likelyRecipientChallenge: 'What happens to the launch date if provisioning takes longer than expected?',
    minimumBeforeSendAction: 'Add explicit provisioning time to the timeline.',
  });

  session = addFinding(session, {
    reviewerRunId: 'run-A',
    type: 'AMBIGUITY',
    title: 'No rollback plan is described if adoption fails',
    artifactLocation: 'memo (absent)',
    evidenceState: 'NOT_APPLICABLE',
    whyMaterial: 'Without a rollback plan, a failed rollout has no defined recovery path.',
    likelyRecipientChallenge: 'What do we do if adoption is low after 30 days?',
    minimumBeforeSendAction: 'NONE',
  });

  session = addFinding(session, {
    reviewerRunId: 'run-B',
    type: 'CLAIM',
    title: 'The $8,000 budget figure looks implausibly low for licensing 500 seats',
    artifactLocation: 'paragraph 3',
    evidenceState: 'UNSUPPORTED_IN_MATERIAL',
    whyMaterial: 'If the figure is wrong, the whole budget section is unreliable.',
    likelyRecipientChallenge: 'Is $8,000 really enough for 500 licenses?',
    minimumBeforeSendAction: 'Confirm the per-seat cost basis.',
  });

  return session;
}

check('two independent findings can be clustered under one semantic issue without deleting them', () => {
  const session = buildReviewedFixtureSession();
  const findingIds = Object.values(session.findings)
    .filter((f) => f.title.includes('IT capacity') || f.title.includes('Two-week timeline'))
    .map((f) => f.id);
  assert.equal(findingIds.length, 2);

  const clustered = createSemanticIssue(session, {
    title: 'IT provisioning capacity and timeline are unconfirmed for the 500-user rollout',
    description: 'Two separately-worded findings both point at the same unconfirmed dependency: whether IT can provision 500 accounts inside the stated two-week window.',
    findingIds,
    evidenceState: 'UNSUPPORTED_IN_MATERIAL',
  });

  const issue = Object.values(clustered.semanticIssues)[0];
  assert.equal(issue.findingIds.length, 2);
  assert.deepEqual([...issue.findingIds].sort(), [...findingIds].sort());
  // Original findings remain untouched, individually addressable.
  assert.equal(Object.keys(clustered.findings).length, Object.keys(session.findings).length);
  for (const id of findingIds) assert.ok(clustered.findings[id]);
});

check('createSemanticIssue rejects an unknown findingId', () => {
  const session = buildReviewedFixtureSession();
  assert.throws(
    () =>
      createSemanticIssue(session, {
        title: 'x',
        description: 'x',
        findingIds: ['not-a-real-id'],
        evidenceState: 'NOT_APPLICABLE',
      }),
    /unknown findingId/
  );
});

console.log('\nHuman adjudication');

function buildAdjudicatedFixtureSession() {
  const session = buildReviewedFixtureSession();
  const byTitle = (fragment) => Object.values(session.findings).find((f) => f.title.includes(fragment));

  const itFindingIds = [byTitle('IT capacity').id, byTitle('Two-week timeline').id];
  let withIssue = createSemanticIssue(session, {
    title: 'IT provisioning capacity and timeline are unconfirmed for the 500-user rollout',
    description: 'Two findings converge on the same unconfirmed IT-provisioning dependency.',
    findingIds: itFindingIds,
    evidenceState: 'UNSUPPORTED_IN_MATERIAL',
  });
  const itIssueId = Object.keys(withIssue.semanticIssues)[0];

  // NEW_MATERIAL, actionChange=YES -- adjudicated at the semantic-issue level.
  withIssue = adjudicate(withIssue, {
    semanticIssueId: itIssueId,
    judgment: 'NEW_MATERIAL',
    actionChange: 'YES',
    note: 'Not previously raised, and would block launch if IT cannot keep up.',
  });

  // KNOWN_PRE_DISPATCH -- adjudicated directly at the finding level (no semantic issue).
  const rollbackFindingId = byTitle('rollback plan').id;
  withIssue = adjudicate(withIssue, {
    findingId: rollbackFindingId,
    judgment: 'KNOWN_PRE_DISPATCH',
    actionChange: 'NO',
    note: 'Already flagged in a prior team review; not new.',
  });

  // WRONG -- adjudicated directly at the finding level.
  const budgetFindingId = byTitle('$8,000 budget figure').id;
  withIssue = adjudicate(withIssue, {
    findingId: budgetFindingId,
    judgment: 'WRONG',
    actionChange: 'NO',
    note: 'Confirmed with the author: $8,000 is a pre-negotiated volume rate, not a retail estimate.',
  });

  return { session: withIssue, itIssueId, rollbackFindingId, budgetFindingId };
}

check('semantic-issue-level adjudication marks the issue ADJUDICATED and is stored separately from the finding', () => {
  const { session, itIssueId } = buildAdjudicatedFixtureSession();
  const issue = session.semanticIssues[itIssueId];
  assert.equal(issue.status, 'ADJUDICATED');
  const adjudication = Object.values(session.adjudications).find((a) => a.semanticIssueId === itIssueId);
  assert.equal(adjudication.judgment, 'NEW_MATERIAL');
  assert.equal(adjudication.actionChange, 'YES');
  // The underlying findings are untouched by adjudication.
  for (const findingId of issue.findingIds) {
    assert.equal('judgment' in session.findings[findingId], false);
  }
});

check('finding-level adjudication does not require a semantic issue', () => {
  const { session, rollbackFindingId, budgetFindingId } = buildAdjudicatedFixtureSession();
  const rollback = Object.values(session.adjudications).find((a) => a.findingId === rollbackFindingId);
  const budget = Object.values(session.adjudications).find((a) => a.findingId === budgetFindingId);
  assert.equal(rollback.judgment, 'KNOWN_PRE_DISPATCH');
  assert.equal(budget.judgment, 'WRONG');
});

check('adjudicate requires exactly one of semanticIssueId or findingId', () => {
  const session = buildReviewedFixtureSession();
  const findingId = Object.keys(session.findings)[0];
  assert.throws(
    () => adjudicate(session, { judgment: 'WRONG', actionChange: 'NO' }),
    /exactly one/
  );
  assert.throws(
    () =>
      adjudicate(session, {
        findingId,
        semanticIssueId: 'anything',
        judgment: 'WRONG',
        actionChange: 'NO',
      }),
    /exactly one/
  );
});

check('session state advances REVIEWED -> ADJUDICATED on the first adjudication', () => {
  const { session } = buildAdjudicatedFixtureSession();
  assert.equal(session.state, 'ADJUDICATED');
});

console.log('\nRevision action linkage');

check('a NEW_MATERIAL + actionChange=YES issue can produce a PLANNED then IMPLEMENTED revision action', () => {
  const { session, itIssueId } = buildAdjudicatedFixtureSession();
  let withAction = planRevisionAction(session, {
    sourceRefs: [{ kind: 'SEMANTIC_ISSUE', id: itIssueId }],
    description: 'Add a paragraph committing to confirm IT provisioning capacity, and add explicit provisioning time to the rollout timeline, before the launch date is finalized.',
    targetLocation: 'Rollout Plan section',
  });
  assert.equal(withAction.state, 'REVISION_PLANNED');
  const actionId = Object.keys(withAction.revisionActions)[0];
  assert.equal(withAction.revisionActions[actionId].status, 'PLANNED');
  assert.deepEqual(withAction.revisionActions[actionId].sourceRefs, [{ kind: 'SEMANTIC_ISSUE', id: itIssueId }]);

  const implemented = implementRevisionAction(withAction, actionId);
  assert.equal(implemented.revisionActions[actionId].status, 'IMPLEMENTED');
});

check('a revision action can instead be REJECTED, and re-resolving an already-resolved action is refused', () => {
  const { session, itIssueId } = buildAdjudicatedFixtureSession();
  const withAction = planRevisionAction(session, {
    sourceRefs: [{ kind: 'SEMANTIC_ISSUE', id: itIssueId }],
    description: 'x',
    targetLocation: 'x',
  });
  const actionId = Object.keys(withAction.revisionActions)[0];
  const rejected = rejectRevisionAction(withAction, actionId);
  assert.equal(rejected.revisionActions[actionId].status, 'REJECTED');
  assert.throws(() => implementRevisionAction(rejected, actionId), /not PLANNED/);
});

check('completeSession refuses while a revision action is still PLANNED, and succeeds once resolved', () => {
  const { session, itIssueId } = buildAdjudicatedFixtureSession();
  const planned = planRevisionAction(session, {
    sourceRefs: [{ kind: 'SEMANTIC_ISSUE', id: itIssueId }],
    description: 'x',
    targetLocation: 'x',
  });
  assert.throws(() => completeSession(planned), /still PLANNED/);
  const actionId = Object.keys(planned.revisionActions)[0];
  const done = completeSession(implementRevisionAction(planned, actionId));
  assert.equal(done.state, 'COMPLETED');
});

console.log('\nRevision source provenance (discriminated refs)');

check('planRevisionAction accepts a SEMANTIC_ISSUE-kind source ref', () => {
  const { session, itIssueId } = buildAdjudicatedFixtureSession();
  const withAction = planRevisionAction(session, {
    sourceRefs: [{ kind: 'SEMANTIC_ISSUE', id: itIssueId }],
    description: 'x',
    targetLocation: 'x',
  });
  const actionId = Object.keys(withAction.revisionActions)[0];
  assert.deepEqual(withAction.revisionActions[actionId].sourceRefs, [{ kind: 'SEMANTIC_ISSUE', id: itIssueId }]);
});

check('planRevisionAction accepts a FINDING-kind source ref backed by a HumanAdjudication with actionChange=YES', () => {
  let session = freezeInput(createSession(ARTIFACT_TEXT));
  session = addFinding(session, {
    reviewerRunId: 'run-1',
    type: 'CLAIM',
    title: 'x',
    artifactLocation: 'x',
    evidenceState: 'NOT_APPLICABLE',
    whyMaterial: 'x',
    likelyRecipientChallenge: 'x',
    minimumBeforeSendAction: 'NONE',
  });
  const findingId = Object.keys(session.findings)[0];
  // KNOWN_PRE_DISPATCH -- judgment is deliberately not what gates authorization; actionChange=YES is.
  session = adjudicate(session, {
    findingId,
    judgment: 'KNOWN_PRE_DISPATCH',
    actionChange: 'YES',
    note: 'Already known, but the author wants it fixed anyway.',
  });
  const withAction = planRevisionAction(session, {
    sourceRefs: [{ kind: 'FINDING', id: findingId }],
    description: 'x',
    targetLocation: 'x',
  });
  const actionId = Object.keys(withAction.revisionActions)[0];
  assert.deepEqual(withAction.revisionActions[actionId].sourceRefs, [{ kind: 'FINDING', id: findingId }]);
});

check('planRevisionAction rejects an unrecognized source ref kind', () => {
  const { session, budgetFindingId } = buildAdjudicatedFixtureSession();
  assert.throws(
    () =>
      planRevisionAction(session, {
        sourceRefs: [{ kind: 'NOT_A_KIND', id: budgetFindingId }],
        description: 'x',
        targetLocation: 'x',
      }),
    /invalid source ref kind/
  );
});

check('planRevisionAction rejects a SEMANTIC_ISSUE ref whose id does not exist', () => {
  const { session } = buildAdjudicatedFixtureSession();
  assert.throws(
    () =>
      planRevisionAction(session, {
        sourceRefs: [{ kind: 'SEMANTIC_ISSUE', id: 'not-a-real-id' }],
        description: 'x',
        targetLocation: 'x',
      }),
    /unknown semantic issue id/
  );
});

check('planRevisionAction rejects a FINDING ref whose id does not exist', () => {
  const { session } = buildAdjudicatedFixtureSession();
  assert.throws(
    () =>
      planRevisionAction(session, {
        sourceRefs: [{ kind: 'FINDING', id: 'not-a-real-id' }],
        description: 'x',
        targetLocation: 'x',
      }),
    /unknown finding id/
  );
});

console.log('\nDecision-record generation');

function buildCompletedFixtureSession() {
  const { session, itIssueId } = buildAdjudicatedFixtureSession();
  const withAction = planRevisionAction(session, {
    sourceRefs: [{ kind: 'SEMANTIC_ISSUE', id: itIssueId }],
    description: 'Add a paragraph committing to confirm IT provisioning capacity, and add explicit provisioning time to the rollout timeline, before the launch date is finalized.',
    targetLocation: 'Rollout Plan section',
  });
  const actionId = Object.keys(withAction.revisionActions)[0];
  return completeSession(implementRevisionAction(withAction, actionId));
}

check('the decision record answers what was reviewed, known, raised, new, material, and changed', () => {
  const session = buildCompletedFixtureSession();
  const record = generateDecisionRecord(session);

  assert.equal(record.sessionId, session.id);
  assert.equal(record.sessionState, 'COMPLETED');
  assert.equal(record.artifactHash, session.artifactHash);
  assert.equal(record.authorContextHash, session.authorContextHash);

  assert.equal(record.authorKnownSummary.confirmedFacts, 2);
  assert.equal(record.authorKnownSummary.knownRisks, 1);
  assert.equal(record.authorKnownSummary.openQuestions, 1);
  assert.equal(record.authorKnownSummary.constraints, 1);

  assert.equal(record.totalFindings, 5);
  assert.equal(record.totalSemanticIssues, 1);
  assert.equal(record.newMaterialCount, 1);
  assert.equal(record.knownPreDispatchCount, 1);
  assert.equal(record.wrongCount, 1);
  assert.equal(record.actionChangeYesCount, 1);
  assert.equal(record.implementedRevisionCount, 1);
  assert.equal(record.plannedRevisionCount, 0);
  assert.equal(record.rejectedRevisionCount, 0);

  const itIssueEntry = record.issues.find((i) => i.title.includes('IT provisioning'));
  assert.equal(itIssueEntry.judgment, 'NEW_MATERIAL');
  assert.equal(itIssueEntry.actionChange, 'YES');
  assert.equal(itIssueEntry.findingIds.length, 2);
  assert.deepEqual(itIssueEntry.revisionActionStatuses, ['IMPLEMENTED']);

  assert.equal(record.standaloneFindingAdjudications.length, 2);
  const rollback = record.standaloneFindingAdjudications.find((a) => a.findingTitle.includes('rollback plan'));
  const budget = record.standaloneFindingAdjudications.find((a) => a.findingTitle.includes('$8,000'));
  assert.equal(rollback.judgment, 'KNOWN_PRE_DISPATCH');
  assert.equal(rollback.actionChange, 'NO');
  assert.equal(budget.judgment, 'WRONG');
  assert.equal(budget.actionChange, 'NO');
});

check('DecisionRecord preserves revision source provenance across both SEMANTIC_ISSUE and FINDING refs', () => {
  const { session, itIssueId, budgetFindingId } = buildAdjudicatedFixtureSession();
  const withAction = planRevisionAction(session, {
    sourceRefs: [
      { kind: 'SEMANTIC_ISSUE', id: itIssueId },
      { kind: 'FINDING', id: budgetFindingId },
    ],
    description: 'x',
    targetLocation: 'x',
  });
  const actionId = Object.keys(withAction.revisionActions)[0];
  const completed = completeSession(implementRevisionAction(withAction, actionId));
  const record = generateDecisionRecord(completed);

  // The same revision action is traceable both from the semantic issue it targets...
  const itIssueEntry = record.issues.find((i) => i.title.includes('IT provisioning'));
  assert.deepEqual(itIssueEntry.revisionActionIds, [actionId]);
  // ...and from the standalone finding it also targets.
  const budgetEntry = record.standaloneFindingAdjudications.find((a) => a.findingTitle.includes('$8,000'));
  assert.deepEqual(budgetEntry.revisionActionIds, [actionId]);
  // The underlying RevisionAction itself keeps the full discriminated source list.
  assert.deepEqual(completed.revisionActions[actionId].sourceRefs, [
    { kind: 'SEMANTIC_ISSUE', id: itIssueId },
    { kind: 'FINDING', id: budgetFindingId },
  ]);
});

check('renderDecisionRecordMarkdown produces readable markdown covering the summary and every issue', () => {
  const session = buildCompletedFixtureSession();
  const record = generateDecisionRecord(session);
  const md = renderDecisionRecordMarkdown(record);
  assert.match(md, /# Decision Record/);
  assert.match(md, /NEW_MATERIAL: 1/);
  assert.match(md, /KNOWN_PRE_DISPATCH: 1/);
  assert.match(md, /WRONG: 1/);
  assert.match(md, /IT provisioning capacity and timeline/);
  assert.match(md, /Standalone finding adjudications/);
  assert.match(md, /rollback plan/);
  assert.match(md, /IMPLEMENTED/);
});

console.log('\nFrozen-input tamper detection');

const probeFinding = {
  reviewerRunId: 'run-1',
  type: 'CLAIM',
  title: 'x',
  artifactLocation: 'x',
  evidenceState: 'NOT_APPLICABLE',
  whyMaterial: 'x',
  likelyRecipientChallenge: 'x',
  minimumBeforeSendAction: 'NONE',
};

check('direct post-freeze artifactText tampering is detected', () => {
  const frozen = freezeInput(buildFixtureSession());
  const tampered = { ...frozen, artifactText: frozen.artifactText + ' TAMPERED' };
  assert.throws(() => addFinding(tampered, probeFinding), /no longer matches its frozen artifactHash/);
});

check('direct post-freeze authorContext tampering is detected', () => {
  const frozen = freezeInput(buildFixtureSession());
  const sneakedItem = { id: 'x', text: 'sneaked in', sourceType: 'AUTHOR', status: 'CURRENT', createdAt: new Date().toISOString() };
  const tampered = {
    ...frozen,
    authorContext: { ...frozen.authorContext, constraints: [...frozen.authorContext.constraints, sneakedItem] },
  };
  assert.throws(() => addFinding(tampered, probeFinding), /no longer matches its frozen authorContextHash/);
});

check('stored hashes are never silently refreshed after tampering', () => {
  const frozen = freezeInput(buildFixtureSession());
  const tampered = { ...frozen, artifactText: frozen.artifactText + ' TAMPERED' };
  const storedHashBefore = tampered.artifactHash;
  try {
    addFinding(tampered, probeFinding);
  } catch {
    // expected
  }
  assert.equal(tampered.artifactHash, storedHashBefore);
  assert.notEqual(tampered.artifactHash, sha256Text(tampered.artifactText));
});

check('the integrity check applies to every audit-trail operation, not just addFinding', () => {
  const session = buildCompletedFixtureSession();
  const tampered = { ...session, artifactText: session.artifactText + ' TAMPERED' };
  assert.throws(() => generateDecisionRecord(tampered), /no longer matches its frozen artifactHash/);
});

console.log('\nState machine enforcement');

check('addFinding is rejected once the session has moved past REVIEWED', () => {
  const attempt = (s) => addFinding(s, probeFinding);

  const { session: adjudicated } = buildAdjudicatedFixtureSession();
  assert.throws(() => attempt(adjudicated), /not permitted in state=ADJUDICATED/);

  const { session: forPlanning, itIssueId } = buildAdjudicatedFixtureSession();
  const revisionPlanned = planRevisionAction(forPlanning, {
    sourceRefs: [{ kind: 'SEMANTIC_ISSUE', id: itIssueId }],
    description: 'x',
    targetLocation: 'x',
  });
  assert.throws(() => attempt(revisionPlanned), /not permitted in state=REVISION_PLANNED/);

  const completed = buildCompletedFixtureSession();
  assert.throws(() => attempt(completed), /not permitted in state=COMPLETED/);
});

check('adjudicate is rejected before REVIEWED and after COMPLETED', () => {
  const frozenOnly = freezeInput(buildFixtureSession());
  assert.throws(
    () => adjudicate(frozenOnly, { findingId: 'whatever', judgment: 'WRONG', actionChange: 'NO' }),
    /not permitted in state=INPUT_FROZEN/
  );

  const completed = buildCompletedFixtureSession();
  const anyFindingId = Object.keys(completed.findings)[0];
  assert.throws(
    () => adjudicate(completed, { findingId: anyFindingId, judgment: 'WRONG', actionChange: 'NO' }),
    /not permitted in state=COMPLETED/
  );
});

check('planRevisionAction is rejected before ADJUDICATED', () => {
  const session = buildReviewedFixtureSession();
  const findingId = Object.keys(session.findings)[0];
  assert.throws(
    () =>
      planRevisionAction(session, {
        sourceRefs: [{ kind: 'FINDING', id: findingId }],
        description: 'x',
        targetLocation: 'x',
      }),
    /not permitted in state=REVIEWED/
  );
});

check('COMPLETED is terminal: no operation can append to or reopen a completed session', () => {
  const completed = buildCompletedFixtureSession();
  const anyFindingId = Object.keys(completed.findings)[0];
  const anyIssueId = Object.keys(completed.semanticIssues)[0];
  const anyActionId = Object.keys(completed.revisionActions)[0];

  assert.throws(() => addFinding(completed, probeFinding), /not permitted in state=COMPLETED/);
  assert.throws(
    () => createSemanticIssue(completed, { title: 'x', description: 'x', findingIds: [anyFindingId], evidenceState: 'NOT_APPLICABLE' }),
    /not permitted in state=COMPLETED/
  );
  assert.throws(
    () => adjudicate(completed, { findingId: anyFindingId, judgment: 'WRONG', actionChange: 'NO' }),
    /not permitted in state=COMPLETED/
  );
  assert.throws(
    () => planRevisionAction(completed, { sourceRefs: [{ kind: 'SEMANTIC_ISSUE', id: anyIssueId }], description: 'x', targetLocation: 'x' }),
    /not permitted in state=COMPLETED/
  );
  assert.throws(() => implementRevisionAction(completed, anyActionId), /not permitted in state=COMPLETED/);
  assert.throws(() => rejectRevisionAction(completed, anyActionId), /not permitted in state=COMPLETED/);
  assert.throws(() => completeSession(completed), /must be ADJUDICATED or REVISION_PLANNED/);
});

console.log('\nHuman change authorization gate');

check('planRevisionAction rejects when no referenced adjudication has actionChange=YES', () => {
  const { session, rollbackFindingId, budgetFindingId } = buildAdjudicatedFixtureSession();
  assert.throws(
    () => planRevisionAction(session, { sourceRefs: [{ kind: 'FINDING', id: rollbackFindingId }], description: 'x', targetLocation: 'x' }),
    /actionChange=YES/
  );
  assert.throws(
    () => planRevisionAction(session, { sourceRefs: [{ kind: 'FINDING', id: budgetFindingId }], description: 'x', targetLocation: 'x' }),
    /actionChange=YES/
  );
});

check('planRevisionAction succeeds once at least one referenced adjudication has actionChange=YES, even mixed with a NO', () => {
  const { session, itIssueId, budgetFindingId } = buildAdjudicatedFixtureSession();
  const withAction = planRevisionAction(session, {
    sourceRefs: [
      { kind: 'SEMANTIC_ISSUE', id: itIssueId },
      { kind: 'FINDING', id: budgetFindingId },
    ],
    description: 'x',
    targetLocation: 'x',
  });
  assert.equal(Object.keys(withAction.revisionActions).length, 1);
});

console.log('\nDuplicate human adjudication');

check('duplicate adjudication of the same semantic issue is rejected', () => {
  const { session, itIssueId } = buildAdjudicatedFixtureSession();
  assert.throws(
    () => adjudicate(session, { semanticIssueId: itIssueId, judgment: 'WRONG', actionChange: 'NO' }),
    /already has a HumanAdjudication/
  );
});

check('duplicate adjudication of the same finding is rejected', () => {
  const { session, rollbackFindingId } = buildAdjudicatedFixtureSession();
  assert.throws(
    () => adjudicate(session, { findingId: rollbackFindingId, judgment: 'WRONG', actionChange: 'NO' }),
    /already has a HumanAdjudication/
  );
});

console.log('\nRevision source kind discrimination in DecisionRecord projection');

check('DecisionRecord matches revision actions by kind AND id, never by id alone, even under an id collision', () => {
  const sharedId = 'shared-id-collision-test';
  const emptyContext = { confirmedFacts: [], knownRisks: [], openQuestions: [], constraints: [] };
  const session = {
    id: 'sess-1',
    state: 'COMPLETED',
    createdAt: new Date().toISOString(),
    artifactText: 'x',
    authorContext: emptyContext,
    frozenAt: new Date().toISOString(),
    artifactHash: sha256Text('x'),
    authorContextHash: sha256AuthorContext(emptyContext),
    findings: {
      [sharedId]: {
        id: sharedId,
        reviewerRunId: 'run-1',
        type: 'CLAIM',
        title: 'Finding with a colliding id',
        artifactLocation: 'x',
        evidenceState: 'NOT_APPLICABLE',
        whyMaterial: 'x',
        likelyRecipientChallenge: 'x',
        minimumBeforeSendAction: 'NONE',
        createdAt: new Date().toISOString(),
      },
    },
    semanticIssues: {
      [sharedId]: {
        id: sharedId,
        title: 'Issue with a colliding id',
        description: 'x',
        findingIds: [],
        evidenceState: 'NOT_APPLICABLE',
        status: 'ADJUDICATED',
      },
    },
    adjudications: {
      'adj-1': {
        id: 'adj-1',
        findingId: sharedId,
        judgment: 'KNOWN_PRE_DISPATCH',
        actionChange: 'YES',
        note: '',
        adjudicatedAt: new Date().toISOString(),
      },
    },
    revisionActions: {
      'rev-1': {
        id: 'rev-1',
        sourceRefs: [{ kind: 'FINDING', id: sharedId }],
        description: 'x',
        targetLocation: 'x',
        status: 'IMPLEMENTED',
        createdAt: new Date().toISOString(),
      },
    },
  };

  const record = generateDecisionRecord(session);
  // rev-1's ref is kind:FINDING -- it must attribute only to the standalone finding...
  assert.equal(record.standaloneFindingAdjudications.length, 1);
  assert.deepEqual(record.standaloneFindingAdjudications[0].revisionActionIds, ['rev-1']);
  // ...and never to the semantic issue that merely happens to share the same id string.
  assert.equal(record.issues.length, 1);
  assert.deepEqual(record.issues[0].revisionActionIds, []);
});

console.log('\nOpen question lifecycle in DecisionRecord');

check('DecisionRecord.openQuestions includes only CURRENT items; RESOLVED/SUPERSEDED stay in context but are excluded from "remaining open"', () => {
  let session = createSession(ARTIFACT_TEXT);
  session = addAuthorContextItem(session, 'openQuestions', { text: 'Still open question', sourceType: 'AUTHOR', status: 'CURRENT' });
  session = addAuthorContextItem(session, 'openQuestions', { text: 'Resolved question', sourceType: 'AUTHOR', status: 'RESOLVED' });
  session = addAuthorContextItem(session, 'openQuestions', { text: 'Superseded question', sourceType: 'AUTHOR', status: 'SUPERSEDED' });
  session = freezeInput(session);
  const record = generateDecisionRecord(session);

  assert.deepEqual(record.openQuestions, ['Still open question']);
  // The structural count stays the total, unfiltered, like the other authorKnownSummary fields.
  assert.equal(record.authorKnownSummary.openQuestions, 3);
  // Nothing is deleted from authorContext itself -- RESOLVED/SUPERSEDED remain for provenance.
  assert.equal(session.authorContext.openQuestions.length, 3);

  const md = renderDecisionRecordMarkdown(record);
  assert.match(md, /Still open question/);
  assert.equal(md.includes('Resolved question'), false);
  assert.equal(md.includes('Superseded question'), false);
});

console.log('\nRevision successor binding (P2-A)');

const AUTHOR_CONTEXT_CATEGORIES = ['confirmedFacts', 'knownRisks', 'openQuestions', 'constraints'];

const REVISED_ARTIFACT_TEXT = `Project Comet — Internal Launch Memo

We are rolling out TaskFlow Lite to all 500 employees over a two-week window.
Pilot testing with 20 employees ran for two weeks with no major issues.
Total budget for licensing is capped at $8,000, with no additional headcount
available for the rollout. IT has confirmed capacity to provision all 500
accounts within the rollout window, beginning one week before go-live.`;

function buildImplementedFixtureSession() {
  const { session, itIssueId } = buildAdjudicatedFixtureSession();
  const withAction = planRevisionAction(session, {
    sourceRefs: [{ kind: 'SEMANTIC_ISSUE', id: itIssueId }],
    description: 'Add a paragraph confirming IT provisioning capacity and an explicit provisioning timeline.',
    targetLocation: 'Rollout Plan section',
  });
  const actionId = Object.keys(withAction.revisionActions)[0];
  const implemented = implementRevisionAction(withAction, actionId);
  return { session: implemented, actionId };
}

check('A. an IMPLEMENTED RevisionAction allows createRevisionSuccessorSession to produce a successor', () => {
  const { session } = buildImplementedFixtureSession();
  const { successorSession } = createRevisionSuccessorSession(session, REVISED_ARTIFACT_TEXT);
  assert.equal(successorSession.state, 'INPUT_FROZEN');
  assert.equal(successorSession.artifactText, REVISED_ARTIFACT_TEXT);
  assert.notEqual(successorSession.artifactHash, null);
});

check('B. the returned sourceSession has a non-null revisionSuccessor binding', () => {
  const { session } = buildImplementedFixtureSession();
  const { sourceSession } = createRevisionSuccessorSession(session, REVISED_ARTIFACT_TEXT);
  assert.notEqual(sourceSession.revisionSuccessor, null);
  assert.equal(typeof sourceSession.revisionSuccessor.createdAt, 'string');
});

check("C. binding's six identity/hash facts exactly match source/successor", () => {
  const { session } = buildImplementedFixtureSession();
  const { sourceSession, successorSession } = createRevisionSuccessorSession(session, REVISED_ARTIFACT_TEXT);
  const binding = sourceSession.revisionSuccessor;
  assert.equal(binding.sourceSessionId, session.id);
  assert.equal(binding.sourceArtifactHash, session.artifactHash);
  assert.equal(binding.sourceAuthorContextHash, session.authorContextHash);
  assert.equal(binding.successorSessionId, successorSession.id);
  assert.equal(binding.successorArtifactHash, successorSession.artifactHash);
  assert.equal(binding.successorAuthorContextHash, successorSession.authorContextHash);
});

check('D. successor artifactHash differs from source artifactHash', () => {
  const { session } = buildImplementedFixtureSession();
  const { successorSession } = createRevisionSuccessorSession(session, REVISED_ARTIFACT_TEXT);
  assert.notEqual(successorSession.artifactHash, session.artifactHash);
});

check('E. successor AuthorContext has the same semantic text/sourceType/status per category as source', () => {
  const { session } = buildImplementedFixtureSession();
  const { successorSession } = createRevisionSuccessorSession(session, REVISED_ARTIFACT_TEXT);
  for (const category of AUTHOR_CONTEXT_CATEGORIES) {
    const sourceItems = session.authorContext[category];
    const successorItems = successorSession.authorContext[category];
    assert.equal(successorItems.length, sourceItems.length);
    for (let i = 0; i < sourceItems.length; i++) {
      assert.equal(successorItems[i].text, sourceItems[i].text);
      assert.equal(successorItems[i].sourceType, sourceItems[i].sourceType);
      assert.equal(successorItems[i].status, sourceItems[i].status);
    }
  }
});

check('F. successor AuthorContext item ids are freshly minted, never reused from source', () => {
  const { session } = buildImplementedFixtureSession();
  const { successorSession } = createRevisionSuccessorSession(session, REVISED_ARTIFACT_TEXT);
  for (const category of AUTHOR_CONTEXT_CATEGORIES) {
    const sourceIds = new Set(session.authorContext[category].map((item) => item.id));
    for (const item of successorSession.authorContext[category]) {
      assert.equal(sourceIds.has(item.id), false);
    }
  }
});

check('G. successor AuthorContext arrays/items do not alias source arrays/items', () => {
  const { session } = buildImplementedFixtureSession();
  const { successorSession } = createRevisionSuccessorSession(session, REVISED_ARTIFACT_TEXT);
  for (const category of AUTHOR_CONTEXT_CATEGORIES) {
    assert.notStrictEqual(successorSession.authorContext[category], session.authorContext[category]);
    for (let i = 0; i < session.authorContext[category].length; i++) {
      assert.notStrictEqual(successorSession.authorContext[category][i], session.authorContext[category][i]);
    }
  }
});

check('H. the caller-supplied sourceSession object is not mutated in place', () => {
  const { session } = buildImplementedFixtureSession();
  const snapshotJson = JSON.stringify(session);
  createRevisionSuccessorSession(session, REVISED_ARTIFACT_TEXT);
  assert.equal(JSON.stringify(session), snapshotJson);
  assert.equal(session.revisionSuccessor, null);
});

check('I. assertRevisionSuccessorIntegrity accepts a genuinely valid source/successor pair', () => {
  const { session } = buildImplementedFixtureSession();
  const { sourceSession, successorSession } = createRevisionSuccessorSession(session, REVISED_ARTIFACT_TEXT);
  assert.doesNotThrow(() => assertRevisionSuccessorIntegrity(sourceSession, successorSession));
});

check('J. a whitespace-only revised artifact is a legal successor as long as the hash changes', () => {
  const { session } = buildImplementedFixtureSession();
  const whitespaceOnly = session.artifactText + ' ';
  const { successorSession } = createRevisionSuccessorSession(session, whitespaceOnly);
  assert.notEqual(successorSession.artifactHash, session.artifactHash);
  assert.equal(successorSession.artifactText, whitespaceOnly);
});

check('K. a DRAFT source is rejected (frozen-or-later required)', () => {
  const draft = createSession(ARTIFACT_TEXT);
  assert.throws(() => createRevisionSuccessorSession(draft, REVISED_ARTIFACT_TEXT), /frozen first/);
});

check('L. a source with zero RevisionActions is rejected', () => {
  const session = freezeInput(createSession(ARTIFACT_TEXT));
  assert.throws(() => createRevisionSuccessorSession(session, REVISED_ARTIFACT_TEXT), /no IMPLEMENTED RevisionAction/);
});

check('M. a source whose only RevisionAction is still PLANNED is rejected', () => {
  const { session, itIssueId } = buildAdjudicatedFixtureSession();
  const withAction = planRevisionAction(session, {
    sourceRefs: [{ kind: 'SEMANTIC_ISSUE', id: itIssueId }],
    description: 'x',
    targetLocation: 'x',
  });
  assert.throws(
    () => createRevisionSuccessorSession(withAction, REVISED_ARTIFACT_TEXT),
    /no IMPLEMENTED RevisionAction/
  );
});

check('N. a source whose only RevisionAction is REJECTED is rejected', () => {
  const { session, itIssueId } = buildAdjudicatedFixtureSession();
  const withAction = planRevisionAction(session, {
    sourceRefs: [{ kind: 'SEMANTIC_ISSUE', id: itIssueId }],
    description: 'x',
    targetLocation: 'x',
  });
  const actionId = Object.keys(withAction.revisionActions)[0];
  const rejected = rejectRevisionAction(withAction, actionId);
  assert.throws(
    () => createRevisionSuccessorSession(rejected, REVISED_ARTIFACT_TEXT),
    /no IMPLEMENTED RevisionAction/
  );
});

check('O. an identical artifact text is rejected (successor must be a changed snapshot)', () => {
  const { session } = buildImplementedFixtureSession();
  assert.throws(
    () => createRevisionSuccessorSession(session, session.artifactText),
    /must be a changed artifact snapshot/
  );
});

check("P. an empty revised artifact is rejected through createSession's existing non-empty rule", () => {
  const { session } = buildImplementedFixtureSession();
  assert.throws(() => createRevisionSuccessorSession(session, ''), /non-empty string/);
});

check('Q. a second direct successor for the same source is rejected', () => {
  const { session } = buildImplementedFixtureSession();
  const { sourceSession } = createRevisionSuccessorSession(session, REVISED_ARTIFACT_TEXT);
  assert.throws(
    () => createRevisionSuccessorSession(sourceSession, REVISED_ARTIFACT_TEXT + ' Again, revised once more.'),
    /already has a direct revision successor/
  );
});

check('R. an unrelated successor object is rejected by the canonical validator', () => {
  const { session } = buildImplementedFixtureSession();
  const { sourceSession } = createRevisionSuccessorSession(session, REVISED_ARTIFACT_TEXT);
  const unrelated = freezeInput(createSession('Some wholly unrelated artifact text.'));
  assert.throws(
    () => assertRevisionSuccessorIntegrity(sourceSession, unrelated),
    /binding\.successorSessionId does not match/
  );
});

check('S. a tampered binding.sourceSessionId is rejected', () => {
  const { session } = buildImplementedFixtureSession();
  const { sourceSession, successorSession } = createRevisionSuccessorSession(session, REVISED_ARTIFACT_TEXT);
  const tampered = { ...sourceSession, revisionSuccessor: { ...sourceSession.revisionSuccessor, sourceSessionId: 'wrong-id' } };
  assert.throws(
    () => assertRevisionSuccessorIntegrity(tampered, successorSession),
    /binding\.sourceSessionId does not match/
  );
});

check('T. a tampered binding.sourceArtifactHash is rejected', () => {
  const { session } = buildImplementedFixtureSession();
  const { sourceSession, successorSession } = createRevisionSuccessorSession(session, REVISED_ARTIFACT_TEXT);
  const tampered = {
    ...sourceSession,
    revisionSuccessor: { ...sourceSession.revisionSuccessor, sourceArtifactHash: 'deadbeef' },
  };
  assert.throws(
    () => assertRevisionSuccessorIntegrity(tampered, successorSession),
    /binding\.sourceArtifactHash does not match/
  );
});

check('U. a tampered binding.sourceAuthorContextHash is rejected', () => {
  const { session } = buildImplementedFixtureSession();
  const { sourceSession, successorSession } = createRevisionSuccessorSession(session, REVISED_ARTIFACT_TEXT);
  const tampered = {
    ...sourceSession,
    revisionSuccessor: { ...sourceSession.revisionSuccessor, sourceAuthorContextHash: 'deadbeef' },
  };
  assert.throws(
    () => assertRevisionSuccessorIntegrity(tampered, successorSession),
    /binding\.sourceAuthorContextHash does not match/
  );
});

check('V. a tampered binding.successorSessionId is rejected', () => {
  const { session } = buildImplementedFixtureSession();
  const { sourceSession, successorSession } = createRevisionSuccessorSession(session, REVISED_ARTIFACT_TEXT);
  const tampered = {
    ...sourceSession,
    revisionSuccessor: { ...sourceSession.revisionSuccessor, successorSessionId: 'wrong-id' },
  };
  assert.throws(
    () => assertRevisionSuccessorIntegrity(tampered, successorSession),
    /binding\.successorSessionId does not match/
  );
});

check('W. a tampered binding.successorArtifactHash is rejected', () => {
  const { session } = buildImplementedFixtureSession();
  const { sourceSession, successorSession } = createRevisionSuccessorSession(session, REVISED_ARTIFACT_TEXT);
  const tampered = {
    ...sourceSession,
    revisionSuccessor: { ...sourceSession.revisionSuccessor, successorArtifactHash: 'deadbeef' },
  };
  assert.throws(
    () => assertRevisionSuccessorIntegrity(tampered, successorSession),
    /binding\.successorArtifactHash does not match/
  );
});

check('X. a tampered binding.successorAuthorContextHash is rejected', () => {
  const { session } = buildImplementedFixtureSession();
  const { sourceSession, successorSession } = createRevisionSuccessorSession(session, REVISED_ARTIFACT_TEXT);
  const tampered = {
    ...sourceSession,
    revisionSuccessor: { ...sourceSession.revisionSuccessor, successorAuthorContextHash: 'deadbeef' },
  };
  assert.throws(
    () => assertRevisionSuccessorIntegrity(tampered, successorSession),
    /binding\.successorAuthorContextHash does not match/
  );
});

check('Y. a tampered successor artifact text with a stale hash is rejected by verifyFrozenInputIntegrity', () => {
  const { session } = buildImplementedFixtureSession();
  const { sourceSession, successorSession } = createRevisionSuccessorSession(session, REVISED_ARTIFACT_TEXT);
  const tamperedSuccessor = { ...successorSession, artifactText: successorSession.artifactText + ' TAMPERED' };
  assert.throws(
    () => assertRevisionSuccessorIntegrity(sourceSession, tamperedSuccessor),
    /no longer matches its frozen artifactHash/
  );
});

check('Z. tampered successor AuthorContext content with a stale authorContextHash is rejected', () => {
  const { session } = buildImplementedFixtureSession();
  const { sourceSession, successorSession } = createRevisionSuccessorSession(session, REVISED_ARTIFACT_TEXT);
  const tamperedItems = successorSession.authorContext.confirmedFacts.map((item, i) =>
    i === 0 ? { ...item, text: 'A completely different claim never copied from source.' } : item
  );
  const tamperedSuccessor = {
    ...successorSession,
    authorContext: { ...successorSession.authorContext, confirmedFacts: tamperedItems },
  };
  assert.throws(
    () => assertRevisionSuccessorIntegrity(sourceSession, tamperedSuccessor),
    /no longer matches its frozen authorContextHash/
  );
});

check(
  'AA. a self-consistent semantic-context tamper (successor hash and binding hash refreshed to agree) is still rejected',
  () => {
    const { session } = buildImplementedFixtureSession();
    const { sourceSession, successorSession } = createRevisionSuccessorSession(session, REVISED_ARTIFACT_TEXT);

    const tamperedItems = successorSession.authorContext.confirmedFacts.map((item, i) =>
      i === 0 ? { ...item, text: 'A completely different claim never copied from source.' } : item
    );
    const tamperedAuthorContext = { ...successorSession.authorContext, confirmedFacts: tamperedItems };
    const refreshedAuthorContextHash = sha256AuthorContext(tamperedAuthorContext);
    // The successor's own stored hash is refreshed to match its own tampered
    // content, so verifyFrozenInputIntegrity alone would now pass on it.
    const tamperedSuccessor = {
      ...successorSession,
      authorContext: tamperedAuthorContext,
      authorContextHash: refreshedAuthorContextHash,
    };
    // The binding's stored hash is refreshed to agree with the tampered
    // successor too -- every downstream record is now self-consistent with
    // every other one, and only the semantic-copy-policy check (independent
    // of any stored hash) can still catch this.
    const tamperedSource = {
      ...sourceSession,
      revisionSuccessor: {
        ...sourceSession.revisionSuccessor,
        successorAuthorContextHash: refreshedAuthorContextHash,
      },
    };
    assert.throws(
      () => assertRevisionSuccessorIntegrity(tamperedSource, tamperedSuccessor),
      /does not semantically match source/
    );
  }
);

console.log('\nRevision verification (P2-B)');

function buildVerifiableFixture() {
  const { session, actionId } = buildImplementedFixtureSession();
  const { sourceSession, successorSession } = createRevisionSuccessorSession(session, REVISED_ARTIFACT_TEXT);
  return { sourceSession, successorSession, actionId };
}

function buildTwoImplementedActionsFixtureSession() {
  const { session, itIssueId } = buildAdjudicatedFixtureSession();
  let withActions = planRevisionAction(session, {
    sourceRefs: [{ kind: 'SEMANTIC_ISSUE', id: itIssueId }],
    description: 'Add a paragraph confirming IT provisioning capacity.',
    targetLocation: 'Rollout Plan section',
  });
  const actionId1 = Object.keys(withActions.revisionActions)[0];
  withActions = planRevisionAction(withActions, {
    sourceRefs: [{ kind: 'SEMANTIC_ISSUE', id: itIssueId }],
    description: 'Add an explicit provisioning timeline.',
    targetLocation: 'Rollout Plan section, timeline paragraph',
  });
  const actionId2 = Object.keys(withActions.revisionActions).find((id) => id !== actionId1);
  let implemented = implementRevisionAction(withActions, actionId1);
  implemented = implementRevisionAction(implemented, actionId2);
  return { session: implemented, actionId1, actionId2 };
}

function buildVerifiableFixtureWithExtraPlannedAndRejectedActions() {
  const { session, itIssueId } = buildAdjudicatedFixtureSession();
  let withActions = planRevisionAction(session, {
    sourceRefs: [{ kind: 'SEMANTIC_ISSUE', id: itIssueId }],
    description: 'Implemented change.',
    targetLocation: 'Rollout Plan section',
  });
  const implementedActionId = Object.keys(withActions.revisionActions)[0];
  withActions = implementRevisionAction(withActions, implementedActionId);

  withActions = planRevisionAction(withActions, {
    sourceRefs: [{ kind: 'SEMANTIC_ISSUE', id: itIssueId }],
    description: 'Still-planned change.',
    targetLocation: 'Rollout Plan section, second paragraph',
  });
  const plannedActionId = Object.keys(withActions.revisionActions).find((id) => id !== implementedActionId);

  withActions = planRevisionAction(withActions, {
    sourceRefs: [{ kind: 'SEMANTIC_ISSUE', id: itIssueId }],
    description: 'Rejected change.',
    targetLocation: 'Rollout Plan section, third paragraph',
  });
  const rejectedActionId = Object.keys(withActions.revisionActions).find(
    (id) => id !== implementedActionId && id !== plannedActionId
  );
  withActions = rejectRevisionAction(withActions, rejectedActionId);

  const { sourceSession, successorSession } = createRevisionSuccessorSession(withActions, REVISED_ARTIFACT_TEXT);
  return { sourceSession, successorSession, implementedActionId, plannedActionId, rejectedActionId };
}

check('P2-B A. VERIFIED_PRESENT can be recorded for an IMPLEMENTED action against its authoritative successor', () => {
  const { sourceSession, successorSession, actionId } = buildVerifiableFixture();
  const updated = recordRevisionVerification(sourceSession, successorSession, {
    revisionActionId: actionId,
    verdict: 'VERIFIED_PRESENT',
    evidence: 'The successor now states IT has confirmed capacity to provision all 500 accounts.',
  });
  const recordId = Object.keys(updated.revisionVerifications)[0];
  assert.equal(updated.revisionVerifications[recordId].verdict, 'VERIFIED_PRESENT');
});

check('P2-B B. NOT_PRESENT can be recorded', () => {
  const { sourceSession, successorSession, actionId } = buildVerifiableFixture();
  const updated = recordRevisionVerification(sourceSession, successorSession, {
    revisionActionId: actionId,
    verdict: 'NOT_PRESENT',
    evidence: 'The successor text was checked and the IT capacity confirmation is not present.',
  });
  const recordId = Object.keys(updated.revisionVerifications)[0];
  assert.equal(updated.revisionVerifications[recordId].verdict, 'NOT_PRESENT');
});

check('P2-B C. INCONCLUSIVE can be recorded', () => {
  const { sourceSession, successorSession, actionId } = buildVerifiableFixture();
  const updated = recordRevisionVerification(sourceSession, successorSession, {
    revisionActionId: actionId,
    verdict: 'INCONCLUSIVE',
    evidence: 'The successor text was checked but the provisioning claim is ambiguous.',
  });
  const recordId = Object.keys(updated.revisionVerifications)[0];
  assert.equal(updated.revisionVerifications[recordId].verdict, 'INCONCLUSIVE');
});

check('P2-B D. no verification record remains distinct from INCONCLUSIVE', () => {
  const { sourceSession, successorSession, actionId } = buildVerifiableFixture();
  const before = Object.values(sourceSession.revisionVerifications).filter((v) => v.revisionActionId === actionId);
  assert.equal(before.length, 0);
  const updated = recordRevisionVerification(sourceSession, successorSession, {
    revisionActionId: actionId,
    verdict: 'INCONCLUSIVE',
    evidence: 'Ambiguous successor evidence.',
  });
  const after = Object.values(updated.revisionVerifications).filter((v) => v.revisionActionId === actionId);
  assert.equal(after.length, 1);
  assert.equal(after[0].verdict, 'INCONCLUSIVE');
});

check('P2-B E. record fields are fresh id, exact revisionActionId/verdict/evidence, and a verifiedAt string', () => {
  const { sourceSession, successorSession, actionId } = buildVerifiableFixture();
  const evidence = 'Confirmed: successor paragraph now states the IT capacity confirmation.';
  const updated = recordRevisionVerification(sourceSession, successorSession, {
    revisionActionId: actionId,
    verdict: 'VERIFIED_PRESENT',
    evidence,
  });
  const recordId = Object.keys(updated.revisionVerifications)[0];
  const record = updated.revisionVerifications[recordId];
  assert.equal(record.id, recordId);
  assert.equal(typeof record.id, 'string');
  assert.ok(record.id.length > 0);
  assert.equal(record.revisionActionId, actionId);
  assert.equal(record.verdict, 'VERIFIED_PRESENT');
  assert.equal(record.evidence, evidence);
  assert.equal(typeof record.verifiedAt, 'string');
  assert.ok(record.verifiedAt.length > 0);
});

check('P2-B F. the caller-supplied sourceSession object is not mutated in place', () => {
  const { sourceSession, successorSession, actionId } = buildVerifiableFixture();
  const snapshotJson = JSON.stringify(sourceSession);
  recordRevisionVerification(sourceSession, successorSession, {
    revisionActionId: actionId,
    verdict: 'VERIFIED_PRESENT',
    evidence: 'Confirmed present.',
  });
  assert.equal(JSON.stringify(sourceSession), snapshotJson);
  assert.deepEqual(sourceSession.revisionVerifications, {});
});

check('P2-B G. different IMPLEMENTED RevisionActions may each receive their own one verification against the same V1', () => {
  const { session, actionId1, actionId2 } = buildTwoImplementedActionsFixtureSession();
  const { sourceSession, successorSession } = createRevisionSuccessorSession(session, REVISED_ARTIFACT_TEXT);
  let updated = recordRevisionVerification(sourceSession, successorSession, {
    revisionActionId: actionId1,
    verdict: 'VERIFIED_PRESENT',
    evidence: 'First revision is present.',
  });
  updated = recordRevisionVerification(updated, successorSession, {
    revisionActionId: actionId2,
    verdict: 'NOT_PRESENT',
    evidence: 'Second revision is not present.',
  });
  assert.equal(Object.keys(updated.revisionVerifications).length, 2);
  const byAction = Object.values(updated.revisionVerifications).reduce(
    (acc, v) => ({ ...acc, [v.revisionActionId]: v }),
    {}
  );
  assert.equal(byAction[actionId1].verdict, 'VERIFIED_PRESENT');
  assert.equal(byAction[actionId2].verdict, 'NOT_PRESENT');
});

check('P2-B H. verification can be recorded when the source session is COMPLETED', () => {
  const { sourceSession: boundSource, successorSession, actionId } = buildVerifiableFixture();
  const completed = completeSession(boundSource);
  assert.equal(completed.state, 'COMPLETED');
  const updated = recordRevisionVerification(completed, successorSession, {
    revisionActionId: actionId,
    verdict: 'VERIFIED_PRESENT',
    evidence: 'Confirmed present even after session completion.',
  });
  const recordId = Object.keys(updated.revisionVerifications)[0];
  assert.equal(updated.revisionVerifications[recordId].verdict, 'VERIFIED_PRESENT');
});

check('P2-B I. assertRevisionVerificationIntegrity accepts a genuinely valid record', () => {
  const { sourceSession, successorSession, actionId } = buildVerifiableFixture();
  const updated = recordRevisionVerification(sourceSession, successorSession, {
    revisionActionId: actionId,
    verdict: 'VERIFIED_PRESENT',
    evidence: 'Confirmed present.',
  });
  const recordId = Object.keys(updated.revisionVerifications)[0];
  assert.doesNotThrow(() => assertRevisionVerificationIntegrity(updated, successorSession, recordId));
});

check('P2-B J. no revision successor is rejected', () => {
  const { session, actionId } = buildImplementedFixtureSession();
  const someSuccessor = freezeInput(createSession('Some other artifact text, unrelated to session.'));
  assert.throws(
    () =>
      recordRevisionVerification(session, someSuccessor, {
        revisionActionId: actionId,
        verdict: 'VERIFIED_PRESENT',
        evidence: 'x',
      }),
    /has no RevisionSuccessorBinding/
  );
});

check('P2-B K. an unrelated successor is rejected through the canonical P2-A boundary', () => {
  const { sourceSession, actionId } = buildVerifiableFixture();
  const unrelated = freezeInput(createSession('A wholly unrelated artifact text.'));
  assert.throws(
    () =>
      recordRevisionVerification(sourceSession, unrelated, {
        revisionActionId: actionId,
        verdict: 'VERIFIED_PRESENT',
        evidence: 'x',
      }),
    /binding\.successorSessionId does not match/
  );
});

check('P2-B L. a tampered binding is rejected through the canonical P2-A boundary', () => {
  const { sourceSession, successorSession, actionId } = buildVerifiableFixture();
  const tamperedSource = {
    ...sourceSession,
    revisionSuccessor: { ...sourceSession.revisionSuccessor, successorArtifactHash: 'deadbeef' },
  };
  assert.throws(
    () =>
      recordRevisionVerification(tamperedSource, successorSession, {
        revisionActionId: actionId,
        verdict: 'VERIFIED_PRESENT',
        evidence: 'x',
      }),
    /binding\.successorArtifactHash does not match/
  );
});

check('P2-B M. an unknown revisionActionId is rejected', () => {
  const { sourceSession, successorSession } = buildVerifiableFixture();
  assert.throws(
    () =>
      recordRevisionVerification(sourceSession, successorSession, {
        revisionActionId: 'not-a-real-action-id',
        verdict: 'VERIFIED_PRESENT',
        evidence: 'x',
      }),
    /unknown revisionActionId/
  );
});

check('P2-B N. a PLANNED RevisionAction is rejected', () => {
  const { sourceSession, successorSession, plannedActionId } = buildVerifiableFixtureWithExtraPlannedAndRejectedActions();
  assert.throws(
    () =>
      recordRevisionVerification(sourceSession, successorSession, {
        revisionActionId: plannedActionId,
        verdict: 'VERIFIED_PRESENT',
        evidence: 'x',
      }),
    /is not IMPLEMENTED \(status=PLANNED\)/
  );
});

check('P2-B O. a REJECTED RevisionAction is rejected', () => {
  const { sourceSession, successorSession, rejectedActionId } = buildVerifiableFixtureWithExtraPlannedAndRejectedActions();
  assert.throws(
    () =>
      recordRevisionVerification(sourceSession, successorSession, {
        revisionActionId: rejectedActionId,
        verdict: 'VERIFIED_PRESENT',
        evidence: 'x',
      }),
    /is not IMPLEMENTED \(status=REJECTED\)/
  );
});

check('P2-B P. an invalid runtime verdict is rejected', () => {
  const { sourceSession, successorSession, actionId } = buildVerifiableFixture();
  assert.throws(
    () =>
      recordRevisionVerification(sourceSession, successorSession, {
        revisionActionId: actionId,
        verdict: 'MOSTLY_PRESENT',
        evidence: 'x',
      }),
    /invalid verdict/
  );
});

check('P2-B Q. empty evidence is rejected', () => {
  const { sourceSession, successorSession, actionId } = buildVerifiableFixture();
  assert.throws(
    () =>
      recordRevisionVerification(sourceSession, successorSession, {
        revisionActionId: actionId,
        verdict: 'VERIFIED_PRESENT',
        evidence: '',
      }),
    /non-empty, non-whitespace-only string/
  );
});

check('P2-B R. whitespace-only evidence is rejected', () => {
  const { sourceSession, successorSession, actionId } = buildVerifiableFixture();
  assert.throws(
    () =>
      recordRevisionVerification(sourceSession, successorSession, {
        revisionActionId: actionId,
        verdict: 'VERIFIED_PRESENT',
        evidence: '   \n\t  ',
      }),
    /non-empty, non-whitespace-only string/
  );
});

check('P2-B S. a duplicate verification for the same revisionActionId is rejected', () => {
  const { sourceSession, successorSession, actionId } = buildVerifiableFixture();
  const updated = recordRevisionVerification(sourceSession, successorSession, {
    revisionActionId: actionId,
    verdict: 'VERIFIED_PRESENT',
    evidence: 'First.',
  });
  assert.throws(
    () =>
      recordRevisionVerification(updated, successorSession, {
        revisionActionId: actionId,
        verdict: 'NOT_PRESENT',
        evidence: 'Second.',
      }),
    /already has a RevisionVerification/
  );
});

check('P2-B T. a rejected duplicate attempt does not overwrite the first verification', () => {
  const { sourceSession, successorSession, actionId } = buildVerifiableFixture();
  const updated = recordRevisionVerification(sourceSession, successorSession, {
    revisionActionId: actionId,
    verdict: 'VERIFIED_PRESENT',
    evidence: 'First.',
  });
  assert.throws(() =>
    recordRevisionVerification(updated, successorSession, {
      revisionActionId: actionId,
      verdict: 'NOT_PRESENT',
      evidence: 'Second.',
    })
  );
  assert.equal(Object.keys(updated.revisionVerifications).length, 1);
  const only = Object.values(updated.revisionVerifications)[0];
  assert.equal(only.verdict, 'VERIFIED_PRESENT');
  assert.equal(only.evidence, 'First.');
});

check('P2-B U. an unknown revisionVerificationId is rejected', () => {
  const { sourceSession, successorSession, actionId } = buildVerifiableFixture();
  const updated = recordRevisionVerification(sourceSession, successorSession, {
    revisionActionId: actionId,
    verdict: 'VERIFIED_PRESENT',
    evidence: 'x',
  });
  assert.throws(
    () => assertRevisionVerificationIntegrity(updated, successorSession, 'not-a-real-verification-id'),
    /unknown revisionVerificationId/
  );
});

check('P2-B V. a map key that does not match record.id is rejected', () => {
  const { sourceSession, successorSession, actionId } = buildVerifiableFixture();
  const updated = recordRevisionVerification(sourceSession, successorSession, {
    revisionActionId: actionId,
    verdict: 'VERIFIED_PRESENT',
    evidence: 'x',
  });
  const recordId = Object.keys(updated.revisionVerifications)[0];
  const record = updated.revisionVerifications[recordId];
  const tampered = { ...updated, revisionVerifications: { 'a-different-key': record } };
  assert.throws(
    () => assertRevisionVerificationIntegrity(tampered, successorSession, recordId),
    /map key .* does not match record\.id/
  );
});

check('P2-B W. a stored verification pointing to an unknown RevisionAction is rejected', () => {
  const { sourceSession, successorSession, actionId } = buildVerifiableFixture();
  const updated = recordRevisionVerification(sourceSession, successorSession, {
    revisionActionId: actionId,
    verdict: 'VERIFIED_PRESENT',
    evidence: 'x',
  });
  const recordId = Object.keys(updated.revisionVerifications)[0];
  const tampered = {
    ...updated,
    revisionVerifications: {
      [recordId]: { ...updated.revisionVerifications[recordId], revisionActionId: 'not-a-real-action-id' },
    },
  };
  assert.throws(
    () => assertRevisionVerificationIntegrity(tampered, successorSession, recordId),
    /references unknown revisionActionId/
  );
});

check('P2-B X. a stored verification pointing to a PLANNED action is rejected', () => {
  const { sourceSession, successorSession, implementedActionId, plannedActionId } =
    buildVerifiableFixtureWithExtraPlannedAndRejectedActions();
  const updated = recordRevisionVerification(sourceSession, successorSession, {
    revisionActionId: implementedActionId,
    verdict: 'VERIFIED_PRESENT',
    evidence: 'x',
  });
  const recordId = Object.keys(updated.revisionVerifications)[0];
  const tampered = {
    ...updated,
    revisionVerifications: {
      [recordId]: { ...updated.revisionVerifications[recordId], revisionActionId: plannedActionId },
    },
  };
  assert.throws(
    () => assertRevisionVerificationIntegrity(tampered, successorSession, recordId),
    /is not IMPLEMENTED \(status=PLANNED\)/
  );
});

check('P2-B Y. a stored verification pointing to a REJECTED action is rejected', () => {
  const { sourceSession, successorSession, implementedActionId, rejectedActionId } =
    buildVerifiableFixtureWithExtraPlannedAndRejectedActions();
  const updated = recordRevisionVerification(sourceSession, successorSession, {
    revisionActionId: implementedActionId,
    verdict: 'VERIFIED_PRESENT',
    evidence: 'x',
  });
  const recordId = Object.keys(updated.revisionVerifications)[0];
  const tampered = {
    ...updated,
    revisionVerifications: {
      [recordId]: { ...updated.revisionVerifications[recordId], revisionActionId: rejectedActionId },
    },
  };
  assert.throws(
    () => assertRevisionVerificationIntegrity(tampered, successorSession, recordId),
    /is not IMPLEMENTED \(status=REJECTED\)/
  );
});

check('P2-B Z. a stored verification with an illegal verdict is rejected', () => {
  const { sourceSession, successorSession, actionId } = buildVerifiableFixture();
  const updated = recordRevisionVerification(sourceSession, successorSession, {
    revisionActionId: actionId,
    verdict: 'VERIFIED_PRESENT',
    evidence: 'x',
  });
  const recordId = Object.keys(updated.revisionVerifications)[0];
  const tampered = {
    ...updated,
    revisionVerifications: {
      [recordId]: { ...updated.revisionVerifications[recordId], verdict: 'MOSTLY_PRESENT' },
    },
  };
  assert.throws(
    () => assertRevisionVerificationIntegrity(tampered, successorSession, recordId),
    /has an invalid verdict/
  );
});

check('P2-B AA. a stored verification with empty/whitespace evidence is rejected', () => {
  const { sourceSession, successorSession, actionId } = buildVerifiableFixture();
  const updated = recordRevisionVerification(sourceSession, successorSession, {
    revisionActionId: actionId,
    verdict: 'VERIFIED_PRESENT',
    evidence: 'x',
  });
  const recordId = Object.keys(updated.revisionVerifications)[0];
  const tampered = {
    ...updated,
    revisionVerifications: {
      [recordId]: { ...updated.revisionVerifications[recordId], evidence: '   ' },
    },
  };
  assert.throws(
    () => assertRevisionVerificationIntegrity(tampered, successorSession, recordId),
    /empty\/whitespace-only evidence/
  );
});

check(
  'P2-B AB. two stored verification records referencing the same revisionActionId are rejected globally, even if the requested one looks valid',
  () => {
    const { sourceSession, successorSession, actionId } = buildVerifiableFixture();
    const updated = recordRevisionVerification(sourceSession, successorSession, {
      revisionActionId: actionId,
      verdict: 'VERIFIED_PRESENT',
      evidence: 'First, individually valid-looking record.',
    });
    const firstRecordId = Object.keys(updated.revisionVerifications)[0];
    const secondRecordId = 'a-second-verification-id';
    const tampered = {
      ...updated,
      revisionVerifications: {
        ...updated.revisionVerifications,
        [secondRecordId]: {
          id: secondRecordId,
          revisionActionId: actionId,
          verdict: 'NOT_PRESENT',
          evidence: 'A second, illegally duplicate record for the same action.',
          verifiedAt: new Date().toISOString(),
        },
      },
    };
    assert.throws(
      () => assertRevisionVerificationIntegrity(tampered, successorSession, firstRecordId),
      /0\.\.1 cardinality violated/
    );
  }
);

check(
  'P2-B AC. an unrelated invalid record elsewhere in the ledger rejects the read globally, even for an otherwise-valid requested record',
  () => {
    const { session, itIssueId } = buildAdjudicatedFixtureSession();
    let withActions = planRevisionAction(session, {
      sourceRefs: [{ kind: 'SEMANTIC_ISSUE', id: itIssueId }],
      description: 'First change.',
      targetLocation: 'Rollout Plan section',
    });
    const actionId1 = Object.keys(withActions.revisionActions)[0];
    withActions = planRevisionAction(withActions, {
      sourceRefs: [{ kind: 'SEMANTIC_ISSUE', id: itIssueId }],
      description: 'Second change.',
      targetLocation: 'Rollout Plan section, second paragraph',
    });
    const actionId2 = Object.keys(withActions.revisionActions).find((id) => id !== actionId1);
    withActions = implementRevisionAction(withActions, actionId1);
    withActions = implementRevisionAction(withActions, actionId2);

    const { sourceSession, successorSession } = createRevisionSuccessorSession(withActions, REVISED_ARTIFACT_TEXT);
    const updated = recordRevisionVerification(sourceSession, successorSession, {
      revisionActionId: actionId1,
      verdict: 'VERIFIED_PRESENT',
      evidence: 'Valid record for action 1.',
    });
    const validRecordId = Object.keys(updated.revisionVerifications)[0];

    const corruptRecordId = 'a-corrupt-unrelated-record';
    const tampered = {
      ...updated,
      revisionVerifications: {
        ...updated.revisionVerifications,
        [corruptRecordId]: {
          id: corruptRecordId,
          revisionActionId: actionId2,
          verdict: 'SOMEWHAT_PRESENT',
          evidence: 'Corrupt unrelated record.',
          verifiedAt: new Date().toISOString(),
        },
      },
    };
    assert.throws(
      () => assertRevisionVerificationIntegrity(tampered, successorSession, validRecordId),
      /has an invalid verdict/
    );
  }
);

check('P2-B AD. later-read rejects when the source/successor binding becomes invalid after verification was stored', () => {
  const { sourceSession, successorSession, actionId } = buildVerifiableFixture();
  const updated = recordRevisionVerification(sourceSession, successorSession, {
    revisionActionId: actionId,
    verdict: 'VERIFIED_PRESENT',
    evidence: 'x',
  });
  const recordId = Object.keys(updated.revisionVerifications)[0];
  const tamperedBinding = {
    ...updated,
    revisionSuccessor: { ...updated.revisionSuccessor, successorArtifactHash: 'deadbeef' },
  };
  assert.throws(
    () => assertRevisionVerificationIntegrity(tamperedBinding, successorSession, recordId),
    /binding\.successorArtifactHash does not match/
  );
});

check('P2-B AE. a valid historical verification remains readable after the source session becomes COMPLETED', () => {
  const { sourceSession, successorSession, actionId } = buildVerifiableFixture();
  const updated = recordRevisionVerification(sourceSession, successorSession, {
    revisionActionId: actionId,
    verdict: 'VERIFIED_PRESENT',
    evidence: 'x',
  });
  const recordId = Object.keys(updated.revisionVerifications)[0];
  const completed = completeSession(updated);
  assert.doesNotThrow(() => assertRevisionVerificationIntegrity(completed, successorSession, recordId));
});

console.log('\nRevision verification ledger integrity at write boundary (P2-B Amendment 1)');

function buildVerifiableFixtureWithTwoActions() {
  const { session, actionId1, actionId2 } = buildTwoImplementedActionsFixtureSession();
  const { sourceSession, successorSession } = createRevisionSuccessorSession(session, REVISED_ARTIFACT_TEXT);
  return { sourceSession, successorSession, actionId1, actionId2 };
}

check(
  'Amendment 1 #1. an existing unrelated corrupt record (illegal verdict) blocks a new, otherwise-valid write',
  () => {
    const { sourceSession, successorSession, actionId1, actionId2 } = buildVerifiableFixtureWithTwoActions();
    const corruptRecordId = 'a-corrupt-existing-record';
    const corrupted = {
      ...sourceSession,
      revisionVerifications: {
        [corruptRecordId]: {
          id: corruptRecordId,
          revisionActionId: actionId1,
          verdict: 'SOMEWHAT_PRESENT',
          evidence: 'Corrupt pre-existing record.',
          verifiedAt: new Date().toISOString(),
        },
      },
    };
    assert.throws(
      () =>
        recordRevisionVerification(corrupted, successorSession, {
          revisionActionId: actionId2,
          verdict: 'VERIFIED_PRESENT',
          evidence: 'Valid evidence for the unrelated action.',
        }),
      /has an invalid verdict/
    );
  }
);

check(
  'Amendment 1 #2. an existing hidden duplicate for RA-1 blocks a new, otherwise-valid write for separate RA-2',
  () => {
    const { sourceSession, successorSession, actionId1, actionId2 } = buildVerifiableFixtureWithTwoActions();
    const firstId = 'hidden-duplicate-a';
    const secondId = 'hidden-duplicate-b';
    const corrupted = {
      ...sourceSession,
      revisionVerifications: {
        [firstId]: {
          id: firstId,
          revisionActionId: actionId1,
          verdict: 'VERIFIED_PRESENT',
          evidence: 'First duplicate.',
          verifiedAt: new Date().toISOString(),
        },
        [secondId]: {
          id: secondId,
          revisionActionId: actionId1,
          verdict: 'NOT_PRESENT',
          evidence: 'Second, hidden duplicate for the same action.',
          verifiedAt: new Date().toISOString(),
        },
      },
    };
    assert.throws(
      () =>
        recordRevisionVerification(corrupted, successorSession, {
          revisionActionId: actionId2,
          verdict: 'VERIFIED_PRESENT',
          evidence: 'Valid evidence for the unrelated action.',
        }),
      /0\.\.1 cardinality violated/
    );
  }
);

check('Amendment 1 #3. an existing map-key/record.id mismatch blocks an otherwise-valid new write', () => {
  const { sourceSession, successorSession, actionId1, actionId2 } = buildVerifiableFixtureWithTwoActions();
  const realId = 'the-real-id';
  const corrupted = {
    ...sourceSession,
    revisionVerifications: {
      'a-different-key': {
        id: realId,
        revisionActionId: actionId1,
        verdict: 'VERIFIED_PRESENT',
        evidence: 'Otherwise valid record stored under the wrong map key.',
        verifiedAt: new Date().toISOString(),
      },
    },
  };
  assert.throws(
    () =>
      recordRevisionVerification(corrupted, successorSession, {
        revisionActionId: actionId2,
        verdict: 'VERIFIED_PRESENT',
        evidence: 'Valid evidence for the unrelated action.',
      }),
    /map key .* does not match record\.id/
  );
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
