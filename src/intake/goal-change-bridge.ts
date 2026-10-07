import { join, resolve } from 'node:path';
import { ChangeMintError, changeRefOf, type ChangeMintRecordV1 } from '../automation/change-mint.js';
import { openChangeMinter, openChangeRegistryReader } from '../automation/change-registry.js';
import { GovernanceStoreIsolation, GovernanceStoreIsolationError } from '../automation/governance-store-isolation.js';
import { parseHumanPrincipalV1, type HumanPrincipalV1 } from '../identity/canonical.js';
import { type WorkspaceConfig } from '../workspace/config.js';
import { FileGoalStore, GoalQueueRequestError, GoalStoreBusyError } from '../workspace/goal-store.js';
import { GoalGovernanceError, type GoalGovernancePort, type GoalGovernanceView, type GovernedGoalView } from '../workspace/goal-governance-port.js';
import { WORKSPACE_UI_FILES } from '../workspace/server.js';
import { GoalBindingError, changeMintRequestOf, goalSourceOf, governedRepositoryResolver, requireGoalChangeBinding,
  requireGoalHuman } from './goal-change-binding.js';
import { parseGovernedRepositories, type GovernedRepositoryBinding } from './workspace-host-config.js';

export interface GoalChangeBridgeOptions {
  config: WorkspaceConfig;
  governedRepositories: readonly GovernedRepositoryBinding[];
  changeRegistryDirectory: string;
  uiDirectory: string;
}

function view(record: ChangeMintRecordV1): GovernedGoalView {
  return { provenance: 'CHANGE_REGISTRY', state: 'GOVERNED', sourceKey: record.sourceKey,
    change: changeRefOf(record), changeKey: record.changeKey, repository: record.repository,
    recordClass: 'OPERATIONAL_RECORD', sourceClassification: 'LOCAL_OPERATOR_INPUT',
    sourceNotice: 'Non-authoritative local operator input.', execution: 'NOT_STARTED', runCreated: false };
}

function mapped(error: unknown): never {
  if (error instanceof GovernanceStoreIsolationError) throw new GoalGovernanceError('GOVERNANCE_STORE_ISOLATION');
  if (error instanceof GoalStoreBusyError) throw new GoalGovernanceError('GOAL_STORE_BUSY');
  if (error instanceof GoalBindingError) throw new GoalGovernanceError(error.code);
  if (error instanceof GoalQueueRequestError && error.code === 'UNKNOWN_GOAL') throw new GoalGovernanceError('UNKNOWN_GOAL');
  if (error instanceof ChangeMintError) {
    if (error.code === 'UNATTRIBUTED_SOURCE') throw new GoalGovernanceError('UNATTRIBUTED_GOAL');
    if (error.code === 'INVALID_CHANGE_SOURCE') throw new GoalGovernanceError('REGISTRY_INTEGRITY');
    throw new GoalGovernanceError(error.code);
  }
  throw error;
}

/** The sole trusted GC1 mint composition. Only the queue and narrow port leave this module. */
export function createGoalChangeBridge(options: GoalChangeBridgeOptions): { store: FileGoalStore; governance: GoalGovernancePort } {
  const repositoryFor = governedRepositoryResolver(parseGovernedRepositories(options.governedRepositories, options.config));
  const goalRoot = options.config.dataDirectory;
  const uiRoot = resolve(options.uiDirectory);
  const isolation = GovernanceStoreIsolation.forGoalChangeBridge(options.changeRegistryDirectory);
  const assertIsolated = () => {
    isolation.assertDisjoint('Workspace Goal Store', goalRoot);
    isolation.assertDisjoint('Workspace UI directory', uiRoot);
    for (const file of WORKSPACE_UI_FILES) isolation.assertDisjoint('Workspace UI asset', join(uiRoot, file));
  };
  // Check before creating the Goal Store or opening a writer. Unsafe roots are never repaired.
  assertIsolated();
  const reader = openChangeRegistryReader(options.changeRegistryDirectory);
  const store = new FileGoalStore(goalRoot);
  const minter = openChangeMinter(options.changeRegistryDirectory);

  const governance: GoalGovernancePort = Object.freeze({
    lookup(projectId: string, goalId: string, sessionHuman: HumanPrincipalV1): GoalGovernanceView {
      try {
        const principal = parseHumanPrincipalV1(sessionHuman);
        const repository = repositoryFor(projectId, goalId);
        assertIsolated();
        const goal = store.read(projectId).goals.find((item) => item.goalId === goalId);
        if (!goal) throw new GoalGovernanceError('UNKNOWN_GOAL');
        const record = reader.getBySource(goalSourceOf(projectId, goalId));
        if (!record) return { provenance: 'CHANGE_REGISTRY', state: 'NOT_GOVERNED' };
        requireGoalHuman(goal, principal);
        return view(requireGoalChangeBinding(record, goal, repository));
      } catch (error) { return mapped(error); }
    },
    async govern(projectId: string, goalId: string, sessionHuman: HumanPrincipalV1): Promise<GovernedGoalView> {
      try {
        const principal = parseHumanPrincipalV1(sessionHuman);
        const repository = repositoryFor(projectId, goalId);
        assertIsolated();
        return await store.withLockedGoal(projectId, goalId, (goal) => {
          assertIsolated();
          requireGoalHuman(goal, principal);
          return view(minter.mint(changeMintRequestOf(goal, repository)));
        });
      } catch (error) { return mapped(error); }
    },
  });
  return Object.freeze({ store, governance });
}
