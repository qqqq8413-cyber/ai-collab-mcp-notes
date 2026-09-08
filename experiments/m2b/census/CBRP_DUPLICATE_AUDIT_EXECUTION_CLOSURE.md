# CBRP Duplicate Audit — Execution Closure (Protocol-1 and Protocol-2)

```
Protocol-1 DUP-R00:      FAILED CLOSED / TERMINAL
Protocol-2 DUP-P2-R00:   FAILED CLOSED / TERMINAL
Protocol-3 recovery:     NOT AUTHORIZED for this acquisition
Pool:                    NOT FROZEN
M-ACQ-01:                OPEN
```

> This document is the terminal decision record for the CBRP corpus
> duplicate-audit acquisition across both protocol versions. It does not
> reopen, modify, or restate either protocol's specification — see
> `CBRP_CORPUS_DUPLICATE_AUDIT_PROTOCOL_1.md` and
> `CBRP_CORPUS_DUPLICATE_AUDIT_PROTOCOL_2.md`, both unmodified.

---

## 1. Protocol-1 — terminal history (by reference)

Protocol-1's DUP-R00 execution is FAILED CLOSED / TERMINAL, closed by CWP-12E.
`DUP-R00-D1` attempt CONSUMED (`STOP_PROVIDER_ERROR`, 0 provider output);
`DUP-R00-D2` never attempted, abandoned with the failed execution. Historical
evidence: `experiments/m2b/census/duplicate-audit-round-0/**` (CWP-12D-2F),
unchanged. Full account: `CBRP_CORPUS_DUPLICATE_AUDIT_PROTOCOL_2.md` §2-§3.

## 2. Protocol-2 — CWP-12G evidence

```
Round:       DUP-P2-R00
Namespace:   experiments/m2b/census/duplicate-audit-p2-round-00/**
Commit:      ffbe0b26e5a8ddd927d0ff936d16fccee18dcbeb (CWP-12G)
```

**D1 — `DUP-P2-R00-D1`** (claude / claude-opus-5): attempt CONSUMED,
`SESSION_VALIDATED`, strict JSON, 19 `positivePairs` reported.
Raw: `duplicate-audit-p2-round-00/raw/DUP-P2-R00-D1.{txt,response.json}`.

**D2 — `DUP-P2-R00-D2`** (gemini / gemini-3.8-flash): attempt CONSUMED
(transport was invoked; a real response was returned and durably persisted).
Outcome: `STOP_MALFORMED_RESPONSE`. The raw text was exactly (33 bytes):
`` ```json\n{"duplicatePairs":[]}\n``` `` — a markdown code fence wrapping
otherwise-parseable JSON. The frozen,
deliberately fence-intolerant extractor (`duplicate-audit-extractor-v1.mjs`,
CWP-12B-R) correctly rejected it: Protocol-1/2's own frozen text never
authorized fence-stripping tolerance. The fence was not removed, the embedded
JSON was not salvaged, and the response was not reinterpreted as a valid D2
result. Raw: `duplicate-audit-p2-round-00/raw/DUP-P2-R00-D2.{txt,response.json}`.

## 3. Terminal classification

```
DUP-P2-R00:              FAILED CLOSED / TERMINAL
D1D2_OUTCOME.json:        NOT DERIVED (requires both sessions validated)
Confirmed duplicates:     UNKNOWN
Disagreement set:         NOT DERIVED
D3:                       NOT RUN / NOT AUTHORIZED
```

`[FACT]` The 19 pairs D1 reported are **observed evidence of one auditor's
output only** — they are not confirmed duplicates, not a disagreement set,
and not eligible for retention under §7.3's decision matrix, which requires
both D1 and D2. They must not be used as formal duplicate decisions.

`[FACT]` D2's malformed raw content (the fenced, otherwise-empty
`{"duplicatePairs":[]}`) is preserved exactly as received. It is not treated
as a formal negative vote, an implicit "no duplicates found," or any other
semantic reading — a malformed response carries no vote under §7.2/§7.4; it
is simply not admitted.

No `D1D2_OUTCOME.json`, no `D3_ROUTE_MANIFEST.json`, no `FINAL_DECISIONS.json`,
and no `RETENTION.json` exist for `DUP-P2-R00`, under either protocol.

## 4. Recovery decision: no Protocol-3 for this acquisition

`[ARCHITECTURE-DECIDED]` Unlike Protocol-1's failure (a client-side
infrastructure error before any provider output existed), Protocol-2's
DUP-P2-R00 execution produced substantive model output before this decision
was made: D1's 19 positive pairs, and D2's substantive (if protocol-invalid)
empty-list payload. A new recovery protocol specified after observing that
output could not claim the same absence of outcome-dependent researcher
discretion that justified the Protocol-1 → Protocol-2 transition. **No
Protocol-3 recovery is authorized for this acquisition.**

A future, separately designed duplicate-audit instrument — for example one
using a different structured-output mechanism robust to fence-wrapping — may
be specified and preregistered on its own terms. It must not be presented as
a continuation or recovery of this acquisition; it is a new study.

## 5. Current consequence

```
current 60-task corpus:   STRUCTURAL REVIEW PASS (unchanged, CBRP_STRUCTURAL_REVIEW
                           ROUND_2 R3_COMPLETE, 60/60 FINAL)
duplicate status:          NOT FORMALLY RESOLVED
pool:                      NOT FROZEN
retention:                  NONE APPLIED
replacement:                NONE
DUP-P2-R01:                 NOT RUN / NOT AUTHORIZED
D3 (either protocol):        NOT RUN / NOT AUTHORIZED
M-ACQ-01:                    OPEN — the CBRP reference-population assignment
                             rate has NOT been measured
```

This document authorizes nothing further. It closes the record of what was
attempted and observed under Protocol-1 and Protocol-2, and states plainly
what has NOT happened: no duplicate decision, no pool freeze, no next round,
no D3, no recovery protocol.
