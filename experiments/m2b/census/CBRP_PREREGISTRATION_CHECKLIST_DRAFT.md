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
| A-5 | N = 60 | **ARCHITECTURE-DECIDED** | Derived from θ, not from cost |
| A-6 | θ_feas = 5% | **ARCHITECTURE-DECIDED** | Design decision, not a definition of "rare" |
| A-7 | Decision zones VIABLE / TOO_SPARSE / INCONCLUSIVE | **ARCHITECTURE-DECIDED** | Census §5.2 |
| A-8 | Routing rubric operational enough for two reviewers to agree | **PROPOSED** | Drafted in Census §3.2; **agreement is asserted, never measured** — see D-3 |
| A-9 | Study id and version string | **OPEN** | Must be fixed before the first call so artifacts can cite it |

---

## B. Statistical method

| # | Item | Status | Note |
|---|---|---|---|
| B-1 | Exact one-sided Clopper–Pearson bounds, α = 0.05 | **ARCHITECTURE-DECIDED** | |
| B-2 | Interval **implementation** | **OPEN** | Three candidates and tradeoffs in Census §5.3; must be pinned before execution |
| B-3 | Numerical convention — tolerance, iteration bound, reported precision | **OPEN** | |
| B-4 | Edge cases `k = 0` and `k = n` | **OPEN** | `k = 0` decides TOO_SPARSE, so its handling is load-bearing |
| B-5 | Independent reproduction path for both bounds | **OPEN** | A second toolchain as cross-check, not as source of truth |
| B-6 | Point estimate reported descriptively only | **ARCHITECTURE-DECIDED** | The ≥ 10% point-estimate rule is explicitly rejected |
| B-7 | Decision-rule version string recorded in the artifact | **OPEN** | |
| B-8 | Asymmetry of the rule stated in any published result | **OPEN** | Only `k = 0` yields TOO_SPARSE; see Census §5.2 |

---

## C. Task population

| # | Item | Status | Note |
|---|---|---|---|
| C-1 | Task template / output format | **OPEN** | |
| C-2 | Realism rubric | **PROPOSED** | Authoring §2.3 |
| C-3 | Self-containment requirement | **PROPOSED** | Authoring §2.4 |
| C-4 | Prohibited leakage term list | **PROPOSED** | Authoring §2.5 |
| C-5 | Diversity dimensions | **PROPOSED** | Authoring §4 |
| C-6 | Diversity enforcement — quotas vs review check | **OPEN** | Authoring §4.1 |
| C-7 | Duplicate-avoidance rule | **OPEN** | Needs an operational definition of "duplicate" |
| C-8 | **The 60 tasks themselves** | **OPEN** | **0 authored. Not authorized by this packet.** |
| C-9 | Difficulty varies within every stratum | **ARCHITECTURE-DECIDED** | "Ordinary" is not a stratum |

---

## D. Authoring and review procedure

| # | Item | Status | Note |
|---|---|---|---|
| D-1 | Blinded authoring envelope — what the author may and may not see | **PROPOSED** | Authoring §2 |
| D-2 | Authoring session design (A / B / C) | **OPEN** | Option C proposed; allocation table unset |
| D-3 | Reviewer independence design | **OPEN** | Two reviewers + bounded adjudication proposed; would also **measure** the disagreement rate that A-8 currently only asserts |
| D-4 | Structural review checklist | **PROPOSED** | Authoring §5.3 |
| D-5 | Reviewer must not score likelihood of the event | **ARCHITECTURE-DECIDED** | Authoring §5.4 |
| D-6 | What "fresh session" means — fresh context, different model, or human | **OPEN** | A same-model author shares priors with the Chief being measured |
| D-7 | Blinding described as reduction, never elimination | **ARCHITECTURE-DECIDED** | Must appear in any result |

---

## E. Freeze and execution order

| # | Item | Status | Note |
|---|---|---|---|
| E-1 | Freeze before first planning call | **ARCHITECTURE-DECIDED** | Authoring §8 |
| E-2 | Per-task SHA-256 and a task manifest hash | **OPEN** | No tasks exist to hash |
| E-3 | Freeze provenance document | **OPEN** | P03's two-part pattern is the precedent |
| E-4 | Invalid-task policy | **OPEN** | A/B/C compared in Authoring §7; a combination proposed |
| E-5 | Ordering / randomization rule | **OPEN** | Four rules compared in Authoring §9; stratum-blocked seeded proposed |
| E-6 | Seed committed **before** execution, if a seeded rule is chosen | **OPEN** | A seed chosen after any result is not a seed |
| E-7 | No outcome-informed replacement, ever | **ARCHITECTURE-DECIDED** | |

---

## F. Harness and runtime

| # | Item | Status | Note |
|---|---|---|---|
| F-1 | Planning-only harness | **OPEN** | Currently **PARTIAL**; nothing implemented |
| F-2 | `runPlanningStage()` behaviour-preserving extraction | **OPEN** | Concept accepted as sound; **not implemented, not authorized** |
| F-3 | Proof the extraction moved no behaviour | **OPEN** | `test-round1-boundary.mjs` is the existing pattern |
| F-4 | Chief system prompt unchanged | **ARCHITECTURE-DECIDED** | |
| F-5 | `SPECIALIST_CAP`, registry, planner logic unchanged | **ARCHITECTURE-DECIDED** | |
| F-6 | Planning provider/model pin | **OPEN** | P03 used `openai/gpt-5`; not carried over by default |
| F-7 | Transport retry policy for census calls | **OPEN** | CAPTURE-3's `explicit-no-retry` is the obvious candidate |
| F-8 | Dependency provenance recorded and enforced against a baseline | **OPEN** | `dependency-provenance.mjs` exists and would apply |
| F-9 | Runtime fingerprint recorded | **OPEN** | Scope stays src/ + dist/; dependency provenance stays separate |
| F-10 | Call budget | **OPEN** | One planning call per task implies 60; the ceiling must be explicit |
| F-11 | STOP rules — integrity violations, budget, fingerprint drift | **OPEN** | |
| F-12 | Retrieval and temperature policy | **OPEN** | |

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
| G-3 | Event fields recomputable from the raw response | **OPEN** |
| G-4 | Verifier for census artifacts | **OPEN** |

---

## H. Analysis and reproducibility

| # | Item | Status | Note |
|---|---|---|---|
| H-1 | Analysis script design | **OPEN** | Must recompute events from artifacts, never read `eventJoint` as given |
| H-2 | Reproducibility check — same artifacts, same verdict | **OPEN** | |
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

## J. Readiness summary

```
68 checklist items

ARCHITECTURE-DECIDED   24
PROPOSED                8
OPEN                   34
DRAFT                   2
IMPLEMENTED             0
VERIFIED                0
```

**Not preregistration-ready.** The blocking clusters, in the order they gate
each other:

1. **B-2 … B-5** — the interval implementation decides the verdict; it cannot be
   chosen at analysis time.
2. **D-2, D-3, D-6, E-4, E-5** — authoring, review and ordering must be fixed
   before a single task is written, or the pool inherits whatever was convenient.
3. **C-8** — the 60 tasks. Nothing can be frozen until they exist, and they may
   not be authored until the items above are settled.
4. **F-1 … F-3** — the planning-only harness. Not implementable until GPT
   authorizes the `runPlanningStage()` extraction.

`[OPEN]` One structural gap worth naming: **A-8 asserts the routing rubric is
operational, and nothing currently measures it.** D-3's two-reviewer design is
the only proposal that would turn that assertion into a number. If a single
reviewer is chosen instead, the rubric's central claim stays untested.
