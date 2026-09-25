import type { ProviderName } from '../config.js';

export type ModelCapability =
  | 'reasoning'
  | 'system_prompt'
  | 'grounded_retrieval'
  | 'native_structured_output'
  | 'streaming';

export type ProviderSupportState = 'SUPPORTED' | 'UNSUPPORTED' | 'UNKNOWN';
export type RuntimeEnablementState = 'ENABLED' | 'DISABLED' | 'UNKNOWN';
export type CapabilityReadiness = 'VERIFIED' | 'WIRED_UNVERIFIED' | 'UNSUPPORTED' | 'UNKNOWN';
export type ParameterName = 'temperature' | 'max_output_tokens';
export type ExplicitTransmission = 'ALLOWED' | 'DISALLOWED' | 'UNKNOWN';

export type EvidenceScope =
  | { kind: 'capability'; capability: ModelCapability }
  | { kind: 'parameter'; parameter: ParameterName };

export interface CapabilityEvidence {
  kind: 'repository_fact' | 'runtime_observation' | 'vendor_documentation';
  source: string;
  provider: ProviderName;
  model: string;
  scope: EvidenceScope;
  reviewedAt: string;
  note: string;
  limitations: string[];
}

export interface CapabilityAssessment {
  providerSupport: ProviderSupportState;
  runtimeEnablement: RuntimeEnablementState;
  readiness: CapabilityReadiness;
  evidence: CapabilityEvidence[];
  notes?: string;
  /** Compatibility projection for existing CLI/report consumers. */
  supportedByProvider?: boolean;
  /** Compatibility projection for existing CLI/report consumers. */
  enabledInRuntime?: boolean;
}

type ParameterConstraintBase = { explicitTransmission: ExplicitTransmission };

export type ParameterConstraint =
  | ({ kind: 'UNSUPPORTED' | 'UNKNOWN' } & ParameterConstraintBase)
  | ({ kind: 'FIXED'; value: number } & ParameterConstraintBase)
  | ({
      kind: 'NUMERIC_RANGE';
      min: number;
      max: number;
      minInclusive: boolean;
      maxInclusive: boolean;
    } & ParameterConstraintBase)
  | ({ kind: 'DISCRETE_VALUES'; values: number[] } & ParameterConstraintBase);

export interface ParameterAssessment {
  readiness: CapabilityReadiness;
  constraint: ParameterConstraint;
  evidence: CapabilityEvidence[];
  notes?: string;
}

export interface ModelPricing {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
  source: string;
  checkedOn: string;
}

export interface ModelProfile {
  provider: ProviderName;
  model: string;
  capabilities: Partial<Record<ModelCapability, CapabilityAssessment>>;
  parameters: Partial<Record<ParameterName, ParameterAssessment>>;
  pricing?: ModelPricing;
  notes?: string;
}

const reviewedAt = '2026-09-26';
const repoLimitations = [
  'Recorded from repository source/history only; not freshly verified against the vendor in E0-R1.',
];

function evidence(
  provider: ProviderName,
  model: string,
  scope: EvidenceScope,
  source: string,
  note: string,
  limitations: string[] = repoLimitations
): CapabilityEvidence {
  return {
    kind: 'repository_fact',
    source,
    provider,
    model,
    scope,
    reviewedAt,
    note,
    limitations: [...limitations],
  };
}

function enabledCapability(
  provider: ProviderName,
  model: string,
  capability: ModelCapability,
  source: string,
  note = 'The existing repository profile records this capability and the current adapter has a corresponding runtime path.'
): CapabilityAssessment {
  return {
    providerSupport: 'SUPPORTED',
    runtimeEnablement: 'ENABLED',
    readiness: 'WIRED_UNVERIFIED',
    evidence: [evidence(provider, model, { kind: 'capability', capability }, source, note)],
    supportedByProvider: true,
    enabledInRuntime: true,
  };
}

function offeredNotWired(
  provider: ProviderName,
  model: string,
  capability: ModelCapability,
  source: string,
  note: string
): CapabilityAssessment {
  return {
    providerSupport: 'SUPPORTED',
    runtimeEnablement: 'DISABLED',
    readiness: 'UNSUPPORTED',
    evidence: [evidence(provider, model, { kind: 'capability', capability }, source, note)],
    notes: 'Repository profile records vendor support, but no runtime path is enabled.',
    supportedByProvider: true,
    enabledInRuntime: false,
  };
}

function unknownParameter(
  provider: ProviderName,
  model: string,
  parameter: ParameterName,
  source: string,
  note: string,
  extraEvidence: CapabilityEvidence[] = []
): ParameterAssessment {
  return {
    readiness: 'WIRED_UNVERIFIED',
    constraint: { kind: 'UNKNOWN', explicitTransmission: 'UNKNOWN' },
    evidence: [evidence(provider, model, { kind: 'parameter', parameter }, source, note), ...extraEvidence],
    notes: 'The adapter path exists; supported values and permission to transmit remain unknown.',
  };
}

function claudeTemperatureEvidence(): CapabilityEvidence[] {
  return [
    evidence(
      'claude',
      'claude-sonnet-5',
      { kind: 'parameter', parameter: 'temperature' },
      'src/providers/claude.ts',
      'The current adapter forwards CallOptions.temperature.'
    ),
    {
      ...evidence(
        'claude',
        'claude-sonnet-5',
        { kind: 'parameter', parameter: 'temperature' },
        '44d5fe9465fc9551174d69278415058b605cc8b6',
        'Repository commit records an HTTP 400 rejection when claude-sonnet-5 received temperature.',
        ['Historical repository record; not independently reproduced in E0-R1.']
      ),
    },
    {
      ...evidence(
        'claude',
        'claude-sonnet-5',
        { kind: 'parameter', parameter: 'temperature' },
        'cf074c2c640559eb40a578f921b82438b2e7fd96',
        'Repository commit records deliberate restoration of temperature passthrough pending capability redesign.',
        ['Historical repository record; does not establish vendor acceptance.']
      ),
    },
  ];
}

function parameterAssessment(
  provider: ProviderName,
  model: string,
  parameter: ParameterName,
  source: string
): ParameterAssessment {
  if (provider === 'claude' && parameter === 'temperature') {
    return {
      readiness: 'WIRED_UNVERIFIED',
      constraint: { kind: 'UNKNOWN', explicitTransmission: 'UNKNOWN' },
      evidence: claudeTemperatureEvidence(),
      notes: 'H1: passthrough is wired, but transmission authority and accepted values are unresolved.',
    };
  }

  return unknownParameter(
    provider,
    model,
    parameter,
    source,
    `The current adapter forwards ${parameter}; vendor support and accepted values are not established here.`
  );
}

export const MODEL_REGISTRY: ModelProfile[] = [
  {
    provider: 'claude',
    model: 'claude-sonnet-5',
    capabilities: {
      reasoning: {
        ...enabledCapability('claude', 'claude-sonnet-5', 'reasoning', 'src/models/capabilities.ts'),
        notes: 'Repository profile records one planning call with 3147 of 4096 output tokens as thinking.',
      },
      system_prompt: enabledCapability('claude', 'claude-sonnet-5', 'system_prompt', 'src/providers/claude.ts'),
      grounded_retrieval: offeredNotWired(
        'claude',
        'claude-sonnet-5',
        'grounded_retrieval',
        'src/models/capabilities.ts',
        'Previous repository profile records Anthropic web search as offered; src/providers/claude.ts does not invoke it.'
      ),
    },
    parameters: {
      temperature: parameterAssessment('claude', 'claude-sonnet-5', 'temperature', 'src/providers/claude.ts'),
      max_output_tokens: parameterAssessment('claude', 'claude-sonnet-5', 'max_output_tokens', 'src/providers/claude.ts'),
    },
  },
  {
    provider: 'openai',
    model: 'gpt-5',
    capabilities: {
      reasoning: {
        ...enabledCapability('openai', 'gpt-5', 'reasoning', 'src/models/capabilities.ts'),
        notes: 'Repository profile records one call with 3904 of 7893 completion tokens as reasoning.',
      },
      system_prompt: enabledCapability('openai', 'gpt-5', 'system_prompt', 'src/providers/openai.ts'),
      grounded_retrieval: offeredNotWired(
        'openai',
        'gpt-5',
        'grounded_retrieval',
        'src/models/capabilities.ts',
        'Previous repository profile records OpenAI web search as offered; src/providers/openai.ts does not invoke it.'
      ),
    },
    parameters: {
      temperature: parameterAssessment('openai', 'gpt-5', 'temperature', 'src/providers/openai.ts'),
      max_output_tokens: parameterAssessment('openai', 'gpt-5', 'max_output_tokens', 'src/providers/openai.ts'),
    },
  },
  {
    provider: 'gemini',
    model: 'gemini-3.1-pro-preview',
    capabilities: {
      reasoning: enabledCapability('gemini', 'gemini-3.1-pro-preview', 'reasoning', 'src/models/capabilities.ts'),
      system_prompt: enabledCapability('gemini', 'gemini-3.1-pro-preview', 'system_prompt', 'src/providers/gemini.ts'),
      grounded_retrieval: {
        ...enabledCapability(
          'gemini',
          'gemini-3.1-pro-preview',
          'grounded_retrieval',
          'src/providers/gemini.ts',
          'Google Search is attached per call when retrieval is requested; grounding metadata is read from the response.'
        ),
      },
    },
    parameters: {
      temperature: parameterAssessment('gemini', 'gemini-3.1-pro-preview', 'temperature', 'src/providers/gemini.ts'),
      max_output_tokens: parameterAssessment('gemini', 'gemini-3.1-pro-preview', 'max_output_tokens', 'src/providers/gemini.ts'),
    },
  },
];

export function findProfile(provider: ProviderName, model?: string): ModelProfile | undefined {
  return MODEL_REGISTRY.find(
    (profile) => profile.provider === provider && (model === undefined || profile.model === model)
  );
}

export type ModelProfileLookup =
  | { status: 'FOUND'; profile: ModelProfile }
  | { status: 'UNKNOWN_MODEL'; provider: ProviderName; model: string };

export type AssessmentLookup<T> =
  | { status: 'FOUND'; assessment: T }
  | { status: 'UNKNOWN_MODEL'; provider: ProviderName; model: string }
  | { status: 'MISSING_ASSESSMENT'; provider: ProviderName; model: string };

export function getModelProfile(provider: ProviderName, model: string): ModelProfileLookup {
  const profile = findProfile(provider, model);
  return profile
    ? { status: 'FOUND', profile: structuredClone(profile) }
    : { status: 'UNKNOWN_MODEL', provider, model };
}

export function getCapabilityAssessment(
  provider: ProviderName,
  model: string,
  capability: ModelCapability
): AssessmentLookup<CapabilityAssessment> {
  const profile = findProfile(provider, model);
  if (!profile) return { status: 'UNKNOWN_MODEL', provider, model };
  const assessment = profile.capabilities[capability];
  return assessment
    ? { status: 'FOUND', assessment: structuredClone(assessment) }
    : { status: 'MISSING_ASSESSMENT', provider, model };
}

export function getParameterAssessment(
  provider: ProviderName,
  model: string,
  parameter: ParameterName
): AssessmentLookup<ParameterAssessment> {
  const profile = findProfile(provider, model);
  if (!profile) return { status: 'UNKNOWN_MODEL', provider, model };
  const assessment = profile.parameters[parameter];
  return assessment
    ? { status: 'FOUND', assessment: structuredClone(assessment) }
    : { status: 'MISSING_ASSESSMENT', provider, model };
}

export function providerSupports(
  provider: ProviderName,
  capability: ModelCapability,
  model?: string
): boolean {
  return findProfile(provider, model)?.capabilities[capability]?.runtimeEnablement === 'ENABLED';
}

export function providerCouldSupport(
  provider: ProviderName,
  capability: ModelCapability,
  model?: string
): boolean {
  return findProfile(provider, model)?.capabilities[capability]?.providerSupport === 'SUPPORTED';
}

export function modelsWithCapability(capability: ModelCapability): ModelProfile[] {
  return MODEL_REGISTRY.filter(
    (profile) => profile.capabilities[capability]?.runtimeEnablement === 'ENABLED'
  );
}

export function unwiredCapabilities(): Array<{ profile: ModelProfile; capability: ModelCapability }> {
  const gaps: Array<{ profile: ModelProfile; capability: ModelCapability }> = [];
  for (const profile of MODEL_REGISTRY) {
    for (const [capability, assessment] of Object.entries(profile.capabilities)) {
      if (
        assessment.providerSupport === 'SUPPORTED' &&
        assessment.runtimeEnablement === 'DISABLED'
      ) {
        gaps.push({ profile, capability: capability as ModelCapability });
      }
    }
  }
  return gaps;
}

export function modelsMissingPricing(): ModelProfile[] {
  return MODEL_REGISTRY.filter((profile) => !profile.pricing);
}
