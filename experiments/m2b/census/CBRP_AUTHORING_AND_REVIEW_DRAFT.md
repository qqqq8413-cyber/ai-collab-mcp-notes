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

five authoring QUOTA BLOCKS     AUTHOR-B01 … AUTHOR-B05
each block × each stratum       = 2 final admitted tasks
                                  5 x 6 x 2 = 60
every stratum therefore draws its ten tasks from all five blocks
```

**Blocks and sessions are different things.** The block is the allocation unit and is
fixed at five. The session is where text actually came from:

```
AUTHOR-B01-S00      the initial fresh session for block 1
AUTHOR-B01-R01 …    fresh replacement sessions, if a gate rejects one of its tasks
```

`[DESIGN]` So the correct statement is **"five authoring blocks begin with five fresh
sessions; additional fresh replacement sessions may exist if outcome-blind structural
screening requires them"** — not "five sessions produce the sixty tasks", which is true
only if nothing is ever rejected.

This is the shape that keeps **author identity from being structurally confounded with
stratum**. The estimand is a rate across a stratified frame, so if a stratum's tasks came
from one author, a per-stratum difference and an author difference would be the same
observation and neither could be read. Spreading every session across every stratum makes
authoring style a source of noise instead of a source of structure.

It also bounds the other risk. A single session authoring all sixty would infer a great
deal about what is wanted by task forty, unprompted; twelve is short enough that there is
little arc to infer from.

The cost is five initial sessions instead of one, a small allocation table, and one extra
fresh session per rejection. That is the price of the confound not existing.

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

### 3.1.1 What "fresh" means, and which model may author — DECIDED

```
[ARCHITECTURE-DECIDED]

a fresh session means a FRESH MODEL CONTEXT
it does NOT require a different model for every session

the exact Chief planning model under measurement — openai / gpt-5 —
is FORBIDDEN as an authoring model
```

The prohibition is narrow and specific: it removes **direct task-generator /
measured-system coupling**, where the model writing the scenarios is the same model whose
planning behaviour the scenarios are used to measure.

`[DESIGN]` **It does not eliminate shared-prior bias.** Two different models trained on
overlapping data still share a great deal about what a "realistic business decision" looks
like, and no author-model rule available here removes that. The claim is that one
specific and identifiable coupling has been removed, not that authorship is independent of
the measured system.

Likewise, `[DESIGN]` **fresh contexts reduce conversational contamination; they do not
make model outputs statistically independent.** Any result must be worded accordingly.

### 3.1.2 Author model families

```
[ARCHITECTURE-DECIDED]

the five blocks must use at least TWO distinct non-Chief model families
every block spans all six strata
→ author-model family is therefore not structurally confounded with stratum
```

The exact provider/model per block is **frozen before authoring begins** and recorded in
the pool manifest as `authorBlockModels`. It is provenance. **No author-model
effectiveness claim may be made**, and the census does not estimate one.

#### Family allocation — FROZEN

Per-block provider, exact model and family:
[`CBRP_MODEL_PINS_PREREG_DRAFT.md`](CBRP_MODEL_PINS_PREREG_DRAFT.md) §2, pin version
`CBRP-SESSION-MODEL-PINS-1`. Three CLAUDE blocks, two GEMINI — the strings live there and
nowhere else, so that six documents cannot drift into six different tables.

A block's **replacement** sessions use that block's pinned provider and exact model too. A
block does not change model because one of its tasks was rejected, and **no replacement may
switch model to improve its chance of acceptance** — model identity belongs to the block,
not to whether a predecessor passed.

`[DESIGN]` The 3 : 2 split is forced; five blocks do not divide evenly into two families.
It confounds nothing, because each block × each stratum = 2 admitted tasks, so **every
stratum receives 6 CLAUDE_FAMILY and 4 GEMINI_FAMILY tasks — the same split in all six.**
Family is unbalanced overall and exactly orthogonal to stratum, which is the property a
stratified estimand needs.

`[CLOSED]` The actual provider/model IDs per block were frozen in CWP-8D.

### 3.2 Session identity is provenance only

`AUTHOR-B01 … AUTHOR-B05` say which quota block a task belongs to;
`AUTHOR-B01-S00` / `-R01` … say which session actually wrote it. The authoring provider,
model and declared family may be recorded beside them, but **the census does not estimate
an author-model effect** and no result may be presented as one.

Full record shape:
[`CBRP_SESSION_PROVENANCE_SCHEMA_DRAFT.md`](CBRP_SESSION_PROVENANCE_SCHEMA_DRAFT.md).

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

### 4.2 No diversity quotas — DECIDED

```
[ARCHITECTURE-DECIDED]

NO hard diversity quotas
the brief asks for variation across the nine dimensions
before the freeze, a DESCRIPTIVE diversity report is produced
```

**Diversity is not an admission gate.** A task may not be rejected or replaced because an
aggregate distribution looks unattractive. Only two things cause pre-freeze replacement:

```
structural review failure          or          confirmed semantic duplicate
```

`[DESIGN]` Quotas were rejected because they shape the pool toward whatever the quota
designer imagined a diverse pool contains, and that imagining is not blind to the study.
A descriptive report has the property that matters: it lets a reader see what the pool
actually looks like, without giving anyone a lever to reshape it after the fact.

**No actual tasks are designed here.**

---

## 5. Structural review — the first of two pre-freeze gates

```
per-task structural review     one task, six structural checks
corpus duplicate audit         all sixty texts at once, after all sixty pass review
                               CBRP_CORPUS_DUPLICATE_AUDIT_DRAFT.md
```

`notDuplicate` was removed from the per-task rubric in CWP-8B: a reviewer who sees one
task cannot judge whether it duplicates one they were never shown, and the field recorded
a guess as a check.



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

### 6.2 Which models may review or audit — FROZEN

```
[ARCHITECTURE-DECIDED]

openai / gpt-5 — the Chief planning model under measurement — is FORBIDDEN as
    a structural reviewer          a structural tie-break
    a corpus duplicate auditor     a duplicate tie-break

exactly as it is forbidden as an author (§3.1.1)
```

Exact reviewer and auditor pins, and the deterministic `CBRP-D3-v1` tie-break routing:
[`CBRP_MODEL_PINS_PREREG_DRAFT.md`](CBRP_MODEL_PINS_PREREG_DRAFT.md) §3, §4, §7. Every task
gets one CLAUDE_FAMILY and one GEMINI_FAMILY review; every round gets one of each.

One rule, three applications. **A model under measurement must not control membership in
the pool it will later be measured on** — and admitting tasks one at a time, or ruling on
which of a duplicate pair survives, is controlling membership just as directly as writing
the tasks. The earlier author-only prohibition left the two gates open, which is the larger
lever of the three: a gatekeeper decides what the pool contains without having to write a
line of it.

`[DESIGN]` **This does not eliminate shared priors or model-family bias.** It removes one
identifiable coupling and nothing wider. Two non-Chief models still share a great deal
about what a realistic business decision looks like, and no model-assignment rule available
here changes that. Any result must be worded accordingly.

#### May a reviewer share the author's model family? — YES

`[DECISION]` **Allowed.** Every task receives one CLAUDE_FAMILY judgement and one
GEMINI_FAMILY judgement, and within a family the reviewing model is a **different exact
model** from the authoring one — `claude-opus-5` reviews what `claude-sonnet-5` wrote,
`gemini-3.8-flash` reviews what `gemini-3.7-flash` wrote. **No task is ever admitted by the
exact model that wrote it**, which is the coupling that mattered. (Those four strings are
quoted from `CBRP-SESSION-MODEL-PINS-1` to make the argument readable; on any discrepancy
[`CBRP_MODEL_PINS_PREREG_DRAFT.md`](CBRP_MODEL_PINS_PREREG_DRAFT.md) governs.)

`[DESIGN]` This is emphatically **not reviewer independence**. A same-family reviewer shares
vendor and training priors with the author and the design does not touch them. **No result
may describe the reviewers as independent of shared family priors** — the available claim is
that exact-model self-screening does not occur.

#### R3's model is derived, not chosen

`[ARCHITECTURE-DECIDED]` The third reviewer's model comes from `CBRP-D3-v1`: a SHA-256 over
`"CBRP-D3-v1\nSTRUCTURAL\n" + taskCandidateId`, first hex character `0-7` → the Claude
reviewer, `8-f` → the Gemini reviewer. A fixed third reviewer would hand one family a
systematic extra vote on every disagreement; hashing removes the discretion without reading
the task, the author family, or either earlier answer. It does **not** guarantee a 50/50
realized split, and no result may claim one.

## 7. Invalid task handling — DECIDED

`[ARCHITECTURE-DECIDED]` Three moments, three different rules, because the risk is
entirely a function of when the problem is found.

### 7.1 Pre-freeze — replacement permitted

Before the pool is frozen and before any Chief output exists, a task rejected by **either**
outcome-blind gate — per-task structural review, or the corpus duplicate audit — is
discarded and replaced. The replacement:

```
is generated in a NEW fresh context
uses the same frozen authoring brief
uses the same predeclared model family as that author BLOCK
targets only the vacant stratum slot
receives normal R1 / R2 structural review, and R3 if they disagree
enters the NEXT corpus duplicate audit round, if it passes structural review
```

#### 7.1.1 Vacancies are filled as a batch, and the batch closes before the next audit

`[ARCHITECTURE-DECIDED]` Replacements are not generated one at a time.

```
1  a duplicate audit round completes and all its rejections are known
2  ALL vacancies are determined FIRST, as one batch
3  the whole batch is authored — one new fresh replacement session per vacated slot
4  every replacement receives R1 / R2, and R3 on disagreement
5  a replacement that FAILS structural review is itself replaced and re-reviewed,
   until every vacated slot holds a structurally-passing task
6  only then does the next duplicate audit round begin
```

`[DESIGN]` Step 5 is a **closure requirement**. The duplicate auditors are given the sixty
current texts, and there are sixty only when every vacancy is filled. So structural review
of a replacement batch runs to completion — including replacing the replacements that fail
it — before the next duplicate round can start. A replacement rejected at structural review
never reaches a duplicate auditor.

Batching also keeps the round count honest: filling vacancies one at a time would put each
new task in a round of its own and multiply rounds without changing what gets screened.

#### 7.1.2 Later duplicate rounds are incremental

`[ARCHITECTURE-DECIDED]` Round 0 audits all 1770 pairs of the initial sixty. Every later
round audits **only pairs with at least one endpoint among that round's replacements**;
pairs of two incumbents are never re-audited. Incumbents are never displaced by a later
replacement.

Full rule, the invariant that justifies it, and the retention procedure:
[`CBRP_CORPUS_DUPLICATE_AUDIT_DRAFT.md`](CBRP_CORPUS_DUPLICATE_AUDIT_DRAFT.md) §2 and §7.

Recorded provenance, truthfully:

```
authorBlockId          AUTHOR-B01 … B05
actualAuthorSessionId  AUTHOR-B01-R01, etc. — never the original -S00
replacementOf          the rejected task's id
replacementGeneration  1, 2, … for successive replacements of the same slot
rejectedPredecessorBy  STRUCTURAL_REVIEW | CORPUS_DUPLICATE
```

`replacementGeneration` increments on every replacement of a slot whichever gate rejected
the predecessor; `rejectedPredecessorBy` records which one it was. The two gates leave
different downstream evidence — a structurally rejected task never reached an auditor — so
they must stay distinguishable in the record.

`[DECISION]` **A replacement session is never recorded as the original session.** The
pool's provenance has to describe how the pool was actually produced, or it is decoration.

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

### 9.3 Seed and permutation — FROZEN as CBRP-ORDER-v1

```
[ARCHITECTURE-DECIDED]

seed            = SHA256( POOL_FREEZE_COMMIT + "\n" + "CBRP-ORDER-v1" )
taskOrderKey    = SHA256( seed + "\nTASK\n"  + taskId + "\n" + taskSha256 )
roundStratumKey = SHA256( seed + "\nROUND\n" + decimal(r) + "\n" + stratumCode )

sorts are ascending lowercase hexadecimal lexical order
no PRNG anywhere
```

Full specification, including stratum codes and emission:
[`CBRP_POOL_MANIFEST_SCHEMA_DRAFT.md`](CBRP_POOL_MANIFEST_SCHEMA_DRAFT.md) §4.

`[DESIGN]` **Seed shopping is structurally impossible, not merely forbidden.** The seed is
a pure function of a commit that already exists when it is computed, so there is exactly
one value and nothing to try. The literal `CBRP-ORDER-v1` is preregistered so the
derivation cannot be quietly re-run with a different separator.

## 10. What this document is not

```
0 tasks authored          0 reviews run              0 duplicate audits run
0 authoring sessions run  0 pools frozen             0 seeds derived
0 provider calls
```

Procedure is now decided; **content does not exist**. The study is a
**PREREGISTRATION CANDIDATE**, not preregistered: no task pool exists, no review has run,
no freeze has occurred, and no ordering seed has been materialized.

`[DESIGN]` The author and reviewer procedures **reduce outcome-targeted selection bias.
They do not eliminate it.** CBRP remains a balanced synthetic reference frame, and no
result from it may be upgraded to production-wide, real-user prevalence, or a natural
production distribution.
