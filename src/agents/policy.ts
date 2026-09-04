import type { Complexity, RunStatus } from '../modes/orchestrator.js';

export type Topology = 'single' | 'collaborative';

export interface ExecutionPolicy {
  /** Number of assigned specialists, independent of whether synthesis runs. */
  topology: Topology;
  synthesize: boolean;
  reason: string;
}

/** Only plan and execution facts cross this boundary. */
export interface ExecutionFacts {
  complexity: Complexity;
  assignmentIds: readonly string[];
  status: RunStatus;
  synthesisAllowed: boolean;
  retrievalRequired: boolean;
  workerResults: ReadonlyArray<{
    agentId: string;
    output?: unknown;
    error?: unknown;
    retrieval?: unknown;
  }>;
}

export function deriveExecutionPolicy(facts: ExecutionFacts): ExecutionPolicy {
  const topology: Topology = facts.assignmentIds.length === 1 ? 'single' : 'collaborative';
  const synthesize = (reason: string): ExecutionPolicy => ({ topology, synthesize: true, reason });

  // Preserve the existing all-failed guard before considering direct delivery.
  if (facts.synthesisAllowed === false) {
    return { topology, synthesize: false, reason: 'no_successful_workers' };
  }

  if (facts.complexity === 'normal' || facts.complexity === 'deep') {
    return synthesize('non_simple_execution');
  }
  if (facts.complexity !== 'simple' || facts.synthesisAllowed !== true) {
    return synthesize('unsupported_execution_state');
  }
  if (facts.assignmentIds.length !== 1) {
    return synthesize('not_single_specialist');
  }

  const worker = facts.workerResults[0];
  if (
    facts.status !== 'SUCCESS' ||
    facts.workerResults.length !== 1 ||
    !worker ||
    worker.agentId !== facts.assignmentIds[0] ||
    worker.error !== undefined
  ) {
    return synthesize('unsupported_execution_state');
  }

  // Both requested retrieval and any returned retrieval metadata exclude V1.
  if (facts.retrievalRequired !== false || worker.retrieval !== undefined) {
    return synthesize('retrieval_not_eligible');
  }
  if (typeof worker.output !== 'string' || worker.output.trim().length === 0) {
    return synthesize('invalid_worker_output');
  }

  return { topology, synthesize: false, reason: 'simple_single_specialist_direct_delivery' };
}
