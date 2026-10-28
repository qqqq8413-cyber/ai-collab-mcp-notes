// M1 test harness (child process only): the real Host's live path on a given dist (M1-LIFT-P0: the repository build is LIVE_PILOT).
//
//   node lifted-host.mjs <patched dist dir> <scenario> <work dir>
//
// The parent test runs the `hold` scenario on a COPY of dist with only `EXE = 'LIVE_PILOT'` changed back to `'HOLD'`, and
// every other scenario on the repository build itself. Everything external is local and synthetic: a fake Anthropic TLS
// server on 127.0.0.1 (self-signed), a software P-256 "passkey", synthetic principals and a dummy API key. No real
// network, credential, account or paid call exists here. Prints one JSON line of facts for the parent to assert.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';

const [DIST, SCENARIO, WORK] = process.argv.slice(2);
const load = (path) => import(join(DIST, path));
const { EXE, MODEL, REPOSITORY, hash, maximumCost } = await load('limited-worker/contract.js');
// Only the `hold` scenario runs on the HOLD copy; every other scenario needs the LIVE_PILOT build.
if (SCENARIO !== 'serve') assert.equal(EXE, SCENARIO === 'hold' ? 'HOLD' : 'LIVE_PILOT');
const { startTrustedWorkspaceHost } = await load('intake/workspace-host.js');
const { parseTrustedWorkspaceHostConfig } = await load('intake/workspace-host-config.js');
const { createLiveRuntime } = await load('limited-worker/live-runtime.js');
const { createLimitedWorkerService } = await load('limited-worker/service.js');
const { WorkerStore } = await load('limited-worker/store.js');
const { limitedLedgerEvidence } = await load('limited-worker/composition.js');
const { agentTransports, nativeAnthropicTransport, unconfiguredLiveTransport, tariffFromMarkdown } = await load('limited-worker/transport.js');
const { REHEARSAL_PRICE_DOCUMENT } = await load('limited-worker/rehearsal.js');
const { loadApprover, workerClassHash, challengeOf, acceptanceHashOf } = await load('limited-worker/run-approval.js');
const { readGovernedModel } = await load('automation/read-model/governed-read-model.js');
const { draftRunDocuments } = await load('limited-worker/governance.js');
const { derivationOf } = await load('limited-worker/run-approval.js');
const { packetFor } = await load('limited-worker/contract.js');
const { openDirectAuthorityPreserver } = await load('automation/authority/preserver.js');

const HUMAN = 'human:m1-lifted-test', ARCHITECT = 'architect:m1-lifted-test', PROJECT = 'chief';
const DUMMY_KEY = 'sk-ant-api03-M1-DUMMY-TEST-KEY-NOT-REAL-0000';
const README = '# CHIEF\n\n說明文件。\n\n## 安裝\n\nnpm install\n';
const source = { text: README, sha: 'a'.repeat(40), path: 'README.md', bytes: Buffer.byteLength(README), hash: hash(Buffer.from(README)) };
const identity = () => ({ sha: 'c'.repeat(40), codeHash: hash('m1-lifted-code'), clean: true });
const MODEL_METADATA = { id: MODEL, type: 'model', lifecycle: 'active', max_input_tokens: 200000, max_tokens: 64000,
  capabilities: { thinking: { types: { disabled: { supported: true } } } } };
const facts = { scenario: SCENARIO };

// ------------------------------------------------------------------ fake provider (TLS, 127.0.0.1)
const certDir = join(WORK, 'tls'); mkdirSync(certDir, { recursive: true });
execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=localhost',
  '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem')], { stdio: 'ignore' });
const provider = { requests: [], delayMs: 0, messageId: `msg_m1_${randomUUID().slice(0, 8)}`, requestId: `req_m1_${randomUUID().slice(0, 8)}` };
const fake = createHttpsServer({ key: readFileSync(join(certDir, 'key.pem')), cert: readFileSync(join(certDir, 'cert.pem')) }, (req, res) => {
  let body = ''; req.on('data', (b) => { body += b; });
  req.on('end', () => {
    provider.requests.push({ method: req.method, path: req.url, apiKey: req.headers['x-api-key'] === DUMMY_KEY ? 'DUMMY' : req.headers['x-api-key'] ? 'OTHER' : 'NONE',
      body: body ? JSON.parse(body) : null });
    const send = (status, type, text, headers = {}) => { res.writeHead(status, { 'content-type': type, ...headers }); res.end(text); };
    if (req.method === 'GET' && req.url === '/docs/en/models/haiku-4-5/overview.md') return send(200, 'text/markdown', REHEARSAL_PRICE_DOCUMENT);
    if (req.method === 'GET' && req.url === `/v1/models/${MODEL}`) return send(200, 'application/json', JSON.stringify(MODEL_METADATA));
    if (req.method === 'POST' && req.url === '/v1/messages') {
      const reply = { id: provider.messageId, type: 'message', role: 'assistant', model: MODEL, stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text: '# README 審查（測試用假 Provider）\n\n- 第 1 行：標題 CHIEF。' }],
        usage: { input_tokens: 812, output_tokens: 64, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, service_tier: 'standard' } };
      setTimeout(() => send(200, 'application/json', JSON.stringify(reply), { 'request-id': provider.requestId }), provider.delayMs);
      return;
    }
    send(404, 'application/json', '{"type":"error"}');
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const fakePort = fake.address().port;
/** node:https replaced for this harness only: every fixed provider URL goes to the local fake, never the network. */
const requester = (target, options, callback) => httpsRequest({ host: '127.0.0.1', port: fakePort, path: target.pathname + target.search, method: options.method,
  headers: options.headers, signal: options.signal, agent: false, servername: 'localhost', ca: readFileSync(join(certDir, 'cert.pem')) }, callback);

// ------------------------------------------------------------------ software passkey (test authenticator)
const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const credentialId = randomBytes(16).toString('base64url');
const spki = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
let signCount = 0;
function assertion(challengeB64u, { origin, flags = 0x05, rpId = 'localhost', key = keys.privateKey, id = credentialId } = {}) {
  const authData = Buffer.concat([createHash('sha256').update(rpId).digest(), Buffer.from([flags]), Buffer.alloc(4)]);
  authData.writeUInt32BE(++signCount, 33);
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: challengeB64u, origin, crossOrigin: false }));
  const signature = sign('sha256', Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()]), { key, dsaEncoding: 'der' });
  return { credentialId: id, authenticatorData: authData.toString('base64url'), clientDataJSON: clientDataJSON.toString('base64url'), signature: signature.toString('base64url') };
}

// ------------------------------------------------------------------ the Host (as main.ts composes it)
const freePort = () => new Promise((resolve) => { const s = createNetServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
// `serve` (manual preview only) keeps the Host running on M1_SERVE_PORT after the setup steps.
const PORT = SCENARIO === 'serve' ? Number(process.env.M1_SERVE_PORT) : await freePort(), ORIGIN = `http://localhost:${PORT}`;
const at = (...p) => join(WORK, 'data', ...p);
const layout = { goals: at('goals'), registry: at('governance', 'registry'), controller: at('governance', 'controller'), authority: at('governance', 'authority'),
  results: at('worker', 'results'), journal: at('worker', 'journal') };
for (const p of [layout.goals, layout.registry, layout.controller, layout.authority, at('worker')]) mkdirSync(p, { recursive: true, mode: 0o700 });
const approverPath = join(WORK, 'approver.json');
let runtimeRef = null; // M1-R1: the live runtime the Host composed, for direct-call scenarios (as a same-process caller would use it).
let clock = { offsetMs: 0, now: () => new Date(Date.now() + clock.offsetMs).toISOString() };
async function startHost() {
  const config = parseTrustedWorkspaceHostConfig({ schemaVersion: 1,
    workspace: { schemaVersion: 1, dataDirectory: layout.goals, humanPrincipal: { principalRef: HUMAN }, projects: [{ projectId: PROJECT, displayName: 'CHIEF (M1 lifted test)', repository: REPOSITORY }] },
    governance: { changeRegistryDirectory: layout.registry, controllerStoreDirectory: layout.controller, repositories: [{ projectId: PROJECT, repository: REPOSITORY }],
      executionStatus: { authorityArchiveDirectory: layout.authority, architectPrincipalRef: ARCHITECT } } }, at());
  const roots = { controllerStoreDirectory: layout.controller, authorityArchiveDirectory: layout.authority, changeRegistryDirectory: layout.registry, architectPrincipalRef: ARCHITECT };
  const store = new WorkerStore(layout.results, { initializationEvidence: limitedLedgerEvidence(roots, clock) });
  const startup = store.lease(); try { store.recover(clock.now()); } finally { startup(); }
  const approver = existsSync(approverPath) ? loadApprover(approverPath, [process.getuid()]) : null;
  const id = identity();
  const workspace = await startTrustedWorkspaceHost({ config, uiDirectory: join(DIST, '..', 'workspace-ui'), port: PORT,
    limitedWorkerFactory: (ports) => {
      const runtime = createLiveRuntime({ ...roots, journalDirectory: layout.journal, resultDirectory: layout.results, clock, humanPrincipalRef: HUMAN,
        implementationSha: id.sha, workerCodeHash: id.codeHash, currentImplementation: identity,
        transport: agentTransports({ 'limited-readme-worker': nativeAnthropicTransport(() => DUMMY_KEY, { requester }),
          'claude-code-reader': unconfiguredLiveTransport('READER_REQUEST_BOUND_UNPROVEN') }),
        readSource: () => source, readGoal: (c) => {
          const g = ports.store.read(c.projectId).goals.find((x) => x.goalId === c.goalId);
          if (!g || g.submittedBy?.principalRef !== HUMAN) throw new Error('GOAL_BINDING_MISMATCH'); return g.text;
        } }, approver);
      runtimeRef = runtime;
      return createLimitedWorkerService({ goals: ports.store, governance: ports.governance, admission: ports.runAdmission, projects: [PROJECT], store,
        quote: () => tariffFromMarkdown(REHEARSAL_PRICE_DOCUMENT, clock.now()), source: () => source, identity, runtime, now: () => clock.now() });
    } });
  const base = `http://127.0.0.1:${PORT}`;
  // A restarted Host reuses the port; a pooled keep-alive socket to the closed one can reset once, so retry the GET.
  let first; for (let i = 0; ; i++) { try { first = await fetch(base + '/'); break; } catch (e) { if (i >= 3) throw e; await new Promise((r) => setTimeout(r, 100)); } }
  const cookie = first.headers.get('set-cookie').split(';')[0];
  const call = async (method, path, body, signal) => {
    facts.lastCall = `${method} ${path} ${body?.action ?? ''}`;
    const response = await fetch(base + '/api/v0' + path, { method, signal, headers: { cookie, ...(body ? { 'content-type': 'application/json', origin: base, 'x-chief-workspace': '1' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error?.code ?? String(response.status)), { status: response.status });
    return data;
  };
  return { workspace, call, close: () => workspace.close() };
}
// M1-R1: the standing ARCHITECT_CLASS_ACCEPTANCE the Human pins (synthetic source: the hash of a test decision text).
const acceptanceOf = (classHash, over = {}) => ({ schema: 'chief-architect-class-acceptance.v1', recordClass: 'ARCHITECT_CLASS_ACCEPTANCE',
  delegationRule: 'ARCHITECT_CLASS_DELEGATION_V1', architectPrincipalRef: ARCHITECT, agentId: 'limited-readme-worker', classSchema: 'chief-limited-worker-class.v1',
  classHash, implementationSha: identity().sha, acceptanceVersion: 1, supersedes: null,
  source: { kind: 'ARCHITECT_REVIEW_DECISION', reviewRef: 'M1-R1 lifted test', decisionSha256: hash('GPT-6: M1-R1 ACCEPTED (synthetic test decision)') },
  acceptedAt: '2026-10-27T00:00:00.000Z', ...over });
const writeApprover = (classHash, over = {}, acceptanceOver = {}) => {
  if (existsSync(approverPath)) unlinkSync(approverPath);
  const architectAcceptance = acceptanceOf(classHash, acceptanceOver);
  // An invalid acceptance is still written (the Host must refuse it when loading); it simply has no hash.
  try { facts.acceptanceHash = acceptanceHashOf(architectAcceptance); } catch { facts.acceptanceHash = null; }
  writeFileSync(approverPath, JSON.stringify({ schemaVersion: 1, kind: 'CHIEF_LIVE_RUN_APPROVER', policy: 'M1_PASSKEY_RUN_V1', humanPrincipalRef: HUMAN,
    passkey: { rpId: 'localhost', origins: [ORIGIN], credentialId, publicKeySpki: spki, algorithm: 'ES256' },
    architectAcceptance, approvalValiditySeconds: 600, ...over }), { mode: 0o644 });
  chmodSync(approverPath, 0o644);
};
const submit = async (call, text, agentId = 'limited-readme-worker') => {
  const goal = await call('POST', `/projects/${PROJECT}/goals`, { text });
  const view = await call('POST', `/projects/${PROJECT}/limited-worker`, { requestId: randomUUID(), goalId: goal.goal.goalId, agentId });
  return view.jobs.find((j) => j.contract.goalId === goal.goal.goalId);
};
const act = (call, job, body, signal) => call('POST', `/projects/${PROJECT}/limited-worker/${job.id}/actions`, { requestId: randomUUID(), ...body }, signal);
const refusal = async (promise) => { try { await promise; return 'NO_REFUSAL'; } catch (e) { return e.message; } };
const messages = () => provider.requests.filter((r) => r.path === '/v1/messages');
const allFiles = (dir) => readdirSync(dir, { recursive: true }).map(String).map((p) => join(dir, p)).filter((p) => statSync(p).isFile());
const archived = () => readGovernedModel({ controllerStoreDirectory: layout.controller, authorityArchiveDirectory: layout.authority, changeRegistryDirectory: layout.registry }, clock).authority;

// ------------------------------------------------------------------ scenarios
let host = await startHost();
try {
  // A first plan (no approver yet) gives the Architect-accepted class hash; the Human then pins it and restarts the Host.
  const job = await submit(host.call, '請用繁體中文說明這份 README 的結構');
  facts.classHash = workerClassHash(job.contract);
  facts.noApprover = await refusal(act(host.call, job, { action: 'REQUEST_APPROVAL', approval: { maxReservationMicroUsd: job.maximumReservationMicroUsd } }));
  await host.close();
  writeApprover(SCENARIO === 'class-not-accepted' ? 'f'.repeat(64) : facts.classHash);
  host = await startHost();
  let view = await host.call('GET', `/projects/${PROJECT}/limited-worker`);
  const card = view.jobs.find((j) => j.id === job.id);
  facts.preview = card.approvalPreview; facts.status = card.liveApproval; facts.execution = view.execution; facts.agentAvailability = view.agentAvailability;
  facts.readerPlan = await refusal(submit(host.call, '用 Claude Code 讀 README', 'claude-code-reader'));
  facts.noPasskeyStart = await refusal(act(host.call, job, { action: 'START', approval: { maxReservationMicroUsd: job.maximumReservationMicroUsd } }));
  facts.wrongAmount = await refusal(act(host.call, job, { action: 'REQUEST_APPROVAL', approval: { maxReservationMicroUsd: job.maximumReservationMicroUsd - 1 } }));
  if (SCENARIO === 'serve') { console.error(`SERVING ${ORIGIN} EXE=${EXE}`); await new Promise(() => {}); }
  if (SCENARIO === 'hold') {
    // EXE HOLD (the real build): the Human sees the run but neither approval nor START writes, verifies or sends anything.
    const any = assertion(Buffer.alloc(32, 1).toString('base64url'), { origin: ORIGIN });
    facts.hold = { request: await refusal(act(host.call, job, { action: 'REQUEST_APPROVAL', approval: { maxReservationMicroUsd: job.maximumReservationMicroUsd } })),
      start: await refusal(act(host.call, job, { action: 'START', approval: { maxReservationMicroUsd: job.maximumReservationMicroUsd }, passkey: any })) };
    const after = (await host.call('GET', `/projects/${PROJECT}/limited-worker`)).jobs.find((j) => j.id === job.id);
    facts.holdJob = { state: after.state, approvalRequest: after.approvalRequest ?? null, approval: after.approval ?? null, reserved: after.reservedMicroUsd,
      events: after.events.map((e) => e.kind), driver: after.driver.state };
    // M1-R1: called directly (not through the service), the runtime itself refuses EXE_HOLD before any write, even
    // for a fully valid candidate (accepted class and SHA, pinned key) and whatever the environment says.
    facts.holdDirect = { request: await refusal((async () => runtimeRef.requestApproval(job.contract, job.maximumReservationMicroUsd))()),
      execute: await refusal(runtimeRef.execute(job.contract, any)), envSeen: ['EXE', 'CHIEF_EXE', 'CHIEF_LIMITED_EXE'].filter((k) => process.env[k] === 'LIVE_PILOT') };
    facts.holdArchive = archived().length; facts.holdRecords = existsSync(join(layout.results, 'm1-approvals'));
    facts.holdSets = existsSync(join(layout.results, 'activation-sets'));
  } else if (SCENARIO === 'class-not-accepted') {
    facts.request = await refusal(act(host.call, job, { action: 'REQUEST_APPROVAL', approval: { maxReservationMicroUsd: job.maximumReservationMicroUsd } }));
  } else if (SCENARIO === 'substitution') {
    // M1-R1: the Human approved a run under acceptance v1; any later change of the pinned acceptance (its source, its
    // version, the accepted SHA or the Architect principal) refuses before anything is preserved or sent.
    const request = () => act(host.call, job, { action: 'REQUEST_APPROVAL', approval: { maxReservationMicroUsd: job.maximumReservationMicroUsd } });
    view = await request();
    const pending = view.jobs.find((j) => j.id === job.id).liveApproval.pending;
    const start = () => act(host.call, job, { action: 'START', approval: { maxReservationMicroUsd: job.maximumReservationMicroUsd }, passkey: assertion(pending.challenge, { origin: ORIGIN }) });
    const v1 = facts.acceptanceHash, swap = async (over, acceptanceOver) => { await host.close(); writeApprover(facts.classHash, over, acceptanceOver); host = await startHost(); };
    await swap({}, { source: { kind: 'ARCHITECT_REVIEW_DECISION', reviewRef: 'M1-R1 lifted test', decisionSha256: hash('a different decision text') } });
    facts.sourceSubstituted = { acceptanceChanged: facts.acceptanceHash !== v1, start: await refusal(start()) };
    await swap({}, { acceptanceVersion: 2, supersedes: v1 });
    facts.versionSuperseded = { acceptanceChanged: facts.acceptanceHash !== v1, start: await refusal(start()) };
    await swap({}, { implementationSha: 'd'.repeat(40) });
    facts.otherSha = { start: await refusal(start()), request: await refusal(request()) };
    await swap({}, { architectPrincipalRef: 'architect:someone-else' });
    facts.otherArchitect = { start: await refusal(start()), request: await refusal(request()) };
    await swap({}, { classSchema: 'chief-limited-worker-class.v2' }).catch((e) => { facts.otherClassSchema = e.message; });
    facts.afterSubstitution = { archive: archived().length, records: existsSync(join(layout.results, 'm1-approvals')), sets: existsSync(join(layout.results, 'activation-sets')),
      messages: messages().length, state: (await host.call('GET', `/projects/${PROJECT}/limited-worker`).catch(() => null))?.jobs.find((j) => j.id === job.id)?.state ?? null };
    // Restoring exactly v1 makes the very same approval valid again: the refusals above were the substitutions, nothing else.
    await host.close().catch(() => {}); writeApprover(facts.classHash); host = await startHost();
    facts.restored = { acceptanceIsV1: facts.acceptanceHash === v1, state: (await start()).jobs.find((j) => j.id === job.id).state, messages: messages().length };
  } else if (SCENARIO === 'only-approved') {
    // M1-R1: with EXE lifted (formal enablement), only the run the Human approved with the passkey can execute.
    const max = job.maximumReservationMicroUsd;
    view = await act(host.call, job, { action: 'REQUEST_APPROVAL', approval: { maxReservationMicroUsd: max } });
    const pendingA = view.jobs.find((j) => j.id === job.id).liveApproval.pending;
    const assertionA = assertion(pendingA.challenge, { origin: ORIGIN });
    facts.runA = (await act(host.call, job, { action: 'START', approval: { maxReservationMicroUsd: max }, passkey: assertionA })).jobs.find((j) => j.id === job.id).state;
    const b = await submit(host.call, '第二個任務：README 的安裝步驟');
    const startB = (passkey) => act(host.call, b, { action: 'START', approval: { maxReservationMicroUsd: max }, ...(passkey ? { passkey } : {}) });
    facts.runB = { notRequested: await refusal(startB(assertionA)) };
    await act(host.call, b, { action: 'REQUEST_APPROVAL', approval: { maxReservationMicroUsd: max } });
    facts.runB.noPasskey = await refusal(startB());
    facts.runB.replayA = await refusal(startB(assertionA));
    // A same-account writer copies run A's consumed approval record under run B's name: not B's approval.
    const records = join(layout.results, 'm1-approvals'), copied = join(records, `${b.id}.json`);
    writeFileSync(copied, readFileSync(join(records, `${job.id}.json`)), { mode: 0o600 });
    facts.runB.copiedRecord = await refusal(startB(assertionA));
    unlinkSync(copied);
    // Called directly (not through the service) the runtime asks for the passkey too.
    facts.runB.direct = await refusal(runtimeRef.execute(b.contract));
    // A same-account writer archives a correctly derived packet and two grants for run C without any Human approval:
    // archived documents alone never run anything (no consumed approval, no signed set).
    const c = await submit(host.call, '第三個任務：README 的標題');
    const approver = loadApprover(approverPath, [process.getuid()]);
    const sliceId = (await host.call('GET', `/projects/${PROJECT}/limited-worker`)).jobs.find((j) => j.id === c.id).driver.change.changeId;
    const now = clock.now(), docs = draftRunDocuments(c.contract, packetFor(c.contract, sliceId), { architectPrincipalRef: ARCHITECT, humanPrincipalRef: HUMAN,
      issuedAt: now, expiresAt: new Date(Date.parse(now) + 600000).toISOString(), nonce: randomUUID(), derivation: derivationOf(approver) });
    const preserver = openDirectAuthorityPreserver(layout.authority); for (const d of docs) preserver.preserve(d);
    facts.runC = { planted: archived().filter((d) => d.ref.authorityId === docs[0].authorityId).map((d) => d.recordClass),
      start: await refusal(act(host.call, c, { action: 'START', approval: { maxReservationMicroUsd: max }, passkey: assertionA })),
      direct: await refusal(runtimeRef.execute(c.contract)), state: (await host.call('GET', `/projects/${PROJECT}/limited-worker`)).jobs.find((j) => j.id === c.id).state };
    const after = (await host.call('GET', `/projects/${PROJECT}/limited-worker`)).jobs;
    facts.states = Object.fromEntries([['A', job.id], ['B', b.id], ['C', c.id]].map(([k, id]) => [k, after.find((j) => j.id === id).state]));
    facts.consumed = readdirSync(records).sort(); facts.expectedConsumed = [`${job.id}.json`];
  } else {
    view = await act(host.call, job, { action: 'REQUEST_APPROVAL', approval: { maxReservationMicroUsd: job.maximumReservationMicroUsd } });
    const pending = view.jobs.find((j) => j.id === job.id).liveApproval.pending;
    facts.pending = { rpId: pending.rpId, credentialMatches: pending.credentialId === credentialId, timeoutMs: pending.timeoutMs, payload: pending.payload,
      challengeMatches: challengeOf(pending.payload).toString('base64url') === pending.challenge };
    const approve = (over = {}) => ({ action: 'START', approval: { maxReservationMicroUsd: job.maximumReservationMicroUsd }, passkey: assertion(pending.challenge, { origin: ORIGIN, ...over }) });
    if (SCENARIO === 'tampered') {
      // Each wrong assertion is refused before anything is preserved; the archive stays empty and nothing is sent.
      const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
      facts.tampered = {
        otherChallenge: await refusal(act(host.call, job, { ...approve(), passkey: assertion(Buffer.alloc(32, 7).toString('base64url'), { origin: ORIGIN }) })),
        otherOrigin: await refusal(act(host.call, job, approve({ origin: 'http://localhost:1' }))),
        otherRpId: await refusal(act(host.call, job, approve({ rpId: 'example.com' }))),
        notVerified: await refusal(act(host.call, job, approve({ flags: 0x01 }))),
        notPresent: await refusal(act(host.call, job, approve({ flags: 0x04 }))),
        otherKey: await refusal(act(host.call, job, approve({ key: other }))),
        otherCredential: await refusal(act(host.call, job, approve({ id: randomBytes(16).toString('base64url') }))) };
      facts.archivedAfterTampered = archived().length; facts.recordsAfterTampered = existsSync(join(layout.results, 'm1-approvals'));
      clock.offsetMs = 11 * 60_000;
      facts.expired = await refusal(act(host.call, job, approve()));
      clock.offsetMs = 0;
    } else if (SCENARIO === 'disconnect') {
      provider.delayMs = 1500;
      const abort = new AbortController(); setTimeout(() => abort.abort(), 300);
      facts.clientAborted = await refusal(act(host.call, job, approve(), abort.signal));
      let state = 'RUNNING';
      for (let i = 0; i < 40 && !['COMPLETED', 'UNCERTAIN', 'BLOCKED'].includes(state); i++) {
        await new Promise((r) => setTimeout(r, 150));
        state = (await host.call('GET', `/projects/${PROJECT}/limited-worker`)).jobs.find((j) => j.id === job.id).state;
      }
      facts.stateAfterDisconnect = state;
    } else {
      view = await act(host.call, job, approve());
      const done = view.jobs.find((j) => j.id === job.id);
      facts.done = { state: done.state, effectiveState: done.effectiveState, resultApplied: done.resultApplied, driver: done.driver.state,
        invocations: done.invocations.map((i) => i.state), report: done.report, usage: done.usage, actualCostMicroUsd: done.actualCostMicroUsd,
        providerMessageId: done.providerMessageId, providerRequestId: done.providerRequestId, providerEndpoint: done.providerEndpoint,
        modelAccountAvailability: done.modelAccountAvailability, reserved: done.reservedMicroUsd, max: maximumCost(done.contract),
        approval: done.approval, events: done.events.map((e) => e.kind) };
      facts.again = await refusal(act(host.call, job, approve()));
      // The same assertion cannot approve another run: its challenge names this run only.
      const second = await submit(host.call, '第二個任務：README 的安裝步驟');
      await act(host.call, second, { action: 'REQUEST_APPROVAL', approval: { maxReservationMicroUsd: second.maximumReservationMicroUsd } });
      facts.replayOnOtherRun = await refusal(act(host.call, second, { action: 'START', approval: { maxReservationMicroUsd: second.maximumReservationMicroUsd },
        passkey: assertion(pending.challenge, { origin: ORIGIN }) }));
      const docs = archived();
      facts.archive = docs.map((d) => ({ kind: d.ref.kind, issuer: d.issuer, authorityId: d.ref.authorityId, recordClass: d.recordClass,
        recordHash: d.ref.recordHash, ...(d.derivation ? { derivation: d.derivation } : {}) }));
      const sets = allFiles(join(layout.results, 'activation-sets')).map((p) => JSON.parse(readFileSync(p, 'utf8')));
      facts.sets = sets.map((s) => ({ policy: s.set.signaturePolicy, setHash: s.setHash, attestations: s.set.attestations.length }));
      const records = readdirSync(join(layout.results, 'm1-approvals'));
      facts.records = records.map((name) => ({ name, mode: (statSync(join(layout.results, 'm1-approvals', name)).mode & 0o777).toString(8),
        payloadSetHash: JSON.parse(readFileSync(join(layout.results, 'm1-approvals', name), 'utf8')).payload.setHash }));
      facts.keyInFiles = allFiles(at()).filter((p) => readFileSync(p).includes(DUMMY_KEY)).length;
      await host.close();
      host = await startHost();
      const restarted = (await host.call('GET', `/projects/${PROJECT}/limited-worker`)).jobs.find((j) => j.id === job.id);
      facts.restarted = { state: restarted.state, resultApplied: restarted.resultApplied, invocations: restarted.invocations.map((i) => i.state), report: restarted.report };
      facts.afterRestart = await refusal(act(host.call, job, approve()));
    }
  }
} catch (error) { facts.error = String(error?.stack ?? error) + " cause=" + String(error?.cause?.stack ?? error?.cause ?? ""); }
finally {
  facts.provider = { messages: messages().length, models: provider.requests.filter((r) => r.path.startsWith('/v1/models/')).length,
    price: provider.requests.filter((r) => r.path.endsWith('overview.md')).length, other: provider.requests.filter((r) => !/^\/(v1\/messages|v1\/models\/|docs\/)/.test(r.path)).length,
    apiKeys: [...new Set(provider.requests.filter((r) => r.path.startsWith('/v1/')).map((r) => r.apiKey))],
    bodies: messages().map((r) => ({ model: r.body.model, max_tokens: r.body.max_tokens, stream: r.body.stream, thinking: r.body.thinking, tools: r.body.tools ?? null, service_tier: r.body.service_tier })) };
  await host.close().catch(() => {}); fake.close();
  process.stdout.write(JSON.stringify(facts) + '\n');
  process.exit(0);
}
