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
 * `dispatchLiveStructuralReview` is the guarded bridge to the offline-tested
 * CWP-10H harness. A default call still throws before loading any transport;
 * future LIVE execution additionally requires the harness's explicit flag,
 * authorized base, credentials, runtime/source checks, and durable reservation.
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
 * Per-round generation envelopes -- CWP-11B / CBRP-STRUCTURAL-REVIEW-EXECUTION-
 * AMENDMENT-1. Everything else about a review call (rubric, prompt bytes, blind
 * id, review order, exact provider/model pin, R1-then-R2 ordering, one attempt,
 * no retry/fallback/substitution) is unchanged and unchangeable per round -- only
 * `maxOutputTokens` and (for Gemini) `thinkingLevel` vary, and only because
 * ROUND_0's real execution recorded a Gemini R2 session terminating on
 * MAX_TOKENS (`V21-B01-S00-EI-02-R2`, see structural-review-round-0/raw/) before
 * it could emit a complete response.
 *
 * ROUND_0 is historical and immutable: its envelope is recorded here exactly as
 * it was actually run (uniform 4096, no explicit thinkingLevel -- i.e. whatever
 * the SDK's implicit default was), so a round id is never ambiguous about what
 * request shape produced its evidence. ROUND_1 stopped before dispatch on source
 * drift. ROUND_2 carries the identical Amendment-1 envelope and remains
 * offline-prepared and LIVE-unauthorized until a separate GPT packet grants it.
 *
 * Keyed by provider, not by R1/R2/R3 role label, because R3's role is always
 * "R3" but its provider is whichever CBRP-D3-v1 selected -- the same provider
 * that would have filled R1 or R2, and so the same envelope that role gets.
 */
export const GENERATION_ENVELOPES = Object.freeze({
  ROUND_0: Object.freeze({
    roundId: 'ROUND_0',
    claude: Object.freeze({ maxOutputTokens: 4096 }),
    gemini: Object.freeze({ maxOutputTokens: 4096 }),
  }),
  ROUND_1: Object.freeze({
    roundId: 'ROUND_1',
    amendmentVersion: 'CBRP-STRUCTURAL-REVIEW-EXECUTION-AMENDMENT-1',
    claude: Object.freeze({ maxOutputTokens: 4096 }),
    gemini: Object.freeze({ maxOutputTokens: 32768, thinkingLevel: 'medium' }),
  }),
  ROUND_2: Object.freeze({
    roundId: 'ROUND_2',
    amendmentVersion: 'CBRP-STRUCTURAL-REVIEW-EXECUTION-AMENDMENT-1',
    claude: Object.freeze({ maxOutputTokens: 4096 }),
    gemini: Object.freeze({ maxOutputTokens: 32768, thinkingLevel: 'medium' }),
  }),
});

/**
 * Looks up the generation envelope for one provider under one round. Fails
 * closed (throws) on an unknown round id or an unknown provider rather than
 * silently falling back to some default -- a round or a provider this function
 * has not been told about is a configuration gap, never a reason to guess.
 */
export function generationEnvelopeFor(roundId, provider) {
  const round = GENERATION_ENVELOPES[roundId];
  if (!round) {
    throw new TypeError(`generationEnvelopeFor: unknown roundId ${JSON.stringify(roundId)}`);
  }
  const envelope = round[provider];
  if (!envelope) {
    throw new TypeError(`generationEnvelopeFor: unknown provider ${JSON.stringify(provider)} for round ${roundId}`);
  }
  return envelope;
}

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
 * Guarded future LIVE entrypoint. Dynamic import keeps ordinary tests/imports
 * away from provider transport construction; the harness repeats the flag
 * guard and enforces every remaining precondition.
 */
export async function dispatchLiveStructuralReview(options = {}) {
  if (options.liveExecution !== true) {
    throw new Error(
      'CBRP-STRUCTURAL-REVIEW-PROTOCOL-1: LIVE dispatch is not authorized without ' +
      'an explicit liveExecution: true flag and a separate GPT execution packet.'
    );
  }
  const { dispatchStructuralReviewLive } = await import('./structural-review-live-harness-v1.mjs');
  return dispatchStructuralReviewLive(options);
}
