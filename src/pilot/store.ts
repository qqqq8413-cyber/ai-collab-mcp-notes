import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AutomationRequestError } from '../workspace/automation-port.js';
import { envelopeSchema, payloadSchema, type PilotData } from './model.js';

export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const problem = () => new AutomationRequestError('PILOT_STORAGE', 503, '自動化儲存無法驗證；未繼續執行，請保留檔案供檢查。');

// Operational records only, in their own directory. No authority or invocation journal is opened.
export class PilotStore {
  readonly directory: string;
  constructor(dataDirectory: string) {
    this.directory = join(dataDirectory, 'auto-p1');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.checkDirectory();
  }
  checkDirectory(): void {
    const s = lstatSync(this.directory);
    if (!s.isDirectory() || s.isSymbolicLink()) throw problem();
  }
  file(projectId: string): string {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(projectId)) throw problem();
    return join(this.directory, projectId + '.json');
  }
  read(projectId: string): PilotData {
    this.checkDirectory();
    const file = this.file(projectId);
    let fd: number | undefined;
    try {
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const s = fstatSync(fd);
      if (!s.isFile() || s.size > 32 * 1024 * 1024) throw problem();
      const parsed = envelopeSchema.parse(JSON.parse(readFileSync(fd, 'utf8')));
      if (parsed.payload.projectId !== projectId || parsed.checksum !== digest(parsed.payload)) throw problem();
      if (new Set(parsed.payload.tasks.map(t => t.id)).size !== parsed.payload.tasks.length ||
          new Set(parsed.payload.runs.map(r => r.id)).size !== parsed.payload.runs.length) throw problem();
      return parsed.payload;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { projectId, revision: 0, tasks: [], runs: [], changes: [], ci: [], operations: [], readStarts: [], baselinedTasks: [] };
      throw problem();
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  write(input: PilotData): void {
    this.checkDirectory();
    const payload = payloadSchema.parse(input);
    const bytes = JSON.stringify({ schemaVersion: 1, checksum: digest(payload), payload });
    if (Buffer.byteLength(bytes) > 32 * 1024 * 1024) throw problem();
    const file = this.file(payload.projectId);
    const tmp = file + '.' + randomUUID() + '.tmp';
    const fd = openSync(tmp, 'wx', 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    try {
      renameSync(tmp, file);
      const directory = openSync(this.directory, 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } finally { try { unlinkSync(tmp); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } }
  }
  lease(): () => void {
    this.checkDirectory();
    const file = join(this.directory, 'runtime.lock');
    let fd: number;
    try { fd = openSync(file, 'wx', 0o600); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw problem();
      const prior = lstatSync(file);
      if (!prior.isFile() || prior.isSymbolicLink() || prior.size > 1000) throw problem();
      let pid: number;
      try { pid = JSON.parse(readFileSync(file, 'utf8')).pid; } catch { throw problem(); }
      if (!Number.isSafeInteger(pid) || pid < 1) throw problem();
      try { process.kill(pid, 0); throw new Error('alive'); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw new AutomationRequestError('PILOT_BUSY', 409, '此資料目錄已有自動化程序；不啟動第二份排程。'); }
      const current = lstatSync(file);
      if (current.ino !== prior.ino || current.dev !== prior.dev) throw problem();
      unlinkSync(file);
      return this.lease();
    }
    const owner = fstatSync(fd);
    writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce: randomUUID() })); fsyncSync(fd);
    return () => {
      closeSync(fd);
      const current = lstatSync(file);
      if (current.ino === owner.ino && current.dev === owner.dev) unlinkSync(file);
    };
  }
}
