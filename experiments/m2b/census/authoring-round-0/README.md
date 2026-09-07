# CBRP Authoring Round 0 — raw evidence

```
RUN:     CBRP-AUTHORING-ROUND-0          STATUS:  COMPLETE
PINS:    CBRP-SESSION-MODEL-PINS-1       CALLS:   5 logical, 5 authorized

CANDIDATES:  60 PROVISIONAL / UNREVIEWED
```

> **These are not CBRP tasks.** They are not structurally admitted, not duplicate-cleared,
> not frozen, not ordered and not Census-eligible. They may not be called a frozen pool or
> a preregistered task pool. Nothing here has passed a gate, because no gate has run.

---

## 1. What is in here

```
BRIEF_SENT.txt              the exact prompt bytes every session received
run.mjs                     the five authoring calls; raw preservation before parsing
extract.mjs                 deterministic extraction and the mechanical checks
SESSIONS.json               per-session provenance
raw/<session>.txt           each author response, verbatim, before any transformation
raw/<session>.response.json the full provider response object
candidates/<session>.json   that session's extracted candidate records
CANDIDATES.json             all 60 records
VALIDATION.json             the mechanical count/hash/uniqueness results
```

Raw responses are written before anything reads them and are never overwritten.

## 2. Sessions

Deterministic block order, one logical call each, no inter-session adaptation. Every
session received byte-identical prompt bytes — one file, read once, sent unchanged.

```
AUTHOR-B01-S00   claude / claude-sonnet-5     12 candidates
AUTHOR-B02-S00   gemini / gemini-3.7-flash    12
AUTHOR-B03-S00   claude / claude-sonnet-5     12
AUTHOR-B04-S00   gemini / gemini-3.7-flash    12
AUTHOR-B05-S00   claude / claude-sonnet-5     12

authoringBriefSha256   7f1f9ebe4dfde9402d838137a549859a630b60a93dce93a119b70bf9642d665f
```

`[FACT]` **Resolved model identity was observable on every call, and matched the requested
pin exactly in all five.** Anthropic returned `model`, Gemini returned `modelVersion`.
CWP-8D allowed for `modelResolved: null` and an operator attestation; that fallback was not
needed. `pinStatus` reads `OBSERVED`, not `OPERATOR ATTESTATION`.

`[DESIGN]` `freshContextConfirmed` remains an **operator attestation**. Each call is one
stateless request carrying only the brief — no conversation id, no prior turns, no system
prompt — which is as fresh as an API context gets, and still not independently verified.

## 3. Extraction

`[DECISION]` **No scenario text was altered.** The only transformation was removing the
fenced code wrapper around the declared JSON format and reading the two declared fields.
Three responses (the Claude ones) arrived fenced; two did not. No wording, grammar,
category, length or content was touched.

Verified by re-parsing the raw bytes with a second independent implementation: 60/60 texts
and declared strata identical, 60/60 `taskSha256` recompute from the stored bytes.

Provisional ids are `<block>-S00-<stratum>-<nn>`, numbered by **order of appearance** in the
author's response — the only outcome-blind ordering available. They are immutable from here,
and are not the freeze-time `CBRP-SC-01…` ids.

## 4. Mechanical results

```
12 candidates per session, 2 per stratum per session      PASS
60 total, 10 per stratum                                  PASS
provisional ids unique                                    PASS
taskSha256 present and well formed for all 60             PASS
byte-identical scenario texts                             0
word count range                                          145 – 311
```

Purely mechanical. No structural judgement was made anywhere in this run.

## 5. Forbidden-literal scan — DESCRIPTIVE EVIDENCE, NOT A VERDICT

Recorded for the blinded structural reviewers. **Claude Code made no admission, rejection
or leakage judgement**, which under CWP-9A §14 is not its decision to make.

```
whole-word hits    2      B04-S00-FR-02   "technical onboarding specialists"
                          B05-S00-OP-01   "duplicating specialist coverage"
substring only     4      "llm" inside fulfillment  x3
                          "anthropic" inside philanthropic  x1
```

The scan matches at a **word-start** boundary, so inflections count and interior
coincidences do not. Both lists are stored so the scan itself stays auditable — a first
pass using bare substring matching reported six hits, four of which were artifacts, and
handing those to a reviewer would have been false leakage evidence.

### 5.1 An open question for GPT, deliberately not answered here

The brief's §2.7 bans the literal word *specialist*. Two candidates contain it, in ordinary
business senses — a hiring line item, and hospital physician coverage.

CWP-9A **§7 and §19** make "contains forbidden leakage" an unusable-response STOP for the
whole run. **§14** reserves structural judgement for the blinded reviewers and casts this
scan as descriptive evidence. Those pull in opposite directions here, and the two readings
have very different costs: a STOP discards 24 candidates from two sessions over two words,
while the per-task review gate already carries "no specialist-count steering" and is
designed to reject exactly this — producing a vacancy that a replacement session fills.

`[OPEN]` **Which gate owns a §2.7 literal violation in a minority of candidates.** Nothing
is lost by leaving it open: no candidate is admitted, nothing is frozen, and CWP-9A §23
requires a return to GPT before any further stage. Deciding it unilaterally in either
direction would have been the larger error.

## 6. Not done, not authorized

```
structural review R1 / R2 / R3        NOT RUN
corpus duplicate audit D1 / D2 / D3   NOT RUN
replacement sessions                  NOT RUN, none authorized
diversity report                      NOT RUN
pool freeze ｜ POOL_FREEZE_COMMIT      NOT DONE
ordering ｜ seed                       NOT DERIVED
Chief planning ｜ Census               NOT RUN
```
