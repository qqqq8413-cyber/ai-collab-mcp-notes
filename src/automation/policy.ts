import { z } from 'zod';
import { isCanonicalEgressSet, sameEgressSet } from './egress-destination.js';
import { tryParsePacket } from './packet.js';
import { parseInstant } from './time.js';
import {
  ACTOR_KINDS, ROLES, type Actor, type Authorization, type AuthorizationClass, type ImplementationPacket,
  type NetworkLevel, type ProviderCallScope, type ValidationCommand,
} from './types.js';

const POLICY_ENTRIES = {
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
export type Operation = keyof typeof POLICY_ENTRIES;

/**
 * The fixed `target` of every LIVE_PROVIDER_MODEL_CALL request and grant. A live call's
 * network authority is its exact egress destination set, never a target string.
 */
export const LIVE_PROVIDER_MODEL_CALL_TARGET = 'live-provider-model-call';

// The authority source evaluatePolicy consults: private, frozen, null-prototype (so
// no inherited or polluted key can classify an operation). Nothing exported aliases it.
const POLICY: Readonly<Record<string, AuthorizationClass>> = Object.freeze(Object.assign(Object.create(null), POLICY_ENTRIES));

/** Frozen inspection copy. evaluatePolicy never reads it, so it cannot grant anything. */
export const OPERATION_POLICY: Readonly<Record<Operation, AuthorizationClass>> = Object.freeze({ ...POLICY_ENTRIES });

const NETWORK_RANK: Readonly<Record<string, number>> = Object.freeze(Object.assign(Object.create(null), {
  OFFLINE: 0, READ_WEB: 1, READ_EXTERNAL_API: 2, WRITE_EXTERNAL: 3, SENSITIVE_WRITE: 4,
} satisfies Record<NetworkLevel, number>));
const OPERATION_LEVEL: Readonly<Record<string, NetworkLevel>> = Object.freeze(Object.assign(Object.create(null), {
  PUSH_WORK_BRANCH: 'WRITE_EXTERNAL', FAST_FORWARD_MAIN: 'WRITE_EXTERNAL',
  READ_WEB: 'READ_WEB', READ_EXTERNAL_API: 'READ_EXTERNAL_API',
  WRITE_EXTERNAL: 'WRITE_EXTERNAL', SENSITIVE_WRITE: 'SENSITIVE_WRITE',
  LIVE_PROVIDER_MODEL_CALL: 'READ_EXTERNAL_API',
} satisfies Partial<Record<Operation, NetworkLevel>>));

// Exact values are compared as given: surrounding whitespace is refused, not trimmed,
// and '*' is refused rather than read as a wildcard.
const exact = z.string().min(1).refine((s) => s.trim() === s && !s.includes('*'));
const text = z.string().min(1).refine((s) => s.trim() === s);
const instant = z.string().refine((s) => parseInstant(s) !== undefined);
const scopeSchema = z.strictObject({ actorKind: z.enum(ACTOR_KINDS), provider: exact, model: exact,
  egressDestinations: z.array(z.string()).refine((set) => isCanonicalEgressSet(set)) });
const authSchema = z.strictObject({
  authorizationId: exact,
  actorRole: z.enum(['GPT_ARCHITECT', 'HUMAN']),
  operation: exact,
  target: exact,
  runId: exact.optional(),
  packetId: exact.optional(),
  scope: scopeSchema.optional(),
  issuedAt: instant,
  expiresAt: instant.optional(),
  reason: text,
}).refine((a) => a.expiresAt === undefined || parseInstant(a.expiresAt)! >= parseInstant(a.issuedAt)!);

const actorSchema = z.strictObject({ id: exact, role: z.enum(ROLES) });
const requestSchema = z.strictObject({
  operation: z.string(),
  target: exact,
  actor: actorSchema,
  packet: z.unknown().optional(),
  runId: exact.optional(),
  authorization: z.unknown().optional(),
  now: instant,
  resourceClassification: z.enum(['ORDINARY', 'CASE_001']).optional(),
  command: z.strictObject({ executable: z.string(), args: z.array(z.string()), cwd: z.string() }).optional(),
  providerCall: scopeSchema.optional(),
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
  /** RUN_OFFLINE_VALIDATION only; `target` is the packet's commandId. */
  command?: { executable: string; args: string[]; cwd: string };
  /** LIVE_PROVIDER_MODEL_CALL only; `target` is LIVE_PROVIDER_MODEL_CALL_TARGET. */
  providerCall?: ProviderCallScope;
}
export interface PolicyResult {
  decision: 'AUTHORIZED' | 'DENIED' | 'REQUIRE_GPT' | 'REQUIRE_HUMAN';
  classification?: AuthorizationClass;
  reason: string;
  /** On an AUTHORIZED RUN_OFFLINE_VALIDATION: the exact packet-bound command to run, argv without a shell. */
  validationCommand?: ValidationCommand;
}

/** A fresh validated copy of authorization data, or undefined. Never throws. */
export function parseAuthorization(value: unknown): Authorization | undefined {
  try {
    const parsed = authSchema.safeParse(value);
    return parsed.success ? parsed.data as Authorization : undefined;
  } catch {
    return undefined;
  }
}

export interface AuthorizationBinding {
  role: 'HUMAN' | 'GPT_ARCHITECT';
  operation: string;
  target: string | undefined;
  runId: string | undefined;
  packetId: string | undefined;
  scope?: ProviderCallScope;
}

// This validates authorization data, not the issuer's real identity or signature.
// Authentication belongs to a later integration boundary. Every bound field must
// match exactly: a grant that names no packet cannot be used where a packet is
// active, and one that names a packet cannot be used where none is.
/** Whether validated authorization data names exactly this action. Ignores time; see matchAuthorization. */
export function authorizationBinds(auth: Authorization, binding: AuthorizationBinding): boolean {
  if (binding.target === undefined || (binding.runId === undefined && binding.packetId === undefined)) return false;
  const sameScope = auth.scope === undefined || binding.scope === undefined
    ? auth.scope === binding.scope
    : auth.scope.actorKind === binding.scope.actorKind && auth.scope.provider === binding.scope.provider &&
      auth.scope.model === binding.scope.model &&
      sameEgressSet(auth.scope.egressDestinations, binding.scope.egressDestinations);
  return auth.actorRole === binding.role && auth.operation === binding.operation && auth.target === binding.target &&
    auth.runId === binding.runId && auth.packetId === binding.packetId && sameScope;
}

/** A validated copy of the grant if it binds exactly this action and `now` is inside its window. */
export function matchAuthorization(value: unknown, binding: AuthorizationBinding, now: string): Authorization | undefined {
  const auth = parseAuthorization(value);
  const at = parseInstant(now);
  if (!auth || at === undefined || !authorizationBinds(auth, binding)) return undefined;
  if (parseInstant(auth.issuedAt)! > at) return undefined;
  if (auth.expiresAt !== undefined && at > parseInstant(auth.expiresAt)!) return undefined;
  return auth;
}

/**
 * A public runtime boundary: the request is parsed strictly here, whatever the caller's
 * static types claim, and anything unrecognised is DENIED. It never throws.
 */
export function evaluatePolicy(request: PolicyRequest): PolicyResult {
  try {
    return decide(request);
  } catch {
    return { decision: 'DENIED', reason: 'policy request could not be evaluated' };
  }
}

function decide(input: unknown): PolicyResult {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) return { decision: 'DENIED', reason: 'malformed policy request' };
  const request = parsed.data;
  if (!Object.hasOwn(POLICY, request.operation)) return { decision: 'DENIED', reason: 'unknown operation' };
  const operation = request.operation as Operation;
  const classification = POLICY[operation];
  const deny = (reason: string): PolicyResult => ({ decision: 'DENIED', classification, reason });
  if (classification === 'FORBIDDEN') return deny('forbidden by G1 policy');
  const packet = tryParsePacket(request.packet);
  if (!packet) return deny('packet missing or malformed');
  const authorization = request.authorization === undefined ? undefined : parseAuthorization(request.authorization);
  if (request.authorization !== undefined && !authorization) return deny('malformed authorization');
  if (request.command !== undefined && operation !== 'RUN_OFFLINE_VALIDATION') return deny('command facts apply only to RUN_OFFLINE_VALIDATION');
  if (request.providerCall !== undefined && operation !== 'LIVE_PROVIDER_MODEL_CALL') return deny('provider call facts apply only to LIVE_PROVIDER_MODEL_CALL');
  if (['READ_REPOSITORY', 'EDIT_PACKET_SCOPE', 'COMMIT_WORK_BRANCH', 'PUSH_WORK_BRANCH'].includes(operation)) {
    if (request.resourceClassification !== 'ORDINARY') {
      return deny('repository resource classification missing or protected; use CASE_001_ACCESS with exact human authorization');
    }
  }
  if (operation === 'LIVE_PROVIDER_MODEL_CALL') {
    // Actor, provider, model, and the egress destination set are separate facts, each
    // separately bound, and only against the packet entry for this call's own actor.
    const call = request.providerCall;
    const allowed = packet.providerCallAuthorization;
    if (!call) return deny('actor, provider, model, and egress destinations must each be stated');
    if (request.target !== LIVE_PROVIDER_MODEL_CALL_TARGET) return deny(`target must be ${LIVE_PROVIDER_MODEL_CALL_TARGET}; network authority is the egress set`);
    if (!allowed.allowed || allowed.maxCalls < 1) return deny('provider calls not authorized in packet');
    // No fallback to another actor's entry, and no search across entries.
    const entry = allowed.calls.find((candidate) => candidate.actorKind === call.actorKind);
    if (!entry) return deny('no packet call entry for this actor');
    if (entry.provider !== call.provider) return deny('provider differs from the packet entry for this actor');
    if (entry.model !== call.model) return deny('model differs from the packet entry for this actor');
    // Exactly this actor's set: a missing, an extra, or a borrowed destination is a different authority.
    if (!sameEgressSet(call.egressDestinations, entry.egressDestinations)) return deny('egress destinations differ from the packet entry for this actor');
    if (call.egressDestinations.some((destination) => !packet.networkAuthorization.destinations.includes(destination))) {
      return deny('egress destination not in packet network destinations');
    }
  }
  const requiredLevel = OPERATION_LEVEL[operation];
  if (requiredLevel) {
    const granted = NETWORK_RANK[packet.networkAuthorization.level];
    if (typeof granted !== 'number' || granted < NETWORK_RANK[requiredLevel]) return deny('insufficient packet network level');
    if (operation !== 'PUSH_WORK_BRANCH' && operation !== 'LIVE_PROVIDER_MODEL_CALL' &&
        !packet.networkAuthorization.destinations.includes(request.target)) {
      return deny('target not in packet network destinations');
    }
  }
  if (operation === 'PUSH_WORK_BRANCH' &&
      (request.target !== packet.targetBranch ||
       !packet.networkAuthorization.destinations.includes(request.target))) return deny('work branch not authorized');
  if (operation === 'FAST_FORWARD_MAIN' && request.target !== 'main') return deny('promotion target must be main');
  if (operation === 'CREATE_WORK_BRANCH' && request.target !== packet.targetBranch) return deny('branch mismatch');
  if (operation === 'COMMIT_WORK_BRANCH' && request.target !== packet.targetBranch) return deny('commit branch mismatch');
  if (operation === 'EDIT_PACKET_SCOPE' && !packet.allowedAreas.includes(request.target)) return deny('area outside packet');
  let validationCommand: ValidationCommand | undefined;
  if (operation === 'RUN_OFFLINE_VALIDATION') {
    // The operation's name proves nothing: the exact argv and cwd must be a packet
    // entry the issuer classified as offline validation.
    const requested = request.command;
    const bound = packet.validationCommands.find((command) => command.commandId === request.target);
    if (!requested) return deny('exact validation command facts missing');
    if (!bound) return deny('validation command not in packet');
    if (bound.classification !== 'OFFLINE_VALIDATION') return deny('packet classifies this command as an external effect');
    if (requested.executable !== bound.executable || requested.cwd !== bound.cwd ||
        requested.args.length !== bound.args.length ||
        requested.args.some((arg, index) => arg !== bound.args[index])) {
      return deny('command differs from the packet-bound executable, arguments, or working directory');
    }
    validationCommand = bound;
  }
  if (classification === 'ALLOW_AUTOMATIC') {
    if (request.actor.role !== 'CODEX_IMPLEMENTER' && request.actor.role !== 'CONTROLLER') return deny('actor not implementer or coordinator');
    return { decision: 'AUTHORIZED', classification, reason: 'packet-scoped automatic action',
      ...(validationCommand ? { validationCommand } : {}) };
  }
  const needed = classification === 'REQUIRE_GPT' ? 'GPT_ARCHITECT' : 'HUMAN';
  if (request.actor.role !== needed) return { decision: classification, classification, reason: `requires ${needed}` };
  if (!matchAuthorization(authorization, { role: needed, operation, target: request.target,
      runId: request.runId, packetId: packet.packetId, scope: request.providerCall }, request.now)) {
    return { decision: classification, classification, reason: `missing exact ${needed} authorization data` };
  }
  return { decision: 'AUTHORIZED', classification, reason: 'exact authorization data present' };
}

/**
 * The live-model dispatch gate: the existing LIVE_PROVIDER_MODEL_CALL policy, evaluated
 * for exactly this call on the authority of the caller-supplied grant. The packet entry
 * for the call's actor must name exactly this provider, model, and egress set, every
 * destination of which is a packet network destination, and the grant must be an exact,
 * current HUMAN authorization for this run, packet, actor, provider, model, and egress
 * set. A grant is evaluated as the role it states, so any other role is refused.
 */
export function authorizeLiveModelCall(input: { packet: unknown; runId: string; scope: ProviderCallScope;
  authorization: unknown; now: string }): PolicyResult {
  const grant = parseAuthorization(input.authorization);
  if (!grant) return { decision: 'DENIED', reason: 'live model call authorization missing or malformed' };
  return evaluatePolicy({ operation: 'LIVE_PROVIDER_MODEL_CALL', target: LIVE_PROVIDER_MODEL_CALL_TARGET,
    actor: { id: grant.authorizationId, role: grant.actorRole }, packet: input.packet as ImplementationPacket,
    runId: input.runId, authorization: grant, now: input.now, providerCall: input.scope });
}

export function evaluateDiffWarnings(changedFiles: number, changedDiffLines: number): string[] {
  if (!Number.isSafeInteger(changedFiles) || changedFiles < 0 ||
      !Number.isSafeInteger(changedDiffLines) || changedDiffLines < 0) throw new Error('Invalid diff facts');
  return [
    ...(changedFiles > 10 ? ['SCOPE_WARNING_CHANGED_FILES'] : []),
    ...(changedDiffLines > 500 ? ['SCOPE_WARNING_DIFF_LINES'] : []),
  ];
}
