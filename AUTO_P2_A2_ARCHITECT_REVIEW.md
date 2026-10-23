# AUTO-P2-A2 Architect Review

Base: `6fd9264bd1fef43977c3857e5ed0b57b722a6c90`.
Branch: `work/auto-p2-a2-input-policy-activation`.
Status: development candidate, production EXE/H1-H9 HOLD. No paid model calls, formal Human authority issuance, main promotion, credential changes or ruleset changes.

## Implemented

- New plans record A2-D1 strict 4,096 selection separately from missing proof. A1 and pre-A1 ledger schemas stay readable without rewriting their checksums; no old grant is upgraded.
- Exact request/system hashes and component byte measurements. Unknown token facts remain null. Reject unpaired surrogates rather than silently repairing strings. No README truncation.
- `limitedActivationCandidate` is a trusted-host integration candidate injected with the existing AP1 core and protected read model. It has no archive writer factory, model transport, credential access, Runner, Driver or Workspace route. It derives target/packet from the persisted job, verifies current clean SHA/code/storage/source/Goal/price and A2 policy, requires all three exact current authority documents to be already preserved, then calls AP1 to reach Controller PACKET_READY only.
- Existing AP1 remains the only authority-preserving activation core. Extra LIMITED_README_WORKER grant must come from the trusted governance process and already exist in the archive. Missing, expired, future, wrong-run, wrong-model, replaced/superseded and operational substitutes are refused.
- No production wiring of this candidate was added. Workspace remains operational-only, shows caps and actionable proof/permission gaps, with technical IDs collapsed. START remains disabled and the server rejects it.

## Tested Versus Not Tested

Evidence under `regressions/auto-p2-a2/`: complete local test summary/log, offline activation trace, real loopback browser checks/screenshots and unchanged-service snapshot. Counts are in the machine-readable summary, not inferred from old reports. The existing test file retains its 32 checks and adds A2 checks using the same isolated fixture.

Activation E2E uses true Goal/GC1/RA1, existing authority preserver in a temporary archive, existing AP1 and actual Controller/Driver. All documents are OFFLINE_SYNTHETIC; it proves transition binding and downstream input-policy refusal, not authenticated Human issuance or model execution. The inherited legacy synthetic calibration separately checks Driver/Worker/Journal/report consistency; it does not prove A2 eligibility. Full safety regression retains budget, timeout/cancel, uncertain recovery, replay, source/tool/model constraints and Seatbelt checks.

UI acceptance uses a new 4877 service and real browser at 1440/768/390/320px, actual local Goal creation and plan persistence, direct START=403 and forged plan=400. Model results and savings are not fabricated. Old 4873-4875 were already unavailable at preflight; live HTTP regression for those services cannot be claimed. 4876 was reachable and was not replaced or edited.

Exact candidate CI, remote equality, final clean status and final-preview packet are recorded after commit in the local A2 closure outputs. These must be checked independently before acceptance; this document does not certify a future CI result.

## Architect Decision Required

The 4,096 proof gap remains the primary technical blocker; see `AUTO_P2_A2_INPUT_PROOF.md`. Review whether the narrow trusted staging integration is acceptable for a later trusted composition. No route may be added that lets Workspace mint grants or treats operational records as authority. Production activation and EXE/H1-H9 changes require a separate reviewed slice and explicit Human authorization, not this candidate.

**Answer:** CHIEF does not yet meet all conditions for a first paid README review. Missing: provable strict input enforcement; reviewed production activation composition with trusted issuance; separately granted exact-run permits/HOLD decision; trusted-host credential/account/API checks and fresh price; then a bounded real-model acceptance. UNISSUED packets and synthetic green tests satisfy none of those authorizations.

STOP FOR ARCHITECT REVIEW.
