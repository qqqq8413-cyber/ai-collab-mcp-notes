import { z } from 'zod';
import type { Actor, Authorization, AuthorizationClass, ImplementationPacket, NetworkLevel } from './types.js';

export const OPERATION_POLICY = {
  READ_REPOSITORY: 'ALLOW_AUTOMATIC', CREATE_WORK_BRANCH: 'ALLOW_AUTOMATIC',
  EDIT_PACKET_SCOPE: 'ALLOW_AUTOMATIC', RUN_OFFLINE_VALIDATION: 'ALLOW_AUTOMATIC',
  COMMIT_WORK_BRANCH: 'ALLOW_AUTOMATIC', PUSH_WORK_BRANCH: 'ALLOW_AUTOMATIC',
  INDEPENDENT_ACCEPTANCE: 'REQUIRE_GPT', ISSUE_CORRECTION_PACKET: 'REQUIRE_GPT',
  FAST_FORWARD_MAIN: 'REQUIRE_HUMAN',
  MERGE_COMMIT: 'FORBIDDEN', SQUASH_ACCEPTED_SHA: 'FORBIDDEN',
  REBASE_ACCEPTED_SHA: 'FORBIDDEN', FORCE_PUSH: 'FORBIDDEN',
  DELETE_BRANCH: 'REQUIRE_HUMAN', CHANGE_BRANCH_PROTECTION: 'REQUIRE_HUMAN',
  CHANGE_REPOSITORY_SETTINGS: 'REQUIRE_HUMAN', MODIFY_WORKFLOW: 'REQUIRE_HUMAN',
  READ_TASK_SECRET: 'REQUIRE_HUMAN', MODIFY_SECRET: 'REQUIRE_HUMAN',
  READ_WEB: 'REQUIRE_GPT', READ_EXTERNAL_API: 'REQUIRE_GPT',
  WRITE_EXTERNAL: 'REQUIRE_GPT', SENSITIVE_WRITE: 'REQUIRE_HUMAN',
  LIVE_PROVIDER_MODEL_CALL: 'REQUIRE_HUMAN', PRODUCTION_DB_MUTATION: 'REQUIRE_HUMAN',
  DESTRUCTIVE_MIGRATION: 'REQUIRE_HUMAN', CASE_001_ACCESS: 'REQUIRE_HUMAN',
  AUTHORITY_MODEL_CHANGE: 'REQUIRE_HUMAN', SECURITY_BOUNDARY_CHANGE: 'REQUIRE_HUMAN',
} as const satisfies Record<string, AuthorizationClass>;
export type Operation = keyof typeof OPERATION_POLICY;

const authSchema = z.strictObject({
  authorizationId: z.string().trim().min(1),
  actorRole: z.enum(['GPT_ARCHITECT', 'HUMAN']),
  operation: z.string().trim().min(1),
  target: z.string().trim().min(1).refine((s) => !s.includes('*')),
  runId: z.string().trim().min(1).optional(),
  packetId: z.string().trim().min(1).optional(),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().optional(),
  reason: z.string().trim().min(1),
});

export interface PolicyRequest {
  operation: string;
  target: string;
  actor: Actor;
  packet?: ImplementationPacket;
  runId?: string;
  authorization?: Authorization;
  now: string;
  resourceClassification?: 'ORDINARY' | 'CASE_001';
}
export interface PolicyResult { decision: 'AUTHORIZED' | 'DENIED' | 'REQUIRE_GPT' | 'REQUIRE_HUMAN'; classification?: AuthorizationClass; reason: string }
const networkRank: Record<NetworkLevel, number> = {
  OFFLINE: 0, READ_WEB: 1, READ_EXTERNAL_API: 2, WRITE_EXTERNAL: 3, SENSITIVE_WRITE: 4,
};
const operationLevel: Partial<Record<Operation, NetworkLevel>> = {
  PUSH_WORK_BRANCH: 'WRITE_EXTERNAL', FAST_FORWARD_MAIN: 'WRITE_EXTERNAL',
  READ_WEB: 'READ_WEB', READ_EXTERNAL_API: 'READ_EXTERNAL_API',
  WRITE_EXTERNAL: 'WRITE_EXTERNAL', SENSITIVE_WRITE: 'SENSITIVE_WRITE',
  LIVE_PROVIDER_MODEL_CALL: 'READ_EXTERNAL_API',
};

// This validates authorization data, not the issuer's real identity or signature.
// Authentication belongs to a later integration boundary.
export function validAuthorization(auth: unknown, operation: string, target: string,
  runId: string | undefined, packetId: string | undefined, now: string,
  role: 'HUMAN' | 'GPT_ARCHITECT'): auth is Authorization {
  const parsed = authSchema.safeParse(auth);
  if (!parsed.success || !z.iso.datetime().safeParse(now).success) return false;
  const value = parsed.data;
  return value.actorRole === role && value.operation === operation && value.target === target &&
    (value.runId === undefined || value.runId === runId) &&
    (value.packetId === undefined || value.packetId === packetId) &&
    value.issuedAt <= now && (value.expiresAt === undefined || now <= value.expiresAt) &&
    (value.runId !== undefined || value.packetId !== undefined);
}

export function evaluatePolicy(request: PolicyRequest): PolicyResult {
  if (!Object.hasOwn(OPERATION_POLICY, request.operation)) return { decision: 'DENIED', reason: 'unknown operation' };
  const operation = request.operation as Operation;
  const classification = OPERATION_POLICY[operation];
  const deny = (reason: string): PolicyResult => ({ decision: 'DENIED', classification, reason });
  if (classification === 'FORBIDDEN') return deny('forbidden by G1 policy');
  if (!request.packet || !request.target || request.target.includes('*')) return deny('packet or exact target missing');
  if (['READ_REPOSITORY', 'EDIT_PACKET_SCOPE', 'COMMIT_WORK_BRANCH', 'PUSH_WORK_BRANCH'].includes(operation)) {
    if (request.resourceClassification !== 'ORDINARY') {
      return deny('repository resource classification missing or protected; use CASE_001_ACCESS with exact human authorization');
    }
  }
  const requiredLevel = operationLevel[operation];
  if (requiredLevel && networkRank[request.packet.networkAuthorization.level] < networkRank[requiredLevel]) {
    return deny('insufficient packet network level');
  }
  if (requiredLevel && operation !== 'PUSH_WORK_BRANCH' &&
      !request.packet.networkAuthorization.destinations.includes(request.target)) {
    return deny('target not in packet network destinations');
  }
  if (operation === 'PUSH_WORK_BRANCH' &&
      (request.target !== request.packet.targetBranch ||
       !request.packet.networkAuthorization.destinations.includes(request.target))) return deny('work branch not authorized');
  if (operation === 'FAST_FORWARD_MAIN' && request.target !== 'main') return deny('promotion target must be main');
  if (operation === 'LIVE_PROVIDER_MODEL_CALL' &&
      (!request.packet.providerCallAuthorization.allowed ||
       !request.packet.providerCallAuthorization.models.includes(request.target) ||
       request.packet.providerCallAuthorization.maxCalls < 1)) return deny('provider call not authorized in packet');
  if (operation === 'CREATE_WORK_BRANCH' && request.target !== request.packet.targetBranch) return deny('branch mismatch');
  if (operation === 'COMMIT_WORK_BRANCH' && request.target !== request.packet.targetBranch) return deny('commit branch mismatch');
  if (operation === 'EDIT_PACKET_SCOPE' && !request.packet.allowedAreas.includes(request.target)) return deny('area outside packet');
  if (classification === 'ALLOW_AUTOMATIC') {
    if (request.actor.role !== 'CODEX_IMPLEMENTER' && request.actor.role !== 'CONTROLLER') return deny('actor not implementer or coordinator');
    return { decision: 'AUTHORIZED', classification, reason: 'packet-scoped automatic action' };
  }
  const needed = classification === 'REQUIRE_GPT' ? 'GPT_ARCHITECT' : 'HUMAN';
  if (request.actor.role !== needed) return { decision: classification, classification, reason: `requires ${needed}` };
  if (!validAuthorization(request.authorization, operation, request.target, request.runId,
      request.packet.packetId, request.now, needed)) {
    return { decision: classification, classification, reason: `missing exact ${needed} authorization data` };
  }
  return { decision: 'AUTHORIZED', classification, reason: 'exact authorization data present' };
}

export function evaluateDiffWarnings(changedFiles: number, changedDiffLines: number): string[] {
  if (!Number.isSafeInteger(changedFiles) || changedFiles < 0 ||
      !Number.isSafeInteger(changedDiffLines) || changedDiffLines < 0) throw new Error('Invalid diff facts');
  return [
    ...(changedFiles > 10 ? ['SCOPE_WARNING_CHANGED_FILES'] : []),
    ...(changedDiffLines > 500 ? ['SCOPE_WARNING_DIFF_LINES'] : []),
  ];
}
