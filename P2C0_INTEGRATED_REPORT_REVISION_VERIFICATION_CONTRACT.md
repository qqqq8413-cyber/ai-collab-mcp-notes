# P2-C0 — Integrated Report Revision Verification Authority Contract

STATUS:
CANDIDATE ARCHITECTURE CONTRACT — GPT ACCEPTANCE REQUIRED

IMPLEMENTATION AUTHORIZATION:
NONE

Repository: `qqqq8413-cyber/ai-collab-mcp-notes`
Mode: offline architecture analysis only. 0 provider/model calls made in the production of this document.
Branch: `product/pre-submission-stress-test-mvp`.

This document freezes the minimum authority/interface contract required for `generateIntegratedDecisionReport` (P1) to safely present `RevisionVerification` (P2-B) facts. **No runtime, type, or test in `src/**`/`test-*.mjs` is changed by this document.** Every recommendation below is a candidate for a future, separately-authorized P2-C runtime packet.

**Amendment 1 incorporated.** This revision resolves both blocking open decisions the original P2-C0 analysis left open (§19), freezes a machine-readable verification-state vocabulary and its display labels (§11 — freshly issued by GPT, not recovered historical wording, §12), corrects a provenance defect in the original document's own non-goals list (§17), and records one pre-existing, unrelated report gap as tracked debt (§19a) rather than solving it here.

**Amendment 2 incorporated.** Before any P2-C report may project `RevisionAction.sourceRefs` as trusted provenance, this revision freezes a new canonical `assertRevisionActionLedgerIntegrity(session)` validator (§3a) closing a confirmed ingress-aliasing defect in `planRevisionAction` and a gap where no validator globally checks `RevisionAction` provenance today. §7's integrity ordering is revised to compose this validator unconditionally. **P2-C runtime remains blocked until a separately-authorized RevisionAction Provenance Hardening runtime is independently accepted first** (§18a) — this amendment does not itself authorize or implement that hardening.

**Amendment 3 incorporated.** Closes the remaining upstream-authority gap: `RevisionAction` authorization (§3a.1 item J) rests on `session.adjudications`, which has write-time invariants (`adjudicate`) but no canonical later-read validator today. Freezes `assertHumanAdjudicationLedgerIntegrity(session)` (§3a.0), composed as the first step inside `assertRevisionActionLedgerIntegrity`, and strengthens the `SEMANTIC_ISSUE`/`FINDING` sourceRef checks to verify the resolved entity's own `id` field, not merely its map key. This remains part of the same, single RevisionAction Provenance Hardening runtime slice (§18a) — HumanAdjudication is not split into a separate milestone.

---

## 1. Current authority inventory

Confirmed by direct inspection of `src/stress-test/types.ts`, `src/stress-test/session.ts`, `src/stress-test/decision-record.ts`, `REVISION_VERIFICATION_CONTRACT.md`:

1. `StressTestSession` (unchanged by P2-A/P2-B) additionally carries, since those slices: `revisionSuccessor: RevisionSuccessorBinding | null` and `revisionVerifications: Record<string, RevisionVerification>`.
2. `RevisionSuccessorBinding` — the authoritative V0→V1 fact, six identity/hash fields, owned by the source session as a single nullable field (0..1).
3. `RevisionVerification` — `{id, revisionActionId, verdict, evidence, verifiedAt}`, human-confirmed, 0..1 per `RevisionAction`, keyed by its own `id` in `revisionVerifications`.
4. Canonical domain validators, both exported from `src/stress-test/session.ts`:
   - `assertRevisionSuccessorIntegrity(sourceSession, successorSession): void` (session.ts:503) — the sole authority for "is `successorSession` genuinely `sourceSession`'s bound V1."
   - `assertRevisionVerificationIntegrity(sourceSession, successorSession, revisionVerificationId): void` (session.ts:717) — begins by reusing the above, then validates the **entire** `revisionVerifications` ledger before resolving the one requested id.
   - `assertRevisionVerificationLedgerIntegrity(sourceSession): void` (session.ts:601) — **module-internal, not exported.** Contains the actual whole-ledger scan (map-key/id match, revisionActionId resolution, IMPLEMENTED status, legal verdict, non-empty/non-whitespace evidence, non-empty verifiedAt, no duplicate revisionActionId). Both public validators above call it; no other copy of this logic exists anywhere in the repository (confirmed by `grep`).
5. `RevisionAction.status === IMPLEMENTED` still means only "marked implemented" (unchanged, `decision-record.ts:399-401`, `labelForRevisionStatus`).
6. `generateIntegratedDecisionReport` currently has **no parameter of any kind for successor-session information** and performs **zero** RevisionVerification-aware logic.
7. **(Amendment 2.)** `planRevisionAction` (session.ts:355) stores `sourceRefs: [...input.sourceRefs]` — confirmed by direct inspection to be a **shallow array clone only**: each `RevisionSourceRef` element (`{kind, id}`) inside remains the same object reference as `input.sourceRefs[i]`. A caller mutating an original `RevisionSourceRef` object after `planRevisionAction` returns silently alters stored, authoritative provenance. No canonical validator today globally checks `RevisionAction.sourceRefs` provenance — `verifyFrozenInputIntegrity` protects only `artifactText`/`authorContext`, never `revisionActions`, and neither `assertRevisionSuccessorIntegrity` nor `assertRevisionVerificationLedgerIntegrity` inspects `sourceRefs` at all. See §3a.
8. **(Amendment 3.)** `HumanAdjudication` (`session.adjudications`, confirmed keyed by `record.id` at `session.ts:301`) is itself an authoritative ledger with write-time invariants enforced only by `adjudicate` (`session.ts:244-303`: exactly one of `semanticIssueId`/`findingId`, target existence by map key, at most one adjudication per exact target) — confirmed by direct inspection to have **no canonical later-read validator today**. Existence-by-map-key (`session.semanticIssues[ref.id]`/`session.findings[ref.id]`) does not itself prove the resolved record's own `id` field equals `ref.id`. Since `RevisionAction` authorization (`planRevisionAction`, session.ts:336-347, and its later-read counterpart in §3a.1 item J) ultimately depends on this ledger, `assertRevisionActionLedgerIntegrity` (§3a) was incomplete without an upstream check on it. See §3a.0.

---

## 2. Existing `IntegratedDecisionReport` interface

Exact current signature (`decision-record.ts:550-553`):

```ts
export function generateIntegratedDecisionReport(
  session: StressTestSession,
  deliberationState: DeliberationState
): IntegratedDecisionReport
```

`IntegratedDecisionReportRevisionAction` (`decision-record.ts:280-287`), exact current shape:

```ts
export interface IntegratedDecisionReportRevisionAction {
  id: string;
  description: string;
  targetLocation: string;
  status: RevisionActionStatus;
  statusLabel: string;
}
```

No field on this type, or anywhere else in `IntegratedDecisionReport`, references `RevisionSuccessorBinding` or `RevisionVerification`. `statusLabel` is produced by `labelForRevisionStatus` (`decision-record.ts:394-409`), a closed switch over `PLANNED | IMPLEMENTED | REJECTED` only — it has no fourth branch and is not the mechanism that would carry any verification-derived label.

`IntegratedDecisionReportIssue.revisionActions` (`decision-record.ts:343-354`, populated at `decision-record.ts:571-579`) is built **exclusively** by filtering `session.revisionActions` for entries whose `sourceRefs` contain a `{kind:'SEMANTIC_ISSUE', id: issue.id}` entry:

```ts
Object.values(session.revisionActions)
  .filter((action) => action.sourceRefs.some((ref) => ref.kind === 'SEMANTIC_ISSUE' && ref.id === issue.id))
```

This is the **only** place in `IntegratedDecisionReport` where a per-`RevisionAction` detail object is constructed. `IntegratedDecisionReportSummary.revisionActionsPlanned`/`revisionActionsImplemented` (`decision-record.ts:632-633`), by contrast, are computed from **all** `session.revisionActions` regardless of `sourceRefs` kind — see §13 for why this asymmetry matters.

---

## 3. Existing P2-A/P2-B canonical validators

Already covered in §1.4. Their exact, current call order inside `assertRevisionVerificationIntegrity` (session.ts:717-736):

```
assertRevisionSuccessorIntegrity(sourceSession, successorSession)
  → assertRevisionVerificationLedgerIntegrity(sourceSession)   [module-internal]
  → local lookup of the one requested revisionVerificationId
```

`assertRevisionSuccessorIntegrity` itself (session.ts:503-576) requires, among other checks: both sessions frozen-or-later, `verifyFrozenInputIntegrity` on both, the six binding fields matching both supplied session objects exactly, `sourceSession.id !== successorSession.id`, `sourceSession.artifactHash !== successorSession.artifactHash`, **≥1 `IMPLEMENTED` `RevisionAction` still present on `sourceSession`**, and the per-category semantic-copy-policy check against `successorSession.authorContext`. It throws immediately if `sourceSession.revisionSuccessor` is `null` — this single fact is load-bearing for §6 CASE 9 and CASE 2 below.

No report-specific weaker duplicate of either function is proposed anywhere in this document (§5 of the governing packet is honored throughout).

---

## 3a. RevisionAction provenance integrity boundary (Amendment 2)

The confirmed defect and gap are stated in §1.7/§1.8. This section freezes the canonical fix — architecture only, no runtime implemented here.

### 3a.0 Upstream authority: HumanAdjudication ledger (Amendment 3)

The confirmed gap is stated in §1.8. Freeze a new canonical validator, upstream of and composed by `assertRevisionActionLedgerIntegrity` (§3a.1):

```ts
assertHumanAdjudicationLedgerIntegrity(session: StressTestSession): void
```

**Not report-specific** — a domain validator, exactly parallel in role to `assertRevisionVerificationLedgerIntegrity`/`assertRevisionActionLedgerIntegrity`. Validates the full existing `session.adjudications` ledger globally, before any downstream authorization logic trusts it.

For every `[key, adjudication]` in `session.adjudications`, required checks:

| # | Check |
|---|---|
| A | `key === adjudication.id` |
| B | `adjudication.id` is a non-empty string |
| C | exactly one of `semanticIssueId`/`findingId` is present |
| D | if `semanticIssueId` present: it is a non-empty string, `session.semanticIssues[semanticIssueId]` exists, and the resolved `SemanticIssue.id === semanticIssueId` |
| E | if `findingId` present: it is a non-empty string, `session.findings[findingId]` exists, and the resolved `ReviewFinding.id === findingId` |
| F | `judgment` is exactly one of `KNOWN_PRE_DISPATCH`/`NEW_NON_MATERIAL`/`NEW_MATERIAL`/`WRONG` |
| G | `actionChange` is exactly `YES` or `NO` |
| H | `note` is a string |
| I | `adjudicatedAt` is a non-empty string |
| J | at most one `HumanAdjudication` targets the same exact `SEMANTIC_ISSUE` id or `FINDING` id — checked globally across the whole ledger, never by first-match `.find()`/`.some()` semantics that stop at the first hit |

This is the exact same "global integrity before local lookup" discipline already established for `assertRevisionVerificationLedgerIntegrity` (§9), applied here to the ledger `RevisionAction` authorization ultimately depends on.

### 3a.1 Canonical validator

```ts
assertRevisionActionLedgerIntegrity(session: StressTestSession): void
```

**Not report-specific.** This is the canonical later-read/write-boundary validator for the entire `revisionActions` ledger, exactly parallel in role to `assertRevisionVerificationLedgerIntegrity` for the verification ledger (§3, §9).

**Must begin by calling `assertHumanAdjudicationLedgerIntegrity(session)` (§3a.0)** — global integrity of the upstream authorization ledger before any local `RevisionAction` check runs (Amendment 3). Only then, for every `[key, action]` in `session.revisionActions`, required checks:

| # | Check |
|---|---|
| A | `key === action.id` |
| B | `action.id` is a non-empty string |
| C | `action.sourceRefs` is non-empty |
| D | every `sourceRef.kind` is exactly `SEMANTIC_ISSUE` or `FINDING` |
| E | every `sourceRef.id` is a non-empty string |
| F | `SEMANTIC_ISSUE` refs resolve against `session.semanticIssues[ref.id]`, **and the resolved `SemanticIssue.id === ref.id`** (Amendment 3 — existence by map key alone is insufficient) |
| G | `FINDING` refs resolve against `session.findings[ref.id]`, **and the resolved `ReviewFinding.id === ref.id`** (Amendment 3, same strengthening) |
| H | `action.status` is one of `PLANNED`/`IMPLEMENTED`/`REJECTED` |
| I | `action.createdAt` is a non-empty string |
| J | at least one `sourceRef` still resolves to a `HumanAdjudication` with `actionChange === 'YES'` against that exact referenced `SemanticIssue`/`ReviewFinding` — the same authorization rule `planRevisionAction` already enforces at write time (`session.ts:336-347`), re-verified rather than merely trusted from history, and (Amendment 3) only ever evaluated **after** §3a.0 has already passed, so no malformed or tampered `HumanAdjudication` may satisfy it. The original rule is unchanged: **at least one** `sourceRef` must be YES-authorized, never all. |

**Deliberately not required** — never a write-time requirement, not invented here: every ref (not just one) having `actionChange=YES`; every ref being adjudicated at all; unique `sourceRefs`; any ordering semantics.

### 3a.2 Threat-model limit

Unchanged from the accepted in-memory model (§3, §14 of `REVISION_VERIFICATION_CONTRACT.md`): `assertRevisionActionLedgerIntegrity` — and, by the same reasoning, `assertHumanAdjudicationLedgerIntegrity` (§3a.0, Amendment 3) — detects structural and provenance-invalid stored state. Neither **cryptographically** proves that a caller did not coherently rewrite every mutually-consistent authority object at once. This limit is neither widened nor narrowed by this amendment; it is the same limit already stated for `assertRevisionSuccessorIntegrity`/`assertRevisionVerificationLedgerIntegrity`.

### 3a.3 Ingress alias isolation (future runtime requirement)

`planRevisionAction` must stop storing caller-owned `RevisionSourceRef` objects directly. Frozen minimum fix — an explicit domain clone helper, never a generic deep-clone utility, mirroring the same clone-on-ingress discipline already established elsewhere in this codebase (P2-A's `AuthorContext` copy, D1-A's checkpoint store):

```ts
function cloneRevisionSourceRef(ref: RevisionSourceRef): RevisionSourceRef {
  return { kind: ref.kind, id: ref.id } as RevisionSourceRef;
}
```

stored as `sourceRefs: input.sourceRefs.map(cloneRevisionSourceRef)` — never `sourceRefs: [...input.sourceRefs]`. Required invariant: mutating the caller's original `sourceRefs` array, or any original `RevisionSourceRef` object, after `planRevisionAction` returns must never change the stored `RevisionAction`.

### 3a.4 Write-boundary composition (future runtime requirement)

Global integrity before authoritative mutation. `assertRevisionActionLedgerIntegrity(session)` must be called and must pass before any of these existing write paths proceed:

- `planRevisionAction` — validate the existing ledger before appending a new `RevisionAction`.
- `setRevisionStatus` (backing `implementRevisionAction`/`rejectRevisionAction`) — validate the entire existing ledger before any status transition.
- `completeSession` — validate the ledger before trusting which actions are `PLANNED`/`IMPLEMENTED`/`REJECTED`.
- `createRevisionSuccessorSession` — validate the ledger before deciding whether an `IMPLEMENTED` action exists (§6 of `REVISION_VERIFICATION_CONTRACT.md`).
- **(Amendment 3.)** `adjudicate` — must call `assertHumanAdjudicationLedgerIntegrity(session)` (§3a.0) at its own beginning, before appending a new `HumanAdjudication`, so an otherwise-valid new adjudication cannot be appended on top of a hidden corrupt adjudication ledger.

A valid, local, well-formed new/transitioning `RevisionAction` (or `HumanAdjudication`) must never be appended or transitioned on top of an unrelated, already-corrupt record elsewhere in the same ledger.

### 3a.5 Later-read/downstream composition (future runtime requirement)

Both existing P2 canonical validators must compose this new one, never merely trust matching ids/statuses:

```
assertRevisionSuccessorIntegrity(sourceSession, successorSession)
  must call assertRevisionActionLedgerIntegrity(sourceSession)
  before trusting sourceSession's IMPLEMENTED RevisionAction existence

assertRevisionVerificationLedgerIntegrity(sourceSession)
  must call assertRevisionActionLedgerIntegrity(sourceSession)
  before trusting any revisionActionId/status it resolves
```

This changes the authority chain from `RevisionVerification → some object with matching id/status` to the correct `RevisionVerification → RevisionAction → valid sourceRefs → authoritative source-session entities`. **(Amendment 3.)** Since `assertRevisionActionLedgerIntegrity` itself now begins with `assertHumanAdjudicationLedgerIntegrity` (§3a.0), the full transitive chain becomes: `RevisionVerification → RevisionAction → valid sourceRefs + valid upstream HumanAdjudication authorization → authoritative source-session entities`.

### 3a.6 Report-boundary composition

P2-C report generation must **always** call `assertRevisionActionLedgerIntegrity(session)` before any `RevisionAction` projection — even when `session.revisionSuccessor === null`, because `allRevisionActions` (§13) is still displayed in the pre-successor `AWAITING_SUCCESSOR` state and must not project unvalidated provenance. §7's integrity ordering (below) is revised accordingly — superseding, not merely supplementing, the Amendment-1 sequence, with exactly one new step (C) inserted unconditionally before the successor/verification branch begins.

### 3a.7 Report egress alias isolation

`allRevisionActions[].sourceRefs` and `issues[].revisionActions[].sourceRefs` (§11.3) must contain cloned `RevisionSourceRef` objects (the same `cloneRevisionSourceRef` semantics as §3a.3) — a report consumer must never receive a reference that aliases the authoritative session's own nested `RevisionSourceRef` objects.

### 3a.8 `generateDecisionRecord` parity

`generateDecisionRecord` (`decision-record.ts:90`) also trusts `session.revisionActions` and projects `RevisionAction.sourceRefs` (via `revisionActionsForIssue`/`revisionActionsForFinding`, `decision-record.ts:112-120`) — with **no validator at all** today. Since a canonical validator now exists, future hardening must not leave `generateDecisionRecord` with a weaker `RevisionAction` trust boundary than `IntegratedDecisionReport`: `generateDecisionRecord(session)` must call `assertRevisionActionLedgerIntegrity(session)` before trusting/projecting `revisionActions`. No other redesign of `DecisionRecord` is authorized or implied by this amendment.

### 3a.8a Report/DecisionRecord adjudication-integrity dependency (Amendment 3)

`IntegratedDecisionReport` and `DecisionRecord` both already present `HumanAdjudication`-derived facts (`IntegratedDecisionReportIssue.humanAdjudication`, `DecisionRecordIssueEntry.judgment`/`actionChange`, `DecisionRecordFindingAdjudicationEntry`). They must not have a weaker adjudication trust boundary than `RevisionAction` provenance does. Because `assertRevisionActionLedgerIntegrity` composes `assertHumanAdjudicationLedgerIntegrity` (§3a.0), and both report generators already call `assertRevisionActionLedgerIntegrity` (§3a.6, §3a.8), their adjudication presentation obtains global adjudication integrity **transitively** — no direct call is required today. This dependency must be documented verbatim in the future runtime (mirroring §9's Amendment-1 boundary statement for the verification ledger): if future code ever stops composing `assertRevisionActionLedgerIntegrity` into either report generator, that generator must call `assertHumanAdjudicationLedgerIntegrity(session)` directly instead — the dependency is transitive today, not permanently free.

### 3a.9 Required adversarial tests for future hardening

At minimum:

| # | Test |
|---|---|
| A | Caller mutates the original `sourceRefs` array after `planRevisionAction` → stored action unchanged |
| B | Caller mutates an original `RevisionSourceRef` object after `planRevisionAction` → stored action unchanged |
| C | Stored `sourceRef` points to a missing `SEMANTIC_ISSUE` → canonical validator rejects |
| D | Stored `sourceRef` points to a missing `FINDING` → rejects |
| E | Stored action has empty `sourceRefs` → rejects |
| F | `revisionActions` map key `!==` `action.id` → rejects |
| G | Stored action has an illegal runtime `status` → rejects |
| H | None of the action's refs still resolves to an adjudication with `actionChange=YES` → rejects |
| I | A hidden, unrelated corrupt `RevisionAction` blocks a new `planRevisionAction` write |
| J | A hidden, unrelated corrupt `RevisionAction` blocks a status transition |
| K | A hidden, unrelated corrupt `RevisionAction` blocks `createRevisionSuccessorSession` |
| L | A hidden corrupt `RevisionAction` blocks report generation even when the displayed target action itself is valid |
| M | Returned report `sourceRefs` are alias-isolated from the authoritative session's `sourceRefs` |
| N | `HumanAdjudication` map key `!==` `adjudication.id` → canonical adjudication validator rejects |
| O | `HumanAdjudication` has both `semanticIssueId` and `findingId` → rejects |
| P | `HumanAdjudication` has neither target → rejects |
| Q | `HumanAdjudication` targets an unknown `SemanticIssue` → rejects |
| R | `HumanAdjudication` targets an unknown `ReviewFinding` → rejects |
| S | `HumanAdjudication.semanticIssueId` resolves by map key but the resolved `SemanticIssue.id` differs → rejects |
| T | `HumanAdjudication.findingId` resolves by map key but the resolved `ReviewFinding.id` differs → rejects |
| U | Duplicate `HumanAdjudication`s target the same `SemanticIssue` → rejects globally |
| V | Duplicate `HumanAdjudication`s target the same `ReviewFinding` → rejects globally |
| W | Illegal runtime `judgment` → rejects |
| X | Illegal runtime `actionChange` → rejects |
| Y | A hidden, unrelated corrupt `HumanAdjudication` blocks a new `adjudicate()` write |
| Z | A hidden, unrelated corrupt `HumanAdjudication` blocks `planRevisionAction` via `assertRevisionActionLedgerIntegrity` |
| AA | A `RevisionAction.sourceRef` resolves by map key but the target object's own `id` differs → `assertRevisionActionLedgerIntegrity` rejects |
| AB | A hidden corrupt `HumanAdjudication` blocks report generation even when the displayed `RevisionAction` itself is otherwise valid |

(N–AB are Amendment 3 additions to the A–M list Amendment 2 already froze — A–M are preserved unchanged, not replaced.) Out of scope for this document — these are requirements for the separately-authorized hardening runtime, not tests this analysis performs.

---

## 4. Successor-session input options

Evaluated per the governing packet's §8.

**Option A — optional third parameter** (`successorSession?: StressTestSession`):
- TypeScript-optional: yes. Runtime-conditionally-required: yes (§6 below).
- Compatibility: fully additive — all 22 existing `generateIntegratedDecisionReport` call sites (`test-stress-test-decision-record.mjs`) remain valid unchanged.
- Fail-closed ability: full — the function can unconditionally validate whenever the argument is present, and unconditionally require it whenever domain state demands it (§6).
- Duplicate caller authority: none introduced — the caller supplies the same object it would supply to `assertRevisionSuccessorIntegrity` directly, no new authority is invented.
- Implementation size: smallest of the three options — one new optional parameter, no new exported function, no call-site rewrite.

**Option B — separate function** (`generateIntegratedDecisionReportWithRevisionVerification(...)`):
- Duplicates the entire session/deliberation-binding and RouteOutcome-integrity logic already in `generateIntegratedDecisionReport`, or requires one function to call the other and then post-process its result (fragile: the P2-B fields would have to be spliced into an already-built, deeply-nested `issues[]` array after the fact).
- Two report APIs for one product concept is a genuine divergence risk (a future P1 change could be applied to one and not the other) — rejected on the same "do not duplicate logic" ground the governing packet applies to validators.

**Option C — input object** (`generateIntegratedDecisionReport({session, deliberationState, successorSession})`):
- Cleaner as an abstract future boundary, but is a **breaking change** to a function already called at all 22 existing P1 test sites, none of which this packet is authorized to touch (§25/§26 of the governing packet: no test modification).
- Not required by anything in the requiredness matrix (§6) — the optional-third-positional-argument shape already expresses every legal/illegal combination needed.
- Reads as generalizing for a future multi-parameter report API the product does not yet need — against §20/§23's explicit instruction not to generalize beyond the one-shot V0→V1 model.

**Recommendation: Option A.** Extend the existing function with one optional trailing parameter, backward-compatible, zero test rewrites, and sufficient to express every case in §6.

---

## 5. Recommended minimum input contract

```ts
generateIntegratedDecisionReport(
  session: StressTestSession,
  deliberationState: DeliberationState,
  successorSession?: StressTestSession
): IntegratedDecisionReport
```

Runtime rule (not expressible in the type system alone): **`successorSession` is required whenever "successor authority is in play,"** defined as the logical OR of three signals — `session.revisionSuccessor !== null`, `Object.keys(session.revisionVerifications).length > 0`, or the caller supplied `successorSession` at all. If any is true and `successorSession` is `undefined`, the function must throw before doing any other work. If `successorSession` is supplied, it must be validated **unconditionally**, even if the other two signals are both false (see §6 CASE 9 — this is what makes an unrelated/extraneous successor object fail closed rather than being silently ignored).

The reason the trigger condition must be an OR of all three signals, not just `revisionSuccessor !== null`, is CASE 2 (§6): a corrupted session where `revisionVerifications` is non-empty but `revisionSuccessor` has been tampered to `null` must not be silently read as "no successor, nothing to check" — see §6 and §9 for the full argument.

---

## 6. Requiredness matrix

| Case | State | Legal? | successorSession required? | Report behavior |
|---|---|---|---|---|
| 1 | `revisionSuccessor===null`, ledger empty, no successor supplied | Legal partial history | No | Succeeds; every RevisionAction's verification presentation is the "no verification" null state |
| 2 | `revisionSuccessor===null`, ledger **non-empty** | **Corrupted / impossible under normal domain operation** | Yes (triggered by non-empty ledger despite `revisionSuccessor` looking null) | Caller must supply `successorSession`; whatever is supplied (or its absence) is then run through `assertRevisionSuccessorIntegrity`, which throws immediately on `revisionSuccessor===null` — **fails closed**, never silently "no verification" |
| 3 | `revisionSuccessor` exists, successor omitted | Illegal caller usage | Yes | **Fails closed** before any projection — explicit "successorSession required" error |
| 4 | `revisionSuccessor` exists, correct successor supplied, ledger empty | Legal partial history | Yes (supplied) | Succeeds; `assertRevisionSuccessorIntegrity` passes, ledger scan is a no-op; every RevisionAction's verification presentation is the "no verification yet" null state |
| 5 | `revisionSuccessor` exists, correct successor supplied, ≥1 valid verification | Legal | Yes | Succeeds; verified RevisionAction(s) show verdict/evidence, others show the null state |
| 6 | `revisionSuccessor` exists, **unrelated** successor supplied | Corrupted input | Yes (supplied, but wrong) | **Fails closed** — `assertRevisionSuccessorIntegrity`'s `successorSessionId` mismatch |
| 7 | `revisionSuccessor` exists, successor's artifact/context hash tampered | Corrupted input | Yes | **Fails closed** — `verifyFrozenInputIntegrity`/hash cross-check inside `assertRevisionSuccessorIntegrity` |
| 8 | binding/successor self-consistent but violates semantic-copy policy | Corrupted input | Yes | **Fails closed** — `assertRevisionSuccessorIntegrity`'s dedicated per-category semantic-copy check (same mechanism P2-A's own AA test proves) |
| 9 | no `revisionSuccessor`, caller supplies a successor anyway | Illegal caller usage | N/A — supplied unnecessarily | **Fails closed**, provided the report validates unconditionally whenever supplied (§5) — `assertRevisionSuccessorIntegrity` throws on `revisionSuccessor===null` regardless of which successor object was handed to it |
| 10 | requested RA/verification valid, an unrelated ledger record is corrupt | Corrupted input | Yes | **Fails closed for the entire report**, not only the corrupt entry — global integrity before local filtering (§7) |

Row 2 and row 9 are the two cases that require the "validate whenever any of the three OR-signals is true, and validate unconditionally whenever supplied" rule from §5 — neither is caught if the trigger condition is naively just `revisionSuccessor !== null`.

**Amendment 1 note.** CASE 1's "no verification" null state and CASE 4's "no verification yet" null state are no longer one collapsed label — §11 freezes them as two distinct, named `verificationState` values: CASE 1 is exactly `AWAITING_SUCCESSOR`; CASE 4 is exactly `NO_VERIFICATION_RECORDED`.

---

## 7. Exact integrity ordering

```
Step A. verifyDeliberationBinding(session, deliberationState)          [existing, unchanged — already calls verifyFrozenInputIntegrity(session)]
Step B. for every deliberationState.outcomes entry:
          assertRouteOutcomeIntegrity(session, deliberationState, attemptId)   [existing, unchanged]
Step C. assertRevisionActionLedgerIntegrity(session)                    [NEW — Amendment 2, unconditional, §3a]
Step D. determine "successor authority in play" =
          session.revisionSuccessor !== null
          OR Object.keys(session.revisionVerifications).length > 0
          OR successorSession !== undefined
Step E. if authority is in play (Step D) and successorSession is undefined:
          FAIL CLOSED (explicit "successorSession required" error) before any further step
Step F. if successorSession supplied / authority in play:
          assertRevisionSuccessorIntegrity(session, successorSession)
Step G. if Object.keys(session.revisionVerifications).length > 0:
          assertRevisionVerificationLedgerIntegrity(session)     [promoted to exported — see §9, "new public aggregate validator"]
Step H. only after A–G succeed without throwing:
          build the COMPLETE allRevisionActions projection (§13) — every
          session.revisionActions entry, via one shared projection
          function, never filtered by sourceRefs kind
Step I. derive issues[].revisionActions from the SAME projection
          function/semantics as Step H, filtered to SEMANTIC_ISSUE-linked
          entries only — never a second, independently-written mapping (§13)
Step J. only then build and return the final IntegratedDecisionReport value
```

(Amendment 1 renumbered the original Step D/E/F into D–I. **Amendment 2 inserts one further new step, C — `assertRevisionActionLedgerIntegrity`, unconditional, immediately after the two existing P1 checks and before the successor/verification branch — shifting every subsequent step down one letter, D–J.** No governing rule from either amendment's ordering is weakened by the other, only made more precise; §3a.6 explains why Step C must run even when no successor exists.)

This is **global integrity before local filtering**: every existing ledger record is validated once, up front, regardless of which RevisionActions the caller will end up looking at — never only the ones that happen to be displayed (§10/§22.I of the governing packet).

---

## 8. Zero-verification handling

CASE 4 in §6. When `session.revisionVerifications` is empty, `assertRevisionVerificationIntegrity(sourceSession, successorSession, id)` cannot be called at all — there is no `id` to pass, and the governing packet explicitly forbids fabricating one merely to make a validator callable (§11 of the governing packet). The correct minimum path is: run **only** `assertRevisionSuccessorIntegrity(session, successorSession)` (Step F). Step G is skipped entirely — an empty ledger trivially satisfies whole-ledger integrity by having nothing to violate it. No new validator or special-case function is needed for this case.

---

## 9. Non-empty verification-ledger handling

Three strategies were evaluated (governing packet §12):

**A — call `assertRevisionVerificationIntegrity` once per stored id.** Correct, but each call independently re-runs `assertRevisionSuccessorIntegrity` **and** the full ledger scan, so N stored records means the successor-binding check and the full-ledger scan each run N times. At first-pilot cardinality (a handful of RevisionActions per session) this is not a real performance concern (per §12's own instruction not to prematurely optimize), but it is architecturally redundant.

**A′ — call `assertRevisionVerificationIntegrity` once, with an arbitrarily chosen existing id, purely to trigger its internal global scan.** Rejected: this repurposes a function whose documented contract is "verify *this one* record" for an undocumented side effect (that its internals happen to scan globally first). It is a fragile, implicit coupling — if that function's internals ever stopped scanning globally up front, this trick would silently stop providing the guarantee the report relies on. It also has no principled way to choose *which* id to pass, which brushes against the "no first/latest heuristic" spirit of §4.G even though that clause is literally about successor selection, not this.

**B — export the existing internal `assertRevisionVerificationLedgerIntegrity(sourceSession)` as public API, with no signature or logic change at all.** It already does exactly and only what Step G needs — a pure structural/provenance scan over `sourceSession.revisionVerifications` against `sourceSession.revisionActions`, requiring no `successorSession` argument at all (confirmed by direct inspection: the function never references `successorSession`). Making it `export function` instead of `function` is the entire change.

**Recommendation: B.** This is not "exporting an internal helper merely for convenience" (governing packet §5's caution) — there is a concrete correctness need: without it, the only way to achieve whole-ledger validation using solely already-public functions is strategy A′, which is a worse design than simply exposing the one function that already, correctly, does the job. **New public aggregate validator required: YES — but it is a one-line visibility change to code that already exists, not new logic.**

**Amendment 1 — explicit boundary statement (must be documented verbatim in the future runtime, not merely implied):** `assertRevisionVerificationLedgerIntegrity` alone is **NOT SUFFICIENT** to trust or display a `RevisionVerification`. It validates only the source session's verification ledger against that same session's `revisionActions` — it says nothing about whether `successorSession` is genuinely `sourceSession`'s authoritative V1. The report's trust boundary is always the ordered pair:

```
assertRevisionSuccessorIntegrity(sourceSession, successorSession)
  THEN
assertRevisionVerificationLedgerIntegrity(sourceSession)
```

never the ledger check alone. This is already the exact order Step F→Step G (§7) enforces; this paragraph exists so a future reader of the promoted-to-public function cannot mistake it for a self-sufficient check.

---

## 10. RevisionAction → RevisionVerification cardinality (projection)

Accepted domain cardinality: 0..1 (unchanged, P2-B). After Step G (§7) has globally validated the ledger — which already makes a duplicate `revisionActionId` structurally impossible to survive — the per-RevisionAction projection step must still not use a bare `.find()` (governing packet §13's explicit instruction). Minimum recommended pattern:

```ts
const matches = Object.values(session.revisionVerifications).filter(
  (v) => v.revisionActionId === action.id
);
if (matches.length > 1) {
  throw new Error(`... more than one RevisionVerification for revisionActionId ${action.id}`);
}
const verification = matches[0] ?? null;
```

This is defense-in-depth, not redundant paranoia: it keeps the projection step's own correctness independent of Step G's implementation detail, exactly mirroring how `assertRevisionSuccessorIntegrity`/`assertRevisionVerificationIntegrity` themselves never rely on "the global check already ran" as an excuse to skip a local structural check. This exact lookup belongs inside the one shared per-action projection function §13 (Amendment 1) requires — it must not be reimplemented separately for `allRevisionActions` versus `issues[].revisionActions`.

---

## 11. Presentation model recommendation

Do **not** change `RevisionAction.status` or `labelForRevisionStatus`'s existing three-way switch (`PLANNED`/`IMPLEMENTED`/`REJECTED` labels are unchanged).

### 11.1 Machine-readable verification state (Amendment 1 — frozen)

```ts
export type IntegratedDecisionReportRevisionVerificationState =
  | 'NOT_APPLICABLE'
  | 'AWAITING_SUCCESSOR'
  | 'NO_VERIFICATION_RECORDED'
  | 'VERIFIED_PRESENT'
  | 'NOT_PRESENT'
  | 'INCONCLUSIVE';
```

This is a **deterministic projection**, not a new semantic ledger or authority — every value is a pure function of already-authoritative facts. Exact mapping:

| Domain fact | `verificationState` |
|---|---|
| `RevisionAction.status === 'PLANNED'` | `NOT_APPLICABLE` |
| `RevisionAction.status === 'REJECTED'` | `NOT_APPLICABLE` |
| `status === 'IMPLEMENTED'` and `sourceSession.revisionSuccessor === null` | `AWAITING_SUCCESSOR` |
| `status === 'IMPLEMENTED'`, valid authoritative successor exists, no `RevisionVerification` for this action | `NO_VERIFICATION_RECORDED` |
| stored verdict `VERIFIED_PRESENT` | `VERIFIED_PRESENT` |
| stored verdict `NOT_PRESENT` | `NOT_PRESENT` |
| stored verdict `INCONCLUSIVE` | `INCONCLUSIVE` |

### 11.2 Exact display labels (Amendment 1 — freshly issued by GPT, not recovered historical wording; §12 remains UNKNOWN for the original citation)

| `verificationState` | Label |
|---|---|
| `NOT_APPLICABLE` | "Verification not applicable" |
| `AWAITING_SUCCESSOR` | "Awaiting successor artifact" |
| `NO_VERIFICATION_RECORDED` | "No verification recorded" |
| `VERIFIED_PRESENT` | "Revision verified in successor artifact" |
| `NOT_PRESENT` | "Revision not present in successor artifact" |
| `INCONCLUSIVE` | "Revision verification inconclusive" |

### 11.3 `IntegratedDecisionReportRevisionAction` — updated shape (Amendment 1)

```ts
export interface IntegratedDecisionReportRevisionAction {
  id: string;
  sourceRefs: RevisionSourceRef[];
  description: string;
  targetLocation: string;
  status: RevisionActionStatus;
  statusLabel: string;
  verificationState: IntegratedDecisionReportRevisionVerificationState;
  verificationVerdict: RevisionVerificationVerdict | null;
  verificationEvidence: string | null;
  verifiedAt: string | null;
  verificationStatusLabel: string;
}
```

- `sourceRefs` is a **cloned projection** of the authoritative `RevisionAction.sourceRefs` (shallow-cloned per entry, the same pattern `cloneRouteInputRefShallow` already uses elsewhere in this file) — never a second, independent source/provenance authority. This is required so a `FINDING`-only entry, once it appears in the new top-level `allRevisionActions` (§13) rather than nested under an issue, still carries its own provenance.
- `verificationVerdict`/`verificationEvidence`/`verifiedAt` are `null` whenever `verificationState` is `NOT_APPLICABLE`, `AWAITING_SUCCESSOR`, or `NO_VERIFICATION_RECORDED`; populated verbatim from the stored `RevisionVerification` only for the three verdict states — never re-derived or re-judged, mirroring how `IntegratedDecisionReportHumanAdjudication` already restates `judgment`/`actionChange`/`note`/`adjudicatedAt` verbatim.
- `verificationStatusLabel` is now **fully frozen** by §11.2 above — no longer a type-only placeholder pending a blocking decision.
- No `verificationPercentage`, `confidenceScore`, `riskScore`, or similar numeric/derived field is introduced (governing packet §14/§23) — this shape distinguishes states, it does not rank or score them.

### 11.4 Top-level successor identity (Amendment 1 — corrects §17's original claim)

```ts
export interface IntegratedDecisionReport {
  sessionId: string;
  artifactHash: string;
  generatedAt: string;
  summary: IntegratedDecisionReportSummary;
  issues: IntegratedDecisionReportIssue[];
  unresolvedRisks: IntegratedDecisionReportUnresolvedRisk[];
  allRevisionActions: IntegratedDecisionReportRevisionAction[];
  revisionSuccessor: { sessionId: string; artifactHash: string } | null;
}
```

- `revisionSuccessor` is `null` exactly when `session.revisionSuccessor === null`; non-null **only** after `assertRevisionSuccessorIntegrity` has succeeded (Step F, §7), and its two fields are read from the **actual validated `successorSession` object**, never copied from the stored `RevisionSuccessorBinding` alone — a corrupted state could in principle have the binding disagree with the object actually supplied, and this field must reflect what was proven, not what was merely stored (§15).
- This field exists once, at the top level — `IntegratedDecisionReportRevisionAction` does **not** carry its own copy of successor identity; a `VERIFIED_PRESENT` entry is understood in the context of the single `report.revisionSuccessor` value, never a per-action restatement of it.
- Explicitly not added: `authorContextHash`, any version string, a "latest" marker, or any delivery-state field (unchanged prohibition, §17).

---

## 12. Presentation-label provenance finding

`REVISION_VERIFICATION_CONTRACT.md` §19 (this repository's own file, item 4) reads: *"Extend `IntegratedDecisionReport` ... to surface the six new presentation labels (§26 of this packet) once the above exists."* The checked-in `REVISION_VERIFICATION_CONTRACT.md` itself ends at §20 ("Blocking open decisions") — it has no §26.

A repository-wide search was performed for the exact label text and for any "§26"/"REPORT SEMANTICS"/"presentation label" reference that could be the source:

```
grep -rn "Revision verified in successor artifact|Revision absent from successor artifact|Revision verification inconclusive|No verification recorded|REPORT SEMANTICS" --include="*.md" .
grep -rniI "presentation label|REPORT SEMANTICS|§26|section 26" .
git log --all -S"Revision verified in successor artifact" --oneline
```

Every "§26" hit that exists in the repository (all inside `ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md`, plus two unrelated inline code comments in `test-stress-test-decision-record.mjs`/`test-stress-test-deliberation.mjs`) belongs to a **different, unrelated packet's own §26** — about the common execution-layer envelope (idempotency, `FailureInfo` mapping, `LatencyBudget` race) and `STILL_OPEN`/coordinated-write test sections, respectively. None of them is about revision-verification presentation labels. The `git log -S` pickaxe search across all branches/history found zero commits ever introducing that label text. No checked-in file — not `HANDOFF.md`, not `CLAUDE_CODE_HANDOFF.md`, not any other `.md` — contains it.

**PRESENTATION LABEL SOURCE: UNKNOWN / NOT RECOVERABLE FROM CURRENT REPOSITORY AUTHORITY.**

The `§26` citation inside `REVISION_VERIFICATION_CONTRACT.md`'s own text refers to the *governing GPT packet that authorized that document's own creation* — delivered live in conversation, never committed to this repository as a file. That is not a repository authority source by this packet's own definition (§15 of the governing packet: possible sources are all repository artifacts; the negative-result instruction is to write exactly the sentence above rather than reconstruct from memory or inference). This document does not reconstruct, guess, or approximate the six labels anywhere.

**Amendment 1 note.** The paragraph above remains true and unedited — the historical citation is still genuinely unrecoverable, and this document still does not claim otherwise. What has changed is that GPT has now issued a **fresh** architecture decision for the vocabulary this gap left open, not a recovery of the missing one: see §11.1/§11.2's `IntegratedDecisionReportRevisionVerificationState` (six values) and its six exact display labels. That fresh decision supersedes this finding's original blocking status for P2-C's purposes (§19) — it is explicitly presented as newly issued, never as recovered historical wording.

---

## 13. Standalone FINDING-linked RevisionAction coverage finding

Confirmed by direct inspection (§2 above) and by the absence of any counter-evidence in `test-stress-test-decision-record.mjs` (whose only `RevisionAction` fixture, `buildFullChainFixture`, uses a `SEMANTIC_ISSUE`-kind `sourceRef` exclusively — no test exercises a `FINDING`-only `RevisionAction` against `generateIntegratedDecisionReport`):

- A `RevisionAction` whose `sourceRefs` contain **only** `{kind:'FINDING', ...}` entries (no `SEMANTIC_ISSUE` entry) is **never** included in `issues[].revisionActions` — the sole detail-level location for per-`RevisionAction` presentation in `IntegratedDecisionReport` today.
- It **is** counted in `summary.revisionActionsPlanned`/`revisionActionsImplemented`, since those are computed from `Object.values(session.revisionActions)` unfiltered by `sourceRefs` kind (`decision-record.ts:620`).
- It is **completely absent** from any detailed presentation object anywhere in `IntegratedDecisionReport`.
- `recordRevisionVerification` (P2-B) places **no** requirement on a `RevisionAction`'s `sourceRefs` kind — only on `status === 'IMPLEMENTED'`. A `FINDING`-only `RevisionAction` can legally receive a `RevisionVerification` today, with no way for `IntegratedDecisionReport` to ever surface it in detail.

**Amendment 1 — GPT DECISION: RESOLVED.** GPT has confirmed Option C. `IntegratedDecisionReport` gains the new top-level field frozen in §11.4:

```ts
allRevisionActions: IntegratedDecisionReportRevisionAction[]
```

containing **every** `session.revisionActions` entry — `Object.values(session.revisionActions)`, no `sourceRefs`-kind filter — each entry carrying its own `sourceRefs` (§11.3) so a `FINDING`-only entry retains full provenance without a second source/provenance authority being invented.

`issues[].revisionActions` **retains its field name and nesting location** for backward compatibility — still filtered to `SEMANTIC_ISSUE`-linked entries only. **Correction (Amendment 2):** this is not "unchanged in shape" — `IntegratedDecisionReportRevisionAction` itself is additively extended by §11.3 (`sourceRefs`, `verificationState`, verification fields), and every entry under `issues[].revisionActions`, exactly like every entry under `allRevisionActions`, uses that same newly-extended shape. Only the field's own name and its nesting location are retained unchanged; its element type is not. The future P2-C runtime **must** derive both `allRevisionActions` and `issues[].revisionActions` from one shared per-action projection function (build the full, newly-extended `IntegratedDecisionReportRevisionAction` object once per `RevisionAction`, then filter the already-built list two ways) — never two independently-written semantic mappings that could silently drift apart (governing amendment §7, Step H/I). This is also the exact mechanism that finally reconciles the discrepancy this document's own §21 (Counterintuitive observation) identified: `summary.revisionActionsImplemented` already counts `FINDING`-only actions, and now the detail view will too.

This decision is no longer blocking (§19).

---

## 14. Summary-count recommendation

**Recommendation: NO new summary counts** (e.g. `verified`/`notPresent`/`inconclusive`/`unverified`) in this slice. P2's own stated purpose (per the P2-0 packet) is proving the smallest end-to-end value loop — one artifact, one issue, one decision, one revision, one successor, one proof — not building aggregate dashboards. Per-`RevisionAction` presentation (§11) is sufficient to prove that single-instance loop; nothing in the requiredness matrix (§6) or the counterexample matrix (§16) depends on an aggregate count existing. If real pilot usage later shows multi-revision aggregation is actually needed, that is evidence-driven future work, not something to add now merely because it is easy.

---

## 15. Partial-history vs corruption semantics

**Legal partial history** (must succeed, never fail closed):
- CASE 1 (§6): `IMPLEMENTED` action(s), no successor yet.
- CASE 4 (§6): successor exists, correct, but no verification yet.
- A ledger where some `IMPLEMENTED` `RevisionAction`s have a verification and others (in the same, valid successor pairing) do not — this is the accepted "V1 completes only RA-1/RA-2 of RA-1/RA-2/RA-3" domain fact from `REVISION_VERIFICATION_CONTRACT.md` §16.H, unchanged.

**Corrupted authority** (must fail closed, the *entire* report generation, never degrade into "not verified yet"):
- CASE 2 (§6): a `RevisionVerification` exists with no `RevisionSuccessorBinding`.
- CASE 6/7/8 (§6): a successor object supplied that is unrelated, tampered, or self-consistently policy-violating.
- CASE 10 (§6): any unrelated corrupt record elsewhere in the ledger, even if the specific record a caller cares about looks individually valid.
- A duplicate `RevisionVerification` for the same `revisionActionId` anywhere in the ledger.
- A `RevisionVerification` whose `revisionActionId` does not resolve within the exact `sourceSession` being reported on.

The dividing line is exactly what P2-A/P2-B's own canonical validators already enforce — §7's Step F/G ordering is what carries that same dividing line into report generation, rather than the report re-deriving its own, possibly weaker, notion of "corrupted."

---

## 16. Counterexample matrix

| # | State | Legal? | What is displayed | Canonical validator | New decision required? |
|---|---|---|---|---|---|
| A | `IMPLEMENTED` RA, no successor | Yes | Null verification state | none (successor authority not in play) | No |
| B | successor exists, no verification | Yes | `NO_VERIFICATION_RECORDED` (§11.1), `report.revisionSuccessor` populated | `assertRevisionSuccessorIntegrity` | No (label text frozen, §11.2) |
| C | `VERIFIED_PRESENT` with exact correct successor | Yes | verdict/evidence/`verifiedAt` shown, `report.revisionSuccessor` identifies exact V1 | `assertRevisionSuccessorIntegrity` + ledger integrity | No |
| D | `NOT_PRESENT` exists | Yes | same as C, verdict `NOT_PRESENT` | same as C | No |
| E | `INCONCLUSIVE` exists | Yes | same as C, verdict `INCONCLUSIVE` | same as C | No |
| F | verification exists, successor omitted | No | — (throws) | report's own required-parameter check (§5/§7 Step E) | No |
| G | verification exists, unrelated successor supplied | No | — (throws) | `assertRevisionSuccessorIntegrity` (successorSessionId mismatch) | No |
| H | verification exists, binding successor hash tampered | No | — (throws) | `assertRevisionSuccessorIntegrity` (hash cross-check / `verifyFrozenInputIntegrity`) | No |
| I | hidden unrelated corrupt record, displayed one looks valid | No | — (throws, whole report) | ledger integrity (Step G), global-before-local | No |
| J | duplicate records for same RA | No | — (throws, whole report) | ledger integrity (Step G), cardinality check | No |
| K | verification references another session's RA id | No | — (throws, whole report) | ledger integrity (Step G), resolution against exact `sourceSession` | No |
| L | binding/successor self-consistent, violates semantic-copy policy | No | — (throws) | `assertRevisionSuccessorIntegrity` (semantic-copy check) | No |
| M | caller supplies successor, no `RevisionSuccessorBinding` exists | No | — (throws) | `assertRevisionSuccessorIntegrity` (`revisionSuccessor===null`) — requires unconditional validation whenever supplied (§5) | No |
| N | `RevisionAction` linked only to `FINDING` | Legal to verify; now presentable via `allRevisionActions` (§13) | Appears in `allRevisionActions` with its own `sourceRefs`; still absent from `issues[].revisionActions` (unchanged, by design) | n/a — resolved by the shared-projection top-level array, not a corruption case | **No — resolved, §13 (Amendment 1)** |

Every counterexample is now fully resolved by existing, accepted P2-A/P2-B validators once the report calls them in the order fixed in §7 (A–J) — no new validation logic is required anywhere in this matrix beyond the report's own required-parameter check (Step E) and the shared-projection mechanism (Step H/I) that closes N.

**Amendment 2 note.** This matrix predates and is unaffected in its own rows by `RevisionAction`-provenance corruption (a tampered/missing `sourceRef`, an ingress-aliased `RevisionSourceRef`, a hidden corrupt `RevisionAction` elsewhere in the ledger) — those counterexamples are enumerated separately in §3a.9, since they are caught by the new §7 Step C (`assertRevisionActionLedgerIntegrity`), unconditionally, before Step D even runs. They are not duplicated into this table to avoid two lists drifting apart.

---

## 17. Explicit non-goals

This document does **not** authorize, and P2-C runtime must not introduce, any of the following (governing packet §23), each rejected on the stated ground:

- ~~Duplicated successor hashes in the report — already available via `report.artifactHash`/the binding itself~~ — **corrected, Amendment 1: this claim was FALSE.** `IntegratedDecisionReport.artifactHash` is the **source session V0's** hash only; before this amendment, `IntegratedDecisionReport` exposed no successor identity anywhere. A report displaying `VERIFIED_PRESENT` without naming the exact successor artifact it was validated against would weaken, not preserve, the P2 provenance claim. The corrected, still-minimal rule: expose successor identity **once**, at the top level (`report.revisionSuccessor`, §11.4), populated only from an actually-validated `successorSession` — never per-`RevisionAction`, never per-`RevisionVerification`, and never a second, independently-derived copy of the same two fields.
- **Duplicated session ids in the `RevisionVerification` presentation model** — `sourceSessionId`/`successorSessionId` remain derivable, not stored, exactly as `RevisionVerification` itself already omits them (`REVISION_VERIFICATION_CONTRACT.md` §8); this is unaffected by the correction above, since `report.revisionSuccessor` lives on the report, not inside any per-action or per-verification presentation object.
- **Generic version identifiers / a latest-version resolver / a generic artifact graph** — P2 remains one-shot V0→V1 (governing packet §20); no version string or "latest" concept exists anywhere in the accepted domain model.
- **Report-owned verification truth / automatic semantic verification** — the report only restates a stored, human-confirmed fact; it must never itself compare artifact text or derive a verdict.
- **Provider/model provenance, a `verifiedBy` actor identity field** — no actor/user-identity system exists anywhere in this codebase (confirmed: `HumanAdjudication` itself has no such field); adding one now for the report alone would be new, unrequested general infrastructure.
- **A delivery-readiness field** — `VERIFIED_PRESENT` answers "was this specific revision human-confirmed present in this specific successor," never "may this artifact be sent" (governing packet §19/§24 of P2-B).
- **A corrective V2 workflow** — one-shot limitation is unchanged (§18 of `REVISION_VERIFICATION_CONTRACT.md`, restated by this packet's §20).
- **A persistence abstraction / a generic repository-service layer** — every function discussed here operates on plain, already-in-memory `StressTestSession`/`DeliberationState` values, exactly like every other function in this module; no storage concern is in scope.
- **(Amendment 3.)** A generic `StressTestSession` integrity framework, a generic ledger-validation framework, or a generic entity registry — `assertHumanAdjudicationLedgerIntegrity`/`assertRevisionActionLedgerIntegrity` are two more purpose-built validators in the same style as `assertRevisionSuccessorIntegrity`/`assertRevisionVerificationLedgerIntegrity`, never a shared abstraction generalizing over all four; DB transactions; and any signature/cryptographic mechanism — this amendment closes only the upstream authority `RevisionAction` provenance specifically needs, nothing broader.

---

## 18. Minimum future P2-C runtime file scope

If/when a P2-C runtime packet is authorized:

**(Amendment 2 splits this scope across two separately-accepted runtime slices — see §18a. The file list below is unchanged in content; only its sequencing changes.)**

1. `src/stress-test/session.ts` — one-line visibility change: `function assertRevisionVerificationLedgerIntegrity` → `export function assertRevisionVerificationLedgerIntegrity`; **plus (Amendment 2, hardening slice)** the new `assertRevisionActionLedgerIntegrity` export (§3a.1), the `cloneRevisionSourceRef` ingress fix in `planRevisionAction` (§3a.3), and composing calls into `planRevisionAction`/`setRevisionStatus`/`completeSession`/`createRevisionSuccessorSession` (§3a.4) and into `assertRevisionSuccessorIntegrity`/`assertRevisionVerificationLedgerIntegrity` (§3a.5); **plus (Amendment 3, same hardening slice)** the new `assertHumanAdjudicationLedgerIntegrity` export (§3a.0), the strengthened own-id `SEMANTIC_ISSUE`/`FINDING` resolution checks inside `assertRevisionActionLedgerIntegrity` (§3a.1 items F/G), and a composing call from `adjudicate` (§3a.4).
2. `src/stress-test/decision-record.ts` — extend `generateIntegratedDecisionReport`'s signature (§5); implement the integrity-ordering steps A–J (§7); add `IntegratedDecisionReportRevisionVerificationState` and its mapping/labels (§11.1/§11.2); extend `IntegratedDecisionReportRevisionAction` with `sourceRefs`/`verificationState`/verification fields (§11.3); add the top-level `allRevisionActions` array and `revisionSuccessor` field to `IntegratedDecisionReport` (§11.4/§13 — now a required part of this contract, no longer contingent); implement `allRevisionActions` and `issues[].revisionActions` as two filters over one shared per-action projection function (§13), never two independently-written mappings; egress-clone `sourceRefs` on every projected entry (§3a.7); **plus (Amendment 2)** compose `assertRevisionActionLedgerIntegrity` into `generateDecisionRecord` for parity (§3a.8) — which (Amendment 3, §3a.8a) transitively also carries `HumanAdjudication` ledger integrity into both report generators with no direct call needed.
3. `src/stress-test/types.ts` — no change anticipated; `RevisionVerificationVerdict`/`RevisionVerification` already live there (P2-B) and `IntegratedDecisionReport*` types live in `decision-record.ts`, matching existing P1 precedent.
4. `src/stress-test/deliberation.ts`, `hash.ts`, `index.ts` — no change anticipated. `index.ts` already wildcard-re-exports `decision-record.js`/`session.js`, so any newly-exported symbol above surfaces automatically (confirmed precedent from P2-A/P2-B).
5. `test-stress-test-mvp.mjs` — new adversarial tests for `assertRevisionActionLedgerIntegrity`/`assertHumanAdjudicationLedgerIntegrity` and ingress alias isolation (§3a.9, tests A–AB); out of scope for this document (docs-only, no test authorization).
6. `test-stress-test-decision-record.mjs` — new tests covering the requiredness matrix (§6), counterexample matrix (§16), and egress alias isolation (§3a.7/§3a.9.M); out of scope for this document (docs-only, no test authorization).

---

## 18a. Required implementation sequencing (Amendments 2 & 3)

Frozen order, **not to be combined into one acceptance unit** — the two slices have different failure modes (provenance/aliasing/upstream-authority correctness vs. report presentation correctness), and combining them would make a review of one mask a defect in the other:

```
P2-C0 (+ Amendment 1 + Amendment 2 + Amendment 3) accepted
  → RevisionAction Provenance Hardening runtime  (§3a incl. §3a.0 — session.ts changes, §18 item 1)
  → independent GPT acceptance
  → P2-C IntegratedDecisionReport runtime         (§5–§17 — decision-record.ts changes, §18 items 2, 5, 6)
  → independent GPT acceptance
```

**(Amendment 3.)** `assertHumanAdjudicationLedgerIntegrity` is **not** a separate, third milestone — it is part of the same, single RevisionAction Provenance Hardening runtime slice above, since `RevisionAction` authorization cannot be correctly validated without it (§3a.0/§3a.1 item J).

P2-C report runtime (`generateIntegratedDecisionReport`'s new signature, `allRevisionActions`, `revisionSuccessor`, verification presentation) must not begin until the RevisionAction Provenance Hardening runtime above is separately authorized and accepted — because §7 Step C (`assertRevisionActionLedgerIntegrity`, itself now dependent on §3a.0) is a load-bearing precondition the report's own integrity ordering depends on, and none of it yet exists in `src/**`.

---

## 19. Blocking open decisions

**BLOCKING OPEN ARCHITECTURE DECISIONS: NONE** (as of Amendment 3).

Four decisions originally left open, or newly identified, are now resolved by fresh, explicitly-issued GPT architecture decisions — none by this document reconstructing or inferring an answer on its own:

1. **Presentation label vocabulary** — resolved in §11.1/§11.2. The underlying historical `§26` citation (`REVISION_VERIFICATION_CONTRACT.md` §19) remains genuinely unrecoverable from repository authority (§12) — that finding is superseded for P2-C's purposes, not solved by reconstruction.
2. **`FINDING`-only `RevisionAction` coverage** — resolved in §13. `allRevisionActions` is now a required part of the minimum P2-C contract, not an open interface-shape question.
3. **`RevisionAction` provenance trust boundary (Amendment 2)** — resolved in §3a.1–§3a.9: `assertRevisionActionLedgerIntegrity` is frozen as the canonical validator, `cloneRevisionSourceRef` as the frozen ingress-fix, and its write/read/report/egress composition points are all specified.
4. **`HumanAdjudication` upstream authority chain (Amendment 3)** — resolved in §3a.0: `assertHumanAdjudicationLedgerIntegrity` is frozen as the canonical upstream validator, composed as the mandatory first step inside `assertRevisionActionLedgerIntegrity`, with its own write-boundary (`adjudicate`) and transitive report-boundary (§3a.8a) composition points specified.

No other schema, validator, or ordering question in this document is left open — §3a/§4/§7/§9/§10/§11 are each resolved with a stated recommendation and rationale. One related, pre-existing gap is recorded — not resolved — as tracked debt below.

**However, "no blocking architecture decision" is not "cleared to build the report."** P2-C's own IntegratedDecisionReport runtime remains **blocked** until the RevisionAction Provenance Hardening runtime (§3a, §18 item 1) is separately authorized, implemented, and accepted — see §18a's frozen sequencing. This is a sequencing/dependency gate, not an open decision: nothing about *what* to build is undecided, only *when* the second slice may begin.

---

## 19a. Known product-complete report debt (R-1)

Recorded per explicit instruction; **not solved by this amendment or by P2-C's scope.**

Confirmed by direct inspection: `IntegratedDecisionReport` — unlike the older `DecisionRecord`, which has `standaloneFindingAdjudications` (`decision-record.ts:43-50`, `137-149`) — has **no equivalent top-level presentation** for a `HumanAdjudication` recorded directly against a bare `ReviewFinding` that was never wrapped in a `SemanticIssue`. `IntegratedDecisionReportIssue` exists only per semantic issue; no other exported type in `decision-record.ts` carries a per-adjudicated-finding detail object. `IntegratedDecisionReport` remains primarily issue-centric for review/adjudication detail — a gap that pre-dates and is entirely independent of everything P2 introduces.

**PRODUCT-COMPLETE REPORT DEBT R-1:** this is **not** a blocker to wiring `allRevisionActions`/`revisionSuccessor`/verification presentation (§11/§13) — those attach to `RevisionAction`, which already carries its own `sourceRefs` regardless of whether the motivating adjudication was issue- or finding-level. It is recorded here because the current product direction is to complete CHIEF V1 before real-user validation: this debt must be reconciled — either a bare-finding-adjudication top-level presentation is added to `IntegratedDecisionReport`, or an explicit, deliberate decision is made that it is out of scope for V1 — **before CHIEF V1 is declared PRODUCT COMPLETE.** It is out of scope for the P2-C runtime slice this document otherwise authorizes.

---

## 20. Professional recommendation

**(Amendment 1.)** 兩個原本阻塞的決策現在都已凍結，但這次修訂引入了一項新的實作紀律要求：`allRevisionActions` 與 `issues[].revisionActions` 必須共用同一個 per-action 投影函式（§7 Step H/I、§13）。建議未來 P2-C 實際落地時，把「兩個陣列對同一筆 RevisionAction 永遠回傳完全相同物件」這條測試寫在最前面，先鎖死「只能有一個真相來源」這個新規則，再接著補完 successor/verification 的完整性測試——這樣可以避免測試套件在兩份投影邏輯已經分岔之後，才被動地去追殺分岔的結果。

**（Amendment 2。）** 建議把 §18a 的兩階段驗收順序視為硬性規定，而不只是建議：先驗收 RevisionAction Provenance Hardening（`assertRevisionActionLedgerIntegrity` + ingress/egress clone），單獨跑完 §3a.9 列出的全部對抗性測試並取得驗收，再開始動 `generateIntegratedDecisionReport` 的簽章與投影邏輯。原因是 §7 Step C 是後面所有 successor/verification 檢查的前置條件——如果兩個切片被壓縮成一次驗收，一旦報表層測試通過，很容易誤以為 provenance 邊界也一併被驗證過，但實際上那是兩組完全獨立的正確性斷言。

**（Amendment 3。）** 建議在同一個 hardening 切片裡，先寫 `assertHumanAdjudicationLedgerIntegrity`（§3a.0）本身的對抗性測試（N–X），確認它單獨正確之後，才寫依賴它的 `assertRevisionActionLedgerIntegrity` 組合測試（Y–AB）。原因是這次修訂新增的是一條「上游先驗證」的鏈路——如果測試撰寫順序反過來（先測 RevisionAction 層、再回頭補 HumanAdjudication 層），很容易寫出「表面上兩層都測到了，但其實只驗證了組合後的整體行為，從未單獨證明過上游驗證器本身在各種畸形輸入下的行為」這種測試債，而這正是本次修正包§4「Global integrity before local authorization」這條規則最容易在測試層被架空的方式。

## 21. Counterintuitive observation

這次調查裡最值得注意的發現,不是「報表少了什麼功能」,而是「報表原本就已經展示的東西,其實已經悄悄地在說謊」:`summary.revisionActionsImplemented` 這個彙總數字,從一開始就把 FINDING-only 的 RevisionAction 算進去了(因為它是對全部 `session.revisionActions` 計數,不分 sourceRef 種類),但同一份報表的詳細畫面卻完全不會顯示那筆記錄本身。也就是說,在 P2-C 讓這個問題變得更嚴重之前,P1 現在的行為就已經是「數字說有,細節說沒有」——這不是 P2-C 引入的新風險,而是一個已經存在、只是直到現在才被系統性地檢查出來的既有落差。**（Amendment 1 已將此落差正式列為必須解決項目：§13 的 `allRevisionActions` 決定即是對這個觀察的直接回應。）**

**（Amendment 2。）** 更值得注意的是：Amendment 1 原本打算讓 `allRevisionActions[].sourceRefs` 承載「權威 provenance」，但當時完全沒有人問過一個更早的問題——`RevisionAction.sourceRefs` 從被 `planRevisionAction` 寫入的那一刻起，本來就沒有真正屬於自己過。`sourceRefs: [...input.sourceRefs]` 這行程式碼看起來完全正常（甚至是這整個檔案裡最不起眼的一行），但它從一開始就只複製了陣列容器，從未複製容器裡的物件本身。也就是說，在追問「報表要不要把 provenance 秀出來」之前，其實還有一個更根本、更早就該問的問題：「這個 provenance 從被寫入的第一天起，究竟屬不屬於 domain 自己？」這次修訂能發現這件事，不是因為 P2-C 的報表設計特別縝密，而是因為要替一個新功能設計信任邊界時，反而照出了一個與這個新功能完全無關、卻已經存在了好幾個切片的舊缺口。

**（Amendment 3。）** 這次的模式又重演了一次，而且重演的方式很值得記住：Amendment 2 才剛凍結了「`RevisionAction` 的 provenance 必須被驗證」，結果馬上就發現這個驗證本身的最後一步——「有沒有一個 `actionChange === 'YES'` 的 adjudication」——所倚賴的 `session.adjudications` 帳本，從 Slice 1 開始就從來沒有自己的後讀驗證器。換句話說，每往上游追一層信任鏈，就會撞到另一層「寫入時規則完備、但讀取時從未被獨立驗證過」的既有帳本。這暗示一件事：這一系列 P2-C0 修正案真正在做的，不是「幫 RevisionAction 補一個驗證器」，而是在系統性地問「這條信任鏈最終依賴的每一個帳本，是否都有自己的 later-read 邊界」——而目前為止，答案在每一層都是「沒有，直到現在才補上」。這也是為什麼 §19a（PRODUCT-COMPLETE REPORT DEBT R-1）標記的那個 standalone-FINDING-adjudication 缺口特別值得警惕：它極可能不是這條鏈上最後一個沒有後讀驗證器的既有帳本。
