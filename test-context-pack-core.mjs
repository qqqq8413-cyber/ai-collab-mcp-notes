// Offline tests for the E0-R6 ContextPack core: canonical serialization, fingerprint,
// budget policy, caller selection, sealing, and pack self-integrity. No domain state,
// no provider, no network.
import assert from 'node:assert/strict';
import { canonicalSerialize, contextFingerprint, serializePayload } from './dist/context/fingerprint.js';
import {
  CONTEXT_PACK_SCHEMA_VERSION,
  ContextPackBudgetError,
  InvalidContextPackError,
  readContextPack,
  sealContextPack,
  snapshotContextPackPolicy,
  snapshotContextPackSelection,
} from './dist/context/pack.js';

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

const HASH = 'a'.repeat(64);
const parts = () => ({
  binding: {
    deliberationStateId: 'state-1', sessionId: 'session-1', artifactHash: HASH, authorContextHash: 'b'.repeat(64),
    attemptId: 'attempt-1', decisionId: 'decision-1', questionId: 'question-1', route: 'ADD_REVIEWER',
    inputRefs: [{ kind: 'AUTHOR_CONTEXT_ITEM', id: 'item-1' }, { kind: 'FINDING', id: 'finding-1' }, { kind: 'SEMANTIC_ISSUE', id: 'issue-1' }],
  },
  question: { rootCause: 'COVERAGE_GAP', materialityReason: 'A material coverage gap remains.' },
  sources: [
    { ref: { kind: 'AUTHOR_CONTEXT_ITEM', id: 'item-1' }, category: 'knownRisks',
      value: { id: 'item-1', text: 'The lease may not renew.', sourceType: 'AUTHOR', status: 'CURRENT', createdAt: '2026-09-27T00:00:00.000Z' } },
    { ref: { kind: 'FINDING', id: 'finding-1' },
      value: { id: 'finding-1', reviewerRunId: 'run-1', type: 'CLAIM', title: 'Unsupported payback', artifactLocation: 'p1',
        evidenceState: 'UNSUPPORTED_IN_MATERIAL', whyMaterial: 'It drives the decision.', likelyRecipientChallenge: 'Where is this from?',
        minimumBeforeSendAction: 'Cite it.', createdAt: '2026-09-27T00:00:00.000Z' } },
    { ref: { kind: 'SEMANTIC_ISSUE', id: 'issue-1' },
      value: { id: 'issue-1', title: 'Payback', description: 'Payback is unsupported.', findingIds: ['finding-1', 'finding-2'],
        evidenceState: 'UNSUPPORTED_IN_MATERIAL', status: 'OPEN' } },
  ],
  artifact: { selectionScope: 'EXCERPT', startChar: 4, endChar: 9, text: 'excer' },
});
const POLICY = snapshotContextPackPolicy({ maxSerializedChars: 100000 });
const seal = (p = parts(), policy = POLICY, at = '2026-09-27T00:00:00.000Z') => sealContextPack(p, policy, at);
const payloadOf = (pack) => {
  const { contextFingerprint: _f, capturedAt: _c, ...payload } = pack;
  return payload;
};

console.log('\nCanonical serialization');

await check('member order is canonical: insertion order does not change the text or fingerprint', () => {
  const a = { b: 1, a: [{ y: 'x', x: 'y' }], c: { z: null, e: true } };
  const b = { c: { e: true, z: null }, a: [{ x: 'y', y: 'x' }], b: 1 };
  assert.equal(canonicalSerialize(a), canonicalSerialize(b));
  assert.equal(canonicalSerialize(a), '{"a":[{"x":"y","y":"x"}],"b":1,"c":{"e":true,"z":null}}');
  const shuffled = parts();
  shuffled.binding = Object.fromEntries(Object.entries(shuffled.binding).reverse());
  shuffled.sources[1].value = Object.fromEntries(Object.entries(shuffled.sources[1].value).reverse());
  assert.equal(seal(shuffled).contextFingerprint, seal().contextFingerprint);
});

await check('array order is significant', () => {
  assert.notEqual(canonicalSerialize([1, 2]), canonicalSerialize([2, 1]));
});

await check('only plain data is canonical', () => {
  for (const bad of [
    { f: () => 1 }, { n: Number.NaN }, { n: Infinity }, { s: Symbol('x') }, { b: 1n }, [undefined], [1, , 3],
    new Date(0), new Map(), Object.assign([1], { extra: true }),
    Object.defineProperty({}, 'g', { enumerable: true, get: () => 1 }),
    { [Symbol('k')]: 1 },
  ]) {
    assert.throws(() => canonicalSerialize(bad), TypeError);
  }
  assert.equal(canonicalSerialize({ a: undefined, b: 1 }), '{"b":1}', 'an undefined member is the same data as an absent one');
});

await check('the budget and the fingerprint read the same canonical text', () => {
  const pack = seal();
  const text = serializePayload(pack);
  assert.equal(text, canonicalSerialize(payloadOf(pack)));
  assert.equal(contextFingerprint(pack), pack.contextFingerprint);
  assert.ok(!text.includes('capturedAt') && !text.includes('contextFingerprint'));
});

console.log('\nFingerprint');

await check('capturedAt is outside the fingerprint', () => {
  const a = seal(parts(), POLICY, '2026-01-01T00:00:00.000Z');
  const b = seal(parts(), POLICY, '2030-12-31T23:59:59.999Z');
  assert.notEqual(a.capturedAt, b.capturedAt);
  assert.equal(a.contextFingerprint, b.contextFingerprint);
});

const MUTATIONS = [
  ['artifactHash', (p) => { p.binding.artifactHash = 'c'.repeat(64); }],
  ['authorContextHash', (p) => { p.binding.authorContextHash = 'c'.repeat(64); }],
  ['sessionId', (p) => { p.binding.sessionId = 'session-2'; }],
  ['deliberationStateId', (p) => { p.binding.deliberationStateId = 'state-2'; }],
  ['attemptId', (p) => { p.binding.attemptId = 'attempt-2'; }],
  ['decisionId', (p) => { p.binding.decisionId = 'decision-2'; }],
  ['questionId', (p) => { p.binding.questionId = 'question-2'; }],
  ['route', (p) => { p.binding.route = 'REPLICATE'; }],
  ['inputRef order', (p) => { p.binding.inputRefs.reverse(); p.sources.reverse(); }],
  ['rootCause', (p) => { p.question.rootCause = 'STABILITY_QUESTION'; }],
  ['materialityReason', (p) => { p.question.materialityReason += ' '; }],
  ['finding field', (p) => { p.sources[1].value.whyMaterial = 'Changed.'; }],
  ['issue field', (p) => { p.sources[2].value.description = 'Changed.'; }],
  ['issue findingIds order', (p) => { p.sources[2].value.findingIds.reverse(); }],
  ['author context text', (p) => { p.sources[0].value.text = 'Changed.'; }],
  ['author context status', (p) => { p.sources[0].value.status = 'RESOLVED'; }],
  ['author context category', (p) => { p.sources[0].category = 'constraints'; }],
  ['artifact offsets', (p) => { p.artifact.startChar = 5; p.artifact.endChar = 10; }],
  ['artifact text', (p) => { p.artifact.text = 'EXCER'; }],
  ['artifact presence', (p) => { delete p.artifact; }],
];
for (const [label, mutate] of MUTATIONS) {
  await check(`changing ${label} changes the fingerprint`, () => {
    const changed = parts();
    mutate(changed);
    assert.notEqual(seal(changed).contextFingerprint, seal().contextFingerprint);
  });
}

console.log('\nBudget policy');

await check('the policy must be a finite positive integer, owned and snapshotted by composition', () => {
  for (const bad of [0, -1, Number.NaN, Infinity, -Infinity, 1.5, '100', null, undefined, 2 ** 53]) {
    assert.throws(() => snapshotContextPackPolicy({ maxSerializedChars: bad }), TypeError);
  }
  for (const bad of [null, [], {}, { maxSerializedChars: 10, extra: 1 },
    Object.defineProperty({}, 'maxSerializedChars', { enumerable: true, get: () => 10 })]) {
    assert.throws(() => snapshotContextPackPolicy(bad), TypeError);
  }
  const source = { maxSerializedChars: 10 };
  const policy = snapshotContextPackPolicy(source);
  source.maxSerializedChars = 1e9;
  assert.equal(policy.maxSerializedChars, 10);
  assert.ok(Object.isFrozen(policy));
});

await check('required context exactly at the limit is accepted; one character less is refused', () => {
  const required = parts();
  delete required.artifact;
  const size = serializePayload({ schemaVersion: CONTEXT_PACK_SCHEMA_VERSION, ...required }).length;
  const pack = seal(required, snapshotContextPackPolicy({ maxSerializedChars: size }));
  assert.equal(serializePayload(pack).length, size);
  assert.throws(() => seal(required, snapshotContextPackPolicy({ maxSerializedChars: size - 1 })), ContextPackBudgetError);
});

await check('over budget never drops, shortens, or reorders a route source', () => {
  const required = parts();
  delete required.artifact;
  const size = serializePayload({ schemaVersion: CONTEXT_PACK_SCHEMA_VERSION, ...required }).length;
  let result;
  assert.throws(() => { result = seal(required, snapshotContextPackPolicy({ maxSerializedChars: size - 1 })); }, /not truncated/);
  assert.equal(result, undefined, 'no partial pack is returned');
});

await check('an excerpt must fit whole, or the build fails', () => {
  const required = parts();
  delete required.artifact;
  const requiredSize = serializePayload({ schemaVersion: CONTEXT_PACK_SCHEMA_VERSION, ...required }).length;
  const full = serializePayload({ schemaVersion: CONTEXT_PACK_SCHEMA_VERSION, ...parts() }).length;
  assert.ok(full > requiredSize);
  assert.equal(seal(parts(), snapshotContextPackPolicy({ maxSerializedChars: full })).artifact.text, 'excer');
  assert.throws(() => seal(parts(), snapshotContextPackPolicy({ maxSerializedChars: full - 1 })), /never truncated/);
});

console.log('\nCaller selection');

await check('a caller states only an attempt and optional offsets', () => {
  const selection = snapshotContextPackSelection({ attemptId: 'attempt-1', artifactSelection: { startChar: 0, endChar: 3 } });
  assert.deepEqual(selection, { attemptId: 'attempt-1', artifactSelection: { startChar: 0, endChar: 3 } });
  assert.ok(Object.isFrozen(selection) && Object.isFrozen(selection.artifactSelection));
  assert.deepEqual(snapshotContextPackSelection({ attemptId: 'attempt-1' }), { attemptId: 'attempt-1' });
});

await check('a caller cannot state canonical facts or excerpt text', () => {
  for (const extra of ['artifactHash', 'authorContextHash', 'sessionId', 'deliberationStateId', 'decisionId', 'questionId',
    'route', 'inputRefs', 'sources', 'question', 'text', 'contextFingerprint', 'capturedAt', 'policy']) {
    assert.throws(() => snapshotContextPackSelection({ attemptId: 'attempt-1', [extra]: 'x' }), TypeError, extra);
  }
  assert.throws(() => snapshotContextPackSelection({ attemptId: 'a', artifactSelection: { startChar: 0, endChar: 3, text: 'abc' } }), TypeError);
  for (const bad of [{}, { attemptId: '' }, { attemptId: '  ' }, { attemptId: 7 }, null, 'attempt-1',
    Object.defineProperty({}, 'attemptId', { enumerable: true, get: () => 'attempt-1' }),
    { attemptId: 'a', artifactSelection: { startChar: 0 } }, { attemptId: 'a', artifactSelection: { startChar: 0.5, endChar: 3 } },
    { attemptId: 'a', artifactSelection: { startChar: '0', endChar: 3 } }, { attemptId: 'a', artifactSelection: null }]) {
    assert.throws(() => snapshotContextPackSelection(bad), TypeError);
  }
});

console.log('\nSealed pack and self-integrity');

await check('a sealed pack is detached from its inputs and frozen throughout', () => {
  const input = parts();
  const pack = seal(input);
  input.sources[1].value.title = 'mutated';
  input.binding.inputRefs.pop();
  input.artifact.text = 'mutated';
  assert.equal(pack.sources[1].value.title, 'Unsupported payback');
  assert.equal(pack.binding.inputRefs.length, 3);
  assert.equal(pack.artifact.text, 'excer');
  for (const node of [pack, pack.binding, pack.binding.inputRefs, pack.binding.inputRefs[0], pack.question, pack.sources,
    pack.sources[0], pack.sources[0].value, pack.sources[2].value.findingIds, pack.artifact]) {
    assert.ok(Object.isFrozen(node));
  }
  assert.throws(() => { pack.sources[1].value.title = 'x'; }, TypeError);
  assert.throws(() => { pack.binding.inputRefs.push({}); }, TypeError);
  assert.equal(pack.schemaVersion, 'E0-R6_CONTEXT_PACK_V1');
  assert.equal(pack.artifact.selectionScope, 'EXCERPT');
});

await check('an intact pack reads back as a detached, frozen copy', () => {
  const pack = seal();
  const read = readContextPack(pack);
  assert.deepEqual(read, pack);
  assert.notEqual(read, pack);
  assert.ok(Object.isFrozen(read.sources[1].value));
  const thawed = JSON.parse(JSON.stringify(pack));
  assert.equal(readContextPack(thawed).contextFingerprint, pack.contextFingerprint);
});

await check('a changed payload with the old fingerprint is INVALID, never merely stale', () => {
  for (const [label, mutate] of MUTATIONS) {
    const tampered = JSON.parse(JSON.stringify(seal()));
    mutate(tampered);
    assert.throws(() => readContextPack(tampered), InvalidContextPackError, label);
  }
});

await check('a changed stored fingerprint is INVALID', () => {
  const tampered = JSON.parse(JSON.stringify(seal()));
  tampered.contextFingerprint = tampered.contextFingerprint.replace(/^./, (c) => (c === '0' ? '1' : '0'));
  assert.throws(() => readContextPack(tampered), /does not match its payload/);
  tampered.contextFingerprint = 'not-a-hash';
  assert.throws(() => readContextPack(tampered), InvalidContextPackError);
});

await check('a malformed pack is INVALID', () => {
  const base = () => JSON.parse(JSON.stringify(seal()));
  const cases = [
    (p) => { p.extra = 1; },
    (p) => { delete p.question; },
    (p) => { p.schemaVersion = 'E0-R6_CONTEXT_PACK_V2'; },
    (p) => { p.binding.route = 'TARGETED_PEER_CHALLENGE'; },
    (p) => { p.binding.inputRefs = []; p.sources = []; },
    (p) => { p.sources.pop(); },
    (p) => { p.sources[1].ref.id = 'finding-9'; },
    (p) => { p.sources[1].value.id = 'finding-9'; },
    (p) => { p.sources[0].category = 'everything'; },
    (p) => { delete p.sources[0].category; },
    (p) => { p.sources[1].category = 'knownRisks'; },
    (p) => { p.artifact.selectionScope = 'FULL'; },
    (p) => { p.artifact.text = 'too long for its offsets'; },
    (p) => { p.artifact.startChar = -1; },
    (p) => { p.capturedAt = 'yesterday'; },
    (p) => { p.binding.sessionId = ''; },
  ];
  for (const mutate of cases) {
    const pack = base();
    mutate(pack);
    assert.throws(() => readContextPack(pack), InvalidContextPackError, mutate.toString());
  }
  for (const bad of [null, 'pack', [], { contextFingerprint: 'x' }, { ...base(), read: () => 1 }]) {
    assert.throws(() => readContextPack(bad), InvalidContextPackError);
  }
});

await check('capturedAt is observational: changing it leaves a pack intact', () => {
  const pack = JSON.parse(JSON.stringify(seal()));
  pack.capturedAt = '1999-01-01T00:00:00.000Z';
  assert.equal(readContextPack(pack).contextFingerprint, seal().contextFingerprint);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
