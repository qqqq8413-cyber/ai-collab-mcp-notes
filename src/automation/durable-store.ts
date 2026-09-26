import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync,
  unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertFreshRun, assertRunInvariants, assertTransition } from './lifecycle.js';
import { requiresControllerWriter, type ControllerStore } from './audit.js';
import type { AuditEntry, ControllerRun } from './types.js';

const VERSION = 1;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export class FileControllerStore implements ControllerStore {
  readonly #directory: string;
  #bound = false;

  constructor(directory: string) {
    if (typeof directory !== 'string' || !directory.trim()) throw new Error('Storage directory required');
    this.#directory = resolve(directory);
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    Object.freeze(this);
  }
  #file(runId: string): string {
    if (typeof runId !== 'string' || !runId.trim()) throw new Error('Invalid runId');
    return join(this.#directory, `${digest(runId)}.json`);
  }
  #load(runId: string): ControllerRun | undefined {
    const file = this.#file(runId);
    if (!existsSync(file)) return undefined;
    let envelope: unknown;
    try { envelope = JSON.parse(readFileSync(file, 'utf8')); }
    catch { throw new Error('Corrupt controller storage JSON'); }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
        Object.keys(envelope).sort().join(',') !== 'checksum,run,schemaVersion') {
      throw new Error('Invalid controller storage envelope');
    }
    const stored = envelope as { schemaVersion: unknown; checksum: unknown; run: unknown };
    if (stored.schemaVersion !== VERSION) throw new Error('Unsupported controller storage schema version');
    if (typeof stored.checksum !== 'string' || stored.checksum !== digest(JSON.stringify(stored.run))) {
      throw new Error('Controller storage checksum mismatch');
    }
    if (!stored.run || typeof stored.run !== 'object' || (stored.run as ControllerRun).runId !== runId) {
      throw new Error('Controller storage identity mismatch');
    }
    assertRunInvariants(stored.run as ControllerRun);
    return stored.run as ControllerRun;
  }
  #locked(runId: string, action: () => void): void {
    const lock = `${this.#file(runId)}.lock`;
    // A leftover lock is an uncertain writer. Never remove one we did not create.
    const fd = openSync(lock, 'wx', 0o600);
    const identity = fstatSync(fd);
    try { action(); }
    finally {
      closeSync(fd);
      const current = lstatSync(lock);
      if (current.dev !== identity.dev || current.ino !== identity.ino) throw new Error('Controller lock ownership changed');
      unlinkSync(lock);
    }
  }
  #write(runId: string, run: ControllerRun): void {
    const target = this.#file(runId);
    const temp = `${target}.${randomUUID()}.tmp`;
    const payload = JSON.stringify(run);
    const serialized = JSON.stringify({ schemaVersion: VERSION, run: JSON.parse(payload), checksum: digest(payload) });
    const fd = openSync(temp, 'wx', 0o600);
    try {
      writeFileSync(fd, serialized);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    try {
      renameSync(temp, target);
      const directoryFd = openSync(this.#directory, 'r');
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    } catch (error) {
      if (existsSync(temp)) unlinkSync(temp);
      throw error;
    }
  }
  create(input: ControllerRun): void {
    const run = structuredClone(input);
    assertFreshRun(run);
    this.#locked(run.runId, () => {
      if (this.#load(run.runId)) throw new Error('Duplicate runId');
      this.#write(run.runId, run);
    });
  }
  get(runId: string): ControllerRun | undefined {
    const run = this.#load(runId);
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
    this.#locked(run.runId, () => {
      const current = this.#load(run.runId);
      if (!current) throw new Error('Unknown runId');
      assertTransition(current, run);
      this.#write(run.runId, run);
    });
  }
  entries(runId: string): AuditEntry[] {
    const run = this.get(runId);
    if (!run) throw new Error('Unknown runId');
    return structuredClone(run.audit);
  }
}
Object.freeze(FileControllerStore);
Object.freeze(FileControllerStore.prototype);
