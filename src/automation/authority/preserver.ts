import { AuthorityArchiveError, parseAuthorityDocument, type AuthorityDocumentV1, type AuthorityRefV1 } from './document.js';
import { openAuthorityArchiveAppender, type AuthorityArchiveAppender } from './file-archive.js';

// G1-AP1: the one production holder of the AUTHORITY_ARCHIVE append capability.
//
// It preserves exactly one thing: a complete canonical AuthorityDocumentV1, parsed by R4P's
// own document rules (each body by its kind's canonical parser). Nothing is converted:
// an invocation record, Controller audit entry, provider response, R4L or Change Mint record
// is not a document and is refused. Storage is R4P's unchanged appender: an identical retry
// returns the same reference, a different body at an archived version fails closed, and
// nothing is overwritten, superseded implicitly or "moved to latest". The reference is
// returned only after the record is durably published (fsync, exclusive link, directory
// fsync), so a caller may let the Controller rely on it only after preserve() returns.
//
// The appender is opened on first use, never handed out, and the preserver exposes no read,
// replace, update, delete, truncate, import, repair or rewrite.

export type AuthorityPreservationCode = 'AUTHORITY_DOCUMENT_INVALID' | 'AUTHORITY_VERSION_CONFLICT' | 'AUTHORITY_PRESERVATION_FAILED';

/** Preservation refused or failed. The message is bounded: no path, no body. */
export class AuthorityPreservationError extends Error {
  constructor(readonly code: AuthorityPreservationCode, readonly archiveCode: string | null) {
    super(archiveCode ? `${code} (${archiveCode})` : code);
    this.name = 'AuthorityPreservationError';
  }
}

export interface DirectAuthorityPreserver {
  preserve(document: AuthorityDocumentV1): AuthorityRefV1;
}

// Refusals the archive decides from the document and what it already holds: retrying the
// same document can never succeed. Anything else is a storage failure.
const REFUSALS: Readonly<Record<string, AuthorityPreservationCode>> = Object.freeze({
  INVALID_DOCUMENT: 'AUTHORITY_DOCUMENT_INVALID', INVALID_SUPERSESSION: 'AUTHORITY_DOCUMENT_INVALID',
  VERSION_GAP: 'AUTHORITY_DOCUMENT_INVALID', VERSION_CONFLICT: 'AUTHORITY_VERSION_CONFLICT',
});

export function openDirectAuthorityPreserver(authorityArchiveDirectory: string): DirectAuthorityPreserver {
  if (typeof authorityArchiveDirectory !== 'string' || !authorityArchiveDirectory) throw new TypeError('An authority archive root is required');
  let appender: AuthorityArchiveAppender | undefined;
  return Object.freeze({
    preserve(input: AuthorityDocumentV1): AuthorityRefV1 {
      let document: AuthorityDocumentV1;
      try { document = parseAuthorityDocument(input); }
      catch (error) {
        throw new AuthorityPreservationError('AUTHORITY_DOCUMENT_INVALID', error instanceof AuthorityArchiveError ? error.code : null);
      }
      try {
        appender ??= openAuthorityArchiveAppender(authorityArchiveDirectory);
        return Object.freeze({ ...appender.append(document) });
      } catch (error) {
        const archiveCode = error instanceof AuthorityArchiveError ? error.code : null;
        throw new AuthorityPreservationError((archiveCode && REFUSALS[archiveCode]) ?? 'AUTHORITY_PRESERVATION_FAILED', archiveCode);
      }
    },
  });
}
