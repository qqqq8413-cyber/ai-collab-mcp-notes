import { assertProviderConfigured, type ProviderName } from '../config.js';
import type { CallOptions, CallResult } from '../providers/types.js';
import { callClaude } from '../providers/claude.js';
import { callOpenAI } from '../providers/openai.js';
import { callGemini } from '../providers/gemini.js';
import type {
  ExecutionRequest,
  ExecutionResultIdentity,
  ExecutionSuccess,
  NormalizedExecutionResult,
  NormalizedRetrieval,
  ProviderBinding,
  ProviderExecutionError,
  ProviderExecutionInput,
  ProviderExecutor,
  ProviderTokenUsage,
} from './types.js';

export interface TransportSuccess {
  outcome: 'SUCCESS';
  result: CallResult;
  /** Legacy CallResult.model is the selected request model, not this observation. */
  reportedModel?: string;
  usage?: ProviderTokenUsage;
  finishReason?: string;
  providerRequestId?: string;
  providerMetadata?: { serviceTier?: string; region?: string };
}

export type ProviderTransportResult =
  | TransportSuccess
  | { outcome: 'KNOWN_FAILURE'; error: ProviderExecutionError & { completionState: 'FAILED' } }
  | { outcome: 'UNCERTAIN'; error: ProviderExecutionError & { completionState: 'UNKNOWN' } };

/** Injectable boundary: tests supply a fake; defaults call the unchanged adapters. */
export type ProviderTransport = (
  prompt: string,
  options: CallOptions
) => Promise<ProviderTransportResult>;

export function resolveProviderBinding(
  request: ExecutionRequest,
  configuredDefaultModel: string
): ProviderBinding {
  if (request.requestedModel !== undefined && !request.requestedModel.trim()) {
    throw new TypeError('Explicit requestedModel must be nonempty');
  }
  if (request.requestedModel === undefined && !configuredDefaultModel.trim()) {
    throw new TypeError('Configured default model must be nonempty');
  }
  return {
    provider: request.provider,
    requestedModel: request.requestedModel,
    effectiveModel: request.requestedModel ?? configuredDefaultModel,
    resolutionBasis: request.requestedModel === undefined ? 'DEFAULT' : 'EXPLICIT',
  };
}

function assertBinding(request: ExecutionRequest, binding: ProviderBinding, provider: ProviderName): void {
  if (
    request.provider !== provider ||
    binding.provider !== provider ||
    request.requestedModel !== binding.requestedModel ||
    !binding.effectiveModel.trim() ||
    (request.requestedModel === undefined && binding.resolutionBasis !== 'DEFAULT') ||
    (request.requestedModel !== undefined &&
      (binding.resolutionBasis !== 'EXPLICIT' || binding.effectiveModel !== request.requestedModel))
  ) {
    throw new TypeError('Execution request and provider binding disagree');
  }
}

function toCallOptions(request: ExecutionRequest, binding: ProviderBinding): CallOptions {
  // The existing adapters own max_tokens, max_completion_tokens, and maxOutputTokens.
  const options: CallOptions = { model: binding.effectiveModel };
  if (request.systemInstruction !== undefined) options.system = request.systemInstruction;
  if (request.stage !== undefined) options.stage = request.stage;
  if (request.retrieval !== undefined) options.retrieval = request.retrieval;
  if (Object.hasOwn(request.parameters, 'temperature')) {
    options.temperature = request.parameters.temperature!.value;
  }
  if (Object.hasOwn(request.parameters, 'max_output_tokens')) {
    options.maxTokens = request.parameters.max_output_tokens!.value;
  }
  return options;
}

function identity(input: ProviderExecutionInput): ExecutionResultIdentity {
  const result: ExecutionResultIdentity = {
    executionId: input.request.executionId,
    attemptId: input.request.attemptId,
    requestedProvider: input.request.provider,
    effectiveProvider: input.binding.provider,
    effectiveModel: input.binding.effectiveModel,
  };
  if (input.request.requestedModel !== undefined) result.requestedModel = input.request.requestedModel;
  return result;
}

function copyRetrieval(result: CallResult['retrieval']): NormalizedRetrieval | undefined {
  if (!result) return undefined;
  const copied: NormalizedRetrieval = {
    status: result.status,
    queries: [...result.queries],
    sources: result.sources.map(({ url, title }) => ({ url, title })),
    sourcesFound: result.sourcesFound,
  };
  if (result.queryCount !== undefined) copied.queryCount = result.queryCount;
  if (result.note !== undefined) copied.note = result.note;
  return copied;
}

function copyUsage(usage: ProviderTokenUsage | undefined): ProviderTokenUsage | undefined {
  if (!usage) return undefined;
  const copied: ProviderTokenUsage = { provider: usage.provider };
  if (usage.inputTokens !== undefined) copied.inputTokens = usage.inputTokens;
  if (usage.outputTokens !== undefined) copied.outputTokens = usage.outputTokens;
  if (usage.reasoningOrThinkingTokens !== undefined) {
    copied.reasoningOrThinkingTokens = usage.reasoningOrThinkingTokens;
  }
  if (usage.totalTokens !== undefined) copied.totalTokens = usage.totalTokens;
  if (usage.sourceFields) {
    copied.sourceFields = {};
    for (const key of ['inputTokens', 'outputTokens', 'reasoningOrThinkingTokens', 'totalTokens'] as const) {
      const sourceField = usage.sourceFields[key];
      if (sourceField !== undefined) copied.sourceFields[key] = sourceField;
    }
  }
  return copied;
}

function copyFailure(error: ProviderExecutionError): ProviderExecutionError {
  const copied: ProviderExecutionError = {
    provider: error.provider,
    model: error.model,
    category: error.category,
    message: error.message.slice(0, 500),
    dispatchState: error.dispatchState,
    completionState: error.completionState,
  };
  if (error.providerStatus !== undefined) copied.providerStatus = error.providerStatus;
  if (error.providerCode !== undefined) copied.providerCode = error.providerCode.slice(0, 128);
  if (error.providerRequestId !== undefined) {
    copied.providerRequestId = error.providerRequestId.slice(0, 128);
  }
  return copied;
}

function createExecutor(
  provider: ProviderName,
  transport: ProviderTransport,
  preflight?: () => void
): ProviderExecutor {
  return {
    kind: 'MODEL_PROVIDER',
    provider,
    async execute(input: ProviderExecutionInput): Promise<NormalizedExecutionResult> {
      assertBinding(input.request, input.binding, provider);
      const common = identity(input);
      const options = toCallOptions(input.request, input.binding);
      preflight?.();
      let observation: ProviderTransportResult;
      try {
        observation = await transport(input.request.input, options);
      } catch {
        // An unclassified transport error cannot prove whether a provider completed work.
        return {
          ...common,
          outcome: 'UNCERTAIN',
          error: {
            provider,
            model: input.binding.effectiveModel,
            category: 'UNKNOWN',
            message: 'Provider execution outcome could not be established.',
            dispatchState: 'UNKNOWN',
            completionState: 'UNKNOWN',
          },
        };
      }

      if (observation.outcome === 'KNOWN_FAILURE' || observation.outcome === 'UNCERTAIN') {
        const error = copyFailure(observation.error);
        if (error.provider !== provider || error.model !== input.binding.effectiveModel) {
          return {
            ...common,
            outcome: 'UNCERTAIN',
            error: {
              provider,
              model: input.binding.effectiveModel,
              category: 'RESULT_MISMATCH',
              message: 'Transport failure identity did not match the execution binding.',
              dispatchState: 'UNKNOWN',
              completionState: 'UNKNOWN',
            },
          };
        }
        return observation.outcome === 'KNOWN_FAILURE'
          ? { ...common, outcome: 'KNOWN_FAILURE', error: { ...error, completionState: 'FAILED' } }
          : { ...common, outcome: 'UNCERTAIN', error: { ...error, completionState: 'UNKNOWN' } };
      }

      if (
        observation.result.provider !== provider ||
        observation.result.model !== input.binding.effectiveModel ||
        (observation.usage !== undefined && observation.usage.provider !== provider)
      ) {
        return {
          ...common,
          outcome: 'UNCERTAIN',
          error: {
            provider,
            model: input.binding.effectiveModel,
            category: 'RESULT_MISMATCH',
            message: 'Transport response identity did not match the execution binding.',
            dispatchState: 'DISPATCHED',
            completionState: 'UNKNOWN',
          },
        };
      }

      const success: ExecutionSuccess = {
        ...common,
        outcome: 'SUCCESS',
        output: { text: observation.result.text },
      };
      if (observation.reportedModel !== undefined) success.providerReportedModel = observation.reportedModel;
      const retrieval = copyRetrieval(observation.result.retrieval);
      if (retrieval !== undefined) success.retrieval = retrieval;
      const usage = copyUsage(observation.usage);
      if (usage !== undefined) success.usage = usage;
      if (observation.finishReason !== undefined) success.finishReason = observation.finishReason;
      if (observation.providerRequestId !== undefined) {
        success.providerRequestId = observation.providerRequestId.slice(0, 128);
      }
      if (observation.providerMetadata) {
        const metadata: NonNullable<ExecutionSuccess['providerMetadata']> = {};
        if (observation.providerMetadata.serviceTier !== undefined) {
          metadata.serviceTier = observation.providerMetadata.serviceTier.slice(0, 128);
        }
        if (observation.providerMetadata.region !== undefined) {
          metadata.region = observation.providerMetadata.region.slice(0, 128);
        }
        if (Object.keys(metadata).length > 0) success.providerMetadata = metadata;
      }
      return success;
    },
  };
}

export function createClaudeExecutor(
  transport?: ProviderTransport
): ProviderExecutor {
  const defaultTransport: ProviderTransport = async (prompt, options) => ({
    outcome: 'SUCCESS',
    result: await callClaude(prompt, options),
  });
  return createExecutor('claude', transport ?? defaultTransport, transport ? undefined : () => assertProviderConfigured('claude'));
}

export function createOpenAIExecutor(
  transport?: ProviderTransport
): ProviderExecutor {
  const defaultTransport: ProviderTransport = async (prompt, options) => ({
    outcome: 'SUCCESS',
    result: await callOpenAI(prompt, options),
  });
  return createExecutor('openai', transport ?? defaultTransport, transport ? undefined : () => assertProviderConfigured('openai'));
}

export function createGeminiExecutor(
  transport?: ProviderTransport
): ProviderExecutor {
  const defaultTransport: ProviderTransport = async (prompt, options) => ({
    outcome: 'SUCCESS',
    result: await callGemini(prompt, options),
  });
  return createExecutor('gemini', transport ?? defaultTransport, transport ? undefined : () => assertProviderConfigured('gemini'));
}
