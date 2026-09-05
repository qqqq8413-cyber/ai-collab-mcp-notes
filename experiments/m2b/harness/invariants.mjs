/**
 * NC-2 — evidence isolation, recomputed rather than asserted.
 *
 * Replay #4's `noRound2Leak` was `!Object.hasOwn(result, 'workerResults')`, which on the
 * replay path is true no matter what: `replaySynthesis` never returns that field. It
 * could not fail, so it was not evidence (HANDOFF §25 E4, and the rev.21 principle).
 *
 * This is the replacement, and it can fail: the report is recomputed from the frozen
 * Round 1 with the production `buildRunReport`, and every arm's report must equal it
 * field for field. If a second-round output ever reached the evidence derivation, the
 * recomputation would differ and this throws.
 */
import { buildRunReport, buildOutputBanner } from '../../../dist/modes/orchestrator.js';

export class EvidenceInvariantViolation extends Error {
  constructor(field, expected, actual) {
    super(
      `NC-2: ${field} changed after the second round. ` +
        `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}. This run is INVALID.`
    );
    this.name = 'EvidenceInvariantViolation';
    this.field = field;
  }
}

/** The evidence baseline of a frozen Round 1, computed with production code only. */
export function evidenceBaseline(snapshot) {
  const report = buildRunReport(snapshot.complexity, snapshot.workers, snapshot.workerResults);
  return {
    report: JSON.parse(JSON.stringify(report)),
    banner: buildOutputBanner(report),
    evidenceLabel: report.evidenceLabel,
    status: report.status,
    retrieval: report.retrieval ?? null,
  };
}

/**
 * Asserts one arm's result did not move the evidence state.
 *
 * @param {string} arm
 * @param {object} baseline            from `evidenceBaseline(snapshot)`
 * @param {object} armResult           `{ report, finalOutput }`
 * @param {Array}  calls               the dispatcher's call log, for the retrieval check
 */
export function assertEvidenceIsolation(arm, baseline, armResult, calls) {
  const actual = JSON.parse(JSON.stringify(armResult.report));

  if (JSON.stringify(actual) !== JSON.stringify(baseline.report)) {
    throw new EvidenceInvariantViolation(`${arm}: run report`, baseline.report, actual);
  }
  if (actual.evidenceLabel !== baseline.evidenceLabel) {
    throw new EvidenceInvariantViolation(`${arm}: evidenceLabel`, baseline.evidenceLabel, actual.evidenceLabel);
  }
  if (actual.status !== baseline.status) {
    throw new EvidenceInvariantViolation(`${arm}: RunStatus`, baseline.status, actual.status);
  }
  if (JSON.stringify(actual.retrieval ?? null) !== JSON.stringify(baseline.retrieval)) {
    throw new EvidenceInvariantViolation(`${arm}: retrieval summary`, baseline.retrieval, actual.retrieval ?? null);
  }
  if (!armResult.finalOutput.startsWith(baseline.banner)) {
    throw new EvidenceInvariantViolation(`${arm}: banner`, baseline.banner, armResult.finalOutput.slice(0, 80));
  }
  for (const call of calls) {
    if (call.retrievalRequested !== null || call.retrievalResult !== null) {
      throw new EvidenceInvariantViolation(`${arm}: retrieval at stage ${call.stage}`, null, {
        requested: call.retrievalRequested,
        result: call.retrievalResult,
      });
    }
  }

  return { arm, evidenceLabel: actual.evidenceLabel, status: actual.status, bannerMatched: true };
}
