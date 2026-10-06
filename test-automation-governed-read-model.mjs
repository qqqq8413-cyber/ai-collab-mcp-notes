import assert from 'node:assert/strict';
// fs fault injection is test machinery only: it changes a source in the middle of a read,
// or makes every mutating filesystem call throw while a read runs.
import { createHash } from 'node:crypto';
import fs, { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync,
  writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as admission from './dist/automation/admission.js';
import { openAuthorityArchiveAppender } from './dist/automation/authority/file-archive.js';
import { AutomationController } from './dist/automation/controller.js';
import { FileControllerStore } from './dist/automation/durable-store.js';
import * as readModel from './dist/automation/read-model/governed-read-model.js';

const { GovernedReadError, readGovernedModel } = readModel;
const ROOT = dirname(fileURLToPath(import.meta.url));
const A = 'a'.repeat(40), B = 'b'.repeat(40);
const T = '2026-10-06T00:00:00.000Z';
const REPO = 'synthetic/example';
const clock = { now: () => T };
const G = { id: 'architect', role: 'GPT_ARCHITECT' };
const X = { id: 'implementer', role: 'CODEX_IMPLEMENTER' };
const H = { id: 'human', role: 'HUMAN' };
const K = { id: 'controller', role: 'CONTROLLER' };
const sha = (text) => createHash('sha256').update(text).digest('hex');
const tests = [];
const check = (name, fn) => tests.push({ name, fn });

// ---------------------------------------------------------------- fixtures
function fakeReality() {
  return { workSha: B, mainSha: A, aheadBy: 1, behindBy: 0, hasBaseOnlyCommits: false,
    workCi: 'SUCCESS', mainCi: 'SUCCESS', workCheck: 'SUCCESS', mainCheck: 'SUCCESS', protected: true, observedAt: T,
    observeBranch(repository, branch) { return { repository, branch, sha: branch === 'main' ? this.mainSha : this.workSha, observedAt: this.observedAt }; },
    compare(repository, baseSha, headSha) { return { repository, baseSha, headSha, aheadBy: this.aheadBy,
      behindBy: this.behindBy, hasBaseOnlyCommits: this.hasBaseOnlyCommits, observedAt: this.observedAt }; },
    observeCi(repository, branch, sha) { return { repository, branch, sha,
      workflowStatus: branch === 'main' ? this.mainCi : this.workCi, requiredCheckName: 'test',
      requiredCheckStatus: branch === 'main' ? this.mainCheck : this.workCheck, observedAt: this.observedAt }; },
    observeProtection(repository, branch) { return { repository, branch, protected: this.protected, requiredChecks: ['test'], observedAt: this.observedAt }; },
  };
}
const packet = (overrides = {}) => ({
  packetId: 'packet-1', packetVersion: 1, sliceId: 'slice-1', expectedBaseSha: A, targetBranch: 'work/synthetic-1',
  objective: 'Offline fixture', allowedAreas: ['src/automation'], forbiddenChanges: ['src/stress-test'],
  invariants: ['human authority retained'], acceptanceCriteria: ['offline checks pass'],
  validationCommands: [{ commandId: 'npm-test', executable: 'npm', args: ['test'], cwd: '.', classification: 'OFFLINE_VALIDATION' }],
  networkAuthorization: { level: 'WRITE_EXTERNAL', destinations: ['work/synthetic-1', 'main'], purpose: 'synthetic GitHub facts', budget: 1 },
  providerCallAuthorization: { allowed: false, calls: [], maxCalls: 0, budget: 0 }, destructiveOperationAuthorization: { allowed: false },
  iterationBudget: { maxImplementationIterationsPerSlice: 3, maxAcceptanceFailuresPerSlice: 3, maxRuntimeMinutesPerIteration: 60,
    maxParallelImplementationAgents: 1 }, ...overrides });
const decision = (run, result, reviewId) => ({ reviewId, actor: 'GPT_ARCHITECT', packetId: run.activePacket.packetId,
  packetHash: run.activePacketHash, reviewedSha: run.remoteSha.sha, decision: result,
  findings: result === 'REJECT' ? ['synthetic finding'] : [], evidenceReferences: ['remote diff'], issuedAt: T });
const correction = (run) => ({ correctionPacketId: `correction-${run.implementationIterations + 1}`, originalPacketId: run.activePacket.packetId,
  originalPacketHash: run.activePacketHash, rejectedSha: run.remoteSha.sha, reviewerFindings: run.acceptance.findings,
  allowedCorrectionAreas: ['src/automation'], unchangedInvariantReferences: run.activePacket.invariants, expectedBaseSha: run.remoteSha.sha,
  correctionIteration: run.implementationIterations + 1, maxCorrectionIteration: 3 });
const grant = (operation, target, runId, packetId, authorizationId) => ({ authorizationId, actorRole: 'HUMAN', operation, target,
  runId, packetId, issuedAt: T, reason: 'synthetic authorization' });
/** An AuthorityDocumentV1 for a body, issued as the lifecycle requires. */
function documentOf(kind, body, { version = 1, supersedes = null, repository = REPO, sliceId = 'slice-1' } = {}) {
  const id = { IMPLEMENTATION_PACKET: body.packetId, CORRECTION_PACKET: body.correctionPacketId, ACCEPTANCE_DECISION: body.reviewId,
    AUTHORIZATION: body.authorizationId }[kind];
  const role = kind === 'AUTHORIZATION' ? body.actorRole : 'GPT_ARCHITECT';
  return { schemaVersion: 1, recordClass: 'DIRECT_AUTHORITY', kind, authorityId: id, version, issuedAt: body.issuedAt ?? T,
    issuer: { role, principalRef: role === 'HUMAN' ? 'human:synthetic' : 'architect:synthetic' },
    subject: kind === 'IMPLEMENTATION_PACKET' ? { repository, sliceId: body.sliceId } : { repository, sliceId }, supersedes, body };
}

function world(dir) {
  const controllerStoreDirectory = join(dir, 'controller'), authorityArchiveDirectory = join(dir, 'authority');
  let controller, appender;
  const reality = fakeReality();
  return {
    controllerStoreDirectory, authorityArchiveDirectory, reality,
    get controller() { return controller ??= new AutomationController(clock, new FileControllerStore(controllerStoreDirectory, clock), reality); },
    archive(kind, body, options) { return (appender ??= openAuthorityArchiveAppender(authorityArchiveDirectory)).append(documentOf(kind, body, options)); },
    read(extra = {}) { return readGovernedModel({ controllerStoreDirectory, authorityArchiveDirectory, ...extra }, clock); },
  };
}
const roots = (w) => ({ controllerStoreDirectory: w.controllerStoreDirectory, authorityArchiveDirectory: w.authorityArchiveDirectory });
/** A sealed run file written around the store, as only R4T-forbidden access could. */
function plantRun(w, run) {
  const payload = JSON.stringify(run);
  mkdirSync(w.controllerStoreDirectory, { recursive: true });
  writeFileSync(join(w.controllerStoreDirectory, `${sha(run.runId)}.json`), JSON.stringify({ schemaVersion: 1, run: JSON.parse(payload), checksum: sha(payload) }));
}
const freshRun = (runId, sliceId, repository = REPO) => ({ runId, sliceId, repository, state: 'IDLE', implementationIterations: 0, acceptanceFailures: 0, audit: [] });
const claimFile = (w, repository, sliceId) => join(w.controllerStoreDirectory, 'changes', `${admission.changeKeyOf({ repository, sliceId })}.json`);
function readFails(fn, code) {
  let caught;
  try { fn(); } catch (error) { caught = error; }
  assert.ok(caught instanceof GovernedReadError, `expected ${code}, got ${caught?.stack ?? 'no error'}`);
  assert.equal(caught.code, code, caught.message);
}
function withFs(names, replace, fn) {
  const originals = Object.fromEntries(names.map((name) => [name, fs[name]]));
  for (const name of names) fs[name] = replace(name, originals[name]);
  syncBuiltinESMExports();
  try { return fn(); } finally { Object.assign(fs, originals); syncBuiltinESMExports(); }
}
/** Every entry under a root with type, mode, inode, size, mtime, ctime and bytes; null when absent. Never follows symlinks. */
function tree(root) {
  if (!existsSync(root) && !lstatSyncSafe(root)) return null;
  const walk = (path, rel) => readdirSync(path).sort().flatMap((name) => {
    const child = join(path, name), key = rel ? `${rel}/${name}` : name, status = lstatSync(child, { bigint: true });
    const meta = [key, status.mode, status.ino, status.size, status.mtimeNs, status.ctimeNs];
    if (status.isSymbolicLink()) return [[...meta, 'link', readlinkSync(child)]];
    if (status.isDirectory()) return [[...meta, 'dir'], ...walk(child, key)];
    return [[...meta, 'file', readFileSync(child).toString('base64')]];
  });
  return walk(root, '');
}
function lstatSyncSafe(path) { try { return lstatSync(path); } catch { return undefined; } }
const unchanged = (w, fn) => {
  const before = [tree(w.controllerStoreDirectory), tree(w.authorityArchiveDirectory)];
  const result = fn();
  assert.deepEqual([tree(w.controllerStoreDirectory), tree(w.authorityArchiveDirectory)], before, 'a read changed a governance root');
  return result;
};
const change = (model, sliceId, repository = REPO) => model.changes.find((item) => item.change.changeId === sliceId && item.repository === repository);
const moves = (view) => view.nextAction.moves.map(({ action, role, toState }) => `${action}/${role}/${toState}`);

// ---------------------------------------------------------------- A. empty stores
check('A1. absent roots read as a valid empty projection and are not created', (dir) => {
  const w = world(dir);
  const model = w.read();
  assert.equal(model.schema, 'chief.governed-read-model');
  assert.equal(model.schemaVersion, 1);
  assert.equal(model.rulesetRef, 'CHIEF-GOV/1');
  assert.equal(model.observedAt, T);
  assert.equal(model.continuation, 'NOT_IMPLEMENTED');
  assert.deepEqual([model.snapshot.controllerStore, model.snapshot.authorityArchive], ['ABSENT', 'ABSENT']);
  assert.match(model.snapshot.id, /^[0-9a-f]{64}$/);
  assert.deepEqual([model.runs, model.changes, model.authority, model.anomalies], [[], [], [], []]);
  assert.deepEqual(readdirSync(dir), [], 'the read created a root');
  assert.ok(Object.isFrozen(model) && Object.isFrozen(model.runs) && Object.isFrozen(model.snapshot));
});
check('A2. present but empty stores read as a valid empty projection', (dir) => {
  const w = world(dir);
  new FileControllerStore(w.controllerStoreDirectory, clock);
  openAuthorityArchiveAppender(w.authorityArchiveDirectory);
  const model = unchanged(w, () => w.read());
  assert.deepEqual([model.snapshot.controllerStore, model.snapshot.authorityArchive], ['PRESENT', 'PRESENT']);
  assert.deepEqual([model.runs, model.changes, model.authority, model.anomalies], [[], [], [], []]);
});
check('A3. roots must be absolute, normalised and disjoint', (dir) => {
  const w = world(dir);
  for (const bad of [{ controllerStoreDirectory: 'relative', authorityArchiveDirectory: w.authorityArchiveDirectory },
    { controllerStoreDirectory: `${w.controllerStoreDirectory}/`, authorityArchiveDirectory: w.authorityArchiveDirectory },
    { controllerStoreDirectory: `${dir}/x/../controller`, authorityArchiveDirectory: w.authorityArchiveDirectory },
    { controllerStoreDirectory: w.controllerStoreDirectory, authorityArchiveDirectory: w.controllerStoreDirectory },
    { controllerStoreDirectory: w.controllerStoreDirectory, authorityArchiveDirectory: join(w.controllerStoreDirectory, 'authority') },
    { controllerStoreDirectory: join(w.authorityArchiveDirectory, 'controller'), authorityArchiveDirectory: w.authorityArchiveDirectory }]) {
    readFails(() => readGovernedModel(bad, clock), 'INVALID_ROOTS');
  }
  assert.deepEqual(readdirSync(dir), []);
});

// ---------------------------------------------------------------- B. one valid run
check('B1. one valid run appears once with its exact change and Controller state', (dir) => {
  const w = world(dir);
  w.controller.createRun('run-1', 'slice-1', REPO);
  const model = unchanged(w, () => w.read());
  assert.equal(model.runs.length, 1);
  const [run] = model.runs;
  const changeKey = admission.changeKeyOf({ repository: REPO, sliceId: 'slice-1' });
  assert.deepEqual([run.runId, run.repository, run.sliceId, run.change, run.changeKey], ['run-1', REPO, 'slice-1', { kind: 'SLICE', changeId: 'slice-1' }, changeKey]);
  assert.deepEqual([run.state, run.interruptedState, run.stopClass, run.terminal, run.externalRecheckRequired], ['IDLE', null, null, false, false]);
  assert.deepEqual(run.admission, { recordClass: 'OPERATIONAL_RECORD', status: 'ROOT', rootRunId: 'run-1', admittedAt: T });
  assert.deepEqual([run.anomalies, run.authority, run.packet, run.audit], [[], [], null, { length: 0, first: null, last: null }]);
  assert.equal(model.changes.length, 1);
  const view = model.changes[0];
  assert.deepEqual([view.change, view.repository, view.changeKey, view.head, view.anomalies, view.authority],
    [{ kind: 'SLICE', changeId: 'slice-1' }, REPO, changeKey, null, [], []]);
  assert.deepEqual(view.runs.map((item) => [item.runId, item.state]), [['run-1', 'IDLE']]);
  assert.deepEqual(view.nextAction, { determinacy: 'DETERMINATE', moves: [{ action: 'ENTER_ARCHITECTURE', role: 'GPT_ARCHITECT', toState: 'ARCHITECTURE' }],
    ruleId: null, conflicts: [], capabilityGaps: [] });
});
check('B2. a run at PACKET_READY with its archived packet: counters, packet and the implementer move', (dir) => {
  const w = world(dir);
  const c = w.controller;
  c.createRun('run-1', 'slice-1', REPO);
  c.enterArchitecture('run-1', G);
  const run = c.issuePacket('run-1', G, packet());
  const ref = w.archive('IMPLEMENTATION_PACKET', packet());
  const model = unchanged(w, () => w.read());
  const [projected] = model.runs;
  assert.deepEqual(projected.packet, { packetId: 'packet-1', packetVersion: 1, packetHash: run.activePacketHash, targetBranch: 'work/synthetic-1', expectedBaseSha: A });
  assert.deepEqual(projected.counters, { implementationIterations: 0, maxImplementationIterations: 3, acceptanceFailures: 0, maxAcceptanceFailures: 3 });
  assert.deepEqual(projected.audit.last, { sequence: 2, action: 'ISSUE_PACKET', at: T });
  assert.equal(ref.recordHash.length, 64);
  assert.deepEqual(projected.authority.find((item) => item.locator === 'activePacket'),
    { kind: 'IMPLEMENTATION_PACKET', authorityId: 'packet-1', bodyHash: run.activePacketHash, locator: 'activePacket', required: true,
      resolution: 'RESOLVED', authority: ref });
  assert.deepEqual(moves(model.changes[0]), ['BEGIN_IMPLEMENTATION/CODEX_IMPLEMENTER/IMPLEMENTING']);
});

// ---------------------------------------------------------------- C. invalid or tampered runs
check('C. an invalid or tampered run fails the whole read closed and is never rewritten', (dir) => {
  const variants = {
    'corrupt JSON': (text) => text.slice(0, -2),
    'checksum mismatch': (text) => text.replace('"state":"ARCHITECTURE"', '"state":"PACKET_READY"'),
    'invariant broken under a valid checksum': (text) => {
      const envelope = JSON.parse(text);
      envelope.run.implementationIterations = 2;
      envelope.checksum = sha(JSON.stringify(envelope.run));
      return JSON.stringify(envelope);
    },
    'unknown schema version': (text) => { const envelope = JSON.parse(text); envelope.schemaVersion = 2; return JSON.stringify(envelope); },
  };
  for (const [label, tamper] of Object.entries(variants)) {
    const w = world(join(dir, label.replace(/\W+/g, '-')));
    w.controller.createRun('run-1', 'slice-1', REPO);
    w.controller.enterArchitecture('run-1', G);
    const file = join(w.controllerStoreDirectory, `${sha('run-1')}.json`);
    writeFileSync(file, tamper(readFileSync(file, 'utf8')));
    unchanged(w, () => readFails(() => w.read(), 'CONTROLLER_RUN_INVALID'));
  }
  // Identity binding: a valid run filed under another runId's name.
  const w = world(join(dir, 'binding'));
  w.controller.createRun('run-1', 'slice-1', REPO);
  renameSync(join(w.controllerStoreDirectory, `${sha('run-1')}.json`), join(w.controllerStoreDirectory, `${sha('run-2')}.json`));
  unchanged(w, () => readFails(() => w.read(), 'CONTROLLER_RUN_INVALID'));
  // A symlinked run file is not followed.
  const s = world(join(dir, 'symlink'));
  s.controller.createRun('run-1', 'slice-1', REPO);
  const real = join(s.controllerStoreDirectory, `${sha('run-1')}.json`);
  renameSync(real, join(dir, 'elsewhere.json'));
  symlinkSync(join(dir, 'elsewhere.json'), real);
  unchanged(s, () => readFails(() => s.read(), 'SOURCE_INTEGRITY'));
});

// ---------------------------------------------------------------- D / F. exact historical authority
function packetHistory(w) {
  const c = w.controller;
  c.createRun('run-1', 'slice-1', REPO);
  c.enterArchitecture('run-1', G);
  c.issuePacket('run-1', G, packet());
  c.stop('run-1', G, 'ARCHITECTURE_STOP', 'packet conflicts with repository reality');
  c.resumeArchitecture('run-1', G);
  return c.issuePacket('run-1', G, packet({ packetId: 'packet-2', packetVersion: 2, objective: 'Second packet' }));
}
check('D. exact historical authority is resolved to the archived version the run records, not the latest', (dir) => {
  const w = world(dir);
  const run = packetHistory(w);
  const first = w.archive('IMPLEMENTATION_PACKET', packet());
  // A later revision of the same document exists; the run recorded version 1.
  const revised = w.archive('IMPLEMENTATION_PACKET', packet({ objective: 'Revised wording' }), { version: 2, supersedes: first });
  const second = w.archive('IMPLEMENTATION_PACKET', packet({ packetId: 'packet-2', packetVersion: 2, objective: 'Second packet' }));
  const model = unchanged(w, () => w.read());
  const references = model.runs[0].authority;
  const historical = references.find((item) => item.authorityId === 'packet-1');
  assert.deepEqual([historical.locator, historical.required, historical.resolution, historical.authority], ['audit#2', false, 'RESOLVED', first]);
  assert.notDeepEqual(historical.authority, revised);
  const active = references.find((item) => item.locator === 'activePacket');
  assert.deepEqual([active.authorityId, active.bodyHash, active.resolution, active.authority], ['packet-2', run.activePacketHash, 'RESOLVED', second]);
  assert.deepEqual(model.authority.map((fact) => [fact.ref.authorityId, fact.ref.version, fact.recordClass]),
    [['packet-1', 1, 'DIRECT_AUTHORITY'], ['packet-1', 2, 'DIRECT_AUTHORITY'], ['packet-2', 1, 'DIRECT_AUTHORITY']]);
  assert.deepEqual(model.authority[0].issuer, { role: 'GPT_ARCHITECT', principalRef: 'architect:synthetic' });
  assert.deepEqual(change(model, 'slice-1').authority, [first, revised, second]);
  assert.deepEqual(moves(change(model, 'slice-1')), ['BEGIN_IMPLEMENTATION/CODEX_IMPLEMENTER/IMPLEMENTING']);
  // The Controller hash and the archive body hash are one canonical definition.
  assert.equal(model.authority.find((fact) => fact.ref.authorityId === 'packet-2').bodyHash, run.activePacketHash);
});
check('F. a missing historical version is never replaced by the latest: the run is INDETERMINATE', (dir) => {
  const w = world(dir);
  const c = w.controller;
  c.createRun('run-1', 'slice-1', REPO);
  c.enterArchitecture('run-1', G);
  const run = c.issuePacket('run-1', G, packet());
  // The archive holds two other revisions of packet-1, neither the body the run records.
  const v1 = w.archive('IMPLEMENTATION_PACKET', packet({ objective: 'Other wording' }));
  w.archive('IMPLEMENTATION_PACKET', packet({ objective: 'Latest wording' }), { version: 2, supersedes: v1 });
  const model = unchanged(w, () => w.read());
  const active = model.runs[0].authority.find((item) => item.locator === 'activePacket');
  assert.deepEqual([active.bodyHash, active.resolution, active.authority], [run.activePacketHash, 'VERSION_NOT_FOUND', null]);
  const view = change(model, 'slice-1');
  assert.equal(view.nextAction.determinacy, 'INDETERMINATE');
  assert.deepEqual(view.nextAction.moves, []);
  assert.deepEqual(view.nextAction.conflicts, [{ scope: 'AUTHORITY', code: 'VERSION_NOT_FOUND', locator: 'run-1:activePacket' }]);
  // Nothing archived at all for a required reference: NOT_ARCHIVED, also INDETERMINATE.
  const n = world(join(dir, 'none'));
  n.controller.createRun('run-1', 'slice-1', REPO);
  n.controller.enterArchitecture('run-1', G);
  n.controller.issuePacket('run-1', G, packet());
  const none = n.read();
  assert.deepEqual(change(none, 'slice-1').nextAction.conflicts, [{ scope: 'AUTHORITY', code: 'NOT_ARCHIVED', locator: 'run-1:activePacket' }]);
  // An archived document for another repository never resolves a run's reference.
  n.archive('IMPLEMENTATION_PACKET', packet(), { repository: 'synthetic/other' });
  const other = n.read();
  assert.equal(other.runs[0].authority[0].resolution, 'SUBJECT_MISMATCH');
  assert.deepEqual(change(other, 'slice-1').authority, []);
});

// ---------------------------------------------------------------- E. operational records are not authority
check('E. an operational ACCEPT (the Controller copy, a journal entry) is not direct authority', (dir) => {
  const w = world(dir);
  const c = w.controller;
  c.createRun('run-1', 'slice-1', REPO);
  c.enterArchitecture('run-1', G);
  c.issuePacket('run-1', G, packet());
  w.archive('IMPLEMENTATION_PACKET', packet());
  c.beginImplementation('run-1', X);
  c.completeImplementation('run-1', X, ['offline checks pass']);
  c.recordRemoteSha('run-1', X);
  c.beginAcceptanceReview('run-1', G);
  const accepted = c.decideAcceptance('run-1', G, decision(c.get('run-1'), 'ACCEPT', 'review-1'));
  assert.equal(accepted.state, 'ACCEPTED');
  // A journal record that looks like an applied ACCEPT, beside the roots.
  const journal = join(dir, 'journal');
  mkdirSync(journal);
  writeFileSync(join(journal, 'review.json'), JSON.stringify({ invocationId: 'inv-1', state: 'APPLIED', application: { sequence: 8, action: 'ACCEPT_EXACT_SHA' },
    result: { value: { decision: 'ACCEPT', reviewId: 'review-1' } } }));
  const model = unchanged(w, () => w.read({ invocationJournalDirectory: journal }));
  const acceptance = model.runs[0].authority.find((item) => item.locator === 'acceptance');
  assert.deepEqual([acceptance.kind, acceptance.authorityId, acceptance.resolution, acceptance.authority], ['ACCEPTANCE_DECISION', 'review-1', 'NOT_ARCHIVED', null]);
  assert.deepEqual(model.authority.map((fact) => fact.ref.kind), ['IMPLEMENTATION_PACKET']);
  assert.ok(!change(model, 'slice-1').authority.some((ref) => ref.kind === 'ACCEPTANCE_DECISION'));
  assert.deepEqual(change(model, 'slice-1').nextAction.conflicts, [{ scope: 'AUTHORITY', code: 'NOT_ARCHIVED', locator: 'run-1:acceptance' }]);
  assert.deepEqual(model, w.read(), 'the journal is not an input');
  // The same operational record placed in the archive is refused, never converted.
  const key = sha('chief.authority.v1\0ACCEPTANCE_DECISION\0review-1');
  mkdirSync(join(w.authorityArchiveDirectory, 'records', key));
  writeFileSync(join(w.authorityArchiveDirectory, 'records', key, '00000001.json'), readFileSync(join(journal, 'review.json')));
  unchanged(w, () => readFails(() => w.read(), 'AUTHORITY_ARCHIVE_INVALID'));
  // Once the exact decision is archived (and the stray record is gone), it resolves.
  rmSync(join(w.authorityArchiveDirectory, 'records', key), { recursive: true });
  const ref = w.archive('ACCEPTANCE_DECISION', accepted.acceptance);
  const resolved = w.read();
  assert.deepEqual(resolved.runs[0].authority.find((item) => item.locator === 'acceptance').authority, ref);
  assert.deepEqual(moves(change(resolved, 'slice-1')), ['AUTHORIZE_PROMOTION/HUMAN/PROMOTION_READY']);
});

// ---------------------------------------------------------------- G / H / I. change identity and siblings
check('G. two valid runs of one exact change: UNLINKED_SIBLING_RUN, INDETERMINATE, no lineage, nothing repaired', (dir) => {
  const w = world(dir);
  w.controller.createRun('run-1', 'slice-1', REPO);
  plantRun(w, freshRun('run-2', 'slice-1'));
  const model = unchanged(w, () => w.read());
  assert.deepEqual(model.runs.map((run) => [run.runId, run.state, run.changeKey]), [
    ['run-1', 'IDLE', admission.changeKeyOf({ repository: REPO, sliceId: 'slice-1' })],
    ['run-2', 'IDLE', admission.changeKeyOf({ repository: REPO, sliceId: 'slice-1' })]]);
  const view = change(model, 'slice-1');
  assert.equal(model.changes.length, 1);
  assert.deepEqual(view.runs.map((run) => run.runId), ['run-1', 'run-2']);
  assert.deepEqual(view.anomalies.map((anomaly) => [anomaly.code, anomaly.runIds]),
    [['ADMISSION_REGISTRY_MISMATCH', ['run-2']], ['UNLINKED_SIBLING_RUN', ['run-1', 'run-2']]]);
  assert.deepEqual([view.head, view.nextAction.determinacy, view.nextAction.moves], [null, 'INDETERMINATE', []]);
  assert.ok(view.nextAction.conflicts.some((item) => item.scope === 'CHANGE' && item.code === 'UNLINKED_SIBLING_RUN'));
  for (const run of model.runs) assert.deepEqual(run.lineage, { kind: 'UNAVAILABLE', admission: 'NOT_IMPLEMENTED', predecessor: null, successor: null });
  assert.deepEqual(model.runs.map((run) => run.admission.status), ['ROOT', 'NOT_ROOT']);
  // The Controller store itself refuses to open such a store; the read model only reports it.
  assert.throws(() => new FileControllerStore(w.controllerStoreDirectory, clock), (error) => error.code === 'ADMISSION_REGISTRY_MISMATCH');
});
check('H. the same sliceId in another canonical repository is another change, not a sibling', (dir) => {
  const w = world(dir);
  w.controller.createRun('run-1', 'slice-1', 'synthetic/one');
  w.controller.createRun('run-2', 'slice-1', 'synthetic/two');
  const model = w.read();
  assert.deepEqual(model.anomalies, []);
  assert.deepEqual(model.changes.map((view) => [view.repository, view.change.changeId, view.runs.map((run) => run.runId), view.nextAction.determinacy]),
    [['synthetic/one', 'slice-1', ['run-1'], 'DETERMINATE'], ['synthetic/two', 'slice-1', ['run-2'], 'DETERMINATE']]);
  assert.notEqual(model.changes[0].changeKey, model.changes[1].changeKey);
});
check('I. case-different sliceIds are distinct exact changes', (dir) => {
  const w = world(dir);
  w.controller.createRun('run-1', 'Slice-1', REPO);
  w.controller.createRun('run-2', 'slice-1', REPO);
  const model = w.read();
  assert.deepEqual(model.anomalies, []);
  assert.deepEqual(model.changes.map((view) => [view.change.changeId, view.runs.map((run) => run.runId)]), [['Slice-1', ['run-1']], ['slice-1', ['run-2']]]);
  assert.deepEqual(model.changes.map((view) => view.changeKey),
    [admission.changeKeyOf({ repository: REPO, sliceId: 'Slice-1' }), admission.changeKeyOf({ repository: REPO, sliceId: 'slice-1' })]);
});

// ---------------------------------------------------------------- J / K. registry contradictions
check('J. an admission registry contradiction is visible beside readable runs', (dir) => {
  const w = world(dir);
  w.controller.createRun('run-1', 'slice-1', REPO);
  w.controller.createRun('run-2', 'slice-2', REPO);
  // slice-2's claim now names run-1 as its ROOT.
  writeFileSync(claimFile(w, REPO, 'slice-2'), admission.sealAdmissionRecord(admission.admissionRecordOf({ repository: REPO, sliceId: 'slice-2' }, 'run-1', T)));
  const model = unchanged(w, () => w.read());
  assert.deepEqual(model.runs.map((run) => [run.runId, run.state, run.admission.status]), [['run-1', 'IDLE', 'ROOT'], ['run-2', 'IDLE', 'NOT_ROOT']]);
  assert.deepEqual([...new Set(model.anomalies.map((anomaly) => anomaly.code))], ['ADMISSION_REGISTRY_MISMATCH']);
  assert.ok(model.anomalies.some((anomaly) => anomaly.detail === 'One runId is claimed as ROOT by two changes'));
  assert.ok(model.anomalies.some((anomaly) => anomaly.runIds.includes('run-2') && anomaly.detail === 'The run is not the admitted ROOT of its change'));
  for (const view of model.changes) assert.equal(view.nextAction.determinacy, 'INDETERMINATE');
  assert.throws(() => new FileControllerStore(w.controllerStoreDirectory, clock), (error) => error.code === 'ADMISSION_REGISTRY_MISMATCH');
});
check('K. runs without an admission record stay LEGACY_UNINDEXED_RUN; a corrupt record is reported, not rewritten', (dir) => {
  const w = world(dir);
  w.controller.createRun('run-1', 'slice-1', REPO);
  plantRun(w, freshRun('run-9', 'slice-9'));
  plantRun(w, freshRun('run-bad', ' slice-bad'));
  w.controller; // the admitted change is otherwise valid
  const corrupt = claimFile(w, REPO, 'slice-7');
  writeFileSync(corrupt, '{"checksum":"0","record":{}}');
  plantRun(w, freshRun('run-7', 'slice-7'));
  const model = unchanged(w, () => w.read());
  const byId = Object.fromEntries(model.runs.map((run) => [run.runId, run]));
  assert.deepEqual([byId['run-9'].admission.status, byId['run-9'].anomalies.map((a) => a.code)], ['NO_RECORD', ['LEGACY_UNINDEXED_RUN']]);
  assert.deepEqual([byId['run-bad'].change, byId['run-bad'].changeKey, byId['run-bad'].admission.status, byId['run-bad'].sliceId],
    [null, null, 'NO_CANONICAL_IDENTITY', ' slice-bad']);
  assert.deepEqual(byId['run-7'].anomalies.map((a) => a.code), ['ADMISSION_RECORD_INVALID']);
  assert.equal(byId['run-7'].admission.status, 'RECORD_INVALID');
  assert.equal(readFileSync(corrupt, 'utf8'), '{"checksum":"0","record":{}}');
  assert.ok(!model.changes.some((view) => view.change.changeId === ' slice-bad'), 'a non-canonical identity is never normalised into a change');
  // The admitted change is readable, but its store would not open: INDETERMINATE, scoped to the store.
  const view = change(model, 'slice-1');
  assert.deepEqual([view.anomalies, view.nextAction.determinacy], [[], 'INDETERMINATE']);
  assert.ok(view.nextAction.conflicts.every((item) => item.scope === 'CONTROLLER_STORE'));
  assert.deepEqual([...new Set(view.nextAction.conflicts.map((item) => item.code))].sort(), ['ADMISSION_RECORD_INVALID', 'LEGACY_UNINDEXED_RUN']);
});

// ---------------------------------------------------------------- L. snapshot consistency
check('L. a source that changes during the read fails closed', (dir) => {
  const w = world(dir);
  w.controller.createRun('run-1', 'slice-1', REPO);
  w.archive('IMPLEMENTATION_PACKET', packet());
  const midway = (path, mutate) => {
    let done = false;
    return withFs(['readdirSync'], (_name, original) => (...args) => {
      const listing = original(...args);
      if (!done && args[0] === path) { done = true; mutate(); }
      return listing;
    }, () => readFails(() => w.read(), 'SNAPSHOT_INCONSISTENT'));
  };
  // A run created by another writer after the store was listed.
  midway(w.controllerStoreDirectory, () => new AutomationController(clock, new FileControllerStore(w.controllerStoreDirectory, clock)).createRun('run-2', 'slice-2', REPO));
  // An authority version appended after the archive was listed.
  midway(join(w.authorityArchiveDirectory, 'records'), () => openAuthorityArchiveAppender(w.authorityArchiveDirectory)
    .append(documentOf('IMPLEMENTATION_PACKET', packet({ packetId: 'packet-9' }))));
  // A run file already read, rewritten in place with the same length (same inode), while the claims are listed.
  const runFile = join(w.controllerStoreDirectory, `${sha('run-1')}.json`);
  const original = readFileSync(runFile, 'utf8');
  midway(join(w.controllerStoreDirectory, 'changes'), () => {
    writeFileSync(runFile, original.replace(/"checksum":"(.)/, (_m, c) => `"checksum":"${c === '0' ? '1' : '0'}`));
  });
  // With nothing moving, the same sources read cleanly and identically.
  writeFileSync(runFile, original);
  const first = w.read();
  assert.deepEqual(w.read(), first);
  assert.equal(w.read().snapshot.id, first.snapshot.id);
});

// ---------------------------------------------------------------- M. read only
const MUTATORS = ['mkdirSync', 'writeFileSync', 'appendFileSync', 'renameSync', 'unlinkSync', 'linkSync', 'symlinkSync', 'chmodSync', 'chownSync',
  'rmSync', 'rmdirSync', 'copyFileSync', 'cpSync', 'truncateSync', 'ftruncateSync', 'utimesSync', 'futimesSync', 'writeSync', 'fsyncSync', 'mkdtempSync'];
check('M. a read never calls a mutating filesystem operation and leaves every byte and entry as it was', (dir) => {
  const w = world(dir);
  const c = w.controller;
  c.createRun('run-1', 'slice-1', REPO);
  c.enterArchitecture('run-1', G);
  c.issuePacket('run-1', G, packet());
  w.archive('IMPLEMENTATION_PACKET', packet());
  assert.throws(() => c.createRun('run-2', 'slice-1', REPO), (error) => error.code === 'SECOND_RUN_FOR_CHANGE'); // refusal evidence on disk
  plantRun(w, freshRun('run-9', 'slice-9'));
  writeFileSync(claimFile(w, REPO, 'slice-8'), 'not json');
  writeFileSync(join(w.controllerStoreDirectory, `${sha('run-x')}.json.lock`), '');
  writeFileSync(join(w.controllerStoreDirectory, 'changes', `${'e'.repeat(64)}.1234.tmp`), 'partial');
  const before = [tree(w.controllerStoreDirectory), tree(w.authorityArchiveDirectory)];
  const writes = [];
  const model = withFs([...MUTATORS, 'openSync'], (name, original) => name === 'openSync'
    ? (path, flags, ...rest) => {
      const readOnly = flags === undefined || flags === 'r' || (typeof flags === 'number' && (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR |
        fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) === 0);
      if (!readOnly) { writes.push(`openSync ${flags}`); throw new Error('write open during read'); }
      return original(path, flags, ...rest);
    }
    : (...args) => { writes.push(name); throw new Error(`${name} during read`); }, () => w.read());
  assert.deepEqual(writes, []);
  assert.deepEqual([tree(w.controllerStoreDirectory), tree(w.authorityArchiveDirectory)], before);
  assert.equal(model.runs.length, 2);
  // No lock, admission, run or authority was added: the store and archive still read as before.
  assert.equal(readdirSync(join(w.controllerStoreDirectory, 'changes')).filter((name) => name.endsWith('.json')).length, 2);
  assert.deepEqual(w.read(), model);
  // A failed read is read-only too.
  writeFileSync(join(w.controllerStoreDirectory, `${sha('run-1')}.json`), 'tampered');
  const failedBefore = [tree(w.controllerStoreDirectory), tree(w.authorityArchiveDirectory)];
  withFs(MUTATORS, (name) => () => { throw new Error(`${name} during read`); }, () => readFails(() => w.read(), 'CONTROLLER_RUN_INVALID'));
  assert.deepEqual([tree(w.controllerStoreDirectory), tree(w.authorityArchiveDirectory)], failedBefore);
});

// ---------------------------------------------------------------- N. capability topology
check('N. the read model holds the archive reader only and exposes no write path', () => {
  const source = readFileSync(join(ROOT, 'src', 'automation', 'read-model', 'governed-read-model.ts'), 'utf8');
  const snapshot = readFileSync(join(ROOT, 'src', 'automation', 'read-model', 'source-snapshot.ts'), 'utf8');
  assert.match(source, /import \{ openAuthorityArchiveReader \} from '\.\.\/authority\/file-archive\.js';/);
  for (const text of [source, snapshot]) {
    assert.doesNotMatch(text, /openAuthorityArchiveAppender|AuthorityArchiveAppender|new FileControllerStore|FileControllerStore\(|AutomationController|createRun|bindController|\.replace\(\s*run/);
    assert.doesNotMatch(text, /\b(mkdirSync|writeFileSync|appendFileSync|renameSync|unlinkSync|linkSync|symlinkSync|chmodSync|rmSync|copyFileSync|truncateSync|writeSync)\b/);
  }
  assert.deepEqual(Object.keys(readModel).sort(), ['GOVERNED_READ_MODEL_SCHEMA', 'GovernedReadError', 'readGovernedModel']);
});

// ---------------------------------------------------------------- O. continuation stays unavailable
check('O. continuation stays NOT_IMPLEMENTED: no lineage, no head, HUMAN_STOP offers only RESUME', (dir) => {
  const w = world(dir);
  const c = w.controller;
  c.createRun('run-1', 'slice-1', REPO);
  c.enterArchitecture('run-1', G);
  c.issuePacket('run-1', G, packet());
  w.archive('IMPLEMENTATION_PACKET', packet());
  c.stop('run-1', H, 'HUMAN_STOP', 'human review required');
  const model = w.read();
  const view = change(model, 'slice-1');
  assert.equal(model.continuation, 'NOT_IMPLEMENTED');
  assert.deepEqual([view.head, view.runs[0].lineage, model.runs[0].lineage],
    [null, { kind: 'UNAVAILABLE', admission: 'NOT_IMPLEMENTED', predecessor: null, successor: null },
      { kind: 'UNAVAILABLE', admission: 'NOT_IMPLEMENTED', predecessor: null, successor: null }]);
  assert.deepEqual(view.nextAction, { determinacy: 'DETERMINATE', moves: [{ action: 'RESUME_HUMAN_STOP', role: 'HUMAN', toState: 'PACKET_READY' }],
    ruleId: null, conflicts: [], capabilityGaps: ['CHANGE_ABANDONMENT_NOT_IMPLEMENTED', 'CONTINUATION_NOT_IN_RULESET'] });
  assert.deepEqual([model.runs[0].stopClass, model.runs[0].interruptedState, model.runs[0].stopReason], ['HUMAN_STOP', 'PACKET_READY', 'human review required']);
  assert.doesNotMatch(JSON.stringify(model), /CONTINUATION"|CONTINUED_IN_SUCCESSOR|successor":"|predecessor":"/);
  // An admission record carrying a continuation is not lineage: R4L refuses it as invalid.
  const record = admission.admissionRecordOf({ repository: REPO, sliceId: 'slice-1' }, 'run-1', T);
  const payload = JSON.stringify({ ...record, reserved: { continuations: [{ runId: 'run-2' }] } });
  writeFileSync(claimFile(w, REPO, 'slice-1'), JSON.stringify({ checksum: sha(payload), record: JSON.parse(payload) }));
  const continued = w.read();
  assert.deepEqual(continued.runs[0].anomalies.map((anomaly) => anomaly.code), ['ADMISSION_RECORD_INVALID']);
  assert.deepEqual(continued.runs[0].lineage, { kind: 'UNAVAILABLE', admission: 'NOT_IMPLEMENTED', predecessor: null, successor: null });
  assert.equal(change(continued, 'slice-1').nextAction.determinacy, 'INDETERMINATE');
});

// ---------------------------------------------------------------- NextAction conformance with the real controller
check('NextAction names the move the real controller then records, across the CHIEF-GOV/1 lifecycle', (dir) => {
  const w = world(dir);
  const c = w.controller;
  const id = 'run-1';
  /** Reads the model, performs the step, and requires the recorded transition to be one of the predicted moves. */
  const step = (label, act) => {
    const predicted = moves(change(w.read(), 'slice-1'));
    assert.equal(change(w.read(), 'slice-1').nextAction.determinacy, 'DETERMINATE', `${label}: ${JSON.stringify(change(w.read(), 'slice-1').nextAction)}`);
    const before = c.get(id).audit.length;
    act();
    const recorded = c.get(id).audit.slice(before);
    assert.ok(recorded.length >= 1, `${label}: nothing recorded`);
    const [entry] = recorded;
    assert.ok(predicted.includes(`${entry.action}/${entry.role}/${entry.nextState}`), `${label}: recorded ${entry.action}/${entry.role}/${entry.nextState}, predicted ${predicted}`);
  };
  c.createRun(id, 'slice-1', REPO);
  step('enter architecture', () => c.enterArchitecture(id, G));
  step('issue packet', () => c.issuePacket(id, G, packet()));
  w.archive('IMPLEMENTATION_PACKET', packet());
  // A stop is an exit, not a predicted move; the stop state's own move is.
  c.stop(id, G, 'ARCHITECTURE_STOP', 'scope question');
  step('return to architecture', () => c.resumeArchitecture(id, G));
  const second = packet({ packetId: 'packet-2', packetVersion: 2 });
  step('issue second packet', () => c.issuePacket(id, G, second));
  w.archive('IMPLEMENTATION_PACKET', second);
  step('begin', () => c.beginImplementation(id, X));
  c.stop(id, K, 'SOFT_STOP', 'build failure');
  assert.deepEqual(moves(change(w.read(), 'slice-1')),
    ['RESUME_SOFT_WITH_REPAIR/CONTROLLER/IMPLEMENTING', 'BUDGET_EXHAUSTED/CONTROLLER/HUMAN_STOP']);
  step('soft resume', () => c.resumeSoft(id, K, 'repaired build'));
  step('complete', () => c.completeImplementation(id, X, ['offline checks pass']));
  step('record remote sha', () => c.recordRemoteSha(id, X));
  step('begin review', () => c.beginAcceptanceReview(id, G));
  const rejection = decision(c.get(id), 'REJECT', 'review-1');
  step('reject', () => c.decideAcceptance(id, G, rejection));
  w.archive('ACCEPTANCE_DECISION', rejection);
  const fix = correction(c.get(id));
  step('issue correction', () => c.issueCorrection(id, G, fix));
  w.archive('CORRECTION_PACKET', fix);
  step('begin corrected iteration', () => c.beginImplementation(id, X));
  step('complete corrected iteration', () => c.completeImplementation(id, X, ['offline checks pass']));
  step('record corrected sha', () => c.recordRemoteSha(id, X));
  c.stop(id, H, 'HUMAN_STOP', 'human pause');
  const resume = grant('RESUME_HUMAN_STOP', c.get(id).stopId, id, 'packet-2', 'auth-resume');
  step('human resume', () => c.resumeHuman(id, H, resume));
  w.archive('AUTHORIZATION', resume);
  assert.deepEqual(moves(change(w.read(), 'slice-1')), ['RECHECK_EXTERNAL_REALITY/CONTROLLER/REMOTE_SHA_READY']);
  step('external recheck', () => c.reconcile(id, K));
  step('begin second review', () => c.beginAcceptanceReview(id, G));
  const acceptance = decision(c.get(id), 'ACCEPT', 'review-2');
  step('accept', () => c.decideAcceptance(id, G, acceptance));
  w.archive('ACCEPTANCE_DECISION', acceptance);
  const promotion = grant('FAST_FORWARD_MAIN', 'main', id, 'packet-2', 'auth-promote');
  step('authorize promotion', () => c.requestPromotion(id, H, promotion));
  w.archive('AUTHORIZATION', promotion);
  step('mark promoting', () => c.beginPromotion(id, K));
  w.reality.mainSha = B;
  step('record promoted main', () => c.recordPromotedMain(id, K));
  step('close', () => c.close(id, K));
  const closed = change(w.read(), 'slice-1');
  assert.deepEqual([closed.nextAction.determinacy, closed.nextAction.moves, closed.runs[0].state], ['DETERMINATE', [], 'CLOSED']);
  // Every retained and historical authority reference of the closed run resolves exactly.
  const references = w.read().runs[0].authority;
  assert.ok(references.filter((item) => item.required).every((item) => item.resolution === 'RESOLVED'), JSON.stringify(references));
  assert.deepEqual(references.find((item) => item.authorityId === 'packet-1').resolution, 'RESOLVED');
});
check('NextAction at a spent iteration budget names the controller halt to HUMAN_STOP', (dir) => {
  const w = world(dir);
  const c = w.controller;
  c.createRun('run-1', 'slice-1', REPO);
  c.enterArchitecture('run-1', G);
  c.issuePacket('run-1', G, packet());
  w.archive('IMPLEMENTATION_PACKET', packet());
  c.beginImplementation('run-1', X);
  c.stop('run-1', G, 'ARCHITECTURE_STOP', 'scope question');
  c.resumeArchitecture('run-1', G);
  const tight = packet({ packetId: 'packet-2', packetVersion: 2, iterationBudget: { maxImplementationIterationsPerSlice: 1,
    maxAcceptanceFailuresPerSlice: 1, maxRuntimeMinutesPerIteration: 60, maxParallelImplementationAgents: 1 } });
  c.issuePacket('run-1', G, tight);
  w.archive('IMPLEMENTATION_PACKET', tight);
  assert.deepEqual(moves(change(w.read(), 'slice-1')), ['STOP/CONTROLLER/HUMAN_STOP']);
  const halted = c.beginImplementation('run-1', X);
  assert.deepEqual([halted.state, halted.audit.at(-1).action, halted.audit.at(-1).role], ['HUMAN_STOP', 'STOP', 'CONTROLLER']);
});

// ---------------------------------------------------------------- runner
let passed = 0, failed = 0;
for (const { name, fn } of tests) {
  const dir = mkdtempSync(join(tmpdir(), 'chief-r4a0-'));
  try { await fn(dir); console.log(`  PASS ${name}`); passed++; }
  catch (error) { console.error(`  FAIL ${name}: ${error.stack}`); failed++; }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
