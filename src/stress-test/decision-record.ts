import type {
  ActionChange,
  Judgment,
  RevisionActionStatus,
  StressTestSession,
} from './types.js';
import { verifyFrozenInputIntegrity } from './session.js';

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
