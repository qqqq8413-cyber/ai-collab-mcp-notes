import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { SYSTEM_CLOCK } from './time.js';
import type { Clock } from './types.js';
import { ChangeMintError, changeMintRecordOf, objectiveHashOf, parseChangeMintRecord, parseChangeMintRequest,
  sourceKeyOf, type ChangeMintRecordV1, type ChangeMintRequestV1, type ChangeSourceIdentityV1 } from './change-mint.js';

const RECORD_FILE = /^([0-9a-f]{64})\.json$/;
const TEMP_FILE = /^[0-9a-f]{64}\.[0-9a-f-]{36}\.tmp$/;
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const integrity = (message: string) => new ChangeMintError('REGISTRY_INTEGRITY', message);

export interface ChangeRegistryReader {
  getBySource(source: ChangeSourceIdentityV1): ChangeMintRecordV1 | undefined;
}
export interface ChangeMinter {
  mint(request: ChangeMintRequestV1): ChangeMintRecordV1;
}

function entry(path: string) {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
function createdOrPresent(create: () => void): void {
  try { create(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
}
function sync(directory: string): void {
  const fd = openSync(directory, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

class FileChangeRegistry {
  readonly #root: string;
  readonly #records: string;
  readonly #clock: Clock;

  constructor(root: string, create: boolean, clock: Clock) {
    if (typeof root !== 'string' || !isAbsolute(root) || normalize(root) !== root ||
        (root.length > 1 && root.endsWith('/')) || /[\u0000-\u001f]/.test(root)) {
      throw integrity('Change Registry root must be an absolute, normalised path');
    }
    this.#root = root;
    this.#records = join(root, 'records');
    this.#clock = clock;
    let present = this.#inspect();
    if (create && !present.records) {
      if (!present.root) {
        mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
        createdOrPresent(() => mkdirSync(root, { mode: 0o700 }));
        present = this.#inspect();
      }
      if (!present.records) {
        createdOrPresent(() => mkdirSync(this.#records, { mode: 0o700 }));
        this.#inspect();
        sync(this.#root);
      }
    }
    this.#verify();
    Object.freeze(this);
  }

  #inspect(): { root: boolean; records: boolean } {
    const root = entry(this.#root);
    if (!root) return { root: false, records: false };
    if (!root.isDirectory()) throw integrity('Change Registry root is not a real directory');
    if ((root.mode & 0o022) !== 0 || (typeof process.getuid === 'function' && root.uid !== process.getuid())) {
      throw integrity('Change Registry root has unsafe ownership or permissions');
    }
    for (const name of readdirSync(this.#root)) if (name !== 'records') throw integrity('Change Registry root contains foreign data');
    const records = entry(this.#records);
    if (records && (!records.isDirectory() || (records.mode & 0o022) !== 0)) {
      throw integrity('Change Registry records is not a protected real directory');
    }
    return { root: true, records: Boolean(records) };
  }

  #read(key: string): ChangeMintRecordV1 | undefined {
    const file = join(this.#records, `${key}.json`);
    const before = entry(file);
    if (!before) return undefined;
    if (!before.isFile()) throw integrity('Canonical Change Mint record is not a regular file');
    let fd: number;
    try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch { throw integrity('Canonical Change Mint record cannot be opened without following a symlink'); }
    let text: string;
    try {
      const current = fstatSync(fd);
      if (!current.isFile() || current.dev !== before.dev || current.ino !== before.ino) {
        throw integrity('Canonical Change Mint record changed during read');
      }
      text = readFileSync(fd, 'utf8');
    } finally { closeSync(fd); }
    let envelope: unknown;
    try { envelope = JSON.parse(text); } catch { throw integrity('Canonical Change Mint record is not JSON'); }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
        Object.keys(envelope).sort().join(',') !== 'checksum,record') throw integrity('Invalid Change Mint envelope');
    const stored = envelope as { checksum: unknown; record: unknown };
    if (typeof stored.checksum !== 'string' || stored.checksum !== sha256(JSON.stringify(stored.record))) {
      throw integrity('Change Mint checksum mismatch');
    }
    const record = parseChangeMintRecord(stored.record);
    if (record.sourceKey !== key) throw integrity('Change Mint record is filed under another source');
    return record;
  }

  #verify(): void {
    if (!this.#inspect().records) return;
    for (const name of readdirSync(this.#records)) {
      if (TEMP_FILE.test(name)) continue;
      const match = RECORD_FILE.exec(name);
      if (!match) throw integrity('Unexpected entry among Change Mint records');
      this.#read(match[1]);
    }
  }

  getBySource(source: ChangeSourceIdentityV1): ChangeMintRecordV1 | undefined {
    const key = sourceKeyOf(source);
    this.#verify();
    const record = this.#read(key);
    return record ? structuredClone(record) : undefined;
  }

  mint(input: ChangeMintRequestV1): ChangeMintRecordV1 {
    const request = parseChangeMintRequest(input);
    const key = sourceKeyOf({ kind: request.source.kind, projectId: request.source.projectId, goalId: request.source.goalId });
    this.#verify();
    const existing = this.#read(key);
    if (existing) return this.#sameBinding(existing, request);
    const record = changeMintRecordOf(request, this.#clock.now());
    const payload = JSON.stringify(record);
    const text = JSON.stringify({ checksum: sha256(payload), record: JSON.parse(payload) });
    const target = join(this.#records, `${key}.json`);
    const temp = join(this.#records, `${key}.${randomUUID()}.tmp`);
    const fd = openSync(temp, 'wx', 0o600);
    try {
      try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
      try { linkSync(temp, target); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') throw new ChangeMintError('PUBLICATION_UNAVAILABLE',
          `Exclusive Change Mint publication is unavailable (${code ?? 'unknown error'}); no fallback`);
        const winner = this.#read(key);
        if (!winner) throw integrity('A competing Change Mint publication is missing');
        return this.#sameBinding(winner, request);
      }
      sync(this.#records);
      return structuredClone(record);
    } finally {
      try { unlinkSync(temp); } catch { /* a temp name is never a canonical mint */ }
    }
  }

  #sameBinding(record: ChangeMintRecordV1, request: ChangeMintRequestV1): ChangeMintRecordV1 {
    const source = request.source;
    if (record.repository !== request.repository || record.source.kind !== source.kind ||
        record.source.projectId !== source.projectId || record.source.goalId !== source.goalId ||
        record.source.createdAt !== source.createdAt || record.source.submittedBy.schemaVersion !== source.submittedBy.schemaVersion ||
        record.source.submittedBy.kind !== source.submittedBy.kind ||
        record.source.submittedBy.principalRef !== source.submittedBy.principalRef ||
        record.source.objectiveHash !== objectiveHashOf(source.objective)) {
      throw new ChangeMintError('CHANGE_SOURCE_BINDING_CONFLICT', 'This Workspace Goal already has a different governed Change binding');
    }
    return structuredClone(record);
  }
}
Object.freeze(FileChangeRegistry);
Object.freeze(FileChangeRegistry.prototype);

/** Pure read capability. A missing registry reads as empty and is not created. */
export function openChangeRegistryReader(root: string): ChangeRegistryReader {
  const registry = new FileChangeRegistry(root, false, SYSTEM_CLOCK);
  return Object.freeze({ getBySource: (source: ChangeSourceIdentityV1) => registry.getBySource(source) });
}

/** Protected write capability. No production runtime composes or receives it in CM1. */
export function openChangeMinter(root: string, clock: Clock = SYSTEM_CLOCK): ChangeMinter {
  const registry = new FileChangeRegistry(root, true, clock);
  return Object.freeze({ mint: (request: ChangeMintRequestV1) => registry.mint(request) });
}
