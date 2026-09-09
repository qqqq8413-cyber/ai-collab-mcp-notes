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
ROUTE ATTEMPT          "this route was actually attempted, once"         (new, §6)
      ≠
ROUTE OUTCOME          "this is what that one attempt produced"          (new, §8)
      ≠
QUESTION DISPOSITION   "this is what the outcome implies for the         (new, §10)
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

- **RouteAttempt** — the record that a specific `RouteDecision` was actually attempted, exactly once. Distinct from the decision itself (§6).
- **AttemptStatus** — the closed, three-value technical-completion classification of one `RouteAttempt`: `SUCCEEDED` | `FAILED` | `INCONCLUSIVE` (§7).
- **RouteOutcome** — the immutable, route-specific result payload (or failure information) produced by one terminal `RouteAttempt` (§8).
- **QuestionDisposition** — a separate lifecycle record stating what a `RouteOutcome` implies for the `UnresolvedQuestion` that motivated the attempt: `RESOLVED` | `STILL_OPEN` | `SUPERSEDED_RECLASSIFIED` | `CROSS_SESSION` (§10).
- **Derived question identity** — a new `UnresolvedQuestion` created when a `QuestionDisposition` is `SUPERSEDED_RECLASSIFIED`, carrying `derivedFromQuestionId` pointing back at the question it replaces (§9).
- **SessionVersionLineage** — the conceptual lineage record (already named, unscheduled, in `MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md` §8) produced when an `ADD_CONTEXT` outcome's disposition is `CROSS_SESSION` (§14.A).
- **ReplicationResult** — the closed, three-value result vocabulary a `REPLICATE` outcome payload carries: `REPRODUCED` | `NOT_REPRODUCED` | `PARTIAL` (§14.C).

None of these are added to `src/stress-test/types.ts` by this document. They are named here so later, explicitly-authorized implementation work has one non-ambiguous vocabulary to build against.

---

## 4. Binding architecture decision: RouteDecision is not execution

Restated from `MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md` §4 and `src/stress-test/deliberation.ts`'s own module docstring, and extended: `RouteDecision` records "this is the justified next route." It is not, and must never become, proof that a provider call happened, retrieval happened, a human answered, the route succeeded, the question changed, or the question was resolved. Every one of those facts — if it ever exists — is recorded by a `RouteAttempt`/`RouteOutcome`/`QuestionDisposition`, never folded backward into the `RouteDecision` that merely justified attempting the route.

`STOP` is the one route with no attempt at all (§6, §14.F) — it remains exactly `RouteDecision(route=STOP)` + `StopReason`, as already implemented.

---

## 5. RouteAttempt — identity, binding, and lifecycle

A `RouteAttempt` is the record that a specific `RouteDecision` was actually attempted, once.

| Field | Requirement |
|---|---|
| `attemptId` | Required, unique. |
| `decisionId` | Required. Must reference an existing, previously-recorded `RouteDecision`. |
| `questionId` | Required for every non-`STOP` route; must exactly equal the referenced `RouteDecision.questionId`. Never independently supplied. |
| `route` | Required; must exactly equal the referenced `RouteDecision.route`. Never inferred, never re-derived from `rootCause` independently of the decision it attempts. |
| `sessionId` | Required; must match the current `DeliberationState.sessionId`. |
| `artifactHash` / `authorContextHash` | Required; must match the current `DeliberationState`'s bound frozen hashes. |
| `startedAt` / `completedAt` | Required once terminal. |
| Logical cost consumed | Required once terminal; feeds `CostBudget` (§13). |
| Latency consumed | Required once terminal; feeds `LatencyBudget` (§13). |
| `status` | Required once terminal: one of `AttemptStatus` (§7). |

Binding rules, all fail-closed, mirroring the pattern `verifyDeliberationBinding`/`recordRouteDecision` already enforce today (`src/stress-test/deliberation.ts`):
- No free-floating attempt: every `RouteAttempt` must reference an existing `RouteDecision`; an attempt naming an unknown `decisionId` cannot exist.
- No inferred route identity: `route` is copied from, and checked against, the referenced decision — never re-derived, never guessed.
- No cross-session reuse: an attempt's `sessionId`/hashes must match the `DeliberationState` currently acting, exactly like every existing Slice 2A/2B binding check; an attempt bound to Session A's hashes can never be recorded against Session B's `DeliberationState`.
- **For `STOP`: there is no `RouteAttempt`.** `STOP` has no provider/execution step to attempt; its audit representation stays `RouteDecision(route=STOP)` + `StopReason`, unchanged.

---

## 6. Attempt status model

Closed, three-value vocabulary: `SUCCEEDED` | `FAILED` | `INCONCLUSIVE`.

**`FAILED`** — the route mechanism itself could not produce any structurally valid result: a provider/transport failure, a retrieval failure, or output that fails runtime validation. The mechanism did not complete as intended.

**`INCONCLUSIVE`** — the route mechanism completed without technical failure, but its own designed result vocabulary includes an explicit indeterminate/insufficient category, and that is what it returned (for example, `SEEK_EVIDENCE`'s evidence-lookup result explicitly supports a "partial / inconclusive" value, §14.D). The mechanism worked; the specific answer it produced is, by the mechanism's own design, indeterminate.

**`SUCCEEDED`** — the route mechanism completed and produced a complete, structurally valid, *determinate* categorical result — even when that result is substantively unhelpful for resolving the underlying question. A replication that reproduces the finding, a peer-challenge response that maintains disagreement, a reviewer pass that finds nothing material: all `SUCCEEDED`. None of these facts says anything about whether the question is now resolved (§11) — that is a disposition question, never an attempt-status question.

**The precise boundary** (resolving the distinction the governing packet asked to be defined precisely): a route's own result vocabulary decides whether `INCONCLUSIVE` is even reachable for it. A vocabulary built entirely from determinate categories (`ADD_REVIEWER`'s "found N findings, possibly zero"; `REPLICATE`'s `REPRODUCED`/`NOT_REPRODUCED`/`PARTIAL`; `TARGETED_PEER_CHALLENGE`'s rebuttal/concession/qualification/refusal-to-yield) never produces `INCONCLUSIVE` — every one of its possible answers is `SUCCEEDED` or `FAILED`, never in between. A vocabulary that itself defines an indeterminate category (`SEEK_EVIDENCE`'s "partial/inconclusive evidence") produces `INCONCLUSIVE` exactly when that category is what came back. `INCONCLUSIVE` must never be redefined per-route as "didn't resolve the question" — that would silently duplicate `QuestionDisposition.STILL_OPEN` at the attempt layer and destroy the separation this contract requires (§11).

Not every route needs all three values. `ADD_CONTEXT` and `STOP` are handled separately (§14.A, §14.F) since neither is a provider/model route.

---

## 7. RouteOutcome contract

`RouteOutcome` is the immutable result of exactly one terminal `RouteAttempt`.

Every `RouteOutcome` binds to:
- `attemptId`, `decisionId`, `originatingQuestionId`, `sessionId`, `artifactHash`, `authorContextHash`, `route`,
- an outcome timestamp,
- a route-specific result payload (§14) or failure information (when `status = FAILED`).

`RouteOutcome` must **not**:
- directly mutate `StressTestSession`,
- directly set `HumanAdjudication`,
- set `actionChange`,
- authorize a `RevisionAction`,
- silently rewrite `ReviewFinding`,
- silently rewrite `SemanticIssue`,
- silently rewrite the original `UnresolvedQuestion`.

`RouteOutcome` is evidence/audit input to re-evaluation (§15) — never itself the fact that a question is resolved (§10, §11).

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

`Q1.rootCause` is never rewritten to `DECISION_SENSITIVE_CONFLICT`. `Q2` is a new registered question, carrying explicit lineage (`derivedFromQuestionId`) back to `Q1`. The minimum required structure is exactly that one field — no separate lineage aggregate is needed for this case, unlike the cross-session case (§14.A), which already has its own conceptual `SessionVersionLineage` record.

---

## 9. QuestionDisposition

A separate conceptual lifecycle record — never overloaded onto `RouteOutcome`, and never an insufficient boolean (`resolved: true/false`).

| Disposition | Meaning |
|---|---|
| `RESOLVED` | The original information deficit no longer remains materially open. |
| `STILL_OPEN` | The original deficit remains materially unresolved. |
| `SUPERSEDED_RECLASSIFIED` | The original question no longer correctly describes the remaining deficit; a new `UnresolvedQuestion` (`derivedFromQuestionId` pointing back at this one) is created (§8). |
| `CROSS_SESSION` | Specific to `ADD_CONTEXT` (§14.A): the supplied context caused creation of a new `StressTestSession` version; the question's disposition under the *old* session is recorded as `CROSS_SESSION`, distinct from `RESOLVED` — the deficit was not resolved under Session A, it was carried across a version boundary into Session B. |

A question may accumulate more than one `QuestionDisposition` record over time (each re-evaluation after a fresh `RouteAttempt` produces one) — dispositions are themselves append-only, exactly like `RouteDecision` history. The *current* disposition for a question is its most recent record (§16).

---

## 10. Route success does not equal question resolution

Binding invariant. `AttemptStatus` and `QuestionDisposition` are answers to two different questions and must never be read as implying one another.

| Scenario | Attempt status | Question disposition |
|---|---|---|
| `REPLICATE` succeeds; finding reproduces | `SUCCEEDED` | Still requires explicit re-evaluation — may remain `STILL_OPEN` or resolve, depending on what reproduction implies for the original stability question |
| `TARGETED_PEER_CHALLENGE` succeeds; both positions remain defensible | `SUCCEEDED` | May remain `STILL_OPEN` — a complete, valid response does not itself dissolve the conflict |
| `SEEK_EVIDENCE` completes; evidence is inconclusive | `INCONCLUSIVE` | May remain `STILL_OPEN` — the lookup's own indeterminacy does not resolve anything by itself |
| `ADD_REVIEWER` completes; finds nothing material | `SUCCEEDED` | Still requires explicit re-evaluation before the coverage gap is treated as closed |

No route's `SUCCEEDED` status is ever read, by itself, as `QuestionDisposition = RESOLVED`. Resolution is always a separate, explicit act (§15).

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
- An actual `RouteAttempt` consumes logical cost when the route is provider/retrieval-backed (every route except `ADD_CONTEXT` and `STOP`, §14).
- Latency attaches to the actual attempt, not the decision.
- `FAILED` and `INCONCLUSIVE` attempts may still consume cost and latency — a failed or indeterminate call was still made and still cost something; spend is never waived because the outcome was unhelpful.
- Spend is append/audit based: `applyCostSpend`/`applyLatencySpend` (accepted, unchanged) never decrement — no failed attempt's spend is ever hidden by reversing it.
- Explicit finite ceilings remain non-negotiable (`MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md` §12, §16 invariant 18): a missing provider-runtime ceiling is a precondition failure for enabling any attempt runtime, not a default of "no limit."
- `transportMaxRetries` remains RESEARCH_ONLY and is not introduced here, exactly as before.
- No numeric production ceiling is chosen by this document.

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

Route output: new `ReviewFinding[]` from one reviewer pass (accepted, unchanged shape). `AttemptStatus`: `SUCCEEDED` (findings produced, possibly zero) or `FAILED` (acquisition/technical failure, invalid output). No `INCONCLUSIVE` category — "found nothing material" is itself a determinate answer, not an indeterminate one. Append-only review evidence; no automatic materiality authority; no automatic question resolution — re-evaluation (§15) decides the coverage gap's disposition.

### C. REPLICATE

`ReplicationResult`: `REPRODUCED` | `NOT_REPRODUCED` | `PARTIAL` — a closed, three-value categorical result, chosen because it mirrors the pattern already governing every other closed enum in this runtime (`StopReason`, `RootCauseCategory`), and because `PARTIAL` is itself a determinate designed category, not an indeterminate escape hatch. `AttemptStatus`: `SUCCEEDED` for any of the three (the replication mechanism ran and produced a definite categorical answer) or `FAILED` (the replication attempt itself could not execute). Reproduction is never treated as truth — it is one input the disposition step (§15) weighs, never a self-executing verdict.

### D. SEEK_EVIDENCE

Evidence-lookup result, one of: supportive | contradictory | partial/inconclusive | execution failure. The first two map to `AttemptStatus = SUCCEEDED`; "partial/inconclusive" maps to `AttemptStatus = INCONCLUSIVE` (§6); "execution failure" maps to `AttemptStatus = FAILED`. Never directly mutates `ReviewFinding.evidenceState` — any later projection into that vocabulary is an explicit, separately-designed re-evaluation step (§15), not an automatic side effect of the lookup.

### E. TARGETED_PEER_CHALLENGE

Challenge-response outcome preserving target/source provenance, bounded excerpt identity, and one of: rebuttal | concession | qualification | refusal-to-yield. All four map to `AttemptStatus = SUCCEEDED` — a complete, valid response was produced, regardless of whether it resolves anything. `FAILED` covers a call failure or an unresolvable reference. Consensus is never truth: no peer response, by itself, automatically resolves the conflict (§10, §11) — that remains a disposition decided by re-evaluation, ultimately subordinate to `HumanAdjudication` (§18).

### F. STOP

No `RouteAttempt`, no `RouteOutcome`, no `AttemptStatus`. Terminal audit representation remains exactly `RouteDecision(route=STOP)` + `StopReason`, unchanged from Slice 2A/2B.

---

## 14. Re-evaluation authority

`QuestionDisposition` is never produced directly from a raw `RouteOutcome`. Four distinct layers, none collapsible into another:

1. **Raw route outcome** — the immutable fact of what the attempt produced (§7).
2. **Deterministic runtime validation** — the same fail-closed, structural checking already used everywhere in this runtime today (provenance resolves, hashes bind, `status`/result values are in their allowlist). This layer can reject a malformed `RouteOutcome` outright; it never decides materiality or disposition.
3. **Semantic re-evaluation** — the actual classification of what the outcome means for the question: does the deficit remain, does it get reclassified, is it resolved. This is **not implemented anywhere in this document or in `deliberation.ts`.** `QuestionDisposition`-construction consumes an externally supplied / later-authorized re-evaluation result as an input — exactly the same posture Slice 2A/2B already takes for `rootCause`/`materialityReason`: this module "enforces structure, not classification — no AI classifier, no numeric score" (`RouteReason` docstring, `src/stress-test/deliberation.ts`). No AI materiality classifier and no numeric materiality scoring is introduced by this document, and none should be introduced silently by whatever implementation phase eventually builds this.
4. **Human adjudication** — entirely unchanged (§18), downstream of and unaffected by everything above.

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
RouteAttempt                    (attemptId, decisionId, questionId, route, sessionId+hashes)
  |  (attemptId)
  v
RouteOutcome                    (attemptId, decisionId, originatingQuestionId, sessionId+hashes, route)
  |  (originatingQuestionId)
  v
QuestionDisposition             (questionId, disposition, provenance to the RouteOutcome that motivated it)
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
  HumanAdjudication   (unchanged, Slice 1; sole gate to RevisionAction, §18)
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
```

Repeated submission of the same outcome identity (`attemptId`) must never create a duplicate historical fact — the same posture `registerUnresolvedQuestion`'s duplicate-id rejection already takes today. Retry always requires a new `RouteDecision` and a new `RouteAttempt`; nothing reuses a prior attempt's identity. No conflict with the current, already-accepted runtime was found: `RouteAttempt`/`RouteOutcome` do not exist in `src/stress-test/deliberation.ts` today, so this is a forward constraint on a not-yet-authorized runtime, not a correction of anything already implemented.

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

---

## 23. Relation to accepted Slice 2A/2B runtime

Nothing in this document alters, weakens, or contradicts `src/stress-test/deliberation.ts` as it stands at HEAD. Every new concept is additive and downstream: `RouteAttempt` references an existing `RouteDecision` without changing its shape; `QuestionDisposition` references an existing `UnresolvedQuestion` without mutating it; the current-question derivation (§15) is backward compatible with `unresolvedQuestions: UnresolvedQuestion[]` exactly as implemented today. No accepted invariant from Slice 2A, the Slice 2A amendment, or Slice 2B is redesigned, loosened, or reopened by this document.

---

## 24. Open GPT decisions

None. Every decision this packet asked to be closed (§22) is closed, using only source-of-truth material already in this repository (`src/stress-test/deliberation.ts`, `src/stress-test/session.ts`, `MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md`) and the packet's own explicit instructions. No contradiction between governing documents was found, so nothing was reported instead of resolved (§3 of the governing packet). `ReplicationResult`'s exact vocabulary (§13.C) and the `questionDispositions` migration shape (§15) were closed rather than left open, on the same minimal-closed-enum / purely-additive-field reasoning pattern this repository already uses for `StopReason` and `RootCauseCategory` — both are conceptual-only and implement nothing.

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
