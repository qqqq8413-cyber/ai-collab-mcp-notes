import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync,
  writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
/**
 * M1-B: the one signing policy. Its set is a different set (the policy is set content, so a different setHash) and is
 * live-eligible only with a verified Human passkey attestation over that setHash, kept in its own record (never in
 * the set: `attestations` stays empty, as the S2 preimage contract requires). S1 sets stay ineligible forever.
 */
export const M1_SIGNATURE_POLICY = Object.freeze({ version: 'M1_PASSKEY_RUN_V1', humanSignatureRequired: true });
export type SignaturePolicyVersion = typeof SIGNATURE_POLICY.version | typeof M1_SIGNATURE_POLICY.version;
const policyOf = (version: SignaturePolicyVersion | undefined) => version === M1_SIGNATURE_POLICY.version ? M1_SIGNATURE_POLICY : SIGNATURE_POLICY;
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
  /** M1: the signing policy the set states; S1_UNSIGNED_V0 when absent. */
  signaturePolicy?: SignaturePolicyVersion;
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
    signaturePolicy: { ...policyOf(input.signaturePolicy) }, attestations: [] });
}

/**
 * M1-B: the set that archiving exactly these three documents (each as version 1, none archived yet) will require.
 * Pure; it lets the Human approve the setHash before anything is preserved. After preservation the set is
 * re-derived from the archive by expectedActivationSet, and the two hashes must be equal.
 */
/** A drafted member: the document's identity and body, and the record hash the archive will seal it with (caller-computed). */
export interface ProspectiveMember { kind: string; authorityId: string; version: number; supersedes: unknown; body: unknown; recordHash: string }
export function prospectiveActivationSet(input: { contract: Contract; packet: ImplementationPacket; signaturePolicy: SignaturePolicyVersion;
  documents: readonly [ProspectiveMember, ProspectiveMember, ProspectiveMember] }): { set: ActivationSetV1; setHash: string } {
  const { contract: c, packet } = input, roles = ['IMPLEMENTATION_PACKET', 'LIVE_PROVIDER_MODEL_CALL', 'LIMITED_README_WORKER'] as const;
  const members = input.documents.map((document, i) => {
    if (document.version !== 1 || document.supersedes !== null || document.kind !== (i === 0 ? 'IMPLEMENTATION_PACKET' : 'AUTHORIZATION')) refuse('ACTIVATION_SET_MEMBER_INVALID');
    return { role: roles[i], kind: document.kind, authorityId: document.authorityId, version: 1, recordHash: document.recordHash,
      bodyHash: authorityBodyHash(document.body as JsonObject) };
  });
  if (members[0].bodyHash !== authorityBodyHash(packet as unknown as JsonObject)) refuse('ACTIVATION_SET_MEMBER_INVALID');
  const set = setSchema.parse({ schema: ACTIVATION_SET_SCHEMA, recordClass: 'OPERATIONAL_RECORD', notAuthority: true,
    runId: c.runId, repository: c.repository, sliceId: packet.sliceId, packetId: packet.packetId, packetHash: packetHash(packet), contractHash: hash(c),
    implementationSha: c.implementationSha, workerCodeHash: c.workerCodeHash, members,
    signaturePolicy: { ...policyOf(input.signaturePolicy) }, attestations: [] });
  return { set, setHash: activationSetHash(set) };
}

const runKey = (runId: string) => sha256(`chief-activation-set-run\n${runId}`);
const uid = () => process.getuid?.();
/** A protected directory: a real directory (not a link), owned by this user, no group or other access. */
function assertSafeDirectory(path: string) {
  let st;
  try { st = lstatSync(path); } catch { return refuse('ACTIVATION_SET_MISSING'); }
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077) || (uid() !== undefined && st.uid !== uid())) refuse('ACTIVATION_SET_STORAGE_UNSAFE');
}
function fsyncDirectory(path: string) { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
/**
 * R1: the publisher's directories. Each one is created if missing, checked, and its parent is fsynced every time
 * (not only when this call created it), so a directory entry left unsynced by a publisher that crashed is made
 * durable before anything is committed beneath it.
 */
function ensureSetDirectory(root: string, runId: string): string {
  const base = join(root, 'activation-sets'), dir = join(base, runKey(runId));
  for (const [parent, path] of [[root, base], [base, dir]] as const) {
    try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    assertSafeDirectory(path);
    fsyncDirectory(parent);
  }
  return dir;
}
function existingSetDirectory(root: string, runId: string): string {
  const base = join(root, 'activation-sets'), dir = join(base, runKey(runId));
  assertSafeDirectory(base); assertSafeDirectory(dir);
  return dir;
}
const TEMP_NAME = /^\.[0-9a-f-]{36}\.tmp$/;
/**
 * R1 (Fix 1): the set file itself must be a regular file (opened without following a link and without blocking on a
 * FIFO), owned by this user, mode exactly 0600, at most 64KB. Its only other names may be this publisher's own
 * temp names in the same protected directory (the link(2) window); any other hard link fails closed.
 */
function readSetFile(path: string): z.infer<typeof fileSchema> {
  let fd: number | undefined;
  try {
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return refuse('ACTIVATION_SET_MISSING');
      return refuse(code === 'ELOOP' || code === 'EMLINK' ? 'ACTIVATION_SET_FILE_UNSAFE' : 'ACTIVATION_SET_CORRUPT');
    }
    const st = fstatSync(fd);
    if (!st.isFile() || (st.mode & 0o7777) !== 0o600 || (uid() !== undefined && st.uid !== uid())) return refuse('ACTIVATION_SET_FILE_UNSAFE');
    if (st.nlink !== 1) {
      const dir = dirname(path), aliases = readdirSync(dir).filter((name) => {
        try { const other = lstatSync(join(dir, name)); return other.ino === st.ino && other.dev === st.dev; } catch { return false; }
      });
      const unsafe = aliases.some((name) => join(dir, name) !== path && !TEMP_NAME.test(name));
      if (unsafe || fstatSync(fd).nlink > aliases.length) return refuse('ACTIVATION_SET_FILE_UNSAFE');
    }
    if (st.size > 64 * 1024) return refuse('ACTIVATION_SET_CORRUPT');
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(fd, 'utf8')));
    if (!parsed.success || activationSetHash(parsed.data.set) !== parsed.data.setHash) return refuse('ACTIVATION_SET_CORRUPT');
    return parsed.data;
  } catch (error) {
    if (error instanceof ActivationSetError) throw error;
    return refuse('ACTIVATION_SET_CORRUPT');
  } finally { if (fd !== undefined) closeSync(fd); }
}

/**
 * Publish the expected set after all three members are durably archived and verified. Order (R1, Fix 2):
 * directories created or checked with each parent fsynced; private temp (0600) written and fsynced; one exclusive
 * link(2); on EEXIST the existing file must pass every check and carry the same hash, and is then fsynced itself;
 * the temp name is removed; the set's directory is fsynced. Only then does it return, on both the new and the
 * idempotent path, so the caller (activation) moves the Controller only after these durability steps.
 * What fsync guarantees depends on the platform (see AUTO_P2_A4_P0_S1_R1_ARCHITECT_REVIEW.md); nothing here
 * claims durability across a real power cut.
 */
export function publishActivationSet(root: string, input: ActivationSetInput): string {
  const set = expectedActivationSet(input), setHash = activationSetHash(set);
  const dir = ensureSetDirectory(root, set.runId), target = join(dir, `${setHash}.json`);
  const temp = join(dir, `.${randomUUID()}.tmp`);
  const fd = openSync(temp, 'wx', 0o600);
  try { fchmodSync(fd, 0o600); writeFileSync(fd, JSON.stringify({ set, setHash })); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    try { linkSync(temp, target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (readSetFile(target).setHash !== setHash) refuse('ACTIVATION_SET_CONFLICT');
      // Idempotent path: the earlier publisher may have died before its directory fsync; make this commit durable now.
      const existing = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try { fsyncSync(existing); } finally { closeSync(existing); }
    }
  } finally { try { unlinkSync(temp); } catch { /* already gone: a leftover temp name is never read as a set */ } }
  fsyncDirectory(dir);
  return setHash;
}

/**
 * Re-derive the expected set from the current archive and the worker's grants, and require exactly that
 * committed record. Used at activation, before execution and at the final send guard.
 */
export function verifyActivationSet(root: string, input: ActivationSetInput): ActivationSetVerification {
  const set = expectedActivationSet(input), setHash = activationSetHash(set);
  const stored = readSetFile(join(existingSetDirectory(root, set.runId), `${setHash}.json`));
  // The stored content hashes to the expected set, so its signature policy and its (empty) attestation list are
  // exactly the expected ones; a set carrying any attestation never parses in S1.
  if (stored.setHash !== setHash || activationSetHash(stored.set) !== setHash) refuse('ACTIVATION_SET_CORRUPT');
  return Object.freeze({ setHash, signed: false as const, policy: set.signaturePolicy.version });
}

/**
 * Formal live eligibility needs a verified Human attestation under a signing policy. An S1 set is never eligible,
 * whatever the caller claims. An M1 set is eligible only when `attestation(setHash)` (the trusted Host's verifier:
 * pinned passkey, re-derived payload, time window) returns without throwing.
 */
export function liveEligibility(verification: ActivationSetVerification | null, attestation?: (setHash: string) => void):
  { eligible: boolean; reason: string | null } {
  if (!verification) return { eligible: false, reason: 'ACTIVATION_SET_MISSING' };
  if (verification.policy !== M1_SIGNATURE_POLICY.version) return { eligible: false, reason: 'ACTIVATION_SET_NOT_SIGNED' };
  if (!attestation) return { eligible: false, reason: 'ACTIVATION_ATTESTATION_MISSING' };
  try { attestation(verification.setHash); return { eligible: true, reason: null }; }
  catch (error) { return { eligible: false, reason: error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : 'ACTIVATION_ATTESTATION_INVALID' }; }
}
