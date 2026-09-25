# Automation Governance Contract (G1-C0)

Status: contract only; no controller or enforcement implementation exists.
Base: `9ad6dbbb7f318387e3a498fc91fae9910a37e638` (`origin/main`).
Work branch: `work/g1-c0-automation-governance-contract`.

This contract governs a future GPT/Codex coordination system. It does not grant
permission to run one. **DEFAULT DENY:** an action without an applicable,
verifiable authorization is forbidden. **NO AGENT MAY EXPAND ITS OWN AUTHORITY.**
An agent's proposed packet, report, or assertion cannot authorize its own new
permissions. Unknown or conflicting authorization fails closed.

## 1. Roles and Authority

| Role | Authority and limit |
| --- | --- |
| HUMAN | Final authority; only a fresh, explicit human decision can authorize exceptional, destructive, or sensitive action. An override names the exact action and scope; it is not a blanket waiver. |
| GPT_ARCHITECT | Owns architecture decisions, immutable implementation packets, independent acceptance, and bounded correction packets. Cannot silently grant itself implementation or human-gated authority. |
| CODEX_IMPLEMENTER | Implements only the active packet, runs permitted checks, and reports evidence. Cannot broaden scope, redefine acceptance after start, accept its own work, or promote itself to architecture/final authority. |
| CONTROLLER | Future deterministic coordinator and policy/state enforcer. Has no semantic authority, cannot waive gates, and cannot transform an agent's output into acceptance. Not implemented in C0. |
| GITHUB | Remote repository, commit SHA, CI, and branch-protection source of truth. GitHub status is evidence, not semantic acceptance. |

`ALLOW_AUTOMATIC` means a future controller *may* act only after an immutable,
authorized packet and all stated preconditions are verified. It is not a
standing grant to the current agent. `REQUIRE_GPT` needs an explicit
GPT_ARCHITECT decision, independently evidenced. `REQUIRE_HUMAN` needs fresh,
action-specific human authorization; GPT cannot downgrade it. `FORBIDDEN`
means not available in the ordinary G1 workflow. A human request to change
that policy first requires a new reviewed contract/packet; it is not an
implicit exception. Each action also needs the applicable network level.

## 2. Operation Authorization Matrix

| Operation | Class | Authorizer / conditions |
| --- | --- | --- |
| Read permitted repository files | ALLOW_AUTOMATIC | Packet scope; excludes CASE-001 and unrelated secrets. |
| Create `work/**` branch | ALLOW_AUTOMATIC | GPT-issued packet names branch and exact verified base SHA. |
| Edit only packet-allowed areas | ALLOW_AUTOMATIC | Immutable packet allowlist and invariants. |
| Run offline build/tests/checks | ALLOW_AUTOMATIC | Packet commands; no hidden live calls. |
| Commit on work branch | ALLOW_AUTOMATIC | Scoped diff, verified branch, no secret/forbidden artifact. |
| Push work branch | ALLOW_AUTOMATIC | Packet explicitly grants GitHub `WRITE_EXTERNAL` for that branch; no force. |
| Independent review from remote SHA | REQUIRE_GPT | GPT_ARCHITECT reviews exact remote SHA; implementer cannot self-review. Read-only GitHub access must be scoped. |
| Issue correction packet | REQUIRE_GPT | GPT_ARCHITECT binds rejected SHA and findings. |
| Fast-forward `main` | REQUIRE_HUMAN | Initial G1 policy; separately authorized promotion and all Section 7 checks. A later contract may permit narrowly routine automation. |
| Merge commit, squash accepted SHA, rebase accepted SHA, force push | FORBIDDEN | Ordinary G1 promotion preserves the accepted SHA; no implicit human bypass. |
| Delete branch | REQUIRE_HUMAN | Exact branch and purpose; never automatic cleanup. |
| Change branch protection or repository settings | REQUIRE_HUMAN | Exact setting and scope; stop before action. |
| Modify CI/workflow files | REQUIRE_HUMAN | Security-sensitive repository automation surface; exact reviewed diff. |
| Access a task-scoped secret | REQUIRE_HUMAN | Specific secret/capability and purpose; no prompt/log exposure. Unrelated secret inspection is forbidden. |
| Create, rotate, or modify secrets | REQUIRE_HUMAN | Exact secret and operation; production credentials additionally require HUMAN_STOP. |
| `READ_WEB` or `READ_EXTERNAL_API` request | REQUIRE_GPT | GPT-issued packet names destination, purpose, and budget; no generic read grant. |
| `WRITE_EXTERNAL` request | REQUIRE_GPT | GPT-issued packet names exact destination/action and budget; only permitted where no more restrictive row applies. |
| `SENSITIVE_WRITE` request | REQUIRE_HUMAN | Fresh exact-action human authorization; no generic network grant. |
| Live provider/model API call | REQUIRE_HUMAN | Default denied; explicit bounded purpose, model/call budget, and audit basis. Future policy may define a separate pre-authorization class. |
| Production database mutation or destructive migration | REQUIRE_HUMAN | HUMAN_STOP; exact environment, operation, rollback/safety evidence. |
| CASE-001 access, reveal, review, modify, push, or re-review | REQUIRE_HUMAN | Fresh explicit authorization for that *exact* action; otherwise forbidden. |
| HumanAdjudication/authority-model or other security-boundary change | REQUIRE_HUMAN | HUMAN_STOP plus a new reviewed architecture packet. |

An action absent from this matrix is denied until classified in a new reviewed
contract. A broad packet cannot convert a human-gated operation into an
automatic one. GitHub fetch/review is a scoped external read; GitHub push is a
scoped external write. Neither implies permission for arbitrary network calls.

## 3. Deterministic Lifecycle

States: `IDLE`, `ARCHITECTURE`, `PACKET_READY`, `IMPLEMENTING`,
`IMPLEMENTATION_COMPLETE`, `REMOTE_SHA_READY`, `ACCEPTANCE_REVIEW`,
`CORRECTION_REQUIRED`, `ACCEPTED`, `PROMOTION_READY`, `PROMOTING`,
`CANONICAL_CI`, `CLOSED`; stop states: `SOFT_STOP`, `ARCHITECTURE_STOP`,
`HUMAN_STOP`, `FAILED_CLOSED`.

Legal normal transitions:

```text
IDLE -> ARCHITECTURE -> PACKET_READY -> IMPLEMENTING
IMPLEMENTING -> IMPLEMENTATION_COMPLETE -> REMOTE_SHA_READY
REMOTE_SHA_READY -> ACCEPTANCE_REVIEW
ACCEPTANCE_REVIEW -> CORRECTION_REQUIRED -> IMPLEMENTING
ACCEPTANCE_REVIEW -> ACCEPTED -> PROMOTION_READY -> PROMOTING
PROMOTING -> CANONICAL_CI -> CLOSED
```

`IMPLEMENTATION_COMPLETE` requires bounded local validation; `REMOTE_SHA_READY`
requires the exact pushed SHA. `ACCEPTED` requires the independent review in
Section 6. `PROMOTION_READY` requires separate promotion authorization and
preflight. `CLOSED` requires post-promotion verification, unless a human
explicitly closes an accepted but intentionally unpromoted slice with a
recorded reason. No path skips remote review or turns implementer self-report
into `ACCEPTED`.

Any active nonterminal state may enter an applicable stop state. Resume from
`SOFT_STOP` returns only to the interrupted state after a bounded, evidenced
repair. `ARCHITECTURE_STOP` resumes through `ARCHITECTURE` and a new packet
version; `HUMAN_STOP` resumes only from the state/action the human explicitly
authorizes, with all stale preconditions rechecked. `FAILED_CLOSED` is a
terminal condition for an unreconcilable or unsafe run, not a fourth stop class;
new work requires a new run and authorization. No automatic retry of an
uncertain external side effect.

## 4. Exactly Three Operational Stop Classes

| Class | Trigger and disposition |
| --- | --- |
| SOFT_STOP | Build/test/lint/type failure, bounded implementation defect, or demonstrably replay-safe temporary CI failure. A scoped correction may resume inside remaining budgets. |
| ARCHITECTURE_STOP | Packet conflicts with repository reality, required scope/public contract expansion, unclear authority, ambiguous acceptance, invariant conflict, or moved `main`. GPT_ARCHITECT decides and issues a new packet/version; no silent adaptation. |
| HUMAN_STOP | Destructive migration, production write, credentials, branch protection/settings/workflow change, unauthorized live model call, force push/deletion request, CASE-001, security or human-authority change, or exhausted iteration/acceptance budget. Stop for fresh explicit human decision. |

Riskier action classes never become a `SOFT_STOP` merely because execution is
easy. `FAILED_CLOSED` describes an outcome/state, not an operational class.

## 5. Iteration and Resource Limits

Conservative defaults per slice: `max_implementation_iterations_per_slice=3`,
`max_acceptance_failures_per_slice=3`, `max_parallel_implementation_agents=1`,
`max_runtime_minutes_per_iteration=60`. Count an iteration when implementation
begins; count an acceptance failure on explicit REJECT. Exhaustion yields
`HUMAN_STOP`; neither agent can reset counters. Proposed warning thresholds are
10 changed files or 500 changed diff lines per iteration. Warnings trigger
explicit scope review, not automatic semantic rejection. Packets may lower
limits; raising them requires explicit GPT architecture review and human
authorization where it expands operational risk. No unbounded GPT/Codex loop.

## 6. Packet, Correction, and Acceptance

An implementation packet minimally binds `packetId`, stage/slice, expected base
SHA, target branch, objective, allowed files/areas, forbidden changes,
invariants, acceptance criteria, validation commands, network authorization
level/destinations, provider-call authorization and budget, destructive-operation
authorization, and iteration budget. Record an immutable packet hash. The
packet is frozen at `IMPLEMENTING`; Codex cannot edit its governing packet.
Architecture change requires a new version and another authorization decision.

A correction packet binds the rejected remote SHA, reviewer findings, allowed
correction scope, unchanged original invariants, expected new base, and maximum
correction iteration. It cannot silently become a new project. If the fix
requires expanded scope or changed invariants, enter `ARCHITECTURE_STOP`.

**IMPLEMENTATION COMPLETE != ACCEPTED.** Acceptance requires an exact remote
commit SHA, independent GPT_ARCHITECT review from remote repository state,
scope/diff review, invariant review, build/test and CI status, and explicit
`ACCEPT` or `REJECT` bound to that SHA. The reviewer independently checks
changed files and results; implementer summary, local unpushed files, and
claimed counts alone are insufficient. A later SHA invalidates the prior
acceptance for promotion. GitHub CI success alone is not semantic acceptance.

## 7. Git and Promotion

Canonical branch is `main`; implementation branches are `work/**`. No direct
implementation on `main`. Preserve the accepted SHA and its ancestry. Normal
promotion is fast-forward only; no merge commit, squash, rebase of accepted
SHA, force push, or automatic branch deletion.

Promotion is separate from acceptance. Initial G1 promotion is human-gated.
Future routine fast-forward automation may be separately authorized only after
a reviewed policy/runtime slice. Before *any* promotion verify: current remote
`main` equals packet's expected SHA; accepted SHA is descendant, ahead of main
and behind by zero; no main-only commits; exact accepted SHA CI including
required `test` is green; branch protection remains enabled; no HUMAN_STOP
category is involved. If `main` moved, enter `ARCHITECTURE_STOP` without
rebase/adaptation. A failed check stops promotion.

After push, verify remote `main` equals the accepted SHA, main-triggered CI and
required `test` succeed, and branch protection still holds. A missing or
ambiguous CI result is not success. At the C0 base, `.github/workflows/ci.yml`
runs build/test on `main` and `work/**`; observed main protection requires
`test`, enforces admins, and disallows force pushes/deletions. These are
observations, not permanent assumptions: future promotion rechecks live state.

## 8. Network and Secret Boundaries

Network levels are ordered `OFFLINE`, `READ_WEB`, `READ_EXTERNAL_API`,
`WRITE_EXTERNAL`, `SENSITIVE_WRITE`; default is `OFFLINE`. A packet requesting
a higher level specifies destination, operation, purpose, and budget. Access
is least-privilege per operation, not an unrestricted grant to all lower/higher
destinations. GitHub remote read and branch push are distinct permissions.
Generic web read does not authorize a model API call. Live model calls remain
default denied and need a separate explicit class, purpose, budget, and audit
record. Agent-orchestration inference and CHIEF runtime-provider experiments
are separately authorized and counted in any future system.

Agents receive no general-purpose secrets. A controller may know that a
capability exists without receiving or disclosing the credential. Credentials
must be task-scoped and least-privilege; never copy them into prompts, logs, or
artifacts, and never inspect unrelated environment secrets. Secret-bearing
operations need explicit authorization; production credentials require
`HUMAN_STOP` unless a later human-approved policy explicitly changes this.

CASE-001 is confidential. Do not access, reveal, review, modify, push, or
re-review it absent fresh explicit human authorization for the exact action.
Automation fails closed on uncertain paths or accidental inclusion.

## 9. CHIEF Domain Boundary

`HumanAdjudication` remains the sole human decision authority. Model consensus,
synthesis, replication, and independent review are not HumanAdjudication.
`RouteOutcome` records validated execution/product fact, not human authority.
Provider execution cannot self-certify correctness. Controller coordination
truth and GitHub CI are operational facts, not semantic authority. Operational
audit is separate from CHIEF's authority ledger. Preserve global integrity
before local filtering and all `claimRouteExecution`/checkpoint validation;
no downstream component may self-certify upstream correctness. See
`EXECUTION_RUNTIME_CONTRACT.md` Sections 7-10 and current
`src/stress-test/session.ts` / `src/stress-test/deliberation.ts`.

## 10. Future Audit and Recovery

A future append-only audit record for each transition/action should contain
`runId`, `sliceId`, `actor`, `role`, `action`, `timestamp`, `previousState`,
`nextState`, repository, branch, `baseSHA`, `resultingSHA`, authorization basis,
packet identifier/hash, acceptance SHA, CI run/status when relevant, stop
reason, and human-authorization reference when applicable. An absent field is
represented as unavailable, not fabricated. No storage is implemented here.
This operational audit never becomes the CHIEF authority ledger.

After a crash, do not infer success from an intended action or absence of an
acknowledgement. A future controller must reload persisted state and compare
remote GitHub canonical/work SHAs and CI before resuming. Reconcile only from
verifiable facts; mismatch or missing truth fails closed. `UNCERTAIN` execution
is not `FAILED`. Never replay an uncertain external side effect merely because
its acknowledgement was lost. Destructive/external-write replay needs proof of
idempotent safety or a fresh human decision.

## Delivery Boundary

G1-C0 adds documentation and a non-executing YAML example only. No controller,
SDK integration, webhook, scheduler, persistence, unattended network action,
automatic correction/promotion, credentials, provider calls, or E0-R3 work is
implemented. G1-R1 (Controller Runtime Foundation) is the *next planned* slice,
not an authorization to begin it. Build/offline tests show preservation, not
governance enforcement or independent acceptance.
