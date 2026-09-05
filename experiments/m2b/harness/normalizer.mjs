/**
 * Deterministic normalization for blind evaluation (protocol §10.1).
 *
 * The line this module has to hold: runtime metadata may be removed, content may not.
 * The test is whether the text was produced by the runtime or written by the model. The
 * banner is emitted by `buildOutputBanner`, so it goes. A sentence in which the model says
 * it cannot verify a number is the model's own words, so it stays — removing hedges would
 * change what the judge is scoring, in the direction of whichever arm hedges more.
 *
 * Everything here is a pure function of its input. The same raw answer normalizes to the
 * same bytes every time, and `verify.mjs` re-runs it to prove the committed normalized
 * answers were not hand-edited.
 */
import { createHash } from 'node:crypto';

export class NormalizationError extends Error {}

/** Removals this module is allowed to perform, stated so a reviewer can audit the list. */
export const PERMITTED_REMOVALS = Object.freeze([
  'evidence banner produced by buildOutputBanner',
  'arm label',
  'provider identity label',
  'model identity label',
  'run/experiment identifiers',
]);

/** Things it must never do. Present as documentation and asserted by the offline tests. */
export const FORBIDDEN_EDITS = Object.freeze([
  'rewriting the answer',
  'shortening or summarizing',
  'fixing grammar or tone',
  'removing caveats or uncertainty statements',
  'padding or truncating to equalize length',
  'reordering or reformatting substantive content',
]);

/**
 * @param {string} finalOutput  the arm's finalOutput, banner included
 * @param {string} banner       the banner for this run, from `buildOutputBanner`
 * @returns {{text:string, sha256:string, removedBannerChars:number}}
 */
export function normalizeAnswer(finalOutput, banner) {
  if (typeof finalOutput !== 'string' || finalOutput.length === 0) {
    throw new NormalizationError('normalizeAnswer: finalOutput must be a non-empty string');
  }
  if (typeof banner !== 'string') {
    throw new NormalizationError('normalizeAnswer: banner must be a string');
  }
  if (banner.length > 0 && !finalOutput.startsWith(banner)) {
    throw new NormalizationError(
      'normalizeAnswer: finalOutput does not start with the supplied banner; ' +
        'refusing to guess what to strip'
    );
  }

  // Exactly one operation: drop the banner prefix. Nothing is trimmed, re-wrapped or
  // re-cased, because every one of those would be a content edit under some input.
  const text = finalOutput.slice(banner.length);
  if (text.length === 0) {
    throw new NormalizationError('normalizeAnswer: nothing left after removing the banner');
  }

  return {
    text,
    sha256: createHash('sha256').update(text).digest('hex'),
    removedBannerChars: banner.length,
  };
}

/**
 * Proves a committed normalized answer is what the normalizer produces from the raw one.
 * Used by `verify.mjs`; this is what makes "deterministic" checkable rather than claimed.
 */
export function verifyNormalization(finalOutput, banner, claimedText) {
  const produced = normalizeAnswer(finalOutput, banner);
  return { deterministic: produced.text === claimedText, expectedSha256: produced.sha256 };
}
