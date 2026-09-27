import type { ProviderName } from '../config.js';
import type { BoundaryResult } from '../execution/boundary.js';
import type { RequestedParameters } from '../execution/types.js';
import type { RouteInputRef } from '../stress-test/deliberation.js';

export type ConsultationKind = 'ADD_REVIEWER' | 'REPLICATE';

/** Caller intent only. Product and execution identities are not caller fields. */
export interface ConsultationRequest {
  attemptId: string;
  consultantRoleId: string;
  provider: ProviderName;
  requestedModel?: string;
  input: string;
  systemInstruction?: string;
  parameters: RequestedParameters;
}

/** A detached view of one current domain route, never authority to execute. */
export interface ConsultationRouteBinding {
  deliberationStateId: string;
  sessionId: string;
  artifactHash: string;
  authorContextHash: string;
  attemptId: string;
  decisionId: string;
  questionId: string;
  route: ConsultationKind;
  inputRefs: RouteInputRef[];
}

export interface ConsultationRouteBindingPort {
  resolve(attemptId: string): ConsultationRouteBinding;
}

/** Execution provenance only; never a RouteOutcome or reviewer judgment. */
export interface ConsultationRecord {
  consultationId: string;
  executionId: string;
  consultationKind: ConsultationKind;
  consultantRoleId: string;
  routeBinding: ConsultationRouteBinding;
  requestedProvider: ProviderName;
  requestedModel?: string;
  consultationInputFingerprint: string;
  /** No dedicated peer-output field exists; arbitrary input text may still contain copied peer material. */
  structuredPeerContext: 'NONE';
  provenanceStatus: 'STABLE' | 'PROVENANCE_UNCERTAIN';
  /** Preserves R4's non-executed and SUCCESS / KNOWN_FAILURE / UNCERTAIN facts verbatim. */
  boundaryResult: BoundaryResult;
}
