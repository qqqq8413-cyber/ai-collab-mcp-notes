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
 * This module imports only `verifyFrozenInputIntegrity` from session.ts —
 * a read-only check. It never imports `adjudicate`, `planRevisionAction`,
 * `implementRevisionAction`, or `rejectRevisionAction`, so nothing here can
 * create HumanAdjudication authority or RevisionAction: that boundary
 * (HumanAdjudication.actionChange=YES -> RevisionAction) is structurally
 * unreachable from this file, not merely undocumented.
 */
import { randomUUID } from 'node:crypto';
import type { StressTestSession } from './types.js';
import { verifyFrozenInputIntegrity } from './session.js';

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

/** Independent snapshot of an UnresolvedQuestion -- never the caller-owned object, so post-registration mutation of the original cannot alter registry history. */
function cloneUnresolvedQuestion(question: UnresolvedQuestion): UnresolvedQuestion {
  return {
    id: question.id,
    inputRefs: cloneRouteInputRefs(question.inputRefs),
    rootCause: question.rootCause,
    materialityReason: question.materialityReason,
    createdAt: question.createdAt,
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
 * Constructs an UnresolvedQuestion. This slice accepts already-classified
 * routing input (rootCause, materialityReason) and enforces its structure
 * — it does not classify anything itself. Every non-NONE question must
 * carry at least one valid RouteInputRef.
 */
export function createUnresolvedQuestion(
  session: StressTestSession,
  input: { rootCause: RootCauseCategory; materialityReason: string; inputRefs: RouteInputRef[] }
): UnresolvedQuestion {
  assertValidRootCause(input.rootCause, 'createUnresolvedQuestion');
  assertNonEmptyMaterialityReason(input.materialityReason);
  if (input.rootCause !== 'NONE' && input.inputRefs.length === 0) {
    throw new Error('createUnresolvedQuestion: at least one inputRef is required for a non-NONE root cause');
  }
  for (const ref of input.inputRefs) validateRouteInputRef(session, ref);
  return {
    id: randomUUID(),
    inputRefs: [...input.inputRefs],
    rootCause: input.rootCause,
    materialityReason: input.materialityReason,
    createdAt: nowIso(),
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

  const decision = deliberationState.history.find((d) => d.id === decisionId);
  if (!decision) {
    throw new Error(`recordRouteAttemptStart: decisionId ${decisionId} is not a currently recorded RouteDecision`);
  }
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
  artifactHash: string;
  authorContextHash: string;
  sourceRefs: RouteInputRef[];
  category: AuthorContextCategoryName;
  question: string;
  inferenceReason: string;
  createdAt: string;
}

export function createContextRequest(
  session: StressTestSession,
  deliberationState: DeliberationState,
  input: {
    questionId: string;
    category: AuthorContextCategoryName;
    question: string;
    inferenceReason: string;
  }
): ContextRequest {
  verifyDeliberationBinding(session, deliberationState);
  if (deliberationState.stopReason !== null) {
    throw new Error('createContextRequest: deliberation has already stopped; no further ContextRequest may be created');
  }
  assertNonEmptyString(input.questionId, 'createContextRequest: questionId');
  const registered = deliberationState.unresolvedQuestions.find((q) => q.id === input.questionId);
  if (!registered) {
    throw new Error(`createContextRequest: questionId ${input.questionId} is not a currently registered unresolved question`);
  }
  if (registered.rootCause !== 'CONTEXT_GAP') {
    throw new Error(
      `createContextRequest: registered question ${input.questionId} has rootCause ${registered.rootCause}, not CONTEXT_GAP`
    );
  }
  if (registered.inputRefs.length === 0) {
    throw new Error(`createContextRequest: registered question ${input.questionId} has no inputRefs`);
  }
  if (!AUTHOR_CONTEXT_CATEGORIES.includes(input.category)) {
    throw new Error(`createContextRequest: unknown category ${JSON.stringify(input.category)}`);
  }
  assertNonEmptyString(input.question, 'createContextRequest: question');
  assertNonEmptyString(input.inferenceReason, 'createContextRequest: inferenceReason');
  for (const ref of registered.inputRefs) validateRouteInputRef(session, ref);
  if (!session.artifactHash || !session.authorContextHash) {
    throw new Error('createContextRequest: session is missing its frozen artifactHash/authorContextHash');
  }
  return {
    id: randomUUID(),
    originatingSessionId: session.id,
    originatingQuestionId: registered.id,
    artifactHash: session.artifactHash,
    authorContextHash: session.authorContextHash,
    sourceRefs: cloneRouteInputRefs(registered.inputRefs),
    category: input.category,
    question: input.question,
    inferenceReason: input.inferenceReason,
    createdAt: nowIso(),
  };
}
