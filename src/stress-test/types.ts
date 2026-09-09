/**
 * Domain types for the Pre-Submission Stress Test MVP.
 *
 * Core product promise: "Before you send this artifact, know which parts you
 * cannot defend." This module defines the data shapes for one review
 * session — intake, author context, findings, semantic issues, human
 * adjudication, revision actions, and the decision record — without any
 * live model execution. See PRE_SUBMISSION_STRESS_TEST_MVP.md for the
 * product-level rationale and what this slice deliberately omits.
 */

/** Where an AuthorContext item's text came from. */
export type AuthorContextSourceType = 'ARTIFACT' | 'AUTHOR' | 'EXTERNAL_SOURCE';

/**
 * An AUTHOR-sourced item is the author's own claim about what they know —
 * never treated as independently verified merely because it was recorded.
 * Only ARTIFACT items are backed by the submitted text itself.
 */
export type AuthorContextItemStatus = 'OPEN' | 'RESOLVED';

export interface AuthorContextItem {
  id: string;
  text: string;
  sourceType: AuthorContextSourceType;
  status: AuthorContextItemStatus;
  createdAt: string;
}

/**
 * What the author already knows, split by kind, distinct from what the
 * submitted artifact itself says. A fact recorded here as AUTHOR is not
 * upgraded to verified just because the author stated it — evidenceState on
 * a ReviewFinding is the only place "supported" is asserted, and only
 * against the artifact.
 */
export interface AuthorContext {
  confirmedFacts: AuthorContextItem[];
  knownRisks: AuthorContextItem[];
  openQuestions: AuthorContextItem[];
  constraints: AuthorContextItem[];
}

export function emptyAuthorContext(): AuthorContext {
  return { confirmedFacts: [], knownRisks: [], openQuestions: [], constraints: [] };
}

/** Support for a claim, measured only against the supplied material — never "true"/"false". */
export type EvidenceState =
  | 'SUPPORTED_IN_MATERIAL'
  | 'PARTIALLY_SUPPORTED'
  | 'UNSUPPORTED_IN_MATERIAL'
  | 'NOT_APPLICABLE';

export type FindingType = 'CLAIM' | 'ASSUMPTION' | 'AMBIGUITY' | 'EXECUTION_RISK';

/**
 * One reviewer-produced observation. Deliberately carries no final
 * materiality judgment — that is a human decision, recorded separately in
 * HumanAdjudication. `reviewerRunId` identifies which review pass produced
 * it (a live model call in a later slice, or a manually authored fixture
 * value in this one) without asserting anything about reviewer identity
 * beyond that grouping.
 */
export interface ReviewFinding {
  id: string;
  reviewerRunId: string;
  type: FindingType;
  title: string;
  artifactLocation: string;
  evidenceState: EvidenceState;
  whyMaterial: string;
  likelyRecipientChallenge: string;
  minimumBeforeSendAction: string;
  rawText?: string;
  createdAt: string;
}

export type SemanticIssueStatus = 'OPEN' | 'ADJUDICATED';

/**
 * Multiple finding occurrences that describe the same underlying
 * vulnerability, without claiming those occurrences were identical.
 * `findingIds` is provenance, not a merge — the original findings are never
 * deleted or mutated once clustered.
 */
export interface SemanticIssue {
  id: string;
  title: string;
  description: string;
  findingIds: string[];
  evidenceState: EvidenceState;
  status: SemanticIssueStatus;
}

export type Judgment = 'KNOWN_PRE_DISPATCH' | 'NEW_NON_MATERIAL' | 'NEW_MATERIAL' | 'WRONG';
export type ActionChange = 'YES' | 'NO';

/**
 * A human decision, kept structurally separate from reviewer output.
 * Targets exactly one of a semantic issue or a single finding — never both,
 * never neither. Adjudicating at the semantic-issue level is the normal
 * path; occurrence-level provenance survives via the issue's own
 * `findingIds`, so it does not need a second adjudication per finding.
 */
export interface HumanAdjudication {
  id: string;
  semanticIssueId?: string;
  findingId?: string;
  judgment: Judgment;
  actionChange: ActionChange;
  note: string;
  adjudicatedAt: string;
}

export type RevisionActionStatus = 'PLANNED' | 'IMPLEMENTED' | 'REJECTED';

/**
 * An explicit, separately tracked action against the artifact. A review
 * finding — even one judged NEW_MATERIAL with actionChange=YES — does not
 * automatically equal an artifact edit; this record is what makes an
 * intended change distinguishable from an implemented one.
 */
export interface RevisionAction {
  id: string;
  sourceIssueIds: string[];
  description: string;
  targetLocation: string;
  status: RevisionActionStatus;
  createdAt: string;
}

export type SessionState =
  | 'DRAFT'
  | 'INPUT_FROZEN'
  | 'REVIEWED'
  | 'ADJUDICATED'
  | 'REVISION_PLANNED'
  | 'COMPLETED';

/**
 * One Pre-Submission Stress Test session. Functions in session.ts return a
 * new session value rather than mutating this one in place — see
 * freezeInput's contract for why silent post-freeze mutation is refused
 * rather than merely discouraged.
 */
export interface StressTestSession {
  id: string;
  state: SessionState;
  createdAt: string;
  artifactText: string;
  authorContext: AuthorContext;
  frozenAt: string | null;
  artifactHash: string | null;
  authorContextHash: string | null;
  findings: Record<string, ReviewFinding>;
  semanticIssues: Record<string, SemanticIssue>;
  adjudications: Record<string, HumanAdjudication>;
  revisionActions: Record<string, RevisionAction>;
}
