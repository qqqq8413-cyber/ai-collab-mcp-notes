/**
 * Offline deterministic tests for CBRP-AUTHOR-EXTRACTOR-2.1.
 *
 * Three reporting categories, kept structurally separate per CWP-10C-R §6:
 *
 *   1. SYNTHETIC PARSER-BEHAVIOR TESTS — every fixture is invented for this file and
 *      exercises the frozen Case A/B/C grammar. These are the tests that define
 *      correct parser behavior.
 *   2. HISTORICAL-EVIDENCE ANTI-CONTAMINATION PROVENANCE CHECK — one check, run
 *      separately, asserting that this file does not embed AUTHOR2-B02-S00's raw
 *      bytes as a fixture. It says something about test hygiene, not about the parser.
 *   3. HISTORICAL B02 DESCRIPTIVE VERIFICATION — a single, clearly separate, informal
 *      run of the frozen extractor against the real preserved B02 bytes, reported for
 *      transparency only. It is not a PASS/FAIL test, defines no parser behavior, is
 *      not a fixture, and does not admit B02 or change CWP-10B's disposition in any
 *      way — see CBRP_AUTHORING_PROTOCOL_2.md §9.4.
 *
 * Category 2 and the count in category 1 are reported separately so that "N/N
 * synthetic fixtures passed" never silently includes a historical-evidence check.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTRACTOR_VERSION, REPRESENTATIONS, extractCbrpAuthorResponse } from './cbrp-author-extractor.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  PASS ${name}`); passed++; }
  catch (e) { console.log(`  FAIL ${name}\n      ${e.stack}`); failed++; }
}

/** A minimal, structurally valid synthetic array. Never treated as candidate content. */
const SYNTHETIC_ARRAY = '[\n  { "stratum": "Strategy / Commitment", "text": "synthetic fixture only" }\n]';
const SYNTHETIC_PARSED = JSON.parse(SYNTHETIC_ARRAY);

/** A second synthetic array, distinct in bytes, for two-JSON-value fixtures. */
const SYNTHETIC_ARRAY_2 = '[\n  { "stratum": "Operations / Execution", "text": "second synthetic fixture" }\n]';

console.log('\n=== 1. SYNTHETIC PARSER-BEHAVIOR TESTS ===');

console.log('\nCASE A — PLAIN_JSON');

await check('PASS: plain JSON array, no fence at all', () => {
  const r = extractCbrpAuthorResponse(SYNTHETIC_ARRAY);
  assert.equal(r.ok, true);
  assert.equal(r.representationDetected, REPRESENTATIONS.PLAIN_JSON);
  assert.deepEqual(r.parsed, SYNTHETIC_PARSED);
  assert.equal(r.normalizedJsonBytes, SYNTHETIC_ARRAY);
});

await check('PASS: plain JSON array with surrounding whitespace only', () => {
  const r = extractCbrpAuthorResponse(`\n\n  ${SYNTHETIC_ARRAY}  \n\n`);
  assert.equal(r.ok, true);
  assert.equal(r.representationDetected, REPRESENTATIONS.PLAIN_JSON);
});

console.log('\nCASE B — COMPLETE_OUTER_FENCE');

await check('PASS: ```json fenced array', () => {
  const raw = '```json\n' + SYNTHETIC_ARRAY + '\n```';
  const r = extractCbrpAuthorResponse(raw);
  assert.equal(r.ok, true);
  assert.equal(r.representationDetected, REPRESENTATIONS.COMPLETE_OUTER_FENCE);
  assert.deepEqual(r.parsed, SYNTHETIC_PARSED);
});

await check('PASS: bare ``` fenced array (no language tag)', () => {
  const raw = '```\n' + SYNTHETIC_ARRAY + '\n```';
  const r = extractCbrpAuthorResponse(raw);
  assert.equal(r.ok, true);
  assert.equal(r.representationDetected, REPRESENTATIONS.COMPLETE_OUTER_FENCE);
});

console.log('\nCASE C — ORPHAN_TRAILING_FENCE: PASS vectors (§5)');

await check('PASS: array + "\\n```" — bare newline then fence', () => {
  const r = extractCbrpAuthorResponse(SYNTHETIC_ARRAY + '\n```');
  assert.equal(r.ok, true);
  assert.equal(r.representationDetected, REPRESENTATIONS.ORPHAN_TRAILING_FENCE);
  assert.deepEqual(r.parsed, SYNTHETIC_PARSED);
  assert.equal(r.normalizedJsonBytes, SYNTHETIC_ARRAY);
});

await check('PASS: array + "\\r\\n```" — CRLF line boundary', () => {
  const r = extractCbrpAuthorResponse(SYNTHETIC_ARRAY + '\r\n```');
  assert.equal(r.ok, true);
  assert.equal(r.representationDetected, REPRESENTATIONS.ORPHAN_TRAILING_FENCE);
});

await check('PASS: array + " \\t\\n```" — horizontal whitespace on the array\'s own line', () => {
  const r = extractCbrpAuthorResponse(SYNTHETIC_ARRAY + ' \t\n```');
  assert.equal(r.ok, true);
  assert.equal(r.representationDetected, REPRESENTATIONS.ORPHAN_TRAILING_FENCE);
});

await check('PASS: array + "\\n\\n```\\n" — blank line before the fence, trailing newline after', () => {
  const r = extractCbrpAuthorResponse(SYNTHETIC_ARRAY + '\n\n```\n');
  assert.equal(r.ok, true);
  assert.equal(r.representationDetected, REPRESENTATIONS.ORPHAN_TRAILING_FENCE);
});

await check('PASS: array + "\\n```\\n\\n" — trailing blank lines after the fence', () => {
  const r = extractCbrpAuthorResponse(SYNTHETIC_ARRAY + '\n```\n\n');
  assert.equal(r.ok, true);
  assert.equal(r.representationDetected, REPRESENTATIONS.ORPHAN_TRAILING_FENCE);
});

await check('PASS: array bytes with brackets/braces/escaped quotes inside string text are not mistaken for structure', () => {
  const tricky = '[\n  { "stratum": "Strategy / Commitment", "text": "cost is [$3M] and the plan is {A, B, C}, with an escaped quote: \\"done\\"" }\n]';
  const r = extractCbrpAuthorResponse(tricky + '\n```');
  assert.equal(r.ok, true);
  assert.equal(r.representationDetected, REPRESENTATIONS.ORPHAN_TRAILING_FENCE);
  assert.equal(r.normalizedJsonBytes, tricky);
});

console.log('\nCASE C — ORPHAN_TRAILING_FENCE: FAIL vectors (§5, exact-line grammar)');

await check('FAIL: array + "```" — fence on the same line, no line boundary at all', () => {
  const r = extractCbrpAuthorResponse(SYNTHETIC_ARRAY + '```');
  assert.equal(r.ok, false, 'no line boundary before the fence must not be recognized');
});

await check('FAIL: array + " ```" — fence on the same line as `]`, separated only by a space', () => {
  const r = extractCbrpAuthorResponse(SYNTHETIC_ARRAY + ' ```');
  assert.equal(r.ok, false, 'same-line fence, even with intervening horizontal whitespace, must not be recognized');
});

await check('FAIL: array + "\\n ```" — leading space on the fence line', () => {
  const r = extractCbrpAuthorResponse(SYNTHETIC_ARRAY + '\n ```');
  assert.equal(r.ok, false, 'a leading space makes the fence line\'s raw content " ```", not "```"');
});

await check('FAIL: array + "\\n\\t```" — leading tab on the fence line', () => {
  const r = extractCbrpAuthorResponse(SYNTHETIC_ARRAY + '\n\t```');
  assert.equal(r.ok, false);
});

await check('FAIL: array + "\\n``` " — trailing space on the fence line', () => {
  const r = extractCbrpAuthorResponse(SYNTHETIC_ARRAY + '\n``` ');
  assert.equal(r.ok, false);
});

await check('FAIL: array + "\\n```\\t" — trailing tab on the fence line', () => {
  const r = extractCbrpAuthorResponse(SYNTHETIC_ARRAY + '\n```\t');
  assert.equal(r.ok, false);
});

await check('FAIL: array + "\\n```json" — language tag not permitted on an orphan trailing fence', () => {
  const r = extractCbrpAuthorResponse(SYNTHETIC_ARRAY + '\n```json');
  assert.equal(r.ok, false);
});

await check('FAIL: array + "\\n```\\n```" — a second fence', () => {
  const r = extractCbrpAuthorResponse(SYNTHETIC_ARRAY + '\n```\n```');
  assert.equal(r.ok, false);
});

await check('FAIL: array + "\\n```\\nprose" — prose after the fence line', () => {
  const r = extractCbrpAuthorResponse(SYNTHETIC_ARRAY + '\n```\nprose');
  assert.equal(r.ok, false);
});

console.log('\nFAIL — prefix prose');

await check('FAIL: prose before the array, trailing fence present', () => {
  const raw = 'Here are the scenarios:\n' + SYNTHETIC_ARRAY + '\n```';
  const r = extractCbrpAuthorResponse(raw);
  assert.equal(r.ok, false);
  assert.equal(r.representationDetected, null);
  assert.equal(r.normalizedJsonBytes, null);
});

console.log('\nFAIL — suffix prose, no fence');

await check('FAIL: explanation after the array, no fence at all', () => {
  const raw = SYNTHETIC_ARRAY + '\nI hope these are useful!';
  const r = extractCbrpAuthorResponse(raw);
  assert.equal(r.ok, false);
});

console.log('\nFAIL — malformed JSON / truncation / multiple values');

await check('FAIL: opening fence with no closing fence (truncated wrapper)', () => {
  const raw = '```json\n' + SYNTHETIC_ARRAY; // no closing fence at all
  const r = extractCbrpAuthorResponse(raw);
  assert.equal(r.ok, false);
});

await check('FAIL: broken JSON followed by a trailing fence', () => {
  const raw = '[\n  { "stratum": "Strategy / Commitment", "text": "missing closing brace"\n]\n```';
  const r = extractCbrpAuthorResponse(raw);
  assert.equal(r.ok, false);
});

await check('FAIL: two JSON arrays back to back, no fence', () => {
  const raw = SYNTHETIC_ARRAY + '\n' + SYNTHETIC_ARRAY_2;
  const r = extractCbrpAuthorResponse(raw);
  assert.equal(r.ok, false);
});

await check('FAIL: two JSON arrays followed by a trailing fence (second JSON value)', () => {
  const raw = SYNTHETIC_ARRAY + '\n' + SYNTHETIC_ARRAY_2 + '\n```';
  const r = extractCbrpAuthorResponse(raw);
  assert.equal(r.ok, false);
});

await check('FAIL: truncated array, unterminated, even with a trailing fence', () => {
  const raw = '[\n  { "stratum": "Strategy / Commitment", "text": "cut off mid' + '\n```';
  const r = extractCbrpAuthorResponse(raw);
  assert.equal(r.ok, false);
});

await check('FAIL: empty response', () => {
  const r = extractCbrpAuthorResponse('   \n  ');
  assert.equal(r.ok, false);
});

await check('FAIL: response is a JSON object, not an array', () => {
  const r = extractCbrpAuthorResponse('{ "stratum": "Strategy / Commitment", "text": "not an array" }');
  assert.equal(r.ok, false);
});

console.log('\nEvidence fields');

await check('originalRawSha256 is always populated, even on failure', () => {
  const raw = 'not json at all';
  const r = extractCbrpAuthorResponse(raw);
  assert.equal(r.ok, false);
  assert.match(r.originalRawSha256, /^[0-9a-f]{64}$/);
  assert.equal(r.normalizedJsonSha256, null);
});

await check('normalizedJsonSha256 is the hash of exactly normalizedJsonBytes, byte for byte', async () => {
  const raw = SYNTHETIC_ARRAY + '\n```';
  const r = extractCbrpAuthorResponse(raw);
  assert.equal(r.ok, true);
  const { createHash } = await import('node:crypto');
  const expected = createHash('sha256').update(r.normalizedJsonBytes, 'utf8').digest('hex');
  assert.equal(r.normalizedJsonSha256, expected);
});

await check('extractorVersion is pinned to the 2.1 conformance repair, not a new protocol version', () => {
  assert.equal(EXTRACTOR_VERSION, 'CBRP-AUTHOR-EXTRACTOR-2.1');
  const r = extractCbrpAuthorResponse(SYNTHETIC_ARRAY);
  assert.equal(r.extractorVersion, 'CBRP-AUTHOR-EXTRACTOR-2.1');
});

await check('normalized bytes are never edited: re-parsing them matches the returned parsed value exactly', () => {
  const raw = SYNTHETIC_ARRAY + '\n```';
  const r = extractCbrpAuthorResponse(raw);
  assert.deepEqual(JSON.parse(r.normalizedJsonBytes), r.parsed);
});

const parserBehaviorPassed = passed;
const parserBehaviorFailed = failed;

console.log('\n=== 2. HISTORICAL-EVIDENCE ANTI-CONTAMINATION PROVENANCE CHECK ===');
console.log('(not a parser-behavior fixture; asserts this file embeds no B02 bytes)\n');

let provenancePassed = 0, provenanceFailed = 0;
async function checkProvenance(name, fn) {
  try { await fn(); console.log(`  PASS ${name}`); provenancePassed++; }
  catch (e) { console.log(`  FAIL ${name}\n      ${e.stack}`); provenanceFailed++; }
}

await checkProvenance('no fixture in this file matches AUTHOR2-B02-S00 raw bytes', () => {
  const b02Path = path.join(DIR, '..', 'authoring-v2-round-0', 'raw', 'AUTHOR2-B02-S00.txt');
  const b02 = fs.readFileSync(b02Path, 'utf8');
  const thisFile = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  assert.ok(!thisFile.includes(b02.slice(0, 200)), 'test file must not embed B02 raw content');
});

console.log('\n=== 3. HISTORICAL B02 DESCRIPTIVE VERIFICATION (informal, not PASS/FAIL) ===');
console.log('Per CBRP_AUTHORING_PROTOCOL_2.md §9.2.1 — evidence only, never a fixture,');
console.log('never an admission decision, never a change to CWP-10B\'s disposition.\n');

{
  const b02Path = path.join(DIR, '..', 'authoring-v2-round-0', 'raw', 'AUTHOR2-B02-S00.txt');
  const b02 = fs.readFileSync(b02Path, 'utf8');
  const r = extractCbrpAuthorResponse(b02);
  console.log(`  representationDetected: ${r.representationDetected}`);
  console.log(`  originalRawSha256:      ${r.originalRawSha256}`);
  console.log(`  candidateCount:         ${Array.isArray(r.parsed) ? r.parsed.length : null}`);
}

console.log('\n=== SUMMARY ===');
console.log(`synthetic parser-behavior tests:              ${parserBehaviorPassed}/${parserBehaviorPassed + parserBehaviorFailed} passed`);
console.log(`historical-evidence anti-contamination check: ${provenancePassed}/${provenancePassed + provenanceFailed} passed`);
console.log(`historical B02 descriptive verification:      reported above, not a PASS/FAIL test`);

const totalPassed = parserBehaviorPassed + provenancePassed;
const totalFailed = parserBehaviorFailed + provenanceFailed;
console.log(`\n${totalPassed} passed, ${totalFailed} failed`);
process.exit(totalFailed === 0 ? 0 : 1);
