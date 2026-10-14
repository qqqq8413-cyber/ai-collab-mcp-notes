# EXE-C2 — Goal-scoped governed activation

**Status:** opt-in candidate. This is a narrowly scoped route into the existing G1-AP1 activation core, not a new source of authority.

## Host configuration

EXE-C2 builds on the existing trusted Host configuration:

- `governance.executionStatus` must already be enabled with the exact Authority Archive root and Architect principal.
- `governance.executionStep.governedLive` must pass the existing pinned-executable, Seatbelt, store-isolation, scope and budget preflight. No provider defaults are introduced.
- An optional `governance.executionStep.activationPlans` array supplies **complete, externally issued documents** for individual Workspace Goals. Each entry has exactly `projectId`, `goalId`, and `bundle` with `implementationPacket` (one complete `DIRECT_AUTHORITY` document) and `liveCallAuthorizations` (zero or more complete `DIRECT_AUTHORITY` AUTHORIZATION documents).

Example *shape* (placeholders are not valid authority documents):

```json
{
  "governance": {
    "executionStep": {
      "governedLive": "<complete existing governed live configuration>",
      "activationPlans": [
        {
          "projectId": "example-project",
          "goalId": "goal-<canonical UUID>",
          "bundle": {
            "implementationPacket": "<externally issued complete IMPLEMENTATION_PACKET authority document>",
            "liveCallAuthorizations": []
          }
        }
      ]
    }
  }
}
```

Use a locally protected Host configuration **outside public repositories and the served Workspace UI directory**. Do not copy live authorization documents into tracked examples. The Host refuses duplicate Goal plans, unknown projects, malformed authority documents, and documents of the wrong kind before composing any live capability or creating the Goal Store.

**Important provenance limitation:** the existing authority archive and local Host configuration check the *stated* issuer and exact document bindings, not a cryptographic signature or independently authenticated Human identity. A localhost Workspace session is **not Human authentication**. The packet and grant must genuinely originate from the responsible Architect and Human; neither the UI nor CHIEF creates or signs them.

## Workspace semantics

`GET /api/v0/projects/:projectId/goals/:goalId/activation` returns bounded operational readiness only. Without an admitted ROOT or an exact configured plan it cannot activate. `POST` accepts **no JSON body, query arguments, run ID, grant, principal, packet, actor, or budget**. It selects only the immutable Host-provisioned plan for the exact Goal, checks the durable Goal's recorded Human, checks the Change and ROOT binding, and invokes G1-AP1 once under the Goal lock.

G1-AP1 preserves each direct-authority document first and only then writes the activation-bound Controller transitions. An interrupted activation can continue only with the same exact packet intent. Existing READY / ARCHITECTURE_ENTERED / PACKET_READY / ADVANCED states remain distinct. Identical completed activation requests are reported as already activated, not re-issued.

Activation stops at `PACKET_READY`. It makes **zero provider/model calls**. Subsequent `/step` still runs the LD1 and Runner gates, including archived exact Human grants, configured live scopes, current policy, egress isolation, budgets and occurrence guards. There is no automatic scheduling, promotion, recovery, correction, authority authoring, or main-branch merge exposed by this slice.

## Verification

Run `npm run build`, `node test-workspace-activation.mjs` and `npm test`. The HTTP tests cover no-plan refusals, no ROOT, same-origin/session checks, forbidden request payloads, exact target derivation, idempotence, binding conflicts and failure propagation. The existing G1-AP1 tests cover real archive/Controller activation and recovery; the HTTP seam uses a controlled activation double so it cannot dispatch or bill a model during testing.
