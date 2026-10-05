import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { parseEgressSet } from '../egress-destination.js';
import { GovernanceStoreIsolation } from '../governance-store-isolation.js';
import { summarizeEgress, type EgressJournal } from '../egress-journal.js';
import type { ProcessExecutor, ProcessResult } from '../process-executor.js';
import { ACTOR_KINDS } from '../types.js';
import { succeeded, summary } from './common.js';
import { ConnectBroker, type BrokerLimits, type EgressDialer, type EgressResolver } from './connect-broker.js';
import {
  proxyEnvironment, refusedModelEnvironmentName, verifyPinnedExecutable, type EgressEvidence, type LiveModelProcessExecutor,
  type ModelProcessOutcome, type ModelProcessRequest,
} from './model-process-isolation.js';
import {
  SANDBOX_EXEC, assertFixedSeatbeltTreesIsolated, assertInvocationIsolated, confinedPath, searchPathDirectories, seatbeltProfile,
} from './seatbelt-validation.js';

// The production LIVE MODEL PROCESS boundary on macOS. Per invocation:
//   verify the executable pin and the exact scope; open the durable egress session;
//   start a loopback CONNECT broker for exactly the call's egress set; build a
//   deny-by-default Seatbelt profile whose only network permission is TCP to that
//   broker port on IPv4 loopback; prove it applies; verify the pin again; run the CLI
//   with the broker as its only proxy; then stop the broker, close the session, and read
//   the evidence back from the journal before returning anything.
// Seatbelt cannot name a remote host, so the broker is the only way out: a CLI that
// ignores the proxy and dials a provider directly is refused by the kernel. Files follow
// the offline validation rules: the workspace (read-only or read-write), stated paths,
// one temporary directory for HOME and TMPDIR, and the operating system. No Mach service
// is allowed. Where any of this cannot be enforced, the CLI does not run.

export interface ModelProcessSettings {
  /** Absolute runtime locations the CLI reads (its installation). Never a home or credential location. */
  runtimeReadPaths: readonly string[];
  /** PATH inside the sandbox: absolute directories only. */
  searchPath: string;
}

function within(path: string, root: string): boolean {
  const rest = relative(root, path);
  return rest === '' || (rest !== '..' && !rest.startsWith('../') && !isAbsolute(rest));
}

/** The Seatbelt profile of a model process: the offline profile plus TCP to the broker on IPv4 loopback, and nothing else. */
export function modelProcessProfile(policy: { readTrees: readonly string[]; writeTrees: readonly string[] }, brokerPort: number):
  { profile: string; parameters: string[] } {
  if (!Number.isSafeInteger(brokerPort) || brokerPort < 1 || brokerPort > 65_535) throw new RangeError('Broker port out of range');
  const { profile, parameters } = seatbeltProfile(policy);
  // Seatbelt accepts only `*` or `localhost` as a network host; tcp4 keeps it to 127.0.0.1.
  return { profile: `${profile}\n(allow network-outbound (remote tcp4 "localhost:${brokerPort}"))`, parameters };
}

type Limits = { timeoutMs: number; maxStdoutBytes: number; maxStderrBytes: number };

export class SeatbeltModelProcessExecutor implements LiveModelProcessExecutor {
  readonly #settings: ModelProcessSettings;
  readonly #executor: ProcessExecutor;
  readonly #journal: EgressJournal;
  readonly #resolver: EgressResolver;
  readonly #dialer: EgressDialer | undefined;
  readonly #limits: Partial<BrokerLimits> | undefined;
  readonly #governance: GovernanceStoreIsolation;
  readonly #home: string;

  constructor(settings: ModelProcessSettings, dependencies: { executor: ProcessExecutor; egressJournal: EgressJournal; resolver: EgressResolver;
    governance: GovernanceStoreIsolation; dialer?: EgressDialer; brokerLimits?: Partial<BrokerLimits>; platform?: string; home?: string }) {
    const platform = dependencies.platform ?? process.platform;
    if (platform !== 'darwin' || !existsSync(SANDBOX_EXEC)) {
      throw new Error('Model process isolation (macOS Seatbelt) is unavailable on this host; live automation is not composed');
    }
    if (typeof settings.searchPath !== 'string' || !settings.searchPath.split(':').every((part) => isAbsolute(part) && !part.includes('\0'))) {
      throw new Error('Model process search path must list absolute directories only');
    }
    if (typeof dependencies.executor?.run !== 'function' || typeof dependencies.egressJournal?.open !== 'function' ||
        typeof dependencies.resolver?.resolve !== 'function') {
      throw new Error('Model process isolation requires a process executor, an egress journal, and a resolver');
    }
    // The boundary itself knows the protected governance roots; without them it is not built.
    if (!(dependencies.governance instanceof GovernanceStoreIsolation)) {
      throw new Error('Model process isolation requires the protected governance roots');
    }
    assertFixedSeatbeltTreesIsolated(dependencies.governance);
    for (const path of [...settings.runtimeReadPaths, ...searchPathDirectories(settings.searchPath)]) {
      dependencies.governance.assertDisjoint('model runtime path', path);
    }
    this.#governance = dependencies.governance;
    this.#settings = Object.freeze({ runtimeReadPaths: Object.freeze([...settings.runtimeReadPaths]), searchPath: settings.searchPath });
    this.#executor = dependencies.executor;
    this.#journal = dependencies.egressJournal;
    this.#resolver = dependencies.resolver;
    this.#dialer = dependencies.dialer;
    this.#limits = dependencies.brokerLimits && Object.freeze({ ...dependencies.brokerLimits });
    this.#home = realpathSync(dependencies.home ?? homedir());
    Object.freeze(this);
  }

  async runModel(request: ModelProcessRequest): Promise<ModelProcessOutcome> {
    const unavailable = (reason: string): ModelProcessOutcome => ({ isolation: 'UNAVAILABLE', reason: reason.slice(0, 600) });
    const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));
    // Steps 2-3: the pin and the exact scope, and every path, before anything is opened.
    let executable: string;
    let egress: readonly string[];
    let cwd: string;
    let policy: { readTrees: string[]; writeTrees: string[] };
    let temporary: string | undefined;
    try {
      if (typeof request.invocationId !== 'string' || !/^[0-9a-f]{64}$/.test(request.invocationId)) throw new Error('invalid invocation id');
      // The scope is one actor's; a request for the other actor carries none of its authority.
      if (!ACTOR_KINDS.includes(request.actorKind) || request.scope?.actorKind !== request.actorKind) throw new Error('scope does not bind the requesting actor');
      egress = parseEgressSet(request.scope?.egressDestinations);
      const refused = refusedModelEnvironmentName(request.env);
      if (refused) throw new Error(`environment variable ${refused} is owned or refused by the model process boundary`);
      executable = verifyPinnedExecutable(request.executable, request.executableSha256);
      const workspace = confinedPath(request.workspace.path, this.#home);
      if (!statSync(workspace).isDirectory()) throw new Error('model workspace is not a directory');
      cwd = realpathSync(request.cwd);
      if (!within(cwd, workspace)) throw new Error('model cwd is outside the model workspace');
      const writable = request.writablePaths.map((path) => confinedPath(path, this.#home));
      const readable = [...request.readOnlyPaths, ...this.#settings.runtimeReadPaths].map((path) => confinedPath(path, this.#home));
      temporary = realpathSync(mkdtempSync(join(tmpdir(), 'chief-model-')));
      confinedPath(temporary, this.#home);
      const readOnlyWorkspace = request.workspace.mode === 'READ_ONLY';
      if (!readOnlyWorkspace && request.workspace.mode !== 'READ_WRITE') throw new Error('unknown workspace mode');
      policy = { readTrees: [...new Set([executable, ...readable, ...(readOnlyWorkspace ? [workspace] : [])])],
        writeTrees: [...new Set([...(readOnlyWorkspace ? [] : [workspace]), ...writable, temporary])] };
      // G1-R4T-1: the effective policy of this invocation, checked again before the session, the
      // broker or the CLI exists.
      assertInvocationIsolated(this.#governance, 'model', { policy, cwd, searchPath: this.#settings.searchPath });
    } catch (error) {
      if (temporary) rmSync(temporary, { recursive: true, force: true });
      return unavailable(`model process isolation refused before anything ran: ${reason(error)}`);
    }

    // Steps 4-5: the durable session, then the broker bound to exactly its set.
    const sessionId = request.invocationId;
    try {
      this.#journal.open({ invocationId: sessionId, provider: request.scope.provider, model: request.scope.model, egressDestinations: [...egress] });
    } catch (error) {
      rmSync(temporary, { recursive: true, force: true });
      return unavailable(`egress session could not be opened: ${reason(error)}`);
    }
    let broker: ConnectBroker;
    try {
      broker = await ConnectBroker.start({ sessionId, allowlist: egress, journal: this.#journal, resolver: this.#resolver,
        ...(this.#dialer ? { dialer: this.#dialer } : {}), ...(this.#limits ? { limits: this.#limits } : {}) });
    } catch (error) {
      this.#closeSession(sessionId);
      rmSync(temporary, { recursive: true, force: true });
      return unavailable(`egress broker could not start on loopback: ${reason(error)}`);
    }

    // Steps 6-7: the profile for this broker port, proven to apply, then the pin once more, then the CLI.
    const { profile, parameters } = modelProcessProfile(policy, broker.port);
    const env = { ...request.env, PATH: this.#settings.searchPath, HOME: temporary, TMPDIR: temporary, ...proxyEnvironment(broker.port) };
    const sandboxed = (file: string, args: readonly string[], limits: Limits, stdin?: string) =>
      this.#executor.run({ executable: SANDBOX_EXEC, args: [...parameters, '-p', profile, '--', file, ...args], cwd, env, ...limits,
        ...(stdin === undefined ? {} : { stdin }) });
    let result: ProcessResult;
    let closeFault = false;
    try {
      // An early return still passes through the shutdown below; nothing has reached the CLI.
      const probe = await sandboxed('/usr/bin/true', [], { timeoutMs: 30_000, maxStdoutBytes: 65_536, maxStderrBytes: 65_536 });
      if (!succeeded(probe)) return unavailable(`the model process Seatbelt profile could not be applied: ${summary(probe)}`);
      try { verifyPinnedExecutable(executable, request.executableSha256); } catch (error) { return unavailable(reason(error)); }
      result = await sandboxed(executable, request.args, { timeoutMs: request.timeoutMs, maxStdoutBytes: request.maxStdoutBytes,
        maxStderrBytes: request.maxStderrBytes }, request.stdin);
    } finally {
      // Steps 9-11: no new connections, open tunnels closed, the session closed. Always.
      closeFault = !(await this.#shutdown(broker, sessionId));
      rmSync(temporary, { recursive: true, force: true });
    }
    // Step 12: the evidence is what the journal holds, read back and validated.
    return { isolation: 'ENFORCED', result, egress: this.#evidence(sessionId, broker.faults, closeFault) };
  }

  /** Stops the broker and closes the session. False when the session could not be closed. */
  async #shutdown(broker: ConnectBroker, sessionId: string): Promise<boolean> {
    broker.stopAccepting();
    await broker.close();
    return this.#closeSession(sessionId);
  }

  #closeSession(sessionId: string): boolean {
    try {
      if (this.#journal.get(sessionId)?.state === 'OPEN') this.#journal.close(sessionId);
      return true;
    } catch {
      return false;
    }
  }

  #evidence(sessionId: string, faults: number, closeFault: boolean): EgressEvidence {
    if (faults > 0) return { status: 'AMBIGUOUS', reason: `the broker could not record ${faults} connection decision(s)` };
    if (closeFault) return { status: 'AMBIGUOUS', reason: 'the egress session could not be closed' };
    try {
      const session = this.#journal.get(sessionId);
      if (!session) return { status: 'AMBIGUOUS', reason: 'the egress session is missing' };
      if (session.state !== 'CLOSED') return { status: 'AMBIGUOUS', reason: 'the egress session is not closed' };
      return { status: 'RECORDED', summary: summarizeEgress(session) };
    } catch (error) {
      return { status: 'AMBIGUOUS', reason: `the egress journal is unreadable: ${error instanceof Error ? error.message : 'error'}` };
    }
  }
}
Object.freeze(SeatbeltModelProcessExecutor);
Object.freeze(SeatbeltModelProcessExecutor.prototype);
