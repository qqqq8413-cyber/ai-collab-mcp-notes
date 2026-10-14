import type { HumanPrincipalV1 } from '../identity/canonical.js';

// EXE-C1: a narrow operational request to a trusted host. This port cannot mint
// authority, select a run, or carry a model grant. Workspace owns no runner.
export interface GoalExecutionStepView {
  recordClass: 'OPERATIONAL_RECORD';
  authority: 'NOT_EXECUTION_AUTHORITY';
  runId: string | null;
  state: string | null;
  readiness: string;
  reason: string | null;
  canStep: boolean;
}

export interface GoalExecutionStepResult {
  recordClass: 'OPERATIONAL_RECORD';
  authority: 'NOT_EXECUTION_AUTHORITY';
  status: 'STEPPED' | 'NOT_STEPPED' | 'STALE_OR_ADVANCED';
  runnerCalls: number;
  runnerOutcome: string | null;
  preState: string | null;
  postState: string | null;
  readiness: GoalExecutionStepView;
}

export class GoalExecutionStepError extends Error {
  constructor(readonly code: 'STEP_BUSY' | 'STEP_BINDING_CONFLICT') {
    super(code === 'STEP_BUSY' ? 'Another step is already in progress.' : 'Governed run identity did not match the Goal.');
  }
}

export interface GoalExecutionStepPort {
  inspect(projectId: string, goalId: string, sessionHuman: HumanPrincipalV1): GoalExecutionStepView;
  step(projectId: string, goalId: string, sessionHuman: HumanPrincipalV1): Promise<GoalExecutionStepResult>;
}
