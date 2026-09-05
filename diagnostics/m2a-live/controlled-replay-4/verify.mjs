// Offline integrity and runtime-evidence verification. Never calls a provider.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { parseGateOutput, segmentAll, resolveSourceRef, validateIssues, selectIssue } from '../../../dist/agents/collaboration.js';
import { buildRunReport, buildOutputBanner } from '../../../dist/modes/orchestrator.js';

const directory = fileURLToPath(new URL('./', import.meta.url));
const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (file) => JSON.parse(readFileSync(join(directory, file), 'utf8'));
const sha = (value) => createHash('sha256').update(value).digest('hex');
const a = read('artifact.json');
const oldDirectory = join(root, 'diagnostics/m2a-live/controlled-replay');
const old = JSON.parse(readFileSync(join(oldDirectory, 'artifact.json'), 'utf8'));
assert.equal(sha(readFileSync(join(oldDirectory, 'artifact.json'))), a.preflight.replay3ArtifactSha256);
assert.deepEqual(a.snapshot, old.snapshot);
assert.equal(sha(JSON.stringify(a.snapshot)), a.preflight.replay4SnapshotSha256);
assert.equal(a.preflight.replay3SnapshotSha256, a.preflight.replay4SnapshotSha256);
for (const [file, expected] of Object.entries(a.preflight.fixtureHashes)) {
  const bytes = readFileSync(join(oldDirectory, file));
  assert.equal(sha(bytes), expected.sha256, file);
  assert.equal(bytes.toString('utf8').length, expected.chars, file);
}
assert.deepEqual(readFileSync(join(directory, 'control-before.json')), readFileSync(join(directory, 'control-after.json')));
assert.equal(a.runtimeUnchanged, true);
assert.deepEqual(a.preflight.runtimeFingerprint, a.runtimeFingerprintAfter);
for (const [file, expected] of Object.entries(a.runtimeFingerprintAfter)) {
  assert.equal(sha(readFileSync(join(root, file))), expected, file);
}
const baselineSource = execFileSync('git', ['show', a.preflight.baselineCommit + ':src/agents/collaboration.ts'], { cwd: root, encoding: 'utf8' });
const currentSource = readFileSync(join(root, 'src/agents/collaboration.ts'), 'utf8');
assert.equal(currentSource.split('export function buildGateAppendix')[0], baselineSource.split('export function buildGateAppendix')[0]);
assert.equal(currentSource.split('export function buildRound2Prompt')[1], baselineSource.split('export function buildRound2Prompt')[1]);
assert.equal(a.calls[0].stage, 'synthesis_gate');
assert.equal(sha(a.calls[0].prompt), a.preflight.expectedGatePromptSha256);
assert.equal(a.calls[0].provider, old.calls[0].provider);
assert.equal(a.calls[0].model, old.calls[0].model);
assert.ok(a.calls.length >= 1 && a.calls.length <= 3);
assert.equal(new Set(a.calls.map((c) => c.stage)).size, a.calls.length);
if (a.fatalError) throw new Error('Recorded fatal error: ' + a.fatalError);
const c = a.result.collaboration;
const parsed = parseGateOutput(a.calls[0].responseText);
assert.deepEqual(parsed, a.parserReplay);
assert.equal(c.parse.status, parsed.status);
assert.equal(c.provisionalAnswer, parsed.answer);
const chunks = segmentAll(a.snapshot.workerResults);
assert.deepEqual(chunks, a.chunkDetail);
const validation = validateIssues(parsed.rawIssues, { successfulAgentIds: a.snapshot.agentOrder, chunksByAgent: chunks });
assert.deepEqual(validation.valid, c.issues.recorded);
assert.deepEqual(validation.rejected, c.issues.rejected);
assert.equal(c.issues.emitted, parsed.rawIssues.length);
assert.equal(c.issues.valid, validation.valid.length);
assert.equal(c.issues.eligible, validation.valid.filter((i) => i.action === 'peer_challenge' && i.decisionSensitive).length);
assert.deepEqual(selectIssue(validation.valid, a.snapshot.agentOrder) ?? null, c.selectedIssue ?? null);
if (c.selectedIssue) {
  assert.equal(c.selectedIssue.action, 'peer_challenge');
  assert.equal(c.selectedIssue.decisionSensitive, true);
  assert.ok(a.snapshot.agentOrder.includes(c.selectedIssue.targetAgentId));
  const resolved = resolveSourceRef(c.selectedIssue.sourceRef, chunks);
  assert.deepEqual(resolved, a.resolved);
  assert.equal(resolved.ok, true);
  assert.notEqual(resolved.agentId, c.selectedIssue.targetAgentId);
  for (const [name, passed] of Object.entries(a.round2ContextChecks ?? {})) assert.equal(passed, true, name);
}
const report = buildRunReport(a.snapshot.complexity, a.roster, a.snapshot.workerResults);
assert.deepEqual(JSON.parse(JSON.stringify(report)), a.reportBefore);
assert.deepEqual(a.reportBefore, a.reportAfter);
assert.deepEqual(a.reportAfter, a.result.report);
assert.equal(buildOutputBanner(report), a.bannerBefore);
for (const [name, passed] of Object.entries(a.invariants)) assert.equal(passed, true, name);
if (c.status === 'COMPLETED') {
  assert.deepEqual(a.calls.map((call) => call.stage), ['synthesis_gate', 'round2_worker', 'decision_synthesis']);
  assert.equal(a.selectedCount, 1);
  assert.ok(Object.keys(a.round2ContextChecks).length >= 7);
} else if (c.reason === 'no_issue_block') {
  assert.equal(a.calls.length, 1);
  assert.equal(c.parse.status, 'absent');
}
if (c.issues.eligible > 1) assert.ok(c.notes.some((note) => note.includes('deterministic ordering picked one')));
const filesBelow = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const path = join(dir, e.name);
  return e.isDirectory() ? filesBelow(path) : e.name === 'hashes.json' ? [] : [path];
});
const hashes = Object.fromEntries(filesBelow(directory).sort().map((path) => [relative(directory, path), sha(readFileSync(path))]));
if (process.argv.includes('--seal')) {
  assert.ok(existsSync(join(directory, 'evaluation.md')), 'Manual evaluation must precede sealing');
  writeFileSync(join(directory, 'hashes.json'), JSON.stringify(hashes, null, 2) + '\n', { flag: 'wx' });
} else if (existsSync(join(directory, 'hashes.json'))) {
  assert.deepEqual(hashes, read('hashes.json'));
}
console.log(JSON.stringify({ fixture: 'PASS', control: 'PASS', runtimeScope: 'PASS', evidence: 'PASS', collaboration: c.status, seal: existsSync(join(directory, 'hashes.json')) ? 'VERIFIED' : 'NOT SEALED' }));
