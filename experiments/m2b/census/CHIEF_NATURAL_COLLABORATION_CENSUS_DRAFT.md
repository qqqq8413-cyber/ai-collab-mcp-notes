# Chief Natural Collaboration Census — DRAFT

```
STATUS:  DRAFT
         NOT ACCEPTED
         NOT PREREGISTERED
         NOT AUTHORIZED FOR LIVE EXECUTION
```

> This is a **new study**, not an amendment. It is deliberately **not** called
> protocol 0.4: naming it as a protocol version would imply it inherits M2-B's
> accepted structure, and the whole point is that it asks a prior question M2-B
> assumed an answer to.
>
> Nothing here is authorized. No task pool is frozen, no sample size is chosen,
> no harness is built. Every number below is a proposal for review.

---

## 1. Primary research question

> **How often does unchanged production Chief naturally choose multi-specialist
> collaboration across a broad, production-like task population?**

and specifically:

```
P( complexity = deep  AND  assigned specialist count >= 2 )
```

### 1.1 What this measures, and what it does not

This census measures **assignment behaviour**. It does not measure protocol F2.

```
F2 (protocol)          >= 2 SUCCESSFUL specialists      requires Round 1 execution
census (phase 1)       >= 2 ASSIGNED specialists        requires planning only
```

A planning-only census can only observe the **precursor** of F2. Assignment is
necessary for F2 and not sufficient for it: a worker can be assigned and then
fail, which is exactly the case `report.status` and `successfulWorkerCount`
exist to distinguish. Every result in this study must therefore be written as
"assigned ≥ 2", never as "F2 pass".

This distinction is kept explicit throughout because collapsing it would
reintroduce, in the measurement, precisely the assumption the study exists to
check.

---

## 2. Why this study exists

`[FACT]` P03 preregistered nine candidates across three archetypes and attempted
all nine, one attempt each. **`deep` AND `assigned ≥ 2` occurred 0 times.**

```
Wave 1   S1 / E1 / I1   deep   ｜ 1 specialist each
Wave 2   S2 / E2        normal ｜ 2 specialists each
         I2             deep   ｜ 1 specialist
Wave 3   S3             normal ｜ 1 specialist
         E3 / I3        deep   ｜ 1 specialist each

F1 failures 3/9 ｜ F2 failures 7/9 ｜ F3 failures 0/9 ｜ admitted 0/9
```

P03 assumed that `deep` + multi-specialist cases could be acquired by authoring
tasks intended to produce them. It never established how often such cases occur
naturally. Those are different claims, and only the first was ever tested.

`[FACT]` Nine observations with zero events bound the frequency only weakly. The
one-sided 95% upper bound from P03 alone is **≈ 28%** — which is compatible with
"common but unlucky" and with "genuinely rare" at the same time. P03 is
therefore strong evidence *about P03* and insufficient to estimate a
production-wide rate.

Until that rate is characterized, changing `Chief`, `F1`, `F2`, the task
construction rules, or the effectiveness question would be tuning against a
sample of nine.

---

## 3. Design principles

Everything the census observes must be production behaviour, unmodified:

```
Chief system prompt      UNCHANGED
Chief planning behaviour UNCHANGED
SPECIALIST_CAP           UNCHANGED
Agent registry           UNCHANGED
```

Role→provider mapping is **irrelevant to task selection** and must not enter it.

### 3.1 Task content prohibitions

No census task may mention:

```
provider names ｜ model names ｜ a desired specialist count
F1 ｜ F2 ｜ peer challenge ｜ experiment eligibility ｜ archetype labels
```

### 3.2 The authoring rule that matters most

Task authors **must not** design cases to force `deep`, multiple specialists,
`market_researcher`, `brand_creative`, or any role combination.

> **The desired outcome is measurement, not qualification.**

A task written to elicit two specialists measures the author, not the Chief. If
the census population were selected for the property being measured, a high
observed rate would be an artifact and a low one would be uninterpretable. This
is the specific failure the census exists to avoid repeating, so it is stated as
a rule rather than as guidance.

---

## 4. Task population

A production-like population, stratified by the kinds of decision the product is
actually used for. **Strata are not chosen by expected specialist count**, and
each is justified below by why it belongs in a realistic population — never by
what it is likely to elicit.

| Stratum | Why it belongs in a production-like population |
|---|---|
| Business strategy | The archetypal reason a user opens an orchestrator: an open decision with several defensible answers |
| Operations / execution | The most common *ordinary* request; scheduling, capacity, sequencing questions dominate real usage |
| Brand / creative | A distinct output mode — judgement about positioning and voice rather than about numbers |
| Research / evidence interpretation | Users bring data they already have and ask what it means; this is a recurring product shape |
| Product / service design | Scope-and-tradeoff decisions, a standing category in the product's own examples |
| Financial / resource allocation | Budget and headcount decisions are among the most frequently delegated real tasks |
| High-stakes contracts / commitments | Low frequency, high consequence; excluded only by an unrealistic population |
| Ordinary project decisions | Deliberately mundane. A population made only of weighty questions is not production-like, and its absence would bias every rate upward |

The last row is load-bearing. A census composed only of hard problems would
measure Chief's behaviour on hard problems and be reported as its behaviour in
general.

`[OPEN]` Stratum weights are not proposed here. Equal allocation is the simplest
defensible default; a usage-weighted allocation would be better if usage data
exists. This is an architecture decision, not an engineering one.

**No task pool is created by this draft.** Authoring, structural review, hashing
and freezing would be a separate authorized round, on the P03 pattern.

---

## 5. Sample size — three candidate designs

Phase 1 costs **one planning call per task**. Observed P03 planning calls:
min 6.9 s, median 14.0 s, max 45.9 s, mean 18.5 s (n = 9, `openai/gpt-5`).

If the census observes **zero** `deep ∧ assigned ≥ 2` events, the one-sided 95%
upper bound on the true rate is `1 − 0.05^(1/N)`:

| N | live planning calls | ≈ wall clock at observed mean | 95% upper bound if zero events | rule-of-three approx |
|---|---|---|---|---|
| **30** | 30 | ~9 min | **9.50%** | 10% |
| **45** | 45 | ~14 min | **6.44%** | 6.7% |
| **60** | 60 | ~19 min | **4.87%** | 5% |

*(Approximation labels: the bound is the exact Clopper–Pearson one-sided limit
for zero successes; "rule of three" is the familiar `3/N` approximation, shown
only to make the exact figure legible. Wall clock is a mean-based estimate, not
a guarantee — the observed spread is 6.9–45.9 s and calls may run serially.)*

### 5.1 What each buys

- **N = 30** — distinguishes "roughly a coin-flip" from "under 10%". Cheapest,
  and enough to refute a claim that the joint case is *common*. It cannot
  distinguish 2% from 8%, which is the range where the interesting follow-up
  decisions differ.
- **N = 45** — the first size at which a zero result bounds the rate under ~6.5%,
  which is low enough to say the joint case is *rare in this population* without
  overclaiming. Non-zero results also start to be estimable rather than merely
  present.
- **N = 60** — buys the 5% threshold and roughly a 50% cost increase over N = 45
  for a ~1.6 percentage-point tightening. Worth it only if a decision actually
  turns on 5% versus 6.5%.

### 5.2 Recommendation

```
PROPOSAL ONLY — NOT ACCEPTED

N = 45, allocated across the eight strata
```

Reasoning: the decision this census feeds is qualitative — whether P03's
population was unrepresentative, or whether the joint condition is genuinely
rare. N = 45 separates those two readings; N = 30 leaves them overlapping; N = 60
sharpens a number no current decision depends on. If a stratum-level rate is
later wanted rather than a pooled one, N = 45 is too small for that and the size
should be reconsidered at that point rather than inflated now on speculation.

---

## 6. Phase 1 — planning-only census

```
one Chief planning call per frozen task

NO Round 1 worker execution   NO synthesis   NO Gate
NO A2                         NO peer challenge   NO effectiveness arm
```

### 6.1 Recorded per task

```
task id ｜ task sha256 ｜ stratum
complexity
requiredCapabilities
assignments ｜ assignment count ｜ assigned agent ids
requiresRedTeam
Chief reason (verbatim)
planning provider/model pin provenance (requested and resolved)
runtime provenance (runtime fingerprint, dependency provenance, execution head)
```

### 6.2 Primary descriptive measures

```
P(deep)
P(assigned >= 2)
P(deep AND assigned >= 2)          ← the question
distribution of assignment counts
role assignment frequencies
role combination frequencies
complexity x assignment-count contingency table
```

All descriptive. **No causal language** anywhere in the results: not "because",
not "due to", not "driven by".

---

## 7. Scientific boundary

The census may **not** conclude any of:

```
multi-specialist improves quality
deep causes fewer specialists
task type causes role selection
retrieval policy causes researcher selection
provider mapping causes planner behaviour
peer challenge works  ｜  peer challenge fails
```

It characterizes **observed Chief allocation behaviour under a preregistered task
population**, and nothing else. In particular it is not an effectiveness study
and produces no evidence about C versus D₁.

### 7.1 Wording already fixed by architecture review

These are `[FACT]` and may be written as such:

```
Within P03, all six deep candidates were assigned one specialist.
The two multi-specialist candidates were classified normal.
```

This is `[SIGNAL]`:

```
The observed P03 sample suggests that task complexity classification and
specialist necessity are distinct planning dimensions for production Chief.
```

This is `[INFERENCE]`:

```
The P03 task population may not have sampled the kind of naturally occurring
case that jointly satisfies deep + multi-specialist collaboration.
```

None of the following is established, and none may be written as fact:

```
inverse correlation between complexity and specialist count
specialist count is uncorrelated with complexity
Chief systematically avoids multi-specialist deep tasks
Chief has a design defect        ｜  F2 is defective
market_researcher was absent because retrieval was disabled
provider mapping caused role selection
M2-B is infeasible               ｜  peer challenge is ineffective
P03 proves production-wide collaboration behaviour
```

---

## 8. Follow-up decision logic — drafted, not selected

`[OPEN]` These are future architecture decisions. Listing them now keeps the
census from being read after the fact in whichever direction its result points.

- **If `deep ∧ assigned ≥ 2` is reasonably common** → P03 likely sampled an
  unrepresentative task population. A new acquisition population may be
  justified **while preserving F1 and F2 unchanged**.
- **If `deep ∧ assigned ≥ 2` is very rare** → reconsider whether M2-B's
  conditioning population matches actual product collaboration behaviour. This
  is a question about the experiment's target population, not about whether the
  gates are correct.
- **If `assigned ≥ 2` is common but `deep ∧ assigned ≥ 2` is rare** →
  investigate whether complexity and collaboration need **separate conditioning
  definitions** in a future protocol.

None of these is implemented, chosen, or ranked here.

---

## 9. Feasibility — what exists today

```
PLANNING-ONLY HARNESS:  PARTIAL
```

**What exists.** `dist/agents/chief.js` exports `CHIEF_SYSTEM_PROMPT`,
`buildPlanningPrompt` and `SPECIALIST_CAP`, so the production planning prompt can
be constructed without running any worker. The capture recorder's stage
allowlist is `['planning', 'round1_worker']`, so a planning-only round already
sits inside its authorized scope, and its pre-call guards, budget reservation,
transport no-retry injection and journal apply unchanged.

**What is missing.** There is no stage primitive that stops after planning.
`runRound1Stage()` performs planning and then dispatches workers through
`Promise.all` in the same function, and the three pieces that turn a raw planning
response into the plan production actually acts on are module-private:

```
planSchema           not exported   zod validation of the planner's JSON
extractJsonObject    not exported   fence-tolerant JSON extraction
enforceConstraints   not exported   caps, dedup, roster validation, adjustments
```

A census that re-implemented those would be measuring its own parser rather than
production's planner — which is the same class of mistake as re-implementing
segmentation, and it was rejected there for the same reason. The archived
`test-chief-live.mjs` did exactly this: it hand-rolled fence-stripping and its
own assertions, so its results were never production-equivalent.

**Smallest engineering boundary required** (described, deliberately not built):

> Extract the planning half of `runRound1Stage()` into an exported
> `runPlanningStage()` returning the same `plan` and `planningAdjustments` that
> `runRound1Stage()` computes, and have `runRound1Stage()` call it. That is a
> pure refactor with no behavioural change, provable by the existing
> `test-round1-boundary.mjs` pattern — which already exists precisely to prove
> that extracting a stage moved no behaviour.

`[OPEN]` Whether to make that change, and whether the census should reuse the
capture recorder or get its own thinner one, are architecture decisions.

**Not done in this round:** no harness, no export, no task pool, no provider
call, no `src/**` change.

---

## 10. What this draft is not

```
not accepted            not preregistered        not authorized
not protocol 0.4        not an effectiveness study
does not change F1-F7   does not change Chief    does not change P03 evidence
```

P03 remains closed at 9/9 attempted, 0 admitted. Its negative result stands
exactly as recorded; this study exists because that result raised a question it
cannot itself answer.
