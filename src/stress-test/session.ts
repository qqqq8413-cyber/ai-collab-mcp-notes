import { randomUUID } from 'node:crypto';
import type {
  ActionChange,
  AuthorContextItem,
  AuthorContextItemStatus,
  AuthorContextSourceType,
  EvidenceState,
  HumanAdjudication,
  Judgment,
  ReviewFinding,
  RevisionAction,
  RevisionSourceRef,
  SemanticIssue,
  StressTestSession,
} from './types.js';
import { emptyAuthorContext } from './types.js';
import { sha256AuthorContext, sha256Text } from './hash.js';

const nowIso = () => new Date().toISOString();

/** Fresh session in DRAFT — no findings, no frozen hashes yet. */
export function createSession(artifactText: string): StressTestSession {
  if (typeof artifactText !== 'string' || artifactText.length === 0) {
    throw new Error('createSession: artifactText must be a non-empty string');
  }
  return {
    id: randomUUID(),
    state: 'DRAFT',
    createdAt: nowIso(),
    artifactText,
    authorContext: emptyAuthorContext(),
    frozenAt: null,
    artifactHash: null,
    authorContextHash: null,
    findings: {},
    semanticIssues: {},
    adjudications: {},
    revisionActions: {},
  };
}

const AUTHOR_CONTEXT_CATEGORIES = ['confirmedFacts', 'knownRisks', 'openQuestions', 'constraints'] as const;
type AuthorContextCategory = (typeof AUTHOR_CONTEXT_CATEGORIES)[number];

const AUTHOR_CONTEXT_ITEM_STATUSES = ['CURRENT', 'RESOLVED', 'SUPERSEDED'] as const;

function assertNotFrozen(session: StressTestSession, action: string): void {
  if (session.state !== 'DRAFT') {
    throw new Error(
      `${action}: session input is frozen (state=${session.state}); frozen input cannot be changed silently — create a new session for a new version`
    );
  }
}

/**
 * Adds one item to an AuthorContext category. Only permitted before freeze —
 * see freezeInput for why post-freeze mutation is refused rather than
 * merely discouraged.
 */
export function addAuthorContextItem(
  session: StressTestSession,
  category: AuthorContextCategory,
  input: { text: string; sourceType: AuthorContextSourceType; status?: AuthorContextItemStatus }
): StressTestSession {
  assertNotFrozen(session, 'addAuthorContextItem');
  if (!AUTHOR_CONTEXT_CATEGORIES.includes(category)) {
    throw new Error(`addAuthorContextItem: unknown category ${JSON.stringify(category)}`);
  }
  if (input.status !== undefined && !AUTHOR_CONTEXT_ITEM_STATUSES.includes(input.status)) {
    throw new Error(`addAuthorContextItem: invalid status ${JSON.stringify(input.status)}`);
  }
  const item: AuthorContextItem = {
    id: randomUUID(),
    text: input.text,
    sourceType: input.sourceType,
    status: input.status ?? 'CURRENT',
    createdAt: nowIso(),
  };
  return {
    ...session,
    authorContext: {
      ...session.authorContext,
      [category]: [...session.authorContext[category], item],
    },
  };
}

/**
 * Freezes the artifact text and author context, hashing both. After this
 * call, session.artifactText/authorContext are exactly what the hashes
 * describe, permanently for this session — every mutating function in this
 * module refuses to run against a frozen session's input fields. A caller
 * that needs different input creates a new session rather than unfreezing
 * this one; that is a deliberate simplification for this slice, not an
 * oversight (see PRE_SUBMISSION_STRESS_TEST_MVP.md).
 */
export function freezeInput(session: StressTestSession): StressTestSession {
  if (session.state !== 'DRAFT') {
    throw new Error(`freezeInput: session must be in DRAFT to freeze (state=${session.state})`);
  }
  return {
    ...session,
    state: 'INPUT_FROZEN',
    frozenAt: nowIso(),
    artifactHash: sha256Text(session.artifactText),
    authorContextHash: sha256AuthorContext(session.authorContext),
  };
}

function assertFrozenOrLater(session: StressTestSession, action: string): void {
  if (session.state === 'DRAFT') {
    throw new Error(`${action}: session input must be frozen first (state=DRAFT)`);
  }
}

/**
 * Records one reviewer finding. Requires input to already be frozen — a
 * finding is meaningless without a fixed artifact/context to have reviewed.
 * The session advances to REVIEWED on its first finding.
 */
export function addFinding(
  session: StressTestSession,
  input: {
    reviewerRunId: string;
    type: ReviewFinding['type'];
    title: string;
    artifactLocation: string;
    evidenceState: EvidenceState;
    whyMaterial: string;
    likelyRecipientChallenge: string;
    minimumBeforeSendAction: string;
    rawText?: string;
  }
): StressTestSession {
  assertFrozenOrLater(session, 'addFinding');
  const finding: ReviewFinding = {
    id: randomUUID(),
    reviewerRunId: input.reviewerRunId,
    type: input.type,
    title: input.title,
    artifactLocation: input.artifactLocation,
    evidenceState: input.evidenceState,
    whyMaterial: input.whyMaterial,
    likelyRecipientChallenge: input.likelyRecipientChallenge,
    minimumBeforeSendAction: input.minimumBeforeSendAction,
    ...(input.rawText !== undefined ? { rawText: input.rawText } : {}),
    createdAt: nowIso(),
  };
  return {
    ...session,
    state: session.state === 'INPUT_FROZEN' ? 'REVIEWED' : session.state,
    findings: { ...session.findings, [finding.id]: finding },
  };
}

/**
 * Clusters one or more existing findings under a single semantic issue.
 * Findings are referenced by id, never deleted or copied — provenance stays
 * intact whether or not the occurrences turn out to describe the same
 * vulnerability. No automated clustering is performed here (see
 * PRE_SUBMISSION_STRESS_TEST_MVP.md); callers supply findingIds explicitly.
 */
export function createSemanticIssue(
  session: StressTestSession,
  input: { title: string; description: string; findingIds: string[]; evidenceState: EvidenceState }
): StressTestSession {
  assertFrozenOrLater(session, 'createSemanticIssue');
  if (input.findingIds.length === 0) {
    throw new Error('createSemanticIssue: findingIds must be non-empty');
  }
  for (const findingId of input.findingIds) {
    if (!session.findings[findingId]) {
      throw new Error(`createSemanticIssue: unknown findingId ${findingId}`);
    }
  }
  const issue: SemanticIssue = {
    id: randomUUID(),
    title: input.title,
    description: input.description,
    findingIds: [...input.findingIds],
    evidenceState: input.evidenceState,
    status: 'OPEN',
  };
  return {
    ...session,
    semanticIssues: { ...session.semanticIssues, [issue.id]: issue },
  };
}

/**
 * Records one human adjudication, targeting exactly one of a semantic issue
 * or a bare finding. Adjudicating a semantic issue marks it ADJUDICATED;
 * the underlying findings are left exactly as reviewers produced them —
 * human judgment is a separate layer, never written back onto reviewer
 * output.
 */
export function adjudicate(
  session: StressTestSession,
  input: {
    semanticIssueId?: string;
    findingId?: string;
    judgment: Judgment;
    actionChange: ActionChange;
    note?: string;
  }
): StressTestSession {
  assertFrozenOrLater(session, 'adjudicate');
  const hasIssue = input.semanticIssueId !== undefined;
  const hasFinding = input.findingId !== undefined;
  if (hasIssue === hasFinding) {
    throw new Error('adjudicate: exactly one of semanticIssueId or findingId must be supplied');
  }
  if (hasIssue && !session.semanticIssues[input.semanticIssueId as string]) {
    throw new Error(`adjudicate: unknown semanticIssueId ${input.semanticIssueId}`);
  }
  if (hasFinding && !session.findings[input.findingId as string]) {
    throw new Error(`adjudicate: unknown findingId ${input.findingId}`);
  }
  const record: HumanAdjudication = {
    id: randomUUID(),
    ...(hasIssue ? { semanticIssueId: input.semanticIssueId as string } : {}),
    ...(hasFinding ? { findingId: input.findingId as string } : {}),
    judgment: input.judgment,
    actionChange: input.actionChange,
    note: input.note ?? '',
    adjudicatedAt: nowIso(),
  };
  const semanticIssues = hasIssue
    ? {
        ...session.semanticIssues,
        [input.semanticIssueId as string]: {
          ...session.semanticIssues[input.semanticIssueId as string],
          status: 'ADJUDICATED' as const,
        },
      }
    : session.semanticIssues;
  return {
    ...session,
    state: session.state === 'REVIEWED' ? 'ADJUDICATED' : session.state,
    semanticIssues,
    adjudications: { ...session.adjudications, [record.id]: record },
  };
}

/**
 * Plans a revision action against the artifact, tied back to the
 * semantic issue(s)/adjudicated finding(s) that motivated it via an explicit
 * discriminated RevisionSourceRef — never inferred from the shape of an id.
 * A revision action existing does not itself mean the artifact was edited —
 * see implementRevisionAction/rejectRevisionAction for the distinction this
 * slice insists on.
 */
export function planRevisionAction(
  session: StressTestSession,
  input: { sourceRefs: RevisionSourceRef[]; description: string; targetLocation: string }
): StressTestSession {
  assertFrozenOrLater(session, 'planRevisionAction');
  if (input.sourceRefs.length === 0) {
    throw new Error('planRevisionAction: sourceRefs must be non-empty');
  }
  for (const ref of input.sourceRefs) {
    if (ref.kind === 'SEMANTIC_ISSUE') {
      if (!session.semanticIssues[ref.id]) {
        throw new Error(`planRevisionAction: unknown semantic issue id ${ref.id}`);
      }
    } else if (ref.kind === 'FINDING') {
      if (!session.findings[ref.id]) {
        throw new Error(`planRevisionAction: unknown finding id ${ref.id}`);
      }
    } else {
      throw new Error(`planRevisionAction: invalid source ref kind ${JSON.stringify((ref as { kind: unknown }).kind)}`);
    }
  }
  const action: RevisionAction = {
    id: randomUUID(),
    sourceRefs: [...input.sourceRefs],
    description: input.description,
    targetLocation: input.targetLocation,
    status: 'PLANNED',
    createdAt: nowIso(),
  };
  return {
    ...session,
    state: session.state === 'ADJUDICATED' ? 'REVISION_PLANNED' : session.state,
    revisionActions: { ...session.revisionActions, [action.id]: action },
  };
}

function setRevisionStatus(
  session: StressTestSession,
  revisionActionId: string,
  status: RevisionAction['status'],
  action: string
): StressTestSession {
  const existing = session.revisionActions[revisionActionId];
  if (!existing) throw new Error(`${action}: unknown revisionActionId ${revisionActionId}`);
  if (existing.status !== 'PLANNED') {
    throw new Error(`${action}: revision action ${revisionActionId} is not PLANNED (status=${existing.status})`);
  }
  return {
    ...session,
    revisionActions: { ...session.revisionActions, [revisionActionId]: { ...existing, status } },
  };
}

export function implementRevisionAction(session: StressTestSession, revisionActionId: string): StressTestSession {
  return setRevisionStatus(session, revisionActionId, 'IMPLEMENTED', 'implementRevisionAction');
}

export function rejectRevisionAction(session: StressTestSession, revisionActionId: string): StressTestSession {
  return setRevisionStatus(session, revisionActionId, 'REJECTED', 'rejectRevisionAction');
}

/** Marks the session COMPLETED. Requires every planned revision action to have been resolved (implemented or rejected) first. */
export function completeSession(session: StressTestSession): StressTestSession {
  if (session.state !== 'ADJUDICATED' && session.state !== 'REVISION_PLANNED') {
    throw new Error(`completeSession: session must be ADJUDICATED or REVISION_PLANNED (state=${session.state})`);
  }
  const stillPlanned = Object.values(session.revisionActions).filter((a) => a.status === 'PLANNED');
  if (stillPlanned.length > 0) {
    throw new Error(`completeSession: ${stillPlanned.length} revision action(s) are still PLANNED`);
  }
  return { ...session, state: 'COMPLETED' };
}
