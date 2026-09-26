import type { ProviderName } from '../config.js';
import {
  getCapabilityAssessment,
  getModelProfile,
  getParameterAssessment,
  type AssessmentLookup,
  type CapabilityAssessment,
  type ModelCapability,
  type ModelProfileLookup,
  type ParameterAssessment,
  type ParameterName,
} from '../models/capabilities.js';
import type { ExecutionRequest, ProviderBinding } from './types.js';

export const ADMISSION_POLICY = 'E0-R3_ADMISSION_V1' as const;
export const PARAMETER_NAMES = ['temperature', 'max_output_tokens'] as const;

export interface CapabilitySource {
  getModelProfile(provider: ProviderName, model: string): ModelProfileLookup;
  getCapabilityAssessment(provider: ProviderName, model: string, capability: ModelCapability): AssessmentLookup<CapabilityAssessment>;
  getParameterAssessment(provider: ProviderName, model: string, parameter: ParameterName): AssessmentLookup<ParameterAssessment>;
}

export const canonicalCapabilitySource: CapabilitySource = {
  getModelProfile,
  getCapabilityAssessment,
  getParameterAssessment,
};

export type Disposition = 'FORWARD' | 'OMIT' | 'REJECT' | 'UNKNOWN';
export interface ParameterDecision {
  parameter: ParameterName;
  request: { state: 'ABSENT' } | { state: 'PRESENT'; value: number };
  disposition: Disposition;
  effectiveValue?: number;
  reason: string;
  readiness?: string;
  evidenceRefs: string[];
}
export interface CapabilityDecision {
  capability: 'system_prompt' | 'grounded_retrieval';
  disposition: 'ADMITTED' | 'REJECTED' | 'UNRESOLVED';
  readiness?: string;
  evidenceRefs: string[];
}
export interface AdmissionRecord {
  policy: typeof ADMISSION_POLICY;
  status: 'ADMITTED' | 'REJECTED' | 'UNRESOLVED';
  reason: string;
  capabilities: CapabilityDecision[];
  parameters: ParameterDecision[];
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function exact(value: unknown, allowed: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!record(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
      Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !allowed.includes(key))) {
    throw new TypeError(`${label} has an invalid shape`);
  }
}

const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const stages = new Set(['planning', 'round1_worker', 'synthesis', 'synthesis_gate', 'round2_worker', 'decision_synthesis']);
const providers = new Set(['claude', 'openai', 'gemini']);

/** Validate the detached entry snapshot; no coercion, defaults, or unknown keys. */
export function validateExecutionRequest(value: unknown): asserts value is ExecutionRequest {
  exact(value, ['executionId', 'attemptId', 'provider', 'requestedModel', 'input', 'systemInstruction',
    'parameters', 'retrieval', 'stage', 'origin'], 'ExecutionRequest');
  if (!nonempty(value.executionId) || !nonempty(value.attemptId) || !providers.has(value.provider as string) ||
      typeof value.input !== 'string') throw new TypeError('ExecutionRequest identity or input is invalid');
  if (Object.hasOwn(value, 'requestedModel') && !nonempty(value.requestedModel)) throw new TypeError('requestedModel must be nonempty');
  if (Object.hasOwn(value, 'systemInstruction') && typeof value.systemInstruction !== 'string') throw new TypeError('systemInstruction must be a string');
  if (Object.hasOwn(value, 'stage') && !stages.has(value.stage as string)) throw new TypeError('stage is invalid');
  exact(value.parameters, PARAMETER_NAMES, 'parameters');
  for (const name of Object.keys(value.parameters)) {
    const parameter = value.parameters[name];
    exact(parameter, ['value'], `parameter ${name}`);
    if (!Object.hasOwn(parameter, 'value') || typeof parameter.value !== 'number' || !Number.isFinite(parameter.value)) {
      throw new TypeError(`parameter ${name} must have a finite value`);
    }
  }
  if (Object.hasOwn(value, 'retrieval')) {
    exact(value.retrieval, ['enabled'], 'retrieval');
    if (!Object.hasOwn(value.retrieval, 'enabled') || typeof value.retrieval.enabled !== 'boolean') throw new TypeError('retrieval.enabled is invalid');
  }
  if (Object.hasOwn(value, 'origin')) {
    exact(value.origin, ['runId', 'sourceRef'], 'origin');
    for (const key of Object.keys(value.origin)) if (!nonempty(value.origin[key])) throw new TypeError(`origin.${key} must be nonempty`);
  }
}

function evidenceRefs(assessment: { evidence?: unknown }): string[] {
  if (!Array.isArray(assessment.evidence)) return [];
  return assessment.evidence.slice(0, 8).map((item: unknown) =>
    record(item) && typeof item.source === 'string' ? item.source.slice(0, 256) : '').filter(Boolean);
}

function parameterDecision(request: ExecutionRequest, binding: ProviderBinding, source: CapabilitySource, parameter: ParameterName): ParameterDecision {
  if (!Object.hasOwn(request.parameters, parameter)) {
    return { parameter, request: { state: 'ABSENT' }, disposition: 'OMIT', reason: 'ABSENT', evidenceRefs: [] };
  }
  const value = request.parameters[parameter]!.value;
  const base: ParameterDecision = { parameter, request: { state: 'PRESENT', value }, disposition: 'UNKNOWN', reason: 'MISSING_ASSESSMENT', evidenceRefs: [] };
  const lookup = structuredClone(source.getParameterAssessment(binding.provider, binding.effectiveModel, parameter));
  if (lookup.status !== 'FOUND' || !record(lookup.assessment) || !record(lookup.assessment.constraint)) return base;
  const assessment = lookup.assessment;
  const constraint = assessment.constraint;
  base.readiness = assessment.readiness;
  base.evidenceRefs = evidenceRefs(assessment);
  if (constraint.kind === 'UNSUPPORTED' || constraint.explicitTransmission === 'DISALLOWED') {
    return { ...base, disposition: 'REJECT', reason: 'UNSUPPORTED_OR_DISALLOWED' };
  }
  if (constraint.kind === 'UNKNOWN' || constraint.explicitTransmission === 'UNKNOWN' || assessment.readiness !== 'VERIFIED') {
    return { ...base, reason: 'UNVERIFIED_OR_UNKNOWN' };
  }
  if (constraint.explicitTransmission !== 'ALLOWED') return base;
  let valid = false;
  if (constraint.kind === 'FIXED') valid = typeof constraint.value === 'number' && Number.isFinite(constraint.value) && value === constraint.value;
  if (constraint.kind === 'NUMERIC_RANGE') valid =
    typeof constraint.min === 'number' && Number.isFinite(constraint.min) &&
    typeof constraint.max === 'number' && Number.isFinite(constraint.max) &&
    typeof constraint.minInclusive === 'boolean' && typeof constraint.maxInclusive === 'boolean' &&
    (constraint.minInclusive ? value >= constraint.min : value > constraint.min) &&
    (constraint.maxInclusive ? value <= constraint.max : value < constraint.max);
  if (constraint.kind === 'DISCRETE_VALUES') valid = Array.isArray(constraint.values) &&
    constraint.values.every((entry: unknown) => typeof entry === 'number' && Number.isFinite(entry)) && constraint.values.includes(value);
  if (!['FIXED', 'NUMERIC_RANGE', 'DISCRETE_VALUES'].includes(constraint.kind as string)) return base;
  return valid
    ? { ...base, disposition: 'FORWARD', effectiveValue: value, reason: 'VERIFIED_ALLOWED_VALUE' }
    : { ...base, disposition: 'REJECT', reason: 'VALUE_OUTSIDE_CONSTRAINT' };
}

export function assessExecution(request: ExecutionRequest, binding: ProviderBinding, source: CapabilitySource): AdmissionRecord {
  const capabilities: CapabilityDecision[] = [];
  const parameters: ParameterDecision[] = [];
  const profile = structuredClone(source.getModelProfile(binding.provider, binding.effectiveModel));
  if (profile.status !== 'FOUND' || profile.profile.provider !== binding.provider || profile.profile.model !== binding.effectiveModel) {
    return { policy: ADMISSION_POLICY, status: 'UNRESOLVED', reason: 'UNKNOWN_MODEL', capabilities, parameters };
  }
  const required: Array<CapabilityDecision['capability']> = [];
  if (request.systemInstruction !== undefined) required.push('system_prompt');
  if (request.retrieval?.enabled === true) required.push('grounded_retrieval');
  for (const capability of required) {
    const lookup = structuredClone(source.getCapabilityAssessment(binding.provider, binding.effectiveModel, capability));
    if (lookup.status !== 'FOUND' || !record(lookup.assessment)) {
      capabilities.push({ capability, disposition: 'UNRESOLVED', evidenceRefs: [] });
      continue;
    }
    const assessment = lookup.assessment;
    const disposition = assessment.readiness === 'VERIFIED' && assessment.providerSupport === 'SUPPORTED' && assessment.runtimeEnablement === 'ENABLED'
      ? 'ADMITTED' : assessment.readiness === 'UNSUPPORTED' ? 'REJECTED' : 'UNRESOLVED';
    capabilities.push({ capability, disposition, readiness: assessment.readiness, evidenceRefs: evidenceRefs(assessment) });
  }
  for (const parameter of PARAMETER_NAMES) parameters.push(parameterDecision(request, binding, source, parameter));
  const status = capabilities.some((item) => item.disposition === 'REJECTED') || parameters.some((item) => item.disposition === 'REJECT')
    ? 'REJECTED' : capabilities.some((item) => item.disposition === 'UNRESOLVED') || parameters.some((item) => item.disposition === 'UNKNOWN')
      ? 'UNRESOLVED' : 'ADMITTED';
  return { policy: ADMISSION_POLICY, status, reason: status === 'ADMITTED' ? 'LOCAL_ADMISSION_PASSED' : 'LOCAL_ADMISSION_BLOCKED', capabilities, parameters };
}
