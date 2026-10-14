import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync,
  writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as activationModule from './dist/automation/activation-core.js';
import { InMemoryControllerStore } from './dist/automation/audit.js';
import { architectReviewAuthority } from './dist/automation/authority/architect-review-authority.js';
import { openAuthorityArchiveReader } from './dist/automation/authority/file-archive.js';
import * as preserverModule from './dist/automation/authority/preserver.js';
import { openChangeMinter } from './dist/automation/change-registry.js';
import { AutomationController } from './dist/automation/controller.js';
import { FileControllerStore } from './dist/automation/durable-store.js';
import { openGovernedExecutionDriver } from './dist/automation/execution-driver.js';
import { packetHash } from './dist/automation/packet.js';
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
    architectPrincipalRef: ARCHITECT,
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

// ---------------------------------------------------------------- G1-AP1-C1 activation intent binding
const ARCH = { id: ARCHITECT, role: 'GPT_ARCHITECT' };
const OTHER_ARCH = { id: 'architect:another-principal', role: 'GPT_ARCHITECT' };
/** Packet n's complete bundle (packet-1 is the world's default bundle). */
const bundleN = (w, n) => n === 1 ? w.bundle() : w.bundle({ packetOverrides: { packetId: `packet-${n}`, objective: `Packet ${n}` },
  grants: [w.doc('AUTHORIZATION', grantOf(IMPL, w.runId, { packetId: `packet-${n}`, authorizationId: `auth-${n}i` })),
    w.doc('AUTHORIZATION', grantOf(REVIEW, w.runId, { packetId: `packet-${n}`, authorizationId: `auth-${n}r` }))] });
const intentOf = (bundle) => ({ packetId: bundle.implementationPacket.body.packetId, packetHash: packetHash(bundle.implementationPacket.body) });
/** A second activation core over the same roots (another process's view), with its own Controller and preserver. */
function coreOver(w, onWrite = () => {}, architectPrincipalRef = ARCHITECT) {
  const controller = new AutomationController(clock, hookedStore(w.paths.controller, (run) => onWrite(run)), w.reality);
  return { controller, core: openGovernedActivationCore({ controllerStoreDirectory: w.paths.controller, authorityArchiveDirectory: w.paths.authority,
    changeRegistryDirectory: w.paths.registry, controller, preserver: openDirectAuthorityPreserver(w.paths.authority), architectPrincipalRef, clock }) };
}
/** A world whose first activation of `bundle` crashed after ENTER_ARCHITECTURE, before ISSUE_PACKET. */
function enteredWorld(dir, n = 1) {
  let writes = 0;
  const w = world(dir, { onWrite: () => { writes += 1; if (writes === 2) throw new Error('crash during controller write'); } });
  refused(() => w.core.activate(w.target(), bundleN(w, n)), 'ACTIVATION_INCOMPLETE');
  return w;
}
const ACTIVATE_CHILD = `
  import { readFileSync } from 'node:fs';
  import { openGovernedActivationCore } from './dist/automation/activation-core.js';
  import { openDirectAuthorityPreserver } from './dist/automation/authority/preserver.js';
  import { AutomationController } from './dist/automation/controller.js';
  import { FileControllerStore } from './dist/automation/durable-store.js';
  const { paths, target, bundle, crashAfter, goAt, now, architect } = JSON.parse(readFileSync(process.argv[1], 'utf8'));
  const clock = { now: () => now };
  const inner = new FileControllerStore(paths.controller, clock);
  // A real crash: the process dies right after the named Controller write is durable.
  const store = { create: (run) => inner.create(run), get: (id) => inner.get(id), replace: (run) => inner.replace(run),
    entries: (id) => inner.entries(id),
    bindController() { const write = inner.bindController(); return (run) => { write(run); if (run.audit.at(-1).action === crashAfter) process.exit(0); }; } };
  const core = openGovernedActivationCore({ controllerStoreDirectory: paths.controller, authorityArchiveDirectory: paths.authority,
    changeRegistryDirectory: paths.registry, controller: new AutomationController(clock, store),
    preserver: openDirectAuthorityPreserver(paths.authority), architectPrincipalRef: architect, clock });
  const late = Date.now() > goAt;
  while (Date.now() < goAt) { /* start together */ }
  let outcome;
  try { outcome = core.activate(target, bundle).status; } catch (error) { outcome = error.code ?? error.message; }
  console.log(JSON.stringify({ outcome, late }));`;
let jobs = 0;
/** One activation of `bundle` in a separate process. Resolves { outcome, late } or { crashed: true }. */
function activateInProcess(w, bundle, { crashAfter = '', goAt = 0 } = {}) {
  const job = join(dirname(w.paths.controller), `job-${jobs++}.json`);
  writeFileSync(job, JSON.stringify({ paths: w.paths, target: w.target(), bundle, crashAfter, goAt, now: T, architect: ARCHITECT }));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', ACTIVATE_CHILD, job], { cwd: ROOT });
    let out = '', err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (status) => status !== 0 ? reject(new Error(err)) : resolve(out.trim() ? JSON.parse(out.trim().split('\n').at(-1)) : { crashed: true }));
  });
}
const auditOf = (w) => w.controller.audit(w.runId).map((entry) => [entry.action, entry.actor, entry.role]);

check('C1-A. packet A preserved, ENTER_ARCHITECTURE bound to A in the same write, a real crash before ISSUE_PACKET; the exact retry issues A', async (dir) => {
  const w = world(dir);
  const crashed = await activateInProcess(w, w.bundle(), { crashAfter: 'ENTER_ARCHITECTURE' });
  assert.deepEqual(crashed, { crashed: true });
  const run = w.controller.get(w.runId);
  assert.deepEqual([run.state, run.activationBinding, run.activePacket], ['ARCHITECTURE', intentOf(w.bundle()), undefined]);
  assert.deepEqual(auditOf(w), [['ENTER_ARCHITECTURE', ARCHITECT, 'GPT_ARCHITECT']]);
  const view = w.core.inspect(w.target());
  assert.deepEqual([view.position, view.activationBinding, view.recordClass], ['ARCHITECTURE_ENTERED', intentOf(w.bundle()), 'OPERATIONAL_RECORD']);
  // The binding and the transition were one Controller write; authority was archived before it.
  const writes = [];
  const seen = world(join(dir, 'seen'), { onWrite: (written, paths) => writes.push([written.audit.at(-1).action, written.activationBinding ?? null,
    openAuthorityArchiveReader(paths.authority).listVersions('IMPLEMENTATION_PACKET', 'packet-1').length]) });
  seen.core.activate(seen.target(), seen.bundle());
  assert.deepEqual(writes, [['ENTER_ARCHITECTURE', intentOf(seen.bundle()), 1], ['ISSUE_PACKET', intentOf(seen.bundle()), 1]]);
  const result = w.core.activate(w.target(), w.bundle());
  assert.deepEqual([result.status, result.preState, result.state, result.packet.packetId], ['ACTIVATED', 'ARCHITECTURE', 'PACKET_READY', 'packet-1']);
  assert.deepEqual(auditOf(w), [['ENTER_ARCHITECTURE', ARCHITECT, 'GPT_ARCHITECT'], ['ISSUE_PACKET', ARCHITECT, 'GPT_ARCHITECT']]);
  assert.deepEqual(w.controller.get(w.runId).activationBinding, intentOf(w.bundle()), 'the binding is retained unchanged');
  assert.deepEqual([versions(w, 'IMPLEMENTATION_PACKET', 'packet-1'), versions(w, 'AUTHORIZATION', 'auth-implementation')], [1, 1]);
});
check('C1-B. after A entered and crashed, an activation with packet B is ACTIVATION_CONFLICT: nothing written, still ARCHITECTURE, B never active', (dir) => {
  const w = enteredWorld(dir);
  refusedUntouched(w, () => w.core.activate(w.target(), bundleN(w, 2)), 'ACTIVATION_CONFLICT');
  const run = w.controller.get(w.runId);
  assert.deepEqual([run.state, run.activePacket, run.activationBinding], ['ARCHITECTURE', undefined, intentOf(w.bundle())]);
  assert.equal(versions(w, 'IMPLEMENTATION_PACKET', 'packet-2'), 0, 'packet B was archived');
  // B through a fresh process's core as well; then A's exact retry still completes with A.
  refusedUntouched(w, () => coreOver(w).core.activate(w.target(), bundleN(w, 2)), 'ACTIVATION_CONFLICT');
  assert.equal(w.core.activate(w.target(), w.bundle()).packet.packetId, 'packet-1');
  refusedUntouched(w, () => w.core.activate(w.target(), bundleN(w, 2)), 'ACTIVATION_CONFLICT');
});
check('C1-C. the same packetId with another body during ARCHITECTURE recovery is ACTIVATION_CONFLICT with no write', (dir) => {
  const w = enteredWorld(dir);
  for (const overrides of [{ objective: 'Same id, other body' }, { packetVersion: 2 }]) {
    refusedUntouched(w, () => w.core.activate(w.target(), w.bundle({ packetOverrides: overrides })), 'ACTIVATION_CONFLICT');
  }
  // Same body, but not the archived document (a later version standing in for the bound one).
  const v1 = w.archive().listVersions('IMPLEMENTATION_PACKET', 'packet-1')[0];
  refusedUntouched(w, () => w.core.activate(w.target(), w.bundle({ packetDocument: w.doc('IMPLEMENTATION_PACKET', w.packet(), { version: 2, supersedes: v1 }) })),
    'ACTIVATION_CONFLICT');
  assert.equal(w.controller.get(w.runId).state, 'ARCHITECTURE');
  assert.equal(w.core.activate(w.target(), w.bundle()).status, 'ACTIVATED');
});
check('C1-D. an ARCHITECTURE entered by any other path is never adopted: ACTIVATION_ALREADY_ADVANCED, no packet issued', (dir) => {
  // Generic Controller.enterArchitecture by the configured Architect, before and after the documents were archived.
  const w = world(dir);
  w.controller.enterArchitecture(w.runId, ARCH);
  refusedUntouched(w, () => w.core.activate(w.target(), w.bundle()), 'ACTIVATION_ALREADY_ADVANCED');
  assert.equal(w.core.inspect(w.target()).position, 'ADVANCED');
  let crash = true;
  const d = world(join(dir, 'd'), { onWrite: () => { if (crash) throw new Error('crash during controller write'); } });
  refused(() => d.core.activate(d.target(), d.bundle()), 'ACTIVATION_INCOMPLETE');
  crash = false;
  d.controller.enterArchitecture(d.runId, ARCH);
  refusedUntouched(d, () => d.core.activate(d.target(), d.bundle()), 'ACTIVATION_ALREADY_ADVANCED');
  // A generic entry landing between the activation's IDLE read and its own entry: the bound entry fails and nothing is issued.
  const r = world(join(dir, 'race'));
  const other = coreOver(r);
  let once = true;
  const racing = coreOver(r, () => { if (once) { once = false; other.controller.enterArchitecture(r.runId, ARCH); } });
  refused(() => racing.core.activate(r.target(), r.bundle()), 'ACTIVATION_ALREADY_ADVANCED');
  // A generic or direct-store entry, a stop and return, or a generic packet: none carries an activation binding.
  for (const world_ of [w, d, r]) {
    const run = world_.controller.get(world_.runId);
    assert.deepEqual([run.state, run.activePacket, Object.hasOwn(run, 'activationBinding')], ['ARCHITECTURE', undefined, false]);
  }
  const s = world(join(dir, 'store'));
  const fresh = s.controller.get(s.runId);
  const entry = { sequence: 1, runId: s.runId, sliceId: s.sliceId, actor: ARCHITECT, role: 'GPT_ARCHITECT', action: 'ENTER_ARCHITECTURE',
    timestamp: T, previousState: 'IDLE', nextState: 'ARCHITECTURE', repository: REPO };
  const direct = new FileControllerStore(s.paths.controller, clock);
  assert.throws(() => direct.replace({ ...fresh, state: 'ARCHITECTURE', audit: [entry], activationBinding: intentOf(s.bundle()) }), /Controller writer required/);
  assert.equal(s.controller.get(s.runId).state, 'IDLE', 'a direct store write forged a bound entry');
  direct.replace({ ...fresh, state: 'ARCHITECTURE', audit: [entry] });
  refusedUntouched(s, () => s.core.activate(s.target(), s.bundle()), 'ACTIVATION_ALREADY_ADVANCED');
  // Generic PACKET_READY of the very same packet, its documents archived, is not an activation either.
  for (const document_ of [s.bundle().implementationPacket, ...s.bundle().liveCallAuthorizations]) s.realPreserver.preserve(document_);
  s.controller.issuePacket(s.runId, ARCH, s.packet());
  refusedUntouched(s, () => s.core.activate(s.target(), s.bundle()), 'ACTIVATION_ALREADY_ADVANCED');
  assert.equal(s.controller.audit(s.runId).length, 2);
});
check('C1-E. an entry or packet issue by another GPT_ARCHITECT principal is never adopted', (dir) => {
  const w = world(dir);
  w.controller.enterArchitecture(w.runId, OTHER_ARCH);
  refusedUntouched(w, () => w.core.activate(w.target(), w.bundle()), 'ACTIVATION_ALREADY_ADVANCED');
  // The exact binding, the documents archived first, but the entry written under another principal.
  const o = world(join(dir, 'other'));
  for (const document_ of [o.bundle().implementationPacket, ...o.bundle().liveCallAuthorizations]) o.realPreserver.preserve(document_);
  o.controller.enterArchitectureForActivation(o.runId, OTHER_ARCH, intentOf(o.bundle()));
  refusedUntouched(o, () => o.core.activate(o.target(), o.bundle()), 'ACTIVATION_ALREADY_ADVANCED');
  // The activation's own entry, then ISSUE_PACKET of the bound packet by another principal.
  const i = enteredWorld(join(dir, 'issued'));
  i.controller.issuePacket(i.runId, OTHER_ARCH, i.packet());
  refusedUntouched(i, () => i.core.activate(i.target(), i.bundle()), 'ACTIVATION_ALREADY_ADVANCED');
  // A core configured with another principal does not adopt this Architect's activation either.
  const c = enteredWorld(join(dir, 'core'));
  refusedUntouched(c, () => coreOver(c, () => {}, OTHER_ARCH.id).core.activate(c.target(), c.bundle()), 'ACTIVATION_ALREADY_ADVANCED');
  assert.equal(c.controller.get(c.runId).state, 'ARCHITECTURE');
});
check('C1-F. concurrent activations with different packets: one binds IDLE → ARCHITECTURE; the loser neither replaces nor completes', async (dir) => {
  // Deterministic interleavings. A wins the entry while B has already read IDLE.
  const w = world(dir);
  let once = true;
  const b = coreOver(w, () => { if (once) { once = false; assert.equal(w.core.activate(w.target(), w.bundle()).status, 'ACTIVATED'); } });
  refused(() => b.core.activate(w.target(), bundleN(w, 2)), 'ACTIVATION_CONFLICT');
  const run = w.controller.get(w.runId);
  assert.deepEqual([run.state, run.activePacket.packetId, run.activationBinding], ['PACKET_READY', 'packet-1', intentOf(w.bundle())]);
  assert.deepEqual(auditOf(w).map(([action]) => action), ['ENTER_ARCHITECTURE', 'ISSUE_PACKET']);
  // B's documents were archived (authority may be ahead of the Controller) but nothing uses them.
  assert.equal(runOf(w).authority.some((reference) => reference.authorityId === 'packet-2'), false);
  // A enters and crashes; B, which read IDLE, cannot complete with its packet; A's retry completes A.
  const x = world(join(dir, 'crashed'));
  let first = true, writes = 0;
  const a = coreOver(x, () => { writes += 1; if (writes === 2) throw new Error('crash during controller write'); });
  const loser = coreOver(x, () => { if (first) { first = false; refused(() => a.core.activate(x.target(), x.bundle()), 'ACTIVATION_INCOMPLETE'); } });
  refused(() => loser.core.activate(x.target(), bundleN(x, 2)), 'ACTIVATION_CONFLICT');
  assert.deepEqual([x.controller.get(x.runId).state, x.controller.get(x.runId).activationBinding], ['ARCHITECTURE', intentOf(x.bundle())]);
  // The Controller itself refuses B under A's entry, guarded or not.
  const entered = x.controller.audit(x.runId)[0];
  const guard = { runId: x.runId, sequence: entered.sequence, action: entered.action, timestamp: entered.timestamp };
  assert.throws(() => x.controller.issuePacketForOccurrence(x.runId, ARCH, guard, x.packet({ packetId: 'packet-2' })), /not the activation/);
  assert.throws(() => x.controller.issuePacket(x.runId, ARCH, x.packet({ packetId: 'packet-2' })), /not the activation/);
  assert.throws(() => x.controller.issuePacket(x.runId, ARCH, x.packet({ objective: 'Same id, other body' })), /not the activation/);
  assert.equal(x.core.activate(x.target(), x.bundle()).status, 'ACTIVATED');
  // Real processes started together, each with its own packet.
  const outcomes = [];
  for (let round = 0; round < 3; round++) {
    const r = world(join(dir, `race-${round}`));
    const bundles = [1, 2, 3, 4].map((n) => bundleN(r, n));
    const goAt = Date.now() + 2000;
    const results = await Promise.all(bundles.map((bundle) => activateInProcess(r, bundle, { goAt })));
    outcomes.push(...results.map((result) => result.outcome));
    const final = r.controller.get(r.runId);
    assert.equal(final.state, 'PACKET_READY', JSON.stringify(results));
    assert.deepEqual(auditOf(r), [['ENTER_ARCHITECTURE', ARCHITECT, 'GPT_ARCHITECT'], ['ISSUE_PACKET', ARCHITECT, 'GPT_ARCHITECT']]);
    const winner = Number(final.activePacket.packetId.slice('packet-'.length));
    assert.deepEqual(final.activationBinding, intentOf(bundles[winner - 1]));
    results.forEach((result, index) => {
      const allowed = index === winner - 1 ? ['ACTIVATED', 'ACTIVATION_INCOMPLETE'] : ['ACTIVATION_CONFLICT', 'ACTIVATION_INCOMPLETE', 'ACTIVATION_READ_MODEL_CONFLICT'];
      assert.ok(allowed.includes(result.outcome), JSON.stringify(results));
    });
    assert.equal(r.core.activate(r.target(), bundles[winner - 1]).status, 'ALREADY_ACTIVATED');
    for (const [index, bundle] of bundles.entries()) {
      if (index !== winner - 1) refusedUntouched(r, () => r.core.activate(r.target(), bundle), 'ACTIVATION_CONFLICT');
    }
  }
  assert.ok(outcomes.filter((outcome) => outcome === 'ACTIVATED').length === 3, JSON.stringify(outcomes));
});
check('C1-G. concurrent exact activations of one packet converge: one entry, one issue, one active packet', async (dir) => {
  // P1 completes while P2, having read IDLE, is about to enter: P2 converges on P1's result.
  const w = world(dir);
  let once = true;
  const p2 = coreOver(w, () => { if (once) { once = false; w.core.activate(w.target(), w.bundle()); } });
  assert.equal(p2.core.activate(w.target(), w.bundle()).status, 'ACTIVATED');
  assert.deepEqual(auditOf(w).map(([action]) => action), ['ENTER_ARCHITECTURE', 'ISSUE_PACKET']);
  // P1 enters and crashes; P2's own entry loses to it, and P2 completes P1's exact intent instead of entering again.
  const x = world(join(dir, 'joined'));
  let first = true, writes = 0;
  const p1 = coreOver(x, () => { writes += 1; if (writes === 2) throw new Error('crash during controller write'); });
  const q2 = coreOver(x, () => { if (first) { first = false; refused(() => p1.core.activate(x.target(), x.bundle()), 'ACTIVATION_INCOMPLETE'); } });
  assert.equal(q2.core.activate(x.target(), x.bundle()).status, 'ACTIVATED');
  assert.deepEqual(auditOf(x).map(([action]) => action), ['ENTER_ARCHITECTURE', 'ISSUE_PACKET']);
  // Both resume the same interrupted activation; the second issue loses to the first and changes nothing.
  const y = enteredWorld(join(dir, 'both-resume'));
  let before = true;
  const r2 = coreOver(y, () => { if (before) { before = false; assert.equal(y.core.activate(y.target(), y.bundle()).status, 'ACTIVATED'); } });
  assert.equal(r2.core.activate(y.target(), y.bundle()).status, 'ACTIVATED');
  assert.deepEqual(auditOf(y).map(([action]) => action), ['ENTER_ARCHITECTURE', 'ISSUE_PACKET']);
  // Real processes started together with the same packet.
  for (let round = 0; round < 3; round++) {
    const r = world(join(dir, `race-${round}`));
    const goAt = Date.now() + 2000;
    const results = await Promise.all([0, 1, 2, 3].map(() => activateInProcess(r, r.bundle(), { goAt })));
    for (const result of results) {
      assert.ok(['ACTIVATED', 'ALREADY_ACTIVATED', 'ACTIVATION_INCOMPLETE', 'ACTIVATION_READ_MODEL_CONFLICT'].includes(result.outcome), JSON.stringify(results));
    }
    assert.ok(results.some((result) => result.outcome === 'ACTIVATED'), JSON.stringify(results));
    assert.deepEqual(auditOf(r), [['ENTER_ARCHITECTURE', ARCHITECT, 'GPT_ARCHITECT'], ['ISSUE_PACKET', ARCHITECT, 'GPT_ARCHITECT']]);
    assert.equal(r.controller.get(r.runId).activePacket.packetId, 'packet-1');
    assert.deepEqual([versions(r, 'IMPLEMENTATION_PACKET', 'packet-1'), versions(r, 'AUTHORIZATION', 'auth-implementation'),
      versions(r, 'AUTHORIZATION', 'auth-architect-review')], [1, 1, 1]);
    assert.equal(r.core.activate(r.target(), r.bundle()).status, 'ALREADY_ACTIVATED');
  }
});
check('C1-H. a real crash right after ISSUE_PACKET: the exact retry is ALREADY_ACTIVATED; another packet is still ACTIVATION_CONFLICT', async (dir) => {
  const w = world(dir);
  assert.deepEqual(await activateInProcess(w, w.bundle(), { crashAfter: 'ISSUE_PACKET' }), { crashed: true });
  assert.equal(w.controller.get(w.runId).state, 'PACKET_READY');
  const result = w.core.activate(w.target(), w.bundle());
  assert.deepEqual([result.status, result.preState, result.packet.packetId], ['ALREADY_ACTIVATED', 'PACKET_READY', 'packet-1']);
  assert.equal(w.controller.audit(w.runId).length, 2);
  refusedUntouched(w, () => w.core.activate(w.target(), bundleN(w, 2)), 'ACTIVATION_CONFLICT');
  refusedUntouched(w, () => w.core.activate(w.target(), w.bundle({ packetOverrides: { objective: 'Same id, other body' } })), 'ACTIVATION_CONFLICT');
});
check('C1-I. the activation binding is an OPERATIONAL_RECORD: never an R4P document, an R4A0 authority reference or fact', (dir) => {
  const w = enteredWorld(dir);
  const archived = (model) => model.authority.map((fact) => `${fact.ref.kind}/${fact.ref.authorityId}/${fact.ref.version}`).sort();
  const expected = ['AUTHORIZATION/auth-architect-review/1', 'AUTHORIZATION/auth-implementation/1', 'IMPLEMENTATION_PACKET/packet-1/1'];
  let model = w.read();
  assert.deepEqual(runOf(w, model).authority, [], 'the bound entry became an authority reference');
  assert.deepEqual(archived(model), expected);
  // G1-RP1-C1: R4A0 projects the binding read-only as operational provenance, never as authority.
  const provenanceOnly = (projected) => {
    const { provenance, ...rest } = projected;
    assert.equal(provenance.recordClass, 'OPERATIONAL_RECORD');
    assert.equal(JSON.stringify(rest).includes('activationBinding'), false, 'R4A0 projects the binding outside provenance');
    return provenance;
  };
  assert.deepEqual(provenanceOnly(runOf(w, model)).activationBinding, intentOf(w.bundle()));
  assert.deepEqual(w.core.inspect(w.target()).recordClass, 'OPERATIONAL_RECORD');
  w.core.activate(w.target(), w.bundle());
  model = w.read();
  assert.deepEqual(archived(model), expected, 'activation archived something beyond the supplied documents');
  assert.deepEqual(runOf(w, model).authority.map((reference) => reference.locator), ['activePacket']);
  assert.ok(model.authority.every((fact) => fact.recordClass === 'DIRECT_AUTHORITY' && !JSON.stringify(fact).includes('activationBinding')));
  assert.deepEqual(provenanceOnly(runOf(w, model)).architectEntries.map((entry) => [entry.action, entry.actor]),
    [['ENTER_ARCHITECTURE', ARCHITECT], ['ISSUE_PACKET', ARCHITECT]]);
  // A binding the run's history does not support is refused on every load.
  const run = w.controller.get(w.runId);
  plantRun(w, { ...run, activationBinding: intentOf(bundleN(w, 2)) });
  assert.throws(() => w.controller.get(w.runId), /activation binding outside its architecture entry/);
  refused(() => w.core.activate(w.target(), w.bundle()), 'ACTIVATION_READ_MODEL_CONFLICT');
});
check('C1-J. generic enterArchitecture is unchanged and binds nothing; the bound entry is IDLE-only, exact and Architect-only', (dir) => {
  const c = new AutomationController(clock, new InMemoryControllerStore(clock));
  c.createRun('run-1', 'slice-1', REPO);
  const generic = c.enterArchitecture('run-1', ARCH);
  assert.deepEqual([generic.state, Object.hasOwn(generic, 'activationBinding')], ['ARCHITECTURE', false]);
  assert.deepEqual(JSON.parse(JSON.stringify(generic.audit)), [{ sequence: 1, runId: 'run-1', sliceId: 'slice-1', actor: ARCHITECT, role: 'GPT_ARCHITECT',
    action: 'ENTER_ARCHITECTURE', timestamp: T, previousState: 'IDLE', nextState: 'ARCHITECTURE', repository: REPO }]);
  assert.equal(c.issuePacket('run-1', ARCH, packetOf('slice-1', { packetId: 'any-packet' })).state, 'PACKET_READY');
  // The bound entry: exact intent, GPT_ARCHITECT, initial IDLE only; a refusal writes nothing.
  const memory = new InMemoryControllerStore(clock);
  const b = new AutomationController(clock, memory);
  b.createRun('run-2', 'slice-2', REPO);
  const intent = { packetId: 'packet-1', packetHash: packetHash(packetOf('slice-2')) };
  for (const bad of [{ packetId: 'packet-1' }, { ...intent, extra: 1 }, { ...intent, packetHash: 'x' }, { ...intent, packetId: '' }, null]) {
    assert.throws(() => b.enterArchitectureForActivation('run-2', ARCH, bad));
  }
  assert.throws(() => b.enterArchitectureForActivation('run-2', { id: 'implementer', role: 'CODEX_IMPLEMENTER' }, intent));
  assert.equal(b.get('run-2').audit.length, 0);
  const entry = { sequence: 1, runId: 'run-2', sliceId: 'slice-2', actor: ARCHITECT, role: 'GPT_ARCHITECT', action: 'ENTER_ARCHITECTURE',
    timestamp: T, previousState: 'IDLE', nextState: 'ARCHITECTURE', repository: REPO };
  assert.throws(() => memory.replace({ ...b.get('run-2'), state: 'ARCHITECTURE', audit: [entry], activationBinding: intent }), /Controller writer required/);
  const bound = b.enterArchitectureForActivation('run-2', ARCH, intent);
  assert.deepEqual([bound.state, bound.activationBinding, bound.audit.length], ['ARCHITECTURE', intent, 1]);
  assert.throws(() => b.enterArchitectureForActivation('run-2', ARCH, intent), /Illegal transition/);
  // Not from an IDLE the run returned to.
  const m = new AutomationController(clock, new InMemoryControllerStore(clock));
  m.createRun('run-3', 'slice-3', REPO);
  m.stop('run-3', { id: 'human', role: 'HUMAN' }, 'HUMAN_STOP', 'pause');
  m.resumeHuman('run-3', { id: 'human', role: 'HUMAN' }, { authorizationId: 'resume-1', actorRole: 'HUMAN', operation: 'RESUME_HUMAN_STOP',
    target: m.get('run-3').stopId, runId: 'run-3', issuedAt: EARLIER, reason: 'resume' });
  assert.equal(m.get('run-3').state, 'IDLE');
  assert.throws(() => m.enterArchitectureForActivation('run-3', ARCH, intent), /has not moved/);
  // A stop and return leaves the binding as history; it no longer constrains the next packet, and AP1 sees ADVANCED.
  const s = enteredWorld(join(dir, 'stopped'));
  s.controller.stop(s.runId, ARCH, 'ARCHITECTURE_STOP', 'rethink');
  s.controller.resumeArchitecture(s.runId, ARCH);
  refusedUntouched(s, () => s.core.activate(s.target(), s.bundle()), 'ACTIVATION_ALREADY_ADVANCED');
  const second = bundleN(s, 2);
  for (const document_ of [second.implementationPacket, ...second.liveCallAuthorizations]) s.realPreserver.preserve(document_);
  assert.equal(s.controller.issuePacket(s.runId, ARCH, second.implementationPacket.body).activationBinding.packetId, 'packet-1');
  refusedUntouched(s, () => s.core.activate(s.target(), bundleN(s, 2)), 'ACTIVATION_ALREADY_ADVANCED');
});
check('C1-K. a bound entry without the packet archived before it (Controller intent first) is never completed', (dir) => {
  const w = world(dir);
  w.controller.enterArchitectureForActivation(w.runId, ARCH, intentOf(w.bundle()));
  const error = refusedUntouched(w, () => w.core.activate(w.target(), w.bundle()), 'ACTIVATION_ALREADY_ADVANCED');
  assert.equal(error.reason, 'INTENT_WITHOUT_AUTHORITY');
  assert.equal(versions(w, 'IMPLEMENTATION_PACKET', 'packet-1'), 0);
  assert.equal(w.controller.get(w.runId).state, 'ARCHITECTURE');
});
check('C1-L. a run that moves between the recovery read and the issue is never issued into: the issue is bound to the exact entry', (dir) => {
  let writes = 0, move = false;
  const w = world(dir, { onWrite: () => { writes += 1; if (writes === 2) throw new Error('crash during controller write'); },
    preserver: (real) => ({ preserve(document_) {
      const ref = real.preserve(document_);
      if (move) { move = false; const other = coreOver(w).controller; other.stop(w.runId, ARCH, 'ARCHITECTURE_STOP', 'rethink'); other.resumeArchitecture(w.runId, ARCH); }
      return ref;
    } }) });
  refused(() => w.core.activate(w.target(), w.bundle()), 'ACTIVATION_INCOMPLETE');
  move = true;
  refused(() => w.core.activate(w.target(), w.bundle()), 'ACTIVATION_ALREADY_ADVANCED');
  assert.deepEqual(w.controller.audit(w.runId).map((entry) => entry.action), ['ENTER_ARCHITECTURE', 'STOP', 'RETURN_TO_ARCHITECTURE']);
  assert.equal(w.controller.get(w.runId).activePacket, undefined);
});

// G1-RP1-C1 O1: an activation retry cannot rewrite a Human grant.
check('G1-RP1-C1 O1. an activation retry with a rewritten grant body is AUTHORITY_VERSION_CONFLICT: nothing written, interrupted or completed', (dir) => {
  const rewritten = (w) => w.bundle({ grants: [w.doc('AUTHORIZATION', grantOf(IMPL, w.runId, { reason: 'a rewritten reason' })),
    w.doc('AUTHORIZATION', grantOf(REVIEW, w.runId))] });
  const entered = enteredWorld(dir);
  refusedUntouched(entered, () => entered.core.activate(entered.target(), rewritten(entered)), 'AUTHORITY_VERSION_CONFLICT');
  assert.equal(entered.controller.get(entered.runId).state, 'ARCHITECTURE');
  const done = world(join(dir, 'done'));
  done.core.activate(done.target(), done.bundle());
  refusedUntouched(done, () => done.core.activate(done.target(), rewritten(done)), 'AUTHORITY_VERSION_CONFLICT');
  assert.equal(versions(done, 'AUTHORIZATION', 'auth-implementation'), 1);
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

// G1-RP1-C1 G2: a review belongs to the Architect principal that began its occurrence.
const OTHER_ARCHITECT = 'architect:other';
const runnerAs = (w, journal, ports, principal, preserver = w.realPreserver) => new AutomationRunner(w.controller, ports.implementation,
  ports.review, { journal, clock, scopes: SCOPES, authorizations: { IMPLEMENTATION: grantOf(IMPL, w.runId), ARCHITECT_REVIEW: grantOf(REVIEW, w.runId) },
    architectAuthority: architectReviewAuthority(preserver, principal) });
const reviewRecord = (journal, w) => journal.list(w.runId).find((record) => record.identity.actorKind === 'ARCHITECT_REVIEW');
check('G1-RP1-C1 G2-a. a review X began and prepared is never dispatched by a runner configured as Y: nothing is written', async (dir) => {
  const { w, journal, ports } = await reviewWorld(dir);
  const begun = w.controller.audit(w.runId).at(-1);
  assert.deepEqual([begun.action, begun.actor, reviewRecord(journal, w).state], ['BEGIN_REMOTE_ACCEPTANCE', ARCHITECT, 'PREPARED']);
  const before = stores(w), record = JSON.stringify(reviewRecord(journal, w));
  const result = await runnerAs(w, journal, ports, OTHER_ARCHITECT).step(w.runId);
  assert.deepEqual([result.outcome, result.state], ['PROVENANCE_MISMATCH', 'ACCEPTANCE_REVIEW']);
  assert.equal(ports.calls.review, 0, 'Y dispatched X\'s review');
  assert.deepEqual(stores(w), before, 'Y wrote to the Controller, the archive or the registry');
  assert.equal(JSON.stringify(reviewRecord(journal, w)), record, 'Y settled X\'s invocation');
});
check('G1-RP1-C1 G2-b/c. X\'s stored review is never applied by Y; X\'s own restart then recovers it exactly', async (dir) => {
  let failing = true;
  const flaky = (real) => ({ preserve(document) {
    if (failing && document.kind === 'ACCEPTANCE_DECISION') throw new AuthorityPreservationError('AUTHORITY_PRESERVATION_FAILED', null);
    return real.preserve(document);
  } });
  const { w, journal, ports, runner } = await reviewWorld(dir, { preserver: flaky });
  assert.equal((await runner.step(w.runId)).outcome, 'AUTHORITY_NOT_PRESERVED');
  assert.equal(reviewRecord(journal, w).state, 'COMPLETED');
  failing = false;
  const before = stores(w);
  const refused = await runnerAs(w, journal, ports, OTHER_ARCHITECT).step(w.runId);
  assert.deepEqual([refused.outcome, refused.state], ['PROVENANCE_MISMATCH', 'ACCEPTANCE_REVIEW']);
  assert.deepEqual(stores(w), before, 'Y preserved or applied X\'s review');
  assert.equal(versions(w, 'ACCEPTANCE_DECISION', 'review-1'), 0);
  assert.equal(reviewRecord(journal, w).state, 'COMPLETED');
  // X restarts: the stored result is preserved and applied as X's, without another review call.
  const recovered = await runnerAs(w, new FileInvocationJournal(w.paths.journal, clock), ports, ARCHITECT).step(w.runId);
  assert.deepEqual([recovered.outcome, recovered.state], ['HUMAN_PROMOTION_REQUIRED', 'ACCEPTED']);
  const accepted = w.controller.audit(w.runId).at(-1);
  assert.deepEqual([accepted.action, accepted.actor], ['ACCEPT_EXACT_SHA', ARCHITECT]);
  assert.equal(w.read().authority.find((fact) => fact.ref.kind === 'ACCEPTANCE_DECISION').issuer.principalRef, ARCHITECT);
  assert.deepEqual([ports.calls.review, reviewRecord(journal, w).state], [1, 'APPLIED']);
});
check('G1-RP1-C1 G2-d. a result X applied is settled as applied by X when a runner configured as Y reads the journal later', async (dir) => {
  const { w, journal, ports } = await reviewWorld(dir);
  // X applies the review, then stops before marking the invocation APPLIED.
  const stalled = new Proxy(journal, { get(target, name) {
    if (name === 'markApplied') return () => { throw new Error('crash before APPLIED'); };
    const value = Reflect.get(target, name);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  await assert.rejects(runnerAs(w, stalled, ports, ARCHITECT).step(w.runId), /crash before APPLIED/);
  assert.deepEqual([w.controller.get(w.runId).state, reviewRecord(journal, w).state], ['ACCEPTED', 'COMPLETED']);
  const result = await runnerAs(w, journal, ports, OTHER_ARCHITECT).step(w.runId);
  assert.deepEqual([result.outcome, result.state], ['HUMAN_PROMOTION_REQUIRED', 'ACCEPTED']);
  const record = reviewRecord(journal, w);
  assert.deepEqual([record.state, record.application?.action], ['APPLIED', 'ACCEPT_EXACT_SHA'], 'a later configuration abandoned X\'s applied review');
  assert.equal(ports.calls.review, 1);
});

// ---------------------------------------------------------------- correction recovery
/** An activated run at CORRECTION_REQUIRED after an archived REJECT, with no correction issued. */
function rejected(dir, { by = ARCHITECT } = {}) {
  const w = world(dir);
  w.core.activate(w.target(), w.bundle());
  const c = w.controller, architect = { id: by, role: 'GPT_ARCHITECT' };
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

// G1-RP1-C1 G3: a correction belongs to the exact rejection it answers.
const architectActor = (id = ARCHITECT) => ({ id, role: 'GPT_ARCHITECT' });
const issues = (w) => w.controller.audit(w.runId).filter((entry) => entry.action === 'ISSUE_CORRECTION_PACKET').map((entry) => entry.actor);
/** The core over `w` with a preserver that runs `after(document)` right after each real preservation. */
const coreWith = (w, after) => openGovernedActivationCore({ controllerStoreDirectory: w.paths.controller, authorityArchiveDirectory: w.paths.authority,
  changeRegistryDirectory: w.paths.registry, controller: w.controller, architectPrincipalRef: ARCHITECT, clock,
  preserver: { preserve(document) { const ref = w.realPreserver.preserve(document); after(document); return ref; } } });
check('G1-RP1-C1 G3-a. a correction another Architect issued, or answering another Architect\'s rejection, is never adopted', (dir) => {
  const w = rejected(dir);
  const correction = correctionOf(w.controller.get(w.runId));
  w.realPreserver.preserve(w.doc('CORRECTION_PACKET', correction));
  w.controller.issueCorrection(w.runId, architectActor(OTHER_ARCHITECT), correction);
  refusedUntouched(w, () => w.core.applyCorrection(w.target(), w.doc('CORRECTION_PACKET', correction)), 'CORRECTION_CONFLICT');
  const foreign = rejected(join(dir, 'foreign'), { by: OTHER_ARCHITECT });
  const error = refusedUntouched(foreign, () => foreign.core.applyCorrection(foreign.target(),
    foreign.doc('CORRECTION_PACKET', correctionOf(foreign.controller.get(foreign.runId)))), 'CORRECTION_NOT_APPLICABLE');
  assert.equal(error.reason, 'REJECTION_NOT_GOVERNED');
  assert.deepEqual(issues(foreign), []);
});
check('G1-RP1-C1 G3-b. another writer winning between preservation and the issue is never reported as this call\'s APPLIED', (dir) => {
  // A foreign Architect wins with the same correction: not this operation.
  const w = rejected(dir);
  const correction = correctionOf(w.controller.get(w.runId));
  const racing = coreWith(w, () => w.controller.issueCorrection(w.runId, architectActor(OTHER_ARCHITECT), correction));
  refused(() => racing.applyCorrection(w.target(), w.doc('CORRECTION_PACKET', correction)), 'CORRECTION_CONFLICT');
  assert.deepEqual(issues(w), [OTHER_ARCHITECT]);
  // The same Architect wins with the same document, guarded by the same rejection: an equivalent completed operation, not APPLIED.
  const same = rejected(join(dir, 'same'));
  const fix = correctionOf(same.controller.get(same.runId));
  const rejection = same.controller.audit(same.runId).at(-1);
  const twin = coreWith(same, () => same.controller.issueCorrectionForOccurrence(same.runId, architectActor(), { runId: same.runId,
    sequence: rejection.sequence, action: rejection.action, timestamp: rejection.timestamp }, fix));
  assert.equal(twin.applyCorrection(same.target(), same.doc('CORRECTION_PACKET', fix)).status, 'ALREADY_APPLIED');
  assert.deepEqual(issues(same), [ARCHITECT]);
});
check('G1-RP1-C1 G3-c. the same correction body under another R4P record is never adopted, before or after an issue', (dir) => {
  const w = rejected(dir);
  const correction = correctionOf(w.controller.get(w.runId));
  w.realPreserver.preserve({ ...w.doc('CORRECTION_PACKET', correction), issuedAt: EARLIER });
  const error = refusedUntouched(w, () => w.core.applyCorrection(w.target(), w.doc('CORRECTION_PACKET', correction)), 'CORRECTION_CONFLICT');
  assert.equal(error.reason, 'ANOTHER_RECORD');
  const rejection = w.controller.audit(w.runId).at(-1);
  w.controller.issueCorrectionForOccurrence(w.runId, architectActor(), { runId: w.runId, sequence: rejection.sequence, action: rejection.action,
    timestamp: rejection.timestamp }, correction);
  refusedUntouched(w, () => w.core.applyCorrection(w.target(), w.doc('CORRECTION_PACKET', correction)), 'CORRECTION_CONFLICT');
  assert.equal(versions(w, 'CORRECTION_PACKET', correction.correctionPacketId), 1);
});
check('G1-RP1-C1 G3-d. an exact retry for the same rejection and the same archived document is idempotent, also after a stop and resume', (dir) => {
  const w = rejected(dir);
  const correction = correctionOf(w.controller.get(w.runId));
  const document = w.doc('CORRECTION_PACKET', correction);
  const first = w.core.applyCorrection(w.target(), document);
  assert.equal(first.status, 'APPLIED');
  const second = w.core.applyCorrection(w.target(), document);
  assert.deepEqual([second.status, second.correction.authority], ['ALREADY_APPLIED', first.correction.authority]);
  w.controller.stop(w.runId, { id: 'controller', role: 'CONTROLLER' }, 'SOFT_STOP', 'pause');
  w.controller.resumeSoft(w.runId, { id: 'controller', role: 'CONTROLLER' }, 'repaired');
  assert.equal(w.core.applyCorrection(w.target(), document).status, 'ALREADY_APPLIED');
  assert.deepEqual([issues(w), versions(w, 'CORRECTION_PACKET', correction.correctionPacketId)], [[ARCHITECT], 1]);
});
check('G1-RP1-C1 G3-e. a stale rejection occurrence is never issued into: refused before writing, or by the guarded issue', (dir) => {
  const K = { id: 'controller', role: 'CONTROLLER' };
  const w = rejected(dir);
  const correction = correctionOf(w.controller.get(w.runId));
  w.controller.stop(w.runId, K, 'SOFT_STOP', 'pause');
  w.controller.resumeSoft(w.runId, K, 'repaired');
  const error = refusedUntouched(w, () => w.core.applyCorrection(w.target(), w.doc('CORRECTION_PACKET', correction)), 'CORRECTION_NOT_APPLICABLE');
  assert.equal(error.reason, 'REJECTION_NOT_CURRENT');
  // The run leaves the rejection occurrence and returns to an identical-looking CORRECTION_REQUIRED between the
  // read and the issue: the Controller refuses the issue guarded by the original rejection.
  const moved = rejected(join(dir, 'moved'));
  const fix = correctionOf(moved.controller.get(moved.runId));
  const core = coreWith(moved, () => {
    moved.controller.stop(moved.runId, K, 'SOFT_STOP', 'moved');
    moved.controller.resumeSoft(moved.runId, K, 'back');
  });
  refused(() => core.applyCorrection(moved.target(), moved.doc('CORRECTION_PACKET', fix)), 'ACTIVATION_INCOMPLETE');
  assert.deepEqual([issues(moved), moved.controller.get(moved.runId).state], [[], 'CORRECTION_REQUIRED']);
  // Authority may be ahead of the Controller, never behind it.
  assert.equal(versions(moved, 'CORRECTION_PACKET', fix.correctionPacketId), 1);
});

// G1-RP1-C1 G4: one SHA rejected twice, end to end.
check('G1-RP1-C1 G4. rejection 1\'s correction never satisfies rejection 2 of the same SHA: Controller, R4A0, runner, LD1 and recovery agree', async (dir) => {
  const w = rejected(dir);
  const c = w.controller, architect = architectActor();
  const first = correctionOf(c.get(w.runId));
  assert.equal(w.core.applyCorrection(w.target(), w.doc('CORRECTION_PACKET', first)).status, 'APPLIED');
  c.beginImplementation(w.runId, X);
  c.completeImplementation(w.runId, X, ['npm test: exit 0']);
  c.recordRemoteSha(w.runId, X); // the work branch still shows the rejected SHA
  c.beginAcceptanceReview(w.runId, architect);
  const second = decisionOf(c.get(w.runId), 'REJECT', 'review-2');
  w.realPreserver.preserve(w.doc('ACCEPTANCE_DECISION', second));
  c.decideAcceptance(w.runId, architect, second);
  assert.deepEqual([c.get(w.runId).remoteSha.sha, c.get(w.runId).correctionPacket.correctionPacketId], [B, first.correctionPacketId]);
  const moves = () => w.read().changes[0].nextAction.moves.map((move) => move.action);
  assert.deepEqual(moves(), ['ISSUE_CORRECTION_PACKET'], 'R4A0 treats the earlier correction as current');
  const journal = new FileInvocationJournal(w.paths.journal, clock);
  const ports = modelPorts(() => journal);
  const runner = runnerAs(w, journal, ports, ARCHITECT);
  assert.deepEqual(Object.values(await runner.step(w.runId)).slice(1, 3), ['AWAITING_CORRECTION', 'CORRECTION_REQUIRED']);
  const driver = openGovernedExecutionDriver({ controllerStoreDirectory: w.paths.controller, authorityArchiveDirectory: w.paths.authority,
    changeRegistryDirectory: w.paths.registry, runner, scopes: SCOPES, clock, architectPrincipalRef: ARCHITECT,
    liveCallAuthorizations: { IMPLEMENTATION: grantOf(IMPL, w.runId), ARCHITECT_REVIEW: grantOf(REVIEW, w.runId) } });
  assert.deepEqual([driver.inspect(w.target()).readiness, driver.inspect(w.target()).reason], ['WAITING_EXTERNAL_ACTOR', 'NOT_A_RUNNER_MOVE']);
  refusedUntouched(w, () => w.core.applyCorrection(w.target(), w.doc('CORRECTION_PACKET', first)), 'PACKET_BINDING_MISMATCH');
  assert.throws(() => c.beginImplementation(w.runId, X), /exact correction packet/);
  assert.equal(ports.calls.implementation, 0);
  // Rejection 2's own correction: applied, then the next iteration is the runner's.
  const own = correctionOf(c.get(w.runId));
  assert.equal(own.correctionIteration, 3);
  assert.equal(w.core.applyCorrection(w.target(), w.doc('CORRECTION_PACKET', own)).status, 'APPLIED');
  assert.deepEqual(moves(), ['BEGIN_IMPLEMENTATION']);
  assert.equal(driver.inspect(w.target()).readiness, 'READY');
  assert.equal((await driver.step(w.target())).postState, 'IMPLEMENTING');
  assert.deepEqual([c.get(w.runId).implementationIterations, c.get(w.runId).correctionPacket.correctionPacketId], [3, own.correctionPacketId]);
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
  // EXE-C1: a configured Trusted Workspace Host is the sole composition caller.
  assert.deepEqual(users(/createGovernedLiveAutomation\(/, [LIVE]), ['src/intake/workspace-host.ts']);
  const host = code(join(ROOT, 'src/intake/workspace-host.ts'));
  assert.match(host, /if \(!config\.executionStep\) return compose\(/);
  for (const file of [CORE, SINK, LIVE]) {
    assert.doesNotMatch(code(join(ROOT, file)), /createRun|openRootRunAdmitter|openChangeMinter|\.mint\(|openAuthorityArchive(Reader|Appender)|file-archive/, file);
  }
  // The core takes only the transitions activation and correction need.
  assert.doesNotMatch(code(join(ROOT, CORE)), /beginImplementation|completeImplementation|recordRemoteSha|beginAcceptanceReview|decideAcceptance|requestPromotion|beginPromotion|recordPromotedMain|resume|\.close\(|\.stop\(|failClosed|reconcile|runner|AutomationRunner|\.step\(|invocation-journal/);
  // G1-AP1-C1: only the bound entry and the occurrence-guarded issue; never the generic transitions.
  assert.match(code(join(ROOT, CORE)), /controller\.enterArchitectureForActivation\(/);
  assert.match(code(join(ROOT, CORE)), /controller\.issuePacketForOccurrence\(/);
  assert.doesNotMatch(code(join(ROOT, CORE)), /controller\.enterArchitecture\(|controller\.issuePacket\(/);
  // G1-RP1-C1: the correction is issued only guarded by the rejection occurrence it answers.
  assert.match(code(join(ROOT, CORE)), /controller\.issueCorrectionForOccurrence\(/);
  assert.doesNotMatch(code(join(ROOT, CORE)), /controller\.issueCorrection\(/);
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
  // EXE-C2: the sole activation route is Goal-scoped and the trusted Host alone
  // selects complete authority; the Workspace cannot import the core or archive.
  assert.deepEqual(SRC.filter((path) => /['"`]\/[^'"`\s]*\/(activate|packet|authority|execute|step)['"`]/.test(text(path))).map(rel), []);
  const ui = readdirSync(join(ROOT, 'workspace-ui')).filter((name) => /\.(js|html)$/.test(name)).map((name) => readFileSync(join(ROOT, 'workspace-ui', name), 'utf8')).join('\n');
  assert.match(ui, /data-act="exec-activate"/);
  assert.doesNotMatch(ui, /\/authority\b|openDirectAuthorityPreserver|parseAuthorityDocument|liveCallAuthorizations|packetHash\(/);
  const server = text(join(ROOT, 'src/workspace/server.ts'));
  assert.match(server, /activation\.activate\(current\.projectId, rest\[3\], submittedBy\)/);
  assert.doesNotMatch(server, /openDirectAuthorityPreserver|parseAuthorityDocument|activation-core/);
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
