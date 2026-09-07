# CBRP Structural Review Rubric — FROZEN CONTENT / EXECUTION NOT RUN

```
METHODOLOGY:   FROZEN / ACCEPTED FOR STRUCTURAL REVIEW PROTOCOL 1  (CWP-10G)
EXECUTION:     NOT RUN
LIVE:          NOT AUTHORIZED
REVIEWS RUN SO FAR:  0
RUBRIC VERSION:  CBRP-STRUCTURAL-REVIEW-RUBRIC-1  (byte count 4694, sha256 2028b998…)
                 — see CBRP_STRUCTURAL_REVIEW_PROTOCOL_1.md §3
```

> The frozen rubric every structural reviewer uses. Like the authoring brief, everything
> below §2 is written to be pasted into a fresh blinded session with no supplement. Its
> exact paste-bytes, the model-visible bytes built around it, blind task identity,
> response grammar, schema, and the R1/R2/R3 admission procedure are frozen in
> [`CBRP_STRUCTURAL_REVIEW_PROTOCOL_1.md`](CBRP_STRUCTURAL_REVIEW_PROTOCOL_1.md) — this
> document freezes the rubric's own content and judgement criteria; that one freezes the
> execution path around it.

---

## 1. Notes for the operator (NOT pasted)

Every task gets **two independent blinded reviews**, `<taskId>-R1` and `<taskId>-R2`,
produced in separate sessions. Neither reviewer sees the other's answer, or that a second
review exists. On disagreement a **third** blinded reviewer, `<taskId>-R3`, receives the
task, its assigned stratum and this same rubric — and **not** the earlier answers, nor the
fact that there was a disagreement. Majority of the three decides.

`[DECISION]` **GPT does not adjudicate individual task-level disagreements.** GPT knows
the measured event, θ, and the whole P03 history; a tie-break from that position is an
outcome-aware decision about pool membership, however carefully made. GPT audits the
*procedure* and the aggregate afterwards. The tie-break is a third blinded reviewer.

`[DESIGN]` Duplication was removed from this rubric in CWP-8B. A per-task reviewer sees
one task, so a `notDuplicate` field asked for a judgement nobody was positioned to make
and would have recorded a guess as a check. Corpus duplication is audited separately, over
all sixty texts at once: see
[`CBRP_CORPUS_DUPLICATE_AUDIT_DRAFT.md`](CBRP_CORPUS_DUPLICATE_AUDIT_DRAFT.md).

`[DESIGN]` The inter-reviewer disagreement rate should be reported as a property of the
routing rubric. The rubric's central claim is that two readers can usually agree from the
task text; two reviewers make that measurable instead of asserted.

**The reviewer must never be asked how the task is likely to be planned.** A reviewer who
scored likely complexity, likely specialist count, or likely roles would reintroduce the
measured event at the gate that decides pool membership — with more authority than the
author had, because review output is what admits a task.

---

## 2. The rubric

> ### Paste from here.

You are checking whether a decision scenario is structurally sound for a research task
pool. You are **not** judging how good it is, how hard it is, or how anyone would answer
it.

You receive one scenario and the category it was assigned. Judge only what is below.

### 2.1 The six categories

A scenario's category is decided by **its primary requested output** — the thing the asker
wants back — not by every subject that appears in the text.

**Operational test.** Read only the final request. Ask: *what would a complete answer hand
back?* That artifact's kind selects the category.

```
1. Strategy / Commitment       a choice among mutually exclusive directions,
                               or a commitment costly to reverse
2. Operations / Execution      how to execute a settled direction: sequencing,
                               capacity, staffing, timelines, rollout
3. Brand / Creative            identity, positioning, naming, voice, creative direction
4. Evidence Interpretation     what supplied data or conflicting findings mean
5. Product / Service Design    what the offering should be: scope, tiers, service model
6. Finance / Resource Allocation  how to divide a finite resource among claimants,
                               or a judgement about financial structure
```

Boundary cases:

```
direction already settled, asking how to carry it out      → Operations
evidence supplied, but asking which option to pick         → Strategy
budget merely constrains a design or plan                  → that design or plan
final question is how to split a fixed pot                 → Finance
```

### 2.2 What you must judge

**stratumCorrect** — Does the assigned category match the primary requested output?

**primaryOutputClear** — Is there exactly one final request, and is it clear what a
complete answer would hand back? A scenario asking three unrelated things at once fails.

**selfContained** — Can it be answered from its own text? It fails if it needs an external
lookup, refers to a document that is not included, or omits a figure its request depends
on.

**realistic** — Does it read as something a real person would actually send? It fails if
it is a puzzle, a riddle, a test case, or a situation no one would be in.

**noExperimentLeakage** — Does the text avoid all of: AI provider, model, assistant or
agent names; research, experiments, evaluation or eligibility; category names used as
labels; meta-commentary addressed to anyone but the advisor?

**noSpecialistSteering** — Does the text avoid instructing **how the answer should be
produced, or by whom**?

It **fails** when the text tells the advisor to answer using several experts, perspectives,
roles, agents or kinds of expertise — *"consult several specialists first"*, *"give me
finance, operations and brand perspectives"*, *"have a panel debate this"*, *"this needs
multiple kinds of expertise"*.

It **passes** when words like *specialist*, *expert*, *consultant*, *panel* or *committee*
merely describe the situation — a hospital's rotas, a role being hired, a witness who filed
a report, a committee that meets fortnightly. Real organisations contain these people, and
saying so is describing the world.

`[DECISION]` **A word is not a violation.** Judge what the text asks the advisor to *do*,
never which nouns it contains. Delete the sentence and ask what was lost: if the situation
lost a fact, it belongs; if only the instructions to the advisor changed, it is steering.
An earlier version of this rubric failed a scenario for the word alone, and that is the
defect this wording exists to remove.

**overallPass** — PASS only if every judgement above passes.

*(Duplication is deliberately not among these. You see one scenario; whether it duplicates
another is a property of the whole corpus and is decided in a separate audit by auditors
who can see all sixty. Do not speculate about it.)*

### 2.3 What you must NOT judge

Do not assess, score, estimate or mention any of:

```
how complex the scenario is        how hard it would be to answer
how many people or perspectives an answer would need
which kinds of expertise it calls for
what the answer would say          whether experts would disagree
```

If you find yourself reasoning about the answer, you have left the rubric.

### 2.4 Output format

Return exactly this, and nothing else:

```json
{
  "taskId": "…",
  "stratumCorrect": true,
  "primaryOutputClear": true,
  "selfContained": true,
  "realistic": true,
  "noExperimentLeakage": true,
  "noSpecialistSteering": true,
  "overallPass": true,
  "reasons": "One or two sentences. On any false, say which check failed and why."
}
```

> ### Paste to here.

---

## 3. What reviewers receive, exactly (NOT pasted)

**May receive:**

```
the task text ｜ its assigned stratum ｜ this rubric
```

**Must NOT receive:**

```
any Chief output ｜ any complexity result ｜ any assigned specialist count
the measured event definition ｜ theta ｜ the P03 outcome
any expected result ｜ any other reviewer's judgement
the fact that a disagreement occurred (third reviewer)
```

---

## 4. Decision procedure

```
R1 PASS and R2 PASS        → task structurally passes
R1 FAIL and R2 FAIL        → task rejected pre-freeze
R1 and R2 disagree         → R3, fresh and blinded; majority of three is final
```

A rejected task is discarded before the freeze and replaced from a **fresh replacement
session in the same author block**, using the same frozen brief and the same predeclared
model family — a session as blind as any initial one, producing the same 12-scenario
output. The operator, not the author, then deterministically admits only the first
response-order candidate declaring the vacated stratum
(`CBRP-REPLACEMENT-SELECTION-v1`, `CBRP_REPLACEMENT_PROTOCOL_1.md`). **A rejected task may
never re-enter the pool**, and its rejection lineage is preserved in the freeze manifest.

Structural review is one of **two** pre-freeze gates. The other is the corpus duplicate
audit, which runs after all sixty have passed here.

**No review has been run.** 60 `CBRP-AUTHORING-V2P1-ROUND-0` (Protocol-2.1) provisional
candidates exist (CWP-10E), but none has been structurally reviewed — the execution path
that would review them is frozen (`CBRP_STRUCTURAL_REVIEW_PROTOCOL_1.md`, CWP-10G) but not
yet LIVE-authorized.
