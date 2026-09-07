# CBRP Corpus Duplicate Audit — DRAFT

```
STATUS:  DRAFT ｜ NOT ACCEPTED ｜ NOT PREREGISTERED ｜ NOT AUTHORIZED
AUDIT ROUNDS RUN:  0     AUDITORS ASSIGNED:  0     CONFIRMED DUPLICATES:  0
```

---

## 1. Why this is a separate stage

The per-task structural review used to carry a `notDuplicate` judgement. It could not
work: that reviewer sees **one** task. Asking whether it duplicates something they were
never shown produces either a guess or a rubber stamp, and either way the field recorded a
judgement nobody was in a position to make.

Duplication is a property of the **corpus**, so it is audited over the corpus, by auditors
who can actually see it.

```
per-task structural review     one task, six structural questions      →  admits a task
corpus duplicate audit         sixty texts at once                     →  finds duplicate pairs
```

### 1.1 When it runs

```
after   all 60 provisional tasks have passed per-task structural review
before  the pool freeze
```

Both boundaries matter. Before per-task review there may be tasks that will be replaced
anyway; after the freeze nothing may be replaced at all.

---

## 2. Rounds — DECIDED

`[ARCHITECTURE-DECIDED]` The audit is not one event. Rejections create vacancies,
vacancies are filled by replacements, and the replacements need screening too.

```
DUP-R00     ROUND 0        FULL         all unordered pairs of the initial 60
DUP-R01     ROUND 1        INCREMENTAL  only pairs touching that round's replacements
DUP-R02 …   ROUND 2, 3, …  INCREMENTAL  same rule, until the pool closes
```

### 2.1 Round 0 — full

Input: all 60 provisional tasks that passed per-task structural review.
Scope: **every unordered pair** — 1770 of them.

### 2.2 Round j ≥ 1 — incremental

```
focusSet_j    every newly admitted structural-pass replacement generated for round j
incumbents_j  the tasks already in the corpus when round j begins

in scope      every unordered pair with AT LEAST ONE endpoint in focusSet_j
out of scope  every pair whose BOTH endpoints are incumbents
```

`[ARCHITECTURE-DECIDED]` **Old–old pairs are never re-audited.** Not "should not" —
re-auditing them is forbidden.

### 2.3 The invariant this maintains

**After any completed round, every unordered pair in the current corpus has been screened
by exactly one completed duplicate-audit round.**

```
round 0        screens every pair of the initial 60                        → base case
round j        incumbents enter with all their mutual pairs screened
               round j screens every incumbent×replacement pair
               round j screens every replacement×replacement pair
               survivors therefore leave round j fully screened            → induction
```

`[DESIGN]` **Exactly one, not at least one.** A pair is screened in the round where one of
its endpoints first appears, and never again — a later round's focusSet contains only
tasks that did not exist before, so no surviving pair can re-enter scope.

### 2.4 Why incremental, and what it costs

Re-running old–old pairs on every replacement would give a task a number of screening
opportunities determined by **how many replacements the process happened to need**. A task
that survived a corpus where nothing was replaced would have been screened once; the same
task in a corpus that needed four replacement rounds would have been screened five times,
by five different auditor pairs, with five chances for one of them to call it a duplicate.
Pool membership would then depend on process luck rather than on the task.

The incremental rule screens exactly the duplicate edges the new tasks introduce, and
gives every pair the same single screening.

`[DESIGN]` **The cost is real and is accepted: a round-0 false negative is permanent.** A
duplicate pair the round-0 auditors both missed is never looked at again, because the pair
never re-enters scope. The design trades that against variable screening intensity, on the
grounds that a fixed one-screening-per-pair rule is preregisterable and a
luck-determined number of screenings is not.

`[DESIGN]` The fairness unit is the **pair**, not the task. An incumbent does participate
in more *rounds* than a late replacement. It does not get any of its pairs judged twice,
and the rubric's judgement is a pair-level judgement.

### 2.5 Precondition on sequencing

`[ARCHITECTURE-DECIDED]` **A round may not begin until the previous round is complete** —
every disputed pair adjudicated, every retention decision applied, every vacancy filled by
a structurally-passing task.

This is what makes §2.3 hold unconditionally rather than conditionally. The incumbent rule
in §7 keeps incumbents because their mutual pairs are already cleared; if a round could
start on top of an unfinished one, that would stop being true and the rule would have no
defined behaviour.

---

## 3. Round sequencing and replacement batches

```
1  round j audit runs over its scope
2  disputed pairs adjudicated                                    → confirmed pair set
3  retention rule applied                                        → rejections
4  ALL vacancies determined FIRST, as one batch
5  the whole batch is authored: same author block, same predeclared model family,
   a NEW fresh replacement session per task, targeting only the vacated stratum slot
6  every replacement receives normal R1 / R2 structural review, R3 on disagreement
7  a replacement that FAILS structural review is itself replaced and re-reviewed,
   until every vacated slot holds a structurally-passing task
8  the structurally-passing tasks of that batch become focusSet_(j+1)
9  round j+1 runs
```

`[DESIGN]` **Step 7 is a closure requirement, not a detail.** §4 gives every auditor all
sixty texts; there are only sixty texts to give once every vacancy is filled. Structural
review of a replacement batch must therefore run to completion — including replacing the
replacements that fail it — *before* the next duplicate round can begin. A replacement
rejected by structural review never reaches a duplicate auditor.

`[DESIGN]` Vacancies are batched (step 4) rather than filled one at a time so that a batch
of replacements is screened against each other in a single round. Filling them
sequentially would put each new task in its own round and multiply the rounds without
changing what gets screened.

---

## 4. What an auditor receives

**Receives:**

```
the sixty current task IDs
the sixty current task texts
auditScopeIds        the ID list defining which pairs are in scope
this rubric          byte-identical in every round
```

**Must NOT receive:**

```
that auditScopeIds are replacements ｜ why those IDs are scoped
any earlier round's findings ｜ any earlier round's outcomes
any other auditor's findings ｜ any expected result
any Chief output ｜ any complexity result ｜ any assigned specialist count
the measured event definition ｜ theta ｜ the P03 outcome
```

`[DESIGN]` **Stratum labels are withheld.** They are not needed — duplication is about the
decision underneath, not the category assigned to it — and supplying them would invite an
auditor to look for duplicates *within* categories and skip the cross-category pairs,
which are exactly the ones a per-task reviewer could never have caught.

### 4.1 One rubric, scope supplied as data

`[DECISION]` The scope is a **data field**, never a change to the rubric text.

```
round 0        auditScopeIds = all sixty IDs        → the scope clause is vacuous
round j >= 1   auditScopeIds = focusSet_j           → the scope clause binds
```

So `duplicateAuditRubricSha256` is **the same hash in every round**, and the pool
manifest's requirement that one rubric hash covers the whole study survives an arbitrary
number of incremental rounds. A rubric edited per round would be a different instrument
each time, and "the auditors all used the same rubric" would stop being checkable.

### 4.2 What an auditor can infer, and cannot be prevented from inferring

`[DESIGN]` An auditor given a scope list can reasonably guess those IDs are somehow
special. That cannot be removed — the scoped question needs the scope. What is withheld is
everything that would make the guess useful: not that they are replacements, not what
replaced what, not any earlier finding, and nothing about the measured event. The residual
is named rather than denied.

---

## 5. The rubric

> ### Paste from here.

You are reading sixty decision scenarios written for a research pool. Your only job is to
find **duplicates**.

### 5.1 What counts as a duplicate

Two scenarios are duplicates when they instantiate **substantially the same underlying
decision structure** and differ only in superficial substitution:

```
industry ｜ organisation name ｜ the numbers ｜ the setting ｜ cosmetic wording
```

Ask: *strip the surface detail — is the decision being made the same decision?*

### 5.2 What does NOT count

**Similarity is not duplication.** Two scenarios may freely share any of:

```
the same industry
the same kind of decision
the same format or length
the same style of request
```

and not be duplicates. A pool of sixty realistic decisions will contain many resemblances;
that is what a realistic pool looks like. Only report a pair when the decision itself is
the same decision wearing different clothes.

### 5.3 Scope

You are given a list, `auditScopeIds`. **Report a pair only if at least one of its two
scenarios is in that list.** Pairs where neither is in the list are outside your task; do
not report them, and do not comment on them.

### 5.4 What to return

Candidate duplicate **pairs**, and nothing else. Do not rank the scenarios, do not judge
their quality, do not suggest replacements, and do not comment on the pool as a whole.

If you find no duplicates, return an empty list. That is a normal outcome.

```json
{
  "auditorId": "…",
  "duplicatePairs": [
    { "a": "…", "b": "…", "reason": "One or two sentences: the shared decision structure, and what differs only superficially." }
  ]
}
```

> ### Paste to here.

---

## 6. Decision procedure

Two auditors, **D1** and **D2**, work independently and never see each other's findings.

```
both report the same pair             → CONFIRMED DUPLICATE
neither reports it                    → not a duplicate
exactly one reports it                → that pair alone goes to D3
```

**D3** is a third fresh blinded auditor who receives **only the two texts of that pair**
and this rubric, and is **not told that a disagreement occurred**, nor that the pair was
flagged by anyone, nor which auditor flagged it. Told there was a split, an adjudicator
answers a much easier and quite different question. Majority of the three decides that
pair.

`[DECISION]` **GPT does not adjudicate task-level duplicate disputes**, for the same
reason it does not adjudicate structural ones: it knows the measured event, θ and the P03
history, and a tie-break from that position is an outcome-aware decision about pool
membership.

### 6.1 Fresh auditor sessions, per round

`[ARCHITECTURE-DECIDED]` **Every round uses new fresh auditor contexts.** An auditor
context is never carried from one duplicate round to the next.

```
DUP-R00-D1   DUP-R00-D2
DUP-R01-D1   DUP-R01-D2
DUP-R02-D1   DUP-R02-D2
…
```

A reused context would arrive at round j already knowing what it found in round j−1 and
which of its findings were acted on — which is an earlier round's outcome, and §4 forbids
supplying that.

**D3 IDs** identify the round and the disputed pair, and encode no outcome:

```
DUP-R00-D3-<idA>__<idB>        idA and idB in ascending lexicographic order
```

`[DESIGN]` The two task IDs are ordered **lexicographically, never by who flagged the
pair**. Ordering by flagger would put "which auditor dissented" into the identifier, and
the identifier is preserved in the evidence a later reader sees. The ID says which pair was
adjudicated. It does not say what was decided.

---

## 7. Retention — which member of a confirmed group is kept

`[ARCHITECTURE-DECIDED]` No discretionary choice, ever. One rule covers every round.

Build the graph whose edges are the round's **confirmed** duplicate pairs. For each
connected component `C`:

```
I = C ∩ incumbents        (empty in round 0, by construction)
R = C ∩ focusSet

if I is non-empty     KEEP  every member of I
                      REJECT every member of R

if I is empty         KEEP  the lexicographically smallest candidate ID in R
                      REJECT every other member of R
```

Round 0 has no incumbents, so `I` is always empty and the rule reduces to
*keep the lexicographically smallest candidate ID in the component*. That is the round-0
rule as originally written; it is not a second rule.

The stated cases follow:

```
replacement ↔ incumbent            I={i}      → keep incumbent, reject replacement
replacement ↔ replacement          I=∅        → keep the smaller candidate ID
replacement ↔ several incumbents   I={i1,i2}  → keep both incumbents, reject replacement
round-0 pair                       I=∅        → keep the smaller
round-0 component of three         I=∅        → keep the smallest, reject the rest
```

`[DECISION]` **No incumbent is ever displaced by a later replacement.**

### 7.1 Why incumbency wins, rather than lexicographic order

Because the alternative is an outcome-shaped lever. If a later replacement could evict an
incumbent by duplicating it with a smaller ID, then the pool's membership would be
alterable by *generating more replacements* — and the process controls how many
replacements it generates. Incumbency priority removes that lever entirely: once a task has
survived a completed round, nothing later in the process can remove it.

It also terminates better. Displacing an incumbent vacates a slot that was already filled,
so every displacement adds a round without reducing the number of open slots.

Both properties are outcome-blind: incumbency is fixed by arrival, arrival is fixed before
the audit runs, and no Chief output exists at any point in this stage.

### 7.2 Components are transitive for rejection, never for incumbent removal

`[DESIGN]` A named asymmetry, deliberate:

```
rejection    transitive — a component member is rejected on a path, not only a direct edge
incumbents   never removed on a path, and never removed at all
```

So a component `{r1, r2, i}` with confirmed edges `r1~r2` and `r2~i` rejects **both**
replacements, including `r1`, which was never confirmed against the incumbent. That is the
conservative direction and it costs only a replacement.

The opposite inference is forbidden: from `i1~r` and `r~i2` it does **not** follow that
`i1~i2`. **Duplicate status is pair-specific.** Two incumbents are duplicates only if a
completed round confirmed that pair directly, and no such confirmation can exist, because
incumbent–incumbent pairs are cleared before they become incumbents.

A component consisting only of incumbents cannot occur: every confirmed edge in an
incremental round has at least one endpoint in `focusSet`.

---

## 8. Termination

```
continue rounds until   exactly 60 tasks
                    AND no confirmed in-scope duplicate produced a vacancy
```

`[ARCHITECTURE-DECIDED]` **No maximum number of replacement rounds is set**, and none may
be invented later. A cap would have to be enforced by admitting a known duplicate or by
relaxing the rubric, and both are worse than stopping.

```
if a valid replacement cannot be obtained    STOP
                                             return to GPT Architecture Review
```

`[DECISION]` **The rubric may not be weakened to make the process terminate.** A rubric
relaxed until the pool fills is a rubric chosen by the difficulty of filling the pool, and
its threshold would then be a property of the process rather than a preregistered
standard.

`[DESIGN]` Termination is therefore **not guaranteed by the rule**. It is guaranteed by
the STOP. That is the honest statement: the procedure either closes on a clean pool or
returns to architecture, and it has no third outcome in which a compromised pool is
frozen.

---

## 9. Evidence preserved, per round

```
roundId                        DUP-R00, DUP-R01, …
auditScopeIds                  the exact ID list supplied
corpusTaskIds + taskSha256     the corpus as it stood when the round ran
duplicateRubricSha256          identical in every round
auditorSessionIds              D1, D2, and each D3
D1 returned pairs              verbatim, including an empty list
D2 returned pairs              verbatim, including an empty list
each D3 returned result        verbatim, per adjudicated pair
confirmedPairs                 after majority
components                     and the I / R split applied to each
retained ｜ rejected            with the rule shown, not just the outcome
vacanciesCreated               and which batch filled them
```

An empty result is evidence and is stored as one. A round that found nothing is not a
round that did not run.

The final pool manifest **references every round**, not only the last. A pool whose
manifest listed only the round that happened to find nothing would be describing a
different procedure from the one that produced it.

---

## 10. Status

```
audit rounds run 0 ｜ auditors assigned 0 ｜ pairs confirmed 0 ｜ tasks replaced 0
```

No task exists to audit. Auditor provider/model IDs are `[OPEN]` — see
[`CBRP_SESSION_PROVENANCE_SCHEMA_DRAFT.md`](CBRP_SESSION_PROVENANCE_SCHEMA_DRAFT.md) §4
for the policy that constrains them and
[`CBRP_AUTHORING_AND_REVIEW_DRAFT.md`](CBRP_AUTHORING_AND_REVIEW_DRAFT.md) §6.2 for why
the Chief model is excluded.
