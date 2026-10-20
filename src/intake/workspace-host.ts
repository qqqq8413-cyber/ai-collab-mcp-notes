import { startWorkspaceServer, type RunningWorkspace } from '../workspace/server.js';
import { createGoalChangeBridge } from './goal-change-bridge.js';
import type { GoalExecutionStatusBridgeOptions } from './goal-execution-status-bridge.js';
import { createGoalRunAdmissionBridge, trustedIntakeIsolation } from './goal-run-admission-bridge.js';
import { type TrustedWorkspaceHostConfig } from './workspace-host-config.js';
import type { AutomationPort } from '../workspace/automation-port.js';
import { createAiPilotPreparation } from '../ai-pilot/preparation.js';

// Type-only references: erased at runtime, so a host without execution status never loads that module.
type StatusModule = typeof import('./goal-execution-status-bridge.js');

/**
 * Trusted production host: checks storage before listening and injects only the narrow GC1
 * governance port, the RA1 run-admission port and, when configured, the G1-WE1-R0 read-only
 * execution status port. The Workspace server receives no controller, store, registry,
 * authority or execution capability.
 */
export function startTrustedWorkspaceHost(options: { config: TrustedWorkspaceHostConfig; uiDirectory: string;
  port: number; aiPreparation?: boolean; automation?: AutomationPort }): Promise<RunningWorkspace> {
  const { config } = options;
  const roots = { config: config.workspace, changeRegistryDirectory: config.changeRegistryDirectory,
    controllerStoreDirectory: config.controllerStoreDirectory, uiDirectory: options.uiDirectory };
  // Both protected roots and every Workspace path are checked before the Goal Store or any writer exists.
  trustedIntakeIsolation(roots);
  const compose = (status?: { module: StatusModule; options: GoalExecutionStatusBridgeOptions }) => {
    const bridge = createGoalChangeBridge({ config: config.workspace, governedRepositories: config.governedRepositories,
      changeRegistryDirectory: config.changeRegistryDirectory, uiDirectory: options.uiDirectory });
    const runAdmission = createGoalRunAdmissionBridge({ ...roots, governedRepositories: config.governedRepositories, store: bridge.store });
    const executionStatus = status?.module.createGoalExecutionStatusBridge({ ...status.options, store: bridge.store });
    const aiPilot = options.aiPreparation ? createAiPilotPreparation({ dataDirectory: config.workspace.dataDirectory,
      repositories: Object.fromEntries(config.governedRepositories.map(b => [b.projectId, b.repository])),
      store: bridge.store, governance: bridge.governance, runAdmission, executionStatus }) : undefined;
    return startWorkspaceServer({ config: config.workspace, uiDirectory: options.uiDirectory, port: options.port,
      store: bridge.store, governance: bridge.governance, runAdmission, ...(executionStatus ? { executionStatus } : {}),
      ...(aiPilot ? { aiPilot } : {}), ...(options.automation ? { automation: options.automation } : {}) });
  };
  // G1-WE1-R0: read-only execution status is off unless configured. Only then is its module loaded, and its three
  // protected roots, Workspace paths and Architect principal are checked before the Goal Store or any writer exists.
  if (!config.executionStatus) return compose();
  const statusOptions: GoalExecutionStatusBridgeOptions = { config: config.workspace, governedRepositories: config.governedRepositories,
    changeRegistryDirectory: config.changeRegistryDirectory, controllerStoreDirectory: config.controllerStoreDirectory,
    authorityArchiveDirectory: config.executionStatus.authorityArchiveDirectory,
    architectPrincipalRef: config.executionStatus.architectPrincipalRef, uiDirectory: options.uiDirectory };
  return import('./goal-execution-status-bridge.js').then((module) => {
    module.trustedObservationPreflight(statusOptions);
    return compose({ module, options: statusOptions });
  });
}
