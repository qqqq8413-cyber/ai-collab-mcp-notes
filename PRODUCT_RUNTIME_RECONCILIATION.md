# Product Runtime Reconciliation — Phase 1 Architecture Inventory

Repository: `qqqq8413-cyber/ai-collab-mcp-notes`
Mode: offline repository analysis only. 0 provider/model calls made in the production of this document.

Refs inspected:
- **A — main** @ `aedc9efe0ff1f4acf7d5a36d9a1b3ab87e5b9af8`
- **B — experimental/m2a-peer-challenge** @ `51cfcbec811bacbbefe0c30e217bc524324df7c8`
- **C — product/pre-submission-stress-test-mvp** @ `c267ad8a6d2ad62f7f1d8124181130dbe4558f7d`

`merge-base(A, B) == A` — B is a linear 98-commit descendant of A, never rebased. C is a separate, unrelated descendant of A (the Stress Test MVP domain layer); C and B share no commits beyond A.

This document was amended after GPT (Architecture / Decision Owner) reviewed the Phase 1 draft and issued final architecture disposition decisions. The amendments are recorded throughout; §3 carries the authoritative disposition matrix and supersedes the draft's separate PORT_CANDIDATE / RESEARCH_ONLY / REQUIRES_REDESIGN tables.

---

## 1. Executive architecture conclusion

**Two separate questions must not be collapsed into one.** The first is *where a capability's code currently lives* — already on `main`, or only on `experimental/m2a-peer-challenge`. The second is *what architecture disposition that capability has in the future CHIEF/Stress Test convergence* — whether the underlying concept is wanted, and separately, whether any concrete implementation is authorized to move anywhere right now. **"Already on `main`" answers only the first question and settles nothing about the second.** This document previously blurred that line by treating "already shipped, already tested" as if it implied "no further architecture decision needed" for some items, and by treating "new on experimental" as if it implied "portable" for others. Both were wrong, and §3 corrects it with a single authoritative matrix that scores every material capability on architecture disposition independent of where its code happens to sit today.

The empirical finding about code location stands and is worth preserving: the M2-A collaboration mechanism — the gate, targeted Round 2, decision synthesis, neutrality guard, deterministic chunk map, replay/frozen-Round1 helpers, call ceilings — **is already on `main`**, compiled into the same `src/agents/collaboration.ts` and `src/modes/orchestrator.ts` that the Stress Test branch (C) was cut from, and already covered by 105 passing tests in `test-collaboration.mjs` that run on every `npm test` today, on both A and C. It is reachable right now through the MCP tool schema (`src/index.ts`, the `experimental.collaboration` input) by any caller of the `ai-collab-mcp` tool, default OFF.

The actual `src/**` delta between A and B is 6 files, 189 changed lines, three independent changes:

1. A refactor (`runPlanningStage` / `runRound1Stage` extracted out of `runOrchestrator` in `orchestrator.ts`) — documented and tested as zero behavior change, existing purely so a caller can obtain a genuine production Round 1 without triggering synthesis. **The stage-boundary concept is architecturally endorsed (§3, §7); no concrete implementation move is authorized in this phase.**
2. An opt-in transport primitive (`transportMaxRetries` on `CallOptions`, implemented in `claude.ts`/`openai.ts`, explicitly a no-op on `gemini.ts`) — forbids SDK-level retries for a caller that needs "one logical call" to mean "one HTTP attempt." **This concrete API is RESEARCH_ONLY (§3) — it was built specifically for M2-B capture accounting and is not recommended for product/`main`.** The general principle it embodies — that logical-deliberation-call accounting and transport-retry accounting are distinguishable concerns — is preserved as a design note, separate from the API itself.
3. A prompt-wording refinement to the peer-challenge eligibility rule inside `buildGateAppendix()` in `collaboration.ts` — validated by 4 new tests and by one round of live evidence (Controlled Replay #4, §9). **This wording is retained as validated reference material on `experimental/m2a-peer-challenge`. It is explicitly not recommended for `main` now (§6): the next phase redesigns deliberation eligibility from scratch under Minimum Necessary Deliberation, and freezing the old CHIEF gate policy into `main` immediately beforehand would pre-empt that redesign.**

Everything else that makes the 98-commit history look large — `experiments/m2b/**` (CBRP census, duplicate-audit, acquisition harness, four evaluation arms, hundreds of fixture/capture files) and six large prose documents (`CURRENT_STATE.md`, `HANDOFF.md`, `M2_EFFECTIVENESS_EXPERIMENT.md`, two `GEMINI_M2B_REVIEW_PACKET*.md`, `WAVE1_PREFLIGHT_REVIEW.md`, 14,338 inserted lines combined) — is research scaffolding that, by its own design documents' explicit mandate (`M2_EFFECTIVENESS_EXPERIMENT.md` §23.4: *"harness 維持 `src/` zero-change,全部放 `experiments/m2b/`"*), never touches production source and was never live-authorized. Its disposition is unchanged by this amendment: RESEARCH_ONLY or DO_NOT_PORT (§3), and the CBRP acquisition path specifically is TERMINAL/CLOSED (§8) — a status distinct from, and not to be confused with, the still-unanswered scientific question the M2-B experiment was designed to investigate (§8).

**No concrete code, test, or prompt is authorized to move to `main` or anywhere else in this phase.** This document performs no port.

---

## 2. Three-ref reality comparison

| | A — main | B — experimental/m2a-peer-challenge | C — product/pre-submission-stress-test-mvp |
|---|---|---|---|
| Base | — | A (98 commits ahead, linear) | A (12 commits ahead, linear, unrelated to B) |
| `src/**` | Full M2 collaboration architecture (`chief.ts`, `collaboration.ts`, `orchestrator.ts`, `debate.ts`, `pipeline.ts`, `policy.ts`, `registry.ts`) — same 15 files as B | Same 15 files, 6 modified (+189/-20 lines) | Adds `src/stress-test/**` (5 new files) on top of A; the 15 collaboration/orchestrator files are byte-identical to A |
| Root tests | `test-chief.mjs`, `test-run-status.mjs`, `test-registry.mjs`, `test-mcp-smoke.mjs`, `test-execution-policy.mjs`, `test-collaboration.mjs` (105 tests) — 208 total | Same 6 files (`test-collaboration.mjs` +4 tests → 109) plus new `test-planning-stage.mjs` (26 tests) → 212 offline, plus `experiments/m2b/test-round1-boundary.mjs` wired into `npm test` | Same 6 files as A (105/208 unchanged) plus `test-stress-test-mvp.mjs` (47 tests) → 255 total |
| `experiments/m2b/**` | absent | ~600 files: CBRP census, duplicate-audit protocol, four-arm (B/B'/C/D) acquisition harness, fixtures, capture tooling — the overwhelming majority of the 98-commit line-count | absent |
| `diagnostics/m2a-live/**` | absent (has `controlled-replay/`, an earlier replay, already on A — see note below) | adds `controlled-replay-4/` (evidence for the gate-wording change) | absent |
| Governance docs | `HANDOFF.md` only | adds `CURRENT_STATE.md`, `M2_EFFECTIVENESS_EXPERIMENT.md`, `GEMINI_M2B_REVIEW_PACKET.md`, `GEMINI_M2B_REVIEW_PACKET_2.md`, `WAVE1_PREFLIGHT_REVIEW.md`; extends `HANDOFF.md` | `HANDOFF.md` only |
| MCP surface (`src/index.ts`) exposure of collaboration | `experimental.collaboration.*` schema present, default OFF | identical | identical (untouched — C never touches these files) |
| Provider calls to produce this document | 0 | 0 | 0 |

Note on `diagnostics/m2a-live/controlled-replay/` (no `-4` suffix): this is an earlier replay (`#3`) already present on `main`. `experimental/m2a-peer-challenge` reuses its five fixtures byte-for-byte for Replay #4 rather than authoring new ones (`README.md` line 19: *"五份 fixture 直接取自 Replay #3,沒有修改"*) — one more point of evidence that the collaboration/replay mechanism itself predates this branch's delta.

**Source-of-truth discipline note:** `CURRENT_STATE.md`'s own `stateVerifiedThrough` field pins it to `ffbe0b26e5a8ddd927d0ff936d16fccee18dcbeb` — a commit *before* the collaboration-wording change, the `transportMaxRetries` primitive, and Controlled Replay #4 all landed. The document says so itself: *"CURRENT_STATE.md 對 live branch HEAD 不具權威性"* (not authoritative for the live branch HEAD). This inventory's classification is built from `git diff`, test files, and the `diagnostics/m2a-live/controlled-replay-4/` artifacts — never from that stale prose. This is worth flagging because it is a concrete, present-tense instance of the failure mode the governing packet's source-of-truth rule warns against, not a hypothetical one.

---

## 3. Authoritative capability disposition matrix

This is GPT's final Phase 1 disposition. It is applied literally, not reinterpreted. Two columns are kept separate throughout this document: **current code location** (a fact about this repository today) and **architecture disposition** (GPT's decision about the concept's future). A row can be `PORT_CANDIDATE` at the concept level while its concrete implementation remains unauthorized to move — that distinction is preserved explicitly wherever it applies, most importantly for the two items marked `NOT AUTHORIZED IN THIS PHASE`.

| Capability (concept) | Current code location | Architecture disposition |
|---|---|---|
| Collaboration gate mechanism | Already on `main` (`synthesis_gate` stage, `runSynthesisStage`) | **PORT_CANDIDATE** |
| Current eligibility policy (DEEP + SUCCESS + N≥2) | Already on `main` / exercised as-is in Replay #4 | **REQUIRES_REDESIGN** |
| Provisional answer / "last defensible checkpoint" | Already on `main` (`provisionalAnswer`, `AnswerSource`) | **PORT_CANDIDATE** |
| Deterministic provenance / source-reference principle | Already on `main` (`segmentAll`, `resolveSourceRef`) | **PORT_CANDIDATE** |
| Current paragraph-based `p1`/`p2`/... source identity | Already on `main` | **REQUIRES_REDESIGN** |
| Targeted peer context | Already on `main` (`buildPeerExcerpt`, `buildRound2Prompt`) | **PORT_CANDIDATE** |
| Bounded Round2 / prohibition on unbounded autonomous deliberation loops | Already on `main` | **PORT_CANDIDATE** |
| Universal/permanent max-one Round2 policy | Already on `main` (`selectIssue`, "at most one `peer_challenge`") | **REQUIRES_REDESIGN** |
| Round2 execution capability | Already on `main` (`round2_worker` stage) | **PORT_CANDIDATE** |
| Per-stage retrieval control | Already on `main` (`retrieval` on `CallOptions`, evidence-capable gating) | **PORT_CANDIDATE** |
| M2-A unconditional Round2 retrieval-OFF policy | Already on `main`; re-verified live in Replay #4 | **RESEARCH_ONLY / REQUIRES_REDESIGN** |
| Post-challenge Decision Synthesis mechanism | Already on `main` (`decision_synthesis` stage) | **PORT_CANDIDATE** |
| Decision Synthesis as final decision authority | Already on `main`'s current wiring (nothing downstream re-gates it against a human) | **REQUIRES_REDESIGN** — see §5 for the binding boundary |
| Neutrality principle (no forced consensus) | Already on `main` | **PORT_CANDIDATE** |
| Prompt-only neutrality enforcement | Already on `main` (the guarantee is instructional text, not a structural check) | **REQUIRES_REDESIGN** |
| Collaboration reporting / observability concepts | Already on `main` (`CollaborationReport`, timings) | **PORT_CANDIDATE** |
| Fallback semantics (gate/R2/decision failure paths) | Already on `main` | **PORT_CANDIDATE** |
| Bounded call / termination ceiling principle | Already on `main` | **PORT_CANDIDATE** |
| Fixed `N + 4` as a universal, product-wide policy | Already on `main` (`policy.ts`) | **REQUIRES_REDESIGN** |
| `runPlanningStage` / `runRound1Stage` stage-boundary concept | New on B (`orchestrator.ts`) | **PORT_CANDIDATE** (concept) |
| Concrete implementation port of `runPlanningStage` / `runRound1Stage` | New on B, not on `main` or C | **NOT AUTHORIZED IN THIS PHASE** |
| `transportMaxRetries` | New on B (`types.ts`, `claude.ts`, `openai.ts`) | **RESEARCH_ONLY** |
| `Round1Snapshot` / `replaySynthesis` / frozen experimental replay helpers | Already on `main` | **RESEARCH_ONLY** |
| Controlled replay diagnostics and evidence artifacts (`diagnostics/m2a-live/controlled-replay-4/*`) | New on B, evidence only | **RESEARCH_ONLY** |
| M2-B arms B / B′ / C / D1 (`experiments/m2b/harness/arms.mjs` and dependents) | New on B | **RESEARCH_ONLY** |
| CBRP / duplicate-audit / acquisition / replacement machinery (`experiments/m2b/census/**`) | New on B | **DO_NOT_PORT** |

Notes on scope, per the governing packet:
- Tests are not scored as independent capabilities. `test-planning-stage.mjs` (26 tests) and the majority of `experiments/m2b/test-round1-boundary.mjs` are verification payload for the `runPlanningStage`/`runRound1Stage` concept row above, not separate matrix entries. The 4 new `test-collaboration.mjs` tests are verification payload for the eligibility-wording change (§6), not a separate entry.
- `experiments/m2b/fixtures*/`, `candidates*/`, and the raw census data under `experiments/m2b/census/**` are data, not capabilities, and carry the same **DO_NOT_PORT** disposition as the CBRP row above; they are the majority of the raw diff's line count and have no code dependency from `src/**`.
- `CURRENT_STATE.md`, the `HANDOFF.md` extension, `M2_EFFECTIVENESS_EXPERIMENT.md`, both `GEMINI_M2B_REVIEW_PACKET*.md`, and `WAVE1_PREFLIGHT_REVIEW.md` are methodology/governance prose, not runtime capabilities. They remain useful narrative context (lowest priority per the source-of-truth rule) and are not part of this disposition matrix.
- The `experiments/m2b/capture/` live-spend scripts (`run-live.mjs`, `runner.mjs`) and their verification counterparts (`capture-verify.mjs`, `parity.mjs`) fall under the same RESEARCH_ONLY disposition as the M2-B arms row: they exist to acquire and verify data for arms B/B′/C/D and are gated behind an explicit confirmation flag, outside `npm test`.

---

## 4. Product convergence decision

Recorded as an architecture decision, not a proposal:

- The **original CHIEF runtime** (planning, worker dispatch, the collaboration/gate/Round2/decision-synthesis machinery already on `main`) is the **underlying deliberation engine** — a substrate, not a product.
- **Pre-Submission Stress Test** is the **first concrete product use case** built on that substrate.
- The product value proposition is explicitly **not** "multi-agent collaboration." It remains, unchanged from `PRE_SUBMISSION_STRESS_TEST_MVP.md`: *"Before you send this artifact, know which parts you cannot defend."*
- Targeted Peer Challenge is **one possible route** inside a larger concept — **Minimum Necessary Deliberation** — not the product itself, and not something to be resolved by asking whether it "belongs entirely" in Stress Test or should be "superseded." That binary framing is rejected: the correct frame is that Targeted Peer Challenge is a candidate route among several, to be selected only when it is the minimum deliberation necessary, never a default mode of operation.

The conceptual future routing set (conceptual architecture only — **not implemented in this phase**):

```
STOP
ADD_CONTEXT
ADD_REVIEWER
REPLICATE
SEEK_EVIDENCE
TARGETED_PEER_CHALLENGE
```

This routing set is the charter for Phase 2 (§13). No eligibility rule, state machine, or schema for it is defined here.

---

## 5. Decision Synthesis authority boundary

The existing `decision_synthesis` mechanism (already on `main`) is architecturally useful and is scored `PORT_CANDIDATE` at the mechanism level (§3). But its *current wiring as final decision authority* is scored `REQUIRES_REDESIGN`, and the boundary below is binding on any future integration, not a suggestion.

A future Decision Synthesis step **may**:
- reconcile review information across sources,
- qualify a `SemanticIssue` (e.g. narrow, sharpen, or contextualize it),
- preserve unresolved disagreement rather than force consensus,
- compare competing reviewer claims,
- update evidence/provenance interpretation.

A future Decision Synthesis step **may not**:
- create `HumanAdjudication` authority,
- authorize artifact edits,
- bypass `actionChange=YES`,
- independently authorize a `RevisionAction`,
- replace the product `DecisionRecord`'s human-grounded audit meaning.

The authoritative product boundary, unchanged and non-negotiable, is:

```
HumanAdjudication.actionChange = YES
  →  RevisionAction
```

Reviewer or model output — including a Decision Synthesis output, however well-reconciled — never by itself authorizes revision. This is the same boundary Slice 1's `planRevisionAction` already enforces in code (`src/stress-test/session.ts`, hardened this session): at least one `RevisionSourceRef` must resolve to a `HumanAdjudication` with `actionChange=YES`, and `judgment` values are explicitly not wired to authorize anything by themselves. Nothing in this reconciliation weakens that gate, and nothing proposed for Phase 2 is permitted to weaken it either.

---

## 6. Gate wording decision

The refined peer-challenge eligibility wording on `experimental/m2a-peer-challenge` (the `buildGateAppendix()` diff validated by 4 tests and by Controlled Replay #4, §9) is **retained as validated reference material and evidence source**.

**It is not recommended for `main` now.** Reason: the next architecture phase (§13) redesigns deliberation routing and eligibility from scratch under Minimum Necessary Deliberation. Porting the old CHIEF gate's eligibility wording into `main` immediately before that redesign would freeze a policy that Phase 2 is expected to replace, not refine further. `experimental/m2a-peer-challenge` remains the validated reference implementation and evidence source for whatever Phase 2 designs next; it is not merged, cherry-picked, or otherwise modified by this decision.

---

## 7. `runPlanningStage` / `runRound1Stage` decision

**Architecture concept: `PORT_CANDIDATE`.**

Reason: explicit stage boundaries — the ability to perform one stage, inspect the resulting state, decide whether more deliberation is justified, and stop without forcing synthesis — are exactly the shape a future adaptive routing layer (§4's routing set) needs. A monolithic `runOrchestrator` that always continues into synthesis cannot support `STOP`, `ADD_REVIEWER`, or any of the other routes as first-class outcomes; a caller needs to be able to hold a completed Round 1 in hand and decide.

**Concrete implementation: `NOT AUTHORIZED IN THIS PHASE`.** No port of `runPlanningStage`/`runRound1Stage` (or their accompanying `test-planning-stage.mjs`) into `main`, C, or anywhere else is performed or recommended as an immediate next step by this document. Implementation remains deferred until a later, explicitly authorized integration phase — most naturally the phase that actually builds the routing layer described in §4/§13, at which point the stage boundary's shape can be validated against real routing requirements rather than assumed in advance.

Supporting technical facts (retained from the original inventory, offered as reference for whenever a future phase does authorize this port — not as a recommendation to act now):
- Depends on: `enforceConstraints`, `buildRunReport`, `callProvider` (all already on `main`, unchanged); no dependency on anything under `experiments/m2b/`.
- Isolable: additive to `orchestrator.ts`; `runOrchestrator`'s external behavior and signature are unchanged, per the diff's own docstrings and the parity tests in `test-planning-stage.mjs` and the bulk of `experiments/m2b/test-round1-boundary.mjs`.
- Does not require modifying the Stress Test Slice-1 contract: `src/stress-test/**` does not import `src/modes/orchestrator.ts` today.
- Does not itself change provider-call counts or evidence/retrieval semantics — it calls the same injected dispatcher `runOrchestrator` already did.

---

## 8. M2-B / CBRP status

Two distinct things must not be conflated: the acquisition **path's** status, and the **scientific question** the path was built to investigate.

**CBRP duplicate-audit acquisition path: TERMINAL / CLOSED.**
- Protocol-1: FAILED CLOSED / TERMINAL.
- Protocol-2: FAILED CLOSED / TERMINAL.
- No Protocol-3 recovery is authorized.
- The candidate pool is not frozen.
- No retention or replacement of pool material is authorized.
- `M-ACQ-01` remains **OPEN** — an unresolved acquisition item, not a decision to revisit it.

This reconciliation does not reopen CBRP, does not characterize anything in this document as recovery authorization, and performs no acquisition, retention, or replacement action.

**The scientific question — "does peer information provide incremental value beyond extra reasoning?" — is PARKED / UNANSWERED / NOT AUTHORIZED**, and is not resolved by the CBRP closure above, by Controlled Replay #4 (§9), or by this document. Replay #4 demonstrates the mechanism runs; it does not and cannot answer whether peer information helps, because the fixture's provisional answer was produced before Round 2 ran (§9). No M2-B effectiveness execution (B/B′/C/D1 or any successor design) is authorized by this document.

---

## 9. Controlled Replay #4 claim boundary

Bounded to what the evidence actually supports.

**Established (allowed claims):**
- Under the one validated fixture/runtime condition exercised, the full downstream mechanism — gate → issue parsing → deterministic selection → `sourceRef` resolution → targeted Round 2 → decision synthesis — executed successfully once, end to end, against real `openai`/`gpt-5` provider calls (3 live calls: `synthesis_gate`, `round2_worker`, `decision_synthesis`; Planning and Round 1 were replayed from Replay #3's frozen, byte-verified snapshot, not re-run live).
- The one authorized production change under test (the gate-eligibility wording in `buildGateAppendix()`) produced its intended effect: a `peer_challenge` was emitted even though the provisional synthesis had already proposed a compromise — the specific behavior the wording change was written to fix.
- 16 offline before/after control captures (disabled/omitted collaboration path, across SIMPLE/NORMAL/DEEP × SUCCESS/DEGRADED/FAILED, minus impossible combinations) were byte-identical (`f50a7b2e...`), evidencing that the wording change did not alter the default-OFF path.
- Offline suite grew 208 → 212 passed, 0 failed, with no existing assertion weakened.
- Evidence/retrieval isolation held: all three live calls had `retrieval` null on both request and result.
- The frozen Round 1 snapshot and its derived report were confirmed unchanged after the live run (`snapshotUnchanged`, `reportUnchanged`, `recomputedReportUnchanged` all true in the harness's own invariant block).
- This supports, specifically: live reachability of the mechanism; issue parsing; deterministic `sourceRef` resolution; targeted Round 2; Decision Synthesis execution; the retrieval-OFF invariant under this one experiment; and fallback/reporting/evidence invariants where tested.

**Not established, and not claimed by the evidence itself** (the source document is explicit on this point — `evaluation.md`'s own closing line: *"PASS 僅表示完整 downstream mechanism 在真實 provider calls 下跑通一次...不宣稱優於 baseline、品質提高、多模型優於單模型或應 productionize"*):
- M2-A does not improve answer quality.
- Multi-agent collaboration is not shown to be better than single-agent.
- Peer information is not shown to add incremental value (the replay's own provisional-answer choice differed between #3 and #4 for reasons the document explicitly declines to attribute to peer interaction, since Round 2 had not yet run when the provisional answer was produced) — this is the same scientific question §8 records as PARKED.
- M2-A is not recommended for default-ON.
- M2-A is not recommended to run for `NORMAL` complexity as a matter of this evidence.
- M2-A is not asserted production-ready.

One live run, one fixture, one provider (`openai`/`gpt-5` for all three calls — the document notes cross-provider live collaboration was not exercised this round).

---

## 10. Product mapping to Stress Test

```
StressTestSession                (src/stress-test/session.ts — exists today)
 |
 v
Review Acquisition                (MISSING — no code exists for this yet, in src/ or experiments/)
 |
 v
ReviewFinding[]                   (src/stress-test/types.ts — exists today, provider-agnostic shape)
 |
 v
Semantic Consolidation             (createSemanticIssue — exists today, manual/test-authored clustering only)
 |
 v
Incremental-value decision         (MISSING — no mechanism decides "is another pass justified")
 |
 v
one of: STOP / ADD_CONTEXT / ADD_REVIEWER / REPLICATE / SEEK_EVIDENCE / TARGETED_PEER_CHALLENGE   (conceptual only — §4, §13; not implemented)
 |
 v
Human Adjudication                 (src/stress-test/session.ts::adjudicate — exists today, exactly-one-per-target)
 |
 v
RevisionAction                     (src/stress-test/session.ts::planRevisionAction — exists today, human-authorized only, bound by §5)
```

**Where existing M2-A concepts could eventually fit**, subject to the concrete-implementation gate in §7 and the authority boundary in §5:
- The `runPlanningStage`/`runRound1Stage` stage-boundary concept is the closest existing analog to a future **Review Acquisition** primitive: "dispatch N independent workers against a task, get back N raw outputs, stop." A Stress Test acquisition step would still need its own adapter layer to turn a `WorkerRunResult` into a `ReviewFinding` (title, `artifactLocation`, `evidenceState`, `whyMaterial`, etc.) — that adapter does not exist anywhere in this repository today, on any branch.
- Targeted Peer Challenge, Decision Synthesis, and the collaboration reporting concepts are candidate implementations of the `TARGETED_PEER_CHALLENGE` route in the conceptual routing set (§4) — one option among six, never the default, and always subordinate to §5's authority boundary. They are not "the optional additional reviewer step" by default; which route (if any) a given session takes is exactly what Phase 2 is charged with defining.

**Genuinely missing, not a port from anywhere:**
- **Incremental-value decision** ("is another pass justified") has no code anywhere — not in `experiments/m2b/` (its arms are pre-registered fixed protocols, not an adaptive decision procedure) and not in `src/` (the DEEP-vs-normal-vs-simple complexity classification in `policy.ts` decides *specialist count*, not *whether to acquire a second review*). This is a genuinely missing product-specific primitive that Phase 2 must define, not something to import.

---

## 11. Remaining items not decided by this amendment

Most of the draft's original open questions are resolved by the decisions above (§4, §5, §6, §7, §8). What remains genuinely undecided:

1. **Timing/trigger for concrete-port authorization.** §7 endorses the stage-boundary *concept* but authorizes no implementation move. This document does not propose when or under what condition that authorization would be granted — most naturally alongside whatever phase actually builds the routing layer, but that linkage is not itself decided here.
2. **`M-ACQ-01` disposition.** Recorded in §8 as remaining OPEN. Whether it is ever pursued again, superseded, or formally closed is not addressed by this document.
3. **Coexistence of the existing `experimental.collaboration` MCP surface with a future Phase 2 routing layer.** `main`'s MCP tool schema already exposes `experimental.collaboration.*` today, default OFF (§1, §2). Whether Phase 2's routing contract subsumes that surface, deprecates it, or runs alongside it is not decided here.

---

## 12. Not implemented, not started, not authorized by this document

Stress Test Slice 2; Phase 2 (Minimum Necessary Deliberation Contract, §13); any concrete port of `runPlanningStage`/`runRound1Stage` or `transportMaxRetries`; porting the gate-wording change to `main`; M2-A productionization; an experimental-branch merge or cherry-pick; any `main` modification; any CASE-001 change or re-review of CASE-001 Proposal V1; CBRP or M2-B execution or Protocol-3 recovery; planner redesign; NORMAL-complexity or default-ON collaboration enablement; peer-challenge productionization; any weakening of `HumanAdjudication.actionChange=YES`; treating Decision Synthesis as revision authority; UI; a database.

---

## 13. Next phase (not started)

**PRODUCT RUNTIME RECONCILIATION — PHASE 2: MINIMUM NECESSARY DELIBERATION CONTRACT.**

To begin only after this amendment is remotely verified and Phase 1 is formally ACCEPTED by GPT. **Not authorized by this packet. Not started by this document.**

Phase 2 must define architecture for the six routes in §4 (`STOP`, `ADD_CONTEXT`, `ADD_REVIEWER`, `REPLICATE`, `SEEK_EVIDENCE`, `TARGETED_PEER_CHALLENGE`), at minimum covering:

- eligibility for each route,
- material issue state,
- missing Author Context,
- evidence gaps,
- reviewer disagreement,
- marginal information value,
- cost ceiling,
- latency ceiling,
- stopping conditions,
- provenance,
- unresolved disagreement representation,
- the `HumanAdjudication` boundary (§5, non-negotiable),
- `DecisionRecord` audit mapping.

No part of Phase 2's contract is designed, implemented, or started in this document.
