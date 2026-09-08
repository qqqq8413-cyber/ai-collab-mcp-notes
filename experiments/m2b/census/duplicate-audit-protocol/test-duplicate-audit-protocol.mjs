/** Offline-only synthetic verification for the duplicate-audit protocol modules. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  LAYER_A_VERSION,
  D1D2_WRAPPER_VERSION,
  D3_WRAPPER_VERSION,
  EXPECTED_LAYER_A_BYTE_COUNT,
  EXPECTED_LAYER_A_SHA256,
  extractLayerAPasteBytes,
  loadFrozenLayerABytes,
  buildD1D2Prompt,
  buildD3Prompt,
} from './duplicate-audit-prompt-v1.mjs';
import {
  ORDER_VERSION,
  sortLexicographic,
  validateCorpusAndScope,
  canonicalizePair,
  pairKey,
  computePairUniverse,
  pairUniverseHash,
} from './duplicate-audit-order-v1.mjs';
import {
  EXTRACTOR_VERSION,
  extractDuplicateAuditResponse,
} from './duplicate-audit-extractor-v1.mjs';
import {
  validateD1D2Response,
  validateD3Response,
  deriveD1D2Outcome,
  finalPairDecision,
  computeDuplicateD3Selector,
  computeConnectedComponents,
  applyRetentionToComponent,
  applyRetention,
} from './duplicate-audit-decision-v1.mjs';
import {
  computeD1D2SessionPlan,
  computeD3RoutePlan,
  buildD3RouteManifest,
  ROUND_STATES,
} from './duplicate-audit-runner.mjs';

const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    passed += 1;
  } catch (error) {
    console.log(`  FAIL ${name}\n      ${error.stack}`);
    failed += 1;
  }
}

function makeTasks(n, prefix = 'CBRP-T') {
  const tasks = [];
  for (let i = 0; i < n; i += 1) {
    tasks.push({ candidateId: `${prefix}-${String(i).padStart(2, '0')}`, taskText: `Synthetic decision scenario ${i}; fixture only.` });
  }
  return tasks;
}

console.log('\n=== CBRP DUPLICATE AUDIT PROTOCOL — SYNTHETIC ONLY ===');

console.log('\n--- Layer A frozen text ---');

check('Layer A extracts from the committed protocol doc to the frozen byte count and SHA-256', () => {
  const layerA = loadFrozenLayerABytes();
  assert.equal(Buffer.byteLength(layerA, 'utf8'), EXPECTED_LAYER_A_BYTE_COUNT);
  assert.equal(sha256(layerA), EXPECTED_LAYER_A_SHA256);
});

check('extractLayerAPasteBytes strips only the marker spacers, never the content\'s own trailing newline', () => {
  const synthetic = '# doc\n\n> ### Paste from here.\n\nhello\nworld\n\n> ### Paste to here.\n\nmore doc\n';
  assert.equal(extractLayerAPasteBytes(synthetic), 'hello\nworld\n');
});

check('extractLayerAPasteBytes throws on missing/duplicated/out-of-order markers', () => {
  assert.throws(() => extractLayerAPasteBytes('no markers here'), /start marker not found/);
  assert.throws(() => extractLayerAPasteBytes('> ### Paste from here.\nx'), /end marker not found/);
  assert.throws(
    () => extractLayerAPasteBytes('> ### Paste from here.\na\n> ### Paste from here.\nb\n> ### Paste to here.'),
    /start marker appears more than once/
  );
  assert.throws(
    () => extractLayerAPasteBytes('> ### Paste to here.\nx\n> ### Paste from here.'),
    /end marker precedes start marker/
  );
});

console.log('\n--- D1/D2 and D3 prompt byte determinism ---');

const layerA = loadFrozenLayerABytes();
const tasks = makeTasks(6);
const ids = tasks.map((t) => t.candidateId);

check('buildD1D2Prompt is deterministic: identical logical input produces byte-identical output', () => {
  const p1 = buildD1D2Prompt({ corpusTasks: tasks, auditScopeIds: ids, layerABytes: layerA });
  const p2 = buildD1D2Prompt({ corpusTasks: tasks, auditScopeIds: ids, layerABytes: layerA });
  assert.equal(p1.modelVisiblePrompt, p2.modelVisiblePrompt);
  assert.equal(p1.promptSha256, p2.promptSha256);
  assert.equal(p1.wrapperVersion, D1D2_WRAPPER_VERSION);
});

check('buildD1D2Prompt is independent of corpusTasks/auditScopeIds input order (D1 == D2 bytes)', () => {
  const shuffledTasks = [...tasks].reverse();
  const shuffledIds = [...ids].reverse();
  const p1 = buildD1D2Prompt({ corpusTasks: tasks, auditScopeIds: ids, layerABytes: layerA });
  const p2 = buildD1D2Prompt({ corpusTasks: shuffledTasks, auditScopeIds: shuffledIds, layerABytes: layerA });
  assert.equal(p1.promptSha256, p2.promptSha256);
});

check('D1/D2 prompt embeds AUDIT INPUT JSON with auditScopeIds before corpusTasks, both lexicographically sorted', () => {
  const p = buildD1D2Prompt({ corpusTasks: tasks, auditScopeIds: [ids[3], ids[0], ids[5]], layerABytes: layerA });
  const jsonLine = p.modelVisiblePrompt.split('AUDIT INPUT JSON:\n')[1];
  const parsed = JSON.parse(jsonLine);
  assert.deepEqual(Object.keys(parsed), ['auditScopeIds', 'corpusTasks']);
  assert.deepEqual(parsed.auditScopeIds, [ids[0], ids[3], ids[5]].sort());
  assert.deepEqual(parsed.corpusTasks.map((t) => t.candidateId), [...ids].sort());
  for (const t of parsed.corpusTasks) assert.deepEqual(Object.keys(t), ['candidateId', 'taskText']);
});

check('D1/D2 prompt never contains auditorId, session identity, or stratum wording', () => {
  const p = buildD1D2Prompt({ corpusTasks: tasks, auditScopeIds: ids, layerABytes: layerA });
  assert.equal(p.modelVisiblePrompt.includes('auditorId'), false);
  assert.equal(p.modelVisiblePrompt.includes('sessionId'), false);
  assert.equal(p.modelVisiblePrompt.includes('stratum'), false);
});

check('buildD1D2Prompt rejects a scope ID absent from the corpus', () => {
  assert.throws(() => buildD1D2Prompt({ corpusTasks: tasks, auditScopeIds: ['CBRP-NOT-REAL'], layerABytes: layerA }));
});

check('buildD3Prompt is deterministic and embeds PAIR JSON with a before b, candidateId before taskText', () => {
  const a = tasks[0];
  const b = tasks[1];
  const d1 = buildD3Prompt({ a, b, layerABytes: layerA });
  const d2 = buildD3Prompt({ a, b, layerABytes: layerA });
  assert.equal(d1.promptSha256, d2.promptSha256);
  assert.equal(d1.wrapperVersion, D3_WRAPPER_VERSION);
  const jsonLine = d1.modelVisiblePrompt.split('PAIR JSON:\n')[1];
  const parsed = JSON.parse(jsonLine);
  assert.deepEqual(Object.keys(parsed), ['a', 'b']);
  assert.deepEqual(Object.keys(parsed.a), ['candidateId', 'taskText']);
  assert.equal(parsed.a.candidateId, a.candidateId);
  assert.equal(parsed.b.candidateId, b.candidateId);
});

check('buildD3Prompt refuses a/b supplied out of canonical order', () => {
  assert.throws(() => buildD3Prompt({ a: tasks[1], b: tasks[0], layerABytes: layerA }));
});

check('D3 prompt never mentions auditScopeIds, a corpus size, disagreement, or another auditor', () => {
  const p = buildD3Prompt({ a: tasks[0], b: tasks[1], layerABytes: layerA });
  for (const forbidden of ['auditScopeIds', 'sixty', 'disagreement', 'another auditor', 'D1', 'D2']) {
    assert.equal(p.modelVisiblePrompt.includes(forbidden), false, `must not contain ${JSON.stringify(forbidden)}`);
  }
});

check('D1/D2 and D3 prompts share the identical Layer A bytes, verifiable as a substring', () => {
  const d1d2 = buildD1D2Prompt({ corpusTasks: tasks, auditScopeIds: ids, layerABytes: layerA });
  const d3 = buildD3Prompt({ a: tasks[0], b: tasks[1], layerABytes: layerA });
  assert.equal(d1d2.modelVisiblePrompt.includes(layerA), true);
  assert.equal(d3.modelVisiblePrompt.includes(layerA), true);
  assert.equal(d1d2.layerASha256, d3.layerASha256);
  assert.equal(d1d2.layerAVersion, LAYER_A_VERSION);
});

console.log('\n--- Deterministic serialization (§5) ---');

check('sortLexicographic sorts ascending and does not mutate its input', () => {
  const input = ['C', 'A', 'B'];
  const sorted = sortLexicographic(input);
  assert.deepEqual(sorted, ['A', 'B', 'C']);
  assert.deepEqual(input, ['C', 'A', 'B']);
});

check('canonicalizePair is order-independent and requires distinct IDs', () => {
  assert.deepEqual(canonicalizePair('B', 'A'), { a: 'A', b: 'B' });
  assert.deepEqual(canonicalizePair('A', 'B'), { a: 'A', b: 'B' });
  assert.throws(() => canonicalizePair('A', 'A'));
});

check('validateCorpusAndScope rejects duplicate corpus IDs, duplicate scope IDs, and unknown scope IDs', () => {
  assert.equal(validateCorpusAndScope({ corpusTaskIds: ['A', 'A', 'B'], auditScopeIds: ['A'] }).ok, false);
  assert.equal(validateCorpusAndScope({ corpusTaskIds: ['A', 'B'], auditScopeIds: ['A', 'A'] }).ok, false);
  assert.equal(validateCorpusAndScope({ corpusTaskIds: ['A', 'B'], auditScopeIds: ['C'] }).ok, false);
  assert.equal(validateCorpusAndScope({ corpusTaskIds: ['A', 'B'], auditScopeIds: ['A'] }).ok, true);
});

check('DUP-R00 invariant: a 60-task corpus produces EXACTLY 1770 pairs -- independently verified as C(60,2)', () => {
  const ids60 = makeTasks(60).map((t) => t.candidateId);
  const universe = computePairUniverse({ corpusTaskIds: ids60, auditScopeIds: ids60 });
  const expectedByFormula = (60 * 59) / 2; // C(60,2), computed independently of computePairUniverse
  assert.equal(expectedByFormula, 1770);
  assert.equal(universe.length, 1770);
  const keys = new Set(universe.map(pairKey));
  assert.equal(keys.size, 1770, 'every pair must be unique');
  for (const { a, b } of universe) assert.equal(a < b, true, 'every pair must be canonically ordered');
});

check('incremental round: pair universe is exactly every pair with at least one endpoint in a small focusSet', () => {
  const ids10 = makeTasks(10).map((t) => t.candidateId);
  const focusSet = [ids10[0], ids10[1]]; // 2 of 10
  const universe = computePairUniverse({ corpusTaskIds: ids10, auditScopeIds: focusSet });
  // Independently enumerate: pairs touching ids10[0] or ids10[1] = 9 + 9 - 1 (the pair between them counted once) = 17
  const expected = new Set();
  for (const x of ids10) {
    for (const f of focusSet) {
      if (x !== f) expected.add(pairKey(canonicalizePair(x, f)));
    }
  }
  assert.equal(universe.length, expected.size);
  assert.equal(expected.size, 17);
  for (const p of universe) assert.equal(expected.has(pairKey(p)), true);
});

check('old-old exclusion: an incremental round never includes a pair whose both endpoints are incumbents', () => {
  const ids10 = makeTasks(10).map((t) => t.candidateId);
  const incumbents = new Set(ids10.slice(2)); // everything except the first two
  const focusSet = new Set([ids10[0], ids10[1]]);
  const universe = computePairUniverse({ corpusTaskIds: ids10, auditScopeIds: [...focusSet] });
  for (const { a, b } of universe) {
    assert.equal(incumbents.has(a) && incumbents.has(b), false, `${a}/${b} must not be an incumbent-incumbent pair`);
  }
});

check('pair orientation never depends on which side an ID was supplied on', () => {
  const u1 = computePairUniverse({ corpusTaskIds: ['B', 'A', 'C'], auditScopeIds: ['A', 'B', 'C'] });
  const u2 = computePairUniverse({ corpusTaskIds: ['C', 'B', 'A'], auditScopeIds: ['C', 'A', 'B'] });
  assert.deepEqual(u1, u2);
});

check('pairUniverseHash is a pure function of the universe content', () => {
  const u = computePairUniverse({ corpusTaskIds: ids, auditScopeIds: ids });
  assert.equal(pairUniverseHash(u), pairUniverseHash([...u]));
});

console.log('\n--- Extractor: strict JSON-only, per protocol §7.2 (CWP-12B-R) ---');

check('1. a plain valid JSON object is accepted', () => {
  const r = extractDuplicateAuditResponse('{"duplicatePairs":[]}');
  assert.equal(r.ok, true);
  assert.deepEqual(r.parsed, { duplicatePairs: [] });
});

check('2. valid JSON with ordinary JSON whitespace around it is accepted (JSON grammar tolerates ws value ws)', () => {
  const r = extractDuplicateAuditResponse('  \n\t {"duplicatePairs":[]} \n  ');
  assert.equal(r.ok, true);
  assert.deepEqual(r.parsed, { duplicatePairs: [] });
});

check('3. a complete ```json ... ``` wrapper is REJECTED, not stripped', () => {
  const r = extractDuplicateAuditResponse('```json\n{"isDuplicate":false,"reason":"no"}\n```');
  assert.equal(r.ok, false);
  assert.equal(r.parsed, null);
});

check('4. a complete ``` ... ``` wrapper (no language tag) is REJECTED, not stripped', () => {
  const r = extractDuplicateAuditResponse('```\n{"isDuplicate":false,"reason":"no"}\n```');
  assert.equal(r.ok, false);
});

check('5. an orphan trailing ``` fence is REJECTED, not stripped', () => {
  const r = extractDuplicateAuditResponse('{"isDuplicate":true,"reason":"yes"}\n```');
  assert.equal(r.ok, false);
});

check('6. a prose prefix before the JSON is REJECTED, never searched past', () => {
  const r = extractDuplicateAuditResponse('Here is my answer: {"duplicatePairs":[]}');
  assert.equal(r.ok, false);
});

check('7. a prose suffix after the JSON is REJECTED, never truncated to the JSON alone', () => {
  const r = extractDuplicateAuditResponse('{"duplicatePairs":[]} — that is my final answer.');
  assert.equal(r.ok, false);
});

check('8. multiple concatenated JSON objects are REJECTED, never resolved by picking the first/last', () => {
  const r = extractDuplicateAuditResponse('{"duplicatePairs":[]}{"duplicatePairs":[]}');
  assert.equal(r.ok, false);
});

check('9. malformed JSON is REJECTED, never repaired', () => {
  const cases = [
    'not json at all',
    '{"duplicatePairs": [}', // broken JSON
    '{"duplicatePairs":[',    // truncated
    "{'duplicatePairs':[]}", // single quotes are not valid JSON
  ];
  for (const raw of cases) {
    const r = extractDuplicateAuditResponse(raw);
    assert.equal(r.ok, false, `expected REJECT for ${JSON.stringify(raw)}`);
  }
});

check('rawSha256/rawBytes always reflect the untouched input, never a transformed/repaired byte sequence', () => {
  const raw = '  {"duplicatePairs":[]}  ';
  const r = extractDuplicateAuditResponse(raw);
  assert.equal(r.rawSha256, sha256(raw));
  assert.equal(r.rawBytes, Buffer.byteLength(raw, 'utf8'));
});

check('a rejected response still reports EXTRACTOR_VERSION and null parsed, with no fabricated normalized form', () => {
  const r = extractDuplicateAuditResponse('```json\n{}\n```');
  assert.equal(r.extractorVersion, EXTRACTOR_VERSION);
  assert.equal(r.parsed, null);
  assert.equal('normalizedJsonBytes' in r, false);
  assert.equal('representationDetected' in r, false);
});

console.log('\n--- D1/D2 response validation (§7.1/§7.2) ---');

const universe15 = computePairUniverse({ corpusTaskIds: ids, auditScopeIds: ids }); // 6 tasks -> 15 pairs
const corpusIds = ids;

check('a well-formed response with a valid positive pair validates', () => {
  const r = validateD1D2Response(
    { duplicatePairs: [{ a: ids[0], b: ids[1], reason: 'same decision structure' }] },
    { corpusTaskIds: corpusIds, pairUniverse: universe15 }
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.positivePairs, [{ a: ids[0], b: ids[1], reason: 'same decision structure' }]);
});

check('empty duplicatePairs is accepted as a normal outcome', () => {
  const r = validateD1D2Response({ duplicatePairs: [] }, { corpusTaskIds: corpusIds, pairUniverse: universe15 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.positivePairs, []);
});

check('an unknown candidate ID is rejected', () => {
  const r = validateD1D2Response(
    { duplicatePairs: [{ a: 'CBRP-GHOST', b: ids[1], reason: 'x' }] },
    { corpusTaskIds: corpusIds, pairUniverse: universe15 }
  );
  assert.equal(r.ok, false);
});

check('a === b is rejected', () => {
  const r = validateD1D2Response(
    { duplicatePairs: [{ a: ids[0], b: ids[0], reason: 'x' }] },
    { corpusTaskIds: corpusIds, pairUniverse: universe15 }
  );
  assert.equal(r.ok, false);
});

check('a reversed pair (a > b) is rejected outright, never silently normalized', () => {
  const [small, large] = [ids[0], ids[1]].sort();
  const r = validateD1D2Response(
    { duplicatePairs: [{ a: large, b: small, reason: 'x' }] },
    { corpusTaskIds: corpusIds, pairUniverse: universe15 }
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /canonically ordered/);
});

check('a duplicate canonical pair entry is rejected', () => {
  const r = validateD1D2Response(
    { duplicatePairs: [
      { a: ids[0], b: ids[1], reason: 'first' },
      { a: ids[0], b: ids[1], reason: 'second' },
    ] },
    { corpusTaskIds: corpusIds, pairUniverse: universe15 }
  );
  assert.equal(r.ok, false);
});

check('a pair outside the in-scope pair universe is rejected (scope violation)', () => {
  const smallCorpus = ['CBRP-X-00', 'CBRP-X-01', 'CBRP-X-02'];
  const smallUniverse = computePairUniverse({ corpusTaskIds: smallCorpus, auditScopeIds: [smallCorpus[0]] });
  // pair (X-01, X-02) has neither endpoint in the scope [X-00] -- out of scope
  const r = validateD1D2Response(
    { duplicatePairs: [{ a: smallCorpus[1], b: smallCorpus[2], reason: 'x' }] },
    { corpusTaskIds: smallCorpus, pairUniverse: smallUniverse }
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /outside the in-scope pair universe/);
});

check('an empty-string reason is rejected', () => {
  const r = validateD1D2Response(
    { duplicatePairs: [{ a: ids[0], b: ids[1], reason: '' }] },
    { corpusTaskIds: corpusIds, pairUniverse: universe15 }
  );
  assert.equal(r.ok, false);
});

check('a model-visible auditorId field on the top-level object is rejected (extra key)', () => {
  const r = validateD1D2Response(
    { duplicatePairs: [], auditorId: 'D1' },
    { corpusTaskIds: corpusIds, pairUniverse: universe15 }
  );
  assert.equal(r.ok, false);
});

check('a non-object / malformed top-level shape is rejected', () => {
  assert.equal(validateD1D2Response([], { corpusTaskIds: corpusIds, pairUniverse: universe15 }).ok, false);
  assert.equal(validateD1D2Response({ wrongKey: [] }, { corpusTaskIds: corpusIds, pairUniverse: universe15 }).ok, false);
  assert.equal(validateD1D2Response({ duplicatePairs: 'not an array' }, { corpusTaskIds: corpusIds, pairUniverse: universe15 }).ok, false);
});

console.log('\n--- D3 response validation (§8.1) ---');

check('a well-formed D3 response validates', () => {
  const r = validateD3Response({ isDuplicate: true, reason: 'same decision structure' });
  assert.equal(r.ok, true);
  assert.equal(r.isDuplicate, true);
});

check('D3 schema rejects a non-boolean isDuplicate, a missing/empty reason, and extra keys', () => {
  assert.equal(validateD3Response({ isDuplicate: 'true', reason: 'x' }).ok, false);
  assert.equal(validateD3Response({ isDuplicate: true, reason: '' }).ok, false);
  assert.equal(validateD3Response({ isDuplicate: true }).ok, false);
  assert.equal(validateD3Response({ isDuplicate: true, reason: 'x', extra: 1 }).ok, false);
  assert.equal(validateD3Response(null).ok, false);
  assert.equal(validateD3Response([]).ok, false);
});

console.log('\n--- Decision matrix and disagreement derivation (§7.3/§7.4) ---');

check('D1=true + D2=true confirms; D1=false + D2=false is not duplicate; disagreement requires D3', () => {
  const universe = computePairUniverse({ corpusTaskIds: ids, auditScopeIds: ids });
  const confirmedPair = { a: ids[0], b: ids[1] };
  const disagreePair = { a: ids[2], b: ids[3] };
  const outcome = deriveD1D2Outcome({
    pairUniverse: universe,
    d1PositivePairs: [confirmedPair, disagreePair],
    d2PositivePairs: [confirmedPair],
  });
  const byKey = new Map(outcome.results.map((r) => [pairKey(r), r]));
  assert.equal(byKey.get(pairKey(confirmedPair)).outcome, 'CONFIRMED');
  assert.equal(byKey.get(pairKey(disagreePair)).outcome, 'D3_REQUIRED');
  const untouchedPair = { a: ids[4], b: ids[5] };
  assert.equal(byKey.get(pairKey(untouchedPair)).outcome, 'NOT_DUPLICATE');
});

check('omission from duplicatePairs is read as a NOT DUPLICATE vote: a pair neither auditor mentions is NOT_DUPLICATE, not D3_REQUIRED', () => {
  const universe = computePairUniverse({ corpusTaskIds: ids, auditScopeIds: ids });
  const outcome = deriveD1D2Outcome({ pairUniverse: universe, d1PositivePairs: [], d2PositivePairs: [] });
  assert.equal(outcome.disagreementSet.length, 0);
  assert.equal(outcome.confirmedPairs.length, 0);
  assert.equal(outcome.results.every((r) => r.outcome === 'NOT_DUPLICATE'), true);
  assert.equal(outcome.results.length, universe.length, 'the full universe is the denominator, not the union of positive reports');
});

check('finalPairDecision is ordinary majority of {D1, D2, D3}, never a tie', () => {
  assert.equal(finalPairDecision({ d1: true, d2: false, d3: true }), true);
  assert.equal(finalPairDecision({ d1: true, d2: false, d3: false }), false);
  assert.equal(finalPairDecision({ d1: false, d2: true, d3: true }), true);
});

console.log('\n--- CBRP-D3-v1 duplicate routing (§8.2) — frozen test vectors ---');

// Independent fixtures: CBRP_MODEL_PINS_PREREG_DRAFT.md §7.2's own frozen test
// vectors, transcribed here rather than derived from computeDuplicateD3Selector.
const D3_VECTORS = [
  { x: 'CBRP-SC-01', y: 'CBRP-FR-07', a: 'CBRP-FR-07', b: 'CBRP-SC-01', firstHex: 'f', provider: 'gemini', model: 'gemini-3.8-flash' },
  { x: 'CBRP-FR-07', y: 'CBRP-SC-01', a: 'CBRP-FR-07', b: 'CBRP-SC-01', firstHex: 'f', provider: 'gemini', model: 'gemini-3.8-flash' },
  { x: 'CBRP-BC-02', y: 'CBRP-BC-09', a: 'CBRP-BC-02', b: 'CBRP-BC-09', firstHex: '7', provider: 'claude', model: 'claude-opus-5' },
  { x: 'CBRP-EI-04', y: 'CBRP-PS-10', a: 'CBRP-EI-04', b: 'CBRP-PS-10', firstHex: '8', provider: 'gemini', model: 'gemini-3.8-flash' },
];

check('computeDuplicateD3Selector reproduces every frozen CBRP_MODEL_PINS_PREREG_DRAFT.md §7.2 test vector exactly', () => {
  for (const vector of D3_VECTORS) {
    const route = computeDuplicateD3Selector(vector.x, vector.y);
    assert.equal(route.a, vector.a);
    assert.equal(route.b, vector.b);
    assert.equal(route.selector[0], vector.firstHex);
    assert.equal(route.provider, vector.provider);
    assert.equal(route.model, vector.model);
  }
});

check('(SC-01, FR-07) and (FR-07, SC-01) route identically -- the route is a property of the pair, not who reported it first', () => {
  const r1 = computeDuplicateD3Selector('CBRP-SC-01', 'CBRP-FR-07');
  const r2 = computeDuplicateD3Selector('CBRP-FR-07', 'CBRP-SC-01');
  assert.deepEqual(r1, r2);
});

check('the selectorInput is exactly "CBRP-D3-v1\\nDUPLICATE\\n" + a + "\\n" + b', () => {
  const route = computeDuplicateD3Selector('CBRP-BC-09', 'CBRP-BC-02');
  assert.equal(route.selectorInput, 'CBRP-D3-v1\nDUPLICATE\nCBRP-BC-02\nCBRP-BC-09');
});

console.log('\n--- Connected components and retention (§11) ---');

check('computeConnectedComponents groups transitively-linked confirmed pairs and leaves untouched candidates out entirely', () => {
  const confirmed = [{ a: 'A', b: 'B' }, { a: 'B', b: 'C' }, { a: 'X', b: 'Y' }];
  const components = computeConnectedComponents(confirmed);
  // Independently reasoned: {A,B,C} is one component (A-B, B-C chain), {X,Y} is another.
  const sorted = components.map((c) => [...c].sort()).sort((p, q) => p[0].localeCompare(q[0]));
  assert.deepEqual(sorted, [['A', 'B', 'C'], ['X', 'Y']]);
});

check('round-0 retention: no incumbents, keep the lexicographically smallest member of each component', () => {
  const confirmed = [{ a: 'CBRP-A-02', b: 'CBRP-A-05' }, { a: 'CBRP-A-05', b: 'CBRP-A-09' }];
  const allIds = ['CBRP-A-01', 'CBRP-A-02', 'CBRP-A-05', 'CBRP-A-09'];
  const result = applyRetention({ confirmedPairs: confirmed, incumbents: [], focusSet: allIds });
  assert.deepEqual(result.keptFromComponents, ['CBRP-A-02']);
  assert.deepEqual(result.rejected, ['CBRP-A-05', 'CBRP-A-09']);
});

check('incumbent-priority retention: any incumbent in a component is kept, every replacement in it is rejected', () => {
  const incumbent = 'CBRP-INC-01';
  const replacementSmaller = 'CBRP-REP-01'; // lexicographically smaller than the incumbent
  const replacementLarger = 'CBRP-REP-09';
  const confirmed = [{ a: replacementSmaller, b: incumbent }, { a: incumbent, b: replacementLarger }];
  const result = applyRetentionToComponent({
    component: [replacementSmaller, incumbent, replacementLarger],
    incumbents: new Set([incumbent]),
    focusSet: new Set([replacementSmaller, replacementLarger]),
  });
  assert.deepEqual(result.keep, [incumbent]);
  assert.deepEqual(result.reject, [replacementSmaller, replacementLarger].sort());
  void confirmed; // shape check only; applyRetention's end-to-end path is covered separately below
});

check('no incumbent displacement: even a lexicographically smaller replacement never survives over an incumbent', () => {
  const incumbent = 'CBRP-ZZZ-99'; // deliberately "large" lexicographically
  const smallerReplacement = 'CBRP-AAA-01'; // would win a lexicographic-only rule
  const result = applyRetention({
    confirmedPairs: [{ a: smallerReplacement, b: incumbent }],
    incumbents: [incumbent],
    focusSet: [smallerReplacement],
  });
  assert.deepEqual(result.keptFromComponents, [incumbent]);
  assert.deepEqual(result.rejected, [smallerReplacement]);
});

check('a component with several incumbents keeps all of them and rejects only the replacement(s)', () => {
  const result = applyRetentionToComponent({
    component: ['CBRP-I-01', 'CBRP-I-02', 'CBRP-R-01'],
    incumbents: new Set(['CBRP-I-01', 'CBRP-I-02']),
    focusSet: new Set(['CBRP-R-01']),
  });
  assert.deepEqual(result.keep, ['CBRP-I-01', 'CBRP-I-02']);
  assert.deepEqual(result.reject, ['CBRP-R-01']);
});

check('applyRetention throws if incumbents and focusSet overlap, or a component member is in neither', () => {
  assert.throws(() => applyRetention({ confirmedPairs: [{ a: 'A', b: 'B' }], incumbents: ['A'], focusSet: ['A', 'B'] }));
  assert.throws(() => applyRetention({ confirmedPairs: [{ a: 'A', b: 'B' }], incumbents: [], focusSet: ['A'] }));
});

console.log('\n--- Round-state vocabulary (§16) ---');

check('ROUND_STATES distinguishes every state CWP-12B requires', () => {
  for (const key of ['PRE_DISPATCH', 'D1_COMPLETE', 'D2_COMPLETE', 'D3_REQUIRED', 'D3_COMPLETE', 'ROUND_COMPLETE', 'FAILED_CLOSED']) {
    assert.equal(ROUND_STATES[key], key);
  }
});

console.log('\n--- Runner: session plans and D3 route manifest (offline, no I/O) ---');

check('computeD1D2SessionPlan produces D1/D2 with the frozen pins and byte-identical prompts', () => {
  const plan = computeD1D2SessionPlan({ roundId: 'DUP-R00', corpusTasks: tasks, auditScopeIds: ids, layerABytes: layerA });
  assert.equal(plan.d1.provider, 'claude');
  assert.equal(plan.d1.model, 'claude-opus-5');
  assert.equal(plan.d2.provider, 'gemini');
  assert.equal(plan.d2.model, 'gemini-3.8-flash');
  assert.equal(plan.d1.prompt.promptSha256, plan.d2.prompt.promptSha256);
  assert.equal(plan.d1.sessionId, 'DUP-R00-D1');
  assert.equal(plan.d2.sessionId, 'DUP-R00-D2');
});

check('computeD3RoutePlan preserves disagreementSet order and derives each route via CBRP-D3-v1', () => {
  const plan = computeD1D2SessionPlan({ roundId: 'DUP-R00', corpusTasks: tasks, auditScopeIds: ids, layerABytes: layerA });
  const disagreementSet = [plan.pairUniverse[0], plan.pairUniverse[3]];
  const d3Plan = computeD3RoutePlan({ roundId: 'DUP-R00', disagreementSet, taskById: plan.taskById, layerABytes: layerA });
  assert.equal(d3Plan.length, 2);
  assert.equal(d3Plan[0].a, disagreementSet[0].a);
  assert.equal(d3Plan[0].b, disagreementSet[0].b);
  assert.equal(d3Plan[0].sessionId, `DUP-R00-D3-${disagreementSet[0].a}__${disagreementSet[0].b}`);
  const independentRoute = computeDuplicateD3Selector(disagreementSet[0].a, disagreementSet[0].b);
  assert.equal(d3Plan[0].provider, independentRoute.provider);
  assert.equal(d3Plan[0].d3Selector, independentRoute.selector);
});

check('buildD3RouteManifest is a pure, deterministic function of the route plan', () => {
  const plan = computeD1D2SessionPlan({ roundId: 'DUP-R00', corpusTasks: tasks, auditScopeIds: ids, layerABytes: layerA });
  const disagreementSet = [plan.pairUniverse[0]];
  const d3Plan = computeD3RoutePlan({ roundId: 'DUP-R00', disagreementSet, taskById: plan.taskById, layerABytes: layerA });
  const m1 = buildD3RouteManifest({ roundId: 'DUP-R00', d3RoutePlan: d3Plan });
  const m2 = buildD3RouteManifest({ roundId: 'DUP-R00', d3RoutePlan: d3Plan });
  assert.equal(JSON.stringify(m1), JSON.stringify(m2));
  assert.equal(m1.routeCount, 1);
  assert.equal(m1.routes[0].a, disagreementSet[0].a);
});

console.log('\n--- Frozen identities ---');

check('module version identifiers are fixed', () => {
  assert.equal(LAYER_A_VERSION, 'CBRP-DUPLICATE-AUDIT-LAYER-A-v1');
  assert.equal(D1D2_WRAPPER_VERSION, 'CBRP-DUPLICATE-AUDIT-D1D2-WRAPPER-1');
  assert.equal(D3_WRAPPER_VERSION, 'CBRP-DUPLICATE-AUDIT-D3-WRAPPER-1');
  assert.equal(ORDER_VERSION, 'CBRP-DUPLICATE-AUDIT-ORDER-v1');
  assert.equal(EXTRACTOR_VERSION, 'CBRP-DUPLICATE-AUDIT-EXTRACTOR-1');
});

console.log(`\n${passed} passed, ${failed} failed`);
console.log('0 provider calls. 0 duplicate audit rounds. 0 structural reviews. 0 replacement sessions. 0 Chief calls.');
process.exit(failed === 0 ? 0 : 1);
