import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CorrectionPacket, ImplementationPacket } from './types.js';

export const SHA = z.string().regex(/^[a-f0-9]{40}$/);
export const PACKET_HASH = z.string().regex(/^[a-f0-9]{64}$/);
const nonempty = z.string().trim().min(1);
const entries = z.array(nonempty).min(1);
const level = z.enum(['OFFLINE', 'READ_WEB', 'READ_EXTERNAL_API', 'WRITE_EXTERNAL', 'SENSITIVE_WRITE']);

export const packetSchema = z.strictObject({
  packetId: nonempty,
  packetVersion: z.number().int().positive(),
  sliceId: nonempty,
  expectedBaseSha: SHA,
  targetBranch: z.string().regex(/^work\/[A-Za-z0-9._/-]+$/),
  objective: nonempty,
  allowedAreas: entries,
  forbiddenChanges: entries,
  invariants: entries,
  acceptanceCriteria: entries,
  validationCommands: entries,
  networkAuthorization: z.strictObject({
    level,
    destinations: z.array(nonempty),
    purpose: nonempty,
    budget: z.number().finite().nonnegative(),
  }),
  providerCallAuthorization: z.strictObject({
    allowed: z.boolean(),
    providers: z.array(nonempty),
    models: z.array(nonempty),
    maxCalls: z.number().int().nonnegative(),
    budget: z.number().finite().nonnegative(),
  }),
  destructiveOperationAuthorization: z.strictObject({ allowed: z.boolean() }),
  iterationBudget: z.strictObject({
    maxImplementationIterationsPerSlice: z.number().int().positive().max(3),
    maxAcceptanceFailuresPerSlice: z.number().int().positive().max(3),
    maxRuntimeMinutesPerIteration: z.number().int().positive().max(60),
    maxParallelImplementationAgents: z.literal(1),
  }),
}).superRefine((packet, context) => {
  if (packet.networkAuthorization.level === 'OFFLINE' &&
      (packet.networkAuthorization.destinations.length || packet.networkAuthorization.budget !== 0)) {
    context.addIssue({ code: 'custom', message: 'OFFLINE cannot name destinations or spend network budget' });
  }
  if (!packet.providerCallAuthorization.allowed &&
      (packet.providerCallAuthorization.providers.length || packet.providerCallAuthorization.models.length ||
       packet.providerCallAuthorization.maxCalls || packet.providerCallAuthorization.budget)) {
    context.addIssue({ code: 'custom', message: 'Denied provider calls cannot carry a budget or targets' });
  }
});

export const correctionSchema = z.strictObject({
  correctionPacketId: nonempty,
  originalPacketId: nonempty,
  originalPacketHash: PACKET_HASH,
  rejectedSha: SHA,
  reviewerFindings: entries,
  allowedCorrectionAreas: entries,
  unchangedInvariantReferences: entries,
  expectedBaseSha: SHA,
  correctionIteration: z.number().int().positive(),
  maxCorrectionIteration: z.number().int().positive().max(3),
});

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  throw new Error('Unsupported canonical value');
}

export function parsePacket(value: unknown): ImplementationPacket {
  return packetSchema.parse(value) as ImplementationPacket;
}
export function packetHash(packet: ImplementationPacket): string {
  return createHash('sha256').update(canonical(parsePacket(packet))).digest('hex');
}
export function parseCorrection(value: unknown): CorrectionPacket {
  return correctionSchema.parse(value) as CorrectionPacket;
}

export function validateCorrection(correction: CorrectionPacket, packet: ImplementationPacket,
  hash: string, rejectedSha: string, reviewerFindings: string[], nextIteration: number): void {
  parseCorrection(correction);
  if (correction.originalPacketId !== packet.packetId || correction.originalPacketHash !== hash ||
      correction.rejectedSha !== rejectedSha || correction.expectedBaseSha !== rejectedSha ||
      correction.reviewerFindings.length !== reviewerFindings.length ||
      correction.reviewerFindings.some((item, index) => item !== reviewerFindings[index]) ||
      correction.correctionIteration !== nextIteration ||
      correction.maxCorrectionIteration > packet.iterationBudget.maxImplementationIterationsPerSlice ||
      correction.correctionIteration > correction.maxCorrectionIteration ||
      correction.allowedCorrectionAreas.some((area) => !packet.allowedAreas.includes(area)) ||
      correction.unchangedInvariantReferences.length !== packet.invariants.length ||
      correction.unchangedInvariantReferences.some((item, index) => item !== packet.invariants[index])) {
    throw new Error('Correction conflicts with original packet or rejected SHA');
  }
}
