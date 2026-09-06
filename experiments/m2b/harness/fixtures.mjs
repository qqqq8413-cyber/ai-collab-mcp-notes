/**
 * Fixture loading and freezing for the M2-B Phase 1 experiment set.
 *
 * ## The one rule this module exists to enforce
 *
 * It reads from `experiments/m2b/fixtures/` and from nowhere else. Ground truth —
 * conflict labels and gold issues — lives under `experiments/m2b/evaluation/`, and no
 * code path here can reach it. That is protocol GI-5, and it is structural rather than a
 * convention: `FIXTURE_ROOT` is the only directory this module ever opens, and every read
 * is an explicit named file, never a recursive walk that could wander.
 *
 * A gold issue that reached the Gate would make the whole evaluation circular, and it
 * would be invisible afterwards. So the separation is enforced where it cannot be
 * forgotten, not where someone has to remember it.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { segmentAll } from '../../../dist/agents/collaboration.js';

export const FIXTURE_ROOT = fileURLToPath(new URL('../fixtures/', import.meta.url));
export const EVALUATION_ROOT = fileURLToPath(new URL('../evaluation/', import.meta.url));

const sha256 = (v) => createHash('sha256').update(v).digest('hex');

/** Fixtures that are experiment fixtures. `synthetic/` is test scaffolding, not one. */
export const EXPERIMENT_FIXTURE_IDS = Object.freeze(['fx-01', 'fx-02', 'fx-03', 'fx-04']);

export class FixtureError extends Error {}

/**
 * Reads one frozen fixture from disk and builds its `Round1Snapshot`.
 *
 * Deterministic in file order: the roster fixes specialist order, so two machines produce
 * the same snapshot bytes and therefore the same hash.
 */
export function loadFixture(fixtureId) {
  const dir = join(FIXTURE_ROOT, fixtureId);
  if (!existsSync(dir)) throw new FixtureError(`fixture "${fixtureId}" does not exist under fixtures/`);

  const read = (name) => {
    const path = join(dir, name);
    if (!existsSync(path)) throw new FixtureError(`fixture "${fixtureId}" is missing ${name}`);
    return readFileSync(path, 'utf8');
  };

  const task = read('task.txt');
  const roster = JSON.parse(read('roster.json'));
  if (!Array.isArray(roster.specialists) || roster.specialists.length < 2) {
    throw new FixtureError(`fixture "${fixtureId}": F2 requires at least two specialists`);
  }

  const files = { 'task.txt': task, 'roster.json': read('roster.json') };
  const workers = [];
  const workerResults = [];

  for (const s of roster.specialists) {
    const missionFile = `mission-${s.id}.txt`;
    const roundFile = `round1-${s.id}.md`;
    const mission = read(missionFile).trim();
    const output = read(roundFile).trim();
    files[missionFile] = mission;
    files[roundFile] = output;

    workers.push({ id: s.id, provider: s.provider, model: s.model, role: s.role, evidenceCapable: false });
    workerResults.push({ agentId: s.id, mission, output });
  }

  const snapshot = {
    task: task.trim(),
    complexity: 'deep',
    agentOrder: roster.specialists.map((s) => s.id),
    workers,
    workerResults,
  };

  return {
    fixtureId,
    roster,
    snapshot,
    files,
    snapshotSha256: sha256(JSON.stringify(snapshot)),
    fileHashes: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, sha256(v)])),
    // One hash over the whole fixture, order-independent of the filesystem.
    fixtureSha256: sha256(
      Object.keys(files).sort().map((k) => `${k}\n${sha256(files[k])}`).join('\n')
    ),
  };
}

/** Deterministic passage ids, using the production chunker. Never a second segmenter. */
export function passagesOf(fixture) {
  const chunks = segmentAll(fixture.snapshot.workerResults);
  const out = {};
  for (const [agentId, list] of Object.entries(chunks)) {
    out[agentId] = list.map((c) => ({ passageId: `${agentId}:${c.id}`, text: c.text }));
  }
  return out;
}

/** Every valid `<agentId>:pN` reference for a fixture, for validating annotator output. */
export function passageIdSet(fixture) {
  return new Set(Object.values(passagesOf(fixture)).flat().map((p) => p.passageId));
}

export function loadAllExperimentFixtures() {
  return EXPERIMENT_FIXTURE_IDS.map(loadFixture);
}

/**
 * Proves this module cannot reach evaluation data.
 *
 * Returns every path the loader would open for a fixture. A test asserts none of them
 * falls under `evaluation/` — which is what makes GI-5 checkable rather than asserted.
 */
export function pathsReadFor(fixtureId) {
  const dir = join(FIXTURE_ROOT, fixtureId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((name) => join(dir, name));
}
