import { spawn } from 'node:child_process';
import { z } from 'zod';
import { ciSchema, LIMITS, REPOSITORY, type CiRun } from './model.js';

export interface CiReader { read(signal: AbortSignal): Promise<CiRun[]> }
export const safeGitHubUrl = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('GITHUB_URL_INVALID');
  const url = new URL(value);
  if (url.origin !== 'https://github.com' || url.username || url.password || url.search || url.hash ||
      !url.pathname.startsWith('/' + REPOSITORY + '/actions/runs/')) throw new Error('GITHUB_URL_INVALID');
  return url.href;
};

// Fixed helper + fixed GET paths; no shell, user-supplied URL, credentials, model or write command.
export class GitHubActionsReader implements CiReader {
  constructor(readonly executable: string, readonly cwd: string) {
    if (!executable.startsWith('/')) throw new Error('Absolute bot helper required');
  }
  #call(args: string[], signal: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new Error('CANCELLED')); return; }
      const env = Object.fromEntries(['HOME', 'PATH', 'TMPDIR', 'LANG'].flatMap(k => process.env[k] ? [[k, process.env[k]!]] : []));
      const child = spawn(this.executable, args, { cwd: this.cwd, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', size = 0, stopped = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        stopped = true;
        if (!child.pid) return;
        try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ }
        killTimer ??= setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already exited */ } }, 500);
      };
      signal.addEventListener('abort', stop, { once: true });
      child.stdout.on('data', (b: Buffer) => { size += b.length; if (size > LIMITS.outputBytes) stop(); else out += b.toString('utf8'); });
      child.stderr.on('data', (b: Buffer) => { size += b.length; if (size > LIMITS.outputBytes) stop(); });
      child.once('error', () => reject(new Error('GITHUB_HELPER_UNAVAILABLE')));
      child.once('close', code => {
        signal.removeEventListener('abort', stop); if (killTimer) clearTimeout(killTimer);
        if (stopped || signal.aborted) { reject(new Error(signal.aborted ? 'CANCELLED_OR_TIMEOUT' : 'GITHUB_RESPONSE_LIMIT')); return; }
        if (code !== 0) { reject(new Error('GITHUB_READ_REFUSED_OR_UNAVAILABLE')); return; }
        try { resolve(JSON.parse(out)); } catch { reject(new Error('GITHUB_RESPONSE_INVALID')); }
      });
    });
  }
  async read(signal: AbortSignal): Promise<CiRun[]> {
    const user = await this.#call(['api', '--method', 'GET', 'user'], signal) as { login?: string };
    if (user.login !== 'chief-ai-bot') throw new Error('BOT_IDENTITY_REQUIRED');
    const response = z.object({ workflow_runs: z.array(z.object({ id: z.number().int().positive(),
      run_attempt: z.number().int().positive(), run_number: z.number().int().positive(), name: z.string(),
      head_sha: z.string(), head_branch: z.string(), status: z.string(), conclusion: z.string().nullable(),
      event: z.string(), updated_at: z.string(), html_url: z.string(), head_repository: z.object({ full_name: z.literal(REPOSITORY) }) })).max(LIMITS.snapshotRuns) })
      .parse(await this.#call(['api', '--method', 'GET', `repos/${REPOSITORY}/actions/runs?per_page=${LIMITS.snapshotRuns}`], signal));
    const runs: CiRun[] = [];
    for (const r of response.workflow_runs) {
      const jobs: CiRun['jobs'] = [];
      for (let page = 1; page <= 2; page++) {
        const data = z.object({ total_count: z.number().int().nonnegative().max(200), jobs: z.array(z.object({
          id: z.number().int().positive(), run_id: z.literal(r.id), name: z.string(), status: z.string(),
          conclusion: z.string().nullable(), labels: z.array(z.string()), html_url: z.string(),
          steps: z.array(z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable(), number: z.number().int() })).default([]),
        })).max(100) }).parse(await this.#call(['api', '--method', 'GET',
          `repos/${REPOSITORY}/actions/runs/${r.id}/attempts/${r.run_attempt}/jobs?per_page=100&page=${page}`], signal));
        for (const job of data.jobs) jobs.push({ id: job.id, name: job.name, status: job.status, conclusion: job.conclusion,
          labels: job.labels, platform: job.labels.some(x => /macos/i.test(x)) ? 'MACOS' : job.labels.some(x => /ubuntu/i.test(x)) ? 'UBUNTU' : 'OTHER',
          url: safeGitHubUrl(job.html_url), steps: job.steps,
          requiredMacSkip: job.name === 'r4t-macos' && (job.conclusion === 'skipped' || job.steps.some(s =>
            /Require a working macOS Seatbelt|Run the isolation suites with every check executed/.test(s.name) && s.conclusion === 'skipped')) });
        if (jobs.length === data.total_count) break;
        if (page === 2 || !data.jobs.length) throw new Error('GITHUB_JOBS_INCOMPLETE');
      }
      if (new Set(jobs.map(j => j.id)).size !== jobs.length) throw new Error('GITHUB_DUPLICATE_JOB');
      runs.push(ciSchema.parse({ id: r.id, attempt: r.run_attempt, number: r.run_number, name: r.name, sha: r.head_sha,
        branch: r.head_branch, status: r.status, conclusion: r.conclusion, event: r.event, updatedAt: r.updated_at,
        url: safeGitHubUrl(r.html_url), jobs }));
    }
    if (new Set(runs.map(r => r.id)).size !== runs.length) throw new Error('GITHUB_DUPLICATE_RUN');
    return runs;
  }
}
