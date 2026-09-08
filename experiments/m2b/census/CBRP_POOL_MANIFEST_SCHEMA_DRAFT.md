# CBRP Pool Manifest Schema — DRAFT

```
STATUS:  DRAFT ｜ NOT ACCEPTED ｜ NOT PREREGISTERED
TASKS IN ANY POOL:  0     POOLS FROZEN:  0
```

> The shape of the freeze artifact, with **no real task in it**. Field names are
> illustrative; the invariants below are not.

---

## 1. Identity schemes

### 1.1 Task IDs

```
CBRP-SC-01 … CBRP-SC-10     Strategy / Commitment
CBRP-OP-01 … CBRP-OP-10     Operations / Execution
CBRP-BC-01 … CBRP-BC-10     Brand / Creative
CBRP-EI-01 … CBRP-EI-10     Evidence Interpretation
CBRP-PS-01 … CBRP-PS-10     Product / Service Design
CBRP-FR-01 … CBRP-FR-10     Finance / Resource Allocation
```

An ID encodes **stratum and nothing else**. It must not encode difficulty, expected
complexity, expected assignment count, expected roles, or authoring session — an id a
reader can decode into an expectation is a label, and labels leak.

`[DESIGN]` The numeric suffix is assigned at freeze time in a stated order and carries no
meaning. Execution order comes from the seeded round-robin, never from the id.

### 1.2 Review IDs

```
<taskId>-R1     first blinded structural review
<taskId>-R2     second, independent
<taskId>-R3     third, only on disagreement between R1 and R2
```

A review id says which review it was, never what it concluded.

### 1.3 Author blocks and authoring sessions

These are two different things and were previously conflated.

```
author block      AUTHOR-B01 … AUTHOR-B05      a quota, fixed at five
authoring session AUTHOR-B01-S00 …             the initial fresh session for that block
                  AUTHOR-B01-R01, -R02, …      fresh replacement sessions, if required
```

The **block** is the allocation unit: each block × each stratum = **2 final admitted
tasks**, so 5 × 6 × 2 = 60. The **session** is where text actually came from. A block
begins with one initial session and gains a replacement session each time an
outcome-blind gate rejects one of its tasks.

`[DECISION]` **A replacement session is never recorded as the original session.** Writing
`AUTHOR-B01-S00` on a task that came from a later context would make the provenance say
something untrue about how the pool was produced, and the whole point of session
provenance is that it is checkable.

`[DESIGN]` The number of *sessions* may therefore exceed five. The number of *blocks* may
not. Any statement that "five sessions produced the sixty tasks" is wrong unless no
replacement was needed.

Provider and model are recorded per block as provenance. **No result may be read as an
author-model effect**, which this study does not estimate.

### 1.4 Duplicate audit rounds and auditors

```
DUP-R00                       round 0 — full, all 1770 pairs of the initial sixty
DUP-R01, DUP-R02, …           incremental rounds, one per replacement batch

DUP-R00-D1 ｜ DUP-R00-D2      that round's two independent blinded auditors
DUP-R00-D3-<idA>__<idB>       third auditor, one disputed pair, ids ascending lexical
```

A round id says when the round ran. An auditor id says which round and, for D3, which pair
was adjudicated. **Neither encodes an outcome**, and the D3 pair is ordered
lexicographically rather than by which auditor flagged it, so the identifier does not
record who dissented.

Full procedure:
[`CBRP_CORPUS_DUPLICATE_AUDIT_PROTOCOL_1.md`](CBRP_CORPUS_DUPLICATE_AUDIT_PROTOCOL_1.md).
Session records:
[`CBRP_SESSION_PROVENANCE_SCHEMA_DRAFT.md`](CBRP_SESSION_PROVENANCE_SCHEMA_DRAFT.md).

---

## 2. Pool manifest

`[DRAFT]` Populated only at freeze, and only once all 60 tasks have structurally passed.

```
studyVersion             CBRP-CENSUS-1
poolVersion              e.g. CBRP-POOL-1 — a whole-pool version, never per-task
frozenAt                 timestamp

taskCount                60
stratumCounts            { each of the six: 10 }
authorBlockCounts        { AUTHOR-B01..B05: 12 }
authorBlockByStratum     { stratum: { AUTHOR-B01..B05: 2 } }
modelPinVersion          CBRP-SESSION-MODEL-PINS-1
d3RoutingVersion         CBRP-D3-v1
authorBlockModels        { AUTHOR-B01..B05: { provider, model, modelFamily } }
                         copied from the canonical pin table at freeze time, never
                         authored here — CBRP_MODEL_PINS_PREREG_DRAFT.md is the source

authoringBriefSha256        the exact brief every session received
reviewRubricSha256          the exact rubric every reviewer received
duplicateAuditRubricSha256  the exact rubric every corpus auditor received

tasks[]                  taskId
                         taskSha256
                         stratum
                         authorBlockId          AUTHOR-B01 … B05
                         authorSessionId        the session it actually came from
                         replacementGeneration  0 for an initial task, 1.. for replacements
                         structuralReviewIds    ["…-R1", "…-R2", optionally "…-R3"]
                         structuralPass         true — a frozen pool contains only passes
                         survivedAuditRounds    every round in which it was in scope
                         admittedAtRound        the round after which its pairs were all screened
                         replacementOf          a rejected task's id, or null

discarded[]              taskId ｜ stratum ｜ authorBlockId ｜ authorSessionId
                         rejectedBy             STRUCTURAL_REVIEW | CORPUS_DUPLICATE
                         rejectedAtRound        the duplicate round, or null if structural
                         structuralReviewIds ｜ duplicateAuditEvidence
                         rejectedAt ｜ replacedBy

duplicateAuditRounds[]   roundId                DUP-R00, DUP-R01, …
                         roundType              FULL | INCREMENTAL
                         auditScopeIds          the exact list supplied to the auditors
                         corpusTaskIds          the corpus as it stood for that round
                         corpusTaskSha256       matching hashes at that moment
                         auditorSessionIds      D1, D2, and each D3
                         d3Routes               per adjudicated pair: selector input
                                                bytes, hex digest, resulting model
                         returnedPairs          verbatim per auditor, empty lists included
                         confirmedPairs         after majority
                         components             with the incumbent / replacement split shown
                         retained ｜ rejected     the §7 rule applied, shown not just asserted
                         vacanciesCreated       and the batch that filled them
```

### 2.0 No self-referential commit

`[ARCHITECTURE-DECIDED]` The manifest records **content identity only**. It carries no
field naming the commit it is committed in — a Git commit cannot contain its own SHA, so
such a field could only ever be wrong, blank, or filled in by a second commit that then
disagrees with the first.

The commit is identified from outside, by Git, and referred to downstream as
`POOL_FREEZE_COMMIT`.

**No ordering field appears here.** Order is materialized in a separate artifact after the
freeze, so that the pool commit exists before the seed is derived from it — see §4.

### 2.1 Invariants a freeze must satisfy

```
exactly 60 tasks, all structuralPass = true
exactly 10 per stratum
exactly 2 per stratum per author BLOCK, for all five blocks
every taskSha256 recomputes from the frozen bytes
every task has R1 and R2; R3 present iff R1 and R2 disagreed
every discarded task names its replacement, and no discarded id appears in tasks[]
every replacement names a session in the same author block as the task it replaced
the three rubric hashes are identical across every task
no confirmed-duplicate pair remains in tasks[]

duplicateAuditRounds[] begins with DUP-R00, roundType FULL, auditScopeIds = all 60 ids
every later round has roundType INCREMENTAL and auditScopeIds = that round's replacements
no auditor session id appears under two roundIds
one duplicateAuditRubricSha256 across every round
one modelPinVersion and one d3RoutingVersion across the whole manifest
every recorded D3 model recomputes from its stored selector input alone
no session in any role used the measured Chief model
the last round produced no vacancy, and the corpus at that round is tasks[]
EVERY UNORDERED PAIR IN tasks[] IS IN THE SCOPE OF EXACTLY ONE ROUND — recomputable
    from the rounds' auditScopeIds and corpusTaskIds alone
```

`[DESIGN]` The last invariant is the one that makes an incremental audit checkable. It is a
property of the recorded rounds, not a claim about them: a reader replays the scope lists,
takes the union of the pairs each round covered, and either it is the complete pair set of
the frozen pool or the audit had a hole. Every other invariant here would still hold on a
pool with an unscreened pair in it.

---

## 3. Freeze and what may change afterwards

**Freeze requires**, committed and pushed together: the exact task bytes, ids, hashes,
strata, authoring session ids, review ids and results, and any replacement lineage.

### 3.0 Freeze sequence

```
final pool manifest bytes
  + the exact 60 task bytes
  + all structural reviews
  + all corpus duplicate-audit evidence
  + the descriptive diversity report
      ↓
  commit + push
      ↓
  the resulting Git commit is POOL_FREEZE_COMMIT
      ↓
  only then may ordering be derived
```

### 3.1 Between freeze and the first Chief call

```
no task-text rewrite ｜ no task-content replacement
```

If a **task-content methodological defect** is found, the fix is not a patch: the whole
pool freeze is invalidated, work returns to authoring and review, and a **new pool version
covering all sixty tasks** is frozen. Patching one task would leave a pool whose members
were admitted under two different standards, and nothing in the artifact would say which.

A **mechanical packaging error** — a wrong count in a summary field, a malformed manifest —
may be corrected only if **the task bytes are unchanged** and the correction is fully
auditable.

### 3.2 After the first Chief planning call

```
no rewrite ｜ no replacement ｜ no exclusion ｜ no stratum reassignment
```

If a frozen task is then found to have a genuine structural defect: **STOP**, study status
`INCOMPLETE`, return to GPT Architecture Review. **A task is never dropped from the
denominator because of its result** — that is outcome-informed exclusion wearing a
methodology costume.

`[DECISION]` Structural task invalidity and execution failure are different things and
must not be mixed. Provider, parse, schema, constraint and resolved-pin failures stay
governed by the census session contract: preserve, STOP, `INCOMPLETE`,
`NO_STATISTICAL_VERDICT`, no retry.

---

## 4. CBRP-ORDER-v1 — frozen ordering algorithm

`[ARCHITECTURE-DECIDED]` Fully deterministic, no PRNG, no discretion at any step.

### 4.1 Stratum codes

```
SC   Strategy / Commitment          EI   Evidence Interpretation
OP   Operations / Execution         PS   Product / Service Design
BC   Brand / Creative               FR   Finance / Resource Allocation
```

Frozen. No aliases.

### 4.2 Seed

```
seed = SHA256( POOL_FREEZE_COMMIT + "\n" + "CBRP-ORDER-v1" )
```

UTF-8 bytes exactly as written. `POOL_FREEZE_COMMIT` is the **full lowercase
40-character** Git SHA of the pool freeze commit.

**No alternate seed. No retries. No seed shopping** — and not merely as a prohibition: the
seed is a pure function of a commit that already exists, so there is exactly one value and
nothing to try. The literal `CBRP-ORDER-v1` is preregistered so the derivation cannot be
re-run with a different separator to obtain a different permutation.

### 4.3 Task order within a stratum

For each frozen task:

```
taskOrderKey = SHA256( seed + "\nTASK\n" + taskId + "\n" + taskSha256 )
```

Within each stratum, sort its ten tasks by `taskOrderKey`, **ascending lowercase
hexadecimal lexical order**.

### 4.4 Stratum order within a round

For each round `r = 0 … 9` and each stratum code:

```
roundStratumKey = SHA256( seed + "\nROUND\n" + decimal(r) + "\n" + stratumCode )
```

Sort the six strata by `roundStratumKey`, ascending lowercase hexadecimal lexical order.

### 4.5 Emission

For round `r`, take **task index `r`** from each stratum's already-sorted list, and emit
those six in that round's stratum order.

```
10 rounds × 6 strata = 60 tasks
each stratum contributes exactly one task per round
```

## 5. Order manifest — a separate artifact, after the freeze

`CBRP_ORDER_MANIFEST.json`:

```
orderVersion        CBRP-ORDER-v1
poolFreezeCommit    the full lowercase 40-character SHA
seed
orderedTaskIds[60]
taskOrderKeys       per task
roundStratumKeys    per round per stratum
createdAt
artifact seal       as later defined
```

Separate on purpose: the seed is derived from the frozen pool commit, so that commit must
exist first. Keeping order out of the pool manifest makes the sequence structural rather
than a matter of discipline.

### 5.1 Validation contract

`[DESIGN]` A future verifier must recompute the **entire** ordering from:

```
POOL_FREEZE_COMMIT   +   the frozen pool manifest and task bytes
```

without trusting `seed`, `taskOrderKeys`, `roundStratumKeys` or `orderedTaskIds`. Those
are summaries, and a summary that is only compared against itself proves nothing. Not
implemented in this round; documented as the contract any implementation must meet.

**Required sequence, in order:**

```
POOL_FREEZE_COMMIT exists
  → seed derivation
  → deterministic order materialization
  → order manifest commit and push
  → Final Pre-Live Review
  → only then may LIVE authorization even be considered
```

---

## 6. Status

```
v2 candidates      12/60 provisional          tasks admitted      0
pools frozen       0        duplicate audits   0        reviews run  0
seeds derived      0        order manifests    0
authoring calls    7 total（v1 5 + v2 2）
```

The v2 acquisition stopped incomplete at B02 under CWP-10B. Its 12 mechanically
extractable B01 records are unreviewed and not admissible, so no pool manifest exists.
