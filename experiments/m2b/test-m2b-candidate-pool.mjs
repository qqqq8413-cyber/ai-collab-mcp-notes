/**
 * Freeze-integrity tests for the preregistered candidate pool of M2B-PROTOCOL-0.3.
 *
 * Everything here is deterministic and offline. What it can check is structure: that there
 * are nine tasks under the preregistered ids, in the frozen wave order, hashed, carrying no
 * hint of complexity, roster, provider or intended archetype, and reusing nothing from the
 * R1/R2/R3 history.
 *
 * What it deliberately does NOT check is whether a task will produce a conflict. That is
 * not deterministically verifiable — it is the question the acquisition run exists to
 * answer, and a test asserting it would be asserting the outcome rather than the design.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { ROLE_PROVIDER_MAP, CHIEF_PIN, ARCHETYPE_SLOTS, RESERVE_SLOTS, WAVES } from './protocol/amendment-0-3.mjs';

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS ${name}`); passed++; }
  catch (e) { console.log(`  FAIL ${name}\n      ${e.stack}`); failed++; }
}

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const POOL = join(ROOT, 'experiments/m2b/candidates-0-3');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(readFileSync(join(POOL, 'candidate-set-manifest.json'), 'utf8'));
const IDS = ['S1', 'S2', 'S3', 'E1', 'E2', 'E3', 'I1', 'I2', 'I3'];
const taskOf = (id) => readFileSync(join(POOL, id, 'task.txt'), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nPool shape');

check('exactly nine tasks exist, under exactly the preregistered ids', () => {
  const dirs = readdirSync(POOL, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  assert.deepEqual(dirs, [...IDS].sort(), 'no extra and no missing candidate directory');
  for (const id of IDS) assert.ok(existsSync(join(POOL, id, 'task.txt')), `${id}/task.txt exists`);
  assert.deepEqual(manifest.candidateIds, IDS);
});

check('the ids are exactly S1-S3 / E1-E3 / I1-I3, three per archetype', () => {
  assert.deepEqual([...ARCHETYPE_SLOTS.STRATEGY], ['S1', 'S2', 'S3']);
  assert.deepEqual([...ARCHETYPE_SLOTS.EXECUTION_CONSTRAINT], ['E1', 'E2', 'E3']);
  assert.deepEqual([...ARCHETYPE_SLOTS.EVIDENCE_INTERPRETATION], ['I1', 'I2', 'I3']);
  for (const id of IDS) {
    const expected = { S: 'STRATEGY_CONFLICT', E: 'EXECUTION_CONSTRAINT_CONFLICT', I: 'EVIDENCE_INTERPRETATION_CONFLICT' }[id[0]];
    assert.equal(manifest.archetypes[id], expected, id);
  }
  assert.deepEqual(manifest.reserveCandidates, [...RESERVE_SLOTS]);
});

check('the wave order is fixed and matches the accepted amendment', () => {
  assert.deepEqual(manifest.waveOrder, WAVES.map((w) => [...w]));
  assert.deepEqual(manifest.waveOrder, [['S1', 'E1', 'I1'], ['S2', 'E2', 'I2'], ['S3', 'E3', 'I3']]);
  assert.deepEqual(manifest.waveOrder.flat().sort(), [...IDS].sort(), 'the waves partition the pool exactly');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nFreeze integrity');

check('every task hash in the manifest recomputes from the file on disk', () => {
  for (const id of IDS) {
    assert.equal(sha256(readFileSync(join(POOL, id, 'task.txt'))), manifest.taskSha256[id], id);
    assert.equal(taskOf(id).length, manifest.taskChars[id], `${id} length`);
  }
});

check('all nine task hashes are distinct', () => {
  const hashes = IDS.map((id) => manifest.taskSha256[id]);
  assert.equal(new Set(hashes).size, 9, 'no duplicated task');
});

check('the manifest does not hash itself', () => {
  // A manifest containing its own hash cannot be verified without special-casing the field
  // that makes it circular. The freeze commit is recorded by a following commit instead.
  assert.ok(!('manifestSha256' in manifest), 'no circular self-hash');
  assert.match(manifest.freezeCommit, /PENDING|^[0-9a-f]{40}$/);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nWhat a task may not contain');

const FORBIDDEN = [
  ['provider name', /claude|gemini|openai|gpt-|sonnet|anthropic/i],
  ['model name', /claude-sonnet|gemini-3|gpt-5|-preview/i],
  ['the word deep', /\bdeep\b/i],
  ['the word specialist', /specialist/i],
  ['a roster hint in Chinese', /專家|複雜度|多位.{0,3}顧問|至少兩位/],
  ['an instruction to disagree', /分歧|衝突|不同意|對立|辯論|disagree|conflict/i],
  ['a positive or negative control identity', /negative control|對照組|控制組|負控|archetype/i],
  ['an angle instruction', /從商業與品牌|兩個角度|不同角度分析/],
];

for (const [label, pattern] of FORBIDDEN) {
  check(`no task contains ${label}`, () => {
    for (const id of IDS) {
      assert.ok(!pattern.test(taskOf(id)), `${id} matches ${pattern}`);
    }
  });
}

check('no task states the provider mapping the protocol pins', () => {
  for (const id of IDS) {
    const task = taskOf(id);
    for (const role of Object.keys(ROLE_PROVIDER_MAP)) assert.ok(!task.includes(role), `${id} names ${role}`);
    for (const pin of [...Object.values(ROLE_PROVIDER_MAP), CHIEF_PIN]) {
      assert.ok(!task.includes(pin.provider), `${id} names ${pin.provider}`);
      assert.ok(!task.includes(pin.model), `${id} names ${pin.model}`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nNo reuse of R1 / R2 / R3 material');

const HISTORICAL = [
  ...['fx-01', 'fx-02', 'fx-03', 'fx-04'].map((i) => join(ROOT, 'experiments/m2b/fixtures', i, 'task.txt')),
  ...['r2-01', 'r2-02', 'r2-03', 'r2-04'].map((i) => join(ROOT, 'experiments/m2b/candidates-r2', i, 'task.txt')),
  ...['fxr-09', 'fxr-10', 'fxr-11'].map((i) => join(ROOT, 'experiments/m2b/fixtures-real-r3', i, 'task.txt')),
].filter(existsSync);

check('the historical tasks are all present to compare against', () => {
  assert.equal(HISTORICAL.length, 11, 'R1 four, R2 four, R3 three');
});

check('no new task duplicates a historical task', () => {
  const old = new Set(HISTORICAL.map((p) => sha256(readFileSync(p))));
  for (const id of IDS) assert.ok(!old.has(manifest.taskSha256[id]), `${id} reuses a historical task`);
});

check('no new task shares a sixty-character run with any historical task', () => {
  // Hash inequality alone would not catch a lightly edited copy.
  const old = HISTORICAL.map((p) => readFileSync(p, 'utf8'));
  for (const id of IDS) {
    const task = taskOf(id);
    for (let i = 0; i + 60 <= task.length; i += 1) {
      const run = task.slice(i, i + 60);
      for (const o of old) assert.ok(!o.includes(run), `${id} reuses text: ${run}`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nStructural review record');

check('every candidate has a complete structural review entry', () => {
  for (const id of IDS) {
    const r = manifest.structuralReview[id];
    assert.ok(r, `${id} reviewed`);
    for (const field of ['domain', 'horizon', 'irreversible', 'credibleA', 'credibleB', 'credibleC', 'dominantRisk']) {
      assert.ok(typeof r[field] === 'string' && r[field].length > 10, `${id}.${field}`);
    }
    assert.equal(r.F5_selfContained, true);
    assert.equal(r.F6_noLiveWeb, true);
    assert.equal(r.F7_nonArithmeticHeavy, true);
  }
});

check('the nine candidates use nine distinct domains', () => {
  const domains = IDS.map((id) => manifest.structuralReview[id].domain);
  assert.equal(new Set(domains).size, 9, `domains repeat: ${domains.join(' | ')}`);
});

check('the review records no expected answer, disagreement or provider', () => {
  // A structural review that recorded an expected outcome would be a gold answer written
  // before the evidence, which is the thing the clean-room annotator exists to prevent.
  const text = JSON.stringify(manifest.structuralReview);
  for (const forbidden of ['expectedAnswer', 'goldAnswer', 'expectedDisagreement', 'expectedProvider', 'expectedTarget', 'correctOption']) {
    assert.ok(!text.includes(forbidden), `review must not carry ${forbidden}`);
  }
  for (const pattern of [/claude|gemini|openai|gpt-5|sonnet/i, /正確答案|應選|預期分歧|預期會選/]) {
    assert.ok(!pattern.test(text), `review matches ${pattern}`);
  }
  assert.deepEqual(manifest.notRecorded, [
    'expected correct answer', 'expected specialist disagreement',
    'expected provider choice', 'expected target provider', 'expected Gate target',
  ]);
});

check('provider coverage is recorded as not having driven selection', () => {
  assert.equal(manifest.noProviderCoverageSelection, true);
  assert.equal(manifest.formalF4Author, 'fresh-clean-room-A2');
  assert.ok(manifest.selectionRationaleExclusions.some((r) => /market_researcher was not targeted/.test(r)));
  const rationale = JSON.stringify(manifest.structuralReview) + manifest.designNote;
  for (const pattern of [/coverage/i, /provider diversity/i, /rotation/i]) {
    assert.ok(!pattern.test(rationale), `selection rationale must not invoke ${pattern}`);
  }
});

check('the manifest references the provider mapping rather than restating it', () => {
  assert.match(manifest.providerMappingReference.source, /amendment-0-3\.mjs/);
  const text = JSON.stringify(manifest.providerMappingReference);
  for (const pin of Object.values(ROLE_PROVIDER_MAP)) {
    assert.ok(!text.includes(pin.model), 'the mapping is referenced, not duplicated');
  }
});

check('the one-attempt rule and protocol version are recorded', () => {
  assert.equal(manifest.protocolVersion, 'M2B-PROTOCOL-0.3');
  assert.match(manifest.oneAttemptRule, /exactly one Round 1 attempt/);
  assert.match(manifest.oneAttemptRule, /never rewritten, replaced or re-run/);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\nHistorical artifacts untouched');

check('fxr-08 is byte-unchanged against its committed manifest', () => {
  const dir = join(ROOT, 'experiments/m2b/fixtures-real-r2/fxr-08');
  const m = JSON.parse(readFileSync(join(dir, 'capture-manifest.json'), 'utf8'));
  for (const [file, expected] of Object.entries(m.fileHashes)) {
    assert.equal(sha256(readFileSync(join(dir, file))), expected, `fxr-08/${file}`);
  }
  const { manifestSha256, ...rest } = m;
  assert.equal(sha256(JSON.stringify(rest, null, 2)), manifestSha256, 'fxr-08 manifest seal');
});

check('no candidate pool file was written into an R1, R2 or R3 directory', () => {
  for (const historical of ['fixtures', 'fixtures-real', 'candidates-r2', 'fixtures-real-r2', 'fixtures-real-r3']) {
    const dir = join(ROOT, 'experiments/m2b', historical);
    if (!existsSync(dir)) continue;
    const names = readdirSync(dir);
    for (const id of IDS) assert.ok(!names.includes(id), `${id} must not appear under ${historical}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
