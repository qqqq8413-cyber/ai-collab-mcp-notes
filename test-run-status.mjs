import assert from 'node:assert/strict';
import { buildRunReport, buildOutputBanner, buildWorkerPrompt } from './dist/modes/orchestrator.js';

// Resolved workers, as resolveRoster would produce them: `evidenceCapable` is already
// derived from the model registry by the time the orchestrator sees a roster.
const workers = [
  { id: 'business_strategist', provider: 'claude', role: 'strategy' },
  { id: 'brand_creative', provider: 'openai', role: 'brand' },
  { id: 'market_researcher', provider: 'gemini', role: 'research', evidenceCapable: true },
];

const ok = (agentId, provider) => ({ agentId, provider, mission: 'm', output: 'result text' });
const bad = (agentId, provider) => ({ agentId, provider, mission: 'm', error: 'Error: boom' });

const withRetrieval = (agentId, provider, retrieval) => ({ ...ok(agentId, provider), retrieval });

const grounded = (agentId = 'market_researcher', provider = 'gemini', sourcesFound = 2) =>
  withRetrieval(agentId, provider, {
    status: 'GROUNDED',
    queries: ['q1', 'q2'],
    queryCount: 2,
    sources: Array.from({ length: sourcesFound }, (_, i) => ({
      url: `https://example.com/${i}`,
      title: `Source ${i}`,
    })),
    sourcesFound,
  });

const searchedNothing = (agentId = 'market_researcher', provider = 'gemini') =>
  withRetrieval(agentId, provider, {
    status: 'UNGROUNDED',
    queries: [],
    sources: [],
    sourcesFound: 0,
    note: 'Search was offered but the model answered without it.',
  });

const retrievalFailed = (agentId = 'market_researcher', provider = 'gemini') =>
  withRetrieval(agentId, provider, {
    status: 'FAILED',
    queries: [],
    sources: [],
    sourcesFound: 0,
    note: 'no grounded retrieval enabled',
  });

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}\n      ${err.message.split('\n')[0]}`);
    failed++;
  }
}

console.log('\nRun status');

check('all specialists return -> SUCCESS, synthesis allowed', () => {
  const r = buildRunReport('normal', workers, [ok('business_strategist', 'claude'), ok('brand_creative', 'openai')]);
  assert.equal(r.status, 'SUCCESS');
  assert.equal(r.successfulWorkers, 2);
  assert.equal(r.failedWorkers, 0);
  assert.equal(r.synthesisAllowed, true);
});

check('one of two fails -> DEGRADED, synthesis still allowed', () => {
  const r = buildRunReport('normal', workers, [ok('business_strategist', 'claude'), bad('brand_creative', 'openai')]);
  assert.equal(r.status, 'DEGRADED');
  assert.equal(r.successfulWorkers, 1);
  assert.equal(r.failedWorkers, 1);
  assert.equal(r.synthesisAllowed, true);
  assert.equal(r.failures[0].agentId, 'brand_creative');
});

check('every specialist fails -> FAILED, synthesis blocked', () => {
  const r = buildRunReport('normal', workers, [bad('business_strategist', 'claude'), bad('brand_creative', 'openai')]);
  assert.equal(r.status, 'FAILED');
  assert.equal(r.successfulWorkers, 0);
  assert.equal(r.synthesisAllowed, false);
});

console.log('\nEvidence label');

check('non-deep task -> NOT_APPLICABLE', () => {
  const r = buildRunReport('normal', workers, [ok('business_strategist', 'claude'), ok('brand_creative', 'openai')]);
  assert.equal(r.evidenceLabel, 'NOT_APPLICABLE');
});

check('deep with no evidence specialist recruited -> HYPOTHESIS', () => {
  const r = buildRunReport('deep', workers, [ok('business_strategist', 'claude'), ok('brand_creative', 'openai')]);
  assert.equal(r.status, 'SUCCESS');
  assert.equal(r.evidenceLabel, 'HYPOTHESIS');
  assert.match(r.notes.join(' '), /no evidence-gathering specialist/);
});

check('deep with real grounded retrieval -> PARTIALLY_GROUNDED, never better', () => {
  const r = buildRunReport('deep', workers, [ok('business_strategist', 'claude'), grounded()]);
  assert.equal(r.evidenceLabel, 'PARTIALLY_GROUNDED');
  assert.match(r.notes.join(' '), /has not been checked/);
});

check('a grounded specialist does not make the whole answer evidence-backed', () => {
  // The ceiling is deliberate: claim-level coverage is the Validation Layer's job.
  const r = buildRunReport('deep', workers, [grounded()]);
  assert.notEqual(r.evidenceLabel, 'EVIDENCE_BACKED');
  assert.match(r.notes.join(' '), /Validation Layer/);
});

check('recruited but the model chose not to search -> CONDITIONAL', () => {
  const r = buildRunReport('deep', workers, [ok('business_strategist', 'claude'), searchedNothing()]);
  assert.equal(r.status, 'SUCCESS', 'the worker itself succeeded');
  assert.equal(r.evidenceLabel, 'CONDITIONAL', 'but nothing was gathered');
});

check('recruited but retrieval failed -> CONDITIONAL, not grounded', () => {
  const r = buildRunReport('deep', workers, [ok('business_strategist', 'claude'), retrievalFailed()]);
  assert.equal(r.evidenceLabel, 'CONDITIONAL');
  assert.match(r.notes.join(' '), /nothing was gathered/);
});

check('recruited but the specialist errored -> CONDITIONAL', () => {
  const r = buildRunReport('deep', workers, [
    ok('business_strategist', 'claude'),
    bad('market_researcher', 'gemini'),
  ]);
  assert.equal(r.status, 'DEGRADED');
  assert.equal(r.evidenceLabel, 'CONDITIONAL');
});

check('grounding survives another specialist failing', () => {
  const r = buildRunReport('deep', workers, [bad('business_strategist', 'claude'), grounded()]);
  assert.equal(r.status, 'DEGRADED');
  assert.equal(r.evidenceLabel, 'PARTIALLY_GROUNDED');
});

check('label never depends on the Chief saying research was unnecessary', () => {
  const results = [ok('business_strategist', 'claude'), ok('brand_creative', 'openai')];
  assert.equal(buildRunReport('simple', workers, results).evidenceLabel, 'NOT_APPLICABLE');
  assert.equal(buildRunReport('normal', workers, results).evidenceLabel, 'NOT_APPLICABLE');
  assert.equal(buildRunReport('deep', workers, results).evidenceLabel, 'HYPOTHESIS');
});

console.log('\nRetrieval reporting');

check('no retrieval attempted -> no retrieval section at all', () => {
  const r = buildRunReport('deep', workers, [ok('business_strategist', 'claude')]);
  assert.equal(r.retrieval, undefined);
});

check('sources and reported query counts are carried through', () => {
  const r = buildRunReport('deep', workers, [grounded('market_researcher', 'gemini', 3)]);
  assert.equal(r.retrieval.specialistsAsked, 1);
  assert.equal(r.retrieval.specialistsGrounded, 1);
  assert.equal(r.retrieval.sourcesFound, 3);
  assert.equal(r.retrieval.queryCount, 2);
  assert.equal(r.retrieval.sources.length, 3);
  assert.match(r.retrieval.sources[0].url, /^https:\/\//);
});

check('an unreported query count stays undefined rather than becoming zero', () => {
  const noCount = withRetrieval('market_researcher', 'gemini', {
    status: 'GROUNDED',
    queries: [],
    sources: [{ url: 'https://example.com' }],
    sourcesFound: 1,
  });
  const r = buildRunReport('deep', workers, [noCount]);
  assert.equal(r.retrieval.queryCount, undefined, 'must not fabricate a measurement');
  assert.equal(r.retrieval.sourcesFound, 1);
});

check('an ungrounded attempt is still counted as asked, not as grounded', () => {
  const r = buildRunReport('deep', workers, [searchedNothing()]);
  assert.equal(r.retrieval.specialistsAsked, 1);
  assert.equal(r.retrieval.specialistsGrounded, 0);
  assert.equal(r.retrieval.sourcesFound, 0);
});

console.log('\nOutput banner');

const banner = (complexity, results) =>
  buildOutputBanner(buildRunReport(complexity, workers, results));

check('clean non-deep run gets no banner', () => {
  const b = banner('normal', [ok('business_strategist', 'claude'), ok('brand_creative', 'openai')]);
  assert.equal(b, '');
});

check('HYPOTHESIS run is marked on the deliverable, not just in metadata', () => {
  const b = banner('deep', [ok('business_strategist', 'claude'), ok('brand_creative', 'openai')]);
  assert.match(b, /UNVERIFIED — HYPOTHESIS/);
  assert.match(b, /hypothesis to be validated, not as a conclusion/);
  assert.ok(b.endsWith('\n\n'), 'banner must be separated from the answer body');
});

check('CONDITIONAL run is marked too', () => {
  const b = banner('deep', [ok('business_strategist', 'claude'), searchedNothing()]);
  assert.match(b, /UNVERIFIED — CONDITIONAL/);
});

check('a grounded run is still marked, because grounded is not validated', () => {
  const b = banner('deep', [ok('business_strategist', 'claude'), grounded()]);
  assert.match(b, /PARTIALLY GROUNDED — claims not yet validated/);
  assert.match(b, /whether the figures and claims below are the ones those sources support/);
});

check('DEGRADED run names the missing specialists', () => {
  const b = banner('normal', [ok('business_strategist', 'claude'), bad('brand_creative', 'openai')]);
  assert.match(b, /DEGRADED — 1\/2 specialists returned/);
  assert.match(b, /Missing: brand_creative/);
});

check('a run that is both unevidenced and degraded shows both warnings', () => {
  const b = banner('deep', [ok('business_strategist', 'claude'), bad('brand_creative', 'openai')]);
  assert.match(b, /UNVERIFIED — HYPOTHESIS/);
  assert.match(b, /DEGRADED — 1\/2/);
});

console.log('\nWorker context propagation');

const originalTask =
  '請用表格整理台灣市場方案，預算不得超過 NT$300,000，不要用降價策略。先結論再理由。';
const assignedMission = 'Summarize market opportunities and external evidence only.';
const workerPrompt = buildWorkerPrompt(originalTask, assignedMission);

check('worker prompt carries original task and assigned mission separately', () => {
  assert.match(workerPrompt, /^Original task:/m);
  assert.match(workerPrompt, /^Assigned mission:/m);
  assert.match(workerPrompt, /請用表格整理台灣市場方案/);
  assert.match(workerPrompt, /Summarize market opportunities/);
  assert.ok(
    workerPrompt.indexOf(originalTask) < workerPrompt.indexOf(assignedMission),
    'original task should remain visible before the delegated mission'
  );
});

check('worker prompt names the task-level context dimensions that must survive delegation', () => {
  assert.match(workerPrompt, /user language/);
  assert.match(workerPrompt, /requested format/);
  assert.match(workerPrompt, /constraints/);
  assert.match(workerPrompt, /scope/);
  assert.match(workerPrompt, /explicit exclusions/);
});

check('worker prompt preserves mission scope instead of letting the worker take over', () => {
  assert.match(workerPrompt, /Execute only the assigned mission/);
  assert.match(workerPrompt, /Do not take over the full task/);
  assert.match(workerPrompt, /outside this mission/);
  assert.match(workerPrompt, /answer only the part relevant to your assigned mission/);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
