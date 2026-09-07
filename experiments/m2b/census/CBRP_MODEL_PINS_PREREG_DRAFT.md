# CBRP Model Pins — PREREGISTERED — DRAFT

```
PIN VERSION:  CBRP-SESSION-MODEL-PINS-1
D3 ROUTING:   CBRP-D3-v1
STATUS:       FROZEN as a decision ｜ study NOT PREREGISTERED
SESSIONS RUN: authoring 7 total（v1 5 + v2 2）｜ structural review 0 ｜ duplicate audit 0
```

> **The canonical table.** Every exact provider/model string used to decide CBRP pool
> membership appears here and **nowhere else**. Other documents reference this file by
> version; none of them restate the strings, because a table copied into six documents is
> a table that will disagree with itself by the third edit.

---

## 1. Scope — pool membership only

```
GOVERNED BY THIS TABLE          NOT GOVERNED BY THIS TABLE
authoring sessions              the measured Chief planning call
structural review sessions      → openai / gpt-5, EXPECTED_PLANNING_PIN
duplicate audit sessions          in the census harness, untouched by this packet
structural / duplicate D3
```

`[DESIGN]` The separation matters. This table decides **who writes and screens the tasks**.
The census execution pin decides **what is measured**. Changing one has nothing to do with
the other, and a reader who conflated them would think the study measures five models.

---

## 2. Authoring — FROZEN

```
[ARCHITECTURE-DECIDED]

AUTHOR-B01    claude   claude-sonnet-5      CLAUDE_FAMILY
AUTHOR-B02    gemini   gemini-3.7-flash     GEMINI_FAMILY
AUTHOR-B03    claude   claude-sonnet-5      CLAUDE_FAMILY
AUTHOR-B04    gemini   gemini-3.7-flash     GEMINI_FAMILY
AUTHOR-B05    claude   claude-sonnet-5      CLAUDE_FAMILY
```

Three CLAUDE blocks and two GEMINI. Because each block × each stratum = 2 admitted tasks,
**every stratum receives 6 CLAUDE_FAMILY and 4 GEMINI_FAMILY tasks — the identical split in
all six.** Family is unbalanced overall and exactly orthogonal to stratum.

### 2.1 Replacement sessions inherit the block's model

```
AUTHOR-B01-R01  →  claude / claude-sonnet-5
AUTHOR-B02-R03  →  gemini / gemini-3.7-flash
```

`[DECISION]` **No replacement may change model to improve acceptance.** Model identity is a
property of the **block**, never of whether a prior candidate passed. A block whose first
candidate was rejected does not get a different author; if switching model on rejection
were allowed, the pool's model composition would be a function of which candidates failed,
and that is a screening outcome shaping the frame.

---

## 3. Structural review — FROZEN

```
[ARCHITECTURE-DECIDED]   every task, without exception

R1    claude   claude-opus-5      CLAUDE_FAMILY
R2    gemini   gemini-3.8-flash   GEMINI_FAMILY
```

R1 and R2 always run in **independent fresh contexts**, and neither sees the other's result.

---

## 4. Duplicate audit — FROZEN

```
[ARCHITECTURE-DECIDED]   every round, without exception

D1    claude   claude-opus-5      CLAUDE_FAMILY
D2    gemini   gemini-3.8-flash   GEMINI_FAMILY
```

Fresh context every round, and no round receives an earlier round's history — see
[`CBRP_CORPUS_DUPLICATE_AUDIT_DRAFT.md`](CBRP_CORPUS_DUPLICATE_AUDIT_DRAFT.md) §6.1.

---

## 5. The Chief model is excluded from all of it

```
[ARCHITECTURE-DECIDED]

openai / gpt-5  —  the measured Chief planning model  —  FORBIDDEN in:

authoring ｜ structural review ｜ structural tie-break
duplicate audit ｜ duplicate tie-break
```

Five roles, one rule: **a model under measurement does not decide the membership of the
pool it will later be measured on.** The Census execution pin is unchanged and is not part
of this table.

---

## 6. Author and reviewer never share an exact model

| family | authors | reviews / audits |
|---|---|---|
| CLAUDE_FAMILY | `claude-sonnet-5` | `claude-opus-5` |
| GEMINI_FAMILY | `gemini-3.7-flash` | `gemini-3.8-flash` |

```
no task is admitted by its own exact author model
every task receives one CLAUDE_FAMILY review AND one GEMINI_FAMILY review
```

`[DESIGN]` This reduces **direct exact-model self-screening** — the case where the model
that wrote a task is also the model that decides the task is good enough to keep. That
specific loop is closed.

`[DESIGN]` **It eliminates none of the following**, and no result may imply otherwise:

```
shared family priors ｜ vendor priors
correlated training data ｜ model dependence generally
```

`claude-opus-5` reviewing a `claude-sonnet-5` task is not an independent judge. It is a
different exact model, from the same vendor, with substantially overlapping priors about
what a well-formed business decision looks like. The claim available is *not self-review*,
and it stops there.

---

## 7. CBRP-D3-v1 — deterministic third-adjudicator routing

```
[ARCHITECTURE-DECIDED]   VERSION  CBRP-D3-v1

no discretionary model choice, in either adjudication type
```

Both selectors are `SHA256` over **exact UTF-8 bytes**, rendered as **lowercase
hexadecimal**, and both read the **first hexadecimal character** only. `\n` is a single
LF byte, `0x0A`. There is **no trailing newline** and no separator other than the ones
shown.

```
first hex character   0 1 2 3 4 5 6 7   →   claude   claude-opus-5
first hex character   8 9 a b c d e f   →   gemini   gemini-3.8-flash
```

### 7.1 Structural D3 — on an R1 / R2 disagreement

```
selectorInput = "CBRP-D3-v1\nSTRUCTURAL\n" + taskCandidateId
selector      = SHA256(selectorInput)          lowercase hex
```

Test vectors — **derivations, not adjudications**; no review has run:

```
CBRP-SC-01  080ff96618e0f5e8901fb46f98bc5b9d82893b793bc3cfb90e991c1a4ab9968b  0  claude-opus-5
CBRP-SC-02  fe54b57577e015534f294b46220a6cc994c932a7184689aa18c552ad6f6806ae  f  gemini-3.8-flash
CBRP-SC-03  07fe21dabe40e94e29401c9b27a950bc1a57362e045d725467ed27a980c7ec8e  0  claude-opus-5
CBRP-SC-04  476d8b37580f96a70e5ef6ade65a146f27bbcaa9bcb307ae372b2ead9230c2be  4  claude-opus-5
CBRP-SC-05  008f55df38284d3fa337fce199531f190fc6a270c75626c8327a8bed97ed4a2c  0  claude-opus-5
CBRP-SC-06  1b44fe1e942d45eb2c52dc43df0157b599931d7184f59d64cc0030a820d51c84  1  claude-opus-5
```

### 7.2 Duplicate D3 — on a D1 / D2 disagreement about one pair

```
a = the lexicographically SMALLER immutable candidate ID
b = the lexicographically LARGER  immutable candidate ID

selectorInput = "CBRP-D3-v1\nDUPLICATE\n" + a + "\n" + b
selector      = SHA256(selectorInput)          lowercase hex
```

`[DESIGN]` Sorting the pair is what makes the route a property of **the pair** rather than
of **who reported it first**. Test vectors, including the same pair supplied both ways:

```
(SC-01, FR-07)  a=CBRP-FR-07 b=CBRP-SC-01  f15d8549847f8176…  f  gemini-3.8-flash
(FR-07, SC-01)  a=CBRP-FR-07 b=CBRP-SC-01  f15d8549847f8176…  f  gemini-3.8-flash   ← identical
(BC-02, BC-09)  a=CBRP-BC-02 b=CBRP-BC-09  7864894ff1eac24b…  7  claude-opus-5
(EI-04, PS-10)  a=CBRP-EI-04 b=CBRP-PS-10  81fee043bc1245fc…  8  gemini-3.8-flash
```

`[ARCHITECTURE-DECIDED]` **No other routing rule exists.** Not by stratum, not by author
family, not by which reviewer dissented, not by operator preference.

### 7.3 Why the route is hashed rather than fixed

A fixed Claude D3 would give the Claude family a systematic possible third vote on every
disagreement; a fixed Gemini D3 would do the symmetric thing. Hashing:

```
removes human discretion at the one point where a tie is being broken
does not read the task content
does not read the author family
does not read either earlier reviewer's output
```

`[DESIGN]` **It does not guarantee a 50/50 realized D3 count, and no result may claim one.**
It gives each immutable adjudication key **one deterministic route**, nothing more. The
realized split depends on which keys actually reach D3, which depends on where the
reviewers disagreed. As an illustration of the size of that effect, over the sixty
canonical task IDs the structural selector routes **27 to Claude and 33 to Gemini**, and
over all 1770 canonical pairs the duplicate selector routes **911 / 859**. Those are the
splits *if every key went to D3*, which none will.

### 7.4 What D3 receives

`[ARCHITECTURE-DECIDED]` A **fresh model context**, and only the preregistered blinded
input for its adjudication type. It must not receive:

```
R1 / D1 output ｜ R2 / D2 output ｜ which reviewer flagged the issue
the fact that a disagreement occurred, beyond what is operationally unavoidable
Chief outputs ｜ the event definition ｜ theta ｜ P03
```

---

## 8. Availability — no substitution, ever

```
[ARCHITECTURE-DECIDED]   the exact strings above are frozen

FORBIDDEN:  latest / alias model names        automatic model upgrade
            fallback to another model         provider substitution
            same-family replacement           retrying under another model
```

```
if a required exact provider/model is unavailable when its session is due

    STOP
    preserve evidence
    return to GPT Architecture Review
```

`[DECISION]` **The study is not continued around an unavailable model.** A pool half
screened by one reviewer and half by its replacement is a pool with two standards in it,
and nothing in the artifact would record which half got which — the same reason a
post-freeze one-task patch is forbidden.

`[FACT]` Of the six strings frozen here, **`claude-sonnet-5` is the only one that appears
anywhere in this repository** (`src/config.ts`, `src/models/capabilities.ts`).
`claude-opus-5`, `gemini-3.7-flash` and `gemini-3.8-flash` have never been referenced by
this project and **have never been resolved against a live provider by it**. That is not an
objection to the pins — GPT Architecture owns the choice, and §8's STOP is exactly the
control for a string that turns out to be unavailable. It is recorded so that the first
availability failure is read as *the preregistered STOP firing*, not as a surprise.

---

## 9. What every session records

`[DRAFT]` Field set, `CBRP-SESSION-MODEL-PINS-1`:

```
modelPinVersion       CBRP-SESSION-MODEL-PINS-1
providerRequested     the pinned provider for that role
modelRequested        the pinned exact model for that role
providerResolved      if observable, else null
modelResolved         if observable, else null
modelFamily           CLAUDE_FAMILY | GEMINI_FAMILY
```

```
if resolved identity IS observable and differs from requested

    STOP
    the author / reviewer / auditor output is NOT admitted
    no retry under another model
```

`[DESIGN]` **`providerResolved` / `modelResolved` are frequently unobservable, and the
schema says so rather than pretending otherwise.** These sessions are blinded pastes into
fresh contexts; a chat surface generally does not report which exact build answered. Where
identity is not observable the fields are `null` and the pin is an **operator instruction**
backed by attestation, exactly like `freshContextConfirmed` — not an enforced constraint.
The mismatch STOP binds only where the identity can actually be seen. Any result that
described these pins as *verified* would be overclaiming.

---

## 10. Status

```
pins frozen as a decision
authoring sessions run   7   v1 5 FAILED CLOSED ｜ v2 2 INCOMPLETE at B02
tasks admitted           0
reviews 0 ｜ duplicate audit rounds 0 ｜ pools frozen 0 ｜ D3 adjudications 0
```

`[FACT]` The five v1 authoring sessions and the two attempted v2 authoring sessions ran
under these pins and **every one resolved to the model it requested** — Anthropic returned
`model`, Gemini returned `modelVersion`, and all seven matched exactly.
`claude-sonnet-5` and `gemini-3.7-flash` are therefore observed to exist and resolve;
`claude-opus-5` and `gemini-3.8-flash` have still never been called.

The v1 run failed for an unrelated prohibited-literal reason. The v2 run stopped for an
unrelated malformed B02 response after B01 and B02; B03-B05 were not called. Neither stop
was a pin mismatch. No structural reviewer or duplicate auditor has been called.
