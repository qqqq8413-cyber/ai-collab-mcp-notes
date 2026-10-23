import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parseWorkspaceConfig} from './dist/workspace/config.js';
import {createGoalChangeBridge} from './dist/intake/goal-change-bridge.js';
import {createGoalRunAdmissionBridge} from './dist/intake/goal-run-admission-bridge.js';
import {AutomationController} from './dist/automation/controller.js';
import {FileControllerStore} from './dist/automation/durable-store.js';
import {openGovernedActivationCore} from './dist/automation/activation-core.js';
import {openDirectAuthorityPreserver} from './dist/automation/authority/preserver.js';
import {FileInvocationJournal} from './dist/automation/file-invocation-journal.js';
import {composeLimitedWorker} from './dist/limited-worker/composition.js';
import {WorkerStore} from './dist/limited-worker/store.js';
import {MODEL,API_VERSION,REPOSITORY,SCOPE,EXE,hash,parseContract,inputPolicy,resourceInputPolicy,serializeRequest,assertInputReady,inputFacts,messageBody,maximumCost,packetFor} from './dist/limited-worker/contract.js';
import {tariffFromMarkdown,nativeAnthropicTransport} from './dist/limited-worker/transport.js';
import {activationCandidate,readiness,planConditions} from './dist/limited-worker/readiness.js';
import {efficiency} from './dist/limited-worker/efficiency.js';
import {createLimitedWorkerService} from './dist/limited-worker/service.js';
import {startWorkspaceServer} from './dist/workspace/server.js';
import {limitedActivationCandidate} from './dist/limited-worker/governance.js';
import {readGovernedModel} from './dist/automation/read-model/governed-read-model.js';

// All authorities, model responses, sources and interaction measurements below are OFFLINE_SYNTHETIC.
// Existing AP1 preserves these synthetic documents only inside a temporary directory, never a real Archive.
const HUMAN={schemaVersion:1,kind:'HUMAN',principalRef:'human:a1-offline-synthetic'},ARCHITECT='architect:a1-offline-synthetic';
const md=`### Model IDs\n| Platform | Model ID |\n|---|---|\n| Claude API | ${MODEL} |\n### Pricing\n| Feature | Value |\n|---|---|\n| Input | $1 / MTok |\n| Output | $5 / MTok |\n### Capabilities\n| Feature | Value |\n|---|---|\n| Context window | 200K tokens |\n### Availability\n| Feature | Value |\n|---|---|\n| Status | Active (legacy) |`;
let passed=0,failed=0;
async function test(name,fn){const dir=realpathSync(mkdtempSync(join(tmpdir(),'chief-a1-')));try{await fn(dir);passed++;console.log('  PASS '+name);}catch(e){failed++;console.error('  FAIL '+name+': '+e.stack);}finally{rmSync(dir,{recursive:true,force:true});}}
async function fixture(dir,{legacy=false,a3=false,deadlineMs,kind='OFFLINE_SYNTHETIC',activate=true,editGrant,editPacket}={}){
  const directory=name=>{const p=join(dir,name);mkdirSync(p,{mode:0o700});return p;};
  const clock={now:()=>new Date().toISOString()},registry=directory('registry'),controllerRoot=directory('controller'),authority=directory('authority');
  const config=parseWorkspaceConfig({schemaVersion:1,dataDirectory:join(dir,'goals'),humanPrincipal:{principalRef:HUMAN.principalRef},projects:[{projectId:'chief',displayName:'OFFLINE_SYNTHETIC',repository:REPOSITORY}]},dir);
  const roots={config,uiDirectory:join(process.cwd(),'workspace-ui'),governedRepositories:[{projectId:'chief',repository:REPOSITORY}],changeRegistryDirectory:registry,controllerStoreDirectory:controllerRoot};
  const bridge=createGoalChangeBridge(roots),admission=createGoalRunAdmissionBridge({...roots,store:bridge.store});
  const g=bridge.store.addGoal('chief','OFFLINE_SYNTHETIC：唯讀 README 文件審查',HUMAN).queue.goals.at(-1);
  const governed=await bridge.governance.govern('chief',g.goalId,HUMAN),admitted=await admission.admit('chief',g.goalId,HUMAN);
  const store=new WorkerStore(join(dir,'results')),source={text:'# OFFLINE_SYNTHETIC README\n',sha:'a'.repeat(40),path:'README.md'};
  source.bytes=Buffer.byteLength(source.text);source.hash=hash(Buffer.from(source.text));
  const c=parseContract({schemaVersion:1,kind:'LIMITED_README_WORKER',repository:REPOSITORY,projectId:'chief',goalId:g.goalId,objectiveHash:hash(g.text),runId:admitted.runId,
    implementationSha:'b'.repeat(40),workerCodeHash:hash('OFFLINE_SYNTHETIC_CODE'),sourceSha:source.sha,sourcePath:source.path,sourceHash:source.hash,sourceBytes:source.bytes,
    agentId:'limited-readme-worker',provider:'anthropic',model:MODEL,apiVersion:API_VERSION,tools:['READ_PINNED_README','WRITE_ISOLATED_REPORT'],outputKey:hash(g.goalId),storageIdentity:store.identity(),
    maxInputTokens:200000,maxOutputTokens:2048,maxCalls:1,maxRetries:0,maxCostMicroUsd:1000000,totalCostMicroUsd:1000000,timeoutSeconds:300,quote:tariffFromMarkdown(md,clock.now()),...(legacy?{}:{inputPolicy:a3?resourceInputPolicy():inputPolicy()})});
  store.create(c,clock.now());const packet=packetFor(c,governed.change.changeId);editPacket?.(packet);
  const grant=(operation,target,id)=>({authorizationId:id,actorRole:'HUMAN',operation,target,runId:c.runId,packetId:packet.packetId,scope:structuredClone(SCOPE),issuedAt:clock.now(),expiresAt:new Date(Date.now()+1800000).toISOString(),reason:'OFFLINE_SYNTHETIC ONLY'});
  const live=grant('LIVE_PROVIDER_MODEL_CALL','live-provider-model-call','a1-synthetic-live'),limited=grant('LIMITED_README_WORKER',hash(c),'a1-synthetic-limited');editGrant?.(live,limited);
  const document=(kind,body)=>({schemaVersion:1,recordClass:'DIRECT_AUTHORITY',kind,authorityId:kind==='IMPLEMENTATION_PACKET'?body.packetId:body.authorizationId,
    version:1,issuedAt:body.issuedAt??clock.now(),issuer:{role:kind==='IMPLEMENTATION_PACKET'?'GPT_ARCHITECT':'HUMAN',principalRef:kind==='IMPLEMENTATION_PACKET'?ARCHITECT:HUMAN.principalRef},
    subject:{repository:REPOSITORY,sliceId:packet.sliceId},supersedes:null,body});
  const preserver=openDirectAuthorityPreserver(authority),controller=new AutomationController(clock,new FileControllerStore(controllerRoot,clock));
  const activation=openGovernedActivationCore({...roots,authorityArchiveDirectory:authority,controller,preserver,architectPrincipalRef:ARCHITECT,clock});
  const target={source:{kind:'WORKSPACE_GOAL',projectId:'chief',goalId:g.goalId},runId:c.runId};
  const bundle={implementationPacket:document('IMPLEMENTATION_PACKET',packet),liveCallAuthorizations:[document('AUTHORIZATION',live)]};
  if(activate){preserver.preserve(document('AUTHORIZATION',limited));activation.activate(target,bundle);}
  let calls=0,preflights=0;
  const transport={kind,async preflight(){preflights++;return{evidenceClass:kind,model:MODEL,apiVersion:API_VERSION,maxInputTokens:200000,maxOutputTokens:2048,priceSourceHash:c.quote.sourceSha256,observedAt:clock.now()};},
    async generate(){calls++;return{id:'OFFLINE_SYNTHETIC_MESSAGE',model:MODEL,stop_reason:'end_turn',content:[{type:'text',text:'# OFFLINE_SYNTHETIC\n非真實 AI 成果。'}],usage:{input_tokens:100,output_tokens:50,cache_creation_input_tokens:0,cache_read_input_tokens:0,service_tier:'standard'}};}};
  const options={...roots,authorityArchiveDirectory:authority,journalDirectory:join(dir,'journal'),resultDirectory:store.directory,architectPrincipalRef:ARCHITECT,humanPrincipalRef:HUMAN.principalRef,
    implementationSha:c.implementationSha,workerCodeHash:c.workerCodeHash,currentImplementation:()=>({sha:c.implementationSha,codeHash:c.workerCodeHash,clean:true}),clock,transport,liveCallGrant:live,limitedGrant:limited,readSource:()=>source,readGoal:()=>g.text,...(deadlineMs?{deadlineMs}:{})};
  const runtime=composeLimitedWorker(options),service=createLimitedWorkerService({goals:bridge.store,governance:bridge.governance,admission,projects:['chief'],store,quote:c.quote,source:()=>source,identity:options.currentImplementation,runtime,now:clock.now,measurementClass:'OFFLINE_SYNTHETIC'});
  return{c,packet,store,source,g,bridge,admission,roots,config,clock,options,runtime,service,activation,target,bundle,preserver,document,live,limited,controller,
    get calls(){return calls;},get preflights(){return preflights;},job:()=>store.read().jobs[0]};
}
await test('A1 keeps requested 4096 distinct from unmeasured estimates, byte limits, output cap and reservation',async dir=>{
  const w=await fixture(dir);const f=inputFacts(w.c,w.g.text,w.source.text);
  assert.equal(f.requestedHardLimitTokens,4096);assert.equal(f.estimatedInputTokens,null);assert.equal(f.hardLimitVerification,'UNVERIFIED');
  assert.equal(f.reservationInputTokenBound,200000);assert.equal(f.apiOutputTokenLimit,2048);assert.equal(f.sourceBytes,w.source.bytes);assert.equal(maximumCost(w.c),210240);
});
await test('a current A1 contract refuses even synthetic execution before Driver steps, budget claims or preflight',async dir=>{
  const w=await fixture(dir);await assert.rejects(w.runtime.execute(w.c),/INPUT_LIMIT_DECISION_REQUIRED/);
  assert.equal(w.calls,0);assert.equal(w.preflights,0);assert.equal(w.job().reservedMicroUsd,0);assert.equal(w.controller.get(w.c.runId).state,'PACKET_READY');
});
await test('native transport remains HOLD before credential reads for both new and legacy contracts',async dir=>{
  const w=await fixture(dir);let keys=0;const native=nativeAnthropicTransport(()=>{keys++;return'never';});
  await assert.rejects(native.preflight(w.c,new AbortController().signal),/EXE_HOLD/);await assert.rejects(native.generate(w.c,w.g.text,w.source.text,new AbortController().signal),/EXE_HOLD/);assert.equal(keys,0);
});
await test('legacy contracts are readable but never input-ready for live use',async dir=>{const w=await fixture(dir,{legacy:true});assert.throws(()=>assertInputReady(w.c),/LEGACY_REQUIRES_REPLAN/);assert.equal(w.store.read().jobs.length,1);});
for(const[field,value]of[['requestedHardLimitTokens',200000],['decision','APPROVED'],['hardLimitVerification','VERIFIED'],['estimatedInputTokens',4096],['requestMaxBytes',999999]])await test('client cannot declare input policy '+field+' accepted',async dir=>{
  const w=await fixture(dir);assert.throws(()=>parseContract({...w.c,inputPolicy:{...w.c.inputPolicy,[field]:value}}));
});
await test('real payload byte and Goal limits reject oversized inputs without token-estimate claims',async dir=>{
  const w=await fixture(dir);const text='x'.repeat(16385);assert.throws(()=>messageBody({...w.c,sourceHash:hash(text),sourceBytes:16385},w.g.text,text),/INPUT_BYTES/);
  const goal='x'.repeat(2001);assert.throws(()=>messageBody({...w.c,objectiveHash:hash(goal)},goal,w.source.text),/INPUT_BYTES/);
});
await test('system derives review packet, scope and all internal IDs without issuing authority',async dir=>{
  const w=await fixture(dir,{activate:false});const before=readdirSync(w.options.authorityArchiveDirectory);
  const p=activationCandidate(w.c,w.packet.sliceId,w.g.text);assert.equal(p.state,'UNISSUED_NOT_AUTHORITY');assert.equal(p.contractHash,hash(w.c));assert.equal(p.issuedAt,null);assert.equal(p.expiresAt,null);
  assert.deepEqual(p.authority,{implementationPacket:null,liveProviderGrant:null,limitedWorkerGrant:null});assert.deepEqual(readdirSync(w.options.authorityArchiveDirectory),before);assert.equal(w.controller.get(w.c.runId).state,'IDLE');
});
await test('a proposal is not an AuthorityDocument and existing AP1 rejects it without writing',async dir=>{
  const w=await fixture(dir,{activate:false});assert.throws(()=>w.activation.activate(w.target,activationCandidate(w.c,w.packet.sliceId,w.g.text)));assert.equal(w.controller.get(w.c.runId).state,'IDLE');assert.deepEqual(readdirSync(w.options.authorityArchiveDirectory),[]);
});
await test('existing AP1 safely activates separately issued synthetic documents, exact retry is idempotent',async dir=>{
  const w=await fixture(dir);const again=w.activation.activate(w.target,w.bundle);assert.equal(again.status,'ALREADY_ACTIVATED');assert.equal(readdirSync(join(w.options.authorityArchiveDirectory,'records')).length,3);assert.equal(w.calls,0);
});
await test('AP1 rejects forged Human principal before any activation write',async dir=>{
  const w=await fixture(dir,{activate:false});w.bundle.liveCallAuthorizations[0].issuer.principalRef='human:forged';assert.throws(()=>w.activation.activate(w.target,w.bundle));assert.equal(w.controller.get(w.c.runId).state,'IDLE');assert.deepEqual(readdirSync(w.options.authorityArchiveDirectory),[]);
});
await test('live A1 composition cannot advance a correctly activated synthetic Run under HOLD',async dir=>{
  const w=await fixture(dir,{kind:'LIVE_PROVIDER'});await assert.rejects(w.runtime.execute(w.c),/EXE_HOLD/);assert.equal(w.calls,0);assert.equal(w.preflights,0);assert.equal(w.controller.get(w.c.runId).state,'PACKET_READY');
});
await test('legacy synthetic calibration still exercises AP1 -> Driver -> Worker -> Journal -> report, not A1 live eligibility',async dir=>{
  const w=await fixture(dir,{legacy:true});await w.runtime.execute(w.c);const seen=w.runtime.inspect(w.c);assert.equal(w.calls,1);assert.equal(seen.driver.state,'IMPLEMENTATION_COMPLETE');assert.equal(seen.journal[0].state,'APPLIED');assert.ok(seen.journal[0].appliedAt);assert.equal(w.store.reportIsValid(w.job()),true);
  const proof={evidenceClass:'OFFLINE_SYNTHETIC',purpose:'Existing governed activation and legacy-result calibration only; not A1 input-policy or live-provider acceptance',
    paidModelCalls:0,syntheticGenerationCalls:1,controller:seen.driver.state,journal:seen.journal,reportHash:w.job().reportHash,archiveSyntheticRecords:3};
  const at=process.argv.indexOf('--evidence');if(at>=0)writeFileSync(process.argv[at+1],JSON.stringify(proof,null,2));
});
await test('readiness tells the operator who acts next without making operational records into authority',()=>{
  const r=readiness(['EXE_HOLD','INPUT_LIMIT_DECISION_REQUIRED','EXE_HOLD']);assert.equal(r.canStart,false);assert.equal(r.checks.length,2);assert.ok(r.checks.every(c=>c.title&&c.nextStep&&c.owner));assert.equal(EXE,'HOLD');
});
await test('changed SHA, code, dirty checkout, expired price and exhausted budget all appear as blockers',async dir=>{
  const w=await fixture(dir);const a=planConditions(w.c,w.c.quote.validUntil,{sha:'c'.repeat(40),codeHash:'d'.repeat(64),clean:false},1000000);
  for(const name of['PRICE_QUOTE_EXPIRED','IMPLEMENTATION_NOT_ACCEPTED_OR_CHANGED','TOTAL_COST_LIMIT','INPUT_LIMIT_DECISION_REQUIRED'])assert.ok(a.includes(name));
});
await test('setup and per-task measurement persist, stay synthetic, and do not claim complete setup or model results',async dir=>{
  const w=await fixture(dir);const interactionId=randomUUID();
  for(const event of['SETUP_OPENED','TASK_FORM_STARTED'])await w.service.prepare('chief',{kind:'OBSERVE',requestId:randomUUID(),event,interactionId},HUMAN);
  const goal=w.bridge.store.addGoal('chief','OFFLINE_SYNTHETIC 新工作',HUMAN).queue.goals.at(-1);
  const response=await w.service.prepare('chief',{requestId:randomUUID(),goalId:goal.goalId,agentId:'limited-readme-worker',interactionId,clientElapsedMs:123},HUMAN);
  assert.ok(response.jobs.at(-1).contract.inputPolicy);const e=response.efficiency;assert.equal(e.productEfficiencyProven,false);assert.equal(e.setup.fullyAuthorizedSetupMs,null);assert.ok(e.setup.firstPlanReadyMs>=0);assert.equal(e.tasks.at(-1).clientReportedFormMs,123);assert.equal(e.tasks.at(-1).goalToVerifiedResultMs,null);
  const reopened=new WorkerStore(w.store.directory);assert.equal(reopened.read().observations.length,3);assert.ok(reopened.read().observations.every(o=>o.evidenceClass==='OFFLINE_SYNTHETIC'));assert.equal(w.calls,0);
});
await test('measurement request dedup is durable and altered reuse is refused',async dir=>{
  const w=await fixture(dir);const input={kind:'OBSERVE',requestId:randomUUID(),event:'SETUP_OPENED',interactionId:randomUUID()};await w.service.prepare('chief',input,HUMAN);await w.service.prepare('chief',input,HUMAN);assert.equal(w.store.read().observations.length,1);
  await assert.rejects(w.service.prepare('chief',{...input,event:'TASK_FORM_STARTED'},HUMAN),/OBSERVATION_ID_CONFLICT/);
});
await test('forged telemetry cannot approve policy, choose evidence class or issue authority',async dir=>{
  const w=await fixture(dir);const input={kind:'OBSERVE',requestId:randomUUID(),event:'SETUP_OPENED',interactionId:randomUUID()};
  for(const field of['authority','evidenceClass','exe','provider','inputPolicy'])await assert.rejects(w.service.prepare('chief',{...input,[field]:'APPROVED'},HUMAN),/INVALID_WORKER_PLAN/);
  assert.equal(w.store.read().observations,undefined);assert.equal(w.calls,0);
});
await test('HOLD refusals are measured once per request, not model requests or authorizations',async dir=>{
  const w=await fixture(dir),input={requestId:randomUUID(),action:'START'};
  for(let i=0;i<2;i++)await assert.rejects(w.service.action('chief',hash(w.c),input,HUMAN),/EXE_HOLD/);
  const e=w.service.read('chief',HUMAN).efficiency;assert.equal(e.recordedOperatorActions,1);assert.equal(e.tasks[0].blockedAttempts[0].reason,'EXE_HOLD');assert.equal(w.calls,0);assert.equal(w.job().reservedMicroUsd,0);
});
await test('reconciliation records a request only: no refund, re-dispatch or authority change',async dir=>{
  const w=await fixture(dir);w.store.reserve(hash(w.c),210240,hash('OFFLINE_SYNTHETIC_CLAIM'),w.clock.now(),true);w.store.recover(w.clock.now());const before=readdirSync(join(w.options.authorityArchiveDirectory,'records'));
  await w.service.action('chief',hash(w.c),{requestId:randomUUID(),action:'RECONCILE'},HUMAN);assert.equal(w.job().state,'UNCERTAIN');assert.equal(w.job().reservedMicroUsd,210240);assert.equal(w.calls,0);assert.deepEqual(readdirSync(join(w.options.authorityArchiveDirectory,'records')),before);
  assert.equal(w.service.read('chief',HUMAN).efficiency.tasks[0].recoveries,1);
});
await test('unverified or inconsistent report/controller/journal cannot create a goal-to-result time',async dir=>{
  const w=await fixture(dir,{legacy:true});await w.runtime.execute(w.c);const first=w.service.read('chief',HUMAN);assert.ok(first.efficiency.tasks[0].goalToVerifiedResultMs>=0);
  writeFileSync(join(w.store.directory,w.c.outputKey,'report.md'),'OFFLINE_SYNTHETIC tamper');const after=w.service.read('chief',HUMAN);assert.equal(after.jobs[0].resultApplied,false);assert.equal(after.efficiency.tasks[0].goalToVerifiedResultMs,null);
});
await test('missing input data, negative time and absent paired AI baseline remain unknown',()=>{
  const e=efficiency([],0,[]);assert.equal(e.setup.firstPlanReadyMs,null);assert.equal(e.comparisonBaseline,null);assert.equal(e.comparisonDesign.directAiHumanTimeMs,null);assert.equal(e.productEfficiencyProven,false);
  const obs=(kind,at)=>({id:randomUUID(),projectId:'chief',at,kind,jobId:null,interactionId:null,reason:null,evidenceClass:'OFFLINE_SYNTHETIC',clientElapsedMs:null});
  assert.equal(efficiency([obs('SETUP_OPENED','2026-10-23T00:01:00.000Z'),obs('PLAN_READY','2026-10-23T00:00:00.000Z')],0,[]).setup.firstPlanReadyMs,null);
});
await test('real HTTP routes reject direct START and forged scope, while plan generation needs only a Goal selection',async dir=>{
  const w=await fixture(dir,{activate:false}),server=await startWorkspaceServer({config:w.config,uiDirectory:'workspace-ui',port:0,store:w.bridge.store,limitedWorker:w.service});
  try{const res=await fetch(server.url),cookie=res.headers.get('set-cookie').split(';')[0],headers={Cookie:cookie,Origin:new URL(server.url).origin,'Content-Type':'application/json','X-Chief-Workspace':'1'};
    const url=server.url+'api/v0/projects/chief/limited-worker',post=(path,body)=>fetch(path,{method:'POST',headers,body:JSON.stringify(body)});
    assert.equal((await post(url+'/'+hash(w.c)+'/actions',{action:'START',requestId:randomUUID()})).status,403);
    assert.equal((await post(url,{goalId:w.g.goalId,agentId:'limited-readme-worker',requestId:randomUUID(),authority:'fake'})).status,400);
    const read=await fetch(url,{headers:{Cookie:cookie}});const data=await read.json();assert.equal(read.status,200,JSON.stringify(data));assert.equal(data.jobs[0].reviewPacket.state,'UNISSUED_NOT_AUTHORITY');assert.equal(data.jobs[0].readiness.canStart,false);assert.deepEqual(readdirSync(w.options.authorityArchiveDirectory),[]);
  }finally{await server.close();}
});
await test('legacy checksum is readable without silently adding policy or measurement values',async dir=>{
  const w=await fixture(dir,{legacy:true}),file=join(w.store.directory,'ledger.json'),before=readFileSync(file);const data=new WorkerStore(w.store.directory).read();
  assert.equal(data.jobs[0].contract.inputPolicy,undefined);assert.equal(data.observations,undefined);assert.deepEqual(readFileSync(file),before);
});
await test('bounded measurement retention explicitly reports dropped observations',async dir=>{
  const w=await fixture(dir);const observation={id:randomUUID(),projectId:'chief',at:w.clock.now(),kind:'CHECK',interactionId:null,jobId:hash(w.c),reason:null,evidenceClass:'OFFLINE_SYNTHETIC',clientElapsedMs:null};
  w.store.update(d=>{d.observations=Array.from({length:2000},()=>({...observation,id:randomUUID()}));});w.store.observe(observation);
  assert.equal(w.store.read().observations.length,2000);const e=w.service.read('chief',HUMAN).efficiency;assert.equal(e.dropped,1);assert.equal(e.coverage,'BOUNDED_WINDOW_WITH_DROPS');
});
await test('reusing a plan counts a new operator action but exact request replay does not',async dir=>{
  const w=await fixture(dir),g=w.bridge.store.addGoal('chief','OFFLINE_SYNTHETIC dedup',HUMAN).queue.goals.at(-1),request={requestId:randomUUID(),goalId:g.goalId,agentId:'limited-readme-worker',interactionId:randomUUID()};
  await w.service.prepare('chief',request,HUMAN);await w.service.prepare('chief',request,HUMAN);await w.service.prepare('chief',{...request,requestId:randomUUID()},HUMAN);
  assert.equal(w.store.read().jobs.length,2);assert.equal(w.service.read('chief',HUMAN).efficiency.recordedOperatorActions,2);assert.equal(w.store.read().jobs.at(-1).evidenceClass,'OFFLINE_SYNTHETIC');
});
await test('displayed report text must match the sealed file, not just the file hash',async dir=>{
  const w=await fixture(dir,{legacy:true});await w.runtime.execute(w.c);w.store.change(hash(w.c),j=>{j.report='OFFLINE_SYNTHETIC display tamper';});
  assert.equal(w.store.reportIsValid(w.job()),false);assert.equal(w.service.read('chief',HUMAN).jobs[0].resultApplied,false);
});
await test('a replacement report/file pair still cannot contradict the APPLIED journal result',async dir=>{
  const w=await fixture(dir,{legacy:true});await w.runtime.execute(w.c);const text='OFFLINE_SYNTHETIC replacement';writeFileSync(join(w.store.directory,w.c.outputKey,'report.md'),text);
  w.store.change(hash(w.c),j=>{j.report=text;j.reportHash=hash(text);});assert.equal(w.store.reportIsValid(w.job()),true);
  const view=w.service.read('chief',HUMAN);assert.equal(view.jobs[0].resultApplied,false);assert.equal(view.efficiency.tasks[0].goalToVerifiedResultMs,null);
});
await test('paired comparison identity binds the same task/source/model/delivery without claiming a baseline',async dir=>{
  const w=await fixture(dir);const before=w.service.read('chief',HUMAN);assert.match(before.efficiency.tasks[0].comparisonKey,/^[a-f0-9]{64}$/);
  assert.equal(before.efficiency.tasks[0].comparisonKey,before.jobs[0].comparisonKey);assert.equal(before.efficiency.comparisonBaseline,null);
});
// A2 adds strict-decision and trusted staging checks to the same isolated fixture.
function a2Gate(w, overrides={}) {
  return limitedActivationCandidate({core:w.activation,store:w.store,readModel:()=>readGovernedModel(w.options,w.clock),
    humanPrincipalRef:HUMAN.principalRef,architectPrincipalRef:ARCHITECT,now:w.clock.now,identity:w.options.currentImplementation,
    readSource:()=>w.source,readGoal:()=>w.g.text,...overrides});
}
function archiveA2(w) {
  const limited=w.document('AUTHORIZATION',w.limited);
  for(const d of[w.bundle.implementationPacket,...w.bundle.liveCallAuthorizations,limited])w.preserver.preserve(d);
  return limited;
}
await test('A2-D1 is selected strict 4096, not approval to use 200000 input tokens',async dir=>{
  const w=await fixture(dir);assert.equal(w.c.inputPolicy.revision,'A2');assert.equal(w.c.inputPolicy.decision,'A2_D1_STRICT_4096');
  assert.equal(w.c.inputPolicy.proofStatus,'BLOCKED_NO_PROVIDER_GUARANTEE');assert.throws(()=>assertInputReady(w.c),/INPUT_LIMIT_DECISION_REQUIRED/);
  const f=inputFacts(w.c,w.g.text,w.source.text);for(const key of['exactInputTokens','provenInputTokenUpperBound','protocolTokenOverhead'])assert.equal(f[key],null);
  assert.equal(f.systemPromptHash,hash(messageBody(w.c,w.g.text,w.source.text).system));assert.equal(f.requestHash,hash(JSON.stringify(messageBody(w.c,w.g.text,w.source.text))));
});
for(const estimate of[0,4095,4096,4097,200000])await test('A2 rejects unverified count '+estimate+' as a hard-limit certificate',async dir=>{
  const w=await fixture(dir);assert.throws(()=>parseContract({...w.c,inputPolicy:{...w.c.inputPolicy,estimatedInputTokens:estimate,estimateMethod:'COUNT_TOKENS'}}));
  assert.throws(()=>assertInputReady(w.c),/INPUT_LIMIT_DECISION_REQUIRED/);assert.equal(w.calls,0);
});
for(const text of['ASCII','繁體中文','e\u0301','é','👩🏽‍💻','<|endoftext|>','\u0000\n"\\'])await test('A2 preserves Unicode/escaping without claiming token equality: '+JSON.stringify(text),async dir=>{
  const w=await fixture(dir),source=text.repeat(10),goal=text;
  const c={...w.c,sourceHash:hash(source),sourceBytes:Buffer.byteLength(source),objectiveHash:hash(goal)};
  const body=messageBody(c,goal,source),f=inputFacts(c,goal,source);
  assert.equal(JSON.parse(body.messages[0].content).source.text,source);assert.equal(JSON.parse(body.messages[0].content).goal,goal);
  assert.equal(f.sourceBytes,Buffer.byteLength(source));assert.equal(f.goalCharacters,goal.length);assert.equal(f.goalUtf8Bytes,Buffer.byteLength(goal));
  assert.equal(f.requestUtf8Bytes,Buffer.byteLength(JSON.stringify(body)));assert.equal(f.provenInputTokenUpperBound,null);
});
for(const text of['\ud800','\udfff','abc\ud800z'])await test('A2 refuses unpaired Unicode surrogate '+JSON.stringify(text),async dir=>{
  const w=await fixture(dir);assert.throws(()=>messageBody({...w.c,objectiveHash:hash(text)},text,w.source.text),/UNPAIRED_SURROGATE/);
});
await test('A2 does not truncate the 16384-byte source to fabricate a token guarantee',async dir=>{
  const w=await fixture(dir),source='x'.repeat(16384),c={...w.c,sourceHash:hash(source),sourceBytes:16384};
  assert.equal(JSON.parse(messageBody(c,w.g.text,source).messages[0].content).source.text.length,16384);
  assert.throws(()=>assertInputReady(c),/INPUT_LIMIT_DECISION_REQUIRED/);
});
await test('A1 persisted policy is readable without rewriting but remains blocked',async dir=>{
  const w=await fixture(dir),policy={...w.c.inputPolicy,revision:'A1',decision:'PENDING_HUMAN_ARCHITECT_REVIEW'};delete policy.proofStatus;
  const c=parseContract({...w.c,inputPolicy:policy});assert.equal(c.inputPolicy.revision,'A1');assert.throws(()=>assertInputReady(c),/INPUT_LIMIT_DECISION_REQUIRED/);
});
await test('A2 trusted staging only accepts already archived documents and ends at Controller PACKET_READY',async dir=>{
  const w=await fixture(dir,{activate:false}),limited=archiveA2(w),gate=a2Gate(w),before=readdirSync(join(w.options.authorityArchiveDirectory,'records'));
  const result=gate.stage(hash(w.c),w.bundle,limited);assert.equal(result.stage.status,'ACTIVATED');assert.equal(result.executionEligible,false);assert.equal(w.controller.get(w.c.runId).state,'PACKET_READY');
  assert.equal(gate.stage(hash(w.c),w.bundle,limited).stage.status,'ALREADY_ACTIVATED');assert.deepEqual(readdirSync(join(w.options.authorityArchiveDirectory,'records')),before);
  await assert.rejects(w.runtime.execute(w.c),/INPUT_LIMIT_DECISION_REQUIRED/);assert.deepEqual(w.runtime.inspect(w.c).journal,[]);assert.equal(w.calls,0);
  const at=process.argv.indexOf('--a2-evidence');if(at>=0)writeFileSync(process.argv[at+1],JSON.stringify({evidenceClass:'OFFLINE_SYNTHETIC',paidModelCalls:0,
    route:'Goal -> GC1 -> RA1 -> trusted pre-archived documents -> existing AP1 -> Controller PACKET_READY -> Driver input-policy refusal',
    stage:result,syntheticAuthorityDocuments:before.length,workerCalls:w.calls,journal:w.runtime.inspect(w.c).journal,productionWiring:'NOT_ENABLED'},null,2));
});
await test('A2 unarchived proposed grants cannot activate or write authority',async dir=>{
  const w=await fixture(dir,{activate:false});assert.throws(()=>a2Gate(w).stage(hash(w.c),w.bundle,w.document('AUTHORIZATION',w.limited)),/NOT_CURRENTLY_ARCHIVED/);
  assert.equal(w.controller.get(w.c.runId).state,'IDLE');assert.deepEqual(readdirSync(w.options.authorityArchiveDirectory),[]);
});
for(const field of['sha','codeHash','clean'])await test('A2 refuses changed implementation '+field+' before activation',async dir=>{
  const w=await fixture(dir,{activate:false}),limited=archiveA2(w);
  assert.throws(()=>a2Gate(w,{identity:()=>({...w.options.currentImplementation(),[field]:field==='clean'?false:'e'.repeat(field==='sha'?40:64)})}).stage(hash(w.c),w.bundle,limited),/IMPLEMENTATION_CHANGED/);
  assert.equal(w.controller.get(w.c.runId).state,'IDLE');
});
for(const type of['expired','future','run','model','tool','source','goal','price','operational','superseded'])await test('A2 activation refuses '+type+' mismatch without model invocation',async dir=>{
  const w=await fixture(dir,{activate:false});let bundle=structuredClone(w.bundle),limited;
  if(type==='expired'){w.limited.issuedAt=new Date(Date.now()-1800000).toISOString();w.limited.expiresAt=new Date(Date.now()-1000).toISOString();}
  if(type==='future')w.limited.issuedAt=new Date(Date.now()+60000).toISOString();
  if(type==='run')w.limited.runId='other-run';
  if(type==='model')w.limited.scope.model='different-model';
  if(type==='tool')bundle.implementationPacket.body.forbiddenChanges=[];
  limited=archiveA2(w);
  if(type==='superseded'){const d={...limited,version:2,supersedes:{kind:limited.kind,authorityId:limited.authorityId,version:1,recordHash:readGovernedModel(w.options,w.clock).authority.find(f=>f.ref.authorityId===w.limited.authorizationId).ref.recordHash},body:{...limited.body,reason:'OFFLINE_SYNTHETIC revoked/superseded'}};w.preserver.preserve(d);}
  const overrides=type==='source'?{readSource:()=>({...w.source,sha:'e'.repeat(40)})}:type==='goal'?{readGoal:()=> 'changed'}:type==='price'?{now:()=>w.c.quote.validUntil}:{};
  if(type==='operational')limited={...limited,recordClass:'OPERATIONAL_RECORD'};
  assert.throws(()=>a2Gate(w,overrides).stage(hash(w.c),bundle,limited));assert.equal(w.controller.get(w.c.runId).state,'IDLE');assert.equal(w.calls,0);
});
await test('A2 cancelled or uncertain jobs cannot be staged or replayed',async dir=>{
  const w=await fixture(dir,{activate:false}),limited=archiveA2(w);w.store.change(hash(w.c),j=>{j.state='CANCELLED';});
  assert.throws(()=>a2Gate(w).stage(hash(w.c),w.bundle,limited),/JOB_NOT_PREPARED/);assert.equal(w.controller.get(w.c.runId).state,'IDLE');
});
await test('A3 resource policy is input-ready, has no token hard-cap claim, and still has production HOLD',async dir=>{
  const w=await fixture(dir,{a3:true});assert.doesNotThrow(()=>assertInputReady(w.c));
  const f=inputFacts(w.c,w.g.text,w.source.text);assert.equal(f.requestedHardLimitTokens,null);assert.equal(f.hardLimitVerification,'NOT_CLAIMED');
  assert.equal(f.estimatedInputTokens,null);assert.equal(f.exactInputTokens,null);assert.equal(EXE,'HOLD');
  const conditions=planConditions(w.c,w.clock.now(),w.options.currentImplementation(),0);assert.ok(!conditions.includes('INPUT_LIMIT_DECISION_REQUIRED'));assert.ok(conditions.includes('EXE_HOLD'));
});
for(const size of[16383,16384,16385])await test('A3 source UTF8 byte boundary '+size+' is enforced without truncation',async dir=>{
  const w=await fixture(dir,{a3:true}),text='x'.repeat(size),c={...w.c,sourceBytes:size,sourceHash:hash(text)};
  if(size>16384)assert.throws(()=>messageBody(c,w.g.text,text),/INPUT_BYTES/);
  else assert.equal(JSON.parse(messageBody(c,w.g.text,text).messages[0].content).source.text,text);
});
for(const size of[1999,2000,2001])await test('A3 Goal UTF16 boundary '+size+' is enforced independently of UTF8 bytes',async dir=>{
  const w=await fixture(dir,{a3:true}),g='é'.repeat(size),c={...w.c,objectiveHash:hash(g)};
  if(size>2000)assert.throws(()=>messageBody(c,g,w.source.text),/INPUT_BYTES/);
  else{assert.equal(JSON.parse(messageBody(c,g,w.source.text).messages[0].content).goal,g);assert.equal(inputFacts(c,g,w.source.text).goalUtf8Bytes,size*2);}
});
for(const size of[131071,131072,131073])await test('A3 shared wire encoder byte boundary '+size,()=>{
  const text='x'.repeat(size-2);if(size>131072)assert.throws(()=>serializeRequest(text),/REQUEST_BYTES_LIMIT/);
  else assert.equal(Buffer.byteLength(serializeRequest(text)),size);
});
for(const field of['sourceMaxBytes','goalMaxCharacters','requestMaxBytes','enforcement','decision','hardLimitVerification'])await test('A3 policy cannot be widened or self-certified: '+field,async dir=>{
  const w=await fixture(dir,{a3:true});assert.throws(()=>parseContract({...w.c,inputPolicy:{...w.c.inputPolicy,[field]:'APPROVED'}}));
  assert.throws(()=>assertInputReady({...w.c,inputPolicy:{...w.c.inputPolicy,[field]:'APPROVED'}}));
});
await test('A3 synthetic AP1 -> Controller -> Driver -> Worker -> Journal -> sealed report succeeds once',async dir=>{
  const w=await fixture(dir,{a3:true,activate:false}),limited=archiveA2(w),staged=a2Gate(w).stage(hash(w.c),w.bundle,limited);
  assert.ok(!staged.blockers.includes('INPUT_LIMIT_DECISION_REQUIRED'));assert.equal(staged.executionEligible,false);
  await w.runtime.execute(w.c);const seen=w.runtime.inspect(w.c);
  assert.equal(w.calls,1);assert.equal(w.preflights,1);assert.equal(seen.driver.state,'IMPLEMENTATION_COMPLETE');assert.equal(seen.journal[0].state,'APPLIED');
  assert.equal(w.runtime.resultConsistency(w.c),true);assert.equal(w.job().actualCostMicroUsd,350);assert.equal(w.job().evidenceClass,'OFFLINE_SYNTHETIC');
  assert.equal(w.job().reservedMicroUsd,210240);assert.equal(w.job().generationClaimed,true);
  await assert.rejects(w.runtime.execute(w.c),/LIMITED_WORKER_NOT_AT_OWNED_STAGE/);assert.equal(w.calls,1);
  const at=process.argv.indexOf('--a3-evidence');if(at>=0)writeFileSync(process.argv[at+1],JSON.stringify({evidenceClass:'OFFLINE_SYNTHETIC',realModelAcceptance:false,paidModelCalls:0,
    inputPolicy:w.c.inputPolicy,staged,controller:seen.driver.state,journal:seen.journal,usage:w.job().usage,actualCostMicroUsd:w.job().actualCostMicroUsd,
    reservedMicroUsd:w.job().reservedMicroUsd,syntheticModelCalls:w.calls,reportHash:w.job().reportHash,resultConsistent:true,productionExe:EXE},null,2));
});
await test('A3 may accept synthetic usage above 4096 without treating that former threshold as a cap',async dir=>{
  const w=await fixture(dir,{a3:true}),generate=w.options.transport.generate;
  w.options.transport.generate=async()=>{const r=await generate();r.usage.input_tokens=6000;return r;};
  await w.runtime.execute(w.c);assert.equal(w.job().usage.inputTokens,6000);assert.equal(w.runtime.resultConsistency(w.c),true);
});
await test('A3 live composition and native transport remain HOLD before key reads, budget and invocation',async dir=>{
  const w=await fixture(dir,{a3:true,kind:'LIVE_PROVIDER'});let keys=0;const native=nativeAnthropicTransport(()=>{keys++;throw new Error('NEVER_READ_KEY');});
  await assert.rejects(w.runtime.execute(w.c),/EXE_HOLD/);await assert.rejects(native.preflight(w.c,new AbortController().signal),/EXE_HOLD/);
  await assert.rejects(native.generate(w.c,w.g.text,w.source.text,new AbortController().signal),/EXE_HOLD/);
  assert.equal(keys,0);assert.equal(w.calls,0);assert.equal(w.job().reservedMicroUsd,0);assert.deepEqual(w.runtime.inspect(w.c).journal,[]);
});
await test('A3 rejects missing archived limited grant even when a packet was activated',async dir=>{
  const w=await fixture(dir,{a3:true,activate:false});w.activation.activate(w.target,w.bundle);
  await w.runtime.execute(w.c);assert.equal(w.calls,0);assert.equal(w.preflights,0);assert.equal(w.controller.get(w.c.runId).state,'HUMAN_STOP');
});
await test('A3 expired Human grant refuses execution before provider preflight',async dir=>{
  const w=await fixture(dir,{a3:true,editGrant:(_,limited)=>{limited.issuedAt=new Date(Date.now()-1800000).toISOString();limited.expiresAt=new Date(Date.now()-1000).toISOString();}});
  await w.runtime.execute(w.c);assert.equal(w.calls,0);assert.equal(w.preflights,0);assert.equal(w.controller.get(w.c.runId).state,'HUMAN_STOP');
});
await test('A3 unknown model metadata or changed pricing fails closed before generation',async dir=>{
  const w=await fixture(dir,{a3:true});w.options.transport.preflight=async()=>({model:'substitute'});
  await w.runtime.execute(w.c);assert.equal(w.calls,0);assert.equal(w.job().state,'BLOCKED');assert.equal(w.controller.get(w.c.runId).state,'HUMAN_STOP');
});
await test('A3 timed out preflight aborts and records no generation claim',async dir=>{
  const w=await fixture(dir,{a3:true,deadlineMs:10});w.options.transport.preflight=async()=>new Promise(r=>setTimeout(()=>r({}),30));
  await w.runtime.execute(w.c);assert.equal(w.calls,0);assert.equal(w.job().generationClaimed,false);assert.equal(w.job().state,'TIMED_OUT');
});
await test('A3 cancellation after one synthetic send retains reservation and prohibits replay',async dir=>{
  const w=await fixture(dir,{a3:true});let started;const ready=new Promise(r=>started=r);let sends=0;
  w.options.transport.generate=async()=>{sends++;started();return new Promise(()=>{});};
  const execution=w.runtime.execute(w.c);await ready;assert.equal(w.runtime.cancel(w.c),true);await execution;
  assert.equal(w.job().state,'UNCERTAIN');assert.equal(w.job().reservedMicroUsd,210240);assert.equal(sends,1);
  await assert.rejects(w.runtime.execute(w.c),/LIMITED_WORKER_NOT_AT_OWNED_STAGE/);assert.equal(sends,1);assert.equal(w.job().state,'UNCERTAIN');assert.equal(w.runtime.inspect(w.c).journal[0].state,'UNCERTAIN');
});
await test('A3 persistent USD1 ceiling retains worst-case reservations across recovery',async dir=>{
  const w=await fixture(dir,{a3:true});
  for(let i=0;i<5;i++){const c=parseContract({...w.c,runId:'a3-offline-budget-'+i,goalId:'goal-'+randomUUID(),outputKey:hash('a3-output-'+i)});w.store.create(c,w.clock.now());
    if(i<4){w.store.reserve(hash(c),maximumCost(c),hash('invocation-'+i),w.clock.now(),true);w.store.recover(w.clock.now());}
    else assert.throws(()=>w.store.reserve(hash(c),maximumCost(c),hash('invocation-'+i),w.clock.now(),true),/TOTAL_COST_LIMIT/);}
  const restored=new WorkerStore(w.store.directory);assert.equal(restored.read().jobs.reduce((s,j)=>s+j.reservedMicroUsd,0),840960);assert.equal(w.calls,0);
});
await test('A3 old A1/A2/R1 plans are immutable and require new Goal/Run, not an in-place permit upgrade',async dir=>{
  const w=await fixture(dir),before=readFileSync(join(w.store.directory,'ledger.json'));
  const historical=await w.service.prepare('chief',{requestId:randomUUID(),goalId:w.g.goalId,agentId:'limited-readme-worker'},HUMAN);
  assert.equal(historical.jobs[0].contract.inputPolicy.revision,'A2');assert.ok(historical.jobs[0].conditions.includes('INPUT_POLICY_LEGACY_REQUIRES_REPLAN'));
  assert.deepEqual(readFileSync(join(w.store.directory,'ledger.json')),before);assert.throws(()=>assertInputReady(w.c),/INPUT_LIMIT_DECISION_REQUIRED/);
  const changed=parseContract({...w.c,inputPolicy:resourceInputPolicy()});assert.notEqual(hash(changed),hash(w.c));assert.notEqual(packetFor(changed,w.packet.sliceId).packetId,w.packet.packetId);
  assert.throws(()=>w.runtime.permit(changed));assert.equal(w.calls,0);
});
await test('A3 service creates new system-bound contracts and UNISSUED packets without granting authority',async dir=>{
  const w=await fixture(dir,{activate:false}),g=w.bridge.store.addGoal('chief','OFFLINE_SYNTHETIC A3新工作',HUMAN).queue.goals.at(-1);
  const view=await w.service.prepare('chief',{requestId:randomUUID(),goalId:g.goalId,agentId:'limited-readme-worker'},HUMAN),j=view.jobs.at(-1);
  assert.equal(j.contract.inputPolicy.revision,'A3');assert.ok(!j.conditions.includes('INPUT_LIMIT_DECISION_REQUIRED'));assert.equal(j.readiness.canStart,false);
  assert.equal(j.reviewPacket.state,'UNISSUED_NOT_AUTHORITY');assert.equal(j.reviewPacket.issuedAt,null);assert.equal(j.input.requestedHardLimitTokens,null);
  await assert.rejects(w.service.action('chief',j.id,{requestId:randomUUID(),action:'START'},HUMAN),/EXE_HOLD/);assert.deepEqual(readdirSync(w.options.authorityArchiveDirectory),[]);assert.equal(w.calls,0);
});
console.log(`\n${passed} passed, ${failed} failed`);process.exitCode=failed?1:0;
