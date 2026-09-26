import type { AuditEntry, ControllerRun } from './types.js';
import { assertFreshRun, assertTransition } from './lifecycle.js';

export interface ControllerStore {
  create(run: ControllerRun): void;
  get(runId: string): ControllerRun | undefined;
  replace(run: ControllerRun): void;
  entries(runId: string): AuditEntry[];
}

// The store is a public write path of its own, so it enforces the same lifecycle as
// the controller rather than trusting its caller. Input is cloned first and only the
// clone is validated and kept: a getter or later mutation cannot change what was checked.
export class InMemoryControllerStore implements ControllerStore {
  private readonly runs = new Map<string, ControllerRun>();

  create(input: ControllerRun): void {
    const run = structuredClone(input);
    if (this.runs.has(run.runId)) throw new Error('Duplicate runId');
    assertFreshRun(run);
    this.runs.set(run.runId, run);
  }
  get(runId: string): ControllerRun | undefined {
    const run = this.runs.get(runId);
    return run ? structuredClone(run) : undefined;
  }
  replace(input: ControllerRun): void {
    const run = structuredClone(input);
    const current = this.runs.get(run.runId);
    if (!current) throw new Error('Unknown runId');
    assertTransition(current, run);
    this.runs.set(run.runId, run);
  }
  entries(runId: string): AuditEntry[] {
    const run = this.get(runId);
    if (!run) throw new Error('Unknown runId');
    return structuredClone(run.audit);
  }
}
