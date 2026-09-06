/**
 * Splits the clean-room annotator outputs into per-fixture ground-truth files.
 *
 * ## What this is allowed to do, and what it is not
 *
 * The protocol requires the annotator output be committed verbatim and forbids Claude from
 * touching the semantic judgement. It also specifies per-fixture storage paths. Those two
 * requirements are reconciled by keeping both: the raw response as received, hashed, and a
 * split whose per-fixture objects are byte-identical elements of the raw array.
 *
 * So this module *partitions*. It does not normalize, reorder within an object, correct,
 * or complete anything. A test re-joins the split and asserts it reproduces the raw array,
 * which is what makes "verbatim" checkable rather than promised.
 *
 * Validation is structural only: schema shape, fixture ids, and whether passage references
 * resolve against the frozen Round 1. A reference that does not resolve is reported — never
 * repaired, because repairing it would be editing the judgement.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadFixture, passageIdSet, EXPERIMENT_FIXTURE_IDS, EVALUATION_ROOT } from './fixtures.mjs';

const CLEANROOM = join(EVALUATION_ROOT, 'cleanroom');
const sha256 = (v) => createHash('sha256').update(v).digest('hex');

export class AnnotationInvalid extends Error {
  constructor(problems) {
    super(`clean-room annotation is invalid: ${problems.join('; ')}`);
    this.name = 'AnnotationInvalid';
    this.problems = problems;
  }
}

/** Pulls the single fenced JSON array out of a raw annotator response. */
export function extractJsonArray(raw) {
  const match = raw.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!match) throw new AnnotationInvalid(['no fenced json block found in the raw annotator output']);
  return JSON.parse(match[1]);
}

export function readRaw(kind) {
  const path = join(CLEANROOM, `raw-${kind}.md`);
  if (!existsSync(path)) throw new AnnotationInvalid([`missing raw annotator output: ${path}`]);
  const text = readFileSync(path, 'utf8');
  return { path, text, sha256: sha256(text), entries: extractJsonArray(text) };
}

/** Structural validation. Never touches content. */
export function validateConflictLabels(entries) {
  const problems = [];
  const seen = new Set();
  for (const e of entries) {
    if (!EXPERIMENT_FIXTURE_IDS.includes(e.fixtureId)) { problems.push(`unknown fixtureId ${JSON.stringify(e.fixtureId)}`); continue; }
    if (seen.has(e.fixtureId)) problems.push(`duplicate entry for ${e.fixtureId}`);
    seen.add(e.fixtureId);
    if (typeof e.materialConflict !== 'boolean') problems.push(`${e.fixtureId}: materialConflict must be a boolean`);
    if (!Array.isArray(e.passageRefs)) problems.push(`${e.fixtureId}: passageRefs must be an array`);
    if (e.materialConflict) {
      if (!e.description) problems.push(`${e.fixtureId}: a conflict with no description`);
      if ((e.passageRefs ?? []).length === 0) problems.push(`${e.fixtureId}: a conflict with no passageRefs`);
    } else if (e.description !== null) {
      problems.push(`${e.fixtureId}: materialConflict is false but description is not null`);
    }
    const ids = passageIdSet(loadFixture(e.fixtureId));
    for (const ref of e.passageRefs ?? []) {
      if (!ids.has(ref)) problems.push(`${e.fixtureId}: passageRef ${ref} does not resolve`);
    }
  }
  for (const id of EXPERIMENT_FIXTURE_IDS) if (!seen.has(id)) problems.push(`no entry for ${id}`);
  if (problems.length) throw new AnnotationInvalid(problems);
  return entries;
}

export function validateGoldIssues(entries) {
  const problems = [];
  const seen = new Set();
  for (const e of entries) {
    if (!EXPERIMENT_FIXTURE_IDS.includes(e.fixtureId)) { problems.push(`unknown fixtureId ${JSON.stringify(e.fixtureId)}`); continue; }
    if (seen.has(e.fixtureId)) problems.push(`duplicate entry for ${e.fixtureId}`);
    seen.add(e.fixtureId);
    if (!Array.isArray(e.goldIssues) || e.goldIssues.length === 0) {
      problems.push(`${e.fixtureId}: goldIssues must be a non-empty array`);
      continue;
    }
    const ids = passageIdSet(loadFixture(e.fixtureId));
    const issueIds = new Set();
    for (const gi of e.goldIssues) {
      if (!gi.id) problems.push(`${e.fixtureId}: a gold issue with no id`);
      if (issueIds.has(gi.id)) problems.push(`${e.fixtureId}: duplicate gold issue id ${gi.id}`);
      issueIds.add(gi.id);
      if (!gi.issue || gi.issue.length === 0) problems.push(`${e.fixtureId}/${gi.id}: empty issue text`);
      if (!Array.isArray(gi.supportRefs)) problems.push(`${e.fixtureId}/${gi.id}: supportRefs must be an array`);
      for (const ref of gi.supportRefs ?? []) {
        if (!ids.has(ref)) problems.push(`${e.fixtureId}/${gi.id}: supportRef ${ref} does not resolve`);
      }
    }
  }
  for (const id of EXPERIMENT_FIXTURE_IDS) if (!seen.has(id)) problems.push(`no entry for ${id}`);
  if (problems.length) throw new AnnotationInvalid(problems);
  return entries;
}

/**
 * Compares the independent labels against the intended archetypes.
 *
 * Reports disagreement; never resolves it. Per protocol §13, an intended negative control
 * that the annotator called a conflict fails as a candidate and must be replaced — the
 * label is not edited and not reinterpreted.
 */
export function checkAgainstIntent(entries) {
  return EXPERIMENT_FIXTURE_IDS.map((fixtureId) => {
    const manifest = JSON.parse(
      readFileSync(join(fileURLToPath(new URL('../fixtures/', import.meta.url)), fixtureId, 'fixture-manifest.json'), 'utf8')
    );
    const intendedPositive = manifest.archetypeCode !== 'NEGATIVE_CONTROL';
    const observed = entries.find((e) => e.fixtureId === fixtureId).materialConflict;
    return { fixtureId, archetypeCode: manifest.archetypeCode, intendedPositive, observed, agrees: intendedPositive === observed };
  });
}

/** Writes the per-fixture split. Refuses to overwrite: frozen ground truth is frozen. */
export function writeSplit() {
  const conflict = readRaw('conflict-labels');
  const gold = readRaw('gold-issues');
  validateConflictLabels(conflict.entries);
  validateGoldIssues(gold.entries);

  const written = [];
  for (const fixtureId of EXPERIMENT_FIXTURE_IDS) {
    mkdirSync(join(EVALUATION_ROOT, fixtureId), { recursive: true });
    for (const [name, source] of [['conflict-labels', conflict], ['gold-issues', gold]]) {
      const entry = source.entries.find((e) => e.fixtureId === fixtureId);
      const path = join(EVALUATION_ROOT, fixtureId, `${name}.json`);
      if (existsSync(path)) throw new Error(`refusing to overwrite frozen ground truth: ${path}`);
      const content = JSON.stringify(entry, null, 2) + '\n';
      writeFileSync(path, content, { flag: 'wx' });
      written.push({ path, sha256: sha256(content) });
    }
  }
  return { written, rawHashes: { 'raw-conflict-labels.md': conflict.sha256, 'raw-gold-issues.md': gold.sha256 } };
}
