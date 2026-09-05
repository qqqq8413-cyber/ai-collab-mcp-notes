# Test A Evaluation

**Final outcome:** PASS

**Original harness outcome:** false negative caused by a local Markdown-normalization check.

The live runtime path passed every execution-policy condition: `simple`, one successful Worker, `SUCCESS`, two logical model calls, `policy.synthesize=false`, the expected direct-delivery reason, `synthesisMs=0`, no retrieval metadata, and exact Worker/final-output equality.

Manual review of the preserved raw output confirms:

| Dimension | Result | Observation |
|---|---|---|
| Correctness | PASS | A = 50,400; B = 55,125; C = 48,090 |
| Language | PASS | Traditional Chinese |
| Explicit constraints | PASS | Applies 5% tax to all three inputs |
| Requested format | PASS | Gives an explicit ascending C, A, B list |
| User-facing readability | PASS | Complete and directly usable |

The answer is more verbose than necessary and ends with a mission-scope sentence. That is a presentation difference that future synthesis might remove, but it is not a material correctness, language, constraint, format, or readability failure under the rev.11 acceptance boundary.

The harness originally searched for label and amount as adjacent plain text after removing only whitespace and commas. Markdown emphasis and punctuation remained between them, so it marked a correct answer as false. `run-case.mjs` now normalizes those formatting characters. No live rerun and no runtime change were needed.
