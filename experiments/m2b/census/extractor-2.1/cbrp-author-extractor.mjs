/**
 * CBRP-AUTHOR-EXTRACTOR-2.1
 *
 * Deterministic wrapper normalization for CBRP author-session responses. This is an
 * extraction/representation amendment only — it decides how much of the response is
 * markdown-fence wrapping around a JSON array, never whether the JSON or the scenario
 * text inside it is well formed, realistic, or admissible. Those remain semantic
 * questions for structural review (CBRP_STRUCTURAL_REVIEW_RUBRIC_DRAFT.md); nothing
 * here performs or implies a semantic judgement.
 *
 * Frozen by CWP-10C. Motivated by M-CBRP-AUTH-02: the 2.0 extractor recognized plain
 * JSON and a *complete* outer fence (opening fence + array + closing fence) but not a
 * syntactically complete array followed only by a lone, ownerless closing fence line —
 * exactly what AUTHOR2-B02-S00 returned under CBRP-AUTHORING-V2-ROUND-0. That run's
 * STOP was correct under the 2.0 rule as written; this module recognizes one more
 * shape, and nothing more.
 *
 * Three accepted representations, tried in order. The first one whose grammar matches
 * wins; none of the checks below repairs anything — a response that almost matches a
 * shape falls through to MALFORMED exactly as before.
 *
 *   PLAIN_JSON            trimmed(raw) is itself one JSON array, nothing else.
 *   COMPLETE_OUTER_FENCE  one opening fence line, one JSON array, one closing fence
 *                         line, and nothing else (optional surrounding whitespace).
 *   ORPHAN_TRAILING_FENCE one complete top-level JSON array starting at the first
 *                         non-whitespace byte, then nothing but optional whitespace
 *                         and exactly one bare closing-fence line.
 *
 * Still forbidden, in every representation: searching prose for a JSON substring,
 * removing explanatory text, repairing malformed JSON, adding or removing commas,
 * fixing quotes, closing missing brackets, guessing truncation, merging multiple JSON
 * blocks, selecting one of several candidate arrays, removing arbitrary suffixes, and
 * any semantic rewriting. A representation that requires any of those is not
 * recognized — it is MALFORMED.
 */

import crypto from 'node:crypto';

export const EXTRACTOR_VERSION = 'CBRP-AUTHOR-EXTRACTOR-2.1';

export const REPRESENTATIONS = Object.freeze({
  PLAIN_JSON: 'PLAIN_JSON',
  COMPLETE_OUTER_FENCE: 'COMPLETE_OUTER_FENCE',
  ORPHAN_TRAILING_FENCE: 'ORPHAN_TRAILING_FENCE',
});

const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * Exactly one complete markdown fence line: three backticks, an optional `json`
 * language tag, and nothing else on the line. No other language tag is accepted —
 * accepting arbitrary tags would turn "recognize a fence" into "guess what the model
 * meant by a fence", which is repair, not normalization.
 */
const OPENING_FENCE_LINE = /^```(?:json)?[ \t]*$/i;
const BARE_FENCE = '```';

/**
 * Scans forward from `text[0] === '['` and returns the index of the matching top-level
 * closing bracket, tracking JSON string state (quotes and backslash escapes) so that a
 * bracket character inside a scenario's text field is never mistaken for structure.
 * Returns -1 if the array never closes (truncated response) — the caller treats that
 * as "no complete array here," never as "repair the truncation."
 */
function findTopLevelArrayEnd(text) {
  if (text[0] !== '[') return -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
      if (depth < 0) return -1; // unbalanced closer before any opener — not this response's array
    }
  }
  return -1; // ran off the end without closing — truncated, not repaired
}

/** CASE A. The entire trimmed response is one JSON array and nothing else. */
function tryPlainJson(raw) {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[')) return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return { representationDetected: REPRESENTATIONS.PLAIN_JSON, normalizedJsonBytes: trimmed, parsed };
}

/**
 * CASE B. One opening fence line, one JSON array, one closing fence line, optional
 * surrounding whitespace, and nothing else. Matches the 2.0 extractor's grammar
 * exactly — this case is unchanged by the 2.1 amendment.
 */
function tryCompleteOuterFence(raw) {
  const trimmed = raw.trim();
  const lines = trimmed.split(/\r?\n/);
  if (lines.length < 3) return null;
  if (!OPENING_FENCE_LINE.test(lines[0])) return null;
  if (lines[lines.length - 1].trim() !== BARE_FENCE) return null;
  const inner = lines.slice(1, -1).join('\n').trim();
  if (!inner.startsWith('[')) return null;
  let parsed;
  try {
    parsed = JSON.parse(inner);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return { representationDetected: REPRESENTATIONS.COMPLETE_OUTER_FENCE, normalizedJsonBytes: inner, parsed };
}

/**
 * CASE C. New in 2.1. A complete top-level JSON array starting at the first
 * non-whitespace byte (conditions 1 and 6: no prefix prose is possible, because any
 * non-whitespace prefix would make that first byte something other than `[`), followed
 * by nothing but optional whitespace and exactly one bare closing-fence line
 * (conditions 4, 5, 7, 8, 9 all reduce to one check: the remainder, once trimmed of
 * whitespace, equals the three-backtick fence and nothing else — a second fence, a
 * second JSON value, or trailing prose would each leave extra non-whitespace bytes
 * behind and fail that equality).
 */
function tryOrphanTrailingFence(raw) {
  const firstNonWs = raw.search(/\S/);
  if (firstNonWs === -1) return null;
  if (raw[firstNonWs] !== '[') return null; // condition 1 / 6: no prefix prose
  const fromArray = raw.slice(firstNonWs);
  const endIndex = findTopLevelArrayEnd(fromArray); // condition 2: complete array, no editing
  if (endIndex === -1) return null;
  const arrayText = fromArray.slice(0, endIndex + 1);
  let parsed;
  try {
    parsed = JSON.parse(arrayText); // condition 3: the array itself parses
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const remainder = fromArray.slice(endIndex + 1);
  if (remainder.trim() !== BARE_FENCE) return null; // conditions 4,5,7,8,9 in one check
  return { representationDetected: REPRESENTATIONS.ORPHAN_TRAILING_FENCE, normalizedJsonBytes: arrayText, parsed };
}

/**
 * Attempts each representation in order and returns a normalization result, or a
 * MALFORMED result carrying no normalized bytes. Never throws on a malformed response —
 * callers decide what a MALFORMED result means for their run (CWP authoring runs treat
 * it as STOP_MALFORMED_RESPONSE).
 *
 * `originalRawSha256` is always computed over the untouched input, so the evidence trail
 * is complete even when normalization fails.
 */
export function extractCbrpAuthorResponse(raw) {
  if (typeof raw !== 'string') {
    throw new TypeError('extractCbrpAuthorResponse: raw must be a string');
  }
  const originalRawSha256 = sha256(raw);
  const attempt = tryPlainJson(raw) ?? tryCompleteOuterFence(raw) ?? tryOrphanTrailingFence(raw);
  if (!attempt) {
    return {
      extractorVersion: EXTRACTOR_VERSION,
      representationDetected: null,
      normalizedJsonBytes: null,
      parsed: null,
      originalRawSha256,
      normalizedJsonSha256: null,
      ok: false,
    };
  }
  return {
    extractorVersion: EXTRACTOR_VERSION,
    representationDetected: attempt.representationDetected,
    normalizedJsonBytes: attempt.normalizedJsonBytes,
    parsed: attempt.parsed,
    originalRawSha256,
    normalizedJsonSha256: sha256(attempt.normalizedJsonBytes),
    ok: true,
  };
}
