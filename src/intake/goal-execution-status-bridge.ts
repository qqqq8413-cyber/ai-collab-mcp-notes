import { join, resolve } from 'node:path';
import { isAuthorityPrincipalRef } from '../automation/authority/document.js';
import { ChangeMintError, type ChangeMintRecordV1 } from '../automation/change-mint.js';
import { openChangeRegistryReader } from '../automation/change-registry.js';
import { assessGovernedRun, type GovernedRunAssessmentV1 } from '../automation/execution-readiness.js';
import { GovernanceStoreIsolation, GovernanceStoreIsolationError } from '../automation/governance-store-isolation.js';
import { GovernedReadError, readGovernedModel, type GovernedReadModelV1 } from '../automation/read-model/governed-read-model.js';
import { rootRunIdOf } from '../automation/root-run-admitter.js';
import { SYSTEM_CLOCK } from '../automation/time.js';
import type { Clock } from '../automation/types.js';
import { parseHumanPrincipalV1, type HumanPrincipalV1 } from '../identity/canonical.js';
import { type WorkspaceConfig } from '../workspace/config.js';
import { GoalExecutionStatusError, type ExecutionAttention, type GoalExecutionStatus, type GoalExecutionStatusPort,
  type GoalExecutionStatusView } from '../workspace/goal-execution-status-port.js';
import { type FileGoalStore } from '../workspace/goal-store.js';
import { WORKSPACE_UI_FILES } from '../workspace/server.js';
import { GoalBindingError, goalSourceOf, governedRepositoryResolver, requireGoalChangeBinding,
  requireGoalHuman } from './goal-change-binding.js';
import { parseGovernedRepositories, type GovernedRepositoryBinding } from './workspace-host-config.js';

// G1-WE1-R0: the trusted, read-only path from a Workspace Goal to its governed execution status.
// The browser names only the project and goal. Everything else is derived here from durable
// evidence: the Goal Store (the Goal and its recorded Human, which must equal the session Human),
// the CM1 Change Registry (the Goal's exact GC1 Change, read only), R4L admission and the R4A0
// governed read (one snapshot of the Controller store and the Authority Archive), and RP1
// operational provenance through the shared readiness assessment LD1 itself uses. The ROOT runId
// is the Change's one deterministic runId; no other run is ever inferred or adopted.
//
// Every operation is a read. It creates no Change, run, admission, authority or journal record,
// holds no minter, admitter, Controller, runner, preserver, appender, model process or provider,
// and never claims a run is ready for a model call: the live-call configuration is not held, so
// eligibility is EXECUTION_ELIGIBILITY_NOT_EVALUATED. Statuses are operational projections, never
// execution authority. It is composed only when the trusted host configures it.

export interface GoalExecutionStatusBridgeOptions {
  config: WorkspaceConfig;
  governedRepositories: readonly GovernedRepositoryBinding[];
  changeRegistryDirectory: string;
  controllerStoreDirectory: string;
  authorityArchiveDirectory: string;
  /** Trusted configuration: the GPT_ARCHITECT principal whose lineage a governed run must carry. Stated, not authenticated. */
  architectPrincipalRef: string;
  uiDirectory: string;
  clock?: Clock;
}

const NOTICE = 'Read-only governed status. It is not execution authority: nothing was started, activated, recovered, corrected or authorized.';

/**
 * All three protected roots must already be safe and mutually disjoint, and the Goal Store, UI directory and every
 * served asset disjoint from them, alias-aware; the Architect principal must be an exact reference. Throws before
 * anything is created; nothing is repaired.
 */
export function trustedObservationPreflight(options: Omit<GoalExecutionStatusBridgeOptions, 'governedRepositories' | 'clock'>): () => void {
  if (!isAuthorityPrincipalRef(options.architectPrincipalRef)) throw new TypeError('executionStatus.architectPrincipalRef must be an exact principal reference');
  const isolation = GovernanceStoreIsolation.forTrustedObservation({ changeRegistryDirectory: options.changeRegistryDirectory,
    controllerStoreDirectory: options.controllerStoreDirectory, authorityArchiveDirectory: options.authorityArchiveDirectory });
  const uiRoot = resolve(options.uiDirectory);
  const assertIsolated = () => {
    isolation.assertDisjoint('Workspace Goal Store', options.config.dataDirectory);
    isolation.assertDisjoint('Workspace UI directory', uiRoot);
    for (const file of WORKSPACE_UI_FILES) isolation.assertDisjoint('Workspace UI asset', join(uiRoot, file));
  };
  assertIsolated();
  return assertIsolated;
}

function mapped(error: unknown): never {
  if (error instanceof GoalExecutionStatusError) throw error;
  if (error instanceof GovernanceStoreIsolationError) throw new GoalExecutionStatusError('GOVERNANCE_STORE_ISOLATION');
  if (error instanceof GoalBindingError) throw new GoalExecutionStatusError(error.code);
  throw error;
}

/** Who a set of next-move roles waits for. */
function attentionOf(roles: Iterable<string>): ExecutionAttention {
  const set = new Set(roles);
  const human = set.has('HUMAN'), architect = set.has('GPT_ARCHITECT');
  return human && architect ? 'HUMAN_AND_ARCHITECT' : human ? 'HUMAN' : architect ? 'ARCHITECT' : 'AUTOMATED_ACTOR';
}

export function createGoalExecutionStatusBridge(options: GoalExecutionStatusBridgeOptions & { store: FileGoalStore }): GoalExecutionStatusPort {
  const repositoryFor = governedRepositoryResolver(parseGovernedRepositories(options.governedRepositories, options.config));
  const assertIsolated = trustedObservationPreflight(options);
  const reader = openChangeRegistryReader(options.changeRegistryDirectory);
  const roots = { controllerStoreDirectory: options.controllerStoreDirectory, authorityArchiveDirectory: options.authorityArchiveDirectory };
  const principalRef = options.architectPrincipalRef;
  const clock = options.clock ?? SYSTEM_CLOCK;
  const { store } = options;

  type Change = NonNullable<GoalExecutionStatusView['change']>;
  const view = (status: GoalExecutionStatus, attention: ExecutionAttention, extra: Partial<GoalExecutionStatusView> = {}): GoalExecutionStatusView =>
    ({ readModelVersion: 'goal-execution-status.v0', recordClass: 'OPERATIONAL_RECORD', authority: 'NOT_EXECUTION_AUTHORITY', status,
      reason: null, executionEligibility: 'EXECUTION_ELIGIBILITY_NOT_EVALUATED', attention, change: null, run: null, nextMoves: [],
      directAuthority: [], unresolvedAuthority: [], operationalProvenance: null, snapshotId: null, notice: NOTICE, ...extra });
  // A governance contradiction is shown, never repaired, adopted or explained away; nothing about a run is projected from it.
  const conflict = (reason: string, change: Change | null, snapshotId: string | null = null) =>
    view('GOVERNANCE_CONFLICT', 'HUMAN', { reason, change, snapshotId });

  /** The projection of R4A0's and RP1's answer for the Change's ROOT run, which exists exactly once. */
  const runView = (assessed: GovernedRunAssessmentV1, change: Change): GoalExecutionStatusView => {
    const run = assessed.run!;
    const required = run.authority.filter((reference) => reference.required);
    const facts: Partial<GoalExecutionStatusView> = { reason: assessed.reason, change, snapshotId: assessed.snapshotId,
      run: { runId: run.runId, state: run.state, terminal: run.terminal, admission: 'ROOT' },
      nextMoves: assessed.nextMoves.map(({ action, role }) => ({ action, role })),
      directAuthority: required.filter((reference) => reference.resolution === 'RESOLVED' && reference.authority)
        .map((reference) => ({ recordClass: 'DIRECT_AUTHORITY', kind: reference.kind, authorityId: reference.authority!.authorityId,
          version: reference.authority!.version })),
      unresolvedAuthority: required.filter((reference) => reference.resolution !== 'RESOLVED')
        .map((reference) => ({ kind: reference.kind, authorityId: reference.authorityId, resolution: reference.resolution })),
      operationalProvenance: { recordClass: 'OPERATIONAL_RECORD', activationBound: run.provenance.activationBinding !== null } };
    const roles = assessed.nextMoves.map((move) => move.role);
    switch (assessed.outcome) {
      case 'RUNNER_MOVE': return view('IN_PROGRESS', 'AUTOMATED_ACTOR', { ...facts, reason: null });
      case 'BLOCKED_AUTHORITY':
        return view('BLOCKED_AUTHORITY', attentionOf(facts.unresolvedAuthority!.map((item) => item.kind === 'AUTHORIZATION' ? 'HUMAN' : 'GPT_ARCHITECT')), facts);
      case 'BLOCKED_PROVENANCE': return view('BLOCKED_PROVENANCE', 'ARCHITECT', facts);
      // The status itself says it; the assessment's generic code (TERMINAL_STATE, NOT_A_RUNNER_MOVE) adds nothing.
      case 'TERMINAL': return view('TERMINAL', 'NONE', { ...facts, reason: null });
      case 'WAITING_HUMAN': return view('WAITING_HUMAN', 'HUMAN', { ...facts, reason: null });
      case 'WAITING_EXTERNAL_ACTOR': {
        const status: GoalExecutionStatus = run.state === 'IDLE' ? 'RUN_IDLE' : run.state === 'ARCHITECTURE' ? 'WAITING_PACKET' : 'WAITING_EXTERNAL_ACTOR';
        return view(status, attentionOf(roles), { ...facts, reason: null });
      }
      default: return conflict(assessed.reason ?? 'GOVERNANCE_CONFLICT', change, assessed.snapshotId);
    }
  };

  /** No ROOT run: only R4L's own claim for this exact Change decides between not admitted and an interrupted admission. */
  const absentRun = (model: GovernedReadModelV1, record: ChangeMintRecordV1, runId: string, change: Change, snapshotId: string | null) => {
    const claims = model.admissions.filter((claim) => claim.changeKey === record.changeKey);
    if (model.runs.some((run) => run.changeKey === record.changeKey) || claims.some((claim) => claim.rootRunId !== runId ||
        claim.repository !== record.repository || claim.sliceId !== record.sliceId)) return conflict('RUN_IDENTITY_CONFLICT', change, snapshotId);
    return claims.length ? view('ROOT_PENDING', 'HUMAN', { change, snapshotId }) : view('RUN_NOT_ADMITTED', 'HUMAN', { change, snapshotId });
  };

  return Object.freeze({
    inspect(projectId: string, goalId: string, sessionHuman: HumanPrincipalV1): GoalExecutionStatusView {
      try {
        const principal = parseHumanPrincipalV1(sessionHuman);
        const repository = repositoryFor(projectId, goalId);
        assertIsolated();
        const goal = store.read(projectId).goals.find((item) => item.goalId === goalId);
        if (!goal) throw new GoalExecutionStatusError('UNKNOWN_GOAL');
        requireGoalHuman(goal, principal);
        // The exact GC1 Change of the exact durable Goal, or none. Never a mint.
        let record: ChangeMintRecordV1 | undefined;
        try { record = reader.getBySource(goalSourceOf(goal.projectId, goal.goalId)); }
        catch { return conflict('REGISTRY_INTEGRITY', null); }
        if (!record) return view('GOAL_NOT_GOVERNED', 'HUMAN');
        try { requireGoalChangeBinding(record, goal, repository); }
        catch (error) {
          if (error instanceof ChangeMintError) return conflict(error.code === 'CHANGE_SOURCE_BINDING_CONFLICT' ? error.code : 'REGISTRY_INTEGRITY', null);
          throw error;
        }
        const change: Change = { kind: 'SLICE', changeId: record.sliceId, changeKey: record.changeKey, repository: record.repository };
        let model: GovernedReadModelV1;
        try { model = readGovernedModel(roots, clock); }
        catch (error) { return conflict(error instanceof GovernedReadError ? `READ_MODEL_${error.code}` : 'READ_MODEL_FAILED', change); }
        const runId = rootRunIdOf(record.changeKey);
        const assessed = assessGovernedRun(model, record, runId, principalRef);
        if (assessed.outcome === 'RUN_NOT_FOUND') return absentRun(model, record, runId, change, assessed.snapshotId);
        if (assessed.outcome === 'TARGET_MISMATCH' || assessed.outcome === 'ADMISSION_INVALID' || assessed.outcome === 'READ_MODEL_CONFLICT') {
          return conflict(assessed.reason ?? 'GOVERNANCE_CONFLICT', change, assessed.snapshotId);
        }
        return runView(assessed, change);
      } catch (error) { return mapped(error); }
    },
  });
}
