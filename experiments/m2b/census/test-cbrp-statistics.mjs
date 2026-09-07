/**
 * Acceptance tests for CBRP-MT-BUEHLER-1.
 *
 * These bounds decide the census verdict, so they are pinned to exact values rather than
 * to properties. The two vectors that matter most are k = 1 and k = N-1: an implementation
 * that used ordinary Clopper-Pearson throughout would agree everywhere else and be wrong
 * in exactly those places, which is the failure this method version exists to prevent.
 *
 * Deterministic and offline. No provider, no filesystem, no randomness.
 */
import assert from 'node:assert/strict';
import {
  METHOD_VERSION, ALPHA, BETA, THETA_FEAS, CBRP_N, NUMERICAL_CONTRACT, ESTIMAND_SCOPE,
  CensusStatisticsError, betaN, assertSupported, lowerBound, upperBound, decide, display,
  cpInteriorLower, cpInteriorUpper, smallestNForZeroEvent, smallestBalancedNForZeroEvent,
  TOO_SPARSE, VIABLE, INCONCLUSIVE,
} from './statistics.mjs';

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS ${name}`); passed++; }
  catch (e) { console.log(`  FAIL ${name}\n      ${e.stack}`); failed++; }
}

/** The pinned vectors are quoted to 12 decimals, so the last digit may be a rounding of the true double. */
const VECTOR_TOLERANCE = 1e-11;
const near = (actual, expected, what) =>
  assert.ok(Math.abs(actual - expected) <= VECTOR_TOLERANCE,
    `${what}: got ${actual.toPrecision(18)}, expected ${expected} (delta ${Math.abs(actual - expected).toExponential(3)})`);

console.log('\nMethod identity and numerical contract');

check('the method version and parameters are pinned', () => {
  assert.equal(METHOD_VERSION, 'CBRP-MT-BUEHLER-1');
  assert.equal(CBRP_N, 60);
  assert.equal(ALPHA, 0.05);
  assert.equal(BETA, 0.95);
  assert.equal(THETA_FEAS, 0.05);
});

check('the numerical contract is deterministic', () => {
  assert.deepEqual([...NUMERICAL_CONTRACT.bracket], [0, 1]);
  assert.ok(NUMERICAL_CONTRACT.tolerance <= 1e-14);
  assert.equal(NUMERICAL_CONTRACT.maxIterations, 200);
  assert.equal(NUMERICAL_CONTRACT.decisionComparison, 'unrounded');
  assert.equal(NUMERICAL_CONTRACT.displayDecimals, 6);
  assert.equal(NUMERICAL_CONTRACT.stochastic, false);
});

check('the same inputs produce bit-identical bounds on repeat', () => {
  for (const k of [0, 1, 3, 17, 42, 59, 60]) {
    assert.equal(lowerBound(k), lowerBound(k), `lower k=${k}`);
    assert.equal(upperBound(k), upperBound(k), `upper k=${k}`);
  }
});

check('the estimand scope names what it excludes', () => {
  assert.match(ESTIMAND_SCOPE.target, /average one-draw event probability/);
  for (const excluded of [
    'task-sampling uncertainty from a larger real-world population',
    'per-task repeatability',
    'production-wide prevalence',
    'deterministic task classification',
  ]) assert.ok(ESTIMAND_SCOPE.excludes.includes(excluded), excluded);
});

console.log('\nbeta_N support guard');

check('beta_60 matches the expected constant', () => {
  near(betaN(60), 0.7357675420279305, 'beta_60');
  assert.equal(betaN(60), 0.7357675420279305, 'and to the exact double');
});

check('beta = 0.95 is supported at N = 60', () => {
  assert.equal(assertSupported(60, 0.95), betaN(60));
});

check('NEGATIVE: a beta below beta_N fails closed rather than computing a bound', () => {
  const err = (() => { try { lowerBound(3, 60, 0.05, 0.5); } catch (e) { return e; } })();
  assert.ok(err instanceof CensusStatisticsError, String(err));
  assert.match(String(err), /below beta_N/);
  assert.match(String(err), /must not be applied/);
  assert.throws(() => upperBound(3, 60, 0.05, 0.5), CensusStatisticsError);
  assert.throws(() => decide(3, { beta: 0.5 }), CensusStatisticsError);
});

console.log('\nPinned test vectors at N = 60');

const VECTORS = [
  [0, 0, 0.048702913310],
  [1, 0.000833333333, 0.076639994935],
  [2, 0.005954897130, 0.101235894924],
  [6, 0.044452967769, 0.187857381989],
  [7, 0.056054881636, 0.207990937191],
  [58, 0.898764105076, 0.994045102870],
  [59, 0.923360005065, 0.999166666667],
  [60, 0.951297086690, 1],
];

for (const [k, expectedLower, expectedUpper] of VECTORS) {
  check(`k = ${k} bounds match the pinned vector`, () => {
    near(lowerBound(k), expectedLower, `lower k=${k}`);
    near(upperBound(k), expectedUpper, `upper k=${k}`);
  });
}

check('k = 0 and k = 60 are exact, not solved', () => {
  assert.equal(lowerBound(0), 0);
  assert.equal(upperBound(60), 1);
});

console.log('\nThe two endpoints where MT must not be Clopper-Pearson');

check('k = 1 lower is alpha/N and NOT the ordinary CP lower endpoint', () => {
  assert.equal(lowerBound(1), ALPHA / CBRP_N);
  near(lowerBound(1), 0.000833333333, 'MT k=1 lower');
  const cp = cpInteriorLower(1);
  near(cp, 0.000854522927, 'CP k=1 lower');
  assert.notEqual(lowerBound(1), cp, 'the heterogeneous endpoint must differ from CP');
  assert.ok(lowerBound(1) < cp, 'and be the more conservative of the two');
});

check('k = N-1 upper is 1 - alpha/N and NOT the ordinary CP upper endpoint', () => {
  assert.equal(upperBound(59), 1 - ALPHA / CBRP_N);
  near(upperBound(59), 0.999166666667, 'MT k=59 upper');
  const cp = cpInteriorUpper(59);
  near(cp, 0.999145477073, 'CP k=59 upper');
  assert.notEqual(upperBound(59), cp);
  assert.ok(upperBound(59) > cp, 'and be the more conservative of the two');
});

check('the interior endpoints DO coincide with CP, which is why the distinction is easy to lose', () => {
  for (const k of [2, 3, 6, 7, 30, 58]) {
    assert.equal(lowerBound(k), cpInteriorLower(k), `lower k=${k}`);
  }
  for (const k of [0, 2, 6, 7, 30, 58]) {
    assert.equal(upperBound(k), cpInteriorUpper(k), `upper k=${k}`);
  }
});

console.log('\nStructural properties');

check('lower is monotone non-decreasing in k', () => {
  for (let k = 1; k <= CBRP_N; k += 1) {
    assert.ok(lowerBound(k) >= lowerBound(k - 1), `lower(${k}) >= lower(${k - 1})`);
  }
});

check('upper is monotone non-decreasing in k', () => {
  for (let k = 1; k <= CBRP_N; k += 1) {
    assert.ok(upperBound(k) >= upperBound(k - 1), `upper(${k}) >= upper(${k - 1})`);
  }
});

check('L(k) = 1 - U(N-k) across the whole range', () => {
  for (let k = 0; k <= CBRP_N; k += 1) {
    near(lowerBound(k), 1 - upperBound(CBRP_N - k), `symmetry at k=${k}`);
  }
});

check('lower <= upper everywhere', () => {
  for (let k = 0; k <= CBRP_N; k += 1) assert.ok(lowerBound(k) <= upperBound(k), `k=${k}`);
});

check('NEGATIVE: a non-integer or out-of-range k is refused', () => {
  for (const bad of [-1, 61, 1.5, NaN]) {
    assert.throws(() => lowerBound(bad), CensusStatisticsError, String(bad));
    assert.throws(() => upperBound(bad), CensusStatisticsError, String(bad));
  }
});

console.log('\nDecision zones');

check('the zone transitions are exactly k=0 / 1..6 / 7..60', () => {
  assert.equal(decide(0).zone, TOO_SPARSE);
  for (let k = 1; k <= 6; k += 1) assert.equal(decide(k).zone, INCONCLUSIVE, `k=${k}`);
  for (let k = 7; k <= 60; k += 1) assert.equal(decide(k).zone, VIABLE, `k=${k}`);
});

check('only k = 0 can conclude TOO_SPARSE, and that asymmetry is the accepted design', () => {
  const sparse = [];
  for (let k = 0; k <= 60; k += 1) if (decide(k).zone === TOO_SPARSE) sparse.push(k);
  assert.deepEqual(sparse, [0]);
});

check('the point estimate does not decide the zone', () => {
  // k = 6 is exactly 10% and is INCONCLUSIVE; the rejected ">= 10% point estimate" rule
  // would have called it viable while its lower bound is 4.45%.
  const six = decide(6);
  assert.equal(six.pointEstimate, 0.1);
  assert.equal(six.zone, INCONCLUSIVE);
  assert.ok(six.lower < THETA_FEAS);
});

check('a decision carries its full provenance', () => {
  const d = decide(7);
  assert.equal(d.methodVersion, 'CBRP-MT-BUEHLER-1');
  assert.equal(d.n, 60);
  assert.equal(d.alpha, 0.05);
  assert.equal(d.beta, 0.95);
  assert.equal(d.thetaFeas, 0.05);
  assert.equal(d.betaN, betaN(60));
});

check('display rounds to six decimals and is never used for the decision', () => {
  assert.equal(display(0.048702913310), '0.048703');
  // A value that rounds across theta at 6 dp must still decide on the raw double.
  const justUnder = 0.0499999999;
  assert.equal(display(justUnder), '0.050000');
  assert.ok(justUnder <= THETA_FEAS, 'the raw comparison, not the display, is what decides');
});

console.log('\nDesign-note computations');

check('N = 59 is the statistical minimum and 60 the smallest balanced six-stratum design', () => {
  assert.equal(smallestNForZeroEvent(), 59);
  assert.equal(smallestBalancedNForZeroEvent(6), 60);
});

check('N = 58 fails the zero-event condition and N = 59 passes', () => {
  assert.ok(upperBound(0, 58, ALPHA, BETA) > THETA_FEAS, 'N=58 must fail');
  assert.ok(upperBound(0, 59, ALPHA, BETA) <= THETA_FEAS, 'N=59 must pass');
  assert.equal(display(upperBound(0, 58, ALPHA, BETA)), '0.050339', 'N=58 zero-event upper');
  assert.equal(display(upperBound(0, 59, ALPHA, BETA)), '0.049508', 'N=59 zero-event upper');
  assert.equal(display(upperBound(0, 60, ALPHA, BETA)), '0.048703', 'N=60 zero-event upper');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
