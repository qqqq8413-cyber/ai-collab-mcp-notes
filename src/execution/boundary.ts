import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { ProviderName } from '../config.js';
import { assessExecution, canonicalCapabilitySource, validateExecutionRequest, type AdmissionRecord, type CapabilitySource } from './admission.js';
import { resolveProviderBinding } from './executors.js';
import { executionRequestFingerprint } from './fingerprint.js';
import { assertExecutorRegistry, type ExecutorRegistry } from './registry.js';
import type { ExecutionRequest, NormalizedExecutionResult, ProviderBinding, ProviderExecutionAuthorization } from './types.js';

export interface DefaultModelResolver {
  resolveDefaultModel(provider: ProviderName): string | undefined;
}

export type AuthorityClaim =
  | { kind: 'CLAIMED'; attemptId: string; checkpoint: unknown }
  | { kind: 'PRE_CALL_TERMINAL'; attemptId: string; checkpoint: unknown };

/** Composition-owned authority, not an authorization flag carried by a request. */
export interface ExecutionAuthorityPort {
  claim(attemptId: string): AuthorityClaim;
}

export type BoundaryResult =
  | { kind: 'NOT_ADMITTED'; admission: AdmissionRecord; binding?: ProviderBinding }
  | { kind: 'EXECUTOR_UNAVAILABLE'; admission: AdmissionRecord; binding: ProviderBinding; provider: ProviderName }
  | { kind: 'PRE_CALL_TERMINAL'; admission: AdmissionRecord; binding: ProviderBinding; checkpoint: unknown }
  | { kind: 'EXECUTED'; admission: AdmissionRecord; binding: ProviderBinding; result: NormalizedExecutionResult; executionLatencyMs: number };

export interface ExecutionBoundaryDependencies {
  defaultModelResolver: DefaultModelResolver;
  authority: ExecutionAuthorityPort;
  registry: ExecutorRegistry;
  capabilitySource?: CapabilitySource;
  monotonicNow?: () => number;
}

export interface ExecutionBoundary {
  execute(request: unknown): Promise<BoundaryResult>;
}

/** Dependencies are selected by composition, never carried in caller request JSON. */
export function createExecutionBoundary(deps: ExecutionBoundaryDependencies): ExecutionBoundary {
  assertExecutorRegistry(deps.registry);
  const fixed = { ...deps };
  return Object.freeze({ execute: (request: unknown) => executeAtBoundary(request, fixed) });
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

function snapshotRequest(value: unknown): ExecutionRequest {
  const seen = new WeakSet<object>();
  const detach = (node: unknown): unknown => {
    if (node === null || typeof node === 'string' || typeof node === 'boolean' || typeof node === 'number') return node;
    if (typeof node !== 'object' || Array.isArray(node) ||
        (Object.getPrototypeOf(node) !== Object.prototype && Object.getPrototypeOf(node) !== null) || seen.has(node)) {
      throw new TypeError('ExecutionRequest must contain only plain, acyclic data');
    }
    seen.add(node);
    const copy: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(node)) {
      if (typeof key !== 'string') throw new TypeError('ExecutionRequest cannot contain symbol keys');
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError('ExecutionRequest cannot contain accessors');
      copy[key] = detach(descriptor.value);
    }
    seen.delete(node);
    return copy;
  };
  const copy = detach(value);
  validateExecutionRequest(copy);
  return freeze(copy);
}

function verifyClaim(claim: AuthorityClaim, attemptId: string): void {
  if (claim === null || typeof claim !== 'object' || claim.attemptId !== attemptId ||
      (claim.kind !== 'CLAIMED' && claim.kind !== 'PRE_CALL_TERMINAL') ||
      claim.checkpoint === null || typeof claim.checkpoint !== 'object') {
    throw new TypeError('Execution authority returned an invalid claim');
  }
  const checkpoint = claim.checkpoint as Record<string, unknown>;
  if (checkpoint.attemptId !== attemptId ||
      (claim.kind === 'CLAIMED' && (checkpoint.phase !== 'CLAIMED' ||
        typeof checkpoint.latencyLimitMs !== 'number' || !Number.isFinite(checkpoint.latencyLimitMs) || checkpoint.latencyLimitMs <= 0 ||
        checkpoint.reservedLatencyMs !== checkpoint.latencyLimitMs)) ||
      (claim.kind === 'PRE_CALL_TERMINAL' && (checkpoint.phase !== 'TERMINAL_FACT_READY' ||
        Object.hasOwn(checkpoint, 'latencyLimitMs') || checkpoint.reservedLatencyMs !== 0))) {
    throw new TypeError('Execution authority checkpoint does not match its claimed phase');
  }
}

function verifyResult(result: NormalizedExecutionResult, request: ExecutionRequest, binding: ProviderBinding): void {
  if (result === null || typeof result !== 'object' ||
      !['SUCCESS', 'KNOWN_FAILURE', 'UNCERTAIN'].includes(result.outcome) ||
      result.executionId !== request.executionId || result.attemptId !== request.attemptId ||
      result.requestedProvider !== request.provider || result.requestedModel !== request.requestedModel ||
      result.effectiveProvider !== binding.provider || result.effectiveModel !== binding.effectiveModel) {
    throw new TypeError('Executor returned a result for a different execution');
  }
}

/** One fixed request, one local decision, one D1 claim, then at most one execution. */
async function executeAtBoundary(value: unknown, deps: ExecutionBoundaryDependencies): Promise<BoundaryResult> {
  const request = snapshotRequest(value);
  const defaultModel = request.requestedModel === undefined
    ? deps.defaultModelResolver.resolveDefaultModel(request.provider) : undefined;
  if (request.requestedModel === undefined && (typeof defaultModel !== 'string' || !defaultModel.trim())) {
    return freeze({ kind: 'NOT_ADMITTED', admission: {
      policy: 'E0-R3_ADMISSION_V1', status: 'UNRESOLVED', reason: 'DEFAULT_MODEL_UNAVAILABLE', capabilities: [], parameters: [],
    } });
  }
  const binding = freeze(resolveProviderBinding(request, defaultModel ?? ''));
  const admission = freeze(assessExecution(request, binding, deps.capabilitySource ?? canonicalCapabilitySource));
  if (admission.status !== 'ADMITTED') return freeze({ kind: 'NOT_ADMITTED', admission, binding: structuredClone(binding) });

  const executor = deps.registry.resolveModelProvider(request.provider);
  if (!executor) return freeze({ kind: 'EXECUTOR_UNAVAILABLE', admission, binding: structuredClone(binding), provider: request.provider });
  if (executor.kind !== 'MODEL_PROVIDER' || executor.provider !== request.provider) {
    throw new TypeError('Registered executor does not match requested provider');
  }

  const claim = structuredClone(deps.authority.claim(request.attemptId));
  verifyClaim(claim, request.attemptId);
  if (claim.kind === 'PRE_CALL_TERMINAL') {
    return freeze({ kind: 'PRE_CALL_TERMINAL', admission, binding: structuredClone(binding), checkpoint: claim.checkpoint });
  }

  const authorization: ProviderExecutionAuthorization = freeze({
    admissionId: randomUUID(), executionId: request.executionId, attemptId: request.attemptId,
    executorId: executor.executorId,
    provider: binding.provider, effectiveModel: binding.effectiveModel,
    requestFingerprint: executionRequestFingerprint(request, binding),
  });
  const now = deps.monotonicNow ?? (() => performance.now());
  const started = now();
  if (!Number.isFinite(started)) throw new TypeError('Execution clock is invalid');
  const result = structuredClone(await executor.execute({ request, binding, authorization }));
  const ended = now();
  if (!Number.isFinite(ended) || ended < started) throw new TypeError('Execution clock is invalid');
  verifyResult(result, request, binding);
  return freeze({ kind: 'EXECUTED', admission, binding: structuredClone(binding), result, executionLatencyMs: ended - started });
}
