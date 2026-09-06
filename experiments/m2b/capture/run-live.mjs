/**
 * Live entry point for the M2-B Real Round 1 capture. This is the only file here that can
 * spend money, and it does nothing except gather provenance, check the preconditions, and
 * hand production `callProvider` to the session driver.
 *
 * It refuses to start unless the confirmation flag is present, so it cannot be run by
 * reflex or by a stray shell history entry. Every other check below exists because a live
 * capture is one-shot: there is no second attempt per candidate, so a precondition noticed
 * afterwards is a candidate lost rather than a candidate delayed.
 */
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { callProvider } from '../../../dist/providers/index.js';
import { runCaptureSession } from './session.mjs';
import { CANDIDATE_SETS, sourceTaskPath, SOURCE_CANDIDATE } from './runner.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PRODUCTION_BOUNDARY_COMMIT = 'd01043b6c520c29473e3960c60bad28aec9719ed';
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

if (!process.argv.includes('--i-am-authorized-to-spend-live-calls')) {
  console.error('Refusing to run: this issues real, paid provider calls and each candidate may be attempted only once.');
  console.error('Pass --i-am-authorized-to-spend-live-calls to proceed.');
  process.exit(2);
}

const setId = (process.argv.find((a) => a.startsWith('--set=')) ?? '--set=R1').slice('--set='.length);
const set = CANDIDATE_SETS[setId];
if (!set) {
  console.error(`unknown candidate set "${setId}"; expected one of ${Object.keys(CANDIDATE_SETS).join(', ')}`);
  process.exit(2);
}
const REAL_ROOT = set.realRoot;
const REAL_FIXTURE_IDS = set.fixtureIds;

const head = git('rev-parse', 'HEAD');

// The harness that spends the calls must itself be committed, so the artifact can name the
// exact code that produced it. An uncommitted capture harness is unciteable evidence.
const dirtyTracked = git('status', '--porcelain', '--untracked-files=no');
if (dirtyTracked) {
  console.error('Refusing to run: tracked files are modified. Commit the capture harness first.\n' + dirtyTracked);
  process.exit(2);
}
const untrackedInScope = git('status', '--porcelain', '--untracked-files=all', '--', 'src', 'experiments', 'dist');
if (untrackedInScope) {
  console.error('Refusing to run: untracked files under src/, dist/ or experiments/.\n' + untrackedInScope);
  process.exit(2);
}

// The boundary this capture depends on must actually be in history, not merely believed in.
try {
  git('merge-base', '--is-ancestor', PRODUCTION_BOUNDARY_COMMIT, head);
} catch {
  console.error(`Refusing to run: HEAD does not contain the accepted production boundary ${PRODUCTION_BOUNDARY_COMMIT}.`);
  process.exit(2);
}

if (existsSync(REAL_ROOT)) {
  console.error(`Refusing to run: ${REAL_ROOT} already exists. A capture session is not repeatable.`);
  process.exit(2);
}
for (const fixtureId of REAL_FIXTURE_IDS) {
  if (!existsSync(sourceTaskPath(fixtureId))) {
    console.error(`Refusing to run: missing source task for ${fixtureId} (${SOURCE_CANDIDATE[fixtureId]}).`);
    process.exit(2);
  }
}

const meta = {
  executionHead: head,
  productionBoundaryCommit: PRODUCTION_BOUNDARY_COMMIT,
  // The prompts Round 1 is built from, pinned to the commits that last defined them.
  promptSourceCommit: {
    'src/agents/chief.ts': git('log', '-1', '--format=%H', '--', 'src/agents/chief.ts'),
    'src/modes/orchestrator.ts': git('log', '-1', '--format=%H', '--', 'src/modes/orchestrator.ts'),
  },
  captureHarnessCommit: head,
  nodeVersion: process.version,
};

console.error(`executionHead            ${meta.executionHead}`);
console.error(`captureHarnessCommit     ${meta.captureHarnessCommit}`);
console.error(`productionBoundaryCommit ${meta.productionBoundaryCommit}`);
console.error(`node                     ${meta.nodeVersion}`);
console.error(`candidate set            ${setId}`);
console.error(`candidates               ${REAL_FIXTURE_IDS.join(', ')}\n`);

const { session } = await runCaptureSession({
  call: callProvider,
  realRoot: REAL_ROOT,
  fixtureIds: REAL_FIXTURE_IDS,
  meta,
  globalBudget: set.globalCallBudget,
});

console.error('');
for (const attempt of session.attempts) {
  console.error(
    `${attempt.fixtureId}  ${String(attempt.captureStatus).padEnd(9)} ` +
      `complexity=${attempt.complexity} workers=${attempt.successfulWorkerCount} ` +
      `status=${attempt.round1Status} calls=${attempt.liveCallCount}`
  );
}
console.error(`\nglobal live calls        ${session.globalLiveCallCount}`);
console.error(`runtime fingerprint      ${session.runtimeFingerprintStartSha256 === session.runtimeFingerprintEndSha256 ? 'UNCHANGED' : 'CHANGED — CAPTURES INVALID'}`);
if (session.roundEndingViolation) {
  console.error(`\nROUND ENDED EARLY: ${session.roundEndingViolation.code} at ${session.roundEndingViolation.fixtureId}`);
  process.exit(1);
}
