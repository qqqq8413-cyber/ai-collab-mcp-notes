// M2-A controlled frozen Round-1 replay diagnostic.
//
// Planning and Round 1 are a synthetic fixture and are NOT under test. Everything from the
// synthesis gate onwards is the real committed runtime, reached through the existing
// replaySynthesis() entry point -- which delegates to the same runSynthesisStage() the live
// orchestrator uses. No trigger flag, no bypass, and no second implementation of the gate,
// parser, chunk resolver, Round 2 builder or decision synthesis.
//
// The injected dispatcher is a pass-through recorder: identical arguments forwarded to the
// real callProvider, with the constructed prompt stored so the prompt-content checks are
// answered from an artifact rather than from reading the source.
// Paths were parameterised after the run so the published record carries no local
// username. Nothing else changed; the artifact beside this file is the original output.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const BASE = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
const CR = `${BASE}/diagnostics/m2a-live/controlled-replay`;
const { replaySynthesis, buildRunReport, buildOutputBanner } = await import(`${BASE}/dist/modes/orchestrator.js`);
const { callProvider } = await import(`${BASE}/dist/providers/index.js`);
const { resolveRoster } = await import(`${BASE}/dist/agents/registry.js`);
const { segmentAll } = await import(`${BASE}/dist/agents/collaboration.js`);

const read = (f) => readFileSync(`${CR}/${f}`, 'utf-8');
const sha = (t) => createHash('sha256').update(t).digest('hex');

const TASK = read('task.txt');
const MISSION = {
  business_strategist: read('mission-business_strategist.txt'),
  brand_creative: read('mission-brand_creative.txt'),
};
const ROUND1 = {
  business_strategist: read('round1-business_strategist.md'),
  brand_creative: read('round1-brand_creative.md'),
};

// Real registry definitions: agent capabilities are not redefined for the diagnostic.
const roster = resolveRoster(['business_strategist', 'brand_creative']);
if (roster.warnings.length) console.log('roster warnings:', roster.warnings);
const agentOrder = ['business_strategist', 'brand_creative'];

const workerResults = agentOrder.map((id) => ({
  agentId: id,
  provider: roster.workers.find((w) => w.id === id).provider,
  mission: MISSION[id],
  output: ROUND1[id],
}));

const snapshot = {
  task: TASK,
  complexity: 'deep',
  agentOrder,
  workers: roster.workers,
  workerResults,
};

// Chunking is done by the real runtime chunker, never hand-written in the fixture.
const chunks = segmentAll(workerResults);
console.log('chunk counts:', Object.fromEntries(Object.entries(chunks).map(([k, v]) => [k, v.length])));

// The report the fixture implies, computed before any live call, for the before/after check.
const reportBefore = buildRunReport(snapshot.complexity, roster.workers, workerResults);
const bannerBefore = buildOutputBanner(reportBefore);
console.log('fixture report:', reportBefore.status, '/', reportBefore.evidenceLabel);

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
  console.log(`  live call ${entry.seq}: ${entry.stage} -> ${provider}`);
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

console.log('\nstarting controlled replay (live provider calls from the gate onwards)...');
const startedAt = new Date().toISOString();
const liveStart = Date.now();
const result = await replaySynthesis(snapshot, {
  synthesizer: { provider: 'openai', model: 'gpt-5' },
  collaboration: { enabled: true },
  call: record,
});
const totalLiveMs = Date.now() - liveStart;

const reportAfter = result.report;
const bannerAfter = buildOutputBanner(reportAfter);
// Recomputed from the frozen Round 1 alone. If Round 2 had leaked into the evidence path
// this would disagree with the report the run returned.
const recomputed = buildRunReport(snapshot.complexity, roster.workers, workerResults);

writeFileSync(`${CR}/artifact.json`, JSON.stringify({
  startedAt,
  finishedAt: new Date().toISOString(),
  fixtureType: 'SYNTHETIC DIAGNOSTIC FIXTURE',
  planningUnderTest: false,
  round1UnderTest: false,
  fixtureHashes: {
    task: sha(TASK),
    missions: Object.fromEntries(Object.entries(MISSION).map(([k, v]) => [k, sha(v)])),
    round1: Object.fromEntries(Object.entries(ROUND1).map(([k, v]) => [k, sha(v)])),
  },
  snapshot: { task: TASK, complexity: snapshot.complexity, agentOrder, workerResults },
  roster: roster.workers.map((w) => ({ id: w.id, provider: w.provider, model: w.model ?? null, evidenceCapable: !!w.evidenceCapable })),
  chunkDetail: chunks,
  chunkCounts: Object.fromEntries(Object.entries(chunks).map(([k, v]) => [k, v.length])),
  reportBefore: { status: reportBefore.status, evidenceLabel: reportBefore.evidenceLabel, retrieval: reportBefore.retrieval ?? null, notes: reportBefore.notes },
  bannerBefore,
  reportAfter: { status: reportAfter.status, evidenceLabel: reportAfter.evidenceLabel, retrieval: reportAfter.retrieval ?? null, notes: reportAfter.notes },
  bannerAfter,
  recomputedFromFrozenRound1: { status: recomputed.status, evidenceLabel: recomputed.evidenceLabel, retrieval: recomputed.retrieval ?? null },
  collaboration: result.collaboration ?? null,
  finalOutput: result.finalOutput,
  timings: result.timings,
  totalLiveMs,
  calls,
}, null, 2));

const c = result.collaboration;
console.log('\n=== SUMMARY ===');
console.log('live calls      :', calls.length, '|', calls.map((x) => x.stage).join(' -> '));
console.log('collaboration   :', c?.status, '/', c?.reason);
console.log('issues          :', JSON.stringify(c?.issues && { raw: c.issues.emitted, valid: c.issues.valid, eligible: c.issues.eligible, rejected: c.issues.rejected.length }));
console.log('selectedIssue   :', JSON.stringify(c?.selectedIssue ?? null));
console.log('round2 excerpt  :', JSON.stringify(c?.round2?.peerExcerpt ?? null));
console.log('answerSource    :', c?.answerSource);
console.log('status/evidence :', reportAfter.status, '/', reportAfter.evidenceLabel);
console.log('timings         :', JSON.stringify(result.timings), '| collab:', JSON.stringify(c?.timings));
console.log('totalLiveMs     :', totalLiveMs);
console.log('\nartifact -> diagnostics/m2a-live/controlled-replay/artifact.json');
