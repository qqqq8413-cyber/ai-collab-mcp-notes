/**
 * CBRP-STRUCTURAL-REVIEW-PROTOCOL-1 -- plan composition and the guarded future
 * LIVE entrypoint.
 *
 * Frozen by CWP-10G. This module composes the pure building blocks
 * (structural-review-prompt-v1, structural-review-order-v1,
 * structural-review-decision-v1, structural-review-extractor-v1) into the
 * initial R1/R2 dispatch plan and the post-pass R3 plan. Every exported
 * function up to `dispatchLiveStructuralReview` is pure: no network I/O, no
 * filesystem access beyond what the caller already resolved, no provider
 * calls, no side effects.
 *
 * `dispatchLiveStructuralReview` is deliberately unimplemented. CWP-10G's
 * authorization is OFFLINE METHODOLOGY / EXECUTION-HARNESS FREEZE only --
 * building a real Anthropic/Gemini dispatch path now, with no LIVE
 * authorization to exercise or validate it against, would be untested code
 * shipped as if it were trustworthy. The guard keeps that gap honest: calling
 * it always throws, so no test, import, or accidental invocation can reach a
 * provider from this file. A future execution packet carrying explicit LIVE
 * authorization is the one that gets to write this function's body.
 */

import { buildStructuralReviewPrompt } from './structural-review-prompt-v1.mjs';
import { computeStructuralReviewOrder } from './structural-review-order-v1.mjs';
import { computeStructuralD3Selector } from './structural-review-decision-v1.mjs';

export const PROTOCOL_VERSION = 'CBRP-STRUCTURAL-REVIEW-PROTOCOL-1';

/** Unchanged from CBRP_MODEL_PINS_PREREG_DRAFT.md §3 -- reproduced, not redefined. */
export const REVIEWER_PINS = Object.freeze({
  R1: Object.freeze({ provider: 'claude', model: 'claude-opus-5', modelFamily: 'CLAUDE_FAMILY' }),
  R2: Object.freeze({ provider: 'gemini', model: 'gemini-3.8-flash', modelFamily: 'GEMINI_FAMILY' }),
});

/** CBRP_STRUCTURAL_REVIEW_PROTOCOL_1.md §10. */
export const CALL_BUDGET = Object.freeze({
  mandatoryR1: 60,
  mandatoryR2: 60,
  mandatoryTotal: 120,
  maxR3: 60,
  maxTotal: 180,
  maxAttemptsPerSession: 1,
});

/**
 * Computes the deterministic R1/R2 dispatch plan for a frozen 60-task pool.
 * Pure -- `rubricPasteBytes` must be supplied by the caller (e.g. from
 * `loadFrozenRubricPasteBytes()`) so this function never has a hidden
 * filesystem dependency of its own.
 *
 * @param {{ pool: Array<{ taskCandidateId: string, taskSha256: string,
 *           stratumCode: string, taskText: string }>, rubricPasteBytes: string }} input
 */
export function computeInitialReviewPlan({ pool, rubricPasteBytes }) {
  if (!Array.isArray(pool)) {
    throw new TypeError('computeInitialReviewPlan: pool must be an array');
  }
  const order = computeStructuralReviewOrder(
    pool.map(({ taskCandidateId, taskSha256 }) => ({ taskCandidateId, taskSha256 }))
  );
  const byId = new Map(pool.map((task) => [task.taskCandidateId, task]));

  return order.map(({ taskCandidateId, reviewOrderKey }) => {
    const task = byId.get(taskCandidateId);
    const prompt = buildStructuralReviewPrompt({
      trueCandidateId: task.taskCandidateId,
      stratumCode: task.stratumCode,
      taskText: task.taskText,
      rubricPasteBytes,
    });
    return {
      taskCandidateId,
      reviewOrderKey,
      blindTaskId: prompt.blindTaskId,
      r1: { reviewId: `${taskCandidateId}-R1`, reviewRole: 'R1', ...REVIEWER_PINS.R1, prompt },
      r2: { reviewId: `${taskCandidateId}-R2`, reviewRole: 'R2', ...REVIEWER_PINS.R2, prompt },
    };
  });
}

/**
 * Computes the R3 batch after all 60 R1/R2 pairs are settled: filters the
 * already-frozen initial order to disagreeing tasks only (order preserved --
 * §15 forbids launching R3 immediately after the first disagreement), and
 * derives each one's D3 route from the TRUE candidate id, never the blind one.
 *
 * @param {{ initialPlan: ReturnType<typeof computeInitialReviewPlan>,
 *           reviewResultsByTaskId: Map<string, { r1Review: object, r2Review: object }> }} input
 */
export function computeR3Plan({ initialPlan, reviewResultsByTaskId }) {
  if (!Array.isArray(initialPlan)) {
    throw new TypeError('computeR3Plan: initialPlan must be an array');
  }
  const disagreeing = initialPlan.filter(({ taskCandidateId }) => {
    const results = reviewResultsByTaskId.get(taskCandidateId);
    if (!results) {
      throw new Error(`computeR3Plan: no R1/R2 results recorded for ${taskCandidateId}`);
    }
    return results.r1Review.overallPass !== results.r2Review.overallPass;
  });

  return disagreeing.map(({ taskCandidateId, reviewOrderKey, blindTaskId, r1 }) => {
    const d3 = computeStructuralD3Selector(taskCandidateId);
    return {
      taskCandidateId,
      reviewOrderKey,
      blindTaskId,
      r3: {
        reviewId: `${taskCandidateId}-R3`,
        reviewRole: 'R3',
        provider: d3.provider,
        model: d3.model,
        modelFamily: d3.modelFamily,
        prompt: r1.prompt, // byte-identical to R1/R2's prompt for this task, per §6/§13
        d3SelectorInput: d3.selectorInput,
        d3Selector: d3.selector,
      },
    };
  });
}

/**
 * Guarded future LIVE entrypoint. Always throws in CWP-10G. See the module
 * docstring for why this is a stub rather than a real (untestable) dispatch
 * implementation.
 */
export async function dispatchLiveStructuralReview() {
  throw new Error(
    'CBRP-STRUCTURAL-REVIEW-PROTOCOL-1: LIVE dispatch is not authorized. ' +
    'This entrypoint is a guarded stub frozen by CWP-10G; it must not be implemented ' +
    'or called before a future GPT execution packet grants explicit LIVE authorization ' +
    'for structural review.'
  );
}
