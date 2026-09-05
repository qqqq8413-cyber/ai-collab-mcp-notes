# Claude Code Handoff: Milestone 2 Scope Analysis

> **STATUS: EXECUTED (rev. 14).** The deliverable is
> [`MILESTONE2_SCOPE_ANALYSIS.md`](MILESTONE2_SCOPE_ANALYSIS.md); the summary lives in
> `HANDOFF.md` §20. Two statements below were **corrected by code reality** and should not
> be carried forward as written:
>
> - The "candidate DEEP logical-call ceiling: about 7" holds only for a three-specialist
>   plan. Planning is bounded, not deterministic. The ceiling is **`N + 4`**, which is
>   **8** at `SPECIALIST_CAP.deep = 4`.
> - A synthesis gate asked to judge `needs_evidence` cannot do so today: the synthesizer
>   receives only the original task and each successful worker's `agentId` / `mission` /
>   `output`. **No retrieval metadata reaches it.** Feeding it retrieval status is a
>   prerequisite change, not a side effect of building the gate.
>
> This document is retained as the brief that was executed. Milestone 2 runtime
> implementation is still not approved.

## Authority and Current State

Use repository code and the latest `HANDOFF.md` as the source of truth. This handoff
defines the next analysis task; it does not authorize runtime implementation.

- Repository: `qqqq8413-cyber/ai-collab-mcp-notes`
- Branch: `main`
- Runtime baseline before these handoff-only docs: `97e89d8d5b8ad9375b6d8fff232b3ca43aaa9b53`
- Step 1-6.1: done
- Step 7 Complexity Router: code + runtime accepted
- Step 7.1 E2E acceptance: done
- Offline tests at handoff: 99 passed, 0 failed
- Step 8 scope analysis: done; implementation deferred
- Milestone 2: scope analysis next; implementation not approved

Step 7.1 evidence is under `regressions/step7-1-e2e/`. SIMPLE direct delivery used
two logical model calls, skipped synthesis and returned Worker text exactly. The DEEP
case used three specialists, six search queries, 21 sources and synthesis, and remained
`PARTIALLY_GROUNDED`. No Step 7 runtime defect is currently confirmed for repair.

Before analysis, verify branch, remote state, working tree and `npm test`. If this
snapshot conflicts with current code, code reality wins and the discrepancy must be
documented.

## Product Question

The goal is not merely to invoke GPT, Claude and Gemini in parallel. It is to test
whether models can use one another's work, expose blind spots, challenge material
disagreements and produce a better decision than a strong single-model process.

The current orchestrator is primarily fan-out/fan-in:

```text
Chief planning
→ independent specialist work in parallel
→ one synthesis
```

Milestone 2 must determine whether a small amount of targeted cross-agent interaction
has value. It must not assume that a second round is valuable merely because it runs.

## Review Signals, Not Proof

Independent Claude and Gemini architecture reviews converged on these risks:

- an independent Chief Review can duplicate an extra model call;
- running all specialists in Round 2 is unnecessarily broad;
- full-output broadcast creates context growth;
- a large disagreement taxonomy is premature;
- peer agreement is not evidence validation;
- extra reasoning budget can masquerade as multi-agent benefit;
- M2 should first be an experimental prototype, not immediate production architecture.

GPT synthesis reduced the proposal accordingly. These are review signals only. Inspect
the code and challenge any point that does not survive code-reality analysis.

## Candidate Architecture

This is a candidate, not an approved implementation:

```text
Chief Planning
        ↓
Round 1 Specialists
        ↓
Synthesis Gate
        ├─ provisional answer
        └─ minimal issue list
                 ↓
       decision-sensitive cross-agent issue?
             ┌───┴───┐
            no      yes
             ↓        ↓
           Final   Targeted Round 2
                   max 1 specialist
                         ↓
                  Decision Synthesis
                         ↓
                       Final
```

Candidate hard boundaries, subject to analysis:

- maximum total rounds: 2;
- maximum Round 2 assignments: 1;
- candidate DEEP logical-call ceiling: about 7;
- no independent Chief Review call;
- no Judge;
- no autonomous agent loop or planning loop;
- no full Worker-output broadcast;
- no evidence-label upgrade;
- optional Round 2 failure falls back to the provisional Round 1 answer.

Do not expand these boundaries without explicit analysis and architecture review.

## Verified Code Reality at Handoff

### Current `run_debate`

`src/modes/debate.ts` currently:

- calls every panelist independently for initial answers;
- calls every panelist again in every configured round;
- gives each panelist its own previous answer plus the full answers of all peers;
- has a fixed numeric `rounds` loop, defaulting to one, with no issue-driven stop;
- always makes a final Judge call;
- defaults Judge provider/model to the first panelist unless supplied;
- calls `callProvider` directly and has no injectable dispatcher;
- has no orchestrator run status, retrieval report, evidence label or timings.

Do not nest `run_debate()` inside `run_orchestrator()` by default. Determine whether
small prompt/context or round-running primitives are worth extracting. Preserve
ownership boundaries where debate semantics conflict with orchestrator semantics.

### Current `run_orchestrator`

`src/modes/orchestrator.ts` currently:

- calls the Chief once and parses/enforces a bounded plan;
- runs assigned Workers in parallel;
- injects original task + assigned mission through the Worker Context Contract;
- requests retrieval only from resolved evidence-capable Workers;
- converts Worker failures into `SUCCESS`, `DEGRADED` or `FAILED`;
- derives evidence labels from execution facts, capped at `PARTIALLY_GROUNDED`;
- derives an independent ExecutionPolicy from plan/execution facts;
- directly delivers only eligible single-specialist SIMPLE output;
- otherwise calls the synthesizer once;
- supports an injectable provider dispatcher for offline tests, not through MCP;
- reports planning, parallel-worker-span, synthesis and total wall time.

The current synthesis prompt receives the original task and successful Worker mission/text
outputs. It is not structured to return both a provisional answer and issue list, and it
does not receive Worker retrieval metadata. Whether one call can safely serve as a
Synthesis Gate is unresolved and must be analyzed, including schema/parse failure and
fallback behavior.

### Current grounding metadata boundary

Gemini preserves provider grounding metadata under `RetrievalResult.raw`, including
fields observed in live evidence such as `groundingSupports`. Runtime consumers summarize
queries and source URLs, but no code consumes `groundingSupports`, and the synthesizer does
not receive it. Therefore:

> M2 currently cannot perform claim-level evidence validation.

Do not infer claim-to-source support from source presence. Claim validation remains Step 10.

## Evidence Invariant

Treat this as a strong candidate invariant:

> Collaboration can expose uncertainty, but cannot validate evidence.

Peer critique, agreement, Round 2 revision and decision synthesis may expose unsupported
assumptions, conflicts or requests for more evidence. None may elevate `evidenceLabel`.
Another model agreeing with grounded research cannot turn `PARTIALLY_GROUNDED` into
`EVIDENCE_BACKED`. A later implementation should include a deterministic invariant test
that no collaboration path can raise the evidence label.

## Minimal Issue and Context Candidates

Start from the smallest routing concept; do not build a complete disagreement taxonomy:

```ts
interface CollaborationIssue {
  targetAgentId: string;
  sourceRef: string;
  challenge: string;
  decisionSensitive: boolean;
  action: "peer_challenge" | "needs_evidence";
}
```

The routing question is whether another specialist should do work. `peer_challenge`
means another capability can materially test or correct a reasoning step. `needs_evidence`
means the gap is an external fact, which model agreement cannot resolve.

Candidate Round 2 context is limited to:

```text
Original User Task
+ target specialist's own Round 1 output
+ one relevant peer excerpt
+ relevant source/retrieval metadata
+ one targeted challenge
```

Analyze how `sourceRef` and excerpt selection can be deterministic, bounded and auditable.
Do not broadcast all raw Worker outputs to all specialists.

## Status, Stop and Fallback Questions

The current status model covers Round 1 Worker completion. Analyze how optional Round 2
should interact with it. The strong candidate is:

```text
Round 1 SUCCESS + optional Round 2 failure
→ preserve provisional answer
→ report collaboration attempt/failure separately
→ do not turn the whole run into FAILED
```

Define behavior for no issue, unusable issue schema, unknown target, target Round 1 failure,
Round 2 timeout/error, decision synthesis failure and a DEGRADED Round 1. Explain whether
new collaboration status belongs inside `RunReport`, beside it, or in a separate report.

## Call and Latency Boundary

The accepted DEEP observation was:

```text
planning:    18.854 s
workers:    122.082 s
synthesis:  110.377 s
total:      251.313 s
logical calls: 5
```

For its three-Worker plan, baseline logical calls are Chief + 3 Workers + synthesis = 5.
If the existing synthesis becomes a gate, a triggered path adds one targeted Worker and
one decision synthesis, yielding a candidate ceiling of 7. Verify this against the actual
proposed state machine. Do not count provider HTTP retries as observed calls, and do not
invent token/cost figures while Step 8 implementation is deferred.

## Required Experimental Ablation

Design comparable evaluation arms before production implementation:

```text
A: strong single model + equivalent retrieval access
B: existing Chief → Round 1 → synthesis orchestrator
C: candidate synthesis gate → targeted peer interaction → decision synthesis
D: strong single model → self-review, with extra reasoning budget comparable to C
```

D controls for the possibility that C improves only because it receives more reasoning
budget. Define tasks, frozen inputs, retrieval parity, output blinding, rubric, error
accounting and evaluator independence. Model consensus is not empirical validation.

Do not invent percentage thresholds. Use directional kill logic:

- if C is materially indistinguishable from B, stop M2;
- if C's improvement is no better than D's, peer interaction has not shown special value;
- if C fixes errors but creates as many or more material new errors, stop or rethink M2;
- productionize only if C materially improves B and that gain cannot reasonably be
  explained by the D self-review control.

## Required Code-Reality Analysis

Inspect at minimum `src/modes/debate.ts`, `src/modes/orchestrator.ts`,
`src/agents/policy.ts`, `src/providers/types.ts`, `src/providers/gemini.ts`, MCP schemas
in `src/index.ts`, and relevant tests. Answer:

1. Current orchestrator call graph and data flow.
2. Current debate call graph, context assembly, round stop and Judge behavior.
3. Components worth extracting as shared primitives.
4. Components that must not be reused or nested.
5. Whether one synthesis call can reliably emit provisional answer + minimal issue list.
6. Minimal issue schema and parse/fallback semantics.
7. Selective peer context contract and bounded excerpt/source references.
8. Round 2 routing and capability-based target validation.
9. Stop conditions and fallback behavior.
10. Evidence/validation boundary and no-elevation invariant.
11. Existing vs proposed status/failure semantics.
12. Logical-call and latency implications.
13. A/B/C/D experimental design and confound controls.
14. Productionization gate and kill logic without fabricated thresholds.
15. Recommended smallest V1.
16. Explicit out-of-scope.
17. Implementation order, if architecture is later approved.
18. Open architecture questions.

## Deliverable

Create `MILESTONE2_SCOPE_ANALYSIS.md`. It must separate current runtime facts, candidate
design, review signals/hypotheses, recommended decisions and unresolved questions.

Stop after the document and handoff update. Wait for architecture review before any
Milestone 2 runtime implementation.

## Explicitly Out of Scope This Round

Do not:

- implement Milestone 2 runtime;
- modify the Chief prompt or Worker Context Contract;
- modify Step 7 ExecutionPolicy or retrieval;
- implement Step 8, Step 9 or Step 10;
- add a Judge, autonomous loop, planning loop or more than one Round 2 Worker;
- build a comprehensive disagreement taxonomy;
- fill unverified pricing/cost values;
- run a large live benchmark.

The next task is exactly:

> Claude Code reads actual code and produces `MILESTONE2_SCOPE_ANALYSIS.md`. No Milestone 2 runtime implementation yet.
