// Offline tests for ContextPack currentness: CURRENT only on exact equality with current
// canonical facts, STALE for an intact pack whose facts moved on, and a thrown failure for
// a tampered pack or for corrupt, ambiguous, or foreign canonical state. No TTL.
import assert from 'node:assert/strict';
import { contextFingerprint } from './dist/context/fingerprint.js';
import { InvalidContextPackError } from './dist/context/pack.js';
import { createStressTestContextPackSource } from './dist/stress-test/context-source.js';
import {
  addAuthorContextItem, addFinding, createDeliberationState, createInMemoryDeliberationStateAccessPort, createSemanticIssue,
  createSession, createUnresolvedQuestion, freezeInput, planRouteForQuestion, recordQuestionDisposition, recordRouteAttemptStart,
  recordRouteDecision, recordRouteOutcome, registerUnresolvedQuestion,
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
const WIDE = { maxSerializedChars: 1_000_000 };

function baseSession() {
  let session = createSession(ARTIFACT);
  session = addAuthorContextItem(session, 'knownRisks', { text: 'The lease may not renew.', sourceType: 'AUTHOR' });
  session = freezeInput(session);
  for (const title of ['Unsupported payback', 'Unstated lease term']) {
    session = addFinding(session, { reviewerRunId: 'review-1', type: 'CLAIM', title, artifactLocation: 'paragraph 2',
      evidenceState: 'UNSUPPORTED_IN_MATERIAL', whyMaterial: 'It drives the decision.',
      likelyRecipientChallenge: 'Where is this from?', minimumBeforeSendAction: 'Cite it.' });
  }
  return createSemanticIssue(session, { title: 'Payback', description: 'Payback is unsupported.',
    findingIds: Object.keys(session.findings), evidenceState: 'UNSUPPORTED_IN_MATERIAL' });
}

function fixture(rootCause = 'COVERAGE_GAP', session = baseSession()) {
  const refs = [{ kind: 'AUTHOR_CONTEXT_ITEM', id: session.authorContext.knownRisks[0].id },
    { kind: 'FINDING', id: Object.keys(session.findings)[0] }, { kind: 'SEMANTIC_ISSUE', id: Object.keys(session.semanticIssues)[0] }];
  let state = createDeliberationState(session, { costCeiling: 20, latencyCeiling: 20 });
  const question = createUnresolvedQuestion(session, { rootCause, materialityReason: 'The payback claim is material.', inputRefs: refs });
  state = registerUnresolvedQuestion(session, state, question);
  const decision = planRouteForQuestion(session, state, question);
  state = recordRouteDecision(session, state, decision);
  state = recordRouteAttemptStart(session, state, decision.id);
  const attemptId = state.attempts[0].attemptId;
  const access = createInMemoryDeliberationStateAccessPort(state);
  const edit = (change) => { const next = access.current(); change(next); access.commitDeliberationState(next); };
  const source = createStressTestContextPackSource(session, access, state.id, WIDE);
  const pack = source.build({ attemptId, artifactSelection: { startChar: 0, endChar: 27 } });
  return { session, state, access, edit, attemptId, question, refs, source, pack };
}

const copy = (pack) => JSON.parse(JSON.stringify(pack));
/** Tampers and re-seals consistently: the fingerprint matches the new payload. */
const reseal = (pack, change) => {
  const next = copy(pack);
  change(next);
  next.contextFingerprint = contextFingerprint(next);
  return next;
};
const failedOutcome = (attemptId) => ({ attemptId, status: 'FAILED', latencyConsumed: 1,
  failure: { category: 'TRANSPORT', message: 'offline failure fixture' } });

console.log('\nCURRENT');

for (const rootCause of ['COVERAGE_GAP', 'STABILITY_QUESTION']) {
  await check(`a fresh ${rootCause} pack is CURRENT`, () => {
    const h = fixture(rootCause);
    assert.deepEqual(h.source.verifyCurrent(h.pack), { status: 'CURRENT', contextFingerprint: h.pack.contextFingerprint });
  });
}

await check('capturedAt proves nothing: an old timestamp on an intact pack is still judged by facts alone', () => {
  const h = fixture();
  const old = copy(h.pack);
  old.capturedAt = '1999-01-01T00:00:00.000Z';
  assert.equal(h.source.verifyCurrent(old).status, 'CURRENT');
});

await check('a pack verified by a newly composed source over the same canonical state is CURRENT', () => {
  const h = fixture();
  const again = createStressTestContextPackSource(h.session, h.access, h.state.id, { maxSerializedChars: 50 });
  assert.equal(again.verifyCurrent(h.pack).status, 'CURRENT', 'verification is not a rebuild under a new budget');
});

console.log('\nINVALID (thrown, never STALE)');

await check('a changed payload under its old fingerprint is INVALID', () => {
  const h = fixture();
  for (const change of [
    (p) => { p.sources[1].value.title = 'forged'; },
    (p) => { p.question.materialityReason = 'forged'; },
    (p) => { p.artifact.text = 'X'.repeat(p.artifact.text.length); },
    (p) => { p.binding.inputRefs.reverse(); p.sources.reverse(); },
  ]) {
    const tampered = copy(h.pack);
    change(tampered);
    assert.throws(() => h.source.verifyCurrent(tampered), InvalidContextPackError);
  }
});

await check('a changed stored fingerprint is INVALID', () => {
  const h = fixture();
  const tampered = copy(h.pack);
  tampered.contextFingerprint = contextFingerprint({ ...h.pack, question: { ...h.pack.question, rootCause: 'NONE' } });
  assert.throws(() => h.source.verifyCurrent(tampered), InvalidContextPackError);
});

await check('a malformed or non-data pack is INVALID', () => {
  const h = fixture();
  for (const bad of [null, {}, { ...copy(h.pack), extra: true }, { ...copy(h.pack), schemaVersion: 'other' },
    { ...copy(h.pack), verify: () => true }]) {
    assert.throws(() => h.source.verifyCurrent(bad), InvalidContextPackError);
  }
});

console.log('\nSTALE (an intact pack whose facts moved on)');

await check('a RouteOutcome on the attempt makes the pack STALE, and stays STALE through the next cycle', () => {
  const h = fixture();
  let state = recordRouteOutcome(h.session, h.access.current(), failedOutcome(h.attemptId));
  h.access.commitDeliberationState(state);
  assert.deepEqual(h.source.verifyCurrent(h.pack), { status: 'STALE', reason: 'ROUTE_OUTCOME_RECORDED',
    contextFingerprint: h.pack.contextFingerprint });
  state = recordQuestionDisposition(h.session, state, { attemptId: h.attemptId, disposition: 'STILL_OPEN', reason: 'retry' });
  const decision = planRouteForQuestion(h.session, state, state.unresolvedQuestions[0]);
  state = recordRouteDecision(h.session, state, decision);
  state = recordRouteAttemptStart(h.session, state, decision.id);
  h.access.commitDeliberationState(state);
  assert.equal(h.source.verifyCurrent(h.pack).reason, 'ROUTE_OUTCOME_RECORDED');
  const next = h.source.build({ attemptId: state.attempts[1].attemptId, artifactSelection: { startChar: 0, endChar: 27 } });
  assert.notEqual(next.contextFingerprint, h.pack.contextFingerprint, 'a new cycle needs a new pack');
  assert.equal(h.source.verifyCurrent(next).status, 'CURRENT');
});

await check('a question resolved after its outcome leaves an old pack STALE', () => {
  const h = fixture('STABILITY_QUESTION');
  let state = recordRouteOutcome(h.session, h.access.current(), failedOutcome(h.attemptId));
  state = recordQuestionDisposition(h.session, state, { attemptId: h.attemptId, disposition: 'RESOLVED', reason: 'settled' });
  h.access.commitDeliberationState(state);
  assert.equal(h.source.verifyCurrent(h.pack).status, 'STALE');
});

await check('a stopped deliberation leaves the pack STALE', () => {
  const h = fixture();
  h.edit((s) => { s.stopReason = 'budget'; });
  assert.equal(h.source.verifyCurrent(h.pack).reason, 'DELIBERATION_STOPPED');
});

await check('changed finding or issue content in the session makes the pack STALE, with the current fingerprint', () => {
  for (const change of [
    (s) => { s.findings[Object.keys(s.findings)[0]].title = 'Rewritten title'; },
    (s) => { s.semanticIssues[Object.keys(s.semanticIssues)[0]].description = 'Rewritten description.'; },
  ]) {
    const h = fixture();
    change(h.session);
    const result = h.source.verifyCurrent(h.pack);
    assert.equal(result.status, 'STALE');
    assert.equal(result.reason, 'SOURCE_CHANGED');
    assert.match(result.currentFingerprint, /^[0-9a-f]{64}$/);
    assert.notEqual(result.currentFingerprint, h.pack.contextFingerprint);
  }
});

await check('a self-consistent pack whose refs, question, or sources differ from current facts is STALE, never CURRENT', () => {
  const h = fixture();
  for (const change of [
    (p) => { p.binding.inputRefs.reverse(); p.sources.reverse(); },
    (p) => { p.question.materialityReason = 'A different reason.'; },
    (p) => { p.sources[1].value.whyMaterial = 'A different reason.'; },
    (p) => { p.binding.decisionId = 'some-other-decision'; },
    (p) => { p.artifact.text = p.artifact.text.toUpperCase(); },
  ]) {
    const forged = reseal(h.pack, change);
    const result = h.source.verifyCurrent(forged);
    assert.equal(result.status, 'STALE', change.toString());
    assert.equal(result.currentFingerprint, h.pack.contextFingerprint);
  }
});

console.log('\nFail closed (thrown)');

await check('changed author context breaks the frozen hash and fails closed', () => {
  const h = fixture();
  h.session.authorContext.knownRisks[0].text = 'Rewritten.';
  assert.throws(() => h.source.verifyCurrent(h.pack), /authorContextHash/);
});

await check('a session or hash mismatch fails closed', () => {
  const h = fixture();
  h.edit((s) => { s.artifactHash = 'f'.repeat(64); s.authorContextHash = 'f'.repeat(64); });
  assert.throws(() => h.source.verifyCurrent(h.pack), /artifactHash/);
  const forged = reseal(fixture().pack, (p) => { p.binding.artifactHash = 'e'.repeat(64); });
  const g = fixture();
  assert.throws(() => g.source.verifyCurrent({ ...forged, binding: { ...forged.binding, sessionId: g.session.id,
    deliberationStateId: g.state.id } }), InvalidContextPackError);
  const hashOnly = reseal(g.pack, (p) => { p.binding.artifactHash = 'e'.repeat(64); });
  assert.throws(() => g.source.verifyCurrent(hashOnly), /frozen hashes/);
});

await check('a pack never rebinds to another session, including a successor-style session', () => {
  const h = fixture();
  const successor = baseSession();
  const other = fixture('COVERAGE_GAP', successor);
  assert.throws(() => other.source.verifyCurrent(h.pack), /never rebinds/);
  const sameStateOtherSession = createStressTestContextPackSource(successor, h.access, h.state.id, WIDE);
  assert.throws(() => sameStateOtherSession.verifyCurrent(h.pack), /never rebinds/);
});

await check('ambiguous or corrupt current state fails closed rather than reading STALE', () => {
  for (const change of [
    (s) => s.attempts.push(structuredClone(s.attempts[0])),
    (s) => s.unresolvedQuestions.push(structuredClone(s.unresolvedQuestions[0])),
    (s) => s.history.push(structuredClone(s.history[0])),
    (s) => { s.history[0].reason.materialityReason = 'Disagrees with its question.'; },
    (s) => { s.unresolvedQuestions[0].inputRefs.reverse(); },
    (s) => s.outcomes.push(failedOutcome('no-such-attempt')),
    (s) => { s.attempts = []; },
  ]) {
    const h = fixture();
    h.edit(change);
    assert.throws(() => h.source.verifyCurrent(h.pack), Error, change.toString());
  }
});

await check('an unrelated corrupt session ledger fails verification closed', () => {
  const h = fixture();
  h.session.semanticIssues['stray-issue'] = { id: 'stray-issue', title: 'Stray', description: 'Refers to nothing.',
    findingIds: ['no-such-finding'], evidenceState: 'NOT_APPLICABLE', status: 'OPEN' };
  assert.throws(() => h.source.verifyCurrent(h.pack), /assertSemanticIssueLedgerIntegrity/);
});

console.log('\nNo refresh, no TTL');

await check('verification never changes or refreshes the offered pack', () => {
  const h = fixture();
  const before = JSON.stringify(h.pack);
  h.session.findings[Object.keys(h.session.findings)[0]].title = 'Rewritten title';
  const result = h.source.verifyCurrent(h.pack);
  assert.equal(result.status, 'STALE');
  assert.equal(JSON.stringify(h.pack), before);
  assert.ok(Object.isFrozen(h.pack) && Object.isFrozen(result));
  const thawed = copy(h.pack);
  h.source.verifyCurrent(thawed);
  assert.equal(JSON.stringify(thawed), before, 'even a thawed copy is not written to');
});

await check('there is no age-based expiry: a pack stays CURRENT while its facts do, whatever time passes', () => {
  let now = Date.UTC(2026, 0, 1);
  const session = baseSession();
  const h = fixture('COVERAGE_GAP', session);
  const source = createStressTestContextPackSource(session, h.access, h.state.id, WIDE, { now: () => new Date(now) });
  const pack = source.build({ attemptId: h.attemptId });
  now += 10 * 365 * 86_400_000;
  assert.equal(source.verifyCurrent(pack).status, 'CURRENT');
  assert.equal(source.build({ attemptId: h.attemptId }).contextFingerprint, pack.contextFingerprint);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
