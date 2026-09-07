# Chief Natural Collaboration Census — CBRP — DRAFT

```
STATUS:  DRAFT
         NOT ACCEPTED
         NOT PREREGISTERED
         NOT AUTHORIZED FOR LIVE EXECUTION

REVISION: methodology revised after Gemini census review (NEEDS REVISION)
          and GPT architecture verdict (ACCEPT WITH CORRECTIONS)
```

> A **new study**, deliberately not called protocol 0.4: naming it as a protocol
> version would imply it inherits M2-B's accepted structure, when its whole point
> is that it asks a prior question M2-B assumed an answer to.
>
> No task pool exists. No harness exists. No sample has been drawn. Companion
> documents: [`CBRP_AUTHORING_AND_REVIEW_DRAFT.md`](CBRP_AUTHORING_AND_REVIEW_DRAFT.md),
> [`CBRP_PREREGISTRATION_CHECKLIST_DRAFT.md`](CBRP_PREREGISTRATION_CHECKLIST_DRAFT.md).

---

## 1. What changed in this revision, and why

The first draft asked about a "broad production-like task population". Gemini's
methodology review returned **NEEDS REVISION**; GPT's verdict was **ACCEPT WITH
CORRECTIONS**. The accepted concerns:

| Concern | Resolution in this revision |
|---|---|
| Target population was undefined | §2 defines **CBRP** as an explicit, preregistered, equally weighted synthetic reference frame |
| "production-wide" was an overclaim without usage weights | §2.2 forbids it outright; every result is scoped to CBRP |
| The original strata overlapped | §3 reduces to six primary-intent strata with a deterministic routing rubric |
| Some stratum descriptions asserted usage frequency | §3 justifies each stratum by what it *is*, never by how often it occurs |
| N = 45 was chosen before an operational threshold existed | §4 fixes θ_feas first, then §5 derives N = 60 from it |
| Authoring intention alone is not a bias control | §6 and the authoring document replace intention with a blinded procedure |

Two of Gemini's points were **accepted as already correct** and are preserved
unchanged: the `assigned ≥ 2` versus F2 distinction (§7), and the
behaviour-preserving `runPlanningStage()` extraction concept (§10).

Four corrections **to** Gemini, applied here:

```
do NOT adopt an arbitrary point-estimate >= 10% decision rule   →  §5.2
blinding REDUCES author bias; it does not eliminate it          →  §6
historical enterprise prompts are not required for this study   →  §3.3
no production-wide prevalence claim is permitted                →  §2.2, §9
```

---

## 2. Target frame — the Chief Balanced Reference Population

### 2.1 Definition

> **CBRP** — a synthetic, preregistered, **equally weighted** reference frame of
> six primary-intent task strata, ten tasks each, N = 60.

CBRP is a **controlled scientific reference population**. It is deliberately
balanced rather than representative, because a balanced frame is the one thing a
synthetic population can honestly be: it is a fixed, stated, reproducible
measurement condition rather than a guess at a distribution nobody has measured.

CBRP is **not** any of:

```
actual user traffic ｜ real-world prevalence
production telemetry ｜ production-wide usage distribution
```

### 2.2 Primary estimand — an average, not a common rate

For task *i*, define the indicator

```
Yi = 1   iff the POST-ENFORCEMENT production plan satisfies
         complexity = deep  AND  assignments.length >= 2
```

Each `Yi` has **its own** success probability `pi`. The tasks are sixty different
decisions in six different strata; nothing makes them equiprobable, and asserting
`p1 = p2 = … = p60` would be a claim about the Chief that this study is supposed
to measure rather than assume.

The estimand is therefore the **average**:

```
p̄ = (1/N) · Σ pi          over the frozen CBRP population
```

Required name for this quantity: **reference-population assignment rate**.

`[ARCHITECTURE-DECIDED]` **The inferential target is the average one-draw event
probability over the exact frozen CBRP tasks.** It does **not** include
task-sampling uncertainty from a larger real-world population, per-task
repeatability, production-wide prevalence, or any claim that a task's
classification is deterministic. Encoded as `ESTIMAND_SCOPE` in `statistics.mjs`
so the exclusions travel with the number.

**Model assumption:** independent, potentially **non-identically distributed**
Bernoulli observations. The count `K = Σ Yi` is a **Poisson-binomial** count, an
inhomogeneous Bernoulli chain — **not** an ordinary Binomial random variable, and
it must never be called one.

`[FACT]` The event source is the **post-enforcement** plan. `plan.assignments`
has already been through `planSchema`, `extractJsonObject` and
`enforceConstraints`, so it is what production would actually have dispatched.
**The raw Chief JSON assignment count must never be the formal event source** —
a planner that asks for five specialists when two are unknown and the cap is four
has proposed five and produced four, and the four is what happened.

**Allowed scoping** — every claim must carry one of these:

```
"within CBRP"
"under this balanced synthetic reference frame"
"CBRP precursor rate"
```

**Forbidden wording**, unless explicitly and truthfully scoped to CBRP:

```
production-wide natural base rate ｜ actual user rate ｜ real-world prevalence
"Chief usually…" ｜ "Chief rarely…"
```

The equal 1/6 weighting is a design choice. **It must never be read as a claim
that the six strata occur equally often in production.**

---

## 3. The six strata

Exactly six. Every task belongs to **exactly one**.

```
1. Strategy / Commitment
2. Operations / Execution
3. Brand / Creative
4. Evidence Interpretation
5. Product / Service Design
6. Finance / Resource Allocation
```

### 3.1 The routing rule

> **A task's stratum is determined by its PRIMARY REQUESTED OUTPUT** — the thing
> the asker wants back — **not by every domain that appears in the text.**

This is the rule the whole rubric rests on. Realistic decisions are
multi-domain by nature; a rubric keyed on "which domains appear" would route
almost everything to whichever stratum was checked first, and two reviewers
would rarely agree. Keying on the requested deliverable makes the question
answerable from the task's final paragraph.

**Operational test.** Read only the final request. Ask: *what artifact would a
complete answer hand back?* That artifact's kind selects the stratum.

### 3.2 Per-stratum rubric

Each stratum is justified by what kind of decision it is, never by how often it
occurs or by what it might elicit.

---

#### 1. Strategy / Commitment

**Inclusion.** The requested output is a **choice among mutually exclusive
directions**, or a commitment whose reversal is costly: which market, which
partner, whether to sign, which of A/B/C.

**Exclusion / handoff.** If the direction is already chosen and the request is
how to carry it out → *Operations / Execution*. If the request is which of
several claimants gets a fixed pool of money or people → *Finance / Resource
Allocation*.

**Positive examples.** Whether to accept an acquisition offer. Which of three
expansion markets to enter. Whether to renew an exclusive distribution
agreement.

**Near-boundary.** *"We have decided to enter Market B; sequence the entry."* →
Operations / Execution: the commitment is made and the deliverable is a plan.

**Note.** High-stakes contracts are a task **form**, not a stratum. They usually
route here because the requested output is a commitment decision — but a
contract task whose request is "model the cash-flow impact" routes to Finance.

---

#### 2. Operations / Execution

**Inclusion.** The direction is settled; the requested output is **how to
execute** — sequencing, capacity, staffing, timelines, throughput, rollout.

**Exclusion / handoff.** If the request is whether to do it at all → *Strategy /
Commitment*. If the deliverable is what the offering itself should be →
*Product / Service Design*.

**Positive examples.** Sequence a three-site rollout under a fixed installation
crew. Restructure a support rota to cut escalation time.

**Near-boundary.** *"Should we hire two engineers or outsource, given this
backlog?"* → Finance / Resource Allocation if the request is how to spend a
fixed budget; Operations if the request is how to clear the backlog and staffing
is one lever among several.

---

#### 3. Brand / Creative

**Inclusion.** The requested output is a **judgement about identity, positioning,
naming, voice or creative direction** — an artifact whose quality is judged by
resonance and coherence rather than by arithmetic.

**Exclusion / handoff.** If the request is which market to pursue → *Strategy*.
If the request is what the product should do → *Product / Service Design*.

**Positive examples.** How to reposition a heritage brand for a younger segment.
Whether to retire a sub-brand and what to say when doing so.

**Near-boundary.** *"Our positioning is confusing customers; fix the onboarding
flow."* → Product / Service Design: the deliverable is the flow, not the
positioning.

---

#### 4. Evidence Interpretation

**Inclusion.** The asker supplies data, findings or conflicting reports, and the
requested output is **what it means** — a reading, a diagnosis, a judgement about
sufficiency.

**Exclusion / handoff.** If evidence is supplied but the request is which option
to pick → *Strategy*. If the request is which budget line to fund → *Finance*.

**Positive examples.** Two studies disagree on a treatment's efficacy; which
reading is better supported. A retention cohort table shows an anomaly; what is
it.

**Near-boundary.** *"Given this churn data, should we cut the mid tier?"* →
Strategy / Commitment: the deliverable is a decision, and the data is input.

---

#### 5. Product / Service Design

**Inclusion.** The requested output is **what the offering should be** — scope,
feature set, tiers, service model, customer-facing mechanics.

**Exclusion / handoff.** If the request is how to build or ship it →
*Operations*. If the request is what it should be *called* or stand for →
*Brand / Creative*.

**Positive examples.** Design a tiering structure for a diagnostics service.
Decide what a self-serve plan should include.

**Near-boundary.** *"Design a mid tier that fits within this budget."* →
Product / Service Design, because the deliverable is the tier; the budget is a
constraint, not the request.

---

#### 6. Finance / Resource Allocation

**Inclusion.** The requested output is **how to divide a finite resource** —
money, headcount, capacity — among competing claimants, or a judgement about
financial structure.

**Exclusion / handoff.** If a budget merely constrains a design or plan → the
stratum of that design or plan.

**Positive examples.** Allocate a fixed capital budget across three plants.
Decide the split between retention and acquisition spend.

**Near-boundary.** *"We are expanding into two adjacent products; how should we
allocate the fixed launch budget between them?"* → **Finance / Resource
Allocation.** The expansion is context; the request is the split.

---

#### 3.3 Two rules the rubric exists to enforce

**When two domains appear**, route by the final requested output. Worked pair:

```
product expansion, final question = allocate a fixed budget
    → Finance / Resource Allocation

financially constrained, final deliverable = a service design
    → Product / Service Design
```

**"Ordinary" is not a stratum.** Difficulty must vary **within** all six. A
stratum that collected only the easy cases would make the others artificially
hard, and the difficulty gradient would then be confounded with stratum
identity.

`[DESIGN]` Historical enterprise prompts are **not required** for this first
study. CBRP is explicitly a synthetic balanced frame, not a sample of real
traffic; requiring real prompts would change the study into one this packet is
not designing.

---

## 4. Operational feasibility threshold

```
theta_feas = 0.05        [DESIGN DECISION]
```

At a precursor rate of 5%, the expected number of planning tasks per observed
`deep ∧ assigned ≥ 2` event is `1 / 0.05 = 20`.

That figure is already **optimistic**, because the precursor sits *before* every
later loss:

```
precursor: deep AND assigned >= 2
    ↓ worker execution success
    ↓ F2: >= 2 SUCCESSFUL specialists
    ↓ formal F4: material cross-agent decision-sensitive disagreement
    ↓ final usable acquisition yield
```

So for **this** M2-B acquisition architecture, a precursor rate below 5% is
treated as **operationally too sparse**.

`[DESIGN DECISION]` — and explicitly **not** any of:

```
a scientific definition of "rare"
a universal product threshold
proof of infeasibility
an estimate of real-world prevalence
```

---

## 5. Sample size and decision rule

### 5.1 Why N = 60 follows from θ_feas

The threshold is fixed first; the sample size is then whatever can actually
reach a verdict against it.

For **zero** observed events, the exact one-sided 95% upper bound is
`1 − 0.05^(1/N)`:

| N | zero-event 95% upper bound | can a zero result conclude TOO_SPARSE? |
|---|---|---|
| 30 | 9.50% | No — far above θ |
| 45 | 6.44% | **No** — still above θ, verdict would be INCONCLUSIVE |
| **60** | **4.87%** | **Yes** — crosses below θ = 5% |

`[FACT]` **N = 59 is the smallest integer** satisfying the zero-event condition:
`1 − 0.05^(1/59) = 4.951% ≤ 5%`, while N = 58 gives 5.034%. Solving
`1 − 0.05^(1/N) ≤ 0.05` gives `N ≥ 58.404`.

CBRP additionally requires six equal strata with equal task counts. **N = 60 is
therefore the smallest *balanced six-stratum design*** satisfying the condition —
`6 × 10` — and that, not the statistical minimum, is why it is the design target.
Stating it the other way round would be false.

`[DESIGN]` Sample size is **not** justified by runtime or wall-clock cost. The
previous draft's timing estimates are demoted to non-decisional provenance:
P03's nine planning calls ran 6.9 s–45.9 s (mean 18.5 s), recorded only so a
future operator can plan a session, and **no design choice rests on them**.

### 5.2 Decision rule

**Method: heterogeneous-Bernoulli-valid Buehler-optimal one-sided bounds**
(Mattner–Tasto), α = 0.05, β = 0.95, against θ_feas = 5%.

The name matters. Ordinary Clopper–Pearson is derived for *identically*
distributed trials; using it here and calling it Clopper–Pearson would assert the
homogeneity §2.2 explicitly refuses. The Buehler-optimal construction for the
average success probability of independent **non-identical** Bernoulli trials is
valid without that assumption. At β = 0.95 **most interior endpoints coincide
exactly with the ordinary one-sided CP endpoints**; only the extreme cases differ:

```
lower bound      k = 0        0
                 k = 1        (1 - beta) / N          = 0.05/60 = 0.0833%
                 k >= 2       ordinary one-sided CP lower endpoint  g_N(k)

upper bound      k <= N-2     ordinary one-sided CP upper endpoint
                 k = N-1      1 - (1 - beta) / N      = 99.9167%
                 k = N        1
```

Decision zones:

```
VIABLE         one-sided 95% LOWER bound  >  5%
TOO_SPARSE     one-sided 95% UPPER bound  <= 5%
INCONCLUSIVE   otherwise
```

Computed zones at N = 60 (`[SIGNAL]` — recomputed at analysis time by the
preregistered implementation, not read from this table):

| events k | point | 95% lower | 95% upper | zone |
|---|---|---|---|---|
| 0 | 0.00% | 0.0000% | 4.8703% | **TOO_SPARSE** |
| 1 | 1.67% | 0.0833% ← MT | 7.6640% | INCONCLUSIVE |
| 2 | 3.33% | 0.5955% | 10.1236% | INCONCLUSIVE |
| 3 | 5.00% | 1.3765% | 12.4187% | INCONCLUSIVE |
| 4 | 6.67% | 2.3091% | 14.6097% | INCONCLUSIVE |
| 5 | 8.33% | 3.3411% | 16.7263% | INCONCLUSIVE |
| 6 | 10.00% | 4.4453% | 18.7857% | INCONCLUSIVE |
| 7 | 11.67% | 5.6055% | 20.7991% | **VIABLE** |
| ≥ 8 | — | ≥ 6.8110% | — | **VIABLE** |

`[FACT]` **The correction does not move the accepted operational zones.** Only
`k = 1`'s lower endpoint changes at all — from CP's 0.0855% to MT's 0.0833% —
and both sit far below θ, so `k = 1` is INCONCLUSIVE either way. `k = 0` remains
TOO_SPARSE, `k ≥ 7` remains VIABLE. The methodology was corrected without
silently relocating the threshold it is judged against.

The point estimate is **reported descriptively and never decides anything**.
Row `k = 6` is why: its point estimate is exactly 10%, and under the rejected
"point estimate ≥ 10%" rule it would have been called viable, while its true
rate is not distinguishable from 4.4%.

### 5.2.1 The independence assumption

`[DESIGN]` The confidence interpretation assumes the sixty planning observations
are **independent**. That is a **modeling assumption**, and it is not established
by anything the harness records:

```
runtime fingerprint   attests this repository's src/ and dist/, not the backend
model pin             attests what was requested and reported, not backend state
provider pin          attests routing, not statistical independence
dependency provenance attests installed bytes, not server behaviour
```

Execution controls — a fixed model pin, no retries, a single session, a
preregistered order — **reduce avoidable nonstationarity**. They do not prove
backend stochastic independence, and no artifact this study can produce would.
Any result must state the assumption rather than imply it was verified.

`[ARCHITECTURE-DECIDED]` **The rule is asymmetric, and the asymmetry is accepted
for Phase 1.** Only `k = 0` can produce TOO_SPARSE, so the design rules *in* far
more readily than it rules *out*, and a single event makes a sparse-but-nonzero
rate unresolvable at N = 60. That is accepted rather than engineered away.

**INCONCLUSIVE is a valid preregistered outcome.** It is what the design returns
when sixty observations genuinely do not separate the hypotheses, and reporting it
is the study working. The alternative — enlarging N after seeing k, or moving θ
until a bound lands somewhere decisive — is exactly what preregistering the rule
prevents. Any result must state the asymmetry alongside the verdict.

### 5.3 Exact interval implementation — OPEN

`[CLOSED]` **M-CBRP-STAT-01 — heterogeneous Bernoulli interval specification.**

```
specification   CLOSED
implementation  CBRP-MT-BUEHLER-1  →  experiments/m2b/census/statistics.mjs
status          VERIFIED — 31 deterministic tests, all eight pinned vectors,
                beta_60 guard, monotonicity, L(k) = 1 − U(N−k), zone transitions
```

The implementation pins the numerical contract — bracket `[0,1]`, tolerance 1e-14,
200 fixed bisection iterations, no stochastic step, unrounded decision comparisons,
six-decimal display — and implements the MT endpoints of §5.2 **including the
`k = 1` and `k = N−1` special cases**. A test asserts that ordinary CP's values at
those two points are *rejected*, since an implementation that silently used CP
throughout would agree everywhere else and be wrong exactly where the correction
matters.

It also fails closed below the Buehler-optimality condition
`beta_N = (1 − 1/N)^(N−1)(2 − 1/N)`, which is `0.7357675420279305` at N = 60. The
method is not applied outside its supported range.

The candidate approaches below are retained as the record of what was considered.

| Approach | For | Against |
|---|---|---|
| Beta-quantile identity for the CP interior (`L = BetaInv(α; k, n−k+1)`, `U = BetaInv(1−α; k+1, n−k)`), with the MT endpoints special-cased | Standard, one line given a beta quantile | Adds a dependency, or a hand-written incomplete-beta; the special cases must not be forgotten |
| Bisection on the exact binomial CDF | No dependency; the CDF is a short exact sum at n = 60 | Convergence tolerance and iteration count must be preregistered |
| Independent recomputation in R/Python (`binom.test`, `scipy.stats.beta.ppf`) as a **cross-check** | An external second implementation is the strongest audit | Requires a second toolchain; must be a check, not the source of truth |

Must be pinned before preregistration:

```
alpha = 0.05, beta = 0.95, one-sided    numerical tolerance / iteration bound
MT special cases k = 1 and k = N-1     edge cases k = 0 and k = N
rounding and reported precision        independent reproduction by a reviewer
```

---

## 6. Bias control — blinded authoring

Author intention is not a control. Procedure is.

`[DESIGN]` **Blinding REDUCES author bias. It does NOT eliminate it.** An author
who has never seen the event definition can still, unprompted, write tasks that
feel like they need a team. The claim available is that a specific and
identifiable channel — writing toward a known target — has been removed.

Full envelope: [`CBRP_AUTHORING_AND_REVIEW_DRAFT.md`](CBRP_AUTHORING_AND_REVIEW_DRAFT.md).

---

## 7. Phase 1 measures assignment, not F2

```
census Phase 1 event    assigned specialist count >= 2      planning only
protocol F2             SUCCESSFUL specialist count >= 2    requires Round 1
```

Assignment is **necessary and not sufficient** for F2: a worker can be assigned
and then fail, which is exactly what `report.status` and `successfulWorkerCount`
exist to separate.

**Forbidden Phase 1 wording:**

```
"F2 pass" ｜ "F2 rate" ｜ "successful collaboration rate"
```

### 7.1 Phase 2

```
NOT DESIGNED ｜ NOT PREREGISTERED ｜ NOT AUTHORIZED
```

Not designed in this packet. What would have to exist before one could even be
*proposed*: a Phase 1 result and its verdict; an architecture decision on
whether worker execution on CBRP tasks is worth its cost; a call budget and a
retry/transport policy for worker calls; and a stated position on whether Phase 2
would reuse the frozen CBRP pool or require a fresh one, since running workers
over tasks whose planning results are already known is a different design with
different contamination risks.

---

## 8. Recorded per task, and primary measures

Draft artifact contract: §20 of
[`CBRP_PREREGISTRATION_CHECKLIST_DRAFT.md`](CBRP_PREREGISTRATION_CHECKLIST_DRAFT.md).

```
P(deep | CBRP)
P(assigned >= 2 | CBRP)
P(deep AND assigned >= 2 | CBRP)          ← the estimand
distribution of assignment counts
role assignment frequencies
role combination frequencies
complexity x assignment-count contingency table
```

All descriptive. **No causal language anywhere**: not "because", not "due to",
not "driven by".

---

## 9. Claim boundary

The census may **not** establish any of:

```
production-wide prevalence ｜ actual user behaviour prevalence
worker success ｜ F2 success ｜ collaboration quality
peer-challenge effectiveness
task-type causation ｜ complexity causation
provider effect ｜ model effect ｜ role-selection causation
```

Allowed conclusion shape:

> **"Within the preregistered CBRP reference frame, …"**

### 9.1 Wording fixed by the P03 architecture review, carried forward

`[FACT]` Within P03, all six deep candidates were assigned one specialist.
`[FACT]` The two multi-specialist candidates were classified normal.
`[SIGNAL]` The observed P03 sample suggests that task complexity classification
and specialist necessity are distinct planning dimensions for production Chief.
`[INFERENCE]` The P03 task population may not have sampled the kind of naturally
occurring case that jointly satisfies deep + multi-specialist collaboration.

Not established, and not writable as fact: inverse or absent correlation between
complexity and specialist count; Chief systematically avoiding multi-specialist
deep tasks; a Chief defect; an F2 defect; retrieval causing `market_researcher`'s
absence; provider mapping causing role selection; M2-B being infeasible; peer
challenge being ineffective; P03 proving production-wide collaboration behaviour.

### 9.2 M-ACQ-01 stays open

CBRP would characterize a **balanced-reference precursor rate**. It would not by
itself establish production telemetry prevalence. **M-ACQ-01 is not closed by
this study**, whatever its result.

---

## 10. Feasibility — what exists today

```
PLANNING-ONLY HARNESS:  PARTIAL
```

**Exists.** `dist/agents/chief.js` exports `CHIEF_SYSTEM_PROMPT`,
`buildPlanningPrompt` and `SPECIALIST_CAP`. The capture recorder's stage
allowlist is `['planning', 'round1_worker']`, so a planning-only round is already
inside its authorized scope, with its pre-call guards, budget reservation,
transport no-retry injection and journal applying unchanged.

**Missing.** No stage primitive stops after planning — `runRound1Stage()` plans
and then dispatches workers through `Promise.all` in one function — and the three
pieces that turn a raw planning response into the plan production acts on are
module-private:

```
planSchema ｜ extractJsonObject ｜ enforceConstraints
```

A census that re-implemented those would measure its own parser rather than
production's planner: the same class of mistake as re-implementing segmentation,
rejected there for the same reason. The archived `test-chief-live.mjs` did
exactly this, hand-rolling fence-stripping and its own assertions, so its results
were never production-equivalent.

**Smallest behaviour-preserving boundary** (described, deliberately not built):

> Extract the planning half of `runRound1Stage()` into an exported
> `runPlanningStage()`, and have `runRound1Stage()` call it. The extraction must
> preserve `CHIEF_SYSTEM_PROMPT`, `buildPlanningPrompt`, `planSchema`,
> `extractJsonObject`, `enforceConstraints`, specialist-cap logic, dedup, roster
> validation, planning adjustments, provider/model behaviour and error semantics.
> Provable by the existing `test-round1-boundary.mjs` pattern, which exists
> precisely to show that extracting a stage moved no behaviour.

**Not done here:** no harness, no export, no task pool, no `src/**` change, no
provider call.

---

## 11. What this draft is not

```
not accepted        not preregistered      not authorized
not protocol 0.4    not an effectiveness study
does not change F1-F7 ｜ Chief ｜ P03 evidence ｜ M-ACQ-01 status
0 tasks authored ｜ 0 harness code ｜ 0 provider calls
```
