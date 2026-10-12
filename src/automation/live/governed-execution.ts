import { openGovernedExecutionDriver, type GovernedExecutionDriver } from '../execution-driver.js';
import type { ActorKind, ProviderCallScope } from '../types.js';
import { createLiveAutomation, type LiveAutomationConfig } from './composition.js';

// G1-LD1: the trusted composition of the governed live execution driver. It is the one
// production path that composes the live automation, and it lets only the driver's
// inspect/step leave: the Controller, runner, journals, adapters, model process and GitHub
// reality stay inside. createLiveAutomation runs first and unchanged, so its full checks
// (exact models, pinned executables, the three protected roots, every agent-visible path
// disjoint, both Seatbelt boundaries) refuse an unsafe configuration before anything is
// created. Composing starts nothing; no process, model call or write happens until step().
//
// Wired into nothing: no Workspace route, UI, SSE event, CLI command, MCP tool, scheduler or
// RA1 admission composes or calls it.

type LiveDependencies = NonNullable<Parameters<typeof createLiveAutomation>[1]>;

/** The exact scope each live adapter calls, as the adapters state it from the same configuration. */
function scopeOf(actorKind: ActorKind, actor: { provider: string; model: string; egressDestinations: string[] }): ProviderCallScope {
  return { actorKind, provider: actor.provider, model: actor.model, egressDestinations: [...actor.egressDestinations] };
}

export function createGovernedLiveExecutionDriver(input: unknown, dependencies: LiveDependencies = {}): GovernedExecutionDriver {
  // One private copy: the live runner and the driver read the same configuration, grants included.
  const config = structuredClone(input) as LiveAutomationConfig;
  const live = createLiveAutomation(config, dependencies);
  return openGovernedExecutionDriver({
    controllerStoreDirectory: config.controllerStoreDirectory,
    authorityArchiveDirectory: config.authorityArchiveDirectory,
    changeRegistryDirectory: config.changeRegistryDirectory,
    runner: live.runner,
    liveCallAuthorizations: config.liveCallAuthorizations,
    scopes: { IMPLEMENTATION: scopeOf('IMPLEMENTATION', config.claude), ARCHITECT_REVIEW: scopeOf('ARCHITECT_REVIEW', config.codex) },
    clock: dependencies.clock,
  });
}
