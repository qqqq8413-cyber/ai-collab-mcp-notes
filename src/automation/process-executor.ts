import { spawn, spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { z } from 'zod';

// The only way automation code runs another program: one executable with exact argv,
// never a shell string. Every run states its working directory, its time limit, both
// output limits, and its complete environment. Nothing is inherited from this process,
// and nothing is retried.

const MAX_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_STDIN_BYTES = 8 * 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 2000;

// A shell would turn one argv element back into a free-form command.
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'fish', 'csh', 'tcsh', 'cmd', 'powershell', 'pwsh', 'env']);
// Names that carry credentials or change how every program behaves. Credential access
// is not part of automation; such a variable is refused even when a caller names it.
const SECRET_NAME = /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIALS?|KEY|AUTH|COOKIE|SESSION)(_|$)/i;
const REFUSED_NAMES = /^(AWS_|SSH_|GPG_|NODE_OPTIONS$|LD_PRELOAD$|LD_LIBRARY_PATH$|DYLD_)/i;

export function isRefusedEnvironmentName(name: string): boolean {
  return SECRET_NAME.test(name) || REFUSED_NAMES.test(name);
}

const noNul = (value: string) => !value.includes('\0');
const requestSchema = z.strictObject({
  executable: z.string().min(1).refine((value) => noNul(value) && value.trim() === value)
    .refine((value) => !SHELLS.has(basename(value).toLowerCase().replace(/\.exe$/, '')), 'shell launchers are refused'),
  args: z.array(z.string().refine(noNul, 'NUL in argument')).max(4096),
  cwd: z.string().refine((value) => noNul(value) && isAbsolute(value), 'cwd must be an absolute path'),
  timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS),
  maxStdoutBytes: z.number().int().positive().max(MAX_OUTPUT_BYTES),
  maxStderrBytes: z.number().int().positive().max(MAX_OUTPUT_BYTES),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().refine(noNul))
    .refine((env) => !Object.keys(env).some(isRefusedEnvironmentName), 'credential-bearing environment variables are refused'),
  stdin: z.string().refine((value) => Buffer.byteLength(value) <= MAX_STDIN_BYTES).optional(),
  killGraceMs: z.number().int().nonnegative().max(60_000).optional(),
});

export interface ProcessRequest {
  executable: string;
  args: string[];
  /** Absolute path of an existing directory. */
  cwd: string;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  /** The complete environment of the child. */
  env: Record<string, string>;
  stdin?: string;
  killGraceMs?: number;
}

export interface ProcessResult {
  outcome: 'EXITED' | 'TIMED_OUT' | 'OUTPUT_LIMIT' | 'SPAWN_FAILED';
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string;
}

export interface ProcessExecutor {
  run(request: ProcessRequest): Promise<ProcessResult>;
}
export interface SyncProcessExecutor {
  runSync(request: ProcessRequest): ProcessResult;
}

/** A validated copy of a request. Refuses anything outside the contract, including an existing but non-directory cwd. */
export function parseProcessRequest(value: unknown): ProcessRequest {
  const request = requestSchema.parse(value) as ProcessRequest;
  let directory = false;
  try { directory = statSync(request.cwd).isDirectory(); } catch { directory = false; }
  if (!directory) throw new Error('Process cwd is not an existing directory');
  return request;
}

/** Copies only the named variables that are present. A credential-bearing name is refused, not skipped. */
export function environmentFromAllowlist(source: Readonly<Record<string, string | undefined>>, names: readonly string[]): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of names) {
    if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('Invalid environment variable name');
    if (isRefusedEnvironmentName(name)) throw new Error(`Environment variable ${name} is credential-bearing and is never forwarded`);
    const value = source[name];
    if (typeof value === 'string') environment[name] = value;
  }
  return environment;
}

class Capture {
  readonly #chunks: Buffer[] = [];
  #bytes = 0;
  constructor(readonly limit: number) {}
  /** False once the limit is exceeded; what fits is kept. */
  push(chunk: Buffer): boolean {
    const room = this.limit - this.#bytes;
    if (room > 0) this.#chunks.push(chunk.subarray(0, room));
    this.#bytes += chunk.length;
    return this.#bytes <= this.limit;
  }
  text(): string { return Buffer.concat(this.#chunks).toString('utf8'); }
}

/**
 * Runs in its own process group, so a timeout or an output overrun terminates the whole
 * tree: SIGTERM first, SIGKILL after the grace period. A terminated run is reported as
 * such, never retried.
 */
export class NodeProcessExecutor implements ProcessExecutor {
  constructor() { Object.freeze(this); }

  /** A refused request is a rejected promise; nothing is spawned for it. */
  async run(value: ProcessRequest): Promise<ProcessResult> {
    const request = parseProcessRequest(value);
    const started = performance.now();
    return new Promise((resolve) => {
      const stdout = new Capture(request.maxStdoutBytes);
      const stderr = new Capture(request.maxStderrBytes);
      let outcome: ProcessResult['outcome'] = 'EXITED';
      let timer: NodeJS.Timeout | undefined;
      let hardKill: NodeJS.Timeout | undefined;
      let settled = false;
      const finish = (result: Omit<ProcessResult, 'stdout' | 'stderr' | 'durationMs'>) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (hardKill) clearTimeout(hardKill);
        resolve({ ...result, stdout: stdout.text(), stderr: stderr.text(), durationMs: Math.round(performance.now() - started) });
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(request.executable, request.args, { cwd: request.cwd, env: { ...request.env }, shell: false,
          detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (error) {
        finish({ outcome: 'SPAWN_FAILED', exitCode: null, signal: null, error: (error as Error).message });
        return;
      }
      const group = (signal: NodeJS.Signals) => {
        try { if (child.pid) process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* already gone */ } }
      };
      const terminate = (why: 'TIMED_OUT' | 'OUTPUT_LIMIT') => {
        if (outcome !== 'EXITED') return;
        outcome = why;
        group('SIGTERM');
        hardKill = setTimeout(() => group('SIGKILL'), request.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
      };
      timer = setTimeout(() => terminate('TIMED_OUT'), request.timeoutMs);
      child.stdout!.on('data', (chunk: Buffer) => { if (!stdout.push(chunk)) terminate('OUTPUT_LIMIT'); });
      child.stderr!.on('data', (chunk: Buffer) => { if (!stderr.push(chunk)) terminate('OUTPUT_LIMIT'); });
      child.stdin!.on('error', () => undefined);
      child.on('error', (error) => {
        if (!child.pid) finish({ outcome: 'SPAWN_FAILED', exitCode: null, signal: null, error: error.message });
      });
      child.on('close', (code, signal) => finish({ outcome, exitCode: code, signal }));
      child.stdin!.end(request.stdin ?? '');
    });
  }
}
Object.freeze(NodeProcessExecutor);
Object.freeze(NodeProcessExecutor.prototype);

/**
 * The synchronous form, for boundaries that are synchronous by design (the repository
 * reality port). A timeout kills with SIGKILL; an output overrun kills the child.
 */
export class SyncNodeProcessExecutor implements SyncProcessExecutor {
  constructor() { Object.freeze(this); }

  runSync(value: ProcessRequest): ProcessResult {
    const request = parseProcessRequest(value);
    const started = performance.now();
    const result = spawnSync(request.executable, request.args, { cwd: request.cwd, env: { ...request.env }, shell: false,
      input: request.stdin ?? '', timeout: request.timeoutMs, killSignal: 'SIGKILL', windowsHide: true,
      maxBuffer: Math.max(request.maxStdoutBytes, request.maxStderrBytes) });
    const stdout = result.stdout ?? Buffer.alloc(0);
    const stderr = result.stderr ?? Buffer.alloc(0);
    const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
    let outcome: ProcessResult['outcome'] = 'EXITED';
    if (code === 'ETIMEDOUT') outcome = 'TIMED_OUT';
    else if (code === 'ENOBUFS' || stdout.length > request.maxStdoutBytes || stderr.length > request.maxStderrBytes) outcome = 'OUTPUT_LIMIT';
    else if (result.error) outcome = 'SPAWN_FAILED';
    return { outcome, exitCode: result.status, signal: result.signal, durationMs: Math.round(performance.now() - started),
      stdout: stdout.subarray(0, request.maxStdoutBytes).toString('utf8'),
      stderr: stderr.subarray(0, request.maxStderrBytes).toString('utf8'),
      ...(result.error && outcome === 'SPAWN_FAILED' ? { error: result.error.message } : {}) };
  }
}
Object.freeze(SyncNodeProcessExecutor);
Object.freeze(SyncNodeProcessExecutor.prototype);
