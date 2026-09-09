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

## State transitions

```
DRAFT → INPUT_FROZEN → REVIEWED → ADJUDICATED → REVISION_PLANNED → COMPLETED
```

- `createSession` starts a session in `DRAFT`. Author-context items may only
  be added in `DRAFT` (`addAuthorContextItem`).
- `freezeInput` requires `DRAFT`, computes and stores `artifactHash` /
  `authorContextHash`, and moves to `INPUT_FROZEN`. It is not re-runnable
  (attempting to freeze an already-frozen session throws).
- `addFinding` requires the session to already be frozen (`INPUT_FROZEN` or
  later); the first finding advances the state to `REVIEWED`.
- `createSemanticIssue` clusters existing `findingIds` (which must already
  exist) into a new issue; it does not change session state by itself.
- `adjudicate` requires exactly one of `semanticIssueId` / `findingId`; the
  first adjudication advances `REVIEWED` → `ADJUDICATED`. Adjudicating a
  semantic issue marks that issue `ADJUDICATED`; the underlying findings are
  left exactly as recorded.
- `planRevisionAction` requires the target issue/finding ids to exist; the
  first one advances `ADJUDICATED` → `REVISION_PLANNED`.
- `implementRevisionAction` / `rejectRevisionAction` resolve a `PLANNED`
  action; re-resolving an already-resolved action throws.
- `completeSession` requires `ADJUDICATED` or `REVISION_PLANNED`, and
  refuses if any revision action is still `PLANNED`.

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
