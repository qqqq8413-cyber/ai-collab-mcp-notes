import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import type { OfflineValidationExecutor, OfflineValidationOutcome, OfflineValidationRequest } from '../offline-validation.js';
import type { ProcessExecutor } from '../process-executor.js';
import { succeeded, summary } from './common.js';

// The production OFFLINE_VALIDATION boundary on macOS: every command runs under
// sandbox-exec with a deny-by-default Seatbelt profile. The profile allows starting
// processes and reading the operating system; it allows reading and writing only the
// validation workspace and one temporary directory, and reading only the stated
// dependencies and runtime paths. It allows no network operation and no Mach service
// lookup, so neither a socket nor a system daemon (DNS, keychain, launch services) can
// be reached. Paths are passed as profile parameters, never spliced into the profile.
// Where this cannot be enforced, the command is not run.

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

// Operating-system locations a process needs to start and keep time. None is under a
// user's home directory and none holds credentials.
const SYSTEM_READ_TREES = Object.freeze(['/usr', '/bin', '/System', '/private/var/db/timezone']);
const SYSTEM_READ_FILES = Object.freeze(['/', '/private/etc/localtime', '/dev/null', '/dev/zero', '/dev/random', '/dev/urandom']);
// Root-level symlinks whose metadata runtimes inspect while resolving paths.
const SYSTEM_METADATA = Object.freeze(['/', '/etc', '/tmp', '/var']);
const SYSTEM_WRITE_FILES = Object.freeze(['/dev/null']);

// Locations a configured path may neither be inside nor contain: they hold keys,
// tokens, keychains, or tool credentials.
const HOME_CREDENTIAL_LOCATIONS = Object.freeze(['.ssh', '.aws', '.gnupg', '.config', '.claude', '.codex', '.docker', '.kube',
  '.netrc', '.npmrc', '.pypirc', '.git-credentials', '.gitconfig', '.local/share', 'Library/Keychains', 'Library/Cookies',
  'Library/Application Support', 'Library/Containers', 'Library/Group Containers']);
const SYSTEM_CREDENTIAL_LOCATIONS = Object.freeze(['/Library/Keychains', '/private/var/db', '/private/etc', '/private/var/root']);

function within(path: string, root: string): boolean {
  const rest = relative(root, path);
  return rest === '' || (rest !== '..' && !rest.startsWith('../') && !isAbsolute(rest));
}

/** A configured path as the sandbox sees it, or why it may not be opened to validation. */
export function confinedPath(path: string, home: string): string {
  if (typeof path !== 'string' || !isAbsolute(path) || /[\u0000-\u001f]/.test(path)) throw new Error(`Validation path ${JSON.stringify(path)} is not absolute`);
  const real = realpathSync(path);
  if (real === '/') throw new Error('Validation may not open the filesystem root');
  if (within(home, real)) throw new Error(`Validation path ${real} contains the home directory`);
  const credentials = [...HOME_CREDENTIAL_LOCATIONS.map((location) => join(home, location)), ...SYSTEM_CREDENTIAL_LOCATIONS];
  const hit = credentials.find((location) => within(real, location) || within(location, real));
  if (hit) throw new Error(`Validation path ${real} overlaps credential location ${hit}`);
  return real;
}

export interface SeatbeltPolicy {
  /** Readable, never writable. */
  readTrees: readonly string[];
  /** Readable and writable. */
  writeTrees: readonly string[];
}

/** The deny-by-default profile and the sandbox-exec parameters that bind its paths. */
export function seatbeltProfile(policy: SeatbeltPolicy): { profile: string; parameters: string[] } {
  if ([...policy.readTrees, ...policy.writeTrees].some((path) => !isAbsolute(path) || path.includes('\0'))) {
    throw new Error('Seatbelt paths must be absolute');
  }
  const parameters: string[] = [];
  const bind = (prefix: string, paths: readonly string[]) => paths.map((path, index) => {
    parameters.push('-D', `${prefix}${index}=${path}`);
    return `(param "${prefix}${index}")`;
  });
  const quoted = (paths: readonly string[]) => paths.map((path) => `"${path}"`);
  const ancestors = new Set<string>();
  for (const path of [...policy.readTrees, ...policy.writeTrees]) {
    for (let current = dirname(path); current !== '/'; current = dirname(current)) ancestors.add(current);
  }
  const reads = bind('R', policy.readTrees);
  const writes = bind('W', policy.writeTrees);
  const metadata = bind('M', [...ancestors].sort());
  const profile = ['(version 1)', '(deny default)',
    '(allow process-fork)', '(allow process-exec)', '(allow signal (target same-sandbox))', '(allow sysctl-read)',
    `(allow file-read-metadata ${[...quoted(SYSTEM_METADATA).map((path) => `(literal ${path})`), ...metadata.map((param) => `(literal ${param})`)].join(' ')})`,
    `(allow file-read* ${[...quoted(SYSTEM_READ_TREES).map((path) => `(subpath ${path})`), ...quoted(SYSTEM_READ_FILES).map((path) => `(literal ${path})`),
      ...[...reads, ...writes].map((param) => `(subpath ${param})`)].join(' ')})`,
    `(allow file-write* ${[...quoted(SYSTEM_WRITE_FILES).map((path) => `(literal ${path})`), ...writes.map((param) => `(subpath ${param})`)].join(' ')})`,
  ].join('\n');
  return { profile, parameters };
}

export interface SeatbeltSettings {
  /** Absolute runtime locations validation reads, such as a developer toolchain. Never a home or credential location. */
  runtimeReadPaths: readonly string[];
  /** PATH inside the sandbox: absolute directories only. */
  searchPath: string;
}

export class SeatbeltOfflineValidationExecutor implements OfflineValidationExecutor {
  readonly #settings: SeatbeltSettings;
  readonly #executor: ProcessExecutor;
  readonly #home: string;

  constructor(settings: SeatbeltSettings, dependencies: { executor: ProcessExecutor; platform?: string; home?: string }) {
    const platform = dependencies.platform ?? process.platform;
    if (platform !== 'darwin' || !existsSync(SANDBOX_EXEC)) {
      throw new Error('Offline validation isolation (macOS Seatbelt) is unavailable on this host; live automation is not composed');
    }
    if (typeof settings.searchPath !== 'string' || !settings.searchPath.split(':').every((part) => isAbsolute(part) && !part.includes('\0'))) {
      throw new Error('Validation search path must list absolute directories only');
    }
    this.#settings = Object.freeze({ runtimeReadPaths: Object.freeze([...settings.runtimeReadPaths]), searchPath: settings.searchPath });
    this.#executor = dependencies.executor;
    this.#home = realpathSync(dependencies.home ?? homedir());
    Object.freeze(this);
  }

  async runOffline(request: OfflineValidationRequest): Promise<OfflineValidationOutcome> {
    let policy: SeatbeltPolicy;
    let cwd: string;
    let temporary: string;
    try {
      const workspace = confinedPath(request.workspace, this.#home);
      temporary = confinedPath(request.temporaryDirectory, this.#home);
      if (!statSync(workspace).isDirectory() || !statSync(temporary).isDirectory()) throw new Error('Validation workspace and temporary directory must be directories');
      cwd = realpathSync(request.cwd);
      if (!within(cwd, workspace)) throw new Error('Validation cwd is outside the validation workspace');
      const readTrees = [...request.readOnlyPaths, ...this.#settings.runtimeReadPaths].map((path) => confinedPath(path, this.#home));
      policy = { readTrees: [...new Set(readTrees)], writeTrees: [...new Set([workspace, temporary])] };
    } catch (error) {
      return { isolation: 'UNAVAILABLE', reason: error instanceof Error ? error.message : String(error) };
    }
    const { profile, parameters } = seatbeltProfile(policy);
    const env = { ...request.env, PATH: this.#settings.searchPath, HOME: temporary, TMPDIR: temporary };
    const sandboxed = (executable: string, args: readonly string[], limits: { timeoutMs: number; maxStdoutBytes: number; maxStderrBytes: number }) =>
      this.#executor.run({ executable: SANDBOX_EXEC, args: [...parameters, '-p', profile, '--', executable, ...args], cwd, env, ...limits });

    // The profile must apply before anything the model wrote is run under it.
    const probe = await sandboxed('/usr/bin/true', [], { timeoutMs: 30_000, maxStdoutBytes: 65_536, maxStderrBytes: 65_536 });
    if (!succeeded(probe)) return { isolation: 'UNAVAILABLE', reason: `the Seatbelt profile could not be applied: ${summary(probe)}` };
    const result = await sandboxed(request.executable, request.args, { timeoutMs: request.timeoutMs, maxStdoutBytes: request.maxStdoutBytes,
      maxStderrBytes: request.maxStderrBytes });
    return { isolation: 'ENFORCED', result };
  }
}
Object.freeze(SeatbeltOfflineValidationExecutor);
Object.freeze(SeatbeltOfflineValidationExecutor.prototype);
