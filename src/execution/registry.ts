import type { ProviderName } from '../config.js';
import { snapshotExecutionInput } from './executors.js';
import type { NormalizedExecutionResult, ProviderExecutionInput, ProviderExecutor } from './types.js';

export type ExecutorKind = 'MODEL_PROVIDER' | 'MCP' | 'CLI_AGENT' | 'REMOTE_AGENT';
export type FutureExecutorKind = Exclude<ExecutorKind, 'MODEL_PROVIDER'>;

export type ExecutorRegistration =
  | { kind: 'MODEL_PROVIDER'; executorId: string; provider: ProviderName; executor: ProviderExecutor }
  | { kind: FutureExecutorKind; executorId: string };

export type ExecutorDescriptor =
  | { kind: 'MODEL_PROVIDER'; executorId: string; provider: ProviderName }
  | { kind: FutureExecutorKind; executorId: string };

export interface RegisteredModelProvider {
  readonly kind: 'MODEL_PROVIDER';
  readonly executorId: string;
  readonly provider: ProviderName;
  execute(input: ProviderExecutionInput): Promise<NormalizedExecutionResult>;
}

const BRAND = Symbol('E0-R4 ExecutorRegistry');
const INSTANCES = new WeakSet<object>();
const KINDS = new Set<ExecutorKind>(['MODEL_PROVIDER', 'MCP', 'CLI_AGENT', 'REMOTE_AGENT']);
const PROVIDER_NAMES = new Set<ProviderName>(['claude', 'openai', 'gemini']);

export interface ExecutorRegistry {
  readonly [BRAND]: true;
  get(kind: ExecutorKind, executorId: string): ExecutorDescriptor | undefined;
  list(): ExecutorDescriptor[];
  resolveModelProvider(provider: ProviderName): RegisteredModelProvider | undefined;
}

function assertRegistrationShape(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError('Executor registration must be a plain object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || !Object.hasOwn(descriptors[key], 'value'))) {
    throw new TypeError('Executor registration must contain only own data fields');
  }
  const kind = descriptors.kind?.value;
  if (!KINDS.has(kind)) throw new TypeError('Unknown executor kind');
  const expected = kind === 'MODEL_PROVIDER' ? ['kind', 'executorId', 'provider', 'executor'] : ['kind', 'executorId'];
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key as string))) {
    throw new TypeError('Executor registration has unexpected or missing fields');
  }
}

function descriptorCopy(descriptor: ExecutorDescriptor): ExecutorDescriptor {
  return descriptor.kind === 'MODEL_PROVIDER'
    ? { kind: descriptor.kind, executorId: descriptor.executorId, provider: descriptor.provider }
    : { kind: descriptor.kind, executorId: descriptor.executorId };
}

/** Immutable composition snapshot. Registration is mechanism availability, never execution authority. */
export function createExecutorRegistry(registrations: readonly ExecutorRegistration[]): ExecutorRegistry {
  if (!Array.isArray(registrations)) throw new TypeError('Executor registrations must be an array');
  const byId = new Map<string, ExecutorDescriptor>();
  const byProvider = new Map<ProviderName, RegisteredModelProvider>();
  for (let index = 0; index < registrations.length; index++) {
    if (!Object.hasOwn(registrations, index)) throw new TypeError('Sparse executor registrations are invalid');
    const registration: unknown = registrations[index];
    assertRegistrationShape(registration);
    const kind = registration.kind as ExecutorKind;
    const executorId = registration.executorId;
    if (typeof executorId !== 'string' || !executorId.trim()) throw new TypeError('executorId must be nonempty');
    if (byId.has(executorId)) throw new TypeError(`Duplicate executorId: ${executorId}`);
    if (kind !== 'MODEL_PROVIDER') {
      byId.set(executorId, Object.freeze({ kind, executorId }));
      continue;
    }
    const provider = registration.provider as ProviderName;
    const executor = registration.executor as ProviderExecutor;
    if (!PROVIDER_NAMES.has(provider) || executor === null || typeof executor !== 'object') {
      throw new TypeError('MODEL_PROVIDER registration has an invalid provider or executor');
    }
    const executorKind = executor.kind;
    const executorProvider = executor.provider;
    const capturedExecute = executor.execute;
    if (executorKind !== 'MODEL_PROVIDER' || executorProvider !== provider || typeof capturedExecute !== 'function') {
      throw new TypeError('MODEL_PROVIDER registration and executor disagree');
    }
    if (byProvider.has(provider)) throw new TypeError(`Duplicate MODEL_PROVIDER mechanism: ${provider}`);
    const receiver = Object.freeze({ kind: 'MODEL_PROVIDER' as const, provider });
    const mechanism: RegisteredModelProvider = Object.freeze({
      kind: 'MODEL_PROVIDER' as const, executorId, provider,
      execute(input: ProviderExecutionInput): Promise<NormalizedExecutionResult> {
        const fixed = snapshotExecutionInput(input);
        if (fixed.authorization.executorId !== executorId ||
            fixed.request.provider !== provider || fixed.binding.provider !== provider ||
            fixed.authorization.provider !== provider) {
          throw new TypeError('Execution authorization does not match the registered executor');
        }
        return capturedExecute.call(receiver, fixed as ProviderExecutionInput);
      },
    });
    byId.set(executorId, Object.freeze({ kind: 'MODEL_PROVIDER', executorId, provider }));
    byProvider.set(provider, mechanism);
  }
  const registry = Object.freeze({
    [BRAND]: true as const,
    get(kind: ExecutorKind, executorId: string): ExecutorDescriptor | undefined {
      const found = byId.get(executorId);
      return found?.kind === kind ? descriptorCopy(found) : undefined;
    },
    list(): ExecutorDescriptor[] { return Array.from(byId.values(), descriptorCopy); },
    resolveModelProvider(provider: ProviderName): RegisteredModelProvider | undefined {
      return byProvider.get(provider);
    },
  });
  INSTANCES.add(registry);
  return registry;
}

export function assertExecutorRegistry(value: unknown): asserts value is ExecutorRegistry {
  if (value === null || typeof value !== 'object' || !INSTANCES.has(value)) {
    throw new TypeError('Execution boundary requires an ExecutorRegistry created by composition');
  }
}
