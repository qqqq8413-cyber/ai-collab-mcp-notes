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

## 3. Authoring session design — three options

`[OPEN]` Not chosen here.

### Option A — one fresh session authors all 60

| | |
|---|---|
| Session-style dependence | **Highest.** One voice, one set of narrative habits across the entire population |
| Cross-task homogeneity | High risk: 60 tasks that share sentence rhythm and framing |
| Author contamination | Rises with length — by task 40 the author has inferred a great deal about what is wanted, even unprompted |
| Consistency | Best: one interpretation of the rubric throughout |
| Operational burden | Lowest |
| Auditability | Simple provenance: one session, one transcript |

### Option B — six fresh sessions, one per stratum

| | |
|---|---|
| Session-style dependence | **Confounded with stratum.** Each stratum inherits one author's voice, so a stratum difference and an author difference become indistinguishable |
| Cross-task homogeneity | Lower overall, but high *within* stratum |
| Author contamination | Lower per session (10 tasks each) |
| Consistency | Six rubric interpretations; boundary cases may route differently |
| Operational burden | Moderate |
| Auditability | Clean: six transcripts, one per stratum |

### Option C — multiple fresh sessions with balanced allocation across strata

Each session authors a few tasks in **several** strata; every stratum is covered
by several sessions.

| | |
|---|---|
| Session-style dependence | **Lowest, and not confounded with stratum** — style spreads across strata rather than aligning with them |
| Cross-task homogeneity | Lowest |
| Author contamination | Lowest: short sessions, no long arc to infer from |
| Consistency | Weakest; needs the routing rubric to carry more weight |
| Operational burden | Highest: more sessions, more allocation bookkeeping |
| Auditability | Most transcripts, but a clear allocation table makes it tractable |

### Recommendation

```
PROPOSAL ONLY — NOT ACCEPTED

Option C, with an allocation that gives every stratum tasks from
at least three different sessions.
```

Reasoning: Option B's flaw is disqualifying for this study specifically. The
estimand is a rate compared across a stratified frame; if author identity aligns
with stratum, any per-stratum pattern is uninterpretable. Option A is
acceptable if operational cost dominates, but it maximizes both homogeneity and
the long-session contamination that blinding is meant to limit. C costs the most
and is the only option that leaves no structural confound.

`[OPEN]` The exact number of sessions and the allocation table are unset. So is
whether "fresh session" means a fresh model context, a different model, or a
human author — a real question, since a same-model author shares priors with the
Chief being measured.

---

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

`[OPEN]` Whether diversity is enforced as hard quotas per dimension or as a
review-time check that no dimension is degenerate. Quotas are auditable but can
themselves shape the pool; a review check is softer but weaker.

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

## 6. Reviewer independence — four options

`[OPEN]` Not chosen here.

| Option | For | Against |
|---|---|---|
| **One reviewer for all 60** | Uniform rubric interpretation; boundary cases decided the same way throughout | A single systematic misreading propagates to the whole pool with nothing to catch it |
| **One reviewer per stratum** | Parallel; each reviewer becomes fluent in one stratum | Reviewer identity aligns with stratum — the same confound rejected for authoring Option B |
| **Two reviewers per task, disagreement resolved** | Disagreement rate is itself evidence the routing rubric is operational; catches individual misreadings | Doubles review cost; needs a stated resolution procedure |
| **GPT architecture adjudication for structural disputes only** | A defined terminal authority; keeps unresolved disputes from silently defaulting | Must be strictly limited to structural disputes, or it becomes an outcome-aware editing channel |

### Recommendation

```
PROPOSAL ONLY — NOT ACCEPTED

Two independent reviewers per task, with GPT architecture adjudication
reserved for structural disputes the two cannot resolve.
Reviewers must NOT be assigned by stratum.
```

Reasoning: the routing rubric's whole justification is that two reviewers can
usually agree from the task text. Two reviewers make that claim **measurable**
instead of asserted — the inter-reviewer disagreement rate should be reported as
a property of the rubric. Adjudication is bounded to structural disputes because
any wider remit would make the adjudicator an editor with knowledge the authors
were denied.

---

## 7. Invalid task handling

`[OPEN]` This remains open before preregistration. The distinction that matters:

```
pre-freeze structural rejection    caught by review, before any Chief call
post-first-call invalid discovery  found after execution has begun
```

The first is ordinary quality control. The second is dangerous, because by then
the pool's outcomes are partly known.

| Option | For | Against |
|---|---|---|
| **A. Invalid frozen task stays in the denominator** | Maximally conservative; no post-hoc removal is possible, so no outcome-informed exclusion can occur | A genuinely broken task (contradictory, unanswerable) permanently distorts the rate |
| **B. Excluded under a preregistered structural-invalid rule** | Allows removal of genuinely broken items while binding the criteria in advance | The rule must be airtight and outcome-blind; any ambiguity becomes a discretionary exclusion channel |
| **C. Pre-freeze replacement permitted; post-freeze replacement forbidden** | Matches where the risk actually is; unlimited fixing before freeze, none after | Says nothing about what to do with an invalid task discovered *after* the freeze |

### Recommendation

```
PROPOSAL ONLY — NOT ACCEPTED

C as the freeze discipline, combined with A as the post-freeze default,
and B available only under a structural-invalid rule that is written,
outcome-blind, and preregistered before the first planning call.
```

Reasoning: C and A are compatible and address different moments — C governs
authoring, A governs execution. B is worth having only if its criteria are
fixed in advance and can be applied from the task text alone; a rule invented
after seeing which tasks produced inconvenient results is not a rule.

**Absolute:** no outcome-informed replacement, under any option.

---

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

## 9. Ordering / randomization

`[OPEN]` Not chosen here. The concern is that provider behaviour may drift over
a session, so the order in which strata meet the Chief can confound stratum with
time.

| Rule | Temporal / provider drift | Reproducibility | Auditability | Stratum clustering |
|---|---|---|---|---|
| **Deterministic task-id order** | Worst: if ids are grouped by stratum, stratum aligns exactly with time | Perfect | Perfect — no seed to check | Maximal |
| **Seeded random order** | Good on average; a single draw can still cluster | Perfect given a preregistered seed | Good — seed must be committed *before* execution | Possible by chance |
| **Stratum-blocked seeded randomization** | Good: each block contains all six strata, so drift hits strata evenly | Perfect given the seed | Good | Bounded by construction |
| **Round-robin interleaving across strata** | Best against drift; strictly even spacing | Perfect, no seed needed | Best — order is derivable from the manifest | None, but the pattern is rigid and predictable |

### Recommendation

```
PROPOSAL ONLY — NOT ACCEPTED

Stratum-blocked seeded randomization: ten blocks of six, one task per
stratum per block, order within block from a seed committed before execution.
```

Reasoning: it bounds clustering by construction like round-robin, while keeping
within-block order unpredictable, and it stays exactly reproducible from a
committed seed. The seed must be in the frozen commit — a seed chosen after
seeing any result is not a seed.

---

## 10. What this document is not

```
0 tasks authored          0 reviewers assigned       0 sessions run
no option accepted        no seed chosen             no pool frozen
no provider call          no harness
```
