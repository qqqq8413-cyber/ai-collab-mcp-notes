import { parseInstant } from '../time.js';
import type { SyncProcessExecutor } from '../process-executor.js';
import type { RepositoryRealityPort } from '../repository-reality.js';
import type { Clock } from '../types.js';

// GitHub as repository reality, read through `gh api` one GET per command. Nothing is
// written. Unknown is never success: a missing, ambiguous, malformed, or refused
// answer throws, and the controller operation that needed it does not advance.
//
// The controller takes its decision instant before it reads the port and refuses any
// observation made after that instant. A live read made during the controller call
// would always be later, so observations are primed immediately before the controller
// operation and served from there, each with the true time it was made. An observation
// that was not primed, or has aged past the limit, is refused rather than read late.

export interface GitHubRealitySettings {
  executable: string;
  /** owner/name; the only repository this port answers for. */
  repository: string;
  workflowName: string;
  requiredCheckName: string;
  /** When set, the required check must come from this GitHub App (15368 is GitHub Actions). */
  requiredCheckAppId?: number;
  timeoutMs: number;
  maxOutputBytes: number;
  maxObservationAgeMs: number;
  /** Absolute directory gh runs in. */
  workingDirectory: string;
}

const REPOSITORY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SHA = /^[0-9a-f]{40}$/;
function assertBranch(branch: string): void {
  if (typeof branch !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes('..') || branch.startsWith('/') ||
      branch.endsWith('/') || branch.includes('//')) throw new Error(`Unsupported branch name ${JSON.stringify(branch)}`);
}
function assertSha(sha: string): void {
  if (typeof sha !== 'string' || !SHA.test(sha)) throw new Error('Malformed SHA');
}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('GitHub answer is not an object');
  return value as Record<string, unknown>;
};

function runStatus(run: Record<string, unknown>): 'PENDING' | 'SUCCESS' | 'FAILURE' {
  if (run.status !== 'completed') return 'PENDING';
  return run.conclusion === 'success' ? 'SUCCESS' : 'FAILURE';
}

export class GitHubCliRepositoryRealityPort implements RepositoryRealityPort {
  readonly #settings: GitHubRealitySettings;
  readonly #executor: SyncProcessExecutor;
  readonly #clock: Clock;
  readonly #env: Record<string, string>;
  readonly #primed = new Map<string, { fact: Record<string, unknown>; at: number }>();

  constructor(settings: GitHubRealitySettings, dependencies: { executor: SyncProcessExecutor; clock: Clock; environment: Record<string, string> }) {
    if (!REPOSITORY.test(settings.repository)) throw new Error('GitHub repository must be owner/name');
    if (!Number.isSafeInteger(settings.maxObservationAgeMs) || settings.maxObservationAgeMs < 1) throw new Error('maxObservationAgeMs must be positive');
    this.#settings = Object.freeze({ ...settings });
    this.#executor = dependencies.executor;
    this.#clock = dependencies.clock;
    this.#env = Object.freeze({ ...dependencies.environment });
    Object.freeze(this);
  }

  /** One read-only GET. Returns the parsed body for HTTP 200, or the status and body otherwise. */
  #get(path: string): { status: number; body: unknown } {
    const settings = this.#settings;
    const result = this.#executor.runSync({ executable: settings.executable, args: ['api', '--method', 'GET', '--include', path],
      cwd: settings.workingDirectory, env: this.#env, timeoutMs: settings.timeoutMs,
      maxStdoutBytes: settings.maxOutputBytes, maxStderrBytes: settings.maxOutputBytes });
    if (result.outcome !== 'EXITED') throw new Error(`gh api ${path} did not complete: ${result.outcome}`);
    const text = result.stdout.replace(/\r\n/g, '\n');
    const split = text.indexOf('\n\n');
    const statusLine = /^HTTP\/[0-9.]+ (\d{3})/.exec(text);
    if (!statusLine || split < 0) throw new Error(`gh api ${path} returned no HTTP status`);
    const status = Number(statusLine[1]);
    let body: unknown;
    try { body = JSON.parse(text.slice(split + 2)); } catch { throw new Error(`gh api ${path} returned malformed JSON`); }
    if (status === 200 && result.exitCode !== 0) throw new Error(`gh api ${path} failed`);
    return { status, body };
  }
  #ok(path: string): Record<string, unknown> {
    const { status, body } = this.#get(path);
    if (status !== 200) throw new Error(`GitHub answered HTTP ${status} for ${path}`);
    return record(body);
  }
  #now(): { at: number; iso: string } {
    const iso = this.#clock.now();
    const at = parseInstant(iso);
    if (at === undefined) throw new Error('Clock returned an invalid timestamp');
    return { at, iso };
  }
  #repository(repository: string): string {
    if (repository !== this.#settings.repository) throw new Error('This port answers for one configured repository only');
    return repository;
  }

  readBranch(repository: string, branch: string): Record<string, unknown> {
    this.#repository(repository);
    assertBranch(branch);
    const body = this.#ok(`repos/${repository}/git/ref/heads/${branch}`);
    const target = record(body.object);
    if (body.ref !== `refs/heads/${branch}` || target.type !== 'commit' || typeof target.sha !== 'string' || !SHA.test(target.sha)) {
      throw new Error(`GitHub branch answer for ${branch} is not an exact commit ref`);
    }
    return { repository, branch, sha: target.sha, observedAt: this.#now().iso };
  }

  readComparison(repository: string, baseSha: string, headSha: string): Record<string, unknown> {
    this.#repository(repository);
    assertSha(baseSha);
    assertSha(headSha);
    const body = this.#ok(`repos/${repository}/compare/${baseSha}...${headSha}`);
    const { ahead_by: aheadBy, behind_by: behindBy, total_commits: total } = body;
    const commits = body.commits;
    if (record(body.base_commit).sha !== baseSha || !Number.isSafeInteger(aheadBy) || !Number.isSafeInteger(behindBy) ||
        (aheadBy as number) < 0 || (behindBy as number) < 0 || !Array.isArray(commits)) throw new Error('GitHub comparison is malformed');
    // The head is proven by the answer itself, not assumed from the request.
    const headProven = (aheadBy as number) === 0
      ? record(body.merge_base_commit).sha === headSha
      : total === commits.length && record(commits.at(-1)).sha === headSha;
    if (!headProven) throw new Error('GitHub comparison does not prove the requested head');
    return { repository, baseSha, headSha, aheadBy, behindBy, hasBaseOnlyCommits: (behindBy as number) > 0, observedAt: this.#now().iso };
  }

  readCi(repository: string, branch: string, sha: string): Record<string, unknown> {
    this.#repository(repository);
    assertBranch(branch);
    assertSha(sha);
    const settings = this.#settings;
    const runs = this.#ok(`repos/${repository}/actions/runs?head_sha=${sha}&branch=${encodeURIComponent(branch)}&event=push&per_page=100`);
    if (!Array.isArray(runs.workflow_runs)) throw new Error('GitHub workflow runs answer is malformed');
    const matching = runs.workflow_runs.map(record).filter((run) => run.name === settings.workflowName &&
      run.head_sha === sha && run.head_branch === branch && run.event === 'push');
    if (matching.length === 0) throw new Error(`No ${settings.workflowName} run for exactly ${sha} on ${branch}`);
    if (matching.length > 1) throw new Error(`Ambiguous: ${matching.length} ${settings.workflowName} runs for ${sha} on ${branch}`);
    const run = matching[0];
    const suite = run.check_suite_id;
    if (!Number.isSafeInteger(suite)) throw new Error('Workflow run has no check suite');
    const checks = this.#ok(`repos/${repository}/commits/${sha}/check-runs?check_name=${encodeURIComponent(settings.requiredCheckName)}&filter=latest&per_page=100`);
    if (!Array.isArray(checks.check_runs)) throw new Error('GitHub check runs answer is malformed');
    // The required check of this run: same commit, same check suite, same name (and app, when configured).
    const bound = checks.check_runs.map(record).filter((check) => check.name === settings.requiredCheckName && check.head_sha === sha &&
      record(check.check_suite).id === suite &&
      (settings.requiredCheckAppId === undefined || record(check.app).id === settings.requiredCheckAppId));
    if (bound.length === 0) throw new Error(`Required check ${settings.requiredCheckName} missing for ${sha} on ${branch}`);
    if (bound.length > 1) throw new Error(`Ambiguous required check ${settings.requiredCheckName} for ${sha}`);
    return { repository, branch, sha, workflowStatus: runStatus(run), requiredCheckName: settings.requiredCheckName,
      requiredCheckStatus: runStatus(bound[0]), observedAt: this.#now().iso };
  }

  readProtection(repository: string, branch: string): Record<string, unknown> {
    this.#repository(repository);
    assertBranch(branch);
    const { status, body } = this.#get(`repos/${repository}/branches/${encodeURIComponent(branch)}/protection`);
    if (status === 404 && record(body).message === 'Branch not protected') {
      return { repository, branch, protected: false, requiredChecks: [], observedAt: this.#now().iso };
    }
    // A refused or failed read is not a protection fact, in either direction.
    if (status !== 200) throw new Error(`GitHub answered HTTP ${status} for ${branch} protection`);
    const checks = record(record(body).required_status_checks ?? {}).contexts ?? [];
    if (!Array.isArray(checks) || checks.some((name) => typeof name !== 'string' || !name)) throw new Error('Protection checks are malformed');
    return { repository, branch, protected: true, requiredChecks: [...checks], observedAt: this.#now().iso };
  }

  /** Performs the live read now and holds it for the controller's next read of the same fact. */
  primeBranch(repository: string, branch: string): void { this.#hold(`branch|${repository}|${branch}`, this.readBranch(repository, branch)); }
  primeComparison(repository: string, baseSha: string, headSha: string): void {
    this.#hold(`compare|${repository}|${baseSha}|${headSha}`, this.readComparison(repository, baseSha, headSha));
  }
  primeCi(repository: string, branch: string, sha: string): void { this.#hold(`ci|${repository}|${branch}|${sha}`, this.readCi(repository, branch, sha)); }
  primeProtection(repository: string, branch: string): void { this.#hold(`protection|${repository}|${branch}`, this.readProtection(repository, branch)); }

  #hold(key: string, fact: Record<string, unknown>): void {
    this.#primed.set(key, { fact: Object.freeze(structuredClone(fact)), at: parseInstant(fact.observedAt as string)! });
  }
  #serve(key: string): unknown {
    const held = this.#primed.get(key);
    if (!held) throw new Error(`Repository fact ${key} was not observed before this controller operation`);
    if (this.#now().at - held.at > this.#settings.maxObservationAgeMs) throw new Error(`Repository fact ${key} is too old to use`);
    return structuredClone(held.fact);
  }

  observeBranch(repository: string, branch: string): unknown { return this.#serve(`branch|${repository}|${branch}`); }
  compare(repository: string, baseSha: string, headSha: string): unknown { return this.#serve(`compare|${repository}|${baseSha}|${headSha}`); }
  observeCi(repository: string, branch: string, sha: string): unknown { return this.#serve(`ci|${repository}|${branch}|${sha}`); }
  observeProtection(repository: string, branch: string): unknown { return this.#serve(`protection|${repository}|${branch}`); }
}
Object.freeze(GitHubCliRepositoryRealityPort);
Object.freeze(GitHubCliRepositoryRealityPort.prototype);
