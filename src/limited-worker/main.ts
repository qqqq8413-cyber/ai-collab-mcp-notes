#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadTrustedWorkspaceHostConfig } from '../intake/workspace-host-config.js';
import { startTrustedWorkspaceHost } from '../intake/workspace-host.js';
import { trustedObservationPreflight } from '../intake/goal-execution-status-bridge.js';
import { PilotEngine } from '../pilot/engine.js';
import { GitHubActionsReader } from '../pilot/github.js';
import { GovernanceStoreIsolation } from '../automation/governance-store-isolation.js';
import { composeLimitedWorker } from './composition.js';
import { createLimitedWorkerService } from './service.js';
import { WorkerStore } from './store.js';
import { fetchOfficialQuote, nativeAnthropicTransport } from './transport.js';
import { hash, REPOSITORY } from './contract.js';
import { readPinnedReadme } from './source.js';
import { loadGrantCopies } from './config.js';

async function main() {
  const args = process.argv.slice(2), allowed = ['--host-config','--port','--permit-config','--measurement-mode'];
  if (args.length % 2 || new Set(args.filter((_,i)=>i%2===0)).size !== args.length/2) throw new Error('INVALID_ARGS');
  for(let i=0;i<args.length;i+=2) if(!allowed.includes(args[i])||!args[i+1])throw new Error('INVALID_ARGS');
  const arg=(name:string)=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
  const path=arg('--host-config');if(!path)throw new Error('MISSING_CONFIG');
  const port=Number(arg('--port')??'4876');if(!Number.isInteger(port)||port<1||port>65535)throw new Error('INVALID_PORT');
  const mode=arg('--measurement-mode');if(mode!==undefined&&mode!=='OFFLINE_SYNTHETIC')throw new Error('INVALID_MEASUREMENT_MODE');
  const measurementClass=mode??'LOCAL_OBSERVATION';
  const config=loadTrustedWorkspaceHostConfig(path);if(!config.executionStatus)throw new Error('AUTHORITY_STATUS_REQUIRED');
  const grantCopies=loadGrantCopies(arg('--permit-config'));
  const root=join(dirname(fileURLToPath(import.meta.url)),'../..'), uiDirectory=join(root,'workspace-ui');
  const roots={config:config.workspace,uiDirectory,changeRegistryDirectory:config.changeRegistryDirectory,controllerStoreDirectory:config.controllerStoreDirectory,...config.executionStatus};
  trustedObservationPreflight(roots);
  const isolation=GovernanceStoreIsolation.forTrustedObservation(roots);isolation.assertDisjoint('limited source repository',root);
  const projects=config.governedRepositories.filter(b=>b.repository===REPOSITORY).map(b=>b.projectId);
  if(!projects.length||config.governedRepositories.some(b=>b.repository!==REPOSITORY))throw new Error('EXACT_REPOSITORY_REQUIRED');
  const workerDirectory=join(config.workspace.dataDirectory,'limited-worker'), journalDirectory=join(config.workspace.dataDirectory,'limited-worker-journal');
  isolation.assertDisjoint('limited results',workerDirectory);isolation.assertDisjoint('limited journal',journalDirectory);
  const workerStore=new WorkerStore(workerDirectory), release=workerStore.lease();
  const clock={now:()=>new Date().toISOString()}; workerStore.recover(clock.now());
  for(const projectId of projects)workerStore.observe({id:randomUUID(),projectId,at:clock.now(),kind:'RUNTIME_START',
    interactionId:null,jobId:null,reason:null,clientElapsedMs:null,evidenceClass:measurementClass});
  const identity=()=>{
    const git=(...a:string[])=>execFileSync('/usr/bin/git',['--no-replace-objects','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',root,...a],{
      encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe'],
      env:{PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0',GIT_NO_REPLACE_OBJECTS:'1'} }).trim();
    const directory=dirname(fileURLToPath(import.meta.url));
    return {sha:git('rev-parse','HEAD'),clean:git('status','--porcelain','--untracked-files=normal')==='',
      codeHash:hash(readdirSync(directory).filter(p=>p.endsWith('.js')).sort().map(p=>[p,hash(readFileSync(join(directory,p)))]))};
  };
  let quote=null;try{quote=await fetchOfficialQuote(clock.now());}catch{console.log('PRICE_UNVERIFIED: worker remains blocked');}
  const source=()=>readPinnedReadme(root,'a3164fd12d6d3129978da32ea024854d6e9b5cdc');
  const engine=new PilotEngine({dataDirectory:config.workspace.dataDirectory,projects,
    reader:new GitHubActionsReader(join(homedir(),'.config/gh-chief-ai/bin/chief-github'),root)});
  try {
    const server=await startTrustedWorkspaceHost({config,uiDirectory,port,automation:engine,aiPreparation:true,
      limitedWorkerFactory:ports=>{
        const id=identity();
        const runtime=composeLimitedWorker({...roots,journalDirectory,resultDirectory:workerDirectory,clock,
          humanPrincipalRef:config.workspace.humanPrincipal.principalRef,implementationSha:id.sha,workerCodeHash:id.codeHash,
          currentImplementation:identity,
          ...grantCopies,transport:nativeAnthropicTransport(()=>{
            const key=process.env.CHIEF_LIMITED_ANTHROPIC_KEY;if(!key)throw new Error('CREDENTIAL_NOT_CONFIGURED');return key;
          }),
          readSource:c=>readPinnedReadme(root,c.sourceSha),readGoal:c=>{
            const g=ports.store.read(c.projectId).goals.find(g=>g.goalId===c.goalId);
            if(!g||g.submittedBy?.principalRef!==config.workspace.humanPrincipal.principalRef)throw new Error('GOAL_BINDING_MISMATCH');return g.text;
          }});
        return createLimitedWorkerService({goals:ports.store,governance:ports.governance,admission:ports.runAdmission,
          projects,store:workerStore,quote,source,identity,runtime,now:clock.now,measurementClass});
      }});
    engine.start();console.log(`CHIEF limited worker: ${server.url} | EXE HOLD | account/model not called`);
    let stopping=false;const stop=()=>{if(stopping)return;stopping=true;void engine.close().then(()=>server.close()).then(()=>{release();process.exit(0);}).catch(()=>process.exit(1));};
    process.once('SIGTERM',stop);process.once('SIGINT',stop);
  }catch(error){await engine.close();release();throw error;}
}
main().catch(()=>{console.error('限定 Worker 無法安全啟動；EXE HOLD，未呼叫模型。');process.exitCode=1;});
