import { GoogleGenerativeAI } from '@google/generative-ai';
import { PROVIDERS, assertProviderConfigured, DEFAULT_MAX_TOKENS } from '../config.js';
import type { CallOptions, CallResult, RetrievalResult } from './types.js';

let client: GoogleGenerativeAI | null = null;

function getClient(): GoogleGenerativeAI {
  if (!client) {
    client = new GoogleGenerativeAI(PROVIDERS.gemini.apiKey!);
  }
  return client;
}

/**
 * Shape of the grounding metadata this code reads. Declared here rather than imported
 * because the installed SDK's types predate the `googleSearch` tool; the fields below are
 * the ones the API actually returns, and any mismatch is handled defensively.
 */
interface GeminiGroundingMetadata {
  webSearchQueries?: string[];
  groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
}

/** Turns provider metadata into a retrieval result, claiming only what the metadata shows. */
function readGroundingMetadata(metadata: GeminiGroundingMetadata | undefined): RetrievalResult {
  if (!metadata) {
    return {
      status: 'UNGROUNDED',
      queries: [],
      sources: [],
      sourcesFound: 0,
      note: 'Search was offered but the model answered without it; no grounding metadata was returned.',
    };
  }

  const queries = metadata.webSearchQueries ?? [];
  const sources = (metadata.groundingChunks ?? [])
    .map((chunk) => chunk.web)
    .filter((web): web is { uri: string; title?: string } => typeof web?.uri === 'string')
    .map((web) => ({ url: web.uri, title: web.title }));

  // Metadata with no sources is not grounding, whatever else it contains.
  const status = sources.length > 0 ? 'GROUNDED' : 'UNGROUNDED';

  return {
    status,
    queries,
    // Only reported because the API states the queries; never inferred.
    queryCount: metadata.webSearchQueries ? queries.length : undefined,
    sources,
    sourcesFound: sources.length,
    note:
      status === 'UNGROUNDED'
        ? 'Grounding metadata was returned but contained no usable sources.'
        : undefined,
    raw: metadata,
  };
}

export async function callGemini(prompt: string, options: CallOptions = {}): Promise<CallResult> {
  assertProviderConfigured('gemini');
  const model = options.model || PROVIDERS.gemini.defaultModel;
  const wantsRetrieval = options.retrieval?.enabled === true;

  const genModel = getClient().getGenerativeModel({
    model,
    systemInstruction: options.system,
    // Search is attached per call, never by default: an ordinary reasoning mission must
    // not silently start costing search queries.
    // The installed SDK types only know the older googleSearchRetrieval tool, so the
    // current tool is passed through with a cast and verified against the live API.
    ...(wantsRetrieval ? { tools: [{ googleSearch: {} } as never] } : {}),
  });

  const result = await genModel.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: options.temperature,
      maxOutputTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    },
  });

  const text = result.response.text();
  if (!text.trim()) {
    const finishReason = result.response.candidates?.[0]?.finishReason;
    throw new Error(
      `Gemini (${model}) returned no text. finishReason=${finishReason}. ` +
        `Raise maxTokens so thinking and the answer both fit.`
    );
  }

  if (!wantsRetrieval) return { provider: 'gemini', model, text };

  const metadata = result.response.candidates?.[0]?.groundingMetadata as
    | GeminiGroundingMetadata
    | undefined;
  return { provider: 'gemini', model, text, retrieval: readGroundingMetadata(metadata) };
}
