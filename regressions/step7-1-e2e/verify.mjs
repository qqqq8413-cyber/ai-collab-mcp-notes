// Verifies and seals saved Step 7.1 evidence without making model calls.
// node verify.mjs /path/to/AI-Agent
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const project = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Provide the AI Agent project path.');
const fixtures = JSON.parse(readFileSync(join(root, 'cases.json'), 'utf8'));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

for (const fixture of fixtures) {
  const directory = join(root, fixture.id);
  assert.ok(existsSync(directory), `Missing evidence: ${fixture.id}`);
  const readJson = (name) => JSON.parse(readFileSync(join(directory, name), 'utf8'));
  const task = readJson('task.json');
  const manifest = readJson('manifest.json');
  const raw = readJson('raw-mcp-response.json');
  const normalized = readJson('normalized-result.json');
  const integrity = readJson('integrity.json');
  const evaluation = existsSync(join(directory, 'evaluation.json'))
    ? readJson('evaluation.json')
    : undefined;
  assert.deepEqual(task, fixture);
  assert.equal(manifest.fixtureSha256, sha256(JSON.stringify(fixture)));
  assert.equal(raw.task, fixture.task);
  assert.deepEqual(JSON.parse(raw.response.content.find((item) => item.type === 'text').text), normalized.result);
  if (normalized.outcome === 'PASS') {
    assert.ok(Object.values(normalized.structuralChecks).every(Boolean));
  } else {
    assert.equal(evaluation?.classification, 'HARNESS_FALSE_NEGATIVE');
    assert.equal(evaluation?.finalOutcome, 'PASS');
    assert.equal(fixture.kind, 'simple_direct');
    assert.deepEqual(evaluation.correctedStructuralChecks, { expectedArithmeticAndOrder: true });
    for (const [name, passed] of Object.entries(normalized.structuralChecks)) {
      if (name !== 'expectedArithmeticAndOrder') assert.equal(passed, true, name);
    }
    const compact = normalized.result.finalOutput.replace(/[\s,，*_：:|]/gu, '');
    const c = compact.indexOf('C案48090元');
    const a = compact.indexOf('A案50400元');
    const b = compact.indexOf('B案55125元');
    assert.ok(c >= 0 && a > c && b > a, 'Recomputed arithmetic/order check');
  }
  assert.equal(integrity.runtimeSourceAndBuildUnchanged, true);
  assert.deepEqual(manifest.runtimeFileSha256, integrity.runtimeFileSha256);
  for (const [path, expected] of Object.entries(manifest.runtimeFileSha256)) {
    assert.equal(sha256(readFileSync(join(project, path))), expected, `Current runtime: ${path}`);
  }
  if (fixture.kind === 'simple_direct') {
    assert.equal(normalized.logicalModelCallCount, 2);
    assert.equal(normalized.result.finalOutput, normalized.result.workerResults[0].output);
  } else {
    assert.ok(normalized.observation.selectedEvidenceAgentIds.length >= 1);
    assert.ok(normalized.observation.groundedAgentIds.length >= 1);
    assert.equal(normalized.result.report.evidenceLabel, 'PARTIALLY_GROUNDED');
  }
  console.log(`${fixture.id}: PASS`);
}

const firstAttempt = join(root, 'DEEP-grounded-attempt-1-normal');
const readAttempt = (name) => JSON.parse(readFileSync(join(firstAttempt, name), 'utf8'));
const firstRaw = readAttempt('raw-mcp-response.json');
const firstNormalized = readAttempt('normalized-result.json');
const firstManifest = readAttempt('manifest.json');
assert.equal(firstManifest.fixtureSha256, sha256(JSON.stringify(readAttempt('task.json'))));
assert.equal(firstRaw.task, readAttempt('task.json').task);
assert.deepEqual(JSON.parse(firstRaw.response.content.find((item) => item.type === 'text').text), firstNormalized.result);
assert.equal(firstNormalized.result.plan.complexity, 'normal');
assert.equal(firstNormalized.outcome, 'FAIL');
assert.equal(readAttempt('evaluation.json').finalOutcome, 'TEST_NOT_EXERCISED');
assert.deepEqual(firstManifest.runtimeFileSha256, readAttempt('integrity.json').runtimeFileSha256);
assert.equal(readAttempt('integrity.json').runtimeSourceAndBuildUnchanged, true);
console.log('DEEP-grounded-attempt-1-normal: preserved TEST_NOT_EXERCISED');

function filesBelow(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'hashes.json') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesBelow(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

const hashes = Object.fromEntries(
  filesBelow(root)
    .sort()
    .map((path) => [relative(root, path), sha256(readFileSync(path))])
);
const hashFile = join(root, 'hashes.json');
if (existsSync(hashFile)) {
  assert.deepEqual(JSON.parse(readFileSync(hashFile, 'utf8')), hashes);
  console.log('hashes.json: VERIFIED');
} else {
  writeFileSync(hashFile, JSON.stringify(hashes, null, 2) + '\n', { flag: 'wx' });
  console.log('hashes.json: CREATED; run verify.mjs again to verify the seal.');
}

for (const path of filesBelow(root)) {
  const text = readFileSync(path, 'utf8');
  assert.doesNotMatch(text, /(?:OPENAI|ANTHROPIC|GEMINI)_API_KEY\s*=/);
  assert.doesNotMatch(text, /sk-ant-[A-Za-z0-9_-]{20,}/);
  assert.doesNotMatch(text, /AIza[A-Za-z0-9_-]{20,}/);
}

assert.ok(existsSync(join(project, 'dist/index.js')));
