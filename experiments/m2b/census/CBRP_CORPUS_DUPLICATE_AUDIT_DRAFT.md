# CBRP Corpus Duplicate Audit — DRAFT

```
STATUS:  DRAFT ｜ NOT ACCEPTED ｜ NOT PREREGISTERED ｜ NOT AUTHORIZED
AUDITS RUN:  0     CONFIRMED DUPLICATES:  0
```

---

## 1. Why this is a separate stage

The per-task structural review used to carry a `notDuplicate` judgement. It could not
work: that reviewer sees **one** task. Asking whether it duplicates something they were
never shown produces either a guess or a rubber stamp, and either way the field recorded a
judgement nobody was in a position to make.

Duplication is a property of the **corpus**, so it is audited once, over the whole corpus,
by auditors who can actually see it.

```
per-task structural review     one task, six structural questions      →  admits a task
corpus duplicate audit         all sixty texts at once                 →  finds duplicate pairs
```

### 1.1 When it runs

```
after   all 60 provisional tasks have passed per-task structural review
before  the pool freeze
```

Both boundaries matter. Before per-task review there may be tasks that will be replaced
anyway; after the freeze nothing may be replaced at all.

---

## 2. What an auditor receives

**May receive:**

```
the sixty provisional task IDs
the sixty task texts
this rubric
```

**Must NOT receive:**

```
any Chief output ｜ any complexity result ｜ any assigned specialist count
the measured event definition ｜ theta ｜ the P03 outcome
any expected result ｜ any other auditor's findings
```

`[DESIGN]` **Stratum labels are withheld.** They are not needed — duplication is about the
decision underneath, not the category assigned to it — and supplying them would invite an
auditor to look for duplicates *within* categories and skip the cross-category pairs,
which are exactly the ones a per-task reviewer could never have caught.

---

## 3. The rubric

> ### Paste from here.

You are reading sixty decision scenarios written for a research pool. Your only job is to
find **duplicates**.

### 3.1 What counts as a duplicate

Two scenarios are duplicates when they instantiate **substantially the same underlying
decision structure** and differ only in superficial substitution:

```
industry ｜ organisation name ｜ the numbers ｜ the setting ｜ cosmetic wording
```

Ask: *strip the surface detail — is the decision being made the same decision?*

### 3.2 What does NOT count

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

### 3.3 What to return

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

## 4. Decision procedure

Two auditors, **D1** and **D2**, work independently and never see each other's findings.

```
both report the same pair             → CONFIRMED DUPLICATE
neither reports it                    → not a duplicate
exactly one reports it                → that pair alone goes to D3
```

**D3** is a third fresh blinded auditor who receives **only the two texts of that pair**
and this rubric, and is **not told that a disagreement occurred**, nor that the pair was
flagged by anyone. Told there was a split, an adjudicator answers a much easier and quite
different question. Majority of the three decides that pair.

`[DECISION]` **GPT does not adjudicate task-level duplicate disputes**, for the same
reason it does not adjudicate structural ones: it knows the measured event, θ and the P03
history, and a tie-break from that position is an outcome-aware decision about pool
membership.

---

## 5. Which of a confirmed pair is replaced

`[ARCHITECTURE-DECIDED]` No discretionary choice, ever.

```
for a confirmed duplicate PAIR
    retain   the lexicographically smaller provisional candidate ID
    reject   the lexicographically larger

for a confirmed duplicate COMPONENT (three or more linked by confirmed pairs)
    retain   the lexicographically smallest candidate ID in the component
    reject   every other member of that component
```

Provisional candidate IDs are **immutable** and assigned before any audit, so the rule is
fixed before anyone can see which task it will keep. It is outcome-blind and
deterministic: there is no version of "we kept the better one", because "better" is a
judgement made after seeing the texts, and a judgement made then can be made in whichever
direction suits the pool.

Rejected tasks are replaced under the replacement rules in
[`CBRP_AUTHORING_AND_REVIEW_DRAFT.md`](CBRP_AUTHORING_AND_REVIEW_DRAFT.md) §7: a fresh
replacement session in the same author block, targeting only the vacated stratum slot.

### 5.1 Replacements re-enter both gates

A replacement task receives its own R1/R2 structural review, R3 if they disagree, **and
participates in a further corpus duplicate audit round**. A replacement that duplicates
something already in the pool is not admitted merely because it arrived late.

`[OPEN]` Whether a later audit round re-audits the whole corpus or only the replacements
against the corpus. Re-auditing everything is the conservative reading and costs more
auditor sessions; the choice must be fixed before the first audit runs.

---

## 6. Evidence preserved

```
auditRubricSha256              the exact rubric every auditor received
auditorIds                     D1, D2, and D3 per adjudicated pair
per-auditor returned pairs     verbatim, including empty results
confirmed pairs and components
retention decisions            with the lexicographic rule applied, shown
rejected task IDs and their replacements
audit round number             replacements create later rounds
```

All of it is committed with the pool freeze. An audit whose findings are not preserved
cannot be checked, and the retention rule's whole value is that a later reader can
recompute it.

---

## 7. Status

```
audits run 0 ｜ auditors assigned 0 ｜ pairs confirmed 0 ｜ tasks replaced 0
```

No task exists to audit.
