/**
 * M2-B artifact verifier.
 *
 * The rule it exists to enforce: a claim in an artifact is worth nothing unless it can be
 * recomputed from the raw data next to it. So this never reads a `PASS` field. It rebuilds
 * every claim from `raw-calls/` using production code where production code produced the
 * thing, and fails loudly when a recomputation disagrees.
 *
 * Offline only. It calls no provider, and cannot: it works from committed artifacts.
 *
 * Usage:  node experiments/m2b/verify.mjs <run-artifact.json> [...]
 *         node experiments/m2b/verify.mjs --self-test
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildRunReport, buildOutputBanner } from '../../dist/modes/orchestrator.js';
import { parseGateOutput, validateIssues, selectIssue, segmentAll, resolveSourceRef } from '../../dist/agents/collaboration.js';
import { validateManifest, canonicalize } from './harness/manifest.mjs';
import { evidenceBaseline } from './harness/invariants.mjs';
import { verifyNormalization } from './harness/normalizer.mjs';
import { assertPairsBlind } from './harness/pairs.mjs';
import { assertNoPeerLeakage } from './harness/leakage.mjs';
import { buildSpecialistBlock } from './harness/arms.mjs';

const sha256 = (v) => createHash('sha256').update(v).digest('hex');

/** Each entry recomputes one claim. `name` is what the report prints; failures throw. */
const CHECKS = [
  ['manifest integrity', (a) => {
    for (const m of Object.values(a.manifests)) {
      validateManifest(m);
      assert.equal(m.manifestSha256, sha256(canonicalize(m)), 'manifestSha256 does not match its own contents');
    }
    return `${Object.keys(a.manifests).length} manifests validated and re-hashed`;
  }],

  ['snapshot hash', (a) => {
    const recomputed = sha256(JSON.stringify(a.snapshot));
    assert.equal(recomputed, a.snapshotSha256, 'snapshot hash does not match the recorded one');
    return recomputed;
  }],

  ['arm call accounting', (a) => {
    const billable = (arm) => a.arms[arm].calls.filter((c) => !c.replayed).length;
    assert.equal(billable('B'), 1, 'arm B must cost exactly one call');
    assert.equal(billable('B_prime'), 1, 'the shared gate must cost exactly one call');
    assert.equal(billable('C'), 2, 'arm C must add exactly two calls on top of the shared gate');
    assert.equal(billable('D1'), 2, 'arm D1 must add exactly two calls on top of the shared gate');
    const total = ['B', 'B_prime', 'C', 'D1'].reduce((n, arm) => n + billable(arm), 0);
    assert.equal(total, 6, 'a fixture-repetition must cost six billable calls, not eight');
    const gateHits = Object.values(a.arms).flatMap((r) => r.calls).filter((c) => c.stage === 'synthesis_gate' && !c.replayed);
    assert.equal(gateHits.length, 1, 'the gate must reach a provider exactly once per repetition');
    return `6 billable calls; gate charged once, replayed ${
      Object.values(a.arms).flatMap((r) => r.calls).filter((c) => c.replayed).length} times`;
  }],

  ['model pins', (a) => {
    for (const [arm, r] of Object.entries(a.arms)) {
      for (const call of r.calls) {
        assert.ok(call.requestedModel, `${arm}/${call.stage}: no requestedModel recorded`);
        assert.equal(call.resolvedModel, call.requestedModel,
          `${arm}/${call.stage}: resolved "${call.resolvedModel}" but pinned "${call.requestedModel}"`);
      }
    }
    return 'every call resolved to the model its manifest pinned';
  }],

  ['retrieval all-off', (a) => {
    for (const [arm, r] of Object.entries(a.arms)) {
      for (const call of r.calls) {
        assert.equal(call.retrievalRequested, null, `${arm}/${call.stage} requested retrieval`);
        assert.equal(call.retrievalResult, null, `${arm}/${call.stage} received retrieval`);
      }
    }
    return 'no retrieval requested or received on any call';
  }],

  ['C and D1 share one provisional', (a) => {
    const bp = a.arms.B_prime.provisionalAnswer;
    assert.ok(bp, 'B-prime recorded no provisional answer');
    assert.equal(a.arms.C.provisionalAnswer, bp, 'C was built on a different gate sample than B-prime');
    const gateShas = new Set(
      Object.values(a.arms).flatMap((r) => r.calls).filter((c) => c.stage === 'synthesis_gate').map((c) => c.promptSha256)
    );
    assert.equal(gateShas.size, 1, 'the shared gate prompt differed between arms');
    return `provisional shared; one gate prompt sha ${[...gateShas][0].slice(0, 12)}`;
  }],

  ['gate parsing re-derived from the recorded response', (a) => {
    const parsed = parseGateOutput(a.gateResponseText);
    assert.equal(parsed.answer, a.arms.B_prime.provisionalAnswer, 'production parser disagrees with the recorded provisional');
    const chunks = segmentAll(a.snapshot.workerResults);
    const { valid } = validateIssues(parsed.rawIssues, { successfulAgentIds: a.snapshot.agentOrder, chunksByAgent: chunks });
    const selected = selectIssue(valid, a.snapshot.agentOrder) ?? null;
    assert.deepEqual(selected, a.selectedIssue ?? null, 'production selection disagrees with the recorded selectedIssue');
    if (selected) {
      const resolved = resolveSourceRef(selected.sourceRef, chunks);
      assert.equal(resolved.ok, true, 'recorded sourceRef does not resolve against the frozen Round 1');
      assert.notEqual(resolved.agentId, selected.targetAgentId, 'sourceRef and target are the same specialist');
    }
    return `parse=${parsed.status}, issues=${parsed.rawIssues.length}, selected=${selected ? 1 : 0}`;
  }],

  ['NC-2 evidence invariance', (a) => {
    const baseline = evidenceBaseline(a.snapshot);
    const report = buildRunReport(a.snapshot.complexity, a.snapshot.workers, a.snapshot.workerResults);
    assert.equal(buildOutputBanner(report), baseline.banner);
    for (const [arm, r] of Object.entries(a.arms)) {
      assert.deepEqual(JSON.parse(JSON.stringify(r.report)), baseline.report, `${arm}: report moved off the Round 1 baseline`);
      assert.ok(r.finalOutput.startsWith(baseline.banner), `${arm}: banner missing or altered`);
    }
    return `evidenceLabel ${baseline.evidenceLabel} / status ${baseline.status}, identical across all four arms`;
  }],

  ['NC-3 D1 peer-leakage assertions', (a) => {
    if (a.arms.D1.skipped) return 'D1 skipped (no selected issue); nothing to check';
    const peer = a.peer;
    assertNoPeerLeakage(a.arms.D1.selfReviewPrompt, peer);
    assertNoPeerLeakage(a.arms.D1.decisionPrompt, peer, { allowPeerChunk: true });
    assert.ok(!a.arms.D1.selfReviewPrompt.includes(peer.chunkText), 'peer chunk reached the D1 middle round');
    assert.ok(!a.arms.D1.decisionPrompt.includes(peer.challengeText), 'gate-authored challenge reached D1');
    return 'D1 prompts re-checked against the peer chunk, challenge and sourceRef';
  }],

  ['C and D1 non-treatment parity', (a) => {
    if (a.arms.D1.skipped) return 'D1 skipped; parity not applicable';
    const block = buildSpecialistBlock(a.snapshot);
    assert.ok(a.arms.C.decisionPrompt.includes(block), 'arm C decision prompt lost the specialist block');
    assert.ok(a.arms.D1.decisionPrompt.includes(block), 'arm D1 decision prompt lost the specialist block');
    const CONTRACT = 'Revision, recency, or agreement between specialists is not evidence.';
    assert.ok(a.arms.C.decisionPrompt.includes(CONTRACT), 'arm C lost the neutrality guard');
    assert.ok(a.arms.D1.decisionPrompt.includes(CONTRACT), 'arm D1 lost the neutrality guard');
    return 'same specialist block and same neutrality guard in both arms';
  }],

  ['normalization determinism', (a) => {
    const baseline = evidenceBaseline(a.snapshot);
    for (const [arm, r] of Object.entries(a.arms)) {
      if (!r.normalized) continue;
      const out = verifyNormalization(r.finalOutput, baseline.banner, r.normalized.text);
      assert.ok(out.deterministic, `${arm}: committed normalized answer is not what the normalizer produces`);
      assert.equal(out.expectedSha256, r.normalized.sha256, `${arm}: normalized sha256 mismatch`);
    }
    return 'every committed normalized answer regenerated byte for byte';
  }],

  ['pair and assignment integrity', (a) => {
    if (!a.blindPairs) return 'no blind pairs in this artifact';
    assertPairsBlind(a.blindPairs.pairs);
    const ids = new Set(a.blindPairs.pairs.map((p) => p.pairId));
    assert.equal(ids.size, a.blindPairs.pairs.length, 'duplicate pairIds');
    assert.deepEqual(new Set(a.blindPairs.assignments.map((x) => x.pairId)), ids, 'assignments do not cover the pairs exactly');
    const armNames = ['"B"', '"B_prime"', '"C"', '"D1"'];
    const serialized = JSON.stringify(a.blindPairs.pairs);
    for (const name of armNames) assert.ok(!serialized.includes(name), `judge-facing pairs mention ${name}`);
    return `${a.blindPairs.pairs.length} pairs, assignments held separately`;
  }],
];

export function verifyArtifact(artifact) {
  const results = [];
  for (const [name, fn] of CHECKS) {
    try {
      results.push({ name, status: 'PASS', detail: fn(artifact) });
    } catch (error) {
      results.push({ name, status: 'FAIL', detail: error.message });
    }
  }
  return { results, ok: results.every((r) => r.status === 'PASS') };
}

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (files.length) {
  let allOk = true;
  for (const file of files) {
    const artifact = JSON.parse(readFileSync(file, 'utf8'));
    const { results, ok } = verifyArtifact(artifact);
    console.log(`\n${file}`);
    for (const r of results) console.log(`  ${r.status === 'PASS' ? 'PASS' : 'FAIL'} ${r.name}: ${r.detail}`);
    allOk = allOk && ok;
  }
  process.exit(allOk ? 0 : 1);
} else if (process.argv.includes('--self-test')) {
  console.log('verify.mjs exposes these recomputations:');
  for (const [name] of CHECKS) console.log(`  - ${name}`);
} else {
  console.log('usage: node experiments/m2b/verify.mjs <run-artifact.json> [...]  |  --self-test');
}
