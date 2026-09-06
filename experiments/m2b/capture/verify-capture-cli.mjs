/**
 * CLI for the offline capture verifier. Recomputes everything from the committed artifacts;
 * never calls a provider and never writes to the capture directory.
 */
import { verifyCapture, verifySyntheticUnchanged } from './capture-verify.mjs';
import {
  CANDIDATE_SETS, SYNTHETIC_ROOT, CHIEF_PIN, PROVIDER_ALLOCATION, SOURCE_CANDIDATE,
  sourceTaskPath, selectWaveSlots, waveCallBudget, waveOutputRoot,
} from './runner.mjs';
import { fileURLToPath } from 'node:url';

const M2B = fileURLToPath(new URL('../', import.meta.url));
const setId = (process.argv.find((a) => a.startsWith('--set=')) ?? '--set=R1').slice('--set='.length);
const set = CANDIDATE_SETS[setId];
if (!set) {
  console.error(`unknown candidate set "${setId}"; expected one of ${Object.keys(CANDIDATE_SETS).join(', ')}`);
  process.exit(2);
}

const waveArg = process.argv.find((a) => a.startsWith('--wave='));
const filledArg = process.argv.find((a) => a.startsWith('--filled-archetypes='));
let realRoot = set.realRoot;
let globalCallBudget = set.globalCallBudget;
let expectedFixtureIds = null;
if (setId === 'P03') {
  if (!waveArg) {
    console.error('P03 verification requires --wave=1, --wave=2 or --wave=3.');
    process.exit(2);
  }
  const waveNumber = Number(waveArg.slice('--wave='.length));
  const filledArchetypes = filledArg
    ? filledArg.slice('--filled-archetypes='.length).split(',').filter(Boolean)
    : [];
  try {
    const selectedSlots = selectWaveSlots(waveNumber, filledArchetypes);
    expectedFixtureIds = selectedSlots;
    realRoot = waveOutputRoot(waveNumber);
    globalCallBudget = waveCallBudget(selectedSlots);
  } catch (err) {
    console.error(`Cannot verify P03: ${err.message}`);
    process.exit(2);
  }
} else if (waveArg || filledArg) {
  console.error(`wave arguments apply only to --set=P03, not ${setId}`);
  process.exit(2);
}

const capture = verifyCapture({
  realRoot,
  chiefPin: CHIEF_PIN,
  providerAllocation: PROVIDER_ALLOCATION,
  sourceCandidate: SOURCE_CANDIDATE,
  sourceTaskPathFor: sourceTaskPath,
  globalCallBudget,
  expectedFixtureIds,
});
const synthetic = verifySyntheticUnchanged({
  syntheticRoot: SYNTHETIC_ROOT,
  evaluationRoot: `${M2B}evaluation`,
  freezeManifestPath: `${M2B}manifests/fixture-freeze-manifest.json`,
});

for (const failure of [...capture.failures, ...synthetic.failures]) {
  console.log(`  FAIL [${failure.id}] ${failure.name} — ${failure.detail}`);
}
console.log(`set ${setId} capture   ${capture.checks.length - capture.failures.length}/${capture.checks.length} checks passed`);
console.log(`synthetic ${synthetic.checks.length - synthetic.failures.length}/${synthetic.checks.length} checks passed`);
if (!capture.ok || !synthetic.ok) process.exit(1);
console.log('\nAll recomputed checks passed.');
