# CBRP Session Provenance Schema — DRAFT

```
STATUS:  DRAFT ｜ NOT ACCEPTED ｜ NOT PREREGISTERED ｜ NOT AUTHORIZED
SESSIONS RECORDED:  0     AUTHORING 0 ｜ STRUCTURAL REVIEW 0 ｜ DUPLICATE AUDIT 0
MODEL PINS:  CBRP-SESSION-MODEL-PINS-1  ｜  D3 ROUTING:  CBRP-D3-v1
```

> **Exact provider/model strings live in one place only:**
> [`CBRP_MODEL_PINS_PREREG_DRAFT.md`](CBRP_MODEL_PINS_PREREG_DRAFT.md). This document
> records *what each session must write down*; that one records *which model each role
> gets*. Nothing here restates a model string.

> The shape of the record every CBRP model session leaves behind. **No session has run.**
> Field names are illustrative; the invariants and the exclusions are not.

Companion to [`CBRP_POOL_MANIFEST_SCHEMA_DRAFT.md`](CBRP_POOL_MANIFEST_SCHEMA_DRAFT.md),
which describes the frozen pool. This document describes **how the pool was produced** —
who wrote each task, who reviewed it, and who audited it for duplication.

---

## 0. What this is for, and what it cannot do

Three model-driven stages sit between "no tasks" and "frozen pool":

```
authoring            5 blocks, ≥ 5 fresh sessions          → provisional tasks
structural review    2–3 blinded reviewers per task        → per-task admission
duplicate audit      2–3 blinded auditors per round        → corpus-level admission
```

Every one of them is a judgement made by a model in a context, and every one of them
decides pool membership. If the record of who made those judgements is missing or
approximate, the pool's blinding claims are assertions rather than checkable facts.

`[DESIGN]` **What this schema cannot do:** it records what was *declared* about each
session. `freshContextConfirmed` is an operator attestation, not a cryptographic fact —
nothing in an artifact can prove a conversation began empty. The schema makes the claim
explicit, attributable and falsifiable by anyone with the execution logs. It does not make
it self-proving, and no result may describe it as verified.

---

## 1. Common to every session record

```
sessionId              globally unique across the whole study
sessionKind            AUTHORING | STRUCTURAL_REVIEW | DUPLICATE_AUDIT
modelPinVersion        CBRP-SESSION-MODEL-PINS-1
providerRequested      the pinned provider for that role
modelRequested         the pinned exact model for that role
providerResolved       if observable, else null
modelResolved          if observable, else null
modelFamily            CLAUDE_FAMILY | GEMINI_FAMILY
freshContextConfirmed  boolean — attested, see §0
createdAt              ISO-8601 timestamp
```

### 1.0 Requested versus resolved

```
if resolved identity IS observable and differs from requested

    STOP
    that session's output is NOT admitted
    no retry under another model
```

`[DESIGN]` **Resolved identity is frequently unobservable and the schema says so.** These
are blinded pastes into fresh contexts, and a chat surface generally does not report which
exact build answered. Where it cannot be seen the fields are `null`, and the pin is an
**operator instruction backed by attestation** — the same epistemic status as
`freshContextConfirmed`, and the same prohibition on calling it verified. The mismatch STOP
binds only where identity can actually be observed.

`[ARCHITECTURE-DECIDED]` No substitution in any case: no alias, no upgrade, no fallback, no
same-family swap. An unavailable pinned model is a **STOP and a return to GPT**, never a
quiet replacement — see the pin table §8.

### 1.1 `modelFamily` is a label, not a measurement

`[DESIGN]` It is declared by the operator so that the family constraints in §2.2 and §4.1
can be checked. **No family effect is estimated and none may be claimed** — not for
authoring quality, not for review agreement, not for anything. The census estimates one
thing, and it is not this.

### 1.2 The Chief model is excluded everywhere

```
[ARCHITECTURE-DECIDED]

openai / gpt-5   FORBIDDEN in all three session kinds, and in both D3 routes
```

Not only authoring. A model under measurement must not decide the membership of the pool
it will later be measured on — whether it decides by writing the tasks, by admitting them
one at a time, by ruling on duplication, or by breaking a tie in either. The exclusion is a
single rule with five applications, and it is checkable from these records alone.

This is the **measured Chief planning pin**, which is a different thing from the pins in
this schema and is untouched by them: the Census execution pin stays `openai / gpt-5`.

`[DESIGN]` **This does not eliminate shared priors or model-family bias.** It removes one
identifiable coupling — generator-or-gatekeeper is the measured system — and nothing
wider. Any result must say so.

---

## 2. Authoring sessions

```
authorBlockId          AUTHOR-B01 … AUTHOR-B05
actualAuthorSessionId  AUTHOR-B01-S00 ｜ AUTHOR-B01-R01 ｜ …
sessionType            INITIAL | REPLACEMENT
provider
model
modelFamily
freshContextConfirmed
authoringBriefSha256   byte-identical across every authoring session
createdAt

targetStrata           INITIAL: all six ｜ REPLACEMENT: exactly the vacated one
producedTaskIds        INITIAL: 12 ｜ REPLACEMENT: 1
replacementOf          the rejected task's id, or null for INITIAL
replacementGeneration  0 for INITIAL; 1, 2, … for successive replacements of one slot
rejectedPredecessorBy  STRUCTURAL_REVIEW | CORPUS_DUPLICATE | null
```

### 2.1 A replacement session is never recorded as the original

`[DECISION]` `authorBlockId` and `actualAuthorSessionId` are separate fields precisely so
that a replacement can name its block without borrowing its block's first session. Writing
`AUTHOR-B01-S00` on a task that came from `AUTHOR-B01-R02` would make the provenance say
something untrue about how the pool was produced.

`replacementGeneration` increments on **every** replacement of a slot regardless of which
gate rejected the predecessor, and `rejectedPredecessorBy` records which gate it was. A
replacement rejected by structural review never reaches a duplicate auditor, so the two
gates produce different downstream evidence and must stay distinguishable.

### 2.2 Family allocation, frozen before authoring

Per-block provider, exact model and family:
[`CBRP_MODEL_PINS_PREREG_DRAFT.md`](CBRP_MODEL_PINS_PREREG_DRAFT.md) §2 —
**frozen**, `CBRP-SESSION-MODEL-PINS-1`.

Two distinct non-Chief families. Every replacement session for a block uses **that block's**
pinned provider, exact model and family — a block does not change model because one of its
tasks was rejected, and no replacement may switch model to improve its chance of
acceptance.

`[DESIGN]` The 3 : 2 split is forced: five blocks do not divide evenly into two families.
It does not confound anything, because each block × each stratum = 2 admitted tasks, so
**every stratum receives 6 CLAUDE_FAMILY and 4 GEMINI_FAMILY tasks — the same split in all
six.** Family is unbalanced overall and exactly orthogonal to stratum, which is the
property that matters for a stratified estimand.

`[CLOSED]` The exact provider/model IDs per block were frozen in CWP-8D. Three blocks are
CLAUDE, two GEMINI; because each block × each stratum = 2 admitted tasks, **every stratum
receives the identical 6 CLAUDE / 4 GEMINI split**, so family stays orthogonal to stratum.

---

## 3. Structural review sessions

```
reviewId               <taskId>-R1 ｜ -R2 ｜ -R3
taskCandidateId        the task reviewed
reviewerSessionId      globally unique; never reused across tasks
reviewRole             R1 | R2 | R3
modelPinVersion ｜ providerRequested ｜ modelRequested
providerResolved ｜ modelResolved ｜ modelFamily
freshContextConfirmed
reviewRubricSha256     byte-identical across every review in the study
createdAt

overallPass            the rubric's single admission output
resultRef              pointer to the verbatim six-judgement record

d3SelectorInput        R3 only: the exact bytes hashed
d3Selector             R3 only: the lowercase hex digest
```

Roles R1 and R2 are pinned to one model each, and R3's model is **derived, not chosen** —
`CBRP-D3-v1`, a SHA-256 over `"CBRP-D3-v1\nSTRUCTURAL\n" + taskCandidateId`, first hex
character `0-7` → Claude reviewer, `8-f` → Gemini reviewer. Storing the input bytes and the
digest lets a reader recompute the route instead of trusting that it was followed. Full
spec and test vectors: [`CBRP_MODEL_PINS_PREREG_DRAFT.md`](CBRP_MODEL_PINS_PREREG_DRAFT.md)
§7.

`[DESIGN]` The six per-task judgements live in the review evidence, not here. This record
answers *who reviewed what, under which rubric*; the rubric's own output stays in one
place so it cannot drift between two copies.

`R3` exists **iff** R1 and R2 disagreed, and receives neither of their answers nor the
fact that they disagreed.

---

## 4. Duplicate audit sessions

```
roundId                DUP-R00 ｜ DUP-R01 ｜ …
auditorId              DUP-R00-D1 ｜ DUP-R00-D2 ｜ DUP-R00-D3-<idA>__<idB>
auditorRole            D1 | D2 | D3
modelPinVersion ｜ providerRequested ｜ modelRequested
providerResolved ｜ modelResolved ｜ modelFamily
freshContextConfirmed
duplicateRubricSha256  byte-identical across every round
auditScopeIds          the exact ID list supplied to that auditor
createdAt

corpusTaskIds          the corpus as it stood for that round
disputedPair           D3 only: the two ids, ascending lexicographic order
d3SelectorInput        D3 only: the exact bytes hashed
d3Selector             D3 only: the lowercase hex digest
returnedPairs          verbatim, including an empty list
```

D1 and D2 are pinned; D3's model is derived the same way, over
`"CBRP-D3-v1\nDUPLICATE\n" + a + "\n" + b` with the pair sorted ascending — so the route
belongs to the **pair**, never to whichever auditor reported it first.

### 4.1 Constraints checkable from these records alone

```
every round's D1 and D2 are DIFFERENT sessions from every other round's
no auditor session id appears under two roundIds
duplicateRubricSha256 is one value across the entire study
round DUP-R00 has auditScopeIds = all sixty ids
round DUP-Rj (j >= 1) has auditScopeIds = that round's focusSet, and nothing else
a D3 record exists iff exactly one of D1/D2 reported that pair
disputedPair is stored in ascending lexicographic order, never flagger order
no session record carries openai/gpt-5, in any role, including either D3 route
every session's modelRequested equals its role's pin under CBRP-SESSION-MODEL-PINS-1
every D3 record's model is REPRODUCIBLE from d3SelectorInput alone
d3SelectorInput matches the byte template for its adjudication type, exactly
one modelPinVersion across the entire study
```

`[DESIGN]` These are stated as record-level checks on purpose. A blinding claim that can
only be confirmed by asking the operator what they remember is not a claim a later reader
can check.

`[CLOSED]` The exact reviewer and auditor provider/model IDs were frozen in CWP-8D:
[`CBRP_MODEL_PINS_PREREG_DRAFT.md`](CBRP_MODEL_PINS_PREREG_DRAFT.md) §3, §4 and §7.

`[DECISION]` **A reviewer or auditor MAY share the author's model family.** It is allowed
because every task receives one CLAUDE_FAMILY and one GEMINI_FAMILY judgement, and because
within a family the reviewing model is a **different exact model** from the authoring one —
so no task is ever admitted by the exact model that wrote it.

`[DESIGN]` This is not reviewer independence. A same-family reviewer shares vendor and
training priors with the author, and the design does not remove them; it removes exact-model
self-screening only. **No result may describe the reviewers as independent of shared family
priors.**

---

## 5. Where these records live

```
authoring sessions        referenced by the pool manifest's tasks[] and discarded[]
structural reviews        referenced by tasks[].structuralReviewIds
duplicate audit rounds    referenced by the manifest's duplicateAuditRounds[]
```

All of it is committed with the pool freeze. Provenance materialized after the freeze
would be a reconstruction, and a reconstruction of who judged what is exactly the thing
this schema exists to make unnecessary.

---

## 6. Status

```
authoring sessions 0 ｜ review sessions 0 ｜ audit sessions 0
tasks produced 0 ｜ pools frozen 0
```

No session has been run and none is authorized.
