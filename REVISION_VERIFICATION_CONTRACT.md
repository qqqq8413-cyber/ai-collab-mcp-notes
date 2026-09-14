# Revision Verification — Authority Model Contract (Product Completion P2-0)

Repository: `qqqq8413-cyber/ai-collab-mcp-notes`
Mode: offline architecture analysis only. 0 provider/model calls made in the production of this document.
Branch: `product/pre-submission-stress-test-mvp`.

This is an architecture-contract document. **It authorizes no implementation.** D1-A and Product Integration P1 are accepted and closed. This document freezes the authority model for the next real product gap: given a `RevisionAction` marked `IMPLEMENTED`, what artifact should be checked next, and what fact proves whether the requested change actually reached it. No type in `src/stress-test/**` is added, no function is written, and no runtime executes.

---

## 1. Product question

*"For `RevisionAction` RA-1 created against frozen Artifact V0, what authoritative successor artifact should be checked, and what fact proves whether RA-1 is actually reflected there?"*

Today `RevisionAction.status === IMPLEMENTED` means only "revision action marked implemented." It proves a human recorded intent to close the loop. It proves nothing about a successor document. This is the smallest end-to-end value loop the product needs before a real pilot:

```
one real artifact
  → one important issue
  → one human decision
  → one revision
  → one successor artifact
  → proof whether the revision actually reached that successor artifact
```

This document freezes the minimum authority for the last two steps only. It does not touch anything upstream of `RevisionAction`.

---

## 2. Existing authority inventory

Confirmed by direct repository inspection (`src/stress-test/types.ts`, `src/stress-test/session.ts`, `src/stress-test/deliberation.ts`, `src/stress-test/hash.ts`):

1. `StressTestSession` (`types.ts:160`) is the authoritative frozen review-input aggregate. It owns `artifactText`, `authorContext`, `frozenAt`/`artifactHash`/`authorContextHash`, `findings`, `semanticIssues`, `adjudications`, `revisionActions` — each of the latter four a `Record<string, X>` keyed by the record's own `id`.
2. `artifactHash = sha256Text(session.artifactText)` (`hash.ts:5`) — exact raw-text identity, whitespace-sensitive.
3. `authorContextHash = sha256AuthorContext(session.authorContext)` (`hash.ts:29`) hashes each `AuthorContextItem`'s `id`, `text`, `sourceType`, `status`, `createdAt` — **record identity, not merely semantic content.** Two `AuthorContext`s with identical prose but freshly generated item ids/timestamps hash differently. This is a hard fact this document must not contradict anywhere it discusses successor `AuthorContext`.
4. `RevisionAction` (`types.ts:137`) is revision *intent / lifecycle* authority — `PLANNED → IMPLEMENTED | REJECTED`, enforced one-way and terminal by `setRevisionStatus` (`session.ts:363`, guard: `existing.status !== 'PLANNED'` throws). It is **not** artifact-version authority; it never references a successor document.
5. `HumanAdjudication.actionChange === 'YES'` (`types.ts:110`) is the current human-authorization gate that `planRevisionAction` (`session.ts:308`) requires before a `RevisionAction` may even be created.
6. `DeliberationState` (`deliberation.ts:583`) is a **separate aggregate** from `StressTestSession`, owning deliberation-execution facts: `history`, `attempts`, `outcomes`, `questionDispositions`, `contextRequests`, `sessionVersionLineages`, `evidenceSubjects`, budgets, `unresolvedQuestions`, `stopReason`.
7. `IntegratedDecisionReport` (P1, `decision-record.ts`) is a validated read-only projection over both aggregates. It creates no semantic authority of its own.
8. No exported helper in this repository performs artifact-content comparison, text diffing, or successor-artifact resolution of any kind. This authority does not exist yet anywhere in the codebase.

---

## 3. Why `SessionVersionLineage` is not reusable as-is

`SessionVersionLineage` (`deliberation.ts:3005`) and its sole producer, `createCrossSessionTransition` (`deliberation.ts:3450`), were inspected directly. Three facts make reuse incorrect, not merely inconvenient:

- **Its precondition is the opposite of a revision.** `createCrossSessionTransition` throws unless `childArtifactHash === parentArtifactHash` (`deliberation.ts:3548`). It exists to carry a supplied `ADD_CONTEXT` answer into a new session while the artifact text stays byte-identical. A revision successor is defined by the artifact text *changing*. Reusing this type for a changed artifact would either silently violate its own enforced invariant or require weakening an invariant that a different, accepted slice (2C, via `ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md`) already froze for a different purpose.
- **Its authority owner is wrong.** `sessionVersionLineages` lives on `DeliberationState`, addressed via `originatingQuestionId` / `suppliedOutcomeAttemptId` / `contextRequestId` — every field ties it to one specific deliberation route attempt. A `RevisionAction` has no `attemptId`; it is a product/session fact, not a deliberation-execution fact (repository fact #4 above).
- **Its cardinality rule doesn't fit.** One `SUPPLIED` outcome produces at most one lineage (`deliberation.ts:3503-3506`), which is a deliberation-route constraint, not a statement about how many times a source session may be revised.

Nothing here amends `SessionVersionLineage`, `createCrossSessionTransition`, or their CROSS_SESSION semantics. They remain exactly as accepted. `RevisionSuccessorBinding` (below) is a new, structurally distinct concept precisely because this one does not fit.

Its one reusable precedent (kept deliberately, see §7): the pattern for constructing a derived session's `AuthorContext` — copy each item's `text`/`sourceType`/`status`, assign each item a fresh `id`/`createdAt` via the existing `addAuthorContextItem` API (`deliberation.ts:3519-3528`).

---

## 4. Frozen authority owner

**Decision A — Option A: the source `StressTestSession` owns the binding**, as a new singleton field:

```ts
revisionSuccessor: RevisionSuccessorBinding | null;
```

Justification:

- `RevisionAction` already lives on `StressTestSession` (repository fact #4). `RevisionSuccessorBinding` is the next fact in the same product lifecycle (*"we said we'd revise it" → "here is what we revised it into"*) — not a deliberation-execution fact, so `DeliberationState` (Option C) is the wrong aggregate for the same reason given in §3.
- Standing rule: do not create a third aggregate for one singleton fact unless correctness requires it. No inspected invariant in §7–§9 requires a `RevisionSuccessorBinding` to be independently addressable, queryable, or to exist without an owning session — a plain nullable field satisfies every requirement below. Option B (new ledger aggregate) is therefore rejected as unnecessary generality (§28 filter, category C).
- This keeps the binding subject to the same frozen-input-integrity discipline every other `StressTestSession` field already has (`verifyFrozenInputIntegrity`), with no new verification machinery.

---

## 5. Frozen `RevisionSuccessorBinding` schema

**Decision B — Option A: exact-session successor**, not artifact-only:

```ts
export interface RevisionSuccessorBinding {
  sourceSessionId: string;
  sourceArtifactHash: string;
  sourceAuthorContextHash: string;
  successorSessionId: string;
  successorArtifactHash: string;
  successorAuthorContextHash: string;
  createdAt: string;
}
```

Justification: `StressTestSession` identity is the triple (`id`, frozen `artifactHash`, frozen `authorContextHash`) — this is already the exact precedent `SessionVersionLineage` itself uses for its own parent/child pair (`deliberation.ts:3006-3012`: `parentSessionId` + `parentArtifactHash` + `parentAuthorContextHash` + the child equivalents). Storing all six fields directly on the binding — rather than only `successorSessionId` and re-deriving hashes by dereferencing the successor session every time — is what makes write-boundary (§13) and later-read (§14) integrity checks self-contained: both can compare the binding's own stored hashes against whichever session object the caller supplies, without needing a cross-aggregate lookup that does not otherwise exist (`StressTestSession` and `DeliberationState` are separate aggregates with no shared registry, repository fact #6). Correctness, not field count, is why all six fields are kept. No `lineageId`/binding `id` field is added: the binding's address *is* "the field on this source session" (0..1 cardinality, §12); nothing in this document needs to reference the binding independent of its owning session.

---

## 6. Successor creation semantics

New architecture-level operation (signature only, no implementation):

```ts
createRevisionSuccessorSession(
  sourceSession: StressTestSession,
  revisedArtifactText: string
): { sourceSession: StressTestSession; successorSession: StressTestSession }
```

Frozen behavior, in order:

1. `verifyFrozenInputIntegrity(sourceSession)` — source frozen integrity.
2. `sourceSession` must be frozen-or-later (mirrors `assertFrozenOrLater`).
3. `sourceSession.revisionSuccessor === null` — reject a second direct successor (Decision E, §12).
4. `sourceSession` must satisfy the successor-creation precondition (Decision D, §12): at least one `RevisionAction` with `status === 'IMPLEMENTED'`.
5. `revisedArtifactText` must be a non-empty string (mirrors `createSession`'s own guard).
6. Construct a wholly new `StressTestSession` via the existing `createSession(revisedArtifactText)` — never a copy-then-mutate of the source (same non-negotiable already stated for `createCrossSessionTransition`, `deliberation.ts:3515-3518`).
7. Populate the new session's `AuthorContext` per §7 below, then `freezeInput` it, then `verifyFrozenInputIntegrity` it.
8. Require `successorSession.id !== sourceSession.id` (true by construction; stated explicitly as a checked invariant, not merely assumed).
9. Require `successorSession.artifactHash !== sourceSession.artifactHash` — the successor must be a genuinely changed artifact snapshot (§14; whitespace-only changes satisfy this, see §16.G).
10. Build the `RevisionSuccessorBinding` from the now-frozen hashes of both sessions and attach it to the returned `sourceSession` (a new value; the input `sourceSession` object is never mutated in place, consistent with every other function in `session.ts`).
11. Return `{ sourceSession, successorSession }` atomically — on any failure above, nothing is returned and nothing is persisted (mirrors `createCrossSessionTransition`'s all-or-nothing bundle contract).
12. Do **not** mark any `RevisionAction` as verified.
13. Do **not** create a `CROSS_SESSION` `QuestionDisposition`.
14. Do **not** modify `sessionVersionLineages` in any `DeliberationState`.

---

## 7. Successor `AuthorContext` semantics

**Decision C — Option B: semantic copy**, mirroring the exact, already-accepted precedent in `createCrossSessionTransition` (`deliberation.ts:3519-3528`): for each category, for each existing item, copy `text` / `sourceType` / `status` and let `addAuthorContextItem` assign a fresh `id` and `createdAt`.

Justification against the other options:

- **Option A (empty)** discards provenance continuity — a later human reviewing V1 would see none of the confirmed facts, known risks, open questions, or constraints that were live when the issue was raised. Rejected.
- **Option C (exact record copy)** is not actually achievable without corrupting the codebase's existing identity discipline: `AuthorContextItem.id`/`createdAt` are creation-event identity fields (repository fact #3), and every other place in this codebase that derives a new session's context already mints fresh ids/timestamps rather than reusing the parent's. Forcing identical ids across two independently frozen sessions would break the invariant that an item's `id`/`createdAt` reflects when it was actually created in *that* session's record — and it would not even produce a matching `authorContextHash`, since the hash also depends on which session's context is being hashed. There is no way to make `successorAuthorContextHash === sourceAuthorContextHash` short of the successor having *zero* new information, so this option collapses to Option B with extra risk and no benefit. Rejected.
- **Option D (caller-supplied)** is explicitly discouraged unless required; nothing here requires it, and it would introduce a second, divergent policy for how a derived session's context gets built next to the one `createCrossSessionTransition` already established. Rejected.

**Explicit non-claim:** `successorAuthorContextHash` is never expected or required to equal `sourceAuthorContextHash`, and no code path may treat hash equality here as proof of semantic equality (repository fact #3). This binding relates sessions by identity, not by author-context content.

---

## 8. Frozen `RevisionVerification` schema

```ts
export type RevisionVerificationVerdict = 'VERIFIED_PRESENT' | 'NOT_PRESENT' | 'INCONCLUSIVE';

export interface RevisionVerification {
  id: string;
  revisionActionId: string;
  verdict: RevisionVerificationVerdict;
  evidence: string;
  verifiedAt: string;
}
```

Owned by the source `StressTestSession` (Decision, §20 below) as:

```ts
revisionVerifications: Record<string, RevisionVerification>;
```

keyed by the record's own `id` — identical pattern to `findings`, `semanticIssues`, `adjudications`, `revisionActions`. `revisionActionId` is a field, not the map key, consistent with how `HumanAdjudication.semanticIssueId`/`findingId` are fields on records keyed by their own `id` rather than by the thing they reference.

No `successorSessionId`, `successorArtifactHash`, `semanticIssueId`, `findingId`, or `sourceSessionId` field is duplicated onto this record — every one of those is authoritatively derivable (§15) through `revisionActionId → sourceSession.revisionActions[...]` and `sourceSession.revisionSuccessor`, and duplicating them would create exactly the "adjacent records merely agreeing with each other" risk §24/§14 (of the packet) explicitly warns against. No `verifiedBy`/actor field is added: no user/actor identity system exists anywhere in this codebase today (`HumanAdjudication` itself has no such field — `types.ts:110-118`), and adding one here would be new general-purpose infrastructure this slice does not need (§28 filter, category C).

---

## 9. Verdict semantics

Closed, three-value vocabulary (packet-specified, frozen as-is — no repository evidence contradicts it):

- **`VERIFIED_PRESENT`** — the verification authority has sufficient evidence that the requested `RevisionAction` is reflected in the authoritative successor artifact.
- **`NOT_PRESENT`** — the authoritative successor artifact was inspected and the requested `RevisionAction` is not reflected sufficiently to count as implemented there.
- **`INCONCLUSIVE`** — the authoritative successor artifact exists, but available verification evidence is insufficient to defensibly determine presence/absence.

**No verification record is a fourth, distinct state — absence of fact.** It is never encoded as `INCONCLUSIVE` or `NOT_PRESENT`; it is simply the absence of any entry in `revisionVerifications` keyed to that `revisionActionId` (§16.A, §26).

---

## 10. Human authority model

**Decision — Option C: machine-assisted, human-confirmed at the domain boundary.**

The domain operation `recordRevisionVerification` (below) never computes a verdict from artifact content itself — `verdict` and `evidence` are always caller-supplied input, never derived by comparing `sourceSession.artifactText` against `successorSession.artifactText`. This rules out Option B (machine as silent final authority) categorically: there is no code path by which an automated comparison alone produces a stored `RevisionVerification`. It is stricter than Option A (pure human-recorded) only in name: the domain function is a **human-confirmation recorder**, exactly mirroring how `HumanAdjudication.judgment` is already caller-supplied and never derived (`types.ts:110-118`, unchanged precedent). A machine-assisted proposal (an LLM or tool suggesting a verdict) may exist entirely outside this function, upstream, as caller-side assistance — but it must pass through the same human-confirmed call this contract freezes, identical to how a reviewer's finding never becomes a `RevisionAction` without passing through `HumanAdjudication.actionChange = YES` (§28.31 of the accepted route-outcome contract's spirit, restated here for the product layer). No diff/comparison engine is built or required by this contract (§19 of the packet).

---

## 11. Evidence requirements

`evidence: string` — a single, bounded, non-empty free-text field, mirroring `HumanAdjudication.note`'s existing precedent (`types.ts:116`) rather than inventing a new structured shape.

Considered and rejected as over-general for first pilot (§28 filter, category C): a structured `{ artifactLocation, beforeExcerpt, afterExcerpt }` object, a generic patch/diff record, an AST-diff record, a full-document diff store. None is required to satisfy the actual bar — "sufficient for a later human to understand why the verdict was recorded" (packet §19) — which a well-written free-text note (e.g. quoting the relevant successor excerpt and stating what changed) already satisfies, exactly as `HumanAdjudication.note` already does for adjudication today.

Structural validation only: `evidence` must be a non-empty, non-whitespace-only string (same shape of check as `assertNonEmptyMaterialityReason` already used elsewhere in this codebase, `deliberation.ts:608-611`). No length ceiling is frozen here; if abuse becomes a real problem post-pilot, that is a bounded follow-up, not a blocking decision now.

---

## 12. Cardinality

- **`SourceSession → RevisionSuccessorBinding`: 0..1.** Enforced structurally — the field is a single nullable value, not a collection. A second creation attempt is **rejected** (§16.J), not queued or superseded (Decision E — Option A, ONE-SHOT first pilot; Option B, corrective versioning, is explicitly out of scope — see §18).
- **`SuccessorSession → revision source`: exactly 1, by construction, not by a stored field.** The successor is always a brand-new session minted inside `createRevisionSuccessorSession` itself (§6, step 6) — it is never an existing session repurposed as a successor, so it is structurally impossible for one successor session to have two sources. No back-reference field is added to `StressTestSession` for this; nothing in §13–§14 needs to traverse successor→source, only source→successor.
- **`RevisionAction → RevisionVerification`: 0..1.** This is not an arbitrary restriction — it is consistent with the terminal, one-way, no-overwrite discipline every other lifecycle fact in this codebase already has (`RevisionAction.status` itself is one-way and terminal per `setRevisionStatus`'s own guard, `session.ts:373-375`; `RouteOutcome`, `HumanAdjudication`, and `QuestionDisposition` are all append-only, never-mutated facts elsewhere in this system). A duplicate `recordRevisionVerification` call for the same `revisionActionId` is **rejected** (§16.K), not overwritten — no implicit last-write-wins.

---

## 13. Write-boundary integrity

**A. Creating `RevisionSuccessorBinding`** (`createRevisionSuccessorSession`) — see the full ordered checklist in §6. Restated as a flat list: source frozen integrity; source has no existing binding; source has ≥1 `IMPLEMENTED` `RevisionAction`; successor freezes cleanly; source ≠ successor; successor artifact hash ≠ source artifact hash; atomic all-or-nothing return.

**B. Recording `RevisionVerification`** (`recordRevisionVerification`) — new architecture-level operation:

```ts
recordRevisionVerification(
  sourceSession: StressTestSession,
  successorSession: StressTestSession,
  input: { revisionActionId: string; verdict: RevisionVerificationVerdict; evidence: string }
): StressTestSession
```

The caller supplies **both** sessions explicitly — never only `revisionActionId` with the successor resolved implicitly — so the domain can independently cross-check the stored binding against the actual objects presented, rather than trusting either in isolation (this is what resolves §16.E and §16.F). Frozen checklist:

1. `verifyFrozenInputIntegrity(sourceSession)` and `verifyFrozenInputIntegrity(successorSession)`.
2. `sourceSession.revisionActions[input.revisionActionId]` must exist — a `RevisionAction` id from another session is structurally absent here, not merely rejected by a cross-reference check (§16.I).
3. That `RevisionAction.status === 'IMPLEMENTED'` — the only eligible status. `PLANNED` (nothing to verify yet) and `REJECTED` (never going to be implemented) are both refused.
4. `sourceSession.revisionSuccessor !== null` — no successor, no verification target; refuse rather than fabricate a verdict (§16.A).
5. Cross-check the stored binding against the objects actually presented: `binding.sourceSessionId === sourceSession.id`, `binding.sourceArtifactHash === sourceSession.artifactHash`, `binding.sourceAuthorContextHash === sourceSession.authorContextHash`, `binding.successorSessionId === successorSession.id`, `binding.successorArtifactHash === successorSession.artifactHash`, `binding.successorAuthorContextHash === successorSession.authorContextHash`. Any mismatch refuses the write (§16.E, §16.F).
6. `input.verdict` ∈ the closed vocabulary (§9).
7. `input.evidence` is a structurally valid non-empty string (§11).
8. No existing `RevisionVerification` in `sourceSession.revisionVerifications` already has `revisionActionId === input.revisionActionId` — duplicate refused (§16.K, §12).
9. Construct and append the new `RevisionVerification`; return a new `sourceSession` value (never mutate in place).

---

## 14. Later-read integrity

Standing rule carried over unchanged from the accepted route-outcome contract's own later-read discipline: **a self-consistent downstream record is not enough.** Before any caller trusts a stored `RevisionVerification`, it must re-resolve the full chain, not merely read the record:

```
RevisionVerification
  → RevisionAction            (must exist in the same source session's revisionActions)
  → owning source session     (the caller-supplied sourceSession itself)
  → RevisionSuccessorBinding  (sourceSession.revisionSuccessor, must be non-null)
  → successor session         (the caller-supplied successorSession)
  → frozen hashes/content     (re-verified via verifyFrozenInputIntegrity + the same
                                six-field cross-check as §13.B.5)
```

Any break in this chain — a missing link, a hash mismatch, a `revisionSuccessor` that is `null` — means the stored verdict must be treated as **unverifiable in this read**, never silently displayed as if trustworthy. This is the same posture §13.B already enforces at write time, applied again at read time because a record that was valid when written is not proof it is still consistent with whatever objects a later caller supplies.

---

## 15. Historical semantics

A stored `RevisionVerification` is a historical statement about the *exact* artifact pair it was evaluated against, not a living claim. Example: `RA-1 VERIFIED_PRESENT in V1` remains true as a historical record even if, under some future architecture slice, a `V1 → V2` successor is later introduced. That later fact **never implies** `RA-1 VERIFIED_PRESENT in V2` — no transitive inference is permitted, ever, by any future reader of this record (packet §22). This document does not build V1→V2 (§12, §18) but this rule is frozen now so that if a future slice does, it inherits the constraint rather than needing to relitigate it.

`RevisionVerification` records also remain fully readable after `sourceSession.state === 'COMPLETED'`: nothing in `session.ts` gates *reads* of a session's fields by `state` — only *writes* are gated (via `assertStateIn`/`assertFrozenOrLater` patterns throughout `session.ts`). No new read restriction is introduced here (§16.L).

---

## 16. Counterexample table

| # | Scenario | Resolution |
|---|---|---|
| A | `RevisionAction` `IMPLEMENTED`, no successor exists | `recordRevisionVerification` refuses (§13.B.4) — state is **absence of a verification record**, never a fabricated verdict. |
| B | Successor exists, requested change is absent | Human/machine-assisted caller records `verdict = NOT_PRESENT` with supporting `evidence` (§9, §13.B). |
| C | Successor exists, evidence insufficient | Caller records `verdict = INCONCLUSIVE` (§9) — a real, stored terminal fact, distinct from "no record." |
| D | All `RevisionAction`s `REJECTED`, caller attempts successor creation | Refused — zero `IMPLEMENTED` actions fails the §6 step-4 precondition (Decision D). |
| E | Unrelated Session B supplied as successor | Refused at write time — `binding.successorSessionId !== sessionB.id` fails §13.B.5's cross-check. |
| F | Binding and child object agree with each other, but disagree with authoritative frozen content/hash | Refused — §13.B.5 and §14 re-derive hashes from the actual session objects via `verifyFrozenInputIntegrity`, not from the binding's own stored copy alone. |
| G | Whitespace-only artifact change | Legal successor creation — `sha256Text` is whitespace-sensitive, so `successorArtifactHash !== sourceArtifactHash` holds (§6 step 9, §14 of the packet: changed hash is successor eligibility, never verification). Whether RA-1 is actually *reflected* is still a separate, independently recorded `RevisionVerification`. |
| H | V0 has RA-1/RA-2/RA-3; V1 completes only RA-1/RA-2 | Legal — successor-creation precondition requires only ≥1 `IMPLEMENTED` action (§6 step 4, Decision D — explicitly not "all"). Each `RevisionAction` gets its own independent, optional `RevisionVerification`; RA-3 (still `PLANNED`) simply has none yet and is ineligible until implemented (§13.B.3). |
| I | `RevisionVerification` references an RA from another source session | Structurally impossible to write — §13.B.2 looks up `revisionActionId` only within the exact `sourceSession` supplied; an id from another session is simply absent there. |
| J | Second direct successor attempted for same source in one-shot mode | Refused — `sourceSession.revisionSuccessor !== null` fails §6 step 3. |
| K | Duplicate `RevisionVerification` attempted | Refused — §13.B.8's uniqueness check on `revisionActionId` within `revisionVerifications`. |
| L | Historical verification remains readable after source session is COMPLETED | Legal, unchanged — reads are never state-gated in this codebase (§15). |

---

## 17. Explicit non-goals

This document does **not**:

- implement any runtime — no type, function, or test is added to `src/**`, `test-*.mjs`, or `package.json`;
- modify `SessionVersionLineage`, `createCrossSessionTransition`, or any accepted CROSS_SESSION semantics;
- modify `RevisionAction`'s existing `PLANNED → IMPLEMENTED | REJECTED` lifecycle or its meaning;
- introduce a generic artifact/version graph, branching, merge, or "latest wins" semantics of any kind;
- introduce corrective/second-successor (`V0 → V2`) support — out of scope for first pilot (§18);
- introduce an actor/user-identity system (no `verifiedBy` field, no auth model);
- build a text-diff engine, AST-diff engine, or any automated content-comparison authority;
- introduce `READY_TO_SEND` / `FINAL` / `DELIVERY_APPROVED` / `DELIVERY_CONFIRMED` or any delivery-readiness semantics — `RevisionVerification` answers "did the change reach the successor artifact," never "may this artifact now be sent";
- authorize provider-backed execution, provider adapters, or LLM Council involvement of any kind.

---

## 18. First-pilot limitation

**Decision E — Option A: ONE-SHOT first pilot.** `V0 → V1` is the only supported direct revision-successor transition; a second direct successor for the same source session is rejected outright (§16.J), not queued.

Known, accepted consequence: if `RevisionVerification` for some `RevisionAction` comes back `NOT_PRESENT` or `INCONCLUSIVE`, there is no in-product corrective `V1 → V2` path in this slice. Resolving that is explicitly out-of-band for first pilot (e.g. a manual follow-up outside this system) and is deliberately not designed here — Option B (supporting corrective versions now) was evaluated and rejected because P2's own stated purpose is closing the smallest end-to-end value loop before pilot, not generalizing version handling before real evidence says that generalization is needed (packet §12). This is a scope limitation, not an unresolved schema question — it changes no type or field in §5/§8, so it is not listed under §20's blocking decisions.

---

## 19. Implementation slice recommendation

If/when a runtime-implementation packet is authorized for P2, the minimum correct slice is:

1. Add `revisionSuccessor: RevisionSuccessorBinding | null` and `revisionVerifications: Record<string, RevisionVerification>` to `StressTestSession` (`types.ts`), plus the `RevisionSuccessorBinding` and `RevisionVerification`/`RevisionVerificationVerdict` types (§5, §8).
2. Implement `createRevisionSuccessorSession` in `session.ts`, reusing `createSession`, `addAuthorContextItem`, `freezeInput`, `verifyFrozenInputIntegrity` exactly as `createCrossSessionTransition` already does for its own child-session construction (§6, §7).
3. Implement `recordRevisionVerification` in `session.ts`, reusing `verifyFrozenInputIntegrity` (§13.B).
4. Extend `IntegratedDecisionReport` (P1, separately authorized) to surface the six new presentation labels (§26 of this packet) once the above exists — explicitly **not** part of this slice.
5. No changes anywhere in `deliberation.ts` are implied or required by any of the above.

---

## 20. Blocking open decisions

BLOCKING OPEN DECISIONS: NONE

---

**PROFESSIONAL RECOMMENDATION:**

在授權任何執行之前，建議下一個 runtime 切片嚴格按照 §19 的順序拆成兩個獨立可驗收的子切片：先落地 `RevisionSuccessorBinding`（§5–§7），單獨跑完整測試並取得驗收；再落地 `RevisionVerification`（§8, §13.B），因為兩者的失敗模式完全不同（前者是「有沒有下一版」，後者是「下一版有沒有改對」），分開驗收能避免把兩種正交的正確性混在同一組測試斷言裡，之後除錯也更容易定位是哪一層的契約被違反。

**COUNTERINTUITIVE OBSERVATION:**

這份文件裡真正有意思的地方不是新加的兩個型別，而是「不加」的那些欄位：`RevisionVerification` 刻意不存 `successorSessionId`/`successorArtifactHash`，`RevisionSuccessorBinding` 刻意不給自己一個獨立 `id`。表面上看起來是在犧牲可查詢性換取精簡，但實際效果相反——正是因為這些欄位被拿掉、改成強制從 `sourceSession` 出發做一次性推導（§13.B.5、§14），才讓「binding 和子物件互相同意，卻與權威凍結內容不一致」（反例 F）這種最陰險的資料腐化情境，從「需要額外一致性檢查」變成「根本沒有第二個可以互相同意的獨立副本」。少存欄位，反而是這裡安全性的來源，而不是代價。
