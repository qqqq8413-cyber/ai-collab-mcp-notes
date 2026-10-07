# GC1 Trusted Workspace Host

GC1 provides a host composition outside `src/workspace`. Only its bridge opens
the CM1 ChangeMinter. The Workspace server receives the Goal Store and a narrow
`lookup` / `govern` port. It cannot access the registry filesystem or start a Run.

Use `workspace-host.example.json` as the trusted configuration shape. Workspace
`project.repository` is still display-only; `governance.repositories` is the
explicit exact R4L repository binding. This configuration is never sent to the
browser. Every configured project needs one governed repository binding.

The operator must provision `governance.changeRegistryDirectory` first as a real
directory owned by the host account, not writable by group or others. The host
rejects unsafe/missing roots and Goal Store or static UI overlaps before listening.
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

R4A0 still reads only Controller and Authority evidence. A GC1 endpoint may show a
mint while R4A0 shows no Run or Change. GC1 does not create admission records,
Controller Runs, authority documents, or model/provider calls. DEMO uses its
existing in-memory behavior and has no governance API integration in this slice.
