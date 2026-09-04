import type { ProviderName } from '../config.js';

/**
 * What a model can do **as wired up in this codebase** — not what it is capable of in
 * principle, and not what its vendor advertises.
 *
 * The distinction is the whole point of this file. `market_researcher` was configured as
 * an evidence-gathering specialist and a run that recruited it was labelled
 * EVIDENCE_BACKED, while `src/providers/gemini.ts` was calling `generateContent` with no
 * tools at all. The label was reporting an intention as an accomplishment.
 *
 * Hence every capability carries two separate facts. Only `enabledInRuntime` may grant a
 * capability; `supportedByProvider` exists so the gap between "the vendor offers this"
 * and "we have wired it up" stays visible instead of being quietly conflated.
 */
export type ModelCapability =
  /** Spends hidden thinking tokens before answering. Measured, not assumed. */
  | 'reasoning'
  /** Accepts a system prompt, so a specialist's role can be set separately from its mission. */
  | 'system_prompt'
  /** Can fetch external information at call time: web search, search grounding, retrieval tools. */
  | 'grounded_retrieval'
  /** Provider-enforced JSON schema, as opposed to parsing JSON out of prose. */
  | 'native_structured_output'
  | 'streaming';

export interface CapabilityState {
  /** The vendor offers this for this model. */
  supportedByProvider: boolean;
  /** This codebase actually calls it, and can read back what happened. */
  enabledInRuntime: boolean;
  notes?: string;
}

export interface ModelPricing {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
  /** Where the figure came from, so it can be rechecked. */
  source: string;
  /** ISO date the figure was last verified against that source. */
  checkedOn: string;
}

export interface ModelProfile {
  provider: ProviderName;
  model: string;
  capabilities: Partial<Record<ModelCapability, CapabilityState>>;
  /**
   * Left unset until someone copies the real numbers from the provider's pricing page.
   *
   * Deliberately not guessed. A plausible-looking invented price would flow straight into
   * cost reporting and become exactly the kind of unanchored quantitative claim this
   * system exists to catch. Grounded search is billed on top of tokens, so this matters
   * more now, not less.
   */
  pricing?: ModelPricing;
  notes?: string;
}

const on = (notes?: string): CapabilityState => ({
  supportedByProvider: true,
  enabledInRuntime: true,
  notes,
});
const offeredButNotWired = (notes: string): CapabilityState => ({
  supportedByProvider: true,
  enabledInRuntime: false,
  notes,
});

export const MODEL_REGISTRY: ModelProfile[] = [
  {
    provider: 'claude',
    model: 'claude-sonnet-5',
    capabilities: {
      reasoning: on('Thinking measured at 3147 of 4096 output tokens (77%) on one planning call.'),
      system_prompt: on(),
      grounded_retrieval: offeredButNotWired(
        'Anthropic offers a web search tool; src/providers/claude.ts does not use it.'
      ),
    },
  },
  {
    provider: 'openai',
    model: 'gpt-5',
    capabilities: {
      reasoning: on('Reasoning measured at 3904 of 7893 completion tokens (49%).'),
      system_prompt: on(),
      grounded_retrieval: offeredButNotWired(
        'OpenAI offers web search; src/providers/openai.ts does not use it.'
      ),
    },
  },
  {
    provider: 'gemini',
    model: 'gemini-3.1-pro-preview',
    capabilities: {
      reasoning: on(),
      system_prompt: on(),
      grounded_retrieval: on(
        'Google Search grounding, attached per call via CallOptions.retrieval and never by default.'
      ),
    },
  },
];

export function findProfile(provider: ProviderName, model?: string): ModelProfile | undefined {
  return MODEL_REGISTRY.find(
    (p) => p.provider === provider && (model === undefined || p.model === model)
  );
}

/**
 * Whether the given binding can do something **right now, in this codebase**.
 *
 * An unknown model answers `false` rather than being given the benefit of the doubt: the
 * Model Router will pick on capability, and an unlisted model is one nobody has checked.
 * Note that nothing here consults the provider's name — a brand never confers a
 * capability.
 */
export function providerSupports(
  provider: ProviderName,
  capability: ModelCapability,
  model?: string
): boolean {
  return findProfile(provider, model)?.capabilities[capability]?.enabledInRuntime ?? false;
}

/** Whether the vendor offers it, wired up here or not. Never grants a capability by itself. */
export function providerCouldSupport(
  provider: ProviderName,
  capability: ModelCapability,
  model?: string
): boolean {
  return findProfile(provider, model)?.capabilities[capability]?.supportedByProvider ?? false;
}

export function modelsWithCapability(capability: ModelCapability): ModelProfile[] {
  return MODEL_REGISTRY.filter((p) => p.capabilities[capability]?.enabledInRuntime);
}

/** Capabilities a vendor offers that this codebase has not wired up. */
export function unwiredCapabilities(): Array<{ profile: ModelProfile; capability: ModelCapability }> {
  const gaps: Array<{ profile: ModelProfile; capability: ModelCapability }> = [];
  for (const profile of MODEL_REGISTRY) {
    for (const [capability, state] of Object.entries(profile.capabilities)) {
      if (state.supportedByProvider && !state.enabledInRuntime) {
        gaps.push({ profile, capability: capability as ModelCapability });
      }
    }
  }
  return gaps;
}

/** Models with no verified pricing. Cost tracking must report these as unknown, not zero. */
export function modelsMissingPricing(): ModelProfile[] {
  return MODEL_REGISTRY.filter((p) => !p.pricing);
}
