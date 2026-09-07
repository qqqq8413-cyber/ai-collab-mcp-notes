/**
 * CBRP-AUTHOR-EXTRACTOR-2.1
 *
 * Implementation conformance repaired by CWP-10C-R: Case C now enforces the frozen
 * grammar's exact-line requirement for the trailing fence (see tryOrphanTrailingFence
 * below) rather than a whitespace-collapsing `trim()` comparison. The protocol itself —
 * CBRP-AUTHORING-PROTOCOL-2.1, its three representations, and every forbidden repair —
 * is unchanged; this is a source-conformance fix, not a new protocol version.
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
 *                         non-whitespace byte, then a genuine line boundary, then
 *                         exactly one line whose raw content is the bare closing
 *                         fence and nothing else (no same-line fence, no leading or
 *                         trailing whitespace on that line, no language tag).
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
 * by a genuine line boundary and then exactly one line whose RAW, unmodified content is
 * the three-backtick fence and nothing else.
 *
 * Tightened by CWP-10C-R. The original implementation checked
 * `remainder.trim() === "```"`, which is too permissive: `trim()` erases the line
 * structure the frozen grammar depends on, so it wrongly accepted a fence on the same
 * line as the array's closing bracket (`[...]```` with no line break at all) and a
 * fence line carrying leading or trailing horizontal whitespace (`` 
 ``` `` or
 * `` 
``` `` with a trailing space) — none of which is "exactly one Markdown
 * closing-fence LINE" as specified. The fix below tests line structure directly rather
 * than a whitespace-collapsed string, per line:
 *
 *   1. split the remainder on a real line boundary (LF, or CRLF as one boundary)
 *   2. condition 4: at least one line boundary must exist at all — no boundary means
 *      the "fence" (if any) is on the array's own line, which is same-line, not orphan
 *   3. condition 5: everything on the array's own line, after `]`, must be pure
 *      horizontal whitespace — nothing else may share that line with the array
 *   4. conditions 6/7/8/9/10/11/12/13/14: walk every remaining line; each must be
 *      either whitespace-only (a blank line, before or after the fence — this is one
 *      mechanism for both "intervening blank lines" and "only whitespace after the
 *      fence") or be the single fence line, whose raw content must equal the
 *      three-backtick string exactly — no trim, so a leading/trailing space or tab,
 *      a language tag, or any other stray character fails the equality outright. A
 *      second non-blank line — a second fence, leftover prose, or a second JSON
 *      value — is rejected the moment it is seen, because at that point a fence line
 *      has already been claimed.
 */
function tryOrphanTrailingFence(raw) {
  const firstNonWs = raw.search(/\S/);
  if (firstNonWs === -1) return null;
  if (raw[firstNonWs] !== '[') return null; // condition 1 / 15: no prefix prose
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
  const lines = remainder.split(/\r\n|\n/);
  if (lines.length < 2) return null; // condition 4: no line boundary at all — same-line fence
  if (!/^[ \t]*$/.test(lines[0])) return null; // condition 5: only horizontal ws before the boundary

  let fenceLineFound = false;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^[ \t]*$/.test(line)) continue; // condition 6 / 12: blank lines, before or after the fence
    if (fenceLineFound) return null; // condition 13 / 14 / 15: a second non-blank line
    if (line !== BARE_FENCE) return null; // condition 8,9,10,11: exact raw content, no trim
    fenceLineFound = true;
  }
  if (!fenceLineFound) return null; // condition 7: exactly one non-whitespace line must remain

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
