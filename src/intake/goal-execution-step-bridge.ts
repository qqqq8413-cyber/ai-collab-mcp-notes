import type { GovernedExecutionDriver, ExecutionInspectionV1 } from '../automation/execution-driver.js';
import type { HumanPrincipalV1 } from '../identity/canonical.js';
import type { GoalExecutionStatusPort, GoalExecutionStatusView } from '../workspace/goal-execution-status-port.js';
import { GoalExecutionStepError, type GoalExecutionStepPort, type GoalExecutionStepView } from '../workspace/goal-execution-step-port.js';
import { goalSourceOf } from './goal-change-binding.js';
import type { ApprovedRunIdentity } from './human-approval.js';

// Trusted Host only. The status reader checks the stored Goal's Human attribution and
// exact ROOT binding; LD1 independently rechecks the Change, ROOT, authority, provenance,
// current occurrence and archived per-call Human grant immediately before each runner step.
// The browser supplies only projectId/goalId. A single POST calls LD1 at most once.
export function createGoalExecutionStepBridge(options: {
  executionStatus: GoalExecutionStatusPort;
  driver: GovernedExecutionDriver;
  /** Mandatory. Absence of signed approval must block even before driver inspection. */
  approvalGate: (identity: ApprovedRunIdentity) => boolean;
}): GoalExecutionStepPort {
  const active = new Set<string>();
  const targetOf = (projectId: string, goalId: string, human: HumanPrincipalV1) => {
    const observed = options.executionStatus.inspect(projectId, goalId, human);
    return { observed, target: observed.run?.admission === 'ROOT'
      ? { source: goalSourceOf(projectId, goalId), runId: observed.run.runId } : null };
  };
  const project = (observed: GoalExecutionStatusView, result?: ExecutionInspectionV1): GoalExecutionStepView => {
    if (!result) return { recordClass: 'OPERATIONAL_RECORD', authority: 'NOT_EXECUTION_AUTHORITY',
      runId: null, state: null, readiness: observed.status, reason: observed.reason, canStep: false };
    if (result.target?.runId !== observed.run?.runId || result.repository !== observed.change?.repository ||
        result.changeKey !== observed.change?.changeKey) {
      throw new GoalExecutionStepError('STEP_BINDING_CONFLICT');
    }
    return { recordClass: 'OPERATIONAL_RECORD', authority: 'NOT_EXECUTION_AUTHORITY',
      runId: observed.run!.runId, state: result.state, readiness: result.readiness, reason: result.reason,
      canStep: observed.status === 'IN_PROGRESS' && result.readiness === 'READY' };
  };
  const inspect = (projectId: string, goalId: string, human: HumanPrincipalV1) => {
    const { observed, target } = targetOf(projectId, goalId, human);
    if (!target) return { observed, target, view: project(observed) };
    const signed = observed.change ?
      options.approvalGate({ projectId, goalId, repository: observed.change.repository,
        changeKey: observed.change.changeKey, runId: target.runId,
        humanPrincipalRef: human.principalRef }) : false;
    if (!signed) return { observed, target, view: {
      recordClass: 'OPERATIONAL_RECORD' as const, authority: 'NOT_EXECUTION_AUTHORITY' as const,
      runId: target?.runId ?? null, state: observed.run?.state ?? null,
      readiness: 'HUMAN_APPROVAL_INVALID', reason: 'SIGNED_APPROVAL_MISSING_EXPIRED_OR_MISMATCHED', canStep: false,
    } };
    return { observed, target, view: project(observed, target ? options.driver.inspect(target) : undefined) };
  };
  return Object.freeze({
    inspect(projectId: string, goalId: string, human: HumanPrincipalV1) { return inspect(projectId, goalId, human).view; },
    async step(projectId: string, goalId: string, human: HumanPrincipalV1) {
      const key = JSON.stringify([projectId, goalId]);
      if (active.has(key)) throw new GoalExecutionStepError('STEP_BUSY');
      active.add(key);
      try {
        const before = inspect(projectId, goalId, human);
        if (!before.target || !before.view.canStep) return { recordClass: 'OPERATIONAL_RECORD' as const,
          authority: 'NOT_EXECUTION_AUTHORITY' as const, status: 'NOT_STEPPED' as const, runnerCalls: 0,
          runnerOutcome: null, preState: before.view.state, postState: before.view.state, readiness: before.view };
        const result = await options.driver.step(before.target);
        // Never trust a driver result to identify a different run as this Goal's.
        if (result.target?.runId !== before.target.runId || result.runnerCalls > 1) {
          throw new GoalExecutionStepError('STEP_BINDING_CONFLICT');
        }
        // A step may have side effects before a later read fails. Never conceal the
        // result by returning a generic HTTP 500, nor claim it is safe to retry.
        let after: GoalExecutionStepView;
        try { after = inspect(projectId, goalId, human).view; }
        catch {
          after = { ...before.view, state: result.postState,
            readiness: 'POST_STEP_OBSERVATION_UNAVAILABLE', reason: 'POST_STEP_RECHECK_FAILED', canStep: false };
        }
        return { recordClass: 'OPERATIONAL_RECORD' as const, authority: 'NOT_EXECUTION_AUTHORITY' as const,
          status: result.status, runnerCalls: result.runnerCalls, runnerOutcome: result.runnerOutcome,
          preState: result.preState, postState: result.postState, readiness: after };
      } finally { active.delete(key); }
    },
  });
}
