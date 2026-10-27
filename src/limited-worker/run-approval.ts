import { createHash, createPublicKey, randomUUID, verify as verifySignature, type KeyObject } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { MODEL, assertLiveRequestBound, canonical, contractOf, hash, maximumCost, packetFor, requestBound, type Contract } from './contract.js';
import { M1_SIGNATURE_POLICY } from './activation-set.js';
import { CLASS_DELEGATION_RULE, isAuthorityPrincipalRef, type ClassDelegationVerifier, type ClassDerivationV1 } from './governance.js';
import type { ImplementationPacket } from '../automation/types.js';

// M1-B: the minimum short-lived, single-run Human authorization for the trusted Host.
//
// The Human's authorization source is a passkey (WebAuthn, ES256, user verification required: Touch ID or the
// device PIN), never a principal string a browser sends. Its public key is pinned in a separate approver
// configuration that the Human writes; for a live Host that file must be owned by root, so an AI tool running as the
// Human's own account cannot replace the key (`AI 工具不可寫`, S2 preimage contract item 3). For one prepared run the
// Host derives the exact payload below (the S2 preimage fields plus the class, agent, model, request bound and the
// approved reservation), shows it in the Workspace, and asks the browser to sign
//   challenge = SHA-256("CHIEF-ACTIVATION-ATTESTATION-V1\n" + canonical(payload)).
// The Host verifies the assertion against the pinned key, origin and RP ID, consumes it once (an exclusive record
// file), and only then preserves the run's three documents. The record is kept apart from the ACTIVATION_SET, and
// every later check (activation, before execution, the final send guard) re-verifies it against the set it names.
//
// What this does not do: no key is created, imported or read here; nothing signs on the Human's behalf; revocation
// (D2) and a separate signer account (D1) are later work. A same-account process that can start its own Host with
// its own root-owned file and the Human's credential is outside what any same-account check can stop.

export const APPROVAL_DOMAIN = 'CHIEF-ACTIVATION-ATTESTATION-V1\n';
export const ATTESTATION_SCHEMA = 'chief-activation-attestation.v1';
export const MAX_APPROVAL_SECONDS = 900;
const HEX = /^[a-f0-9]{64}$/, SHA = /^[a-f0-9]{40}$/, B64U = /^[A-Za-z0-9_-]{1,8192}$/;
const instant = z.iso.datetime();
const fail = (code: string): never => { throw new Error(code); };
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest();
export const fromBase64Url = (value: unknown, code = 'PASSKEY_ENCODING_INVALID'): Buffer => {
  if (typeof value !== 'string' || !B64U.test(value)) return fail(code);
  return Buffer.from(value, 'base64url');
};

// ------------------------------------------------------------------------------------------------ standing class acceptance
// M1-R1 (R-1). Three different things, never confused:
//   1. ARCHITECT_CLASS_ACCEPTANCE (this record): the Architect accepted one fixed Worker class (WORKER_CLASS_SCHEMA,
//      its hash) for one exact implementation SHA. Stated by its source (the Architect's review decision: a reference
//      and the SHA-256 of the decision text the Human received) and versioned (acceptanceVersion, supersedes). The
//      Human pins it in the root-owned approver file; its hash (acceptanceHashOf, domain separated) is what every
//      derived record and every per-run passkey payload names. It is not run authority and authorizes no run.
//   2. CLASS_DERIVED_AUTHORITY: the one run packet the trusted Host derives from that class (packetFor), archived with
//      a `derivation` naming the acceptance hash, class hash and SHA. It is not the Architect's direct authority.
//   3. DIRECT_AUTHORITY: a document the Architect (or the Human) issued directly. Unchanged.
// A derived packet is accepted only by classDelegationVerifier below (the explicit ARCHITECT_CLASS_DELEGATION_V1 rule);
// a configured architectPrincipalRef alone never makes a Host-derived packet the Architect's.
export const CLASS_ACCEPTANCE_SCHEMA = 'chief-architect-class-acceptance.v1';
export const CLASS_ACCEPTANCE_DOMAIN = 'CHIEF-ARCHITECT-CLASS-ACCEPTANCE-V1\n';
export const WORKER_CLASS_SCHEMA = 'chief-limited-worker-class.v1';
const principal = z.string().min(1).max(200).refine(isAuthorityPrincipalRef);
export const acceptanceSchema = z.strictObject({ schema: z.literal(CLASS_ACCEPTANCE_SCHEMA), recordClass: z.literal('ARCHITECT_CLASS_ACCEPTANCE'),
  delegationRule: z.literal(CLASS_DELEGATION_RULE), architectPrincipalRef: principal, agentId: z.literal('limited-readme-worker'),
  classSchema: z.literal(WORKER_CLASS_SCHEMA), classHash: z.string().regex(HEX), implementationSha: z.string().regex(SHA),
  acceptanceVersion: z.number().int().min(1).max(1000), supersedes: z.string().regex(HEX).nullable(),
  source: z.strictObject({ kind: z.literal('ARCHITECT_REVIEW_DECISION'), reviewRef: z.string().min(1).max(200), decisionSha256: z.string().regex(HEX) }),
  acceptedAt: instant }).refine((a) => (a.acceptanceVersion === 1) === (a.supersedes === null), { message: 'ACCEPTANCE_VERSION_CHAIN' });
export type ClassAcceptanceV1 = z.infer<typeof acceptanceSchema>;
/** The standing acceptance's identity: SHA-256("CHIEF-ARCHITECT-CLASS-ACCEPTANCE-V1\n" + canonical(record)). */
export const acceptanceHashOf = (acceptance: ClassAcceptanceV1): string => {
  const parsed = acceptanceSchema.safeParse(acceptance);
  if (!parsed.success) return fail('CLASS_ACCEPTANCE_INVALID');
  return sha256(CLASS_ACCEPTANCE_DOMAIN + canonical(parsed.data)).toString('hex');
};

// ------------------------------------------------------------------------------------------------ approver config
const approverSchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('CHIEF_LIVE_RUN_APPROVER'),
  policy: z.literal(M1_SIGNATURE_POLICY.version), humanPrincipalRef: z.string().min(1).max(200),
  passkey: z.strictObject({ rpId: z.literal('localhost'), origins: z.array(z.string().regex(/^http:\/\/localhost:[1-9][0-9]{0,4}$/)).min(1).max(4),
    credentialId: z.string().regex(B64U), publicKeySpki: z.string().regex(/^[A-Za-z0-9+/=]{40,400}$/), algorithm: z.literal('ES256') }),
  architectAcceptance: acceptanceSchema,
  approvalValiditySeconds: z.number().int().min(60).max(MAX_APPROVAL_SECONDS) });
export type ApproverConfigV1 = z.infer<typeof approverSchema>;
export interface Approver extends ApproverConfigV1 {
  readonly keyId: string; readonly publicKey: KeyObject; readonly protection: 'ROOT_OWNED' | 'SAME_ACCOUNT_OWNED';
  /** M1-R1: the pinned standing acceptance's hash. */
  readonly acceptanceHash: string;
}

/** An ES256 (P-256) SubjectPublicKeyInfo, and nothing else (a private key or another curve is refused). */
export function passkeyPublicKey(spkiBase64: string): KeyObject {
  let key: KeyObject;
  try { key = createPublicKey({ key: Buffer.from(spkiBase64, 'base64'), format: 'der', type: 'spki' }); } catch { return fail('APPROVER_KEY_INVALID'); }
  if (key.type !== 'public' || key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return fail('APPROVER_KEY_INVALID');
  return key;
}
export const keyIdOf = (spkiBase64: string) => createHash('sha256').update(Buffer.from(spkiBase64, 'base64')).digest('hex');

/**
 * A protected file: opened without following a link or blocking, a regular file of at most `maxBytes`, owned by one
 * of `owners`, not writable by group or others (and for records: exactly `mode`).
 */
function readProtected(path: string, options: { maxBytes: number; owners: readonly number[]; mode?: number; code: string }): { data: Buffer; uid: number } {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || !options.owners.includes(st.uid) || (st.mode & 0o022) || (options.mode !== undefined && (st.mode & 0o7777) !== options.mode) ||
      st.size > options.maxBytes) throw new Error(options.code);
    const data = readFileSync(fd);
    if (data.length > options.maxBytes) throw new Error(options.code);
    return { data, uid: st.uid };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(options.code === 'APPROVAL_RECORD_UNSAFE' ? 'APPROVAL_RECORD_MISSING' : 'APPROVER_CONFIG_MISSING');
    throw new Error(options.code);
  } finally { if (fd !== undefined) closeSync(fd); }
}

/**
 * The trusted Host's approver configuration. `owners` are the uids allowed to own the file: the live Host passes
 * only root (0); tests pass their own uid and are reported as SAME_ACCOUNT_OWNED.
 */
export function loadApprover(path: string, owners: readonly number[] = [0]): Approver {
  const { data, uid } = readProtected(path, { maxBytes: 65536, owners, code: 'APPROVER_CONFIG_UNSAFE' });
  let parsed: ApproverConfigV1;
  try { parsed = approverSchema.parse(JSON.parse(data.toString('utf8'))); } catch { return fail('APPROVER_CONFIG_INVALID'); }
  const publicKey = passkeyPublicKey(parsed.passkey.publicKeySpki);
  return Object.freeze({ ...structuredClone(parsed), keyId: keyIdOf(parsed.passkey.publicKeySpki), publicKey, protection: uid === 0 ? 'ROOT_OWNED' as const : 'SAME_ACCOUNT_OWNED' as const,
    acceptanceHash: acceptanceHashOf(parsed.architectAcceptance) });
}

// ------------------------------------------------------------------------------------------------ the worker class
/**
 * The Architect-accepted class of a contract: everything except what one run fills in (project, goal, run, output
 * and storage identity, the quote's time window and source snapshot hash, and the implementation, which the approver
 * configuration pins separately). Accepting the class once, for an exact implementation SHA, replaces a per-run
 * Architect packet; the Host derives each run's packet from the contract with the existing packetFor.
 */
export function workerClass(c: Contract) {
  const template = packetFor(c, 'chief-limited-worker-class') as unknown as Record<string, unknown>;
  const { packetId: _id, sliceId: _slice, objective: _objective, expectedBaseSha: _base, ...packetTemplate } = template;
  return { schema: WORKER_CLASS_SCHEMA, kind: c.kind, repository: c.repository, sourceSha: c.sourceSha, sourcePath: c.sourcePath,
    sourceHash: c.sourceHash, sourceBytes: c.sourceBytes, agentId: c.agentId, provider: c.provider, model: c.model, apiVersion: c.apiVersion,
    tools: [...c.tools], maxInputTokens: c.maxInputTokens, maxOutputTokens: c.maxOutputTokens, maxCalls: c.maxCalls, maxRetries: c.maxRetries,
    maxTurns: c.maxTurns ?? null, maxCostMicroUsd: c.maxCostMicroUsd, totalCostMicroUsd: c.totalCostMicroUsd, timeoutSeconds: c.timeoutSeconds,
    price: { model: c.quote.model, apiVersion: c.quote.apiVersion, sourceUrl: c.quote.sourceUrl, inputMicroUsdPerToken: c.quote.inputMicroUsdPerToken,
      outputMicroUsdPerToken: c.quote.outputMicroUsdPerToken, maxInputTokens: c.quote.maxInputTokens, maxOutputTokens: c.quote.maxOutputTokens },
    inputPolicy: c.inputPolicy ?? null, requestBound: requestBound(c), reservationMicroUsd: maximumCost(c), packetTemplate };
}
export const workerClassHash = (c: Contract) => hash(workerClass(c));

/** M1-R1: what a run packet derived under this approver's pinned acceptance states about its derivation. */
export const derivationOf = (approver: Pick<Approver, 'architectAcceptance' | 'acceptanceHash'>): ClassDerivationV1 => ({ rule: CLASS_DELEGATION_RULE,
  derivedBy: 'CHIEF_TRUSTED_HOST', acceptanceHash: approver.acceptanceHash, classHash: approver.architectAcceptance.classHash,
  implementationSha: approver.architectAcceptance.implementationSha });

/**
 * M1-R1: the explicit class-delegation rule (ARCHITECT_CLASS_DELEGATION_V1). A CLASS_DERIVED_AUTHORITY packet is admitted
 * only when it is version 1, states the accepting Architect principal as its issuer (the delegator, not the author),
 * names exactly the pinned acceptance (hash, class, SHA), and its packet is exactly packetFor(its own contract) for an
 * accepted class at the accepted SHA with a proven one-request bound. Anything else throws; nothing is repaired.
 */
export function classDelegationVerifier(approver: Pick<Approver, 'architectAcceptance' | 'acceptanceHash'>): ClassDelegationVerifier {
  const a = approver.architectAcceptance, pinned = approver.acceptanceHash;
  if (acceptanceHashOf(a) !== pinned) return fail('CLASS_ACCEPTANCE_HASH_MISMATCH');
  return (record, packet: ImplementationPacket) => {
    const d = record.derivation;
    if (record.version !== 1 || record.issuer.role !== 'GPT_ARCHITECT' || record.issuer.principalRef !== a.architectPrincipalRef) fail('DELEGATION_ISSUER_MISMATCH');
    if (!d || d.rule !== CLASS_DELEGATION_RULE || d.derivedBy !== 'CHIEF_TRUSTED_HOST' || d.acceptanceHash !== pinned) fail('DELEGATION_ACCEPTANCE_MISMATCH');
    // contractOf refuses any packet that is not exactly packetFor(its own contract): nothing but the derivation is accepted.
    let c: Contract;
    try { c = contractOf(packet); } catch { return fail('DELEGATION_PACKET_NOT_DERIVED'); }
    if (c.agentId !== a.agentId) fail('WORKER_CLASS_NOT_ACCEPTED');
    assertLiveRequestBound(c);
    if (d.classHash !== a.classHash || workerClassHash(c) !== a.classHash) fail('WORKER_CLASS_NOT_ACCEPTED');
    if (d.implementationSha !== a.implementationSha || c.implementationSha !== a.implementationSha) fail('IMPLEMENTATION_NOT_ACCEPTED');
  };
}

// ------------------------------------------------------------------------------------------------ the payload
const grantRefSchema = z.strictObject({ operation: z.enum(['LIMITED_README_WORKER', 'LIVE_PROVIDER_MODEL_CALL']), authorityId: z.string().min(1).max(128),
  version: z.literal(1), recordHash: z.string().regex(HEX) });
export const payloadSchema = z.strictObject({ payloadSchema: z.literal(ATTESTATION_SCHEMA), policyVersion: z.literal(M1_SIGNATURE_POLICY.version),
  setHash: z.string().regex(HEX), runId: z.string().min(1).max(200), repository: z.string().min(1).max(200), contractHash: z.string().regex(HEX),
  packetId: z.string().min(1).max(128), packetHash: z.string().regex(HEX),
  // M1-R1: the signed run names the derived packet record (with its derivation) and the standing acceptance it derives from.
  packetRecordClass: z.literal('CLASS_DERIVED_AUTHORITY'), packetRecordHash: z.string().regex(HEX), acceptanceHash: z.string().regex(HEX),
  implementationSha: z.string().regex(SHA), workerCodeHash: z.string().regex(HEX),
  operations: z.tuple([z.literal('LIMITED_README_WORKER'), z.literal('LIVE_PROVIDER_MODEL_CALL')]),
  grants: z.tuple([grantRefSchema, grantRefSchema]), classHash: z.string().regex(HEX), agentId: z.literal('limited-readme-worker'), model: z.literal(MODEL),
  maxModelRequests: z.literal(1), maxRetries: z.literal(0), approvedMaxReservationMicroUsd: z.number().int().min(1).max(1000000),
  signerKeyId: z.string().regex(HEX), rpId: z.literal('localhost'), issuedAt: instant, expiresAt: instant, nonce: z.string().uuid() });
export type ApprovalPayloadV1 = z.infer<typeof payloadSchema>;
export const parsePayload = (value: unknown): ApprovalPayloadV1 => {
  const parsed = payloadSchema.safeParse(value);
  if (!parsed.success || parsed.data.grants[0].operation !== 'LIMITED_README_WORKER' || parsed.data.grants[1].operation !== 'LIVE_PROVIDER_MODEL_CALL') return fail('APPROVAL_PAYLOAD_INVALID');
  const issued = Date.parse(parsed.data.issuedAt), expires = Date.parse(parsed.data.expiresAt);
  if (!(expires > issued) || expires - issued > MAX_APPROVAL_SECONDS * 1000) return fail('APPROVAL_PAYLOAD_INVALID');
  return parsed.data;
};
/** The 32 bytes the passkey signs over (as the WebAuthn challenge). */
export const challengeOf = (payload: ApprovalPayloadV1): Buffer => sha256(APPROVAL_DOMAIN + canonical(payload));
/** A fresh time window and nonce for one approval request; never longer than the approver's validity or the quote. */
export function approvalWindow(approver: Pick<Approver, 'approvalValiditySeconds'>, c: Contract, now: string) {
  const at = Date.parse(now), expires = Math.min(at + approver.approvalValiditySeconds * 1000, Date.parse(c.quote.validUntil));
  if (!Number.isFinite(at) || expires - at < 60_000) return fail('APPROVAL_WINDOW_TOO_SHORT');
  return { issuedAt: new Date(at).toISOString(), expiresAt: new Date(expires).toISOString(), nonce: randomUUID() };
}

// ------------------------------------------------------------------------------------------------ WebAuthn
export interface PasskeyAssertion { credentialId: string; authenticatorData: string; clientDataJSON: string; signature: string }
export const assertionSchema = z.strictObject({ credentialId: z.string().regex(B64U), authenticatorData: z.string().regex(B64U),
  clientDataJSON: z.string().regex(B64U), signature: z.string().regex(B64U) });
const FLAG_UP = 0x01, FLAG_UV = 0x04, FLAG_AT = 0x40;
function clientData(raw: Buffer, type: 'webauthn.get' | 'webauthn.create', challenge: Buffer, origins: readonly string[]) {
  let data: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try { data = JSON.parse(raw.toString('utf8')); } catch { return fail('PASSKEY_CLIENT_DATA_INVALID'); }
  if (data.type !== type) return fail('PASSKEY_CLIENT_DATA_TYPE');
  if (data.challenge !== challenge.toString('base64url')) return fail('PASSKEY_CHALLENGE_MISMATCH');
  if (typeof data.origin !== 'string' || !origins.includes(data.origin)) return fail('PASSKEY_ORIGIN_MISMATCH');
  if (data.crossOrigin === true) return fail('PASSKEY_CROSS_ORIGIN');
}
function authenticatorFlags(authData: Buffer, rpId: string) {
  if (authData.length < 37) return fail('PASSKEY_AUTHENTICATOR_DATA_INVALID');
  if (!authData.subarray(0, 32).equals(sha256(rpId))) return fail('PASSKEY_RP_ID_MISMATCH');
  const flags = authData[32];
  if (!(flags & FLAG_UP)) return fail('PASSKEY_USER_NOT_PRESENT');
  if (!(flags & FLAG_UV)) return fail('PASSKEY_USER_NOT_VERIFIED');
  return { flags, signCount: authData.readUInt32BE(33) };
}

/**
 * Verify one WebAuthn assertion: the pinned credential, `webauthn.get` client data carrying exactly this challenge
 * from an allowed origin, the RP ID hash, user presence and user verification, and an ES256 signature by the pinned
 * key over authenticatorData || SHA-256(clientDataJSON).
 */
export function verifyAssertion(approver: Pick<Approver, 'passkey' | 'publicKey'>, input: unknown, challenge: Buffer) {
  const parsed = assertionSchema.safeParse(input);
  if (!parsed.success) return fail('PASSKEY_ASSERTION_INVALID');
  const a = parsed.data;
  if (a.credentialId !== approver.passkey.credentialId) return fail('PASSKEY_CREDENTIAL_MISMATCH');
  const client = fromBase64Url(a.clientDataJSON), authData = fromBase64Url(a.authenticatorData), signature = fromBase64Url(a.signature);
  clientData(client, 'webauthn.get', challenge, approver.passkey.origins);
  const { flags, signCount } = authenticatorFlags(authData, approver.passkey.rpId);
  let valid = false;
  try { valid = verifySignature('sha256', Buffer.concat([authData, sha256(client)]), { key: approver.publicKey, dsaEncoding: 'der' }, signature); } catch { valid = false; }
  if (!valid) return fail('PASSKEY_SIGNATURE_INVALID');
  return { flags, signCount, assertionHash: hash(canonical(a)) };
}

/** Minimal CBOR (RFC 8949) for a COSE_Key: maps, integers, byte and text strings. */
function cbor(data: Buffer, start = 0): { value: unknown; end: number } {
  if (start >= data.length) return fail('PASSKEY_COSE_KEY_INVALID');
  const head = data[start], major = head >> 5, info = head & 0x1f;
  let length: number, at = start + 1;
  if (info < 24) length = info;
  else if (info === 24) { length = data[at]; at += 1; }
  else if (info === 25) { length = data.readUInt16BE(at); at += 2; }
  else return fail('PASSKEY_COSE_KEY_INVALID');
  if (major === 0) return { value: length, end: at };
  if (major === 1) return { value: -1 - length, end: at };
  if (major === 2 || major === 3) {
    if (at + length > data.length) return fail('PASSKEY_COSE_KEY_INVALID');
    const bytes = data.subarray(at, at + length);
    return { value: major === 2 ? Buffer.from(bytes) : bytes.toString('utf8'), end: at + length };
  }
  if (major === 5) {
    const map = new Map<unknown, unknown>();
    for (let i = 0; i < length; i++) { const k = cbor(data, at); const v = cbor(data, k.end); map.set(k.value, v.value); at = v.end; }
    return { value: map, end: at };
  }
  return fail('PASSKEY_COSE_KEY_INVALID');
}

/**
 * Verify a passkey registration (`webauthn.create`, made with user verification) and that the public key the
 * browser reports is the credential's own COSE key. Returns the approver's passkey section. Used only by the
 * one-time enrollment tool; registering a key grants nothing until the Human pins it in a root-owned file.
 */
export function verifyRegistration(input: { credentialId: unknown; clientDataJSON: unknown; authenticatorData: unknown; publicKeySpki: unknown; algorithm: unknown },
  expected: { challenge: Buffer; rpId: 'localhost'; origins: readonly string[] }) {
  if (input.algorithm !== -7 || typeof input.publicKeySpki !== 'string') return fail('PASSKEY_ALGORITHM_UNSUPPORTED');
  const credentialId = fromBase64Url(input.credentialId), client = fromBase64Url(input.clientDataJSON), authData = fromBase64Url(input.authenticatorData);
  clientData(client, 'webauthn.create', expected.challenge, expected.origins);
  const { flags } = authenticatorFlags(authData, expected.rpId);
  if (!(flags & FLAG_AT) || authData.length < 55) return fail('PASSKEY_ATTESTED_DATA_MISSING');
  const idLength = authData.readUInt16BE(53), id = authData.subarray(55, 55 + idLength);
  if (!id.equals(credentialId)) return fail('PASSKEY_CREDENTIAL_MISMATCH');
  const cose = cbor(authData, 55 + idLength).value as Map<number, unknown>;
  if (!(cose instanceof Map) || cose.get(1) !== 2 || cose.get(3) !== -7 || cose.get(-1) !== 1) return fail('PASSKEY_ALGORITHM_UNSUPPORTED');
  const spki = fromBase64Url(input.publicKeySpki).toString('base64');
  const jwk = passkeyPublicKey(spki).export({ format: 'jwk' }) as { x?: string; y?: string };
  if (jwk.x !== (cose.get(-2) as Buffer | undefined)?.toString('base64url') || jwk.y !== (cose.get(-3) as Buffer | undefined)?.toString('base64url')) return fail('PASSKEY_PUBLIC_KEY_MISMATCH');
  return { rpId: expected.rpId, credentialId: credentialId.toString('base64url'), publicKeySpki: spki, algorithm: 'ES256' as const, keyId: keyIdOf(spki) };
}

// ------------------------------------------------------------------------------------------------ the record
const recordSchema = z.strictObject({ schema: z.literal(ATTESTATION_SCHEMA), recordClass: z.literal('HUMAN_PASSKEY_ATTESTATION'),
  jobId: z.string().regex(HEX), payload: z.unknown().transform(parsePayload), challenge: z.string().regex(B64U), assertion: assertionSchema,
  assertionHash: z.string().regex(HEX), keyId: z.string().regex(HEX), signCount: z.number().int().nonnegative(), verifiedAt: instant });
export type ApprovalRecordV1 = z.infer<typeof recordSchema>;
const recordPath = (root: string, jobId: string) => join(root, 'm1-approvals', `${jobId}.json`);
function fsyncPath(path: string) { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }

/** Consume one verified approval: an exclusive 0600 file per job, so a second use of any approval fails closed. */
export function writeApprovalRecord(root: string, record: Omit<ApprovalRecordV1, 'schema' | 'recordClass'>): void {
  const full = recordSchema.parse({ schema: ATTESTATION_SCHEMA, recordClass: 'HUMAN_PASSKEY_ATTESTATION', ...record });
  const dir = join(root, 'm1-approvals');
  try { mkdirSync(dir, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const st = lstatSync(dir);
  if (!st.isDirectory() || (st.mode & 0o077) || st.uid !== process.getuid?.()) fail('APPROVAL_RECORD_UNSAFE');
  fsyncPath(root);
  let fd: number;
  try { fd = openSync(recordPath(root, record.jobId), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) { return fail((error as NodeJS.ErrnoException).code === 'EEXIST' ? 'APPROVAL_ALREADY_USED' : 'APPROVAL_RECORD_UNSAFE'); }
  try { writeFileSync(fd, JSON.stringify(full)); fsyncSync(fd); } finally { closeSync(fd); }
  fsyncPath(dir);
}
export function readApprovalRecord(root: string, jobId: string): ApprovalRecordV1 {
  const uid = process.getuid?.();
  const { data } = readProtected(recordPath(root, jobId), { maxBytes: 65536, owners: uid === undefined ? [] : [uid], mode: 0o600, code: 'APPROVAL_RECORD_UNSAFE' });
  let record: ApprovalRecordV1;
  try { record = recordSchema.parse(JSON.parse(data.toString('utf8'))); } catch { return fail('APPROVAL_RECORD_CORRUPT'); }
  // M1-R1: a record copied under another job's name is not that job's approval.
  if (record.jobId !== jobId) return fail('APPROVAL_RECORD_CORRUPT');
  return record;
}

/**
 * The verifier the trusted worker calls for an M1 set: the consumed record of this job names this setHash and this
 * contract, its payload re-hashes to the signed challenge, the pinned key verifies the assertion again, and the
 * approval window is still open.
 */
export function attestationVerifier(root: string, approver: Pick<Approver, 'passkey' | 'publicKey' | 'keyId' | 'acceptanceHash'>, now: () => string) {
  return (c: Contract, setHash: string): void => {
    const record = readApprovalRecord(root, hash(c)), p = record.payload;
    if (p.setHash !== setHash || p.contractHash !== hash(c) || p.runId !== c.runId || p.signerKeyId !== approver.keyId || record.keyId !== approver.keyId ||
      p.acceptanceHash !== approver.acceptanceHash) fail('ATTESTATION_BINDING_MISMATCH');
    const challenge = challengeOf(p);
    if (record.challenge !== challenge.toString('base64url')) fail('ATTESTATION_BINDING_MISMATCH');
    verifyAssertion(approver, record.assertion, challenge);
    const at = Date.parse(now());
    if (!Number.isFinite(at) || at < Date.parse(p.issuedAt) || at >= Date.parse(p.expiresAt)) fail('ATTESTATION_EXPIRED');
  };
}
