// M2-A diagnostic live #2. Runtime used exactly as committed at d1d1d28.
// The injected dispatcher is a pass-through recorder: identical arguments forwarded to the
// real callProvider, with the constructed prompt stored so section 9 can be answered from
// an artifact rather than from reading the source.
// Paths were parameterised after the run so the published record carries no local
// username. Nothing else changed; the artifact beside this file is the original output.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const BASE = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
const { runOrchestrator, buildRunReport, buildOutputBanner } = await import(`${BASE}/m2/dist/modes/orchestrator.js`);
const { callProvider } = await import(`${BASE}/m2/dist/providers/index.js`);
const { resolveRoster } = await import(`${BASE}/m2/dist/agents/registry.js`);
const { segmentAll } = await import(`${BASE}/m2/dist/agents/collaboration.js`);

const TASK = readFileSync(`${BASE}/diagnostics/m2a-live/run2-planning-reachable/fixture.txt`, 'utf-8');
const taskSha = createHash('sha256').update(TASK).digest('hex');
console.log('fixture chars:', TASK.length, 'sha256:', taskSha);

const calls = [];
const record = async (provider, prompt, options = {}) => {
  const started = Date.now();
  const entry = {
    seq: calls.length + 1,
    stage: options.stage ?? null,
    provider,
    model: options.model ?? null,
    system: options.system ?? null,
    retrievalRequested: options.retrieval ?? null,
    promptChars: prompt.length,
    prompt,
  };
  calls.push(entry);
  try {
    const result = await callProvider(provider, prompt, options);
    entry.ms = Date.now() - started;
    entry.responseModel = result.model;
    entry.responseChars = result.text.length;
    entry.responseText = result.text;
    entry.retrievalResult = result.retrieval ?? null;
    return result;
  } catch (err) {
    entry.ms = Date.now() - started;
    entry.error = String(err);
    throw err;
  }
};

const roster = resolveRoster(['business_strategist', 'market_researcher', 'brand_creative']);
console.log('roster warnings:', roster.warnings.length ? roster.warnings : 'none');
console.log('starting diagnostic #2...');

const startedAt = new Date().toISOString();
const result = await runOrchestrator({
  task: TASK,
  orchestrator: { provider: 'openai', model: 'gpt-5' },
  workers: roster.workers,
  synthesizer: { provider: 'openai', model: 'gpt-5' },
  call: record,
  experimental: { collaboration: { enabled: true } },
});

const recomputed = buildRunReport(result.plan.complexity, roster.workers, result.workerResults);
const chunks = segmentAll(result.workerResults.filter((r) => r.output !== undefined));

writeFileSync(`${BASE}/diagnostics/m2a-live/run2-planning-reachable/artifact.json`, JSON.stringify({
  startedAt,
  finishedAt: new Date().toISOString(),
  taskSha256: taskSha,
  task: TASK,
  roster: roster.workers.map((w) => ({ id: w.id, provider: w.provider, model: w.model ?? null, evidenceCapable: !!w.evidenceCapable })),
  plan: result.plan,
  planningAdjustments: result.planningAdjustments,
  workerResults: result.workerResults,
  report: result.report,
  recomputedReportFromRound1: {
    status: recomputed.status,
    evidenceLabel: recomputed.evidenceLabel,
    retrieval: recomputed.retrieval,
    notes: recomputed.notes,
  },
  bannerFromRound1Report: buildOutputBanner(result.report),
  collaboration: result.collaboration ?? null,
  chunkDetail: chunks,
  chunkCounts: Object.fromEntries(Object.entries(chunks).map(([k, v]) => [k, v.length])),
  finalOutput: result.finalOutput,
  timings: result.timings,
  calls,
}, null, 2));

console.log('\n=== SUMMARY ===');
console.log('complexity      :', result.plan.complexity);
console.log('assignments     :', result.plan.assignments.map((a) => a.agentId).join(', '), `(N=${result.plan.assignments.length})`);
console.log('requiresRedTeam :', result.plan.requiresRedTeam);
console.log('logical calls   :', calls.length);
console.log('stages          :', calls.map((c) => c.stage).join(' -> '));
console.log('status/evidence :', result.report.status, '/', result.report.evidenceLabel);
console.log('collaboration   :', result.collaboration?.status, '/', result.collaboration?.reason);
console.log('issues          :', JSON.stringify({ raw: result.collaboration?.issues?.emitted, valid: result.collaboration?.issues?.valid, eligible: result.collaboration?.issues?.eligible }));
console.log('chunk counts    :', JSON.stringify(Object.fromEntries(Object.entries(chunks).map(([k, v]) => [k, v.length]))));
console.log('timings         :', JSON.stringify(result.timings));
console.log('collab timings  :', JSON.stringify(result.collaboration?.timings));
console.log('\nartifact -> written next to this harness.');
