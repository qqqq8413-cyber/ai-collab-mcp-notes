import { createHash } from 'node:crypto';
import {
  chmodSync, constants, copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, statSync, symlinkSync, unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { IMPLEMENTATION_ACTOR, type ImplementationAgentPort, type ImplementationInput, type ImplementationResult } from '../bridge.js';
import type { InvocationJournal } from '../invocation-journal.js';
import type { OfflineValidationExecutor } from '../offline-validation.js';
import { evaluatePolicy } from '../policy.js';
import type { ProcessExecutor, ProcessResult } from '../process-executor.js';
import type { Clock, ImplementationPacket, ProviderCallScope, ValidationCommand } from '../types.js';
import {
  assertExactModel, checkScope, git, isProtectedPath, remoteBranchSha, requireStartedInvocation, stagedEntries, statusPaths, succeeded,
  summary, withinArea, type GitSettings,
} from './common.js';

// Claude Code as the implementation agent. The model never sees the repository: it runs
// in a model workspace holding only the files inside the packet's read scope, with file
// tools alone (no Bash), and it may write only where explicit path rules allow. After it
// exits, this adapter carries its changes into an adapter-owned worktree, checks scope,
// runs the packet's validation in an isolated offline sandbox against a view holding only
// the packet read scope, and commits and pushes the exact work branch itself. It never
// pushes anything else, never forces, and never reports a SHA as authority; the
// controller reads the pushed SHA from repository reality.

export interface ClaudeCodeSettings {
  executable: string;
  provider: string;
  model: string;
  destination: string;
  timeoutMs: number;
  maxTurns: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
}
export interface DeliverySettings extends GitSettings {
  commitAuthor: { name: string; email: string };
  validationTimeoutMs: number;
  validationMaxOutputBytes: number;
  /** Dependency directories (e.g. node_modules) linked into the validation copy only, after the model has exited. */
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

// Claude Code's own context loading is switched off: no CLAUDE.md from any directory and
// no auto-memory, so nothing outside the model workspace reaches the model that way.
const CLAUDE_ENVIRONMENT = Object.freeze({ CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });

// ---------------------------------------------------------------- model file scope

export const FILE_TOOLS = Object.freeze(['Read', 'Glob', 'Grep', 'Edit', 'Write']);
const SAFE_SEGMENT = /^[A-Za-z0-9._@+-]+$/;
const CASE_001 = /case[-_ ]?001/i;
// Protected and confidential paths at any depth, mirroring the delivery scope check.
const PROTECTED_PATTERNS = Object.freeze(['**/.git', '**/.git/**', './.github', './.github/**', '**/.gitmodules', '**/.gitattributes',
  '**/.env*', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/*.keystore', '**/id_rsa*', '**/id_ed25519*', '**/id_ecdsa*', '**/id_dsa*',
  '**/.npmrc', '**/.netrc', '**/.pypirc', '**/*CASE-001*', '**/*CASE-001*/**', '**/*CASE_001*', '**/*CASE_001*/**', '**/*CASE001*',
  '**/*CASE001*/**']);

/** Claude Code permission rules for one iteration, with the areas they were derived from. */
export interface ModelFileScope {
  readonly readAreas: readonly string[];
  readonly writeAreas: readonly string[];
  readonly allow: readonly string[];
  readonly deny: readonly string[];
}

const expressible = (path: string) => path.length > 0 && path.split('/').every((part) => SAFE_SEGMENT.test(part) && part !== '.' && part !== '..');
const trimArea = (area: string) => area.replace(/\/+$/, '');

/**
 * The file-tool permissions for one iteration, or why the packet's scope cannot be stated
 * safely. Claude Code allows reads anywhere in its working directory and lets a deny rule
 * override any allow, so the read scope is enforced by what the working directory holds
 * (the read scope and nothing else) and by deny rules naming every repository path
 * outside it. Writes are allowed only by Edit rules for the write scope. Every rule names
 * a path; no rule approves a tool generically.
 */
export function modelFileScope(input: { readAreas: readonly string[]; writeAreas: readonly string[]; forbidden: readonly string[];
  linked: readonly string[]; repositoryPaths: readonly string[] }): ModelFileScope | string {
  const readAreas = input.readAreas.map(trimArea);
  const writeAreas = input.writeAreas.map(trimArea);
  if (readAreas.length === 0 || writeAreas.length === 0) return 'the packet names no read or write area';
  for (const area of [...readAreas, ...writeAreas]) {
    if (!expressible(area)) return `area ${JSON.stringify(area)} is not a plain repository path`;
    if (isProtectedPath(area) || CASE_001.test(area)) return `area ${area} is protected`;
    if (input.linked.some((link) => withinArea(area, link))) return `area ${area} is a linked dependency directory`;
  }
  const unreadable = writeAreas.find((area) => !readAreas.some((read) => withinArea(area, read)));
  if (unreadable) return `write area ${unreadable} is outside the read scope`;

  const deny = new Set<string>();
  const both = (pattern: string) => { deny.add(`Read(${pattern})`); deny.add(`Edit(${pattern})`); };
  for (const pattern of PROTECTED_PATTERNS) both(pattern);
  for (const link of input.linked) { both(`./${link}`); both(`./${link}/**`); }
  for (const entry of input.forbidden.map(trimArea)) {
    if (!writeAreas.some((area) => withinArea(entry, area) || withinArea(area, entry))) continue;
    if (!expressible(entry)) return `forbidden area ${JSON.stringify(entry)} inside the write scope is not a plain repository path`;
    if (writeAreas.some((area) => withinArea(area, entry))) return `a write area lies inside forbidden area ${entry}`;
    deny.add(`Edit(./${entry})`);
    deny.add(`Edit(./${entry}/**)`);
  }
  // Each repository path outside the read scope, named by its shortest prefix that is neither inside nor above a read area.
  for (const path of input.repositoryPaths) {
    if (readAreas.some((area) => withinArea(path, area))) continue;
    const parts = path.split('/');
    for (let length = 1; length <= parts.length; length++) {
      const prefix = parts.slice(0, length).join('/');
      if (readAreas.some((area) => withinArea(area, prefix))) continue;
      if (!expressible(prefix)) return `repository path ${JSON.stringify(prefix)} outside the read scope cannot be named in a deny rule`;
      both(`./${prefix}`);
      both(`./${prefix}/**`);
      break;
    }
  }
  const allow = [...readAreas.flatMap((area) => [`Read(./${area})`, `Read(./${area}/**)`]),
    ...writeAreas.flatMap((area) => [`Edit(./${area})`, `Edit(./${area}/**)`])];
  return Object.freeze({ readAreas: Object.freeze([...readAreas]), writeAreas: Object.freeze([...writeAreas]),
    allow: Object.freeze([...new Set(allow)]), deny: Object.freeze([...deny].sort()) });
}

/**
 * The complete Claude Code argv. Non-interactive JSON output with a report schema; the
 * exact model and a turn limit; restricted mode (settings files ignored, file tools
 * confined to the working directory, bypass refused); dontAsk with nobody answering
 * prompts, so anything a rule does not allow is denied; the file tools only, with the
 * path rules of the model file scope; no session persistence, MCP servers, skills, or
 * browser. There is no Bash, no permission bypass, and no fallback model.
 */
export function claudeArguments(settings: ClaudeCodeSettings, scope: ModelFileScope): string[] {
  if (scope.allow.some((rule) => !/^(Read|Edit)\(\.\/[A-Za-z0-9._@+/-]+(\/\*\*)?\)$/.test(rule))) throw new Error('Every allow rule must name a path');
  const permissions = { allow: [...scope.allow], deny: [...scope.deny], disableBypassPermissionsMode: 'disable' };
  return ['-p', '--output-format', 'json', '--model', assertExactModel(settings.model), '--max-turns', String(settings.maxTurns),
    '--restricted', '--permission-prompts', 'none', '--permission-mode', 'dontAsk', '--no-session-persistence',
    '--strict-mcp-config', '--disable-slash-commands', '--no-chrome', '--tools', FILE_TOOLS.join(','),
    '--settings', JSON.stringify({ permissions }), '--disallowedTools', 'Bash,WebFetch,WebSearch',
    '--json-schema', JSON.stringify(REPORT_SCHEMA)];
}

function prompt(input: ImplementationInput, scope: ModelFileScope): string {
  const packet = input.packet;
  const lines = [
    `You are the implementation agent for CHIEF packet ${packet.packetId} (version ${packet.packetVersion}), implementation iteration ${input.implementationIteration}.`,
    `The current directory holds only the repository files inside this packet's read scope: ${JSON.stringify(scope.readAreas)}.`,
    'Other repository content is intentionally absent. Do not look for it.',
    `Create, change, or delete files only inside: ${JSON.stringify(scope.writeAreas)}.`,
    `Objective: ${packet.objective}`,
    `Forbidden changes: ${JSON.stringify(packet.forbiddenChanges)}`,
    `Invariants that must still hold: ${JSON.stringify(packet.invariants)}`,
    `Acceptance criteria: ${JSON.stringify(packet.acceptanceCriteria)}`,
    `After you finish, the adapter runs these validation commands in an isolated offline sandbox (you cannot run them): ${JSON.stringify(packet.validationCommands.map((command) => [command.executable, ...command.args]))}`,
  ];
  if (input.correction) {
    lines.push(`This iteration answers a rejection of ${input.correction.rejectedSha}.`,
      `Reviewer findings to address: ${JSON.stringify(input.correction.reviewerFindings)}`);
  }
  lines.push('You have file tools only. The adapter delivers your changes; it commits and pushes nothing you did not change in scope.',
    'Finish with status COMPLETED, or the stop class that applies (SOFT_STOP: a defect you could not fix within scope;',
    'ARCHITECTURE_STOP: the work needs content or changes outside the scope above, or the packet conflicts with the files; HUMAN_STOP: a human decision is required), with a short reason.',
    'Your report is advisory. The adapter checks scope and runs validation itself.');
  return `${lines.join('\n')}\n`;
}

type Stop = Exclude<ImplementationResult, { status: 'COMPLETED' }>;
const stop = (status: Stop['status'], reason: string): Stop => ({ status, reason: reason.slice(0, 2000) });
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 600);

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

interface FileState { digest: string; executable: boolean }
interface ModelWorkspace { root: string; manifest: Map<string, FileState>; scope: ModelFileScope }

const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const MAX_WORKSPACE_ENTRIES = 200_000;

export class ClaudeCodeImplementationAdapter implements ImplementationAgentPort {
  readonly #claude: ClaudeCodeSettings;
  readonly #git: DeliverySettings;
  readonly #env: Record<string, string>;
  readonly #executor: ProcessExecutor;
  readonly #validation: OfflineValidationExecutor;
  readonly #journal: InvocationJournal;
  readonly #clock: Clock;

  constructor(settings: { claude: ClaudeCodeSettings; git: DeliverySettings; environment: Record<string, string> },
    dependencies: { executor: ProcessExecutor; validation: OfflineValidationExecutor; journal: InvocationJournal; clock: Clock }) {
    assertExactModel(settings.claude.model);
    if (!Number.isSafeInteger(settings.claude.maxTurns) || settings.claude.maxTurns < 1 || settings.claude.maxTurns > 500) {
      throw new Error('Claude maxTurns must be a bounded positive integer');
    }
    for (const link of settings.git.linkedDirectories) {
      if (!SAFE_SEGMENT.test(link.path) || ['.', '..', '.git'].includes(link.path) || !isAbsolute(link.source)) throw new Error('Invalid linked directory');
    }
    independentDependencies(settings.git.linkedDirectories, settings.git);
    if (typeof dependencies.validation?.runOffline !== 'function') throw new Error('An offline validation isolation boundary is required');
    this.#claude = Object.freeze({ ...settings.claude });
    this.#git = Object.freeze({ ...settings.git, commitAuthor: Object.freeze({ ...settings.git.commitAuthor }),
      linkedDirectories: Object.freeze(settings.git.linkedDirectories.map((link) => Object.freeze({ ...link }))) as DeliverySettings['linkedDirectories'] });
    this.#env = Object.freeze({ ...settings.environment });
    this.#executor = dependencies.executor;
    this.#validation = dependencies.validation;
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
    // Linked dependencies are proven independent of the repository again before anything runs.
    try { independentDependencies(settings.linkedDirectories, settings); } catch (error) { return stop('HUMAN_STOP', message(error)); }
    // A scope that cannot be stated as path rules is refused before any process runs.
    const stated = this.#fileScope(input, []);
    if (typeof stated === 'string') return stop('ARCHITECTURE_STOP', `model file scope is not safely expressible: ${stated}`);

    // The branch must be where the controller left it before any model call is spent.
    const before = await remoteBranchSha(this.#executor, settings, env, branch);
    if (before !== expectedRemote) return stop('ARCHITECTURE_STOP', `work branch ${branch} moved before implementation`);
    const fetched = await git(this.#executor, settings, env, settings.repositoryPath, ['fetch', '--no-tags', settings.remote, base]);
    if (!succeeded(fetched)) return stop('HUMAN_STOP', `could not fetch base ${base}: ${summary(fetched)}`);
    const worktree = join(settings.worktreeRoot, invocation.invocationId);
    const added = await git(this.#executor, settings, env, settings.repositoryPath, ['worktree', 'add', '--detach', worktree, base]);
    if (!succeeded(added)) return stop('HUMAN_STOP', `could not create worktree: ${summary(added)}`);
    const listed = await git(this.#executor, settings, env, worktree, ['ls-files', '--stage', '-z']);
    if (!succeeded(listed)) return stop('HUMAN_STOP', `could not list the base tree: ${summary(listed)}`);
    const workspace = this.#materialize(input, worktree, listed.stdout);
    if ('status' in workspace) return workspace;

    const run = await this.#executor.run({ executable: this.#claude.executable, args: claudeArguments(this.#claude, workspace.scope),
      cwd: workspace.root, env: { ...env, ...CLAUDE_ENVIRONMENT }, timeoutMs: this.#claude.timeoutMs, maxStdoutBytes: this.#claude.maxStdoutBytes,
      maxStderrBytes: this.#claude.maxStderrBytes, stdin: prompt(input, workspace.scope) });
    if (!succeeded(run)) return stop('HUMAN_STOP', `Claude Code run failed: ${summary(run)}`);
    const report = readReport(run.stdout, this.#claude.model);
    if (typeof report === 'string') return stop('HUMAN_STOP', report);
    if (report.status !== 'COMPLETED') return stop(report.status, `implementer reported: ${report.reason}`);
    const changed = this.#collect(input, workspace, worktree);
    if (!Array.isArray(changed)) return changed;
    return this.#deliver(input, worktree, changed, expectedRemote, report.reason);
  }

  #fileScope(input: Readonly<ImplementationInput>, repositoryPaths: readonly string[]): ModelFileScope | string {
    return modelFileScope({ readAreas: input.packet.allowedAreas, writeAreas: input.correction?.allowedCorrectionAreas ?? input.packet.allowedAreas,
      forbidden: input.packet.forbiddenChanges, linked: this.#git.linkedDirectories.map((link) => link.path), repositoryPaths });
  }

  /** A fresh directory holding exactly the base files inside the read scope: no Git metadata, protected, confidential, or linked path. */
  #materialize(input: Readonly<ImplementationInput>, worktree: string, listing: string): ModelWorkspace | Stop {
    let entries: Array<{ mode: string; path: string }>;
    try { entries = indexEntries(listing); } catch (error) { return stop('HUMAN_STOP', message(error)); }
    const scope = this.#fileScope(input, entries.map((entry) => entry.path));
    if (typeof scope === 'string') return stop('ARCHITECTURE_STOP', `model file scope is not safely expressible: ${scope}`);
    const visible = entries.filter((entry) => this.#inReadScope(input, entry.path));
    const special = visible.find((entry) => entry.mode !== '100644' && entry.mode !== '100755');
    if (special) return stop('ARCHITECTURE_STOP', `the read scope holds a non-regular entry ${special.path} (mode ${special.mode})`);
    const root = `${worktree}.model`;
    const manifest = new Map<string, FileState>();
    try {
      mkdirSync(root);
      for (const entry of visible) {
        const source = join(worktree, entry.path);
        if (!lstatSync(source).isFile()) throw new Error(`base file ${entry.path} is not a regular file in the worktree`);
        const executable = entry.mode === '100755';
        manifest.set(entry.path, { digest: copyInto(root, entry.path, source, executable), executable });
      }
    } catch (error) {
      return stop('HUMAN_STOP', `could not prepare the model workspace: ${message(error)}`);
    }
    return { root, manifest, scope };
  }

  /** The packet read scope: inside `activePacket.allowedAreas`, never a protected, confidential, or linked path. Both the model and validation see only this. */
  #inReadScope(input: Readonly<ImplementationInput>, path: string): boolean {
    return input.packet.allowedAreas.some((area) => withinArea(path, trimArea(area))) && !isProtectedPath(path) && !CASE_001.test(path) &&
      !this.#git.linkedDirectories.some((link) => withinArea(path, link.path));
  }

  /** The model's changes, checked against the write scope and carried into the worktree; nothing is carried if any is out of scope. */
  #collect(input: Readonly<ImplementationInput>, workspace: ModelWorkspace, worktree: string): string[] | Stop {
    let files: Map<string, FileState>;
    try { files = workspaceFiles(workspace.root); } catch (error) { return stop('HUMAN_STOP', `model workspace: ${message(error)}`); }
    const changes: Array<{ path: string; deleted: boolean }> = [];
    for (const [path, state] of files) {
      const base = workspace.manifest.get(path);
      if (!base || base.digest !== state.digest || base.executable !== state.executable) changes.push({ path, deleted: false });
    }
    for (const path of workspace.manifest.keys()) if (!files.has(path)) changes.push({ path, deleted: true });
    if (changes.length === 0) return stop('SOFT_STOP', 'implementation produced no changes');
    const paths = changes.map((change) => change.path).sort();
    const confidential = paths.find((path) => CASE_001.test(path));
    if (confidential) return stop('HUMAN_STOP', `scope violation: confidential path ${confidential}`);
    const verdict = checkScope(paths, workspace.scope.writeAreas, input.packet.forbiddenChanges);
    if (!verdict.ok) return stop(verdict.protectedPath ? 'HUMAN_STOP' : 'ARCHITECTURE_STOP', `scope violation: ${verdict.reason}`);
    try {
      for (const change of changes) if (change.deleted) removeFile(worktree, change.path);
      for (const change of changes) if (!change.deleted) placeFile(worktree, change.path, join(workspace.root, change.path), files.get(change.path)!.executable);
    } catch (error) {
      return stop('HUMAN_STOP', `could not carry the changes into the worktree: ${message(error)}`);
    }
    return paths;
  }

  async #deliver(input: Readonly<ImplementationInput>, worktree: string, changed: readonly string[], expectedRemote: string | null,
    reported: string): Promise<ImplementationResult> {
    const packet = input.packet;
    const branch = packet.targetBranch;
    const settings = this.#git;
    const env = this.#env;
    const run = (args: string[]) => git(this.#executor, settings, env, worktree, args);
    const scoped = (paths: string[]): Stop | undefined => {
      const verdict = checkScope(paths, input.correction?.allowedCorrectionAreas ?? packet.allowedAreas, packet.forbiddenChanges);
      return verdict.ok ? undefined : stop(verdict.protectedPath ? 'HUMAN_STOP' : 'ARCHITECTURE_STOP', `scope violation: ${verdict.reason}`);
    };

    const status = await run(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (!succeeded(status)) return stop('HUMAN_STOP', `could not inspect the worktree: ${summary(status)}`);
    const seen = [...new Set(statusPaths(status.stdout))].sort();
    // Git must see exactly the carried change set: an ignored or unexpected path is never validated without being delivered, or delivered unseen.
    if (seen.length !== changed.length || seen.some((path, index) => path !== changed[index])) {
      return stop('ARCHITECTURE_STOP', 'the change set differs from what Git sees in the worktree (ignored or unexpected paths)');
    }
    const outside = scoped(seen);
    if (outside) return outside;

    const evidence: string[] = [`changed paths inside packet scope: ${changed.length}`];
    const copy = await this.#validationView(input, worktree);
    if ('status' in copy) return copy;
    // Every command is authorized, and its cwd already exists in the scoped view, before any runs; nothing is recreated from outside the scope.
    for (const command of packet.validationCommands) {
      const verdict = this.#authorizeValidation(input, command);
      if (verdict) return verdict;
      if (command.cwd !== '.' && !plainDirectory(copy.root, command.cwd)) {
        return stop('ARCHITECTURE_STOP', `validation ${command.commandId} cwd ${command.cwd} is not inside the packet read scope`);
      }
    }
    for (const [index, command] of packet.validationCommands.entries()) {
      const outcome = await this.#validation.runOffline({ executable: command.executable, args: [...command.args],
        cwd: command.cwd === '.' ? copy.root : join(copy.root, command.cwd), workspace: copy.root, temporaryDirectory: copy.temporary,
        readOnlyPaths: copy.dependencies, env, timeoutMs: settings.validationTimeoutMs,
        maxStdoutBytes: settings.validationMaxOutputBytes, maxStderrBytes: settings.validationMaxOutputBytes });
      if (outcome.isolation !== 'ENFORCED') {
        return stop('HUMAN_STOP', `offline validation isolation unavailable; nothing was validated or delivered: ${outcome.reason}`);
      }
      // Output of model-written code stays in the local log: it may carry repository content outside the packet scope.
      keepLog(copy.logs, index, command.commandId, outcome.result);
      if (!succeeded(outcome.result)) return stop('SOFT_STOP', `validation ${command.commandId} failed: ${exitOf(outcome.result)}`);
      evidence.push(`validation ${command.commandId}: exit 0 (isolated: network denied, filesystem confined)`);
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

  /**
   * The repository view validation runs against: the worktree's regular files inside the packet
   * read scope as they stand after the carried changes, and nothing else from the repository.
   * Linked dependencies are added as read-only links; they are not repository read authority.
   * A validation that needs more of the repository fails; the scope is never widened here.
   */
  async #validationView(input: Readonly<ImplementationInput>, worktree: string):
    Promise<{ root: string; temporary: string; logs: string; dependencies: string[] } | Stop> {
    // Checked once more and bound to the canonical sources, so what validation may read is exactly what was proven.
    let dependencies: string[];
    try { dependencies = independentDependencies(this.#git.linkedDirectories, this.#git); } catch (error) { return stop('HUMAN_STOP', message(error)); }
    const listed = await git(this.#executor, this.#git, this.#env, worktree, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    if (!succeeded(listed)) return stop('HUMAN_STOP', `could not list the worktree: ${summary(listed)}`);
    const paths = [...new Set(listed.stdout.split('\0').filter(Boolean))].filter((path) => this.#inReadScope(input, path)).sort();
    const root = `${worktree}.validation`, temporary = `${worktree}.tmp`, logs = `${worktree}.logs`;
    try {
      mkdirSync(root);
      for (const path of paths) {
        const source = join(worktree, path);
        const stats = lstatSync(source, { throwIfNoEntry: false });
        if (stats === undefined) continue; // deleted by the carried changes
        if (!stats.isFile()) return stop('ARCHITECTURE_STOP', `the validation scope holds a non-regular entry ${path}`);
        copyInto(root, path, source, (stats.mode & 0o100) !== 0);
      }
      for (const [index, link] of this.#git.linkedDirectories.entries()) symlinkSync(dependencies[index], join(root, link.path), 'dir');
      mkdirSync(temporary);
      mkdirSync(logs);
    } catch (error) {
      return stop('HUMAN_STOP', `could not prepare the validation copy: ${message(error)}`);
    }
    return { root, temporary, logs, dependencies };
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

/** The filesystem identity of an existing path: device and inode, so symlinks, firmlinks, letter case, and Unicode form cannot alias it. */
function identity(path: string): string {
  const stats = statSync(path, { bigint: true });
  return `${stats.dev}:${stats.ino}`;
}

/** The identities of a path and each of its ancestors up to the filesystem root. */
function lineage(path: string): string[] {
  const identities: string[] = [];
  for (let current = path; ; current = dirname(current)) {
    identities.push(identity(current));
    if (dirname(current) === current) return identities;
  }
}

/**
 * The canonical sources of the linked dependencies, proven filesystem-disjoint from the
 * repository and the worktree root: a source may be neither of them, inside either, nor
 * above either. A dependency is never repository read authority; repository content
 * validation needs comes only through the packet's allowed areas. Throws when a path cannot
 * be resolved or a source overlaps; there is no override. Content is never inspected.
 */
export function independentDependencies(linked: ReadonlyArray<{ path: string; source: string }>,
  roots: { repositoryPath: string; worktreeRoot: string }): string[] {
  if (linked.length === 0) return [];
  const canonical = (label: string, path: string) => {
    try { return realpathSync.native(path); } catch { throw new Error(`${label} ${JSON.stringify(path)} cannot be resolved`); }
  };
  const guarded = [['repository', canonical('repository', roots.repositoryPath)], ['worktree root', canonical('worktree root', roots.worktreeRoot)]]
    .map(([label, path]) => ({ label, lineage: lineage(path) }));
  return linked.map((link) => {
    const source = canonical(`linked dependency ${link.path} source`, link.source);
    const own = lineage(source);
    for (const root of guarded) {
      if (own.includes(root.lineage[0])) throw new Error(`linked dependency ${link.path} source ${source} is the ${root.label} or inside it`);
      if (root.lineage.includes(own[0])) throw new Error(`linked dependency ${link.path} source ${source} contains the ${root.label}`);
    }
    return source;
  });
}

/** Entries of `git ls-files --stage -z`: mode and path of each stage-0 entry. */
function indexEntries(output: string): Array<{ mode: string; path: string }> {
  return output.split('\0').filter(Boolean).map((token) => {
    const match = /^(\d{6}) [0-9a-f]{40,64} (\d)\t(.+)$/s.exec(token);
    if (!match || match[2] !== '0') throw new Error('Unrecognized git ls-files entry');
    return { mode: match[1], path: match[3] };
  });
}

/** Every regular file under the model workspace with its content digest. Any other kind of entry is refused. */
function workspaceFiles(root: string): Map<string, FileState> {
  const files = new Map<string, FileState>();
  const pending = [''];
  let entries = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    for (const name of readdirSync(join(root, directory))) {
      if (++entries > MAX_WORKSPACE_ENTRIES) throw new Error('too many entries');
      const path = directory ? `${directory}/${name}` : name;
      const stats = lstatSync(join(root, path));
      if (stats.isDirectory()) pending.push(path);
      else if (stats.isFile()) files.set(path, { digest: digest(join(root, path)), executable: (stats.mode & 0o100) !== 0 });
      else throw new Error(`non-regular entry ${path}`);
    }
  }
  return files;
}

/** Copies one regular file into a fresh view with its executable bit; returns its content digest. */
function copyInto(root: string, path: string, source: string, executable: boolean): string {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target, constants.COPYFILE_EXCL);
  chmodSync(target, executable ? 0o755 : 0o644);
  return digest(target);
}

/** Whether a repository-relative directory exists in a view through plain directories only. */
function plainDirectory(root: string, path: string): boolean {
  let current = root;
  for (const part of path.split('/')) {
    current = join(current, part);
    if (!lstatSync(current, { throwIfNoEntry: false })?.isDirectory()) return false;
  }
  return true;
}

/** The parent directories of a worktree path, created where missing; none may be a symlink or a file. */
function parents(worktree: string, path: string, create: boolean): void {
  let current = worktree;
  for (const part of path.split('/').slice(0, -1)) {
    current = join(current, part);
    const stats = lstatSync(current, { throwIfNoEntry: false });
    if (stats === undefined && create) mkdirSync(current);
    else if (!stats?.isDirectory()) throw new Error(`${path} is not beneath plain directories`);
  }
}

function placeFile(worktree: string, path: string, source: string, executable: boolean): void {
  parents(worktree, path, true);
  const target = join(worktree, path);
  const existing = lstatSync(target, { throwIfNoEntry: false });
  if (existing && !existing.isFile()) throw new Error(`${path} is not a regular file in the worktree`);
  writeFileSync(target, readFileSync(source));
  chmodSync(target, executable ? 0o755 : 0o644);
}

function removeFile(worktree: string, path: string): void {
  parents(worktree, path, false);
  const target = join(worktree, path);
  if (!lstatSync(target).isFile()) throw new Error(`${path} is not a regular file in the worktree`);
  unlinkSync(target);
  for (let current = dirname(target); current.startsWith(`${worktree}/`) && readdirSync(current).length === 0; current = dirname(current)) {
    rmdirSync(current);
  }
}

function exitOf(result: ProcessResult): string {
  return `${result.outcome}${result.exitCode === null ? '' : ` exit ${result.exitCode}`}${result.signal ? ` signal ${result.signal}` : ''}`;
}

function keepLog(directory: string, index: number, commandId: string, result: ProcessResult): void {
  writeFileSync(join(directory, `validation-${index}.log`), [`command: ${JSON.stringify(commandId)}`, `outcome: ${exitOf(result)}`,
    '--- stdout', result.stdout, '--- stderr', result.stderr, ''].join('\n'), { mode: 0o600 });
}
