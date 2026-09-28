import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { AutomationController } from '../controller.js';
import { FileControllerStore } from '../durable-store.js';
import { FileInvocationJournal } from '../file-invocation-journal.js';
import {
  NodeProcessExecutor, SyncNodeProcessExecutor, environmentFromAllowlist, type ProcessExecutor, type SyncProcessExecutor,
} from '../process-executor.js';
import { AutomationRunner } from '../runner.js';
import type { OfflineValidationExecutor } from '../offline-validation.js';
import type { Clock } from '../types.js';
import { ClaudeCodeImplementationAdapter } from './claude-code-implementation.js';
import { CodexArchitectReviewAdapter } from './codex-architect-review.js';
import { assertExactModel } from './common.js';
import { GitHubCliRepositoryRealityPort } from './github-cli-reality.js';
import { SeatbeltOfflineValidationExecutor } from './seatbelt-validation.js';

// Wires the live automation: durable controller store, invocation journal, controller,
// runner, the two agent adapters, and GitHub reality. Importing this module starts
// nothing, and so does composing it: no process, model call, network read, or write
// happens until a caller steps a run. Every live field is explicit; there are no
// model defaults, no fallback models, and no configuration field that holds a secret.
// Offline validation runs only behind the macOS Seatbelt boundary; where that boundary
// is unavailable, nothing is composed.

const exact = z.string().min(1).refine((value) => value.trim() === value && !value.includes('\0'));
const absolute = exact.refine(isAbsolute, 'must be an absolute path');
const positive = (max: number) => z.number().int().positive().max(max);
const MINUTE = 60_000;
const MB = 1024 * 1024;

const configSchema = z.strictObject({
  repository: z.string().regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/),
  controllerStoreDirectory: absolute,
  journalDirectory: absolute,
  environment: z.strictObject({ allow: z.array(z.string()).max(64) }),
  claude: z.strictObject({ executable: exact, provider: exact, model: exact, destination: exact,
    timeoutMs: positive(6 * 60 * MINUTE), maxTurns: positive(500), maxStdoutBytes: positive(64 * MB), maxStderrBytes: positive(64 * MB) }),
  codex: z.strictObject({ executable: exact, provider: exact, model: exact, destination: exact, timeoutMs: positive(6 * 60 * MINUTE),
    maxStdoutBytes: positive(64 * MB), maxStderrBytes: positive(64 * MB), maxResultBytes: positive(4 * MB),
    disabledFeatures: z.array(z.string().regex(/^[a-z0-9_.]+$/)).max(64) }),
  git: z.strictObject({ executable: exact, remote: exact, repositoryPath: absolute, worktreeRoot: absolute,
    timeoutMs: positive(60 * MINUTE), maxOutputBytes: positive(64 * MB), commitAuthor: z.strictObject({ name: exact, email: exact }),
    validationTimeoutMs: positive(6 * 60 * MINUTE), validationMaxOutputBytes: positive(64 * MB),
    linkedDirectories: z.array(z.strictObject({ path: z.string().regex(/^[A-Za-z0-9._-]+$/), source: absolute })).max(8) }),
  /** Runtime paths (e.g. a developer toolchain) readable inside the validation sandbox, and the PATH it uses. */
  offlineValidation: z.strictObject({ runtimeReadPaths: z.array(absolute).max(16), searchPath: exact }),
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
  reality: GitHubCliRepositoryRealityPort;
}

export function createLiveAutomation(input: unknown, dependencies: { clock?: Clock; environmentSource?: Readonly<Record<string, string | undefined>>;
  executor?: ProcessExecutor; syncExecutor?: SyncProcessExecutor; offlineValidation?: OfflineValidationExecutor; platform?: string } = {}):
  Readonly<LiveAutomation> {
  const config = configSchema.parse(input);
  assertExactModel(config.claude.model);
  assertExactModel(config.codex.model);
  const clock: Clock = dependencies.clock ?? Object.freeze({ now: () => new Date().toISOString() });
  const environment = Object.freeze({ ...environmentFromAllowlist(dependencies.environmentSource ?? process.env, config.environment.allow),
    ...FIXED_ENVIRONMENT });
  const executor = dependencies.executor ?? new NodeProcessExecutor();
  const syncExecutor = dependencies.syncExecutor ?? new SyncNodeProcessExecutor();
  const validation = dependencies.offlineValidation ?? new SeatbeltOfflineValidationExecutor(config.offlineValidation,
    { executor, platform: dependencies.platform });

  const journal = new FileInvocationJournal(config.journalDirectory, clock);
  const reality = new GitHubCliRepositoryRealityPort({ ...config.github, repository: config.repository,
    workingDirectory: config.git.repositoryPath }, { executor: syncExecutor, clock, environment });
  const controller = new AutomationController(clock, new FileControllerStore(config.controllerStoreDirectory), reality);
  const gitSettings = { executable: config.git.executable, remote: config.git.remote, repositoryPath: config.git.repositoryPath,
    worktreeRoot: config.git.worktreeRoot, timeoutMs: config.git.timeoutMs, maxOutputBytes: config.git.maxOutputBytes };
  const implementation = new ClaudeCodeImplementationAdapter({ claude: config.claude, git: { ...gitSettings,
    commitAuthor: config.git.commitAuthor, validationTimeoutMs: config.git.validationTimeoutMs,
    validationMaxOutputBytes: config.git.validationMaxOutputBytes, linkedDirectories: config.git.linkedDirectories }, environment },
  { executor, validation, journal, clock });
  const review = new CodexArchitectReviewAdapter({ codex: config.codex, git: gitSettings, environment }, { executor, journal, clock });
  const runner = new AutomationRunner(controller, implementation, review, {
    journal, clock, authorizations: config.liveCallAuthorizations,
    scopes: { IMPLEMENTATION: implementation.scope, ARCHITECT_REVIEW: review.scope },
    // The controller refuses facts observed after its decision instant, so the one
    // fact the runner's controller calls read is observed immediately before them.
    observeRepository: (run) => reality.primeBranch(run.repository, run.activePacket!.targetBranch),
  });
  return Object.freeze({ controller, runner, journal, reality });
}
