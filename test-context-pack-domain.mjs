// Offline tests for the canonical stress-test ContextPack source: real sessions and
// deliberation states built through the accepted domain APIs, R5 binding parity, and
// global-before-local integrity. No provider, no network, no product write by R6.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { serializePayload } from './dist/context/fingerprint.js';
import { ContextPackBudgetError, CONTEXT_PACK_SCHEMA_VERSION } from './dist/context/pack.js';
import { createConsultationRouteBindingPort } from './dist/stress-test/consultation-binding.js';
import { createStressTestContextPackSource } from './dist/stress-test/context-source.js';
import {
  addAuthorContextItem, addFinding, createDeliberationState, createInMemoryDeliberationStateAccessPort, createSemanticIssue,
  createSession, createUnresolvedQuestion, freezeInput, planRouteForQuestion, recordQuestionDisposition, recordRouteAttemptStart,
  recordRouteDecision, recordRouteOutcome, registerEvidenceSubject, registerUnresolvedQuestion,
} from './dist/stress-test/index.js';

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

const ARTIFACT = 'Open a second studio in Q2.\n\nPayback is 14 months, per the owner.';
const MATERIALITY = 'The payback claim drives the go/no-go decision.';
const WIDE = { maxSerializedChars: 1_000_000 };
const finding = (title) => ({ reviewerRunId: 'review-1', type: 'CLAIM', title, artifactLocation: 'paragraph 2',
  evidenceState: 'UNSUPPORTED_IN_MATERIAL', whyMaterial: 'It drives the decision.',
  likelyRecipientChallenge: 'Where does 14 months come from?', minimumBeforeSendAction: 'Cite the source.' });

function baseSession({ beforeFreeze } = {}) {
  let session = createSession(ARTIFACT);
  session = addAuthorContextItem(session, 'knownRisks', { text: 'The lease may not renew.', sourceType: 'AUTHOR' });
  session = addAuthorContextItem(session, 'confirmedFacts', { text: 'Two studios exist.', sourceType: 'EXTERNAL_SOURCE', status: 'RESOLVED' });
  if (beforeFreeze) session = beforeFreeze(session);
  session = freezeInput(session);
  session = addFinding(session, finding('Unsupported payback'));
  session = addFinding(session, finding('Unstated lease term'));
  const findingIds = Object.keys(session.findings);
  session = createSemanticIssue(session, { title: 'Payback', description: 'Payback is unsupported.', findingIds,
    evidenceState: 'UNSUPPORTED_IN_MATERIAL' });
  return session;
}

/** A started attempt for `rootCause`, with the named refs in the given order. */
function fixture({ rootCause = 'COVERAGE_GAP', order = ['AUTHOR', 'FINDING', 'ISSUE'], policy = WIDE, session: given, now } = {}) {
  const session = given ?? baseSession();
  const [findingA, findingB] = Object.keys(session.findings);
  const ref = {
    AUTHOR: { kind: 'AUTHOR_CONTEXT_ITEM', id: session.authorContext.knownRisks[0].id },
    RESOLVED_AUTHOR: { kind: 'AUTHOR_CONTEXT_ITEM', id: session.authorContext.confirmedFacts[0].id },
    FINDING: { kind: 'FINDING', id: findingA },
    FINDING_B: { kind: 'FINDING', id: findingB },
    ISSUE: { kind: 'SEMANTIC_ISSUE', id: Object.keys(session.semanticIssues)[0] },
  };
  let state = createDeliberationState(session, { costCeiling: 20, latencyCeiling: 20 });
  const question = createUnresolvedQuestion(session, { rootCause, materialityReason: MATERIALITY, inputRefs: order.map((k) => ref[k]) });
  state = registerUnresolvedQuestion(session, state, question);
  if (rootCause === 'EVIDENCE_GAP') {
    state = registerEvidenceSubject(session, state, { questionId: question.id, sourceRef: ref.FINDING,
      originatingFindingId: ref.FINDING.id, claimText: 'Payback is 14 months.' }).deliberationState;
  }
  const decision = planRouteForQuestion(session, state, question);
  state = recordRouteDecision(session, state, decision);
  state = recordRouteAttemptStart(session, state, decision.id);
  const attemptId = state.attempts[state.attempts.length - 1].attemptId;
  const commits = { count: 0 };
  const inner = createInMemoryDeliberationStateAccessPort(state);
  const access = {
    resolveCurrentDeliberationState: (id) => inner.resolveCurrentDeliberationState(id),
    commitDeliberationState: (next) => { commits.count++; inner.commitDeliberationState(next); },
  };
  const edit = (change) => { const next = inner.current(); change(next); inner.commitDeliberationState(next); };
  const source = createStressTestContextPackSource(session, access, state.id, policy, now ? { now } : {});
  return { session, state, access, inner, edit, commits, attemptId, question, decision, ref, source,
    r5: createConsultationRouteBindingPort(session, access, state.id) };
}

const failedOutcome = (attemptId) => ({ attemptId, status: 'FAILED', latencyConsumed: 1,
  failure: { category: 'TRANSPORT', message: 'offline failure fixture' } });

console.log('\nBuild');

for (const [rootCause, route] of [['COVERAGE_GAP', 'ADD_REVIEWER'], ['STABILITY_QUESTION', 'REPLICATE']]) {
  await check(`${route} pack builds with canonical binding, question, and every source in ref order`, () => {
    const h = fixture({ rootCause });
    const pack = h.source.build({ attemptId: h.attemptId });
    assert.equal(pack.schemaVersion, CONTEXT_PACK_SCHEMA_VERSION);
    assert.deepEqual(pack.binding, {
      deliberationStateId: h.state.id, sessionId: h.session.id, artifactHash: h.session.artifactHash,
      authorContextHash: h.session.authorContextHash, attemptId: h.attemptId, decisionId: h.decision.id,
      questionId: h.question.id, route, inputRefs: h.question.inputRefs,
    });
    assert.deepEqual(pack.question, { rootCause, materialityReason: MATERIALITY });
    assert.deepEqual(pack.sources.map((s) => s.ref), h.question.inputRefs);
    assert.equal(Object.hasOwn(pack, 'artifact'), false, 'no excerpt unless one was selected');
    assert.equal(h.commits.count, 0);
  });
}

await check('every other route is refused', () => {
  for (const rootCause of ['DECISION_SENSITIVE_CONFLICT', 'EVIDENCE_GAP', 'CONTEXT_GAP']) {
    const h = fixture({ rootCause, order: ['FINDING', 'ISSUE'] });
    assert.throws(() => h.source.build({ attemptId: h.attemptId }), /does not execute route/);
  }
});

await check('unknown, duplicate attempt, duplicate decision, and duplicate question are refused', () => {
  const h = fixture();
  assert.throws(() => h.source.build({ attemptId: 'no-such-attempt' }), /exactly one RouteAttempt/);
  const dupAttempt = fixture();
  dupAttempt.edit((s) => s.attempts.push(structuredClone(s.attempts[0])));
  assert.throws(() => dupAttempt.source.build({ attemptId: dupAttempt.attemptId }), /exactly one RouteAttempt/);
  const dupDecision = fixture();
  dupDecision.edit((s) => s.history.push(structuredClone(s.history[0])));
  assert.throws(() => dupDecision.source.build({ attemptId: dupDecision.attemptId }), /more than one recorded RouteDecision/);
  const dupQuestion = fixture();
  dupQuestion.edit((s) => s.unresolvedQuestions.push(structuredClone(s.unresolvedQuestions[0])));
  assert.throws(() => dupQuestion.source.build({ attemptId: dupQuestion.attemptId }), /duplicate UnresolvedQuestion.id/);
});

await check('a stopped deliberation is refused', () => {
  const h = fixture();
  h.edit((s) => { s.stopReason = 'budget'; });
  assert.throws(() => h.source.build({ attemptId: h.attemptId }), /stopped/);
});

await check('an attempt with a recorded RouteOutcome, or a question no longer current, is refused', () => {
  const h = fixture();
  const withOutcome = recordRouteOutcome(h.session, h.inner.current(), failedOutcome(h.attemptId));
  h.inner.commitDeliberationState(withOutcome);
  assert.throws(() => h.source.build({ attemptId: h.attemptId }), /already has a RouteOutcome/);
  const resolved = recordQuestionDisposition(h.session, withOutcome, { attemptId: h.attemptId, disposition: 'RESOLVED', reason: 'offline' });
  h.inner.commitDeliberationState(resolved);
  assert.throws(() => h.source.build({ attemptId: h.attemptId }), /RouteOutcome|no longer current/);
});

await check('a session or hash mismatch is refused', () => {
  const h = fixture();
  h.edit((s) => { s.artifactHash = 'f'.repeat(64); });
  assert.throws(() => h.source.build({ attemptId: h.attemptId }), /artifactHash/);
  const other = fixture();
  const foreign = createStressTestContextPackSource(baseSession(), other.access, other.state.id, WIDE);
  assert.throws(() => foreign.build({ attemptId: other.attemptId }), /bound to session/);
  const tamperedText = fixture();
  const session = structuredClone(tamperedText.session);
  session.artifactText += ' (edited)';
  const drifted = createStressTestContextPackSource(session, tamperedText.access, tamperedText.state.id, WIDE);
  assert.throws(() => drifted.build({ attemptId: tamperedText.attemptId }), /frozen artifactHash/);
});

await check('route refs keep their canonical order, all of them, each exactly resolved', () => {
  const a = fixture({ order: ['ISSUE', 'FINDING_B', 'AUTHOR', 'FINDING'] });
  const pack = a.source.build({ attemptId: a.attemptId });
  assert.deepEqual(pack.binding.inputRefs.map((r) => r.kind), ['SEMANTIC_ISSUE', 'FINDING', 'AUTHOR_CONTEXT_ITEM', 'FINDING']);
  assert.deepEqual(pack.sources.map((s) => s.ref), a.question.inputRefs);
  assert.deepEqual(pack.sources.map((s) => s.value.id), a.question.inputRefs.map((r) => r.id));
  const b = fixture({ order: ['FINDING', 'AUTHOR', 'FINDING_B', 'ISSUE'], session: a.session });
  assert.notEqual(b.source.build({ attemptId: b.attemptId }).contextFingerprint, pack.contextFingerprint);
});

console.log('\nSource types');

await check('FINDING and SEMANTIC_ISSUE are exact detached copies; the issue keeps findingIds, unmerged', () => {
  const h = fixture({ order: ['FINDING', 'ISSUE'] });
  const pack = h.source.build({ attemptId: h.attemptId });
  assert.deepEqual(pack.sources[0], { ref: h.ref.FINDING, value: h.session.findings[h.ref.FINDING.id] });
  assert.deepEqual(pack.sources[1], { ref: h.ref.ISSUE, value: h.session.semanticIssues[h.ref.ISSUE.id] });
  assert.notEqual(pack.sources[0].value, h.session.findings[h.ref.FINDING.id]);
  assert.deepEqual(pack.sources[1].value.findingIds, Object.keys(h.session.findings));
  assert.equal(pack.sources.length, 2, 'leaf findings are not duplicated into the pack');
});

await check('AUTHOR_CONTEXT_ITEM resolves its one category and keeps source type and status as recorded', () => {
  const h = fixture({ order: ['AUTHOR', 'RESOLVED_AUTHOR'] });
  const pack = h.source.build({ attemptId: h.attemptId });
  assert.deepEqual(pack.sources[0], { ref: h.ref.AUTHOR, category: 'knownRisks', value: h.session.authorContext.knownRisks[0] });
  assert.deepEqual(pack.sources[1], { ref: h.ref.RESOLVED_AUTHOR, category: 'confirmedFacts',
    value: h.session.authorContext.confirmedFacts[0] });
  assert.equal(pack.sources[1].value.sourceType, 'EXTERNAL_SOURCE');
  assert.equal(pack.sources[1].value.status, 'RESOLVED');
  assert.deepEqual(Object.keys(pack.sources[0].value).sort(), ['createdAt', 'id', 'sourceType', 'status', 'text']);
});

/** Points the started attempt's question and decision at `refs`, consistently. */
const retarget = (h, refs) => h.edit((s) => {
  s.unresolvedQuestions[0].inputRefs = refs;
  s.history[0].inputRefs = structuredClone(refs);
});

await check('an ambiguous author-context id is refused, across categories and within one', () => {
  const across = fixture({ session: baseSession({ beforeFreeze: (s) => {
    const copy = structuredClone(s);
    copy.authorContext.constraints.push(structuredClone(copy.authorContext.knownRisks[0]));
    return copy;
  } }), order: ['FINDING'] });
  retarget(across, [across.ref.AUTHOR]);
  assert.throws(() => across.source.build({ attemptId: across.attemptId }), /ambiguous AUTHOR_CONTEXT_ITEM/);
  const within = fixture({ session: baseSession({ beforeFreeze: (s) => {
    const copy = structuredClone(s);
    copy.authorContext.knownRisks.push({ ...structuredClone(copy.authorContext.knownRisks[0]), text: 'A different claim.' });
    return copy;
  } }), order: ['FINDING'] });
  retarget(within, [within.ref.AUTHOR]);
  assert.throws(() => within.source.build({ attemptId: within.attemptId }), /exactly one item in one category/);
});

await check('unknown and inherited ids never resolve', () => {
  for (const ref of [{ kind: 'FINDING', id: 'no-such-finding' }, { kind: 'SEMANTIC_ISSUE', id: 'no-such-issue' },
    { kind: 'AUTHOR_CONTEXT_ITEM', id: 'no-such-item' }, { kind: 'FINDING', id: 'constructor' },
    { kind: 'SEMANTIC_ISSUE', id: '__proto__' }, { kind: 'FINDING', id: 'toString' }, { kind: 'SEMANTIC_ISSUE', id: 'hasOwnProperty' }]) {
    const h = fixture();
    retarget(h, [ref]);
    assert.throws(() => h.source.build({ attemptId: h.attemptId }), /unknown|does not resolve/, JSON.stringify(ref));
  }
});

await check('copied sources are detached and frozen; later changes to the session do not reach the pack', () => {
  const h = fixture();
  const pack = h.source.build({ attemptId: h.attemptId, artifactSelection: { startChar: 0, endChar: 6 } });
  const before = JSON.stringify(pack);
  h.session.findings[h.ref.FINDING.id].title = 'mutated';
  h.session.semanticIssues[h.ref.ISSUE.id].findingIds.reverse();
  h.session.authorContext.knownRisks[0].text = 'mutated';
  assert.equal(JSON.stringify(pack), before);
  for (const node of [pack.sources[0].value, pack.sources[1].value, pack.sources[2].value.findingIds, pack.binding.inputRefs, pack.artifact]) {
    assert.ok(Object.isFrozen(node));
  }
  assert.throws(() => { pack.sources[1].value.title = 'x'; }, TypeError);
  assert.throws(() => { pack.sources.push({}); }, TypeError);
});

console.log('\nArtifact excerpt');

await check('an excerpt is the exact canonical slice, marked as an excerpt', () => {
  const h = fixture();
  const at = (startChar, endChar) => h.source.build({ attemptId: h.attemptId, artifactSelection: { startChar, endChar } }).artifact;
  assert.deepEqual(at(0, 6), { selectionScope: 'EXCERPT', startChar: 0, endChar: 6, text: 'Open a' });
  assert.equal(at(0, ARTIFACT.length).text, ARTIFACT, 'even the whole span is labelled EXCERPT');
  assert.equal(at(0, ARTIFACT.length).selectionScope, 'EXCERPT');
  assert.equal(at(ARTIFACT.length - 1, ARTIFACT.length).text, '.');
});

await check('offsets outside 0 <= start < end <= length are refused', () => {
  const h = fixture();
  for (const [startChar, endChar] of [[-1, 3], [3, 3], [5, 2], [0, ARTIFACT.length + 1], [ARTIFACT.length, ARTIFACT.length + 1]]) {
    assert.throws(() => h.source.build({ attemptId: h.attemptId, artifactSelection: { startChar, endChar } }), RangeError);
  }
  assert.throws(() => h.source.build({ attemptId: h.attemptId, artifactSelection: { startChar: 0.5, endChar: 3 } }), TypeError);
});

await check('a caller cannot supply excerpt text, hashes, or session facts', () => {
  const h = fixture();
  assert.throws(() => h.source.build({ attemptId: h.attemptId, artifactSelection: { startChar: 0, endChar: 4, text: 'Fake' } }), TypeError);
  for (const extra of ['artifactHash', 'sessionId', 'authorContextHash', 'route', 'inputRefs', 'decisionId', 'questionId']) {
    assert.throws(() => h.source.build({ attemptId: h.attemptId, [extra]: 'forged' }), TypeError, extra);
  }
});

await check('the selection is read once; changing it after build changes nothing', () => {
  const h = fixture();
  const selection = { attemptId: h.attemptId, artifactSelection: { startChar: 0, endChar: 4 } };
  const pack = h.source.build(selection);
  selection.artifactSelection.endChar = 20;
  assert.equal(pack.artifact.text, 'Open');
  assert.throws(() => { pack.artifact.text = 'x'; }, TypeError);
});

console.log('\nBudget');

const requiredSize = (h) => {
  const pack = h.source.build({ attemptId: h.attemptId });
  return serializePayload(pack).length;
};

await check('the policy is required at composition and snapshotted there', () => {
  const h = fixture();
  for (const bad of [{ maxSerializedChars: 0 }, { maxSerializedChars: -5 }, { maxSerializedChars: Number.NaN },
    { maxSerializedChars: Infinity }, { maxSerializedChars: 2.5 }, {}, undefined]) {
    assert.throws(() => createStressTestContextPackSource(h.session, h.access, h.state.id, bad), TypeError);
  }
  const size = requiredSize(h);
  const policy = { maxSerializedChars: size };
  const source = createStressTestContextPackSource(h.session, h.access, h.state.id, policy);
  policy.maxSerializedChars = 1;
  assert.equal(source.build({ attemptId: h.attemptId }).sources.length, 3, 'a later change to the policy object is ignored');
});

await check('required context exactly at the limit builds; one less fails without dropping a ref', () => {
  const h = fixture();
  const size = requiredSize(h);
  const exact = createStressTestContextPackSource(h.session, h.access, h.state.id, { maxSerializedChars: size });
  const pack = exact.build({ attemptId: h.attemptId });
  assert.equal(serializePayload(pack).length, size);
  assert.deepEqual(pack.sources.map((s) => s.ref), h.question.inputRefs);
  const tight = createStressTestContextPackSource(h.session, h.access, h.state.id, { maxSerializedChars: size - 1 });
  assert.throws(() => tight.build({ attemptId: h.attemptId }), ContextPackBudgetError);
});

await check('an excerpt that would exceed the budget fails the build instead of being cut', () => {
  const h = fixture();
  const size = requiredSize(h);
  const source = createStressTestContextPackSource(h.session, h.access, h.state.id, { maxSerializedChars: size + 120 });
  assert.equal(source.build({ attemptId: h.attemptId, artifactSelection: { startChar: 0, endChar: 10 } }).artifact.text, 'Open a sec');
  assert.throws(() => source.build({ attemptId: h.attemptId, artifactSelection: { startChar: 0, endChar: ARTIFACT.length } }),
    /never truncated/);
});

console.log('\nFingerprint');

await check('the same canonical context has one fingerprint whatever capturedAt says', () => {
  let tick = 0;
  const h = fixture({ now: () => new Date(Date.UTC(2026, 0, 1) + tick++ * 86_400_000) });
  const a = h.source.build({ attemptId: h.attemptId });
  const b = h.source.build({ attemptId: h.attemptId });
  assert.notEqual(a.capturedAt, b.capturedAt);
  assert.equal(a.contextFingerprint, b.contextFingerprint);
});

await check('changes to canonical content change the fingerprint of the next build', () => {
  const h = fixture();
  const base = h.source.build({ attemptId: h.attemptId, artifactSelection: { startChar: 0, endChar: 6 } }).contextFingerprint;
  const again = () => h.source.build({ attemptId: h.attemptId, artifactSelection: { startChar: 0, endChar: 6 } }).contextFingerprint;
  h.session.findings[h.ref.FINDING.id].whyMaterial = 'Rewritten.';
  const afterFinding = again();
  assert.notEqual(afterFinding, base);
  h.session.semanticIssues[h.ref.ISSUE.id].description = 'Rewritten.';
  assert.notEqual(again(), afterFinding);
  assert.notEqual(h.source.build({ attemptId: h.attemptId, artifactSelection: { startChar: 1, endChar: 7 } }).contextFingerprint, again());
});

console.log('\nR5 parity');

for (const [rootCause, route] of [['COVERAGE_GAP', 'ADD_REVIEWER'], ['STABILITY_QUESTION', 'REPLICATE']]) {
  await check(`${route}: ContextPack.binding equals the R5 ConsultationRouteBinding exactly`, () => {
    const h = fixture({ rootCause, order: ['ISSUE', 'AUTHOR', 'FINDING'] });
    const r5 = h.r5.resolve(h.attemptId);
    const pack = h.source.build({ attemptId: h.attemptId });
    assert.deepEqual(pack.binding, r5);
    assert.deepEqual(Object.keys(pack.binding), Object.keys(r5));
    assert.deepEqual(pack.binding.inputRefs, r5.inputRefs);
  });
}

await check('R5 and R6 refuse the same provenance mismatches', () => {
  const tamper = [
    (s) => { s.history[0].questionId = 'other-question'; },
    (s) => { s.history[0].reason.materialityReason = 'Different.'; },
    (s) => { s.history[0].inputRefs.reverse(); },
    (s) => { s.attempts[0].logicalCost = 0; },
    (s) => { s.attempts[0].sessionId = 'other-session'; },
  ];
  for (const change of tamper) {
    const h = fixture();
    h.edit(change);
    assert.throws(() => h.r5.resolve(h.attemptId), Error, change.toString());
    assert.throws(() => h.source.build({ attemptId: h.attemptId }), Error, change.toString());
  }
});

console.log('\nGlobal before local');

await check('an unrelated corrupt SemanticIssue ledger blocks the pack though the requested refs resolve', () => {
  const h = fixture({ order: ['AUTHOR', 'FINDING'] });
  h.session.semanticIssues['stray-issue'] = { id: 'stray-issue', title: 'Stray', description: 'Refers to nothing.',
    findingIds: ['no-such-finding'], evidenceState: 'NOT_APPLICABLE', status: 'OPEN' };
  assert.equal(h.r5.resolve(h.attemptId).attemptId, h.attemptId, 'locally, the requested route looks valid');
  assert.throws(() => h.source.build({ attemptId: h.attemptId }), /assertSemanticIssueLedgerIntegrity/);
});

await check('an unrelated corrupt HumanAdjudication ledger blocks the pack', () => {
  const h = fixture();
  h.session.adjudications['key-a'] = { id: 'key-b', semanticIssueId: h.ref.ISSUE.id, judgment: 'NEW_MATERIAL',
    actionChange: 'NO', note: 'x', adjudicatedAt: '2026-09-27T00:00:00.000Z' };
  assert.equal(h.r5.resolve(h.attemptId).attemptId, h.attemptId);
  assert.throws(() => h.source.build({ attemptId: h.attemptId }), /assertHumanAdjudicationLedgerIntegrity/);
});

await check('an unrelated orphan RouteOutcome, or a corrupt unrelated attempt, blocks the pack', () => {
  const orphan = fixture();
  orphan.edit((s) => s.outcomes.push({ ...structuredClone(failedOutcome('no-such-attempt')) }));
  assert.equal(orphan.r5.resolve(orphan.attemptId).attemptId, orphan.attemptId);
  assert.throws(() => orphan.source.build({ attemptId: orphan.attemptId }), /does not resolve to exactly one RouteAttempt/);

  const second = fixture();
  let state = second.inner.current();
  const q2 = createUnresolvedQuestion(second.session, { rootCause: 'STABILITY_QUESTION', materialityReason: 'Another gap.',
    inputRefs: [second.ref.FINDING_B] });
  state = registerUnresolvedQuestion(second.session, state, q2);
  const d2 = planRouteForQuestion(second.session, state, q2);
  state = recordRouteDecision(second.session, state, d2);
  state = recordRouteAttemptStart(second.session, state, d2.id);
  state.history[1].reason.materialityReason = 'Disagrees with its question.';
  second.inner.commitDeliberationState(state);
  assert.equal(second.r5.resolve(second.attemptId).attemptId, second.attemptId);
  assert.throws(() => second.source.build({ attemptId: second.attemptId }), /materialityReason/);
});

console.log('\nNo authority, no execution');

await check('builds read state and never commit, record, or change it', () => {
  const h = fixture();
  const before = JSON.stringify(h.inner.current());
  const sessionBefore = JSON.stringify(h.session);
  h.source.build({ attemptId: h.attemptId, artifactSelection: { startChar: 0, endChar: 4 } });
  h.source.verifyCurrent(h.source.build({ attemptId: h.attemptId }));
  assert.equal(h.commits.count, 0);
  assert.equal(JSON.stringify(h.inner.current()), before);
  assert.equal(JSON.stringify(h.session), sessionBefore);
});

await check('ContextPack production code has no write, claim, execution, provider, or successor path', () => {
  const files = ['src/context/types.ts', 'src/context/fingerprint.ts', 'src/context/pack.ts', 'src/stress-test/context-source.ts'];
  const source = files.map((path) => readFileSync(path, 'utf8')).join('\n');
  for (const name of ['addFinding', 'createSemanticIssue', 'recordRouteOutcome', 'recordQuestionDisposition', 'adjudicate(',
    'planRevisionAction', 'implementRevisionAction', 'recordRevisionVerification', 'recordExecutionTerminalFact',
    'persistExecutionTerminalFactAsRouteOutcome', 'markExecutionOutcomeCommitted', 'claimRouteExecution', 'ExecutionBoundary',
    'ProviderExecutor', 'callProvider', 'commitDeliberationState', 'revisionSuccessor', 'ConsultationRecord',
    "from '../execution", "from '../providers", "from '../consultation/coordinator", 'randomUUID', 'Date.now']) {
    assert.equal(source.includes(name), false, `${name} must not appear in ContextPack production code`);
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
