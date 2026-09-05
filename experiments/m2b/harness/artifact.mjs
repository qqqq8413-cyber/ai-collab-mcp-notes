/**
 * Assembles the run artifact that `verify.mjs` recomputes from.
 *
 * The artifact stores raw material, not conclusions: prompts, responses, call metadata and
 * the frozen snapshot. Every derived claim — call counts, pins, evidence invariance,
 * leakage, normalization — is left for the verifier to recompute, so no reader has to take
 * this module's word for anything.
 */
import { createHash } from 'node:crypto';
import { evidenceBaseline } from './invariants.mjs';
import { normalizeAnswer } from './normalizer.mjs';
import { buildBlindPairs } from './pairs.mjs';

const sha256 = (v) => createHash('sha256').update(v).digest('hex');

/** Pulls the prompt a given stage was actually sent, out of the stub/live call log. */
const promptFor = (seen, stage, nth = 0) => seen.filter((s) => s.stage === stage)[nth]?.prompt ?? null;

export function buildRunArtifact({ experimentId, fixtureId, runIndex, snapshot, run, seen, manifests, gateResponseText }) {
  const baseline = evidenceBaseline(snapshot);
  const { arms, peer, accounting } = run;

  const normalized = {};
  for (const [arm, r] of Object.entries(arms)) {
    if (r.skipped || !r.result?.finalOutput) continue;
    normalized[arm] = normalizeAnswer(r.result.finalOutput, baseline.banner);
  }

  const comparisons = [['B', 'B_prime'], ['B_prime', 'C'], ['C', 'D1']].filter(
    ([a, b]) => normalized[a] && normalized[b]
  );
  const blindPairs = comparisons.length
    ? buildBlindPairs({ fixtureId, runIndex, normalized, comparisons })
    : null;

  return {
    experimentId,
    fixtureId,
    runIndex,
    generatedAt: new Date().toISOString(),
    snapshot,
    snapshotSha256: sha256(JSON.stringify(snapshot)),
    manifests,
    gateResponseText,
    selectedIssue: arms.B_prime.result.collaboration?.selectedIssue ?? null,
    peer,
    accounting,
    arms: {
      B: armRecord(arms.B, normalized.B, null, null),
      B_prime: armRecord(arms.B_prime, normalized.B_prime, null, null),
      C: armRecord(arms.C, normalized.C, null, promptFor(seen, 'decision_synthesis', 0)),
      // H-03: a skipped D1 is a legal shape, not a hole. It records what did NOT happen
      // as raw fact so the verifier can insist nothing happened, rather than merely
      // finding nothing.
      D1: arms.D1.skipped
        ? { skipped: true, reason: arms.D1.reason, calls: [] }
        : {
            ...armRecord(arms.D1, normalized.D1, promptFor(seen, 'self_review'), promptFor(seen, 'decision_synthesis', 1)),
            // H-04 §8.5: raw identity, so the verifier can compare it against the
            // recomputed selectedIssue itself. Never a `targetMatched: true` field.
            selfReview: {
              agentId: arms.D1.result.selfReview.agentId,
              provider: arms.D1.result.selfReview.provider,
              promptSha256: arms.D1.result.selfReview.promptSha256,
            },
          },
    },
    blindPairs,
  };
}

function armRecord(armRun, normalizedAnswer, selfReviewPrompt, decisionPrompt) {
  return {
    skipped: false,
    calls: armRun.calls,
    report: armRun.result.report,
    finalOutput: armRun.result.finalOutput,
    provisionalAnswer: armRun.result.collaboration?.provisionalAnswer ?? null,
    ...(normalizedAnswer ? { normalized: normalizedAnswer } : {}),
    ...(selfReviewPrompt ? { selfReviewPrompt } : {}),
    ...(decisionPrompt ? { decisionPrompt } : {}),
  };
}
