import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fsModule, { chmodSync, closeSync, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync,
  symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { execFileSync } from 'node:child_process';
import { parseWorkspaceConfig } from './dist/workspace/config.js';
import { createGoalChangeBridge } from './dist/intake/goal-change-bridge.js';
import { createGoalRunAdmissionBridge } from './dist/intake/goal-run-admission-bridge.js';
import { openGovernedActivationCore } from './dist/automation/activation-core.js';
import { openDirectAuthorityPreserver } from './dist/automation/authority/preserver.js';
import { parseAuthorityDocument } from './dist/automation/authority/document.js';
import { readGovernedModel } from './dist/automation/read-model/governed-read-model.js';
import { AutomationController } from './dist/automation/controller.js';
import { FileControllerStore, storedRunFileName } from './dist/automation/durable-store.js';
import { FileInvocationJournal } from './dist/automation/file-invocation-journal.js';
import { openAuthorityArchiveReader } from './dist/automation/authority/file-archive.js';
import { readRecordFile } from './dist/automation/record-file.js';
import { composeLimitedWorker, limitedLedgerEvidence } from './dist/limited-worker/composition.js';
import { WorkerStore } from './dist/limited-worker/store.js';
import { MODEL, API_VERSION, REPOSITORY, SCOPE, hash, parseContract, resourceInputPolicy, packetFor } from './dist/limited-worker/contract.js';
import { tariffFromMarkdown, offlineAnthropicTransport } from './dist/limited-worker/transport.js';
import { createGovernedLimitedWorker } from './dist/automation/live/governed-execution.js';
import { activationCandidate } from './dist/limited-worker/readiness.js';
import { ACTIVATION_SET_SCHEMA, SIGNATURE_POLICY, activationSetHash, expectedActivationSet, liveEligibility, publishActivationSet,
  verifyActivationSet } from './dist/limited-worker/activation-set.js';

// AUTO-P2-A4-P0-S1: lease safety and the ACTIVATION_SET. Every authority document, model response and source here is
// OFFLINE_SYNTHETIC, in temporary directories. No key is read, no provider or account API is called, nothing is issued.
const HUMAN = { schemaVersion: 1, kind: 'HUMAN', principalRef: 'human:s1-offline-synthetic' }, ARCHITECT = 'architect:s1-offline-synthetic';
const md = `### Model IDs\n| Platform | Model ID |\n|---|---|\n| Claude API | ${MODEL} |\n### Pricing\n| Feature | Value |\n|---|---|\n| Input | $1 / MTok |\n| Output | $5 / MTok |\n### Capabilities\n| Feature | Value |\n|---|---|\n| Context window | 200K tokens |\n### Availability\n| Feature | Value |\n|---|---|\n| Status | Active (legacy) |`;
const MODEL_REPLY = { id: MODEL, type: 'model', lifecycle: 'active', max_input_tokens: 200000, max_tokens: 64000, capabilities: { thinking: { types: { disabled: { supported: true } } } } };
const REPLY = { id: 'OFFLINE_SYNTHETIC_MESSAGE', model: MODEL, stop_reason: 'end_turn', content: [{ type: 'text', text: '# OFFLINE_SYNTHETIC\n非真實 AI 成果。' }],
  usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, service_tier: 'standard' } };
const ROOT = process.cwd();
let passed = 0, failed = 0;
// S1_ONLY=<name prefix> runs only the matching tests (used by mutate.py to keep fault-injection runs short).
const ONLY = process.env.S1_ONLY;
async function test(name, fn) {
  if (ONLY && !name.startsWith(ONLY)) return;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'chief-s1-')));
  try { await fn(dir); passed++; console.log('  PASS ' + name); }
  catch (e) { failed++; console.error('  FAIL ' + name + ': ' + e.stack); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
const sub = (dir, name) => { const p = join(dir, name); mkdirSync(p, { mode: 0o700 }); return p; };
const refusedWith = (fn, code) => assert.throws(fn, (e) => e instanceof Error && e.message === code, `expected ${code}`);
const tree = (root) => readdirSync(root, { recursive: true }).map(String).sort().map((name) => {
  const path = join(root, name), st = lstatSync(path);
  return [name, st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'link' : readFileSync(path).toString('base64')];
});
const leaseFiles = (dir) => readdirSync(dir).filter((n) => n.startsWith('runtime.lock')).sort();

// ---------------------------------------------------------------- the A4 trusted-Host world (as in test-auto-p2-a1.mjs)
async function world(dir, { preserveIssued, classDelegation } = {}) {
  const directory = (name) => sub(dir, name);
  const clock = { now: () => new Date().toISOString() }, registry = directory('registry'), controllerRoot = directory('controller'), authority = directory('authority');
  const config = parseWorkspaceConfig({ schemaVersion: 1, dataDirectory: join(dir, 'goals'), humanPrincipal: { principalRef: HUMAN.principalRef },
    projects: [{ projectId: 'chief', displayName: 'OFFLINE_SYNTHETIC', repository: REPOSITORY }] }, dir);
  const roots = { config, uiDirectory: join(ROOT, 'workspace-ui'), governedRepositories: [{ projectId: 'chief', repository: REPOSITORY }],
    changeRegistryDirectory: registry, controllerStoreDirectory: controllerRoot };
  const bridge = createGoalChangeBridge(roots), admission = createGoalRunAdmissionBridge({ ...roots, store: bridge.store });
  const g = bridge.store.addGoal('chief', 'OFFLINE_SYNTHETIC：唯讀 README 文件審查', HUMAN).queue.goals.at(-1);
  const governed = await bridge.governance.govern('chief', g.goalId, HUMAN), admitted = await admission.admit('chief', g.goalId, HUMAN);
  const store = new WorkerStore(join(dir, 'results')), source = { text: '# OFFLINE_SYNTHETIC README\n', sha: 'a'.repeat(40), path: 'README.md' };
  source.bytes = Buffer.byteLength(source.text); source.hash = hash(Buffer.from(source.text));
  const c = parseContract({ schemaVersion: 1, kind: 'LIMITED_README_WORKER', repository: REPOSITORY, projectId: 'chief', goalId: g.goalId, objectiveHash: hash(g.text),
    runId: admitted.runId, implementationSha: 'b'.repeat(40), workerCodeHash: hash('OFFLINE_SYNTHETIC_CODE'), sourceSha: source.sha, sourcePath: source.path,
    sourceHash: source.hash, sourceBytes: source.bytes, agentId: 'limited-readme-worker', provider: 'anthropic', model: MODEL, apiVersion: API_VERSION,
    tools: ['READ_PINNED_README', 'WRITE_ISOLATED_REPORT'], outputKey: hash(g.goalId), storageIdentity: store.identity(), maxInputTokens: 200000,
    maxOutputTokens: 2048, maxCalls: 1, maxRetries: 0, maxCostMicroUsd: 1000000, totalCostMicroUsd: 1000000, timeoutSeconds: 300,
    quote: tariffFromMarkdown(md, clock.now()), inputPolicy: resourceInputPolicy() });
  store.create(c, clock.now());
  const packet = packetFor(c, governed.change.changeId);
  const grant = (operation, target, id) => ({ authorizationId: id, actorRole: 'HUMAN', operation, target, runId: c.runId, packetId: packet.packetId,
    scope: structuredClone(SCOPE), issuedAt: clock.now(), expiresAt: new Date(Date.now() + 1800000).toISOString(), reason: 'OFFLINE_SYNTHETIC ONLY' });
  const live = grant('LIVE_PROVIDER_MODEL_CALL', 'live-provider-model-call', 's1-synthetic-live'), limited = grant('LIMITED_README_WORKER', hash(c), 's1-synthetic-limited');
  const document = (kind, body) => ({ schemaVersion: 1, recordClass: 'DIRECT_AUTHORITY', kind, authorityId: kind === 'IMPLEMENTATION_PACKET' ? body.packetId : body.authorizationId,
    version: 1, issuedAt: body.issuedAt ?? clock.now(), issuer: { role: kind === 'IMPLEMENTATION_PACKET' ? 'GPT_ARCHITECT' : 'HUMAN',
      principalRef: kind === 'IMPLEMENTATION_PACKET' ? ARCHITECT : HUMAN.principalRef }, subject: { repository: REPOSITORY, sliceId: packet.sliceId }, supersedes: null, body });
  const bundle = { implementationPacket: document('IMPLEMENTATION_PACKET', packet), liveCallAuthorizations: [document('AUTHORIZATION', live)] };
  const limitedDocument = document('AUTHORIZATION', limited);
  let calls = 0;
  const providerIO = { price: async () => md, model: async () => structuredClone(MODEL_REPLY), send: async () => { calls++; return structuredClone(REPLY); }, now: clock.now };
  const options = { ...roots, authorityArchiveDirectory: authority, journalDirectory: join(dir, 'journal'), resultDirectory: store.directory,
    architectPrincipalRef: ARCHITECT, humanPrincipalRef: HUMAN.principalRef, implementationSha: c.implementationSha, workerCodeHash: c.workerCodeHash,
    currentImplementation: () => ({ sha: c.implementationSha, codeHash: c.workerCodeHash, clean: true }), clock, transport: offlineAnthropicTransport(providerIO),
    liveCallGrant: live, limitedGrant: limited, readSource: () => source, readGoal: () => g.text, ...(classDelegation ? { classDelegation } : {}) };
  const preserver = openDirectAuthorityPreserver(authority);
  const runtime = preserveIssued
    ? composeLimitedWorker(options, { createActivation: (controller) => openGovernedActivationCore({ ...options, controller, preserver }),
      preserveIssued: (documents) => preserveIssued(documents, preserver) })
    : createGovernedLimitedWorker(options);
  const model = () => readGovernedModel(options, clock);
  const documents = [bundle.implementationPacket, bundle.liveCallAuthorizations[0], limitedDocument];
  const setDir = join(store.directory, 'activation-sets');
  return { c, packet, store, source, g, clock, options, runtime, bundle, limitedDocument, documents, preserver, live, limited, providerIO, model, authority, setDir,
    get calls() { return calls; }, job: () => store.read().jobs[0],
    state: () => new AutomationController(clock, new FileControllerStore(controllerRoot, clock)).get(c.runId).state,
    setFiles: () => existsSync(setDir) ? readdirSync(setDir, { recursive: true }).map(String).filter((n) => n.endsWith('.json')) : [],
    setInput: () => ({ contract: c, packet, model: model(), liveGrant: live, limitedGrant: limited }) };
}
const activate = (w) => w.runtime.activateIssued(w.c, w.bundle, w.limitedDocument);
const supersede = (w, doc) => {
  const prior = w.model().authority.find((f) => f.ref.kind === doc.kind && f.ref.authorityId === doc.authorityId);
  w.preserver.preserve({ ...doc, version: 2, supersedes: prior.ref, body: doc.kind === 'IMPLEMENTATION_PACKET' ? { ...doc.body, packetVersion: 2 } : { ...doc.body, reason: 'OFFLINE_SYNTHETIC superseded' } });
};

// ---------------------------------------------------------------- M1-R1 (R-1) at the stage layer
await test('S1-M1R1 a Host-derived packet document is refused at staging without the explicit class-delegation rule, before anything is preserved', async (dir) => {
  const derivation = { rule: 'ARCHITECT_CLASS_DELEGATION_V1', derivedBy: 'CHIEF_TRUSTED_HOST', acceptanceHash: 'a'.repeat(64), classHash: 'b'.repeat(64), implementationSha: 'b'.repeat(40) };
  const derived = (w) => ({ ...w.bundle, implementationPacket: { ...w.bundle.implementationPacket, recordClass: 'CLASS_DERIVED_AUTHORITY', derivation } });
  let preserved = 0;
  const preserveIssued = (documents, preserver) => { preserved += documents.length; for (const d of documents) preserver.preserve(d); };
  const plain = await world(sub(dir, 'plain'), { preserveIssued });
  refusedWith(() => plain.runtime.activateIssued(plain.c, derived(plain), plain.limitedDocument), 'ACTIVATION_PACKET_DERIVED_WITHOUT_DELEGATION');
  assert.deepEqual([preserved, plain.model().authority.length, plain.setFiles(), plain.state()], [0, 0, [], 'IDLE']);
  const seen = [];
  const refusing = await world(sub(dir, 'refusing'), { preserveIssued, classDelegation: (record, packet) => { seen.push([record.version, packet.packetId]); throw new Error('DELEGATION_ACCEPTANCE_MISMATCH'); } });
  refusedWith(() => refusing.runtime.activateIssued(refusing.c, derived(refusing), refusing.limitedDocument), 'DELEGATION_ACCEPTANCE_MISMATCH');
  assert.deepEqual([preserved, refusing.model().authority.length, refusing.state(), seen], [0, 0, 'IDLE', [[1, refusing.packet.packetId]]]);
});

// ---------------------------------------------------------------- separate processes
function child(script, args, { timeout } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', script, ...args], { cwd: ROOT, ...(timeout ? { timeout } : {}) });
    let out = '', err = '';
    p.stdout.on('data', (b) => { out += b; }); p.stderr.on('data', (b) => { err += b; });
    p.on('close', (code, signal) => resolve({ code, signal, out, err, pid: p.pid }));
    p.on('error', reject);
  });
}
const lines = (path) => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const LEASE_CHILD = `
  import { appendFileSync, readFileSync } from 'node:fs';
  import { join } from 'node:path';
  import { WorkerStore } from './dist/limited-worker/store.js';
  const [dir, log, goAt, holdMs, mode] = process.argv.slice(1);
  const store = new WorkerStore(dir), note = (o) => appendFileSync(log, JSON.stringify({ pid: process.pid, ...o }) + '\\n');
  while (Date.now() < Number(goAt)) { /* start together */ }
  let release;
  try { release = store.lease(); } catch (error) { note({ refused: error.message }); process.exit(0); }
  const mine = readFileSync(join(dir, 'runtime.lock'), 'utf8');
  note({ acquired: String(process.hrtime.bigint()) });
  if (mode === 'die') process.kill(process.pid, 'SIGKILL');
  const until = Date.now() + Number(holdMs); while (Date.now() < until) { /* hold */ }
  // Still ours at the end of the hold: nobody removed or replaced it.
  note({ released: String(process.hrtime.bigint()), intact: readFileSync(join(dir, 'runtime.lock'), 'utf8') === mine });
  release();`;
const RESERVE_CHILD = `
  import { appendFileSync } from 'node:fs';
  import { WorkerStore } from './dist/limited-worker/store.js';
  const [dir, log, goAt, id, invocationId] = process.argv.slice(1);
  const store = new WorkerStore(dir);
  while (Date.now() < Number(goAt)) { /* start together */ }
  try { store.reserve(id, 210240, invocationId, new Date().toISOString(), true); appendFileSync(log, JSON.stringify({ ok: invocationId }) + '\\n'); }
  catch (error) { appendFileSync(log, JSON.stringify({ refused: error.message }) + '\\n'); }`;
// A whole trusted Host in its own process: the same composition, the offline transport, sends counted in the log.
const HOST_CHILD = `
  import { appendFileSync, readFileSync } from 'node:fs';
  import { createGovernedLimitedWorker } from './dist/automation/live/governed-execution.js';
  import { offlineAnthropicTransport } from './dist/limited-worker/transport.js';
  const [jobPath, log, goAt, mode] = process.argv.slice(1);
  const job = JSON.parse(readFileSync(jobPath, 'utf8')), clock = { now: () => new Date().toISOString() };
  const note = (o) => appendFileSync(log, JSON.stringify({ pid: process.pid, ...o }) + '\\n');
  const io = { price: async () => job.md, model: async () => job.modelReply, now: clock.now,
    ready: async () => { if (mode === 'die-before-send') process.kill(process.pid, 'SIGKILL'); await new Promise((r) => setTimeout(r, 30)); },
    send: async () => { note({ send: true }); if (mode === 'die-after-send') process.kill(process.pid, 'SIGKILL'); return job.reply; } };
  const runtime = createGovernedLimitedWorker({ ...job.options, clock, transport: offlineAnthropicTransport(io),
    currentImplementation: () => job.identity, readSource: () => job.source, readGoal: () => job.goal });
  while (Date.now() < Number(goAt)) { /* start together */ }
  try { await runtime.execute(job.contract); note({ done: true }); } catch (error) { note({ refused: error.message }); }`;
const hostJob = (w, dir) => {
  const { clock: _c, transport: _t, currentImplementation: _i, readSource: _s, readGoal: _g, ...options } = w.options;
  const path = join(dir, `host-${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify({ options, md, modelReply: MODEL_REPLY, reply: REPLY, contract: w.c, source: w.source, goal: w.g.text,
    identity: { sha: w.c.implementationSha, codeHash: w.c.workerCodeHash, clean: true } }));
  return path;
};
// The Host's activation sequence in its own process, killed with SIGKILL at a chosen point.
const STAGE_CHILD = `
  import { readFileSync } from 'node:fs';
  import { openDirectAuthorityPreserver } from './dist/automation/authority/preserver.js';
  import { readGovernedModel } from './dist/automation/read-model/governed-read-model.js';
  import { publishActivationSet } from './dist/limited-worker/activation-set.js';
  const job = JSON.parse(readFileSync(process.argv[1], 'utf8'));
  const preserver = openDirectAuthorityPreserver(job.authority);
  job.documents.forEach((d, i) => { if (i === job.killAfter) process.kill(process.pid, 'SIGKILL'); preserver.preserve(d); });
  if (job.killAfter === 3) process.kill(process.pid, 'SIGKILL');
  const model = readGovernedModel({ controllerStoreDirectory: job.controller, authorityArchiveDirectory: job.authority }, { now: () => new Date().toISOString() });
  publishActivationSet(job.results, { contract: job.contract, packet: job.packet, model, liveGrant: job.live, limitedGrant: job.limited });
  if (job.killAfter === 4) process.kill(process.pid, 'SIGKILL');
  console.log('done');`;
const stageJob = (w, dir, killAfter) => {
  const path = join(dir, `stage-${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify({ authority: w.authority, controller: w.options.controllerStoreDirectory, results: w.store.directory, killAfter,
    documents: w.documents, contract: w.c, packet: w.packet, live: w.live, limited: w.limited }));
  return path;
};
async function deadPid() { return (await child('process.exit(0)', [])).pid; }
const staleLease = async (dir) => { const record = { pid: await deadPid(), nonce: randomUUID() }; writeFileSync(join(dir, 'runtime.lock'), JSON.stringify(record), { mode: 0o600 }); return record; };

// The pre-S1 takeover, unchanged apart from the test hook and the returned descriptor, to reproduce its race.
function legacyLease(directory, hook) {
  const file = join(directory, 'runtime.lock');
  let fd;
  try { fd = openSync(file, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const prior = lstatSync(file), pid = JSON.parse(readFileSync(file, 'utf8')).pid;
    try { process.kill(pid, 0); throw new Error('WORKER_LEASE_BUSY'); } catch (e) { if (e.code !== 'ESRCH') throw new Error('WORKER_LEASE_BUSY'); }
    const current = lstatSync(file); if (current.ino !== prior.ino || current.dev !== prior.dev) throw new Error('WORKER_LEASE_UNCERTAIN');
    hook?.();
    unlinkSync(file); return legacyLease(directory);
  }
  writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce: randomUUID() }));
  return { fd, close: () => closeSync(fd) };
}

// ================================================================ S1-A lease
await test('S1-A reproduced: the pre-S1 takeover deletes a lease another process has just taken over', async (dir) => {
  const d = sub(dir, 's'); await staleLease(d);
  let b;
  const a = legacyLease(d, () => { b = legacyLease(d); });
  try {
    assert.ok(a && b, 'both contenders returned holding a lease');
    assert.equal(fstatSync(b.fd).nlink, 0, 'B\'s freshly acquired lease file was deleted by A\'s late unlink');
    assert.equal(fstatSync(a.fd).nlink, 1);
  } finally { a.close(); b.close(); }
});
await test('S1-A the same interleaving against the new lease: the late contender stops and the fresh holder keeps its lease', async (dir) => {
  const store = new WorkerStore(join(dir, 's')), file = join(store.directory, 'runtime.lock');
  await staleLease(store.directory);
  let releaseB, recordB;
  refusedWith(() => store.lease({ beforeTakeover: () => { releaseB = new WorkerStore(store.directory).lease(); recordB = readFileSync(file, 'utf8'); } }), 'WORKER_LEASE_BUSY');
  assert.equal(readFileSync(file, 'utf8'), recordB, 'B\'s lease is untouched');
  assert.deepEqual(leaseFiles(store.directory), ['runtime.lock'], 'no token or temp file is left behind');
  refusedWith(() => store.lease(), 'WORKER_LEASE_BUSY');
  releaseB(); assert.deepEqual(leaseFiles(store.directory), []);
  // A repeated release never removes a later holder's lease.
  const releaseC = store.lease(), recordC = readFileSync(file, 'utf8');
  releaseB(); assert.equal(readFileSync(file, 'utf8'), recordC); releaseC(); assert.deepEqual(leaseFiles(store.directory), []);
});
await test('S1-A a takeover in progress (its token exists) makes every contender BUSY; a token left by a dead takeover fails closed', async (dir) => {
  const store = new WorkerStore(join(dir, 's'));
  const stale = await staleLease(store.directory);
  writeFileSync(join(store.directory, `runtime.lock.takeover-${stale.nonce}`), JSON.stringify({ pid: stale.pid, nonce: randomUUID() }), { mode: 0o600 });
  const before = tree(store.directory);
  for (let i = 0; i < 3; i++) refusedWith(() => store.lease(), 'WORKER_LEASE_BUSY');
  assert.deepEqual(tree(store.directory), before, 'nothing was removed, replaced or left behind');
});
await test('S1-A PID reuse: a lease whose pid belongs to any live process is BUSY and untouched', async (dir) => {
  const store = new WorkerStore(join(dir, 's'));
  const unrelated = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)']);
  try {
    writeFileSync(join(store.directory, 'runtime.lock'), JSON.stringify({ pid: unrelated.pid, nonce: randomUUID() }), { mode: 0o600 });
    const before = tree(store.directory);
    refusedWith(() => store.lease(), 'WORKER_LEASE_BUSY'); assert.deepEqual(tree(store.directory), before);
  } finally { unrelated.kill('SIGKILL'); }
});
await test('S1-A unreadable, malformed or symlinked lease records are UNCERTAIN and never removed', async (dir) => {
  const store = new WorkerStore(join(dir, 's')), file = join(store.directory, 'runtime.lock');
  for (const content of ['', '{"pid":1}', 'not json', JSON.stringify({ pid: 'x', nonce: randomUUID() }), 'x'.repeat(600)]) {
    writeFileSync(file, content, { mode: 0o600 });
    refusedWith(() => store.lease(), 'WORKER_LEASE_UNCERTAIN'); assert.equal(readFileSync(file, 'utf8'), content); unlinkSync(file);
  }
  const target = join(dir, 'elsewhere'); writeFileSync(target, JSON.stringify({ pid: await deadPid(), nonce: randomUUID() }));
  symlinkSync(target, file); const before = tree(store.directory);
  refusedWith(() => store.lease(), 'WORKER_LEASE_UNCERTAIN'); assert.deepEqual(tree(store.directory), before);
});
await test('S1-A process death: a holder killed by SIGKILL leaves a complete stale lease that a later process takes over cleanly', async (dir) => {
  const store = new WorkerStore(join(dir, 's')), log = join(dir, 'log');
  const r = await child(LEASE_CHILD, [store.directory, log, String(Date.now()), '0', 'die']);
  assert.equal(r.signal, 'SIGKILL');
  assert.equal(JSON.parse(readFileSync(join(store.directory, 'runtime.lock'), 'utf8')).pid, r.pid, 'the dead holder\'s lease remains, complete');
  const release = store.lease(); assert.equal(JSON.parse(readFileSync(join(store.directory, 'runtime.lock'), 'utf8')).pid, process.pid);
  release(); assert.deepEqual(leaseFiles(store.directory), []);
});
for (const kind of ['free', 'stale']) await test(`S1-A six processes race for a ${kind} lease, 8 rounds: one holder at a time, every lease intact until released`, async (dir) => {
  const store = new WorkerStore(join(dir, 's'));
  for (let round = 0; round < 8; round++) {
    if (kind === 'stale') await staleLease(store.directory);
    const log = join(dir, `log-${round}`), goAt = Date.now() + 1500;
    await Promise.all(Array.from({ length: 6 }, () => child(LEASE_CHILD, [store.directory, log, String(goAt), '40', 'hold'])));
    const entries = lines(log), holds = entries.filter((e) => e.acquired);
    assert.equal(entries.length, 6 + holds.length, JSON.stringify(entries));
    assert.ok(holds.length >= 1, `round ${round}: someone held the lease`);
    assert.ok(entries.filter((e) => e.released).every((e) => e.intact), `round ${round}: a held lease was removed or replaced`);
    assert.ok(entries.filter((e) => e.refused).every((e) => e.refused === 'WORKER_LEASE_BUSY'), JSON.stringify(entries));
    const spans = holds.map((h) => ({ from: BigInt(h.acquired), to: BigInt(entries.find((e) => e.pid === h.pid && e.released).released) }))
      .sort((a, b) => (a.from < b.from ? -1 : 1));
    for (let i = 1; i < spans.length; i++) assert.ok(spans[i].from > spans[i - 1].to, `round ${round}: two processes held the lease at once`);
    assert.deepEqual(leaseFiles(store.directory), [], `round ${round}: no lease, token or temp file is left`);
  }
});
await test('S1-A a leftover write.lock stops every ledger write and changes nothing; the documented Human recovery resumes', async (dir) => {
  const w = await world(dir), lock = join(w.store.directory, 'write.lock'), ledger = join(w.store.directory, 'ledger.json');
  const before = readFileSync(ledger);
  writeFileSync(lock, '', { mode: 0o600 });
  refusedWith(() => w.store.change(hash(w.c), (j) => { j.events.push({ at: w.clock.now(), kind: 'X' }); }), 'WORKER_STORE_WRITE_LOCK_HELD');
  refusedWith(() => w.store.reserve(hash(w.c), 210240, hash('x'), w.clock.now(), true), 'WORKER_STORE_WRITE_LOCK_HELD');
  activate(w); await w.runtime.execute(w.c).catch(() => {});
  assert.equal(w.calls, 0); assert.deepEqual(readFileSync(ledger), before); assert.ok(existsSync(lock), 'never removed automatically');
  // Recovery (Human): hold the runtime lease so no Host runs, check the ledger still verifies, then remove the leftover.
  const release = w.store.lease(); assert.equal(w.store.read().jobs.length, 1); unlinkSync(lock); release();
  w.store.change(hash(w.c), (j) => { j.events.push({ at: w.clock.now(), kind: 'S1_RECOVERY_CHECK' }); });
});
await test('S1-A three processes racing to reserve one job, 5 rounds: exactly one claim each round', async (dir) => {
  for (let round = 0; round < 5; round++) {
    const w = await world(sub(dir, `r${round}`)), log = join(dir, `reserve-${round}`), goAt = Date.now() + 1500;
    await Promise.all(['a', 'b', 'c'].map((n) => child(RESERVE_CHILD, [w.store.directory, log, String(goAt), hash(w.c), hash(`inv-${round}-${n}`)])));
    const out = lines(log);
    assert.equal(out.length, 3); assert.equal(out.filter((e) => e.ok).length, 1, JSON.stringify(out));
    assert.ok(out.filter((e) => e.refused).every((e) => ['REQUEST_NOT_REPLAYABLE', 'WORKER_STORE_WRITE_LOCK_HELD'].includes(e.refused)), JSON.stringify(out));
    assert.equal(w.job().state, 'RUNNING'); assert.equal(w.job().reservedMicroUsd, 210240);
    assert.equal(w.job().invocationId, out.find((e) => e.ok).ok);
  }
});
await test('S1-A four Host processes execute one activated run at once: one provider send in total', async (dir) => {
  const w = await world(dir); activate(w);
  const job = hostJob(w, dir), log = join(dir, 'host'), goAt = Date.now() + 2500;
  await Promise.all([1, 2, 3, 4].map(() => child(HOST_CHILD, [job, log, String(goAt), 'normal'])));
  const out = lines(log);
  assert.equal(out.filter((e) => e.send).length, 1, JSON.stringify(out)); assert.equal(out.filter((e) => e.done).length, 1, JSON.stringify(out));
  assert.ok(out.filter((e) => e.refused).every((e) => ['WORKER_LEASE_BUSY', 'LIMITED_WORKER_NOT_AT_OWNED_STAGE'].includes(e.refused)), JSON.stringify(out));
  assert.equal(w.runtime.resultConsistency(w.c), true); assert.equal(w.calls, 0);
  assert.deepEqual(leaseFiles(w.store.directory), []);
});
for (const mode of ['die-before-send', 'die-after-send']) await test(`S1-A Host killed (SIGKILL) ${mode === 'die-before-send' ? 'after the claim, before the send' : 'right after the send'}: restart takes the lease over and never sends again`, async (dir) => {
  const w = await world(dir); activate(w);
  const job = hostJob(w, dir), log = join(dir, 'host');
  const r = await child(HOST_CHILD, [job, log, String(Date.now()), mode]);
  assert.equal(r.signal, 'SIGKILL');
  const sent = lines(log).filter((e) => e.send).length;
  assert.equal(sent, mode === 'die-before-send' ? 0 : 1);
  assert.equal(JSON.parse(readFileSync(join(w.store.directory, 'runtime.lock'), 'utf8')).pid, r.pid);
  assert.equal(w.job().generationClaimed, true);
  await createGovernedLimitedWorker(w.options).execute(w.c).catch(() => {});
  await child(HOST_CHILD, [job, log, String(Date.now()), 'normal']);
  assert.equal(w.calls, 0); assert.equal(lines(log).filter((e) => e.send).length, sent);
  assert.equal(w.job().state, 'UNCERTAIN'); assert.equal(w.job().reservedMicroUsd, 210240); assert.equal(w.job().report, null);
  assert.deepEqual(leaseFiles(w.store.directory), []);
});

// ================================================================ S1-B ACTIVATION_SET
await test('S1-B activation commits one content-addressed set binding run, packet, contract, implementation and signature policy', async (dir) => {
  const w = await world(dir);
  const staged = activate(w);
  assert.equal(staged.stage.state, 'PACKET_READY');
  const files = w.setFiles(); assert.equal(files.length, 1);
  const stored = JSON.parse(readFileSync(join(w.setDir, files[0]), 'utf8')), s = stored.set;
  assert.equal(stored.setHash, activationSetHash(s)); assert.ok(files[0].endsWith(`${stored.setHash}.json`));
  assert.equal(staged.activationSet.setHash, stored.setHash);
  assert.deepEqual([s.schema, s.recordClass, s.notAuthority, s.runId, s.repository, s.packetId, s.contractHash, s.implementationSha, s.workerCodeHash],
    [ACTIVATION_SET_SCHEMA, 'OPERATIONAL_RECORD', true, w.c.runId, w.c.repository, w.packet.packetId, hash(w.c), w.c.implementationSha, w.c.workerCodeHash]);
  assert.deepEqual(s.members.map((m) => [m.role, m.kind, m.authorityId, m.version]), [['IMPLEMENTATION_PACKET', 'IMPLEMENTATION_PACKET', w.packet.packetId, 1],
    ['LIVE_PROVIDER_MODEL_CALL', 'AUTHORIZATION', w.live.authorizationId, 1], ['LIMITED_README_WORKER', 'AUTHORIZATION', w.limited.authorizationId, 1]]);
  const archived = w.model().authority.map((f) => f.ref.recordHash);
  assert.ok(s.members.every((m) => archived.includes(m.recordHash)));
  assert.deepEqual(s.signaturePolicy, { version: 'S1_UNSIGNED_V0', humanSignatureRequired: false }); assert.deepEqual(s.attestations, []);
  assert.deepEqual(staged.liveEligibility, { eligible: false, reason: 'ACTIVATION_SET_NOT_SIGNED' });
  assert.ok(staged.blockers.includes('ACTIVATION_SET_UNSIGNED') && staged.blockers.includes('EXE_HOLD')); assert.equal(staged.executionEligible, false);
  // Not authority: the archive refuses it and still holds exactly the three documents.
  const archive = tree(w.authority);
  assert.throws(() => parseAuthorityDocument(s)); assert.throws(() => w.preserver.preserve(s));
  assert.deepEqual(tree(w.authority), archive); assert.equal(w.model().authority.length, 3);
  // A repeated activation is the same commit; the offline run then completes exactly once.
  assert.equal(activate(w).stage.status, 'ALREADY_ACTIVATED'); assert.equal(w.setFiles().length, 1);
  await w.runtime.execute(w.c); assert.equal(w.calls, 1); assert.equal(w.runtime.resultConsistency(w.c), true);
});
for (const crashAt of [0, 1, 2, 3]) await test(`S1-B crash after ${crashAt} of 3 documents preserved: no set, no activation, no execution; an exact retry completes once`, async (dir) => {
  const w = await world(dir, { preserveIssued: (documents, preserver) => {
    documents.forEach((d, i) => { if (i === crashAt) throw new Error('INJECTED_CRASH'); preserver.preserve(d); });
    if (crashAt === 3) throw new Error('INJECTED_CRASH');
  } });
  const initial = w.state();
  assert.throws(() => activate(w), /INJECTED_CRASH/);
  assert.equal(w.model().authority.length, crashAt, 'partial records stay; nothing is deleted');
  assert.deepEqual(w.setFiles(), []); assert.equal(w.state(), initial);
  await assert.rejects(w.runtime.execute(w.c), /LIMITED_WORKER_NOT_AT_OWNED_STAGE/); assert.equal(w.calls, 0);
  const retry = composeLimitedWorker(w.options, { createActivation: (controller) => openGovernedActivationCore({ ...w.options, controller, preserver: w.preserver }),
    preserveIssued: (documents) => { for (const d of documents) w.preserver.preserve(d); } });
  assert.equal(retry.activateIssued(w.c, w.bundle, w.limitedDocument).stage.state, 'PACKET_READY');
  assert.equal(w.model().authority.length, 3, 'the retry reuses the archived records'); assert.equal(w.setFiles().length, 1);
  await retry.execute(w.c); assert.equal(w.calls, 1);
});
for (const killAfter of [1, 2, 3, 4]) await test(`S1-B Host killed (SIGKILL) ${killAfter < 4 ? `after ${killAfter} document(s)` : 'after the set, before the Controller'}: restart activates once`, async (dir) => {
  const w = await world(dir), initial = w.state();
  const r = await child(STAGE_CHILD, [stageJob(w, dir, killAfter)]);
  assert.equal(r.signal, 'SIGKILL', r.err);
  assert.equal(w.model().authority.length, Math.min(killAfter, 3)); assert.equal(w.setFiles().length, killAfter === 4 ? 1 : 0);
  assert.equal(w.state(), initial);
  await assert.rejects(w.runtime.execute(w.c), /LIMITED_WORKER_NOT_AT_OWNED_STAGE/); assert.equal(w.calls, 0);
  assert.equal(activate(w).stage.state, 'PACKET_READY');
  assert.equal(w.model().authority.length, 3); assert.equal(w.setFiles().length, 1);
  await w.runtime.execute(w.c); assert.equal(w.calls, 1);
});
await test('S1-B duplicate concurrent submissions of the same documents: one archive record each, one set', async (dir) => {
  const w = await world(dir);
  const results = await Promise.all([1, 2, 3, 4].map(() => child(STAGE_CHILD, [stageJob(w, dir, -1)])));
  assert.ok(results.some((r) => r.code === 0 && r.out.includes('done')), JSON.stringify(results.map((r) => r.err.slice(-300))));
  assert.equal(w.model().authority.length, 3); assert.equal(w.setFiles().length, 1);
  verifyActivationSet(w.store.directory, w.setInput());
  assert.equal(activate(w).stage.state, 'PACKET_READY'); assert.equal(w.setFiles().length, 1);
});
await test('S1-B simulated power-loss residues (constructed states, not a real power cut): a leftover temp file is never a set; truncated, altered, symlinked, unsafe or missing sets refuse', async (dir) => {
  const w = await world(dir); activate(w);
  const [name] = w.setFiles(), path = join(w.setDir, name), runDir = join(path, '..'), good = readFileSync(path);
  writeFileSync(join(runDir, `.${randomUUID()}.tmp`), good.subarray(0, 20), { mode: 0o600 });
  verifyActivationSet(w.store.directory, w.setInput());
  for (const bad of [good.subarray(0, 40), Buffer.from(good.toString().replace(/"runId":"[^"]+"/, '"runId":"run-other"')), Buffer.alloc(0)]) {
    writeFileSync(path, bad); refusedWith(() => verifyActivationSet(w.store.directory, w.setInput()), 'ACTIVATION_SET_CORRUPT');
  }
  unlinkSync(path); const copy = join(dir, 'copy.json'); writeFileSync(copy, good, { mode: 0o600 }); symlinkSync(copy, path);
  refusedWith(() => verifyActivationSet(w.store.directory, w.setInput()), 'ACTIVATION_SET_FILE_UNSAFE');
  unlinkSync(path); writeFileSync(path, good, { mode: 0o600 }); verifyActivationSet(w.store.directory, w.setInput());
  chmodSync(runDir, 0o755); refusedWith(() => verifyActivationSet(w.store.directory, w.setInput()), 'ACTIVATION_SET_STORAGE_UNSAFE'); chmodSync(runDir, 0o700);
  unlinkSync(path); refusedWith(() => verifyActivationSet(w.store.directory, w.setInput()), 'ACTIVATION_SET_MISSING');
  // The pre-execution check refuses before any reservation or claim.
  await w.runtime.execute(w.c);
  assert.equal(w.calls, 0); assert.equal(w.job().state, 'BLOCKED'); assert.equal(w.job().reason, 'ACTIVATION_SET_MISSING');
  assert.equal(w.job().generationClaimed, false); assert.equal(w.job().reservedMicroUsd, 0);
});
await test('S1-B forged markers, conflicting content, a forged attestation and mixed versions are never the expected set', async (dir) => {
  const w = await world(dir); activate(w);
  const expected = expectedActivationSet(w.setInput()), expectedHash = activationSetHash(expected);
  const [name] = w.setFiles(), path = join(w.setDir, name), runDir = join(path, '..'), good = readFileSync(path);
  const write = (set, file = join(runDir, `${activationSetHash(set)}.json`)) => writeFileSync(file, JSON.stringify({ set, setHash: activationSetHash(set) }), { mode: 0o600 });
  // Forged sets under their own names are never read: a fabricated member, another contract, an older implementation.
  write({ ...expected, members: [expected.members[0], expected.members[1], { ...expected.members[2], recordHash: 'f'.repeat(64) }] });
  write({ ...expected, contractHash: 'e'.repeat(64) }); write({ ...expected, implementationSha: 'c'.repeat(40) });
  assert.equal(verifyActivationSet(w.store.directory, w.setInput()).setHash, expectedHash);
  // Self-consistent other content under the expected name: publication conflicts, verification refuses.
  write({ ...expected, sliceId: 'other-slice' }, path);
  refusedWith(() => publishActivationSet(w.store.directory, w.setInput()), 'ACTIVATION_SET_CONFLICT');
  refusedWith(() => verifyActivationSet(w.store.directory, w.setInput()), 'ACTIVATION_SET_CORRUPT');
  // A forged "Human attestation" never parses in S1 (no signature policy accepts one yet).
  writeFileSync(path, JSON.stringify({ set: { ...expected, attestations: [{ signer: 'human', signature: 'forged' }] }, setHash: expectedHash }));
  refusedWith(() => verifyActivationSet(w.store.directory, w.setInput()), 'ACTIVATION_SET_CORRUPT');
  writeFileSync(path, good); verifyActivationSet(w.store.directory, w.setInput());
  // Mixed versions: once any member has a newer archived version, the committed set is stale.
  supersede(w, w.limitedDocument);
  refusedWith(() => verifyActivationSet(w.store.directory, w.setInput()), 'ACTIVATION_SET_MEMBER_NOT_CURRENT');
  refusedWith(() => publishActivationSet(w.store.directory, w.setInput()), 'ACTIVATION_SET_MEMBER_NOT_CURRENT');
  await w.runtime.execute(w.c); assert.equal(w.calls, 0); assert.equal(w.job().generationClaimed, false);
  refusedWith(() => expectedActivationSet({ ...w.setInput(), contract: { ...w.c, runId: 'run-unknown' } }), 'ACTIVATION_SET_RUN_MISMATCH');
  // Orphan: documents never archived in this world are refused even with otherwise exact content.
  const other = await world(sub(dir, 'other'));
  refusedWith(() => expectedActivationSet(other.setInput()), 'ACTIVATION_SET_MEMBER_NOT_ARCHIVED');
  refusedWith(() => publishActivationSet(other.store.directory, other.setInput()), 'ACTIVATION_SET_MEMBER_NOT_ARCHIVED');
});
for (const change of ['removed', 'corrupted', 'stale']) await test(`S1-B the final send guard re-verifies the set: ${change} after the claim, no request is sent`, async (dir) => {
  const w = await world(dir); activate(w);
  const [name] = w.setFiles(), path = join(w.setDir, name);
  w.providerIO.ready = async () => {
    if (change === 'removed') unlinkSync(path);
    if (change === 'corrupted') writeFileSync(path, readFileSync(path).subarray(0, 50));
    if (change === 'stale') supersede(w, w.bundle.implementationPacket);
  };
  await w.runtime.execute(w.c);
  assert.equal(w.calls, 0); assert.equal(w.job().generationClaimed, true); assert.equal(w.job().state, 'UNCERTAIN'); assert.equal(w.job().reservedMicroUsd, 210240);
  if (change !== 'stale') assert.equal(w.job().reason, change === 'removed' ? 'ACTIVATION_SET_MISSING' : 'ACTIVATION_SET_CORRUPT');
});
await test('S1-B an unsigned set never yields live eligibility, and a live transport stays behind EXE HOLD', async (dir) => {
  const w = await world(dir); const staged = activate(w);
  assert.deepEqual(liveEligibility(staged.activationSet), { eligible: false, reason: 'ACTIVATION_SET_NOT_SIGNED' });
  assert.deepEqual(liveEligibility(null), { eligible: false, reason: 'ACTIVATION_SET_MISSING' });
  assert.deepEqual({ ...SIGNATURE_POLICY }, { version: 'S1_UNSIGNED_V0', humanSignatureRequired: false });
  assert.equal(staged.activationSet.signed, false); assert.equal(staged.executionEligible, false);
  let preflights = 0;
  const live = composeLimitedWorker({ ...w.options, transport: { kind: 'LIVE_PROVIDER', preflight: async () => { preflights++; throw new Error('NO'); },
    generate: async () => { preflights++; throw new Error('NO'); } } });
  await assert.rejects(live.execute(w.c), /EXE_HOLD/); assert.equal(preflights, 0); assert.equal(w.calls, 0);
});
await test('S1-B publishing writes nothing to the Authority Archive and never rewrites its history', async (dir) => {
  const w = await world(dir);
  for (const d of w.documents) w.preserver.preserve(d);
  const before = tree(w.authority);
  const first = publishActivationSet(w.store.directory, w.setInput()), again = publishActivationSet(w.store.directory, w.setInput());
  assert.equal(first, again); assert.deepEqual(tree(w.authority), before); assert.equal(w.setFiles().length, 1);
  assert.deepEqual(readdirSync(join(w.setDir, w.setFiles()[0], '..')).filter((n) => n.endsWith('.tmp')), [], 'no temp file is left');
  assert.equal(verifyActivationSet(w.store.directory, w.setInput()).setHash, first);
});

await test('S1-B the unissued Pilot Packet states the ACTIVATION_SET requirement and grants nothing', async (dir) => {
  const w = await world(dir), p = activationCandidate(w.c, w.packet.sliceId, w.g.text);
  assert.equal(p.state, 'UNISSUED_NOT_AUTHORITY'); assert.equal(p.issuedAt, null); assert.equal(p.expiresAt, null);
  assert.deepEqual(p.authority, { implementationPacket: null, liveProviderGrant: null, limitedWorkerGrant: null });
  assert.deepEqual([p.activationSet.schema, p.activationSet.required, p.activationSet.setHash, p.activationSet.liveEligibility, p.activationSet.notAuthority],
    [ACTIVATION_SET_SCHEMA, true, null, 'NOT_ELIGIBLE_UNSIGNED', true]);
  assert.deepEqual(p.activationSet.signaturePolicy, { ...SIGNATURE_POLICY }); assert.match(p.activationPath, /Authority Archive -> ACTIVATION_SET -> Controller/);
  assert.deepEqual(w.setFiles(), []); assert.equal(w.model().authority.length, 0);
});

// ================================================================ S1-R1: Fix 1 (set file checks) and Fix 2 (commit durability)
// Test-only tracing of the builtin fs calls the dist modules make (ESM live bindings refreshed with syncBuiltinESMExports).
// A hook runs before each call, so a hook that throws stops the publisher exactly before that step. Restored after use.
const TRACED = ['mkdirSync', 'openSync', 'fchmodSync', 'writeFileSync', 'fsyncSync', 'linkSync', 'unlinkSync', 'renameSync'];
function traceFs(hook) {
  const original = Object.fromEntries([...TRACED, 'closeSync'].map((n) => [n, fsModule[n]])), fdPath = new Map();
  for (const name of TRACED) fsModule[name] = function (...args) {
    const call = { name, path: typeof args[0] === 'number' ? fdPath.get(args[0]) : String(args[0]),
      to: ['linkSync', 'renameSync'].includes(name) ? String(args[1]) : undefined, flags: name === 'openSync' ? args[1] : undefined };
    hook(call);
    const result = original[name].apply(this, args);
    if (name === 'openSync') fdPath.set(result, call.path);
    return result;
  };
  fsModule.closeSync = function (fd) { fdPath.delete(fd); return original.closeSync.call(this, fd); };
  syncBuiltinESMExports();
  return () => { Object.assign(fsModule, original); syncBuiltinESMExports(); };
}
const TEMP = /\/\.[0-9a-f-]{36}\.tmp$/;
const publishSteps = (w) => (c) => c.path === w.store.directory || Boolean(c.path?.startsWith(w.setDir));
function labelled(w, trace) {
  const runDir = existsSync(w.setDir) ? join(w.setDir, readdirSync(w.setDir)[0] ?? '') : null;
  const label = (p) => p === w.store.directory ? 'root' : p === w.setDir ? 'base' : p === runDir ? 'run' : TEMP.test(p) ? 'temp' : p?.endsWith('.json') ? 'target' : p;
  return trace.map((c) => `${c.name}:${label(c.path)}${c.to ? '>' + label(c.to) : ''}`);
}
const VERIFY_CHILD = `
  import { readFileSync } from 'node:fs';
  import { readGovernedModel } from './dist/automation/read-model/governed-read-model.js';
  import { verifyActivationSet } from './dist/limited-worker/activation-set.js';
  const job = JSON.parse(readFileSync(process.argv[1], 'utf8'));
  const model = readGovernedModel({ controllerStoreDirectory: job.controller, authorityArchiveDirectory: job.authority }, { now: () => new Date().toISOString() });
  try { verifyActivationSet(job.results, { contract: job.contract, packet: job.packet, model, liveGrant: job.live, limitedGrant: job.limited }); console.log(JSON.stringify({ ok: true })); }
  catch (error) { console.log(JSON.stringify({ error: error.message })); }`;
// SIGKILL (a real process death, not a power cut) exactly before the chosen publish step.
const PUBLISH_KILL_CHILD = `
  import fs, { readFileSync } from 'node:fs';
  import { syncBuiltinESMExports } from 'node:module';
  import { readGovernedModel } from './dist/automation/read-model/governed-read-model.js';
  import { publishActivationSet } from './dist/limited-worker/activation-set.js';
  const job = JSON.parse(readFileSync(process.argv[1], 'utf8')), killAt = Number(process.argv[2]), fdPath = new Map();
  let n = 0;
  for (const name of ${JSON.stringify(TRACED)}) {
    const original = fs[name];
    fs[name] = function (...args) {
      const path = typeof args[0] === 'number' ? fdPath.get(args[0]) : String(args[0]);
      if ((path === job.results || path?.startsWith(job.results + '/activation-sets')) && n++ === killAt) process.kill(process.pid, 'SIGKILL');
      const result = original.apply(this, args); if (name === 'openSync') fdPath.set(result, path); return result;
    };
  }
  syncBuiltinESMExports();
  const model = readGovernedModel({ controllerStoreDirectory: job.controller, authorityArchiveDirectory: job.authority }, { now: () => new Date().toISOString() });
  publishActivationSet(job.results, { contract: job.contract, packet: job.packet, model, liveGrant: job.live, limitedGrant: job.limited });
  console.log('done');`;
const FRESH_PUBLISH = ['mkdirSync:base', 'openSync:root', 'fsyncSync:root', 'mkdirSync:run', 'openSync:base', 'fsyncSync:base',
  'openSync:temp', 'fchmodSync:temp', 'writeFileSync:temp', 'fsyncSync:temp', 'linkSync:temp>target', 'unlinkSync:temp', 'openSync:run', 'fsyncSync:run'];
const LINKED_AT = FRESH_PUBLISH.indexOf('linkSync:temp>target');

await test('S1-R1 Fix 1: the set file must be mode 0600; 0644, 0666 and every other mode fail closed at verify, publish and execution', async (dir) => {
  const w = await world(dir); activate(w);
  const [name] = w.setFiles(), path = join(w.setDir, name), verify = () => verifyActivationSet(w.store.directory, w.setInput());
  assert.equal(lstatSync(path).mode & 0o7777, 0o600); verify();
  for (const mode of [0o644, 0o666, 0o640, 0o604, 0o660, 0o400, 0o700]) {
    chmodSync(path, mode);
    refusedWith(verify, 'ACTIVATION_SET_FILE_UNSAFE');
    refusedWith(() => publishActivationSet(w.store.directory, w.setInput()), 'ACTIVATION_SET_FILE_UNSAFE');
  }
  chmodSync(path, 0o600); verify(); assert.equal(publishActivationSet(w.store.directory, w.setInput()), verify().setHash);
  // The directories are checked separately; a safe file does not excuse an unsafe directory.
  for (const d of [w.setDir, join(path, '..')]) {
    chmodSync(d, 0o755); refusedWith(verify, 'ACTIVATION_SET_STORAGE_UNSAFE');
    refusedWith(() => publishActivationSet(w.store.directory, w.setInput()), 'ACTIVATION_SET_STORAGE_UNSAFE'); chmodSync(d, 0o700);
  }
  chmodSync(path, 0o644);
  await w.runtime.execute(w.c);
  assert.equal(w.calls, 0); assert.equal(w.job().reason, 'ACTIVATION_SET_FILE_UNSAFE'); assert.equal(w.job().generationClaimed, false);
});
await test('S1-R1 Fix 1: a directory, FIFO or symlink at the set name, or a hard link other than the publisher\'s own temp name, fails closed without blocking', async (dir) => {
  const w = await world(dir); activate(w);
  const [name] = w.setFiles(), path = join(w.setDir, name), runDir = join(path, '..'), good = readFileSync(path);
  const verify = () => verifyActivationSet(w.store.directory, w.setInput());
  const alias = join(runDir, `.${randomUUID()}.tmp`); linkSync(path, alias); verify(); unlinkSync(alias);
  for (const other of [join(w.store.directory, 'outside.json'), join(dir, 'elsewhere.json'), join(runDir, 'other-name.json'), join(runDir, '.not-a-temp.tmp')]) {
    linkSync(path, other);
    refusedWith(verify, 'ACTIVATION_SET_FILE_UNSAFE');
    refusedWith(() => publishActivationSet(w.store.directory, w.setInput()), 'ACTIVATION_SET_FILE_UNSAFE');
    unlinkSync(other); verify();
  }
  unlinkSync(path); mkdirSync(path, { mode: 0o700 }); refusedWith(verify, 'ACTIVATION_SET_FILE_UNSAFE'); rmSync(path, { recursive: true });
  // A FIFO is checked in its own process with a time limit, so a blocking open would show up as a kill, not a hang.
  execFileSync('mkfifo', ['-m', '600', path]);
  const r = await child(VERIFY_CHILD, [stageJob(w, dir, -1)], { timeout: 15000 });
  assert.equal(r.signal, null, 'the check blocked on a FIFO'); assert.deepEqual(JSON.parse(r.out.trim()), { error: 'ACTIVATION_SET_FILE_UNSAFE' });
  unlinkSync(path); writeFileSync(path, good, { mode: 0o600 }); verify();
});
await test('S1-R1 Fix 2: publish order — each parent fsynced after its directory, temp fsynced before link(2), set directory fsynced last; the idempotent path syncs before returning', async (dir) => {
  const w = await world(dir);
  for (const d of w.documents) w.preserver.preserve(d);
  const record = (fn) => { const trace = []; const restore = traceFs((c) => { if (publishSteps(w)(c)) trace.push(c); }); try { return [fn(), trace]; } finally { restore(); } };
  const [first, fresh] = record(() => publishActivationSet(w.store.directory, w.setInput()));
  assert.deepEqual(labelled(w, fresh), FRESH_PUBLISH);
  const [again, repeat] = record(() => publishActivationSet(w.store.directory, w.setInput()));
  assert.equal(again, first);
  // mkdir and link are attempted and answer EEXIST; the existing file is checked, then fsynced, before the directory fsync.
  assert.deepEqual(labelled(w, repeat), ['mkdirSync:base', 'openSync:root', 'fsyncSync:root', 'mkdirSync:run', 'openSync:base', 'fsyncSync:base',
    'openSync:temp', 'fchmodSync:temp', 'writeFileSync:temp', 'fsyncSync:temp', 'linkSync:temp>target', 'openSync:target', 'openSync:target', 'fsyncSync:target',
    'unlinkSync:temp', 'openSync:run', 'fsyncSync:run']);
  assert.equal(w.setFiles().length, 1); assert.deepEqual(readdirSync(join(w.setDir, w.setFiles()[0], '..')).filter((n) => n.endsWith('.tmp')), []);
});
await test(`S1-R1 Fix 2: a stop injected before each of the ${FRESH_PUBLISH.length} publish steps leaves no set or a complete one; an exact retry commits once`, async (dir) => {
  for (let k = 0; k < FRESH_PUBLISH.length; k++) {
    const w = await world(sub(dir, `k${k}`));
    for (const d of w.documents) w.preserver.preserve(d);
    let n = 0;
    const restore = traceFs((c) => { if (publishSteps(w)(c) && n++ === k) throw new Error('INJECTED_STOP'); });
    let threw = false;
    try { publishActivationSet(w.store.directory, w.setInput()); } catch (e) { assert.match(e.message, /INJECTED_STOP/); threw = true; } finally { restore(); }
    // The temp-name removal is best effort by design: a failure there is absorbed and the commit completes.
    assert.equal(threw, FRESH_PUBLISH[k] !== 'unlinkSync:temp', `stop before ${FRESH_PUBLISH[k]}`);
    let outcome; try { verifyActivationSet(w.store.directory, w.setInput()); outcome = 'COMMITTED'; } catch (e) { outcome = e.message; }
    assert.equal(outcome, k > LINKED_AT ? 'COMMITTED' : 'ACTIVATION_SET_MISSING', `stop before ${FRESH_PUBLISH[k]}`);
    publishActivationSet(w.store.directory, w.setInput()); verifyActivationSet(w.store.directory, w.setInput()); assert.equal(w.setFiles().length, 1);
  }
});
await test(`S1-R1 Fix 2: SIGKILL before each of the ${FRESH_PUBLISH.length} publish steps (real process death, not a power cut): restart activates and executes once`, async (dir) => {
  for (let k = 0; k < FRESH_PUBLISH.length; k++) {
    const w = await world(sub(dir, `k${k}`));
    for (const d of w.documents) w.preserver.preserve(d);
    const r = await child(PUBLISH_KILL_CHILD, [stageJob(w, dir, -1), String(k)]);
    assert.equal(r.signal, 'SIGKILL', `step ${k}: ${r.err.slice(-200)}`);
    let outcome; try { verifyActivationSet(w.store.directory, w.setInput()); outcome = 'COMMITTED'; } catch (e) { outcome = e.message; }
    assert.equal(outcome, k > LINKED_AT ? 'COMMITTED' : 'ACTIVATION_SET_MISSING', `killed before ${FRESH_PUBLISH[k]}`);
    assert.equal(activate(w).stage.state, 'PACKET_READY'); assert.equal(w.setFiles().length, 1);
    await w.runtime.execute(w.c); assert.equal(w.calls, 1, `step ${k}`);
  }
});
await test('S1-R1 Fix 2: activation writes the Controller only after every set durability step; a stop at any set step leaves the Controller unchanged', async (dir) => {
  const w = await world(dir), controllerRoot = w.options.controllerStoreDirectory, initial = w.state();
  const { O_WRONLY, O_RDWR, O_CREAT, O_APPEND, O_TRUNC } = fsModule.constants;
  const writes = (f) => typeof f === 'number' ? Boolean(f & (O_WRONLY | O_RDWR | O_CREAT | O_APPEND | O_TRUNC)) : /[wax+]/.test(String(f ?? 'r'));
  const trace = [];
  const restore = traceFs((c) => { if (c.path?.startsWith(w.setDir) || c.path?.startsWith(controllerRoot)) trace.push(c); });
  try { assert.equal(activate(w).stage.state, 'PACKET_READY'); } finally { restore(); }
  const controllerWrite = (c) => c.path?.startsWith(controllerRoot) && (c.name !== 'openSync' || writes(c.flags)) && c.name !== 'fsyncSync';
  const firstControllerWrite = trace.findIndex(controllerWrite), lastSetSync = trace.findLastIndex((c) => c.name === 'fsyncSync' && c.path?.startsWith(w.setDir));
  assert.ok(lastSetSync >= 0 && firstControllerWrite > lastSetSync, `controller write at ${firstControllerWrite}, last set fsync at ${lastSetSync}`);
  assert.notEqual(initial, 'PACKET_READY');
  let k = 0;
  for (;; k++) {
    const v = await world(sub(dir, `s${k}`)), before = v.state();
    let n = 0, stoppedAt = null, threw = false;
    const undo = traceFs((c) => { if (c.path?.startsWith(v.setDir) && n++ === k) { stoppedAt = c; throw new Error('INJECTED_STOP'); } });
    // Any refusal counts (a stop inside the set file read is reported fail-closed as ACTIVATION_SET_CORRUPT).
    try { activate(v); } catch (e) { assert.match(e.message, /^(INJECTED_STOP|ACTIVATION_SET_[A-Z_]+)$/); threw = true; } finally { undo(); }
    if (!stoppedAt) break;
    if (!threw) {
      // Only the best-effort temp-name removal may absorb a stop; the activation then completed with its set committed.
      assert.ok(stoppedAt.name === 'unlinkSync' && TEMP.test(stoppedAt.path), `stop at set step ${k} (${stoppedAt.name}) was absorbed`);
      assert.equal(v.state(), 'PACKET_READY'); verifyActivationSet(v.store.directory, v.setInput()); continue;
    }
    assert.equal(v.state(), before, `stop at set step ${k} (${stoppedAt.name}) moved the Controller`);
    assert.equal(activate(v).stage.state, 'PACKET_READY'); assert.equal(activate(v).stage.status, 'ALREADY_ACTIVATED');
    if (k === 0) { await v.runtime.execute(v.c); assert.equal(v.calls, 1); }
  }
  assert.ok(k >= FRESH_PUBLISH.length - 2, `only ${k} set steps were exercised`);
});
await test('S1-R1 Fix 3: S1_UNSIGNED_V0 can never become live-eligible, whatever a caller claims', async () => {
  for (const claimed of [{ setHash: 'a'.repeat(64), signed: true, policy: 'S1_UNSIGNED_V0' }, { setHash: 'a'.repeat(64), signed: true, policy: 'S2_HUMAN_SIGNED_V1' },
    { setHash: 'a'.repeat(64), signed: false, policy: 'S1_UNSIGNED_V0' }]) assert.equal(liveEligibility(claimed).eligible, false);
  assert.deepEqual({ ...SIGNATURE_POLICY }, { version: 'S1_UNSIGNED_V0', humanSignatureRequired: false });
});

// ================================================================ S1-R2: WorkerStore special-file reads (runtime.lock, ledger.json, report.md)
// Each case replaces exactly one of the three names. A FIFO is always checked in its own process with a 15 s limit, so a
// blocking open shows up as a killed child, never as a hung suite; it is tried empty and holding a well-formed record (a
// reader that skipped the file-type check would accept that record). A device node cannot be created without root, so
// the device case redirects that one open(2) to /dev/null (a real character device, same flags) in this process.
const R2_CHILD = `
  import { closeSync, constants, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
  import { execFileSync } from 'node:child_process';
  import { WorkerStore } from './dist/limited-worker/store.js';
  const [kind, dir, target, preload, jobFile] = process.argv.slice(1);
  const fifo = (bytes) => {
    execFileSync('mkfifo', ['-m', '600', target]);
    if (!bytes) return;
    openSync(target, constants.O_RDONLY | constants.O_NONBLOCK); // held open: the FIFO keeps the bytes after the writer closes
    const w = openSync(target, constants.O_WRONLY); writeSync(w, bytes); closeSync(w);
  };
  const store = new WorkerStore(dir);
  let out;
  try {
    if (kind === 'release') {
      const release = store.lease(), mine = readFileSync(target);
      unlinkSync(target); fifo(preload ? mine : null);
      release(); out = { result: 'RELEASE_RETURNED' };
    } else {
      fifo(preload ? readFileSync(preload) : null);
      if (kind === 'lease') { store.lease(); out = { result: 'ACQUIRED' }; }
      if (kind === 'ledger') out = { result: store.read().jobs.length };
      if (kind === 'update') out = { result: store.update(() => 'WROTE') };
      if (kind === 'report') out = { result: store.reportIsValid(JSON.parse(readFileSync(jobFile, 'utf8'))) };
    }
  } catch (error) { out = { error: error.message }; }
  console.log(JSON.stringify(out));`;
async function fifoCase(kind, dir, target, { preload = '', job = '' } = {}) {
  const r = await child(R2_CHILD, [kind, dir, target, preload, job], { timeout: 15000 });
  assert.equal(r.signal, null, `${kind}: the read blocked on a FIFO (child killed after 15 s)`);
  assert.ok(lstatSync(target).isFIFO(), `${kind}: the FIFO was replaced`);
  rmSync(target);
  return JSON.parse(r.out.trim() || JSON.stringify({ exit: r.code, err: r.err.slice(-300) }));
}
const PIPE_SAFE = 16384; // stay within the smallest default FIFO buffer (macOS), so the preload write never blocks
function viaDevice(path, fn) {
  const original = fsModule.openSync;
  fsModule.openSync = function (p, ...rest) { return original.call(this, String(p) === path ? '/dev/null' : p, ...rest); };
  syncBuiltinESMExports();
  try { return fn(); } finally { fsModule.openSync = original; syncBuiltinESMExports(); }
}
const mksock = (path) => execFileSync('python3', ['-I', '-c',
  'import os, socket, sys; os.chdir(os.path.dirname(sys.argv[1])); socket.socket(socket.AF_UNIX).bind(os.path.basename(sys.argv[1]))', path]);
const put = (path, bytes, mode) => { rmSync(path, { recursive: true, force: true }); writeFileSync(path, bytes, { mode }); chmodSync(path, mode); };
const UNSAFE_MODES = [0o644, 0o640, 0o604, 0o660, 0o606, 0o666, 0o4600];
// Every non-FIFO special or unsafe form of `path`; `good` is a well-formed record, so only the file itself is at fault.
function* unsafeForms(dir, path, good, oversize) {
  const elsewhere = join(dir, `elsewhere-${randomUUID()}`); put(elsewhere, good, 0o600);
  rmSync(path, { recursive: true, force: true }); symlinkSync(elsewhere, path); yield 'symlink to a valid record';
  rmSync(path); mkdirSync(path, { mode: 0o700 }); yield 'directory';
  rmSync(path, { recursive: true }); mksock(path); yield 'socket';
  for (const mode of UNSAFE_MODES) { put(path, good, mode); yield `mode ${mode.toString(8)}`; }
  put(path, oversize, 0o600); yield 'oversize';
  rmSync(path); rmSync(elsewhere);
}
// Names and file types only (reading a FIFO or socket would block or fail).
const kinds = (root) => readdirSync(root).sort().map((name) => {
  const st = lstatSync(join(root, name));
  return [name, st.isFile() ? readFileSync(join(root, name)).toString('base64') : st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'link' : st.isFIFO() ? 'fifo' : st.isSocket() ? 'socket' : 'other'];
});

await test('S1-R2 runtime.lock: FIFO (empty or holding a valid stale record), symlink, directory, socket, device, unsafe mode or oversize lease is UNCERTAIN — no block, no takeover, release leaves it', async (dir) => {
  const store = new WorkerStore(sub(dir, 's')), file = join(store.directory, 'runtime.lock');
  const record = await staleLease(store.directory), good = readFileSync(file);
  // Regular owner-only files keep working: a stale 0600 or 0400 lease is taken over; the new lease is 0600.
  for (const mode of [0o600, 0o400]) {
    put(file, good, mode); const release = store.lease();
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).pid, process.pid); assert.equal(lstatSync(file).mode & 0o7777, 0o600);
    release(); assert.equal(existsSync(file), false);
  }
  for (const form of unsafeForms(dir, file, good, JSON.stringify({ ...record, pad: 'x'.repeat(600) }))) {
    const before = kinds(store.directory);
    refusedWith(() => store.lease(), 'WORKER_LEASE_UNCERTAIN');
    assert.deepEqual(kinds(store.directory), before, `${form}: nothing taken over, no token or temp left`);
  }
  put(file, good, 0o600);
  viaDevice(file, () => refusedWith(() => store.lease(), 'WORKER_LEASE_UNCERTAIN'));
  assert.deepEqual(readFileSync(file), good, 'device: the stale lease was not taken over');
  // Release: the holder's lease replaced by an unsafe form (a 0644 copy carries the holder's own nonce) is left in place.
  for (const [form, swap] of [['0644 copy of the holder\'s own lease', (mine) => put(file, mine, 0o644)], ['directory', () => { rmSync(file); mkdirSync(file); }],
    ['socket', () => { rmSync(file); mksock(file); }]]) {
    rmSync(file, { recursive: true, force: true });
    const release = store.lease(), mine = readFileSync(file); swap(mine);
    release(); assert.ok(existsSync(file), `release removed a ${form}`);
  }
  rmSync(file, { recursive: true, force: true });
  { const release = store.lease(), mine = readFileSync(file); viaDevice(file, () => release()); assert.deepEqual(readFileSync(file), mine, 'device: release removed the lease'); release(); }
  // FIFOs, each in a time-limited child.
  const preload = join(dir, 'stale-lease.json'); writeFileSync(preload, good);
  assert.deepEqual(await fifoCase('lease', store.directory, file), { error: 'WORKER_LEASE_UNCERTAIN' });
  assert.deepEqual(await fifoCase('lease', store.directory, file, { preload }), { error: 'WORKER_LEASE_UNCERTAIN' });
  assert.deepEqual(await fifoCase('release', store.directory, file), { result: 'RELEASE_RETURNED' });
  assert.deepEqual(await fifoCase('release', store.directory, file, { preload: '1' }), { result: 'RELEASE_RETURNED' });
  assert.deepEqual(kinds(store.directory), [], 'no lease, token or temp file left');
});
await test('S1-R2 runtime.lock: an unsafe lease blocks activation and execution before any ledger change or send', async (dir) => {
  const w = await world(dir); activate(w);
  const file = join(w.store.directory, 'runtime.lock'), ledger = join(w.store.directory, 'ledger.json');
  await staleLease(w.store.directory); chmodSync(file, 0o644);
  const before = readFileSync(ledger);
  await assert.rejects(w.runtime.execute(w.c), /WORKER_LEASE_UNCERTAIN/);
  assert.throws(() => activate(w), /WORKER_LEASE_UNCERTAIN/);
  assert.equal(w.calls, 0); assert.deepEqual(readFileSync(ledger), before); assert.equal(w.job().state, 'PREPARED');
  rmSync(file); await w.runtime.execute(w.c); assert.equal(w.calls, 1); assert.equal(w.store.read().jobs.length, 1);
});
await test('S1-R2 ledger.json: FIFO (empty or holding the valid ledger), symlink, directory, socket, device, unsafe mode or oversize ledger is INTEGRITY — never read as an empty ledger, never rewritten', async (dir) => {
  const w = await world(dir), file = join(w.store.directory, 'ledger.json'), lock = join(w.store.directory, 'write.lock');
  const good = readFileSync(file), jobs = w.store.read().jobs;
  assert.equal(lstatSync(file).mode & 0o7777, 0o600); assert.equal(jobs.length, 1);
  put(file, good, 0o400); assert.deepEqual(w.store.read().jobs, jobs, 'an owner-only 0400 ledger still reads');
  const refused = (form) => {
    refusedWith(() => w.store.read(), 'WORKER_STORAGE_INTEGRITY');
    refusedWith(() => w.store.update((d) => d.jobs.length), 'WORKER_STORAGE_INTEGRITY');
    refusedWith(() => w.store.create(w.c, w.clock.now()), 'WORKER_STORAGE_INTEGRITY');
    assert.equal(existsSync(lock), false, `${form}: write.lock left behind`);
  };
  const oversize = Buffer.alloc(16 * 1024 * 1024 + 1, 0x20);
  for (const form of unsafeForms(dir, file, good, oversize)) {
    const kind = lstatSync(file); refused(form);
    const after = lstatSync(file);
    assert.ok(after.ino === kind.ino && after.mode === kind.mode, `${form}: the ledger name was rewritten`);
  }
  put(file, good, 0o600);
  viaDevice(file, () => refused('device'));
  assert.deepEqual(readFileSync(file), good);
  // FIFOs in a time-limited child: read, and a write (update) that would replace the ledger with a fresh one.
  const preload = join(dir, 'ledger-copy.json'); writeFileSync(preload, good); assert.ok(good.length < PIPE_SAFE, `ledger ${good.length} bytes`);
  rmSync(file);
  assert.deepEqual(await fifoCase('ledger', w.store.directory, file), { error: 'WORKER_STORAGE_INTEGRITY' });
  assert.deepEqual(await fifoCase('ledger', w.store.directory, file, { preload }), { error: 'WORKER_STORAGE_INTEGRITY' });
  assert.deepEqual(await fifoCase('update', w.store.directory, file, { preload }), { error: 'WORKER_STORAGE_INTEGRITY' });
  assert.equal(existsSync(lock), false);
  // Restored: the same ledger, byte for byte; only a missing ledger (ENOENT) reads as new and empty.
  put(file, good, 0o600); assert.deepEqual(w.store.read().jobs, jobs);
  assert.deepEqual(new WorkerStore(sub(dir, 'fresh')).read().jobs, []);
});
await test('S1-R2 ledger.json: an unsafe ledger stops execution with zero sends; restored, the same job runs once (no new job)', async (dir) => {
  const w = await world(dir); activate(w);
  const file = join(w.store.directory, 'ledger.json'), good = readFileSync(file);
  for (const unsafe of [() => chmodSync(file, 0o644), () => { rmSync(file); mkdirSync(file); }]) {
    unsafe();
    await assert.rejects(w.runtime.execute(w.c), /WORKER_STORAGE_INTEGRITY/);
    assert.equal(w.calls, 0);
    put(file, good, 0o600);
  }
  assert.equal(w.job().state, 'PREPARED');
  await w.runtime.execute(w.c); assert.equal(w.calls, 1); assert.equal(w.store.read().jobs.length, 1);
});
await test('S1-R2 report.md: FIFO (empty or holding the exact report), symlink, directory, socket, device, unsafe mode or oversize report is invalid — the result is not consistent and nothing is re-sent', async (dir) => {
  const w = await world(dir); activate(w); await w.runtime.execute(w.c);
  const file = join(w.store.directory, w.c.outputKey, 'report.md'), good = readFileSync(file), job = w.job();
  assert.equal(w.calls, 1); assert.equal(job.state, 'COMPLETED'); assert.equal(lstatSync(file).mode & 0o7777, 0o600);
  assert.equal(w.store.reportIsValid(job), true); assert.equal(w.runtime.resultConsistency(w.c), true);
  put(file, good, 0o400); assert.equal(w.store.reportIsValid(job), true, 'an owner-only 0400 report is still valid');
  const invalid = (form) => {
    assert.equal(w.store.reportIsValid(job), false, form); assert.equal(w.runtime.resultConsistency(w.c), false, form);
  };
  for (const form of unsafeForms(dir, file, good, Buffer.alloc(65537, 0x20))) invalid(form);
  put(file, good, 0o600);
  viaDevice(file, () => invalid('device'));
  const jobFile = join(dir, 'job.json'), preload = join(dir, 'report-copy.md');
  writeFileSync(jobFile, JSON.stringify(job)); writeFileSync(preload, good); assert.ok(good.length < PIPE_SAFE);
  rmSync(file);
  assert.deepEqual(await fifoCase('report', w.store.directory, file, { job: jobFile }), { result: false });
  assert.deepEqual(await fifoCase('report', w.store.directory, file, { preload, job: jobFile }), { result: false });
  // An invalid report is not new work: the job stays COMPLETED and another execute sends nothing.
  mksock(file);
  try { await w.runtime.execute(w.c); } catch { /* refused either way */ }
  assert.equal(w.calls, 1); assert.equal(w.job().state, 'COMPLETED');
  rmSync(file); put(file, good, 0o600); assert.equal(w.store.reportIsValid(job), true); assert.equal(w.runtime.resultConsistency(w.c), true);
});

// ================================================================ S1-R3-A: critical governance reads (Controller store, invocation journal, Authority Archive)
// Each target is a file the execution path reads before a provider request: the run's Controller file, its R4L admission
// record, its invocation journal record and an Authority Archive record. A FIFO is again checked in a time-limited child,
// empty and holding the exact valid record.
const R3_CHILD = `
  import { closeSync, constants, openSync, readFileSync, writeSync } from 'node:fs';
  import { execFileSync } from 'node:child_process';
  import { FileControllerStore } from './dist/automation/durable-store.js';
  import { FileInvocationJournal } from './dist/automation/file-invocation-journal.js';
  import { openAuthorityArchiveReader } from './dist/automation/authority/file-archive.js';
  const [kind, root, target, preload, id] = process.argv.slice(1);
  execFileSync('mkfifo', ['-m', '600', target]);
  if (preload) {
    openSync(target, constants.O_RDONLY | constants.O_NONBLOCK); // held open: the FIFO keeps the bytes after the writer closes
    const w = openSync(target, constants.O_WRONLY); writeSync(w, readFileSync(preload)); closeSync(w);
  }
  const clock = { now: () => new Date().toISOString() };
  let out;
  try {
    if (kind === 'controller') out = { result: new FileControllerStore(root, clock).get(id)?.runId ?? null };
    if (kind === 'journal') out = { result: new FileInvocationJournal(root, clock).get(id)?.invocationId ?? null };
    if (kind === 'archive') { openAuthorityArchiveReader(root); out = { result: 'OPENED' }; }
  } catch (error) { out = { error: String(error.message) }; }
  console.log(JSON.stringify(out));`;
async function fifoRecord(t, preload = '') {
  const r = await child(R3_CHILD, [t.kind, t.root, t.path, preload, t.id ?? ''], { timeout: 15000 });
  assert.equal(r.signal, null, `${t.name}: the read blocked on a FIFO (child killed after 15 s)`);
  assert.ok(lstatSync(t.path).isFIFO(), `${t.name}: the FIFO was replaced`);
  rmSync(t.path);
  return JSON.parse(r.out.trim() || JSON.stringify({ exit: r.code, err: r.err.slice(-300) }));
}
const RECORD = /^[0-9a-f]{64}\.json$/;
const runFileOf = (w) => join(w.options.controllerStoreDirectory, storedRunFileName(w.c.runId));
const admissionFileOf = (w) => { const d = join(w.options.controllerStoreDirectory, 'changes'); return join(d, readdirSync(d).find((n) => RECORD.test(n))); };
const journalFileOf = (w) => join(w.options.journalDirectory, readdirSync(w.options.journalDirectory).find((n) => RECORD.test(n)));
const archiveFileOf = (w) => {
  const records = join(w.authority, 'records');
  return join(records, readdirSync(records, { recursive: true }).map(String).filter((n) => n.endsWith('.json')).sort()[0]);
};
async function governedFiles(dir) {
  const w = await world(dir); activate(w); await w.runtime.execute(w.c); assert.equal(w.calls, 1);
  const controller = w.options.controllerStoreDirectory, journal = w.options.journalDirectory;
  const invocationId = basename(journalFileOf(w)).slice(0, -'.json'.length);
  const controllerRead = () => new FileControllerStore(controller, w.clock).get(w.c.runId).runId;
  return {
    run: { name: 'Controller run file', kind: 'controller', root: controller, id: w.c.runId, max: 16 * 1024 * 1024,
      path: runFileOf(w), read: controllerRead, refused: /Unsafe controller storage file \(/ },
    admission: { name: 'R4L admission record', kind: 'controller', root: controller, id: w.c.runId, max: 1024 * 1024,
      path: admissionFileOf(w), read: controllerRead, refused: /Admission record is not a safe regular file \(/ },
    journal: { name: 'invocation journal record', kind: 'journal', root: journal, id: invocationId, max: 4 * 1024 * 1024,
      path: journalFileOf(w), read: () => new FileInvocationJournal(journal, w.clock).get(invocationId).invocationId,
      refused: /Invocation journal file is not a safe regular file \(/ },
    archive: { name: 'Authority Archive record', kind: 'archive', root: w.authority, max: 4 * 1024 * 1024,
      path: archiveFileOf(w), read: () => { openAuthorityArchiveReader(w.authority); return 'OPENED'; },
      refused: /A canonical authority record is (not a regular file|not safe to read \()/ },
  };
}
for (const which of ['run', 'admission', 'journal', 'archive']) {
  await test(`S1-R3-A ${which}: FIFO (empty or holding the exact record), symlink, directory, socket, device, unsafe mode, oversize, truncated, corrupted or empty record fails closed without blocking`, async (dir) => {
    const t = (await governedFiles(dir))[which], good = readFileSync(t.path), expected = t.read();
    assert.equal(lstatSync(t.path).mode & 0o7777, 0o600, `${t.name} is written 0600`);
    put(t.path, good, 0o400); assert.equal(t.read(), expected, 'an owner-only 0400 record still reads');
    for (const form of unsafeForms(dir, t.path, good, Buffer.alloc(t.max + 1, 0x20))) assert.throws(t.read, t.refused, form);
    put(t.path, good, 0o600);
    viaDevice(t.path, () => assert.throws(t.read, t.refused, 'device'));
    const flipped = good.toString('utf8').replace(/[0-9a-f](?=[0-9a-f]{20})/, (d) => (d === '0' ? '1' : '0'));
    for (const [form, bytes] of [['truncated', good.subarray(0, Math.floor(good.length / 2))], ['corrupted', Buffer.from(flipped)], ['empty', Buffer.alloc(0)]]) {
      put(t.path, bytes, 0o600); assert.throws(t.read, /./, form);
    }
    const copy = join(dir, 'record-copy'); writeFileSync(copy, good); assert.ok(good.length < PIPE_SAFE, `${t.name}: ${good.length} bytes`);
    rmSync(t.path);
    for (const preload of ['', copy]) assert.match((await fifoRecord(t, preload)).error ?? 'NO ERROR', t.refused, preload ? 'FIFO holding the record' : 'empty FIFO');
    put(t.path, good, 0o600); assert.equal(t.read(), expected);
  });
}
await test('S1-R3-A an unsafe or missing run, admission or archive record, or an unsafe record after the generation claim, stops execution with zero sends', async (dir) => {
  const cases = [
    ['before execution: run file 0644', 'before', (w) => chmodSync(runFileOf(w), 0o644)],
    ['before execution: run file missing', 'before', (w) => rmSync(runFileOf(w))],
    ['before execution: admission record 0644', 'before', (w) => chmodSync(admissionFileOf(w), 0o644)],
    ['before execution: admission record missing', 'before', (w) => rmSync(admissionFileOf(w))],
    ['before execution: archive record 0644', 'before', (w) => chmodSync(archiveFileOf(w), 0o644)],
    ['before execution: archive record missing', 'before', (w) => rmSync(archiveFileOf(w))],
    ['after the claim: run file 0644', 'claimed', (w) => chmodSync(runFileOf(w), 0o644)],
    ['after the claim: archive record 0644', 'claimed', (w) => chmodSync(archiveFileOf(w), 0o644)],
    ['after the claim: journal record 0644', 'claimed', (w) => chmodSync(journalFileOf(w), 0o644)],
    ['after the claim: journal record replaced by a symlink to itself', 'claimed', (w) => {
      const f = journalFileOf(w), copy = `${f}.copy`; writeFileSync(copy, readFileSync(f), { mode: 0o600 }); rmSync(f); symlinkSync(copy, f); }],
  ];
  for (const [i, [name, when, unsafe]] of cases.entries()) {
    const w = await world(sub(dir, `c${i}`)); activate(w);
    if (when === 'before') unsafe(w); else w.providerIO.ready = async () => unsafe(w);
    try { await w.runtime.execute(w.c); } catch { /* refused */ }
    assert.equal(w.calls, 0, name);
  }
});
await test('S1-R3-A the read is bounded: never more than maxBytes + 1 bytes, even when fstat under-reports a file that grows', async (dir) => {
  const path = join(dir, 'grows.json'); put(path, Buffer.alloc(1000, 0x20), 0o600);
  assert.equal(readRecordFile(path, 1000).status, 'READ');
  assert.deepEqual(readRecordFile(path, 999), { status: 'UNSAFE', problem: 'TOO_LARGE' });
  const original = { fstatSync: fsModule.fstatSync, readSync: fsModule.readSync };
  let bytes = 0;
  fsModule.fstatSync = function (...args) { const st = original.fstatSync.apply(this, args); return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { size: 0 }); };
  fsModule.readSync = function (...args) { const n = original.readSync.apply(this, args); bytes += n; return n; };
  syncBuiltinESMExports();
  let result;
  try { result = readRecordFile(path, 100); } finally { Object.assign(fsModule, original); syncBuiltinESMExports(); }
  assert.deepEqual(result, { status: 'UNSAFE', problem: 'TOO_LARGE' });
  assert.ok(bytes <= 101, `read ${bytes} bytes for a 100-byte bound`);
});

// ================================================================ S1-R3-B: a ledger lost after the store was used
const ledgerOf = (w) => join(w.store.directory, 'ledger.json');
const evidenceStore = (w, directory = w.store.directory) => new WorkerStore(directory, { initializationEvidence: limitedLedgerEvidence(w.options, w.clock) });
const observation = (w) => ({ id: randomUUID(), projectId: 'chief', at: w.clock.now(), kind: 'RUNTIME_START', interactionId: null, jobId: null,
  reason: null, evidenceClass: 'OFFLINE_SYNTHETIC', clientElapsedMs: null });
const usedEntries = (w) => readdirSync(w.store.directory).filter((n) => /^(activation-sets|[0-9a-f]{64})$/.test(n));
function refusedEverywhere(w, store, code) {
  refusedWith(() => store.read(), code);
  refusedWith(() => store.create(w.c, w.clock.now()), code);
  refusedWith(() => store.reserve(hash(w.c), 1, 'a'.repeat(64), w.clock.now(), true), code);
  refusedWith(() => store.observe(observation(w)), code);
  assert.equal(existsSync(ledgerOf(w)), false, 'a fresh ledger was written');
}
await test('S1-R3-B after activation, a missing ledger is refused for read, create, reserve, observe and execution; nothing rebuilds it', async (dir) => {
  const w = await world(dir); activate(w);
  const good = readFileSync(ledgerOf(w)); rmSync(ledgerOf(w));
  for (const store of [w.store, evidenceStore(w)]) refusedEverywhere(w, store, 'WORKER_LEDGER_MISSING_AFTER_INIT');
  await assert.rejects(w.runtime.execute(w.c), /WORKER_LEDGER_MISSING_AFTER_INIT/);
  assert.throws(() => activate(w), /WORKER_LEDGER_MISSING_AFTER_INIT/);
  assert.equal(w.calls, 0); assert.equal(existsSync(ledgerOf(w)), false);
  writeFileSync(ledgerOf(w), good, { mode: 0o600 }); await w.runtime.execute(w.c); assert.equal(w.calls, 1);
});
await test('S1-R3-B after a send, with the ACTIVATION_SET and reports removed too, the Controller evidence still refuses any new reservation or dispatch', async (dir) => {
  const w = await world(dir); activate(w); await w.runtime.execute(w.c); assert.equal(w.calls, 1);
  rmSync(ledgerOf(w)); for (const name of usedEntries(w)) rmSync(join(w.store.directory, name), { recursive: true });
  refusedEverywhere(w, evidenceStore(w), 'WORKER_LEDGER_MISSING_AFTER_INIT');
  await assert.rejects(w.runtime.execute(w.c), /WORKER_LEDGER_MISSING_AFTER_INIT/);
  assert.equal(w.calls, 1); assert.equal(existsSync(ledgerOf(w)), false);
  // Stated limit: a store given no evidence source sees only its own directory, which now holds no trace.
  assert.deepEqual(w.store.read().jobs, []);
});
await test('S1-R3-B a ledger lost after the generation claim stops the final send guard: no request is sent and nothing is rebuilt', async (dir) => {
  const w = await world(dir); activate(w);
  w.providerIO.ready = async () => { rmSync(ledgerOf(w)); };
  try { await w.runtime.execute(w.c); } catch { /* refused */ }
  assert.equal(w.calls, 0); assert.equal(existsSync(ledgerOf(w)), false);
});
await test('S1-R3-B a never-used store still initializes; Controller evidence counts only for the store identity it is bound to', async (dir) => {
  const w = await world(dir); activate(w);
  const other = evidenceStore(w, sub(dir, 'other-results'));
  assert.deepEqual(other.read().jobs, []); other.observe(observation(w));
  assert.equal(other.read().observations.length, 1, 'the first write initialized a new ledger');
  // Before activation the same store has no evidence yet (no reservation can exist before activation): it reads as new.
  const v = await world(sub(dir, 'v')); rmSync(ledgerOf(v));
  assert.deepEqual(evidenceStore(v).read().jobs, []);
});
await test('S1-R3-B evidence that cannot be read is not evidence of absence: the missing ledger is refused as UNVERIFIABLE', async (dir) => {
  const w = await world(dir); activate(w);
  rmSync(ledgerOf(w)); for (const name of usedEntries(w)) rmSync(join(w.store.directory, name), { recursive: true });
  chmodSync(runFileOf(w), 0o644);
  refusedEverywhere(w, evidenceStore(w), 'WORKER_LEDGER_MISSING_UNVERIFIABLE');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
