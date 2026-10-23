# AUTO-P2-A2 Input Policy Resolution

## Decision and Finding

Human A2-D1 selects strict 4,096 total input tokens, not 200,000. This is a specification decision, not authority to execute. Result: **BLOCKED_NO_PROVIDER_GUARANTEE**. Runtime retains `INPUT_LIMIT_DECISION_REQUIRED`; the legacy code name now denotes a technical proof gap, not an unresolved Human choice.

No reliable pre-dispatch proof was found in the inspected public provider contracts. This is not a claim that such a mechanism is mathematically impossible. No authenticated API, count_tokens request, credential or model generation was used.

## Primary Sources

Public documents were retrieved on 2026-10-23; retrieval times and SHA-256 seals are in `regressions/auto-p2-a2/research-sources.json`. These document seals are not tokenizer or inference-backend attestations.

- [Token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting): describes a preflight estimate, possible differences from generation, and provider-added nonbillable tokens. It specifies no numerical maximum estimation error. Therefore no fixed safety margin follows from that contract.
- [Official legacy tokenizer](https://github.com/anthropics/anthropic-tokenizer-typescript): its stated applicability excludes accurate counting from Claude 3 onward. It is not a Haiku 4.5 proof mechanism.
- [Messages reference](https://platform.claude.com/docs/en/api/messages/create): `max_tokens` bounds generated output, not input. No caller-selectable 4,096 hard input cap was found in the inspected request fields. Returned usage arrives too late to prevent an oversized input.
- [Count reference](https://platform.claude.com/docs/en/api/messages/count_tokens): accepts model, messages and system inputs, but does not establish an immutable count-to-generation reservation or signed bound. A successful count would not override the guide's estimate disclaimer.
- [API versions](https://platform.claude.com/docs/en/api/versioning): parameter compatibility is not a tokenizer/hidden-overhead immutability guarantee. Code remains pinned to `2023-06-01`; the public reference currently displays `2026-10-21`. Account-specific compatibility is UNVERIFIED. No migration was made.
- [Pinned Haiku overview](https://platform.claude.com/docs/en/models/haiku-4-5/overview): documents the fixed model ID, 200K context and standard input/output pricing. Context capacity is not permission to relax A2-D1. Public availability is not account availability.

## What Must Be Counted

The actual request is generated once by `messageBody`: fixed system prompt; one user message whose canonical JSON includes the entire Goal and entire pinned README plus source SHA/path; fixed model, max_tokens, standard tier and disabled thinking. There are no tool definitions, attachments, caching, beta features or previous conversation. README instructions remain untrusted content.

Local facts can be exact: source bytes, Goal UTF-16 length, Goal UTF-8 bytes, system bytes, user-content bytes, full JSON wire bytes, and request/system hashes. These are not token counts. API metadata is included in the wire hash; it must not be asserted to tokenize exactly like plain text. Server role framing, normalization and hidden optimization tokens have no verified bound here. Exact token count, protocol overhead and proven token upper bound are explicitly null.

## Why a Byte Bound Is Not a Token Proof

The proposed inequality `T <= UTF8(content) + H` would require proof that every content token consumes at least one input byte after every provider transformation, plus a finite verified bound H for framing/special/provider tokens. The inspected contract provides neither prerequisite. A byte-BPE assumption, arbitrary multiplier, model-generated assertion or empirical handful of samples is insufficient. Even under that unverified assumption, a permitted 16KB README alone can exceed a 4,096-byte sufficient condition. No content was truncated or silently normalized to manufacture acceptance.

Unicode tests cover ASCII, Chinese, composed/decomposed accents, emoji/ZWJ, JSON escapes, special-token-looking text and unpaired surrogates. Valid scalars are preserved byte-for-byte through the content field; malformed surrogate strings are rejected. This verifies CHIEF serialization, not provider tokenization. Values 4,095/4,096/4,097 in test inputs are **untrusted count claims**, not measured boundary counts, and all remain blocked.

## Distinct Limits

| Item | Meaning | Current enforcement |
| --- | --- | --- |
| 4,096 input tokens | Human-selected hard total input cap | Cannot prove; refuse dispatch |
| Exact/estimated input count | Unknown; neither fabricated | null / NOT_MEASURED |
| 16,384 source bytes / 2,000 Goal UTF-16 units | Local content limits | Runtime byte/length/hash checks; no truncation |
| 131,072 wire bytes | Request transport bound | Runtime serialization check |
| 2,048 output tokens | Generation limit | API max_tokens and returned-usage validation |
| 200,000 token reservation | Existing model-context conservative cost basis | Not input-policy permission |
| US$0.210240 reserve | 200,000 x 1 + 2,048 x 5 microUSD | Existing durable budget; standard API cost only |
| US$1 single and total / one generation / 300 seconds | Existing outer safety limits | Runtime controls retained; production HOLD |

Actual usage/cost remains unknown until a separately authorized real response. Tax/invoice settlement and remote cancellation billing are not proven by local tests. Never refund or replay an uncertain request automatically.

## Required Resolution

Keep A2-D1 unchanged. Architect needs provider-backed bounded counting/error semantics or a verifiable model-specific tokenizer plus complete protocol/transformation bounds, bound to this exact request/model/API and revalidated before dispatch. Alternatively a provider-enforced input cap would need documented semantics and a separately reviewed implementation. Until such evidence exists, no legal Human permit can make the present implementation technically satisfy the strict input requirement. Do not ask Human to reselect a wider cap as an implementation shortcut.
