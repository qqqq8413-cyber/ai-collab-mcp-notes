import { startWorkspaceServer, type RunningWorkspace } from '../workspace/server.js';
import { createGoalChangeBridge } from './goal-change-bridge.js';
import { type TrustedWorkspaceHostConfig } from './workspace-host-config.js';

/** Trusted production host: checks storage before listening and injects only the narrow GC1 port. */
export function startTrustedWorkspaceHost(options: { config: TrustedWorkspaceHostConfig; uiDirectory: string;
  port: number }): Promise<RunningWorkspace> {
  const { config } = options;
  const bridge = createGoalChangeBridge({ config: config.workspace, governedRepositories: config.governedRepositories,
    changeRegistryDirectory: config.changeRegistryDirectory, uiDirectory: options.uiDirectory });
  return startWorkspaceServer({ config: config.workspace, uiDirectory: options.uiDirectory, port: options.port,
    store: bridge.store, governance: bridge.governance });
}
