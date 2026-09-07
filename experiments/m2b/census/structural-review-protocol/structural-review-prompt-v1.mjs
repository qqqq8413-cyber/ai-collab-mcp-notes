/**
 * CBRP-STRUCTURAL-BLIND-ID-v1 / CBRP-STRUCTURAL-REVIEW-PROMPT-1
 *
 * Deterministic, content-blind construction of the exact model-visible bytes a
 * structural reviewer (R1, R2 or R3) receives for one candidate, plus the blind
 * task identifier that stands in for the real, provenance-bearing candidate id.
 *
 * Frozen by CWP-10G; see CBRP_STRUCTURAL_REVIEW_PROTOCOL_1.md. This module never
 * calls a provider and never judges a scenario's content -- it only assembles
 * bytes that are byte-identical for R1, R2 and R3 on the same task. Provider/model
 * routing is applied entirely outside of what it returns.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

export const BLIND_ID_VERSION = 'CBRP-STRUCTURAL-BLIND-ID-v1';
export const PROMPT_VERSION = 'CBRP-STRUCTURAL-REVIEW-PROMPT-1';
export const RUBRIC_VERSION = 'CBRP-STRUCTURAL-REVIEW-RUBRIC-1';

/**
 * Frozen once in CWP-10G by extracting CBRP_STRUCTURAL_REVIEW_RUBRIC_DRAFT.md's
 * "Paste from here" / "Paste to here" span with `extractRubricPasteBytes` below.
 * A future edit to that span (there must never be one to already-frozen wording)
 * would change these and `loadFrozenRubricPasteBytes` would fail closed on it.
 */
export const EXPECTED_RUBRIC_BYTE_COUNT = 4694;
export const EXPECTED_RUBRIC_SHA256 = '2028b998ea0ba8d687cddf87d67e34a2b03d57ce30c47eb3600d0cf336bf4b6e';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const RUBRIC_DOC_PATH = path.join(DIR, '..', 'CBRP_STRUCTURAL_REVIEW_RUBRIC_DRAFT.md');
const START_MARKER = '> ### Paste from here.';
const END_MARKER = '> ### Paste to here.';

const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

/** Canonical stratum code -> display name, matching the rubric's §2.1 category list. */
export const STRATUM_DISPLAY_NAMES = Object.freeze({
  SC: 'Strategy / Commitment',
  OP: 'Operations / Execution',
  BC: 'Brand / Creative',
  EI: 'Evidence Interpretation',
  PS: 'Product / Service Design',
  FR: 'Finance / Resource Allocation',
});

/**
 * Extracts the frozen rubric paste-bytes from a raw markdown document: the exact
 * text strictly between the file's one `> ### Paste from here.` line and its one
 * `> ### Paste to here.` line, with the marker-adjacent blank-line spacers removed
 * and the content's own single trailing newline preserved. Throws -- never
 * guesses -- if either marker is missing, or either appears more than once, or the
 * markers are out of order.
 *
 * The leading and trailing spacers are NOT symmetric, and this is not
 * arbitrary -- it is what makes the result byte-identical to
 * `authoring-v2p1-round-0/BRIEF_SENT.txt`, which the same paste convention already
 * produced for `CBRP-AUTHORING-BRIEF-2` and which a real live run already
 * consumed successfully (CWP-10E):
 *
 *   leading:   "> ### Paste from here." line-end + one blank spacer line = two
 *              newlines, all of which are spacer -- content itself starts with
 *              text, never a newline, so ALL leading newlines are stripped.
 *   trailing:  the pasted text's own last line, as a normal text block, already
 *              ends with ITS OWN single newline; the second trailing newline is
 *              the blank spacer line before "> ### Paste to here.". Only ONE
 *              trailing newline is spacer, so only one is stripped, leaving the
 *              content's own terminator in place.
 *
 * Verified directly against `BRIEF_SENT.txt` in this module's test file, not
 * merely asserted.
 */
export function extractRubricPasteBytes(rawMarkdown) {
  if (typeof rawMarkdown !== 'string') {
    throw new TypeError('extractRubricPasteBytes: rawMarkdown must be a string');
  }
  const startIdx = rawMarkdown.indexOf(START_MARKER);
  const startIdx2 = startIdx === -1 ? -1 : rawMarkdown.indexOf(START_MARKER, startIdx + 1);
  const endIdx = rawMarkdown.indexOf(END_MARKER);
  const endIdx2 = endIdx === -1 ? -1 : rawMarkdown.indexOf(END_MARKER, endIdx + 1);
  if (startIdx === -1) throw new Error('extractRubricPasteBytes: start marker not found');
  if (endIdx === -1) throw new Error('extractRubricPasteBytes: end marker not found');
  if (startIdx2 !== -1) throw new Error('extractRubricPasteBytes: start marker appears more than once');
  if (endIdx2 !== -1) throw new Error('extractRubricPasteBytes: end marker appears more than once');
  if (endIdx < startIdx) throw new Error('extractRubricPasteBytes: end marker precedes start marker');
  const between = rawMarkdown.slice(startIdx + START_MARKER.length, endIdx);
  return between.replace(/^\n+/, '').replace(/\n$/, '');
}

/**
 * Reads the committed rubric doc, extracts its paste-bytes, and fails closed if
 * either the extraction is ambiguous or the result does not match the byte count
 * and SHA-256 frozen above -- the same STOP-on-mismatch shape already used for the
 * authoring brief (`authoring-v2p1-round-0/run.mjs`'s `EXPECTED_PROMPT_SHA256`
 * check). Not called by `buildStructuralReviewPrompt` itself -- callers that need
 * the real frozen bytes call this explicitly, so the prompt builder stays a pure
 * function of its arguments with no filesystem dependency of its own.
 */
export function loadFrozenRubricPasteBytes() {
  const raw = fs.readFileSync(RUBRIC_DOC_PATH, 'utf8');
  const rubricPasteBytes = extractRubricPasteBytes(raw);
  const byteCount = Buffer.byteLength(rubricPasteBytes, 'utf8');
  const rubricSha256 = sha256(rubricPasteBytes);
  if (byteCount !== EXPECTED_RUBRIC_BYTE_COUNT || rubricSha256 !== EXPECTED_RUBRIC_SHA256) {
    throw new Error(
      'loadFrozenRubricPasteBytes: extracted rubric does not match the frozen bytes ' +
      `(got ${byteCount} bytes / ${rubricSha256}, expected ${EXPECTED_RUBRIC_BYTE_COUNT} / ${EXPECTED_RUBRIC_SHA256})`
    );
  }
  return rubricPasteBytes;
}

/**
 * `blindTaskId = "SR-" + SHA256("CBRP-STRUCTURAL-BLIND-ID-v1\n" + trueCandidateId)`,
 * the full lowercase 64-hex digest. Deterministic and one-way: nothing in the
 * returned id, or in anything built from it, lets a reviewer recover the true
 * candidate id, its author block, its author session, or its replacement status.
 */
export function computeBlindTaskId(trueCandidateId) {
  if (typeof trueCandidateId !== 'string' || !trueCandidateId) {
    throw new TypeError('computeBlindTaskId: trueCandidateId must be a non-empty string');
  }
  return `SR-${sha256(`${BLIND_ID_VERSION}\n${trueCandidateId}`)}`;
}

/**
 * Builds the exact model-visible bytes for one structural review call. The caller
 * never supplies a review role (R1/R2/R3) -- the bytes never depend on it, which
 * is what makes R1/R2/R3 prompt-byte identity a structural guarantee rather than
 * an operational habit. Never performs a provider call.
 *
 * Layout, byte for byte: `rubricPasteBytes`, then two LF bytes, then the literal
 * line `REVIEW INPUT JSON:`, then one LF, then `JSON.stringify({ taskId,
 * assignedStratum, taskText })` in that key order with no pretty-printing.
 *
 * @param {{ trueCandidateId: string, stratumCode: keyof STRATUM_DISPLAY_NAMES,
 *           taskText: string, rubricPasteBytes: string }} input
 */
export function buildStructuralReviewPrompt({ trueCandidateId, stratumCode, taskText, rubricPasteBytes }) {
  if (typeof trueCandidateId !== 'string' || !trueCandidateId) {
    throw new TypeError('buildStructuralReviewPrompt: trueCandidateId must be a non-empty string');
  }
  const assignedStratum = STRATUM_DISPLAY_NAMES[stratumCode];
  if (!assignedStratum) {
    throw new TypeError(`buildStructuralReviewPrompt: unknown stratumCode ${JSON.stringify(stratumCode)}`);
  }
  if (typeof taskText !== 'string' || !taskText) {
    throw new TypeError('buildStructuralReviewPrompt: taskText must be a non-empty string');
  }
  if (typeof rubricPasteBytes !== 'string' || !rubricPasteBytes) {
    throw new TypeError('buildStructuralReviewPrompt: rubricPasteBytes must be a non-empty string');
  }

  const blindTaskId = computeBlindTaskId(trueCandidateId);
  const reviewInputJson = JSON.stringify({ taskId: blindTaskId, assignedStratum, taskText });
  const modelVisiblePrompt = `${rubricPasteBytes}\n\nREVIEW INPUT JSON:\n${reviewInputJson}`;

  return {
    blindTaskId,
    promptVersion: PROMPT_VERSION,
    rubricVersion: RUBRIC_VERSION,
    rubricSha256: sha256(rubricPasteBytes),
    promptBytes: Buffer.byteLength(modelVisiblePrompt, 'utf8'),
    promptSha256: sha256(modelVisiblePrompt),
    modelVisiblePrompt,
  };
}
