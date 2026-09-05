/**
 * Recording dispatcher for the M2-B harness.
 *
 * One live Gate response is expensive and, per protocol §5.1, its sampling variance is
 * large enough to flip a headline decision. So B-prime, C and D-1 must all be built on the
 * *same* gate response rather than three independent samples of it. This dispatcher is how
 * that happens without forking the production replay path: `replaySynthesis` already
 * accepts an injected `call`, and every orchestrator call already declares its own
 * `stage`, so a dispatcher can answer `synthesis_gate` from a recording and forward
 * everything else.
 *
 * It also carries the two assertions that a run cannot be trusted without: the resolved
 * model must equal the pinned one, and retrieval must be absent everywhere.
 */
import { createHash } from 'node:crypto';

export class ModelPinViolation extends Error {
  constructor(stage, requested, resolved) {
    super(
      `model pin violated at stage "${stage}": manifest requested "${requested}", ` +
        `provider resolved "${resolved}". This run is INVALID.`
    );
    this.name = 'ModelPinViolation';
    this.stage = stage;
    this.requestedModel = requested;
    this.resolvedModel = resolved;
  }
}

export class RetrievalPolicyViolation extends Error {
  constructor(stage) {
    super(`retrievalPolicy is all-off but stage "${stage}" carried retrieval. This run is INVALID.`);
    this.name = 'RetrievalPolicyViolation';
    this.stage = stage;
  }
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/**
 * @param {object} input
 * @param {(provider: string, prompt: string, options: object) => Promise<{provider,model,text,retrieval?}>} input.call
 *   The underlying dispatcher. Offline tests pass a deterministic stub; a live run would
 *   pass the real `callProvider`. The harness itself never chooses one.
 * @param {Record<string,{provider:string,requestedModel:string}>} input.pins
 *   Stage -> pin. A stage with no pin is a manifest error, not a default.
 * @param {number|'unsupported'} input.temperature
 *   Plumbed through to the underlying call when numeric. `'unsupported'` records the fact
 *   and sends nothing — the protocol forbids working around it in provider runtime.
 * @param {{stage:string, provider:string, model:string, text:string}|null} [input.replay]
 *   A previously recorded response. Only `synthesis_gate` is replayable in Phase 1.
 */
export function createDispatcher({ call, pins, temperature, replay = null }) {
  const calls = [];
  let recordedGate = replay;

  const dispatcher = async (provider, prompt, options) => {
    const stage = options.stage;
    if (!stage) throw new Error('dispatcher received a call with no stage; cannot pin or account for it');

    const pin = pins[stage];
    if (!pin) throw new Error(`no model pin for stage "${stage}"; manifest is incomplete`);
    if (pin.provider !== provider) {
      throw new ModelPinViolation(stage, `${pin.provider}/${pin.requestedModel}`, `${provider}/?`);
    }

    // A replayed gate is not a provider call. It is recorded as such so call accounting
    // reflects what was actually spent, not what the code path looks like.
    if (stage === 'synthesis_gate' && recordedGate) {
      calls.push({
        seq: calls.length + 1,
        stage,
        provider,
        requestedModel: pin.requestedModel,
        resolvedModel: recordedGate.model,
        promptSha256: sha256(prompt),
        promptChars: prompt.length,
        responseChars: recordedGate.text.length,
        retrievalRequested: null,
        retrievalResult: null,
        replayed: true,
        ms: 0,
      });
      return { provider, model: recordedGate.model, text: recordedGate.text };
    }

    const startedAt = Date.now();
    const result = await call(provider, prompt, {
      ...options,
      model: pin.requestedModel,
      ...(typeof temperature === 'number' ? { temperature } : {}),
    });
    const ms = Date.now() - startedAt;

    if (result.model !== pin.requestedModel) {
      throw new ModelPinViolation(stage, pin.requestedModel, result.model);
    }
    if (options.retrieval || result.retrieval) throw new RetrievalPolicyViolation(stage);

    calls.push({
      seq: calls.length + 1,
      stage,
      provider,
      requestedModel: pin.requestedModel,
      resolvedModel: result.model,
      promptSha256: sha256(prompt),
      promptChars: prompt.length,
      responseChars: result.text.length,
      retrievalRequested: options.retrieval ?? null,
      retrievalResult: result.retrieval ?? null,
      replayed: false,
      ms,
    });

    if (stage === 'synthesis_gate' && !recordedGate) {
      recordedGate = { stage, provider, model: result.model, text: result.text };
    }
    return result;
  };

  return {
    dispatcher,
    calls,
    /** The gate response this dispatcher recorded or replayed, for handing to the next arm. */
    get gateRecording() {
      return recordedGate;
    },
    /** Calls that actually cost a provider request. A replayed gate is not one. */
    billableCalls: () => calls.filter((c) => !c.replayed),
  };
}
