// The single benchmark task every harness plans against.
//
// Kept in one place because it is the control variable: run-to-run comparisons of
// complexity, specialist count and cost are only meaningful if the input is
// byte-identical. A harness that inlines its own copy silently becomes incomparable —
// which already happened once, when a live planning check used a placeholder company
// name and returned `normal` where the orchestrator runs had returned `deep`.
//
// ⚠️ BENCHMARK RESET (rev. 19). The company name here was the real one, and this file is
// public. It has been replaced with a fixed placeholder. Because that exact substitution
// is the one already known to move a plan from `deep` to `normal`, every BENCHMARK_TASK
// measurement recorded before this change is historical and NOT comparable with anything
// measured after it. Re-baseline before comparing; do not read old numbers against new
// runs. The placeholder is now itself the control variable and must not be edited again.
export const BENCHMARK_TASK = `請規劃「星芒影像工作室」2027 年如何提升：
1. 營收
2. 品牌影響力
3. 案源品質

請提出可執行的成長策略。`;

/** The roster those comparisons were measured with. */
export const BENCHMARK_ROSTER = ['business_strategist', 'market_researcher', 'brand_creative'];

/**
 * A task that is unambiguously `simple` by the §14 definition — calculation and
 * formatting over information that is entirely contained in the prompt. Nothing here
 * needs research, judgement, or more than one specialist.
 *
 * Exists because every measurement so far has been the deep strategy task above, so the
 * cost of orchestration on a small task has never actually been observed.
 */
export const SIMPLE_TASK = `以下三筆報價都是未稅總價，請換算成含稅（營業稅 5%）金額，並由低到高排序：
A 案 48,000 元
B 案 52,500 元
C 案 45,800 元`;
