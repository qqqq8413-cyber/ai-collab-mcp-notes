# CBRP Replacement Protocol 1 — FROZEN METHODOLOGY

```
PROTOCOL:   CBRP-REPLACEMENT-PROTOCOL-1
SELECTION:  CBRP-REPLACEMENT-SELECTION-v1
BRIEF:      CBRP-AUTHORING-BRIEF-2  (UNCHANGED — same 8114 bytes, same sha256)
BRIEF SHA:  a9da93fd5d4dd059c0faebdf3e29713abe2035191af5aac26a5b73eb17842336

STATUS:  METHODOLOGY FROZEN ｜ OFFLINE VERIFIED ｜ NOT EXECUTED ｜ NOT AUTHORIZED
REAL REPLACEMENT SESSIONS: 0     STRUCTURAL REVIEWS: 0     PROVIDER CALLS: 0
```

> **Content-blind by construction.** This document, its reference implementation and its
> tests were written without inspecting the sixty `CBRP-AUTHORING-V2P1-ROUND-0` task
> texts. Nothing here depends on what any of them says, and the procedure is designed to
> work identically for any possible set of future review or audit failures — because it
> was written before any exist.

---

## 0. Why this needed its own document

`CBRP_AUTHORING_AND_REVIEW_DRAFT.md` §7.1 says a rejected task's replacement "uses the
same frozen authoring brief" and "targets only the vacant stratum slot." Both are true,
but the brief demands **12 scenarios, 2 per stratum** from every session — never one. So
"targets only the vacant slot" could not, as written, mean the *author* is told the slot;
it had to mean the *operator* narrows twelve outputs down to one, and nothing had said
how. That gap — which of the 12 fills the vacancy, what happens to the other 11, whether
a same-session second attempt is allowed, how simultaneous vacancies map to session ids —
is what this protocol closes, **before** structural review produces a single real
vacancy to close it around.

---

## 1. The author-facing prompt never changes

`[ARCHITECTURE-DECIDED]` A replacement session receives **exactly** the same frozen paste
bytes as an initial session — `CBRP-AUTHORING-BRIEF-2`, sha256 `a9da93fd…`, 8114 bytes —
and nothing else.

```
NEVER TOLD:  which slot is vacant           which stratum needs replacement
             which predecessor failed        why it failed
             whether the rejection came from structural review or duplicate audit
             which tasks already exist        reviewer output ｜ duplicate auditor output
```

The author produces the same **12 scenarios, 2 per stratum** as any initial session. A
replacement session is, from the author's side, indistinguishable from an initial one.

`[DESIGN]` This is what makes "targets only the vacant slot" true without being false:
the *session* is blind and general; the *operator* is the one who narrows the output, by
a rule fixed in advance (§3), never by reading the twelve scenarios and picking a
favorite.

---

## 2. One vacancy → one fresh replacement session

`[ARCHITECTURE-DECIDED]`

```
for EVERY vacated pool slot:  exactly ONE fresh replacement session is dispatched
    same author block               same exact block provider/model pin
    same frozen 8114-byte brief     fresh stateless context
    ONE logical provider call        no retry, no repair, no continuation
```

Session identity: `AUTHOR21-B0X-R01`, `-R02`, … — allocation rule in §5. **Session
identity and `replacementGeneration` are separate concepts** — see §6.

---

## 3. Deterministic slot selection — CBRP-REPLACEMENT-SELECTION-v1

`[ARCHITECTURE-DECIDED]` Let `S` be the vacant slot's frozen stratum. Among the
replacement session's exactly two candidates whose **author-declared** stratum is `S`:

```
SELECT the candidate with the smaller indexInResponse
     = the FIRST target-stratum candidate in response order
```

```
FORBIDDEN:  semantic comparison ｜ quality judgement
            a reviewer choosing between the two ｜ operator discretion
```

`indexInResponse` exists the instant the response is mechanically parsed — before anyone
reads a word of scenario text — which is what makes this rule content-blind in fact and
not merely in intent.

Reference implementation:
[`replacement-protocol/replacement-selection-v1.mjs`](replacement-protocol/replacement-selection-v1.mjs)
— function `selectReplacementCandidate`. It fails closed (returns `{ ok: false, reason }`,
never throws, never guesses) on any mechanical irregularity: not exactly 12 candidates,
any declared stratum with a count other than 2, or fewer/more than 2 candidates declaring
the vacant stratum. A malformed replacement response is a mechanical STOP for the whole
session (§7), never a reason to loosen this check.

---

## 4. Surplus disposition

`[ARCHITECTURE-DECIDED]` Exactly **one** of the twelve outputs becomes the admitted
replacement candidate. The other **eleven** — including the *second* target-stratum
candidate — receive a permanent, singular disposition:

```
SURPLUS_REPLACEMENT_OUTPUT / PERMANENTLY_INELIGIBLE
```

Preserved as evidence (text, hash, declared stratum, session provenance). **Never**:

```
structurally reviewed for admission     used to fill another vacancy
used as a later fallback                used as a duplicate-audit candidate
used as a seed / example                used in Chief / Census
recycled into another replacement generation
```

`[DESIGN]` "Permanent" is load-bearing. A surplus output that could later be promoted
would turn the selection rule into a menu rather than a determination, and the whole
point of fixing `indexInResponse` as the tiebreak in §3 is that there is no menu.

---

## 5. Session-id allocation across a vacancy batch

`[ARCHITECTURE-DECIDED]` All vacancies in a batch are known **before** any replacement
provider call (see §8/§9 for what "batch" means for each gate). Then, deterministically:

```
1. sort ALL vacancies ascending by (authorBlockId, replacementOf), replacementOf compared
   as a plain lexicographic string
2. within each authorBlockId, in that sorted order, allocate the next unused ordinal:
   existing max ordinal for that block, + 1, + 1, ...
```

Reference implementation: `allocateReplacementSessionIds` in
[`replacement-protocol/replacement-selection-v1.mjs`](replacement-protocol/replacement-selection-v1.mjs).
If `AUTHOR21-B02-R01` and `-R02` already exist, the next vacancy in that block receives
`-R03` — the counter is a property of the block's dispatch history, not of the current
batch alone.

---

## 6. Replacement lineage — mandatory fields

For the **admitted** replacement candidate:

```
authorBlockId ｜ actualAuthorSessionId ｜ replacementOf
replacementGeneration ｜ rejectedPredecessorBy
```

`[ARCHITECTURE-DECIDED]` **`replacementGeneration` increments per SLOT** — 1, 2, 3, … —
**regardless of which gate rejected the predecessor** (`STRUCTURAL_REVIEW` or
`CORPUS_DUPLICATE`; recorded separately in `rejectedPredecessorBy`).

**`replacementGeneration` and the session ordinal (§5) are independent counters**, and the
test suite demonstrates this directly: a slot's fifth replacement generation can be
served by whichever block-level session ordinal comes next in dispatch order, and the two
numbers need not — and in general will not — match. One counts refills of a *slot*; the
other counts replacement sessions ever dispatched by a *block*.

A surplus output (§4) is never part of this lineage as an admitted replacement — it has
no `replacementOf` relationship to any slot, because it was never selected for one.

---

## 7. Mechanical failure of a replacement session

`[ARCHITECTURE-DECIDED]` A replacement author response is governed by the **same**
mechanical rules as an initial Protocol 2.1 session: exact pinned model, same brief hash,
fresh context, `CBRP-AUTHOR-EXTRACTOR-2.1`, 12 candidates, 2 per declared stratum, valid
labels, raw preservation.

```
if a dispatched replacement call fails mechanically:
    preserve evidence
    STOP
    no retry ｜ no same-session repair ｜ no alternative model
    no automatic new replacement session
    return to GPT Architecture
```

---

## 8. Structural-review vacancy batching

`[ARCHITECTURE-DECIDED]`

```
1. complete ALL R1 / R2 / required R3 structural-review decisions for the initial 60
   FIRST — do not begin replacement authoring after the first failed task
2. only once all 60 initial decisions are final, materialize the complete
   structural-failure vacancy batch
3. return to GPT for explicit replacement-batch LIVE authorization — no automatic
   replacement call is authorized by structural review itself
```

For an authorized replacement batch: each selected replacement receives ordinary
`R1` / `R2`, `R3` on disagreement. If any selected replacements fail: finish the current
batch's review decisions first, then form the next replacement vacancy batch, then STOP
to GPT for a new explicit authorization. **Never auto-loop provider calls.**

---

## 9. Duplicate-audit vacancies

`[ARCHITECTURE-DECIDED]` After a duplicate-audit round, all confirmed rejections from
that round are determined first and form **one** replacement batch, screened by the
**same** selection protocol (§3–§6). Every selected replacement must pass structural
review before entering the next incremental duplicate-audit round — replacements are not
generated one at a time while an audit round is still unresolved.

This is the same closure requirement `CBRP_AUTHORING_AND_REVIEW_DRAFT.md` §7.1.1 already
states for the authoring↔review boundary; this protocol supplies the *selection*
mechanism that boundary assumed but never defined.

---

## 10. Candidate ids for replacement evidence

`[ARCHITECTURE-DECIDED]` All twelve raw outputs from a replacement session receive
evidence ids under their **real session**:

```
V21-B01-R01-SC-01, V21-B01-R01-SC-02, ...
```

The admitted replacement keeps **its own actual id** — it is never renamed to its
predecessor's id. Slot lineage (which id replaced which) lives in the pool manifest
(`replacementOf`), not in the id string itself, for the same reason a task id never
encoded expected outcome (`CBRP_POOL_MANIFEST_SCHEMA_DRAFT.md` §1.1).

---

## 11. Model pins — unchanged

A replacement inherits its author **block's** exact frozen pin, unconditionally:

```
B01 / B03 / B05  →  claude / claude-sonnet-5
B02 / B04        →  gemini / gemini-3.7-flash
```

No alias, no fallback, no substitution, no model switching after rejection — identical to
`CBRP_MODEL_PINS_PREREG_DRAFT.md` §2.1: model identity belongs to the block, never to
whether a predecessor passed.

---

## 12. Reviewer blindness

`[ARCHITECTURE-DECIDED]` No future structural reviewer receives any of:

```
literal scanner output          author rejection history
surplus candidate information   why a task is a replacement
predecessor text                 previous reviewer outputs
replacementGeneration
```

Reviewer-visible inputs remain exactly the preregistered task/rubric inputs
(`CBRP_STRUCTURAL_REVIEW_RUBRIC_DRAFT.md` §2.1–§2.2), unchanged by this protocol.

---

## 13. Offline verification

```
module   experiments/m2b/census/replacement-protocol/replacement-selection-v1.mjs
tests    experiments/m2b/census/replacement-protocol/test-replacement-selection-v1.mjs
         16/16 synthetic tests passing, none derived from real CWP-10E candidate text
         (the suite asserts this of itself)
```

Covered: first-in-response selection; response order reversed selects a different
candidate; 11 surplus outputs, including the non-selected same-stratum candidate;
fail-closed on wrong count, wrong per-stratum count, and a missing target stratum;
multi-vacancy and multi-block RNN allocation; continuation from existing ordinals;
`replacementGeneration` independence from session ordinal; and that no function in this
module can promote a same-session surplus candidate after its sibling is rejected — a
failed selection can only be followed by a **new** vacancy going through the **same**
allocator, which mints a new ordinal.

---

## 14. Status

```
CBRP-REPLACEMENT-PROTOCOL-1     FROZEN, OFFLINE VERIFIED, NOT EXECUTED
real replacement sessions       0
selected replacement candidates 0
structural reviews of any kind  0
provider calls                  0
```

No vacancy exists yet — no structural review has run on the 60
`CBRP-AUTHORING-V2P1-ROUND-0` candidates. This protocol governs what happens the first
time one does, and not before.
