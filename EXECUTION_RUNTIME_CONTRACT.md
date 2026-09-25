# Execution Runtime Contract

Status: E0-R-C0 contract freeze, pending GPT independent acceptance.
Base: `4d8ee2ba387570d789c2c21dde0a197f623d64f8` (`origin/main`).
Work branch: `work/e0-r-c0-execution-runtime-contract`.

This document defines future architecture, not implemented runtime behavior.
GPT owns architecture/acceptance; the human retains final authority. Completion
of C0 does not authorize E0-R1 or later implementation.

## 0. Repository Reality and Scope

At this base, `src/providers/types.ts` exposes `CallOptions` and `CallResult`;
`src/providers/index.ts` dispatches through a provider switch. There is no
execution admission or parameter reconciliation layer in that dispatch path.
Adapters construct their own requests and forward temperature. Their returned
model is the locally selected request model, not a separately observed response
model. Usage, finish reason, and request ID are not normalized in `CallResult`.

`src/models/capabilities.ts` separates boolean provider support from runtime
enablement, but lacks first-class parameter constraints and claim provenance.
Unknown lookups become false in the boolean helpers; they do not yet preserve
the UNKNOWN/UNSUPPORTED distinction required below. An omitted model can select
the first provider profile. That behavior is not the future admission contract.
`src/agents/registry.ts` consumes those helpers; `src/agents/policy.ts` controls
delivery/synthesis policy, not capability admission.

Claude/OpenAI currently report requested retrieval as unsupported; Gemini wires
Google Search and normalizes grounding metadata. These are repository wiring
facts, not independent verification of current vendor/model support. Existing
SDK invocation does not establish zero SDK-internal retries.

`PRODUCT_RUNTIME_RECONCILIATION.md` and historical `HANDOFF.md` sections describe
older pinned states. In particular, historical unimplemented-route descriptions
must not erase current deliberation/checkpoint code in
`src/stress-test/deliberation.ts`. Current code takes precedence. C0 preserves
all existing behavior and changes only this contract and an appended handoff.

## 1. ExecutionRequest

ExecutionRequest represents normalized CHIEF intent, never a provider wire body.
Its conceptual fields cover:

- Explicit requested provider and model, with provenance for resolved defaults.
- Prompt/input content and separate system instruction.
- Requested generation parameters, preserving absent versus explicitly supplied.
- Retrieval intent and its requirements; omission must not imply successful retrieval.
- Execution/call stage and purpose.
- Run, logical execution, and attempt identity plus originating record references
  sufficient to correlate admission, transport facts, and downstream validation.

Defaults must be resolved explicitly before capability lookup; a provider's first
registry entry is not authority for a different requested model. Provider-specific
messages, tool declarations, SDK settings, and wire names remain adapter-owned.
Exact serialized types/versioning are deferred; these responsibilities are frozen.

## 2. Capability, Evidence, and Readiness

Capability and parameter claims are specific to model, operation, and runtime
adapter/version. Provider brand alone grants nothing. Vendor support and local
runtime enablement are separate facts; each can be unknown. Wiring alone is not
proof that the vendor accepts a feature.

Claims need traceable provenance: source/reference, applicable model/runtime and
operation, observation or review time, evidence kind, and limitations. Repository
history, vendor documentation, and a controlled execution observation are distinct
evidence kinds. Conflicting, stale, or inapplicable evidence must be explicit.
One successful call is an execution fact, not universal capability verification.

Readiness must represent at least:

| State | Meaning |
| --- | --- |
| VERIFIED | Applicable evidence verifies support and the scoped runtime path. |
| WIRED_UNVERIFIED | A local path exists, but applicable verification is incomplete. |
| UNSUPPORTED | Evidence establishes lack of support for the scoped capability. |
| UNKNOWN | Evidence is absent, conflicting, or insufficient to determine support. |

Preserve the underlying vendor-support/runtime-enablement axes and evidence even
when presenting readiness. Vendor support with no local implementation is not
executable readiness. VERIFIED is not proof of semantic correctness. Neither
WIRED_UNVERIFIED nor UNKNOWN silently grants production execution permission;
any future controlled verification needs separate explicit authorization.

## 3. Parameter Constraints and Reconciliation

Parameters become first-class capability records, not hidden adapter conditionals.
The constraint model must represent unsupported, fixed value, numeric range
(including bound inclusivity), discrete allowed values, and unknown. Constraints
must state whether explicit transmission is allowed: a fixed provider default
does not itself imply that sending that value is legal. Do not invent ranges.

Given explicit intent, applicable evidence, readiness, and an identified policy,
reconciliation must deterministically record one outcome per requested parameter:

| Outcome | Meaning |
| --- | --- |
| FORWARD | Value and transmission satisfy verified applicable constraints. |
| OMIT | An explicit, recorded rule permits omission without silently changing intent. |
| REJECT | Invalid value, unsupported request, or incompatible required semantics. |
| UNKNOWN | Available evidence cannot determine a valid disposition. |

OMIT is not an escape hatch for unsupported explicit requirements. Where omission
would change requested semantics, reject or obtain an explicit revised intent
before admission. Never silently clamp, substitute, infer support from a name,
or treat UNKNOWN as FORWARD. Record requested value, disposition, effective
value/absence, reason, evidence reference, and policy identity. A deterministic
UNKNOWN is a valid reconciliation result but is not admission permission.

## 4. H1: Claude Temperature Reconciliation

`CallOptions.temperature` is globally expressible and
`src/providers/claude.ts` currently forwards it. Repository commit
`44d5fe9465fc9551174d69278415058b605cc8b6` records that `claude-sonnet-5`
rejected temperature with HTTP 400 and removed passthrough. Commit
`cf074c2c640559eb40a578f921b82438b2e7fd96` deliberately restored passthrough
pending capability redesign. This is a repository-recorded observation, not a
freshly reproduced provider response or a claim about every Claude model.

C0 does not hotfix H1. Future capability/parameter reconciliation must determine
FORWARD, OMIT, REJECT, or UNKNOWN using scoped evidence and runtime readiness.
Provider-wide Claude exceptions, authoritative model-name heuristics, silent
retry without temperature, and UNKNOWN-as-supported are forbidden solutions.

## 5. ProviderExecutor

ProviderExecutor accepts an already normalized/admitted request, translates it to
provider-specific wire format, invokes the provider, and normalizes the response.
It must preserve the effective semantics authorized at admission and correlate
execution facts to that admission. Invalid/stale admission cannot be self-repaired
by silently changing parameters or model selection.

It must not decide product routing, HumanAdjudication, or RouteOutcome authority;
self-authorize unsupported capabilities; or silently change requested semantics.
Defensive adapter validation can reject a mismatch but cannot grant permission.

## 6. NormalizedExecutionResult

The provider-neutral result must preserve:

- Requested provider/model and effective wire target, separately from actual
  provider/model when independently knowable or reported, with the basis recorded.
- Output content/text, without treating nonempty output as semantic correctness.
- Available usage with native units/meaning and availability; missing is not zero.
- Retrieval request/result, observed sources/queries, and explicit unavailable,
  unsupported, or failed distinctions where applicable.
- Available finish reason and provider request identifier.
- Bounded, allowlisted provider metadata required for interpretation/debugging.
- Normalized error/failure or uncertainty facts, stage, and execution identity.

Do not copy requested model into an observed-actual field. Do not invent token
counts, retrieval events, finish reasons, price, or cost. Usage truth, pricing,
and cost calculation are separate concerns. Arbitrary SDK objects, credentials,
and unbounded raw responses are not normalized metadata. Preservation rules must
identify omitted/unavailable information without creating false observations.
The result carries execution facts, never semantic decision authority.

## 7. Admission and Ordering

The required ordering is:

`intent -> capability lookup -> parameter reconciliation -> admission ->
ProviderExecutor -> NormalizedExecutionResult -> downstream validation/product semantics`.

Unsupported, invalid, or unresolved requests must not silently reach an adapter.
Admission binds the resolved intent, evidence/reconciliation decision, and
execution authorization. Adapters execute; they are not policy authorities.
Capability admission is necessary, not sufficient: existing D1-A ownership,
readiness, execution-policy, budget/deadline, and stop gates remain mandatory.
It must neither bypass nor replace `claimRouteExecution` and its checkpoint rules.

## 8. ExecutorRegistry Ownership

A future ExecutorRegistry owns explicit registration/lookup of executor classes,
conceptually MODEL_PROVIDER, MCP, CLI_AGENT, and REMOTE_AGENT. Registration says
which mechanism can handle an admitted request, not that it is authorized to act.
Capability ownership, admission policy, execution mechanism, and product authority
remain separate. No registry is implemented here; the provider switch stays intact.

## 9. Authority and Global Integrity

HumanAdjudication is the sole human decision authority in the domain. RouteOutcome
records validated execution/product fact, not a human decision. Model consensus,
synthesis, independent review, and replication are not HumanAdjudication.
Provider execution cannot certify semantic correctness, and agreement cannot
elevate evidence labels.

Preserve `src/stress-test/session.ts` ledger integrity and revision authorization
rules and `src/stress-test/deliberation.ts` RouteOutcome/checkpoint boundaries.
An executor must not directly create an authoritative RouteOutcome or bypass its
domain validation. Operational telemetry/audit records are separate from the
authority ledger; correlation does not confer authority. Global-before-local
integrity checks must not be weakened for convenience or partial report reads.

## 10. Failure and Uncertainty

UNKNOWN execution outcome is not FAILED. Future normalized handling must separate:

- Known pre-call failure: admission/translation failed without provider dispatch.
- Known provider failure: sufficient evidence identifies the failed operation.
- Confirmed execution success: response confirms completion, not correctness.
- Uncertain outcome: dispatch may have happened but completion is not established.

A timeout or lost connection after dispatch does not prove the provider did no
work. Logical attempts and transport attempts must remain distinguishable. Blind
replay is not the default; future retry/reconciliation requires explicit ownership,
evidence, and duplicate-execution policy. This principle does not alter existing
FAILED semantics or checkpoint enums in C0, nor claim distributed exactly-once
execution from existing single-process coordination. No retry/fallback is added.

## 11. Schema Layers

Compact model-facing schemas help models express proposals. Strict runtime/domain
validation establishes admissible records, identity, references, constraints, and
authority. A permissive model surface cannot weaken runtime validation. Parsing
success is not admission, execution success, ledger integrity, or human approval.
This contract does not change MCP schemas or current validators.

## 12. Context and Consultation

Model execution context is a bounded representation, not canonical authority state.
Future ContextPack/consultation may supply selected context with provenance;
ledger/domain records remain canonical and must be checked at authoritative
boundaries. Reviews, replication, and peer challenge remain evidence/proposals,
not authority by consensus. No ContextPack is implemented in C0.

## Delivery Boundary

C0 changes documentation only. No adapter, registry, admission, routing, schema,
deliberation, retry, or runtime behavior changes; no provider/model calls; no
CASE-001 access. E0-R1 (Capability / Parameter Model) is the next planned slice,
not an authorized continuation. Build and offline tests validate preservation;
they do not verify vendor capabilities or establish architecture acceptance.
