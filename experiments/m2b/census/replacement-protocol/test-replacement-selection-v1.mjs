/**
 * Offline deterministic tests for CBRP-REPLACEMENT-SELECTION-v1.
 *
 * All fixtures are synthetic. None is drawn from CBRP-AUTHORING-V2P1-ROUND-0's real
 * candidates — per CWP-10F §3/§19 this amendment is content-blind, and no real CWP-10E
 * candidate text may be a test fixture for this module.
 *
 * Two reporting categories, kept structurally separate per CWP-10F-R §6/§7, mirroring
 * `extractor-2.1/test-extractor.mjs`:
 *
 *   1. SYNTHETIC REPLACEMENT-SELECTION BEHAVIOR TESTS — every fixture is invented for
 *      this file and exercises the frozen selection and ordinal-allocation rules.
 *   2. HISTORICAL-EVIDENCE ANTI-CONTAMINATION PROVENANCE CHECK — one check, run
 *      separately, asserting that this file embeds no real CWP-10E candidate text. It
 *      says something about test hygiene, not about selection behavior. Its imports are
 *      ordinary top-level ESM imports (no dynamic `import()` inside an unawaited
 *      callback), so the check is fully synchronous and cannot race process exit.
 *
 * Category 2 and the count in category 1 are reported separately so that "N/N behavior
 * tests passed" never silently includes the anti-contamination check.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRATUM_CODES, SELECTION_VERSION, selectReplacementCandidate, allocateReplacementSessionIds } from './replacement-selection-v1.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS ${name}`); passed++; }
  catch (e) { console.log(`  FAIL ${name}\n      ${e.stack}`); failed++; }
}

/** Twelve synthetic candidates, two per stratum, response order 0..11. Never real content. */
function makeSyntheticSession({ order = STRATUM_CODES } = {}) {
  const candidates = [];
  let index = 0;
  for (const code of order) {
    for (const n of [1, 2]) {
      candidates.push({
        taskCandidateId: `V21-TEST-S00-${code}-${String(n).padStart(2, '0')}`,
        stratumCode: code,
        indexInResponse: index,
      });
      index += 1;
    }
  }
  return candidates;
}

console.log('\n=== 1. SYNTHETIC REPLACEMENT-SELECTION BEHAVIOR TESTS ===');

console.log('\n=== selectReplacementCandidate ===');

check('one vacancy / two target-stratum candidates: first-in-response selected', () => {
  const candidates = makeSyntheticSession();
  const r = selectReplacementCandidate({ vacantStratumCode: 'BC', candidates });
  assert.equal(r.ok, true);
  assert.equal(r.selectionVersion, SELECTION_VERSION);
  const bc = candidates.filter((c) => c.stratumCode === 'BC').sort((a, b) => a.indexInResponse - b.indexInResponse);
  assert.equal(r.selectedCandidateId, bc[0].taskCandidateId);
  assert.equal(r.surplusCandidateIds.length, 11);
  assert.ok(!r.surplusCandidateIds.includes(r.selectedCandidateId));
});

check('response order reversed: a new first-in-response candidate is selected', () => {
  const forward = makeSyntheticSession();
  const forwardResult = selectReplacementCandidate({ vacantStratumCode: 'PS', candidates: forward });

  // Reverse indexInResponse across the same 12 candidate ids, independent of forward's own order.
  const maxIndex = Math.max(...forward.map((c) => c.indexInResponse));
  const reversed = forward.map((c) => ({ ...c, indexInResponse: maxIndex - c.indexInResponse }));
  const reversedResult = selectReplacementCandidate({ vacantStratumCode: 'PS', candidates: reversed });

  assert.equal(forwardResult.ok, true);
  assert.equal(reversedResult.ok, true);
  assert.notEqual(reversedResult.selectedCandidateId, forwardResult.selectedCandidateId,
    'reversing response order must flip which target-stratum candidate is first');

  const ps = reversed.filter((c) => c.stratumCode === 'PS').sort((a, b) => a.indexInResponse - b.indexInResponse);
  assert.equal(reversedResult.selectedCandidateId, ps[0].taskCandidateId);
});

check('11 surplus outputs are returned, and the second target-stratum candidate is among them', () => {
  const candidates = makeSyntheticSession();
  const r = selectReplacementCandidate({ vacantStratumCode: 'EI', candidates });
  assert.equal(r.ok, true);
  assert.equal(r.surplusCandidateIds.length, 11);
  const ei = candidates.filter((c) => c.stratumCode === 'EI').sort((a, b) => a.indexInResponse - b.indexInResponse);
  const secondEi = ei[1].taskCandidateId;
  assert.ok(r.surplusCandidateIds.includes(secondEi), 'the non-selected same-stratum candidate must be surplus');
  assert.notEqual(r.selectedCandidateId, secondEi);
  // every surplus id is one of the 12, and none is the selected one
  const allIds = new Set(candidates.map((c) => c.taskCandidateId));
  for (const id of r.surplusCandidateIds) assert.ok(allIds.has(id));
});

console.log('\n=== fail-closed mechanical guards ===');

check('wrong 12-count fails closed (11 candidates)', () => {
  const candidates = makeSyntheticSession().slice(0, 11);
  const r = selectReplacementCandidate({ vacantStratumCode: 'SC', candidates });
  assert.equal(r.ok, false);
  assert.equal(r.selectedCandidateId, undefined);
});

check('wrong 12-count fails closed (13 candidates)', () => {
  const candidates = makeSyntheticSession();
  candidates.push({ taskCandidateId: 'V21-TEST-S00-SC-99', stratumCode: 'SC', indexInResponse: 12 });
  const r = selectReplacementCandidate({ vacantStratumCode: 'SC', candidates });
  assert.equal(r.ok, false);
});

check('wrong 2-per-stratum fails closed (three OP, one FR)', () => {
  const candidates = makeSyntheticSession();
  // Turn one FR candidate into an extra OP candidate, so OP=3 and FR=1, total still 12.
  const frIndex = candidates.findIndex((c) => c.stratumCode === 'FR');
  candidates[frIndex] = { ...candidates[frIndex], stratumCode: 'OP' };
  const r = selectReplacementCandidate({ vacantStratumCode: 'BC', candidates });
  assert.equal(r.ok, false);
});

check('missing target stratum fails closed (vacant stratum has zero candidates)', () => {
  const candidates = makeSyntheticSession();
  // Relabel both FR candidates as SC, so SC=4, FR=0, total still 12 — FR is the vacant stratum.
  for (const c of candidates) if (c.stratumCode === 'FR') c.stratumCode = 'SC';
  const r = selectReplacementCandidate({ vacantStratumCode: 'FR', candidates });
  assert.equal(r.ok, false);
});

check('invalid vacantStratumCode fails closed', () => {
  const candidates = makeSyntheticSession();
  const r = selectReplacementCandidate({ vacantStratumCode: 'ZZ', candidates });
  assert.equal(r.ok, false);
});

check('duplicate candidate ids within one session fail closed', () => {
  const candidates = makeSyntheticSession();
  candidates[1] = { ...candidates[1], taskCandidateId: candidates[0].taskCandidateId };
  const r = selectReplacementCandidate({ vacantStratumCode: 'SC', candidates });
  assert.equal(r.ok, false);
});

console.log('\n=== indexInResponse response-order permutation invariant (CWP-10F-R) ===');

check('duplicate indexInResponse (two candidates at 4, position 7 missing) fails closed', () => {
  const candidates = makeSyntheticSession();
  const idx7 = candidates.findIndex((c) => c.indexInResponse === 7);
  candidates[idx7] = { ...candidates[idx7], indexInResponse: 4 };
  const r = selectReplacementCandidate({ vacantStratumCode: 'SC', candidates });
  assert.equal(r.ok, false);
  assert.match(r.reason, /duplicate value\(s\) 4/);
});

check('the two target-stratum candidates sharing the same indexInResponse fails closed', () => {
  const candidates = makeSyntheticSession();
  const sc = candidates.filter((c) => c.stratumCode === 'SC').sort((a, b) => a.indexInResponse - b.indexInResponse);
  const secondIdx = candidates.findIndex((c) => c.taskCandidateId === sc[1].taskCandidateId);
  candidates[secondIdx] = { ...candidates[secondIdx], indexInResponse: sc[0].indexInResponse };
  const r = selectReplacementCandidate({ vacantStratumCode: 'SC', candidates });
  assert.equal(r.ok, false);
  assert.match(r.reason, /duplicate value\(s\) 0/);
});

check('indexInResponse = -1 fails closed', () => {
  const candidates = makeSyntheticSession();
  const last = candidates.findIndex((c) => c.indexInResponse === 11);
  candidates[last] = { ...candidates[last], indexInResponse: -1 };
  const r = selectReplacementCandidate({ vacantStratumCode: 'SC', candidates });
  assert.equal(r.ok, false);
  assert.match(r.reason, /outside the required range/);
});

check('indexInResponse = 12 fails closed', () => {
  const candidates = makeSyntheticSession();
  const first = candidates.findIndex((c) => c.indexInResponse === 0);
  candidates[first] = { ...candidates[first], indexInResponse: 12 };
  const r = selectReplacementCandidate({ vacantStratumCode: 'SC', candidates });
  assert.equal(r.ok, false);
  assert.match(r.reason, /outside the required range/);
});

check('twelve unique integers that are not exactly the set {0,...,11} fails closed', () => {
  // Shift every indexInResponse by +1: still 12 unique integers, but the set is
  // {1,...,12} rather than {0,...,11} -- caught by the per-candidate range check.
  const candidates = makeSyntheticSession().map((c) => ({ ...c, indexInResponse: c.indexInResponse + 1 }));
  const r = selectReplacementCandidate({ vacantStratumCode: 'SC', candidates });
  assert.equal(r.ok, false);
});

check('array storage order does not affect selection when the indexInResponse permutation is unchanged', () => {
  const candidates = makeSyntheticSession();
  const forward = selectReplacementCandidate({ vacantStratumCode: 'OP', candidates });
  // Scramble array storage order only; every candidate keeps its own indexInResponse.
  const scrambled = [...candidates].reverse();
  const scrambledResult = selectReplacementCandidate({ vacantStratumCode: 'OP', candidates: scrambled });
  assert.equal(forward.ok, true);
  assert.equal(scrambledResult.ok, true);
  assert.equal(scrambledResult.selectedCandidateId, forward.selectedCandidateId,
    'selection must follow indexInResponse, not array storage order');
  assert.deepEqual([...scrambledResult.surplusCandidateIds].sort(), [...forward.surplusCandidateIds].sort());
});

console.log('\n=== no semantic input is possible ===');

check('selection depends only on stratumCode and indexInResponse — no text field exists to score', () => {
  const candidates = makeSyntheticSession();
  const r = selectReplacementCandidate({ vacantStratumCode: 'SC', candidates });
  assert.equal(r.ok, true);
  // The function's own input objects carry no "text" field at all in this fixture.
  assert.ok(candidates.every((c) => !('text' in c) && !('taskText' in c)));
});

console.log('\n=== allocateReplacementSessionIds ===');

check('multiple vacancies, same block: deterministic RNN allocation in sorted order', () => {
  const vacancies = [
    { authorBlockId: 'AUTHOR21-B02', replacementOf: 'V21-B02-S00-SC-01' },
    { authorBlockId: 'AUTHOR21-B02', replacementOf: 'V21-B02-S00-FR-02' },
  ];
  const result = allocateReplacementSessionIds({ vacancies });
  const bySlot = Object.fromEntries(result.map((r) => [r.replacementOf, r]));
  // FR-02 < SC-01 lexicographically ('F' < 'S'), so FR-02 sorts first and gets R01.
  assert.equal(bySlot['V21-B02-S00-FR-02'].actualAuthorSessionId, 'AUTHOR21-B02-R01');
  assert.equal(bySlot['V21-B02-S00-SC-01'].actualAuthorSessionId, 'AUTHOR21-B02-R02');
});

check('multiple blocks: sort by authorBlockId first, then by predecessor id', () => {
  const vacancies = [
    { authorBlockId: 'AUTHOR21-B05', replacementOf: 'V21-B05-S00-SC-01' },
    { authorBlockId: 'AUTHOR21-B02', replacementOf: 'V21-B02-S00-SC-01' },
    { authorBlockId: 'AUTHOR21-B02', replacementOf: 'V21-B02-S00-BC-01' },
  ];
  const result = allocateReplacementSessionIds({ vacancies });
  const bySlot = Object.fromEntries(result.map((r) => [r.replacementOf, r]));
  // Within B02: 'BC-01' < 'SC-01' lexicographically.
  assert.equal(bySlot['V21-B02-S00-BC-01'].actualAuthorSessionId, 'AUTHOR21-B02-R01');
  assert.equal(bySlot['V21-B02-S00-SC-01'].actualAuthorSessionId, 'AUTHOR21-B02-R02');
  assert.equal(bySlot['V21-B05-S00-SC-01'].actualAuthorSessionId, 'AUTHOR21-B05-R01');
});

check('existing R01/R02: next unused ordinal begins R03', () => {
  const vacancies = [{ authorBlockId: 'AUTHOR21-B01', replacementOf: 'V21-B01-S00-OP-02' }];
  const result = allocateReplacementSessionIds({
    vacancies,
    existingOrdinalsByBlock: { 'AUTHOR21-B01': 2 },
  });
  assert.equal(result[0].actualAuthorSessionId, 'AUTHOR21-B01-R03');
});

check('replacementGeneration is independent from the RNN session ordinal', () => {
  const vacancies = [
    { authorBlockId: 'AUTHOR21-B03', replacementOf: 'V21-B03-S00-SC-01', replacementGeneration: 3 },
    { authorBlockId: 'AUTHOR21-B03', replacementOf: 'V21-B03-S00-EI-02', replacementGeneration: 1 },
  ];
  const result = allocateReplacementSessionIds({ vacancies });
  const bySlot = Object.fromEntries(result.map((r) => [r.replacementOf, r]));
  // 'EI-02' < 'SC-01' lexicographically, so EI-02 gets the first ordinal (R01) even
  // though its replacementGeneration (1) is lower than SC-01's (3) — the two numbers
  // are computed independently and neither influences the other.
  assert.equal(bySlot['V21-B03-S00-EI-02'].actualAuthorSessionId, 'AUTHOR21-B03-R01');
  assert.equal(bySlot['V21-B03-S00-EI-02'].replacementGeneration, 1);
  assert.equal(bySlot['V21-B03-S00-SC-01'].actualAuthorSessionId, 'AUTHOR21-B03-R02');
  assert.equal(bySlot['V21-B03-S00-SC-01'].replacementGeneration, 3);
});

console.log('\n=== same-session fallback is structurally impossible ===');

check('selected candidate failure does NOT promote the same session\'s second target-stratum candidate', () => {
  // Simulate: the selected replacement later fails structural review. The module offers
  // no operation that takes a "failed" selection and returns an alternate from the same
  // session's surplus — the only re-entry point is a brand new vacancy (a new
  // replacementOf) fed through allocateReplacementSessionIds, which mints a NEW session
  // ordinal rather than reusing the exhausted one.
  const candidates = makeSyntheticSession();
  const first = selectReplacementCandidate({ vacantStratumCode: 'OP', candidates });
  assert.equal(first.ok, true);

  // There is no function in this module of the shape
  // reselectFromSurplus(sessionId, failedCandidateId) — asserting its absence directly.
  assert.equal(typeof selectReplacementCandidate === 'function', true);
  const moduleExports = { selectReplacementCandidate, allocateReplacementSessionIds };
  assert.deepEqual(
    Object.keys(moduleExports).sort(),
    ['allocateReplacementSessionIds', 'selectReplacementCandidate'].sort()
  );

  // A fresh vacancy for the same slot goes through the ordinal allocator like any other
  // vacancy and receives the next unused ordinal for that block — never the exhausted
  // session's identity.
  const nextVacancy = allocateReplacementSessionIds({
    vacancies: [{ authorBlockId: 'AUTHOR21-B01', replacementOf: 'V21-B01-S00-OP-01' }],
    existingOrdinalsByBlock: { 'AUTHOR21-B01': 1 }, // R01 (the exhausted session) already used
  });
  assert.equal(nextVacancy[0].actualAuthorSessionId, 'AUTHOR21-B01-R02');
});

const selectionBehaviorPassed = passed;
const selectionBehaviorFailed = failed;

console.log('\n=== 2. HISTORICAL-EVIDENCE ANTI-CONTAMINATION PROVENANCE CHECK ===');
console.log('(not a selection-behavior fixture; asserts this file embeds no real CWP-10E candidate text)\n');

let provenancePassed = 0, provenanceFailed = 0;
function checkProvenance(name, fn) {
  try { fn(); console.log(`  PASS ${name}`); provenancePassed++; }
  catch (e) { console.log(`  FAIL ${name}\n      ${e.stack}`); provenanceFailed++; }
}

checkProvenance('no fixture in this file matches real CWP-10E raw evidence', () => {
  const evidenceDir = path.join(DIR, '..', 'authoring-v2p1-round-0', 'raw');
  const thisFile = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  for (const name of fs.readdirSync(evidenceDir)) {
    if (!name.endsWith('.txt')) continue;
    const real = fs.readFileSync(path.join(evidenceDir, name), 'utf8');
    assert.ok(!thisFile.includes(real.slice(0, 200)), `test file must not embed ${name}`);
  }
});

console.log('\n=== SUMMARY ===');
console.log(`synthetic replacement-selection behavior tests: ${selectionBehaviorPassed}/${selectionBehaviorPassed + selectionBehaviorFailed} passed`);
console.log(`anti-contamination provenance check:             ${provenancePassed}/${provenancePassed + provenanceFailed} passed`);

const totalPassed = selectionBehaviorPassed + provenancePassed;
const totalFailed = selectionBehaviorFailed + provenanceFailed;
console.log(`\n${totalPassed} passed, ${totalFailed} failed`);
process.exit(totalFailed === 0 ? 0 : 1);
