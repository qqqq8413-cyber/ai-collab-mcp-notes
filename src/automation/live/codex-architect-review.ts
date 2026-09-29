import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { ArchitectReviewBundle, ArchitectReviewInput, ArchitectReviewPort } from '../bridge.js';
import { parseEgressSet } from '../egress-destination.js';
import type { InvocationJournal } from '../invocation-journal.js';
import type { ProcessExecutor } from '../process-executor.js';
import type { AcceptanceDecision, Clock, CorrectionPacket, ProviderCallScope } from '../types.js';
import { assertExactModel, git, requireStartedInvocation, succeeded, summary, type GitSettings } from './common.js';
import { egressRefusal, verifyPinnedExecutable, type LiveModelProcessExecutor } from './model-process-isolation.js';

// Codex as the independent architect reviewer, run non-interactively against a
// read-only worktree at exactly the remote SHA the controller recorded. The model
// writes only semantic review content through a strict output schema. This adapter
// binds every trusted field itself (review id, actor, packet, hash, reviewed SHA,
// issuedAt, and all correction binding) from the controller's input, and the
// controller's own validators remain final. The CLI runs only through the egress-bound
// model process boundary: the review worktree is read-only to it, its network reaches
// only the broker enforcing the call's exact egress set, and its answer is used only
// with clean broker evidence.

export interface CodexSettings {
  /** Absolute path of the pinned native Codex executable (not a launcher script), and the SHA-256 of its bytes. */
  executable: string;
  executableSha256: string;
  provider: string;
  model: string;
  /** The exact canonical egress set the broker enforces for this actor's calls. */
  egressDestinations: string[];
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxResultBytes: number;
  /** Codex features turned off for the review session, as the installed CLI names them. */
  disabledFeatures: string[];
}

/** Features a review session must never have, whatever else is configured. */
export const REQUIRED_DISABLED_FEATURES = Object.freeze(['multi_agent', 'multi_agent_v2', 'multi_agent_mode', 'enable_fanout', 'plugins', 'apps',
  'hooks', 'browser_use', 'computer_use', 'in_app_browser', 'memories', 'remote_plugin', 'image_generation']);

export const REVIEW_OUTPUT_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['decision', 'findings', 'evidenceReferences', 'correction'],
  properties: {
    decision: { type: 'string', enum: ['ACCEPT', 'REJECT'] },
    findings: { type: 'array', items: { type: 'string' } },
    evidenceReferences: { type: 'array', items: { type: 'string' } },
    correction: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false,
      required: ['allowedCorrectionAreas', 'unchangedInvariantReferences'],
      properties: { allowedCorrectionAreas: { type: 'array', items: { type: 'string' } },
        unchangedInvariantReferences: { type: 'array', items: { type: 'string' } } } }] },
  },
});
const item = z.string().trim().min(1).max(2000);
const reviewOutputSchema = z.strictObject({
  decision: z.enum(['ACCEPT', 'REJECT']),
  findings: z.array(item).max(50),
  evidenceReferences: z.array(item).min(1).max(50),
  correction: z.strictObject({ allowedCorrectionAreas: z.array(item).min(1).max(50), unchangedInvariantReferences: z.array(item).min(1).max(50) }).nullable(),
});

/**
 * The complete Codex argv: exec with the exact model; read-only sandbox; approvals
 * never asked (so nothing is ever approved); web search off; project instruction files
 * not injected; user config and execpolicy rules not loaded; multi-agent, plugins,
 * apps, hooks, browser and computer use off; no session persisted; the answer shape
 * fixed by an output schema. No full-auto, workspace write, or bypass.
 */
export function codexArguments(settings: CodexSettings, paths: { worktree: string; schema: string; output: string }): string[] {
  const features = [...new Set([...REQUIRED_DISABLED_FEATURES, ...settings.disabledFeatures])];
  return ['exec', '--model', assertExactModel(settings.model), '--sandbox', 'read-only',
    '--config', 'approval_policy="never"', '--config', 'web_search="disabled"', '--config', 'project_doc_max_bytes=0',
    ...features.flatMap((feature) => ['--disable', feature]),
    '--ignore-user-config', '--ignore-rules', '--ephemeral', '--color', 'never',
    '--cd', paths.worktree, '--output-schema', paths.schema, '--output-last-message', paths.output, '-'];
}

function prompt(input: ArchitectReviewInput): string {
  const packet = input.packet;
  return [
    `You are the independent GPT_ARCHITECT acceptance reviewer for CHIEF packet ${packet.packetId} (version ${packet.packetVersion}).`,
    `The current directory is a read-only checkout of exactly commit ${input.remoteSha.sha} from branch ${input.remoteSha.branch}, implementation iteration ${input.implementationIteration}.`,
    `The packet base is ${packet.expectedBaseSha}${input.correction ? `; this iteration corrects the rejected commit ${input.correction.rejectedSha}` : ''}. Inspect the change with git (for example git diff ${packet.expectedBaseSha} HEAD).`,
    'Do not modify any file and do not use the network. Implementation completion is not acceptance, and the implementer\'s claims are not evidence.',
    'ACCEPT only when every acceptance criterion holds, every changed path is inside the allowed areas, no forbidden change is present, and every invariant still holds. Otherwise REJECT with specific findings.',
    `Objective: ${packet.objective}`,
    `Allowed areas: ${JSON.stringify(packet.allowedAreas)}`,
    `Forbidden changes: ${JSON.stringify(packet.forbiddenChanges)}`,
    `Invariants: ${JSON.stringify(packet.invariants)}`,
    `Acceptance criteria: ${JSON.stringify(packet.acceptanceCriteria)}`,
    'Answer with: decision; findings (non-empty for REJECT); evidenceReferences (at least one: files, commands, or lines you checked);',
    'correction: null for ACCEPT; for REJECT either null or { allowedCorrectionAreas (a subset of the allowed areas), unchangedInvariantReferences (exactly the invariants above) }.',
    'Do not state packet ids, hashes, SHAs, actors, authorizations, or timestamps; they are bound outside your answer.',
  ].join('\n') + '\n';
}

const stop = (kind: 'ARCHITECTURE_STOP' | 'HUMAN_STOP', reason: string): ArchitectReviewBundle => ({ stop: kind, reason: reason.slice(0, 2000) });

export class CodexArchitectReviewAdapter implements ArchitectReviewPort {
  readonly #codex: CodexSettings;
  readonly #git: GitSettings;
  readonly #env: Record<string, string>;
  readonly #executor: ProcessExecutor;
  readonly #model: LiveModelProcessExecutor;
  readonly #journal: InvocationJournal;
  readonly #clock: Clock;

  constructor(settings: { codex: CodexSettings; git: GitSettings; environment: Record<string, string> },
    dependencies: { executor: ProcessExecutor; model: LiveModelProcessExecutor; journal: InvocationJournal; clock: Clock }) {
    assertExactModel(settings.codex.model);
    parseEgressSet(settings.codex.egressDestinations);
    verifyPinnedExecutable(settings.codex.executable, settings.codex.executableSha256);
    if (typeof dependencies.model?.runModel !== 'function') throw new Error('An egress-bound model process boundary is required');
    for (const feature of settings.codex.disabledFeatures) {
      if (!/^[a-z0-9_.]+$/.test(feature)) throw new Error('Invalid Codex feature name');
    }
    this.#codex = Object.freeze({ ...settings.codex, disabledFeatures: Object.freeze([...settings.codex.disabledFeatures]) as string[],
      egressDestinations: Object.freeze([...settings.codex.egressDestinations]) as string[] });
    this.#git = Object.freeze({ ...settings.git });
    this.#env = Object.freeze({ ...settings.environment });
    this.#executor = dependencies.executor;
    this.#model = dependencies.model;
    this.#journal = dependencies.journal;
    this.#clock = dependencies.clock;
    Object.freeze(this);
  }

  get scope(): ProviderCallScope {
    return { actorKind: 'ARCHITECT_REVIEW', provider: this.#codex.provider, model: this.#codex.model, egressDestinations: [...this.#codex.egressDestinations] };
  }

  async review(input: Readonly<ArchitectReviewInput>): Promise<ArchitectReviewBundle> {
    const invocation = requireStartedInvocation(this.#journal, input, 'ARCHITECT_REVIEW', this.scope);
    const settings = this.#git;
    const env = this.#env;
    const sha = input.remoteSha.sha;
    const bases = [input.packet.expectedBaseSha, ...(input.correction ? [input.correction.rejectedSha] : [])];
    for (const commit of [sha, ...bases]) {
      const fetched = await git(this.#executor, settings, env, settings.repositoryPath, ['fetch', '--no-tags', settings.remote, commit]);
      if (!succeeded(fetched)) return stop('HUMAN_STOP', `could not fetch ${commit}: ${summary(fetched)}`);
    }
    const worktree = join(settings.worktreeRoot, invocation.invocationId);
    const added = await git(this.#executor, settings, env, settings.repositoryPath, ['worktree', 'add', '--detach', worktree, sha]);
    if (!succeeded(added)) return stop('HUMAN_STOP', `could not create the review worktree: ${summary(added)}`);
    // Repository-local agent configuration must not redefine the reviewer; if the
    // reviewed tree carries any, isolation cannot be guaranteed and nothing is run.
    const top = await git(this.#executor, settings, env, worktree, ['ls-tree', '--name-only', 'HEAD']);
    if (!succeeded(top)) return stop('HUMAN_STOP', `could not list the reviewed tree: ${summary(top)}`);
    const local = top.stdout.split('\n').filter((name) => ['.codex', '.agents'].includes(name.trim()));
    if (local.length) return stop('ARCHITECTURE_STOP', `reviewed tree contains agent configuration (${local.join(', ')}); reviewer isolation cannot be guaranteed`);

    // The schema and the answer live in a directory of their own: the only place the reviewer may write.
    const answers = join(settings.worktreeRoot, `${invocation.invocationId}.review`);
    if (existsSync(answers)) throw new Error('Review answer directory already exists; refusing to read a stale answer');
    mkdirSync(answers, { mode: 0o700 });
    const schema = join(answers, 'review-schema.json');
    const output = join(answers, 'review-output.json');
    writeFileSync(schema, JSON.stringify(REVIEW_OUTPUT_SCHEMA), { flag: 'wx', mode: 0o600 });
    // Git in the worktree reads the clone's object store; the reviewer may read it, never write it.
    const store = join(settings.repositoryPath, '.git');
    const scope = this.scope;
    const outcome = await this.#model.runModel({ invocationId: invocation.invocationId, actorKind: 'ARCHITECT_REVIEW', scope,
      executable: this.#codex.executable, executableSha256: this.#codex.executableSha256, args: codexArguments(this.#codex, { worktree, schema, output }),
      cwd: worktree, workspace: { path: worktree, mode: 'READ_ONLY' }, writablePaths: [answers],
      readOnlyPaths: lstatSync(store, { throwIfNoEntry: false })?.isDirectory() ? [store] : [settings.repositoryPath], env, stdin: prompt(input),
      timeoutMs: this.#codex.timeoutMs, maxStdoutBytes: this.#codex.maxStdoutBytes, maxStderrBytes: this.#codex.maxStderrBytes });
    if (outcome.isolation !== 'ENFORCED') return stop('HUMAN_STOP', `model process isolation unavailable; Codex was not run: ${outcome.reason}`);
    const egress = egressRefusal(outcome, scope, invocation.invocationId);
    if (egress) return stop('HUMAN_STOP', `egress: ${egress}`);
    const run = outcome.result;
    if (!succeeded(run)) return stop('HUMAN_STOP', `Codex review run failed: ${summary(run)}`);

    // The reviewed workspace must be exactly as it was checked out.
    const status = await git(this.#executor, settings, env, worktree, ['status', '--porcelain=v1', '--untracked-files=all']);
    const head = await git(this.#executor, settings, env, worktree, ['rev-parse', 'HEAD']);
    if (!succeeded(status) || !succeeded(head)) return stop('HUMAN_STOP', 'could not verify the review workspace after the run');
    if (status.stdout.trim() !== '' || head.stdout.trim() !== sha) return stop('ARCHITECTURE_STOP', 'the reviewer changed the review workspace');

    let answer: unknown;
    try {
      if (statSync(output).size > this.#codex.maxResultBytes) return stop('ARCHITECTURE_STOP', 'review answer exceeds its bound');
      answer = JSON.parse(readFileSync(output, 'utf8'));
    } catch {
      return stop('ARCHITECTURE_STOP', 'review answer is missing or not JSON');
    }
    const parsed = reviewOutputSchema.safeParse(answer);
    if (!parsed.success) return stop('ARCHITECTURE_STOP', 'review answer does not match the review schema');
    const review = parsed.data;
    if (review.decision === 'ACCEPT' && review.correction !== null) return stop('ARCHITECTURE_STOP', 'an ACCEPT carried a correction');
    if (review.decision === 'REJECT' && review.findings.length === 0) return stop('ARCHITECTURE_STOP', 'a REJECT carried no findings');

    const packet = input.packet;
    const decision: AcceptanceDecision = { reviewId: `review-${invocation.invocationId.slice(0, 24)}`, actor: 'GPT_ARCHITECT',
      packetId: packet.packetId, packetHash: input.packetHash, reviewedSha: sha, decision: review.decision,
      findings: review.findings, evidenceReferences: review.evidenceReferences, issuedAt: this.#clock.now() };
    if (review.decision === 'ACCEPT' || review.correction === null) return { decision };
    const correction: CorrectionPacket = { correctionPacketId: `correction-${packet.packetId}-${input.implementationIteration + 1}`,
      originalPacketId: packet.packetId, originalPacketHash: input.packetHash, rejectedSha: sha,
      reviewerFindings: [...review.findings], allowedCorrectionAreas: review.correction.allowedCorrectionAreas,
      unchangedInvariantReferences: review.correction.unchangedInvariantReferences, expectedBaseSha: sha,
      correctionIteration: input.implementationIteration + 1,
      maxCorrectionIteration: packet.iterationBudget.maxImplementationIterationsPerSlice };
    return { decision, correction };
  }
}
Object.freeze(CodexArchitectReviewAdapter);
Object.freeze(CodexArchitectReviewAdapter.prototype);
