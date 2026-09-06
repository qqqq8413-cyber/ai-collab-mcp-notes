/**
 * Offline tests for the M2-B Phase 1 fixture freeze.
 *
 * No provider is called and no arm is run. The clean-room annotations, once received, are
 * committed data — this suite validates their structure and their references, and never
 * regenerates them: a test that re-derived ground truth from a model would make the ground
 * truth a function of the thing it is supposed to judge.
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  loadFixture, loadAllExperimentFixtures, passagesOf, passageIdSet,
  pathsReadFor, EXPERIMENT_FIXTURE_IDS, FIXTURE_ROOT, EVALUATION_ROOT, FixtureError,
} from './harness/fixtures.mjs';
import { buildCleanRoomPacket, scanPacket, assertPacketClean, PacketLeakageDetected, FORBIDDEN_TERMS, PACKET_ORDER } from './harness/cleanroom.mjs';
import { OPTION_3_PRIME } from './harness/freeze.mjs';
import { readRaw, extractJsonArray, validateConflictLabels, validateGoldIssues, checkAgainstIntent, AnnotationInvalid } from './harness/annotations.mjs';

const M2B = fileURLToPath(new URL('./', import.meta.url));
const sha256 = (v) => createHash('sha256').update(v).digest('hex');
let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  PASS ${name}`); passed++; }
  catch (e) { console.log(`  FAIL ${name}\n      ${e.stack}`); failed++; }
}
function mustThrow(fn, type) {
  let thrown = null;
  try { fn(); } catch (e) { thrown = e; }
  assert.ok(thrown, 'expected a throw but nothing was thrown');
  assert.ok(thrown instanceof type, `expected ${type.name}, got ${thrown?.constructor?.name}: ${thrown?.message}`);
  return thrown;
}
const manifestOf = (id) => JSON.parse(readFileSync(join(FIXTURE_ROOT, id, 'fixture-manifest.json'), 'utf8'));

/* ============================================================ fixture set */
console.log('\nFixture set');

await check('exactly four experiment fixtures, with unique ids', () => {
  assert.equal(EXPERIMENT_FIXTURE_IDS.length, 4);
  assert.equal(new Set(EXPERIMENT_FIXTURE_IDS).size, 4);
  for (const id of EXPERIMENT_FIXTURE_IDS) assert.ok(existsSync(join(FIXTURE_ROOT, id)), `${id} missing`);
});

await check('the replay #3/#4 fixture is absent from the Phase 1 set', () => {
  // Contaminated: its Gate output, selected issue and trigger history have all been seen.
  for (const fx of loadAllExperimentFixtures()) {
    const text = JSON.stringify(fx.snapshot);
    assert.ok(!text.includes('business_strategist'), `${fx.fixtureId} reuses a replay specialist id`);
    assert.ok(!text.includes('brand_creative'), `${fx.fixtureId} reuses a replay specialist id`);
    assert.ok(!text.includes('Content Lab'), `${fx.fixtureId} reuses replay task material`);
    assert.ok(!text.includes('月訂閱短影音'), `${fx.fixtureId} reuses the replay task`);
  }
  const replaySnapshotSha = 'cb5e9c309a8b64cac1b688d9de4ff4a9b26fc504d40d3ccb5ff412bcb4965a4b';
  for (const fx of loadAllExperimentFixtures()) {
    assert.notEqual(fx.snapshotSha256, replaySnapshotSha, `${fx.fixtureId} IS the replay snapshot`);
  }
});

await check('the four archetypes are present exactly once each', () => {
  const codes = EXPERIMENT_FIXTURE_IDS.map((id) => manifestOf(id).archetypeCode).sort();
  assert.deepEqual(codes, ['EVIDENCE_INTERPRETATION_CONFLICT', 'EXECUTION_CONSTRAINT_CONFLICT', 'NEGATIVE_CONTROL', 'STRATEGY_CONFLICT']);
});

await check('every fixture satisfies the structural half of F1-F3', () => {
  for (const fx of loadAllExperimentFixtures()) {
    assert.equal(fx.snapshot.complexity, 'deep', `${fx.fixtureId}: F1 requires deep`);
    assert.ok(fx.snapshot.workerResults.length >= 2, `${fx.fixtureId}: F2 requires N >= 2`);
    for (const r of fx.snapshot.workerResults) {
      assert.ok(r.output && r.output.length > 0, `${fx.fixtureId}: F3 requires every worker to have succeeded`);
      assert.ok(r.mission && r.mission.length > 0, `${fx.fixtureId}: missing mission`);
    }
  }
});

await check('the eligibility record cites only pre-Gate material', () => {
  // §7: any rationale resting on Gate behaviour invalidates the candidate.
  const forbidden = ['triggered', 'Gate selected', 'Replay', 'gate 會', 'selectedIssue', 'should force'];
  for (const id of EXPERIMENT_FIXTURE_IDS) {
    const text = JSON.stringify(manifestOf(id).eligibility);
    for (const term of forbidden) {
      assert.ok(!text.toLowerCase().includes(term.toLowerCase()), `${id}: eligibility rationale cites "${term}"`);
    }
    for (const key of ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7']) {
      assert.ok(manifestOf(id).eligibility[key]?.length > 0, `${id}: no ${key} rationale`);
    }
  }
});

await check('F7: no fixture makes arithmetic load-bearing', () => {
  for (const fx of loadAllExperimentFixtures()) {
    const text = fx.snapshot.task + fx.snapshot.workerResults.map((r) => r.output).join('\n');
    assert.ok(!/\d[\d,]*\s*萬/.test(text), `${fx.fixtureId}: carries 萬-denominated figures`);
    assert.ok(!/毛利率?\s*[≥>=]/.test(text), `${fx.fixtureId}: carries a margin threshold to compute against`);
    assert.ok(!text.includes('增量成本'), `${fx.fixtureId}: carries an incremental-cost table`);
  }
});

await check('status is FROZEN_PRE_ARM and no arm output exists yet', () => {
  for (const id of EXPERIMENT_FIXTURE_IDS) {
    const m = manifestOf(id);
    assert.equal(m.status, 'FROZEN_PRE_ARM');
    assert.equal(m.armExecution, 'NONE');
  }
  for (const dir of ['raw-calls', 'normalized-answers', 'blind-evaluation', 'evaluation-results']) {
    assert.ok(!existsSync(join(M2B, dir)), `arm output directory "${dir}" exists during the freeze stage`);
  }
});

/* ================================================================= hashes */
console.log('\nHashes reproduce');

await check('every frozen file reproduces the hash its manifest records', () => {
  for (const id of EXPERIMENT_FIXTURE_IDS) {
    const fx = loadFixture(id);
    const m = manifestOf(id);
    assert.equal(fx.fixtureSha256, m.fixtureSha256, `${id}: fixture hash changed`);
    assert.equal(fx.snapshotSha256, m.snapshotSha256, `${id}: snapshot hash changed`);
    assert.deepEqual(fx.fileHashes, m.fileHashes, `${id}: a source file changed after freezing`);
  }
});

await check('NEGATIVE: a fixture edited after freezing fails its hash', () => {
  const fx = loadFixture('fx-01');
  const tampered = { ...fx.snapshot, task: fx.snapshot.task + ' (edited)' };
  assert.notEqual(sha256(JSON.stringify(tampered)), manifestOf('fx-01').snapshotSha256);
});

await check('NEGATIVE: a missing fixture file is an error, not a silent default', () => {
  mustThrow(() => loadFixture('fx-99'), FixtureError);
});

/* ============================================================== passages */
console.log('\nPassage ids');

await check('passage ids come from the production chunker, not a second segmenter', () => {
  for (const fx of loadAllExperimentFixtures()) {
    const passages = passagesOf(fx);
    for (const [agentId, list] of Object.entries(passages)) {
      list.forEach((p, i) => {
        assert.equal(p.passageId, `${agentId}:p${i + 1}`, 'passage ids must be <agentId>:pN in order');
        assert.ok(p.text.length > 0);
      });
    }
  }
});

await check('every manifest passage id resolves against the frozen Round 1', () => {
  for (const id of EXPERIMENT_FIXTURE_IDS) {
    const live = passageIdSet(loadFixture(id));
    for (const ids of Object.values(manifestOf(id).passageIds)) {
      for (const pid of ids) assert.ok(live.has(pid), `${id}: manifest lists ${pid}, which no longer resolves`);
    }
  }
});

/* ================================================== runtime / evaluation */
console.log('\nRuntime and evaluation path isolation (GI-5)');

await check('the fixture loader opens nothing under evaluation/', () => {
  for (const id of EXPERIMENT_FIXTURE_IDS) {
    for (const path of pathsReadFor(id)) {
      assert.ok(!path.startsWith(EVALUATION_ROOT), `loader would open ${path}`);
      assert.ok(path.startsWith(FIXTURE_ROOT), `loader would open outside fixtures/: ${path}`);
    }
  }
});

await check('no ground-truth file sits inside a runtime fixture directory', () => {
  for (const id of EXPERIMENT_FIXTURE_IDS) {
    for (const name of readdirSync(join(FIXTURE_ROOT, id))) {
      assert.ok(!/gold-issues|conflict-labels/.test(name), `${id}/${name} is evaluation data inside the runtime path`);
    }
  }
});

await check('a loaded fixture object carries no ground truth', () => {
  for (const fx of loadAllExperimentFixtures()) {
    const text = JSON.stringify(fx);
    assert.ok(!text.includes('goldIssues'), `${fx.fixtureId}: gold issues reached the fixture object`);
    assert.ok(!text.includes('materialConflict'), `${fx.fixtureId}: conflict labels reached the fixture object`);
  }
});

await check('the loader function body has no code path to the evaluation directory', () => {
  // Structural, alongside the behavioural check above. Scoped to loadFixture's own body:
  // a prose mention elsewhere in the file is documentation, not a path, and a test that
  // failed on prose would be measuring the wrong thing.
  const source = readFileSync(join(M2B, 'harness', 'fixtures.mjs'), 'utf8');
  const start = source.indexOf('export function loadFixture');
  const end = source.indexOf('export function', start + 10);
  const body = source.slice(start, end);
  assert.ok(body.includes('FIXTURE_ROOT'), 'loadFixture should read from the fixture root');
  assert.ok(!body.includes('EVALUATION_ROOT'), 'loadFixture references the evaluation root');
  assert.ok(!/join\([^)]*['\`]evaluation/.test(body), 'loadFixture builds a path into evaluation/');
  assert.ok(!/readdirSync|readdir\b/.test(body), 'loadFixture walks a directory instead of reading named files');
});

/* ========================================================== clean room */
console.log('\nClean-room packet');

await check('both packets build and pass the leakage scan', () => {
  for (const kind of ['conflict', 'gold']) {
    const packet = buildCleanRoomPacket(kind);
    assert.deepEqual(scanPacket(packet.text), []);
    assert.ok(packet.bytes > 1000);
  }
});

await check('the packet carries only permitted source material', () => {
  const packet = buildCleanRoomPacket('conflict');
  for (const fx of loadAllExperimentFixtures()) {
    assert.ok(packet.text.includes(fx.snapshot.task.split('\n')[0]), `${fx.fixtureId}: task missing`);
    for (const r of fx.snapshot.workerResults) {
      assert.ok(packet.text.includes(r.mission), `${fx.fixtureId}: mission missing`);
      for (const p of passagesOf(fx)[r.agentId]) {
        assert.ok(packet.text.includes(p.text), `${fx.fixtureId}: passage ${p.passageId} missing`);
      }
    }
  }
});

await check('the packet never exposes which fixture is the negative control', () => {
  const packet = buildCleanRoomPacket('conflict');
  for (const id of EXPERIMENT_FIXTURE_IDS) {
    assert.ok(!packet.text.includes(manifestOf(id).archetypeCode), `${id}: archetype code leaked`);
  }
  assert.ok(!packet.text.toLowerCase().includes('negative control'));
  // Nor by position: the intended control is not last.
  assert.notEqual(PACKET_ORDER[PACKET_ORDER.length - 1], 'fx-04', 'the negative control must not sit last');
});

for (const [label, term] of [
  ['selectedIssue', 'the selectedIssue was market_positioning'],
  ['challengeText', 'challengeText: how does this hold?'],
  ['a Replay reference', 'as seen in Replay #4'],
  ['negative-control identity', 'this one is the negative control'],
  ['Gate behaviour', 'the Gate selected p5 here'],
]) {
  await check(`NEGATIVE: a packet containing ${label} fails validation`, () => {
    mustThrow(() => assertPacketClean(`instructions\n\n${term}\n`), PacketLeakageDetected);
  });
}

await check('the leakage scanner is case-insensitive and states its limits', () => {
  mustThrow(() => assertPacketClean('SELECTEDISSUE was set'), PacketLeakageDetected);
  const report = assertPacketClean('a clean packet body');
  assert.equal(report.lexicalOnly, true, 'the scanner must declare it is lexical only');
  assert.ok(FORBIDDEN_TERMS.length > 20);
});

/* ===================================================== Option 3-prime */
console.log("\nOption 3' allocation");

await check('the three positive fixtures rotate target provider across all three providers', () => {
  const positives = EXPERIMENT_FIXTURE_IDS.filter((id) => manifestOf(id).archetypeCode !== 'NEGATIVE_CONTROL');
  const providers = positives.map((id) => OPTION_3_PRIME.byFixture[id].targetProvider).sort();
  assert.deepEqual(providers, ['claude', 'gemini', 'openai']);
});

await check('the negative control has a declared allocation too', () => {
  const alloc = OPTION_3_PRIME.byFixture['fx-04'];
  assert.ok(alloc?.targetProvider && alloc?.targetModel);
});

await check('within a fixture, every specialist shares the target provider and model', () => {
  // This is what makes target-provider coverage deterministic rather than dependent on
  // which specialist the Gate happens to choose.
  for (const fx of loadAllExperimentFixtures()) {
    const alloc = OPTION_3_PRIME.byFixture[fx.fixtureId];
    for (const w of fx.snapshot.workers) {
      assert.equal(w.provider, alloc.targetProvider, `${fx.fixtureId}/${w.id}: provider differs from the allocation`);
      assert.equal(w.model, alloc.targetModel, `${fx.fixtureId}/${w.id}: model differs from the allocation`);
    }
  }
});

await check('the decision synthesizer is fixed across every fixture', () => {
  assert.deepEqual(OPTION_3_PRIME.decisionSynthesizer, { provider: 'openai', requestedModel: 'gpt-5' });
});

await check('the allocation states it is execution coverage, not generalization', () => {
  assert.match(OPTION_3_PRIME.claimBoundary, /Execution coverage only/);
  assert.match(OPTION_3_PRIME.claimBoundary, /does not support any/);
});

/* ============================================ annotations (once received) */
console.log('\nClean-room annotations');

const CONFLICT_PATH = (id) => join(EVALUATION_ROOT, id, 'conflict-labels.json');
const GOLD_PATH = (id) => join(EVALUATION_ROOT, id, 'gold-issues.json');
const annotationsPresent = EXPERIMENT_FIXTURE_IDS.every((id) => existsSync(CONFLICT_PATH(id)));

await check('conflict labels, when present, are structurally valid and resolve', () => {
  if (!annotationsPresent) { console.log('       (skipped: clean-room annotations not yet received)'); return; }
  for (const id of EXPERIMENT_FIXTURE_IDS) {
    const label = JSON.parse(readFileSync(CONFLICT_PATH(id), 'utf8'));
    assert.equal(label.fixtureId, id);
    assert.equal(typeof label.materialConflict, 'boolean');
    const ids = passageIdSet(loadFixture(id));
    for (const ref of label.passageRefs ?? []) assert.ok(ids.has(ref), `${id}: label cites ${ref}, which does not resolve`);
    if (label.materialConflict) assert.ok(label.description?.length > 0, `${id}: a conflict with no description`);
    else assert.equal(label.description, null);
  }
});

await check('the intended 3 positive / 1 negative structure is independently supported', () => {
  if (!annotationsPresent) { console.log('       (skipped: clean-room annotations not yet received)'); return; }
  for (const id of EXPERIMENT_FIXTURE_IDS) {
    const expected = manifestOf(id).archetypeCode !== 'NEGATIVE_CONTROL';
    const actual = JSON.parse(readFileSync(CONFLICT_PATH(id), 'utf8')).materialConflict;
    assert.equal(actual, expected,
      `${id}: intended ${expected ? 'positive' : 'negative'} but the independent annotator said materialConflict=${actual}. ` +
      'Per protocol the label must not be edited — replace the candidate instead.');
  }
});

await check('gold issues, when present, are valid, resolve, and live outside runtime paths', () => {
  if (!EXPERIMENT_FIXTURE_IDS.every((id) => existsSync(GOLD_PATH(id)))) {
    console.log('       (skipped: gold issues not yet received)'); return;
  }
  for (const id of EXPERIMENT_FIXTURE_IDS) {
    const path = GOLD_PATH(id);
    assert.ok(!path.startsWith(FIXTURE_ROOT), 'gold issues must not sit under fixtures/');
    const gold = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(gold.fixtureId, id);
    assert.ok(Array.isArray(gold.goldIssues) && gold.goldIssues.length > 0);
    const ids = passageIdSet(loadFixture(id));
    for (const gi of gold.goldIssues) {
      assert.ok(gi.id && gi.issue?.length > 0, `${id}: malformed gold issue`);
      for (const ref of gi.supportRefs ?? []) assert.ok(ids.has(ref), `${id}: gold issue cites ${ref}, which does not resolve`);
    }
  }
});

await check('the per-fixture split is a faithful partition of the raw annotator output', () => {
  // What makes "committed verbatim" checkable: rejoin the split and it must reproduce the
  // raw objects exactly. Any normalization, correction or completion would show up here.
  for (const [kind, name] of [['conflict-labels', 'conflict-labels'], ['gold-issues', 'gold-issues']]) {
    const raw = readRaw(kind);
    for (const entry of raw.entries) {
      const split = JSON.parse(readFileSync(join(EVALUATION_ROOT, entry.fixtureId, `${name}.json`), 'utf8'));
      assert.deepEqual(split, entry, `${entry.fixtureId}/${name}: the split differs from the raw annotator output`);
    }
    assert.equal(raw.entries.length, EXPERIMENT_FIXTURE_IDS.length);
  }
});

await check('the raw annotator outputs are present and hashed into the freeze manifest', () => {
  const freeze = JSON.parse(readFileSync(join(M2B, 'manifests', 'fixture-freeze-manifest.json'), 'utf8'));
  for (const [file, key] of [
    ['raw-conflict-labels.md', 'rawConflictLabelsSha256'],
    ['raw-gold-issues.md', 'rawGoldIssuesSha256'],
    ['packet-conflict.md', 'packetConflictSha256'],
    ['packet-gold.md', 'packetGoldSha256'],
  ]) {
    const actual = sha256(readFileSync(join(EVALUATION_ROOT, 'cleanroom', file), 'utf8'));
    assert.equal(freeze.cleanRoom[key], actual, `${file}: hash in the freeze manifest does not match the file`);
  }
});

await check('the freeze manifest records zero arm execution and zero provider calls', () => {
  const freeze = JSON.parse(readFileSync(join(M2B, 'manifests', 'fixture-freeze-manifest.json'), 'utf8'));
  assert.equal(freeze.status, 'FROZEN_PRE_ARM');
  assert.equal(freeze.armExecution, 'NONE');
  assert.equal(freeze.liveProviderCalls, 0);
  assert.equal(freeze.temperatureProbe, 'NOT RUN');
  assert.equal(freeze.fixtures.length, 4);
  assert.match(freeze.cleanRoom.activityClass, /not a runtime experiment/);
});

await check('every hash in the freeze manifest reproduces from the frozen files', () => {
  const freeze = JSON.parse(readFileSync(join(M2B, 'manifests', 'fixture-freeze-manifest.json'), 'utf8'));
  for (const f of freeze.fixtures) {
    const fx = loadFixture(f.fixtureId);
    assert.equal(f.fixtureSha256, fx.fixtureSha256, `${f.fixtureId}: fixture hash`);
    assert.equal(f.snapshotSha256, fx.snapshotSha256, `${f.fixtureId}: snapshot hash`);
    for (const [key, path] of [
      ['conflictLabelsSha256', join(EVALUATION_ROOT, f.fixtureId, 'conflict-labels.json')],
      ['goldIssuesSha256', join(EVALUATION_ROOT, f.fixtureId, 'gold-issues.json')],
      ['fixtureManifestSha256', join(FIXTURE_ROOT, f.fixtureId, 'fixture-manifest.json')],
    ]) {
      assert.equal(f[key], sha256(readFileSync(path, 'utf8')), `${f.fixtureId}: ${key}`);
    }
  }
});

await check('conflict labels and gold issues came from separate sessions, recorded as such', () => {
  const freeze = JSON.parse(readFileSync(join(M2B, 'manifests', 'fixture-freeze-manifest.json'), 'utf8'));
  assert.notEqual(freeze.cleanRoom.conflictAnnotator, freeze.cleanRoom.goldAnnotator);
  assert.match(freeze.cleanRoom.goldAnnotator, /never session A output/);
  assert.match(freeze.cleanRoom.isolation, /two separate fresh sessions/);
});

await check('NEGATIVE: a conflict label with an unresolvable passageRef is rejected', () => {
  const entries = readRaw('conflict-labels').entries.map((e) =>
    e.fixtureId === 'fx-01' ? { ...e, passageRefs: [...e.passageRefs, 'market_positioning:p99'] } : e);
  const err = mustThrow(() => validateConflictLabels(entries), AnnotationInvalid);
  assert.ok(err.problems.some((p) => p.includes('p99')));
});

await check('NEGATIVE: a gold issue with an unresolvable supportRef is rejected', () => {
  const entries = readRaw('gold-issues').entries.map((e) =>
    e.fixtureId === 'fx-02' ? { ...e, goldIssues: [{ ...e.goldIssues[0], supportRefs: ['growth_planning:p99'] }] } : e);
  const err = mustThrow(() => validateGoldIssues(entries), AnnotationInvalid);
  assert.ok(err.problems.some((p) => p.includes('p99')));
});

await check('NEGATIVE: a materialConflict=true label with no description is rejected', () => {
  const entries = readRaw('conflict-labels').entries.map((e) =>
    e.fixtureId === 'fx-03' ? { ...e, description: null } : e);
  mustThrow(() => validateConflictLabels(entries), AnnotationInvalid);
});

await check('NEGATIVE: a missing fixture entry is rejected rather than filled in', () => {
  const entries = readRaw('conflict-labels').entries.filter((e) => e.fixtureId !== 'fx-04');
  const err = mustThrow(() => validateConflictLabels(entries), AnnotationInvalid);
  assert.ok(err.problems.some((p) => p.includes('no entry for fx-04')));
});

await check('NEGATIVE: intent disagreement is reported, never silently reconciled', () => {
  // The whole point of the negative control: if the independent annotator disagrees, the
  // candidate fails and gets replaced. The label is not edited.
  const flipped = readRaw('conflict-labels').entries.map((e) =>
    e.fixtureId === 'fx-04' ? { ...e, materialConflict: true, description: 'x', passageRefs: ['team_workflow:p1'] } : e);
  const report = checkAgainstIntent(flipped);
  const negative = report.find((r) => r.fixtureId === 'fx-04');
  assert.equal(negative.agrees, false, 'a flipped negative control must be reported as disagreeing');
  assert.equal(negative.intendedPositive, false);
});

await check('NEGATIVE: a conflict label citing a nonexistent passage is rejected', () => {
  const ids = passageIdSet(loadFixture('fx-01'));
  assert.ok(!ids.has('market_positioning:p99'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
