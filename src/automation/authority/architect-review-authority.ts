import { parseAcceptanceDecision } from '../lifecycle.js';
import { parseCorrection } from '../packet.js';
import type { ArchitectAuthoritySink, ReviewAuthorityOutcome } from '../runner.js';
import { isAuthorityPrincipalRef, parseAuthorityDocument, type AuthorityDocumentV1, type AuthorityKindV1, type JsonObject } from './document.js';
import { AuthorityPreservationError, type DirectAuthorityPreserver } from './preserver.js';

// G1-AP1: the architect review's direct-authority preservation path. The runner hands it the
// review's AcceptanceDecision and, for a REJECT, its CorrectionPacket, exactly as the review
// protocol returned them, before the Controller may rely on either. Each becomes a version 1
// DIRECT_AUTHORITY document issued by GPT_ARCHITECT under the configured principal, about the
// run's exact Change; both are formed and validated before either is preserved, the decision
// first. A body that cannot form a canonical document, or a version the archive already holds
// with another body, is REFUSED (retrying cannot change that); anything else is FAILED.
//
// Nothing here reads the invocation journal: the journal stays an operational record. The
// stated principal is a configured reference, not authentication of the reviewer.

function documentOf(kind: AuthorityKindV1, authorityId: string, issuedAt: string, body: object, principalRef: string,
  subject: { repository: string; sliceId: string }): AuthorityDocumentV1 {
  return parseAuthorityDocument({ schemaVersion: 1, recordClass: 'DIRECT_AUTHORITY', kind, authorityId, version: 1, issuedAt,
    issuer: { role: 'GPT_ARCHITECT', principalRef }, subject: { repository: subject.repository, sliceId: subject.sliceId },
    supersedes: null, body: body as JsonObject });
}

export function architectReviewAuthority(preserver: DirectAuthorityPreserver, principalRef: string): ArchitectAuthoritySink {
  if (typeof preserver?.preserve !== 'function') throw new TypeError('A direct authority preserver is required');
  if (!isAuthorityPrincipalRef(principalRef)) throw new TypeError('architectPrincipalRef must be an exact principal reference');
  return Object.freeze({
    principalRef,
    preserveReview(subject: { repository: string; sliceId: string }, decisionInput: unknown, correctionInput: unknown): ReviewAuthorityOutcome {
      let documents: AuthorityDocumentV1[];
      try {
        const decision = parseAcceptanceDecision(decisionInput);
        const correction = correctionInput === undefined ? undefined : parseCorrection(correctionInput);
        documents = [documentOf('ACCEPTANCE_DECISION', decision.reviewId, decision.issuedAt, decision, principalRef, subject)];
        // The correction has no issue time of its own: it is issued with the review that carries it.
        if (correction) {
          documents.push(documentOf('CORRECTION_PACKET', correction.correctionPacketId, decision.issuedAt, correction, principalRef, subject));
        }
      } catch { return 'REFUSED'; }
      for (const document of documents) {
        try { preserver.preserve(document); }
        catch (error) {
          return error instanceof AuthorityPreservationError && error.code !== 'AUTHORITY_PRESERVATION_FAILED' ? 'REFUSED' : 'FAILED';
        }
      }
      return 'PRESERVED';
    },
  });
}
