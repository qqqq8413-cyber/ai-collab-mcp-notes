import { startWorkspaceServer, type RunningWorkspace } from '../workspace/server.js';
import { createGoalChangeBridge } from './goal-change-bridge.js';
import type { GoalExecutionStatusBridgeOptions } from './goal-execution-status-bridge.js';
import { createGoalRunAdmissionBridge, trustedIntakeIsolation } from './goal-run-admission-bridge.js';
import { type TrustedWorkspaceHostConfig } from './workspace-host-config.js';

// Type-only references: erased at runtime, so a host without execution status never loads that module.
type StatusModule = typeof import('./goal-execution-status-bridge.js');
type LiveDriver = ReturnType<typeof import('../automation/live/governed-execution.js')['createGovernedLiveAutomation']>['execution'];
type LiveCapabilities = ReturnType<typeof import('../automation/live/governed-execution.js')['createGovernedLiveAutomation']>;
type TrustedActivationPlan = import('./activation-plan-preflight.js').TrustedActivationPlan;

/**
 * Trusted production host: checks storage before listening and injects only the narrow GC1
 * governance port, the RA1 run-admission port and, when configured, the G1-WE1-R0 read-only
 * execution status port. The Workspace server receives no controller, store, registry,
 * authority or execution capability.
 */
export function startTrustedWorkspaceHost(options: { config: TrustedWorkspaceHostConfig; uiDirectory: string;
  port: number }): Promise<RunningWorkspace> {
  const { config } = options;
  const roots = { config: config.workspace, changeRegistryDirectory: config.changeRegistryDirectory,
    controllerStoreDirectory: config.controllerStoreDirectory, uiDirectory: options.uiDirectory };
  // Both protected roots and every Workspace path are checked before the Goal Store or any writer exists.
  trustedIntakeIsolation(roots);
  const compose = async (status?: { module: StatusModule; options: GoalExecutionStatusBridgeOptions },
    live?: LiveCapabilities, plans: readonly TrustedActivationPlan[] = []): Promise<RunningWorkspace> => {
    const bridge = createGoalChangeBridge({ config: config.workspace, governedRepositories: config.governedRepositories,
      changeRegistryDirectory: config.changeRegistryDirectory, uiDirectory: options.uiDirectory });
    const runAdmission = createGoalRunAdmissionBridge({ ...roots, governedRepositories: config.governedRepositories, store: bridge.store });
    const executionStatus = status?.module.createGoalExecutionStatusBridge({ ...status.options, store: bridge.store });
    const approvedPlans = new Map(plans.map((plan) => [JSON.stringify([plan.projectId, plan.goalId]), plan]));
    // Never load the signed approval verifier, Runner bridge or Controller-adjacent
    // modules in an ordinary or read-only Host. They belong only to opt-in Live.
    const liveBridges = live && executionStatus ? await Promise.all([
      import('./goal-execution-step-bridge.js'), import('./goal-activation-bridge.js'), import('./human-approval.js'),
    ]) : null;
    const executionStep = live && executionStatus && liveBridges ? liveBridges[0].createGoalExecutionStepBridge({ executionStatus, driver: live.execution,
      approvalGate: (identity) => {
        const plan = approvedPlans.get(JSON.stringify([identity.projectId, identity.goalId]));
        return !!plan && liveBridges[2].humanApprovalMatches(plan.approval, identity, plan.bundle);
      },
    }) : undefined;
    const goalActivation = live && executionStatus && liveBridges ? liveBridges[1].createGoalActivationBridge({ status: executionStatus,
      activation: live.activation, store: bridge.store, plans,
      architectPrincipalRef: config.executionStatus!.architectPrincipalRef }) : undefined;
    return startWorkspaceServer({ config: config.workspace, uiDirectory: options.uiDirectory, port: options.port,
      store: bridge.store, governance: bridge.governance, runAdmission, ...(executionStatus ? { executionStatus } : {}),
      ...(executionStep ? { executionStep } : {}), ...(goalActivation ? { goalActivation } : {}) });
  };
  // G1-WE1-R0: read-only execution status is off unless configured. Only then is its module loaded, and its three
  // protected roots, Workspace paths and Architect principal are checked before the Goal Store or any writer exists.
  if (!config.executionStatus) return compose();
  const statusOptions: GoalExecutionStatusBridgeOptions = { config: config.workspace, governedRepositories: config.governedRepositories,
    changeRegistryDirectory: config.changeRegistryDirectory, controllerStoreDirectory: config.controllerStoreDirectory,
    authorityArchiveDirectory: config.executionStatus.authorityArchiveDirectory,
    architectPrincipalRef: config.executionStatus.architectPrincipalRef, uiDirectory: options.uiDirectory };
  return import('./goal-execution-status-bridge.js').then(async (module) => {
    module.trustedObservationPreflight(statusOptions);
    if (!config.executionStep) return compose({ module, options: statusOptions });
    const live = config.executionStep.governedLive;
    if (!live || typeof live !== 'object' || Array.isArray(live)) throw new TypeError('executionStep.governedLive must be an object');
    const fields = live as Record<string, unknown>;
    if (fields.controllerStoreDirectory !== config.controllerStoreDirectory ||
        fields.changeRegistryDirectory !== config.changeRegistryDirectory ||
        fields.authorityArchiveDirectory !== statusOptions.authorityArchiveDirectory ||
        fields.architectPrincipalRef !== statusOptions.architectPrincipalRef ||
        fields.repository !== config.governedRepositories[0]?.repository ||
        config.governedRepositories.some((binding) => binding.repository !== fields.repository)) {
      throw new Error('executionStep must bind the exact trusted governance roots, principal and repository');
    }
    // Validate every complete direct-authority document while no live capability or
    // Goal Store exists. This module is never loaded by a read-only/disabled Host.
    const { validateActivationPlans } = await import('./activation-plan-preflight.js');
    if (!config.executionStep.humanApprovalPublicKeyPem) {
      throw new Error('EXE-C4 live Host requires an independently pinned Human Ed25519 public key');
    }
    const plans = validateActivationPlans(config.executionStep.activationPlans, config.executionStep.humanApprovalPublicKeyPem);
    if (plans.some((plan) => plan.approval.payload.humanPrincipalRef !== config.workspace.humanPrincipal.principalRef)) {
      throw new Error('HUMAN_APPROVAL_PRINCIPAL_MISMATCH');
    }
    // Live imports and writable capabilities exist ONLY behind explicit opt-in.
    const liveModule = await import('../automation/live/governed-execution.js');
    // Validate and compose the governed live driver before opening Workspace's Goal Store.
    const capabilities = liveModule.createGovernedLiveAutomation(live);
    return compose({ module, options: statusOptions }, capabilities, plans);
  });
}
