import type {
  ActionChange,
  Judgment,
  RevisionActionStatus,
  StressTestSession,
} from './types.js';
import { verifyFrozenInputIntegrity } from './session.js';
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
import { isQuestionCurrent, validateRouteInputRef, verifyDeliberationBinding } from './deliberation.js';

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
    const finding = session.findings[findingId];
    const revisionActions = revisionActionsForFinding(findingId);
    standaloneFindingAdjudications.push({
      findingId,
      findingTitle: finding ? finding.title : '(finding missing)',
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

/** A finished revision, presented without claiming artifact-content verification exists. */
export interface IntegratedDecisionReportRevisionAction {
  id: string;
  description: string;
  targetLocation: string;
  status: RevisionActionStatus;
  /** Human-readable status label. IMPLEMENTED is labeled "marked implemented" — never "verified in final artifact" (§14). */
  statusLabel: string;
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
  resolvedQuestions: number;
  evidenceSupportive: number;
  evidenceContradictory: number;
  evidenceInconclusive: number;
}

export interface IntegratedDecisionReport {
  sessionId: string;
  artifactHash: string;
  generatedAt: string;
  summary: IntegratedDecisionReportSummary;
  issues: IntegratedDecisionReportIssue[];
  unresolvedRisks: IntegratedDecisionReportUnresolvedRisk[];
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
  const subject = deliberationState.evidenceSubjects.find((s) => s.id === outcome.evidenceSubjectId);
  if (!subject) {
    throw new Error(
      `generateIntegratedDecisionReport: SEEK_EVIDENCE outcome for attempt ${outcome.attemptId} references evidenceSubjectId ${outcome.evidenceSubjectId}, which does not resolve to any recorded EvidenceSubject -- provenance is corrupted`
    );
  }
  validateRouteInputRef(session, subject.sourceRef);
  if (!session.findings[subject.originatingFindingId]) {
    throw new Error(
      `generateIntegratedDecisionReport: EvidenceSubject ${subject.id} references originatingFindingId ${subject.originatingFindingId}, which does not resolve to any recorded ReviewFinding -- provenance is corrupted`
    );
  }
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

  const attempt = deliberationState.attempts.find((a) => a.decisionId === decision.id) ?? null;
  let attemptStatus: AttemptStatus | null = null;
  let resultSummary: string | null = null;
  let failure: { category: FailureCategory; message: string } | null = null;
  let evidence: IntegratedDecisionReportEvidencePresentation | null = null;
  let dispositions: IntegratedDecisionReportDisposition[] = [];

  if (attempt) {
    const outcome = deliberationState.outcomes.find((o) => o.attemptId === attempt.attemptId) ?? null;
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
        for (const id of reviewed.findingIds) {
          if (!session.findings[id]) {
            throw new Error(
              `generateIntegratedDecisionReport: ADD_REVIEWER outcome for attempt ${attempt.attemptId} references unknown findingId ${id} -- provenance is corrupted`
            );
          }
        }
        resultSummary = `${reviewed.findingIds.length} finding(s) added via reviewer run ${reviewed.reviewerRunId}`;
      } else if (route === 'REPLICATE') {
        const replicated = outcome as ReplicationRouteOutcome;
        validateRouteInputRef(session, replicated.targetRef);
        resultSummary = replicated.result;
      } else if (route === 'TARGETED_PEER_CHALLENGE') {
        const challenged = outcome as TargetedPeerChallengeRouteOutcome;
        validateRouteInputRef(session, challenged.targetRef);
        validateRouteInputRef(session, challenged.sourceRef);
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
 * existing authoritative identities only (Product Integration P1). Never
 * mutates either input, never introduces a new semantic ledger, and never
 * infers a judgment neither ledger already recorded.
 *
 * Fails closed (throws) if the session/state binding does not hold, or if
 * any reference this projection touches (a RouteInputRef, an
 * evidenceSubjectId, a findingId) does not resolve against the authoritative
 * ledgers it is drawn from -- see this file's own header comment for the
 * exact boundary of what that reuse covers.
 */
export function generateIntegratedDecisionReport(
  session: StressTestSession,
  deliberationState: DeliberationState
): IntegratedDecisionReport {
  verifyDeliberationBinding(session, deliberationState);

  const issues: IntegratedDecisionReportIssue[] = Object.values(session.semanticIssues).map((issue) => {
    const artifactLocations = issue.findingIds.map((findingId) => {
      const finding = session.findings[findingId];
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
      .map((action) => ({
        id: action.id,
        description: action.description,
        targetLocation: action.targetLocation,
        status: action.status,
        statusLabel: labelForRevisionStatus(action.status),
      }));
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
    resolvedQuestions: totalQuestions - unresolvedQuestionsCount,
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
  };
}
