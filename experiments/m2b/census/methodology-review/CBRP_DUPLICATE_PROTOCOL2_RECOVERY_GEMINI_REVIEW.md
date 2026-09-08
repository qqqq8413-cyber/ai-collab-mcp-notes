# CBRP Duplicate Audit Protocol-2 Recovery — Independent Methodology Review (ADVISORY EVIDENCE)

```
STATUS:            ADVISORY EVIDENCE ONLY — NOT A DECISION
DECISION OWNER:    GPT Architecture (unchanged)
SOURCE:            User-supplied independent review, submitted verbatim in CWP-12E
REVIEWING MODEL:   UNKNOWN / NOT REPO-VERIFIED
```

> This document is **advisory evidence**, not a specification and not a decision. It is
> preserved here verbatim, exactly as supplied by the user in the CWP-12E packet, as an
> independent methodology opinion on the DUP-R00 recovery question (Protocol-1 STOP on
> `STOP_PROVIDER_ERROR`, CWP-12D-2). GPT Architecture remains the sole decision owner; this
> review informed but does not substitute for the architecture decision recorded in
> `CBRP_CORPUS_DUPLICATE_AUDIT_PROTOCOL_2.md`. No claim is made here about which model
> produced this review — the reviewing model identifier was not independently mechanically
> verifiable from anything in this repository, so it is recorded as `UNKNOWN / NOT
> REPO-VERIFIED` rather than invented or assumed from the packet's own label of it as a
> "Gemini methodology review."

---

## Verbatim review

> The block below is reproduced exactly as received, byte-for-byte, with no editing,
> paraphrasing, or correction of its content.

```
RECOMMENDATION: C
CONFIDENCE: HIGH
RATIONALE: The critical factor in this incident is that the failure occurred client-side before any network bytes reached the provider, resulting in zero substantive model output. Because no pair judgments were generated, outcome-dependent researcher discretion (e.g., p-hacking or rejecting an undesirable model response) is impossible. However, the rigid "frozen attempt policy" of Protocol-1 explicitly forbids retries. Attempting to bypass this via naming conventions (Option B) compromises preregistration integrity by violating the letter of the frozen rule. Option C is the standard methodological mechanism for addressing unforeseen, non-substantive structural failures: it officially closes Protocol-1 as an unrecoverable infrastructure failure, immutably preserving its log, and requires the prospective preregistration of Protocol-2 to explicitly define handling for pre-transport, zero-output failures before execution resumes. This maintains an unbroken, transparent chain of methodological custody.
IS B A DISGUISED RETRY?: YES Appending "RECOVERY" to a new execution identity while operating under Protocol-1 is a semantic loophole. Since Protocol-1 explicitly states "retry forbidden," circumventing this with a new identity name within the same protocol constitutes an unacknowledged violation of the frozen rules.
IS C METHODOLOGICALLY ACCEPTABLE?: YES Because there was zero model exposure and zero data generated, amending the protocol does not introduce outcome bias. Freezing Protocol-2 makes the methodological adjustment explicit and prospective, properly separating an infrastructure configuration error from substantive model evaluation.
SHOULD ORIGINAL D2 RUN ALONE?: NO Executing D2 under the failed Protocol-1 while D1 executes under a newly patched identity or protocol fractures the symmetry of the paired execution environment. The experimental design demands cohort execution; running them under disparate protocol rules or timelines introduces unnecessary environmental divergence.
IF RECOVERY IS ALLOWED: Protocol-1 must be formally closed, with its immutable failure logs permanently archived as proof of zero model contact. Protocol-2 must be preregistered with a prospective, explicit definition for handling "zero-model-output infrastructure failures." Finally, both D1 and D2 must be executed fresh from scratch using new execution identities exclusively under Protocol-2.
REQUIRED LIMITATION STATEMENT: The study must disclose that the original preregistered execution (Protocol-1) encountered a terminal client-side SDK error prior to any model contact. Because the failure yielded zero output, the protocol was formally amended (Protocol-2) to explicitly permit infrastructure recovery for zero-byte transport failures, under which the final substantive audit was conducted.
FATAL OBJECTION: NONE
```

---

## How this was used

`CBRP_CORPUS_DUPLICATE_AUDIT_PROTOCOL_2.md` records the actual GPT architecture decision
(Option C) and its normative consequences. Where that document's wording tracks this
review's reasoning, it is because GPT's own decision independently agreed with it, not
because this review is itself binding. Where the two differ — for example, this review's
suggested "REQUIRED LIMITATION STATEMENT" wording differs slightly from the limitation
statement CWP-12E froze — Protocol-2's own frozen text is authoritative.
