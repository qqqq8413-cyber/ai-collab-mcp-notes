import { createHash } from 'node:crypto';
import { z } from 'zod';
import { NETWORK_LEVELS, type CorrectionPacket, type ImplementationPacket } from './types.js';

// Schemas stay module-private. An exported zod object is mutable authority any
// importer could alter; callers get parse functions instead.
const SHA = z.string().regex(/^[a-f0-9]{40}$/);
const PACKET_HASH = z.string().regex(/^[a-f0-9]{64}$/);
const nonempty = z.string().trim().min(1);
const entries = z.array(nonempty).min(1);
const level = z.enum(NETWORK_LEVELS);

// A shell or `env` would turn one argv element back into a free-form command, which
// exact argv binding exists to prevent. This refuses those launchers only; it does
// not certify any other program as free of side effects.
const COMMAND_LAUNCHERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'fish', 'csh', 'tcsh',
  'cmd', 'powershell', 'pwsh', 'env']);
const PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;
const validationCommand = z.strictObject({
  commandId: nonempty.refine((id) => !id.includes('*')),
  executable: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/)
    .refine((name) => !COMMAND_LAUNCHERS.has(name.toLowerCase().replace(/\.exe$/, ''))),
  args: z.array(z.string().refine((arg) => !arg.includes('\0'))),
  // Repository-relative, '.' for the root; never absolute and never climbing out.
  cwd: z.string().refine((dir) => dir === '.' ||
    dir.split('/').every((part) => PATH_SEGMENT.test(part) && part !== '.' && part !== '..')),
  classification: z.enum(['OFFLINE_VALIDATION', 'EXTERNAL_EFFECT']),
});

const packetSchema = z.strictObject({
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
  validationCommands: z.array(validationCommand).min(1),
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
  const ids = packet.validationCommands.map((command) => command.commandId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', message: 'Validation command ids must be unique' });
  }
});

const correctionSchema = z.strictObject({
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

export function isSha(value: unknown): value is string {
  return SHA.safeParse(value).success;
}
export function isPacketHash(value: unknown): value is string {
  return PACKET_HASH.safeParse(value).success;
}
export function parsePacket(value: unknown): ImplementationPacket {
  return packetSchema.parse(value) as ImplementationPacket;
}
/** A fresh validated copy, or undefined. Never throws, including on hostile getters. */
export function tryParsePacket(value: unknown): ImplementationPacket | undefined {
  try {
    const parsed = packetSchema.safeParse(value);
    return parsed.success ? parsed.data as ImplementationPacket : undefined;
  } catch {
    return undefined;
  }
}
export function packetHash(packet: ImplementationPacket): string {
  return createHash('sha256').update(canonical(parsePacket(packet))).digest('hex');
}
export function parseCorrection(value: unknown): CorrectionPacket {
  return correctionSchema.parse(value) as CorrectionPacket;
}

export function validateCorrection(input: CorrectionPacket, packetInput: ImplementationPacket,
  hash: string, rejectedSha: string, reviewerFindings: string[], nextIteration: number): void {
  // Compare validated copies, never the caller's objects, which could change between reads.
  const correction = parseCorrection(input);
  const packet = parsePacket(packetInput);
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
