import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { AutomationController } from '../controller.js';
import { FileControllerStore } from '../durable-store.js';
import { isCanonicalEgressSet } from '../egress-destination.js';
import { FileEgressJournal } from '../file-egress-journal.js';
import { FileInvocationJournal } from '../file-invocation-journal.js';
import { GovernanceStoreIsolation } from '../governance-store-isolation.js';
import {
  NodeProcessExecutor, SyncNodeProcessExecutor, environmentFromAllowlist, type ProcessExecutor, type SyncProcessExecutor,
} from '../process-executor.js';
import { AutomationRunner } from '../runner.js';
import type { OfflineValidationExecutor } from '../offline-validation.js';
import type { Clock } from '../types.js';
import { ClaudeCodeImplementationAdapter } from './claude-code-implementation.js';
import { CodexArchitectReviewAdapter } from './codex-architect-review.js';
import { assertExactModel } from './common.js';
import { PublicAddressResolver } from './connect-broker.js';
import { GitHubCliRepositoryRealityPort } from './github-cli-reality.js';
import type { LiveModelProcessExecutor } from './model-process-isolation.js';
import { SeatbeltModelProcessExecutor } from './seatbelt-model-process.js';
import { SeatbeltOfflineValidationExecutor, assertFixedSeatbeltTreesIsolated, searchPathDirectories } from './seatbelt-validation.js';

// Wires the live automation: durable controller store, invocation journal, controller,
// runner, the two agent adapters, and GitHub reality. Importing this module starts
// nothing, and so does composing it: no process, model call, network read, or write
// happens until a caller steps a run. Every live field is explicit; there are no
// model defaults, no fallback models, and no configuration field that holds a secret.
// Offline validation runs only behind the macOS Seatbelt boundary, and each model CLI
// only behind the egress-bound model process boundary (Seatbelt confined to a loopback
// CONNECT broker that enforces the actor's exact egress set, with a pinned executable);
// where either boundary is unavailable, nothing is composed. The broker's resolver is
// the public-address resolver; nothing in this configuration can replace it.
//
// G1-R4T-1/CM1: the Controller store, Authority Archive, and Change Registry are protected governance roots.
// Before anything is constructed, all must already exist as safe, mutually disjoint
// directories, and none may overlap any path an agent, a model process or generated
// code can see (see agentVisiblePaths). The archive root is named here only so it can be
// protected: no archive reader or appender is opened. No Change Mint capability is opened.
// Both Seatbelt boundaries receive
// the roots and check every invocation's effective paths again.

const exact = z.string().min(1).refine((value) => value.trim() === value && !value.includes('\0'));
const absolute = exact.refine(isAbsolute, 'must be an absolute path');
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const egressSet = z.array(z.string()).refine((set) => isCanonicalEgressSet(set), 'egress destinations must be a sorted, unique, non-empty set of canonical hostname:port values');
const positive = (max: number) => z.number().int().positive().max(max);
const MINUTE = 60_000;
const MB = 1024 * 1024;

const configSchema = z.strictObject({
  repository: z.string().regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/),
  controllerStoreDirectory: absolute,
  /** Protected, never opened by the live composition (G1-R4T-1). */
  authorityArchiveDirectory: absolute,
  /** Protected only. No registry reader or minter is opened by this composition. */
  changeRegistryDirectory: absolute,
  journalDirectory: absolute,
  egressJournalDirectory: absolute,
  environment: z.strictObject({ allow: z.array(z.string()).max(64) }),
  claude: z.strictObject({ executable: absolute, executableSha256: sha256, provider: exact, model: exact, egressDestinations: egressSet,
    timeoutMs: positive(6 * 60 * MINUTE), maxTurns: positive(500), maxStdoutBytes: positive(64 * MB), maxStderrBytes: positive(64 * MB) }),
  codex: z.strictObject({ executable: absolute, executableSha256: sha256, provider: exact, model: exact, egressDestinations: egressSet,
    timeoutMs: positive(6 * 60 * MINUTE),
    maxStdoutBytes: positive(64 * MB), maxStderrBytes: positive(64 * MB), maxResultBytes: positive(4 * MB),
    disabledFeatures: z.array(z.string().regex(/^[a-z0-9_.]+$/)).max(64) }),
  git: z.strictObject({ executable: exact, remote: exact, repositoryPath: absolute, worktreeRoot: absolute,
    timeoutMs: positive(60 * MINUTE), maxOutputBytes: positive(64 * MB), commitAuthor: z.strictObject({ name: exact, email: exact }),
    validationTimeoutMs: positive(6 * 60 * MINUTE), validationMaxOutputBytes: positive(64 * MB),
    linkedDirectories: z.array(z.strictObject({ path: z.string().regex(/^[A-Za-z0-9._-]+$/), source: absolute })).max(8) }),
  /** Runtime paths (e.g. a developer toolchain) readable inside the validation sandbox, and the PATH it uses. */
  offlineValidation: z.strictObject({ runtimeReadPaths: z.array(absolute).max(16), searchPath: exact }),
  /** Runtime paths the model CLIs read inside their sandbox (their installations), and the PATH they use. */
  modelProcess: z.strictObject({ runtimeReadPaths: z.array(absolute).max(16), searchPath: exact }),
  github: z.strictObject({ executable: exact, workflowName: exact, requiredCheckName: exact, requiredCheckAppId: z.number().int().positive().optional(),
    timeoutMs: positive(10 * MINUTE), maxOutputBytes: positive(64 * MB), maxObservationAgeMs: positive(10 * MINUTE) }),
  /** Caller-supplied HUMAN grants for LIVE_PROVIDER_MODEL_CALL, per actor. Validated by the existing policy at each dispatch. */
  liveCallAuthorizations: z.strictObject({ IMPLEMENTATION: z.unknown().optional(), ARCHITECT_REVIEW: z.unknown().optional() }),
});
export type LiveAutomationConfig = z.infer<typeof configSchema>;

// Non-secret settings that keep the CLIs from waiting on a terminal that is not there.
const FIXED_ENVIRONMENT = Object.freeze({ GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', NO_COLOR: '1' });

export interface LiveAutomation {
  controller: AutomationController;
  runner: AutomationRunner;
  journal: FileInvocationJournal;
  egressJournal: FileEgressJournal;
  reality: GitHubCliRepositoryRealityPort;
}

/**
 * Every configured path that can become visible to the Claude implementation process, the
 * Codex review process, offline validation or model-generated code, plus the operational
 * journals, which may not share a governance root either.
 */
function agentVisiblePaths(config: LiveAutomationConfig): Array<[string, string]> {
  return [
    ['git.repositoryPath', config.git.repositoryPath],
    ['git.worktreeRoot', config.git.worktreeRoot],
    ...config.git.linkedDirectories.map((link): [string, string] => [`git.linkedDirectories[${link.path}].source`, link.source]),
    ...config.offlineValidation.runtimeReadPaths.map((path, index): [string, string] => [`offlineValidation.runtimeReadPaths[${index}]`, path]),
    ...searchPathDirectories(config.offlineValidation.searchPath).map((path, index): [string, string] => [`offlineValidation.searchPath[${index}]`, path]),
    ...config.modelProcess.runtimeReadPaths.map((path, index): [string, string] => [`modelProcess.runtimeReadPaths[${index}]`, path]),
    ...searchPathDirectories(config.modelProcess.searchPath).map((path, index): [string, string] => [`modelProcess.searchPath[${index}]`, path]),
    ['claude.executable', config.claude.executable],
    ['codex.executable', config.codex.executable],
    ['journalDirectory', config.journalDirectory],
    ['egressJournalDirectory', config.egressJournalDirectory],
  ];
}

export function createLiveAutomation(input: unknown, dependencies: { clock?: Clock; environmentSource?: Readonly<Record<string, string | undefined>>;
  executor?: ProcessExecutor; syncExecutor?: SyncProcessExecutor; offlineValidation?: OfflineValidationExecutor;
  modelProcess?: LiveModelProcessExecutor; platform?: string } = {}): Readonly<LiveAutomation> {
  const config = configSchema.parse(input);
  assertExactModel(config.claude.model);
  assertExactModel(config.codex.model);
  // Nothing has been created yet: an unsafe configuration is refused untouched.
  const governance = GovernanceStoreIsolation.forLiveRoots(config);
  for (const [label, path] of agentVisiblePaths(config)) governance.assertDisjoint(label, path);
  assertFixedSeatbeltTreesIsolated(governance);
  const clock: Clock = dependencies.clock ?? Object.freeze({ now: () => new Date().toISOString() });
  const environment = Object.freeze({ ...environmentFromAllowlist(dependencies.environmentSource ?? process.env, config.environment.allow),
    ...FIXED_ENVIRONMENT });
  const executor = dependencies.executor ?? new NodeProcessExecutor();
  const syncExecutor = dependencies.syncExecutor ?? new SyncNodeProcessExecutor();
  const validation = dependencies.offlineValidation ?? new SeatbeltOfflineValidationExecutor(config.offlineValidation,
    { executor, governance, platform: dependencies.platform });
  const egressJournal = new FileEgressJournal(config.egressJournalDirectory, clock);
  const model = dependencies.modelProcess ?? new SeatbeltModelProcessExecutor(config.modelProcess,
    { executor, egressJournal, resolver: new PublicAddressResolver(), governance, platform: dependencies.platform });

  const journal = new FileInvocationJournal(config.journalDirectory, clock);
  const reality = new GitHubCliRepositoryRealityPort({ ...config.github, repository: config.repository,
    workingDirectory: config.git.repositoryPath }, { executor: syncExecutor, clock, environment });
  const controller = new AutomationController(clock, new FileControllerStore(config.controllerStoreDirectory, clock), reality);
  const gitSettings = { executable: config.git.executable, remote: config.git.remote, repositoryPath: config.git.repositoryPath,
    worktreeRoot: config.git.worktreeRoot, timeoutMs: config.git.timeoutMs, maxOutputBytes: config.git.maxOutputBytes };
  const implementation = new ClaudeCodeImplementationAdapter({ claude: config.claude, git: { ...gitSettings,
    commitAuthor: config.git.commitAuthor, validationTimeoutMs: config.git.validationTimeoutMs,
    validationMaxOutputBytes: config.git.validationMaxOutputBytes, linkedDirectories: config.git.linkedDirectories }, environment },
  { executor, model, validation, journal, clock });
  const review = new CodexArchitectReviewAdapter({ codex: config.codex, git: gitSettings, environment }, { executor, model, journal, clock });
  const runner = new AutomationRunner(controller, implementation, review, {
    journal, clock, authorizations: config.liveCallAuthorizations,
    scopes: { IMPLEMENTATION: implementation.scope, ARCHITECT_REVIEW: review.scope },
    // The controller refuses facts observed after its decision instant, so the one
    // fact the runner's controller calls read is observed immediately before them.
    observeRepository: (run) => reality.primeBranch(run.repository, run.activePacket!.targetBranch),
  });
  return Object.freeze({ controller, runner, journal, egressJournal, reality });
}
