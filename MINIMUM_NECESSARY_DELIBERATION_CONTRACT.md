# Minimum Necessary Deliberation — Architecture Contract (Phase 2)

Repository: `qqqq8413-cyber/ai-collab-mcp-notes`
Mode: offline architecture analysis only. 0 provider/model calls made in the production of this document.
Branch: `product/pre-submission-stress-test-mvp`.

This is an architecture-contract document. **It authorizes no implementation.** It defines the routing layer that sits between Semantic Consolidation and Human Adjudication in the Stress Test flow (`PRODUCT_RUNTIME_RECONCILIATION.md` §10, §13), answering: *what is the minimum additional deliberation necessary before this artifact can be presented to a human for defensibility adjudication?*

Source of truth used, in priority order per the governing packet: `src/stress-test/**` (code — `types.ts`, `session.ts`, `decision-record.ts`, `hash.ts`), `PRE_SUBMISSION_STRESS_TEST_MVP.md`, `PRODUCT_RUNTIME_RECONCILIATION.md`, `src/agents/collaboration.ts` / `src/modes/orchestrator.ts` / `src/agents/policy.ts` (already-shipped M2-A mechanism, read for validated reference semantics only — never copied as policy merely because it exists).

This revision corrects a frozen-input violation in the prior version's `ADD_CONTEXT` semantics (§4) and closes the three previously-open GPT decisions (§17).

---

## 1. Executive decision

CHIEF's underlying deliberation engine (already on `main`) and the Pre-Submission Stress Test product (Slice 1, already architecture-accepted) converge through a routing layer, not a merge of one into the other. That layer decides, for each material unresolved question in a Stress Test session, the single least costly action among six routes — `STOP`, `ADD_CONTEXT`, `ADD_REVIEWER`, `REPLICATE`, `SEEK_EVIDENCE`, `TARGETED_PEER_CHALLENGE` — that plausibly resolves the actual information deficit, or the finding that no such action is justified. The router never acquires a model output merely because a model output is available, and nothing it does ever creates revision authority: that remains, unconditionally, `HumanAdjudication.actionChange = YES → RevisionAction` (§10). Where a route's answer depends on information only the author can supply, the router crosses a session-version boundary rather than mutating frozen input (§4) — Slice 1's already-hardened freeze guarantees are never weakened by this layer.

This document is the architecture specification for that layer. It is not implemented here, and no part of `src/**`, tests, or `StressTestSession` is changed by it.

---

## 2. Scope / non-goals

Phase 2 does **not**:
- implement provider-backed Review Acquisition,
- add routes to `src/**`,
- modify `StressTestSession`,
- change schemas,
- add a database,
- add UI,
- implement session versioning or an unfreeze API,
- execute M2-B,
- restart CBRP,
- validate product effectiveness,
- prove multi-agent superiority,
- re-review CASE-001,
- alter `HumanAdjudication` authority,
- decide exact provider/model selection,
- enable collaboration by default.

---

## 3. Definitions

- **Deliberation** — any additional information-gathering or analysis step, beyond the findings already recorded in a session, undertaken specifically to reduce a *material* unresolved question before Human Adjudication.
- **Route** — one of the six discrete actions the router may select: `STOP`, `ADD_CONTEXT`, `ADD_REVIEWER`, `REPLICATE`, `SEEK_EVIDENCE`, `TARGETED_PEER_CHALLENGE` (§4).
- **Material** — see §6. A question is material only if resolving it has a plausible consequence path to Human Adjudication, artifact defensibility, potential `RevisionAction`, evidence state, or risk state.
- **Root-cause category** — the classification of *why* an unresolved material question remains open, used to select a route deterministically (§5): `CONTEXT_GAP`, `EVIDENCE_GAP`, `STABILITY_QUESTION`, `COVERAGE_GAP`, `DECISION_SENSITIVE_CONFLICT`, or `NONE`.
- **RoutingState** (conceptual, §8) — the aggregate that tracks what has been decided and spent during deliberation for one session; not implemented in this phase.
- **Incremental Material Finding Rate (IMFR)** — a conceptual signal (§7): the proportion of a route's output that turns out to be a genuinely new material item versus redundant or non-material. A routing signal only — never an authorization signal.
- **Last defensible checkpoint** — the most recent state of the review (findings, issues, adjudications) known to be internally consistent and not corrupted by a failed or partial deliberation step. Every fallback rule (§13) protects this checkpoint.

---

## 4. Six-route contract

Every route shares one refusal rule, stated once here rather than six times: **a route does not execute without a recorded, materiality-justified `RouteReason` (§6, §8) naming the specific unresolved item it targets.** "Another model output is available" is never sufficient justification on its own.

### STOP

| | |
|---|---|
| Purpose | Declare that no further machine deliberation is justified; hand control to Human Adjudication. |
| Eligibility | No unresolved material item remains, **or** remaining disagreement is non-material (§6), **or** estimated marginal information value (§7) is below threshold, **or** the cost/latency budget (§12) is exhausted, **or** no other route is eligible. |
| Required inputs | Current unresolved-item list, current evidence-state summary, cost/latency spent so far. |
| Expected information gain | None — `STOP` is defined to acquire no new information. |
| Allowed to solve | The "should deliberation continue" question itself. |
| Not allowed to solve | Correctness. `STOP` must never be read as "everything is correct" — only as "no more machine deliberation is justified before a human decides." |
| Output contract | A `StopReason` (§11) plus the exact unresolved-item snapshot handed to Human Adjudication. |
| Provenance | References every remaining unresolved `ReviewFinding`/`SemanticIssue` id, unfiltered. |
| Cost / latency | Zero incremental cost. |
| Stopping / re-evaluation | Terminal for the current deliberation loop — `STOP` *is* the re-evaluation's output, not an input to a further step. |
| Failure / fallback | `STOP` cannot itself fail; it is always *reachable* as the outcome of §13's fallback rule, though never *automatic* after every other route's failure — see §13. |

### ADD_CONTEXT

| | |
|---|---|
| Purpose | Resolve a material question whose root cause is information only the author/client can supply — never guessed by another model call, and never resolved by mutating frozen input. |
| Eligibility | An unresolved material item's root cause is classified `CONTEXT_GAP`: an ambiguity of intent, a missing constraint, or a missing non-public fact that cannot legitimately be inferred from the artifact itself. |
| Required inputs | A `ContextRequest`, conceptually containing: the originating session id, the originating `artifactHash` and `authorContextHash`, the originating `ReviewFinding.id`/`SemanticIssue.id`, the target `AuthorContext` category, the exact unresolved question, and the reason the information cannot legitimately be inferred. |
| Expected information gain | An **authoritative declaration** from the author — not an externally verified fact (see "Authoritative declaration vs. externally verified fact" below). |
| Allowed to solve | Ambiguity of intent; missing constraints; missing non-public facts. |
| Not allowed to solve | Externally verifiable factual claims, including ones embedded inside an author's own answer (→ `SEEK_EVIDENCE`; see below); genuine reviewer disagreement over already-available material (→ `ADD_REVIEWER` / `TARGETED_PEER_CHALLENGE` / `REPLICATE`). |
| Output contract | A `ContextRequest` is emitted. **The currently frozen `StressTestSession` is never mutated.** If answered, the answer does not append to the existing session — it seeds a new session version (see below). If declined, the `ContextGap` is recorded as unresolved against the existing, still-frozen session. |
| Provenance | The `ContextRequest` references the originating `ReviewFinding.id`/`SemanticIssue.id`; a supplied answer's resulting `AuthorContextItem` carries standard provenance (`sourceType: AUTHOR`, `status: CURRENT`) **inside the new session version**, not the old one. |
| Cost | **No provider call** for the request/response itself — answered by a human, not spent against any model-call budget. Producing the new frozen session version (freezing, hashing) is bookkeeping, not a deliberation call. |
| Latency | Bounded by human response time, not model latency. |
| Stopping / re-evaluation | If answered: a new session version is created and frozen (below), and routing re-evaluates from scratch **against the new session's frozen hashes.** If declined: routing re-evaluates from scratch against the **existing, unchanged** session, with the `ContextGap` now flagged unresolved. |
| Failure / fallback | No response supplied → preserve the current session exactly; preserve the `ContextGap` as unresolved; the route may lead toward `STOP` with `StopReason: unresolved_but_human_decidable` or another applicable reason (§11) — never guessed, never silently dropped, and never used as a reason to mutate the frozen session. |

#### ADD_CONTEXT is a cross-session / version-boundary route

This is the primary correction in this revision. Slice 1's already-accepted runtime permits `addAuthorContextItem` **only** while `session.state === DRAFT` (`src/stress-test/session.ts`), and `freezeInput` permanently binds `artifactText`, `authorContext`, `artifactHash`, and `authorContextHash` together (`PRE_SUBMISSION_STRESS_TEST_MVP.md`, "Frozen-input runtime integrity"); `verifyFrozenInputIntegrity` fails closed on any post-freeze mutation. **`ADD_CONTEXT` does not, and architecturally cannot, mutate a frozen session's `AuthorContext` in place.** A prior version of this contract described the author's answer as becoming "a new `AuthorContextItem`" inside the same session with routing continuing "inside the same session" — that language is corrected here because it silently implied either an unfreeze API or a direct mutation of frozen input, neither of which exists or is authorized. No unfreeze API is introduced by this correction, and no `StressTestSession` versioning mechanism is implemented — the flow below is conceptual only, per §18.

```
Frozen Session A  (artifactHash_A, authorContextHash_A)
 |
 v
CONTEXT_GAP identified on Session A
 |
 v
ADD_CONTEXT  ->  ContextRequest (references Session A + its hashes)
 |
 +----------------------------+-------------------------------------+
 |                                                                   |
 v                                                                   v
human supplies context                                human declines / does not respond
 |                                                                   |
 v                                                                   v
new DRAFT Session B                                    Session A remains current;
 (same artifactText, unless the                        ContextGap recorded unresolved;
  artifact itself was also                              routing re-evaluates against A
  intentionally revised)                                 and may proceed toward STOP
 |
 v
add the new AuthorContextItem to Session B while DRAFT
 |
 v
freeze Session B  ->  (artifactHash_B, authorContextHash_B)
 |
 v
review/deliberation proceeds against Session B, the new current frozen input
 |
 v
Session A remains an immutable historical version — never deleted, never
silently superseded in place
```

#### Prior findings across a context-version change

`ReviewFinding`/`SemanticIssue` results produced against `artifactHash_A`/`authorContextHash_A` must **not** silently become current review results under `artifactHash_B`/`authorContextHash_B` merely because Session B reuses the same `artifactText`. This contract adopts the conservative rule for Phase 2:

```
new AuthorContext version
  → new frozen session (Session B)
  → Session A's review outputs remain historical lineage / prior-version evidence
  → new current review state must be produced or explicitly re-bound against
    Session B's own hashes
```

No optimization for partial reuse (e.g. automatically carrying forward findings that did not depend on the changed context) is designed in this phase. A later, separately authorized implementation phase must explicitly determine what, if anything, may be carried forward versus what must be re-reviewed under Session B.

#### Authoritative declaration vs. externally verified fact

An author's answer to a `ContextRequest` is **authoritative as a declaration** of author intent, client constraints, non-public requirements, declared assumptions, or declared organizational facts — the product does not second-guess whether the author meant what they said. It is **not** automatically proof of externally verifiable factual truth. If an author-supplied answer itself contains an externally verifiable material factual claim, that claim may still be classified `EVIDENCE_GAP` and routed to `SEEK_EVIDENCE` on its own merits. Being author-supplied changes the claim's provenance and epistemic status (an author declaration, not a reviewer inference) — it does not exempt an embedded factual claim from the same evidence-state vocabulary every other claim in the session is scored against.

### ADD_REVIEWER

| | |
|---|---|
| Purpose | Expand review perspective: obtain an independent reviewer role/lens not already represented, to check for a plausible blind spot. |
| Eligibility | A material `COVERAGE_GAP` is identified — a domain or lens no existing `ReviewFinding` addresses. **Not** eligible merely because existing reviewers disagree, or because many findings already exist. |
| Required inputs | Description of the missing perspective, and which existing `ReviewFinding`/`SemanticIssue` id(s) motivate needing it. |
| Expected information gain | A genuinely new class of finding, not otherwise obtainable from reviewers already consulted. |
| Allowed to solve | Coverage gaps. |
| Not allowed to solve | Robustness of an *existing* finding (→ `REPLICATE`); a disagreement already on the table between two specific findings (→ `TARGETED_PEER_CHALLENGE`). |
| Output contract | New `ReviewFinding[]`, added with the same shape and append-only semantics as any other finding — no special-casing, no materiality field. |
| Provenance | New findings carry a new, distinct `reviewerRunId`; each finding's own `artifactLocation`/`evidenceState`/etc. is independently recorded exactly as today. |
| Cost | One reviewer-pass acquisition. See §15 for why this contract treats "acquire one reviewer pass" as one deliberation unit without authorizing any acquisition mechanism here. |
| Latency | One reviewer-pass latency. |
| Stopping / re-evaluation | After new findings land, routing re-evaluates every unresolved item, including the new ones, from scratch. |
| Failure / fallback | Acquisition fails → preserve prior findings unchanged; record the failure; do not auto-retry (a retry is a fresh routing decision, not an automatic loop). |

**Reviewer-role-space note (GPT Decision 2, closed — §17):** the existing CHIEF registry roster (`business_strategist` / `market_researcher` / `brand_creative`, `src/agents/registry.ts`) is registry **infrastructure**, not the Stress Test product's reviewer-role **ontology**. `ADD_REVIEWER`'s eligible reviewer-role space is not permanently fixed to that roster; it must be extensible and artifact-appropriate, driven by whatever coverage gap (§5) an artifact actually presents. A later implementation phase may adapt the existing registry mechanism as infrastructure, but its current three roles are not treated as authoritative product taxonomy by this contract. The final reviewer taxonomy itself is not designed in this phase.

### REPLICATE

| | |
|---|---|
| Purpose | Test the robustness of an **existing** finding: is it stable under independent re-execution of substantially the same review role/method, or is it stochastic/idiosyncratic? A diagnostic route, not a source of feature value in itself. |
| Eligibility | A specific `ReviewFinding`/`SemanticIssue`'s materiality hinges on `STABILITY_QUESTION` — whether it reproduces — not on whether a different perspective would find something else. |
| Required inputs | The `ReviewFinding`/`SemanticIssue` id under test, and the same role/method used to produce it originally, independently re-executed. |
| Expected information gain | A stability signal (reproduced / not reproduced / partial) about one existing finding. |
| Allowed to solve | "Is this finding real, or an artifact of one stochastic pass." |
| Not allowed to solve | Perspective coverage (→ `ADD_REVIEWER`); disagreement between two *different* reviewers (→ `TARGETED_PEER_CHALLENGE`). |
| Output contract | A `ReplicationOutcome` attached to the original finding/issue's provenance chain — not a new, independently-competing `ReviewFinding`. |
| Provenance | References the original id under test plus the new attempt's own run id. |
| Cost | One additional pass — same cost profile as `ADD_REVIEWER`, but produces a stability signal, not a new finding. |
| Latency | One reviewer-pass latency. |
| Stopping / re-evaluation | The original finding's routing-relevant confidence is updated (a non-reproduced finding may drop out of "material"); re-evaluate from scratch. |
| Failure / fallback | Replication attempt fails → preserve the original finding exactly as it was; a failed *check* never discredits what it failed to check. |

Explicit non-import: `REPLICATE` does not import M2-B's D1-arm mechanics (byte-identical-except-treatment construction for measuring one arm against another). That is a research measurement technique for comparing experimental arms, not a product routing mechanism, and stays on `experimental/m2a-peer-challenge` per `PRODUCT_RUNTIME_RECONCILIATION.md` §3.

### SEEK_EVIDENCE

| | |
|---|---|
| Purpose | Resolve a material question that depends on an externally verifiable factual claim, when the frozen artifact/context is insufficient. |
| Eligibility | The relevant claim's `evidenceState` is `UNSUPPORTED_IN_MATERIAL` or `PARTIALLY_SUPPORTED`, **and** the missing support is a factual/evidentiary gap (`EVIDENCE_GAP`) rather than a matter of interpretation. |
| Required inputs | The specific claim needing verification and the `ReviewFinding`/`SemanticIssue` id it came from. |
| Expected information gain | An `evidenceState` transition for one claim. |
| Allowed to solve | Factual/evidentiary gaps — including a factual claim embedded inside an author's own `ADD_CONTEXT` answer (§4). |
| Not allowed to solve | Interpretive disagreement; perspective gaps; stability questions. Explicitly distinguished: *"I need another interpretation"* is never this route; *"I need an external fact"* is. |
| Output contract | An evidence-lookup result recorded against the claim's provenance. Does not change the evidence-state vocabulary itself (still `SUPPORTED_IN_MATERIAL` / `PARTIALLY_SUPPORTED` / `UNSUPPORTED_IN_MATERIAL` / `NOT_APPLICABLE`, per `PRE_SUBMISSION_STRESS_TEST_MVP.md`). Per-stage retrieval control is a `PORT_CANDIDATE` mechanism (`PRODUCT_RUNTIME_RECONCILIATION.md` §3) that a later, authorized implementation phase may use here — **no retrieval is performed in this document.** |
| Provenance | References the claim's originating `ReviewFinding.id`/`SemanticIssue.id` and `artifactLocation`. |
| Cost | One evidence-lookup call. |
| Latency | Retrieval latency — potentially higher and more variable than a plain model call. |
| Stopping / re-evaluation | After the lookup, re-evaluate whether the item remains material given the new evidence state. |
| Failure / fallback | Lookup fails or is inconclusive → mark the `EvidenceGap` unresolved (never guessed, never silently treated as permanently unsupported) and surface it at `STOP`. |

### TARGETED_PEER_CHALLENGE

| | |
|---|---|
| Purpose | Resolve an explicit, material, decision-sensitive conflict between two specific review claims via a bounded, provenance-bound direct response. |
| Eligibility | A `DECISION_SENSITIVE_CONFLICT`: explicit material tension between two review claims/recommendations; the conflict is decision-sensitive; source and target are provenance-bound to specific `ReviewFinding`/`SemanticIssue` identities (never "the general vibe of disagreement"); a direct bounded response has a plausible chance to resolve, falsify, strengthen, or materially qualify the issue. |
| Required inputs | Target id, source (challenging) id, the specific tension, a provenance-bound excerpt. |
| Expected information gain | A rebuttal, concession, qualification, or reasoned refusal to yield — any of which moves the conflict from generic disagreement to something concretely adjudicable. |
| Allowed to solve | Exactly one decision-sensitive conflict between two identified claims. |
| Not allowed to solve | General "run everything past everyone" review; missing perspective (→ `ADD_REVIEWER`); stability (→ `REPLICATE`); external fact-checking (→ `SEEK_EVIDENCE`). Must never become a default or automatic route merely because two findings exist. |
| Output contract | A challenge-response record: the target's own prior position (referenced, not re-typed), the exact opposing finding/issue/source reference, a bounded excerpt, and the original constraints necessary to answer the challenge. **Not full transcript sharing.** The *shape* of this contract follows the same principle already validated on `main`'s `buildPeerExcerpt`/`buildRound2Prompt` (targeted context only) — reused as a principle, not as the current implementation or its eligibility wording (`PRODUCT_RUNTIME_RECONCILIATION.md` §6). |
| Provenance | Bound to product-domain identities — `ReviewFinding.id` / `SemanticIssue.id` / `artifactLocation` — **never** to paragraph-local chunk ids as the authoritative reference (§9). |
| Cost | One targeted-response call. |
| Latency | One call's latency. |
| Stopping / re-evaluation | Re-evaluate whether the conflict is resolved, still open, or has surfaced a new one; does not automatically cascade into a second challenge (bounded by §11). |
| Failure / fallback | Call fails, or the reference cannot be resolved → preserve the pre-challenge issue state exactly; never fabricate a resolution. A response that succeeds but is unconvincing is not promoted into an authoritative final state by itself — it becomes additional input for Human Adjudication (§10), the same boundary that binds any future Decision-Synthesis-shaped reconciliation of the exchange. |

---

## 5. Routing precedence / decision model

Routes are not chosen from an unordered menu. Every unresolved material item is first classified by **root-cause category** (§3), and, for a single item, that category deterministically selects the route via **causal deficit resolution**: before treating a disagreement as a genuine conflict worth challenging, resolve whatever would make the conflict ill-posed in the first place.

| Priority | Root-cause category | Route | Why this precedence |
|---|---|---|---|
| 1 (first) | `CONTEXT_GAP` | `ADD_CONTEXT` | Costs no model call and is the most authoritative possible answer; resolving it can dissolve downstream gaps for free, so it is checked before any route that spends a call. |
| 2 | `EVIDENCE_GAP` | `SEEK_EVIDENCE` | A disagreement whose root is an unresolved external fact is checked before it is assumed to be a genuine interpretive conflict — the "disagreement" may evaporate once the fact is known. |
| 3 | `STABILITY_QUESTION` | `REPLICATE` | Before spending a call acquiring a new perspective or staging a challenge based on an existing finding, confirm the finding is even reproducible. |
| 4 | `COVERAGE_GAP` | `ADD_REVIEWER` | Broadens perspective only once the existing material's own reliability is not itself in question. |
| 5 (last) | `DECISION_SENSITIVE_CONFLICT` | `TARGETED_PEER_CHALLENGE` | Used only once none of the four prior deficits is the actual root cause — a genuine conflict between two specific, already-stable, well-evidenced findings that context, evidence, or stability checks cannot dissolve. |
| — | `NONE` | `STOP` | No material root cause remains. |

This ordering is **causal deficit resolution**, not a cost ranking: each earlier category is checked first because leaving it unresolved would make a `TARGETED_PEER_CHALLENGE` ill-posed — challenging a finding whose instability, missing context, or missing evidence is the actual problem wastes the challenge. No claim is made that `TARGETED_PEER_CHALLENGE` is the most expensive route per unit of information gained; no repository evidence establishes a cost ordering across routes, and this precedence does not depend on one.

**This is a single-item precedence table, not a whole-session priority queue.** It resolves the order in which root causes are checked for *one* unresolved item. When multiple, unrelated material items are simultaneously eligible for different routes, the table above is not consulted first — instead:

1. Rank the competing items by their **plausible material consequence** (§6): correctness, factual defensibility, decision impact, compliance/risk impact, audience impact, and likely revision consequence. No numeric severity score is computed — this is a qualitative ranking based on which item's resolution plausibly matters more to Human Adjudication.
2. Address the higher-consequence item first, regardless of which root-cause category it happens to classify under.
3. Only when two or more items are **materially comparable** (no clear higher-consequence item) does the causal-deficit-resolution table above serve as a deterministic tie-break.

This prevents a low-impact `CONTEXT_GAP` from blocking an unrelated high-impact `EVIDENCE_GAP` or conflict merely because `CONTEXT_GAP` holds causal priority 1 — causal priority governs *one item's own* root-cause checking order, never cross-item scheduling.

**Governing principle, restated:** prefer the least costly action that resolves the actual information deficit, for the highest-consequence unresolved item currently eligible. This answers the standing precedence questions directly:
- *Author Context missing AND reviewers disagree, on the same item* → `ADD_CONTEXT` first (causal priority 1); the disagreement may dissolve once context is supplied.
- *Reviewers disagree because an external fact is unknown, on the same item* → `SEEK_EVIDENCE` (causal priority 2) is preferred over `TARGETED_PEER_CHALLENGE` (causal priority 5); it was never a genuine interpretive conflict if an unknown fact is the root cause.
- *`REPLICATE` vs. `ADD_REVIEWER`, on the same item* → `REPLICATE` (causal priority 3) precedes `ADD_REVIEWER` (causal priority 4): diagnose whether an existing finding is real before spending a call looking for a different one.
- *When does unresolved disagreement simply `STOP`* → when its root cause classifies `NONE`, when no route remains eligible, when marginal information value (§7) is below threshold, or when budget (§12) is exhausted.
- *Can one route make another newly eligible* → yes, by construction: after every route completes (success or failure), **all** currently-unresolved material items are re-classified from scratch, not resumed from a fixed plan.
- *Can routes repeat* — only under §11's bounded-iteration ceiling, and only via a fresh, independently justified `RouteDecision` (§8) — never an automatic retry, per §13.
- *Does a low-impact item block a high-impact one* → no: cross-item scheduling is governed by material consequence (above); causal-deficit-resolution applies only within one item's own routing.

---

## 6. Materiality model

A question is material only if it has a plausible consequence path to at least one of:

- **Artifact correctness** — the artifact's stated facts or logic,
- **Factual defensibility** — whether the author can defend a claim if challenged,
- **Decision/recommendation impact** — whether the artifact's core recommendation changes,
- **Compliance/risk impact** — legal, regulatory, or organizational risk,
- **Audience/user impact** — consequences for whoever receives or acts on the artifact,
- **Revision consequence** — whether an edit to the artifact would plausibly follow.

and, through one of those dimensions, a plausible consequence path to: `HumanAdjudication`, artifact defensibility, a potential `RevisionAction`, evidence state, or risk state.

Two reviewers phrasing a recommendation differently is **not** material by itself — it must trace to one of the dimensions above. A route is never required to guarantee it will eventually produce `actionChange = YES`; that decision belongs to the human (§10), not to the materiality test that merely justifies *attempting* a route.

---

## 7. Marginal information value model

No numeric score is invented here; no repository evidence (one live replay, one fixture) justifies one. Instead, a conceptual set of observable inputs a future router could weigh:

- unresolved material `SemanticIssue`/`ReviewFinding` count and state,
- evidence completeness (`evidenceState` distribution),
- reviewer independence/diversity already represented,
- prior agreement/disagreement pattern,
- source provenance quality,
- missing Author Context,
- potential decision impact (§6),
- previous route outcome,
- cost already spent (§12),
- latency already spent (§12),
- rate of repeated non-material findings.

**Incremental Material Finding Rate (IMFR)** — conceptually, the proportion of a route's newly acquired output judged material versus redundant/non-material. A declining IMFR across successive routes on the same session is a *signal* that continued deliberation has diminishing returns, making `STOP` more justified — never a hard rule, and never numerically fixed here.

This is explicitly distinguished from revision authorization: **a new or material finding never authorizes a `RevisionAction`.** IMFR feeds only the routing decision (§5); the human-authority boundary (§10) is untouched by any value this model computes.

---

## 8. Routing state / conceptual data contract

No schema is implemented here. This identifies the minimum coherent set of concepts a later, authorized phase would need, and states explicitly which existing Stress Test types are reused as-is versus which concepts are new.

**Reused as-is, unchanged:** `ReviewFinding`, `SemanticIssue`, `AuthorContext` / `AuthorContextItem`, `HumanAdjudication`, `RevisionAction`, `RevisionSourceRef`, `DecisionRecord`, `StressTestSession`. None of these are modified by this contract.

### `DeliberationState` (GPT Decision 3, closed — §17)

`DeliberationState` is a **separate aggregate**, not a field on `StressTestSession`. It references a `StressTestSession` by id; it does not duplicate that session's domain truth.

Required conceptual binding — a `DeliberationState` carries at minimum:
- `sessionId` (the `StressTestSession` it is bound to),
- `artifactHash` and `authorContextHash` (the exact frozen-input hashes it is bound to — see fail-closed rule below),
- route history (`DeliberationHistory`, an ordered list of `RouteDecision`s),
- cost/latency accounting (`CostBudget`/`LatencyBudget`),
- unresolved routing questions (`UnresolvedQuestion[]`),
- a terminal `StopReason`, if the deliberation has stopped.

`DeliberationState` must **not** own copies of `ReviewFinding`, `SemanticIssue`, `HumanAdjudication`, `RevisionAction`, or `AuthorContext` — those remain authoritative only in `StressTestSession`/the domain records themselves; `DeliberationState` references them by typed ids (`RouteInputRef`, below).

`DeliberationState` has **no revision authority, no alternate `DecisionRecord` authority, and no input-mutation authority.** If a `DeliberationState`'s bound `sessionId`/`artifactHash`/`authorContextHash` do not match the `StressTestSession` it is asked to act against, routing **fails closed** — the same posture `verifyFrozenInputIntegrity` already takes for tampered input (`src/stress-test/session.ts`).

Rationale: this preserves Slice 1's already-hardened aggregate untouched, isolates all Phase 2 routing bookkeeping from it, prevents reopening frozen-input semantics, keeps `DecisionRecord` as the sole audit projection (§14), and avoids duplicating product-domain truth in a second place.

### Other new concepts a later phase would design

| Concept | Role |
|---|---|
| `RouteDecision` | One routing decision: `{ route, reason, inputRefs, outcome, timestamp }`. |
| `RouteReason` | The root-cause classification (§5's five categories or `NONE`) plus the materiality justification (§6). |
| `RouteInputRef` | A reference to whatever motivated the route — modeled directly on the already-hardened `RevisionSourceRef` discriminated-union pattern (`{ kind: 'FINDING' \| 'SEMANTIC_ISSUE' \| 'AUTHOR_CONTEXT_ITEM', id }`), never inferred from the shape of `id`. |
| `RouteOutcome` | What the route produced: new finding id(s) for `ADD_REVIEWER`; a `ReplicationOutcome` for `REPLICATE`; an evidence-lookup result for `SEEK_EVIDENCE`; a challenge-response record for `TARGETED_PEER_CHALLENGE`; a `ContextRequest`/new-session-version reference or unresolved gap for `ADD_CONTEXT` (§4); a `StopReason` for `STOP`. |
| `UnresolvedQuestion` | A still-open material item after routing concludes, referencing the `ReviewFinding`/`SemanticIssue` id and the root-cause category that left it unresolved. |
| `CostBudget` / `LatencyBudget` | `{ spent, ceiling }` pairs, tracked at both route and session level (§12). |
| `DeliberationHistory` | The ordered list of `RouteDecision`s held inside `DeliberationState` — the audit input for a future `DecisionRecord` mapping (§14), not a replacement for it. |
| `StopReason` | One of the values enumerated in §11. |

`EvidenceGap`, `ContextGap`, and `DisagreementRef` are **not** separate first-class entities — they are the concrete shapes `RouteReason`'s root-cause classification takes, each carrying a reference back to an existing `ReviewFinding`/`SemanticIssue`/`AuthorContext` identity. Introducing them as independent persisted types would create a second identity system alongside the existing domain entities, which §9 explicitly rejects.

### Version lineage (cross-session boundary)

Because `ADD_CONTEXT` (§4) can conclude by creating a new `StressTestSession` version rather than mutating the current one, a future implementation phase needs a minimal lineage record. Not designed or schematized here — only its required conceptual content:
- `previousSessionId`,
- `newSessionId`,
- `reason` (`= ADD_CONTEXT` for this route),
- the previous `artifactHash` and `authorContextHash`,
- the new `artifactHash` and `authorContextHash`.

The exact persisted type or name for this record is **not chosen here**, and no schema or implementation proposal beyond this conceptual list is made. A `DeliberationHistory` for a session that ends in an `ADD_CONTEXT` version transition would reference this lineage record rather than silently treating Session B's history as a continuation of Session A's — a future `DecisionRecord` mapping (§14) would need to decide how to present a multi-version history to a human, which is also not designed here.

---

## 9. Provenance contract

Every route binds to product-domain identities: `ReviewFinding.id`, `SemanticIssue.id`, `AuthorContext`/`AuthorContextItem` identity, `artifactLocation`, and the frozen `artifactHash`/`authorContextHash`. Paragraph-local chunk identity (`p1`/`p2`/...) is **never** the product-level provenance identity — it may remain an internal excerpting aid (for example, constructing a bounded excerpt inside a `TARGETED_PEER_CHALLENGE` output), but the authoritative reference is always a domain-entity id.

Required fallback, uniform across every route: **an invalid or unresolved reference means the route cannot execute.** The router preserves the last defensible state, records an auditable failure with its reason, and never fabricates a mapping. This is a direct continuation of a pattern already validated in Slice 1's code today — `createSemanticIssue`, `adjudicate`, and `planRevisionAction` already throw on an unknown id rather than guessing (`src/stress-test/session.ts`) — not a new philosophy invented for this contract.

Findings are bound to the exact `artifactHash`/`authorContextHash` pair under which they were produced (§4's version-boundary rule for `ADD_CONTEXT`). A reference that would cross a version boundary without going through the lineage record (§8) is treated the same as any other invalid reference — the route cannot execute, and nothing is guessed.

---

## 10. Human authority boundary

Binding, unconditional, and unaffected by anything else in this document.

Machine deliberation **may**:
- discover findings,
- challenge findings,
- seek evidence,
- request context,
- qualify a `SemanticIssue`,
- preserve unresolved disagreement,
- recommend that a question needs human judgment.

Machine deliberation **may not**:
- create revision authority,
- mark `actionChange = YES` on behalf of the human,
- independently authorize a `RevisionAction`,
- treat consensus as `HumanAdjudication`,
- bypass `HumanAdjudication`.

The boundary:

```
HumanAdjudication.actionChange = YES
  →  RevisionAction
```

Reviewer or model output — including any future Decision-Synthesis-shaped reconciliation of a `TARGETED_PEER_CHALLENGE` exchange, and including an author's own `ADD_CONTEXT` declaration (§4) — never by itself authorizes revision. This is the same gate already enforced in code today (`planRevisionAction`, hardened this session: at least one `RevisionSourceRef` must resolve to a `HumanAdjudication` with `actionChange=YES`; `judgment` values are never wired to authorize anything). Nothing in this contract weakens that gate, and no future implementation of this contract is permitted to weaken it either.

---

## 11. Stopping / iteration contract

`StopReason` — one of exactly six values:

| `StopReason` | Meaning |
|---|---|
| `successful` | No unresolved material item remains. |
| `budget` | The session's `CostBudget` ceiling was reached with material items still unresolved. |
| `latency` | The session's `LatencyBudget` ceiling was reached with material items still unresolved. |
| `no_eligible_route` | Every unresolved item classifies `NONE`, or no route remains eligible under the budgets. |
| `unresolved_but_human_decidable` | Material disagreement (or an unanswered `ADD_CONTEXT` request, §4) remains, deliberately preserved rather than forced to resolve. |
| `failure_fallback` | A route failed, and after re-classification (§13) no other route was independently justified — deliberation stopped rather than retrying blindly. |

**Bounded iteration principle:** the router re-evaluates all currently-unresolved material items from scratch after **every** route execution — success or failure — rather than following a pre-planned fixed sequence (§5). There is a session-level ceiling concept (`CostBudget`/`LatencyBudget`, §12, values not chosen here). When the ceiling is reached mid-deliberation, the router stops (`StopReason: budget` or `latency`) and surfaces **every** currently-unresolved item to Human Adjudication exactly as it stands — nothing is silently dropped for having run out of budget.

A failed optional deliberation step never erases the last defensible checkpoint (§3, §13). This prevents unbounded autonomous loops by construction: no route can "keep trying" on its own, because every re-evaluation is a fresh, materiality-justified decision (§4's shared refusal rule), not a resumption of an in-flight retry.

---

## 12. Cost / latency contract

Two independent budget dimensions, each tracked at the route level (cost of the one route about to run) and the session level (cumulative across `DeliberationHistory`):

- **`CostBudget`** — logical deliberation calls. This is explicitly **not** `transportMaxRetries` (`PRODUCT_RUNTIME_RECONCILIATION.md` §3: that API is `RESEARCH_ONLY`, built for M2-B capture accounting, and is not imported as a product primitive here). The principle it embodies — that a logical deliberation call and a transport-layer retry are distinguishable accounting concerns — is preserved; the concrete API is not.
- **`LatencyBudget`** — wall-clock time spent in deliberation, tracked separately, since `SEEK_EVIDENCE` in particular is expected to have a materially different latency profile than the other routes (retrieval latency vs. a plain model call).

No specific numeric ceiling (dollar amount, call count, or time limit) is chosen in this document (GPT Decision 1, closed — §17). **Binding invariant:** before any provider-backed Minimum Necessary Deliberation runtime is enabled, it must have explicit, finite hard ceilings for both `CostBudget` and `LatencyBudget`. An unconfigured ceiling must never be interpreted as unbounded — the absence of a configured value is a precondition failure for enabling the runtime, not a default of "no limit." The old `N + 4` shape is not adopted as that default (§15 already treats it as redesigned policy, not a number to carry forward).

The contract answers *"why did the system spend one more call here?"* structurally, not through a separate explanation system: **no route executes without a recorded `RouteReason`** (§4's shared rule, §8's `RouteDecision.reason`). The justification is the answer, and it is permanently attached to the outcome it produced.

---

## 13. Fallback semantics

Carried forward as a binding invariant: **a failed optional deliberation step must never destroy an earlier defensible checkpoint.**

**Failure does not automatically force `STOP`.** The authoritative rule, uniform across every route:

```
route failure
  → preserve the last defensible checkpoint
  → record the failure
  → re-classify all currently-unresolved material items from scratch (§5)
  → select another eligible route ONLY if independently justified
  → otherwise STOP
```

`STOP` is always *reachable* — it is the outcome when re-classification finds nothing else independently justified — but it is never *automatic* merely because a route failed. In particular, a retry of the very same route that just failed is never automatic: it requires a fresh, independently justified `RouteDecision` (§8), exactly like selecting any other route.

| Failure | Fallback |
|---|---|
| Route-planning failure (routing decision itself cannot be made) | Preserve current review state. |
| Invalid provenance reference | Skip the unsafe route entirely; never guess a mapping. |
| `ADD_REVIEWER` acquisition failure | Preserve prior findings unchanged. |
| `REPLICATE` attempt failure | Preserve prior findings unchanged. |
| `SEEK_EVIDENCE` retrieval failure | Mark the evidence gap unresolved; do not treat it as permanently unsupported. |
| `ADD_CONTEXT` no response | Preserve the current (pre-request) session exactly; mark the `ContextGap` unresolved (§4). |
| `TARGETED_PEER_CHALLENGE` failure | Preserve the pre-challenge issue state exactly. |
| Reconciliation failure (any future Decision-Synthesis-shaped step) | Do not promote the raw, unreconciled challenge response into an authoritative final state. |
| No eligible route after re-classification | `STOP`. |

Each route's own §4 entry restates the fallback specific to it; this table is the consolidated, authoritative version.

---

## 14. Audit / DecisionRecord mapping

**`DecisionRecord` is not modified in this phase.** This section is architecture only, describing how a later, separately authorized phase could extend the mapping without creating a second, competing source of truth.

A future `DecisionRecord` projection could answer, from `DeliberationHistory` (§8) alone:

- Was extra deliberation performed? — presence/absence of a `DeliberationHistory`.
- Why? — each `RouteDecision.reason`.
- Which route(s)? — each `RouteDecision.route`.
- Which issue triggered it? — each `RouteDecision.inputRefs`.
- What provenance was used? — the same `RouteInputRef`s.
- What did it cost? — `CostBudget`/`LatencyBudget` spent, summed across `DeliberationHistory`.
- Did it materially change the review state? — compare the unresolved-item set before and after.
- What remained unresolved? — the final `UnresolvedQuestion` list.
- Why did deliberation stop? — the terminal `StopReason`.
- Which Human Adjudication ultimately authorized any revision? — **already answerable today, unchanged**, via the existing `HumanAdjudication`/`RevisionAction`/`RevisionSourceRef` chain (§10).

Where a session's deliberation spans a version boundary created by `ADD_CONTEXT` (§4, §8), a future `DecisionRecord` mapping must present that lineage explicitly rather than silently attributing Session A's prior findings to Session B — this document does not design that presentation, only requires that it not be silently collapsed.

`DeliberationHistory` is described here strictly as an *audit input* to a future `DecisionRecord` projection — never a parallel or competing decision record in its own right.

---

## 15. Relation to existing M2-A

No wholesale cherry-pick. Each concept is scored independently.

| M2-A concept | Phase 2 contract role | Disposition |
|---|---|---|
| Collaboration gate | Maps loosely to the router's eligibility-evaluation step in general (not one route) | **Redesigned as policy** — root-cause classification (§5) replaces the DEEP+SUCCESS+N≥2 gate; the underlying gate *mechanism* remains a `PORT_CANDIDATE` per `PRODUCT_RUNTIME_RECONCILIATION.md` §3 |
| Provisional answer | Maps to the "last defensible checkpoint" preserved between/around routes (§3, §13) | **Reused as principle** |
| `sourceRef` (paragraph `p1`/`p2`) | Maps to internal excerpting only, never product identity (§9) | **Excluded** as product-level identity; the underlying idea of a resolvable, bounded reference is **reused as principle**, reimplemented against domain-entity ids |
| Targeted peer context | Maps directly to `TARGETED_PEER_CHALLENGE`'s output contract (§4) | **Reused as principle** |
| Round2 max-one | Maps to the bounded-iteration/ceiling contract (§11, §12) | **Redesigned as policy** — no longer "exactly one, always"; bounded and re-evaluated per §11 |
| Round2 execution | Maps to `TARGETED_PEER_CHALLENGE`'s execution step | **Reused as principle**; concrete implementation **not authorized** (`PRODUCT_RUNTIME_RECONCILIATION.md` §7) |
| Retrieval OFF (unconditional) | `SEEK_EVIDENCE` is the one route retrieval exists for | **Redesigned as policy** — retrieval is deliberately enabled for exactly the route designed for it |
| Decision Synthesis | Maps to an optional, bounded reconciliation step usable after any route, subordinate to §10 | **Redesigned as policy** on authority; mechanism **reused as principle** |
| Neutrality guard | Maps to "preserve unresolved disagreement" across every route and the `DisagreementRef`-shaped `RouteReason` classification | **Reused as principle** |
| Collaboration reporting | Maps to `DeliberationHistory` / the future `DecisionRecord` mapping (§14) | **Reused as principle** |
| Fallback semantics | Maps directly to §13 | **Reused as principle**, carried forward whole |
| Call ceiling (`N + 4`) | Maps to `CostBudget`/session ceiling (§12) | **Redesigned as policy** — a configurable budget, not a fixed formula tied to specialist count |
| Stage boundaries (`runPlanningStage`/`runRound1Stage`) | Maps to Review Acquisition being obtainable as one discrete, inspectable unit before routing decides anything | **Reused as principle**; concrete implementation **not authorized** (`PRODUCT_RUNTIME_RECONCILIATION.md` §7) |
| M2-B arms B/B′/C/D1, CBRP/duplicate-audit machinery | No mapping — out of scope for product routing | **Retained as research reference** / **Excluded**, per `PRODUCT_RUNTIME_RECONCILIATION.md` §3, §8 |

---

## 16. Invariants

1. `HumanAdjudication.actionChange = YES → RevisionAction` is the only path to revision authority. Nothing else ever authorizes it.
2. A failed optional deliberation step never destroys the last defensible checkpoint.
3. Invalid or unresolved provenance is never guessed; the route that would need it does not execute.
4. No route executes without a recorded `RouteReason`; "a model output is available" is never sufficient justification.
5. `STOP` is always reachable, but is never automatic merely because a route failed (§13).
6. Every route re-evaluates all unresolved items from scratch after completion; no automatic cascading loop.
7. Paragraph-local chunk ids are never the product-level provenance identity.
8. Retrieval is off by default for every route except `SEEK_EVIDENCE`, where it is the route's entire purpose.
9. A new or material finding is a routing signal, never a revision authorization.
10. `DeliberationHistory` is an audit input, never a second `DecisionRecord`.
11. Frozen `AuthorContext` is never modified in place.
12. `ADD_CONTEXT` cannot mutate a frozen `StressTestSession`.
13. New Author Context supplied after freeze creates a new session/version boundary (§4, §8) — it is never appended to the existing frozen session.
14. Review outputs are bound to the `artifactHash` + `authorContextHash` pair under which they were produced.
15. Old-version findings cannot silently become current findings in a new context version.
16. `DeliberationState` is bound to `sessionId` + the frozen hashes it targets, and fails closed on any mismatch.
17. An author's declaration (via `ADD_CONTEXT`) is not automatically external factual verification — an embedded factual claim may still be routed to `SEEK_EVIDENCE`.
18. Before any provider-backed Minimum Necessary Deliberation runtime is enabled, it must have explicit, finite hard ceilings for `CostBudget` and `LatencyBudget`; an unconfigured ceiling is never interpreted as unbounded.

---

## 17. Open GPT decisions

All three decisions carried as open in the prior version of this contract have been resolved and are recorded here as closed — none is reopened.

**Decision 1 — session-level `CostBudget`/`LatencyBudget` ceiling values. CLOSED.**
Resolution: Option B. Phase 2 does not freeze numeric production ceilings; `CostBudget` and `LatencyBudget` values remain policy/configuration choices for a later implementation phase, not architecture decisions made here. `N + 4` is not adopted as a default. Binding invariant added (§12, §16 #18): before any provider-backed runtime is enabled, it must have explicit, finite hard ceilings for both budgets — an unconfigured ceiling must never be interpreted as unbounded.

**Decision 2 — `ADD_REVIEWER`'s reviewer-role space. CLOSED.**
Resolution: the current CHIEF registry roster (`business_strategist` / `market_researcher` / `brand_creative`) is registry **infrastructure**, not the Stress Test product's reviewer-role **ontology** (§4). Product reviewer capabilities must be extensible and artifact-appropriate, selected by coverage gap (§5), not permanently assumed to be the three existing CHIEF roles. A later implementation phase may adapt the existing registry mechanism as infrastructure; its current roster is not authoritative taxonomy. The final reviewer taxonomy itself remains undesigned — only this framing decision is closed.

**Decision 3 — where `DeliberationState` lives. CLOSED.**
Resolution: a separate `DeliberationState` aggregate, referencing `StressTestSession` by id, never duplicating its domain truth, with no revision authority, no alternate `DecisionRecord` authority, and no input-mutation authority; it fails closed if its bound `sessionId`/hashes do not match the session it targets (§8).

No new open GPT decision is raised by this amendment. Every correction in this revision — the `ADD_CONTEXT` version-boundary semantics, the historical-findings binding rule, the authoritative-declaration/external-fact distinction, the failure-does-not-force-STOP clarification, the routing-precedence correction, and the three closures above — is fully specified by the source-of-truth material already in this repository (`src/stress-test/session.ts`, `PRE_SUBMISSION_STRESS_TEST_MVP.md`) and by GPT's decisions in the governing packet; none of it requires further architecture input to be complete.

---

## 18. Implementation authorization

Phase 2 is architecture only. **Implementation of this contract is NOT authorized by this document.** No route, no data type described in §8, no cost/latency accounting, no version-lineage mechanism, no `DeliberationState`, and no provider-backed acquisition is implemented, scaffolded, or scheduled here. Stress Test Slice 2 is **not started**. No provider-backed Review Acquisition is authorized. No provider or model calls were made in the production of this document. This remains an architecture specification only, for a later, explicitly authorized integration phase.
