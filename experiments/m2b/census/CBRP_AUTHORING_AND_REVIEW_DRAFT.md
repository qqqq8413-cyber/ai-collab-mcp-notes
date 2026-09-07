# CBRP — Authoring and Structural Review Controls — DRAFT

```
STATUS:  DRAFT
         NOT ACCEPTED
         NOT PREREGISTERED
         NOT AUTHORIZED

TASKS AUTHORED SO FAR:  0
```

> Companion to [`CHIEF_NATURAL_COLLABORATION_CENSUS_DRAFT.md`](CHIEF_NATURAL_COLLABORATION_CENSUS_DRAFT.md).
> This document defines *how* the 60 CBRP tasks would be produced and checked.
> **It does not author any task**, and every option below is a proposal for
> architecture review.

---

## 1. The control this replaces

The first draft's bias control was a rule that authors *must not* write tasks
designed to elicit `deep` or multiple specialists. Gemini's review accepted the
intent and rejected the mechanism: **authoring intention alone is not a bias
control.** An author who knows the target cannot reliably un-know it, and no
audit can distinguish a task written honestly from one written hopefully.

This document replaces intention with **procedure**: withhold the target from
the person who writes the tasks.

### 1.1 The claim that is available

```
Blinded authoring REDUCES author bias.
It does NOT eliminate it.
```

`[DESIGN]` What blinding removes is one specific, identifiable channel: writing
toward a known target. What it cannot remove is that a fluent author writing
"a realistic strategy decision" may produce cases that read as needing a team,
purely from a prior about what interesting decisions look like. Any result must
therefore be reported as measured **under blinded authoring**, never as measured
free of authoring effects.

---

## 2. Blinded authoring envelope

Authoring occurs in **fresh session(s)** with no history of this project.

### 2.1 The author must NOT receive

```
Chief system prompt              F1 ｜ F2 ｜ any eligibility criterion
theta_feas                       the deep + assigned>=2 event definition
the P03 0/9 result               any desired complexity
any desired specialist count     any desired role
provider / model mapping         peer challenge design ｜ B / B' / C / D1
any expected study result        the fact that assignment count is measured
```

The last line matters most. Telling an author "we are counting how many
specialists get assigned" reintroduces the target in the one sentence that
sounds procedural.

### 2.2 The author receives ONLY

```
assigned stratum                 stratum routing rubric (census §3.2)
task realism rubric              self-containment requirements
task output format               prohibited leakage terms
diversity constraints            duplicate-avoidance instructions
```

### 2.3 Realism rubric (draft)

A CBRP task should read as something a real person would actually send:

- a concrete situation with an actor who has a reason to decide now
- enough supplied fact to answer without external lookup
- a genuine tension — the obvious answer is not free
- one clear final request, whose deliverable determines the stratum
- no meta-commentary about AI, agents, models, or how it should be answered

### 2.4 Self-containment

The task must be answerable from its own text. **No live retrieval, no external
lookup, no reference to documents not included.** This mirrors F5/F6 in the
M2-B protocol and is stated to the author as a writing constraint, without
naming F5 or F6.

### 2.5 Prohibited leakage terms

No task text may contain:

```
provider names ｜ model names ｜ agent or role identifiers
"specialist" ｜ any requested number of perspectives or experts
F1 ｜ F2 ｜ complexity labels ｜ "deep" as a system term
peer challenge ｜ experiment ｜ eligibility ｜ archetype ｜ stratum names as labels
```

---

## 3. Authoring session design — DECIDED

```
[ARCHITECTURE-DECIDED]

five fresh authoring sessions   AUTHOR-01 … AUTHOR-05
each authors 12 tasks           two per stratum, all six strata
                                5 x 2 x 6 = 60
every stratum therefore draws its ten tasks from all five session identities
```

This is the shape that keeps **author identity from being structurally confounded with
stratum**. The estimand is a rate across a stratified frame, so if a stratum's tasks came
from one author, a per-stratum difference and an author difference would be the same
observation and neither could be read. Spreading every session across every stratum makes
authoring style a source of noise instead of a source of structure.

It also bounds the other risk. A single session authoring all sixty would infer a great
deal about what is wanted by task forty, unprompted; twelve is short enough that there is
little arc to infer from.

The cost is five sessions instead of one, and a small allocation table. That is the price
of the confound not existing.

### 3.1 Fresh authoring session — operational definition

`[ARCHITECTURE-DECIDED]` A session qualifies only if **all** of these hold. Each:

- begins as a **new clean conversation**, with no carried context
- receives **no prior CBRP conversation history**
- receives **no Chief planning output**, from any run
- receives **no previously authored task text**, including its own from another session
- receives **no P03 outcome**
- receives **no F1 / F2 definition**
- receives **no formal event definition** — including the fact that assignment count is
  what gets measured
- receives **no θ_feas**
- receives **no desired specialist count**
- receives **no desired complexity**
- receives **no provider / model role map**
- receives **no peer-challenge arm information**

and receives **the same frozen authoring brief** as every other session, byte for byte.

Allowed context, and nothing else:

```
six-stratum routing rubric ｜ two-per-stratum requirement ｜ realism rules
self-containment rules ｜ diversity rules ｜ output schema ｜ forbidden leakage list
```

All of it lives in
[`CBRP_AUTHORING_BRIEF_PREREG_DRAFT.md`](CBRP_AUTHORING_BRIEF_PREREG_DRAFT.md), whose
hash is recorded in the pool manifest so a later reader can confirm every session got the
same brief.

`[OPEN]` Whether "fresh session" is satisfied by a fresh model context, a different model,
or a human author. A same-model author shares priors with the Chief being measured, which
is a real limitation of the cheapest reading and is not resolved here.

### 3.2 Session identity is provenance only

`AUTHOR-01 … AUTHOR-05` identify where a task came from. The authoring provider and model
may be recorded beside them, but **the census does not estimate an author-model effect**
and no result may be presented as one.

## 4. Task diversity controls

These exist to prevent 60 near-duplicates. They must **not** optimize for the
measured event.

Proposed dimensions, each to vary across the pool:

```
organization size          time horizon              reversibility
industry                   uncertainty level         stakes
requested output format    amount of supplied evidence
number of explicit alternatives
```

### 4.1 Forbidden framings

A diversity rule may never say:

```
ensure the task is multi-domain
ensure it requires multiple skills
ensure it is complex / deep
ensure the roles would disagree
ensure more than one kind of expertise is needed
```

Each of these is the event definition wearing a diversity costume. The
distinction is that legitimate dimensions vary properties of the **situation**;
forbidden ones vary properties of the **expected answer**.

`[ARCHITECTURE-DECIDED]` The forbidden instructions, stated as instructions rather than
as guidance, because each is the event definition in a diversity costume:

```
make some tasks deep
make some tasks multi-domain
make some tasks require multiple experts
ensure disagreement
ensure multiple specialists
```

The line is that legitimate dimensions vary properties of the **situation**; forbidden
ones vary properties of the **expected answer**.

`[OPEN]` Whether diversity is enforced as hard quotas per dimension or as a review-time
check that no dimension is degenerate. Quotas are auditable but can themselves shape the
pool; a review check is softer but weaker. The brief currently states the dimensions and
asks for variation without quotas.

**No actual tasks are designed here.**

---

## 5. Structural review

Every task is structurally reviewed **before any Chief call**.

### 5.1 Reviewer may see

```
task text ｜ assigned stratum ｜ routing rubric ｜ realism rubric ｜ formatting requirements
```

### 5.2 Reviewer must NOT see

```
Chief planning output ｜ event result ｜ complexity result
assignment count ｜ any expected outcome
```

Review happens before the first planning call, so there is nothing to see — but
the prohibition is stated because in a multi-wave execution it would otherwise
become possible, and outcome-informed review is the failure mode that would
quietly invalidate the freeze.

### 5.3 Checks

```
correct stratum under the routing rubric
primary requested output is clear and singular
self-contained and answerable from the text
realistic decision framing
no provider / model / agent leakage
no F1 / F2 / experiment leakage
no specialist-count steering
not an obvious duplicate of another task
no outcome-based editing
no hidden instruction targeting any registry role
```

### 5.4 The reviewer does NOT score

```
likelihood of deep ｜ likelihood of >= 2 assignments ｜ expected role combination
```

`[DESIGN]` A reviewer who scored these would be re-introducing the target at the
gate that blinding just protected — and would do it with more authority, because
review output is what decides whether a task enters the frozen pool.

---

## 6. Reviewer independence — DECIDED

```
[ARCHITECTURE-DECIDED]

two independent blinded structural reviews per task     <taskId>-R1, <taskId>-R2
reviewed separately; neither sees the other's answer
on disagreement, a third fresh blinded reviewer         <taskId>-R3
majority of the three is final
```

The third reviewer receives the task, its assigned stratum and the same frozen rubric —
and **not** the two earlier answers, nor the fact that a disagreement occurred. Told there
was a split, a tie-breaker is answering a different and much easier question than the one
the other two answered.

Two reviewers rather than one because the routing rubric's central claim is that two
readers can usually agree from the task text. Two makes that **measurable**: the
inter-reviewer disagreement rate is reported as a property of the rubric rather than
asserted about it. Reviewers are **not** assigned by stratum, for the same reason authors
are not.

### 6.1 GPT does not adjudicate task-level disagreements

`[ARCHITECTURE-DECIDED]` **FORBIDDEN.** GPT knows the measured event, θ, and the entire
P03 history. A tie-break from that position is an outcome-aware decision about which tasks
enter the pool, however carefully it is made, and it would be the one such decision in an
otherwise blinded procedure.

GPT audits afterwards: the procedure, the aggregate review evidence, protocol compliance.
The tie-break is a third blinded reviewer.

Full rubric and visibility rules:
[`CBRP_STRUCTURAL_REVIEW_RUBRIC_DRAFT.md`](CBRP_STRUCTURAL_REVIEW_RUBRIC_DRAFT.md).

## 7. Invalid task handling — DECIDED

`[ARCHITECTURE-DECIDED]` Three moments, three different rules, because the risk is
entirely a function of when the problem is found.

### 7.1 Pre-freeze — replacement permitted

Before the pool is frozen and before any Chief output exists, a structurally rejected task
is discarded and replaced. The replacement:

```
comes from a fresh authoring session under the same frozen brief
keeps the intended stratum and session quota
receives two independent structural reviews, and a third on disagreement
```

A rejected task **may never re-enter the pool**, and the rejection and replacement lineage
is preserved in the freeze manifest. Nothing here is outcome-informed: no Chief output
exists yet, so there is no outcome to be informed by.

### 7.2 Post-freeze, before the first Chief call — whole-pool re-freeze only

```
no task-text rewrite ｜ no task-content replacement
```

A **task-content methodological defect** invalidates the **complete pool freeze**: work
returns to authoring and review, and a new pool version covering all sixty tasks is frozen.
Patching one task would leave a pool whose members were admitted under two standards, with
nothing in the artifact recording which.

A **mechanical packaging error** may be corrected only if the **task bytes are unchanged**
and the correction is fully auditable.

### 7.3 After the first Chief call — nothing moves

```
no rewrite ｜ no replacement ｜ no exclusion ｜ no stratum reassignment
```

If a frozen task is then found to have a genuine structural defect: **STOP**, study status
`INCOMPLETE`, return to GPT Architecture Review. **A task is never dropped from the
denominator because of its result.**

### 7.4 Execution failure is not structural invalidity

`[DECISION]` The two must not be mixed. Provider, parse, schema, constraint and
resolved-pin failures remain governed by the census session contract — preserve, STOP,
`INCOMPLETE`, `NO_STATISTICAL_VERDICT`, no retry — and none of them says anything about
whether the task was well formed.

## 8. Freeze boundary

All 60 tasks must be **authored, structurally reviewed, finalized, hashed,
ordered, committed and pushed** before the **first** production Chief planning
call.

After that first call:

```
no rewrite ｜ no replacement ｜ no rebalance
no stratum reassignment based on Chief output
no deletion because of unwanted complexity
no deletion because of unwanted assignment count
```

The invalid-task exception exists only as far as the preregistered policy in §7
allows, and not one case further.

---

## 9. Ordering — DECIDED

```
[ARCHITECTURE-DECIDED]

seeded ROUND-ROBIN INTERLEAVING across the six strata

ten rounds, each containing exactly one task from each stratum
within-stratum order, and the order of the six strata within each round,
come from the frozen seed procedure

NOT six contiguous stratum blocks
```

### 9.1 What it buys, and what it does not

Provider behaviour may drift across a session, so the order in which strata meet the Chief
can confound **stratum identity** with **execution time**. Round-robin bounds that by
construction: each stratum appears once per round, so drift is spread evenly across all
six rather than concentrated in whichever ran last. Seeding the within-round order keeps
the sequence from being a fixed, predictable pattern while staying exactly reproducible.

`[DESIGN]` **It reduces structural confounding. It does not prove the absence of time
effects.** No ordering can; the claim available is that stratum and position are not
aligned by construction.

### 9.2 Seed governance

The seed must be derived **after** all sixty tasks are frozen and **before** any Chief
planning output exists:

```
task freeze commit
  → seed derivation
  → deterministic order materialization
  → order manifest commit and push
  → Final Pre-Live Review
  → only then may LIVE authorization even be considered
```

**A seed may never be selected on the basis of observed Chief output**, and the order
manifest is a separate artifact from the pool manifest precisely so the freeze commit
exists before the seed can be computed.

### 9.3 Seed method

```
PROPOSAL FOR GPT REVIEW — not accepted

seed = SHA-256( frozenPoolCommitSha + "\n" + "CBRP-ORDER-v1" )

then: a deterministic permutation derived from that seed, by a stated algorithm,
      applied within each stratum and to the six positions of each round
```

Its property is the one that matters: **the seed is a function of a commit that already
exists**, so there is exactly one seed and no discretionary choice. Seed shopping — trying
values until an attractive ordering appears — is not merely forbidden but unavailable,
because there is nothing to try.

The domain separator `CBRP-ORDER-v1` is preregistered so the derivation cannot be quietly
re-run with a different literal to obtain a different permutation.

`[OPEN]` The exact permutation algorithm from seed bytes to ordering is not fixed here.
Whatever is chosen must be deterministic, stated in advance, and independently reproducible
from the committed seed — and it must be fixed before the freeze, not after.

## 10. What this document is not

```
0 tasks authored          0 reviews run              0 authoring sessions run
0 pools frozen            0 seeds derived            0 provider calls
```

Procedure is now decided; **content does not exist**. The study is a
**PREREGISTRATION CANDIDATE**, not preregistered: no task pool exists, no review has run,
no freeze has occurred, and no ordering seed has been materialized.

`[DESIGN]` The author and reviewer procedures **reduce outcome-targeted selection bias.
They do not eliminate it.** CBRP remains a balanced synthetic reference frame, and no
result from it may be upgraded to production-wide, real-user prevalence, or a natural
production distribution.
