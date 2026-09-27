import { symlinkSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { IMPLEMENTATION_ACTOR, type ImplementationAgentPort, type ImplementationInput, type ImplementationResult } from '../bridge.js';
import type { InvocationJournal } from '../invocation-journal.js';
import { evaluatePolicy } from '../policy.js';
import type { ProcessExecutor } from '../process-executor.js';
import type { Clock, ImplementationPacket, ProviderCallScope, ValidationCommand } from '../types.js';
import {
  assertExactModel, checkScope, git, remoteBranchSha, requireStartedInvocation, stagedEntries, statusPaths, succeeded, summary,
  type GitSettings,
} from './common.js';

// Claude Code as the implementation agent, run non-interactively in an isolated
// worktree with a restricted tool set. Claude's own report is advisory: this adapter
// checks scope, runs the packet's validation, commits, and pushes the exact work branch
// itself. It never pushes anything else, never forces, and never reports a SHA as
// authority; the controller reads the pushed SHA from repository reality.

export interface ClaudeCodeSettings {
  executable: string;
  provider: string;
  model: string;
  destination: string;
  timeoutMs: number;
  maxTurns: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  /** Pre-approve Bash for exactly the packet's offline validation commands, and nothing else. */
  exposeValidationCommands: boolean;
}
export interface DeliverySettings extends GitSettings {
  commitAuthor: { name: string; email: string };
  validationTimeoutMs: number;
  validationMaxOutputBytes: number;
  /** Directories (e.g. node_modules) linked into each worktree so validation can run offline. */
  linkedDirectories: Array<{ path: string; source: string }>;
}

const REPORT_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['status', 'reason'],
  properties: {
    status: { type: 'string', enum: ['COMPLETED', 'SOFT_STOP', 'ARCHITECTURE_STOP', 'HUMAN_STOP'] },
    reason: { type: 'string' },
  },
});
const reportSchema = z.strictObject({ status: z.enum(['COMPLETED', 'SOFT_STOP', 'ARCHITECTURE_STOP', 'HUMAN_STOP']),
  reason: z.string().trim().min(1).max(2000) });
const SAFE_TOKEN = /^[A-Za-z0-9._/:=@+-]+$/;
const FILE_TOOLS = Object.freeze(['Read', 'Glob', 'Grep', 'Edit', 'Write']);

/** Exact Bash rules for the packet's offline validation commands that are safe to express as one plain command line. */
export function validationBashRules(packet: ImplementationPacket): string[] {
  return packet.validationCommands
    .filter((command) => command.classification === 'OFFLINE_VALIDATION' && command.cwd === '.' &&
      [command.executable, ...command.args].every((token) => SAFE_TOKEN.test(token)))
    .map((command) => `Bash(${[command.executable, ...command.args].join(' ')})`);
}

/**
 * The complete Claude Code argv. Non-interactive JSON output with a report schema; the
 * exact model and a turn limit; restricted mode (settings files ignored, file tools
 * confined to the worktree, bypass refused); nobody answers permission prompts, so
 * anything not pre-approved is denied; no session persistence, MCP servers, skills, or
 * browser. The tool set is the file tools, plus Bash only when exact validation
 * commands are pre-approved. There is no permission bypass and no fallback model.
 */
export function claudeArguments(settings: ClaudeCodeSettings, packet: ImplementationPacket): string[] {
  const bashRules = settings.exposeValidationCommands ? validationBashRules(packet) : [];
  const tools = bashRules.length ? [...FILE_TOOLS, 'Bash'] : [...FILE_TOOLS];
  return ['-p', '--output-format', 'json', '--model', assertExactModel(settings.model), '--max-turns', String(settings.maxTurns),
    '--restricted', '--permission-prompts', 'none', '--permission-mode', 'acceptEdits', '--no-session-persistence',
    '--strict-mcp-config', '--disable-slash-commands', '--no-chrome',
    '--tools', tools.join(','), '--allowedTools', [...FILE_TOOLS, ...bashRules].join(','),
    '--disallowedTools', 'WebFetch,WebSearch', '--json-schema', JSON.stringify(REPORT_SCHEMA)];
}

function prompt(input: ImplementationInput): string {
  const packet = input.packet;
  const lines = [
    `You are the implementation agent for CHIEF packet ${packet.packetId} (version ${packet.packetVersion}), implementation iteration ${input.implementationIteration}.`,
    'The current directory is a Git worktree at the base commit the controller chose. Work only inside it.',
    `Objective: ${packet.objective}`,
    `Allowed areas (change only paths inside these): ${JSON.stringify(packet.allowedAreas)}`,
    `Forbidden changes: ${JSON.stringify(packet.forbiddenChanges)}`,
    `Invariants that must still hold: ${JSON.stringify(packet.invariants)}`,
    `Acceptance criteria: ${JSON.stringify(packet.acceptanceCriteria)}`,
    `Validation commands (argv; run only these, exactly): ${JSON.stringify(packet.validationCommands.map((command) => [command.executable, ...command.args]))}`,
  ];
  if (input.correction) {
    lines.push(`This iteration answers a rejection of ${input.correction.rejectedSha}.`,
      `Reviewer findings to address: ${JSON.stringify(input.correction.reviewerFindings)}`,
      `Allowed correction areas: ${JSON.stringify(input.correction.allowedCorrectionAreas)}`);
  }
  lines.push('Rules: do not commit, push, create or switch branches, or change Git configuration; the adapter delivers your changes.',
    'Do not read or print credentials or files outside this directory, and do not use the network.',
    'Finish with status COMPLETED, or the stop class that applies (SOFT_STOP: a defect you could not fix within scope;',
    'ARCHITECTURE_STOP: the packet conflicts with the repository or needs more scope; HUMAN_STOP: a human decision is required), with a short reason.',
    'Your report is advisory. The adapter checks scope and runs validation itself.');
  return `${lines.join('\n')}\n`;
}

type Stop = Exclude<ImplementationResult, { status: 'COMPLETED' }>;
const stop = (status: Stop['status'], reason: string): Stop => ({ status, reason: reason.slice(0, 2000) });

/** Claude's report from its JSON result, or why it is unusable. Model substitution is refused where the result shows it. */
function readReport(stdout: string, model: string): z.infer<typeof reportSchema> | string {
  let result: Record<string, unknown>;
  try { result = JSON.parse(stdout); } catch { return 'Claude Code output is not JSON'; }
  if (!result || typeof result !== 'object' || result.type !== 'result') return 'Claude Code output is not a result';
  if (result.is_error !== false || result.subtype !== 'success') return `Claude Code run did not succeed (${String(result.subtype)})`;
  const usage = result.modelUsage;
  if (usage && typeof usage === 'object' && !Object.hasOwn(usage, model)) return 'Claude Code result does not show the configured model';
  let report: unknown = result.structured_output;
  if (report === undefined && typeof result.result === 'string') {
    try { report = JSON.parse(result.result); } catch { report = undefined; }
  }
  const parsed = reportSchema.safeParse(report);
  return parsed.success ? parsed.data : 'Claude Code report does not match its schema';
}

export class ClaudeCodeImplementationAdapter implements ImplementationAgentPort {
  readonly #claude: ClaudeCodeSettings;
  readonly #git: DeliverySettings;
  readonly #env: Record<string, string>;
  readonly #executor: ProcessExecutor;
  readonly #journal: InvocationJournal;
  readonly #clock: Clock;

  constructor(settings: { claude: ClaudeCodeSettings; git: DeliverySettings; environment: Record<string, string> },
    dependencies: { executor: ProcessExecutor; journal: InvocationJournal; clock: Clock }) {
    assertExactModel(settings.claude.model);
    if (!Number.isSafeInteger(settings.claude.maxTurns) || settings.claude.maxTurns < 1 || settings.claude.maxTurns > 500) {
      throw new Error('Claude maxTurns must be a bounded positive integer');
    }
    for (const link of settings.git.linkedDirectories) {
      if (!/^[A-Za-z0-9._-]+$/.test(link.path) || link.path === '.git' || !isAbsolute(link.source)) throw new Error('Invalid linked directory');
    }
    this.#claude = Object.freeze({ ...settings.claude });
    this.#git = Object.freeze({ ...settings.git, commitAuthor: Object.freeze({ ...settings.git.commitAuthor }),
      linkedDirectories: Object.freeze(settings.git.linkedDirectories.map((link) => Object.freeze({ ...link }))) as DeliverySettings['linkedDirectories'] });
    this.#env = Object.freeze({ ...settings.environment });
    this.#executor = dependencies.executor;
    this.#journal = dependencies.journal;
    this.#clock = dependencies.clock;
    Object.freeze(this);
  }

  get scope(): ProviderCallScope {
    return { provider: this.#claude.provider, model: this.#claude.model, destination: this.#claude.destination };
  }

  async execute(input: Readonly<ImplementationInput>): Promise<ImplementationResult> {
    const invocation = requireStartedInvocation(this.#journal, input, 'IMPLEMENTATION', this.scope);
    const packet = input.packet;
    const branch = packet.targetBranch;
    if (!/^work\/[A-Za-z0-9._/-]+$/.test(branch) || branch.includes('..')) throw new Error('Target branch is not a work branch');
    const correction = input.correction;
    const base = correction ? correction.rejectedSha : packet.expectedBaseSha;
    const expectedRemote = correction ? correction.rejectedSha : null;
    const settings = this.#git;
    const env = this.#env;
    const refused = this.#authorizeDelivery(input, correction === undefined);
    if (refused) return refused;

    // The branch must be where the controller left it before any model call is spent.
    const before = await remoteBranchSha(this.#executor, settings, env, branch);
    if (before !== expectedRemote) return stop('ARCHITECTURE_STOP', `work branch ${branch} moved before implementation`);
    const fetched = await git(this.#executor, settings, env, settings.repositoryPath, ['fetch', '--no-tags', settings.remote, base]);
    if (!succeeded(fetched)) return stop('HUMAN_STOP', `could not fetch base ${base}: ${summary(fetched)}`);
    const worktree = join(settings.worktreeRoot, invocation.invocationId);
    const added = await git(this.#executor, settings, env, settings.repositoryPath, ['worktree', 'add', '--detach', worktree, base]);
    if (!succeeded(added)) return stop('HUMAN_STOP', `could not create worktree: ${summary(added)}`);
    for (const link of settings.linkedDirectories) symlinkSync(link.source, join(worktree, link.path), 'dir');

    const run = await this.#executor.run({ executable: this.#claude.executable, args: claudeArguments(this.#claude, packet),
      cwd: worktree, env, timeoutMs: this.#claude.timeoutMs, maxStdoutBytes: this.#claude.maxStdoutBytes,
      maxStderrBytes: this.#claude.maxStderrBytes, stdin: prompt(input) });
    if (!succeeded(run)) return stop('HUMAN_STOP', `Claude Code run failed: ${summary(run)}`);
    const report = readReport(run.stdout, this.#claude.model);
    if (typeof report === 'string') return stop('HUMAN_STOP', report);
    if (report.status !== 'COMPLETED') return stop(report.status, `implementer reported: ${report.reason}`);
    return this.#deliver(input, worktree, expectedRemote, report.reason);
  }

  async #deliver(input: Readonly<ImplementationInput>, worktree: string, expectedRemote: string | null, reported: string):
    Promise<ImplementationResult> {
    const packet = input.packet;
    const branch = packet.targetBranch;
    const settings = this.#git;
    const env = this.#env;
    const run = (args: string[]) => git(this.#executor, settings, env, worktree, args);
    const scoped = (paths: string[]): Stop | undefined => {
      const verdict = checkScope(paths, correctionAreas(input) ?? packet.allowedAreas, packet.forbiddenChanges);
      return verdict.ok ? undefined : stop(verdict.protectedPath ? 'HUMAN_STOP' : 'ARCHITECTURE_STOP', `scope violation: ${verdict.reason}`);
    };

    const status = await run(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (!succeeded(status)) return stop('HUMAN_STOP', `could not inspect the worktree: ${summary(status)}`);
    const changed = statusPaths(status.stdout);
    if (changed.length === 0) return stop('SOFT_STOP', 'implementation produced no changes');
    const outside = scoped(changed);
    if (outside) return outside;

    const evidence: string[] = [`changed paths inside packet scope: ${changed.length}`];
    for (const command of packet.validationCommands) {
      const verdict = this.#authorizeValidation(input, command);
      if (verdict) return verdict;
      const result = await this.#executor.run({ executable: command.executable, args: [...command.args],
        cwd: command.cwd === '.' ? worktree : join(worktree, command.cwd), env, timeoutMs: settings.validationTimeoutMs,
        maxStdoutBytes: settings.validationMaxOutputBytes, maxStderrBytes: settings.validationMaxOutputBytes });
      if (!succeeded(result)) return stop('SOFT_STOP', `validation ${command.commandId} failed: ${summary(result)}`);
      evidence.push(`validation ${command.commandId}: exit 0`);
    }

    const staged = await run(['add', '-A']);
    if (!succeeded(staged)) return stop('HUMAN_STOP', `could not stage changes: ${summary(staged)}`);
    const raw = await run(['diff', '--cached', '--raw', '-z', '--no-renames']);
    if (!succeeded(raw)) return stop('HUMAN_STOP', `could not inspect staged changes: ${summary(raw)}`);
    const entries = stagedEntries(raw.stdout);
    const link = entries.find((entry) => entry.status !== 'D' && (entry.mode === '120000' || entry.mode === '160000'));
    if (link) return stop('HUMAN_STOP', `staged ${link.mode === '120000' ? 'symlink' : 'gitlink'} ${link.path}`);
    const stagedOutside = scoped(entries.map((entry) => entry.path));
    if (stagedOutside) return stagedOutside;
    const check = await run(['diff', '--cached', '--check']);
    if (!succeeded(check)) return stop('SOFT_STOP', `git diff --check failed: ${summary(check)}`);
    evidence.push('git diff --cached --check: pass');

    const author = settings.commitAuthor;
    const committed = await run(['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`, '-c', 'commit.gpgsign=false',
      'commit', '--no-verify', '-m', `CHIEF ${packet.packetId} iteration ${input.implementationIteration}`,
      '-m', `Invocation: ${input.invocationId}`]);
    if (!succeeded(committed)) return stop('HUMAN_STOP', `could not commit: ${summary(committed)}`);
    const head = await run(['rev-parse', 'HEAD']);
    const local = head.stdout.trim();
    if (!succeeded(head) || !/^[0-9a-f]{40}$/.test(local)) return stop('HUMAN_STOP', 'could not read the local commit');

    // Immediately before the push: the remote branch must still be where it was.
    const remoteBefore = await remoteBranchSha(this.#executor, settings, env, branch);
    if (remoteBefore !== expectedRemote) return stop('ARCHITECTURE_STOP', `work branch ${branch} moved before push`);
    const pushed = await run(['push', '--no-verify', settings.remote, `HEAD:refs/heads/${branch}`]);
    // Whatever git said, the remote is read back. Only an exact answer is an answer.
    const remoteAfter = await remoteBranchSha(this.#executor, settings, env, branch);
    if (remoteAfter === local) {
      evidence.push(`delivered to ${branch} without force (remote was ${expectedRemote === null ? 'absent' : 'the rejected SHA'})`);
      evidence.push(`implementer report (advisory): ${reported}`.slice(0, 2000));
      return { status: 'COMPLETED', validationEvidence: evidence };
    }
    if (remoteAfter === expectedRemote) return stop('HUMAN_STOP', `push did not land: ${summary(pushed)}`);
    throw new Error(`Work branch ${branch} is at an unexpected SHA after push; the delivery outcome is uncertain`);
  }

  /** Commit and push (and, on a first iteration, branch creation) are the packet's to grant under the existing policy. Checked before any model call. */
  #authorizeDelivery(input: Readonly<ImplementationInput>, first: boolean): Stop | undefined {
    const operations = first ? ['CREATE_WORK_BRANCH', 'COMMIT_WORK_BRANCH', 'PUSH_WORK_BRANCH'] : ['COMMIT_WORK_BRANCH', 'PUSH_WORK_BRANCH'];
    for (const operation of operations) {
      const verdict = evaluatePolicy({ operation, target: input.packet.targetBranch, actor: IMPLEMENTATION_ACTOR,
        packet: input.packet as ImplementationPacket, runId: input.runId, now: this.#clock.now(), resourceClassification: 'ORDINARY' });
      if (verdict.decision !== 'AUTHORIZED') return stop('ARCHITECTURE_STOP', `${operation} not granted by the packet: ${verdict.reason}`);
    }
    return undefined;
  }

  /** Validation runs only as the existing policy's packet-bound offline command, never as an arbitrary program. */
  #authorizeValidation(input: Readonly<ImplementationInput>, command: ValidationCommand): Stop | undefined {
    const verdict = evaluatePolicy({ operation: 'RUN_OFFLINE_VALIDATION', target: command.commandId, actor: IMPLEMENTATION_ACTOR,
      packet: input.packet as ImplementationPacket, runId: input.runId, now: this.#clock.now(),
      command: { executable: command.executable, args: [...command.args], cwd: command.cwd } });
    return verdict.decision === 'AUTHORIZED' ? undefined : stop('ARCHITECTURE_STOP', `validation ${command.commandId} not runnable: ${verdict.reason}`);
  }
}
Object.freeze(ClaudeCodeImplementationAdapter);
Object.freeze(ClaudeCodeImplementationAdapter.prototype);

/** A correction iteration may change only its allowed correction areas. */
function correctionAreas(input: Readonly<ImplementationInput>): readonly string[] | undefined {
  return input.correction?.allowedCorrectionAreas;
}
