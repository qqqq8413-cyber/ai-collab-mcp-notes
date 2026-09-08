# CBRP Corpus Duplicate Audit Protocol-2 — SPECIFICATION CLOSED

```
PROTOCOL:      CBRP-CORPUS-DUPLICATE-AUDIT-PROTOCOL-2
BASELINE:      CBRP-CORPUS-DUPLICATE-AUDIT-PROTOCOL-1  (frozen, historical, unmodified —
                CBRP_CORPUS_DUPLICATE_AUDIT_PROTOCOL_1.md)
D1/D2 PINS:    D1 claude/claude-opus-5, D2 gemini/gemini-3.8-flash        (unchanged)
D3 ROUTING:    CBRP-D3-v1                                                (unchanged)

STATUS:  SPECIFICATION CLOSED | IMPLEMENTATION NOT YET VERIFIED | LIVE NOT AUTHORIZED
PROTOCOL-2 AUDIT ROUNDS RUN:  0
PROTOCOL-2 PROVIDER CALLS:    0
SUBSTANTIVE DUPLICATE JUDGMENTS OBSERVED:  0
```

> This document closes the *specification* of Protocol-2 (CWP-12E). It is a **delta
> document**: Protocol-1 (`CBRP_CORPUS_DUPLICATE_AUDIT_PROTOCOL_1.md`) is Protocol-2's
> frozen methodological baseline, incorporated **by reference, verbatim, unmodified**.
> Every provision of Protocol-1 not explicitly listed as changed in §4 (Complete Delta
> List) below remains binding on Protocol-2 exactly as written. Protocol-1 itself is never
> edited, never re-pasted, and never forked into a second independently-editable copy — this
> document exists specifically so that never has to happen. No reference implementation
> (harness/tests) exists yet for Protocol-2 — that is separate, future engineering work and
> requires its own `EXECUTION AUTHORIZATION: GRANTED` packet. Protocol-2 has not run. This
> document does not preregister the overall CBRP study; it closes one instrument's recovery
> specification within it.

---

## 1. Why this document exists

Protocol-1's first real LIVE execution (`DUP-R00`, CWP-12D-2) consumed its D1
provider-transport attempt and then STOPped on `STOP_PROVIDER_ERROR` before any provider
response existed. Protocol-1's own frozen rule (§10: one attempt per session, transport
failure is a terminal STOP, retry is forbidden unconditionally) makes that DUP-R00
execution permanently closed as failed — not paused, not retriable, not resumable. See §2.

GPT Architecture's accepted recovery strategy is **Option C: a new protocol version**,
not a same-protocol renamed retry (Option B, rejected as a disguised retry) and not
running the historical unused D2 alone (rejected as breaking cohort symmetry — see §3,
§8). This document is that new protocol version's specification closure.

---

## 2. Protocol-1 DUP-R00 — historical closure (normative)

```
Protocol-1 DUP-R00:  FAILED CLOSED / TERMINAL EXECUTION
```

**Historical D1:**

```
sessionId               DUP-R00-D1
provider                claude
model                   claude-opus-5
attempt                 CONSUMED
result                  STOP_PROVIDER_ERROR
provider model output   NONE
raw model response      NONE
pair judgments          0
```

**Historical D2:**

```
sessionId    DUP-R00-D2
attempt      NOT ATTEMPTED
```

`[ARCHITECTURE-DECIDED]` **Protocol-1 D1 must never redispatch. Protocol-1 D2 must never
execute.** D2's never-attempted status is not an available attempt carried forward — it is
**abandoned together with the failed protocol execution it belonged to**. A future
execution of "D2" is not Protocol-1's D2 continuing; it is a Protocol-2 D2, a different
session under a different protocol, evaluated against the same corpus for the first time
under Protocol-2's own rules (§3, §8). Protocol-1's own D2 slot is permanently unfilled and
stays that way.

**Historical evidence:** `experiments/m2b/census/duplicate-audit-round-0/**` — preserved
exactly as CWP-12D-2 produced it (CWP-12D-2F). The directory name itself is part of the
historical record of a real `liveArtifactPaths()` off-by-one defect (repaired in
CWP-12D-2R for all *future* rounds) and is never renamed, moved, or normalized to
`duplicate-audit-round-00/`. This document does not modify that evidence and does not
modify `CBRP_CORPUS_DUPLICATE_AUDIT_PROTOCOL_1.md`.

---

## 3. Why Protocol-2 may start fresh — and what that claim does not include

`[DECISION]` A same-Protocol-1 session under a renamed execution identity is a **forbidden
retry** — Protocol-1's one-attempt rule does not have a naming-convention exception, and
disguising a retry as a new identity inside the same protocol would be an unacknowledged
rule violation, not a legitimate recovery.

A **Protocol-2** fresh execution, begun only after Protocol-1 was formally closed as failed
(§2), is a different thing: a prospective methodological version transition. Its
justification is limited and factual, not general:

```
substantive duplicate-audit model outputs observed, at any point, under Protocol-1:  0
pair judgments observed:                                                        0 / 1770
```

Because the D1 attempt that was consumed produced **zero** provider output — the failure
was a client-side SDK rejection before any network byte reached the provider — there is no
model response of any kind that a researcher could have seen, liked, disliked, or been
influenced by when specifying Protocol-2. Outcome-dependent discretion (choosing to retry
because an unfavorable answer came back, or because a favorable one didn't) is structurally
impossible when nothing came back at all.

`[DECISION]` **This does not mean the incident carries no methodological limitation.** It
means only that *outcome-selection* is not among the limitations — see the required
disclosure in §9. A real infrastructure failure still occurred, a real attempt was still
consumed, and that is disclosed, not concealed.

---

## 4. Complete Delta List — every permitted change from Protocol-1

`[ARCHITECTURE-DECIDED]` This is the exhaustive list. **No semantic change to Protocol-1
not listed here is authorized.** Any Protocol-2 provision, or any future engineering
implementation of Protocol-2, that appears to require a change to Protocol-1 not listed
below is out of scope for Protocol-2 and requires its own GPT-reviewed packet.

```
1. Execution identities            §6 — new DUP-P2-R00-* session IDs, never
                                    DUP-R00-* (metadata only, never model-visible)
2. Round identifier                §6 — DUP-P2-R00 (Protocol-2's Round 0), distinct
                                    from Protocol-1's DUP-R00
3. Artifact evidence namespace     §7 — duplicate-audit-p2-round-00/, distinct from
                                    both duplicate-audit-round-0/ (historical,
                                    immutable) and duplicate-audit-round-00/
                                    (Protocol-1's never-reached intended namespace)
4. Attempt/failure boundary        §8 — Protocol-1 §10 ("one attempt, retry
   made explicit                   forbidden") restated with an explicit,
                                    operationally precise consumed/not-consumed
                                    boundary; no change to the underlying
                                    one-attempt rule itself
5. Historical closure record       §2 — new normative record of Protocol-1 DUP-R00's
                                    terminal status; does not exist in Protocol-1
                                    itself, which predates its own failure
6. Required limitation statement   §9 — new required disclosure text specific to
                                    this recovery
```

Everything else — the corpus, the duplicate definition, every model-visible byte, every
provider/model pin, every deterministic ordering rule, the decision matrix, D3 routing and
sequencing, retention, replacement semantics, round sequencing, and termination — is
**Protocol-1, unmodified, incorporated by reference**. See §5.

---

## 5. Substantive invariants — retained unchanged from Protocol-1 (incorporated by reference)

`[ARCHITECTURE-DECIDED]` Protocol-2 makes **no substantive duplicate-audit rule change**.
Every item below is Protocol-1's own text, unmodified, and this document does not restate
it as a second source of truth — only names the governing section:

```
canonical 60-task population                    Protocol-1 §14 / CWP-12C corpus binding
candidate IDs, task texts, task hashes           Protocol-1 §5, §13
audit scope (Round 0 = all 60)                   Protocol-1 §2.1, §5.1
1770 unordered pair universe, pair ordering      Protocol-1 §5, §5.1
Layer A — common duplicate definition            Protocol-1 §4.1, §6 (frozen text, verbatim)
D1/D2 model-visible prompt construction          Protocol-1 §7, §7.5 (frozen text, verbatim)
D3 model-visible prompt construction             Protocol-1 §8, §8.5 (frozen text, verbatim)
JSON-only extraction (no fence tolerance)         duplicate-audit-extractor-v1.mjs (CWP-12B-R)
D1 provider/model: claude / claude-opus-5        Protocol-1 §9
D2 provider/model: gemini / gemini-3.8-flash     Protocol-1 §9
D3 routing: CBRP-D3-v1                           Protocol-1 §8.2, CBRP_MODEL_PINS_PREREG_DRAFT.md §7.2
generation envelope (Claude 32768/null/null,     DUP_R00_GENERATION_ENVELOPES,
  Gemini 32768/medium/null)                      CBRP_CORPUS_DUPLICATE_AUDIT_PROTOCOL_1.md §9 lineage
decision matrix (D1=D2 agree / D1≠D2 → D3)       Protocol-1 §7.3
D3 sequencing and route-manifest durability      Protocol-1 §8.4
raw-first persistence, one-attempt reservations  Protocol-1 §10, §13
retention rule (incumbency wins)                  Protocol-1 §11
replacement semantics                             Protocol-1 §3, CBRP_REPLACEMENT_PROTOCOL_1.md
old–old pair exclusion                            Protocol-1 §2.2, §2.4
round sequencing (a round may not begin until     Protocol-1 §2.5
  the previous round is complete)
termination semantics (no rubric weakening,       Protocol-1 §12
  STOP-return-to-GPT if a round cannot close)
```

`[DECISION]` **Protocol version, execution identity, and recovery history are harness and
evidence metadata only.** They are never part of the model-visible D1/D2 or D3 prompt, and
this document adds nothing to Protocol-1's existing §4.2/§4.3 "must NOT receive" lists
except making explicit that those lists already cover this incident's specifics: an
auditor under Protocol-2 must never be shown that Protocol-1 failed, what the recovery
history is, which provider failed, any attempt-consumption status, that a "research event"
occurred, θ, the P03 outcome, the Chief outcome, or an expected duplicate result — exactly
as Protocol-1 §4.2/§4.3 already require for prior-round findings, outcomes, and everything
else on those lists.

The D1/D2 and D3 wrapper **construction algorithms and their version identifiers**
(`CBRP-DUPLICATE-AUDIT-D1D2-WRAPPER-1`, `CBRP-DUPLICATE-AUDIT-D3-WRAPPER-1`, Protocol-1
§7.5/§8.5) are unchanged and are **not** reversioned under Protocol-2 — reversioning a
byte-identical algorithm would be a spurious identity change with no functional referent,
and would falsely suggest the wrapper text itself differs between protocols when it does
not.

---

## 6. New execution identities

`[ARCHITECTURE-DECIDED]` Protocol-2 Round 0's round identifier is `DUP-P2-R00`, giving
session identities by the same `${roundId}-${role}` convention Protocol-1 §8.3 already
uses:

```
DUP-P2-R00-D1
DUP-P2-R00-D2
DUP-P2-R00-D3-<a>__<b>      a, b in canonical lexicographic order (Protocol-1 §5)
```

These identities are **metadata only** — harness/evidence bookkeeping, never model-visible,
exactly as Protocol-1 §4.2/§4.3 already require of `DUP-R00-*` identities. Reusing
`DUP-R00-D1` or `DUP-R00-D2` for any future session is forbidden (§2): those identities
belong to Protocol-1's closed, terminal execution and must never be reassigned.

---

## 7. Protocol-2 artifact namespace

```
experiments/m2b/census/duplicate-audit-p2-round-00/       Protocol-2 Round 0 LIVE evidence
experiments/m2b/census/duplicate-audit-p2-round-01/        Protocol-2 Round 1, if ever needed
experiments/m2b/census/duplicate-audit-p2-round-02/        ...
```

subject to the same round-sequencing precondition (§5: Protocol-1 §2.5) and to future
replacement/execution authorization exactly as Protocol-1 rounds are.

`[ARCHITECTURE-DECIDED]` Forbidden namespaces for any Protocol-2 evidence:

```
duplicate-audit-round-0/     immutable historical Protocol-1 DUP-R00 failure evidence
                              (CWP-12D-2F) — never written to again, by any protocol
duplicate-audit-round-00/     Protocol-1's permanently unused / retired intended
                              namespace — Protocol-1 DUP-R00 is FAILED CLOSED /
                              TERMINAL (§2) and is never resumed, so this namespace
                              is never used by Protocol-1 after terminal closure,
                              never used by Protocol-2, and never used by any future
                              recovery protocol
```

A future Protocol-2 reference implementation must derive `duplicate-audit-p2-round-NN/`
from a Protocol-2-scoped round-ID pattern independent of Protocol-1's own
`ROUND_ID_PATTERN`/`liveArtifactPaths()` (`duplicate-audit-live-harness-v1.mjs`, frozen and
unmodified by this document) — that is future engineering work, not part of this
specification closure, exactly as Protocol-1 §7.5/§8.5 note for their own reference
implementations.

---

## 8. Attempt / failure policy (explicit boundary)

`[ARCHITECTURE-DECIDED]` Protocol-1 §10's rule is unchanged: **one provider-transport
attempt per required session, no retry, no fallback, no provider substitution, no model
substitution, no prompt mutation, no response repair, no semantic salvage.** Protocol-2
does not create an internal "retry zero-output failures" mechanism. What follows makes
operationally precise a boundary Protocol-1 left implicit — where exactly "one attempt" is
consumed — using the actual, observed distinction between CWP-12D (STOP before any
reservation existed) and CWP-12D-2 (STOP after transport was invoked).

### 8.1 Pre-dispatch failure — attempt NOT consumed

If execution STOPs **before** (a) any durable attempt-reservation exists for that session,
**and** (b) provider transport is invoked, and the harness can mechanically establish that
no provider-transport attempt occurred:

```
the session's attempt is NOT consumed
```

Offline infrastructure repair may occur. The same session may execute later, but only
after a new, explicit GPT LIVE authorization — never automatically, never as a silent
retry inside the same authorization. This is the same class of failure as the historical
CWP-12D credential-bootstrap STOP (`STOP_CREDENTIAL_MISSING`, fired before any reservation
or provider dispatch).

### 8.2 Reserved / ambiguous state — treated as consumed, fail closed

If a durable attempt-reservation exists for a session but whether provider transport was
invoked cannot be mechanically ruled out (for example: a process crash between reservation
and a confirmed transport outcome), the attempt is treated as **consumed / ambiguous** and
the run fails closed.

`[ARCHITECTURE-DECIDED]` **Never infer "probably unused."** Ambiguity resolves toward
treating the attempt as spent, not toward treating it as available.

### 8.3 Transport invoked — attempt consumed, terminal

Once provider transport is invoked for a session, **the attempt is consumed**, and this
remains true even when:

```
the SDK rejects the request locally (client-side, before any network byte is sent)
zero provider output is returned
zero raw model output exists
the network request is later shown not to have reached the provider at all
```

This is exactly what happened to `DUP-R00-D1` under Protocol-1 (§2) and is why it is
CONSUMED, not available, despite zero bytes reaching Anthropic.

A transport failure after this boundary is **terminal for that specific execution**. No
same-protocol recovery identity may be created for that session, and no same-protocol
redispatch is permitted. Any future recovery proposal for a session that reached this
boundary requires: STOP, return to GPT, and a **new protocol-version architecture
decision** — the same kind of decision this document itself is (Protocol-1 → Protocol-2).
Naming that possibility (for example, "Protocol-3") is not preregistering or authorizing
it; no such future protocol is preregistered or authorized by this document.

---

## 9. D1/D2 symmetry

`[ARCHITECTURE-DECIDED]` Protocol-2 starts **both** auditors fresh, for the same reason
Protocol-1 §8.3 requires fresh contexts per round: a reused context or an asymmetric pairing
would not be the frozen paired-execution design.

```
DUP-P2-R00-D1     fresh stateless context, Protocol-2 execution identity
DUP-P2-R00-D2     fresh stateless context, Protocol-2 execution identity
```

Forbidden:

```
combining Protocol-2 D1 with Protocol-1's unused D2         — D2 was abandoned with
                                                                Protocol-1 (§2)
running Protocol-1's unused D2 alone, under any protocol     — it has no valid pairing
```

Both auditors receive: the same frozen corpus (§5), the same frozen D1/D2 model-visible
prompt (§5, §10), fresh stateless context, Protocol-2 execution identities (§6), and the
Protocol-2 evidence namespace (§7). Provider/model pins remain their original respective
pins (§5: claude/claude-opus-5 for D1, gemini/gemini-3.8-flash for D2) — Protocol-2 does
not reassign which provider plays which role.

---

## 10. Model-visible byte identity

`[ARCHITECTURE-DECIDED]` Protocol-2 D1 and D2 must receive **exactly** the same
model-visible bytes Protocol-1 froze. Because Protocol-1 §7.5/§8.5's construction
algorithm takes only the frozen text blocks and `corpusTasks`/`auditScopeIds` as inputs —
never `roundId`, never session identity, never protocol version — and Protocol-2 binds to
the identical canonical 60-task corpus (§5), the resulting prompt bytes are **identical by
construction**, not merely required to match:

```
D1/D2 prompt bytes         77147
D1/D2 prompt SHA-256       40fc7509387777c010fee9016280b9f9e0120ee5276691540128bc68af725e2d
Layer A bytes               639
Layer A SHA-256             57ca27ecf339ad4d5d5e1f45d3361a90a2ca1accf8a6e1433f55c831f613a05d
```

A future Protocol-2 reference implementation that reuses Protocol-1's own
`buildD1D2Prompt`/`buildD3Prompt` (`duplicate-audit-prompt-v1.mjs`, unmodified) against the
same canonical corpus (`duplicate-audit-corpus-binding-v1.mjs`, unmodified) needs no new
code to satisfy this — it is a structural consequence of not introducing any
protocol/round/session value into those functions' inputs, which §5 and this section both
forbid.

---

## 11. Required limitation statement

`[ARCHITECTURE-DECIDED]` Any report, manuscript, or evidence summary describing the
duplicate audit must include a disclosure equivalent in meaning to:

> The original CBRP Duplicate Audit Protocol-1 DUP-R00 execution terminated on a
> client-side infrastructure error after its D1 provider-transport attempt had been
> consumed but before any provider/model response or substantive duplicate judgment was
> obtained. Protocol-1 was closed as failed. Before any duplicate-audit model judgment
> had been observed, Protocol-2 was prospectively frozen, retaining the same corpus,
> duplicate definition, model-visible prompts, provider/model assignments, generation
> envelopes, pair universe, adjudication rules and retention rules, while introducing new
> execution identities and an explicit attempt/failure boundary. The substantive audit
> was subsequently conducted, if executed, under Protocol-2.

Forbidden wordings — none of the following may be said, in any paraphrase:

```
"Protocol-1 was never attempted"
"D1 was unconsumed"
"Protocol-2 was part of the original preregistration"
"the infrastructure failure has no methodological relevance"
```

---

## 12. Status terminology

```
Protocol-1:
  SPECIFICATION CLOSED
  DUP-R00 EXECUTION FAILED CLOSED / TERMINAL
  SUPERSEDED FOR FUTURE DUPLICATE-AUDIT EXECUTION BY PROTOCOL-2
  HISTORICAL EVIDENCE IMMUTABLE

Protocol-2 (after CWP-12E):
  SPECIFICATION CLOSED
  IMPLEMENTATION NOT YET VERIFIED
  LIVE NOT AUTHORIZED
  0 PROTOCOL-2 AUDIT ROUNDS RUN
  0 PROTOCOL-2 PROVIDER CALLS
  0 SUBSTANTIVE DUPLICATE JUDGMENTS OBSERVED
```

The overall CBRP study is not preregistered by this or any prior duplicate-audit document.
Protocol-2 has not executed. There is exactly one active future-execution duplicate-audit
protocol: **CBRP-CORPUS-DUPLICATE-AUDIT-PROTOCOL-2**. Protocol-1 remains historical — its
specification stays authoritative for everything Protocol-2 incorporates by reference
(§5), but it is not itself an alternative active execution protocol going forward.

---

## 13. Evidence preserved, per round

Identical to Protocol-1 §13's list, incorporated by reference, with the round/session
identities and evidence paths drawn from §6/§7 of this document instead of Protocol-1's,
and with one addition: each round's evidence must record `protocolVersion:
"CBRP-CORPUS-DUPLICATE-AUDIT-PROTOCOL-2"` as harness/evidence metadata (never
model-visible, §5, §10) so a later reader can distinguish Protocol-2 evidence from
Protocol-1's without relying on the artifact namespace alone.

---

## 14. Status

```
PROTOCOL:          CBRP-CORPUS-DUPLICATE-AUDIT-PROTOCOL-2
BASELINE:          CBRP-CORPUS-DUPLICATE-AUDIT-PROTOCOL-1 (frozen, unmodified)
STATUS:            SPECIFICATION CLOSED | IMPLEMENTATION NOT YET VERIFIED |
                    LIVE NOT AUTHORIZED
PROTOCOL-2 AUDIT ROUNDS RUN:               0
PROTOCOL-2 PROVIDER CALLS:                 0
SUBSTANTIVE DUPLICATE JUDGMENTS OBSERVED:  0
```

Protocol-2 Round 0 input population is the same canonical 60-task population Protocol-1
§14 and CWP-12C's corpus binding define — the `CBRP-AUTHORING-V2P1-ROUND-0` candidates
that passed `CBRP-STRUCTURAL-REVIEW-PROTOCOL-1` ROUND_2 (R3_COMPLETE, 60/60 FINAL). No new
population is introduced by this document.

Protocol-2 has not been executed. 0 Protocol-2 duplicate-audit rounds have run, 0 pools are
frozen under Protocol-2, 0 Chief Census calls have been made. Auditor provider/model IDs
remain frozen exactly as Protocol-1 §9 and `CBRP_MODEL_PINS_PREREG_DRAFT.md` §4/§7.2
specify.

This document does not claim the overall CBRP study is preregistered. It does not
implement a Protocol-2 harness. It does not authorize Protocol-2 LIVE execution. It does
not authorize, preregister, or name any recovery mechanism beyond §8's explicit boundary.
