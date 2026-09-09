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

export type StopReason =
  | 'successful'
  | 'budget'
  | 'latency'
  | 'no_eligible_route'
  | 'unresolved_but_human_decidable'
  | 'failure_fallback';

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

/** "This is the justified next route" — never "the route has executed". */
export interface RouteDecision {
  id: string;
  route: DeliberationRoute;
  reason: RouteReason;
  inputRefs: RouteInputRef[];
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
 * Plans (does not record or execute) a RouteDecision for one already-
 * classified UnresolvedQuestion. Pure and offline — zero provider calls.
 * Deliberately does not rank or select among multiple unresolved
 * questions; autonomous multi-item prioritization is a separate,
 * not-yet-authorized implementation decision (contract §5, §13).
 */
export function planRouteForQuestion(
  session: StressTestSession,
  deliberationState: DeliberationState,
  question: UnresolvedQuestion
): RouteDecision {
  verifyDeliberationBinding(session, deliberationState);
  assertNonEmptyMaterialityReason(question.materialityReason);
  if (question.rootCause !== 'NONE' && question.inputRefs.length === 0) {
    throw new Error('planRouteForQuestion: at least one inputRef is required for a non-NONE root cause');
  }
  for (const ref of question.inputRefs) validateRouteInputRef(session, ref);
  const route = routeForRootCause(question.rootCause);
  return {
    id: randomUUID(),
    route,
    reason: { rootCause: question.rootCause, materialityReason: question.materialityReason },
    inputRefs: [...question.inputRefs],
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
 * requires an explicit StopReason; every other route requires that none be
 * supplied.
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
  const expectedRoute = routeForRootCause(routeDecision.reason.rootCause);
  if (routeDecision.route !== expectedRoute) {
    throw new Error(
      `recordRouteDecision: route ${routeDecision.route} is inconsistent with rootCause ${routeDecision.reason.rootCause} (expected ${expectedRoute})`
    );
  }
  assertNonEmptyMaterialityReason(routeDecision.reason.materialityReason);
  for (const ref of routeDecision.inputRefs) validateRouteInputRef(session, ref);

  let stopReason: StopReason | null = null;
  if (routeDecision.route === 'STOP') {
    if (!options?.stopReason) {
      throw new Error('recordRouteDecision: route STOP requires an explicit stopReason');
    }
    stopReason = options.stopReason;
  } else if (options?.stopReason) {
    throw new Error('recordRouteDecision: stopReason may only be supplied when route is STOP');
  }

  return {
    ...deliberationState,
    history: [...deliberationState.history, routeDecision],
    stopReason,
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
 */
export interface ContextRequest {
  id: string;
  originatingSessionId: string;
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
    reason: RouteReason;
    sourceRefs: RouteInputRef[];
    category: AuthorContextCategoryName;
    question: string;
    inferenceReason: string;
  }
): ContextRequest {
  verifyDeliberationBinding(session, deliberationState);
  if (input.reason.rootCause !== 'CONTEXT_GAP') {
    throw new Error(`createContextRequest: requires rootCause CONTEXT_GAP (got ${input.reason.rootCause})`);
  }
  assertNonEmptyMaterialityReason(input.reason.materialityReason);
  if (!AUTHOR_CONTEXT_CATEGORIES.includes(input.category)) {
    throw new Error(`createContextRequest: unknown category ${JSON.stringify(input.category)}`);
  }
  assertNonEmptyString(input.question, 'createContextRequest: question');
  assertNonEmptyString(input.inferenceReason, 'createContextRequest: inferenceReason');
  for (const ref of input.sourceRefs) validateRouteInputRef(session, ref);
  if (!session.artifactHash || !session.authorContextHash) {
    throw new Error('createContextRequest: session is missing its frozen artifactHash/authorContextHash');
  }
  return {
    id: randomUUID(),
    originatingSessionId: session.id,
    artifactHash: session.artifactHash,
    authorContextHash: session.authorContextHash,
    sourceRefs: [...input.sourceRefs],
    category: input.category,
    question: input.question,
    inferenceReason: input.inferenceReason,
    createdAt: nowIso(),
  };
}
