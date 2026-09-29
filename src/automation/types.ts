// Runtime vocabularies are frozen: they back validation, so an importer must not be
// able to extend them.
export const STATES = Object.freeze([
  'IDLE', 'ARCHITECTURE', 'PACKET_READY', 'IMPLEMENTING',
  'IMPLEMENTATION_COMPLETE', 'REMOTE_SHA_READY', 'ACCEPTANCE_REVIEW',
  'CORRECTION_REQUIRED', 'ACCEPTED', 'PROMOTION_READY', 'PROMOTING',
  'CANONICAL_CI', 'CLOSED', 'SOFT_STOP', 'ARCHITECTURE_STOP',
  'HUMAN_STOP', 'FAILED_CLOSED',
] as const);
export type ControllerState = typeof STATES[number];
export const STOP_CLASSES = Object.freeze(['SOFT_STOP', 'ARCHITECTURE_STOP', 'HUMAN_STOP'] as const);
export type StopClass = typeof STOP_CLASSES[number];
export const ROLES = Object.freeze(['HUMAN', 'GPT_ARCHITECT', 'CODEX_IMPLEMENTER', 'CONTROLLER', 'GITHUB'] as const);
export type Role = typeof ROLES[number];
export const NETWORK_LEVELS = Object.freeze(['OFFLINE', 'READ_WEB', 'READ_EXTERNAL_API', 'WRITE_EXTERNAL', 'SENSITIVE_WRITE'] as const);
export type NetworkLevel = typeof NETWORK_LEVELS[number];
export type AuthorizationClass = 'ALLOW_AUTOMATIC' | 'REQUIRE_GPT' | 'REQUIRE_HUMAN' | 'FORBIDDEN';

export interface Actor { id: string; role: Role }
export interface Clock { now(): string }

/** The two actors whose calls are live model calls. */
export const ACTOR_KINDS = Object.freeze(['IMPLEMENTATION', 'ARCHITECT_REVIEW'] as const);
export type ActorKind = typeof ACTOR_KINDS[number];

/**
 * The facts a live model call is authorized against. None is inferred from another.
 * `actorKind` names the one actor the call is for: a scope, a packet call entry, or a
 * grant for one actor confers nothing on the other. `egressDestinations` is the exact
 * canonical set of `hostname:port` authorities that actor's model process may reach
 * (sorted, unique; see egress-destination.ts). It is network authority only because an
 * approved egress-bound boundary enforces it; a declared destination without that
 * enforcement grants nothing.
 */
export interface ProviderCallScope { actorKind: ActorKind; provider: string; model: string; egressDestinations: string[] }

export interface Authorization {
  authorizationId: string;
  actorRole: 'GPT_ARCHITECT' | 'HUMAN';
  operation: string;
  target: string;
  runId?: string;
  packetId?: string;
  /** LIVE_PROVIDER_MODEL_CALL only: the exact actor, provider, model, and egress destination set granted. */
  scope?: ProviderCallScope;
  issuedAt: string;
  expiresAt?: string;
  reason: string;
}
export interface GPTAuthorization extends Authorization { actorRole: 'GPT_ARCHITECT' }
export interface HumanAuthorization extends Authorization { actorRole: 'HUMAN' }

/**
 * One exact validation command. It is argv, not a shell string: an execution adapter
 * runs `executable` with exactly `args` in the repository-relative `cwd`, without a
 * shell. `classification` is the packet issuer's statement of effect; only
 * OFFLINE_VALIDATION can be authorized by RUN_OFFLINE_VALIDATION.
 */
export interface ValidationCommand {
  commandId: string;
  executable: string;
  args: string[];
  cwd: string;
  classification: 'OFFLINE_VALIDATION' | 'EXTERNAL_EFFECT';
}

export interface ImplementationPacket {
  packetId: string;
  packetVersion: number;
  sliceId: string;
  expectedBaseSha: string;
  targetBranch: string;
  objective: string;
  allowedAreas: string[];
  forbiddenChanges: string[];
  invariants: string[];
  acceptanceCriteria: string[];
  validationCommands: ValidationCommand[];
  networkAuthorization: { level: NetworkLevel; destinations: string[]; purpose: string; budget: number };
  /**
   * `calls`: the one authority for live calls, at most one entry per actor kind, each the
   * exact scope that actor's calls must state; empty when calls are not allowed.
   * `maxCalls` is shared by every actor of the packet.
   */
  providerCallAuthorization: { allowed: boolean; calls: ProviderCallScope[]; maxCalls: number; budget: number };
  destructiveOperationAuthorization: { allowed: boolean };
  iterationBudget: {
    maxImplementationIterationsPerSlice: number;
    maxAcceptanceFailuresPerSlice: number;
    maxRuntimeMinutesPerIteration: number;
    maxParallelImplementationAgents: number;
  };
}

export interface CorrectionPacket {
  correctionPacketId: string;
  originalPacketId: string;
  originalPacketHash: string;
  rejectedSha: string;
  reviewerFindings: string[];
  allowedCorrectionAreas: string[];
  unchangedInvariantReferences: string[];
  expectedBaseSha: string;
  correctionIteration: number;
  maxCorrectionIteration: number;
}

export interface RemoteShaEvidence {
  repository: string;
  branch: string;
  sha: string;
  observedAt: string;
  source: 'GITHUB';
}
export interface AcceptanceDecision {
  reviewId: string;
  actor: 'GPT_ARCHITECT';
  packetId: string;
  packetHash: string;
  reviewedSha: string;
  decision: 'ACCEPT' | 'REJECT';
  findings: string[];
  evidenceReferences: string[];
  issuedAt: string;
}

export interface PromotionPreflightFacts {
  expectedMainSha: string;
  observedMainSha: string;
  acceptedSha: string;
  aheadBy: number;
  behindBy: number;
  hasMainOnlyCommits: boolean;
  acceptedShaCiPassed: boolean;
  requiredCheckPassed: boolean;
  mainProtected: boolean;
}
export interface PostPromotionFacts {
  observedMainSha: string;
  expectedAcceptedSha: string;
  mainCiPassed: boolean;
  requiredCheckPassed: boolean;
  mainProtected: boolean;
}

/**
 * One exact audit occurrence of one run. A controller write bound to it applies only
 * while that entry is still the run's last entry. Integrity and coordination data,
 * not a credential: it grants nothing.
 */
export interface ControllerOccurrenceGuard {
  runId: string;
  sequence: number;
  action: string;
  timestamp: string;
}

export interface AuditEntry {
  sequence: number;
  runId: string;
  sliceId: string;
  actor: string;
  role: Role;
  action: string;
  timestamp: string;
  previousState: ControllerState;
  nextState: ControllerState;
  repository: string;
  branch?: string;
  baseSHA?: string;
  resultingSHA?: string;
  authorizationReference?: string;
  packetId?: string;
  packetHash?: string;
  acceptanceSHA?: string;
  stopReason?: string;
  stopId?: string;
}
export interface ControllerRun {
  runId: string;
  sliceId: string;
  repository: string;
  state: ControllerState;
  interruptedState?: ControllerState;
  externalRecheckRequired?: boolean;
  stopReason?: string;
  /**
   * Identity of the current stop occurrence, `stop-<audit sequence>` of the entry
   * that entered it. A HUMAN_STOP resume grant targets this, not the run.
   */
  stopId?: string;
  /** The grant consumed by the most recent HUMAN_STOP resume. */
  humanResumeAuthorization?: HumanAuthorization;
  activePacket?: ImplementationPacket;
  activePacketHash?: string;
  correctionPacket?: CorrectionPacket;
  implementationIterations: number;
  iterationStartedAt?: string;
  acceptanceFailures: number;
  remoteSha?: RemoteShaEvidence;
  acceptance?: AcceptanceDecision;
  promotionAuthorization?: HumanAuthorization;
  promotionPreflight?: PromotionPreflightFacts;
  observedPromotedMainSha?: string;
  audit: AuditEntry[];
}
