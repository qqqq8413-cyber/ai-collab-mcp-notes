# Route Outcome & Question Lifecycle — Architecture Contract (Slice 2C)

Repository: `qqqq8413-cyber/ai-collab-mcp-notes`
Mode: offline architecture analysis only. 0 provider/model calls made in the production of this document.
Branch: `product/pre-submission-stress-test-mvp`.

This is an architecture-contract document. **It authorizes no implementation.** Slices 2A/2B established the accepted, offline routing/audit foundation — `StressTestSession → DeliberationState → UnresolvedQuestion → RouteDecision → ContextRequest` — with independently-snapshotted audit history (`src/stress-test/deliberation.ts`). That foundation answers *which route is justified next*. It does not yet answer *what happens after an authorized route is actually attempted* — success vs. failure vs. an indeterminate result, whether an outcome may close a question, how a residual deficit is represented, or how `ADD_CONTEXT`'s cross-session boundary and `STOP`'s absence of any attempt fit the same model. This document closes that gap at the architecture level only.

Source of truth used, in priority order: `src/stress-test/deliberation.ts`, `src/stress-test/session.ts`, `src/stress-test/types.ts` (accepted runtime, binding); `MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md` (Phase 2 routing contract, binding, not modified by this document); `PRODUCT_RUNTIME_RECONCILIATION.md` (Phase 1 disposition, binding, not modified); `PRE_SUBMISSION_STRESS_TEST_MVP.md` (Slice 1 domain contract, binding, not modified). No contradiction between these governing documents and the design below was found; none of them is amended here.

---

## 1. Executive decision — the core architecture question

*"What is the minimum state transition required after a planned Minimum Necessary Deliberation route is attempted, while preserving auditability, boundedness, frozen-input integrity, and human revision authority?"*

Answer: five concepts that must never collapse into one another, each a distinct, separately-recorded fact:

```
ROUTE DECISION        "this route is the justified next step"           (Slice 2A/2B, accepted, unchanged)
      ≠
ROUTE ATTEMPT          "this route was actually attempted, once"         (new, §5)
      ≠
ROUTE OUTCOME          "this is what that one attempt produced"          (new, §7)
      ≠
QUESTION DISPOSITION   "this is what the outcome implies for the         (new, §9)
                        question that motivated it"
      ≠
HUMAN ADJUDICATION     "a human decided what this means for the          (Slice 1, accepted, unchanged)
                        artifact"
```

`RouteDecision` already exists and is unchanged by this document. The other four concepts are defined here at the architecture level only — no type is added to `src/stress-test/**`, no function is written, and no route executes.

---

## 2. Scope / non-goals

This document does **not**:
- implement `RouteAttempt`, `RouteOutcome`, or `QuestionDisposition` runtime,
- implement provider-backed route execution of any kind (`ADD_REVIEWER` acquisition, `SEEK_EVIDENCE` retrieval, `TARGETED_PEER_CHALLENGE` calls, etc.),
- implement `StressTestSession` versioning/lineage runtime,
- modify `src/**`, `test-*.mjs`, or `package.json`,
- modify `MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md`, `PRODUCT_RUNTIME_RECONCILIATION.md`, or `PRE_SUBMISSION_STRESS_TEST_MVP.md`,
- redesign any already-accepted Slice 2A/2B invariant (root-cause → route mapping, registration/binding rules, order-sensitive provenance matching, `StopReason` allowlist, snapshot/value-semantics at API boundaries),
- decide exact reviewer ontology, provider/model selection, or numeric cost/latency ceilings,
- reopen CBRP or execute M2-B,
- weaken `HumanAdjudication.actionChange = YES → RevisionAction`.

---

## 3. Definitions (new concepts)

- **RouteAttempt** — the immutable fact that a specific `RouteDecision` has begun execution, exactly once. A start-only record, distinct from the decision itself and from any terminal result (§5).
- **AttemptStatus** — the closed, three-value technical-completion classification of one terminal `RouteAttempt`: `SUCCEEDED` | `FAILED` | `INCONCLUSIVE` (§6).
- **RouteOutcome** — the immutable, terminal, route-specific result payload (or failure information) produced by one `RouteAttempt` (§7).
- **QuestionDisposition** — a separate lifecycle record stating what a `RouteOutcome` implies for the `UnresolvedQuestion` that motivated the attempt: `RESOLVED` | `STILL_OPEN` | `SUPERSEDED_RECLASSIFIED` | `CROSS_SESSION` (§9).
- **Derived question identity** — a new `UnresolvedQuestion` created when a `QuestionDisposition` is `SUPERSEDED_RECLASSIFIED`, carrying `derivedFromQuestionId` pointing back at the question it replaces (§8).
- **SessionVersionLineage** — the conceptual lineage record (already named, unscheduled, in `MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md` §8) produced when an `ADD_CONTEXT` outcome's disposition is `CROSS_SESSION` (§13.A).
- **ReplicationResult** — the closed, three-value result vocabulary a `REPLICATE` outcome payload carries: `REPRODUCED` | `NOT_REPRODUCED` | `PARTIAL` (§13.C).
- **Open / unterminated attempt** — a `RouteAttempt` for which no terminal `RouteOutcome` has been recorded; a derived condition, never a fourth `AttemptStatus` value (§5).

None of these are added to `src/stress-test/types.ts` by this document. They are named here so later, explicitly-authorized implementation work has one non-ambiguous vocabulary to build against.

---

## 4. Binding architecture decision: RouteDecision is not execution

Restated from `MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md` §4 and `src/stress-test/deliberation.ts`'s own module docstring, and extended: `RouteDecision` records "this is the justified next route." It is not, and must never become, proof that a provider call happened, retrieval happened, a human answered, the route succeeded, the question changed, or the question was resolved. Every one of those facts — if it ever exists — is recorded by a `RouteAttempt`/`RouteOutcome`/`QuestionDisposition`, never folded backward into the `RouteDecision` that merely justified attempting the route.

`STOP` is the one route with no attempt at all (§5, §13.F) — it remains exactly `RouteDecision(route=STOP)` + `StopReason`, as already implemented.

---

## 5. RouteAttempt — identity, binding, and lifecycle

**Binding decision: `RouteAttempt` is the start fact, not the terminal fact.** `RouteAttempt` is the immutable record that one authorized `RouteDecision` has begun execution. It is recorded **before** the external/human mechanism begins — before a provider call is sent, before a human is asked, before a retrieval request is issued — precisely so that a process/provider/retrieval-layer crash after execution starts still leaves an auditable proof that the attempt was begun.

`RouteAttempt` owns, at minimum:

| Field | Requirement |
|---|---|
| `attemptId` | Required, unique. |
| `decisionId` | Required. Must reference an existing, previously-recorded `RouteDecision`. |
| `questionId` | Required for every non-`STOP` route; must exactly equal the referenced `RouteDecision.questionId`. Never independently supplied. |
| `route` | Required; must exactly equal the referenced `RouteDecision.route`. Never inferred, never re-derived from `rootCause` independently of the decision it attempts. |
| `sessionId` | Required; must match the current `DeliberationState.sessionId`. |
| `artifactHash` / `authorContextHash` | Required; must match the current `DeliberationState`'s bound frozen hashes. |
| `startedAt` | Required, recorded at the moment the attempt begins. |

`RouteAttempt` must **not** require `completedAt`, a terminal `AttemptStatus`, or a terminal route result — those belong exclusively to `RouteOutcome` (§7). `RouteAttempt` is never later mutated from a "started" shape into a "completed" shape; it remains, permanently, a start-only record:

```
RouteAttempt(start)  ->  RouteOutcome(terminal)         [correct model]

mutable RouteAttempt(start -> completed)                [rejected]
```

Binding rules, all fail-closed, mirroring the pattern `verifyDeliberationBinding`/`recordRouteDecision` already enforce today (`src/stress-test/deliberation.ts`):
- No free-floating attempt: every `RouteAttempt` must reference an existing `RouteDecision`; an attempt naming an unknown `decisionId` cannot exist.
- No inferred route identity: `route` is copied from, and checked against, the referenced decision — never re-derived, never guessed.
- No cross-session reuse: an attempt's `sessionId`/hashes must match the `DeliberationState` currently acting, exactly like every existing Slice 2A/2B binding check; an attempt bound to Session A's hashes can never be recorded against Session B's `DeliberationState`.
- **For `STOP`: there is no `RouteAttempt`.** `STOP` has no provider/execution step to attempt; its audit representation stays `RouteDecision(route=STOP)` + `StopReason`, unchanged.

### Open / unterminated attempt

Because a `RouteAttempt` is written before execution, it is possible for a `RouteAttempt` to exist with no corresponding `RouteOutcome` — execution began but no terminal result was defensibly recorded. This is **not** a fourth `AttemptStatus` value: no `UNKNOWN`, `ABANDONED`, or `CRASHED` status is introduced at this architecture stage. It is instead a condition *derived* purely from the absence of a terminal `RouteOutcome` for a given `attemptId` — an **open / unterminated attempt**.

Binding rules:
- It remains an auditable fact; it must never be silently deleted.
- It must never be treated as `SUCCEEDED`.
- It must never be treated as `FAILED` unless a valid `FAILED` `RouteOutcome` is explicitly recorded for it.
- Another `RouteAttempt` for the same `RouteDecision` remains forbidden while its predecessor is open — the one-attempt-per-decision cardinality (§19) holds whether or not the existing attempt has terminated.
- No automatic retry. A future recovery policy may issue a **new** `RouteDecision` only through an explicitly authorized, fail-closed recovery path. That recovery runtime is not designed by this document.

---

## 6. Attempt status model

Closed, three-value vocabulary: `SUCCEEDED` | `FAILED` | `INCONCLUSIVE`.

**`FAILED`** — the route mechanism itself could not produce any structurally valid result: a provider/transport failure, a retrieval failure, or output that fails runtime validation. The mechanism did not complete as intended.

**`INCONCLUSIVE`** — the route mechanism completed without technical failure, but its own designed result vocabulary includes an explicit indeterminate/insufficient category, and that is what it returned (for example, `SEEK_EVIDENCE`'s evidence-lookup result explicitly supports a "partial / inconclusive" value, §13.D). The mechanism worked; the specific answer it produced is, by the mechanism's own design, indeterminate.

**`SUCCEEDED`** — the route mechanism completed and produced a complete, structurally valid, *determinate* categorical result — even when that result is substantively unhelpful for resolving the underlying question. A replication that reproduces the finding, a peer-challenge response that maintains disagreement, a reviewer pass that finds nothing material: all `SUCCEEDED`. None of these facts says anything about whether the question is now resolved (§10) — that is a disposition question, never an attempt-status question.

**The precise boundary** (resolving the distinction the governing packet asked to be defined precisely): a route's own result vocabulary decides whether `INCONCLUSIVE` is even reachable for it. A vocabulary built entirely from determinate categories (`ADD_REVIEWER`'s "found N findings, possibly zero"; `REPLICATE`'s `REPRODUCED`/`NOT_REPRODUCED`/`PARTIAL`; `TARGETED_PEER_CHALLENGE`'s rebuttal/concession/qualification/refusal-to-yield) never produces `INCONCLUSIVE` — every one of its possible answers is `SUCCEEDED` or `FAILED`, never in between. A vocabulary that itself defines an indeterminate category (`SEEK_EVIDENCE`'s "partial/inconclusive evidence") produces `INCONCLUSIVE` exactly when that category is what came back. `INCONCLUSIVE` must never be redefined per-route as "didn't resolve the question" — that would silently duplicate `QuestionDisposition.STILL_OPEN` at the attempt layer and destroy the separation this contract requires (§10).

Not every route needs all three values. `ADD_CONTEXT` and `STOP` are handled separately (§13.A, §13.F) since neither is a provider/model route.

### Per-route AttemptStatus allowlist (binding)

Previously advisory (Slice 2C's Engineering Lead recommendation); **accepted here as a binding architecture requirement.** Which `AttemptStatus` values a route's `RouteOutcome` may legally carry is fixed per route, not left to per-implementation convention:

| Route | Allowed `AttemptStatus` values |
|---|---|
| `ADD_CONTEXT` | `SUCCEEDED`, `FAILED` |
| `ADD_REVIEWER` | `SUCCEEDED`, `FAILED` |
| `REPLICATE` | `SUCCEEDED`, `FAILED` |
| `SEEK_EVIDENCE` | `SUCCEEDED`, `INCONCLUSIVE`, `FAILED` |
| `TARGETED_PEER_CHALLENGE` | `SUCCEEDED`, `FAILED` |
| `STOP` | — no `RouteAttempt`, no `AttemptStatus` |

`INCONCLUSIVE` is never a generic synonym for "the question remained unresolved" — only a route whose own result vocabulary contains an explicit indeterminate category may ever produce it; today, that is `SEEK_EVIDENCE` alone. Resolving the three cases the governing packet named explicitly:
- `REPLICATE` result `PARTIAL` → `AttemptStatus = SUCCEEDED`, because `PARTIAL` is a determinate `ReplicationResult` category, not an indeterminate one.
- `TARGETED_PEER_CHALLENGE` refusal-to-yield → `AttemptStatus = SUCCEEDED`, because the mechanism successfully produced a determinate response.
- `ADD_REVIEWER` returning zero material findings → `AttemptStatus = SUCCEEDED`, because zero findings is itself a valid, determinate reviewer result.

`QuestionDisposition` (§9) — never `AttemptStatus` — decides whether the *question* remains open.

---

## 7. RouteOutcome contract

**Binding decision: `RouteOutcome` is the terminal fact, not `RouteAttempt`.** `RouteOutcome` is the immutable terminal record for exactly one `RouteAttempt`. Recording a `RouteOutcome` is what makes that `RouteAttempt` terminal — `RouteOutcome` is a wholly separate record, never an update to the `RouteAttempt` it terminates (§5).

Every `RouteOutcome` binds to:
- `attemptId`, `decisionId`, `originatingQuestionId`, `sessionId`, `artifactHash`, `authorContextHash`, `route`,
- `completedAt` (the outcome timestamp),
- `status` — one of `AttemptStatus` (§6), subject to the per-route allowlist (§6),
- logical cost consumed / accounted (§12),
- latency consumed (§12),
- a route-specific result payload (§13) or failure information (when `status = FAILED`).

`RouteOutcome` must **not**:
- directly mutate `StressTestSession`,
- directly set `HumanAdjudication`,
- set `actionChange`,
- authorize a `RevisionAction`,
- silently rewrite `ReviewFinding`,
- silently rewrite `SemanticIssue`,
- silently rewrite the original `UnresolvedQuestion`.

`RouteOutcome` is evidence/audit input to re-evaluation (§14) — never itself the fact that a question is resolved (§9, §10).

### Schema freeze (Slice 2D-B0)

The remainder of this section freezes `RouteOutcome`'s exact conceptual envelope and every route-specific payload, so a future implementation phase has one unambiguous schema to build against rather than open questions. Nothing below is implemented; no `src/**` type, function, or test is added by this freeze.

#### Identity: no separate `outcomeId`

`RouteOutcome` does **not** get its own `outcomeId`. `attemptId` is sufficient identity: invariant 10 (§20) already fixes `ONE RouteAttempt -> AT MOST ONE terminal RouteOutcome`, so `attemptId` uniquely identifies both the attempt and the (at most one) outcome that terminates it. A second, redundant identity field would duplicate that cardinality guarantee rather than add one.

#### Generic envelope — derived vs. supplied vs. generated

| Field | Source |
|---|---|
| `attemptId` | Caller-supplied — identifies which existing, still-open `RouteAttempt` this outcome terminates. Resolved only against `deliberationState.attempts`; an unknown `attemptId` is rejected (no free-floating outcome, mirroring `recordRouteAttemptStart`'s own `decisionId` resolution rule). |
| `decisionId`, `originatingQuestionId`, `route` | Derived/copied from the resolved `RouteAttempt`. Never independently caller-supplied — a caller can never restate these inconsistently with the attempt they claim to terminate; any mismatch is rejected. |
| `sessionId`, `artifactHash`, `authorContextHash` | Derived/copied from the resolved `RouteAttempt`, and re-verified against the current `DeliberationState` binding before the outcome is recorded (fail-closed, mirroring `recordRouteAttemptStart`'s own re-check, §5). |
| `completedAt` | **Runtime-generated at record time.** Never a caller-supplied timestamp — an arbitrary caller timestamp would let a delayed or replayed recording claim a false completion time. Clarified further below: this is the time the runtime defensibly *recorded* the outcome, not necessarily a provider's own server-side completion timestamp. |
| `status` (`AttemptStatus`) | Caller-supplied — this is the one fact only the external mechanism can know. Validated against the per-route allowlist (§6) and against result/status consistency (below). |
| `logicalCost` | **Not accepted as caller input at all.** Always derived/copied from the resolved `RouteAttempt.logicalCost` onto the outcome's own record — see "Logical cost is never re-charged," below. |
| `latencyConsumed` | Caller-supplied/measured — the one other fact only knowable at completion. See "Latency," below. |
| Route-specific result payload OR `FailureInfo` | Caller-supplied, structurally validated per the frozen per-route schemas below and required to be consistent with `status`. |

Restated plainly (Slice 2D-B0 amendment): **caller supplies** `attemptId`, `status`, `latencyConsumed`, and the route-specific payload or `FailureInfo`. **Runtime derives** (from the resolved `RouteAttempt`, never from the caller) `decisionId`, `originatingQuestionId`, `route`, `sessionId`, `artifactHash`, `authorContextHash`, and `logicalCost`. **Runtime generates** `completedAt`. There is no "caller supplies `logicalCost` and a mismatch is rejected" path — `logicalCost` is not caller input in the first place.

#### Logical cost is never re-charged

`RouteAttempt` already owns `logicalCost`, and that cost was already accounted **at attempt start** (Slice 2D-A, `recordRouteAttemptStart` -> `applyCostSpend`, already implemented and shipped). `RouteOutcome.logicalCost` is a **copied audit mirror** of `RouteAttempt.logicalCost` for the same `attemptId`, written by the runtime onto the recorded outcome — the caller does not supply it, has no way to supply a conflicting value, and there is nothing to validate a mismatch against. **Recording a `RouteOutcome` must never call `applyCostSpend()` again for the same attempt** — there is exactly one cost charge per attempt, made at start, full stop. This also resolves an ambiguity in §12's `FAILED`/`INCONCLUSIVE`-attempts-still-consume-cost language: that cost was already consumed at attempt start, before the outcome existed; recording the outcome does not spend it a second time.

#### Latency

`latencyConsumed` must be finite, numeric, `>= 0`, and measured/supplied at terminalization — never fabricated for an attempt that never completed (§5, §12, open/unterminated attempts). It is accounted **exactly once**, through the latency budget, at the moment the outcome is recorded. Exceeding the latency ceiling fails closed: no outcome is recorded if its latency cannot be accounted under the existing finite ceiling — mirroring exactly how `applyCostSpend` already fails closed on the cost ceiling today. Latency is never accounted at attempt start (§12): there is nothing to measure yet.

#### `completedAt` semantics (clarified)

`completedAt` is the time the terminal `RouteOutcome` is **defensibly recorded by the runtime** — not necessarily a provider's own server-side completion timestamp, and not necessarily the exact instant external execution actually finished. This distinction is deliberate: this domain layer has no channel for an authoritative provider-side completion time, and inventing one would overstate the precision of what the audit record actually knows. Runtime-generated at record time remains the accepted rule; this clarification narrows what that timestamp is understood to mean, not when it is generated.

#### `FailureInfo` — generic, provider-neutral failure payload

```
FailureCategory =
  | 'TRANSPORT'              -- the call/request itself could not complete
  | 'VALIDATION'              -- the mechanism returned output, but it fails
                                structural/runtime validation
  | 'REFERENCE_RESOLUTION'    -- a required domain reference could not be
                                resolved (mirrors validateRouteInputRef's
                                existing fail-closed posture)
  | 'EXECUTION'               -- the mechanism ran and reached a terminal
                                state but could not complete its designed
                                function, for a reason not covered above

FailureInfo (conceptual):
{
  category: FailureCategory,
  message: string,   -- sanitized, bounded prose; a human-readable
                         explanation, never a raw SDK error object, stack
                         trace, request header, API key, or other secret
}
```

Each category is justified by an existing named failure mode in the already-accepted fallback table (`MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md` §13): route-planning/reference failures -> `REFERENCE_RESOLUTION`; acquisition/retrieval/challenge-call failures -> `TRANSPORT` or `EXECUTION` depending on whether the call itself failed or ran to an unusable end; malformed mechanism output -> `VALIDATION`. `FailureCategory` is a closed runtime allowlist, mirroring the existing `StopReason`/`RootCauseCategory` pattern — no arbitrary string is accepted. **`status = FAILED` requires a `FailureInfo`; every other status forbids one** — a non-`FAILED` outcome carrying failure information, or a `FAILED` outcome missing it, is structurally invalid.

#### Status / result consistency (binding)

| Route | Result value | Required `AttemptStatus` |
|---|---|---|
| `ADD_CONTEXT` | `SUPPLIED` / `DECLINED` / `NO_RESPONSE` | `SUCCEEDED` |
| `ADD_REVIEWER` | finding batch (`findingIds`, possibly empty) | `SUCCEEDED` |
| `REPLICATE` | `REPRODUCED` / `NOT_REPRODUCED` / `PARTIAL` | `SUCCEEDED` |
| `SEEK_EVIDENCE` | `SUPPORTIVE` / `CONTRADICTORY` | `SUCCEEDED` |
| `SEEK_EVIDENCE` | `INCONCLUSIVE` | `INCONCLUSIVE` |
| `TARGETED_PEER_CHALLENGE` | `REBUTTAL` / `CONCESSION` / `QUALIFICATION` / `REFUSAL_TO_YIELD` | `SUCCEEDED` |
| any route | — (failure) | `FAILED` (`FailureInfo` required, no result payload) |

A `RouteOutcome`'s `status` must exactly equal the value this table specifies for its result; any other pairing is a structural inconsistency and must be rejected, never silently coerced. Concretely, both examples the governing packet named are invalid: `SEEK_EVIDENCE` with `result: INCONCLUSIVE` paired with `status: SUCCEEDED` — invalid, `INCONCLUSIVE` is the one result this table maps to `AttemptStatus.INCONCLUSIVE`. `REPLICATE` with `result: PARTIAL` paired with `status: INCONCLUSIVE` — invalid, `PARTIAL` is a determinate `ReplicationResult` category (§6, §13.C) and maps only to `SUCCEEDED`; `REPLICATE` never produces `INCONCLUSIVE` at all (§6's per-route allowlist).

#### A. `ADD_CONTEXT` payload

```
AddContextResult = 'SUPPLIED' | 'DECLINED' | 'NO_RESPONSE'

SUPPLIED:     { result: 'SUPPLIED', responseText: string }   -- responseText non-empty
DECLINED:     { result: 'DECLINED' }                          -- no responseText field
NO_RESPONSE:  { result: 'NO_RESPONSE' }                        -- no responseText field
```

All three map to `AttemptStatus = SUCCEEDED` (§6's allowlist) — asking a human and recording what happened completes determinately in every case, *once a value is legitimately terminalizable at all* (see runtime readiness, below). A genuine delivery/mechanism failure (the request itself could not be presented) is the one path to `status = FAILED` + `FailureInfo` (typically `TRANSPORT`).

Recording this outcome does **not** mutate `AuthorContext`, does **not** create a new `StressTestSession`, and does **not** implement any lineage record — it is an outcome fact only. A later, separately-authorized session-version runtime may consume `responseText` through explicit provenance (the `ContextRequest` this outcome terminates); that consumption is not designed or authorized here.

##### Runtime readiness (Slice 2D-B0 amendment)

The three-value `AddContextResult` enum stays as the conceptual lifecycle vocabulary, but the three values are **not equally ready for a future RouteOutcome runtime**:

| Result | Runtime readiness |
|---|---|
| `SUPPLIED` | READY |
| `DECLINED` | READY |
| `NO_RESPONSE` | **NOT READY** |

`SUPPLIED` and `DECLINED` are both *positive, human-initiated* facts — a human actively responded, one way or the other, and that fact can be terminalized the moment it happens. `NO_RESPONSE` is different in kind: it is a claim about an *absence* over some span of time, and no accepted architecture in this repository currently defines a response deadline, a response window, a waiting period, or any explicit human-request-closure event. Without one of those, nothing tells the runtime *when* "no response" becomes a defensible terminal fact rather than merely "not yet." A caller must never be able to declare `NO_RESPONSE` arbitrarily — that would let a caller terminalize an `ADD_CONTEXT` attempt as "no response" the instant after asking, which is not a defensible audit fact.

**First-runtime subset, until response-window architecture is separately frozen:** a future first `RouteOutcome` implementation for `ADD_CONTEXT` may support `SUPPLIED -> SUCCEEDED`, `DECLINED -> SUCCEEDED`, and `FAILED -> FailureInfo`. It must **not** support `NO_RESPONSE`. The conceptual enum retains `NO_RESPONSE` as a future lifecycle state; runtime support for it remains explicitly **NOT AUTHORIZED / BLOCKED BY RESPONSE-WINDOW POLICY**. No timeout duration is invented by this amendment.

**Future `NO_RESPONSE` requirement (open architecture dependency, §24):** before `NO_RESPONSE` runtime can be authorized, architecture must define one defensible closure mechanism — for example, a `responseDeadlineAt` bound to the `ContextRequest`, or an explicit, externally recorded request-window-close event. This document does **not** choose between those two mechanisms now, and does **not** add a deadline field to any runtime type — existing source-of-truth does not yet clearly dictate one over the other. This is marked as a future architecture dependency, not resolved here.

#### B. `ADD_REVIEWER` payload

```
{ reviewerRunId: string, findingIds: string[] }
```

**Binding identity decision (Slice 2D-B0 amendment): `reviewerRunId` and `attemptId` are separate identities, never made equal.** `RouteAttempt.attemptId` is the Minimum Necessary Deliberation execution-attempt identity; `ReviewFinding.reviewerRunId` is the reviewer/acquisition-run identity that produced one batch of findings. The prior version of this schema froze `reviewerRunId === attemptId` as a convention; GPT reviewed and rejected identity equality between two different domain concepts, while accepting the underlying provenance goal. That convention is removed. The two identities may correspond one-to-one for a given `ADD_REVIEWER` outcome, but they are not, and must never become, the same identifier.

Requirements:
- `reviewerRunId` **must** be a non-empty string.
- `findingIds` **may be empty** — a reviewer pass that finds nothing material is still `SUCCEEDED` (§13.B).
- Every `findingId` **must** resolve in `StressTestSession.findings` — the same fail-closed resolution `validateRouteInputRef` already applies to a `FINDING`-kind `RouteInputRef`.
- Every referenced finding's `reviewerRunId` **must** equal the payload's own `reviewerRunId` — internal batch consistency.
- Every referenced finding's `createdAt` **must** be `>= RouteAttempt.startedAt` — required, not merely recommended (corrected from the prior version, which treated this as optional hardening).
- `findingIds` uses snapshot/value semantics like every other array this contract defines (§7, "Snapshot / value semantics," below).

The `RouteOutcome` itself is what establishes the audit lineage — `attemptId -> reviewerRunId -> findingIds` — recorded together, at the same moment, on the same immutable record. No equality between `attemptId` and `reviewerRunId` is needed to make that lineage provable: the lineage is the fact that this one outcome record names both identities side by side.

**`reviewerRunId` reuse is prohibited.** One `reviewerRunId` may be claimed by **at most one** successful `ADD_REVIEWER` `RouteOutcome` within the same `StressTestSession` lineage. A second `ADD_REVIEWER` `RouteOutcome` attempting to claim a `reviewerRunId` already claimed by an earlier successful outcome is rejected outright. This is a structural check — the runtime must track which `reviewerRunId` values a session's prior successful `ADD_REVIEWER` outcomes have already claimed — never inferred from timestamp ordering alone; a later `createdAt` does not by itself prove a `reviewerRunId` is being used for the first time. This prevents one historical reviewer batch from being silently reused as if it were a later attempt's own output.

**Implementation-sequencing scope note (Slice 2D-B0 final amendment):** "the same `StressTestSession` lineage" is the invariant's full, intended scope, but `SessionVersionLineage` runtime (§8's `ADD_CONTEXT` cross-session flow) does not exist yet. Before that runtime exists, a first `RouteOutcome` implementation can only enforce `reviewerRunId` uniqueness across the outcomes visible in the **current** `DeliberationState`/`StressTestSession` — which is the complete known lineage at that implementation stage, not a weakening of the invariant. When cross-session lineage runtime is later introduced, the uniqueness check must be extended across the linked lineage if this invariant remains binding at that point; this document does not pretend a first implementation can query lineage records that do not yet exist.

**Newness provenance — the key open architecture question, and its honest limit.** `ReviewFinding` (`src/stress-test/types.ts`) carries no field binding it to a `RouteAttempt`: `reviewerRunId` is a free-form, caller-supplied string, and `createdAt` is not causally bound to any attempt's `startedAt`. Inspected directly (`src/stress-test/types.ts`, `src/stress-test/session.ts::addFinding`): nothing in today's accepted domain layer can prove, from a finding's own stored fields alone, that it was produced specifically by one exact attempt rather than being an older finding whose `reviewerRunId` happens to match.

Stated accurately, without overclaiming: **this offline domain layer cannot cryptographically prove that a malicious caller did not manually fabricate a `ReviewFinding`.** That guarantee is outside the current trust model — the same trust boundary this domain layer already accepts everywhere (nothing stops a caller from directly constructing an invalid domain object; the system defends against structural inconsistency, never against a caller with direct object-construction access). Random-UUID unguessability does **not** prove causal provenance and is not the architecture boundary here — the prior version of this document overstated this and is corrected.

Within that accepted trust model, newness is defended **structurally**, by the combination of checks above, not by any single one alone:
- `RouteAttempt.startedAt` (an ordering anchor),
- a `reviewerRunId` distinct from `attemptId` (a real acquisition-run identity, not a borrowed one),
- `finding.createdAt >= attempt.startedAt` (an ordering check against that anchor),
- one `reviewerRunId` claimable by at most one successful `ADD_REVIEWER` outcome (no reuse of a historical batch),
- every referenced finding sharing that same `reviewerRunId` (internal batch consistency).

Together these make it structurally defensible that a claimed finding batch is *this* attempt's own new output rather than a reused or fabricated one, within the trust model this whole domain layer already operates under — not a cryptographic proof, and not claimed as one.

#### C. `REPLICATE` payload

```
{ result: ReplicationResult, targetRef: RouteInputRef }
```

`ReplicationResult` (`REPRODUCED` | `NOT_REPRODUCED` | `PARTIAL`, already frozen §3/§13.C) — all three map to `AttemptStatus = SUCCEEDED` (§6's allowlist; `REPLICATE` never produces `INCONCLUSIVE`).

`targetRef`: the exact `RouteInputRef` under replication; must exactly match one of the recorded `RouteDecision`'s own `inputRefs` — never independently supplied, never a free-floating reference. Restated explicitly here (rather than left implicit in the attempt/decision chain) for the same reason every other `RouteOutcome` binding field is restated: a terminal audit record should be self-contained, not require a full chain-walk to understand what happened.

No new `ReviewFinding` is ever produced or referenced by this payload: the already-accepted routing contract's output contract for `REPLICATE` is explicit — "a `ReplicationOutcome` attached to the original finding/issue's provenance chain — not a new, independently-competing `ReviewFinding`" (`MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md` §4). This closes the packet's question of whether a produced finding should be referenced by id: there is no produced finding to reference.

#### D. `SEEK_EVIDENCE` payload

```
SeekEvidenceResult = 'SUPPORTIVE' | 'CONTRADICTORY' | 'INCONCLUSIVE'
```

`SUPPORTIVE` / `CONTRADICTORY` -> `AttemptStatus = SUCCEEDED`. `INCONCLUSIVE` -> `AttemptStatus = INCONCLUSIVE` (§6). `FAILED` -> `FailureInfo`, no result payload.

##### Claim-identity gap (Slice 2D-B0 final amendment) — corrects the prior readiness claim

The accepted Phase 2 contract requires `SEEK_EVIDENCE` to identify the specific factual claim needing verification, its originating `ReviewFinding`/`SemanticIssue`, and that finding's own `artifactLocation`/provenance (`MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md` §4). The current product-domain `RouteInputRef` vocabulary identifies only a `FINDING` or `SEMANTIC_ISSUE` as a whole — there is no typed `ClaimId`, `ClaimRef`, or `EvidenceSubject` anywhere in the accepted runtime. The frozen `{ result, citations }` payload therefore cannot, by itself, answer *"which exact claim were these citations evaluating?"* whenever one finding carries more than one factual proposition, or a `SemanticIssue` aggregates multiple findings.

This gap is **not solved here**. In particular, this document does not casually add `claimText`, `claimId`, `claimIndex`, `paragraphId`, or `chunkId` without a separately justified design: paragraph-local identity is not product authority (`MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md` §9); an arbitrary copied claim-text field can drift from the source it was copied from; a `SemanticIssue` can aggregate multiple findings; and one finding can carry more than one factual proposition, so a single finding/issue reference does not uniquely identify a claim inside it. `SEEK_EVIDENCE`'s claim-level provenance requires a separately authorized architecture decision — recorded as genuinely open (§24), not invented under the pressure of this amendment.

##### Runtime readiness (Slice 2D-B0 final amendment) — corrects the prior readiness claim

Until claim-level `EvidenceSubject` provenance is separately frozen, **no `SEEK_EVIDENCE` result variant may be recorded** by a future RouteOutcome runtime (invariant 32, §20):

| Result | Runtime readiness |
|---|---|
| `SUPPORTIVE` | BLOCKED |
| `CONTRADICTORY` | BLOCKED |
| `INCONCLUSIVE` | BLOCKED |

A generic `FAILED` `RouteOutcome` + `FailureInfo` may still eventually be recorded — failure only records that the attempt did not produce a valid route result; it does not claim a successful evidence judgment against any claim. Retrieval itself remains **NOT AUTHORIZED** regardless of this readiness question. This corrects the prior version of this document, which marked `SEEK_EVIDENCE` "schema ready, execution/retrieval not authorized" without surfacing the claim-identity gap above — the successful-result schema was not actually complete, only its citation shape was.

Provider-neutral evidence citation, reused as a principle from `main`'s already-validated retrieval shape (`src/providers/types.ts::RetrievalSource { title?: string; url: string }` and `RetrievalResult`) — inspected directly, read-only, per §4 of this packet:

```
EvidenceCitation (conceptual):
{
  sourceIdentifier: string,  -- a URL, or another stable, re-locatable
                                identifier for a non-URL source (e.g. a
                                retrieved document's own citation key) --
                                never a raw page dump
  title?: string,
  excerpt: string,            -- bounded evidence text attributable to the
                                identified source -- a quotation or close
                                paraphrase of what that source actually
                                says, never the full source text, and never
                                an arbitrary assistant-generated paraphrase
                                presented as though it were the source's own
                                words
}

SUPPORTIVE / CONTRADICTORY:  { result, citations: EvidenceCitation[] }  -- citations MUST be non-empty
INCONCLUSIVE:                 { result: 'INCONCLUSIVE', citations: EvidenceCitation[] }  -- citations MAY be empty
```

`RetrievalSource`'s bounded `{title?, url}` shape and `RetrievalResult`'s documented rationale ("provider metadata... kept so a claim can be traced back to its source") are reused as principle only — never the type itself, never imported into this module. `RetrievalResult.raw?: unknown` is deliberately **not** reused: it is exactly the kind of unbounded, provider-specific metadata this contract excludes (§8 of the governing packet: no raw SDK objects, no huge raw pages). `excerpt` is deliberately source-attributable, not a generation surface: if a future implementation wants an assistant-authored paraphrase or synthesis distinct from what the source itself says, that requires its own, separately named field with its own semantic role — it is never folded into `excerpt` under the current frozen schema. No retrieval mechanism, provider, or SDK is chosen or implemented here.

#### E. `TARGETED_PEER_CHALLENGE` payload

```
TargetedPeerChallengeResult = 'REBUTTAL' | 'CONCESSION' | 'QUALIFICATION' | 'REFUSAL_TO_YIELD'
```

All four map to `AttemptStatus = SUCCEEDED` (§6's allowlist). `FAILED` -> `FailureInfo`, no result payload.

##### Input cardinality (Slice 2D-B0 final amendment)

`TARGETED_PEER_CHALLENGE` is explicitly a conflict between two identified review claims/positions (`MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md` §4) — a single provenance reference cannot establish both sides of that conflict. **Frozen architecture invariant (invariant 30, §20):** a registered `UnresolvedQuestion` whose `rootCause = DECISION_SENSITIVE_CONFLICT` must contain **at least two distinct `RouteInputRef`s** — distinct meaning `(kind, id)` is not identical between them. This is a gap in the currently-accepted registration rule discovered while translating this schema into executable requirements: `registerUnresolvedQuestion` (Slice 2B, accepted) today requires only `inputRefs.length >= 1` for any non-`NONE` root cause — sufficient for every other root-cause category, but not for `DECISION_SENSITIVE_CONFLICT` specifically, whose whole premise is two opposing positions.

**Required future enforcement, not implemented here:** before `TARGETED_PEER_CHALLENGE` execution can ever be authorized, a future routing-validation gate (at question registration, planning, or an equivalent boundary — the exact function is not chosen here) must reject a `DECISION_SENSITIVE_CONFLICT` question that cannot supply two distinct source/target provenance refs. No such gate exists in the accepted runtime today, and none is implemented by this document.

```
{
  targetRef: RouteInputRef,     -- the position being challenged
  sourceRef: RouteInputRef,     -- the position doing the challenging
  boundedExcerpt: { text: string, truncated: boolean, charLimit: number },
  response: string,              -- the target's actual reply
  result: TargetedPeerChallengeResult,
}
```

`targetRef`/`sourceRef` bind to product-domain identities only (`RouteInputRef` — `ReviewFinding.id`/`SemanticIssue.id`), never paragraph-local chunk ids as authority — already binding (`MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md` §9). `boundedExcerpt` reuses, as a principle only, the shape already validated by `main`'s `buildPeerExcerpt` (`src/agents/collaboration.ts`, inspected directly, read-only) — a length-limited excerpt with an explicit truncation flag — while dropping its paragraph/chunk identity fields (`agentId`, `chunkId`, `chunkIndex`, `startChar`, `endChar`), which are exactly the kind of identity this contract forbids as product authority (§9 of that same contract). No consensus mechanism, decision synthesis, or automatic resolution is implied: a `REBUTTAL` is still just one attempt's outcome, subordinate to re-evaluation (§14) and, ultimately, `HumanAdjudication` (§17).

**Target/source binding, frozen this amendment (invariant 31, §20):** `targetRef` and `sourceRef` must (a) each be a structurally valid `RouteInputRef`, (b) be distinct from one another — never the same `(kind, id)` — and (c) each exactly match one of the originating, recorded `RouteDecision.inputRefs`, preserving exact `kind` + `id` identity, with no inference. The outcome may choose which of the recorded inputs plays `target` and which plays `source`, but may not introduce a ref that was absent from the decision's own provenance — no arbitrary new ref introduced only at outcome time.

##### Runtime readiness (Slice 2D-B0 final amendment)

Until the input-cardinality routing gate above exists, **no `TARGETED_PEER_CHALLENGE` successful result variant (`REBUTTAL`/`CONCESSION`/`QUALIFICATION`/`REFUSAL_TO_YIELD`) may be recorded** by a future RouteOutcome runtime — the gate that would guarantee two distinct, decision-bound refs exist does not yet exist, so a successful outcome could not yet be defensibly bound to two provenance-distinct positions. A generic `FAILED` `RouteOutcome` + `FailureInfo` may still eventually be recorded for an already-started historical `TARGETED_PEER_CHALLENGE` attempt — failure only records that the mechanism did not produce a valid result; it does not require two-sided provenance to be meaningful. This blocks *runtime recording of a successful outcome*, not the schema itself: the payload shape and the provenance rules above are closed (§22, §24) — only their execution/recording is gated pending the routing gate.

Re-reviewed for the Slice 2D-B0 amendment: no contradiction found in the previously-frozen shape; `chunkId`/`agentId`/paragraph identity are not reintroduced as product-domain authority, and `RouteInputRef`-based source/target identity is unchanged — this amendment only adds the cardinality and binding requirements above.

#### F. `STOP`

No `RouteOutcome` exists for `STOP` at all (§5, §6) — not applicable, restated here only for completeness.

#### Session domain truth — RouteOutcome never silently mutates it

`RouteOutcome` never mutates `StressTestSession.findings`, `.semanticIssues`, `AuthorContext`, `HumanAdjudication`, or `RevisionAction`. Where a payload references a domain object (`ADD_REVIEWER`'s `findingIds`), that object must already exist through its own, separate domain operation performed **before** the `RouteOutcome` is recorded:

```
reviewer mechanism produces output
  -> addFinding(...)                        [an ordinary, already-accepted session.ts call]
  -> record RouteOutcome referencing the resulting finding ids

never:

record RouteOutcome
  -> secretly add findings
```

This sequencing is viable against the current state machine — inspected directly, `src/stress-test/session.ts` and `PRE_SUBMISSION_STRESS_TEST_MVP.md`, "State transitions": `addFinding` is allowed in `INPUT_FROZEN` and `REVIEWED`, and a `DeliberationState` only exists once a session is `REVIEWED` and stays there for as long as no `HumanAdjudication` has yet been recorded — exactly the window during which Minimum Necessary Deliberation operates. No conflict with `addFinding`'s existing state gate was found.

#### Snapshot / value semantics (extended)

Every new type this schema freeze defines follows the same independent-snapshot discipline the Slice 2B amendment already hardened for `RouteInputRef`/`UnresolvedQuestion`/`RouteDecision`: `FailureInfo`, `findingIds` arrays, `EvidenceCitation` arrays, `targetRef`/`sourceRef`, `boundedExcerpt`, and every route-specific result payload object must be independently cloned when a `RouteOutcome` is recorded — a caller-owned mutable reference must never be able to silently rewrite `DeliberationState`'s outcome history after the fact. This is not new policy; it is invariant 20 (§20) applied to every field this freeze adds.

#### Schema decisions closed (Slice 2D-B0)

**A. Does `RouteOutcome` need its own `outcomeId`?** No — `attemptId` is sufficient identity, given the already-fixed `ONE RouteAttempt -> AT MOST ONE RouteOutcome` cardinality (invariant 10).

**B. Exact generic `FailureInfo` vocabulary.** `TRANSPORT` / `VALIDATION` / `REFERENCE_RESOLUTION` / `EXECUTION` + a sanitized, bounded `message`; a closed runtime allowlist. `FAILED` requires it; every other status forbids it.

**C. Exact `ADD_CONTEXT` payload.** `SUPPLIED` (with `responseText`) / `DECLINED` / `NO_RESPONSE`, all `SUCCEEDED`; no session mutation, no lineage. **Corrected by the Slice 2D-B0 amendment:** `SUPPLIED` and `DECLINED` are runtime-ready; `NO_RESPONSE` is not — see "Runtime readiness," above, and the open decision recorded in §24.

**D. Exact `ADD_REVIEWER` payload/provenance.** `{ reviewerRunId, findingIds }`. **Corrected by the Slice 2D-B0 amendment:** the `reviewerRunId === attemptId` identity-equality convention is removed — GPT rejected collapsing two distinct domain identities into one. Newness is instead defended structurally by the combination documented above (`startedAt` ordering, a distinct `reviewerRunId`, `finding.createdAt >= attempt.startedAt`, one-`reviewerRunId`-per-successful-outcome, and internal batch consistency), explicitly *not* claimed as cryptographic proof. `findingIds` may be empty.

**E. Exact `REPLICATE` payload/provenance.** `{ result, targetRef }`; no produced finding exists to reference, per the already-accepted output contract.

**F. Exact `SEEK_EVIDENCE` payload/provenance.** `{ result, citations: EvidenceCitation[] }`; `EvidenceCitation` reused as principle from `main`'s `RetrievalSource`, deliberately excluding its unbounded `raw` field; `excerpt` is source-attributable text, never an arbitrary assistant paraphrase. **Corrected by the Slice 2D-B0 final amendment:** this citation shape is closed, but it is not, by itself, sufficient — it does not identify *which claim* the citations evaluate. Claim-level `EvidenceSubject` provenance is a separate, genuinely open decision (§24); `SUPPORTIVE`/`CONTRADICTORY`/`INCONCLUSIVE` are all runtime-blocked until it is closed.

**G. Exact `TARGETED_PEER_CHALLENGE` payload/provenance.** `{ targetRef, sourceRef, boundedExcerpt, response, result }`; `boundedExcerpt` reused as principle from `main`'s `buildPeerExcerpt`, stripped of chunk/paragraph identity. **Corrected by the Slice 2D-B0 final amendment:** the payload shape and the target/source binding rule (invariant 31) are closed, but a registered `DECISION_SENSITIVE_CONFLICT` question is not yet guaranteed to carry the two distinct refs this payload requires (invariant 30) — no routing gate enforces that yet, so all four successful result variants are runtime-blocked until it exists.

**H. Which fields are derived vs. caller-supplied.** See the generic-envelope table above. **Corrected by the Slice 2D-B0 amendment:** `logicalCost` is not caller input at all — always derived, with no "supply and reject on mismatch" path.

**I. Exact status/result consistency rules.** See the table above; a mismatched pair (e.g. `SEEK_EVIDENCE` `INCONCLUSIVE` + `status: SUCCEEDED`, or `REPLICATE` `PARTIAL` + `status: INCONCLUSIVE`) is structurally invalid and must be rejected.

**J. Is any route blocked by insufficient accepted domain provenance?** **Revised by the Slice 2D-B0 final amendment — more is blocked than the prior version claimed.** `ADD_CONTEXT` (`SUPPLIED`/`DECLINED`) and `REPLICATE` are direct restatements of already-explicit contract text and remain unblocked. `ADD_REVIEWER` is closed via a structural, multi-signal provenance rule and remains unblocked, subject to that rule. But `ADD_CONTEXT`'s `NO_RESPONSE`, every `SEEK_EVIDENCE` successful/inconclusive result, and every `TARGETED_PEER_CHALLENGE` successful result are now all runtime-blocked — the first on response-closure architecture, the second on claim-level provenance architecture, the third on an input-cardinality routing gate. See the readiness table below.

**K. Is `reviewerRunId` reuse across `ADD_REVIEWER` outcomes permitted?** No. At most one successful `ADD_REVIEWER` `RouteOutcome` per `reviewerRunId` within a `StressTestSession` lineage; a second claim is rejected, checked structurally, never inferred from timestamp alone. A first runtime implementation may only check this across the current `DeliberationState`/session, not a not-yet-existing cross-session lineage (see "Implementation-sequencing scope note," above).

**L. (Slice 2D-B0 final amendment) Does a `DECISION_SENSITIVE_CONFLICT` question need more than one `RouteInputRef`?** Yes — at least two, and they must be distinct `(kind, id)` pairs (invariant 30). Not yet enforced by any registration gate in the accepted runtime; flagged as required future enforcement, not implemented here.

**M. (Slice 2D-B0 final amendment) Must a `TARGETED_PEER_CHALLENGE` outcome's `targetRef`/`sourceRef` originate from the terminated `RouteDecision`'s own `inputRefs`?** Yes, exactly, with no inference and no new ref introduced at outcome time (invariant 31).

**N. (Slice 2D-B0 final amendment) Is `SEEK_EVIDENCE`'s claim-level provenance closed?** No — genuinely open (§24). This document explicitly declines to invent `claimText`/`claimId`/`claimIndex`/`paragraphId`/`chunkId` without a separately justified design.

#### Route readiness table (Slice 2D-B0 final amendment)

Not a purely relative sequencing preference — several result variants are actual architecture blockers, and the table below says so explicitly rather than treating every route/result as equally ready. This replaces the prior version's readiness table, which under-stated how much was blocked.

**Ready for first, offline `RouteOutcome` runtime:**
- Generic `FAILED` `RouteOutcome` (+ `FailureInfo`), for any already-started non-`STOP` `RouteAttempt`, regardless of route — see "Generic FAILED outcome," below.
- `ADD_CONTEXT` — `SUPPLIED`
- `ADD_CONTEXT` — `DECLINED`
- `ADD_REVIEWER` — successful finding-batch outcome, subject to every accepted `reviewerRunId`/newness check above
- `REPLICATE` — `REPRODUCED` / `NOT_REPRODUCED` / `PARTIAL`

**Not ready:**
- `ADD_CONTEXT` — `NO_RESPONSE` (no response-window/closure architecture exists yet — genuinely open, §24)
- `TARGETED_PEER_CHALLENGE` — all successful result variants (`REBUTTAL`/`CONCESSION`/`QUALIFICATION`/`REFUSAL_TO_YIELD`), blocked on the input-cardinality routing gate (invariant 30)
- `SEEK_EVIDENCE` — `SUPPORTIVE` / `CONTRADICTORY` / `INCONCLUSIVE`, blocked on claim-level `EvidenceSubject` provenance (genuinely open, §24)

#### Generic `FAILED` outcome remains structurally useful

A generic `FAILED` `RouteOutcome` stays recordable for **every** route above, including the three whose successful payloads are not yet runtime-ready — `FAILED` means only that the mechanism did not produce a valid route-specific result; it does not require the missing successful-result schema to be complete, and it makes no claim requiring two-sided provenance, claim-level identity, or anything else that the still-open items above would need. This does **not** authorize executing `TARGETED_PEER_CHALLENGE` or `SEEK_EVIDENCE`, or waiting for a `NO_RESPONSE` closure — it only means the generic ledger schema can represent an already-started attempt's defensible failure terminalization, for whichever route that already-started attempt happens to be. Provider execution remains `0` / **NOT AUTHORIZED**, unconditionally, regardless of this readiness question.

#### Recommended next slice scope (not authorized by this document)

If GPT authorizes further implementation, the next slice should be scoped narrowly to what is actually ready:

**`SLICE 2D-B1` — SAFE ROUTEOUTCOME LEDGER**, limited to:
- the `RouteOutcome` generic envelope,
- an `outcomes[]` ledger on `DeliberationState`,
- `FailureInfo`,
- latency accounting,
- the `ONE RouteAttempt -> AT MOST ONE RouteOutcome` cardinality,
- generic `FAILED`,
- `ADD_CONTEXT` `SUPPLIED` / `DECLINED`,
- `ADD_REVIEWER` success,
- `REPLICATE` success,
- snapshot/value semantics for every field above.

It should explicitly **not** implement: `NO_RESPONSE`; `SEEK_EVIDENCE` successful/inconclusive outcomes; `TARGETED_PEER_CHALLENGE` successful outcomes; `QuestionDisposition`; current-question gates; route execution; or any provider call. This is a recommendation for a future packet to authorize or not — it is not itself an authorization, and Slice 2D-B1 is **NOT AUTHORIZED** by this document.

#### Schema freeze (Slice 2D-C0): `ContextRequest` <-> `RouteAttempt` binding

`ADD_CONTEXT` success recording (deferred out of every slice so far, most recently reaffirmed in the Slice 2D-B2-0 freeze's `CROSS_SESSION`-blocking reasoning, §9 above: "no attempt-bound `ContextRequest`... exists yet") has exactly one missing prerequisite: an identity link proving *which* `RouteAttempt` a given `ContextRequest` — and, eventually, a given human response — belongs to. Today `ContextRequest` binds only to a `questionId`, and a question may (legally, per Slice 2D-B2-A's active-cycle model) have several completed cycles over its lifetime; question-level binding alone cannot prove a response answers *this* attempt's request rather than some other cycle's. This freeze closes that gap at the architecture level only — nothing below is implemented; no `src/**` type, function, or test is added.

**Core architecture question, answered:** the same single-hop, backward-pointing, derived-and-copied identity pattern already used at every other layer of this contract (`RouteAttempt.decisionId`, `RouteOutcome.attemptId`, `UnresolvedQuestion.derivedFromQuestionId`) — `ContextRequest.originatingAttemptId`, cross-checked at both write and read time against the exact `RouteAttempt` it names. A future `ADD_CONTEXT`-success `RouteOutcome` closes the loop by carrying `contextRequestId` and independently re-verifying `RouteOutcome.attemptId === ContextRequest.originatingAttemptId` — two facts, independently derived, cross-checked to agree, never a single fact trusted from one side alone.

##### A. Where attempt<->request identity lives

Closed: `ContextRequest.originatingAttemptId: string` (option A), not `RouteAttempt.contextRequestId` (option B), a parallel binding ledger (option C), or timestamp/questionId inference (option D). This is not merely convention-matching — it is close to *forced* by an already-accepted invariant: `RouteAttempt` is an immutable, start-only fact that is never mutated into a different shape after creation (invariant 21). Since the required creation order (§B, below) records `RouteAttempt` *before* `ContextRequest` can exist, option B would require either mutating an already-recorded `RouteAttempt` to attach a `contextRequestId` after the fact (a direct invariant-21 violation) or inventing a second, earlier point at which `RouteAttempt` could somehow already know its future request's id (impossible without reversing the creation order). `ContextRequest` is the downstream artifact, created *because* an attempt already exists; it naturally holds the backward reference, exactly as every other downstream identity in this contract already does. No parallel table is added — storing the same relationship in two places would only invent a second synchronization invariant, the same refusal already given for `QuestionDisposition`/`derivedFromQuestionId` (§9 above).

`ContextRequest`'s frozen field set becomes: `id`, `originatingSessionId`, `originatingQuestionId`, `originatingAttemptId`, `artifactHash`, `authorContextHash`, `sourceRefs`, `category`, `question`, `inferenceReason`, `createdAt`. `originatingQuestionId` is *not* removed even though it is technically re-derivable by chasing `originatingAttemptId -> RouteAttempt.decisionId -> RouteDecision.questionId` — this is not a second independent copy of the *lineage* relationship (which is what §9's refusal actually targets); it is a derived-and-copied convenience field, exactly the same shape `RouteOutcome.originatingQuestionId` already is alongside `RouteOutcome.attemptId`/`decisionId` (§7's envelope table, "Derived — copied from the resolved chain... re-verified against the current binding"). A derived-copy field that is always independently re-validated against its source chain is not the same hazard as an independently-writable parallel identity.

##### B. Request creation order

Closed: `RouteDecision -> recordRouteDecision -> recordRouteAttemptStart -> createContextRequest`. No request may exist before its attempt. This makes the recorded `RouteAttempt` the audit fact that execution of `ADD_CONTEXT` actually began, *before* a human is ever asked anything — consistent with every other route's already-accepted "attempt starts before any external interaction" posture (§5).

##### C. `createContextRequest` caller binding input

Closed: the future input becomes `{ attemptId, category, question, inferenceReason }`, replacing today's `{ questionId, category, question, inferenceReason }` outright — not extended alongside it. `questionId`, `sourceRefs`, `sessionId`, and both hashes must all derive from the resolved `attempt -> decision -> registered question` chain, never restated by the caller. This eliminates exactly the caller-divergence class of bug this contract has refused at every other boundary (`recordRouteOutcome`, `recordQuestionDisposition`): a caller could otherwise supply a `questionId` that does not actually match the attempt it claims to be requesting context for.

##### D. One attempt -> how many requests

Closed: **`ONE ADD_CONTEXT RouteAttempt -> AT MOST ONE ContextRequest`** (option A), not option B (multiple requests per attempt). A `RouteAttempt` represents one execution of one route, and its eventual `RouteOutcome` can hold exactly one determinate `AddContextResult` value (`SUPPLIED` | `DECLINED` | `NO_RESPONSE`, §7.A, unchanged) — there is no accepted mechanism for a "partially answered" outcome across several pending requests, and inventing one merely to permit multiple requests per attempt would be exactly the kind of unjustified complexity this contract has consistently refused elsewhere. If more than one piece of context is genuinely needed, the existing mechanisms already suffice without a new concept: multiple `RouteInputRef`s inside *one* `ContextRequest.sourceRefs`, or — if the deficit is genuinely a different question — a fresh `UnresolvedQuestion` requiring its own `RouteDecision`/`RouteAttempt` cycle. Cardinality mirrors `ONE RouteDecision -> AT MOST ONE RouteAttempt` (invariant 9) and `ONE RouteAttempt -> AT MOST ONE RouteOutcome` (invariant 10) exactly.

An attempt whose `ContextRequest` is created but never answered is not a gap this decision needs to solve: it is simply a permanently open/unterminated attempt, the same accepted audit state every other route already has (§5, invariant 22) — `NO_RESPONSE`'s own closure mechanism (open decision, §24 below) governs when, if ever, that becomes a defensible terminal fact; this decision does not need to, and does not, touch that question.

##### E. `contextRequests[]` ledger on `DeliberationState`

Closed: YES. Without it, adding `originatingAttemptId` to a value `ContextRequest` returned to (and only held by) an external caller is insufficient — a future `ADD_CONTEXT`-success `RouteOutcome`'s `contextRequestId` would have nothing authoritative in `DeliberationState` to resolve against, and could not be independently re-validated at read time. This mirrors exactly why `outcomes[]` and `questionDispositions[]` became necessary ledgers rather than caller-held values: an audit fact must be provable *from state*, never from an external object a caller could fabricate, omit, or diverge from.

##### F. Ledger cardinality / read integrity

Closed: a future pure, non-cached helper — name not binding, conceptually `assertContextRequestLedgerIntegrity(state)` — validates, on every read: every `ContextRequest.id` is non-empty and globally unique within `contextRequests[]`; every `originatingAttemptId` resolves to exactly one existing `RouteAttempt` whose `route === 'ADD_CONTEXT'` (`0` or `>1` both fail closed, no first-match); at most one `ContextRequest` claims any given `attemptId` (independently re-derived at read time, never trusting that the write-time gate in §16-below already guaranteed it for state that may predate it — the same "never trust an upstream check for pre-existing state" posture this contract has taken since the Slice 2D-B2-0 amendment); and every entry's `sessionId`/`artifactHash`/`authorContextHash` binding matches the chain it claims to belong to. Never cached, never persisted on `DeliberationState`.

##### G. Future `createContextRequest` return shape

Closed: option B — `{ deliberationState: DeliberationState, contextRequest: ContextRequest }`, atomic (ledger append and returned snapshot are produced from the same generated identity in one call; either both happen or the call throws and neither does). This is the one call-site-breaking shape change in this freeze's blast radius: `createContextRequest` is currently the only state-mutating function in this module that returns a bare value instead of the new `DeliberationState` — bringing it in line with `recordRouteDecision`/`recordRouteAttemptStart`/`recordRouteOutcome`/`recordQuestionDisposition` is a consistency correction, not a novel shape. Option A (state only) would lose the payload a caller needs to actually present to a human; option C (split factory/record) would reintroduce exactly the caller-divergence risk decision C above eliminates (a factory-built value could drift from what actually gets recorded); option D (caller separately registers) reopens the same problem decision E closes (a request that could exist without ever entering the ledger).

##### H. Separate `ContextResponse` entity

Closed: NO. The human-response fact belongs on the future `ADD_CONTEXT`-success `RouteOutcome` itself — `contextRequestId` plus the already-frozen `AddContextResult` payload (§7.A, unchanged: `SUPPLIED`/`DECLINED`/`NO_RESPONSE`) — because `RouteOutcome` is already this contract's accepted terminal immutable fact for an attempt; a second entity would duplicate exactly what `RouteOutcome` already is, the same "no second ledger without justification" refusal already applied to `QuestionDisposition`'s replacement-question model (§9) and to decision A above.

##### I. `SUPPLIED`/`DECLINED` provenance shape (readiness only — not implemented)

Closed as a readiness note, not a runtime authorization: a future `ADD_CONTEXT`-success `RouteOutcome` payload carries `contextRequestId`, independently re-resolved to exactly one `ContextRequest` in `contextRequests[]`, cross-checked that `RouteOutcome.attemptId === ContextRequest.originatingAttemptId` — two independently-derived facts confirmed to agree, never one trusted alone. `SUPPLIED`: `{ result: 'SUPPLIED', contextRequestId, responseText }` (`responseText` non-empty, unchanged from §7.A). `DECLINED`: `{ result: 'DECLINED', contextRequestId }` — no reason field is added; nothing in this contract's binding/provenance model needs one, and inventing a field merely for symmetry is exactly the unjustified invention this contract has refused before (`FailureInfo`'s message cap, §7; `materialityReason`'s absent bound, §9). Recording either payload does **not** mutate `AuthorContext` and does **not** create `SessionVersionLineage` — both remain exactly as already frozen at §7.A/§13.A/§24 above and below; `responseText` becomes prerequisite evidence for a later, separately-authorized `CROSS_SESSION` transition, not a direct session mutation.

##### J. `FAILED` interaction with zero or one `ContextRequest`

Closed: both are structurally legal, and neither creates ambiguity. (a) The attempt fails before any `ContextRequest` is ever created (the human-interaction mechanism itself could not be invoked) — generic `FAILED` (§7, unchanged) with zero `ContextRequest`s for that attempt. (b) A `ContextRequest` was created but the downstream human-response mechanism subsequently fails — generic `FAILED` with exactly one `ContextRequest` for that attempt. `FAILED`'s own payload (`{status, latencyConsumed, failure}`, §7) requires no change and carries no `contextRequestId` in either case — whether a `ContextRequest` happens to exist for a failed attempt is simply an independent, readable historical fact, never required or forbidden by the `FAILED` shape itself.

##### K. Active-cycle rule after attempt binding

Closed: the current `createContextRequest` allowance of `0` *or* `1` active cycles (§9 above, "`createContextRequest`'s active-cycle check") exists *only* because attempt binding did not yet exist, and disappears once it lands. Once `createContextRequest` takes `attemptId` as its binding input (§C, above), it is *progressing* an already-resolved cycle, not merely checking in on a question in the abstract — the same posture `recordRouteAttemptStart`/`recordRouteOutcome` already take. The rule becomes: exactly **one** active cycle required, and it must be the exact `RouteDecision` the supplied `attemptId` belongs to; `0` or a wrong-cycle match both reject, and a legacy `>1` remains a fail-closed inconsistent state, never automatically reconciled — identical in shape to every other cycle-progressing operation (§9, invariant 39).

##### L. Legacy missing-`contextRequests` compatibility

Closed: a `DeliberationState` predating this field is read as `contextRequests: []` at read boundaries only, never by mutating the stored record — exactly the same purely-additive compatibility posture already used for `questionDispositions` when that ledger was first introduced (§15 above: "today's runtime has no `questionDispositions` array... no breaking schema migration required") and for legacy-missing `derivedFromQuestionId` (§9 above). All newly-created state materializes `contextRequests: []` explicitly.

##### M. Blast radius

Closed. A future, separately authorized implementation phase is expected to touch: `ContextRequest` (add `originatingAttemptId`), `DeliberationState` (add `contextRequests: ContextRequest[]`), `createDeliberationState` (initialize `contextRequests: []`), `createContextRequest` (input shape `questionId -> attemptId`; full precondition rewrite per the chain above; return shape `ContextRequest -> { deliberationState, contextRequest }`), a new context-request ledger integrity helper (new code), and tests (substantial rewrite of every existing `createContextRequest` call site, not merely additions, given the input/return shape changes). Only once a *later*, separately authorized slice implements `ADD_CONTEXT` success does the blast radius extend to `recordRouteOutcome`'s `ADD_CONTEXT` branch (today entirely absent — `SUCCEEDED` is rejected outright for this route) and the `RouteOutcome` union (a new `AddContextRouteOutcome` variant). Confirmed to need **no** direct change for this freeze's own scope: `recordRouteAttemptStart` (attempt creation does not depend on what, if anything, happens after it), `isQuestionCurrent`, `getActiveRouteDecisionsForQuestion` (both remain fully disposition/cycle-shape agnostic — nothing about `ContextRequest` existing changes `RouteDecision`/`RouteAttempt`/`RouteOutcome`/`QuestionDisposition` identity or cardinality).

#### Schema decisions closed (Slice 2D-C0)

**A–M map exactly to the lettered subsections immediately above.** No governing source-of-truth document contradicts A–M; none required reopening an already-accepted Slice 2A/2B/2C/2D-B0/2D-B1/2D-B2-0/2D-B2-A/2D-B2-B invariant to close.

#### Recommended next runtime slices (Slice 2D-C0 freeze)

Not authorized by this document.

**`SLICE 2D-C1` — CONTEXTREQUEST ATTEMPT-BINDING LEDGER RUNTIME:** `ContextRequest.originatingAttemptId`; `contextRequests[]` ledger on `DeliberationState`; `createContextRequest`'s full precondition rewrite (attempt-bound input, exactly-one-active-cycle rule, `{deliberationState, contextRequest}` return); the ledger read-integrity helper (§F). No `ADD_CONTEXT` success `RouteOutcome`; no `SUPPLIED`/`DECLINED`; no `CROSS_SESSION`.

**`SLICE 2D-C2` — `ADD_CONTEXT` `SUPPLIED` / `DECLINED` ROUTEOUTCOME:** the `AddContextRouteOutcome` variant (`contextRequestId`, cross-checked against `RouteOutcome.attemptId`); `SUPPLIED`/`DECLINED` recording per §I above. Still no `AuthorContext` mutation, no `CROSS_SESSION`, no `NO_RESPONSE`.

**`SLICE 2D-C3` — `CROSS_SESSION` / `SESSION VERSION LINEAGE`** (later, separately authorized, and only once 2D-C1/2D-C2 are both accepted): the actual session-version transition `SUPPLIED` evidence is prerequisite for. Not designed by this document beyond the prerequisite chain already established (§9 above, decision E: "`CROSS_SESSION` remains runtime-blocked").

`NO_RESPONSE` remains excluded from all three recommended slices — it depends on a response-window/closure architecture decision (open, §24 below) that none of 2D-C1/C2/C3 builds.

---

## 8. Question lifecycle: append-only, not in-place reclassification

The registered `UnresolvedQuestion` produced by `registerUnresolvedQuestion` (Slice 2B, accepted) is an audit snapshot. After a `RouteAttempt` on that question, its `rootCause`, `materialityReason`, `inputRefs`, and identity are **never mutated in place** — this is a direct extension of the append-only, snapshot-owned discipline the Slice 2B amendment already hardened at the API-boundary level (independent cloning of every registered/recorded object).

Worked example:

```
Q1  rootCause = EVIDENCE_GAP
     |
     v
SEEK_EVIDENCE attempted (RouteAttempt, RouteOutcome)
     |
     v
re-evaluation determines: the factual gap is resolved,
                           but two interpretations now materially conflict
     |
     v
Q1 -> QuestionDisposition = SUPERSEDED_RECLASSIFIED   (Q1 itself is untouched)
     |
     v
Q2  rootCause = DECISION_SENSITIVE_CONFLICT
    derivedFromQuestionId = Q1
```

`Q1.rootCause` is never rewritten to `DECISION_SENSITIVE_CONFLICT`. `Q2` is a new registered question, carrying explicit lineage (`derivedFromQuestionId`) back to `Q1`. The minimum required structure is exactly that one field — no separate lineage aggregate is needed for this case, unlike the cross-session case (§13.A), which already has its own conceptual `SessionVersionLineage` record.

---

## 9. QuestionDisposition

A separate conceptual lifecycle record — never overloaded onto `RouteOutcome`, and never an insufficient boolean (`resolved: true/false`).

| Disposition | Meaning |
|---|---|
| `RESOLVED` | The original information deficit no longer remains materially open. |
| `STILL_OPEN` | The original deficit remains materially unresolved. |
| `SUPERSEDED_RECLASSIFIED` | The original question no longer correctly describes the remaining deficit; a new `UnresolvedQuestion` (`derivedFromQuestionId` pointing back at this one) is created (§8). |
| `CROSS_SESSION` | Specific to `ADD_CONTEXT` (§13.A): the supplied context caused creation of a new `StressTestSession` version; the question's disposition under the *old* session is recorded as `CROSS_SESSION`, distinct from `RESOLVED` — the deficit was not resolved under Session A, it was carried across a version boundary into Session B. |

### Terminality

Each disposition value has explicit terminality semantics for the question it targets:

| Disposition | Terminal for this question? | Question remains current (§15)? |
|---|---|---|
| `STILL_OPEN` | No | Yes — a future fresh `RouteDecision` may target it |
| `RESOLVED` | Yes, in this session | No |
| `SUPERSEDED_RECLASSIFIED` | Yes, for the original question | No — the replacement deficit must use a new `UnresolvedQuestion` identity (§8) |
| `CROSS_SESSION` | Yes, under the old session | No — not copied as current into the new session |

Once a question has a terminal disposition (`RESOLVED`, `SUPERSEDED_RECLASSIFIED`, or `CROSS_SESSION`), **no future `RouteDecision`, `RouteAttempt`, `RouteOutcome`, or second `QuestionDisposition` may target that original question in that session.** This is fail-closed, mirroring every other binding check in this architecture: a routing gate presented with a non-current question must refuse, not silently proceed.

A question's disposition history is itself append-only, but bounded: it may accumulate any number of `STILL_OPEN` records — one per re-evaluation cycle that did not close it — but the moment a terminal disposition is recorded, no disposition of any kind may follow it for that question (§19). **Corrected wording, precise statement (Slice 2D-B2-B amendment):** the bound is on *terminal* dispositions, not on disposition count overall — a question's history is `STILL_OPEN*` followed by an optional single terminal disposition (`RESOLVED` or `SUPERSEDED_RECLASSIFIED`; `CROSS_SESSION` remains architecture-terminal but runtime-blocked), never the other way around. This removes any ambiguity from "current disposition" semantics: for a non-terminal question, the current disposition is simply its most recent `STILL_OPEN` record (or "none yet"); for a terminal question, there is exactly **one terminal disposition, ever** (any number of earlier `STILL_OPEN` records from prior completed cycles may legitimately precede it), and once it is recorded, it is permanently the last disposition that question will ever have.

### Schema freeze (Slice 2D-B2-0)

The remainder of this section freezes `QuestionDisposition`'s exact conceptual envelope, its binding to `RouteOutcome`, current-question derivation, the complete current-gate API set, and active-cycle semantics — so a future implementation phase has one unambiguous schema to build against. Nothing below is implemented; no `src/**` type, function, or test is added by this freeze.

#### Identity: no separate `dispositionId`

`QuestionDisposition` does **not** get its own `dispositionId`, for the same reason `RouteOutcome` got no separate `outcomeId` (§7): invariant 27 already fixes `ONE RouteOutcome -> AT MOST ONE QuestionDisposition`, so the outcome's own identity — `attemptId` — is sufficient to identify the (at most one) disposition that closes it. A disposition is uniquely identifiable *from* the `RouteOutcome` that motivated it; inventing a second identity would duplicate a cardinality guarantee that already exists rather than add one.

#### Generic envelope — derived vs. supplied vs. generated

| Field | Source |
|---|---|
| `attemptId` | Caller-supplied — identifies which existing, terminal `RouteOutcome` this disposition targets. Resolved only against `deliberationState.outcomes`; an unknown `attemptId` is rejected (no free-floating disposition, mirroring `recordRouteAttemptStart`/`recordRouteOutcome`'s own resolution rule). |
| `disposition` | Caller-supplied — one of the closed `QuestionDispositionKind` values (below), the one fact only an external semantic re-evaluation can supply. |
| `reason` | Caller-supplied — non-empty explicit prose (below). |
| Disposition-specific payload (e.g. a `SUPERSEDED_RECLASSIFIED` replacement question, §"SUPERSEDED_RECLASSIFIED" below) | Caller-supplied where the disposition requires one; forbidden otherwise. |
| `questionId` | Derived — copied from the resolved `RouteOutcome.originatingQuestionId`. Never independently caller-supplied; a caller can never restate it inconsistently with the outcome they claim to target. |
| `sessionId`, `artifactHash`, `authorContextHash` | Derived — copied from the resolved chain (`RouteOutcome` -> `RouteAttempt` -> current `DeliberationState`/`StressTestSession`), re-verified against the current binding before the disposition is recorded (fail-closed, mirroring `recordRouteOutcome`'s own re-check, §7). |
| `createdAt` | **Runtime-generated at record time.** Never a caller-supplied timestamp, for the same reason `RouteOutcome.completedAt` is runtime-generated (§7). |

Caller must never be able to restate a derived binding field inconsistently — exactly the same discipline `recordRouteOutcome`'s exact-key-shape hardening already enforces (§7, §14 of the governing packet), extended to this new operation.

#### `reason`

Every `QuestionDisposition` requires `reason`: a non-empty, explicit prose string — the externally-supplied semantic re-evaluation rationale. This runtime validates structure only; it never computes or infers the disposition itself, exactly the posture `RouteReason.materialityReason` and `UnresolvedQuestion.materialityReason` already take (no AI classifier, no numeric materiality score, §14).

No maximum bound is frozen here. `materialityReason` — the closest existing precedent, structurally identical in purpose — carries no bound in the accepted runtime (`assertNonEmptyMaterialityReason` checks only non-emptiness), and no repository evidence justifies inventing one for `reason` merely for symmetry with `FailureInfo.message`'s 2000-character cap. That cap exists for a specifically named reason — bounding a payload that could otherwise carry an unbounded raw error blob (§7) — which does not apply here: `reason` is always a short, deliberately-authored rationale, not a place where an unbounded external payload could leak in. Inventing a bound without an analogous justification would be exactly the kind of unjustified invention this contract has consistently refused elsewhere (§7's `SEEK_EVIDENCE`/`ADD_REVIEWER` provenance sections).

#### Outcome binding (fail-closed chain resolution)

A `QuestionDisposition` must resolve `attemptId` to exactly one existing, terminal `RouteOutcome` — no free-floating disposition. Required, all independently re-validated (never trusting that an earlier layer already checked them, mirroring `validateAttemptProvenanceForOutcome`'s posture in `recordRouteOutcome`, §7):

- the `RouteOutcome` exists (resolved from `deliberationState.outcomes`),
- its `RouteAttempt` exists (resolved from `deliberationState.attempts`),
- its `RouteDecision` exists (resolved from `deliberationState.history`),
- its `UnresolvedQuestion` exists (resolved from `deliberationState.unresolvedQuestions`),
- `outcome.originatingQuestionId === question.id`,
- `sessionId`/`artifactHash`/`authorContextHash` bind exactly across every layer of the chain and the current `DeliberationState`/`StressTestSession`.

`ONE RouteOutcome -> AT MOST ONE QuestionDisposition` (already invariant 27): a second disposition attempting to claim an `attemptId` that already has one is rejected outright — no overwrite, no repair path.

#### The outcome must be terminal

A `QuestionDisposition` may only be recorded against an existing, terminal `RouteOutcome`. An open/unterminated `RouteAttempt` — one with no recorded outcome yet (§5) — cannot receive a disposition. There is no path `RouteAttempt -> QuestionDisposition` that skips `RouteOutcome`; the chain is always `RouteAttempt -> RouteOutcome -> QuestionDisposition`, never shorter.

#### `recordQuestionDisposition` — complete precondition list

Consolidating every precondition this conceptual operation must independently enforce, gathered here in one place rather than left implicit across the sections above and below:

1. `deliberationState.stopReason === null` — no disposition may be recorded once machine deliberation has stopped (§"Post-`STOP` rule," below).
2. The targeted question must be **current** before this call — the same currentness gate every other routing operation gets (§"Current gates," above), required here as an intrinsic precondition of this specific operation, not because it is a sixth pre-existing API being retrofitted.
3. Resolve the full `RouteOutcome` -> `RouteAttempt` -> `RouteDecision` -> `UnresolvedQuestion` chain (§"Outcome binding," above) — fail closed on any break.
4. Require **exactly one** active cycle for that question (§"Legacy / permissive-state integrity," below), and require that active cycle to be the *exact* decision represented by the supplied outcome's `attemptId` — not merely *an* active cycle for the question, but specifically the one this disposition is closing.
5. Reject if the targeted `RouteOutcome` already has a `QuestionDisposition` (invariant 27, already-established `ONE RouteOutcome -> AT MOST ONE QuestionDisposition`).

This closes the legacy parallel-cycle ambiguity at the disposition boundary: even a session with historically-inconsistent parallel decisions cannot have a disposition recorded against the *wrong* one of them.

#### Legal disposition combinations after `FAILED` / `SUCCEEDED`

`AttemptStatus` never mechanically determines `QuestionDisposition` (§10, invariant 4 — restated and extended here to the failure direction too). The legal-combination table:

| Outcome status | `STILL_OPEN` | `RESOLVED` | `SUPERSEDED_RECLASSIFIED` | `CROSS_SESSION` |
|---|---|---|---|---|
| `FAILED` (any route) | Legal | Legal | Legal | **Illegal** |
| `SUCCEEDED` — `ADD_REVIEWER` | Legal | Legal | Legal | Illegal (wrong route) |
| `SUCCEEDED` — `REPLICATE` | Legal | Legal | Legal | Illegal (wrong route) |

**`CROSS_SESSION` after `FAILED` is illegal, closed explicitly.** `CROSS_SESSION` requires an actual new `StressTestSession` version carrying supplied context forward (§13.A); a failed attempt produced no supplied context and cannot have caused a version transition — there is nothing to carry across. This holds regardless of route.

**`RESOLVED` after `FAILED` is legal, closed explicitly — not left implicit.** The materiality/resolution decision is made by an *externally supplied* semantic re-evaluation, never by the attempt's own mechanical status (§14) — the same separation invariant 4 already establishes in the success direction (`SUCCEEDED` never mechanically implies `RESOLVED`) must hold symmetrically in the failure direction (`FAILED` must not mechanically forbid `RESOLVED`). A concrete, legitimate case, corrected to stay consistent with frozen-input integrity (an earlier version of this example wrongly implied the frozen artifact/context could change in place, which it never can, §5 of the routing contract, `verifyFrozenInputIntegrity`): `SEEK_EVIDENCE` fails (retrieval outright unavailable), and an independent semantic re-evaluation determines, from the *same* frozen input, that the underlying claim was over-classified as material in the first place — the failed route proved nothing either way, but re-evaluation independently concludes the deficit no longer needs to remain current. That is a genuine `RESOLVED`, not a misattribution, *provided* `reason` states that independent rationale rather than citing the failure itself as the resolving fact. If genuinely new author context were required to resolve the question, that is an `ADD_CONTEXT` / new-session-boundary matter (§13.A), never a `RESOLVED`-in-place claim that the frozen input itself changed. Forbidding `RESOLVED`-after-`FAILED` structurally would force a caller into an artificial `SUPERSEDED_RECLASSIFIED` detour merely to close a legitimately-resolved question, which is a worse, more convoluted answer than simply allowing the disposition value the semantics were always meant to carry. The misattribution risk the governing packet names is real but is a **reason-quality** concern, not a **structural-legality** one: this runtime validates that `reason` is a non-empty, explicit rationale (above); it does not, and architecturally should not, attempt to verify that the rationale is *good* — exactly the same boundary `materialityReason` already draws everywhere else in this contract.

#### `SUCCEEDED` never automatically infers `RESOLVED`

For both currently-implemented success paths, a valid re-evaluation may legitimately produce any of `STILL_OPEN`, `RESOLVED`, or `SUPERSEDED_RECLASSIFIED` (§10's own table already gives concrete examples for `REPLICATE`/`ADD_REVIEWER`) — this document does not compute or default to any of them from the outcome's `status` or route-specific result value. `SUPERSEDED_RECLASSIFIED` is architecturally legal after either success path (e.g. a `REPLICATE` result reveals the real deficit is something else entirely) even though its first-implementation runtime is deferred (below).

#### `CROSS_SESSION` remains runtime-blocked

`CROSS_SESSION` is architecture-valid only for `ADD_CONTEXT` + a successful `SUPPLIED` result + an actual new `StressTestSession` version / `SessionVersionLineage` (§13.A, §14 of the governing packet). The accepted runtime today has none of: an attempt-bound `ContextRequest`, an `ADD_CONTEXT` success `RouteOutcome`, `SessionVersionLineage`, or Session-B-creation runtime. `CROSS_SESSION` `QuestionDisposition` runtime is therefore **BLOCKED** and excluded from the first `QuestionDisposition` implementation set (below) — no fabricated cross-session record may exist without the actual lineage it claims to represent.

#### `SUPERSEDED_RECLASSIFIED` — replacement-question model (architecture only)

Two requirements must both hold, atomically, per the worked example already given (§8): `Q1` becomes terminally `SUPERSEDED_RECLASSIFIED` if and only if its replacement `Q2` is simultaneously registered — never one without the other. A caller must not be able to leave `Q1` terminal with no `Q2`, nor register an orphan `Q2` claiming derivation from `Q1` without the matching disposition.

The frozen model, chosen to preserve the existing pure-factory separation (`createUnresolvedQuestion` stays a pure, unvalidated-against-state factory; `registerUnresolvedQuestion` stays the sole state-mutating registration path) rather than weakening it:

```
caller constructs Q2 via createUnresolvedQuestion(session, {
  rootCause, materialityReason, inputRefs, derivedFromQuestionId: Q1.id
})
  -> a plain, offline, pure value; not yet registered; not yet state

caller calls (conceptual, not implemented):
recordQuestionDisposition(session, deliberationState, {
  attemptId,                          -- Q1's terminal RouteOutcome
  disposition: 'SUPERSEDED_RECLASSIFIED',
  reason,
  replacementQuestion: Q2,
})
  -> independently re-validates Q2 from scratch (never trusts createUnresolvedQuestion
     produced it correctly) -- ordinary inputRef/materiality validation, rootCause != NONE,
     Q2.id != Q1.id, Q2.derivedFromQuestionId === Q1.id exactly
  -> atomically, in one returned DeliberationState:
       - registers Q2 into unresolvedQuestions (same structural rules registerUnresolvedQuestion
         already enforces, re-validated independently -- never trusting Q2 arrived pre-validated)
       - records Q1's terminal SUPERSEDED_RECLASSIFIED disposition
  -> either both facts land in the returned state, or neither does; no partial transition
```

This mirrors the existing `createUnresolvedQuestion` (pure factory) / `registerUnresolvedQuestion` (state-mutating, independently re-validating) separation exactly — `recordQuestionDisposition` plays the role `registerUnresolvedQuestion` already plays for an ordinary question, just atomically bundled with the disposition it is inseparable from. This does not weaken the pure-factory rule; it reuses it for the replacement question exactly as already established for every other question.

#### `derivedFromQuestionId` becomes a field on `UnresolvedQuestion`

**Confirmed, with technical reasoning, not merely inherited from the earlier draft.** Two options were weighed: (A) a single `derivedFromQuestionId: string | null` field on every `UnresolvedQuestion`, or (B) a separate lineage-tracking collection alongside it. (A) is adopted. Reasoning: (B) would track exactly the same relationship (A) already captures with one field, at the cost of a second collection whose entries would need to stay in permanent agreement with the field on the record it describes — an integrity risk (A) cannot have, since (A) stores the fact in exactly one place. This matches the design principle already used throughout this contract: a reference lives on the entity that needs it (`RouteAttempt.decisionId`, `RouteOutcome.originatingQuestionId`) rather than in a parallel link table. Every originally-created question has `derivedFromQuestionId: null`; a replacement question created only through the atomic transition above has it set to the exact `Q1.id` it supersedes.

Rules, closed:
- `derivedFromQuestionId` on an originally-created question is always `null`.
- On a replacement question, it must reference an existing `Q1` that is, in the *same atomic transition*, being marked terminally `SUPERSEDED_RECLASSIFIED` — never an arbitrary, independently-chosen `Q1`.
- The replacement question's `id` must be distinct from `Q1.id`.
- The replacement question's `rootCause` must not be `NONE` (ordinary registration rule, unchanged).
- The replacement question keeps every ordinary `inputRef`/materiality validation `registerUnresolvedQuestion` already enforces — `derivedFromQuestionId` is an addition, not a relaxation.
- **`registerUnresolvedQuestion` (the ordinary, non-atomic registration path) must reject any question whose `derivedFromQuestionId` is non-`null`.** The *only* path to register a derived question is the atomic `SUPERSEDED_RECLASSIFIED` transition above — never a standalone call that fabricates lineage to an arbitrary `Q1` without an accompanying terminal disposition on it. This closes the governing packet's requirement that "no arbitrary derivation chain attachment" exist outside a superseding transition.

This is a schema change to an already-accepted Slice 2A/2B type (`UnresolvedQuestion`), which is precisely why it is scoped to a later slice (below), not bundled into the first `QuestionDisposition` runtime.

#### First-implementation subset

**Closed: `STILL_OPEN` + `RESOLVED` only, first.** `SUPERSEDED_RECLASSIFIED` requires a material schema change to an already-shipped, already-tested Slice 2A/2B type (`derivedFromQuestionId` on `UnresolvedQuestion`, above) — every function that already constructs or validates `UnresolvedQuestion` (`createUnresolvedQuestion`, `registerUnresolvedQuestion`, `planRouteForQuestion`, `recordRouteDecision`, `cloneUnresolvedQuestion`) would need to decide how the new field interacts with its existing validation, widening the blast radius of a single slice considerably. `CROSS_SESSION` is blocked outright regardless (above). Isolating `STILL_OPEN`/`RESOLVED` — which need no schema change to any existing accepted type, only the wholly-new `QuestionDisposition` concept — into a first slice keeps that risk contained; `SUPERSEDED_RECLASSIFIED` (and, separately, whenever its prerequisites exist, `CROSS_SESSION`) belongs in a later, explicitly authorized slice (recommended below).

#### Current-question derivation

Formalizing §15's existing rule as an exact, implementable definition:

```
isQuestionCurrent(deliberationState, questionId): boolean
  = true  iff no terminal QuestionDisposition (RESOLVED, SUPERSEDED_RECLASSIFIED,
           or CROSS_SESSION) has been recorded for questionId
  = true  for a question with zero dispositions, or only STILL_OPEN dispositions
  = false once any terminal disposition has been recorded for it -- permanently,
           for the life of that DeliberationState
```

No redundant `current: true/false` field is ever stored on `UnresolvedQuestion` — currentness is always derived from `questionDispositions[]` (§15's already-frozen array), never cached, so it can never drift out of sync with the disposition history that actually determines it.

#### Current gates — complete API list

**Closed: all five require a fail-closed current-question check, confirmed technically, not merely because GPT prefers it:**

| API | Why it needs the gate |
|---|---|
| `planRouteForQuestion` | Early, non-authoritative fail-fast: planning is pure and ephemeral by design (`planRouteForQuestion`'s own accepted docstring, `src/stress-test/deliberation.ts`: "Plans (does not record or execute)... Pure and offline"), so refusing here catches the mistake before any further work happens — consistent with this function's existing practice of independently re-validating everything `recordRouteDecision` will also re-validate (defense in depth already established, not a new pattern). |
| `recordRouteDecision` | **Authoritative gate.** Only a recorded decision is audit truth; a terminal historical question must never receive a new recorded decision, full stop. |
| `recordRouteAttemptStart` | A stale, pre-terminal decision recorded *before* the question went terminal must not be allowed to start a fresh attempt after the question closed — currently checks only "registered" (`deliberationState.unresolvedQuestions.find`); must also check current. |
| `recordRouteOutcome` | The critical stale-attempt case (§"RouteOutcome after terminal disposition," below): a second, still-open historical attempt on an already-terminal question must not be allowed to terminalize. |
| `createContextRequest` | A new `ContextRequest` against an already-terminal question must reject (§"ContextRequest after terminal disposition," below); currently checks only registration. |

No runtime code is modified by this document; this is the frozen requirement a future implementation phase must satisfy.

`recordQuestionDisposition` itself also requires its target question to still be current *before* it records the very disposition that may make it non-current (full precondition list above). This is **not a sixth entry retrofitted onto the list of five pre-existing APIs above** — those five already existed before `QuestionDisposition` was designed, and each needed this gate added to already-accepted behavior. `recordQuestionDisposition` is a wholly new operation being designed for the first time; requiring currentness is simply an intrinsic precondition of what it does, not a retrofit.

#### Active-cycle semantics

**Closed: at most one ACTIVE deliberation cycle per current question, at a time.** A question's cycle — beginning at a recorded `RouteDecision` for it and ending at a recorded `QuestionDisposition` for that decision's eventual outcome — is **ACTIVE** for the whole span between those two events, regardless of which intermediate stage it is currently in:

```
ACTIVE(question) = exists a RouteDecision d in history with d.questionId === question.id
                    such that no QuestionDisposition has yet been recorded for d's
                    eventual outcome
```

This single definition subsumes every stage the governing packet named separately — a decision recorded with no attempt yet, an attempt started with no outcome yet, and an outcome recorded with no disposition yet are all just different points along the *same* active span, not three different categories needing different handling. Only once a disposition is recorded for a decision's cycle — `STILL_OPEN` (permitting a fresh cycle to begin) or a terminal disposition (permitting no further cycle at all) — may a *new* `RouteDecision` for that same question ever be recorded.

#### Existing historical state (non-retroactive)

The active-cycle rule above is a **forward-looking gate on future recording**, never a retroactive claim about what the currently-accepted runtime already enforces. Today's `planRouteForQuestion`/`recordRouteDecision` place no check preventing two decisions from being recorded for the same question — the accepted runtime is, and always has been, more permissive than this new rule. No shipped test in `test-stress-test-deliberation.mjs` (Slice 2A through 2D-B1) ever exercises or relies on that permissiveness — none constructs two decisions for one question — so tightening this later is a compatible, non-breaking hardening, not a correction of a bug. No historical record is ever silently deleted, and no migration is invented: if a future implementation phase ever discovers a session with genuinely parallel decisions/attempts for one question (a state nothing in the accepted runtime has ever produced), it must fail closed on that discovery — treat it as an inconsistent state requiring explicit reconciliation — rather than silently picking one decision as authoritative.

#### Where active-cycle *creation* is prevented — and why that is not the whole answer

**`recordRouteDecision` remains the authoritative gate that *prevents creation* of a second active cycle.** For a non-`STOP` `RouteDecision`, before recording it, a future runtime must establish (1) the targeted question is current, and (2) zero active non-`STOP` `RouteDecision`s already exist for that question — reject if one already exists; reject, as legacy/inconsistent state, if more than one somehow already exists. `STOP` is exempt from this check entirely: it is session-level termination, not a new question cycle (§"`STOP` interaction," below).

**Corrected — this is not, by itself, sufficient.** An earlier version of this document claimed downstream checks at `recordRouteAttemptStart`/`recordRouteOutcome` would be structurally redundant once `recordRouteDecision` enforces the rule, "since there is no path by which they could encounter two competing active decisions." That reasoning only holds for state created *after* the gate exists. The accepted runtime today (`planRouteForQuestion`/`recordRouteDecision`, Slice 2A/2B) predates this rule entirely and places no check preventing two decisions from being recorded for the same question — so a `DeliberationState` can structurally already contain `Q1 -> Decision A` and `Q1 -> Decision B`, both active, before any active-cycle gate is ever implemented. A downstream operation cannot rely on an upstream gate that did not exist when the state it is now operating on was created. Every downstream operation must therefore **independently** re-derive and validate the active-cycle set for the question it targets — never trust that an upstream gate already guaranteed it, exactly the same "never trust, always re-validate at the boundary" posture this entire contract already takes everywhere else (§7's `validateAttemptProvenanceForOutcome`, §9's outcome-binding chain resolution).

#### Legacy / permissive-state integrity — the structural helper this requires

A future implementation needs a structural helper conceptually equivalent to:

```
getActiveRouteDecisionsForQuestion(deliberationState, questionId): RouteDecision[]
  = every non-STOP RouteDecision d in history with d.questionId === questionId
    such that no QuestionDisposition has yet been recorded for d's eventual outcome
```

(exact name not frozen; `assertSingleActiveCycleIntegrity(...)` performing the same derivation and throwing is an equally acceptable shape). Its result has exactly three possible sizes, each with a frozen meaning:

| `getActiveRouteDecisionsForQuestion(...).length` | Meaning |
|---|---|
| `0` | Valid — no active cycle; starting a new one is permitted (subject to currentness). |
| `1` | Valid **only** for progressing that exact cycle — the operation must be operating on that one active decision/attempt/outcome, not a different one. |
| `>1` | **Invalid — legacy/inconsistent state.** Fail closed. |

The `>1` case is **never** automatically reconciled: no "pick the latest," no timestamp-based winner, no silent deletion of the losing decisions. It fails closed, exactly like every other integrity violation in this contract — the same posture already established for "existing historical state" (above).

#### Downstream legacy-integrity gates

Although `recordRouteDecision` is the authoritative *creation* gate, the following operations must **independently** protect against a question whose historical state already violates single-active-cycle integrity — this is not duplicate policy enforcement; it is integrity validation for states that may predate the authoritative gate:

| API | Required independent check |
|---|---|
| `recordRouteAttemptStart` | Resolve the question; require exactly one active cycle, and that it is the exact decision being started. `0` active or `>1` active → reject; `1` active belonging to a *different* decision → reject. |
| `recordRouteOutcome` | Resolve the question; require exactly one active cycle, and that it is the exact decision/attempt being terminalized. Same `0`/`>1`/wrong-cycle rejection. |
| `recordQuestionDisposition` | Resolve the question; require exactly one active cycle, and that it is the exact decision represented by the supplied outcome/`attemptId` (full precondition list below). |

`planRouteForQuestion` gets the identical check as an early, non-authoritative fail-fast (below) — planning remains ephemeral; `recordRouteDecision` remains the sole authoritative *creation* enforcement, but every operation that *progresses* an existing cycle re-derives and re-checks that cycle's uniqueness independently, rather than trusting a gate that may not have existed when the state it is now touching was created.

#### `planRouteForQuestion`'s active-cycle check

For a non-`STOP` question: the question must be current, and no active cycle may already exist. If exactly one already exists, reject (planning cannot start a second cycle). If more than one already exists, reject as inconsistent historical state — the same `>1` case as every other downstream gate. Planning remains ephemeral and non-authoritative; `recordRouteDecision` remains the authoritative enforcement point for actually *creating* a cycle.

#### `createContextRequest`'s active-cycle check

`createContextRequest` keeps its required current-question gate (§"Current gates," above) and additionally: if the targeted question is found to have more than one active recorded cycle, it rejects as inconsistent historical state — the same integrity check every other downstream operation performs. This document does **not** attempt to solve `ContextRequest` -> `RouteAttempt` binding here (still separately deferred, unchanged), and `createContextRequest` is never required to invent or assume an active cycle for its own operation — it only refuses when the historical state it inspects is already inconsistent.

#### `RouteOutcome` after terminal disposition (stale attempts)

Concrete case, made explicit: a session has (hypothetically, per "existing historical state" above) two historical attempts on `Q1` — attempt A and attempt B, both started before either question-currentness or active-cycle enforcement existed. Attempt A's outcome is recorded and disposed `RESOLVED`. Attempt B is still open. **After `RESOLVED`, attempt B must never be allowed to record a `RouteOutcome`** — this is exactly why `recordRouteOutcome` needs the current-question gate (above), not merely the outcome-binding checks it already has. Attempt B becomes a **permanently open/unterminated attempt** — an accepted, explicit audit state (§5, invariant 22), never silently deleted, never coerced into `SUCCEEDED` or `FAILED` after the fact.

#### `ContextRequest` after terminal disposition

The same rule extends to `ADD_CONTEXT`: once `Q1` (a `CONTEXT_GAP` question) has any terminal disposition, a new `ContextRequest` against it must reject. `createContextRequest` today checks only that the question is *registered* (`deliberationState.unresolvedQuestions.find`); a future implementation must add the current-question check alongside it.

#### `STOP` interaction with any unfinished active-cycle stage — a major decision, closed explicitly and generalized

An earlier version of this document closed this question only for an open `RouteAttempt`. **Corrected: `ACTIVE` (above) spans all three stages — decision-only, attempt-open, and outcome-recorded-but-undisposed — and `STOP`'s interaction must be closed for every one of them, not merely the middle one.**

Three options were weighed, per the governing packet's own framing:

- **(A) An unfinished active-cycle stage at `STOP` time is an acceptable, explicit audit state.**
- **(B) `STOP` must fail closed while any active cycle is unfinished.**
- **(C) `STOP` may proceed only after explicit interrupted-cycle handling.**

**(A) is adopted, for all three stages.** (B) is rejected because it would make `STOP` unreachable in exactly the situations it is most needed: `budget` and `latency` `StopReason`s (already-accepted vocabulary, restated at §18) are precisely the outcomes of a cycle that is *itself* mid-flight and consuming the exhausted budget — forcing `STOP` to wait for that cycle to finish would make the ceiling meaningless, since the one thing exceeding a ceiling is supposed to do is stop the session regardless of what is still running. (C) is rejected because "explicit interrupted-cycle handling" does not exist and is repeatedly, deliberately not designed by this contract (§5's open/unterminated attempt is already accepted as a permanent state with "no automatic retry" and recovery deferred to "an explicitly authorized, fail-closed recovery path," not yet built) — requiring a precondition that has no implementation would make `STOP` just as unreachable as (B), for a different reason.

(A) is also the option every other part of this contract already points toward: an open/unterminated attempt is *already* an accepted permanent audit fact (invariant 22); `STOP` already may hand `STILL_OPEN` questions to `HumanAdjudication` unfiltered (invariant 13, §18) — a human is precisely the right authority to decide what, if anything, to do about a cycle orphaned by `STOP`, exactly as they are already the authority for unresolved questions in general. `STOP` is session-level machine-deliberation termination; it does **not** itself create or need a question cycle, so nothing about any of the three stages below blocks it.

**(1) `STOP` after a decision-only cycle (no `RouteAttempt` yet).** `Q1 -> non-STOP RouteDecision D1 -> no RouteAttempt -> STOP.` Allowed. `D1` remains immutable historical audit truth — "this route had been justified" — but was never attempted. No future `RouteAttempt` may begin for `D1` after `STOP` (§"Post-`STOP` rule," below).

**(2) `STOP` after an open attempt (no `RouteOutcome` yet).** `Q1 -> D1 -> RouteAttempt A1 -> no RouteOutcome -> STOP.` Allowed (the case the earlier version of this document already covered). `A1` remains permanently open/unterminated; no later `RouteOutcome` may be recorded for it.

**(3) `STOP` after a terminal outcome but before disposition — frozen explicitly.** `Q1 -> D1 -> A1 -> RouteOutcome O1 -> no QuestionDisposition yet -> STOP.` Allowed. After `STOP`, `recordQuestionDisposition(O1, ...)` **must reject** (precondition 1 of its complete list, above: `stopReason === null`). `O1` remains an immutable terminal `RouteOutcome` with no `QuestionDisposition` — permanently. `Q1` therefore remains **current / unresolved** at machine-deliberation shutdown, and is handed to `HumanAdjudication` as such. **Nothing fabricates `STILL_OPEN`, `RESOLVED`, or any other disposition merely because `STOP` occurred** — `STOP` ends machine deliberation; it never retroactively completes or resolves what machine deliberation left unfinished.

Concretely, for stage (2) specifically (unchanged from the earlier version): once `STOP` is recorded, `deliberationState.stopReason !== null`, and `recordRouteOutcome`'s existing "already stopped" check (Slice 2D-B1, accepted) already rejects any later outcome for that attempt. This is not a gap to close in any of the three stages; it is the same accepted permanent-audit-state pattern, just triggered by `STOP` instead of (or before) a terminal disposition would otherwise have been reached.

#### Post-`STOP` rule

Once `deliberationState.stopReason !== null`, **no further machine-deliberation mutation is permitted, at minimum**: no new `RouteDecision`, no `RouteAttempt`, no `RouteOutcome`, no `QuestionDisposition`, no `ContextRequest`. Read-only derivation and audit inspection (e.g. computing `isQuestionCurrent`, listing the current-question set for the `HumanAdjudication` handoff) remains allowed — `STOP` ends *machine deliberation*, not the ability to read what it produced.

#### `ACTIVE` cycle after `STOP` — two distinct concepts, never conflated

```
ACTIVE FOR ROUTING
  = deliberationState.stopReason === null
    AND the cycle has not yet received a QuestionDisposition

UNFINISHED HISTORICAL CYCLE AFTER STOP
  = deliberationState.stopReason !== null
    AND the pre-STOP cycle never reached a disposition
```

An unfinished pre-`STOP` cycle may remain, permanently, "without disposition" — that is expected, not an error (above). But it must never be reinterpreted as an *actionable* active cycle once `STOP` has been recorded: after `STOP`, no routing action is permitted regardless of which stage an unfinished cycle sits at (Post-`STOP` rule, above). This distinction exists specifically to avoid a misleading claim that machine deliberation is still "active" after it has terminally stopped — `ACTIVE FOR ROUTING` is a live, actionable state; `UNFINISHED HISTORICAL CYCLE AFTER STOP` is a permanent, inert historical fact for `HumanAdjudication` to see, never for machine deliberation to resume.

#### Snapshot / value semantics (extended)

`QuestionDisposition` and every nested payload it carries — `reason`, and (once implemented) a `SUPERSEDED_RECLASSIFIED` replacement question's own `inputRefs`/lineage fields — follow the same independent-snapshot discipline every other concept in this contract already follows (§7's "Snapshot / value semantics," invariant 20): a caller-owned mutable reference must never be able to silently rewrite `questionDispositions[]` after the fact.

#### Authority (restated)

`QuestionDisposition` does **not**: authorize a `RevisionAction`, mutate `HumanAdjudication`, set `actionChange`, mutate `ReviewFinding`, mutate `SemanticIssue`, or mutate the frozen artifact/context. `HumanAdjudication.actionChange = YES -> RevisionAction` remains the sole gate to revision authority (§17, invariant 19) — entirely unaffected by anything in this section.

#### Schema decisions closed (Slice 2D-B2-0)

**A. Does `QuestionDisposition` need a separate `dispositionId`?** No — `attemptId` is sufficient identity, given the already-fixed `ONE RouteOutcome -> AT MOST ONE QuestionDisposition` cardinality (invariant 27).

**B. Exact generic envelope.** See the derived/supplied/generated table above.

**C. Exact caller vs. derived/generated fields.** Caller: `attemptId`, `disposition`, `reason`, disposition-specific payload where required. Derived: `questionId`, `sessionId`, `artifactHash`, `authorContextHash`. Generated: `createdAt`.

**D. Legal disposition combinations after `FAILED`/`SUCCEEDED`.** See the table above. `CROSS_SESSION` after `FAILED` is illegal; `RESOLVED` after `FAILED` is legal, closed explicitly (not left implicit) — resolution is decided by externally-supplied re-evaluation, never by the attempt's own mechanical status.

**E. Is `CROSS_SESSION` runtime-blocked?** Yes — no attempt-bound `ContextRequest`, `ADD_CONTEXT` success outcome, `SessionVersionLineage`, or Session-B runtime exists yet.

**F. Exact `SUPERSEDED_RECLASSIFIED` replacement-question model.** Caller constructs `Q2` via the existing pure `createUnresolvedQuestion` factory (with `derivedFromQuestionId`); a new, atomic `recordQuestionDisposition` operation independently re-validates `Q2` and, in one returned state, both registers `Q2` and terminally disposes `Q1` — both facts land together or neither does.

**G. Does `derivedFromQuestionId` become a field on `UnresolvedQuestion`?** Yes, confirmed with technical reasoning (a single field, not a parallel lineage collection) — `null` on originally-created questions, `Q1.id` on a replacement, settable *only* through the atomic `SUPERSEDED_RECLASSIFIED` transition, never through ordinary registration.

**H. Does `SUPERSEDED_RECLASSIFIED` belong in the first runtime slice?** No — it requires a material schema change to the already-accepted `UnresolvedQuestion` type; deferred to a later, separately authorized slice (below).

**I. Exact current-question derivation.** `isQuestionCurrent` — true iff no terminal disposition has been recorded; no redundant stored boolean.

**J. Complete current-gate API list.** `planRouteForQuestion`, `recordRouteDecision`, `recordRouteAttemptStart`, `recordRouteOutcome`, `createContextRequest` — all five, confirmed technically (see the table above), not merely asserted.

**K. May one question have parallel active deliberation cycles?** No — at most one `ACTIVE` cycle per current question at a time.

**L. Definition of `ACTIVE`.** A single span from a recorded `RouteDecision` to a recorded `QuestionDisposition` for its eventual outcome — subsuming the decision-only, attempt-only, and outcome-only sub-stages as one continuous active state, not three separate categories.

**M. Where does active-cycle enforcement belong?** Authoritatively at `recordRouteDecision`; `planRouteForQuestion` refuses for the same early-fail-fast reason it already gets the currentness gate; `recordRouteAttemptStart` needs no independent check, since the authoritative gate upstream already prevents the state it would otherwise have to detect.

**N. What does `STOP` do when an open attempt exists?** Proceeds — an explicit, accepted, permanent open/unterminated-attempt audit state, per option (A) above; never fails closed on this basis, and never requires interrupted-attempt handling that does not exist.

**O. How do stale historical attempts behave after a terminal disposition?** They can never record a `RouteOutcome` (the current-question gate on `recordRouteOutcome` rejects them) and remain permanently open/unterminated — the identical pattern as an attempt orphaned by `STOP` (N above), just triggered by a terminal disposition instead.

No governing source-of-truth document contradicts A–O; none required reopening an already-accepted Slice 2A/2B/2C/2D invariant to close.

#### Recommended next runtime slices

Not authorized by this document. Two slices, in this order:

**`SLICE 2D-B2-A` — CURRENTNESS CORE:** `QuestionDisposition` type; `questionDispositions[]` ledger; `STILL_OPEN`/`RESOLVED` only; outcome binding; `isQuestionCurrent`; all five current gates; `recordQuestionDisposition`'s own current/`STOP`/active-cycle preconditions (full list above); the authoritative active-cycle *creation* gate at `recordRouteDecision` (+ `planRouteForQuestion`'s early fail-fast); **and** the independent legacy active-cycle *integrity* validation at `recordRouteAttemptStart`/`recordRouteOutcome`/`recordQuestionDisposition`/`createContextRequest` (`getActiveRouteDecisionsForQuestion`-shaped, above); no `SUPERSEDED_RECLASSIFIED`; no `CROSS_SESSION`. This is the smallest slice that makes currentness and active-cycle enforcement real without touching any already-accepted type's shape.

**Reaffirmed as binding sequencing, not merely a recommendation:** currentness and active-cycle enforcement — including the legacy-integrity validation above — **must** land together in `SLICE 2D-B2-A` as one indivisible hardening unit. They must never be split across separate runtime slices. Splitting them would reopen exactly the gap this amendment corrects: an implementation that lands currentness alone, deferring active-cycle (and its legacy-integrity checks) to a later slice, would leave a window in which the same current question could still have two active decisions recorded against it, because the very re-derivation that would catch that inconsistency is what got deferred.

**`SLICE 2D-B2-B` — SUPERSEDED / DERIVED QUESTION LINEAGE** (later, separately authorized): adds `derivedFromQuestionId` to `UnresolvedQuestion` (the one material schema change deferred out of 2D-B2-A), the atomic `recordQuestionDisposition(SUPERSEDED_RECLASSIFIED, replacementQuestion)` operation, and `registerUnresolvedQuestion`'s corresponding rejection of a non-`null` `derivedFromQuestionId` on the ordinary registration path. Its exact schema is now frozen, in full, by the Slice 2D-B2-B0 freeze immediately below.

`CROSS_SESSION` remains excluded from both — it depends on prerequisites (`ADD_CONTEXT` success, `SessionVersionLineage`) neither slice builds, and belongs in whichever future slice actually builds those.

#### `SLICE 2D-B2-A` — accepted status (recorded here as provenance, not granted by this document)

`SLICE 2D-B2-A` (recommended immediately above) has since been separately authorized, implemented, and accepted by GPT, exactly as scoped. This document records that acceptance as provenance for the freeze below; it neither grants nor amends that authorization, and does not alter §25's authorization ledger, which remains GPT's own to update.

#### Schema freeze (Slice 2D-B2-B0)

This subsection freezes the exact executable architecture for `QuestionDisposition.SUPERSEDED_RECLASSIFIED` and `UnresolvedQuestion.derivedFromQuestionId` — the one item the Slice 2D-B2-0 first-implementation subset (above) deferred. As with that freeze, nothing below is implemented by this document; no `src/**` type, function, or test is added.

**Core architecture question, answered:** the minimum immutable lineage representation is a single field, `UnresolvedQuestion.derivedFromQuestionId: string | null`, written exactly once, only through the atomic `SUPERSEDED_RECLASSIFIED` transition, together with a non-cached global read-time integrity check over the complete `unresolvedQuestions`/`questionDispositions` graph. The forward direction (parent -> child) is derived by scanning for a match, never stored on the parent; the reverse direction (`Q1` was in fact disposed `SUPERSEDED_RECLASSIFIED`) is derived from the already-existing disposition ledger. No second, parallel field is needed on either record, and none is added — duplicating the same relationship in two places would only invent a second synchronization invariant to maintain, not add safety.

##### A. Legacy missing-`derivedFromQuestionId` semantics

Closed. A question registered before this field existed has no `derivedFromQuestionId` key at all. At read boundaries only, missing/`undefined` is interpreted as the legal equivalent of `derivedFromQuestionId: null` — never as an error, and never by mutating the stored record merely to backfill the key. This is safe, not merely convenient: no legitimate `SUPERSEDED_RECLASSIFIED` derivation could exist before this runtime was authorized, so no pre-existing question can legitimately be a replacement question in disguise. This compatibility reading must never be used to excuse a genuine lineage break — a legacy `SUPERSEDED_RECLASSIFIED` disposition with no matching child (§K below) fails closed exactly as a freshly-written one would; "old questions lack the field" is never grounds for treating a broken chain as valid. All newly-created or newly-cloned output — from the factory, from cloning, or from the atomic transition — must materialize an explicit `null` (never leave the key absent); the missing-as-null reading exists solely for reading state that predates the field, never as a shape new code is allowed to produce.

##### B. Canonical `derivedFromQuestionId` shape

Closed, reaffirming the Slice 2D-B2-0 freeze (§9 above) without reopening it: `string | null`, never `string | null | undefined` in canonical (post-factory) output. `null` means original question; a non-empty string means a direct replacement of exactly one prior question, and must equal that question's `id` exactly.

##### C. `createUnresolvedQuestion` factory behavior

Closed. The factory stays pure and state-unvalidating. Its conceptual input gains an optional `derivedFromQuestionId?: string | null`. Omitted or `null` both produce an explicit `null` in the output — never left absent. A non-empty string is required to be non-empty (rejecting `''`/whitespace-only) and is preserved exactly. The factory proves nothing about state: not that the named parent exists, is current, is being superseded, or that registration is authorized — those remain the atomic transition's own, independent responsibility (§H–§J below), exactly as the factory already proves nothing about `inputRefs` resolving against a real session beyond calling the same `validateRouteInputRef` it always has.

##### D. `registerUnresolvedQuestion` (ordinary path) behavior

Closed, reaffirming and formalizing what the Slice 2D-B2-0 freeze already required (invariant 37): the ordinary registration path accepts only an original question. Effective `derivedFromQuestionId` (after the legacy-compatible read, §A) must be `null`; any non-null value is rejected outright. The only path that may ever register a question with a non-null `derivedFromQuestionId` is the atomic `SUPERSEDED_RECLASSIFIED` transition (§H–§J below) — never a standalone call that fabricates lineage to an arbitrary parent with no accompanying terminal disposition on it.

##### E. Single lineage source of truth — no `replacementQuestionId` on the disposition

Closed. `QuestionDisposition` gains no `replacementQuestionId`, and no nested `replacementQuestion` is persisted inside the disposition ledger. The stored lineage fact is exactly one thing, in exactly one place: `Q2.derivedFromQuestionId = Q1.id`. Storing the same relationship a second time on `Q1`'s own disposition record would not add a capability — the forward direction is already answerable by scanning `unresolvedQuestions` for a match — it would only create a second copy of one fact that both future writes and future reads would need to keep synchronized, exactly the kind of self-inflicted integrity risk this contract has consistently refused elsewhere (the `derivedFromQuestionId`-vs-lineage-collection reasoning above applies identically here, one layer down).

##### F. Exact `SUPERSEDED_RECLASSIFIED` input shape

Closed. `recordQuestionDisposition`'s conceptual input becomes a discriminated union on `disposition`. `STILL_OPEN`/`RESOLVED` keep their existing exact shape (`attemptId`, `disposition`, `reason` — no other key). `SUPERSEDED_RECLASSIFIED`'s exact shape is `attemptId`, `disposition`, `reason`, `replacementQuestion` — and no other key. `replacementQuestion` is caller-owned (typically, but not necessarily, the direct output of `createUnresolvedQuestion`) and must be independently revalidated from scratch (§H), never trusted merely because it has the right shape. Exact-key rejection (the same discipline already governing every other input in this runtime) applies in both directions: a `SUPERSEDED_RECLASSIFIED` input carrying `replacementQuestionId`, `newQuestionId`, `parentId`, a top-level `derivedFromQuestionId`, `lineage`, `newSessionId`, or `actionChange` is rejected; a `STILL_OPEN`/`RESOLVED` input carrying `replacementQuestion` is equally rejected. `CROSS_SESSION` remains excluded from `RecordableQuestionDispositionKind` entirely (unchanged, §9 above).

##### G. Stored `QuestionDisposition` shape

Closed. The persisted envelope does not change shape for `SUPERSEDED_RECLASSIFIED` — it is exactly the same generic envelope already frozen (`attemptId`, `questionId`, `sessionId`, `artifactHash`, `authorContextHash`, `disposition`, `reason`, `createdAt`) with `disposition = 'SUPERSEDED_RECLASSIFIED'`. No extra replacement-identity field is stored on it (§E) — `Q2` itself carries the lineage back to `Q1`, not the other way around.

##### H. Replacement `Q2` validation (minimum exact checks)

Closed, exhaustive. The atomic transition independently re-validates `replacementQuestion` from scratch — never trusting it arrived pre-validated, mirroring `recordRouteOutcome`'s posture toward its own caller-supplied payload:

- `id`: non-empty; distinct from `Q1.id`; not already present in `unresolvedQuestions` (the existing duplicate-id rule, unchanged).
- `rootCause`: a valid `RootCauseCategory`; must not be `NONE` (the existing "`NONE` maps to `STOP`, never a registered question" rule, unchanged).
- `materialityReason`: the existing non-empty rule, unchanged.
- `inputRefs`: non-empty; every ref independently valid against the current `StressTestSession` (unchanged); independently snapshotted, never aliased to the caller's array (§Q below).
- `createdAt`: must be present and parseable; the atomic transition preserves the exact value it is given rather than silently regenerating it — the same "never silently regenerate a caller/factory-supplied fact" posture `RouteOutcome.completedAt`/`QuestionDisposition.createdAt` take in the *opposite* direction (those are always runtime-generated, never caller-supplied; `UnresolvedQuestion.createdAt` has always been factory-generated-once-and-preserved-through-registration, unchanged since Slice 2B — this freeze reaffirms that split for the replacement question specifically, it does not alter it).
- `derivedFromQuestionId`: must exactly equal `Q1.id` — not merely non-null, not merely a well-formed string.

Any failure here rejects the entire transition; nothing is partially registered.

##### I. Existing-child check (write-time)

Closed. Before superseding `Q1`, the transition counts already-registered questions whose *effective* `derivedFromQuestionId` (§A) equals `Q1.id`. Required: exactly `0`. If `1` already exists, reject — `Q1` already has a replacement; a second is a fork (§J), never permitted. If `>1` already exists, reject as inconsistent state (§J) — the same "never automatically reconciled" posture as every other cardinality violation in this contract. The atomic transition itself is the only mechanism ever authorized to create the one permitted direct child.

##### J. Cardinality

Closed. One superseded parent has at most one direct child through derived lineage, and a derived child has exactly one direct parent. A chain (`Q1 -> Q2 -> Q3`) is valid; a fork (`Q1` claimed as parent by both `Q2` and `Q3`) is not. This is enforced going forward at write time (§I) and independently re-validated at read time in both directions (§K), because — the lesson already carried forward from the Slice 2D-B2-0 amendment — a write-time gate alone cannot retroactively guarantee anything about state that predates it or about state a write path never touches.

##### K. Read-time lineage integrity — both directions

Closed, exhaustive, fail-closed, never automatically reconciled:

- **Reverse (child -> parent), for every registered `Q2` with effective `derivedFromQuestionId = Q1.id`:** exactly one `Q1` must exist; `Q1.id != Q2.id`; **corrected wording (Slice 2D-B2-B amendment) — `Q1` must have exactly one *terminal* `QuestionDisposition`, and that terminal disposition must be `SUPERSEDED_RECLASSIFIED`; `Q1` may additionally have any number of earlier `STILL_OPEN` records from prior completed cycles — "exactly one `QuestionDisposition` total" was too strong and conflicted with the already-accepted "any number of prior `STILL_OPEN`" model (§9 "Terminality")**; `Q1` and `Q2` must share the same session/artifact/author-context binding; `Q2` must be the unique direct child of `Q1` (no sibling fork). Any violation — an orphan `Q2` whose named parent does not exist, has no terminal disposition, has a terminal disposition other than `SUPERSEDED_RECLASSIFIED`, has more than one terminal disposition (e.g. a tampered `RESOLVED` + `SUPERSEDED_RECLASSIFIED` pair for the same `Q1`, in either order), or has more than one claimed child — is invalid.
- **Forward (parent -> child), for every `QuestionDisposition` with `disposition = SUPERSEDED_RECLASSIFIED` targeting `Q1`:** exactly one `Q2` must exist with effective `derivedFromQuestionId === Q1.id`. `0` (a superseded parent with no replacement ever registered) is invalid. `>1` (a fork) is invalid. There is no latest-child winner and no first-child winner.

##### L. Cycle handling

Closed. Derived lineage must be acyclic. Self-reference (`Q1.derivedFromQuestionId = Q1.id`), a two-question cycle (`Q1 -> Q2 -> Q1`), and any longer cycle are all invalid. No timestamp-based arbitration ever breaks a cycle — a cycle is simply invalid, full stop. The accepted atomic write path (§H–§J) can never construct one on its own, but read-time validation must still detect one in tampered, hand-constructed, or legacy state — the same posture already taken toward every other integrity property in this section, consistent with this contract's standing refusal to let "the write path would never do this" stand in for an actual read-time check (the active-cycle `>1` case, §9 above, already established this precedent).

##### M. Currentness — no change required

Confirmed, not newly decided: `isQuestionCurrent`'s existing formal definition (§9 above, "Current-question derivation") already treats `SUPERSEDED_RECLASSIFIED` as terminal, identically to `RESOLVED` and `CROSS_SESSION` — it was written disposition-kind-agnostic from the start. Implementing `SUPERSEDED_RECLASSIFIED` therefore requires no change to that definition's *logic* — only, per §O below, that it run the new global lineage-integrity check before answering.

##### N. Active-cycle integration — no redesign; transitive coverage confirmed

Closed: `getActiveRouteDecisionsForQuestion`'s existing definition (§9 above) is already disposition-kind-agnostic — it does not inspect *which* disposition, so a cycle closed by `SUPERSEDED_RECLASSIFIED` ends it exactly as `RESOLVED`/`STILL_OPEN` already do. No redesign of the cycle state machine is needed or authorized. Explicitly inspected, per the governing packet's own instruction: `planRouteForQuestion`, `recordRouteDecision`, `recordRouteAttemptStart`, `recordRouteOutcome`, and `createContextRequest` all reach their currentness/active-cycle behavior *transitively*, through their existing (2D-B2-A) calls to `isQuestionCurrent`/`getActiveRouteDecisionsForQuestion` — provided the new global lineage-integrity check (§O) is invoked inside `isQuestionCurrent` itself, every one of those five call sites inherits it automatically, with no direct code change to any of the five. `refsExactlyMatch` requires no change — it operates on `RouteInputRef` arrays and has no relationship to question lineage.

##### O. Global lineage read-integrity boundary

Closed. A future, pure, non-cached helper — name not binding, conceptually `assertDerivedQuestionLineageIntegrity(state)` — validates the *complete* derived-lineage graph (every registered question's effective `derivedFromQuestionId`, cross-checked against every disposition) in one pass. **Exact internal ordering, corrected (Slice 2D-B2-B amendment):**

1. Global `UnresolvedQuestion.id` non-emptiness and uniqueness (identity before any local derivation).
2. Structural derived-graph checks: self-reference, then acyclicity (§L) — a broken *shape* is reported before this function tries to interpret what a (possibly cyclic) chain's dispositions mean.
3. `QuestionDisposition` ledger validation: per-`attemptId` cardinality (`ONE RouteOutcome -> AT MOST ONE QuestionDisposition`, invariant 27) **and** per-`questionId` lifecycle terminality (`STILL_OPEN*` then an optional single terminal disposition, in ledger append order — never `createdAt`/timestamp arbitration; §9 "Terminality," §19; Slice 2D-B2-B amendment).
4. Semantic lineage checks: reverse (child -> parent, §K), fork detection, and forward (parent -> child, §K) — only reached once identity, structure, and ledger lifecycle are already confirmed sound, so an individually-plausible-looking but globally-invalid parent (e.g. a tampered `RESOLVED` + `SUPERSEDED_RECLASSIFIED` pair for the same `Q1`) is already rejected at step 3, before step 4 ever gets to ask whether that `Q1`'s child is valid.

This must run before any *local* question is answered, for the same reason the disposition ledger is re-validated globally before a local query narrows to one question (§9 above) — global corruption can change the correct interpretation of a query that looks local. Exact invocation boundary, closed: `isQuestionCurrent` runs it once, at entry, on the full state; `recordQuestionDisposition`'s `SUPERSEDED_RECLASSIFIED` branch runs it once, before writing (in addition to, not instead of, its existing precondition list, §9 above). `getActiveRouteDecisionsForQuestion` does **not** independently re-run it — within a single call chain, once `isQuestionCurrent` (or an equivalent entry check) has validated the immutable state snapshot that call is operating on, no further internal derivation in that same call needs to repeat an unchanged fact about the same unchanged state. This is not a relaxation of "never trust an upstream check" — that principle governs trust *across separate calls/operations* (exactly why `recordRouteAttemptStart` cannot rely on `recordRouteDecision`'s gate, §9 above); it says nothing about redundantly re-scanning the same immutable snapshot multiple times *within* one function's own execution. The helper itself is never cached or persisted across calls — every independent call re-validates from scratch.

##### Atomic transition — complete step list

Closed, superseding the illustrative (non-exhaustive) sketch given earlier in this section with the complete, exact sequence:

1. Verify `DeliberationState`/`StressTestSession` binding (unchanged).
2. Require `deliberationState.stopReason === null` (already precondition 1 of `recordQuestionDisposition`'s general list, §9 above — restated, not duplicated, for this branch).
3. Resolve exactly one `RouteOutcome -> RouteAttempt -> RouteDecision -> Q1` chain (already precondition 3 of the general list — restated, not duplicated).
4. Require `Q1` current, and require exactly one active cycle for `Q1` matching the exact decision represented by the supplied `attemptId` (already preconditions 2 and 4 of the general list — restated, not duplicated).
5. Reject if the targeted `RouteOutcome` already has a `QuestionDisposition` (already precondition 5 — restated, not duplicated; invariant 27).
6. Run the global lineage-integrity check (§O) over the state as it stands before this write.
7. Run the existing-child check (§I): exactly zero questions may already claim `derivedFromQuestionId = Q1.id`.
8. Independently validate `replacementQuestion` (§H) in full.
9. Atomically produce one returned `DeliberationState` in which `Q2` is appended to `unresolvedQuestions` (independently snapshotted, below) **and** `Q1`'s `SUPERSEDED_RECLASSIFIED` disposition is appended to `questionDispositions` — both facts land together, or the call throws and neither lands.

Steps 2–5 are the same preconditions every `recordQuestionDisposition` call already enforces (§9 above); steps 6–9 are the `SUPERSEDED_RECLASSIFIED`-specific additions this freeze closes.

##### Snapshot semantics for `Q2`

Closed, restating the existing "Snapshot / value semantics (extended)" rule (§9 above) for this specific caller-owned payload: on a successful transition, both `replacementQuestion` and `replacementQuestion.inputRefs` are independently snapshotted before being stored. Caller mutation of the object passed in must never be able to alter `unresolvedQuestions[]` or `questionDispositions[]` after the call returns — no aliasing, in either direction.

##### Human authority — unaffected, restated

`SUPERSEDED_RECLASSIFIED` does not set `actionChange`, create or mutate `HumanAdjudication`, create `RevisionAction`, or mutate the frozen artifact, `AuthorContext`, `ReviewFinding`, or `SemanticIssue`. `HumanAdjudication.actionChange = YES -> RevisionAction` remains the sole revision gate (§17, invariant 19) — entirely unaffected, exactly as every other `QuestionDisposition` kind already is (§9 above).

##### `SLICE 2D-B2-B` blast radius — exact function list

Closed. Functions a future, separately authorized `SLICE 2D-B2-B` runtime implementation is expected to touch:

- `UnresolvedQuestion` — add `derivedFromQuestionId: string | null`.
- `createUnresolvedQuestion` — accept optional `derivedFromQuestionId`, default/normalize to explicit `null` (§C).
- `cloneUnresolvedQuestion` — copy `derivedFromQuestionId` (a scalar field; no new aliasing concern).
- `registerUnresolvedQuestion` — reject non-null effective `derivedFromQuestionId` (§D; formalizes already-frozen invariant 37).
- `RecordableQuestionDispositionKind` — add `SUPERSEDED_RECLASSIFIED`.
- `RecordQuestionDispositionInput` — become a discriminated union; add the `SUPERSEDED_RECLASSIFIED` variant carrying `replacementQuestion` (§F).
- `recordQuestionDisposition` — add the `SUPERSEDED_RECLASSIFIED` branch implementing the atomic step list above.
- `assertLedgerQuestionDispositionIntegrity` — extend its allowed-kind check to include `SUPERSEDED_RECLASSIFIED`; no other change to its existing logic.
- A new derived-lineage integrity helper (§O) — new code, not a modification of an existing function.
- `isQuestionCurrent` — invoke the new helper (§O) at entry; no change to its terminal-disposition logic itself (§M).
- Tests/fixtures — scope determined at implementation time, not by this document.

Confirmed to need **no** direct change, gaining correct behavior transitively (§N) or being structurally unrelated: `planRouteForQuestion`, `recordRouteDecision`, `recordRouteAttemptStart`, `recordRouteOutcome`, `createContextRequest`, `getActiveRouteDecisionsForQuestion`, `resolveUniqueRouteDecisionById`, `validateAttemptProvenanceForOutcome`, `refsExactlyMatch`, `applyCostSpend`, `applyLatencySpend`.

#### Schema decisions closed (Slice 2D-B2-B0)

**A–O map exactly to the lettered subsections immediately above** (§A legacy semantics, §B canonical shape, §C factory, §D ordinary registration, §E single source of truth, §F exact input shape, §G stored shape, §H replacement validation, §I existing-child check, §J cardinality, §K read-time integrity, §L cycles, §M currentness, §N active-cycle integration, §O global lineage boundary) — recorded together here, in one place, rather than repeated, mirroring how the Slice 2D-B2-0 freeze indexes its own A–O above.

No governing source-of-truth document contradicts A–O; none required reopening an already-accepted Slice 2A/2B/2C/2D-B0/2D-B2-0/2D-B2-A invariant to close. This freeze introduces zero new open decisions (§24 below).

---

## 10. Route success does not equal question resolution

Binding invariant. `AttemptStatus` and `QuestionDisposition` are answers to two different questions and must never be read as implying one another.

| Scenario | Attempt status | Question disposition |
|---|---|---|
| `REPLICATE` succeeds; finding reproduces | `SUCCEEDED` | Still requires explicit re-evaluation — may remain `STILL_OPEN` or resolve, depending on what reproduction implies for the original stability question |
| `TARGETED_PEER_CHALLENGE` succeeds; both positions remain defensible | `SUCCEEDED` | May remain `STILL_OPEN` — a complete, valid response does not itself dissolve the conflict |
| `SEEK_EVIDENCE` completes; evidence is inconclusive | `INCONCLUSIVE` | May remain `STILL_OPEN` — the lookup's own indeterminacy does not resolve anything by itself |
| `ADD_REVIEWER` completes; finds nothing material | `SUCCEEDED` | Still requires explicit re-evaluation before the coverage gap is treated as closed |

No route's `SUCCEEDED` status is ever read, by itself, as `QuestionDisposition = RESOLVED`. Resolution is always a separate, explicit act (§14).

---

## 11. Failure / fallback / retry binding

Carries forward `MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md` §13's fallback rule unchanged, extended to the attempt layer:

```
route attempt fails
  -> preserve the last defensible checkpoint
  -> record the failure (RouteOutcome, status=FAILED)
  -> re-classify all currently-unresolved material items from scratch (§5 of the routing contract)
  -> select another route only if independently justified
  -> otherwise STOP
```

No automatic retry, ever. A retry of the very same route that just failed requires:

```
NEW RouteDecision  ->  NEW RouteAttempt
```

Never reuse a failed attempt's identity. Never overwrite failed-attempt history — a `FAILED` `RouteOutcome` is a permanent, immutable historical fact exactly like a `SUCCEEDED` one; a later successful retry does not delete, hide, or supersede it. `INCONCLUSIVE` attempts follow the identical rule: they are not retried automatically, and a fresh attempt at the same or a different route requires its own fresh `RouteDecision`.

---

## 12. Cost / latency accounting for actual attempts

Extending `MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md` §12's pure-counter model to actual attempts:

- Planning a `RouteDecision` costs zero provider-call units — planning is pure and offline today (`planRouteForQuestion`) and stays that way.
- An actual `RouteAttempt` consumes logical cost when the route is provider/retrieval-backed (every route except `ADD_CONTEXT` and `STOP`, §13).
- `FAILED` and `INCONCLUSIVE` attempts may still consume cost and latency — a failed or indeterminate call was still made and still cost something; spend is never waived because the outcome was unhelpful.
- Spend is append/audit based: `applyCostSpend`/`applyLatencySpend` (accepted, unchanged) never decrement — no failed attempt's spend is ever hidden by reversing it.
- Explicit finite ceilings remain non-negotiable (`MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md` §12, §16 invariant 18): a missing provider-runtime ceiling is a precondition failure for enabling any attempt runtime, not a default of "no limit."
- `transportMaxRetries` remains RESEARCH_ONLY and is not introduced here, exactly as before.
- No numeric production ceiling is chosen by this document.

### Cost accounted at attempt start, not at outcome

For provider/retrieval-backed routes, the logical cost budget must be validated and the route's logical call cost accounted **when the `RouteAttempt` begins — before the external call is made**, not when a `RouteOutcome` is eventually recorded:

```
start RouteAttempt
  -> validate the finite CostBudget has room
  -> account the route's logical call cost
  -> external execution may then begin
```

This ordering exists precisely because a process that crashes after sending a provider request must not make that cost disappear merely because no `RouteOutcome` was ever recorded (§5, open/unterminated attempts). Cost already accounted at attempt start is **never reversed** — not because the attempt failed, not because it was inconclusive, and not because the process lost the response and left the attempt open.

`ADD_CONTEXT`'s logical provider-call cost is `0` — it is human context acquisition, not a model call (§13.A). `STOP` has no `RouteAttempt` and therefore no attempt cost at all (§5).

### Latency accounted at completion

Latency remains associated with the `RouteOutcome` where it is actually measured — an attempt's duration is only knowable once it terminates. If an attempt never receives a defensible `RouteOutcome` (an open/unterminated attempt, §5), no terminal latency value is fabricated merely to make the record look complete. A future execution/recovery layer may define a conservative accounting rule for interrupted-attempt latency, but that is an execution-runtime concern, not authorized or designed here — it is never a reason to mutate or erase the open `RouteAttempt` itself.

---

## 13. Route-specific outcome semantics

### A. ADD_CONTEXT

Not a model/provider route — human context acquisition. Immediate route output remains `ContextRequest` (accepted, unchanged). The `RouteOutcome` result payload is one of three determinate values: `SUPPLIED` | `DECLINED` | `NO_RESPONSE`. All three are `AttemptStatus = SUCCEEDED` — asking a human and recording what happened is a mechanism that completes determinately in every one of these cases; none is a technical failure. (A genuine delivery failure of the request itself — the mechanism could not even present the request — is the one path to `FAILED` here.)

Conceptual lifecycle when context is supplied:

```
Session A (artifactHash_A, authorContextHash_A)
 -> Q1 CONTEXT_GAP
 -> ADD_CONTEXT RouteDecision -> RouteAttempt -> ContextRequest
 -> human response: SUPPLIED
 -> RouteOutcome(result=SUPPLIED)
 -> Q1 QuestionDisposition = CROSS_SESSION
 -> SessionVersionLineage A -> B
 -> Session B, DRAFT
 -> new AuthorContextItem added while B is DRAFT
 -> freeze B -> (artifactHash_B, authorContextHash_B)
 -> new review/deliberation proceeds against Session B
```

Rules, unchanged from the routing contract: no unfreeze; no mutation of Session A; `Q1` remains historical under Session A, never copied as current into Session B; Session A's findings remain historical; Session B gets its own, newly-bound current review state. `DECLINED` and `NO_RESPONSE` both leave `Q1`'s disposition `STILL_OPEN` against the unchanged, still-current Session A — no lineage record is produced for either. No versioning is implemented by this document.

#### Schema freeze (Slice 2D-C3-0): `CROSS_SESSION` / `SessionVersionLineage`

`SessionVersionLineage` has been named, unscheduled, since `MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md` §8 ("Version lineage (cross-session boundary)"), which deliberately left "the exact persisted type or name for this record... not chosen." This freeze closes that deferred choice, together with the complete atomic transition architecture the Slice 2D-C0/C1/C2 chain (`ContextRequest.originatingAttemptId`, the request ledger, `AddContextSuppliedRouteOutcome`) now makes possible. Nothing below is implemented; no `src/**` type, function, or test is added.

**Core architecture question, answered:** the immutable lineage fact is a dedicated `SessionVersionLineage` record — its own identity (`lineageId`), never overloaded onto `childSession.id` — that independently re-derives and freezes the complete provenance chain (`RouteOutcome -> RouteAttempt -> RouteDecision -> Q1` and `RouteOutcome -> ContextRequest -> RouteAttempt`, both re-validated against the current `DeliberationState`/`StressTestSession A` binding) at the moment of transition, and is created **atomically** with Session B and Q1's `CROSS_SESSION` disposition -- one operation, one return, or none of the three facts exists. Session A itself is never touched: the lineage record, like every other audit fact in this contract, lives in `DeliberationState A`, not in either session's own domain state.

##### A. Is `SessionVersionLineage` required?

Closed: YES. `QuestionDisposition = CROSS_SESSION` only states that Q1 stopped being current under Session A; it does not identify Session B, which `SUPPLIED` outcome caused the transition, the old/new hashes, or which `AuthorContextItem` was introduced. Those facts require an explicit record — the same "a disposition-kind boolean is never enough, a nested single field is never enough" reasoning already applied to `QuestionDisposition` itself (§9 above) and to `derivedFromQuestionId` (§9, Slice 2D-B2-0).

##### B. Lineage identity

Closed: a fresh, runtime-generated `lineageId: string`, **not** `childSession.id`. Confirmed by analysis, not merely by not overloading it on principle: this accepted architecture's atomicity rules (§E below) do make one child session and one lineage record 1:1 in every case the runtime can ever produce — but `childSessionId` is still the wrong identity to reuse, for two independent reasons. First, a session's own `id` is generated by `createSession` for a purpose that has nothing to do with lineage (an ordinary session, `createSession`'s only caller today, never has a lineage record at all); reusing it would make `SessionVersionLineage`'s identity accidentally *inherited* from an unrelated concept's lifecycle, rather than born with the record itself, unlike every other identity in this contract (`RouteDecision.id`, `RouteAttempt.attemptId`, `ContextRequest.id`, `UnresolvedQuestion.id` are all freshly generated at the point their own concept is created). Second, the primary lookups this record needs — "has this `suppliedOutcomeAttemptId` already produced a lineage" (§O below) — key on `suppliedOutcomeAttemptId`, not on `childSessionId`; overloading the child's own id buys no lookup benefit while giving up identity independence for free.

##### C. Lineage fields

Closed, the complete set, none removed:

```
SessionVersionLineage {
  lineageId                  -- fresh identity (§B)
  parentSessionId             -- derived; == DeliberationState A's own sessionId (re-verified, not restated)
  childSessionId               -- the newly created Session B's id
  parentArtifactHash            -- copied audit-mirror of Session A's frozen artifactHash at transition time
  parentAuthorContextHash        -- copied audit-mirror of Session A's frozen authorContextHash at transition time
  childArtifactHash                -- Session B's own frozen artifactHash
  childAuthorContextHash             -- Session B's own frozen authorContextHash
  originatingQuestionId                -- derived-and-copied convenience field (§ below), re-verified against the resolved attempt/decision chain
  suppliedOutcomeAttemptId              -- the exact RouteAttempt/RouteOutcome identity that authorized this transition
  contextRequestId                       -- derived-and-copied convenience field, re-verified === the resolved RouteOutcome's own contextRequestId
  addedAuthorContextItemId                -- the exact new AuthorContextItem created in Session B (load-bearing, not derivable from anything else)
  createdAt                                -- runtime-generated
}
```

`originatingQuestionId` and `contextRequestId` are not new independent facts — both are already derivable by chasing `suppliedOutcomeAttemptId` through the resolved chain — but they are kept as derived-and-copied convenience fields, exactly the same discipline already applied to `RouteOutcome.originatingQuestionId` (§7) and `ContextRequest.originatingQuestionId` (§7, Slice 2D-C0 freeze): a reader of `SessionVersionLineage` alone can answer "which question, which request, which session, which item" without a second lookup, and every copy is independently re-verified against its source chain, never independently caller-authoritative. `responseText` is deliberately **not** duplicated onto the lineage record — it is already authoritative on `O1.responseText` and is copied verbatim into the new `AuthorContextItem.text` (§H below); a third copy would be exactly the unjustified duplication this contract has refused everywhere else. No `parentDeliberationStateId` field is needed: `SessionVersionLineage` lives *inside* `DeliberationState A`'s own ledger (§D below), so every read of it is already scoped to the correct parent `DeliberationState` instance by construction — there is no registry anywhere in this runtime that looks a `DeliberationState` up by id, so a field pointing back to "which one" would have nothing to resolve against.

##### D. Lineage ownership / storage

Closed, resolving §13 and §36 of the governing packet together rather than as two separate answers: `DeliberationState.sessionVersionLineages: SessionVersionLineage[]`, an append-only ledger on the **parent** `DeliberationState A` -- the same pattern `outcomes[]`, `questionDispositions[]`, and `contextRequests[]` already establish. The atomic transition operation (§K below) *also* returns the freshly-created record directly to the caller (so it can be presented or acted upon immediately without re-deriving it from the returned state) -- but the returned value and the persisted ledger entry are the same fact recorded twice for two different consumers, not two competing storage designs. Persistence is not optional: without it, §O's "at most one child session per `SUPPLIED` outcome" rule would be unenforceable on any call after the first, since nothing would remain to check against. A separate product-level or cross-session global ledger (option D of §13) is rejected as unjustified infrastructure -- `DeliberationState A` is already the authoritative home for every other audit fact this transition produces (the `CROSS_SESSION` disposition itself lives there), so the lineage record belongs beside it, not in a new structure invented solely for this one concept.

##### E. Cardinality

Closed, three independent rules: (1) **one child `StressTestSession` -> exactly one parent** through this mechanism -- no merge-session semantics, a child never claims two parents; (2) **`ONE ADD_CONTEXT SUPPLIED RouteOutcome -> AT MOST ONE SessionVersionLineage`/child session** -- the same human response must never silently fork into multiple session versions under one transition identity; a genuinely-needed second branch requires a separately-designed, explicitly-authorized branching architecture, not accidental reuse of this mechanism; (3) **`ONE DeliberationState.sessionVersionLineages[]` entry -> exactly one `childSessionId`**, and no two entries may ever share a `childSessionId` (a direct consequence of (1) combined with `createSession` always minting a fresh id). All three mirror cardinality shapes already frozen elsewhere in this contract (`ONE RouteDecision -> AT MOST ONE RouteAttempt`, invariant 9; `ONE ADD_CONTEXT RouteAttempt -> AT MOST ONE ContextRequest`, invariant 50).

##### F. Session B construction model

Closed: option B -- Session B is a wholly **new** `StressTestSession` (a fresh `createSession`-equivalent identity), reconstructed from Session A's `artifactText` plus Session A's `AuthorContext` plus the one newly-supplied item -- never a copy-then-mutate of Session A's own object. Session A's own `id`, `state`, `frozenAt`, `artifactHash`, `authorContextHash`, and every domain record are untouched by this operation; `verifyFrozenInputIntegrity(sessionA)` would find it byte-for-byte identical to before the transition, exactly the existing runtime guarantee this contract has never permitted routing to weaken.

##### G. Artifact / hash semantics across the version boundary

Closed, confirmed against the actual hash implementation (`src/stress-test/session.ts`, `sha256Text`/`sha256AuthorContext`), not assumed: `artifactHash = sha256Text(session.artifactText)` is a pure function of `artifactText` alone -- no other field participates. Because `ADD_CONTEXT` adds author context, never a revised artifact, Session B's `artifactText` is byte-for-byte identical to Session A's, and therefore **`childArtifactHash === parentArtifactHash` deterministically**, not merely by convention -- confirmed as an equation, not a probabilistic expectation. `authorContextHash = sha256AuthorContext(session.authorContext)` is a pure function of the complete `AuthorContext` structure; Session B's `AuthorContext` differs from Session A's by exactly the one newly-added item (§H below), so **`childAuthorContextHash` is the correct recomputation over Session B's actual, differing `AuthorContext`** -- the governing packet's own caution against overclaiming cryptographic non-collision is respected: this freeze does not assert "the hashes must differ" as an invented axiom, only that each hash is independently, correctly recomputed over its own session's actual content, which in every non-pathological case yields a different value because the content differs.

##### H. `AuthorContext` transition / new item construction

Closed. Session B's `AuthorContext` is exactly: every `AuthorContextItem` from every category of Session A's `AuthorContext`, independently snapshotted (never aliased to Session A's own arrays), **plus** exactly one new item constructed as:

```
category:  ContextRequest(R1).category           -- never caller-restated (§ below)
text:      AddContextSuppliedRouteOutcome(O1).responseText  -- never caller-restated, never trimmed/rewritten/classified
sourceType: 'AUTHOR'                              -- a human supplied it, in response to the system's own request
status:    'CURRENT'                              -- the existing addAuthorContextItem default; not superseding anything in Session A (Session A's own items are never touched)
id:        generated by the existing addAuthorContextItem/AuthorContextItem identity mechanism -- no second, transition-specific id scheme
```

No item is omitted from Session A's copy, and the one new item is added exactly once -- never duplicated, never aliased to a mutable reference the caller could later use to rewrite Session B's history after the fact (§ "Alias isolation" below).

##### `category` provenance (packet §19)

Closed: the new item's `category` is `R1.category` exactly -- `ContextRequest` already carries this fact from when the request was created (§7, Slice 2D-C0 freeze), and restating it as new caller input to the transition operation would reopen exactly the caller-divergence risk this contract has refused at every other boundary (`createContextRequest` itself no longer accepts a caller-restated `questionId`, for the identical reason).

##### `text` provenance (packet §20)

Closed: the new item's `text` is `O1.responseText` exactly, copied verbatim -- not trimmed, not summarized, not restated through a new caller-supplied field. `responseText` is already the accepted immutable response fact (§7, Slice 2D-C2); inventing a second, independently-caller-suppliable text field for the transition would let a caller substitute different content than what the human actually supplied, which this contract's "never trust a caller-restated derived fact" posture (§14 of the routing contract, restated at every layer since) exists specifically to prevent.

##### I. Session B's lifecycle state through the transition

Closed, decision made (this was left open by the governing packet's own §26, evaluated here rather than deferred): the atomic transition operation performs `createSession`-equivalent construction, copies Session A's `AuthorContext` items plus the one new item, **and freezes B**, returning it already in `INPUT_FROZEN` -- option B of the packet's own framing, and the *only* option consistent with this operation's own atomicity contract (§L below). The packet's stated condition for choosing this ("if and only if no additional caller-authored context is expected between creation and freeze") is satisfied by construction: this operation's entire contract is "given exactly one already-resolved `SUPPLIED` outcome, deterministically produce exactly Session A's context plus that one supplied item" -- there is no step at which the caller could supply *additional* authored context without inventing an entirely different, wider operation. Returning B still in `DRAFT` would only manufacture an artificial extra step (a caller-remembered `freezeInput` call) for no benefit, and would leave a session that structurally *must* be frozen sitting unfrozen between calls -- exactly the kind of half-finished intermediate state this contract's atomicity/snapshot discipline exists to avoid everywhere else (§L, §30 of the governing packet).

##### J. What is NOT copied from Session A

Closed, explicit, no partial reuse: Session B's `findings`, `semanticIssues`, `adjudications`, and `revisionActions` all start **empty** (`createSession`'s own accepted defaults) -- Session A's `ReviewFinding`/`SemanticIssue`/`HumanAdjudication`/`RevisionAction` records remain historical, bound forever to Session A's own `artifactHash`/`authorContextHash` (§9 of `MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md`: "findings are bound to the exact artifactHash/authorContextHash pair under which they were produced"). No `DeliberationState` is carried into Session B by this operation -- Session B has no `DeliberationState` at all until some later, separately-invoked `createDeliberationState(sessionB, ...)` call, which itself requires Session B to already be `REVIEWED` (unchanged existing precondition) before it can run; nothing about this transition shortcuts that lifecycle. `Q1` itself is **not** copied into Session B as a registered `UnresolvedQuestion` -- Session B has no registered questions at all until its own, later review/deliberation cycle derives them from its own frozen input; Q1 remains exactly what it always was, a historical, terminally-`CROSS_SESSION`-disposed record under Session A.

##### K. `CROSS_SESSION` operation input / API shape

Closed: one atomic higher-level operation, conceptually

```
createCrossSessionTransition(
  session: StressTestSession,           -- Session A
  deliberationState: DeliberationState, -- DeliberationState A
  input: { suppliedOutcomeAttemptId: string }
): {
  session: StressTestSession,            -- Session A, unchanged (returned for API symmetry with every other function in this module, not because it differs)
  deliberationState: DeliberationState,   -- DeliberationState A, +1 QuestionDisposition(CROSS_SESSION), +1 sessionVersionLineages[] entry
  childSession: StressTestSession,       -- Session B, INPUT_FROZEN (§I)
  lineage: SessionVersionLineage,        -- the same fact just appended into deliberationState.sessionVersionLineages
}
```

never a standalone extension of `recordQuestionDisposition(..., 'CROSS_SESSION', { childSessionId })` (the governing packet's own explicit rejection, §28-29): a caller-supplied `childSessionId` on a standalone disposition call could reference a session that does not exist, was not actually derived from this outcome, or already has a different lineage -- exactly the "arbitrary derivation chain attachment" this contract has refused at the `SUPERSEDED_RECLASSIFIED` boundary (§9, Slice 2D-B2-B0 freeze) and now refuses here for the identical reason. The single input, `suppliedOutcomeAttemptId`, is deliberately minimal: every other fact (`questionId`, `contextRequestId`, `responseText`, both sessions' hashes) is resolved from that one identity through the chain (§N below), never restated by the caller.

##### L. Atomic disposition + child + lineage semantics

Closed: `createCrossSessionTransition` either produces all three facts together in one returned bundle (Q1's `CROSS_SESSION` disposition, Session B, the `SessionVersionLineage` record) or the call throws and **none** of them exists -- no disposition without a child, no child without a lineage record, no lineage record without the disposition. This is not a new invariant category; it is the same "atomic dual/triple write" discipline already frozen for `recordQuestionDisposition`'s `SUPERSEDED_RECLASSIFIED` branch (§9, Slice 2D-B2-B0/B freeze: "either both facts land in the returned state, or neither does"), extended from two facts to three because this transition produces one more artifact than a same-session disposition ever needs to.

##### M. `QuestionDisposition` stored shape

Closed: **unchanged**. No `childSessionId` field is added to `QuestionDisposition`'s generic envelope (§9). The `CROSS_SESSION` disposition continues to carry exactly `attemptId`, `questionId`, `sessionId`, `artifactHash`, `authorContextHash`, `disposition`, `reason`, `createdAt` -- identical in shape to `RESOLVED`/`STILL_OPEN`/`SUPERSEDED_RECLASSIFIED`. The actual cross-session relationship belongs entirely to `SessionVersionLineage`, which already carries `originatingQuestionId` and `suppliedOutcomeAttemptId` -- storing the same relationship a second time on the disposition record would be exactly the duplicated-lineage-truth hazard this contract refused for `SUPERSEDED_RECLASSIFIED` (no `replacementQuestionId` on that disposition either, §9, decision E of the Slice 2D-C0... consistent precedent, Slice 2D-B2-B0 decision E). `SessionVersionLineage.suppliedOutcomeAttemptId` is deliberately the *same* identity `QuestionDisposition.attemptId` already uses for this outcome -- reusing it, rather than inventing a `dispositionId` to reference, mirrors `QuestionDisposition`'s own decision not to invent a separate identity when `attemptId` already suffices (§9, decision A).

##### N. Mandatory `SUPPLIED`-outcome fresh read validation

Closed, exhaustive, all independently re-verified -- **never** trusted merely because `O1.result === 'SUPPLIED'` is what the stored discriminant says:

1. `O1` resolves to exactly one `RouteAttempt` (`attempts.filter`, `0`/`>1` both reject).
2. That attempt resolves to exactly one `RouteDecision` (`resolveUniqueRouteDecisionById`, never a blind first match).
3. Decision/question/session/hash provenance is independently re-verified through the same chain `validateAttemptProvenanceForOutcome` already establishes (§7) -- never assumed still valid merely because it once was.
4. `O1.route === 'ADD_CONTEXT'`.
5. `O1.status === 'SUCCEEDED'`.
6. `O1.result === 'SUPPLIED'` (not `DECLINED`; `DECLINED` structurally cannot authorize this transition, §33).
7. `O1.contextRequestId` resolves to exactly one `ContextRequest`.
8. **Mandatory**: the COMPLETE `ContextRequest` ledger passes `assertContextRequestLedgerIntegrity`-equivalent validation before the one selected request is trusted -- the same "global before local" posture this contract has required at every ledger boundary since the Slice 2D-B2-0 amendment, now applied a third time (`ContextRequest` ledger integrity was first required at `createContextRequest`, Slice 2D-C1; again at `recordRouteOutcome`'s `ADD_CONTEXT` branch, Slice 2D-C2; now here).
9. The selected request's `originatingAttemptId === O1.attemptId`.
10. Request/question/session/hash bindings all agree (`originatingQuestionId`, `originatingSessionId`, `artifactHash`, `authorContextHash`), exactly the checks already frozen at `recordRouteOutcome`'s `ADD_CONTEXT` branch (§7, Slice 2D-C2).
11. `O1.responseText` is still a structurally-valid non-empty string -- re-validated, never assumed still valid merely because it passed validation once at write time (the same "never trust storage, always re-validate at the read boundary" posture `assertLedgerQuestionDispositionIntegrity` already takes for `QuestionDisposition`, §9).

Steps 1-3 and 9-10 are not a new invention -- they are the identical authoritative-upstream chain this contract already requires (§ "Authoritative-upstream principle" below); step 8 is the one new mandatory gate this freeze adds, closing the last prerequisite the Slice 2D-B2-0 freeze's `CROSS_SESSION`-blocking reasoning (§9 above) named.

##### Authoritative-upstream principle (packet §9, restated as a named rule, not new infrastructure)

Closed as an explicit statement of a rule this contract has already applied repeatedly, not a new generic mechanism: any transition that treats an existing audit fact as authorization evidence must walk that fact all the way back to its authoritative upstream domain binding -- `DeliberationState A -> RouteAttempt -> RouteDecision -> Q1`, and separately `DeliberationState A -> ContextRequest -> RouteAttempt`, and separately `RouteOutcome -> ContextRequest` -- and require all three chains to agree, never merely compare two adjacent downstream records to each other (the exact class of gap the Slice 2D-C1 amendment closed for `ContextRequest`/`RouteAttempt`, and the Slice 2D-B2-B amendment closed for two terminal `QuestionDisposition`s on one question). This is an audit-boundary rule this contract restates at each new boundary that needs it, not a shared library or generic infrastructure this freeze introduces.

##### O. Response reuse prevention

Closed, an executable mechanism, not hand-waved: because the persisted `sessionVersionLineages[]` ledger lives on `DeliberationState A` (§D), a **write-time** check is possible and required -- before creating anything, `createCrossSessionTransition` scans `deliberationState.sessionVersionLineages` for an existing entry whose `suppliedOutcomeAttemptId === input.suppliedOutcomeAttemptId`; if one already exists, the call rejects outright (no second child session, no overwrite, no silent reuse of the existing one). This is the same "if any existing X already claims this identity, reject" write-time gate already frozen for `ContextRequest` (invariant 50, "`ONE ADD_CONTEXT RouteAttempt -> AT MOST ONE ContextRequest`") applied one layer further down the chain.

##### P. Lineage read-integrity

Closed: a future, pure, non-cached helper -- name not binding, conceptually `assertSessionVersionLineageIntegrity(state)` -- validates the COMPLETE `sessionVersionLineages[]` collection on every read: `lineageId` non-empty and globally unique; `parentSessionId`/`childSessionId` both non-empty and never equal to each other; at most one lineage entry per `childSessionId` (§E.3) and at most one per `suppliedOutcomeAttemptId` (§E.2, re-derived independently at read time, never trusting the write-time gate alone for state that may predate it -- the same posture this contract has taken since the Slice 2D-B2-0 amendment); `parentSessionId` matches the containing `DeliberationState.sessionId`; `parentArtifactHash`/`parentAuthorContextHash` match the containing `DeliberationState`'s own hashes; `suppliedOutcomeAttemptId` independently resolves and re-validates the complete `ADD_CONTEXT` provenance chain (§N, all eleven steps, not merely re-checking that the lineage record's own copied fields are internally consistent); `originatingQuestionId`/`contextRequestId` match that resolved chain exactly; `addedAuthorContextItemId` exists exactly once in the (conceptually referenced, not persisted alongside) child session's `AuthorContext`; a matching `CROSS_SESSION` `QuestionDisposition` exists for `originatingQuestionId` on the same `attemptId`; no fork (§E.2) and no reuse (§O) ambiguity. Never cached, never persisted beyond the ledger entries themselves.

##### Q. Legacy compatibility

Closed: a `DeliberationState` predating this field is read as `sessionVersionLineages: []` at read boundaries only, never by mutating the stored record -- the identical purely-additive compatibility posture already used for `contextRequests` (§7, Slice 2D-C0/C1 freeze) and `questionDispositions` (§15) when each was first introduced. All newly-created `DeliberationState` values materialize `sessionVersionLineages: []` explicitly.

##### R. Cost / latency semantics

Closed: `createCrossSessionTransition` is not itself a new `RouteAttempt` and charges neither `logicalCost` nor latency again -- those were already accounted in full on `A1`/`O1` when the `ADD_CONTEXT` attempt itself ran (§12). Session creation is domain-transition bookkeeping, exactly as `registerUnresolvedQuestion`/`createUnresolvedQuestion` already charge nothing on their own (only `RouteAttempt` starts ever charge logical cost, invariant 24).

##### S. Question / review reset behavior

Closed: Session B undergoes review again from its own frozen input -- no reuse of Session A's current review state, and no automatic re-registration of `Q1` or any other question as current under B (§J above). This is not a new rule; it is `MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md` §9's existing "a reference that would cross a version boundary without going through the lineage record is treated the same as any other invalid reference" applied to review state specifically: Session B's findings/issues/questions are only ever what a fresh review pass against B's own `(childArtifactHash, childAuthorContextHash)` actually produces.

##### Human authority (restated, unaffected)

`CROSS_SESSION` grants no `RevisionAction` authority. It creates a new review *input* session; it does not authorize an artifact edit. `HumanAdjudication.actionChange = YES -> RevisionAction` remains the sole revision gate (§17, invariant 19), entirely unaffected by any of the above, exactly as every other `QuestionDisposition` kind already is (§9).

#### Schema decisions closed (Slice 2D-C3-0)

**A-S map exactly to the lettered/named subsections immediately above.** No governing source-of-truth document contradicts A-S; none required reopening an already-accepted Slice 2A/2B/2C/2D-B0/2D-B1/2D-B2-0/2D-B2-A/2D-B2-B/2D-C0/2D-C1/2D-C2 invariant to close.

#### Recommended next runtime slices (Slice 2D-C3-0 freeze)

Not authorized by this document.

**`SLICE 2D-C3-A` — SESSION VERSION LINEAGE + CHILD SESSION CONSTRUCTION:** `SessionVersionLineage` type; `sessionVersionLineages[]` ledger on `DeliberationState`; the read-integrity helper (§P); Session-B construction (`AuthorContext` copy + one new item, §F-§H); the response-reuse write-time gate (§O). No `CROSS_SESSION` `QuestionDisposition` recording yet -- this slice can be built and tested (child session construction, hash equations, alias isolation) entirely independently of the disposition side.

**`SLICE 2D-C3-B` — ATOMIC `CROSS_SESSION` DISPOSITION TRANSITION** (after 2D-C3-A is accepted): `createCrossSessionTransition` itself (§K), wiring the mandatory `SUPPLIED`-outcome read validation (§N) and the authoritative-upstream chain (§ above) into one atomic operation that also records Q1's `CROSS_SESSION` `QuestionDisposition`. This split is preferred over any alternative because it isolates the genuinely new, cross-session-spanning construction logic (2D-C3-A, which touches no existing `QuestionDisposition`/currentness machinery at all) from the one integration point that finally makes `CROSS_SESSION` recordable (2D-C3-B) -- consistent with this contract's established preference for the smallest slice that makes one concept real without touching another already-accepted type's shape (the same reasoning that separated Slice 2D-B2-A from 2D-B2-B).

`NO_RESPONSE` and `SEEK_EVIDENCE` claim-level provenance remain excluded from both slices — neither dependency is built by either.

### B. ADD_REVIEWER

Route output: new `ReviewFinding[]` from one reviewer pass (accepted, unchanged shape). `AttemptStatus`: `SUCCEEDED` (findings produced, possibly zero) or `FAILED` (acquisition/technical failure, invalid output). No `INCONCLUSIVE` category — "found nothing material" is itself a determinate answer, not an indeterminate one. Append-only review evidence; no automatic materiality authority; no automatic question resolution — re-evaluation (§14) decides the coverage gap's disposition.

### C. REPLICATE

`ReplicationResult`: `REPRODUCED` | `NOT_REPRODUCED` | `PARTIAL` — a closed, three-value categorical result, chosen because it mirrors the pattern already governing every other closed enum in this runtime (`StopReason`, `RootCauseCategory`), and because `PARTIAL` is itself a determinate designed category, not an indeterminate escape hatch. `AttemptStatus`: `SUCCEEDED` for any of the three (the replication mechanism ran and produced a definite categorical answer) or `FAILED` (the replication attempt itself could not execute). Reproduction is never treated as truth — it is one input the disposition step (§14) weighs, never a self-executing verdict.

### D. SEEK_EVIDENCE

Evidence-lookup result, one of: supportive | contradictory | partial/inconclusive | execution failure. The first two map to `AttemptStatus = SUCCEEDED`; "partial/inconclusive" maps to `AttemptStatus = INCONCLUSIVE` (§6); "execution failure" maps to `AttemptStatus = FAILED`. Never directly mutates `ReviewFinding.evidenceState` — any later projection into that vocabulary is an explicit, separately-designed re-evaluation step (§14), not an automatic side effect of the lookup.

### E. TARGETED_PEER_CHALLENGE

Challenge-response outcome preserving target/source provenance, bounded excerpt identity, and one of: rebuttal | concession | qualification | refusal-to-yield. All four map to `AttemptStatus = SUCCEEDED` — a complete, valid response was produced, regardless of whether it resolves anything. `FAILED` covers a call failure or an unresolvable reference. Consensus is never truth: no peer response, by itself, automatically resolves the conflict (§10, §14) — that remains a disposition decided by re-evaluation, ultimately subordinate to `HumanAdjudication` (§17).

### F. STOP

No `RouteAttempt`, no `RouteOutcome`, no `AttemptStatus`. Terminal audit representation remains exactly `RouteDecision(route=STOP)` + `StopReason`, unchanged from Slice 2A/2B.

---

## 14. Re-evaluation authority

`QuestionDisposition` is never produced directly from a raw `RouteOutcome`. Four distinct layers, none collapsible into another:

1. **Raw route outcome** — the immutable fact of what the attempt produced (§7).
2. **Deterministic runtime validation** — the same fail-closed, structural checking already used everywhere in this runtime today (provenance resolves, hashes bind, `status`/result values are in their allowlist). This layer can reject a malformed `RouteOutcome` outright; it never decides materiality or disposition.
3. **Semantic re-evaluation** — the actual classification of what the outcome means for the question: does the deficit remain, does it get reclassified, is it resolved. This is **not implemented anywhere in this document or in `deliberation.ts`.** `QuestionDisposition`-construction consumes an externally supplied / later-authorized re-evaluation result as an input — exactly the same posture Slice 2A/2B already takes for `rootCause`/`materialityReason`: this module "enforces structure, not classification — no AI classifier, no numeric score" (`RouteReason` docstring, `src/stress-test/deliberation.ts`). No AI materiality classifier and no numeric materiality scoring is introduced by this document, and none should be introduced silently by whatever implementation phase eventually builds this.
4. **Human adjudication** — entirely unchanged (§17), downstream of and unaffected by everything above.

Prefer minimum architecture: a future `recordQuestionDisposition`-shaped function would validate structure (valid disposition kind, valid provenance, non-empty reason) exactly like `registerUnresolvedQuestion` does today, and accept the disposition classification itself as caller-supplied input — never compute it.

---

## 15. Current question set derivation

`DeliberationState.unresolvedQuestions: UnresolvedQuestion[]` (accepted, Slice 2A/2B, unchanged) stays exactly as implemented — an append-only registry of question snapshots. This document's conceptual addition, for a later phase, is a second, equally append-only array: `questionDispositions: QuestionDisposition[]`.

The **current** unresolved-question set is derived, never stored redundantly:

```
current questions
  = registered questions (unresolvedQuestions)
    minus
    questions whose most recent disposition is RESOLVED, SUPERSEDED_RECLASSIFIED, or CROSS_SESSION
```

`STILL_OPEN` never removes a question from "current" — it is exactly the disposition that keeps a question current after a re-evaluation that didn't close it.

**Compatibility, explicit:** today's runtime has no `questionDispositions` array and no derivation step — every registered question is, by the absence of any disposition mechanism, definitionally current. Adding `questionDispositions` later is purely additive: no existing field is renamed or removed, no existing behavior changes, and the degenerate case (no dispositions recorded) reproduces exactly today's behavior. No breaking schema migration is required; this is a conceptual description for a later phase, not an instruction to implement it now.

**Fail-closed on non-current questions:** once a question's disposition is terminal (`RESOLVED`, `SUPERSEDED_RECLASSIFIED`, or `CROSS_SESSION`, §9), it leaves the current set permanently — there is no path back from a terminal disposition. §9's Slice 2D-B2-0 schema freeze closes the complete list of APIs a future implementation phase must gate on currentness: `planRouteForQuestion`, `recordRouteDecision`, `recordRouteAttemptStart`, `recordRouteOutcome`, and `createContextRequest` — not merely the two named in an earlier draft of this document. This is not implemented by this document; it is a binding requirement on whatever phase does implement it.

---

## 16. Audit chain / identity relationships

```
StressTestSession
  |  (sessionId)
  v
DeliberationState
  |  (sessionId + artifactHash + authorContextHash, fail-closed binding)
  v
UnresolvedQuestion              (registered, append-only, id)
  |  (questionId, exact structural match: rootCause/materialityReason/inputRefs)
  v
RouteDecision                   (id, questionId, route derived from rootCause)
  |  (decisionId, route copied+checked)
  v
RouteAttempt                    (START fact only: attemptId, decisionId, questionId, route,
                                  sessionId+hashes, startedAt — immutable, never mutated to "completed")
  |
  +-- (attemptId) no terminal RouteOutcome ever recorded --> OPEN / UNTERMINATED ATTEMPT
  |                                                            (auditable; not SUCCEEDED; not FAILED
  |                                                             without an explicit FAILED RouteOutcome;
  |                                                             no second RouteAttempt for this
  |                                                             RouteDecision while open; no auto-retry)
  |
  v  (attemptId)
RouteOutcome                    (TERMINAL fact: attemptId, decisionId, originatingQuestionId,
                                  sessionId+hashes, route, completedAt, AttemptStatus,
                                  cost consumed, latency consumed, result payload OR failure info)
  |  (originatingQuestionId; at most one QuestionDisposition per RouteOutcome, §19)
  v
QuestionDisposition             (questionId, disposition, provenance to the RouteOutcome that motivated it;
                                  RESOLVED/SUPERSEDED_RECLASSIFIED/CROSS_SESSION are terminal and
                                  permanently close the question to further routing, §9)
  |
  +-- RESOLVED / STILL_OPEN ------------------------------> (loop: re-classification, §5 of routing contract)
  |
  +-- SUPERSEDED_RECLASSIFIED --> new UnresolvedQuestion (derivedFromQuestionId) --> (loop)
  |
  +-- CROSS_SESSION (ADD_CONTEXT only)
        |  (previousSessionId)
        v
      SessionVersionLineage     (previousSessionId, newSessionId, reason=ADD_CONTEXT, old+new hashes)
        |  (newSessionId)
        v
      new StressTestSession (DRAFT -> ... -> REVIEWED)
        |
        v
      (new DeliberationState, fresh routing from scratch)

... eventually, for any lineage:
  STOP  (RouteDecision(route=STOP) + StopReason; no RouteAttempt, no RouteOutcome)
    |
    v
  HumanAdjudication   (unchanged, Slice 1; sole gate to RevisionAction, §17)
```

Every edge above is an identity check, not a convenience link: an object at one layer that cannot resolve its required reference to the layer above it cannot exist, following the same fail-closed pattern Slice 2A/2B already enforces for `RouteInputRef`/`UnresolvedQuestion`/`RouteDecision` binding.

---

## 17. Human authority boundary

Unchanged, unconditional, restated because it governs every new concept above too:

```
HumanAdjudication.actionChange = YES
  ->  RevisionAction
```

Nothing in `RouteAttempt`, `RouteOutcome`, `QuestionDisposition`, a reviewer's output, an evidence lookup, a replication result, a peer-challenge response, or a human's `ADD_CONTEXT` response may independently authorize revision. `QuestionDisposition = RESOLVED` means only "this deliberation information deficit no longer needs to remain current" — it does not mean "the artifact must change." That gap is deliberate and permanent: resolving a routing question and authorizing an edit are different acts, gated by different authorities, exactly as `MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md` §10 and `PRODUCT_RUNTIME_RECONCILIATION.md` §5 already require.

---

## 18. Stopping with unresolved questions

`STOP` does not require all questions resolved — the existing `StopReason` vocabulary already anticipates this (`unresolved_but_human_decidable`, `budget`, `latency`, `no_eligible_route`). `STOP` may occur while `current` unresolved questions (§15) remain. Terminal handoff preserves them exactly: the current-question set at the moment of `STOP` is handed to `HumanAdjudication` unfiltered — no question still `STILL_OPEN` is ever marked `RESOLVED` merely because deliberation stopped. Stopping ends machine deliberation; it never retroactively resolves what machine deliberation didn't resolve.

---

## 19. Idempotency / duplicate record safety

```
ONE RouteDecision   -> AT MOST ONE RouteAttempt
ONE RouteAttempt    -> AT MOST ONE terminal RouteOutcome
ONE RouteOutcome    -> AT MOST ONE QuestionDisposition
```

Repeated submission of the same outcome identity (`attemptId`) must never create a duplicate historical fact — the same posture `registerUnresolvedQuestion`'s duplicate-id rejection already takes today. Retry always requires a new `RouteDecision` and a new `RouteAttempt`; nothing reuses a prior attempt's identity. No conflict with the current, already-accepted runtime was found: `RouteAttempt`/`RouteOutcome` do not exist in `src/stress-test/deliberation.ts` today, so this is a forward constraint on a not-yet-authorized runtime, not a correction of anything already implemented.

A question may accumulate multiple `QuestionDisposition` records only through the non-terminal path: `STILL_OPEN` → fresh `RouteDecision` → fresh `RouteAttempt` → fresh `RouteOutcome` → new `QuestionDisposition`. The moment a terminal disposition (`RESOLVED`/`SUPERSEDED_RECLASSIFIED`/`CROSS_SESSION`) is recorded, no later disposition may exist for that question (§9) — precisely: a question may have any number of prior `STILL_OPEN` records, but **at most one terminal disposition, ever**, and it must be the last disposition recorded for that question, in ledger append order (never by `createdAt`/timestamp arbitration).

An open/unterminated attempt (§5) is itself an idempotency concern: while a `RouteAttempt` has no recorded `RouteOutcome`, no second `RouteAttempt` for the same `RouteDecision` may be created — `ONE RouteDecision -> AT MOST ONE RouteAttempt` holds whether or not that one attempt has yet terminated.

---

## 20. Invariants

1. `RouteDecision` != `RouteAttempt`.
2. `RouteAttempt` != `RouteOutcome`.
3. `RouteOutcome` != `QuestionDisposition`.
4. Route success (`AttemptStatus.SUCCEEDED`) != question resolution (`QuestionDisposition.RESOLVED`).
5. A failed attempt never destroys the prior defensible checkpoint.
6. The original `UnresolvedQuestion` is never reclassified in place — `rootCause`, `materialityReason`, `inputRefs`, and identity are immutable once registered (already true today; extended, not weakened, here).
7. A reclassified residual deficit gets a new question identity (`derivedFromQuestionId`), never a mutation of the original.
8. Retry always requires a fresh `RouteDecision` and a fresh `RouteAttempt` — never an automatic loop.
9. One `RouteDecision` has at most one `RouteAttempt`.
10. One `RouteAttempt` has at most one terminal `RouteOutcome`.
11. `RouteAttempt`/`RouteOutcome`/`QuestionDisposition` remain bound to `sessionId` + the exact frozen hashes they were created against; any mismatch fails closed.
12. `STOP` has no `RouteAttempt` and no `RouteOutcome`.
13. `STOP` may hand unresolved (`STILL_OPEN`) questions to `HumanAdjudication`; it never marks them `RESOLVED` by stopping.
14. A supplied `ADD_CONTEXT` response crosses a session-version boundary; it never mutates the frozen session it was requested against.
15. Old-session questions and findings never silently become current in a new session version.
16. `FAILED` and `INCONCLUSIVE` attempts still consume and record cost/latency; spend is never reversed to hide the work.
17. `RouteOutcome` has no revision authority.
18. `QuestionDisposition` has no revision authority.
19. `HumanAdjudication.actionChange = YES` remains the sole gate to `RevisionAction` — nothing above it substitutes for it.
20. Audit objects use snapshot/value semantics at every API boundary; a mutable caller-owned reference must never silently rewrite prior history (extends the Slice 2B amendment's alias-isolation hardening to every new concept in this document).
21. `RouteAttempt` is an immutable start-only fact; it is never mutated from a "started" shape into a "completed" shape — `RouteOutcome` is a separate terminal record, not an update to it (§5).
22. An attempt with no recorded `RouteOutcome` is an open/unterminated attempt — auditable, never silently deleted, never treated as `SUCCEEDED`, and never treated as `FAILED` without an explicit `FAILED` `RouteOutcome` (§5).
23. No second `RouteAttempt` may exist for a `RouteDecision` whose existing attempt is open/unterminated; recovery, if ever authorized, issues a new `RouteDecision` through an explicit, fail-closed recovery path (§5).
24. Logical cost is accounted at `RouteAttempt` start, before external execution begins, and is never reversed regardless of the eventual `AttemptStatus` (§12).
25. Each route's `RouteOutcome.status` is restricted to that route's binding `AttemptStatus` allowlist (§6); `INCONCLUSIVE` is reachable only for a route whose own result vocabulary defines an indeterminate category.
26. A question with a terminal `QuestionDisposition` (`RESOLVED`/`SUPERSEDED_RECLASSIFIED`/`CROSS_SESSION`) may never again be targeted by a `RouteDecision`, `RouteAttempt`, `RouteOutcome`, or further `QuestionDisposition` in that session (§9).
27. One `RouteOutcome` produces at most one `QuestionDisposition` for its originating question (§19).
28. `RouteAttempt.attemptId` and `ReviewFinding.reviewerRunId` are separate identities and are never made equal; one `reviewerRunId` may be claimed by at most one successful `ADD_REVIEWER` `RouteOutcome` within a `StressTestSession` lineage (§7).
29. `NO_RESPONSE` (an `ADD_CONTEXT` result) may never be caller-declared or runtime-terminalized until architecture separately defines an explicit response-closure mechanism (a response deadline or an externally recorded closure event); absent that, only `SUPPLIED`, `DECLINED`, and `FAILED` are terminalizable for `ADD_CONTEXT` (§7).
30. A registered `UnresolvedQuestion` whose `rootCause = DECISION_SENSITIVE_CONFLICT` must contain at least two distinct (`kind`, `id`) `RouteInputRef`s; not yet enforced by any registration gate in the accepted runtime (§7).
31. A `TARGETED_PEER_CHALLENGE` `RouteOutcome`'s `targetRef` and `sourceRef` must be distinct from one another and must each exactly match one of the terminated `RouteDecision`'s own `inputRefs`, with no inference and no new ref introduced at outcome time (§7).
32. No `SEEK_EVIDENCE` result (`SUPPORTIVE`/`CONTRADICTORY`/`INCONCLUSIVE`) may be recorded until claim-level `EvidenceSubject` provenance is separately, explicitly frozen; only a generic `FAILED` outcome is recordable for `SEEK_EVIDENCE` until then (§7).
33. `TARGETED_PEER_CHALLENGE`'s successful result variants may not be recorded until the `DECISION_SENSITIVE_CONFLICT` input-cardinality routing gate (invariant 30) exists; only a generic `FAILED` outcome is recordable for `TARGETED_PEER_CHALLENGE` until then (§7).
34. `planRouteForQuestion`, `recordRouteDecision`, `recordRouteAttemptStart`, `recordRouteOutcome`, and `createContextRequest` must all fail closed on a non-current question — registration in `unresolvedQuestions` is never sufficient by itself once a terminal disposition exists (§9).
35. At most one `ACTIVE` deliberation cycle — a recorded `RouteDecision` through a recorded `QuestionDisposition` for its eventual outcome — may exist per question at a time; enforced authoritatively at `recordRouteDecision` (§9).
36. `STOP` may be recorded while a `RouteAttempt` is open; the attempt becomes permanently open/unterminated, never forced closed, never treated as an error caused by stopping (§9).
37. `registerUnresolvedQuestion` must reject any question whose `derivedFromQuestionId` is non-`null`; a derived question may only ever be registered through the atomic `SUPERSEDED_RECLASSIFIED` transition, never standalone (§9).
38. `RESOLVED` is a legal `QuestionDisposition` after a `FAILED` `RouteOutcome` when independently justified by `reason`; `CROSS_SESSION` is never legal after `FAILED`, regardless of route (§9).
39. Every operation that progresses an existing deliberation cycle (`recordRouteAttemptStart`, `recordRouteOutcome`, `recordQuestionDisposition`, `createContextRequest`) must independently re-derive that question's active-cycle set and fail closed if it is not exactly one cycle matching the one being progressed — never trusting that `recordRouteDecision`'s creation-time gate already guaranteed this for state that may predate it (§9).
40. A question found to have more than one active `RouteDecision` is a legacy-inconsistent state that always fails closed; it is never automatically reconciled, never resolved by picking the latest, and never silently deleted (§9).
41. `STOP` is exempt from active-cycle blocking at every stage — decision-only, attempt-open, and outcome-recorded-but-undisposed — because it is session-level termination, not a new question cycle; none of the three stages ever blocks it, and none is ever retroactively completed or resolved merely because `STOP` occurred (§9).
42. Once `deliberationState.stopReason !== null`, no further machine-deliberation mutation is permitted (no new `RouteDecision`, `RouteAttempt`, `RouteOutcome`, `QuestionDisposition`, or `ContextRequest`); read-only derivation/audit inspection remains permitted (§9).
43. A `SUPERSEDED_RECLASSIFIED` transition is atomic: `Q1`'s terminal disposition and `Q2`'s registration land in the same returned `DeliberationState`, or neither does (§9).
44. Before a `SUPERSEDED_RECLASSIFIED` transition is recorded, exactly zero questions may already have an effective `derivedFromQuestionId` equal to the question being superseded; one or more is rejected (§9).
45. A superseded parent has at most one direct child through derived lineage, and a derived child has exactly one direct parent; a fork and an orphan are both invalid and fail closed, never automatically reconciled (§9).
46. Derived lineage must be acyclic; a question that is its own ancestor through any chain of `derivedFromQuestionId` references is invalid at read time, regardless of whether the accepted write path could ever produce one (§9).
47. A question's missing `derivedFromQuestionId` (predating the field's existence) is read as its legal equivalent, `null`, without mutating the stored record, and this compatibility reading may never be used to treat a genuinely broken lineage chain as valid (§9).
48. Global derived-lineage graph integrity is validated before any local question's currentness or lineage is answered, never cached and never persisted (§9).
49. `ContextRequest.originatingAttemptId` identifies the exact `RouteAttempt` that caused it; no reverse-pointing field is ever added to `RouteAttempt`, and no parallel binding ledger ever stores the same relationship a second time (§7, Slice 2D-C0 freeze).
50. `ONE ADD_CONTEXT RouteAttempt -> AT MOST ONE ContextRequest`; a `ContextRequest` may only be created for an attempt that does not already have one, enforced at write time and independently re-derived at read time for legacy/tampered state (§7, Slice 2D-C0 freeze).
51. A `ContextRequest` may only be created for an already-recorded, non-terminated `RouteAttempt` whose route is `ADD_CONTEXT`, whose targeted question is current, and whose exactly-one active deliberation cycle is the exact `RouteDecision` that attempt belongs to — the same fail-closed posture every other cycle-progressing operation already takes (§9, invariant 39), with no "0 or 1" allowance once attempt binding exists (§7, Slice 2D-C0 freeze).
52. `DeliberationState.contextRequests[]` is append-only audit history; every entry's identity and session/hash binding is independently re-validated at every read, never trusted merely because it is present in the array (§7, Slice 2D-C0 freeze).
53. A missing `DeliberationState.contextRequests` array (state predating this field) is read as its legal equivalent, `[]`, without mutating the stored record (§7, Slice 2D-C0 freeze).
54. `SessionVersionLineage.lineageId` is a fresh, independently-generated identity, never overloaded onto `childSession.id`, even though the two are always 1:1 in accepted usage (§13.A, Slice 2D-C3-0 freeze).
55. `ONE StressTestSession (child) -> exactly ONE parent` through the `CROSS_SESSION` transition mechanism; no merge-session semantics (§13.A, Slice 2D-C3-0 freeze).
56. `ONE ADD_CONTEXT SUPPLIED RouteOutcome -> AT MOST ONE SessionVersionLineage`/child session, enforced at write time by scanning `DeliberationState.sessionVersionLineages` for an existing entry with the same `suppliedOutcomeAttemptId`, and independently re-derived at read time (§13.A, Slice 2D-C3-0 freeze).
57. Q1's `CROSS_SESSION` `QuestionDisposition`, Session B, and the `SessionVersionLineage` record are created atomically by one operation: all three land together, or none does (§13.A, Slice 2D-C3-0 freeze).
58. `QuestionDisposition`'s generic envelope gains no `childSessionId` field for `CROSS_SESSION`; the cross-session relationship lives exclusively in `SessionVersionLineage`, which reuses the outcome's own `attemptId` (as `suppliedOutcomeAttemptId`) rather than inventing a second identity (§13.A, Slice 2D-C3-0 freeze).
59. A `SUPPLIED` `RouteOutcome` is never trusted as `CROSS_SESSION` authorization merely because its stored `result` discriminant says so -- the complete attempt/decision/question chain and the complete `ContextRequest` ledger are independently re-validated at the moment of transition (§13.A, Slice 2D-C3-0 freeze).
60. `childArtifactHash === parentArtifactHash` deterministically, because `artifactHash` is a pure function of `artifactText` alone and `ADD_CONTEXT` never revises the artifact; `childAuthorContextHash` is independently and correctly recomputed over Session B's own, content-differing `AuthorContext` (§13.A, Slice 2D-C3-0 freeze).
61. A missing `DeliberationState.sessionVersionLineages` array (state predating this field) is read as its legal equivalent, `[]`, without mutating the stored record (§13.A, Slice 2D-C3-0 freeze).

---

## 21. What this document does not claim

- Which provider/model executes any route.
- That multi-agent deliberation is better than single-pass review.
- That more reasoning improves quality.
- That `TARGETED_PEER_CHALLENGE` should be a default route.
- That any route described here is production-ready.
- That M2-B's scientific question is answered.
- That CBRP is reopened.
- That the exact reviewer ontology is solved.
- Any numeric production cost/latency ceiling.
- That `RouteAttempt` runtime exists.
- That `RouteOutcome` runtime exists.
- That `QuestionDisposition` runtime exists.
- That session-version runtime exists.

---

## 22. Architecture decisions closed

**A. Can one `RouteDecision` have multiple `RouteAttempt`s?** No. Retry requires a fresh `RouteDecision` (§11, §19, invariant 8).

**B. Can `RouteOutcome` itself close a question?** No. `QuestionDisposition` is a separate, explicit record; no `RouteOutcome` implicitly resolves anything (§9, §14, invariant 3).

**C. Can the original `UnresolvedQuestion` be mutated to a new `rootCause`?** No. A new question identity is created, with explicit lineage (`derivedFromQuestionId`) back to the original (§8, invariants 6–7).

**D. Does `STOP` require zero current unresolved questions?** No. `STOP` may occur with `STILL_OPEN` questions remaining; they are handed to `HumanAdjudication` unfiltered (§18, invariant 13).

**E. Does `QuestionDisposition.RESOLVED` authorize artifact revision?** No. It means only that the deliberation deficit no longer needs to remain current — never that the artifact must change (§17, invariant 19).

**F. Can a `FAILED` attempt be deleted or overwritten by a successful retry?** No. Failed-attempt history is permanent; a later success does not erase it (§11, invariant 5).

**G. Can a later route implicitly reuse a prior attempt's provider output without explicit provenance?** No. Any reuse must be explicit, provenance-bound input — never an implicit carry-forward (§7, §16, invariant 11).

No governing source-of-truth document contradicts any of these seven closures; none required reopening an already-accepted Slice 2A/2B invariant to close.

**Closed by this amendment:**

**H. Is `RouteAttempt` mutated from a "started" shape into a "completed" shape, or is `RouteOutcome` a separate terminal record?** Separate. `RouteAttempt` is an immutable start-only fact; `RouteOutcome` is the only terminal record, and recording it never mutates the `RouteAttempt` it terminates (§5, §7, invariant 21).

**I. Does an attempt with no recorded `RouteOutcome` get a new `AttemptStatus` value such as `UNKNOWN`, `ABANDONED`, or `CRASHED`?** No. It is an open/unterminated attempt, a condition derived from the absence of a terminal outcome — never a fourth `AttemptStatus` value (§5, invariant 22).

**J. Is logical cost accounted at `RouteAttempt` start or only once a `RouteOutcome` is recorded?** At start, before external execution begins, and never reversed regardless of the eventual outcome (§12, invariant 24).

**K. Is the per-route `AttemptStatus` allowlist (§6) binding or advisory?** Binding. Originally an Engineering Lead advisory recommendation from Slice 2C; explicitly accepted by GPT as an architecture requirement in this amendment (§6, invariant 25).

**L. May a question with a terminal disposition be targeted by routing again?** No. Fail closed — a terminal `QuestionDisposition` permanently removes the question from the current set (§9, §15, invariant 26).

**M. May one `RouteOutcome` produce more than one `QuestionDisposition`?** No. At most one, for the outcome's originating question (§19, invariant 27).

No governing source-of-truth document contradicts H–M; none required reopening an already-accepted Slice 2A/2B/2C invariant to close.

**Closed by the Slice 2D-B0 schema freeze:** decisions A–J (plus K, added by this amendment), covering `RouteOutcome` identity, the generic envelope, `FailureInfo`, and every route-specific payload — recorded in full in §7's "Schema decisions closed" subsection rather than repeated here, to keep the payload reasoning next to the schema it closes. Summary: no `outcomeId`; a four-category `FailureInfo`; frozen payloads for all five non-`STOP` routes; `logicalCost` never accepted as caller input, always derived, never re-charged; binding status/result consistency; no route blocked outright, though `ADD_CONTEXT`'s `NO_RESPONSE` result variant specifically remains blocked (§24) pending response-window architecture.

**Corrected by the Slice 2D-B0 amendment:** GPT reviewed and rejected the schema freeze's `reviewerRunId === attemptId` identity-equality convention for `ADD_REVIEWER` — two distinct domain identities must never be made equal. `ADD_REVIEWER`'s newness provenance is redesigned as a structural, multi-signal check (§7: `startedAt` ordering, a distinct `reviewerRunId`, `finding.createdAt >= attempt.startedAt`, one-`reviewerRunId`-per-successful-outcome, internal batch consistency) that does not claim cryptographic proof, only structural defensibility within this domain layer's already-accepted trust model (invariant 28). `ADD_CONTEXT`'s `NO_RESPONSE` result is corrected from implicitly-ready to explicitly blocked pending a future, separately-authorized response-closure architecture decision (invariant 29, §24). `logicalCost`'s envelope entry is corrected from "caller-suppliable with mismatch rejection" to "not caller input at all." `completedAt` is clarified as the runtime's own recording time, not a claimed provider-side completion time. `SEEK_EVIDENCE`'s `excerpt` is clarified as source-attributable text, never an arbitrary assistant paraphrase. `TARGETED_PEER_CHALLENGE` was re-reviewed and found unchanged.

**Corrected by the Slice 2D-B0 final amendment:** two further provenance gaps, discovered while translating the frozen schemas into executable requirements, are corrected — decisions L–N in §7. `TARGETED_PEER_CHALLENGE` requires two distinct source/target refs (invariant 30), and its `targetRef`/`sourceRef` must both originate from the terminated `RouteDecision`'s own `inputRefs` (invariant 31) — closed decisions, but its successful-outcome *runtime* stays blocked until a routing gate enforces the cardinality requirement, since no such gate exists in the accepted runtime today. `SEEK_EVIDENCE`'s frozen `{result, citations}` payload is confirmed insufficient to identify *which claim* is being evaluated — `SEEK_EVIDENCE`'s claim-level provenance is left genuinely open (§24) rather than solved by inventing an unjustified `claimId`/`claimText`/`paragraphId` field. The route-readiness table (§7) and the reviewerRunId-reuse scope note (§7) are revised accordingly; a recommended, not-authorized `SLICE 2D-B1` scope is proposed (§7) for whatever GPT chooses to authorize next.

**Closed by the Slice 2D-B2-0 schema freeze:** fifteen decisions (A–O, §9's "Schema decisions closed" subsection), covering `QuestionDisposition` identity and generic envelope, legal disposition/status combinations (including `RESOLVED` after `FAILED`, closed explicitly rather than left implicit), `CROSS_SESSION`'s continued runtime block, the `SUPERSEDED_RECLASSIFIED` replacement-question model and its `derivedFromQuestionId` field (confirmed for `UnresolvedQuestion`, deferred to a later slice), the complete five-API current-gate list, active-cycle semantics and where its gate belongs, and — as a major architecture decision — that `STOP` may proceed while a `RouteAttempt` is open, leaving it permanently open/unterminated rather than failing closed or requiring not-yet-built recovery machinery (invariants 34–38). Two prior open items (`ADD_CONTEXT`'s `NO_RESPONSE` and `SEEK_EVIDENCE`'s claim-level provenance) are explicitly left open, unrevisited, per this packet's own instruction not to solve unrelated items merely because this document was open (§24).

**Corrected by the Slice 2D-B2-0 amendment:** two executable-consistency gaps found in remote architecture review are closed, both in §9. First, the earlier claim that `recordRouteAttemptStart`/`recordRouteOutcome` need no independent active-cycle check because `recordRouteDecision`'s gate already prevents the problem is corrected — that gate only prevents *future* creation of a second active cycle; it says nothing about state that predates the gate's existence. `recordRouteAttemptStart`, `recordRouteOutcome`, `recordQuestionDisposition`, and `createContextRequest` must each independently re-derive the question's active-cycle set and fail closed on `0`/`>1`/wrong-cycle results (invariant 39), and a `>1` result is always a legacy-inconsistent state, never automatically reconciled (invariant 40). Second, `STOP`'s interaction with an unfinished cycle — previously closed only for the open-attempt stage — is generalized to all three `ACTIVE` stages, including a decision with no attempt yet and an outcome recorded with no disposition yet (invariant 41), together with an explicit post-`STOP` no-further-mutation rule (invariant 42) and a named distinction between `ACTIVE FOR ROUTING` and an `UNFINISHED HISTORICAL CYCLE AFTER STOP`, so an unresolved pre-`STOP` cycle is never mistaken for one deliberation could still act on. A third, smaller correction replaces the `RESOLVED`-after-`FAILED` worked example, which had implied the frozen artifact/context could change in place — a frozen-input-integrity violation this contract has never permitted — with one consistent with re-evaluating the *same* frozen input. `SLICE 2D-B2-A`'s scope (§9, "Recommended next runtime slices") is reaffirmed as one indivisible unit that must include the legacy-integrity validation above, not merely currentness and decision-time active-cycle creation alone.

**Closed by the Slice 2D-B2-B0 schema freeze:** fifteen decisions (A–O, §9's "Schema decisions closed (Slice 2D-B2-B0)" subsection), covering the exact `SUPERSEDED_RECLASSIFIED`/`derivedFromQuestionId` schema deferred by the Slice 2D-B2-0 freeze: legacy missing-field read semantics, the canonical single-field lineage shape (confirmed, not reopened), factory and ordinary-registration behavior, the single-source-of-truth rejection of a second stored lineage field, the exact discriminated input/stored-envelope shapes, replacement-question validation, write-time and read-time cardinality (existing-child check, fork/orphan rejection, no automatic reconciliation), cycle detection, and the exact boundary at which a new global lineage-integrity check must run relative to the already-accepted currentness/active-cycle machinery (invariants 43–48). `SLICE 2D-B2-A` (currentness/active-cycle core) is recorded in §9 as separately accepted and closed, not granted by this freeze; this freeze's own authorization scope is architecture documentation only (§25).

**Closed by the Slice 2D-C0 schema freeze:** thirteen decisions (A–M, §7's "Schema decisions closed (Slice 2D-C0)" subsection), covering the `ContextRequest.originatingAttemptId` identity link and why it — not a reverse-pointing `RouteAttempt` field, a parallel ledger, or inference — is the only shape compatible with `RouteAttempt`'s already-accepted immutability (invariant 21); the required creation order (decision after attempt, never before); `createContextRequest`'s future attempt-bound input, replacing `questionId` outright; `ONE ADD_CONTEXT RouteAttempt -> AT MOST ONE ContextRequest` cardinality; the `contextRequests[]` ledger and its read-integrity helper; the future `{deliberationState, contextRequest}` return shape; the decision against a separate `ContextResponse` entity; `SUPPLIED`/`DECLINED` provenance readiness; `FAILED`'s interaction with zero-or-one requests; the active-cycle rule once attempt binding lands; legacy missing-`contextRequests` compatibility; and the exact blast radius (invariants 49–53). `NO_RESPONSE` and `SEEK_EVIDENCE` claim-level provenance remain untouched, unrevisited (§24).

**Closed by the Slice 2D-C3-0 schema freeze:** nineteen decisions (A–S, §13.A's "Schema decisions closed (Slice 2D-C3-0)" subsection), covering whether `SessionVersionLineage` is required (yes — `QuestionDisposition = CROSS_SESSION` alone cannot identify Session B, the causing outcome, the hashes, or the new item); its own fresh `lineageId` (never overloaded onto `childSessionId`, even though the two are always 1:1 in accepted usage); the complete field set, closing which fields are load-bearing versus derived-and-copied convenience versus deliberately excluded (`responseText`, already authoritative elsewhere); ledger ownership resolved as one answer across §13/§36 of the governing packet (`DeliberationState.sessionVersionLineages[]`, both returned at transition time and persisted for later read-time re-validation); the three independent cardinality rules; Session B's construction as a wholly new session (never copy-then-mutate); the artifact/hash equations, confirmed against the actual `sha256Text`/`sha256AuthorContext` implementation rather than assumed; the exact `AuthorContext`-copy-plus-one-new-item construction and its `category`/`text` provenance; Session B ending the transition already `INPUT_FROZEN` (a point the governing packet left open, closed here); the explicit non-copy list from Session A; the atomic `createCrossSessionTransition` operation shape (rejecting a standalone `recordQuestionDisposition(CROSS_SESSION, {childSessionId})` extension outright); the three-fact atomic write; `QuestionDisposition`'s stored shape staying unchanged; the eleven-step mandatory `SUPPLIED`-outcome read validation, naming the "authoritative-upstream" principle explicitly rather than leaving it implicit; an executable response-reuse write-time gate; the read-integrity helper; legacy compatibility; cost/latency semantics; and question/review-reset behavior (invariants 54–61). `NO_RESPONSE` and `SEEK_EVIDENCE` claim-level provenance remain untouched, unrevisited (§24).

---

## 23. Relation to accepted Slice 2A/2B runtime

Nothing in this document alters, weakens, or contradicts `src/stress-test/deliberation.ts` as it stands at HEAD. Every new concept is additive and downstream: `RouteAttempt` references an existing `RouteDecision` without changing its shape; `QuestionDisposition` references an existing `UnresolvedQuestion` without mutating it; the current-question derivation (§15) is backward compatible with `unresolvedQuestions: UnresolvedQuestion[]` exactly as implemented today. No accepted invariant from Slice 2A, the Slice 2A amendment, or Slice 2B is redesigned, loosened, or reopened by this document.

---

## 24. Open GPT decisions

**Two genuinely open items — not hidden, not closed by convenience:**

**1. `NO_RESPONSE` terminalization mechanism: OPEN / deferred to future human-response-lifecycle architecture.** `ADD_CONTEXT`'s `NO_RESPONSE` result cannot be defensibly terminalized without an explicit response-closure mechanism — a `responseDeadlineAt` bound to `ContextRequest`, or an explicit externally recorded request-window-close event (§7, invariant 29). Existing accepted source-of-truth does not clearly dictate which of those two mechanisms is correct, and no timeout duration may be invented to manufacture a closure. This is left open deliberately, not resolved by picking one arbitrarily; a future, separately authorized architecture decision must close it before `NO_RESPONSE` runtime can be authorized.

**2. `SEEK_EVIDENCE` claim-level `EvidenceSubject` provenance: OPEN / requires a separately authorized architecture decision.** The frozen `{result, citations}` payload identifies a source, but not which specific factual claim within a `ReviewFinding`/`SemanticIssue` the citations evaluate (§7, invariant 32). This document explicitly declines to invent `claimText`/`claimId`/`claimIndex`/`paragraphId`/`chunkId` to paper over the gap — paragraph-local identity is not product authority, copied claim text can drift, a `SemanticIssue` can aggregate multiple findings, and one finding can carry more than one factual proposition. `SUPPORTIVE`/`CONTRADICTORY`/`INCONCLUSIVE` all stay runtime-blocked until this is closed.

**Not an open decision, despite being a runtime blocker:** `TARGETED_PEER_CHALLENGE`'s source/target provenance rule *is* closed by this amendment (§7 decisions L–M, invariants 30–31) — two distinct refs, both drawn from the terminated `RouteDecision`'s own `inputRefs`. Its successful-outcome runtime stays blocked only because the routing gate that would *enforce* that closed rule does not exist yet — a sequencing gap, not an unresolved architecture question. The same is true of `SUPERSEDED_RECLASSIFIED` (§9 decisions F–H) and `CROSS_SESSION` (§9 decision E): both are architecturally closed — the replacement-question model, the `derivedFromQuestionId` field, and the exact prerequisites `CROSS_SESSION` still lacks are all frozen — but deliberately sequenced into a later slice rather than left as unresolved questions.

**Neither of the two items above was revisited by the Slice 2D-B2-0 schema freeze, by the Slice 2D-B2-A amendment, by the Slice 2D-B2-B0 schema freeze, by the Slice 2D-B2-B amendment, by the Slice 2D-C0 schema freeze, by Slices 2D-C1/C1-amendment/C2, nor by the Slice 2D-C3-0 schema freeze.** Both remain exactly as recorded: still open, still requiring a separately authorized architecture decision before their respective runtimes can be authorized. `NO_RESPONSE`'s entry, specifically, is directly relevant to — but not solved by — the Slice 2D-C0 freeze: `ContextRequest` now has an identity link precise enough to someday carry a `responseDeadlineAt` if that mechanism is ever chosen, but this freeze does not choose it, add it, or otherwise narrow the open decision (§9 above; per §22/§26 of the Slice 2D-C0 governing packet). The Slice 2D-C3-0 freeze names a third genuine prerequisite of `NO_RESPONSE`'s eventual closure — `ContextRequest` now also has an atomic-transition mechanism precise enough to someday consume a `responseDeadlineAt` if that mechanism is chosen — without itself choosing, adding, or narrowing it.

**The Slice 2D-C3-0 schema freeze introduces zero new open decisions.** All nineteen items its governing packet asked to be closed (§13.A's "Schema decisions closed (Slice 2D-C3-0)," A–S) were closeable from source-of-truth already accepted in this document, `MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md` §8/§9 (which already named `SessionVersionLineage`'s conceptual field set and deliberately deferred its exact type/name to this freeze), and this repository's existing runtime (`src/stress-test/session.ts`'s `createSession`/`addAuthorContextItem`/`freezeInput`/`verifyFrozenInputIntegrity` and the actual `sha256Text`/`sha256AuthorContext` hash implementations, inspected directly rather than assumed) — not left open for lack of a clear answer. The one point the governing packet explicitly left open for evaluation (§26, Session B's lifecycle state at the end of the transition) is closed here (§I) with the reasoning the packet itself asked for, not deferred further; the point the packet asked to be resolved together with another (§13/§36, lineage ownership) is closed as one coherent answer rather than two independent, potentially-conflicting ones (§D).

**The Slice 2D-C0 schema freeze introduces zero new open decisions.** All thirteen items its governing packet asked to be closed (§7's "Schema decisions closed (Slice 2D-C0)," A–M) were closeable from source-of-truth already accepted in this document and this repository's existing runtime (`src/stress-test/deliberation.ts`'s current `ContextRequest` interface and `createContextRequest`, inspected directly) and this contract's own already-established patterns (single-hop backward-pointing derived identity, ledger-before-provenance, never-trust-an-upstream-check-for-pre-existing-state) — not left open for lack of a clear answer.

**The Slice 2D-B2-B0 schema freeze introduces zero new open decisions.** All fifteen items its governing packet asked to be closed (§9's "Schema decisions closed (Slice 2D-B2-B0)," A–O) were closeable from source-of-truth already accepted in this document and this repository's existing runtime (`src/stress-test/deliberation.ts`'s current `UnresolvedQuestion`, `createUnresolvedQuestion`, `cloneUnresolvedQuestion`, and `registerUnresolvedQuestion`, inspected directly rather than assumed) and this contract's own already-established patterns (global-before-local integrity validation, write-time-gate-is-not-sufficient-alone, never-automatically-reconciled cardinality violations) — not left open for lack of a clear answer.

**This amendment introduces zero new open decisions.** Both executable-consistency gaps it was asked to close — the legacy active-cycle integrity gap and the incomplete `STOP`-interaction closure — were closeable from source-of-truth already accepted in this repository and this contract's own already-established patterns (the "never trust an upstream check for pre-existing state" posture already used everywhere else, and the existing `budget`/`latency` `StopReason` vocabulary), not left open for lack of a clear answer.

Every other decision either governing packet asked to be closed (§22, including the amendment's H–M, the Slice 2D-B0 schema freeze's A–N in §7, and the Slice 2D-B2-0 schema freeze's A–O in §9) is closed, using only source-of-truth material already in this repository (`src/stress-test/deliberation.ts`, `src/stress-test/session.ts`, `src/stress-test/types.ts`, `src/providers/types.ts`, `src/agents/collaboration.ts`, `MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md`) and the packets' own explicit instructions. No contradiction between governing documents was found, so nothing was reported instead of resolved. `ReplicationResult`'s exact vocabulary (§13.C) and the `questionDispositions` migration shape (§15) were closed rather than left open, on the same minimal-closed-enum / purely-additive-field reasoning pattern this repository already uses for `StopReason` and `RootCauseCategory` — both are conceptual-only and implement nothing. The per-route `AttemptStatus` allowlist (§6, decision K of §22) was originally submitted as Engineering Lead advisory input in Slice 2C and has now been explicitly accepted by GPT as binding — recorded here as provenance, not as a decision this document made unilaterally. `ADD_REVIEWER`'s newness-provenance rule (§7 decision D) is closed as a structural, multi-signal check, not as identity equality — GPT's rejection of the prior `reviewerRunId === attemptId` convention is fully incorporated, not merely noted. The `STOP`-while-open-attempt decision (§9 decision N) was explicitly evaluated against all three options the governing packet posed, not assumed by default.

---

## 25. Implementation authorization

This ledger records current implementation/authorization status only. It does not reopen, reinterpret, or rewrite any architecture decision closed elsewhere in this document — it corrects a stale status snapshot against decisions that have since been separately, explicitly authorized and accepted.

**IMPLEMENTED / ACCEPTED:**

`RouteAttempt` runtime: **IMPLEMENTED / ACCEPTED**
`RouteOutcome` runtime — currently accepted subset only (generic `FAILED`; `ADD_REVIEWER` success; `REPLICATE` success; `ADD_CONTEXT` `SUPPLIED`/`DECLINED` success — Slice 2D-C2; per the route-readiness table, §7): **IMPLEMENTED / ACCEPTED**
`QuestionDisposition` runtime — `STILL_OPEN` / `RESOLVED` only: **IMPLEMENTED / ACCEPTED**
Currentness / active-cycle core (`isQuestionCurrent`, all five current gates, the authoritative active-cycle creation gate, and independent legacy active-cycle integrity validation — Slice 2D-B2-A): **IMPLEMENTED / ACCEPTED**
`QuestionDisposition.SUPERSEDED_RECLASSIFIED` runtime, including `derivedFromQuestionId` and the derived-lineage/question-terminality read-integrity hardening — Slice 2D-B2-B, accepted per the Slice 2D-B2-B amendment and the Slice 2D-C0 packet's own "Previous status" (§0): **IMPLEMENTED / ACCEPTED**
`ContextRequest` <-> `RouteAttempt` attempt-binding runtime (`originatingAttemptId`, `contextRequests[]` ledger, attempt-bound `createContextRequest`) — Slice 2D-C1, accepted per the Slice 2D-C1 amendment and the Slice 2D-C2/2D-C3-0 packets' own "Previous status" fields: **IMPLEMENTED / ACCEPTED**
`ADD_CONTEXT` `SUPPLIED`/`DECLINED` success (`AddContextRouteOutcome`, mandatory `ContextRequest`-ledger provenance validation) — Slice 2D-C2, accepted per the Slice 2D-C3-0 packet's own "Previous status" (§0): **IMPLEMENTED / ACCEPTED**

**NOT YET IMPLEMENTED / NOT GENERALLY AUTHORIZED:**

Provider-backed route execution: **NOT AUTHORIZED**
`CROSS_SESSION` / `SessionVersionLineage` runtime (schema frozen only by the Slice 2D-C3-0 freeze, §13.A): **NOT AUTHORIZED**
`NO_RESPONSE`: **NOT AUTHORIZED**
`SEEK_EVIDENCE` result runtime: **NOT AUTHORIZED**
`TARGETED_PEER_CHALLENGE` success runtime: **NOT AUTHORIZED**
Route execution generally, and Slice 2D's full/general scope beyond the specific accepted subsets recorded above: **NOT AUTHORIZED**

Provider/model calls: **0**
