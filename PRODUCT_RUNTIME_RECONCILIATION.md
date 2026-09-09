# Product Runtime Reconciliation — Phase 1 Architecture Inventory

Repository: `qqqq8413-cyber/ai-collab-mcp-notes`
Mode: offline repository analysis only. 0 provider/model calls made in the production of this document.

Refs inspected:
- **A — main** @ `aedc9efe0ff1f4acf7d5a36d9a1b3ab87e5b9af8`
- **B — experimental/m2a-peer-challenge** @ `51cfcbec811bacbbefe0c30e217bc524324df7c8`
- **C — product/pre-submission-stress-test-mvp** @ `c267ad8a6d2ad62f7f1d8124181130dbe4558f7d`

`merge-base(A, B) == A` — B is a linear 98-commit descendant of A, never rebased. C is a separate, unrelated descendant of A (the Stress Test MVP domain layer); C and B share no commits beyond A.

---

## 1. Executive architecture conclusion

**The core finding of this inventory reframes the question the packet asks.** The packet asks what should be *ported from* the M2-A runtime *into* the product line. But inspection of `src/**` shows the M2-A collaboration mechanism — the gate, targeted Round 2, decision synthesis, neutrality guard, deterministic chunk map, replay/frozen-Round1 helpers, call ceilings — **is already on `main`**, already compiled into the same `src/agents/collaboration.ts` and `src/modes/orchestrator.ts` that the Stress Test branch (C) was cut from, and already covered by 105 passing tests in `test-collaboration.mjs` that run on every `npm test` today, on both A and C. It is reachable right now through the MCP tool schema (`src/index.ts`, the `experimental.collaboration` input) by any caller of the `ai-collab-mcp` tool.

So this is not a research-to-product migration. It is a **narrower reconciliation of a small delta** that experimental/m2a-peer-challenge (B) accumulated on top of an already-shared foundation, plus a large, clearly-bounded body of M2-B/CBRP research that never touched `src/` at all and was never meant to.

The actual `src/**` delta between A and B is 6 files, 189 changed lines, three independent changes:

1. **A pure refactor** (`runPlanningStage` / `runRound1Stage` extracted out of `runOrchestrator` in `orchestrator.ts`) — documented and tested as zero behavior change, existing purely so a caller can obtain a genuine production Round 1 without triggering synthesis.
2. **A small opt-in transport primitive** (`transportMaxRetries` on `CallOptions`, implemented in `claude.ts`/`openai.ts`, explicitly a no-op on `gemini.ts`) — forbids SDK-level retries for a caller that needs "one logical call" to mean "one HTTP attempt." Default (`undefined`) leaves every existing caller's behavior untouched.
3. **A prompt-wording refinement** to the peer-challenge eligibility rule inside `buildGateAppendix()` in `collaboration.ts` — not a new mechanism, a correction to the already-shipped one's instructions, validated by 4 new tests and by one round of live evidence (Controlled Replay #4, §10).

Everything else that makes the 98-commit history look large — `experiments/m2b/**` (CBRP census, duplicate-audit, acquisition harness, four evaluation arms, hundreds of fixture/capture files) and six large prose documents (`CURRENT_STATE.md`, `HANDOFF.md`, `M2_EFFECTIVENESS_EXPERIMENT.md`, two `GEMINI_M2B_REVIEW_PACKET*.md`, `WAVE1_PREFLIGHT_REVIEW.md`, 14,338 inserted lines combined) — is research scaffolding that, **by its own design documents' explicit mandate** (`M2_EFFECTIVENESS_EXPERIMENT.md` §23.4: *"harness 維持 `src/` zero-change,全部放 `experiments/m2b/`"*), never touches production source and was never live-authorized.

**Recommendation in one sentence:** treat the orchestrator refactor and the transport primitive as low-risk, immediately portable mechanism; treat the collaboration-gate wording fix and the entire question of whether decision-synthesis-style collaboration belongs in the Stress Test product line as one open architecture question for GPT (§11); treat everything under `experiments/m2b/` and the six prose documents as research, not to be revived or ported, per §11 of the governing packet.

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

**Source-of-truth discipline note:** `CURRENT_STATE.md`'s own `stateVerifiedThrough` field pins it to `ffbe0b26e5a8ddd927d0ff936d16fccee18dcbeb` — a commit *before* the collaboration-wording change, the `transportMaxRetries` primitive, and Controlled Replay #4 all landed. The document says so itself: *"CURRENT_STATE.md 對 live branch HEAD 不具權威性"* (not authoritative for the live branch HEAD). This inventory's classification is built from `git diff`, test files, and the `diagnostics/m2a-live/controlled-replay-4/` artifacts — never from that stale prose — exactly per the packet's §3 source-of-truth rule. This is worth flagging because it is a concrete, present-tense instance of the failure mode §3 warns against, not a hypothetical one.

---

## 3. Runtime capability inventory

Evaluated against every item in the packet's §5 checklist. "Status" records where the capability actually lives today, established from code, not prose.

| Capability | Already on `main`? | New in B beyond `main`? | Notes |
|---|---|---|---|
| Pre-synthesis / synthesis collaboration gate (`synthesis_gate` stage, `runSynthesisStage`) | Yes | No | Full implementation, prompt construction, and 105 tests already on `main` |
| Provisional answer handling (`provisionalAnswer`, `AnswerSource`) | Yes | No | — |
| Deterministic chunk map / `sourceRef` resolution (`segmentAll`, `resolveSourceRef`) | Yes | No | — |
| Targeted peer-context construction (`buildPeerExcerpt`, `buildRound2Prompt`) | Yes | No | — |
| Round2 max-one selection (`selectIssue`, `isRound2Eligible`) | Yes | No | — |
| Round2 provider execution (`round2_worker` stage) | Yes | No | — |
| Round2 retrieval-OFF invariant | Yes | No | Verified again live in Replay #4 (§10) |
| Decision Synthesis (`decision_synthesis` stage) | Yes | No | — |
| Neutrality guard (no forced consensus) | Yes | No | Verified again live in Replay #4 |
| Collaboration reporting (`CollaborationReport`, timings) | Yes | No | — |
| Fallback semantics (gate/R2/decision failure paths) | Yes | No | — |
| Call ceilings (`N + 4` for DEEP) | Yes | No | Enforced in `policy.ts`/`collaboration.ts`, unchanged by B |
| Replay / frozen-Round1 helpers (`replaySynthesis`, `Round1Snapshot`, `toRound1Snapshot`) | Yes | No | Reused verbatim by Replay #4's harness |
| **Round1-stage extraction** (`runPlanningStage`, `runRound1Stage`) | **No** | **Yes** | The one genuinely new orchestrator capability; pure refactor, documented zero-behavior-change |
| **`transportMaxRetries` transport primitive** | **No** | **Yes** | Opt-in, default no-op, isolated to `claude.ts`/`openai.ts` |
| **Peer-challenge eligibility wording** (`buildGateAppendix()` text) | prior wording on `main` | **refined wording on B** | Same mechanism, corrected instructions; not a new gate |
| Diagnostic harnesses (`diagnostics/m2a-live/controlled-replay-4/*`) | No | Yes (evidence only) | One-shot captured evidence + a sealed offline verifier; not runtime |
| M2-B experiment arms (B/B′/C/D, `experiments/m2b/harness/arms.mjs`) | No | Yes | Explicitly harness-only, explicitly forbidden from entering `src/` by its own protocol (§23.4) |
| Acquisition fixtures / candidate pools (`experiments/m2b/fixtures*/`, `candidates*/`) | No | Yes | Data, not code; ~40% of the raw diff by line count |
| CBRP census / duplicate audit (`experiments/m2b/census/**`) | No | Yes | Already formally closed this session (CWP-12H); no bearing on this inventory beyond confirming it never touched `src/` |
| Prompt/schema changes made only to make M2-A testable | No | One instance (see below) | — |

**The one "testability-only" schema change worth naming precisely:** `CallOptions.transportMaxRetries` exists *only* because the M2-B capture path needed a guarantee that one logical call costs at most one HTTP attempt when a real budget is on the line. It is documented as such in `types.ts` itself. It is a legitimate, narrow, opt-in primitive — not a schema contortion — but its only current caller is research code (`experiments/m2b/capture/*`).

---

## 4. PORT_CANDIDATE

| Capability | Source | Why |
|---|---|---|
| `runPlanningStage` / `runRound1Stage` extraction | `src/modes/orchestrator.ts` | Pure refactor of already-shipped code; the diff's own docstrings assert and the parity tests in `test-planning-stage.mjs` (26 tests) and the bulk of `experiments/m2b/test-round1-boundary.mjs` prove zero behavior change, including clock-read parity. Reusable outside any experiment: any future caller needing "a genuine Round 1 without committing to synthesis" — which is exactly the shape a future Stress Test "acquire one reviewer pass" primitive would need — benefits from this being one function instead of an inline half of a larger one. Makes no provider-call-count or evidence/retrieval change. |
| `transportMaxRetries` on `CallOptions` | `src/providers/types.ts`, `claude.ts`, `openai.ts` | Small, isolated, opt-in, default-inert primitive. Reusable outside M2-B: any future live acquisition path in the Stress Test product (§9) that needs an auditable "N logical calls = N HTTP attempts" guarantee would want this rather than reinventing it. Does not touch evidence/retrieval semantics. |
| The 26 tests in `test-planning-stage.mjs` | root | Deterministic, offline, stub-only; validates the mechanism above; no reason to leave behind if the mechanism ports |

Both of the above are **mechanism**, not policy: neither changes what the product does today, both are inert until a caller opts in, and porting them requires no decision about collaboration, peer challenge, or M2-A as a feature.

---

## 5. RESEARCH_ONLY / DO_NOT_PORT

| Item | Classification | Why |
|---|---|---|
| `experiments/m2b/harness/arms.mjs` (B/B′/C/D arm runners) | RESEARCH_ONLY | Explicitly a harness over the *existing* production gate/R2/decision-synthesis mechanism; measures it, does not extend it. Its own header pins it to protocol §3.1 and forbids entering `src/` |
| `experiments/m2b/harness/a2-acquisition.mjs`, `fixtures.mjs`, `invariants.mjs`, `prompts.mjs` | RESEARCH_ONLY | Fixture/acquisition/invariant machinery for the arms above; `prompts.mjs`'s own header: *"arm D is a control, not a candidate feature, so it must not enter the production code path"* |
| `experiments/m2b/capture/run-live.mjs`, `runner.mjs`, `capture-verify.mjs`, `parity.mjs` | RESEARCH_ONLY / DO_NOT_PORT | Real Round-1 capture path for M2-B; spends money by design; gated behind an explicit confirmation flag; not part of `npm test` |
| `experiments/m2b/census/**` (CBRP duplicate-audit, structural review, authoring rounds) | RESEARCH_ONLY, formally closed | Closed this session via CWP-12H; explicitly not to be reopened per this packet's §11 and §15 |
| `experiments/m2b/fixtures*/`, `candidates*/` (raw data) | DO_NOT_PORT | Data, not runtime; ~50%+ of the raw diff's line count; no code dependency from `src/**` |
| `diagnostics/m2a-live/controlled-replay-4/artifact.json`, `attempt.json`, `control-before.json`, `control-after.json`, `hashes.json`, `preflight.json`, `npm-test-*.log` | RESEARCH_ONLY (frozen evidence) | Captured data from one live run; valuable as evidence (§10), not as runtime |
| `diagnostics/m2a-live/controlled-replay-4/control.mjs`, `harness.mjs`, `verify.mjs` | RESEARCH_ONLY | Diagnostic scripts specific to replaying and verifying that one capture; `harness.mjs` is a one-shot recorder wrapping the *already-shipped* `replaySynthesis`, adding nothing new to runtime |
| `CURRENT_STATE.md`, `HANDOFF.md` (extension), `M2_EFFECTIVENESS_EXPERIMENT.md`, `GEMINI_M2B_REVIEW_PACKET.md`, `GEMINI_M2B_REVIEW_PACKET_2.md`, `WAVE1_PREFLIGHT_REVIEW.md` | RESEARCH_ONLY (methodology/governance prose) | Lowest priority per §3; useful for narrative context only; `CURRENT_STATE.md` is demonstrably stale relative to B's own HEAD (§2 note) |

## 6. REQUIRES_REDESIGN

| Item | Issue | What redesign would mean |
|---|---|---|
| `experiments/m2b/test-round1-boundary.mjs` | Structurally split: ~90% of its tests (Round 1 boundary, production-object identity, failure semantics, timing contract, planning/Round1 parity) are genuine acceptance tests of the now-`main`-eligible `runPlanningStage`/`runRound1Stage` extraction and belong beside `test-planning-stage.mjs` at the repository root. Its final test ("Historical control integrity") pulls in `experiments/m2b/capture/control-recheck.mjs` and the sealed `controlled-replay-4/control.mjs` — a legitimate but M2-B-specific regression fingerprint that should stay research-side. | A future port would split the file rather than move or leave it whole: production-boundary tests move to root; the historical-control test and its dependency stay under `experiments/m2b/`, decoupled from whatever ships |
| The gate-eligibility wording change in `buildGateAppendix()` | Technically a strict improvement to an already-shipped prompt, validated by 4 tests and one live replay — but "port the wording fix" implicitly reopens "is collaboration/peer-challenge part of this product line at all," which is not a wording question. See open question in §11. | Not a redesign of the code itself (it is a two-paragraph prompt diff); the redesign question is architectural: whether the surrounding feature belongs in the product, which the wording fix cannot answer by itself |
| The "hash-pinned control regression" pattern (`control-recheck.mjs` / `HISTORICAL_CONTROL_SHA256`) | The specific implementation is M2-B-coupled (sealed to one historical capture), but the underlying idea — freeze a byte-identical fingerprint of a disabled/control path so a refactor can prove it did not move the behavior — is a sound general regression-safety pattern | Worth noting, not adopting as-is. The Stress Test domain layer already independently arrived at an analogous but distinct pattern this session (`verifyFrozenInputIntegrity` — a runtime tamper-check, not a build-time regression fingerprint) for a different problem (frozen input integrity, not behavior-preservation across a refactor). No import is needed; flagged only so the convergence is visible to GPT. |

---

## 7. Dependency graph (PORT_CANDIDATEs only)

**`runPlanningStage` / `runRound1Stage`** (`src/modes/orchestrator.ts`)
- Depends on: `enforceConstraints`, `buildRunReport`, `callProvider` (all already on `main`, unchanged)
- Depends on other experimental changes: none — the extraction is self-contained within `orchestrator.ts`
- Already on `main`: the code it wraps (planning call, worker dispatch, `buildRunReport`) — yes, everything except the two new exported functions themselves
- Isolable cleanly: yes — it is additive; `runOrchestrator`'s external behavior and signature are unchanged (confirmed by `test-collaboration.mjs` passing unmodified on both A and, hypothetically, after this port)
- Requires modifying the Stress Test Slice-1 contract: no — `src/stress-test/**` does not import `src/modes/orchestrator.ts` at all today
- Makes provider calls: no by itself — it calls the injected `call` parameter exactly as `runOrchestrator` already did; porting it makes zero new calls
- Touches evidence/retrieval semantics: no — retrieval attachment logic (`worker.evidenceCapable ? { retrieval: ... } : {}`) is copied verbatim, not altered

**`transportMaxRetries`** (`src/providers/types.ts`, `claude.ts`, `openai.ts`)
- Depends on: nothing beyond the provider SDKs already in `package.json`
- Depends on other experimental changes: none
- Already on `main`: the `CallOptions` interface and the two provider functions it extends — yes, in unmodified form
- Isolable cleanly: yes — a single optional field with a documented default of "leave the SDK alone"
- Requires modifying the Stress Test Slice-1 contract: no
- Makes provider calls: no — it changes retry behavior of calls a caller already makes, not whether a call happens
- Touches evidence/retrieval semantics: no

Both port candidates have an **empty dependency edge into `experiments/m2b/**`** — neither requires anything from the research tree to compile, type-check, or pass its own tests. This is the single clearest signal that they are mechanism, not experiment scaffolding.

---

## 8. Product mapping to Stress Test

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
Incremental-value decision         (MISSING — no mechanism decides "is another pass worth it")
 |
 v
optional additional reviewer / peer challenge   (mechanism EXISTS on main, in a different shape — see caution below)
 |
 v
Human Adjudication                 (src/stress-test/session.ts::adjudicate — exists today, exactly-one-per-target)
 |
 v
RevisionAction                     (src/stress-test/session.ts::planRevisionAction — exists today, human-authorized only)
```

**Where existing M2-A primitives could fit:**
- `runPlanningStage`/`runRound1Stage`, if ported, is the closest existing analog to a future **Review Acquisition** primitive: "dispatch N independent workers against a task, get back N raw outputs, stop." A Stress Test acquisition step would still need its own adapter layer to turn a `WorkerRunResult` into a `ReviewFinding` (title, `artifactLocation`, `evidenceState`, `whyMaterial`, etc.) — that adapter does not exist anywhere in this repository today, on any branch.
- `transportMaxRetries` would matter the moment Review Acquisition makes real provider calls under any per-session call budget worth auditing precisely.

**Where existing M2-A primitives do *not* fit without a real redesign decision, not just wiring:**
- The **peer-challenge / Round2 / Decision Synthesis** chain is model-adjudicated: the synthesizer, not a human, decides whether disagreement is material and what the final answer says. Slice 1's `HumanAdjudication` is deliberately the opposite: a human judgment is the only thing that can authorize a `RevisionAction` (`planRevisionAction`'s `actionChange=YES` gate, added this session), and `judgment` values like `NEW_MATERIAL` are explicitly *not* wired to authorize anything by themselves. Reusing Decision Synthesis as "the optional additional reviewer / peer challenge" step would import model-adjudicated consensus into a product whose whole premise is that a human decides what is defensible. This is not a wiring problem; it is the open question in §11 below.
- **Incremental-value decision** ("is a second pass worth it") has no code anywhere — not in `experiments/m2b/` (its arms are pre-registered fixed protocols, not an adaptive decision procedure) and not in `src/` (the DEEP-vs-normal-vs-simple complexity classification in `policy.ts` decides *specialist count*, not *whether to acquire a second review*). This is a genuinely missing product-specific primitive, not something to port from anywhere.

---

## 9. Minimal recommended port set

1. `runPlanningStage` / `runRound1Stage` extraction (`src/modes/orchestrator.ts`) — zero behavior change, no policy decision required, no dependency on anything under `experiments/m2b/`.
2. `transportMaxRetries` (`src/providers/types.ts`, `claude.ts`, `openai.ts`) — same profile.
3. The 26 offline tests in `test-planning-stage.mjs`, ported alongside #1 so the mechanism does not ship untested.
4. (Conditional on the split in §6) the production-boundary majority of `experiments/m2b/test-round1-boundary.mjs`, once separated from its historical-control tail.

Nothing above requires deciding whether collaboration/peer-challenge belongs in the product. That is deliberate: it is the smallest set that is uncontroversial on the evidence alone.

---

## 10. M2-A live evidence (Controlled Replay #4)

Bounded to what the evidence actually supports, per the packet's §10 constraints.

**Established (allowed claims):**
- Under the one validated fixture/runtime condition exercised, the full downstream mechanism — gate → issue parsing → deterministic selection → `sourceRef` resolution → targeted Round 2 → decision synthesis — executed successfully once, end to end, against real `openai`/`gpt-5` provider calls (3 live calls: `synthesis_gate`, `round2_worker`, `decision_synthesis`; Planning and Round 1 were replayed from Replay #3's frozen, byte-verified snapshot, not re-run live).
- The one authorized production change under test (the gate-eligibility wording in `buildGateAppendix()`) produced its intended effect: a `peer_challenge` was emitted even though the provisional synthesis had already proposed a compromise — the specific behavior the wording change was written to fix.
- 16 offline before/after control captures (disabled/omitted collaboration path, across SIMPLE/NORMAL/DEEP × SUCCESS/DEGRADED/FAILED, minus impossible combinations) were byte-identical (`f50a7b2e...`), evidencing that the wording change did not alter the default-OFF path.
- Offline suite grew 208 → 212 passed, 0 failed, with no existing assertion weakened.
- Evidence/retrieval isolation held: all three live calls had `retrieval` null on both request and result.
- The frozen Round 1 snapshot and its derived report were confirmed unchanged after the live run (`snapshotUnchanged`, `reportUnchanged`, `recomputedReportUnchanged` all true in the harness's own invariant block).

**Not established, and not claimed by the evidence itself** (the source document is explicit on this point — `evaluation.md`'s own closing line: *"PASS 僅表示完整 downstream mechanism 在真實 provider calls 下跑通一次...不宣稱優於 baseline、品質提高、多模型優於單模型或應 productionize"*):
- M2-A does not improve answer quality.
- Multi-agent collaboration is not shown to be better than single-agent.
- Peer information is not shown to add incremental value (the replay's own provisional-answer choice differed between #3 and #4 for reasons the document explicitly declines to attribute to peer interaction, since Round 2 had not yet run when the provisional answer was produced).
- M2-A is not recommended for default-ON.
- M2-A is not recommended to run for `NORMAL` complexity as a matter of this evidence.
- M2-A is not asserted production-ready.

One live run, one fixture, one provider (`openai`/`gpt-5` for all three calls — the document notes cross-provider live collaboration was not exercised this round).

---

## 11. Open architecture questions for GPT

1. **Does collaboration/peer-challenge/decision-synthesis belong in the Stress Test product line at all?** It is already shipped on `main`, already MCP-reachable, already opt-in/default-OFF — but it is model-adjudicated (§8), and the Stress Test thesis (§4 of `PRE_SUBMISSION_STRESS_TEST_MVP.md`, already architecture-accepted) is human-adjudicated. Is this a separate, still-valid product line running alongside Stress Test, or a predecessor direction to be formally superseded?
2. If the answer to (1) is "not now, but keep it live": should the gate-eligibility wording fix (§10) still be accepted into `main` on its own merits (it is a strict improvement to already-shipped behavior, fully tested), independent of any Stress Test decision?
3. Should `runPlanningStage`/`runRound1Stage` and `transportMaxRetries` be ported to `main` now, given they are zero-risk and answer (1) does not gate them? (This inventory's recommendation is yes — see §9 — but the port itself was explicitly out of scope for this phase.)
4. Should `experiments/m2b/test-round1-boundary.mjs` be split now (§6), independent of (1), since its majority content tests mechanism already on `main`?
5. Is the CBRP/M2-B research track (already formally closed this session via CWP-12H for the duplicate-audit sub-track specifically) to be considered fully closed end-to-end, or does GPT want the four-arm (B/B′/C/D) effectiveness experiment kept open as a parked, not-yet-authorized track for later?
6. Does GPT want a concrete design slice opened for the two primitives §8 identifies as genuinely missing — a Review-Acquisition adapter (`WorkerRunResult` → `ReviewFinding`) and an Incremental-Value decision procedure — or is that explicitly deferred until after this reconciliation is itself decided?

---

## 12. Proposed implementation slices (no implementation performed)

- **Slice R1 — mechanical port.** Port `runPlanningStage`/`runRound1Stage` and `transportMaxRetries` (plus `test-planning-stage.mjs`) to `main`. No behavior change to any existing caller; no policy decision required; answers none of §11 by itself.
- **Slice R2 — test reorganization.** Split `experiments/m2b/test-round1-boundary.mjs`: move its production-boundary majority to the repository root (beside the file Slice R1 adds); leave the historical-control-integrity test and its `capture/control-recheck.mjs` dependency under `experiments/m2b/`. Depends on R1 only for a stable landing spot; does not depend on §11's decisions.
- **Slice R3 — gate-wording reconciliation (conditional on §11.2).** Accept the `buildGateAppendix()` eligibility wording fix and its 4 tests into `main`, independent of whether collaboration ships as a Stress Test feature.
- **Slice R4 — product-line decision (conditional on §11.1).** Whatever GPT decides about collaboration's place relative to Stress Test — formally supersede, keep parallel, or defer — recorded as a decision document before any further Stress Test slice touches provider calls.
- **Future Stress Test Slice 2 (not this phase, not authorized here) — Review Acquisition design.** A new primitive, not a port: an adapter from a dispatch mechanism (potentially `runRound1Stage`, pending R1) to `ReviewFinding[]`, plus whatever Incremental-Value decision procedure GPT wants (§11.6). No implementation, no schema change, is proposed or performed here.

No code, test, or schema change is included in this document or this phase.

---

**Not implemented, not started, not restarted by this document:** Stress Test Slice 2, M2-A productionization, an experimental-branch merge or cherry-pick, any `main` modification, any CASE-001 change, CBRP or M2-B execution, planner redesign, NORMAL-complexity collaboration enablement, peer-challenge productionization, UI, or a database.
