/**
 * Offline verifier for the M2-B Real Round 1 capture. Never calls a provider.
 *
 * The governing rule is that nothing here may read a self-reported conclusion. A manifest
 * saying `captureStatus: CAPTURED` or `actualComplexity: deep` is a claim by the process
 * under audit; every one of those claims is recomputed from the raw call journal, the
 * frozen snapshot and production code, and the manifest is then checked against the
 * recomputation rather than consulted for the answer.
 *
 * Checks return structured results instead of throwing, so the negative tests can assert
 * that a specific check catches a specific tampering rather than that "something failed".
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildRunReport } from '../../../dist/modes/orchestrator.js';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) => JSON.stringify(value, null, 2);

export const ALLOWED_STAGES = Object.freeze(['planning', 'round1_worker']);
export const FORBIDDEN_STAGES = Object.freeze(['synthesis', 'synthesis_gate', 'round2_worker', 'decision_synthesis', 'self_review']);
export const GLOBAL_CALL_BUDGET = 16;
export const PER_CANDIDATE_CALL_BUDGET = 4;

/** Filename fragments that mean ground truth has leaked into the runtime fixture path. */
const EVALUATION_ARTIFACT_PATTERNS = Object.freeze(['conflict-label', 'gold-issue', 'annotation', 'packet-', 'archetype']);

/**
 * @param {object} input
 * @param {(fixtureId: string) => string} input.sourceTaskPathFor
 *   Resolves a fixture's source task file. Passed in rather than derived here so each
 *   candidate set keeps its own source directory, and so a test can verify a capture that
 *   lives anywhere on disk.
 */
export function verifyCapture({ realRoot, chiefPin, providerAllocation, sourceCandidate, sourceTaskPathFor, globalCallBudget = GLOBAL_CALL_BUDGET }) {
  const checks = [];
  const check = (id, name, ok, detail = '') => {
    checks.push({ id, name, ok: Boolean(ok), detail: String(detail) });
    return Boolean(ok);
  };

  const session = JSON.parse(readFileSync(join(realRoot, 'capture-session.json'), 'utf8'));
  const fixtureIds = session.attempts.map((a) => a.fixtureId);
  const all = [];

  for (const fixtureId of fixtureIds) {
    const dir = join(realRoot, fixtureId);
    const read = (name) => readFileSync(join(dir, name), 'utf8');
    const readJson = (name) => JSON.parse(read(name));
    const manifest = readJson('capture-manifest.json');
    const rawCalls = readJson('raw-calls.json');
    const p = (id, name, ok, detail) => check(`${fixtureId}/${id}`, name, ok, detail);
    all.push({ fixtureId, manifest, rawCalls, dir });

    // 1. task hash, and byte-identical reuse of the source candidate's task
    const task = read('task.txt');
    p(1, 'task hash matches manifest', sha256(task) === manifest.taskSha256, `${sha256(task)} vs ${manifest.taskSha256}`);
    const sourceTask = readFileSync(sourceTaskPathFor(fixtureId), 'utf8');
    p('1b', 'task bytes identical to source candidate', task === sourceTask, 'task text was reused verbatim');

    // 2. raw calls hash
    p(2, 'raw-calls hash matches manifest', sha256(canonical(rawCalls)) === manifest.rawCallsSha256, manifest.rawCallsSha256);

    // 3. snapshot hash
    const hasSnapshot = existsSync(join(dir, 'snapshot.json'));
    if (hasSnapshot) {
      p(3, 'snapshot hash matches manifest', sha256(read('snapshot.json')) === manifest.snapshotSha256, manifest.snapshotSha256);
    } else {
      p(3, 'snapshot hash matches manifest', manifest.snapshotSha256 === null, 'no snapshot: attempt did not reach Round 1 completion');
    }

    // 4. manifest hash, resealed from the manifest's own canonical form
    const { manifestSha256, ...rest } = manifest;
    p(4, 'manifest seal recomputes', sha256(canonical(rest)) === manifestSha256, manifestSha256);

    // 5. execution fixture identity
    p(5, 'fixture identity matches its directory', manifest.fixtureId === fixtureId, manifest.fixtureId);

    // 6. source candidate mapping
    p(6, 'source candidate mapping is the authorized one', manifest.sourceCandidateId === sourceCandidate[fixtureId], manifest.sourceCandidateId);

    // 8. exactly one planning call
    const planningCalls = rawCalls.filter((c) => c.stage === 'planning');
    p(8, 'exactly one planning call', planningCalls.length === 1, `${planningCalls.length}`);

    // 9. planning pin: requested and resolved both equal the authorized Chief pin
    const planning = planningCalls[0] ?? null;
    p(9, 'planning provider/model pin binds requested and resolved', Boolean(planning)
      && planning.providerRequested === chiefPin.provider
      && planning.modelRequested === chiefPin.model
      && planning.providerResolved === chiefPin.provider
      && planning.modelResolved === chiefPin.model,
      planning ? `${planning.providerRequested}/${planning.modelRequested} -> ${planning.providerResolved}/${planning.modelResolved}` : 'no planning call');

    const snapshot = hasSnapshot ? readJson('snapshot.json') : null;
    const plan = existsSync(join(dir, 'planner-result.json')) ? readJson('planner-result.json') : null;

    // 10. production complexity, recomputed from the planner's own output (F1)
    const complexity = plan?.complexity ?? null;
    p(10, 'manifest complexity matches the planner result', complexity === manifest.actualComplexity, `${complexity}`);
    p('10b', 'F1: production complexity is deep', complexity === 'deep', `${complexity}`);

    // 11. assignment count
    const assignments = plan?.assignments ?? [];
    p(11, 'assignment count matches manifest', assignments.length === (manifest.plannerAssignments?.length ?? -1), `${assignments.length}`);

    // 12. successful worker count, recounted (F2)
    const results = snapshot?.workerResults ?? [];
    const successful = results.filter((r) => typeof r.output === 'string');
    p(12, 'successful worker count matches manifest', successful.length === manifest.successfulWorkerCount, `${successful.length}`);
    p('12b', 'F2: at least two specialists returned output', successful.length >= 2, `${successful.length}`);

    // 13. Round 1 status, recomputed with production buildRunReport (F3)
    let recomputedStatus = null;
    if (snapshot) {
      recomputedStatus = buildRunReport(snapshot.complexity, snapshot.workers, snapshot.workerResults).status;
    }
    p(13, 'run status matches manifest', recomputedStatus === manifest.round1Status, `${recomputedStatus}`);
    p('13b', 'F3: recomputed RunStatus is SUCCESS', recomputedStatus === 'SUCCESS', `${recomputedStatus}`);

    // 14. assignment ids and worker result ids are the same set, in the same order
    p(14, 'assignments and worker results agree on agent ids',
      JSON.stringify(assignments.map((a) => a.agentId)) === JSON.stringify(results.map((r) => r.agentId)),
      JSON.stringify(results.map((r) => r.agentId)));

    const workerCalls = rawCalls.filter((c) => c.stage === 'round1_worker');
    const roster = readJson('available-roster.json').workers;

    for (const result of results) {
      const worker = roster.find((w) => w.id === result.agentId) ?? null;
      const matches = workerCalls.filter((c) => worker && c.systemPrompt === worker.role);
      const q = (id, name, ok, detail) => p(`${id}:${result.agentId}`, name, ok, detail);

      // 15. role -> raw call mapping is unique, which is what makes attribution checkable
      q(15, 'role maps to exactly one raw worker call', matches.length === 1, `${matches.length} match(es)`);
      const raw = matches.length === 1 ? matches[0] : null;
      q('15b', 'recorded agentId agrees with the role match', raw ? raw.agentId === result.agentId : false, raw?.agentId ?? 'none');

      // 16. mission binding: file, snapshot and the prompt actually sent
      const missionFile = existsSync(join(dir, `mission-${result.agentId}.txt`)) ? read(`mission-${result.agentId}.txt`) : null;
      q(16, 'mission file matches the snapshot mission', missionFile === result.mission, 'exact');
      q('16b', 'mission appears verbatim in the prompt sent', raw ? raw.prompt.includes(result.mission) : false, 'prompt carries the mission');

      // 17/18. provider and model, requested and resolved, on both sides
      const pin = providerAllocation[fixtureId];
      q(17, 'worker provider binds snapshot, request and resolution',
        Boolean(worker && raw) && worker.provider === pin.provider && raw.providerRequested === pin.provider && raw.providerResolved === pin.provider,
        raw ? `${raw.providerRequested} -> ${raw.providerResolved}` : 'no call');
      q(18, 'worker model binds snapshot, request and resolution',
        Boolean(worker && raw) && worker.model === pin.model && raw.modelRequested === pin.model && raw.modelResolved === pin.model,
        raw ? `${raw.modelRequested} -> ${raw.modelResolved}` : 'no call');

      // 19. the frozen output is the provider's text, unchanged
      q(19, 'Round 1 output is exactly the raw provider text', raw ? raw.responseText === result.output : false, 'byte equality');
      const outputFile = existsSync(join(dir, `round1-${result.agentId}.md`)) ? read(`round1-${result.agentId}.md`) : null;
      q('19b', 'round1 file matches the snapshot output', outputFile === result.output, 'byte equality');
    }

    // 20. retrieval all-off, on request and on result, everywhere
    p(20, 'no call requested retrieval', rawCalls.every((c) => c.retrievalRequested === false), 'all-off');
    p('20b', 'no call carries a retrieval result', rawCalls.every((c) => c.retrievalResult === null), 'all-off');
    p('20c', 'no worker result carries retrieval', results.every((r) => r.retrieval === undefined || r.retrieval === null), 'all-off');

    // 21. temperature never specified
    p(21, 'temperature was never requested', rawCalls.every((c) => c.temperatureRequested === null), TEMPERATURE_DETAIL(manifest));

    // 22/26/27/28/29. stage discipline
    const stages = [...new Set(rawCalls.map((c) => c.stage))];
    p(22, 'only planning and round1_worker stages appear', rawCalls.every((c) => ALLOWED_STAGES.includes(c.stage)), stages.join(', ') || 'none');
    for (const [n, forbidden] of [[26, 'synthesis'], [27, 'synthesis_gate'], [28, 'round2_worker'], [29, 'decision_synthesis']]) {
      p(n, `no ${forbidden} call`, !rawCalls.some((c) => c.stage === forbidden), '0 calls');
    }

    // 23. per-candidate call budget
    p(23, 'candidate call count within budget', rawCalls.length <= PER_CANDIDATE_CALL_BUDGET, `${rawCalls.length} <= ${PER_CANDIDATE_CALL_BUDGET}`);
    p('23b', 'candidate call count matches manifest', rawCalls.length === manifest.liveCallCount, `${rawCalls.length}`);

    // 25. no duplicate attempt inside a candidate
    p(25, 'call sequence numbers are unique', new Set(rawCalls.map((c) => c.seq)).size === rawCalls.length, `${rawCalls.length} calls`);

    // 30. no evaluation or gold-truth artifact in the runtime fixture path
    const stray = readdirSync(dir).filter((f) => EVALUATION_ARTIFACT_PATTERNS.some((pat) => f.toLowerCase().includes(pat)));
    p(30, 'no evaluation or gold artifact in the runtime fixture', stray.length === 0, stray.join(', ') || 'none');

    // 32. the manifest's own status follows from the recomputed facts, not the other way round
    const recomputedStatusLabel = (complexity === 'deep' && successful.length >= 2 && recomputedStatus === 'SUCCESS') ? 'CAPTURED' : 'FAILED';
    p(32, 'manifest captureStatus follows from recomputed facts', manifest.captureStatus === recomputedStatusLabel,
      `recomputed ${recomputedStatusLabel}, manifest ${manifest.captureStatus}`);
  }

  // 7. exactly one attempt per source candidate, across the whole session
  const sources = all.map((a) => a.manifest.sourceCandidateId);
  check(7, 'exactly one attempt per source candidate', new Set(sources).size === sources.length, sources.join(', '));
  check('7b', 'exactly one attempt per fixture id', new Set(fixtureIds).size === fixtureIds.length, fixtureIds.join(', '));

  // 24. global call budget, recounted across every candidate
  const globalCalls = all.reduce((n, a) => n + a.rawCalls.length, 0);
  check(24, 'global call count within budget', globalCalls <= globalCallBudget, `${globalCalls} <= ${globalCallBudget}`);
  check('24b', 'global call count matches the session record', globalCalls === session.globalLiveCallCount, `${globalCalls}`);
  check('24c', 'session records the authorized global call budget',
    session.globalCallBudget == null || session.globalCallBudget === globalCallBudget,
    `${session.globalCallBudget ?? 'historical-unrecorded'} vs ${globalCallBudget}`);

  // 25 (session scope). The journal is the write-ahead record; nothing may exist outside it.
  const journalPath = join(realRoot, 'journal.ndjson');
  const journal = readFileSync(journalPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  check('25b', 'every recorded call appears in the write-ahead journal', journal.length === globalCalls, `${journal.length} journalled, ${globalCalls} in artifacts`);
  const journalSeqs = journal.map((c) => c.seq).sort((x, y) => x - y);
  check('25c', 'journal sequence is complete and gapless', journalSeqs.every((s, i) => s === i + 1), journalSeqs.join(','));

  // 31. runtime fingerprint unchanged across the whole capture
  check(31, 'runtime fingerprint start equals end',
    session.runtimeFingerprintStartSha256 === session.runtimeFingerprintEndSha256,
    `${session.runtimeFingerprintStartSha256} vs ${session.runtimeFingerprintEndSha256}`);

  return { checks, ok: checks.every((c) => c.ok), failures: checks.filter((c) => !c.ok) };
}

function TEMPERATURE_DETAIL(manifest) {
  return manifest.temperaturePolicy ?? '(no policy recorded)';
}

/**
 * Confirms the superseded synthetic fixtures and their ground truth are byte-unchanged.
 *
 * The real capture supersedes this material but must not disturb it: an altered synthetic
 * fixture would make the supersession itself unauditable, since the thing being replaced
 * would no longer be the thing that was reviewed. Parameterized by root so a test can
 * tamper with a copy and prove the check fires, rather than trusting that it would.
 */
export function verifySyntheticUnchanged({ syntheticRoot, evaluationRoot, freezeManifestPath }) {
  const checks = [];
  const check = (id, name, ok, detail = '') => {
    checks.push({ id, name, ok: Boolean(ok), detail: String(detail) });
  };
  const freeze = JSON.parse(readFileSync(freezeManifestPath, 'utf8'));

  for (const entry of freeze.fixtures) {
    const dir = join(syntheticRoot, entry.fixtureId);
    const manifestPath = join(dir, 'fixture-manifest.json');
    const manifestBytes = readFileSync(manifestPath, 'utf8');
    check(`${entry.fixtureId}/manifest`, 'synthetic fixture manifest unchanged',
      sha256(manifestBytes) === entry.fixtureManifestSha256, entry.fixtureId);

    const manifest = JSON.parse(manifestBytes);
    for (const [file, expected] of Object.entries(manifest.fileHashes)) {
      // The freeze hashed mission and round1 files after `.trim()`, because the loader
      // trims them before they enter the snapshot. Reproducing that convention exactly is
      // the point: the check has to recompute the frozen hash, not a different one that
      // happens to also be stable.
      const raw = readFileSync(join(dir, file), 'utf8');
      const hashed = /^(mission|round1)-/.test(file) ? raw.trim() : raw;
      check(`${entry.fixtureId}/${file}`, 'synthetic fixture file unchanged',
        sha256(hashed) === expected, file);
    }

    for (const [name, expected] of [['conflict-labels.json', entry.conflictLabelsSha256], ['gold-issues.json', entry.goldIssuesSha256]]) {
      const path = join(evaluationRoot, entry.fixtureId, name);
      check(`${entry.fixtureId}/${name}`, 'archived ground truth unchanged',
        sha256(readFileSync(path, 'utf8')) === expected, name);
    }
  }

  return { checks, ok: checks.every((c) => c.ok), failures: checks.filter((c) => !c.ok) };
}
