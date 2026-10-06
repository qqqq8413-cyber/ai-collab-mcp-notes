import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, type BigIntStats } from 'node:fs';
import { join } from 'node:path';

// Read-only snapshot of the two governance roots for the governed read model (G1-R4A0).
//
// Nothing here creates, opens for writing, locks, renames, links, unlinks, chmods or
// repairs anything: the only filesystem calls are lstat, readdir, and open(O_RDONLY |
// O_NOFOLLOW) + fstat + read + close. A missing root reads as empty and stays missing.
//
// Consistency: the read model takes one snapshot before it projects and one after, and
// fails closed unless they are identical. Each relevant entry is fingerprinted by
// device, inode, size, mtime, ctime (nanoseconds) and the SHA-256 of its bytes. The
// stores publish by rename or link (a new inode) and never write a published file in
// place, and ctime cannot be set back by a writer, so two equal snapshots mean no
// relevant entry changed between them: the projection describes one instant.

export type SourceKind = 'CONTROLLER_STORE' | 'AUTHORITY_ARCHIVE';

export class GovernedReadError extends Error {
  readonly code: 'INVALID_ROOTS' | 'SOURCE_INTEGRITY' | 'CONTROLLER_RUN_INVALID' | 'AUTHORITY_ARCHIVE_INVALID' | 'SNAPSHOT_INCONSISTENT';
  constructor(code: GovernedReadError['code'], message: string) {
    super(message);
    this.name = 'GovernedReadError';
    this.code = code;
  }
}

interface Fingerprint { source: SourceKind; path: string; type: 'dir' | 'file'; identity: string; sha256: string | null }
export interface SourceSnapshot {
  /** Canonical description of every relevant entry; equal strings mean an unchanged source. */
  readonly signature: string;
  /** Content address of the snapshot: entry paths and byte hashes only, no inode data. */
  readonly id: string;
  readonly present: Readonly<Record<SourceKind, boolean>>;
  /** Controller store run files, by file name. */
  readonly runFiles: ReadonlyMap<string, string>;
  /** Controller store admission claims, by change key (the file name without .json). */
  readonly claimFiles: ReadonlyMap<string, string>;
  /** Authority archive record files, by path under the archive root. */
  readonly authorityFiles: ReadonlyMap<string, string>;
}

const RUN_FILE = /^[0-9a-f]{64}\.json$/;
const CLAIM_FILE = RUN_FILE;
const AUTHORITY_KEY = /^[0-9a-f]{64}$/;
const AUTHORITY_TEMP = /^[0-9]{8,16}\.[0-9a-f-]{36}\.tmp$/;
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const integrity = (message: string) => new GovernedReadError('SOURCE_INTEGRITY', message);

function lstat(path: string): BigIntStats | undefined {
  try { return lstatSync(path, { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw integrity(`Cannot inspect a governance entry (${(error as NodeJS.ErrnoException).code ?? 'unknown error'})`);
  }
}
const identityOf = (status: BigIntStats, withTimes: boolean) => withTimes
  ? `${status.dev}:${status.ino}:${status.size}:${status.mtimeNs}:${status.ctimeNs}`
  : `${status.dev}:${status.ino}`;

/** A real directory reached without a symlink, or undefined when absent. */
function directory(path: string, what: string): BigIntStats | undefined {
  const status = lstat(path);
  if (status && !status.isDirectory()) throw integrity(`${what} is not a directory (symlinks are not followed)`);
  return status;
}
function list(path: string): string[] {
  try { return readdirSync(path).sort(); }
  catch (error) { throw integrity(`Cannot list a governance directory (${(error as NodeJS.ErrnoException).code ?? 'unknown error'})`); }
}
/** The bytes of a regular file opened without following a symlink, with its identity. */
function readRegular(path: string): { text: string; status: BigIntStats } {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new GovernedReadError('SNAPSHOT_INCONSISTENT', 'A governance record disappeared during the read');
    throw integrity(code === 'ELOOP' ? 'A governance record is a symlink' : `Cannot open a governance record (${code ?? 'unknown error'})`);
  }
  try {
    const status = fstatSync(fd, { bigint: true });
    if (!status.isFile()) throw integrity('A governance record is not a regular file');
    return { text: readFileSync(fd, 'utf8'), status };
  } finally { closeSync(fd); }
}

function scanController(root: string, entries: Fingerprint[], runs: Map<string, string>, claims: Map<string, string>): boolean {
  const rootStatus = directory(root, 'The Controller store root');
  if (!rootStatus) return false;
  entries.push({ source: 'CONTROLLER_STORE', path: '.', type: 'dir', identity: identityOf(rootStatus, false), sha256: null });
  // Exactly the names FileControllerStore reads: run files and canonical claims. Locks,
  // temps and refusal evidence are not part of what a run or an admission is.
  for (const name of list(root)) {
    if (!RUN_FILE.test(name)) continue;
    const { text, status } = readRegular(join(root, name));
    runs.set(name, text);
    entries.push({ source: 'CONTROLLER_STORE', path: name, type: 'file', identity: identityOf(status, true), sha256: sha256(text) });
  }
  const changes = join(root, 'changes');
  const changesStatus = directory(changes, 'The Controller store changes directory');
  if (changesStatus) {
    entries.push({ source: 'CONTROLLER_STORE', path: 'changes', type: 'dir', identity: identityOf(changesStatus, false), sha256: null });
    for (const name of list(changes)) {
      if (!CLAIM_FILE.test(name)) continue;
      const { text, status } = readRegular(join(changes, name));
      claims.set(name.slice(0, -'.json'.length), text);
      entries.push({ source: 'CONTROLLER_STORE', path: `changes/${name}`, type: 'file', identity: identityOf(status, true), sha256: sha256(text) });
    }
  }
  return true;
}

function scanArchive(root: string, entries: Fingerprint[], records: Map<string, string>): boolean {
  const rootStatus = directory(root, 'The authority archive root');
  if (!rootStatus) return false;
  entries.push({ source: 'AUTHORITY_ARCHIVE', path: '.', type: 'dir', identity: identityOf(rootStatus, false), sha256: null });
  // Every entry the archive itself would consider (it ignores dot entries and temp
  // names): an unexpected entry appearing between the snapshots also changes them.
  const walk = (relative: string, depth: number): void => {
    const path = relative === '.' ? root : join(root, relative);
    for (const name of list(path)) {
      if (name.startsWith('.') || (depth === 2 && AUTHORITY_TEMP.test(name))) continue;
      const child = relative === '.' ? name : `${relative}/${name}`;
      const status = lstat(join(root, child));
      if (!status) throw new GovernedReadError('SNAPSHOT_INCONSISTENT', 'An authority archive entry disappeared during the read');
      if (status.isDirectory() && depth < 2 && (depth === 0 ? name === 'records' : AUTHORITY_KEY.test(name))) {
        entries.push({ source: 'AUTHORITY_ARCHIVE', path: child, type: 'dir', identity: identityOf(status, false), sha256: null });
        walk(child, depth + 1);
      } else if (status.isFile() && depth === 2) {
        const { text, status: opened } = readRegular(join(root, child));
        records.set(child, text);
        entries.push({ source: 'AUTHORITY_ARCHIVE', path: child, type: 'file', identity: identityOf(opened, true), sha256: sha256(text) });
      } else {
        // Not an archive shape; the archive reader refuses it. Recorded so it is stable.
        entries.push({ source: 'AUTHORITY_ARCHIVE', path: child, type: 'file', identity: identityOf(status, true), sha256: null });
      }
    }
  };
  walk('.', 0);
  return true;
}

/** One read-only pass over both roots. */
export function takeSourceSnapshot(controllerStoreDirectory: string, authorityArchiveDirectory: string): SourceSnapshot {
  const entries: Fingerprint[] = [];
  const runFiles = new Map<string, string>(), claimFiles = new Map<string, string>(), authorityFiles = new Map<string, string>();
  const controller = scanController(controllerStoreDirectory, entries, runFiles, claimFiles);
  const archive = scanArchive(authorityArchiveDirectory, entries, authorityFiles);
  const order = (a: Fingerprint, b: Fingerprint) => a.source === b.source ? (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    : a.source < b.source ? -1 : 1;
  entries.sort(order);
  const signature = JSON.stringify([controller, archive, entries]);
  const id = sha256(JSON.stringify([controller, archive, entries.map(({ source, path, type, sha256: hash }) => [source, path, type, hash])]));
  return Object.freeze({ signature, id, present: Object.freeze({ CONTROLLER_STORE: controller, AUTHORITY_ARCHIVE: archive }),
    runFiles, claimFiles, authorityFiles });
}
