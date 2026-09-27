import { createHash } from 'node:crypto';
import type { ConsultationRequest, ConsultationRouteBinding } from './types.js';

/** Canonical field order and explicit optional-field presence; integrity, not authentication. */
export function consultationInputFingerprint(request: ConsultationRequest, binding: ConsultationRouteBinding): string {
  const payload = {
    consultantRoleId: request.consultantRoleId,
    attemptId: request.attemptId,
    provider: request.provider,
    requestedModel: { present: Object.hasOwn(request, 'requestedModel'), value: request.requestedModel ?? null },
    input: request.input,
    systemInstruction: { present: Object.hasOwn(request, 'systemInstruction'), value: request.systemInstruction ?? null },
    parameters: {
      temperature: Object.hasOwn(request.parameters, 'temperature') ? request.parameters.temperature!.value : null,
      max_output_tokens: Object.hasOwn(request.parameters, 'max_output_tokens') ? request.parameters.max_output_tokens!.value : null,
    },
    routeBinding: {
      deliberationStateId: binding.deliberationStateId,
      sessionId: binding.sessionId,
      artifactHash: binding.artifactHash,
      authorContextHash: binding.authorContextHash,
      attemptId: binding.attemptId,
      decisionId: binding.decisionId,
      questionId: binding.questionId,
      route: binding.route,
      inputRefs: binding.inputRefs.map((ref) => ({ kind: ref.kind, id: ref.id })),
    },
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
