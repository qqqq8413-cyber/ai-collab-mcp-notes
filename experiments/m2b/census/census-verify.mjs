/**
 * Offline verifier for a CBRP census artifact.
 *
 * Recomputes rather than reads. Every self-reported field in the session — the event
 * flags, k, the bounds, the zone — is derived again from the artifacts it claims to
 * summarize, because a summary that agrees with itself proves nothing. The one thing the
 * verifier trusts is the frozen task manifest it is handed, which is the input the study
 * was preregistered against.
 *
 * Never calls a provider and never writes to the session directory.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ATTEMPT_RESERVED, ATTEMPT_SETTLED, readRecords } from './attempt-registry.mjs';
import { CENSUS_ALLOWED_STAGES, GLOBAL_LOGICAL_CALL_BUDGET, PER_TASK_LOGICAL_CALL_BUDGET, TRANSPORT_RETRY_POLICY } from './planning-recorder.mjs';
import { APPROVED_COMPILER, APPROVED_NODE_VERSION, matchesCensusBaseline } from './census-provenance.mjs';
import { toolchainProblems } from './build-binding.mjs';
import { ALPHA, BETA, CBRP_N, METHOD_VERSION, THETA_FEAS, decide } from './statistics.mjs';
import { NO_STATISTICAL_VERDICT, SESSION_COMPLETE, STUDY_VERSION, deriveEvents } from './census-session.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) => JSON.stringify(value, null, 2);

export function verifyCensus({ outDir, tasks, expectedPin, expectedN = CBRP_N }) {
  const checks = [];
  const q = (id, name, ok, detail = '') => { checks.push({ id, name, ok: Boolean(ok), detail: String(detail) }); return Boolean(ok); };

  const sessionPath = join(outDir, 'census-session.json');
  if (!existsSync(sessionPath)) {
    q(1, 'census-session.json exists', false, sessionPath);
    return { checks, ok: false, failures: checks };
  }
  const session = JSON.parse(readFileSync(sessionPath, 'utf8'));

  // 1. identity and seal
  q(1, 'study and method versions are the census ones', session.studyVersion === STUDY_VERSION && session.methodVersion === METHOD_VERSION,
    `${session.studyVersion} / ${session.methodVersion}`);
  const { sessionSha256, ...unsealed } = session;
  q(2, 'session seal recomputes', sha256(canonical(unsealed)) === sessionSha256, sessionSha256);
  q(3, 'statistical parameters are the preregistered ones',
    session.N === expectedN && session.alpha === ALPHA && session.beta === BETA && session.thetaFeas === THETA_FEAS,
    `N=${session.N} alpha=${session.alpha} beta=${session.beta} theta=${session.thetaFeas}`);

  // 2. manifest <-> artifacts bijection
  const manifestIds = tasks.map((t) => t.taskId);
  const resultIds = session.results.map((r) => r.taskId);
  q(4, 'every result task is in the manifest', resultIds.every((id) => manifestIds.includes(id)), resultIds.join(', '));
  q('4b', 'no task appears twice in the results', new Set(resultIds).size === resultIds.length, `${new Set(resultIds).size}/${resultIds.length}`);
  q('4c', 'task hashes match the frozen manifest', session.results.every((r) => {
    const task = tasks.find((t) => t.taskId === r.taskId);
    return task && task.taskSha256 === r.taskSha256 && sha256(task.text) === r.taskSha256;
  }), 'recomputed from the frozen text');
  if (session.sessionStatus === SESSION_COMPLETE) {
    q('4d', 'a complete session covers every manifest task exactly once',
      new Set(resultIds).size === manifestIds.length && manifestIds.every((id) => resultIds.includes(id)),
      `${new Set(resultIds).size} of ${manifestIds.length}`);
    q('4e', 'a complete session has exactly N unique tasks', new Set(resultIds).size === expectedN, `${new Set(resultIds).size}`);
  }

  // 3. attempt registry consistency
  const registry = readRecords(join(outDir, 'attempt-registry.ndjson'));
  const reserved = registry.filter((r) => r.state === ATTEMPT_RESERVED);
  const settled = registry.filter((r) => r.state === ATTEMPT_SETTLED);
  q(5, 'every reservation has exactly one settlement',
    reserved.length === settled.length
      && reserved.every((r) => settled.filter((s) => s.key === r.key).length === 1),
    `${reserved.length} reserved, ${settled.length} settled`);
  q('5b', 'every reservation precedes its settlement in the journal',
    reserved.every((r) => {
      const s = settled.find((x) => x.key === r.key);
      return s && s.seq > r.seq;
    }), 'by sequence');
  q('5c', 'no task reserved an attempt twice',
    new Set(reserved.map((r) => r.key)).size === reserved.length, `${reserved.length}`);
  q('5d', 'registry attempts match the recorded results',
    reserved.length === session.results.length, `${reserved.length} vs ${session.results.length}`);

  // 4. call journal, budget and stage discipline
  const journalPath = join(outDir, 'planning-journal.ndjson');
  const journal = existsSync(journalPath)
    ? readFileSync(journalPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  q(6, 'journal matches the session call record', journal.length === session.calls.length
    && journal.every((c, i) => JSON.stringify(c) === JSON.stringify(session.calls[i])), `${journal.length}`);
  const seqs = session.calls.map((c) => c.seq);
  q('6b', 'call sequence is complete and gapless', seqs.every((s, i) => s === i + 1), seqs.join(','));
  q(7, 'only the planning stage appears', session.calls.every((c) => CENSUS_ALLOWED_STAGES.includes(c.stage)),
    [...new Set(session.calls.map((c) => c.stage))].join(', ') || 'none');
  q('7b', 'no worker, gate, synthesis or round 2 call exists',
    !session.calls.some((c) => ['round1_worker', 'synthesis', 'synthesis_gate', 'round2_worker', 'decision_synthesis'].includes(c.stage)),
    '0 post-planning calls');
  q(8, 'global logical call budget respected',
    session.calls.length <= session.logicalCallBudget && session.logicalCallBudget === GLOBAL_LOGICAL_CALL_BUDGET,
    `${session.calls.length} <= ${session.logicalCallBudget}`);
  q('8b', 'per-task budget respected', session.results.every((r) =>
    session.calls.filter((c) => c.taskId === r.taskId).length <= PER_TASK_LOGICAL_CALL_BUDGET),
    `<= ${PER_TASK_LOGICAL_CALL_BUDGET} per task`);

  // 5. routing and transport
  q(9, 'every call requested the expected pin',
    session.calls.every((c) => c.providerRequested === expectedPin.provider && c.modelRequested === expectedPin.model),
    `${expectedPin.provider}/${expectedPin.model}`);
  q('9b', 'every successful call resolved to the expected pin',
    session.calls.filter((c) => c.success).every((c) => c.providerResolved === expectedPin.provider && c.modelResolved === expectedPin.model),
    'requested === resolved');
  q(10, 'every call recorded the explicit no-retry transport policy',
    session.calls.every((c) => c.transportRetryPolicy === TRANSPORT_RETRY_POLICY && c.transportMaxRetriesRequested === 0),
    TRANSPORT_RETRY_POLICY);

  // 6. build binding and dependency provenance
  q(11, 'dist was built from the authorized source', session.buildBinding?.match === true,
    `${session.buildBinding?.referenceDistDigest ?? 'absent'} vs ${session.buildBinding?.executionDistDigest ?? 'absent'}`);
  q('11b', 'the build binding names the execution head',
    session.buildBinding?.executionHead === session.executionHead, session.executionHead ?? 'absent');
  // The toolchain is part of the proof, not a footnote: reference and execution digests
  // agreeing says the two trees match, never that an approved compiler made either.
  const toolProblems = toolchainProblems(session.buildBinding?.toolchain);
  q('11c', 'the build toolchain matches the approved one', toolProblems.length === 0, toolProblems.join(' | ') || 'approved');
  q('11d', 'the recorded Node runtime is the approved one',
    session.buildBinding?.toolchain?.nodeVersion === APPROVED_NODE_VERSION
      && session.dependencyProvenance?.node?.version === APPROVED_NODE_VERSION,
    `${session.buildBinding?.toolchain?.nodeVersion ?? 'absent'} vs ${APPROVED_NODE_VERSION}`);
  q('11e', 'the compiler that built dist resolves inside the approved package',
    session.buildBinding?.toolchain?.compilerResolvesInsideApprovedPackage === true
      && session.buildBinding?.toolchain?.compilerExecutableRelative === APPROVED_COMPILER.executableRelative
      && session.buildBinding?.toolchain?.compilerExecutableSha256 === APPROVED_COMPILER.executableSha256,
    session.buildBinding?.toolchain?.compilerExecutableRelative ?? 'absent');

  const depProblems = matchesCensusBaseline(session.dependencyProvenance ?? {});
  q(12, 'dependency provenance equals the census baseline', depProblems.length === 0, depProblems.join(' | ') || 'identical');
  q('12c', 'the toolchain packages are attested alongside the runtime ones',
    ['typescript', APPROVED_COMPILER.package].every((name) =>
      (session.dependencyProvenance?.packages ?? []).some((p) => p.name === name && typeof p.runtimePackageDigest === 'string')),
    'typescript + native compiler digests present');
  q('12b', 'Zod provenance is attested',
    (session.dependencyProvenance?.packages ?? []).some((p) => p.name === 'zod' && typeof p.runtimePackageDigest === 'string'),
    'zod digest present');

  // 7. events recomputed from the post-enforcement plan, never read back
  let eventsOk = true;
  for (const result of session.results) {
    if (!result.plan) continue;
    const recomputed = deriveEvents(result.plan);
    if (recomputed.eventDeep !== result.eventDeep
      || recomputed.eventAssignedGte2 !== result.eventAssignedGte2
      || recomputed.eventJoint !== result.eventJoint) eventsOk = false;
  }
  q(13, 'every event flag recomputes from its own post-enforcement plan', eventsOk, 'recomputed');
  q('13b', 'assignment counts come from the enforced plan, not a raw response',
    session.results.every((r) => !r.plan || r.eventAssignedGte2 === (r.plan.assignments.length >= 2)),
    'plan.assignments.length');

  // 8. statistical recomputation
  const usable = session.results.filter((r) => r.failureCategory === null && r.plan);
  const verdictAllowed = session.sessionStatus === SESSION_COMPLETE
    && usable.length === expectedN
    && new Set(usable.map((r) => r.taskId)).size === expectedN;
  if (verdictAllowed) {
    const k = usable.filter((r) => deriveEvents(r.plan).eventJoint).length;
    q(14, 'k recomputes from the artifacts', k === session.k, `${k} vs ${session.k}`);
    const recomputed = decide(k, { n: expectedN, alpha: ALPHA, beta: BETA, thetaFeas: THETA_FEAS });
    q('14b', 'bounds recompute', recomputed.lower === session.statistics.lower && recomputed.upper === session.statistics.upper,
      `${recomputed.lower} / ${recomputed.upper}`);
    q('14c', 'decision zone recomputes', recomputed.zone === session.statistics.zone, recomputed.zone);
  } else {
    q(14, 'an incomplete session produces no statistical verdict',
      session.k === null && session.statistics?.verdict === NO_STATISTICAL_VERDICT,
      session.statistics?.verdict ?? 'absent');
  }

  return { checks, ok: checks.every((c) => c.ok), failures: checks.filter((c) => !c.ok) };
}

export { sha256 };
