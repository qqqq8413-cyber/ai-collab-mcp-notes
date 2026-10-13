import type { HumanPrincipalV1 } from '../identity/canonical.js';

// G1-WE1-R0's injected read-only boundary. The Workspace names a project and a goal; the trusted
// host re-derives the Change, the ROOT run and every governance fact and answers with a bounded
// operational projection. The port can only inspect: nothing here steps, executes, activates,
// resumes, recovers, corrects, authorizes, promotes or drives, and no store, registry, archive,
// controller, runner or model capability crosses it. A status is a product projection of
// governed evidence, never execution authority.

export const GOAL_EXECUTION_STATUSES = Object.freeze(['GOAL_NOT_GOVERNED', 'RUN_NOT_ADMITTED', 'ROOT_PENDING', 'RUN_IDLE',
  'WAITING_PACKET', 'BLOCKED_AUTHORITY', 'BLOCKED_PROVENANCE', 'WAITING_EXTERNAL_ACTOR', 'WAITING_HUMAN', 'IN_PROGRESS', 'TERMINAL',
  'GOVERNANCE_CONFLICT'] as const);
export type GoalExecutionStatus = typeof GOAL_EXECUTION_STATUSES[number];

/** Who the governed next move waits for. AUTOMATED_ACTOR: the governed runner protocol, which this Workspace cannot start. */
export type ExecutionAttention = 'NONE' | 'HUMAN' | 'ARCHITECT' | 'HUMAN_AND_ARCHITECT' | 'AUTOMATED_ACTOR';

export interface GoalExecutionStatusView {
  readModelVersion: 'goal-execution-status.v0';
  recordClass: 'OPERATIONAL_RECORD';
  authority: 'NOT_EXECUTION_AUTHORITY';
  status: GoalExecutionStatus;
  /** A bounded reason code for BLOCKED_AUTHORITY, BLOCKED_PROVENANCE (RP1-C1 refusal) or GOVERNANCE_CONFLICT; otherwise null. */
  reason: string | null;
  /** Whether a provider or model call is authorized is never evaluated here: the live-call configuration is not held. */
  executionEligibility: 'EXECUTION_ELIGIBILITY_NOT_EVALUATED';
  attention: ExecutionAttention;
  change: { kind: 'SLICE'; changeId: string; changeKey: string; repository: string } | null;
  run: { runId: string; state: string; terminal: boolean; admission: 'ROOT' } | null;
  /** The lifecycle moves the governed evidence allows next, each with the one role that may take it. */
  nextMoves: { action: string; role: string }[];
  /** Required direct authority the run rests on that resolves exactly in the archive: identifiers only, never a body. */
  directAuthority: { recordClass: 'DIRECT_AUTHORITY'; kind: string; authorityId: string; version: number }[];
  /** Required direct authority that does not resolve: identifiers and the resolution code only. */
  unresolvedAuthority: { kind: string; authorityId: string; resolution: string }[];
  /** Operational provenance of the run, never authority. */
  operationalProvenance: { recordClass: 'OPERATIONAL_RECORD'; activationBound: boolean } | null;
  snapshotId: string | null;
  notice: string;
}

export type GoalExecutionStatusErrorCode = 'UNKNOWN_PROJECT' | 'UNKNOWN_GOAL' | 'UNATTRIBUTED_GOAL' | 'GOAL_PRINCIPAL_MISMATCH' |
  'GOVERNANCE_STORE_ISOLATION';

const messages: Record<GoalExecutionStatusErrorCode, string> = {
  UNKNOWN_PROJECT: 'This project has no trusted governance binding.',
  UNKNOWN_GOAL: 'This goal is not in the durable queue.',
  UNATTRIBUTED_GOAL: 'This goal has no recorded Human attribution.',
  GOAL_PRINCIPAL_MISMATCH: 'This goal belongs to a different Human principal.',
  GOVERNANCE_STORE_ISOLATION: 'The governance storage isolation check failed.',
};

export class GoalExecutionStatusError extends Error {
  constructor(readonly code: GoalExecutionStatusErrorCode) {
    super(messages[code]);
    this.name = 'GoalExecutionStatusError';
  }
}

export interface GoalExecutionStatusPort {
  inspect(projectId: string, goalId: string, sessionHuman: HumanPrincipalV1): GoalExecutionStatusView;
}
