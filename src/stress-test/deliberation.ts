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

/** The full accepted architecture vocabulary for ADD_CONTEXT's human-response mechanism (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §7.A). `NO_RESPONSE` remains excluded from the recordable subset below -- its terminalization mechanism is a still-open architecture decision (§24). */
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

export type AddContextRouteOutcome = AddContextSuppliedRouteOutcome | AddContextDeclinedRouteOutcome;

/** Slice 2D-C2's complete RouteOutcome vocabulary. SEEK_EVIDENCE/TARGETED_PEER_CHALLENGE successful outcomes, ADD_CONTEXT's NO_RESPONSE result, and any INCONCLUSIVE outcome are not yet representable -- not authorized in this slice. */
export type RouteOutcome = FailedRouteOutcome | AddReviewerRouteOutcome | ReplicationRouteOutcome | AddContextRouteOutcome;

/** The full accepted architecture vocabulary (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §9). `CROSS_SESSION` remains excluded from the recordable subset below -- it needs `ADD_CONTEXT` success + session-lineage runtime, not authorized yet. */
export type QuestionDispositionKind = 'STILL_OPEN' | 'RESOLVED' | 'SUPERSEDED_RECLASSIFIED' | 'CROSS_SESSION';

/** Slice 2D-B2-B's recordable subset. `SUPERSEDED_RECLASSIFIED` was added in Slice 2D-B2-B (`derivedFromQuestionId` on `UnresolvedQuestion`, ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §9 Slice 2D-B2-B0 freeze). `CROSS_SESSION` remains excluded -- needs `ADD_CONTEXT` success + session-lineage runtime, not authorized yet. */
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
 * An injected unsupported disposition (`SUPERSEDED_RECLASSIFIED`,
 * `CROSS_SESSION`, or an unknown string) throws here rather than silently
 * being treated as non-terminal.
 */
/**
 * `STILL_OPEN` is the only non-terminal recordable disposition kind; every
 * other recordable kind (`RESOLVED`, `SUPERSEDED_RECLASSIFIED`) terminates a
 * question's disposition history (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md
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
  // AND per-questionId lifecycle terminality. Only once this passes can step
  // 4 below safely assume every question has at most one terminal
  // disposition (never two, e.g. a tampered RESOLVED + SUPERSEDED_RECLASSIFIED
  // pair for the same parent).
  assertQuestionDispositionLedgerIntegrity(deliberationState);

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
  result?: ReplicationResult | AddContextResult;
  targetRef?: RouteInputRef;
  contextRequestId?: string;
  responseText?: string;
}

/**
 * Records the immutable terminal fact for one already-started `RouteAttempt`
 * — offline audit bookkeeping only; never executes a route, calls a
 * provider, retrieves anything, or contacts a human
 * (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §7, §20).
 *
 * Slice 2D-C2 records five shapes: a generic `FAILED` outcome for any
 * already-started non-STOP attempt, a successful `ADD_REVIEWER` outcome, a
 * successful `REPLICATE` outcome, and successful `ADD_CONTEXT` `SUPPLIED`/
 * `DECLINED` outcomes (each independently re-verified against the complete
 * `ContextRequest` ledger, never trusted from the input alone). `ADD_CONTEXT`
 * `NO_RESPONSE`, `SEEK_EVIDENCE`/`TARGETED_PEER_CHALLENGE` successful
 * outcomes, and any `INCONCLUSIVE` outcome are rejected outright — not yet
 * authorized, regardless of how plausible the supplied payload looks.
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
  if (input.status === 'INCONCLUSIVE') {
    throw new Error('recordRouteOutcome: INCONCLUSIVE is not recordable in Slice 2D-B1');
  }

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
        'recordRouteOutcome: ADD_CONTEXT result NO_RESPONSE is not authorized -- terminalization mechanism is an unresolved open architecture decision'
      );
    }
    if (rawResult === 'SUPPLIED') {
      allowedKeys = ['attemptId', 'status', 'latencyConsumed', 'result', 'contextRequestId', 'responseText'];
    } else if (rawResult === 'DECLINED') {
      allowedKeys = ['attemptId', 'status', 'latencyConsumed', 'result', 'contextRequestId'];
    } else {
      throw new Error(`recordRouteOutcome: invalid or unsupported ADD_CONTEXT result ${JSON.stringify(rawResult)}`);
    }
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
 * branch" below); `CROSS_SESSION` remains rejected outright, not yet
 * authorized.
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

  const matchingAttempts = deliberationState.attempts.filter((a) => a.attemptId === outcome.attemptId);
  if (matchingAttempts.length !== 1) {
    throw new Error(`${label}: attemptId ${attemptId} does not resolve to exactly one RouteAttempt`);
  }
  const attempt = matchingAttempts[0];
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
 * Validates the actual child `StressTestSession` against its
 * `SessionVersionLineage` record -- the dimension the parent-side helper
 * above cannot reach, because Session B is never stored inside
 * `DeliberationState A` (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md
 * §13.A, "Child-side lineage validation boundary," Slice 2D-C3-0
 * amendment). Only meaningful when the caller actually holds the child
 * session object -- exported so it can be invoked wherever that is true,
 * not only inside `createCrossSessionTransition` itself.
 */
export function assertSessionVersionLineageChildIntegrity(
  parentSession: StressTestSession,
  lineage: SessionVersionLineage,
  childSession: StressTestSession,
  suppliedOutcome: AddContextSuppliedRouteOutcome,
  contextRequest: ContextRequest
): void {
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

  // Mandatory: the COMPLETE SessionVersionLineage ledger must be sound, and
  // this exact SUPPLIED outcome must not already have produced one, before
  // any child session is constructed (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md
  // §13.A, decision O; Slice 2D-C3-0 amendment §16).
  assertSessionVersionLineageLedgerIntegrity(parentDeliberationState);
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

  // Child-side validation runs on the actual constructed child before any
  // success return -- the parent-side ledger helper above cannot reach this
  // dimension (ROUTE_OUTCOME_QUESTION_LIFECYCLE_CONTRACT.md §13.A, "Child-side
  // lineage validation boundary," Slice 2D-C3-0 amendment).
  assertSessionVersionLineageChildIntegrity(parentSession, buildLineageSnapshot(), childSession, outcome, contextRequest);

  return {
    session: parentSession,
    deliberationState: {
      ...parentDeliberationState,
      questionDispositions: [...parentDeliberationState.questionDispositions, disposition],
      sessionVersionLineages: [...effectiveSessionVersionLineages(parentDeliberationState), buildLineageSnapshot()],
    },
    childSession,
    lineage: buildLineageSnapshot(),
  };
}
