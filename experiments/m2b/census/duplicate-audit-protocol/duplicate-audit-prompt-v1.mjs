/**
 * CBRP-DUPLICATE-AUDIT-LAYER-A-v1 / CBRP-DUPLICATE-AUDIT-D1D2-WRAPPER-1 /
 * CBRP-DUPLICATE-AUDIT-D3-WRAPPER-1
 *
 * Deterministic, byte-exact construction of the model-visible bytes for the two
 * duplicate-audit instruments: the D1/D2 corpus wrapper and the D3 pair wrapper.
 * Frozen by CWP-12A (layer split, schemas) and CWP-12A-R (exact byte
 * composition); see CBRP_CORPUS_DUPLICATE_AUDIT_PROTOCOL_1.md §6-§8. This
 * module never calls a provider and never judges a pair's content -- it only
 * assembles bytes. Provider/model routing (CBRP-D3-v1) lives in
 * duplicate-audit-decision-v1.mjs, entirely outside what this module returns.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

export const LAYER_A_VERSION = 'CBRP-DUPLICATE-AUDIT-LAYER-A-v1';
export const D1D2_WRAPPER_VERSION = 'CBRP-DUPLICATE-AUDIT-D1D2-WRAPPER-1';
export const D3_WRAPPER_VERSION = 'CBRP-DUPLICATE-AUDIT-D3-WRAPPER-1';

/**
 * Frozen once in CWP-12A by extracting CBRP_CORPUS_DUPLICATE_AUDIT_PROTOCOL_1.md
 * §6's "Paste from here" / "Paste to here" span with `extractLayerAPasteBytes`
 * below. A future edit to that span (there must never be one to already-frozen
 * wording) would change these and `loadFrozenLayerABytes` would fail closed.
 */
export const EXPECTED_LAYER_A_BYTE_COUNT = 639;
export const EXPECTED_LAYER_A_SHA256 = '57ca27ecf339ad4d5d5e1f45d3361a90a2ca1accf8a6e1433f55c831f613a05d';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PROTOCOL_DOC_PATH = path.join(DIR, '..', 'CBRP_CORPUS_DUPLICATE_AUDIT_PROTOCOL_1.md');
const START_MARKER = '> ### Paste from here.';
const END_MARKER = '> ### Paste to here.';

const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * Extracts Layer A's frozen paste-bytes from the raw protocol markdown: the
 * exact text strictly between the file's one `> ### Paste from here.` line and
 * its one `> ### Paste to here.` line, with the marker-adjacent blank-line
 * spacers removed and the content's own single trailing newline preserved.
 * Throws -- never guesses -- if either marker is missing, appears more than
 * once, or is out of order.
 *
 * Same asymmetric leading/trailing-newline convention as
 * `structural-review-prompt-v1.mjs`'s `extractRubricPasteBytes` (CWP-10G) and
 * `CBRP_REPLACEMENT_PROTOCOL_1.md`'s brief extraction: all leading newlines are
 * spacer and are stripped; only ONE trailing newline is spacer, so only one is
 * stripped, leaving the pasted content's own natural terminator in place.
 */
export function extractLayerAPasteBytes(rawMarkdown) {
  if (typeof rawMarkdown !== 'string') {
    throw new TypeError('extractLayerAPasteBytes: rawMarkdown must be a string');
  }
  const startIdx = rawMarkdown.indexOf(START_MARKER);
  const startIdx2 = startIdx === -1 ? -1 : rawMarkdown.indexOf(START_MARKER, startIdx + 1);
  const endIdx = rawMarkdown.indexOf(END_MARKER);
  const endIdx2 = endIdx === -1 ? -1 : rawMarkdown.indexOf(END_MARKER, endIdx + 1);
  if (startIdx === -1) throw new Error('extractLayerAPasteBytes: start marker not found');
  if (endIdx === -1) throw new Error('extractLayerAPasteBytes: end marker not found');
  if (startIdx2 !== -1) throw new Error('extractLayerAPasteBytes: start marker appears more than once');
  if (endIdx2 !== -1) throw new Error('extractLayerAPasteBytes: end marker appears more than once');
  if (endIdx < startIdx) throw new Error('extractLayerAPasteBytes: end marker precedes start marker');
  const between = rawMarkdown.slice(startIdx + START_MARKER.length, endIdx);
  return between.replace(/^\n+/, '').replace(/\n$/, '');
}

/**
 * Reads the committed protocol doc, extracts Layer A's paste-bytes, and fails
 * closed if extraction is ambiguous or the result does not match the byte
 * count and SHA-256 frozen above. Not called by the prompt builders themselves
 * -- callers that need the real frozen bytes call this explicitly, so the
 * builders stay pure functions of their arguments with no filesystem
 * dependency of their own.
 */
export function loadFrozenLayerABytes() {
  const raw = fs.readFileSync(PROTOCOL_DOC_PATH, 'utf8');
  const layerABytes = extractLayerAPasteBytes(raw);
  const byteCount = Buffer.byteLength(layerABytes, 'utf8');
  const layerASha256 = sha256(layerABytes);
  if (byteCount !== EXPECTED_LAYER_A_BYTE_COUNT || layerASha256 !== EXPECTED_LAYER_A_SHA256) {
    throw new Error(
      'loadFrozenLayerABytes: extracted Layer A text does not match the frozen bytes ' +
      `(got ${byteCount} bytes / ${layerASha256}, expected ${EXPECTED_LAYER_A_BYTE_COUNT} / ${EXPECTED_LAYER_A_SHA256})`
    );
  }
  return layerABytes;
}

// --- Frozen text blocks (§7.5, §8.5) ---------------------------------------
// Verbatim from CBRP_CORPUS_DUPLICATE_AUDIT_PROTOCOL_1.md. Never edited per
// round, never edited per pair, never assembled any other way.

const D1D2_FRAMING_BYTES =
  'You are auditing a corpus of sixty decision scenarios written for a research pool.\n' +
  'Your only job is to find duplicate pairs among them.';

const D1D2_SCOPE_INSTRUCTION_BYTES =
  'You are given a list, auditScopeIds, inside AUDIT INPUT JSON below. Report a pair\n' +
  'only if at least one of its two scenarios is in that list. Pairs where neither is in\n' +
  'the list are outside your task; do not report them, and do not comment on them.';

const D1D2_RETURN_INSTRUCTION_BYTES =
  'Return candidate duplicate pairs, and nothing else. Do not rank the scenarios, do\n' +
  'not judge their quality, do not suggest replacements, and do not comment on the pool\n' +
  'as a whole. If you find no duplicates, return an empty list. That is a normal\n' +
  'outcome. Return exactly this JSON shape, and nothing else:\n\n' +
  '{"duplicatePairs":[{"a":"<candidate-id>","b":"<candidate-id>","reason":"<non-empty explanation>"}]}';

const D3_FRAMING_BYTES =
  'You are comparing exactly two decision scenarios, candidate A and candidate B.\n' +
  'Your only job is to judge whether they are duplicates.';

const D3_RETURN_INSTRUCTION_BYTES =
  'Return your judgment using exactly this JSON shape, and nothing else:\n\n' +
  '{"isDuplicate":true,"reason":"<non-empty explanation>"}\n\n' +
  'isDuplicate must be strictly boolean true or false.';

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function assertCandidateTask(task, label) {
  if (typeof task !== 'object' || task === null) {
    throw new TypeError(`${label} must be an object`);
  }
  assertNonEmptyString(task.candidateId, `${label}.candidateId`);
  assertNonEmptyString(task.taskText, `${label}.taskText`);
}

/**
 * Builds the exact model-visible bytes for one D1 or one D2 session (§7.5).
 * `corpusTasks` and `auditScopeIds` are sorted ascending lexicographically by
 * this function -- callers do not need to pre-sort, and the output is
 * identical regardless of input order, which is what makes D1's and D2's
 * prompt bytes byte-identical given the same logical inputs.
 *
 * @param {{ corpusTasks: Array<{candidateId: string, taskText: string}>,
 *           auditScopeIds: string[], layerABytes: string }} input
 */
export function buildD1D2Prompt({ corpusTasks, auditScopeIds, layerABytes }) {
  if (!Array.isArray(corpusTasks) || corpusTasks.length === 0) {
    throw new TypeError('buildD1D2Prompt: corpusTasks must be a non-empty array');
  }
  if (!Array.isArray(auditScopeIds) || auditScopeIds.length === 0) {
    throw new TypeError('buildD1D2Prompt: auditScopeIds must be a non-empty array');
  }
  assertNonEmptyString(layerABytes, 'buildD1D2Prompt: layerABytes');
  corpusTasks.forEach((task, i) => assertCandidateTask(task, `buildD1D2Prompt: corpusTasks[${i}]`));
  auditScopeIds.forEach((id, i) => assertNonEmptyString(id, `buildD1D2Prompt: auditScopeIds[${i}]`));

  const corpusIds = corpusTasks.map((t) => t.candidateId);
  const corpusIdSet = new Set(corpusIds);
  if (corpusIdSet.size !== corpusIds.length) {
    throw new Error('buildD1D2Prompt: corpusTasks contains duplicate candidateId values');
  }
  const scopeIdSet = new Set(auditScopeIds);
  if (scopeIdSet.size !== auditScopeIds.length) {
    throw new Error('buildD1D2Prompt: auditScopeIds contains duplicate values');
  }
  for (const id of auditScopeIds) {
    if (!corpusIdSet.has(id)) {
      throw new Error(`buildD1D2Prompt: auditScopeIds contains an ID not present in corpusTasks: ${JSON.stringify(id)}`);
    }
  }

  const sortedScopeIds = [...auditScopeIds].sort();
  const sortedCorpusTasks = [...corpusTasks]
    .sort((x, y) => (x.candidateId < y.candidateId ? -1 : x.candidateId > y.candidateId ? 1 : 0))
    .map((t) => ({ candidateId: t.candidateId, taskText: t.taskText }));

  const auditInputJson = JSON.stringify({ auditScopeIds: sortedScopeIds, corpusTasks: sortedCorpusTasks });
  const modelVisiblePrompt =
    `${D1D2_FRAMING_BYTES}\n\n${layerABytes}\n\n${D1D2_SCOPE_INSTRUCTION_BYTES}\n\n` +
    `${D1D2_RETURN_INSTRUCTION_BYTES}\n\nAUDIT INPUT JSON:\n${auditInputJson}`;

  return {
    wrapperVersion: D1D2_WRAPPER_VERSION,
    layerAVersion: LAYER_A_VERSION,
    layerASha256: sha256(layerABytes),
    promptBytes: Buffer.byteLength(modelVisiblePrompt, 'utf8'),
    promptSha256: sha256(modelVisiblePrompt),
    modelVisiblePrompt,
  };
}

/**
 * Builds the exact model-visible bytes for one D3 session on one disputed pair
 * (§8.5). `a` and `b` must already be in canonical lexicographic order
 * (`duplicate-audit-order-v1.mjs`'s `canonicalizePair`) -- this function does
 * not reorder them, so an out-of-order call is a caller bug, not something
 * silently corrected here.
 *
 * @param {{ a: {candidateId: string, taskText: string},
 *           b: {candidateId: string, taskText: string}, layerABytes: string }} input
 */
export function buildD3Prompt({ a, b, layerABytes }) {
  assertCandidateTask(a, 'buildD3Prompt: a');
  assertCandidateTask(b, 'buildD3Prompt: b');
  assertNonEmptyString(layerABytes, 'buildD3Prompt: layerABytes');
  if (!(a.candidateId < b.candidateId)) {
    throw new Error(`buildD3Prompt: a (${a.candidateId}) must be lexicographically smaller than b (${b.candidateId})`);
  }

  const pairJson = JSON.stringify({
    a: { candidateId: a.candidateId, taskText: a.taskText },
    b: { candidateId: b.candidateId, taskText: b.taskText },
  });
  const modelVisiblePrompt =
    `${D3_FRAMING_BYTES}\n\n${layerABytes}\n\n${D3_RETURN_INSTRUCTION_BYTES}\n\nPAIR JSON:\n${pairJson}`;

  return {
    wrapperVersion: D3_WRAPPER_VERSION,
    layerAVersion: LAYER_A_VERSION,
    layerASha256: sha256(layerABytes),
    promptBytes: Buffer.byteLength(modelVisiblePrompt, 'utf8'),
    promptSha256: sha256(modelVisiblePrompt),
    modelVisiblePrompt,
  };
}
