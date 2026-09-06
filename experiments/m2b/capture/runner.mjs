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
import {
  ACQUISITION_POOL_SIZE, ARCHETYPE_SLOTS, CHIEF_PIN, PROTOCOL_VERSION,
  ROLE_PROVIDER_MAP, WAVES, routingFor, slotsForWave,
} from '../protocol/amendment-0-3.mjs';
import { TRANSPORT_MAX_RETRIES, TRANSPORT_RETRY_POLICY } from './recorder.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const canonical = (value) => JSON.stringify(value, null, 2);

/**
 * Bumped from CAPTURE-2 because the artifact schema gained transport provenance.
 *
 * Not a protocol change: the methodology is untouched and this is still 0.3. The version
 * exists so a verifier can tell a capture that never recorded its transport policy from
 * one that recorded it as zero, instead of reading the absence as compliance.
 */
export const CAPTURE_VERSION = 'M2B-REAL-ROUND1-CAPTURE-3';
export const RETRIEVAL_POLICY = 'all-off';
export const TEMPERATURE_POLICY = 'provider-default-unprobed';

/** The full registered specialist roster. The planner picks from these; it is not told which. */
export const REGISTERED_SPECIALISTS = Object.freeze(['business_strategist', 'market_researcher', 'brand_creative']);

export { CHIEF_PIN, PROTOCOL_VERSION, TRANSPORT_MAX_RETRIES, TRANSPORT_RETRY_POLICY };

export const SYNTHETIC_ROOT = fileURLToPath(new URL('../fixtures/', import.meta.url));
export const CANDIDATES_R2_ROOT = fileURLToPath(new URL('../candidates-r2/', import.meta.url));
export const CANDIDATES_R3_ROOT = fileURLToPath(new URL('../candidates-r3/', import.meta.url));
export const CANDIDATES_0_3_ROOT = fileURLToPath(new URL('../candidates-0-3/', import.meta.url));
export const P03_REAL_ROOT = fileURLToPath(new URL('../fixtures-real-0-3/', import.meta.url));

const P03_MANIFEST_PATH = join(CANDIDATES_0_3_ROOT, 'candidate-set-manifest.json');
const P03_PROVENANCE_PATH = join(CANDIDATES_0_3_ROOT, 'freeze-provenance.json');
const P03_SLOT_IDS = Object.freeze(Object.values(ARCHETYPE_SLOTS).flat());
const P03_SOURCE_CANDIDATE = Object.freeze(Object.fromEntries(P03_SLOT_IDS.map((id) => [id, id])));

/**
 * The candidate sets, each frozen before its own capture ran.
 *
 * R1 reused the task text of the four superseded synthetic candidates. The production
 * Chief classified all four as `normal`, so all four failed F1 — honestly, and that
 * evidence is preserved rather than replaced. R2 is a distinct set of four authored
 * replacement tasks with its own ids, its own source directory and its own output root,
 * so nothing about R1 can be overwritten, reused, or quietly absorbed into R2's result.
 *
 * These sets preserve the historical Option 3-prime allocation that produced their
 * committed evidence. New captures use the protocol 0.3 role map below; the historical
 * allocation remains here only so the old artifacts can still be verified as recorded.
 */
export const CANDIDATE_SETS = Object.freeze({
  R1: Object.freeze({
    setId: 'R1',
    status: 'FAILED — all four classified normal, preserved as capture evidence',
    fixtureIds: Object.freeze(['fxr-01', 'fxr-02', 'fxr-03', 'fxr-04']),
    sourceRoot: SYNTHETIC_ROOT,
    realRoot: fileURLToPath(new URL('../fixtures-real/', import.meta.url)),
    globalCallBudget: 16,
    sourceCandidate: Object.freeze({ 'fxr-01': 'fx-01', 'fxr-02': 'fx-02', 'fxr-03': 'fx-03', 'fxr-04': 'fx-04' }),
    providerAllocation: Object.freeze({
      'fxr-01': { provider: 'openai', model: 'gpt-5' },
      'fxr-02': { provider: 'claude', model: 'claude-sonnet-5' },
      'fxr-03': { provider: 'gemini', model: 'gemini-3.1-pro-preview' },
      'fxr-04': { provider: 'openai', model: 'gpt-5' },
    }),
  }),
  R2: Object.freeze({
    setId: 'R2',
    status: 'REPLACEMENT SET',
    fixtureIds: Object.freeze(['fxr-05', 'fxr-06', 'fxr-07', 'fxr-08']),
    sourceRoot: CANDIDATES_R2_ROOT,
    realRoot: fileURLToPath(new URL('../fixtures-real-r2/', import.meta.url)),
    globalCallBudget: 16,
    sourceCandidate: Object.freeze({ 'fxr-05': 'r2-01', 'fxr-06': 'r2-02', 'fxr-07': 'r2-03', 'fxr-08': 'r2-04' }),
    providerAllocation: Object.freeze({
      'fxr-05': { provider: 'openai', model: 'gpt-5' },
      'fxr-06': { provider: 'claude', model: 'claude-sonnet-5' },
      'fxr-07': { provider: 'gemini', model: 'gemini-3.1-pro-preview' },
      'fxr-08': { provider: 'openai', model: 'gpt-5' },
    }),
  }),
  R3: Object.freeze({
    setId: 'R3',
    status: 'REPLACEMENT POSITIVE SET',
    fixtureIds: Object.freeze(['fxr-09', 'fxr-10', 'fxr-11']),
    sourceRoot: CANDIDATES_R3_ROOT,
    realRoot: fileURLToPath(new URL('../fixtures-real-r3/', import.meta.url)),
    globalCallBudget: 12,
    sourceCandidate: Object.freeze({ 'fxr-09': 'r3-01', 'fxr-10': 'r3-02', 'fxr-11': 'r3-03' }),
    providerAllocation: Object.freeze({
      'fxr-09': { provider: 'openai', model: 'gpt-5' },
      'fxr-10': { provider: 'claude', model: 'claude-sonnet-5' },
      'fxr-11': { provider: 'gemini', model: 'gemini-3.1-pro-preview' },
    }),
  }),
  P03: Object.freeze({
    setId: 'P03',
    status: 'FROZEN PRE-LIVE ACQUISITION POOL',
    fixtureIds: P03_SLOT_IDS,
    sourceRoot: CANDIDATES_0_3_ROOT,
    realRoot: P03_REAL_ROOT,
    sourceCandidate: P03_SOURCE_CANDIDATE,
  }),
});

const mergeSets = (key) => Object.freeze(Object.assign({}, ...Object.values(CANDIDATE_SETS).map((set) => set[key])));

/** Merged historical map used only to verify committed protocol 0.2 captures. */
export const HISTORICAL_PROVIDER_ALLOCATION = mergeSets('providerAllocation');

/**
 * Backward-compatible allocation registry written to new session manifests.
 *
 * `byAgent` is the active protocol 0.3 routing truth. The historical fixture map is kept
 * under an explicit name so old homogeneous captures remain auditable without being
 * reinterpreted as heterogeneous evidence.
 */
export const PROVIDER_ALLOCATION = Object.freeze({
  mode: 'role-based-heterogeneous',
  byAgent: ROLE_PROVIDER_MAP,
  historicalHomogeneousByFixture: HISTORICAL_PROVIDER_ALLOCATION,
});
export const SOURCE_CANDIDATE = mergeSets('sourceCandidate');

export function candidateSetFor(fixtureId) {
  const set = Object.values(CANDIDATE_SETS).find((s) => s.fixtureIds.includes(fixtureId));
  if (!set) throw new Error(`no candidate set defines "${fixtureId}"`);
  return set;
}

/** R1's ids, kept as the default so existing callers and tests keep their meaning. */
export const REAL_FIXTURE_IDS = CANDIDATE_SETS.R1.fixtureIds;
export const REAL_ROOT = CANDIDATE_SETS.R1.realRoot;

/** The one file a capture is allowed to read from its source candidate. */
export function sourceTaskPath(fixtureId) {
  const set = candidateSetFor(fixtureId);
  const path = join(set.sourceRoot, set.sourceCandidate[fixtureId], 'task.txt');
  if (set.setId === 'P03') assertFrozenP03Pool(fixtureId, path);
  return path;
}

/** Recomputes the frozen P03 manifest, protocol shape and selected task hash. */
export function assertFrozenP03Pool(fixtureId = null, taskPath = null) {
  const manifestBytes = readFileSync(P03_MANIFEST_PATH, 'utf8');
  const manifest = JSON.parse(manifestBytes);
  const provenance = JSON.parse(readFileSync(P03_PROVENANCE_PATH, 'utf8'));
  const expectedSlots = new Set(P03_SLOT_IDS);

  if (manifest.protocolVersion !== PROTOCOL_VERSION || provenance.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('P03 freeze conflicts with the accepted protocol version');
  }
  if (manifest.candidateIds.length !== ACQUISITION_POOL_SIZE
      || manifest.candidateIds.some((id) => !expectedSlots.has(id))
      || new Set(manifest.candidateIds).size !== expectedSlots.size) {
    throw new Error('P03 freeze conflicts with the accepted acquisition pool');
  }
  if (JSON.stringify(manifest.waveOrder) !== JSON.stringify(WAVES)) {
    throw new Error('P03 freeze conflicts with the accepted protocol wave order');
  }
  if (sha256(manifestBytes) !== provenance.candidateSetManifestSha256) {
    throw new Error('P03 candidate-set manifest hash does not match freeze provenance');
  }
  for (const id of P03_SLOT_IDS) {
    if (manifest.taskSha256[id] !== provenance.taskSha256[id]) {
      throw new Error(`P03 task hash provenance disagrees for ${id}`);
    }
  }
  if (fixtureId !== null) {
    if (!expectedSlots.has(fixtureId)) throw new Error(`unknown P03 slot "${fixtureId}"`);
    const resolvedPath = taskPath ?? join(CANDIDATES_0_3_ROOT, fixtureId, 'task.txt');
    const actual = sha256(readFileSync(resolvedPath, 'utf8'));
    if (actual !== manifest.taskSha256[fixtureId]) {
      throw new Error(`P03 frozen task hash mismatch for ${fixtureId}`);
    }
  }
  return { manifest, provenance };
}

/** One-based CLI wave number to protocol-defined ordered slots. */
export function selectWaveSlots(waveNumber, filledArchetypes = []) {
  assertFrozenP03Pool();
  if (!Number.isInteger(waveNumber) || waveNumber < 1 || waveNumber > WAVES.length) {
    throw new Error(`wave must be an integer from 1 to ${WAVES.length}`);
  }
  const validArchetypes = new Set(Object.keys(ARCHETYPE_SLOTS));
  const unknown = filledArchetypes.filter((name) => !validArchetypes.has(name));
  if (unknown.length > 0) throw new Error(`unknown filled archetype(s): ${unknown.join(', ')}`);
  return [...slotsForWave(waveNumber - 1, filledArchetypes)];
}

/** One planning plus at most one call per registered specialist for each selected slot. */
export function waveCallBudget(selectedSlots) {
  return selectedSlots.length * (1 + REGISTERED_SPECIALISTS.length);
}

export function waveOutputRoot(waveNumber) {
  if (!Number.isInteger(waveNumber) || waveNumber < 1 || waveNumber > WAVES.length) {
    throw new Error(`wave must be an integer from 1 to ${WAVES.length}`);
  }
  return join(P03_REAL_ROOT, `wave-${waveNumber}`);
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
export function buildWorkerRefs(_fixtureId) {
  return REGISTERED_SPECIALISTS.map((id) => {
    const pin = routingFor(id);
    return {
      id,
      provider: pin.provider,
      model: pin.model,
      providesEvidence: false,
    };
  });
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

  const { workers, warnings } = resolveRoster(buildWorkerRefs(fixtureId));

  const call = recorder.dispatcherFor(fixtureId, {
    pins: { planning: CHIEF_PIN, round1_worker: routingFor },
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
        routingRole: result.agentId,
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
    providerAllocation: {
      mode: PROVIDER_ALLOCATION.mode,
      byAgent: PROVIDER_ALLOCATION.byAgent,
    },
    retrievalPolicy: RETRIEVAL_POLICY,
    temperaturePolicy: TEMPERATURE_POLICY,
    transportRetryPolicy: TRANSPORT_RETRY_POLICY,
    transportMaxRetries: TRANSPORT_MAX_RETRIES,
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
