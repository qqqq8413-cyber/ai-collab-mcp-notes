import type { AuditEntry, ControllerRun } from './types.js';
import { packetHash } from './packet.js';

export interface ControllerStore {
  create(run: ControllerRun): void;
  get(runId: string): ControllerRun | undefined;
  replace(run: ControllerRun): void;
  entries(runId: string): AuditEntry[];
}

export class InMemoryControllerStore implements ControllerStore {
  private readonly runs = new Map<string, ControllerRun>();

  create(run: ControllerRun): void {
    if (this.runs.has(run.runId)) throw new Error('Duplicate runId');
    this.runs.set(run.runId, structuredClone(run));
  }
  get(runId: string): ControllerRun | undefined {
    const run = this.runs.get(runId);
    return run ? structuredClone(run) : undefined;
  }
  replace(run: ControllerRun): void {
    const current = this.runs.get(run.runId);
    if (!current) throw new Error('Unknown runId');
    if (run.runId !== current.runId || run.sliceId !== current.sliceId || run.repository !== current.repository ||
        run.implementationIterations < current.implementationIterations ||
        run.acceptanceFailures < current.acceptanceFailures ||
        (current.activePacketHash && current.state !== 'ARCHITECTURE' &&
          run.activePacketHash !== current.activePacketHash) ||
        (run.activePacket && packetHash(run.activePacket) !== run.activePacketHash)) {
      throw new Error('Controller identity, counters, or packet integrity violation');
    }
    if (run.audit.length !== current.audit.length + 1 ||
        run.audit[run.audit.length - 1]?.sequence !== current.audit.length + 1 ||
        current.audit.some((entry, index) => JSON.stringify(entry) !== JSON.stringify(run.audit[index]))) {
      throw new Error('Audit must be append-only with monotonic sequence');
    }
    this.runs.set(run.runId, structuredClone(run));
  }
  entries(runId: string): AuditEntry[] {
    const run = this.get(runId);
    if (!run) throw new Error('Unknown runId');
    return structuredClone(run.audit);
  }
}
