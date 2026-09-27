import { contextFingerprint } from '../context/fingerprint.js';
import {
  CONTEXT_PACK_SCHEMA_VERSION,
  deepFreeze,
  readContextPack,
  sealContextPack,
  snapshotContextPackPolicy,
  snapshotContextPackSelection,
  type ContextPackParts,
} from '../context/pack.js';
import type {
  ArtifactExcerpt,
  AuthorContextCategory,
  ContextPack,
  ContextPackSelection,
  ContextPackSource,
  ContextPackSourcePort,
  ContextPackStaleReason,
  ContextPackVerification,
} from '../context/types.js';
import { bindConsultationRoute } from './consultation-binding.js';
import {
  assertRouteOutcomeIntegrity,
  isQuestionCurrent,
  verifyDeliberationBinding,
  type DeliberationState,
  type DeliberationStateAccessPort,
  type RouteInputRef,
} from './deliberation.js';
import { isReviewFindingShape, isSemanticIssueShape, resolveExactRecord } from './reference.js';
import { assertRevisionVerificationLedgerIntegrity } from './session.js';
import type { AuthorContextItem, StressTestSession } from './types.js';

const AUTHOR_CONTEXT_CATEGORIES: readonly AuthorContextCategory[] = ['confirmedFacts', 'knownRisks', 'openQuestions', 'constraints'];

/**
 * Global before local. Every canonical read boundary this repository exposes over the
 * session and the deliberation state runs before any one route source is selected, so a
 * requested record that looks valid on its own cannot carry a pack out of corrupt state.
 * Each rule stays in the validator that owns it; nothing here restates one.
 */
function assertCanonicalReadIntegrity(session: StressTestSession, current: DeliberationState): void {
  // Frozen artifact and author-context hashes, and the state's binding to them.
  verifyDeliberationBinding(session, current);
  // SemanticIssue -> HumanAdjudication -> RevisionAction -> RevisionVerification ledgers.
  assertRevisionVerificationLedgerIntegrity(session);
  // Question identity, derived lineage, and the disposition ledger; each call checks the whole graph.
  for (const question of current.unresolvedQuestions) isQuestionCurrent(current, question.id);
  // Every attempt and every outcome, not only the attempt being asked about.
  const attemptIds = new Set<string>();
  for (const attempt of current.attempts) attemptIds.add(attempt.attemptId);
  for (const outcome of current.outcomes) attemptIds.add(outcome.attemptId);
  for (const attemptId of attemptIds) assertRouteOutcomeIntegrity(session, current, attemptId);
}

/** One exact canonical record per ref. Unknown, ambiguous, malformed, or inherited never resolves. */
function resolveSource(session: StressTestSession, ref: RouteInputRef): ContextPackSource {
  switch (ref.kind) {
    case 'FINDING': {
      const finding = resolveExactRecord(session.findings, ref.id, isReviewFindingShape);
      if (!finding) throw new Error(`ContextPack FINDING ${ref.id} does not resolve exactly`);
      return { ref: { kind: 'FINDING', id: ref.id }, value: structuredClone(finding) };
    }
    case 'SEMANTIC_ISSUE': {
      const issue = resolveExactRecord(session.semanticIssues, ref.id, isSemanticIssueShape);
      if (!issue) throw new Error(`ContextPack SEMANTIC_ISSUE ${ref.id} does not resolve exactly`);
      return { ref: { kind: 'SEMANTIC_ISSUE', id: ref.id }, value: structuredClone(issue) };
    }
    case 'AUTHOR_CONTEXT_ITEM': {
      const matches: Array<{ category: AuthorContextCategory; item: AuthorContextItem }> = [];
      for (const category of AUTHOR_CONTEXT_CATEGORIES) {
        const items = session.authorContext[category];
        if (!Array.isArray(items)) throw new Error(`ContextPack author context category ${category} is not a list`);
        for (const item of items) {
          if (item !== null && typeof item === 'object' && item.id === ref.id) matches.push({ category, item });
        }
      }
      if (matches.length !== 1) {
        throw new Error(`ContextPack AUTHOR_CONTEXT_ITEM ${ref.id} does not resolve to exactly one item in one category`);
      }
      const [{ category, item }] = matches;
      return { ref: { kind: 'AUTHOR_CONTEXT_ITEM', id: ref.id }, category, value: structuredClone(item) };
    }
    default: {
      const exhaustive: never = ref;
      throw new Error(`ContextPack ref kind ${JSON.stringify((exhaustive as { kind: unknown }).kind)} is not supported`);
    }
  }
}

/** Offsets are UTF-16 code units into the frozen artifact. The text is always sliced here, never supplied. */
function excerpt(session: StressTestSession, range: { startChar: number; endChar: number }): ArtifactExcerpt {
  const { startChar, endChar } = range;
  const text = session.artifactText;
  if (!(startChar >= 0 && startChar < endChar && endChar <= text.length)) {
    throw new RangeError(`ContextPack artifact selection must satisfy 0 <= startChar < endChar <= ${text.length}`);
  }
  return { selectionScope: 'EXCERPT', startChar, endChar, text: text.slice(startChar, endChar) };
}

/**
 * The canonical stress-test ContextPack source. Read-only: it resolves the current
 * DeliberationState on every call, validates globally, binds the route through the same
 * definition E0-R5 consultation uses, and copies exact records. It records nothing,
 * starts nothing, and never follows a successor session.
 */
export function createStressTestContextPackSource(
  session: StressTestSession,
  stateAccess: DeliberationStateAccessPort,
  deliberationStateId: string,
  policy: unknown,
  options: { now?: () => Date } = {}
): ContextPackSourcePort {
  if (session === null || typeof session !== 'object') throw new TypeError('ContextPack source requires a StressTestSession');
  if (!stateAccess || typeof stateAccess.resolveCurrentDeliberationState !== 'function') {
    throw new TypeError('ContextPack source requires a DeliberationStateAccessPort');
  }
  if (typeof deliberationStateId !== 'string' || !deliberationStateId.trim()) {
    throw new TypeError('ContextPack source requires a deliberationStateId');
  }
  const budget = snapshotContextPackPolicy(policy);
  const now = options.now ?? (() => new Date());
  if (typeof now !== 'function') throw new TypeError('ContextPack source clock must be a function');

  const resolveCurrent = (): DeliberationState => {
    const current = stateAccess.resolveCurrentDeliberationState(deliberationStateId);
    if (current === null || typeof current !== 'object' || current.id !== deliberationStateId) {
      throw new Error('ContextPack state access returned a different deliberation state');
    }
    return current;
  };

  const project = (current: DeliberationState, selection: ContextPackSelection): ContextPackParts => {
    assertCanonicalReadIntegrity(session, current);
    const binding = bindConsultationRoute(session, current, deliberationStateId, selection.attemptId);
    // The shared binding already proved this question resolves exactly once.
    const question = current.unresolvedQuestions.filter((entry) => entry.id === binding.questionId)[0];
    const parts: ContextPackParts = {
      binding: {
        deliberationStateId: binding.deliberationStateId,
        sessionId: binding.sessionId,
        artifactHash: binding.artifactHash,
        authorContextHash: binding.authorContextHash,
        attemptId: binding.attemptId,
        decisionId: binding.decisionId,
        questionId: binding.questionId,
        route: binding.route,
        inputRefs: binding.inputRefs.map((ref) => ({ kind: ref.kind, id: ref.id }) as RouteInputRef),
      },
      question: { rootCause: question.rootCause, materialityReason: question.materialityReason },
      sources: binding.inputRefs.map((ref) => resolveSource(session, ref)),
    };
    if (selection.artifactSelection) parts.artifact = excerpt(session, selection.artifactSelection);
    return parts;
  };

  const capturedAt = (): string => {
    const date = now();
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new TypeError('ContextPack source clock returned an invalid Date');
    return date.toISOString();
  };

  return Object.freeze({
    build(value: unknown): ContextPack {
      const selection = snapshotContextPackSelection(value);
      const current = resolveCurrent();
      return sealContextPack(project(current, selection), budget, capturedAt());
    },

    /**
     * Currentness is structural, never an age: the pack must be intact, bound to this
     * session and state, and projecting its selection from current canonical facts must
     * give its fingerprint. The offered pack is never changed or refreshed.
     */
    verifyCurrent(value: unknown): ContextPackVerification {
      const pack = readContextPack(value);
      if (pack.binding.deliberationStateId !== deliberationStateId || pack.binding.sessionId !== session.id) {
        throw new Error('ContextPack is bound to a different deliberation state or session; a pack never rebinds');
      }
      const current = resolveCurrent();
      assertCanonicalReadIntegrity(session, current);
      if (pack.binding.artifactHash !== session.artifactHash || pack.binding.authorContextHash !== session.authorContextHash) {
        throw new Error("ContextPack hashes do not match the session's frozen hashes");
      }
      const attempts = current.attempts.filter((attempt) => attempt.attemptId === pack.binding.attemptId);
      if (attempts.length !== 1) throw new Error('ContextPack attempt does not resolve exactly once in the current state');

      const stale = (reason: ContextPackStaleReason, currentFingerprint?: string): ContextPackVerification =>
        deepFreeze({ status: 'STALE', reason, contextFingerprint: pack.contextFingerprint,
          ...(currentFingerprint ? { currentFingerprint } : {}) });
      if (current.stopReason !== null) return stale('DELIBERATION_STOPPED');
      if (current.outcomes.some((outcome) => outcome.attemptId === pack.binding.attemptId)) return stale('ROUTE_OUTCOME_RECORDED');
      if (!isQuestionCurrent(current, attempts[0].questionId)) return stale('QUESTION_NOT_CURRENT');

      const selection: ContextPackSelection = { attemptId: pack.binding.attemptId };
      if (pack.artifact) selection.artifactSelection = { startChar: pack.artifact.startChar, endChar: pack.artifact.endChar };
      const currentFingerprint = contextFingerprint({ schemaVersion: CONTEXT_PACK_SCHEMA_VERSION, ...project(current, selection) });
      return currentFingerprint === pack.contextFingerprint
        ? deepFreeze({ status: 'CURRENT', contextFingerprint: pack.contextFingerprint })
        : stale('SOURCE_CHANGED', currentFingerprint);
    },
  });
}
