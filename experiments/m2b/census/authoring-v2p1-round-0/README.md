# CBRP Authoring V2P1 Round 0 — raw evidence

```
RUN:        CBRP-AUTHORING-V2P1-ROUND-0        STATUS:  COMPLETE
PROTOCOL:   CBRP-AUTHORING-PROTOCOL-2.1        EXTRACTOR: CBRP-AUTHOR-EXTRACTOR-2.1
BRIEF:      CBRP-AUTHORING-BRIEF-2             PINS:    CBRP-SESSION-MODEL-PINS-1
CALLS:      5 logical, 5 authorized (CWP-10E-AUTH)

CANDIDATES: 60 PROTOCOL-2.1 PROVISIONAL / UNREVIEWED
```

> **These are not CBRP tasks.** They are not structurally admitted, not duplicate-cleared,
> not frozen, not ordered and not Census-eligible. This is a **new acquisition** under
> Protocol 2.1 — not a retry or continuation of Protocol 2's
> `CBRP-AUTHORING-V2-ROUND-0`, whose 12 valid B01 candidates and B02 STOP evidence remain
> historical, immutable, and permanently excluded from this pool (see
> `CBRP_AUTHORING_PROTOCOL_2.md` §9.4).

---

## 1. What is in here

```
BRIEF_SENT.txt              the exact prompt bytes every session received
run.mjs                     the five authoring calls; raw preservation before extraction
SESSIONS.json                per-session provenance, requested/resolved identity, extractor result
raw/<session>.txt           each author response, verbatim, before any transformation
raw/<session>.response.json the full provider response object
candidates/<session>.json   that session's extracted candidate records
CANDIDATES.json             all 60 records
```

Raw responses are written before anything reads them and are never overwritten.
Extraction used only `CBRP-AUTHOR-EXTRACTOR-2.1` — no custom parsing, no fallback, no
manual cleanup, no ad-hoc repair.

## 2. Sessions

Deterministic block order, one logical call each, no inter-session adaptation. All five
sessions received byte-identical prompt bytes — one file, read once, sent unchanged.

```
AUTHOR21-B01-S00   claude / claude-sonnet-5     COMPLETE_OUTER_FENCE   12 candidates
AUTHOR21-B02-S00   gemini / gemini-3.7-flash    PLAIN_JSON             12
AUTHOR21-B03-S00   claude / claude-sonnet-5     COMPLETE_OUTER_FENCE   12
AUTHOR21-B04-S00   gemini / gemini-3.7-flash    PLAIN_JSON             12
AUTHOR21-B05-S00   claude / claude-sonnet-5     COMPLETE_OUTER_FENCE   12

promptSha256   a9da93fd5d4dd059c0faebdf3e29713abe2035191af5aac26a5b73eb17842336
```

`[FACT]` **Resolved model identity was observable on every call and matched the requested
pin exactly in all five** — `pinStatus: OBSERVED` throughout, not the `OPERATOR
ATTESTATION` fallback. None of the three accepted representations needed the Case C
(`ORPHAN_TRAILING_FENCE`) shape this run: three responses arrived as a complete outer
fence, two as plain JSON. The tightened Case C grammar from CWP-10C-R was exercised only
by its offline test suite and the B02 descriptive verification, not by this live run.

`[DESIGN]` `freshContextConfirmed` remains an **operator attestation**: each call is one
stateless request carrying only the brief — no conversation id, no prior turns, no system
prompt, no session/block identity in the model-visible prompt.

## 3. Extraction and verbatim preservation

`[DECISION]` **No scenario text was altered.** `CBRP-AUTHOR-EXTRACTOR-2.1` performed the
only transformation permitted — recognizing and removing wrapper bytes around the
declared JSON array — and nothing else.

Independently verified twice, outside the extractor module:
- A second, from-scratch re-parse of the raw bytes (bypassing
  `extractCbrpAuthorResponse` entirely) reproduces all 60 texts and declared strata
  exactly.
- All 60 `taskSha256` values recompute from the stored `taskText` bytes.

Provisional ids are `V21-<block>-S00-<stratum>-<nn>`, numbered by **order of appearance**
in the author's response. They are immutable from here and are not the freeze-time
`CBRP-SC-01…` ids.

## 4. Mechanical results

```
12 candidates per session, 2 per stratum per session      PASS  (5/5 sessions)
60 total, 10 per stratum globally                         PASS
provisional ids unique                                    PASS  (60/60)
taskSha256 present, well formed, and recomputes            PASS  (60/60)
raw -> parsed text preservation                            PASS  (independent re-parse)
```

Purely mechanical. No structural judgement — `stratumCorrect`, `primaryOutputClear`,
`selfContained`, `realistic`, `noExperimentLeakage`, `noSpecialistSteering`,
`overallPass`, likely complexity, likely specialist count, likely Census eligibility —
was made anywhere in this run. Those are the blinded structural reviewers' questions.

## 5. Optional descriptive literal scan — NOT a gate

Recorded as evidence only, per CWP-10E §19 / §14 and CWP-10E-AUTH §9: **no STOP
authority, no rejection authority, no admission authority**, and this scan's output must
never enter a future reviewer's prompt.

```
whole-word "specialist" hits   2
  V21-B02-S00-SC-01   "...a specialist machining firm with $22M in annual revenue..."
  V21-B02-S00-OP-01   "...comprises 10 dedicated IT integration specialists..."
```

Under `CBRP-AUTHORING-BRIEF-2` (§2.7, corrected in CWP-10A) this word is not forbidden —
only answer-production steering is. No characterization of these two occurrences as
steering or non-steering is made here; that judgement belongs to structural review.

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

Per CWP-10E §23 / CWP-10E-AUTH §12: **STOP here.** Return to GPT Architecture before any
further stage.
