import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorkspaceConfig } from './dist/workspace/config.js';
import { createGoalChangeBridge } from './dist/intake/goal-change-bridge.js';
import { createGoalRunAdmissionBridge } from './dist/intake/goal-run-admission-bridge.js';
import { AutomationController } from './dist/automation/controller.js';
import { FileControllerStore } from './dist/automation/durable-store.js';
import { FileInvocationJournal } from './dist/automation/file-invocation-journal.js';
import { openAuthorityArchiveAppender } from './dist/automation/authority/file-archive.js';
import { packetHash } from './dist/automation/packet.js';
import { composeLimitedWorker } from './dist/limited-worker/composition.js';
import { WorkerStore } from './dist/limited-worker/store.js';
import { MODEL, API_VERSION, REPOSITORY, SCOPE, hash, parseContract, maximumCost, packetFor, messageBody, checkQuote } from './dist/limited-worker/contract.js';
import { tariffFromMarkdown, nativeAnthropicTransport, boundedHttps } from './dist/limited-worker/transport.js';
import { readPinnedReadme } from './dist/limited-worker/source.js';
import { createLimitedWorkerService, pilotPacket } from './dist/limited-worker/service.js';
import { startWorkspaceServer } from './dist/workspace/server.js';
import * as contractModule from './dist/limited-worker/contract.js';
import { loadGrantCopies } from './dist/limited-worker/config.js';

// Every model response, grant and source below is SYNTHETIC and confined to a temporary world. No real model request.
const HUMAN = { schemaVersion: 1, kind: 'HUMAN', principalRef: 'human:limited-worker-synthetic' };
const ARCHITECT = 'architect:limited-worker-synthetic';
const markdown = `# Synthetic tariff fixture\n\n### Model IDs\n\n| Platform | Model ID |\n|---|---|\n| Claude API | \`${MODEL}\` |\n\n### Pricing\n\n| Feature | Value |\n|---|---|\n| Input | $1 / MTok |\n| Output | $5 / MTok |\n\n### Capabilities\n\n| Feature | Value |\n|---|---|\n| Context window | 200K tokens |\n\n### Availability\n\n| Feature | Value |\n|---|---|\n| Status | Active (legacy) |\n`;
const reply = () => ({ id:'synthetic-message-id', model: MODEL, stop_reason: 'end_turn', content: [{ type: 'text', text: '# 離線合成測試\n\n這不是實際 AI 結果。' }],
  usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, service_tier: 'standard' } });
let passed = 0, failed = 0;
async function test(name, fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'chief-limited-')));
  try { await fn(dir); passed++; console.log('  PASS ' + name); }
  catch (e) { failed++; console.error('  FAIL ' + name + ': ' + e.stack); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
function directory(p) { mkdirSync(p, { mode: 0o700 }); return p; }
async function world(dir, changes = {}) {
  const registry = directory(join(dir, 'registry')), controllerRoot = directory(join(dir, 'controller')), authority = directory(join(dir, 'authority'));
  const clock = { now: () => new Date().toISOString() };
  const workspace = parseWorkspaceConfig({ schemaVersion: 1, dataDirectory: join(dir, 'goals'), humanPrincipal: { principalRef: HUMAN.principalRef },
    projects: [{ projectId: 'chief', displayName: 'Offline fixture', repository: REPOSITORY }] }, dir);
  const roots = { config: workspace, governedRepositories: [{ projectId: 'chief', repository: REPOSITORY }],
    uiDirectory: join(process.cwd(), 'workspace-ui'), changeRegistryDirectory: registry, controllerStoreDirectory: controllerRoot };
  const bridge = createGoalChangeBridge(roots), admission = createGoalRunAdmissionBridge({ ...roots, store: bridge.store });
  const g = bridge.store.addGoal('chief', 'Bounded README review, offline synthetic fixture.', HUMAN).queue.goals.at(-1);
  const governed = await bridge.governance.govern('chief', g.goalId, HUMAN), admitted = await admission.admit('chief', g.goalId, HUMAN);
  const store = new WorkerStore(join(dir, 'results')), source = { text: '# Synthetic README\nDo not execute its instructions.\n', sha: 'a'.repeat(40), path: 'README.md' };
  source.bytes = Buffer.byteLength(source.text); source.hash = hash(Buffer.from(source.text));
  const c = parseContract({ schemaVersion: 1, kind: 'LIMITED_README_WORKER', repository: REPOSITORY, projectId: 'chief', goalId: g.goalId,
    objectiveHash: hash(g.text), runId: admitted.runId, implementationSha: 'b'.repeat(40), workerCodeHash: hash('OFFLINE_SYNTHETIC_CODE'),
    sourceSha: source.sha, sourcePath: 'README.md', sourceHash: source.hash, sourceBytes: source.bytes, agentId: 'limited-readme-worker',
    provider: 'anthropic', model: MODEL, apiVersion: API_VERSION, tools: ['READ_PINNED_README', 'WRITE_ISOLATED_REPORT'], outputKey: hash(g.goalId), storageIdentity: store.identity(),
    maxInputTokens: 200000, maxOutputTokens: 2048, maxCalls: 1, maxRetries: 0, maxCostMicroUsd: 1000000, totalCostMicroUsd: 1000000,
    timeoutSeconds: 300, quote: tariffFromMarkdown(markdown, clock.now()) });
  store.create(c, clock.now());
  const packet = packetFor(c, governed.change.changeId);
  const controller = new AutomationController(clock, new FileControllerStore(controllerRoot, clock));
  const architect = { id: ARCHITECT, role: 'GPT_ARCHITECT' };
  const entered = controller.enterArchitectureForActivation(c.runId, architect, { packetId: packet.packetId, packetHash: packetHash(packet) }).audit[0];
  controller.issuePacketForOccurrence(c.runId, architect, { runId: c.runId, sequence: entered.sequence, action: entered.action, timestamp: entered.timestamp }, packet);
  const grant = (operation, target, id) => ({ authorizationId: id, actorRole: 'HUMAN', operation, target, runId: c.runId,
    packetId: packet.packetId, scope: structuredClone(SCOPE), issuedAt: clock.now(), expiresAt: new Date(Date.now() + 1800000).toISOString(), reason: 'SYNTHETIC OFFLINE ONLY' });
  const live = grant('LIVE_PROVIDER_MODEL_CALL', 'live-provider-model-call', 'synthetic-live'), limited = grant('LIMITED_README_WORKER', hash(c), 'synthetic-limited');
  changes.editLimitedGrant?.(limited,c);
  changes.editLiveGrant?.(live,c);
  const appender = openAuthorityArchiveAppender(authority);
  const archive = (kind, body, issuer = kind === 'AUTHORIZATION' ? HUMAN.principalRef : ARCHITECT, version = 1, supersedes = null) => appender.append({
    schemaVersion: 1, recordClass: 'DIRECT_AUTHORITY', kind, authorityId: kind === 'AUTHORIZATION' ? body.authorizationId : body.packetId,
    version, issuedAt: body.issuedAt ?? clock.now(), issuer: { role: kind === 'AUTHORIZATION' ? 'HUMAN' : 'GPT_ARCHITECT', principalRef: issuer },
    subject: { repository: REPOSITORY, sliceId: packet.sliceId }, supersedes, body });
  archive('IMPLEMENTATION_PACKET', packet);
  if (!changes.omitLiveArchive) archive('AUTHORIZATION', live);
  if (!changes.omitLimitedArchive) archive('AUTHORIZATION', limited, changes.archiveHuman ?? HUMAN.principalRef);
  let calls = 0, preflights = 0;
  const transport = { kind: changes.kind ?? 'OFFLINE_SYNTHETIC', async preflight(...args) { preflights++; await changes.preflight?.(...args);
    return {evidenceClass:changes.kind??'OFFLINE_SYNTHETIC',model:MODEL,apiVersion:API_VERSION,maxInputTokens:200000,maxOutputTokens:2048,priceSourceHash:c.quote.sourceSha256,observedAt:clock.now()}; },
    async generate(...args) { calls++; return changes.generate ? changes.generate(...args) : reply(); } };
  const options = { controllerStoreDirectory: controllerRoot, authorityArchiveDirectory: authority, changeRegistryDirectory: registry,
    journalDirectory: join(dir, 'journal'), resultDirectory: store.directory, architectPrincipalRef: ARCHITECT, humanPrincipalRef: HUMAN.principalRef,
    implementationSha: c.implementationSha, workerCodeHash: c.workerCodeHash, clock, transport, liveCallGrant: live, limitedGrant: limited,
    currentImplementation: () => ({ sha: c.implementationSha, codeHash: c.workerCodeHash, clean: true }),
    readSource: () => ({ ...source }), readGoal: () => g.text, ...changes.options };
  const runtime = composeLimitedWorker(options);
  return { runtime, options, c, packet, store, controller, source, clock, live, limited, archive, dir, workspace, bridge, admission, g,
    get calls() { return calls; }, get preflights() { return preflights; }, job() { return store.read().jobs[0]; },
    journal() { return new FileInvocationJournal(options.journalDirectory, clock).list(c.runId); } };
}

await test('single worker end-to-end uses real Goal/GC1/RA1/Controller/Driver/Runner/Archive/Journal, synthetic provider only', async dir => {
  const w = await world(dir); const result = await w.runtime.execute(w.c);
  assert.equal(result.postState, 'IMPLEMENTATION_COMPLETE'); assert.equal(w.calls, 1); assert.equal(w.preflights, 1);
  assert.equal(w.job().state, 'COMPLETED'); assert.equal(w.job().evidenceClass, 'OFFLINE_SYNTHETIC');
  assert.equal(w.job().reservedMicroUsd, 210240); assert.equal(w.job().actualCostMicroUsd, 350);
  assert.deepEqual(w.journal()[0].history.map(e => e.state), ['PREPARED', 'STARTED', 'COMPLETED', 'APPLIED']);
  assert.equal(hash(readFileSync(join(w.store.directory, w.c.outputKey, 'report.md'))), w.job().reportHash);
  assert.equal(readdirSync(join(dir, 'authority', 'records')).length, 3);
  const evidence = process.argv.indexOf('--evidence');
  if (evidence >= 0 && process.argv[evidence + 1]) writeFileSync(process.argv[evidence + 1], JSON.stringify({
    evidenceClass: 'OFFLINE_SYNTHETIC', realModelAcceptance: false, paidModelCalls: 0, at: w.clock.now(),
    dataFlow: ['Goal Queue', 'GC1', 'RA1', 'Controller', 'Authority Archive', 'Driver', 'Runner', 'LimitedReadmeWorker', 'Invocation Journal', 'Isolated report'],
    controllerState: result.postState, jobState: w.job().state, syntheticGenerationCalls: w.calls,
    syntheticAuthorityRecords: readdirSync(join(dir, 'authority', 'records')).length,
    journalHistory: w.journal()[0].history.map(e => ({ state: e.state, at: e.at })),
    modelPreflight: w.job().modelPreflight, providerMessageId: w.job().providerMessageId,
    reservedMicroUsd: w.job().reservedMicroUsd, syntheticUsageCostMicroUsd: w.job().actualCostMicroUsd,
    reportHash: w.job().reportHash, reportArtifactVerified: w.store.reportIsValid(w.job()),
  }, null, 2));
});
await test('completed document never enters Git delivery, second Agent, review or promotion', async dir => {
  const w = await world(dir); await w.runtime.execute(w.c);
  await assert.rejects(w.runtime.execute(w.c), /LIMITED_WORKER_NOT_AT_OWNED_STAGE/); assert.equal(w.calls, 1);
  assert.equal(w.controller.get(w.c.runId).remoteSha, undefined);
});
await test('live transport cannot run even with synthetic valid archived permits while EXE HOLD', async dir => {
  const w = await world(dir, { kind: 'LIVE_PROVIDER' }); await assert.rejects(w.runtime.execute(w.c), /EXE_HOLD/);
  assert.equal(w.calls, 0); assert.equal(w.preflights, 0); assert.equal(w.journal().length, 0); assert.equal(w.job().reservedMicroUsd, 0);
});
await test('unarchived generic live-call grant is blocked by the real Driver', async dir => {
  const w = await world(dir, { omitLiveArchive: true }); const out = await w.runtime.execute(w.c);
  assert.equal(w.calls, 0); assert.equal(out.status, 'NOT_STEPPED');
});
await test('unarchived full-contract Human permit is refused by the Worker after standard Driver gating', async dir => {
  const w = await world(dir, { omitLimitedArchive: true }); await w.runtime.execute(w.c);
  assert.equal(w.calls, 0); assert.equal(w.preflights, 0); assert.equal(w.controller.get(w.c.runId).state, 'HUMAN_STOP');
});
await test('another Human principal cannot grant the Goal owner’s permit', async dir => {
  const w = await world(dir, { archiveHuman: 'human:wrong-synthetic' }); await w.runtime.execute(w.c); assert.equal(w.calls, 0);
});
for (const [field, value] of [['implementationSha','c'.repeat(40)], ['workerCodeHash','c'.repeat(64)]]) await test(field + ' mismatch refuses before provider preflight', async dir => {
  const w = await world(dir, { options: { [field]: value } }); await w.runtime.execute(w.c); assert.equal(w.calls, 0); assert.equal(w.preflights, 0);
});
await test('source hash and Goal mismatches refuse before reservation or model calls', async dir => {
  const w = await world(dir, { options: { readGoal: () => 'Changed goal' } }); await w.runtime.execute(w.c);
  assert.equal(w.calls, 0); assert.equal(w.job().reservedMicroUsd, 0);
});
await test('source bytes/path/SHA cannot be swapped by the adapter source port', async dir => {
  const w = await world(dir, { options: { readSource: () => ({ text: 'private session', bytes: 15, path: 'secrets', sha: 'f'.repeat(40), hash: 'f'.repeat(64) }) } });
  await w.runtime.execute(w.c); assert.equal(w.calls, 0);
});
await test('current pricing and account model preflight failure produces no inference and no retry', async dir => {
  const w = await world(dir, { preflight() { throw new Error('ACCOUNT_MODEL_NOT_VERIFIED'); } });
  await w.runtime.execute(w.c); assert.equal(w.calls, 0); assert.equal(w.preflights, 1); assert.equal(w.job().state, 'BLOCKED');
});
await test('preflight that ignores cancellation is still bounded by the Worker deadline', async dir => {
  const w = await world(dir, { options: { deadlineMs: 200 }, preflight: () => new Promise(() => {}) });
  await w.runtime.execute(w.c); assert.equal(w.calls, 0); assert.equal(w.job().state, 'TIMED_OUT');
});
await test('timeout after generation claim is UNCERTAIN, reserved and never auto-replayed after restart', async dir => {
  const w = await world(dir, { options: { deadlineMs: 200 }, generate: () => new Promise(() => {}) });
  await w.runtime.execute(w.c); assert.equal(w.calls, 1); assert.equal(w.job().state, 'UNCERTAIN'); assert.equal(w.journal()[0].state, 'UNCERTAIN');
  const restarted = composeLimitedWorker(w.options); await assert.rejects(restarted.execute(w.c),/LIMITED_WORKER_NOT_AT_OWNED_STAGE/); assert.equal(w.calls, 1); assert.equal(w.job().reservedMicroUsd, 210240);
});
await test('user cancellation aborts the active request; remote completion stays uncertain and reservation remains', async dir => {
  let entered; const ready = new Promise(r => entered = r); let wasAborted = false;
  const w = await world(dir, { generate: async (_c,_g,_s, signal) => { entered(); return new Promise((_,reject) => signal.addEventListener('abort', () => { wasAborted = true; reject(new Error('USER_CANCEL')); })); } });
  const work = w.runtime.execute(w.c); await Promise.race([ready, new Promise((_,reject)=>setTimeout(()=>reject(new Error('fixture did not reach generation')),1000))]); assert.equal(w.runtime.cancel(w.c), true); await work;
  assert.equal(wasAborted, true); assert.equal(w.job().state, 'UNCERTAIN'); assert.equal(w.job().reason, 'USER_CANCEL'); assert.equal(w.calls, 1);
});
for (const [name, change] of [
  ['output token excess', r => r.usage.output_tokens = 2049], ['input token excess', r => r.usage.input_tokens = 200001],
  ['unknown input usage', r => delete r.usage.input_tokens], ['cache charge', r => r.usage.cache_creation_input_tokens = 1],
  ['priority tier', r => r.usage.service_tier = 'priority'], ['model substitution', r => r.model = 'different-model'],
  ['tool call', r => r.content = [{ type: 'tool_use', text: 'shell' }]], ['truncated output', r => r.stop_reason = 'max_tokens'],
]) await test(name + ' never becomes a completed result; zero retries', async dir => {
  const w = await world(dir, { generate() { const r = reply(); change(r); return r; } }); await w.runtime.execute(w.c);
  assert.equal(w.calls, 1); assert.equal(w.job().state, 'UNCERTAIN'); assert.equal(w.job().report, null);
});
await test('parallel duplicate execution cannot dispatch a second request', async dir => {
  const w = await world(dir); await Promise.allSettled([w.runtime.execute(w.c), w.runtime.execute(w.c)]); assert.equal(w.calls, 1);
});
await test('pricing changes, missing model IDs, ambiguous tariffs and expired quotes are refused', () => {
  const now = new Date().toISOString(); const q = tariffFromMarkdown(markdown, now);
  for (const text of [markdown.replace('$1 / MTok','$2 / MTok'), markdown.replace(MODEL,'alias'), markdown.replace('200K tokens','1M tokens'), markdown.replace('Active (legacy)','Retired'), markdown.replace('| Output |','| Input |')]) assert.throws(() => tariffFromMarkdown(text, now));
  assert.throws(() => checkQuote(q, q.validUntil)); assert.throws(() => checkQuote({ ...q, checkedAt: new Date(Date.now()+3600000).toISOString() }, now));
});
await test('exact model/provider/API/tools/token/cost/call bounds are strict contract fields', async dir => {
  const w = await world(dir);
  for (const [key,value] of [['model','latest'],['provider','other'],['apiVersion','latest'],['maxCalls',2],['maxRetries',1],['maxCostMicroUsd',1000001],['timeoutSeconds',301],['maxOutputTokens',2049],['maxInputTokens',200001],['sourceBytes',16385],['tools',['SHELL']]]) assert.throws(() => parseContract({ ...w.c, [key]: value }));
  assert.equal(maximumCost(w.c), 210240);
});
await test('request exposes only goal and README text; tool, shell, cache, batch, beta and Agent loops are absent', async dir => {
  const w = await world(dir), body = messageBody(w.c, 'Bounded README review, offline synthetic fixture.', w.source.text);
  assert.deepEqual(Object.keys(body).sort(), ['max_tokens','messages','model','service_tier','stream','system','thinking']);
  assert.equal(body.max_tokens,2048); assert.equal(body.service_tier,'standard_only'); assert.deepEqual(body.thinking,{type:'disabled'});
  assert.equal(body.messages.length,1); assert.ok(!('tools' in body));
});
await test('persistent global reservation cannot exceed US$1 or be reset by another Store instance', async dir => {
  const w = await world(dir);
  for (let i=0;i<4;i++) {
    const c = { ...w.c, goalId: 'goal-'+randomUUID(), runId: 'synthetic-run-'+i, outputKey: hash(i) }; const j = w.store.create(c,w.clock.now());
    w.store.reserve(j.id,210240,hash('invocation'+i),w.clock.now(),true); w.store.change(j.id,j=>j.state='UNCERTAIN');
  }
  const reopened = new WorkerStore(w.store.directory), other = reopened.create({ ...w.c, runId:'fifth-synthetic' },w.clock.now());
  assert.throws(()=>reopened.reserve(other.id,210240,hash('fifth'),w.clock.now(),true), /TOTAL_COST_LIMIT/);
  assert.equal(reopened.read().jobs.reduce((s,j)=>s+j.reservedMicroUsd,0),840960);
});
await test('restart converts interrupted RUNNING to UNCERTAIN without replay or refund', async dir => {
  const w = await world(dir); w.store.reserve(hash(w.c),210240,hash('interrupted'),w.clock.now(),true);
  const reopened = new WorkerStore(w.store.directory); reopened.recover(w.clock.now()); assert.equal(reopened.read().jobs[0].state,'UNCERTAIN');
  assert.equal(reopened.read().jobs[0].reservedMicroUsd,210240); assert.equal(w.calls,0);
});
await test('exclusive runtime lease, checksum and symlink failures are fail-closed', async dir => {
  const w = await world(dir), release = w.store.lease();
  assert.throws(()=>new WorkerStore(w.store.directory).lease(),/WORKER_LEASE_BUSY/); release();
  const file = join(w.store.directory,'ledger.json'); const bad=readFileSync(file,'utf8').replace('PREPARED','RUNNING'); writeFileSync(file,bad);
  assert.throws(()=>w.store.read(),/WORKER_STORAGE_INTEGRITY/); assert.equal(readFileSync(file,'utf8'),bad);
  symlinkSync(w.store.directory,join(dir,'alias')); assert.throws(()=>new WorkerStore(join(dir,'alias')),/WORKER_STORAGE_UNSAFE/);
});
await test('arbitrary destination and already-cancelled native requests cannot reach a provider', async () => {
  await assert.rejects(boundedHttps('https://example.com/', { method:'GET',signal:new AbortController().signal }),/TRANSPORT_REFUSED/);
  const abort=new AbortController();abort.abort();await assert.rejects(boundedHttps('https://api.anthropic.com/v1/messages',{method:'POST',signal:abort.signal}),/TRANSPORT_REFUSED/);
});
await test('native transport itself refuses HOLD before reading a key or opening account/model requests', async dir => {
  const w=await world(dir); let keys=0; const native=nativeAnthropicTransport(()=>{keys++;throw new Error('must not read');});
  await assert.rejects(native.preflight(w.c,new AbortController().signal),/EXE_HOLD/);
  await assert.rejects(native.generate(w.c,w.g.text,w.source.text,new AbortController().signal),/EXE_HOLD/);assert.equal(keys,0);
});
await test('implementation identity is rechecked after provider preflight, not just at composition', async dir => {
  let clean=true; const w=await world(dir,{preflight(){clean=false;},options:{currentImplementation:()=>({sha:'b'.repeat(40),codeHash:hash('OFFLINE_SYNTHETIC_CODE'),clean})}});
  await w.runtime.execute(w.c);assert.equal(w.calls,0);assert.equal(w.job().reason,'IMPLEMENTATION_CHANGED');
});
await test('generic live-call grant expiry during preflight is rechecked before generation',async dir=>{
  let offset=0;const w=await world(dir,{editLimitedGrant(g){g.expiresAt=new Date(Date.now()+3500000).toISOString();},preflight(){offset=1900000;},options:{clock:{now:()=>new Date(Date.now()+offset).toISOString()}}});
  await w.runtime.execute(w.c);assert.equal(w.calls,0);assert.equal(w.job().state,'BLOCKED');
});
await test('generic live-call authority superseded during preflight cannot dispatch generation',async dir=>{
  let w;w=await world(dir,{preflight(){
    const prior=w.archive('AUTHORIZATION',w.live);
    w.archive('AUTHORIZATION',{...w.live,reason:'SYNTHETIC supersession'},HUMAN.principalRef,2,prior);
  }});
  await w.runtime.execute(w.c);assert.equal(w.calls,0);assert.equal(w.job().state,'BLOCKED');
});
await test('real Workspace HTTP path enforces session/origin, HOLD, forged-field refusal and cancellation', async dir => {
  const w=await world(dir);const service=createLimitedWorkerService({goals:w.bridge.store,governance:w.bridge.governance,admission:w.admission,projects:['chief'],
    store:w.store,quote:w.c.quote,source:()=>w.source,identity:w.options.currentImplementation,runtime:w.runtime,now:w.clock.now});
  const server=await startWorkspaceServer({config:w.workspace,uiDirectory:'workspace-ui',port:0,store:w.bridge.store,limitedWorker:service});
  try {
    const endpoint=server.url+'api/v0/projects/chief/limited-worker';assert.equal((await fetch(endpoint)).status,401);
    const bootstrap=await fetch(server.url),cookie=bootstrap.headers.get('set-cookie').split(';')[0];
    const headers={Cookie:cookie,Origin:new URL(server.url).origin,'X-Chief-Workspace':'1','Content-Type':'application/json'};
    const post=(url,body,h=headers)=>fetch(url,{method:'POST',headers:h,body:JSON.stringify(body)});
    const input={requestId:randomUUID(),goalId:w.g.goalId,agentId:'limited-readme-worker'};
    assert.equal((await post(endpoint,input,{...headers,Origin:'http://evil.example'})).status,403);
    assert.equal((await post(endpoint,{...input,authorization:'fake',sourcePath:'/private/session'})).status,400);
    const prepared=await post(endpoint,input);assert.equal(prepared.status,201);assert.equal((await prepared.json()).jobs.length,1);
    const action=endpoint+'/'+hash(w.c)+'/actions';const start=await post(action,{action:'START',requestId:randomUUID()});
    assert.equal(start.status,403);assert.equal((await start.json()).error.code,'EXE_HOLD');assert.equal(w.calls,0);
    const cancelled=await post(action,{action:'CANCEL',requestId:randomUUID()});assert.equal((await cancelled.json()).jobs[0].state,'CANCELLED');
    const packet=pilotPacket(w.job(),w.packet.sliceId);assert.equal(packet.issuedAt,null);assert.equal(packet.state,'UNISSUED_NOT_AUTHORITY');
    assert.equal((await fetch(endpoint+'?grant=1',{headers:{Cookie:cookie}})).status,400);
  }finally{await server.close();}
});
for(const [name,edit] of [
  ['contract hash',g=>g.target='f'.repeat(64)],['run',g=>g.runId='wrong-run'],['packet',g=>g.packetId='wrong-packet'],
  ['provider',g=>g.scope.provider='other'],['model',g=>g.scope.model='alias'],['tools/egress',g=>g.scope.egressDestinations=['example.com:443']],
  ['expiry',g=>{g.issuedAt=new Date(Date.now()-3600000).toISOString();g.expiresAt=new Date(Date.now()-1000).toISOString();}],
])await test('archived Human permit with wrong '+name+' refuses before any model request',async dir=>{
  const w=await world(dir,{editLimitedGrant:edit});await w.runtime.execute(w.c);assert.equal(w.calls,0);assert.equal(w.preflights,0);
});
await test('actual process crash preserves reservation, stale lease recovery and uncertainty without replay',async dir=>{
  const w=await world(dir);const storeModule=new URL('./dist/limited-worker/store.js',import.meta.url).href;
  const program=`import {WorkerStore} from ${JSON.stringify(storeModule)};const s=new WorkerStore(process.argv[1]);s.lease();s.reserve(process.argv[2],210240,process.argv[3],new Date().toISOString(),true);process.kill(process.pid,'SIGKILL');`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',program,w.store.directory,hash(w.c),hash('crash-invocation')],{timeout:5000,encoding:'utf8'});
  assert.equal(child.signal,'SIGKILL');const restarted=new WorkerStore(w.store.directory),release=restarted.lease();
  try{restarted.recover(w.clock.now());assert.equal(w.job().state,'UNCERTAIN');assert.equal(w.job().reservedMicroUsd,210240);assert.equal(w.calls,0);}finally{release();}
});
await test('report artifact corruption cannot be displayed as controller-applied success',async dir=>{
  const w=await world(dir);await w.runtime.execute(w.c);assert.equal(w.store.reportIsValid(w.job()),true);
  writeFileSync(join(w.store.directory,w.c.outputKey,'report.md'),'tampered fixture');assert.equal(w.store.reportIsValid(w.job()),false);
});
await test('result and journal storage cannot alias protected Authority or Controller roots',async dir=>{
  const w=await world(dir);assert.throws(()=>composeLimitedWorker({...w.options,resultDirectory:w.options.authorityArchiveDirectory}));
  assert.throws(()=>composeLimitedWorker({...w.options,journalDirectory:w.options.controllerStoreDirectory}));
});
await test('fixed-version source extraction ignores changed working text and refuses symlinks, oversized sources and symbolic refs',dir=>{
  const repo=directory(join(dir,'source'));const git=(...args)=>execFileSync('/usr/bin/git',['-C',repo,'-c','core.hooksPath=/dev/null','-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid',...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init');writeFileSync(join(repo,'README.md'),'# Exact synthetic version\n');git('add','README.md');git('commit','-m','Synthetic source');const sha=git('rev-parse','HEAD');
  writeFileSync(join(repo,'README.md'),'working text must not be read');assert.equal(readPinnedReadme(repo,sha).text,'# Exact synthetic version\n');
  for(const ref of['HEAD','main',sha+':../private'])assert.throws(()=>readPinnedReadme(repo,ref),/SOURCE_REFUSED/);
  writeFileSync(join(repo,'README.md'),'x'.repeat(16385));git('add','README.md');git('commit','-m','Synthetic oversized');assert.throws(()=>readPinnedReadme(repo,git('rev-parse','HEAD')),/SOURCE_SIZE_LIMIT/);
  rmSync(join(repo,'README.md'));symlinkSync('/nonexistent/synthetic-private-session',join(repo,'README.md'));git('add','README.md');git('commit','-m','Synthetic symlink');assert.throws(()=>readPinnedReadme(repo,git('rev-parse','HEAD')),/SOURCE_NOT_REGULAR_README/);
});
await test('contract validators expose no mutable Zod schema and the exact egress set is deeply frozen',()=>{
  assert.equal(Object.keys(contractModule).some(k=>/schema/i.test(k)),false);assert.equal(Object.isFrozen(SCOPE),true);assert.equal(Object.isFrozen(SCOPE.egressDestinations),true);
  assert.deepEqual(SCOPE.egressDestinations,['api.anthropic.com:443','platform.claude.com:443']);
  assert.throws(()=>SCOPE.egressDestinations.push('example.com:443'));
});
await test('explicit grant-copy files are private strict inputs, never authority issuance or EXE release',async dir=>{
  assert.deepEqual(loadGrantCopies(undefined),{liveCallGrant:null,limitedGrant:null});
  const w=await world(dir),file=join(dir,'copies.json');
  const raw={schemaVersion:1,liveCallGrant:w.live,limitedGrant:w.limited};
  writeFileSync(file,JSON.stringify(raw),{mode:0o600});
  const before=readdirSync(join(dir,'authority','records'));
  assert.deepEqual(loadGrantCopies(file),{liveCallGrant:w.live,limitedGrant:w.limited});
  assert.deepEqual(readdirSync(join(dir,'authority','records')),before);
  chmodSync(file,0o644);assert.throws(()=>loadGrantCopies(file),/GRANT_COPY_FILE_UNSAFE/);chmodSync(file,0o600);
  writeFileSync(file,JSON.stringify({...raw,exe:'AUTHORIZED'}));assert.throws(()=>loadGrantCopies(file));
  writeFileSync(file,JSON.stringify({...raw,limitedGrant:{...w.limited,actorRole:'GPT_ARCHITECT'}}));assert.throws(()=>loadGrantCopies(file),/GRANT_COPY_INVALID/);
  symlinkSync(file,join(dir,'copies-alias'));assert.throws(()=>loadGrantCopies(join(dir,'copies-alias')));
  assert.equal(contractModule.EXE,'HOLD');
});
console.log(`\n${passed} passed, ${failed} failed`);process.exitCode=failed?1:0;
