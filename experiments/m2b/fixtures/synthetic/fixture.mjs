/**
 * Deterministic synthetic fixture for the offline harness tests.
 *
 * NOT an experiment fixture. The four Phase 1 fixtures are frozen only after the harness
 * review (GPT authorization section C), and choosing them now would be choosing them
 * before the tool that runs them has been reviewed.
 *
 * Everything here is invented so the tests have a stable oracle. Live model output is
 * never used as a test oracle: it would make the suite non-deterministic and would smuggle
 * a model's judgment into a check that is supposed to be structural.
 */
export const SNAPSHOT = Object.freeze({
  task: 'Decide whether to open a second production studio next year.',
  complexity: 'deep',
  agentOrder: ['strategist', 'brand'],
  workers: [
    { id: 'strategist', provider: 'openai', model: 'stub-strategist-1', role: 'Business strategy', evidenceCapable: false },
    { id: 'brand', provider: 'openai', model: 'stub-brand-1', role: 'Brand and creative', evidenceCapable: false },
  ],
  workerResults: [
    {
      agentId: 'strategist',
      mission: 'Assess capacity, payback and downside risk.',
      output: [
        '## Recommendation: do not open the second studio yet',
        'The scarcest resource is not demand but delivery capacity.',
        'A second site competes for the same senior editors that carry the high-margin work.',
        'Under the current headcount there is no way to staff both without borrowing from the core team.',
      ].join('\n\n'),
    },
    {
      agentId: 'brand',
      mission: 'Assess positioning, price anchoring and brand dilution.',
      output: [
        '## Recommendation: open it under a separate brand',
        'A separate brand isolates the price anchor of the flagship work.',
        'Capacity can be bounded by capping the client count and refusing rush work.',
      ].join('\n\n'),
    },
  ],
});

export const PEER_CHUNK_TEXT =
  'A second site competes for the same senior editors that carry the high-margin work.';
export const CHALLENGE_TEXT =
  'How does a separate brand avoid consuming the same senior editing capacity the flagship work depends on?';
export const SOURCE_REF = 'strategist:p3';

const ISSUE = {
  targetAgentId: 'brand',
  sourceRef: SOURCE_REF,
  challenge: CHALLENGE_TEXT,
  decisionSensitive: true,
  action: 'peer_challenge',
};

export const PROVISIONAL = 'PROVISIONAL: open the second studio under a separate brand, with a capacity cap.';
export const GATE_TEXT = PROVISIONAL + '\n\n```json\n' + JSON.stringify({ collaborationIssues: [ISSUE] }) + '\n```';
export const PLAIN_SYNTHESIS = 'PLAIN-SYNTHESIS: open the second studio under a separate brand.';
export const ROUND2_TEXT = 'REVISED: only if the separate brand can run on outsourced capacity with a hard no-cross rule.';
export const SELF_REVIEW_TEXT = 'SELF-REVIEWED: my strongest objection is that the capacity cap is unenforceable in practice.';
export const DECISION_TEXT = 'DECISION: defer, and validate the outsourced-capacity assumption within 90 days.';

export const PINS = Object.freeze({
  synthesis: { provider: 'openai', requestedModel: 'stub-synth-1' },
  synthesis_gate: { provider: 'openai', requestedModel: 'stub-synth-1' },
  round2_worker: { provider: 'openai', requestedModel: 'stub-brand-1' },
  self_review: { provider: 'openai', requestedModel: 'stub-brand-1' },
  decision_synthesis: { provider: 'openai', requestedModel: 'stub-synth-1' },
});

/**
 * Deterministic stub dispatcher. Answers by stage and echoes back the model it was asked
 * for, which is what makes the pin assertion meaningful in the passing case — and what the
 * mismatch test overrides.
 */
export function makeStub(overrides = {}) {
  const seen = [];
  const call = async (provider, prompt, options) => {
    seen.push({ stage: options.stage, provider, prompt, options });
    if (overrides.throwAt === options.stage) throw new Error(`stub failure at ${options.stage}`);
    const model = overrides.resolvedModel?.[options.stage] ?? options.model;
    const text =
      options.stage === 'synthesis' ? PLAIN_SYNTHESIS
      : options.stage === 'synthesis_gate' ? (overrides.gateText ?? GATE_TEXT)
      : options.stage === 'round2_worker' ? ROUND2_TEXT
      : options.stage === 'self_review' ? SELF_REVIEW_TEXT
      : options.stage === 'decision_synthesis' ? DECISION_TEXT
      : `stub-${options.stage}`;
    const result = { provider, model, text };
    if (overrides.retrievalAt === options.stage) result.retrieval = { status: 'GROUNDED', queries: [], sources: [], sourcesFound: 0 };
    return result;
  };
  return { call, seen };
}
