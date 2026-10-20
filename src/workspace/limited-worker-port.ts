import type { HumanPrincipalV1 } from '../identity/canonical.js';

export class LimitedWorkerRequestError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}
export interface LimitedWorkerPort {
  read(projectId: string, human: HumanPrincipalV1): unknown;
  prepare(projectId: string, input: unknown, human: HumanPrincipalV1): Promise<unknown>;
  action(projectId: string, id: string, input: unknown, human: HumanPrincipalV1): unknown;
}
