/**
 * Re-runs replay #4's sealed 16-group disabled/omitted control against the current runtime.
 *
 * ## Why this exists
 *
 * `diagnostics/m2a-live/controlled-replay-4/verify.mjs` pins the runtime that produced
 * replay #4 by hashing `src/` and `dist/`. Any authorized change to production necessarily
 * breaks that pin — that is the fingerprint doing its job, not a regression. But it means
 * the verifier stops at the fingerprint and never reaches the question that actually
 * matters after a refactor: did the disabled/omitted behaviour move?
 *
 * This answers that question directly. The control harness is a verbatim copy of the
 * sealed `control.mjs` with one change, the relative path to `dist/` — the sealed original
 * is not touched, not regenerated, and not re-sealed. A changed historical control would be
 * evidence of regression, so this reports rather than rewrites.
 *
 *   node experiments/m2b/capture/control-recheck.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SEALED = join(ROOT, 'diagnostics/m2a-live/controlled-replay-4/control.mjs');

/** The hash the historical control produced, recorded in replay #4's preflight. */
export const HISTORICAL_CONTROL_SHA256 =
  'f50a7b2ee2a8b7f896dc6a6b88692d612281553011a1de685b2e39c9a567c698';

export function recheckControl() {
  const source = readFileSync(SEALED, 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'm2b-control-'));
  try {
    // Only the dist import path is rewritten; every assertion and every case is the
    // sealed harness's own.
    const relocated = source.replace(
      "'../../../dist/modes/orchestrator.js'",
      JSON.stringify(join(ROOT, 'dist/modes/orchestrator.js'))
    );
    assert.notEqual(relocated, source, 'expected to rewrite the dist import path');
    const script = join(dir, 'control.mjs');
    writeFileSync(script, relocated);
    const out = execFileSync(process.execPath, [script, 'before'], { encoding: 'utf8' });
    return JSON.parse(out.trim().split('\n').pop());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = recheckControl();
  const drifted = result.sha256 !== HISTORICAL_CONTROL_SHA256;
  console.log(JSON.stringify({ ...result, historical: HISTORICAL_CONTROL_SHA256, drifted }, null, 2));
  if (drifted) {
    console.error('\nCONTROL DRIFT: the disabled/omitted path no longer reproduces the historical capture.');
    console.error('Do not regenerate the sealed artifact. This is evidence of a regression.');
    process.exit(1);
  }
  console.log('\nNo drift: the disabled/omitted path is byte-identical to the historical control.');
}
