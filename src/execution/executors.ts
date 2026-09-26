import { assertProviderConfigured, type ProviderName } from '../config.js';
import type { CallOptions, CallResult } from '../providers/types.js';
import { callClaude } from '../providers/claude.js';
import { callOpenAI } from '../providers/openai.js';
import { callGemini } from '../providers/gemini.js';
import { executionRequestFingerprint } from './fingerprint.js';
import type {
  ExecutionRequest,
  ExecutionResultIdentity,
  ExecutionSuccess,
  NormalizedExecutionResult,
  NormalizedRetrieval,
  ProviderBinding,
  ProviderExecutionAuthorization,
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

/**
 * The fixed facts of one execution. Everything an executor checks, dispatches,
 * matches, and reports is read from this, never from the caller's input.
 */
export interface ExecutionSnapshot {
  readonly request: Readonly<ExecutionRequest>;
  readonly binding: Readonly<ProviderBinding>;
  readonly authorization: Readonly<ProviderExecutionAuthorization>;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Detaches an execution from its caller in one synchronous step: request,
 * binding, and authorization are each read once, deep-copied with
 * structuredClone (nested parameters, retrieval, origin, and anything added
 * later included), and frozen. The caller can mutate its own objects while the
 * transport is pending without changing any fact of the execution in flight.
 * An ownership / async-boundary snapshot, not cryptographic immutability; input
 * that is not plain cloneable data is refused.
 */
export function snapshotExecutionInput(input: ProviderExecutionInput): ExecutionSnapshot {
  if (!isRecord(input)) throw new TypeError('Execution input must be an object');
  const snapshot: unknown = structuredClone({
    request: input.request,
    binding: input.binding,
    authorization: input.authorization,
  });
  if (!isRecord(snapshot) || !isRecord(snapshot.request) || !isRecord(snapshot.binding) || !isRecord(snapshot.authorization)) {
    throw new TypeError('Execution input must carry request, binding, and authorization objects');
  }
  return deepFreeze(snapshot as unknown as ExecutionSnapshot);
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

function assertAuthorization(snapshot: ExecutionSnapshot): void {
  const { request, binding, authorization } = snapshot;
  if (
    typeof authorization.admissionId !== 'string' || !authorization.admissionId.trim() ||
    authorization.executionId !== request.executionId ||
    authorization.attemptId !== request.attemptId ||
    authorization.provider !== binding.provider ||
    authorization.effectiveModel !== binding.effectiveModel ||
    authorization.requestFingerprint !== executionRequestFingerprint(request, binding)
  ) {
    throw new TypeError('Execution authorization does not match the fixed request and binding');
  }
}

// Built only from the snapshot, as fresh objects: the transport owns what it
// receives, and nothing it changes there reaches the snapshot or the caller.
function toCallOptions(request: Readonly<ExecutionRequest>, binding: Readonly<ProviderBinding>): CallOptions {
  // The existing adapters own max_tokens, max_completion_tokens, and maxOutputTokens.
  const options: CallOptions = { model: binding.effectiveModel };
  if (request.systemInstruction !== undefined) options.system = request.systemInstruction;
  if (request.stage !== undefined) options.stage = request.stage;
  if (request.retrieval !== undefined) options.retrieval = structuredClone(request.retrieval);
  if (Object.hasOwn(request.parameters, 'temperature')) {
    options.temperature = request.parameters.temperature!.value;
  }
  if (Object.hasOwn(request.parameters, 'max_output_tokens')) {
    options.maxTokens = request.parameters.max_output_tokens!.value;
  }
  return options;
}

function identity({ request, binding }: ExecutionSnapshot): ExecutionResultIdentity {
  const result: ExecutionResultIdentity = {
    executionId: request.executionId,
    attemptId: request.attemptId,
    requestedProvider: request.provider,
    effectiveProvider: binding.provider,
    effectiveModel: binding.effectiveModel,
  };
  if (request.requestedModel !== undefined) result.requestedModel = request.requestedModel;
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
      // One execution, one fixed fact snapshot, taken before anything can await.
      // From here on the caller's input is never read again: binding checks,
      // dispatch, response and failure matching, and the result identity all
      // use these same facts.
      const snapshot = snapshotExecutionInput(input);
      const { request, binding } = snapshot;
      assertBinding(request, binding, provider);
      assertAuthorization(snapshot);
      const common = identity(snapshot);
      const expectedModel = binding.effectiveModel;
      const options = toCallOptions(request, binding);
      preflight?.();
      let observation: ProviderTransportResult;
      try {
        observation = await transport(request.input, options);
      } catch {
        // An unclassified transport error cannot prove whether a provider completed work.
        return {
          ...common,
          outcome: 'UNCERTAIN',
          error: {
            provider,
            model: expectedModel,
            category: 'UNKNOWN',
            message: 'Provider execution outcome could not be established.',
            dispatchState: 'UNKNOWN',
            completionState: 'UNKNOWN',
          },
        };
      }

      // Each transport fact is read once and copied before it is checked, so the
      // value validated is the value recorded.
      const outcome = observation.outcome;
      if (outcome === 'KNOWN_FAILURE' || outcome === 'UNCERTAIN') {
        const error = copyFailure((observation as Exclude<ProviderTransportResult, TransportSuccess>).error);
        if (error.provider !== provider || error.model !== expectedModel) {
          return {
            ...common,
            outcome: 'UNCERTAIN',
            error: {
              provider,
              model: expectedModel,
              category: 'RESULT_MISMATCH',
              message: 'Transport failure identity did not match the execution binding.',
              dispatchState: 'UNKNOWN',
              completionState: 'UNKNOWN',
            },
          };
        }
        return outcome === 'KNOWN_FAILURE'
          ? { ...common, outcome: 'KNOWN_FAILURE', error: { ...error, completionState: 'FAILED' } }
          : { ...common, outcome: 'UNCERTAIN', error: { ...error, completionState: 'UNKNOWN' } };
      }

      const reported = (observation as TransportSuccess).result;
      const reportedProvider = reported.provider;
      const reportedResultModel = reported.model;
      const text = reported.text;
      const usage = copyUsage((observation as TransportSuccess).usage);
      if (
        reportedProvider !== provider ||
        reportedResultModel !== expectedModel ||
        (usage !== undefined && usage.provider !== provider)
      ) {
        return {
          ...common,
          outcome: 'UNCERTAIN',
          error: {
            provider,
            model: expectedModel,
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
        output: { text },
      };
      const { reportedModel, finishReason, providerRequestId, providerMetadata } = observation as TransportSuccess;
      if (reportedModel !== undefined) success.providerReportedModel = reportedModel;
      const retrieval = copyRetrieval(reported.retrieval);
      if (retrieval !== undefined) success.retrieval = retrieval;
      if (usage !== undefined) success.usage = usage;
      if (finishReason !== undefined) success.finishReason = finishReason;
      if (providerRequestId !== undefined) {
        success.providerRequestId = providerRequestId.slice(0, 128);
      }
      if (providerMetadata) {
        const metadata: NonNullable<ExecutionSuccess['providerMetadata']> = {};
        const { serviceTier, region } = providerMetadata;
        if (serviceTier !== undefined) {
          metadata.serviceTier = serviceTier.slice(0, 128);
        }
        if (region !== undefined) {
          metadata.region = region.slice(0, 128);
        }
        if (Object.keys(metadata).length > 0) success.providerMetadata = metadata;
      }
      return success;
    },
  };
}

/** A default transport keeps the adapter's native completion reason as finishReason. */
function adapterSuccess(result: CallResult): TransportSuccess {
  const finishReason = result.completion?.providerReason;
  return finishReason === undefined
    ? { outcome: 'SUCCESS', result }
    : { outcome: 'SUCCESS', result, finishReason };
}

export function createClaudeExecutor(
  transport?: ProviderTransport
): ProviderExecutor {
  const defaultTransport: ProviderTransport = async (prompt, options) =>
    adapterSuccess(await callClaude(prompt, options));
  return createExecutor('claude', transport ?? defaultTransport, transport ? undefined : () => assertProviderConfigured('claude'));
}

export function createOpenAIExecutor(
  transport?: ProviderTransport
): ProviderExecutor {
  const defaultTransport: ProviderTransport = async (prompt, options) =>
    adapterSuccess(await callOpenAI(prompt, options));
  return createExecutor('openai', transport ?? defaultTransport, transport ? undefined : () => assertProviderConfigured('openai'));
}

export function createGeminiExecutor(
  transport?: ProviderTransport
): ProviderExecutor {
  const defaultTransport: ProviderTransport = async (prompt, options) =>
    adapterSuccess(await callGemini(prompt, options));
  return createExecutor('gemini', transport ?? defaultTransport, transport ? undefined : () => assertProviderConfigured('gemini'));
}
