import { createHash, createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../automation/invocation-journal.js';
import { isInstant } from '../automation/time.js';
import { REPOSITORY_PATTERN } from '../automation/admission.js';
import { GOAL_ID, PROJECT_ID } from '../identity/canonical.js';

// EXE-C4: a separate, offline Human signature proves that the pinned key holder
// approved precisely this Goal, ROOT Run, Change and complete authority bundle.
// This attestation is NOT a DIRECT_AUTHORITY document; AP1/LD1 still validate
// the packet, individual grants, budgets, provenance and Controller occurrence.
const hash = (input: string) => createHash('sha256').update(input, 'utf8').digest('hex');
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const HEX = /^[a-f0-9]{64}$/;
const principal = z.string().min(1).max(256).refine((x) => x.trim() === x && !/[\u0000-\u001f\u007f]/.test(x));
const instant = z.string().refine(isInstant);
const payloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  purpose: z.literal('CHIEF_EXE_C4_HUMAN_APPROVAL'),
  projectId: z.string().regex(PROJECT_ID),
  goalId: z.string().regex(GOAL_ID),
  repository: z.string().regex(REPOSITORY_PATTERN),
  changeKey: z.string().min(1).max(256),
  runId: z.string().regex(RUN_ID),
  humanPrincipalRef: principal,
  issuedAt: instant,
  expiresAt: instant,
  bundleSha256: z.string().regex(HEX),
});
const approvalSchema = z.strictObject({
  payload: payloadSchema,
  signatureBase64: z.string().min(1).max(128),
});
export type HumanApprovalPayloadV1 = Readonly<z.infer<typeof payloadSchema>>;
export type ConfiguredHumanApproval = Readonly<z.infer<typeof approvalSchema>>;
export interface ApprovedRunIdentity {
  projectId: string; goalId: string; repository: string; changeKey: string;
  runId: string; humanPrincipalRef: string;
}
export interface VerifiedHumanApproval {
  readonly payload: HumanApprovalPayloadV1;
  readonly bundleSha256: string;
  readonly keyFingerprint: string;
}
/** Transport-independent bundle shape: schema enforcement belongs to AP1. */
type ApprovalBundle = { implementationPacket: unknown; liveCallAuthorizations: readonly unknown[] };

const DOMAIN = 'CHIEF-EXE-C4-HUMAN-APPROVAL-V1\n';
/** Published signing input for an OUT-OF-PROCESS signer. The Host never holds a private key. */
export function approvalSigningBytes(payload: HumanApprovalPayloadV1): Buffer {
  return Buffer.from(DOMAIN + canonicalJson(payload), 'utf8');
}

export function authorityBundleSha256(bundle: ApprovalBundle): string {
  return hash(canonicalJson(bundle));
}

/** Fail closed during Host startup, before any live or write-capable actor exists. */
export function verifyOfflineHumanApproval(
  untrusted: unknown,
  pinnedPublicKeyPem: string,
  bundle: ApprovalBundle,
): VerifiedHumanApproval {
  const approval = approvalSchema.parse(untrusted);
  const payload = approval.payload;
  if (payload.bundleSha256 !== authorityBundleSha256(bundle)) throw new Error('HUMAN_APPROVAL_BUNDLE_MISMATCH');
  const issued = Date.parse(payload.issuedAt), expires = Date.parse(payload.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued ||
      expires - issued > 7 * 86400_000) throw new Error('HUMAN_APPROVAL_WINDOW_INVALID');
  const sig = Buffer.from(approval.signatureBase64, 'base64');
  if (sig.length !== 64 || sig.toString('base64') !== approval.signatureBase64) {
    throw new Error('HUMAN_APPROVAL_SIGNATURE_INVALID');
  }
  const key = createPublicKey(pinnedPublicKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('HUMAN_APPROVAL_KEY_NOT_ED25519');
  if (!verify(null, approvalSigningBytes(payload), key, sig)) throw new Error('HUMAN_APPROVAL_SIGNATURE_INVALID');
  const keyFingerprint = hash(key.export({ type: 'spki', format: 'der' }).toString('base64'));
  return Object.freeze({ payload: Object.freeze({ ...payload }), bundleSha256: payload.bundleSha256, keyFingerprint });
}

/** Recheck time, exact ROOT and bundle at every inspection AND dispatch boundary. */
export function humanApprovalMatches(
  approved: VerifiedHumanApproval | undefined, identity: ApprovedRunIdentity,
  bundle: ApprovalBundle,
  now = Date.now(),
): boolean {
  if (!approved || !Number.isFinite(now)) return false;
  const p = approved.payload;
  return now >= Date.parse(p.issuedAt) && now < Date.parse(p.expiresAt) &&
    p.projectId === identity.projectId && p.goalId === identity.goalId &&
    p.repository === identity.repository && p.changeKey === identity.changeKey &&
    p.runId === identity.runId && p.humanPrincipalRef === identity.humanPrincipalRef &&
    p.bundleSha256 === authorityBundleSha256(bundle);
}
