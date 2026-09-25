import type { ProviderName } from '../config.js';
import type { ParameterName } from '../models/capabilities.js';
import type { CallStage, RetrievalRequest } from '../providers/types.js';

/** A supplied value is distinct from a parameter absent from the request. */
export interface RequestedParameter {
  value: number;
}

export type RequestedParameters = Partial<Record<ParameterName, RequestedParameter>>;

/** Normalized CHIEF intent; provider wire shapes belong to provider adapters. */
export interface ExecutionRequest {
  executionId: string;
  attemptId: string;
  provider: ProviderName;
  /** Absent when a configured default model is requested. */
  requestedModel?: string;
  input: string;
  systemInstruction?: string;
  parameters: RequestedParameters;
  retrieval?: RetrievalRequest;
  stage?: CallStage;
  origin?: { runId?: string; sourceRef?: string };
}

export interface ProviderBinding {
  provider: ProviderName;
  requestedModel?: string;
  effectiveModel: string;
  resolutionBasis: 'EXPLICIT' | 'DEFAULT';
}

/** R3 will issue this after admission; R2 executors do not evaluate it. */
export interface ProviderExecutionAuthorization {
  admissionId: string;
  executionId: string;
  attemptId: string;
}

export interface ProviderExecutionInput {
  request: ExecutionRequest;
  binding: ProviderBinding;
  authorization: ProviderExecutionAuthorization;
}

export interface ProviderExecutor {
  readonly kind: 'MODEL_PROVIDER';
  readonly provider: ProviderName;
  execute(input: ProviderExecutionInput): Promise<NormalizedExecutionResult>;
}

/** All values are optional provider-reported facts; no totals are inferred. */
export interface ProviderTokenUsage {
  provider: ProviderName;
  inputTokens?: number;
  outputTokens?: number;
  reasoningOrThinkingTokens?: number;
  totalTokens?: number;
  sourceFields?: {
    inputTokens?: string;
    outputTokens?: string;
    reasoningOrThinkingTokens?: string;
    totalTokens?: string;
  };
}

/** Unlike legacy RetrievalResult, arbitrary raw SDK metadata is not carried. */
export interface NormalizedRetrieval {
  status: 'GROUNDED' | 'UNGROUNDED' | 'FAILED';
  queries: string[];
  queryCount?: number;
  sources: Array<{ url: string; title?: string }>;
  sourcesFound: number;
  note?: string;
}

export interface ProviderExecutionError {
  provider: ProviderName;
  model: string;
  category: 'PROVIDER_REJECTION' | 'TRANSPORT' | 'RESULT_MISMATCH' | 'UNKNOWN';
  message: string;
  providerStatus?: number;
  providerCode?: string;
  providerRequestId?: string;
  dispatchState: 'NOT_DISPATCHED' | 'DISPATCHED' | 'UNKNOWN';
  completionState: 'FAILED' | 'UNKNOWN';
}

export interface ExecutionResultIdentity {
  executionId: string;
  attemptId: string;
  requestedProvider: ProviderName;
  requestedModel?: string;
  effectiveProvider: ProviderName;
  effectiveModel: string;
}

export interface ExecutionSuccess extends ExecutionResultIdentity {
  outcome: 'SUCCESS';
  output: { text: string };
  /** Present only when independently reported by the transport/provider. */
  providerReportedModel?: string;
  retrieval?: NormalizedRetrieval;
  usage?: ProviderTokenUsage;
  finishReason?: string;
  providerRequestId?: string;
  /** Explicit allowlist; values must be bounded before inclusion. */
  providerMetadata?: { serviceTier?: string; region?: string };
}

export interface ExecutionKnownFailure extends ExecutionResultIdentity {
  outcome: 'KNOWN_FAILURE';
  error: ProviderExecutionError & { completionState: 'FAILED' };
}

export interface ExecutionUncertain extends ExecutionResultIdentity {
  outcome: 'UNCERTAIN';
  error: ProviderExecutionError & { completionState: 'UNKNOWN' };
}

export type NormalizedExecutionResult =
  | ExecutionSuccess
  | ExecutionKnownFailure
  | ExecutionUncertain;
