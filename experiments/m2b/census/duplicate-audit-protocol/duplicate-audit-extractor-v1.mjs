/**
 * CBRP-DUPLICATE-AUDIT-EXTRACTOR-1
 *
 * Deterministic wrapper normalization for duplicate-audit response bytes (D1,
 * D2, and D3 alike -- all three return one JSON object). Mirrors
 * `structural-review-extractor-v1.mjs`'s (CWP-10G) three-representation
 * grammar and forbidden-repair list exactly, under this instrument's own
 * frozen identity -- the grammar itself is protocol-agnostic ("one JSON object,
 * optionally fenced"), but each CBRP instrument keeps its own versioned,
 * self-contained module rather than importing another protocol's, matching
 * this repository's established convention (structural-review-extractor-v1.mjs
 * itself was written fresh rather than importing extractor-2.1's array-shaped
 * extractor, despite mirroring it explicitly).
 *
 * This is an extraction/representation amendment only -- it decides how much of
 * the response is markdown-fence wrapping around a JSON object, never whether
 * the object's fields are correct. Schema is a separate, later question:
 * duplicate-audit-decision-v1.mjs.
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
 * MALFORMED, and MALFORMED is a mechanical STOP for the whole session
 * (CBRP_CORPUS_DUPLICATE_AUDIT_PROTOCOL_1.md §10): no retry, no repair prompt.
 */

import crypto from 'node:crypto';

export const EXTRACTOR_VERSION = 'CBRP-DUPLICATE-AUDIT-EXTRACTOR-1';

export const REPRESENTATIONS = Object.freeze({
  PLAIN_JSON_OBJECT: 'PLAIN_JSON_OBJECT',
  COMPLETE_OUTER_FENCE: 'COMPLETE_OUTER_FENCE',
  ORPHAN_TRAILING_FENCE: 'ORPHAN_TRAILING_FENCE',
});

const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

const OPENING_FENCE_LINE = /^```(?:json)?$/i;
const BARE_FENCE = '```';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
      if (depth < 0) return -1;
    }
  }
  return -1;
}

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

function tryOrphanTrailingFence(raw) {
  const firstNonWs = raw.search(/\S/);
  if (firstNonWs === -1) return null;
  if (raw[firstNonWs] !== '{') return null;
  const fromObject = raw.slice(firstNonWs);
  const endIndex = findTopLevelObjectEnd(fromObject);
  if (endIndex === -1) return null;
  const objectText = fromObject.slice(0, endIndex + 1);
  let parsed;
  try {
    parsed = JSON.parse(objectText);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;

  const remainder = fromObject.slice(endIndex + 1);
  const lines = remainder.split(/\r\n|\n/);
  if (lines.length < 2) return null;
  if (!/^[ \t]*$/.test(lines[0])) return null;

  let fenceLineFound = false;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^[ \t]*$/.test(line)) continue;
    if (fenceLineFound) return null;
    if (line !== BARE_FENCE) return null;
    fenceLineFound = true;
  }
  if (!fenceLineFound) return null;

  return { representationDetected: REPRESENTATIONS.ORPHAN_TRAILING_FENCE, normalizedJsonBytes: objectText, parsed };
}

/**
 * Attempts each representation in order and returns a normalization result, or
 * a MALFORMED result carrying no normalized bytes. Never throws on a malformed
 * response -- callers decide what a MALFORMED result means for their session
 * (a duplicate-audit session treats it as a mechanical STOP).
 */
export function extractDuplicateAuditResponse(raw) {
  if (typeof raw !== 'string') {
    throw new TypeError('extractDuplicateAuditResponse: raw must be a string');
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
