import assert from 'node:assert/strict';
// Child processes and fs fault injection are test machinery only: they race real store
// instances and simulate crashes. Nothing here reaches production code.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as admission from './dist/automation/admission.js';
import { InMemoryControllerStore } from './dist/automation/audit.js';
import { AutomationController } from './dist/automation/controller.js';
import { FileControllerStore } from './dist/automation/durable-store.js';

const { InvalidChangeIdentityError, RunAdmissionIntegrityError, RunAdmissionRefusedError } = admission;
const ROOT = dirname(fileURLToPath(import.meta.url));
const A = 'a'.repeat(40), B = 'b'.repeat(40), T = '2026-09-26T00:00:00.000Z';
const G = { id: 'architect', role: 'GPT_ARCHITECT' }, X = { id: 'implementer', role: 'CODEX_IMPLEMENTER' };
const H = { id: 'human', role: 'HUMAN' }, K = { id: 'controller', role: 'CONTROLLER' };
const REPO = 'synthetic/example', SLICE = 'slice-1', CHANGE = { repository: REPO, sliceId: SLICE };
const clock = { now: () => T };

const tests = [];
const check = (name, fn) => tests.push({ name, fn });

const sha = (text) => createHash('sha256').update(text).digest('hex');
// The change key, computed here independently of the implementation.
const keyOf = (repository = REPO, sliceId = SLICE) => sha(`chief.change.v1\0${repository}\0${sliceId}`);
const fresh = (runId, sliceId = SLICE, repository = REPO) => ({ runId, sliceId, repository, state: 'IDLE',
  implementationIterations: 0, acceptanceFailures: 0, audit: [] });
const runFiles = (dir) => readdirSync(dir).filter((name) => /^[0-9a-f]{64}\.json$/.test(name)).sort();
const runFile = (dir, runId) => join(dir, `${sha(runId)}.json`);
const claimFile = (dir, key = keyOf()) => join(dir, 'changes', `${key}.json`);
const claims = (dir) => readdirSync(join(dir, 'changes')).filter((name) => /^[0-9a-f]{64}\.json$/.test(name)).sort();
function refused(fn, expected = {}) {
  let caught;
  try { fn(); } catch (error) { caught = error; }
  assert.ok(caught instanceof RunAdmissionRefusedError, `expected SECOND_RUN_FOR_CHANGE, got ${caught?.stack ?? 'no error'}`);
  assert.equal(caught.code, 'SECOND_RUN_FOR_CHANGE');
  for (const [field, value] of Object.entries(expected)) assert.equal(caught[field], value, field);
  return caught;
}
const failsClosed = (fn, code) => assert.throws(fn, (error) => error instanceof RunAdmissionIntegrityError && error.code === code,
  `expected ${code}`);
const invalidIdentity = (fn, field) => assert.throws(fn, (error) => error instanceof InvalidChangeIdentityError &&
  error.code === 'INVALID_CHANGE_IDENTITY' && error.field === field);
/** Swaps one node:fs function, for this process's ESM importers too, for the duration of fn. */
function withFs(name, replace, fn) {
  const original = fs[name];
  fs[name] = replace(original); syncBuiltinESMExports();
  try { return fn(); } finally { fs[name] = original; syncBuiltinESMExports(); }
}
/** Rewrites the stored admission record as bit rot or a writer around the store would. */
function rewriteClaim(dir, mutate, { reseal = true, key = keyOf() } = {}) {
  const file = claimFile(dir, key), envelope = JSON.parse(readFileSync(file, 'utf8'));
  mutate(envelope.record);
  if (reseal) envelope.checksum = sha(JSON.stringify(envelope.record));
  writeFileSync(file, JSON.stringify(envelope));
}
/** A run file exactly as the store wrote runs before admission existed. */
function writeLegacyRun(dir, run) {
  const payload = JSON.stringify(run);
  writeFileSync(runFile(dir, run.runId), JSON.stringify({ schemaVersion: 1, run: JSON.parse(payload), checksum: sha(payload) }));
}

// ---------------------------------------------------------------- lifecycle fixtures
function fakeReality() {
  return { workSha: B, mainSha: A,
    observeBranch(repository, branch) { return { repository, branch, sha: branch === 'main' ? this.mainSha : this.workSha, observedAt: T }; },
    compare(repository, baseSha, headSha) { return { repository, baseSha, headSha, aheadBy: 1, behindBy: 0, hasBaseOnlyCommits: false, observedAt: T }; },
    observeCi(repository, branch, sha) { return { repository, branch, sha, workflowStatus: 'SUCCESS', requiredCheckName: 'test',
      requiredCheckStatus: 'SUCCESS', observedAt: T }; },
    observeProtection(repository, branch) { return { repository, branch, protected: true, requiredChecks: ['test'], observedAt: T }; } };
}
function packet() {
  return { packetId: 'packet-1', packetVersion: 1, sliceId: SLICE, expectedBaseSha: A, targetBranch: 'work/synthetic-1',
    objective: 'Offline fixture', allowedAreas: ['src/automation'], forbiddenChanges: ['src/stress-test'],
    invariants: ['human authority'], acceptanceCriteria: ['checks pass'],
    validationCommands: [{ commandId: 'test', executable: 'npm', args: ['test'], cwd: '.', classification: 'OFFLINE_VALIDATION' }],
    networkAuthorization: { level: 'WRITE_EXTERNAL', destinations: ['main', 'work/synthetic-1'], purpose: 'fixture', budget: 1 },
    providerCallAuthorization: { allowed: false, calls: [], maxCalls: 0, budget: 0 },
    destructiveOperationAuthorization: { allowed: false },
    iterationBudget: { maxImplementationIterationsPerSlice: 3, maxAcceptanceFailuresPerSlice: 3,
      maxRuntimeMinutesPerIteration: 60, maxParallelImplementationAgents: 1 } };
}
const decision = (c) => ({ reviewId: 'review-1', actor: 'GPT_ARCHITECT', packetId: 'packet-1', packetHash: c.get('run-1').activePacketHash,
  reviewedSha: B, decision: 'ACCEPT', findings: [], evidenceReferences: ['remote diff'], issuedAt: T });
const promotion = { authorizationId: 'auth-promote', actorRole: 'HUMAN', operation: 'FAST_FORWARD_MAIN', target: 'main',
  runId: 'run-1', packetId: 'packet-1', issuedAt: T, reason: 'synthetic authorization' };
const PATHS = {
  IDLE: () => {},
  ARCHITECTURE: (c) => c.enterArchitecture('run-1', G),
  PACKET_READY: (c) => { PATHS.ARCHITECTURE(c); c.issuePacket('run-1', G, packet()); },
  IMPLEMENTING: (c) => { PATHS.PACKET_READY(c); c.beginImplementation('run-1', X); },
  SOFT_STOP: (c) => { PATHS.IMPLEMENTING(c); c.stop('run-1', K, 'SOFT_STOP', 'build failed'); },
  ARCHITECTURE_STOP: (c) => { PATHS.PACKET_READY(c); c.stop('run-1', G, 'ARCHITECTURE_STOP', 'packet conflict'); },
  HUMAN_STOP: (c) => { PATHS.IMPLEMENTING(c); c.stop('run-1', H, 'HUMAN_STOP', 'pause'); },
  ACCEPTED: (c) => { PATHS.IMPLEMENTING(c); c.completeImplementation('run-1', X, ['offline checks']); c.recordRemoteSha('run-1', X);
    c.beginAcceptanceReview('run-1', G); c.decideAcceptance('run-1', G, decision(c)); },
  CLOSED: (c, reality) => { PATHS.ACCEPTED(c); c.requestPromotion('run-1', H, promotion); c.beginPromotion('run-1', K);
    reality.mainSha = B; c.recordPromotedMain('run-1', K); c.close('run-1', K); },
  FAILED_CLOSED: (c) => { PATHS.IMPLEMENTING(c); c.failClosed('run-1', K, 'unreconcilable'); },
};

// ---------------------------------------------------------------- shared conformance
const STORES = {
  memory: (_dir, storeClock = clock) => new InMemoryControllerStore(storeClock),
  file: (dir, storeClock = clock) => new FileControllerStore(dir, storeClock),
};
for (const [kind, open] of Object.entries(STORES)) {
  check(`${kind}: the first run of a change is admitted as its ROOT`, (dir) => {
    const store = open(dir); const c = new AutomationController(clock, store, fakeReality());
    c.createRun('run-1', SLICE, REPO);
    assert.deepEqual(store.admissionRecord(CHANGE), { schemaVersion: 1, kind: 'CHANGE_ADMISSION', recordClass: 'OPERATIONAL_RECORD',
      ruleset: 'CHIEF-GOV/1', changeKey: keyOf(), repository: REPO, sliceId: SLICE, rootRunId: 'run-1', admittedAt: T,
      lineage: [{ runId: 'run-1', relation: 'ROOT' }], reserved: { continuations: [] } });
    assert.equal(admission.changeKeyOf(CHANGE), keyOf());
    assert.equal(c.get('run-1').state, 'IDLE');
  });
  check(`${kind}: a second runId for the same change is refused, through the controller and the store directly`, (dir) => {
    const store = open(dir); const c = new AutomationController(clock, store, fakeReality());
    c.createRun('run-1', SLICE, REPO);
    const before = JSON.stringify(store.get('run-1'));
    const fields = { ruleset: 'CHIEF-GOV/1', changeKey: keyOf(), repository: REPO, sliceId: SLICE, existingRootRunId: 'run-1' };
    const viaController = refused(() => c.createRun('run-2', SLICE, REPO), { ...fields, requestedRunId: 'run-2' });
    refused(() => store.create(fresh('run-3')), { ...fields, requestedRunId: 'run-3' });
    assert.equal(viaController.evidenceRecorded, true);
    assert.equal(store.get('run-2'), undefined);
    assert.equal(store.get('run-3'), undefined);
    assert.throws(() => c.get('run-2'), /Unknown controller run/);
    assert.equal(JSON.stringify(store.get('run-1')), before);
    assert.equal(store.admissionRecord(CHANGE).rootRunId, 'run-1');
    if (kind === 'file') assert.deepEqual(runFiles(dir), [`${sha('run-1')}.json`]);
  });
  check(`${kind}: the second run is refused whatever state the ROOT is in, and the ROOT is untouched`, (dir) => {
    for (const [state, path] of Object.entries(PATHS)) {
      const at = join(dir, state); const store = open(at); const reality = fakeReality();
      const c = new AutomationController(clock, store, reality);
      c.createRun('run-1', SLICE, REPO); path(c, reality);
      assert.equal(c.get('run-1').state, state);
      const before = JSON.stringify(c.get('run-1'));
      refused(() => c.createRun('run-2', SLICE, REPO), { existingRootRunId: 'run-1', requestedRunId: 'run-2' });
      refused(() => store.create(fresh('run-2')));
      assert.equal(JSON.stringify(c.get('run-1')), before, `${state} root changed`);
      assert.equal(store.get('run-2'), undefined, `${state} admitted a second run`);
    }
  });
  check(`${kind}: sliceId is exact and case-sensitive; other changes never contend`, (dir) => {
    const store = open(dir); const c = new AutomationController(clock, store, fakeReality());
    c.createRun('run-1', SLICE, REPO);
    c.createRun('run-2', 'Slice-1', REPO);
    c.createRun('run-3', 'SLICE-1', REPO);
    c.createRun('run-4', 'slice-2', REPO);
    c.createRun('run-5', SLICE, 'synthetic/other');
    assert.equal(store.admissionRecord({ repository: REPO, sliceId: 'Slice-1' }).changeKey, keyOf(REPO, 'Slice-1'));
    assert.notEqual(keyOf(REPO, 'Slice-1'), keyOf());
    for (const [runId, sliceId, repository] of [['run-1', SLICE, REPO], ['run-2', 'Slice-1', REPO], ['run-3', 'SLICE-1', REPO],
      ['run-4', 'slice-2', REPO], ['run-5', SLICE, 'synthetic/other']]) {
      assert.equal(store.admissionRecord({ repository, sliceId }).rootRunId, runId);
    }
    refused(() => c.createRun('run-6', 'Slice-1', REPO), { existingRootRunId: 'run-2' });
  });
  check(`${kind}: invalid or non-canonical identities are rejected, never rewritten, and create nothing`, (dir) => {
    const store = open(dir); const c = new AutomationController(clock, store, fakeReality());
    // Blank or non-string identities are refused first by the fresh-run check (validation order:
    // fresh run, then identity); the identity parser refuses every other non-canonical spelling.
    for (const sliceId of ['', ' ', 42, undefined]) {
      assert.throws(() => store.create({ ...fresh('run-x'), sliceId }), /a run must be created empty in IDLE/);
      if (typeof sliceId === 'string') invalidIdentity(() => c.createRun('run-x', sliceId, REPO), 'sliceId');
    }
    for (const sliceId of ['-slice', '.slice', '_slice', 'slice 1', 'slice/1', 'slice:1', 'sl\u00efce', 'slice\u200b', 'a'.repeat(129),
      'slice-1\n', 'slice-1\0']) {
      invalidIdentity(() => store.create({ ...fresh('run-x'), sliceId }), 'sliceId');
      invalidIdentity(() => c.createRun('run-x', sliceId, REPO), 'sliceId');
    }
    assert.throws(() => store.create({ ...fresh('run-x'), repository: '' }), /a run must be created empty in IDLE/);
    for (const repository of ['', 'synthetic', 'synthetic/example/x', 'synthetic /example', 'synthetic/exam ple', 'https://github.com/synthetic/example']) {
      if (repository) invalidIdentity(() => store.create({ ...fresh('run-x'), repository }), 'repository');
      invalidIdentity(() => c.createRun('run-x', SLICE, repository), 'repository');
    }
    assert.equal(store.get('run-x'), undefined);
    assert.equal(store.admissionRecord(CHANGE), undefined);
    if (kind === 'file') { assert.deepEqual(runFiles(dir), []); assert.deepEqual(claims(dir), []); }
    c.createRun('run-1', 'a'.repeat(128), REPO);
    assert.equal(store.admissionRecord({ repository: REPO, sliceId: 'a'.repeat(128) }).rootRunId, 'run-1');
  });
  check(`${kind}: leading or trailing whitespace cannot name another change`, (dir) => {
    const store = open(dir); const c = new AutomationController(clock, store, fakeReality());
    c.createRun('run-1', SLICE, REPO);
    for (const alias of [` ${SLICE}`, `${SLICE} `, `\t${SLICE}`, `${SLICE}\n`, `\u00a0${SLICE}`]) {
      invalidIdentity(() => c.createRun('run-2', alias, REPO), 'sliceId');
      invalidIdentity(() => store.create(fresh('run-2', alias)), 'sliceId');
    }
    for (const alias of [` ${REPO}`, `${REPO} `]) {
      invalidIdentity(() => c.createRun('run-2', SLICE, alias), 'repository');
      invalidIdentity(() => store.create(fresh('run-2', SLICE, alias)), 'repository');
    }
    assert.equal(store.get('run-2'), undefined);
    refused(() => c.createRun('run-2', SLICE, REPO));
  });
  check(`${kind}: the same runId twice keeps the duplicate semantics, and a used runId never blocks another change`, (dir) => {
    const store = open(dir); const c = new AutomationController(clock, store, fakeReality());
    c.createRun('run-1', SLICE, REPO);
    assert.throws(() => c.createRun('run-1', SLICE, REPO), /Duplicate runId/);
    assert.throws(() => store.create(fresh('run-1', 'slice-2')), /Duplicate runId/);
    assert.deepEqual(store.admissionRefusals(CHANGE), []);
    assert.equal(store.admissionRecord({ repository: REPO, sliceId: 'slice-2' }), undefined);
    c.createRun('run-2', 'slice-2', REPO);
    assert.equal(store.admissionRecord({ repository: REPO, sliceId: 'slice-2' }).rootRunId, 'run-2');
  });
  check(`${kind}: refusal evidence is an append-only OPERATIONAL_RECORD and never changes the admission`, (dir) => {
    const store = open(dir); store.create(fresh('run-1'));
    const admitted = JSON.stringify(store.admissionRecord(CHANGE));
    const fileBefore = kind === 'file' ? readFileSync(claimFile(dir), 'utf8') : undefined;
    refused(() => store.create(fresh('run-2')));
    const first = store.admissionRefusals(CHANGE);
    refused(() => store.create(fresh('run-3')));
    const all = store.admissionRefusals(CHANGE);
    assert.equal(all.length, 2);
    assert.ok(all.some((record) => JSON.stringify(record) === JSON.stringify(first[0])), 'an earlier refusal record changed');
    for (const record of all) {
      assert.deepEqual(Object.keys(record).sort(), ['changeKey', 'code', 'existingRootRunId', 'kind', 'recordClass', 'refusedAt',
        'repository', 'requestedRunId', 'ruleset', 'schemaVersion', 'sliceId']);
      assert.equal(record.recordClass, 'OPERATIONAL_RECORD');
      assert.equal(record.kind, 'CHANGE_ADMISSION_REFUSAL');
      assert.equal(record.code, 'SECOND_RUN_FOR_CHANGE');
      assert.equal(record.existingRootRunId, 'run-1');
    }
    assert.deepEqual(all.map((record) => record.requestedRunId).sort(), ['run-2', 'run-3']);
    assert.equal(JSON.stringify(store.admissionRecord(CHANGE)), admitted);
    if (kind === 'file') assert.equal(readFileSync(claimFile(dir), 'utf8'), fileBefore);
  });
  check(`${kind}: a refusal whose evidence cannot be recorded is still a refusal`, (dir) => {
    let calls = 0;
    const failing = { now: () => (calls++ === 0 ? T : 'not a timestamp') };
    const store = open(dir, failing); store.create(fresh('run-1'));
    const error = refused(() => store.create(fresh('run-2')), { existingRootRunId: 'run-1' });
    assert.equal(error.evidenceRecorded, false);
    assert.deepEqual(store.admissionRefusals(CHANGE), []);
    assert.equal(store.get('run-2'), undefined);
    if (kind === 'file') assert.equal(existsSync(runFile(dir, 'run-2')), false);
  });
}

// ---------------------------------------------------------------- file store
check('file: a second store instance on the same directory refuses the second run', (dir) => {
  new AutomationController(clock, new FileControllerStore(dir, clock), fakeReality()).createRun('run-1', SLICE, REPO);
  const other = new FileControllerStore(dir, clock);
  refused(() => other.create(fresh('run-2')), { existingRootRunId: 'run-1' });
  refused(() => new AutomationController(clock, new FileControllerStore(dir, clock), fakeReality()).createRun('run-3', SLICE, REPO));
  assert.deepEqual(runFiles(dir), [`${sha('run-1')}.json`]);
  assert.equal(other.admissionRefusals(CHANGE).length, 2);
});
check('file: CLOSED and FAILED_CLOSED roots keep their change closed after a restart', (dir) => {
  for (const state of ['CLOSED', 'FAILED_CLOSED']) {
    const at = join(dir, state), reality = fakeReality();
    const c = new AutomationController(clock, new FileControllerStore(at, clock), reality);
    c.createRun('run-1', SLICE, REPO); PATHS[state](c, reality);
    const restarted = new AutomationController(clock, new FileControllerStore(at, clock), reality);
    assert.equal(restarted.get('run-1').state, state);
    refused(() => restarted.createRun('run-2', SLICE, REPO), { existingRootRunId: 'run-1' });
    assert.deepEqual(runFiles(at), [`${sha('run-1')}.json`]);
  }
});
check('file: a crash between claim and run leaves ROOT_PENDING: only the same run can finish it', (dir) => {
  const store = new FileControllerStore(dir, clock);
  // The run's durable write fails after the claim is published: the process "dies" there.
  assert.throws(() => withFs('renameSync', () => () => { throw new Error('crash before the run is written'); },
    () => store.create(fresh('run-1'))), /crash before the run is written/);
  assert.equal(readFileSync(claimFile(dir), 'utf8').length > 0, true);
  assert.deepEqual(runFiles(dir), []);
  const reopened = new FileControllerStore(dir, clock);
  assert.equal(reopened.get('run-1'), undefined);
  assert.equal(reopened.admissionRecord(CHANGE).rootRunId, 'run-1');
  refused(() => reopened.create(fresh('run-2')), { existingRootRunId: 'run-1', requestedRunId: 'run-2' });
  invalidIdentity(() => reopened.create(fresh('run-1', `${SLICE} `)), 'sliceId');
  const claim = readFileSync(claimFile(dir), 'utf8');
  reopened.create(fresh('run-1'));
  assert.equal(readFileSync(claimFile(dir), 'utf8'), claim, 'finishing a pending ROOT rewrote its claim');
  assert.equal(new FileControllerStore(dir, clock).get('run-1').state, 'IDLE');
  assert.deepEqual(runFiles(dir), [`${sha('run-1')}.json`]);
  assert.throws(() => reopened.create(fresh('run-1')), /Duplicate runId/);
});
check('file: a process killed after its claim keeps the change; its stale run lock fails closed until a human clears it', async (dir) => {
  const script = `
    import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    import { FileControllerStore } from './dist/automation/durable-store.js';
    const store = new FileControllerStore(process.argv[1]);
    fs.renameSync = () => process.exit(9); syncBuiltinESMExports();
    store.create({ runId: 'run-1', sliceId: 'slice-1', repository: 'synthetic/example', state: 'IDLE',
      implementationIterations: 0, acceptanceFailures: 0, audit: [] });`;
  const status = await new Promise((resolve) => spawn(process.execPath, ['--input-type=module', '-e', script, dir], { cwd: ROOT })
    .on('close', resolve));
  assert.equal(status, 9);
  const lock = `${runFile(dir, 'run-1')}.lock`;
  assert.ok(existsSync(lock), 'the killed writer left its run lock');
  assert.ok(readdirSync(dir).some((name) => name.endsWith('.tmp')), 'the killed writer left its run temp');
  assert.deepEqual(runFiles(dir), []);
  const store = new FileControllerStore(dir, clock);
  assert.throws(() => store.create(fresh('run-1')), (error) => error.code === 'EEXIST');
  assert.ok(existsSync(lock), 'an uncertain lock was removed');
  refused(() => store.create(fresh('run-2')), { existingRootRunId: 'run-1' });
  rmSync(lock); // a human verified that no writer remains
  store.create(fresh('run-1'));
  assert.deepEqual(runFiles(dir), [`${sha('run-1')}.json`]);
  refused(() => store.create(fresh('run-3')));
});
check('file: a stale run lock without a claim admits nothing and blocks only that runId', (dir) => {
  const store = new FileControllerStore(dir, clock);
  const lock = `${runFile(dir, 'run-1')}.lock`;
  writeFileSync(lock, 'uncertain');
  assert.throws(() => store.create(fresh('run-1')), (error) => error.code === 'EEXIST');
  assert.equal(readFileSync(lock, 'utf8'), 'uncertain');
  assert.equal(store.admissionRecord(CHANGE), undefined);
  assert.deepEqual(claims(dir), []);
  store.create(fresh('run-2'));
  assert.equal(store.admissionRecord(CHANGE).rootRunId, 'run-2');
});
check('file: temp admission artifacts are never read and never decide', (dir) => {
  const store = new FileControllerStore(dir, clock);
  const loser = admission.admissionRecordOf(CHANGE, 'run-9', T);
  writeFileSync(join(dir, 'changes', `${keyOf()}.00000000-0000-4000-8000-000000000000.tmp`), admission.sealAdmissionRecord(loser));
  writeFileSync(join(dir, 'changes', `${keyOf()}.11111111-1111-4111-8111-111111111111.tmp`), '{"torn":');
  writeFileSync(join(dir, `${sha('run-1')}.json.22222222-2222-4222-8222-222222222222.tmp`), '{');
  store.create(fresh('run-1'));
  assert.equal(store.admissionRecord(CHANGE).rootRunId, 'run-1');
  refused(() => new FileControllerStore(dir, clock).create(fresh('run-9')), { existingRootRunId: 'run-1' });
  assert.equal(new FileControllerStore(dir, clock).get('run-1').runId, 'run-1');
  assert.equal(readdirSync(join(dir, 'changes')).filter((name) => name.endsWith('.tmp')).length, 2, 'a foreign temp was touched');
});
check('file: a run that predates admission fails closed and is never backfilled', (dir) => {
  writeLegacyRun(dir, fresh('run-legacy'));
  failsClosed(() => new FileControllerStore(dir, clock), 'LEGACY_UNINDEXED_RUN');
  assert.ok(!existsSync(join(dir, 'changes')) || claims(dir).length === 0, 'a legacy run was backfilled');
  const other = join(dir, 'non-canonical');
  mkdirSync(other);
  writeLegacyRun(other, fresh('run-legacy', 'my slice'));
  failsClosed(() => new FileControllerStore(other, clock), 'LEGACY_UNINDEXED_RUN');
  // A run that appears beside an open store is not operable either.
  const live = join(dir, 'live'); const store = new FileControllerStore(live, clock);
  store.create(fresh('run-1'));
  writeLegacyRun(live, fresh('run-legacy', 'slice-2'));
  failsClosed(() => store.get('run-legacy'), 'LEGACY_UNINDEXED_RUN');
  failsClosed(() => new FileControllerStore(live, clock), 'LEGACY_UNINDEXED_RUN');
  assert.equal(store.admissionRecord({ repository: REPO, sliceId: 'slice-2' }), undefined);
});
check('file: a corrupt admission record fails closed for create, load and open', (dir) => {
  const store = new FileControllerStore(dir, clock); store.create(fresh('run-1'));
  rewriteClaim(dir, (record) => { record.rootRunId = 'run-2'; record.lineage[0].runId = 'run-2'; }, { reseal: false });
  failsClosed(() => store.create(fresh('run-2')), 'ADMISSION_RECORD_INVALID');
  failsClosed(() => store.get('run-1'), 'ADMISSION_RECORD_INVALID');
  failsClosed(() => new FileControllerStore(dir, clock), 'ADMISSION_RECORD_INVALID');
  writeFileSync(claimFile(dir), '{"checksum":');
  failsClosed(() => store.create(fresh('run-2')), 'ADMISSION_RECORD_INVALID');
  assert.equal(existsSync(runFile(dir, 'run-2')), false);
});
check('file: an admission identity mismatch fails closed', (dir) => {
  const store = new FileControllerStore(dir, clock);
  store.create(fresh('run-1')); store.create(fresh('run-2', 'slice-2'));
  const original = readFileSync(claimFile(dir), 'utf8');
  // A valid record of another change filed under this change's key.
  writeFileSync(claimFile(dir), readFileSync(claimFile(dir, keyOf(REPO, 'slice-2'))));
  failsClosed(() => store.get('run-1'), 'ADMISSION_REGISTRY_MISMATCH');
  failsClosed(() => store.create(fresh('run-3')), 'ADMISSION_REGISTRY_MISMATCH');
  failsClosed(() => new FileControllerStore(dir, clock), 'ADMISSION_REGISTRY_MISMATCH');
  // A well-formed record that names another ROOT than the run on disk.
  writeFileSync(claimFile(dir), original);
  rewriteClaim(dir, (record) => { record.rootRunId = 'run-other'; record.lineage[0].runId = 'run-other'; });
  failsClosed(() => store.get('run-1'), 'ADMISSION_REGISTRY_MISMATCH');
  failsClosed(() => new FileControllerStore(dir, clock), 'ADMISSION_REGISTRY_MISMATCH');
  // An identity whose key is not the one it is stored under.
  writeFileSync(claimFile(dir), original);
  rewriteClaim(dir, (record) => { record.sliceId = 'slice-3'; });
  failsClosed(() => store.get('run-1'), 'ADMISSION_RECORD_INVALID');
  assert.equal(existsSync(runFile(dir, 'run-3')), false);
});
check('file: an extra ROOT, any other relation or a continuation in the record fails closed', (dir) => {
  for (const [name, mutate] of [
    ['extra ROOT', (record) => { record.lineage.push({ runId: 'run-2', relation: 'ROOT' }); }],
    ['continuation relation', (record) => { record.lineage.push({ runId: 'run-2', relation: 'CONTINUATION' }); }],
    ['non-empty continuations', (record) => { record.reserved.continuations.push({ runId: 'run-2' }); }],
    ['unknown field', (record) => { record.authority = true; }],
    ['other ruleset', (record) => { record.ruleset = 'CHIEF-GOV/2'; }],
    ['authority class', (record) => { record.recordClass = 'AUTHORITY_ARCHIVE'; }],
  ]) {
    const at = join(dir, name.replace(/ /g, '-')); const store = new FileControllerStore(at, clock);
    store.create(fresh('run-1'));
    rewriteClaim(at, mutate);
    failsClosed(() => store.create(fresh('run-2')), 'ADMISSION_RECORD_INVALID');
    failsClosed(() => store.get('run-1'), 'ADMISSION_RECORD_INVALID');
    failsClosed(() => new FileControllerStore(at, clock), 'ADMISSION_RECORD_INVALID');
    assert.equal(existsSync(runFile(at, 'run-2')), false, name);
  }
});
check('file: without atomic link publication admission fails closed, with no fallback', (dir) => {
  const store = new FileControllerStore(dir, clock);
  for (const code of ['EPERM', 'ENOTSUP', 'EXDEV', 'EIO']) {
    withFs('linkSync', () => () => { throw Object.assign(new Error(`link: ${code}`), { code }); }, () =>
      failsClosed(() => store.create(fresh('run-1')), 'ADMISSION_CLAIM_UNAVAILABLE'));
    assert.deepEqual(readdirSync(join(dir, 'changes')), [], `${code} left a claim or temp`);
    assert.deepEqual(runFiles(dir), [], `${code} wrote a run`);
  }
  store.create(fresh('run-1'));
  assert.equal(store.admissionRecord(CHANGE).rootRunId, 'run-1');
});
check('file: refusal evidence that cannot be written leaves the refusal intact', (dir) => {
  const store = new FileControllerStore(dir, clock); store.create(fresh('run-1'));
  writeFileSync(join(dir, 'changes', 'refusals'), 'not a directory');
  const error = refused(() => store.create(fresh('run-2')), { existingRootRunId: 'run-1' });
  assert.equal(error.evidenceRecorded, false);
  assert.deepEqual(runFiles(dir), [`${sha('run-1')}.json`]);
  const second = join(dir, 'second'), other = new FileControllerStore(second, clock); other.create(fresh('run-1'));
  const failure = withFs('linkSync', (link) => (from, to) => {
    if (String(to).includes(join('changes', 'refusals'))) throw Object.assign(new Error('evidence disk full'), { code: 'ENOSPC' });
    return link(from, to);
  }, () => refused(() => other.create(fresh('run-2')), { existingRootRunId: 'run-1' }));
  assert.equal(failure.evidenceRecorded, false);
  assert.deepEqual(readdirSync(join(second, 'changes', 'refusals', keyOf())), [], 'a partial refusal record was left');
  assert.deepEqual(runFiles(second), [`${sha('run-1')}.json`]);
});

// ---------------------------------------------------------------- concurrency (separate processes)
const WORKER = `
  import { FileControllerStore } from './dist/automation/durable-store.js';
  const [dir, runId, sliceId, goAt] = process.argv.slice(1);
  const store = new FileControllerStore(dir);
  const late = Date.now() > Number(goAt);
  while (Date.now() < Number(goAt)) { /* start together */ }
  let outcome = 'ADMITTED';
  try { store.create({ runId, sliceId, repository: 'synthetic/example', state: 'IDLE', implementationIterations: 0,
    acceptanceFailures: 0, audit: [] }); }
  catch (error) { outcome = error.code ?? error.message; }
  console.log(JSON.stringify({ runId, outcome, late }));`;
function race(dir, requests) {
  const goAt = String(Date.now() + 2500);
  return Promise.all(requests.map(({ runId, sliceId }) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', WORKER, dir, runId, sliceId, goAt], { cwd: ROOT });
    let out = '', err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (status) => (status === 0 ? resolve(JSON.parse(out.trim().split('\n').at(-1))) : reject(new Error(err))));
  })));
}
const contention = [];
check('concurrent creators of one change in separate processes: exactly one ROOT', async (dir) => {
  for (let round = 0; round < 3; round++) {
    const at = join(dir, `round-${round}`);
    const results = await race(at, Array.from({ length: 12 }, (_, i) => ({ runId: `run-${round}-${i}`, sliceId: SLICE })));
    const admitted = results.filter((result) => result.outcome === 'ADMITTED');
    assert.equal(admitted.length, 1, JSON.stringify(results));
    assert.ok(results.every((result) => result === admitted[0] || result.outcome === 'SECOND_RUN_FOR_CHANGE'), JSON.stringify(results));
    assert.deepEqual(runFiles(at), [`${sha(admitted[0].runId)}.json`]);
    const store = new FileControllerStore(at, clock);
    assert.equal(store.admissionRecord(CHANGE).rootRunId, admitted[0].runId);
    assert.equal(store.admissionRefusals(CHANGE).length, 11);
    contention.push(`${results.filter((result) => !result.late).length}/12 started together`);
  }
});
check('concurrent creators of different changes all succeed; the same runId twice admits one', async (dir) => {
  const results = await race(join(dir, 'distinct'), Array.from({ length: 8 }, (_, i) => ({ runId: `run-${i}`, sliceId: `slice-${i}` })));
  assert.ok(results.every((result) => result.outcome === 'ADMITTED'), JSON.stringify(results));
  assert.equal(runFiles(join(dir, 'distinct')).length, 8);
  assert.equal(claims(join(dir, 'distinct')).length, 8);
  const same = await race(join(dir, 'same'), [{ runId: 'run-1', sliceId: SLICE }, { runId: 'run-1', sliceId: SLICE }]);
  assert.equal(same.filter((result) => result.outcome === 'ADMITTED').length, 1, JSON.stringify(same));
  assert.ok(same.every((result) => ['ADMITTED', 'EEXIST', 'Duplicate runId'].includes(result.outcome)), JSON.stringify(same));
  assert.deepEqual(runFiles(join(dir, 'same')), [`${sha('run-1')}.json`]);
});

// ---------------------------------------------------------------- no continuation, no authority
check('no continuation path exists and admission grants no authority', () => {
  const pattern = /continu|successor|lineage|sibling|adopt|mint/i;
  for (const type of [FileControllerStore, InMemoryControllerStore, AutomationController]) {
    assert.deepEqual(Object.getOwnPropertyNames(type.prototype).filter((name) => pattern.test(name)), [], type.name);
  }
  assert.deepEqual(Object.keys(admission).filter((name) => pattern.test(name)), []);
  const source = ['admission.ts', 'audit.ts', 'durable-store.ts', 'controller.ts']
    .map((file) => readFileSync(join(ROOT, 'src/automation', file), 'utf8')).join('\n');
  assert.ok(!/relation:\s*'(?!ROOT')/.test(source), 'a lineage relation other than ROOT is written');
  assert.ok(!/continuations:\s*\[\s*[^\]\s]/.test(source), 'a continuation is written');
  assert.ok(!/authorizationId|authorizationReference|actorRole/.test(readFileSync(join(ROOT, 'src/automation/admission.ts'), 'utf8')),
    'an admission record carries a grant');
  const record = admission.admissionRecordOf(CHANGE, 'run-1', T);
  assert.throws(() => admission.parseAdmissionRecord({ ...record, lineage: [...record.lineage, { runId: 'run-2', relation: 'CONTINUATION' }] }));
  assert.throws(() => admission.parseAdmissionRecord({ ...record, reserved: { continuations: [{ runId: 'run-2' }] } }));
  assert.equal(record.recordClass, 'OPERATIONAL_RECORD');
});

let passed = 0, failed = 0;
for (const { name, fn } of tests) {
  const dir = mkdtempSync(join(tmpdir(), 'chief-r4l-'));
  try { await fn(dir); console.log(`  PASS ${name}`); passed++; }
  catch (error) { console.error(`  FAIL ${name}: ${error.stack}`); failed++; }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
if (contention.length) console.log(`  (race rounds: ${contention.join('; ')})`);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
