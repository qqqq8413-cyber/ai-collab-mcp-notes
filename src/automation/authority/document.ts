import { createHash } from 'node:crypto';
import { z } from 'zod';
import { REPOSITORY_PATTERN, SLICE_ID_PATTERN } from '../admission.js';
import { canonicalJson } from '../invocation-journal.js';
import { parseAcceptanceDecision } from '../lifecycle.js';
import { parseCorrection, tryParsePacket } from '../packet.js';
import { parseAuthorization } from '../policy.js';
import { isInstant } from '../time.js';

// CHIEF direct authority (G1-R4P-1). An AuthorityDocumentV1 preserves one direct
// authority document: an implementation packet, a correction packet, an acceptance
// decision or an authorization. The archive preserves authority; it does not create
// it, authenticate anyone, or authorize execution by itself.
//
// Each body is validated by the repository's own canonical parser for its kind and
// must already be in that parser's canonical form: the archive never rewrites
// authority. The document's own identifier is its authorityId (packetId,
// correctionPacketId, reviewId, authorizationId), so one document cannot be filed
// under two identities. `version` counts revisions of that one document in the archive;
// it is not the packet's run-scoped packetVersion, which stays in the body untouched.
//
// bodyHash and recordHash are integrity data: they detect corruption and accidental
// change. They are not a signature, not Human authentication and not proof of who
// wrote a record; anyone able to write the archive can write a record whose hashes
// verify. Writer authenticity is outside R4P (R4T governs writable capabilities).
//
// Operational records (invocation journal, APPLIED results, controller audit, R4L
// admission and refusal, CI results, provider or executor output, replay traces,
// connector executions) are never direct authority. No body of theirs parses as a
// direct-authority body, and nothing here converts one.

export const AUTHORITY_KINDS = Object.freeze(['IMPLEMENTATION_PACKET', 'CORRECTION_PACKET', 'ACCEPTANCE_DECISION',
  'AUTHORIZATION'] as const);
export type AuthorityKindV1 = typeof AUTHORITY_KINDS[number];
/** Exact and case-sensitive; never folded, trimmed or used as a path. */
export const AUTHORITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface AuthorityRefV1 {
  kind: AuthorityKindV1;
  authorityId: string;
  version: number;
  recordHash: string;
}
export interface AuthorityDocumentV1 {
  schemaVersion: 1;
  recordClass: 'DIRECT_AUTHORITY';
  kind: AuthorityKindV1;
  authorityId: string;
  version: number;
  issuedAt: string;
  /** A reference the document states, not an authenticated identity. */
  issuer: { role: 'HUMAN' | 'GPT_ARCHITECT'; principalRef: string };
  subject: { repository: string; sliceId?: string };
  supersedes: AuthorityRefV1 | null;
  body: JsonObject;
}
/** A document as archived: bodyHash = SHA256(canonical(body)), recordHash = SHA256(canonical(record without recordHash)). */
export interface AuthorityRecordV1 extends AuthorityDocumentV1 {
  bodyHash: string;
  recordHash: string;
}

export type AuthorityArchiveErrorCode =
  | 'INVALID_DOCUMENT' | 'INVALID_SUPERSESSION' | 'VERSION_GAP' | 'VERSION_CONFLICT' | 'REF_MISMATCH'
  | 'ARCHIVE_INTEGRITY' | 'PUBLICATION_UNAVAILABLE';

export class AuthorityArchiveError extends Error {
  readonly code: AuthorityArchiveErrorCode;
  constructor(code: AuthorityArchiveErrorCode, message: string) {
    super(message);
    this.name = 'AuthorityArchiveError';
    this.code = code;
  }
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const HEX64 = /^[0-9a-f]{64}$/;
const kind = z.enum(AUTHORITY_KINDS);
const authorityId = z.string().regex(AUTHORITY_ID_PATTERN);
const version = z.number().int().positive().refine(Number.isSafeInteger);
// Stated, not authenticated: exact text without control characters or surrounding space.
const principalRef = z.string().min(1).max(256)
  .refine((value) => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value));
const refSchema = z.strictObject({ kind, authorityId, version, recordHash: z.string().regex(HEX64) });
const documentShape = {
  schemaVersion: z.literal(1),
  recordClass: z.literal('DIRECT_AUTHORITY'),
  kind,
  authorityId,
  version,
  issuedAt: z.string().refine(isInstant),
  issuer: z.strictObject({ role: z.enum(['HUMAN', 'GPT_ARCHITECT']), principalRef }),
  // The repository and slice grammars are R4L's change identity, compared exactly.
  subject: z.strictObject({ repository: z.string().regex(REPOSITORY_PATTERN),
    sliceId: z.string().regex(SLICE_ID_PATTERN).optional() }),
  supersedes: refSchema.nullable(),
  body: z.record(z.string(), z.unknown()),
};
const documentSchema = z.strictObject(documentShape);
const recordSchema = z.strictObject({ ...documentShape, bodyHash: z.string().regex(HEX64), recordHash: z.string().regex(HEX64) });

const invalid = (message: string) => new AuthorityArchiveError('INVALID_DOCUMENT', message);

function hasNegativeZero(value: unknown): boolean {
  if (typeof value === 'number') return Object.is(value, -0);
  if (Array.isArray(value)) return value.some(hasNegativeZero);
  if (value && typeof value === 'object') return Object.values(value).some(hasNegativeZero);
  return false;
}
/** A JSON copy of plain data; anything canonical JSON cannot carry exactly is refused. */
function plainCopy(value: unknown): { text: string; copy: unknown } {
  let text: string;
  try { text = canonicalJson(value); } catch { throw invalid('Not plain JSON data'); }
  const copy: unknown = JSON.parse(text);
  if (hasNegativeZero(value)) throw invalid('Not plain JSON data');
  return { text, copy };
}

interface BodyRule {
  parse(body: unknown): Record<string, unknown> | undefined;
  /** The body's own identifier: the document's authorityId. */
  id(body: Record<string, unknown>): unknown;
  /** The issuer role the repository's lifecycle accepts for this kind. */
  role(body: Record<string, unknown>): unknown;
  /** The body's own issue time, when it has one. */
  issuedAt?(body: Record<string, unknown>): unknown;
  /** The body's slice, when it names one. */
  sliceId?(body: Record<string, unknown>): unknown;
}
const attempt = (parse: (body: unknown) => unknown) => (body: unknown) => {
  try { return parse(body) as Record<string, unknown> | undefined; } catch { return undefined; }
};
// Each kind reuses the repository's existing canonical parser; no competing definition.
const BODY_RULES: Readonly<Record<AuthorityKindV1, BodyRule>> = Object.freeze({
  IMPLEMENTATION_PACKET: { parse: attempt(tryParsePacket), id: (b) => b.packetId, role: () => 'GPT_ARCHITECT', sliceId: (b) => b.sliceId },
  CORRECTION_PACKET: { parse: attempt(parseCorrection), id: (b) => b.correctionPacketId, role: () => 'GPT_ARCHITECT' },
  ACCEPTANCE_DECISION: { parse: attempt(parseAcceptanceDecision), id: (b) => b.reviewId, role: (b) => b.actor, issuedAt: (b) => b.issuedAt },
  AUTHORIZATION: { parse: attempt(parseAuthorization), id: (b) => b.authorizationId, role: (b) => b.actorRole, issuedAt: (b) => b.issuedAt },
});

function checkDocument(document: AuthorityDocumentV1, bodyText: string): void {
  const rule = BODY_RULES[document.kind];
  const parsed = rule.parse(document.body);
  if (!parsed || canonicalJson(parsed) !== bodyText) throw invalid(`Body is not a canonical ${document.kind}`);
  if (rule.id(parsed) !== document.authorityId) throw invalid('authorityId must be the body\'s own identifier');
  if (rule.role(parsed) !== document.issuer.role) throw invalid('Issuer role does not match the body');
  if (rule.issuedAt && rule.issuedAt(parsed) !== document.issuedAt) throw invalid('issuedAt does not match the body');
  if (rule.sliceId && rule.sliceId(parsed) !== document.subject.sliceId) throw invalid('subject.sliceId must be the body\'s slice');
  const previous = document.supersedes;
  if (document.version === 1 ? previous !== null : (previous === null || previous.kind !== document.kind ||
      previous.authorityId !== document.authorityId || previous.version !== document.version - 1)) {
    throw new AuthorityArchiveError('INVALID_SUPERSESSION',
      'Version 1 supersedes nothing; version N supersedes exactly version N-1 of the same kind and authorityId');
  }
}

/** A validated copy of a document to append. It is never rewritten: non-canonical input is refused. */
export function parseAuthorityDocument(input: unknown): AuthorityDocumentV1 {
  const { text, copy } = plainCopy(input);
  const parsed = documentSchema.safeParse(copy);
  if (!parsed.success || canonicalJson(parsed.data) !== text) throw invalid('Not a valid AuthorityDocumentV1');
  const document = copy as AuthorityDocumentV1;
  checkDocument(document, canonicalJson(document.body));
  return document;
}

export function authorityBodyHash(body: JsonObject): string {
  return sha256(canonicalJson(body));
}
export function sealAuthorityRecord(input: AuthorityDocumentV1): AuthorityRecordV1 {
  const document = parseAuthorityDocument(input);
  const withBody = { ...document, bodyHash: authorityBodyHash(document.body) };
  return { ...withBody, recordHash: sha256(canonicalJson(withBody)) };
}
export function authorityRefOf(record: AuthorityRecordV1): AuthorityRefV1 {
  return { kind: record.kind, authorityId: record.authorityId, version: record.version, recordHash: record.recordHash };
}
export function parseAuthorityRef(input: unknown): AuthorityRefV1 {
  const parsed = refSchema.safeParse(input);
  if (!parsed.success) throw invalid('Not a valid AuthorityRefV1');
  return parsed.data as AuthorityRefV1;
}

/**
 * Opens one stored record: exact canonical bytes, strict schema, the same document
 * checks as an append, and both hashes. Anything else fails closed; nothing is repaired.
 */
export function openAuthorityRecord(text: string): AuthorityRecordV1 {
  const integrity = (message: string) => new AuthorityArchiveError('ARCHIVE_INTEGRITY', message);
  let stored: unknown;
  try { stored = JSON.parse(text); } catch { throw integrity('Malformed authority record JSON'); }
  let canonical: string;
  try { canonical = canonicalJson(stored); } catch { throw integrity('Authority record is not plain JSON'); }
  if (canonical !== text) throw integrity('Authority record is not in canonical form');
  if (!recordSchema.safeParse(stored).success) throw integrity('Unsupported or invalid authority record');
  const { bodyHash, recordHash, ...document } = stored as AuthorityRecordV1;
  try { checkDocument(document, canonicalJson(document.body)); }
  catch (error) { throw integrity(`Stored authority record is invalid: ${(error as Error).message}`); }
  if (authorityBodyHash(document.body) !== bodyHash) throw integrity('Authority body hash mismatch');
  if (sha256(canonicalJson({ ...document, bodyHash })) !== recordHash) throw integrity('Authority record hash mismatch');
  return stored as AuthorityRecordV1;
}

/** Domain-separated logical key; the raw authorityId never names a path. */
export function authorityKeyOf(kindInput: AuthorityKindV1, idInput: string): string {
  const parsedKind = kind.safeParse(kindInput), parsedId = authorityId.safeParse(idInput);
  if (!parsedKind.success || !parsedId.success) throw invalid('Invalid authority kind or authorityId');
  return sha256(`chief.authority.v1\0${parsedKind.data}\0${parsedId.data}`);
}
