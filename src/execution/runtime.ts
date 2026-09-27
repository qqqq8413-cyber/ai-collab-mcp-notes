import { PROVIDERS, type ProviderName } from '../config.js';
import { canonicalCapabilitySource, type CapabilitySource } from './admission.js';
import { createExecutionBoundary, type DefaultModelResolver, type ExecutionAuthorityPort, type ExecutionBoundary } from './boundary.js';
import { createClaudeExecutor, createGeminiExecutor, createOpenAIExecutor } from './executors.js';
import { createExecutorRegistry, type ExecutorRegistry } from './registry.js';

const PROVIDER_NAMES: readonly ProviderName[] = ['claude', 'openai', 'gemini'];

/** Snapshot configuration facts; a later config mutation cannot rebind this runtime. */
export function createConfiguredDefaultModelResolver(): DefaultModelResolver {
  const models: Record<ProviderName, string> = {
    claude: PROVIDERS.claude.defaultModel,
    openai: PROVIDERS.openai.defaultModel,
    gemini: PROVIDERS.gemini.defaultModel,
  };
  return Object.freeze({ resolveDefaultModel(provider: ProviderName): string | undefined { return models[provider]; } });
}

/** Constructs mechanisms without dispatching any provider call. */
export function createDefaultProviderRegistry(): ExecutorRegistry {
  return createExecutorRegistry([
    { kind: 'MODEL_PROVIDER', executorId: 'model-provider:claude', provider: 'claude', executor: createClaudeExecutor() },
    { kind: 'MODEL_PROVIDER', executorId: 'model-provider:openai', provider: 'openai', executor: createOpenAIExecutor() },
    { kind: 'MODEL_PROVIDER', executorId: 'model-provider:gemini', provider: 'gemini', executor: createGeminiExecutor() },
  ]);
}

export interface ExecutionRuntimeComposition {
  authority: ExecutionAuthorityPort;
  registry: ExecutorRegistry;
  capabilitySource?: CapabilitySource;
  defaultModelResolver?: DefaultModelResolver;
  monotonicNow?: () => number;
}

/** Explicit one-time assembly; no service locator or legacy runtime wiring. */
export function createExecutionRuntime(composition: ExecutionRuntimeComposition): ExecutionBoundary {
  const resolver = composition.defaultModelResolver ?? createConfiguredDefaultModelResolver();
  const defaults = Object.fromEntries(PROVIDER_NAMES.map((provider) => [provider, resolver.resolveDefaultModel(provider)])) as Record<ProviderName, string | undefined>;
  const fixedResolver: DefaultModelResolver = Object.freeze({
    resolveDefaultModel(provider: ProviderName): string | undefined { return defaults[provider]; },
  });
  return createExecutionBoundary({
    defaultModelResolver: fixedResolver,
    capabilitySource: composition.capabilitySource ?? canonicalCapabilitySource,
    registry: composition.registry,
    authority: composition.authority,
    monotonicNow: composition.monotonicNow,
  });
}
