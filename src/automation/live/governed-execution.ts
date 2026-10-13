import { openGovernedActivationCore, type GovernedActivationCore } from '../activation-core.js';
import { architectReviewAuthority } from '../authority/architect-review-authority.js';
import { isAuthorityPrincipalRef } from '../authority/document.js';
import { openDirectAuthorityPreserver } from '../authority/preserver.js';
import { openGovernedExecutionDriver, type GovernedExecutionDriver } from '../execution-driver.js';
import type { ActorKind, ProviderCallScope } from '../types.js';
import { createLiveAutomation, type LiveAutomationConfig } from './composition.js';

// G1-LD1 / G1-AP1: the trusted governed live composition. It is the one production path that
// composes the live automation and the one that opens the direct authority preserver, and it
// lets only two narrow capabilities leave: the execution driver (inspect/step) and the
// activation core (inspect/activate/applyCorrection). The Controller, runner, journals,
// adapters, model process, GitHub reality, the preserver and the archive stay inside.
//
// createLiveAutomation runs first and unchanged, so its full checks (exact models, pinned
// executables, the three protected roots, every agent-visible path disjoint, both Seatbelt
// boundaries) refuse an unsafe configuration before anything is created. The preserver opens
// the archive only on its first append and runs only in this trusted process; the runner
// receives an architect review authority sink, never the preserver or an appender.
// Composing starts nothing; no process, model call or write happens until a capability is used.
//
// Configuration: the live configuration plus `architectPrincipalRef`, the trusted
// GPT_ARCHITECT principal reference (stated, not authenticated).
//
// Wired into nothing: no Workspace route, UI, SSE event, CLI command, MCP tool, scheduler or
// RA1 admission composes or calls it.

type LiveDependencies = NonNullable<Parameters<typeof createLiveAutomation>[1]>;

export interface GovernedLiveAutomation {
  execution: GovernedExecutionDriver;
  activation: GovernedActivationCore;
}

/** The exact scope each live adapter calls, as the adapters state it from the same configuration. */
function scopeOf(actorKind: ActorKind, actor: { provider: string; model: string; egressDestinations: string[] }): ProviderCallScope {
  return { actorKind, provider: actor.provider, model: actor.model, egressDestinations: [...actor.egressDestinations] };
}

export function createGovernedLiveAutomation(input: unknown, dependencies: Omit<LiveDependencies, 'architectAuthority'> = {}):
  GovernedLiveAutomation {
  // One private copy: the live runner, the driver and the activation core read the same configuration.
  const copy = structuredClone(input) as LiveAutomationConfig & { architectPrincipalRef?: unknown };
  if (!copy || typeof copy !== 'object') throw new TypeError('A governed live configuration is required');
  const { architectPrincipalRef, ...config } = copy;
  if (!isAuthorityPrincipalRef(architectPrincipalRef)) throw new TypeError('architectPrincipalRef must be an exact principal reference');
  const preserver = openDirectAuthorityPreserver(config.authorityArchiveDirectory);
  const live = createLiveAutomation(config, { ...dependencies,
    architectAuthority: architectReviewAuthority(preserver, architectPrincipalRef) });
  const roots = { controllerStoreDirectory: config.controllerStoreDirectory, authorityArchiveDirectory: config.authorityArchiveDirectory,
    changeRegistryDirectory: config.changeRegistryDirectory };
  const execution = openGovernedExecutionDriver({ ...roots, runner: live.runner, liveCallAuthorizations: config.liveCallAuthorizations,
    scopes: { IMPLEMENTATION: scopeOf('IMPLEMENTATION', config.claude), ARCHITECT_REVIEW: scopeOf('ARCHITECT_REVIEW', config.codex) },
    architectPrincipalRef, clock: dependencies.clock });
  const activation = openGovernedActivationCore({ ...roots, controller: live.controller, preserver, architectPrincipalRef,
    clock: dependencies.clock });
  return Object.freeze({ execution, activation });
}
