import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { authorityBodyHash, type JsonObject } from '../automation/authority/document.js';
import { canonicalJson } from '../automation/invocation-journal.js';
import { packetHash } from '../automation/packet.js';
import type { ImplementationPacket } from '../automation/types.js';
import { hash, type Contract } from './contract.js';

// AUTO-P2-A4-P0-S1: the ACTIVATION_SET commit record.
//
// Three direct-authority documents (the Architect's implementation packet and the Human's two grants) are
// preserved one by one, so a crash can leave a partial set in the Authority Archive. That is allowed (authority
// may be ahead of the Controller, G1-AP1) and nothing is ever deleted. The ACTIVATION_SET says which exact
// three archived records belong together for one run, packet, contract and implementation, and it is published
// only after all three are durably preserved and verified. It is content addressed (its file name is the hash of
// its complete content), published with one exclusive link(2) after fsync, and an identical retry is a no-op.
//
// It is an OPERATIONAL_RECORD, not direct authority: it lives in the worker's result store, never in the
// Authority Archive, and it grants nothing. Every check re-derives the expected set from the archive's current
// records and the worker's own grants, so a set that names older versions, other records or another contract
// is simply not the expected one. Partial, orphan, corrupt, superseded or conflicting sets refuse activation.
//
// Signature policy (reserved for D1): S1 records the policy version it expects and an empty attestation list.
// A later policy will require a Human attestation over setHash; S1 produces, imports and reads no key, and an
// unsigned set is never eligible for a LIVE_PROVIDER call.

export const ACTIVATION_SET_SCHEMA = 'chief-activation-set.v1';
export const SIGNATURE_POLICY = Object.freeze({ version: 'S1_UNSIGNED_V0', humanSignatureRequired: false });
const ROLES = ['IMPLEMENTATION_PACKET', 'LIVE_PROVIDER_MODEL_CALL', 'LIMITED_README_WORKER'] as const;
const HEX = /^[a-f0-9]{64}$/;

const memberSchema = z.strictObject({ role: z.enum(ROLES), kind: z.enum(['IMPLEMENTATION_PACKET', 'AUTHORIZATION']),
  authorityId: z.string().min(1).max(128), version: z.number().int().min(1), recordHash: z.string().regex(HEX), bodyHash: z.string().regex(HEX) });
const setSchema = z.strictObject({ schema: z.literal(ACTIVATION_SET_SCHEMA), recordClass: z.literal('OPERATIONAL_RECORD'), notAuthority: z.literal(true),
  runId: z.string().min(1).max(200), repository: z.string().min(1).max(200), sliceId: z.string().min(1).max(200),
  packetId: z.string().min(1).max(128), packetHash: z.string().regex(HEX), contractHash: z.string().regex(HEX),
  implementationSha: z.string().regex(/^[a-f0-9]{40}$/), workerCodeHash: z.string().regex(HEX),
  members: z.tuple([memberSchema, memberSchema, memberSchema]),
  signaturePolicy: z.strictObject({ version: z.string().min(1).max(64), humanSignatureRequired: z.boolean() }),
  attestations: z.array(z.unknown()).max(0) });
const fileSchema = z.strictObject({ set: setSchema, setHash: z.string().regex(HEX) });
export type ActivationSetV1 = z.infer<typeof setSchema>;

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
export const activationSetHash = (set: ActivationSetV1) => sha256(canonicalJson(set as unknown as JsonObject));

/**
 * The only governed read-model facts the set reads (a structural subset of the governed read model). Callers pass a
 * freshly read model; this module never reads the Controller store or the Authority Archive itself.
 */
export interface ActivationSetFacts {
  runs: ReadonlyArray<{ runId: string; repository: string; sliceId: string; anomalies: readonly unknown[] }>;
  authority: ReadonlyArray<{ ref: { kind: string; authorityId: string; version: number; recordHash: string }; bodyHash: string }>;
  anomalies: readonly unknown[];
}
export interface ActivationSetInput {
  contract: Contract; packet: ImplementationPacket; model: ActivationSetFacts;
  liveGrant: unknown; limitedGrant: unknown;
}
export interface ActivationSetVerification { setHash: string; signed: false; policy: string }

class ActivationSetError extends Error {}
const refuse = (code: string): never => { throw new ActivationSetError(code); };

/** The one current archived record of each member, by exact body; any newer version makes the set stale. */
function memberOf(model: ActivationSetFacts, role: typeof ROLES[number], kind: 'IMPLEMENTATION_PACKET' | 'AUTHORIZATION', authorityId: unknown, body: unknown) {
  if (typeof authorityId !== 'string' || !body || typeof body !== 'object') return refuse('ACTIVATION_SET_MEMBER_INVALID');
  const bodyHash = authorityBodyHash(body as JsonObject);
  const versions = model.authority.filter((fact) => fact.ref.kind === kind && fact.ref.authorityId === authorityId);
  const exact = versions.filter((fact) => fact.bodyHash === bodyHash);
  if (exact.length !== 1) return refuse('ACTIVATION_SET_MEMBER_NOT_ARCHIVED');
  if (versions.some((fact) => fact.ref.version > exact[0].ref.version)) return refuse('ACTIVATION_SET_MEMBER_NOT_CURRENT');
  const { ref } = exact[0];
  return { role, kind, authorityId, version: ref.version, recordHash: ref.recordHash, bodyHash };
}

/** The set the current archive and the worker's own grants require for this contract. Pure. */
export function expectedActivationSet(input: ActivationSetInput): ActivationSetV1 {
  const { contract: c, packet, model } = input;
  const run = model.runs.find((r) => r.runId === c.runId);
  if (!run || run.repository !== c.repository || run.sliceId !== packet.sliceId || run.anomalies.length || model.anomalies.length) refuse('ACTIVATION_SET_RUN_MISMATCH');
  const grantId = (grant: unknown) => (grant && typeof grant === 'object' ? (grant as { authorizationId?: unknown }).authorizationId : undefined);
  return setSchema.parse({ schema: ACTIVATION_SET_SCHEMA, recordClass: 'OPERATIONAL_RECORD', notAuthority: true,
    runId: c.runId, repository: c.repository, sliceId: packet.sliceId, packetId: packet.packetId, packetHash: packetHash(packet), contractHash: hash(c),
    implementationSha: c.implementationSha, workerCodeHash: c.workerCodeHash,
    members: [memberOf(model, 'IMPLEMENTATION_PACKET', 'IMPLEMENTATION_PACKET', packet.packetId, packet),
      memberOf(model, 'LIVE_PROVIDER_MODEL_CALL', 'AUTHORIZATION', grantId(input.liveGrant), input.liveGrant),
      memberOf(model, 'LIMITED_README_WORKER', 'AUTHORIZATION', grantId(input.limitedGrant), input.limitedGrant)],
    signaturePolicy: { ...SIGNATURE_POLICY }, attestations: [] });
}

const runKey = (runId: string) => sha256(`chief-activation-set-run\n${runId}`);
function directoryOf(root: string, runId: string, create: boolean): string {
  const base = join(root, 'activation-sets'), dir = join(base, runKey(runId));
  for (const path of [base, dir]) {
    if (create) { try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } }
    let st;
    try { st = lstatSync(path); } catch { return refuse('ACTIVATION_SET_MISSING'); }
    if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077)) refuse('ACTIVATION_SET_STORAGE_UNSAFE');
  }
  return dir;
}
function readSetFile(path: string): z.infer<typeof fileSchema> {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > 64 * 1024) return refuse('ACTIVATION_SET_CORRUPT');
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(fd, 'utf8')));
    if (!parsed.success || activationSetHash(parsed.data.set) !== parsed.data.setHash) return refuse('ACTIVATION_SET_CORRUPT');
    return parsed.data;
  } catch (error) {
    if (error instanceof ActivationSetError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return refuse('ACTIVATION_SET_MISSING');
    return refuse('ACTIVATION_SET_CORRUPT');
  } finally { if (fd !== undefined) closeSync(fd); }
}

/**
 * Publish the expected set after all three members are durably archived and verified: temp + fsync, one
 * exclusive link(2), directory fsync. An existing identical set is the same commit (idempotent); anything else
 * under that name is a conflict. Returns the set hash.
 */
export function publishActivationSet(root: string, input: ActivationSetInput): string {
  const set = expectedActivationSet(input), setHash = activationSetHash(set);
  const dir = directoryOf(root, set.runId, true), target = join(dir, `${setHash}.json`);
  const text = JSON.stringify({ set, setHash });
  const temp = join(dir, `.${randomUUID()}.tmp`);
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    try { linkSync(temp, target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = readSetFile(target);
      if (existing.setHash !== setHash) refuse('ACTIVATION_SET_CONFLICT');
      return setHash;
    }
    const dirFd = openSync(dir, 'r'); try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    return setHash;
  } finally { try { unlinkSync(temp); } catch { /* best effort: a leftover temp name is never read as a set */ } }
}

/**
 * Re-derive the expected set from the current archive and the worker's grants, and require exactly that
 * committed record. Used at activation, before execution and at the final send guard.
 */
export function verifyActivationSet(root: string, input: ActivationSetInput): ActivationSetVerification {
  const set = expectedActivationSet(input), setHash = activationSetHash(set);
  const stored = readSetFile(join(directoryOf(root, set.runId, false), `${setHash}.json`));
  // The stored content hashes to the expected set, so its signature policy and its (empty) attestation list are
  // exactly the expected ones; a set carrying any attestation never parses in S1.
  if (stored.setHash !== setHash || activationSetHash(stored.set) !== setHash) refuse('ACTIVATION_SET_CORRUPT');
  return Object.freeze({ setHash, signed: false as const, policy: SIGNATURE_POLICY.version });
}

/** Formal live eligibility needs a verified Human attestation under a signing policy; S1 has neither. */
export function liveEligibility(verification: ActivationSetVerification | null): { eligible: false; reason: string } {
  if (!verification) return { eligible: false, reason: 'ACTIVATION_SET_MISSING' };
  return { eligible: false, reason: 'ACTIVATION_SET_NOT_SIGNED' };
}
