# CBRP Authoring v2 Round 0 — Incomplete Evidence

```
run id               CBRP-AUTHORING-V2-ROUND-0
protocol             CBRP-AUTHORING-PROTOCOL-2
brief                CBRP-AUTHORING-BRIEF-2
execution base       08cd0200ecbd4642dd394e8377362ce18a23566a
status               INCOMPLETE
logical calls        2 of at most 5
extracted candidates 12 of expected 60
```

This directory preserves the truthful partial evidence from CWP-10B-CODEX. The five
initial sessions were scheduled sequentially. `AUTHOR2-B01-S00` returned a mechanically
valid 12-object response. `AUTHOR2-B02-S00` returned a response that could not be parsed
by the frozen deterministic extraction rule, so the acquisition stopped immediately.
`AUTHOR2-B03-S00`, `AUTHOR2-B04-S00`, and `AUTHOR2-B05-S00` were not called.

The B02 raw text and full provider response are preserved under `raw/`. No retry,
follow-up, repair, replacement, structural review, duplicate audit, Chief call, pool
freeze, or ordering step was performed.

## Evidence map

- `BRIEF_SENT.txt` — exact 8114-byte model-visible prompt; SHA-256
  `a9da93fd5d4dd059c0faebdf3e29713abe2035191af5aac26a5b73eb17842336`.
- `SESSIONS.json` — call order, pins, timing, outcomes, and the recorded pre-dispatch
  local syntax-validation refusal.
- `raw/` — immutable raw text and full provider response objects for B01 and B02.
- `candidates/AUTHOR2-B01-S00.json` — the 12 deterministically extracted B01 records.
- `CANDIDATES.json` — incomplete aggregate containing only deterministically parseable
  candidates.
- `VALIDATION.json` — primary mechanical validation result; acquisition status is FAIL.
- `CROSS_CHECK.json` — independent standard-library JSON/hash cross-check of the 12
  extracted candidates.
- `run.mjs`, `extract.mjs`, `cross-check.mjs` — bounded acquisition and offline checking
  tools used for this run.

## Interpretation boundary

The 12 extracted records are **V2 PROVISIONAL / UNREVIEWED / NOT ADMISSIBLE**. They do
not constitute a task pool, a completed acquisition, a structural-review result, a
duplicate-clearance result, or Census evidence. No semantic judgement was performed.
