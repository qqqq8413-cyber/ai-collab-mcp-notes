/**
 * Drives one M2-B Real Round 1 capture session: four candidates, one attempt each.
 *
 * Separated from the CLI so the whole session — recorder, production Round 1, artifact
 * writing, sealing — can be exercised offline against a deterministic stub provider. The
 * only thing the CLI adds is passing production `callProvider` in, which is also the only
 * thing that costs money. A bug found by a stub session is a bug that never burned a call.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRecorder, ScopeViolation, RetrievalPolicyViolation, TemperaturePolicyViolation, CallBudgetExceeded } from './recorder.mjs';
import { runtimeFingerprint, fingerprintDiff } from './runtime-fingerprint.mjs';
import {
  captureCandidate, sealManifest, canonical, sha256, candidateSetFor,
  REAL_FIXTURE_IDS, CHIEF_PIN, PROVIDER_ALLOCATION, SOURCE_CANDIDATE,
  CAPTURE_VERSION, PROTOCOL_VERSION, RETRIEVAL_POLICY, TEMPERATURE_POLICY,
} from './runner.mjs';

/** Violations that end the round rather than the candidate. */
const ROUND_ENDING = [ScopeViolation, RetrievalPolicyViolation, TemperaturePolicyViolation, CallBudgetExceeded];
const isRoundEnding = (err) => ROUND_ENDING.some((Kind) => err instanceof Kind);

export async function runCaptureSession({
  call,
  realRoot,
  fixtureIds = REAL_FIXTURE_IDS,
  meta,
  now = () => new Date(),
  fresh = false,
  globalBudget,
}) {
  if (fresh && existsSync(realRoot)) rmSync(realRoot, { recursive: true, force: true });
  mkdirSync(realRoot, { recursive: true });

  const journalPath = join(realRoot, 'journal.ndjson');
  if (existsSync(journalPath)) {
    throw new Error(`refusing to start: ${journalPath} already exists. A capture session is not repeatable.`);
  }
  writeFileSync(journalPath, '', 'utf8');

  // Frozen before the first call, so any change to the runtime mid-capture is detectable.
  const fingerprintStart = runtimeFingerprint();
  const fingerprintStartSha256 = sha256(canonical(fingerprintStart));

  const recorder = createRecorder({ call, journalPath, now, ...(globalBudget === undefined ? {} : { globalBudget }) });
  const startedAt = now().toISOString();
  const results = [];
  let roundEndingViolation = null;

  // Every candidate in one session must belong to one set: mixing them would produce a
  // session record whose call accounting and ceiling span two separate authorizations.
  for (const fixtureId of fixtureIds) {
    if (candidateSetFor(fixtureId).setId !== candidateSetFor(fixtureIds[0]).setId) {
      throw new Error(`candidate "${fixtureId}" belongs to a different set than "${fixtureIds[0]}"`);
    }
  }

  for (const fixtureId of fixtureIds) {
    let result = null;
    try {
      result = await captureCandidate({
        fixtureId,
        recorder,
        outDir: join(realRoot, fixtureId),
        now,
        meta: { ...meta, runtimeFingerprintStartSha256: fingerprintStartSha256 },
      });
    } catch (err) {
      // A scope, retrieval, temperature or budget violation is an experiment-integrity
      // failure. Remaining candidates are abandoned rather than attempted, because the
      // harness that would run them is the thing now in doubt.
      if (isRoundEnding(err)) {
        roundEndingViolation = { fixtureId, code: err.code, message: String(err) };
        break;
      }
      throw err;
    }

    // The latch, not the throw, is what actually stops the round. Production catches each
    // worker call's exception itself, so a violation raised inside one would otherwise be
    // downgraded to an ordinary worker failure and the next candidate would be attempted.
    if (recorder.violation) {
      roundEndingViolation = { fixtureId, ...recorder.violation };
      results.push(result);
      break;
    }
    results.push(result);
  }

  const fingerprintEnd = runtimeFingerprint();
  const fingerprintEndSha256 = sha256(canonical(fingerprintEnd));
  const completedAt = now().toISOString();

  // Seal each manifest only now, so the end-of-capture fingerprint is inside the hash.
  for (const result of results) {
    const sealed = sealManifest({
      ...result.manifest,
      runtimeFingerprintEnd: fingerprintEndSha256,
    });
    writeFileSync(join(result.outDir, 'capture-manifest.json'), canonical(sealed), 'utf8');
    result.manifest = sealed;
  }

  const set = candidateSetFor(fixtureIds[0]);
  const session = {
    captureVersion: CAPTURE_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    candidateSet: set.setId,
    candidateSetFixtureIds: [...set.fixtureIds],
    ...meta,
    retrievalPolicy: RETRIEVAL_POLICY,
    temperaturePolicy: TEMPERATURE_POLICY,
    chiefPin: CHIEF_PIN,
    providerAllocation: PROVIDER_ALLOCATION,
    sourceCandidate: SOURCE_CANDIDATE,
    startedAt,
    completedAt,
    globalLiveCallCount: recorder.liveCallCount,
    roundEndingViolation,
    runtimeFingerprintStartSha256: fingerprintStartSha256,
    runtimeFingerprintEndSha256: fingerprintEndSha256,
    runtimeFingerprintDrift: fingerprintDiff(fingerprintStart, fingerprintEnd),
    attempts: results.map((r) => ({
      fixtureId: r.fixtureId,
      sourceCandidateId: SOURCE_CANDIDATE[r.fixtureId],
      captureStatus: r.manifest.captureStatus,
      complexity: r.manifest.actualComplexity,
      successfulWorkerCount: r.manifest.successfulWorkerCount,
      round1Status: r.manifest.round1Status,
      liveCallCount: r.manifest.liveCallCount,
      manifestSha256: r.manifest.manifestSha256,
    })),
  };
  writeFileSync(join(realRoot, 'capture-session.json'), canonical(session), 'utf8');

  return { session, results, recorder };
}
