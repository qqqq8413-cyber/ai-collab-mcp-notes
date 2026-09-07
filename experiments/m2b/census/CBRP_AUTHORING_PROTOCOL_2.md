# CBRP Authoring Protocol v2 — FROZEN METHODOLOGY

```
PROTOCOL:        CBRP-AUTHORING-PROTOCOL-2
BRIEF:           CBRP-AUTHORING-BRIEF-2
BRIEF SHA-256:   a9da93fd5d4dd059c0faebdf3e29713abe2035191af5aac26a5b73eb17842336
BRIEF BYTES:     8114

STATUS:  METHODOLOGY FROZEN ｜ NOT EXECUTED ｜ NOT AUTHORIZED
RUNS 0 ｜ TASKS AUTHORED 0 ｜ REVIEWS 0 ｜ CHIEF CALLS 0
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

Authoring v1     FAILED-CLOSED, historical only
Authoring v2     METHODOLOGY FROZEN, NOT EXECUTED
tasks admitted   0        study  NOT PREREGISTERED
```

No v2 scenario exists. Execution requires a separate authorization for
`CBRP-AUTHORING-V2-ROUND-0`.
