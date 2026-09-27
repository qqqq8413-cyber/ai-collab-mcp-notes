import { z } from 'zod';
import { parseAcceptanceDecision } from './lifecycle.js';
import {
  STOP_CLASSES, type AcceptanceDecision, type Actor, type ControllerRun, type CorrectionPacket, type ImplementationPacket,
  type RemoteShaEvidence, type StopClass,
} from './types.js';

// The bridge contract between the automation runner and the two external actors it
// drives. A port receives detached, deeply frozen data and returns only what its role
// may state. Neither port names a controller role, a repository fact, or an authority:
// branch, SHA, CI, and protection come from the controller's repository reality port,
// and acceptance comes only from the controller's own validation of a review.

/**
 * The protocol actors the runner acts as. They are composition-owned: callers never
 * pass an actor to the runner, and nothing a port returns can choose or change one.
 * The implementation role keeps the controller's existing vocabulary; it does not
 * say which agent implements.
 */
export const IMPLEMENTATION_ACTOR: Readonly<Actor> = Object.freeze({ id: 'automation-implementation-agent', role: 'CODEX_IMPLEMENTER' });
export const ARCHITECT_REVIEW_ACTOR: Readonly<Actor> = Object.freeze({ id: 'automation-architect-review', role: 'GPT_ARCHITECT' });
export const RUNNER_ACTOR: Readonly<Actor> = Object.freeze({ id: 'automation-runner', role: 'CONTROLLER' });

/** What an implementation agent is given: the frozen packet, and the correction when one governs this iteration. */
export interface ImplementationInput {
  runId: string;
  sliceId: string;
  implementationIteration: number;
  packet: ImplementationPacket;
  packetHash: string;
  correction?: CorrectionPacket;
}

/**
 * What an implementation agent may report: completion with validation evidence, or
 * the operational stop class that applies, with a reason. Nothing else is part of a
 * result, so a result that states a SHA, branch, CI, protection, acceptance,
 * promotion, or human fact is refused, not read.
 */
export type ImplementationResult =
  | { status: 'COMPLETED'; validationEvidence: string[] }
  | { status: StopClass; reason: string };

export interface ImplementationAgentPort {
  execute(input: Readonly<ImplementationInput>): ImplementationResult | Promise<ImplementationResult>;
}

/** What the architect reviewer is given. `remoteSha` is the controller's recorded repository evidence. */
export interface ArchitectReviewInput {
  runId: string;
  sliceId: string;
  implementationIteration: number;
  acceptanceFailures: number;
  packet: ImplementationPacket;
  packetHash: string;
  remoteSha: RemoteShaEvidence;
  correction?: CorrectionPacket;
}

/**
 * One AcceptanceDecision and, only with a REJECT, optionally the exact correction for
 * the next iteration. The runner hands both to the controller's validators as given;
 * it repairs nothing.
 */
export interface ArchitectReviewBundle {
  decision: AcceptanceDecision;
  correction?: CorrectionPacket;
}

export interface ArchitectReviewPort {
  review(input: Readonly<ArchitectReviewInput>): ArchitectReviewBundle | Promise<ArchitectReviewBundle>;
}

// Report sizes are bounded; the controller's own text rule (trimmed, non-empty) applies.
const MAX_EVIDENCE_ENTRIES = 50;
const MAX_TEXT = 2000;
const text = z.string().trim().min(1).max(MAX_TEXT);
const implementationResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('COMPLETED'), validationEvidence: z.array(text).min(1).max(MAX_EVIDENCE_ENTRIES) }),
  z.strictObject({ status: z.enum(STOP_CLASSES), reason: text }),
]);
const reviewBundleSchema = z.strictObject({ decision: z.unknown(), correction: z.unknown().optional() });

/** A validated copy of an implementation result. Throws on anything outside the contract. */
export function parseImplementationResult(value: unknown): ImplementationResult {
  return implementationResultSchema.parse(value) as ImplementationResult;
}

/**
 * A validated copy of a review's decision, read once with the controller's own
 * decision schema so the controller is given exactly what was checked here. Binding
 * to the active packet and remote SHA is left to the controller. The correction is
 * passed through unread: the controller parses and validates it.
 */
export function parseReviewBundle(value: unknown): { decision: AcceptanceDecision; correction?: unknown } {
  const bundle = reviewBundleSchema.parse(value);
  const decision = parseAcceptanceDecision(bundle.decision);
  if (bundle.correction === undefined) return { decision };
  if (decision.decision !== 'REJECT') throw new Error('Only a REJECT may carry a correction packet');
  return { decision, correction: bundle.correction };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const member of Object.values(value)) deepFreeze(member);
    Object.freeze(value);
  }
  return value;
}

/** The correction the current iteration answers, if any: the controller admits iteration N only with correction N. */
function governingCorrection(run: ControllerRun): CorrectionPacket | undefined {
  const correction = run.correctionPacket;
  return correction && correction.correctionIteration === run.implementationIterations ? correction : undefined;
}

export function implementationInput(run: ControllerRun): Readonly<ImplementationInput> {
  const correction = governingCorrection(run);
  return deepFreeze(structuredClone({ runId: run.runId, sliceId: run.sliceId,
    implementationIteration: run.implementationIterations, packet: run.activePacket!, packetHash: run.activePacketHash!,
    ...(correction ? { correction } : {}) }));
}

export function reviewInput(run: ControllerRun): Readonly<ArchitectReviewInput> {
  const correction = governingCorrection(run);
  return deepFreeze(structuredClone({ runId: run.runId, sliceId: run.sliceId,
    implementationIteration: run.implementationIterations, acceptanceFailures: run.acceptanceFailures,
    packet: run.activePacket!, packetHash: run.activePacketHash!, remoteSha: run.remoteSha!,
    ...(correction ? { correction } : {}) }));
}
