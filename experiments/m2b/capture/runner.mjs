/**
 * M2-B Real Round 1 capture runner.
 *
 * Produces a frozen Round 1 that production actually generated: real Chief planning, real
 * specialist assignments, real provider outputs, real provenance. The synthetic fixtures
 * this replaces had their Round 1 hand-written and provider metadata attached afterwards,
 * which made every downstream provenance claim about them unsupportable.
 *
 * ## Why this calls runRound1Stage and not runOrchestrator
 *
 * `runOrchestrator` legitimately continues into synthesis for exactly the runs this
 * experiment needs — DEEP, SUCCESS, two or more specialists. Calling it and then trying to
 * stop would either burn a synthesis call or require a production flag whose only purpose
 * is to serve the experiment. `runRound1Stage` is the production boundary that makes the
 * capture possible without either.
 *
 * ## What this reads from the old synthetic fixtures
 *
 * `task.txt`, and nothing else. The old missions, Round 1 texts, roster, snapshot, conflict
 * labels and gold issues are archival: reading any of them here would let superseded
 * synthetic material shape the planner's assignments or the capture's success criteria,
 * which is the contamination this whole re-capture exists to remove.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { resolveRoster } from '../../../dist/agents/registry.js';
import { runRound1Stage, toRound1Snapshot } from '../../../dist/modes/orchestrator.js';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const canonical = (value) => JSON.stringify(value, null, 2);

export const CAPTURE_VERSION = 'M2B-REAL-ROUND1-CAPTURE-1';
export const PROTOCOL_VERSION = 'M2B-PROTOCOL-0.2';
export const RETRIEVAL_POLICY = 'all-off';
export const TEMPERATURE_POLICY = 'provider-default-unprobed';

/** The full registered specialist roster. The planner picks from these; it is not told which. */
export const REGISTERED_SPECIALISTS = Object.freeze(['business_strategist', 'market_researcher', 'brand_creative']);

/** Every specialist of a candidate shares one provider and model, so C and D-1 targets are pinned before the Gate exists. */
export const PROVIDER_ALLOCATION = Object.freeze({
  'fxr-01': { provider: 'openai', model: 'gpt-5' },
  'fxr-02': { provider: 'claude', model: 'claude-sonnet-5' },
  'fxr-03': { provider: 'gemini', model: 'gemini-3.1-pro-preview' },
  'fxr-04': { provider: 'openai', model: 'gpt-5' },
});

/** Chief is pinned identically across all four, explicitly rather than by env default. */
export const CHIEF_PIN = Object.freeze({ provider: 'openai', model: 'gpt-5' });

export const SOURCE_CANDIDATE = Object.freeze({
  'fxr-01': 'fx-01',
  'fxr-02': 'fx-02',
  'fxr-03': 'fx-03',
  'fxr-04': 'fx-04',
});

export const REAL_FIXTURE_IDS = Object.freeze(['fxr-01', 'fxr-02', 'fxr-03', 'fxr-04']);

export const SYNTHETIC_ROOT = fileURLToPath(new URL('../fixtures/', import.meta.url));
export const REAL_ROOT = fileURLToPath(new URL('../fixtures-real/', import.meta.url));

/** The one file the capture is allowed to take from a superseded synthetic candidate. */
export function sourceTaskPath(fixtureId) {
  return join(SYNTHETIC_ROOT, SOURCE_CANDIDATE[fixtureId], 'task.txt');
}

/**
 * The worker refs handed to production `resolveRoster`.
 *
 * `providesEvidence: false` is what actually enforces the all-off retrieval policy: it
 * makes `evidenceCapable` false in the resolved worker, and production only attaches a
 * retrieval request to an evidence-capable specialist. The role text is left exactly as the
 * registry defines it — market_researcher is still the Research Analyst, it simply may not
 * search during this experiment.
 */
export function buildWorkerRefs(fixtureId) {
  const pin = PROVIDER_ALLOCATION[fixtureId];
  if (!pin) throw new Error(`no provider allocation for ${fixtureId}`);
  return REGISTERED_SPECIALISTS.map((id) => ({
    id,
    provider: pin.provider,
    model: pin.model,
    providesEvidence: false,
  }));
}

/**
 * Runs one candidate's single capture attempt and writes its artifacts.
 *
 * Returns a result rather than throwing for candidate-level failure: a failed attempt is
 * evidence that must be preserved and committed, not an error to unwind. Round-level
 * violations — scope, retrieval, budget — do propagate, because those must stop everything.
 */
export async function captureCandidate({ fixtureId, recorder, outDir, meta, now = () => new Date() }) {
  const taskPath = sourceTaskPath(fixtureId);
  const task = readFileSync(taskPath, 'utf8');
  const taskSha256 = sha256(task);

  const pin = PROVIDER_ALLOCATION[fixtureId];
  const { workers, warnings } = resolveRoster(buildWorkerRefs(fixtureId));

  const call = recorder.dispatcherFor(fixtureId, {
    pins: { planning: CHIEF_PIN, round1_worker: pin },
    workers,
  });

  const startedAt = now().toISOString();
  let round1 = null;
  let fatalError = null;
  try {
    round1 = await runRound1Stage({
      task,
      orchestrator: { provider: CHIEF_PIN.provider, model: CHIEF_PIN.model },
      workers,
      call,
    });
  } catch (err) {
    // Planning failures, and pin mismatches on the planning call, land here. The attempt is
    // over and cannot be retried; what matters is that the journal already holds the raw call.
    fatalError = String(err);
  }
  const completedAt = now().toISOString();

  mkdirSync(outDir, { recursive: true });
  const write = (name, contents) => {
    writeFileSync(join(outDir, name), contents, 'utf8');
    return sha256(contents);
  };

  const rawCalls = recorder.callsFor(fixtureId);
  const files = {};
  files['task.txt'] = write('task.txt', task);
  files['available-roster.json'] = write('available-roster.json', canonical({ refs: buildWorkerRefs(fixtureId), workers, warnings }));

  const perWorker = [];
  if (round1) {
    files['planner-result.json'] = write('planner-result.json', canonical(round1.plan));
    files['planning-adjustments.json'] = write('planning-adjustments.json', canonical(round1.planningAdjustments));
    files['snapshot.json'] = write('snapshot.json', canonical(toRound1Snapshot(round1, task, workers)));
    files['report.json'] = write('report.json', canonical(round1.report));

    for (const result of round1.workerResults) {
      const worker = workers.find((w) => w.id === result.agentId);
      const raw = rawCalls.find((c) => c.stage === 'round1_worker' && c.agentId === result.agentId) ?? null;
      files[`mission-${result.agentId}.txt`] = write(`mission-${result.agentId}.txt`, result.mission);
      if (typeof result.output === 'string') {
        files[`round1-${result.agentId}.md`] = write(`round1-${result.agentId}.md`, result.output);
      }
      perWorker.push({
        agentId: result.agentId,
        roleSha256: sha256(worker.role),
        missionSha256: sha256(result.mission),
        outputSha256: typeof result.output === 'string' ? sha256(result.output) : null,
        providerRequested: worker.provider,
        providerResolved: raw?.providerResolved ?? null,
        modelRequested: worker.model ?? null,
        modelResolved: raw?.modelResolved ?? null,
        status: typeof result.output === 'string' ? 'SUCCESS' : 'FAILED',
        error: result.error ?? null,
        retrievalRequested: false,
        retrievalResult: result.retrieval ?? null,
      });
    }
  }

  files['raw-calls.json'] = write('raw-calls.json', canonical(rawCalls));

  const planningCall = rawCalls.find((c) => c.stage === 'planning') ?? null;
  const successfulWorkerCount = round1 ? round1.workerResults.filter((r) => typeof r.output === 'string').length : 0;
  const failedWorkerCount = round1 ? round1.workerResults.length - successfulWorkerCount : 0;

  // The manifest's status is derived from the eligibility gates, never from "did the code
  // finish without throwing". A run that completes cleanly but comes back `normal`, or with
  // one specialist, or DEGRADED, is a failed candidate — and the manifest has to say so
  // rather than record CAPTURED and leave the contradiction for a reader to notice. The
  // fixture obeys the result; the result is not adjusted to keep the fixture.
  const f1 = round1?.plan.complexity === 'deep';
  const f2 = successfulWorkerCount >= 2;
  const f3 = round1?.report.status === 'SUCCESS';
  const captureStatus = !fatalError && f1 && f2 && f3 ? 'CAPTURED' : 'FAILED';
  const failureReasons = [
    fatalError ? `fatal: ${fatalError}` : null,
    round1 && !f1 ? `F1: complexity is ${round1.plan.complexity}, not deep` : null,
    round1 && !f2 ? `F2: ${successfulWorkerCount} specialist(s) returned output, fewer than two` : null,
    round1 && !f3 ? `F3: RunStatus is ${round1.report.status}, not SUCCESS` : null,
  ].filter(Boolean);

  const manifest = {
    fixtureId,
    sourceCandidateId: SOURCE_CANDIDATE[fixtureId],
    captureVersion: CAPTURE_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    executionHead: meta.executionHead,
    productionBoundaryCommit: meta.productionBoundaryCommit,
    promptSourceCommit: meta.promptSourceCommit,
    captureHarnessCommit: meta.captureHarnessCommit,
    nodeVersion: meta.nodeVersion,
    taskSha256,
    startedAt,
    completedAt,
    captureStatus,
    eligibility: { F1: f1, F2: f2, F3: f3 },
    failureReasons,
    fatalError,
    chiefPin: {
      provider: CHIEF_PIN.provider,
      requestedModel: CHIEF_PIN.model,
      resolvedModel: planningCall?.modelResolved ?? null,
      resolvedProvider: planningCall?.providerResolved ?? null,
    },
    providerAllocation: pin,
    retrievalPolicy: RETRIEVAL_POLICY,
    temperaturePolicy: TEMPERATURE_POLICY,
    actualComplexity: round1?.plan.complexity ?? null,
    plannerAssignments: round1?.plan.assignments ?? null,
    planningAdjustments: round1?.planningAdjustments ?? null,
    round1Status: round1?.report.status ?? null,
    successfulWorkerCount,
    failedWorkerCount,
    liveCallCount: rawCalls.length,
    agentOrder: round1?.plan.assignments.map((a) => a.agentId) ?? null,
    availableRosterSha256: files['available-roster.json'],
    snapshotSha256: files['snapshot.json'] ?? null,
    rawCallsSha256: files['raw-calls.json'],
    runtimeFingerprintStart: meta.runtimeFingerprintStartSha256,
    runtimeFingerprintEnd: null,
    postRound1Execution: 'NONE',
    gateExecution: 'NONE',
    synthesisExecution: 'NONE',
    workers: perWorker,
    fileHashes: files,
  };

  return { fixtureId, manifest, round1, fatalError, rawCalls, outDir };
}

/** True when this attempt met every eligibility gate. Recomputed, never read from a field. */
export function isEligible(manifest) {
  return manifest.captureStatus === 'CAPTURED';
}

/**
 * Seals a manifest by hashing its canonical form with the hash field itself excluded.
 * Kept separate from capture so the end-of-round fingerprint can be filled in first.
 */
export function sealManifest(manifest) {
  const { manifestSha256, ...rest } = manifest;
  return { ...rest, manifestSha256: sha256(canonical(rest)) };
}

export { sha256 };
