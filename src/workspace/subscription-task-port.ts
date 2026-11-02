import type { HumanPrincipalV1 } from '../identity/canonical.js';

// M2-0: the Human adds, reads and cancels tasks for the Human's own Claude Code. This port only reaches the local
// task queue; it holds no model, credential, Authority, Controller or governed execution capability.
export class SubscriptionTaskRequestError extends Error {
  constructor(readonly code: string, readonly status: number, message: string = code) { super(message); }
}
export interface SubscriptionTaskPort {
  read(projectId: string, human: HumanPrincipalV1): unknown;
  create(projectId: string, input: unknown, human: HumanPrincipalV1): unknown;
  action(projectId: string, taskId: string, input: unknown, human: HumanPrincipalV1): unknown;
}
