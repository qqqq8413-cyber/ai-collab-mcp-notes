/**
 * CBRP-STRUCTURAL-REVIEW-ORDER-v1
 *
 * Deterministic dispatch order for the initial R1/R2 pass over the frozen pool.
 * No PRNG, no seed shopping, no outcome input -- the order is a pure function of
 * each candidate's own immutable identity, computable before any reviewer has
 * been called. Frozen by CWP-10G; see CBRP_STRUCTURAL_REVIEW_PROTOCOL_1.md §9.
 *
 * R3 order is not a separate derivation: it is this same frozen order, filtered
 * to the tasks a completed R1/R2 pass found disagreeing (see
 * `structural-review-runner.mjs`'s `computeR3Plan`). `Array.prototype.filter`
 * preserves relative order, so no second ordering rule is needed or defined.
 */

import crypto from 'node:crypto';

export const ORDER_VERSION = 'CBRP-STRUCTURAL-REVIEW-ORDER-v1';

const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * `reviewOrderKey = SHA256("CBRP-STRUCTURAL-REVIEW-ORDER-v1\n" + taskCandidateId +
 * "\n" + taskSha256)`, lowercase hex.
 */
export function computeReviewOrderKey({ taskCandidateId, taskSha256 }) {
  if (typeof taskCandidateId !== 'string' || !taskCandidateId) {
    throw new TypeError('computeReviewOrderKey: taskCandidateId must be a non-empty string');
  }
  if (typeof taskSha256 !== 'string' || !taskSha256) {
    throw new TypeError('computeReviewOrderKey: taskSha256 must be a non-empty string');
  }
  return sha256(`${ORDER_VERSION}\n${taskCandidateId}\n${taskSha256}`);
}

/**
 * Sorts candidates ascending by `reviewOrderKey`, lowercase-hexadecimal
 * lexicographic. Input array order and storage order never affect the result --
 * the sort key depends only on each candidate's own `taskCandidateId` and
 * `taskSha256`. Returns new objects; input candidates are not mutated.
 *
 * @param {Array<{ taskCandidateId: string, taskSha256: string }>} candidates
 */
export function computeStructuralReviewOrder(candidates) {
  if (!Array.isArray(candidates)) {
    throw new TypeError('computeStructuralReviewOrder: candidates must be an array');
  }
  return candidates
    .map((c) => ({ ...c, reviewOrderKey: computeReviewOrderKey(c) }))
    .sort((a, b) => (a.reviewOrderKey < b.reviewOrderKey ? -1 : a.reviewOrderKey > b.reviewOrderKey ? 1 : 0));
}
