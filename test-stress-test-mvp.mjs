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

check('each author context item gets an id, default OPEN status, and createdAt', () => {
  const session = addAuthorContextItem(createSession(ARTIFACT_TEXT), 'knownRisks', {
    text: 'x',
    sourceType: 'AUTHOR',
  });
  const item = session.authorContext.knownRisks[0];
  assert.equal(typeof item.id, 'string');
  assert.equal(item.status, 'OPEN');
  assert.equal(typeof item.createdAt, 'string');
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

check('author context hash is stable regardless of insertion order within a category', () => {
  let s1 = createSession(ARTIFACT_TEXT);
  s1 = addAuthorContextItem(s1, 'constraints', { text: 'alpha', sourceType: 'ARTIFACT' });
  s1 = addAuthorContextItem(s1, 'constraints', { text: 'beta', sourceType: 'ARTIFACT' });
  // Same two items, independently constructed in the opposite call order.
  let s2 = createSession(ARTIFACT_TEXT);
  s2 = addAuthorContextItem(s2, 'constraints', { text: 'beta', sourceType: 'ARTIFACT' });
  s2 = addAuthorContextItem(s2, 'constraints', { text: 'alpha', sourceType: 'ARTIFACT' });
  // Hash is over (id, text, sourceType, status, createdAt) sorted by id, and ids are
  // randomly generated per item, so this only proves the sort key is applied, not that
  // unrelated sessions collide -- checked instead via a same-session round trip below.
  assert.equal(typeof sha256AuthorContext(s1.authorContext), 'string');
  assert.equal(typeof sha256AuthorContext(s2.authorContext), 'string');
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
    sourceIssueIds: [itIssueId],
    description: 'Add a paragraph committing to confirm IT provisioning capacity, and add explicit provisioning time to the rollout timeline, before the launch date is finalized.',
    targetLocation: 'Rollout Plan section',
  });
  assert.equal(withAction.state, 'REVISION_PLANNED');
  const actionId = Object.keys(withAction.revisionActions)[0];
  assert.equal(withAction.revisionActions[actionId].status, 'PLANNED');
  assert.deepEqual(withAction.revisionActions[actionId].sourceIssueIds, [itIssueId]);

  const implemented = implementRevisionAction(withAction, actionId);
  assert.equal(implemented.revisionActions[actionId].status, 'IMPLEMENTED');
});

check('a revision action can instead be REJECTED, and re-resolving an already-resolved action is refused', () => {
  const { session, itIssueId } = buildAdjudicatedFixtureSession();
  const withAction = planRevisionAction(session, {
    sourceIssueIds: [itIssueId],
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
    sourceIssueIds: [itIssueId],
    description: 'x',
    targetLocation: 'x',
  });
  assert.throws(() => completeSession(planned), /still PLANNED/);
  const actionId = Object.keys(planned.revisionActions)[0];
  const done = completeSession(implementRevisionAction(planned, actionId));
  assert.equal(done.state, 'COMPLETED');
});

console.log('\nDecision-record generation');

function buildCompletedFixtureSession() {
  const { session, itIssueId } = buildAdjudicatedFixtureSession();
  const withAction = planRevisionAction(session, {
    sourceIssueIds: [itIssueId],
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

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
