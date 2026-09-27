import type { RootCauseCategory, RouteInputRef } from '../stress-test/deliberation.js';
import type { AuthorContextItem, ReviewFinding, SemanticIssue } from '../stress-test/types.js';

/**
 * E0-R6 ContextPack: a bounded, detached, immutable, route-scoped view of canonical
 * product state for one execution attempt.
 *
 * What a pack says is only: "this exact context was projected from these exact
 * canonical sources under this exact binding". It does not claim to be complete,
 * semantically correct, evidence of truth, or current; it is current only while
 * `verifyCurrent` says so. It carries no authority: it is not canonical state, a ledger,
 * a verdict, a HumanAdjudication, a RouteOutcome, or a prompt. The canonical session
 * and DeliberationState stay authoritative.
 */

/** V1 covers the two routes E0-R5 consults on. */
export type ContextPackRoute = 'ADD_REVIEWER' | 'REPLICATE';

export type AuthorContextCategory = 'confirmedFacts' | 'knownRisks' | 'openQuestions' | 'constraints';

/** Where the pack came from. Every field is read from canonical state, never from a caller. */
export interface ContextPackBinding {
  deliberationStateId: string;
  sessionId: string;
  artifactHash: string;
  authorContextHash: string;
  attemptId: string;
  decisionId: string;
  questionId: string;
  route: ContextPackRoute;
  /** The question's route refs, in their canonical order. */
  inputRefs: readonly RouteInputRef[];
}

/** The routing context that explains why the route exists. */
export interface ContextPackQuestion {
  rootCause: RootCauseCategory;
  materialityReason: string;
}

/**
 * One canonical record copied exactly, in route-ref order. A SemanticIssue keeps its
 * `findingIds` as recorded; the pack does not merge those findings or claim they agree.
 * An author context item keeps its source type and status as recorded: AUTHOR is not
 * verified, CURRENT is not true.
 */
export type ContextPackSource =
  | { ref: { kind: 'FINDING'; id: string }; value: ReviewFinding }
  | { ref: { kind: 'SEMANTIC_ISSUE'; id: string }; value: SemanticIssue }
  | { ref: { kind: 'AUTHOR_CONTEXT_ITEM'; id: string }; category: AuthorContextCategory; value: AuthorContextItem };

/** An exact slice of the frozen artifact. An excerpt, never the whole artifact. */
export interface ArtifactExcerpt {
  selectionScope: 'EXCERPT';
  startChar: number;
  endChar: number;
  text: string;
}

/** Everything the budget measures and the fingerprint binds. */
export interface ContextPackPayload {
  schemaVersion: 'E0-R6_CONTEXT_PACK_V1';
  binding: ContextPackBinding;
  question: ContextPackQuestion;
  sources: readonly ContextPackSource[];
  artifact?: ArtifactExcerpt;
}

export interface ContextPack extends ContextPackPayload {
  /** SHA-256 of the canonical payload: integrity binding, not authentication. */
  contextFingerprint: string;
  /**
   * When the projection was taken. Observational only: outside the fingerprint, so the
   * same canonical context projected twice has one fingerprint, and never evidence
   * that the pack is current.
   */
  capturedAt: string;
}

/** Owned by composition and snapshotted there; a build caller cannot change it. */
export interface ContextPackPolicy {
  /** Upper bound on the canonical payload's length in UTF-16 code units. */
  maxSerializedChars: number;
}

/** The only things a caller chooses: which attempt, and optionally which artifact span. */
export interface ContextPackSelection {
  attemptId: string;
  artifactSelection?: { startChar: number; endChar: number };
}

export type ContextPackStaleReason =
  | 'DELIBERATION_STOPPED'
  | 'ROUTE_OUTCOME_RECORDED'
  | 'QUESTION_NOT_CURRENT'
  | 'SOURCE_CHANGED';

/**
 * CURRENT: the pack is intact and projecting its selection from current canonical facts
 * gives the same fingerprint. STALE: an intact pack whose facts no longer match. An
 * invalid or tampered pack, or corrupt or ambiguous canonical state, throws instead.
 */
export type ContextPackVerification =
  | { status: 'CURRENT'; contextFingerprint: string }
  | { status: 'STALE'; reason: ContextPackStaleReason; contextFingerprint: string; currentFingerprint?: string };

export interface ContextPackSourcePort {
  build(selection: unknown): ContextPack;
  verifyCurrent(pack: unknown): ContextPackVerification;
}
