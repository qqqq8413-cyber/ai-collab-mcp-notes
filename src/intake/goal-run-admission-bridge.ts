import { join, resolve } from 'node:path';
import { ChangeMintError, changeRefOf, type ChangeMintRecordV1 } from '../automation/change-mint.js';
import { openChangeRegistryReader } from '../automation/change-registry.js';
import { GovernanceStoreIsolation, GovernanceStoreIsolationError } from '../automation/governance-store-isolation.js';
import { RootRunAdmissionError, openRootRunAdmitter, type AdmittedRootRun, type GovernedChangeIdentity } from '../automation/root-run-admitter.js';
import { parseHumanPrincipalV1, type HumanPrincipalV1 } from '../identity/canonical.js';
import { type WorkspaceConfig } from '../workspace/config.js';
import { type FileGoalStore, GoalQueueRequestError, GoalStoreBusyError, type GoalRecord } from '../workspace/goal-store.js';
import { GoalRunAdmissionError, type AdmittedGoalRunView, type GoalRunAdmissionPort,
  type GoalRunView } from '../workspace/goal-run-admission-port.js';
import { WORKSPACE_UI_FILES } from '../workspace/server.js';
import { GoalBindingError, goalSourceOf, governedRepositoryResolver, requireGoalChangeBinding,
  requireGoalHuman } from './goal-change-binding.js';
import { parseGovernedRepositories, type GovernedRepositoryBinding } from './workspace-host-config.js';

// G1-RA1: the sole trusted path from an already-governed Workspace Goal to its Change's one
// ROOT run. It re-reads the durable Goal under the Goal Store's cross-process project lock,
// requires the session Human, requires the existing GC1 Change (it never mints one), and
// admits through the narrow root-run admitter. The browser names only the project and goal.
// It holds read access to the Change Registry and nothing else of it.

export interface GoalRunAdmissionBridgeOptions {
  config: WorkspaceConfig;
  governedRepositories: readonly GovernedRepositoryBinding[];
  changeRegistryDirectory: string;
  controllerStoreDirectory: string;
  uiDirectory: string;
}

/**
 * Both protected roots (Change Registry, Controller store) must already be safe and disjoint,
 * and the Goal Store, UI directory and every served asset must be disjoint from both,
 * alias-aware. Throws before anything is created; unsafe roots are never repaired.
 */
export function trustedIntakeIsolation(options: Omit<GoalRunAdmissionBridgeOptions, 'governedRepositories'>): () => void {
  const isolation = GovernanceStoreIsolation.forTrustedIntake({ changeRegistryDirectory: options.changeRegistryDirectory,
    controllerStoreDirectory: options.controllerStoreDirectory });
  const goalRoot = options.config.dataDirectory;
  const uiRoot = resolve(options.uiDirectory);
  const assertIsolated = () => {
    isolation.assertDisjoint('Workspace Goal Store', goalRoot);
    isolation.assertDisjoint('Workspace UI directory', uiRoot);
    for (const file of WORKSPACE_UI_FILES) isolation.assertDisjoint('Workspace UI asset', join(uiRoot, file));
  };
  assertIsolated();
  return assertIsolated;
}

function mapped(error: unknown): never {
  if (error instanceof GoalRunAdmissionError) throw error;
  if (error instanceof GovernanceStoreIsolationError) throw new GoalRunAdmissionError('GOVERNANCE_STORE_ISOLATION');
  if (error instanceof GoalStoreBusyError) throw new GoalRunAdmissionError('GOAL_STORE_BUSY');
  if (error instanceof GoalBindingError) throw new GoalRunAdmissionError(error.code);
  if (error instanceof GoalQueueRequestError && error.code === 'UNKNOWN_GOAL') throw new GoalRunAdmissionError('UNKNOWN_GOAL');
  if (error instanceof RootRunAdmissionError) throw new GoalRunAdmissionError(error.code);
  if (error instanceof ChangeMintError) {
    if (error.code === 'UNATTRIBUTED_SOURCE') throw new GoalRunAdmissionError('UNATTRIBUTED_GOAL');
    if (error.code === 'CHANGE_SOURCE_BINDING_CONFLICT') throw new GoalRunAdmissionError('CHANGE_SOURCE_BINDING_CONFLICT');
    throw new GoalRunAdmissionError('REGISTRY_INTEGRITY');
  }
  throw error;
}

const changeFacts = (record: ChangeMintRecordV1) => ({ change: changeRefOf(record), changeKey: record.changeKey,
  repository: record.repository });
const identityOf = (record: ChangeMintRecordV1): GovernedChangeIdentity => ({ repository: record.repository,
  sliceId: record.sliceId, changeKey: record.changeKey });

function admittedView(record: ChangeMintRecordV1, run: AdmittedRootRun): AdmittedGoalRunView {
  return { provenance: 'CONTROLLER_STORE', state: 'ADMITTED', admission: 'ROOT', recordClass: 'OPERATIONAL_RECORD',
    runId: run.runId, ...changeFacts(record), controllerState: 'IDLE', execution: 'NOT_STARTED', modelStarted: false,
    packetIssued: false, authorityGranted: false };
}

/** The RA1 composition. Only the narrow port leaves this module; the Goal Store is the host's GC1 store. */
export function createGoalRunAdmissionBridge(options: GoalRunAdmissionBridgeOptions & { store: FileGoalStore }): GoalRunAdmissionPort {
  const repositoryFor = governedRepositoryResolver(parseGovernedRepositories(options.governedRepositories, options.config));
  const assertIsolated = trustedIntakeIsolation(options);
  const reader = openChangeRegistryReader(options.changeRegistryDirectory);
  // The protected root passed preflight above; only now may the store lay out its own entries.
  const admitter = openRootRunAdmitter(options.controllerStoreDirectory);
  const { store } = options;

  // The exact GC1 Change of the exact durable Goal, or none. Never a mint, never an alternate Change.
  const governedChange = (goal: GoalRecord, repository: string) => {
    const record = reader.getBySource(goalSourceOf(goal.projectId, goal.goalId));
    return record && requireGoalChangeBinding(record, goal, repository);
  };

  return Object.freeze({
    lookup(projectId: string, goalId: string, sessionHuman: HumanPrincipalV1): GoalRunView {
      try {
        const principal = parseHumanPrincipalV1(sessionHuman);
        const repository = repositoryFor(projectId, goalId);
        assertIsolated();
        const goal = store.read(projectId).goals.find((item) => item.goalId === goalId);
        if (!goal) throw new GoalRunAdmissionError('UNKNOWN_GOAL');
        requireGoalHuman(goal, principal);
        const record = governedChange(goal, repository);
        if (!record) return { provenance: 'CHANGE_REGISTRY', state: 'GOAL_NOT_GOVERNED', runId: null };
        const run = admitter.lookup(identityOf(record));
        if (run.runId !== null) return admittedView(record, run);
        return { provenance: 'CONTROLLER_STORE', state: 'NOT_ADMITTED', rootClaim: run.admission, runId: null,
          ...changeFacts(record), execution: 'NOT_STARTED' };
      } catch (error) { return mapped(error); }
    },
    async admit(projectId: string, goalId: string, sessionHuman: HumanPrincipalV1): Promise<AdmittedGoalRunView> {
      try {
        const principal = parseHumanPrincipalV1(sessionHuman);
        const repository = repositoryFor(projectId, goalId);
        assertIsolated();
        // The same storage lock as GC1 mint and every queue mutation: the Goal cannot be removed,
        // governed or changed while it is read, bound and admitted.
        return await store.withLockedGoal(projectId, goalId, (goal) => {
          assertIsolated();
          requireGoalHuman(goal, principal);
          const record = governedChange(goal, repository);
          if (!record) throw new GoalRunAdmissionError('GOAL_NOT_GOVERNED');
          return admittedView(record, admitter.admit(identityOf(record)));
        });
      } catch (error) { return mapped(error); }
    },
  });
}
