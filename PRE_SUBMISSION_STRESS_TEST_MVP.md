# Pre-Submission Stress Test — MVP (Slice 1)

## Product purpose

CHIEF is being reframed around one core promise:

> "Before you send this artifact, know which parts you cannot defend."

This is not multi-agent debate, model orchestration for its own sake, maximum
deliberation, or generic prompt improvement. The eventual product provides:

1. independent review context
2. evidence gating
3. adaptive review routing
4. semantic issue consolidation
5. auditable human decision records

Slice 1 implements only the domain/data architecture needed to run one
session end to end — intake, author context, findings, semantic issues,
human adjudication, revision actions, and a decision record — with **no live
model execution**. Everything is a pure, in-memory data transformation:
`createSession` → `freezeInput` → `addFinding` (repeated) →
`createSemanticIssue` (optional clustering) → `adjudicate` (repeated) →
`planRevisionAction` → `implementRevisionAction` / `rejectRevisionAction` →
`completeSession` → `generateDecisionRecord`.

Source: `src/stress-test/` (`types.ts`, `hash.ts`, `session.ts`,
`decision-record.ts`, `index.ts`). Tests: `test-stress-test-mvp.mjs`, wired
into `npm test`.

## Domain entities

- **AuthorContext** — `confirmedFacts[]`, `knownRisks[]`, `openQuestions[]`,
  `constraints[]`, each an array of `AuthorContextItem` (`id`, `text`,
  `sourceType`, `status`, `createdAt`). `sourceType` is `ARTIFACT` | `AUTHOR` |
  `EXTERNAL_SOURCE` — see provenance rules below. `status` is `CURRENT` |
  `RESOLVED` | `SUPERSEDED` — the item's own lifecycle (still standing /
  settled / replaced by a later item), not whether it is syntactically a
  question, and never an epistemic claim (no `VERIFIED`). `addAuthorContextItem`
  defaults new items to `CURRENT` and rejects any other value at runtime.
- **ReviewFinding** — one reviewer-produced observation: `id`,
  `reviewerRunId`, `type` (`CLAIM` | `ASSUMPTION` | `AMBIGUITY` |
  `EXECUTION_RISK`), `title`, `artifactLocation`, `evidenceState`,
  `whyMaterial`, `likelyRecipientChallenge`, `minimumBeforeSendAction`,
  optional `rawText`, `createdAt`. Carries no materiality field — see
  evidence-state rules below.
- **SemanticIssue** — `id`, `title`, `description`, `findingIds[]`,
  `evidenceState`, `status` (`OPEN` | `ADJUDICATED`). Groups occurrences of
  the same underlying vulnerability without merging or deleting them.
- **HumanAdjudication** — `id`, exactly one of `semanticIssueId` /
  `findingId`, `judgment` (`KNOWN_PRE_DISPATCH` | `NEW_NON_MATERIAL` |
  `NEW_MATERIAL` | `WRONG`), `actionChange` (`YES` | `NO`), `note`,
  `adjudicatedAt`.
- **RevisionAction** — `id`, `sourceRefs: RevisionSourceRef[]`, `description`,
  `targetLocation`, `status` (`PLANNED` | `IMPLEMENTED` | `REJECTED`),
  `createdAt`. A finding — even NEW_MATERIAL + actionChange=YES — does not
  automatically equal an artifact edit; this is the separately tracked fact
  of whether an edit actually happened. Each `RevisionSourceRef` is an
  explicit discriminated union — `{ kind: 'SEMANTIC_ISSUE', id }` or
  `{ kind: 'FINDING', id }` — never inferred from the shape of `id`.
  `planRevisionAction` validates every ref's `id` exists against the kind it
  claims and rejects any other `kind` outright.
- **StressTestSession** — the aggregate: `id`, `state`, `createdAt`,
  `artifactText`, `authorContext`, `frozenAt`, `artifactHash`,
  `authorContextHash`, and the `findings` / `semanticIssues` /
  `adjudications` / `revisionActions` maps (keyed by id).
- **DecisionRecord** — a pure projection over a completed (or in-progress)
  session; never mutates it. Answers: what was reviewed, what the author
  already knew, what remained open, what was raised, what was new, what was
  material, what was meant to change, what actually changed, what was
  rejected, and what evidence state supported each issue. Available as JSON
  (`generateDecisionRecord`) or Markdown (`renderDecisionRecordMarkdown`).
  `openQuestions` (the "remaining open" list) includes only `AuthorContext`
  `openQuestions` items whose `status` is `CURRENT` — `RESOLVED` and
  `SUPERSEDED` items stay in `authorContext` for provenance but are not
  reported as still outstanding. `authorKnownSummary.openQuestions` is a
  separate, unfiltered count of the whole category, matching the other
  `authorKnownSummary` fields.

## State transitions

```
DRAFT → INPUT_FROZEN → REVIEWED → ADJUDICATED → REVISION_PLANNED → COMPLETED
```

Each operation is gated to an explicit, operation-specific set of allowed
states — not merely "frozen or later" — so no operation can run in a state
where it would produce a nonsensical or unauditable result:

| Operation | Allowed states |
|---|---|
| `addAuthorContextItem` | `DRAFT` only |
| `freezeInput` | `DRAFT` only |
| `addFinding` | `INPUT_FROZEN`, `REVIEWED` |
| `createSemanticIssue` | `REVIEWED` only |
| `adjudicate` | `REVIEWED`, `ADJUDICATED` |
| `planRevisionAction` | `ADJUDICATED`, `REVISION_PLANNED` |
| `implementRevisionAction` | `REVISION_PLANNED` only |
| `rejectRevisionAction` | `REVISION_PLANNED` only |
| `completeSession` | `ADJUDICATED`, `REVISION_PLANNED` |

- `createSession` starts a session in `DRAFT`.
- `freezeInput` computes and stores `artifactHash` / `authorContextHash`,
  and moves to `INPUT_FROZEN`. It is not re-runnable (attempting to freeze
  an already-frozen session throws).
- `addFinding`'s first call advances `INPUT_FROZEN` → `REVIEWED`. It is
  refused once the session has moved past `REVIEWED` (i.e. once any
  adjudication has been recorded) — a finding added after adjudication
  began would not be reflected in any prior judgment.
- `createSemanticIssue` clusters existing `findingIds` (which must already
  exist) into a new issue while the session is `REVIEWED`; it does not
  change session state by itself.
- `adjudicate` requires exactly one of `semanticIssueId` / `findingId`; the
  first adjudication advances `REVIEWED` → `ADJUDICATED`. Adjudicating a
  semantic issue marks that issue `ADJUDICATED`; the underlying findings are
  left exactly as recorded. At most one `HumanAdjudication` may target a
  given semantic issue or finding — see "Duplicate adjudication" below.
- `planRevisionAction` requires every source ref's id to exist, and requires
  at least one referenced adjudication to carry `actionChange=YES` — see
  "Human change authorization" below. The first call advances
  `ADJUDICATED` → `REVISION_PLANNED`.
- `implementRevisionAction` / `rejectRevisionAction` resolve a `PLANNED`
  action and require the session itself to be `REVISION_PLANNED`;
  re-resolving an already-resolved action throws.
- `completeSession` requires `ADJUDICATED` or `REVISION_PLANNED`, and
  refuses if any revision action is still `PLANNED`.
- **`COMPLETED` is terminal.** No operation's allowed-state list includes
  `COMPLETED`, so nothing can append review/adjudication/revision data to,
  or otherwise reopen, a completed session. There is deliberately no
  uncomplete/reopen operation.

## Frozen-input runtime integrity

`freezeInput` storing `artifactHash` / `authorContextHash` only proves the
input matched the hash *at freeze time*. `StressTestSession` is a plain JS
object, so nothing at the type level stops a caller — including a caller
with no TypeScript checking at all — from mutating `session.artifactText`
or `session.authorContext` directly afterward while leaving the stored
hashes untouched. `verifyFrozenInputIntegrity(session)` closes that gap at
runtime: for any state past `DRAFT` it recomputes both hashes and throws if
either no longer matches what was stored at freeze time. It never
refreshes the stored hash and never silently accepts modified input — it
fails closed. Every post-freeze operation whose result feeds the audit
trail (`addFinding`, `createSemanticIssue`, `adjudicate`,
`planRevisionAction`, `implementRevisionAction`, `rejectRevisionAction`,
`completeSession`, `generateDecisionRecord`) calls it before doing anything
else. A caller who needs different input still creates a new
`StressTestSession` — this verifier detects tampering, it does not provide
a repair path.

## Human change authorization

A `ReviewFinding` or `SemanticIssue` existing — even one a reviewer marked
severe — never by itself authorizes an artifact edit. `planRevisionAction`
requires that at least one of its `sourceRefs` resolve (by `kind` and `id`
together) to a recorded `HumanAdjudication` with `actionChange=YES`;
otherwise it throws rather than planning the action. `judgment` is
deliberately not consulted for this gate — `NEW_MATERIAL` is an experiment
metric from the CASE-001-style pilot design, not this product's
authorization rule, and a human is allowed to choose to change something
already categorized `KNOWN_PRE_DISPATCH` or any other judgment. Other,
unauthorized `sourceRefs` may still be included on the same action for
provenance; only one of them needs `actionChange=YES`.

## Duplicate adjudication

Slice 1 has no decision-amendment or supersession model. `adjudicate`
therefore allows at most one `HumanAdjudication` per target: a second
`adjudicate` call naming the same `semanticIssueId` or the same `findingId`
throws rather than silently overwriting the first (no implicit
last-write-wins). A future slice may introduce explicit adjudication
supersession if a real need for amendment emerges; it is not implemented
here.

## Provenance rules

- An `AUTHOR`-sourced `AuthorContextItem` is the author's own claim about
  what they know. It is **never** treated as independently verified merely
  because it was recorded — only `ARTIFACT`-sourced items are backed by the
  submitted text itself, and `EXTERNAL_SOURCE` items carry their own separate
  provenance (not defined further in this slice).
- A `SemanticIssue`'s `findingIds` is provenance, not a merge. The original
  `ReviewFinding` records are never deleted or mutated once clustered — the
  session's `findings` map is append-only for this slice (no delete/edit
  operation is exposed).
- `HumanAdjudication` is a separate layer from reviewer output by
  construction: `ReviewFinding` has no field for it, and adjudicating a
  semantic issue only ever sets that issue's own `status`, never anything on
  the findings it clusters.
- A `RevisionAction`'s `sourceRefs` links back to whichever issue/finding ids
  motivated it, each tagged with an explicit `kind`, so a `DecisionRecord`
  can always trace an implemented change back to the judgment that
  authorized it without guessing what kind of id it is looking at.
  `generateDecisionRecord` matches a ref to a semantic issue or finding by
  `kind` **and** `id` together, never by `id` alone — the discriminator is
  meant to survive projection, not just storage, so it is not treated as
  redundant just because id collisions between a `SemanticIssue` and a
  `ReviewFinding` are practically improbable with random ids.
- `HumanAdjudication`'s `semanticIssueId?` / `findingId?` pair is already an
  unambiguous discriminated target (exactly one is ever set, and the caller
  names which by the field itself) — it was deliberately left as-is during
  the RevisionAction provenance hardening rather than redesigned to match.

## Evidence-state rules

- Evidence state is scoped to the supplied material only:
  `SUPPORTED_IN_MATERIAL`, `PARTIALLY_SUPPORTED`, `UNSUPPORTED_IN_MATERIAL`,
  `NOT_APPLICABLE`.
- `VERIFIED` / `TRUE` / `FALSE` / `DISPROVEN` are deliberately not evidence
  states in this model — a reviewer or model believing something is not the
  same as the artifact supporting it, and this architecture has no field in
  which to record "verified" at all.
- Evidence state lives on `ReviewFinding` (and, once clustered, on the
  `SemanticIssue` that summarizes its occurrences) — never on
  `AuthorContextItem`, which only ever carries `sourceType`/`status`.

## Immutability / freeze discipline

Every mutating function in `session.ts` checks session state before acting.
Once a session is frozen (`state !== 'DRAFT'`), `addAuthorContextItem` and
`freezeInput` itself both throw rather than silently applying a change — a
caller who needs different input creates a new session. Functions return a
new session value rather than mutating their argument in place, matching
existing repository conventions (immutable-style updates elsewhere in
`src/`) rather than introducing an unfreeze/versioning mechanism, which is
out of scope for this slice.

**Architecture decision (confirmed during Slice 1 hardening):** frozen
artifact input and frozen author context are immutable by design, not by
omission. No unfreeze API is desired at any point — changing frozen input
always requires a new `StressTestSession`. A future slice may add session
*lineage* metadata (e.g. `parentSessionId`, `supersedesSessionId`) so a new
session can declare which prior session it supersedes, but that lineage
mechanism is explicitly not implemented in this hardening step and must not
be inferred from the current schema.

## What this slice deliberately does NOT implement

- **Independent review acquisition and adaptive reviewer routing are
  downstream capabilities and are not implemented in Slice 1.**
- No live Claude/Gemini/OpenAI provider calls of any kind.
- No automated semantic clustering or embeddings — `createSemanticIssue`
  takes an explicit `findingIds` list; grouping is manual/test-authored in
  this slice.
- No persistence layer, database, or file-based session storage — sessions
  are plain in-memory values, matching the rest of `src/`, which has none
  either.
- No visual UI — the decision record is JSON and/or Markdown only.
- No unfreeze/versioning mechanism for frozen input — a new session is the
  only path to different input.
- No reviewer ranking, winner selection, or model comparison of any kind.
