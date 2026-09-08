# CBRP Corpus Duplicate Audit — SPECIFICATION CLOSED

```
PROTOCOL:      CBRP-CORPUS-DUPLICATE-AUDIT-PROTOCOL-1
D1/D2 PINS:    D1 claude/claude-opus-5, D2 gemini/gemini-3.8-flash
               (unchanged — CBRP_MODEL_PINS_PREREG_DRAFT.md §4)
D3 ROUTING:    CBRP-D3-v1        (unchanged — CBRP_MODEL_PINS_PREREG_DRAFT.md §7.2)

STATUS:  SPECIFICATION CLOSED | IMPLEMENTATION NOT YET VERIFIED | LIVE NOT AUTHORIZED
AUDIT ROUNDS RUN:  0     AUDITORS ASSIGNED:  0     CONFIRMED DUPLICATES:  0
```

> This document closes the *specification* (CWP-12A): every deterministic mechanism,
> schema, sequencing rule and evidence requirement below is normative. No reference
> implementation (harness/tests) exists yet — that is separate, future engineering work
> and requires its own `EXECUTION AUTHORIZATION: GRANTED` packet, exactly as
> `CBRP_STRUCTURAL_REVIEW_PROTOCOL_1.md` did before its harness was built. DUP-R00 has
> not run. This document does not preregister the overall CBRP study; it closes one
> instrument inside it.

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
Scope: **every unordered pair** — 1770 of them (see §5 for how that number is derived
and verified).

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
in §11 keeps incumbents because their mutual pairs are already cleared; if a round could
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
   a NEW fresh replacement session per task — same blind brief, same 12-scenario
   output; the operator deterministically admits only the first response-order
   candidate declaring the vacated stratum (`CBRP-REPLACEMENT-SELECTION-v1`,
   `CBRP_REPLACEMENT_PROTOCOL_1.md`), never the author
6  every replacement receives normal R1 / R2 structural review, R3 on disagreement
7  a replacement that FAILS structural review is itself replaced and re-reviewed,
   until every vacated slot holds a structurally-passing task
8  the structurally-passing tasks of that batch become focusSet_(j+1)
9  round j+1 runs
```

`[DESIGN]` **Step 7 is a closure requirement, not a detail.** §4 gives every D1/D2
auditor all sixty texts; there are only sixty texts to give once every vacancy is filled.
Structural review of a replacement batch must therefore run to completion — including
replacing the replacements that fail it — *before* the next duplicate round can begin. A
replacement rejected by structural review never reaches a duplicate auditor.

`[DESIGN]` Vacancies are batched (step 4) rather than filled one at a time so that a batch
of replacements is screened against each other in a single round. Filling them
sequentially would put each new task in its own round and multiply the rounds without
changing what gets screened.

---

## 4. Instrument architecture — three layers

`[ARCHITECTURE-DECIDED]` The instrument is not one rubric. It is three layers, and every
implementation must keep them separable:

```
A.  COMMON DUPLICATE DEFINITION    what a duplicate IS — byte-identical wherever used
B.  D1/D2 CORPUS AUDIT WRAPPER     A + corpus-scale framing + auditScopeIds + schema
C.  D3 PAIR ADJUDICATION WRAPPER   A + two-candidate framing + schema — nothing else
```

Layer A never varies. Layers B and C each add exactly what their auditor needs and
nothing an earlier draft happened to include for convenience. The earlier draft of this
document put corpus-scale framing ("you are reading sixty decision scenarios…") directly
inside the one rubric D3 also read from — naming the corpus size and implying a scope list
D3 must never see. §8 exists specifically to keep that framing out of what D3 reads.

### 4.1 Layer A — the common duplicate definition

The semantic standard for what counts as a duplicate. Frozen text, given in full in §6.
Both D1/D2 and D3 read these exact bytes, unmodified, as the semantic core of their
respective wrapper.

### 4.2 Layer B — the D1/D2 corpus audit wrapper

Layer A, plus:

```
receives         the sixty current task IDs
                  the sixty current task texts
                  auditScopeIds        the ID list defining which pairs are in scope
                  D1/D2 output schema (§7.1)

must NOT receive  auditor identity
                  stratum labels
                  replacement history
                  why auditScopeIds are scoped
                  prior-round findings
                  prior-round outcomes
                  the other auditor's output
                  expected result
                  Chief output ｜ Chief complexity ｜ assigned specialist count
                  the measured event definition ｜ theta ｜ the P03 outcome
```

Auditor/session identity belongs in harness metadata, never in the model-visible prompt —
see §7.1: no model-visible `auditorId` field.

`[DESIGN]` **Stratum labels are withheld.** They are not needed — duplication is about the
decision underneath, not the category assigned to it — and supplying them would invite an
auditor to look for duplicates *within* categories and skip the cross-category pairs,
which are exactly the ones a per-task reviewer could never have caught.

#### 4.2.1 One rubric, scope supplied as data

`[DECISION]` The scope is a **data field**, never a change to Layer A's text.

```
round 0        auditScopeIds = all sixty IDs        → the scope clause is vacuous
round j >= 1   auditScopeIds = focusSet_j            → the scope clause binds
```

So Layer A's hash is **the same in every round**, and the pool manifest's requirement
that one rubric hash covers the whole study survives an arbitrary number of incremental
rounds. A rubric edited per round would be a different instrument each time, and "the
auditors all used the same rubric" would stop being checkable.

#### 4.2.2 What an auditor can infer, and cannot be prevented from inferring

`[DESIGN]` An auditor given a scope list can reasonably guess those IDs are somehow
special. That cannot be removed — the scoped question needs the scope. What is withheld is
everything that would make the guess useful: not that they are replacements, not what
replaced what, not any earlier finding, and nothing about the measured event. The residual
is named rather than denied.

### 4.3 Layer C — the D3 pair adjudication wrapper

Layer A, plus:

```
receives          candidate a ID + task text
                   candidate b ID + task text, with a and b in canonical
                     lexicographic order (§5)
                   D3 output schema (§9)

must NOT receive   auditScopeIds
                   D1 output ｜ D2 output
                   which auditor flagged the pair
                   the fact that a disagreement occurred
                   prior audit-round findings/outcomes
                   expected result
                   Chief output ｜ the measured event definition ｜ theta ｜ P03
```

Full wrapper text and D3's exact response schema: §8.

---

## 5. Deterministic serialization

`[ARCHITECTURE-DECIDED]` Every ordering used anywhere in this instrument is fixed by
rule, never by discovery order, response order, provider, or operator choice.

```
corpus task ordering        ascending lexicographic immutable candidate ID
auditScopeIds ordering      ascending lexicographic immutable candidate ID

pair canonicalization       a = lexicographically smaller immutable candidate ID
                             b = lexicographically larger  immutable candidate ID
                             require a < b
```

Pair orientation must never depend on which auditor found it, response order, provider,
or operator choice — the same rule §6.1 of `CBRP_MODEL_PINS_PREREG_DRAFT.md` already
applies to D3 routing, restated here as the general rule for every pair this instrument
handles.

### 5.1 The in-scope pair universe

The complete in-scope pair universe for a round is deterministically generated from
`corpusTaskIds` and `auditScopeIds` alone:

```
pairUniverse(corpusTaskIds, auditScopeIds) =
  { canonicalize(x, y)  for every unordered pair {x, y} ⊆ corpusTaskIds
                          such that x ∈ auditScopeIds OR y ∈ auditScopeIds }
```

For DUP-R00, `auditScopeIds = corpusTaskIds` (all sixty), so every pair qualifies and the
universe is every unordered pair of the 60 — its cardinality must be **exactly 1770**
( = C(60, 2) ). For an incremental round, `auditScopeIds = focusSet_j` and the universe is
exactly the in-scope set defined in §2.2.

This universe, not the union of an auditor's positive reports, is the denominator against
which D1/D2 completeness and D1/D2 disagreement are computed — see §7.3–§7.4.

---

## 6. Layer A — the common duplicate definition (frozen text)

The following is Layer A's complete, frozen semantic content. It is pasted byte-identical
into the D1/D2 wrapper (§7) and the D3 wrapper (§8) — never edited per round, never edited
per pair, never told the corpus size.

> ### Paste from here.

Two scenarios are duplicates when they instantiate **substantially the same underlying
decision structure** and differ only in superficial substitution:

```
industry ｜ organisation name ｜ the numbers ｜ the setting ｜ cosmetic wording
```

Ask: *strip the surface detail — is the decision being made the same decision?*

**Similarity is not duplication.** Two scenarios may freely share any of:

```
the same industry
the same kind of decision
the same format or length
the same style of request
```

and not be duplicates. Only judge a pair as a duplicate when the decision itself is the
same decision wearing different clothes.

> ### Paste to here.

---

## 7. D1 / D2 corpus audit wrapper

D1 and D2 each receive an independent fresh context (§4.2, §10.1). Their model-visible
input bytes must be identical to each other, differing only in `auditScopeIds` being the
same list supplied to both — never in wording.

The full model-visible prompt is Layer A (§6, verbatim) preceded by corpus-scale framing
and followed by the sixty task texts, `auditScopeIds`, and the return-schema instructions
below — composed the same way `structural-review-prompt-v1.mjs` composes the structural
review's rubric with its per-task `REVIEW INPUT JSON` (frozen rubric bytes first, then a
data block, never the reverse).

### 7.1 Response schema

Exact semantic schema:

```json
{
  "duplicatePairs": [
    { "a": "<candidate-id>", "b": "<candidate-id>", "reason": "<non-empty explanation>" }
  ]
}
```

No model-visible `auditorId` field. An auditor's identity is harness metadata (§13),
never part of the schema it is asked to fill in.

### 7.2 Fail-closed validation

Strict, in this order; the first violation STOPs:

```
response must be valid JSON
required top-level shape must match (duplicatePairs: array of {a, b, reason})
only known candidate IDs allowed (both a and b ∈ corpusTaskIds)
a != b
require canonical a < b (§5)
duplicate canonical pair entries forbidden (the same {a,b} reported twice)
every reported pair must be inside the deterministic in-scope pair universe (§5.1)
reason must be a non-empty string
```

```
schema-invalid output   = STOP
malformed output        = STOP
unknown ID               = STOP
scope violation           = STOP
duplicate entry           = STOP
```

No silent normalization of a reversed pair, no semantic salvage, no prompt-based repair,
no second attempt (§10).

### 7.3 Decision matrix

For every in-scope canonical pair:

```
D1=true  + D2=true    → CONFIRMED DUPLICATE
D1=false + D2=false   → NOT DUPLICATE
D1 != D2               → D3 REQUIRED
```

### 7.4 Omission is a vote

`[ARCHITECTURE-DECIDED]` **An auditor omitting a valid in-scope pair from
`duplicatePairs` means that auditor votes NOT DUPLICATE for that pair.** The full pair
universe (§5.1) is the denominator, never merely the union of the two auditors' positive
reports — so a pair neither auditor mentions is a `D1=false + D2=false` case under §7.3,
resolved without invoking D3, and an auditor's `duplicatePairs` list is read as "every pair
in scope this auditor calls a duplicate," not "the pairs this auditor bothered to
mention."

If you find no duplicates, return an empty list. That is a normal outcome, and is
persisted as one (§13).

---

## 8. D3 pair adjudication wrapper

D3 receives a new fresh blinded context for each disputed pair (§10.1). D3 must NOT
receive the sixty-task corpus wrapper — only Layer A and the one pair in dispute.

The full model-visible prompt is Layer A (§6, verbatim) preceded by two-candidate framing
and followed by candidate a's ID and text, candidate b's ID and text (in canonical order,
§5), and the return-schema instructions below. Corpus-specific instructions — the sixty
task texts, `auditScopeIds`, any wording implying a corpus of any particular size — belong
only in §7's wrapper and must never appear in Layer A or in D3's wrapper.

D3 is not told a disagreement occurred, nor which auditor flagged the pair, nor that the
pair was flagged by anyone. Told there was a split, an adjudicator answers a much easier
and quite different question than "is this pair a duplicate."

### 8.1 Response schema

Exact semantic schema:

```json
{ "isDuplicate": true, "reason": "<non-empty explanation>" }
```

`isDuplicate` is strictly boolean `true`/`false`. Strict fail-closed validation, same
posture as §7.2: schema-invalid, malformed, or missing/non-boolean `isDuplicate` = STOP.
No additional adjudication semantics — D3 answers exactly the same question D1 and D2
answered, on exactly the same two texts, under exactly the same Layer A definition.

D3's vote combines with D1/D2 by ordinary majority: two of {D1, D2, D3} agreeing decides
the pair. `[DECISION]` **GPT does not adjudicate task-level duplicate disputes**, for the
same reason it does not adjudicate structural ones: it knows the measured event, θ and the
P03 history, and a tie-break from that position is an outcome-aware decision about pool
membership.

### 8.2 D3 routing — CBRP-D3-v1

`[ARCHITECTURE-DECIDED]` **D3's model is derived, never chosen.**

```
a = lexicographically smaller immutable candidate ID
b = lexicographically larger  immutable candidate ID

selectorInput = "CBRP-D3-v1\nDUPLICATE\n" + a + "\n" + b
selector      = SHA256(selectorInput)      lowercase hexadecimal

first hex character   0-7   →  claude   claude-opus-5
first hex character   8-f   →  gemini   gemini-3.8-flash
```

Sorting the pair (§5) is what makes the route a property of the pair rather than of who
reported it first. No discretionary routing, no model substitution, existing frozen model
pins unchanged. Full spec and test vectors, including the same pair supplied both ways:
[`CBRP_MODEL_PINS_PREREG_DRAFT.md`](CBRP_MODEL_PINS_PREREG_DRAFT.md) §7.2.

### 8.3 Fresh auditor sessions, per round

`[ARCHITECTURE-DECIDED]` **Every round uses new fresh auditor contexts.** An auditor
context is never carried from one duplicate round to the next.

```
DUP-R00-D1   DUP-R00-D2
DUP-R01-D1   DUP-R01-D2
DUP-R02-D1   DUP-R02-D2
…
```

A reused context would arrive at round j already knowing what it found in round j−1 and
which of its findings were acted on — which is an earlier round's outcome, and §4.2
forbids supplying that.

**D3 session IDs** identify the round and the disputed pair, and encode no outcome:

```
DUP-R00-D3-<a>__<b>        a and b in ascending lexicographic order (§5)
```

`[DESIGN]` The two task IDs are ordered **lexicographically, never by who flagged the
pair**. Ordering by flagger would put "which auditor dissented" into the identifier, and
the identifier is preserved in the evidence a later reader sees. The ID says which pair was
adjudicated. It does not say what was decided.

### 8.4 D3 sequencing and durability

`[ARCHITECTURE-DECIDED]` For one duplicate-audit round, in this exact order:

```
1  finish D1
2  validate and persist D1
3  finish D2
4  validate and persist D2
5  derive the COMPLETE disagreement set
6  deterministically derive every D3 route (§8.2)
7  materialize the COMPLETE D3_ROUTE_MANIFEST durably — every disputed pair's route,
   written once, before any D3 provider call, never one route persisted immediately
   before its own call
8  reload/verify the persisted manifest
9  only then may the FIRST D3 provider dispatch occur
```

D3 is never launched immediately after the first disagreement is found while D1/D2 are
still finishing the round. The disagreement set and the complete route manifest must exist
before any D3 transport call. If an existing `D3_ROUTE_MANIFEST.json` is encountered for a
round already in progress, it is mechanically compared to the freshly recomputed frozen
plan — a mismatch STOPs, and the manifest is never overwritten or repaired; persistence
failure STOPs before any D3 provider call.

This durability requirement is deliberately the duplicate-audit analogue of
`CBRP-STRUCTURAL-REVIEW-PROTOCOL-1` §9's R3 route-manifest requirement
(`R3_ROUTE_MANIFEST.json`, implemented and offline-verified for structural review by
CWP-11F) — the same failure mode (a route computed in memory and dispatched from before
ever touching disk) is closed here before any duplicate-audit harness is built, rather
than after a LIVE STOP discovers it.

---

## 9. Provider / model pins

```
D1   claude / claude-opus-5      every round, without exception
D2   gemini / gemini-3.8-flash   every round, without exception
D3   CBRP-D3-v1 derived route    §8.2 — never chosen, never fixed to one provider
```

Fresh D1/D2 contexts every round (§8.3). Fresh D3 context every disputed pair (§8.3). No
fallback, no aliases, no automatic upgrade, no same-family substitution — a session that
cannot dispatch to its pinned provider/model STOPs (§10), it does not retarget to a
same-family sibling. Canonical source: [`CBRP_MODEL_PINS_PREREG_DRAFT.md`](CBRP_MODEL_PINS_PREREG_DRAFT.md)
§4 (D1/D2) and §7.2 (D3 routing and test vectors) — this document does not restate the
pins as a second source of truth, only as a summary; the pins file is authoritative.

---

## 10. Attempts and STOP policy

`[ARCHITECTURE-DECIDED]` One attempt per required provider session. Forbidden,
unconditionally:

```
retry
fallback
provider substitution
model substitution
prompt mutation after dispatch
response repair
semantic salvage
rubric weakening
```

The following are fail-closed STOP conditions — evidence already produced is preserved,
and the run does not continue past the first one encountered:

```
transport failure
provider/model unavailable
MAX_TOKENS                         (even if the visible truncated text is valid JSON —
                                     the structural review MAX_TOKENS rule applies
                                     identically here, provider-agnostic)
malformed response
schema violation                   (§7.2, §8.1)
source drift
prompt/hash drift
persistence failure
manifest mismatch                  (§8.4)
unexpected candidate/scope mismatch
attempt reservation violation
```

### 10.1 Fresh contexts, restated

Every D1/D2 session (§8.3) and every D3 session (§8.3) is a single stateless request
containing only its frozen wrapper prompt — no system prompt, no prior turns, no
conversation ID, no continuation from a previous round or a previous pair.

---

## 11. Retention — which member of a confirmed group is kept

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

### 11.1 Why incumbency wins, rather than lexicographic order

Because the alternative is an outcome-shaped lever. If a later replacement could evict an
incumbent by duplicating it with a smaller ID, then the pool's membership would be
alterable by *generating more replacements* — and the process controls how many
replacements it generates. Incumbency priority removes that lever entirely: once a task has
survived a completed round, nothing later in the process can remove it.

It also terminates better. Displacing an incumbent vacates a slot that was already filled,
so every displacement adds a round without reducing the number of open slots.

Both properties are outcome-blind: incumbency is fixed by arrival, arrival is fixed before
the audit runs, and no Chief output exists at any point in this stage.

### 11.2 Components are transitive for rejection, never for incumbent removal

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

## 12. Termination

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

## 13. Evidence preserved, per round

```
roundId
corpusTaskIds + corpus task hashes
auditScopeIds + scope hash
full deterministic in-scope pair universe, pair count, pair-universe hash    (§5.1)
commonDuplicateDefinition (Layer A) bytes + hash                              (§6)
D1/D2 wrapper bytes + hash                                                     (§7)
exact model-visible prompt bytes + hash, per session
provider/model pins                                                            (§9)
session metadata (auditor/session identity — never model-visible, §4.2)
attempt reservation, per session
raw response persisted BEFORE parsing, per session
parsed response, per session
D1 positive pair set                    verbatim, including an empty list
D2 positive pair set                    verbatim, including an empty list
complete disagreement set
complete D3 route manifest                                                     (§8.4)
D3 prompt hashes
D3 raw responses
D3 parsed responses
final pair decisions, per adjudicated pair                                    verbatim
confirmedPairs
connected components, and the I / R split applied to each                     (§11)
incumbent / focusSet classification
retained ｜ rejected                     with the rule shown, not just the outcome
vacanciesCreated, and which batch filled them
round completion state
STOP state, where applicable
```

An empty result is evidence and is stored as one. A round that found nothing is not a
round that did not run.

The final pool manifest **references every round**, not only the last. A pool whose
manifest listed only the round that happened to find nothing would be describing a
different procedure from the one that produced it.

---

## 14. Status

```
PROTOCOL:          CBRP-CORPUS-DUPLICATE-AUDIT-PROTOCOL-1
STATUS:            SPECIFICATION CLOSED | IMPLEMENTATION NOT YET VERIFIED |
                    LIVE NOT AUTHORIZED
AUDIT ROUNDS RUN:  0
auditors assigned  0 ｜ pairs confirmed 0 ｜ tasks replaced 0
```

**Current DUP-R00 input population: the 60 `CBRP-AUTHORING-V2P1-ROUND-0` candidates that
passed per-task structural review** — `CBRP-STRUCTURAL-REVIEW-PROTOCOL-1` ROUND_2 is
R3_COMPLETE, all 60 structural decisions FINAL, 0 remaining `PENDING_R3`
(`CBRP_STRUCTURAL_REVIEW_PROTOCOL_1.md` §17; evidence:
`experiments/m2b/census/structural-review-round-2/FINAL_DECISIONS.json`). This is a
genuine, current, auditable 60-task population — distinct from the CWP-9B-barred
`CBRP-AUTHORING-ROUND-0` v1 candidates, which remain permanently ineligible and are not
and never will be audit input.

DUP-R00 has not been executed. 0 duplicate-audit rounds have run, 0 pools are frozen, 0
Chief Census calls have been made. Auditor provider/model IDs are **frozen** —
[`CBRP_MODEL_PINS_PREREG_DRAFT.md`](CBRP_MODEL_PINS_PREREG_DRAFT.md) §4 for D1 and D2, §7.2
for the derived D3 route, and
[`CBRP_AUTHORING_AND_REVIEW_DRAFT.md`](CBRP_AUTHORING_AND_REVIEW_DRAFT.md) §6.2 for why the
Chief model is excluded from all of them.

This document does not claim the overall CBRP study is preregistered; it closes one
instrument's specification within it.
