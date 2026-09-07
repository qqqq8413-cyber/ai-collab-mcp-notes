/**
 * Offline deterministic tests for CBRP-STRUCTURAL-REVIEW-PROTOCOL-1.
 *
 * Three reporting categories, kept structurally separate per CWP-10G §23/§24,
 * mirroring `extractor-2.1/test-extractor.mjs` and
 * `replacement-protocol/test-replacement-selection-v1.mjs`:
 *
 *   1. SYNTHETIC BEHAVIOR TESTS -- every fixture is invented for this file.
 *      None uses any of the 60 real CBRP-AUTHORING-V2P1-ROUND-0 candidate texts
 *      or ids as a parser, prompt, schema, or decision fixture.
 *   2. HISTORICAL-EVIDENCE ANTI-CONTAMINATION PROVENANCE CHECK -- one check,
 *      asserting this file embeds no real CWP-10E candidate text.
 *   3. FROZEN RUBRIC PROVENANCE CHECK -- one check, asserting the committed
 *      rubric document's extracted paste-bytes still match the byte count and
 *      SHA-256 frozen into structural-review-prompt-v1.mjs. This reads a real
 *      committed *methodology* file (the rubric, not a candidate scenario), so
 *      it is not the category-2 restriction -- but it is not a synthetic
 *      behavior fixture either, so it is counted on its own.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  BLIND_ID_VERSION,
  PROMPT_VERSION,
  RUBRIC_VERSION,
  EXPECTED_RUBRIC_BYTE_COUNT,
  EXPECTED_RUBRIC_SHA256,
  STRATUM_DISPLAY_NAMES,
  extractRubricPasteBytes,
  loadFrozenRubricPasteBytes,
  computeBlindTaskId,
  buildStructuralReviewPrompt,
} from './structural-review-prompt-v1.mjs';

import {
  EXTRACTOR_VERSION,
  REPRESENTATIONS,
  extractStructuralReviewResponse,
} from './structural-review-extractor-v1.mjs';

import {
  REVIEW_OBJECT_KEYS,
  BOOLEAN_CHECK_KEYS,
  validateReviewObject,
  admissionDisagreement,
  describeCheckLevelDisagreement,
  decideStructuralReview,
  D3_VERSION,
  computeStructuralD3Selector,
} from './structural-review-decision-v1.mjs';

import {
  ORDER_VERSION,
  computeReviewOrderKey,
  computeStructuralReviewOrder,
} from './structural-review-order-v1.mjs';

import {
  PROTOCOL_VERSION,
  REVIEWER_PINS,
  CALL_BUDGET,
  computeInitialReviewPlan,
  computeR3Plan,
  dispatchLiveStructuralReview,
} from './structural-review-runner.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS ${name}`); passed++; }
  catch (e) { console.log(`  FAIL ${name}\n      ${e.stack}`); failed++; }
}
async function checkAsync(name, fn) {
  try { await fn(); console.log(`  PASS ${name}`); passed++; }
  catch (e) { console.log(`  FAIL ${name}\n      ${e.stack}`); failed++; }
}

/** A minimal synthetic rubric string -- never the real frozen bytes -- for tests
 * that only need *some* non-empty rubric text, not the real content. */
const SYNTHETIC_RUBRIC = 'SYNTHETIC RUBRIC TEXT FOR TESTS ONLY -- never the real frozen paste bytes.';

/** A schema-valid synthetic review object builder. */
function makeReview({ taskId, overallPass = true, failOn = [] } = {}) {
  const checks = {};
  for (const key of BOOLEAN_CHECK_KEYS) checks[key] = !failOn.includes(key);
  const computedOverallPass = BOOLEAN_CHECK_KEYS.every((k) => checks[k]);
  return {
    taskId,
    ...checks,
    overallPass: overallPass === 'auto' ? computedOverallPass : overallPass,
    reasons: 'Synthetic fixture reason text.',
  };
}

console.log('\n=== 1. SYNTHETIC BEHAVIOR TESTS ===');

console.log('\n--- BLIND ID (CBRP-STRUCTURAL-BLIND-ID-v1) ---');

check('deterministic: same trueCandidateId yields the same blindTaskId', () => {
  const a = computeBlindTaskId('V21-TEST-S00-SC-01');
  const b = computeBlindTaskId('V21-TEST-S00-SC-01');
  assert.equal(a, b);
  assert.match(a, /^SR-[0-9a-f]{64}$/);
});

check('different trueCandidateId yields a different blindTaskId', () => {
  const a = computeBlindTaskId('V21-TEST-S00-SC-01');
  const b = computeBlindTaskId('V21-TEST-S00-SC-02');
  assert.notEqual(a, b);
});

check('blindTaskId matches the frozen SHA256("CBRP-STRUCTURAL-BLIND-ID-v1\\n" + id) construction', () => {
  const expected = 'SR-' + crypto.createHash('sha256').update(`${BLIND_ID_VERSION}\nV21-TEST-S00-SC-01`, 'utf8').digest('hex');
  assert.equal(computeBlindTaskId('V21-TEST-S00-SC-01'), expected);
});

check('true candidate id is absent from the model-visible prompt', () => {
  const trueId = 'V21-B03-S00-EI-02-TEST-ONLY';
  const result = buildStructuralReviewPrompt({
    trueCandidateId: trueId,
    stratumCode: 'EI',
    taskText: 'Synthetic task text.',
    rubricPasteBytes: SYNTHETIC_RUBRIC,
  });
  assert.ok(!result.modelVisiblePrompt.includes(trueId), 'true candidate id must never appear in model-visible bytes');
});

console.log('\n--- PROMPT (CBRP-STRUCTURAL-REVIEW-PROMPT-1) ---');

check('R1/R2/R3 prompt bytes are identical for the same task (role is never an input)', () => {
  const args = { trueCandidateId: 'V21-TEST-S00-BC-01', stratumCode: 'BC', taskText: 'Same task, any role.', rubricPasteBytes: SYNTHETIC_RUBRIC };
  const p1 = buildStructuralReviewPrompt(args);
  const p2 = buildStructuralReviewPrompt(args);
  const p3 = buildStructuralReviewPrompt(args);
  assert.equal(p1.modelVisiblePrompt, p2.modelVisiblePrompt);
  assert.equal(p2.modelVisiblePrompt, p3.modelVisiblePrompt);
  assert.equal(p1.promptSha256, p2.promptSha256);
  assert.equal(p1.blindTaskId, p2.blindTaskId);
});

check('exact canonical assigned stratum for all six strata', () => {
  for (const [code, displayName] of Object.entries(STRATUM_DISPLAY_NAMES)) {
    const result = buildStructuralReviewPrompt({
      trueCandidateId: `V21-TEST-S00-${code}-01`,
      stratumCode: code,
      taskText: 'Synthetic.',
      rubricPasteBytes: SYNTHETIC_RUBRIC,
    });
    const inputLine = result.modelVisiblePrompt.split('REVIEW INPUT JSON:\n')[1];
    const parsedInput = JSON.parse(inputLine);
    assert.equal(parsedInput.assignedStratum, displayName);
  }
});

check('unknown stratumCode is refused, not silently mapped', () => {
  assert.throws(() => buildStructuralReviewPrompt({
    trueCandidateId: 'V21-TEST-S00-ZZ-01', stratumCode: 'ZZ', taskText: 'x', rubricPasteBytes: SYNTHETIC_RUBRIC,
  }));
});

check('JSON escaping in task text: quotes, backslashes, newlines, unicode', () => {
  const taskText = 'A "quoted" clause, a back\\slash, a\nline break, and Unicode: é中文😀.';
  const result = buildStructuralReviewPrompt({
    trueCandidateId: 'V21-TEST-S00-PS-01', stratumCode: 'PS', taskText, rubricPasteBytes: SYNTHETIC_RUBRIC,
  });
  const inputLine = result.modelVisiblePrompt.split('REVIEW INPUT JSON:\n')[1];
  const parsedInput = JSON.parse(inputLine);
  assert.equal(parsedInput.taskText, taskText, 'round-tripping through JSON.stringify/parse must preserve the exact text');
  assert.equal(inputLine.includes('\n' + 'line break'), false, 'the literal newline inside taskText must be escaped, not a raw line break in the prompt bytes');
});

check('deterministic promptSha256: same inputs, same hash, twice', () => {
  const args = { trueCandidateId: 'V21-TEST-S00-FR-01', stratumCode: 'FR', taskText: 'Hash determinism check.', rubricPasteBytes: SYNTHETIC_RUBRIC };
  const a = buildStructuralReviewPrompt(args);
  const b = buildStructuralReviewPrompt(args);
  assert.equal(a.promptSha256, b.promptSha256);
});

check('prompt layout: rubric, two LFs, literal header line, one LF, then the compact JSON', () => {
  const result = buildStructuralReviewPrompt({
    trueCandidateId: 'V21-TEST-S00-OP-01', stratumCode: 'OP', taskText: 'Layout check.', rubricPasteBytes: SYNTHETIC_RUBRIC,
  });
  const expectedPrefix = `${SYNTHETIC_RUBRIC}\n\nREVIEW INPUT JSON:\n`;
  assert.ok(result.modelVisiblePrompt.startsWith(expectedPrefix));
  const jsonPart = result.modelVisiblePrompt.slice(expectedPrefix.length);
  assert.equal(jsonPart, JSON.stringify(JSON.parse(jsonPart)), 'the JSON part must be compact (no pretty-printing) -- re-stringifying must be a no-op');
});

check('promptVersion / rubricVersion are reported and constant across calls', () => {
  const result = buildStructuralReviewPrompt({
    trueCandidateId: 'V21-TEST-S00-SC-03', stratumCode: 'SC', taskText: 'x', rubricPasteBytes: SYNTHETIC_RUBRIC,
  });
  assert.equal(result.promptVersion, PROMPT_VERSION);
  assert.equal(result.rubricVersion, RUBRIC_VERSION);
});

console.log('\n--- EXTRACTOR (CBRP-STRUCTURAL-REVIEW-EXTRACTOR-1) ---');

console.log('\nPASS vectors');

check('PLAIN_JSON_OBJECT', () => {
  const r = extractStructuralReviewResponse('{"a":1,"b":"two"}');
  assert.equal(r.ok, true);
  assert.equal(r.representationDetected, REPRESENTATIONS.PLAIN_JSON_OBJECT);
  assert.deepEqual(r.parsed, { a: 1, b: 'two' });
});

check('COMPLETE_OUTER_FENCE, bare fence', () => {
  const r = extractStructuralReviewResponse('```\n{"a":1}\n```');
  assert.equal(r.ok, true);
  assert.equal(r.representationDetected, REPRESENTATIONS.COMPLETE_OUTER_FENCE);
});

check('COMPLETE_OUTER_FENCE, json-tagged fence (case-insensitive)', () => {
  const r1 = extractStructuralReviewResponse('```json\n{"a":1}\n```');
  const r2 = extractStructuralReviewResponse('```JSON\n{"a":1}\n```');
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(r1.representationDetected, REPRESENTATIONS.COMPLETE_OUTER_FENCE);
});

check('ORPHAN_TRAILING_FENCE, LF line boundary', () => {
  const r = extractStructuralReviewResponse('{"a":1}\n```');
  assert.equal(r.ok, true);
  assert.equal(r.representationDetected, REPRESENTATIONS.ORPHAN_TRAILING_FENCE);
});

check('ORPHAN_TRAILING_FENCE, CRLF line boundary', () => {
  const r = extractStructuralReviewResponse('{"a":1}\r\n```');
  assert.equal(r.ok, true);
  assert.equal(r.representationDetected, REPRESENTATIONS.ORPHAN_TRAILING_FENCE);
});

check('ORPHAN_TRAILING_FENCE with an intervening blank line', () => {
  const r = extractStructuralReviewResponse('{"a":1}\n\n```');
  assert.equal(r.ok, true);
  assert.equal(r.representationDetected, REPRESENTATIONS.ORPHAN_TRAILING_FENCE);
});

console.log('\nFAIL vectors -- every one MALFORMED, none repaired');

check('prose prefix', () => {
  const r = extractStructuralReviewResponse('Here is my review:\n{"a":1}');
  assert.equal(r.ok, false);
});

check('prose suffix, no fence', () => {
  const r = extractStructuralReviewResponse('{"a":1}\nThanks for reading!');
  assert.equal(r.ok, false);
});

check('second JSON object', () => {
  const r = extractStructuralReviewResponse('{"a":1}\n{"b":2}');
  assert.equal(r.ok, false);
});

check('array instead of object (top level)', () => {
  const r = extractStructuralReviewResponse('[{"a":1}]');
  assert.equal(r.ok, false);
});

check('array instead of object, fenced', () => {
  const r = extractStructuralReviewResponse('```\n[{"a":1}]\n```');
  assert.equal(r.ok, false);
});

check('malformed / truncated JSON', () => {
  const r = extractStructuralReviewResponse('{ "a": 1,');
  assert.equal(r.ok, false);
});

check('incomplete fence (opening fence, no closing fence)', () => {
  const r = extractStructuralReviewResponse('```\n{"a":1}');
  assert.equal(r.ok, false);
});

check('same-line orphan fence (no line break before the fence)', () => {
  const r = extractStructuralReviewResponse('{"a":1}```');
  assert.equal(r.ok, false);
});

check('leading whitespace on the orphan fence line', () => {
  const r = extractStructuralReviewResponse('{"a":1}\n   ```');
  assert.equal(r.ok, false);
});

check('trailing whitespace on the orphan fence line', () => {
  const r = extractStructuralReviewResponse('{"a":1}\n```   ');
  assert.equal(r.ok, false);
});

check('arbitrary language tag on the opening fence', () => {
  const r = extractStructuralReviewResponse('```python\n{"a":1}\n```');
  assert.equal(r.ok, false);
});

check('extractorVersion and hashes are always reported, even on MALFORMED', () => {
  const r = extractStructuralReviewResponse('not json at all');
  assert.equal(r.extractorVersion, EXTRACTOR_VERSION);
  assert.equal(r.ok, false);
  assert.equal(typeof r.originalRawSha256, 'string');
  assert.equal(r.normalizedJsonSha256, null);
});

console.log('\n--- SCHEMA (review object validation) ---');

check('a fully valid review object passes', () => {
  const review = makeReview({ taskId: 'SR-test', overallPass: 'auto' });
  const r = validateReviewObject(review, { expectedBlindTaskId: 'SR-test' });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.review).sort(), [...REVIEW_OBJECT_KEYS].sort());
});

check('FAIL: missing key', () => {
  const review = makeReview({ taskId: 'SR-test', overallPass: 'auto' });
  delete review.reasons;
  const r = validateReviewObject(review, { expectedBlindTaskId: 'SR-test' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /missing/);
});

check('FAIL: extra key', () => {
  const review = { ...makeReview({ taskId: 'SR-test', overallPass: 'auto' }), extraField: 'not allowed' };
  const r = validateReviewObject(review, { expectedBlindTaskId: 'SR-test' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /extra/);
});

check('FAIL: string boolean ("true") is rejected', () => {
  const review = { ...makeReview({ taskId: 'SR-test', overallPass: 'auto' }), overallPass: 'true' };
  const r = validateReviewObject(review, { expectedBlindTaskId: 'SR-test' });
  assert.equal(r.ok, false);
});

check('FAIL: null boolean is rejected', () => {
  const review = { ...makeReview({ taskId: 'SR-test', overallPass: 'auto' }), stratumCorrect: null };
  const r = validateReviewObject(review, { expectedBlindTaskId: 'SR-test' });
  assert.equal(r.ok, false);
});

check('FAIL: wrong blind task id', () => {
  const review = makeReview({ taskId: 'SR-wrong', overallPass: 'auto' });
  const r = validateReviewObject(review, { expectedBlindTaskId: 'SR-expected' });
  assert.equal(r.ok, false);
});

check('FAIL: empty reasons', () => {
  const review = { ...makeReview({ taskId: 'SR-test', overallPass: 'auto' }), reasons: '' };
  const r = validateReviewObject(review, { expectedBlindTaskId: 'SR-test' });
  assert.equal(r.ok, false);
});

check('FAIL: non-string reasons', () => {
  const review = { ...makeReview({ taskId: 'SR-test', overallPass: 'auto' }), reasons: 12345 };
  const r = validateReviewObject(review, { expectedBlindTaskId: 'SR-test' });
  assert.equal(r.ok, false);
});

check('FAIL: overallPass=true but a check is false', () => {
  const review = { ...makeReview({ taskId: 'SR-test', failOn: ['realistic'] }), overallPass: true };
  const r = validateReviewObject(review, { expectedBlindTaskId: 'SR-test' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /overallPass/);
});

check('FAIL: overallPass=false but all six checks are true', () => {
  const review = { ...makeReview({ taskId: 'SR-test' }), overallPass: false };
  const r = validateReviewObject(review, { expectedBlindTaskId: 'SR-test' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /overallPass/);
});

console.log('\n--- DECISION (disagreement / R3 trigger / majority) ---');

check('PASS + PASS -> FINAL PASS, no R3', () => {
  const r1Review = makeReview({ taskId: 'SR-x' });
  const r2Review = makeReview({ taskId: 'SR-x' });
  const d = decideStructuralReview({ r1Review, r2Review });
  assert.equal(d.ok, true);
  assert.equal(d.finalPass, true);
  assert.equal(d.r3Required, false);
  assert.equal(d.disagreement, false);
});

check('FAIL + FAIL -> FINAL FAIL, no R3', () => {
  const r1Review = makeReview({ taskId: 'SR-x', overallPass: 'auto', failOn: ['realistic'] });
  const r2Review = makeReview({ taskId: 'SR-x', overallPass: 'auto', failOn: ['selfContained'] });
  const d = decideStructuralReview({ r1Review, r2Review });
  assert.equal(d.ok, true);
  assert.equal(d.finalPass, false);
  assert.equal(d.r3Required, false);
  assert.equal(d.disagreement, false);
  assert.ok(d.checkLevelDisagreement.length > 0, 'field-level disagreement is reported descriptively');
});

check('PASS + FAIL -> R3 required (not decided without R3)', () => {
  const r1Review = makeReview({ taskId: 'SR-x' });
  const r2Review = makeReview({ taskId: 'SR-x', overallPass: 'auto', failOn: ['realistic'] });
  const d = decideStructuralReview({ r1Review, r2Review });
  assert.equal(d.ok, false);
  assert.equal(d.r3Required, true);
  assert.equal(d.disagreement, true);
});

check('FAIL + PASS -> R3 required (not decided without R3)', () => {
  const r1Review = makeReview({ taskId: 'SR-x', overallPass: 'auto', failOn: ['realistic'] });
  const r2Review = makeReview({ taskId: 'SR-x' });
  const d = decideStructuralReview({ r1Review, r2Review });
  assert.equal(d.ok, false);
  assert.equal(d.r3Required, true);
  assert.equal(d.disagreement, true);
});

check('majority: PASS, FAIL, PASS -> FINAL PASS', () => {
  const r1Review = makeReview({ taskId: 'SR-x', overallPass: true });
  const r2Review = makeReview({ taskId: 'SR-x', overallPass: 'auto', failOn: ['realistic'] });
  const r3Review = makeReview({ taskId: 'SR-x', overallPass: true });
  const d = decideStructuralReview({ r1Review, r2Review, r3Review });
  assert.equal(d.ok, true);
  assert.equal(d.finalPass, true);
});

check('majority: PASS, FAIL, FAIL -> FINAL FAIL', () => {
  const r1Review = makeReview({ taskId: 'SR-x', overallPass: true });
  const r2Review = makeReview({ taskId: 'SR-x', overallPass: 'auto', failOn: ['realistic'] });
  const r3Review = makeReview({ taskId: 'SR-x', overallPass: 'auto', failOn: ['selfContained'] });
  const d = decideStructuralReview({ r1Review, r2Review, r3Review });
  assert.equal(d.ok, true);
  assert.equal(d.finalPass, false);
});

check('majority: FAIL, PASS, PASS -> FINAL PASS', () => {
  const r1Review = makeReview({ taskId: 'SR-x', overallPass: 'auto', failOn: ['realistic'] });
  const r2Review = makeReview({ taskId: 'SR-x', overallPass: true });
  const r3Review = makeReview({ taskId: 'SR-x', overallPass: true });
  const d = decideStructuralReview({ r1Review, r2Review, r3Review });
  assert.equal(d.ok, true);
  assert.equal(d.finalPass, true);
});

check('majority: FAIL, PASS, FAIL -> FINAL FAIL', () => {
  const r1Review = makeReview({ taskId: 'SR-x', overallPass: 'auto', failOn: ['realistic'] });
  const r2Review = makeReview({ taskId: 'SR-x', overallPass: true });
  const r3Review = makeReview({ taskId: 'SR-x', overallPass: 'auto', failOn: ['selfContained'] });
  const d = decideStructuralReview({ r1Review, r2Review, r3Review });
  assert.equal(d.ok, true);
  assert.equal(d.finalPass, false);
});

check('R3 supplied when R1/R2 already agreed is refused (R3 must never run without a real disagreement)', () => {
  const r1Review = makeReview({ taskId: 'SR-x' });
  const r2Review = makeReview({ taskId: 'SR-x' });
  const r3Review = makeReview({ taskId: 'SR-x' });
  const d = decideStructuralReview({ r1Review, r2Review, r3Review });
  assert.equal(d.ok, false);
});

check('child-check disagreement while overallPass agrees (both FAIL, different failing check) -> NO R3', () => {
  const r1Review = makeReview({ taskId: 'SR-x', overallPass: 'auto', failOn: ['stratumCorrect'] });
  const r2Review = makeReview({ taskId: 'SR-x', overallPass: 'auto', failOn: ['noSpecialistSteering'] });
  assert.equal(admissionDisagreement(r1Review, r2Review), false, 'overallPass must agree (both FAIL) for this fixture to be meaningful');
  const disagreementFields = describeCheckLevelDisagreement(r1Review, r2Review);
  assert.ok(disagreementFields.includes('stratumCorrect') && disagreementFields.includes('noSpecialistSteering'));
  const d = decideStructuralReview({ r1Review, r2Review });
  assert.equal(d.ok, true);
  assert.equal(d.r3Required, false, 'field-level disagreement alone must never trigger R3');
});

console.log('\n--- D3 (CBRP-D3-v1, structural route) ---');

check('pinned structural selector vectors match CBRP_MODEL_PINS_PREREG_DRAFT.md §7.1 exactly', () => {
  const vectors = [
    ['CBRP-SC-01', '080ff96618e0f5e8901fb46f98bc5b9d82893b793bc3cfb90e991c1a4ab9968b', 'claude'],
    ['CBRP-SC-02', 'fe54b57577e015534f294b46220a6cc994c932a7184689aa18c552ad6f6806ae', 'gemini'],
    ['CBRP-SC-03', '07fe21dabe40e94e29401c9b27a950bc1a57362e045d725467ed27a980c7ec8e', 'claude'],
    ['CBRP-SC-04', '476d8b37580f96a70e5ef6ade65a146f27bbcaa9bcb307ae372b2ead9230c2be', 'claude'],
    ['CBRP-SC-05', '008f55df38284d3fa337fce199531f190fc6a270c75626c8327a8bed97ed4a2c', 'claude'],
    ['CBRP-SC-06', '1b44fe1e942d45eb2c52dc43df0157b599931d7184f59d64cc0030a820d51c84', 'claude'],
  ];
  for (const [id, expectedSelector, expectedProvider] of vectors) {
    const r = computeStructuralD3Selector(id);
    assert.equal(r.selector, expectedSelector, `selector mismatch for ${id}`);
    assert.equal(r.provider, expectedProvider, `provider mismatch for ${id}`);
  }
});

check('D3_VERSION is reported as CBRP-D3-v1 -- reused, not redefined', () => {
  assert.equal(D3_VERSION, 'CBRP-D3-v1');
});

check('selectorInput has no trailing newline and no extra separators', () => {
  const r = computeStructuralD3Selector('CBRP-SC-01');
  assert.equal(r.selectorInput, 'CBRP-D3-v1\nSTRUCTURAL\nCBRP-SC-01');
  assert.ok(!r.selectorInput.endsWith('\n'));
});

check('first hex char 0-7 routes to claude/claude-opus-5', () => {
  const r = computeStructuralD3Selector('CBRP-SC-01'); // selector[0] === '0'
  assert.equal(r.provider, 'claude');
  assert.equal(r.model, 'claude-opus-5');
  assert.equal(r.modelFamily, 'CLAUDE_FAMILY');
});

check('first hex char 8-f routes to gemini/gemini-3.8-flash', () => {
  const r = computeStructuralD3Selector('CBRP-SC-02'); // selector[0] === 'f'
  assert.equal(r.provider, 'gemini');
  assert.equal(r.model, 'gemini-3.8-flash');
  assert.equal(r.modelFamily, 'GEMINI_FAMILY');
});

check('true candidate id used for D3 routing never appears in the model-visible prompt', () => {
  const trueId = 'V21-TEST-S00-SC-01-D3-CHECK';
  const d3 = computeStructuralD3Selector(trueId);
  const prompt = buildStructuralReviewPrompt({
    trueCandidateId: trueId, stratumCode: 'SC', taskText: 'x', rubricPasteBytes: SYNTHETIC_RUBRIC,
  });
  assert.ok(!prompt.modelVisiblePrompt.includes(trueId));
  assert.ok(!prompt.modelVisiblePrompt.includes(d3.selectorInput));
  assert.ok(!prompt.modelVisiblePrompt.includes(d3.selector));
});

console.log('\n--- ORDER (CBRP-STRUCTURAL-REVIEW-ORDER-v1) ---');

check('ORDER_VERSION is reported as CBRP-STRUCTURAL-REVIEW-ORDER-v1', () => {
  assert.equal(ORDER_VERSION, 'CBRP-STRUCTURAL-REVIEW-ORDER-v1');
});

check('deterministic reviewOrderKey: same input, same key, twice', () => {
  const input = { taskCandidateId: 'V21-TEST-S00-SC-01', taskSha256: 'a'.repeat(64) };
  assert.equal(computeReviewOrderKey(input), computeReviewOrderKey(input));
});

check('reviewOrderKey construction matches SHA256(ORDER_VERSION + "\\n" + id + "\\n" + hash)', () => {
  const taskCandidateId = 'V21-TEST-S00-SC-01';
  const taskSha256 = 'a'.repeat(64);
  const expected = crypto.createHash('sha256').update(`${ORDER_VERSION}\n${taskCandidateId}\n${taskSha256}`, 'utf8').digest('hex');
  assert.equal(computeReviewOrderKey({ taskCandidateId, taskSha256 }), expected);
});

check('storage order does not change the frozen sorted result', () => {
  const candidates = Array.from({ length: 8 }, (_, i) => ({
    taskCandidateId: `V21-TEST-S00-XX-${String(i).padStart(2, '0')}`,
    taskSha256: crypto.createHash('sha256').update(`synthetic-fixture-${i}`, 'utf8').digest('hex'),
  }));
  const forward = computeStructuralReviewOrder(candidates).map((c) => c.taskCandidateId);
  const shuffled = [...candidates].reverse();
  const fromShuffled = computeStructuralReviewOrder(shuffled).map((c) => c.taskCandidateId);
  assert.deepEqual(fromShuffled, forward);
});

check('order is a strict function of taskCandidateId + taskSha256, not array position', () => {
  const a = { taskCandidateId: 'V21-TEST-S00-AA-01', taskSha256: 'b'.repeat(64) };
  const b = { taskCandidateId: 'V21-TEST-S00-BB-01', taskSha256: 'c'.repeat(64) };
  const orderAB = computeStructuralReviewOrder([a, b]).map((c) => c.taskCandidateId);
  const orderBA = computeStructuralReviewOrder([b, a]).map((c) => c.taskCandidateId);
  assert.deepEqual(orderAB, orderBA);
});

console.log('\n--- RUNNER (plan composition; the guarded LIVE stub) ---');

function makeSyntheticPool(n = 6) {
  const codes = ['SC', 'OP', 'BC', 'EI', 'PS', 'FR'];
  return Array.from({ length: n }, (_, i) => {
    const code = codes[i % codes.length];
    return {
      taskCandidateId: `V21-TEST-S00-${code}-${String(i).padStart(2, '0')}`,
      taskSha256: crypto.createHash('sha256').update(`synthetic-runner-fixture-${i}`, 'utf8').digest('hex'),
      stratumCode: code,
      taskText: `Synthetic runner-plan fixture #${i}.`,
    };
  });
}

check('computeInitialReviewPlan: one entry per pool task, R1/R2 pinned correctly and prompt-identical', () => {
  const pool = makeSyntheticPool(6);
  const plan = computeInitialReviewPlan({ pool, rubricPasteBytes: SYNTHETIC_RUBRIC });
  assert.equal(plan.length, pool.length);
  for (const entry of plan) {
    assert.equal(entry.r1.provider, REVIEWER_PINS.R1.provider);
    assert.equal(entry.r1.model, REVIEWER_PINS.R1.model);
    assert.equal(entry.r2.provider, REVIEWER_PINS.R2.provider);
    assert.equal(entry.r2.model, REVIEWER_PINS.R2.model);
    assert.equal(entry.r1.prompt.modelVisiblePrompt, entry.r2.prompt.modelVisiblePrompt);
    assert.equal(entry.blindTaskId, entry.r1.prompt.blindTaskId);
    assert.equal(entry.r1.reviewId, `${entry.taskCandidateId}-R1`);
    assert.equal(entry.r2.reviewId, `${entry.taskCandidateId}-R2`);
  }
});

check('computeInitialReviewPlan order matches computeStructuralReviewOrder independently', () => {
  const pool = makeSyntheticPool(6);
  const plan = computeInitialReviewPlan({ pool, rubricPasteBytes: SYNTHETIC_RUBRIC });
  const independentOrder = computeStructuralReviewOrder(pool.map(({ taskCandidateId, taskSha256 }) => ({ taskCandidateId, taskSha256 })));
  assert.deepEqual(plan.map((p) => p.taskCandidateId), independentOrder.map((o) => o.taskCandidateId));
});

check('computeR3Plan includes only disagreeing tasks, in frozen order, with correct D3 routing', () => {
  const pool = makeSyntheticPool(6);
  const plan = computeInitialReviewPlan({ pool, rubricPasteBytes: SYNTHETIC_RUBRIC });
  const results = new Map();
  plan.forEach((entry, i) => {
    const disagree = i % 2 === 0; // alternate: agree, disagree, agree, disagree, ...
    const r1Review = makeReview({ taskId: entry.blindTaskId, overallPass: true });
    const r2Review = disagree
      ? makeReview({ taskId: entry.blindTaskId, overallPass: 'auto', failOn: ['realistic'] })
      : makeReview({ taskId: entry.blindTaskId, overallPass: true });
    results.set(entry.taskCandidateId, { r1Review, r2Review });
  });
  const r3Plan = computeR3Plan({ initialPlan: plan, reviewResultsByTaskId: results });
  const expectedIds = plan.filter((_, i) => i % 2 === 0).map((e) => e.taskCandidateId);
  assert.deepEqual(r3Plan.map((e) => e.taskCandidateId), expectedIds);
  for (const entry of r3Plan) {
    const expectedD3 = computeStructuralD3Selector(entry.taskCandidateId);
    assert.equal(entry.r3.d3Selector, expectedD3.selector);
    assert.equal(entry.r3.provider, expectedD3.provider);
    const originalEntry = plan.find((p) => p.taskCandidateId === entry.taskCandidateId);
    assert.equal(entry.r3.prompt.modelVisiblePrompt, originalEntry.r1.prompt.modelVisiblePrompt, 'R3 prompt bytes must equal R1/R2 prompt bytes for the same task');
  }
});

check('computeR3Plan refuses to run past a task with no recorded R1/R2 results', () => {
  const pool = makeSyntheticPool(2);
  const plan = computeInitialReviewPlan({ pool, rubricPasteBytes: SYNTHETIC_RUBRIC });
  assert.throws(() => computeR3Plan({ initialPlan: plan, reviewResultsByTaskId: new Map() }));
});

check('call budget matches the frozen protocol numbers', () => {
  assert.equal(CALL_BUDGET.mandatoryR1, 60);
  assert.equal(CALL_BUDGET.mandatoryR2, 60);
  assert.equal(CALL_BUDGET.mandatoryTotal, 120);
  assert.equal(CALL_BUDGET.maxR3, 60);
  assert.equal(CALL_BUDGET.maxTotal, 180);
  assert.equal(CALL_BUDGET.maxAttemptsPerSession, 1);
});

check('PROTOCOL_VERSION is reported', () => {
  assert.equal(PROTOCOL_VERSION, 'CBRP-STRUCTURAL-REVIEW-PROTOCOL-1');
});

await checkAsync('dispatchLiveStructuralReview is a guarded stub: it always rejects, never dispatches', async () => {
  await assert.rejects(() => dispatchLiveStructuralReview(), /LIVE dispatch is not authorized/);
});

const selectionBehaviorPassed = passed;
const selectionBehaviorFailed = failed;

console.log('\n=== 2. HISTORICAL-EVIDENCE ANTI-CONTAMINATION PROVENANCE CHECK ===');
console.log('(not a behavior fixture; asserts this file embeds no real CWP-10E candidate text)\n');

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

console.log('\n=== 3. FROZEN RUBRIC PROVENANCE CHECK ===');
console.log('(reads the real committed methodology rubric, not a candidate scenario)\n');

let rubricProvenancePassed = 0, rubricProvenanceFailed = 0;
function checkRubricProvenance(name, fn) {
  try { fn(); console.log(`  PASS ${name}`); rubricProvenancePassed++; }
  catch (e) { console.log(`  FAIL ${name}\n      ${e.stack}`); rubricProvenanceFailed++; }
}

checkRubricProvenance('the committed rubric doc extracts to exactly the frozen byte count and SHA-256', () => {
  const rawMarkdown = fs.readFileSync(path.join(DIR, '..', 'CBRP_STRUCTURAL_REVIEW_RUBRIC_DRAFT.md'), 'utf8');
  const extracted = extractRubricPasteBytes(rawMarkdown);
  assert.equal(Buffer.byteLength(extracted, 'utf8'), EXPECTED_RUBRIC_BYTE_COUNT);
  assert.equal(crypto.createHash('sha256').update(extracted, 'utf8').digest('hex'), EXPECTED_RUBRIC_SHA256);
});

checkRubricProvenance('loadFrozenRubricPasteBytes() succeeds against the committed file (no STOP)', () => {
  const bytes = loadFrozenRubricPasteBytes();
  assert.equal(typeof bytes, 'string');
  assert.ok(bytes.length > 0);
});

checkRubricProvenance('extractRubricPasteBytes\'s marker convention reproduces BRIEF_SENT.txt byte-for-byte on the authoring brief doc', () => {
  // Cross-check against a SECOND real committed paste-section, one whose extracted
  // bytes were already consumed by a real live run (CWP-10E) and are independently
  // known-correct -- this is what caught the original off-by-one-newline bug in this
  // function (a symmetric \n+ strip on both ends undercounted the brief by one byte).
  const briefMarkdown = fs.readFileSync(path.join(DIR, '..', 'CBRP_AUTHORING_BRIEF_V2_PREREG_DRAFT.md'), 'utf8');
  const extractedBrief = extractRubricPasteBytes(briefMarkdown); // same marker convention, different document
  const briefSent = fs.readFileSync(path.join(DIR, '..', 'authoring-v2p1-round-0', 'BRIEF_SENT.txt'), 'utf8');
  assert.equal(extractedBrief, briefSent, 'extraction must reproduce the already-live-verified brief bytes exactly, including the single trailing newline');
});

console.log('\n=== SUMMARY ===');
console.log(`synthetic behavior tests:                 ${selectionBehaviorPassed}/${selectionBehaviorPassed + selectionBehaviorFailed} passed`);
console.log(`anti-contamination provenance check:      ${provenancePassed}/${provenancePassed + provenanceFailed} passed`);
console.log(`frozen rubric provenance check:            ${rubricProvenancePassed}/${rubricProvenancePassed + rubricProvenanceFailed} passed`);

const totalPassed = selectionBehaviorPassed + provenancePassed + rubricProvenancePassed;
const totalFailed = selectionBehaviorFailed + provenanceFailed + rubricProvenanceFailed;
console.log(`\n${totalPassed} passed, ${totalFailed} failed`);
console.log(`\n0 provider calls. 0 structural reviews. 0 replacement sessions. 0 duplicate audits. 0 Chief calls.`);
process.exit(totalFailed === 0 ? 0 : 1);
