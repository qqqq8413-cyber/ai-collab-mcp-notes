import type { HumanPrincipalV1 } from '../identity/canonical.js';

// GC1's injected operational boundary. No raw registry, authority or execution capability.
export type GoalGovernanceErrorCode = 'UNKNOWN_PROJECT' | 'UNKNOWN_GOAL' | 'UNATTRIBUTED_GOAL' |
  'GOAL_PRINCIPAL_MISMATCH' | 'GOAL_ALREADY_GOVERNED' | 'CHANGE_SOURCE_BINDING_CONFLICT' |
  'REGISTRY_INTEGRITY' | 'PUBLICATION_UNAVAILABLE' | 'GOVERNANCE_STORE_ISOLATION' | 'GOAL_STORE_BUSY';

const messages: Record<GoalGovernanceErrorCode, string> = {
  UNKNOWN_PROJECT: 'This project has no trusted governance binding.',
  UNKNOWN_GOAL: 'This goal is not in the durable queue.',
  UNATTRIBUTED_GOAL: 'This goal has no recorded Human attribution.',
  GOAL_PRINCIPAL_MISMATCH: 'This goal belongs to a different Human principal.',
  GOAL_ALREADY_GOVERNED: 'This goal already has a governed Change and cannot be removed.',
  CHANGE_SOURCE_BINDING_CONFLICT: 'This goal already has a different governed Change binding.',
  REGISTRY_INTEGRITY: 'The Change Registry failed its integrity check; nothing was repaired.',
  PUBLICATION_UNAVAILABLE: 'Safe Change publication is unavailable; no fallback was used.',
  GOVERNANCE_STORE_ISOLATION: 'The governance storage isolation check failed.',
  GOAL_STORE_BUSY: 'The goal queue is locked by another operation; nothing was changed.',
};

export class GoalGovernanceError extends Error {
  constructor(readonly code: GoalGovernanceErrorCode) {
    super(messages[code]);
    this.name = 'GoalGovernanceError';
  }
}

export interface GovernedGoalView {
  provenance: 'CHANGE_REGISTRY';
  state: 'GOVERNED';
  sourceKey: string;
  change: { kind: 'SLICE'; changeId: string };
  changeKey: string;
  repository: string;
  recordClass: 'OPERATIONAL_RECORD';
  sourceClassification: 'LOCAL_OPERATOR_INPUT';
  sourceNotice: 'Non-authoritative local operator input.';
  execution: 'NOT_STARTED';
  runCreated: false;
}
export type GoalGovernanceView = GovernedGoalView | { provenance: 'CHANGE_REGISTRY'; state: 'NOT_GOVERNED' };

export interface GoalGovernancePort {
  lookup(projectId: string, goalId: string, sessionHuman: HumanPrincipalV1): GoalGovernanceView;
  govern(projectId: string, goalId: string, sessionHuman: HumanPrincipalV1): Promise<GovernedGoalView>;
}
