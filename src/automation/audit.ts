import type { AuditEntry, ControllerRun } from './types.js';
import { assertFreshRun, assertTransition } from './lifecycle.js';

export interface ControllerStore {
  create(run: ControllerRun): void;
  get(runId: string): ControllerRun | undefined;
  replace(run: ControllerRun): void;
  bindController(): (run: ControllerRun) => void;
  entries(runId: string): AuditEntry[];
}

// Only a controller that bound this store may append repository-authority actions.
// Direct store writes remain useful for testing the lifecycle but cannot impersonate
// a repository observation or clear a human-resume recheck flag.
const CONTROLLER_ONLY = new Set(['RECORD_REMOTE_SHA', 'BEGIN_REMOTE_ACCEPTANCE', 'ACCEPT_EXACT_SHA',
  'REJECT_EXACT_SHA', 'AUTHORIZE_PROMOTION', 'MARK_PROMOTING', 'RECORD_PROMOTED_MAIN',
  'RECOVER_PROMOTED_MAIN', 'CLOSE_VERIFIED_RUN', 'RECOVER_CLOSE', 'RECONCILE_PENDING', 'RECHECK_EXTERNAL_REALITY']);
export function requiresControllerWriter(action: unknown): boolean { return typeof action === 'string' && CONTROLLER_ONLY.has(action); }

// The store is a public write path of its own, so it enforces the same lifecycle as
// the controller rather than trusting its caller. Input is cloned first and only the
// clone is validated and kept: a getter or later mutation cannot change what was checked.
// Runs live in a true private field; a TypeScript `private` is still writable at runtime.
export class InMemoryControllerStore implements ControllerStore {
  readonly #runs = new Map<string, ControllerRun>();
  #bound = false;

  constructor() {
    Object.freeze(this);
  }
  create(input: ControllerRun): void {
    const run = structuredClone(input);
    if (this.#runs.has(run.runId)) throw new Error('Duplicate runId');
    assertFreshRun(run);
    this.#runs.set(run.runId, run);
  }
  get(runId: string): ControllerRun | undefined {
    const run = this.#runs.get(runId);
    return run ? structuredClone(run) : undefined;
  }
  replace(input: ControllerRun): void {
    this.#replace(input, false);
  }
  bindController(): (run: ControllerRun) => void {
    if (this.#bound) throw new Error('Controller store already bound');
    this.#bound = true;
    return (run) => this.#replace(run, true);
  }
  #replace(input: ControllerRun, privileged: boolean): void {
    const run = structuredClone(input);
    if (!privileged && requiresControllerWriter(run.audit.at(-1)?.action)) throw new Error('Controller writer required');
    const current = this.#runs.get(run.runId);
    if (!current) throw new Error('Unknown runId');
    assertTransition(current, run);
    this.#runs.set(run.runId, run);
  }
  entries(runId: string): AuditEntry[] {
    const run = this.get(runId);
    if (!run) throw new Error('Unknown runId');
    return structuredClone(run.audit);
  }
}
Object.freeze(InMemoryControllerStore);
Object.freeze(InMemoryControllerStore.prototype);
