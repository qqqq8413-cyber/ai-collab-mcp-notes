export const STATES = [
  'IDLE', 'ARCHITECTURE', 'PACKET_READY', 'IMPLEMENTING',
  'IMPLEMENTATION_COMPLETE', 'REMOTE_SHA_READY', 'ACCEPTANCE_REVIEW',
  'CORRECTION_REQUIRED', 'ACCEPTED', 'PROMOTION_READY', 'PROMOTING',
  'CANONICAL_CI', 'CLOSED', 'SOFT_STOP', 'ARCHITECTURE_STOP',
  'HUMAN_STOP', 'FAILED_CLOSED',
] as const;
export type ControllerState = typeof STATES[number];
export type StopClass = 'SOFT_STOP' | 'ARCHITECTURE_STOP' | 'HUMAN_STOP';
export type Role = 'HUMAN' | 'GPT_ARCHITECT' | 'CODEX_IMPLEMENTER' | 'CONTROLLER' | 'GITHUB';
export type NetworkLevel = 'OFFLINE' | 'READ_WEB' | 'READ_EXTERNAL_API' | 'WRITE_EXTERNAL' | 'SENSITIVE_WRITE';
export type AuthorizationClass = 'ALLOW_AUTOMATIC' | 'REQUIRE_GPT' | 'REQUIRE_HUMAN' | 'FORBIDDEN';

export interface Actor { id: string; role: Role }
export interface Clock { now(): string }

export interface Authorization {
  authorizationId: string;
  actorRole: 'GPT_ARCHITECT' | 'HUMAN';
  operation: string;
  target: string;
  runId?: string;
  packetId?: string;
  issuedAt: string;
  expiresAt?: string;
  reason: string;
}
export interface GPTAuthorization extends Authorization { actorRole: 'GPT_ARCHITECT' }
export interface HumanAuthorization extends Authorization { actorRole: 'HUMAN' }

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
  validationCommands: string[];
  networkAuthorization: { level: NetworkLevel; destinations: string[]; purpose: string; budget: number };
  providerCallAuthorization: { allowed: boolean; providers: string[]; models: string[]; maxCalls: number; budget: number };
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
}
export interface ControllerRun {
  runId: string;
  sliceId: string;
  repository: string;
  state: ControllerState;
  interruptedState?: ControllerState;
  externalRecheckRequired?: boolean;
  stopReason?: string;
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
