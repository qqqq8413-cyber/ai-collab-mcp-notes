import type { HumanPrincipalV1 } from '../identity/canonical.js';

// EXE-C2: Goal-scoped request to use a pre-provisioned, fully issued authority
// bundle held only by the trusted host. Browsers cannot supply documents, grants,
// identities, run IDs, packet IDs, provider settings or a budget.
export interface GoalActivationView {
  recordClass: 'OPERATIONAL_RECORD';
  authority: 'NOT_EXECUTION_AUTHORITY';
  readiness: 'NO_ROOT' | 'NO_APPROVED_PLAN' | 'PLAN_MISMATCH' | 'READY' | 'RETRY_REQUIRED' | 'ALREADY_ACTIVATED' | 'ADVANCED';
  canActivate: boolean;
  state: string | null;
  packetId: string | null;
  reason: string | null;
}

export interface GoalActivationResult {
  recordClass: 'OPERATIONAL_RECORD';
  authority: 'NOT_EXECUTION_AUTHORITY';
  status: 'ACTIVATED' | 'ALREADY_ACTIVATED' | 'NOT_ACTIVATED';
  readiness: GoalActivationView;
}

export class GoalActivationError extends Error {
  constructor(readonly code: 'ACTIVATION_BUSY' | 'ACTIVATION_BINDING_CONFLICT' | 'ACTIVATION_REFUSED') {
    super(code);
  }
}
export interface GoalActivationPort {
  inspect(projectId: string, goalId: string, sessionHuman: HumanPrincipalV1): GoalActivationView;
  activate(projectId: string, goalId: string, sessionHuman: HumanPrincipalV1): Promise<GoalActivationResult>;
}
