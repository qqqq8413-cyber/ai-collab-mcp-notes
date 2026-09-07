# CBRP — Preregistration Readiness Checklist — DRAFT

```
STATUS:  DRAFT
         NOT ACCEPTED
         NOT PREREGISTERED
```

> Everything that must be resolved before GPT may accept the CBRP census as a
> preregistered study. Companions:
> [`CHIEF_NATURAL_COLLABORATION_CENSUS_DRAFT.md`](CHIEF_NATURAL_COLLABORATION_CENSUS_DRAFT.md),
> [`CBRP_AUTHORING_AND_REVIEW_DRAFT.md`](CBRP_AUTHORING_AND_REVIEW_DRAFT.md).
>
> Status vocabulary, strictly:
>
> ```
> OPEN                  no position taken
> PROPOSED              a recommendation exists, marked PROPOSAL ONLY, not accepted
> ARCHITECTURE-DECIDED  GPT has decided it
> IMPLEMENTED           code or artifacts exist
> VERIFIED              proven by a deterministic check
> ```
>
> **Nothing below is IMPLEMENTED or VERIFIED.** No task exists, no harness
> exists, no provider call has been made.

---

## A. Study definition

| # | Item | Status | Note |
|---|---|---|---|
| A-1 | CBRP definition — synthetic, preregistered, equally weighted reference frame | **ARCHITECTURE-DECIDED** | Census §2.1 |
| A-2 | Primary estimand `P(deep ∧ assigned ≥ 2 | CBRP)` | **ARCHITECTURE-DECIDED** | Named *reference-population assignment rate* |
| A-3 | Six primary-intent strata | **ARCHITECTURE-DECIDED** | Census §3 |
| A-4 | Equal weighting, 10 tasks per stratum | **ARCHITECTURE-DECIDED** | Never a usage-frequency claim |
| A-5 | N = 60 | **ARCHITECTURE-DECIDED** | N = 59 is the statistical minimum; **60 is the smallest balanced six-stratum design** meeting it. Derived from θ, never from cost |
| A-6 | θ_feas = 5% | **ARCHITECTURE-DECIDED** | Design decision, not a definition of "rare" |
| A-7 | Decision zones VIABLE / TOO_SPARSE / INCONCLUSIVE | **ARCHITECTURE-DECIDED** | Census §5.2 |
| A-8 | Routing rubric operational enough for two reviewers to agree | **PROPOSED** | D-3 now makes it measurable: the inter-reviewer disagreement rate is reported as a property of the rubric. Still asserted until reviews run |
| A-9 | Study id and version string | **OPEN** | Must be fixed before the first call so artifacts can cite it |

---

## B. Statistical method

| # | Item | Status | Note |
|---|---|---|---|
| B-0 | Model: independent, **non-identically** distributed Bernoulli; estimand `p̄ = (1/N)Σpi`; count is Poisson-binomial, never an ordinary Binomial | **ARCHITECTURE-DECIDED** | Census §2.2 |
| B-1 | **M-CBRP-STAT-01** | **VERIFIED** | Specification CLOSED ｜ implementation VERIFIED ｜ independent reproduction VERIFIED. No methodology blocker remains on the interval formula |
| B-1b | MT endpoints: `k = 1` lower `(1−β)/N`, `k = N−1` upper `1−(1−β)/N`, CP interior | **ARCHITECTURE-DECIDED** | Census §5.2 |
| B-1c | Independence is a **modeling assumption**, not attested by fingerprint / model pin / provider pin | **ARCHITECTURE-DECIDED** | Census §5.2.1 |
| B-2 | Interval **implementation**, including the two MT special cases | **VERIFIED** | `statistics.mjs`; 31 tests including rejection of CP at `k = 1` and `k = N−1` |
| B-3 | Numerical convention — tolerance, iteration bound, reported precision | **VERIFIED** | `NUMERICAL_CONTRACT`: bracket [0,1], 1e-14, 200 fixed iterations, unrounded decisions, 6-dp display |
| B-4 | Edge cases `k = 0`, `k = 1`, `k = N−1`, `k = N` | **VERIFIED** | All four pinned; plus a `beta_N` support guard that fails closed |
| B-5 | Independent reproduction of both bounds | **VERIFIED** | Reproduced independently by Codex: model, `beta_60`, all eight pinned vectors, the zone transitions, and N = 59 / 60. No repository change was made by that audit |
| B-6 | Point estimate reported descriptively only | **ARCHITECTURE-DECIDED** | The ≥ 10% point-estimate rule is explicitly rejected |
| B-7 | Decision-rule version string recorded in the artifact | **OPEN** | |
| B-8 | Asymmetry of the rule, and INCONCLUSIVE as a valid outcome | **ARCHITECTURE-DECIDED** | Accepted for Phase 1; must be stated alongside any verdict |

---

## C. Task population

| # | Item | Status | Note |
|---|---|---|---|
| C-1 | Task template / output format | **ARCHITECTURE-DECIDED** | JSON array of `{stratum, text}`, 12 per session; brief §2.8 |
| C-2 | Realism rubric | **ARCHITECTURE-DECIDED** | Brief §2.2, and a review check |
| C-3 | Self-containment requirement | **ARCHITECTURE-DECIDED** | Brief §2.3, and a review check |
| C-4 | Prohibited leakage term list | **ARCHITECTURE-DECIDED** | Brief §2.7, and a review check |
| C-5 | Diversity dimensions | **ARCHITECTURE-DECIDED** | Nine dimensions of the situation; five forbidden instructions about the answer |
| C-6 | Diversity enforcement — quotas vs review check | **OPEN** | Authoring §4.1 |
| C-7 | Duplicate-avoidance rule | **ARCHITECTURE-DECIDED** | "Differing only in industry or only in the numbers" is one scenario; brief §2.6 and review check `notDuplicate` |
| C-8 | **The 60 tasks themselves** | **OPEN** | **0 authored.** Procedure is frozen; authoring is not authorized |
| C-9 | Difficulty varies within every stratum | **ARCHITECTURE-DECIDED** | "Ordinary" is not a stratum |

---

## D. Authoring and review procedure

| # | Item | Status | Note |
|---|---|---|---|
| D-1 | Blinded authoring envelope | **ARCHITECTURE-DECIDED** | Twelve exclusions and a closed allow-list; Authoring §3.1 |
| D-2 | Authoring session design | **ARCHITECTURE-DECIDED** | Five sessions × 12 tasks × 2 per stratum; every stratum draws from all five |
| D-3 | Reviewer independence design | **ARCHITECTURE-DECIDED** | Two blinded reviews, third on disagreement, majority final; GPT task-level adjudication **forbidden**. Makes A-8's claim measurable |
| D-4 | Structural review rubric | **ARCHITECTURE-DECIDED** | Eight judgements, fixed output schema; `CBRP_STRUCTURAL_REVIEW_RUBRIC_DRAFT.md` |
| D-5 | Reviewer must not score likelihood of the event | **ARCHITECTURE-DECIDED** | Authoring §5.4 |
| D-6 | "Fresh session" — operational definition | **ARCHITECTURE-DECIDED** | Twelve conditions, Authoring §3.1. **Still `[OPEN]`:** whether fresh context, a different model, or a human satisfies it — a same-model author shares priors with the Chief being measured |
| D-7 | Blinding described as reduction, never elimination | **ARCHITECTURE-DECIDED** | Must appear in any result |

---

## E. Freeze and execution order

| # | Item | Status | Note |
|---|---|---|---|
| E-1 | Freeze before first planning call | **ARCHITECTURE-DECIDED** | Authoring §8 |
| E-2 | Per-task SHA-256 and a pool manifest | **OPEN** | Schema decided (`CBRP_POOL_MANIFEST_SCHEMA_DRAFT.md`); no task exists to hash |
| E-3 | Freeze provenance | **OPEN** | Required contents decided: bytes, ids, hashes, strata, session ids, review ids and results, replacement lineage. Not run |
| E-4 | Invalid-task policy | **ARCHITECTURE-DECIDED** | Three moments, three rules: pre-freeze replace; post-freeze whole-pool re-freeze; post-first-call STOP. Never dropped for its result |
| E-5 | Ordering / randomization rule | **ARCHITECTURE-DECIDED** | Seeded round-robin across six strata, ten rounds of six; not contiguous blocks |
| E-6 | Seed governance and method | **PROPOSED** | Sequence decided: freeze → derive → materialize → commit → review. Method `SHA-256(frozenPoolCommit + "CBRP-ORDER-v1")` is **PROPOSAL FOR GPT REVIEW**; the permutation algorithm is `[OPEN]` |
| E-7 | No outcome-informed replacement, ever | **ARCHITECTURE-DECIDED** | |

---

## F. Harness and runtime

| # | Item | Status | Note |
|---|---|---|---|
| F-1 | Planning-only harness | **OPEN** | `runPlanningStage()` exists; the **census** harness around it does not |
| F-2 | `runPlanningStage()` behaviour-preserving extraction | **IMPLEMENTED** | See CENSUS-REQ-01 |
| F-3 | Proof the extraction moved no behaviour | **VERIFIED** | Full Round 1 output, provider call order and the five-read stepped clock all asserted unchanged |
| F-4 | Chief system prompt unchanged | **ARCHITECTURE-DECIDED** | |
| F-5 | `SPECIALIST_CAP`, registry, planner logic unchanged | **ARCHITECTURE-DECIDED** | |
| F-6 | Planning provider/model pin | **ARCHITECTURE-DECIDED** | `openai/gpt-5`, no fallback, no substitution; `EXPECTED_PLANNING_PIN`, enforced pre-call and by the verifier |
| F-7 | Transport retry policy for census calls | **IMPLEMENTED** | `explicit-no-retry` reused; every call records `transportMaxRetriesRequested = 0` |
| F-8 | Dependency provenance recorded and enforced against a baseline | **IMPLEMENTED** | `census-provenance.mjs`, own baseline `CBRP-CENSUS-DEPS-1`, Zod included |
| F-9 | Runtime fingerprint recorded **and enforced** | **VERIFIED** | See CENSUS-REQ-09. Scope stays src/ + dist/; dependency, toolchain and Node provenance sit beside it, never inside it |
| F-10 | Call budget | **IMPLEMENTED** | 60 global, 1 per task; no slots×4 semantics |
| F-11 | STOP rules — integrity violations, budget, failure paths | **IMPLEMENTED** | Pre-dispatch refusals cost no attempt; settled failures stop the session with no verdict |
| F-12 | Retrieval and temperature policy | **IMPLEMENTED** | Both refused pre-call by the census recorder |

---

## G. Artifact contract — DRAFT, not final

`[DRAFT]` Field names are illustrative. **This is not the final schema.**

### G.1 Session level

```
studyId ｜ studyVersion ｜ decisionRuleVersion
executionHead ｜ frozenPopulationCommit ｜ taskManifestSha256
N ｜ theta_feas ｜ alpha
plannerProviderRequested / Resolved ｜ plannerModelRequested / Resolved
dependencyProvenance ｜ runtimeFingerprintStart / End ｜ fingerprintDrift
callBudget ｜ orderRule ｜ orderSeed (if any)
startedAt ｜ completedAt ｜ stopCondition (null if none)
```

### G.2 Per task

```
taskId ｜ taskSha256 ｜ stratum ｜ orderIndex
rawPlanningResponseSha256
complexity ｜ requiredCapabilities
assignments ｜ assignmentCount ｜ assignedAgentIds
requiresRedTeam ｜ reason ｜ planningAdjustments
providerRequested / Resolved ｜ modelRequested / Resolved
callStatus ｜ error
eventDeep ｜ eventAssignedGte2 ｜ eventJoint
```

| # | Item | Status |
|---|---|---|
| G-1 | Session field set | **DRAFT** |
| G-2 | Per-task field set | **DRAFT** |
| G-5 | Pool manifest schema and identity schemes | **DRAFT** | `CBRP_POOL_MANIFEST_SCHEMA_DRAFT.md`; task ids encode stratum only, review ids encode order only |
| G-6 | Order manifest, separate from the pool manifest | **DRAFT** | Separate so the freeze commit exists before the seed is derived from it |
| G-3 | Event fields recomputable from the post-enforcement plan | **VERIFIED** |
| G-4 | Verifier for census artifacts | **IMPLEMENTED** |

---

## H. Analysis and reproducibility

| # | Item | Status | Note |
|---|---|---|---|
| H-1 | Analysis recomputation | **IMPLEMENTED** | The verifier recomputes events, k, bounds and zone; never reads `eventJoint` as given |
| H-2 | Reproducibility check — same artifacts, same verdict | **VERIFIED** | Bit-identical bounds on repeat; the verifier re-derives the verdict from artifacts |
| H-3 | Independent bound reproduction by a reviewer | **OPEN** | See B-5 |
| H-4 | Descriptive measures reported | **PROPOSED** | Census §8 |
| H-5 | No causal language in results | **ARCHITECTURE-DECIDED** | |

---

## I. Claim boundary

| # | Item | Status | Note |
|---|---|---|---|
| I-1 | Every conclusion scoped "within the preregistered CBRP reference frame" | **ARCHITECTURE-DECIDED** | |
| I-2 | Production-wide prevalence claims prohibited | **ARCHITECTURE-DECIDED** | |
| I-3 | `assigned ≥ 2` never called F2 | **ARCHITECTURE-DECIDED** | Census §7 |
| I-4 | No worker-success, F2, quality or peer-challenge claim | **ARCHITECTURE-DECIDED** | |
| I-5 | No causation claims — task type, complexity, provider, model, role | **ARCHITECTURE-DECIDED** | |
| I-6 | **M-ACQ-01 not closed by this study** | **ARCHITECTURE-DECIDED** | CBRP gives a balanced-reference rate, not telemetry prevalence |
| I-7 | Phase 2 not designed, not preregistered, not authorized | **ARCHITECTURE-DECIDED** | Prerequisites listed in Census §7.1 |

---

## K. Engineering requirements for a live census

Raised by the planning-stage extraction and the statistical correction. **Do not
read any of 03–06 as implemented; they are not.**

| # | Requirement | Status | Note |
|---|---|---|---|
| **CENSUS-REQ-01** | `runPlanningStage()` parity — a production plan obtainable with zero worker calls, behaviour provably unmoved | **IMPLEMENTED** | Extracted; 32 planning-stage tests and 18 Round 1 boundary tests, both in the root test command |
| **CENSUS-REQ-02** | Post-enforcement event source — the formal assignment count is `runPlanningStage().plan.assignments.length`, never the raw Chief JSON | **ARCHITECTURE-DECIDED** | Documented in Census §2.2; a test pins that raw 5 becomes enforced 4. **The census consumer of it does not exist yet** |
| **CENSUS-REQ-03** | Durable **pre-dispatch** attempt reservation | **IMPLEMENTED** | `attempt-registry.mjs`: append-only NDJSON, fsync per record, three distinguishable recovery states; reserved-but-unsettled = `AMBIGUOUS_ATTEMPT_CONSUMED`, session INCOMPLETE, no retry |
| **CENSUS-REQ-04** | Source ↔ dist execution binding | **IMPLEMENTED / VERIFIED OFFLINE** | Now consumes CENSUS-REQ-07 and -08: toolchain and runtime are asserted before the reference build, and travel in the artifact. Historical `runtimeFingerprint` untouched |
| **CENSUS-REQ-05** | Zod installed-byte provenance | **IMPLEMENTED** | In the census baseline with lock integrity, manifest hash, entrypoint, digest and file count. No package version changed |
| **CENSUS-REQ-06** | Census-specific recorder and artifact contract | **IMPLEMENTED** | `planning-recorder.mjs`, `census-session.mjs` (`CBRP-CENSUS-1`), `census-verify.mjs`; 69 rehearsal tests |
| **CENSUS-REQ-07** | Build toolchain provenance | **CLOSED / VERIFIED OFFLINE** | Both TypeScript packages attested. TS 7 is the native port, so the compiler is a binary in `@typescript/typescript-darwin-arm64`; the executable is resolved by asking the launcher, not by reading a path, and must land inside the approved package |
| **CENSUS-REQ-08** | Node runtime pin | **CLOSED / VERIFIED OFFLINE** | `process.version` pinned at `v24.15.0` and fail-closed; platform, arch and other `process.versions` fields recorded as context and never compared |
| **CENSUS-REQ-09** | Runtime drift enforcement | **CLOSED / VERIFIED OFFLINE** | Historical fingerprint semantics unchanged. Missing start → pre-dispatch stop; any start/end difference → INCOMPLETE and no verdict, even on sixty successes. Re-sampled at each task boundary; **cannot** prove a transient change inside one call |
| **CENSUS-REQ-10** | Pre-call provenance revalidation | **CLOSED / VERIFIED OFFLINE** | The session calls the verifier's own `toolchainProblems` and `matchesCensusBaseline` on the actual records. A forged `match: true` or `problems: []` is refused before any reservation |

## J. Readiness summary

```
83 checklist items

ARCHITECTURE-DECIDED             42
PROPOSED                          3
OPEN                              8
DRAFT                             4
IMPLEMENTED                      12
IMPLEMENTED / VERIFIED OFFLINE    1
CLOSED / VERIFIED OFFLINE         4
VERIFIED                          9
```

**PREREGISTRATION CANDIDATE — not preregistered.** Method, estimand, decision rule,
execution infrastructure, and now authoring, review, invalid-task and ordering procedure
are all decided. What is missing is the study's **content and its execution record**: the
sixty tasks are unwritten, no review has run, no pool is frozen, and no seed has been
materialized.

**Not preregistration-ready.** The blocking clusters, in the order they gate
each other:

1. **E-6 seed method** — proposed, awaiting GPT review, and the permutation algorithm
   from seed bytes to ordering is still `[OPEN]`. It must be fixed **before** the freeze.
2. **D-6** — whether a "fresh session" may be the same model that is being measured.
3. **C-8** — the 60 tasks. **0 authored**, and authoring is not authorized.
4. **E-2, E-3** — the freeze itself, which cannot begin until the tasks exist and have
   passed review.

**The remaining blockers are all methodology and content, not engineering.** Every
execution-infrastructure requirement CENSUS-REQ-01 … 10 is now closed offline. What
stands between here and a preregisterable study is: who writes the sixty tasks and
how, who reviews them, what happens to an invalid one, what order they run in, and
then the tasks themselves and their freeze.

`[OPEN]` One structural gap worth naming: **A-8 asserts the routing rubric is
operational, and nothing currently measures it.** D-3's two-reviewer design is
the only proposal that would turn that assertion into a number. If a single
reviewer is chosen instead, the rubric's central claim stays untested.

`[OPEN]` A second: **the census harness has been rehearsed, never run.** Every
path is exercised against a stub, which proves the refusals fire and the artifact
is verifiable. It does not prove the production Chief behaves as the stub did, and
nothing offline can.
