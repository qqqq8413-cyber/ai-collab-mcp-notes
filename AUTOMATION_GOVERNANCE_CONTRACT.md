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
| Live provider/model API call | REQUIRE_HUMAN | Default denied; explicit bounded purpose, model/call budget, and audit basis. Binds the calling actor, provider, exact model, and that actor's exact broker-enforced egress destination set (Section 8.1). Future policy may define a separate pre-authorization class. |
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
terminal condition for an unreconcilable or unsafe run, not a fourth stop class.
A terminal run keeps its change closed: new work requires a new governed change
identity and authorization, never another run of the same change (Section 3.1).
No automatic retry of an uncertain external side effect.

### 3.1 Run Admission (G1-R4L-1)

CHIEF-GOV/1: one change, exactly one ROOT run, ever. A change is
`ChangeRefV1 { kind: 'SLICE', changeId: sliceId }` in one repository, keyed by
`sha256("chief.change.v1\0" + repository + "\0" + sliceId)` over the exact
identity: `sliceId` matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` and is
case-sensitive, the repository is `owner/name`, and a non-canonical spelling is
refused, never normalised. Every `ControllerStore.create` admits the first run
of a change as its ROOT and refuses any other runId for that change
(`SECOND_RUN_FOR_CHANGE`) before the run exists, whatever the ROOT's state,
`CLOSED` and `FAILED_CLOSED` included. Budget, authority, Human stop, lifecycle
and governance state therefore cannot be reset by opening another run. The
relation is one-to-one in both directions: a runId is the ROOT of at most one
change, so a runId already claimed by one change (even while its run is still
pending) is never admitted for another; admissions and runs that contradict
this fail closed. The admission record is an operational record, not
authority; continuation is reserved and not implemented.

Admission is a structural invariant, not authorization: it cannot tell whether
two different sliceIds are the same real work. Activation prerequisite: before
any run-creation surface (Workspace, API, agent or executor) goes live, new
change identities must come from a governed change-mint or adoption process,
and who may request a run is decided at the governed authorization boundary. No
caller may choose an arbitrary new sliceId to obtain a fresh change.

The file store requires a local filesystem with atomic, exclusive link(2)
publication and durable directory fsync. Network, sync and remote filesystems
are unsupported for `controllerStoreDirectory`; where link publication is
unavailable, admission fails closed.

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
`HUMAN_STOP`; neither agent can reset counters, and opening another run for the
same change is refused (Section 3.1). Proposed warning thresholds are
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

### 6.1 Authority Archive (G1-R4P-1)

Direct authority (implementation packets, correction packets, acceptance
decisions and authorizations) is preserved in an append-only
`AUTHORITY_ARCHIVE` as `AuthorityDocumentV1` records of class
`DIRECT_AUTHORITY`. The archive preserves authority; it does not create it,
authenticate a Human, or authorize execution. Each body is validated by the
repository's canonical parser for its kind and must already be in canonical
form. The document's own identifier (`packetId`, `correctionPacketId`,
`reviewId`, `authorizationId`) is its `authorityId`, exact and matching
`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`. `version` counts archive revisions of that
one document (1, 2, ... without gaps, each superseding the exact previous record
hash); it is not a packet's run-scoped `packetVersion`, which stays in the body.
An identical retry returns the same reference; a different record for an
archived version fails closed. `bodyHash` and `recordHash` detect corruption;
they are not signatures and not authentication. Operational records (journals,
APPLIED results, controller audit, R4L admission and refusal, CI results,
provider or executor output, replay traces, connector executions) never become
direct authority, and no API promotes them. The archive root is separately
configured and holds only `records/`. An existing root is inspected before the
archive creates anything: a root that is not an archive (another store, foreign
content, or a symlink) is refused without any change, and symlinked `records/`,
key directories or record files are never followed or read as authority. This
is storage separation, not R4T capability governance.

### 6.2 Governed Read Model (G1-R4A0)

A read-only projection (`GovernedReadModelV1`, ruleset CHIEF-GOV/1) of the
Controller store and the authority archive. It never constructs the Controller
store and never mutates either root (no directory, lock, temp, admission, run,
repair or backfill); a missing root reads as empty. It reads one consistent
snapshot: every relevant entry is fingerprinted (identity, size, times, byte
hash) before and after the projection, and any difference fails closed.

- Runs exist only as the Controller store holds them, after the store's own
  envelope, checksum, identity-binding and lifecycle-invariant checks; a run file
  that fails them fails the whole read closed.
- A change is R4L's exact identity (`repository` + case-sensitive `sliceId`,
  never normalised). A run without a canonical identity belongs to no change.
- R4L admission is reported as an operational fact, never as authority or as the
  source of what exists. `LEGACY_UNINDEXED_RUN`, `ADMISSION_REGISTRY_MISMATCH`
  and `ADMISSION_RECORD_INVALID` are reported, not repaired. More than one valid
  run of one exact change is `UNLINKED_SIBLING_RUN`; no lineage explains it.
- Direct authority comes only from the archive reader. A run's packet,
  correction, decision or grant is an operational copy, matched to the archived
  version whose body hash it records, never to another or the latest version,
  and checked against the run's repository and slice. Journals, run status, Git,
  CI and model output are not read.
- NextAction lists the lifecycle moves (Section 3) the recorded facts allow and
  the role that may take each; it is INDETERMINATE when the store holds any
  admission contradiction (such a store does not open, so no run in it can
  move) or when an authority body the run retains does not resolve exactly. A
  terminal run has none. `HUMAN_STOP` offers only the Human resume; change
  abandonment and continuation are capability gaps.
- CHIEF-GOV/1 has no continuation: run lineage is `UNAVAILABLE`, a change has no
  head.

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

### 8.1 Live Model Egress (G1-R3C)

A live provider/model call is authorized only as an operationally enforced
network fact, never as a declared string.

1. A live provider/model call remains `REQUIRE_HUMAN`, at network level
   `READ_EXTERNAL_API`.
2. The authorization is actor-scoped. It binds the calling actor
   (`IMPLEMENTATION` or `ARCHITECT_REVIEW`), the provider, the exact model,
   and that actor's exact egress destination set: canonical `hostname:port`
   authorities (lower-case ASCII DNS names of at least two labels, explicit
   port, no scheme, path, userinfo, wildcard, IP literal, or trailing dot),
   sorted and unique. The packet states each actor's scope once, as one entry
   of `providerCallAuthorization.calls` (at most one entry per actor kind, in
   actor-kind order); it holds no packet-wide provider, model, or egress list.
   The same actor, provider, model, and set must be stated, byte for byte, by
   that actor's Human grant, that actor's packet entry (each destination also
   listed in `networkAuthorization.destinations`), the call scope, and the
   broker allowlist. A missing or extra destination or a different port is a
   different authority and is denied. The operation's `target` is the fixed
   value `live-provider-model-call`; it is never a host.
3. One actor's entry, grant, or destinations confer no authority on the other
   actor. A call is checked only against the packet entry for its own actor
   kind: no fallback to another entry, no union of entries, no subset or
   superset, and no search for a provider or model across entries. A Human
   grant for one actor never authorizes the other, even where both entries
   name the same provider, model, and set. The call budget (`maxCalls`) stays
   packet-wide: every started call of either actor counts against it.
4. A destination declaration without technical enforcement grants nothing. A
   logical label (`anthropic`, `openai`, `claude-cli`, `codex-cli`,
   `provider-api`) or a base URL is not an egress destination.
5. A model CLI runs only through an approved egress-bound model process
   boundary: a pinned executable (content hash checked at composition and
   immediately before dispatch) under a deny-by-default sandbox whose only
   network permission is one invocation-scoped loopback broker. The boundary
   runs a model process only for a scope bound to the requesting actor. There
   is no unsandboxed or weaker fallback; where the boundary is unavailable,
   the call is not made.
6. The broker allowlist must exactly equal that actor's Human, packet, and
   call set. A result is usable only with durable broker evidence for that
   invocation: a closed session, the exact allowlist, at least one recorded
   connection when the process reports success, and no refused attempt.
   Missing, corrupt, or ambiguous evidence fails closed.
7. The broker accepts HTTP CONNECT to an exact allowlisted authority only. It
   parses only the bounded CONNECT request head needed to validate the proxy
   protocol. It does not persist or log header values, does not use them as
   authority, does not forward them as CHIEF metadata, and never sees provider
   HTTPS headers after the tunnel is established. The head it holds never
   exceeds a fixed byte bound, however the head arrives; an oversized head is
   refused. Bytes after the head are tunnel payload, passed on unchanged. It
   does not terminate or inspect TLS, generate certificates, read request
   bodies, or hold credentials. It resolves the name itself, refuses
   non-public addresses, and connects to the address it validated.
8. A plaintext CONNECT head carrying a credential-shaped header
   (`Authorization`, `Proxy-Authorization`, `Cookie`, `X-Api-Key`, or
   `Api-Key`, in any letter case) is refused whole, before any destination
   decision, with the fixed reason `CREDENTIAL_HEADER`. The header's name and
   value are recorded nowhere: not in the egress journal, a refusal, an
   error, a stop reason, or an audit record.
9. An unauthorized egress attempt is recorded before it is refused and stops
   the run for a human. It is never silently repaired, retried, widened, or
   answered by adding a host inferred from output.
10. Adding an egress destination (including an authentication or telemetry
    host) requires a new applicable Human authorization and packet entry for
    the actor that needs it.
11. Model and API credentials remain outside prompts, logs, journals, and the
    broker. CHIEF never reads or inserts them.
12. There is no broad proxy or network grant: the broker binds 127.0.0.1 only,
    serves one invocation, and callers cannot supply or override proxy,
    provider-routing, or TLS-trust settings of a model process.

The egress journal is operational evidence of broker activity. It is not an
authorization, HumanAdjudication, acceptance, RouteOutcome, repository truth,
or provider truth, and it drives no lifecycle. The invocation journal schema
moved to version 2 with this change; version 1 records bound one destination
string that nothing enforced and are refused as unsupported, never migrated.
Actor scoping (G1-R3C-C1) keeps version 2: the stored shape is unchanged, and
the actor kind is stored once, in the invocation identity, which the call
scope must equal.

### 8.2 Governance Store Isolation (G1-R4T-1)

1. The Controller store (runs and R4L admission state), Authority Archive
   (DIRECT_AUTHORITY), and CM1 Change Registry (operational mint records) are
   the protected governance roots.
2. No agent, model process, model workspace, offline validation process or
   model-generated code may read or write any root's raw files. A checksum
   is no substitute: whoever can rewrite a record can rewrite its checksum.
3. The three roots must be mutually disjoint and disjoint from every
   agent-visible filesystem tree: repository, worktree root, linked dependency
   sources, model and validation runtime paths and search paths, model
   executables, the operational journals, and the fixed Seatbelt trees. Overlap
   means equal, inside, containing, or the same tree through any alias; it is
   decided by filesystem identity and component-wise canonical paths, never by
   string prefixes. Unresolvable identity fails closed.
4. LIVE composition requires all three roots to exist already as real directories
   (not symlinks) owned by the host account and not writable by group or
   others. It refuses, before constructing anything, on any unsafe identity,
   alias, ownership or permission, and repairs nothing
   (`GOVERNANCE_STORE_ISOLATION`, not a stop class).
5. The model process and offline validation boundaries hold the roots and
   re-check each invocation's effective paths (workspace, cwd, readable and
   writable paths, runtime and search paths, executable, temporary directory)
   before any session, broker, profile probe or command exists; an overlap
   answers `UNAVAILABLE` and nothing runs.
6. The authority appender has zero production runtime holders. Since G1-R4A0
   the governed read model (Section 6.2) is the only holder of the archive
   reader; it holds no appender and is wired into no runtime surface.
7. Workspace receives no raw governance writer and no controller, runner, store
   or model capability. GC1 permits the server to receive only a narrow injected
   GoalGovernancePort from a trusted host outside `src/workspace`.
8. R4T is capability and storage isolation inside one trusted host account,
   not Human authentication, and it does not protect against the kernel, root,
   the host account, or code already inside the trusted host process.
9. R4T does not make hashes authentic.
10. D1 binds a configured Human principal to a local Workspace session and
    attributes new Goals; it is not Human authentication or authorization.
    R4A0 is the read-only projection of Section 6.2.
11. CM1's Change Registry has separate reader and minter capabilities. GC1's
    trusted GoalChangeBridge is the single production mint path. The model/runner
    LIVE composition still protects its root without opening either capability.
    GC1 re-reads a durable Goal under the Goal Store's project lock, binds its
    exact text, timestamp and recorded Human to an explicitly configured governed
    repository, and mints only for the same server-derived local-session Human.
    Registry/Goal Store/UI paths are alias-aware disjoint before listening.
    The normal trusted-host DELETE checks the registry under the same project
    lock and refuses an already governed Goal; a leftover lock is never repaired.
12. GC1's governance HTTP projection is operational (`CHANGE_REGISTRY`), with
    execution `NOT_STARTED` and no Run created by the operation. It grants no
    authority and appends no authority document. R4A0 remains unchanged: it
    projects Controller/Authority evidence and therefore has no mint-only Change
    entry before a Run exists.

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
