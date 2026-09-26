import type { ExecutionAuthorityPort } from '../execution/boundary.js';
import {
  claimRouteExecution,
  type DeliberationState,
  type DeliberationStateAccessPort,
  type LiveExecutionPolicyResolver,
  type RouteExecutionCheckpointStore,
} from './deliberation.js';
import type { StressTestSession } from './types.js';

/** The product's D1-A claim remains the only source of execution authority. */
export function createD1ExecutionAuthority(
  session: StressTestSession,
  state: DeliberationState,
  store: RouteExecutionCheckpointStore,
  stateAccessPort: DeliberationStateAccessPort,
  policyResolver: LiveExecutionPolicyResolver
): ExecutionAuthorityPort {
  return {
    claim(attemptId) {
      const checkpoint = claimRouteExecution(session, state, store, stateAccessPort, policyResolver, { attemptId });
      return checkpoint.phase === 'CLAIMED'
        ? { kind: 'CLAIMED', attemptId: checkpoint.attemptId, checkpoint }
        : { kind: 'PRE_CALL_TERMINAL', attemptId: checkpoint.attemptId, checkpoint };
    },
  };
}
