/**
 * Blind pair builder (protocol §10.4).
 *
 * Produces what the judge sees and, separately, the map that says what it was. The two
 * must never travel together: `pairs.json` is the judge's input and carries no arm,
 * provider or model; `assignments.json` is withheld until judging is done.
 *
 * Order is counterbalanced rather than randomized for the pilot, because randomizing makes
 * order bias into noise without measuring it, and the pilot's job is to measure it
 * (protocol §20.3).
 */
import { createHash } from 'node:crypto';

export class PairLeakageDetected extends Error {}

/** Tokens that must never appear in a judge-facing pair. */
const FORBIDDEN_KEYS = ['arm', 'provider', 'model', 'requestedModel', 'resolvedModel', 'runIndex', 'ms', 'timings'];

const pairId = (fixtureId, runIndex, left, right, order) =>
  createHash('sha256').update(`${fixtureId}|${runIndex}|${left}|${right}|${order}`).digest('hex').slice(0, 16);

/**
 * @param {object} input
 * @param {string} input.fixtureId
 * @param {number} input.runIndex
 * @param {Record<string,{text:string}>} input.normalized   arm -> normalized answer
 * @param {Array<[string,string]>} input.comparisons        e.g. [['B','B_prime'],['B_prime','C'],['C','D1']]
 * @param {boolean} [input.counterbalance]                  emit both orders of each comparison
 */
export function buildBlindPairs({ fixtureId, runIndex, normalized, comparisons, counterbalance = true }) {
  const pairs = [];
  const assignments = [];

  for (const [armA, armB] of comparisons) {
    for (const [first, second] of counterbalance ? [[armA, armB], [armB, armA]] : [[armA, armB]]) {
      const left = normalized[first];
      const right = normalized[second];
      if (!left || !right) throw new Error(`buildBlindPairs: missing normalized answer for ${first} or ${second}`);

      const order = `${first}->${second}`;
      const id = pairId(fixtureId, runIndex, armA, armB, order);
      pairs.push({ pairId: id, answerX: left.text, answerY: right.text });
      assignments.push({ pairId: id, fixtureId, runIndex, comparison: `${armA} vs ${armB}`, answerX: first, answerY: second });
    }
  }

  assertPairsBlind(pairs);
  return { pairs, assignments };
}

/**
 * Fails if a judge-facing pair carries anything identifying.
 *
 * Only structural leakage is in scope. An answer whose own wording betrays its arm cannot
 * be fixed here — editing it is forbidden — so protocol §10.3 measures that separately
 * with a leakage audit instead of pretending this check covers it.
 */
export function assertPairsBlind(pairs) {
  for (const pair of pairs) {
    for (const key of Object.keys(pair)) {
      if (!['pairId', 'answerX', 'answerY'].includes(key)) {
        throw new PairLeakageDetected(`blind pair carries a non-blind field: "${key}"`);
      }
    }
    for (const key of FORBIDDEN_KEYS) {
      if (Object.hasOwn(pair, key)) throw new PairLeakageDetected(`blind pair carries "${key}"`);
    }
  }
  return { pairs: pairs.length, structuralCheckOnly: true, contentLeakageMeasuredBy: 'protocol §10.3 leakage audit' };
}
