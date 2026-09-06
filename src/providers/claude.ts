import Anthropic from '@anthropic-ai/sdk';
import { PROVIDERS, assertProviderConfigured, DEFAULT_MAX_TOKENS } from '../config.js';
import type { CallOptions, CallResult } from './types.js';
import { retrievalUnsupported } from './types.js';

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: PROVIDERS.claude.apiKey });
  }
  return client;
}

export async function callClaude(prompt: string, options: CallOptions = {}): Promise<CallResult> {
  assertProviderConfigured('claude');
  const model = options.model || PROVIDERS.claude.defaultModel;
  // Request-scoped, so ordinary callers keep the client default of two retries.
  const requestOptions = options.transportMaxRetries === 0 ? { maxRetries: 0 } : undefined;

  const response = await getClient().messages.create(
    {
      model,
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: options.temperature,
      system: options.system,
      messages: [{ role: 'user', content: prompt }],
    },
    requestOptions
  );
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  if (!text.trim()) {
    throw new Error(
      `Claude (${model}) returned no text. stop_reason=${response.stop_reason}, ` +
        `thinking_tokens=${response.usage.output_tokens_details?.thinking_tokens}. ` +
        `Raise maxTokens so thinking and the answer both fit.`
    );
  }
  // Anthropic's web search tool is not wired up here. Asking for retrieval must report
  // that it did not happen, rather than returning a training-data answer unmarked.
  if (options.retrieval?.enabled) {
    return { provider: 'claude', model, text, retrieval: retrievalUnsupported('claude') };
  }
  return { provider: 'claude', model, text };
}
