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
| `NO_RESPONSE` | **SCHEMA FROZEN — RUNTIME NOT YET AUTHORIZED** |

`SUPPLIED` and `DECLINED` are both *positive, human-initiated* facts — a human actively responded, one way or the other, and that fact can be terminalized the moment it happens. `NO_RESPONSE` is different in kind: it is not an observation of what a human did, but an affirmative lifecycle decision that waiting for a response has ended. **Corrected by the Slice 2D-C4-0 freeze:** the earlier framing below, that this decision depends on *how long* to wait, was the wrong question — see the "Schema freeze (Slice 2D-C4-0)" subsection later in this section for the closed answer: `NO_RESPONSE` is authorized by an explicit closure action, never by elapsed time. A caller must never be able to declare `NO_RESPONSE` merely by asserting the result on an ordinary `RouteOutcome` payload — that boundary is now enforced by requiring a dedicated closure operation rather than a `recordRouteOutcome` branch (§ below, decision C).

**First-runtime subset, until `NO_RESPONSE` runtime is separately authorized:** the currently accepted `RouteOutcome` implementation for `ADD_CONTEXT` supports `SUPPLIED -> SUCCEEDED`, `DECLINED -> SUCCEEDED`, and `FAILED -> FailureInfo` (Slice 2D-C2, accepted). It does **not yet** support `NO_RESPONSE` in runtime — the closure *mechanism* is now architecturally closed (Slice 2D-C4-0, below), but implementing it is a separate, not-yet-authorized runtime slice. No timeout duration is invented anywhere in this document.

**Formerly an open architecture dependency (§24) — now closed by the Slice 2D-C4-0 freeze, later in this section.** The dependency was resolved in favor of an explicit closure event, never a `responseDeadlineAt`/deadline field of any kind; see the freeze subsection for the complete closed answer.

**Governance status corrected by the Slice 2D-C5-0 amendment.** The "SCHEMA FROZEN — RUNTIME NOT YET AUTHORIZED" row above and the "First-runtime subset" paragraph both describe this document's status as of the Slice 2D-C4-0 freeze, a point-in-time snapshot preserved here as historical record rather than rewritten in place (the same editorial posture already applied to the Slice 2D-B0 final amendment's own readiness table, §24). The Slice 2D-C4 runtime — `AddContextNoResponseRouteOutcome` and `closeContextRequestWithoutResponse`, gated exactly as decision C below specifies — has since been separately, explicitly authorized and accepted (§25). `NO_RESPONSE` is therefore READY in the accepted runtime today, on equal footing with `SUPPLIED`/`DECLINED`. **Further corrected by the Slice 2D-D0 packet:** `SEEK_EVIDENCE`'s and `TARGETED_PEER_CHALLENGE`'s own runtime have both since been separately authorized and accepted as well (Slice 2D-C5-A/2D-C5-B and Slice 2D-C6-A/2D-C6-B respectively, §25) — no route named in this document remains not-yet-authorized at the offline/domain layer as of Slice 2D-D0; only provider/retrieval/human execution remains `0` / **NOT AUTHORIZED**, unconditionally.

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

**Corrected by the Slice 2D-C5-0 freeze — the gap is now closed.** See "Schema freeze (Slice 2D-C5-0): `EvidenceSubject` / claim-level provenance" in §13.D for the complete closed answer: a dedicated, immutable `EvidenceSubject` audit fact, registered before routing, referenced by id from the eventual `RouteOutcome` rather than restated. This document no longer declines to add claim identity — it adds exactly one durable identity (`EvidenceSubject.id`) and explicitly continues to reject `claimIndex`/`paragraphId`/`chunkId` as identity (they remain provenance/location facts, never authority).

##### Runtime readiness — corrected by the Slice 2D-C5-0 freeze

The claim-identity *architecture* that previously blocked every `SEEK_EVIDENCE` result variant is now closed (§13.D, Slice 2D-C5-0). Runtime itself remains **NOT YET IMPLEMENTED** — this freeze closes the schema; it does not build `registerEvidenceSubject`, the `EvidenceSubject` ledger, the routing gate, or `SeekEvidenceRouteOutcome` recording (§25):

| Result | Runtime readiness |
|---|---|
| `SUPPORTIVE` | **SCHEMA FROZEN — RUNTIME NOT YET AUTHORIZED** |
| `CONTRADICTORY` | **SCHEMA FROZEN — RUNTIME NOT YET AUTHORIZED** |
| `INCONCLUSIVE` | **SCHEMA FROZEN — RUNTIME NOT YET AUTHORIZED** |

A generic `FAILED` `RouteOutcome` + `FailureInfo` remains recordable for an already-started `SEEK_EVIDENCE` attempt regardless of `EvidenceSubject` — failure only records that the attempt did not produce a valid route result; it does not claim a successful evidence judgment against any claim, so it never needed claim identity in the first place (§13.D, decision P). Retrieval itself remains **NOT AUTHORIZED** regardless of this readiness question.

**Governance status corrected by the Slice 2D-C6-0 freeze.** The table above and this section's own "Runtime itself remains NOT YET IMPLEMENTED" wording are a point-in-time snapshot as of the Slice 2D-C5-0 freeze, preserved here as historical record rather than rewritten in place (the same editorial posture already applied earlier in this document, §7, to the `NO_RESPONSE` governance-status correction). `registerEvidenceSubject`, the `EvidenceSubject` ledger and its three-boundary routing gate, and `SeekEvidenceRouteOutcome` recording have since been separately, explicitly authorized and accepted (Slice 2D-C5-A/2D-C5-B, §25). `SUPPORTIVE`/`CONTRADICTORY`/`INCONCLUSIVE` are therefore **IMPLEMENTED / ACCEPTED** in the runtime today, not merely schema-frozen. Retrieval remains **NOT AUTHORIZED**, unconditionally, unaffected by this correction.

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

**Sequencing question closed by the Slice 2D-C6-0 freeze:** "the exact function is not chosen here," above, is no longer accurate as a statement of open architecture — the exact gate placement (five independent boundaries, not one) is now chosen; see §13.E immediately below invariant 79. **Status corrected by the Slice 2D-D0 packet:** the gate is no longer merely chosen at the architecture level — Slice 2D-C6-A has since implemented it, and Slice 2D-C6-B has since implemented `TARGETED_PEER_CHALLENGE` successful-result recording against it; both are **IMPLEMENTED / ACCEPTED** (§25).

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

**Governance status corrected by the Slice 2D-D0 packet.** The "no ... successful result variant ... may be recorded" wording above is a point-in-time snapshot as of the Slice 2D-B0 final amendment, preserved here as historical record rather than rewritten in place (the same editorial posture already applied earlier in this document, §7, to the `NO_RESPONSE` and `SEEK_EVIDENCE` governance-status corrections). The input-cardinality routing gate has since been implemented (Slice 2D-C6-A), and `REBUTTAL`/`CONCESSION`/`QUALIFICATION`/`REFUSAL_TO_YIELD` successful-result recording, with full `targetRef`/`sourceRef` decision-provenance and distinctness validation, has since been implemented against it (Slice 2D-C6-B) — both separately, explicitly authorized and accepted (§25). `TARGETED_PEER_CHALLENGE` successful results are therefore **IMPLEMENTED / ACCEPTED** in the runtime today, not merely schema-frozen.

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

**N. (Slice 2D-B0 final amendment) Is `SEEK_EVIDENCE`'s claim-level provenance closed?** **Corrected by the Slice 2D-C5-0 freeze: YES.** A dedicated `EvidenceSubject` audit fact now carries claim identity (`id`) and an immutable `claimText`; `claimIndex`/`paragraphId`/`chunkId` remain explicitly rejected as identity, exactly as this document always insisted (§13.D, Slice 2D-C5-0 freeze).

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

**Governance status corrected by the Slice 2D-C6-0 freeze; further corrected by the Slice 2D-D0 packet.** The table above is a point-in-time snapshot from the Slice 2D-B0 final amendment, preserved here as historical record rather than rewritten in place (the same editorial posture already applied earlier in this document, §7, to the `NO_RESPONSE` governance-status correction). `SEEK_EVIDENCE — SUPPORTIVE / CONTRADICTORY / INCONCLUSIVE`'s "Not ready" listing above is stale: `EvidenceSubject` registry/integrity/routing-gate runtime (Slice 2D-C5-A) and `SeekEvidenceRouteOutcome` recording with route-specific later-read provenance validation (Slice 2D-C5-B, including its read-provenance-hardening amendment) have both since been separately, explicitly authorized and accepted (§25); `SEEK_EVIDENCE` successful/inconclusive results are therefore **READY** in the accepted runtime today. `TARGETED_PEER_CHALLENGE`'s "Not ready" listing above is now equally stale: its readiness gate (Slice 2D-C6-A) and its `REBUTTAL`/`CONCESSION`/`QUALIFICATION`/`REFUSAL_TO_YIELD` successful-result recording (Slice 2D-C6-B) have both since been separately, explicitly authorized and accepted (§25); `TARGETED_PEER_CHALLENGE` successful results are therefore **READY** in the accepted runtime today as well. Only `ADD_CONTEXT`'s `NO_RESPONSE` listing above remains itself stale in a different direction than this correction addresses — see §7 above, where its own governance-status correction already lives. As of the Slice 2D-D0 packet, every route/result variant this table originally listed has an accepted offline/domain runtime; nothing in this table's "Not ready" list remains genuinely not-ready at the offline/domain layer (§25's own new "Offline/domain closure" note). This is exclusively an offline/domain-ledger claim — it says nothing about provider/retrieval/human execution, which remains `0` / **NOT AUTHORIZED** unconditionally (see the new closing section on live-execution boundaries).

#### Generic `FAILED` outcome remains structurally useful

A generic `FAILED` `RouteOutcome` stays recordable for **every** route above. As of the Slice 2D-D0 packet, this is no longer a distinction between "ready" and "not yet runtime-ready" successful payloads — every route/result this table names now has an accepted offline/domain runtime (§25) — but the principle itself remains true and load-bearing for legacy/historical state: `FAILED` means only that the mechanism did not produce a valid route-specific result; it never required the successful-result schema to be complete, and it makes no claim requiring two-sided provenance, claim-level identity, or anything else a route's own successful-result rule needs. This does **not** authorize executing `TARGETED_PEER_CHALLENGE`, `SEEK_EVIDENCE`, or any other route, or waiting for a `NO_RESPONSE` closure — it only means the generic ledger schema can represent an already-started attempt's defensible failure terminalization, for whichever route that already-started attempt happens to be. Provider execution remains `0` / **NOT AUTHORIZED**, unconditionally, regardless of offline/domain readiness.

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

**Corrected by the Slice 2D-C3-0 amendment:** the `DRAFT` step shown above is an internal construction detail, not an externally observable one. The atomic transition operation may pass Session B through `DRAFT` internally while building it, but it never returns, and no caller ever observes, Session B in `DRAFT` — the only externally observable result of a successful transition is Session B already `INPUT_FROZEN` (§I below).

Rules, unchanged from the routing contract: no unfreeze; no mutation of Session A; `Q1` remains historical under Session A, never copied as current into Session B; Session A's findings remain historical; Session B gets its own, newly-bound current review state. No versioning is implemented by this document.

**Corrected by the Slice 2D-C3-0 amendment — `DECLINED`/`NO_RESPONSE` disposition semantics.** The prior statement that `DECLINED` and `NO_RESPONSE` both mechanically leave `Q1`'s disposition `STILL_OPEN` was wrong: `AddContextResult` and `QuestionDisposition` are, and remain, separate domains (§10 above) — an attempt result never itself computes or defaults to a disposition.

- **`DECLINED`:** produces no `SessionVersionLineage` and no Session B. It does **not** mechanically determine `QuestionDisposition`. `Q1` remains current under Session A until a separately supplied semantic re-evaluation records a valid disposition for it — which may legitimately be `STILL_OPEN`, `RESOLVED`, or `SUPERSEDED_RECLASSIFIED`, subject to the same rules that already govern every other route's re-evaluation (§10's table). Nothing in this document computes that disposition automatically from `result: 'DECLINED'`.
- **`NO_RESPONSE`:** as written at the Slice 2D-C3-0 amendment, runtime remained **NOT AUTHORIZED** — the closure *mechanism* was then only architecturally closed by the Slice 2D-C4-0 freeze (below: an explicit closure action, never elapsed time), with implementation a separate, not-yet-authorized runtime slice. **Status corrected by the Slice 2D-C5-0 amendment:** the Slice 2D-C4 runtime has since been separately authorized and accepted (§25) — `AddContextNoResponseRouteOutcome` now exists in the accepted runtime, produced only through `closeContextRequestWithoutResponse`. This does not change the disposition rule stated here: no `QuestionDisposition` is inferred from a `NO_RESPONSE` outcome, and no lineage/session transition results from one — exactly like `SUPPLIED`/`DECLINED`, `NO_RESPONSE` never mechanically determines `QuestionDisposition` (§ below, decision K).

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

**Corrected by the Slice 2D-C3-0 amendment — observable scope.** All three rules above are enforced, and are only ever claimed, within the scope this runtime can actually observe: one parent `DeliberationState`'s own `sessionVersionLineages[]` ledger. There is no global session or lineage registry in this runtime (§D above), so none of these rules is a claim that a given `childSessionId` is absent from every other `DeliberationState` that may exist elsewhere — each rule only claims uniqueness within the one ledger a given integrity check actually reads. A genuinely global guarantee would require an authoritative global session collection, which this document does not introduce.

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

**Corrected by the Slice 2D-C3-0 amendment — two independent dimensions, not one.** The three chains above are all **parent-side**: everything they walk lives inside `DeliberationState A`, and the parent-side helper (§P below) can and must validate all of them from the parent state alone. **Child-side** validation — `SessionVersionLineage -> the actual Session B` (§ child-side helper below) — is a distinct dimension that the parent-side helper cannot reach, because Session B is never stored inside `DeliberationState A` (§D above). Child-side validation is only meaningful, and only ever required, when a real child session object is actually being used or inspected by the caller; it is never a claim the parent-side helper alone can or does make. Both dimensions apply together whenever a caller holds and relies on the real child object; only the parent-side dimension applies when a caller has nothing but the persisted `DeliberationState A`.

##### O. Response reuse prevention

Closed, an executable mechanism, not hand-waved: because the persisted `sessionVersionLineages[]` ledger lives on `DeliberationState A` (§D), a **write-time** check is possible and required -- before creating anything, `createCrossSessionTransition` scans `deliberationState.sessionVersionLineages` for an existing entry whose `suppliedOutcomeAttemptId === input.suppliedOutcomeAttemptId`; if one already exists, the call rejects outright (no second child session, no overwrite, no silent reuse of the existing one). This is the same "if any existing X already claims this identity, reject" write-time gate already frozen for `ContextRequest` (invariant 50, "`ONE ADD_CONTEXT RouteAttempt -> AT MOST ONE ContextRequest`") applied one layer further down the chain.

##### P. Parent-side lineage ledger integrity

**Corrected by the Slice 2D-C3-0 amendment — the prior version of this section claimed a single helper could validate child-session contents from parent state alone; that claim was impossible and is removed.** Closed, precisely scoped: a future, pure, non-cached helper -- name not binding, conceptually `assertSessionVersionLineageLedgerIntegrity(parentDeliberationState)` -- validates only facts resolvable authoritatively from the **parent** `DeliberationState` alone, on every read of the COMPLETE `sessionVersionLineages[]` collection: `lineageId` non-empty and globally unique; `parentSessionId`/`childSessionId` both non-empty and never equal to each other; `childSessionId` unique across the ledger (§E.3) and `suppliedOutcomeAttemptId` unique across the ledger (§E.2), both re-derived independently at read time, never trusting the write-time gate alone for state that may predate it -- the same posture this contract has taken since the Slice 2D-B2-0 amendment; `parentSessionId` matches the containing `DeliberationState.sessionId`; `parentArtifactHash`/`parentAuthorContextHash` match the containing `DeliberationState`'s own hashes; `suppliedOutcomeAttemptId` independently resolves to exactly one existing `RouteOutcome` and re-validates the COMPLETE `ADD_CONTEXT` provenance chain (§N, all eleven steps, including full `ContextRequest`-ledger integrity and exact request binding -- not merely re-checking that the lineage record's own copied fields are internally consistent); `originatingQuestionId`/`contextRequestId` match that resolved chain exactly; a matching `CROSS_SESSION` `QuestionDisposition` exists for `originatingQuestionId` on the same `attemptId`; no fork (§E.2) and no reuse (§O) ambiguity. Never cached, never persisted beyond the ledger entries themselves.

**This helper does not, and cannot, validate the contents of Session B.** `addedAuthorContextItemId`'s presence inside a real child `AuthorContext`, `childSession.state === 'INPUT_FROZEN'`, or either child hash actually matching a real session object are all facts about an object this helper never receives -- Session B is never stored inside `DeliberationState A` (§D above), so a helper that receives only the parent state has no child object to inspect. Claiming otherwise would assert a capability this runtime does not possess. Validating those facts requires the separate child-side helper immediately below, which takes the actual child session as an explicit argument.

##### Child-side lineage validation boundary

Closed: a separate, pure validation, conceptually `assertSessionVersionLineageChildIntegrity(lineage, childSession, resolvedSuppliedOutcome, resolvedContextRequest)` -- exact signature/name not binding, but the dependency on an explicitly-supplied child session object is not optional. It validates the actual child `StressTestSession` when, and only when, that object is available to the caller (e.g. immediately after `createCrossSessionTransition` returns it, or whenever a caller independently holds both `DeliberationState A` and the specific `StressTestSession B` it names). Required checks: `childSession.id === lineage.childSessionId`; `childSession.id !== lineage.parentSessionId`; `childSession.state === 'INPUT_FROZEN'`; `verifyFrozenInputIntegrity(childSession)` passes; `childSession.artifactHash === lineage.childArtifactHash`; `childSession.authorContextHash === lineage.childAuthorContextHash`; `childSession.artifactHash === lineage.parentArtifactHash` (§G's hash-equality equation, checked against the real object, not merely restated); exactly one `AuthorContextItem` in `childSession.authorContext` with `id === lineage.addedAuthorContextItemId`; that item's `category === resolvedContextRequest.category`; that item's `text === resolvedSuppliedOutcome.responseText`; that item's `sourceType === 'AUTHOR'` and `status === 'CURRENT'` (§H); and that `childSession.authorContext` contains exactly Session A's copied items plus that one new item -- no omission, no duplication, no extra item. This helper does not create, register, or persist anything, and does not require or introduce a global child-session registry -- no such registry exists anywhere in this runtime, and none is introduced by this document -- it only ever operates on a child session object the caller already, independently possesses.

##### What persisted lineage can, and cannot, prove alone

Closed: `SessionVersionLineage`, once persisted in `DeliberationState A`, proves exactly this -- at transition time, this child identity and these child hashes and this added-item identity were produced from this exact `SUPPLIED` outcome, and that fact remains globally re-verifiable forever after by re-walking the parent-side chain (§P above). It does **not**, by itself, make the child `StressTestSession` object globally retrievable, and it does not prove anything about that object's *current* contents at some later read time -- this runtime has no session repository, and a lineage record is not one. Verifying the actual child's contents (child-side helper above) requires the caller to already, independently hold that child session object -- today, only the caller who received it directly from `createCrossSessionTransition`, or who is separately threading it through their own code. If a future slice ever introduces an authoritative global session repository, child-side verification could be extended to run automatically at any later read; until then, this document does not claim a capability the runtime does not have.

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

**Corrected by the Slice 2D-C3-0 amendment.** The prior recommendation below was invalid: it proposed a `2D-C3-A` slice that would persist a real `sessionVersionLineages[]` entry and/or return a real, usable child `StressTestSession` as its own standalone, independently-callable result, before any `2D-C3-B` existed to record the corresponding `CROSS_SESSION` `QuestionDisposition`. Being permitted to author an internal primitive first is not the same as being permitted to persist half of an atomic transition — any slice whose own successful execution could produce a `DeliberationState` with a lineage entry (or a real child session) but no matching disposition would itself violate invariant 57/§L, the exact three-fact atomicity rule this same freeze establishes. "Can be built and tested independently" was true only of the pure logic; it was not true of exposing that logic as a live, standalone write path, and the prior wording did not draw that line.

**Recommended (Option 1 of the governing amendment packet, preferred absent any code-inspection evidence that separation would materially lower implementation risk -- none was gathered, since this amendment is documentation-only):**

**`SLICE 2D-C3` — ATOMIC `CROSS_SESSION` TRANSITION RUNTIME**, one implementation slice, single commit boundary for anything that can mutate a real `DeliberationState`: `SessionVersionLineage` type; `sessionVersionLineages[]` ledger on `DeliberationState`; legacy missing-ledger compatibility (§Q); the parent-side lineage ledger integrity helper (§P); the child-side lineage validation helper (§ child-side helper above); child construction helpers (`AuthorContext` copy + one new item, §F-§H); the mandatory fresh `SUPPLIED`-outcome provenance validation (§N) and the authoritative-upstream chain (§ above); the response-reuse write-time gate (§O); `CROSS_SESSION` `QuestionDisposition` recording; the atomic `createCrossSessionTransition` operation itself (§K/§L), returning all three facts together or none; and tests covering every one of the above. No sub-slice of this work may be committed, merged, or reported complete on its own if it exposes any standalone, independently-callable path that appends to `sessionVersionLineages[]` or returns a completed/usable child session without also recording the matching `CROSS_SESSION` disposition in the same atomic call.

**If a future packet later finds concrete implementation-risk evidence (from actual code inspection, not anticipated here) that justifies splitting this work, the only acceptable split is:**

**`SLICE 2D-C3-A` — PURE INTERNAL PRIMITIVES ONLY:** types (`SessionVersionLineage`); pure validators, including both the parent-side helper (§P) and the child-side helper (§ above), each operating only on caller-supplied or synthetic fixture state, never a live production write path; a child-construction helper that is not exported as, or callable as, a completed transition. Explicitly excluded from this slice: any append to a real `sessionVersionLineages[]`; any persisted child/lineage fact; any caller-visible completed Session B transition. This slice produces no code path capable of persisting a partial transition, because it persists nothing at all.

**`SLICE 2D-C3-B` — the single atomic operation** (`createCrossSessionTransition`, §K/§L) that persists and returns all three facts together -- `CROSS_SESSION` disposition, `SessionVersionLineage`, child `StressTestSession` -- or none. This is the only slice authorized to introduce a code path that mutates a real `DeliberationState` with lineage data, and it may not be split further.

Under either option, **no future packet may authorize, and no report may claim complete, a runtime slice that persists a `SessionVersionLineage` entry or hands back a completed child session independently of recording the matching `CROSS_SESSION` disposition in the same atomic call.**

`NO_RESPONSE` and `SEEK_EVIDENCE` claim-level provenance remain excluded from all of the above — neither dependency is built by any of it.

#### Schema freeze (Slice 2D-C4-0): `ADD_CONTEXT` `NO_RESPONSE` closure

`NO_RESPONSE` has been named, unscheduled, since the Slice 2D-B0 amendment first blocked it (§7, "Runtime readiness," invariant 29) for exactly one reason: nothing in this contract defined *when* an absence of response becomes a defensible terminal fact. This freeze closes that gap — not by inventing a duration, but by replacing the entire "how long is long enough" question with an explicit, auditable closure action. Nothing below is implemented; no `src/**` type, function, or test is added.

**Core architecture question, answered:** the defensible terminal fact is not elapsed time; it is an explicit closure event. `NO_RESPONSE` means "the system explicitly closed this `ContextRequest` without a `SUPPLIED` or `DECLINED` response ever having been recorded for its `RouteAttempt`" — a domain closure fact, not an inference from silence. Nothing about *when* that closure should happen is decided here; only *what it means* once it happens.

##### A. Exact semantic meaning

Closed: `NO_RESPONSE` records that this specific, already-created `ContextRequest` was explicitly closed by an affirmative lifecycle action, without a `SUPPLIED`/`DECLINED` response ever being recorded first. It does **not** mean, and must never be read to mean: a fixed duration elapsed; an SLA expired; the recipient definitely never replied anywhere in the real world; a network/provider timeout occurred; or any other externally-inferred fact. `AddContextResult` and real-world response truth are not the same thing — this ledger proves only what the domain runtime itself did.

##### B. Explicit closure vs. timeout inference

Closed: no automatic elapsed-time inference is introduced. `responseDeadlineAt`, `timeoutSeconds`, a default response window, a scheduler, polling, or cron are all explicitly rejected as mechanisms this document defines or authorizes. The prior open decision's framing ("a `responseDeadlineAt` ... or an explicit ... closure event," §7 "Runtime readiness," as it read before this freeze) is resolved in favor of the second option alone — an explicit closure event, never a deadline field. A future product policy may decide *when* to invoke the closure operation below; this domain runtime does not invent, store, or enforce that policy (§O).

##### C. Dedicated operation vs. generic `recordRouteOutcome`

Closed: a dedicated operation, not a `recordRouteOutcome` branch. `SUPPLIED`/`DECLINED` are externally-observed response facts — a human actively did something, and `recordRouteOutcome` already exists to record an externally-observed fact for a route. `NO_RESPONSE` is not an observation of what a human did; it is an affirmative decision by the caller that waiting for this request has ended. Routing it through `recordRouteOutcome`'s generic `result` field would let a caller disguise that lifecycle decision as an ordinary response payload, with no distinguishable API signal that anything different just happened. A dedicated operation makes the authority boundary explicit in the API surface itself, not merely in a comment.

##### D. Operation input shape

Closed, conceptually:

```
closeContextRequestWithoutResponse(
  session: StressTestSession,
  deliberationState: DeliberationState,
  input: { attemptId: string, latencyConsumed: number }
): DeliberationState
```

No other key. The caller never restates `contextRequestId`, `questionId`, `decisionId`, `sessionId`/hash fields, `result`, `status`, `completedAt`, or `responseText` — every one of those is derived from the audit chain `attemptId` already identifies, exactly the same "caller supplies only the identity, the runtime resolves everything else" discipline `createContextRequest` (§7, Slice 2D-C0) and `createCrossSessionTransition` (§13.A, Slice 2D-C3-0) already established. `latencyConsumed` is the one genuinely caller-supplied accounting fact, under the same discipline every other terminal `RouteOutcome` already uses (§12).

##### E. `ContextRequest` preconditions

Closed: exactly one `ContextRequest` must already exist, bound to the exact `ADD_CONTEXT` `RouteAttempt` named by `attemptId` — resolved only after the COMPLETE `ContextRequest` ledger passes `assertContextRequestLedgerIntegrity`-equivalent validation (§7, Slice 2D-C0/C1/C2's now-repeated "global before local" posture, applied a fourth time). Zero requests: closure rejected outright — there is nothing to close. The selected request is derived from the resolved attempt, never caller-restated (§D above). Also required before closure: exactly one `ADD_CONTEXT` `RouteAttempt` resolves for `attemptId`; its decision/question provenance is fully valid; its question is current, with exactly one active cycle matching the exact decision this attempt belongs to; no `RouteOutcome` already exists for this attempt; no `QuestionDisposition` already exists for it; and `deliberationState.stopReason === null`. `SUPPLIED`/`DECLINED` already recorded for this attempt, or a `FAILED` outcome already recorded, both reject the closure outright — `ONE RouteAttempt -> AT MOST ONE RouteOutcome` (invariant 10) is never an exception for this operation.

##### F. `AttemptStatus`

Closed: `SUCCEEDED`. The `ADD_CONTEXT` request mechanism reached an explicit, determinate lifecycle closure — no usable context was ever supplied, but the mechanism itself did not technically fail, exactly the same reasoning already frozen for `DECLINED` (§7.A above). `FAILED` remains reserved exclusively for a genuine acquisition/technical failure — the mechanism could not even present the request. `INCONCLUSIVE` remains illegal for `ADD_CONTEXT` under the already-binding per-route `AttemptStatus` allowlist (§6, invariant 25) — unchanged by this freeze.

##### G. `RouteOutcome` shape

Closed, minimal, no additional field found necessary:

```
AddContextNoResponseRouteOutcome extends RouteOutcomeCommon {
  status: 'SUCCEEDED';
  route: 'ADD_CONTEXT';
  result: 'NO_RESPONSE';
  contextRequestId: string;
}
```

No `responseText` (nothing was supplied). No `timeoutSeconds`/deadline field (§B — no duration is ever computed or stored). No caller-supplied `closureReason` — the operation's own semantics *are* the reason; inventing a second, independently-caller-suppliable text field to explain a decision the operation itself already fully expresses would be exactly the unjustified invention this contract has refused everywhere else (`FailureInfo`'s message cap, §7; `CROSS_SESSION`'s deterministic `reason`, §13.A). No scheduler identity — no scheduler is designed or authorized here (§O below). `AddContextRouteOutcome` extends to `AddContextSuppliedRouteOutcome | AddContextDeclinedRouteOutcome | AddContextNoResponseRouteOutcome`.

##### H. Separate closure entity

Closed: NO. The immutable `AddContextNoResponseRouteOutcome` record itself is the terminal closure fact; `RouteAttempt` already supplies its identity, and `ContextRequest.originatingAttemptId` already supplies the binding back to the request being closed. A second `ContextRequestClosure`/`ContextResponseClosure` entity would duplicate `attemptId`, `contextRequestId`, and `completedAt` without carrying any independent authority or provenance this outcome record cannot already express — the same "no second ledger without justification" refusal already applied to `QuestionDisposition`'s replacement-question model (§9) and to `SessionVersionLineage`'s decision against a second response-fact field (§13.A, decision C).

##### I. `completedAt` semantics

Closed: the runtime-generated time at which the explicit closure operation itself recorded the outcome — unchanged from every other `RouteOutcome`'s `completedAt` (§7, "`completedAt` semantics"). It is **not** proof of how long the recipient had to answer, not a provider timestamp, and not a claimed response deadline; no duration may ever be derived from it by subtracting it from `RouteAttempt.startedAt` or any other timestamp to argue how long the system "waited."

##### J. Latency accounting

Closed: `latencyConsumed` is caller-supplied, finite, non-negative accounting input, under the exact same discipline `recordRouteOutcome` already applies to every other terminal outcome (§12, "Latency accounted at completion") — accounted once, at successful closure, never reversed. It is accounting input only; it must never be interpreted as evidence that a particular elapsed duration proves `NO_RESPONSE` is the correct result (§B). A rejected closure attempt spends no latency and charges no logical cost a second time — `logicalCost` was already accounted in full when the `ADD_CONTEXT` `RouteAttempt` itself started (§12).

##### K. `QuestionDisposition` relationship

Closed: unchanged from the posture already frozen for `SUPPLIED`/`DECLINED` (above). `NO_RESPONSE` does not mechanically produce `STILL_OPEN`, `RESOLVED`, `SUPERSEDED_RECLASSIFIED`, or `CROSS_SESSION`. `AddContextResult` and `QuestionDisposition` remain separate domains (§10); the question remains current under its session until a separately supplied semantic re-evaluation records a valid disposition for it.

##### L. `CROSS_SESSION` relationship

Closed: `NO_RESPONSE` can never authorize `createCrossSessionTransition`. Only a `SUPPLIED` outcome supplies the one fact (`responseText`) that operation's entire contract depends on (§13.A, decision N step 6, already explicit: "not `DECLINED`; `DECLINED` structurally cannot authorize this transition" — the identical reasoning excludes `NO_RESPONSE`, which has no `responseText` at all). No Session B, no `SessionVersionLineage`, no `CROSS_SESSION` disposition may ever result from a `NO_RESPONSE` outcome.

##### M. Read-time provenance

Closed: a future stored `AddContextNoResponseRouteOutcome` is never trusted merely because it is present in `deliberationState.outcomes` — the same "never trust, always re-validate at the boundary" posture this contract has required at every terminal-outcome boundary since `validateAttemptProvenanceForOutcome` (§7) and reaffirmed for `SUPPLIED` at `assertContextRequestLedgerIntegrity`'s every call site (§7, Slice 2D-C1/C2) and at `revalidateSuppliedOutcomeProvenance` (§13.A). At any future boundary that trusts a stored `NO_RESPONSE` outcome: it must resolve to exactly one `RouteAttempt`; that attempt's decision/question provenance must be fully re-derived, never assumed; the COMPLETE `ContextRequest` ledger must independently pass integrity validation before the one named request is trusted; the named `contextRequestId` must resolve to exactly one request, bound to the same attempt/question/session/hash; `result`/`status` must be exactly `NO_RESPONSE`/`SUCCEEDED`; no `responseText` field may be present; `logicalCost` must match the resolved attempt's own; `latencyConsumed` must be finite/non-negative; `completedAt` must be a parseable timestamp. No step may be skipped because it "already passed once when written."

##### N. Late-response posture

Closed as explicitly out of scope for this freeze, not as a new open architecture decision: `ONE RouteAttempt -> AT MOST ONE RouteOutcome` (invariant 10) is unchanged and unweakened — once an attempt is closed as `NO_RESPONSE`, a later `SUPPLIED`, `DECLINED`, or `FAILED` outcome for that same attempt is rejected outright, exactly as a second outcome of any kind already is for every other route. This freeze does **not** design a workflow for "the human replies after closure" — it does not silently reopen the terminal attempt, does not mutate the `NO_RESPONSE` outcome, and does not auto-create a new attempt on the closed question's behalf. A future, separately authorized product policy would need its own explicit new `RouteDecision`/`RouteAttempt` cycle (the question's normal re-evaluation path, §10's table, already available once *some* `QuestionDisposition` reopens routing for it) or another, separately-designed mechanism — neither is designed or authorized here. This is a closed scope boundary, not a deferred question: nothing about it requires a future architecture decision before `NO_RESPONSE` runtime itself can be authorized.

##### O. Future scheduler/policy boundary

Closed: this freeze defines only the domain transition — what closing a request without a response means, once closure happens. It does not decide, design, or authorize *when* a caller should invoke `closeContextRequestWithoutResponse` — a configured deadline elapsing, a human operator's explicit action, or an external workflow's own expiry decision are all equally plausible future callers of this one operation, and choosing among them (or building any of the infrastructure to automate the choice) is a separate, future, explicitly-authorized architecture decision this document does not make. No scheduler, poller, or cron architecture is designed or implied by this freeze.

##### Failure fallback (restated)

If the closure operation itself cannot structurally complete — unknown/blank `attemptId`, zero or ambiguous `ContextRequest`, an attempt that is not `ADD_CONTEXT`, a question that is not current, an attempt that already has a `RouteOutcome`, a stopped deliberation, or any other precondition failure — it throws and mutates nothing. `NO_RESPONSE` is never a fallback result for a validation failure; a validation failure is never silently reinterpreted as `FAILED`, `NO_RESPONSE`, or any other route's outcome.

##### Legacy compatibility

Closed: no new legacy-compatibility concern is introduced. No new ledger is added (§H), so no new "missing field reads as `[]`" rule is needed. Every existing pre-`NO_RESPONSE` `RouteOutcome` remains exactly as valid as it always was. The historical absence of any `RouteOutcome` for an attempt is never reinterpreted as an implicit `NO_RESPONSE` — absence remains absence, exactly the already-accepted "open/unterminated attempt" reading (invariant 22); only an explicit, successfully-recorded `AddContextNoResponseRouteOutcome` ever means `NO_RESPONSE`.

#### Schema decisions closed (Slice 2D-C4-0)

**A-O map exactly to the lettered subsections immediately above.** No governing source-of-truth document contradicts A–O; none required reopening an already-accepted Slice 2A/2B/2C/2D-B0/2D-B1/2D-B2-0/2D-B2-A/2D-B2-B/2D-C0/2D-C1/2D-C2/2D-C3-0/2D-C3 invariant to close.

#### Recommended next runtime slice (Slice 2D-C4-0 freeze)

Not authorized by this document.

**`SLICE 2D-C4` — EXPLICIT `NO_RESPONSE` CLOSURE RUNTIME:** `AddContextNoResponseRouteOutcome` type; `closeContextRequestWithoutResponse` itself (§D), including the complete precondition chain (§E/§F), the mandatory global `ContextRequest` ledger gate, and latency accounting (§J); no new ledger, no new legacy-compatibility field (§H, §"Legacy compatibility" above — nothing to add); tests covering the happy path, every rejection precondition (§E), the `ONE RouteAttempt -> AT MOST ONE RouteOutcome` late-closure/late-response rejection (§N), no automatic `QuestionDisposition` (§K), `CROSS_SESSION` remaining unreachable from a `NO_RESPONSE` outcome (§L), and no cost/latency double-spend (§J). This is a single, small, self-contained slice — there is no atomicity split to consider here the way `CROSS_SESSION` required one (§13.A, Slice 2D-C3-0/2D-C3 amendment): `closeContextRequestWithoutResponse` produces exactly one fact (the outcome record), never a multi-fact bundle, so the "primitive vs. persisted half-transition" distinction that governed the `CROSS_SESSION` slice split does not apply here.

`SEEK_EVIDENCE` claim-level provenance remains excluded — this slice does not build it, and closing `NO_RESPONSE` does not narrow that separate open decision (§24).

### B. ADD_REVIEWER

Route output: new `ReviewFinding[]` from one reviewer pass (accepted, unchanged shape). `AttemptStatus`: `SUCCEEDED` (findings produced, possibly zero) or `FAILED` (acquisition/technical failure, invalid output). No `INCONCLUSIVE` category — "found nothing material" is itself a determinate answer, not an indeterminate one. Append-only review evidence; no automatic materiality authority; no automatic question resolution — re-evaluation (§14) decides the coverage gap's disposition.

### C. REPLICATE

`ReplicationResult`: `REPRODUCED` | `NOT_REPRODUCED` | `PARTIAL` — a closed, three-value categorical result, chosen because it mirrors the pattern already governing every other closed enum in this runtime (`StopReason`, `RootCauseCategory`), and because `PARTIAL` is itself a determinate designed category, not an indeterminate escape hatch. `AttemptStatus`: `SUCCEEDED` for any of the three (the replication mechanism ran and produced a definite categorical answer) or `FAILED` (the replication attempt itself could not execute). Reproduction is never treated as truth — it is one input the disposition step (§14) weighs, never a self-executing verdict.

### D. SEEK_EVIDENCE

Evidence-lookup result, one of: supportive | contradictory | partial/inconclusive | execution failure. The first two map to `AttemptStatus = SUCCEEDED`; "partial/inconclusive" maps to `AttemptStatus = INCONCLUSIVE` (§6); "execution failure" maps to `AttemptStatus = FAILED`. Never directly mutates `ReviewFinding.evidenceState` — any later projection into that vocabulary is an explicit, separately-designed re-evaluation step (§14), not an automatic side effect of the lookup.

#### Schema freeze (Slice 2D-C5-0): `EvidenceSubject` / claim-level provenance

The claim-identity gap has been named, unsolved, since the Slice 2D-B0 final amendment (§7, "Claim-identity gap") for exactly one reason: the accepted `RouteInputRef` vocabulary identifies a whole `ReviewFinding`/`SemanticIssue`, never the one factual proposition inside it that a `SEEK_EVIDENCE` attempt actually evaluates. This freeze closes that gap. Nothing below is implemented; no `src/**` type, function, or test is added.

**Core architecture question, answered:** the immutable product-domain identity is a dedicated `EvidenceSubject` record — its own identity (`id`), registered *before* routing, naming the exact factual proposition (`claimText`) and its exact leaf `ReviewFinding` provenance (`originatingFindingId`) — referenced afterward by every `SEEK_EVIDENCE` `RouteDecision`/`RouteAttempt`/`RouteOutcome` for that question, never restated. `EvidenceSubject` answers "which exact claim" the same way `ContextRequest` already answers "which exact context gap" and `SessionVersionLineage` already answers "which exact session transition" — one dedicated, independently-identified audit fact per concept, never a bag of fields grafted onto an unrelated type.

##### A. Is `EvidenceSubject` required?

Closed: YES. `{result, citations}` alone identifies a source, never which claim inside a `ReviewFinding`/`SemanticIssue` the citations evaluate — the exact gap the Slice 2D-B0 final amendment named and declined to paper over. The same "a disposition-kind boolean is never enough, a nested single field is never enough" reasoning already applied to `QuestionDisposition` (§9) and to `SessionVersionLineage` (§13.A, Slice 2D-C3-0 freeze, decision A) applies here: a citation shape alone cannot answer "of what."

##### B. `EvidenceSubject` identity

Closed: a fresh, runtime-generated `id: string` — never `originatingQuestionId` reused as identity (a question can, in principle, later be reclassified or superseded, §9; the claim being verified should not silently inherit a lifecycle event that belongs to a different concept), never a copied/derived value from `ReviewFinding`/`SemanticIssue`, and never `paragraphId`/`chunkId`/`claimIndex`/array position/text offset — all of those describe *where inside a source* something sits, never *what durable product concept* it is, exactly the distinction `MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md` §9 already draws for every other identity in this contract.

##### C. Minimum fields

Closed:

```
EvidenceSubject {
  id                  -- fresh identity (§B)
  originatingQuestionId -- the EVIDENCE_GAP question this claim belongs to
  sourceRef              -- RouteInputRef, FINDING | SEMANTIC_ISSUE only (§E)
  originatingFindingId     -- mandatory leaf ReviewFinding provenance (§F)
  claimText                 -- the immutable registered factual proposition (§D below)
  sessionId                  -- derived-and-copied convenience field (§ below)
  artifactHash                 -- derived-and-copied convenience field
  authorContextHash              -- derived-and-copied convenience field
  createdAt                       -- runtime-generated
}
```

**Corrected from the governing packet's own proposed shape:** `sessionId`/`artifactHash`/`authorContextHash` are added. The packet's suggested minimum field list omitted them, but every other audit-fact type this contract has ever frozen for a `DeliberationState`-owned ledger — `QuestionDisposition` (§9), `ContextRequest` (§7, Slice 2D-C0), `SessionVersionLineage` (§13.A, Slice 2D-C3-0) — carries this exact trio as a derived-and-copied convenience field, independently re-verified against the containing `DeliberationState`'s own binding at every read (never independently caller-authoritative). Omitting it here would be an unexplained, unjustified departure from an otherwise-universal pattern in this document, not a genuine minimization — this is the one concrete correction inspection surfaced (packet §5's own instruction: "identify any concrete missing or redundant field before freezing").

No `artifactLocation` (§G — derived, never duplicated). No `sourceExcerpt`/copied finding text (the leaf `ReviewFinding` already owns its own text/`artifactLocation`; `EvidenceSubject` only needs to *point* at it, via `originatingFindingId`).

##### D. `claimText` authority and semantics

Closed: `claimText` is the exact factual proposition deliberately registered for evidence evaluation — **not** required to be a byte-for-byte quotation already stored inside the `ReviewFinding` it originates from, and not verified by any semantic/NLP check that it is "really" contained in that finding (§ below, "Trust boundary"). Once registered: immutable, never silently rewritten, and never restated by a `RouteOutcome` (§Q) — every later reference is by `EvidenceSubject.id` alone, exactly the discipline that prevents `responseText`/`reason`/every other authored-text field in this contract from drifting between where it was authored and where it is later used (§13.A decision D's identical reasoning for `ContextRequest.category`/`SUPPLIED.responseText`).

##### Trust boundary (packet §8)

Closed, stated precisely to avoid overclaiming: this domain runtime can prove "this exact immutable proposition was registered as the evidence subject for this exact `EVIDENCE_GAP` question, with this exact finding/issue provenance, at this exact time." It **cannot** cryptographically or semantically prove "the proposition is a faithful, complete extraction of what the source finding actually says" — that judgment call is a caller-supplied semantic act, structurally identical in kind (never in mechanism) to `materialityReason` (§8 of the routing contract) and to `ADD_REVIEWER`'s already-accepted "structural defensibility, not cryptographic proof" trust model (§7, decision D). No new verification machinery is invented to close that gap; it was never closeable within this domain layer's existing trust boundary, and pretending otherwise would overclaim.

##### E. `sourceRef` allowlist

Closed: `FINDING` | `SEMANTIC_ISSUE` only — `AUTHOR_CONTEXT_ITEM` is excluded. This is not merely a preference; it is a structural consequence of decision F below: `originatingFindingId` must always resolve to exactly one real `ReviewFinding`, and an `AUTHOR_CONTEXT_ITEM` has no backing `ReviewFinding` to resolve to at all (`AuthorContextItem` and `ReviewFinding` are unrelated types, `src/stress-test/types.ts`) — there is no leaf-provenance path for author-supplied context to satisfy. `sourceRef` must exactly match one of the originating `EVIDENCE_GAP` question's own `inputRefs` (`(kind, id)` equality, no inference) — the same "no arbitrary new ref introduced only at [creation] time" discipline already frozen for `REPLICATE.targetRef` (§7.C) and `TARGETED_PEER_CHALLENGE`'s two refs (§7.E, invariant 31).

##### F. Mandatory leaf `ReviewFinding` provenance

Closed: `originatingFindingId` is mandatory in every case, even when `sourceRef.kind === 'SEMANTIC_ISSUE'`. If `sourceRef.kind === 'FINDING'`, then `originatingFindingId === sourceRef.id` exactly. If `sourceRef.kind === 'SEMANTIC_ISSUE'`, the named `SemanticIssue` must exist, and `originatingFindingId` must identify exactly one `ReviewFinding` already present in that issue's own `findingIds` (`src/stress-test/types.ts::SemanticIssue.findingIds`) — never an unrelated finding, never a finding merely plausible-looking. Reason: `artifactLocation` and every other leaf-provenance fact live on `ReviewFinding`, never on `SemanticIssue` (`SemanticIssue` has no `artifactLocation` field at all, inspected directly) — without this rule, a `SemanticIssue`-sourced `EvidenceSubject` would have no path back to a concrete artifact location, exactly the gap the Slice 2D-B0 final amendment named ("that finding's own `artifactLocation`/provenance"). Every `EvidenceSubject` therefore has exactly one leaf provenance anchor, regardless of which `sourceRef` kind registered it.

##### G. `artifactLocation`: derive, never duplicate

Closed: `EvidenceSubject` does **not** carry its own `artifactLocation` field. `ReviewFinding` already authoritatively owns `artifactLocation` (`src/stress-test/types.ts`); a copied field on `EvidenceSubject` would be exactly the duplicated-lineage-truth hazard this contract has refused everywhere else (`QuestionDisposition`'s refusal to carry a `childSessionId`, §13.A decision M; `SessionVersionLineage`'s refusal to duplicate `responseText`, §13.A decision C) — it would require permanent synchronization against the finding it was copied from, with no mechanism to detect drift. Any future consumer that needs `artifactLocation` resolves it by walking `originatingFindingId -> session.findings[id].artifactLocation`, exactly as `originatingQuestionId`/`contextRequestId`-style derived-and-copied fields are already re-verified at every read boundary elsewhere in this contract, never independently caller-authoritative.

##### H. `SemanticIssue` relationship

Closed: when `sourceRef.kind === 'SEMANTIC_ISSUE'`, an `EvidenceSubject` does **not** mean the whole issue is one factual claim — it means "within this issue, this exact originating `ReviewFinding` (§F) supplied the leaf provenance for this separately-registered factual proposition." No automatic assumption that every finding aggregated into the issue supports, or even relates to, the same claim; a `SemanticIssue` can aggregate multiple findings (`MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md` §9, already the reason this gap was left open rather than solved by a naive single-reference field), and this freeze does not pretend otherwise. A second, different `EvidenceSubject` targeting a different finding within the same issue is a completely independent registration, never in tension with this one.

##### I. Ledger ownership

Closed: `DeliberationState.evidenceSubjects: EvidenceSubject[]`, an append-only audit ledger on the same `DeliberationState` that already owns `questionDispositions[]`/`contextRequests[]`/`sessionVersionLineages[]` — the identical established pattern, not a new one. No separate global registry: an `EvidenceSubject` exists specifically to support one deliberation question and its subsequent `SEEK_EVIDENCE` cycles (§M/§N below), and every other question-scoped or attempt-scoped audit fact in this contract already lives inside the one `DeliberationState` that owns the question, never in a cross-session or cross-deliberation structure.

##### J. Legacy compatibility

Closed: a `DeliberationState` predating this field is read as `evidenceSubjects: []` at read boundaries only, never by mutating the stored record — the identical purely-additive compatibility posture already used for `contextRequests` (§7, Slice 2D-C0/C1) and `sessionVersionLineages` (§13.A, Slice 2D-C3-0) when each was first introduced. All newly-created `DeliberationState` values materialize `evidenceSubjects: []` explicitly.

##### K. Creation API

Closed, conceptually:

```
registerEvidenceSubject(
  session: StressTestSession,
  deliberationState: DeliberationState,
  input: {
    questionId: string,
    sourceRef: RouteInputRef,
    originatingFindingId: string,
    claimText: string
  }
): { deliberationState: DeliberationState; evidenceSubject: EvidenceSubject }
```

**On `questionId`, not `attemptId` — an apparent tension with the Slice 2D-C0 freeze, resolved explicitly, not glossed over.** `createContextRequest` deliberately replaced `questionId` with `attemptId` (§7, Slice 2D-C0 freeze, decision C) because a `ContextRequest` is the *output* of running one specific `ADD_CONTEXT` attempt — attempt-scoped by its very nature (`ONE ADD_CONTEXT RouteAttempt -> AT MOST ONE ContextRequest`, invariant 50). `EvidenceSubject` is the opposite in kind: it is a *precondition* for a `SEEK_EVIDENCE` attempt to even be planned (§O below — a `RouteDecision` cannot exist without one), and per decision M/N below it is reused, unchanged, across every attempt/cycle a question has, never re-created per attempt. It is question-scoped in the same sense `UnresolvedQuestion.materialityReason`/`inputRefs` are question-scoped, not attempt-scoped in the sense `ContextRequest` is — so `questionId` is the correct binding identity here, and the two decisions do not actually conflict; they answer the same "what should this concept bind to" question correctly for two genuinely different concepts.

No other input key. `sessionId`/`artifactHash`/`authorContextHash` are derived from `session`, never caller-restated, mirroring every other creation API in this contract.

##### L. Question preconditions

Closed: `questionId` must resolve to exactly one registered `UnresolvedQuestion` whose `rootCause === 'EVIDENCE_GAP'` — never `CONTEXT_GAP`/`STABILITY_QUESTION`/`COVERAGE_GAP`/`DECISION_SENSITIVE_CONFLICT`/`NONE`. The question must be current (`isQuestionCurrent`). `sourceRef` must exactly equal one entry of `question.inputRefs` (`(kind, id)` equality). Every referenced session-domain object (`ReviewFinding`/`SemanticIssue`) must independently resolve and validate, exactly as `validateRouteInputRef` already does for every other `RouteInputRef` consumer in this contract.

##### M. Cardinality — one question, at most one subject in storage, exactly one before routing

Closed, as two distinct invariants, corrected and disambiguated by the Slice 2D-C5-0 amendment (the original wording below conflated them under one "EXACTLY ONE" label):

**Ledger/storage cardinality:** `ONE EVIDENCE_GAP UnresolvedQuestion -> ZERO OR ONE EvidenceSubject` at any point in the pre-routing lifecycle. Zero is a legitimate, non-corrupt state — a freshly registered `EVIDENCE_GAP` question has no `EvidenceSubject` yet until `registerEvidenceSubject` is called. More than one is always inconsistent and always fails closed at read time (§U below).

**Route-readiness cardinality:** before a `SEEK_EVIDENCE` `RouteDecision` may be planned, recorded, or attempted for `Q`, `ONE EVIDENCE_GAP UnresolvedQuestion -> EXACTLY ONE valid EvidenceSubject` is required — enforced at all three gates in §O below. A question should ask about exactly one factual proposition; if two claims genuinely need independent verification, the correct model is two separate `EVIDENCE_GAP` questions (each with its own `materialityReason`/`inputRefs`), never one question carrying two subjects. This makes `questionId -> EvidenceSubject` a deterministic lookup once registered, and avoids inventing an additional per-`RouteDecision` selection identity ("which of this question's subjects does this attempt target") that a many-subjects-per-question model would otherwise require.

##### N. Reuse across cycles

Closed: if `Q` remains current after a `SEEK_EVIDENCE` attempt and receives `QuestionDisposition.STILL_OPEN`, a later, fresh `RouteDecision`/`RouteAttempt` cycle for the same `Q` reuses the *same* `EvidenceSubject` — a second subject is never registered merely because another evidence attempt is made. Question identity owns subject identity (§M). If the underlying proposition materially changes, that is not a reason to mutate or replace the existing subject (§X below) — it requires a new or `SUPERSEDED_RECLASSIFIED` question (§9) and, following from §M, that new question's own fresh `EvidenceSubject`.

##### O. Planning/routing gates

Closed, at **three** independent boundaries — corrected by the Slice 2D-C5-0 amendment from the original two-boundary wording, which omitted the earliest of the three and left `planRouteForQuestion` (`src/stress-test/deliberation.ts`, taking `session` as its first parameter and already calling `validateRouteInputRef(session, ref)` for every `inputRef`) ungated. The same "never trust that an earlier function must have been called" posture already governs active-cycle integrity (invariant 39: independently re-derived at `recordRouteAttemptStart`, `recordRouteOutcome`, `recordQuestionDisposition`, `createContextRequest`, never trusting `recordRouteDecision`'s own creation-time gate alone for state that may predate it) and now extends one boundary earlier for this gate specifically:

1. **`planRouteForQuestion`** — fails closed as early as possible, before a `RouteDecision` object is ever minted: a `SEEK_EVIDENCE` route may not even be *planned* for an `EVIDENCE_GAP` question unless exactly one valid `EvidenceSubject` is already registered for it. This is the causal-ordering gate — `EvidenceSubject` registration must happen before route planning, not merely before recording.
2. **`recordRouteDecision`** — the authoritative write boundary (mirroring where the active-cycle *creation* gate already lives, invariant 35): never trusts that `planRouteForQuestion` was actually called, or that it enforced this check, before persisting the `RouteDecision`.
3. **`recordRouteAttemptStart`** — legacy/tampered-state protection, independently re-derived (mirroring where active-cycle integrity is independently re-checked for state that may predate the creation-time gate, invariant 39): never trusts that a historical `RouteDecision` passed a gate that may not have existed when it was recorded, or that could have been bypassed by directly-constructed legacy/tampered state.

All three independently derive the requirement appropriate to their own boundary; none defers to another having already checked it.

##### P. Legacy `FAILED` compatibility

Closed: historical generic `SEEK_EVIDENCE` `FAILED` `RouteOutcome` records are not invalidated merely because they predate `EvidenceSubject` — the accepted contract already permits generic `FAILED` for `SEEK_EVIDENCE` (§7 above, "Generic `FAILED` outcome remains structurally useful") precisely because it claims no evidence judgment against any claim, so it never needed claim identity to be defensible. `EvidenceSubject` becomes **mandatory** only to record a `SUCCEEDED`/`INCONCLUSIVE` `SEEK_EVIDENCE` result (§Q/§V below); the historical `FAILED` path does not retroactively gain, or require, a claim-result assertion it never made.

##### Q. `SeekEvidenceRouteOutcome` shape

Closed. **Refined from the governing packet's own proposed flattened shape**, for the same reason `AddContextRouteOutcome` is a union rather than one interface with an optional `responseText`: `status` and `result` are structurally coupled (§7's status/result consistency table, unchanged), so the type itself should make an invalid `status`/`result` pairing unrepresentable, not merely runtime-rejectable:

```
SeekEvidenceSupportiveOrContradictoryRouteOutcome extends RouteOutcomeCommon {
  route: 'SEEK_EVIDENCE'
  status: 'SUCCEEDED'
  result: 'SUPPORTIVE' | 'CONTRADICTORY'
  evidenceSubjectId: string
  citations: EvidenceCitation[]   -- non-empty (§S)
}

SeekEvidenceInconclusiveRouteOutcome extends RouteOutcomeCommon {
  route: 'SEEK_EVIDENCE'
  status: 'INCONCLUSIVE'
  result: 'INCONCLUSIVE'
  evidenceSubjectId: string
  citations: EvidenceCitation[]   -- may be empty (§S)
}

SeekEvidenceRouteOutcome = SeekEvidenceSupportiveOrContradictoryRouteOutcome | SeekEvidenceInconclusiveRouteOutcome
```

No `claimText`, `originatingFindingId`, `artifactLocation`, or `sourceRef` duplicated onto the outcome — every one of those resolves by walking `evidenceSubjectId -> EvidenceSubject` (§V below), the exact "identify the immutable subject, never restate it" discipline `AddContextSuppliedRouteOutcome.contextRequestId` and `SessionVersionLineage.suppliedOutcomeAttemptId` already establish. `RouteOutcome`'s union extends to include both variants above.

##### R. Result/status matrix

Closed: preserved, unchanged from §7's already-frozen table — `SUPPORTIVE -> SUCCEEDED`, `CONTRADICTORY -> SUCCEEDED`, `INCONCLUSIVE -> INCONCLUSIVE`, `FAILED` uses the existing generic `FailedRouteOutcome`/`FailureInfo` path and carries no evidence-relation result at all (§P above).

##### S. Citation cardinality/schema

Closed: `SUPPORTIVE`/`CONTRADICTORY` require `citations.length > 0`; `INCONCLUSIVE` permits `citations.length === 0`, unchanged from the already-frozen shape (§7 above). Each `EvidenceCitation`'s structural validation, closed for the future runtime: `sourceIdentifier` must be a non-empty string; `title`, when present, must be a non-empty string (an empty/whitespace-only supplied `title` is rejected the same way every other optional-but-non-empty-when-present field in this contract is); `excerpt` must be a non-empty string. No numeric character bound is invented for `excerpt` — the same "no bound without an analogous, specifically-named justification" reasoning already applied to `materialityReason`/`QuestionDisposition.reason` (§9), not `FailureInfo.message`'s 2000-character cap (that cap exists specifically to bound an otherwise-unbounded raw error blob, a risk `excerpt` does not share since it is always an authored, source-attributable quotation, never a raw payload). No provider or retrieval mechanism is chosen here (§33 of the governing packet; unchanged from §7 above).

##### T. `QuestionDisposition` separation

Closed: unchanged from the posture already frozen for every other route's outcome (§10). No `SEEK_EVIDENCE` result — `SUPPORTIVE`, `CONTRADICTORY`, or `INCONCLUSIVE` — mechanically produces `STILL_OPEN`, `RESOLVED`, `SUPERSEDED_RECLASSIFIED`, or `CROSS_SESSION`. An evidence-relation fact (§ "Evidence relation semantics" below) is not a disposition; semantic re-evaluation remains a separate, explicitly supplied act (§14), and `HumanAdjudication`/`RevisionAction` authority is entirely unaffected (§17, invariant 19) — `SUPPORTIVE`/`CONTRADICTORY` grant no revision authority, exactly as no `RouteOutcome` ever has.

##### Evidence relation semantics (packet §24)

Closed: `SUPPORTIVE` means the recorded citations support the exact `EvidenceSubject.claimText` proposition; `CONTRADICTORY` means they contradict it; `INCONCLUSIVE` means the attempt did not establish either relation sufficiently. These are evidence-relation facts about one attempt's findings, never claims that the artifact must change, that the claim is now globally true or false forever, or that any `QuestionDisposition`/`HumanAdjudication`/`RevisionAction` follows automatically (§T above).

##### U. Global read integrity — corrected to be session-aware by the Slice 2D-C5-0 amendment

**The original signature was underspecified in a way that made it unimplementable as stated.** `assertEvidenceSubjectLedgerIntegrity(deliberationState)`, accepting only `DeliberationState`, cannot actually validate "the originating finding resolves to exactly one current session `ReviewFinding`" — `ReviewFinding` and `SemanticIssue` are `StressTestSession` domain truth (`src/stress-test/types.ts`), never copied onto `DeliberationState` (§G above refuses exactly this duplication for `artifactLocation`, on the same grounds). A helper that only receives `deliberationState` has no `session.findings`/`session.semanticIssues` to resolve against at all.

Corrected, conceptually: `assertEvidenceSubjectLedgerIntegrity(session: StressTestSession, deliberationState: DeliberationState)` — session-aware, mirroring `validateRouteInputRef(session, ref)` (`src/stress-test/deliberation.ts`, inspected directly), which already takes `session` as its first parameter for exactly this reason. Before the `evidenceSubjects[]` ledger can be trusted at all, the helper must first pass `verifyFrozenInputIntegrity(session)` (`src/stress-test/session.ts`) and `verifyDeliberationBinding(session, deliberationState)` (`src/stress-test/deliberation.ts`) — the same complete session/state binding check already used, identically, as the first step of `planRouteForQuestion`, `createContextRequest`, and `createCrossSessionTransition` (`src/stress-test/deliberation.ts`, inspected directly). `EvidenceSubject` integrity can never trust `state.sessionId`/`state.artifactHash`/`state.authorContextHash` as free-standing facts — they must themselves be bound back to the actual `session.id`/`session.artifactHash`/`session.authorContextHash` they claim to describe, not merely internally self-consistent within `DeliberationState`.

Validates the COMPLETE `evidenceSubjects[]` collection on every read, never only the one subject a caller happens to be creating or resolving (the same "global before local" posture required at every other ledger boundary since the Slice 2D-B2-0 amendment). At minimum: `id` non-empty and globally unique; `originatingQuestionId` resolves to exactly one registered `UnresolvedQuestion` whose `rootCause === 'EVIDENCE_GAP'`; **at most one** `EvidenceSubject` per `originatingQuestionId` (§M's *storage* cardinality — zero-or-one — re-derived independently at read time, never trusting the write-time gate alone for state that may predate it; the *route-readiness* exactly-one requirement is a separate check owned by §O's three gates, not by this helper); `sourceRef` is a structurally valid `RouteInputRef` and exactly belongs to that question's own `inputRefs`; `originatingFindingId` is non-empty and satisfies the exact `FINDING`/`SEMANTIC_ISSUE` leaf-provenance rule (§F), resolved directly against the authoritative `session.findings`/`session.semanticIssues`, never a copy; the originating finding resolves to exactly one current `ReviewFinding` in that same `session`; `claimText` is non-empty; `createdAt` is a parseable timestamp; `sessionId`/`artifactHash`/`authorContextHash` match **both** the containing `DeliberationState`'s own binding (§C) **and** the authoritative `session`'s own `id`/`artifactHash`/`authorContextHash` directly — a three-way match, not merely state-internal agreement. No local-first lookup is ever trusted before this complete validation passes.

##### V. Outcome write/read provenance

Closed: a future successful/inconclusive `SEEK_EVIDENCE` outcome must be independently re-validated against the complete authoritative-upstream chain (§13.A's named principle, restated a further time) — **`StressTestSession + DeliberationState -> RouteAttempt -> RouteDecision -> EVIDENCE_GAP Question -> EvidenceSubject -> sourceRef -> originating ReviewFinding -> artifactLocation/provenance`**, `StressTestSession` prepended by the Slice 2D-C5-0 amendment for the same reason §U above is now session-aware: `ReviewFinding`/`artifactLocation` provenance cannot be resolved from `DeliberationState` alone — and, separately, `RouteOutcome.evidenceSubjectId -> exactly that same EvidenceSubject`, never trusted merely because the outcome's own copied `evidenceSubjectId` and a plausible-looking subject happen to agree with each other (the exact class of gap the Slice 2D-C1 amendment closed for `ContextRequest`/`RouteAttempt`, and the Slice 2D-C3-0 amendment's decision N closed for `SUPPLIED`-outcome provenance: never merely compare two adjacent downstream records). Before recording: the COMPLETE, **session-aware** `EvidenceSubject` ledger integrity (§U, corrected) must pass; the exact subject must resolve; exact attempt/decision/question provenance must hold; the question's current/active-cycle rules must hold; the resolved `EvidenceSubject.originatingQuestionId` must equal the attempt's own question; the result/status matrix (§R) and citation schema (§S) must validate; latency is accounted only after every prior check passes (§12, unchanged); `ONE RouteAttempt -> AT MOST ONE RouteOutcome` (invariant 10) is unweakened. No retrieval occurs at this boundary — recording an already-obtained evidence result is separate from acquiring it (§33 of the governing packet).

##### W. Alias isolation

Closed: `registerEvidenceSubject` returns independent value snapshots, mirroring `createContextRequest`'s `buildSnapshot()`-called-twice discipline (§7, Slice 2D-C0) — mutating a caller-owned `sourceRef` object, the `claimText`-carrying input object, the returned subject, or any future outcome's `citations` array must never rewrite stored audit history. No generic immutability framework is introduced; this is the same value-semantics discipline already governing every other type in this contract (§7, "Snapshot / value semantics," invariant 20).

##### X. Claim/source mutation posture

Closed: `EvidenceSubject.claimText` is immutable — if the factual proposition materially changes, the subject is never mutated and its text is never overwritten; the correct path is a new or `SUPERSEDED_RECLASSIFIED` `EVIDENCE_GAP` question and that question's own fresh subject (§N). `ReviewFinding` records are already session-bound historical facts (§7.B); `EvidenceSubject` never silently rebinds `originatingFindingId` to a different finding after registration — if the source provenance genuinely changes, that requires a new subject/question path, never a retarget mutation of the existing one.

##### Y. Cross-session posture

Closed: `EvidenceSubject`s are bound to their current `DeliberationState`/session (§C's `sessionId`/`artifactHash`/`authorContextHash` fields make this explicit and independently re-verifiable) and do **not** carry into Session B through an `ADD_CONTEXT` `CROSS_SESSION` transition (§13.A) — Session B reviews from scratch against its own frozen input, exactly as it registers no current questions, findings, or dispositions carried over from Session A (§13.A, decision J). No cross-session `EvidenceSubject` reuse of any kind is authorized or implied by this freeze.

#### Schema decisions closed (Slice 2D-C5-0)

**A-Y map exactly to the lettered/named subsections immediately above.** No governing source-of-truth document contradicts A–Y; none required reopening an already-accepted Slice 2A/2B/2C/2D-B0/2D-B1/2D-B2-0/2D-B2-A/2D-B2-B/2D-C0/2D-C1/2D-C2/2D-C3-0/2D-C3/2D-C4-0/2D-C4 invariant to close. §24 now contains zero genuinely open schema decisions.

#### Recommended next runtime slices (Slice 2D-C5-0 freeze)

Not authorized by this document.

**Evaluated explicitly against the same atomicity question the `CROSS_SESSION` split required (§13.A, Slice 2D-C3-0 amendment §14): does either candidate slice risk persisting an invalid partial lifecycle on its own?** No. `EvidenceSubject` and `SeekEvidenceRouteOutcome` are two independently-complete audit facts, sequenced, not two co-dependent halves of one atomic transaction — the same relationship `ContextRequest` (Slice 2D-C1) already has to `AddContextRouteOutcome` (Slice 2D-C2): an `EvidenceSubject` with no outcome yet is a completely valid, non-orphaned state (exactly as an unanswered `ContextRequest` already is, §7 above), never the "lineage without its bijected disposition" hazard `CROSS_SESSION` actually had. A two-slice split is therefore safe here, unlike the `CROSS_SESSION` case.

**`SLICE 2D-C5-A` — EVIDENCESUBJECT REGISTRY + INTEGRITY + ROUTING GATE:** `EvidenceSubject` type; `evidenceSubjects[]` ledger on `DeliberationState`; legacy missing-ledger compatibility (§J); `registerEvidenceSubject` (§K) with its complete precondition chain (§L); the session-aware global read-integrity helper (§U, corrected by the Slice 2D-C5-0 amendment); the three-boundary planning/routing gate (§O, corrected by the Slice 2D-C5-0 amendment) at `planRouteForQuestion`, `recordRouteDecision`, and `recordRouteAttemptStart`; tests covering every one of the above. No `SeekEvidenceRouteOutcome` recording yet.

**`SLICE 2D-C5-B` — `SEEK_EVIDENCE` SUCCESSFUL/INCONCLUSIVE ROUTEOUTCOME RECORDING** (after 2D-C5-A is accepted): the `SeekEvidenceRouteOutcome` union (§Q); the mandatory outcome write/read provenance chain (§V); the result/status matrix and citation schema validation (§R/§S); tests covering every one of the above, plus the legacy-`FAILED`-compatibility regression (§P). This slice depends on 2D-C5-A's routing gate already existing (§O) so that a `SEEK_EVIDENCE` attempt can only ever exist with a valid `EvidenceSubject` already bound to it before an outcome is ever recorded against it.

This document does not claim the product is complete once this freeze is accepted. Still not implemented, beyond this slice's own scope, as of this Slice 2D-C5-0 freeze: `SEEK_EVIDENCE` runtime itself (2D-C5-A/B above); `TARGETED_PEER_CHALLENGE`'s successful-result routing gate/runtime (its schema is already closed, §7.E, invariant 30/31 — only the gate and recording are unimplemented); and all provider/retrieval execution (§33 of the governing packet; `0`, unconditionally). Architecture-open and implementation-not-yet-built are two different states, and this freeze closes only the former for `SEEK_EVIDENCE`. **Status corrected by the Slice 2D-C6-0 freeze; further corrected by the Slice 2D-D0 packet:** Slices 2D-C5-A and 2D-C5-B have since been separately authorized and accepted (§25) — `SEEK_EVIDENCE` runtime is no longer in the "still not implemented" state this paragraph describes. `TARGETED_PEER_CHALLENGE`'s routing gate (Slice 2D-C6-A) and successful-result runtime (Slice 2D-C6-B) have themselves since been separately authorized and accepted (§25) as well — it, too, is no longer in that state. Only all provider/retrieval execution remains as stated: `0`, unconditionally.

### E. TARGETED_PEER_CHALLENGE

Challenge-response outcome preserving target/source provenance, bounded excerpt identity, and one of: rebuttal | concession | qualification | refusal-to-yield. All four map to `AttemptStatus = SUCCEEDED` — a complete, valid response was produced, regardless of whether it resolves anything. `FAILED` covers a call failure or an unresolvable reference. Consensus is never truth: no peer response, by itself, automatically resolves the conflict (§10, §14) — that remains a disposition decided by re-evaluation, ultimately subordinate to `HumanAdjudication` (§17).

#### Schema freeze (Slice 2D-C6-0): `TARGETED_PEER_CHALLENGE` route-readiness gate placement

`TARGETED_PEER_CHALLENGE`'s payload shape and provenance rules were already closed by the Slice 2D-B0 final amendment (invariants 30/31, §7.E above) — what remained open was purely sequencing: *which* function(s) enforce the two-distinct-refs cardinality, and whether one enforcement point is sufficient. This freeze closes that sequencing question, architecture only — no `src/**` type, function, or test is added or modified (§25).

**Core architecture question, answered:** the cardinality requirement is enforced at every boundary capable of minting or advancing `TARGETED_PEER_CHALLENGE` execution authority, not at a single chosen point — the same "never trust an upstream check for pre-existing state" posture already governing every other multi-boundary gate in this document (invariant 74's three-boundary `SEEK_EVIDENCE` gate, §13.D; invariant 39's active-cycle re-derivation, §9).

##### A. `registerUnresolvedQuestion` — the authoritative write boundary

Closed: `registerUnresolvedQuestion` must reject a `rootCause === 'DECISION_SENSITIVE_CONFLICT'` question whose `inputRefs` do not contain at least two distinct `(kind, id)` `RouteInputRef`s. Invariant 30 already states this cardinality as a property of a *registered* `UnresolvedQuestion` — registration is therefore the authoritative persistence gate that must formalize it, exactly as `registerUnresolvedQuestion` already independently re-validates every other structural property of a caller-supplied question rather than trusting the caller's factory (§8, `MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md`-era precedent, extended here).

##### B. `createUnresolvedQuestion` — early, non-authoritative rejection

Closed: `createUnresolvedQuestion` should also fail closed on the same cardinality requirement for `DECISION_SENSITIVE_CONFLICT`, as the canonical constructor that should never mint a structurally invalid conflict question. This does **not** relax decision A — `registerUnresolvedQuestion` remains the authoritative persistence gate and must independently re-validate cardinality from the supplied `question` object regardless of how it was constructed, exactly as it already independently re-validates every other `createUnresolvedQuestion` output today rather than trusting the factory. A caller that bypasses the factory (a hand-built object literal, or a legacy/tampered value) must still be caught at registration.

##### C. `planRouteForQuestion` — causal-order/legacy-read protection

Closed: `planRouteForQuestion` must independently reject a current `DECISION_SENSITIVE_CONFLICT` question whose `inputRefs` — read fresh from the registered question at plan time, never assumed from registration having once passed — no longer contain at least two distinct refs. This protects against state that predates decision A's registration enforcement (a `DeliberationState`/`StressTestSession` pair created before this gate existed), the same "legacy state may predate a later-added gate" reasoning already governing invariant 74's `planRouteForQuestion` boundary for `SEEK_EVIDENCE`.

##### D. `recordRouteDecision` — the authoritative decision-write boundary

Closed: `recordRouteDecision` must independently enforce the same cardinality requirement, never trusting that the `RouteDecision` it is asked to record actually came from `planRouteForQuestion`. A manually constructed or legacy `DECISION_SENSITIVE_CONFLICT` `RouteDecision` cannot bypass cardinality merely by skipping the planning call — the identical posture invariant 74 already takes for `recordRouteDecision`'s `SEEK_EVIDENCE` check.

##### E. `recordRouteAttemptStart` — final execution-start protection

Closed: `recordRouteAttemptStart` must independently enforce the same invariant immediately before a `TARGETED_PEER_CHALLENGE` attempt begins, never trusting that registration, planning, or decision-recording already checked it. This is the last point before `logicalCost` is charged and execution authority is minted — the same final boundary invariant 74 already closes for `SEEK_EVIDENCE`.

##### F. Shared readiness helper; registration uses its own pure cardinality check

Closed: one canonical internal helper — conceptually `assertTargetedPeerChallengeReady(session, deliberationState, questionId)` or equivalent — validates session/state binding, resolves the exact registered current question, confirms `rootCause === 'DECISION_SENSITIVE_CONFLICT'`, structurally validates the complete `inputRefs` set (each ref resolving against the authoritative `StressTestSession`, per `validateRouteInputRef`), and confirms at least two distinct `(kind, id)` refs among them. This single helper is reused, unchanged, at decisions C/D/E (`planRouteForQuestion`, `recordRouteDecision`, `recordRouteAttemptStart`) — never copy-pasted into three drifting implementations, exactly the discipline the Slice 2D-C5-A/2D-C5-B write/read-drift lesson established for `assertSeekEvidenceSubjectReady`. `registerUnresolvedQuestion` (decision A) and `createUnresolvedQuestion` (decision B) may not reuse this same helper directly — at those two boundaries there is no yet-registered, yet-current question to resolve by id (registration is what makes the question exist and current in the first place); they instead share an underlying *pure* cardinality/ref-validation helper (structural distinctness plus, where a `session` is available, per-ref resolution) that the readiness helper itself also calls internally — one source of truth for "what counts as two distinct valid refs," reused by both the pre-persistence and post-persistence sides of this gate, never restated as two independent rules.

##### G. Distinctness is full-tuple `(kind, id)`, never `id` alone

Closed, restating invariant 30/81 explicitly for this freeze: two `RouteInputRef`s are distinct for cardinality purposes if and only if `kind` or `id` differs. `FINDING:X` and `SEMANTIC_ISSUE:X` are distinct — a finding and the semantic issue that clusters it are different domain objects even when their ids happen to collide — provided each independently resolves against the authoritative `session` (`validateRouteInputRef`). `[{FINDING,F1},{FINDING,F1}]` does not satisfy the requirement; deduplicating by `id` alone, ignoring `kind`, is never performed.

##### H. "At least two," not "exactly two"

Closed: the cardinality floor is a minimum, not an exact count. Three or more distinct refs (e.g., a conflict later found to implicate a third position) remain legal; nothing in this freeze caps `inputRefs.length`, and no future gate may reject a `DECISION_SENSITIVE_CONFLICT` question merely for carrying more than two.

##### I. No positional target/source semantics

Closed: a registered `DECISION_SENSITIVE_CONFLICT` question's `inputRefs` record the conflict *set*; they carry no positional target/source meaning. `inputRefs[0]` is never interpreted as "the target" and `inputRefs[1]` as "the source" (or vice versa) at construction, registration, planning, or decision-recording. A future successful `TARGETED_PEER_CHALLENGE` outcome alone selects, from that already-recorded set, which ref plays `targetRef` and which plays `sourceRef` — constrained only by invariant 31's existing distinctness/decision-provenance rule (both must exactly match a recorded `RouteDecision.inputRef`; no new ref introduced at outcome time), never by array position. This freeze introduces no ordering requirement and does not relax invariant 31's already-closed rule.

##### J. `RouteDecision.inputRefs` exact-match rule is unaffected

Preserved, unchanged: `RouteDecision.inputRefs` must still exactly and order-sensitively match `UnresolvedQuestion.inputRefs` (the existing decision/question provenance rule this contract already enforces for every route). TPC readiness (decisions A–F above) is an additional precondition layered on top of that existing rule, never a replacement for it — a `DECISION_SENSITIVE_CONFLICT` `RouteDecision` must satisfy both.

##### K. Legacy generic `FAILED` compatibility preserved

Closed, formalizing invariant 33's existing exception: a historical `TARGETED_PEER_CHALLENGE` `RouteAttempt` whose originating question predates this freeze's cardinality gate may still record a generic `FAILED` `RouteOutcome`. `FAILED` asserts only that the mechanism did not produce a valid result — it makes no claim requiring two-sided, provenance-distinct positions, so a future readiness gate closing decisions A–E must never retroactively invalidate an already-started legacy attempt's ability to terminate `FAILED`. Only the four successful result variants (`REBUTTAL`/`CONCESSION`/`QUALIFICATION`/`REFUSAL_TO_YIELD`) remain gated on readiness (invariant 33, unchanged).

#### Schema decisions closed (Slice 2D-C6-0)

**A–K map exactly to the lettered subsections immediately above.** No governing source-of-truth document contradicts A–K; none required reopening the already-closed `TARGETED_PEER_CHALLENGE` payload/provenance schema (invariants 30/31, Slice 2D-B0 final amendment) or any other already-accepted invariant. §24 continues to carry zero genuinely open schema decisions after this freeze.

#### Recommended next runtime slices (Slice 2D-C6-0 freeze)

Not authorized by this document.

**Evaluated explicitly against the same atomicity question the `CROSS_SESSION` and `SEEK_EVIDENCE` splits each required (§13.A, Slice 2D-C3-0 amendment §14; §13.D, Slice 2D-C5-0 freeze, "Recommended next runtime slices"): does either candidate slice risk persisting an invalid partial lifecycle on its own?** No. A valid `DECISION_SENSITIVE_CONFLICT` question, its `RouteDecision`, and a started `RouteAttempt` are all completely valid, non-orphaned states with no successful outcome yet recorded — exactly as an `EvidenceSubject` with no `SeekEvidenceRouteOutcome` yet, or a `ContextRequest` with no response yet, already are elsewhere in this contract. A two-slice split is therefore safe here, the same reasoning that validated the `SEEK_EVIDENCE` 2D-C5-A/2D-C5-B split.

**`SLICE 2D-C6-A` — TPC QUESTION CARDINALITY + THREE READINESS GATES:** decisions A–H above — `createUnresolvedQuestion`'s early rejection, `registerUnresolvedQuestion`'s authoritative enforcement, the shared `assertTargetedPeerChallengeReady`-equivalent helper, and its reuse at `planRouteForQuestion`/`recordRouteDecision`/`recordRouteAttemptStart`; tests covering every one of the above, including the "unrelated corrupt state elsewhere does not block an otherwise-valid question" global-before-local pattern already established for `EvidenceSubject`. No `TargetedPeerChallengeRouteOutcome` recording yet.

**`SLICE 2D-C6-B` — TPC SUCCESSFUL ROUTEOUTCOME RECORDING** (after 2D-C6-A is accepted): the `REBUTTAL`/`CONCESSION`/`QUALIFICATION`/`REFUSAL_TO_YIELD` outcome payload (§7.E), the mandatory `targetRef`/`sourceRef` distinctness-and-decision-provenance validation (invariant 31), and the legacy-`FAILED`-compatibility regression (decision K); tests covering every one of the above. This slice depends on 2D-C6-A's readiness gate already existing so that a `TARGETED_PEER_CHALLENGE` attempt can only ever exist for a question already proven to carry two distinct, valid positions before an outcome is ever recorded against it.

This document does not claim the product is complete once this freeze is accepted. Still not implemented, beyond this slice's own scope, as of the Slice 2D-C6-0 freeze: `TARGETED_PEER_CHALLENGE` runtime itself (2D-C6-A/B above) and all provider/retrieval execution (§25; `0`, unconditionally). Architecture-open and implementation-not-yet-built are two different states, and this freeze closes only the former for `TARGETED_PEER_CHALLENGE`'s gate placement. **Status corrected by the Slice 2D-D0 packet:** Slices 2D-C6-A and 2D-C6-B have since been separately authorized, implemented, and accepted (§25) — `TARGETED_PEER_CHALLENGE` runtime is no longer in the "still not implemented" state this paragraph describes; all provider/retrieval execution remains as stated.

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
29. `NO_RESPONSE` (an `ADD_CONTEXT` result) is authorized only through the dedicated `closeContextRequestWithoutResponse` operation's explicit closure action — never through `recordRouteOutcome`, never inferred from elapsed time. **Status corrected by the Slice 2D-C5-0 amendment:** the Slice 2D-C4 runtime is accepted (§25); `SUPPLIED`, `DECLINED`, `FAILED`, and `NO_RESPONSE` are all terminalizable for `ADD_CONTEXT` in the accepted runtime today, with `NO_RESPONSE` reachable exclusively through `closeContextRequestWithoutResponse`, never `recordRouteOutcome` (§7, §13.A Slice 2D-C4-0 freeze).
30. A registered `UnresolvedQuestion` whose `rootCause = DECISION_SENSITIVE_CONFLICT` must contain at least two distinct (`kind`, `id`) `RouteInputRef`s; not yet enforced by any registration gate in the accepted runtime (§7).
31. A `TARGETED_PEER_CHALLENGE` `RouteOutcome`'s `targetRef` and `sourceRef` must be distinct from one another and must each exactly match one of the terminated `RouteDecision`'s own `inputRefs`, with no inference and no new ref introduced at outcome time (§7).
32. A `SEEK_EVIDENCE` result (`SUPPORTIVE`/`CONTRADICTORY`/`INCONCLUSIVE`) requires exactly one valid `EvidenceSubject` registered for its originating question, with subject-bound provenance independently re-verified at both write and read time (`registerEvidenceSubject`, the routing gate, invariant 74; §13.D, Slice 2D-C5-0 freeze). **Status corrected by the Slice 2D-C6-0 freeze:** this invariant formerly read `SEEK_EVIDENCE` results as blocked pending separate runtime authorization; `registerEvidenceSubject`, the three-boundary routing gate, and `SeekEvidenceRouteOutcome` recording (with route-specific later-read provenance validation) are now **IMPLEMENTED / ACCEPTED** (Slice 2D-C5-A/2D-C5-B, §25) — a generic `FAILED` outcome remains additionally recordable for `SEEK_EVIDENCE` regardless (§7).
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
62. `NO_RESPONSE`'s terminal fact is an explicit closure action, never an elapsed-time inference; no `responseDeadlineAt`, `timeoutSeconds`, default response window, scheduler, poller, or cron is ever authorized by this contract to manufacture that closure automatically (§13.A, Slice 2D-C4-0 freeze).
63. `NO_RESPONSE` is recordable only through `closeContextRequestWithoutResponse`'s own dedicated, minimal-input operation (`attemptId`, `latencyConsumed`) — never as a `result` value accepted by `recordRouteOutcome`, which remains reserved for externally-observed response facts (`SUPPLIED`/`DECLINED`) (§13.A, Slice 2D-C4-0 freeze).
64. `closeContextRequestWithoutResponse` requires exactly one already-recorded `ContextRequest` bound to the exact `ADD_CONTEXT` `RouteAttempt` named, resolved only after the COMPLETE `ContextRequest` ledger independently passes integrity validation; zero requests, an already-terminated attempt (any existing `RouteOutcome`), or an already-disposed question all reject closure outright (§13.A, Slice 2D-C4-0 freeze).
65. `NO_RESPONSE` maps to `AttemptStatus = SUCCEEDED`; the request mechanism reaching a determinate closure without usable context is never itself a technical failure (§6, §13.A, Slice 2D-C4-0 freeze).
66. `AddContextNoResponseRouteOutcome` carries no `responseText`, no timeout/deadline field, no caller-supplied closure reason, and no scheduler identity; no separate `ContextRequestClosure`/`ContextResponseClosure` entity is introduced — the outcome record itself is the complete terminal closure fact (§13.A, Slice 2D-C4-0 freeze).
67. `NO_RESPONSE` never mechanically produces a `QuestionDisposition` of any kind, and never authorizes `createCrossSessionTransition` — only a `SUPPLIED` outcome's `responseText` can ever supply that transition's required fact (§13.A, Slice 2D-C4-0 freeze).
68. Once an attempt is closed `NO_RESPONSE`, no later `SUPPLIED`, `DECLINED`, or `FAILED` outcome may be recorded for it (invariant 10 unweakened); a human reply after explicit closure is out of scope for this freeze and never silently reopens the terminal attempt or auto-creates a new one (§13.A, Slice 2D-C4-0 freeze).
69. The historical absence of any `RouteOutcome` for an attempt is never reinterpreted as an implicit `NO_RESPONSE`; only an explicit, successfully-recorded `AddContextNoResponseRouteOutcome` ever means `NO_RESPONSE` (§13.A, Slice 2D-C4-0 freeze).
70. `EvidenceSubject.id` is a fresh, independently-generated identity -- never `originatingQuestionId`, never a copied/derived value from `ReviewFinding`/`SemanticIssue`, and never `paragraphId`/`chunkId`/`claimIndex`/array position/text offset (§13.D, Slice 2D-C5-0 freeze).
71. `ONE EVIDENCE_GAP UnresolvedQuestion -> ZERO OR ONE EvidenceSubject` in storage at any point in the pre-routing lifecycle (zero is a legitimate not-yet-registered state, never corrupt; more than one always fails closed at read time), and `-> EXACTLY ONE valid EvidenceSubject` is required before `SEEK_EVIDENCE` routing (invariant 74) — the two cardinalities disambiguated by the Slice 2D-C5-0 amendment. Two claims requiring independent verification are always two separate `EVIDENCE_GAP` questions, never one question carrying two subjects (§13.D, Slice 2D-C5-0 freeze).
72. `EvidenceSubject.originatingFindingId` is mandatory in every case and always resolves to exactly one `ReviewFinding` -- equal to `sourceRef.id` when `sourceRef.kind === 'FINDING'`, or a member of `SemanticIssue.findingIds` when `sourceRef.kind === 'SEMANTIC_ISSUE'`; `AUTHOR_CONTEXT_ITEM` is never a valid `sourceRef` kind for `EvidenceSubject`, having no backing `ReviewFinding` to resolve to (§13.D, Slice 2D-C5-0 freeze).
73. `EvidenceSubject` never carries its own `artifactLocation`; it is always derived by walking `originatingFindingId -> ReviewFinding.artifactLocation`, never duplicated and independently re-synchronized (§13.D, Slice 2D-C5-0 freeze).
74. A `SEEK_EVIDENCE` route for an `EVIDENCE_GAP` question may not be planned, recorded, or attempted unless exactly one valid `EvidenceSubject` is already registered for that question — enforced independently at three boundaries: `planRouteForQuestion` (fails closed before a `RouteDecision` is even minted), `recordRouteDecision` (the authoritative write boundary), and `recordRouteAttemptStart` (independently re-derived for state that may predate the creation-time gate) — corrected from two boundaries to three by the Slice 2D-C5-0 amendment (§13.D, Slice 2D-C5-0 freeze, decision O).
75. `EvidenceSubject.claimText` is immutable once registered; a materially changed proposition requires a new or `SUPERSEDED_RECLASSIFIED` `EVIDENCE_GAP` question and that question's own fresh `EvidenceSubject`, never a mutation of the existing text or a retarget of `originatingFindingId` (§13.D, Slice 2D-C5-0 freeze).
76. A future successful/inconclusive `SEEK_EVIDENCE` `RouteOutcome` is never trusted as claim-evaluated merely because its stored `evidenceSubjectId` and a plausible-looking `EvidenceSubject` agree with each other -- the complete **`StressTestSession + DeliberationState -> RouteAttempt -> RouteDecision -> EVIDENCE_GAP Question -> EvidenceSubject -> sourceRef -> ReviewFinding`** chain is independently re-validated at the moment of recording and at every later read; `StressTestSession` is load-bearing here, not optional context, because `ReviewFinding`/`SemanticIssue` provenance cannot be proven from `DeliberationState` alone (§13.D decision U/V, corrected by the Slice 2D-C5-0 amendment) (§13.D, Slice 2D-C5-0 freeze).
77. No `SEEK_EVIDENCE` result (`SUPPORTIVE`/`CONTRADICTORY`/`INCONCLUSIVE`) mechanically produces a `QuestionDisposition` of any kind; semantic re-evaluation remains a separate, explicitly supplied act (§13.D, Slice 2D-C5-0 freeze).
78. `EvidenceSubject`s are bound to their current `DeliberationState`/session and never carry into Session B through an `ADD_CONTEXT` `CROSS_SESSION` transition; Session B reviews from scratch, registering no `EvidenceSubject` carried over from Session A (§13.D, Slice 2D-C5-0 freeze).
79. A missing `DeliberationState.evidenceSubjects` array (state predating this field) is read as its legal equivalent, `[]`, without mutating the stored record (§13.D, Slice 2D-C5-0 freeze).
80. A `DECISION_SENSITIVE_CONFLICT` question's `TARGETED_PEER_CHALLENGE` route may not be registered, planned, recorded, or attempted unless its `inputRefs` contain at least two distinct `(kind, id)` `RouteInputRef`s — enforced independently at five boundaries: `createUnresolvedQuestion` (fails closed at construction), `registerUnresolvedQuestion` (the authoritative write/persistence boundary, formalizing invariant 30), `planRouteForQuestion` (independently re-derived for legacy/tampered state that may predate registration enforcement), `recordRouteDecision` (the authoritative decision-write boundary, never trusting that `planRouteForQuestion` was already called), and `recordRouteAttemptStart` (the final execution-start protection, never trusting any earlier boundary) — none deferring to another having already checked the requirement (§13.E, Slice 2D-C6-0 freeze).
81. Distinctness for invariant 80's cardinality requirement is full-tuple `(kind, id)` equality, never `id` alone — two `RouteInputRef`s of different `kind` but the same `id` (e.g., `FINDING:X` and `SEMANTIC_ISSUE:X`) count as distinct, provided each independently resolves as a valid domain object against the authoritative `StressTestSession`; deduplication by `id` alone is never performed (§13.E, Slice 2D-C6-0 freeze).
82. A registered `DECISION_SENSITIVE_CONFLICT` question's `inputRefs` carry no positional target/source semantics; `inputRefs[0]`/`inputRefs[1]` are never interpreted as target/source at construction, registration, planning, or decision-recording — a future successful `TARGETED_PEER_CHALLENGE` outcome alone chooses which recorded, decision-bound ref plays `targetRef` and which plays `sourceRef`, constrained only by invariant 31's distinctness/provenance rule, never by array position (§13.E, Slice 2D-C6-0 freeze).
83. A historical/legacy `TARGETED_PEER_CHALLENGE` `RouteAttempt` whose originating question predates invariant 80's cardinality gate may still record a generic `FAILED` `RouteOutcome`; `FAILED` asserts only mechanism failure, never a valid two-sided challenge result, and is therefore never retroactively blocked by a gate introduced after the attempt's question was registered (§13.E, Slice 2D-C6-0 freeze).

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
- That this document's own architecture text itself confers implementation authorization for any route, gate, or ledger — authorization is recorded exclusively in §25, and closing a schema decision here is never itself a runtime grant. **Corrected by the Slice 2D-C5-0 final amendment:** this section formerly denied, flatly, that `RouteAttempt`/`RouteOutcome`/`QuestionDisposition`/session-version runtime exists at all — that denial predates their acceptance and is no longer factually compatible with §25, which now records `RouteAttempt`, the accepted `RouteOutcome` subset, `QuestionDisposition` (`STILL_OPEN`/`RESOLVED`/`SUPERSEDED_RECLASSIFIED`), and `CROSS_SESSION`/`SessionVersionLineage` session-version runtime as **IMPLEMENTED / ACCEPTED**. What this document still does not claim is that any of that accepted runtime is complete, production-ready, or extends beyond the specific accepted subsets §25 names. **Status corrected by the Slice 2D-C6-0 freeze; further corrected by the Slice 2D-D0 packet:** `SEEK_EVIDENCE` successful/inconclusive runtime has itself since been accepted (Slice 2D-C5-A/2D-C5-B, §25) and is removed from this list. `TARGETED_PEER_CHALLENGE`'s readiness-gate and successful-outcome runtime have themselves since been accepted (Slice 2D-C6-A/2D-C6-B, §25) and are removed from this list as well; provider/retrieval execution remains genuinely not implemented.

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

**Closed by the Slice 2D-C4-0 schema freeze:** fifteen decisions (A–O, §13.A's "Schema decisions closed (Slice 2D-C4-0)" subsection), resolving the last genuinely open half of the two-item list this document has carried since the Slice 2D-B0 amendment. The defensible terminal fact for `NO_RESPONSE` is an explicit closure action, never an elapsed-time inference — resolving the open dependency in favor of an auditable closure event over any `responseDeadlineAt`/timeout mechanism, and requiring a dedicated `closeContextRequestWithoutResponse` operation rather than a `recordRouteOutcome` branch, so the authority boundary is explicit in the API surface itself; the operation's minimal input shape (`attemptId`, `latencyConsumed` only); the complete `ContextRequest`/attempt precondition chain; `AttemptStatus = SUCCEEDED`; the minimal `AddContextNoResponseRouteOutcome` shape with no additional field found necessary; the decision against a separate closure entity; `completedAt`/latency semantics unchanged from every other terminal outcome; `QuestionDisposition` and `CROSS_SESSION` both remaining structurally unreachable from a `NO_RESPONSE` outcome; the complete read-time re-validation rule; the late-response posture closed as an explicit scope boundary rather than left open; and the future scheduler/policy question deliberately left to a separate, later architecture decision (invariants 62–69). `SEEK_EVIDENCE` claim-level provenance was the sole remaining open item at that point (§24) — now also closed, below.

**Closed by the Slice 2D-C5-0 schema freeze:** twenty-five decisions (A–Y, §13.D's "Schema decisions closed (Slice 2D-C5-0)" subsection), closing the last genuinely open item this document has carried since the Slice 2D-B0 final amendment. A dedicated, independently-identified `EvidenceSubject` audit fact answers "which exact claim" the same way `ContextRequest`/`SessionVersionLineage` already answer their own "which exact X" questions — its own fresh `id` (never `paragraphId`/`chunkId`/`claimIndex`/a reused question or finding id); an immutable `claimText`, registered once, never restated by a later outcome; mandatory leaf `ReviewFinding` provenance even when the source is a `SemanticIssue` (`artifactLocation` derived, never duplicated); a `FINDING`/`SEMANTIC_ISSUE`-only `sourceRef` allowlist (`AUTHOR_CONTEXT_ITEM` structurally excluded — no backing finding to resolve to); a `DeliberationState.evidenceSubjects[]` ledger mirroring the already-established ownership pattern; a `questionId`-bound (not `attemptId`-bound) creation API, with the apparent tension against the Slice 2D-C0 freeze's opposite choice for `ContextRequest` explicitly resolved rather than glossed over; `ONE EVIDENCE_GAP question -> ZERO OR ONE EvidenceSubject` in storage, `EXACTLY ONE` before routing (the two cardinalities disambiguated by the Slice 2D-C5-0 amendment, below), reused unchanged across every re-attempt cycle for that question; a three-boundary planning/routing gate at `planRouteForQuestion`, `recordRouteDecision`, and `recordRouteAttemptStart` (the amendment added the first of the three); a `SeekEvidenceRouteOutcome` union refined from the governing packet's own flattened proposal so status/result pairing is type-safe, referencing `evidenceSubjectId` rather than restating the subject; the complete global read-integrity and outcome write/read provenance chains; and an explicit finding, during inspection, that the governing packet's proposed minimum field list had omitted the `sessionId`/`artifactHash`/`authorContextHash` trio every other `DeliberationState`-owned audit fact already carries (invariants 70–79). `§24` now contains zero genuinely open schema decisions.

**Corrected by the Slice 2D-C5-0 amendment:** three executable-consistency gaps found in remote architecture review are closed, none reopening the `EvidenceSubject` design itself (§13.D, decisions A–Y remain the closed architecture). First, the global read-integrity helper (§U) originally accepted only `DeliberationState`, but `ReviewFinding`/`SemanticIssue` leaf provenance is `StressTestSession` domain truth the helper cannot resolve without also receiving `session` — corrected to `assertEvidenceSubjectLedgerIntegrity(session, deliberationState)`, gated on `verifyFrozenInputIntegrity(session)` and `verifyDeliberationBinding(session, deliberationState)` passing first, with `sessionId`/`artifactHash`/`authorContextHash` re-verified as a three-way match against both `state` and `session` directly, never state-internal agreement alone; the outcome write/read provenance chain (§V) is corrected identically, `StressTestSession` prepended to its authoritative-upstream chain. Second, decision M's single "`EXACTLY ONE`" cardinality conflated two distinct invariants — corrected into a *storage* cardinality (`ZERO OR ONE` `EvidenceSubject` per `EVIDENCE_GAP` question; zero is a legitimate pre-registration state, never treated as corrupt) and a separate *route-readiness* cardinality (`EXACTLY ONE` required before `SEEK_EVIDENCE` routing, enforced at §O's gates). Third, decision O's planning/routing gate was originally two boundaries (`recordRouteDecision`, `recordRouteAttemptStart`), omitting `planRouteForQuestion` — the earliest point a `SEEK_EVIDENCE` route is ever considered (`src/stress-test/deliberation.ts`, taking `session` as its first parameter, already the boundary where `validateRouteInputRef` runs for every `inputRef`) — corrected to three independent boundaries, none deferring to another having already checked the requirement (invariants 71/74 corrected to match). Separately, §24/§25's governance-status ledger is synchronized against actual accepted repository state: `NO_RESPONSE` (`AddContextNoResponseRouteOutcome`, `closeContextRequestWithoutResponse`) moves from its stale "not implemented" wording to **IMPLEMENTED / ACCEPTED**, reflecting the Slice 2D-C4 runtime already accepted before this amendment was authored; stale wording elsewhere in §24 implying `CROSS_SESSION` still lacks runtime prerequisites is corrected to reflect its own already-accepted Slice 2D-C3 status. No new open schema decision is introduced by any of the four corrections.

---

## 23. Relation to accepted Slice 2A/2B runtime

Nothing in this document alters, weakens, or contradicts `src/stress-test/deliberation.ts` as it stands at HEAD. Every new concept is additive and downstream: `RouteAttempt` references an existing `RouteDecision` without changing its shape; `QuestionDisposition` references an existing `UnresolvedQuestion` without mutating it; the current-question derivation (§15) is backward compatible with `unresolvedQuestions: UnresolvedQuestion[]` exactly as implemented today. No accepted invariant from Slice 2A, the Slice 2A amendment, or Slice 2B is redesigned, loosened, or reopened by this document.

---

## 24. Open GPT decisions

**Zero genuinely open *schema* decisions remain, as of the Slice 2D-C5-0 freeze — unchanged by the Slice 2D-C5-0 amendment, which corrects executable consistency (§13.D decisions M/O/U/V; this section's own governance-status wording) without reopening any architecture decision, unchanged again by the Slice 2D-C6-0 freeze, which closes only `TARGETED_PEER_CHALLENGE`'s executable gate-placement sequencing (§13.E) and synchronizes this section's own governance-status wording against the now-accepted Slice 2D-C5-A/2D-C5-B runtime, and unchanged again by the Slice 2D-D0 packet, which is read-only inspection (no source, test, or package change) and synchronizes this section's own governance-status wording against the now-accepted Slice 2D-C6-A/2D-C6-B runtime, without reopening any architecture decision.** This section's history is preserved below rather than deleted: every item this document ever carried as genuinely open was closed in sequence, each by its own separately authorized architecture decision, never solved merely because another was being worked on. **This "zero" count is scoped to offline/domain schema decisions only** — the Slice 2D-D0 packet's own live-execution boundary inventory (new closing section below) explicitly and deliberately carries a non-zero open-decision count of a different kind: not-yet-closed *live-execution* architecture questions, never claimed resolved by this section, and never mixed into this section's schema-decision ledger.

**Closed by the Slice 2D-C4-0 schema freeze (formerly item 1 of this section):** `ADD_CONTEXT`'s `NO_RESPONSE` terminalization mechanism. The prior framing — a `responseDeadlineAt` bound to `ContextRequest`, or an explicit externally recorded request-window-close event, with existing source-of-truth said not to dictate which — is resolved: the second option alone, an explicit closure action via the dedicated `closeContextRequestWithoutResponse` operation, never a deadline field or any elapsed-time inference (§13.A, "Schema freeze (Slice 2D-C4-0)," decisions A–O; invariants 62–69). **Status corrected by the Slice 2D-C5-0 amendment:** `NO_RESPONSE` *runtime* is now **IMPLEMENTED / ACCEPTED** (§25) — the Slice 2D-C4 runtime packet was separately authorized and accepted after this freeze was written, and this section's earlier "NOT AUTHORIZED / not implemented" wording had not been updated to reflect that acceptance.

**Closed by the Slice 2D-C5-0 schema freeze (formerly item 2 of this section):** `SEEK_EVIDENCE`'s claim-level `EvidenceSubject` provenance. The frozen `{result, citations}` payload identified a source but never which specific factual claim within a `ReviewFinding`/`SemanticIssue` the citations evaluate (§7, invariant 32, as it read before this freeze). This document previously, deliberately declined to invent `claimText`/`claimId`/`claimIndex`/`paragraphId`/`chunkId` to paper over the gap without a separately justified design — that design now exists: a dedicated `EvidenceSubject` audit fact, its own fresh identity, an immutable registered `claimText`, and mandatory leaf `ReviewFinding` provenance (§13.D, "Schema freeze (Slice 2D-C5-0)," decisions A–Y; invariants 70–79). **Status corrected by the Slice 2D-C6-0 freeze:** `SUPPORTIVE`/`CONTRADICTORY`/`INCONCLUSIVE` *runtime* is now **IMPLEMENTED / ACCEPTED** (§25) — the Slice 2D-C5-A/2D-C5-B runtime packets were separately authorized and accepted after this freeze was written, and this section's earlier "NOT AUTHORIZED / only the architecture/mechanism is closed, not implemented" wording had not been updated to reflect that acceptance.

**Not an open decision, despite being a runtime blocker:** `TARGETED_PEER_CHALLENGE`'s source/target provenance rule *is* closed (§7 decisions L–M, invariants 30–31) — two distinct refs, both drawn from the terminated `RouteDecision`'s own `inputRefs`. Its successful-outcome runtime stays blocked only because the routing gate that would *enforce* that closed rule does not exist yet — a sequencing gap, not an unresolved architecture question. `SUPERSEDED_RECLASSIFIED` (§9 decisions F–H) was architecturally closed the same way, sequenced into a later slice — and, per §25, that later slice (Slice 2D-B2-B) has since been separately authorized, accepted, and is now **IMPLEMENTED / ACCEPTED**, not merely closed-and-pending. `CROSS_SESSION` (§9 decision E) follows the identical trajectory: architecturally closed first, sequenced into Slice 2D-C3, and — **status corrected by the Slice 2D-C5-0 amendment** — Slice 2D-C3 has itself since been separately authorized, accepted, and is now **IMPLEMENTED / ACCEPTED** (§25); this section's earlier wording ("the exact prerequisites `CROSS_SESSION` still lacks") described a point-in-time gap that closed before this amendment, and is corrected rather than left to imply `CROSS_SESSION` is still runtime-blocked. **Status corrected by the Slice 2D-C6-0 freeze:** `SEEK_EVIDENCE`'s own successful-outcome runtime has itself since moved past the closed-but-not-yet-implemented state — Slice 2D-C5-A and Slice 2D-C5-B have both been separately authorized, accepted, and are now **IMPLEMENTED / ACCEPTED** (§25), the same trajectory `SUPERSEDED_RECLASSIFIED` and `CROSS_SESSION` already completed; this section's earlier wording describing it as "sequenced into a later, not-yet-authorized slice" (§13.D, "Recommended next runtime slices") described a point-in-time gap that closed before this freeze, and is corrected rather than left to imply `SEEK_EVIDENCE` is still runtime-blocked. **Status corrected by the Slice 2D-D0 packet:** `TARGETED_PEER_CHALLENGE`'s own successful-outcome runtime has itself since moved past the closed-but-not-yet-implemented state described above — its readiness gate (Slice 2D-C6-A) and its `REBUTTAL`/`CONCESSION`/`QUALIFICATION`/`REFUSAL_TO_YIELD` successful-result recording (Slice 2D-C6-B) have both been separately authorized, accepted, and are now **IMPLEMENTED / ACCEPTED** (§25), the same trajectory `SEEK_EVIDENCE`, `SUPERSEDED_RECLASSIFIED`, and `CROSS_SESSION` already completed. Every route this document names has now completed that trajectory; only provider/retrieval/human execution remains in the not-yet-implemented state (§25, and the new closing section on live-execution boundaries).

**Architecture-open is distinct from implementation-not-yet-built (Slice 2D-C5-0 governing packet §36), stated once, explicitly, now that both items above are closed.** Closing every genuinely open *schema* decision in this document does not mean the product is complete. **Genuinely pending, as of the Slice 2D-D0 packet (§25 is authoritative; this list is illustrative, not exhaustive):** all provider/retrieval/human-external-execution for every route, and every live-execution architecture decision inventoried in the new closing section below (common execution-layer decisions and route-specific execution decisions alike) — none of which this document's offline/domain schema work resolves merely by having closed the offline/domain schema. **Already `IMPLEMENTED`/`ACCEPTED` (§25) — corrected out of this list by the Slice 2D-C5-0 final amendment, which found `NO_RESPONSE` and `CROSS_SESSION` still named here as unfinished after their own runtime slices had already been accepted; further corrected by the Slice 2D-C6-0 freeze, which found `SEEK_EVIDENCE` successful/inconclusive runtime still named here as pending after its own runtime slices had already been accepted; and further corrected by the Slice 2D-D0 packet, which found `TARGETED_PEER_CHALLENGE`'s readiness-gate and successful-outcome runtime still named here as pending after its own runtime slices had already been accepted:** `NO_RESPONSE` explicit closure runtime (`closeContextRequestWithoutResponse`, Slice 2D-C4), `CROSS_SESSION`/`SessionVersionLineage` runtime (Slice 2D-C3), `SEEK_EVIDENCE` successful/inconclusive runtime (`EvidenceSubject` registration, the three-boundary routing gate, `SeekEvidenceRouteOutcome` recording — Slice 2D-C5-A/2D-C5-B), and `TARGETED_PEER_CHALLENGE` readiness-gate and successful-outcome runtime (the constructor/registration/planning/decision/attempt-start gates, and `TargetedPeerChallengeRouteOutcome` recording — Slice 2D-C6-A/2D-C6-B) are all accepted, not pending. All of the above — pending and already-accepted alike — remain governed entirely by §25's implementation-authorization ledger, never by this section. A future genuinely open architecture decision may still arise — from a new route, a new lifecycle boundary, or a remote review finding a gap this document did not anticipate — and would be recorded here exactly as the closed items above once were; the new closing section below records the first such set discovered by a dedicated live-execution inventory rather than by an unrelated freeze.

**Neither item above was revisited prematurely by an unrelated freeze.** `SEEK_EVIDENCE`'s item was not solved by the Slice 2D-B2-0 schema freeze, the Slice 2D-B2-A amendment, the Slice 2D-B2-B0 schema freeze, the Slice 2D-B2-B amendment, the Slice 2D-C0 schema freeze, Slices 2D-C1/C1-amendment/C2, the Slice 2D-C3-0 schema freeze, nor the Slice 2D-C4-0 schema freeze — each, per its own governing packet's explicit instruction, left it untouched rather than solving it merely because this document happened to be open. Per the Slice 2D-C4-0 governing packet's own instruction (§27), closing `NO_RESPONSE` was likewise not treated as license to also solve `EvidenceSubject` provenance in the same amendment; it was closed only once its own, separately authorized Slice 2D-C5-0 packet arrived.

**The Slice 2D-C6-0 freeze introduces zero new open decisions.** The single sequencing question its governing packet asked to close — where, exactly, `TARGETED_PEER_CHALLENGE`'s already-closed input-cardinality rule (invariant 30, Slice 2D-B0 final amendment) is enforced — was closeable entirely from source-of-truth already accepted in this repository's existing runtime (`src/stress-test/deliberation.ts`'s current `createUnresolvedQuestion`, `registerUnresolvedQuestion`, `planRouteForQuestion`, `recordRouteDecision`, and `recordRouteAttemptStart` signatures, inspected directly) and this contract's own already-established patterns (the identical five-decision-shaped, shared-helper, never-trust-an-upstream-boundary architecture invariant 74 already closed for `SEEK_EVIDENCE`'s three routing gates, §13.D). No `TARGETED_PEER_CHALLENGE` payload/provenance decision (invariants 30/31) is reopened by this freeze; decisions A–K (§13.E) only place, never redesign, the gate. The freeze's second component — synchronizing this section's and §25's governance-status wording against the now-accepted Slice 2D-C5-A/2D-C5-B runtime — corrects stale status snapshots exactly as the Slice 2D-C5-0 amendment already did for `NO_RESPONSE`/`CROSS_SESSION`, reopening nothing.

**The Slice 2D-C5-0 amendment introduces zero new open decisions.** All three executable-consistency gaps its governing packet asked to close — the non-session-aware `EvidenceSubject` global-integrity helper, the two-boundary (rather than three-boundary) planning/routing gate, and the stale `NO_RESPONSE`/`CROSS_SESSION` governance-status wording — were closeable from source-of-truth already accepted in this document and this repository's existing runtime (`src/stress-test/deliberation.ts`'s `verifyDeliberationBinding`/`validateRouteInputRef`/`planRouteForQuestion`, each already taking `session` as an authoritative parameter, inspected directly) and this contract's own already-established patterns (the "never trust an upstream check for pre-existing state" posture governing every other multi-boundary gate in this document, and the existing derive-and-copy re-verification discipline already required for `sessionId`/`artifactHash`/`authorContextHash` everywhere else). No `EvidenceSubject` architecture decision (A–Y) is reopened by this amendment; only decisions M, O, U, and V are corrected in place, exactly as the 2D-C3-0 amendment corrected `SessionVersionLineage` decisions without reopening that freeze's own architecture.

**The Slice 2D-C5-0 schema freeze introduces zero new open decisions.** All twenty-five items its governing packet asked to be closed (§13.D's "Schema decisions closed (Slice 2D-C5-0)," A–Y) were closeable from source-of-truth already accepted in this document (`MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md` §4/§9, which already named the claim-identity requirement and the "paragraph-local identity is not product authority" refusal this freeze completes) and this repository's existing runtime (`src/stress-test/types.ts`'s `ReviewFinding`/`SemanticIssue`, and `src/stress-test/deliberation.ts`'s `RouteInputRef`/`validateRouteInputRef`, inspected directly rather than assumed) — not left open for lack of a clear answer. The one point the governing packet's own proposed shape got wrong — omitting the `sessionId`/`artifactHash`/`authorContextHash` trio every other `DeliberationState`-owned audit fact already carries — is corrected here (§13.D, decision C), not silently adopted.

**The Slice 2D-C4-0 schema freeze introduces zero new open decisions.** All fifteen items its governing packet asked to be closed (§13.A's "Schema decisions closed (Slice 2D-C4-0)," A–O) were closeable from source-of-truth already accepted in this document — principally the observation, already available since the Slice 2D-C0/C3-0 freezes, that `ContextRequest`'s identity link and `createCrossSessionTransition`'s atomic-transition mechanism were both *precise enough* to someday carry a `responseDeadlineAt` if that mechanism were ever chosen, but that neither freeze chose it. This freeze makes the choice: no deadline field, ever: an explicit closure action instead. Not left open for lack of a clear answer.

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
`RouteOutcome` runtime — currently accepted subset only (generic `FAILED`; `ADD_REVIEWER` success; `REPLICATE` success; `ADD_CONTEXT` `SUPPLIED`/`DECLINED` success — Slice 2D-C2; `SEEK_EVIDENCE` `SUPPORTIVE`/`CONTRADICTORY`/`INCONCLUSIVE` success — Slice 2D-C5-B; `TARGETED_PEER_CHALLENGE` `REBUTTAL`/`CONCESSION`/`QUALIFICATION`/`REFUSAL_TO_YIELD` success — Slice 2D-C6-B; per the route-readiness table, §7): **IMPLEMENTED / ACCEPTED**
`QuestionDisposition` runtime — `STILL_OPEN` / `RESOLVED` only: **IMPLEMENTED / ACCEPTED**
Currentness / active-cycle core (`isQuestionCurrent`, all five current gates, the authoritative active-cycle creation gate, and independent legacy active-cycle integrity validation — Slice 2D-B2-A): **IMPLEMENTED / ACCEPTED**
`QuestionDisposition.SUPERSEDED_RECLASSIFIED` runtime, including `derivedFromQuestionId` and the derived-lineage/question-terminality read-integrity hardening — Slice 2D-B2-B, accepted per the Slice 2D-B2-B amendment and the Slice 2D-C0 packet's own "Previous status" (§0): **IMPLEMENTED / ACCEPTED**
`ContextRequest` <-> `RouteAttempt` attempt-binding runtime (`originatingAttemptId`, `contextRequests[]` ledger, attempt-bound `createContextRequest`) — Slice 2D-C1, accepted per the Slice 2D-C1 amendment and the Slice 2D-C2/2D-C3-0 packets' own "Previous status" fields: **IMPLEMENTED / ACCEPTED**
`ADD_CONTEXT` `SUPPLIED`/`DECLINED` success (`AddContextRouteOutcome`, mandatory `ContextRequest`-ledger provenance validation) — Slice 2D-C2, accepted per the Slice 2D-C3-0 packet's own "Previous status" (§0): **IMPLEMENTED / ACCEPTED**
`CROSS_SESSION` / `SessionVersionLineage` runtime (`SessionVersionLineage` type, `sessionVersionLineages[]` ledger, parent-side and child-side lineage integrity, the atomic `createCrossSessionTransition` operation, and the bidirectional `CROSS_SESSION` <-> `SessionVersionLineage` read-time bijection) — Slice 2D-C3, accepted per the Slice 2D-C3 amendment and the Slice 2D-C4-0 packet's own "Slice 2D-C3 is: ACCEPTED / CLOSED" status (§1): **IMPLEMENTED / ACCEPTED**
`NO_RESPONSE` explicit closure runtime (`AddContextNoResponseRouteOutcome`, `closeContextRequestWithoutResponse` and its complete `ContextRequest`/attempt precondition chain, and the dedicated-operation boundary that rejects `NO_RESPONSE` through `recordRouteOutcome`) — Slice 2D-C4, accepted per the Slice 2D-C5-0 packet's own "Slice 2D-C4 final accepted SHA" status (§1); status corrected in this ledger by the Slice 2D-C5-0 amendment, which found this line still read stale **NOT AUTHORIZED**: **IMPLEMENTED / ACCEPTED**
`EvidenceSubject` registry, session-aware global read-integrity validation, and the three-boundary `SEEK_EVIDENCE` routing gate (`registerEvidenceSubject`, `planRouteForQuestion`/`recordRouteDecision`/`recordRouteAttemptStart`; invariants 70–74, 76, 78–79) — Slice 2D-C5-A, accepted per the Slice 2D-C5-B packet's own "C5-A: ACCEPTED / CLOSED" status (§1); final accepted SHA `a3bb3ff6edc7898040b4398f7292c6a9dcc91232`: **IMPLEMENTED / ACCEPTED**
`SEEK_EVIDENCE` `SUPPORTIVE`/`CONTRADICTORY`/`INCONCLUSIVE` result recording (`EvidenceCitation`, `SeekEvidenceRouteOutcome`, the status/result/citation matrix, and route-specific later-read provenance re-validation reusing `validateAttemptProvenanceForOutcome`) — Slice 2D-C5-B, including its authoritative-upstream read-provenance-hardening amendment, accepted per the Slice 2D-C6-0 packet's own "C5-B: ACCEPTED / CLOSED" status (§1); final accepted SHA `eed1d6123224a810c8fadbb629030aa16c7a9235`: **IMPLEMENTED / ACCEPTED**

`TARGETED_PEER_CHALLENGE` question cardinality/readiness runtime (constructor gate, registration gate, planning gate, decision-recording gate, attempt-start gate, and the shared `assertTargetedPeerChallengeReady`/`assertTargetedPeerChallengeInputRefs` readiness validation; invariants 80–83) — Slice 2D-C6-A, accepted per the Slice 2D-C6-B packet's own "C6-A: ACCEPTED / CLOSED" status (§1); final accepted SHA `030174c0cc82f3e18e7797aad365d70ca35c1d4d`: **IMPLEMENTED / ACCEPTED**
`TARGETED_PEER_CHALLENGE` `REBUTTAL`/`CONCESSION`/`QUALIFICATION`/`REFUSAL_TO_YIELD` successful result recording (`TargetedPeerChallengeBoundedExcerpt`, `TargetedPeerChallengeRouteOutcome`, mandatory `targetRef`/`sourceRef` decision-provenance and full-tuple distinctness validation, and route-specific later-read provenance re-validation reusing `validateAttemptProvenanceForOutcome` and `assertTargetedPeerChallengeReady`) — Slice 2D-C6-B, accepted per the Slice 2D-D0 packet's own "C6-B: ACCEPTED / CLOSED" status (§1); final accepted SHA `e9534e2e6a28ba15e86e03fae3fbd226b655a4aa`: **IMPLEMENTED / ACCEPTED**

**NOT YET IMPLEMENTED / NOT GENERALLY AUTHORIZED:**

Provider-backed route execution: **NOT AUTHORIZED**
Route execution generally, and Slice 2D's full/general scope beyond the specific accepted subsets recorded above: **NOT AUTHORIZED**

Provider/model calls: **0**

**Offline/domain closure, recorded here rather than reopening any architecture decision (Slice 2D-D0, read-only inventory):** with `TARGETED_PEER_CHALLENGE`'s readiness gate and successful-result recording now accepted above, every currently accepted Minimum Necessary Deliberation route (`ADD_CONTEXT`, `ADD_REVIEWER`, `REPLICATE`, `SEEK_EVIDENCE`, `TARGETED_PEER_CHALLENGE`, `STOP`) has a complete offline/domain ledger — see the new closing section below for the precise, deliberately narrow meaning of "offline/domain complete" and the full inventory of what remains genuinely open before any provider-backed execution of any route may be authorized.

---

## 26. Offline deliberation runtime closure & live execution boundary inventory (Slice 2D-D0)

Architecture documentation and read-only source inspection only. **No `src/**`, test, or `package.json` change is made by this section or this packet.** This section is the authoritative transition document between (A) the now-complete offline/domain Minimum Necessary Deliberation lifecycle and (B) future provider/retrieval/human external execution. It closes no new offline/domain schema decision — §24's "zero genuinely open schema decisions" is unchanged by it (§24, above) — and it authorizes no runtime. It exists to inventory, precisely and without silently resolving, everything that must still be decided before **any** provider-backed route execution of **any** route may be authorized.

### 26.1 "Offline/domain complete" — defined precisely, not to be over-read

**"Offline/domain complete" means:** the product-domain ledger (`src/stress-test/deliberation.ts` + `src/stress-test/session.ts`, `StressTestSession` + `DeliberationState`) can defensibly represent and validate a caller-supplied terminal result for every currently accepted route/result class, including authoritative provenance and later-read validation where the result carries semantic meaning (`SEEK_EVIDENCE`'s `EvidenceSubject` binding, `TARGETED_PEER_CHALLENGE`'s `targetRef`/`sourceRef` decision-provenance, `ADD_REVIEWER`'s newness/reviewerRunId structural checks, `REPLICATE`'s `targetRef` decision-provenance, `ADD_CONTEXT`'s `ContextRequest` ledger provenance).

**It does NOT mean, and this document does not claim:**
- a provider can be called;
- retrieval exists;
- reviewer execution exists;
- replication execution exists;
- `TARGETED_PEER_CHALLENGE` execution exists;
- model selection exists;
- orchestration exists;
- the product is production-ready, or complete in any sense beyond this narrow offline/domain-ledger claim.

The term used throughout this section is deliberately **"offline/domain complete,"** never "route execution complete" — the latter phrase is not used anywhere in this section because it would overclaim.

### 26.2 Offline/domain route-level closure (source-verified)

| Route | Offline/domain state | Accepting slice(s) |
|---|---|---|
| `ADD_CONTEXT` | `ContextRequest`, `SUPPLIED`, `DECLINED`, `NO_RESPONSE` explicit closure, generic `FAILED`, `CROSS_SESSION` continuation | Slice 2D-C0/C1/C2/C3/C4 |
| `ADD_REVIEWER` | successful result recording (structural multi-signal newness check), generic `FAILED` | Slice 2D-B0/B1 (schema); accepted subset per §25 |
| `REPLICATE` | successful result recording (`targetRef` decision-provenance), generic `FAILED` | Slice 2D-B0/B1 (schema); accepted subset per §25 |
| `SEEK_EVIDENCE` | `EvidenceSubject`, three-boundary routing readiness, `SUPPORTIVE`/`CONTRADICTORY`/`INCONCLUSIVE`, generic `FAILED` | Slice 2D-C5-0/C5-A/C5-B |
| `TARGETED_PEER_CHALLENGE` | two-distinct-ref readiness (five boundaries), `REBUTTAL`/`CONCESSION`/`QUALIFICATION`/`REFUSAL_TO_YIELD`, generic `FAILED` | Slice 2D-C6-0/C6-A/C6-B |
| `STOP` | accepted no-`RouteAttempt`/no-`RouteOutcome` semantics, unchanged since Slice 2A/2B | Slice 2A/2B |
| `QuestionDisposition` | `STILL_OPEN`/`RESOLVED`/`SUPERSEDED_RECLASSIFIED` — separate semantic re-evaluation, unchanged | Slice 2D-B2-A/B2-B |
| `HumanAdjudication` | remains the sole revision authority (`actionChange = YES → RevisionAction`) — unchanged | Slice 1 |

**Not claimed:** the product is complete. This table is exclusively an offline/domain-ledger claim (§26.1).

### 26.3 Common execution-layer decisions (inventory — not resolved here)

Findings below are grounded directly in current source, inspected read-only this packet: `src/stress-test/deliberation.ts` (`RouteAttempt`, `RouteOutcome`, `recordRouteAttemptStart`, `recordRouteOutcome`, `applyCostSpend`, `applyLatencySpend`, `FailureInfo`, `logicalAttemptCostForRoute`), `src/providers/types.ts`, `src/agents/collaboration.ts`, `src/providers/index.ts`/`claude.ts`/`openai.ts`/`gemini.ts`, `src/config.ts`, `MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md`.

**Grounding fact, load-bearing for this entire section:** a repository-wide search (`grep` across `src/stress-test/*.ts`, `src/providers/*.ts`, `src/agents/*.ts`, `src/modes/*.ts`) found **zero** references connecting `src/stress-test/*` to `src/providers/*`, `src/agents/*`, or `src/modes/*`, in either direction. The offline deliberation domain and the existing "main" CHIEF/collaboration provider pipeline are today two fully disjoint code paths. No orchestration layer currently targets a stress-test `RouteAttempt` at all.

**A/B. What product operation owns an actual external/provider execution, and does it live inside stress-test domain code or an orchestration layer?**
Neither exists today (see grounding fact above). `recordRouteAttemptStart`'s own docstring already states the intended ordering: `recordRouteAttemptStart` → persist the returned state → "an external mechanism MAY execute in a separately-authorized layer." Every function in `deliberation.ts` is documented, repeatedly, as pure/offline/zero-provider-calls. Introducing a live call *inside* `deliberation.ts` would contradict that standing textual guarantee for every existing function. The repository's own existing precedent (the "main" pipeline's `src/modes/orchestrator.ts`/`pipeline.ts`/`debate.ts` call providers; `src/stress-test/*` does not) leans toward a **separate orchestration layer**, not domain-code, as the natural home for the external call — but this is a directional read of precedent, not a closed decision. **OPEN.**

**C. Does `RouteAttempt` provide sufficient execution identity?**
`RouteAttempt.attemptId` is a fresh, independently-generated identity (`randomUUID()`), globally unique, immutable once created, already under a `ONE RouteDecision -> AT MOST ONE RouteAttempt` and `ONE RouteAttempt -> AT MOST ONE RouteOutcome` cardinality (invariants 9–10, already accepted runtime). No source-of-truth evidence inspected this packet demonstrates `attemptId` is insufficient as an idempotency/execution key. Per this packet's own instruction, **no new identity is invented.** **NOT OPEN** — `attemptId` is presumptively sufficient absent a demonstrated need for a second identity.

**D. How is an executor prevented from executing the same attempt twice?**
The *ledger* already prevents a second `RouteAttempt` record for the same `RouteDecision`. It does not prevent an executor from independently calling an external provider twice for an *already-recorded* `attemptId` (e.g., a naive retry outside the ledger, or two concurrent executor processes racing on the same open attempt). No de-duplication/idempotency check against `deliberationState.outcomes`/in-flight state is specified before a live call may begin. **OPEN.**

**E. What does an executor do if external work succeeds but result persistence fails?**
No mechanism exists to represent "the external call happened and produced a result, but `recordRouteOutcome` could not (yet, or ever) legally accept it." There is no "provisional outcome" or "external result received, pending ledger commit" state. This is the write side of the atomicity/reconciliation problem — see §26.8. **OPEN.**

**F. What does an executor do if external work fails before a `RouteOutcome` is written?**
Partially closed already: `MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md` §13's fallback table already establishes the *principle* ("preserve the last defensible checkpoint, record an auditable failure with its reason, never fabricate"), and the offline runtime already accepts a generic `FAILED` `RouteOutcome` (`FailureInfo`) for exactly this case, for every non-`STOP` route, today. Mechanically, an executor whose call fails cleanly should call `recordRouteOutcome({status:'FAILED', failure:{category, message}})`. **NOT OPEN** as a mechanism; who invokes it is subsumed by A/B.

**G. How are transport/provider failures mapped into the already-frozen `FailureInfo` categories?**
`FailureInfo.category` is closed: `TRANSPORT | VALIDATION | REFERENCE_RESOLUTION | EXECUTION`. No concrete mapping table from real provider/SDK failure modes (rate limits, timeouts, auth errors, malformed/unparseable responses, content refusals) to these four categories exists anywhere in the repository. The four categories appear adequate on inspection (network/timeout → `TRANSPORT`; the call itself failing → `EXECUTION`; a normalized-result parse failure → `VALIDATION`; an unresolved reference → `REFERENCE_RESOLUTION`, already the route-agnostic pattern `MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md` §13 already uses) — this is a mechanical gap, not a conceptual blocker, but the table itself does not exist. **OPEN** (mechanical).

**H. How is `latencyConsumed` measured/normalized?**
Not specified anywhere. `RouteOutcomeCommon.latencyConsumed` is caller-supplied; the domain layer only checks it is a finite, non-negative number (`assertFiniteNonNegative`). No unit (milliseconds vs. seconds vs. an abstract "latency unit") is stated in either contract, and the domain layer never measures it itself. **OPEN.**

**I. How does the finite `LatencyBudget` interact with an external call whose final duration cannot be known before the call begins?**
Genuine, concrete gap — see §26.9 for the full trace. **OPEN.**

**J. What pre-call budget reservation, if any, is needed?**
No reservation concept exists. `applyCostSpend` is called once, at attempt start, for a fixed route-determined `logicalCost` (an integer, not a live measurement) — this already functions as a *cost* reservation. `applyLatencySpend` is called once, only at outcome time, from a caller-supplied value — there is no *latency* reservation at all. **OPEN**, and directly entangled with I.

**K. Where does provider/model selection authority live?**
Nowhere connects to stress-test today (per the grounding fact above). In the separate "main" pipeline, selection lives in `src/agents/registry.ts` (`AGENT_REGISTRY`, `resolveRoster`/`resolveWorker`/`listAgents`) and `src/config.ts` (`ProviderName`, `availableProviders`) — infrastructure never wired to `StressTestSession`/`DeliberationState`. `MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md` §17 Decision 2 (already closed) states this explicitly: the CHIEF registry roster is **infrastructure**, not the Stress Test product's reviewer-role **ontology** — reusable as plumbing, but the product-level selection *authority* remains undesigned. **OPEN.**

**L. How does execution remain bounded with no automatic retry?**
The *principle* is already accepted architecture: invariant 6 ("no automatic cascading loop"), and `MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md` §13 ("a retry of the very same route that just failed is never automatic; it requires a fresh, independently justified `RouteDecision`"). `CostBudget` is explicitly, already, **not** `transportMaxRetries` (§12: "a logical deliberation call and a transport-layer retry are distinguishable accounting concerns" — the concrete API from `PRODUCT_RUNTIME_RECONCILIATION.md` is explicitly not imported). No runtime mechanism yet enforces or represents the boundary between "a transport-level retry inside one logical call" and "a second logical `RouteAttempt.'" **PARTIALLY OPEN** — principle closed, enforcement point undesigned.

**M. How are external raw/provider objects prevented from leaking into product audit state?**
See §26.10. The *type-level* boundary is **already closed**: `EvidenceCitation`'s own docstring already states, explicitly, "Never a raw provider/SDK object, a retrieved full document, a ranking score, or a query"; `TargetedPeerChallengeBoundedExcerpt`, `AddReviewerRouteOutcome`, `ReplicationRouteOutcome`, and `FailureInfo` were each independently confirmed by direct inspection this packet to have no field capable of holding such data. **NOT OPEN** as a schema question; open only as a future runtime-discipline question (whatever normalizer code is eventually written must respect a boundary that already exists).

**N. What is the atomicity boundary between external side effects and local ledger persistence?**
The central live-execution architecture question. See §26.8 in full. **OPEN.**

**O. What is the fallback behavior if execution cannot produce a valid normalized route result?**
Already principled (`MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md` §13: "an invalid or unresolved reference means the route cannot execute... records an auditable failure with its reason, never fabricates a mapping") and already mechanically supported (generic `FAILED`, same as F). **NOT OPEN** as a new decision.

**P. Which failures should produce a generic `FAILED` `RouteOutcome` versus leave an open historical attempt?**
Already implicit in accepted invariants, restated here without changing runtime semantics (per this packet's own §17 instruction — nothing below is a change): an attempt with no recorded `RouteOutcome` is legitimately open/unterminated — auditable, never silently deleted, never treated as `SUCCEEDED` or `FAILED` without an explicit outcome (invariant 22, already accepted); `STOP` may leave unfinished historical cycles (invariant 36, already accepted). Any failure an executor can actually *observe* and attribute to the specific attempt (a determinate provider/transport failure, a normalization failure) should produce a `FAILED` `RouteOutcome` — that is exactly what `FAILED` already exists for. An attempt should remain open/historical only for genuinely indeterminate cases — the process is interrupted before it can determine whether the call even succeeded or failed, so there is nothing yet to record. **NOT OPEN** as a new decision; restated for the benefit of a future execution-layer implementer, not modified.

**Q. What explicit authorization boundary must exist before any live call?**
One binding precondition already exists on record: `MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md` invariant 18 — "Before any provider-backed Minimum Necessary Deliberation runtime is enabled, it must have explicit, finite hard ceilings for `CostBudget` and `LatencyBudget`; an unconfigured ceiling must never be interpreted as unbounded." No further authorization boundary (a feature flag, a per-session opt-in, a dedicated GPT authorization packet per route) is yet specified beyond what this session's own packet-governance protocol already requires for every change. Whether invariant 18 alone is a sufficient gate, or whether a dedicated live-execution authorization boundary is also required, is not decided here. **OPEN.**

**Common execution-layer open decisions, consolidated (11):**
1. Execution ownership — which module/layer performs the actual external call (A/B).
2. Live-call idempotency/de-duplication beyond the existing ledger's one-attempt-per-decision rule (D).
3. Success-but-persistence-fails reconciliation (E) — see §26.8.
4. Concrete `FailureInfo` category mapping table for real provider/transport failure modes (G).
5. `latencyConsumed` measurement definition and units (H).
6. `LatencyBudget` vs. an external call whose true duration is unknowable in advance (I) — see §26.9.
7. Pre-call cost/latency reservation mechanism, if any (J).
8. Product-domain provider/model selection authority, distinct from existing CHIEF registry infrastructure (K).
9. Transport-retry vs. logical-`RouteAttempt`-retry boundary and its enforcement point (L).
10. External-side-effect vs. local-ledger atomicity/reconciliation contract (N) — see §26.8.
11. Whether invariant 18 alone is a sufficient authorization gate before any route's live execution, or a dedicated live-execution authorization boundary is also required (Q).

### 26.4 `ADD_CONTEXT` execution classification

`ADD_CONTEXT`'s already-accepted runtime represents: `ContextRequest` → external/human response or explicit closure (`closeContextRequestWithoutResponse`) → optional new session (`CROSS_SESSION`). Its "response" is authored by the artifact's **human author**, not generated by a model — there is no provider call anywhere in its core mechanism, and none is architecturally implied by its own contract text (`MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md` §4: "No provider call for the request/response itself — answered by a human, not spent against any model-call budget"). Forcing `ADD_CONTEXT` into the same "provider-backed executor" abstraction as the other four routes would be a category error — its authority model is fundamentally a human-input-capture-and-closure mechanism, not a model-execution mechanism. Its only genuinely open item is an **input/integration surface question, not a provider-execution question**: what UI/CLI/API surface actually captures a human's reply and calls it into `recordRouteOutcome({result:'SUPPLIED'|'DECLINED'})` against the correct `ContextRequest.id`. **`ADD_CONTEXT` open decisions: 1** (the human-response capture surface).

### 26.5 Route-specific execution inventories

#### `ADD_REVIEWER`

Between `RouteAttempt(ADD_REVIEWER)` and the already-accepted `AddReviewerRouteOutcome`:
- **Reviewer selection authority — undesigned.** `MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md` §17 Decision 2 (already closed) states the current CHIEF registry roster is infrastructure only; the product's reviewer-role taxonomy/selection authority is explicitly not designed.
- **`reviewerRunId` creation authority — undesigned.** Caller-supplied to `recordRouteOutcome` today, with only structural validation (distinctness, `startedAt` ordering, `finding.createdAt >= attempt.startedAt`, one-`reviewerRunId`-per-successful-outcome) — who mints it, and when, is unspecified.
- **Invocation input — undesigned.** What exact input triggers a new reviewer pass (the full artifact? a scoped slice? the specific unresolved item's context?) is unspecified.
- **`addFinding` → structured-input gap.** `addFinding` (`src/stress-test/session.ts`) requires an already-fully-structured `ReviewFinding` shape as caller input (`title`, `evidenceState`, `whyMaterial`, `likelyRecipientChallenge`, `minimumBeforeSendAction`, `artifactLocation`, confirmed by direct signature inspection) — a raw provider text response cannot be handed to it directly. No parser/normalizer from raw model output into this exact shape exists.
- **Ordering/atomicity across two aggregates.** `addFinding` mutates `StressTestSession`; `RouteOutcome` mutates `DeliberationState` — two separate aggregates per `MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md` §17 Decision 3 (already closed). No atomic operation spans both today; an executor would need to call both in some order with no existing atomicity guarantee between them (entangled with the general atomicity question, §26.8).
- **Exactly-once/newness — already closed**, not open: the structural multi-signal check is already implemented and accepted (invariant-equivalent to invariant 28).
- Failure mapping / provider selection / retry posture — common questions G/K/L above, not restated.

**`ADD_REVIEWER` open decisions: 5** (reviewer selection authority; `reviewerRunId` minting authority; invocation-input shape; raw-output-to-`ReviewFinding` normalization; `addFinding`/`RouteOutcome` two-aggregate ordering and atomicity).

#### `REPLICATE`

Between `RouteAttempt(REPLICATE)` and the already-accepted `ReplicationRouteOutcome`:
- **What exactly is re-run — undesigned.** Neither contract specifies whether `REPLICATE` re-asks the same reviewer/prompt for the same `targetRef`, or runs an independent verification pass.
- **Which reviewer/model/configuration is reused or varied — undesigned.**
- **Authoritative `targetRef` resolution — already closed, not open.** Confirmed in the accepted runtime: `targetRef` must independently resolve (`validateRouteInputRef`) and exactly match a member of the terminated `RouteDecision.inputRefs`.
- **Reproduction comparison authority — undesigned.** No comparison logic exists anywhere; `ReplicationResult` (`REPRODUCED`/`NOT_REPRODUCED`/`PARTIAL`) is caller-supplied directly to `recordRouteOutcome`, validated only for enum membership — nothing decides *which* value is correct.
- Provider selection / failure mapping / retry posture — common questions K/G/L, not restated.

**`REPLICATE` open decisions: 3** (what is re-run; reviewer/model reuse-or-vary policy; reproduction-classification authority).

#### `SEEK_EVIDENCE`

Between `EvidenceSubject` + `RouteAttempt(SEEK_EVIDENCE)` and the already-accepted `SeekEvidenceRouteOutcome`:
- **Query-generation authority — undesigned.** No mechanism turns `EvidenceSubject.claimText` into an actual retrieval query.
- **Retrieval provider/tool authority — undesigned.** `src/providers/types.ts` already defines a retrieval abstraction (`RetrievalRequest`, `RetrievalResult`, `RetrievalSource`, `RetrievalStatus`) for the separate "main" pipeline — never wired to stress-test. Whether `SEEK_EVIDENCE` reuses this shape or needs its own is undesigned.
- **Source-selection/ranking — undesigned.**
- **Citation/`sourceIdentifier` derivation and excerpt provenance — undesigned.** No rule connects a raw `RetrievalSource` (`title?`/`url`) to `EvidenceCitation`'s `sourceIdentifier`/`excerpt`/`title` fields.
- **Who determines `SUPPORTIVE`/`CONTRADICTORY`/`INCONCLUSIVE` — undesigned.** `SeekEvidenceResult` is caller-supplied directly; no classification mechanism exists.
- **Raw retrieval/provider data boundary — already closed, not open.** `EvidenceCitation`'s own docstring already forbids raw provider/SDK objects, full documents, ranking scores, or queries — a design constraint any future normalizer must satisfy, not an open question.
- Retry posture / failure mapping — common questions L/G, not restated.

**`SEEK_EVIDENCE` open decisions: 5** (query-generation authority; retrieval provider/tool authority, including whether to reuse `src/providers/types.ts`'s shape; source-selection/ranking authority; citation/excerpt derivation-and-normalization rule; evidence-classification authority).

#### `TARGETED_PEER_CHALLENGE`

Between `RouteAttempt(TARGETED_PEER_CHALLENGE)` and the already-accepted `TargetedPeerChallengeRouteOutcome`. This is the largest gap among all five routes — a genuine identity-system mismatch, not merely an unimplemented mechanism.

**Grounding fact (direct inspection of `src/agents/collaboration.ts`, read-only):** the experimental M2-A mechanism's entire challenge identity is `agentId`/`chunkId` against `OutputChunk`s — ephemeral, run-time-segmented passages of a Round-1 specialist's raw text output, never persisted as a stable product-domain record. `CollaborationIssue.sourceRef` is a `<agentId>:<chunkId>` string, `PeerExcerpt` carries `agentId`/`chunkId`/`chunkIndex`/`startChar`/`endChar`, and `buildPeerExcerpt(agentId, chunk, charLimit)` builds directly from that ephemeral chunk. Product `TARGETED_PEER_CHALLENGE` identity is `RouteInputRef` (`kind: FINDING | SEMANTIC_ISSUE | AUTHOR_CONTEXT_ITEM`, `id`), resolving against `StressTestSession.findings`/`semanticIssues` — persisted, stable, product-domain records with no chunk/agent attribution. **These are two disjoint identity systems with no existing mapping between them.** `MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md` invariant 7 — "Paragraph-local chunk ids are never the product-level provenance identity" — already stands as an explicit, existing architectural bar against solving this by naively equating the two. This packet does **not** invent that mapping; it is inventoried, not solved.

- **How `targetRef` maps to challenged content — undesigned.** A `targetRef` names a `ReviewFinding`/`SemanticIssue`; M2-A's "challenged content" is a specific specialist's `OutputChunk`. No existing audit fact links a `ReviewFinding` to the specific raw model output (if any) that produced it — `ReviewFinding.rawText` is optional and, even when present, carries no chunk segmentation or agent attribution.
- **How `sourceRef` maps to challenge-generating content — undesigned**, the mirror gap.
- **Whether a stored reviewer output exists for each product ref — NO**, confirmed by direct inspection of `ReviewFinding`'s type (`src/stress-test/types.ts`): `rawText?: string` is optional, unsegmented, unattributed.
- **Whether such a mapping needs a new audit fact — appears likely on inspection, but is explicitly not decided here.** This is exactly the kind of new-schema decision this read-only inventory slice must not silently make.
- **Who selects the challenged model/reviewer — undesigned**, mirroring `ADD_REVIEWER`'s reviewer-selection gap, but scoped to "which existing finding-producing pass gets challenged."
- **How `boundedExcerpt` is derived — the type is closed (`TargetedPeerChallengeBoundedExcerpt`, Slice 2D-C6-B), but its source text is not.** Whether it comes from a `ReviewFinding.rawText`, a freshly re-fetched provider output, or the finding's own `artifactLocation` quote is undesigned.
- **How `response` is captured — undesigned**, mirroring `ADD_REVIEWER`'s invocation-input gap.
- **Who classifies `REBUTTAL`/`CONCESSION`/`QUALIFICATION`/`REFUSAL_TO_YIELD` — undesigned**, mirroring `REPLICATE`'s classification-authority gap; `TargetedPeerChallengeResult` is caller-supplied directly, validated only for enum membership and status pairing.
- Failure mapping / retry posture — common questions G/L, not restated.

**`TARGETED_PEER_CHALLENGE` open decisions: 7** (target-content mapping; source-content mapping; whether/how a new audit fact bridges product refs to reviewer-output provenance; challenged-party/reviewer selection authority; `boundedExcerpt` source-text derivation; response-capture mechanism; result-classification authority).

**Product/experimental TPC identity bridge currently exists: NO.**

### 26.6 Experimental M2-A status (preserved, not reopened)

M2-A proved only that the experimental mechanism ran end-to-end once. It did **not** prove: quality improvement; incremental peer-information value; production readiness; default-on policy; or product-domain identity compatibility (§26.5 above demonstrates the opposite — a genuine, unbridged identity mismatch). M2-B is not reopened and not executed by this packet.

### 26.7 Executor architecture: common shell vs. route-specific adapters vs. separate operations (evaluation, not implementation)

**Do not assume** all four machine routes (`ADD_REVIEWER`, `REPLICATE`, `SEEK_EVIDENCE`, `TARGETED_PEER_CHALLENGE`) should share one executor API merely because they share `RouteAttempt`/`RouteOutcome`.

**For a common shell:** all four already share `recordRouteAttemptStart`, the generic `FAILED` path, `applyLatencySpend`, and (prospectively) an idempotency key (`attemptId`, §26.3.C) and a `FailureInfo`-category mapping convention (§26.3.G). A shared envelope could plausibly own: idempotency-key derivation, budget-reservation-and-reconciliation (once §26.9 is resolved), the external-call try/catch skeleton, and the final `recordRouteOutcome` dispatch.

**Against forcing one executor API:** the actual external *authority* differs materially per route — `ADD_REVIEWER` needs reviewer selection + finding normalization; `REPLICATE` needs reproduction-comparison authority; `SEEK_EVIDENCE` needs retrieval-provider authority + ranking + citation normalization; `TARGETED_PEER_CHALLENGE` needs the unsolved identity-bridge problem, which is qualitatively larger and structurally different (it plausibly needs a *new audit fact*, not merely a normalizer) — see §26.5. `ADD_CONTEXT` is not "provider execution" in kind at all (§26.4) and must not be forced into the same shape.

**Recommendation (evaluation only, not adopted as an implementation decision):** a common execution **shell** (idempotency-key = `attemptId`; a shared external-call try/catch skeleton; shared `FailureInfo`-category mapping conventions; a shared "no automatic retry" enforcement point) is plausibly useful and low architectural risk to specify — **with route-specific adapters** supplying the actual external call and the raw-output normalizer into each route's already-closed successful-result type. `ADD_CONTEXT` should not be forced into this shell at all.

### 26.8 Atomicity: the reconciliation problem, named precisely

External side effects cannot be literally database-atomic with local ledger persistence — an HTTP call to a provider and a local `DeliberationState` mutation are two physically separate systems; no code change can make them one atomic transaction. Applying the standing atomicity rule (pure preparation may be separate; a live operation must never knowingly expose a false partial transition without accounting for the recovery/audit consequence), the exact reconciliation/idempotency problem is:

1. **External call succeeds, but the process crashes or the network drops before `recordRouteOutcome` is ever called.** The `RouteAttempt` (already persisted before execution, per its own documented ordering) stays open/unterminated. This is not silently wrong — invariant 22 (already accepted) already treats an open/unterminated attempt as auditable, never silently deleted, never guessed into `SUCCEEDED` or `FAILED`. What is missing is any reconciliation *process*: nothing re-queries the external system, nothing surfaces "this attempt has been open unusually long," and per this packet's own §17 instruction, no automatic reconciliation is invented here.
2. **External call succeeds, but `recordRouteOutcome` rejects the result** (e.g., the `LatencyBudget` race, §26.9). Here the external work is real (and possibly billed) but has no ledger representation of its actual result — only the open `RouteAttempt` itself, minted before the call, stands as the audit signal that work may have occurred.

**The audit *substrate* for reconciliation already exists** (open/unterminated `RouteAttempt` semantics, invariant 22). **The reconciliation *process/policy* does not** — who looks at open attempts, on what trigger, and what they are permitted to do about it, is genuinely undesigned. Not invented here, per this packet's own instruction.

### 26.9 Budget posture: the `LatencyBudget` race (identified, not papered over)

Preserved unchanged: finite `CostBudget` and `LatencyBudget` are both required; no unbounded execution; no automatic retry; logical cost is charged at attempt start (`applyCostSpend`, a fixed route-determined integer — already a real *cost* reservation); latency is charged only at terminal outcome (`applyLatencySpend`, from a caller-supplied `latencyConsumed` value).

**The race, traced through the actual accepted code (`applyLatencySpend`, confirmed by direct inspection):** it throws if `spent + amount > ceiling`. Consider: an external call is made; its actual measured latency, once known after the call completes, would push `latencyBudget.spent` over `latencyBudget.ceiling`. `recordRouteOutcome` can then no longer legally persist that measured latency — the call has *already happened*, but the ledger structurally refuses to accept the true fact about how long it took. The executor is left with no legal option: fabricating or truncating the latency value would violate the "never guessed, never fabricated" principle this same contract already applies elsewhere (e.g. §13's fallback rule); leaving the attempt permanently open despite holding a complete, real result is a *worse* false-partial-transition than §26.8's cases, because here the result is not merely unrecorded — it is known and cannot be truthfully recorded.

This is a **genuine, unresolved architecture gap**, not merely an implementation detail. No arbitrary reservation constant is proposed here to paper over it (per this packet's own instruction). **Recorded as OPEN** (consolidated list item 6, §26.3).

### 26.10 Provider secrets / raw data inventory

Product domain must never store API keys, provider auth, raw SDK response objects, unbounded raw pages, or private transport metadata. Current locations, confirmed by direct inspection:
- **API keys:** `PROVIDERS.<name>.apiKey`, sourced from `src/config.ts`, read only inside each provider adapter at call time (`src/providers/claude.ts`, `openai.ts`, `gemini.ts`) — never referenced anywhere under `src/stress-test/`.
- **Raw provider response objects:** `RetrievalResult.raw?: unknown` (`src/providers/types.ts`) exists only in the separate "main" pipeline's own `CallResult`/`RetrievalResult` shape — never referenced by, or reachable from, stress-test domain types.
- **Stress-test's own accepted types** (`EvidenceCitation`, `TargetedPeerChallengeBoundedExcerpt`, `FailureInfo`, `AddReviewerRouteOutcome`, `ReplicationRouteOutcome`) were each independently confirmed, by direct docstring/shape inspection this packet, to structurally exclude API keys, raw SDK objects, unbounded raw pages, and private transport metadata already — none has a field capable of holding such data.

No secret was found in, or entered into, this documentation. **Not open as a schema question** — the type-level boundary is already sound by construction, because no execution has ever occurred to test it. **Open only as a future runtime-discipline concern:** whatever normalizer/executor code is eventually written must be reviewed to confirm it never spreads a raw provider response into a `FailureInfo.message`, an `EvidenceCitation`, or any other accepted type — flagged for the next slice's own review process, not a new architecture decision.

### 26.11 Source-comment observation (non-blocking engineering cleanup, not an architecture decision)

`src/stress-test/deliberation.ts`'s `TargetedPeerChallengeBoundedExcerpt` comments (two occurrences, confirmed by direct inspection) read "`truncated` iff `text.length === charLimit`." The accepted runtime correctly enforces only the one-directional implication actually intended and implemented: `text.length <= charLimit` always, **and** `truncated === true → text.length === charLimit` — never the converse. An untruncated excerpt may legitimately have `text.length === charLimit` (a source that happens to be exactly the limit's length without being truncated at all), so the bidirectional "iff" phrasing overclaims what the code enforces; the code itself (`assertValidTargetedPeerChallengeBoundedExcerpt`) is correct. **No `src/**` change is made in this docs-only slice.** Recorded here as a comment-wording cleanup for a future, in-scope commit — not an architecture decision, not blocking.

### 26.12 Execution gap matrix

| Route | Offline ledger readiness | Execution class | Current reusable mechanism | Missing product authority/binding | Provider/retrieval dependency | Genuinely open decisions | Safe next slice |
|---|---|---|---|---|---|---|---|
| `ADD_CONTEXT` | Complete | Human-response capture + explicit closure — **not** model-provider execution in kind | `ContextRequest`, `closeContextRequestWithoutResponse`, `createCrossSessionTransition` (all accepted) | Human-response capture surface (UI/CLI/API) | None (human-answered) | 1 | Input-surface design, independent of any provider slice |
| `ADD_REVIEWER` | Complete | Provider-backed reviewer pass | `AGENT_REGISTRY`/`resolveRoster` (infra only, unwired), `addFinding` | Reviewer selection authority; `reviewerRunId` minting; invocation input; raw-output→`ReviewFinding` normalization; `addFinding`/`RouteOutcome` ordering+atomicity | Yes (a specialist/model call) | 5 | Common execution-layer slice first (§26.3), then reviewer-normalization slice |
| `REPLICATE` | Complete | Provider-backed re-run + comparison | `targetRef` decision-provenance (accepted) | What is re-run; reviewer/model reuse-or-vary policy; comparison/classification authority | Yes (a specialist/model call) | 3 | Common execution-layer slice first, then comparison-authority slice |
| `SEEK_EVIDENCE` | Complete | Provider-backed retrieval | `RetrievalRequest`/`RetrievalResult`/`RetrievalSource` (main-pipeline shape, unwired) | Query generation; retrieval provider/tool authority; ranking; citation/excerpt normalization; evidence classification | Yes (retrieval-specific — invariant 8: retrieval is `SEEK_EVIDENCE`'s entire purpose) | 5 | Common execution-layer slice first, then retrieval-integration slice |
| `TARGETED_PEER_CHALLENGE` | Complete | Provider-backed challenge/response, **plus an unsolved identity bridge** | None reusable as-is — M2-A's `agentId`/`chunkId` identity is architecturally barred from product use (invariant 7) | Target/source-content mapping; possible new audit fact; challenged-party selection; `boundedExcerpt` source-text derivation; response capture; result classification | Yes (a specialist/model call) | 7 | Common execution-layer slice first; identity-bridge redesign is its own, larger, later slice |

No numeric production estimate is given for any cell above, per this packet's own instruction.

### 26.13 Recommended next architecture slice

**Recommended: `SLICE 2D-D1-0` — EXTERNAL ROUTE EXECUTION ENVELOPE / IDEMPOTENCY / FAILURE CONTRACT.**

Inspection confirms this is the smallest slice that closes a prerequisite shared by more than one machine route without prematurely choosing a provider: all five routes' own execution inventories (§26.4–§26.5) independently depend on the same four common-layer questions — idempotency (§26.3.D), the `FailureInfo` mapping table (§26.3.G), the atomicity/reconciliation *policy* (§26.8 — policy only, no code), and the `LatencyBudget` race (§26.9). Solving these once unblocks every route's own subsequent, route-specific slice; solving one route's execution authority first (e.g. `ADD_REVIEWER`'s reviewer-selection question) would leave these four common questions to be separately re-litigated per route. `TARGETED_PEER_CHALLENGE`'s identity-bridge problem (§26.5) is real and large, but it is a route-specific *schema* question, not a shared execution-envelope prerequisite — it belongs in its own, later, dedicated slice, after the common envelope exists, not before.

`SLICE 2D-D1-0` should be scoped narrowly, architecture only, no code, to:
1. the idempotency-key contract (formalizing `attemptId` reuse as the executor-facing idempotency key, §26.3.C/D);
2. a concrete `FailureInfo` category mapping table for common transport/provider failure modes (§26.3.G);
3. the atomicity/reconciliation *policy* for §26.8's two named scenarios — a decision, not a mechanism;
4. a resolution for the `LatencyBudget` race (§26.9) — a chosen policy, not an arbitrary reservation constant.

It should explicitly **not** choose a provider, select a model, design `ADD_REVIEWER`'s reviewer taxonomy, design `SEEK_EVIDENCE`'s retrieval integration, or attempt `TARGETED_PEER_CHALLENGE`'s identity bridge. This is a recommendation for a future packet to authorize or not — it is not itself an authorization, and no runtime implementation is authorized by naming it here.

### 26.14 Open decisions (Slice 2D-D0) — full list

Unlike §24's historical *schema* list (zero, unchanged, §24 above), this is a live-execution *architecture* inventory and is **not** forced to zero.

**Common execution-layer (11):** see the consolidated list in §26.3.

**Route-specific (21):**
- `ADD_CONTEXT` (1): human-response capture surface.
- `ADD_REVIEWER` (5): reviewer selection authority; `reviewerRunId` minting authority; invocation-input shape; raw-output→`ReviewFinding` normalization; `addFinding`/`RouteOutcome` two-aggregate ordering and atomicity.
- `REPLICATE` (3): what is re-run; reviewer/model reuse-or-vary policy; reproduction-classification authority.
- `SEEK_EVIDENCE` (5): query-generation authority; retrieval provider/tool authority; source-selection/ranking authority; citation/excerpt derivation-and-normalization; evidence-classification authority.
- `TARGETED_PEER_CHALLENGE` (7): target-content mapping; source-content mapping; whether/how a new audit fact bridges product refs to reviewer-output provenance; challenged-party selection authority; `boundedExcerpt` source-text derivation; response-capture mechanism; result-classification authority.

**Total: 32 genuinely open live-execution decisions**, none of which reopens any offline/domain schema decision this document has already closed (§24), and none of which is resolved by this read-only inventory packet.

---

## 27. External route execution envelope: idempotency, failure, reconciliation, latency contract (Slice 2D-D1-0)

Architecture documentation only. **No `src/**`, test, or `package.json` change is made by this section or this packet; no execution checkpoint runtime is implemented; no provider/model is called or selected.** This section closes the smallest common execution-layer prerequisite shared by `ADD_REVIEWER`, `REPLICATE`, `SEEK_EVIDENCE`, and `TARGETED_PEER_CHALLENGE` (§26.3, §26.12–§26.13), without choosing a provider, a model, or any route-specific normalization/classification authority, and without touching the `TARGETED_PEER_CHALLENGE` identity bridge (§26.5, deliberately deferred to its own later slice).

### 27.1 Three-layer execution authority model (standing principle)

Frozen as the organizing principle for everything below:

1. **Product domain** (`src/stress-test/deliberation.ts` + `session.ts`) — whether a `RouteAttempt` is valid and what terminal facts are legal. Unchanged by this slice.
2. **Execution coordination** — whether one attempt owns exactly one live-call claim, a latency reservation, and a recovery checkpoint. New in this slice, architecture only.
3. **Route adapter** — how one route's specific external mechanism is invoked and its raw result normalized. Remains open (§26.5), not solved here.

No layer substitutes for another. The product domain never performs a live call (see 27.2); the execution-coordination layer never decides route-specific semantic authority (reviewer selection, evidence classification, TPC identity mapping, etc. — all still OPEN per §26.5); the route adapter never bypasses the execution-coordination claim/checkpoint.

### 27.2 Execution ownership — resolves §26.3.A/B

**Frozen:** live external execution MUST NOT occur inside `src/stress-test/deliberation.ts`. That module remains pure/offline product-domain routing and audit state, exactly as every function in it already documents itself (confirmed by direct inspection this packet — `recordRouteAttemptStart`'s own docstring already states the intended ordering: persist the attempt, then "an external mechanism MAY execute in a separately-authorized layer"). Live execution belongs in a separate orchestration/execution-coordination layer, consistent with the repository's own existing precedent that provider calls live in `src/modes/*`/`src/agents/*`, never in `src/stress-test/*` (grounding fact, §26.3).

No final module/filename is chosen in this docs-only slice. This resolves §26.3 open item 1 (execution ownership) as a **layering** decision; the concrete module boundary remains an implementation detail for the runtime slice that follows.

### 27.3 Execution classification — resolves §26.3 scope boundary, restates §26.4

The shared execution envelope defined in this section (§27.4–§27.15) applies only to the four machine-provider routes: `ADD_REVIEWER`, `REPLICATE`, `SEEK_EVIDENCE`, `TARGETED_PEER_CHALLENGE`. `ADD_CONTEXT` remains categorically outside it — its response is human-authored, not model-generated (§26.4, unchanged) — and must not be forced into the shape of a machine executor merely because it shares `RouteAttempt`. `STOP` records no `RouteAttempt`/`RouteOutcome` at all and is likewise out of scope.

### 27.4 Execution identity: `attemptId` — resolves §26.3.C (already closed, restated)

**Frozen:** `RouteAttempt.attemptId` is the executor-facing idempotency key. No second product execution identity (`executionId`, `requestId`, `callId`, `runExecutionId`, `providerAttemptId`, or similar) is introduced. §26.3.C already found no source-of-truth evidence that `attemptId` is insufficient; this slice does not manufacture a need for a second identity. A provider-specific request id may exist transiently as transport metadata (useful for support/debugging), but it is never product authority and is never substituted for `attemptId`.

### 27.5 Identity ≠ de-duplication — resolves §26.3.D (the actual gap)

`attemptId` being the idempotency *key* does not mean duplicate execution is already *prevented*. The existing `ONE RouteDecision → AT MOST ONE RouteAttempt` cardinality (invariants 9–10, already accepted) stops a second `RouteAttempt` record from being created for the same decision; it does nothing to stop two independent executor processes (or one process retrying after an apparent hang) from both initiating an external call for the *same already-persisted* `attemptId`. A live executor therefore requires an **atomic execution claim** distinct from, and layered on top of, the existing ledger cardinality.

### 27.6 Durable execution checkpoint — conceptual record, state machine

**Frozen:** the requirement for a durable execution-coordination record keyed by `attemptId` — conceptually a `RouteExecutionCheckpoint` (name not final). It is:
- **not** owned by `DeliberationState`;
- **not** a second product-outcome ledger — `RouteOutcome` remains the sole authoritative product terminal record (§27.12);
- purpose-scoped to execution coordination, de-duplication, latency reservation, and crash reconciliation only.

Storage technology (database row, transactional table, durable queue, etc.) is explicitly **not chosen here** — an infrastructure choice, not an architecture decision this slice makes.

**Frozen conceptual phases:**

```
UNCLAIMED → CLAIMED → TERMINAL_FACT_READY → OUTCOME_COMMITTED
```

- **UNCLAIMED** need not be physically stored — it is simply the absence of a checkpoint row for an `attemptId`.
- **CLAIMED** — this exact `attemptId` holds exclusive live-execution ownership; no second executor may initiate another external call for it.
- **TERMINAL_FACT_READY** — the external mechanism reached a determinate terminal technical fact, normalized into the route's already-accepted product-domain-ready payload shape (e.g. `TargetedPeerChallengeRouteOutcome`'s field shape minus the envelope) **or** a sanitized `FailureInfo`; it has **not** necessarily been successfully persisted as a `RouteOutcome` yet.
- **OUTCOME_COMMITTED** — `recordRouteOutcome` (or the applicable dedicated domain operation, e.g. a future `ADD_CONTEXT`-shaped one) has successfully persisted the terminal fact.

No automatic backward transition between phases.

### 27.7 Atomic claim requirement — resolves §26.3.D concretely

The `UNCLAIMED → CLAIMED` transition must be atomic with respect to `attemptId`: of two concurrent claimers, exactly one succeeds; the loser MUST NOT call a provider. "Check then insert" without an atomic uniqueness/compare-and-set guarantee does not satisfy this. The concrete mechanism (database uniqueness constraint, transaction, CAS, durable queue semantics) is deferred as an infrastructure choice, not decided here.

**Pre-claim domain check** (does not replace any existing domain validator — additive, execution-coordination-layer only): authoritative session/state binding valid; `attemptId` resolves exactly; the attempt has no `RouteOutcome` yet; the attempt's route is machine-executable (§27.3); state is not `STOPPED`; the route's own already-accepted readiness gate still passes (`assertTargetedPeerChallengeReady`, `SEEK_EVIDENCE`'s three-boundary gate, etc.); finite budget configuration exists (invariant 18, MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md §12); explicit live-execution authorization exists (§27.15).

**Post-claim rule:** once `CLAIMED`, no second executor may launch a second external call for the same `attemptId` merely because no `RouteOutcome` exists yet, the first worker appears slow, a process restarted, or a timeout observer fired. `CLAIMED` is never interpreted as "free to retry." Crash recovery is reconciliation (§27.12), never automatic re-execution.

**Provider-side idempotency** (a provider's own idempotency-key feature, using `attemptId` where compatible) is **defense in depth only** — it does not replace the product execution claim, and the architecture must work correctly even against a provider exposing no such API.

### 27.8 No automatic retry — resolves §26.3.L

**Frozen:** automatic transport/provider retries = **0** for the first live-execution architecture. The execution shell must disable SDK auto-retry where technically supported. A hidden SDK-level retry is, architecturally, an unauthorized additional external execution — it re-calls a provider without a corresponding fresh `RouteDecision`/`RouteAttempt`, silently violating the already-accepted principle (invariant 6; `MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md` §13: "a retry of the very same route that just failed is never automatic; it requires a fresh, independently justified `RouteDecision`").

**Grounded observation (direct inspection this packet, read-only):** `src/providers/claude.ts`, `openai.ts`, and `gemini.ts` construct their SDK clients and call sites today with no `maxRetries`, no timeout, and no `AbortSignal` passed anywhere — a repository-wide search for `maxRetries|timeout|AbortController|signal:` across all three adapters returned zero matches. None of the three currently satisfies this slice's "no automatic retry" or "enforceable deadline" (§27.13) requirements as they stand today; each SDK's own default retry/timeout behavior applies unmodified. This is not a defect to fix here — no `src/**` change is made — but it is a concrete, source-grounded reason none of the three adapters is yet eligible for product live execution under this architecture (§27.14 restates this as a general eligibility rule).

A controlled transport retry, if ever wanted later, requires its own separately authorized architecture redesign — not assumed here.

### 27.9 `FailureInfo` mapping — resolves §26.3.G

Preserves the already-closed, closed vocabulary (`FailureCategory`, confirmed unchanged by direct inspection this packet — `src/stress-test/deliberation.ts:270`): `TRANSPORT | VALIDATION | REFERENCE_RESOLUTION | EXECUTION`. No provider-specific category is added. `FailureInfo.message` remains sanitized, bounded (2000-char cap, `FAILURE_MESSAGE_MAX_CHARS`, confirmed unchanged), human-readable — never a stack trace, header, API key, raw SDK object, or raw provider response.

**Mapping table:**

| Category | Applies when | Examples |
|---|---|---|
| `REFERENCE_RESOLUTION` | An authoritative product reference required for execution cannot be resolved | `targetRef`/`sourceRef` no longer resolves; `EvidenceSubject` cannot resolve; required finding/issue identity missing or ambiguous |
| `TRANSPORT` | The call channel itself failed before a usable response existed | DNS/network/socket/TLS failure; provider request timeout; executor-triggered deadline abort; HTTP 408; HTTP 429 / rate limiting; provider 5xx; SDK transport exception |
| `VALIDATION` | A response was received but cannot be normalized into the already-accepted product-domain terminal-result schema | malformed structured response; missing required normalized fields; unsupported result enum from the route-specific normalizer; citation payload fails `EvidenceCitation` normalization; reviewer output cannot become a valid `ReviewFinding`; TPC response cannot normalize into the accepted payload |
| `EXECUTION` | A determinate executor-layer inability that is neither of the above | missing/invalid provider configuration discovered at execution time; missing credentials; unsupported selected capability/tool; provider/model refuses the requested operation; adapter cannot legally construct its invocation; internal executor failure after domain refs are valid but before a valid route result exists |

**Precedence when multiple conditions exist** — frozen causal order, never "whichever exception was caught last": `REFERENCE_RESOLUTION` (if authoritative identity cannot be established) → `TRANSPORT` (if the channel failed before a usable response existed) → `VALIDATION` (if a response existed but failed the output contract) → `EXECUTION` (other determinate failures). Preferred posture: detect `REFERENCE_RESOLUTION` failures before any provider call — when caught pre-call, provider calls for that attempt execution = 0.

### 27.10 Failure disposition — restates §26.3.F/O/P, no semantic change

If the executor can determinately attribute a failure to the attempt: normalize `FailureInfo` → checkpoint `TERMINAL_FACT_READY` → attempt to persist a generic `FAILED` `RouteOutcome`. A known determinate failure is never left as a silently-open attempt.

If a process disappears while the checkpoint is `CLAIMED` and no durable terminal fact exists, the attempt is **execution-ambiguous**. The executor must NOT infer `FAILED`, infer `SUCCEEDED`, or automatically re-run provider execution. The checkpoint remains `CLAIMED`/ambiguous pending explicit reconciliation — fail-closed, consistent with invariant 22 (open/unterminated attempts are already accepted as auditable, never silently resolved).

### 27.11 Checkpoint-before-commit ordering — resolves §26.3.E/N, §26.8

**Frozen ordering:** external mechanism completes → normalize/sanitize into the route's already-accepted payload shape or sanitized `FailureInfo` → durably persist `TERMINAL_FACT_READY` → **then** attempt `recordRouteOutcome` → `OUTCOME_COMMITTED`.

**Reason:** if the provider call succeeds and the process then crashes before `RouteOutcome` is ever written, the exact normalized fact must remain recoverable without re-calling the provider — this is the reconciliation substrate for §26.8 scenario 1.

**`RouteOutcome` remains authoritative product truth.** The execution checkpoint is not product semantic authority; once `RouteOutcome` is committed, no routing/currentness/`HumanAdjudication` decision may derive product truth from checkpoint state. The checkpoint exists only for de-duplication, crash recovery, persistence reconciliation, and execution audit — never a second competing truth ledger. After commit, checkpoint transitions to `OUTCOME_COMMITTED`; a later implementation may compact/remove the stored normalized payload once audit/recovery requirements permit (retention duration not decided here), but the state transition itself stays auditable.

**Product persistence failure** (`TERMINAL_FACT_READY` reached, but `recordRouteOutcome` rejects or persistence fails — §26.8 scenario 2): keep `TERMINAL_FACT_READY` durably; do not call the provider again; do not fabricate a different payload; do not automatically mutate product state; surface a reconciliation-required state. A future reconciliation operation may retry **only** the product-persistence step using the exact checkpointed normalized fact — it must never re-run external execution.

**Reconciliation validation:** any future persistence-only reconciliation must re-run the same authoritative product validators an ordinary `RouteOutcome` write uses (session/hash binding, attempt provenance, question currentness, route readiness, `EvidenceSubject` integrity, TPC readiness, etc.). A checkpoint created earlier does not bypass current-state validation; if current state makes the previously-normalized fact no longer legal, reconciliation fails closed rather than force-writing a stale fact.

**No automatic reconciliation** is introduced by this slice — no background automatic retry, automatic provider replay, or automatic outcome force-write. This slice freezes the recovery substrate/policy only; trigger/UI/operator policy for reconciliation remains a later implementation decision (§26.8's "reconciliation *process*" gap is narrowed to a frozen *policy*, not yet an implemented *process*).

### 27.12 Latency contract — resolves §26.3.H/I/J, §26.9

**Unit and measurement window (resolves H):** `latencyConsumed` unit is frozen as **milliseconds**, measured with a monotonic clock (not `Date.now` subtraction, when a monotonic elapsed-time API is available). The window runs from immediately before the first external side effect (the provider call) through the point a normalized terminal fact — success or failure — has been produced, including the route-specific normalization/classification work required to obtain that fact. Excluded: pre-call eligibility/ref validation, durable claim acquisition, post-terminal `RouteOutcome` persistence, and later `QuestionDisposition`. `latencyConsumed` remains, as already accepted, an **observed execution fact** — never truncated, clamped to remaining budget, replaced with the configured limit, or estimated.

**Admission (partially resolves J):** before `CLAIMED` transitions into an actual external call, the executor computes `remainingLatency = latencyBudget.ceiling - latencyBudget.spent - other durable in-flight reservations`, and requires `remainingLatency > 0`. No live call begins otherwise.

**Explicit per-call limit (resolves J):** every provider-backed live execution must receive an explicit, finite `latencyLimitMs` from live-execution policy/configuration — no numeric default is frozen here, and a missing value means the call is **not authorized**, never "unlimited." Required: `latencyLimitMs > 0` and `latencyLimitMs <= remainingLatency`. The executor durably reserves `latencyLimitMs` in the checkpoint before the provider call — this is an authorization ceiling, not a prediction of actual latency.

**Reservation:** across one `DeliberationState`, `spent + durable active reservations` must never exceed `latencyBudget.ceiling`. Atomic reservation is required once concurrent machine executions are ever allowed; a first implementation MAY serialize provider-backed execution per `DeliberationState` if that materially simplifies correctness — concurrency is not required by this slice.

**Provider deadline (resolves I, partially):** the external adapter MUST support an enforceable deadline/abort bounded by `latencyLimitMs`. A candidate provider/adapter that cannot expose a bounded execution mechanism is **not eligible** for product live execution under this architecture — no provider is selected by this rule, but §27.8's grounded observation already shows none of the three current adapters yet exposes one.

**Normal reconciliation:** on a terminal fact with `actualLatencyMs <= reserved latencyLimitMs`, release the reservation and charge `actualLatencyMs` through the existing latency accounting (`applyLatencySpend`) when `RouteOutcome` is persisted. Unused reservation returns to available budget. No logical-cost re-charge (§27.13 preserves `CostBudget` unchanged).

**Deadline timeout:** when the deadline is reached, abort/cancel the external call, normalize `FailureInfo.category = TRANSPORT` with a sanitized timeout message, and produce a terminal technical failure. Observed latency remains the actually measured value, never guessed from the configured limit.

**Overrun — execution-shell contract violation (resolves I/the §26.9 race, decisively):** if an adapter returns control with `actualLatencyMs > latencyLimitMs` despite the required deadline, this is an **execution-shell contract violation**, not a normal outcome. The executor must NOT clamp the latency, fabricate a legal `RouteOutcome`, or silently exceed the product's `LatencyBudget`. It persists the observed fact in the execution checkpoint and surfaces **reconciliation/operator-attention-required** — no provider replay. Such an adapter is not eligible for continued production execution until the breach is understood. This resolves §26.9's race by removing the *legal option* that was previously missing (fabricate vs. leave permanently open): the reservation-and-deadline discipline above (admission + per-call limit + enforced provider deadline) is designed so a legally-recordable `actualLatencyMs <= latencyLimitMs <= remainingLatency` is the expected path, and an adapter that still overruns its own enforced deadline is treated as a contract violation requiring operator attention, not a silent ledger failure — truth (the real observed latency) is preserved either way, never fabricated.

### 27.13 Cost budget — unchanged

`CostBudget` is not redesigned. `logicalCost` remains charged exactly once, at `RouteAttempt` start (`applyCostSpend`, a fixed route-determined integer via `logicalAttemptCostForRoute` — confirmed unchanged by direct inspection this packet). The live executor MUST NOT charge logical cost again. No provider-dollar/token accounting is introduced.

### 27.14 Explicit live-execution authorization — resolves §26.3.Q

**Frozen:** finite `CostBudget`/`LatencyBudget` configuration (invariant 18, already accepted) is **necessary but not sufficient** to authorize live execution. A future execution shell must additionally require an explicit **live-execution enablement policy**, absent/disabled by default, authorizing at minimum (a) Stress Test live execution generally and (b) the specific route. Provider/model selection authority remains separate and still **OPEN** (§26.3.K, unchanged). No execution occurs while live authorization is absent. This session's own GPT packet-governance authorization is not the runtime product mechanism — it authorizes this documentation packet, not a running system's live calls.

**Live authorization ≠ human revision authority:** live-execution authorization means only "this external route mechanism may execute." It never grants `HumanAdjudication`/`ACTION_CHANGE = YES`/`RevisionAction` authority, which remains unchanged (Slice 1, unaffected).

### 27.15 Remaining open by design — not solved here

Provider/model selection (Claude/OpenAI/Gemini, specific models, registry role) is **not chosen** in this slice — it closes the envelope, not selection authority; each route-specific execution slice still decides what capability it needs. Route-specific normalization/classification (`ADD_REVIEWER` raw-output→`ReviewFinding`; `REPLICATE` result classification; `SEEK_EVIDENCE` query/retrieval/citation normalization; TPC's identity bridge and response classification) is likewise not solved — the common shell accepts route-specific adapter functions conceptually (§27.1 layer 3), but their authority is defined later, per route. `ADD_CONTEXT`'s human-response capture surface (§26.4) is unaffected and remains its own, separate, non-execution open item.

### 27.16 Required failure matrix

| Condition | Provider call made? | Failure category | Checkpoint terminal fact? | `RouteOutcome` | Automatic retry? |
|---|---|---|---|---|---|
| Unknown product ref (pre-call) | No | `REFERENCE_RESOLUTION` | Yes (`FailureInfo`) | `FAILED` | No |
| Missing provider config | No | `EXECUTION` | Yes (`FailureInfo`) | `FAILED` | No |
| Network/DNS/TLS failure | Attempted | `TRANSPORT` | Yes (`FailureInfo`) | `FAILED` | No |
| Timeout/deadline reached | Yes (aborted) | `TRANSPORT` | Yes (`FailureInfo`) | `FAILED` | No |
| HTTP 429 | Yes | `TRANSPORT` | Yes (`FailureInfo`) | `FAILED` | No |
| HTTP 5xx | Yes | `TRANSPORT` | Yes (`FailureInfo`) | `FAILED` | No |
| Provider refusal | Yes | `EXECUTION` | Yes (`FailureInfo`) | `FAILED` | No |
| Malformed response | Yes | `VALIDATION` | Yes (`FailureInfo`) | `FAILED` | No |
| Normalizer schema failure | Yes | `VALIDATION` | Yes (`FailureInfo`) | `FAILED` | No |
| Process crash while `CLAIMED`, no terminal fact | Unknown | — (ambiguous) | No | None (stays open) | No — fails closed, reconciliation-pending |
| Result normalized but `RouteOutcome` persistence fails | Yes | N/A (success path) | Yes (normalized success payload) | Not yet committed — persistence-reconciliation pending | No — never re-run external execution |
| Latency deadline contract overrun | Yes | N/A (success/failure path with overrun) | Yes, flagged reconciliation/operator-attention-required | Not committed pending resolution | No |

### 27.17 Required state flow

```
RouteAttempt already persisted (recordRouteAttemptStart, existing runtime)
  ↓
live-execution authorization + eligibility check (§27.14, §27.7 pre-claim check)
  ↓
atomic CLAIMED(attemptId)                                  (§27.6, §27.7)
  ↓
latency admission + reservation (latencyLimitMs)            (§27.12)
  ↓
external route adapter call, bounded by provider deadline   (§27.1 layer 3, §27.12)
  ↓
normalized terminal fact (success payload or FailureInfo)   (§27.9, §27.10)
  ↓
durable TERMINAL_FACT_READY                                 (§27.6, §27.11)
  ↓
recordRouteOutcome (existing runtime, re-validated)          (§27.11)
  ↓
OUTCOME_COMMITTED                                            (§27.6, §27.11)
```

**Crash/reconciliation branches:**
- Crash while `CLAIMED`, no terminal fact yet → checkpoint stays `CLAIMED`/ambiguous, fail-closed, no inference, no auto-rerun (§27.10, §27.7).
- Terminal fact reached (`TERMINAL_FACT_READY`) but `recordRouteOutcome` rejects or persistence fails → checkpoint stays `TERMINAL_FACT_READY`, no provider replay, reconciliation-required surfaced; a future persistence-only reconciliation re-validates against current authoritative state before writing (§27.11).
- Deadline enforced but adapter still overruns it → contract-violation path, observed latency preserved, no clamp/fabrication, operator attention required, no replay (§27.12).

### 27.18 Governance backlink check (Slice 2D-D1-0)

This section changes no offline/domain implementation status. §25 is unaffected by this slice: `RouteOutcome`/`RouteAttempt`/`QuestionDisposition` runtime status lines above remain exactly as the Slice 2D-D0 packet left them, and the two **NOT AUTHORIZED** lines ("Provider-backed route execution," "Route execution generally...") remain **NOT AUTHORIZED** — this slice adds architecture/authorization posture only and marks no execution runtime, idempotency mechanism, or latency-reservation mechanism as implemented. A search of this section's own prose for language that could be misread as "provider execution now ready," "latency race already implemented," or "idempotency already implemented" found none requiring correction; §27.19 states the negative runtime consequence explicitly to foreclose that misreading.

### 27.19 Runtime consequence — explicit, not implied

The current domain runtime (`src/stress-test/deliberation.ts`, `applyLatencySpend`, confirmed unchanged by direct inspection this packet — still throws if `spent + amount > ceiling`, still charged only at terminal-outcome time) does **not yet** model in-flight latency reservations, atomic execution claims, or an execution checkpoint of any kind. This section documents and freezes the architecture and policy for those mechanisms; it does not implement them. **Provider-backed route execution therefore remains NOT AUTHORIZED** until a later runtime slice implements the accepted reservation/admission/claim/checkpoint contract above. Documentation alone does not resolve the `LatencyBudget` race described in §26.9 — only a runtime slice that actually implements admission (§27.12) does.

### 27.20 Common execution-layer decisions — closed vs. still open after this freeze

**Closed or materially resolved by this slice (10):**
1. Execution ownership — layering resolved (§27.2); concrete module boundary deferred to implementation.
2. Live-call idempotency/de-duplication — resolved via the atomic execution claim (§27.5, §27.7).
3. Success-but-persistence-fails reconciliation — policy resolved (§27.11); process/trigger/UI deferred.
4. `FailureInfo` category mapping table — resolved (§27.9).
5. `latencyConsumed` measurement definition and units — resolved (§27.12).
6. `LatencyBudget` vs. an external call of unknowable duration — resolved via admission + reservation + enforced deadline + fail-closed overrun policy (§27.12).
7. Pre-call latency reservation mechanism — resolved conceptually (§27.12); storage technology deferred.
8. Transport-retry vs. logical-`RouteAttempt`-retry enforcement point — resolved: zero automatic transport retries, enforced by the execution shell (§27.8).
9. External-side-effect/local-ledger atomicity/reconciliation contract — resolved as policy (§27.11, §27.17); no automatic mechanism implemented.
10. Dedicated live-execution authorization boundary — resolved: invariant 18 alone is insufficient; a separate live-execution enablement policy is required (§27.14).

**Still open after this freeze (1):**
- Product-domain provider/model selection authority (§26.3.K) — explicitly out of scope for this slice (§27.15); remains for a later, dedicated slice.

Common execution-layer open-decision count: **11 → 1** after this freeze (10 resolved as architecture/policy; the remaining 1 — provider/model selection authority — was always out of scope for an "envelope" slice by the packet's own design, §26.13).

### 27.21 Route-specific decisions — unchanged

Direct source inspection this packet (`deliberation.ts`'s `RouteAttempt`/`RouteOutcome`/`FailureInfo`/budget functions, `src/providers/*`) found nothing contradicting the Slice 2D-D0 route-specific inventory. Counts are unchanged: `ADD_CONTEXT` 1, `ADD_REVIEWER` 5, `REPLICATE` 3, `SEEK_EVIDENCE` 5, `TARGETED_PEER_CHALLENGE` 7 — **21 total**, exactly as §26.14 recorded. This slice resolves none of them; none was in scope (§27.15).

### 27.22 Recommended next architecture slice

**Recommended: `SLICE 2D-D1-A` — EXECUTION COORDINATION / CLAIM / LATENCY RESERVATION OFFLINE RUNTIME.**

This slice's own freeze (§27.6–§27.14) is now a complete, internally consistent architecture for the execution checkpoint, the atomic claim, and the latency-reservation/admission contract — entirely independent of any specific provider. The natural next step is to **implement that architecture offline** (the checkpoint state machine, the atomic claim primitive, the latency admission/reservation bookkeeping) **without any provider call**, exactly mirroring how `RouteAttempt`/`RouteOutcome` themselves were built and fully tested offline (Slice 2D-B0/B1) long before any route's successful-result semantics were designed. This closes the runtime gap named in §27.19 and gives every future route-specific execution slice (reviewer normalization, retrieval integration, TPC identity bridge, etc.) a tested, working coordination substrate to build on, rather than each one having to first invent its own ad hoc claim/reservation logic. No missing common-schema prerequisite was surfaced during this freeze that would redirect the recommendation elsewhere.

---

## 28. Execution checkpoint schema & atomic claim/reservation API freeze (Slice 2D-D1-A0)

Architecture documentation only. **No `src/**`, test, or `package.json` change is made by this section or this packet; no execution checkpoint is implemented; no provider/model is called.** §27 (Slice 2D-D1-0) remains fully authoritative and is not reopened — `attemptId` as the sole idempotency key, execution living outside `DeliberationState`, zero automatic retries, the `FailureInfo` vocabulary, checkpoint-before-`RouteOutcome` ordering, millisecond monotonic latency, explicit finite `latencyLimitMs`, latency reservation, the provider-deadline requirement, live execution disabled by default, and the three-layer authority model are all unchanged. This section translates that accepted policy into an exact, implementable schema and API contract, closing the specific sequencing gap D1-0 left open (§27.12's claim → admission → call ordering did not yet say what happens when admission itself fails) and freezing everything a runtime implementer would otherwise have to invent ad hoc.

**Status: DOCUMENTED / NOT YET ACCEPTED.** Two schema inconsistencies found in remote review of the original freeze were corrected in place by the Slice 2D-D1-A0 amendment (never implemented, so corrected directly rather than via this document's append-only historical-correction convention, which applies only to already-accepted slices): (1) the reservation-vs-`RouteOutcome` handoff double-counted latency capacity between outcome persistence and checkpoint acknowledgement — corrected via the derived `effectiveLatencyEncumbrance` concept, §28.11/§28.12; (2) the admission-rejection shape required a `latencyLimitMs` field even when the defect *was* a missing/invalid limit — corrected by splitting `TERMINAL_FACT_READY` into `ReservedTerminalFactReadyCheckpoint`/`AdmissionRejectedTerminalFactReadyCheckpoint`, §28.13. Affected subsections are marked "*corrected by the Slice 2D-D1-A0 amendment*" inline.

**Grounding, confirmed by direct inspection this packet:** `DeliberationState` (`src/stress-test/deliberation.ts:583`) carries its own identity as `id` (not `deliberationStateId`) plus `sessionId`, `artifactHash`, `authorContextHash`, `latencyBudget: DeliberationBudget` (`{ spent, ceiling }`, `deliberation.ts:571`). `RouteAttempt` (`deliberation.ts:245`) already carries `attemptId`, `decisionId`, `questionId`, `route`, `sessionId`, `artifactHash`, `authorContextHash`, `startedAt`, `logicalCost` — every product-truth field a checkpoint could want is already resolvable from the attempt itself once the owning `DeliberationState` is known. `recordRouteOutcome` (`deliberation.ts:1797`) already enforces "one attempt has at most one outcome" as its own precondition, confirmed by direct read. A repository-wide search for `interface.*Store|interface.*Repository|class.*Store|class.*Repository|Port\b` under `src/` returned **zero matches** — no persistence/store abstraction exists anywhere in the repository today; this section's store-port contract (§28.3) is a genuinely new architecture surface, not a fit against an existing convention.

### 28.1 Exact checkpoint entity

**Frozen name:** `RouteExecutionCheckpoint`. **Identity:** `attemptId` — the same `RouteAttempt.attemptId` already frozen as the sole executor-facing idempotency key (§27.4). No second identity (`checkpointId`, `executionId`, `callId`, `requestId`) is introduced.

### 28.2 Checkpoint ownership

The checkpoint is **not** a field on `DeliberationState` and **not** a field on `StressTestSession` — it belongs to the execution-coordination layer (§27.1 layer 2). **Frozen conceptual owner:** a `RouteExecutionCheckpointStore` (or equivalent durable-store port) supporting lookup and atomic mutation by `attemptId`. No concrete storage technology is chosen (§28.23 makes this distinction explicit).

### 28.3 Parent binding and non-duplication

**Frozen:** the checkpoint stores `deliberationStateId` (the owning `DeliberationState.id`) as a binding key — required so the coordination layer can prove which state owns the attempt and aggregate active reservations scoped to it (§28.12). This is a parent/binding key, **not** a second execution identity.

`sessionId`, `artifactHash`, and `authorContextHash` are **not** duplicated onto the checkpoint. Default posture (per this packet's own §8 instruction) is not to copy product truth that coordination integrity does not need: every operation that needs those values resolves the authoritative `RouteAttempt` (which already carries them, confirmed above) via `deliberationState.attempts.find(a => a.attemptId === attemptId)` after resolving `deliberationState` by `deliberationStateId`. Re-resolution, not duplication, is the frozen rule.

### 28.4 Route binding

**Frozen:** the checkpoint stores `route` as an immutable copied coordination/audit binding, set once at claim time and never mutated. It must always equal the authoritative `RouteAttempt.route` — read integrity (§28.20) verifies this on every read; it is **never** independently authoritative, and a mismatch is an integrity violation, not a source of truth to reconcile toward. No copy of `RouteDecision`, `UnresolvedQuestion`, `ReviewFinding`, or `SemanticIssue` is stored on the checkpoint.

### 28.5 Exact phase union

**Frozen discriminated union**, discriminant field `phase`:

```
RouteExecutionCheckpoint =
  | ClaimedCheckpoint            (phase: 'CLAIMED')
  | TerminalFactReadyCheckpoint  (phase: 'TERMINAL_FACT_READY')
  | OutcomeCommittedCheckpoint   (phase: 'OUTCOME_COMMITTED')
```

`UNCLAIMED` remains the absence of any stored record for an `attemptId` — never a fourth union member. No generic mutable `status: string` shape is used; each phase's TypeScript shape exposes only the fields legal at that lifecycle point (illegal-field combinations are unrepresentable, not merely unchecked). No backward transition exists in the union (nothing transitions a `TerminalFactReadyCheckpoint` back into a `ClaimedCheckpoint`, etc.).

### 28.6 `CLAIMED` — minimum fields

```
ClaimedCheckpoint {
  phase: 'CLAIMED';
  attemptId: string;
  deliberationStateId: string;
  route: NonStopDeliberationRoute;
  claimedAt: string;          // ISO timestamp, parseable
  latencyLimitMs: number;     // finite integer > 0
  reservedLatencyMs: number;  // finite integer > 0
}
```

**Invariant:** `reservedLatencyMs === latencyLimitMs` for every `ClaimedCheckpoint` that is externally observable to a caller (§28.7 — a checkpoint that never reaches this state because admission failed is not a `ClaimedCheckpoint` at all). No provider/model identity, no secret, no raw payload field exists at this phase.

### 28.7 Claim + reservation as one coordination transaction — closes the ordering gap (§27.12)

**Frozen:** `claimRouteExecution` performs the atomic ownership claim and the latency admission/reservation check as **one coordination transaction**, not two separately-observable steps. The transaction may pass through `CLAIMED` internally, but **no provider-call-authorized `ClaimedCheckpoint` is ever returned to a caller unless its latency reservation has already succeeded** as part of the same transaction. This is the exact, chosen resolution to the gap this packet's §12 identified: D1-0 said "atomic CLAIMED → latency admission/reservation → provider call" without saying what happens when admission fails; A0 collapses claim-and-admission into one atomic step so that "admission fails" and "claim fails" produce the same observable result to the caller — no provider-call-authorized state is ever exposed in either case.

### 28.8 No-call admission failure — exact representation (§27.12's race, made mechanical) — *corrected by the Slice 2D-D1-A0 amendment*

**Amendment note:** the shape below replaces the amendment-superseded version of this subsection, which required a `latencyLimitMs` field on the rejection record even when the defect *was* a missing or malformed `latencyLimitMs` — an unrepresentable requirement that would have forced either fabricating a value or persisting a malformed raw one. Corrected by introducing a dedicated subtype (§28.13) with no `latencyLimitMs` field at all.

**Frozen:** when ownership can be claimed but the latency reservation cannot legally be granted, the transaction produces, atomically and directly, an `AdmissionRejectedTerminalFactReadyCheckpoint` (§28.13) — **never** a `latencyLimitMs`-bearing record, regardless of cause:

```
AdmissionRejectedTerminalFactReadyCheckpoint {
  phase: 'TERMINAL_FACT_READY';
  attemptId; deliberationStateId; route; claimedAt;
  reservedLatencyMs: 0;                   // never fabricated — no reservation was ever held
  terminalFactReadyAt: claimedAt;         // same instant — no time was spent attempting a call
  terminalFact: {
    kind: 'FAILED';
    failure: { category: 'EXECUTION', message: '<sanitized, cause-specific — §28.9>' };
    actualLatencyMs: 0;
  };
}
```

No `latencyLimitMs` field exists on this shape at all — not the caller's malformed input, not a fabricated replacement (§28.13 makes this the structural discriminant distinguishing this subtype from an ordinary executed one). No `ClaimedCheckpoint` reaches an external caller in this path. Provider calls = 0. `actualLatencyMs` = 0 (no fabrication — no external work was ever attempted). **Category: `EXECUTION`** — chosen because product references are valid, no transport call was attempted (ruling out `TRANSPORT`), no external response exists to validate (ruling out `VALIDATION`), and no reference-resolution failure occurred (ruling out `REFERENCE_RESOLUTION`); what failed is execution *policy* itself being unable to legally admit the operation, which is exactly `EXECUTION`'s definition in the already-frozen mapping (§27.9). No new `FailureCategory` is invented.

### 28.9 Three admission-rejection causes — all normalize to the same shape

Exactly three causes reach the `AdmissionRejectedTerminalFactReadyCheckpoint` shape (§28.8), all occurring strictly before any provider call, all normalizing to `FailureInfo.category = 'EXECUTION'`, distinguished only by `FailureInfo.message` wording — never a second category, never a provider-specific one:

1. **Missing or invalid `latencyLimitMs`** (missing, non-number, `NaN`, `Infinity`, `<= 0`, fractional) — a configuration/policy defect. The malformed raw value is never stored anywhere on the checkpoint; no replacement value is fabricated.
2. **Structurally valid `latencyLimitMs` but insufficient remaining reservable budget** — a legitimate admission failure against `remainingLatency` (§27.12's formula). The checkpoint MAY optionally retain the originally-requested value for sanitized audit purposes as `requestedLatencyLimitMs` on the rejection record — but this freeze does not introduce that field: no concrete need for it was demonstrated by inspection this packet, and the smaller design (omit it) is preferred per this packet's own instruction (§14) until a future packet demonstrates otherwise. If ever introduced, it must be finite, positive, integer, request/audit data only, and never interpreted as a reservation or counted in any budget sum.
3. **An unresolved `DEADLINE_VIOLATION` checkpoint already exists for this `deliberationStateId`** (§28.14's claim-blocking rule) — the execution shell has already observed a deadline-contract violation on this `DeliberationState` and must not admit a further provider-backed claim against it until that violation is separately reconciled.

### 28.10 Atomicity of claim + reservation

**Frozen (Option A, general contract):** the atomic claim-and-reservation transaction (§28.7) is a property of the `RouteExecutionCheckpointStore` itself — two concurrent `claimRouteExecution` calls against the same `deliberationStateId` (whether for the same or different `attemptId`s) must never both succeed by reading the same stale `remainingLatency` value. A first implementation MAY satisfy this by serializing provider-backed execution per `DeliberationState` (Option B as a valid *implementation strategy* of Option A's contract, per D1-0 §27.12's own allowance) — but the store's public contract is Option A regardless of which internal strategy a given implementation uses; a future concurrent implementation must not require a contract change, only a strategy change.

### 28.11 Reservation aggregation — effective encumbrance, not raw reservation — *corrected by the Slice 2D-D1-A0 amendment*

**Amendment note (the contradiction found in remote review, recorded precisely):** the amendment-superseded version of this subsection held a checkpoint's *full* `reservedLatencyMs` active throughout `TERMINAL_FACT_READY`, released only at `OUTCOME_COMMITTED`. But `recordRouteOutcome` (a separate call, against a separate aggregate, §27.11) charges `actualLatencyMs` into `deliberationState.latencyBudget.spent` *before* `markExecutionOutcomeCommitted` ever runs — the two cannot occur in one physical transaction (§27.11, unchanged). Between those two calls, the superseded rule counted the same latency cost **twice**: once already landed in `spent`, once still fully reserved. Example, exactly as identified: ceiling 100, reservation A 60, reservation B 40, A's actual latency 50 — after A's `RouteOutcome` persists but before A's checkpoint is acknowledged, the superseded equation reads `spent(50) + reservedA(60) + reservedB(40) = 150 > ceiling`, an apparent overrun even though nothing is actually oversubscribed. This is a defect in the accounting formula, not evidence of corrupt state, and it is corrected below without treating the two cross-layer operations as one transaction.

**Frozen replacement concept — `effectiveLatencyEncumbrance`:** a *derived*, read-time-computed value (never a stored, mutated field — `reservedLatencyMs` itself is never rewritten to account for this), computed by joining one checkpoint against the authoritative `DeliberationState.outcomes`:

- **`CLAIMED`:** `effectiveLatencyEncumbrance = reservedLatencyMs`.
- **`TERMINAL_FACT_READY` (`ReservedTerminalFactReadyCheckpoint`, §28.13), no matching `RouteOutcome` yet for this `attemptId`:** `effectiveLatencyEncumbrance = reservedLatencyMs` (full — the true cost has landed nowhere yet).
- **`TERMINAL_FACT_READY` (`ReservedTerminalFactReadyCheckpoint`), exactly one authoritative `RouteOutcome` already persisted for this `attemptId`, with `route` agreeing and `outcome.latencyConsumed === terminalFact.actualLatencyMs`:** `effectiveLatencyEncumbrance = reservedLatencyMs - terminalFact.actualLatencyMs` (the **residual** — required invariant `0 <= effectiveLatencyEncumbrance <= reservedLatencyMs`, since `actualLatencyMs <= reservedLatencyMs` always holds for a committable terminal fact, EC-9). If no exact matching outcome exists — wrong `attemptId`, disagreeing `route`, or disagreeing `latencyConsumed` — this residual reduction **never** applies; the checkpoint's full `reservedLatencyMs` remains encumbered. No heuristic, no "latest outcome," no first-match behavior.
- **`TERMINAL_FACT_READY` (`AdmissionRejectedTerminalFactReadyCheckpoint`, §28.8/§28.13):** `effectiveLatencyEncumbrance = 0` (`reservedLatencyMs` is already `0` by construction).
- **`OUTCOME_COMMITTED`:** `effectiveLatencyEncumbrance = 0` (the cost is now exclusively carried by `deliberationState.latencyBudget.spent`; continuing to encumber anything would double-count capacity already spent).

**Frozen global invariant, for one `deliberationStateId`, replacing the amendment-superseded raw-sum formula:**

```
authoritative deliberationState.latencyBudget.spent
  + SUM(effectiveLatencyEncumbrance(checkpoint, deliberationState) for every checkpoint of this deliberationStateId)
  <= authoritative deliberationState.latencyBudget.ceiling
```

Re-running the worked example under the corrected formula: before A's outcome, `spent(0) + effective_A(60) + effective_B(40) = 100`. After A's `RouteOutcome` persists but before A's checkpoint is acknowledged: `spent(50) + effective_A(60-50=10) + effective_B(40) = 100` — unchanged, no overrun, no double-count. After A's acknowledgement (`OUTCOME_COMMITTED`): `spent(50) + effective_A(0) + effective_B(40) = 90`. The combined contribution of any single attempt is exactly `reservedLatencyMs` at every instant, split between `spent` and `effectiveLatencyEncumbrance` in different proportions as it moves through its lifecycle, never double-counted and never dropped.

### 28.12 Reservation release point — no double-spend and no double-count window (resolves §27.12/amendment §5–§9)

**Frozen resolution:** no reservation is ever fully "released" at a single instant in the amendment-superseded sense. Instead, the moment an authoritative matching `RouteOutcome` lands (per §28.11's residual rule), the checkpoint's *effective* encumbrance drops from `reservedLatencyMs` to the residual `reservedLatencyMs - actualLatencyMs` **automatically**, as a consequence of it being a derived read-time value — no separate write, no race, no second transaction is needed to make this happen, because `effectiveLatencyEncumbrance` is computed fresh from current authoritative state (`deliberationState.outcomes`) every time it is read (at a new claim's admission check, or at a read-integrity check, §28.20). The residual then drops to zero only at the checkpoint's own successful `TERMINAL_FACT_READY → OUTCOME_COMMITTED` transition (§28.19), at which point the cost is carried exclusively by `deliberationState.latencyBudget.spent`.

At every instant, an attempt's true latency cost is accounted for by **exactly** `spent`'s own contribution (0 before the outcome lands, `actualLatencyMs` after) **plus** the checkpoint's `effectiveLatencyEncumbrance` (full before the outcome lands, residual after it lands and before acknowledgement, zero after acknowledgement) — and this sum is invariantly `reservedLatencyMs` for as long as the checkpoint exists in `TERMINAL_FACT_READY`, then `actualLatencyMs` alone once `OUTCOME_COMMITTED`. No transient window exists in which capacity is simultaneously free-to-reserve-elsewhere and not yet truly spent (the double-spend `§18`/`§19` forbid), and no transient window exists in which the same cost is counted in both `spent` and a checkpoint's *full* reservation simultaneously (the double-count this amendment corrects).

A `ReservedTerminalFactReadyCheckpoint` whose `recordRouteOutcome` persistence fails (D1-0 §27.11's "product persistence failure" scenario) correctly retains its **full** `reservedLatencyMs` as its effective encumbrance under this rule — no matching outcome exists yet, so §28.11's residual reduction never applies, exactly the outcome needed since the true cost has not landed anywhere.

### 28.13 `TERMINAL_FACT_READY` — exact shape split and terminal-fact representation — *corrected by the Slice 2D-D1-A0 amendment*

**Amendment note:** the amendment-superseded version of this subsection used one undifferentiated `TerminalFactReadyCheckpoint` shape requiring `latencyLimitMs` unconditionally — unrepresentable for the admission-rejected case (§28.8), whose entire point is that no legal `latencyLimitMs` was ever admitted. Corrected by splitting `TERMINAL_FACT_READY` into two phase-compatible subtypes, structurally discriminated by the presence or absence of `latencyLimitMs` (never a separate phase — `phase` remains `'TERMINAL_FACT_READY'` on both):

```
TerminalFactReadyCheckpoint =
  | ReservedTerminalFactReadyCheckpoint
  | AdmissionRejectedTerminalFactReadyCheckpoint

ReservedTerminalFactReadyCheckpoint {
  phase: 'TERMINAL_FACT_READY';
  attemptId; deliberationStateId; route; claimedAt;
  latencyLimitMs: number;     // finite integer > 0 — carried forward from the CLAIMED record
  reservedLatencyMs: number;  // finite integer > 0; === latencyLimitMs
  terminalFactReadyAt: string;
  terminalFact: ReservedTerminalFact;
}

AdmissionRejectedTerminalFactReadyCheckpoint {
  phase: 'TERMINAL_FACT_READY';
  attemptId; deliberationStateId; route; claimedAt;
  reservedLatencyMs: 0;       // never fabricated; no latencyLimitMs field exists on this shape at all
  terminalFactReadyAt: string; // === claimedAt
  terminalFact: { kind: 'FAILED'; actualLatencyMs: 0; failure: FailureInfo };  // category always EXECUTION, §28.9
}

ReservedTerminalFact =
  | { kind: 'SUCCEEDED'; actualLatencyMs: number; payload: RouteSpecificSuccessPayload }
  | { kind: 'FAILED';    actualLatencyMs: number; failure: FailureInfo }
  | { kind: 'DEADLINE_VIOLATION'; actualLatencyMs: number }  // > the checkpoint's own latencyLimitMs; never committable, §28.14
```

Every `ReservedTerminalFactReadyCheckpoint` is reachable only via `CLAIMED → recordExecutionTerminalFact` (§28.17) — it always carries a real `latencyLimitMs`/`reservedLatencyMs` pair from a successful claim. Every `AdmissionRejectedTerminalFactReadyCheckpoint` is reachable only directly from `claimRouteExecution`'s own atomic admission-rejection path (§28.8) — `recordExecutionTerminalFact` can never produce one (§28.17). No malformed or fabricated `latencyLimitMs` value is ever stored on either shape.

**`RouteSpecificSuccessPayload` — frozen design (resolves §27.20/§27.23, Option A chosen over Option B):** the smallest design satisfying every listed constraint is to reuse, verbatim, the already-accepted route-specific portion of `RecordRouteOutcomeInput` for `attempt.route` — i.e., every field `recordRouteOutcome` already accepts for that route (`result`, `targetRef`, `sourceRef`, `boundedExcerpt`, `response`, `citation`, etc., per route) **except** `attemptId`, `status`, and `latencyConsumed`, which the checkpoint already tracks independently (`attemptId` as identity, `status` implied by `TerminalFact.kind`, `actualLatencyMs` as the checkpoint's own field). This is deliberately **not** a new type — it is a structural subset of a type this document has already closed per route (§25). Choosing it over a generic `raw: unknown`/`providerResponse: unknown`/`metadata: Record<string, unknown>` escape hatch (explicitly forbidden by this packet's §20) means: raw provider data is excluded **by construction**, because the reused types were already independently confirmed (Slice 2D-D0, §26.10) to have no field capable of holding such data; no second semantic authority is created, because committing this payload later is simply *replaying the same object* into the same `recordRouteOutcome` that would already accept it directly; and no route-specific normalization/classification authority is preempted, because this only fixes the *shape* of what a future route adapter must produce — it says nothing about *who* produces it or *how* (§26.5's open items are untouched).

**`FailureInfo` terminal fact** — reuses the already-closed `FailureInfo` type verbatim (§27.9); no duplication of `sessionId`/`artifactHash`/`authorContextHash`/`logicalCost`, all of which remain authoritative on the re-resolved `RouteAttempt` (§28.3) and are re-derived, never re-supplied, at commit time (§28.19).

### 28.14 Deadline-violation representation — non-committable, no phase expansion; blocks future claims on the same state

**Frozen:** a deadline-contract-violation (D1-0 §27.12's `actualLatencyMs > latencyLimitMs` case) is represented as the `DEADLINE_VIOLATION` terminal-fact subtype **within** a `ReservedTerminalFactReadyCheckpoint` (§28.13) — no new checkpoint phase is added, per this packet's own preference. It remains fully recoverable/auditable in the execution-coordination store, its effective encumbrance remains the **full** `reservedLatencyMs` (§28.11 — no matching `RouteOutcome` is ever legal for it, so the residual-reduction rule never applies; its `actualLatencyMs > reservedLatencyMs` is precisely the fact operator attention must see, and is never clamped or hidden), and it is **permanently non-committable**: `markExecutionOutcomeCommitted` (§28.19) must reject any transition attempt where `terminalFact.kind === 'DEADLINE_VIOLATION'`, unconditionally — there is no path by which a deadline-violation record ever becomes `OUTCOME_COMMITTED`. No provider replay; no product `RouteOutcome` force-write.

**Deadline violation blocks future machine claims on the same `DeliberationState` (new execution-safety consequence, already implied by D1-0, closed explicitly by this amendment):** if any `deliberationStateId` has an unresolved `DEADLINE_VIOLATION` checkpoint (one that has not been separately reconciled by a later-designed operator process — not defined here), every subsequent `claimRouteExecution` call against that same `deliberationStateId` MUST fail closed via the ordinary admission-rejection path (§28.8/§28.9, cause 3) — never a `ClaimedCheckpoint`. Reason: the execution shell has already observed, for this state, at least one case where true measured latency exceeded its authorized reservation; continuing to admit further provider-backed claims against the same state's budget as if it remained normally trustworthy would risk compounding an already-unreconciled overrun. This creates no new product-semantic truth — it is a coordination-layer safety gate only, and it never mutates or force-resolves the underlying `DEADLINE_VIOLATION` record. No automatic repair is introduced.

### 28.15 `OUTCOME_COMMITTED` — minimum fields

```
OutcomeCommittedCheckpoint {
  phase: 'OUTCOME_COMMITTED';
  attemptId; deliberationStateId; route;
  claimedAt; terminalFactReadyAt; outcomeCommittedAt: string;
  actualLatencyMs: number;   // copied forward from the committed terminal fact, for read convenience
}
```

The full `terminalFact` payload (including any `RouteSpecificSuccessPayload`) MAY be retained for audit or MAY be omitted from a canonical compacted representation once committed — retention/compaction *duration* policy is explicitly out of scope (per D1-0 §27.11's own deferral), but whatever a future implementation chooses, read integrity must still be able to prove phase progression (`CLAIMED` occurred, `TERMINAL_FACT_READY` occurred, `OUTCOME_COMMITTED` occurred, in that order) from the timestamps alone, independent of whether the full payload is retained.

### 28.16 Timestamp ordering — audit only, never ownership

**Frozen:** `claimedAt <= terminalFactReadyAt <= outcomeCommittedAt`, for every phase where the later timestamp exists. Timestamps exist strictly for audit ordering. **Atomic store semantics — never timestamp comparison — decide ownership** (the claim in §28.7/§28.10, and the single successful commit in §28.19); a clock skew or two equal timestamps must never be used to arbitrate a disputed claim or a disputed commit.

### 28.17 Exact API surface — *return/precondition types corrected by the Slice 2D-D1-A0 amendment*

**Frozen conceptual operations — no generic `updateCheckpoint(partialObject)` escape hatch; every transition is a dedicated, narrow operation:**

```
claimRouteExecution(session, deliberationState, store, input: { attemptId, latencyLimitMs })
  → ClaimedCheckpoint | AdmissionRejectedTerminalFactReadyCheckpoint
                                                        (§28.7/§28.8/§28.9 — never throws for an ordinary admission
                                                         failure; never returns a ReservedTerminalFactReadyCheckpoint)

recordExecutionTerminalFact(store, input: { attemptId, actualLatencyMs, terminalFact })
  → ReservedTerminalFactReadyCheckpoint                (§28.18 — requires current phase CLAIMED; can never
                                                         produce an AdmissionRejectedTerminalFactReadyCheckpoint,
                                                         since admission was already resolved inside the claim)

markExecutionOutcomeCommitted(session, deliberationState, store, input: { attemptId })
  → OutcomeCommittedCheckpoint                         (§28.19)

assertRouteExecutionCheckpointIntegrity(session, deliberationState, store, attemptId?)
  → void | throws                                      (§28.20)
```

**Amendment correction:** the amendment-superseded surface returned/accepted the single undifferentiated `TerminalFactReadyCheckpoint` at both `claimRouteExecution` and `recordExecutionTerminalFact`. Corrected: `claimRouteExecution`'s only two possible results are `ClaimedCheckpoint` (admission succeeded) or `AdmissionRejectedTerminalFactReadyCheckpoint` (admission failed, for any of the three causes in §28.9) — it never produces a `ReservedTerminalFactReadyCheckpoint` directly, because that subtype only exists after an actual external call has been attempted. `recordExecutionTerminalFact` is, symmetrically, the only operation that can ever produce a `ReservedTerminalFactReadyCheckpoint`, and it can never produce an `AdmissionRejectedTerminalFactReadyCheckpoint`, because by the time it runs (requiring phase `CLAIMED`), admission has already succeeded.

### 28.18 Claim input and terminal-fact input — narrowest legal shape

**`claimRouteExecution` input:** `{ attemptId, latencyLimitMs }` only. Everything else — `route`, `deliberationStateId`, `sessionId`, hashes, `reservedLatencyMs`, `claimedAt` — is derived from the authoritative `RouteAttempt` (re-resolved per §28.3), the live-execution policy (§28.21), the deadline-violation claim-blocking check (§28.14), and the store's own transaction (§28.7). A caller may not restate any of it. A malformed `latencyLimitMs` (§28.9 cause 1) is validated, never stored raw and never fabricated into a replacement value — it produces an `AdmissionRejectedTerminalFactReadyCheckpoint` with no `latencyLimitMs` field at all (§28.13).

**`recordExecutionTerminalFact` input:** `{ attemptId, actualLatencyMs, terminalFact }` only. `route`, `claimedAt`, `latencyLimitMs`, `reservedLatencyMs`, the parent binding, and the checkpoint's current phase are all derived from the existing `ClaimedCheckpoint` record, never caller-supplied. The operation requires the checkpoint's current phase to be `CLAIMED`; any other current phase is rejected (§28.25's transition matrix), and it always produces a `ReservedTerminalFactReadyCheckpoint` — never the admission-rejected subtype (§28.17).

### 28.19 Commit-acknowledgement input and integrity — narrowest legal shape, no adjacency-only trust

**`markExecutionOutcomeCommitted` input:** `{ attemptId }` only, per this packet's own preference (§31) — a caller never simply asserts `outcomeCommitted = true`. The operation must independently verify, before transitioning:
1. the checkpoint's current phase is `TERMINAL_FACT_READY` (either subtype, §28.13) and `terminalFact.kind !== 'DEADLINE_VIOLATION'` (§28.14);
2. exactly one `RouteOutcome` exists in `deliberationState.outcomes` for this `attemptId` (already enforced as a `recordRouteOutcome` precondition, confirmed by direct inspection this packet — `deliberation.ts:1815`'s existing "one attempt has at most one outcome" check means this is a re-verification, not a new invariant);
3. that `RouteOutcome` is consistent with the checkpointed `terminalFact`: for `terminalFact.kind === 'SUCCEEDED'`, its route-specific fields agree with `terminalFact.payload` (§28.13); for `terminalFact.kind === 'FAILED'` (whether an executed failure on a `ReservedTerminalFactReadyCheckpoint` or an admission-rejection on an `AdmissionRejectedTerminalFactReadyCheckpoint`), `RouteOutcome.status === 'FAILED'` and its `failure` agrees with `terminalFact.failure`;
4. that `RouteOutcome`'s `latencyConsumed` agrees with the checkpoint's `terminalFact.actualLatencyMs`;
5. the `deliberationStateId`/`route` binding is still valid (§28.3/§28.4).

Only if all five hold does the transition to `OUTCOME_COMMITTED` occur. No adjacency-only trust (i.e., "a `RouteOutcome` exists somewhere, therefore this checkpoint may commit" is insufficient without the consistency check in step 3–4).

### 28.20 Checkpoint read integrity — global, not merely local

**Frozen validator**, conceptually `assertRouteExecutionCheckpointIntegrity(session, deliberationState, store, attemptId?)`, mirroring this document's own established "never trust an upstream boundary already checked it" posture (already applied to `SEEK_EVIDENCE`/`TARGETED_PEER_CHALLENGE` readiness, §13.D/§13.E): it must independently validate, never trusting checkpoint self-consistency alone —
- the attempt resolves exactly (against `deliberationState.attempts`, via the parent binding);
- the parent `DeliberationState` binding is valid;
- `route` agrees with the authoritative `RouteAttempt.route` (§28.4);
- phase-specific required/forbidden fields hold exactly (§28.6/§28.13/§28.15 shapes, no extra or missing fields);
- timestamp ordering holds (§28.16);
- the reservation is legal — not merely locally well-formed, but globally consistent: **global reservation integrity**, scoped to at least one `deliberationStateId`, requires `deliberationState.latencyBudget.spent + SUM(effectiveLatencyEncumbrance(checkpoint, deliberationState) for every sibling checkpoint) <= deliberationState.latencyBudget.ceiling` (§28.11's corrected, derived-encumbrance formula — **never** a blind sum of raw `reservedLatencyMs`, which would double-count any sibling whose matching `RouteOutcome` has already landed) — a single locally-well-formed checkpoint is not trustworthy in isolation if its siblings' effective encumbrances collectively overrun the ceiling;
- terminal-fact legality (§28.13's shape, `DEADLINE_VIOLATION` correctly marked non-committable);
- product-outcome consistency, exactly the §28.19 checks, whenever `phase === 'OUTCOME_COMMITTED'`.

"Global before local" applies exactly as this document's prior slices have already established elsewhere.

### 28.21 Legacy / missing coordination state — compatibility posture

Because execution checkpoints do not exist in any accepted runtime today, an existing `RouteAttempt` with no checkpoint record is **legitimate historical/offline state**, not an anomaly. A missing checkpoint must **never** be interpreted as "`UNCLAIMED`, and therefore automatically safe to execute" — for any future live-execution eligibility decision, a missing checkpoint means only "no execution-coordination record exists yet for this `attemptId`." A separately-authorized `claimRouteExecution` call may create one only after every current precondition (route readiness, live-execution authorization, etc.) independently passes. Historical `RouteOutcome`s recorded with no checkpoint at all (every one that exists today, and every one Slice 2D-B0 through 2D-D1-0 have produced in tests) remain fully legitimate accepted offline history and are never retroactively required to acquire one.

**No retroactive invalidation:** checkpoint integrity (§28.20) must never make any existing accepted offline `RouteAttempt`, `RouteOutcome`, or `QuestionDisposition` invalid merely because it predates execution coordination. Execution coordination is required only for future live-execution paths, never applied backward.

### 28.22 Alias isolation

Every stored checkpoint payload (claim input, terminal fact, route-specific success payload) is an independent snapshot at the moment of its transition. Mutating a caller-owned object after passing it into `claimRouteExecution`/`recordExecutionTerminalFact` must never alter stored coordination history — the store's write boundary is responsible for this, not a generic deep-freeze utility applied everywhere. This mirrors the same discipline this document's accepted domain layer already applies to every `RouteOutcome`/`RouteAttempt` write (clone-at-the-boundary, never trust a caller's continued ownership of a passed-in object).

### 28.23 Store-port contract vs. production durability — explicit distinction

An offline reference implementation may later provide an in-memory `RouteExecutionCheckpointStore` for deterministic tests. **This does not, and can never, by itself satisfy production durability or cross-process atomicity.** The store-port *contract* frozen in this section (§28.1–§28.20) requires its claim operation (§28.7/§28.10) to be atomic; a future production adapter (a database, a transactional queue, or equivalent) must supply the actual durable, cross-process atomic semantics that an in-memory test double can only simulate within one process. No claim of cross-process safety may ever be derived from an in-memory test double's passing tests alone.

### 28.24 Required schema summary — *corrected by the Slice 2D-D1-A0 amendment (5-state breakdown)*

| State | `latencyLimitMs` required? | `reservedLatencyMs` | Effective encumbrance *before* matching outcome | Effective encumbrance *after* matching outcome | Committable? | Legal next transition |
|---|---|---|---|---|---|---|
| *(absent)* — `UNCLAIMED` | — (no record) | — | — | — | — | → `CLAIMED` or → `TFR`/`ADMISSION_REJECTED`, via `claimRouteExecution` |
| `CLAIMED` | Yes (`> 0`) | `=== latencyLimitMs` | `reservedLatencyMs` (no outcome possible yet) | n/a | No | → `TFR`/`RESERVED` via `recordExecutionTerminalFact` |
| `TFR` / `ADMISSION_REJECTED` (§28.13) | **No field at all** | `0` | `0` | `0` (never has a matching outcome to transition on) | Yes — as a `FAILED` outcome, exactly like any other `FAILED` terminal fact | → `OUTCOME_COMMITTED` via `markExecutionOutcomeCommitted` |
| `TFR` / `RESERVED`, `terminalFact.kind` = `SUCCEEDED`/`FAILED` | Yes (`> 0`) | `> 0` | `reservedLatencyMs` | `reservedLatencyMs - actualLatencyMs` (residual, §28.11) | Yes | → `OUTCOME_COMMITTED` via `markExecutionOutcomeCommitted` |
| `TFR` / `RESERVED`, `terminalFact.kind` = `DEADLINE_VIOLATION` | Yes (`> 0`) | `> 0` | `reservedLatencyMs` (full, always — no matching outcome is ever legal, §28.14) | n/a — never reaches "after," permanently full | **No — permanently non-committable** | none — terminal, reconciliation/operator-attention only; also blocks future claims on the same `deliberationStateId` (§28.14) |
| `OUTCOME_COMMITTED` | n/a (not stored at this phase) | n/a | n/a | `0` | Already committed | none — terminal |

### 28.25 Required transition matrix — *updated by the Slice 2D-D1-A0 amendment*

**Legal:**

| From | To | Operation |
|---|---|---|
| *(absent)* | `CLAIMED` | `claimRouteExecution`, admission succeeds (all three §28.9 causes pass) |
| *(absent)* | `TERMINAL_FACT_READY` / `ADMISSION_REJECTED` (`FAILED`, `EXECUTION` category) | `claimRouteExecution`, admission rejected for any of the three §28.9 causes — no `CLAIMED` ever exposed |
| `CLAIMED` | `TERMINAL_FACT_READY` / `RESERVED` (`SUCCEEDED`/`FAILED`/`DEADLINE_VIOLATION`) | `recordExecutionTerminalFact` |
| `TERMINAL_FACT_READY` / `ADMISSION_REJECTED` (`FAILED`) | `OUTCOME_COMMITTED` | `markExecutionOutcomeCommitted`, all §28.19 checks pass |
| `TERMINAL_FACT_READY` / `RESERVED` (`SUCCEEDED`/`FAILED`) | `OUTCOME_COMMITTED` | `markExecutionOutcomeCommitted`, all §28.19 checks pass |

**Rejected (each throws / refuses, never silently no-ops):**

| Attempted transition | Why rejected |
|---|---|
| Claim + admission rejection, but caller expects a `ClaimedCheckpoint` back | Not a rejection of the call itself — §28.8/§28.9's `AdmissionRejectedTerminalFactReadyCheckpoint` is the correct, successful return value; the caller must branch on the returned shape, not assume `ClaimedCheckpoint` |
| `recordExecutionTerminalFact` attempting to produce an `AdmissionRejectedTerminalFactReadyCheckpoint` | Admission was already resolved atomically inside `claimRouteExecution` (§28.17); this operation can only ever produce a `ReservedTerminalFactReadyCheckpoint`, and only from phase `CLAIMED` |
| `claimRouteExecution` against a `deliberationStateId` with an unresolved `DEADLINE_VIOLATION` checkpoint | §28.14's claim-blocking rule — fails closed via the admission-rejection path (§28.9 cause 3), never a `ClaimedCheckpoint` |
| Deadline-violation record → `OUTCOME_COMMITTED` | §28.14 — permanently non-committable by construction |
| Duplicate claim (`claimRouteExecution` called twice for the same `attemptId`) | A checkpoint already exists for this `attemptId`; the atomic claim (§28.7/§28.10) guarantees the second caller observes an existing record, not a fresh claim |
| Terminal fact recorded twice (`recordExecutionTerminalFact` called when phase is already `TERMINAL_FACT_READY` or `OUTCOME_COMMITTED`) | Requires current phase `CLAIMED`; any other phase is rejected |
| Commit acknowledgement before a matching `RouteOutcome` exists | §28.19 check 2 fails — no `OUTCOME_COMMITTED` without a matching authoritative `RouteOutcome` already persisted |
| Second commit acknowledgement (`markExecutionOutcomeCommitted` called when phase is already `OUTCOME_COMMITTED`) | Requires current phase `TERMINAL_FACT_READY`; `OUTCOME_COMMITTED` is terminal |

### 28.26 Frozen design-time invariants (Slice 2D-D1-A0)

Numbered locally to this section (`EC-1`–`EC-15`) rather than merged into this document's master invariant numbering (§16 and elsewhere), because — consistent with Slice 2D-D1-0's own posture (§27.18–§27.19) — nothing in this section is implemented runtime; these are binding requirements a future runtime slice must satisfy, not yet-accepted guarantees about existing behavior.

1. **EC-1** — Checkpoint identity is exactly `attemptId`; no second execution identity exists (§28.1).
2. **EC-2** — Every checkpoint carries a valid `deliberationStateId` parent binding (§28.3).
3. **EC-3** — At most one checkpoint exists per `attemptId` (§28.10, enforced by the atomic claim).
4. **EC-4** — `route` is immutable once set and always agrees with the authoritative `RouteAttempt.route` (§28.4).
5. **EC-5** — Only the fields legal for the current `phase` may be present; the union is exhaustive and non-generic (§28.5).
6. **EC-6** — The `UNCLAIMED → CLAIMED`-or-`TERMINAL_FACT_READY` transition is atomic; of concurrent claimants, exactly one may obtain a provider-call-authorized `ClaimedCheckpoint` (§28.7/§28.10).
7. **EC-7** — *(corrected by the Slice 2D-D1-A0 amendment)* For one `deliberationStateId`, authoritative `spent` plus the **sum of effective latency encumbrance** (§28.11's derived formula, never a blind sum of raw `reservedLatencyMs`) across every checkpoint of that state never exceeds `ceiling`.
8. **EC-8** — No `ClaimedCheckpoint` is ever exposed to a caller without an already-successful latency reservation (§28.7/§28.8).
9. **EC-9** — For a `SUCCEEDED` or `FAILED` terminal fact, `actualLatencyMs <= reservedLatencyMs` always (§28.13); a violation is representable only as `DEADLINE_VIOLATION` (EC-10), never silently clamped into a normal fact.
10. **EC-10** — A `DEADLINE_VIOLATION` terminal fact is permanently non-committable; no transition to `OUTCOME_COMMITTED` exists for it (§28.14).
11. **EC-11** — `TERMINAL_FACT_READY` is reached before any `RouteOutcome` write is attempted for the same terminal fact (§27.11, restated).
12. **EC-12** — `OUTCOME_COMMITTED` requires exactly one authoritative `RouteOutcome` already persisted, consistent with the checkpointed terminal fact (§28.19).
13. **EC-13** — An `attemptId` with no checkpoint is legitimate historical/offline state, never treated as `UNCLAIMED`-and-safe for a live-execution decision (§28.21).
14. **EC-14** — No checkpoint field, at any phase, may hold a raw provider/SDK payload, a secret, or an unbounded raw document (§28.13, by construction).
15. **EC-15** — `RouteOutcome` is the sole product-truth ledger; no checkpoint state is ever treated as product-semantic authority, and no circular dependency exists where `RouteOutcome`'s own validity depends on checkpoint content (§28.27).
16. **EC-16** — *(added by the Slice 2D-D1-A0 amendment)* An `AdmissionRejectedTerminalFactReadyCheckpoint` never carries a `latencyLimitMs` field, regardless of admission-rejection cause — a malformed or absent limit is never stored raw, and no replacement value is ever fabricated (§28.8/§28.13).
17. **EC-17** — *(added by the Slice 2D-D1-A0 amendment)* Any unresolved `DEADLINE_VIOLATION` checkpoint on a `deliberationStateId` blocks every subsequent `claimRouteExecution` for that same state from producing a `ClaimedCheckpoint`; such claims fail closed via the ordinary admission-rejection path, never bypassed (§28.14).

### 28.27 `RouteOutcome` authority preserved — no circular dependency

Restated precisely: `RouteOutcome` is, and remains, the sole authoritative product terminal-truth ledger (§27.11, unchanged). `OutcomeCommittedCheckpoint` status *depends on* a `RouteOutcome`'s existence and consistency (§28.19) — but the dependency runs in exactly one direction. `recordRouteOutcome`'s own validators (session/hash binding, attempt provenance, question currentness, route readiness, `EvidenceSubject`/TPC readiness, etc. — all pre-existing, all unchanged) never inspect, and must never be made to inspect, execution-checkpoint state for their own semantic validity. No circular authority is introduced.

### 28.28 Live-execution authorization as claim input

`claimRouteExecution` (§28.17/§28.18) does not reduce live-execution eligibility to "a `latencyLimitMs` was supplied." Per D1-0 §27.14 (unchanged), the claim operation must additionally resolve — from the live-execution enablement policy, not from the caller's own assertion — proof that live execution is authorized both generally and for the attempt's specific route, before any admission/reservation logic runs. This section does not design the final product UI/config representation of that policy (explicitly out of scope, per this packet's own §43); it only fixes that the claim operation's precondition chain must include it.

### 28.29 Provider selection and route-specific decisions — unchanged

Provider/model selection (Claude/OpenAI/Gemini, specific models, registry roles) remains **OPEN** and is not touched by this schema freeze — no provider is read, called, or selected in the course of this inspection. Direct inspection this packet of `deliberation.ts` and the store-abstraction search found nothing contradicting the Slice 2D-D0 route-specific inventory: counts are unchanged — `ADD_CONTEXT` 1, `ADD_REVIEWER` 5, `REPLICATE` 3, `SEEK_EVIDENCE` 5, `TARGETED_PEER_CHALLENGE` 7, **21 total**. Slice 2D-D1-0's own common-execution-layer open-decision count (**11 → 1**, §27.20) is **not rewritten** by this section: D1-0 closed the provider-independent *policy* questions; this section closes the *executable schema/sequencing* needed to implement those already-accepted policies — sequencing refinement, not a reopening (per this packet's own §46 instruction). The one remaining common open item — provider/model selection authority — is unchanged and unresolved here.

### 28.30 Recommended next slice

**Recommended: `SLICE 2D-D1-A` — EXECUTION COORDINATION / CLAIM / LATENCY RESERVATION OFFLINE RUNTIME**, exactly as Slice 2D-D1-0 already recommended (§27.22) and this packet's own §51 expects absent a new blocker. This freeze found no missing common-schema prerequisite that would redirect the recommendation: the exact checkpoint entity, phase union, field shapes, API surface, reservation-aggregation rule, and transition matrix are now specified precisely enough to implement and test entirely offline (no provider calls), mirroring how `RouteAttempt`/`RouteOutcome` were themselves built and fully tested offline before any route's successful-result semantics existed. That runtime slice must implement, at minimum, the deterministic conformance tests this packet's own §39–§41 anticipate: (a) a two-concurrent-claims-same-`attemptId` test proving exactly one obtains a provider-call-authorized `ClaimedCheckpoint`, explicitly noting that a single-process in-memory test demonstrates API/store-contract conformance only, never cross-process production durability (§28.23); (b) a reservation-aggregation test proving two attempts against one `deliberationStateId` cannot jointly reserve more than the remaining ceiling, including a self-consistent-tamper variant where two individually-valid checkpoints' combined reservations exceed the ceiling and global read integrity (§28.20) rejects it; (c) an admission-failure test proving the exact §28.8 transition is followed, with zero provider calls and no permanently-ambiguous `CLAIMED` state produced for a failure that was already known and pre-call.

### 28.31 Required tests for the reservation-handoff and admission-rejection paths (Slice 2D-D1-A0 amendment)

In addition to §28.30's (a)–(c), the future `SLICE 2D-D1-A` runtime must prove the exact handoff and admission-rejection corrections made by this amendment — restated here precisely so no runtime implementer has to reconstruct them from the narrative reasoning in §28.11–§28.14:

**Reservation-handoff test (proves §28.11/§28.12, using this amendment's own worked example):** with `ceiling = 100`, attempt A reserving 60 and attempt B reserving 40 against the same `deliberationStateId` —
- before A's `RouteOutcome` exists: `spent(0) + effective_A(60) + effective_B(40) = 100`;
- after A's `RouteOutcome` persists (actual latency 50) but before A's checkpoint is acknowledged: `spent(50) + effective_A(60-50=10) + effective_B(40) = 100` — no corruption, no apparent overrun, no double-count;
- after A's `markExecutionOutcomeCommitted` succeeds: `spent(50) + effective_A(0) + effective_B(40) = 90`.

A self-consistent-tamper variant must also prove global read integrity (§28.20) still rejects two individually-valid `ReservedTerminalFactReadyCheckpoint`s whose combined *effective* encumbrance (not raw reservation) exceeds the ceiling once neither has a matching outcome yet.

**Admission-rejection-cause tests (proves §28.8/§28.9/§28.13), independently, for each of the three causes:** missing `latencyLimitMs`; structurally invalid `latencyLimitMs` (non-number, `NaN`, `Infinity`, `<= 0`, fractional); and a structurally valid `latencyLimitMs` exceeding remaining reservable budget. Each must prove: provider calls = 0; the resulting checkpoint is an `AdmissionRejectedTerminalFactReadyCheckpoint` carrying **no** `latencyLimitMs` field at all (present with any value, malformed or otherwise, fails the test); `reservedLatencyMs === 0`; `terminalFact.actualLatencyMs === 0`; `terminalFact.failure.category === 'EXECUTION'`.

**Deadline-violation claim-blocking test (proves §28.14/EC-17):** given a `deliberationStateId` with one unresolved `DEADLINE_VIOLATION` checkpoint, a subsequent `claimRouteExecution` call for a different `attemptId` on the same state must produce an `AdmissionRejectedTerminalFactReadyCheckpoint` (cause 3, §28.9) and never a `ClaimedCheckpoint`, even when that new attempt's own `latencyLimitMs` and remaining budget would otherwise admit it.
