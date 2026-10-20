import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { digest } from '../pilot/store.js';
import { AiPilotRequestError } from '../workspace/ai-pilot-port.js';

export const AGENTS = Object.freeze([
  Object.freeze({ id: 'claude-code', name: 'Claude Code', provider: 'anthropic', requestedModel: 'claude-sonnet-5',
    modelSource: 'REPOSITORY_CONFIG_DEFAULT_NOT_PROBED', adapterRole: 'IMPLEMENTATION', scopeCompatible: false }),
  Object.freeze({ id: 'codex', name: 'Codex', provider: 'openai', requestedModel: 'gpt-5',
    modelSource: 'REPOSITORY_CONFIG_DEFAULT_NOT_PROBED', adapterRole: 'ARCHITECT_REVIEW', scopeCompatible: false }),
]);
export const planInput = z.strictObject({ requestId: z.string().uuid(), goalId: z.string().regex(/^goal-[a-f0-9-]{36}$/),
  agentId: z.enum(['claude-code', 'codex']) });
export const planSchema = planInput.extend({ objectiveHash: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.iso.datetime(),
  principalRef: z.string().min(1).max(256), recordClass: z.literal('OPERATIONAL_RECORD'), state: z.literal('PERMIT_DRAFT'),
  requestedModel: z.string().min(1).max(200) });
export type Plan = z.infer<typeof planSchema>;
const payload = z.strictObject({ projectId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/), plans: z.array(planSchema).max(100) });
const envelope = z.strictObject({ schemaVersion: z.literal(1), checksum: z.string().regex(/^[a-f0-9]{64}$/), payload });
const storageError = () => new AiPilotRequestError('PREPARATION_STORAGE', 503, 'AI 工作準備紀錄無法驗證；不啟動執行或修補檔案。');

export class PreparationStore {
  readonly #directory: string;
  constructor(dataDirectory: string) { this.#directory = join(dataDirectory, 'ai-preparation'); }
  #check(): void {
    try { const s = lstatSync(this.#directory); if (!s.isDirectory() || s.isSymbolicLink()) throw storageError(); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw storageError(); }
  }
  #file(projectId: string): string {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(projectId)) throw storageError();
    return join(this.#directory, projectId + '.json');
  }
  read(projectId: string): Plan[] {
    this.#check(); let fd: number | undefined;
    try {
      fd = openSync(this.#file(projectId), constants.O_RDONLY | constants.O_NOFOLLOW);
      const s = fstatSync(fd); if (!s.isFile() || s.size > 1024 * 1024) throw storageError();
      const parsed = envelope.parse(JSON.parse(readFileSync(fd, 'utf8')));
      if (parsed.payload.projectId !== projectId || parsed.checksum !== digest(parsed.payload) ||
        new Set(parsed.payload.plans.map(p => p.requestId)).size !== parsed.payload.plans.length) throw storageError();
      return parsed.payload.plans;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw storageError();
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  add(projectId: string, input: Plan): void {
    this.#check(); mkdirSync(this.#directory, { recursive: true, mode: 0o700 }); this.#check();
    const file = this.#file(projectId), lock = file + '.lock';
    let fd: number;
    try { fd = openSync(lock, 'wx', 0o600); } catch { throw new AiPilotRequestError('PREPARATION_BUSY', 409, '工作準備紀錄忙碌；請稍後再試。'); }
    const owner = fstatSync(fd); let temp: string | undefined;
    try {
      const plan = planSchema.parse(input), plans = this.read(projectId);
      const existing = plans.find(p => p.requestId === plan.requestId || p.goalId === plan.goalId);
      if (existing) {
        if (existing.goalId !== plan.goalId || existing.agentId !== plan.agentId || existing.principalRef !== plan.principalRef || existing.objectiveHash !== plan.objectiveHash) {
          throw new AiPilotRequestError('PLAN_CONFLICT', 409, '既有工作準備綁定不同；未覆寫。');
        }
        return;
      }
      if (plans.length >= 100) throw new AiPilotRequestError('PLAN_LIMIT', 409, '準備紀錄已達上限；未刪除或覆寫既有紀錄。');
      const data = payload.parse({ projectId, plans: [...plans, plan] });
      temp = file + '.' + randomUUID() + '.tmp';
      const out = openSync(temp, 'wx', 0o600);
      try { writeFileSync(out, JSON.stringify({ schemaVersion: 1, checksum: digest(data), payload: data })); fsyncSync(out); }
      finally { closeSync(out); }
      renameSync(temp, file); temp = undefined;
      const dir = openSync(this.#directory, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
    } finally {
      if (temp) unlinkSync(temp); closeSync(fd);
      const current = lstatSync(lock); if (current.dev === owner.dev && current.ino === owner.ino) unlinkSync(lock);
    }
  }
}
