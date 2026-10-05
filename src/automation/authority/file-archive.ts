import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { canonicalJson } from '../invocation-journal.js';
import {
  AuthorityArchiveError, authorityKeyOf, authorityRefOf, openAuthorityRecord, parseAuthorityDocument, parseAuthorityRef,
  sealAuthorityRecord, type AuthorityDocumentV1, type AuthorityKindV1, type AuthorityRecordV1, type AuthorityRefV1,
} from './document.js';

// The local AUTHORITY_ARCHIVE (G1-R4P-1): durable and append-only.
//
//   <root>/records/<SHA256("chief.authority.v1\0" + kind + "\0" + authorityId)>/00000001.json, 00000002.json, ...
//
// A record is published like an R4L claim: the complete sealed record is written to a
// temp name, fsynced, published with one exclusive link(2) (EEXIST if the version
// exists), and the directory is fsynced. Nothing is ever renamed over, rewritten or
// deleted; temp names are never read as authority. When link publication is
// unavailable, the append fails closed: there is no weaker fallback.
//
// The root is the archive's own and separately configured: it holds `records/` and
// nothing else, so it cannot be shared with a controller run store, R4L admission or a
// Workspace goal store. An existing root is inspected before anything is created, so a
// root that is not an archive is refused untouched. The root, records/, key directories
// and canonical record files must be real directories and regular files: symlinks are
// never followed into another store. That is storage separation, not protection: a
// process that can write this directory can write anything (R4T governs writable
// capabilities), and the hashes are still not authenticity.
//
// Reading and writing are separate capabilities. A reader exposes only get /
// listVersions / latest; an appender exposes only append. Neither can update, replace,
// delete, truncate, rewrite, move "latest", or import an operational record.

/** Read capability. Exposes no mutation. */
export interface AuthorityArchiveReader {
  get(ref: AuthorityRefV1): AuthorityRecordV1 | undefined;
  listVersions(kind: AuthorityKindV1, authorityId: string): readonly AuthorityRefV1[];
  latest(kind: AuthorityKindV1, authorityId: string): AuthorityRecordV1 | undefined;
}
/** Append capability. Appending the identical record again returns the same reference. */
export interface AuthorityArchiveAppender {
  append(document: AuthorityDocumentV1): AuthorityRefV1;
}

const KEY_DIRECTORY = /^[0-9a-f]{64}$/;
const RECORD_FILE = /^[0-9]{8,16}\.json$/;
const TEMP_FILE = /^[0-9]{8,16}\.[0-9a-f-]{36}\.tmp$/;
const fileOf = (version: number) => `${String(version).padStart(8, '0')}.json`;
const integrity = (message: string) => new AuthorityArchiveError('ARCHIVE_INTEGRITY', message);
// Dot entries (for example a file manager's .DS_Store) are neither authority nor errors.
const ignored = (name: string) => name.startsWith('.');
/** The entry itself, never a symlink's target; undefined when absent. */
function entry(path: string): Stats | undefined {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
const createdOrPresent = (create: () => void) => {
  try { create(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
};
/** A canonical record file's text, only if it is a regular file reached without a symlink. */
function readRecord(path: string): string {
  const notRegular = () => integrity('A canonical authority record is not a regular file (symlinks are not followed)');
  if (!entry(path)?.isFile()) throw notRegular();
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw notRegular();
    throw error;
  }
  try {
    if (!fstatSync(fd).isFile()) throw notRegular();
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}

class FileAuthorityArchive {
  readonly #root: string;
  readonly #records: string;

  constructor(root: string, create: boolean) {
    if (typeof root !== 'string' || !root.trim()) throw new Error('Authority archive root required');
    this.#root = resolve(root);
    this.#records = join(this.#root, 'records');
    // Inspect first, create second: an existing root that is not an archive is refused
    // before the archive changes anything in it.
    let present = this.#inspect();
    if (create && !present.records) {
      if (!present.root) {
        mkdirSync(dirname(this.#root), { recursive: true, mode: 0o700 });
        createdOrPresent(() => mkdirSync(this.#root, { mode: 0o700 }));
        present = this.#inspect();
      }
      if (!present.records) {
        createdOrPresent(() => mkdirSync(this.#records, { mode: 0o700 }));
        this.#sync(this.#root);
      }
    }
    this.#verify();
    Object.freeze(this);
  }
  #sync(directory: string): void {
    const fd = openSync(directory, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  /** Read-only: whether the root and records/ exist, refusing anything that is not an archive. */
  #inspect(): { root: boolean; records: boolean } {
    const root = entry(this.#root);
    if (!root) return { root: false, records: false };
    if (!root.isDirectory()) throw integrity('The authority archive root is not a directory (symlinks are not followed)');
    for (const name of readdirSync(this.#root)) {
      if (!ignored(name) && name !== 'records') throw integrity('The authority archive root holds something other than records');
    }
    const records = entry(this.#records);
    if (records && !records.isDirectory()) throw integrity('records is not a directory (symlinks are not followed)');
    return { root: true, records: Boolean(records) };
  }
  // Opening replays every chain. Any contradiction fails closed; nothing is repaired.
  #verify(): void {
    if (!this.#inspect().records) return;
    for (const name of readdirSync(this.#records)) {
      if (ignored(name)) continue;
      if (!KEY_DIRECTORY.test(name) || !lstatSync(join(this.#records, name)).isDirectory()) {
        throw integrity('Unexpected entry among authority records');
      }
      this.#chain(name);
    }
  }
  /** The validated chain of one logical key: versions 1..n, each superseding the one before. */
  #chain(key: string): AuthorityRecordV1[] {
    const directory = join(this.#records, key);
    const status = entry(directory);
    if (!status) return [];
    if (!status.isDirectory()) throw integrity('An authority key entry is not a directory (symlinks are not followed)');
    const chain: AuthorityRecordV1[] = [];
    for (const name of readdirSync(directory)) {
      if (ignored(name) || TEMP_FILE.test(name)) continue;
      if (!RECORD_FILE.test(name)) throw integrity('Unexpected entry in an authority chain');
      const record = openAuthorityRecord(readRecord(join(directory, name)));
      if (authorityKeyOf(record.kind, record.authorityId) !== key) throw integrity('Authority record is in the wrong logical directory');
      if (fileOf(record.version) !== name) throw integrity('Authority record is filed under the wrong version');
      chain.push(record);
    }
    chain.sort((a, b) => a.version - b.version);
    chain.forEach((record, index) => {
      if (record.version !== index + 1) throw integrity('Authority chain has a version gap');
      const expected = index === 0 ? null : authorityRefOf(chain[index - 1]);
      if (canonicalJson(record.supersedes) !== canonicalJson(expected)) throw integrity('Authority chain has an invalid supersession');
    });
    return chain;
  }
  get(input: AuthorityRefV1): AuthorityRecordV1 | undefined {
    const ref = parseAuthorityRef(input);
    const record = this.#chain(authorityKeyOf(ref.kind, ref.authorityId))[ref.version - 1];
    if (!record) return undefined;
    if (record.recordHash !== ref.recordHash) {
      throw new AuthorityArchiveError('REF_MISMATCH', 'The archived record at this version is not the referenced record');
    }
    return structuredClone(record);
  }
  listVersions(kind: AuthorityKindV1, authorityId: string): readonly AuthorityRefV1[] {
    return Object.freeze(this.#chain(authorityKeyOf(kind, authorityId)).map(authorityRefOf));
  }
  latest(kind: AuthorityKindV1, authorityId: string): AuthorityRecordV1 | undefined {
    const record = this.#chain(authorityKeyOf(kind, authorityId)).at(-1);
    return record ? structuredClone(record) : undefined;
  }
  append(input: AuthorityDocumentV1): AuthorityRefV1 {
    const document = parseAuthorityDocument(input);
    const record = sealAuthorityRecord(document);
    const text = canonicalJson(record);
    const key = authorityKeyOf(record.kind, record.authorityId);
    const directory = join(this.#records, key);
    if (!entry(directory)) {
      createdOrPresent(() => mkdirSync(directory, { mode: 0o700 }));
      this.#sync(this.#records);
    }
    const chain = this.#chain(key);
    const existing = chain[record.version - 1];
    if (existing) {
      if (canonicalJson(existing) === text) return authorityRefOf(existing);
      throw new AuthorityArchiveError('VERSION_CONFLICT', 'This version is already archived with different content');
    }
    if (record.version !== chain.length + 1) throw new AuthorityArchiveError('VERSION_GAP', 'Versions are appended without gaps');
    const expected = chain.length ? authorityRefOf(chain[chain.length - 1]) : null;
    if (canonicalJson(record.supersedes) !== canonicalJson(expected)) {
      throw new AuthorityArchiveError('INVALID_SUPERSESSION', 'The document does not supersede the archived previous version');
    }
    if (this.#publish(directory, record.version, text)) return authorityRefOf(record);
    // EEXIST: a concurrent writer published this version first. Its record decides.
    const winner = this.#chain(key)[record.version - 1];
    if (winner && canonicalJson(winner) === text) return authorityRefOf(winner);
    throw new AuthorityArchiveError('VERSION_CONFLICT', 'This version is already archived with different content');
  }
  // Write temp, fsync, publish with one exclusive link(2), fsync the directory, remove the
  // temp name. Returns false on EEXIST; never overwrites.
  #publish(directory: string, version: number, text: string): boolean {
    const target = join(directory, fileOf(version));
    const temp = join(directory, `${fileOf(version).slice(0, -'.json'.length)}.${randomUUID()}.tmp`);
    const fd = openSync(temp, 'wx', 0o600);
    try {
      try {
        writeFileSync(fd, text);
        fsyncSync(fd);
      } finally { closeSync(fd); }
      try { linkSync(temp, target); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') return false;
        throw new AuthorityArchiveError('PUBLICATION_UNAVAILABLE',
          `Exclusive authority publication is unavailable (${code ?? 'unknown error'}); no fallback is attempted`);
      }
      this.#sync(directory);
      return true;
    } finally {
      // Temp names are never authority; one left behind by a crash is harmless.
      try { unlinkSync(temp); } catch { /* best effort */ }
    }
  }
}
Object.freeze(FileAuthorityArchive);
Object.freeze(FileAuthorityArchive.prototype);

/** Opens the archive for reading only. A missing archive reads as empty; nothing is created. */
export function openAuthorityArchiveReader(root: string): AuthorityArchiveReader {
  const archive = new FileAuthorityArchive(root, false);
  return Object.freeze({
    get: (ref: AuthorityRefV1) => archive.get(ref),
    listVersions: (kind: AuthorityKindV1, authorityId: string) => archive.listVersions(kind, authorityId),
    latest: (kind: AuthorityKindV1, authorityId: string) => archive.latest(kind, authorityId),
  });
}
/** Opens the archive for appending only, creating its root if needed. */
export function openAuthorityArchiveAppender(root: string): AuthorityArchiveAppender {
  const archive = new FileAuthorityArchive(root, true);
  return Object.freeze({ append: (document: AuthorityDocumentV1) => archive.append(document) });
}
