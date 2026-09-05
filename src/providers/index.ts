import type { ProviderName } from '../config.js';
import type { CallOptions, CallResult, CallStage } from './types.js';
import { callClaude } from './claude.js';
import { callOpenAI } from './openai.js';
import { callGemini } from './gemini.js';

export type { CallOptions, CallResult, CallStage };

export async function callProvider(
  provider: ProviderName,
  prompt: string,
  options: CallOptions = {}
): Promise<CallResult> {
  switch (provider) {
    case 'claude':
      return callClaude(prompt, options);
    case 'openai':
      return callOpenAI(prompt, options);
    case 'gemini':
      return callGemini(prompt, options);
    default:
      throw new Error(`Unknown provider: ${provider satisfies never}`);
  }
}
