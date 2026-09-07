/**
 * Offline deterministic tests for CBRP-AUTHOR-EXTRACTOR-2.1.
 *
 * All fixtures are synthetic. None is drawn from CWP-10B's AUTHOR2-B02-S00 response —
 * per CWP-10C §8, historical B02 evidence may be *cited* descriptively in methodology
 * documents but must never become the test input that defines the parser. The synthetic
 * array below exists only to exercise the grammar; its content is deliberately generic
 * and is not, and must never become, a CBRP candidate.
 */
import assert from 'node:assert/strict';
import { EXTRACTOR_VERSION, REPRESENTATIONS, extractCbrpAuthorResponse } from './cbrp-author-extractor.mjs';

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

console.log('\nCASE C — ORPHAN_TRAILING_FENCE (new in 2.1)');

await check('PASS: complete array followed by a lone trailing fence, no opening fence', () => {
  const raw = SYNTHETIC_ARRAY + '\n```';
  const r = extractCbrpAuthorResponse(raw);
  assert.equal(r.ok, true);
  assert.equal(r.representationDetected, REPRESENTATIONS.ORPHAN_TRAILING_FENCE);
  assert.deepEqual(r.parsed, SYNTHETIC_PARSED);
  assert.equal(r.normalizedJsonBytes, SYNTHETIC_ARRAY);
});

await check('PASS: orphan trailing fence with trailing whitespace after it', () => {
  const raw = SYNTHETIC_ARRAY + '\n```\n\n';
  const r = extractCbrpAuthorResponse(raw);
  assert.equal(r.ok, true);
  assert.equal(r.representationDetected, REPRESENTATIONS.ORPHAN_TRAILING_FENCE);
});

await check('PASS: array bytes containing brackets and braces inside string text are not mistaken for structure', () => {
  const tricky = '[\n  { "stratum": "Strategy / Commitment", "text": "cost is [$3M] and the plan is {A, B, C}, with an escaped quote: \\"done\\"" }\n]';
  const raw = tricky + '\n```';
  const r = extractCbrpAuthorResponse(raw);
  assert.equal(r.ok, true);
  assert.equal(r.representationDetected, REPRESENTATIONS.ORPHAN_TRAILING_FENCE);
  assert.equal(r.normalizedJsonBytes, tricky);
});

console.log('\nFAIL — prefix prose');

await check('FAIL: prose before the array, trailing fence present', () => {
  const raw = 'Here are the scenarios:\n' + SYNTHETIC_ARRAY + '\n```';
  const r = extractCbrpAuthorResponse(raw);
  assert.equal(r.ok, false);
  assert.equal(r.representationDetected, null);
  assert.equal(r.normalizedJsonBytes, null);
});

console.log('\nFAIL — suffix prose');

await check('FAIL: explanation after the array, no fence', () => {
  const raw = SYNTHETIC_ARRAY + '\nI hope these are useful!';
  const r = extractCbrpAuthorResponse(raw);
  assert.equal(r.ok, false);
});

console.log('\nFAIL — doubled / malformed fencing');

await check('FAIL: array followed by two closing fences', () => {
  const raw = SYNTHETIC_ARRAY + '\n```\n```';
  const r = extractCbrpAuthorResponse(raw);
  assert.equal(r.ok, false);
});

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

await check('FAIL: two JSON arrays followed by a trailing fence (second JSON value, condition 9)', () => {
  const raw = SYNTHETIC_ARRAY + '\n' + SYNTHETIC_ARRAY_2 + '\n```';
  const r = extractCbrpAuthorResponse(raw);
  assert.equal(r.ok, false);
});

await check('FAIL: language-tagged trailing fence is not a bare fence (condition 5)', () => {
  const raw = SYNTHETIC_ARRAY + '\n```json';
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

await check('extractorVersion is pinned', () => {
  assert.equal(EXTRACTOR_VERSION, 'CBRP-AUTHOR-EXTRACTOR-2.1');
  const r = extractCbrpAuthorResponse(SYNTHETIC_ARRAY);
  assert.equal(r.extractorVersion, 'CBRP-AUTHOR-EXTRACTOR-2.1');
});

await check('normalized bytes are never edited: re-parsing them matches the returned parsed value exactly', () => {
  const raw = SYNTHETIC_ARRAY + '\n```';
  const r = extractCbrpAuthorResponse(raw);
  assert.deepEqual(JSON.parse(r.normalizedJsonBytes), r.parsed);
});

console.log('\nNegative control: this suite must not derive from CWP-10B evidence');

await check('no fixture in this file matches AUTHOR2-B02-S00 raw bytes', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const b02Path = path.join(dir, '..', 'authoring-v2-round-0', 'raw', 'AUTHOR2-B02-S00.txt');
  const b02 = fs.readFileSync(b02Path, 'utf8');
  const thisFile = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  assert.ok(!thisFile.includes(b02.slice(0, 200)), 'test file must not embed B02 raw content');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
