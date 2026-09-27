import { randomUUID } from 'node:crypto';
import { validateExecutionRequest } from '../execution/admission.js';
import type { ExecutionBoundary } from '../execution/boundary.js';
import type { ExecutionRequest } from '../execution/types.js';
import { consultationInputFingerprint } from './fingerprint.js';
import type { ConsultationRecord, ConsultationRequest, ConsultationRouteBinding, ConsultationRouteBindingPort } from './types.js';

const REQUEST_KEYS = ['attemptId', 'consultantRoleId', 'provider', 'requestedModel', 'input', 'systemInstruction', 'parameters'];
const BINDING_KEYS = ['deliberationStateId', 'sessionId', 'artifactHash', 'authorContextHash', 'attemptId', 'decisionId', 'questionId', 'route', 'inputRefs'];
const REF_KINDS = new Set(['FINDING', 'SEMANTIC_ISSUE', 'AUTHOR_CONTEXT_ITEM']);

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactData(value: unknown, allowed: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!plain(value)) throw new TypeError(`${label} must be plain data`);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key) ||
      !Object.getOwnPropertyDescriptor(value, key)?.enumerable ||
      !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) {
    throw new TypeError(`${label} has an unexpected or non-data field`);
  }
}

function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const member of Object.values(value)) deepFreeze(member);
    Object.freeze(value);
  }
  return value;
}

/** Reject getters and unknown fields before any route read or identity mint. */
export function snapshotConsultationRequest(value: unknown): ConsultationRequest {
  exactData(value, REQUEST_KEYS, 'ConsultationRequest');
  if (!nonempty(value.attemptId) || !nonempty(value.consultantRoleId) || typeof value.input !== 'string' ||
      !Object.hasOwn(value, 'parameters')) throw new TypeError('ConsultationRequest identity or input is invalid');
  exactData(value.parameters, ['temperature', 'max_output_tokens'], 'ConsultationRequest.parameters');
  const parameters: ConsultationRequest['parameters'] = {};
  for (const name of Object.keys(value.parameters) as Array<keyof ConsultationRequest['parameters']>) {
    const item = value.parameters[name];
    exactData(item, ['value'], `ConsultationRequest.parameters.${name}`);
    if (Reflect.ownKeys(item).length !== 1 || !Object.hasOwn(item, 'value') ||
        typeof item.value !== 'number' || !Number.isFinite(item.value)) {
      throw new TypeError(`ConsultationRequest.parameters.${name} is invalid`);
    }
    parameters[name] = { value: item.value };
  }
  const request: ConsultationRequest = {
    attemptId: value.attemptId,
    consultantRoleId: value.consultantRoleId,
    provider: value.provider as ConsultationRequest['provider'],
    input: value.input,
    parameters,
  };
  if (Object.hasOwn(value, 'requestedModel')) request.requestedModel = value.requestedModel as string;
  if (Object.hasOwn(value, 'systemInstruction')) request.systemInstruction = value.systemInstruction as string;
  const validationInput: ExecutionRequest = { executionId: 'consultation-schema-validation',
    attemptId: request.attemptId, provider: request.provider, input: request.input, parameters: request.parameters };
  if (Object.hasOwn(request, 'requestedModel')) validationInput.requestedModel = request.requestedModel;
  if (Object.hasOwn(request, 'systemInstruction')) validationInput.systemInstruction = request.systemInstruction;
  validateExecutionRequest(validationInput);
  return deepFreeze(request);
}

/** Snapshot the trusted port's response before an async execution can begin. */
function snapshotBinding(value: unknown, attemptId: string): ConsultationRouteBinding {
  exactData(value, BINDING_KEYS, 'ConsultationRouteBinding');
  for (const key of BINDING_KEYS.slice(0, 7)) {
    if (!nonempty(value[key])) throw new TypeError(`ConsultationRouteBinding.${key} is invalid`);
  }
  if (value.attemptId !== attemptId || (value.route !== 'ADD_REVIEWER' && value.route !== 'REPLICATE') ||
      !Array.isArray(value.inputRefs)) throw new TypeError('ConsultationRouteBinding is not an exact supported route');
  const refs = value.inputRefs.map((ref: unknown) => {
    exactData(ref, ['kind', 'id'], 'ConsultationRouteBinding.inputRefs[]');
    if (Reflect.ownKeys(ref).length !== 2 || !REF_KINDS.has(ref.kind as string) || !nonempty(ref.id)) {
      throw new TypeError('ConsultationRouteBinding.inputRefs[] is invalid');
    }
    return { kind: ref.kind, id: ref.id } as ConsultationRouteBinding['inputRefs'][number];
  });
  if (refs.length === 0) throw new TypeError('ConsultationRouteBinding has no input refs');
  return deepFreeze({ deliberationStateId: value.deliberationStateId as string, sessionId: value.sessionId as string,
    artifactHash: value.artifactHash as string, authorContextHash: value.authorContextHash as string,
    attemptId: value.attemptId as string, decisionId: value.decisionId as string,
    questionId: value.questionId as string, route: value.route, inputRefs: refs });
}

function sameBinding(a: ConsultationRouteBinding, b: ConsultationRouteBinding): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface ConsultationCoordinator {
  consult(request: unknown): Promise<ConsultationRecord>;
}

/** One consultation, one R4 boundary call. The ports are trusted composition dependencies. */
export function createConsultationCoordinator(bindingPort: ConsultationRouteBindingPort, boundary: ExecutionBoundary): ConsultationCoordinator {
  if (!bindingPort || typeof bindingPort.resolve !== 'function' || !boundary || typeof boundary.execute !== 'function') {
    throw new TypeError('Consultation coordinator requires a binding port and ExecutionBoundary');
  }
  return Object.freeze({
    async consult(value: unknown): Promise<ConsultationRecord> {
      const request = snapshotConsultationRequest(value);
      const binding = snapshotBinding(bindingPort.resolve(request.attemptId), request.attemptId);
      const consultationId = randomUUID();
      const executionId = randomUUID();
      const executionRequest: ExecutionRequest = { executionId, attemptId: request.attemptId,
        provider: request.provider, input: request.input, parameters: structuredClone(request.parameters) };
      if (Object.hasOwn(request, 'requestedModel')) executionRequest.requestedModel = request.requestedModel;
      if (Object.hasOwn(request, 'systemInstruction')) executionRequest.systemInstruction = request.systemInstruction;
      const boundaryResult = deepFreeze(structuredClone(await boundary.execute(executionRequest)));
      let provenanceStatus: ConsultationRecord['provenanceStatus'] = 'STABLE';
      try {
        const after = snapshotBinding(bindingPort.resolve(request.attemptId), request.attemptId);
        if (!sameBinding(binding, after)) throw new Error('Consultation route binding changed during execution');
      } catch (error) {
        if (boundaryResult.kind !== 'EXECUTED') throw error;
        provenanceStatus = 'PROVENANCE_UNCERTAIN';
      }
      const record: ConsultationRecord = {
        consultationId, executionId, consultationKind: binding.route, consultantRoleId: request.consultantRoleId,
        routeBinding: binding, requestedProvider: request.provider,
        consultationInputFingerprint: consultationInputFingerprint(request, binding), structuredPeerContext: 'NONE',
        provenanceStatus, boundaryResult,
      };
      if (Object.hasOwn(request, 'requestedModel')) record.requestedModel = request.requestedModel;
      return deepFreeze(record);
    },
  });
}
