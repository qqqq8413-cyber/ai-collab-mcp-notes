/**
 * Runtime fingerprint over the compiled and source runtime, used to prove that nothing
 * about the code under test moved between the first and last live call of a capture.
 *
 * This is deliberately the same shape as the fingerprint the Replay #4 artifact carries:
 * a file -> sha256 map, recomputed from disk. It answers "is this the same runtime?" and
 * nothing else. It cannot tell you whether a change was behaviourally meaningful — that
 * question needs a behavioural control re-run, which lives in control-recheck.mjs.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function walk(directory, extension, out) {
  for (const entry of readdirSync(directory).sort()) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) walk(full, extension, out);
    else if (entry.endsWith(extension)) out.push(full);
  }
  return out;
}

/**
 * Hashes every TypeScript source file and every compiled JavaScript file.
 *
 * Both halves are included on purpose. `src` alone would miss a stale or hand-edited
 * `dist`, which is what actually executes; `dist` alone would miss a source edit that had
 * not been rebuilt yet, and would then silently start passing after the next build.
 */
export function runtimeFingerprint() {
  const files = [
    ...walk(join(REPO_ROOT, 'src'), '.ts', []),
    ...walk(join(REPO_ROOT, 'dist'), '.js', []),
  ];
  const map = {};
  for (const file of files) map[relative(REPO_ROOT, file)] = sha256(readFileSync(file));
  return map;
}

/** Returns the files that differ, so a drift report can name them rather than say "changed". */
export function fingerprintDiff(before, after) {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed = [];
  for (const name of [...names].sort()) {
    if (before[name] !== after[name]) {
      changed.push({ file: name, before: before[name] ?? null, after: after[name] ?? null });
    }
  }
  return changed;
}
