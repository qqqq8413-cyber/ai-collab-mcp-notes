# GC1 / RA1 Trusted Workspace Host

GC1 provides a host composition outside `src/workspace`. Only its bridge opens
the CM1 ChangeMinter. The Workspace server receives the Goal Store, a narrow
`lookup` / `govern` port and (since RA1) a narrow run-admission `lookup` / `admit`
port. It cannot access the registry or Controller store filesystem, hold the
Controller, or start any execution.

Use `workspace-host.example.json` as the trusted configuration shape. Workspace
`project.repository` is still display-only; `governance.repositories` is the
explicit exact R4L repository binding. This configuration is never sent to the
browser. Every configured project needs one governed repository binding.

The operator must provision `governance.changeRegistryDirectory` and
`governance.controllerStoreDirectory` first, each as a real directory owned by the
host account, not writable by group or others, and disjoint from each other. The
host rejects unsafe/missing roots, root overlap, and Goal Store or static UI
overlaps with either root before listening, and creates nothing on refusal.
It also checks the resolved static asset paths, so a symlinked asset cannot expose
registry data. It neither repairs storage nor creates a Change on startup.

Build and run the GC1 host with:

```sh
npm run build
npm run workspace:host -- --config /absolute/path/to/host.json
```

The queue-only `chief-workspace` entry remains available for reading, adding and
reordering WS-L1 Goals. DELETE now fails closed without a trusted governance port:
a queue-only listener cannot bypass the registry-aware source-retention check.
Use the GC1 host for deletion and governance. Direct host-account filesystem access
remains outside the R4T threat boundary; checksums are not authentication.

The host exposes two operational routes, using the existing D1 local session and
Workspace Host/origin/header restrictions:

- `POST /api/v0/projects/:projectId/goals/:goalId/govern`: no body, Content-Type,
  or transfer body. The bridge re-reads the durable Goal under the same on-disk
  project lock used by queue mutations. It requires a recorded Human equal to
  the server-derived session Human. CM1 publication remains exclusive/write-once.
- `GET /api/v0/projects/:projectId/goals/:goalId/governance`: `NOT_GOVERNED` or a
  narrow `CHANGE_REGISTRY` projection of the same exact binding.

Successful governance returns operational identifiers, `OPERATIONAL_RECORD`,
`LOCAL_OPERATOR_INPUT`, a non-authoritative source notice, `NOT_STARTED`, and
`runCreated: false`. It is not execution authorization. Identical retries and
restarts return the same Change; changed binding facts fail closed.

Normal trusted-host DELETE checks governance while holding the project lock.
If removal wins, governance sees an unknown Goal and mints nothing. If governance
wins, DELETE cannot remove the source. Govern/govern contention waits briefly for
the storage lock; an abandoned lock produces a bounded refusal, never a repair.

`runCreated: false` describes the governance operation: governing never creates a
Run. Whether the Change has its Run is read from the RA1 route below. The field is
kept for compatibility and is never read as current Run state: `/governance` does
not query the Controller store, and the G1-LD1 execution driver derives everything
from the Change Registry and R4A0, not from this projection.

## RA1 run admission

RA1 adds exactly one mutation and one read, with the same D1 session and
Host/origin/Fetch-Site/header restrictions:

- `POST /api/v0/projects/:projectId/goals/:goalId/run`: no body, Content-Type,
  transfer body or query. Under the same Goal Store project lock as GC1 it
  re-reads the durable Goal, requires the recorded Human to equal the session
  Human, requires the Goal's existing GC1 Change (it never mints:
  `GOAL_NOT_GOVERNED`), checks the exact CM1 binding, and admits the run
  `"run-" + changeKey` through R4L. The response is operational: `CONTROLLER_STORE`,
  admission `ROOT`, `OPERATIONAL_RECORD`, `controllerState: IDLE`, execution
  `NOT_STARTED`, and `modelStarted`, `packetIssued`, `authorityGranted` all false.
- `GET /api/v0/projects/:projectId/goals/:goalId/run`: `GOAL_NOT_GOVERNED`,
  `NOT_ADMITTED` (`rootClaim` `NONE`, or `ROOT_PENDING` for a claim left by an
  interrupted admission that the next POST completes), or `ADMITTED` only when the
  exact run and its R4L claim agree.

Identical, concurrent and post-restart admissions return the same run. A ROOT
under another runId (`RUN_IDENTITY_CONFLICT`), a leftover run lock
(`RUN_ADMISSION_UNCERTAIN`), store corruption (`RUN_ADMISSION_INTEGRITY`) and a
run that has moved beyond admission (`RUN_BEYOND_ADMISSION`) all fail closed; none
is repaired, adopted or rewritten, and no storage path is returned. A governed
Goal stays undeletable. Demo mode and the UI do not call these routes.

R4A0 still reads only Controller and Authority evidence. A GC1 endpoint may show a
mint while R4A0 shows no Run or Change; after RA1 admission, R4A0 read explicitly
against the same Controller store shows that one IDLE ROOT run. GC1 does not create
admission records, Controller Runs, authority documents, or model/provider calls;
RA1 creates only the admission record and the IDLE run. DEMO uses its
existing in-memory behavior and has no governance API integration in this slice.

## LD1 (not wired)

G1-LD1 adds the governed one-step execution driver core. No Workspace route, UI
control, SSE event, port or automatic call reaches it: RA1 still ends at the IDLE
ROOT run, and `GoalRunAdmissionPort` is unchanged.

## WE1-R0 read-only execution status (optional, off by default)

G1-WE1-R0 adds one read-only route, with the same D1 session and Host/Fetch-Site/header restrictions:

- `GET /api/v0/projects/:projectId/goals/:goalId/execution`: no body, Content-Type, transfer body or query. There is no
  POST or any other execution route.

It is composed only when the trusted host configuration sets
`governance.executionStatus: { authorityArchiveDirectory, architectPrincipalRef }`. Without it the route answers
503 `EXECUTION_STATUS_UNAVAILABLE`, the host loads no status, read-model, runner or authority module, and everything
else works as before. When set, the host requires the Change Registry, Controller store and Authority Archive roots
to be pre-provisioned (real directories, owned by the host account, not group/other writable), mutually disjoint and
disjoint from the Goal Store, the UI directory and every served asset, and `architectPrincipalRef` to be an exact R4P
principal reference; any failure refuses before listen and creates nothing. No live model composition, provider
credential, runner or journal is involved.

The trusted bridge (`src/intake/goal-execution-status-bridge.ts`) derives everything from durable evidence: the
durable Goal and its recorded Human (equal to the session Human), the Goal's exact GC1 Change (registry reader, never
a mint), the Change's one ROOT runId (`"run-" + changeKey`), R4L admission and the R4A0 governed read. Lifecycle
readiness and RP1 provenance come from `src/automation/execution-readiness.ts`, the same assessment LD1 uses. The
Workspace receives only `GoalExecutionStatusPort.inspect`.

Statuses (operational projections, never execution authority): `GOAL_NOT_GOVERNED`, `RUN_NOT_ADMITTED`,
`ROOT_PENDING` (an interrupted admission's R4L claim; never completed by the read), `RUN_IDLE`, `WAITING_PACKET`,
`BLOCKED_AUTHORITY`, `BLOCKED_PROVENANCE` (RP1-C1 reason codes), `WAITING_EXTERNAL_ACTOR`, `WAITING_HUMAN`,
`IN_PROGRESS` (the runner protocol owns the next move; nothing is running because of this), `TERMINAL` and
`GOVERNANCE_CONFLICT` (binding, registry, read-model or ROOT-identity contradictions; never repaired). Eligibility for
a model call is always `EXECUTION_ELIGIBILITY_NOT_EVALUATED`: the live-call grants are not held here. The answer
lists required direct authority that resolves (identifiers and version only) separately from operational provenance
(whether the run carries the AP1 binding); it never contains a document body, hash, path, journal payload or secret.

The UI shows a compact 執行狀態 section for the goal on 此刻, read when the goal first appears there and on 重新讀取
only (never polled), with no execution, recovery or authorization control. Demo mode answers locally and never
requests it. RP1-C1 dead ends (a re-issued packet, a correction after an unsupported stop/resume, a review under
another Architect principal) are explained, not repaired; recovery needs a separate Architect decision.
