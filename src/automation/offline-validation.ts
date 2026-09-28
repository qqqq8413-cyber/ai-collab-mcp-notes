import type { ProcessResult } from './process-executor.js';

// OFFLINE_VALIDATION runs code a model wrote. The classification is not the boundary:
// an implementation of this port is. It runs one packet validation command with the
// network denied and the filesystem confined to the validation workspace (read/write),
// one temporary directory (read/write), the stated read-only dependencies, and the
// operating system itself. Nothing else under a user's home is readable, no credential
// location is reachable, the environment is exactly the one given, and nothing is
// retried. An implementation that cannot enforce this answers UNAVAILABLE; it never
// runs the command some other way.

export interface OfflineValidationRequest {
  executable: string;
  args: readonly string[];
  /** Absolute; inside `workspace`. */
  cwd: string;
  /** Absolute, existing directory: the disposable copy validated. Readable and writable. */
  workspace: string;
  /** Absolute, existing, empty directory. Readable and writable; HOME and TMPDIR point here. */
  temporaryDirectory: string;
  /** Absolute, existing paths readable (never writable) during validation, such as linked dependencies. */
  readOnlyPaths: readonly string[];
  /** The explicit non-secret environment. HOME, TMPDIR, and PATH are set by the implementation. */
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
}

export type OfflineValidationOutcome =
  | { isolation: 'ENFORCED'; result: ProcessResult }
  | { isolation: 'UNAVAILABLE'; reason: string };

export interface OfflineValidationExecutor {
  runOffline(request: OfflineValidationRequest): Promise<OfflineValidationOutcome>;
}
