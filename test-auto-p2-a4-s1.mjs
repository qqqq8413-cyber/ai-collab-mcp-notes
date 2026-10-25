import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync,
  symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorkspaceConfig } from './dist/workspace/config.js';
import { createGoalChangeBridge } from './dist/intake/goal-change-bridge.js';
import { createGoalRunAdmissionBridge } from './dist/intake/goal-run-admission-bridge.js';
import { openGovernedActivationCore } from './dist/automation/activation-core.js';
import { openDirectAuthorityPreserver } from './dist/automation/authority/preserver.js';
import { parseAuthorityDocument } from './dist/automation/authority/document.js';
import { readGovernedModel } from './dist/automation/read-model/governed-read-model.js';
import { AutomationController } from './dist/automation/controller.js';
import { FileControllerStore } from './dist/automation/durable-store.js';
import { composeLimitedWorker } from './dist/limited-worker/composition.js';
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
async function test(name, fn) {
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
async function world(dir, { preserveIssued } = {}) {
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
    liveCallGrant: live, limitedGrant: limited, readSource: () => source, readGoal: () => g.text };
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

// ---------------------------------------------------------------- separate processes
function child(script, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', script, ...args], { cwd: ROOT });
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
await test('S1-B power-loss residues: a leftover temp file is never a set; truncated, altered, symlinked, unsafe or missing sets refuse', async (dir) => {
  const w = await world(dir); activate(w);
  const [name] = w.setFiles(), path = join(w.setDir, name), runDir = join(path, '..'), good = readFileSync(path);
  writeFileSync(join(runDir, `.${randomUUID()}.tmp`), good.subarray(0, 20), { mode: 0o600 });
  verifyActivationSet(w.store.directory, w.setInput());
  for (const bad of [good.subarray(0, 40), Buffer.from(good.toString().replace(/"runId":"[^"]+"/, '"runId":"run-other"')), Buffer.alloc(0)]) {
    writeFileSync(path, bad); refusedWith(() => verifyActivationSet(w.store.directory, w.setInput()), 'ACTIVATION_SET_CORRUPT');
  }
  unlinkSync(path); const copy = join(dir, 'copy.json'); writeFileSync(copy, good); symlinkSync(copy, path);
  refusedWith(() => verifyActivationSet(w.store.directory, w.setInput()), 'ACTIVATION_SET_CORRUPT');
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
