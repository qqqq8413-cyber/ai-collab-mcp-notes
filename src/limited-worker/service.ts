import { z } from 'zod';
import type { FileGoalStore } from '../workspace/goal-store.js';
import type { GoalGovernancePort } from '../workspace/goal-governance-port.js';
import type { GoalRunAdmissionPort } from '../workspace/goal-run-admission-port.js';
import type { HumanPrincipalV1 } from '../identity/canonical.js';
import { LimitedWorkerRequestError, type LimitedWorkerPort } from '../workspace/limited-worker-port.js';
import { EXE, MODEL, API_VERSION, REPOSITORY, SYSTEM_PROMPT, hash, parseContract, maximumCost, checkQuote, resourceInputPolicy, inputFacts, type Quote } from './contract.js';
import { activationCandidate, planConditions, readiness } from './readiness.js';
import { efficiency } from './efficiency.js';
import { WorkerStore, type Job } from './store.js';
import type { composeLimitedWorker } from './composition.js';
import type { readPinnedReadme } from './source.js';

const createInput = z.strictObject({ requestId: z.string().uuid(), goalId: z.string().regex(/^goal-[a-f0-9-]{36}$/), agentId: z.literal('limited-readme-worker'),
  interactionId:z.string().uuid().optional(),clientElapsedMs:z.number().int().min(0).max(86400000).optional() });
const observeInput=z.strictObject({kind:z.literal('OBSERVE'),requestId:z.string().uuid(),event:z.enum(['SETUP_OPENED','TASK_FORM_STARTED']),interactionId:z.string().uuid()});
const actions = z.strictObject({ requestId: z.string().uuid(), action: z.enum(['CHECK', 'START', 'CANCEL','RECONCILE']) });
export interface LimitedServiceOptions {
  goals: FileGoalStore; governance: GoalGovernancePort; admission: GoalRunAdmissionPort;
  projects: readonly string[]; store: WorkerStore; quote: Quote | null;
  source(): ReturnType<typeof readPinnedReadme>;
  identity(): { sha: string; codeHash: string; clean: boolean };
  runtime: ReturnType<typeof composeLimitedWorker>; now(): string;
  measurementClass?:'LOCAL_OBSERVATION'|'OFFLINE_SYNTHETIC';
}
export function createLimitedWorkerService(options: LimitedServiceOptions): LimitedWorkerPort {
  const projects = new Set(options.projects), quote = options.quote ? structuredClone(options.quote) : null;
  const refuse = (code: string, status = 409): never => { throw new LimitedWorkerRequestError(code, status); };
  const observe=(projectId:string,id:string,kind:Parameters<WorkerStore['observe']>[0]['kind'],jobId:string|null,reason:string|null=null,interactionId:string|null=null,clientElapsedMs:number|null=null)=>
    options.store.observe({id,projectId,kind,jobId,reason,interactionId,clientElapsedMs,at:options.now(),evidenceClass:options.measurementClass??'LOCAL_OBSERVATION'});
  const goal = (projectId: string, goalId: string, human: HumanPrincipalV1) => {
    if (!projects.has(projectId)) refuse('UNKNOWN_PROJECT', 404);
    const g = options.goals.read(projectId).goals.find(g => g.goalId === goalId);
    if (!g) return refuse('UNKNOWN_GOAL', 404);
    if (g.submittedBy?.principalRef !== human.principalRef || human.kind !== 'HUMAN') refuse('GOAL_PRINCIPAL_MISMATCH', 403);
    return g;
  };
  const view = (j: Job, human: HumanPrincipalV1,totalReserved:number) => {
    const g = goal(j.contract.projectId, j.contract.goalId, human), identity = options.identity();
    const conditions=planConditions(j.contract,options.now(),identity,totalReserved-j.reservedMicroUsd);
    if (hash(g.text) !== j.contract.objectiveHash) refuse('GOAL_BINDING_MISMATCH');
    let permit: unknown = null, authorityStatus = 'MISSING_OR_INVALID';
    try { permit = options.runtime.permit(j.contract); authorityStatus = 'ARCHIVED_BINDING_VALID'; } catch { conditions.push('LIMITED_PERMIT_MISSING_OR_INVALID'); }
    const observed = options.runtime.inspect(j.contract);
    const applied = options.runtime.resultConsistency(j.contract);
    if(observed.driver.state!=='PACKET_READY'&&observed.driver.state!=='IMPLEMENTING')conditions.push('CONTROLLER_NOT_READY');
    if(j.state==='UNCERTAIN'||j.state==='COMPLETED'&&!applied)conditions.push('UNCERTAIN_NO_REPLAY');
    else if(['COMPLETED','CANCELLED','BLOCKED','TIMED_OUT','FAILED'].includes(j.state))conditions.push('WORK_ALREADY_TERMINAL');
    let measuredInput:ReturnType<typeof inputFacts>|null=null;
    try{const source=options.source();if(source.sha!==j.contract.sourceSha)throw new Error('SOURCE_CHANGED');measuredInput=inputFacts(j.contract,g.text,source.text);}catch{conditions.push('SOURCE_OR_GOAL_MISMATCH');}
    const sliceId=observed.driver.change?.changeId;
    return { ...j, objective: g.text, conditions, authorityStatus, authority: permit, driver: observed.driver, invocations: observed.journal,
      comparisonKey:hash({objectiveHash:j.contract.objectiveHash,sourceHash:j.contract.sourceHash,sourceSha:j.contract.sourceSha,
        provider:j.contract.provider,model:j.contract.model,apiVersion:j.contract.apiVersion,outputMaxTokens:j.contract.maxOutputTokens,systemPromptHash:hash(SYSTEM_PROMPT),delivery:'README_FINDINGS_REPORT'}),
      readiness:readiness(conditions),input:measuredInput,goalCreatedAt:g.createdAt,
      verifiedAt:applied?observed.journal.find(r=>r.invocationId===j.invocationId&&r.state==='APPLIED')?.appliedAt??null:null,
      reviewPacket:sliceId?activationCandidate(j.contract,sliceId,g.text):null,
      effectiveState: j.state === 'COMPLETED' && !applied ? 'RESULT_REQUIRES_RECONCILIATION' : j.state,
      resultApplied: applied, exe: EXE, modelAccountAvailability: j.modelPreflight?.evidenceClass === 'LIVE_PROVIDER' ? 'ACCOUNT_METADATA_VERIFIED' : 'UNVERIFIED_NO_ACCOUNT_CALL',
      maximumReservationMicroUsd: maximumCost(j.contract), report: j.report, notice: 'Operational evidence, not authority. OFFLINE_SYNTHETIC is not real AI acceptance.' };
  };
  const read = (projectId: string, human: HumanPrincipalV1) => {
    if (!projects.has(projectId)) refuse('UNKNOWN_PROJECT', 404);
    const data = options.store.read();
    const totalReserved=data.jobs.reduce((sum,j)=>sum+j.reservedMicroUsd,0);
    const jobs=data.jobs.filter(j=>j.contract.projectId===projectId).map(j=>view(j,human,totalReserved));
    return { exe: EXE, recordClass: 'OPERATIONAL_RECORD', model: MODEL, provider: 'anthropic', apiVersion: API_VERSION,
      agentId: 'limited-readme-worker', quote, accountAvailability: 'UNVERIFIED',
      totalReservedMicroUsd:totalReserved,totalCeilingMicroUsd:data.ceilingMicroUsd,
      efficiency:efficiency((data.observations??[]).filter(o=>o.projectId===projectId),data.observationsDropped??0,jobs),jobs };
  };
  return Object.freeze({ read,
    async prepare(projectId: string, input: unknown, human: HumanPrincipalV1) {
      if(!projects.has(projectId))return refuse('UNKNOWN_PROJECT',404);
      const observation=observeInput.safeParse(input);
      if(observation.success){const o=observation.data;observe(projectId,o.requestId,o.event,null,null,o.interactionId);return read(projectId,human);}
      const parsed = createInput.safeParse(input); if (!parsed.success) return refuse('INVALID_WORKER_PLAN', 400);
      const g = goal(projectId, parsed.data.goalId, human);
      const prior = options.store.read().jobs.find(j => j.contract.projectId === projectId && j.contract.goalId === g.goalId);
      if (prior) {
        if(prior.contract.inputPolicy?.revision!=='A3')return read(projectId,human);
        const saved=options.store.read().observations?.find(o=>o.id===parsed.data.requestId);
        if(!(saved?.kind==='PLAN_READY'&&saved.jobId===prior.id&&saved.projectId===projectId&&saved.interactionId===(parsed.data.interactionId??null)&&saved.clientElapsedMs===(parsed.data.clientElapsedMs??null)))
          observe(projectId,parsed.data.requestId,'PLAN_REUSED',prior.id,null,parsed.data.interactionId??null,parsed.data.clientElapsedMs??null);
        return read(projectId, human);
      }
      if (!quote) return refuse('PRICE_NOT_VERIFIED', 503);
      try { checkQuote(quote, options.now()); } catch { return refuse('PRICE_QUOTE_EXPIRED', 409); }
      const source = options.source(), identity = options.identity();
      const governed = await options.governance.govern(projectId, g.goalId, human), admitted = await options.admission.admit(projectId, g.goalId, human);
      if (governed.repository !== REPOSITORY) return refuse('REPOSITORY_MISMATCH');
      const c = parseContract({ schemaVersion: 1, kind: 'LIMITED_README_WORKER', repository: REPOSITORY, projectId, goalId: g.goalId,
        objectiveHash: hash(g.text), runId: admitted.runId, implementationSha: identity.sha, workerCodeHash: identity.codeHash,
        sourceSha: source.sha, sourcePath: 'README.md', sourceHash: source.hash, sourceBytes: source.bytes,
        agentId: 'limited-readme-worker', provider: 'anthropic', model: MODEL, apiVersion: API_VERSION,
        tools: ['READ_PINNED_README', 'WRITE_ISOLATED_REPORT'], outputKey: hash([projectId, g.goalId, admitted.runId]), storageIdentity: options.store.identity(),
        maxInputTokens: 200000, maxOutputTokens: 2048, maxCalls: 1, maxRetries: 0, maxCostMicroUsd: 1000000, totalCostMicroUsd: 1000000, timeoutSeconds: 300, quote,inputPolicy:resourceInputPolicy() });
      maximumCost(c);inputFacts(c,g.text,source.text);
      options.store.create(c, options.now());
      if(options.measurementClass==='OFFLINE_SYNTHETIC')options.store.change(hash(c),j=>{j.evidenceClass='OFFLINE_SYNTHETIC';});
      observe(projectId,parsed.data.requestId,'PLAN_READY',hash(c),null,parsed.data.interactionId??null,parsed.data.clientElapsedMs??null);
      return read(projectId, human);
    },
    async action(projectId: string, id: string, input: unknown, human: HumanPrincipalV1) {
      const parsed = actions.safeParse(input); if (!parsed.success) return refuse('INVALID_WORKER_ACTION', 400);
      const job = options.store.read().jobs.find(j => j.id === id && j.contract.projectId === projectId); if (!job) return refuse('UNKNOWN_JOB', 404);
      goal(projectId, job.contract.goalId, human);
      if (parsed.data.action === 'START') {
        if (EXE === 'HOLD') {observe(projectId,parsed.data.requestId,'START_REFUSED',id,'EXE_HOLD');return refuse('EXE_HOLD', 403);}
        await options.runtime.execute(job.contract);
      }
      if (parsed.data.action === 'CANCEL') {
        const active = options.runtime.cancel(job.contract);
        if (!active && job.state === 'PREPARED') options.store.change(id, j => { j.state = 'CANCELLED'; j.reason = 'USER_CANCEL_BEFORE_REQUEST'; j.events.push({ at: options.now(), kind: 'USER_CANCEL_BEFORE_REQUEST' }); });
      }
      if(parsed.data.action!=='START')observe(projectId,parsed.data.requestId,parsed.data.action==='RECONCILE'?'RECONCILIATION_REQUESTED':parsed.data.action,id,parsed.data.action==='CANCEL'?'USER_CANCEL':null);
      return read(projectId, human);
    },
  });
}
export function pilotPacket(job: Job, sliceId: string,objective='Review the bound README only') {
  return activationCandidate(job.contract,sliceId,objective);
}
