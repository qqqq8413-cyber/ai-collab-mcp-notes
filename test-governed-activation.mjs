import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync,
  writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as activationModule from './dist/automation/activation-core.js';
import { architectReviewAuthority } from './dist/automation/authority/architect-review-authority.js';
import { openAuthorityArchiveReader } from './dist/automation/authority/file-archive.js';
import * as preserverModule from './dist/automation/authority/preserver.js';
import { openChangeMinter } from './dist/automation/change-registry.js';
import { AutomationController } from './dist/automation/controller.js';
import { FileControllerStore } from './dist/automation/durable-store.js';
import { openGovernedExecutionDriver } from './dist/automation/execution-driver.js';
import { FileInvocationJournal } from './dist/automation/file-invocation-journal.js';
import { createGovernedLiveAutomation } from './dist/automation/live/governed-execution.js';
import { readGovernedModel } from './dist/automation/read-model/governed-read-model.js';
import { openRootRunAdmitter } from './dist/automation/root-run-admitter.js';
import { AutomationRunner } from './dist/automation/runner.js';

const { GovernedActivationError, openGovernedActivationCore } = activationModule;
const { AuthorityPreservationError, openDirectAuthorityPreserver } = preserverModule;

// G1-AP1 direct authority preservation and governed activation. Every store is real and local
// to a temporary directory: the CM1 registry (a test-held minter), the Controller store (RA1's
// root-run admitter creates the ROOT run), the R4P archive (written only through the
// preserver under test, read back through R4A0 or a test-held reader). Model ports are offline
// fakes that count their calls. Nothing reaches a provider, a model CLI, GitHub or a repository.

const ROOT = dirname(fileURLToPath(import.meta.url));
const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const T = '2026-10-12T00:00:00.000Z';
const EARLIER = '2026-10-11T00:00:00.000Z';
const REPO = 'synthetic/example', BRANCH = 'work/synthetic-1';
const clock = { now: () => T };
const ARCHITECT = 'architect:gpt-synthetic';
const HUMAN = { schemaVersion: 1, kind: 'HUMAN', principalRef: 'human:local-owner' };
const X = { id: 'implementer', role: 'CODEX_IMPLEMENTER' };
const goalId = (n) => `goal-00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sourceOf = (n = 1) => ({ kind: 'WORKSPACE_GOAL', projectId: 'chief', goalId: goalId(n) });
const IMPL_EGRESS = ['api.anthropic.com:443', 'platform.claude.com:443'];
const REVIEW_EGRESS = ['auth.openai.com:443', 'chatgpt.com:443'];
const IMPL = { actorKind: 'IMPLEMENTATION', provider: 'anthropic', model: 'claude-opus-5-5', egressDestinations: [...IMPL_EGRESS] };
const REVIEW = { actorKind: 'ARCHITECT_REVIEW', provider: 'openai', model: 'gpt-5.5-codex', egressDestinations: [...REVIEW_EGRESS] };
const SCOPES = { IMPLEMENTATION: IMPL, ARCHITECT_REVIEW: REVIEW };
const TARGET = 'live-provider-model-call';
const tests = [];
const check = (name, fn) => tests.push([name, fn]);

// ---------------------------------------------------------------- fixtures
function fakeReality() {
  return { workSha: B, mainSha: A,
    observeBranch(repository, branch) { return { repository, branch, sha: branch === 'main' ? this.mainSha : this.workSha, observedAt: T }; },
    compare(repository, baseSha, headSha) { return { repository, baseSha, headSha, aheadBy: 1, behindBy: 0, hasBaseOnlyCommits: false, observedAt: T }; },
    observeCi(repository, branch, sha) { return { repository, branch, sha, workflowStatus: 'SUCCESS', requiredCheckName: 'test',
      requiredCheckStatus: 'SUCCESS', observedAt: T }; },
    observeProtection(repository, branch) { return { repository, branch, protected: true, requiredChecks: ['test'], observedAt: T }; } };
}
const packetOf = (sliceId, overrides = {}) => ({
  packetId: 'packet-1', packetVersion: 1, sliceId, expectedBaseSha: A, targetBranch: BRANCH,
  objective: 'Offline AP1 fixture', allowedAreas: ['src/automation'], forbiddenChanges: ['src/stress-test'],
  invariants: ['human authority retained'], acceptanceCriteria: ['offline checks pass'],
  validationCommands: [{ commandId: 'test', executable: 'npm', args: ['test'], cwd: '.', classification: 'OFFLINE_VALIDATION' }],
  networkAuthorization: { level: 'WRITE_EXTERNAL', destinations: [BRANCH, 'main', ...IMPL_EGRESS, ...REVIEW_EGRESS].sort(), purpose: 'fixture', budget: 1 },
  providerCallAuthorization: { allowed: true, calls: [structuredClone(IMPL), structuredClone(REVIEW)], maxCalls: 6, budget: 0 },
  destructiveOperationAuthorization: { allowed: false },
  iterationBudget: { maxImplementationIterationsPerSlice: 3, maxAcceptanceFailuresPerSlice: 3, maxRuntimeMinutesPerIteration: 60,
    maxParallelImplementationAgents: 1 }, ...overrides });
const grantOf = (scope, runId, overrides = {}) => ({ authorizationId: `auth-${scope.actorKind.toLowerCase().replace('_', '-')}`,
  actorRole: 'HUMAN', operation: 'LIVE_PROVIDER_MODEL_CALL', target: TARGET, runId, packetId: 'packet-1', scope: structuredClone(scope),
  issuedAt: EARLIER, reason: 'exact human grant for this fixture', ...overrides });
const document = (kind, body, { repository = REPO, sliceId, version = 1, supersedes = null, role, principalRef } = {}) => {
  const id = { IMPLEMENTATION_PACKET: body.packetId, CORRECTION_PACKET: body.correctionPacketId, ACCEPTANCE_DECISION: body.reviewId,
    AUTHORIZATION: body.authorizationId }[kind];
  const issuerRole = role ?? (kind === 'AUTHORIZATION' ? body.actorRole : 'GPT_ARCHITECT');
  return { schemaVersion: 1, recordClass: 'DIRECT_AUTHORITY', kind, authorityId: id, version, issuedAt: body.issuedAt ?? T,
    issuer: { role: issuerRole, principalRef: principalRef ?? (issuerRole === 'HUMAN' ? HUMAN.principalRef : ARCHITECT) },
    subject: { repository, sliceId: kind === 'IMPLEMENTATION_PACKET' ? body.sliceId : sliceId }, supersedes, body };
};
const decisionOf = (run, result, reviewId) => ({ reviewId, actor: 'GPT_ARCHITECT', packetId: run.activePacket.packetId,
  packetHash: run.activePacketHash, reviewedSha: run.remoteSha.sha, decision: result,
  findings: result === 'REJECT' ? ['synthetic finding'] : [], evidenceReferences: ['remote diff'], issuedAt: T });
const correctionOf = (run, overrides = {}) => ({ correctionPacketId: `correction-${run.implementationIterations + 1}`,
  originalPacketId: run.activePacket.packetId, originalPacketHash: run.activePacketHash, rejectedSha: run.remoteSha.sha,
  reviewerFindings: run.acceptance?.findings ?? ['synthetic finding'], allowedCorrectionAreas: ['src/automation'],
  unchangedInvariantReferences: run.activePacket.invariants, expectedBaseSha: run.remoteSha.sha,
  correctionIteration: run.implementationIterations + 1, maxCorrectionIteration: 3, ...overrides });
/** A durable store whose writes call `onWrite(run)` first: it may inspect the archive, or throw to "crash" there. */
function hookedStore(directory, onWrite) {
  const inner = new FileControllerStore(directory, clock);
  return { create: (run) => inner.create(run), get: (id) => inner.get(id), replace: (run) => inner.replace(run),
    entries: (id) => inner.entries(id),
    bindController() { const write = inner.bindController(); return (run) => { onWrite(structuredClone(run)); write(run); }; } };
}
function modelPorts(journalOf, behaviour = {}) {
  const calls = { implementation: 0, review: 0 };
  return { calls,
    implementation: { execute() { calls.implementation += 1; return { status: 'COMPLETED', validationEvidence: ['npm test: exit 0'] }; } },
    review: { review(input) {
      calls.review += 1;
      void journalOf;
      return (behaviour.review ?? ((i) => ({ decision: { reviewId: 'review-1', actor: 'GPT_ARCHITECT', packetId: i.packet.packetId,
        packetHash: i.packetHash, reviewedSha: i.remoteSha.sha, decision: 'ACCEPT', findings: [], evidenceReferences: ['diff'], issuedAt: T } })))(input);
    } } };
}

/** One governed world: Goal n minted and admitted; the activation core over a real Controller and preserver. */
function world(dir, { goals = [1], admit = true, onWrite = () => {}, preserver: wrap } = {}) {
  const paths = { registry: join(dir, 'registry'), controller: join(dir, 'controller'), authority: join(dir, 'authority'), journal: join(dir, 'journal') };
  const minter = openChangeMinter(paths.registry, clock);
  const records = goals.map((n) => minter.mint({ repository: REPO, source: { schemaVersion: 1, ...sourceOf(n), createdAt: T,
    submittedBy: HUMAN, objective: `Governed fixture objective ${n}.` } }));
  const admitter = openRootRunAdmitter(paths.controller, clock);
  const runs = admit ? records.map((record) => admitter.admit({ repository: record.repository, sliceId: record.sliceId,
    changeKey: record.changeKey }).runId) : [];
  const [record] = records;
  const runId = runs[0] ?? `run-${record.changeKey}`;
  const reality = fakeReality();
  const realPreserver = openDirectAuthorityPreserver(paths.authority);
  const preserver = wrap ? wrap(realPreserver) : realPreserver;
  const controller = new AutomationController(clock, hookedStore(paths.controller, (run) => onWrite(run, paths)), reality);
  const core = openGovernedActivationCore({ controllerStoreDirectory: paths.controller, authorityArchiveDirectory: paths.authority,
    changeRegistryDirectory: paths.registry, controller, preserver, architectPrincipalRef: ARCHITECT, clock });
  const sliceId = record.sliceId;
  const packet = (overrides) => packetOf(sliceId, overrides);
  const bundle = ({ packetOverrides, grants, packetDocument } = {}) => {
    const body = packet(packetOverrides);
    return { implementationPacket: packetDocument ?? document('IMPLEMENTATION_PACKET', body),
      liveCallAuthorizations: grants ?? [document('AUTHORIZATION', grantOf(IMPL, runId), { sliceId }),
        document('AUTHORIZATION', grantOf(REVIEW, runId), { sliceId })] };
  };
  return { paths, records, record, runs, runId, sliceId, controller, reality, preserver, realPreserver, core, packet, bundle,
    target: (n = 1, id = runId) => ({ source: sourceOf(n), runId: id }),
    read: () => readGovernedModel({ controllerStoreDirectory: paths.controller, authorityArchiveDirectory: paths.authority }, clock),
    archive: () => openAuthorityArchiveReader(paths.authority),
    doc: (kind, body, options = {}) => document(kind, body, { sliceId, ...options }) };
}
function refused(fn, code) {
  let caught;
  try { fn(); } catch (error) { caught = error; }
  assert.ok(caught instanceof GovernedActivationError, `expected ${code}, got ${caught?.stack ?? 'no error'}`);
  assert.equal(caught.code, code, caught.message);
  return caught;
}
function tree(root) {
  if (!existsSync(root)) return null;
  const walk = (path, rel) => readdirSync(path).sort().flatMap((name) => {
    const child = join(path, name), key = rel ? `${rel}/${name}` : name, status = lstatSync(child, { bigint: true });
    const meta = [key, status.mode, status.ino, status.size, status.mtimeNs];
    if (status.isSymbolicLink()) return [[...meta, 'link', readlinkSync(child)]];
    if (status.isDirectory()) return [[...meta, 'dir'], ...walk(child, key)];
    return [[...meta, 'file', readFileSync(child).toString('base64')]];
  });
  return walk(root, '');
}
const stores = (w) => [w.paths.registry, w.paths.controller, w.paths.authority].map(tree);
/** A refusal decided before any write: every store byte-identical. */
function refusedUntouched(w, fn, code) {
  const before = stores(w);
  const error = refused(fn, code);
  assert.deepEqual(stores(w), before, `${code}: a refused activation wrote something`);
  return error;
}
const runOf = (w, model = w.read()) => model.runs.find((run) => run.runId === w.runId);
const sha = (text) => createHash('sha256').update(text).digest('hex');
function plantRun(w, run) {
  const payload = JSON.stringify(run);
  writeFileSync(join(w.paths.controller, `${sha(run.runId)}.json`), JSON.stringify({ schemaVersion: 1, run: JSON.parse(payload), checksum: sha(payload) }));
}
const versions = (w, kind, id) => w.archive().listVersions(kind, id).length;

// ---------------------------------------------------------------- activation
check('A-AK. an exact CM1 + RA1 IDLE ROOT with exact Architect and Human documents activates to PACKET_READY, and nothing further', (dir) => {
  const w = world(dir);
  const view = w.core.inspect(w.target());
  assert.deepEqual([view.position, view.state, view.humanPrincipalRef, view.packet], ['IDLE', 'IDLE', HUMAN.principalRef, null]);
  const result = w.core.activate(w.target(), w.bundle());
  assert.deepEqual([result.status, result.preState, result.state, result.changeKey], ['ACTIVATED', 'IDLE', 'PACKET_READY', w.record.changeKey]);
  assert.deepEqual(result.packet.packetId, 'packet-1');
  assert.notEqual(result.preSnapshotId, result.postSnapshotId);
  assert.deepEqual(result.authority.liveCallAuthorizations.map((item) => item.actorKind), ['IMPLEMENTATION', 'ARCHITECT_REVIEW']);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.authority));
  const audit = w.controller.audit(w.runId);
  assert.deepEqual(audit.map((entry) => [entry.action, entry.actor, entry.role]),
    [['ENTER_ARCHITECTURE', ARCHITECT, 'GPT_ARCHITECT'], ['ISSUE_PACKET', ARCHITECT, 'GPT_ARCHITECT']]);
  // AK. R4A0 resolves the packet to exactly the archived version.
  const run = runOf(w);
  const reference = run.authority.find((item) => item.locator === 'activePacket');
  assert.deepEqual([reference.required, reference.resolution, reference.authority], [true, 'RESOLVED', result.authority.implementationPacket]);
  // LD1 now finds the run READY (the configured grants are the archived ones); activation stepped nothing.
  let steps = 0;
  const driver = openGovernedExecutionDriver({ controllerStoreDirectory: w.paths.controller, authorityArchiveDirectory: w.paths.authority,
    changeRegistryDirectory: w.paths.registry, runner: { step: async () => { steps += 1; } }, scopes: SCOPES, clock,
    liveCallAuthorizations: { IMPLEMENTATION: grantOf(IMPL, w.runId), ARCHITECT_REVIEW: grantOf(REVIEW, w.runId) } });
  assert.equal(driver.inspect(w.target()).readiness, 'READY');
  assert.equal(steps, 0);
  assert.equal(JSON.stringify(result).includes(dir), false, 'a path leaked');
});
check('B. every document is durably in R4P before the Controller relies on it', (dir) => {
  const seen = [];
  const w = world(dir, { onWrite: (run, paths) => {
    const reader = openAuthorityArchiveReader(paths.authority);
    seen.push([run.audit.at(-1).action, reader.listVersions('IMPLEMENTATION_PACKET', 'packet-1').length,
      reader.listVersions('AUTHORIZATION', 'auth-implementation').length, reader.listVersions('AUTHORIZATION', 'auth-architect-review').length]);
  } });
  w.core.activate(w.target(), w.bundle());
  assert.deepEqual(seen, [['ENTER_ARCHITECTURE', 1, 1, 1], ['ISSUE_PACKET', 1, 1, 1]]);
});
check('C-F. exact retries converge: one version per document, one packet, no duplicate transition', (dir) => {
  const w = world(dir);
  w.core.activate(w.target(), w.bundle());
  const again = w.core.activate(w.target(), w.bundle());
  assert.deepEqual([again.status, again.preState], ['ALREADY_ACTIVATED', 'PACKET_READY']);
  // F. a fresh process over the same roots
  const controller = new AutomationController(clock, new FileControllerStore(w.paths.controller, clock), w.reality);
  const core = openGovernedActivationCore({ controllerStoreDirectory: w.paths.controller, authorityArchiveDirectory: w.paths.authority,
    changeRegistryDirectory: w.paths.registry, controller, preserver: openDirectAuthorityPreserver(w.paths.authority),
    architectPrincipalRef: ARCHITECT, clock });
  assert.equal(core.activate(w.target(), w.bundle()).status, 'ALREADY_ACTIVATED');
  assert.equal(w.controller.audit(w.runId).length, 2);
  assert.deepEqual([versions(w, 'IMPLEMENTATION_PACKET', 'packet-1'), versions(w, 'AUTHORIZATION', 'auth-implementation'),
    versions(w, 'AUTHORIZATION', 'auth-architect-review')], [1, 1, 1]);
});
check('D. a crash after authority publication, before ENTER_ARCHITECTURE: the run stays IDLE and the exact retry completes', (dir) => {
  let crash = true;
  const w = world(dir, { onWrite: () => { if (crash) throw new Error('crash during controller write'); } });
  refused(() => w.core.activate(w.target(), w.bundle()), 'ACTIVATION_INCOMPLETE');
  assert.equal(runOf(w).state, 'IDLE');
  assert.equal(versions(w, 'IMPLEMENTATION_PACKET', 'packet-1'), 1, 'authority is ahead of the Controller');
  crash = false;
  const result = w.core.activate(w.target(), w.bundle());
  assert.deepEqual([result.status, result.preState], ['ACTIVATED', 'IDLE']);
  assert.equal(versions(w, 'IMPLEMENTATION_PACKET', 'packet-1'), 1);
});
check('E. a crash after ENTER_ARCHITECTURE, before ISSUE_PACKET: the exact retry issues the packet', (dir) => {
  let writes = 0;
  const w = world(dir, { onWrite: () => { writes += 1; if (writes === 2) throw new Error('crash during controller write'); } });
  refused(() => w.core.activate(w.target(), w.bundle()), 'ACTIVATION_INCOMPLETE');
  assert.deepEqual([runOf(w).state, w.core.inspect(w.target()).position], ['ARCHITECTURE', 'ARCHITECTURE_ENTERED']);
  const result = w.core.activate(w.target(), w.bundle());
  assert.deepEqual([result.status, result.preState, result.state], ['ACTIVATED', 'ARCHITECTURE', 'PACKET_READY']);
  assert.deepEqual(w.controller.audit(w.runId).map((entry) => entry.action), ['ENTER_ARCHITECTURE', 'ISSUE_PACKET']);
});
check('G-H. another packet at PACKET_READY is ACTIVATION_CONFLICT; any later state is ALREADY_ADVANCED; nothing is written or reset', (dir) => {
  const w = world(dir);
  w.core.activate(w.target(), w.bundle());
  const other = w.bundle({ packetOverrides: { packetId: 'packet-2', objective: 'Another packet' },
    grants: [w.doc('AUTHORIZATION', grantOf(IMPL, w.runId, { packetId: 'packet-2', authorizationId: 'auth-2i' })),
      w.doc('AUTHORIZATION', grantOf(REVIEW, w.runId, { packetId: 'packet-2', authorizationId: 'auth-2r' }))] });
  refusedUntouched(w, () => w.core.activate(w.target(), other), 'ACTIVATION_CONFLICT');
  const reworded = w.bundle({ packetOverrides: { objective: 'Same id, other body' } });
  refusedUntouched(w, () => w.core.activate(w.target(), reworded), 'ACTIVATION_CONFLICT');
  w.controller.beginImplementation(w.runId, X);
  refusedUntouched(w, () => w.core.activate(w.target(), w.bundle()), 'ACTIVATION_ALREADY_ADVANCED');
  assert.equal(w.core.inspect(w.target()).position, 'ADVANCED');
  assert.equal(runOf(w).state, 'IMPLEMENTING');
});
check('I. source, Change and run must be exactly bound; the target supplies no identity facts', (dir) => {
  const w = world(dir, { goals: [1, 2] });
  refusedUntouched(w, () => w.core.activate(w.target(1, w.runs[1]), w.bundle()), 'ACTIVATION_TARGET_MISMATCH');
  refusedUntouched(w, () => w.core.activate(w.target(9), w.bundle()), 'ACTIVATION_CHANGE_NOT_FOUND');
  refusedUntouched(w, () => w.core.activate(w.target(1, 'run-unknown'), w.bundle()), 'ACTIVATION_RUN_NOT_FOUND');
  for (const extra of [{ repository: REPO }, { sliceId: w.sliceId }, { changeKey: w.record.changeKey }]) {
    refusedUntouched(w, () => w.core.activate({ ...w.target(), ...extra }, w.bundle()), 'ACTIVATION_TARGET_INVALID');
  }
  const unadmitted = world(join(dir, 'unadmitted'), { admit: false });
  refusedUntouched(unadmitted, () => unadmitted.core.activate(unadmitted.target(), unadmitted.bundle()), 'ACTIVATION_RUN_NOT_FOUND');
  assert.deepEqual(readdirSync(unadmitted.paths.controller).filter((name) => name.endsWith('.json')), [], 'activation created a run');
});
check('J-K. a non-ROOT run or any R4A0 anomaly fails closed before anything is written', (dir) => {
  const w = world(dir);
  plantRun(w, { runId: 'run-sibling', sliceId: w.sliceId, repository: REPO, state: 'IDLE', implementationIterations: 0, acceptanceFailures: 0, audit: [] });
  refusedUntouched(w, () => w.core.activate(w.target(1, 'run-sibling'), w.bundle()), 'ACTIVATION_ADMISSION_INVALID');
  refusedUntouched(w, () => w.core.activate(w.target(), w.bundle()), 'ACTIVATION_READ_MODEL_CONFLICT');
  const k = world(join(dir, 'k'));
  plantRun(k, { runId: 'legacy-1', sliceId: 'legacy-slice', repository: REPO, state: 'IDLE', implementationIterations: 0, acceptanceFailures: 0, audit: [] });
  const error = refusedUntouched(k, () => k.core.activate(k.target(), k.bundle()), 'ACTIVATION_READ_MODEL_CONFLICT');
  assert.equal(error.reason, 'GOVERNANCE_ANOMALY');
});
check('L-O. the packet document must name this exact Change and be issued by the configured Architect', (dir) => {
  const w = world(dir);
  const packetDocument = (body, options) => w.bundle({ packetDocument: document('IMPLEMENTATION_PACKET', body, options) });
  refusedUntouched(w, () => w.core.activate(w.target(), packetDocument(w.packet({ sliceId: 'goal-other' }))), 'AUTHORITY_SUBJECT_MISMATCH');
  const bodyOnly = w.bundle();
  bodyOnly.implementationPacket.body.sliceId = 'goal-other';
  refusedUntouched(w, () => w.core.activate(w.target(), bodyOnly), 'AUTHORITY_DOCUMENT_INVALID');
  refusedUntouched(w, () => w.core.activate(w.target(), packetDocument(w.packet(), { repository: 'synthetic/other' })), 'AUTHORITY_SUBJECT_MISMATCH');
  refusedUntouched(w, () => w.core.activate(w.target(), packetDocument(w.packet(), { role: 'HUMAN', principalRef: HUMAN.principalRef })),
    'AUTHORITY_ISSUER_MISMATCH');
  refusedUntouched(w, () => w.core.activate(w.target(), packetDocument(w.packet(), { principalRef: 'architect:someone-else' })),
    'AUTHORITY_ISSUER_MISMATCH');
  // Naked bodies, operational records and non-canonical documents are not direct authority.
  refusedUntouched(w, () => w.core.activate(w.target(), { implementationPacket: w.packet(), liveCallAuthorizations: [] }), 'AUTHORITY_DOCUMENT_INVALID');
  refusedUntouched(w, () => w.core.activate(w.target(), { ...w.bundle(), extra: true }), 'AUTHORITY_DOCUMENT_INVALID');
  const wrongClass = w.bundle();
  wrongClass.implementationPacket.recordClass = 'OPERATIONAL_RECORD';
  refusedUntouched(w, () => w.core.activate(w.target(), wrongClass), 'AUTHORITY_DOCUMENT_INVALID');
  assert.equal(runOf(w).state, 'IDLE');
});
check('P-V. each Human grant is issued by the CM1-attributed Human and binds this run, packet and one exact call entry', (dir) => {
  const w = world(dir);
  const withImplementation = (grant, options) => w.bundle({ grants: [w.doc('AUTHORIZATION', grant, options), w.doc('AUTHORIZATION', grantOf(REVIEW, w.runId))] });
  const cases = [
    ['P another Human', grantOf(IMPL, w.runId), { principalRef: 'human:someone-else' }, 'HUMAN_PRINCIPAL_MISMATCH'],
    ['P2 a GPT-issued grant', grantOf(IMPL, w.runId, { actorRole: 'GPT_ARCHITECT' }), {}, 'AUTHORITY_ISSUER_MISMATCH'],
    ['Q wrong runId', grantOf(IMPL, `${w.runId}-other`), {}, 'LIVE_CALL_GRANT_NOT_BOUND'],
    ['R wrong packetId', grantOf(IMPL, w.runId, { packetId: 'packet-2' }), {}, 'LIVE_CALL_GRANT_NOT_BOUND'],
    ['S wrong actor', grantOf(IMPL, w.runId, { scope: { ...structuredClone(IMPL), actorKind: 'ARCHITECT_REVIEW' } }), {}, 'LIVE_CALL_GRANT_NOT_BOUND'],
    ['T wrong provider', grantOf(IMPL, w.runId, { scope: { ...structuredClone(IMPL), provider: 'openai' } }), {}, 'LIVE_CALL_GRANT_NOT_BOUND'],
    ['U wrong model', grantOf(IMPL, w.runId, { scope: { ...structuredClone(IMPL), model: 'claude-sonnet-5-5' } }), {}, 'LIVE_CALL_GRANT_NOT_BOUND'],
    ['V egress subset', grantOf(IMPL, w.runId, { scope: { ...structuredClone(IMPL), egressDestinations: ['api.anthropic.com:443'] } }), {}, 'LIVE_CALL_GRANT_NOT_BOUND'],
    ['V2 egress superset', grantOf(IMPL, w.runId, { scope: { ...structuredClone(IMPL), egressDestinations: [...IMPL_EGRESS, 'chatgpt.com:443'].sort() } }), {}, 'LIVE_CALL_GRANT_NOT_BOUND'],
    ['another operation', grantOf(IMPL, w.runId, { operation: 'READ_EXTERNAL_API' }), {}, 'LIVE_CALL_GRANT_NOT_BOUND'],
    ['another target', grantOf(IMPL, w.runId, { target: 'api.anthropic.com:443' }), {}, 'LIVE_CALL_GRANT_NOT_BOUND'],
    ['wrong subject', grantOf(IMPL, w.runId), { sliceId: 'goal-other' }, 'AUTHORITY_SUBJECT_MISMATCH'],
  ];
  for (const [label, grant, options, code] of cases) {
    const error = refusedUntouched(w, () => w.core.activate(w.target(), withImplementation(grant, options)), code);
    assert.equal(error.code, code, label);
  }
  assert.equal(runOf(w).state, 'IDLE');
});
check('W-AA. the packet call entries are covered exactly once; disabled provider calls take no grant', (dir) => {
  const w = world(dir);
  const impl = w.doc('AUTHORIZATION', grantOf(IMPL, w.runId)), review = w.doc('AUTHORIZATION', grantOf(REVIEW, w.runId));
  refusedUntouched(w, () => w.core.activate(w.target(), w.bundle({ grants: [impl] })), 'LIVE_CALL_GRANT_MISSING');
  refusedUntouched(w, () => w.core.activate(w.target(), w.bundle({ grants: [] })), 'LIVE_CALL_GRANT_MISSING');
  const onlyImplementation = { providerCallAuthorization: { allowed: true, calls: [structuredClone(IMPL)], maxCalls: 2, budget: 0 } };
  refusedUntouched(w, () => w.core.activate(w.target(), w.bundle({ packetOverrides: onlyImplementation, grants: [impl, review] })), 'LIVE_CALL_GRANT_EXTRA');
  const second = w.doc('AUTHORIZATION', grantOf(IMPL, w.runId, { authorizationId: 'auth-implementation-2' }));
  refusedUntouched(w, () => w.core.activate(w.target(), w.bundle({ grants: [impl, second, review] })), 'LIVE_CALL_GRANT_DUPLICATE');
  refusedUntouched(w, () => w.core.activate(w.target(), w.bundle({ grants: [impl, impl, review] })), 'LIVE_CALL_GRANT_DUPLICATE');
  const disabled = { providerCallAuthorization: { allowed: false, calls: [], maxCalls: 0, budget: 0 } };
  refusedUntouched(w, () => w.core.activate(w.target(), w.bundle({ packetOverrides: disabled, grants: [impl] })), 'LIVE_CALL_GRANT_EXTRA');
  const result = w.core.activate(w.target(), w.bundle({ packetOverrides: disabled, grants: [] }));
  assert.deepEqual([result.status, result.authority.liveCallAuthorizations], ['ACTIVATED', []]);
});

// ---------------------------------------------------------------- the preserver
check('AB-AC. the preserver: one append capability, idempotent exact retry, a different body at an archived version fails closed', (dir) => {
  const root = join(dir, 'authority');
  const preserver = openDirectAuthorityPreserver(root);
  assert.deepEqual(Object.keys(preserver), ['preserve']);
  assert.ok(Object.isFrozen(preserver));
  assert.deepEqual(Object.keys(preserverModule).sort(), ['AuthorityPreservationError', 'openDirectAuthorityPreserver']);
  assert.equal(existsSync(root), false, 'opening the preserver created the archive');
  const grant = document('AUTHORIZATION', grantOf(IMPL, 'run-1'), { sliceId: 'slice-1' });
  const first = preserver.preserve(grant);
  assert.deepEqual(preserver.preserve(structuredClone(grant)), first);
  const changed = { ...structuredClone(grant), body: { ...grant.body, reason: 'another statement' } };
  let caught;
  try { preserver.preserve(changed); } catch (error) { caught = error; }
  assert.ok(caught instanceof AuthorityPreservationError);
  assert.deepEqual([caught.code, caught.archiveCode], ['AUTHORITY_VERSION_CONFLICT', 'VERSION_CONFLICT']);
  assert.equal(caught.message.includes(root), false);
  assert.deepEqual(openAuthorityArchiveReader(root).get(first).body, grant.body, 'the archived version was overwritten');
  // Only complete canonical documents: operational records and naked bodies are refused, never converted.
  for (const input of [grant.body, { invocationId: 'x', state: 'COMPLETED', recordClass: 'OPERATIONAL_RECORD' },
    { sequence: 1, action: 'ACCEPT_EXACT_SHA', actor: 'controller' }, { ...grant, recordClass: 'OPERATIONAL_RECORD' },
    { schemaVersion: 1, kind: 'CHANGE_MINT', recordClass: 'OPERATIONAL_RECORD' }, null, 'text']) {
    let error;
    try { preserver.preserve(input); } catch (thrown) { error = thrown; }
    assert.equal(error?.code, 'AUTHORITY_DOCUMENT_INVALID', JSON.stringify(input));
  }
  // A gap or a broken supersession is refused, never re-numbered.
  for (const options of [{ version: 3, supersedes: first }, { version: 2, supersedes: null }]) {
    let error;
    try { preserver.preserve(document('AUTHORIZATION', { ...grantOf(IMPL, 'run-1'), reason: 'v2' }, { sliceId: 'slice-1', ...options })); }
    catch (thrown) { error = thrown; }
    assert.equal(error?.code, 'AUTHORITY_DOCUMENT_INVALID');
  }
  assert.equal(openAuthorityArchiveReader(root).listVersions('AUTHORIZATION', 'auth-implementation').length, 1);
});
check('AM-AN. a later version of the same packet document never stands in for the run\'s exact reference', (dir) => {
  const w = world(dir);
  const activated = w.core.activate(w.target(), w.bundle());
  const later = w.preserver.preserve(w.doc('IMPLEMENTATION_PACKET', w.packet({ objective: 'Revised wording' }),
    { version: 2, supersedes: activated.authority.implementationPacket }));
  assert.equal(later.version, 2);
  const reference = runOf(w).authority.find((item) => item.locator === 'activePacket');
  assert.deepEqual([reference.resolution, reference.authority], ['RESOLVED', activated.authority.implementationPacket]);
  // An exact retry still names version 1; a retry carrying the revised body is a different packet.
  assert.equal(w.core.activate(w.target(), w.bundle()).status, 'ALREADY_ACTIVATED');
  refusedUntouched(w, () => w.core.activate(w.target(), w.bundle({ packetOverrides: { objective: 'Revised wording' } })), 'ACTIVATION_CONFLICT');
});

// ---------------------------------------------------------------- architect review authority
/** An activated world driven by the real runner, with the real sink over `preserver`, to ACCEPTANCE_REVIEW. */
async function reviewWorld(dir, { preserver, review } = {}) {
  const seen = [];
  const w = world(dir, { onWrite: (run, paths) => {
    const reader = openAuthorityArchiveReader(paths.authority);
    seen.push([run.audit.at(-1).action, reader.listVersions('ACCEPTANCE_DECISION', 'review-1').length,
      reader.listVersions('CORRECTION_PACKET', 'correction-1').length]);
  } });
  w.core.activate(w.target(), w.bundle());
  const journal = new FileInvocationJournal(w.paths.journal, clock);
  const ports = modelPorts(() => journal, { review });
  const sink = architectReviewAuthority(preserver ? preserver(w.realPreserver) : w.realPreserver, ARCHITECT);
  const runner = new AutomationRunner(w.controller, ports.implementation, ports.review, { journal, clock, scopes: SCOPES,
    authorizations: { IMPLEMENTATION: grantOf(IMPL, w.runId), ARCHITECT_REVIEW: grantOf(REVIEW, w.runId) }, architectAuthority: sink });
  for (let i = 0; i < 4; i++) await runner.step(w.runId);
  assert.equal(w.controller.get(w.runId).state, 'ACCEPTANCE_REVIEW');
  seen.length = 0;
  return { w, journal, ports, runner, seen, sink };
}
const rejecting = (input) => ({ decision: { reviewId: 'review-1', actor: 'GPT_ARCHITECT', packetId: input.packet.packetId,
  packetHash: input.packetHash, reviewedSha: input.remoteSha.sha, decision: 'REJECT', findings: ['synthetic finding'],
  evidenceReferences: ['diff'], issuedAt: T },
  correction: { correctionPacketId: 'correction-1', originalPacketId: input.packet.packetId, originalPacketHash: input.packetHash,
    rejectedSha: input.remoteSha.sha, reviewerFindings: ['synthetic finding'], allowedCorrectionAreas: ['src/automation'],
    unchangedInvariantReferences: input.packet.invariants, expectedBaseSha: input.remoteSha.sha, correctionIteration: 2, maxCorrectionIteration: 3 } });
check('AD-AL-AI-AJ. ACCEPT: the decision is archived before the Controller reaches ACCEPTED; R4A0 resolves it; journal and audit stay operational', async (dir) => {
  const { w, journal, ports, runner, seen } = await reviewWorld(dir);
  const result = await runner.step(w.runId);
  assert.deepEqual([result.outcome, result.state], ['HUMAN_PROMOTION_REQUIRED', 'ACCEPTED']);
  assert.deepEqual(seen, [['ACCEPT_EXACT_SHA', 1, 0]], 'the Controller wrote ACCEPTED before the decision was archived');
  const accepted = w.controller.audit(w.runId).at(-1);
  assert.deepEqual([accepted.actor, accepted.role], [ARCHITECT, 'GPT_ARCHITECT']);
  const model = w.read();
  const reference = runOf(w, model).authority.find((item) => item.locator === 'acceptance');
  assert.deepEqual([reference.required, reference.resolution, reference.authority.kind, reference.authority.version],
    [true, 'RESOLVED', 'ACCEPTANCE_DECISION', 1]);
  const fact = model.authority.find((item) => item.ref.kind === 'ACCEPTANCE_DECISION');
  assert.deepEqual([fact.issuer.role, fact.issuer.principalRef, fact.subject.repository, fact.subject.sliceId],
    ['GPT_ARCHITECT', ARCHITECT, REPO, w.sliceId]);
  assert.equal(ports.calls.review, 1);
  // AI / AJ. The journal record stays an operational record; nothing operational is in the archive.
  const [, review] = journal.list(w.runId).sort((a, b) => a.identity.occurrence.sequence - b.identity.occurrence.sequence);
  assert.deepEqual([review.state, review.identity.actorKind], ['APPLIED', 'ARCHITECT_REVIEW']);
  assert.equal(JSON.stringify(review).includes('DIRECT_AUTHORITY'), false);
  assert.deepEqual(model.authority.map((item) => item.ref.kind).sort(), ['ACCEPTANCE_DECISION', 'AUTHORIZATION', 'AUTHORIZATION', 'IMPLEMENTATION_PACKET']);
  assert.equal(JSON.stringify(w.controller.audit(w.runId)).includes('DIRECT_AUTHORITY'), false);
  assert.ok(runOf(w, model).authority.filter((item) => item.locator.startsWith('audit#')).every((item) => item.required === false));
});
check('AE. REJECT with a correction: both are archived before the Controller consumes either', async (dir) => {
  const { w, runner, seen } = await reviewWorld(dir, { review: rejecting });
  const result = await runner.step(w.runId);
  assert.deepEqual([result.state, w.controller.get(w.runId).correctionPacket?.correctionPacketId], ['CORRECTION_REQUIRED', 'correction-1']);
  assert.deepEqual(seen, [['REJECT_EXACT_SHA', 1, 1], ['ISSUE_CORRECTION_PACKET', 1, 1]]);
  const run = runOf(w);
  assert.deepEqual(run.authority.filter((item) => item.required).map((item) => [item.locator, item.resolution]),
    [['activePacket', 'RESOLVED'], ['correctionPacket', 'RESOLVED'], ['acceptance', 'RESOLVED']]);
});
check('AF-AH. a decision that cannot be preserved is not applied; the run stays ACCEPTANCE_REVIEW; the retry applies the stored result without the reviewer', async (dir) => {
  let failing = true;
  const flaky = (real) => ({ preserve(document) {
    if (failing && document.kind === 'ACCEPTANCE_DECISION') throw new AuthorityPreservationError('AUTHORITY_PRESERVATION_FAILED', 'PUBLICATION_UNAVAILABLE');
    return real.preserve(document);
  } });
  const { w, journal, ports, runner, seen } = await reviewWorld(dir, { preserver: flaky });
  const result = await runner.step(w.runId);
  assert.deepEqual([result.outcome, result.state], ['AUTHORITY_NOT_PRESERVED', 'ACCEPTANCE_REVIEW']);
  assert.equal(result.detail, 'direct authority preservation failed; review result not applied');
  assert.deepEqual(seen, [], 'the Controller was written');
  assert.equal(w.archive().listVersions('ACCEPTANCE_DECISION', 'review-1').length, 0);
  const review = journal.list(w.runId).find((record) => record.identity.actorKind === 'ARCHITECT_REVIEW');
  assert.equal(review.state, 'COMPLETED', 'the stored result is neither applied nor discarded');
  // Still failing: the next step tries again, never the reviewer.
  assert.equal((await runner.step(w.runId)).outcome, 'AUTHORITY_NOT_PRESERVED');
  failing = false;
  const retried = await runner.step(w.runId);
  assert.deepEqual([retried.outcome, retried.state], ['HUMAN_PROMOTION_REQUIRED', 'ACCEPTED']);
  assert.equal(ports.calls.review, 1, 'a preservation failure re-dispatched the reviewer');
  assert.equal(journal.get(review.invocationId).state, 'APPLIED');
});
check('AG. a correction that cannot be preserved after its decision was: nothing is applied; the archived decision stays unused', async (dir) => {
  const flaky = (real) => ({ preserve(document) {
    if (document.kind === 'CORRECTION_PACKET') throw new AuthorityPreservationError('AUTHORITY_PRESERVATION_FAILED', null);
    return real.preserve(document);
  } });
  const { w, ports, runner, seen } = await reviewWorld(dir, { preserver: flaky, review: rejecting });
  const result = await runner.step(w.runId);
  assert.deepEqual([result.outcome, result.state], ['AUTHORITY_NOT_PRESERVED', 'ACCEPTANCE_REVIEW']);
  assert.deepEqual(seen, []);
  assert.deepEqual([w.archive().listVersions('ACCEPTANCE_DECISION', 'review-1').length, w.archive().listVersions('CORRECTION_PACKET', 'correction-1').length], [1, 0]);
  assert.equal(runOf(w).acceptanceFailures ?? w.controller.get(w.runId).acceptanceFailures, 0);
  assert.equal(ports.calls.review, 1);
});
check('AG2. a review the archive refuses (its reviewId already holds another body) is not applied: ARCHITECTURE_STOP, no re-dispatch', async (dir) => {
  const { w, journal, ports, runner, seen } = await reviewWorld(dir);
  const run = w.controller.get(w.runId);
  w.realPreserver.preserve(w.doc('ACCEPTANCE_DECISION', { ...decisionOf({ ...run, remoteSha: { sha: B } }, 'ACCEPT', 'review-1'), evidenceReferences: ['other'] }));
  const result = await runner.step(w.runId);
  assert.deepEqual([result.outcome, result.state, result.stopReason], ['STOPPED', 'ARCHITECTURE_STOP',
    'direct authority preservation refused; review result not applied']);
  assert.deepEqual(seen.map(([action]) => action), ['STOP']);
  const review = journal.list(w.runId).find((record) => record.identity.actorKind === 'ARCHITECT_REVIEW');
  assert.equal(review.state, 'APPLIED', 'the stop settles the invocation');
  assert.equal(review.application.action, 'STOP');
  assert.equal(ports.calls.review, 1);
  // A malformed correction from the reviewer is refused the same way.
  const bad = await reviewWorld(join(dir, 'bad'), { review: (input) => ({ ...rejecting(input), correction: { correctionPacketId: 'correction-1' } }) });
  const stopped = await bad.runner.step(bad.w.runId);
  assert.deepEqual([stopped.state, bad.w.archive().listVersions('ACCEPTANCE_DECISION', 'review-1').length], ['ARCHITECTURE_STOP', 0]);
});

// ---------------------------------------------------------------- correction recovery
/** An activated run at CORRECTION_REQUIRED after an archived REJECT, with no correction issued. */
function rejected(dir) {
  const w = world(dir);
  w.core.activate(w.target(), w.bundle());
  const c = w.controller, architect = { id: ARCHITECT, role: 'GPT_ARCHITECT' };
  c.beginImplementation(w.runId, X);
  c.completeImplementation(w.runId, X, ['npm test: exit 0']);
  c.recordRemoteSha(w.runId, X);
  c.beginAcceptanceReview(w.runId, architect);
  const decision = decisionOf(c.get(w.runId), 'REJECT', 'review-1');
  w.realPreserver.preserve(w.doc('ACCEPTANCE_DECISION', decision));
  c.decideAcceptance(w.runId, architect, decision);
  return w;
}
check('AO. applyCorrection acts only where R4A0\'s exact next move is ISSUE_CORRECTION_PACKET, preserved first', (dir) => {
  const early = world(join(dir, 'early'));
  early.core.activate(early.target(), early.bundle());
  const stand = { correctionPacketId: 'correction-1', originalPacketId: 'packet-1', originalPacketHash: 'f'.repeat(64), rejectedSha: B,
    reviewerFindings: ['synthetic finding'], allowedCorrectionAreas: ['src/automation'], unchangedInvariantReferences: ['human authority retained'],
    expectedBaseSha: B, correctionIteration: 2, maxCorrectionIteration: 3 };
  refusedUntouched(early, () => early.core.applyCorrection(early.target(), early.doc('CORRECTION_PACKET', stand)), 'CORRECTION_NOT_APPLICABLE');
  const w = rejected(dir);
  const correction = correctionOf(w.controller.get(w.runId));
  const result = w.core.applyCorrection(w.target(), w.doc('CORRECTION_PACKET', correction));
  assert.deepEqual([result.status, result.state, result.correction.correctionPacketId], ['APPLIED', 'CORRECTION_REQUIRED', correction.correctionPacketId]);
  assert.equal(w.archive().listVersions('CORRECTION_PACKET', correction.correctionPacketId).length, 1);
  const run = runOf(w);
  assert.deepEqual(run.authority.find((item) => item.locator === 'correctionPacket').authority, result.correction.authority);
  assert.equal(w.controller.audit(w.runId).at(-1).actor, ARCHITECT);
  assert.equal(w.core.applyCorrection(w.target(), w.doc('CORRECTION_PACKET', correction)).status, 'ALREADY_APPLIED');
  assert.equal(w.controller.audit(w.runId).filter((entry) => entry.action === 'ISSUE_CORRECTION_PACKET').length, 1);
  // Once R4A0's next move is BEGIN_IMPLEMENTATION, another correction is not applicable and nothing is archived.
  const another = { ...correction, allowedCorrectionAreas: ['src/automation', 'src/intake'] };
  refusedUntouched(w, () => w.core.applyCorrection(w.target(), w.doc('CORRECTION_PACKET', { ...another, correctionPacketId: 'correction-other' })),
    'CORRECTION_NOT_APPLICABLE');
});
check('AP-AQ. a correction that does not bind the active packet, hash or rejected SHA, or is issued by anyone else, is refused unwritten', (dir) => {
  const w = rejected(dir);
  const run = w.controller.get(w.runId);
  const cases = [
    [correctionOf(run, { originalPacketHash: 'f'.repeat(64) }), {}, 'PACKET_BINDING_MISMATCH'],
    [correctionOf(run, { originalPacketId: 'packet-2' }), {}, 'PACKET_BINDING_MISMATCH'],
    [correctionOf(run, { rejectedSha: C, expectedBaseSha: C }), {}, 'PACKET_BINDING_MISMATCH'],
    [correctionOf(run, { correctionIteration: 3 }), {}, 'PACKET_BINDING_MISMATCH'],
    [correctionOf(run), { principalRef: 'architect:someone-else' }, 'AUTHORITY_ISSUER_MISMATCH'],
    [correctionOf(run), { sliceId: 'goal-other' }, 'AUTHORITY_SUBJECT_MISMATCH'],
  ];
  for (const [body, options, code] of cases) refusedUntouched(w, () => w.core.applyCorrection(w.target(), w.doc('CORRECTION_PACKET', body, options)), code);
  refusedUntouched(w, () => w.core.applyCorrection(w.target(), correctionOf(run)), 'AUTHORITY_DOCUMENT_INVALID');
  assert.equal(w.controller.get(w.runId).correctionPacket, undefined);
});

// ---------------------------------------------------------------- the live composition
const PINS = realpathSync(mkdtempSync(join(tmpdir(), 'chief-ap1-pins-')));
process.on('exit', () => rmSync(PINS, { recursive: true, force: true }));
const pinned = (name) => {
  const path = join(PINS, name);
  writeFileSync(path, `SYNTHETIC-${name.toUpperCase()}-BINARY\n`, { mode: 0o755 });
  return { executable: path, executableSha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
};
const directory = (path) => { mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700); return path; };
function liveConfig(dir, grants) {
  for (const path of ['repo', 'worktrees', 'deps']) directory(join(dir, path));
  const governance = join(dir, 'governance');
  return { repository: REPO, architectPrincipalRef: ARCHITECT, controllerStoreDirectory: directory(join(governance, 'controller')),
    authorityArchiveDirectory: directory(join(governance, 'authority')), changeRegistryDirectory: directory(join(governance, 'registry')),
    journalDirectory: join(dir, 'journal'), egressJournalDirectory: join(dir, 'egress'), environment: { allow: ['PATH'] },
    claude: { ...pinned('claude'), provider: IMPL.provider, model: IMPL.model, egressDestinations: [...IMPL_EGRESS], timeoutMs: 600_000, maxTurns: 40,
      maxStdoutBytes: 1_000_000, maxStderrBytes: 1_000_000 },
    codex: { ...pinned('codex'), provider: REVIEW.provider, model: REVIEW.model, egressDestinations: [...REVIEW_EGRESS], timeoutMs: 600_000,
      maxStdoutBytes: 1_000_000, maxStderrBytes: 1_000_000, maxResultBytes: 100_000, disabledFeatures: [] },
    git: { executable: 'git', remote: 'origin', repositoryPath: join(dir, 'repo'), worktreeRoot: join(dir, 'worktrees'), timeoutMs: 60_000,
      maxOutputBytes: 1_000_000, commitAuthor: { name: 'CHIEF automation', email: 'automation@example.invalid' }, validationTimeoutMs: 60_000,
      validationMaxOutputBytes: 1_000_000, linkedDirectories: [{ path: 'node_modules', source: join(dir, 'deps') }] },
    offlineValidation: { runtimeReadPaths: [], searchPath: '/usr/bin:/bin' }, modelProcess: { runtimeReadPaths: [], searchPath: '/usr/bin:/bin' },
    github: { executable: 'gh', workflowName: 'CI', requiredCheckName: 'test', timeoutMs: 10_000, maxOutputBytes: 1_000_000, maxObservationAgeMs: 60_000 },
    liveCallAuthorizations: grants };
}
function counted() {
  const count = { processes: 0 };
  const bump = async () => { count.processes += 1; };
  return { count, dependencies: { clock, environmentSource: { PATH: '/bin' }, executor: { run: bump }, syncExecutor: { runSync() { count.processes += 1; } },
    offlineValidation: { runOffline: bump }, modelProcess: { runModel: bump } } };
}
check('LIVE. the governed composition returns only execution and activation; activation there reaches PACKET_READY and LD1 READY; nothing runs', (dir) => {
  const base = realpathSync(dir);
  const probe = liveConfig(join(base, 'live'), {});
  const minted = openChangeMinter(probe.changeRegistryDirectory, clock).mint({ repository: REPO, source: { schemaVersion: 1, ...sourceOf(1),
    createdAt: T, submittedBy: HUMAN, objective: 'Live composition fixture.' } });
  const runId = openRootRunAdmitter(probe.controllerStoreDirectory, clock).admit({ repository: REPO, sliceId: minted.sliceId, changeKey: minted.changeKey }).runId;
  const grants = { IMPLEMENTATION: grantOf(IMPL, runId), ARCHITECT_REVIEW: grantOf(REVIEW, runId) };
  const { count, dependencies } = counted();
  const before = tree(probe.authorityArchiveDirectory);
  const composed = createGovernedLiveAutomation({ ...probe, liveCallAuthorizations: grants }, dependencies);
  assert.deepEqual(Object.keys(composed).sort(), ['activation', 'execution']);
  assert.deepEqual(Object.keys(composed.activation).sort(), ['activate', 'applyCorrection', 'inspect']);
  assert.deepEqual(Object.keys(composed.execution).sort(), ['inspect', 'step']);
  assert.deepEqual(tree(probe.authorityArchiveDirectory), before, 'composing opened or wrote the archive');
  const target = { source: sourceOf(1), runId };
  const doc = (kind, body) => document(kind, body, { sliceId: minted.sliceId });
  const result = composed.activation.activate(target, { implementationPacket: doc('IMPLEMENTATION_PACKET', packetOf(minted.sliceId)),
    liveCallAuthorizations: [doc('AUTHORIZATION', grants.IMPLEMENTATION), doc('AUTHORIZATION', grants.ARCHITECT_REVIEW)] });
  assert.equal(result.status, 'ACTIVATED');
  assert.equal(composed.execution.inspect(target).readiness, 'READY');
  assert.equal(count.processes, 0);
  for (const bad of [undefined, '', ' architect', 'a\u0000b']) {
    const { count: none, dependencies: deps } = counted();
    assert.throws(() => createGovernedLiveAutomation({ ...liveConfig(join(base, `bad-${none.processes}-${String(bad).length}`), {}), architectPrincipalRef: bad }, deps), TypeError);
    assert.equal(none.processes, 0);
  }
});

// ---------------------------------------------------------------- production topology (static)
function sources(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? sources(child) : entry.name.endsWith('.ts') ? [child] : [];
  });
}
const SRC = sources(join(ROOT, 'src'));
const text = (path) => readFileSync(path, 'utf8');
const rel = (path) => relative(ROOT, path);
const code = (path) => text(path).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const users = (pattern, except = []) => SRC.filter((path) => !except.includes(rel(path)) && pattern.test(text(path))).map(rel).sort();
const CORE = 'src/automation/activation-core.ts', PRESERVER = 'src/automation/authority/preserver.ts';
const SINK = 'src/automation/authority/architect-review-authority.ts', LIVE = 'src/automation/live/governed-execution.ts';
check('AR-AS-AT-AU. one minter (GC1), one run creator (RA1), one archive reader (R4A0), one appender holder (the preserver)', () => {
  assert.deepEqual(users(/openChangeMinter|ChangeMinter/, ['src/automation/change-registry.ts']), ['src/intake/goal-change-bridge.ts']);
  assert.deepEqual(users(/\.createRun\(/, ['src/automation/controller.ts']), ['src/automation/root-run-admitter.ts']);
  assert.deepEqual(users(/openAuthorityArchiveReader/, ['src/automation/authority/file-archive.ts']), ['src/automation/read-model/governed-read-model.ts']);
  assert.deepEqual(users(/openAuthorityArchiveAppender|AuthorityArchiveAppender/, ['src/automation/authority/file-archive.ts']), [PRESERVER]);
  assert.equal((code(join(ROOT, PRESERVER)).match(/openAuthorityArchiveAppender\(/g) ?? []).length, 1);
  assert.deepEqual(users(/openDirectAuthorityPreserver\(/, [PRESERVER]), [LIVE]);
  assert.equal((code(join(ROOT, LIVE)).match(/openDirectAuthorityPreserver\(/g) ?? []).length, 1);
  assert.deepEqual(users(/architectReviewAuthority\(/, [SINK]), [LIVE]);
  assert.deepEqual(users(/openGovernedActivationCore\(/, [CORE]), [LIVE]);
  assert.deepEqual(users(/createGovernedLiveAutomation\(/, [LIVE]), []);
  for (const file of [CORE, SINK, LIVE]) {
    assert.doesNotMatch(code(join(ROOT, file)), /createRun|openRootRunAdmitter|openChangeMinter|\.mint\(|openAuthorityArchive(Reader|Appender)|file-archive/, file);
  }
  // The core takes only the transitions activation and correction need.
  assert.doesNotMatch(code(join(ROOT, CORE)), /beginImplementation|completeImplementation|recordRemoteSha|beginAcceptanceReview|decideAcceptance|requestPromotion|beginPromotion|recordPromotedMain|resume|\.close\(|\.stop\(|failClosed|reconcile|runner|AutomationRunner|\.step\(|invocation-journal/);
  assert.match(code(join(ROOT, CORE)), /controller\.enterArchitecture\(/);
  assert.match(code(join(ROOT, CORE)), /controller\.issuePacket\(/);
  assert.match(code(join(ROOT, CORE)), /controller\.issueCorrection\(/);
});
check('AV-AW-AX. no Workspace, model, validation or LD1 path reaches an authority writer; the runner holds only the sink', () => {
  const workspace = SRC.filter((path) => rel(path).startsWith('src/workspace/'));
  assert.deepEqual(workspace.filter((path) => /preserver|Preserver|AuthorityArchive|architect-review-authority|activation-core/.test(text(path))).map(rel), []);
  for (const file of ['src/automation/live/claude-code-implementation.ts', 'src/automation/live/codex-architect-review.ts',
    'src/automation/live/seatbelt-model-process.ts', 'src/automation/live/model-process-isolation.ts', 'src/automation/live/seatbelt-validation.ts',
    'src/automation/offline-validation.ts', 'src/automation/execution-driver.ts', 'src/automation/runner.ts', 'src/automation/live/composition.ts']) {
    assert.doesNotMatch(text(join(ROOT, file)), /preserver\.js|openDirectAuthorityPreserver|AuthorityArchiveAppender|openAuthorityArchive|file-archive/, file);
  }
  assert.deepEqual(users(/architectAuthority/), ['src/automation/live/composition.ts', LIVE, 'src/automation/runner.ts']);
  // No route, UI control or event activates anything.
  assert.deepEqual(SRC.filter((path) => /['"`]\/[^'"`\s]*\/(activate|packet|authority|execute|step)['"`]/.test(text(path))).map(rel), []);
  const ui = readdirSync(join(ROOT, 'workspace-ui')).filter((name) => /\.(js|html)$/.test(name)).map((name) => readFileSync(join(ROOT, 'workspace-ui', name), 'utf8')).join('\n');
  assert.doesNotMatch(ui, /\/activate|\/authority|activation/i);
});

let passed = 0, failed = 0;
for (const [name, fn] of tests) {
  const dir = mkdtempSync(join(tmpdir(), 'chief-ap1-'));
  try { await fn(dir); console.log(`  PASS ${name}`); passed++; }
  catch (error) { console.error(`  FAIL ${name}: ${error.stack}`); failed++; }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
