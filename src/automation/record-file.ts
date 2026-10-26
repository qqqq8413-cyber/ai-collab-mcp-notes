import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

// AUTO-P2-A4-P0-S1-R3: one safe read of a governance record file (a Controller run or admission
// record, an invocation journal record, an Authority Archive record). It only reads: it grants no
// capability, opens nothing for writing and imports nothing but node:fs, so the modules that use it
// keep their existing boundaries.

export type RecordFileProblem = 'SYMLINK' | 'NOT_REGULAR' | 'UNSAFE_OWNER' | 'UNSAFE_MODE' | 'TOO_LARGE' | 'UNREADABLE';
export type RecordFileRead =
  | { status: 'ABSENT' }
  | { status: 'READ'; text: string }
  | { status: 'UNSAFE'; problem: RecordFileProblem };

const CHUNK = 64 * 1024;

/**
 * Opens without following a symlink and without blocking (O_NOFOLLOW | O_NONBLOCK), so a FIFO or a
 * device cannot stall the open or the read. Before any byte is read, fstat must show a regular file
 * owned by this user with no group/other or setuid/setgid/sticky bits and at most `maxBytes`. The read
 * itself is bounded: it never reads more than `maxBytes + 1` bytes, whatever fstat reported, so a file
 * that grows while it is read is refused, not consumed. ABSENT only when open(2) itself reports ENOENT.
 */
export function readRecordFile(path: string, maxBytes: number): RecordFileRead {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('maxBytes must be a positive integer');
  const unsafe = (problem: RecordFileProblem): RecordFileRead => ({ status: 'UNSAFE', problem });
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { status: 'ABSENT' };
    return unsafe(code === 'ELOOP' || code === 'EMLINK' ? 'SYMLINK' : 'UNREADABLE');
  }
  try {
    const st = fstatSync(fd), uid = process.getuid?.();
    if (!st.isFile()) return unsafe('NOT_REGULAR');
    if (uid !== undefined && st.uid !== uid) return unsafe('UNSAFE_OWNER');
    if (st.mode & 0o7077) return unsafe('UNSAFE_MODE');
    if (st.size > maxBytes) return unsafe('TOO_LARGE');
    const chunk = Buffer.allocUnsafe(Math.min(CHUNK, maxBytes + 1)), chunks: Buffer[] = [];
    let total = 0;
    for (let n; (n = readSync(fd, chunk, 0, Math.min(chunk.length, maxBytes + 1 - total), null)) > 0;) {
      chunks.push(Buffer.from(chunk.subarray(0, n))); total += n;
      if (total > maxBytes) return unsafe('TOO_LARGE');
    }
    return { status: 'READ', text: Buffer.concat(chunks, total).toString('utf8') };
  } catch {
    return unsafe('UNREADABLE');
  } finally { closeSync(fd); }
}
