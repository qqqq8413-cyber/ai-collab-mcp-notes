# CHIEF EXE-C4 — Offline Signed Human Approval Gate (Candidate)

**Branch:** `work/exe-c4-signed-human-approval` (not merged to main).

## What this slice solves

An ordinary Workspace browser cookie and its confirm sheet do not authenticate a Human. EXE-C4 adds an **out-of-band Ed25519 signature** over a narrowly scoped Human approval attestation. In a **live Trusted Host**, the server checks the attestation against a public key independently pinned in the protected Host configuration before activation and before any Runner step. The browser, Claude/Codex agent, Controller and the Host have **no Human private signing key** and cannot mint a signature.

The attestation **does not replace** an Architect implementation packet or any Human AUTHORIZATION document. Those remain distinct DIRECT_AUTHORITY records, validated and preserved by the existing AP1 / LD1 / archive flow. A signature is an authenticated *approval to use an already issued, exactly pinned bundle for one ROOT Run*, not a direct authority document on its own.

## Trust boundary

- The Human verifies a packet/grants bundle and the specific Goal, Change and ROOT Run **outside the Host**, using a protected signing device/process. Ed25519 private key custody and key-to-person enrollment remain external.
- A protected Host config includes only the trusted **Ed25519 SPKI PEM public key**, plus the pre-provisioned bundle and externally issued signed approval. Neither the HTTP API nor the Workspace UI accepts keys, documents, grants, run identities, signatures, policies or budgets.
- The Host validates the signature against the pinned public key and a SHA-256 digest of the **canonical complete bundle**, then validates the exact project/goal and repository. The configured approval principal must match the Workspace's configured Human principal.
- **At runtime** both activation and every runner step check: projectId, goalId, repository, changeKey, runId, humanPrincipalRef, bundle digest and the validity window. Missing/mismatched/expired approval fails closed before the activation core or executor is called.
- Approval validity has an exclusive expiry and maximum seven-day span. It can be made ineffective immediately by disabling Live or removing it from the protected Host configuration and restarting the Host. More sophisticated immediate revocation and key rotation are not in this slice.
- The underlying Controller occurrence guard, existing model budgets, per-call Human AUTHORIZATION records, provider scope and LD1 replay/uncertainty handling **remain mandatory**. The signed attestation alone cannot dispatch paid work.
- The full attestation is **operational authentication evidence**, not `DIRECT_AUTHORITY` or `AUTHORITY_ARCHIVE` material. No signature is issued by CHIEF.

## Configuration shape

Under `governance.executionStep` in Trusted Host JSON, use:

```json
{
  "humanApprovalPublicKeyPem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n",
  "governedLive": { "...": "existing exactly pinned, fully validated live configuration" },
  "activationPlans": [
    {
      "projectId": "chief",
      "goalId": "goal-00000000-0000-0000-0000-000000000001",
      "bundle": {
        "implementationPacket": { "...": "externally issued complete IMPLEMENTATION_PACKET document" },
        "liveCallAuthorizations": []
      },
      "humanApproval": {
        "payload": {
          "schemaVersion": 1,
          "purpose": "CHIEF_EXE_C4_HUMAN_APPROVAL",
          "projectId": "chief",
          "goalId": "goal-00000000-0000-0000-0000-000000000001",
          "repository": "owner/repository",
          "changeKey": "exact governed Change key",
          "runId": "exact admitted ROOT Run ID",
          "humanPrincipalRef": "configured exact Human principal",
          "issuedAt": "2026-10-14T00:00:00.000Z",
          "expiresAt": "2026-10-15T00:00:00.000Z",
          "bundleSha256": "lowercase sha256 digest of canonical complete bundle"
        },
        "signatureBase64": "canonical base64 of a 64-byte Ed25519 signature"
      }
    }
  ]
}
```

The above is **an illustrative shape, not valid execution authority**. Real `bundle` documents must be parseable by the exact authority validators. With no trusted public key a Live Host refuses to start, even if there are zero activation plans; with zero plans both activate and runner steps remain blocked.

## External signature protocol

The exact input bytes to Ed25519 signing/verification are:

```text
UTF8("CHIEF-EXE-C4-HUMAN-APPROVAL-V1\\n" + canonicalJson(payload))
```

`canonicalJson` is CHIEF's strict recursive serializer: object keys sorted in JS code-unit order, array order retained, no unsupported values. Use exported `authorityBundleSha256(bundle)` to calculate the payload digest and `approvalSigningBytes(payload)` to create the exact bytes **on an offline signing environment**. Sign those bytes with the Human-controlled private key (Ed25519, raw message, not a prehashed digest). Include the resulting canonical Base64 signature with the unchanged payload. Do not put private keys, a private-key path, or unreviewed credentials in this repository or a Host config.

Key possession proves only control of the pinned private key. Binding that key to a real Human, proving they understood the packet, and establishing the governance approval policy are external enrollment/procedure requirements. Use a hardware-backed or otherwise secured signer where possible.

## Lifecycle

1. Operator creates an exact Goal → governed Change → admitted ROOT. Read identities from the trusted projection; none are sent by the browser to the signature verifier.
2. Architect issues the full packet; Human issues the full underlying AUTHORIZATION documents independently. Securely review bundle and budget before signing.
3. Human signer receives the exact payload + bundle digest, signs offline and transfers **only the public key and signed attestation** to protected Host provisioning.
4. Host restarts with explicitly enabled Live configuration, validates all direct documents and the cryptographic proof **before constructing live capabilities**.
5. UI can request `activate` and `step` for the selected Goal. Host re-verifies the scoped, time-bounded approval on each operation, then AP1/LD1 enforce all existing run and call gates. A UI confirm is still an operational acknowledgement, not authentication.

## Invariants and exclusions

- Ordinary/observation-only Hosts must never import Runner, provider, journal, authority approval verifier or any new live module. EXE-C4 imports are lazy behind Live.
- Direct unit tests with a stub runner may inject a synthetic `approvalGate`; production Host composition **always** derives the gate from verified pre-provisioned plans.
- No new HTTP route, signer API, shared signing service, private key generation, autonomous actor loop, provider spending or Main merge.
- No automatic Architect packet issuance; no direct Human AUTHORIZATION issuance; no UI-backed identity enrollment or key rotation; no guaranteed real-person authentication beyond possession of the externally enrolled key.
- Replay **within the exact signed ROOT Run and expiry** is bounded by the existing per-call Human grants and Controller budgets. Revocation within a live process is currently expiry-based (or stop/reconfigure Host); an online revocation journal is a separate future decision.

## Verification

- `node test-exe-c4-human-approval.mjs` checks signature forgery/wrong key/algorithm, full-bundle mutation, stale run/change/project/goal/principal, future/expired/overlong validity, activation refusal and runner refusal **without paid calls**.
- `node test-workspace-activation.mjs` tests complete Host provisioned-plan parsing with a synthetically signed approval.
- `node test-goal-run-admission.mjs` checks that an ordinary Host remains isolated from the journal and live modules.
- `npm test` for the entire regression suite.

**Acceptance boundary:** This is a candidate implementation of a safe offline Human signature gate, not production-ready Human enrollment, a browser signing ceremony, or autonomous Agent operation.
