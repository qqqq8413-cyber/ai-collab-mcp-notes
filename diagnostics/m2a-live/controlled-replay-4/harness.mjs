// Replay #4: read the immutable Replay #3 fixture, forward actual runtime calls once.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { replaySynthesis, buildRunReport, buildOutputBanner } from '../../../dist/modes/orchestrator.js';
import { callProvider } from '../../../dist/providers/index.js';
import { resolveRoster } from '../../../dist/agents/registry.js';
import { PROVIDERS } from '../../../dist/config.js';
import { buildGateAppendix, segmentAll, resolveSourceRef, buildPeerExcerpt, buildRound2Prompt, parseGateOutput, selectIssue } from '../../../dist/agents/collaboration.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const directory = fileURLToPath(new URL('./', import.meta.url));
const fixtureDirectory = join(root, 'diagnostics/m2a-live/controlled-replay');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const baselineCommit = 'aedc9efe0ff1f4acf7d5a36d9a1b3ab87e5b9af8';
const mode = process.argv[2];
assert.ok(['--preflight', '--live'].includes(mode), 'Choose --preflight or --live');
const previous = readJson(join(fixtureDirectory, 'artifact.json'));
const expectedHashes = readJson(join(fixtureDirectory, 'fixture-hashes.json'));
const fixtureHashes = {};
for (const [file, expected] of Object.entries(expectedHashes)) {
  const bytes = readFileSync(join(fixtureDirectory, file));
  fixtureHashes[file] = { chars: bytes.toString('utf8').length, sha256: sha(bytes) };
  assert.deepEqual(fixtureHashes[file], expected, file);
  assert.deepEqual(bytes, execFileSync('git', ['show', baselineCommit + ':diagnostics/m2a-live/controlled-replay/' + file], { cwd: root }));
}
const read = (file) => readFileSync(join(fixtureDirectory, file), 'utf8');
const agentOrder = [...previous.snapshot.agentOrder];
const roster = resolveRoster(agentOrder);
assert.deepEqual(roster.warnings, []);
const workerResults = agentOrder.map((id) => ({
  agentId: id,
  provider: roster.workers.find((w) => w.id === id).provider,
  mission: read('mission-' + id + '.txt'),
  output: read('round1-' + id + '.md'),
}));
const snapshot = {
  task: read('task.txt'), complexity: previous.snapshot.complexity, agentOrder, workerResults,
};
assert.deepEqual(snapshot, previous.snapshot);
assert.equal(sha(JSON.stringify(snapshot)), sha(JSON.stringify(previous.snapshot)));
assert.deepEqual(roster.workers.map((w) => ({
  id: w.id, provider: w.provider, model: w.model ?? null, evidenceCapable: !!w.evidenceCapable,
})), previous.roster);
const runtimeSnapshot = { ...snapshot, workers: roster.workers };
const frozenSnapshot = JSON.stringify(runtimeSnapshot);
const reportBefore = buildRunReport(snapshot.complexity, roster.workers, workerResults);
const reportFields = (r) => ({
  status: r.status, evidenceLabel: r.evidenceLabel, retrieval: r.retrieval ?? null, notes: r.notes,
});
assert.deepEqual(reportFields(reportBefore), previous.reportBefore);
const bannerBefore = buildOutputBanner(reportBefore);
assert.equal(bannerBefore, previous.bannerBefore);
const chunks = segmentAll(workerResults);
assert.deepEqual(chunks, previous.chunkDetail);
const oldGate = previous.calls.find((c) => c.stage === 'synthesis_gate');
const boundary = oldGate.prompt.indexOf('\n\nOptional collaboration block');
assert.ok(boundary > 0);
const expectedGatePrompt = oldGate.prompt.slice(0, boundary) + buildGateAppendix(agentOrder, chunks);
const marker = '- At most one "peer_challenge"';
assert.equal(expectedGatePrompt.slice(expectedGatePrompt.indexOf(marker)), oldGate.prompt.slice(oldGate.prompt.indexOf(marker)));
assert.equal(
  expectedGatePrompt.slice(0, expectedGatePrompt.indexOf('- Evaluate peer-challenge eligibility')),
  oldGate.prompt.slice(0, oldGate.prompt.indexOf('- Raise an issue only where'))
);
const controlBefore = readFileSync(join(directory, 'control-before.json'));
assert.deepEqual(controlBefore, readFileSync(join(directory, 'control-after.json')));
for (const [file, count] of [['npm-test-before.log', 208], ['npm-test-after.log', 212]]) {
  const log = readFileSync(join(directory, file), 'utf8');
  const totals = [...log.matchAll(/^(\d+) passed, (\d+) failed$/gm)];
  assert.equal(totals.reduce((sum, m) => sum + Number(m[1]), 0), count);
  assert.equal(totals.reduce((sum, m) => sum + Number(m[2]), 0), 0);
}
function filesBelow(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}
function fingerprint() {
  return Object.fromEntries([
    ...git('ls-files', 'src', 'package.json', 'package-lock.json', 'tsconfig.json').split('\n').map((p) => join(root, p)),
    ...filesBelow(join(root, 'dist')),
  ].sort().map((path) => [relative(root, path), sha(readFileSync(path))]));
}
assert.equal(git('diff', '--name-only', baselineCommit, '--', 'src'), 'src/agents/collaboration.ts');
assert.equal(git('diff', '--name-only', '--', 'src'), '');
const preflight = {
  baselineCommit, runtimeCommit: git('rev-parse', 'HEAD'), branch: git('branch', '--show-current'),
  workingTree: git('status', '--porcelain'), nodeVersion: process.version,
  fixtureHashes, replay3SnapshotSha256: sha(JSON.stringify(previous.snapshot)),
  replay4SnapshotSha256: sha(JSON.stringify(snapshot)), byteIdenticalFixtureVerified: true,
  replay3ArtifactSha256: sha(readFileSync(join(fixtureDirectory, 'artifact.json'))),
  controlCases: 16, controlSha256: sha(controlBefore), controlByteEquivalent: true,
  offlineTests: { before: 208, after: 212, failed: 0 },
  gateProvider: oldGate.provider, gateModel: oldGate.model,
  expectedGatePromptSha256: sha(expectedGatePrompt), gateChangedOnlyEligibility: true,
  round2DefaultModels: Object.fromEntries(roster.workers.map((w) => [w.id, w.model ?? PROVIDERS[w.provider].defaultModel])),
  runtimeFingerprint: fingerprint(),
};
const secrets = Object.values(PROVIDERS).map((p) => p.apiKey).filter((s) => typeof s === 'string' && s.length > 12);
function save(name, value, exclusive = false) {
  const text = JSON.stringify(value, null, 2) + '\n';
  assert.ok(!secrets.some((secret) => text.includes(secret)), 'Credential detected; artifact write blocked');
  assert.doesNotMatch(text, /sk-(?:proj-|ant-)?[A-Za-z0-9_-]{30,}|AIza[A-Za-z0-9_-]{30,}/);
  writeFileSync(join(directory, name), text, { flag: exclusive ? 'wx' : 'w' });
}
if (mode === '--preflight') {
  save('preflight.json', preflight);
  console.log(JSON.stringify(preflight, (key, value) => key === 'runtimeFingerprint' ? '(saved)' : value, 2));
} else {
  for (const provider of new Set([oldGate.provider, ...roster.workers.map((w) => w.provider)])) {
    assert.ok(PROVIDERS[provider].apiKey, 'Missing credentials: ' + provider);
  }
  const state = {
    startedAt: new Date().toISOString(), fixtureType: 'SYNTHETIC DIAGNOSTIC FIXTURE',
    planningUnderTest: false, round1UnderTest: false, preflight,
    snapshot, roster: previous.roster, chunkDetail: chunks, reportBefore, bannerBefore, calls: [],
  };
  save('attempt.json', { startedAt: state.startedAt, runtimeCommit: preflight.runtimeCommit, maxLiveReplays: 1 }, true);
  save('artifact.json', state, true);
  const checkpoint = () => save('artifact.json', state);
  const record = async (provider, prompt, options = {}) => {
    assert.ok(['synthesis_gate', 'round2_worker', 'decision_synthesis'].includes(options.stage));
    assert.ok(!state.calls.some((c) => c.stage === options.stage), 'No stage rerun allowed');
    if (options.stage === 'synthesis_gate') {
      assert.equal(prompt, expectedGatePrompt);
      assert.equal(provider, oldGate.provider);
      assert.equal(options.model, oldGate.model);
      assert.equal(options.system ?? null, oldGate.system);
    }
    const entry = {
      seq: state.calls.length + 1, stage: options.stage, provider,
      model: options.model ?? null, system: options.system ?? null,
      options: { ...options }, retrievalRequested: options.retrieval ?? null,
      prompt, promptChars: prompt.length, startedAt: new Date().toISOString(),
    };
    state.calls.push(entry);
    checkpoint();
    console.log('live call ' + entry.seq + ': ' + entry.stage + ' -> ' + provider);
    const started = Date.now();
    try {
      const response = await callProvider(provider, prompt, options);
      Object.assign(entry, {
        ms: Date.now() - started, responseModel: response.model, responseText: response.text,
        responseChars: response.text.length, retrievalResult: response.retrieval ?? null,
      });
      return response;
    } catch (error) {
      Object.assign(entry, { ms: Date.now() - started, error: String(error) });
      throw error;
    } finally {
      checkpoint();
    }
  };
  const started = Date.now();
  try {
    const result = await replaySynthesis(runtimeSnapshot, {
      synthesizer: { provider: oldGate.provider, model: oldGate.model },
      collaboration: { enabled: true }, call: record,
    });
    state.result = result;
    state.totalLiveMs = Date.now() - started;
    state.reportAfter = result.report;
    state.bannerAfter = buildOutputBanner(result.report);
    state.snapshotUnchanged = JSON.stringify(runtimeSnapshot) === frozenSnapshot;
    state.recomputedFromFrozenRound1 = buildRunReport(snapshot.complexity, roster.workers, workerResults);
    const c = result.collaboration;
    const parsed = parseGateOutput(state.calls[0].responseText);
    state.parserReplay = parsed;
    state.deterministicSelectionReplay = selectIssue(c.issues.recorded, agentOrder) ?? null;
    state.selectionFallbackUsed = c.issues.eligible > 1;
    state.selectedCount = c.selectedIssue ? 1 : 0;
    const r2 = state.calls.find((call) => call.stage === 'round2_worker');
    const decision = state.calls.find((call) => call.stage === 'decision_synthesis');
    state.resolved = c.selectedIssue ? resolveSourceRef(c.selectedIssue.sourceRef, chunks) : null;
    if (state.resolved?.ok && c.round2) {
      const resolved = state.resolved;
      const target = workerResults.find((r) => r.agentId === c.selectedIssue.targetAgentId);
      const excerpt = buildPeerExcerpt(resolved.agentId, resolved.chunk, c.round2.peerExcerpt.charLimit);
      state.exactPeerExcerpt = excerpt;
      state.round2ContextChecks = {
        exactConstructedPrompt: r2?.prompt === buildRound2Prompt({
          task: snapshot.task, mission: target.mission, previousOutput: target.output,
          excerpt, challenge: c.selectedIssue.challenge,
        }),
        originalTask: r2?.prompt.includes(snapshot.task),
        targetMission: r2?.prompt.includes(target.mission),
        targetRound1: r2?.prompt.includes(target.output),
        exactPeerChunk: r2?.prompt.includes(excerpt.text),
        challenge: r2?.prompt.includes(c.selectedIssue.challenge),
        excerptMatchesOffsets: workerResults.find((r) => r.agentId === resolved.agentId).output.slice(excerpt.startChar, excerpt.endChar) === excerpt.text,
        noFullPeerBroadcast: !r2?.prompt.includes(workerResults.find((r) => r.agentId === resolved.agentId).output),
      };
    }
    state.invariants = {
      snapshotUnchanged: state.snapshotUnchanged,
      reportUnchanged: JSON.stringify(reportBefore) === JSON.stringify(result.report),
      recomputedReportUnchanged: JSON.stringify(reportBefore) === JSON.stringify(state.recomputedFromFrozenRound1),
      bannerUnchanged: bannerBefore === state.bannerAfter && result.finalOutput.startsWith(bannerBefore),
      retrievalOff: state.calls.every((call) => call.retrievalRequested === null && call.retrievalResult === null),
      provisionalPreserved: c.provisionalAnswer === parsed.answer,
      selectedAtMostOne: state.selectedCount <= 1,
      deterministicSelection: JSON.stringify(state.deterministicSelectionReplay) === JSON.stringify(c.selectedIssue ?? null),
      finalPreserved: result.finalOutput === bannerBefore + (c.answerSource === 'round2_decision_synthesis' ? decision?.responseText : c.provisionalAnswer),
      round2OutputPreserved: r2?.responseText === c.round2?.output,
      noRound2Leak: !Object.hasOwn(result, 'workerResults'),
      downstreamCallCeiling: state.calls.length <= 3,
      noPlanningOrWorkersRerun: state.calls.every((call) => !['planning', 'round1_worker'].includes(call.stage)),
    };
  } catch (error) {
    state.fatalError = String(error);
    process.exitCode = 1;
  } finally {
    state.finishedAt = new Date().toISOString();
    state.totalLiveMs ??= Date.now() - started;
    state.runtimeFingerprintAfter = fingerprint();
    state.runtimeUnchanged = JSON.stringify(preflight.runtimeFingerprint) === JSON.stringify(state.runtimeFingerprintAfter);
    checkpoint();
  }
  console.log(JSON.stringify({
    status: state.result?.collaboration?.status, reason: state.result?.collaboration?.reason,
    parse: state.result?.collaboration?.parse, issues: state.result?.collaboration?.issues,
    selectedIssue: state.result?.collaboration?.selectedIssue, invariants: state.invariants,
    calls: state.calls.map(({ stage, ms }) => ({ stage, ms })), totalLiveMs: state.totalLiveMs,
    fatalError: state.fatalError,
  }, null, 2));
}
