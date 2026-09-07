/**
 * CBRP-CENSUS-1 session driver — planning only, offline-testable.
 *
 * ## Why this is not a CAPTURE-3 session
 *
 * A capture session produces a Round 1: a plan and the specialists it dispatched, sealed
 * as evidence about collaboration. A census produces sixty plans and nothing else. Reusing
 * CAPTURE-3's semantics would attach worker-shaped fields and a Round-1-shaped verifier to
 * a study that never runs a worker, and every reader after us would have to work out which
 * of those fields were meaningful. So the session format is its own: `CBRP-CENSUS-1`.
 *
 * ## The one ordering rule that matters
 *
 * Every check that can be made before a call is made before the attempt is reserved, and
 * the attempt is reserved and fsynced before the provider boundary. The reason is in
 * `attempt-registry.mjs`: an attempt that may have been spent but whose result is lost
 * cannot be retried, replaced, or skipped without corrupting a one-attempt study, so the
 * only safe design is to know it happened.
 *
 * ## Why the preflight recomputes instead of reading a flag
 *
 * An earlier version checked `buildBinding.match === true` and
 * `dependencyProvenance.problems.length === 0`. Both are conclusions someone else reached,
 * and a session that trusts them can be handed `{ match: true }` alongside the wrong
 * compiler and start spending attempts. The same pure comparison functions the verifier
 * uses are called here on the actual records, so preflight and verification cannot drift
 * into two policies, and a forged summary field buys nothing.
 *
 * ## Failure is not Y = 0
 *
 * A provider exception, a parse failure, a schema failure, a plan with no usable
 * assignments, or a resolved-pin mismatch all stop the session with
 * `sessionStatus = INCOMPLETE` and no verdict. None of them becomes an observed
 * non-event: recording a failure as `Y = 0` would silently bias the estimate downward by
 * exactly the failures the harness happened to produce.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ATTEMPT_RESERVED, ATTEMPT_SETTLED, AMBIGUOUS_ATTEMPT_CONSUMED,
  NEVER_ATTEMPTED, openAttemptRegistry, recoverSession,
} from './attempt-registry.mjs';
import { createPlanningRecorder, GLOBAL_LOGICAL_CALL_BUDGET, PER_TASK_LOGICAL_CALL_BUDGET, TRANSPORT_RETRY_POLICY } from './planning-recorder.mjs';
import { fingerprintDiff, runtimeFingerprint } from '../capture/runtime-fingerprint.mjs';
import { matchesCensusBaseline } from './census-provenance.mjs';
import { toolchainProblems } from './build-binding.mjs';
import { ALPHA, BETA, CBRP_N, METHOD_VERSION, THETA_FEAS, decide } from './statistics.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) => JSON.stringify(value, null, 2);

export const STUDY_VERSION = 'CBRP-CENSUS-1';

/** Architecture target for a future preregistration. No fallback, no substitution. */
export const EXPECTED_PLANNING_PIN = Object.freeze({ provider: 'openai', model: 'gpt-5' });

export const SESSION_COMPLETE = 'COMPLETE';
export const SESSION_INCOMPLETE = 'INCOMPLETE';
export const NO_STATISTICAL_VERDICT = 'NO_STATISTICAL_VERDICT';

export class CensusIntegrityError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CensusIntegrityError';
    this.code = code ?? 'CENSUS_INTEGRITY_VIOLATION';
  }
}

/** The formal event, derived only from the post-enforcement plan. */
export function deriveEvents(plan) {
  const eventDeep = plan.complexity === 'deep';
  const eventAssignedGte2 = plan.assignments.length >= 2;
  return { eventDeep, eventAssignedGte2, eventJoint: eventDeep && eventAssignedGte2 };
}

/**
 * Runs a census session.
 *
 * `runPlanningStage` is injected rather than imported so a rehearsal can drive the real
 * production function with a stub dispatcher, and so this file never becomes a second
 * place where a plan is parsed. It is always production's; nothing here re-implements
 * `planSchema`, `extractJsonObject` or `enforceConstraints`.
 */
export async function runCensusSession({
  tasks,
  taskManifestHash,
  runPlanningStage,
  call,
  workers,
  outDir,
  expectedPin = EXPECTED_PLANNING_PIN,
  executionHead,
  buildBinding,
  dependencyProvenance,
  runtimeFingerprintStart,
  runtimeFingerprintEnd = null,
  orderRule,
  now = () => new Date(),
  globalBudget = GLOBAL_LOGICAL_CALL_BUDGET,
  expectedN = CBRP_N,
  /** Injectable so a rehearsal can drive drift deterministically; production semantics unchanged. */
  fingerprint = runtimeFingerprint,
}) {
  mkdirSync(outDir, { recursive: true });
  const registryPath = join(outDir, 'attempt-registry.ndjson');

  // Recovery first: an unsettled reservation from an earlier run means an attempt may
  // already have been spent, and nothing below may run until a person has looked at it.
  const recovery = recoverSession(registryPath);
  if (!recovery.resumable) {
    return sealSession({
      outDir, now, taskManifestHash, executionHead, buildBinding, dependencyProvenance,
      runtimeFingerprintStart, runtimeFingerprintEnd, orderRule, expectedPin, globalBudget, expectedN,
      sessionStatus: SESSION_INCOMPLETE,
      stopReason: AMBIGUOUS_ATTEMPT_CONSUMED,
      stopDetail: recovery.detail,
      results: [],
      calls: [],
      startedAt: now().toISOString(),
    });
  }

  // CENSUS-REQ-09 / CENSUS-REQ-10. Everything that does not depend on a particular task
  // is checked once, before the registry is even opened, so a bad environment cannot
  // reserve an attempt on its way to being noticed.
  const sessionRefusal = precheckSession({
    buildBinding, dependencyProvenance, executionHead, expectedPin, runtimeFingerprintStart,
  });
  if (sessionRefusal) {
    return sealSession({
      outDir, now, taskManifestHash, executionHead, buildBinding, dependencyProvenance,
      runtimeFingerprintStart, runtimeFingerprintEnd, orderRule, expectedPin, globalBudget, expectedN,
      sessionStatus: SESSION_INCOMPLETE,
      stopReason: sessionRefusal.code,
      stopDetail: sessionRefusal.message,
      results: [], calls: [], startedAt: now().toISOString(),
      runtimeFingerprintDrift: [],
    });
  }

  const registry = openAttemptRegistry(registryPath);
  const recorder = createPlanningRecorder({ call, expectedPin, now, globalBudget });
  const startedAt = now().toISOString();
  const results = [];
  let stopReason = null;
  let stopDetail = null;

  try {
    for (const [orderIndex, task] of tasks.entries()) {
      // --- Everything checkable before the attempt is claimed.
      const drift = fingerprintDiff(runtimeFingerprintStart, fingerprint());
      const structural = drift.length
        ? { code: 'RUNTIME_DRIFT', message: `runtime changed before ${task.taskId}: ${drift.map((d) => d.file).join(', ')}` }
        : precheckTask(task, { tasks, executionHead, registry });
      if (structural) {
        // A pre-dispatch refusal is not a consumed attempt and must not look like one.
        stopReason = structural.code;
        stopDetail = structural.message;
        break;
      }

      registry.reserve(task.taskId, task.taskSha256, { orderIndex, reservedAt: now().toISOString() });

      // --- Provider boundary.
      const dispatch = recorder.dispatcherFor(task.taskId);
      let planning = null;
      let failure = null;
      try {
        planning = await runPlanningStage({
          task: task.text,
          orchestrator: { provider: expectedPin.provider, model: expectedPin.model },
          workers,
          call: dispatch,
        });
      } catch (err) {
        failure = { category: classifyFailure(err), error: String(err) };
      }

      const raw = recorder.callsFor(task.taskId).at(-1) ?? null;
      const events = planning ? deriveEvents(planning.plan) : { eventDeep: null, eventAssignedGte2: null, eventJoint: null };

      registry.settle(task.taskId, task.taskSha256, {
        settledAt: now().toISOString(),
        outcome: failure ? 'FAILED' : 'SUCCEEDED',
        failureCategory: failure?.category ?? null,
      });

      results.push({
        taskId: task.taskId,
        taskSha256: task.taskSha256,
        stratum: task.stratum,
        orderIndex,
        attemptState: ATTEMPT_SETTLED,
        providerRequested: raw?.providerRequested ?? null,
        modelRequested: raw?.modelRequested ?? null,
        providerResolved: raw?.providerResolved ?? null,
        modelResolved: raw?.modelResolved ?? null,
        rawResponseSha256: raw?.rawResponseSha256 ?? null,
        planningMs: planning?.planningMs ?? null,
        plan: planning?.plan ?? null,
        planningAdjustments: planning?.planningAdjustments ?? null,
        ...events,
        failureCategory: failure?.category ?? null,
        error: failure?.error ?? null,
      });

      if (failure) {
        // A settled failure is evidence and a consumed attempt. It is never Y = 0.
        stopReason = failure.category;
        stopDetail = failure.error;
        break;
      }
      if (recorder.violation) {
        stopReason = recorder.violation.code;
        stopDetail = recorder.violation.message;
        break;
      }
    }
  } finally {
    registry.close();
  }

  // CENSUS-REQ-09. The end fingerprint is required, and any net drift invalidates the
  // session even when all sixty calls succeeded: the plans were produced by a runtime we
  // can no longer name.
  const endFingerprint = runtimeFingerprintEnd ?? fingerprint();
  const drift = fingerprintDiff(runtimeFingerprintStart, endFingerprint);
  if (drift.length && stopReason === null) {
    stopReason = 'RUNTIME_DRIFT';
    stopDetail = `runtime changed during the session: ${drift.map((d) => d.file).join(', ')}`;
  }

  const complete = stopReason === null && drift.length === 0 && results.length === tasks.length;
  return sealSession({
    outDir, now, taskManifestHash, executionHead, buildBinding, dependencyProvenance,
    runtimeFingerprintStart, runtimeFingerprintEnd: endFingerprint, orderRule, expectedPin,
    globalBudget, expectedN,
    sessionStatus: complete ? SESSION_COMPLETE : SESSION_INCOMPLETE,
    stopReason, stopDetail, results,
    calls: recorder.calls,
    startedAt,
    runtimeFingerprintDrift: drift,
  });
}

/**
 * Session-wide preflight, recomputed rather than read.
 *
 * Every check here calls the same pure function the verifier calls, on the record itself.
 * A caller that hands over `{ match: true }` with the wrong compiler, or a provenance
 * object asserting `problems: []`, gets refused on the evidence rather than believed on
 * the summary.
 */
export function precheckSession({ buildBinding, dependencyProvenance, executionHead, expectedPin, runtimeFingerprintStart }) {
  const fail = (code, message) => ({ code, message });

  if (!executionHead) return fail('EXECUTION_HEAD_MISSING', 'no execution head recorded');
  if (!expectedPin?.provider || !expectedPin?.model) return fail('PIN_MISSING', 'no expected planning pin');

  if (!isFingerprint(runtimeFingerprintStart)) {
    return fail('RUNTIME_FINGERPRINT_MISSING', 'no runtime fingerprint was taken for the authorized execution state');
  }

  if (!buildBinding) return fail('BUILD_BINDING_MISMATCH', 'no build binding recorded');
  if (buildBinding.executionHead !== executionHead) {
    return fail('EXECUTION_HEAD_MISMATCH',
      `build binding names ${buildBinding.executionHead}, session names ${executionHead}`);
  }
  const toolchain = toolchainProblems(buildBinding.toolchain);
  if (toolchain.length) return fail('TOOLCHAIN_MISMATCH', toolchain.join('; '));
  if (buildBinding.match !== true) {
    return fail('BUILD_BINDING_MISMATCH', 'dist/ was not built from the authorized source');
  }

  const dependency = matchesCensusBaseline(dependencyProvenance ?? {});
  if (dependency.length) return fail('DEPENDENCY_MISMATCH', dependency.join('; '));

  return null;
}

const isFingerprint = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;

/** Everything that can refuse a task before an attempt is spent on it. */
/** Per-task checks. The environment-wide ones ran once, in `precheckSession`. */
function precheckTask(task, { tasks, executionHead, registry }) {
  const fail = (code, message) => ({ code, message });
  if (!task || typeof task.text !== 'string') return fail('TASK_MISSING', `${task?.taskId ?? '(unknown)'} has no text`);
  if (sha256(task.text) !== task.taskSha256) {
    return fail('TASK_HASH_MISMATCH', `${task.taskId} does not hash to its frozen ${task.taskSha256}`);
  }
  if (!tasks.some((t) => t.taskId === task.taskId)) return fail('MANIFEST_MEMBERSHIP', `${task.taskId} is not in the manifest`);
  if (registry.stateOf(task.taskId, task.taskSha256) !== NEVER_ATTEMPTED) {
    return fail('DUPLICATE_ATTEMPT', `${task.taskId} has already been attempted`);
  }
  return null;
}

function classifyFailure(err) {
  const text = String(err);
  if (/CENSUS_RESOLVED_PIN_MISMATCH/.test(text)) return 'RESOLVED_PIN_MISMATCH';
  if (/CENSUS_REQUEST_PIN_MISMATCH/.test(text)) return 'REQUEST_PIN_MISMATCH';
  if (/CENSUS_SCOPE_VIOLATION/.test(text)) return 'SCOPE_VIOLATION';
  if (/CENSUS_BUDGET_EXCEEDED/.test(text)) return 'BUDGET_VIOLATION';
  if (/did not return a JSON object/.test(text)) return 'PARSE_FAILURE';
  if (/no usable assignments/.test(text)) return 'CONSTRAINT_FAILURE';
  if (err?.name === 'ZodError' || /invalid_/.test(text) || /Invalid input/.test(text)) return 'SCHEMA_FAILURE';
  return 'PROVIDER_FAILURE';
}

/**
 * Writes the session artifact and computes the verdict, if one is allowed at all.
 *
 * The verdict gate is deliberately strict: a statistical conclusion is produced only from
 * a complete session of exactly N settled outcomes covering every frozen task once.
 * Anything else is `NO_STATISTICAL_VERDICT` — an incomplete census has no k.
 */
function sealSession(args) {
  const {
    outDir, now, taskManifestHash, executionHead, buildBinding, dependencyProvenance,
    runtimeFingerprintStart, runtimeFingerprintEnd, orderRule, expectedPin, globalBudget,
    expectedN, sessionStatus, stopReason, stopDetail, results, calls, startedAt,
    runtimeFingerprintDrift = [],
  } = args;

  const settled = results.filter((r) => r.attemptState === ATTEMPT_SETTLED && r.failureCategory === null);
  const uniqueIds = new Set(settled.map((r) => r.taskId));
  // A drifted runtime forfeits the verdict even if every call succeeded.
  const verdictAllowed = sessionStatus === SESSION_COMPLETE
    && runtimeFingerprintDrift.length === 0
    && settled.length === expectedN
    && uniqueIds.size === expectedN;

  const k = verdictAllowed ? settled.filter((r) => r.eventJoint === true).length : null;
  const statistics = verdictAllowed
    ? decide(k, { n: expectedN, alpha: ALPHA, beta: BETA, thetaFeas: THETA_FEAS })
    : { verdict: NO_STATISTICAL_VERDICT, reason: sessionStatus === SESSION_COMPLETE ? 'incomplete outcome set' : stopReason };

  const session = {
    studyVersion: STUDY_VERSION,
    methodVersion: METHOD_VERSION,
    executionHead,
    taskManifestHash,
    N: expectedN,
    thetaFeas: THETA_FEAS,
    alpha: ALPHA,
    beta: BETA,
    expectedPlanningProvider: expectedPin.provider,
    expectedPlanningModel: expectedPin.model,
    transportRetryPolicy: TRANSPORT_RETRY_POLICY,
    logicalCallBudget: globalBudget,
    perTaskLogicalCallBudget: PER_TASK_LOGICAL_CALL_BUDGET,
    attemptCount: results.length,
    logicalCallCount: calls.length,
    sessionStatus,
    stopReason,
    stopDetail,
    buildBinding,
    dependencyProvenance,
    runtimeFingerprintStart,
    runtimeFingerprintEnd,
    runtimeFingerprintStartSha256: runtimeFingerprintStart ? sha256(canonical(runtimeFingerprintStart)) : null,
    runtimeFingerprintEndSha256: runtimeFingerprintEnd ? sha256(canonical(runtimeFingerprintEnd)) : null,
    runtimeFingerprintDrift,
    orderRule,
    startedAt,
    completedAt: now().toISOString(),
    k,
    statistics,
    results,
    calls,
  };

  const sealed = { ...session, sessionSha256: sha256(canonical(session)) };
  writeFileSync(join(outDir, 'census-session.json'), canonical(sealed), 'utf8');
  if (calls.length) {
    writeFileSync(join(outDir, 'planning-journal.ndjson'), calls.map((c) => JSON.stringify(c)).join('\n') + '\n', 'utf8');
  }
  return { session: sealed, outDir, registryPath: join(outDir, 'attempt-registry.ndjson') };
}

export { sha256, canonical, ATTEMPT_RESERVED, ATTEMPT_SETTLED, existsSync };
