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
import { validateManifest, canonicalize, isUtcIso } from './harness/manifest.mjs';
import { evidenceBaseline } from './harness/invariants.mjs';
import { verifyNormalization } from './harness/normalizer.mjs';
import { assertPairsBlind } from './harness/pairs.mjs';
import { assertNoPeerLeakage } from './harness/leakage.mjs';
import { buildSpecialistBlock } from './harness/arms.mjs';

const sha256 = (v) => createHash('sha256').update(v).digest('hex');

/**
 * Recomputes whether the gate triggered, from the recorded gate response and production
 * code. H-03: this is the fact every call-shape expectation hangs on, and the artifact's
 * own `triggered` flag (if any) is not consulted.
 */
function recomputeTrigger(a) {
  const parsed = parseGateOutput(a.gateResponseText);
  const chunks = segmentAll(a.snapshot.workerResults);
  const { valid } = validateIssues(parsed.rawIssues, {
    successfulAgentIds: a.snapshot.agentOrder,
    chunksByAgent: chunks,
  });
  const selected = selectIssue(valid, a.snapshot.agentOrder) ?? null;
  return { parsed, chunks, selected, triggered: selected !== null };
}

const billable = (a, arm) => (a.arms[arm].calls ?? []).filter((c) => !c.replayed).length;
const stagesOf = (a, arm) => (a.arms[arm].calls ?? []).map((c) => c.stage);

/** Each entry recomputes one claim. `name` is what the report prints; failures throw. */
const CHECKS = [
  ['manifest integrity', (a) => {
    for (const [arm, m] of Object.entries(a.manifests)) {
      validateManifest(m);
      assert.equal(m.manifestSha256, sha256(canonicalize(m)), `${arm}: manifestSha256 does not match its own contents`);
    }
    return `${Object.keys(a.manifests).length} manifests validated, sealed and re-hashed`;
  }],

  // H-04 §8.3. A manifest that validates in isolation still proves nothing about *this*
  // run until it is bound to it.
  ['manifest / artifact identity binding', (a) => {
    for (const [arm, m] of Object.entries(a.manifests)) {
      assert.equal(m.experimentId, a.experimentId, `${arm}: manifest experimentId does not match the artifact`);
      assert.equal(m.fixtureId, a.fixtureId, `${arm}: manifest fixtureId does not match the artifact`);
      assert.equal(m.runIndex, a.runIndex, `${arm}: manifest runIndex does not match the artifact`);
      assert.equal(m.arm, arm, `${arm}: manifest declares arm "${m.arm}"`);
      assert.equal(m.snapshotSha256, a.snapshotSha256, `${arm}: manifest snapshotSha256 does not match the artifact`);
      assert.equal(m.protocolVersion, 'M2B-PROTOCOL-0.2', `${arm}: wrong protocolVersion`);
    }
    const baseline = evidenceBaseline(a.snapshot);
    for (const [arm, m] of Object.entries(a.manifests)) {
      assert.equal(m.evidenceLabelBaseline, baseline.evidenceLabel,
        `${arm}: manifest evidenceLabelBaseline "${m.evidenceLabelBaseline}" but the frozen Round 1 recomputes to "${baseline.evidenceLabel}"`);
    }
    return `${Object.keys(a.manifests).length} manifests bound to this artifact and to the recomputed baseline`;
  }],

  ['snapshot hash', (a) => {
    const recomputed = sha256(JSON.stringify(a.snapshot));
    assert.equal(recomputed, a.snapshotSha256, 'snapshot hash does not match the recorded one');
    return recomputed;
  }],

  // H-03. Two legal shapes, and which one applies is recomputed rather than declared.
  ['trigger state and arm call accounting', (a) => {
    const { triggered, selected } = recomputeTrigger(a);

    assert.equal(billable(a, 'B'), 1, 'arm B must cost exactly one call');
    assert.equal(billable(a, 'B_prime'), 1, 'the shared gate must cost exactly one call');

    const gateHits = Object.values(a.arms).flatMap((r) => r.calls ?? [])
      .filter((c) => c.stage === 'synthesis_gate' && !c.replayed);
    assert.equal(gateHits.length, 1, 'the gate must reach a provider exactly once per repetition');

    if (triggered) {
      assert.equal(billable(a, 'C'), 2, 'a triggered C must add round2_worker and decision_synthesis');
      assert.deepEqual(stagesOf(a, 'C'), ['synthesis_gate', 'round2_worker', 'decision_synthesis']);
      assert.equal(a.arms.D1.skipped, false, 'the gate selected an issue, so D1 must not be skipped');
      assert.equal(billable(a, 'D1'), 2, 'a triggered D1 must add self_review and decision_synthesis');
      assert.deepEqual(stagesOf(a, 'D1'), ['self_review', 'decision_synthesis']);
      const total = ['B', 'B_prime', 'C', 'D1'].reduce((n, arm) => n + billable(a, arm), 0);
      assert.equal(total, 6, 'a triggered repetition costs six billable calls');
      return `TRIGGERED (${selected.targetAgentId} <- ${selected.sourceRef}): 6 billable calls`;
    }

    // Not triggered. A legal observation, not a discarded run: C degenerates to B-prime
    // and D1 has nothing to review. Anything else here is a harness that spent money it
    // had no reason to spend.
    assert.equal(billable(a, 'C'), 0, 'an untriggered C must add no calls at all');
    assert.deepEqual(stagesOf(a, 'C'), ['synthesis_gate'], 'an untriggered C must stop at the replayed gate');
    assert.equal(a.arms.D1.skipped, true, 'no selected issue, so D1 must be skipped');
    assert.equal(a.arms.D1.reason, 'no_selected_issue');
    assert.deepEqual(a.arms.D1.calls ?? [], [], 'a skipped D1 must have made no call');
    assert.equal(billable(a, 'D1'), 0);
    const total = ['B', 'B_prime', 'C', 'D1'].reduce((n, arm) => n + billable(a, arm), 0);
    assert.equal(total, 2, 'an untriggered repetition costs two billable calls');
    return 'NOT TRIGGERED: 2 billable calls, C == B-prime, D1 skipped';
  }],

  // H-04 §8.2. `requested === resolved` alone proves only that the adapter was
  // self-consistent — not that either matched what the manifest promised.
  ['call / manifest pin binding', (a) => {
    let bound = 0;
    for (const [arm, r] of Object.entries(a.arms)) {
      const pins = a.manifests[arm]?.pins;
      assert.ok(pins, `${arm}: no manifest pins to bind against`);
      for (const call of r.calls ?? []) {
        const pin = pins[call.stage];
        assert.ok(pin, `${arm}/${call.stage}: manifest has no pin for this stage`);
        assert.equal(call.provider, pin.provider, `${arm}/${call.stage}: provider "${call.provider}" but manifest pins "${pin.provider}"`);
        assert.equal(call.requestedModel, pin.requestedModel, `${arm}/${call.stage}: requested "${call.requestedModel}" but manifest pins "${pin.requestedModel}"`);
        assert.equal(call.resolvedModel, pin.requestedModel, `${arm}/${call.stage}: resolved "${call.resolvedModel}" but manifest pins "${pin.requestedModel}"`);
        bound++;
      }
    }
    return `${bound} calls bound to their manifest pin (provider, requested and resolved)`;
  }],

  // H-04 §8.4 / §8.5. The arms must be comparable, which is a fact about the pins and the
  // target, not something the harness may assert about itself.
  ['cross-arm pin and target matching', (a) => {
    const { triggered, selected } = recomputeTrigger(a);
    const pinOf = (arm, stage) => a.manifests[arm]?.pins?.[stage];
    const same = (x, y, what) => {
      assert.ok(x && y, `${what}: a pin is missing`);
      assert.equal(x.provider, y.provider, `${what}: providers differ (${x.provider} vs ${y.provider})`);
      assert.equal(x.requestedModel, y.requestedModel, `${what}: models differ (${x.requestedModel} vs ${y.requestedModel})`);
    };

    same(pinOf('B_prime', 'synthesis_gate'), pinOf('C', 'synthesis_gate'), 'B-prime and C gate');
    if (!triggered) return 'NOT TRIGGERED: gate pins matched; C/D1 second-round pins not applicable';

    same(pinOf('C', 'round2_worker'), pinOf('D1', 'self_review'), 'C round2 target and D1 self-review target');
    same(pinOf('C', 'decision_synthesis'), pinOf('D1', 'decision_synthesis'), 'C and D1 decision synthesizer');

    assert.equal(a.arms.D1.selfReview?.agentId, selected.targetAgentId,
      `D1 reviewed "${a.arms.D1.selfReview?.agentId}" but the gate selected "${selected.targetAgentId}"`);
    const d1Call = (a.arms.D1.calls ?? []).find((c) => c.stage === 'self_review');
    const cCall = (a.arms.C.calls ?? []).find((c) => c.stage === 'round2_worker');
    assert.equal(d1Call.provider, cCall.provider, 'C and D1 second-round providers differ at runtime');
    assert.equal(d1Call.resolvedModel, cCall.resolvedModel, 'C and D1 second-round resolved models differ at runtime');
    return `same gate pin, same target pin, same synthesizer pin, same target specialist "${selected.targetAgentId}"`;
  }],

  // H-05. Client-observed execution provenance only — this asserts nothing about
  // server-side timing, and no check here may be read as a server timestamp guarantee.
  ['execution timestamp provenance', (a) => {
    let live = 0;
    let replayed = 0;
    for (const [arm, m] of Object.entries(a.manifests)) {
      assert.ok(m.startedAt !== undefined, `${arm}: manifest has no startedAt`);
      assert.ok(isUtcIso(m.startedAt), `${arm}: manifest startedAt "${m.startedAt}" is not a UTC ISO-8601 instant`);
    }
    for (const [arm, r] of Object.entries(a.arms)) {
      const manifestAt = Date.parse(a.manifests[arm]?.startedAt ?? '');
      for (const call of r.calls ?? []) {
        if (call.replayed) {
          // A replay is not an execution. It must not carry one's timing.
          assert.equal(call.startedAt, null,
            `${arm}/${call.stage}: a replayed call claims startedAt "${call.startedAt}"; a replay is not a provider execution`);
          assert.ok(call.ms === null || call.ms === undefined,
            `${arm}/${call.stage}: a replayed call claims ms=${call.ms}; a replay spent no provider time`);
          if (call.recordedProviderStartedAt != null) {
            assert.ok(isUtcIso(call.recordedProviderStartedAt),
              `${arm}/${call.stage}: recordedProviderStartedAt is not a UTC ISO-8601 instant`);
          }
          replayed++;
          continue;
        }
        assert.ok(call.startedAt !== undefined && call.startedAt !== null,
          `${arm}/${call.stage}: a real provider call has no startedAt`);
        assert.ok(isUtcIso(call.startedAt),
          `${arm}/${call.stage}: startedAt "${call.startedAt}" is not a UTC ISO-8601 instant`);
        assert.ok(Number.isFinite(call.ms) && call.ms >= 0,
          `${arm}/${call.stage}: ms must be a non-negative number, got ${call.ms}`);
        // Ordering sanity, not precision: a call issued before its own run began is
        // impossible, whatever the clock's accuracy.
        if (Number.isFinite(manifestAt)) {
          assert.ok(Date.parse(call.startedAt) >= manifestAt,
            `${arm}/${call.stage}: call startedAt precedes the manifest's own startedAt`);
        }
        live++;
      }
    }
    return `${live} live calls carry a UTC startedAt; ${replayed} replayed calls claim none (client-observed only)`;
  }],

  ['retrieval all-off', (a) => {
    for (const [arm, r] of Object.entries(a.arms)) {
      for (const call of r.calls ?? []) {
        assert.equal(call.retrievalRequested, null, `${arm}/${call.stage} requested retrieval`);
        assert.equal(call.retrievalResult, null, `${arm}/${call.stage} received retrieval`);
      }
    }
    return 'no retrieval requested or received on any call';
  }],

  ['C and B-prime share one gate sample', (a) => {
    const bp = a.arms.B_prime.provisionalAnswer;
    assert.ok(bp, 'B-prime recorded no provisional answer');
    assert.equal(a.arms.C.provisionalAnswer, bp, 'C was built on a different gate sample than B-prime');
    const gateShas = new Set(
      Object.values(a.arms).flatMap((r) => r.calls ?? []).filter((c) => c.stage === 'synthesis_gate').map((c) => c.promptSha256)
    );
    assert.equal(gateShas.size, 1, 'the shared gate prompt differed between arms');
    const { triggered } = recomputeTrigger(a);
    if (!triggered) {
      assert.equal(a.arms.C.finalOutput, a.arms.B_prime.finalOutput,
        'with no issue selected, C must deliver exactly what B-prime delivered');
    }
    return `provisional shared; one gate prompt sha ${[...gateShas][0].slice(0, 12)}${triggered ? '' : '; C == B-prime'}`;
  }],

  ['gate parsing re-derived from the recorded response', (a) => {
    const { parsed, chunks, selected } = recomputeTrigger(a);
    assert.equal(parsed.answer, a.arms.B_prime.provisionalAnswer, 'production parser disagrees with the recorded provisional');
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
      // H-03: a skipped D1 has no second-round result, so demanding a report here would
      // read a legal no-trigger run as an evidence failure. What it must have instead is
      // nothing at all — asserted below, not merely unexamined.
      if (r.skipped) {
        assert.equal(arm, 'D1', `only D1 may be skipped, not ${arm}`);
        assert.equal(r.finalOutput, undefined, 'a skipped D1 must not carry a finalOutput');
        assert.equal(r.normalized, undefined, 'a skipped D1 must not carry a normalized answer');
        assert.equal(r.report, undefined, 'a skipped D1 must not carry a report');
        continue;
      }
      assert.deepEqual(JSON.parse(JSON.stringify(r.report)), baseline.report, `${arm}: report moved off the Round 1 baseline`);
      assert.ok(r.finalOutput.startsWith(baseline.banner), `${arm}: banner missing or altered`);
    }
    return `evidenceLabel ${baseline.evidenceLabel} / status ${baseline.status}, identical across every arm that produced an answer`;
  }],

  ['NC-3 D1 peer-leakage diagnostic', (a) => {
    if (a.arms.D1.skipped) return 'D1 skipped (no selected issue); nothing to check';
    const peer = a.peer;
    assertNoPeerLeakage(a.arms.D1.selfReviewPrompt, peer);
    assertNoPeerLeakage(a.arms.D1.decisionPrompt, peer, { allowPeerChunk: true });
    assert.ok(!a.arms.D1.selfReviewPrompt.includes(peer.chunkText), 'peer chunk reached the D1 middle round');
    assert.ok(!a.arms.D1.decisionPrompt.includes(peer.challengeText), 'gate-authored challenge reached D1');
    assert.ok(!a.arms.D1.decisionPrompt.includes(peer.sourceRef), 'sourceRef reached D1');
    return 'exact rejections re-checked; substring window is a secondary diagnostic, not a proof of no leakage';
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
    let checked = 0;
    for (const [arm, r] of Object.entries(a.arms)) {
      if (r.skipped) continue;
      if (!r.normalized) continue;
      const out = verifyNormalization(r.finalOutput, baseline.banner, r.normalized.text);
      assert.ok(out.deterministic, `${arm}: committed normalized answer is not what the normalizer produces`);
      assert.equal(out.expectedSha256, r.normalized.sha256, `${arm}: normalized sha256 mismatch`);
      checked++;
    }
    return `${checked} normalized answers regenerated byte for byte`;
  }],

  ['pair and assignment integrity', (a) => {
    const { triggered } = recomputeTrigger(a);
    if (!a.blindPairs) return 'no blind pairs in this artifact';
    assertPairsBlind(a.blindPairs.pairs);
    const ids = new Set(a.blindPairs.pairs.map((p) => p.pairId));
    assert.equal(ids.size, a.blindPairs.pairs.length, 'duplicate pairIds');
    assert.deepEqual(new Set(a.blindPairs.assignments.map((x) => x.pairId)), ids, 'assignments do not cover the pairs exactly');
    for (const name of ['"B"', '"B_prime"', '"C"', '"D1"']) {
      assert.ok(!JSON.stringify(a.blindPairs.pairs).includes(name), `judge-facing pairs mention ${name}`);
    }
    // H-03 / §12: no D1 answer means no D1 pair. Never a placeholder to keep the count.
    if (!triggered) {
      const d1Pairs = a.blindPairs.assignments.filter((x) => x.answerX === 'D1' || x.answerY === 'D1');
      assert.deepEqual(d1Pairs, [], 'an untriggered run produced a judge-facing pair containing D1');
    }
    return `${a.blindPairs.pairs.length} pairs, assignments held separately${triggered ? '' : ', no D1 pair'}`;
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
