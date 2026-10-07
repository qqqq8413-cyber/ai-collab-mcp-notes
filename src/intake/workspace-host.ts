import { startWorkspaceServer, type RunningWorkspace } from '../workspace/server.js';
import { createGoalChangeBridge } from './goal-change-bridge.js';
import { createGoalRunAdmissionBridge, trustedIntakeIsolation } from './goal-run-admission-bridge.js';
import { type TrustedWorkspaceHostConfig } from './workspace-host-config.js';

/**
 * Trusted production host: checks storage before listening and injects only the narrow GC1
 * governance port and RA1 run-admission port. The Workspace server receives no controller,
 * store, registry, authority or execution capability.
 */
export function startTrustedWorkspaceHost(options: { config: TrustedWorkspaceHostConfig; uiDirectory: string;
  port: number }): Promise<RunningWorkspace> {
  const { config } = options;
  const roots = { config: config.workspace, changeRegistryDirectory: config.changeRegistryDirectory,
    controllerStoreDirectory: config.controllerStoreDirectory, uiDirectory: options.uiDirectory };
  // Both protected roots and every Workspace path are checked before the Goal Store or any writer exists.
  trustedIntakeIsolation(roots);
  const bridge = createGoalChangeBridge({ config: config.workspace, governedRepositories: config.governedRepositories,
    changeRegistryDirectory: config.changeRegistryDirectory, uiDirectory: options.uiDirectory });
  const runAdmission = createGoalRunAdmissionBridge({ ...roots, governedRepositories: config.governedRepositories, store: bridge.store });
  return startWorkspaceServer({ config: config.workspace, uiDirectory: options.uiDirectory, port: options.port,
    store: bridge.store, governance: bridge.governance, runAdmission });
}
