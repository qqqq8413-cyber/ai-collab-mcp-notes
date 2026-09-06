/** Offline integrity checks for the R3 candidate freeze and protected historical evidence. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANDIDATE_SETS, sourceTaskPath } from './runner.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const R3_ROOT = CANDIDATE_SETS.R3.sourceRoot;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const manifest = JSON.parse(readFileSync(join(R3_ROOT, 'candidate-set-manifest.json'), 'utf8'));

assert.equal(git('branch', '--show-current'), 'experimental/m2a-peer-challenge');
execFileSync('git', ['merge-base', '--is-ancestor', manifest.expectedStartingHead, 'HEAD'], { cwd: ROOT });
assert.equal(git('rev-parse', `${manifest.productionBoundaryCommit}:src`), git('rev-parse', 'HEAD:src'));

for (const [path, expectedTree] of Object.entries(manifest.historicalGitTreesAtStartingHead)) {
  assert.equal(git('rev-parse', `HEAD:${path}`), expectedTree, path);
  assert.equal(git('status', '--porcelain', '--', path), '', `${path} has working-tree changes`);
}

for (const entry of manifest.candidates) {
  const task = readFileSync(sourceTaskPath(entry.fixtureId));
  assert.equal(sha256(task), entry.taskSha256, entry.fixtureId);
  assert.equal([...task.toString('utf8')].length, entry.taskChars, entry.fixtureId);
}

const replayRoot = join(ROOT, 'diagnostics/m2a-live/controlled-replay-4');
const sealed = JSON.parse(readFileSync(join(replayRoot, 'hashes.json'), 'utf8'));
const walk = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = join(directory, entry.name);
  if (entry.isDirectory()) return walk(path);
  if (entry.name === 'hashes.json') return [];
  assert.equal(statSync(path).isFile(), true, path);
  return [path];
});
const recomputed = Object.fromEntries(walk(replayRoot).sort().map((path) => [relative(replayRoot, path), sha256(readFileSync(path))]));
assert.deepEqual(recomputed, sealed);

console.log(JSON.stringify({
  branch: 'experimental/m2a-peer-challenge',
  productionSrc: 'UNCHANGED_FROM_D01043B',
  r3Tasks: 'FROZEN',
  historicalTrees: 'UNCHANGED',
  replay4ArtifactSeal: 'INTACT',
}, null, 2));
