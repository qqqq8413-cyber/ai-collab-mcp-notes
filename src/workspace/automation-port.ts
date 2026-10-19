// Operational observations only. No Controller, model or authority capability crosses this port.
export class AutomationRequestError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}

export interface AutomationPort {
  read(projectId: string): unknown;
  create(projectId: string, input: unknown): unknown;
  action(projectId: string, taskId: string, input: unknown): unknown;
}
