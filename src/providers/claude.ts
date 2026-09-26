import Anthropic from '@anthropic-ai/sdk';
import { PROVIDERS, assertProviderConfigured, DEFAULT_MAX_TOKENS } from '../config.js';
import type { CallOptions, CallResult, CompletionVocabulary } from './types.js';
import { classifyCompletion, retrievalUnsupported } from './types.js';

/**
 * `max_tokens` and `model_context_window_exceeded` both stop generation at a token limit,
 * as the installed SDK documents them. This adapter sets no stop sequences, tools or
 * streaming, so every other reason is left unclassified.
 */
const CLAUDE_COMPLETION: CompletionVocabulary = {
  complete: ['end_turn'],
  truncated: ['max_tokens', 'model_context_window_exceeded'],
};

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
  const response = await getClient().messages.create({
    model,
    max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: options.temperature,
    system: options.system,
    messages: [{ role: 'user', content: prompt }],
  });
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
  // Non-empty text is not a finished answer: `max_tokens` means it was cut off.
  const completion = classifyCompletion(response.stop_reason, CLAUDE_COMPLETION);
  const result: CallResult = { provider: 'claude', model, text, ...(completion ? { completion } : {}) };
  // Anthropic's web search tool is not wired up here. Asking for retrieval must report
  // that it did not happen, rather than returning a training-data answer unmarked.
  if (options.retrieval?.enabled) {
    return { ...result, retrieval: retrievalUnsupported('claude') };
  }
  return result;
}
