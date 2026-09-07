/**
 * Planning-only recording dispatcher for a CBRP census session.
 *
 * ## Why this is not the capture recorder
 *
 * The M2-B recorder allows `planning` and `round1_worker`, and its budget is slots x 4
 * because a candidate is a plan plus its specialists. A census is planning only: one call
 * per task, sixty in total, and a worker call is not a budget overrun but a category
 * error. Reusing the capture recorder would mean a worker dispatch stayed inside the
 * allowlist and merely counted against a budget, which is the wrong refusal.
 *
 * So the allowlist is one stage long and the budgets are flat: 60 global, 1 per task.
 *
 * Every guard is pre-call, for the same reason as in capture: a live call cannot be taken
 * back, so a violation must stop the request rather than annotate the artifact afterwards.
 * The transport no-retry option is injected here too, so one logical call is one HTTP
 * attempt and the census budget bounds requests as well as dispatches.
 */
import { createHash } from 'node:crypto';
import { TRANSPORT_MAX_RETRIES, TRANSPORT_RETRY_POLICY } from '../capture/recorder.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export const CENSUS_ALLOWED_STAGES = Object.freeze(['planning']);
export const GLOBAL_LOGICAL_CALL_BUDGET = 60;
export const PER_TASK_LOGICAL_CALL_BUDGET = 1;

export { TRANSPORT_MAX_RETRIES, TRANSPORT_RETRY_POLICY };

const error = (name, code) => class extends Error {
  constructor(message) { super(message); this.name = name; this.code = code; }
};

export const CensusScopeViolation = error('CensusScopeViolation', 'CENSUS_SCOPE_VIOLATION');
export const CensusRetrievalViolation = error('CensusRetrievalViolation', 'CENSUS_RETRIEVAL_VIOLATION');
export const CensusTemperatureViolation = error('CensusTemperatureViolation', 'CENSUS_TEMPERATURE_VIOLATION');
export const CensusBudgetExceeded = error('CensusBudgetExceeded', 'CENSUS_BUDGET_EXCEEDED');
export const CensusRequestPinMismatch = error('CensusRequestPinMismatch', 'CENSUS_REQUEST_PIN_MISMATCH');
export const CensusResolvedPinMismatch = error('CensusResolvedPinMismatch', 'CENSUS_RESOLVED_PIN_MISMATCH');
export const CensusDuplicateDispatch = error('CensusDuplicateDispatch', 'CENSUS_DUPLICATE_DISPATCH');

/**
 * @param {object} input
 * @param {Function} input.call            underlying dispatcher (production `callProvider` when live)
 * @param {{provider:string, model:string}} input.expectedPin  the only route a census call may take
 */
export function createPlanningRecorder({
  call,
  expectedPin,
  now = () => new Date(),
  globalBudget = GLOBAL_LOGICAL_CALL_BUDGET,
}) {
  const calls = [];
  const dispatchedTasks = new Set();
  let reserved = 0;
  let seq = 0;
  let violation = null;

  /** Latches a round-ending violation; a throw alone can be swallowed by a caller's catch. */
  const halt = (err) => {
    if (!violation) violation = { code: err.code, message: String(err) };
    return err;
  };

  const dispatcherFor = (taskId) => {
    if (dispatchedTasks.has(taskId)) throw halt(new CensusDuplicateDispatch(`${taskId} already dispatched a planning call.`));
    dispatchedTasks.add(taskId);
    let taskCalls = 0;

    return async (provider, prompt, options = {}) => {
      const stage = options.stage;

      // --- Pre-call guards. Each stops the request; none annotates it afterwards.
      if (!stage || !CENSUS_ALLOWED_STAGES.includes(stage)) {
        throw halt(new CensusScopeViolation(
          `CENSUS_SCOPE_VIOLATION: stage "${stage ?? '(none)'}" is not authorized; a census is planning only. Provider NOT called.`));
      }
      if (options.retrieval != null) {
        throw halt(new CensusRetrievalViolation('CENSUS_RETRIEVAL_VIOLATION: retrieval is off for the census. Provider NOT called.'));
      }
      if (options.temperature !== undefined) {
        throw halt(new CensusTemperatureViolation(
          `CENSUS_TEMPERATURE_VIOLATION: temperature ${options.temperature} under a provider-default-unprobed policy. Provider NOT called.`));
      }
      if (reserved >= globalBudget) {
        throw halt(new CensusBudgetExceeded(`CENSUS_BUDGET_EXCEEDED: global budget of ${globalBudget} is spent. Provider NOT called.`));
      }
      if (taskCalls >= PER_TASK_LOGICAL_CALL_BUDGET) {
        throw halt(new CensusBudgetExceeded(
          `CENSUS_BUDGET_EXCEEDED: ${taskId} already spent its ${PER_TASK_LOGICAL_CALL_BUDGET}-call budget. Provider NOT called.`));
      }
      if (provider !== expectedPin.provider || options.model !== expectedPin.model) {
        throw halt(new CensusRequestPinMismatch(
          `CENSUS_REQUEST_PIN_MISMATCH: expected ${expectedPin.provider}/${expectedPin.model}, `
            + `requested ${provider}/${options.model ?? null}. Provider NOT called.`));
      }

      taskCalls += 1;
      reserved += 1;
      const callOptions = { ...options, transportMaxRetries: TRANSPORT_MAX_RETRIES };
      const startedAt = now().toISOString();
      const startMs = Date.now();
      const base = {
        seq: (seq += 1),
        taskId,
        stage,
        providerRequested: provider,
        modelRequested: options.model ?? null,
        promptSha256: sha256(prompt),
        systemPromptSha256: options.system ? sha256(options.system) : null,
        transportRetryPolicy: TRANSPORT_RETRY_POLICY,
        transportMaxRetriesRequested: callOptions.transportMaxRetries,
        startedAt,
      };

      let result;
      try {
        result = await call(provider, prompt, callOptions);
      } catch (err) {
        calls.push({
          ...base, ms: Date.now() - startMs,
          providerResolved: null, modelResolved: null,
          rawResponseSha256: null, rawResponseChars: null,
          success: false, pinMismatch: false, error: String(err),
        });
        throw err;
      }

      const pinMismatch = result.provider !== expectedPin.provider || result.model !== expectedPin.model;
      calls.push({
        ...base, ms: Date.now() - startMs,
        providerResolved: result.provider,
        modelResolved: result.model,
        rawResponseSha256: sha256(result.text),
        rawResponseChars: result.text.length,
        success: !pinMismatch,
        pinMismatch,
        error: pinMismatch
          ? `CENSUS_RESOLVED_PIN_MISMATCH: expected ${expectedPin.provider}/${expectedPin.model}, `
            + `resolved ${result.provider}/${result.model}`
          : null,
      });

      if (pinMismatch) {
        throw halt(new CensusResolvedPinMismatch(
          `CENSUS_RESOLVED_PIN_MISMATCH: expected ${expectedPin.provider}/${expectedPin.model}, `
            + `resolved ${result.provider}/${result.model}. Response preserved; call INVALID.`));
      }
      return result;
    };
  };

  return {
    dispatcherFor,
    get calls() { return [...calls]; },
    get logicalCallCount() { return calls.length; },
    get reservedCallCount() { return reserved; },
    get violation() { return violation; },
    callsFor: (taskId) => calls.filter((c) => c.taskId === taskId),
  };
}

export { sha256 };
