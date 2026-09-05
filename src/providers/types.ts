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

/**
 * Which step of a run a call belongs to.
 *
 * Recorded explicitly because it cannot be inferred. Offline tests previously identified
 * synthesis by the *absence* of a system prompt, which stops working the moment a run has
 * more than one synthesis-class call: a second one would be counted as a worker and the
 * call-count assertions would silently measure the wrong thing.
 *
 * Diagnostic only. No provider adapter reads it, and none of them spread CallOptions into
 * a request body, so it cannot reach a vendor API.
 */
export type CallStage =
  | 'planning'
  | 'round1_worker'
  /** The single synthesis call of a run without experimental collaboration. */
  | 'synthesis'
  /** Synthesis that also asks for an optional collaboration issue block. */
  | 'synthesis_gate'
  | 'round2_worker'
  | 'decision_synthesis';

export interface CallOptions {
  model?: string;
  system?: string;
  temperature?: number;
  maxTokens?: number;
  retrieval?: RetrievalRequest;
  /** Diagnostic label for tests and reporting; never sent to a provider. */
  stage?: CallStage;
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
