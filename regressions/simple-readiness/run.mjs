// Live quality probe. Uses the existing MCP server and saves unmodified responses.
// node run.mjs /path/to/ai-collab-mcp /path/to/new-evidence-directory
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [projectArg, outputArg] = process.argv.slice(2);
if (!projectArg || !outputArg) throw new Error('Provide project and new evidence directory paths.');
const project = resolve(projectArg);
const outputDir = resolve(outputArg);
if (existsSync(outputDir)) throw new Error('Use a new directory to preserve prior observations.');
const fixtureText = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'cases.json'), 'utf8');
const cases = JSON.parse(fixtureText);
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const projectImport = (path) => import(pathToFileURL(join(project, path)).href);
process.chdir(project);
const requireProject = createRequire(join(project, 'package.json'));
const { Client } = await import(pathToFileURL(requireProject.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
const { StdioClientTransport } = await import(pathToFileURL(requireProject.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href);
const { BENCHMARK_ROSTER } = await projectImport('benchmark-task.mjs');
const { resolveRoster } = await projectImport('dist/agents/registry.js');
const { PROVIDERS } = await projectImport('dist/config.js');
const { buildOutputBanner } = await projectImport('dist/modes/orchestrator.js');

function fingerprints() {
  const files = ['benchmark-task.mjs', 'package.json', 'package-lock.json'];
  for (const root of ['src', 'dist']) {
    for (const entry of readdirSync(join(project, root), { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) files.push(join(entry.parentPath, entry.name).slice(project.length + 1));
    }
  }
  return Object.fromEntries(files.sort().map((file) => [file, sha256(readFileSync(join(project, file)))]));
}

const before = fingerprints();
const { workers } = resolveRoster(BENCHMARK_ROSTER);
mkdirSync(outputDir, { recursive: true });
const writeJson = (name, value) => writeFileSync(join(outputDir, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
writeJson('manifest.json', {
  startedAt: new Date().toISOString(),
  purpose: 'Worker user-facing readiness; two distinct cases, one observation each; not a latency distribution estimate.',
  fixtureSha256: sha256(fixtureText),
  nodeVersion: process.version,
  chief: { provider: 'openai', model: 'gpt-5' },
  synthesizer: { provider: 'openai', model: 'gpt-5' },
  roster: workers.map((worker) => ({ ...worker, model: worker.model ?? PROVIDERS[worker.provider].defaultModel })),
  fileSha256: before,
});

const transport = new StdioClientTransport({ command: process.execPath, args: [join(project, 'dist/index.js')], cwd: project });
const client = new Client({ name: 'simple-readiness-regression', version: '1.0.0' });
let failed = false;
try {
  await client.connect(transport);
  for (const fixture of cases) {
    const startedAt = new Date().toISOString();
    console.log(`${fixture.id} starting at ${startedAt}`);
    try {
      const response = await client.callTool({
        name: 'run_orchestrator',
        arguments: {
          task: fixture.task,
          orchestrator: { provider: 'openai', model: 'gpt-5' },
          workers: BENCHMARK_ROSTER,
          synthesizer: { provider: 'openai', model: 'gpt-5' },
        },
      }, undefined, { timeout: 900000 });
      writeJson(`${fixture.id}-mcp.json`, { startedAt, completedAt: new Date().toISOString(), task: fixture.task, response });
      if (response.isError) throw new Error(`MCP error; see ${fixture.id}-mcp.json`);
      const result = JSON.parse(response.content[0].text);
      const checks = {
        simple: result.plan.complexity === 'simple',
        singleAssignment: result.plan.assignments.length === 1,
        singleSuccessfulWorker: result.workerResults.length === 1 && typeof result.workerResults[0].output === 'string' && result.workerResults[0].output.length > 0 && !result.workerResults[0].error,
        successStatus: result.report.status === 'SUCCESS',
        synthesisExecuted: result.report.synthesisAllowed && result.timings.synthesisMs > 0 && typeof result.finalOutput === 'string' && result.finalOutput.length > 0,
        noBannerSoFinalIsRawSynthesis: buildOutputBanner(result.report) === '',
      };
      writeJson(`${fixture.id}.json`, { ...fixture, startedAt, completedAt: new Date().toISOString(), structuralChecks: checks, result });
      console.log(JSON.stringify({ id: fixture.id, structuralChecks: checks, result }, null, 2));
      if (Object.values(checks).some((value) => !value)) failed = true;
    } catch (error) {
      failed = true;
      writeJson(`${fixture.id}-error.json`, { startedAt, error: String(error) });
      console.error(`${fixture.id}: ${String(error)}`);
    }
  }
} finally {
  await client.close();
  const after = fingerprints();
  const unchanged = JSON.stringify(before) === JSON.stringify(after);
  writeJson('integrity.json', { completedAt: new Date().toISOString(), runtimeSourceAndBaselineUnchanged: unchanged, fileSha256: after });
  if (!unchanged) failed = true;
  if (failed) process.exitCode = 1;
}
