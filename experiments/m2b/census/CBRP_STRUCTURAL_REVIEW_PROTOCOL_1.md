# CBRP Structural Review Execution Protocol — FROZEN METHODOLOGY

```
PROTOCOL:      CBRP-STRUCTURAL-REVIEW-PROTOCOL-1
RUBRIC:        CBRP-STRUCTURAL-REVIEW-RUBRIC-1   (byte count 4694, sha256 2028b998…)
PROMPT:        CBRP-STRUCTURAL-REVIEW-PROMPT-1
BLIND ID:      CBRP-STRUCTURAL-BLIND-ID-v1
EXTRACTOR:     CBRP-STRUCTURAL-REVIEW-EXTRACTOR-1
ORDER:         CBRP-STRUCTURAL-REVIEW-ORDER-v1
D3 ROUTING:    CBRP-D3-v1        (unchanged — CBRP_MODEL_PINS_PREREG_DRAFT.md §7.1)
REVIEWER PINS: R1 claude/claude-opus-5, R2 gemini/gemini-3.8-flash
               (unchanged — CBRP_MODEL_PINS_PREREG_DRAFT.md §3)
AMENDMENT:     CBRP-STRUCTURAL-REVIEW-EXECUTION-AMENDMENT-1 (§18, CWP-11B)
               ROUND_1 generation envelope — offline prepared, not executed

STATUS:  METHODOLOGY FROZEN ｜ OFFLINE VERIFIED
ROUND_0: LIVE / FAILED_CLOSED / INITIAL_INCOMPLETE / IMMUTABLE (80 dispatched, 79 validated)
ROUND_1: LIVE NOT AUTHORIZED
```

> **Content-blind by construction, like `CBRP_REPLACEMENT_PROTOCOL_1.md`.** This
> document, its reference implementation and its tests were written without any of
> the 60 `CBRP-AUTHORING-V2P1-ROUND-0` task texts entering a fixture, a synthetic
> example, or a design decision. Nothing here depends on what any of them says.

---

## 0. Why this needed its own document

`CBRP_STRUCTURAL_REVIEW_RUBRIC_DRAFT.md` and `CBRP_MODEL_PINS_PREREG_DRAFT.md`
already froze **what** a reviewer judges and **which** model judges it: the six
per-task checks, the R1/R2 pins, and that R3 exists only on disagreement, routed by
`CBRP-D3-v1`. Neither document froze **the exact bytes a reviewer sees**, **how a
real candidate id is kept out of that reviewer's hands**, **the exact grammar of an
acceptable response**, **the mechanical procedure that turns two-or-three responses
into one admission decision**, or **the order 60 tasks are dispatched in**. Those
five gaps are exactly what CWP-10F closed for replacement selection, one stage
earlier in the pipeline — this document closes the equivalent gaps for structural
review, **before** any real reviewer call.

---

## 1. Existing structural methodology — preserved, not reopened

`[ARCHITECTURE-DECIDED]` Unchanged by this document:

```
R1  claude / claude-opus-5     R2  gemini / gemini-3.8-flash      — fresh, blinded, independent
R3 exists iff R1.overallPass != R2.overallPass
R3 model = CBRP-D3-v1: SHA256("CBRP-D3-v1\nSTRUCTURAL\n" + taskCandidateId),
           first lowercase hex char, 0-7 -> claude/claude-opus-5, 8-f -> gemini/gemini-3.8-flash
GPT never adjudicates an individual task
the six per-task judgements and their pass/fail meaning (CBRP_STRUCTURAL_REVIEW_RUBRIC_DRAFT.md §2)
```

Nothing in §2–§9 below changes any of this. They freeze the execution path around
it: the bytes, the identity scheme, the grammar, the schema, and the order.

---

## 2. Blind task identity — CBRP-STRUCTURAL-BLIND-ID-v1

`[ARCHITECTURE-DECIDED]` A structural reviewer must never see a real provisional
candidate id (`V21-B01-S00-SC-01`) — those ids encode author block and session
provenance, which the rubric's own blindness requirements (§3 below) forbid
exposing.

```
blindTaskId = "SR-" + SHA256("CBRP-STRUCTURAL-BLIND-ID-v1\n" + trueCandidateId)
```

Full lowercase 64-hex digest. Deterministic, one-way, and **the same for R1, R2 and
R3 on one task** — a reviewer's role never changes what bytes they receive, so
prompt-byte identity across roles is a structural property, not an operational
habit. The true-id ↔ blindTaskId mapping is **operator-side evidence only** and is
never sent to any provider.

Reference implementation:
[`structural-review-protocol/structural-review-prompt-v1.mjs`](structural-review-protocol/structural-review-prompt-v1.mjs)
— `computeBlindTaskId`.

---

## 3. Frozen rubric bytes — CBRP-STRUCTURAL-REVIEW-RUBRIC-1

`[ARCHITECTURE-DECIDED]` The reviewer-facing rubric text is exactly the span of
`CBRP_STRUCTURAL_REVIEW_RUBRIC_DRAFT.md` §2 between its `> ### Paste from here.` and
`> ### Paste to here.` marker lines, with all leading blank-line spacer stripped and
exactly one trailing newline stripped — **not symmetric**, and deliberately so: the
pasted text's own last line, as an ordinary text block, already ends with its own
single newline; only the *second* trailing newline (the blank spacer line before the
closing marker) is spacer. This is the same paste-extraction convention already used
for `CBRP-AUTHORING-BRIEF-2`, and this rubric's extraction is cross-verified against
that brief's already-live-consumed bytes
(`authoring-v2p1-round-0/BRIEF_SENT.txt`) in the test suite (§16) — that check is what
caught an earlier, symmetric-strip draft of this extraction being off by one byte.

```
version       CBRP-STRUCTURAL-REVIEW-RUBRIC-1
byte count    4694   (exact UTF-8 bytes)
sha256        2028b998ea0ba8d687cddf87d67e34a2b03d57ce30c47eb3600d0cf336bf4b6e
```

Extraction is implemented once, precisely, and re-verified against the live file
rather than retyped: `extractRubricPasteBytes` (pure — takes markdown text, returns
the span) and `loadFrozenRubricPasteBytes` (reads the committed rubric doc, extracts,
and **fails closed** if the result does not match the byte count and SHA-256 above —
the same STOP-on-mismatch shape `authoring-v2p1-round-0/run.mjs` already uses for the
authoring brief). Both live in
[`structural-review-protocol/structural-review-prompt-v1.mjs`](structural-review-protocol/structural-review-prompt-v1.mjs).

`[DECISION]` No wording in the rubric's paste span changed to produce this freeze.
Only its *status* line changed (§13 of
[`CBRP_STRUCTURAL_REVIEW_RUBRIC_DRAFT.md`](CBRP_STRUCTURAL_REVIEW_RUBRIC_DRAFT.md))
to distinguish METHODOLOGY FROZEN from EXECUTION NOT RUN from LIVE NOT AUTHORIZED —
three different facts the old single `STATUS: DRAFT` line could not say at once.

---

## 4. Model-visible prompt contract — CBRP-STRUCTURAL-REVIEW-PROMPT-1

`[ARCHITECTURE-DECIDED]` Deterministic, byte-exact construction:

```
<RUBRIC_PASTE_BYTES>
\n\n                         (two LF bytes)
REVIEW INPUT JSON:
\n                            (one LF)
{"taskId":"<blindTaskId>","assignedStratum":"<canonical display name>","taskText":"<exact taskText>"}
```

The JSON object is `JSON.stringify` output in that exact key order, with no
pretty-printing. Canonical stratum display names — matching
`CBRP_STRUCTURAL_REVIEW_RUBRIC_DRAFT.md` §2.1 exactly:

```
SC  Strategy / Commitment            OP  Operations / Execution
BC  Brand / Creative                 EI  Evidence Interpretation
PS  Product / Service Design         FR  Finance / Resource Allocation
```

```
FORBIDDEN in the model-visible bytes:  author metadata ｜ scanner result ｜ replacement metadata
    predecessor ｜ other task ｜ other review ｜ event definition ｜ F1/F2 ｜ theta ｜ P03 ｜ Chief output
    a system prompt carrying project context ｜ any explanation beyond the rubric and the input JSON
```

`[FACT]` For the same task, R1, R2 and R3 prompt bytes are **identical** — the
builder takes no role parameter, so there is no code path by which they could
diverge. Only the provider/model that receives those bytes differs, and that
routing is decided entirely outside this function (§1, §7).

Reference implementation: `buildStructuralReviewPrompt` in
[`structural-review-protocol/structural-review-prompt-v1.mjs`](structural-review-protocol/structural-review-prompt-v1.mjs).
Pure — takes `rubricPasteBytes` as an explicit argument rather than reading the
rubric file itself, so it has no hidden filesystem dependency and is exercised by
synthetic rubric text in every behavior test.

---

## 5. Response normalization — CBRP-STRUCTURAL-REVIEW-EXTRACTOR-1

`[ARCHITECTURE-DECIDED]` The JSON-**object** analogue of `CBRP-AUTHOR-EXTRACTOR-2.1`
(`extractor-2.1/cbrp-author-extractor.mjs`), whose three representations and whose
forbidden-repair list this mirrors exactly, substituting "one JSON object" for "one
JSON array" throughout:

```
A  PLAIN_JSON_OBJECT      the complete trimmed response is one JSON object
B  COMPLETE_OUTER_FENCE   one opening fence line (bare ``` or ```json, case-insensitive),
                          one JSON object, one closing bare-``` line, nothing else
C  ORPHAN_TRAILING_FENCE  one complete top-level JSON object, a genuine line boundary,
                          optional whitespace-only blank lines, then exactly one raw
                          line that is the bare fence — no leading/trailing whitespace
                          on that line, no language tag
```

```
FORBIDDEN, every representation:  searching JSON substrings out of prose ｜ removing
    explanatory text ｜ repairing malformed JSON ｜ adding/removing commas ｜ fixing quotes
    ｜ closing missing brackets ｜ guessing truncation ｜ merging multiple JSON blocks
    ｜ choosing among candidate objects ｜ removing arbitrary suffixes ｜ any semantic rewriting
```

Any unsupported representation is `MALFORMED` — a mechanical STOP for the whole
review session (§11). No retry, no repair prompt, during LIVE review.

Reference implementation: `extractStructuralReviewResponse` in
[`structural-review-protocol/structural-review-extractor-v1.mjs`](structural-review-protocol/structural-review-extractor-v1.mjs).

---

## 6. Response schema and the `overallPass` invariant

`[ARCHITECTURE-DECIDED]` The accepted review object has **exactly** these nine keys
— no missing, no extra:

```
taskId ｜ stratumCorrect ｜ primaryOutputClear ｜ selfContained ｜ realistic
noExperimentLeakage ｜ noSpecialistSteering ｜ overallPass ｜ reasons
```

```
taskId                must equal the model-visible blindTaskId, exactly, as a string
six checks, overallPass   strict boolean — "true"/"false" strings and null are REJECTED
reasons               non-string or empty is REJECTED
```

`[DECISION]` `reasons` non-empty is a mechanical requirement of this schema, decided
in CWP-10G — the packet that requested this freeze left it conditional ("if the
mechanical contract requires non-empty"); this document is what fixes that
condition. An empty `reasons` string satisfies none of the rubric's own output
instructions ("say which check failed and why"), so requiring it non-empty costs
nothing and closes an otherwise-silent gap.

```
expectedOverallPass = stratumCorrect AND primaryOutputClear AND selfContained
                       AND realistic AND noExperimentLeakage AND noSpecialistSteering

overallPass MUST equal expectedOverallPass exactly.  Mismatch -> FAIL CLOSED.
Never repaired. Never inferred. Never asked what the reviewer "must have meant."
```

Reference implementation: `validateReviewObject` in
[`structural-review-protocol/structural-review-decision-v1.mjs`](structural-review-protocol/structural-review-decision-v1.mjs).

---

## 7. Disagreement trigger and R3 routing

`[ARCHITECTURE-DECIDED]` **Frozen explicitly, per CWP-10G, as the reading of the
existing rubric's decision table:**

```
ADMISSION DISAGREEMENT  :=  R1.overallPass !== R2.overallPass     — this alone triggers R3

R1 PASS + R2 PASS   ->  FINAL PASS, no R3
R1 FAIL + R2 FAIL   ->  FINAL FAIL, no R3
overallPass differs  ->  R3 REQUIRED
```

`[DECISION]` Differences between the individual six check fields **may** be recorded
descriptively (`describeCheckLevelDisagreement`) as check-level disagreement. They
**do not** independently trigger R3 when `overallPass` agrees, and no second,
field-by-field voting mechanism exists. Two reviewers can both FAIL a task for two
different reasons — one check each — and that is not a disagreement this protocol
acts on; only the single boolean that decides admission is compared.

`[ARCHITECTURE-DECIDED]` R3 receives **exactly** the same model-visible bytes as R1
and R2 (§4) and must **not** be told: that R1/R2 disagreed, either response, either
provider/model, which side needs a tie-break, or the current vote count. R3's
provider/model is selected **operator-side**, from `CBRP-D3-v1` over the **true**
candidate id (§1) — never the blind one, and never anything model-visible.

Reference implementation: `admissionDisagreement`, `describeCheckLevelDisagreement`,
`computeStructuralD3Selector` in
[`structural-review-protocol/structural-review-decision-v1.mjs`](structural-review-protocol/structural-review-decision-v1.mjs).

---

## 8. Final admission decision

`[ARCHITECTURE-DECIDED]`

```
no R3 (R1/R2 agreed)   finalPass = R1.overallPass  ( = R2.overallPass )
R3 present              finalPass = majority(R1.overallPass, R2.overallPass, R3.overallPass)
```

Reference implementation: `decideStructuralReview` — refuses (`ok:false`) to compute
a decision from an R1/R2 pair that disagrees without an R3 present, and refuses an
R3 supplied when R1/R2 already agreed (R3 must never run in that case). Neither
refusal is repaired or overridden; both are the function saying the decision is not
yet computable, or was asked for a case that cannot exist under this protocol.

---

## 9. Call ordering — CBRP-STRUCTURAL-REVIEW-ORDER-v1

`[ARCHITECTURE-DECIDED]` Deterministic, no PRNG, no seed shopping, no outcome input:

```
reviewOrderKey = SHA256("CBRP-STRUCTURAL-REVIEW-ORDER-v1\n" + taskCandidateId + "\n" + taskSha256)
sort ascending, lowercase-hexadecimal lexicographic
```

```
INITIAL PASS:  for each task in review order: dispatch R1, then R2
               (temporally adjacent for one task; still separate fresh contexts, separate pinned models)
               R2's prompt is already fixed before R1 is dispatched (§4) —
               R1's response is never inspected to change R2's input
```

```
R3 PASS:  only after all 60 R1/R2 pairs are COMPLETE — never launched after the first disagreement
          = the frozen initial order, filtered to disagreeing tasks (order-preserving)
          disagreement set and each task's D3 route are materialized before the first R3 dispatch
```

Reference implementation: `computeReviewOrderKey`, `computeStructuralReviewOrder` in
[`structural-review-protocol/structural-review-order-v1.mjs`](structural-review-protocol/structural-review-order-v1.mjs);
composed into full plans by `computeInitialReviewPlan` and `computeR3Plan` in
[`structural-review-protocol/structural-review-runner.mjs`](structural-review-protocol/structural-review-runner.mjs).
No separate R3 ordering rule is defined — `Array.prototype.filter` preserves
relative order, so filtering the frozen initial order *is* the R3 order.

---

## 10. Call budget

```
mandatory   60 x R1  +  60 x R2  =  120 logical provider calls
optional    0 to 60 x R3
maximum     180 logical calls for the complete stage
per session maximum 1 attempt — no retry, no repair, no continuation, no fallback model
```

Frozen as `CALL_BUDGET` in
[`structural-review-protocol/structural-review-runner.mjs`](structural-review-protocol/structural-review-runner.mjs).

---

## 11. Evidence preservation and STOP conditions

`[ARCHITECTURE-DECIDED]` Before extracting or evaluating any response: **persist the
complete raw provider response first.** At minimum, every review session records:

```
true taskCandidateId ｜ blindTaskId ｜ reviewSessionId ｜ reviewRole (R1|R2|R3)
providerRequested/Resolved ｜ modelRequested/Resolved ｜ resolvedIdentityObservable ｜ pinStatus
rubricVersion ｜ rubricSha256 ｜ promptVersion ｜ promptSha256 ｜ promptBytes
startedAt ｜ settledAt ｜ providerDispatchCount ｜ transportRetryConfiguration
rawResponseSha256 ｜ raw response bytes ｜ extractorVersion ｜ representationDetected
normalizedJsonSha256 ｜ parsed review object ｜ mechanical validation result
```

No raw evidence overwrite, ever. Session ids
(`<trueTaskCandidateId>-R1`/`-R2`/`-R3`) are **operator-side provenance only** — never
model-visible (§2, §4).

`[ARCHITECTURE-DECIDED]` **STOP immediately** on any of: base/runtime drift ｜
prompt/rubric hash mismatch ｜ exact model unavailable ｜ observable pin mismatch ｜
provider/transport failure ｜ unexpected second provider attempt ｜ non-fresh context
｜ raw evidence preservation failure ｜ extractor rejection (MALFORMED) ｜ JSON parse
rejection ｜ schema rejection ｜ `taskId`/`blindTaskId` mismatch ｜ `overallPass`
AND-invariant mismatch ｜ unexpected R3 provider routing ｜ unexpected review-session
duplication.

```
after any STOP:  preserve evidence, do not retry, do not repair,
                  do not continue later reviews, return to GPT
```

---

## 12. No semantic operator override

`[ARCHITECTURE-DECIDED]` Claude Code / the operator **must not**: change reviewer
booleans, rewrite `reasons`, reinterpret a failure, override the majority, promote a
rejected candidate, drop an inconvenient review, reassign stratum, or alter task
text. Pool-membership admission comes **only** from `decideStructuralReview`'s frozen
boolean procedure over validated review objects — never from a human or model
judgement applied after the fact.

---

## 13. Real candidates are not test fixtures

`[ARCHITECTURE-DECIDED]` All prompt-builder, extractor, and decision-engine tests
(`test-structural-review-protocol.mjs`) use synthetic candidate text and synthetic
ids only — never any of the 60 `CBRP-AUTHORING-V2P1-ROUND-0` task texts, as a parser
fixture, a prompt fixture, an expected PASS/FAIL fixture, or a review example. A
separate anti-contamination check (§2 of the test file's own reporting, mirroring
`extractor-2.1/test-extractor.mjs`) asserts this of the test file itself. The rubric
document read by §3's provenance check is methodology text, not a candidate
scenario, and is reported in its own third category rather than folded into either
of the other two.

---

## 14. Reserved future artifact namespace — not created now

`[DESIGN]` A future LIVE run's evidence belongs under
`experiments/m2b/census/structural-review-round-0/` (`RUBRIC_SENT.txt`,
`PROMPT_MANIFEST.json`, `BLIND_ID_MAP.json`, `REVIEW_ORDER.json`, `SESSIONS.json`,
`REVIEWS.json`, `DISAGREEMENTS.json`, `FINAL_DECISIONS.json`, `VALIDATION.json`,
`raw/`). **None of it exists yet.** Creating any of it now, with zero real reviewer
calls behind it, would be exactly the kind of fabricated evidence this whole
provenance discipline exists to prevent. This section names the namespace so a
future LIVE packet does not have to re-derive it; it commits nothing else.

---

## 15. Why the LIVE dispatch path is a guarded stub, not an implementation

`[DESIGN]` `structural-review-runner.mjs` implements every **pure** step of the
pipeline — blind identity, prompt bytes, response grammar, schema, the decision
procedure, and dispatch ordering — and composes them into `computeInitialReviewPlan`
and `computeR3Plan`. It does **not** implement `dispatchLiveStructuralReview`; calling
it always throws.

Building a real Anthropic/Gemini dispatch path now, with no LIVE authorization to
exercise it against, would be untested code presented as trustworthy — exactly the
failure mode this protocol's evidence discipline exists to prevent one layer up. The
guard keeps the gap honest instead of papering over it: no test, import, or
accidental invocation in this packet can reach a provider from this file. A future
execution packet carrying explicit `EXECUTION AUTHORIZATION: GRANTED` for structural
review LIVE calls is the one that gets to write that function's body — and at that
point it can be tested against what it is actually for.

---

## 16. Offline verification

```
modules   experiments/m2b/census/structural-review-protocol/
            structural-review-prompt-v1.mjs
            structural-review-extractor-v1.mjs
            structural-review-decision-v1.mjs
            structural-review-order-v1.mjs
            structural-review-runner.mjs
tests     experiments/m2b/census/structural-review-protocol/test-structural-review-protocol.mjs
            synthetic behavior tests:              76/76 passing (grew from 67 as CWP-10G-R
                                                    tightened the extractor's fence-line grammar)
            anti-contamination provenance check:    1/1 passing (separately reported)
            frozen rubric provenance check:          3/3 passing (separately reported)
          experiments/m2b/census/structural-review-protocol/test-structural-review-live-harness.mjs
            39/39 passing (CWP-10H's 29 offline harness tests + CWP-11B's 10:
            ROUND_0/ROUND_1 envelope values, Claude/Gemini per-call token and
            thinkingLevel routing, ROUND_1 cardinality, an unrecognized roundId
            refused pre-dispatch, three MAX_TOKENS fail-closed cases, and the
            ROUND_0/ROUND_1 namespace-reality guards)
```

Covered: blind-id determinism and one-wayness; R1/R2/R3 prompt-byte identity for one
task; the six canonical stratum display names; JSON escaping of task text (quotes,
backslashes, newlines, Unicode); deterministic prompt hashing; all three extractor
representations passing and eleven distinct MALFORMED shapes failing closed
(prose prefix/suffix, a second JSON object, an array where an object is required —
both bare and fenced, truncated JSON, an incomplete fence, a same-line fence, leading
and trailing whitespace on the fence line, an unsupported language tag); full schema
validation (missing/extra key, string/null booleans, wrong `blindTaskId`,
empty/non-string `reasons`, both directions of the `overallPass` mismatch); every
disagreement/no-disagreement/majority combination the decision table can produce,
including the child-check-disagreement-without-R3 case; all six `CBRP-D3-v1`
structural test vectors from `CBRP_MODEL_PINS_PREREG_DRAFT.md` §7.1 reproduced
exactly; order determinism and its independence from storage order; full plan
composition (`computeInitialReviewPlan`, `computeR3Plan`) including R3's reused
R1-identical prompt bytes; the frozen call-budget numbers; that
`dispatchLiveStructuralReview` unconditionally rejects; and, separately, that the §3
extraction convention reproduces `authoring-v2p1-round-0/BRIEF_SENT.txt` byte-for-byte
when applied to the authoring brief's own paste markers — the check that caught this
document's extraction rule being off by one trailing-newline byte before any rubric
bytes were frozen against it.

---

## 17. Status

```
CBRP-STRUCTURAL-REVIEW-PROTOCOL-1     FROZEN, OFFLINE VERIFIED
ROUND_0 (LIVE, CWP-10E-era envelope)   EXECUTED / FAILED_CLOSED / INITIAL_INCOMPLETE / IMMUTABLE
ROUND_1 (amended envelope, CWP-11B)    OFFLINE PREPARED / NOT EXECUTED / LIVE NOT AUTHORIZED
sessions dispatched (ROUND_0)          80          reviews validated (ROUND_0)   79
formal admitted tasks                  0
duplicate audit rounds                 0
pool frozen                            NO
Chief Census calls                     0
study                                  NOT PREREGISTERED
```

`[FACT]` ROUND_0 actually ran LIVE and stopped incomplete: `V21-B01-S00-EI-02-R2`
(Gemini) terminated on `finishReason: MAX_TOKENS`, its visibly truncated text
failed `CBRP-STRUCTURAL-REVIEW-EXTRACTOR-1`, and the run STOPPED at
`STOP_MALFORMED_RESPONSE` with 80 sessions dispatched and 79 reviews validated —
preserved immutably under `structural-review-round-0/`. See §18 for the
generation-envelope amendment (`CBRP-STRUCTURAL-REVIEW-EXECUTION-AMENDMENT-1`,
CWP-11B) this outcome produced.

No structural review has completed on any of the 60 `CBRP-AUTHORING-V2P1-ROUND-0`
candidates, and none may run again under ROUND_0's exact envelope or namespace —
that attempt is closed. A ROUND_1 attempt requires a separate future GPT packet
carrying explicit `EXECUTION AUTHORIZATION: GRANTED` for structural review LIVE
execution.

---

## 18. CBRP-STRUCTURAL-REVIEW-EXECUTION-AMENDMENT-1 — ROUND_1 generation envelope (CWP-11B)

`[ARCHITECTURE-DECIDED]` A **prospective, envelope-only** amendment, frozen after
ROUND_0's real LIVE failure and before any ROUND_1 call. Nothing in §1–§9 changes:
same 60 candidates, same rubric, same prompt bytes, same blind ids, same review
order, same R1/R2 exact model pins, same R1-then-R2 ordering, same one-attempt/
no-retry/no-fallback/no-substitution rule, same extractor/schema/admission
semantics. Only the per-provider generation ceiling changes, and only for a
**new** round:

```
                ROUND_0 (historical, immutable)   ROUND_1 (amended, not yet run)
R1 / claude     maxOutputTokens 4096              maxOutputTokens 4096  (UNCHANGED)
R2 / gemini     maxOutputTokens 4096              maxOutputTokens 32768, thinkingLevel "medium"
```

Frozen as `GENERATION_ENVELOPES` in
[`structural-review-protocol/structural-review-runner.mjs`](structural-review-protocol/structural-review-runner.mjs),
looked up by **provider**, not by R1/R2/R3 role label — R3's role is always
`R3`, but its provider is whichever `CBRP-D3-v1` selected, so it receives
whichever envelope that provider's role would have gotten.

### 18.1 Why: the mechanical Claude-ceiling audit and the observed Gemini failure

`[FACT]` **ROUND_0's actual stop was a Gemini R2 truncation, not a Claude one.**
`V21-B01-S00-EI-02-R2`'s raw response shows `finishReason: "MAX_TOKENS"` with
`thoughtsTokenCount: 3934` against a total `candidatesTokenCount: 158` — nearly
the entire token budget was consumed by hidden reasoning before any visible
output, truncating the JSON mid-string.

`[FACT]` **Mechanical, descriptive-only audit of all 40 preserved ROUND_0 Claude
R1 raw responses** (`structural-review-round-0/raw/*-R1.response.json`) — no
reviewer judgement inspected, only provider-reported termination and token
counts:

```
Claude R1 responses found         40
stop_reason distribution          { "end_turn": 40 }
max observed output_tokens        752
max observed thinking_tokens      483
count with stop_reason=max_tokens 0
```

`[DECISION]` Per the frozen rule this audit exists to enforce: **zero** Claude R1
responses hit `max_tokens`, so Claude's ceiling is **preserved at 4096, not
raised for symmetry** with Gemini's change. Raising it anyway would have been an
unforced, unevidenced change to a value nothing observed requires — exactly the
kind of amendment this protocol's own discipline (§0, §15) exists to refuse.

### 18.2 SDK capability check — no dependency change required

`[FACT]` The installed `@google/generative-ai@0.24.1` performs no client-side
allow-listing of `generationConfig`: `GenerativeModel` stores whatever object it
is given (`this.generationConfig = modelParams.generationConfig || {}`) and the
request builder serializes the whole params object verbatim
(`JSON.stringify(params)`) with no field-by-field validation. An extra
`thinkingConfig` key therefore reaches the transport layer unmodified — the SDK
does not need to know the field exists to carry it. This closes the packet's
required check without a live provider call or availability probe: **no SDK
upgrade or replacement was needed.**

`[DESIGN]` This confirms the SDK will **transmit** the field faithfully; it
does not confirm the live API's exact accepted shape for `thinkingLevel` (a
qualitative level, distinct from a numeric thinking-budget parameter) since
confirming that would itself require a live call, which this packet's mode
(OFFLINE ENGINEERING) forbids. `createRealProviderTransport` sends it as
`generationConfig.thinkingConfig.thinkingLevel` — the naming convention already
established for Gemini's other structured generation-config fields — and omits
the key entirely (not merely `null`) whenever a round's envelope has no
`thinkingLevel`, so ROUND_0's historical request shape is exactly reproduced,
never approximated.

### 18.3 MAX_TOKENS fail-closed rule (applies to every round, not just ROUND_1)

`[ARCHITECTURE-DECIDED]` Immediately after raw provider evidence is durably
persisted, and before the provider/model pin check or any extraction:

```
if the provider's reported termination indicates MAX_TOKENS (Gemini finishReason
   "MAX_TOKENS", or Claude stop_reason "max_tokens", case-insensitive):
       STOP  (outcome STOP_MAX_TOKENS_TRUNCATED)
       do NOT extract, do NOT schema-admit, do NOT retry, do NOT continue later sessions
```

`[DECISION]` **This fires regardless of whether the truncated visible text
happens to parse as syntactically valid JSON.** ROUND_0's actual failure was
lucky in one narrow sense — the truncation broke mid-string and so also broke
JSON syntax, which is what let the pre-existing extractor's ordinary MALFORMED
path catch it. A truncation that happened to land exactly on a JSON boundary
would have produced a schema-valid-looking review built from an incomplete
reasoning process, and admitted it as if it were a complete judgement. This rule
removes that coincidence from the safety property: termination-signal fail-
closed, not JSON-validity fail-closed.

### 18.4 Round-scoped artifact namespace

`[ARCHITECTURE-DECIDED]` `ROUND_ARTIFACT_DIR_NAMES` maps `ROUND_0 →
structural-review-round-0/` (real, immutable) and `ROUND_1 →
structural-review-round-1/` (reserved, per §14 — **not created by this
amendment**). `dispatchStructuralReviewLive` requires an explicit `roundId` with
no default; a live entrypoint silently assuming a round is exactly the implicit
behavior this amendment exists to eliminate. `runInitialStructuralReviewStage`
and `runR3StructuralReviewStage` default `roundId` to `'ROUND_0'` only for
backward compatibility with call sites (all pre-existing tests) that predate
round-awareness and never intended to select anything else.

### 18.5 Status

```
CBRP-STRUCTURAL-REVIEW-EXECUTION-AMENDMENT-1   OFFLINE VERIFIED, NOT EXECUTED
ROUND_1 real sessions                           0
ROUND_1 real artifact namespace                 NOT CREATED
provider calls (this amendment)                 0
```

`EXECUTION AUTHORIZATION: GRANTED` for CWP-11B covers offline engineering only.
Starting ROUND_1 LIVE requires a separate future GPT packet.
