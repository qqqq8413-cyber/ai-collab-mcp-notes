/**
 * CBRP-DUPLICATE-AUDIT-RUNNER-1
 *
 * Composes the frozen building blocks (prompt, order, decision) into a round
 * plan: the D1/D2 session pair, and -- once D1/D2 have both completed -- the
 * complete D3 route plan and its durable manifest shape. Frozen by CWP-12A;
 * see CBRP_CORPUS_DUPLICATE_AUDIT_PROTOCOL_1.md §8.4, §9, §16. Pure: no I/O,
 * no provider call, no filesystem dependency. The guarded LIVE dispatch
 * boundary (durability, reservations, transport) lives in
 * duplicate-audit-live-harness-v1.mjs, mirroring the
 * structural-review-runner.mjs / structural-review-live-harness-v1.mjs split.
 */

import { computePairUniverse } from './duplicate-audit-order-v1.mjs';
import { computeDuplicateD3Selector, D3_VERSION } from './duplicate-audit-decision-v1.mjs';
import { buildD1D2Prompt, buildD3Prompt } from './duplicate-audit-prompt-v1.mjs';

export const PROTOCOL_VERSION = 'CBRP-CORPUS-DUPLICATE-AUDIT-PROTOCOL-1';

/** §16: the round-state values a validation/evidence record must distinguish. */
export const ROUND_STATES = Object.freeze({
  PRE_DISPATCH: 'PRE_DISPATCH',
  D1_COMPLETE: 'D1_COMPLETE',
  D2_COMPLETE: 'D2_COMPLETE',
  D3_REQUIRED: 'D3_REQUIRED',
  D3_COMPLETE: 'D3_COMPLETE',
  ROUND_COMPLETE: 'ROUND_COMPLETE',
  FAILED_CLOSED: 'FAILED_CLOSED',
});

/** §9/§10: fixed pins, one attempt per required session, no D1/D2 call cap. */
export const CALL_BUDGET = Object.freeze({
  mandatoryD1D2PerRound: 2,
  perSessionMaxAttempts: 1,
});

export const D1_PIN = Object.freeze({ provider: 'claude', model: 'claude-opus-5', modelFamily: 'CLAUDE_FAMILY' });
export const D2_PIN = Object.freeze({ provider: 'gemini', model: 'gemini-3.8-flash', modelFamily: 'GEMINI_FAMILY' });

/**
 * CWP-12C: DUP-R00's frozen, provider-keyed generation envelope -- the
 * duplicate-audit analogue of `GENERATION_ENVELOPES` in
 * structural-review-runner.mjs. A LIVE operator cannot change
 * maxOutputTokens/thinkingLevel/temperature ad hoc: the real LIVE entrypoint
 * (duplicate-audit-live-harness-v1.mjs's `dispatchLiveDuplicateAudit`) reads
 * these values internally and does not accept them as caller-suppliable
 * parameters. D3 uses the envelope entry for whichever provider
 * CBRP-D3-v1 selects for that pair.
 *
 * Claude's `max_tokens: 32768` is mechanically representable by the
 * installed `@anthropic-ai/sdk` (0.123.0) without changing provider/model
 * semantics: `max_tokens` on the plain (non-beta) `messages.create` request
 * is typed simply as `number`, with no beta-header or endpoint-switch
 * requirement documented for that field -- unlike the SDK's separate
 * `output-128k-2025-02-19` beta flag, which applies only to the beta
 * endpoint this transport does not use. Whether the API itself honors
 * 32768 for `claude-opus-5` at request time is a LIVE-time question the
 * existing STOP_PROVIDER_ERROR / MAX_TOKENS fail-closed paths already
 * handle; it is not a build-time representability failure.
 *
 * Gemini's `maxOutputTokens: 32768` / `thinkingLevel: 'medium'` are the
 * exact values structural review's ROUND_1/ROUND_2 envelope already used in
 * real LIVE Gemini dispatches (CBRP-STRUCTURAL-REVIEW-EXECUTION-AMENDMENT-1,
 * CWP-11B), so their representability is not merely mechanical but already
 * empirically exercised by this repository.
 */
export const DUP_R00_GENERATION_ENVELOPES = Object.freeze({
  claude: Object.freeze({
    provider: 'claude', model: 'claude-opus-5',
    maxOutputTokens: 32768, thinkingLevel: null, temperature: null,
  }),
  gemini: Object.freeze({
    provider: 'gemini', model: 'gemini-3.8-flash',
    maxOutputTokens: 32768, thinkingLevel: 'medium', temperature: null,
  }),
});
export const DUP_R00_GENERATION_ENVELOPE_VERSION = 'CBRP-DUPLICATE-AUDIT-DUP-R00-GENERATION-ENVELOPE-1';

/**
 * Looks up DUP-R00's frozen envelope for one provider. Fails closed (throws)
 * on an unknown provider rather than silently falling back to a default --
 * mirrors `generationEnvelopeFor` in structural-review-runner.mjs.
 */
export function dupR00EnvelopeFor(provider) {
  const envelope = DUP_R00_GENERATION_ENVELOPES[provider];
  if (!envelope) {
    throw new TypeError(`dupR00EnvelopeFor: unknown provider ${JSON.stringify(provider)}`);
  }
  return envelope;
}

/**
 * Builds one round's complete D1/D2 session plan: the deterministic in-scope
 * pair universe (§5.1), and the two sessions (`<roundId>-D1`, `<roundId>-D2`)
 * that share byte-identical model-visible prompts (§7) and differ only in
 * their pinned provider/model.
 *
 * @param {{ roundId: string, corpusTasks: Array<{candidateId: string, taskText: string}>,
 *           auditScopeIds: string[], layerABytes: string }} input
 */
export function computeD1D2SessionPlan({ roundId, corpusTasks, auditScopeIds, layerABytes }) {
  if (typeof roundId !== 'string' || !roundId) {
    throw new TypeError('computeD1D2SessionPlan: roundId must be a non-empty string');
  }
  const corpusTaskIds = corpusTasks.map((t) => t.candidateId);
  const pairUniverse = computePairUniverse({ corpusTaskIds, auditScopeIds });
  const prompt = buildD1D2Prompt({ corpusTasks, auditScopeIds, layerABytes });
  const taskById = new Map(corpusTasks.map((t) => [t.candidateId, t]));

  const session = (role, pin) => ({
    sessionId: `${roundId}-${role}`,
    role,
    ...pin,
    prompt,
  });

  return {
    roundId,
    corpusTaskIds: [...corpusTaskIds].sort(),
    auditScopeIds: [...auditScopeIds].sort(),
    pairUniverse,
    taskById,
    d1: session('D1', D1_PIN),
    d2: session('D2', D2_PIN),
  };
}

/**
 * Derives one round's complete D3 route plan from its (already-validated,
 * already-persisted) D1/D2 outcome's `disagreementSet` -- never launched
 * before both D1 and D2 have completed and been persisted (§8.4 steps 1-4).
 * Order is preserved from `disagreementSet`, which is itself the pair
 * universe's own deterministic order filtered to disputed pairs (mirroring
 * `computeR3Plan`'s "filter preserves order, no second ordering rule" design
 * in structural-review-runner.mjs).
 *
 * @param {{ roundId: string, disagreementSet: Array<{a: string, b: string}>,
 *           taskById: Map<string, {candidateId: string, taskText: string}>,
 *           layerABytes: string }} input
 */
export function computeD3RoutePlan({ roundId, disagreementSet, taskById, layerABytes }) {
  if (typeof roundId !== 'string' || !roundId) {
    throw new TypeError('computeD3RoutePlan: roundId must be a non-empty string');
  }
  if (!Array.isArray(disagreementSet)) {
    throw new TypeError('computeD3RoutePlan: disagreementSet must be an array');
  }
  return disagreementSet.map(({ a, b }) => {
    const taskA = taskById.get(a);
    const taskB = taskById.get(b);
    if (!taskA || !taskB) {
      throw new Error(`computeD3RoutePlan: missing task text for pair ${a}/${b}`);
    }
    const route = computeDuplicateD3Selector(a, b);
    const prompt = buildD3Prompt({ a: taskA, b: taskB, layerABytes });
    return {
      a,
      b,
      sessionId: `${roundId}-D3-${a}__${b}`,
      role: 'D3',
      provider: route.provider,
      model: route.model,
      modelFamily: route.modelFamily,
      d3SelectorInput: route.selectorInput,
      d3Selector: route.selector,
      prompt,
    };
  });
}

/**
 * The durable §8.4 manifest shape: every D3 route for a round, materialized
 * as one complete object before any D3 provider call. `routeCount` and
 * `routes` are the fields a persistence layer writes verbatim; this function
 * performs no I/O.
 */
export function buildD3RouteManifest({ roundId, d3RoutePlan }) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    d3Version: D3_VERSION,
    roundId,
    routeCount: d3RoutePlan.length,
    routes: d3RoutePlan.map((entry) => ({
      a: entry.a,
      b: entry.b,
      sessionId: entry.sessionId,
      role: entry.role,
      provider: entry.provider,
      model: entry.model,
      modelFamily: entry.modelFamily,
      d3SelectorInput: entry.d3SelectorInput,
      d3Selector: entry.d3Selector,
      promptSha256: entry.prompt.promptSha256,
    })),
  };
}
