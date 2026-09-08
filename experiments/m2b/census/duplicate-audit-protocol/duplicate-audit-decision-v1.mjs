/**
 * CBRP-DUPLICATE-AUDIT-DECISION-1
 *
 * The frozen boolean procedure that turns D1/D2's parsed JSON objects into
 * validated positive-pair sets, those sets into a per-pair D1/D2 outcome and a
 * disagreement set (§7.1-§7.4), a D3 parsed object into a validated vote
 * (§8.1), CBRP-D3-v1's duplicate-pair routing (§8.2), and a round's confirmed
 * pairs into connected components and a retention decision (§11). Frozen by
 * CWP-12A; see CBRP_CORPUS_DUPLICATE_AUDIT_PROTOCOL_1.md. Pure and
 * content-blind: nothing here reads task text, scores likelihood, or
 * exercises operator discretion -- see §11's "no discretionary choice, ever."
 */

import crypto from 'node:crypto';
import { canonicalizePair, pairKey } from './duplicate-audit-order-v1.mjs';

const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

// --- §7.1/§7.2 D1/D2 response validation ------------------------------------

const D1D2_TOP_KEYS = Object.freeze(['duplicatePairs']);
const D1D2_PAIR_KEYS = Object.freeze(['a', 'b', 'reason']);

/**
 * Validates one D1 or D2 parsed response object against §7.1's exact schema
 * and §7.2's ordered fail-closed checklist. Returns `{ ok: false, reason }`
 * on the first violation -- never throws, never repairs, never continues past
 * it to find more problems, matching this instrument's "first violation STOPs"
 * posture (§7.2). On success, returns the validated positive-pair set exactly
 * as reported (§7.4: an auditor's list is read as a complete positive set,
 * omission is a NOT DUPLICATE vote, computed later by the caller against the
 * full pair universe -- this function does not itself know the universe
 * beyond membership-checking each reported pair against it).
 *
 * @param {unknown} parsed
 * @param {{ corpusTaskIds: string[], pairUniverse: Array<{a: string, b: string}> }} context
 */
export function validateD1D2Response(parsed, { corpusTaskIds, pairUniverse }) {
  if (!Array.isArray(corpusTaskIds) || corpusTaskIds.length === 0) {
    throw new TypeError('validateD1D2Response: corpusTaskIds must be a non-empty array');
  }
  if (!Array.isArray(pairUniverse)) {
    throw new TypeError('validateD1D2Response: pairUniverse must be an array');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'response must be a JSON object' };
  }
  const topKeys = Object.keys(parsed);
  const missingTop = D1D2_TOP_KEYS.filter((k) => !topKeys.includes(k));
  const extraTop = topKeys.filter((k) => !D1D2_TOP_KEYS.includes(k));
  if (missingTop.length > 0 || extraTop.length > 0) {
    return {
      ok: false,
      reason: `top-level key set mismatch (missing: ${JSON.stringify(missingTop)}, extra: ${JSON.stringify(extraTop)})`,
    };
  }
  if (!Array.isArray(parsed.duplicatePairs)) {
    return { ok: false, reason: 'duplicatePairs must be an array' };
  }

  const corpusIdSet = new Set(corpusTaskIds);
  const universeKeySet = new Set(pairUniverse.map(pairKey));
  const seenPairKeys = new Set();
  const positivePairs = [];

  for (const [i, entry] of parsed.duplicatePairs.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { ok: false, reason: `duplicatePairs[${i}] must be an object` };
    }
    const entryKeys = Object.keys(entry);
    const missing = D1D2_PAIR_KEYS.filter((k) => !entryKeys.includes(k));
    const extra = entryKeys.filter((k) => !D1D2_PAIR_KEYS.includes(k));
    if (missing.length > 0 || extra.length > 0) {
      return {
        ok: false,
        reason: `duplicatePairs[${i}] key set mismatch (missing: ${JSON.stringify(missing)}, extra: ${JSON.stringify(extra)})`,
      };
    }
    const { a, b, reason } = entry;
    if (typeof a !== 'string' || !a || typeof b !== 'string' || !b) {
      return { ok: false, reason: `duplicatePairs[${i}] a/b must be non-empty strings` };
    }
    if (!corpusIdSet.has(a) || !corpusIdSet.has(b)) {
      return { ok: false, reason: `duplicatePairs[${i}] references an ID outside corpusTaskIds` };
    }
    if (a === b) {
      return { ok: false, reason: `duplicatePairs[${i}] has a === b (${JSON.stringify(a)})` };
    }
    if (!(a < b)) {
      return { ok: false, reason: `duplicatePairs[${i}] is not canonically ordered: a=${JSON.stringify(a)} must be < b=${JSON.stringify(b)}` };
    }
    const key = pairKey({ a, b });
    if (seenPairKeys.has(key)) {
      return { ok: false, reason: `duplicatePairs[${i}] duplicates an earlier entry for pair ${key}` };
    }
    seenPairKeys.add(key);
    if (!universeKeySet.has(key)) {
      return { ok: false, reason: `duplicatePairs[${i}] pair ${key} is outside the in-scope pair universe` };
    }
    if (typeof reason !== 'string' || reason.length === 0) {
      return { ok: false, reason: `duplicatePairs[${i}] reason must be a non-empty string` };
    }
    positivePairs.push({ a, b, reason });
  }

  return { ok: true, positivePairs };
}

// --- §8.1 D3 response validation --------------------------------------------

const D3_KEYS = Object.freeze(['isDuplicate', 'reason']);

/**
 * Validates one D3 parsed response object against §8.1's exact schema:
 * strictly boolean `isDuplicate`, non-empty string `reason`, no other keys.
 */
export function validateD3Response(parsed) {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'response must be a JSON object' };
  }
  const keys = Object.keys(parsed);
  const missing = D3_KEYS.filter((k) => !keys.includes(k));
  const extra = keys.filter((k) => !D3_KEYS.includes(k));
  if (missing.length > 0 || extra.length > 0) {
    return {
      ok: false,
      reason: `key set mismatch (missing: ${JSON.stringify(missing)}, extra: ${JSON.stringify(extra)})`,
    };
  }
  if (typeof parsed.isDuplicate !== 'boolean') {
    return { ok: false, reason: `isDuplicate must be a boolean, got ${JSON.stringify(parsed.isDuplicate)}` };
  }
  if (typeof parsed.reason !== 'string' || parsed.reason.length === 0) {
    return { ok: false, reason: 'reason must be a non-empty string' };
  }
  return { ok: true, isDuplicate: parsed.isDuplicate, reason: parsed.reason };
}

// --- §7.3/§7.4 decision matrix and disagreement derivation ------------------

/**
 * Derives, for every pair in the deterministic in-scope pair universe, D1's
 * and D2's vote (`true` only if the auditor's validated positive-pair set
 * contains that pair -- §7.4: omission from `duplicatePairs` is read as a
 * NOT DUPLICATE vote, so the full universe is the denominator, never merely
 * the union of positive reports) and the resulting §7.3 classification.
 *
 * @param {{ pairUniverse: Array<{a: string, b: string}>,
 *           d1PositivePairs: Array<{a: string, b: string}>,
 *           d2PositivePairs: Array<{a: string, b: string}> }} input
 * @returns {{ results: Array<{a: string, b: string, d1: boolean, d2: boolean,
 *             outcome: 'CONFIRMED'|'NOT_DUPLICATE'|'D3_REQUIRED'}>,
 *             confirmedPairs: Array<{a: string, b: string}>,
 *             disagreementSet: Array<{a: string, b: string}> }}
 */
export function deriveD1D2Outcome({ pairUniverse, d1PositivePairs, d2PositivePairs }) {
  if (!Array.isArray(pairUniverse)) {
    throw new TypeError('deriveD1D2Outcome: pairUniverse must be an array');
  }
  const d1Set = new Set(d1PositivePairs.map(pairKey));
  const d2Set = new Set(d2PositivePairs.map(pairKey));
  const results = [];
  const confirmedPairs = [];
  const disagreementSet = [];
  for (const pair of pairUniverse) {
    const key = pairKey(pair);
    const d1 = d1Set.has(key);
    const d2 = d2Set.has(key);
    let outcome;
    if (d1 && d2) {
      outcome = 'CONFIRMED';
      confirmedPairs.push(pair);
    } else if (!d1 && !d2) {
      outcome = 'NOT_DUPLICATE';
    } else {
      outcome = 'D3_REQUIRED';
      disagreementSet.push(pair);
    }
    results.push({ a: pair.a, b: pair.b, d1, d2, outcome });
  }
  return { results, confirmedPairs, disagreementSet };
}

/**
 * §8.1's "ordinary majority" of {D1, D2, D3} for one disputed pair. Only
 * meaningful when D1 and D2 already disagree -- majority-of-3 with a 1/1
 * split plus D3's vote always produces a clean 2/1 decision, never a tie.
 */
export function finalPairDecision({ d1, d2, d3 }) {
  const votes = [d1, d2, d3];
  const trueCount = votes.filter((v) => v === true).length;
  return trueCount >= 2;
}

// --- §8.2 CBRP-D3-v1, duplicate route ---------------------------------------

export const D3_VERSION = 'CBRP-D3-v1';

const D3_CLAUDE = Object.freeze({ provider: 'claude', model: 'claude-opus-5', modelFamily: 'CLAUDE_FAMILY' });
const D3_GEMINI = Object.freeze({ provider: 'gemini', model: 'gemini-3.8-flash', modelFamily: 'GEMINI_FAMILY' });

/**
 * `selectorInput = "CBRP-D3-v1\nDUPLICATE\n" + a + "\n" + b` with the pair
 * already canonicalized (`a` the lexicographically smaller ID); `selector =
 * SHA256(selectorInput)` lowercase hex; only the first hex character is read:
 * `0-7` routes to Claude, `8-f` to Gemini (CBRP_MODEL_PINS_PREREG_DRAFT.md
 * §7.2). Takes two candidate IDs in either order and canonicalizes them
 * itself, so the route is a property of the pair, never of which argument
 * position the caller happened to put a given ID in.
 */
export function computeDuplicateD3Selector(x, y) {
  const { a, b } = canonicalizePair(x, y);
  const selectorInput = `${D3_VERSION}\nDUPLICATE\n${a}\n${b}`;
  const selector = sha256(selectorInput);
  const route = '01234567'.includes(selector[0]) ? D3_CLAUDE : D3_GEMINI;
  return { a, b, selectorInput, selector, ...route };
}

// --- §11 connected components and retention ---------------------------------

/**
 * Groups confirmed duplicate pairs into connected components (union-find).
 * A candidate that appears in no confirmed pair is not part of any
 * component and is untouched by retention -- §11 only ever removes a member
 * of a confirmed-duplicate component.
 *
 * @param {Array<{a: string, b: string}>} confirmedPairs
 * @returns {string[][]} each component's members, ascending lexicographic
 */
export function computeConnectedComponents(confirmedPairs) {
  if (!Array.isArray(confirmedPairs)) {
    throw new TypeError('computeConnectedComponents: confirmedPairs must be an array');
  }
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur);
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (x, y) => {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent.set(rx, ry);
  };
  for (const { a, b } of confirmedPairs) {
    find(a);
    find(b);
    union(a, b);
  }
  const groups = new Map();
  for (const id of parent.keys()) {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(id);
  }
  return [...groups.values()].map((members) => [...members].sort());
}

/**
 * Applies §11's deterministic retention rule to one connected component:
 * `I = C ∩ incumbents`, `R = C ∩ focusSet`. If `I` is non-empty, every
 * member of `I` is kept and every member of `R` is rejected. If `I` is
 * empty (round 0, by construction, or any component with no incumbent
 * member), the lexicographically smallest member of `R` is kept and every
 * other member of `R` is rejected. No discretionary choice.
 *
 * @param {{ component: string[], incumbents: Set<string>, focusSet: Set<string> }} input
 */
export function applyRetentionToComponent({ component, incumbents, focusSet }) {
  if (!Array.isArray(component) || component.length === 0) {
    throw new TypeError('applyRetentionToComponent: component must be a non-empty array');
  }
  const I = component.filter((id) => incumbents.has(id));
  const R = component.filter((id) => focusSet.has(id));
  const unclassified = component.filter((id) => !incumbents.has(id) && !focusSet.has(id));
  if (unclassified.length > 0) {
    throw new Error(
      `applyRetentionToComponent: component member(s) not in incumbents or focusSet: ${JSON.stringify(unclassified)}`
    );
  }
  if (I.length > 0) {
    return { keep: [...I].sort(), reject: [...R].sort() };
  }
  const sortedR = [...R].sort();
  const smallest = sortedR[0];
  return { keep: [smallest], reject: sortedR.slice(1) };
}

/**
 * Applies retention across every connected component of a round's confirmed
 * duplicate pairs. Candidates outside every component are implicitly kept
 * (retention only ever rejects a member of a confirmed-duplicate component)
 * and are not listed here -- callers assemble the full surviving corpus as
 * `allCandidates - rejected`.
 *
 * @param {{ confirmedPairs: Array<{a: string, b: string}>,
 *           incumbents: Iterable<string>, focusSet: Iterable<string> }} input
 */
export function applyRetention({ confirmedPairs, incumbents, focusSet }) {
  const incumbentSet = new Set(incumbents);
  const focusSetSet = new Set(focusSet);
  const overlap = [...incumbentSet].filter((id) => focusSetSet.has(id));
  if (overlap.length > 0) {
    throw new Error(`applyRetention: incumbents and focusSet must be disjoint, both contain ${JSON.stringify(overlap)}`);
  }
  const components = computeConnectedComponents(confirmedPairs);
  const perComponent = components.map((component) => ({
    component,
    ...applyRetentionToComponent({ component, incumbents: incumbentSet, focusSet: focusSetSet }),
  }));
  const rejected = perComponent.flatMap((c) => c.reject).sort();
  const keptFromComponents = perComponent.flatMap((c) => c.keep).sort();
  return { components: perComponent, keptFromComponents, rejected };
}
