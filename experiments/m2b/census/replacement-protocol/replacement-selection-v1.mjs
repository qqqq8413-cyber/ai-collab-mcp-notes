/**
 * CBRP-REPLACEMENT-SELECTION-v1
 *
 * Deterministic, content-blind selection of one admitted replacement candidate out of
 * a replacement author session's twelve mechanically-produced outputs, plus the
 * mechanical allocation of replacement session identifiers across a vacancy batch.
 *
 * This module never reads a provider response and never scores scenario text. It
 * accepts only structural metadata already produced by CBRP-AUTHOR-EXTRACTOR-2.1's
 * mechanical validation (declared stratum, response-order index, candidate id) and
 * returns which one candidate is selected and which eleven are surplus. Frozen by
 * CWP-10F; see CBRP_REPLACEMENT_PROTOCOL_1.md for the governing methodology.
 */

import crypto from 'node:crypto';

export const SELECTION_VERSION = 'CBRP-REPLACEMENT-SELECTION-v1';

/** The six frozen strata. A candidate record must declare one of these. */
export const STRATUM_CODES = Object.freeze(['SC', 'OP', 'BC', 'EI', 'PS', 'FR']);

const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * Selects the one replacement candidate that fills a vacant slot, out of a replacement
 * session's twelve mechanically-produced outputs.
 *
 * Rule: among the two candidates whose declared stratum equals the vacant slot's frozen
 * stratum, select the one with the smaller `indexInResponse` — equivalently, the first
 * target-stratum candidate in response order. No semantic comparison, no quality
 * judgement, no operator discretion: the rule is a total order over `indexInResponse`,
 * which exists before anyone reads the candidates' text.
 *
 * Fails closed — returns `{ ok: false, reason }`, never throws and never guesses — on
 * any mechanical irregularity: not exactly twelve candidates, any declared stratum with
 * a count other than two, or the vacant stratum itself not represented exactly twice.
 * A malformed replacement response is a mechanical STOP for the whole session (frozen
 * elsewhere, in CBRP_REPLACEMENT_PROTOCOL_1.md §7), never a reason to relax this check.
 *
 * @param {{ vacantStratumCode: string, candidates: Array<{taskCandidateId: string, stratumCode: string, indexInResponse: number}> }} input
 * @returns {{ ok: true, selectionVersion: string, selectedCandidateId: string, surplusCandidateIds: string[] }
 *         | { ok: false, reason: string }}
 */
export function selectReplacementCandidate({ vacantStratumCode, candidates }) {
  if (!STRATUM_CODES.includes(vacantStratumCode)) {
    return { ok: false, reason: `vacantStratumCode is not one of the six frozen strata: ${JSON.stringify(vacantStratumCode)}` };
  }
  if (!Array.isArray(candidates)) {
    return { ok: false, reason: 'candidates must be an array' };
  }
  if (candidates.length !== 12) {
    return { ok: false, reason: `expected exactly 12 candidates, got ${candidates.length}` };
  }
  for (const [i, c] of candidates.entries()) {
    if (typeof c?.taskCandidateId !== 'string' || !c.taskCandidateId) {
      return { ok: false, reason: `candidates[${i}]: missing taskCandidateId` };
    }
    if (typeof c?.stratumCode !== 'string' || !STRATUM_CODES.includes(c.stratumCode)) {
      return { ok: false, reason: `candidates[${i}]: invalid stratumCode ${JSON.stringify(c?.stratumCode)}` };
    }
    if (typeof c?.indexInResponse !== 'number' || !Number.isInteger(c.indexInResponse)) {
      return { ok: false, reason: `candidates[${i}]: indexInResponse must be an integer` };
    }
  }
  const idSet = new Set(candidates.map((c) => c.taskCandidateId));
  if (idSet.size !== candidates.length) {
    return { ok: false, reason: 'candidate ids are not unique within this session' };
  }

  const countsByStratum = {};
  for (const c of candidates) countsByStratum[c.stratumCode] = (countsByStratum[c.stratumCode] ?? 0) + 1;
  for (const code of STRATUM_CODES) {
    const count = countsByStratum[code] ?? 0;
    if (count !== 2) {
      return { ok: false, reason: `stratum ${code} has ${count} candidate(s), expected exactly 2` };
    }
  }

  // The per-stratum-count check above already guarantees the vacant stratum has
  // exactly two members whenever it passes; this direct check is kept anyway so a
  // "missing target stratum" fixture reads as its own explicit assertion rather than
  // an implicit consequence of the loop above.
  const targetCandidates = candidates.filter((c) => c.stratumCode === vacantStratumCode);
  if (targetCandidates.length !== 2) {
    return { ok: false, reason: `vacant stratum ${vacantStratumCode} is not represented by exactly 2 candidates` };
  }

  const sorted = [...targetCandidates].sort((a, b) => a.indexInResponse - b.indexInResponse);
  const selected = sorted[0];
  const surplusCandidateIds = candidates
    .filter((c) => c.taskCandidateId !== selected.taskCandidateId)
    .map((c) => c.taskCandidateId);

  return {
    ok: true,
    selectionVersion: SELECTION_VERSION,
    selectedCandidateId: selected.taskCandidateId,
    surplusCandidateIds,
  };
}

/**
 * Deterministically assigns replacement session ordinals (the "RNN" in
 * `AUTHOR21-B0X-RNN`) across a vacancy batch, per CBRP_REPLACEMENT_PROTOCOL_1.md §5.
 *
 * All vacancies in the batch must be known before this runs — it is not meant to be
 * called one vacancy at a time. Sort key is `(authorBlockId, replacementOf)` ascending,
 * `replacementOf` compared as a plain lexicographic string; within each block the next
 * unused ordinal is handed out in that sorted order, continuing from
 * `existingOrdinalsByBlock` (the highest ordinal already used in that block, 0 if none).
 *
 * `replacementGeneration`, if present on a vacancy, is passed through unchanged and
 * plays no role in the sort or the ordinal — session ordinal is a property of the
 * *block* (how many replacement sessions that block has ever dispatched), while
 * `replacementGeneration` is a property of the *slot* (how many times that one slot has
 * been refilled). The two counters are independent by construction.
 *
 * @param {{ vacancies: Array<{authorBlockId: string, replacementOf: string, replacementGeneration?: number}>,
 *           existingOrdinalsByBlock?: Record<string, number> }} input
 * @returns {Array<{authorBlockId: string, replacementOf: string, replacementGeneration?: number,
 *           sessionOrdinal: number, actualAuthorSessionId: string}>}
 */
export function allocateReplacementSessionIds({ vacancies, existingOrdinalsByBlock = {} }) {
  if (!Array.isArray(vacancies)) {
    throw new TypeError('allocateReplacementSessionIds: vacancies must be an array');
  }
  for (const v of vacancies) {
    if (typeof v?.authorBlockId !== 'string' || typeof v?.replacementOf !== 'string') {
      throw new TypeError('allocateReplacementSessionIds: each vacancy needs authorBlockId and replacementOf strings');
    }
  }

  const sorted = [...vacancies].sort((a, b) => {
    if (a.authorBlockId !== b.authorBlockId) return a.authorBlockId < b.authorBlockId ? -1 : 1;
    if (a.replacementOf !== b.replacementOf) return a.replacementOf < b.replacementOf ? -1 : 1;
    return 0;
  });

  const counters = { ...existingOrdinalsByBlock };
  return sorted.map((v) => {
    const nextOrdinal = (counters[v.authorBlockId] ?? 0) + 1;
    counters[v.authorBlockId] = nextOrdinal;
    return {
      ...v,
      sessionOrdinal: nextOrdinal,
      actualAuthorSessionId: `${v.authorBlockId}-R${String(nextOrdinal).padStart(2, '0')}`,
    };
  });
}

/** Convenience for provenance records: hashes evidence text without altering it. */
export function evidenceSha256(text) {
  return sha256(text);
}
