/**
 * Recording dispatcher for the M2-B Real Round 1 capture.
 *
 * This wraps production `callProvider` rather than replacing or re-implementing any
 * provider adapter: the capture must exercise the same code path a real run does, or the
 * Round 1 it freezes is not the one production would have produced.
 *
 * Everything here exists because a live call costs money and cannot be taken back. So the
 * guards are all *pre-call*: a violation must stop the request before it is issued, not be
 * noticed in the artifact afterwards. The four that can end the whole round are scope,
 * retrieval, budget and journal integrity.
 *
 * ## What "resolved" means here (and does not)
 *
 * `providerResolved` / `modelResolved` are the provider and model the *adapter* reports
 * having used. They are client-observed effective routing. They are not a vendor server
 * build, a weight version, or a backend deployment id — this codebase never receives those,
 * so no check built on these fields may be described as attesting to them.
 *
 * `startedAt` is likewise taken in this process immediately before the request is issued.
 * It records when the harness sent the call. It is not a server execution timestamp.
 */
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/** Stages this round is authorized to send to a provider. Everything else is a violation. */
export const ALLOWED_STAGES = Object.freeze(['planning', 'round1_worker']);

/** 4 candidates x (1 planning + at most 3 Round 1 workers). */
export const GLOBAL_CALL_BUDGET = 16;
export const PER_CANDIDATE_CALL_BUDGET = 4;

/** A post-Round1 stage was requested. Ends the round, not just the candidate. */
export class ScopeViolation extends Error {
  constructor(stage) {
    super(`SCOPE_VIOLATION_POST_ROUND1_CALL: stage "${stage}" is not authorized this round. Provider NOT called.`);
    this.name = 'ScopeViolation';
    this.code = 'SCOPE_VIOLATION_POST_ROUND1_CALL';
    this.stage = stage;
  }
}

/** Retrieval reached a call while the protocol pins retrievalPolicy to all-off. */
export class RetrievalPolicyViolation extends Error {
  constructor(stage) {
    super(`RETRIEVAL_POLICY_VIOLATION: stage "${stage}" carried retrieval under an all-off policy. Provider NOT called.`);
    this.name = 'RetrievalPolicyViolation';
    this.code = 'RETRIEVAL_POLICY_VIOLATION';
    this.stage = stage;
  }
}

/** Temperature was set. This round records the provider default and probes nothing. */
export class TemperaturePolicyViolation extends Error {
  constructor(stage, temperature) {
    super(`TEMPERATURE_POLICY_VIOLATION: stage "${stage}" requested temperature ${temperature} under a provider-default-unprobed policy. Provider NOT called.`);
    this.name = 'TemperaturePolicyViolation';
    this.code = 'TEMPERATURE_POLICY_VIOLATION';
    this.stage = stage;
  }
}

export class CallBudgetExceeded extends Error {
  constructor(scope, limit) {
    super(`CALL_BUDGET_EXCEEDED: ${scope} budget of ${limit} is already spent. Provider NOT called.`);
    this.name = 'CallBudgetExceeded';
    this.code = 'CALL_BUDGET_EXCEEDED';
    this.scope = scope;
    this.limit = limit;
  }
}

/**
 * A worker call could not be attributed to exactly one specialist.
 *
 * Round 1 worker calls do not carry an agent id — production passes the specialist's role
 * as the system prompt and nothing else identifies it. So attribution is by exact role
 * match against the resolved roster, and an ambiguous or absent match is a capture defect,
 * never something to resolve by guessing.
 */
export class WorkerBindingError extends Error {
  constructor(matches) {
    super(`INVALID_CAPTURE: a round1_worker call matched ${matches} specialists in the resolved roster; exactly one is required.`);
    this.name = 'WorkerBindingError';
    this.code = 'INVALID_CAPTURE';
    this.matches = matches;
  }
}

/**
 * The adapter answered as a different provider or model than the pin requested.
 *
 * Per protocol §15 the raw response and its provenance are kept — they are evidence of
 * what actually happened — but the call is invalid and its text must not be used. Thrown
 * rather than returned so a worker call becomes a Round 1 failure instead of quietly
 * contributing text under a model name that did not produce it.
 */
export class ModelPinMismatch extends Error {
  constructor(stage, requested, resolved) {
    super(`MODEL_PIN_MISMATCH at stage "${stage}": requested ${requested}, resolved ${resolved}. Response preserved; call INVALID.`);
    this.name = 'ModelPinMismatch';
    this.code = 'MODEL_PIN_MISMATCH';
    this.stage = stage;
    this.requested = requested;
    this.resolved = resolved;
  }
}

/** A candidate may be attempted once. A second attempt invalidates it by protocol. */
export class DuplicateAttempt extends Error {
  constructor(fixtureId) {
    super(`INVALID_BY_PROTOCOL: ${fixtureId} has already been attempted this session. One attempt per candidate.`);
    this.name = 'DuplicateAttempt';
    this.code = 'INVALID_BY_PROTOCOL';
    this.fixtureId = fixtureId;
  }
}

/**
 * @param {object} input
 * @param {Function} input.call Underlying dispatcher. Offline tests pass a stub; a live run passes production `callProvider`.
 * @param {string|null} [input.journalPath] Write-ahead journal (NDJSON). Every call is appended the moment it settles.
 * @param {() => Date} [input.now] Injectable clock, so timestamp behaviour is testable without a provider.
 * @param {number} [input.globalBudget]
 */
export function createRecorder({ call, journalPath = null, now = () => new Date(), globalBudget = GLOBAL_CALL_BUDGET }) {
  const calls = [];
  const attempted = new Set();
  let seq = 0;
  let violation = null;

  /**
   * Budget slots claimed, as distinct from calls that have settled.
   *
   * Production dispatches Round 1 workers through `Promise.all`, so every worker's guard
   * runs before any of their responses arrive. A budget checked against `calls.length` —
   * which only grows once a call settles — would see the same stale count in all of them
   * and let the whole batch through, overshooting the hard maximum by up to two calls. The
   * slot is therefore claimed synchronously, in the same turn as the check.
   */
  let reserved = 0;

  /**
   * Latches a round-ending violation, because throwing is not enough to stop the round.
   *
   * Production wraps each Round 1 worker call in its own try/catch, so that a single
   * specialist failing does not lose the others. That is correct for a run and wrong for a
   * guard: a retrieval, temperature or budget violation raised inside a worker call would
   * be caught there, recorded as an ordinary worker error, and the session would carry on
   * to the next candidate having already broken protocol. The latch survives being
   * swallowed, and the session reads it rather than relying on the throw arriving.
   */
  const halt = (err) => {
    if (!violation) violation = { code: err.code, message: String(err), stage: err.stage ?? null };
    return err;
  };

  /**
   * Appends one record to the journal before returning control.
   *
   * Live calls have already been paid for by the time they settle, so the evidence must
   * reach durable storage immediately. Buffering all four candidates in memory and writing
   * at the end would lose every call to a single crash.
   */
  const journal = (record) => {
    calls.push(record);
    if (journalPath) appendFileSync(journalPath, JSON.stringify(record) + '\n', 'utf8');
  };

  /**
   * Builds the `call`-shaped function for one candidate.
   *
   * @param {string} fixtureId
   * @param {object} config
   * @param {{provider:string, model:string}} config.pins.planning
   * @param {{provider:string, model:string}} config.pins.round1_worker
   * @param {Array<{id:string, role:string, provider:string, model:string}>} config.workers Resolved production roster.
   */
  const dispatcherFor = (fixtureId, { pins, workers }) => {
    if (attempted.has(fixtureId)) throw new DuplicateAttempt(fixtureId);
    attempted.add(fixtureId);
    let candidateCalls = 0;

    return async (provider, prompt, options = {}) => {
      const stage = options.stage;

      // --- Pre-call guards. Each one must stop the request, not annotate it afterwards.

      if (!stage || !ALLOWED_STAGES.includes(stage)) throw halt(new ScopeViolation(stage ?? '(none)'));
      if (options.retrieval != null) throw halt(new RetrievalPolicyViolation(stage));
      if (options.temperature !== undefined) throw halt(new TemperaturePolicyViolation(stage, options.temperature));
      if (reserved >= globalBudget) throw halt(new CallBudgetExceeded('global', globalBudget));
      if (candidateCalls >= PER_CANDIDATE_CALL_BUDGET) throw halt(new CallBudgetExceeded(`candidate ${fixtureId}`, PER_CANDIDATE_CALL_BUDGET));

      const pin = pins[stage];
      if (!pin) throw new Error(`no pin for stage "${stage}"; the capture manifest is incomplete`);

      // Attribution has to happen before the call too: a worker call that cannot be tied
      // to exactly one specialist would produce an artifact nobody can verify, and there
      // is no point paying for it first.
      // Attribution is checked before the slot is claimed, so a call that will be refused
      // does not consume budget.
      let agentId = null;
      if (stage === 'round1_worker') {
        const matched = workers.filter((w) => w.role === options.system);
        if (matched.length !== 1) throw halt(new WorkerBindingError(matched.length));
        agentId = matched[0].id;
      }

      candidateCalls += 1;
      reserved += 1;
      const startedAt = now().toISOString();
      const startMs = Date.now();
      const base = {
        seq: (seq += 1),
        fixtureId,
        stage,
        agentId,
        providerRequested: provider,
        modelRequested: options.model ?? null,
        systemPrompt: options.system ?? null,
        systemPromptSha256: options.system ? sha256(options.system) : null,
        prompt,
        promptSha256: sha256(prompt),
        temperatureRequested: options.temperature ?? null,
        retrievalRequested: options.retrieval != null,
        startedAt,
      };

      let result;
      try {
        result = await call(provider, prompt, options);
      } catch (err) {
        journal({
          ...base,
          ms: Date.now() - startMs,
          providerResolved: null,
          modelResolved: null,
          responseText: null,
          responseChars: null,
          responseSha256: null,
          retrievalResult: null,
          success: false,
          pinMismatch: false,
          error: String(err),
        });
        throw err;
      }

      const requestedLabel = `${pin.provider}/${pin.model}`;
      const resolvedLabel = `${result.provider}/${result.model}`;
      const pinMismatch = result.provider !== pin.provider || result.model !== pin.model;

      journal({
        ...base,
        ms: Date.now() - startMs,
        providerResolved: result.provider,
        modelResolved: result.model,
        responseText: result.text,
        responseChars: result.text.length,
        responseSha256: sha256(result.text),
        retrievalResult: result.retrieval ?? null,
        // A pin mismatch is not a successful call, however well-formed the text is.
        success: !pinMismatch,
        pinMismatch,
        error: pinMismatch ? `MODEL_PIN_MISMATCH: requested ${requestedLabel}, resolved ${resolvedLabel}` : null,
      });

      if (pinMismatch) throw new ModelPinMismatch(stage, requestedLabel, resolvedLabel);
      return result;
    };
  };

  return {
    dispatcherFor,
    get calls() { return calls; },
    get liveCallCount() { return calls.length; },
    /** The first round-ending violation, if any. Set even when production swallowed the throw. */
    get violation() { return violation; },
    /** Budget slots claimed. Equals liveCallCount once every dispatched call has settled. */
    get reservedCallCount() { return reserved; },
    callsFor: (fixtureId) => calls.filter((c) => c.fixtureId === fixtureId),
  };
}
