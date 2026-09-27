import type { ActorKind, InvocationJournal, InvocationRecord } from '../invocation-journal.js';
import type { ProcessExecutor, ProcessResult } from '../process-executor.js';
import type { ProviderCallScope } from '../types.js';

// Shared by the live adapters. Nothing here calls a model or writes a repository.

/**
 * A live adapter dispatches nothing unless the journal shows this exact invocation
 * STARTED for this adapter's actor kind, provider, model, and destination, and for the
 * run and packet it was given. The runner writes STARTED only after the human-grant
 * gate and the call budget, so an adapter composed outside that path refuses to run.
 */
export function requireStartedInvocation(journal: InvocationJournal, input: { invocationId?: string; runId: string; sliceId: string;
  packet: { packetId: string }; packetHash: string }, kind: ActorKind, scope: ProviderCallScope): InvocationRecord {
  const id = input.invocationId;
  if (typeof id !== 'string') throw new Error('Live adapter refuses: the call is not journaled');
  const record = journal.get(id);
  const identity = record?.identity;
  if (!record || record.state !== 'STARTED' || identity!.actorKind !== kind || identity!.provider !== scope.provider ||
      identity!.model !== scope.model || identity!.destination !== scope.destination || identity!.runId !== input.runId ||
      identity!.sliceId !== input.sliceId || identity!.packetId !== input.packet.packetId || identity!.packetHash !== input.packetHash) {
    throw new Error('Live adapter refuses: no STARTED invocation binds this exact call');
  }
  return record;
}

// A moving alias is not a model identity; nothing substitutes one model for another.
const MODEL_ALIASES = new Set(['latest', 'default', 'best', 'auto', 'opus', 'sonnet', 'haiku', 'fable', 'mini']);
export function assertExactModel(model: unknown): string {
  if (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(model) || MODEL_ALIASES.has(model.toLowerCase()) ||
      /latest/i.test(model)) {
    throw new Error(`Model ${JSON.stringify(model)} is not an exact model identifier`);
  }
  return model;
}

export interface GitSettings {
  executable: string;
  remote: string;
  /** Local clone that worktrees are created from. */
  repositoryPath: string;
  /** Directory under which each invocation gets its own worktree. */
  worktreeRoot: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export function succeeded(result: ProcessResult): boolean {
  return result.outcome === 'EXITED' && result.exitCode === 0;
}
export function summary(result: ProcessResult): string {
  const tail = (result.stderr || result.stdout).trim().split('\n').slice(-3).join(' | ');
  return `${result.outcome}${result.exitCode === null ? '' : ` exit ${result.exitCode}`}${tail ? `: ${tail}` : ''}`.slice(0, 600);
}

/** Git, with repository hooks disabled for every call: a hook is code the reviewed or delivered tree could supply. */
export function git(executor: ProcessExecutor, settings: GitSettings, env: Record<string, string>, cwd: string, args: string[],
  stdin?: string): Promise<ProcessResult> {
  return executor.run({ executable: settings.executable, args: ['-c', 'core.hooksPath=/dev/null', ...args], cwd, env,
    timeoutMs: settings.timeoutMs, maxStdoutBytes: settings.maxOutputBytes, maxStderrBytes: settings.maxOutputBytes,
    ...(stdin === undefined ? {} : { stdin }) });
}

/** The exact SHA of one remote branch, or null when it does not exist. Anything ambiguous throws. */
export async function remoteBranchSha(executor: ProcessExecutor, settings: GitSettings, env: Record<string, string>,
  branch: string): Promise<string | null> {
  const ref = `refs/heads/${branch}`;
  const result = await git(executor, settings, env, settings.repositoryPath, ['ls-remote', '--heads', settings.remote, ref]);
  if (!succeeded(result)) throw new Error(`Could not read remote branch ${branch}: ${summary(result)}`);
  const lines = result.stdout.split('\n').filter((line) => line.trim());
  const matches = lines.map((line) => line.split('\t')).filter(([, name]) => name === ref);
  if (matches.length !== lines.length || matches.length > 1) throw new Error(`Ambiguous remote branch listing for ${branch}`);
  if (matches.length === 0) return null;
  const sha = matches[0][0];
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Malformed remote SHA for ${branch}`);
  return sha;
}

// Paths an implementation may never change, whatever the packet allows: repository
// metadata, CI workflows, and credential-shaped files.
const PROTECTED_PATH = /(^|\/)\.git(\/|$)|^\.github(\/|$)|(^|\/)\.gitmodules$|(^|\/)\.gitattributes$|(^|\/)\.env($|\.)|\.(pem|key|p12|pfx|keystore)$|(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$|(^|\/)\.(npmrc|netrc|pypirc)$/i;

export function withinArea(path: string, area: string): boolean {
  const normalized = area.replace(/\/+$/, '');
  return normalized.length > 0 && (path === normalized || path.startsWith(`${normalized}/`));
}

export type ScopeVerdict = { ok: true } | { ok: false; protectedPath: boolean; reason: string };

/** Every path must be a clean repository-relative path inside an allowed area, outside every forbidden area and every protected path. */
export function checkScope(paths: readonly string[], allowedAreas: readonly string[], forbiddenChanges: readonly string[]): ScopeVerdict {
  for (const path of paths) {
    if (!path || path.startsWith('/') || path.split('/').some((part) => part === '..' || part === '') || /[\u0000-\u001f]/.test(path)) {
      return { ok: false, protectedPath: true, reason: `invalid path ${JSON.stringify(path)}` };
    }
    if (PROTECTED_PATH.test(path)) return { ok: false, protectedPath: true, reason: `protected path ${path}` };
    if (forbiddenChanges.some((area) => withinArea(path, area))) return { ok: false, protectedPath: false, reason: `forbidden path ${path}` };
    if (!allowedAreas.some((area) => withinArea(path, area))) return { ok: false, protectedPath: false, reason: `path outside allowed areas ${path}` };
  }
  return { ok: true };
}

/** Paths named by `git status --porcelain=v1 -z`, including both sides of a rename or copy. */
export function statusPaths(output: string): string[] {
  const tokens = output.split('\0');
  const paths: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token) continue;
    if (token.length < 4 || token[2] !== ' ') throw new Error('Unrecognized git status entry');
    paths.push(token.slice(3));
    if (token[0] === 'R' || token[0] === 'C') paths.push(tokens[++index] ?? '');
  }
  return paths;
}

/** Entries of `git diff --cached --raw -z --no-renames`: path, new mode, status. */
export function stagedEntries(output: string): Array<{ path: string; mode: string; status: string }> {
  const tokens = output.split('\0').filter((token, index, all) => token !== '' || index < all.length - 1);
  const entries: Array<{ path: string; mode: string; status: string }> = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const meta = tokens[index];
    const path = tokens[index + 1];
    const fields = meta?.startsWith(':') ? meta.slice(1).split(' ') : [];
    if (fields.length !== 5 || path === undefined) throw new Error('Unrecognized git diff --raw entry');
    entries.push({ path, mode: fields[1], status: fields[4] });
  }
  return entries;
}
