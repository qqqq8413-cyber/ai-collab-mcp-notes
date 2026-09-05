# Step 7.1 Live E2E Acceptance

Run on 2026-09-05 (Asia/Taipei), against production MCP stdio runtime at baseline
`ad384ec14e19f744951e17f85bb40ac32718239d`. Runtime code was not modified.

| Evidence directory | Final evaluation | Planning / workers / synthesis / total (ms) |
| --- | --- | --- |
| `SIMPLE-direct/` | PASS | 7318 / 5216 / 0 / 12534 |
| `DEEP-grounded-attempt-1-normal/` | TEST_NOT_EXERCISED | 27570 / 139961 / 77889 / 245420 |
| `DEEP-grounded/` | PASS | 18854 / 122082 / 110377 / 251313 |

## Reading the Evidence

- `task.json`: exact input and purpose for that attempt. `cases.json` contains the final fixtures.
- `manifest.json`: start time, baseline commit, Node version, resolved roster/capabilities, runtime hashes.
- `raw-mcp-response.json`: complete returned MCP payload, including original task and timestamps.
- `normalized-result.json`: parsed response, initial automated checks and observations.
- `evaluation.json` / `evaluation.md`: reviewed outcome, corrections and limitations.
- `integrity.json`: post-run runtime hashes and before/after comparison.
- `hashes.json`: SHA-256 seal of all other files in this directory tree.

The SIMPLE initial FAIL is a preserved harness false negative: Markdown emphasis
and punctuation were not removed by the first arithmetic/order checker. Only the
checker was corrected; the same raw response passed re-evaluation without another
live call. This normalization is test-only, not a runtime quality gate.

The first DEEP fixture produced a valid NORMAL plan. It exercised search and
synthesis, but not the DEEP evidence-label branch. Its raw FAIL remains intact;
review classifies it as TEST_NOT_EXERCISED. One fixture-only correction made the
investment stakes explicit. No agent/provider was forced, and the corrected run
returned DEEP, three successful workers, six search queries and 21 sources.

Chief missions are `result.plan.assignments[].mission`; worker raw text is
`result.workerResults[].output`. SIMPLE `finalOutput` equals the worker text exactly.
For DEEP, the synthesis text is `result.finalOutput.slice(observation.expectedBanner.length)`
after checking that `finalOutput` starts with that exact banner. No text was edited.
These are adapter-returned texts, not provider HTTP envelopes; Chief raw planning
text is not exposed by this MCP API.

## Measurement Boundaries

Logical model calls (A: 2, B: 5) are derived from assignments and executed policy,
cross-checked against unchanged production code and offline dispatcher tests.
They are not independently captured live HTTP counts and do not include SDK retries.

Retrieval-request evidence combines resolved `evidenceCapable`, the unchanged
capability-based orchestrator dispatch branch, the adapter's retrieval-only metadata
path, and actual returned GROUNDED metadata. CallOptions were not separately traced.
Provider identity alone is not used as proof of retrieval.

Timings are orchestrator phase wall times, excluding MCP startup/transport.
Workers time is the parallel span. This is not a latency distribution or token/cost
measurement. PARTIALLY_GROUNDED does not validate every synthesized claim or price.

## Offline Verification

From the repository root, with the same built runtime available:

```sh
node regressions/step7-1-e2e/verify.mjs '/path/to/AI Agent'
```

This verifies saved payload consistency, evaluations, current runtime fingerprints
and the evidence seal without model calls. A different runtime build intentionally
fails the fingerprint check. Original live execution used `run-case.mjs` with the
runtime path and case ID; existing case directories are protected against overwrite.
Do not rerun live tests merely to regenerate this evidence.
