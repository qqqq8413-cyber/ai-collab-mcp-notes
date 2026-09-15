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
Step C. determine "successor authority in play" =
          session.revisionSuccessor !== null
          OR Object.keys(session.revisionVerifications).length > 0
          OR successorSession !== undefined
Step D. if authority is in play (Step C) and successorSession is undefined:
          FAIL CLOSED (explicit "successorSession required" error) before any further step
Step E. if successorSession supplied / authority in play:
          assertRevisionSuccessorIntegrity(session, successorSession)
Step F. if Object.keys(session.revisionVerifications).length > 0:
          assertRevisionVerificationLedgerIntegrity(session)     [promoted to exported — see §9, "new public aggregate validator"]
Step G. only after A–F succeed without throwing:
          build the COMPLETE allRevisionActions projection (§13) — every
          session.revisionActions entry, via one shared projection
          function, never filtered by sourceRefs kind
Step H. derive issues[].revisionActions from the SAME projection
          function/semantics as Step G, filtered to SEMANTIC_ISSUE-linked
          entries only — never a second, independently-written mapping (§13)
Step I. only then build and return the final IntegratedDecisionReport value
```

(Amendment 1 renumbers the original Step D/E/F into D–I above to make room for the explicit fail-closed step and the shared-projection requirement; no governing rule from the original ordering is weakened, only made more precise.)

This is **global integrity before local filtering**: every existing ledger record is validated once, up front, regardless of which RevisionActions the caller will end up looking at — never only the ones that happen to be displayed (§10/§22.I of the governing packet).

---

## 8. Zero-verification handling

CASE 4 in §6. When `session.revisionVerifications` is empty, `assertRevisionVerificationIntegrity(sourceSession, successorSession, id)` cannot be called at all — there is no `id` to pass, and the governing packet explicitly forbids fabricating one merely to make a validator callable (§11 of the governing packet). The correct minimum path is: run **only** `assertRevisionSuccessorIntegrity(session, successorSession)` (Step E). Step F is skipped entirely — an empty ledger trivially satisfies whole-ledger integrity by having nothing to violate it. No new validator or special-case function is needed for this case.

---

## 9. Non-empty verification-ledger handling

Three strategies were evaluated (governing packet §12):

**A — call `assertRevisionVerificationIntegrity` once per stored id.** Correct, but each call independently re-runs `assertRevisionSuccessorIntegrity` **and** the full ledger scan, so N stored records means the successor-binding check and the full-ledger scan each run N times. At first-pilot cardinality (a handful of RevisionActions per session) this is not a real performance concern (per §12's own instruction not to prematurely optimize), but it is architecturally redundant.

**A′ — call `assertRevisionVerificationIntegrity` once, with an arbitrarily chosen existing id, purely to trigger its internal global scan.** Rejected: this repurposes a function whose documented contract is "verify *this one* record" for an undocumented side effect (that its internals happen to scan globally first). It is a fragile, implicit coupling — if that function's internals ever stopped scanning globally up front, this trick would silently stop providing the guarantee the report relies on. It also has no principled way to choose *which* id to pass, which brushes against the "no first/latest heuristic" spirit of §4.G even though that clause is literally about successor selection, not this.

**B — export the existing internal `assertRevisionVerificationLedgerIntegrity(sourceSession)` as public API, with no signature or logic change at all.** It already does exactly and only what Step F needs — a pure structural/provenance scan over `sourceSession.revisionVerifications` against `sourceSession.revisionActions`, requiring no `successorSession` argument at all (confirmed by direct inspection: the function never references `successorSession`). Making it `export function` instead of `function` is the entire change.

**Recommendation: B.** This is not "exporting an internal helper merely for convenience" (governing packet §5's caution) — there is a concrete correctness need: without it, the only way to achieve whole-ledger validation using solely already-public functions is strategy A′, which is a worse design than simply exposing the one function that already, correctly, does the job. **New public aggregate validator required: YES — but it is a one-line visibility change to code that already exists, not new logic.**

**Amendment 1 — explicit boundary statement (must be documented verbatim in the future runtime, not merely implied):** `assertRevisionVerificationLedgerIntegrity` alone is **NOT SUFFICIENT** to trust or display a `RevisionVerification`. It validates only the source session's verification ledger against that same session's `revisionActions` — it says nothing about whether `successorSession` is genuinely `sourceSession`'s authoritative V1. The report's trust boundary is always the ordered pair:

```
assertRevisionSuccessorIntegrity(sourceSession, successorSession)
  THEN
assertRevisionVerificationLedgerIntegrity(sourceSession)
```

never the ledger check alone. This is already the exact order Step E→Step F (§7) enforces; this paragraph exists so a future reader of the promoted-to-public function cannot mistake it for a self-sufficient check.

---

## 10. RevisionAction → RevisionVerification cardinality (projection)

Accepted domain cardinality: 0..1 (unchanged, P2-B). After Step E (§7) has globally validated the ledger — which already makes a duplicate `revisionActionId` structurally impossible to survive — the per-RevisionAction projection step must still not use a bare `.find()` (governing packet §13's explicit instruction). Minimum recommended pattern:

```ts
const matches = Object.values(session.revisionVerifications).filter(
  (v) => v.revisionActionId === action.id
);
if (matches.length > 1) {
  throw new Error(`... more than one RevisionVerification for revisionActionId ${action.id}`);
}
const verification = matches[0] ?? null;
```

This is defense-in-depth, not redundant paranoia: it keeps the projection step's own correctness independent of Step F's implementation detail, exactly mirroring how `assertRevisionSuccessorIntegrity`/`assertRevisionVerificationIntegrity` themselves never rely on "the global check already ran" as an excuse to skip a local structural check. This exact lookup belongs inside the one shared per-action projection function §13 (Amendment 1) requires — it must not be reimplemented separately for `allRevisionActions` versus `issues[].revisionActions`.

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

- `revisionSuccessor` is `null` exactly when `session.revisionSuccessor === null`; non-null **only** after `assertRevisionSuccessorIntegrity` has succeeded (Step E, §7), and its two fields are read from the **actual validated `successorSession` object**, never copied from the stored `RevisionSuccessorBinding` alone — a corrupted state could in principle have the binding disagree with the object actually supplied, and this field must reflect what was proven, not what was merely stored (§15).
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

`issues[].revisionActions` is **retained, unchanged in shape**, for backward compatibility — still filtered to `SEMANTIC_ISSUE`-linked entries only. The future P2-C runtime **must** derive both `allRevisionActions` and `issues[].revisionActions` from one shared per-action projection function (build the full `IntegratedDecisionReportRevisionAction` object once per `RevisionAction`, then filter the already-built list two ways) — never two independently-written semantic mappings that could silently drift apart (governing amendment §7, Step G/H). This is also the exact mechanism that finally reconciles the discrepancy this document's own §21 (Counterintuitive observation) identified: `summary.revisionActionsImplemented` already counts `FINDING`-only actions, and now the detail view will too.

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

The dividing line is exactly what P2-A/P2-B's own canonical validators already enforce — §7's Step E/F ordering is what carries that same dividing line into report generation, rather than the report re-deriving its own, possibly weaker, notion of "corrupted."

---

## 16. Counterexample matrix

| # | State | Legal? | What is displayed | Canonical validator | New decision required? |
|---|---|---|---|---|---|
| A | `IMPLEMENTED` RA, no successor | Yes | Null verification state | none (successor authority not in play) | No |
| B | successor exists, no verification | Yes | `NO_VERIFICATION_RECORDED` (§11.1), `report.revisionSuccessor` populated | `assertRevisionSuccessorIntegrity` | No (label text frozen, §11.2) |
| C | `VERIFIED_PRESENT` with exact correct successor | Yes | verdict/evidence/`verifiedAt` shown, `report.revisionSuccessor` identifies exact V1 | `assertRevisionSuccessorIntegrity` + ledger integrity | No |
| D | `NOT_PRESENT` exists | Yes | same as C, verdict `NOT_PRESENT` | same as C | No |
| E | `INCONCLUSIVE` exists | Yes | same as C, verdict `INCONCLUSIVE` | same as C | No |
| F | verification exists, successor omitted | No | — (throws) | report's own required-parameter check (§5/§7 Step D) | No |
| G | verification exists, unrelated successor supplied | No | — (throws) | `assertRevisionSuccessorIntegrity` (successorSessionId mismatch) | No |
| H | verification exists, binding successor hash tampered | No | — (throws) | `assertRevisionSuccessorIntegrity` (hash cross-check / `verifyFrozenInputIntegrity`) | No |
| I | hidden unrelated corrupt record, displayed one looks valid | No | — (throws, whole report) | ledger integrity (Step F), global-before-local | No |
| J | duplicate records for same RA | No | — (throws, whole report) | ledger integrity (Step F), cardinality check | No |
| K | verification references another session's RA id | No | — (throws, whole report) | ledger integrity (Step F), resolution against exact `sourceSession` | No |
| L | binding/successor self-consistent, violates semantic-copy policy | No | — (throws) | `assertRevisionSuccessorIntegrity` (semantic-copy check) | No |
| M | caller supplies successor, no `RevisionSuccessorBinding` exists | No | — (throws) | `assertRevisionSuccessorIntegrity` (`revisionSuccessor===null`) — requires unconditional validation whenever supplied (§5) | No |
| N | `RevisionAction` linked only to `FINDING` | Legal to verify; now presentable via `allRevisionActions` (§13) | Appears in `allRevisionActions` with its own `sourceRefs`; still absent from `issues[].revisionActions` (unchanged, by design) | n/a — resolved by the shared-projection top-level array, not a corruption case | **No — resolved, §13 (Amendment 1)** |

Every counterexample is now fully resolved by existing, accepted P2-A/P2-B validators once the report calls them in the order fixed in §7 (A–I) — no new validation logic is required anywhere in this matrix beyond the report's own required-parameter check (Step D) and the shared-projection mechanism (Step G/H) that closes N.

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

---

## 18. Minimum future P2-C runtime file scope

If/when a P2-C runtime packet is authorized:

1. `src/stress-test/session.ts` — one-line visibility change: `function assertRevisionVerificationLedgerIntegrity` → `export function assertRevisionVerificationLedgerIntegrity`. No logic change.
2. `src/stress-test/decision-record.ts` — extend `generateIntegratedDecisionReport`'s signature (§5); implement the integrity-ordering steps A–I (§7); add `IntegratedDecisionReportRevisionVerificationState` and its mapping/labels (§11.1/§11.2); extend `IntegratedDecisionReportRevisionAction` with `sourceRefs`/`verificationState`/verification fields (§11.3); add the top-level `allRevisionActions` array and `revisionSuccessor` field to `IntegratedDecisionReport` (§11.4/§13 — now a required part of this contract, no longer contingent); implement `allRevisionActions` and `issues[].revisionActions` as two filters over one shared per-action projection function (§13), never two independently-written mappings.
3. `src/stress-test/types.ts` — no change anticipated; `RevisionVerificationVerdict`/`RevisionVerification` already live there (P2-B) and `IntegratedDecisionReport*` types live in `decision-record.ts`, matching existing P1 precedent.
4. `src/stress-test/deliberation.ts`, `hash.ts`, `index.ts` — no change anticipated. `index.ts` already wildcard-re-exports `decision-record.js`/`session.js`, so any newly-exported symbol above surfaces automatically (confirmed precedent from P2-A/P2-B).
5. `test-stress-test-decision-record.mjs` — new tests covering the requiredness matrix (§6) and counterexample matrix (§16); out of scope for this document (docs-only, no test authorization).

---

## 19. Blocking open decisions

**BLOCKING OPEN DECISIONS: NONE** (as of Amendment 1).

Both decisions originally left open here are now resolved by fresh, explicitly-issued GPT architecture decisions — neither by this document reconstructing or inferring an answer on its own:

1. **Presentation label vocabulary** — resolved in §11.1/§11.2. The underlying historical `§26` citation (`REVISION_VERIFICATION_CONTRACT.md` §19) remains genuinely unrecoverable from repository authority (§12) — that finding is superseded for P2-C's purposes, not solved by reconstruction.
2. **`FINDING`-only `RevisionAction` coverage** — resolved in §13. `allRevisionActions` is now a required part of the minimum P2-C contract, not an open interface-shape question.

No other schema, validator, or ordering question in this document is left open — §4/§7/§9/§10/§11 are each resolved with a stated recommendation and rationale. One related, pre-existing gap is recorded — not resolved — as tracked debt below.

---

## 19a. Known product-complete report debt (R-1)

Recorded per explicit instruction; **not solved by this amendment or by P2-C's scope.**

Confirmed by direct inspection: `IntegratedDecisionReport` — unlike the older `DecisionRecord`, which has `standaloneFindingAdjudications` (`decision-record.ts:43-50`, `137-149`) — has **no equivalent top-level presentation** for a `HumanAdjudication` recorded directly against a bare `ReviewFinding` that was never wrapped in a `SemanticIssue`. `IntegratedDecisionReportIssue` exists only per semantic issue; no other exported type in `decision-record.ts` carries a per-adjudicated-finding detail object. `IntegratedDecisionReport` remains primarily issue-centric for review/adjudication detail — a gap that pre-dates and is entirely independent of everything P2 introduces.

**PRODUCT-COMPLETE REPORT DEBT R-1:** this is **not** a blocker to wiring `allRevisionActions`/`revisionSuccessor`/verification presentation (§11/§13) — those attach to `RevisionAction`, which already carries its own `sourceRefs` regardless of whether the motivating adjudication was issue- or finding-level. It is recorded here because the current product direction is to complete CHIEF V1 before real-user validation: this debt must be reconciled — either a bare-finding-adjudication top-level presentation is added to `IntegratedDecisionReport`, or an explicit, deliberate decision is made that it is out of scope for V1 — **before CHIEF V1 is declared PRODUCT COMPLETE.** It is out of scope for the P2-C runtime slice this document otherwise authorizes.

---

## 20. Professional recommendation

**(Amendment 1.)** 兩個原本阻塞的決策現在都已凍結，但這次修訂引入了一項新的實作紀律要求：`allRevisionActions` 與 `issues[].revisionActions` 必須共用同一個 per-action 投影函式（§7 Step G/H、§13）。建議未來 P2-C 實際落地時，把「兩個陣列對同一筆 RevisionAction 永遠回傳完全相同物件」這條測試寫在最前面，先鎖死「只能有一個真相來源」這個新規則，再接著補完 successor/verification 的完整性測試——這樣可以避免測試套件在兩份投影邏輯已經分岔之後，才被動地去追殺分岔的結果。

## 21. Counterintuitive observation

這次調查裡最值得注意的發現,不是「報表少了什麼功能」,而是「報表原本就已經展示的東西,其實已經悄悄地在說謊」:`summary.revisionActionsImplemented` 這個彙總數字,從一開始就把 FINDING-only 的 RevisionAction 算進去了(因為它是對全部 `session.revisionActions` 計數,不分 sourceRef 種類),但同一份報表的詳細畫面卻完全不會顯示那筆記錄本身。也就是說,在 P2-C 讓這個問題變得更嚴重之前,P1 現在的行為就已經是「數字說有,細節說沒有」——這不是 P2-C 引入的新風險,而是一個已經存在、只是直到現在才被系統性地檢查出來的既有落差。**（Amendment 1 已將此落差正式列為必須解決項目：§13 的 `allRevisionActions` 決定即是對這個觀察的直接回應。）**
