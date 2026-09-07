# CBRP Authoring Protocol v2 — FROZEN METHODOLOGY

```
PROTOCOL:          CBRP-AUTHORING-PROTOCOL-2   +  2.1 extraction amendment
EXTRACTOR:         CBRP-AUTHOR-EXTRACTOR-2.1
BRIEF:             CBRP-AUTHORING-BRIEF-2  (UNCHANGED by 2.1)
BRIEF SHA-256:     a9da93fd5d4dd059c0faebdf3e29713abe2035191af5aac26a5b73eb17842336
BRIEF BYTES:       8114

STATUS:  CBRP-AUTHORING-V2-ROUND-0 (Protocol 2) INCOMPLETE / CLOSED, 2 calls, 12 candidates
         Protocol 2.1 extractor METHODOLOGY FROZEN ｜ NOT EXECUTED ｜ NOT AUTHORIZED
RUNS UNDER 2.1: 0 ｜ TASKS AUTHORED UNDER 2.1: 0 ｜ REVIEWS 0 ｜ CHIEF CALLS 0
```

> Prospective amendment motivated by **M-CBRP-AUTH-01**. It does not modify, rehabilitate
> or reinterpret Authoring v1, and no v1 candidate is carried forward.

---

## 1. What v1 got wrong

`CBRP-AUTHORING-PROTOCOL-1` ran once, produced sixty candidates, and was adjudicated a
**failed acquisition**: `FORBIDDEN_LITERAL_STOP`. Its brief §2.7 banned the literal word
*specialist*; two scenarios used it for a hospital rota and a hiring line, and the frozen
STOP envelope made that fatal to the whole run.

```
[FACT]       the prohibition caught ordinary task-world vocabulary
[INFERENCE]  lexical occurrence and answer-production steering are different concepts
[DECISION]   v1 remains failed as written; this correction is prospective only
```

`[DESIGN]` The defect was **duplication, not omission**. v1's brief §2.5 already stated the
rule semantically — *do not try to make scenarios that need several kinds of expertise*.
§2.7 then restated it as a word ban. Two rules, one intent, and only one of them was right.
v2 deletes the lexical restatement and keeps the semantic rule.

`[FACT]` The same conflation was independently present in the **structural review rubric**,
which read *"It fails on 'specialist', 'expert panel', …"*. Correcting only the brief would
have moved the failure from the authoring gate to the review gate without changing the
outcome. Both are corrected in this amendment.

---

## 2. The frozen distinction

```
ALLOWED    describing the scenario's world
           a person, role, fact or constraint that exists inside the situation

FORBIDDEN  ANSWER-PRODUCTION STEERING
           instructing, requesting, encouraging or meaningfully implying that the
           advisor should produce the answer using multiple specialists, multiple
           experts, an expert panel, several perspectives, multiple agents, different
           professional roles, a debate between experts, or multiple kinds of
           expertise — or equivalent wording
```

**The rule concerns how the answer should be produced.** It prohibits no occupation and no
domain vocabulary. `specialist`, `expert`, `specialist physician`, `technical specialist`
and `expert witness` are ordinary English and may appear freely as description.

### 2.1 The operational test

> Delete the sentence. If the **situation** lost a fact, it belongs. If only the
> **instructions to the advisor** changed, it is steering.

All examples below and in the brief are permanently
`ILLUSTRATIVE ONLY — NOT ELIGIBLE FOR CBRP`.

```
ALLOWED    The two sites still run overlapping specialist rotas.
           An expert witness has already filed a report.
           Our compliance committee meets fortnightly.

FORBIDDEN  Consult several specialists before answering.
           Give me finance, operations and brand perspectives.
           Have an expert panel debate the options.
           This needs multiple kinds of expertise.
           Use several agents to analyze this.
```

`[DESIGN]` The allowed examples are written fresh for v2. Two phrasings that would
otherwise have been natural here are verbatim fragments of the v1 trigger candidates, and
putting v1 output in front of a v2 author is barred regardless of how short the fragment is.

### 2.2 What the author is told, and what they are not

The author-facing rule is one sentence: **do not tell the advisor how many people, experts,
perspectives or roles should be involved in answering.**

It is stated without revealing any of:

```
Chief ｜ specialist assignment count ｜ the formal Census event
F1 / F2 ｜ theta ｜ P03 ｜ that the study measures collaboration at all
```

An author who knew the rule's purpose could satisfy it and still write toward it.

---

## 3. Authoring-stage STOP conditions — MECHANICAL AND TRANSPORT ONLY

`[ARCHITECTURE-DECIDED]` An authoring **run** stops only for faults that make the evidence
unusable as evidence:

```
required exact model unavailable
requested / resolved pin mismatch, where resolved identity is observable
provider or transport failure
authoring prompt byte mismatch
non-fresh context detected
malformed response
deterministic extraction failure
wrong number of scenarios
invalid stratum labels
wrong per-stratum count
unexpected second provider attempt
evidence-preservation failure
```

### 3.1 Explicitly NOT authoring-run STOP conditions

```
contains a forbidden literal        semantic leakage
noSpecialistSteering                realism
selfContained                       stratum correctness beyond declared-label mechanics
```

`[DECISION]` **None of these can stop an authoring run**, and none may be added later
without a new protocol version. They are **semantic admission questions**, and a run-level
STOP answers them at the wrong granularity: it discards every scenario in a session — and
under v1's one-shot rule, every session in the run — because of a property of one scenario.

`[DESIGN]` The v1 failure is the worked example. Two scenarios out of sixty carried an
ordinary word; the entire acquisition was lost. The per-scenario gate that exists to catch
exactly that was never reached.

---

## 4. Semantic admission belongs to structural review

`[ARCHITECTURE-DECIDED]` The blinded per-task structural review owns every semantic
judgement, unchanged from the existing rubric:

```
stratumCorrect ｜ primaryOutputClear ｜ selfContained ｜ realistic
noExperimentLeakage ｜ noSpecialistSteering ｜ overallPass
```

A scenario that steers answer production **fails `noSpecialistSteering`**, is discarded, and
is replaced from a fresh replacement session in the same block — the ordinary pre-freeze
replacement path, with truthful session lineage.

### 4.1 `noSpecialistSteering`, restated for v2

```
FAILS      the text instructs, requests or meaningfully implies that the answer be
           produced using several experts, perspectives, roles, agents or kinds of
           expertise

PASSES     the text merely contains specialist / expert / consultant / panel /
           committee as description of the situation
```

`[DECISION]` **A word is not a violation.** The reviewer judges what the text asks the
advisor to do, not which nouns it uses.

---

## 5. Literal scans are descriptive audit evidence only

```
PERMITTED  recording literal / token hits as audit evidence
           helping a later auditor locate a passage

NOT        an authoring admission gate
           an automatic rejection rule
           a run-level STOP condition
```

`[ARCHITECTURE-DECIDED]` **A lexical hit alone has no protocol disposition.** It is an
observation, and observations do not decide membership.

### 5.1 Scanner output never reaches a reviewer

`[DECISION]` **FORBIDDEN:** sending a structural reviewer any scanner verdict — *"this
candidate contains a forbidden word"*, a flag, a highlight, or a hit count. Reviewers
receive only the preregistered review inputs, and nothing else.

A reviewer handed a flag is answering *"do you agree with the scanner?"*, which is an
easier and different question than the rubric's. Scanner evidence is preserved **outside**
the reviewer prompt, where a later auditor can read it and the reviewer cannot.

`[DESIGN]` The v1 scan is also the reason to distrust flags: its first pass reported six
hits, of which four were substring artifacts — `llm` inside *fulfillment*, `anthropic`
inside *philanthropic*. Handing those to a reviewer would have been false evidence.

---

## 6. Unchanged from v1

```
model pins           CBRP-SESSION-MODEL-PINS-1, no change
                     B01/B03/B05 claude / claude-sonnet-5
                     B02/B04     gemini / gemini-3.7-flash
                     review and audit pins unchanged
                     no aliases, no fallback, no substitution
author block design  5 blocks, 2 tasks per stratum per block, 60 candidates
                     every block spans all six strata
brief delivery       one frozen brief, byte-identical to every session
one-shot sessions    one logical call per initial session; no repair prompt
```

---

## 7. Namespaces — nothing collides with v1

`[ARCHITECTURE-DECIDED]`

```
run id            CBRP-AUTHORING-V2-ROUND-0
author blocks     AUTHOR2-B01 … AUTHOR2-B05
initial sessions  AUTHOR2-B01-S00 … AUTHOR2-B05-S00
replacements      AUTHOR2-B01-R01 …
candidate ids     V2-B01-S00-SC-01 …
```

`[DECISION]` v1's `AUTHOR-B01-S00` and `B01-S00-SC-01` already denote **historical v1
sessions and candidates** and are never reused. The two namespaces stay separable by
inspection, so no later reader can mistake a v2 record for a v1 one.

### 7.1 No carry-forward

```
v1 brief bytes      immutable, sha256 7f1f9ebe4dfde9402d838137a549859a630b60a93dce93a119b70bf9642d665f
v1 raw outputs      immutable
v1 60 candidates    immutable, barred from any pool, barred as v2 seed material
v1 verdict          immutable
```

A fresh v2 context receives the v2 brief and nothing else.

---

## 8. Status

```
M-CBRP-AUTH-01   CLOSED AT METHODOLOGY AMENDMENT LEVEL
                 v1 failure preserved ｜ v2 semantic distinction frozen
                 the v1 failure is NOT repaired, and is not describable as repaired

M-CBRP-AUTH-02   CLOSED AT METHODOLOGY AMENDMENT LEVEL — see §9
                 CBRP-AUTHORING-V2-ROUND-0 preserved exactly as it executed
                 the Protocol-2 STOP at B02 is NOT retroactively reopened

Authoring v1     FAILED-CLOSED, historical only
Authoring v2 (Protocol 2)     INCOMPLETE / CLOSED — stopped at B02 after 2 provider calls
Authoring v2.1 (Protocol 2.1) METHODOLOGY FROZEN, NOT EXECUTED
tasks admitted   0        study  NOT PREREGISTERED
```

`CBRP-AUTHORING-V2-ROUND-0` under Protocol 2 is **closed exactly as it executed**: B01
yielded 12 mechanically extractable provisional candidates; B02's response triggered the
frozen run-level STOP under the extractor rule in force at the time; B03-B05 were not
called. The 12 records remain unreviewed, not admissible, and are **not carried forward**
into any run under 2.1 — see §9.4. A renewed acquisition requires its own GPT Architecture
authorization under a new run identity (§9.3).

---

## 9. Protocol 2.1 — deterministic wrapper normalization amendment

`[ARCHITECTURE-DECIDED]` This is an **extraction/representation amendment only.** It
changes how much of an author response is recognized as markdown-fence wrapping around a
JSON array. It changes nothing about `CBRP-AUTHORING-BRIEF-2`, nothing about model pins,
nothing about author block design, and nothing semantic — the brief's paste-section bytes
and hash are unchanged, still `a9da93fd…`.

### 9.1 Method lesson — M-CBRP-AUTH-02

```
[FACT]      AUTHOR2-B02-S00 returned a syntactically complete JSON array followed only
            by an isolated Markdown closing-fence line — no opening fence, no prose.
[FACT]      Protocol 2's extractor recognized plain JSON and a COMPLETE outer fence
            (opening fence + array + closing fence), but did not recognize a complete
            array followed by a lone trailing fence with no matching opener.
[DECISION]  CWP-10B remains failed/incomplete exactly as executed. No retrospective
            extraction, no retroactive admission of B02, no reopening of that STOP.
```

`[DESIGN]` This is the same shape of error as M-CBRP-AUTH-01, one layer down: v1 conflated
a lexical property with a semantic one and failed a scenario for a word it merely
contained; Protocol 2's extractor conflated "not our recognized wrapper" with "malformed,"
when the response was in fact a syntactically complete array wearing an extra, harmless
trailing artifact. Both errors are corrected **prospectively, not retroactively** — that
consistency is the point, not a coincidence.

### 9.2 The three accepted representations

```
CASE A  PLAIN_JSON             trimmed(raw) is itself one JSON array, nothing else.
CASE B  COMPLETE_OUTER_FENCE   one opening fence line, one JSON array, one closing
                                fence line, and nothing else (unchanged from Protocol 2).
CASE C  ORPHAN_TRAILING_FENCE  one complete top-level JSON array starting at the first
                                non-whitespace byte, then a genuine line boundary,
                                then exactly one line whose RAW content is the bare
                                closing fence and nothing else.
```

Case C is recognized only when **all** of the following hold; failing any one produces
`STOP_MALFORMED_RESPONSE`, exactly as before:

```
1. the first non-whitespace character is `[`
2. a complete top-level JSON array can be determined without editing its bytes
3. the array itself parses successfully
4. after the array's closing `]`, remaining content is only whitespace, one
   Markdown closing-fence line, and more whitespace
5. that fence line is exactly three backticks with no language tag
6. there is no prefix prose
7. there is no suffix prose
8. there is no second fence
9. there is no second JSON value
```

`[DESIGN]` The reference implementation checks line **structure**, not a
whitespace-collapsed string. Everything after the array's matching closing bracket is
split on a real line boundary (LF, or CRLF as one boundary). Condition 4 requires that
boundary to exist at all — no boundary means any would-be fence sits on the array's own
line, which is same-line, not orphan. Condition 5 requires the array's own remaining
line to contain only horizontal whitespace. Every line after that must be either
whitespace-only — one mechanism serving both condition 6 (intervening blank lines) and
condition 12 (only whitespace after the fence) — or be **the** fence line, whose raw,
untrimmed content must equal the three-backtick string exactly; a leading or trailing
space or tab, a language tag (condition 5/11), or any other stray character fails that
equality outright. A second non-blank line — a second fence (condition 8/13), leftover
prose (condition 7/9/15), or a second JSON value (condition 14) — is rejected the
moment it is seen, because by then a fence line has already been claimed.

`[DECISION]` **CWP-10C-R correction.** The version of this check released with CWP-10C
compared `remainder.trim()` to the bare fence, which erases line structure and is too
permissive: it wrongly accepted a fence sharing the array's own line
(`` [...]``` ``, no line boundary at all) and a fence line carrying leading or trailing
horizontal whitespace, neither of which is "exactly one Markdown closing-fence LINE."
The per-line mechanism above replaces it. Protocol 2.1's specification — the three
representations, the nine-numbered Case C requirement, and every forbidden repair —
did not change; only the implementation's conformance to it did.

**Still forbidden, in every representation** — this is a wrapper-recognition amendment,
never a repair tool:

```
searching arbitrary prose for a JSON substring      removing explanatory text
repairing malformed JSON                            adding or removing commas
fixing quotes                                       closing missing brackets
guessing truncation                                 merging multiple JSON blocks
selecting one of several candidate arrays           removing arbitrary suffixes
semantic rewriting
```

### 9.2.1 Reference implementation

```
extractor         CBRP-AUTHOR-EXTRACTOR-2.1
module            experiments/m2b/census/extractor-2.1/cbrp-author-extractor.mjs
tests             experiments/m2b/census/extractor-2.1/test-extractor.mjs
                   32/32 synthetic parser-behavior tests passing
                   1/1 historical-evidence anti-contamination check passing, reported
                   separately — never counted among the parser-behavior fixtures
returns            representationDetected, normalizedJsonBytes, originalRawSha256,
                   normalizedJsonSha256 — at minimum, per this amendment's requirement
```

`[FACT]` Every **parser-behavior** fixture is synthetic; none is drawn from
`AUTHOR2-B02-S00`. The suite reports parser-behavior tests and the B02
anti-contamination check as two separate counts, precisely so that "all fixtures
synthetic" is a claim about the 32 tests that define parser behavior, and never a claim
that quietly folds in the one check that reads B02's bytes for a different purpose —
asserting this file does not embed them.

`[FACT]` Run once, offline, against the preserved historical evidence as an independent
**verification** step — not as a test fixture and not as an admission decision — the 2.1
extractor recognizes `AUTHOR2-B02-S00`'s raw bytes (sha256 `83f6283c…`, matching
`SESSIONS.json`'s recorded `rawResponseSha256`) as `ORPHAN_TRAILING_FENCE` and would
normalize it to a parseable 12-element array across all six strata. This is offered as
evidence that the amendment targets the actual defect, precisely worded as **evidence,
not disposition**: §9.4 governs what happens to that content, and this fact does not
change it.

### 9.3 New run identity — nothing collides with Protocol 2 or v1

```
[ARCHITECTURE-DECIDED]

run id            CBRP-AUTHORING-V2P1-ROUND-0
author blocks     AUTHOR21-B01 … AUTHOR21-B05
initial sessions  AUTHOR21-B01-S00 … AUTHOR21-B05-S00
replacements      AUTHOR21-B01-R01 …
candidate ids     V21-B01-S00-SC-01 …
```

`AUTHOR2-*` and `V2-*` already denote **CBRP-AUTHORING-V2-ROUND-0** under Protocol 2 and
are never reused. All three namespaces — v1, Protocol 2, Protocol 2.1 — stay separable by
inspection.

### 9.4 CWP-10B candidates are not carried forward

`[ARCHITECTURE-DECIDED]` **Zero candidates carry forward from `CBRP-AUTHORING-V2-ROUND-0`
into any run under Protocol 2.1** — including B01's twelve, which satisfied both the old
and the new extraction rule.

```
B01's 12 valid candidates   historical PARTIAL-ACQUISITION evidence only
B02 raw output              historical STOP evidence only
```

Neither may be used as: a future candidate, a replacement, a few-shot example, seed
material, a test fixture, or an authoring example.

`[DESIGN]` **This is a provenance choice, not a quality judgement.** B01's content was not
defective under either rule. But `CBRP-AUTHORING-V2-ROUND-0` was one sequential
acquisition governed by Protocol 2 end to end, and it terminated at its run-level STOP. A
renewed acquisition under Protocol 2.1 must be **homogeneous** — every one of its sixty
candidates produced under the same extraction rule, in the same run — so there is no
mixed-protocol pool whose manifest would have to explain which candidates were screened
by which version of the wrapper grammar. That is the identical reasoning CWP-9B applied to
v1: not carried forward because of a defect in the content, but because a clean
provenance boundary is worth more than reusing twelve already-valid records.

### 9.5 STOP conditions, unchanged except representation

Every other Protocol 2 STOP condition is unchanged:

```
provider / transport failure          pin mismatch
prompt-byte mismatch                  non-fresh context
JSON parse failure after permitted    wrong scenario count
    wrapper normalization
invalid declared labels               wrong per-stratum count
unexpected second provider attempt    evidence-preservation failure
```

`[DECISION]` **No semantic admission judgement moves into authoring.** Recognizing one
more wrapper shape is still a mechanical question about bytes; `noSpecialistSteering`,
realism, self-containment and stratum correctness beyond declared-label mechanics remain
exclusively structural review's, unchanged from §3 and §4.

### 9.6 Status

```
M-CBRP-AUTH-02              CLOSED AT METHODOLOGY AMENDMENT LEVEL
CBRP-AUTHORING-V2-ROUND-0   INCOMPLETE / CLOSED, 2 calls, 12 candidates, 0 carried forward
Protocol 2.1 extractor      FROZEN, IMPLEMENTATION VERIFIED AGAINST FROZEN GRAMMAR
                            32/32 synthetic parser-behavior tests, 1/1 anti-contamination
                            check, and — only as a descriptive check, never a fixture —
                            against historical B02 bytes
CBRP-AUTHORING-V2P1-ROUND-0 NOT AUTHORIZED, NOT RUN
```

No provider call was made to produce this section. Execution of
`CBRP-AUTHORING-V2P1-ROUND-0` requires a separate GPT Architecture authorization.
