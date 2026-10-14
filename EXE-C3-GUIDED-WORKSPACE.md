# CHIEF EXE-C3 — Guided Goal-scoped Workspace Operations

**Implementation candidate, not yet merged into canonical main.**

## Purpose
EXE-C3 makes the existing EXE-C1/EXE-C2 governed operations usable from the Workspace without accidentally acting on the first unrelated queued Goal.

## Human-facing flow
1. Open a Project's **此刻** view. Its work ledger displays **操作** for every queued Goal. Select the exact Goal you intend to operate on. Selection is UI-only, per-project and in-memory; it never reorders the durable queue or grants authority.
2. The execution/status/activation sections show **only the selected Goal**. They load status from the trusted Host. When an operation is unavailable, its button remains disabled; the UI cannot override a server refusal.
3. A click on **建立正式治理變更**, **建立 ROOT Run**, **依正式文件啟動** or **執行下一步（一次）** opens an explicit review sheet. The sheet names the project, exact Goal and (if admitted) ROOT Run.
4. Confirming re-fetches the current execution status and the relevant activation or runner readiness. A changed state, ROOT identity or readiness cancels the request. This check is for operator clarity; only the **server's authoritative, occurrence-guarded checks** enforce authorization.
5. One click submits **one** existing Goal-scoped operation. The page refreshes the trusted execution projection and retains the action outcome only as an operational result.

## Authorization & safety
- An ordinary local Workspace session **does not authenticate a Human** and the confirmation sheet **does not create direct authority**.
- Architect packets and live provider grants must be valid, separately issued and configured in the existing Trusted Host. This slice does not construct, sign, store, modify, infer, approve, or upload them.
- The one-step action **may cause a real paid model invocation** only after the already existing protected Runner accepts exact authorization, configured provider scope, current occurrence and budget. Confirming the UI sheet is never sufficient by itself.
- No new execution HTTP endpoints, Controller grants, self-running loop, scheduler or main-branch promotion were added.
- Selection and review intent are not stored in localStorage/sessionStorage or supplied as identity claims to APIs.
- Outstanding confirmations close when their Goal is removed or the user changes the selection; the server independently refuses stale or mismatched Goal, Run and authority facts.

## Verification
- `node test-workspace-guided-execution.mjs` covers second-goal selection, single request, fresh status reinspection, ROOT mismatch, revoked readiness, changed selection, unready actions, separate governance/admission, exact host-approved activation, and absence of direct dispatch from the click handler.
- A real Chrome browser test has created two Goals in an isolated local Workspace and verified selecting the second changes the focal title while keeping the first goal in its durable queue position.
- `npm test` and GitHub Linux/macOS CI are required before acceptance.

**Outstanding:** verified Human identity and a trusted direct-authority issuance workflow are **not** in EXE-C3. CHIEF still cannot autonomously create Architect packets or Human grants from plain queue text, and no live Claude/Codex model call is initiated during this slice.
