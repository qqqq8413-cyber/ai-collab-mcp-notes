# CBRP Authoring Round 0 — FAILED ACQUISITION, preserved

```
RUN:       CBRP-AUTHORING-ROUND-0        PROTOCOL:  CBRP-AUTHORING-PROTOCOL-1
PINS:      CBRP-SESSION-MODEL-PINS-1     CALLS:     5 logical, 5 authorized

provider execution      COMPLETE      the five responses came back
authoring acquisition   INCOMPLETE    FORBIDDEN_LITERAL_STOP
```

> ## Superseded by architecture verdict
>
> GPT Architecture reviewed this run in CWP-9B and ruled the **authoring acquisition
> INCOMPLETE**: the frozen brief categorically prohibits the literal word *specialist*, and
> CWP-9A's frozen STOP envelope lists "contains forbidden leakage" as an authoring-stage
> STOP. Two candidates contain it. The run may **not** be reinterpreted as a successful
> acquisition on the grounds that both uses are semantically ordinary.
>
> The adjudication is
> [`AUTHORING_V1_ARCHITECTURE_VERDICT.json`](AUTHORING_V1_ARCHITECTURE_VERDICT.json).
> Everything below is preserved exactly as recorded at execution time; the verdict
> supersedes it for **study-state interpretation only**, and alters nothing.

> **None of these 60 are CBRP tasks, and none ever will be.** Not admitted, not
> duplicate-cleared, not frozen, not ordered, not Census-eligible — and now not eligible for
> any future pool. They are historical failed-acquisition evidence and methodology-design
> evidence, and nothing else. No gate ever ran on them.

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

`[FACT]` **What the two historical status fields do and do not mean.** Both are left exactly
as the executor wrote them, because both are true of what they measure:

```
SESSIONS.json      runStatus = COMPLETE        the five provider responses completed
VALIDATION.json    mechanicalStatus = PASS     count, schema and hash mechanics passed
```

Neither says the frozen authoring protocol passed, and neither was ever capable of saying
so — a literal-prohibition breach is invisible to a count-and-hash check. The architecture
verdict supersedes them for study-state interpretation, and does not edit them.

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

### 5.1 Adjudicated — this is what closed the run

`[DECISION]` The question of which gate owns a §2.7 literal violation was left open at
execution time and **decided by GPT Architecture in CWP-9B**: the brief's prohibition is
categorical, the STOP envelope is frozen, and the run is therefore an **INCOMPLETE
authoring acquisition** — `FORBIDDEN_LITERAL_STOP`.

```
B04-S00-FR-02   "technical onboarding specialists"
B05-S00-OP-01   "duplicating specialist coverage"
```

`[FACT]` The correct label is **LEXICAL AUTHORING-BRIEF VIOLATION**. Both are ordinary
domain usage — a hiring line item and hospital physician coverage — and **neither is
measured-event steering**; nothing here steered a Chief toward assigning more workers, and
no Chief was ever called. Under Authoring v1 as written, an ordinary usage is still a STOP,
because the prohibition was lexical rather than semantic.

`[DESIGN]` That gap is recorded as method lesson **M-CBRP-AUTH-01**: lexical occurrence and
answer-production steering are distinct concepts, and v1's rule conflated them. **The
lesson does not rescue this run.** Any revision is prospective, in a new protocol version;
applying it backwards would be deciding a gate's outcome after seeing what it caught.

## 6. Not done, and now permanently not authorized for these candidates

```
structural review R1 / R2 / R3        NOT RUN ｜ NOT AUTHORIZED for these 60
corpus duplicate audit D1 / D2 / D3   NOT RUN ｜ NOT AUTHORIZED for these 60
replacement sessions                  NOT RUN ｜ none authorized under v1
retry / repair / same-session cont.   FORBIDDEN — CWP-9A was one-shot
renumbering into final CBRP ids       FORBIDDEN
promotion into Authoring v2           FORBIDDEN
diversity report                      NOT RUN
pool freeze ｜ POOL_FREEZE_COMMIT      NOT DONE
ordering ｜ seed                       NOT DERIVED
Chief planning ｜ Census               NOT RUN — Census relevance is NONE
```

## 7. What a renewed acquisition needs

`[ARCHITECTURE-DECIDED]` A new version, not a continuation:

```
protocol version      CBRP-AUTHORING-PROTOCOL-2
                      a new authoring brief version and hash
                      a new run ID
                      a new candidate namespace
carries forward       nothing
```

The five sessions in this directory are closed. They are not rerun, not repaired, and not
continued.
