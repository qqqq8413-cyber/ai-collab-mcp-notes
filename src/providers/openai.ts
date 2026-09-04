import OpenAI from 'openai';
import { PROVIDERS, assertProviderConfigured, DEFAULT_MAX_TOKENS } from '../config.js';
import type { CallOptions, CallResult } from './types.js';
import { retrievalUnsupported } from './types.js';

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({ apiKey: PROVIDERS.openai.apiKey });
  }
  return client;
}

export async function callOpenAI(prompt: string, options: CallOptions = {}): Promise<CallResult> {
  assertProviderConfigured('openai');
  const model = options.model || PROVIDERS.openai.defaultModel;
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (options.system) messages.push({ role: 'system', content: options.system });
  messages.push({ role: 'user', content: prompt });

  const response = await getClient().chat.completions.create({
    model,
    messages,
    temperature: options.temperature,
    max_completion_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
  });
  const text = response.choices[0]?.message?.content ?? '';
  if (!text.trim()) {
    throw new Error(
      `OpenAI (${model}) returned no text. finish_reason=${response.choices[0]?.finish_reason}, ` +
        `reasoning_tokens=${response.usage?.completion_tokens_details?.reasoning_tokens}. ` +
        `Raise maxTokens so reasoning and the answer both fit.`
    );
  }
  // OpenAI's web search tool is not wired up here. Asking for retrieval must report
  // that it did not happen, rather than returning a training-data answer unmarked.
  if (options.retrieval?.enabled) {
    return { provider: 'openai', model, text, retrieval: retrievalUnsupported('openai') };
  }
  return { provider: 'openai', model, text };
}
