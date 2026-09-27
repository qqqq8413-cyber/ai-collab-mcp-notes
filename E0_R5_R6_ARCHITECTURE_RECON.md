# E0-R5 / E0-R6 Architecture Reconnaissance

Status: read-only architecture evidence for GPT review. E0-R5 and E0-R6 are not implemented or authorized by this document. Facts below describe the repository at the E0-R4 work-branch review point; proposals are explicitly marked.

## Boundary inherited from E0-R4

`src/execution/boundary.ts` separates request snapshot, exact model binding, R3 capability/parameter admission, exact registered mechanism resolution, D1-A claim, executor-bound authorization, and one normalized execution result. `src/execution/types.ts` records execution/attempt/provider/model identity, optional provider usage and retrieval, and SUCCESS / KNOWN_FAILURE / UNCERTAIN. The result is an execution fact, not a reviewed finding or decision. `src/execution/registry.ts` identifies mechanisms, not specialist roles or evidence quality. Neither registry existence nor a successful model response grants product authority.

## E0-R5: independent consultation

### Reusable facts and mechanisms

| Existing surface | Reusable for R5 | Boundary |
| --- | --- | --- |
| `src/execution/boundary.ts`, `types.ts`, `registry.ts` | Exact execution identity, admission, D1 claim, executor binding, normalized facts | No consultation scheduler, specialist identity, or product verdict exists yet. |
| `src/stress-test/execution-authority.ts`, `deliberation.ts` | Existing D1-A route claim and terminal controls | Route admission/claim is not proof that a specialist's answer is correct. |
| `src/stress-test/types.ts` `ReviewFinding`, `SemanticIssue` | Finding occurrence and clustered-issue provenance (`reviewerRunId`, `findingIds`) | `reviewerRunId` groups a pass; it does not establish a provider, role, independent source, or execution attempt. EvidenceState is relative to supplied material. |
| `src/stress-test/types.ts` `HumanAdjudication` | Separate human judgment/action-change authority | Never derive it from a model response, peer agreement, or registry lookup. |
| `src/stress-test/deliberation.ts` route vocabulary | Existing ADD_REVIEWER / REPLICATE / TARGETED_PEER_CHALLENGE intents and outcome validation | A planned route is not a provider call; recorded RouteOutcome has separate validation and ownership. |
| `src/agents/collaboration.ts` | Ideas for bounded, offset-bearing excerpts, only after source validation | Experimental orchestration output is not a canonical consultation record. |

### Proposed entry, exit, and identity (not a contract)

R5 should enter the execution runtime with a caller-owned *consultation intent* bound to a specific frozen session/artifact/context and an existing authorized route attempt. Before each model invocation, R3/R4 and D1-A still run in their current order. A candidate `ConsultationExecutionRef` would bind session ID, artifact/context hashes, route attempt ID, consultation ID, specialist role/assignment ID, execution ID, attempt ID, requested provider/model, effective provider/model, executor ID, and resulting status. The execution layer owns execution facts; a distinct consultation coordinator would own the mapping from one consultation to its independently dispatched executions. Merely adding a role to `NormalizedExecutionResult` would conflate provider facts with orchestration provenance.

The exit should be a detached, immutable consultation evidence/proposal record referencing exact execution results, not a `RouteOutcome`, `ReviewFinding`, or `HumanAdjudication` created implicitly. Any later product write must revalidate session binding, route lineage, source finding/evidence references, and the relevant canonical ledger. A failed or UNCERTAIN execution remains visible as such; it cannot be silently omitted from the denominator or retried as if no attempt occurred. Agreement is a relation among recorded proposals, never a vote that upgrades evidence or creates authority.

To substantiate independence, preserve per-attempt prompt/context identity, provider/model/executor identity, timing, result status, source references, retrieval state, and whether peer outputs were visible before that attempt. Different model names alone do not prove independent evidence acquisition; shared prompts, sources, prior outputs, or model priors can yield correlated answers. Do not infer independence from agreement.

### Minimal candidate types/ports requiring GPT approval

- `ConsultationIntent` / `ConsultationExecutionRef`: exact product binding and role-to-execution provenance, with a single authoritative owner for IDs and lifecycle.
- `ConsultationEvidence`: immutable list of all attempts, statuses, result references, source claims, and peer-visibility facts; bounded raw text or sealed references, not an adjudication.
- `ConsultationExecutionPort`: invokes the existing execution boundary for a named attempt and receives its execution fact; no bypass of registry or D1-A.
- `ConsultationRecordingPort`: records consultation provenance and its relation to the product route, then hands proposed findings to the product layer's existing validation/write APIs.

GPT decisions before implementation: who issues consultation IDs and role assignments; whether one D1 route claim covers one provider execution or a multi-execution consultation; how retry/replication differ and consume budget; how exact prompt/context and source visibility are sealed; how product RouteOutcome is recorded after consultation; whether a failed consultation can produce a bounded partial proposal; which new persistence/ledger is canonical for consultation provenance. These are architectural choices, not details R4 resolves.

## E0-R6: bounded ContextPack, not a second ledger

**Proposed responsibility:** provide one execution attempt a bounded, detached view of authorized context, with exact source references and hashes. It is an input artifact. Its presence never makes a claim current, verified, or approved. On consumption, the canonical source and its integrity checks remain authoritative.

| Candidate | Canonical source | Copying safe? | Provenance and currentness risk | Revalidate downstream? |
| --- | --- | --- | --- | --- |
| Frozen artifact text or excerpt | `StressTestSession.artifactText` + `artifactHash` | Bounded detached excerpt after `verifyFrozenInputIntegrity` | Truncation/offsets may hide contrary text; successor version differs | Yes: session ID, exact hash, excerpt offsets/content against current bound artifact. |
| Author context | `StressTestSession.authorContext` + `authorContextHash` | Detached selected items | `sourceType=AUTHOR` is an author claim, not independent verification; item status may be RESOLVED/SUPERSEDED | Yes: exact item ID, source type, status, hash, and session binding. |
| ReviewFinding | `session.findings` | Detached selection | `reviewerRunId` groups a pass, not reviewer identity; evidenceState only concerns supplied material | Yes: exact owned ID/key, canonical ledger, artifact location and binding. |
| SemanticIssue | `session.semanticIssues` | Detached selection plus finding IDs | Cluster is not a merged proof; issue status may change and leaf findings may be invalid | Yes: global issue/finding ledger, every member ID and status. |
| UnresolvedQuestion / input refs | `DeliberationState` bound to session | Detached selection | Question may become non-current or be disposed; refs can be stale or wrong kind | Yes: `verifyDeliberationBinding`, global ledgers, exact refs and currentness. |
| Prior execution facts | R4 `NormalizedExecutionResult` plus a future canonical execution/consultation record | Only if the record owner is defined and identities sealed | SUCCESS is not semantic correctness; UNCERTAIN is not replay permission; result may lack independent source provenance | Yes: exact attempt/execution binding and all status/identity facts; do not promote to product outcome. |
| Explicit evidence references / EvidenceSubject | Deliberation evidence-subject ledger and exact references | Detached, bounded citation/reference view | Retrieval/citation may be missing, contradictory, or stale; URLs alone do not verify content | Yes: complete ledger first, then exact subject/ref resolution and freshness policy. |
| HumanAdjudication / RouteOutcome | Product ledgers only | Possibly label/reference only, pending GPT decision | A copy can appear authoritative after the source changes | Always: do not let copied text or status replace canonical read. |

The table proposes candidates, not finalized ContextPack fields. GPT must choose which are actually required for a specific execution route, and which may be omitted under a size budget.

### Integrity, size, and ownership

The repository already checks frozen input hashes (`src/stress-test/session.ts`), complete semantic-issue/adjudication/revision ledgers (`session.ts`, `decision-record.ts`), and complete route/evidence/request ledgers in `deliberation.ts`. R6 should invoke those canonical checks **before** selecting one local item; validating only an item named by the pack can miss corrupt unrelated state. A pack should record source session/version/hash, exact typed IDs, extraction offsets, capture time, truncation markers, and a deterministic size budget. Deep-copy/freeze or equivalent ownership isolation must prevent caller mutation after capture; check the source again at the consumer boundary, because a stable old copy is still stale when the canonical ledger advances. Avoid caching mutable authority or creating parallel lifecycle/status fields in the pack. If a source cannot be proven current, omit it or fail closed; do not synthesize a placeholder claim.

GPT decisions before implementation: route-specific inclusion rules and token/character budgets; whether/how packs are persisted or hashed; timestamp and successor-session freshness rules; treatment of incomplete external evidence; redaction and sensitive-text policy; exact canonical validators at pack construction/consumption; handling of a pack that becomes stale while an async execution is in flight. No ContextPack code is added by E0-R4.

## DO NOT REUSE AS AUTHORITY

| Surface | Actual category | Why it cannot authorize R5/R6 |
| --- | --- | --- |
| Legacy orchestrator synthesis (`src/modes/orchestrator.ts`, `src/agents/policy.ts`) | Delivery/coordination output over workers | A synthesized answer is neither a D1 claim nor a human adjudication. |
| Agent registry (`src/agents/registry.ts`) | Specialist configuration convenience | It permits overrides/inline definitions; unlike ExecutorRegistry, it is not exact immutable execution-mechanism authority. |
| Experimental collaboration (`src/agents/collaboration.ts`) | Experimental challenge/excerpt evidence | Prompt gate and peer excerpts can inform design, not validate product outcome or source independence. |
| Model consensus/agreement | Derived comparison signal | Correlated priors/sources can produce agreement without independent evidence or correctness. |
| `Round1Snapshot` (`src/modes/orchestrator.ts`) | In-process experimental replay data | Detached/frozen for comparison, but not a persisted canonical ledger, sealed consultation record, or authorization. |
| `RouteOutcome` (`src/stress-test/deliberation.ts`) | Validated product/coordination fact | It must be recorded through its own domain API after execution; a model result cannot fabricate or substitute it. |
| Controller audit (`src/automation/types.ts`) | Operational repository-workflow fact | It records controller states/commits, not artifact evidence, specialist independence, D1 execution authority, or human product judgment. |

## Proposed sequencing (advisory; GPT owns architecture)

1. Decide R5 consultation identity, D1 budget granularity, provenance ledger, and product write boundary; implement one narrow independent consultation route with fake executors and explicit failure/uncertainty tests, without reusing legacy synthesis authority.
2. Decide R6 route-specific context sources, global validators, bounding, redaction, and freshness policy; implement a detached ContextPack as an execution input view only, with stale/alias/corrupt-ledger tests.
3. Integrate the two only after each contract is independently accepted; verify that copied context and model agreement never create D1, RouteOutcome, or HumanAdjudication authority.
