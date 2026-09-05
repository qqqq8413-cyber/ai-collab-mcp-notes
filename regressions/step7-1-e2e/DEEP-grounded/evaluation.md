# Test B Evaluation

**Final outcome:** PASS

The corrected high-stakes fixture exercised the intended production branch without naming or forcing an agent, provider, or model:

```text
DEEP planning
→ evidence capability selected naturally
→ Gemini grounded retrieval
→ Worker metadata and sources preserved
→ collaborative synthesis
→ PARTIALLY_GROUNDED report
→ conservative user-facing banner
```

## Recorded facts

| Field | Observation |
|---|---|
| Complexity | `deep` |
| Assignments | 3 (`market_researcher`, `business_strategist`, `brand_creative`) |
| Logical model calls | 5 |
| Run status | `SUCCESS` |
| Grounded specialist | `market_researcher` |
| Retrieval | `GROUNDED`; 6 reported queries; 21 sources |
| Raw metadata | `webSearchQueries`, `groundingChunks`, `groundingSupports`, `searchEntryPoint` |
| Policy | `collaborative`; `synthesize=true`; `non_simple_execution` |
| Evidence label | `PARTIALLY_GROUNDED` |
| Timing | planning 18.854s; workers 122.082s; synthesis 110.377s; total 251.313s |

The report-level query and source counts match the grounded Worker, every Worker source remains present in the report, and final output begins with the exact banner generated from the report:

```text
PARTIALLY GROUNDED — claims not yet validated
```

The result never uses `EVIDENCE_BACKED`. Its report note and banner both state that retrieval covers the research specialist's work only and that claim-level support in the final synthesis has not been validated. This test therefore accepts the transport and evidence-semantics chain, not the factual correctness of every synthesized claim.

Attempt 1 remains saved separately as `DEEP-grounded-attempt-1-normal/`. It verified grounding and synthesis subchains but was `TEST_NOT_EXERCISED` for the DEEP evidence-label branch because the original fixture did not define stakes high enough for the unchanged Chief contract.
