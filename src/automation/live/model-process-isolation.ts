import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { sameEgressSet } from '../egress-destination.js';
import type { EgressSummary } from '../egress-journal.js';
import type { ActorKind } from '../invocation-journal.js';
import type { ProcessResult } from '../process-executor.js';
import type { ProviderCallScope } from '../types.js';

// LIVE MODEL PROCESS boundary. A live model CLI runs only through an implementation of
// this port, never through the ordinary process executor. The implementation runs the
// pinned executable with its network confined to one invocation-scoped CONNECT broker
// that enforces the call's exact egress set, and its files confined to the stated
// workspace and paths. It returns the broker's durable evidence with the result. One that
// cannot enforce this answers UNAVAILABLE and runs nothing; there is no weaker fallback.

export interface ModelProcessRequest {
  invocationId: string;
  actorKind: ActorKind;
  /** The exact provider, model, and egress set the broker enforces. */
  scope: ProviderCallScope;
  /** Absolute path of the pinned CLI executable, and the SHA-256 of its bytes. */
  executable: string;
  executableSha256: string;
  args: readonly string[];
  /** Absolute; inside `workspace.path`. */
  cwd: string;
  /** The model's workspace: readable, and writable only in READ_WRITE mode. */
  workspace: { path: string; mode: 'READ_WRITE' | 'READ_ONLY' };
  /** Further absolute paths the process may write, such as the directory of an answer file. */
  writablePaths: readonly string[];
  /** Further absolute paths the process may read, never write. */
  readOnlyPaths: readonly string[];
  /** Explicit non-secret environment. Proxy, provider-routing, and TLS-trust variables are refused; HOME, TMPDIR, and PATH are set by the boundary. */
  env: Readonly<Record<string, string>>;
  stdin: string;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
}

export type EgressEvidence = { status: 'RECORDED'; summary: EgressSummary } | { status: 'AMBIGUOUS'; reason: string };

export type ModelProcessOutcome =
  | { isolation: 'ENFORCED'; result: ProcessResult; egress: EgressEvidence }
  | { isolation: 'UNAVAILABLE'; reason: string };

export interface LiveModelProcessExecutor {
  runModel(request: ModelProcessRequest): Promise<ModelProcessOutcome>;
}

// The boundary alone decides where a model process's network goes. A caller may not name
// a proxy, point a CLI at another provider or endpoint, or change which certificates it
// trusts. Such a name in the request refuses the run; it is never silently replaced.
const REFUSED_MODEL_ENVIRONMENT = new RegExp('^(' + [
  '(HTTPS?|ALL|NO|FTP)_PROXY', 'GLOBAL_AGENT_.*', 'NODE_USE_ENV_PROXY',
  'ANTHROPIC_.*', 'OPENAI_.*', 'CODEX_.*', 'AZURE_.*', 'AWS_.*', 'GOOGLE_.*', 'GCLOUD_.*', 'CLOUDSDK_.*', 'VERTEX.*', 'CLOUD_ML_.*',
  'CLAUDE_CODE_USE_.*', 'CLAUDE_CODE_.*(BASE_URL|PROXY.*|OAUTH.*|CLIENT_CERT.*|CLIENT_KEY.*|UNIX_SOCKET)',
  'NODE_EXTRA_CA_CERTS', 'NODE_TLS_.*', 'SSL_CERT_.*', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
].join('|') + ')$', 'i');

/** The first environment name a model process request may not carry, if any. */
export function refusedModelEnvironmentName(env: Readonly<Record<string, string>>): string | undefined {
  return Object.keys(env ?? {}).find((name) => REFUSED_MODEL_ENVIRONMENT.test(name));
}

/** The proxy environment the boundary sets for the child: every scheme to the broker, no exemptions. */
export function proxyEnvironment(port: number): Record<string, string> {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new RangeError('Broker port out of range');
  const proxy = `http://127.0.0.1:${port}`;
  return { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy, NO_PROXY: '', http_proxy: proxy, https_proxy: proxy, all_proxy: proxy, no_proxy: '' };
}

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * The canonical path of a pinned executable after checking that its bytes hash to
 * `sha256`. A script is refused: its hash pins neither its interpreter nor anything it
 * launches, so it cannot stand in for the program that actually runs.
 */
export function verifyPinnedExecutable(path: string, sha256: string): string {
  if (typeof path !== 'string' || !isAbsolute(path) || /[\u0000-\u001f]/.test(path)) throw new Error('Pinned executable must be an absolute path');
  if (typeof sha256 !== 'string' || !SHA256.test(sha256)) throw new Error('Pinned executable needs a lower-case SHA-256');
  const real = realpathSync(path);
  if (!statSync(real).isFile()) throw new Error('Pinned executable is not a regular file');
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(1024 * 1024);
  const fd = openSync(real, 'r');
  let head = '';
  try {
    for (let read = readSync(fd, buffer); read > 0; read = readSync(fd, buffer)) {
      if (head === '') head = buffer.subarray(0, 2).toString('latin1');
      hash.update(buffer.subarray(0, read));
    }
  } finally { closeSync(fd); }
  if (head === '#!') throw new Error('Pinned executable is a script; pin the program that actually runs');
  if (hash.digest('hex') !== sha256) throw new Error('Pinned executable hash mismatch; nothing is run');
  return real;
}

function succeeded(result: ProcessResult): boolean {
  return result.outcome === 'EXITED' && result.exitCode === 0;
}

/**
 * Why a model process's result may not be used, from its egress evidence, or undefined
 * when it may. The evidence must be a closed session of exactly this invocation whose
 * allowlist is exactly the call's egress set, with no refused connection; and a process
 * that reports success must show at least one broker-recorded connection. Anything
 * missing or ambiguous refuses.
 */
export function egressRefusal(outcome: Extract<ModelProcessOutcome, { isolation: 'ENFORCED' }>, scope: ProviderCallScope,
  invocationId: string): string | undefined {
  const evidence = outcome.egress;
  if (evidence?.status !== 'RECORDED') return `egress evidence is missing or ambiguous: ${evidence?.reason ?? 'none'}`.slice(0, 600);
  const summary = evidence.summary;
  if (summary.sessionId !== invocationId || !summary.closed) return 'egress evidence does not close this invocation\'s session';
  if (!sameEgressSet(summary.allowlist, scope.egressDestinations)) return 'the broker allowlist differs from the authorized egress set';
  if (summary.denied > 0) return `the model process attempted ${summary.denied} unauthorized egress connection(s); nothing is retried or widened`;
  if (succeeded(outcome.result) && summary.connected === 0) return 'the model process reported success with no broker-recorded provider connection';
  return undefined;
}
