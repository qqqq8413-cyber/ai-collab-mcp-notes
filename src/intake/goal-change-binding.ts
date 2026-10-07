import { requireSameChangeBinding, type ChangeMintRecordV1, type ChangeMintRequestV1,
  type ChangeSourceIdentityV1 } from '../automation/change-mint.js';
import { GOAL_ID, type HumanPrincipalV1 } from '../identity/canonical.js';
import { type GoalRecord } from '../workspace/goal-store.js';
import { type GovernedRepositoryBinding } from './workspace-host-config.js';

// The one definition of how a durable Workspace Goal binds to its governed Change, shared by
// GC1 (mint) and RA1 (run admission) so the two can never disagree. Pure: it holds no store,
// registry or controller capability and reads nothing itself.

export type GoalBindingErrorCode = 'UNKNOWN_PROJECT' | 'UNKNOWN_GOAL' | 'UNATTRIBUTED_GOAL' | 'GOAL_PRINCIPAL_MISMATCH';

export class GoalBindingError extends Error {
  constructor(readonly code: GoalBindingErrorCode) {
    super(code);
    this.name = 'GoalBindingError';
  }
}

/** The governed repository of a project, from trusted configuration only. The display repository plays no part. */
export function governedRepositoryResolver(bindings: readonly GovernedRepositoryBinding[]):
  (projectId: string, goalId: string) => string {
  const repositories = new Map(bindings.map((binding) => [binding.projectId, binding.repository]));
  return (projectId, goalId) => {
    const repository = repositories.get(projectId);
    if (!repository) throw new GoalBindingError('UNKNOWN_PROJECT');
    if (typeof goalId !== 'string' || !GOAL_ID.test(goalId)) throw new GoalBindingError('UNKNOWN_GOAL');
    return repository;
  };
}

/** The stored attribution must equal the server-derived session Human exactly. History is never rewritten or adopted. */
export function requireGoalHuman(goal: GoalRecord, principal: HumanPrincipalV1): void {
  if (goal.submittedBy === null) throw new GoalBindingError('UNATTRIBUTED_GOAL');
  if (goal.submittedBy.schemaVersion !== principal.schemaVersion || goal.submittedBy.kind !== principal.kind ||
      goal.submittedBy.principalRef !== principal.principalRef) throw new GoalBindingError('GOAL_PRINCIPAL_MISMATCH');
}

export function goalSourceOf(projectId: string, goalId: string): ChangeSourceIdentityV1 {
  return { kind: 'WORKSPACE_GOAL', projectId, goalId };
}

/** The CM1 mint request of the exact durable Goal: its stored text, time and attribution, nothing from a browser. */
export function changeMintRequestOf(goal: GoalRecord, repository: string): ChangeMintRequestV1 {
  if (goal.submittedBy === null) throw new GoalBindingError('UNATTRIBUTED_GOAL');
  return { repository, source: { schemaVersion: 1, kind: 'WORKSPACE_GOAL', projectId: goal.projectId,
    goalId: goal.goalId, createdAt: goal.createdAt, submittedBy: goal.submittedBy, objective: goal.text } };
}

/** The registry record, validated against the exact durable Goal with CM1's own binding check. */
export function requireGoalChangeBinding(record: ChangeMintRecordV1, goal: GoalRecord, repository: string): ChangeMintRecordV1 {
  return requireSameChangeBinding(record, changeMintRequestOf(goal, repository));
}
