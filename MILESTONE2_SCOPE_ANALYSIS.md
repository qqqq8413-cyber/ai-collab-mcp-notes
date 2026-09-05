# Milestone 2 — Scope Analysis

> **STATUS: SCOPE ANALYSIS ONLY. NO RUNTIME IMPLEMENTATION.**
>
> Produced per `CLAUDE_CODE_HANDOFF.md`. No file under `src/` was modified.

Every claim below is tagged:

| Tag | Meaning |
|---|---|
| **[FACT]** | Verified in the code or in recorded evidence during this analysis |
| **[DESIGN]** | Candidate design, not approved |
| **[SIGNAL]** | Review signal or hypothesis, not evidence |
| **[DECISION]** | Recommended decision, subject to architecture review |
| **[OPEN]** | Unresolved |

---

## 0. Handoff snapshot verification

| Handoff claim | Verified? | Note |
|---|---|---|
| Offline tests 99 passed, 0 failed | **[FACT] yes** | `npm test` → 11 + 25 + 20 + 7 + 36 = 99 |
| Runtime baseline `97e89d8` | **[FACT] yes** | Present in remote history |
| Step 7 code + runtime accepted | **[FACT] yes** | `src/agents/policy.ts` exists and is wired |
| Step 6.1 Worker Context Contract done | **[FACT] yes** | `buildWorkerPrompt()` at `orchestrator.ts:158` |
| DEEP: 3 specialists, 6 queries, 21 sources, `PARTIALLY_GROUNDED` | **[FACT] yes** | `regressions/step7-1-e2e/DEEP-grounded/evaluation.json` |

### Discrepancies found

**D1 — the working directory is not a git checkout. [FACT]**

```
$ git rev-parse --abbrev-ref HEAD
fatal: not a git repository
```

Branch and working-tree state cannot be verified locally. I verified equivalence a
different way: `src/modes/orchestrator.ts`, `src/modes/debate.ts`, `src/agents/policy.ts`,
`src/providers/types.ts` and `src/index.ts` are **byte-identical to remote `main`**. Remote
HEAD is `656d7b6` ("Prepare Claude Code Milestone 2 scope handoff").

Consequence: local edits here are not tracked and cannot be diffed or reverted by git.
Anyone implementing M2 in this directory should clone the repository instead.

**D2 — a stored Step 7.1 artifact still reads `outcome: FAIL`. [FACT]**

`regressions/step7-1-e2e/SIMPLE-direct/normalized-result.json` records `outcome: FAIL`
with one false check, `expectedArithmeticAndOrder`. Every other structural check passed.
`evaluation.md` documents this as a harness false negative: the checker searched for label
and amount as adjacent plain text after stripping only whitespace and commas, so Markdown
emphasis between them failed the match. `run-case.mjs` was fixed; the stored artifact is
the pre-fix run and was not regenerated.

**This is not a runtime defect.** It is recorded here so the next reader does not
re-litigate it, and because a stored artifact whose top-level verdict contradicts its own
evaluation is a trap for an automated consumer.

---

# PART 1 — CURRENT RUNTIME FACTS

## 1. Orchestrator call graph and data flow [FACT]

```
runOrchestrator(options)
  │
  ├─ call(chief)                        1 call
  │    prompt : buildPlanningPrompt(task, workers, budget)
  │    system : orchestrator.systemPrompt ?? CHIEF_SYSTEM_PROMPT
  │    → extractJsonObject → planSchema.parse → enforceConstraints
  │    → plan + planningAdjustments[]
  │
  ├─ Promise.all(plan.assignments.map(...))    N calls, parallel
  │    prompt : buildWorkerPrompt(task, assignment.mission)
  │    system : worker.role
  │    retrieval: { enabled: true } only if worker.evidenceCapable
  │    errors caught per worker → { error } instead of throwing
  │
  ├─ buildRunReport(plan.complexity, workers, workerResults)
  │    → status / evidenceLabel / retrieval summary / notes
  ├─ deriveExecutionPolicy(facts)       pure, no model call
  │
  └─ policy.synthesize ?
       ├─ false → finalOutput = workerResults[0].output          0 calls
       └─ true  → call(synthesizer)                              1 call
                  finalOutput = buildOutputBanner(report) + text
```

Total: `1 + N + (0 or 1)`.

### What the synthesizer actually receives [FACT]

From `orchestrator.ts:497-514`, the synthesis prompt contains only:

- the original task;
- for each **successful** worker: `agentId`, `mission`, `output`;
- a DEGRADED note naming failed agents, when applicable.

It does **not** receive: retrieval metadata, source URLs, `plan.reason`,
`requiredCapabilities`, `planningAdjustments`, the evidence label, or any failed worker's
error text.

**The model that writes the final answer never sees which sources were retrieved.**
Source URLs reach `report.retrieval.sources` and the human-facing banner, but never the
synthesizer. This matters for M2: a synthesis gate asked to identify `needs_evidence`
issues would be reasoning about evidence it cannot see.

### Latent coupling in the direct-delivery path [FACT]

```ts
finalOutput: report.synthesisAllowed ? workerResults[0].output! : null
```

The direct path returns raw worker text **without `buildOutputBanner(report)`**. Today
that is harmless and provably so: `deriveExecutionPolicy` grants direct delivery only when
`complexity === 'simple'` (→ `evidenceLabel: NOT_APPLICABLE`) and `status === 'SUCCESS'`,
and those are exactly the conditions under which the banner is empty.

It is still a coupling held by two conditions in a different file. **Any M2 path that
delivers output without going through the synthesis branch inherits a silently
banner-free deliverable.** [SIGNAL]

## 2. Debate call graph, context, stop condition, judge [FACT]

```
runDebate({ question, panel, judge = panel[0], rounds = 1 })
  │
  ├─ Promise.all(panel.map(...))         panel.length calls
  │    prompt : question               (no system prompt, no role)
  │
  ├─ for r in 0..rounds-1               panel.length calls PER round
  │    each panelist receives:
  │      question
  │    + FULL text of every peer's current answer
  │    + its own previous answer
  │    prompt: "Critically evaluate all answers ... give your revised answer"
  │
  └─ call(judge)                         1 call
       prompt: question + every panelist's final answer
```

Total: `panel.length × (1 + rounds) + 1`. For 3 panelists and the default 1 round: **7 calls.**

Confirmed properties, all matching the handoff:

| Property | State |
|---|---|
| Round stop condition | **Fixed integer only.** No issue-driven or convergence stop |
| Peer context | **Full output broadcast**, every peer to every peer, every round |
| Judge | **Always called**, unconditionally |
| Judge default | `panel[0]` — the first panelist judges its own debate |
| Injectable dispatcher | **None.** Calls `callProvider` directly → cannot be call-counted offline |
| Run status / retrieval / evidence label / timings | **None** |
| System prompt / agent role | **None.** Panelists are bare providers, not registry agents |

### The two modes have incompatible agent models [FACT]

`Panelist` is `{ id, provider, model }`. `Worker` is `{ id, provider, model, role, evidenceCapable }`
and is produced by `resolveRoster()`, which derives `evidenceCapable` from the model
capability registry. Debate has no registry integration, so **a debate panelist can never
be evidence-capable** and no debate output can carry retrieval metadata.

---

# PART 2 — REUSE BOUNDARIES

## 3. Worth extracting as shared primitives [DECISION]

| Candidate | Why it survives analysis |
|---|---|
| **Bounded excerpt selection** | Both modes need "include part of another agent's output". Debate currently does the unbounded version. A pure `selectExcerpt(text, ref, maxChars)` is testable offline and is the thing that keeps context growth bounded |
| **Best-effort structured-block parsing** | `extractJsonObject()` already exists but *throws*. M2 needs a non-throwing variant that returns `undefined` rather than failing the run. Extract as `tryExtractJsonObject()` beside it; do not change the existing throwing behaviour used by planning |
| **The injectable dispatcher pattern** | `options.call` already exists in the orchestrator. If any debate-shaped work becomes part of M2, it needs the same seam or M2's call counts cannot be tested offline |

## 4. Must NOT be reused or nested [DECISION]

| Do not | Reason |
|---|---|
| **Call `runDebate()` inside `runOrchestrator()`** | It has no injectable dispatcher, no status model, no retrieval, no policy, and always adds a Judge call. Nesting it imports every one of those and makes M2's call ceiling unbounded by the orchestrator's own rules |
| **Reuse the debate critique prompt** | It instructs "give your revised, improved answer to the original question" — whole-task ownership. That directly contradicts the Worker Context Contract's "Execute only the assigned mission. Do not take over the full task" |
| **Reuse the Judge** | Out of scope by the handoff, and the default judge is `panel[0]`, i.e. a participant judging itself |
| **Reuse debate's round loop** | Its stop condition is a counter. M2's stop condition is "is there a decision-sensitive issue" — a different mechanism, not a parameterization of the same one |

**Ownership boundary [DECISION]:** debate semantics are *symmetric peer critique with a
verdict*. Orchestrator semantics are *asymmetric delegation with a contract*. M2 belongs to
the orchestrator. `run_debate` should be left alone this round.

---

# PART 3 — SYNTHESIS GATE FEASIBILITY

## 5. Can one synthesis call reliably emit provisional answer + issue list?

### The risk is not "can a model do it". It is where the failure lands. [FACT]

Today the orchestrator has **exactly one** parse dependency: the Chief's plan. When it
fails, it fails at `orchestrator.ts:428` — **before any worker has been paid for**.

Making synthesis a gate adds a second parse dependency **after all worker cost is spent**,
on the call that currently produces the deliverable. In the recorded DEEP run that is
232.9 s of planning + worker time already committed.

Synthesis is also already the slowest single stage: **110.377 s of 251.313 s (44%)** [FACT].
Asking it to additionally produce a structured issue list makes the longest call longer.

### Recommendation [DECISION]

**Do not make the answer depend on the parse.** Structure it so that a parse failure
degrades to exactly today's behaviour:

```
synthesis output = free-text answer
                   + optional trailing fenced JSON block
```

- The **answer** is the text with the block removed. Never parsed, never schema-validated.
- The **issue list** is parsed best-effort. On any failure — missing block, invalid JSON,
  schema mismatch — treat it as *no issues*, record why, and finish with the provisional
  answer.

This makes the gate strictly additive: **the worst case is current behaviour plus one
recorded note.** It also means a Round 2 never runs on a malformed gate, which is the
conservative direction.

### What the gate must be given that it does not have today [DECISION]

To emit a defensible `needs_evidence` issue, the gate needs retrieval metadata that the
synthesizer currently never sees (§1). Minimum addition: per successful worker, whether
retrieval was attempted, its status, and the source count — **not** the full source list,
and **not** `groundingSupports`.

## 6. Minimal issue schema and fallback semantics [DESIGN]

Starting from the handoff's candidate, unchanged in shape:

```ts
interface CollaborationIssue {
  targetAgentId: string;
  sourceRef: string;
  challenge: string;
  decisionSensitive: boolean;
  action: "peer_challenge" | "needs_evidence";
}
```

Parse and validation ladder — each step failing means *no Round 2*, never a failed run:

| Step | On failure |
|---|---|
| Locate trailing JSON block | no issues; note `gate_block_absent` |
| `JSON.parse` | no issues; note `gate_block_unparseable` |
| Zod schema validation | no issues; note `gate_schema_invalid` |
| `targetAgentId` ∈ roster **and** ∈ this run's successful assignments | drop that issue; note `issue_target_unknown` |
| `decisionSensitive === true` | drop; not decision-sensitive is not worth a call |
| `action === 'needs_evidence'` **and** target not `evidenceCapable` | drop; note `evidence_target_not_capable` |
| More than one surviving issue | **take at most one**, deterministically (see below) |

**Deterministic selection [DECISION]:** if several issues survive, do not let the model
choose and do not choose randomly. Sort by a fixed key — `action` (`needs_evidence` before
`peer_challenge`), then `targetAgentId` lexicographically, then array index — and take the
first. Deterministic selection is what makes the run auditable and the offline test stable.

---

# PART 4 — ROUND 2 CONTRACT

## 7. Selective peer context and bounded references [DESIGN]

Candidate Round 2 worker input, and nothing else:

```
Original User Task            (unchanged, same string as Round 1)
Assigned Mission              (the target's own Round 1 mission, unchanged)
Your previous response        (the target's own Round 1 output, in full)
One peer excerpt              (bounded, see below)
One targeted challenge        (issue.challenge)
Retrieval context             (only if action === needs_evidence)
```

### `sourceRef` must resolve deterministically [DECISION]

The handoff asks how excerpt selection can be deterministic, bounded and auditable. Free-text
`sourceRef` cannot be. Constrain it to an identifier the runtime already owns:

```
sourceRef := "<agentId>"            → that worker's Round 1 output
```

Then excerpting is a pure function of `(text, maxChars)`, not of model-chosen offsets.
**Do not let the gate emit character ranges or quoted spans** — a quoted span has to be
located in the original, which reintroduces string matching and the exact class of false
negative that produced discrepancy D2.

Bound: one peer excerpt, one target, head-of-text truncation at a fixed limit, recorded
verbatim in the run record so the Round 2 input can be reconstructed. **Never broadcast all
worker outputs.**

## 8. Round 2 routing and capability-based target validation [DECISION]

Validation must be structural, consistent with the project's existing pattern that a model
cannot assert a capability into existence:

| Check | Source of truth |
|---|---|
| Target exists | `workers` roster |
| Target ran in Round 1 and succeeded | `workerResults` |
| Target is not the source of the excerpt | `issue.sourceRef !== issue.targetAgentId` |
| `needs_evidence` target can actually retrieve | `worker.evidenceCapable`, which is already derived from the model capability registry |

The last row is the important one. `needs_evidence` means *an external fact is missing*.
Routing that to a specialist with no `grounded_retrieval` produces another training-data
opinion wearing an evidence label's clothing. **[FACT]** Today only Gemini has
`grounded_retrieval` enabled in runtime, so in the current roster `needs_evidence` can only
ever route to `market_researcher`.

---

# PART 5 — STATUS, STOP, FALLBACK

## 9 & 11. Existing vs proposed status semantics [DECISION]

`RunStatus` today describes **Round 1 worker completion**. Overloading it would destroy that
meaning: a run whose Round 1 fully succeeded and whose optional Round 2 failed is not
`DEGRADED` in the sense every existing test and banner uses.

**Recommendation: a separate, optional field. Do not touch `RunStatus` or `EvidenceLabel`.**

```ts
interface CollaborationReport {
  attempted: boolean;
  outcome: 'NOT_TRIGGERED' | 'COMPLETED' | 'SKIPPED' | 'FAILED';
  reason: string;              // machine-readable, e.g. 'gate_schema_invalid'
  issue?: CollaborationIssue;  // the one selected, if any
  round2AgentId?: string;
  answerSource: 'round1_provisional' | 'round2_decision_synthesis';
}
```

`answerSource` is the field that matters for evaluation: it states which text the user
actually received, which is exactly what an ablation needs and what a reader of the run
record would otherwise have to infer.

### Required behaviour table [DESIGN]

| Situation | Final answer | `outcome` | Run `status` |
|---|---|---|---|
| No issue emitted | provisional | `NOT_TRIGGERED` | unchanged |
| Gate block absent / unparseable / schema-invalid | provisional | `SKIPPED` | unchanged |
| Issue targets unknown or Round-1-failed agent | provisional | `SKIPPED` | unchanged |
| `needs_evidence` → non-retrieving target | provisional | `SKIPPED` | unchanged |
| Round 2 worker throws or times out | provisional | `FAILED` | **unchanged** |
| Decision synthesis throws | **provisional** | `FAILED` | **unchanged** |
| Round 2 + decision synthesis succeed | decision synthesis | `COMPLETED` | unchanged |
| Round 1 `DEGRADED` | *see below* | | `DEGRADED` |
| Round 1 `FAILED` | `null` | `NOT_TRIGGERED` | `FAILED` |

**Round 1 `DEGRADED` [DECISION]: do not run Round 2.** A degraded run is already missing a
specialist's contribution; spending two more calls to challenge what remains optimises the
wrong thing, and the DEGRADED banner already tells the reader the answer is thin. This also
keeps the triggered path's cost analysis simple — it only ever applies to clean runs.

**Round 1 `FAILED` cannot reach the gate at all [FACT]** — `policy.synthesize` is false with
reason `no_successful_workers`, and the function returns before synthesis.

---

# PART 6 — EVIDENCE BOUNDARY

## 10. No-elevation invariant [DECISION]

> **Collaboration can expose uncertainty, but cannot validate evidence.**

I endorse this as an invariant and recommend it be enforced structurally rather than by
convention. `deriveEvidenceLabel()` currently reads only `complexity`, the roster's
`evidenceCapable` flags, and each worker's actual `retrieval.status` — no collaboration
input exists in its signature, so **the invariant holds today by construction** [FACT].

The risk M2 introduces is a Round 2 worker that *does* retrieve. That is a real retrieval
event and would legitimately move a `CONDITIONAL` run to `PARTIALLY_GROUNDED` under the
existing rules — which is not an elevation *by collaboration*, it is an elevation by
retrieval that happened to occur in Round 2.

**[OPEN] Q-A:** should a Round 2 retrieval count toward the evidence label at all? Counting
it is consistent with "the label reflects what execution actually did". Not counting it is
more conservative. I lean toward counting it, because refusing to count a real retrieval
would make the label *understate* execution, and every other rule in this system is built to
prevent overstatement, not understatement. This needs an explicit decision before
implementation.

**Ceiling is unaffected either way:** `PARTIALLY_GROUNDED` remains the maximum. Nothing in
M2 may introduce `EVIDENCE_BACKED`. A deterministic offline test should assert that no
collaboration path produces a label outside the existing four values, and that peer
agreement alone never changes a label.

**[FACT] Claim-level validation remains impossible.** `groundingSupports` is present in the
live API response and is retained inside `RetrievalResult.raw`, but it is **not declared in
`GeminiGroundingMetadata`** (`gemini.ts` declares only `webSearchQueries` and
`groundingChunks`) and **no code in `src/` reads it**. Any consumer would have to widen the
type first. Claim-to-source support must not be inferred from source presence. That is Step 10.

---

# PART 7 — CALLS AND LATENCY

## 12. Logical-call ceiling — the handoff's "about 7" is right for the observed run and low in general [FACT]

Baseline is `1 + N + 1`. The triggered path adds one targeted worker and one decision
synthesis:

```
ceiling = 1 (chief) + N (round 1) + 1 (gate) + 1 (round 2) + 1 (decision) = N + 4
```

| N | Baseline | Triggered ceiling |
|---|---|---|
| 1 (SIMPLE direct) | 2 | not applicable — SIMPLE should not gate |
| 2 | 4 | 6 |
| **3 (the observed DEEP run)** | **5** | **7** ✅ matches the handoff |
| **4 (`SPECIALIST_CAP.deep`)** | **6** | **8** |

**Correction:** `SPECIALIST_CAP.deep = 4` [FACT], so the ceiling is **8**, not 7. Seven is
the ceiling *for a three-specialist plan*. Because planning is bounded-not-deterministic —
the same DEEP task has produced 2- and 3-specialist plans — the ceiling must be expressed as
`N + 4`, or a run that legitimately plans four specialists will look like a violation.

### Latency [FACT + DESIGN]

Measured DEEP: planning 18.854 s, workers 122.082 s, synthesis 110.377 s, total 251.313 s.

The triggered path adds a Round 2 worker span and a **second synthesis-class call**.
Synthesis was 110 s. Two synthesis-class calls plus one targeted worker plausibly puts a
triggered DEEP run in the **400–450 s** range — but that is arithmetic on one observation,
not a measurement. **[SIGNAL]** It should be stated as a design risk, not a number.

The direction is unambiguous even so: **M2's triggered path roughly doubles the slowest
part of the run.** The gate must therefore trigger rarely, which is an argument for the
strict `decisionSensitive` filter and the single-issue cap rather than against them.

---

# PART 8 — EXPERIMENT

## 13. A/B/C/D design and confound controls

| Arm | Description |
|---|---|
| A | strong single model + equivalent retrieval access |
| B | current orchestrator: Chief → Round 1 → synthesis |
| C | candidate: gate → targeted Round 2 → decision synthesis |
| D | strong single model → self-review, reasoning budget comparable to C |

### Two blockers found in code reality [FACT]

**E1 — retrieval parity for arm A is currently impossible except on Gemini.**
`grounded_retrieval` is `enabledInRuntime: true` for `gemini-3.1-pro-preview` only; Claude
and OpenAI are `supportedByProvider: true, enabledInRuntime: false`. So "single model with
equivalent retrieval access" can only mean Gemini today. Either arm A is Gemini, or every
arm runs retrieval-off and the evidence dimension leaves the experiment entirely.
**This is a design constraint, not a preference.** [OPEN] Q-B: which?

**E2 — outputs are self-unblinding.** `buildOutputBanner()` prepends
`PARTIALLY_GROUNDED` / `HYPOTHESIS` / `DEGRADED` text to the deliverable. An evaluator
comparing arms would see the arm's provenance in the first line. Evaluation must compare
**banner-stripped** text, and the stripping must be mechanical and recorded.

### Controls [DESIGN]

- **Frozen inputs:** one task list, byte-identical across arms — the existing
  `benchmark-task.mjs` single-source pattern is the precedent and should be extended, not
  re-invented per arm.
- **Reasoning budget parity (D vs C):** `DEFAULT_MAX_TOKENS` is shared across providers
  [FACT]. D's budget must be set from C's *observed* consumption, not guessed.
- **Error accounting must be symmetric.** Count material new errors introduced, not only
  errors fixed. An arm that fixes two claims and invents one is not obviously better.
- **Evaluator independence.** A model that participated in an arm must not score that arm.
  Given the roster, this constrains which model can evaluate which arm and should be fixed
  in advance, in writing.

## 14. Productionization gate [DECISION]

Directional, no invented thresholds:

- C indistinguishable from B → **stop M2.**
- C's improvement not better than D's → peer interaction has shown no special value; the
  gain is reasoning budget. **Stop.**
- C fixes errors but introduces as many or more material new ones → **stop or rethink.**
- Productionize only if C materially improves on B **and** that gain is not reasonably
  explained by D.

**[DECISION] Add one gate the handoff does not list:** if the gate almost never triggers on
representative tasks, C collapses into B plus one wasted structured-output requirement on
the critical path. **Trigger rate is itself a kill criterion**, and it is measurable long
before quality is.

---

# PART 9 — RECOMMENDATION

## 15. Smallest viable V1 [DECISION]

1. Extend the synthesis prompt to append an **optional** trailing JSON block containing at
   most a small issue list. Free-text answer remains primary and unparsed.
2. Give the synthesis call minimal retrieval context per worker (attempted / status /
   source count) so `needs_evidence` is grounded in something.
3. Best-effort parse + the validation ladder in §6. Any failure ⇒ provisional answer.
4. Deterministic single-issue selection.
5. Round 2: one worker, `buildWorkerPrompt`-shaped, plus one bounded peer excerpt and one
   challenge. `evidenceCapable` required for `needs_evidence`.
6. Decision synthesis: one call. On failure ⇒ provisional answer.
7. `CollaborationReport` beside `RunReport`. `RunStatus` and `EvidenceLabel` untouched.
8. Offline tests with the injected dispatcher asserting exact call counts per path, the
   fallback ladder, deterministic selection, and the no-elevation invariant.

**Gate only `deep`. [DECISION]** `simple` has direct delivery precisely because
orchestration was not earning its cost there; `normal` is unmeasured. Gating `deep` alone
keeps the blast radius on the runs where a wrong decision is expensive, which is the same
reasoning that put the evidence label on `deep` only.

### One piece of test infrastructure will break [FACT]

`test-execution-policy.mjs:38` identifies stages as:

```js
const stage = calls.length === 0 ? 'planning' : options.system ? 'worker' : 'synthesis';
```

**Synthesis is identified by the absence of a system prompt.** M2 introduces a second
synthesis-class call, and any system prompt on either would be misclassified as a worker.
This heuristic must be replaced with an explicit stage label before M2 tests are written,
or the call-count assertions will silently measure the wrong thing.

## 16. Explicitly out of scope [DECISION]

Judge; autonomous or planning loops; more than one Round 2 worker; more than two rounds;
full worker-output broadcast; disagreement taxonomy; any `EVIDENCE_BACKED` path;
`groundingSupports` consumption (Step 10); Steps 8, 9, 10; Chief prompt or Worker Context
Contract changes; ExecutionPolicy or retrieval changes; nesting `run_debate`; pricing or
cost values; large live benchmarks.

## 17. Implementation order, if approved [DESIGN]

1. Replace the test-harness stage heuristic (no runtime change).
2. `tryExtractJsonObject()` + `CollaborationIssue` schema + validation ladder — pure, offline.
3. `CollaborationReport` type and plumbing, always `NOT_TRIGGERED`. No behaviour change.
4. Gate prompt + retrieval context + best-effort parse. Still never triggers Round 2.
   **Measure trigger rate here** — the §14 kill criterion applies before any Round 2 exists.
5. Round 2 execution + decision synthesis behind an explicit opt-in flag.
6. Invariant and fallback tests.
7. A/B/C/D ablation.
8. Only then consider default-on.

Steps 1–4 are reversible and add no model call. The first irreversible cost is step 5.

## 18. Open questions [OPEN]

| # | Question |
|---|---|
| Q-A | Does a Round 2 retrieval count toward `evidenceLabel`? (§10 — I lean yes; needs a decision) |
| Q-B | Arm A retrieval parity: Gemini-only, or all arms retrieval-off? (§13 E1) |
| Q-C | Should the gate see failed workers' error text? It currently sees nothing about them, yet a failure is decision-relevant |
| Q-D | Is `normal` ever gated, or is `deep`-only permanent? |
| Q-E | Where do Round 2 timings live — extend `timings`, or a separate block? Extending changes a shape existing comparisons depend on |
| Q-F | Should the direct-delivery path apply `buildOutputBanner` defensively, so the §1 latent coupling cannot bite a future path? |
| Q-G | If the gate emits an issue but Round 2 is disabled, is the issue surfaced to the user or recorded only? |

---

## Summary

- **Nothing was implemented.** No file under `src/` was modified. 99 offline tests still pass.
- **The handoff's snapshot is accurate**, with two documented discrepancies: the working
  directory is not a git checkout, and one stored Step 7.1 artifact carries a documented
  false-negative verdict.
- **Two corrections to the handoff's stated boundaries:** the DEEP logical-call ceiling is
  `N + 4` — 8 at `SPECIALIST_CAP.deep`, not 7 — and the synthesizer does not currently
  receive any retrieval metadata, so a gate asked to raise `needs_evidence` would be
  reasoning about evidence it cannot see.
- **The main design recommendation** is that the gate must never put the deliverable behind
  a parse: worst case must equal today's behaviour plus a note.
- **The main risk** is latency, not correctness — the triggered path roughly doubles the
  slowest stage of the run, which makes trigger rate a kill criterion in its own right.
