import 'dotenv/config';

export type ProviderName = 'claude' | 'openai' | 'gemini';

/**
 * All three providers think/reason before answering, and those hidden tokens are
 * charged against the same output budget as the visible answer. A budget that only
 * fits the answer gets consumed by thinking, leaving truncated or empty text.
 */
export const DEFAULT_MAX_TOKENS = 16384;

export interface ProviderConfig {
  name: ProviderName;
  apiKey?: string;
  defaultModel: string;
}

export const PROVIDERS: Record<ProviderName, ProviderConfig> = {
  claude: {
    name: 'claude',
    apiKey: process.env.ANTHROPIC_API_KEY,
    defaultModel: process.env.CLAUDE_MODEL || 'claude-sonnet-5',
  },
  openai: {
    name: 'openai',
    apiKey: process.env.OPENAI_API_KEY,
    defaultModel: process.env.OPENAI_MODEL || 'gpt-5',
  },
  gemini: {
    name: 'gemini',
    apiKey: process.env.GEMINI_API_KEY,
    defaultModel: process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview',
  },
};

export function isProviderConfigured(name: ProviderName): boolean {
  return Boolean(PROVIDERS[name].apiKey);
}

export function availableProviders(): ProviderName[] {
  return (Object.keys(PROVIDERS) as ProviderName[]).filter(isProviderConfigured);
}

export function assertProviderConfigured(name: ProviderName): void {
  if (!isProviderConfigured(name)) {
    throw new Error(
      `Provider "${name}" is not configured. Set the corresponding API key env var before using it.`
    );
  }
}
