/**
 * CBRP-DUPLICATE-AUDIT-EXTRACTOR-1
 *
 * Strict JSON-only response acceptance for duplicate-audit sessions (D1, D2,
 * and D3 alike). Frozen by CWP-12A; see
 * CBRP_CORPUS_DUPLICATE_AUDIT_PROTOCOL_1.md §7.2: "response must be valid
 * JSON" is the first, unconditional check -- the protocol never authorized a
 * markdown-fence-stripping layer the way `CBRP-STRUCTURAL-REVIEW-EXTRACTOR-1`
 * does for structural review. CWP-12B mirrored that extractor's
 * three-representation grammar here anyway; CWP-12B-R removes it as an
 * unauthorized amendment to the frozen protocol -- accepting a fenced or
 * orphan-fenced response would be exactly the "obsolete assumption" CWP-12B's
 * own instructions warned against copying.
 *
 * The entire raw provider response is handed to `JSON.parse` unmodified.
 * JSON's own grammar (RFC 8259: `JSON-text = ws value ws`) already tolerates
 * surrounding whitespace and nothing else -- no fence stripping, no prefix or
 * suffix removal, no substring search, no repair, because none of those run
 * here at all. A response is either itself parseable JSON or it is
 * MALFORMED; there is no third outcome and no partial credit.
 *
 * Whether the parsed value is the right *shape* (a plain object, the correct
 * keys) is a separate, later question answered by
 * `duplicate-audit-decision-v1.mjs`'s `validateD1D2Response` /
 * `validateD3Response` -- this module only decides whether the response text
 * is JSON at all.
 */

import crypto from 'node:crypto';

export const EXTRACTOR_VERSION = 'CBRP-DUPLICATE-AUDIT-EXTRACTOR-1';

const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * Parses the complete raw response as JSON. `ok: false` (MALFORMED) on any
 * parse failure -- prose before or after the value, a markdown fence of any
 * kind, multiple concatenated JSON values, or genuinely malformed JSON all
 * fail identically, because `JSON.parse` rejects all of them identically.
 * `rawSha256`/`rawBytes` are computed over the untouched input bytes, always
 * -- there is no normalized/transformed byte sequence to hash separately,
 * so no field here can ever reflect a repaired or wrapper-stripped response.
 */
export function extractDuplicateAuditResponse(raw) {
  if (typeof raw !== 'string') {
    throw new TypeError('extractDuplicateAuditResponse: raw must be a string');
  }
  const rawSha256 = sha256(raw);
  const rawBytes = Buffer.byteLength(raw, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      extractorVersion: EXTRACTOR_VERSION,
      parsed: null,
      rawSha256,
      rawBytes,
      ok: false,
    };
  }
  return {
    extractorVersion: EXTRACTOR_VERSION,
    parsed,
    rawSha256,
    rawBytes,
    ok: true,
  };
}
