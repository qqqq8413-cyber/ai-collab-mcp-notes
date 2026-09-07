# CBRP Authoring Brief v2 — DRAFT

```
PROTOCOL:      CBRP-AUTHORING-PROTOCOL-2
BRIEF VERSION: CBRP-AUTHORING-BRIEF-2
STATUS:        DRAFT ｜ METHODOLOGY FROZEN ｜ NOT EXECUTED ｜ NOT AUTHORIZED

TASKS AUTHORED UNDER THIS BRIEF:  0        RUNS:  0
```

> **This document is the complete brief.** Everything below §1 is written to be pasted
> into a fresh authoring session with no supplementary explanation. If a session needs
> something that is not here, the brief is wrong and must be fixed *before* authoring
> starts — not patched mid-session, which would give later sessions a different brief.
>
> **All examples in this brief are `ILLUSTRATIVE ONLY — NOT ELIGIBLE FOR CBRP`.** They
> exist to show shape and are permanently barred from the pool: an example an author has
> already read cannot also be an independent sample.

> ## What changed from v1, and what did not
>
> `CBRP-AUTHORING-PROTOCOL-1` ran once and was adjudicated a **failed acquisition** —
> `FORBIDDEN_LITERAL_STOP`, because §2.7 banned the literal word *specialist* and two of
> sixty scenarios used it to describe a hospital rota and a hiring line. See
> [`authoring-round-0/AUTHORING_V1_ARCHITECTURE_VERDICT.json`](authoring-round-0/AUTHORING_V1_ARCHITECTURE_VERDICT.json).
>
> **Exactly one rule changed: §2.7.** Every other section — the six categories, the realism
> rules, self-containment, length, variation, non-repetition, the output format, and all six
> worked category examples — is byte-identical to v1. The amendment is a single correction,
> not a rewrite, so nothing else is confounded with it.
>
> `[DESIGN]` v1's §2.5 already stated the rule **semantically** ("do not try to make
> scenarios that need several kinds of expertise"). §2.7 then restated it **lexically**, as
> a word ban, and the two were not the same rule. v2 removes the lexical restatement and
> keeps the semantic one. **This is prospective.** v1 stands as written and stands as
> failed; no v1 candidate is rehabilitated by it.

---

## 1. Notes for the operator (NOT pasted into the authoring session)

Run id **`CBRP-AUTHORING-V2-ROUND-0`**. Five authoring **quota blocks**,
`AUTHOR2-B01` … `AUTHOR2-B05`, each beginning with one fresh session
(`AUTHOR2-B01-S00` …) that authors **12 tasks: two per stratum**. Provisional candidate
ids are namespaced `V2-B01-S00-SC-01` and never collide with v1's.
Five blocks × 2 × 6 strata = 60, and every stratum receives its ten tasks from all five
blocks. That is the point of the shape: if a stratum's tasks came from one author, a
per-stratum difference and an author difference would be the same thing, and the study's
estimand is a rate across a stratified frame.

**Blocks are fixed at five; sessions are not.** Each rejection adds a fresh replacement
session (`AUTHOR2-B01-R01` …) in the same block, using this same brief and that block's
predeclared model family. A replacement is never recorded as the original session.

Each session receives **this brief verbatim and nothing else**. In particular it must not
receive: prior CBRP conversation history, any Chief planning output, any previously
authored task text, the P03 outcome, F1/F2, the measured event, θ, a desired specialist
count, a desired complexity, the provider/model role map, or anything about peer-challenge
arms.

`[ARCHITECTURE-DECIDED]` **No v1 output may reach a v2 session.** The sixty v1 candidates
are barred as seed, inspiration or example material, and the examples in this brief were
written so that none of them reproduces v1 candidate text.

Session identity is provenance only. The provider and model are frozen per block before
authoring begins and recorded, but **the census does not estimate an author-model effect**
and no result may be read as one.

The Chief planning model under measurement — `openai / gpt-5` — is **forbidden** as an
authoring model, to remove direct task-generator / measured-system coupling. At least two
distinct non-Chief model families are used across the five blocks, and since every block
spans all six strata, author-model family is not confounded with stratum.

`[DESIGN]` A fresh session means a **fresh model context**, not necessarily a different
model. Fresh contexts reduce conversational contamination; they do **not** make outputs
statistically independent, and the model rule does not eliminate shared-prior bias.

`[DESIGN]` This procedure **reduces** outcome-targeted selection bias. It does not
eliminate it. A fluent author writing "a realistic decision" may still produce cases that
lean one way for reasons no brief can remove.

---

## 2. The brief

> ### Paste from here.

You are writing realistic decision scenarios for a research task pool.

Write **12 scenarios**: exactly **two** in each of the six categories below.

Each scenario is a self-contained piece of text that a real person might send to an
advisor, ending in a clear request. Nothing else — no notes to us, no explanations of
your choices, no commentary about how the scenario should be answered.

### 2.1 The six categories

A scenario's category is decided by **its primary requested output** — the thing the
asker wants back — **not** by every subject that appears in the text. Real decisions
touch several domains; the category is the kind of answer being asked for.

**Operational test.** Read only your final request. Ask: *what would a complete answer
hand back?* That artifact's kind selects the category.

---

**1. Strategy / Commitment** — the requested output is a **choice among mutually
exclusive directions**, or a commitment that is costly to reverse.

*Not this category if:* the direction is already settled and you are asking how to carry
it out (that is Operations), or you are asking how to split a fixed pot (that is Finance).

`ILLUSTRATIVE ONLY — NOT ELIGIBLE FOR CBRP:` *A regional clinic group has been offered
acquisition by a national chain and separately has a bank term sheet to expand
independently. Both offers lapse in six weeks. Which should they take?*

---

**2. Operations / Execution** — the direction is settled; the requested output is **how
to execute**: sequencing, capacity, staffing, timelines, throughput, rollout.

*Not this category if:* you are asking whether to do it at all (Strategy), or what the
offering itself should be (Product / Service Design).

`ILLUSTRATIVE ONLY — NOT ELIGIBLE FOR CBRP:` *A bakery has committed to supplying three
new supermarket depots from one production site. Given the oven capacity and delivery
windows below, how should they phase the rollout?*

---

**3. Brand / Creative** — the requested output is a **judgement about identity,
positioning, naming, voice or creative direction**; its quality is judged by resonance and
coherence rather than by arithmetic.

*Not this category if:* you are asking which market to pursue (Strategy), or what the
product should do (Product / Service Design).

`ILLUSTRATIVE ONLY — NOT ELIGIBLE FOR CBRP:` *A 40-year-old tool manufacturer is losing
younger trade customers who find its brand dated, while older customers cite exactly that
heritage as why they buy. How should the brand present itself now?*

---

**4. Evidence Interpretation** — you supply data, findings or conflicting reports, and the
requested output is **what it means**: a reading, a diagnosis, a judgement about whether
the evidence is sufficient.

*Not this category if:* you supply evidence but ask which option to pick (Strategy), or
which budget line to fund (Finance).

`ILLUSTRATIVE ONLY — NOT ELIGIBLE FOR CBRP:` *A language school's retention rose 8% after
a curriculum change, but the same term it also cut class sizes and raised prices. The
cohort table is below. What does the retention change actually show?*

---

**5. Product / Service Design** — the requested output is **what the offering should be**:
scope, feature set, tiers, service model, customer-facing mechanics.

*Not this category if:* you are asking how to build or ship it (Operations), or what it
should be called or stand for (Brand / Creative).

`ILLUSTRATIVE ONLY — NOT ELIGIBLE FOR CBRP:` *A veterinary practice wants to offer a
subscription for routine care. What should be included, and how should it be structured?*

---

**6. Finance / Resource Allocation** — the requested output is **how to divide a finite
resource** — money, headcount, capacity — among competing claimants, or a judgement about
financial structure.

*Not this category if:* a budget merely constrains a design or a plan; then the category is
that of the design or plan.

`ILLUSTRATIVE ONLY — NOT ELIGIBLE FOR CBRP:` *A museum has one capital grant and three
claims on it: roof repair, a new gallery, and digitising the archive. How should the grant
be divided?*

---

**When two subjects appear**, route by the final requested output:

```
a product-expansion scenario whose final question is how to split a fixed budget
    → Finance / Resource Allocation

a financially constrained scenario whose final deliverable is a service design
    → Product / Service Design
```

### 2.2 What makes a scenario realistic

- a concrete situation with someone who has a reason to decide **now**
- a genuine tension — the obvious answer costs something
- enough supplied fact to answer without looking anything up
- **one** clear final request, whose deliverable decides the category
- written as the asker would write it, not as a puzzle

### 2.3 Self-contained

The scenario must be answerable **from its own text**. No live lookup, no reference to
documents you have not included, no "see the attached". If a figure matters, state it.

### 2.4 Length

Roughly **150–450 words**. Long enough to carry a real situation; short enough that the
request stays clear. This is a guide, not a hard gate.

### 2.5 Vary your twelve

Across your twelve scenarios, vary:

```
industry / domain          organisation size          time horizon
reversibility              stakes                     uncertainty
how much evidence is supplied
how many explicit alternatives are named
the style of deliverable requested
```

Some should be weighty; some should be ordinary. A set made only of momentous decisions
is not a realistic set.

**Do not** vary anything about the expected *answer*. Specifically, do not try to make
scenarios that "need several kinds of expertise", "are complex", "require multiple
perspectives", "would produce disagreement", or "need more than one expert". Those are
properties of an answer, and shaping the pool around them would invalidate what it is for.

### 2.6 Do not repeat yourself

Your twelve must be twelve different situations. Two scenarios that differ only in
industry, or only in the numbers, are one scenario. Vary the shape of the decision, not
the set dressing.

### 2.7 Never include

```
the names of any AI provider, model, assistant or agent
any instruction about how the answer should be produced, or by whom
any mention of research, experiments, evaluation, eligibility or categories-as-labels
any meta-commentary addressed to us rather than to the advisor
```

Write the scenario as the asker. Never as someone briefing a system.

#### The one that is easy to get wrong

**Do not tell the advisor how many people, experts, perspectives or roles should be
involved in answering.** That is the entire rule. It is about **how the answer gets made**
— not about which words your scenario is allowed to contain.

Your scenario describes a world, and real organisations are full of specialists, experts,
consultants, panels and committees. Naming them is describing the situation:

`ILLUSTRATIVE ONLY — NOT ELIGIBLE FOR CBRP:`

- *The two sites still run overlapping specialist rotas.* — a fact about the world
- *An expert witness has already filed a report.* — a fact about the world
- *Our compliance committee meets fortnightly.* — a fact about the world

What you may never do is reach past the scenario and shape the reply:

`ILLUSTRATIVE ONLY — NOT ELIGIBLE FOR CBRP:`

- *Consult several specialists before answering.* — shapes the reply
- *Give me finance, operations and brand perspectives.* — shapes the reply
- *Have an expert panel debate the options.* — shapes the reply
- *This needs multiple kinds of expertise.* — shapes the reply

**The test.** Delete the sentence and ask what was lost. If the *situation* lost a fact,
the sentence belongs. If only the *instructions to the advisor* changed, cut it.

### 2.8 Output format

Return exactly this, and nothing else:

```json
[
  {
    "stratum": "Strategy / Commitment",
    "text": "The full scenario, ending in its request."
  }
]
```

Twelve objects, two per category, `stratum` spelled exactly as the six headings above.

> ### Paste to here.

---

## 3. What happens next (NOT pasted)

Two outcome-blind gates, in order:

1. **Per-task structural review** — two independent blinded reviewers, a third on
   disagreement. `CBRP_STRUCTURAL_REVIEW_RUBRIC_DRAFT.md`.
2. **Corpus duplicate audit** — after all sixty pass review, two blinded auditors read all
   sixty texts at once. `CBRP_CORPUS_DUPLICATE_AUDIT_DRAFT.md`. Duplication is a property
   of the corpus, so a per-task reviewer is not asked about it.

A scenario rejected by either gate is discarded before the freeze and replaced from a fresh
replacement session in the same block under this same brief. A discarded scenario may never
re-enter the pool.

`[ARCHITECTURE-DECIDED]` **§2.7 is a review question, not an authoring-run STOP.** A
scenario that steers answer production is rejected by the structural reviewer's
`noSpecialistSteering` judgement and replaced — the same as any other structural failure.
The authoring run itself stops only for mechanical and transport faults. That division is
what v1 got wrong, and it is frozen in
[`CBRP_AUTHORING_PROTOCOL_2.md`](CBRP_AUTHORING_PROTOCOL_2.md).

The variation instruction in §2.5 and the "do not repeat yourself" instruction in §2.6 are
**authoring guidance**. Neither is an admission gate: no task is rejected because an
aggregate diversity distribution looks unattractive.

**No scenario authored under this brief exists yet, and none may be authored until GPT
issues an execution authorization for `CBRP-AUTHORING-V2-ROUND-0`.** CWP-10A freezes the
methodology only.
