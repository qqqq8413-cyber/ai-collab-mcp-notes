/** Asks a provider to answer using external retrieval rather than training data alone. */
export interface RetrievalRequest {
  enabled: boolean;
}

/**
 * What retrieval actually did on one call.
 *
 * - GROUNDED:   retrieval ran and returned at least one source.
 * - UNGROUNDED: retrieval was available and offered, but the model answered without
 *               searching. The answer is training-data reasoning like any other.
 * - FAILED:     retrieval was asked for and could not happen — the provider has no
 *               runtime support, or the call returned unusable grounding metadata.
 *
 * Absent entirely when retrieval was never requested. "Requested" and "happened" are
 * deliberately different facts.
 */
export type RetrievalStatus = 'GROUNDED' | 'UNGROUNDED' | 'FAILED';

export interface RetrievalSource {
  title?: string;
  url: string;
}

export interface RetrievalResult {
  status: RetrievalStatus;
  /** Search queries the API reports having issued. Empty when it reports none. */
  queries: string[];
  /**
   * Number of queries, only when the API states it. Left undefined rather than
   * estimated — a guessed count would become a fabricated cost input.
   */
  queryCount?: number;
  sources: RetrievalSource[];
  sourcesFound: number;
  /** Why the status is not GROUNDED. */
  note?: string;
  /** Provider metadata as received, kept so a claim can be traced back to its source. */
  raw?: unknown;
}

export interface CallOptions {
  model?: string;
  system?: string;
  temperature?: number;
  maxTokens?: number;
  retrieval?: RetrievalRequest;
}

export interface CallResult {
  provider: string;
  model: string;
  text: string;
  retrieval?: RetrievalResult;
}

/** Result for a provider that was asked to retrieve but has no runtime support for it. */
export function retrievalUnsupported(provider: string): RetrievalResult {
  return {
    status: 'FAILED',
    queries: [],
    sources: [],
    sourcesFound: 0,
    note: `${provider} has no grounded retrieval enabled in this codebase; the answer comes from training data.`,
  };
}
