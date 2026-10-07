import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync,
  writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AutomationController } from './dist/automation/controller.js';
import { FileControllerStore } from './dist/automation/durable-store.js';
import { FileEgressJournal } from './dist/automation/file-egress-journal.js';
import { GovernanceStoreIsolation, GovernanceStoreIsolationError } from './dist/automation/governance-store-isolation.js';
import { NodeProcessExecutor } from './dist/automation/process-executor.js';
import { createLiveAutomation } from './dist/automation/live/composition.js';
import { SeatbeltModelProcessExecutor } from './dist/automation/live/seatbelt-model-process.js';
import {
  SANDBOX_EXEC, SeatbeltOfflineValidationExecutor, assertFixedSeatbeltTreesIsolated, assertInvocationIsolated,
} from './dist/automation/live/seatbelt-validation.js';
import * as archiveModule from './dist/automation/authority/file-archive.js';

// G1-R4T-1 governance store isolation. What each group proves:
// - ROOT IDENTITY and the invocation-policy unit checks: the path policy itself (alias-aware
//   identity, component boundaries, ownership, permissions), on every platform.
// - STATIC COMPOSITION: the real createLiveAutomation refuses before constructing anything.
//   Refusals use no injected boundary; only the "accepted" checks inject inert validation and
//   model fakes so they also compose where Seatbelt is absent (ordinary dependency injection,
//   not isolation evidence); on macOS the real boundaries compose too.
// - MODEL PROCESS / OFFLINE VALIDATION: the real Seatbelt executors with the real process
//   executor (counted); a refusal must start no process, open no egress session and resolve
//   nothing. They need macOS Seatbelt and are reported as skipped elsewhere.
// - CAPABILITY TOPOLOGY: the production source graph and exported surfaces.

const ROOT = dirname(fileURLToPath(import.meta.url));
const T = '2026-10-05T00:00:00.000Z';
const clock = { now: () => T };
const seatbelt = process.platform === 'darwin' && existsSync(SANDBOX_EXEC) &&
  spawnSync(SANDBOX_EXEC, ['-p', '(version 1)(allow default)', '/usr/bin/true']).status === 0;
const tests = [];
const check = (name, fn, { requires } = {}) => tests.push([name, fn, requires]);

function refused(fn, pattern = /./) {
  let caught;
  try { fn(); } catch (error) { caught = error; }
  assert.ok(caught instanceof GovernanceStoreIsolationError, `expected GOVERNANCE_STORE_ISOLATION, got ${caught?.stack ?? 'no error'}`);
  assert.equal(caught.code, 'GOVERNANCE_STORE_ISOLATION');
  assert.match(caught.message, pattern);
}
const directory = (path) => { mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700); return path; };
function roots(base) {
  return { controller: directory(join(base, 'controller')), authority: directory(join(base, 'authority')),
    registry: directory(join(base, 'registry')) };
}
const isolation = (controller, authority, registry = directory(join(dirname(authority), 'registry'))) =>
  GovernanceStoreIsolation.forLiveRoots({ controllerStoreDirectory: controller,
    authorityArchiveDirectory: authority, changeRegistryDirectory: registry });

// ---------------------------------------------------------------- root identity
check('1. disjoint controller and authority roots are accepted', (dir) => {
  const { controller, authority } = roots(dir);
  const governance = isolation(controller, authority);
  assert.deepEqual(Object.getOwnPropertyNames(GovernanceStoreIsolation.prototype).sort(), ['assertDisjoint', 'assertNotRoot', 'constructor']);
  assert.ok(Object.isFrozen(governance));
  governance.assertDisjoint('elsewhere', directory(join(dir, 'elsewhere')));
});
check('2. the same root for both is refused', (dir) => {
  const { controller } = roots(dir);
  refused(() => isolation(controller, controller), /overlap/);
});
check('3-4. a root containing the other is refused, either way', (dir) => {
  const outer = directory(join(dir, 'outer')), inner = directory(join(outer, 'inner'));
  refused(() => isolation(outer, inner), /overlap/);
  refused(() => isolation(inner, outer), /overlap/);
});
check('5. a root reached through a symlinked ancestor is the same root', (dir) => {
  const real = directory(join(dir, 'real')), store = directory(join(real, 'store'));
  symlinkSync(real, join(dir, 'alias'));
  refused(() => isolation(store, join(dir, 'alias', 'store')), /overlap/);
  refused(() => isolation(real, join(dir, 'alias', 'store')), /overlap/);
});
check('6-8. a symlink, a regular file or an absent path is not a protected root', (dir) => {
  const { authority } = roots(dir);
  const target = directory(join(dir, 'target'));
  symlinkSync(target, join(dir, 'link'));
  refused(() => isolation(join(dir, 'link'), authority), /symlink/);
  writeFileSync(join(dir, 'file'), 'x');
  refused(() => isolation(join(dir, 'file'), authority), /not a directory/);
  refused(() => isolation(join(dir, 'absent'), authority), /does not exist/);
  assert.equal(existsSync(join(dir, 'absent')), false, 'an absent root was provisioned');
  for (const bad of ['relative', `${authority}/`, `${dir}/x/../controller`, `${dir}//controller`, '']) refused(() => isolation(bad, authority));
});
check('9. a group- or world-writable root is refused and never chmodded', (dir) => {
  const { controller, authority } = roots(dir);
  for (const mode of [0o770, 0o707, 0o777]) {
    chmodSync(controller, mode);
    refused(() => isolation(controller, authority), /writable by group or others/);
    assert.equal(statSync(controller).mode & 0o777, mode, 'the root was repaired');
  }
}, { requires: process.platform !== 'win32' ? undefined : 'POSIX permission bits' });
check('10. a root owned by another account is refused', (dir) => {
  const { authority } = roots(dir);
  refused(() => isolation('/usr', authority), /not owned by the host account/);
}, { requires: typeof process.getuid === 'function' && process.getuid() !== 0 ? undefined : 'a non-root POSIX account' });
check('a root swapped after composition fails closed at the next check', (dir) => {
  const { controller, authority } = roots(dir);
  const governance = isolation(controller, authority);
  renameSync(controller, join(dir, 'moved-away'));
  directory(controller);
  refused(() => governance.assertDisjoint('elsewhere', directory(join(dir, 'elsewhere'))), /changed after composition/);
  const second = roots(join(dir, 'second')), later = isolation(second.controller, second.authority);
  renameSync(second.authority, join(dir, 'authority-moved'));
  refused(() => later.assertDisjoint('elsewhere', join(dir, 'elsewhere')), /AUTHORITY_ARCHIVE root does not exist/);
});
check('CM1. registry root is required, real, safe, and disjoint from both existing roots', (dir) => {
  const { controller, authority, registry } = roots(dir);
  refused(() => GovernanceStoreIsolation.forLiveRoots({ controllerStoreDirectory: controller,
    authorityArchiveDirectory: authority }), /CHANGE_REGISTRY is not an absolute/);
  refused(() => isolation(controller, authority, controller), /overlap/);
  refused(() => isolation(controller, authority, authority), /overlap/);
  refused(() => isolation(controller, authority, join(controller, 'registry')), /does not exist/);
  const alias = join(dir, 'registry-alias'); symlinkSync(registry, alias);
  refused(() => isolation(controller, authority, alias), /symlink/);
  chmodSync(registry, 0o777);
  refused(() => isolation(controller, authority, registry), /writable by group or others/);
  chmodSync(registry, 0o700);
  const governance = isolation(controller, authority, registry);
  refused(() => governance.assertDisjoint('model workspace', registry), /CHANGE_REGISTRY/);
  refused(() => governance.assertNotRoot('fixed literal', registry), /CHANGE_REGISTRY/);
  renameSync(registry, join(dir, 'moved-registry'));
  directory(registry);
  refused(() => governance.assertDisjoint('elsewhere', join(dir, 'elsewhere')), /CHANGE_REGISTRY root changed/);
});
check('GC1. a registry-only bridge guard is not a full model/validation isolation capability', (dir) => {
  const { registry } = roots(dir);
  const guard = GovernanceStoreIsolation.forGoalChangeBridge(registry);
  assert.equal(guard instanceof GovernanceStoreIsolation, false);
  assert.deepEqual(Object.keys(guard), ['assertDisjoint']);
  refused(() => guard.assertDisjoint('Goal Store', registry), /CHANGE_REGISTRY/);
  assert.match(readFileSync(join(ROOT, 'src/automation/live/seatbelt-model-process.ts'), 'utf8'),
    /governance instanceof GovernanceStoreIsolation/);
  assert.match(readFileSync(join(ROOT, 'src/automation/live/seatbelt-validation.ts'), 'utf8'),
    /governance instanceof GovernanceStoreIsolation/);
});
check('GC1. real model and validation boundaries reject a registry-only guard before any process', (dir) => {
  const governance = GovernanceStoreIsolation.forGoalChangeBridge(roots(dir).registry);
  let calls = 0;
  const executor = { run() { calls++; throw new Error('must not run'); } };
  const settings = { runtimeReadPaths: [], searchPath: '/usr/bin' };
  assert.throws(() => new SeatbeltModelProcessExecutor(settings, { governance, executor,
    egressJournal: { open() { calls++; } }, resolver: { resolve() { calls++; } } }), /requires the protected governance roots/);
  assert.throws(() => new SeatbeltOfflineValidationExecutor(settings, { governance, executor }), /requires the protected governance roots/);
  assert.equal(calls, 0);
}, { requires: seatbelt ? undefined : 'macOS Seatbelt' });

// ---------------------------------------------------------------- static composition (the real createLiveAutomation)
const PINS = realpathSync(mkdtempSync(join(tmpdir(), 'chief-r4t-pins-')));
process.on('exit', () => rmSync(PINS, { recursive: true, force: true }));
const pinned = (name) => {
  const path = join(PINS, name);
  writeFileSync(path, `SYNTHETIC-${name.toUpperCase()}-BINARY\n`, { mode: 0o755 });
  return { executable: path, executableSha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
};
const CLAUDE = { ...pinned('claude'), provider: 'anthropic', model: 'claude-opus-5-5', egressDestinations: ['api.anthropic.com:443'],
  timeoutMs: 600_000, maxTurns: 40, maxStdoutBytes: 1_000_000, maxStderrBytes: 1_000_000 };
const CODEX = { ...pinned('codex'), provider: 'openai', model: 'gpt-5.5-codex', egressDestinations: ['chatgpt.com:443'], timeoutMs: 600_000,
  maxStdoutBytes: 1_000_000, maxStderrBytes: 1_000_000, maxResultBytes: 100_000, disabledFeatures: [] };
function liveConfig(dir, change = (config) => config) {
  for (const path of ['repo', 'worktrees', 'deps']) directory(join(dir, path));
  const { controller, authority, registry } = roots(join(dir, 'governance'));
  return change({ repository: 'synthetic/example', controllerStoreDirectory: controller, authorityArchiveDirectory: authority,
    changeRegistryDirectory: registry,
    journalDirectory: join(dir, 'journal'), egressJournalDirectory: join(dir, 'egress'), environment: { allow: ['PATH'] }, claude: CLAUDE, codex: CODEX,
    git: { executable: 'git', remote: 'origin', repositoryPath: join(dir, 'repo'), worktreeRoot: join(dir, 'worktrees'), timeoutMs: 60_000,
      maxOutputBytes: 1_000_000, commitAuthor: { name: 'CHIEF automation', email: 'automation@example.invalid' }, validationTimeoutMs: 60_000,
      validationMaxOutputBytes: 1_000_000, linkedDirectories: [{ path: 'node_modules', source: join(dir, 'deps') }] },
    offlineValidation: { runtimeReadPaths: [], searchPath: '/usr/bin:/bin' }, modelProcess: { runtimeReadPaths: [], searchPath: '/usr/bin:/bin' },
    github: { executable: 'gh', workflowName: 'CI', requiredCheckName: 'test', timeoutMs: 10_000, maxOutputBytes: 1_000_000, maxObservationAgeMs: 60_000 },
    liveCallAuthorizations: {} });
}
const counted = () => ({ processes: 0 });
function compose(config, count = counted(), inject = false) {
  const executor = { async run() { count.processes += 1; } };
  const syncExecutor = { runSync() { count.processes += 1; } };
  const fakes = inject ? { offlineValidation: { async runOffline() { count.processes += 1; } }, modelProcess: { async runModel() { count.processes += 1; } } } : {};
  return createLiveAutomation(config, { clock, environmentSource: { PATH: '/bin' }, executor, syncExecutor, ...fakes });
}
/** A composition refusal: classified, before any process, and with nothing created anywhere. */
function tree(path) {
  return typeof path === 'string' && existsSync(path) ? readdirSync(path, { recursive: true }).map(String).sort() : null;
}
function compositionRefused(dir, config, pattern) {
  const count = counted();
  const watched = [config.controllerStoreDirectory, config.authorityArchiveDirectory, config.changeRegistryDirectory,
    config.journalDirectory, config.egressJournalDirectory];
  const before = watched.map(tree);
  refused(() => compose(config, count), pattern);
  assert.equal(count.processes, 0);
  assert.deepEqual(watched.map(tree), before, 'a refused composition created or changed something');
}
const swap = (config, key, path) => ({ ...config, [key]: path });
const git = (config, change) => ({ ...config, git: { ...config.git, ...change } });
check('11. a Controller store root inside the repository is refused', (dir) => {
  const config = liveConfig(dir, (c) => swap(c, 'controllerStoreDirectory', directory(join(dir, 'repo', 'store'))));
  compositionRefused(dir, config, /git\.repositoryPath overlaps the protected CONTROLLER_STORE root/);
});
check('12. an Authority Archive root that contains the repository is refused', (dir) => {
  const config = liveConfig(dir);
  const outer = directory(join(dir, 'outer'));
  const moved = git(swap(config, 'authorityArchiveDirectory', outer), { repositoryPath: directory(join(outer, 'repo')) });
  compositionRefused(dir, moved, /git\.repositoryPath overlaps the protected AUTHORITY_ARCHIVE root/);
});
check('13. a root inside the worktree root is refused', (dir) => {
  const config = liveConfig(dir, (c) => swap(c, 'controllerStoreDirectory', directory(join(dir, 'worktrees', 'store'))));
  compositionRefused(dir, config, /git\.worktreeRoot overlaps/);
});
check('14. a linked dependency source containing a root is refused', (dir) => {
  const config = liveConfig(dir);
  compositionRefused(dir, git(config, { linkedDirectories: [{ path: 'node_modules', source: join(dir, 'governance') }] }),
    /git\.linkedDirectories\[node_modules\]\.source overlaps/);
});
check('15. a model runtime read path at a root is refused', (dir) => {
  const config = liveConfig(dir);
  compositionRefused(dir, { ...config, modelProcess: { runtimeReadPaths: [config.authorityArchiveDirectory], searchPath: '/usr/bin' } },
    /modelProcess\.runtimeReadPaths\[0\] overlaps the protected AUTHORITY_ARCHIVE root/);
  compositionRefused(dir, { ...config, modelProcess: { runtimeReadPaths: [], searchPath: `/usr/bin:${config.controllerStoreDirectory}` } },
    /modelProcess\.searchPath\[1\] overlaps/);
});
check('16. an offline validation runtime read path inside a root is refused', (dir) => {
  const config = liveConfig(dir);
  compositionRefused(dir, { ...config, offlineValidation: { runtimeReadPaths: [join(config.controllerStoreDirectory, 'toolchain')],
    searchPath: '/usr/bin' } }, /offlineValidation\.runtimeReadPaths\[0\] overlaps the protected CONTROLLER_STORE root/);
});
check('CM1. live composition protects the registry without opening a mint capability', (dir) => {
  const config = liveConfig(dir);
  const before = tree(config.changeRegistryDirectory);
  assert.throws(() => compose({ ...config, changeRegistryDirectory: undefined }), /changeRegistryDirectory/);
  assert.deepEqual(tree(config.changeRegistryDirectory), before);
  compositionRefused(dir, git(config, { repositoryPath: config.changeRegistryDirectory }), /CHANGE_REGISTRY/);
  compositionRefused(dir, { ...config, modelProcess: { runtimeReadPaths: [config.changeRegistryDirectory], searchPath: '/usr/bin' } },
    /CHANGE_REGISTRY/);
  compositionRefused(dir, { ...config, offlineValidation: { runtimeReadPaths: [config.changeRegistryDirectory], searchPath: '/usr/bin' } },
    /CHANGE_REGISTRY/);
  const live = compose(config, counted(), true);
  assert.deepEqual(Object.keys(live).sort(), ['controller', 'egressJournal', 'journal', 'reality', 'runner']);
  assert.deepEqual(readdirSync(config.changeRegistryDirectory), [], 'composition opened or minted in the registry');
});
check('17-18. operational journals may not share a governance root', (dir) => {
  const config = liveConfig(dir);
  compositionRefused(dir, swap(config, 'journalDirectory', join(config.controllerStoreDirectory, 'journal')), /journalDirectory overlaps/);
  compositionRefused(dir, swap(config, 'egressJournalDirectory', config.authorityArchiveDirectory), /egressJournalDirectory overlaps/);
});
check('19. an alias of a root among the agent-visible paths is refused', (dir) => {
  const config = liveConfig(dir);
  symlinkSync(dirname(config.controllerStoreDirectory), join(dir, 'innocent'));
  compositionRefused(dir, git(config, { worktreeRoot: join(dir, 'innocent', 'controller', 'trees') }), /git\.worktreeRoot overlaps/);
  compositionRefused(dir, { ...config, claude: { ...CLAUDE, executable: join(dir, 'innocent', 'authority', 'claude') } }, /claude\.executable overlaps/);
});
check('20. siblings that only share a name prefix are accepted', (dir) => {
  const config = liveConfig(dir);
  const prefixed = git(config, { repositoryPath: directory(`${config.controllerStoreDirectory}-old`),
    worktreeRoot: directory(`${config.authorityArchiveDirectory}.trees`) });
  const live = compose({ ...prefixed, journalDirectory: `${config.controllerStoreDirectory}2` }, counted(), true);
  assert.ok(Object.isFrozen(live));
  assert.deepEqual(readdirSync(config.authorityArchiveDirectory), [], 'the composition opened the Authority Archive');
});
check('the real composition with the real Seatbelt boundaries composes with safe roots, and opens no archive', (dir) => {
  const config = liveConfig(dir);
  const live = compose(config);
  assert.deepEqual(Object.keys(live).sort(), ['controller', 'egressJournal', 'journal', 'reality', 'runner']);
  assert.deepEqual(readdirSync(config.authorityArchiveDirectory), []);
}, { requires: seatbelt ? undefined : 'macOS Seatbelt' });

// ---------------------------------------------------------------- invocation policy (unit, every platform)
check('the per-invocation check refuses every overlapping field and passes a disjoint policy', (dir) => {
  const { controller, authority } = roots(join(dir, 'governance'));
  const governance = isolation(controller, authority);
  const work = directory(join(dir, 'work')), temp = directory(join(dir, 'tmp'));
  const safe = { policy: { readTrees: ['/usr/bin'], writeTrees: [work, temp] }, cwd: work, searchPath: '/usr/bin:/bin' };
  assertInvocationIsolated(governance, 'unit', safe);
  for (const [field, invocation] of [
    ['writable', { ...safe, policy: { ...safe.policy, writeTrees: [work, join(controller, 'x')] } }],
    ['readable', { ...safe, policy: { ...safe.policy, readTrees: [authority] } }],
    ['cwd', { ...safe, cwd: controller }],
    ['search path', { ...safe, searchPath: `/usr/bin:${authority}` }],
    ['executable', { ...safe, executable: (writeFileSync(join(authority, 'tool'), 'x'), join(authority, 'tool')) }],
  ]) refused(() => assertInvocationIsolated(governance, 'unit', invocation), new RegExp(`unit ${field}`));
  assertFixedSeatbeltTreesIsolated(governance);
  refused(() => governance.assertNotRoot('literal', controller), /is the protected CONTROLLER_STORE root/);
});

// ---------------------------------------------------------------- model process (real Seatbelt executor)
const NODE = realpathSync(process.execPath);
const NODE_SHA = createHash('sha256').update(readFileSync(NODE)).digest('hex');
function modelBoundary(dir, { runtimeReadPaths = [] } = {}) {
  const home = directory(join(dir, 'home')), work = directory(join(dir, 'work'));
  const { controller, authority } = roots(join(dir, 'governance'));
  const governance = isolation(controller, authority);
  const inner = new NodeProcessExecutor();
  const executor = { runs: 0, run(request) { this.runs += 1; return inner.run(request); } };
  const journal = new FileEgressJournal(join(dir, 'egress'), clock);
  const resolver = { calls: 0, async resolve() { this.calls += 1; return []; } };
  const model = new SeatbeltModelProcessExecutor({ runtimeReadPaths: [dirname(dirname(NODE)), ...runtimeReadPaths], searchPath: '/usr/bin:/bin' },
    { executor, egressJournal: journal, resolver, governance, home });
  const scope = { actorKind: 'IMPLEMENTATION', provider: 'fixture-provider', model: 'fixture-model-1', egressDestinations: ['allowed.test:443'] };
  const request = (overrides = {}) => ({ invocationId: randomBytes(32).toString('hex'), actorKind: 'IMPLEMENTATION', scope, executable: NODE,
    executableSha256: NODE_SHA, args: ['-e', 'process.stdout.write(process.cwd())'], cwd: work, workspace: { path: work, mode: 'READ_WRITE' },
    writablePaths: [], readOnlyPaths: [], env: { LANG: 'C' }, stdin: '', timeoutMs: 60_000, maxStdoutBytes: 100_000, maxStderrBytes: 100_000,
    ...overrides });
  /** A refusal: UNAVAILABLE and classified, with no process, no egress session and no resolution. */
  const noProcess = async (overrides, pattern) => {
    const sent = request(overrides);
    const outcome = await model.runModel(sent);
    assert.equal(outcome.isolation, 'UNAVAILABLE');
    assert.match(outcome.reason, /GOVERNANCE_STORE_ISOLATION/);
    assert.match(outcome.reason, pattern);
    assert.equal(executor.runs, 0, 'a process started');
    assert.equal(journal.get(sent.invocationId), undefined, 'an egress session was opened');
    assert.equal(resolver.calls, 0);
  };
  return { model, executor, controller, authority, work, request, noProcess };
}
const seatbeltOnly = { requires: seatbelt ? undefined : 'macOS Seatbelt' };
check('21. a model workspace inside the Controller store starts no process', async (dir) => {
  const b = modelBoundary(dir);
  const inside = directory(join(b.controller, 'work'));
  await b.noProcess({ cwd: inside, workspace: { path: inside, mode: 'READ_WRITE' } }, /model writable path overlaps the protected CONTROLLER_STORE/);
}, seatbeltOnly);
check('22. a read-only model workspace that is the Authority Archive starts no process', async (dir) => {
  const b = modelBoundary(dir);
  await b.noProcess({ cwd: b.authority, workspace: { path: b.authority, mode: 'READ_ONLY' } }, /model readable path overlaps the protected AUTHORITY_ARCHIVE/);
}, seatbeltOnly);
check('23. a read-only path at a governance root starts no process', async (dir) => {
  const b = modelBoundary(dir);
  await b.noProcess({ readOnlyPaths: [b.authority] }, /model readable path overlaps/);
}, seatbeltOnly);
check('24. a writable path inside a governance root starts no process', async (dir) => {
  const b = modelBoundary(dir);
  await b.noProcess({ writablePaths: [directory(join(b.controller, 'answers'))] }, /model writable path overlaps/);
}, seatbeltOnly);
check('25. a model runtime read path at a governance root is refused when the boundary is built', (dir) => {
  const { controller, authority } = roots(join(dir, 'governance'));
  refused(() => modelBoundary(dir, { runtimeReadPaths: [authority] }), /model runtime path overlaps the protected AUTHORITY_ARCHIVE/);
  refused(() => new SeatbeltModelProcessExecutor({ runtimeReadPaths: [], searchPath: `/usr/bin:${controller}` }, { executor: new NodeProcessExecutor(),
    egressJournal: new FileEgressJournal(join(dir, 'e'), clock), resolver: { resolve: async () => [] }, governance: isolation(controller, authority) }),
  /model runtime path overlaps/);
  assert.throws(() => new SeatbeltModelProcessExecutor({ runtimeReadPaths: [], searchPath: '/usr/bin' }, { executor: new NodeProcessExecutor(),
    egressJournal: new FileEgressJournal(join(dir, 'e'), clock), resolver: { resolve: async () => [] }, governance: { assertDisjoint() {} } }),
  /requires the protected governance roots/);
}, seatbeltOnly);
check('26. a symlink alias into a governance root starts no process', async (dir) => {
  const b = modelBoundary(dir);
  const inside = directory(join(b.controller, 'work'));
  symlinkSync(inside, join(dir, 'looks-safe'));
  await b.noProcess({ cwd: join(dir, 'looks-safe'), workspace: { path: join(dir, 'looks-safe'), mode: 'READ_WRITE' } }, /overlaps the protected CONTROLLER_STORE/);
  symlinkSync(b.authority, join(dir, 'answers-alias'));
  await b.noProcess({ writablePaths: [join(dir, 'answers-alias')] }, /overlaps the protected AUTHORITY_ARCHIVE/);
}, seatbeltOnly);
check('27. a disjoint model request keeps the existing Seatbelt behavior', async (dir) => {
  const b = modelBoundary(dir);
  const outcome = await b.model.runModel(b.request());
  assert.equal(outcome.isolation, 'ENFORCED', outcome.reason);
  assert.equal(outcome.result.exitCode, 0, JSON.stringify(outcome.result));
  assert.equal(outcome.result.stdout, realpathSync(b.work));
  assert.equal(outcome.egress.status, 'RECORDED');
  assert.equal(b.executor.runs, 2, 'the profile probe and the CLI');
}, seatbeltOnly);
check('CM1. a model process cannot read or write the Change Registry', async (dir) => {
  const b = modelBoundary(dir);
  const registry = join(dirname(b.controller), 'registry');
  await b.noProcess({ readOnlyPaths: [registry] }, /CHANGE_REGISTRY/);
  await b.noProcess({ writablePaths: [registry] }, /CHANGE_REGISTRY/);
}, seatbeltOnly);

// ---------------------------------------------------------------- offline validation (real Seatbelt executor)
function validationBoundary(dir, { runtimeReadPaths = [] } = {}) {
  const home = directory(join(dir, 'home')), work = directory(join(dir, 'work')), temp = directory(join(dir, 'tmp')), deps = directory(join(dir, 'deps'));
  const { controller, authority } = roots(join(dir, 'governance'));
  const inner = new NodeProcessExecutor();
  const executor = { runs: 0, run(request) { this.runs += 1; return inner.run(request); } };
  const validation = new SeatbeltOfflineValidationExecutor({ runtimeReadPaths, searchPath: '/usr/bin:/bin' },
    { executor, governance: isolation(controller, authority), home });
  const request = (overrides = {}) => ({ executable: '/bin/pwd', args: [], cwd: work, workspace: work, temporaryDirectory: temp, readOnlyPaths: [deps],
    env: { LANG: 'C' }, timeoutMs: 60_000, maxStdoutBytes: 100_000, maxStderrBytes: 100_000, ...overrides });
  const noProcess = async (overrides, pattern) => {
    const outcome = await validation.runOffline(request(overrides));
    assert.equal(outcome.isolation, 'UNAVAILABLE');
    assert.match(outcome.reason, /GOVERNANCE_STORE_ISOLATION/);
    assert.match(outcome.reason, pattern);
    assert.equal(executor.runs, 0, 'generated code or the profile probe ran');
  };
  return { validation, executor, controller, authority, work, request, noProcess };
}
check('28. a validation workspace inside the Controller store runs nothing', async (dir) => {
  const b = validationBoundary(dir);
  const inside = directory(join(b.controller, 'copy'));
  await b.noProcess({ cwd: inside, workspace: inside }, /validation writable path overlaps the protected CONTROLLER_STORE/);
}, seatbeltOnly);
check('29. a validation workspace that is the Authority Archive runs nothing', async (dir) => {
  const b = validationBoundary(dir);
  await b.noProcess({ cwd: b.authority, workspace: b.authority }, /overlaps the protected AUTHORITY_ARCHIVE/);
}, seatbeltOnly);
check('30. a read-only dependency at a governance root runs nothing', async (dir) => {
  const b = validationBoundary(dir);
  await b.noProcess({ readOnlyPaths: [b.controller] }, /validation readable path overlaps/);
}, seatbeltOnly);
check('31. a temporary directory inside a governance root runs nothing', async (dir) => {
  const b = validationBoundary(dir);
  await b.noProcess({ temporaryDirectory: directory(join(b.authority, 'tmp')) }, /validation writable path overlaps the protected AUTHORITY_ARCHIVE/);
}, seatbeltOnly);
check('32. a validation runtime read path or executable at a governance root is refused', async (dir) => {
  const { authority } = roots(join(dir, 'governance'));
  refused(() => validationBoundary(dir, { runtimeReadPaths: [authority] }), /validation runtime path overlaps/);
  const b = validationBoundary(join(dir, 'second'));
  writeFileSync(join(b.controller, 'generated-tool'), '#!/bin/sh\n', { mode: 0o755 });
  await b.noProcess({ executable: join(b.controller, 'generated-tool') }, /validation executable overlaps/);
}, seatbeltOnly);
check('33. a symlink alias into a governance root runs nothing', async (dir) => {
  const b = validationBoundary(dir);
  symlinkSync(b.controller, join(dir, 'deps-alias'));
  await b.noProcess({ readOnlyPaths: [join(dir, 'deps-alias')] }, /overlaps the protected CONTROLLER_STORE/);
  symlinkSync(directory(join(b.authority, 'copy')), join(dir, 'copy-alias'));
  await b.noProcess({ cwd: join(dir, 'copy-alias'), workspace: join(dir, 'copy-alias') }, /overlaps the protected AUTHORITY_ARCHIVE/);
}, seatbeltOnly);
check('34. a disjoint validation request keeps the existing behavior', async (dir) => {
  const b = validationBoundary(dir);
  const outcome = await b.validation.runOffline(b.request());
  assert.equal(outcome.isolation, 'ENFORCED', outcome.reason);
  assert.equal(outcome.result.exitCode, 0);
  assert.equal(outcome.result.stdout.trim(), realpathSync(b.work));
  assert.equal(b.executor.runs, 2, 'the profile probe and the command');
}, seatbeltOnly);
check('CM1. offline validation cannot read or write the Change Registry', async (dir) => {
  const b = validationBoundary(dir);
  const registry = join(dirname(b.controller), 'registry');
  await b.noProcess({ readOnlyPaths: [registry] }, /CHANGE_REGISTRY/);
  await b.noProcess({ workspace: registry, cwd: registry }, /CHANGE_REGISTRY/);
}, seatbeltOnly);

// ---------------------------------------------------------------- capability topology (production source graph)
function sources(directoryPath) {
  return readdirSync(directoryPath, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directoryPath, entry.name);
    return entry.isDirectory() ? sources(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
}
const SRC = sources(join(ROOT, 'src'));
const text = (path) => readFileSync(path, 'utf8');
const rel = (path) => relative(ROOT, path);
// G1-R4A0 capability delta: the governed read model alone may hold AuthorityArchiveReader.
// No production source outside the archive holds AuthorityArchiveAppender.
const GOVERNED_READ_MODEL = join('src', 'automation', 'read-model', 'governed-read-model.ts');
check('35. only the governed read model obtains the archive reader; nothing outside the archive obtains the appender', () => {
  const outside = SRC.filter((path) => !path.includes(`${join('src', 'automation', 'authority')}/`));
  const users = outside.filter((path) => /openAuthorityArchive(Appender|Reader)|authority\/file-archive(\.js)?['"]|authority\/document(\.js)?['"]/.test(text(path)));
  assert.deepEqual(users.map(rel), [GOVERNED_READ_MODEL]);
  assert.deepEqual(outside.filter((path) => /openAuthorityArchiveAppender|AuthorityArchiveAppender/.test(text(path))).map(rel), []);
  assert.match(text(join(ROOT, GOVERNED_READ_MODEL)), /import \{ openAuthorityArchiveReader \} from '\.\.\/authority\/file-archive\.js';/);
  // Nothing imports the read model yet: no Workspace, runner, controller, model process, MCP or composition holds it.
  assert.deepEqual(SRC.filter((path) => !path.includes(`${join('src', 'automation', 'read-model')}/`) &&
    /read-model\//.test(text(path))).map(rel), []);
  for (const surface of ['src/workspace', 'src/automation/live/composition.ts', 'src/automation/runner.ts', 'src/automation/controller.ts',
    'src/automation/live/claude-code-implementation.ts', 'src/automation/live/codex-architect-review.ts', 'src/automation/live/seatbelt-model-process.ts',
    'src/automation/live/model-process-isolation.ts', 'src/index.ts']) {
    assert.ok(existsSync(join(ROOT, surface)), `${surface} moved; update the topology check`);
  }
  assert.deepEqual(SRC.filter((path) => /getGovernanceWriter|getAuthorityStore|authorityService/.test(text(path))).map(rel), []);
});
check('36. Workspace source reaches no governance writer, controller, runner or model capability', () => {
  const workspace = SRC.filter((path) => path.includes(`${join('src', 'workspace')}/`));
  assert.ok(workspace.length > 0);
  const hits = workspace.filter((path) => /AutomationController|ControllerStore|FileControllerStore|AuthorityArchive|createRun|AutomationRunner|ClaudeCode|CodexArchitect|ModelProcess|GovernanceStoreIsolation|from ['"][^'"]*automation\//
    .test(text(path)));
  assert.deepEqual(hits.map(rel), []);
});
check('37. no raw Controller store getter exists', (dir) => {
  assert.deepEqual(Object.getOwnPropertyNames(AutomationController.prototype).filter((name) => /store|raw|admission/i.test(name)), []);
  assert.deepEqual(SRC.filter((path) => /\bgetStore\b|writeRawRun|writeAdmission|controller\.store\b/.test(text(path))).map(rel), []);
  const config = liveConfig(dir);
  assert.deepEqual(Object.keys(compose(config, counted(), true)).sort(), ['controller', 'egressJournal', 'journal', 'reality', 'runner']);
});
check('38. the R4P reader/appender split is unchanged', (dir) => {
  assert.deepEqual(Object.keys(archiveModule).sort(), ['openAuthorityArchiveAppender', 'openAuthorityArchiveReader']);
  assert.deepEqual(Object.keys(archiveModule.openAuthorityArchiveReader(join(dir, 'archive'))).sort(), ['get', 'latest', 'listVersions']);
  assert.deepEqual(Object.keys(archiveModule.openAuthorityArchiveAppender(join(dir, 'archive'))), ['append']);
});
check('39. R4L admission at the store boundary is unchanged', (dir) => {
  const store = new FileControllerStore(dir, clock);
  const controller = new AutomationController(clock, store);
  controller.createRun('run-1', 'slice-1', 'synthetic/example');
  assert.throws(() => controller.createRun('run-2', 'slice-1', 'synthetic/example'), (error) => error.code === 'SECOND_RUN_FOR_CHANGE');
});
check('40. no run-creation path, endpoint or tool exists outside the controller', () => {
  const callers = SRC.filter((path) => /\.createRun\(|\.create\(\s*(run|\{\s*runId)/.test(text(path)) && !path.endsWith(join('automation', 'controller.ts')));
  assert.deepEqual(callers.map(rel), []);
  assert.deepEqual(SRC.filter((path) => /['"`]\/(api\/[^'"`]*\/)?(run|start)['"`]/.test(text(path))).map(rel), []);
  assert.deepEqual(SRC.filter((path) => /createLiveAutomation\(/.test(text(path)) && !path.endsWith(join('live', 'composition.ts'))).map(rel), []);
});
check('GC1. exactly one trusted bridge path holds Change Minter; every other runtime remains excluded', () => {
  const implementation = join('src', 'automation', 'change-registry.ts');
  const bridge = join('src', 'intake', 'goal-change-bridge.ts');
  const outside = SRC.filter((path) => rel(path) !== implementation);
  assert.deepEqual(outside.filter((path) => /openChangeMinter|ChangeMinter|change-registry\.js/.test(text(path))).map(rel), [bridge]);
  assert.equal((text(join(ROOT, bridge)).match(/openChangeMinter\(/g) ?? []).length, 1);
  assert.deepEqual(SRC.filter((path) => rel(path).startsWith('src/workspace/') && /change-mint|change-registry/.test(text(path))).map(rel), []);
  assert.deepEqual(SRC.filter((path) => rel(path).startsWith('src/automation/read-model/') &&
    /change-mint|change-registry/.test(text(path))).map(rel), []);
});

let passed = 0, failed = 0, skipped = 0;
for (const [name, fn, requires] of tests) {
  if (requires) { console.log(`  SKIP ${name} (requires ${requires})`); skipped++; continue; }
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'chief-r4t-')));
  try { await fn(dir); console.log(`  PASS ${name}`); passed++; }
  catch (error) { console.error(`  FAIL ${name}: ${error.stack}`); failed++; }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
if (failed) process.exitCode = 1;
