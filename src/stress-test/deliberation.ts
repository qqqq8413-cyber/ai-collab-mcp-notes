/**
 * Minimum Necessary Deliberation — offline routing/audit foundation (Slice 2A).
 *
 * Implements the pure domain layer described in
 * MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md: the six routes, the
 * deterministic root-cause -> route mapping, a DeliberationState kept
 * strictly separate from StressTestSession, fail-closed session/hash
 * binding, finite budget accounting, and the pure ADD_CONTEXT
 * ContextRequest shape. No route executes anything here — a RouteDecision
 * records "this is the justified next route", never "the route has run".
 *
 * This module imports `verifyFrozenInputIntegrity` (read-only) from
 * session.ts, plus -- as of Slice 2D-C3 -- `createSession`/
 * `addAuthorContextItem`/`freezeInput`, used only inside
 * `createCrossSessionTransition` to construct Session B from existing,
 * already-accepted session-construction primitives (never by duplicating
 * their logic here). It never imports `adjudicate`, `planRevisionAction`,
 * `implementRevisionAction`, or `rejectRevisionAction`, so nothing here can
 * create HumanAdjudication authority or RevisionAction against either
 * session: that boundary (HumanAdjudication.actionChange=YES ->
 * RevisionAction) remains structurally unreachable from this file, not
 * merely undocumented.
 */
import { randomUUID } from 'node:crypto';
import type { AuthorContextItem, StressTestSession } from './types.js';
import { addAuthorContextItem, createSession, freezeInput, verifyFrozenInputIntegrity } from './session.js';

const nowIso = () => new Date().toISOString();

export type DeliberationRoute =
  | 'STOP'
  | 'ADD_CONTEXT'
  | 'ADD_REVIEWER'
  | 'REPLICATE'
  | 'SEEK_EVIDENCE'
  | 'TARGETED_PEER_CHALLENGE';

export type RootCauseCategory =
  | 'NONE'
  | 'CONTEXT_GAP'
  | 'EVIDENCE_GAP'
  | 'STABILITY_QUESTION'
  | 'COVERAGE_GAP'
  | 'DECISION_SENSITIVE_CONFLICT';

/** Runtime allowlist mirroring the RootCauseCategory union — same rationale as STOP_REASONS below: a plain-JS caller has no compile-time check. */
const ROOT_CAUSES: readonly RootCauseCategory[] = [
  'NONE',
  'CONTEXT_GAP',
  'EVIDENCE_GAP',
  'STABILITY_QUESTION',
  'COVERAGE_GAP',
  'DECISION_SENSITIVE_CONFLICT',
];

/** Deterministic, exhaustive root-cause -> route mapping (MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md §5). */
export function routeForRootCause(rootCause: RootCauseCategory): DeliberationRoute {
  switch (rootCause) {
    case 'NONE':
      return 'STOP';
    case 'CONTEXT_GAP':
      return 'ADD_CONTEXT';
    case 'EVIDENCE_GAP':
      return 'SEEK_EVIDENCE';
    case 'STABILITY_QUESTION':
      return 'REPLICATE';
    case 'COVERAGE_GAP':
      return 'ADD_REVIEWER';
    case 'DECISION_SENSITIVE_CONFLICT':
      return 'TARGETED_PEER_CHALLENGE';
    default: {
      const exhaustive: never = rootCause;
      throw new Error(`routeForRootCause: unhandled root cause ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Explicit, discriminated reference to whatever motivated a route — never
 * inferred from the shape of `id` (no UUID-shape or prefix inference),
 * mirroring the RevisionSourceRef pattern already hardened in session.ts.
 */
export type RouteInputRef =
  | { kind: 'FINDING'; id: string }
  | { kind: 'SEMANTIC_ISSUE'; id: string }
  | { kind: 'AUTHOR_CONTEXT_ITEM'; id: string };

const AUTHOR_CONTEXT_CATEGORIES = ['confirmedFacts', 'knownRisks', 'openQuestions', 'constraints'] as const;

/** Fails closed on an unknown or ambiguous reference — never guesses. */
export function validateRouteInputRef(session: StressTestSession, ref: RouteInputRef): void {
  if (ref.kind === 'FINDING') {
    if (!session.findings[ref.id]) {
      throw new Error(`validateRouteInputRef: unknown FINDING id ${ref.id}`);
    }
    return;
  }
  if (ref.kind === 'SEMANTIC_ISSUE') {
    if (!session.semanticIssues[ref.id]) {
      throw new Error(`validateRouteInputRef: unknown SEMANTIC_ISSUE id ${ref.id}`);
    }
    return;
  }
  if (ref.kind === 'AUTHOR_CONTEXT_ITEM') {
    const matches = AUTHOR_CONTEXT_CATEGORIES.filter((category) =>
      session.authorContext[category].some((item) => item.id === ref.id)
    );
    if (matches.length === 0) {
      throw new Error(`validateRouteInputRef: unknown AUTHOR_CONTEXT_ITEM id ${ref.id}`);
    }
    if (matches.length > 1) {
      throw new Error(
        `validateRouteInputRef: ambiguous AUTHOR_CONTEXT_ITEM id ${ref.id} found in multiple categories (${matches.join(', ')})`
      );
    }
    return;
  }
  const exhaustive: never = ref;
  throw new Error(`validateRouteInputRef: invalid ref kind ${JSON.stringify((exhaustive as { kind: unknown }).kind)}`);
}

/**
 * Order-sensitive exact comparison: both length, and each position's
 * `kind`+`id`, must match. Deliberately no sorting, normalizing, or
 * deduplication — a reordered or set-equal-but-reordered ref list is
 * treated as a mismatch, not silently accepted. Set semantics would be a
 * separate, explicit architecture redesign, not a default here.
 */
function refsExactlyMatch(a: RouteInputRef[], b: RouteInputRef[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((ref, index) => ref.kind === b[index].kind && ref.id === b[index].id);
}

/**
 * Independent, freshly-allocated copy of one RouteInputRef -- never the
 * caller-owned object. Explicit per-kind construction (not a generic
 * object-literal spread) so the result stays exhaustively typed as
 * RouteInputRef rather than a widened `{kind: string; id: string}`.
 */
function cloneRouteInputRef(ref: RouteInputRef): RouteInputRef {
  switch (ref.kind) {
    case 'FINDING':
      return { kind: 'FINDING', id: ref.id };
    case 'SEMANTIC_ISSUE':
      return { kind: 'SEMANTIC_ISSUE', id: ref.id };
    case 'AUTHOR_CONTEXT_ITEM':
      return { kind: 'AUTHOR_CONTEXT_ITEM', id: ref.id };
    default: {
      const exhaustive: never = ref;
      throw new Error(`cloneRouteInputRef: invalid ref kind ${JSON.stringify((exhaustive as { kind: unknown }).kind)}`);
    }
  }
}

function cloneRouteInputRefs(refs: RouteInputRef[]): RouteInputRef[] {
  return refs.map(cloneRouteInputRef);
}

export type StopReason =
  | 'successful'
  | 'budget'
  | 'latency'
  | 'no_eligible_route'
  | 'unresolved_but_human_decidable'
  | 'failure_fallback';

/** Runtime allowlist mirroring the StopReason union — a plain-JS caller has no compile-time check, so an unrecognized string must be rejected here, not just at the type level. */
const STOP_REASONS: readonly StopReason[] = [
  'successful',
  'budget',
  'latency',
  'no_eligible_route',
  'unresolved_but_human_decidable',
  'failure_fallback',
];

/** Root-cause classification plus the (already-made) materiality justification. This module enforces structure, not classification — no AI classifier, no numeric score, no inference from finding count/evidenceState/complexity. */
export interface RouteReason {
  rootCause: RootCauseCategory;
  materialityReason: string;
}

/** A still-open material item, pointing back to domain objects by RouteInputRef rather than duplicating them. */
export interface UnresolvedQuestion {
  id: string;
  inputRefs: RouteInputRef[];
  rootCause: RootCauseCategory;
  materialityReason: string;
  createdAt: string;
  /**
   * `null` for an originally-created question. Non-null only for a direct
   * replacement created through the atomic `SUPERSEDED_RECLASSIFIED`
   * transition (`recordQuestionDisposition`) -- never through ordinary
   * `registerUnresolvedQuestion`
   * (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §9, Slice 2D-B2-B0/B2-B).
   * A question predating this field may lack the key entirely; read it via
   * `effectiveDerivedFromQuestionId`, never this property directly, unless
   * the value is already known-canonical.
   */
  derivedFromQuestionId: string | null;
}

/**
 * "This is the justified next route" — never "the route has executed".
 *
 * `questionId` binds a non-STOP decision to the exact UnresolvedQuestion
 * it targets, so a decision can never be constructed against domain refs
 * that merely happen to be valid without proving the corresponding routing
 * question was actually registered first. STOP is a session-level
 * terminal decision, not a response to any one question, so its
 * `questionId` is always `null` — never a fabricated NONE question id.
 */
export interface RouteDecision {
  id: string;
  route: DeliberationRoute;
  reason: RouteReason;
  inputRefs: RouteInputRef[];
  questionId: string | null;
  createdAt: string;
}

/** Every route except STOP -- STOP has no RouteAttempt (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §5). */
export type NonStopDeliberationRoute = Exclude<DeliberationRoute, 'STOP'>;

/** Runtime allowlist mirroring NonStopDeliberationRoute -- a plain-JS caller has no compile-time check. */
const NON_STOP_ROUTES: readonly NonStopDeliberationRoute[] = [
  'ADD_CONTEXT',
  'ADD_REVIEWER',
  'REPLICATE',
  'SEEK_EVIDENCE',
  'TARGETED_PEER_CHALLENGE',
];

/**
 * The immutable fact that one authorized, already-recorded RouteDecision
 * has begun execution -- recorded BEFORE any external/human mechanism runs,
 * so a crash after execution starts still leaves an auditable proof the
 * attempt was begun (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §5). A
 * start-only record: it carries no `completedAt`, `status`, outcome,
 * latency, or result payload -- those belong exclusively to a future
 * RouteOutcome (§7). Never mutated once created. Because no RouteOutcome
 * runtime exists yet, every RouteAttempt in this slice is, by construction,
 * open/unterminated (§5, §14) -- that is expected, not an error.
 */
export interface RouteAttempt {
  attemptId: string;
  decisionId: string;
  questionId: string;
  route: NonStopDeliberationRoute;
  sessionId: string;
  artifactHash: string;
  authorContextHash: string;
  startedAt: string;
  logicalCost: number;
}

/** The closed, three-value technical-completion classification of one terminal RouteAttempt (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §6). */
export type AttemptStatus = 'SUCCEEDED' | 'FAILED' | 'INCONCLUSIVE';

/** Runtime allowlist mirroring AttemptStatus -- a plain-JS caller has no compile-time check. */
const ATTEMPT_STATUSES: readonly AttemptStatus[] = ['SUCCEEDED', 'FAILED', 'INCONCLUSIVE'];

function assertValidAttemptStatus(status: AttemptStatus, label: string): void {
  if (!ATTEMPT_STATUSES.includes(status)) {
    throw new Error(`${label}: invalid AttemptStatus ${JSON.stringify(status)}`);
  }
}

/** The closed, provider-neutral failure-category vocabulary (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §7). */
export type FailureCategory = 'TRANSPORT' | 'VALIDATION' | 'REFERENCE_RESOLUTION' | 'EXECUTION';

const FAILURE_CATEGORIES: readonly FailureCategory[] = ['TRANSPORT', 'VALIDATION', 'REFERENCE_RESOLUTION', 'EXECUTION'];

/** Implementation hard cap for audit safety, not a provider-specific policy. Messages over this length are rejected, never truncated. */
const FAILURE_MESSAGE_MAX_CHARS = 2000;

/**
 * Generic, provider-neutral failure payload. Exactly `{ category, message }`
 * -- never a stack trace, request header, API key, raw SDK error object, or
 * any other field. `message` is a sanitized, bounded, human-readable
 * explanation; sanitizing actual secrets out of it is the caller/execution
 * layer's responsibility before this domain API is ever called.
 */
export interface FailureInfo {
  category: FailureCategory;
  message: string;
}

function assertValidFailureInfo(failure: FailureInfo, label: string): void {
  if (failure === null || typeof failure !== 'object') {
    throw new Error(`${label} must be an object`);
  }
  assertExactKeys(failure, ['category', 'message'], label);
  if (!FAILURE_CATEGORIES.includes(failure.category)) {
    throw new Error(`${label}.category: invalid FailureCategory ${JSON.stringify(failure.category)}`);
  }
  if (typeof failure.message !== 'string' || failure.message.trim().length === 0) {
    throw new Error(`${label}.message must be a non-empty string`);
  }
  if (failure.message.length > FAILURE_MESSAGE_MAX_CHARS) {
    throw new Error(`${label}.message exceeds ${FAILURE_MESSAGE_MAX_CHARS} characters`);
  }
}

/** Independent snapshot of a FailureInfo -- never the caller-owned object. */
function cloneFailureInfo(failure: FailureInfo): FailureInfo {
  return { category: failure.category, message: failure.message };
}

/** Closed, three-value REPLICATE result vocabulary -- all determinate; none maps to INCONCLUSIVE (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §13.C). */
export type ReplicationResult = 'REPRODUCED' | 'NOT_REPRODUCED' | 'PARTIAL';

const REPLICATION_RESULTS: readonly ReplicationResult[] = ['REPRODUCED', 'NOT_REPRODUCED', 'PARTIAL'];

function assertValidReplicationResult(result: ReplicationResult, label: string): void {
  if (!REPLICATION_RESULTS.includes(result)) {
    throw new Error(`${label}: invalid ReplicationResult ${JSON.stringify(result)}`);
  }
}

/**
 * Common fields every RouteOutcome carries, regardless of route/status
 * (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §7's generic envelope).
 * `attemptId` is RouteOutcome's own identity -- no separate `outcomeId`,
 * since one RouteAttempt has at most one RouteOutcome. `logicalCost` is
 * always a copied audit mirror of the terminated RouteAttempt's own
 * `logicalCost`, never caller input. `completedAt` is runtime-generated:
 * the time this domain runtime defensibly recorded the outcome, not a
 * claimed provider-side completion time.
 */
interface RouteOutcomeCommon {
  attemptId: string;
  decisionId: string;
  originatingQuestionId: string;
  route: NonStopDeliberationRoute;
  sessionId: string;
  artifactHash: string;
  authorContextHash: string;
  completedAt: string;
  status: AttemptStatus;
  logicalCost: number;
  latencyConsumed: number;
}

/** The immutable terminal record for an attempt whose mechanism did not produce a valid route-specific result. Recordable for any non-STOP route. */
export interface FailedRouteOutcome extends RouteOutcomeCommon {
  status: 'FAILED';
  failure: FailureInfo;
}

/** The immutable terminal record for a successful ADD_REVIEWER attempt. `findingIds` may be empty; every id must resolve in StressTestSession.findings and share `reviewerRunId` (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §7.B). */
export interface AddReviewerRouteOutcome extends RouteOutcomeCommon {
  status: 'SUCCEEDED';
  route: 'ADD_REVIEWER';
  reviewerRunId: string;
  findingIds: string[];
}

/** The immutable terminal record for a successful REPLICATE attempt. `targetRef` must exactly match one of the terminated RouteDecision's own inputRefs (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §7.C). */
export interface ReplicationRouteOutcome extends RouteOutcomeCommon {
  status: 'SUCCEEDED';
  route: 'REPLICATE';
  result: ReplicationResult;
  targetRef: RouteInputRef;
}

/** The full accepted architecture vocabulary for ADD_CONTEXT's human-response mechanism (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §7.A). `NO_RESPONSE`'s explicit closure mechanism is implemented and accepted (Slice 2D-C4) -- it is excluded from `recordRouteOutcome`'s own recordable subset below not because it is unauthorized, but because only the dedicated `closeContextRequestWithoutResponse` operation may ever create it (§ below, decision C). */
export type AddContextResult = 'SUPPLIED' | 'DECLINED' | 'NO_RESPONSE';

/** The immutable terminal record for a successful ADD_CONTEXT attempt whose human context-request mechanism obtained supplied context. `contextRequestId` resolves to the exact `ContextRequest` this outcome answers -- independently re-verified to belong to this same attempt/question/session/hash binding, never trusted merely because a caller supplied a plausible-looking id (Slice 2D-C2). `responseText` is an immutable, provider-neutral response fact; recording it never mutates `AuthorContext` or creates a new session. */
export interface AddContextSuppliedRouteOutcome extends RouteOutcomeCommon {
  status: 'SUCCEEDED';
  route: 'ADD_CONTEXT';
  result: 'SUPPLIED';
  contextRequestId: string;
  responseText: string;
}

/** The immutable terminal record for a successful ADD_CONTEXT attempt whose human explicitly declined to supply the requested context -- itself a determinate, successful completion of the request mechanism, never a failure. No `responseText` and no `declineReason` field. */
export interface AddContextDeclinedRouteOutcome extends RouteOutcomeCommon {
  status: 'SUCCEEDED';
  route: 'ADD_CONTEXT';
  result: 'DECLINED';
  contextRequestId: string;
}

/**
 * The immutable terminal record for an `ADD_CONTEXT` `ContextRequest`
 * explicitly closed by `closeContextRequestWithoutResponse` (Slice 2D-C4)
 * without any `SUPPLIED`/`DECLINED` response having been recorded for its
 * `RouteAttempt` -- an explicit lifecycle closure fact, never an inference
 * from elapsed time (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §13.A,
 * Slice 2D-C4-0 freeze). `status: 'SUCCEEDED'` because the request
 * mechanism itself reached a determinate closure -- no usable context was
 * supplied, but that is not a technical failure. No `responseText` (nothing
 * was supplied); no timeout/deadline/`closureReason`/scheduler field -- the
 * operation's own semantics are the complete reason (decision G).
 */
export interface AddContextNoResponseRouteOutcome extends RouteOutcomeCommon {
  status: 'SUCCEEDED';
  route: 'ADD_CONTEXT';
  result: 'NO_RESPONSE';
  contextRequestId: string;
}

export type AddContextRouteOutcome =
  | AddContextSuppliedRouteOutcome
  | AddContextDeclinedRouteOutcome
  | AddContextNoResponseRouteOutcome;

/**
 * A single, provider-neutral citation supporting/contradicting a
 * `SEEK_EVIDENCE` `EvidenceSubject.claimText` (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md
 * §13.D decision S, Slice 2D-C5-0 freeze). Never a raw provider/SDK object, a
 * retrieved full document, a ranking score, or a query -- `sourceIdentifier`
 * names where the excerpt came from, `excerpt` is the bounded quoted text
 * itself, and `title` is optional descriptive context. No numeric length
 * bound is invented for `excerpt`/`title`, the same "no bound without an
 * analogous, specifically-named justification" reasoning already applied to
 * `materialityReason`/`QuestionDisposition.reason`.
 */
export interface EvidenceCitation {
  sourceIdentifier: string;
  title?: string;
  excerpt: string;
}

/** Closed, three-value SEEK_EVIDENCE result vocabulary (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §13.D decision Q/R). Deliberately never overloaded onto `ReplicationResult`, `AddContextResult`, or `AttemptStatus` -- a separate concept with its own status/result matrix. */
export type SeekEvidenceResult = 'SUPPORTIVE' | 'CONTRADICTORY' | 'INCONCLUSIVE';

/** Runtime allowlist mirroring SeekEvidenceResult -- a plain-JS caller has no compile-time check. */
const SEEK_EVIDENCE_RESULTS: readonly SeekEvidenceResult[] = ['SUPPORTIVE', 'CONTRADICTORY', 'INCONCLUSIVE'];

/**
 * The immutable terminal record for a `SEEK_EVIDENCE` attempt whose evidence
 * relation was determinately established. `evidenceSubjectId` identifies the
 * immutable `EvidenceSubject` this result evaluates -- `claimText`,
 * `originatingFindingId`, `artifactLocation`, and `sourceRef` are never
 * duplicated onto the outcome; every one of those resolves by walking
 * `evidenceSubjectId -> EvidenceSubject`, exactly the "identify the immutable
 * subject, never restate it" discipline `AddContextSuppliedRouteOutcome.contextRequestId`
 * already establishes (§13.D decision Q).
 */
export interface SeekEvidenceSupportiveOrContradictoryRouteOutcome extends RouteOutcomeCommon {
  status: 'SUCCEEDED';
  route: 'SEEK_EVIDENCE';
  result: 'SUPPORTIVE' | 'CONTRADICTORY';
  evidenceSubjectId: string;
  citations: EvidenceCitation[];
}

/** The immutable terminal record for a `SEEK_EVIDENCE` attempt whose evidence relation was not determinately established either way (§13.D decision Q/R). `citations` may be empty -- an inconclusive attempt need not have found anything. */
export interface SeekEvidenceInconclusiveRouteOutcome extends RouteOutcomeCommon {
  status: 'INCONCLUSIVE';
  route: 'SEEK_EVIDENCE';
  result: 'INCONCLUSIVE';
  evidenceSubjectId: string;
  citations: EvidenceCitation[];
}

export type SeekEvidenceRouteOutcome = SeekEvidenceSupportiveOrContradictoryRouteOutcome | SeekEvidenceInconclusiveRouteOutcome;

/** Closed, four-value TARGETED_PEER_CHALLENGE result vocabulary (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §7.E, Slice 2D-B0 final amendment; §13.E, Slice 2D-C6-B). All four map to `AttemptStatus = SUCCEEDED` -- a complete, valid response was produced, regardless of whether it resolves the underlying conflict; none maps to `INCONCLUSIVE` (§6). No result automatically implies any `QuestionDisposition` -- consensus/disagreement is never inferred (§13.E decision, Slice 2D-C6-B). */
export type TargetedPeerChallengeResult = 'REBUTTAL' | 'CONCESSION' | 'QUALIFICATION' | 'REFUSAL_TO_YIELD';

/** Runtime allowlist mirroring TargetedPeerChallengeResult -- a plain-JS caller has no compile-time check. */
const TARGETED_PEER_CHALLENGE_RESULTS: readonly TargetedPeerChallengeResult[] = [
  'REBUTTAL',
  'CONCESSION',
  'QUALIFICATION',
  'REFUSAL_TO_YIELD',
];

/**
 * A bounded quoted excerpt attached to a successful `TARGETED_PEER_CHALLENGE`
 * result -- a product-domain shape, deliberately never importing the
 * experimental `PeerExcerpt`/`buildPeerExcerpt` (`src/agents/collaboration.ts`)
 * directly; `agentId`/`chunkId`/`chunkIndex`/`startChar`/`endChar` are never
 * carried here, the same "paragraph-local identity is not product authority"
 * refusal already applied to `EvidenceCitation` (Slice 2D-C5-0 freeze). The
 * runtime proves only that this payload is structurally self-consistent
 * (`truncated` iff `text.length === charLimit`, and `text.length <=
 * charLimit` always) -- it never proves `text` was truly copied from a
 * provider output, that `truncated` reflects some external hidden source, or
 * that the excerpt semantically belongs to `sourceRef`; those are
 * execution-layer truths that do not exist in this offline slice.
 */
export interface TargetedPeerChallengeBoundedExcerpt {
  text: string;
  truncated: boolean;
  charLimit: number;
}

/**
 * The immutable terminal record for a successful `TARGETED_PEER_CHALLENGE`
 * attempt (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §7.E, §13.E, Slice
 * 2D-C6-B). `targetRef`/`sourceRef` must each exactly match one of the
 * terminated `RouteDecision`'s own `inputRefs` and be distinct from one
 * another (invariant 31) -- no inference, no new ref introduced at outcome
 * time, no positional meaning assigned to either ref's position within the
 * decision's recorded conflict set. `result` is an audit fact only -- it
 * never mechanically produces a `QuestionDisposition`.
 */
export interface TargetedPeerChallengeRouteOutcome extends RouteOutcomeCommon {
  status: 'SUCCEEDED';
  route: 'TARGETED_PEER_CHALLENGE';
  targetRef: RouteInputRef;
  sourceRef: RouteInputRef;
  boundedExcerpt: TargetedPeerChallengeBoundedExcerpt;
  response: string;
  result: TargetedPeerChallengeResult;
}

/** Slice 2D-C6-B's complete RouteOutcome vocabulary. `ADD_CONTEXT`'s `NO_RESPONSE` result is representable, but only through `closeContextRequestWithoutResponse` -- `recordRouteOutcome` never accepts it (§ below). */
export type RouteOutcome =
  | FailedRouteOutcome
  | AddReviewerRouteOutcome
  | ReplicationRouteOutcome
  | AddContextRouteOutcome
  | SeekEvidenceRouteOutcome
  | TargetedPeerChallengeRouteOutcome;

/** The full accepted architecture vocabulary (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §9). `CROSS_SESSION` remains excluded from the recordable subset below -- it is never constructed via the ordinary `recordQuestionDisposition` path; as of Slice 2D-C3, only the atomic `createCrossSessionTransition` operation may ever produce one. */
export type QuestionDispositionKind = 'STILL_OPEN' | 'RESOLVED' | 'SUPERSEDED_RECLASSIFIED' | 'CROSS_SESSION';

/** Slice 2D-B2-B's recordable subset. `SUPERSEDED_RECLASSIFIED` was added in Slice 2D-B2-B (`derivedFromQuestionId` on `UnresolvedQuestion`, ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §9 Slice 2D-B2-B0 freeze). `CROSS_SESSION` remains excluded -- as of Slice 2D-C3 its runtime exists, but exclusively through `createCrossSessionTransition`'s own atomic operation, never this ordinary recordable path. */
export type RecordableQuestionDispositionKind = 'STILL_OPEN' | 'RESOLVED' | 'SUPERSEDED_RECLASSIFIED';

const RECORDABLE_QUESTION_DISPOSITION_KINDS: readonly RecordableQuestionDispositionKind[] = [
  'STILL_OPEN',
  'RESOLVED',
  'SUPERSEDED_RECLASSIFIED',
];

/**
 * The complete stored/read-time-valid vocabulary -- `RECORDABLE_QUESTION_DISPOSITION_KINDS`
 * plus `CROSS_SESSION` (Slice 2D-C3). Deliberately separate from the
 * ordinary-call recordable subset above: `recordQuestionDisposition` must
 * keep rejecting `CROSS_SESSION` as caller input (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md
 * §9, Slice 2D-C3-0 amendment §9) -- only `createCrossSessionTransition`
 * constructs one, internally, after independently satisfying every ordinary
 * disposition precondition itself.
 */
const STORED_QUESTION_DISPOSITION_KINDS: readonly QuestionDispositionKind[] = [
  ...RECORDABLE_QUESTION_DISPOSITION_KINDS,
  'CROSS_SESSION',
];

/**
 * The immutable fact of one semantic re-evaluation of a terminal
 * `RouteOutcome`. `attemptId` is this record's own identity -- no separate
 * `dispositionId`, since one `RouteOutcome` has at most one
 * `QuestionDisposition`. `questionId`/`sessionId`/`artifactHash`/
 * `authorContextHash` are always derived from the resolved
 * outcome->attempt->decision->question chain, never caller-supplied.
 * `disposition`/`reason` are the one fact only an external semantic
 * re-evaluation can supply; this module enforces structure, never computes
 * the disposition itself (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §9).
 */
export interface QuestionDisposition {
  attemptId: string;
  questionId: string;
  sessionId: string;
  artifactHash: string;
  authorContextHash: string;
  disposition: QuestionDispositionKind;
  reason: string;
  createdAt: string;
}

export interface DeliberationBudget {
  spent: number;
  ceiling: number;
}

/**
 * Separate aggregate, never a field on StressTestSession. References a
 * session by id and by the exact frozen hashes it was created against; it
 * never owns copies of ReviewFinding/SemanticIssue/HumanAdjudication/
 * RevisionAction/AuthorContext — those stay authoritative only in the
 * session itself.
 */
export interface DeliberationState {
  id: string;
  sessionId: string;
  artifactHash: string;
  authorContextHash: string;
  history: RouteDecision[];
  attempts: RouteAttempt[];
  outcomes: RouteOutcome[];
  questionDispositions: QuestionDisposition[];
  contextRequests: ContextRequest[];
  sessionVersionLineages: SessionVersionLineage[];
  evidenceSubjects: EvidenceSubject[];
  costBudget: DeliberationBudget;
  latencyBudget: DeliberationBudget;
  unresolvedQuestions: UnresolvedQuestion[];
  stopReason: StopReason | null;
  createdAt: string;
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite number >= 0 (got ${JSON.stringify(value)})`);
  }
}

function assertNonEmptyMaterialityReason(reason: string): void {
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new Error('materialityReason must be a non-empty, explicit prose string');
  }
}

function assertNonEmptyString(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertValidRootCause(rootCause: RootCauseCategory, label: string): void {
  if (!ROOT_CAUSES.includes(rootCause)) {
    throw new Error(`${label}: invalid rootCause ${JSON.stringify(rootCause)}`);
  }
}

/**
 * Rejects any top-level key not in `allowed`. A plain-JS caller bypasses
 * TypeScript's excess-property checks entirely, so this is the only thing
 * that actually stops an unexpected field (a stray `logicalCost`, a
 * `route`, a raw error object's `stack`) from silently riding along on an
 * otherwise-valid input (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §14-§15).
 */
function assertExactKeys(input: object, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(input)) {
    if (!allowedSet.has(key)) {
      throw new Error(`${label}: unexpected field ${JSON.stringify(key)}`);
    }
  }
}

/** Structural validation for one `EvidenceCitation` -- `sourceIdentifier`/`excerpt` non-empty; `title`, when present, non-empty (never present-but-blank). No numeric length bound is invented (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §13.D decision S). */
function assertValidEvidenceCitation(citation: EvidenceCitation, label: string): void {
  if (citation === null || typeof citation !== 'object') {
    throw new Error(`${label} must be an object`);
  }
  assertExactKeys(citation, ['sourceIdentifier', 'title', 'excerpt'], label);
  assertNonEmptyString(citation.sourceIdentifier, `${label}.sourceIdentifier`);
  if (citation.title !== undefined) {
    assertNonEmptyString(citation.title, `${label}.title`);
  }
  assertNonEmptyString(citation.excerpt, `${label}.excerpt`);
}

/** Independent value snapshot of one EvidenceCitation -- never the caller-owned object, preserving the exact supplied `sourceIdentifier`/`title`/`excerpt` strings without trimming or normalization. */
function cloneEvidenceCitation(citation: EvidenceCitation): EvidenceCitation {
  const clone: EvidenceCitation = { sourceIdentifier: citation.sourceIdentifier, excerpt: citation.excerpt };
  if (citation.title !== undefined) {
    clone.title = citation.title;
  }
  return clone;
}

function cloneEvidenceCitations(citations: EvidenceCitation[]): EvidenceCitation[] {
  return citations.map(cloneEvidenceCitation);
}

/**
 * Shared status/result/citation-cardinality matrix for a `SEEK_EVIDENCE`
 * evidence-relation outcome, used identically at write time
 * (`recordRouteOutcome`) and read time (`assertSeekEvidenceOutcomeIntegrity`)
 * so the two boundaries can never drift (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md
 * §13.D decisions R/S; the Slice 2D-C5-A amendment's write/read-drift lesson
 * applied a further time). Legal pairings only: `SUCCEEDED` +
 * `SUPPORTIVE`/`CONTRADICTORY`, or `INCONCLUSIVE` + `INCONCLUSIVE` -- every
 * other status/result combination fails closed. `SUPPORTIVE`/`CONTRADICTORY`
 * require at least one citation; `INCONCLUSIVE` permits zero.
 */
function assertSeekEvidenceStatusResultAndCitations(
  status: AttemptStatus,
  result: SeekEvidenceResult,
  citations: EvidenceCitation[],
  label: string
): void {
  if (!SEEK_EVIDENCE_RESULTS.includes(result)) {
    throw new Error(`${label}: invalid or unsupported SEEK_EVIDENCE result ${JSON.stringify(result)}`);
  }
  const validPairing =
    (status === 'SUCCEEDED' && (result === 'SUPPORTIVE' || result === 'CONTRADICTORY')) ||
    (status === 'INCONCLUSIVE' && result === 'INCONCLUSIVE');
  if (!validPairing) {
    throw new Error(`${label}: SEEK_EVIDENCE status ${status} is not a legal pairing with result ${result}`);
  }
  if (!Array.isArray(citations)) {
    throw new Error(`${label}: citations must be an array`);
  }
  for (const citation of citations) {
    assertValidEvidenceCitation(citation, `${label}: citations[]`);
  }
  if ((result === 'SUPPORTIVE' || result === 'CONTRADICTORY') && citations.length === 0) {
    throw new Error(`${label}: result ${result} requires at least one citation`);
  }
}

/**
 * Reads `UnresolvedQuestion.derivedFromQuestionId` tolerating legacy state
 * that predates the field (missing/`undefined` -- read-time compatibility
 * only, never a mutation of the stored record,
 * ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §9 "Legacy missing-
 * `derivedFromQuestionId` semantics"). A non-null value must still be a
 * non-empty string; a malformed value fails closed rather than being
 * silently treated as absent.
 */
function effectiveDerivedFromQuestionId(question: UnresolvedQuestion): string | null {
  const raw = (question as { derivedFromQuestionId?: string | null }).derivedFromQuestionId;
  if (raw === undefined || raw === null) {
    return null;
  }
  assertNonEmptyString(raw, 'UnresolvedQuestion.derivedFromQuestionId');
  return raw;
}

/** Independent snapshot of an UnresolvedQuestion -- never the caller-owned object, so post-registration mutation of the original cannot alter registry history. Legacy-missing `derivedFromQuestionId` is always materialized as an explicit `null` in new output (§"effectiveDerivedFromQuestionId" above). */
function cloneUnresolvedQuestion(question: UnresolvedQuestion): UnresolvedQuestion {
  return {
    id: question.id,
    inputRefs: cloneRouteInputRefs(question.inputRefs),
    rootCause: question.rootCause,
    materialityReason: question.materialityReason,
    createdAt: question.createdAt,
    derivedFromQuestionId: effectiveDerivedFromQuestionId(question),
  };
}

/** Independent snapshot of a RouteDecision -- never the caller-owned object, so post-recording mutation of the original cannot alter audit history. */
function cloneRouteDecision(decision: RouteDecision): RouteDecision {
  return {
    id: decision.id,
    route: decision.route,
    reason: { rootCause: decision.reason.rootCause, materialityReason: decision.reason.materialityReason },
    inputRefs: cloneRouteInputRefs(decision.inputRefs),
    questionId: decision.questionId,
    createdAt: decision.createdAt,
  };
}

/**
 * Fail-closed logical-call cost per route
 * (MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md §12;
 * ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §12). Logical-call
 * accounting only -- never dollars, token prices, provider pricing, or a
 * numeric production ceiling. The caller never supplies this value; it is
 * always derived from the recorded RouteDecision.route, so a caller can
 * never claim `logicalCost = 0` for a provider-backed route.
 */
function logicalAttemptCostForRoute(route: NonStopDeliberationRoute): number {
  switch (route) {
    case 'ADD_CONTEXT':
      return 0;
    case 'ADD_REVIEWER':
    case 'REPLICATE':
    case 'SEEK_EVIDENCE':
    case 'TARGETED_PEER_CHALLENGE':
      return 1;
    default: {
      const exhaustive: never = route;
      throw new Error(`logicalAttemptCostForRoute: unhandled route ${JSON.stringify(exhaustive)}`);
    }
  }
}

export interface DeliberationBudgetInput {
  costCeiling: number;
  latencyCeiling: number;
}

/**
 * Creates a DeliberationState bound to one REVIEWED, frozen session.
 *
 * Only REVIEWED is accepted: Minimum Necessary Deliberation sits between
 * review/semantic consolidation and Human Adjudication (contract §1), so
 * DRAFT, INPUT_FROZEN (no findings reviewed yet), ADJUDICATED,
 * REVISION_PLANNED, and COMPLETED are all refused.
 *
 * Ceilings must be explicit finite numbers >= 0 supplied by the caller —
 * NaN, Infinity, negative, and missing values are all rejected. A missing
 * ceiling is never interpreted as unlimited (contract §12, §16 invariant
 * 18); zero is accepted and means no paid/provider-backed route may run.
 */
export function createDeliberationState(session: StressTestSession, budgets: DeliberationBudgetInput): DeliberationState {
  verifyFrozenInputIntegrity(session);
  if (session.state !== 'REVIEWED') {
    throw new Error(
      `createDeliberationState: session must be REVIEWED (state=${session.state}); Minimum Necessary Deliberation sits between review and Human Adjudication`
    );
  }
  if (!session.artifactHash || !session.authorContextHash) {
    throw new Error('createDeliberationState: session is missing its frozen artifactHash/authorContextHash');
  }
  assertFiniteNonNegative(budgets.costCeiling, 'createDeliberationState: costCeiling');
  assertFiniteNonNegative(budgets.latencyCeiling, 'createDeliberationState: latencyCeiling');
  return {
    id: randomUUID(),
    sessionId: session.id,
    artifactHash: session.artifactHash,
    authorContextHash: session.authorContextHash,
    history: [],
    attempts: [],
    outcomes: [],
    questionDispositions: [],
    contextRequests: [],
    sessionVersionLineages: [],
    evidenceSubjects: [],
    costBudget: { spent: 0, ceiling: budgets.costCeiling },
    latencyBudget: { spent: 0, ceiling: budgets.latencyCeiling },
    unresolvedQuestions: [],
    stopReason: null,
    createdAt: nowIso(),
  };
}

/**
 * Fail-closed proof that a DeliberationState is still bound to the exact
 * session/hashes it was created against. Every other function in this
 * module calls this before doing anything else. No repair path — a
 * mismatch always throws.
 */
export function verifyDeliberationBinding(session: StressTestSession, state: DeliberationState): void {
  verifyFrozenInputIntegrity(session);
  if (state.sessionId !== session.id) {
    throw new Error(`verifyDeliberationBinding: DeliberationState is bound to session ${state.sessionId}, not ${session.id}`);
  }
  if (state.artifactHash !== session.artifactHash) {
    throw new Error(
      "verifyDeliberationBinding: DeliberationState.artifactHash no longer matches the session's frozen artifactHash"
    );
  }
  if (state.authorContextHash !== session.authorContextHash) {
    throw new Error(
      "verifyDeliberationBinding: DeliberationState.authorContextHash no longer matches the session's frozen authorContextHash"
    );
  }
}

/**
 * Resolves a `RouteDecision` by id without ever trusting `.find()`'s
 * first-match result blindly. The accepted runtime before this slice placed
 * no check preventing a duplicate `RouteDecision.id` from ever being
 * recorded (`recordRouteDecision` hardens this going forward, below), so a
 * `DeliberationState` predating that hardening -- or one directly
 * constructed by a test -- can still structurally contain two history
 * entries sharing one id. Zero matches and more than one match both fail
 * closed; only exactly one match resolves
 * (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §9 amendment, "Legacy
 * duplicate decision id").
 */
function resolveUniqueRouteDecisionById(deliberationState: DeliberationState, decisionId: string, label: string): RouteDecision {
  const matches = deliberationState.history.filter((d) => d.id === decisionId);
  if (matches.length === 0) {
    throw new Error(`${label}: decisionId ${decisionId} is not a currently recorded RouteDecision`);
  }
  if (matches.length > 1) {
    throw new Error(
      `${label}: decisionId ${decisionId} matches more than one recorded RouteDecision -- identity-ambiguous legacy/inconsistent state`
    );
  }
  return matches[0];
}

/**
 * Never trusts a `QuestionDisposition` ledger entry merely because it is
 * present in `deliberationState.questionDispositions` -- every structural
 * rule is independently re-validated on every read, exactly the same
 * "never trust, always re-validate at the boundary" posture
 * `validateAttemptProvenanceForOutcome` already takes for `RouteAttempt`.
 * `STILL_OPEN`/`RESOLVED`/`SUPERSEDED_RECLASSIFIED`/`CROSS_SESSION` are all
 * valid *stored* kinds (`STORED_QUESTION_DISPOSITION_KINDS`); an injected
 * unknown string still throws here rather than being silently treated as
 * non-terminal. `CROSS_SESSION`'s own additional bijection with
 * `SessionVersionLineage` is validated separately, one layer up
 * (`assertCrossSessionLineageIntegrity`, Slice 2D-C3-0 amendment) -- this
 * function only proves the disposition record itself is structurally sound.
 */
/**
 * `STILL_OPEN` is the only non-terminal recordable disposition kind; every
 * other stored kind (`RESOLVED`, `SUPERSEDED_RECLASSIFIED`, `CROSS_SESSION`)
 * terminates a question's disposition history (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md
 * §9 "Terminality"). Never called with an unsupported/unknown kind --
 * `assertLedgerQuestionDispositionIntegrity` already rejects those before
 * this predicate would ever see one.
 */
function isTerminalQuestionDispositionKind(kind: QuestionDispositionKind): boolean {
  return kind !== 'STILL_OPEN';
}

function assertLedgerQuestionDispositionIntegrity(deliberationState: DeliberationState, disposition: QuestionDisposition): void {
  assertNonEmptyString(disposition.attemptId, 'QuestionDisposition ledger entry: attemptId');
  assertNonEmptyString(disposition.questionId, 'QuestionDisposition ledger entry: questionId');
  if (!STORED_QUESTION_DISPOSITION_KINDS.includes(disposition.disposition)) {
    throw new Error(`QuestionDisposition ledger entry: invalid or unsupported disposition ${JSON.stringify(disposition.disposition)}`);
  }
  assertNonEmptyString(disposition.reason, 'QuestionDisposition ledger entry: reason');
  if (Number.isNaN(Date.parse(disposition.createdAt))) {
    throw new Error('QuestionDisposition ledger entry: createdAt is not a valid parseable timestamp');
  }
  if (disposition.sessionId !== deliberationState.sessionId) {
    throw new Error('QuestionDisposition ledger entry: sessionId does not match the current DeliberationState binding');
  }
  if (disposition.artifactHash !== deliberationState.artifactHash) {
    throw new Error('QuestionDisposition ledger entry: artifactHash does not match the current DeliberationState binding');
  }
  if (disposition.authorContextHash !== deliberationState.authorContextHash) {
    throw new Error('QuestionDisposition ledger entry: authorContextHash does not match the current DeliberationState binding');
  }
  const matchingOutcomes = deliberationState.outcomes.filter((o) => o.attemptId === disposition.attemptId);
  if (matchingOutcomes.length !== 1) {
    throw new Error(
      `QuestionDisposition ledger entry: attemptId ${disposition.attemptId} does not resolve to exactly one RouteOutcome`
    );
  }
  if (matchingOutcomes[0].originatingQuestionId !== disposition.questionId) {
    throw new Error('QuestionDisposition ledger entry: outcome.originatingQuestionId does not match disposition.questionId');
  }
}

/**
 * Re-validates the complete disposition ledger at every read boundary, two
 * independent cardinality dimensions: (1) `ONE RouteOutcome -> AT MOST ONE
 * QuestionDisposition` (per-`attemptId`, invariant 27) and (2) per-`questionId`
 * lifecycle terminality (Slice 2D-B2-B amendment,
 * ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §9 "Terminality," §19) --
 * any number of `STILL_OPEN` records for a question, but at most one
 * *terminal* disposition ever, and it must be the last disposition that
 * question has, in ledger append order (never `createdAt`/timestamp
 * arbitration: order is `deliberationState.questionDispositions` array
 * order, exactly the order this module itself appends in). Per-`attemptId`
 * uniqueness alone is not sufficient: two individually-unique-per-attempt
 * terminal dispositions for the *same question* (e.g. a tampered `RESOLVED`
 * on one attempt plus `SUPERSEDED_RECLASSIFIED` on another) must also fail
 * closed, in either order. Neither corruption is ever resolved by
 * first/latest/terminal-wins semantics.
 */
function assertQuestionDispositionLedgerIntegrity(deliberationState: DeliberationState): void {
  const dispositionCountByAttemptId = new Map<string, number>();
  const terminalKindSeenByQuestionId = new Map<string, QuestionDispositionKind>();

  for (const disposition of deliberationState.questionDispositions) {
    assertLedgerQuestionDispositionIntegrity(deliberationState, disposition);
    const count = (dispositionCountByAttemptId.get(disposition.attemptId) ?? 0) + 1;
    dispositionCountByAttemptId.set(disposition.attemptId, count);
    if (count > 1) {
      throw new Error(
        `QuestionDisposition ledger entry: attemptId ${disposition.attemptId} has more than one QuestionDisposition -- inconsistent state`
      );
    }

    const priorTerminalKind = terminalKindSeenByQuestionId.get(disposition.questionId);
    if (priorTerminalKind !== undefined) {
      throw new Error(
        `QuestionDisposition ledger entry: question ${disposition.questionId} already has a terminal disposition (${priorTerminalKind}) -- no further disposition of any kind may follow it, per ledger append order`
      );
    }
    if (isTerminalQuestionDispositionKind(disposition.disposition)) {
      terminalKindSeenByQuestionId.set(disposition.questionId, disposition.disposition);
    }
  }
}

/**
 * Validates the COMPLETE derived-lineage graph, never only the one question
 * a caller happens to be asking about
 * (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §9, "Global lineage
 * read-integrity boundary"). Exact internal ordering (Slice 2D-B2-B
 * amendment, corrected to match this order): (1) global
 * `UnresolvedQuestion.id` non-emptiness/uniqueness -- identity before any
 * local derivation; (2) structural derived-graph checks -- self-reference,
 * then acyclicity, so a broken graph *shape* is reported before this
 * function tries to interpret what a (possibly cyclic) chain's dispositions
 * mean; (3) `QuestionDisposition` ledger integrity -- per-`attemptId`
 * cardinality *and* per-`questionId` lifecycle terminality
 * (`assertQuestionDispositionLedgerIntegrity`), so an individually-
 * plausible-looking parent with two terminal dispositions (e.g. a tampered
 * `RESOLVED` + `SUPERSEDED_RECLASSIFIED` pair for the same question) is
 * already rejected here, before; (4) semantic lineage -- reverse (child ->
 * parent), fork detection, and forward (parent -> child) integrity, which
 * can now safely assume every question has at most one terminal
 * disposition. Pure, non-cached, non-memoized -- never persists anything on
 * `DeliberationState`. Any violation fails closed; none is ever
 * automatically reconciled.
 */
function assertDerivedQuestionLineageIntegrity(deliberationState: DeliberationState): void {
  const seenQuestionIds = new Set<string>();
  for (const question of deliberationState.unresolvedQuestions) {
    assertNonEmptyString(question.id, 'assertDerivedQuestionLineageIntegrity: question.id');
    if (seenQuestionIds.has(question.id)) {
      throw new Error(
        `assertDerivedQuestionLineageIntegrity: duplicate UnresolvedQuestion.id ${question.id} -- identity-ambiguous legacy/inconsistent state`
      );
    }
    seenQuestionIds.add(question.id);
  }

  const questionsById = new Map(deliberationState.unresolvedQuestions.map((q) => [q.id, q] as const));

  // Step 2: structural checks (self-reference, acyclicity) run before any
  // disposition-semantic check below -- a broken graph *shape* is reported
  // before this function tries to reason about what a (possibly cyclic)
  // chain's dispositions mean.
  for (const child of deliberationState.unresolvedQuestions) {
    const parentId = effectiveDerivedFromQuestionId(child);
    if (parentId === child.id) {
      throw new Error(
        `assertDerivedQuestionLineageIntegrity: question ${child.id} has derivedFromQuestionId equal to its own id -- self-referential lineage`
      );
    }
  }

  const globallyVisited = new Set<string>();
  for (const question of deliberationState.unresolvedQuestions) {
    if (globallyVisited.has(question.id)) continue;
    const pathSeen = new Set<string>();
    let current: UnresolvedQuestion | undefined = question;
    while (current) {
      if (pathSeen.has(current.id)) {
        throw new Error(`assertDerivedQuestionLineageIntegrity: derived lineage cycle detected involving question ${current.id}`);
      }
      pathSeen.add(current.id);
      globallyVisited.add(current.id);
      const parentId = effectiveDerivedFromQuestionId(current);
      current = parentId === null ? undefined : questionsById.get(parentId);
    }
  }

  // Step 3: QuestionDisposition ledger integrity -- per-attemptId cardinality
  // AND per-questionId lifecycle terminality -- plus (Slice 2D-C3-0
  // amendment) the complete CROSS_SESSION <-> SessionVersionLineage
  // bijection, so an orphan or forged CROSS_SESSION disposition fails
  // closed here rather than being silently accepted as terminal by whatever
  // reads this state next (isQuestionCurrent included). Only once this
  // passes can step 4 below safely assume every question has at most one
  // terminal disposition (never two, e.g. a tampered RESOLVED +
  // SUPERSEDED_RECLASSIFIED pair for the same parent).
  assertCrossSessionLineageIntegrity(deliberationState);

  // Step 4: reverse integrity (child -> parent) and fork detection.
  const childIdsByParentId = new Map<string, string[]>();

  for (const child of deliberationState.unresolvedQuestions) {
    const parentId = effectiveDerivedFromQuestionId(child);
    if (parentId === null) continue;
    if (!questionsById.has(parentId)) {
      throw new Error(
        `assertDerivedQuestionLineageIntegrity: question ${child.id} claims derivedFromQuestionId ${parentId}, which is not a currently registered question -- orphan derived question`
      );
    }
    // Ledger integrity (step 3, above) already guarantees at most one
    // terminal disposition per question -- so this is "does the parent have
    // a terminal disposition, and is it SUPERSEDED_RECLASSIFIED," never
    // "exactly one disposition total" (a parent may legitimately carry any
    // number of earlier STILL_OPEN records from prior completed cycles).
    const terminalForParent = deliberationState.questionDispositions.filter(
      (d) => d.questionId === parentId && isTerminalQuestionDispositionKind(d.disposition)
    );
    if (terminalForParent.length !== 1 || terminalForParent[0].disposition !== 'SUPERSEDED_RECLASSIFIED') {
      throw new Error(
        `assertDerivedQuestionLineageIntegrity: question ${child.id}'s claimed parent ${parentId} does not have exactly one terminal SUPERSEDED_RECLASSIFIED disposition -- broken lineage`
      );
    }
    const siblings = childIdsByParentId.get(parentId) ?? [];
    siblings.push(child.id);
    childIdsByParentId.set(parentId, siblings);
  }

  for (const [parentId, childIds] of childIdsByParentId) {
    if (childIds.length > 1) {
      throw new Error(
        `assertDerivedQuestionLineageIntegrity: question ${parentId} has more than one direct derived child (${childIds.join(', ')}) -- fork in derived lineage`
      );
    }
  }

  // Forward integrity (parent -> child): every SUPERSEDED_RECLASSIFIED
  // disposition must have exactly one registered child pointing back at it.
  const supersededQuestionIds = new Set(
    deliberationState.questionDispositions.filter((d) => d.disposition === 'SUPERSEDED_RECLASSIFIED').map((d) => d.questionId)
  );
  for (const parentId of supersededQuestionIds) {
    const childCount = childIdsByParentId.get(parentId)?.length ?? 0;
    if (childCount !== 1) {
      throw new Error(
        `assertDerivedQuestionLineageIntegrity: superseded question ${parentId} has ${childCount} registered direct children (expected exactly 1) -- missing or forked replacement`
      );
    }
  }
}

/**
 * Pure, non-cached, non-memoized: recomputes from `history`/`attempts`/
 * `outcomes`/`questionDispositions` on every call -- never stored, never an
 * `active: boolean` field anywhere. A non-`STOP` `RouteDecision` targeting
 * `questionId` counts as active for the whole span from being recorded to
 * a `QuestionDisposition` being recorded for its eventual outcome,
 * regardless of which of the three intermediate stages (decision-only,
 * attempt-open, outcome-undisposed) it currently sits at
 * (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §9, "Active-cycle
 * semantics"). Fails closed on any identity ambiguity encountered along
 * the way -- never resolves it by picking a first match, a latest
 * timestamp, or silently repairing it.
 */
function getActiveRouteDecisionsForQuestion(deliberationState: DeliberationState, questionId: string): RouteDecision[] {
  assertQuestionDispositionLedgerIntegrity(deliberationState);
  const candidates = deliberationState.history.filter((d) => d.route !== 'STOP' && d.questionId === questionId);

  const seenDecisionIds = new Set<string>();
  const active: RouteDecision[] = [];

  for (const decision of candidates) {
    assertNonEmptyString(decision.id, 'getActiveRouteDecisionsForQuestion: decision.id');
    const globallyUniqueDecision = resolveUniqueRouteDecisionById(
      deliberationState,
      decision.id,
      'getActiveRouteDecisionsForQuestion'
    );
    if (seenDecisionIds.has(decision.id)) {
      throw new Error(
        `getActiveRouteDecisionsForQuestion: duplicate RouteDecision.id ${decision.id} in history -- identity-ambiguous legacy/inconsistent state`
      );
    }
    seenDecisionIds.add(decision.id);

    const attemptsForDecision = deliberationState.attempts.filter((a) => a.decisionId === globallyUniqueDecision.id);
    if (attemptsForDecision.length === 0) {
      active.push(decision);
      continue;
    }
    if (attemptsForDecision.length > 1) {
      throw new Error(
        `getActiveRouteDecisionsForQuestion: decision ${decision.id} has more than one RouteAttempt -- inconsistent legacy state`
      );
    }
    const attempt = attemptsForDecision[0];

    const outcomesForAttempt = deliberationState.outcomes.filter((o) => o.attemptId === attempt.attemptId);
    if (outcomesForAttempt.length === 0) {
      active.push(decision);
      continue;
    }
    if (outcomesForAttempt.length > 1) {
      throw new Error(
        `getActiveRouteDecisionsForQuestion: attempt ${attempt.attemptId} has more than one RouteOutcome -- inconsistent legacy state`
      );
    }
    const outcome = outcomesForAttempt[0];

    const dispositionsForOutcome = deliberationState.questionDispositions.filter((d) => d.attemptId === outcome.attemptId);
    if (dispositionsForOutcome.length === 0) {
      active.push(decision);
      continue;
    }
    if (dispositionsForOutcome.length > 1) {
      throw new Error(
        `getActiveRouteDecisionsForQuestion: outcome ${outcome.attemptId} has more than one QuestionDisposition -- inconsistent legacy state`
      );
    }
    assertLedgerQuestionDispositionIntegrity(deliberationState, dispositionsForOutcome[0]);
    // exactly one valid disposition -> this decision's cycle is inactive; not added to `active`.
  }

  return active;
}

/**
 * Pure, non-cached, non-memoized derivation -- currentness is never stored
 * as a field on `UnresolvedQuestion` (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md
 * §9, "Current-question derivation"). Global identity/lineage integrity is
 * validated before any local question is answered -- global corruption can
 * change the correct interpretation of a query that looks local (§9,
 * "Global lineage read-integrity boundary"); this also means a
 * duplicate-`UnresolvedQuestion.id` state fails closed here rather than
 * being silently resolved by whichever local `.find()`/`.some()` a caller
 * happens to run first. Fails closed on an unregistered question rather
 * than silently treating it as current or terminal by default. Never
 * depends on `deliberationState.stopReason` -- a question may remain
 * current after `STOP` for the `HumanAdjudication` handoff; `STOP` ends
 * routing, never question identity/currentness. `STILL_OPEN` is the only
 * non-terminal recordable disposition; any other recorded disposition
 * (`RESOLVED`, `SUPERSEDED_RECLASSIFIED`) terminalizes the question.
 */
export function isQuestionCurrent(deliberationState: DeliberationState, questionId: string): boolean {
  assertDerivedQuestionLineageIntegrity(deliberationState);
  const registered = deliberationState.unresolvedQuestions.some((q) => q.id === questionId);
  if (!registered) {
    throw new Error(`isQuestionCurrent: questionId ${questionId} is not a currently registered unresolved question`);
  }
  const dispositionsForQuestion = deliberationState.questionDispositions.filter((d) => d.questionId === questionId);
  return !dispositionsForQuestion.some((d) => isTerminalQuestionDispositionKind(d.disposition));
}

/**
 * Constructs an UnresolvedQuestion. This slice accepts already-classified
 * routing input (rootCause, materialityReason) and enforces its structure
 * — it does not classify anything itself. Every non-NONE question must
 * carry at least one valid RouteInputRef.
 */
export function createUnresolvedQuestion(
  session: StressTestSession,
  input: {
    rootCause: RootCauseCategory;
    materialityReason: string;
    inputRefs: RouteInputRef[];
    derivedFromQuestionId?: string | null;
  }
): UnresolvedQuestion {
  assertValidRootCause(input.rootCause, 'createUnresolvedQuestion');
  assertNonEmptyMaterialityReason(input.materialityReason);
  if (input.rootCause !== 'NONE' && input.inputRefs.length === 0) {
    throw new Error('createUnresolvedQuestion: at least one inputRef is required for a non-NONE root cause');
  }
  for (const ref of input.inputRefs) validateRouteInputRef(session, ref);
  // Early, non-authoritative rejection (contract §13.E decision B, Slice
  // 2D-C6-0/2D-C6-A): the canonical constructor should not mint a
  // structurally invalid DECISION_SENSITIVE_CONFLICT question.
  // `registerUnresolvedQuestion` remains the authoritative persistence gate
  // and independently re-validates this from scratch below -- never trusted
  // from this constructor call alone.
  if (input.rootCause === 'DECISION_SENSITIVE_CONFLICT') {
    assertTargetedPeerChallengeInputRefs(session, input.inputRefs, 'createUnresolvedQuestion');
  }
  let derivedFromQuestionId: string | null = null;
  if (input.derivedFromQuestionId !== undefined && input.derivedFromQuestionId !== null) {
    assertNonEmptyString(input.derivedFromQuestionId, 'createUnresolvedQuestion: derivedFromQuestionId');
    derivedFromQuestionId = input.derivedFromQuestionId;
  }
  return {
    id: randomUUID(),
    inputRefs: [...input.inputRefs],
    rootCause: input.rootCause,
    materialityReason: input.materialityReason,
    createdAt: nowIso(),
    derivedFromQuestionId,
  };
}

/**
 * Registers an already-constructed UnresolvedQuestion into a
 * DeliberationState's registry, immutably. Never trusts that the question
 * came from `createUnresolvedQuestion` — every structural rule is
 * re-validated from scratch against whatever object was actually passed
 * in. A `rootCause` of `NONE` can never be registered: `NONE` means no
 * unresolved deficit remains and maps directly to `STOP`, a session-level
 * terminal decision, not a registered question. Registering the same
 * question id twice is refused rather than replaced or merged.
 */
export function registerUnresolvedQuestion(
  session: StressTestSession,
  deliberationState: DeliberationState,
  question: UnresolvedQuestion
): DeliberationState {
  verifyDeliberationBinding(session, deliberationState);
  if (deliberationState.stopReason !== null) {
    throw new Error('registerUnresolvedQuestion: deliberation has already stopped; no further question may be registered');
  }
  assertNonEmptyString(question.id, 'registerUnresolvedQuestion: question.id');
  assertValidRootCause(question.rootCause, 'registerUnresolvedQuestion');
  if (question.rootCause === 'NONE') {
    throw new Error(
      'registerUnresolvedQuestion: rootCause NONE cannot be registered -- NONE means no unresolved deficit remains and maps to STOP'
    );
  }
  assertNonEmptyMaterialityReason(question.materialityReason);
  for (const ref of question.inputRefs) validateRouteInputRef(session, ref);
  if (question.inputRefs.length === 0) {
    throw new Error('registerUnresolvedQuestion: at least one inputRef is required for a non-NONE root cause');
  }
  // Authoritative write boundary (contract §13.E decision A, Slice
  // 2D-C6-0/2D-C6-A): invariant 30 states this cardinality as a property of
  // a REGISTERED UnresolvedQuestion -- never trusts that
  // createUnresolvedQuestion was called, that its own gate ran, or that the
  // caller-supplied object was not modified after construction.
  if (question.rootCause === 'DECISION_SENSITIVE_CONFLICT') {
    assertTargetedPeerChallengeInputRefs(session, question.inputRefs, 'registerUnresolvedQuestion');
  }
  if (effectiveDerivedFromQuestionId(question) !== null) {
    throw new Error(
      `registerUnresolvedQuestion: question ${question.id} has a non-null derivedFromQuestionId; a derived question may only be registered through the atomic SUPERSEDED_RECLASSIFIED transition (recordQuestionDisposition)`
    );
  }
  if (deliberationState.unresolvedQuestions.some((q) => q.id === question.id)) {
    throw new Error(`registerUnresolvedQuestion: question ${question.id} is already registered`);
  }
  return {
    ...deliberationState,
    unresolvedQuestions: [...deliberationState.unresolvedQuestions, cloneUnresolvedQuestion(question)],
  };
}

/**
 * Plans (does not record or execute) a RouteDecision for one already-
 * classified UnresolvedQuestion. Pure and offline — zero provider calls.
 * Deliberately does not rank or select among multiple unresolved
 * questions; autonomous multi-item prioritization is a separate,
 * not-yet-authorized implementation decision (contract §5, §13).
 *
 * For a non-NONE root cause, `question` must identify a question already
 * present in `deliberationState.unresolvedQuestions`, and every field the
 * registry holds — rootCause, materialityReason, and inputRefs in exact
 * order — must match the supplied `question` exactly; a same-id-but-
 * modified question is rejected, not silently accepted. For `NONE`, the
 * question must NOT be registered (NONE is never registrable — see
 * `registerUnresolvedQuestion`) and the resulting decision carries
 * `questionId: null`.
 */
export function planRouteForQuestion(
  session: StressTestSession,
  deliberationState: DeliberationState,
  question: UnresolvedQuestion
): RouteDecision {
  verifyDeliberationBinding(session, deliberationState);
  if (deliberationState.stopReason !== null) {
    throw new Error('planRouteForQuestion: deliberation has already stopped; no further route may be planned');
  }
  assertValidRootCause(question.rootCause, 'planRouteForQuestion');
  assertNonEmptyString(question.id, 'planRouteForQuestion: question.id');
  assertNonEmptyMaterialityReason(question.materialityReason);
  if (question.rootCause !== 'NONE' && question.inputRefs.length === 0) {
    throw new Error('planRouteForQuestion: at least one inputRef is required for a non-NONE root cause');
  }
  for (const ref of question.inputRefs) validateRouteInputRef(session, ref);
  const route = routeForRootCause(question.rootCause);

  if (question.rootCause === 'NONE') {
    if (deliberationState.unresolvedQuestions.some((q) => q.id === question.id)) {
      throw new Error('planRouteForQuestion: a NONE-rootCause question must never be a registered unresolved question');
    }
    return {
      id: randomUUID(),
      route,
      reason: { rootCause: question.rootCause, materialityReason: question.materialityReason },
      inputRefs: cloneRouteInputRefs(question.inputRefs),
      questionId: null,
      createdAt: nowIso(),
    };
  }

  const registered = deliberationState.unresolvedQuestions.find((q) => q.id === question.id);
  if (!registered) {
    throw new Error(`planRouteForQuestion: question ${question.id} is not a currently registered unresolved question`);
  }
  if (registered.rootCause !== question.rootCause) {
    throw new Error(
      `planRouteForQuestion: registered question ${question.id} has rootCause ${registered.rootCause}, not the supplied ${question.rootCause}`
    );
  }
  if (registered.materialityReason !== question.materialityReason) {
    throw new Error(`planRouteForQuestion: registered question ${question.id} has a different materialityReason than supplied`);
  }
  if (!refsExactlyMatch(registered.inputRefs, question.inputRefs)) {
    throw new Error(
      `planRouteForQuestion: registered question ${question.id} has different inputRefs (order-sensitive) than supplied`
    );
  }
  if (!isQuestionCurrent(deliberationState, question.id)) {
    throw new Error(`planRouteForQuestion: question ${question.id} is not current`);
  }
  const activeForPlan = getActiveRouteDecisionsForQuestion(deliberationState, question.id);
  if (activeForPlan.length === 1) {
    throw new Error(`planRouteForQuestion: question ${question.id} already has an active deliberation cycle`);
  }
  if (activeForPlan.length > 1) {
    throw new Error(
      `planRouteForQuestion: question ${question.id} has more than one active deliberation cycle -- inconsistent legacy state`
    );
  }

  // Gate 1 of 3 (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §13.D decision
  // O, Slice 2D-C5-A): a SEEK_EVIDENCE route may not even be planned for an
  // EVIDENCE_GAP question until exactly one valid EvidenceSubject is already
  // registered for it. Fails closed as early as possible, before a
  // RouteDecision object is ever minted -- causal-order enforcement, never
  // trusted by the later authoritative/independent gates below.
  if (route === 'SEEK_EVIDENCE') {
    assertSeekEvidenceSubjectReady(session, deliberationState, question.id);
  }

  // TPC Gate 1 of 3 (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §13.E
  // decision C, invariant 80, Slice 2D-C6-A): a TARGETED_PEER_CHALLENGE
  // route may not even be planned for a DECISION_SENSITIVE_CONFLICT question
  // until its currently-registered inputRefs still contain at least two
  // distinct, valid RouteInputRefs -- causal-order/legacy-read protection,
  // before a RouteDecision is ever minted, never trusting that
  // registration's own gate still holds for state that may predate it.
  if (route === 'TARGETED_PEER_CHALLENGE') {
    assertTargetedPeerChallengeReady(session, deliberationState, question.id);
  }

  // Derived from the already-validated registry entry, not the caller-owned
  // `question` argument, so the returned decision cannot alias anything the
  // caller still holds a mutable reference to.
  return {
    id: randomUUID(),
    route,
    reason: { rootCause: registered.rootCause, materialityReason: registered.materialityReason },
    inputRefs: cloneRouteInputRefs(registered.inputRefs),
    questionId: question.id,
    createdAt: nowIso(),
  };
}

/**
 * Records a RouteDecision into DeliberationState history, immutably.
 * Never mutates StressTestSession and never executes the route — this is
 * routing/audit bookkeeping only.
 *
 * Refuses once the state has already stopped (`stopReason !== null`).
 * Refuses a route/rootCause mismatch outright, so a RouteDecision that
 * claims an incompatible route can never be recorded. `route === 'STOP'`
 * requires an explicit, allowlisted StopReason and `questionId === null`;
 * every other route requires a `questionId` that identifies a currently
 * registered unresolved question whose rootCause, materialityReason, and
 * inputRefs (order-sensitive) exactly match the decision's own — and
 * forbids any `stopReason` being supplied.
 *
 * A RouteDecision is never trusted to have come from `planRouteForQuestion`
 * — every structural rule that function enforces is re-checked here from
 * scratch against whatever object was actually passed in.
 */
export function recordRouteDecision(
  session: StressTestSession,
  deliberationState: DeliberationState,
  routeDecision: RouteDecision,
  options?: { stopReason?: StopReason }
): DeliberationState {
  verifyDeliberationBinding(session, deliberationState);
  if (deliberationState.stopReason !== null) {
    throw new Error('recordRouteDecision: deliberation has already stopped; no further RouteDecision may be recorded');
  }
  assertNonEmptyString(routeDecision.id, 'recordRouteDecision: routeDecision.id');
  if (deliberationState.history.some((d) => d.id === routeDecision.id)) {
    throw new Error(
      `recordRouteDecision: RouteDecision.id ${routeDecision.id} is already recorded in history -- no audit identity may be duplicated`
    );
  }
  assertValidRootCause(routeDecision.reason.rootCause, 'recordRouteDecision');
  const expectedRoute = routeForRootCause(routeDecision.reason.rootCause);
  if (routeDecision.route !== expectedRoute) {
    throw new Error(
      `recordRouteDecision: route ${routeDecision.route} is inconsistent with rootCause ${routeDecision.reason.rootCause} (expected ${expectedRoute})`
    );
  }
  assertNonEmptyMaterialityReason(routeDecision.reason.materialityReason);
  if (routeDecision.reason.rootCause !== 'NONE' && routeDecision.inputRefs.length === 0) {
    throw new Error(
      `recordRouteDecision: at least one inputRef is required for a non-NONE root cause (rootCause=${routeDecision.reason.rootCause})`
    );
  }
  for (const ref of routeDecision.inputRefs) validateRouteInputRef(session, ref);

  if (routeDecision.route === 'STOP') {
    if (routeDecision.questionId !== null) {
      throw new Error('recordRouteDecision: a STOP decision must have questionId=null; STOP is session-level, not a response to any one question');
    }
  } else {
    if (typeof routeDecision.questionId !== 'string' || routeDecision.questionId.length === 0) {
      throw new Error('recordRouteDecision: a non-STOP decision requires a non-empty questionId');
    }
    const registered = deliberationState.unresolvedQuestions.find((q) => q.id === routeDecision.questionId);
    if (!registered) {
      throw new Error(
        `recordRouteDecision: questionId ${routeDecision.questionId} is not a currently registered unresolved question`
      );
    }
    if (registered.rootCause !== routeDecision.reason.rootCause) {
      throw new Error(
        `recordRouteDecision: registered question ${routeDecision.questionId} has rootCause ${registered.rootCause}, not ${routeDecision.reason.rootCause}`
      );
    }
    if (registered.materialityReason !== routeDecision.reason.materialityReason) {
      throw new Error(
        `recordRouteDecision: registered question ${routeDecision.questionId} has a different materialityReason than the decision`
      );
    }
    if (!refsExactlyMatch(registered.inputRefs, routeDecision.inputRefs)) {
      throw new Error(
        `recordRouteDecision: registered question ${routeDecision.questionId} has different inputRefs (order-sensitive) than the decision`
      );
    }
    // Authoritative active-cycle creation gate: STOP is exempt (it is
    // session-level termination, never a new question cycle) -- this
    // branch is non-STOP only.
    if (!isQuestionCurrent(deliberationState, routeDecision.questionId)) {
      throw new Error(`recordRouteDecision: question ${routeDecision.questionId} is not current`);
    }
    const activeForRecord = getActiveRouteDecisionsForQuestion(deliberationState, routeDecision.questionId);
    if (activeForRecord.length === 1) {
      throw new Error(`recordRouteDecision: question ${routeDecision.questionId} already has an active deliberation cycle`);
    }
    if (activeForRecord.length > 1) {
      throw new Error(
        `recordRouteDecision: question ${routeDecision.questionId} has more than one active deliberation cycle -- inconsistent legacy state`
      );
    }

    // Gate 2 of 3 (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §13.D
    // decision O, Slice 2D-C5-A): the authoritative persistence gate -- never
    // trusts that `routeDecision` actually came from `planRouteForQuestion`
    // or that its gate 1 check ran; a manually/legacy-constructed
    // SEEK_EVIDENCE decision with no registered subject is rejected here
    // independently.
    if (routeDecision.route === 'SEEK_EVIDENCE') {
      assertSeekEvidenceSubjectReady(session, deliberationState, routeDecision.questionId);
    }

    // TPC Gate 2 of 3 (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §13.E
    // decision D, invariant 80, Slice 2D-C6-A): the authoritative
    // decision-write boundary -- never trusts that `routeDecision` actually
    // came from `planRouteForQuestion` or that its gate 1 check ran; a
    // manually-constructed or legacy TARGETED_PEER_CHALLENGE decision cannot
    // bypass cardinality merely by skipping the planning call.
    if (routeDecision.route === 'TARGETED_PEER_CHALLENGE') {
      assertTargetedPeerChallengeReady(session, deliberationState, routeDecision.questionId);
    }
  }

  let stopReason: StopReason | null = null;
  if (routeDecision.route === 'STOP') {
    if (!options?.stopReason) {
      throw new Error('recordRouteDecision: route STOP requires an explicit stopReason');
    }
    if (!STOP_REASONS.includes(options.stopReason)) {
      throw new Error(`recordRouteDecision: invalid stopReason ${JSON.stringify(options.stopReason)}`);
    }
    stopReason = options.stopReason;
  } else if (options?.stopReason) {
    throw new Error('recordRouteDecision: stopReason may only be supplied when route is STOP');
  }

  return {
    ...deliberationState,
    history: [...deliberationState.history, cloneRouteDecision(routeDecision)],
    stopReason,
  };
}

/**
 * Records that one already-recorded, non-STOP `RouteDecision` has begun
 * execution — offline audit bookkeeping only. Never executes the route,
 * calls a provider, retrieves anything, or contacts a human
 * (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §5, §20). The intended
 * future ordering is: `recordRouteAttemptStart` -> persist the returned
 * state -> an external mechanism MAY execute in a separately-authorized
 * layer.
 *
 * `decisionId` is resolved ONLY against `deliberationState.history` — a
 * structurally-valid `RouteDecision` that was never recorded does not
 * authorize an attempt (no free-floating attempt). `STOP` decisions are
 * rejected outright: `STOP` has no `RouteAttempt`, no external execution,
 * and no attempt cost. Logical cost is derived from the decision's own
 * route, never supplied by the caller, and is accounted atomically with
 * the new `RouteAttempt` via `applyCostSpend` — either both happen, or
 * neither does; there is never a returned state where the attempt exists
 * but its cost was not accounted.
 *
 * `ONE RouteDecision -> AT MOST ONE RouteAttempt`: a second attempt for a
 * decision that already has one is rejected outright, regardless of
 * whether a future outcome would succeed, fail, or remain unterminated.
 * Retry is never a second attempt for the same decision — it requires a
 * new `RouteDecision`, which this function does not create.
 *
 * Because no RouteOutcome runtime exists yet, every RouteAttempt created
 * here is, by construction, open/unterminated
 * (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §5, §14) — expected, not an
 * error. Because no QuestionDisposition runtime exists yet, "registered"
 * and "current" are the same thing in this slice (§23 of that contract);
 * no second currentness policy is introduced here.
 */
export function recordRouteAttemptStart(
  session: StressTestSession,
  deliberationState: DeliberationState,
  decisionId: string
): DeliberationState {
  verifyDeliberationBinding(session, deliberationState);
  if (deliberationState.stopReason !== null) {
    throw new Error('recordRouteAttemptStart: deliberation has already stopped; no further RouteAttempt may start');
  }
  assertNonEmptyString(decisionId, 'recordRouteAttemptStart: decisionId');

  const decision = resolveUniqueRouteDecisionById(deliberationState, decisionId, 'recordRouteAttemptStart');
  if (decision.route === 'STOP') {
    throw new Error('recordRouteAttemptStart: STOP has no RouteAttempt, no external execution, and no attempt cost');
  }
  if (typeof decision.questionId !== 'string' || decision.questionId.length === 0) {
    throw new Error(`recordRouteAttemptStart: recorded decision ${decisionId} has no non-empty questionId`);
  }
  const registered = deliberationState.unresolvedQuestions.find((q) => q.id === decision.questionId);
  if (!registered) {
    throw new Error(
      `recordRouteAttemptStart: decision ${decisionId}'s questionId ${decision.questionId} is not a currently registered unresolved question`
    );
  }
  if (deliberationState.attempts.some((attempt) => attempt.decisionId === decisionId)) {
    throw new Error(
      `recordRouteAttemptStart: decision ${decisionId} already has a RouteAttempt; retry requires a new RouteDecision`
    );
  }

  if (!isQuestionCurrent(deliberationState, decision.questionId)) {
    throw new Error(`recordRouteAttemptStart: question ${decision.questionId} is not current`);
  }
  const activeForStart = getActiveRouteDecisionsForQuestion(deliberationState, decision.questionId);
  if (activeForStart.length === 0) {
    throw new Error(`recordRouteAttemptStart: question ${decision.questionId} has no active deliberation cycle`);
  }
  if (activeForStart.length > 1) {
    throw new Error(
      `recordRouteAttemptStart: question ${decision.questionId} has more than one active deliberation cycle -- inconsistent legacy state`
    );
  }
  if (activeForStart[0].id !== decision.id) {
    throw new Error(
      `recordRouteAttemptStart: question ${decision.questionId}'s active deliberation cycle is a different RouteDecision than ${decisionId}`
    );
  }

  // Gate 3 of 3 (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §13.D decision
  // O, Slice 2D-C5-A): legacy/tampered-state execution-start protection --
  // never trusts that a historical SEEK_EVIDENCE RouteDecision passed gate 1
  // or gate 2, which may not have existed when it was recorded, or could
  // have been bypassed by directly-constructed legacy/tampered state.
  if (decision.route === 'SEEK_EVIDENCE') {
    assertSeekEvidenceSubjectReady(session, deliberationState, decision.questionId);
  }

  // TPC Gate 3 of 3 (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §13.E
  // decision E, invariant 80, Slice 2D-C6-A): final execution-start
  // protection -- never trusts that construction, registration, planning, or
  // decision-recording already checked the requirement.
  if (decision.route === 'TARGETED_PEER_CHALLENGE') {
    assertTargetedPeerChallengeReady(session, deliberationState, decision.questionId);
  }

  const logicalCost = logicalAttemptCostForRoute(decision.route);
  const withCost = applyCostSpend(deliberationState, logicalCost);

  verifyDeliberationBinding(session, deliberationState);
  if (!session.artifactHash || !session.authorContextHash) {
    throw new Error('recordRouteAttemptStart: session is missing its frozen artifactHash/authorContextHash');
  }

  const attempt: RouteAttempt = {
    attemptId: randomUUID(),
    decisionId: decision.id,
    questionId: decision.questionId,
    route: decision.route,
    sessionId: session.id,
    artifactHash: session.artifactHash,
    authorContextHash: session.authorContextHash,
    startedAt: nowIso(),
    logicalCost,
  };

  return {
    ...withCost,
    attempts: [...withCost.attempts, attempt],
  };
}

/**
 * Never blindly trusts a stored `RouteAttempt` merely because it is present
 * in `deliberationState.attempts` — every structural rule is independently
 * re-validated (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §7 amendment,
 * "Revalidate attempt provenance"). Resolves and cross-checks the attempt's
 * own recorded `RouteDecision` and registered `UnresolvedQuestion`, and
 * returns the decision (needed by `REPLICATE`'s `targetRef` check). Throws
 * on any mismatch; no repair path.
 */
function validateAttemptProvenanceForOutcome(
  session: StressTestSession,
  deliberationState: DeliberationState,
  attempt: RouteAttempt
): RouteDecision {
  assertNonEmptyString(attempt.attemptId, 'recordRouteOutcome: attempt.attemptId');
  assertNonEmptyString(attempt.decisionId, 'recordRouteOutcome: attempt.decisionId');
  assertNonEmptyString(attempt.questionId, 'recordRouteOutcome: attempt.questionId');
  if (!NON_STOP_ROUTES.includes(attempt.route)) {
    throw new Error(`recordRouteOutcome: attempt.route ${JSON.stringify(attempt.route)} is not a valid non-STOP route`);
  }
  if (attempt.sessionId !== deliberationState.sessionId || attempt.sessionId !== session.id) {
    throw new Error('recordRouteOutcome: attempt.sessionId does not match the current session/DeliberationState binding');
  }
  if (attempt.artifactHash !== deliberationState.artifactHash || attempt.artifactHash !== session.artifactHash) {
    throw new Error('recordRouteOutcome: attempt.artifactHash does not match the current session/DeliberationState binding');
  }
  if (attempt.authorContextHash !== deliberationState.authorContextHash || attempt.authorContextHash !== session.authorContextHash) {
    throw new Error('recordRouteOutcome: attempt.authorContextHash does not match the current session/DeliberationState binding');
  }
  assertFiniteNonNegative(attempt.logicalCost, 'recordRouteOutcome: attempt.logicalCost');
  if (attempt.logicalCost !== logicalAttemptCostForRoute(attempt.route)) {
    throw new Error('recordRouteOutcome: attempt.logicalCost does not match the expected logical cost for its route');
  }
  if (Number.isNaN(Date.parse(attempt.startedAt))) {
    throw new Error('recordRouteOutcome: attempt.startedAt is not a valid parseable timestamp');
  }

  const decision = resolveUniqueRouteDecisionById(deliberationState, attempt.decisionId, 'recordRouteOutcome');
  if (decision.route === 'STOP') {
    throw new Error('recordRouteOutcome: STOP has no RouteAttempt/RouteOutcome');
  }
  if (decision.route !== attempt.route) {
    throw new Error('recordRouteOutcome: recorded decision route does not match the attempt route');
  }
  if (decision.questionId !== attempt.questionId) {
    throw new Error('recordRouteOutcome: recorded decision questionId does not match the attempt questionId');
  }

  const question = deliberationState.unresolvedQuestions.find((q) => q.id === attempt.questionId);
  if (!question) {
    throw new Error(
      `recordRouteOutcome: attempt ${attempt.attemptId}'s questionId ${attempt.questionId} is not a currently registered unresolved question`
    );
  }
  if (decision.reason.rootCause !== question.rootCause) {
    throw new Error('recordRouteOutcome: recorded decision rootCause does not match the registered question rootCause');
  }
  if (decision.reason.materialityReason !== question.materialityReason) {
    throw new Error('recordRouteOutcome: recorded decision materialityReason does not match the registered question materialityReason');
  }
  if (!refsExactlyMatch(decision.inputRefs, question.inputRefs)) {
    throw new Error('recordRouteOutcome: recorded decision inputRefs do not exactly match the registered question inputRefs (order-sensitive)');
  }
  if (routeForRootCause(question.rootCause) !== decision.route) {
    throw new Error('recordRouteOutcome: registered question rootCause does not map to the recorded decision route');
  }

  return decision;
}

/** The caller-suppliable shape for `recordRouteOutcome`. Every field this module derives/generates (route, decisionId, originatingQuestionId, sessionId, artifactHash, authorContextHash, logicalCost, completedAt) is deliberately absent -- accepting them here would let a caller restate a binding fact inconsistently, which `assertExactKeys` independently rejects at runtime regardless of what TypeScript's optional fields imply. */
export interface RecordRouteOutcomeInput {
  attemptId: string;
  status: AttemptStatus;
  latencyConsumed: number;
  failure?: FailureInfo;
  reviewerRunId?: string;
  findingIds?: string[];
  result?: ReplicationResult | AddContextResult | SeekEvidenceResult | TargetedPeerChallengeResult;
  targetRef?: RouteInputRef;
  contextRequestId?: string;
  responseText?: string;
  evidenceSubjectId?: string;
  citations?: EvidenceCitation[];
  sourceRef?: RouteInputRef;
  boundedExcerpt?: TargetedPeerChallengeBoundedExcerpt;
  response?: string;
}

/**
 * Records the immutable terminal fact for one already-started `RouteAttempt`
 * — offline audit bookkeeping only; never executes a route, calls a
 * provider, retrieves anything, or contacts a human
 * (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §7, §20).
 *
 * Records a generic `FAILED` outcome for any already-started non-STOP
 * attempt, a successful `ADD_REVIEWER` outcome, a successful `REPLICATE`
 * outcome, successful `ADD_CONTEXT` `SUPPLIED`/`DECLINED` outcomes (each
 * independently re-verified against the complete `ContextRequest` ledger,
 * never trusted from the input alone), and -- as of Slice 2D-C5-B --
 * `SEEK_EVIDENCE` `SUPPORTIVE`/`CONTRADICTORY`/`INCONCLUSIVE` results, each
 * independently re-verified against the complete `EvidenceSubject` ledger
 * (`assertEvidenceSubjectLedgerIntegrity`, reused rather than reimplemented;
 * ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §13.D decisions Q-V). `INCONCLUSIVE`
 * is recordable ONLY for `SEEK_EVIDENCE` -- every other route's `AttemptStatus`
 * allowlist is unchanged (§6). `ADD_CONTEXT` `NO_RESPONSE` is rejected
 * outright through this function regardless of how plausible the supplied
 * payload looks -- not because it is unauthorized (Slice 2D-C4 implemented
 * and accepted its own dedicated `closeContextRequestWithoutResponse`
 * operation), but because this function is never the path that creates it.
 * As of Slice 2D-C6-B, `TARGETED_PEER_CHALLENGE` `REBUTTAL`/`CONCESSION`/
 * `QUALIFICATION`/`REFUSAL_TO_YIELD` results are also recordable, each
 * independently re-verified against the currently-registered question's
 * TPC readiness (`assertTargetedPeerChallengeReady`, reused rather than
 * reimplemented; ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §13.E) and
 * against the terminated `RouteDecision`'s own `inputRefs` for
 * `targetRef`/`sourceRef` membership and distinctness (invariant 31).
 *
 * `attemptId` is resolved only against `deliberationState.attempts` (no
 * free-floating outcome) and re-validated against its own recorded
 * `RouteDecision`/`UnresolvedQuestion` from scratch
 * (`validateAttemptProvenanceForOutcome`) — the stored `RouteAttempt` is
 * never trusted merely because it is present in state. `ONE RouteAttempt ->
 * AT MOST ONE RouteOutcome`: a second outcome for an already-terminated
 * attempt is rejected. `logicalCost` is always copied from the attempt,
 * never caller-suppliable, and `applyCostSpend` is never called here — cost
 * was already accounted at attempt start. `latencyConsumed` is accounted
 * exactly once, after every structural/payload check passes, so a rejected
 * recording never spends latency and never appends a partial outcome.
 */
export function recordRouteOutcome(
  session: StressTestSession,
  deliberationState: DeliberationState,
  input: RecordRouteOutcomeInput
): DeliberationState {
  verifyDeliberationBinding(session, deliberationState);
  if (deliberationState.stopReason !== null) {
    throw new Error('recordRouteOutcome: deliberation has already stopped; no further RouteOutcome may be recorded');
  }
  if (input === null || typeof input !== 'object') {
    throw new Error('recordRouteOutcome: input must be an object');
  }
  assertNonEmptyString(input.attemptId, 'recordRouteOutcome: attemptId');
  assertValidAttemptStatus(input.status, 'recordRouteOutcome: status');

  const attempt = deliberationState.attempts.find((a) => a.attemptId === input.attemptId);
  if (!attempt) {
    throw new Error(`recordRouteOutcome: attemptId ${input.attemptId} is not a currently recorded RouteAttempt`);
  }
  if (deliberationState.outcomes.some((o) => o.attemptId === input.attemptId)) {
    throw new Error(`recordRouteOutcome: attempt ${input.attemptId} already has a RouteOutcome; one attempt has at most one outcome`);
  }

  const decision = validateAttemptProvenanceForOutcome(session, deliberationState, attempt);

  if (!isQuestionCurrent(deliberationState, attempt.questionId)) {
    throw new Error(`recordRouteOutcome: question ${attempt.questionId} is not current`);
  }
  const activeForOutcome = getActiveRouteDecisionsForQuestion(deliberationState, attempt.questionId);
  if (activeForOutcome.length === 0) {
    throw new Error(`recordRouteOutcome: question ${attempt.questionId} has no active deliberation cycle`);
  }
  if (activeForOutcome.length > 1) {
    throw new Error(
      `recordRouteOutcome: question ${attempt.questionId} has more than one active deliberation cycle -- inconsistent legacy state`
    );
  }
  if (activeForOutcome[0].id !== decision.id) {
    throw new Error(
      `recordRouteOutcome: question ${attempt.questionId}'s active deliberation cycle is a different RouteDecision than the one being terminalized`
    );
  }

  let allowedKeys: readonly string[];
  if (input.status === 'FAILED') {
    allowedKeys = ['attemptId', 'status', 'latencyConsumed', 'failure'];
  } else if (attempt.route === 'SEEK_EVIDENCE') {
    // The only route whose AttemptStatus allowlist includes INCONCLUSIVE
    // (§6) -- handled here, before the blanket INCONCLUSIVE rejection below,
    // regardless of whether this particular call is SUCCEEDED or
    // INCONCLUSIVE; the exact status/result pairing is validated later.
    allowedKeys = ['attemptId', 'status', 'latencyConsumed', 'result', 'evidenceSubjectId', 'citations'];
  } else if (input.status === 'INCONCLUSIVE') {
    throw new Error(
      `recordRouteOutcome: INCONCLUSIVE is not recordable for route ${attempt.route} -- only SEEK_EVIDENCE supports an indeterminate evidence result`
    );
  } else if (attempt.route === 'ADD_REVIEWER') {
    allowedKeys = ['attemptId', 'status', 'latencyConsumed', 'reviewerRunId', 'findingIds'];
  } else if (attempt.route === 'REPLICATE') {
    allowedKeys = ['attemptId', 'status', 'latencyConsumed', 'result', 'targetRef'];
  } else if (attempt.route === 'ADD_CONTEXT') {
    // Shape differs by result (SUPPLIED carries responseText, DECLINED does
    // not), so the exact-key set is chosen by raw result-string equality --
    // never by validated-result membership -- exactly the same
    // "peek at the raw discriminant before validating it" posture already
    // used for recordQuestionDisposition's SUPERSEDED_RECLASSIFIED branch.
    const rawResult = (input as { result?: unknown }).result;
    if (rawResult === 'NO_RESPONSE') {
      throw new Error(
        'recordRouteOutcome: ADD_CONTEXT result NO_RESPONSE is never recordable through recordRouteOutcome -- only the dedicated closeContextRequestWithoutResponse operation may create it (Slice 2D-C4)'
      );
    }
    if (rawResult === 'SUPPLIED') {
      allowedKeys = ['attemptId', 'status', 'latencyConsumed', 'result', 'contextRequestId', 'responseText'];
    } else if (rawResult === 'DECLINED') {
      allowedKeys = ['attemptId', 'status', 'latencyConsumed', 'result', 'contextRequestId'];
    } else {
      throw new Error(`recordRouteOutcome: invalid or unsupported ADD_CONTEXT result ${JSON.stringify(rawResult)}`);
    }
  } else if (attempt.route === 'TARGETED_PEER_CHALLENGE') {
    allowedKeys = ['attemptId', 'status', 'latencyConsumed', 'targetRef', 'sourceRef', 'boundedExcerpt', 'response', 'result'];
  } else {
    throw new Error(
      `recordRouteOutcome: SUCCEEDED result recording for route ${attempt.route} is not authorized in Slice 2D-B1`
    );
  }
  assertExactKeys(input, allowedKeys, 'recordRouteOutcome');
  assertFiniteNonNegative(input.latencyConsumed, 'recordRouteOutcome: latencyConsumed');

  if (input.status === 'FAILED') {
    assertValidFailureInfo(input.failure as FailureInfo, 'recordRouteOutcome: failure');

    const withLatency = applyLatencySpend(deliberationState, input.latencyConsumed);
    verifyDeliberationBinding(session, deliberationState);

    const outcome: FailedRouteOutcome = {
      attemptId: attempt.attemptId,
      decisionId: attempt.decisionId,
      originatingQuestionId: attempt.questionId,
      route: attempt.route,
      sessionId: attempt.sessionId,
      artifactHash: attempt.artifactHash,
      authorContextHash: attempt.authorContextHash,
      completedAt: nowIso(),
      status: 'FAILED',
      logicalCost: attempt.logicalCost,
      latencyConsumed: input.latencyConsumed,
      failure: cloneFailureInfo(input.failure as FailureInfo),
    };
    return { ...withLatency, outcomes: [...withLatency.outcomes, outcome] };
  }

  if (attempt.route === 'SEEK_EVIDENCE') {
    const result = input.result as SeekEvidenceResult;
    const citations = input.citations as EvidenceCitation[];
    const evidenceSubjectId = input.evidenceSubjectId as string;

    assertSeekEvidenceStatusResultAndCitations(input.status, result, citations, 'recordRouteOutcome');
    assertNonEmptyString(evidenceSubjectId, 'recordRouteOutcome: evidenceSubjectId');

    // Global before local, and never assume C5-A's earlier planning/
    // recording/attempt-start gates already proved this for state that may
    // have changed since: the question must still have exactly one valid
    // EvidenceSubject, and the caller-supplied evidenceSubjectId must
    // resolve to that exact subject -- readiness alone is not sufficient
    // because the caller must identify which subject this result evaluates
    // (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §13.D decision V,
    // Slice 2D-C5-B). Reuses the C5-A shared ledger validator
    // (`assertSeekEvidenceSubjectReady` -> `assertEvidenceSubjectLedgerIntegrity`
    // -> `assertSemanticIssueEvidenceLeaf`) rather than reimplementing
    // sourceRef/leaf-finding logic here -- the exact lesson the Slice
    // 2D-C5-A amendment closed.
    assertSeekEvidenceSubjectReady(session, deliberationState, attempt.questionId);
    const resolvedSubject = effectiveEvidenceSubjects(deliberationState).find(
      (s) => s.originatingQuestionId === attempt.questionId
    );
    if (!resolvedSubject || resolvedSubject.id !== evidenceSubjectId) {
      throw new Error(
        `recordRouteOutcome: evidenceSubjectId ${evidenceSubjectId} does not match the exact EvidenceSubject registered for question ${attempt.questionId}`
      );
    }

    const withLatency = applyLatencySpend(deliberationState, input.latencyConsumed);
    verifyDeliberationBinding(session, deliberationState);

    let outcome: SeekEvidenceRouteOutcome;
    if (result === 'INCONCLUSIVE') {
      outcome = {
        attemptId: attempt.attemptId,
        decisionId: attempt.decisionId,
        originatingQuestionId: attempt.questionId,
        route: 'SEEK_EVIDENCE',
        sessionId: attempt.sessionId,
        artifactHash: attempt.artifactHash,
        authorContextHash: attempt.authorContextHash,
        completedAt: nowIso(),
        status: 'INCONCLUSIVE',
        logicalCost: attempt.logicalCost,
        latencyConsumed: input.latencyConsumed,
        result: 'INCONCLUSIVE',
        evidenceSubjectId,
        citations: cloneEvidenceCitations(citations),
      };
    } else {
      outcome = {
        attemptId: attempt.attemptId,
        decisionId: attempt.decisionId,
        originatingQuestionId: attempt.questionId,
        route: 'SEEK_EVIDENCE',
        sessionId: attempt.sessionId,
        artifactHash: attempt.artifactHash,
        authorContextHash: attempt.authorContextHash,
        completedAt: nowIso(),
        status: 'SUCCEEDED',
        logicalCost: attempt.logicalCost,
        latencyConsumed: input.latencyConsumed,
        result,
        evidenceSubjectId,
        citations: cloneEvidenceCitations(citations),
      };
    }
    return { ...withLatency, outcomes: [...withLatency.outcomes, outcome] };
  }

  if (attempt.route === 'ADD_REVIEWER') {
    const reviewerRunId = input.reviewerRunId as string;
    assertNonEmptyString(reviewerRunId, 'recordRouteOutcome: reviewerRunId');
    if (reviewerRunId === attempt.attemptId) {
      throw new Error('recordRouteOutcome: reviewerRunId must not equal attemptId -- they are separate identities, never made equal');
    }
    if (!Array.isArray(input.findingIds)) {
      throw new Error('recordRouteOutcome: findingIds must be an array');
    }
    const seenFindingIds = new Set<string>();
    for (const findingId of input.findingIds) {
      assertNonEmptyString(findingId, 'recordRouteOutcome: findingIds[]');
      if (seenFindingIds.has(findingId)) {
        throw new Error(`recordRouteOutcome: duplicate findingId ${findingId}`);
      }
      seenFindingIds.add(findingId);
      const finding = session.findings[findingId];
      if (!finding) {
        throw new Error(`recordRouteOutcome: unknown findingId ${findingId}`);
      }
      if (finding.reviewerRunId !== reviewerRunId) {
        throw new Error(`recordRouteOutcome: finding ${findingId}'s reviewerRunId does not match the supplied reviewerRunId`);
      }
      const findingCreatedAtMs = Date.parse(finding.createdAt);
      if (Number.isNaN(findingCreatedAtMs)) {
        throw new Error(`recordRouteOutcome: finding ${findingId} has an unparseable createdAt`);
      }
      if (findingCreatedAtMs < Date.parse(attempt.startedAt)) {
        throw new Error(`recordRouteOutcome: finding ${findingId}.createdAt is before the attempt's startedAt`);
      }
    }
    const reviewerRunIdReused = deliberationState.outcomes.some(
      (o): o is AddReviewerRouteOutcome =>
        o.route === 'ADD_REVIEWER' && o.status === 'SUCCEEDED' && o.reviewerRunId === reviewerRunId
    );
    if (reviewerRunIdReused) {
      throw new Error(
        `recordRouteOutcome: reviewerRunId ${reviewerRunId} was already claimed by an earlier successful ADD_REVIEWER RouteOutcome in this session`
      );
    }

    const withLatency = applyLatencySpend(deliberationState, input.latencyConsumed);
    verifyDeliberationBinding(session, deliberationState);

    const outcome: AddReviewerRouteOutcome = {
      attemptId: attempt.attemptId,
      decisionId: attempt.decisionId,
      originatingQuestionId: attempt.questionId,
      route: 'ADD_REVIEWER',
      sessionId: attempt.sessionId,
      artifactHash: attempt.artifactHash,
      authorContextHash: attempt.authorContextHash,
      completedAt: nowIso(),
      status: 'SUCCEEDED',
      logicalCost: attempt.logicalCost,
      latencyConsumed: input.latencyConsumed,
      reviewerRunId,
      findingIds: [...input.findingIds],
    };
    return { ...withLatency, outcomes: [...withLatency.outcomes, outcome] };
  }

  if (attempt.route === 'ADD_CONTEXT') {
    const result = input.result as 'SUPPLIED' | 'DECLINED';
    const contextRequestId = input.contextRequestId as string;
    assertNonEmptyString(contextRequestId, 'recordRouteOutcome: contextRequestId');

    // Mandatory: the COMPLETE ContextRequest ledger must be sound before a
    // single selected request from it is ever trusted -- agreement between
    // the outcome input and one request alone is insufficient if the
    // request/attempt/state chain elsewhere in the ledger is already corrupt
    // (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §7, Slice 2D-C2;
    // reaffirms the Slice 2D-C1 amendment's authoritative-upstream posture).
    assertContextRequestLedgerIntegrity(deliberationState);

    const matchingRequests = effectiveContextRequests(deliberationState).filter((r) => r.id === contextRequestId);
    if (matchingRequests.length !== 1) {
      throw new Error(`recordRouteOutcome: contextRequestId ${contextRequestId} does not resolve to exactly one ContextRequest`);
    }
    const contextRequest = matchingRequests[0];
    if (contextRequest.originatingAttemptId !== attempt.attemptId) {
      throw new Error(
        'recordRouteOutcome: contextRequest.originatingAttemptId does not match the attempt being terminalized -- a request from another attempt is never valid provenance'
      );
    }
    if (contextRequest.originatingQuestionId !== attempt.questionId) {
      throw new Error('recordRouteOutcome: contextRequest.originatingQuestionId does not match attempt.questionId');
    }
    if (contextRequest.originatingSessionId !== attempt.sessionId) {
      throw new Error('recordRouteOutcome: contextRequest.originatingSessionId does not match the attempt session binding');
    }
    if (contextRequest.artifactHash !== attempt.artifactHash) {
      throw new Error('recordRouteOutcome: contextRequest.artifactHash does not match the attempt binding');
    }
    if (contextRequest.authorContextHash !== attempt.authorContextHash) {
      throw new Error('recordRouteOutcome: contextRequest.authorContextHash does not match the attempt binding');
    }

    if (result === 'SUPPLIED') {
      const responseText = input.responseText as string;
      assertNonEmptyString(responseText, 'recordRouteOutcome: responseText');

      const withLatency = applyLatencySpend(deliberationState, input.latencyConsumed);
      verifyDeliberationBinding(session, deliberationState);

      const outcome: AddContextSuppliedRouteOutcome = {
        attemptId: attempt.attemptId,
        decisionId: attempt.decisionId,
        originatingQuestionId: attempt.questionId,
        route: 'ADD_CONTEXT',
        sessionId: attempt.sessionId,
        artifactHash: attempt.artifactHash,
        authorContextHash: attempt.authorContextHash,
        completedAt: nowIso(),
        status: 'SUCCEEDED',
        logicalCost: attempt.logicalCost,
        latencyConsumed: input.latencyConsumed,
        result: 'SUPPLIED',
        contextRequestId,
        responseText,
      };
      return { ...withLatency, outcomes: [...withLatency.outcomes, outcome] };
    }

    // result === 'DECLINED'
    const withLatency = applyLatencySpend(deliberationState, input.latencyConsumed);
    verifyDeliberationBinding(session, deliberationState);

    const outcome: AddContextDeclinedRouteOutcome = {
      attemptId: attempt.attemptId,
      decisionId: attempt.decisionId,
      originatingQuestionId: attempt.questionId,
      route: 'ADD_CONTEXT',
      sessionId: attempt.sessionId,
      artifactHash: attempt.artifactHash,
      authorContextHash: attempt.authorContextHash,
      completedAt: nowIso(),
      status: 'SUCCEEDED',
      logicalCost: attempt.logicalCost,
      latencyConsumed: input.latencyConsumed,
      result: 'DECLINED',
      contextRequestId,
    };
    return { ...withLatency, outcomes: [...withLatency.outcomes, outcome] };
  }

  if (attempt.route === 'TARGETED_PEER_CHALLENGE') {
    const targetRef = input.targetRef as RouteInputRef;
    const sourceRef = input.sourceRef as RouteInputRef;
    const boundedExcerpt = input.boundedExcerpt as TargetedPeerChallengeBoundedExcerpt;
    const response = input.response as string;
    const result = input.result as TargetedPeerChallengeResult;

    // Global before local, and never assume C6-A's earlier planning/
    // recording/attempt-start gates already proved this for state that may
    // have changed since -- the question must still carry at least two
    // distinct, valid RouteInputRefs (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md
    // §13.E, Slice 2D-C6-0/C6-A, reused rather than reimplemented).
    assertTargetedPeerChallengeReady(session, deliberationState, attempt.questionId);
    assertTargetedPeerChallengeResultPayload(
      input.status,
      result,
      targetRef,
      sourceRef,
      boundedExcerpt,
      response,
      decision.inputRefs,
      session,
      'recordRouteOutcome'
    );

    const withLatency = applyLatencySpend(deliberationState, input.latencyConsumed);
    verifyDeliberationBinding(session, deliberationState);

    const outcome: TargetedPeerChallengeRouteOutcome = {
      attemptId: attempt.attemptId,
      decisionId: attempt.decisionId,
      originatingQuestionId: attempt.questionId,
      route: 'TARGETED_PEER_CHALLENGE',
      sessionId: attempt.sessionId,
      artifactHash: attempt.artifactHash,
      authorContextHash: attempt.authorContextHash,
      completedAt: nowIso(),
      status: 'SUCCEEDED',
      logicalCost: attempt.logicalCost,
      latencyConsumed: input.latencyConsumed,
      targetRef: cloneRouteInputRef(targetRef),
      sourceRef: cloneRouteInputRef(sourceRef),
      boundedExcerpt: cloneTargetedPeerChallengeBoundedExcerpt(boundedExcerpt),
      response,
      result,
    };
    return { ...withLatency, outcomes: [...withLatency.outcomes, outcome] };
  }

  // attempt.route === 'REPLICATE'
  const result = input.result as ReplicationResult;
  assertValidReplicationResult(result, 'recordRouteOutcome: result');
  const targetRef = input.targetRef as RouteInputRef;
  if (targetRef === null || typeof targetRef !== 'object') {
    throw new Error('recordRouteOutcome: targetRef must be an object');
  }
  validateRouteInputRef(session, targetRef);
  if (targetRef.kind === 'AUTHOR_CONTEXT_ITEM') {
    throw new Error('recordRouteOutcome: REPLICATE targetRef must be FINDING or SEMANTIC_ISSUE, not AUTHOR_CONTEXT_ITEM');
  }
  const targetRefMatchesDecision = decision.inputRefs.some((ref) => ref.kind === targetRef.kind && ref.id === targetRef.id);
  if (!targetRefMatchesDecision) {
    throw new Error('recordRouteOutcome: REPLICATE targetRef must exactly match one of the recorded RouteDecision.inputRefs');
  }

  const withLatency = applyLatencySpend(deliberationState, input.latencyConsumed);
  verifyDeliberationBinding(session, deliberationState);

  const outcome: ReplicationRouteOutcome = {
    attemptId: attempt.attemptId,
    decisionId: attempt.decisionId,
    originatingQuestionId: attempt.questionId,
    route: 'REPLICATE',
    sessionId: attempt.sessionId,
    artifactHash: attempt.artifactHash,
    authorContextHash: attempt.authorContextHash,
    completedAt: nowIso(),
    status: 'SUCCEEDED',
    logicalCost: attempt.logicalCost,
    latencyConsumed: input.latencyConsumed,
    result,
    targetRef: cloneRouteInputRef(targetRef),
  };
  return { ...withLatency, outcomes: [...withLatency.outcomes, outcome] };
}

/** The caller-suppliable shape for `recordQuestionDisposition`. Every derived/generated field (questionId, sessionId, artifactHash, authorContextHash, createdAt) is deliberately absent -- `assertExactKeys` independently rejects any of them if supplied, regardless of what TypeScript's own shape implies. */
export interface RecordStillOpenOrResolvedDispositionInput {
  attemptId: string;
  disposition: 'STILL_OPEN' | 'RESOLVED';
  reason: string;
}

/**
 * `replacementQuestion` (`Q2`) is caller-owned -- typically, but not
 * necessarily, the direct output of `createUnresolvedQuestion` -- and is
 * independently revalidated from scratch, never trusted merely because it
 * has the right shape (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §9,
 * Slice 2D-B2-B0 freeze, §H).
 */
export interface RecordSupersededDispositionInput {
  attemptId: string;
  disposition: 'SUPERSEDED_RECLASSIFIED';
  reason: string;
  replacementQuestion: UnresolvedQuestion;
}

export type RecordQuestionDispositionInput = RecordStillOpenOrResolvedDispositionInput | RecordSupersededDispositionInput;

/**
 * Records the immutable fact of one semantic re-evaluation of a terminal
 * `RouteOutcome` — offline audit bookkeeping only; never computes the
 * disposition itself, never executes a route, never touches
 * `HumanAdjudication`/`RevisionAction`/`ReviewFinding`/`SemanticIssue`/the
 * frozen artifact or context
 * (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §9, §28).
 *
 * `attemptId` resolves the full chain — `RouteOutcome` -> `RouteAttempt` ->
 * `RouteDecision` (via `resolveUniqueRouteDecisionById`, never a blind
 * first match) -> registered `UnresolvedQuestion` — with every link
 * independently re-checked, exactly the "never trust an upstream check for
 * pre-existing state" posture this module takes everywhere else. The
 * target question must already be current (an intrinsic precondition of
 * this operation, not a retrofit onto a pre-existing API), and must have
 * **exactly one** active deliberation cycle, which must be the exact
 * `RouteDecision` this outcome terminates — `0`, `>1`, or a
 * different-cycle result all reject; a legacy-inconsistent `>1` is never
 * automatically reconciled. `ONE RouteOutcome -> AT MOST ONE
 * QuestionDisposition`: a second disposition for an already-disposed
 * outcome is rejected outright.
 *
 * Slice 2D-B2-B additionally records `SUPERSEDED_RECLASSIFIED`, atomically
 * with registering its replacement question (§"SUPERSEDED_RECLASSIFIED
 * branch" below); `CROSS_SESSION` remains rejected outright on this
 * ordinary path -- as of Slice 2D-C3, `CROSS_SESSION` runtime exists, but
 * only `createCrossSessionTransition`'s own atomic operation may ever
 * construct one, after independently satisfying every ordinary disposition
 * precondition itself plus its own additional cross-session provenance
 * chain.
 */
export function recordQuestionDisposition(
  session: StressTestSession,
  deliberationState: DeliberationState,
  input: RecordQuestionDispositionInput
): DeliberationState {
  verifyDeliberationBinding(session, deliberationState);
  if (deliberationState.stopReason !== null) {
    throw new Error('recordQuestionDisposition: deliberation has already stopped; no further QuestionDisposition may be recorded');
  }
  if (input === null || typeof input !== 'object') {
    throw new Error('recordQuestionDisposition: input must be an object');
  }
  // Exact-key set is chosen by raw disposition-string equality, not by
  // validated disposition membership -- so a STILL_OPEN/RESOLVED/garbage
  // input keeps exactly the original three-key check (and its original
  // error precedence) it always had; only a literal 'SUPERSEDED_RECLASSIFIED'
  // input gets the wider four-key set.
  const allowedKeys: readonly string[] =
    (input as { disposition?: unknown }).disposition === 'SUPERSEDED_RECLASSIFIED'
      ? ['attemptId', 'disposition', 'reason', 'replacementQuestion']
      : ['attemptId', 'disposition', 'reason'];
  assertExactKeys(input, allowedKeys, 'recordQuestionDisposition');
  assertNonEmptyString(input.attemptId, 'recordQuestionDisposition: attemptId');
  if (!RECORDABLE_QUESTION_DISPOSITION_KINDS.includes(input.disposition)) {
    throw new Error(`recordQuestionDisposition: invalid or unsupported disposition ${JSON.stringify(input.disposition)}`);
  }
  assertNonEmptyString(input.reason, 'recordQuestionDisposition: reason');
  if (input.disposition === 'SUPERSEDED_RECLASSIFIED' && input.replacementQuestion === undefined) {
    throw new Error('recordQuestionDisposition: SUPERSEDED_RECLASSIFIED requires replacementQuestion');
  }

  const matchingOutcomes = deliberationState.outcomes.filter((o) => o.attemptId === input.attemptId);
  if (matchingOutcomes.length === 0) {
    throw new Error(`recordQuestionDisposition: attemptId ${input.attemptId} does not resolve to any recorded RouteOutcome`);
  }
  if (matchingOutcomes.length > 1) {
    throw new Error(
      `recordQuestionDisposition: attemptId ${input.attemptId} resolves to more than one RouteOutcome -- inconsistent state`
    );
  }
  const outcome = matchingOutcomes[0];

  if (deliberationState.questionDispositions.some((d) => d.attemptId === outcome.attemptId)) {
    throw new Error(`recordQuestionDisposition: the RouteOutcome for attemptId ${input.attemptId} already has a QuestionDisposition`);
  }

  const matchingAttempts = deliberationState.attempts.filter((a) => a.attemptId === outcome.attemptId);
  if (matchingAttempts.length !== 1) {
    throw new Error(`recordQuestionDisposition: outcome.attemptId ${outcome.attemptId} does not resolve to exactly one RouteAttempt`);
  }
  const attempt = matchingAttempts[0];

  const decision = resolveUniqueRouteDecisionById(deliberationState, attempt.decisionId, 'recordQuestionDisposition');
  if (decision.route === 'STOP') {
    throw new Error('recordQuestionDisposition: STOP has no RouteAttempt/RouteOutcome/QuestionDisposition');
  }
  if (decision.questionId !== attempt.questionId) {
    throw new Error('recordQuestionDisposition: recorded decision questionId does not match the attempt questionId');
  }
  if (outcome.decisionId !== decision.id) {
    throw new Error('recordQuestionDisposition: outcome.decisionId does not match the resolved decision');
  }
  if (outcome.originatingQuestionId !== decision.questionId) {
    throw new Error('recordQuestionDisposition: outcome.originatingQuestionId does not match the resolved decision questionId');
  }
  if (outcome.route !== attempt.route || attempt.route !== decision.route) {
    throw new Error('recordQuestionDisposition: route is inconsistent across outcome/attempt/decision');
  }

  // A claim-evaluating SEEK_EVIDENCE outcome (SUPPORTIVE/CONTRADICTORY/
  // INCONCLUSIVE) is never trusted as a semantic re-evaluation target merely
  // because it is present in state -- its own route-specific provenance
  // (EvidenceSubject, leaf finding, citation schema) is independently
  // re-validated here, before any disposition is recorded against it
  // (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §13.D decision V; Slice
  // 2D-C5-B, §33). A no-op for every non-claim-evaluating outcome.
  assertSeekEvidenceOutcomeIntegrity(session, deliberationState, outcome);

  // A successful TARGETED_PEER_CHALLENGE outcome is never trusted as a
  // semantic re-evaluation target merely because it is present in state --
  // its own route-specific provenance (TPC readiness, targetRef/sourceRef
  // membership and distinctness, boundedExcerpt/response validity) is
  // independently re-validated here, before any disposition is recorded
  // against it (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §13.E, Slice
  // 2D-C6-B). A no-op for every non-TPC-success outcome, including generic
  // FAILED. `isQuestionCurrent` itself stays state-only, unchanged.
  assertTargetedPeerChallengeOutcomeIntegrity(session, deliberationState, outcome);

  const questionId = decision.questionId;
  if (typeof questionId !== 'string' || questionId.length === 0) {
    throw new Error('recordQuestionDisposition: resolved decision has no non-empty questionId');
  }
  const matchingQuestions = deliberationState.unresolvedQuestions.filter((q) => q.id === questionId);
  if (matchingQuestions.length !== 1) {
    throw new Error(
      `recordQuestionDisposition: questionId ${questionId} does not resolve to exactly one registered UnresolvedQuestion`
    );
  }

  if (attempt.sessionId !== deliberationState.sessionId || attempt.sessionId !== session.id) {
    throw new Error('recordQuestionDisposition: attempt.sessionId does not match the current session/DeliberationState binding');
  }
  if (attempt.artifactHash !== deliberationState.artifactHash || attempt.artifactHash !== session.artifactHash) {
    throw new Error('recordQuestionDisposition: attempt.artifactHash does not match the current session/DeliberationState binding');
  }
  if (attempt.authorContextHash !== deliberationState.authorContextHash || attempt.authorContextHash !== session.authorContextHash) {
    throw new Error('recordQuestionDisposition: attempt.authorContextHash does not match the current session/DeliberationState binding');
  }
  if (
    outcome.sessionId !== attempt.sessionId ||
    outcome.artifactHash !== attempt.artifactHash ||
    outcome.authorContextHash !== attempt.authorContextHash
  ) {
    throw new Error("recordQuestionDisposition: outcome's session/hash binding does not match the attempt it terminates");
  }

  if (!isQuestionCurrent(deliberationState, questionId)) {
    throw new Error(`recordQuestionDisposition: question ${questionId} is not current`);
  }
  const activeForDisposition = getActiveRouteDecisionsForQuestion(deliberationState, questionId);
  if (activeForDisposition.length === 0) {
    throw new Error(`recordQuestionDisposition: question ${questionId} has no active deliberation cycle`);
  }
  if (activeForDisposition.length > 1) {
    throw new Error(
      `recordQuestionDisposition: question ${questionId} has more than one active deliberation cycle -- inconsistent legacy state`
    );
  }
  if (activeForDisposition[0].id !== decision.id) {
    throw new Error(
      `recordQuestionDisposition: question ${questionId}'s active deliberation cycle is a different RouteDecision than the one this outcome terminates`
    );
  }

  verifyDeliberationBinding(session, deliberationState);

  const newDisposition: QuestionDisposition = {
    attemptId: outcome.attemptId,
    questionId,
    sessionId: attempt.sessionId,
    artifactHash: attempt.artifactHash,
    authorContextHash: attempt.authorContextHash,
    disposition: input.disposition,
    reason: input.reason,
    createdAt: nowIso(),
  };

  if (input.disposition !== 'SUPERSEDED_RECLASSIFIED') {
    return {
      ...deliberationState,
      questionDispositions: [...deliberationState.questionDispositions, newDisposition],
    };
  }

  // SUPERSEDED_RECLASSIFIED branch (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md
  // §9, Slice 2D-B2-B0 freeze, §I/§H/§P): write-time existing-child check,
  // then full independent revalidation of the caller-owned replacement
  // question, then one atomic dual-append -- both facts land together, or
  // (via every throw above and below) neither does.
  const existingChildren = deliberationState.unresolvedQuestions.filter(
    (q) => effectiveDerivedFromQuestionId(q) === questionId
  );
  if (existingChildren.length === 1) {
    throw new Error(`recordQuestionDisposition: question ${questionId} already has a registered replacement question`);
  }
  if (existingChildren.length > 1) {
    throw new Error(
      `recordQuestionDisposition: question ${questionId} already has more than one registered replacement question -- inconsistent legacy state`
    );
  }

  const replacement = input.replacementQuestion;
  if (replacement === null || typeof replacement !== 'object') {
    throw new Error('recordQuestionDisposition: replacementQuestion must be an object');
  }
  assertNonEmptyString(replacement.id, 'recordQuestionDisposition: replacementQuestion.id');
  if (replacement.id === questionId) {
    throw new Error('recordQuestionDisposition: replacementQuestion.id must be distinct from the superseded question id');
  }
  if (deliberationState.unresolvedQuestions.some((q) => q.id === replacement.id)) {
    throw new Error(`recordQuestionDisposition: replacementQuestion.id ${replacement.id} is already registered`);
  }
  assertValidRootCause(replacement.rootCause, 'recordQuestionDisposition: replacementQuestion');
  if (replacement.rootCause === 'NONE') {
    throw new Error('recordQuestionDisposition: replacementQuestion.rootCause must not be NONE');
  }
  assertNonEmptyMaterialityReason(replacement.materialityReason);
  if (!Array.isArray(replacement.inputRefs) || replacement.inputRefs.length === 0) {
    throw new Error('recordQuestionDisposition: replacementQuestion.inputRefs must be a non-empty array');
  }
  for (const ref of replacement.inputRefs) validateRouteInputRef(session, ref);
  if (typeof replacement.createdAt !== 'string' || Number.isNaN(Date.parse(replacement.createdAt))) {
    throw new Error('recordQuestionDisposition: replacementQuestion.createdAt is not a valid parseable timestamp');
  }
  const replacementLineage = effectiveDerivedFromQuestionId(replacement);
  if (replacementLineage !== questionId) {
    throw new Error(
      `recordQuestionDisposition: replacementQuestion.derivedFromQuestionId must exactly equal the superseded question id ${questionId}`
    );
  }

  const replacementQuestionSnapshot: UnresolvedQuestion = {
    id: replacement.id,
    inputRefs: cloneRouteInputRefs(replacement.inputRefs),
    rootCause: replacement.rootCause,
    materialityReason: replacement.materialityReason,
    createdAt: replacement.createdAt,
    derivedFromQuestionId: questionId,
  };

  return {
    ...deliberationState,
    unresolvedQuestions: [...deliberationState.unresolvedQuestions, replacementQuestionSnapshot],
    questionDispositions: [...deliberationState.questionDispositions, newDisposition],
  };
}

/**
 * Pure logical-call accounting — never a transport-retry primitive.
 * transportMaxRetries is deliberately not imported or referenced anywhere
 * in this module (MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md §12).
 */
export function applyCostSpend(deliberationState: DeliberationState, amount: number): DeliberationState {
  assertFiniteNonNegative(amount, 'applyCostSpend: amount');
  const spent = deliberationState.costBudget.spent + amount;
  assertFiniteNonNegative(spent, 'applyCostSpend: resulting spent');
  if (spent > deliberationState.costBudget.ceiling) {
    throw new Error(
      `applyCostSpend: spending ${amount} would exceed the cost ceiling (spent=${deliberationState.costBudget.spent}, ceiling=${deliberationState.costBudget.ceiling})`
    );
  }
  return { ...deliberationState, costBudget: { ...deliberationState.costBudget, spent } };
}

export function applyLatencySpend(deliberationState: DeliberationState, amount: number): DeliberationState {
  assertFiniteNonNegative(amount, 'applyLatencySpend: amount');
  const spent = deliberationState.latencyBudget.spent + amount;
  assertFiniteNonNegative(spent, 'applyLatencySpend: resulting spent');
  if (spent > deliberationState.latencyBudget.ceiling) {
    throw new Error(
      `applyLatencySpend: spending ${amount} would exceed the latency ceiling (spent=${deliberationState.latencyBudget.spent}, ceiling=${deliberationState.latencyBudget.ceiling})`
    );
  }
  return { ...deliberationState, latencyBudget: { ...deliberationState.latencyBudget, spent } };
}

export type AuthorContextCategoryName = (typeof AUTHOR_CONTEXT_CATEGORIES)[number];

/**
 * The pure route-output shape for ADD_CONTEXT. Emitting one never mutates
 * AuthorContext, never creates a new StressTestSession, and never
 * unfreezes anything — the version transition this would eventually seed
 * is explicitly out of scope for this slice
 * (MINIMUM_NECESSARY_DELIBERATION_CONTRACT.md §4, §18).
 *
 * `sourceRefs` and the implied rootCause are never independently supplied
 * by the caller — they are always derived from the registered
 * `originatingQuestionId`, so provenance cannot diverge between the
 * question that justified the request and the request itself. The audit
 * chain is StressTestSession -> UnresolvedQuestion -> ContextRequest.
 */
export interface ContextRequest {
  id: string;
  originatingSessionId: string;
  originatingQuestionId: string;
  /** The exact ADD_CONTEXT RouteAttempt that caused this request; no reverse field on RouteAttempt, no parallel binding ledger (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §7, Slice 2D-C0 freeze). */
  originatingAttemptId: string;
  artifactHash: string;
  authorContextHash: string;
  sourceRefs: RouteInputRef[];
  category: AuthorContextCategoryName;
  question: string;
  inferenceReason: string;
  createdAt: string;
}

/**
 * Reads `DeliberationState.contextRequests` tolerating legacy state that
 * predates the field (missing/`undefined` -- read-time compatibility only,
 * never a mutation of the stored record, ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md
 * §7 "Legacy missing-`contextRequests` compatibility").
 */
function effectiveContextRequests(deliberationState: DeliberationState): ContextRequest[] {
  return (deliberationState as { contextRequests?: ContextRequest[] }).contextRequests ?? [];
}

/**
 * Validates the COMPLETE ContextRequest ledger, never only the one request a
 * caller happens to be creating (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md
 * §7, Slice 2D-C0 freeze, decision F): global `id` uniqueness; `ONE
 * ADD_CONTEXT RouteAttempt -> AT MOST ONE ContextRequest`; every request
 * resolves to an existing `ADD_CONTEXT` `RouteAttempt` -- itself independently
 * re-verified against the current `DeliberationState.sessionId`/
 * `artifactHash`/`authorContextHash` binding before anything else about it is
 * trusted (`DeliberationState -> RouteAttempt -> ContextRequest`, not merely
 * `RouteAttempt <-> ContextRequest`; a self-consistent but state-inconsistent
 * attempt/request pair must never be mistaken for authoritative history,
 * Slice 2D-C1 amendment) -- whose recorded `RouteDecision` is also
 * `ADD_CONTEXT` and whose `questionId` resolves to exactly one registered
 * `CONTEXT_GAP` question; every derived-and-copied field
 * (`originatingQuestionId`/`originatingSessionId`/`artifactHash`/
 * `authorContextHash`/`sourceRefs`) agrees with that resolved chain. Pure,
 * non-cached, non-memoized. Any violation fails closed; none is ever
 * automatically reconciled.
 */
function assertContextRequestLedgerIntegrity(deliberationState: DeliberationState): void {
  const seenRequestIds = new Set<string>();
  const seenAttemptIds = new Set<string>();

  for (const request of effectiveContextRequests(deliberationState)) {
    assertNonEmptyString(request.id, 'ContextRequest ledger entry: id');
    if (seenRequestIds.has(request.id)) {
      throw new Error(`ContextRequest ledger entry: duplicate ContextRequest.id ${request.id} -- identity-ambiguous legacy/inconsistent state`);
    }
    seenRequestIds.add(request.id);

    assertNonEmptyString(request.originatingAttemptId, 'ContextRequest ledger entry: originatingAttemptId');
    if (seenAttemptIds.has(request.originatingAttemptId)) {
      throw new Error(
        `ContextRequest ledger entry: more than one ContextRequest for attemptId ${request.originatingAttemptId} -- inconsistent state`
      );
    }
    seenAttemptIds.add(request.originatingAttemptId);

    const matchingAttempts = deliberationState.attempts.filter((a) => a.attemptId === request.originatingAttemptId);
    if (matchingAttempts.length !== 1) {
      throw new Error(
        `ContextRequest ledger entry: originatingAttemptId ${request.originatingAttemptId} does not resolve to exactly one RouteAttempt`
      );
    }
    const attempt = matchingAttempts[0];
    // The resolved RouteAttempt must itself belong to the current
    // DeliberationState binding before anything about it is trusted --
    // mutual agreement between a corrupted RouteAttempt and a ContextRequest
    // that faithfully copied that corrupted attempt's fields is never proof
    // of authoritative binding (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md
    // §7, Slice 2D-C1 amendment). DeliberationState -> RouteAttempt ->
    // ContextRequest, not merely RouteAttempt <-> ContextRequest.
    if (attempt.sessionId !== deliberationState.sessionId) {
      throw new Error(
        `ContextRequest ledger entry: attempt ${attempt.attemptId}'s sessionId does not match the current DeliberationState binding`
      );
    }
    if (attempt.artifactHash !== deliberationState.artifactHash) {
      throw new Error(
        `ContextRequest ledger entry: attempt ${attempt.attemptId}'s artifactHash does not match the current DeliberationState binding`
      );
    }
    if (attempt.authorContextHash !== deliberationState.authorContextHash) {
      throw new Error(
        `ContextRequest ledger entry: attempt ${attempt.attemptId}'s authorContextHash does not match the current DeliberationState binding`
      );
    }
    if (attempt.route !== 'ADD_CONTEXT') {
      throw new Error(`ContextRequest ledger entry: attempt ${attempt.attemptId} has route ${attempt.route}, not ADD_CONTEXT`);
    }

    const decision = resolveUniqueRouteDecisionById(deliberationState, attempt.decisionId, 'ContextRequest ledger entry');
    if (decision.route !== 'ADD_CONTEXT') {
      throw new Error(
        `ContextRequest ledger entry: recorded decision for attempt ${attempt.attemptId} has route ${decision.route}, not ADD_CONTEXT`
      );
    }
    if (attempt.questionId !== decision.questionId) {
      throw new Error('ContextRequest ledger entry: attempt.questionId does not match the resolved decision.questionId');
    }

    const matchingQuestions = deliberationState.unresolvedQuestions.filter((q) => q.id === attempt.questionId);
    if (matchingQuestions.length !== 1) {
      throw new Error(
        `ContextRequest ledger entry: attempt.questionId ${attempt.questionId} does not resolve to exactly one registered UnresolvedQuestion`
      );
    }
    const question = matchingQuestions[0];
    if (question.rootCause !== 'CONTEXT_GAP') {
      throw new Error(`ContextRequest ledger entry: registered question ${question.id} has rootCause ${question.rootCause}, not CONTEXT_GAP`);
    }

    if (request.originatingQuestionId !== question.id) {
      throw new Error('ContextRequest ledger entry: originatingQuestionId does not match the resolved question');
    }
    if (request.originatingSessionId !== attempt.sessionId) {
      throw new Error('ContextRequest ledger entry: originatingSessionId does not match the resolved attempt binding');
    }
    if (request.artifactHash !== attempt.artifactHash) {
      throw new Error('ContextRequest ledger entry: artifactHash does not match the resolved attempt binding');
    }
    if (request.authorContextHash !== attempt.authorContextHash) {
      throw new Error('ContextRequest ledger entry: authorContextHash does not match the resolved attempt binding');
    }
    if (!refsExactlyMatch(request.sourceRefs, question.inputRefs)) {
      throw new Error('ContextRequest ledger entry: sourceRefs do not exactly match the registered question inputRefs (order-sensitive)');
    }
    if (!AUTHOR_CONTEXT_CATEGORIES.includes(request.category)) {
      throw new Error(`ContextRequest ledger entry: invalid category ${JSON.stringify(request.category)}`);
    }
    assertNonEmptyString(request.question, 'ContextRequest ledger entry: question');
    assertNonEmptyString(request.inferenceReason, 'ContextRequest ledger entry: inferenceReason');
    if (Number.isNaN(Date.parse(request.createdAt))) {
      throw new Error('ContextRequest ledger entry: createdAt is not a valid parseable timestamp');
    }
  }
}

/**
 * Creates and records a `ContextRequest` for an already-started `ADD_CONTEXT`
 * `RouteAttempt` -- offline audit bookkeeping only; no provider/human
 * interaction occurs here (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §7,
 * Slice 2D-C0 freeze). `attemptId` resolves the full chain --
 * `RouteAttempt` -> `RouteDecision` (via `resolveUniqueRouteDecisionById`,
 * never a blind first match) -> registered `UnresolvedQuestion` -- with
 * every link independently re-checked; `questionId` is no longer accepted
 * as caller input (eliminates caller divergence). The targeted question must
 * be current, with **exactly one** active deliberation cycle matching the
 * exact decision the supplied attempt belongs to -- the "0 or 1 allowed"
 * exception from before attempt binding existed is gone. `ONE ADD_CONTEXT
 * RouteAttempt -> AT MOST ONE ContextRequest`: a second request for an
 * attempt that already has one is rejected outright. Returns both the new
 * `DeliberationState` (with the request atomically appended to
 * `contextRequests[]`) and an independent snapshot of the same request --
 * two separate objects, never aliased, so mutating one can never rewrite
 * the other's history.
 */
export function createContextRequest(
  session: StressTestSession,
  deliberationState: DeliberationState,
  input: {
    attemptId: string;
    category: AuthorContextCategoryName;
    question: string;
    inferenceReason: string;
  }
): { deliberationState: DeliberationState; contextRequest: ContextRequest } {
  verifyDeliberationBinding(session, deliberationState);
  if (deliberationState.stopReason !== null) {
    throw new Error('createContextRequest: deliberation has already stopped; no further ContextRequest may be created');
  }
  if (input === null || typeof input !== 'object') {
    throw new Error('createContextRequest: input must be an object');
  }
  assertExactKeys(input, ['attemptId', 'category', 'question', 'inferenceReason'], 'createContextRequest');
  assertNonEmptyString(input.attemptId, 'createContextRequest: attemptId');

  const matchingAttempts = deliberationState.attempts.filter((a) => a.attemptId === input.attemptId);
  if (matchingAttempts.length === 0) {
    throw new Error(`createContextRequest: attemptId ${input.attemptId} is not a currently recorded RouteAttempt`);
  }
  if (matchingAttempts.length > 1) {
    throw new Error(`createContextRequest: attemptId ${input.attemptId} matches more than one recorded RouteAttempt -- inconsistent state`);
  }
  const attempt = matchingAttempts[0];
  if (attempt.route !== 'ADD_CONTEXT') {
    throw new Error(`createContextRequest: attempt ${attempt.attemptId} has route ${attempt.route}, not ADD_CONTEXT`);
  }

  const decision = resolveUniqueRouteDecisionById(deliberationState, attempt.decisionId, 'createContextRequest');
  if (decision.route !== 'ADD_CONTEXT') {
    throw new Error(`createContextRequest: recorded decision for attempt ${attempt.attemptId} has route ${decision.route}, not ADD_CONTEXT`);
  }
  if (attempt.questionId !== decision.questionId) {
    throw new Error('createContextRequest: attempt.questionId does not match the resolved decision.questionId');
  }

  const matchingQuestions = deliberationState.unresolvedQuestions.filter((q) => q.id === attempt.questionId);
  if (matchingQuestions.length !== 1) {
    throw new Error(
      `createContextRequest: attempt.questionId ${attempt.questionId} does not resolve to exactly one registered UnresolvedQuestion`
    );
  }
  const registered = matchingQuestions[0];
  if (registered.rootCause !== 'CONTEXT_GAP') {
    throw new Error(`createContextRequest: registered question ${registered.id} has rootCause ${registered.rootCause}, not CONTEXT_GAP`);
  }
  if (registered.inputRefs.length === 0) {
    throw new Error(`createContextRequest: registered question ${registered.id} has no inputRefs`);
  }

  if (!isQuestionCurrent(deliberationState, registered.id)) {
    throw new Error(`createContextRequest: question ${registered.id} is not current`);
  }
  // Attempt binding now exists, so this is progressing an already-resolved
  // cycle, not merely checking in on a question in the abstract -- the
  // former "0 or 1 active cycles" allowance is gone (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md
  // §7, Slice 2D-C0 freeze, decision K).
  const activeForContextRequest = getActiveRouteDecisionsForQuestion(deliberationState, registered.id);
  if (activeForContextRequest.length === 0) {
    throw new Error(`createContextRequest: question ${registered.id} has no active deliberation cycle`);
  }
  if (activeForContextRequest.length > 1) {
    throw new Error(
      `createContextRequest: question ${registered.id} has more than one active deliberation cycle -- inconsistent legacy state`
    );
  }
  if (activeForContextRequest[0].id !== decision.id) {
    throw new Error(
      `createContextRequest: question ${registered.id}'s active deliberation cycle is a different RouteDecision than the one attempt ${attempt.attemptId} belongs to`
    );
  }

  if (attempt.sessionId !== deliberationState.sessionId || attempt.sessionId !== session.id) {
    throw new Error('createContextRequest: attempt.sessionId does not match the current session/DeliberationState binding');
  }
  if (attempt.artifactHash !== deliberationState.artifactHash || attempt.artifactHash !== session.artifactHash) {
    throw new Error('createContextRequest: attempt.artifactHash does not match the current session/DeliberationState binding');
  }
  if (attempt.authorContextHash !== deliberationState.authorContextHash || attempt.authorContextHash !== session.authorContextHash) {
    throw new Error('createContextRequest: attempt.authorContextHash does not match the current session/DeliberationState binding');
  }
  for (const ref of registered.inputRefs) validateRouteInputRef(session, ref);

  // Global ledger integrity is re-validated before this attempt's own
  // duplicate-request check -- a locally-scoped check alone cannot prove the
  // rest of the ledger is not already corrupt (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md
  // §7, Slice 2D-C0 freeze, decision F).
  assertContextRequestLedgerIntegrity(deliberationState);
  if (effectiveContextRequests(deliberationState).some((r) => r.originatingAttemptId === attempt.attemptId)) {
    throw new Error(`createContextRequest: attempt ${attempt.attemptId} already has a recorded ContextRequest`);
  }

  if (!AUTHOR_CONTEXT_CATEGORIES.includes(input.category)) {
    throw new Error(`createContextRequest: unknown category ${JSON.stringify(input.category)}`);
  }
  assertNonEmptyString(input.question, 'createContextRequest: question');
  assertNonEmptyString(input.inferenceReason, 'createContextRequest: inferenceReason');
  if (!session.artifactHash || !session.authorContextHash) {
    throw new Error('createContextRequest: session is missing its frozen artifactHash/authorContextHash');
  }
  const artifactHash = session.artifactHash;
  const authorContextHash = session.authorContextHash;

  const id = randomUUID();
  const createdAt = nowIso();
  const buildSnapshot = (): ContextRequest => ({
    id,
    originatingSessionId: session.id,
    originatingQuestionId: registered.id,
    originatingAttemptId: attempt.attemptId,
    artifactHash,
    authorContextHash,
    sourceRefs: cloneRouteInputRefs(registered.inputRefs),
    category: input.category,
    question: input.question,
    inferenceReason: input.inferenceReason,
    createdAt,
  });

  return {
    deliberationState: {
      ...deliberationState,
      contextRequests: [...effectiveContextRequests(deliberationState), buildSnapshot()],
    },
    contextRequest: buildSnapshot(),
  };
}

/**
 * Explicitly closes an `ADD_CONTEXT` `ContextRequest` without a `SUPPLIED`/
 * `DECLINED` response ever having been recorded for its `RouteAttempt` --
 * the one, dedicated lifecycle operation authorized to produce a
 * `NO_RESPONSE` `RouteOutcome` (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md
 * §13.A, Slice 2D-C4-0 freeze). `recordRouteOutcome` never accepts
 * `NO_RESPONSE` as a `result` value -- only this operation may create one,
 * the same "dedicated operation, not a generic branch" boundary
 * `createCrossSessionTransition` already establishes for `CROSS_SESSION`
 * (§13.A, Slice 2D-C3-0 freeze).
 *
 * `attemptId` resolves the full chain -- `RouteAttempt` -> `RouteDecision`
 * -> registered `UnresolvedQuestion` -> `ContextRequest` -- with every link
 * independently re-checked (`validateAttemptProvenanceForOutcome`, the
 * COMPLETE `ContextRequest` ledger integrity gate, currentness, and
 * exactly-one-active-cycle), never trusted merely because the attempt is
 * present in state. `ONE RouteAttempt -> AT MOST ONE RouteOutcome`: an
 * attempt that already has any terminal outcome (`SUPPLIED`, `DECLINED`,
 * `FAILED`, or an earlier `NO_RESPONSE`) rejects closure outright -- no
 * overwrite, no conversion, no late replacement. Records no
 * `QuestionDisposition` -- `AddContextResult` and `QuestionDisposition`
 * remain separate domains; the question remains current until a separately
 * supplied semantic re-evaluation records one. Caller supplies only
 * `attemptId` and `latencyConsumed`; every derived/generated field is
 * resolved from the audit chain, never caller-restated.
 */
export function closeContextRequestWithoutResponse(
  session: StressTestSession,
  deliberationState: DeliberationState,
  input: { attemptId: string; latencyConsumed: number }
): DeliberationState {
  verifyDeliberationBinding(session, deliberationState);
  if (deliberationState.stopReason !== null) {
    throw new Error('closeContextRequestWithoutResponse: deliberation has already stopped; no further closure may be recorded');
  }
  if (input === null || typeof input !== 'object') {
    throw new Error('closeContextRequestWithoutResponse: input must be an object');
  }
  assertExactKeys(input, ['attemptId', 'latencyConsumed'], 'closeContextRequestWithoutResponse');
  assertNonEmptyString(input.attemptId, 'closeContextRequestWithoutResponse: attemptId');
  assertFiniteNonNegative(input.latencyConsumed, 'closeContextRequestWithoutResponse: latencyConsumed');

  const matchingAttempts = deliberationState.attempts.filter((a) => a.attemptId === input.attemptId);
  if (matchingAttempts.length !== 1) {
    throw new Error(`closeContextRequestWithoutResponse: attemptId ${input.attemptId} does not resolve to exactly one RouteAttempt`);
  }
  const attempt = matchingAttempts[0];
  if (attempt.route !== 'ADD_CONTEXT') {
    throw new Error(`closeContextRequestWithoutResponse: attempt ${attempt.attemptId} has route ${attempt.route}, not ADD_CONTEXT`);
  }
  if (deliberationState.outcomes.some((o) => o.attemptId === attempt.attemptId)) {
    throw new Error(
      `closeContextRequestWithoutResponse: attempt ${attempt.attemptId} already has a RouteOutcome; one attempt has at most one outcome`
    );
  }

  const decision = validateAttemptProvenanceForOutcome(session, deliberationState, attempt);

  if (!isQuestionCurrent(deliberationState, attempt.questionId)) {
    throw new Error(`closeContextRequestWithoutResponse: question ${attempt.questionId} is not current`);
  }
  const activeForClosure = getActiveRouteDecisionsForQuestion(deliberationState, attempt.questionId);
  if (activeForClosure.length === 0) {
    throw new Error(`closeContextRequestWithoutResponse: question ${attempt.questionId} has no active deliberation cycle`);
  }
  if (activeForClosure.length > 1) {
    throw new Error(
      `closeContextRequestWithoutResponse: question ${attempt.questionId} has more than one active deliberation cycle -- inconsistent legacy state`
    );
  }
  if (activeForClosure[0].id !== decision.id) {
    throw new Error(
      `closeContextRequestWithoutResponse: question ${attempt.questionId}'s active deliberation cycle is a different RouteDecision than the one being terminalized`
    );
  }

  const registered = deliberationState.unresolvedQuestions.find((q) => q.id === attempt.questionId);
  if (!registered) {
    throw new Error(
      `closeContextRequestWithoutResponse: attempt ${attempt.attemptId}'s questionId ${attempt.questionId} is not a currently registered unresolved question`
    );
  }
  if (registered.rootCause !== 'CONTEXT_GAP') {
    throw new Error(`closeContextRequestWithoutResponse: registered question ${registered.id} has rootCause ${registered.rootCause}, not CONTEXT_GAP`);
  }

  if (deliberationState.questionDispositions.some((d) => d.attemptId === attempt.attemptId)) {
    throw new Error(`closeContextRequestWithoutResponse: attempt ${attempt.attemptId} already has a QuestionDisposition -- inconsistent lifecycle state`);
  }

  // Mandatory: the COMPLETE ContextRequest ledger must be sound before a
  // single selected request from it is ever trusted (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md
  // §13.A, Slice 2D-C4-0 freeze, decision E -- the same "global before local"
  // gate already required at createContextRequest and recordRouteOutcome's
  // ADD_CONTEXT branch, Slice 2D-C0/C1/C2).
  assertContextRequestLedgerIntegrity(deliberationState);
  const matchingRequests = effectiveContextRequests(deliberationState).filter((r) => r.originatingAttemptId === attempt.attemptId);
  if (matchingRequests.length !== 1) {
    throw new Error(
      `closeContextRequestWithoutResponse: attemptId ${attempt.attemptId} does not resolve to exactly one ContextRequest -- nothing to close`
    );
  }
  const contextRequest = matchingRequests[0];
  if (
    contextRequest.originatingQuestionId !== attempt.questionId ||
    contextRequest.originatingSessionId !== attempt.sessionId ||
    contextRequest.artifactHash !== attempt.artifactHash ||
    contextRequest.authorContextHash !== attempt.authorContextHash
  ) {
    throw new Error('closeContextRequestWithoutResponse: contextRequest binding does not match the resolved attempt');
  }

  const withLatency = applyLatencySpend(deliberationState, input.latencyConsumed);
  verifyDeliberationBinding(session, withLatency);

  const outcome: AddContextNoResponseRouteOutcome = {
    attemptId: attempt.attemptId,
    decisionId: attempt.decisionId,
    originatingQuestionId: attempt.questionId,
    route: 'ADD_CONTEXT',
    sessionId: attempt.sessionId,
    artifactHash: attempt.artifactHash,
    authorContextHash: attempt.authorContextHash,
    completedAt: nowIso(),
    status: 'SUCCEEDED',
    logicalCost: attempt.logicalCost,
    latencyConsumed: input.latencyConsumed,
    result: 'NO_RESPONSE',
    contextRequestId: contextRequest.id,
  };

  return { ...withLatency, outcomes: [...withLatency.outcomes, outcome] };
}

/**
 * The immutable, atomically-created cross-session-boundary lineage fact
 * (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §13.A, Slice 2D-C3-0 freeze).
 * Its own fresh `lineageId` is never overloaded onto `childSessionId`
 * (freeze decision B). `originatingQuestionId`/`contextRequestId` are
 * derived-and-copied convenience fields, independently re-verified against
 * the resolved provenance chain at every read boundary -- never trusted as
 * independently caller-authoritative. No `responseText` (already
 * authoritative on the `SUPPLIED` outcome and copied verbatim into the new
 * `AuthorContextItem`); no embedded child session or `ContextRequest`.
 */
export interface SessionVersionLineage {
  lineageId: string;
  parentSessionId: string;
  childSessionId: string;
  parentArtifactHash: string;
  parentAuthorContextHash: string;
  childArtifactHash: string;
  childAuthorContextHash: string;
  originatingQuestionId: string;
  suppliedOutcomeAttemptId: string;
  contextRequestId: string;
  addedAuthorContextItemId: string;
  createdAt: string;
}

/**
 * Reads `DeliberationState.sessionVersionLineages` tolerating legacy state
 * that predates the field (missing/`undefined` -- read-time compatibility
 * only, never a mutation of the stored record,
 * ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §13.A, decision Q).
 */
function effectiveSessionVersionLineages(deliberationState: DeliberationState): SessionVersionLineage[] {
  return (deliberationState as { sessionVersionLineages?: SessionVersionLineage[] }).sessionVersionLineages ?? [];
}

/**
 * Resolves `attemptId` to exactly one `RouteOutcome` and independently
 * re-validates it, from scratch, as a defensible `ADD_CONTEXT` `SUPPLIED`
 * authorization for a cross-session transition -- never trusted merely
 * because a stored `result` discriminant says so
 * (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §13.A, decision N, all
 * eleven steps). State-only (no `StressTestSession` parameter), mirroring
 * `assertContextRequestLedgerIntegrity`'s own established shape -- every
 * field is checked against `DeliberationState`'s own binding, never against
 * a session object, so this same function is reusable both by
 * `createCrossSessionTransition` (a fresh caller-named attempt) and by
 * `assertSessionVersionLineageLedgerIntegrity` (every *historical* lineage
 * entry's own recorded attempt, re-validated a second time at every read).
 *
 * **Slice 2D-C3-0 amendment -- parity with `validateAttemptProvenanceForOutcome`.**
 * This function must never be a weaker attempt/decision/question provenance
 * check than the one `recordRouteOutcome` already trusts -- it re-derives
 * every state-resolvable rule that validator enforces (attempt identity
 * fields, logical cost, `startedAt`, decision/question rootCause and
 * materiality agreement, exact input-ref matching, and the root-cause ->
 * route mapping), plus the `RouteOutcome` common-envelope fields that
 * validator cannot check (it runs before any outcome exists).
 */
function revalidateSuppliedOutcomeProvenance(
  deliberationState: DeliberationState,
  attemptId: string,
  label: string
): {
  outcome: AddContextSuppliedRouteOutcome;
  attempt: RouteAttempt;
  decision: RouteDecision;
  question: UnresolvedQuestion;
  contextRequest: ContextRequest;
} {
  assertNonEmptyString(attemptId, `${label}: suppliedOutcomeAttemptId`);

  const matchingOutcomes = deliberationState.outcomes.filter((o) => o.attemptId === attemptId);
  if (matchingOutcomes.length !== 1) {
    throw new Error(`${label}: suppliedOutcomeAttemptId ${attemptId} does not resolve to exactly one RouteOutcome`);
  }
  const outcome = matchingOutcomes[0];
  if (outcome.route !== 'ADD_CONTEXT') {
    throw new Error(`${label}: attemptId ${attemptId}'s RouteOutcome has route ${outcome.route}, not ADD_CONTEXT`);
  }
  if (outcome.status !== 'SUCCEEDED') {
    throw new Error(`${label}: attemptId ${attemptId}'s RouteOutcome status is ${outcome.status}, not SUCCEEDED`);
  }
  if (outcome.result !== 'SUPPLIED') {
    throw new Error(`${label}: attemptId ${attemptId}'s RouteOutcome result is ${outcome.result}, not SUPPLIED -- DECLINED can never authorize a cross-session transition`);
  }
  assertNonEmptyString(outcome.responseText, `${label}: outcome.responseText`);
  assertFiniteNonNegative(outcome.logicalCost, `${label}: outcome.logicalCost`);
  assertFiniteNonNegative(outcome.latencyConsumed, `${label}: outcome.latencyConsumed`);
  if (Number.isNaN(Date.parse(outcome.completedAt))) {
    throw new Error(`${label}: outcome.completedAt is not a valid parseable timestamp`);
  }

  const matchingAttempts = deliberationState.attempts.filter((a) => a.attemptId === outcome.attemptId);
  if (matchingAttempts.length !== 1) {
    throw new Error(`${label}: attemptId ${attemptId} does not resolve to exactly one RouteAttempt`);
  }
  const attempt = matchingAttempts[0];
  assertNonEmptyString(attempt.attemptId, `${label}: attempt.attemptId`);
  assertNonEmptyString(attempt.decisionId, `${label}: attempt.decisionId`);
  assertNonEmptyString(attempt.questionId, `${label}: attempt.questionId`);
  if (attempt.sessionId !== deliberationState.sessionId) {
    throw new Error(`${label}: attempt ${attempt.attemptId}'s sessionId does not match the current DeliberationState binding`);
  }
  if (attempt.artifactHash !== deliberationState.artifactHash) {
    throw new Error(`${label}: attempt ${attempt.attemptId}'s artifactHash does not match the current DeliberationState binding`);
  }
  if (attempt.authorContextHash !== deliberationState.authorContextHash) {
    throw new Error(`${label}: attempt ${attempt.attemptId}'s authorContextHash does not match the current DeliberationState binding`);
  }
  if (attempt.route !== 'ADD_CONTEXT') {
    throw new Error(`${label}: attempt ${attempt.attemptId} has route ${attempt.route}, not ADD_CONTEXT`);
  }
  assertFiniteNonNegative(attempt.logicalCost, `${label}: attempt.logicalCost`);
  if (attempt.logicalCost !== logicalAttemptCostForRoute(attempt.route)) {
    throw new Error(`${label}: attempt.logicalCost does not match the expected logical cost for its route`);
  }
  if (Number.isNaN(Date.parse(attempt.startedAt))) {
    throw new Error(`${label}: attempt.startedAt is not a valid parseable timestamp`);
  }
  if (outcome.logicalCost !== attempt.logicalCost) {
    throw new Error(`${label}: outcome.logicalCost does not match the resolved attempt's logicalCost`);
  }

  const decision = resolveUniqueRouteDecisionById(deliberationState, attempt.decisionId, label);
  if (decision.route !== 'ADD_CONTEXT') {
    throw new Error(`${label}: recorded decision for attempt ${attempt.attemptId} has route ${decision.route}, not ADD_CONTEXT`);
  }
  if (attempt.questionId !== decision.questionId) {
    throw new Error(`${label}: attempt.questionId does not match the resolved decision.questionId`);
  }
  if (outcome.decisionId !== decision.id || outcome.originatingQuestionId !== decision.questionId) {
    throw new Error(`${label}: outcome's decisionId/originatingQuestionId does not match the resolved decision`);
  }
  if (outcome.sessionId !== attempt.sessionId || outcome.artifactHash !== attempt.artifactHash || outcome.authorContextHash !== attempt.authorContextHash) {
    throw new Error(`${label}: outcome's session/hash binding does not match the resolved attempt`);
  }

  const matchingQuestions = deliberationState.unresolvedQuestions.filter((q) => q.id === attempt.questionId);
  if (matchingQuestions.length !== 1) {
    throw new Error(`${label}: attempt.questionId ${attempt.questionId} does not resolve to exactly one registered UnresolvedQuestion`);
  }
  const question = matchingQuestions[0];
  if (outcome.originatingQuestionId !== question.id) {
    throw new Error(`${label}: outcome.originatingQuestionId does not match the resolved question`);
  }
  if (decision.reason.rootCause !== question.rootCause) {
    throw new Error(`${label}: recorded decision rootCause does not match the registered question rootCause`);
  }
  if (decision.reason.materialityReason !== question.materialityReason) {
    throw new Error(`${label}: recorded decision materialityReason does not match the registered question materialityReason`);
  }
  if (!refsExactlyMatch(decision.inputRefs, question.inputRefs)) {
    throw new Error(`${label}: recorded decision inputRefs do not exactly match the registered question inputRefs (order-sensitive)`);
  }
  if (routeForRootCause(question.rootCause) !== decision.route) {
    throw new Error(`${label}: registered question rootCause does not map to the recorded decision route`);
  }

  // Mandatory: the COMPLETE ContextRequest ledger must be sound before a
  // single selected request from it is ever trusted (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md
  // §13.A, decision N step 8 -- the third boundary this exact gate is now
  // required at, after Slice 2D-C1/2D-C2).
  assertContextRequestLedgerIntegrity(deliberationState);
  const matchingRequests = effectiveContextRequests(deliberationState).filter((r) => r.id === outcome.contextRequestId);
  if (matchingRequests.length !== 1) {
    throw new Error(`${label}: contextRequestId ${outcome.contextRequestId} does not resolve to exactly one ContextRequest`);
  }
  const contextRequest = matchingRequests[0];
  if (contextRequest.originatingAttemptId !== attempt.attemptId) {
    throw new Error(`${label}: contextRequest.originatingAttemptId does not match the resolved attempt`);
  }
  if (
    contextRequest.originatingQuestionId !== attempt.questionId ||
    contextRequest.originatingSessionId !== attempt.sessionId ||
    contextRequest.artifactHash !== attempt.artifactHash ||
    contextRequest.authorContextHash !== attempt.authorContextHash
  ) {
    throw new Error(`${label}: contextRequest binding does not match the resolved attempt`);
  }

  return { outcome, attempt, decision, question, contextRequest };
}

/**
 * Validates the COMPLETE `sessionVersionLineages[]` ledger, never only the
 * one entry a caller happens to be creating
 * (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §13.A, decision P, as
 * corrected by the Slice 2D-C3-0 amendment: parent-side only -- it never
 * claims to validate Session B's actual contents, which are not stored in
 * `DeliberationState`; see `assertSessionVersionLineageChildIntegrity`
 * below for that dimension). For every lineage entry: `lineageId`
 * non-empty/globally unique; `parentSessionId` non-empty and matches this
 * state's own `sessionId`; `childSessionId` non-empty, never equal to
 * `parentSessionId`, unique across this ledger; both parent hashes match
 * this state's own hashes; `suppliedOutcomeAttemptId` non-empty, unique
 * across this ledger, and independently re-validated as a defensible
 * `ADD_CONTEXT` `SUPPLIED` authorization via
 * `revalidateSuppliedOutcomeProvenance` (never trusting the write-time gate
 * alone for state that may predate it); `originatingQuestionId`/
 * `contextRequestId` match that resolved chain exactly; a matching
 * `CROSS_SESSION` `QuestionDisposition` exists for the same
 * `attemptId`/`questionId` (only `createCrossSessionTransition` can ever
 * have produced one, §9). Pure, non-cached, non-memoized. Any violation
 * fails closed; none is ever automatically reconciled.
 */
function assertSessionVersionLineageLedgerIntegrity(deliberationState: DeliberationState): void {
  const seenLineageIds = new Set<string>();
  const seenChildSessionIds = new Set<string>();
  const seenSuppliedOutcomeAttemptIds = new Set<string>();

  for (const lineage of effectiveSessionVersionLineages(deliberationState)) {
    assertNonEmptyString(lineage.lineageId, 'SessionVersionLineage ledger entry: lineageId');
    if (seenLineageIds.has(lineage.lineageId)) {
      throw new Error(`SessionVersionLineage ledger entry: duplicate lineageId ${lineage.lineageId} -- identity-ambiguous legacy/inconsistent state`);
    }
    seenLineageIds.add(lineage.lineageId);

    assertNonEmptyString(lineage.parentSessionId, 'SessionVersionLineage ledger entry: parentSessionId');
    if (lineage.parentSessionId !== deliberationState.sessionId) {
      throw new Error('SessionVersionLineage ledger entry: parentSessionId does not match the current DeliberationState binding');
    }
    assertNonEmptyString(lineage.childSessionId, 'SessionVersionLineage ledger entry: childSessionId');
    if (lineage.childSessionId === lineage.parentSessionId) {
      throw new Error('SessionVersionLineage ledger entry: childSessionId must not equal parentSessionId');
    }
    if (seenChildSessionIds.has(lineage.childSessionId)) {
      throw new Error(`SessionVersionLineage ledger entry: duplicate childSessionId ${lineage.childSessionId} -- inconsistent state`);
    }
    seenChildSessionIds.add(lineage.childSessionId);

    if (lineage.parentArtifactHash !== deliberationState.artifactHash) {
      throw new Error('SessionVersionLineage ledger entry: parentArtifactHash does not match the current DeliberationState binding');
    }
    if (lineage.parentAuthorContextHash !== deliberationState.authorContextHash) {
      throw new Error('SessionVersionLineage ledger entry: parentAuthorContextHash does not match the current DeliberationState binding');
    }

    assertNonEmptyString(lineage.suppliedOutcomeAttemptId, 'SessionVersionLineage ledger entry: suppliedOutcomeAttemptId');
    if (seenSuppliedOutcomeAttemptIds.has(lineage.suppliedOutcomeAttemptId)) {
      throw new Error(
        `SessionVersionLineage ledger entry: duplicate suppliedOutcomeAttemptId ${lineage.suppliedOutcomeAttemptId} -- inconsistent state`
      );
    }
    seenSuppliedOutcomeAttemptIds.add(lineage.suppliedOutcomeAttemptId);

    const { question, contextRequest } = revalidateSuppliedOutcomeProvenance(
      deliberationState,
      lineage.suppliedOutcomeAttemptId,
      'SessionVersionLineage ledger entry'
    );
    if (lineage.originatingQuestionId !== question.id) {
      throw new Error('SessionVersionLineage ledger entry: originatingQuestionId does not match the resolved provenance chain');
    }
    if (lineage.contextRequestId !== contextRequest.id) {
      throw new Error('SessionVersionLineage ledger entry: contextRequestId does not match the resolved provenance chain');
    }
    assertNonEmptyString(lineage.addedAuthorContextItemId, 'SessionVersionLineage ledger entry: addedAuthorContextItemId');
    if (lineage.childArtifactHash !== lineage.parentArtifactHash) {
      throw new Error('SessionVersionLineage ledger entry: childArtifactHash does not equal parentArtifactHash');
    }
    assertNonEmptyString(lineage.childAuthorContextHash, 'SessionVersionLineage ledger entry: childAuthorContextHash');
    if (Number.isNaN(Date.parse(lineage.createdAt))) {
      throw new Error('SessionVersionLineage ledger entry: createdAt is not a valid parseable timestamp');
    }

    const matchingDispositions = deliberationState.questionDispositions.filter(
      (d) => d.attemptId === lineage.suppliedOutcomeAttemptId && d.questionId === lineage.originatingQuestionId
    );
    if (matchingDispositions.length !== 1 || matchingDispositions[0].disposition !== 'CROSS_SESSION') {
      throw new Error(
        `SessionVersionLineage ledger entry: no matching CROSS_SESSION QuestionDisposition exists for attemptId ${lineage.suppliedOutcomeAttemptId}`
      );
    }
  }
}

/**
 * Combined global cross-session integrity (Slice 2D-C3-0 amendment §9-11):
 * (1) ordinary `QuestionDisposition` ledger integrity; (2) the complete
 * `SessionVersionLineage` ledger, which already independently enforces the
 * forward direction -- every lineage has exactly one matching `CROSS_SESSION`
 * disposition (`assertSessionVersionLineageLedgerIntegrity`, above); (3) the
 * reverse direction this amendment adds -- every `CROSS_SESSION` disposition
 * has exactly one matching lineage, never zero (an orphan terminal fact with
 * no session ever actually produced) or more than one (ambiguous history).
 * Together the two directions form a bijection, scoped to one parent
 * `DeliberationState`, between `CROSS_SESSION` dispositions and
 * `SessionVersionLineage` entries. Pure, non-cached, non-memoized; every
 * violation fails closed (throws), never silently interpreted as "not
 * terminal" by a caller such as `isQuestionCurrent`.
 */
function assertCrossSessionLineageIntegrity(deliberationState: DeliberationState): void {
  assertQuestionDispositionLedgerIntegrity(deliberationState);
  assertSessionVersionLineageLedgerIntegrity(deliberationState);

  const lineages = effectiveSessionVersionLineages(deliberationState);
  for (const disposition of deliberationState.questionDispositions) {
    if (disposition.disposition !== 'CROSS_SESSION') continue;
    const matchingLineages = lineages.filter(
      (l) => l.suppliedOutcomeAttemptId === disposition.attemptId && l.originatingQuestionId === disposition.questionId
    );
    if (matchingLineages.length !== 1) {
      throw new Error(
        `assertCrossSessionLineageIntegrity: CROSS_SESSION disposition for attemptId ${disposition.attemptId} does not have exactly one matching SessionVersionLineage -- orphan or ambiguous cross-session history`
      );
    }
  }
}

/**
 * Validates the actual child `StressTestSession` against its
 * `SessionVersionLineage` record -- the dimension the parent-side helper
 * above cannot reach, because Session B is never stored inside
 * `DeliberationState A` (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md
 * §13.A, "Child-side lineage validation boundary," Slice 2D-C3-0
 * amendment). Only meaningful when the caller actually holds the child
 * session object -- exported so it can be invoked wherever that is true,
 * not only inside `createCrossSessionTransition` itself.
 *
 * **Slice 2D-C3-0 amendment §15-16.** `parentSession`'s own identity is now
 * independently bound to `lineage` (never silently ignored merely because
 * it is accepted as a parameter), and the passed `suppliedOutcome`/
 * `contextRequest` snapshots are cross-checked against `lineage`'s own
 * copied identity fields. This does **not** prove those snapshots came from
 * an authoritative `DeliberationState` ledger -- this function receives no
 * `DeliberationState` and cannot re-derive that; that membership proof
 * remains exclusively parent-side (`assertSessionVersionLineageLedgerIntegrity`/
 * `assertCrossSessionLineageIntegrity`, above). A caller invoking this
 * helper with a self-consistent but entirely fabricated `lineage`/
 * `suppliedOutcome`/`contextRequest` triple -- none of them ever actually
 * recorded anywhere -- is a case only the parent-side ledger helpers can
 * catch.
 */
export function assertSessionVersionLineageChildIntegrity(
  parentSession: StressTestSession,
  lineage: SessionVersionLineage,
  childSession: StressTestSession,
  suppliedOutcome: AddContextSuppliedRouteOutcome,
  contextRequest: ContextRequest
): void {
  verifyFrozenInputIntegrity(parentSession);
  if (lineage.parentSessionId !== parentSession.id) {
    throw new Error('assertSessionVersionLineageChildIntegrity: lineage.parentSessionId does not match parentSession.id');
  }
  if (lineage.parentArtifactHash !== parentSession.artifactHash) {
    throw new Error('assertSessionVersionLineageChildIntegrity: lineage.parentArtifactHash does not match parentSession.artifactHash');
  }
  if (lineage.parentAuthorContextHash !== parentSession.authorContextHash) {
    throw new Error('assertSessionVersionLineageChildIntegrity: lineage.parentAuthorContextHash does not match parentSession.authorContextHash');
  }

  if (
    suppliedOutcome.attemptId !== lineage.suppliedOutcomeAttemptId ||
    suppliedOutcome.originatingQuestionId !== lineage.originatingQuestionId ||
    suppliedOutcome.contextRequestId !== lineage.contextRequestId
  ) {
    throw new Error('assertSessionVersionLineageChildIntegrity: suppliedOutcome does not match lineage\'s own identity fields');
  }
  if (suppliedOutcome.route !== 'ADD_CONTEXT' || suppliedOutcome.status !== 'SUCCEEDED' || suppliedOutcome.result !== 'SUPPLIED') {
    throw new Error('assertSessionVersionLineageChildIntegrity: suppliedOutcome is not a SUCCEEDED ADD_CONTEXT SUPPLIED outcome');
  }
  if (
    contextRequest.id !== lineage.contextRequestId ||
    contextRequest.originatingAttemptId !== lineage.suppliedOutcomeAttemptId ||
    contextRequest.originatingQuestionId !== lineage.originatingQuestionId ||
    contextRequest.originatingSessionId !== lineage.parentSessionId ||
    contextRequest.artifactHash !== lineage.parentArtifactHash ||
    contextRequest.authorContextHash !== lineage.parentAuthorContextHash
  ) {
    throw new Error('assertSessionVersionLineageChildIntegrity: contextRequest does not match lineage\'s own identity fields');
  }

  if (childSession.id !== lineage.childSessionId) {
    throw new Error('assertSessionVersionLineageChildIntegrity: childSession.id does not match lineage.childSessionId');
  }
  if (childSession.id === lineage.parentSessionId) {
    throw new Error('assertSessionVersionLineageChildIntegrity: childSession.id must not equal lineage.parentSessionId');
  }
  if (childSession.state !== 'INPUT_FROZEN') {
    throw new Error(`assertSessionVersionLineageChildIntegrity: childSession.state must be INPUT_FROZEN (got ${childSession.state})`);
  }
  verifyFrozenInputIntegrity(childSession);
  if (childSession.artifactText !== parentSession.artifactText) {
    throw new Error('assertSessionVersionLineageChildIntegrity: childSession.artifactText does not equal parentSession.artifactText');
  }
  if (childSession.artifactHash !== lineage.childArtifactHash) {
    throw new Error('assertSessionVersionLineageChildIntegrity: childSession.artifactHash does not match lineage.childArtifactHash');
  }
  if (childSession.authorContextHash !== lineage.childAuthorContextHash) {
    throw new Error('assertSessionVersionLineageChildIntegrity: childSession.authorContextHash does not match lineage.childAuthorContextHash');
  }
  if (childSession.artifactHash !== lineage.parentArtifactHash) {
    throw new Error('assertSessionVersionLineageChildIntegrity: childSession.artifactHash does not equal lineage.parentArtifactHash');
  }

  let addedItem: AuthorContextItem | null = null;
  let addedCategory: AuthorContextCategoryName | null = null;
  for (const category of AUTHOR_CONTEXT_CATEGORIES) {
    const matches = childSession.authorContext[category].filter((item) => item.id === lineage.addedAuthorContextItemId);
    if (matches.length > 1) {
      throw new Error(`assertSessionVersionLineageChildIntegrity: addedAuthorContextItemId appears more than once in category ${category}`);
    }
    if (matches.length === 1) {
      if (addedItem !== null) {
        throw new Error('assertSessionVersionLineageChildIntegrity: addedAuthorContextItemId appears in more than one category');
      }
      addedItem = matches[0];
      addedCategory = category;
    }
  }
  if (addedItem === null || addedCategory === null) {
    throw new Error('assertSessionVersionLineageChildIntegrity: addedAuthorContextItemId does not resolve to any child AuthorContextItem');
  }
  if (addedCategory !== contextRequest.category) {
    throw new Error("assertSessionVersionLineageChildIntegrity: added item's category does not match the resolved ContextRequest.category");
  }
  if (addedItem.text !== suppliedOutcome.responseText) {
    throw new Error("assertSessionVersionLineageChildIntegrity: added item's text does not match the resolved SUPPLIED outcome.responseText");
  }
  if (addedItem.sourceType !== 'AUTHOR') {
    throw new Error("assertSessionVersionLineageChildIntegrity: added item's sourceType must be AUTHOR");
  }
  if (addedItem.status !== 'CURRENT') {
    throw new Error("assertSessionVersionLineageChildIntegrity: added item's status must be CURRENT");
  }

  // Child AuthorContext must equal Session A's semantic snapshot (text/sourceType/status,
  // order-preserving; id/createdAt are never compared -- copied items are always
  // freshly minted by addAuthorContextItem) plus exactly the one item checked above.
  for (const category of AUTHOR_CONTEXT_CATEGORIES) {
    const expected = parentSession.authorContext[category].map((item) => `${item.text} ${item.sourceType} ${item.status}`);
    const actual = childSession.authorContext[category]
      .filter((item) => item.id !== lineage.addedAuthorContextItemId)
      .map((item) => `${item.text} ${item.sourceType} ${item.status}`);
    if (expected.length !== actual.length || expected.some((value, i) => value !== actual[i])) {
      throw new Error(
        `assertSessionVersionLineageChildIntegrity: child AuthorContext category ${category} does not exactly match Session A's copied snapshot`
      );
    }
  }
}

/**
 * The single atomic `CROSS_SESSION` transition
 * (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §13.A, decisions K/L, as
 * corrected by the Slice 2D-C3-0 amendment §14): given exactly one already-
 * resolved `ADD_CONTEXT` `SUPPLIED` `RouteOutcome`, produces Q1's
 * `CROSS_SESSION` `QuestionDisposition`, one `SessionVersionLineage`, and a
 * new Session B (already `INPUT_FROZEN`) together, in one returned bundle --
 * or throws and persists/returns none of them. No sub-operation of this
 * function is separately callable; there is no path through this module
 * that can append to `sessionVersionLineages[]` or hand back a completed
 * child session without also recording the matching disposition in the
 * same call.
 */
export function createCrossSessionTransition(
  parentSession: StressTestSession,
  parentDeliberationState: DeliberationState,
  input: { suppliedOutcomeAttemptId: string }
): {
  session: StressTestSession;
  deliberationState: DeliberationState;
  childSession: StressTestSession;
  lineage: SessionVersionLineage;
} {
  verifyDeliberationBinding(parentSession, parentDeliberationState);
  if (parentDeliberationState.stopReason !== null) {
    throw new Error('createCrossSessionTransition: deliberation has already stopped; no further CROSS_SESSION transition may be created');
  }
  if (input === null || typeof input !== 'object') {
    throw new Error('createCrossSessionTransition: input must be an object');
  }
  assertExactKeys(input, ['suppliedOutcomeAttemptId'], 'createCrossSessionTransition');
  assertNonEmptyString(input.suppliedOutcomeAttemptId, 'createCrossSessionTransition: suppliedOutcomeAttemptId');

  const { outcome, attempt, decision, question, contextRequest } = revalidateSuppliedOutcomeProvenance(
    parentDeliberationState,
    input.suppliedOutcomeAttemptId,
    'createCrossSessionTransition'
  );

  if (parentDeliberationState.questionDispositions.some((d) => d.attemptId === outcome.attemptId)) {
    throw new Error(`createCrossSessionTransition: the RouteOutcome for attemptId ${outcome.attemptId} already has a QuestionDisposition`);
  }
  if (!isQuestionCurrent(parentDeliberationState, question.id)) {
    throw new Error(`createCrossSessionTransition: question ${question.id} is not current`);
  }
  const activeForTransition = getActiveRouteDecisionsForQuestion(parentDeliberationState, question.id);
  if (activeForTransition.length === 0) {
    throw new Error(`createCrossSessionTransition: question ${question.id} has no active deliberation cycle`);
  }
  if (activeForTransition.length > 1) {
    throw new Error(
      `createCrossSessionTransition: question ${question.id} has more than one active deliberation cycle -- inconsistent legacy state`
    );
  }
  if (activeForTransition[0].id !== decision.id) {
    throw new Error(
      `createCrossSessionTransition: question ${question.id}'s active deliberation cycle is a different RouteDecision than the one this outcome terminates`
    );
  }

  // Mandatory: the COMPLETE cross-session history (disposition ledger +
  // lineage ledger + their bijection) must be sound, and this exact SUPPLIED
  // outcome must not already have produced a lineage, before any child
  // session is constructed (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md
  // §13.A, decision O; Slice 2D-C3-0 amendment §9-11/§14).
  assertCrossSessionLineageIntegrity(parentDeliberationState);
  if (effectiveSessionVersionLineages(parentDeliberationState).some((l) => l.suppliedOutcomeAttemptId === outcome.attemptId)) {
    throw new Error(
      `createCrossSessionTransition: attemptId ${outcome.attemptId} already produced a SessionVersionLineage -- one SUPPLIED outcome may create at most one child session`
    );
  }

  if (!parentSession.artifactHash || !parentSession.authorContextHash) {
    throw new Error('createCrossSessionTransition: parentSession is missing its frozen artifactHash/authorContextHash');
  }
  const parentArtifactHash = parentSession.artifactHash;
  const parentAuthorContextHash = parentSession.authorContextHash;

  // Session B: a wholly new StressTestSession, never a copy-then-mutate of
  // Session A (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §13.A, decision
  // F). Internal construction passes through DRAFT; only the final,
  // INPUT_FROZEN session is ever returned (decision I).
  let childSession = createSession(parentSession.artifactText);
  for (const category of AUTHOR_CONTEXT_CATEGORIES) {
    for (const item of parentSession.authorContext[category]) {
      childSession = addAuthorContextItem(childSession, category, {
        text: item.text,
        sourceType: item.sourceType,
        status: item.status,
      });
    }
  }
  const beforeAddedIds = new Set(childSession.authorContext[contextRequest.category].map((item) => item.id));
  childSession = addAuthorContextItem(childSession, contextRequest.category, {
    text: outcome.responseText,
    sourceType: 'AUTHOR',
    status: 'CURRENT',
  });
  const addedItem = childSession.authorContext[contextRequest.category].find((item) => !beforeAddedIds.has(item.id));
  if (!addedItem) {
    throw new Error('createCrossSessionTransition: internal invariant violated -- newly added AuthorContextItem was not found');
  }
  const addedAuthorContextItemId = addedItem.id;

  childSession = freezeInput(childSession);
  verifyFrozenInputIntegrity(childSession);
  if (!childSession.artifactHash || !childSession.authorContextHash) {
    throw new Error('createCrossSessionTransition: internal invariant violated -- childSession is missing frozen hashes');
  }
  const childArtifactHash = childSession.artifactHash;
  const childAuthorContextHash = childSession.authorContextHash;
  if (childArtifactHash !== parentArtifactHash) {
    throw new Error(
      'createCrossSessionTransition: internal invariant violated -- childSession.artifactHash does not equal parentSession.artifactHash'
    );
  }

  const lineageId = randomUUID();
  const createdAt = nowIso();
  const childSessionId = childSession.id;
  const buildLineageSnapshot = (): SessionVersionLineage => ({
    lineageId,
    parentSessionId: parentSession.id,
    childSessionId,
    parentArtifactHash,
    parentAuthorContextHash,
    childArtifactHash,
    childAuthorContextHash,
    originatingQuestionId: question.id,
    suppliedOutcomeAttemptId: outcome.attemptId,
    contextRequestId: contextRequest.id,
    addedAuthorContextItemId,
    createdAt,
  });

  // CROSS_SESSION's stored envelope is unchanged (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md
  // §13.A, decision M) -- no childSessionId/lineageId field. `reason` is a
  // deterministic, purely structural fact never derived from responseText's
  // content (decision M; this module never classifies what a human said).
  const disposition: QuestionDisposition = {
    attemptId: outcome.attemptId,
    questionId: question.id,
    sessionId: attempt.sessionId,
    artifactHash: attempt.artifactHash,
    authorContextHash: attempt.authorContextHash,
    disposition: 'CROSS_SESSION',
    reason: `CROSS_SESSION: ADD_CONTEXT SUPPLIED RouteOutcome ${outcome.attemptId} authorized session version transition ${parentSession.id} -> ${childSessionId} (lineage ${lineageId})`,
    createdAt,
  };

  const provisionalDeliberationState: DeliberationState = {
    ...parentDeliberationState,
    questionDispositions: [...parentDeliberationState.questionDispositions, disposition],
    sessionVersionLineages: [...effectiveSessionVersionLineages(parentDeliberationState), buildLineageSnapshot()],
  };

  // Prove the newly-created pair satisfies the exact same global read rules
  // any later, independent read of this state will apply -- not merely that
  // it looked correct while being assembled here (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md
  // §13.A; Slice 2D-C3-0 amendment §14).
  assertCrossSessionLineageIntegrity(provisionalDeliberationState);

  // Child-side validation runs on the actual constructed child before any
  // success return -- the parent-side ledger helpers above cannot reach this
  // dimension (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §13.A, "Child-side
  // lineage validation boundary," Slice 2D-C3-0 amendment).
  assertSessionVersionLineageChildIntegrity(parentSession, buildLineageSnapshot(), childSession, outcome, contextRequest);

  return {
    session: parentSession,
    deliberationState: provisionalDeliberationState,
    childSession,
    lineage: buildLineageSnapshot(),
  };
}

/**
 * The immutable claim-identity audit fact answering "which exact factual
 * proposition does a SEEK_EVIDENCE attempt evaluate?"
 * (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §13.D, Slice 2D-C5-0
 * freeze). `id` is its own fresh identity -- never `originatingQuestionId`
 * reused, never a copied/derived value from `ReviewFinding`/`SemanticIssue`,
 * never `paragraphId`/`chunkId`/`claimIndex`/array position/text offset
 * (decision B). No `artifactLocation` -- always derived by walking
 * `originatingFindingId -> ReviewFinding.artifactLocation`, never duplicated
 * (decision G). No `attemptId` -- `EvidenceSubject` is question-scoped and
 * exists *before* route planning, reused unchanged across every re-attempt
 * cycle for the same question (decisions K, N). `sessionId`/`artifactHash`/
 * `authorContextHash` are derived-and-copied convenience fields,
 * independently re-verified against the authoritative session at every read
 * boundary, never independently caller-authoritative (decision C).
 */
export interface EvidenceSubject {
  id: string;
  originatingQuestionId: string;
  sourceRef: RouteInputRef;
  originatingFindingId: string;
  claimText: string;
  sessionId: string;
  artifactHash: string;
  authorContextHash: string;
  createdAt: string;
}

const EVIDENCE_SUBJECT_STORED_KEYS = [
  'id',
  'originatingQuestionId',
  'sourceRef',
  'originatingFindingId',
  'claimText',
  'sessionId',
  'artifactHash',
  'authorContextHash',
  'createdAt',
] as const;

/**
 * Reads `DeliberationState.evidenceSubjects` tolerating legacy state that
 * predates the field (missing/`undefined` -- read-time compatibility only,
 * never a mutation of the stored record, the same posture already used for
 * `effectiveContextRequests`/`effectiveSessionVersionLineages`). Unlike
 * those two, an explicit non-array value (not merely missing) fails closed
 * rather than being silently treated as empty -- ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md
 * §13.D decision J, Slice 2D-C5-A's own hardening of the legacy-compat
 * posture.
 */
function effectiveEvidenceSubjects(deliberationState: DeliberationState): EvidenceSubject[] {
  const raw = (deliberationState as { evidenceSubjects?: unknown }).evidenceSubjects;
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error('effectiveEvidenceSubjects: evidenceSubjects is present but not an array -- malformed state');
  }
  return raw as EvidenceSubject[];
}

/**
 * Shared leaf-provenance rule for a SEMANTIC_ISSUE-sourced EvidenceSubject,
 * enforced identically at write (`registerEvidenceSubject`) and read
 * (`assertEvidenceSubjectLedgerIntegrity`) time so the two boundaries can
 * never drift into two subtly different interpretations (Slice 2D-C5-A
 * amendment). The selected `originatingFindingId` must occur EXACTLY ONCE in
 * the resolved SemanticIssue's own `findingIds` -- `SemanticIssue.findingIds`
 * is an audit/provenance collection, not a set; a repeated occurrence means
 * the authoritative upstream provenance structure is itself malformed. It is
 * never silently deduplicated, first-matched, or treated as harmless merely
 * because every occurrence resolves to the same `ReviewFinding` identity --
 * corrected here from the original `.includes()`-only membership check,
 * which could not distinguish "member once" from "member more than once."
 */
function assertSemanticIssueEvidenceLeaf(
  session: StressTestSession,
  semanticIssueId: string,
  originatingFindingId: string,
  label: string
): void {
  const issue = session.semanticIssues[semanticIssueId];
  if (!issue) {
    throw new Error(`${label}: unknown SEMANTIC_ISSUE id ${semanticIssueId}`);
  }
  if (!Array.isArray(issue.findingIds)) {
    throw new Error(`${label}: SemanticIssue ${issue.id}'s findingIds is not an array -- malformed state`);
  }
  const occurrences = issue.findingIds.filter((id) => id === originatingFindingId).length;
  if (occurrences === 0) {
    throw new Error(`${label}: originatingFindingId ${originatingFindingId} is not a member of SemanticIssue ${issue.id}'s findingIds`);
  }
  if (occurrences > 1) {
    throw new Error(
      `${label}: originatingFindingId ${originatingFindingId} occurs ${occurrences} times in SemanticIssue ${issue.id}'s findingIds -- malformed, provenance-ambiguous membership`
    );
  }
}

/**
 * Validates the COMPLETE `evidenceSubjects[]` ledger, never only the one
 * subject a caller happens to be creating or resolving -- the same "global
 * before local" posture required at every other ledger boundary since the
 * Slice 2D-B2-0 amendment. Session-aware
 * (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §13.D decision U, corrected
 * by the Slice 2D-C5-0 amendment): `ReviewFinding`/`SemanticIssue` leaf
 * provenance is `StressTestSession` domain truth this helper cannot resolve
 * from `DeliberationState` alone, so `session` is a required, load-bearing
 * parameter, not optional context. `verifyDeliberationBinding` at entry
 * already proves `deliberationState.sessionId`/`artifactHash`/
 * `authorContextHash` equal `session.id`/`artifactHash`/`authorContextHash`
 * -- so every subsequent check of a stored subject's own `sessionId`/
 * `artifactHash`/`authorContextHash` against the `DeliberationState`'s own
 * binding is transitively a three-way match against the authoritative
 * session too, never state-internal agreement alone.
 *
 * Storage cardinality only: at most one `EvidenceSubject` per
 * `originatingQuestionId` (decision M) -- zero is a legitimate,
 * not-yet-registered state, never treated as corruption. The separate,
 * stricter route-readiness cardinality (exactly one, before SEEK_EVIDENCE
 * routing) is independently owned by `assertSeekEvidenceSubjectReady` and
 * the three gates it backs (decision O), not by this helper.
 */
function assertEvidenceSubjectLedgerIntegrity(session: StressTestSession, deliberationState: DeliberationState): void {
  verifyDeliberationBinding(session, deliberationState);

  const seenIds = new Set<string>();
  const countByQuestionId = new Map<string, number>();

  for (const subject of effectiveEvidenceSubjects(deliberationState)) {
    assertExactKeys(subject, EVIDENCE_SUBJECT_STORED_KEYS, 'EvidenceSubject ledger entry');

    assertNonEmptyString(subject.id, 'EvidenceSubject ledger entry: id');
    if (seenIds.has(subject.id)) {
      throw new Error(
        `EvidenceSubject ledger entry: duplicate EvidenceSubject.id ${subject.id} -- identity-ambiguous legacy/inconsistent state`
      );
    }
    seenIds.add(subject.id);

    assertNonEmptyString(subject.originatingQuestionId, 'EvidenceSubject ledger entry: originatingQuestionId');
    const matchingQuestions = deliberationState.unresolvedQuestions.filter((q) => q.id === subject.originatingQuestionId);
    if (matchingQuestions.length !== 1) {
      throw new Error(
        `EvidenceSubject ledger entry: originatingQuestionId ${subject.originatingQuestionId} does not resolve to exactly one registered UnresolvedQuestion`
      );
    }
    const question = matchingQuestions[0];
    if (question.rootCause !== 'EVIDENCE_GAP') {
      throw new Error(
        `EvidenceSubject ledger entry: question ${question.id} has rootCause ${question.rootCause}, not EVIDENCE_GAP`
      );
    }

    // Storage cardinality (decision M): zero-or-one per question. Zero for
    // some other EVIDENCE_GAP question in the same state is never checked
    // here -- only "does *this* subject's question already have another
    // subject" is a violation.
    const count = (countByQuestionId.get(subject.originatingQuestionId) ?? 0) + 1;
    countByQuestionId.set(subject.originatingQuestionId, count);
    if (count > 1) {
      throw new Error(
        `EvidenceSubject ledger entry: question ${subject.originatingQuestionId} has more than one EvidenceSubject -- inconsistent state`
      );
    }

    if (subject.sourceRef === null || typeof subject.sourceRef !== 'object') {
      throw new Error('EvidenceSubject ledger entry: sourceRef must be an object');
    }
    assertExactKeys(subject.sourceRef, ['kind', 'id'], 'EvidenceSubject ledger entry: sourceRef');
    if (subject.sourceRef.kind !== 'FINDING' && subject.sourceRef.kind !== 'SEMANTIC_ISSUE') {
      throw new Error(
        `EvidenceSubject ledger entry: sourceRef.kind must be FINDING or SEMANTIC_ISSUE (got ${JSON.stringify(
          (subject.sourceRef as { kind: unknown }).kind
        )}) -- AUTHOR_CONTEXT_ITEM has no backing ReviewFinding to resolve to`
      );
    }
    assertNonEmptyString(subject.sourceRef.id, 'EvidenceSubject ledger entry: sourceRef.id');
    validateRouteInputRef(session, subject.sourceRef);

    const matchesQuestionRef = question.inputRefs.some(
      (ref) => ref.kind === subject.sourceRef.kind && ref.id === subject.sourceRef.id
    );
    if (!matchesQuestionRef) {
      throw new Error(
        `EvidenceSubject ledger entry: sourceRef does not exactly match any of question ${question.id}'s own inputRefs`
      );
    }

    assertNonEmptyString(subject.originatingFindingId, 'EvidenceSubject ledger entry: originatingFindingId');
    if (subject.sourceRef.kind === 'FINDING') {
      if (subject.originatingFindingId !== subject.sourceRef.id) {
        throw new Error(
          'EvidenceSubject ledger entry: originatingFindingId must equal sourceRef.id when sourceRef.kind is FINDING'
        );
      }
    } else {
      // sourceRef.kind === 'SEMANTIC_ISSUE'.
      assertSemanticIssueEvidenceLeaf(session, subject.sourceRef.id, subject.originatingFindingId, 'EvidenceSubject ledger entry');
    }
    const resolvedFinding = session.findings[subject.originatingFindingId];
    if (!resolvedFinding) {
      throw new Error(
        `EvidenceSubject ledger entry: originatingFindingId ${subject.originatingFindingId} does not resolve to a ReviewFinding in the current session`
      );
    }
    if (resolvedFinding.id !== subject.originatingFindingId) {
      throw new Error(
        `EvidenceSubject ledger entry: resolved ReviewFinding's own id does not agree with originatingFindingId ${subject.originatingFindingId} -- map-key/stored-id mismatch`
      );
    }

    assertNonEmptyString(subject.claimText, 'EvidenceSubject ledger entry: claimText');
    if (Number.isNaN(Date.parse(subject.createdAt))) {
      throw new Error('EvidenceSubject ledger entry: createdAt is not a valid parseable timestamp');
    }

    if (subject.sessionId !== deliberationState.sessionId) {
      throw new Error('EvidenceSubject ledger entry: sessionId does not match the current DeliberationState/session binding');
    }
    if (subject.artifactHash !== deliberationState.artifactHash) {
      throw new Error('EvidenceSubject ledger entry: artifactHash does not match the current DeliberationState/session binding');
    }
    if (subject.authorContextHash !== deliberationState.authorContextHash) {
      throw new Error(
        'EvidenceSubject ledger entry: authorContextHash does not match the current DeliberationState/session binding'
      );
    }
  }
}

/**
 * Shared route-readiness rule (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md
 * §13.D decision O): before a SEEK_EVIDENCE route may be planned, recorded,
 * or attempted for an EVIDENCE_GAP question, exactly one valid
 * EvidenceSubject must already be registered for it. One shared
 * implementation, called independently at all three gates below, so the
 * rule is never duplicated three subtly different ways. Global ledger
 * integrity is re-validated on every call, never skipped in favor of a
 * local-only lookup (global-before-local).
 */
function assertSeekEvidenceSubjectReady(
  session: StressTestSession,
  deliberationState: DeliberationState,
  questionId: string
): void {
  assertEvidenceSubjectLedgerIntegrity(session, deliberationState);

  const question = deliberationState.unresolvedQuestions.find((q) => q.id === questionId);
  if (!question) {
    throw new Error(`assertSeekEvidenceSubjectReady: questionId ${questionId} is not a currently registered unresolved question`);
  }
  if (question.rootCause !== 'EVIDENCE_GAP') {
    throw new Error(`assertSeekEvidenceSubjectReady: question ${questionId} has rootCause ${question.rootCause}, not EVIDENCE_GAP`);
  }

  const matching = effectiveEvidenceSubjects(deliberationState).filter((s) => s.originatingQuestionId === questionId);
  if (matching.length === 0) {
    throw new Error(
      `assertSeekEvidenceSubjectReady: question ${questionId} has no registered EvidenceSubject -- SEEK_EVIDENCE may not be planned, recorded, or attempted until registerEvidenceSubject is called for it`
    );
  }
  if (matching.length > 1) {
    throw new Error(
      `assertSeekEvidenceSubjectReady: question ${questionId} has more than one EvidenceSubject -- inconsistent state`
    );
  }
}

/**
 * Registers the immutable EvidenceSubject claim-identity fact for one
 * already-registered, current EVIDENCE_GAP question -- offline audit
 * bookkeeping only; no provider/retrieval call occurs here
 * (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §13.D, Slice 2D-C5-0 freeze,
 * decision K). `questionId`-bound, not `attemptId`-bound: a precondition for
 * planning a SEEK_EVIDENCE route to even exist, not the output of one
 * (decision K's own resolution of the apparent tension with
 * `createContextRequest`'s opposite, attempt-bound choice).
 *
 * `sourceRef` must exactly match one of the question's own `inputRefs` and
 * be `FINDING`/`SEMANTIC_ISSUE` only -- `AUTHOR_CONTEXT_ITEM` is rejected
 * outright, having no backing `ReviewFinding` to resolve to (decision E).
 * `originatingFindingId` is mandatory leaf provenance, resolved against the
 * actual `StressTestSession`, never merely a plausible-looking id (decision
 * F). `ONE EVIDENCE_GAP question -> AT MOST ONE EvidenceSubject`: a second
 * registration for a question that already has one is rejected outright --
 * never overwritten, merged, or returned as an idempotent substitute
 * (decision M).
 *
 * Returns two independent snapshots -- the appended `DeliberationState` and
 * a freestanding `evidenceSubject` -- mirroring `createContextRequest`'s
 * `buildSnapshot()`-called-twice discipline, so mutating one can never
 * rewrite the other's stored history (decision W).
 */
export function registerEvidenceSubject(
  session: StressTestSession,
  deliberationState: DeliberationState,
  input: {
    questionId: string;
    sourceRef: RouteInputRef;
    originatingFindingId: string;
    claimText: string;
  }
): { deliberationState: DeliberationState; evidenceSubject: EvidenceSubject } {
  verifyDeliberationBinding(session, deliberationState);
  if (deliberationState.stopReason !== null) {
    throw new Error('registerEvidenceSubject: deliberation has already stopped; no further EvidenceSubject may be registered');
  }
  if (input === null || typeof input !== 'object') {
    throw new Error('registerEvidenceSubject: input must be an object');
  }
  assertExactKeys(input, ['questionId', 'sourceRef', 'originatingFindingId', 'claimText'], 'registerEvidenceSubject');
  assertNonEmptyString(input.questionId, 'registerEvidenceSubject: questionId');

  // Global before local: the COMPLETE existing ledger is proven sound before
  // this registration trusts any local subject/question relationship.
  assertEvidenceSubjectLedgerIntegrity(session, deliberationState);

  const question = deliberationState.unresolvedQuestions.find((q) => q.id === input.questionId);
  if (!question) {
    throw new Error(`registerEvidenceSubject: questionId ${input.questionId} is not a currently registered unresolved question`);
  }
  if (question.rootCause !== 'EVIDENCE_GAP') {
    throw new Error(`registerEvidenceSubject: question ${input.questionId} has rootCause ${question.rootCause}, not EVIDENCE_GAP`);
  }
  if (!isQuestionCurrent(deliberationState, input.questionId)) {
    throw new Error(`registerEvidenceSubject: question ${input.questionId} is not current`);
  }

  if (input.sourceRef === null || typeof input.sourceRef !== 'object') {
    throw new Error('registerEvidenceSubject: sourceRef must be an object');
  }
  assertExactKeys(input.sourceRef, ['kind', 'id'], 'registerEvidenceSubject: sourceRef');
  if (input.sourceRef.kind !== 'FINDING' && input.sourceRef.kind !== 'SEMANTIC_ISSUE') {
    throw new Error(
      `registerEvidenceSubject: sourceRef.kind must be FINDING or SEMANTIC_ISSUE (got ${JSON.stringify(
        (input.sourceRef as { kind: unknown }).kind
      )}) -- AUTHOR_CONTEXT_ITEM has no backing ReviewFinding to resolve to`
    );
  }
  assertNonEmptyString(input.sourceRef.id, 'registerEvidenceSubject: sourceRef.id');
  validateRouteInputRef(session, input.sourceRef);

  const matchesQuestionRef = question.inputRefs.some(
    (ref) => ref.kind === input.sourceRef.kind && ref.id === input.sourceRef.id
  );
  if (!matchesQuestionRef) {
    throw new Error(`registerEvidenceSubject: sourceRef does not exactly match any of question ${question.id}'s own inputRefs`);
  }

  assertNonEmptyString(input.originatingFindingId, 'registerEvidenceSubject: originatingFindingId');
  if (input.sourceRef.kind === 'FINDING') {
    if (input.originatingFindingId !== input.sourceRef.id) {
      throw new Error('registerEvidenceSubject: originatingFindingId must equal sourceRef.id when sourceRef.kind is FINDING');
    }
  } else {
    assertSemanticIssueEvidenceLeaf(session, input.sourceRef.id, input.originatingFindingId, 'registerEvidenceSubject');
  }
  const resolvedFinding = session.findings[input.originatingFindingId];
  if (!resolvedFinding) {
    throw new Error(
      `registerEvidenceSubject: originatingFindingId ${input.originatingFindingId} does not resolve to a ReviewFinding in the current session`
    );
  }
  if (resolvedFinding.id !== input.originatingFindingId) {
    throw new Error(
      `registerEvidenceSubject: resolved ReviewFinding's own id does not agree with originatingFindingId ${input.originatingFindingId} -- map-key/stored-id mismatch`
    );
  }

  assertNonEmptyString(input.claimText, 'registerEvidenceSubject: claimText');

  // Cardinality (decision M): zero currently registered for this question.
  // Never overwritten, merged, or returned as an idempotent substitute.
  if (effectiveEvidenceSubjects(deliberationState).some((s) => s.originatingQuestionId === input.questionId)) {
    throw new Error(
      `registerEvidenceSubject: question ${input.questionId} already has a registered EvidenceSubject; it is never overwritten or re-registered`
    );
  }

  if (!session.artifactHash || !session.authorContextHash) {
    throw new Error('registerEvidenceSubject: session is missing its frozen artifactHash/authorContextHash');
  }

  const id = randomUUID();
  const createdAt = nowIso();
  const sessionId = session.id;
  const artifactHash = session.artifactHash;
  const authorContextHash = session.authorContextHash;
  const questionId = question.id;
  const originatingFindingId = input.originatingFindingId;
  const claimText = input.claimText;
  const sourceRefSnapshot = cloneRouteInputRef(input.sourceRef);
  const buildSnapshot = (): EvidenceSubject => ({
    id,
    originatingQuestionId: questionId,
    sourceRef: cloneRouteInputRef(sourceRefSnapshot),
    originatingFindingId,
    claimText,
    sessionId,
    artifactHash,
    authorContextHash,
    createdAt,
  });

  return {
    deliberationState: {
      ...deliberationState,
      evidenceSubjects: [...effectiveEvidenceSubjects(deliberationState), buildSnapshot()],
    },
    evidenceSubject: buildSnapshot(),
  };
}

/**
 * Independently re-validates a stored successful/inconclusive `SEEK_EVIDENCE`
 * `RouteOutcome` against the complete authoritative-upstream chain at the
 * moment it is about to be trusted as a claim-evaluating fact -- never
 * merely because `outcome.attemptId`/`outcome.originatingQuestionId` look
 * self-consistent (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §13.D
 * decision V, "authoritative-upstream" principle, restated a further time).
 * A no-op for any outcome that is not a claim-evaluating SEEK_EVIDENCE
 * result -- a generic `FAILED` SEEK_EVIDENCE outcome asserts no evidence
 * relation and never required an EvidenceSubject (decision P), so it is
 * never subject to this check.
 *
 * The `RouteAttempt` -> `RouteDecision` -> `UnresolvedQuestion` leg reuses
 * the canonical `validateAttemptProvenanceForOutcome` -- the exact function
 * `recordRouteOutcome` itself trusts at write time -- rather than
 * maintaining a second, weaker provenance walk here (Slice 2D-C5-B
 * amendment: "later-read provenance parity"). This also reuses
 * `assertEvidenceSubjectLedgerIntegrity` (and, transitively,
 * `assertSemanticIssueEvidenceLeaf`) rather than reimplementing
 * sourceRef/leaf-finding logic a third time -- the exact write/read-drift
 * lesson the Slice 2D-C5-A amendment closed for registration, applied here
 * to outcome recording/re-reading.
 */
function assertSeekEvidenceOutcomeIntegrity(
  session: StressTestSession,
  deliberationState: DeliberationState,
  outcome: RouteOutcome
): void {
  if (outcome.route !== 'SEEK_EVIDENCE' || outcome.status === 'FAILED') {
    return;
  }
  verifyDeliberationBinding(session, deliberationState);
  const label = 'SEEK_EVIDENCE outcome read validation';
  assertSeekEvidenceStatusResultAndCitations(outcome.status, outcome.result, outcome.citations, label);
  assertNonEmptyString(outcome.evidenceSubjectId, `${label}: evidenceSubjectId`);
  assertFiniteNonNegative(outcome.latencyConsumed, `${label}: latencyConsumed`);
  if (Number.isNaN(Date.parse(outcome.completedAt))) {
    throw new Error(`${label}: completedAt is not a valid parseable timestamp`);
  }

  const matchingAttempts = deliberationState.attempts.filter((a) => a.attemptId === outcome.attemptId);
  if (matchingAttempts.length !== 1) {
    throw new Error(`${label}: attemptId ${outcome.attemptId} does not resolve to exactly one RouteAttempt`);
  }
  const attempt = matchingAttempts[0];
  if (attempt.route !== 'SEEK_EVIDENCE') {
    throw new Error(`${label}: resolved attempt has route ${attempt.route}, not SEEK_EVIDENCE`);
  }

  // Full attempt -> decision -> question provenance parity with
  // `recordRouteOutcome`'s own write-time check -- attemptId/decisionId/
  // questionId non-empty, route validity, session/hash binding against both
  // `deliberationState` and the authoritative `session`, logicalCost
  // finite/non-negative AND route-legal (never adjacent-only, so tampering
  // attempt.logicalCost and outcome.logicalCost to the SAME invalid value no
  // longer passes), startedAt parseable, decision resolution, and decision
  // rootCause/materialityReason/inputRefs/route-mapping parity with the
  // registered question.
  const decision = validateAttemptProvenanceForOutcome(session, deliberationState, attempt);
  if (decision.route !== 'SEEK_EVIDENCE') {
    throw new Error(`${label}: resolved decision has route ${decision.route}, not SEEK_EVIDENCE`);
  }
  if (decision.id !== outcome.decisionId) {
    throw new Error(`${label}: outcome.decisionId does not match the resolved attempt's own decision`);
  }
  if (attempt.questionId !== outcome.originatingQuestionId) {
    throw new Error(`${label}: outcome.originatingQuestionId does not match the resolved attempt`);
  }

  if (attempt.logicalCost !== outcome.logicalCost) {
    throw new Error(`${label}: logicalCost does not match the resolved attempt`);
  }
  if (
    attempt.sessionId !== outcome.sessionId ||
    attempt.artifactHash !== outcome.artifactHash ||
    attempt.authorContextHash !== outcome.authorContextHash
  ) {
    throw new Error(`${label}: outcome session/hash binding does not match the resolved attempt`);
  }

  const question = deliberationState.unresolvedQuestions.find((q) => q.id === attempt.questionId);
  if (!question || question.rootCause !== 'EVIDENCE_GAP') {
    throw new Error(`${label}: resolved question does not have rootCause EVIDENCE_GAP`);
  }

  assertEvidenceSubjectLedgerIntegrity(session, deliberationState);
  const matchingSubjects = effectiveEvidenceSubjects(deliberationState).filter((s) => s.id === outcome.evidenceSubjectId);
  if (matchingSubjects.length !== 1) {
    throw new Error(`${label}: evidenceSubjectId ${outcome.evidenceSubjectId} does not resolve to exactly one EvidenceSubject`);
  }
  if (matchingSubjects[0].originatingQuestionId !== question.id) {
    throw new Error(`${label}: resolved EvidenceSubject does not belong to the outcome's own question`);
  }
}

/**
 * Shared, pure structural/cardinality validator for a
 * `DECISION_SENSITIVE_CONFLICT` question's `inputRefs` -- the ONE source of
 * truth for "what counts as a valid `TARGETED_PEER_CHALLENGE` conflict set"
 * (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §13.E decisions F/G/H,
 * invariants 80/81, Slice 2D-C6-A). Every ref must independently resolve
 * against the authoritative `session` (`validateRouteInputRef`) -- an
 * unresolved/malformed ref never counts toward cardinality, so the gate is
 * "two or more distinct AND valid refs," never merely `inputRefs.length >=
 * 2`. Distinctness is full-tuple `(kind, id)`: two refs of different `kind`
 * but the same `id` are distinct, provided each independently resolves;
 * deduplication by `id` alone is never performed. "At least two" is a floor,
 * not an exact count -- three or more distinct refs remain legal and are
 * never truncated or normalized. Used directly by `createUnresolvedQuestion`/
 * `registerUnresolvedQuestion` (which validate a caller-supplied array with
 * no yet-registered/current question to resolve by id) and, transitively,
 * by `assertTargetedPeerChallengeReady` below (which resolves the registered
 * question first, then reuses this same function) -- never reimplemented a
 * second or third time.
 */
function assertTargetedPeerChallengeInputRefs(session: StressTestSession, inputRefs: RouteInputRef[], label: string): void {
  if (!Array.isArray(inputRefs)) {
    throw new Error(`${label}: inputRefs must be an array`);
  }
  for (const ref of inputRefs) validateRouteInputRef(session, ref);
  const distinctKeys = new Set(inputRefs.map((ref) => `${ref.kind}\x00${ref.id}`));
  if (distinctKeys.size < 2) {
    throw new Error(
      `${label}: a DECISION_SENSITIVE_CONFLICT question requires at least two distinct (kind, id) RouteInputRefs`
    );
  }
}

/**
 * Post-registration `TARGETED_PEER_CHALLENGE` readiness
 * (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §13.E decisions C/D/E/F,
 * invariants 80/81, Slice 2D-C6-A). Resolves the exact registered, current
 * question and reuses `assertTargetedPeerChallengeInputRefs` above on its
 * `inputRefs` rather than maintaining a second definition of tuple/
 * cardinality semantics. Reused, unchanged, at `planRouteForQuestion`,
 * `recordRouteDecision`, and `recordRouteAttemptStart` -- none deferring to
 * another having already checked the requirement, the same
 * never-trust-an-upstream-boundary posture already governing invariant 74's
 * `SEEK_EVIDENCE` gates.
 */
function assertTargetedPeerChallengeReady(
  session: StressTestSession,
  deliberationState: DeliberationState,
  questionId: string
): UnresolvedQuestion {
  verifyDeliberationBinding(session, deliberationState);
  const question = deliberationState.unresolvedQuestions.find((q) => q.id === questionId);
  if (!question) {
    throw new Error(
      `assertTargetedPeerChallengeReady: questionId ${questionId} is not a currently registered unresolved question`
    );
  }
  if (question.rootCause !== 'DECISION_SENSITIVE_CONFLICT') {
    throw new Error(
      `assertTargetedPeerChallengeReady: question ${questionId} has rootCause ${question.rootCause}, not DECISION_SENSITIVE_CONFLICT`
    );
  }
  if (!isQuestionCurrent(deliberationState, questionId)) {
    throw new Error(`assertTargetedPeerChallengeReady: question ${questionId} is not current`);
  }
  assertTargetedPeerChallengeInputRefs(session, question.inputRefs, 'assertTargetedPeerChallengeReady');
  return question;
}

/**
 * Structural validator for a `TargetedPeerChallengeBoundedExcerpt` payload
 * (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §7.E, §13.E, Slice 2D-C6-B).
 * Proves only self-consistency -- `text.length <= charLimit` always, and
 * `truncated` iff `text.length === charLimit` -- mirroring the structural
 * invariant the experimental `buildPeerExcerpt` principle already produces
 * (`src/agents/collaboration.ts`, read-only reference, never imported here).
 * `charLimit` is an explicit per-result bound, not a global production
 * policy ceiling -- no numeric maximum is invented.
 */
function assertValidTargetedPeerChallengeBoundedExcerpt(excerpt: TargetedPeerChallengeBoundedExcerpt, label: string): void {
  if (excerpt === null || typeof excerpt !== 'object') {
    throw new Error(`${label} must be an object`);
  }
  assertExactKeys(excerpt, ['text', 'truncated', 'charLimit'], label);
  if (typeof excerpt.text !== 'string' || excerpt.text.trim().length === 0) {
    throw new Error(`${label}.text must be a non-empty string`);
  }
  if (typeof excerpt.truncated !== 'boolean') {
    throw new Error(`${label}.truncated must be a boolean`);
  }
  if (
    typeof excerpt.charLimit !== 'number' ||
    !Number.isFinite(excerpt.charLimit) ||
    !Number.isInteger(excerpt.charLimit) ||
    excerpt.charLimit < 1
  ) {
    throw new Error(`${label}.charLimit must be a finite, positive integer`);
  }
  if (excerpt.text.length > excerpt.charLimit) {
    throw new Error(`${label}: text.length must not exceed charLimit`);
  }
  if (excerpt.truncated && excerpt.text.length !== excerpt.charLimit) {
    throw new Error(`${label}: a truncated excerpt must have text.length exactly equal to charLimit`);
  }
}

/** Independent snapshot of a TargetedPeerChallengeBoundedExcerpt -- never the caller-owned object; `text` is stored exactly as supplied, never trimmed or normalized. */
function cloneTargetedPeerChallengeBoundedExcerpt(
  excerpt: TargetedPeerChallengeBoundedExcerpt
): TargetedPeerChallengeBoundedExcerpt {
  return { text: excerpt.text, truncated: excerpt.truncated, charLimit: excerpt.charLimit };
}

/**
 * Shared status/result/targetRef/sourceRef/boundedExcerpt/response validator
 * for a successful `TARGETED_PEER_CHALLENGE` outcome -- the ONE source of
 * truth reused at both write time (`recordRouteOutcome`) and later-read time
 * (`assertTargetedPeerChallengeOutcomeIntegrity`), the same write/read-parity
 * discipline the Slice 2D-C5-A/2D-C5-B amendments established
 * (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §13.E, Slice 2D-C6-B).
 * `targetRef`/`sourceRef` must each independently resolve
 * (`validateRouteInputRef`), be distinct from one another by full tuple
 * `(kind, id)` -- never `id` alone -- and each exactly match one of
 * `decisionInputRefs` (invariant 31); no positional meaning is ever assigned
 * to either ref's position within that recorded set.
 */
function assertTargetedPeerChallengeResultPayload(
  status: AttemptStatus,
  result: TargetedPeerChallengeResult,
  targetRef: RouteInputRef,
  sourceRef: RouteInputRef,
  boundedExcerpt: TargetedPeerChallengeBoundedExcerpt,
  response: string,
  decisionInputRefs: RouteInputRef[],
  session: StressTestSession,
  label: string
): void {
  if (status !== 'SUCCEEDED') {
    throw new Error(`${label}: TARGETED_PEER_CHALLENGE result recording requires status SUCCEEDED`);
  }
  if (!TARGETED_PEER_CHALLENGE_RESULTS.includes(result)) {
    throw new Error(`${label}: invalid TargetedPeerChallengeResult ${JSON.stringify(result)}`);
  }
  if (targetRef === null || typeof targetRef !== 'object') {
    throw new Error(`${label}: targetRef must be an object`);
  }
  validateRouteInputRef(session, targetRef);
  if (sourceRef === null || typeof sourceRef !== 'object') {
    throw new Error(`${label}: sourceRef must be an object`);
  }
  validateRouteInputRef(session, sourceRef);
  if (targetRef.kind === sourceRef.kind && targetRef.id === sourceRef.id) {
    throw new Error(`${label}: targetRef and sourceRef must be distinct (kind, id) refs`);
  }
  const targetIsMember = decisionInputRefs.some((ref) => ref.kind === targetRef.kind && ref.id === targetRef.id);
  if (!targetIsMember) {
    throw new Error(`${label}: targetRef must exactly match one of the recorded RouteDecision.inputRefs`);
  }
  const sourceIsMember = decisionInputRefs.some((ref) => ref.kind === sourceRef.kind && ref.id === sourceRef.id);
  if (!sourceIsMember) {
    throw new Error(`${label}: sourceRef must exactly match one of the recorded RouteDecision.inputRefs`);
  }
  assertValidTargetedPeerChallengeBoundedExcerpt(boundedExcerpt, `${label}: boundedExcerpt`);
  if (typeof response !== 'string' || response.trim().length === 0) {
    throw new Error(`${label}: response must be a non-empty string`);
  }
}

/**
 * Independently re-validates a stored successful `TARGETED_PEER_CHALLENGE`
 * `RouteOutcome` against the complete authoritative-upstream chain at the
 * moment it is about to be trusted as the target of semantic re-evaluation
 * -- never merely because its stored fields look self-consistent
 * (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §13.E, "authoritative-upstream"
 * principle, Slice 2D-C6-B). A no-op for any outcome that is not a
 * successful TARGETED_PEER_CHALLENGE result -- a generic `FAILED`
 * TARGETED_PEER_CHALLENGE outcome asserts no two-sided challenge result and
 * carries none of `targetRef`/`sourceRef`/`boundedExcerpt`/`response`/
 * `result`, so it is never subject to this check (decision K, Slice
 * 2D-C6-A).
 *
 * The `RouteAttempt` -> `RouteDecision` -> `UnresolvedQuestion` leg reuses
 * the canonical `validateAttemptProvenanceForOutcome` -- the exact function
 * `recordRouteOutcome` itself trusts at write time -- rather than
 * maintaining a second, weaker provenance walk (the standing rule after
 * the Slice 2D-C5-B amendment). TPC readiness reuses
 * `assertTargetedPeerChallengeReady` (and, transitively,
 * `assertTargetedPeerChallengeInputRefs`) rather than reimplementing
 * cardinality/ref-validity logic a third time. The result/targetRef/
 * sourceRef/boundedExcerpt/response payload reuses
 * `assertTargetedPeerChallengeResultPayload`, the same function
 * `recordRouteOutcome` calls at write time.
 */
function assertTargetedPeerChallengeOutcomeIntegrity(
  session: StressTestSession,
  deliberationState: DeliberationState,
  outcome: RouteOutcome
): void {
  if (outcome.route !== 'TARGETED_PEER_CHALLENGE' || outcome.status !== 'SUCCEEDED') {
    return;
  }
  verifyDeliberationBinding(session, deliberationState);
  const label = 'TARGETED_PEER_CHALLENGE outcome read validation';
  assertFiniteNonNegative(outcome.latencyConsumed, `${label}: latencyConsumed`);
  if (Number.isNaN(Date.parse(outcome.completedAt))) {
    throw new Error(`${label}: completedAt is not a valid parseable timestamp`);
  }

  const matchingAttempts = deliberationState.attempts.filter((a) => a.attemptId === outcome.attemptId);
  if (matchingAttempts.length !== 1) {
    throw new Error(`${label}: attemptId ${outcome.attemptId} does not resolve to exactly one RouteAttempt`);
  }
  const attempt = matchingAttempts[0];
  if (attempt.route !== 'TARGETED_PEER_CHALLENGE') {
    throw new Error(`${label}: resolved attempt has route ${attempt.route}, not TARGETED_PEER_CHALLENGE`);
  }

  // Full attempt -> decision -> question provenance parity with
  // `recordRouteOutcome`'s own write-time check.
  const decision = validateAttemptProvenanceForOutcome(session, deliberationState, attempt);
  if (decision.route !== 'TARGETED_PEER_CHALLENGE') {
    throw new Error(`${label}: resolved decision has route ${decision.route}, not TARGETED_PEER_CHALLENGE`);
  }
  if (decision.id !== outcome.decisionId) {
    throw new Error(`${label}: outcome.decisionId does not match the resolved attempt's own decision`);
  }
  if (attempt.questionId !== outcome.originatingQuestionId) {
    throw new Error(`${label}: outcome.originatingQuestionId does not match the resolved attempt`);
  }

  if (attempt.logicalCost !== outcome.logicalCost) {
    throw new Error(`${label}: logicalCost does not match the resolved attempt`);
  }
  if (
    attempt.sessionId !== outcome.sessionId ||
    attempt.artifactHash !== outcome.artifactHash ||
    attempt.authorContextHash !== outcome.authorContextHash
  ) {
    throw new Error(`${label}: outcome session/hash binding does not match the resolved attempt`);
  }

  // Never assume C6-A's earlier planning/recording/attempt-start gates
  // remain trustworthy for later/tampered state -- readiness is re-derived
  // in full, including the currently-registered question's inputRefs.
  assertTargetedPeerChallengeReady(session, deliberationState, attempt.questionId);

  assertTargetedPeerChallengeResultPayload(
    outcome.status,
    outcome.result,
    outcome.targetRef,
    outcome.sourceRef,
    outcome.boundedExcerpt,
    outcome.response,
    decision.inputRefs,
    session,
    label
  );
}

// ===========================================================================
// Execution coordination runtime — Slice 2D-D1-A (OFFLINE ONLY)
// ===========================================================================
//
// Implements the accepted Slice 2D-D1-A0 architecture
// (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §27, §28.1-§28.36, EC-1-EC-30)
// as a deterministic, single-process, in-memory reference runtime.
//
// NOTHING HERE CALLS A PROVIDER. No Claude/OpenAI/Gemini call, no retrieval,
// no prompt generation, no model selection, no TPC execution, no Round 2.
// Every "execution result" this layer accepts is an already-obtained,
// already-normalized terminal fact handed in by a caller that performed the
// call somewhere outside this domain (§27.1's layer separation, §27.2).
//
// Durability posture (§28.23, restated so no reader can mistake it): the
// in-memory store/port below prove API and coordination-CONTRACT conformance
// within one process only. They are NOT database durability, NOT cross-process
// atomicity, NOT distributed locking, and NOT crash-safe production
// persistence. A production adapter must supply those; passing tests here can
// never be evidence of them.
// ===========================================================================

/**
 * The four machine-provider routes the execution envelope applies to (§27.3).
 * `ADD_CONTEXT` is categorically outside it (human-authored response) and
 * `STOP` records no attempt at all -- neither may ever be claimed for
 * provider-backed execution.
 */
const MACHINE_EXECUTABLE_ROUTES: readonly NonStopDeliberationRoute[] = [
  'ADD_REVIEWER',
  'REPLICATE',
  'SEEK_EVIDENCE',
  'TARGETED_PEER_CHALLENGE',
];

function assertFiniteNonNegativeInteger(value: number, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a finite integer >= 0 (got ${JSON.stringify(value)})`);
  }
}

function assertFinitePositiveInteger(value: number, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a finite integer > 0 (got ${JSON.stringify(value)})`);
  }
}

/**
 * The route-specific portion of an already-obtained successful terminal
 * result -- deliberately NOT a new type: each member is the exact subset of
 * `RecordRouteOutcomeInput` this document already accepted for that route
 * (§28.13's frozen Option A), minus `attemptId`/`status`/`latencyConsumed`,
 * which the checkpoint already tracks independently. No `raw`/
 * `providerResponse`/`metadata` escape hatch exists, so a raw provider
 * payload is excluded by construction, not merely by convention (EC-14).
 */
export type RouteSpecificSuccessPayload =
  | { reviewerRunId: string; findingIds: string[] }
  | { result: ReplicationResult; targetRef: RouteInputRef }
  | { result: 'SUPPORTIVE' | 'CONTRADICTORY'; evidenceSubjectId: string; citations: EvidenceCitation[] }
  | { result: 'SUPPLIED'; contextRequestId: string; responseText: string }
  | { result: 'DECLINED'; contextRequestId: string }
  | { result: 'NO_RESPONSE'; contextRequestId: string }
  | {
      targetRef: RouteInputRef;
      sourceRef: RouteInputRef;
      boundedExcerpt: TargetedPeerChallengeBoundedExcerpt;
      response: string;
      result: TargetedPeerChallengeResult;
    };

/** The exact `SEEK_EVIDENCE` inconclusive payload already accepted by `recordRouteOutcome` (§28.13, EC-19). */
export interface SeekEvidenceInconclusivePayload {
  result: 'INCONCLUSIVE';
  evidenceSubjectId: string;
  citations: EvidenceCitation[];
}

/**
 * The persisted terminal fact. `DEADLINE_VIOLATION` exists here and ONLY
 * here -- it is always derived by this runtime from the single supplied
 * `actualLatencyMs` versus the authoritative `ClaimedCheckpoint.latencyLimitMs`,
 * never caller-selected (§28.14, EC-18).
 */
export type ReservedTerminalFact =
  | { kind: 'SUCCEEDED'; actualLatencyMs: number; payload: RouteSpecificSuccessPayload }
  | { kind: 'INCONCLUSIVE'; actualLatencyMs: number; payload: SeekEvidenceInconclusivePayload }
  | { kind: 'FAILED'; actualLatencyMs: number; failure: FailureInfo }
  | { kind: 'DEADLINE_VIOLATION'; actualLatencyMs: number };

/**
 * The caller-facing terminal-result input (§28.13, second amendment).
 * Structurally incapable of expressing `DEADLINE_VIOLATION` or a second
 * `actualLatencyMs` -- the two defects that shape exists to foreclose.
 */
export type ExecutionTerminalResultInput =
  | { kind: 'SUCCEEDED'; payload: RouteSpecificSuccessPayload }
  | { kind: 'INCONCLUSIVE'; payload: SeekEvidenceInconclusivePayload }
  | { kind: 'FAILED'; failure: FailureInfo };

/** Ownership claimed and latency reservation already granted, atomically, in one transaction (§28.6/§28.7). */
export interface ClaimedCheckpoint {
  phase: 'CLAIMED';
  attemptId: string;
  deliberationStateId: string;
  route: NonStopDeliberationRoute;
  claimedAt: string;
  latencyLimitMs: number;
  reservedLatencyMs: number;
}

/** An external call was attempted and produced a terminal fact (§28.13). */
export interface ReservedTerminalFactReadyCheckpoint {
  phase: 'TERMINAL_FACT_READY';
  attemptId: string;
  deliberationStateId: string;
  route: NonStopDeliberationRoute;
  claimedAt: string;
  latencyLimitMs: number;
  reservedLatencyMs: number;
  terminalFactReadyAt: string;
  terminalFact: ReservedTerminalFact;
}

/**
 * A determinate PRE-call failure -- no provider call was ever attempted, so
 * no reservation was ever held and no `latencyLimitMs` field exists on this
 * shape at all (§28.8/§28.13, EC-16). Reachable two ways, both producing this
 * identical canonical shape: `claimRouteExecution`'s own admission rejection
 * (§28.9, always `EXECUTION`) and `recordExecutionPreCallFailure` (§28.33,
 * `REFERENCE_RESOLUTION` or `EXECUTION`).
 */
export interface PreCallFailedTerminalFactReadyCheckpoint {
  phase: 'TERMINAL_FACT_READY';
  attemptId: string;
  deliberationStateId: string;
  route: NonStopDeliberationRoute;
  claimedAt: string;
  reservedLatencyMs: 0;
  terminalFactReadyAt: string;
  terminalFact: { kind: 'FAILED'; actualLatencyMs: 0; failure: FailureInfo };
}

export type TerminalFactReadyCheckpoint =
  | ReservedTerminalFactReadyCheckpoint
  | PreCallFailedTerminalFactReadyCheckpoint;

/** `terminalFact` is RETAINED, never compacted away -- read integrity re-proves exact agreement against it (§28.15, EC-24). */
export interface OutcomeCommittedCheckpoint {
  phase: 'OUTCOME_COMMITTED';
  attemptId: string;
  deliberationStateId: string;
  route: NonStopDeliberationRoute;
  claimedAt: string;
  terminalFactReadyAt: string;
  outcomeCommittedAt: string;
  terminalFact: ReservedTerminalFact;
}

/**
 * The execution-coordination record for exactly one `RouteAttempt`.
 * Identity is `attemptId` and nothing else -- no `checkpointId`/`executionId`/
 * `callId`/`requestId` second identity exists (§28.1, EC-1). `UNCLAIMED` is
 * the ABSENCE of a record, never a fourth phase (§28.5).
 */
export type RouteExecutionCheckpoint = ClaimedCheckpoint | TerminalFactReadyCheckpoint | OutcomeCommittedCheckpoint;

/** Structural discriminant between the two `TERMINAL_FACT_READY` subtypes (§28.13): a pre-call failure has no `latencyLimitMs` field at all. */
export function isPreCallFailedCheckpoint(
  checkpoint: RouteExecutionCheckpoint
): checkpoint is PreCallFailedTerminalFactReadyCheckpoint {
  return checkpoint.phase === 'TERMINAL_FACT_READY' && !('latencyLimitMs' in checkpoint);
}

/**
 * Live-execution authority (§28.32, EC-20). `DISABLED` is categorically NOT
 * an admission failure: it produces no checkpoint of any kind. No provider or
 * model name belongs in this decision -- provider selection remains OPEN
 * (§28.29, unchanged).
 */
export type LiveExecutionPolicyDecision = { status: 'DISABLED' } | { status: 'ENABLED'; latencyLimitMs: number };

/** Composition-level dependency, never per-call caller data (§28.32). */
export interface LiveExecutionPolicyResolver {
  resolveLiveExecutionPolicy(attempt: RouteAttempt): LiveExecutionPolicyDecision;
}

/**
 * Current-value authority (§28.34.4, EC-27). Serializing operations through a
 * critical section does NOT, by itself, make a second operation observe the
 * state a first one just committed -- these domain operations use immutable
 * value semantics (`operation(state) -> newState`), so a caller-captured
 * snapshot stays stale forever unless current state is re-resolved from
 * INSIDE the boundary. This port exists exactly to close that gap. It is not
 * a second semantic ledger: `RouteOutcome` remains product truth (EC-25).
 */
export interface DeliberationStateAccessPort {
  resolveCurrentDeliberationState(deliberationStateId: string): DeliberationState;
  commitDeliberationState(nextState: DeliberationState): void;
}

/**
 * Checkpoint persistence + state-level coordination (§28.2/§28.10/§28.34.4).
 * Deliberately exposes NO generic `updateCheckpoint(partialObject)` escape
 * hatch -- every lifecycle change flows through a dedicated, narrow operation
 * (§28.17).
 */
export interface RouteExecutionCheckpointStore {
  getCheckpoint(attemptId: string): RouteExecutionCheckpoint | undefined;
  listCheckpointsForDeliberationState(deliberationStateId: string): RouteExecutionCheckpoint[];
  /** Atomic insert-if-absent. Throws if a checkpoint already exists for the `attemptId` (EC-3/EC-6). */
  insertCheckpointIfAbsent(checkpoint: RouteExecutionCheckpoint): RouteExecutionCheckpoint;
  /** Phase-safe replacement: rejects unless the stored record is currently in `expectedPhase`. */
  replaceCheckpointPhase(
    attemptId: string,
    expectedPhase: RouteExecutionCheckpoint['phase'],
    next: RouteExecutionCheckpoint
  ): RouteExecutionCheckpoint;
  withDeliberationStateCoordination<T>(deliberationStateId: string, operation: () => T): T;
}

// --- Snapshot / alias isolation (§28.22, EC-14) ----------------------------
// Explicit domain-specific clone helpers, reusing the ones the accepted
// product layer already established. No generic deep-freeze/deep-clone
// infrastructure is introduced (this packet's own §30 instruction).

function cloneRouteSpecificSuccessPayload(payload: RouteSpecificSuccessPayload): RouteSpecificSuccessPayload {
  const raw = payload as Record<string, unknown>;
  if ('reviewerRunId' in raw) {
    return { reviewerRunId: raw.reviewerRunId as string, findingIds: [...(raw.findingIds as string[])] };
  }
  if ('boundedExcerpt' in raw) {
    return {
      targetRef: cloneRouteInputRef(raw.targetRef as RouteInputRef),
      sourceRef: cloneRouteInputRef(raw.sourceRef as RouteInputRef),
      boundedExcerpt: cloneTargetedPeerChallengeBoundedExcerpt(raw.boundedExcerpt as TargetedPeerChallengeBoundedExcerpt),
      response: raw.response as string,
      result: raw.result as TargetedPeerChallengeResult,
    };
  }
  if ('evidenceSubjectId' in raw) {
    return {
      result: raw.result as 'SUPPORTIVE' | 'CONTRADICTORY',
      evidenceSubjectId: raw.evidenceSubjectId as string,
      citations: cloneEvidenceCitations(raw.citations as EvidenceCitation[]),
    };
  }
  if ('responseText' in raw) {
    return {
      result: 'SUPPLIED',
      contextRequestId: raw.contextRequestId as string,
      responseText: raw.responseText as string,
    };
  }
  if ('contextRequestId' in raw) {
    return { result: raw.result as 'DECLINED' | 'NO_RESPONSE', contextRequestId: raw.contextRequestId as string };
  }
  return { result: raw.result as ReplicationResult, targetRef: cloneRouteInputRef(raw.targetRef as RouteInputRef) };
}

function cloneSeekEvidenceInconclusivePayload(payload: SeekEvidenceInconclusivePayload): SeekEvidenceInconclusivePayload {
  return {
    result: 'INCONCLUSIVE',
    evidenceSubjectId: payload.evidenceSubjectId,
    citations: cloneEvidenceCitations(payload.citations),
  };
}

function cloneReservedTerminalFact(fact: ReservedTerminalFact): ReservedTerminalFact {
  switch (fact.kind) {
    case 'SUCCEEDED':
      return { kind: 'SUCCEEDED', actualLatencyMs: fact.actualLatencyMs, payload: cloneRouteSpecificSuccessPayload(fact.payload) };
    case 'INCONCLUSIVE':
      return {
        kind: 'INCONCLUSIVE',
        actualLatencyMs: fact.actualLatencyMs,
        payload: cloneSeekEvidenceInconclusivePayload(fact.payload),
      };
    case 'FAILED':
      return { kind: 'FAILED', actualLatencyMs: fact.actualLatencyMs, failure: cloneFailureInfo(fact.failure) };
    case 'DEADLINE_VIOLATION':
      return { kind: 'DEADLINE_VIOLATION', actualLatencyMs: fact.actualLatencyMs };
    default: {
      const exhaustive: never = fact;
      throw new Error(`cloneReservedTerminalFact: invalid kind ${JSON.stringify((exhaustive as { kind: unknown }).kind)}`);
    }
  }
}

// --- Route-specific payload validation -------------------------------------
// Structural/vocabulary validation only. Deep product re-verification
// (findings resolve, refs belong to the decision's inputRefs, evidence
// subject readiness, ...) stays where it already lives -- `recordRouteOutcome`
// at persistence time. Coordination governs admission and ordering, never
// product semantic content (§28.34.8/EC-25).

function assertRouteSpecificSuccessPayload(
  route: NonStopDeliberationRoute,
  payload: RouteSpecificSuccessPayload,
  label: string
): void {
  if (payload === null || typeof payload !== 'object') {
    throw new Error(`${label} must be an object`);
  }
  const raw = payload as Record<string, unknown>;
  switch (route) {
    case 'ADD_REVIEWER': {
      assertExactKeys(payload, ['reviewerRunId', 'findingIds'], label);
      assertNonEmptyString(raw.reviewerRunId as string, `${label}.reviewerRunId`);
      if (!Array.isArray(raw.findingIds)) {
        throw new Error(`${label}.findingIds must be an array`);
      }
      for (const id of raw.findingIds as unknown[]) {
        assertNonEmptyString(id as string, `${label}.findingIds[]`);
      }
      return;
    }
    case 'REPLICATE': {
      assertExactKeys(payload, ['result', 'targetRef'], label);
      assertValidReplicationResult(raw.result as ReplicationResult, `${label}.result`);
      if (raw.targetRef === null || typeof raw.targetRef !== 'object') {
        throw new Error(`${label}.targetRef must be an object`);
      }
      return;
    }
    case 'SEEK_EVIDENCE': {
      assertExactKeys(payload, ['result', 'evidenceSubjectId', 'citations'], label);
      if (raw.result !== 'SUPPORTIVE' && raw.result !== 'CONTRADICTORY') {
        throw new Error(
          `${label}.result must be SUPPORTIVE or CONTRADICTORY for a SUCCEEDED SEEK_EVIDENCE terminal fact (got ${JSON.stringify(raw.result)}); INCONCLUSIVE uses its own terminal-fact kind`
        );
      }
      assertNonEmptyString(raw.evidenceSubjectId as string, `${label}.evidenceSubjectId`);
      if (!Array.isArray(raw.citations)) {
        throw new Error(`${label}.citations must be an array`);
      }
      for (const citation of raw.citations as EvidenceCitation[]) {
        assertValidEvidenceCitation(citation, `${label}.citations[]`);
      }
      return;
    }
    case 'TARGETED_PEER_CHALLENGE': {
      assertExactKeys(payload, ['targetRef', 'sourceRef', 'boundedExcerpt', 'response', 'result'], label);
      if (raw.targetRef === null || typeof raw.targetRef !== 'object') {
        throw new Error(`${label}.targetRef must be an object`);
      }
      if (raw.sourceRef === null || typeof raw.sourceRef !== 'object') {
        throw new Error(`${label}.sourceRef must be an object`);
      }
      assertValidTargetedPeerChallengeBoundedExcerpt(
        raw.boundedExcerpt as TargetedPeerChallengeBoundedExcerpt,
        `${label}.boundedExcerpt`
      );
      assertNonEmptyString(raw.response as string, `${label}.response`);
      if (!TARGETED_PEER_CHALLENGE_RESULTS.includes(raw.result as TargetedPeerChallengeResult)) {
        throw new Error(`${label}.result: invalid TargetedPeerChallengeResult ${JSON.stringify(raw.result)}`);
      }
      return;
    }
    case 'ADD_CONTEXT': {
      if (raw.result === 'SUPPLIED') {
        assertExactKeys(payload, ['result', 'contextRequestId', 'responseText'], label);
        assertNonEmptyString(raw.contextRequestId as string, `${label}.contextRequestId`);
        assertNonEmptyString(raw.responseText as string, `${label}.responseText`);
        return;
      }
      if (raw.result === 'DECLINED' || raw.result === 'NO_RESPONSE') {
        assertExactKeys(payload, ['result', 'contextRequestId'], label);
        assertNonEmptyString(raw.contextRequestId as string, `${label}.contextRequestId`);
        return;
      }
      throw new Error(`${label}.result: invalid AddContextResult ${JSON.stringify(raw.result)}`);
    }
    default: {
      const exhaustive: never = route;
      throw new Error(`${label}: invalid route ${JSON.stringify(exhaustive)}`);
    }
  }
}

function assertSeekEvidenceInconclusivePayload(payload: SeekEvidenceInconclusivePayload, label: string): void {
  if (payload === null || typeof payload !== 'object') {
    throw new Error(`${label} must be an object`);
  }
  assertExactKeys(payload, ['result', 'evidenceSubjectId', 'citations'], label);
  if (payload.result !== 'INCONCLUSIVE') {
    throw new Error(`${label}.result must be INCONCLUSIVE (got ${JSON.stringify(payload.result)})`);
  }
  assertNonEmptyString(payload.evidenceSubjectId, `${label}.evidenceSubjectId`);
  if (!Array.isArray(payload.citations)) {
    throw new Error(`${label}.citations must be an array`);
  }
  for (const citation of payload.citations) {
    assertValidEvidenceCitation(citation, `${label}.citations[]`);
  }
}

// --- projectRouteOutcomeToTerminalFact + exact agreement (§28.35.3) --------

/**
 * The ONE shared comparison boundary (§28.35.3). A pure, symmetric projection
 * of an already-persisted, authoritative `RouteOutcome` back into the same
 * `ReservedTerminalFact` shape a checkpoint stores. Used -- never
 * reimplemented -- by `markExecutionOutcomeCommitted` (§28.19 step 3),
 * `assertRouteExecutionCheckpointIntegrity` (§28.20), and §28.11's
 * residual-encumbrance match. Never produces `DEADLINE_VIOLATION`: no
 * `RouteOutcome` may exist for one (§28.14).
 */
export function projectRouteOutcomeToTerminalFact(outcome: RouteOutcome): ReservedTerminalFact {
  if (outcome === null || typeof outcome !== 'object') {
    throw new Error('projectRouteOutcomeToTerminalFact: outcome must be an object');
  }
  const actualLatencyMs = outcome.latencyConsumed;
  if (outcome.status === 'FAILED') {
    return { kind: 'FAILED', actualLatencyMs, failure: cloneFailureInfo((outcome as FailedRouteOutcome).failure) };
  }
  if (outcome.status === 'INCONCLUSIVE') {
    const seek = outcome as SeekEvidenceInconclusiveRouteOutcome;
    // Read the raw discriminant: a tampered/hand-built outcome is not
    // trustworthy merely because its TypeScript type says SEEK_EVIDENCE.
    if ((outcome as { route: string }).route !== 'SEEK_EVIDENCE') {
      throw new Error(
        `projectRouteOutcomeToTerminalFact: INCONCLUSIVE is only representable for SEEK_EVIDENCE (got route ${(outcome as { route: string }).route})`
      );
    }
    return {
      kind: 'INCONCLUSIVE',
      actualLatencyMs,
      payload: { result: 'INCONCLUSIVE', evidenceSubjectId: seek.evidenceSubjectId, citations: cloneEvidenceCitations(seek.citations) },
    };
  }
  switch (outcome.route) {
    case 'ADD_REVIEWER': {
      const o = outcome as AddReviewerRouteOutcome;
      return { kind: 'SUCCEEDED', actualLatencyMs, payload: { reviewerRunId: o.reviewerRunId, findingIds: [...o.findingIds] } };
    }
    case 'REPLICATE': {
      const o = outcome as ReplicationRouteOutcome;
      return { kind: 'SUCCEEDED', actualLatencyMs, payload: { result: o.result, targetRef: cloneRouteInputRef(o.targetRef) } };
    }
    case 'SEEK_EVIDENCE': {
      const o = outcome as SeekEvidenceSupportiveOrContradictoryRouteOutcome;
      return {
        kind: 'SUCCEEDED',
        actualLatencyMs,
        payload: { result: o.result, evidenceSubjectId: o.evidenceSubjectId, citations: cloneEvidenceCitations(o.citations) },
      };
    }
    case 'TARGETED_PEER_CHALLENGE': {
      const o = outcome as TargetedPeerChallengeRouteOutcome;
      return {
        kind: 'SUCCEEDED',
        actualLatencyMs,
        payload: {
          targetRef: cloneRouteInputRef(o.targetRef),
          sourceRef: cloneRouteInputRef(o.sourceRef),
          boundedExcerpt: cloneTargetedPeerChallengeBoundedExcerpt(o.boundedExcerpt),
          response: o.response,
          result: o.result,
        },
      };
    }
    case 'ADD_CONTEXT': {
      const o = outcome as AddContextRouteOutcome;
      if (o.result === 'SUPPLIED') {
        return {
          kind: 'SUCCEEDED',
          actualLatencyMs,
          payload: { result: 'SUPPLIED', contextRequestId: o.contextRequestId, responseText: o.responseText },
        };
      }
      return { kind: 'SUCCEEDED', actualLatencyMs, payload: { result: o.result, contextRequestId: o.contextRequestId } };
    }
  }
  throw new Error(
    `projectRouteOutcomeToTerminalFact: invalid route ${JSON.stringify((outcome as { route: unknown }).route)}`
  );
}

function routeInputRefsAgree(a: RouteInputRef, b: RouteInputRef): boolean {
  return a.kind === b.kind && a.id === b.id;
}

function citationsAgree(a: EvidenceCitation[], b: EvidenceCitation[]): boolean {
  // Ordering is domain-significant and is compared, never reduced to set
  // membership (§28.35.3).
  if (a.length !== b.length) return false;
  return a.every((c, i) => c.sourceIdentifier === b[i].sourceIdentifier && c.excerpt === b[i].excerpt && c.title === b[i].title);
}

/**
 * Value equality over the CLOSED domain fields only (§28.35.3) -- never
 * object identity, never category-only agreement, never prose similarity,
 * never a latest/first heuristic, and never a generic unbounded JSON
 * comparison (no field reachable here can hold a raw provider payload).
 */
function successPayloadsExactlyAgree(a: RouteSpecificSuccessPayload, b: RouteSpecificSuccessPayload): boolean {
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const xKeys = Object.keys(x).sort();
  const yKeys = Object.keys(y).sort();
  if (xKeys.length !== yKeys.length || xKeys.some((k, i) => k !== yKeys[i])) return false;
  if ('reviewerRunId' in x) {
    const xf = x.findingIds as string[];
    const yf = y.findingIds as string[];
    return x.reviewerRunId === y.reviewerRunId && xf.length === yf.length && xf.every((id, i) => id === yf[i]);
  }
  if ('boundedExcerpt' in x) {
    const xe = x.boundedExcerpt as TargetedPeerChallengeBoundedExcerpt;
    const ye = y.boundedExcerpt as TargetedPeerChallengeBoundedExcerpt;
    return (
      routeInputRefsAgree(x.targetRef as RouteInputRef, y.targetRef as RouteInputRef) &&
      routeInputRefsAgree(x.sourceRef as RouteInputRef, y.sourceRef as RouteInputRef) &&
      xe.text === ye.text &&
      xe.truncated === ye.truncated &&
      xe.charLimit === ye.charLimit &&
      x.response === y.response &&
      x.result === y.result
    );
  }
  if ('evidenceSubjectId' in x) {
    return (
      x.result === y.result &&
      x.evidenceSubjectId === y.evidenceSubjectId &&
      citationsAgree(x.citations as EvidenceCitation[], y.citations as EvidenceCitation[])
    );
  }
  if ('responseText' in x) {
    return x.result === y.result && x.contextRequestId === y.contextRequestId && x.responseText === y.responseText;
  }
  if ('contextRequestId' in x) {
    return x.result === y.result && x.contextRequestId === y.contextRequestId;
  }
  return x.result === y.result && routeInputRefsAgree(x.targetRef as RouteInputRef, y.targetRef as RouteInputRef);
}

/** Exact terminal-fact agreement -- the §28.19 step 3/4 check, shared with §28.11 and §28.20. */
export function terminalFactsExactlyAgree(a: ReservedTerminalFact, b: ReservedTerminalFact): boolean {
  if (a.kind !== b.kind) return false;
  if (a.actualLatencyMs !== b.actualLatencyMs) return false;
  switch (a.kind) {
    case 'SUCCEEDED':
      return successPayloadsExactlyAgree(a.payload, (b as typeof a).payload);
    case 'INCONCLUSIVE': {
      const bp = (b as typeof a).payload;
      return a.payload.evidenceSubjectId === bp.evidenceSubjectId && citationsAgree(a.payload.citations, bp.citations);
    }
    case 'FAILED': {
      const bf = (b as typeof a).failure;
      return a.failure.category === bf.category && a.failure.message === bf.message;
    }
    case 'DEADLINE_VIOLATION':
      return true;
    default:
      return false;
  }
}

// --- Effective latency encumbrance (§28.11/§28.12, EC-7) -------------------

/**
 * A DERIVED, read-time value -- never a stored, mutated field.
 * `reservedLatencyMs` itself is never rewritten. Computed by joining one
 * checkpoint against the authoritative `DeliberationState.outcomes`, so the
 * reservation-to-`spent` handoff needs no second write and has no race
 * window (§28.12).
 */
export function effectiveLatencyEncumbrance(
  checkpoint: RouteExecutionCheckpoint,
  deliberationState: DeliberationState
): number {
  if (checkpoint.phase === 'OUTCOME_COMMITTED') return 0;
  if (checkpoint.phase === 'CLAIMED') return checkpoint.reservedLatencyMs;
  if (isPreCallFailedCheckpoint(checkpoint)) return 0;
  const reserved = checkpoint as ReservedTerminalFactReadyCheckpoint;
  const matches = deliberationState.outcomes.filter((o) => o.attemptId === reserved.attemptId);
  if (matches.length !== 1) return reserved.reservedLatencyMs;
  let projected: ReservedTerminalFact;
  try {
    projected = projectRouteOutcomeToTerminalFact(matches[0]);
  } catch {
    return reserved.reservedLatencyMs;
  }
  // Residual reduction applies ONLY on exact agreement -- a disagreeing but
  // otherwise-plausible outcome leaves the FULL reservation encumbered
  // (§28.11). A DEADLINE_VIOLATION never agrees with any projection, so it
  // stays permanently full, exactly as §28.14 requires.
  if (!terminalFactsExactlyAgree(projected, reserved.terminalFact)) return reserved.reservedLatencyMs;
  return reserved.reservedLatencyMs - reserved.terminalFact.actualLatencyMs;
}

/** `SUM(effectiveLatencyEncumbrance)` over every checkpoint of one `deliberationStateId`. */
export function totalEffectiveLatencyEncumbrance(
  store: RouteExecutionCheckpointStore,
  deliberationState: DeliberationState
): number {
  return store
    .listCheckpointsForDeliberationState(deliberationState.id)
    .reduce((sum, checkpoint) => sum + effectiveLatencyEncumbrance(checkpoint, deliberationState), 0);
}

function assertGlobalLatencyIntegrity(
  store: RouteExecutionCheckpointStore,
  deliberationState: DeliberationState,
  label: string
): void {
  const encumbrance = totalEffectiveLatencyEncumbrance(store, deliberationState);
  const total = deliberationState.latencyBudget.spent + encumbrance;
  if (total > deliberationState.latencyBudget.ceiling) {
    throw new Error(
      `${label}: global latency integrity violated -- spent(${deliberationState.latencyBudget.spent}) + effectiveEncumbrance(${encumbrance}) = ${total} exceeds ceiling(${deliberationState.latencyBudget.ceiling})`
    );
  }
}

function hasUnresolvedDeadlineViolation(store: RouteExecutionCheckpointStore, deliberationStateId: string): boolean {
  return store
    .listCheckpointsForDeliberationState(deliberationStateId)
    .some((c) => c.phase === 'TERMINAL_FACT_READY' && (c as ReservedTerminalFactReadyCheckpoint).terminalFact.kind === 'DEADLINE_VIOLATION');
}

// --- State coordination transaction (§28.34.4) ----------------------------

/**
 * The frozen §28.34.4 transaction: (1) acquire coordination for
 * `deliberationStateId`; (2) resolve the CURRENT authoritative state AFTER
 * acquiring it, never before; (3) run `operation` against that current value;
 * (4) commit any new state BEFORE releasing; (5) release; (6) return.
 *
 * No caller-supplied/caller-captured `DeliberationState` may serve as the
 * accounting snapshot once the boundary is entered (EC-27).
 */
export function withCurrentDeliberationState<T>(
  store: RouteExecutionCheckpointStore,
  deliberationStateAccessPort: DeliberationStateAccessPort,
  deliberationStateId: string,
  operation: (currentState: DeliberationState) => { nextState?: DeliberationState; result: T }
): T {
  return store.withDeliberationStateCoordination(deliberationStateId, () => {
    const currentState = deliberationStateAccessPort.resolveCurrentDeliberationState(deliberationStateId);
    if (currentState.id !== deliberationStateId) {
      throw new Error(
        `withCurrentDeliberationState: access port returned DeliberationState ${currentState.id}, not ${deliberationStateId}`
      );
    }
    const { nextState, result } = operation(currentState);
    if (nextState !== undefined) {
      deliberationStateAccessPort.commitDeliberationState(nextState);
    }
    return result;
  });
}

// --- Shared precondition helpers ------------------------------------------

function resolveExactAttempt(deliberationState: DeliberationState, attemptId: string, label: string): RouteAttempt {
  const matches = deliberationState.attempts.filter((a) => a.attemptId === attemptId);
  if (matches.length !== 1) {
    throw new Error(`${label}: attemptId ${attemptId} does not resolve to exactly one RouteAttempt in the current DeliberationState`);
  }
  return matches[0];
}

function assertMachineExecutableRoute(route: NonStopDeliberationRoute, label: string): void {
  if (!MACHINE_EXECUTABLE_ROUTES.includes(route)) {
    throw new Error(
      `${label}: route ${route} is not machine-executable -- the external execution envelope covers ADD_REVIEWER/REPLICATE/SEEK_EVIDENCE/TARGETED_PEER_CHALLENGE only (§27.3)`
    );
  }
}

/**
 * Re-runs the applicable ALREADY-ACCEPTED route readiness for a claim, from
 * the current authoritative state -- never trusting that an earlier
 * planning/attempt-start gate is still satisfied. Claiming execution for an
 * attempt whose outcome could never legally be recorded is exactly what this
 * refuses to authorize.
 */
function assertClaimRouteReadiness(session: StressTestSession, currentState: DeliberationState, attempt: RouteAttempt): void {
  const decision = validateAttemptProvenanceForOutcome(session, currentState, attempt);
  if (!isQuestionCurrent(currentState, attempt.questionId)) {
    throw new Error(`claimRouteExecution: question ${attempt.questionId} is not current`);
  }
  const active = getActiveRouteDecisionsForQuestion(currentState, attempt.questionId);
  if (active.length !== 1 || active[0].id !== decision.id) {
    throw new Error(
      `claimRouteExecution: question ${attempt.questionId} has no single active deliberation cycle matching the attempt's RouteDecision`
    );
  }
  if (attempt.route === 'SEEK_EVIDENCE') {
    assertSeekEvidenceSubjectReady(session, currentState, attempt.questionId);
  } else if (attempt.route === 'TARGETED_PEER_CHALLENGE') {
    assertTargetedPeerChallengeReady(session, currentState, attempt.questionId);
  }
}

function assertLiveExecutionPolicyDecisionShape(decision: LiveExecutionPolicyDecision, label: string): void {
  if (decision === null || typeof decision !== 'object') {
    throw new Error(`${label} must return an object`);
  }
  if (decision.status === 'DISABLED') {
    assertExactKeys(decision, ['status'], label);
    return;
  }
  if (decision.status !== 'ENABLED') {
    throw new Error(`${label}: invalid LiveExecutionPolicyDecision status ${JSON.stringify((decision as { status: unknown }).status)}`);
  }
  assertExactKeys(decision, ['status', 'latencyLimitMs'], label);
}

function buildPreCallFailedCheckpoint(
  attempt: RouteAttempt,
  deliberationStateId: string,
  failure: FailureInfo
): PreCallFailedTerminalFactReadyCheckpoint {
  // claimedAt === terminalFactReadyAt: no time was spent attempting a call,
  // and no latency is ever fabricated (§28.8/§28.13).
  const at = nowIso();
  return {
    phase: 'TERMINAL_FACT_READY',
    attemptId: attempt.attemptId,
    deliberationStateId,
    route: attempt.route,
    claimedAt: at,
    reservedLatencyMs: 0,
    terminalFactReadyAt: at,
    terminalFact: { kind: 'FAILED', actualLatencyMs: 0, failure: cloneFailureInfo(failure) },
  };
}

// --- claimRouteExecution (§28.7-§28.10, §28.17, §28.18) -------------------

/**
 * The atomic ownership claim AND latency admission/reservation, as ONE
 * coordination transaction (§28.7). No provider-call-authorized
 * `ClaimedCheckpoint` is ever returned unless its reservation already
 * succeeded in that same transaction (EC-8).
 *
 * Returns a `PreCallFailedTerminalFactReadyCheckpoint` -- a successful return
 * value, not an error -- for each of the three checkpoint-producing admission
 * causes (§28.9). THROWS, creating no checkpoint of any kind, when the
 * resolved live-execution policy is `DISABLED` (§28.32): "never authorized to
 * be attempted" is categorically distinct from "authorized but not admissible
 * this time".
 *
 * Calls no provider. Selects no model. Generates no prompt.
 */
export function claimRouteExecution(
  session: StressTestSession,
  deliberationState: DeliberationState,
  store: RouteExecutionCheckpointStore,
  deliberationStateAccessPort: DeliberationStateAccessPort,
  liveExecutionPolicyResolver: LiveExecutionPolicyResolver,
  input: { attemptId: string }
): ClaimedCheckpoint | PreCallFailedTerminalFactReadyCheckpoint {
  if (input === null || typeof input !== 'object') {
    throw new Error('claimRouteExecution: input must be an object');
  }
  // `{ attemptId }` ONLY -- a caller may never restate route, state id,
  // hashes, latencyLimitMs, reservedLatencyMs, claimedAt, an authorization
  // flag, spent, or remaining budget (§28.18/EC-20).
  assertExactKeys(input, ['attemptId'], 'claimRouteExecution');
  assertNonEmptyString(input.attemptId, 'claimRouteExecution: attemptId');

  // (1) The caller's own state identifies the intended state and verifies the
  // caller's binding expectation -- it is never the accounting authority.
  verifyDeliberationBinding(session, deliberationState);
  const deliberationStateId = deliberationState.id;

  // (2)-(15) all run inside the state coordination boundary, against the
  // CURRENT authoritative state resolved in there (EC-26/EC-27).
  return withCurrentDeliberationState<ClaimedCheckpoint | PreCallFailedTerminalFactReadyCheckpoint>(
    store,
    deliberationStateAccessPort,
    deliberationStateId,
    (currentState) => {
    verifyDeliberationBinding(session, currentState);
    const attempt = resolveExactAttempt(currentState, input.attemptId, 'claimRouteExecution');
    assertMachineExecutableRoute(attempt.route, 'claimRouteExecution');
    if (currentState.outcomes.some((o) => o.attemptId === input.attemptId)) {
      throw new Error(`claimRouteExecution: attempt ${input.attemptId} already has a RouteOutcome; execution is already terminalized`);
    }
    if (store.getCheckpoint(input.attemptId) !== undefined) {
      throw new Error(`claimRouteExecution: attempt ${input.attemptId} already has an execution checkpoint; a claim is not repeatable`);
    }
    if (currentState.stopReason !== null) {
      throw new Error('claimRouteExecution: deliberation has already stopped; no further execution may be claimed');
    }
    assertClaimRouteReadiness(session, currentState, attempt);

    const policy = liveExecutionPolicyResolver.resolveLiveExecutionPolicy(attempt);
    assertLiveExecutionPolicyDecisionShape(policy, 'claimRouteExecution: liveExecutionPolicyResolver');
    if (policy.status === 'DISABLED') {
      // No checkpoint of any kind -- fail closed (§28.32, EC-20).
      throw new Error(
        `claimRouteExecution: live execution is DISABLED for route ${attempt.route}; no execution checkpoint is created and no provider call is authorized`
      );
    }

    // Cause 3 first: an unreconciled deadline-contract violation on this state
    // blocks every further claim, even one the budget would otherwise admit
    // (§28.14/EC-17).
    if (hasUnresolvedDeadlineViolation(store, deliberationStateId)) {
      return {
        result: store.insertCheckpointIfAbsent(
          buildPreCallFailedCheckpoint(attempt, deliberationStateId, {
            category: 'EXECUTION',
            message: `claimRouteExecution: DeliberationState ${deliberationStateId} has an unresolved DEADLINE_VIOLATION checkpoint; further provider-backed claims are blocked until it is separately reconciled`,
          })
        ) as PreCallFailedTerminalFactReadyCheckpoint,
      };
    }

    // Cause 1: the policy-derived limit is itself missing/malformed. The raw
    // value is never stored and no replacement is ever fabricated (EC-16).
    const limit = policy.latencyLimitMs;
    if (typeof limit !== 'number' || !Number.isFinite(limit) || !Number.isInteger(limit) || limit <= 0) {
      return {
        result: store.insertCheckpointIfAbsent(
          buildPreCallFailedCheckpoint(attempt, deliberationStateId, {
            category: 'EXECUTION',
            message: 'claimRouteExecution: live execution policy returned a missing or malformed latencyLimitMs; no reservation is possible',
          })
        ) as PreCallFailedTerminalFactReadyCheckpoint,
      };
    }

    // Cause 2: structurally valid, but the state has no remaining reservable
    // latency. Remaining is computed from CURRENT spent and CURRENT effective
    // encumbrance, inside the boundary (§28.11/EC-7).
    const remaining =
      currentState.latencyBudget.ceiling - currentState.latencyBudget.spent - totalEffectiveLatencyEncumbrance(store, currentState);
    if (limit > remaining) {
      return {
        result: store.insertCheckpointIfAbsent(
          buildPreCallFailedCheckpoint(attempt, deliberationStateId, {
            category: 'EXECUTION',
            message: `claimRouteExecution: requested latency envelope exceeds the remaining reservable latency for DeliberationState ${deliberationStateId}`,
          })
        ) as PreCallFailedTerminalFactReadyCheckpoint,
      };
    }

    const claimed: ClaimedCheckpoint = {
      phase: 'CLAIMED',
      attemptId: attempt.attemptId,
      deliberationStateId,
      route: attempt.route,
      claimedAt: nowIso(),
      latencyLimitMs: limit,
      reservedLatencyMs: limit,
    };
    return { result: store.insertCheckpointIfAbsent(claimed) as ClaimedCheckpoint };
    }
  );
}

// --- recordExecutionPreCallFailure (§28.33) -------------------------------

/**
 * The determinate PRE-call failure path -- principally a `REFERENCE_RESOLUTION`
 * failure `claimRouteExecution`'s own admission logic never detects (§28.33,
 * EC-21). Follows the frozen 13-step sequence, in which EVERY terminality
 * precondition reads the CURRENT authoritative state resolved inside
 * coordination, never the caller's own possibly-stale snapshot (EC-29).
 *
 * `failure.category` is restricted to `REFERENCE_RESOLUTION` or `EXECUTION`:
 * `TRANSPORT` cannot exist before any transport channel was engaged, and
 * `VALIDATION` cannot exist before any external response was received
 * (§28.33's restricted allowlist). Calls no provider.
 */
export function recordExecutionPreCallFailure(
  session: StressTestSession,
  deliberationState: DeliberationState,
  store: RouteExecutionCheckpointStore,
  deliberationStateAccessPort: DeliberationStateAccessPort,
  liveExecutionPolicyResolver: LiveExecutionPolicyResolver,
  input: { attemptId: string; failure: FailureInfo }
): PreCallFailedTerminalFactReadyCheckpoint {
  if (input === null || typeof input !== 'object') {
    throw new Error('recordExecutionPreCallFailure: input must be an object');
  }
  assertExactKeys(input, ['attemptId', 'failure'], 'recordExecutionPreCallFailure');
  assertNonEmptyString(input.attemptId, 'recordExecutionPreCallFailure: attemptId');

  // (1) caller state identifies only.
  verifyDeliberationBinding(session, deliberationState);
  const deliberationStateId = deliberationState.id;

  // (2) acquire coordination; (3) resolve CURRENT state inside it.
  return withCurrentDeliberationState(store, deliberationStateAccessPort, deliberationStateId, (currentState) => {
    verifyDeliberationBinding(session, currentState); // (4)
    const attempt = resolveExactAttempt(currentState, input.attemptId, 'recordExecutionPreCallFailure'); // (5)
    if (currentState.outcomes.some((o) => o.attemptId === input.attemptId)) {
      // (6) -- the stale-snapshot bypass this step exists to close (EC-29).
      throw new Error(
        `recordExecutionPreCallFailure: attempt ${input.attemptId} already has a RouteOutcome in the current DeliberationState; a pre-call fact may not be recorded for an already-terminalized attempt`
      );
    }
    if (store.getCheckpoint(input.attemptId) !== undefined) {
      throw new Error(`recordExecutionPreCallFailure: attempt ${input.attemptId} already has an execution checkpoint`); // (7)
    }
    if (currentState.stopReason !== null) {
      throw new Error('recordExecutionPreCallFailure: deliberation has already stopped');
    }
    assertMachineExecutableRoute(attempt.route, 'recordExecutionPreCallFailure'); // (8)

    const policy = liveExecutionPolicyResolver.resolveLiveExecutionPolicy(attempt); // (9)
    assertLiveExecutionPolicyDecisionShape(policy, 'recordExecutionPreCallFailure: liveExecutionPolicyResolver');
    if (policy.status === 'DISABLED') {
      // (10) -- mirrors claimRouteExecution exactly; no checkpoint created.
      throw new Error(
        `recordExecutionPreCallFailure: live execution is DISABLED for route ${attempt.route}; no execution checkpoint is created`
      );
    }
    // Note (§28.33): a pre-call failure requires ENABLED but never requires a
    // reservable latencyLimitMs -- no provider call will ever occur for this
    // checkpoint, so reservedLatencyMs is 0 unconditionally. A genuine
    // REFERENCE_RESOLUTION failure is causally prior to a merely-malformed
    // policy latency configuration and is recorded as such (§27.9's
    // precedence, unchanged) -- which is why the limit is not inspected here.

    // (11) category scope.
    assertValidFailureInfo(input.failure, 'recordExecutionPreCallFailure: failure');
    if (input.failure.category !== 'REFERENCE_RESOLUTION' && input.failure.category !== 'EXECUTION') {
      throw new Error(
        `recordExecutionPreCallFailure: failure.category ${input.failure.category} is not a legal pre-call cause -- only REFERENCE_RESOLUTION or EXECUTION (no transport was engaged and no external response exists before a call)`
      );
    }

    // (12) atomic create; (13) release on return.
    return {
      result: store.insertCheckpointIfAbsent(
        buildPreCallFailedCheckpoint(attempt, deliberationStateId, input.failure)
      ) as PreCallFailedTerminalFactReadyCheckpoint,
    };
  });
}

// --- recordExecutionTerminalFact (§28.13/§28.14/§28.18) -------------------

/**
 * Records an ALREADY-OBTAINED terminal fact for a `CLAIMED` checkpoint. Takes
 * only the store: it mutates no `DeliberationState` and therefore enters no
 * state coordination boundary (§28.17's exact surface).
 *
 * `actualLatencyMs` is supplied EXACTLY ONCE, at the top level -- `result`
 * carries no latency field, so there is no second value to disagree with
 * (EC-18). `DEADLINE_VIOLATION` is derived here, never submitted: derivation
 * strictly precedes normal classification, so a `SUCCEEDED`/`INCONCLUSIVE`/
 * `FAILED` submission whose measured latency overran the authorized envelope
 * is stored as `DEADLINE_VIOLATION`, and the overrun is never clamped or
 * hidden (§28.14).
 */
export function recordExecutionTerminalFact(
  store: RouteExecutionCheckpointStore,
  input: { attemptId: string; actualLatencyMs: number; result: ExecutionTerminalResultInput }
): ReservedTerminalFactReadyCheckpoint {
  if (input === null || typeof input !== 'object') {
    throw new Error('recordExecutionTerminalFact: input must be an object');
  }
  assertExactKeys(input, ['attemptId', 'actualLatencyMs', 'result'], 'recordExecutionTerminalFact');
  assertNonEmptyString(input.attemptId, 'recordExecutionTerminalFact: attemptId');

  // (1) resolve the exact, authoritative ClaimedCheckpoint.
  const existing = store.getCheckpoint(input.attemptId);
  if (existing === undefined) {
    throw new Error(`recordExecutionTerminalFact: no execution checkpoint exists for attempt ${input.attemptId}`);
  }
  if (existing.phase !== 'CLAIMED') {
    throw new Error(
      `recordExecutionTerminalFact: checkpoint for attempt ${input.attemptId} is in phase ${existing.phase}; a terminal fact may only be recorded from CLAIMED`
    );
  }
  const claimed = existing;

  // (2) structural validation of the single supplied latency value --
  // malformed input is rejected outright, never stored, never substituted.
  assertFiniteNonNegativeInteger(input.actualLatencyMs, 'recordExecutionTerminalFact: actualLatencyMs');

  const result = input.result;
  if (result === null || typeof result !== 'object') {
    throw new Error('recordExecutionTerminalFact: result must be an object');
  }
  // A caller cannot even structurally express DEADLINE_VIOLATION: it is not a
  // member of ExecutionTerminalResultInput, so it fails this same kind check.
  if (result.kind === 'FAILED') {
    assertExactKeys(result, ['kind', 'failure'], 'recordExecutionTerminalFact: result');
  } else if (result.kind === 'SUCCEEDED' || result.kind === 'INCONCLUSIVE') {
    assertExactKeys(result, ['kind', 'payload'], 'recordExecutionTerminalFact: result');
  } else {
    throw new Error(
      `recordExecutionTerminalFact: result.kind ${JSON.stringify((result as { kind: unknown }).kind)} is not a legal ExecutionTerminalResultInput kind (SUCCEEDED, INCONCLUSIVE, FAILED) -- DEADLINE_VIOLATION is always derived, never submitted`
    );
  }

  // (3)/(4) derive the deadline violation BEFORE any normal classification.
  let terminalFact: ReservedTerminalFact;
  if (input.actualLatencyMs > claimed.latencyLimitMs) {
    terminalFact = { kind: 'DEADLINE_VIOLATION', actualLatencyMs: input.actualLatencyMs };
  } else {
    // (5) only now is the caller's result trusted to classify.
    if (result.kind === 'FAILED') {
      assertValidFailureInfo(result.failure, 'recordExecutionTerminalFact: result.failure');
      terminalFact = { kind: 'FAILED', actualLatencyMs: input.actualLatencyMs, failure: cloneFailureInfo(result.failure) };
    } else if (result.kind === 'INCONCLUSIVE') {
      // Route is re-resolved from the checkpoint, never from caller intent
      // (§28.13/EC-19) -- mirrors recordRouteOutcome's own guard exactly.
      if (claimed.route !== 'SEEK_EVIDENCE') {
        throw new Error(
          `recordExecutionTerminalFact: INCONCLUSIVE is not representable for route ${claimed.route} -- only SEEK_EVIDENCE supports an indeterminate evidence result`
        );
      }
      assertSeekEvidenceInconclusivePayload(result.payload, 'recordExecutionTerminalFact: result.payload');
      terminalFact = {
        kind: 'INCONCLUSIVE',
        actualLatencyMs: input.actualLatencyMs,
        payload: cloneSeekEvidenceInconclusivePayload(result.payload),
      };
    } else {
      assertRouteSpecificSuccessPayload(claimed.route, result.payload, 'recordExecutionTerminalFact: result.payload');
      terminalFact = {
        kind: 'SUCCEEDED',
        actualLatencyMs: input.actualLatencyMs,
        payload: cloneRouteSpecificSuccessPayload(result.payload),
      };
    }
    // EC-9, re-asserted defensively: a normal terminal fact never exceeds its
    // own reservation. A violation is representable only as
    // DEADLINE_VIOLATION, never silently clamped into a normal fact.
    if (input.actualLatencyMs > claimed.reservedLatencyMs) {
      throw new Error(
        `recordExecutionTerminalFact: actualLatencyMs ${input.actualLatencyMs} exceeds reservedLatencyMs ${claimed.reservedLatencyMs} for a normal terminal fact`
      );
    }
  }

  const next: ReservedTerminalFactReadyCheckpoint = {
    phase: 'TERMINAL_FACT_READY',
    attemptId: claimed.attemptId,
    deliberationStateId: claimed.deliberationStateId,
    route: claimed.route,
    claimedAt: claimed.claimedAt,
    latencyLimitMs: claimed.latencyLimitMs,
    reservedLatencyMs: claimed.reservedLatencyMs,
    terminalFactReadyAt: nowIso(),
    terminalFact,
  };
  return store.replaceCheckpointPhase(claimed.attemptId, 'CLAIMED', next) as ReservedTerminalFactReadyCheckpoint;
}

// --- persistExecutionTerminalFactAsRouteOutcome (§28.35) ------------------

function deriveRecordRouteOutcomeInput(
  attemptId: string,
  terminalFact: ReservedTerminalFact,
  label: string
): RecordRouteOutcomeInput {
  if (terminalFact.kind === 'DEADLINE_VIOLATION') {
    throw new Error(`${label}: a DEADLINE_VIOLATION terminal fact is permanently non-committable; no RouteOutcome may be derived from it`);
  }
  const base = { attemptId, latencyConsumed: terminalFact.actualLatencyMs };
  if (terminalFact.kind === 'FAILED') {
    return { ...base, status: 'FAILED', failure: cloneFailureInfo(terminalFact.failure) };
  }
  if (terminalFact.kind === 'INCONCLUSIVE') {
    return {
      ...base,
      status: 'INCONCLUSIVE',
      result: 'INCONCLUSIVE',
      evidenceSubjectId: terminalFact.payload.evidenceSubjectId,
      citations: cloneEvidenceCitations(terminalFact.payload.citations),
    };
  }
  // A purely mechanical reassembly: RouteSpecificSuccessPayload was already
  // frozen as an exact subset of RecordRouteOutcomeInput (§28.13), so this is
  // a spread, never a normalization step.
  return { ...base, status: 'SUCCEEDED', ...cloneRouteSpecificSuccessPayload(terminalFact.payload) } as RecordRouteOutcomeInput;
}

/**
 * The ONLY legal path to a new `RouteOutcome` for an `attemptId` that owns an
 * execution checkpoint (§28.35/§28.36, EC-23/EC-30). Replays the STORED
 * terminal fact exactly -- a caller supplies `{ attemptId }` and nothing else,
 * so no status, latency, payload, failure, citation, ref, excerpt, or response
 * can be retyped into a "close enough" but unequal value.
 *
 * Calls the canonical, unmodified `recordRouteOutcome` (never a copy of its
 * validators) against the CURRENT state resolved inside coordination, and
 * commits the result before releasing (§28.35's 10-step sequence).
 *
 * On product-persistence failure it commits nothing and leaves the checkpoint
 * at `TERMINAL_FACT_READY` with its reservation and terminal fact intact,
 * available for a later persistence-only reconciliation attempt (§27.11).
 * There is no automatic reconciliation loop and no provider replay.
 */
export function persistExecutionTerminalFactAsRouteOutcome(
  session: StressTestSession,
  deliberationState: DeliberationState,
  store: RouteExecutionCheckpointStore,
  deliberationStateAccessPort: DeliberationStateAccessPort,
  input: { attemptId: string }
): DeliberationState {
  if (input === null || typeof input !== 'object') {
    throw new Error('persistExecutionTerminalFactAsRouteOutcome: input must be an object');
  }
  assertExactKeys(input, ['attemptId'], 'persistExecutionTerminalFactAsRouteOutcome');
  assertNonEmptyString(input.attemptId, 'persistExecutionTerminalFactAsRouteOutcome: attemptId');

  // (1) identity lookup -- the checkpoint's parent binding is fixed once set
  // and is not itself subject to concurrent mutation (§28.4).
  const checkpoint = store.getCheckpoint(input.attemptId);
  if (checkpoint === undefined) {
    throw new Error(`persistExecutionTerminalFactAsRouteOutcome: no execution checkpoint exists for attempt ${input.attemptId}`);
  }
  if (deliberationState.id !== checkpoint.deliberationStateId) {
    throw new Error(
      `persistExecutionTerminalFactAsRouteOutcome: caller DeliberationState ${deliberationState.id} does not own checkpoint for attempt ${input.attemptId}`
    );
  }
  verifyDeliberationBinding(session, deliberationState);

  // (2)/(3) coordinate, then resolve CURRENT state inside the boundary.
  return withCurrentDeliberationState(store, deliberationStateAccessPort, checkpoint.deliberationStateId, (currentState) => {
    verifyDeliberationBinding(session, currentState);
    // (4) re-resolve the checkpoint -- defends against a concurrent second
    // commit attempt between the identity lookup and the boundary.
    const live = store.getCheckpoint(input.attemptId);
    if (live === undefined || live.phase !== 'TERMINAL_FACT_READY') {
      throw new Error(
        `persistExecutionTerminalFactAsRouteOutcome: checkpoint for attempt ${input.attemptId} is not in TERMINAL_FACT_READY`
      );
    }
    const terminalFact = (live as ReservedTerminalFactReadyCheckpoint).terminalFact;
    // (5) derive the exact input from the stored fact (rejects DEADLINE_VIOLATION).
    const outcomeInput = deriveRecordRouteOutcomeInput(input.attemptId, terminalFact, 'persistExecutionTerminalFactAsRouteOutcome');
    // (6) canonical, unmodified product validator. (7) no provider call, ever.
    const nextState = recordRouteOutcome(session, currentState, outcomeInput);
    // (8) commit before releasing; (9) return.
    return { nextState, result: nextState };
  });
}

// --- markExecutionOutcomeCommitted (§28.19) -------------------------------

/**
 * Acknowledges that the authoritative `RouteOutcome` for this checkpoint's
 * terminal fact now exists and EXACTLY agrees with it (§28.19). No
 * adjacency-only trust: "an outcome exists somewhere" is never sufficient.
 * Retains `terminalFact` on the committed checkpoint -- compaction is not
 * authorized (§28.15/EC-24).
 */
export function markExecutionOutcomeCommitted(
  session: StressTestSession,
  deliberationState: DeliberationState,
  store: RouteExecutionCheckpointStore,
  deliberationStateAccessPort: DeliberationStateAccessPort,
  input: { attemptId: string }
): OutcomeCommittedCheckpoint {
  if (input === null || typeof input !== 'object') {
    throw new Error('markExecutionOutcomeCommitted: input must be an object');
  }
  assertExactKeys(input, ['attemptId'], 'markExecutionOutcomeCommitted');
  assertNonEmptyString(input.attemptId, 'markExecutionOutcomeCommitted: attemptId');

  const checkpoint = store.getCheckpoint(input.attemptId);
  if (checkpoint === undefined) {
    throw new Error(`markExecutionOutcomeCommitted: no execution checkpoint exists for attempt ${input.attemptId}`);
  }
  if (deliberationState.id !== checkpoint.deliberationStateId) {
    throw new Error(
      `markExecutionOutcomeCommitted: caller DeliberationState ${deliberationState.id} does not own checkpoint for attempt ${input.attemptId}`
    );
  }
  verifyDeliberationBinding(session, deliberationState);

  return withCurrentDeliberationState(store, deliberationStateAccessPort, checkpoint.deliberationStateId, (currentState) => {
    verifyDeliberationBinding(session, currentState);
    const live = store.getCheckpoint(input.attemptId);
    if (live === undefined || live.phase !== 'TERMINAL_FACT_READY') {
      throw new Error(
        `markExecutionOutcomeCommitted: checkpoint for attempt ${input.attemptId} is not in TERMINAL_FACT_READY; OUTCOME_COMMITTED is terminal and a second acknowledgement is rejected`
      );
    }
    const tfr = live as ReservedTerminalFactReadyCheckpoint;
    if (tfr.terminalFact.kind === 'DEADLINE_VIOLATION') {
      throw new Error(
        `markExecutionOutcomeCommitted: attempt ${input.attemptId} recorded a DEADLINE_VIOLATION; it is permanently non-committable (§28.14)`
      );
    }
    // (2) exactly one authoritative RouteOutcome, in the CURRENT state.
    const matches = currentState.outcomes.filter((o) => o.attemptId === input.attemptId);
    if (matches.length !== 1) {
      throw new Error(
        `markExecutionOutcomeCommitted: attempt ${input.attemptId} does not resolve to exactly one RouteOutcome in the current DeliberationState`
      );
    }
    // (3)/(4) exact agreement, via the ONE shared projection boundary --
    // this is what detects a self-consistently altered RouteOutcome that
    // timestamps alone could never reveal.
    const projected = projectRouteOutcomeToTerminalFact(matches[0]);
    if (!terminalFactsExactlyAgree(projected, tfr.terminalFact)) {
      throw new Error(
        `markExecutionOutcomeCommitted: the authoritative RouteOutcome for attempt ${input.attemptId} does not exactly agree with the checkpointed terminal fact`
      );
    }
    // (5) parent/route binding still valid against the authoritative attempt.
    const attempt = resolveExactAttempt(currentState, input.attemptId, 'markExecutionOutcomeCommitted');
    if (attempt.route !== tfr.route || matches[0].route !== tfr.route) {
      throw new Error(`markExecutionOutcomeCommitted: checkpoint route ${tfr.route} disagrees with the authoritative RouteAttempt/RouteOutcome`);
    }
    assertGlobalLatencyIntegrity(store, currentState, 'markExecutionOutcomeCommitted');

    const committed: OutcomeCommittedCheckpoint = {
      phase: 'OUTCOME_COMMITTED',
      attemptId: tfr.attemptId,
      deliberationStateId: tfr.deliberationStateId,
      route: tfr.route,
      claimedAt: tfr.claimedAt,
      terminalFactReadyAt: tfr.terminalFactReadyAt,
      outcomeCommittedAt: nowIso(),
      terminalFact: cloneReservedTerminalFact(tfr.terminalFact),
    };
    return {
      result: store.replaceCheckpointPhase(tfr.attemptId, 'TERMINAL_FACT_READY', committed) as OutcomeCommittedCheckpoint,
    };
  });
}

// --- performCoordinatedLatencyWrite (§28.34.5/§28.36.4) -------------------

/**
 * The coordinated wrapper for every NEW latency-consuming write that is NOT
 * checkpoint-backed replay -- `recordRouteOutcome`'s `ADD_CONTEXT`
 * `SUPPLIED`/`DECLINED` and generic-`FAILED` branches, and
 * `closeContextRequestWithoutResponse`'s `NO_RESPONSE` closure.
 *
 * Enters coordination UNCONDITIONALLY (EC-26): the question "is effective
 * encumbrance currently positive?" is answered only INSIDE the boundary,
 * never as a pre-boundary gate used to decide whether to enter it -- that
 * pre-check is itself racy across the zero-to-positive transition.
 *
 * Rejects outright if any checkpoint exists for `attemptId`, regardless of its
 * phase, `reservedLatencyMs`, or `effectiveLatencyEncumbrance` (§28.36) -- an
 * identity/authority gate, not a budget gate. Zero reservation never restores
 * an uncheckpointed write path (EC-30).
 *
 * The canonical product validators are called unmodified and are never made to
 * inspect checkpoint state themselves (§28.34.8/EC-25). No automatic retry.
 */
export function performCoordinatedLatencyWrite(
  store: RouteExecutionCheckpointStore,
  deliberationStateAccessPort: DeliberationStateAccessPort,
  deliberationStateId: string,
  attemptId: string,
  operation: (currentState: DeliberationState) => DeliberationState
): DeliberationState {
  assertNonEmptyString(deliberationStateId, 'performCoordinatedLatencyWrite: deliberationStateId');
  assertNonEmptyString(attemptId, 'performCoordinatedLatencyWrite: attemptId');
  if (typeof operation !== 'function') {
    throw new Error('performCoordinatedLatencyWrite: operation must be a function');
  }
  return withCurrentDeliberationState(store, deliberationStateAccessPort, deliberationStateId, (currentState) => {
    if (store.getCheckpoint(attemptId) !== undefined) {
      throw new Error(
        `performCoordinatedLatencyWrite: attempt ${attemptId} already owns an execution checkpoint; the only legal path to a new RouteOutcome for it is persistExecutionTerminalFactAsRouteOutcome (§28.36)`
      );
    }
    const encumbrance = totalEffectiveLatencyEncumbrance(store, currentState);
    if (encumbrance > 0) {
      throw new Error(
        `performCoordinatedLatencyWrite: DeliberationState ${deliberationStateId} currently holds ${encumbrance}ms of active effective latency encumbrance; this uncheckpointed write is deferred rather than permitted to bypass the reservation`
      );
    }
    const nextState = operation(currentState);
    if (nextState === null || typeof nextState !== 'object' || nextState.id !== deliberationStateId) {
      throw new Error('performCoordinatedLatencyWrite: operation must return a DeliberationState for the same deliberationStateId');
    }
    return { nextState, result: nextState };
  });
}

// --- assertRouteExecutionCheckpointIntegrity (§28.20) ---------------------

const CLAIMED_KEYS = ['phase', 'attemptId', 'deliberationStateId', 'route', 'claimedAt', 'latencyLimitMs', 'reservedLatencyMs'] as const;
const RESERVED_TFR_KEYS = [...CLAIMED_KEYS, 'terminalFactReadyAt', 'terminalFact'] as const;
const PRE_CALL_TFR_KEYS = [
  'phase',
  'attemptId',
  'deliberationStateId',
  'route',
  'claimedAt',
  'reservedLatencyMs',
  'terminalFactReadyAt',
  'terminalFact',
] as const;
const COMMITTED_KEYS = [
  'phase',
  'attemptId',
  'deliberationStateId',
  'route',
  'claimedAt',
  'terminalFactReadyAt',
  'outcomeCommittedAt',
  'terminalFact',
] as const;

function assertTerminalFactShape(
  fact: ReservedTerminalFact,
  route: NonStopDeliberationRoute,
  label: string
): void {
  if (fact === null || typeof fact !== 'object') {
    throw new Error(`${label} must be an object`);
  }
  switch (fact.kind) {
    case 'DEADLINE_VIOLATION':
      assertExactKeys(fact, ['kind', 'actualLatencyMs'], label);
      assertFiniteNonNegativeInteger(fact.actualLatencyMs, `${label}.actualLatencyMs`);
      return;
    case 'FAILED':
      assertExactKeys(fact, ['kind', 'actualLatencyMs', 'failure'], label);
      assertFiniteNonNegativeInteger(fact.actualLatencyMs, `${label}.actualLatencyMs`);
      assertValidFailureInfo(fact.failure, `${label}.failure`);
      return;
    case 'INCONCLUSIVE':
      assertExactKeys(fact, ['kind', 'actualLatencyMs', 'payload'], label);
      assertFiniteNonNegativeInteger(fact.actualLatencyMs, `${label}.actualLatencyMs`);
      if (route !== 'SEEK_EVIDENCE') {
        throw new Error(`${label}: INCONCLUSIVE is legal only for route SEEK_EVIDENCE (got ${route})`);
      }
      assertSeekEvidenceInconclusivePayload(fact.payload, `${label}.payload`);
      return;
    case 'SUCCEEDED':
      assertExactKeys(fact, ['kind', 'actualLatencyMs', 'payload'], label);
      assertFiniteNonNegativeInteger(fact.actualLatencyMs, `${label}.actualLatencyMs`);
      assertRouteSpecificSuccessPayload(route, fact.payload, `${label}.payload`);
      return;
    default:
      throw new Error(`${label}: invalid terminal fact kind ${JSON.stringify((fact as { kind: unknown }).kind)}`);
  }
}

function assertOneCheckpointIntegrity(
  session: StressTestSession,
  deliberationState: DeliberationState,
  checkpoint: RouteExecutionCheckpoint,
  label: string
): void {
  if (checkpoint === null || typeof checkpoint !== 'object') {
    throw new Error(`${label}: checkpoint must be an object`);
  }
  assertNonEmptyString(checkpoint.attemptId, `${label}: attemptId`);
  if (checkpoint.deliberationStateId !== deliberationState.id) {
    throw new Error(
      `${label}: checkpoint for attempt ${checkpoint.attemptId} is bound to DeliberationState ${checkpoint.deliberationStateId}, not ${deliberationState.id}`
    );
  }
  // Never trust checkpoint self-consistency: the attempt must resolve
  // exactly, against the authoritative ledger, and route must agree -- a
  // self-consistent forged child checkpoint fails here (§28.4/EC-4).
  const attempt = resolveExactAttempt(deliberationState, checkpoint.attemptId, label);
  if (attempt.route !== checkpoint.route) {
    throw new Error(
      `${label}: checkpoint route ${checkpoint.route} disagrees with the authoritative RouteAttempt.route ${attempt.route}`
    );
  }
  assertNonEmptyString(checkpoint.claimedAt, `${label}: claimedAt`);
  if (Number.isNaN(Date.parse(checkpoint.claimedAt))) {
    throw new Error(`${label}: claimedAt is not a parseable timestamp`);
  }

  if (checkpoint.phase === 'CLAIMED') {
    assertExactKeys(checkpoint, CLAIMED_KEYS, label);
    assertFinitePositiveInteger(checkpoint.latencyLimitMs, `${label}: latencyLimitMs`);
    assertFinitePositiveInteger(checkpoint.reservedLatencyMs, `${label}: reservedLatencyMs`);
    if (checkpoint.reservedLatencyMs !== checkpoint.latencyLimitMs) {
      throw new Error(`${label}: reservedLatencyMs must equal latencyLimitMs for a CLAIMED checkpoint`);
    }
    return;
  }

  if (checkpoint.phase === 'TERMINAL_FACT_READY') {
    assertNonEmptyString(checkpoint.terminalFactReadyAt, `${label}: terminalFactReadyAt`);
    if (Date.parse(checkpoint.claimedAt) > Date.parse(checkpoint.terminalFactReadyAt)) {
      throw new Error(`${label}: claimedAt must be <= terminalFactReadyAt`);
    }
    if (isPreCallFailedCheckpoint(checkpoint)) {
      assertExactKeys(checkpoint, PRE_CALL_TFR_KEYS, label);
      if (checkpoint.reservedLatencyMs !== 0) {
        throw new Error(`${label}: a pre-call-failed checkpoint must carry reservedLatencyMs === 0`);
      }
      if (checkpoint.terminalFactReadyAt !== checkpoint.claimedAt) {
        throw new Error(`${label}: a pre-call-failed checkpoint must carry terminalFactReadyAt === claimedAt (no time was spent attempting a call)`);
      }
      if (checkpoint.terminalFact.kind !== 'FAILED' || checkpoint.terminalFact.actualLatencyMs !== 0) {
        throw new Error(`${label}: a pre-call-failed checkpoint's terminal fact must be FAILED with actualLatencyMs === 0`);
      }
      assertValidFailureInfo(checkpoint.terminalFact.failure, `${label}: terminalFact.failure`);
      return;
    }
    const reserved = checkpoint as ReservedTerminalFactReadyCheckpoint;
    assertExactKeys(reserved, RESERVED_TFR_KEYS, label);
    assertFinitePositiveInteger(reserved.latencyLimitMs, `${label}: latencyLimitMs`);
    assertFinitePositiveInteger(reserved.reservedLatencyMs, `${label}: reservedLatencyMs`);
    if (reserved.reservedLatencyMs !== reserved.latencyLimitMs) {
      throw new Error(`${label}: reservedLatencyMs must equal latencyLimitMs`);
    }
    assertTerminalFactShape(reserved.terminalFact, reserved.route, `${label}: terminalFact`);
    if (reserved.terminalFact.kind === 'DEADLINE_VIOLATION') {
      if (reserved.terminalFact.actualLatencyMs <= reserved.latencyLimitMs) {
        throw new Error(`${label}: a DEADLINE_VIOLATION terminal fact must carry actualLatencyMs > latencyLimitMs`);
      }
      if (deliberationState.outcomes.some((o) => o.attemptId === reserved.attemptId)) {
        throw new Error(`${label}: a DEADLINE_VIOLATION attempt must never have a RouteOutcome (§28.14)`);
      }
    } else if (reserved.terminalFact.actualLatencyMs > reserved.reservedLatencyMs) {
      throw new Error(`${label}: actualLatencyMs exceeds reservedLatencyMs for a normal terminal fact (EC-9)`);
    }
    return;
  }

  if (checkpoint.phase === 'OUTCOME_COMMITTED') {
    assertExactKeys(checkpoint, COMMITTED_KEYS, label);
    assertNonEmptyString(checkpoint.terminalFactReadyAt, `${label}: terminalFactReadyAt`);
    assertNonEmptyString(checkpoint.outcomeCommittedAt, `${label}: outcomeCommittedAt`);
    if (
      Date.parse(checkpoint.claimedAt) > Date.parse(checkpoint.terminalFactReadyAt) ||
      Date.parse(checkpoint.terminalFactReadyAt) > Date.parse(checkpoint.outcomeCommittedAt)
    ) {
      throw new Error(`${label}: claimedAt <= terminalFactReadyAt <= outcomeCommittedAt must hold`);
    }
    // terminalFact retention is REQUIRED -- a compacted checkpoint produced
    // under this contract is rejected here (§28.15/EC-24).
    assertTerminalFactShape(checkpoint.terminalFact, checkpoint.route, `${label}: terminalFact`);
    if (checkpoint.terminalFact.kind === 'DEADLINE_VIOLATION') {
      throw new Error(`${label}: a DEADLINE_VIOLATION checkpoint may never reach OUTCOME_COMMITTED (§28.14)`);
    }
    const matches = deliberationState.outcomes.filter((o) => o.attemptId === checkpoint.attemptId);
    if (matches.length !== 1) {
      throw new Error(`${label}: an OUTCOME_COMMITTED checkpoint requires exactly one authoritative RouteOutcome`);
    }
    const projected = projectRouteOutcomeToTerminalFact(matches[0]);
    if (!terminalFactsExactlyAgree(projected, checkpoint.terminalFact)) {
      throw new Error(
        `${label}: the authoritative RouteOutcome for attempt ${checkpoint.attemptId} no longer exactly agrees with the retained terminal fact`
      );
    }
    if (matches[0].latencyConsumed !== checkpoint.terminalFact.actualLatencyMs) {
      throw new Error(`${label}: RouteOutcome.latencyConsumed disagrees with terminalFact.actualLatencyMs`);
    }
    return;
  }

  throw new Error(`${label}: invalid checkpoint phase ${JSON.stringify((checkpoint as { phase: unknown }).phase)}`);
}

/**
 * Global-before-local read integrity (§28.20). A PURE validator of the
 * `deliberationState` snapshot it is given -- it does not resolve "the latest
 * live state" and takes no `DeliberationStateAccessPort` dependency (§28.20's
 * fifth-amendment scope clarification). A caller needing integrity checked
 * against current live state resolves that state through the coordination
 * boundary first and passes the result in.
 *
 * The global reservation invariant is ALWAYS evaluated across every sibling
 * checkpoint of the state, even when `attemptId` narrows the per-checkpoint
 * shape checks: a single locally-well-formed checkpoint is not trustworthy in
 * isolation if its siblings' combined effective encumbrance overruns the
 * ceiling.
 */
export function assertRouteExecutionCheckpointIntegrity(
  session: StressTestSession,
  deliberationState: DeliberationState,
  store: RouteExecutionCheckpointStore,
  attemptId?: string
): void {
  verifyDeliberationBinding(session, deliberationState);
  const label = 'assertRouteExecutionCheckpointIntegrity';
  const siblings = store.listCheckpointsForDeliberationState(deliberationState.id);

  // Global first.
  assertGlobalLatencyIntegrity(store, deliberationState, label);

  const seen = new Set<string>();
  for (const sibling of siblings) {
    if (seen.has(sibling.attemptId)) {
      throw new Error(`${label}: more than one checkpoint exists for attempt ${sibling.attemptId} (EC-3)`);
    }
    seen.add(sibling.attemptId);
  }

  if (attemptId !== undefined) {
    assertNonEmptyString(attemptId, `${label}: attemptId`);
    const checkpoint = store.getCheckpoint(attemptId);
    if (checkpoint === undefined) {
      throw new Error(`${label}: no execution checkpoint exists for attempt ${attemptId}`);
    }
    assertOneCheckpointIntegrity(session, deliberationState, checkpoint, label);
    return;
  }
  for (const sibling of siblings) {
    assertOneCheckpointIntegrity(session, deliberationState, sibling, label);
  }
}

// --- Deterministic offline reference implementations ----------------------
// In-memory, single-process, synchronous. Proves the coordination CONTRACT
// only -- never database durability, cross-process atomicity, distributed
// locking, or crash-safe production persistence (§28.23).

export function createInMemoryRouteExecutionCheckpointStore(): RouteExecutionCheckpointStore {
  const checkpoints = new Map<string, RouteExecutionCheckpoint>();
  const held = new Set<string>();
  return {
    getCheckpoint(attemptId: string): RouteExecutionCheckpoint | undefined {
      return checkpoints.get(attemptId);
    },
    listCheckpointsForDeliberationState(deliberationStateId: string): RouteExecutionCheckpoint[] {
      return [...checkpoints.values()].filter((c) => c.deliberationStateId === deliberationStateId);
    },
    insertCheckpointIfAbsent(checkpoint: RouteExecutionCheckpoint): RouteExecutionCheckpoint {
      if (checkpoints.has(checkpoint.attemptId)) {
        throw new Error(
          `RouteExecutionCheckpointStore: a checkpoint already exists for attempt ${checkpoint.attemptId}; insert-if-absent is atomic and never overwrites (EC-3/EC-6)`
        );
      }
      checkpoints.set(checkpoint.attemptId, checkpoint);
      return checkpoint;
    },
    replaceCheckpointPhase(
      attemptId: string,
      expectedPhase: RouteExecutionCheckpoint['phase'],
      next: RouteExecutionCheckpoint
    ): RouteExecutionCheckpoint {
      const existing = checkpoints.get(attemptId);
      if (existing === undefined) {
        throw new Error(`RouteExecutionCheckpointStore: no checkpoint exists for attempt ${attemptId}`);
      }
      if (existing.phase !== expectedPhase) {
        throw new Error(
          `RouteExecutionCheckpointStore: checkpoint for attempt ${attemptId} is in phase ${existing.phase}, not the expected ${expectedPhase}`
        );
      }
      if (next.attemptId !== attemptId || next.deliberationStateId !== existing.deliberationStateId || next.route !== existing.route) {
        throw new Error(
          `RouteExecutionCheckpointStore: a phase transition may never change a checkpoint's attemptId, parent binding, or route`
        );
      }
      checkpoints.set(attemptId, next);
      return next;
    },
    withDeliberationStateCoordination<T>(deliberationStateId: string, operation: () => T): T {
      // Deterministic single-process ownership. Re-entry is a programming
      // error, not a supported nesting pattern -- fail closed rather than
      // silently permit an inner operation to act on a half-built state.
      if (held.has(deliberationStateId)) {
        throw new Error(
          `RouteExecutionCheckpointStore: state coordination for ${deliberationStateId} is already held by an enclosing operation; coordinated operations are never nested`
        );
      }
      held.add(deliberationStateId);
      try {
        return operation();
      } finally {
        held.delete(deliberationStateId);
      }
    },
  };
}

export function createInMemoryDeliberationStateAccessPort(
  initialState: DeliberationState
): DeliberationStateAccessPort & { current(): DeliberationState } {
  let state = initialState;
  return {
    resolveCurrentDeliberationState(deliberationStateId: string): DeliberationState {
      if (state.id !== deliberationStateId) {
        throw new Error(`DeliberationStateAccessPort: no DeliberationState ${deliberationStateId} is known to this port`);
      }
      return state;
    },
    commitDeliberationState(nextState: DeliberationState): void {
      if (nextState === null || typeof nextState !== 'object' || nextState.id !== state.id) {
        throw new Error('DeliberationStateAccessPort: a committed DeliberationState must carry the same id');
      }
      state = nextState;
    },
    current(): DeliberationState {
      return state;
    },
  };
}

/**
 * A fixed policy for tests/composition. Carries no provider or model name --
 * live-execution authority and provider selection are separate concerns, and
 * selection remains OPEN (§28.29).
 */
export function createStaticLiveExecutionPolicyResolver(
  decide: LiveExecutionPolicyDecision | ((attempt: RouteAttempt) => LiveExecutionPolicyDecision)
): LiveExecutionPolicyResolver {
  return {
    resolveLiveExecutionPolicy(attempt: RouteAttempt): LiveExecutionPolicyDecision {
      return typeof decide === 'function' ? decide(attempt) : decide;
    },
  };
}
