/**
 * Offline tests for the M2-B experiment harness.
 *
 * No provider is called. Every oracle is a synthetic fixture, never live model output:
 * a live oracle would make the suite non-deterministic and would put a model's judgment
 * inside a check meant to be structural.
 *
 * Every invariant here has a matching negative test that breaks it on purpose. An
 * assertion that has never been observed to fail is not evidence that it can (HANDOFF
 * §25 E4, and the rev.21 principle) — so each guard is proven failable before it is
 * relied on.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildRunReport, buildOutputBanner } from '../../dist/modes/orchestrator.js';
import { createDispatcher, ModelPinViolation, RetrievalPolicyViolation } from './harness/dispatcher.mjs';
import { runArmB, runArmBPrime, runArmC, runArmD1, runAllArms, buildSpecialistBlock } from './harness/arms.mjs';
import { buildSelfReviewPrompt, buildSelfReviewDecisionPrompt, extractDecisionContract } from './harness/prompts.mjs';
import { assertNoPeerLeakage, PeerLeakageDetected } from './harness/leakage.mjs';
import { evidenceBaseline, assertEvidenceIsolation, EvidenceInvariantViolation } from './harness/invariants.mjs';
import { normalizeAnswer, verifyNormalization, NormalizationError } from './harness/normalizer.mjs';
import { buildBlindPairs, assertPairsBlind, PairLeakageDetected } from './harness/pairs.mjs';
import { validateManifest, sealManifest, ManifestInvalid, MANDATORY_FIELDS, isUtcIso } from './harness/manifest.mjs';
import { buildRunArtifact } from './harness/artifact.mjs';
import { verifyArtifact } from './verify.mjs';
import * as F from './fixtures/synthetic/fixture.mjs';

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
/** Asserts `fn` throws, and that the error is the specific type the guard promises. */
async function mustThrow(fn, type, hint) {
  let thrown = null;
  try { await fn(); } catch (e) { thrown = e; }
  assert.ok(thrown, `expected a throw (${hint}) but nothing was thrown`);
  assert.ok(thrown instanceof type, `expected ${type.name} but got ${thrown.constructor.name}: ${thrown.message}`);
  return thrown;
}

const PEER = { chunkText: F.PEER_CHUNK_TEXT, challengeText: F.CHALLENGE_TEXT, sourceRef: F.SOURCE_REF };

/**
 * Deterministic clock. H-05 timestamp behaviour is asserted offline, with no provider
 * anywhere near it — a wall clock would make these tests flaky for no gain.
 */
const RUN_STARTED_AT = '2026-01-01T00:00:00.000Z';
function fakeClock(startIso = RUN_STARTED_AT, stepMs = 1000) {
  let t = Date.parse(startIso);
  return () => { const at = new Date(t); t += stepMs; return at; };
}
const base = () => ({ snapshot: F.SNAPSHOT, pins: F.PINS, temperature: 0 });

/* ============================================================== arm runners */
console.log('\nArm runners (PASS cases)');

await check('arm B runs synthesis only and spends exactly one call', async () => {
  const stub = F.makeStub();
  const b = await runArmB({ ...base(), call: stub.call });
  assert.deepEqual(b.calls.map((c) => c.stage), ['synthesis']);
  assert.equal(b.billable, 1);
  assert.ok(b.result.finalOutput.endsWith(F.PLAIN_SYNTHESIS));
  assert.equal(b.result.collaboration, undefined, 'arm B must carry no collaboration object at all');
});

await check('arm B-prime runs the gate, records it, and never reaches Round 2', async () => {
  const stub = F.makeStub();
  const bp = await runArmBPrime({ ...base(), call: stub.call });
  assert.deepEqual(bp.calls.map((c) => c.stage), ['synthesis_gate']);
  assert.equal(bp.billable, 1);
  assert.equal(bp.result.collaboration.status, 'SKIPPED');
  assert.equal(bp.result.collaboration.reason, 'round2_disabled');
  assert.ok(bp.gateRecording, 'B-prime must produce the gate recording C and D1 replay');
  assert.equal(bp.gateRecording.text, F.GATE_TEXT);
});

await check('B-prime keeps selectedIssue, which is what lets C and D1 share a target', async () => {
  const stub = F.makeStub();
  const bp = await runArmBPrime({ ...base(), call: stub.call });
  assert.equal(bp.result.collaboration.selectedIssue.targetAgentId, 'brand');
  assert.equal(bp.result.collaboration.selectedIssue.sourceRef, F.SOURCE_REF);
});

await check('arm C replays the shared gate and adds exactly two billable calls', async () => {
  const stub = F.makeStub();
  const bp = await runArmBPrime({ ...base(), call: stub.call });
  const c = await runArmC({ ...base(), call: stub.call, gateRecording: bp.gateRecording });
  assert.deepEqual(c.calls.map((x) => x.stage), ['synthesis_gate', 'round2_worker', 'decision_synthesis']);
  assert.equal(c.billable, 2, 'the replayed gate must not be billed');
  assert.equal(c.calls.find((x) => x.stage === 'synthesis_gate').replayed, true);
  assert.equal(c.result.collaboration.status, 'COMPLETED');
  assert.ok(c.result.finalOutput.endsWith(F.DECISION_TEXT));
});

await check('arm D1 runs self_review then decision_synthesis, two billable calls', async () => {
  const stub = F.makeStub();
  const bp = await runArmBPrime({ ...base(), call: stub.call });
  const d1 = await runArmD1({ ...base(), call: stub.call, bPrime: bp, peer: PEER });
  assert.equal(d1.skipped, false);
  assert.deepEqual(d1.calls.map((x) => x.stage), ['self_review', 'decision_synthesis']);
  assert.equal(d1.billable, 2);
  assert.equal(d1.result.selfReview.agentId, 'brand', 'D1 must challenge the same specialist C challenged');
  assert.ok(d1.result.finalOutput.endsWith(F.DECISION_TEXT));
});

await check('C and D1 are built on a byte-identical provisional answer', async () => {
  const stub = F.makeStub();
  const bp = await runArmBPrime({ ...base(), call: stub.call });
  const c = await runArmC({ ...base(), call: stub.call, gateRecording: bp.gateRecording });
  assert.equal(c.result.collaboration.provisionalAnswer, bp.result.collaboration.provisionalAnswer);
  assert.equal(c.result.collaboration.provisionalAnswer, F.PROVISIONAL);
});

await check('the shared gate prompt is identical for B-prime and C', async () => {
  const stub = F.makeStub();
  const bp = await runArmBPrime({ ...base(), call: stub.call });
  const c = await runArmC({ ...base(), call: stub.call, gateRecording: bp.gateRecording });
  assert.equal(
    c.calls.find((x) => x.stage === 'synthesis_gate').promptSha256,
    bp.calls.find((x) => x.stage === 'synthesis_gate').promptSha256
  );
});

/* ========================================================= call accounting */
console.log('\nCall accounting');

await check('one fixture-repetition costs exactly six billable provider calls', async () => {
  const stub = F.makeStub();
  const run = await runAllArms({ ...base(), call: stub.call });
  assert.deepEqual(run.accounting, {
    B: 1, sharedGate: 1, C: 2, D1: 2, totalBillable: 6, naiveWithoutSharedGate: 8,
  });
});

await check('the six calls carry the expected stages, gate charged once', async () => {
  const stub = F.makeStub();
  await runAllArms({ ...base(), call: stub.call });
  const stages = stub.seen.map((s) => s.stage).sort();
  assert.deepEqual(stages, ['decision_synthesis', 'decision_synthesis', 'round2_worker', 'self_review', 'synthesis', 'synthesis_gate']);
  assert.equal(stub.seen.filter((s) => s.stage === 'synthesis_gate').length, 1, 'the gate must reach the provider once');
});

/* ============================================================ model pinning */
console.log('\nModel pinning');

await check('a run whose resolved model matches the pin is accepted', async () => {
  const stub = F.makeStub();
  const b = await runArmB({ ...base(), call: stub.call });
  assert.equal(b.calls[0].requestedModel, 'stub-synth-1');
  assert.equal(b.calls[0].resolvedModel, 'stub-synth-1');
});

await check('NEGATIVE: resolvedModel != requestedModel aborts the run', async () => {
  const stub = F.makeStub({ resolvedModel: { synthesis: 'some-other-model' } });
  const err = await mustThrow(() => runArmB({ ...base(), call: stub.call }), ModelPinViolation, 'pin mismatch');
  assert.equal(err.resolvedModel, 'some-other-model');
  assert.match(err.message, /INVALID/);
});

await check('NEGATIVE: a stage with no pin is a manifest error, not an adapter default', async () => {
  const stub = F.makeStub();
  const { synthesis: _drop, ...withoutSynthesis } = F.PINS;
  await mustThrow(
    () => runArmB({ ...base(), pins: withoutSynthesis, call: stub.call }),
    Error, 'missing pin'
  );
});

/* ============================================================== NC-3 leakage */
console.log('\nNC-3 peer-leakage guard');

await check('a clean D1 self-review prompt passes NC-3', () => {
  const prompt = buildSelfReviewPrompt({
    task: F.SNAPSHOT.task,
    mission: F.SNAPSHOT.workerResults[1].mission,
    previousOutput: F.SNAPSHOT.workerResults[1].output,
  });
  const report = assertNoPeerLeakage(prompt, PEER);
  assert.deepEqual(report.checked, ['sourceRef', 'peer chunk', 'peer challenge']);
  assert.deepEqual(report.notChecked, ['paraphrase', 'topic steer', 'semantic leakage']);
});

await check('the D1 prompt builder has no parameter through which peer text could arrive', () => {
  assert.equal(buildSelfReviewPrompt.length, 1);
  const prompt = buildSelfReviewPrompt({ task: 'T', mission: 'M', previousOutput: 'P' });
  assert.ok(!prompt.includes('peer'));
  assert.ok(!prompt.includes('another specialist'));
});

await check('NEGATIVE: peer chunk text smuggled into a D prompt is caught', () => {
  const contaminated = `Original task:\nX\n\nSomeone noted: ${F.PEER_CHUNK_TEXT}\n`;
  const err = mustThrowSync(() => assertNoPeerLeakage(contaminated, PEER), PeerLeakageDetected);
  assert.equal(err.kind, 'peer chunk');
});

await check('NEGATIVE: peer challenge text smuggled into a D prompt is caught', () => {
  // A fragment unique to the gate-authored challenge: it appears nowhere in Round 1, so
  // attribution is unambiguous. (The full challenge shares a window with the chunk it was
  // written about, which is realistic — a challenge usually quotes its target.)
  const uniqueToChallenge = 'the flagship work depends on?';
  assert.ok(F.CHALLENGE_TEXT.includes(uniqueToChallenge));
  assert.ok(!F.PEER_CHUNK_TEXT.includes(uniqueToChallenge));
  const err = mustThrowSync(
    () => assertNoPeerLeakage(`Original task:\nX\n\nConsider: ${uniqueToChallenge}\n`, PEER),
    PeerLeakageDetected
  );
  assert.equal(err.kind, 'peer challenge');
});

await check('NC-3 scoping: the decision prompt may carry the peer chunk, since Round 1 does', () => {
  // Both arms' decision synthesis sees the full Round 1 block. Forbidding it here would
  // break the parity that makes C and D1 comparable at all.
  const withRound1 = `Results from each specialist:\n${F.SNAPSHOT.workerResults[0].output}`;
  mustThrowSync(() => assertNoPeerLeakage(withRound1, PEER), PeerLeakageDetected);
  const report = assertNoPeerLeakage(withRound1, PEER, { allowPeerChunk: true });
  assert.deepEqual(report.checked, ['sourceRef', 'peer challenge']);
  assert.ok(report.notChecked[0].includes('present in Round 1 for both arms'));
});

await check('NEGATIVE: even in decision-prompt mode, the gate-authored challenge is still forbidden', () => {
  const contaminated = `Results:\n${F.SNAPSHOT.workerResults[0].output}\n\n${F.CHALLENGE_TEXT}`;
  const err = mustThrowSync(
    () => assertNoPeerLeakage(contaminated, PEER, { allowPeerChunk: true }),
    PeerLeakageDetected
  );
  assert.equal(err.kind, 'peer challenge');
});

await check('NEGATIVE: even in decision-prompt mode, the sourceRef is still forbidden', () => {
  mustThrowSync(
    () => assertNoPeerLeakage(`Results:\nsee ${F.SOURCE_REF}`, PEER, { allowPeerChunk: true }),
    PeerLeakageDetected
  );
});

await check('NEGATIVE: a bare sourceRef in a D prompt is caught', () => {
  const err = mustThrowSync(() => assertNoPeerLeakage(`see ${F.SOURCE_REF} for context`, PEER), PeerLeakageDetected);
  assert.equal(err.kind, 'sourceRef');
});

await check('NC-3 catches a reflowed quotation, not only an exact one', () => {
  const reflowed = 'A second site competes for the same\nsenior editors that carry the high-margin work.';
  mustThrowSync(() => assertNoPeerLeakage(`X\n\n${reflowed}`, PEER), PeerLeakageDetected);
});

await check('NC-3 states plainly that it does not catch paraphrase', () => {
  const paraphrase = 'The new location would draw on the very same experienced staff.';
  // Passes on purpose. The guard is not claimed to cover this; §19 X11 records the gap.
  const report = assertNoPeerLeakage(`X\n\n${paraphrase}`, PEER);
  assert.ok(report.notChecked.includes('paraphrase'));
});

await check('arm D1 refuses to call the provider when its prompt is contaminated', async () => {
  const stub = F.makeStub();
  const bp = await runArmBPrime({ ...base(), call: stub.call });
  const before = stub.seen.length;
  // The peer record claims the target's own answer is peer text, so the guard must fire.
  const poisoned = { ...PEER, chunkText: F.SNAPSHOT.workerResults[1].output.slice(0, 60) };
  await mustThrow(
    () => runArmD1({ ...base(), call: stub.call, bPrime: bp, peer: poisoned }),
    PeerLeakageDetected, 'contaminated D1'
  );
  assert.equal(stub.seen.length, before, 'no provider call may be made once leakage is detected');
});

await check('NEGATIVE: a whole challenge string transplanted into a D prompt is caught in both modes', () => {
  // The failure actually worth catching: a harness bug passing selected.challenge through.
  const transplanted = `Results:\n${F.SNAPSHOT.workerResults[0].output}\n\nAddress this: ${F.CHALLENGE_TEXT}`;
  for (const opts of [{}, { allowPeerChunk: true }]) {
    const err = mustThrowSync(() => assertNoPeerLeakage(transplanted, PEER, opts), PeerLeakageDetected);
    assert.equal(err.kind, 'peer challenge');
  }
});

await check('NEGATIVE: a whole peer chunk transplanted into a middle-round prompt is caught', () => {
  const transplanted = `Your previous answer:\nX\n\nAnother specialist wrote: ${F.PEER_CHUNK_TEXT}`;
  const err = mustThrowSync(() => assertNoPeerLeakage(transplanted, PEER), PeerLeakageDetected);
  assert.equal(err.kind, 'peer chunk');
});

await check('the guard reports which checks are exact-string and which are windowed', () => {
  const clean = buildSelfReviewPrompt({ task: 'T', mission: 'M', previousOutput: 'P' });
  const mid = assertNoPeerLeakage(clean, PEER);
  assert.deepEqual(mid.exactStringChecked, ['sourceRef', 'challengeText', 'chunkText']);
  assert.equal(mid.windowChars, 20);
  const dec = assertNoPeerLeakage(clean, PEER, { allowPeerChunk: true });
  assert.deepEqual(dec.exactStringChecked, ['sourceRef', 'challengeText']);
  assert.equal(dec.windowChars, 60, 'decision mode widens the window; see leakage.mjs for why');
});

/* ========================================================= NC-2 evidence */
console.log('\nNC-2 evidence isolation');

await check('all four arms leave the evidence baseline untouched', async () => {
  const stub = F.makeStub();
  const run = await runAllArms({ ...base(), call: stub.call });
  const baseline = evidenceBaseline(F.SNAPSHOT);
  for (const [arm, r] of Object.entries(run.arms)) {
    const out = assertEvidenceIsolation(arm, baseline, r.result, r.calls);
    assert.equal(out.evidenceLabel, baseline.evidenceLabel);
  }
});

await check('NEGATIVE: an evidenceLabel changed after the second round is caught', () => {
  const baseline = evidenceBaseline(F.SNAPSHOT);
  const tampered = {
    report: { ...baseline.report, evidenceLabel: 'PARTIALLY_GROUNDED' },
    finalOutput: baseline.banner + 'x',
  };
  const err = mustThrowSync(() => assertEvidenceIsolation('C', baseline, tampered, []), EvidenceInvariantViolation);
  assert.match(err.message, /INVALID/);
});

await check('NEGATIVE: a RunStatus changed after the second round is caught', () => {
  const baseline = evidenceBaseline(F.SNAPSHOT);
  const tampered = { report: { ...baseline.report, status: 'DEGRADED' }, finalOutput: baseline.banner + 'x' };
  mustThrowSync(() => assertEvidenceIsolation('C', baseline, tampered, []), EvidenceInvariantViolation);
});

await check('NEGATIVE: a missing banner is caught', () => {
  const baseline = evidenceBaseline(F.SNAPSHOT);
  mustThrowSync(
    () => assertEvidenceIsolation('C', baseline, { report: baseline.report, finalOutput: 'no banner here' }, []),
    EvidenceInvariantViolation
  );
});

await check('NEGATIVE: retrieval on any call violates the all-off policy', async () => {
  const stub = F.makeStub({ retrievalAt: 'synthesis' });
  await mustThrow(() => runArmB({ ...base(), call: stub.call }), RetrievalPolicyViolation, 'retrieval present');
});

await check('NEGATIVE: a retrieval result recorded in the call log is caught by NC-2 too', () => {
  const baseline = evidenceBaseline(F.SNAPSHOT);
  const calls = [{ stage: 'round2_worker', retrievalRequested: null, retrievalResult: { status: 'GROUNDED' } }];
  mustThrowSync(
    () => assertEvidenceIsolation('C', baseline, { report: baseline.report, finalOutput: baseline.banner + 'x' }, calls),
    EvidenceInvariantViolation
  );
});

/* ========================================================== normalization */
console.log('\nNormalization');

await check('normalization removes the banner and nothing else', () => {
  const report = buildRunReport(F.SNAPSHOT.complexity, F.SNAPSHOT.workers, F.SNAPSHOT.workerResults);
  const banner = buildOutputBanner(report);
  const raw = banner + 'Body with a caveat: I could not verify this number.';
  const out = normalizeAnswer(raw, banner);
  assert.equal(out.text, 'Body with a caveat: I could not verify this number.');
  assert.ok(out.text.includes('could not verify'), 'caveats are content and must survive');
});

await check('normalization is deterministic across repeated runs', () => {
  const report = buildRunReport(F.SNAPSHOT.complexity, F.SNAPSHOT.workers, F.SNAPSHOT.workerResults);
  const banner = buildOutputBanner(report);
  const raw = banner + F.DECISION_TEXT;
  const a = normalizeAnswer(raw, banner);
  const b = normalizeAnswer(raw, banner);
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.sha256, createHash('sha256').update(F.DECISION_TEXT).digest('hex'));
});

await check('NEGATIVE: a substantively edited normalized answer fails verification', () => {
  const report = buildRunReport(F.SNAPSHOT.complexity, F.SNAPSHOT.workers, F.SNAPSHOT.workerResults);
  const banner = buildOutputBanner(report);
  const raw = banner + 'Defer the decision. This estimate is unverified.';
  const edited = 'Defer the decision.'; // a caveat removed — exactly the forbidden edit
  const out = verifyNormalization(raw, banner, edited);
  assert.equal(out.deterministic, false);
});

await check('NEGATIVE: normalizing with the wrong banner refuses rather than guesses', () => {
  mustThrowSync(() => normalizeAnswer('some answer', '> NOT THE BANNER\n\n'), NormalizationError);
});

/* ============================================================ blind pairs */
console.log('\nBlind pairs');

await check('pairs carry only a pairId and two answers', () => {
  const normalized = { B: { text: 'b' }, B_prime: { text: 'bp' }, C: { text: 'c' }, D1: { text: 'd' } };
  const { pairs, assignments } = buildBlindPairs({
    fixtureId: 'synthetic-1', runIndex: 1, normalized,
    comparisons: [['B', 'B_prime'], ['B_prime', 'C'], ['C', 'D1']],
  });
  assert.equal(pairs.length, 6, 'three comparisons, counterbalanced');
  for (const p of pairs) assert.deepEqual(Object.keys(p).sort(), ['answerX', 'answerY', 'pairId']);
  assert.equal(assignments.length, 6);
  assert.ok(assignments.every((a) => a.answerX && a.answerY));
});

await check('counterbalancing emits both orders of every comparison', () => {
  const normalized = { C: { text: 'c' }, D1: { text: 'd' } };
  const { assignments } = buildBlindPairs({ fixtureId: 'f', runIndex: 1, normalized, comparisons: [['C', 'D1']] });
  assert.deepEqual(assignments.map((a) => `${a.answerX}->${a.answerY}`), ['C->D1', 'D1->C']);
});

await check('the hidden assignment map is separate from what the judge sees', () => {
  const normalized = { C: { text: 'c' }, D1: { text: 'd' } };
  const { pairs, assignments } = buildBlindPairs({ fixtureId: 'f', runIndex: 1, normalized, comparisons: [['C', 'D1']] });
  assert.ok(!JSON.stringify(pairs).includes('"C"'));
  assert.ok(JSON.stringify(assignments).includes('"C"'));
});

await check('NEGATIVE: a pair carrying arm metadata is rejected', () => {
  mustThrowSync(() => assertPairsBlind([{ pairId: 'x', answerX: 'a', answerY: 'b', arm: 'C' }]), PairLeakageDetected);
});

await check('NEGATIVE: a pair carrying provider or model metadata is rejected', () => {
  mustThrowSync(() => assertPairsBlind([{ pairId: 'x', answerX: 'a', answerY: 'b', resolvedModel: 'gpt-5' }]), PairLeakageDetected);
});

/* =============================================================== manifest */
console.log('\nExperiment manifest');

const goodManifest = () => sealManifest({
  experimentId: 'm2b-offline-selftest',
  protocolVersion: 'M2B-PROTOCOL-0.2',
  fixtureId: 'synthetic-1',
  fixtureSha256: 'a'.repeat(64),
  snapshotSha256: 'b'.repeat(64),
  arm: 'C',
  runIndex: 1,
  startedAt: RUN_STARTED_AT,
  pins: F.PINS,
  temperature: 0,
  retrievalPolicy: 'all-off',
  evidenceLabelBaseline: 'HYPOTHESIS',
  runtimeCommit: 'c'.repeat(40),
  promptSourceCommit: 'd'.repeat(40),
  chunkerVersion: 'e'.repeat(64),
  peerExcerptChars: 1000,
});

await check('a complete manifest validates and seals', () => {
  const m = goodManifest();
  assert.equal(validateManifest(m), m);
  assert.match(m.manifestSha256, /^[0-9a-f]{64}$/);
});

await check('NEGATIVE: every mandatory field, removed one at a time, invalidates the manifest', () => {
  for (const field of MANDATORY_FIELDS) {
    const m = goodManifest();
    delete m[field];
    const err = mustThrowSync(() => validateManifest(m), ManifestInvalid);
    assert.ok(
      err.problems.some((p) => p.includes(field)),
      `removing "${field}" must be reported by name, got: ${err.problems.join('; ')}`
    );
  }
});

await check('NEGATIVE: a pin without requestedModel is rejected (adapter default is not a pin)', () => {
  const m = goodManifest();
  m.pins = { ...m.pins, round2_worker: { provider: 'openai' } };
  const err = mustThrowSync(() => validateManifest(m), ManifestInvalid);
  assert.ok(err.problems.some((p) => p.includes('adapter default is not a pin')));
});

await check('NEGATIVE: retrievalPolicy other than all-off is rejected', () => {
  const m = goodManifest();
  m.retrievalPolicy = 'gemini-only';
  mustThrowSync(() => validateManifest(m), ManifestInvalid);
});

await check('NEGATIVE: a tampered manifestSha256 is rejected', () => {
  const m = goodManifest();
  m.peerExcerptChars = 2000;
  mustThrowSync(() => validateManifest(m), ManifestInvalid);
});

/* ======================================== C / D1 non-treatment parity */
console.log('\nC and D1 parity on non-treatment parts');

await check('D1 preserves the required non-treatment Decision contract invariants', () => {
  // Not "verbatim": buildSelfReviewDecisionPrompt re-words the treatment-specific lines
  // after extracting the contract. What must survive is the non-treatment content, which
  // is what this asserts line by line.
  const prompt = buildSelfReviewDecisionPrompt({
    task: 'T', specialistBlock: 'S', degradedNote: '',
    targetAgentId: 'brand', selfObjection: 'O', revisedOutput: 'R',
  });
  assert.ok(prompt.includes('Revision, recency, or agreement between specialists is not evidence.'));
  assert.ok(prompt.includes('- Produce the final answer to the original task.'));
  assert.ok(prompt.includes('- If the disagreement is unresolved, state it plainly.'));
  assert.ok(prompt.includes('The second round gathered no new external evidence.'));
});

await check('the Decision contract is derived from production, so it cannot silently drift', () => {
  const contract = extractDecisionContract();
  assert.ok(contract.startsWith('Decision contract:'));
  assert.ok(contract.includes('is not evidence'));
});

await check('the reconstructed specialist block matches what production sends arm C', async () => {
  const stub = F.makeStub();
  const bp = await runArmBPrime({ ...base(), call: stub.call });
  await runArmC({ ...base(), call: stub.call, gateRecording: bp.gateRecording });
  const decisionPrompt = stub.seen.find((s) => s.stage === 'decision_synthesis').prompt;
  assert.ok(
    decisionPrompt.includes(buildSpecialistBlock(F.SNAPSHOT)),
    'harness reconstruction of the specialist block has drifted from production'
  );
});

await check('D1 declares its treatment difference and nothing more', async () => {
  const stub = F.makeStub();
  const bp = await runArmBPrime({ ...base(), call: stub.call });
  await runArmC({ ...base(), call: stub.call, gateRecording: bp.gateRecording });
  await runArmD1({ ...base(), call: stub.call, bPrime: bp, peer: PEER });
  const cPrompt = stub.seen.filter((s) => s.stage === 'decision_synthesis')[0].prompt;
  const dPrompt = stub.seen.filter((s) => s.stage === 'decision_synthesis')[1].prompt;
  assert.ok(cPrompt.includes('A cross-specialist challenge was raised'), 'C keeps its framing; Phase 1 does no source masking');
  assert.ok(dPrompt.includes('reconsidered its own answer'));
  assert.ok(!dPrompt.includes('A cross-specialist challenge was raised'));
  assert.ok(!dPrompt.includes(F.CHALLENGE_TEXT), 'the gate-authored challenge must not reach D1 at all');
  assert.ok(!dPrompt.includes(F.SOURCE_REF), 'the sourceRef must not reach D1 at all');
  const block = buildSpecialistBlock(F.SNAPSHOT);
  assert.ok(cPrompt.includes(block) && dPrompt.includes(block), 'both arms must see the same Round 1 block');
  // Non-treatment parity: the same contract text in both.
  const contract = extractDecisionContract().split('\n').slice(1, 3).join('\n');
  assert.ok(cPrompt.includes(contract.split('\n')[0]));
  assert.ok(dPrompt.includes(contract.split('\n')[0]));
});

/* ================================================= skip and failure paths */
console.log('\nSkip and failure paths');

await check('D1 skips cleanly when the gate emitted no issue', async () => {
  const stub = F.makeStub({ gateText: F.PROVISIONAL });
  const bp = await runArmBPrime({ ...base(), call: stub.call });
  const d1 = await runArmD1({ ...base(), call: stub.call, bPrime: bp, peer: { chunkText: '', challengeText: '', sourceRef: '' } });
  assert.equal(d1.skipped, true);
  assert.equal(d1.reason, 'no_selected_issue');
  assert.equal(d1.billable, 0);
});

await check('a gate that emits no issue leaves C equal to B-prime, and that is data not an error', async () => {
  const stub = F.makeStub({ gateText: F.PROVISIONAL });
  const bp = await runArmBPrime({ ...base(), call: stub.call });
  const c = await runArmC({ ...base(), call: stub.call, gateRecording: bp.gateRecording });
  assert.equal(c.result.collaboration.reason, 'no_issue_block');
  assert.equal(c.result.finalOutput, bp.result.finalOutput);
  assert.equal(c.billable, 0, 'no Round 2, no decision synthesis, nothing spent');
});

/* ================================================================ verifier */
console.log('\nArtifact verifier');

function buildArtifact(run, stub, gateResponseText) {
  const manifest = (arm) => sealManifest({
    experimentId: 'm2b-offline-selftest', protocolVersion: 'M2B-PROTOCOL-0.2',
    fixtureId: 'synthetic-1', fixtureSha256: 'a'.repeat(64),
    snapshotSha256: createHash('sha256').update(JSON.stringify(F.SNAPSHOT)).digest('hex'),
    arm, runIndex: 1, startedAt: RUN_STARTED_AT, pins: F.PINS, temperature: 0, retrievalPolicy: 'all-off',
    evidenceLabelBaseline: 'HYPOTHESIS', runtimeCommit: 'c'.repeat(40), promptSourceCommit: 'd'.repeat(40),
    chunkerVersion: 'e'.repeat(64), peerExcerptChars: 1000,
  });
  return buildRunArtifact({
    generatedAt: RUN_STARTED_AT,
    experimentId: 'm2b-offline-selftest', fixtureId: 'synthetic-1', runIndex: 1,
    snapshot: F.SNAPSHOT, run, seen: stub.seen, gateResponseText,
    manifests: { B: manifest('B'), B_prime: manifest('B_prime'), C: manifest('C'), D1: manifest('D1') },
  });
}

async function syntheticArtifact() {
  const stub = F.makeStub();
  const run = await runAllArms({ ...base(), call: stub.call, now: fakeClock() });
  return buildArtifact(run, stub, F.GATE_TEXT);
}

await check('the verifier passes every recomputation on a clean artifact', async () => {
  const { results, ok } = verifyArtifact(await syntheticArtifact());
  const failures = results.filter((r) => r.status === 'FAIL').map((r) => `${r.name}: ${r.detail}`);
  assert.deepEqual(failures, []);
  assert.equal(ok, true);
  assert.equal(results.length, 15, 'all fifteen recomputations must run');
});

await check('NEGATIVE: the verifier catches a tampered call count', async () => {
  const a = await syntheticArtifact();
  a.arms.C.calls = a.arms.C.calls.filter((c) => c.stage !== 'round2_worker');
  const { results } = verifyArtifact(a);
  assert.equal(results.find((r) => r.name === 'trigger state and arm call accounting').status, 'FAIL');
});

await check('NEGATIVE: the verifier catches a resolvedModel that drifted off its pin', async () => {
  const a = await syntheticArtifact();
  a.arms.B.calls[0].resolvedModel = 'gpt-5';
  const { results } = verifyArtifact(a);
  assert.equal(results.find((r) => r.name === 'call / manifest pin binding').status, 'FAIL');
});

await check('NEGATIVE: the verifier catches retrieval appearing on a call', async () => {
  const a = await syntheticArtifact();
  a.arms.C.calls[1].retrievalResult = { status: 'GROUNDED' };
  const { results } = verifyArtifact(a);
  assert.equal(results.find((r) => r.name === 'retrieval all-off').status, 'FAIL');
});

await check('NEGATIVE: the verifier catches C and B-prime built on different gate samples', async () => {
  const a = await syntheticArtifact();
  a.arms.C.provisionalAnswer = 'a different provisional';
  const { results } = verifyArtifact(a);
  assert.equal(results.find((r) => r.name === 'C and B-prime share one gate sample').status, 'FAIL');
});

await check('NEGATIVE: the verifier catches a hand-edited normalized answer', async () => {
  const a = await syntheticArtifact();
  a.arms.C.normalized.text = a.arms.C.normalized.text.replace('DECISION', 'CONCLUSION');
  const { results } = verifyArtifact(a);
  assert.equal(results.find((r) => r.name === 'normalization determinism').status, 'FAIL');
});

await check('NEGATIVE: the verifier catches an evidence label that moved', async () => {
  const a = await syntheticArtifact();
  a.arms.D1.report = { ...a.arms.D1.report, evidenceLabel: 'PARTIALLY_GROUNDED' };
  const { results } = verifyArtifact(a);
  assert.equal(results.find((r) => r.name === 'NC-2 evidence invariance').status, 'FAIL');
});

await check('NEGATIVE: the verifier catches peer content that reached a D1 prompt', async () => {
  const a = await syntheticArtifact();
  a.arms.D1.selfReviewPrompt += `\n\n${F.PEER_CHUNK_TEXT}`;
  const { results } = verifyArtifact(a);
  assert.equal(results.find((r) => r.name === 'NC-3 D1 peer-leakage diagnostic').status, 'FAIL');
});

await check('NEGATIVE: the verifier catches an arm label leaking into judge-facing pairs', async () => {
  const a = await syntheticArtifact();
  a.blindPairs.pairs[0].arm = 'C';
  const { results } = verifyArtifact(a);
  assert.equal(results.find((r) => r.name === 'pair and assignment integrity').status, 'FAIL');
});

await check('NEGATIVE: the verifier catches a manifest whose hash no longer matches', async () => {
  const a = await syntheticArtifact();
  a.manifests.C.peerExcerptChars = 2000;
  const { results } = verifyArtifact(a);
  assert.equal(results.find((r) => r.name === 'manifest integrity').status, 'FAIL');
});

await check('NEGATIVE: the verifier catches a snapshot that no longer hashes to its record', async () => {
  const a = await syntheticArtifact();
  a.snapshotSha256 = 'f'.repeat(64);
  const { results } = verifyArtifact(a);
  assert.equal(results.find((r) => r.name === 'snapshot hash').status, 'FAIL');
});

await check('NEGATIVE: the verifier catches a lost neutrality guard in either arm', async () => {
  const a = await syntheticArtifact();
  a.arms.D1.decisionPrompt = a.arms.D1.decisionPrompt.replace(
    'Revision, recency, or agreement between specialists is not evidence.', 'Prefer the revised answer.'
  );
  const { results } = verifyArtifact(a);
  assert.equal(results.find((r) => r.name === 'C and D1 non-treatment parity').status, 'FAIL');
});

await check('NEGATIVE: the verifier catches a selectedIssue that production would not have selected', async () => {
  const a = await syntheticArtifact();
  a.selectedIssue = { ...a.selectedIssue, targetAgentId: 'strategist' };
  const { results } = verifyArtifact(a);
  assert.equal(results.find((r) => r.name === 'gate parsing re-derived from the recorded response').status, 'FAIL');
});

/* ================================================= H-03 no-trigger path */
console.log('\nH-03 no-trigger path');

/** A repetition where the gate emits no issue block at all. A legal observation. */
async function noTriggerArtifact() {
  const stub = F.makeStub({ gateText: F.PROVISIONAL });
  const run = await runAllArms({ ...base(), call: stub.call, now: fakeClock() });
  return { artifact: buildArtifact(run, stub, F.PROVISIONAL), run, stub };
}

await check('a no-trigger repetition costs two billable calls, not six', async () => {
  const { run } = await noTriggerArtifact();
  assert.deepEqual(run.accounting, { B: 1, sharedGate: 1, C: 0, D1: 0, totalBillable: 2, naiveWithoutSharedGate: 4 });
});

await check('a no-trigger repetition leaves C equal to B-prime and D1 skipped', async () => {
  const { run } = await noTriggerArtifact();
  assert.equal(run.arms.C.result.finalOutput, run.arms.B_prime.result.finalOutput);
  assert.equal(run.arms.D1.skipped, true);
  assert.equal(run.arms.D1.reason, 'no_selected_issue');
  assert.deepEqual(run.arms.D1.calls, []);
});

await check('a no-trigger repetition produces no D1 normalized answer and no D1 pair', async () => {
  const { artifact } = await noTriggerArtifact();
  assert.equal(artifact.arms.D1.skipped, true);
  assert.equal(artifact.arms.D1.normalized, undefined);
  const d1Pairs = (artifact.blindPairs?.assignments ?? []).filter((x) => x.answerX === 'D1' || x.answerY === 'D1');
  assert.deepEqual(d1Pairs, [], 'no placeholder D1 answer may be invented to keep the pair count');
});

await check('the verifier passes a valid triggered artifact', async () => {
  const { results, ok } = verifyArtifact(await syntheticArtifact());
  assert.deepEqual(results.filter((r) => r.status === 'FAIL').map((r) => `${r.name}: ${r.detail}`), []);
  assert.equal(ok, true);
  assert.match(results.find((r) => r.name === 'trigger state and arm call accounting').detail, /^TRIGGERED/);
});

await check('the verifier passes a valid no-trigger artifact', async () => {
  const { artifact } = await noTriggerArtifact();
  const { results, ok } = verifyArtifact(artifact);
  assert.deepEqual(results.filter((r) => r.status === 'FAIL').map((r) => `${r.name}: ${r.detail}`), []);
  assert.equal(ok, true);
  assert.match(results.find((r) => r.name === 'trigger state and arm call accounting').detail, /^NOT TRIGGERED/);
});

await check('NEGATIVE: an untriggered C that ran round2_worker is caught', async () => {
  const { artifact } = await noTriggerArtifact();
  artifact.arms.C.calls.push({ seq: 2, stage: 'round2_worker', provider: 'openai', requestedModel: 'stub-brand-1', resolvedModel: 'stub-brand-1', retrievalRequested: null, retrievalResult: null, replayed: false });
  const { results } = verifyArtifact(artifact);
  assert.equal(results.find((r) => r.name === 'trigger state and arm call accounting').status, 'FAIL');
});

await check('NEGATIVE: an untriggered C that ran decision_synthesis is caught', async () => {
  const { artifact } = await noTriggerArtifact();
  artifact.arms.C.calls.push({ seq: 2, stage: 'decision_synthesis', provider: 'openai', requestedModel: 'stub-synth-1', resolvedModel: 'stub-synth-1', retrievalRequested: null, retrievalResult: null, replayed: false });
  const { results } = verifyArtifact(artifact);
  assert.equal(results.find((r) => r.name === 'trigger state and arm call accounting').status, 'FAIL');
});

await check('NEGATIVE: an untriggered D1 that ran self_review is caught', async () => {
  const { artifact } = await noTriggerArtifact();
  artifact.arms.D1 = { skipped: false, calls: [{ seq: 1, stage: 'self_review', provider: 'openai', requestedModel: 'stub-brand-1', resolvedModel: 'stub-brand-1', retrievalRequested: null, retrievalResult: null, replayed: false }] };
  const { results } = verifyArtifact(artifact);
  assert.equal(results.find((r) => r.name === 'trigger state and arm call accounting').status, 'FAIL');
});

await check('NEGATIVE: an untriggered D1 that ran decision_synthesis is caught', async () => {
  const { artifact } = await noTriggerArtifact();
  artifact.arms.D1 = { skipped: false, calls: [{ seq: 1, stage: 'decision_synthesis', provider: 'openai', requestedModel: 'stub-synth-1', resolvedModel: 'stub-synth-1', retrievalRequested: null, retrievalResult: null, replayed: false }] };
  const { results } = verifyArtifact(artifact);
  assert.equal(results.find((r) => r.name === 'trigger state and arm call accounting').status, 'FAIL');
});

await check('NEGATIVE: an untriggered C whose finalOutput differs from B-prime is caught', async () => {
  const { artifact } = await noTriggerArtifact();
  artifact.arms.C.finalOutput = artifact.arms.C.finalOutput + ' tampered';
  const { results } = verifyArtifact(artifact);
  assert.equal(results.find((r) => r.name === 'C and B-prime share one gate sample').status, 'FAIL');
});

await check('NEGATIVE: an untriggered D1 carrying a normalized answer is caught', async () => {
  const { artifact } = await noTriggerArtifact();
  artifact.arms.D1.normalized = { text: 'invented', sha256: 'x'.repeat(64), removedBannerChars: 0 };
  const { results } = verifyArtifact(artifact);
  assert.equal(results.find((r) => r.name === 'NC-2 evidence invariance').status, 'FAIL');
});

await check('NEGATIVE: an untriggered artifact carrying a D1 evaluation pair is caught', async () => {
  const { artifact } = await noTriggerArtifact();
  artifact.blindPairs = artifact.blindPairs ?? { pairs: [], assignments: [] };
  artifact.blindPairs.pairs.push({ pairId: 'fake01', answerX: 'x', answerY: 'y' });
  artifact.blindPairs.assignments.push({ pairId: 'fake01', fixtureId: 'synthetic-1', runIndex: 1, comparison: 'C vs D1', answerX: 'C', answerY: 'D1' });
  const { results } = verifyArtifact(artifact);
  assert.equal(results.find((r) => r.name === 'pair and assignment integrity').status, 'FAIL');
});

await check('NEGATIVE: an artifact claiming no-trigger while the gate response selects an issue is caught', async () => {
  // The recorded gate response is the truth; the recorded shape claims otherwise.
  const { artifact } = await noTriggerArtifact();
  artifact.gateResponseText = F.GATE_TEXT;
  const { results } = verifyArtifact(artifact);
  assert.equal(results.find((r) => r.name === 'trigger state and arm call accounting').status, 'FAIL');
});

/* ============================================ H-04 manifest/runtime binding */
console.log('\nH-04 manifest and runtime binding');

await check('NEGATIVE: a manifest pinning a different model than the call used is caught', async () => {
  const a = await syntheticArtifact();
  a.manifests.C.pins = { ...a.manifests.C.pins, round2_worker: { provider: 'openai', requestedModel: 'some-other-model' } };
  a.manifests.C = sealManifest({ ...a.manifests.C, manifestSha256: undefined });
  const { results } = verifyArtifact(a);
  assert.equal(results.find((r) => r.name === 'call / manifest pin binding').status, 'FAIL');
});

await check('NEGATIVE: a manifest pinning a different provider than the call used is caught', async () => {
  const a = await syntheticArtifact();
  a.manifests.B.pins = { ...a.manifests.B.pins, synthesis: { provider: 'claude', requestedModel: 'stub-synth-1' } };
  a.manifests.B = sealManifest({ ...a.manifests.B, manifestSha256: undefined });
  const { results } = verifyArtifact(a);
  assert.equal(results.find((r) => r.name === 'call / manifest pin binding').status, 'FAIL');
});

await check('NEGATIVE: a missing manifestSha256 is caught', async () => {
  const a = await syntheticArtifact();
  delete a.manifests.C.manifestSha256;
  const { results } = verifyArtifact(a);
  assert.equal(results.find((r) => r.name === 'manifest integrity').status, 'FAIL');
});

for (const [field, value] of [['experimentId', 'other-experiment'], ['fixtureId', 'other-fixture'], ['runIndex', 99], ['snapshotSha256', 'f'.repeat(64)], ['evidenceLabelBaseline', 'PARTIALLY_GROUNDED']]) {
  await check(`NEGATIVE: a manifest whose ${field} disagrees with the artifact is caught`, async () => {
    const a = await syntheticArtifact();
    a.manifests.C = sealManifest({ ...a.manifests.C, [field]: value, manifestSha256: undefined });
    const { results } = verifyArtifact(a);
    assert.equal(results.find((r) => r.name === 'manifest / artifact identity binding').status, 'FAIL');
  });
}

await check('NEGATIVE: a manifest filed under the wrong arm key is caught', async () => {
  const a = await syntheticArtifact();
  a.manifests.C = sealManifest({ ...a.manifests.C, arm: 'D1', manifestSha256: undefined });
  const { results } = verifyArtifact(a);
  assert.equal(results.find((r) => r.name === 'manifest / artifact identity binding').status, 'FAIL');
});

for (const [what, mutate] of [
  ['B-prime and C gate models differ', (a) => { a.manifests.C.pins = { ...a.manifests.C.pins, synthesis_gate: { provider: 'openai', requestedModel: 'other-gate-model' } }; }],
  ['B-prime and C gate providers differ', (a) => { a.manifests.C.pins = { ...a.manifests.C.pins, synthesis_gate: { provider: 'claude', requestedModel: 'stub-synth-1' } }; }],
  ['C round2 and D1 self-review providers differ', (a) => { a.manifests.D1.pins = { ...a.manifests.D1.pins, self_review: { provider: 'claude', requestedModel: 'stub-brand-1' } }; }],
  ['C round2 and D1 self-review models differ', (a) => { a.manifests.D1.pins = { ...a.manifests.D1.pins, self_review: { provider: 'openai', requestedModel: 'other-target-model' } }; }],
  ['C and D1 decision synthesizers differ', (a) => { a.manifests.D1.pins = { ...a.manifests.D1.pins, decision_synthesis: { provider: 'openai', requestedModel: 'other-synth' } }; }],
]) {
  await check(`NEGATIVE: ${what} is caught`, async () => {
    const a = await syntheticArtifact();
    mutate(a);
    for (const arm of ['C', 'D1']) a.manifests[arm] = sealManifest({ ...a.manifests[arm], manifestSha256: undefined });
    const { results } = verifyArtifact(a);
    const failed = results.filter((r) => r.status === 'FAIL').map((r) => r.name);
    assert.ok(
      failed.includes('cross-arm pin and target matching') || failed.includes('call / manifest pin binding'),
      `expected a pin-binding failure, got: ${failed.join(', ') || 'none'}`
    );
  });
}

await check('NEGATIVE: a D1 that reviewed a different specialist than the gate selected is caught', async () => {
  const a = await syntheticArtifact();
  a.arms.D1.selfReview = { ...a.arms.D1.selfReview, agentId: 'strategist' };
  const { results } = verifyArtifact(a);
  assert.equal(results.find((r) => r.name === 'cross-arm pin and target matching').status, 'FAIL');
});

await check('the artifact records raw identity, never a self-reported match', async () => {
  const a = await syntheticArtifact();
  const serialized = JSON.stringify(a);
  for (const bad of ['targetMatched', 'modelPinMatched', 'pinMatched', 'triggered"']) {
    assert.ok(!serialized.includes(bad), `artifact carries a self-reported conclusion field: ${bad}`);
  }
  assert.equal(a.arms.D1.selfReview.agentId, 'brand');
  assert.equal(a.arms.D1.selfReview.provider, 'openai');
});

/* ============================================ H-05 execution provenance */
console.log('\nH-05 execution timestamp provenance');

await check('a real provider call records a UTC startedAt taken before the request', async () => {
  const stub = F.makeStub();
  const b = await runArmB({ ...base(), call: stub.call, now: fakeClock() });
  const call = b.calls[0];
  assert.equal(call.replayed, false);
  assert.ok(isUtcIso(call.startedAt), `startedAt "${call.startedAt}" is not UTC ISO-8601`);
  assert.equal(call.startedAt, RUN_STARTED_AT, 'the timestamp must come from the clock, before the call');
  assert.ok(Number.isFinite(call.ms) && call.ms >= 0);
});

await check('a replayed gate claims no provider execution timestamp', async () => {
  const stub = F.makeStub();
  const bp = await runArmBPrime({ ...base(), call: stub.call, now: fakeClock() });
  const c = await runArmC({ ...base(), call: stub.call, now: fakeClock('2026-01-01T01:00:00.000Z'), gateRecording: bp.gateRecording });
  const replayed = c.calls.find((x) => x.stage === 'synthesis_gate');
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.startedAt, null, 'a replay is not a provider execution and must not carry one\'s timestamp');
  assert.equal(replayed.ms, null, 'a replay spent no provider time');
  // The original execution's timestamp is kept, but as separate provenance.
  assert.equal(replayed.recordedProviderStartedAt, RUN_STARTED_AT);
  assert.ok(isUtcIso(replayed.recordedProviderStartedAt));
});

await check('the timestamp is client-observed only and is documented as such', () => {
  const source = readFileSync(new URL('./harness/dispatcher.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes('client-observed'), 'the dispatcher must state that timestamps are client-observed');
  assert.ok(source.includes('not attested by any provider'));
});

await check('a valid UTC instant is accepted and an offset instant is not', () => {
  assert.equal(isUtcIso('2026-01-01T00:00:00.000Z'), true);
  assert.equal(isUtcIso('2026-01-01T00:00:00Z'), true);
  assert.equal(isUtcIso('2026-01-01T00:00:00+08:00'), false, 'an offset is not UTC');
  assert.equal(isUtcIso('2026-01-01 00:00:00Z'), false);
  assert.equal(isUtcIso('2026-13-45T99:99:99Z'), false, 'a well-shaped but impossible instant is not valid');
  assert.equal(isUtcIso(1767225600000), false);
  assert.equal(isUtcIso(undefined), false);
});

await check('NEGATIVE: a manifest with no startedAt is rejected', () => {
  const m = goodManifest();
  delete m.startedAt;
  const err = mustThrowSync(() => validateManifest(m), ManifestInvalid);
  assert.ok(err.problems.some((x) => x.includes('startedAt')));
});

for (const [label, value] of [
  ['malformed', 'yesterday afternoon'],
  ['non-UTC offset', '2026-01-01T00:00:00+08:00'],
  ['impossible instant', '2026-13-45T99:99:99Z'],
  ['a number instead of a string', 1767225600000],
]) {
  await check(`NEGATIVE: a manifest whose startedAt is ${label} is rejected`, () => {
    const m = sealManifest({ ...goodManifest(), startedAt: value, manifestSha256: undefined });
    const err = mustThrowSync(() => validateManifest(m), ManifestInvalid);
    assert.ok(err.problems.some((x) => x.includes('startedAt')), err.problems.join('; '));
  });
}

await check('NEGATIVE: the verifier catches a manifest with no startedAt', async () => {
  const a = await syntheticArtifact();
  delete a.manifests.C.startedAt;
  const { results } = verifyArtifact(a);
  assert.equal(results.find((r) => r.name === 'execution timestamp provenance').status, 'FAIL');
});

await check('NEGATIVE: the verifier catches a malformed manifest startedAt', async () => {
  const a = await syntheticArtifact();
  a.manifests.C.startedAt = 'not-a-timestamp';
  const { results } = verifyArtifact(a);
  assert.equal(results.find((r) => r.name === 'execution timestamp provenance').status, 'FAIL');
});

await check('NEGATIVE: the verifier catches a real provider call with no startedAt', async () => {
  const a = await syntheticArtifact();
  delete a.arms.B.calls[0].startedAt;
  const { results } = verifyArtifact(a);
  assert.equal(results.find((r) => r.name === 'execution timestamp provenance').status, 'FAIL');
});

await check('NEGATIVE: the verifier catches a malformed call startedAt', async () => {
  const a = await syntheticArtifact();
  a.arms.C.calls.find((c) => c.stage === 'round2_worker').startedAt = '2026-01-01 00:00:00';
  const { results } = verifyArtifact(a);
  assert.equal(results.find((r) => r.name === 'execution timestamp provenance').status, 'FAIL');
});

await check('NEGATIVE: the verifier catches a replayed gate dressed up as a live call', async () => {
  // The exact fabrication H-05 exists to stop: a replay presented as a provider execution.
  const a = await syntheticArtifact();
  const replayed = a.arms.C.calls.find((c) => c.stage === 'synthesis_gate');
  replayed.startedAt = '2026-01-01T02:00:00.000Z';
  replayed.ms = 1234;
  const { results } = verifyArtifact(a);
  assert.equal(results.find((r) => r.name === 'execution timestamp provenance').status, 'FAIL');
});

await check('NEGATIVE: the verifier catches a call issued before its own run began', async () => {
  const a = await syntheticArtifact();
  a.arms.B.calls[0].startedAt = '2025-06-01T00:00:00.000Z';
  const { results } = verifyArtifact(a);
  assert.equal(results.find((r) => r.name === 'execution timestamp provenance').status, 'FAIL');
});

await check('NEGATIVE: the verifier catches a negative call duration', async () => {
  const a = await syntheticArtifact();
  a.arms.B.calls[0].ms = -5;
  const { results } = verifyArtifact(a);
  assert.equal(results.find((r) => r.name === 'execution timestamp provenance').status, 'FAIL');
});

function mustThrowSync(fn, type) {
  let thrown = null;
  try { fn(); } catch (e) { thrown = e; }
  assert.ok(thrown, 'expected a throw but nothing was thrown');
  assert.ok(thrown instanceof type, `expected ${type.name} but got ${thrown?.constructor?.name}: ${thrown?.message}`);
  return thrown;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
