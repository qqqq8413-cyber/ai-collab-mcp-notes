/**
 * CBRP-STRUCTURAL-REVIEW-EXTRACTOR-1
 *
 * Deterministic wrapper normalization for structural-review response bytes -- the
 * JSON-object analogue of CBRP-AUTHOR-EXTRACTOR-2.1
 * (experiments/m2b/census/extractor-2.1/cbrp-author-extractor.mjs), whose three
 * representations and whose forbidden-repair list this module mirrors exactly,
 * substituting "one JSON object" for "one JSON array" throughout. Frozen by
 * CWP-10G; see CBRP_STRUCTURAL_REVIEW_PROTOCOL_1.md §5.
 *
 * This is an extraction/representation amendment only -- it decides how much of
 * the response is markdown-fence wrapping around a JSON object, never whether the
 * object's fields are correct. Schema and the overallPass invariant are a
 * separate, later question: structural-review-decision-v1.mjs.
 *
 * Three accepted representations, tried in order. The first one whose grammar
 * matches wins; none of the checks below repairs anything -- a response that
 * almost matches a shape falls through to MALFORMED exactly as before.
 *
 *   PLAIN_JSON_OBJECT     trimmed(raw) is itself one JSON object, nothing else.
 *   COMPLETE_OUTER_FENCE  one opening fence line, one JSON object, one closing
 *                         fence line, and nothing else (optional surrounding
 *                         whitespace).
 *   ORPHAN_TRAILING_FENCE one complete top-level JSON object starting at the
 *                         first non-whitespace byte, then a genuine line
 *                         boundary, then exactly one line whose raw content is
 *                         the bare closing fence and nothing else (no same-line
 *                         fence, no leading or trailing whitespace on that line,
 *                         no language tag).
 *
 * Still forbidden, in every representation: searching prose for a JSON
 * substring, removing explanatory text, repairing malformed JSON, adding or
 * removing commas, fixing quotes, closing missing brackets, guessing
 * truncation, merging multiple JSON blocks, selecting one of several candidate
 * objects, removing arbitrary suffixes, and any semantic rewriting. A
 * representation that requires any of those is not recognized -- it is
 * MALFORMED, and MALFORMED is a mechanical STOP for the whole review session
 * (CBRP_STRUCTURAL_REVIEW_PROTOCOL_1.md §11): no retry, no repair prompt.
 */

import crypto from 'node:crypto';

export const EXTRACTOR_VERSION = 'CBRP-STRUCTURAL-REVIEW-EXTRACTOR-1';

export const REPRESENTATIONS = Object.freeze({
  PLAIN_JSON_OBJECT: 'PLAIN_JSON_OBJECT',
  COMPLETE_OUTER_FENCE: 'COMPLETE_OUTER_FENCE',
  ORPHAN_TRAILING_FENCE: 'ORPHAN_TRAILING_FENCE',
});

const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * Exactly one complete markdown fence line: three backticks, an optional `json`
 * language tag, and nothing else on the line. No other language tag is
 * accepted -- accepting arbitrary tags would turn "recognize a fence" into
 * "guess what the model meant by a fence," which is repair, not normalization.
 */
const OPENING_FENCE_LINE = /^```(?:json)?$/i;
const BARE_FENCE = '```';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Scans forward from `text[0] === '{'` and returns the index of the matching
 * top-level closing brace, tracking JSON string state (quotes and backslash
 * escapes) so that a brace or bracket character inside a review field's text is
 * never mistaken for structure. Returns -1 if the object never closes
 * (truncated response) -- the caller treats that as "no complete object here,"
 * never as "repair the truncation."
 */
function findTopLevelObjectEnd(text) {
  if (text[0] !== '{') return -1;
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
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) return i;
      if (depth < 0) return -1; // unbalanced closer before any opener -- not this response's object
    }
  }
  return -1; // ran off the end without closing -- truncated, not repaired
}

/** CASE A. The entire trimmed response is one JSON object and nothing else. */
function tryPlainJsonObject(raw) {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  return { representationDetected: REPRESENTATIONS.PLAIN_JSON_OBJECT, normalizedJsonBytes: trimmed, parsed };
}

/**
 * CASE B. One opening fence line, one JSON object, one closing fence line,
 * optional surrounding whitespace, and nothing else.
 */
function tryCompleteOuterFence(raw) {
  const lines = raw.split(/\r?\n/);
  while (lines.length > 0 && /^[ \t]*$/.test(lines[0])) lines.shift();
  while (lines.length > 0 && /^[ \t]*$/.test(lines[lines.length - 1])) lines.pop();
  if (lines.length < 3) return null;
  if (!OPENING_FENCE_LINE.test(lines[0])) return null;
  if (lines[lines.length - 1] !== BARE_FENCE) return null;
  const inner = lines.slice(1, -1).join('\n').trim();
  if (!inner.startsWith('{')) return null;
  let parsed;
  try {
    parsed = JSON.parse(inner);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  return { representationDetected: REPRESENTATIONS.COMPLETE_OUTER_FENCE, normalizedJsonBytes: inner, parsed };
}

/**
 * CASE C. A complete top-level JSON object starting at the first non-whitespace
 * byte (no prefix prose is possible, because any non-whitespace prefix would
 * make that first byte something other than `{`), followed by a genuine line
 * boundary and then exactly one line whose RAW, unmodified content is the
 * three-backtick fence and nothing else. Line structure is tested directly
 * (never a whitespace-collapsed string), matching the exact-line grammar
 * CWP-10C-R already froze for the array case:
 *
 *   1. split the remainder on a real line boundary (LF, or CRLF as one
 *      boundary)
 *   2. at least one line boundary must exist at all -- no boundary means the
 *      "fence" (if any) is on the object's own line, which is same-line, not
 *      orphan
 *   3. everything on the object's own line, after `}`, must be pure horizontal
 *      whitespace -- nothing else may share that line with the object
 *   4. walk every remaining line; each must be either whitespace-only (a blank
 *      line, before or after the fence) or be the single fence line, whose raw
 *      content must equal the three-backtick string exactly -- no trim, so a
 *      leading/trailing space or tab, a language tag, or any other stray
 *      character fails the equality outright. A second non-blank line (a
 *      second fence, leftover prose, or a second JSON value) is rejected the
 *      moment it is seen, because at that point a fence line has already been
 *      claimed.
 */
function tryOrphanTrailingFence(raw) {
  const firstNonWs = raw.search(/\S/);
  if (firstNonWs === -1) return null;
  if (raw[firstNonWs] !== '{') return null; // no prefix prose
  const fromObject = raw.slice(firstNonWs);
  const endIndex = findTopLevelObjectEnd(fromObject); // complete object, no editing
  if (endIndex === -1) return null;
  const objectText = fromObject.slice(0, endIndex + 1);
  let parsed;
  try {
    parsed = JSON.parse(objectText); // the object itself parses
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;

  const remainder = fromObject.slice(endIndex + 1);
  const lines = remainder.split(/\r\n|\n/);
  if (lines.length < 2) return null; // no line boundary at all -- same-line fence
  if (!/^[ \t]*$/.test(lines[0])) return null; // only horizontal ws before the boundary

  let fenceLineFound = false;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^[ \t]*$/.test(line)) continue; // blank lines, before or after the fence
    if (fenceLineFound) return null; // a second non-blank line
    if (line !== BARE_FENCE) return null; // exact raw content, no trim
    fenceLineFound = true;
  }
  if (!fenceLineFound) return null; // exactly one non-whitespace line must remain

  return { representationDetected: REPRESENTATIONS.ORPHAN_TRAILING_FENCE, normalizedJsonBytes: objectText, parsed };
}

/**
 * Attempts each representation in order and returns a normalization result, or
 * a MALFORMED result carrying no normalized bytes. Never throws on a malformed
 * response -- callers decide what a MALFORMED result means for their run
 * (a structural-review session treats it as a mechanical STOP).
 *
 * `originalRawSha256` is always computed over the untouched input, so the
 * evidence trail is complete even when normalization fails.
 */
export function extractStructuralReviewResponse(raw) {
  if (typeof raw !== 'string') {
    throw new TypeError('extractStructuralReviewResponse: raw must be a string');
  }
  const originalRawSha256 = sha256(raw);
  const attempt = tryPlainJsonObject(raw) ?? tryCompleteOuterFence(raw) ?? tryOrphanTrailingFence(raw);
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
