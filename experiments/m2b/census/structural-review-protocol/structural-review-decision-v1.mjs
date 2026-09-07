/**
 * CBRP-STRUCTURAL-REVIEW-DECISION-1
 *
 * The frozen boolean procedure that turns a structural reviewer's parsed JSON
 * object into a validated review, and R1/R2/(R3) validated reviews into one
 * final per-task admission decision. Frozen by CWP-10G; see
 * CBRP_STRUCTURAL_REVIEW_PROTOCOL_1.md §6-§8. Pure and content-blind: nothing
 * here reads task text, scores likelihood, or exercises operator discretion --
 * see §22's "no semantic operator override" invariant, which this module exists
 * to make structurally true rather than merely promised.
 */

import crypto from 'node:crypto';

const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

/** Exact accepted key set for a reviewer's parsed JSON object -- no more, no fewer. */
export const REVIEW_OBJECT_KEYS = Object.freeze([
  'taskId',
  'stratumCorrect',
  'primaryOutputClear',
  'selfContained',
  'realistic',
  'noExperimentLeakage',
  'noSpecialistSteering',
  'overallPass',
  'reasons',
]);

/** The six judgements whose conjunction `overallPass` must equal exactly. */
export const BOOLEAN_CHECK_KEYS = Object.freeze([
  'stratumCorrect',
  'primaryOutputClear',
  'selfContained',
  'realistic',
  'noExperimentLeakage',
  'noSpecialistSteering',
]);

/**
 * Validates one reviewer's parsed JSON object against the frozen schema and the
 * `overallPass` AND-invariant. Fails closed -- returns `{ ok: false, reason }`,
 * never throws, never repairs -- on: a non-object value; any missing or extra
 * key; a non-string or mismatched `taskId`; any of the six checks or
 * `overallPass` not being a strict boolean (a string `"true"`/`"false"` or a
 * `null` both fail this, deliberately); an empty or non-string `reasons`; or an
 * `overallPass` that does not equal the AND of the six checks.
 *
 * @param {unknown} parsed
 * @param {{ expectedBlindTaskId: string }} context
 */
export function validateReviewObject(parsed, { expectedBlindTaskId }) {
  if (typeof expectedBlindTaskId !== 'string' || !expectedBlindTaskId) {
    throw new TypeError('validateReviewObject: expectedBlindTaskId must be a non-empty string');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'review object must be a JSON object' };
  }

  const actualKeys = Object.keys(parsed);
  const missing = REVIEW_OBJECT_KEYS.filter((k) => !actualKeys.includes(k));
  const extra = actualKeys.filter((k) => !REVIEW_OBJECT_KEYS.includes(k));
  if (missing.length > 0 || extra.length > 0) {
    return {
      ok: false,
      reason: `review object key set mismatch (missing: ${JSON.stringify(missing)}, extra: ${JSON.stringify(extra)})`,
    };
  }

  if (typeof parsed.taskId !== 'string' || parsed.taskId !== expectedBlindTaskId) {
    return {
      ok: false,
      reason: `taskId ${JSON.stringify(parsed.taskId)} does not equal the expected blindTaskId ${JSON.stringify(expectedBlindTaskId)}`,
    };
  }

  for (const key of BOOLEAN_CHECK_KEYS) {
    if (typeof parsed[key] !== 'boolean') {
      return { ok: false, reason: `${key} must be a boolean, got ${JSON.stringify(parsed[key])}` };
    }
  }
  if (typeof parsed.overallPass !== 'boolean') {
    return { ok: false, reason: `overallPass must be a boolean, got ${JSON.stringify(parsed.overallPass)}` };
  }
  if (typeof parsed.reasons !== 'string' || parsed.reasons.length === 0) {
    return { ok: false, reason: 'reasons must be a non-empty string' };
  }

  const expectedOverallPass = BOOLEAN_CHECK_KEYS.every((key) => parsed[key] === true);
  if (parsed.overallPass !== expectedOverallPass) {
    return {
      ok: false,
      reason: `overallPass (${parsed.overallPass}) does not equal the AND of the six checks (${expectedOverallPass})`,
    };
  }

  return { ok: true, review: { ...parsed } };
}

/** ADMISSION DISAGREEMENT is defined as exactly this, and only this (§12). */
export function admissionDisagreement(r1Review, r2Review) {
  return r1Review.overallPass !== r2Review.overallPass;
}

/**
 * Descriptive only: which of the six checks the two reviewers disagreed on, even
 * when their `overallPass` values happen to agree. Never fed into the R3 trigger
 * or the final decision -- per §12, field-level disagreement does not
 * independently trigger R3, and this module does not construct a second voting
 * mechanism out of it.
 */
export function describeCheckLevelDisagreement(r1Review, r2Review) {
  return BOOLEAN_CHECK_KEYS.filter((key) => r1Review[key] !== r2Review[key]);
}

/**
 * The single frozen decision procedure. `r3Review` is `null`/omitted when R1 and
 * R2 agreed (the only case in which R3 must not run); otherwise it must be
 * supplied for the majority computation.
 *
 * @param {{ r1Review: object, r2Review: object, r3Review?: object|null }} input
 * @returns {{ ok: true, finalPass: boolean, disagreement: boolean, r3Required: boolean,
 *             checkLevelDisagreement: string[] }
 *         | { ok: false, reason: string, r3Required?: boolean, disagreement?: boolean }}
 */
export function decideStructuralReview({ r1Review, r2Review, r3Review = null }) {
  const disagreement = admissionDisagreement(r1Review, r2Review);
  const checkLevelDisagreement = describeCheckLevelDisagreement(r1Review, r2Review);

  if (!disagreement) {
    if (r3Review) {
      return { ok: false, reason: 'R3 supplied but R1/R2 overallPass already agree -- R3 must not run' };
    }
    return { ok: true, finalPass: r1Review.overallPass, disagreement: false, r3Required: false, checkLevelDisagreement };
  }

  if (!r3Review) {
    return { ok: false, reason: 'R1/R2 overallPass disagree -- R3 is required', disagreement: true, r3Required: true };
  }

  const votes = [r1Review.overallPass, r2Review.overallPass, r3Review.overallPass];
  const passCount = votes.filter((v) => v === true).length;
  return {
    ok: true,
    finalPass: passCount >= 2,
    disagreement: true,
    r3Required: true,
    checkLevelDisagreement,
  };
}

// --- CBRP-D3-v1, structural route -----------------------------------------
//
// Unchanged from CBRP_MODEL_PINS_PREREG_DRAFT.md §7.1 -- reproduced here as the
// one executable implementation, since none existed before CWP-10G. The
// duplicate-audit route (§7.2) is out of scope: no duplicate audit exists yet
// to route.

export const D3_VERSION = 'CBRP-D3-v1';

const D3_CLAUDE = Object.freeze({ provider: 'claude', model: 'claude-opus-5', modelFamily: 'CLAUDE_FAMILY' });
const D3_GEMINI = Object.freeze({ provider: 'gemini', model: 'gemini-3.8-flash', modelFamily: 'GEMINI_FAMILY' });

/**
 * `selectorInput = "CBRP-D3-v1\nSTRUCTURAL\n" + trueCandidateId`; `selector =
 * SHA256(selectorInput)` lowercase hex; only the first hex character is read:
 * `0-7` routes to Claude, `8-f` to Gemini. Takes the TRUE candidate id, never
 * the blind task id -- D3 routing is operator-side and must never be computable
 * by, or from, anything the model saw.
 */
export function computeStructuralD3Selector(trueCandidateId) {
  if (typeof trueCandidateId !== 'string' || !trueCandidateId) {
    throw new TypeError('computeStructuralD3Selector: trueCandidateId must be a non-empty string');
  }
  const selectorInput = `${D3_VERSION}\nSTRUCTURAL\n${trueCandidateId}`;
  const selector = sha256(selectorInput);
  const route = '01234567'.includes(selector[0]) ? D3_CLAUDE : D3_GEMINI;
  return { selectorInput, selector, ...route };
}
