import type { HumanPrincipalV1 } from '../identity/canonical.js';

export class AiPilotRequestError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}

// Preparation is operational input. This port contains no grant/archive writer or execution capability.
export interface AiPilotPort {
  list(projectId: string, principal: HumanPrincipalV1): unknown;
  create(projectId: string, input: unknown, principal: HumanPrincipalV1): unknown;
  action(projectId: string, planId: string, input: unknown, principal: HumanPrincipalV1): Promise<unknown>;
}
