/**
 * M2B-PROTOCOL-0.3 — Option 3'-H, Heterogeneous Round 1.
 *
 * The amendment is encoded as executable constants, not only as prose, so that the design
 * document and anything that later executes against it cannot drift apart silently. The
 * offline test suite asserts both directions: that these constants say what the protocol
 * says, and that the protocol document still says what these constants encode.
 *
 * Nothing here calls a provider, and nothing here authorizes a call.
 *
 * ## What changed from Option 3'
 *
 * Option 3' pinned every specialist of a fixture to one provider, which made the target's
 * provider known before the Gate existed to choose a target. Option 3'-H pins provider to
 * *role* instead, globally. The consequence for the main estimand is unchanged — C and D-1
 * target the same selected specialist in the same fixture, so they still resolve to the
 * same provider and model — but the target provider is no longer knowable in advance,
 * because it now follows whichever specialist the Gate selects. That is why designed
 * target rotation is demoted to observed coverage rather than kept as a requirement.
 */

export const PROTOCOL_VERSION = 'M2B-PROTOCOL-0.3';
export const SUPERSEDED_VERSION = 'M2B-PROTOCOL-0.2';
export const AMENDMENT_NAME = "Option 3'-H — Heterogeneous Round1";

/**
 * Role -> provider, fixed globally. Deliberately NOT indexed by fixture: a mapping that
 * varied per fixture would reintroduce the provider/fixture collinearity this replaces.
 */
export const ROLE_PROVIDER_MAP = Object.freeze({
  business_strategist: Object.freeze({ provider: 'claude', model: 'claude-sonnet-5' }),
  market_researcher: Object.freeze({ provider: 'gemini', model: 'gemini-3.1-pro-preview' }),
  brand_creative: Object.freeze({ provider: 'openai', model: 'gpt-5' }),
});

export const CHIEF_PIN = Object.freeze({ provider: 'openai', model: 'gpt-5' });

/** The planner still chooses how many specialists and what each is asked to do. */
export const PLANNER_FREEDOM = Object.freeze(['specialist count', 'specialist selection', 'mission text']);

/**
 * Resolves the pinned routing for one specialist.
 *
 * The C/D-1 invariant follows from this being a function of the agent alone: two arms that
 * target the same agent in the same fixture cannot resolve to different models, because
 * neither the arm nor the fixture is an input.
 */
export function routingFor(agentId) {
  const pin = ROLE_PROVIDER_MAP[agentId];
  if (!pin) throw new Error(`no role-provider pin for "${agentId}"`);
  return pin;
}

/** The non-negotiable matching constraint, restated so a test can execute it. */
export function cd1TargetInvariantHolds(agentId) {
  const c = routingFor(agentId);
  const d1 = routingFor(agentId);
  return c.provider === d1.provider && c.model === d1.model;
}

/**
 * Target-provider rotation is now an OBSERVED property of what the Gate happened to
 * select, never a reason to choose one fixture over another.
 */
export const TARGET_PROVIDER_ROTATION = Object.freeze({
  status: 'SECONDARY — OBSERVED EXECUTION COVERAGE',
  isSelectionCriterion: false,
  rule: 'A fixture may never be chosen, kept or dropped to obtain provider coverage.',
});

/**
 * The acquisition pool: three archetypes, three tasks each, the third held as reserve.
 *
 * All nine must be authored, hashed, ordered, committed and pushed in one freeze before
 * any live call. Authoring them is NOT part of this amendment round.
 */
export const ARCHETYPE_SLOTS = Object.freeze({
  STRATEGY: Object.freeze(['S1', 'S2', 'S3']),
  EXECUTION_CONSTRAINT: Object.freeze(['E1', 'E2', 'E3']),
  EVIDENCE_INTERPRETATION: Object.freeze(['I1', 'I2', 'I3']),
});

export const RESERVE_SLOTS = Object.freeze(['S3', 'E3', 'I3']);

export const ACQUISITION_POOL_SIZE = 9;

/** Wave N attempts only the slots still unfilled after wave N-1. */
export const WAVES = Object.freeze([
  Object.freeze(['S1', 'E1', 'I1']),
  Object.freeze(['S2', 'E2', 'I2']),
  Object.freeze(['S3', 'E3', 'I3']),
]);

export const ONE_ATTEMPT_PER_TASK = true;

/**
 * Given which archetypes are already filled, the slots a wave may actually attempt.
 *
 * An archetype that is already filled contributes nothing to later waves: attempting it
 * again would be spending a one-shot task to look for a better version of a slot that is
 * already closed, which is cherry-picking with extra steps.
 */
export function slotsForWave(waveIndex, filledArchetypes) {
  const archetypeOf = (slot) =>
    Object.entries(ARCHETYPE_SLOTS).find(([, slots]) => slots.includes(slot))[0];
  return WAVES[waveIndex].filter((slot) => !filledArchetypes.includes(archetypeOf(slot)));
}

/** F1-F7 are unchanged by this amendment. Listed so a test can assert they did not move. */
export const ELIGIBILITY_CRITERIA = Object.freeze(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7']);

/**
 * F4 is now authored during acquisition by a fresh clean-room Gemini session, A2.
 *
 * What A2 may see is a whitelist, not a guideline. It excludes the intended archetype
 * specifically: an annotator told which archetype a task was written to produce would be
 * confirming a label rather than reading the text, and F4 would stop being independent of
 * the thing it is supposed to qualify.
 */
export const F4_AUTHORITY = Object.freeze({
  author: 'fresh clean-room Gemini session A2',
  authoredDuring: 'acquisition',
  maySee: Object.freeze(['task', 'missions', 'actual Round1', 'passage IDs', 'output schema']),
  mustNotSee: Object.freeze(['intended archetype', 'Gate output', 'arm outputs', 'gold issues']),
  outputFields: Object.freeze(['materialConflict', 'conflictArchetype', 'summary', 'passageIds']),
});

/** A candidate fills a preregistered slot only when both conditions hold. */
export function fillsArchetypeSlot(annotation, preregisteredArchetype) {
  return annotation.materialConflict === true && annotation.conflictArchetype === preregisteredArchetype;
}

/**
 * Same decision reached by different reasoning is not, by itself, a material conflict.
 *
 * Recorded as an executable rule because it is the exact case that would otherwise be
 * argued into a pass when a slot is proving hard to fill.
 */
export const SAME_DECISION_DIFFERENT_REASONING_IS_NOT_CONFLICT = true;

export const NEGATIVE_CONTROL = Object.freeze({
  fixtureId: 'fxr-08',
  rerun: false,
  assessedBy: 'the same clean-room A2',
  expected: Object.freeze({ materialConflict: false }),
  onUnexpectedTrue: 'STOP — return to GPT review',
});

/** Claims this protocol may not support, at any stage of the work it authorizes. */
export const FORBIDDEN_CLAIMS = Object.freeze([
  'pure peer-information value',
  'homogeneous deployment generalization',
  'cross-provider generalization',
  'provider heterogeneity caused the observed conflict',
]);

export const CLAIM_BOUNDARY = Object.freeze({
  fixtureAcquisition: 'NO EFFECTIVENESS CLAIM',
  pilot: 'DOES NOT ANSWER EFFECTIVENESS',
  formalCGreaterThanD1: 'only after a later formal study, and only for the preregistered heterogeneous fixture population',
});
