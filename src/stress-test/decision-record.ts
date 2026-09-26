import type {
  ActionChange,
  Judgment,
  RevisionAction,
  RevisionActionStatus,
  RevisionSourceRef,
  RevisionVerificationVerdict,
  StressTestSession,
} from './types.js';
import {
  assertRevisionActionLedgerIntegrity,
  assertRevisionSuccessorIntegrity,
  assertSemanticIssueLedgerIntegrity,
  assertRevisionVerificationLedgerIntegrity,
  verifyFrozenInputIntegrity,
} from './session.js';
import { isReviewFindingShape, resolveExactRecord } from './reference.js';
import type {
  AddReviewerRouteOutcome,
  AddContextRouteOutcome,
  AttemptStatus,
  DeliberationState,
  EvidenceCitation,
  FailureCategory,
  NonStopDeliberationRoute,
  QuestionDispositionKind,
  ReplicationRouteOutcome,
  RootCauseCategory,
  RouteDecision,
  RouteInputRef,
  SeekEvidenceRouteOutcome,
  SeekEvidenceSupportiveOrContradictoryRouteOutcome,
  TargetedPeerChallengeRouteOutcome,
} from './deliberation.js';
import {
  assertRouteOutcomeIntegrity,
  isQuestionCurrent,
  validateRouteInputRef,
  verifyDeliberationBinding,
} from './deliberation.js';

export interface DecisionRecordIssueEntry {
  semanticIssueId: string;
  title: string;
  evidenceState: string;
  findingIds: string[];
  judgment: Judgment | null;
  actionChange: ActionChange | null;
  revisionActionIds: string[];
  revisionActionStatuses: RevisionActionStatus[];
}

export interface DecisionRecordFindingAdjudicationEntry {
  findingId: string;
  findingTitle: string;
  judgment: Judgment;
  actionChange: ActionChange;
  revisionActionIds: string[];
  revisionActionStatuses: RevisionActionStatus[];
}

export interface DecisionRecord {
  sessionId: string;
  sessionState: string;
  generatedAt: string;
  artifactHash: string | null;
  authorContextHash: string | null;
  authorKnownSummary: { confirmedFacts: number; knownRisks: number; openQuestions: number; constraints: number };
  openQuestions: string[];
  totalFindings: number;
  totalSemanticIssues: number;
  newMaterialCount: number;
  newNonMaterialCount: number;
  knownPreDispatchCount: number;
  wrongCount: number;
  actionChangeYesCount: number;
  plannedRevisionCount: number;
  implementedRevisionCount: number;
  rejectedRevisionCount: number;
  /** Adjudications targeting a semantic issue (may cluster more than one finding). */
  issues: DecisionRecordIssueEntry[];
  /** Adjudications targeting a bare finding directly, never wrapped in a semantic issue. */
  standaloneFindingAdjudications: DecisionRecordFindingAdjudicationEntry[];
}

/**
 * Pure projection over a session — answers what was reviewed, what the
 * author already knew, what was raised, what was new, what was material,
 * what was meant to change, what actually changed, and what evidence
 * supported each issue. Never mutates the session and never itself judges
 * anything; every field here traces back to a recorded human adjudication
 * or a structural fact about the session.
 *
 * Judgment/actionChange/revision-linked counts are computed across BOTH
 * adjudication targets — semantic issues and bare findings — since human
 * adjudication is explicitly permitted at either level (types.ts,
 * HumanAdjudication). Counting only issue-level adjudications would silently
 * drop any judgment recorded directly on a finding that was never clustered.
 */
export function generateDecisionRecord(session: StressTestSession): DecisionRecord {
  verifyFrozenInputIntegrity(session);
  assertRevisionActionLedgerIntegrity(session);
  const issueAdjudications = new Map<string, { judgment: Judgment; actionChange: ActionChange }>();
  const findingAdjudications = new Map<string, { judgment: Judgment; actionChange: ActionChange }>();
  for (const adjudication of Object.values(session.adjudications)) {
    if (adjudication.semanticIssueId) {
      issueAdjudications.set(adjudication.semanticIssueId, {
        judgment: adjudication.judgment,
        actionChange: adjudication.actionChange,
      });
    } else if (adjudication.findingId) {
      findingAdjudications.set(adjudication.findingId, {
        judgment: adjudication.judgment,
        actionChange: adjudication.actionChange,
      });
    }
  }

  // Matched by BOTH kind and id -- a SemanticIssue and a ReviewFinding could
  // in principle share an id-shaped string, and the discriminator on
  // RevisionSourceRef exists precisely so that case is never ambiguous. Do
  // not collapse this back to matching on `ref.id` alone.
  const revisionActionsForIssue = (semanticIssueId: string) =>
    Object.values(session.revisionActions).filter((action) =>
      action.sourceRefs.some((ref) => ref.kind === 'SEMANTIC_ISSUE' && ref.id === semanticIssueId)
    );

  const revisionActionsForFinding = (findingId: string) =>
    Object.values(session.revisionActions).filter((action) =>
      action.sourceRefs.some((ref) => ref.kind === 'FINDING' && ref.id === findingId)
    );

  const issues: DecisionRecordIssueEntry[] = Object.values(session.semanticIssues).map((issue) => {
    const adjudication = issueAdjudications.get(issue.id) ?? null;
    const revisionActions = revisionActionsForIssue(issue.id);
    return {
      semanticIssueId: issue.id,
      title: issue.title,
      evidenceState: issue.evidenceState,
      findingIds: [...issue.findingIds],
      judgment: adjudication?.judgment ?? null,
      actionChange: adjudication?.actionChange ?? null,
      revisionActionIds: revisionActions.map((a) => a.id),
      revisionActionStatuses: revisionActions.map((a) => a.status),
    };
  });

  const standaloneFindingAdjudications: DecisionRecordFindingAdjudicationEntry[] = [];
  for (const [findingId, adjudication] of findingAdjudications) {
    // The adjudication ledger validated above already resolves every target
    // exactly; the same resolver is used here, and a miss fails closed rather
    // than projecting a placeholder title.
    const finding = resolveExactRecord(session.findings, findingId, isReviewFindingShape);
    if (!finding) {
      throw new Error(`generateDecisionRecord: adjudicated findingId ${findingId} does not exactly resolve to a ReviewFinding`);
    }
    const revisionActions = revisionActionsForFinding(findingId);
    standaloneFindingAdjudications.push({
      findingId,
      findingTitle: finding.title,
      judgment: adjudication.judgment,
      actionChange: adjudication.actionChange,
      revisionActionIds: revisionActions.map((a) => a.id),
      revisionActionStatuses: revisionActions.map((a) => a.status),
    });
  }

  const allJudgments: Judgment[] = [
    ...issues.map((i) => i.judgment).filter((j): j is Judgment => j !== null),
    ...standaloneFindingAdjudications.map((a) => a.judgment),
  ];
  const allActionChanges: ActionChange[] = [
    ...issues.map((i) => i.actionChange).filter((a): a is ActionChange => a !== null),
    ...standaloneFindingAdjudications.map((a) => a.actionChange),
  ];
  const revisionStatuses = Object.values(session.revisionActions).map((a) => a.status);

  return {
    sessionId: session.id,
    sessionState: session.state,
    generatedAt: new Date().toISOString(),
    artifactHash: session.artifactHash,
    authorContextHash: session.authorContextHash,
    authorKnownSummary: {
      confirmedFacts: session.authorContext.confirmedFacts.length,
      knownRisks: session.authorContext.knownRisks.length,
      openQuestions: session.authorContext.openQuestions.length,
      constraints: session.authorContext.constraints.length,
    },
    // Only CURRENT items are "remaining" open questions -- RESOLVED and
    // SUPERSEDED items stay in authorContext for provenance but must not be
    // reported as still outstanding.
    openQuestions: session.authorContext.openQuestions.filter((q) => q.status === 'CURRENT').map((q) => q.text),
    totalFindings: Object.keys(session.findings).length,
    totalSemanticIssues: issues.length,
    newMaterialCount: allJudgments.filter((j) => j === 'NEW_MATERIAL').length,
    newNonMaterialCount: allJudgments.filter((j) => j === 'NEW_NON_MATERIAL').length,
    knownPreDispatchCount: allJudgments.filter((j) => j === 'KNOWN_PRE_DISPATCH').length,
    wrongCount: allJudgments.filter((j) => j === 'WRONG').length,
    actionChangeYesCount: allActionChanges.filter((a) => a === 'YES').length,
    plannedRevisionCount: revisionStatuses.filter((s) => s === 'PLANNED').length,
    implementedRevisionCount: revisionStatuses.filter((s) => s === 'IMPLEMENTED').length,
    rejectedRevisionCount: revisionStatuses.filter((s) => s === 'REJECTED').length,
    issues,
    standaloneFindingAdjudications,
  };
}

/** Markdown rendering of a DecisionRecord — no visual UI, matching this slice's scope. */
export function renderDecisionRecordMarkdown(record: DecisionRecord): string {
  const lines: string[] = [];
  lines.push(`# Decision Record — session ${record.sessionId}`);
  lines.push('');
  lines.push(`Generated: ${record.generatedAt}`);
  lines.push(`Session state: ${record.sessionState}`);
  lines.push(`Artifact hash: ${record.artifactHash ?? '(not frozen)'}`);
  lines.push(`Author context hash: ${record.authorContextHash ?? '(not frozen)'}`);
  lines.push('');
  lines.push('## What the author already knew');
  lines.push('');
  lines.push(`- Confirmed facts: ${record.authorKnownSummary.confirmedFacts}`);
  lines.push(`- Known risks: ${record.authorKnownSummary.knownRisks}`);
  lines.push(`- Open questions: ${record.authorKnownSummary.openQuestions}`);
  lines.push(`- Constraints: ${record.authorKnownSummary.constraints}`);
  if (record.openQuestions.length > 0) {
    lines.push('');
    lines.push('Open questions remaining:');
    for (const q of record.openQuestions) lines.push(`- ${q}`);
  }
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Findings raised: ${record.totalFindings}`);
  lines.push(`- Semantic issues: ${record.totalSemanticIssues}`);
  lines.push(`- NEW_MATERIAL: ${record.newMaterialCount}`);
  lines.push(`- NEW_NON_MATERIAL: ${record.newNonMaterialCount}`);
  lines.push(`- KNOWN_PRE_DISPATCH: ${record.knownPreDispatchCount}`);
  lines.push(`- WRONG: ${record.wrongCount}`);
  lines.push(`- Issues/findings with actionChange=YES: ${record.actionChangeYesCount}`);
  lines.push(`- Revision actions — planned: ${record.plannedRevisionCount}, implemented: ${record.implementedRevisionCount}, rejected: ${record.rejectedRevisionCount}`);
  lines.push('');
  lines.push('## Semantic issues');
  lines.push('');
  if (record.issues.length === 0) lines.push('(none)');
  for (const issue of record.issues) {
    lines.push(`### ${issue.title}`);
    lines.push('');
    lines.push(`- Evidence state: ${issue.evidenceState}`);
    lines.push(`- Occurrences (finding IDs): ${issue.findingIds.join(', ')}`);
    lines.push(`- Judgment: ${issue.judgment ?? 'UNADJUDICATED'}`);
    lines.push(`- Action change: ${issue.actionChange ?? 'n/a'}`);
    lines.push(`- Revision actions: ${issue.revisionActionIds.length === 0 ? 'none' : issue.revisionActionStatuses.join(', ')}`);
    lines.push('');
  }
  lines.push('## Standalone finding adjudications');
  lines.push('');
  if (record.standaloneFindingAdjudications.length === 0) lines.push('(none)');
  for (const entry of record.standaloneFindingAdjudications) {
    lines.push(`### ${entry.findingTitle}`);
    lines.push('');
    lines.push(`- Judgment: ${entry.judgment}`);
    lines.push(`- Action change: ${entry.actionChange}`);
    lines.push(`- Revision actions: ${entry.revisionActionIds.length === 0 ? 'none' : entry.revisionActionStatuses.join(', ')}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ============================================================================
// Integrated Decision Report — Product Integration P1 (read-only projection)
// ============================================================================
//
// Everything below is a JOIN over two already-authoritative ledgers
// (StressTestSession, DeliberationState) — never a new semantic ledger, never
// a new judgment. It mutates neither input. Every join below traces to an
// existing authoritative identity (a RouteInputRef's {kind,id}, a
// findingId/semanticIssueId/attemptId/evidenceSubjectId) — never text/title
// similarity, array position, or "the latest record". Where no authoritative
// chain exists for a dimension, that dimension is represented as null/empty,
// never guessed.
//
// Provenance/integrity reuse: `verifyDeliberationBinding` (session/state hash
// binding), `isQuestionCurrent` (which itself reuses the domain's own
// question-lineage integrity check), and `validateRouteInputRef` (the exact
// function the write paths use to resolve a RouteInputRef) are called on
// every reference this projection presents — never a hand-rolled weaker
// substitute. This does NOT reach the full depth of the write-path's
// route-specific outcome validators (`assertSeekEvidenceOutcomeIntegrity`,
// `assertTargetedPeerChallengeOutcomeIntegrity`), which are not exported from
// deliberation.ts; see this slice's own completion report for the exact
// boundary this leaves open.
//
// Execution-coordination checkpoints (RouteExecutionCheckpoint) are excluded
// entirely — RouteOutcome remains the sole source of terminal result content.

/**
 * The six-state, deterministic verification-presentation vocabulary frozen
 * by P2-C0 (Amendment 1, §11.1) — a pure projection of already-authoritative
 * facts, never a second semantic ledger. Absence of a RevisionVerification
 * is never encoded as INCONCLUSIVE or NOT_PRESENT: it is its own distinct
 * state (AWAITING_SUCCESSOR before a successor exists, NO_VERIFICATION_RECORDED
 * once one does).
 */
export type IntegratedDecisionReportRevisionVerificationState =
  | 'NOT_APPLICABLE'
  | 'AWAITING_SUCCESSOR'
  | 'NO_VERIFICATION_RECORDED'
  | 'VERIFIED_PRESENT'
  | 'NOT_PRESENT'
  | 'INCONCLUSIVE';

/**
 * A finished revision, presented without claiming artifact-content
 * verification exists merely because it was marked implemented --
 * `verificationState`/`verificationVerdict`/`verificationEvidence`/
 * `verifiedAt` carry that separate, human-confirmed fact (P2-C0 §11).
 * `sourceRefs` is a cloned projection of the authoritative
 * `RevisionAction.sourceRefs` (§11.3) -- never the same array/object
 * references as `session.revisionActions[...].sourceRefs`.
 */
export interface IntegratedDecisionReportRevisionAction {
  id: string;
  sourceRefs: RevisionSourceRef[];
  description: string;
  targetLocation: string;
  status: RevisionActionStatus;
  /** Human-readable status label. IMPLEMENTED is labeled "marked implemented" — never "verified in final artifact" (§14). */
  statusLabel: string;
  verificationState: IntegratedDecisionReportRevisionVerificationState;
  /** Verbatim from the stored RevisionVerification when one exists; null for NOT_APPLICABLE/AWAITING_SUCCESSOR/NO_VERIFICATION_RECORDED. */
  verificationVerdict: RevisionVerificationVerdict | null;
  verificationEvidence: string | null;
  verifiedAt: string | null;
  /** Exact P2-C0 §11.2 label for `verificationState` -- never recovered/guessed historical wording. */
  verificationStatusLabel: string;
}

/** What a HumanAdjudication recorded — displayed alongside route evidence, never synthesized from it (§13). */
export interface IntegratedDecisionReportHumanAdjudication {
  judgment: Judgment;
  actionChange: ActionChange;
  note: string;
  adjudicatedAt: string;
}

/** Exactly what an accepted SEEK_EVIDENCE RouteOutcome recorded — the report never independently judges whether a citation supports the claim (§11). */
export interface IntegratedDecisionReportEvidencePresentation {
  evidenceSubjectId: string;
  claimText: string;
  sourceRef: RouteInputRef;
  originatingFindingId: string;
  citations: EvidenceCitation[];
}

/** One QuestionDisposition as recorded — never re-derived or re-labeled. */
export interface IntegratedDecisionReportDisposition {
  disposition: QuestionDispositionKind;
  reason: string;
  createdAt: string;
}

/**
 * One RouteDecision's lifecycle for a question, joined ONLY through its own
 * `decisionId`/`attemptId` — never route-execution-checkpoint state (§12,
 * §18). `resultSummary`/`evidence`/`failure` are populated only once an
 * accepted RouteOutcome exists; `null` before then, never fabricated (§16).
 */
export interface IntegratedDecisionReportRouteCycle {
  routeDecisionId: string;
  route: NonStopDeliberationRoute;
  attemptId: string | null;
  attemptStatus: AttemptStatus | null;
  resultSummary: string | null;
  failure: { category: FailureCategory; message: string } | null;
  evidence: IntegratedDecisionReportEvidencePresentation | null;
  dispositions: IntegratedDecisionReportDisposition[];
}

/** Every RouteDecision cycle an UnresolvedQuestion has gone through — a question may legitimately have zero, one, or several (§16). */
export interface IntegratedDecisionReportQuestionThread {
  unresolvedQuestionId: string;
  rootCause: RootCauseCategory;
  isCurrent: boolean;
  routeCycles: IntegratedDecisionReportRouteCycle[];
}

/**
 * One semantic issue, joined to deliberation ONLY via an UnresolvedQuestion
 * whose own `inputRefs` names this exact `semanticIssueId` (§9) — never via
 * shared finding membership, which is a separate, weaker provenance claim.
 */
export interface IntegratedDecisionReportIssue {
  semanticIssueId: string;
  title: string;
  description: string;
  findingIds: string[];
  /** Derived exclusively via ReviewFinding.artifactLocation for each findingId (§10) — never a second, independent location authority. */
  artifactLocations: string[];
  evidenceState: string;
  humanAdjudication: IntegratedDecisionReportHumanAdjudication | null;
  revisionActions: IntegratedDecisionReportRevisionAction[];
  linkedQuestions: IntegratedDecisionReportQuestionThread[];
}

/**
 * A currently-open (`isQuestionCurrent === true`) question, regardless of
 * whether it is also linked to a semantic issue — this is the deterministic,
 * issue-agnostic "what remains unresolved" view (§15). `semanticIssueId` is
 * populated only when one of the question's own `inputRefs` names one.
 */
export interface IntegratedDecisionReportUnresolvedRisk {
  unresolvedQuestionId: string;
  rootCause: RootCauseCategory;
  sourceRefs: RouteInputRef[];
  semanticIssueId: string | null;
  routeCycles: IntegratedDecisionReportRouteCycle[];
}

/** Deterministic counts only (§7) — no invented risk score, no severity inferred from counts. */
export interface IntegratedDecisionReportSummary {
  reviewFindings: number;
  semanticIssues: number;
  adjudicatedIssues: number;
  actionChangeYes: number;
  revisionActionsPlanned: number;
  revisionActionsImplemented: number;
  unresolvedQuestions: number;
  disposedQuestions: number;
  evidenceSupportive: number;
  evidenceContradictory: number;
  evidenceInconclusive: number;
}

export interface IntegratedDecisionReport {
  /** The SOURCE (V0) session's own id -- never the successor's, see `revisionSuccessor` below. */
  sessionId: string;
  /** The SOURCE (V0) session's frozen artifact hash -- never the successor's (P2-C0 §17). */
  artifactHash: string;
  generatedAt: string;
  summary: IntegratedDecisionReportSummary;
  issues: IntegratedDecisionReportIssue[];
  unresolvedRisks: IntegratedDecisionReportUnresolvedRisk[];
  /** Every session.revisionActions entry, unfiltered by sourceRefs kind (P2-C0 §13) -- closes the FINDING-only coverage gap `issues[].revisionActions` alone cannot. */
  allRevisionActions: IntegratedDecisionReportRevisionAction[];
  /**
   * Null exactly when `session.revisionSuccessor` is null; otherwise the
   * exact validated successor's own identity -- read from the actual
   * `successorSession` object supplied and proven via
   * `assertRevisionSuccessorIntegrity`, never copied from the stored
   * `RevisionSuccessorBinding` alone (P2-C0 §11.4).
   */
  revisionSuccessor: { sessionId: string; artifactHash: string } | null;
}

function labelForRevisionStatus(status: RevisionActionStatus): string {
  switch (status) {
    case 'PLANNED':
      return 'Revision action planned';
    case 'IMPLEMENTED':
      // Deliberately NOT "verified in final artifact" -- revision-content
      // verification does not exist yet (§14, this packet's own instruction).
      return 'Revision action marked implemented';
    case 'REJECTED':
      return 'Revision action rejected';
    default: {
      const exhaustive: never = status;
      throw new Error(`labelForRevisionStatus: invalid RevisionActionStatus ${JSON.stringify(exhaustive)}`);
    }
  }
}

function cloneRouteInputRefShallow(ref: RouteInputRef): RouteInputRef {
  return { kind: ref.kind, id: ref.id } as RouteInputRef;
}

/** Report-local clone -- never the same object as `session.revisionActions[...].sourceRefs[i]` (P2-C0 §12 egress isolation). */
function cloneRevisionSourceRefShallow(ref: RevisionSourceRef): RevisionSourceRef {
  return { kind: ref.kind, id: ref.id } as RevisionSourceRef;
}

function labelForRevisionVerificationState(state: IntegratedDecisionReportRevisionVerificationState): string {
  switch (state) {
    case 'NOT_APPLICABLE':
      return 'Verification not applicable';
    case 'AWAITING_SUCCESSOR':
      return 'Awaiting successor artifact';
    case 'NO_VERIFICATION_RECORDED':
      return 'No verification recorded';
    case 'VERIFIED_PRESENT':
      return 'Revision verified in successor artifact';
    case 'NOT_PRESENT':
      return 'Revision not present in successor artifact';
    case 'INCONCLUSIVE':
      return 'Revision verification inconclusive';
    default: {
      const exhaustive: never = state;
      throw new Error(`labelForRevisionVerificationState: invalid state ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * The ONE shared per-`RevisionAction` projection (P2-C0 §15) -- both
 * `allRevisionActions` and `issues[].revisionActions` reuse the exact object
 * this returns, never two independently-written mappings. Callers must have
 * already run the full integrity ordering (assertRevisionActionLedgerIntegrity,
 * and -- whenever `session.revisionSuccessor !== null` --
 * assertRevisionSuccessorIntegrity/assertRevisionVerificationLedgerIntegrity)
 * before calling this; it trusts `session.revisionVerifications` without
 * re-validating it.
 */
function buildRevisionActionPresentation(
  session: StressTestSession,
  action: RevisionAction
): IntegratedDecisionReportRevisionAction {
  const sourceRefs = action.sourceRefs.map(cloneRevisionSourceRefShallow);
  const statusLabel = labelForRevisionStatus(action.status);

  let verificationState: IntegratedDecisionReportRevisionVerificationState;
  let verificationVerdict: RevisionVerificationVerdict | null = null;
  let verificationEvidence: string | null = null;
  let verifiedAt: string | null = null;

  if (action.status === 'PLANNED' || action.status === 'REJECTED') {
    verificationState = 'NOT_APPLICABLE';
  } else if (session.revisionSuccessor === null) {
    verificationState = 'AWAITING_SUCCESSOR';
  } else {
    // Defense-in-depth (P2-C0 §13): the global ledger validator this
    // function's caller already ran makes >1 structurally impossible, but
    // this projection step never relies on that alone -- no bare `.find()`.
    const matches = Object.values(session.revisionVerifications).filter((v) => v.revisionActionId === action.id);
    if (matches.length > 1) {
      throw new Error(
        `generateIntegratedDecisionReport: more than one RevisionVerification references revisionActionId ${action.id}`
      );
    }
    const record = matches[0] ?? null;
    if (!record) {
      verificationState = 'NO_VERIFICATION_RECORDED';
    } else {
      verificationState = record.verdict;
      verificationVerdict = record.verdict;
      verificationEvidence = record.evidence;
      verifiedAt = record.verifiedAt;
    }
  }

  return {
    id: action.id,
    sourceRefs,
    description: action.description,
    targetLocation: action.targetLocation,
    status: action.status,
    statusLabel,
    verificationState,
    verificationVerdict,
    verificationEvidence,
    verifiedAt,
    verificationStatusLabel: labelForRevisionVerificationState(verificationState),
  };
}

/**
 * Reconstructs exactly what an accepted SEEK_EVIDENCE outcome recorded,
 * joined to its EvidenceSubject via `evidenceSubjectId` only. Fails closed if
 * that id does not resolve, or if the subject's own `sourceRef`/
 * `originatingFindingId` no longer resolve -- a real, reused-validator-backed
 * tamper check, not a semantic judgment about the evidence itself.
 */
function buildEvidencePresentation(
  session: StressTestSession,
  deliberationState: DeliberationState,
  outcome: SeekEvidenceRouteOutcome
): IntegratedDecisionReportEvidencePresentation {
  const matchingSubjects = deliberationState.evidenceSubjects.filter((subject) => subject.id === outcome.evidenceSubjectId);
  if (matchingSubjects.length !== 1) {
    throw new Error(
      `generateIntegratedDecisionReport: SEEK_EVIDENCE outcome for attempt ${outcome.attemptId} references evidenceSubjectId ${outcome.evidenceSubjectId}, which does not resolve to exactly one recorded EvidenceSubject`
    );
  }
  const subject = matchingSubjects[0];
  return {
    evidenceSubjectId: subject.id,
    claimText: subject.claimText,
    sourceRef: cloneRouteInputRefShallow(subject.sourceRef),
    originatingFindingId: subject.originatingFindingId,
    citations: outcome.citations.map((c) => ({ sourceIdentifier: c.sourceIdentifier, title: c.title, excerpt: c.excerpt })),
  };
}

/**
 * One RouteDecision's presentation, re-validating every reference it carries
 * (`validateRouteInputRef`, the exact function the write paths use) before
 * trusting it for display. Never reads RouteExecutionCheckpoint state (§18).
 */
function buildRouteCycle(
  session: StressTestSession,
  deliberationState: DeliberationState,
  decision: RouteDecision
): IntegratedDecisionReportRouteCycle {
  if (decision.route === 'STOP') {
    // Unreachable in accepted state: STOP's questionId is always null, so a
    // decision matched to a real question can never be STOP. Fail closed
    // rather than silently mis-typing it, if legacy/tampered state disagrees.
    throw new Error(`generateIntegratedDecisionReport: RouteDecision ${decision.id} is STOP but is bound to a question -- corrupted state`);
  }
  const route: NonStopDeliberationRoute = decision.route;
  for (const ref of decision.inputRefs) validateRouteInputRef(session, ref);

  const matchingAttempts = deliberationState.attempts.filter((attempt) => attempt.decisionId === decision.id);
  if (matchingAttempts.length > 1) {
    throw new Error(`generateIntegratedDecisionReport: RouteDecision ${decision.id} resolves to more than one RouteAttempt`);
  }
  const attempt = matchingAttempts[0] ?? null;
  let attemptStatus: AttemptStatus | null = null;
  let resultSummary: string | null = null;
  let failure: { category: FailureCategory; message: string } | null = null;
  let evidence: IntegratedDecisionReportEvidencePresentation | null = null;
  let dispositions: IntegratedDecisionReportDisposition[] = [];

  if (attempt) {
    const matchingOutcomes = deliberationState.outcomes.filter((outcome) => outcome.attemptId === attempt.attemptId);
    if (matchingOutcomes.length > 1) {
      throw new Error(`generateIntegratedDecisionReport: RouteAttempt ${attempt.attemptId} resolves to more than one RouteOutcome`);
    }
    assertRouteOutcomeIntegrity(session, deliberationState, attempt.attemptId);
    const outcome = matchingOutcomes[0] ?? null;
    if (outcome) {
      attemptStatus = outcome.status;
      if (outcome.status === 'FAILED') {
        failure = { category: outcome.failure.category, message: outcome.failure.message };
      } else if (route === 'SEEK_EVIDENCE') {
        const seek = outcome as SeekEvidenceRouteOutcome;
        resultSummary = seek.result;
        evidence = buildEvidencePresentation(session, deliberationState, seek);
      } else if (route === 'ADD_REVIEWER') {
        const reviewed = outcome as AddReviewerRouteOutcome;
        resultSummary = `${reviewed.findingIds.length} finding(s) added via reviewer run ${reviewed.reviewerRunId}`;
      } else if (route === 'REPLICATE') {
        const replicated = outcome as ReplicationRouteOutcome;
        resultSummary = replicated.result;
      } else if (route === 'TARGETED_PEER_CHALLENGE') {
        const challenged = outcome as TargetedPeerChallengeRouteOutcome;
        resultSummary = challenged.result;
      } else if (route === 'ADD_CONTEXT') {
        resultSummary = (outcome as AddContextRouteOutcome).result;
      }
    }
    dispositions = deliberationState.questionDispositions
      .filter((d) => d.attemptId === attempt.attemptId)
      .map((d) => ({ disposition: d.disposition, reason: d.reason, createdAt: d.createdAt }));
  }

  return {
    routeDecisionId: decision.id,
    route,
    attemptId: attempt ? attempt.attemptId : null,
    attemptStatus,
    resultSummary,
    failure,
    evidence,
    dispositions,
  };
}

function buildQuestionThread(
  session: StressTestSession,
  deliberationState: DeliberationState,
  question: DeliberationState['unresolvedQuestions'][number]
): IntegratedDecisionReportQuestionThread {
  for (const ref of question.inputRefs) validateRouteInputRef(session, ref);
  const isCurrent = isQuestionCurrent(deliberationState, question.id);
  const routeCycles = deliberationState.history
    .filter((d) => d.questionId === question.id)
    .map((d) => buildRouteCycle(session, deliberationState, d));
  return {
    unresolvedQuestionId: question.id,
    rootCause: question.rootCause,
    isCurrent,
    routeCycles,
  };
}

/**
 * Read-only, additive integrated projection over an already-frozen
 * StressTestSession and its DeliberationState — joins the review/adjudication
 * ledger to the deliberation/evidence/execution-outcome ledger through
 * existing authoritative identities only (Product Integration P1), and,
 * since P2-C, the revision-successor/revision-verification ledgers through
 * the exact same canonical P2-A/P2-B validators the domain layer itself
 * uses. Never mutates any input, never introduces a new semantic ledger,
 * and never infers a judgment none of the ledgers already recorded --
 * `verificationVerdict`/`verificationEvidence` are always restated verbatim
 * from a stored, human-confirmed RevisionVerification, never derived by
 * comparing artifact text.
 *
 * `successorSession` is optional at the type level, but conditionally
 * required at runtime whenever "successor authority is in play" --
 * `session.revisionSuccessor !== null`, `session.revisionVerifications` is
 * non-empty, or the caller supplied it at all -- in which case it is always
 * validated unconditionally, never silently ignored (P2-C0 §5/§6).
 *
 * Fails closed (throws) if the session/state binding does not hold, if any
 * reference this projection touches (a RouteInputRef, an evidenceSubjectId,
 * a findingId) does not resolve against the authoritative ledgers it is
 * drawn from, if the RevisionAction/HumanAdjudication ledgers are corrupt,
 * or if successor/verification authority is in play without a validated
 * `successorSession` -- see this file's own header comment for the exact
 * boundary the reused RouteOutcome-side validators cover.
 */
export function generateIntegratedDecisionReport(
  session: StressTestSession,
  deliberationState: DeliberationState,
  successorSession?: StressTestSession
): IntegratedDecisionReport {
  verifyDeliberationBinding(session, deliberationState);
  // Global SemanticIssue integrity before any projection: every issue, whether
  // or not an adjudication, revision action, or question selects it, must be
  // stored under its own id with exactly resolving, non-repeating findingIds.
  assertSemanticIssueLedgerIntegrity(session);
  // Validate historical outcomes even when no detail view traverses them.
  for (const outcome of deliberationState.outcomes) {
    assertRouteOutcomeIntegrity(session, deliberationState, outcome.attemptId);
  }
  // Composes assertHumanAdjudicationLedgerIntegrity transitively -- global
  // RevisionAction/adjudication integrity before any issue/revision/
  // adjudication projection below trusts either ledger. Unconditional: even
  // a source with no successor yet still projects allRevisionActions in the
  // AWAITING_SUCCESSOR state, which must not rest on unvalidated provenance.
  assertRevisionActionLedgerIntegrity(session);

  const successorAuthorityInPlay =
    session.revisionSuccessor !== null ||
    Object.keys(session.revisionVerifications).length > 0 ||
    successorSession !== undefined;
  if (successorAuthorityInPlay && successorSession === undefined) {
    throw new Error(
      'generateIntegratedDecisionReport: successorSession is required -- session.revisionSuccessor exists and/or revisionVerifications is non-empty, but no successorSession was supplied'
    );
  }
  // Validated unconditionally whenever supplied, even if the other two
  // signals are both false -- this is what makes an unrelated/extraneous
  // successor object fail closed rather than being silently ignored.
  if (successorSession !== undefined) {
    assertRevisionSuccessorIntegrity(session, successorSession);
  }
  if (Object.keys(session.revisionVerifications).length > 0) {
    assertRevisionVerificationLedgerIntegrity(session);
  }

  let revisionSuccessor: { sessionId: string; artifactHash: string } | null = null;
  if (session.revisionSuccessor !== null) {
    if (successorSession === undefined || !successorSession.artifactHash) {
      throw new Error(
        'generateIntegratedDecisionReport: internal invariant violated -- session.revisionSuccessor exists but a validated successorSession.artifactHash is missing'
      );
    }
    revisionSuccessor = { sessionId: successorSession.id, artifactHash: successorSession.artifactHash };
  }

  // The ONE shared projection (P2-C0 §15): built once per RevisionAction,
  // then reused (never rebuilt) for both allRevisionActions and every
  // issue's filtered revisionActions below.
  const allRevisionActions: IntegratedDecisionReportRevisionAction[] = Object.values(session.revisionActions).map(
    (action) => buildRevisionActionPresentation(session, action)
  );
  const revisionActionPresentationById = new Map(allRevisionActions.map((presentation) => [presentation.id, presentation]));

  const issues: IntegratedDecisionReportIssue[] = Object.values(session.semanticIssues).map((issue) => {
    const artifactLocations = issue.findingIds.map((findingId) => {
      const finding = resolveExactRecord(session.findings, findingId, isReviewFindingShape);
      if (!finding) {
        throw new Error(
          `generateIntegratedDecisionReport: semantic issue ${issue.id} references findingId ${findingId}, which does not resolve to any recorded ReviewFinding`
        );
      }
      return finding.artifactLocation;
    });
    const adjudication = Object.values(session.adjudications).find((a) => a.semanticIssueId === issue.id) ?? null;
    const revisionActions = Object.values(session.revisionActions)
      .filter((action) => action.sourceRefs.some((ref) => ref.kind === 'SEMANTIC_ISSUE' && ref.id === issue.id))
      .map((action) => {
        const presentation = revisionActionPresentationById.get(action.id);
        if (!presentation) {
          throw new Error(
            `generateIntegratedDecisionReport: internal invariant violated -- no shared projection found for revisionActionId ${action.id}`
          );
        }
        return presentation;
      });
    const linkedQuestions = deliberationState.unresolvedQuestions
      .filter((q) => q.inputRefs.some((ref) => ref.kind === 'SEMANTIC_ISSUE' && ref.id === issue.id))
      .map((q) => buildQuestionThread(session, deliberationState, q));

    return {
      semanticIssueId: issue.id,
      title: issue.title,
      description: issue.description,
      findingIds: [...issue.findingIds],
      artifactLocations,
      evidenceState: issue.evidenceState,
      humanAdjudication: adjudication
        ? { judgment: adjudication.judgment, actionChange: adjudication.actionChange, note: adjudication.note, adjudicatedAt: adjudication.adjudicatedAt }
        : null,
      revisionActions,
      linkedQuestions,
    };
  });

  const unresolvedRisks: IntegratedDecisionReportUnresolvedRisk[] = deliberationState.unresolvedQuestions
    .filter((q) => isQuestionCurrent(deliberationState, q.id))
    .map((q) => {
      for (const ref of q.inputRefs) validateRouteInputRef(session, ref);
      const semanticIssueRef = q.inputRefs.find((ref) => ref.kind === 'SEMANTIC_ISSUE') ?? null;
      const routeCycles = deliberationState.history
        .filter((d) => d.questionId === q.id)
        .map((d) => buildRouteCycle(session, deliberationState, d));
      return {
        unresolvedQuestionId: q.id,
        rootCause: q.rootCause,
        sourceRefs: q.inputRefs.map(cloneRouteInputRefShallow),
        semanticIssueId: semanticIssueRef ? semanticIssueRef.id : null,
        routeCycles,
      };
    });

  const totalQuestions = deliberationState.unresolvedQuestions.length;
  const unresolvedQuestionsCount = deliberationState.unresolvedQuestions.filter((q) => isQuestionCurrent(deliberationState, q.id)).length;

  const allAdjudications = Object.values(session.adjudications);
  const revisionStatuses = Object.values(session.revisionActions).map((a) => a.status);

  const seekEvidenceOutcomes = deliberationState.outcomes.filter(
    (o): o is SeekEvidenceSupportiveOrContradictoryRouteOutcome | SeekEvidenceRouteOutcome =>
      o.route === 'SEEK_EVIDENCE' && (o.status === 'SUCCEEDED' || o.status === 'INCONCLUSIVE')
  );

  const summary: IntegratedDecisionReportSummary = {
    reviewFindings: Object.keys(session.findings).length,
    semanticIssues: Object.keys(session.semanticIssues).length,
    adjudicatedIssues: Object.values(session.semanticIssues).filter((i) => i.status === 'ADJUDICATED').length,
    actionChangeYes: allAdjudications.filter((a) => a.actionChange === 'YES').length,
    revisionActionsPlanned: revisionStatuses.filter((s) => s === 'PLANNED').length,
    revisionActionsImplemented: revisionStatuses.filter((s) => s === 'IMPLEMENTED').length,
    unresolvedQuestions: unresolvedQuestionsCount,
    disposedQuestions: totalQuestions - unresolvedQuestionsCount,
    evidenceSupportive: seekEvidenceOutcomes.filter((o) => o.status === 'SUCCEEDED' && (o as SeekEvidenceSupportiveOrContradictoryRouteOutcome).result === 'SUPPORTIVE').length,
    evidenceContradictory: seekEvidenceOutcomes.filter((o) => o.status === 'SUCCEEDED' && (o as SeekEvidenceSupportiveOrContradictoryRouteOutcome).result === 'CONTRADICTORY').length,
    evidenceInconclusive: seekEvidenceOutcomes.filter((o) => o.status === 'INCONCLUSIVE').length,
  };

  return {
    sessionId: session.id,
    artifactHash: deliberationState.artifactHash,
    generatedAt: new Date().toISOString(),
    summary,
    issues,
    unresolvedRisks,
    allRevisionActions,
    revisionSuccessor,
  };
}
