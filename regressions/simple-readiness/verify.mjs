// Verifies saved evidence without making model calls. Semantic review is in HANDOFF.
// node verify.mjs /path/to/evidence-directory
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.argv[2]) throw new Error('Provide an evidence directory.');
const directory = resolve(process.argv[2]);
const readJson = (name) => JSON.parse(readFileSync(join(directory, name), 'utf8'));
const fixtureText = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'cases.json'), 'utf8');
const fixtures = JSON.parse(fixtureText);
const manifest = readJson('manifest.json');
const integrity = readJson('integrity.json');
assert.equal(manifest.fixtureSha256, createHash('sha256').update(fixtureText).digest('hex'));
assert.equal(integrity.runtimeSourceAndBaselineUnchanged, true);
assert.deepEqual(manifest.fileSha256, integrity.fileSha256);

function verifyTable(text) {
  const lines = text.trim().split('\n');
  assert.equal(lines.length, 4);
  const cells = (line) => {
    assert.match(line, /^\|.*\|$/);
    return line.slice(1, -1).split('|').map((cell) => cell.trim());
  };
  assert.deepEqual(cells(lines[0]), ['場地', '費用（元）']);
  const separators = cells(lines[1]);
  assert.equal(separators.length, 2);
  for (const cell of separators) assert.match(cell, /^:?-{3,}:?$/);
  assert.deepEqual(lines.slice(2).map(cells), [['松山館', '12000'], ['中山館', '15000']]);
}

function verifySummary(text) {
  assert.ok(Array.from(text.replace(/\s/gu, '')).length <= 100);
  assert.equal(text.trim().split(/\n/).length, 1);
  assert.ok(text.split(/[。！？]/u).filter((part) => part.trim()).length <= 2);
  assert.doesNotMatch(text, /^[#>*-]|^\d+[.)]/);
  for (const fact of ['林宜庭', '9月18日前', '三支15秒直式短片', '投放平台與廣告預算未定']) {
    assert.ok(text.includes(fact), `Missing recorded fact: ${fact}`);
  }
  assert.doesNotMatch(text, /9月12|五支|30秒/);
}

for (const fixture of fixtures) {
  const observation = readJson(`${fixture.id}.json`);
  const raw = readJson(`${fixture.id}-mcp.json`);
  const result = observation.result;
  assert.equal(raw.task, fixture.task);
  for (const field of ['id', 'category', 'task', 'acceptance']) {
    assert.deepEqual(observation[field], fixture[field]);
  }
  assert.deepEqual(JSON.parse(raw.response.content[0].text), result);
  assert.equal(result.plan.complexity, 'simple');
  assert.equal(result.plan.assignments.length, 1);
  assert.equal(result.workerResults.length, 1);
  assert.equal(result.workerResults[0].mission, result.plan.assignments[0].mission);
  assert.equal(result.workerResults[0].agentId, result.plan.assignments[0].agentId);
  assert.equal(result.report.status, 'SUCCESS');
  assert.equal(result.report.synthesisAllowed, true);
  assert.equal(result.report.evidenceLabel, 'NOT_APPLICABLE');
  assert.ok(Object.values(observation.structuralChecks).every((value) => value === true));
  for (const ms of Object.values(result.timings)) assert.ok(ms > 0);
  const stageSum = result.timings.planningMs + result.timings.workersMs + result.timings.synthesisMs;
  assert.ok(result.timings.totalMs >= stageSum);
  const worker = result.workerResults[0].output;
  const synthesis = result.finalOutput;
  for (const text of [worker, synthesis]) {
    if (fixture.id === 'SIMPLE-2') verifyTable(text);
    else verifySummary(text);
  }
  assert.equal(worker, synthesis);
  console.log(JSON.stringify({
    id: fixture.id,
    checks: 'PASS',
    workerAndSynthesisExactlyEqual: true,
    workerCodePoints: Array.from(worker).length,
    workerCodePointsExcludingWhitespace: Array.from(worker.replace(/\s/gu, '')).length,
    outputSha256: createHash('sha256').update(worker).digest('hex'),
    timings: result.timings,
  }, null, 2));
}
