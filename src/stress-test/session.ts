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
  RevisionSuccessorBinding,
  RevisionVerification,
  RevisionVerificationVerdict,
  SemanticIssue,
  SessionState,
  StressTestSession,
} from './types.js';
import { emptyAuthorContext } from './types.js';
import { sha256AuthorContext, sha256Text } from './hash.js';
import { isReviewFindingShape, isSemanticIssueShape, lookupExactRecord, resolveExactRecord } from './reference.js';

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
    revisionSuccessor: null,
    revisionVerifications: {},
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
 * Runtime (not just type-level) proof that a session's frozen input has not
 * been tampered with since freezeInput ran. TypeScript cannot stop a
 * caller — including a plain-JS caller with no type checking at all — from
 * mutating `session.artifactText` / `session.authorContext` directly after
 * freeze while leaving the stored hashes untouched. Every post-freeze domain
 * operation whose result feeds the audit trail calls this first and fails
 * closed on any mismatch; it never refreshes the stored hash or silently
 * accepts the modified input. A caller who needs different input must
 * create a new StressTestSession — see freezeInput's own contract.
 */
export function verifyFrozenInputIntegrity(session: StressTestSession): void {
  if (session.state === 'DRAFT') return;
  if (!session.artifactHash || !session.authorContextHash) {
    throw new Error(
      'verifyFrozenInputIntegrity: session is frozen or later but is missing its stored artifactHash/authorContextHash'
    );
  }
  if (sha256Text(session.artifactText) !== session.artifactHash) {
    throw new Error(
      'verifyFrozenInputIntegrity: artifactText no longer matches its frozen artifactHash — frozen input was modified after freeze; create a new StressTestSession instead of mutating this one'
    );
  }
  if (sha256AuthorContext(session.authorContext) !== session.authorContextHash) {
    throw new Error(
      'verifyFrozenInputIntegrity: authorContext no longer matches its frozen authorContextHash — frozen input was modified after freeze; create a new StressTestSession instead of mutating this one'
    );
  }
}

/** Throws unless the session's current state is one of `allowed` — enforces the documented state machine precisely, not just "frozen or later". */
function assertStateIn(session: StressTestSession, action: string, allowed: SessionState[]): void {
  if (!allowed.includes(session.state)) {
    throw new Error(`${action}: not permitted in state=${session.state} (requires one of: ${allowed.join(', ')})`);
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
  verifyFrozenInputIntegrity(session);
  assertFrozenOrLater(session, 'addFinding');
  assertStateIn(session, 'addFinding', ['INPUT_FROZEN', 'REVIEWED']);
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
  // Write/read parity: exact reference resolution only accepts a finding of this
  // runtime shape, so a finding that would never resolve is never written.
  if (!isReviewFindingShape(finding)) {
    throw new Error('addFinding: every finding field must be a string (rawText optional)');
  }
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
  verifyFrozenInputIntegrity(session);
  assertFrozenOrLater(session, 'createSemanticIssue');
  assertStateIn(session, 'createSemanticIssue', ['REVIEWED']);
  assertSemanticIssueLedgerIntegrity(session);
  if (!Array.isArray(input.findingIds) || input.findingIds.length === 0) {
    throw new Error('createSemanticIssue: findingIds must be non-empty');
  }
  for (const findingId of input.findingIds) {
    if (!resolveExactRecord(session.findings, findingId, isReviewFindingShape)) {
      throw new Error(`createSemanticIssue: unknown findingId ${findingId}`);
    }
  }
  // findingIds is provenance, not a set: a repeated id is exactly the malformed,
  // provenance-ambiguous membership later evidence reads reject, so it is never written.
  if (new Set(input.findingIds).size !== input.findingIds.length) {
    throw new Error('createSemanticIssue: findingIds must not repeat a finding');
  }
  const issue: SemanticIssue = {
    id: randomUUID(),
    title: input.title,
    description: input.description,
    findingIds: [...input.findingIds],
    evidenceState: input.evidenceState,
    status: 'OPEN',
  };
  if (!isSemanticIssueShape(issue)) {
    throw new Error('createSemanticIssue: title, description, and evidenceState must be strings');
  }
  const next: StressTestSession = {
    ...session,
    semanticIssues: { ...session.semanticIssues, [issue.id]: issue },
  };
  assertSemanticIssueLedgerIntegrity(next);
  return next;
}

/**
 * Canonical ledger-wide validator for `session.semanticIssues`. Validates
 * EVERY issue, whether or not any adjudication, revision action, question,
 * or report later selects it -- global integrity before local lookup or
 * projection. Each issue must be stored under its own id with the runtime
 * SemanticIssue shape, and its `findingIds` must be a non-empty provenance
 * list with no repeats whose every entry resolves through the exact
 * ReviewFinding resolver (owned key, finding shape, finding.id === id).
 * Report projections call it before projecting anything; createSemanticIssue
 * calls it before and after its write.
 */
export function assertSemanticIssueLedgerIntegrity(session: StressTestSession): void {
  if (session.semanticIssues === null || typeof session.semanticIssues !== 'object') {
    throw new Error('assertSemanticIssueLedgerIntegrity: semanticIssues must be an object');
  }
  for (const [key, issue] of Object.entries(session.semanticIssues)) {
    if (issue === null || typeof issue !== 'object' || Array.isArray(issue) || !isSemanticIssueShape(issue)) {
      throw new Error(`assertSemanticIssueLedgerIntegrity: entry at key "${key}" is not a well-formed SemanticIssue`);
    }
    if (key !== issue.id || !isNonEmptyString(issue.id)) {
      throw new Error(
        `assertSemanticIssueLedgerIntegrity: semanticIssues map key "${key}" does not match SemanticIssue.id "${issue.id}"`
      );
    }
    if (issue.findingIds.length === 0) {
      throw new Error(`assertSemanticIssueLedgerIntegrity: SemanticIssue ${issue.id} has no findingIds`);
    }
    const seenFindingIds = new Set<string>();
    for (const findingId of issue.findingIds) {
      if (seenFindingIds.has(findingId)) {
        throw new Error(
          `assertSemanticIssueLedgerIntegrity: SemanticIssue ${issue.id} repeats findingId ${JSON.stringify(findingId)} -- provenance-ambiguous membership`
        );
      }
      seenFindingIds.add(findingId);
      const lookup = lookupExactRecord(session.findings, findingId, isReviewFindingShape);
      if (!lookup.found) {
        throw new Error(
          `assertSemanticIssueLedgerIntegrity: SemanticIssue ${issue.id} references findingId ${JSON.stringify(findingId)}, which does not exactly resolve to a ReviewFinding (${lookup.reason})`
        );
      }
    }
  }
}

const JUDGMENTS: Judgment[] = ['KNOWN_PRE_DISPATCH', 'NEW_NON_MATERIAL', 'NEW_MATERIAL', 'WRONG'];
const ACTION_CHANGES: ActionChange[] = ['YES', 'NO'];
const REVISION_ACTION_STATUSES: RevisionAction['status'][] = ['PLANNED', 'IMPLEMENTED', 'REJECTED'];

/**
 * Canonical later-read/write-boundary validator for the entire
 * `session.adjudications` ledger (P2-C0 Amendment 3). Validates EVERY
 * existing entry globally, never only the one a caller is about to touch --
 * the same "global integrity before local lookup" discipline already
 * established for `assertRevisionVerificationLedgerIntegrity`. Existence by
 * map key alone is never sufficient: the resolved SemanticIssue/ReviewFinding
 * object's own `id` field must also equal the stored target id. Cardinality
 * (at most one adjudication per exact target) is tracked separately per
 * target *kind* -- a SemanticIssue and a ReviewFinding may legally share an
 * id-shaped string, so collapsing by id alone would be a false-positive
 * duplicate.
 */
export function assertHumanAdjudicationLedgerIntegrity(session: StressTestSession): void {
  const seenTargets = new Set<string>();
  for (const [key, adjudication] of Object.entries(session.adjudications)) {
    if (key !== adjudication.id) {
      throw new Error(
        `assertHumanAdjudicationLedgerIntegrity: adjudications map key "${key}" does not match adjudication.id "${adjudication.id}"`
      );
    }
    if (!isNonEmptyString(adjudication.id)) {
      throw new Error(`assertHumanAdjudicationLedgerIntegrity: adjudication at key "${key}" has an invalid id`);
    }
    const hasIssue = adjudication.semanticIssueId !== undefined;
    const hasFinding = adjudication.findingId !== undefined;
    if (hasIssue === hasFinding) {
      throw new Error(
        `assertHumanAdjudicationLedgerIntegrity: adjudication ${adjudication.id} must target exactly one of semanticIssueId/findingId`
      );
    }
    let targetKey: string;
    if (hasIssue) {
      const semanticIssueId = adjudication.semanticIssueId as string;
      if (!isNonEmptyString(semanticIssueId)) {
        throw new Error(
          `assertHumanAdjudicationLedgerIntegrity: adjudication ${adjudication.id} has an invalid semanticIssueId`
        );
      }
      const lookup = lookupExactRecord(session.semanticIssues, semanticIssueId, isSemanticIssueShape);
      if (!lookup.found && lookup.reason === 'NOT_OWNED') {
        throw new Error(
          `assertHumanAdjudicationLedgerIntegrity: adjudication ${adjudication.id} references unknown semanticIssueId ${semanticIssueId}`
        );
      }
      if (!lookup.found) {
        throw new Error(
          `assertHumanAdjudicationLedgerIntegrity: adjudication ${adjudication.id}'s semanticIssueId "${semanticIssueId}" resolves by map key but the resolved SemanticIssue.id "${(session.semanticIssues[semanticIssueId] as { id?: unknown } | null)?.id}" differs or the record is malformed`
        );
      }
      targetKey = `SEMANTIC_ISSUE:${semanticIssueId}`;
    } else {
      const findingId = adjudication.findingId as string;
      if (!isNonEmptyString(findingId)) {
        throw new Error(`assertHumanAdjudicationLedgerIntegrity: adjudication ${adjudication.id} has an invalid findingId`);
      }
      const lookup = lookupExactRecord(session.findings, findingId, isReviewFindingShape);
      if (!lookup.found && lookup.reason === 'NOT_OWNED') {
        throw new Error(
          `assertHumanAdjudicationLedgerIntegrity: adjudication ${adjudication.id} references unknown findingId ${findingId}`
        );
      }
      if (!lookup.found) {
        throw new Error(
          `assertHumanAdjudicationLedgerIntegrity: adjudication ${adjudication.id}'s findingId "${findingId}" resolves by map key but the resolved ReviewFinding.id "${(session.findings[findingId] as { id?: unknown } | null)?.id}" differs or the record is malformed`
        );
      }
      targetKey = `FINDING:${findingId}`;
    }
    if (!JUDGMENTS.includes(adjudication.judgment)) {
      throw new Error(
        `assertHumanAdjudicationLedgerIntegrity: adjudication ${adjudication.id} has an invalid judgment ${JSON.stringify(adjudication.judgment)}`
      );
    }
    if (!ACTION_CHANGES.includes(adjudication.actionChange)) {
      throw new Error(
        `assertHumanAdjudicationLedgerIntegrity: adjudication ${adjudication.id} has an invalid actionChange ${JSON.stringify(adjudication.actionChange)}`
      );
    }
    if (typeof adjudication.note !== 'string') {
      throw new Error(`assertHumanAdjudicationLedgerIntegrity: adjudication ${adjudication.id} has a non-string note`);
    }
    if (!isNonEmptyString(adjudication.adjudicatedAt)) {
      throw new Error(`assertHumanAdjudicationLedgerIntegrity: adjudication ${adjudication.id} has an invalid adjudicatedAt`);
    }
    if (seenTargets.has(targetKey)) {
      throw new Error(
        `assertHumanAdjudicationLedgerIntegrity: more than one HumanAdjudication targets ${targetKey} -- 0..1 cardinality violated`
      );
    }
    seenTargets.add(targetKey);
  }
}

/**
 * Canonical later-read/write-boundary validator for the entire
 * `session.revisionActions` ledger (P2-C0 Amendment 2/3) -- not
 * report-specific. Begins by validating the upstream `session.adjudications`
 * ledger (`assertHumanAdjudicationLedgerIntegrity`): the authorization check
 * below (item J) can never be trusted if that upstream ledger is corrupt.
 * Existence-by-map-key alone is never sufficient for a sourceRef's target
 * either -- the resolved SemanticIssue/ReviewFinding's own `id` must match.
 * Required dependency direction: HumanAdjudication integrity ->
 * RevisionAction integrity -> RevisionSuccessor/RevisionVerification
 * integrity; never reversed.
 */
export function assertRevisionActionLedgerIntegrity(session: StressTestSession): void {
  assertHumanAdjudicationLedgerIntegrity(session);

  for (const [key, action] of Object.entries(session.revisionActions)) {
    if (key !== action.id) {
      throw new Error(
        `assertRevisionActionLedgerIntegrity: revisionActions map key "${key}" does not match action.id "${action.id}"`
      );
    }
    if (!isNonEmptyString(action.id)) {
      throw new Error(`assertRevisionActionLedgerIntegrity: action at key "${key}" has an invalid id`);
    }
    if (!Array.isArray(action.sourceRefs) || action.sourceRefs.length === 0) {
      throw new Error(`assertRevisionActionLedgerIntegrity: action ${action.id} has empty or non-array sourceRefs`);
    }
    if (!REVISION_ACTION_STATUSES.includes(action.status)) {
      throw new Error(
        `assertRevisionActionLedgerIntegrity: action ${action.id} has an invalid status ${JSON.stringify(action.status)}`
      );
    }
    if (!isNonEmptyString(action.createdAt)) {
      throw new Error(`assertRevisionActionLedgerIntegrity: action ${action.id} has an invalid createdAt`);
    }

    let authorized = false;
    for (const ref of action.sourceRefs) {
      if (ref === null || typeof ref !== 'object' || (ref.kind !== 'SEMANTIC_ISSUE' && ref.kind !== 'FINDING')) {
        throw new Error(
          `assertRevisionActionLedgerIntegrity: action ${action.id} has a sourceRef with an invalid kind ${JSON.stringify((ref as { kind?: unknown } | null)?.kind)}`
        );
      }
      if (!isNonEmptyString(ref.id)) {
        throw new Error(`assertRevisionActionLedgerIntegrity: action ${action.id} has a sourceRef with an invalid id`);
      }
      if (ref.kind === 'SEMANTIC_ISSUE') {
        const lookup = lookupExactRecord(session.semanticIssues, ref.id, isSemanticIssueShape);
        if (!lookup.found && lookup.reason === 'NOT_OWNED') {
          throw new Error(
            `assertRevisionActionLedgerIntegrity: action ${action.id} references unknown semantic issue ${ref.id}`
          );
        }
        if (!lookup.found) {
          throw new Error(
            `assertRevisionActionLedgerIntegrity: action ${action.id}'s sourceRef "${ref.id}" resolves by map key but the resolved SemanticIssue.id "${(session.semanticIssues[ref.id] as { id?: unknown } | null)?.id}" differs or the record is malformed`
          );
        }
        if (Object.values(session.adjudications).some((a) => a.actionChange === 'YES' && a.semanticIssueId === ref.id)) {
          authorized = true;
        }
      } else {
        const lookup = lookupExactRecord(session.findings, ref.id, isReviewFindingShape);
        if (!lookup.found && lookup.reason === 'NOT_OWNED') {
          throw new Error(`assertRevisionActionLedgerIntegrity: action ${action.id} references unknown finding ${ref.id}`);
        }
        if (!lookup.found) {
          throw new Error(
            `assertRevisionActionLedgerIntegrity: action ${action.id}'s sourceRef "${ref.id}" resolves by map key but the resolved ReviewFinding.id "${(session.findings[ref.id] as { id?: unknown } | null)?.id}" differs or the record is malformed`
          );
        }
        if (Object.values(session.adjudications).some((a) => a.actionChange === 'YES' && a.findingId === ref.id)) {
          authorized = true;
        }
      }
    }
    if (!authorized) {
      throw new Error(
        `assertRevisionActionLedgerIntegrity: action ${action.id} has no sourceRef that still resolves to a HumanAdjudication with actionChange=YES`
      );
    }
  }
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
  verifyFrozenInputIntegrity(session);
  assertFrozenOrLater(session, 'adjudicate');
  assertStateIn(session, 'adjudicate', ['REVIEWED', 'ADJUDICATED']);
  assertHumanAdjudicationLedgerIntegrity(session);
  if (input === null || typeof input !== 'object') {
    throw new Error('adjudicate: input must be an object');
  }
  const hasIssue = input.semanticIssueId !== undefined;
  const hasFinding = input.findingId !== undefined;
  if (hasIssue === hasFinding) {
    throw new Error('adjudicate: exactly one of semanticIssueId or findingId must be supplied');
  }
  // The new entry is validated before anything is written, against the same
  // vocabularies and exact-reference rule the canonical ledger validator applies
  // on every later read.
  if (hasIssue && !resolveExactRecord(session.semanticIssues, input.semanticIssueId, isSemanticIssueShape)) {
    throw new Error(`adjudicate: unknown semanticIssueId ${input.semanticIssueId}`);
  }
  if (hasFinding && !resolveExactRecord(session.findings, input.findingId, isReviewFindingShape)) {
    throw new Error(`adjudicate: unknown findingId ${input.findingId}`);
  }
  if (!JUDGMENTS.includes(input.judgment)) {
    throw new Error(`adjudicate: invalid judgment ${JSON.stringify(input.judgment)}`);
  }
  if (!ACTION_CHANGES.includes(input.actionChange)) {
    throw new Error(`adjudicate: invalid actionChange ${JSON.stringify(input.actionChange)}`);
  }
  if (input.note !== undefined && typeof input.note !== 'string') {
    throw new Error('adjudicate: note must be a string when supplied');
  }
  // Slice 1 has no amendment/supersession model -- at most one HumanAdjudication per target.
  if (hasIssue && Object.values(session.adjudications).some((a) => a.semanticIssueId === input.semanticIssueId)) {
    throw new Error(
      `adjudicate: semantic issue ${input.semanticIssueId} already has a HumanAdjudication; Slice 1 does not support amendment — implicit last-write-wins is refused`
    );
  }
  if (hasFinding && Object.values(session.adjudications).some((a) => a.findingId === input.findingId)) {
    throw new Error(
      `adjudicate: finding ${input.findingId} already has a HumanAdjudication; Slice 1 does not support amendment — implicit last-write-wins is refused`
    );
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
  const next: StressTestSession = {
    ...session,
    state: session.state === 'REVIEWED' ? 'ADJUDICATED' : session.state,
    semanticIssues,
    adjudications: { ...session.adjudications, [record.id]: record },
  };
  // Write/read parity: a successful adjudication never returns a ledger its own
  // canonical later-read validator would reject.
  assertHumanAdjudicationLedgerIntegrity(next);
  return next;
}

/**
 * Domain-specific clone for one RevisionSourceRef -- containing only its
 * two discriminant fields, never a caller-owned object reference. Not a
 * generic deep-clone utility; this is the exact minimum needed to isolate
 * `RevisionAction.sourceRefs` from the caller's own input objects (P2-C0
 * Amendment 2).
 */
function cloneRevisionSourceRef(ref: RevisionSourceRef): RevisionSourceRef {
  return { kind: ref.kind, id: ref.id } as RevisionSourceRef;
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
  verifyFrozenInputIntegrity(session);
  assertFrozenOrLater(session, 'planRevisionAction');
  assertStateIn(session, 'planRevisionAction', ['ADJUDICATED', 'REVISION_PLANNED']);
  assertRevisionActionLedgerIntegrity(session);
  if (!Array.isArray(input.sourceRefs) || input.sourceRefs.length === 0) {
    throw new Error('planRevisionAction: sourceRefs must be non-empty');
  }
  for (const ref of input.sourceRefs) {
    if (ref === null || typeof ref !== 'object') {
      throw new Error('planRevisionAction: every sourceRef must be an object');
    }
    if (ref.kind === 'SEMANTIC_ISSUE') {
      if (!resolveExactRecord(session.semanticIssues, ref.id, isSemanticIssueShape)) {
        throw new Error(`planRevisionAction: unknown semantic issue id ${ref.id}`);
      }
    } else if (ref.kind === 'FINDING') {
      if (!resolveExactRecord(session.findings, ref.id, isReviewFindingShape)) {
        throw new Error(`planRevisionAction: unknown finding id ${ref.id}`);
      }
    } else {
      throw new Error(`planRevisionAction: invalid source ref kind ${JSON.stringify((ref as { kind: unknown }).kind)}`);
    }
  }
  // A reviewer finding never authorizes a revision by itself -- a human must
  // have recorded actionChange=YES against at least one of the refs used
  // here. judgment is deliberately not consulted: NEW_MATERIAL is an
  // experiment metric, not the product's authorization rule, and a human may
  // choose to change something already categorized as known.
  const isAuthorized = input.sourceRefs.some((ref) =>
    Object.values(session.adjudications).some((a) => {
      if (a.actionChange !== 'YES') return false;
      if (ref.kind === 'SEMANTIC_ISSUE') return a.semanticIssueId === ref.id;
      return a.findingId === ref.id;
    })
  );
  if (!isAuthorized) {
    throw new Error(
      'planRevisionAction: no sourceRef resolves to a HumanAdjudication with actionChange=YES; a revision may only be planned once a human has explicitly authorized a change'
    );
  }
  const action: RevisionAction = {
    id: randomUUID(),
    sourceRefs: input.sourceRefs.map(cloneRevisionSourceRef),
    description: input.description,
    targetLocation: input.targetLocation,
    status: 'PLANNED',
    createdAt: nowIso(),
  };
  const next: StressTestSession = {
    ...session,
    state: session.state === 'ADJUDICATED' ? 'REVISION_PLANNED' : session.state,
    revisionActions: { ...session.revisionActions, [action.id]: action },
  };
  assertRevisionActionLedgerIntegrity(next);
  return next;
}

function setRevisionStatus(
  session: StressTestSession,
  revisionActionId: string,
  status: RevisionAction['status'],
  action: string
): StressTestSession {
  verifyFrozenInputIntegrity(session);
  assertStateIn(session, action, ['REVISION_PLANNED']);
  assertRevisionActionLedgerIntegrity(session);
  const existing = resolveExactRecord(session.revisionActions, revisionActionId);
  if (!existing) throw new Error(`${action}: unknown revisionActionId ${revisionActionId}`);
  if (existing.status !== 'PLANNED') {
    throw new Error(`${action}: revision action ${revisionActionId} is not PLANNED (status=${existing.status})`);
  }
  const next: StressTestSession = {
    ...session,
    revisionActions: { ...session.revisionActions, [revisionActionId]: { ...existing, status } },
  };
  assertRevisionActionLedgerIntegrity(next);
  return next;
}

export function implementRevisionAction(session: StressTestSession, revisionActionId: string): StressTestSession {
  return setRevisionStatus(session, revisionActionId, 'IMPLEMENTED', 'implementRevisionAction');
}

export function rejectRevisionAction(session: StressTestSession, revisionActionId: string): StressTestSession {
  return setRevisionStatus(session, revisionActionId, 'REJECTED', 'rejectRevisionAction');
}

/** Marks the session COMPLETED. Requires every planned revision action to have been resolved (implemented or rejected) first. */
export function completeSession(session: StressTestSession): StressTestSession {
  verifyFrozenInputIntegrity(session);
  if (session.state !== 'ADJUDICATED' && session.state !== 'REVISION_PLANNED') {
    throw new Error(`completeSession: session must be ADJUDICATED or REVISION_PLANNED (state=${session.state})`);
  }
  assertRevisionActionLedgerIntegrity(session);
  const stillPlanned = Object.values(session.revisionActions).filter((a) => a.status === 'PLANNED');
  if (stillPlanned.length > 0) {
    throw new Error(`completeSession: ${stillPlanned.length} revision action(s) are still PLANNED`);
  }
  return { ...session, state: 'COMPLETED' };
}

/**
 * Creates V1: a wholly fresh, frozen StressTestSession holding the revised
 * artifact text, and binds it to `sourceSession` as its one authoritative
 * direct revision successor (0..1 -- first pilot is one-shot, see
 * REVISION_VERIFICATION_CONTRACT.md). This answers only "which frozen
 * session is sourceSession's successor" -- it never marks any RevisionAction
 * verified, creates a QuestionDisposition, or touches SessionVersionLineage
 * or DeliberationState; whether a specific RevisionAction actually reached
 * the successor is RevisionVerification (P2-B, not implemented here).
 */
export function createRevisionSuccessorSession(
  sourceSession: StressTestSession,
  revisedArtifactText: string
): { sourceSession: StressTestSession; successorSession: StressTestSession } {
  verifyFrozenInputIntegrity(sourceSession);
  assertFrozenOrLater(sourceSession, 'createRevisionSuccessorSession');
  assertRevisionActionLedgerIntegrity(sourceSession);
  if (sourceSession.revisionSuccessor !== null) {
    throw new Error(
      'createRevisionSuccessorSession: sourceSession already has a direct revision successor -- first pilot supports at most one (0..1)'
    );
  }
  const hasImplementedRevisionAction = Object.values(sourceSession.revisionActions).some(
    (a) => a.status === 'IMPLEMENTED'
  );
  if (!hasImplementedRevisionAction) {
    throw new Error(
      'createRevisionSuccessorSession: sourceSession has no IMPLEMENTED RevisionAction -- nothing to check a successor against'
    );
  }

  // Wholly fresh session -- never a copy-then-mutate of sourceSession. Every
  // AuthorContextItem below is a newly constructed object via the existing
  // addAuthorContextItem API, so nothing here aliases sourceSession's arrays
  // or item objects.
  let successorSession = createSession(revisedArtifactText);
  for (const category of AUTHOR_CONTEXT_CATEGORIES) {
    for (const item of sourceSession.authorContext[category]) {
      successorSession = addAuthorContextItem(successorSession, category, {
        text: item.text,
        sourceType: item.sourceType,
        status: item.status,
      });
    }
  }
  successorSession = freezeInput(successorSession);
  verifyFrozenInputIntegrity(successorSession);

  if (successorSession.id === sourceSession.id) {
    throw new Error(
      'createRevisionSuccessorSession: internal invariant violated -- successorSession.id equals sourceSession.id'
    );
  }
  if (!sourceSession.artifactHash || !sourceSession.authorContextHash) {
    throw new Error('createRevisionSuccessorSession: sourceSession is missing its frozen artifactHash/authorContextHash');
  }
  if (!successorSession.artifactHash || !successorSession.authorContextHash) {
    throw new Error(
      'createRevisionSuccessorSession: internal invariant violated -- successorSession is missing frozen hashes'
    );
  }
  if (successorSession.artifactHash === sourceSession.artifactHash) {
    throw new Error(
      'createRevisionSuccessorSession: revisedArtifactText produced the same artifactHash as sourceSession -- the successor must be a changed artifact snapshot'
    );
  }

  const binding: RevisionSuccessorBinding = {
    sourceSessionId: sourceSession.id,
    sourceArtifactHash: sourceSession.artifactHash,
    sourceAuthorContextHash: sourceSession.authorContextHash,
    successorSessionId: successorSession.id,
    successorArtifactHash: successorSession.artifactHash,
    successorAuthorContextHash: successorSession.authorContextHash,
    createdAt: nowIso(),
  };

  return {
    sourceSession: { ...sourceSession, revisionSuccessor: binding },
    successorSession,
  };
}

/**
 * Canonical, reusable later-read validator (REVISION_VERIFICATION_CONTRACT.md
 * §14/§24): fails closed unless `successorSession` is genuinely
 * `sourceSession`'s authoritative RevisionSuccessorBinding successor, per
 * every fact recorded at write time -- never trusted merely because the two
 * supplied objects agree with each other. P2-B and later report projections
 * must reuse this boundary rather than duplicate its checks.
 *
 * Proves only domain-boundary / later-read consistency within this in-memory
 * architecture -- not cryptographic immutability, not that any specific
 * RevisionAction's change appears in the successor's artifact text, and not
 * final delivery status.
 */
export function assertRevisionSuccessorIntegrity(
  sourceSession: StressTestSession,
  successorSession: StressTestSession
): void {
  verifyFrozenInputIntegrity(sourceSession);
  verifyFrozenInputIntegrity(successorSession);
  assertFrozenOrLater(sourceSession, 'assertRevisionSuccessorIntegrity');
  assertFrozenOrLater(successorSession, 'assertRevisionSuccessorIntegrity');

  const binding = sourceSession.revisionSuccessor;
  if (!binding) {
    throw new Error('assertRevisionSuccessorIntegrity: sourceSession has no RevisionSuccessorBinding');
  }
  if (binding.sourceSessionId !== sourceSession.id) {
    throw new Error('assertRevisionSuccessorIntegrity: binding.sourceSessionId does not match sourceSession.id');
  }
  if (binding.sourceArtifactHash !== sourceSession.artifactHash) {
    throw new Error(
      'assertRevisionSuccessorIntegrity: binding.sourceArtifactHash does not match sourceSession.artifactHash'
    );
  }
  if (binding.sourceAuthorContextHash !== sourceSession.authorContextHash) {
    throw new Error(
      'assertRevisionSuccessorIntegrity: binding.sourceAuthorContextHash does not match sourceSession.authorContextHash'
    );
  }
  if (binding.successorSessionId !== successorSession.id) {
    throw new Error('assertRevisionSuccessorIntegrity: binding.successorSessionId does not match successorSession.id');
  }
  if (binding.successorArtifactHash !== successorSession.artifactHash) {
    throw new Error(
      'assertRevisionSuccessorIntegrity: binding.successorArtifactHash does not match successorSession.artifactHash'
    );
  }
  if (binding.successorAuthorContextHash !== successorSession.authorContextHash) {
    throw new Error(
      'assertRevisionSuccessorIntegrity: binding.successorAuthorContextHash does not match successorSession.authorContextHash'
    );
  }
  if (sourceSession.id === successorSession.id) {
    throw new Error('assertRevisionSuccessorIntegrity: sourceSession.id equals successorSession.id');
  }
  if (sourceSession.artifactHash === successorSession.artifactHash) {
    throw new Error('assertRevisionSuccessorIntegrity: sourceSession.artifactHash equals successorSession.artifactHash');
  }
  assertRevisionActionLedgerIntegrity(sourceSession);
  const hasImplementedRevisionAction = Object.values(sourceSession.revisionActions).some(
    (a) => a.status === 'IMPLEMENTED'
  );
  if (!hasImplementedRevisionAction) {
    throw new Error('assertRevisionSuccessorIntegrity: sourceSession no longer contains an IMPLEMENTED RevisionAction');
  }
  for (const category of AUTHOR_CONTEXT_CATEGORIES) {
    const sourceItems = sourceSession.authorContext[category];
    const successorItems = successorSession.authorContext[category];
    if (successorItems.length !== sourceItems.length) {
      throw new Error(
        `assertRevisionSuccessorIntegrity: successor AuthorContext category "${category}" does not have the same number of items as source`
      );
    }
    for (let i = 0; i < sourceItems.length; i++) {
      const sourceItem = sourceItems[i];
      const successorItem = successorItems[i];
      if (
        successorItem.text !== sourceItem.text ||
        successorItem.sourceType !== sourceItem.sourceType ||
        successorItem.status !== sourceItem.status
      ) {
        throw new Error(
          `assertRevisionSuccessorIntegrity: successor AuthorContext category "${category}" item ${i} does not semantically match source (expected copied text/sourceType/status)`
        );
      }
    }
  }
}

const REVISION_VERIFICATION_VERDICTS: RevisionVerificationVerdict[] = ['VERIFIED_PRESENT', 'NOT_PRESENT', 'INCONCLUSIVE'];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNonEmptyNonWhitespaceString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Canonical ledger-wide validator shared by the write boundary
 * (recordRevisionVerification), the later-read boundary
 * (assertRevisionVerificationIntegrity), and P2-C report generation --
 * exported since P2-C0's own §9 recommendation (promoted from
 * module-internal with no signature/logic change). Validates EVERY existing
 * entry in `sourceSession.revisionVerifications`, never only the one a
 * caller is about to touch or request: before any boundary trusts anything
 * about the ledger -- including before appending a brand-new,
 * otherwise-unrelated record -- the whole ledger must already be
 * structurally/provenance-consistent (the same "global integrity before
 * local filtering" rule already applied elsewhere in P2-B), so a hidden
 * corrupt or duplicate record can never be built on top of, only ever
 * caught. Since P2-C0 Amendment 3, first composes
 * `assertRevisionActionLedgerIntegrity` (which itself composes
 * `assertHumanAdjudicationLedgerIntegrity`), so a corrupt upstream
 * RevisionAction or HumanAdjudication ledger can never be silently trusted
 * merely because `record.revisionActionId`/`.status` happen to match.
 *
 * IMPORTANT -- this validator ALONE is NOT sufficient to trust or display a
 * RevisionVerification against a successor artifact: it says nothing about
 * whether any `successorSession` a caller may have in hand is genuinely
 * `sourceSession`'s authoritative V1. Callers (report generation included)
 * must always call `assertRevisionSuccessorIntegrity(sourceSession,
 * successorSession)` first, THEN this function -- never this function
 * alone.
 */
export function assertRevisionVerificationLedgerIntegrity(sourceSession: StressTestSession): void {
  assertRevisionActionLedgerIntegrity(sourceSession);
  const seenRevisionActionIds = new Set<string>();
  for (const [key, record] of Object.entries(sourceSession.revisionVerifications)) {
    if (key !== record.id) {
      throw new Error(
        `assertRevisionVerificationLedgerIntegrity: revisionVerifications map key "${key}" does not match record.id "${record.id}"`
      );
    }
    if (!isNonEmptyString(record.id)) {
      throw new Error(`assertRevisionVerificationLedgerIntegrity: record at key "${key}" has an invalid id`);
    }
    const referencedAction = resolveExactRecord(sourceSession.revisionActions, record.revisionActionId);
    if (!referencedAction) {
      throw new Error(
        `assertRevisionVerificationLedgerIntegrity: record ${record.id} references unknown revisionActionId ${record.revisionActionId}`
      );
    }
    if (referencedAction.status !== 'IMPLEMENTED') {
      throw new Error(
        `assertRevisionVerificationLedgerIntegrity: record ${record.id} references revision action ${record.revisionActionId}, which is not IMPLEMENTED (status=${referencedAction.status})`
      );
    }
    if (!REVISION_VERIFICATION_VERDICTS.includes(record.verdict)) {
      throw new Error(
        `assertRevisionVerificationLedgerIntegrity: record ${record.id} has an invalid verdict ${JSON.stringify(record.verdict)}`
      );
    }
    if (!isNonEmptyNonWhitespaceString(record.evidence)) {
      throw new Error(`assertRevisionVerificationLedgerIntegrity: record ${record.id} has empty/whitespace-only evidence`);
    }
    if (!isNonEmptyString(record.verifiedAt)) {
      throw new Error(`assertRevisionVerificationLedgerIntegrity: record ${record.id} has an invalid verifiedAt`);
    }
    if (seenRevisionActionIds.has(record.revisionActionId)) {
      throw new Error(
        `assertRevisionVerificationLedgerIntegrity: more than one RevisionVerification references revisionActionId ${record.revisionActionId} -- 0..1 cardinality violated`
      );
    }
    seenRevisionActionIds.add(record.revisionActionId);
  }
}

/**
 * Records one immutable, human-confirmed RevisionVerification against
 * `input.revisionActionId` (REVISION_VERIFICATION_CONTRACT.md §8, §10, §13.B).
 * `verdict`/`evidence` are always caller-supplied -- this function never
 * compares `sourceSession.artifactText` against `successorSession.artifactText`
 * to derive a verdict; it is a human-confirmation recorder, not a comparator
 * (§10 of this contract's own human authority model).
 *
 * Before appending the new record, the ENTIRE existing ledger is validated
 * (assertRevisionVerificationLedgerIntegrity) -- a pre-existing corrupt or
 * duplicate record elsewhere in the ledger blocks this write too, even one
 * unrelated to `input.revisionActionId` (P2-B Amendment 1).
 */
export function recordRevisionVerification(
  sourceSession: StressTestSession,
  successorSession: StressTestSession,
  input: { revisionActionId: string; verdict: RevisionVerificationVerdict; evidence: string }
): StressTestSession {
  assertRevisionSuccessorIntegrity(sourceSession, successorSession);
  assertRevisionVerificationLedgerIntegrity(sourceSession);

  const action = resolveExactRecord(sourceSession.revisionActions, input.revisionActionId);
  if (!action) {
    throw new Error(`recordRevisionVerification: unknown revisionActionId ${input.revisionActionId}`);
  }
  if (action.status !== 'IMPLEMENTED') {
    throw new Error(
      `recordRevisionVerification: revision action ${input.revisionActionId} is not IMPLEMENTED (status=${action.status})`
    );
  }
  if (!REVISION_VERIFICATION_VERDICTS.includes(input.verdict)) {
    throw new Error(`recordRevisionVerification: invalid verdict ${JSON.stringify(input.verdict)}`);
  }
  if (!isNonEmptyNonWhitespaceString(input.evidence)) {
    throw new Error('recordRevisionVerification: evidence must be a non-empty, non-whitespace-only string');
  }
  const isDuplicate = Object.values(sourceSession.revisionVerifications).some(
    (v) => v.revisionActionId === input.revisionActionId
  );
  if (isDuplicate) {
    throw new Error(
      `recordRevisionVerification: revision action ${input.revisionActionId} already has a RevisionVerification -- RevisionAction -> RevisionVerification is 0..1; no amendment, no overwrite`
    );
  }

  const record: RevisionVerification = {
    id: randomUUID(),
    revisionActionId: input.revisionActionId,
    verdict: input.verdict,
    evidence: input.evidence,
    verifiedAt: nowIso(),
  };

  const next: StressTestSession = {
    ...sourceSession,
    revisionVerifications: { ...sourceSession.revisionVerifications, [record.id]: record },
  };
  assertRevisionVerificationLedgerIntegrity(next);
  return next;
}

/**
 * Canonical, reusable later-read validator for one RevisionVerification
 * (REVISION_VERIFICATION_CONTRACT.md §14, this packet's §12-§15). Begins by
 * reusing assertRevisionSuccessorIntegrity rather than restating P2-A's
 * binding checks, then validates the ENTIRE revisionVerifications ledger --
 * not merely the requested record -- before trusting anything about it
 * (global integrity before local lookup): a hidden duplicate or a corrupt,
 * unrelated record elsewhere in the same session must never be masked by a
 * caller that only looked up one id.
 *
 * Proves only domain-boundary / later-read provenance and cardinality
 * consistency within this in-memory architecture -- never that the stored
 * human verdict is epistemically correct, and never protection against an
 * attacker able to coherently rewrite every authoritative object at once.
 */
export function assertRevisionVerificationIntegrity(
  sourceSession: StressTestSession,
  successorSession: StressTestSession,
  revisionVerificationId: string
): void {
  assertRevisionSuccessorIntegrity(sourceSession, successorSession);
  assertRevisionVerificationLedgerIntegrity(sourceSession);

  const record = resolveExactRecord(sourceSession.revisionVerifications, revisionVerificationId);
  if (!record) {
    throw new Error(`assertRevisionVerificationIntegrity: unknown revisionVerificationId ${revisionVerificationId}`);
  }
  if (record.id !== revisionVerificationId) {
    throw new Error(
      `assertRevisionVerificationIntegrity: record.id "${record.id}" does not match requested revisionVerificationId "${revisionVerificationId}"`
    );
  }
}
