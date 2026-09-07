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

### 1.3 Authoring session IDs

```
AUTHOR-01 … AUTHOR-05
```

Provenance only. The authoring provider and model may be recorded beside them; **no
result may be read as an author-model effect**, which this study does not estimate.

---

## 2. Pool manifest

`[DRAFT]` Populated only at freeze, and only once all 60 tasks have structurally passed.

```
studyVersion             CBRP-CENSUS-1
poolVersion              e.g. CBRP-POOL-1 — a whole-pool version, never per-task
frozenAt                 timestamp
frozenCommit             the commit this manifest is committed in

taskCount                60
stratumCounts            { each of the six: 10 }
authorSessionCounts      { AUTHOR-01..05: 12 }
authorSessionByStratum   { stratum: { AUTHOR-01..05: 2 } }

authoringBriefSha256     the exact brief every session received
reviewRubricSha256       the exact rubric every reviewer received

tasks[]                  taskId
                         taskSha256
                         stratum
                         authorSessionId
                         structuralReviewIds    ["…-R1", "…-R2", optionally "…-R3"]
                         structuralPass         true — a frozen pool contains only passes
                         replacementOf          a discarded task's id, or null

discarded[]              taskId ｜ stratum ｜ authorSessionId
                         structuralReviewIds ｜ rejectedAt ｜ replacedBy
```

**No ordering field appears here.** Order is materialized in a separate artifact after the
freeze, so that the pool commit exists before the seed is derived from it — see §4.

### 2.1 Invariants a freeze must satisfy

```
exactly 60 tasks, all structurallyPass = true
exactly 10 per stratum
exactly 2 per stratum per authoring session, for all five sessions
every taskSha256 recomputes from the frozen bytes
every task has R1 and R2; R3 present iff R1 and R2 disagreed
every discarded task names its replacement, and no discarded id appears in tasks[]
authoringBriefSha256 and reviewRubricSha256 identical across every task
```

---

## 3. Freeze and what may change afterwards

**Freeze requires**, committed and pushed together: the exact task bytes, ids, hashes,
strata, authoring session ids, review ids and results, and any replacement lineage.

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

## 4. Order manifest — a separate artifact, after the freeze

```
studyVersion ｜ poolVersion ｜ poolManifestSha256
seedMethod ｜ seedInputs ｜ seed
rounds[]     ten rounds, each six taskIds, one per stratum
orderIndex   0..59, derived from rounds
materializedAt ｜ materializedCommit
```

Separate on purpose: the seed is derived from the frozen pool commit, so the pool must be
committed first. Keeping order out of the pool manifest makes that sequence structural
rather than a matter of discipline.

**Required sequence, in order:**

```
task freeze commit
  → seed derivation
  → deterministic order materialization
  → order manifest commit and push
  → Final Pre-Live Review
  → only then may LIVE authorization even be considered
```

---

## 5. Status

```
tasks authored     0        pools frozen       0
reviews run        0        seeds derived      0
order manifests    0        provider calls     0
```
