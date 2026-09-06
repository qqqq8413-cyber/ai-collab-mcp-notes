/**
 * Offline acceptance tests for the protocol 0.3 A2 acquisition path.
 *
 * Provider-free by construction: nothing here dispatches a call, and the captures the
 * builder reads are either committed historical artifacts or stub directories written to
 * a temp dir in the shape a real capture seals.
 *
 * The tests that matter most are the ones about what A2 cannot see and about ordering.
 * Both are rules that would be worthless if they were decided after Wave 1 output existed,
 * so both are asserted here, before it does.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { segmentAll } from '../../dist/agents/collaboration.js';
import {
  A2_SESSION_ID, ORDERING_RULE, CONFLICT_ARCHETYPES, NEGATIVE_CONTROL_FIXTURE_ID,
  NEGATIVE_CONTROL_CAPTURE_DIR, NO_A2_BATCH, A2_BATCH, NO_F4_ELIGIBLE_CANDIDATES,
  STOP_REQUIRED, NEGATIVE_CONTROL_UNEXPECTED_TRUE, A2LeakageDetected, A2CaptureError,
  A2_INSTRUCTIONS, CASE_PAYLOAD_FORBIDDEN_TERMS,
  loadRealCapture, isAdmissible, passagesForCapture, passageIdsForCapture, orderCases,
  caseIdFor, scanCasePayload, scanInternalIdentities, assertA2PacketClean,
  negativeControlAlreadyUsed, buildA2AcquisitionBatch, validateAnnotation,
  validateAnnotationSet, assessNegativeControl, preregisteredArchetypeOf,
  resolveSlotFills, resolveAnnotations, verifyProvenance,
} from './harness/a2-acquisition.mjs';
import { PACKET_ORDER, buildCleanRoomPacket, FORBIDDEN_TERMS } from './harness/cleanroom.mjs';
import { ARCHETYPE_SLOTS, PROTOCOL_VERSION } from './protocol/amendment-0-3.mjs';

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  PASS ${name}`); passed++; }
  catch (e) { console.log(`  FAIL ${name}\n      ${e.stack}`); failed++; }
}
async function mustReject(fn, hint) {
  let thrown = null;
  try { await fn(); } catch (e) { thrown = e; }
  assert.ok(thrown, `expected a rejection (${hint}) but none happened`);
  return thrown;
}

const sha256 = (v) => createHash('sha256').update(v).digest('hex');
const canonical = (v) => JSON.stringify(v, null, 2);
const SCRATCH = mkdtempSync(join(tmpdir(), 'm2b-a2-'));
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const BASE_SHA = '5d92a34333dab522885ef88a48889680079f6594';

/**
 * Writes a capture directory in the shape `sealManifest` produces.
 *
 * Stub text only. The point of these is the harness's behaviour around a capture, never
 * the capture's content — the real artifacts are exercised through fxr-08 below.
 */
function makeCapture(dir, {
  fixtureId, task, workers, complexity = 'deep', reportStatus = 'SUCCESS', requested = null,
}) {
  mkdirSync(dir, { recursive: true });
  const workerResults = workers.map((w) => ({ agentId: w.agentId, provider: 'stub', mission: w.mission, output: w.output }));
  const snapshot = {
    task: task.trim(),
    complexity,
    agentOrder: workers.map((w) => w.agentId),
    workers: workers.map((w) => ({ id: w.agentId, provider: 'stub', model: 'stub', role: 'stub role', evidenceCapable: false })),
    workerResults,
  };
  const report = {
    status: reportStatus,
    requestedWorkers: requested ?? workers.length,
    successfulWorkers: workers.length,
    failedWorkers: 0,
    failures: [],
  };

  const files = { 'task.txt': task, 'snapshot.json': canonical(snapshot), 'report.json': canonical(report) };
  for (const w of workers) {
    files[`mission-${w.agentId}.txt`] = w.mission;
    files[`round1-${w.agentId}.md`] = w.output;
  }
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);

  const rest = {
    fixtureId,
    captureVersion: 'M2B-REAL-ROUND1-CAPTURE-2',
    protocolVersion: PROTOCOL_VERSION,
    taskSha256: sha256(task),
    captureStatus: 'CAPTURED',
    eligibility: { F1: complexity === 'deep', F2: workers.length >= 2, F3: reportStatus === 'SUCCESS' },
    agentOrder: workers.map((w) => w.agentId),
    fileHashes: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, sha256(v)])),
  };
  writeFileSync(join(dir, 'capture-manifest.json'), canonical({ ...rest, manifestSha256: sha256(canonical(rest)) }));
  return dir;
}

const body = (label, n) => Array.from({ length: n }, (_, i) => `${label} 第 ${i + 1} 段的完整意見內容，足夠長以構成一個獨立段落。`).join('\n\n');

/** Three admissible P03-shaped captures, one per archetype slot. */
function makeWaveOne(root, { suffix = '' } = {}) {
  return {
    S1: makeCapture(join(root, `s1${suffix}`), {
      fixtureId: 'S1',
      task: `一家專業影像後製軟體公司要決定下一版的方向。${suffix}`,
      workers: [
        { agentId: 'business_strategist', mission: '評估商業風險與可行性', output: body('策略', 3) },
        { agentId: 'brand_creative', mission: '評估品牌與市場定位', output: body('品牌', 2) },
      ],
    }),
    E1: makeCapture(join(root, `e1${suffix}`), {
      fixtureId: 'E1',
      task: `一家獨立遊戲工作室要決定發行排程。${suffix}`,
      workers: [
        { agentId: 'business_strategist', mission: '評估產能與時程限制', output: body('產能', 3) },
        { agentId: 'market_researcher', mission: '評估市場時機', output: body('市場', 2) },
      ],
    }),
    I1: makeCapture(join(root, `i1${suffix}`), {
      fixtureId: 'I1',
      task: `一家線上語言學習公司要判讀一份留存率數據。${suffix}`,
      workers: [
        { agentId: 'market_researcher', mission: '解讀數據', output: body('數據', 3) },
        { agentId: 'brand_creative', mission: '解讀使用者訊號', output: body('訊號', 2) },
      ],
    }),
  };
}

const WAVE1 = makeWaveOne(join(SCRATCH, 'wave1'));

console.log('\nAdmission (D-2)');

await check('eligibility is recomputed from artifacts, not read from the status fields', () => {
  const capture = loadRealCapture(WAVE1.S1);
  assert.deepEqual(capture.eligibility, { F1: true, F2: true, F3: true });
  assert.ok(isAdmissible(capture));
  const source = readFileSync(fileURLToPath(new URL('./harness/a2-acquisition.mjs', import.meta.url)), 'utf8');
  const admissionBlock = source.slice(source.indexOf('const eligibility ='), source.indexOf('admitted: eligibility'));
  assert.ok(!admissionBlock.includes('manifest.eligibility'), 'admission must not read the manifest eligibility field');
  assert.ok(!admissionBlock.includes('captureStatus'), 'admission must not read captureStatus');
});

await check('F1 failure is refused admission', () => {
  const dir = makeCapture(join(SCRATCH, 'f1-fail'), {
    fixtureId: 'S2', task: '任務內容', complexity: 'normal',
    workers: [
      { agentId: 'business_strategist', mission: 'm', output: body('a', 2) },
      { agentId: 'brand_creative', mission: 'm', output: body('b', 2) },
    ],
  });
  const capture = loadRealCapture(dir);
  assert.equal(capture.eligibility.F1, false);
  assert.equal(isAdmissible(capture), false);
});

await check('F2 failure is refused admission', () => {
  const dir = makeCapture(join(SCRATCH, 'f2-fail'), {
    fixtureId: 'E2', task: '任務內容', requested: 2,
    workers: [{ agentId: 'business_strategist', mission: 'm', output: body('a', 2) }],
  });
  const capture = loadRealCapture(dir);
  assert.equal(capture.eligibility.F2, false);
  assert.equal(isAdmissible(capture), false);
});

await check('F3 failure is refused admission', () => {
  const dir = makeCapture(join(SCRATCH, 'f3-fail'), {
    fixtureId: 'I2', task: '任務內容', reportStatus: 'DEGRADED',
    workers: [
      { agentId: 'business_strategist', mission: 'm', output: body('a', 2) },
      { agentId: 'brand_creative', mission: 'm', output: body('b', 2) },
    ],
  });
  const capture = loadRealCapture(dir);
  assert.equal(capture.eligibility.F3, false);
  assert.equal(isAdmissible(capture), false);
});

await check('NEGATIVE: a capture whose round1 bytes were edited after sealing is rejected', () => {
  const dir = makeCapture(join(SCRATCH, 'tampered'), {
    fixtureId: 'S3', task: '任務內容',
    workers: [
      { agentId: 'business_strategist', mission: 'm', output: body('a', 2) },
      { agentId: 'brand_creative', mission: 'm', output: body('b', 2) },
    ],
  });
  writeFileSync(join(dir, 'round1-brand_creative.md'), body('tampered', 2));
  const err = mustRejectSync(() => loadRealCapture(dir));
  assert.match(String(err), /does not match its sealed hash/);
});

await check('NEGATIVE: a manifest that disagrees with its own seal is rejected', () => {
  const dir = makeCapture(join(SCRATCH, 'reseal'), {
    fixtureId: 'E3', task: '任務內容',
    workers: [
      { agentId: 'business_strategist', mission: 'm', output: body('a', 2) },
      { agentId: 'brand_creative', mission: 'm', output: body('b', 2) },
    ],
  });
  const m = JSON.parse(readFileSync(join(dir, 'capture-manifest.json'), 'utf8'));
  m.captureStatus = 'CAPTURED-BUT-EDITED';
  writeFileSync(join(dir, 'capture-manifest.json'), canonical(m));
  const err = mustRejectSync(() => loadRealCapture(dir));
  assert.match(String(err), /does not match its own seal/);
});

await check('NEGATIVE: a report claiming more successful workers than the artifacts show is rejected', () => {
  const dir = makeCapture(join(SCRATCH, 'overclaim'), {
    fixtureId: 'I3', task: '任務內容',
    workers: [
      { agentId: 'business_strategist', mission: 'm', output: body('a', 2) },
      { agentId: 'brand_creative', mission: 'm', output: body('b', 2) },
    ],
  });
  const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
  report.successfulWorkers = 3;
  const files = { 'report.json': canonical(report) };
  writeFileSync(join(dir, 'report.json'), files['report.json']);
  const m = JSON.parse(readFileSync(join(dir, 'capture-manifest.json'), 'utf8'));
  const { manifestSha256, ...rest } = m;
  rest.fileHashes['report.json'] = sha256(files['report.json']);
  writeFileSync(join(dir, 'capture-manifest.json'), canonical({ ...rest, manifestSha256: sha256(canonical(rest)) }));
  const err = mustRejectSync(() => loadRealCapture(dir));
  assert.match(String(err), /report claims 3 successful workers/);
});

console.log('\nT-2 — zero eligible candidates');

await check('a wave with no eligible candidate returns NO_A2_BATCH and emits no packet', () => {
  const none = makeWaveOne(join(SCRATCH, 'none'), { suffix: ' 變體' });
  const failing = [
    makeCapture(join(SCRATCH, 'none-a'), { fixtureId: 'S1', task: '甲', complexity: 'normal', workers: [{ agentId: 'business_strategist', mission: 'm', output: body('a', 2) }, { agentId: 'brand_creative', mission: 'm', output: body('b', 2) }] }),
    makeCapture(join(SCRATCH, 'none-b'), { fixtureId: 'E1', task: '乙', requested: 2, workers: [{ agentId: 'business_strategist', mission: 'm', output: body('a', 2) }] }),
    makeCapture(join(SCRATCH, 'none-c'), { fixtureId: 'I1', task: '丙', reportStatus: 'DEGRADED', workers: [{ agentId: 'business_strategist', mission: 'm', output: body('a', 2) }, { agentId: 'brand_creative', mission: 'm', output: body('b', 2) }] }),
  ];
  const result = buildA2AcquisitionBatch({ candidateCaptureDirs: failing });
  assert.equal(result.status, NO_A2_BATCH);
  assert.equal(result.reason, NO_F4_ELIGIBLE_CANDIDATES);
  assert.equal(result.packet, null);
  assert.equal(result.provenance, null);
  assert.equal(result.negativeControlIncluded, false, 'the control must not go out alone');
  assert.deepEqual(result.admitted, []);
  assert.equal(result.rejected.length, 3);
  assert.ok(none);
});

console.log('\nT-3 / T-4 — negative control inclusion');

const batch1 = buildA2AcquisitionBatch({
  candidateCaptureDirs: [WAVE1.S1, WAVE1.E1, WAVE1.I1],
  builderCommit: 'test', executionHead: 'test',
});

await check('the first non-empty batch carries every admitted case and the control exactly once', () => {
  assert.equal(batch1.status, A2_BATCH);
  assert.deepEqual([...batch1.admitted].sort(), ['E1', 'I1', 'S1']);
  assert.equal(batch1.negativeControlIncluded, true);
  const controls = batch1.provenance.cases.filter((c) => c.isNegativeControl);
  assert.equal(controls.length, 1);
  assert.equal(controls[0].internalFixtureId, NEGATIVE_CONTROL_FIXTURE_ID);
  assert.equal(batch1.provenance.cases.length, 4);
  assert.equal(batch1.provenance.batchIndex, 1);
});

await check('a later batch does not include the control again', () => {
  const wave2 = makeWaveOne(join(SCRATCH, 'wave2'), { suffix: ' 第二波' });
  const batch2 = buildA2AcquisitionBatch({
    candidateCaptureDirs: [wave2.S1, wave2.E1],
    priorProvenance: [batch1.provenance],
  });
  assert.equal(batch2.status, A2_BATCH);
  assert.equal(batch2.negativeControlIncluded, false);
  assert.equal(batch2.provenance.cases.filter((c) => c.isNegativeControl).length, 0);
  assert.equal(batch2.provenance.cases.length, 2);
  assert.equal(batch2.provenance.batchIndex, 2);
  assert.ok(!batch2.packet.text.includes(loadRealCapture(NEGATIVE_CONTROL_CAPTURE_DIR).task.trim().slice(0, 40)));
});

await check('control reuse is decided from prior provenance, never from a flag passed in', () => {
  assert.equal(negativeControlAlreadyUsed([]), false);
  assert.equal(negativeControlAlreadyUsed([{ negativeControlIncluded: false }]), false);
  assert.equal(negativeControlAlreadyUsed([{ negativeControlIncluded: true }]), true);
  assert.equal(negativeControlAlreadyUsed([{ negativeControlIncluded: false }, { negativeControlIncluded: true }]), true);
});

console.log('\nT-5 — A2-visible data boundary');

await check('the packet carries no internal fixture or slot identity', () => {
  const text = batch1.packet.text;
  for (const id of [...Object.values(ARCHETYPE_SLOTS).flat(), NEGATIVE_CONTROL_FIXTURE_ID]) {
    assert.ok(!new RegExp(`\\b${id}\\b`).test(text), `packet leaks the internal id ${id}`);
  }
  assert.deepEqual(scanInternalIdentities(text), []);
});

await check('the packet carries no archetype intent, control identity, provider, model or role', () => {
  const lower = batch1.packet.text.toLowerCase();
  for (const term of [
    'intended archetype', 'negative control', 'preregistered', 'claude', 'gemini', 'openai',
    'gpt-5', 'sonnet', 'capturestatus', 'complexity', 'evidencecapable', 'stub role',
    'gate selected', 'gate output', 'synthesis_gate', 'arm b', 'arm c',
    'handoff', 'round2', 'decision_synthesis', 'gold issue',
  ]) {
    assert.ok(!lower.includes(term), `packet leaks "${term}"`);
  }
});

await check('the scanner is phrase-based because real Round1 text uses these words normally', () => {
  // fxr-08's own advice numbers its decision gates "Gate 1", "Gate 2". A scanner that
  // forbade the bare word would permanently disqualify the frozen negative control, and
  // the failure would look like a leak rather than like a false positive.
  const control = loadRealCapture(NEGATIVE_CONTROL_CAPTURE_DIR);
  const text = control.workerResults.map((r) => r.output).join('\n');
  assert.ok(/gate/i.test(text), 'the control really does contain the bare word');
  assert.deepEqual(scanCasePayload(text), [], 'and it is not treated as a leak');
});

await check('the static schema enum is allowed even though the legacy scanner forbids it', () => {
  // Protocol 0.3 explicitly lets A2 see the output schema, and the schema names the enum.
  assert.ok(A2_INSTRUCTIONS.includes('conflictArchetype'));
  for (const value of CONFLICT_ARCHETYPES) assert.ok(A2_INSTRUCTIONS.includes(value), value);
  assert.ok(FORBIDDEN_TERMS.includes('archetype'), 'the legacy list still forbids it, and is left alone');
  assert.ok(!CASE_PAYLOAD_FORBIDDEN_TERMS.includes('archetype'));
});

await check('the same-decision rule is stated to A2 and not softened', () => {
  assert.ok(A2_INSTRUCTIONS.includes('相同決策 + 不同推理，不自動構成 material conflict'));
});

await check('NEGATIVE: a case payload carrying provider metadata is refused', () => {
  const err = mustRejectSync(() => assertA2PacketClean({
    instructions: A2_INSTRUCTIONS,
    caseBlocks: ['# 情境 case-01\n\n**模型:** claude-sonnet-5\n'],
  }));
  assert.ok(err instanceof A2LeakageDetected);
});

await check('NEGATIVE: an internal slot id anywhere in the packet is refused', () => {
  const err = mustRejectSync(() => assertA2PacketClean({
    instructions: A2_INSTRUCTIONS,
    caseBlocks: ['# 情境 case-01\n\n原始任務 S1 的內容\n'],
  }));
  assert.ok(err instanceof A2LeakageDetected);
  assert.equal(err.term, 'S1');
});

await check('NEGATIVE: a case payload naming the negative control is refused', () => {
  const err = mustRejectSync(() => assertA2PacketClean({
    instructions: A2_INSTRUCTIONS,
    caseBlocks: ['# 情境 case-01\n\nthis one is the negative control\n'],
  }));
  assert.ok(err instanceof A2LeakageDetected);
});

console.log('\nT-6 / T-7 — deterministic ordering and opaque aliases');

await check('rebuilding the same inputs reproduces bytes, hash, aliases and mapping', () => {
  const again = buildA2AcquisitionBatch({
    candidateCaptureDirs: [WAVE1.S1, WAVE1.E1, WAVE1.I1],
    builderCommit: 'test', executionHead: 'test',
  });
  assert.equal(again.packet.text, batch1.packet.text);
  assert.equal(again.packet.sha256, batch1.packet.sha256);
  assert.deepEqual(again.provenance, batch1.provenance);
});

await check('input order does not affect the packet', () => {
  const shuffled = buildA2AcquisitionBatch({
    candidateCaptureDirs: [WAVE1.I1, WAVE1.S1, WAVE1.E1],
    builderCommit: 'test', executionHead: 'test',
  });
  assert.equal(shuffled.packet.sha256, batch1.packet.sha256);
  assert.deepEqual(shuffled.provenance.cases.map((c) => c.caseId), batch1.provenance.cases.map((c) => c.caseId));
});

await check('the order is exactly task SHA-256 lexical ascending', () => {
  const hashes = batch1.provenance.cases.map((c) => c.taskSha256);
  assert.deepEqual(hashes, [...hashes].sort());
  assert.equal(batch1.provenance.orderingRule, ORDERING_RULE);
});

await check('ordering does not follow slot id, archetype or control identity', () => {
  const ids = batch1.provenance.cases.map((c) => c.internalFixtureId);
  const slotOrder = ['S1', 'E1', 'I1', NEGATIVE_CONTROL_FIXTURE_ID];
  assert.notDeepEqual(ids, slotOrder, 'a packet ordered by slot id would be readable by position');
  const controlIndex = batch1.provenance.cases.findIndex((c) => c.isNegativeControl);
  assert.ok(controlIndex >= 0);
  // The control is placed by its task hash like everything else, never pinned to an end.
  const byHash = [...batch1.provenance.cases].sort((a, b) => (a.taskSha256 < b.taskSha256 ? -1 : 1));
  assert.equal(byHash[controlIndex].internalFixtureId, NEGATIVE_CONTROL_FIXTURE_ID);
});

await check('aliases are sequential opaque case ids and the mapping lives only in provenance', () => {
  assert.deepEqual(batch1.provenance.cases.map((c) => c.caseId), ['case-01', 'case-02', 'case-03', 'case-04']);
  assert.equal(caseIdFor(0), 'case-01');
  assert.equal(caseIdFor(9), 'case-10');
  for (const c of batch1.provenance.cases) {
    assert.ok(c.internalFixtureId, 'provenance keeps the mapping');
    assert.ok(batch1.packet.text.includes(`# 情境 ${c.caseId}`));
  }
});

await check('NEGATIVE: two candidates sharing one task hash are refused rather than ordered arbitrarily', () => {
  const a = makeCapture(join(SCRATCH, 'dup-a'), { fixtureId: 'S1', task: '一模一樣的任務', workers: [{ agentId: 'business_strategist', mission: 'm', output: body('a', 2) }, { agentId: 'brand_creative', mission: 'm', output: body('b', 2) }] });
  const b = makeCapture(join(SCRATCH, 'dup-b'), { fixtureId: 'E1', task: '一模一樣的任務', workers: [{ agentId: 'business_strategist', mission: 'm', output: body('a', 2) }, { agentId: 'brand_creative', mission: 'm', output: body('b', 2) }] });
  const err = mustRejectSync(() => buildA2AcquisitionBatch({ candidateCaptureDirs: [a, b] }));
  assert.ok(err instanceof A2CaptureError);
  assert.match(String(err), /share one task hash/);
});

console.log('\nT-8 — production passage semantics');

await check('packet passage ids equal production segmentAll for the same round1 text', () => {
  const capture = loadRealCapture(NEGATIVE_CONTROL_CAPTURE_DIR);
  const production = segmentAll(capture.workerResults);
  const expected = capture.agentOrder.flatMap((id) => production[id].map((c) => `${id}:${c.id}`));
  assert.deepEqual(passageIdsForCapture(capture), expected);
  const passages = passagesForCapture(capture);
  for (const [agentId, list] of Object.entries(passages)) {
    assert.deepEqual(list.map((p) => p.text), production[agentId].map((c) => c.text));
  }
});

await check('the module segments through production and defines no second splitter', () => {
  const source = readFileSync(fileURLToPath(new URL('./harness/a2-acquisition.mjs', import.meta.url)), 'utf8');
  assert.ok(source.includes("import { segmentAll } from '../../../dist/agents/collaboration.js'"));
  assert.equal((source.match(/segmentAll\(/g) ?? []).length, 1, 'exactly one segmentation call site');
  for (const smell of ['split(/\\n\\n/', 'splitParagraphs', 'function segment']) {
    assert.ok(!source.includes(smell), `a second segmenter would drift from production: ${smell}`);
  }
});

await check('every passage id emitted for a case is cited-back-able and unique', () => {
  for (const c of batch1.provenance.cases) {
    assert.equal(new Set(c.passageIds).size, c.passageIds.length);
    for (const id of c.passageIds) assert.match(id, /^[a-z_]+:p\d+$/);
  }
});

console.log('\nT-9 / T-10 / T-12 — annotation validator');

const caseOf = (fixtureId) => batch1.provenance.cases.find((c) => c.internalFixtureId === fixtureId);
const twoAgentRefs = (record) => {
  const byAgent = new Map();
  for (const id of record.passageIds) {
    const agent = id.slice(0, id.lastIndexOf(':'));
    if (!byAgent.has(agent)) byAgent.set(agent, id);
  }
  return [...byAgent.values()].slice(0, 2);
};

await check('a false annotation is accepted only in its one legal shape', () => {
  const record = caseOf('S1');
  const ok = validateAnnotation({ caseId: record.caseId, materialConflict: false, conflictArchetype: null, summary: null, passageIds: [] }, record);
  assert.deepEqual(ok.errors, []);
  assert.ok(ok.ok);
});

await check('NEGATIVE: a false annotation carrying an archetype, summary or passages is invalid', () => {
  const record = caseOf('S1');
  const refs = twoAgentRefs(record);
  for (const bad of [
    { materialConflict: false, conflictArchetype: 'STRATEGY', summary: null, passageIds: [] },
    { materialConflict: false, conflictArchetype: null, summary: '有分歧', passageIds: [] },
    { materialConflict: false, conflictArchetype: null, summary: null, passageIds: refs },
  ]) {
    const r = validateAnnotation({ caseId: record.caseId, ...bad }, record);
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
});

await check('a true annotation needs an allowed archetype, a summary and two distinct agents', () => {
  const record = caseOf('S1');
  const refs = twoAgentRefs(record);
  assert.equal(refs.length, 2);
  const r = validateAnnotation({ caseId: record.caseId, materialConflict: true, conflictArchetype: 'STRATEGY', summary: '兩位專家對方向有實質分歧', passageIds: refs }, record);
  assert.deepEqual(r.errors, []);
});

await check('NEGATIVE: a true annotation citing one agent only is invalid', () => {
  const record = caseOf('S1');
  const oneAgent = record.passageIds.filter((id) => id.startsWith(`${record.agentOrder[0]}:`)).slice(0, 2);
  assert.equal(oneAgent.length, 2);
  const r = validateAnnotation({ caseId: record.caseId, materialConflict: true, conflictArchetype: 'STRATEGY', summary: '分歧', passageIds: oneAgent }, record);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('two distinct agents')));
});

await check('NEGATIVE: a true annotation with an empty summary or unknown archetype is invalid', () => {
  const record = caseOf('S1');
  const refs = twoAgentRefs(record);
  assert.equal(validateAnnotation({ caseId: record.caseId, materialConflict: true, conflictArchetype: 'STRATEGY', summary: '   ', passageIds: refs }, record).ok, false);
  assert.equal(validateAnnotation({ caseId: record.caseId, materialConflict: true, conflictArchetype: 'PRICING', summary: '分歧', passageIds: refs }, record).ok, false);
});

await check('NEGATIVE: a passage id from another case is refused', () => {
  const record = caseOf('S1');
  const other = caseOf('E1');
  const foreign = other.passageIds.find((id) => !record.passageIds.includes(id));
  const r = validateAnnotation({ caseId: record.caseId, materialConflict: true, conflictArchetype: 'STRATEGY', summary: '分歧', passageIds: [record.passageIds[0], foreign] }, record);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('not present in this case')));
});

await check('NEGATIVE: an invented passage id is refused', () => {
  const record = caseOf('S1');
  const r = validateAnnotation({ caseId: record.caseId, materialConflict: true, conflictArchetype: 'STRATEGY', summary: '分歧', passageIds: [record.passageIds[0], 'business_strategist:p999'] }, record);
  assert.equal(r.ok, false);
});

console.log('\nT-11 — case-set validation');

const falseFor = (fixtureId) => ({ caseId: caseOf(fixtureId).caseId, materialConflict: false, conflictArchetype: null, summary: null, passageIds: [] });
const trueFor = (fixtureId, archetype) => {
  const record = caseOf(fixtureId);
  return { caseId: record.caseId, materialConflict: true, conflictArchetype: archetype, summary: `${fixtureId} 的實質分歧`, passageIds: twoAgentRefs(record) };
};

await check('a complete, one-to-one annotation set validates', () => {
  const set = [trueFor('S1', 'STRATEGY'), trueFor('E1', 'EXECUTION_CONSTRAINT'), trueFor('I1', 'EVIDENCE_INTERPRETATION'), falseFor(NEGATIVE_CONTROL_FIXTURE_ID)];
  const v = validateAnnotationSet(set, batch1.provenance);
  assert.deepEqual(v.errors, []);
  assert.ok(v.ok);
});

await check('NEGATIVE: unknown, duplicate and missing cases are each rejected', () => {
  const base = [trueFor('S1', 'STRATEGY'), trueFor('E1', 'EXECUTION_CONSTRAINT'), trueFor('I1', 'EVIDENCE_INTERPRETATION'), falseFor(NEGATIVE_CONTROL_FIXTURE_ID)];
  const unknown = validateAnnotationSet([...base, { caseId: 'case-99', materialConflict: false, conflictArchetype: null, summary: null, passageIds: [] }], batch1.provenance);
  assert.ok(unknown.errors.some((e) => e.includes('unknown caseId "case-99"')));

  const duplicate = validateAnnotationSet([...base, base[0]], batch1.provenance);
  assert.ok(duplicate.errors.some((e) => e.includes('duplicate annotation')));

  const missing = validateAnnotationSet(base.slice(1), batch1.provenance);
  assert.ok(missing.errors.some((e) => e.includes('missing annotation')));

  assert.equal(validateAnnotationSet('not an array', batch1.provenance).ok, false);
});

console.log('\nT-13 / T-14 — slot-fill resolution');

await check('a matching archetype fills the preregistered slot', () => {
  const set = [trueFor('S1', 'STRATEGY'), trueFor('E1', 'EXECUTION_CONSTRAINT'), trueFor('I1', 'EVIDENCE_INTERPRETATION'), falseFor(NEGATIVE_CONTROL_FIXTURE_ID)];
  const resolved = resolveAnnotations({ annotations: set, provenance: batch1.provenance });
  assert.equal(resolved.status, 'RESOLVED');
  const byFixture = Object.fromEntries(resolved.slots.map((s) => [s.internalFixtureId, s]));
  assert.equal(byFixture.S1.fillsSlot, true);
  assert.equal(byFixture.S1.preregisteredArchetype, 'STRATEGY');
  assert.equal(byFixture.E1.fillsSlot, true);
  assert.equal(byFixture.I1.fillsSlot, true);
  assert.deepEqual([...resolved.filledArchetypes].sort(), ['EVIDENCE_INTERPRETATION', 'EXECUTION_CONSTRAINT', 'STRATEGY']);
  assert.equal(resolved.slots.length, 3, 'the control has no slot');
});

await check('OTHER is a valid annotation that never fills a slot', () => {
  const set = [trueFor('S1', 'OTHER'), trueFor('E1', 'EXECUTION_CONSTRAINT'), trueFor('I1', 'EVIDENCE_INTERPRETATION'), falseFor(NEGATIVE_CONTROL_FIXTURE_ID)];
  const v = validateAnnotationSet(set, batch1.provenance);
  assert.deepEqual(v.errors, [], 'OTHER is a legal material-conflict class');
  const resolved = resolveAnnotations({ annotations: set, provenance: batch1.provenance });
  const s1 = resolved.slots.find((s) => s.internalFixtureId === 'S1');
  assert.equal(s1.materialConflict, true);
  assert.equal(s1.conflictArchetype, 'OTHER');
  assert.equal(s1.fillsSlot, false);
});

await check('a non-matching archetype does not fill the slot', () => {
  const set = [trueFor('S1', 'EVIDENCE_INTERPRETATION'), trueFor('E1', 'EXECUTION_CONSTRAINT'), falseFor('I1'), falseFor(NEGATIVE_CONTROL_FIXTURE_ID)];
  const resolved = resolveAnnotations({ annotations: set, provenance: batch1.provenance });
  const byFixture = Object.fromEntries(resolved.slots.map((s) => [s.internalFixtureId, s]));
  assert.equal(byFixture.S1.fillsSlot, false, 'a conflict of the wrong kind does not close the slot');
  assert.equal(byFixture.I1.fillsSlot, false, 'materialConflict=false never fills');
  assert.equal(byFixture.E1.fillsSlot, true);
  assert.deepEqual(resolved.filledArchetypes, ['EXECUTION_CONSTRAINT']);
});

await check('the intended archetype is read only after annotation, never inside the packet', () => {
  assert.equal(preregisteredArchetypeOf('S1'), 'STRATEGY');
  assert.equal(preregisteredArchetypeOf('E2'), 'EXECUTION_CONSTRAINT');
  assert.equal(preregisteredArchetypeOf('I3'), 'EVIDENCE_INTERPRETATION');
  assert.equal(preregisteredArchetypeOf(NEGATIVE_CONTROL_FIXTURE_ID), null);
  const source = readFileSync(fileURLToPath(new URL('./harness/a2-acquisition.mjs', import.meta.url)), 'utf8');
  const packetSection = source.slice(source.indexOf('function renderCaseBlock'), source.indexOf('// Batch construction'));
  assert.ok(!packetSection.includes('ARCHETYPE_SLOTS'), 'packet rendering must not reach the preregistered archetype');
});

console.log('\nT-15 / T-16 — negative control result');

await check('a control annotated true returns STOP_REQUIRED and resolves no slots', () => {
  const record = caseOf(NEGATIVE_CONTROL_FIXTURE_ID);
  const set = [
    trueFor('S1', 'STRATEGY'), trueFor('E1', 'EXECUTION_CONSTRAINT'), trueFor('I1', 'EVIDENCE_INTERPRETATION'),
    { caseId: record.caseId, materialConflict: true, conflictArchetype: 'STRATEGY', summary: '意外的分歧', passageIds: twoAgentRefs(record) },
  ];
  const assessment = assessNegativeControl(set, batch1.provenance);
  assert.equal(assessment.status, STOP_REQUIRED);
  assert.equal(assessment.reason, NEGATIVE_CONTROL_UNEXPECTED_TRUE);
  const resolved = resolveAnnotations({ annotations: set, provenance: batch1.provenance });
  assert.equal(resolved.status, STOP_REQUIRED);
  assert.equal(resolved.slots, null, 'no slot may be filled from a batch whose control failed');
});

await check('a control annotated false is accepted and the batch continues', () => {
  const set = [trueFor('S1', 'STRATEGY'), trueFor('E1', 'EXECUTION_CONSTRAINT'), trueFor('I1', 'EVIDENCE_INTERPRETATION'), falseFor(NEGATIVE_CONTROL_FIXTURE_ID)];
  const assessment = assessNegativeControl(set, batch1.provenance);
  assert.equal(assessment.status, 'OK');
  assert.equal(assessment.assessed, true);
  assert.equal(resolveAnnotations({ annotations: set, provenance: batch1.provenance }).status, 'RESOLVED');
});

await check('the control is identified through hidden provenance, not from the annotation', () => {
  const record = caseOf(NEGATIVE_CONTROL_FIXTURE_ID);
  assert.ok(record.isNegativeControl);
  assert.ok(!batch1.packet.text.includes(record.internalFixtureId));
  const set = [trueFor('S1', 'STRATEGY'), trueFor('E1', 'EXECUTION_CONSTRAINT'), trueFor('I1', 'EVIDENCE_INTERPRETATION')];
  assert.equal(assessNegativeControl(set, batch1.provenance).status, STOP_REQUIRED, 'an unannotated control is not a pass');
});

console.log('\nT-5 continued / D-5 — session identity');

await check('every batch carries the one logical A2 session, fresh first then continuing', () => {
  assert.equal(batch1.provenance.a2SessionId, A2_SESSION_ID);
  assert.equal(batch1.provenance.a2SessionStart, 'FRESH');
  const wave2 = makeWaveOne(join(SCRATCH, 'wave2b'), { suffix: ' 續' });
  const batch2 = buildA2AcquisitionBatch({ candidateCaptureDirs: [wave2.S1], priorProvenance: [batch1.provenance] });
  assert.equal(batch2.provenance.a2SessionId, A2_SESSION_ID);
  assert.equal(batch2.provenance.a2SessionStart, 'CONTINUE');
});

console.log('\nT-17 — hidden provenance');

await check('the hidden manifest records every field the protocol requires', () => {
  const p = batch1.provenance;
  for (const field of [
    'protocolVersion', 'a2SessionId', 'batchIndex', 'packetSha256', 'orderingRule',
    'negativeControlIncluded', 'builderCommit', 'executionHead', 'cases',
  ]) assert.ok(field in p, `missing ${field}`);
  assert.equal(p.protocolVersion, PROTOCOL_VERSION);
  for (const c of p.cases) {
    for (const field of [
      'caseId', 'internalFixtureId', 'taskSha256', 'sourceCaptureManifestSha256',
      'missionSha256', 'round1OutputSha256', 'passageIds', 'isNegativeControl',
    ]) assert.ok(field in c, `case missing ${field}`);
  }
});

await check('every hash in the hidden manifest recomputes from the committed captures', () => {
  const result = verifyProvenance(batch1.provenance);
  assert.deepEqual(result.failures, []);
  assert.ok(result.ok);
  assert.equal(result.checked, 4);
});

await check('NEGATIVE: a provenance whose recorded packet hash was edited fails verification', () => {
  const tampered = { ...batch1.provenance, packetSha256: sha256('something else') };
  const result = verifyProvenance(tampered);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.id === 'packetSha256'));
});

await check('NEGATIVE: a provenance whose case order was rearranged fails verification', () => {
  const cases = [...batch1.provenance.cases];
  const swapped = [cases[1], cases[0], ...cases.slice(2)].map((c, i) => ({ ...c, caseId: caseIdFor(i) }));
  const result = verifyProvenance({ ...batch1.provenance, cases: swapped });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.id === 'ordering'));
});

await check('the A2-visible packet contains no hidden mapping', () => {
  for (const c of batch1.provenance.cases) {
    assert.ok(!batch1.packet.text.includes(c.internalFixtureId));
    assert.ok(!batch1.packet.text.includes(c.sourceCaptureManifestSha256));
    assert.ok(!batch1.packet.text.includes(c.taskSha256));
  }
});

console.log('\nT-1 — legacy clean-room path unchanged');

const gitShow = (path) => {
  const r = spawnSync('git', ['show', `${BASE_SHA}:${path}`], { cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  assert.equal(r.status, 0, `git show failed for ${path}: ${r.stderr}`);
  return r.stdout;
};

await check('cleanroom.mjs is byte-identical to the base commit', () => {
  const path = 'experiments/m2b/harness/cleanroom.mjs';
  assert.equal(sha256(readFileSync(join(REPO, path), 'utf8')), sha256(gitShow(path)));
});

await check('fixtures.mjs is byte-identical to the base commit', () => {
  const path = 'experiments/m2b/harness/fixtures.mjs';
  assert.equal(sha256(readFileSync(join(REPO, path), 'utf8')), sha256(gitShow(path)));
});

await check('the legacy synthetic packet still builds with its own order and its own scanner', () => {
  assert.deepEqual([...PACKET_ORDER], ['fx-03', 'fx-01', 'fx-04', 'fx-02']);
  const packet = buildCleanRoomPacket('conflict');
  assert.deepEqual(packet.fixtureOrder, [...PACKET_ORDER]);
  assert.ok(packet.sha256.length === 64);
});

await check('the acquisition path does not import or reuse the legacy builder', () => {
  const source = readFileSync(fileURLToPath(new URL('./harness/a2-acquisition.mjs', import.meta.url)), 'utf8');
  // Asserted on imports and call sites, not on mentions: the module header explains why
  // it is separate from the legacy path, and naming it there is the explanation working.
  const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  assert.ok(!imports.some((i) => i.includes('cleanroom')), 'must not import the legacy builder');
  assert.ok(!imports.some((i) => i.includes('fixtures.mjs')), 'must not import the legacy loader');
  for (const call of ['assertPacketClean(', 'scanPacket(', 'loadFixture(', 'passagesOf(', 'PACKET_ORDER']) {
    assert.ok(!source.includes(call), `must not reuse the legacy path: ${call}`);
  }
});

console.log('\nT-18 — no provider calls');

await check('the module imports nothing that can reach a provider', () => {
  const source = readFileSync(fileURLToPath(new URL('./harness/a2-acquisition.mjs', import.meta.url)), 'utf8');
  const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), [
    '../../../dist/agents/collaboration.js',
    '../protocol/amendment-0-3.mjs',
    'node:crypto',
    'node:fs',
    'node:path',
    'node:url',
  ]);
  for (const smell of ['callProvider', 'dispatcher', 'recorder.mjs', 'session.mjs', 'runCaptureSession', 'fetch(']) {
    assert.ok(!source.includes(smell), `acquisition must not be able to spend a call: ${smell}`);
  }
});

await check('this suite performs no capture attempt and writes nothing into a capture root', () => {
  const source = readFileSync(fileURLToPath(new URL('./test-m2b-a2-acquisition.mjs', import.meta.url)), 'utf8');
  // Asserted on imports rather than on mentions: a suite that cannot reach the capture
  // session or the live entry point cannot spend a call, whatever its strings say.
  const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  for (const forbidden of ['capture/session', 'capture/run-live', 'capture/recorder', 'capture/runner']) {
    assert.ok(!imports.some((i) => i.includes(forbidden)), `test suite must not reach ${forbidden}`);
  }
  const writes = [...source.matchAll(/writeFileSync\(join\((\w+)/g)].map((m) => m[1]);
  assert.ok(writes.every((v) => v === 'dir'), 'every write goes through the temp-dir capture builder');
  assert.ok(SCRATCH.startsWith(tmpdir()), 'all writes go to a temp dir');
});

function mustRejectSync(fn) {
  let thrown = null;
  try { fn(); } catch (e) { thrown = e; }
  assert.ok(thrown, 'expected a rejection but none happened');
  return thrown;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
