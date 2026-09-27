import type { ConsultationRouteBinding, ConsultationRouteBindingPort } from '../consultation/types.js';
import {
  isQuestionCurrent,
  routeForRootCause,
  validateRouteInputRef,
  verifyDeliberationBinding,
  type DeliberationState,
  type DeliberationStateAccessPort,
  type RouteInputRef,
} from './deliberation.js';
import type { StressTestSession } from './types.js';

function refsMatch(a: RouteInputRef[], b: RouteInputRef[]): boolean {
  return a.length === b.length && a.every((ref, index) => ref.kind === b[index].kind && ref.id === b[index].id);
}

/**
 * The one definition of a supported consultation route binding, read from a state the
 * caller has already resolved. The port below and every other read-only consumer share
 * it, so route provenance never has a second meaning. It writes nothing.
 */
export function bindConsultationRoute(
  session: StressTestSession,
  current: DeliberationState,
  deliberationStateId: string,
  attemptId: string
): ConsultationRouteBinding {
  if (typeof attemptId !== 'string' || !attemptId.trim()) throw new TypeError('Consultation attemptId is invalid');
  if (current.id !== deliberationStateId) throw new Error('Consultation state access returned a different deliberation state');
  verifyDeliberationBinding(session, current);
  if (current.stopReason !== null) throw new Error('Consultation deliberation has stopped');

  const attempts = current.attempts.filter((entry) => entry.attemptId === attemptId);
  if (attempts.length !== 1) throw new Error('Consultation attemptId does not resolve to exactly one RouteAttempt');
  const attempt = attempts[0];
  if (attempt.route !== 'ADD_REVIEWER' && attempt.route !== 'REPLICATE') {
    throw new Error(`Consultation does not execute route ${attempt.route}`);
  }
  if (current.outcomes.some((outcome) => outcome.attemptId === attemptId)) {
    throw new Error('Consultation attempt already has a RouteOutcome');
  }
  if (attempt.sessionId !== current.sessionId || attempt.sessionId !== session.id ||
      attempt.artifactHash !== current.artifactHash || attempt.artifactHash !== session.artifactHash ||
      attempt.authorContextHash !== current.authorContextHash || attempt.authorContextHash !== session.authorContextHash ||
      attempt.logicalCost !== 1 || Number.isNaN(Date.parse(attempt.startedAt))) {
    throw new Error('Consultation RouteAttempt provenance does not match the current session');
  }
  const decisions = current.history.filter((entry) => entry.id === attempt.decisionId);
  const questions = current.unresolvedQuestions.filter((entry) => entry.id === attempt.questionId);
  if (decisions.length !== 1 || questions.length !== 1) {
    throw new Error('Consultation decision or question does not resolve exactly once');
  }
  const decision = decisions[0];
  const question = questions[0];
  if (decision.route !== attempt.route || decision.questionId !== attempt.questionId ||
      decision.reason.rootCause !== question.rootCause ||
      decision.reason.materialityReason !== question.materialityReason ||
      routeForRootCause(question.rootCause) !== attempt.route ||
      !refsMatch(decision.inputRefs, question.inputRefs)) {
    throw new Error('Consultation attempt, decision, and question disagree');
  }
  if (!isQuestionCurrent(current, question.id)) throw new Error('Consultation question is no longer current');
  for (const ref of question.inputRefs) validateRouteInputRef(session, ref);
  const inputRefs = question.inputRefs.map((ref) => ({ kind: ref.kind, id: ref.id }) as RouteInputRef);
  return Object.freeze({
    deliberationStateId: current.id, sessionId: session.id,
    artifactHash: current.artifactHash, authorContextHash: current.authorContextHash,
    attemptId: attempt.attemptId, decisionId: decision.id, questionId: question.id,
    route: attempt.route, inputRefs: Object.freeze(inputRefs.map((ref) => Object.freeze(ref))),
  }) as ConsultationRouteBinding;
}

/** Read current canonical domain state on every resolution; this port never claims execution. */
export function createConsultationRouteBindingPort(
  session: StressTestSession,
  stateAccess: DeliberationStateAccessPort,
  deliberationStateId: string
): ConsultationRouteBindingPort {
  if (typeof deliberationStateId !== 'string' || !deliberationStateId.trim()) {
    throw new TypeError('Consultation binding requires a deliberationStateId');
  }
  return Object.freeze({
    resolve(attemptId: string): ConsultationRouteBinding {
      if (typeof attemptId !== 'string' || !attemptId.trim()) throw new TypeError('Consultation attemptId is invalid');
      const current = stateAccess.resolveCurrentDeliberationState(deliberationStateId);
      return bindConsultationRoute(session, current, deliberationStateId, attemptId);
    },
  });
}
