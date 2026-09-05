// Runs exactly one Step 7.1 live case and writes immutable evidence.
// node run-case.mjs /path/to/AI-Agent SIMPLE-direct|DEEP-grounded
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repo = resolve(scriptDir, '../..');
const [projectArg, caseId] = process.argv.slice(2);
if (!projectArg || !caseId) throw new Error('Provide the AI Agent project path and case ID.');

const project = resolve(projectArg);
const fixturesText = readFileSync(join(scriptDir, 'cases.json'), 'utf8');
const fixture = JSON.parse(fixturesText).find((item) => item.id === caseId);
if (!fixture) throw new Error(`Unknown case: ${caseId}`);
const outputDir = join(scriptDir, fixture.id);
if (existsSync(outputDir)) throw new Error(`Evidence already exists: ${outputDir}`);

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const writeJson = (name, value) =>
  writeFileSync(join(outputDir, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });

function filesBelow(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesBelow(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function runtimeFingerprint() {
  const paths = ['benchmark-task.mjs', 'package.json', 'package-lock.json', 'tsconfig.json'];
  for (const root of ['src', 'dist']) {
    paths.push(...filesBelow(join(project, root)).map((path) => relative(project, path)));
  }
  return Object.fromEntries(
    paths.sort().map((path) => [path, sha256(readFileSync(join(project, path)))])
  );
}

const before = runtimeFingerprint();
mkdirSync(outputDir, { recursive: false });
writeJson('task.json', fixture);

process.chdir(project);
const requireProject = createRequire(join(project, 'package.json'));
const importProject = (path) => import(pathToFileURL(join(project, path)).href);
const { Client } = await import(
  pathToFileURL(requireProject.resolve('@modelcontextprotocol/sdk/client/index.js')).href
);
const { StdioClientTransport } = await import(
  pathToFileURL(requireProject.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href
);
const { SIMPLE_TASK, BENCHMARK_ROSTER } = await importProject('benchmark-task.mjs');
const { resolveRoster } = await importProject('dist/agents/registry.js');
const { PROVIDERS } = await importProject('dist/config.js');
const { buildOutputBanner } = await importProject('dist/modes/orchestrator.js');

if (fixture.kind === 'simple_direct' && fixture.task !== SIMPLE_TASK) {
  throw new Error('SIMPLE fixture no longer matches the fixed benchmark task.');
}

const { workers } = resolveRoster(BENCHMARK_ROSTER);
const repoHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
const startedAt = new Date().toISOString();
writeJson('manifest.json', {
  startedAt,
  caseId: fixture.id,
  purpose: fixture.purpose,
  fixtureSha256: sha256(JSON.stringify(fixture)),
  repoHead,
  nodeVersion: process.version,
  chief: { provider: 'openai', model: 'gpt-5' },
  synthesizer: { provider: 'openai', model: 'gpt-5' },
  roster: workers.map((worker) => ({
    ...worker,
    model: worker.model ?? PROVIDERS[worker.provider].defaultModel,
  })),
  runtimeFileSha256: before,
});

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(project, 'dist/index.js')],
  cwd: project,
});
const client = new Client({ name: `step7-1-${fixture.id}`, version: '1.0.0' });
let response;
let completedAt;
try {
  await client.connect(transport);
  response = await client.callTool(
    {
      name: 'run_orchestrator',
      arguments: {
        task: fixture.task,
        orchestrator: { provider: 'openai', model: 'gpt-5' },
        workers: BENCHMARK_ROSTER,
        synthesizer: { provider: 'openai', model: 'gpt-5' },
      },
    },
    undefined,
    { timeout: 900000 }
  );
  completedAt = new Date().toISOString();
  writeJson('raw-mcp-response.json', { startedAt, completedAt, task: fixture.task, response });
  if (response.isError) throw new Error('MCP returned isError=true.');
  const textBlock = response.content.find((item) => item.type === 'text');
  if (!textBlock) throw new Error('MCP response has no text block.');
  const result = JSON.parse(textBlock.text);
  const synthesisExecuted = result.report.policy?.synthesize ?? result.report.synthesisAllowed;
  const logicalModelCallCount = 1 + result.plan.assignments.length + (synthesisExecuted ? 1 : 0);

  let structuralChecks;
  let observation;
  if (fixture.kind === 'simple_direct') {
    const worker = result.workerResults[0];
    const compact = String(result.finalOutput ?? '').replace(/[\s,，*_：:|]/gu, '');
    const c = compact.indexOf('C案48090元');
    const a = compact.indexOf('A案50400元');
    const b = compact.indexOf('B案55125元');
    structuralChecks = {
      complexitySimple: result.plan.complexity === 'simple',
      exactlyOneAssignment: result.plan.assignments.length === 1,
      exactlyOneSuccessfulWorker:
        result.workerResults.length === 1 && typeof worker?.output === 'string' && !worker?.error,
      statusSuccess: result.report.status === 'SUCCESS',
      evidenceNotApplicable: result.report.evidenceLabel === 'NOT_APPLICABLE',
      policySkipsSynthesis: result.report.policy?.synthesize === false,
      directDeliveryReason:
        result.report.policy?.reason === 'simple_single_specialist_direct_delivery',
      synthesisMsZero: result.timings.synthesisMs === 0,
      exactRawWorkerDelivery: result.finalOutput === worker?.output,
      noRetrievalMetadata: worker?.retrieval === undefined && result.report.retrieval === undefined,
      exactlyTwoLogicalModelCalls: logicalModelCallCount === 2,
      expectedArithmeticAndOrder: c >= 0 && a > c && b > a,
      nonEmptyUserFacingText: typeof result.finalOutput === 'string' && result.finalOutput.trim().length > 0,
    };
    observation = {
      selectedEvidenceAgentIds: [],
      groundedAgentIds: [],
      outputSha256: sha256(result.finalOutput ?? ''),
      workerOutputSha256: sha256(worker?.output ?? ''),
    };
  } else {
    const selectedIds = new Set(result.plan.assignments.map((assignment) => assignment.agentId));
    const evidenceIds = workers
      .filter((worker) => worker.evidenceCapable && selectedIds.has(worker.id))
      .map((worker) => worker.id);
    const evidenceResults = result.workerResults.filter((worker) => evidenceIds.includes(worker.agentId));
    const grounded = evidenceResults.filter((worker) => worker.retrieval?.status === 'GROUNDED');
    const workerSources = grounded.flatMap((worker) => worker.retrieval.sources ?? []);
    const reportSources = result.report.retrieval?.sources ?? [];
    const reportedQuerySum = evidenceResults
      .map((worker) => worker.retrieval?.queryCount)
      .filter((value) => typeof value === 'number')
      .reduce((sum, value) => sum + value, 0);
    const rawMetadata = grounded.map((worker) => worker.retrieval?.raw).filter(Boolean);
    const expectedBanner = buildOutputBanner(result.report);
    structuralChecks = {
      complexityDeep: result.plan.complexity === 'deep',
      evidenceCapabilitySelectedNaturally: evidenceIds.length >= 1,
      selectedEvidenceWorkerReceivedRetrievalResult:
        evidenceResults.length >= 1 && evidenceResults.every((worker) => worker.retrieval),
      atLeastOneGroundedWorker: grounded.length >= 1,
      workerQueryCountReported:
        grounded.some((worker) => (worker.retrieval?.queryCount ?? 0) >= 1),
      workerSourcesReported:
        grounded.some((worker) => (worker.retrieval?.sourcesFound ?? 0) >= 1),
      webSearchQueriesPreserved: rawMetadata.some(
        (raw) => Array.isArray(raw.webSearchQueries) && raw.webSearchQueries.length >= 1
      ),
      groundingChunksPreserved: rawMetadata.some(
        (raw) => Array.isArray(raw.groundingChunks) && raw.groundingChunks.length >= 1
      ),
      groundingSupportsPreserved: rawMetadata.some(
        (raw) => Array.isArray(raw.groundingSupports) && raw.groundingSupports.length >= 1
      ),
      runStatusAllowsSynthesis: ['SUCCESS', 'DEGRADED'].includes(result.report.status),
      policyKeepsSynthesis: result.report.policy?.synthesize === true,
      synthesisActuallyRan: synthesisExecuted === true && result.timings.synthesisMs > 0,
      evidenceLabelPartial: result.report.evidenceLabel === 'PARTIALLY_GROUNDED',
      reportShowsGroundedSpecialist: (result.report.retrieval?.specialistsGrounded ?? 0) >= 1,
      reportQueryCountPreserved:
        reportedQuerySum >= 1 && result.report.retrieval?.queryCount === reportedQuerySum,
      reportSourcesPreserved:
        workerSources.length >= 1 &&
        workerSources.every((source) => reportSources.some((item) => item.url === source.url)),
      conservativeBannerPreserved:
        expectedBanner.includes('PARTIALLY GROUNDED') &&
        expectedBanner.includes('claims not yet validated') &&
        result.finalOutput.startsWith(expectedBanner),
      neverClaimsEvidenceBacked:
        !JSON.stringify({ report: result.report, finalOutput: result.finalOutput }).includes('EVIDENCE_BACKED'),
    };
    observation = {
      selectedEvidenceAgentIds: evidenceIds,
      groundedAgentIds: grounded.map((worker) => worker.agentId),
      workerRetrieval: evidenceResults.map((worker) => ({
        agentId: worker.agentId,
        status: worker.retrieval?.status,
        queryCount: worker.retrieval?.queryCount,
        sourcesFound: worker.retrieval?.sourcesFound,
        queries: worker.retrieval?.queries,
        rawMetadataKeys: Object.keys(worker.retrieval?.raw ?? {}),
      })),
      reportRetrieval: result.report.retrieval,
      expectedBanner,
    };
  }

  const allChecksPass = Object.values(structuralChecks).every(Boolean);
  const outcome =
    fixture.kind === 'deep_grounded' && !structuralChecks.evidenceCapabilitySelectedNaturally
      ? 'TEST_NOT_EXERCISED'
      : allChecksPass
        ? 'PASS'
        : 'FAIL';
  writeJson('normalized-result.json', {
    caseId: fixture.id,
    startedAt,
    completedAt,
    outcome,
    logicalModelCallCount,
    structuralChecks,
    observation,
    result,
  });
  console.log(JSON.stringify({ caseId: fixture.id, outcome, logicalModelCallCount, structuralChecks, observation }, null, 2));
  if (outcome !== 'PASS') process.exitCode = 1;
} catch (error) {
  completedAt ??= new Date().toISOString();
  if (!existsSync(join(outputDir, 'error.json'))) {
    writeJson('error.json', { startedAt, completedAt, error: String(error) });
  }
  console.error(String(error));
  process.exitCode = 1;
} finally {
  await client.close();
  const after = runtimeFingerprint();
  const unchanged = JSON.stringify(before) === JSON.stringify(after);
  writeJson('integrity.json', {
    completedAt: new Date().toISOString(),
    runtimeSourceAndBuildUnchanged: unchanged,
    runtimeFileSha256: after,
  });
  if (!unchanged) process.exitCode = 1;
}
