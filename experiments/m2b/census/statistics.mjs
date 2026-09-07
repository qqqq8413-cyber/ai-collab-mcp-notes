/**
 * CBRP-MT-BUEHLER-1 — one-sided confidence bounds for the average success probability
 * of independent, potentially NON-IDENTICALLY distributed Bernoulli observations.
 *
 * ## Why not just Clopper-Pearson
 *
 * The sixty CBRP tasks are sixty different decisions across six strata. Nothing makes
 * them equiprobable, and assuming p1 = ... = p60 would assert the very thing about the
 * Chief that the census exists to measure. Ordinary Clopper-Pearson is derived for
 * identically distributed trials, so using it whole and calling it CP would smuggle that
 * assumption into the method name.
 *
 * The Buehler-optimal construction (Mattner-Tasto) for the average success probability
 * `p-bar = (1/N) sum(pi)` is valid without homogeneity. At beta = 0.95 most interior
 * endpoints coincide exactly with the ordinary one-sided CP endpoints — which is why the
 * distinction is easy to lose — but the extremes do not, and those are the two places the
 * correction exists for:
 *
 *   lower   k = 0      0
 *           k = 1      alpha / N            (CP would say 0.000854..., not 0.000833...)
 *           k >= 2     CP interior lower
 *
 *   upper   k <= N-2   CP interior upper
 *           k = N-1    1 - alpha / N        (CP would say 0.999145..., not 0.999167...)
 *           k = N      1
 *
 * A generic homogeneous CP function must never be used as the whole method.
 *
 * ## What the bounds are about
 *
 * The inferential target is the average ONE-DRAW event probability over the exact frozen
 * CBRP tasks. It does not include task-sampling uncertainty from a larger real-world
 * population, per-task repeatability, production-wide prevalence, or any claim that a
 * task's classification is deterministic. See `ESTIMAND_SCOPE`.
 */

/** Pinned numerical contract. Changing any of these changes the study's verdict. */
export const METHOD_VERSION = 'CBRP-MT-BUEHLER-1';
export const ALPHA = 0.05;
export const BETA = 0.95;
export const THETA_FEAS = 0.05;
export const CBRP_N = 60;

/** Deterministic bisection: fixed bracket, fixed iteration count, no randomness. */
export const NUMERICAL_CONTRACT = Object.freeze({
  bracket: Object.freeze([0, 1]),
  tolerance: 1e-14,
  maxIterations: 200,
  /** Decisions compare raw doubles. Rounding is for humans and never for the verdict. */
  decisionComparison: 'unrounded',
  displayDecimals: 6,
  stochastic: false,
});

export const ESTIMAND_SCOPE = Object.freeze({
  target: 'average one-draw event probability over the exact frozen CBRP tasks',
  excludes: Object.freeze([
    'task-sampling uncertainty from a larger real-world population',
    'per-task repeatability',
    'production-wide prevalence',
    'deterministic task classification',
  ]),
});

export class CensusStatisticsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CensusStatisticsError';
    this.code = 'CENSUS_STATISTICS_UNSUPPORTED';
  }
}

/** log C(n, k), summed rather than factorialed so n = 60 never overflows. */
function logBinomial(n, k) {
  let total = 0;
  for (let i = 0; i < k; i += 1) total += Math.log(n - i) - Math.log(i + 1);
  return total;
}

/** P(X <= k) for X ~ Binomial(n, p). Exact sum; n is small enough that this is cheap. */
export function binomialCdfAtMost(k, n, p) {
  if (p <= 0) return 1;
  if (p >= 1) return k >= n ? 1 : 0;
  let total = 0;
  for (let i = 0; i <= k; i += 1) {
    total += Math.exp(logBinomial(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  }
  return Math.min(1, total);
}

export const binomialCdfAtLeast = (k, n, p) => (k === 0 ? 1 : 1 - binomialCdfAtMost(k - 1, n, p));

/**
 * Solves a monotone tail equation on [0, 1] by bisection.
 *
 * Fixed iteration count rather than a convergence loop: the same inputs must produce the
 * same bits on every machine and every run, and an early exit on a tolerance test makes
 * that depend on how quickly the bracket happened to close.
 */
function solveMonotone(f, target) {
  const [lowStart, highStart] = NUMERICAL_CONTRACT.bracket;
  let low = lowStart;
  let high = highStart;
  for (let i = 0; i < NUMERICAL_CONTRACT.maxIterations; i += 1) {
    const mid = (low + high) / 2;
    if (f(mid) < target) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/** The ordinary one-sided CP interior endpoints. Interior use only — never the whole method. */
export const cpInteriorLower = (k, n = CBRP_N, alpha = ALPHA) =>
  solveMonotone((p) => binomialCdfAtLeast(k, n, p), alpha);
export const cpInteriorUpper = (k, n = CBRP_N, alpha = ALPHA) =>
  solveMonotone((p) => 1 - binomialCdfAtMost(k, n, p), 1 - alpha);

/**
 * The Buehler-optimality condition for this construction.
 *
 * beta_N = (1 - 1/N)^(N-1) * (2 - 1/N). The method is supported only for beta >= beta_N,
 * so the analysis fails closed rather than quietly applying it outside its range — the
 * failure mode being a bound that looks ordinary and is not valid.
 */
export const betaN = (n = CBRP_N) => Math.pow(1 - 1 / n, n - 1) * (2 - 1 / n);

export function assertSupported(n = CBRP_N, beta = BETA) {
  const required = betaN(n);
  if (!(beta >= required)) {
    throw new CensusStatisticsError(
      `beta = ${beta} is below beta_N = ${required} for N = ${n}; `
        + 'the Buehler-optimal construction is not supported here and must not be applied.',
    );
  }
  return required;
}

/**
 * Heterogeneous-Bernoulli-valid one-sided lower bound on p-bar.
 *
 * The k = 1 case is the whole point: CP would give a slightly larger number that is not
 * valid without homogeneity.
 */
export function lowerBound(k, n = CBRP_N, alpha = ALPHA, beta = BETA) {
  assertSupported(n, beta);
  if (!Number.isInteger(k) || k < 0 || k > n) throw new CensusStatisticsError(`k must be an integer in [0, ${n}], got ${k}`);
  if (k === 0) return 0;
  if (k === 1) return alpha / n;
  return cpInteriorLower(k, n, alpha);
}

/** The symmetric counterpart; `k = N-1` is where it departs from CP. */
export function upperBound(k, n = CBRP_N, alpha = ALPHA, beta = BETA) {
  assertSupported(n, beta);
  if (!Number.isInteger(k) || k < 0 || k > n) throw new CensusStatisticsError(`k must be an integer in [0, ${n}], got ${k}`);
  if (k === n) return 1;
  if (k === n - 1) return 1 - alpha / n;
  return cpInteriorUpper(k, n, alpha);
}

export const TOO_SPARSE = 'TOO_SPARSE';
export const VIABLE = 'VIABLE';
export const INCONCLUSIVE = 'INCONCLUSIVE';

/**
 * The preregistered verdict.
 *
 * Comparisons are on raw doubles. INCONCLUSIVE is a legitimate preregistered outcome and
 * not a failure of the study: the alternative — nudging a bound until it lands in a
 * decisive zone — is the thing preregistration exists to prevent.
 */
export function decide(k, { n = CBRP_N, alpha = ALPHA, beta = BETA, thetaFeas = THETA_FEAS } = {}) {
  const lower = lowerBound(k, n, alpha, beta);
  const upper = upperBound(k, n, alpha, beta);
  const zone = upper <= thetaFeas ? TOO_SPARSE : (lower > thetaFeas ? VIABLE : INCONCLUSIVE);
  return {
    methodVersion: METHOD_VERSION,
    k, n, alpha, beta, thetaFeas,
    betaN: betaN(n),
    pointEstimate: k / n,
    lower,
    upper,
    zone,
  };
}

/** Display only. Never used in a comparison. */
export const display = (value) => value.toFixed(NUMERICAL_CONTRACT.displayDecimals);

/**
 * The smallest N whose zero-event upper bound falls at or below theta.
 *
 * N = 59 statistically; CBRP uses 60 because it is the smallest such N divisible by the
 * six strata. Exposed so the design note is a computation rather than a remembered claim.
 */
export function smallestNForZeroEvent(thetaFeas = THETA_FEAS, alpha = ALPHA, beta = BETA) {
  for (let n = 2; n <= 500; n += 1) {
    if (beta < betaN(n)) continue;
    if (upperBound(0, n, alpha, beta) <= thetaFeas) return n;
  }
  return null;
}

export function smallestBalancedNForZeroEvent(strata = 6, thetaFeas = THETA_FEAS, alpha = ALPHA, beta = BETA) {
  const minimum = smallestNForZeroEvent(thetaFeas, alpha, beta);
  if (minimum === null) return null;
  return Math.ceil(minimum / strata) * strata;
}
