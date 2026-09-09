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

Re-reviewed for the Slice 2D-B0 amendment: no contradiction found. `chunkId`/`agentId`/paragraph identity are not reintroduced as product-domain authority; `RouteInputRef`-based source/target identity is unchanged.

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

**F. Exact `SEEK_EVIDENCE` payload/provenance.** `{ result, citations: EvidenceCitation[] }`; `EvidenceCitation` reused as principle from `main`'s `RetrievalSource`, deliberately excluding its unbounded `raw` field. `excerpt` is source-attributable text, never an arbitrary assistant paraphrase (Slice 2D-B0 amendment).

**G. Exact `TARGETED_PEER_CHALLENGE` payload/provenance.** `{ targetRef, sourceRef, boundedExcerpt, response, result }`; `boundedExcerpt` reused as principle from `main`'s `buildPeerExcerpt`, stripped of chunk/paragraph identity. Re-reviewed this amendment; unchanged.

**H. Which fields are derived vs. caller-supplied.** See the generic-envelope table above. **Corrected by the Slice 2D-B0 amendment:** `logicalCost` is not caller input at all — always derived, with no "supply and reject on mismatch" path.

**I. Exact status/result consistency rules.** See the table above; a mismatched pair (e.g. `SEEK_EVIDENCE` `INCONCLUSIVE` + `status: SUCCEEDED`, or `REPLICATE` `PARTIAL` + `status: INCONCLUSIVE`) is structurally invalid and must be rejected.

**J. Is any route blocked by insufficient accepted domain provenance?** No route is blocked outright, but one **result variant** is: `ADD_CONTEXT`'s `NO_RESPONSE` cannot yet be safely terminalized (see "Runtime readiness," above, and §24). `ADD_CONTEXT` (`SUPPLIED`/`DECLINED`) and `REPLICATE` are direct restatements of already-explicit contract text. `TARGETED_PEER_CHALLENGE` and `SEEK_EVIDENCE` are closed via principles reused from already-validated `main` mechanisms (`buildPeerExcerpt`, `RetrievalSource`). `ADD_REVIEWER` is closed via a structural, multi-signal provenance rule rather than the (rejected) identity-equality convention — safe to implement subject to that rule.

**K. (Slice 2D-B0) Is `reviewerRunId` reuse across `ADD_REVIEWER` outcomes permitted?** No. At most one successful `ADD_REVIEWER` `RouteOutcome` per `reviewerRunId` within a `StressTestSession` lineage; a second claim is rejected, checked structurally, never inferred from timestamp alone.

#### Route readiness table (Slice 2D-B0 amendment)

Not a purely relative sequencing preference — one result variant is an actual architecture blocker, and the table below says so explicitly rather than treating every route/result as equally ready:

**Ready for first `RouteOutcome` runtime:**
- `REPLICATE`
- `TARGETED_PEER_CHALLENGE`
- `ADD_CONTEXT` — `SUPPLIED`
- `ADD_CONTEXT` — `DECLINED`

**Ready subject to the new `ADD_REVIEWER` provenance rule** (structural, multi-signal — §7 "Newness provenance," above):
- `ADD_REVIEWER`

**Schema ready, but execution/retrieval still not authorized** (no provider/retrieval mechanism is chosen or implemented anywhere in this contract):
- `SEEK_EVIDENCE`

**Blocked:**
- `ADD_CONTEXT` — `NO_RESPONSE` (no response-window/closure architecture exists yet; see the open decision in §24)

No route or result variant is claimed ready merely for symmetry with the others; `NO_RESPONSE` stays blocked until a separate, explicit response-closure architecture decision is made.

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

A question's disposition history is itself append-only, but bounded: it may accumulate any number of `STILL_OPEN` records — one per re-evaluation cycle that did not close it — but the moment a terminal disposition is recorded, no disposition of any kind may follow it for that question (§19). This removes any ambiguity from "current disposition" semantics: for a non-terminal question, the current disposition is simply its most recent `STILL_OPEN` record (or "none yet"); for a terminal question, there is exactly one disposition, ever, and it is the terminal one.

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

**Fail-closed on non-current questions:** once a question's disposition is terminal (`RESOLVED`, `SUPERSEDED_RECLASSIFIED`, or `CROSS_SESSION`, §9), it leaves the current set permanently — there is no path back from a terminal disposition. A future implementation phase must update `planRouteForQuestion` and `recordRouteDecision` (or an equivalent routing gate) so that a non-`STOP` `RouteDecision` may target only a question in the *current* set — not merely any historical question still physically present in the append-only `unresolvedQuestions` registry. This is not implemented by this document; it is a binding requirement on whatever phase does implement it.

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

A question may accumulate multiple `QuestionDisposition` records only through the non-terminal path: `STILL_OPEN` → fresh `RouteDecision` → fresh `RouteAttempt` → fresh `RouteOutcome` → new `QuestionDisposition`. The moment a terminal disposition (`RESOLVED`/`SUPERSEDED_RECLASSIFIED`/`CROSS_SESSION`) is recorded, no later disposition may exist for that question (§9) — for a terminal question there is exactly one disposition, ever.

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

---

## 23. Relation to accepted Slice 2A/2B runtime

Nothing in this document alters, weakens, or contradicts `src/stress-test/deliberation.ts` as it stands at HEAD. Every new concept is additive and downstream: `RouteAttempt` references an existing `RouteDecision` without changing its shape; `QuestionDisposition` references an existing `UnresolvedQuestion` without mutating it; the current-question derivation (§15) is backward compatible with `unresolvedQuestions: UnresolvedQuestion[]` exactly as implemented today. No accepted invariant from Slice 2A, the Slice 2A amendment, or Slice 2B is redesigned, loosened, or reopened by this document.

---

## 24. Open GPT decisions

**One genuinely open item — not hidden, not closed by convenience:**

**`NO_RESPONSE` terminalization mechanism: OPEN / deferred to future human-response-lifecycle architecture.** `ADD_CONTEXT`'s `NO_RESPONSE` result cannot be defensibly terminalized without an explicit response-closure mechanism — a `responseDeadlineAt` bound to `ContextRequest`, or an explicit externally recorded request-window-close event (§7, invariant 29). Existing accepted source-of-truth does not clearly dictate which of those two mechanisms is correct, and no timeout duration may be invented to manufacture a closure. This is left open deliberately, not resolved by picking one arbitrarily; a future, separately authorized architecture decision must close it before `NO_RESPONSE` runtime can be authorized.

Every other decision either governing packet asked to be closed (§22, including the amendment's H–M and the Slice 2D-B0 schema freeze's A–K in §7) is closed, using only source-of-truth material already in this repository (`src/stress-test/deliberation.ts`, `src/stress-test/session.ts`, `src/stress-test/types.ts`, `src/providers/types.ts`, `src/agents/collaboration.ts`, `MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md`) and the packets' own explicit instructions. No contradiction between governing documents was found, so nothing was reported instead of resolved. `ReplicationResult`'s exact vocabulary (§13.C) and the `questionDispositions` migration shape (§15) were closed rather than left open, on the same minimal-closed-enum / purely-additive-field reasoning pattern this repository already uses for `StopReason` and `RootCauseCategory` — both are conceptual-only and implement nothing. The per-route `AttemptStatus` allowlist (§6, decision K of §22) was originally submitted as Engineering Lead advisory input in Slice 2C and has now been explicitly accepted by GPT as binding — recorded here as provenance, not as a decision this document made unilaterally. `ADD_REVIEWER`'s newness-provenance rule (§7 decision D) is closed as a structural, multi-signal check, not as identity equality — GPT's rejection of the prior `reviewerRunId === attemptId` convention is fully incorporated, not merely noted.

---

## 25. Implementation authorization

Implementation: **NOT AUTHORIZED**
Provider-backed route execution: **NOT AUTHORIZED**
`RouteAttempt` runtime: **NOT AUTHORIZED**
`RouteOutcome` runtime: **NOT AUTHORIZED**
`QuestionDisposition` runtime: **NOT AUTHORIZED**
Session version runtime: **NOT AUTHORIZED**
Slice 2D: **NOT AUTHORIZED**
Provider/model calls: **0**
