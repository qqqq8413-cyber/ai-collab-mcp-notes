import { z } from 'zod';
import type { FileGoalStore } from '../workspace/goal-store.js';
import type { GoalGovernancePort } from '../workspace/goal-governance-port.js';
import type { GoalRunAdmissionPort } from '../workspace/goal-run-admission-port.js';
import type { HumanPrincipalV1 } from '../identity/canonical.js';
import { LimitedWorkerRequestError, type LimitedWorkerPort } from '../workspace/limited-worker-port.js';
import { EXE, MODEL, API_VERSION, REPOSITORY, SYSTEM_PROMPT, AGENT_IDS, READER_TURNS, SCOPE, hash, parseContract, maximumCost, checkQuote, resourceInputPolicy, inputFacts, requestBound, assertLiveRequestBound, type Contract, type Quote } from './contract.js';
import { activationCandidate, planConditions, readiness } from './readiness.js';
import { efficiency } from './efficiency.js';
import { WorkerStore, type Job } from './store.js';
import type { composeLimitedWorker } from './composition.js';
import type { readPinnedReadme } from './source.js';

const createInput = z.strictObject({ requestId: z.string().uuid(), goalId: z.string().regex(/^goal-[a-f0-9-]{36}$/), agentId: z.enum(AGENT_IDS),
  interactionId:z.string().uuid().optional(),clientElapsedMs:z.number().int().min(0).max(86400000).optional() });
const observeInput=z.strictObject({kind:z.literal('OBSERVE'),requestId:z.string().uuid(),event:z.enum(['SETUP_OPENED','TASK_FORM_STARTED']),interactionId:z.string().uuid()});
// M0: START carries the Human's explicit approval of this job's worst-case reservation (the amount shown before approving).
// M1: REQUEST_APPROVAL asks the trusted Host for this run's exact payload to sign; START then carries the passkey assertion.
const passkeyInput = z.strictObject({ credentialId: z.string().max(8192), authenticatorData: z.string().max(8192), clientDataJSON: z.string().max(8192), signature: z.string().max(8192) });
const actions = z.strictObject({ requestId: z.string().uuid(), action: z.enum(['CHECK', 'START', 'CANCEL','RECONCILE','REQUEST_APPROVAL']),
  approval: z.strictObject({ maxReservationMicroUsd: z.number().int().min(1).max(1000000) }).optional(), passkey: passkeyInput.optional() });
// Events that end a job's attempt, for the finished time shown with its result.
const FINISHED = ['RESULT_PERSISTED_NOT_AUTHORITY','UNCERTAIN_NO_REPLAY_RESERVATION_RETAINED','STOPPED_BEFORE_GENERATION','REFUSED_BEFORE_RESERVATION',
  'USER_CANCEL_BEFORE_REQUEST','UNCERTAIN_NO_REPLAY'];
/** M1: what a real (LIVE_PROVIDER) run still needs. Shown by a Host that cannot start one; nothing here grants anything. */
export const LIVE_AUTHORIZATION_STEPS = Object.freeze([
  'Architect 審查 M1-R1，並決定是否接受「README Worker 類別」與確切程式版本（常設類別接受；每個 Run 的 Packet 由 Host 依此衍生並標示為衍生紀錄，不是 Architect 逐次核發）；Claude Code 唯讀分析不在首次 Pilot 範圍（CLI 無法證明請求上限）。',
  'Human 與 Architect 決定是否解除 EXE／H1–H9 HOLD。目前程式常數 EXE＝HOLD，必須由另一個經 Architect 接受的提交改變。',
  'Human 一次性登記通行金鑰（Touch ID），把公鑰與 Architect 類別接受紀錄（類別雜湊、程式版本、審查來源與版本）寫入批准設定檔，並把該檔改為 root 擁有。這是 S2 的最小替代；完整 S2（D1 獨立簽署帳號、D2 撤銷）仍未完成。',
  'Human 在 Anthropic Console 設定工作區支出上限（供應商端硬上限；CLI 的預算開關不是硬上限），並只讓正式 Host 持有 API 金鑰。',
  '每個任務：Human 在介面查看任務、資料範圍、預算上限與模型，再用通行金鑰批准這一個 Run（最多 15 分鐘內有效、只能用一次）。',
]);
export interface LimitedServiceOptions {
  goals: FileGoalStore; governance: GoalGovernancePort; admission: GoalRunAdmissionPort;
  projects: readonly string[]; store: WorkerStore; quote: Quote | null | (() => Quote | null);
  source(): ReturnType<typeof readPinnedReadme>;
  identity(): { sha: string; codeHash: string; clean: boolean };
  runtime: LimitedRuntime; now(): string;
  measurementClass?:'LOCAL_OBSERVATION'|'OFFLINE_SYNTHETIC';
  /** M0: only the offline rehearsal Host sets this. With an OFFLINE_SYNTHETIC runtime it lets START run under EXE HOLD; nothing else does. */
  allowOfflineStart?: true;
}
/** The runtime the service drives: the composed Worker, plus (M1, real Host only) the passkey approval steps. */
export type LimitedRuntime = Omit<ReturnType<typeof composeLimitedWorker>, 'execute'> & {
  execute(c: Contract, passkey?: unknown): Promise<unknown>;
  requestApproval?(c: Contract, approvedMaxReservationMicroUsd: number): unknown;
  approvalStatus?(c: Contract): unknown;
};
/** M1-B: what the Human sees before approving one run (derived from the contract; nothing here is authority). */
export function approvalPreview(c: Contract, objective: string) {
  const bound = requestBound(c);
  return { task: objective, agentId: c.agentId, provider: c.provider, model: c.model, apiVersion: c.apiVersion,
    dataScope: { repository: c.repository, path: c.sourcePath, sourceSha: c.sourceSha, bytes: c.sourceBytes, sourceHash: c.sourceHash, access: 'READ_ONLY_PINNED_COPY' },
    maxReservationMicroUsd: maximumCost(c), totalCeilingMicroUsd: c.totalCostMicroUsd, priceMicroUsdPerToken: { input: c.quote.inputMicroUsdPerToken, output: c.quote.outputMicroUsdPerToken },
    maxInputTokensPerRequest: c.maxInputTokens, maxOutputTokensPerRequest: c.maxOutputTokens, requestBound: bound, timeoutSeconds: c.timeoutSeconds,
    egressDestinations: [...SCOPE.egressDestinations], delivery: 'README_FINDINGS_REPORT_NO_REPOSITORY_WRITE',
    costEvidence: 'USAGE_TIMES_PUBLISHED_PRICE_NOT_PROVIDER_INVOICE', reservationReleased: false };
}
export function createLimitedWorkerService(options: LimitedServiceOptions): LimitedWorkerPort {
  const projects = new Set(options.projects), fixedQuote = typeof options.quote === 'function' ? null : options.quote ? structuredClone(options.quote) : null;
  const currentQuote = () => typeof options.quote === 'function' ? options.quote() : fixedQuote;
  const offline = () => options.allowOfflineStart === true && options.runtime.transportKind === 'OFFLINE_SYNTHETIC';
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
      resultApplied: applied, exe: EXE, modelAccountAvailability: j.modelPreflight?.evidenceClass !== 'LIVE_PROVIDER' ? 'UNVERIFIED_NO_ACCOUNT_CALL'
        // M1-R1: a fake provider's model metadata never counts as the account's.
        : j.providerEndpoint === 'ANTHROPIC_PUBLIC_API' ? 'ACCOUNT_METADATA_VERIFIED' : 'TEST_REQUESTER_NOT_ACCOUNT',
      maximumReservationMicroUsd: maximumCost(j.contract), report: j.report, notice: 'Operational evidence, not authority. OFFLINE_SYNTHETIC is not real AI acceptance.',
      startedAt: j.events.find(e => e.kind === 'WORST_CASE_RESERVED')?.at ?? null, finishedAt: j.events.filter(e => FINISHED.includes(e.kind)).at(-1)?.at ?? null,
      approvalPreview: approvalPreview(j.contract, g.text), requestBound: requestBound(j.contract),
      liveApproval: options.runtime.approvalStatus ? safely(() => options.runtime.approvalStatus!(j.contract)) : null };
  };
  const safely = (f: () => unknown) => { try { return f(); } catch { return { refusal: 'APPROVAL_STATUS_UNAVAILABLE' }; } };
  const read = (projectId: string, human: HumanPrincipalV1) => {
    if (!projects.has(projectId)) refuse('UNKNOWN_PROJECT', 404);
    const data = options.store.read();
    const totalReserved=data.jobs.reduce((sum,j)=>sum+j.reservedMicroUsd,0);
    const jobs=data.jobs.filter(j=>j.contract.projectId===projectId).map(j=>view(j,human,totalReserved));
    return { exe: EXE, recordClass: 'OPERATIONAL_RECORD', model: MODEL, provider: 'anthropic', apiVersion: API_VERSION,
      agentId: 'limited-readme-worker', agents: [...AGENT_IDS], quote: currentQuote(), accountAvailability: 'UNVERIFIED',
      execution: { evidenceClass: options.runtime.transportKind, startAvailable: offline() || EXE !== 'HOLD',
        authorizationSteps: offline() ? [] : [...LIVE_AUTHORIZATION_STEPS], approvalMethod: offline() ? 'OFFLINE_REHEARSAL_CHECKBOX' : 'PASSKEY_PER_RUN' },
      agentAvailability: Object.fromEntries(AGENT_IDS.map((id) => [id, offline() ? 'OFFLINE_REHEARSAL' : id === 'limited-readme-worker' ? 'LIVE_REQUIRES_APPROVAL' : 'READER_REQUEST_BOUND_UNPROVEN'])),
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
      // M1-A: a live Host does not plan Claude Code reader jobs: no request bound is proven, so no live run could follow.
      if (!offline() && parsed.data.agentId === 'claude-code-reader') return refuse('READER_REQUEST_BOUND_UNPROVEN', 409);
      const prior = options.store.read().jobs.find(j => j.contract.projectId === projectId && j.contract.goalId === g.goalId);
      if (prior) {
        if(prior.contract.inputPolicy?.revision!=='A3')return read(projectId,human);
        const saved=options.store.read().observations?.find(o=>o.id===parsed.data.requestId);
        if(!(saved?.kind==='PLAN_READY'&&saved.jobId===prior.id&&saved.projectId===projectId&&saved.interactionId===(parsed.data.interactionId??null)&&saved.clientElapsedMs===(parsed.data.clientElapsedMs??null)))
          observe(projectId,parsed.data.requestId,'PLAN_REUSED',prior.id,null,parsed.data.interactionId??null,parsed.data.clientElapsedMs??null);
        return read(projectId, human);
      }
      const quote = currentQuote();
      if (!quote) return refuse('PRICE_NOT_VERIFIED', 503);
      try { checkQuote(quote, options.now()); } catch { return refuse('PRICE_QUOTE_EXPIRED', 409); }
      const source = options.source(), identity = options.identity();
      const governed = await options.governance.govern(projectId, g.goalId, human), admitted = await options.admission.admit(projectId, g.goalId, human);
      if (governed.repository !== REPOSITORY) return refuse('REPOSITORY_MISMATCH');
      const c = parseContract({ schemaVersion: 1, kind: 'LIMITED_README_WORKER', repository: REPOSITORY, projectId, goalId: g.goalId,
        objectiveHash: hash(g.text), runId: admitted.runId, implementationSha: identity.sha, workerCodeHash: identity.codeHash,
        sourceSha: source.sha, sourcePath: 'README.md', sourceHash: source.hash, sourceBytes: source.bytes,
        agentId: parsed.data.agentId, ...(parsed.data.agentId === 'claude-code-reader' ? { maxTurns: READER_TURNS } : {}),
        provider: 'anthropic', model: MODEL, apiVersion: API_VERSION,
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
      const codeOf = (error: unknown) => error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : 'WORKER_FAILED_CLOSED';
      if (parsed.data.action === 'REQUEST_APPROVAL') {
        // M1-B: the same gates as START, before the trusted Host derives and stores anything.
        if (EXE === 'HOLD' && !offline()) {observe(projectId,parsed.data.requestId,'START_REFUSED',id,'EXE_HOLD');return refuse('EXE_HOLD', 403);}
        if (offline() || !options.runtime.requestApproval) return refuse('PASSKEY_APPROVAL_NOT_USED_ON_THIS_HOST', 409);
        if (job.state !== 'PREPARED') return refuse('WORK_ALREADY_STARTED_OR_TERMINAL', 409);
        const approved = parsed.data.approval?.maxReservationMicroUsd;
        if (approved === undefined) return refuse('APPROVAL_REQUIRED', 400);
        if (approved !== maximumCost(job.contract)) return refuse('APPROVAL_DOES_NOT_MATCH_COST', 409);
        try { assertLiveRequestBound(job.contract); options.runtime.requestApproval(job.contract, approved); } catch (error) { return refuse(codeOf(error), 409); }
        observe(projectId,parsed.data.requestId,'APPROVAL_REQUESTED',id);
        return read(projectId, human);
      }
      if (parsed.data.action === 'START') {
        // EXE HOLD still stops every run except on the offline rehearsal Host (OFFLINE_SYNTHETIC runtime, explicitly allowed).
        if (EXE === 'HOLD' && !offline()) {observe(projectId,parsed.data.requestId,'START_REFUSED',id,'EXE_HOLD');return refuse('EXE_HOLD', 403);}
        if (job.state !== 'PREPARED') return refuse('WORK_ALREADY_STARTED_OR_TERMINAL', 409);
        const approved = parsed.data.approval?.maxReservationMicroUsd;
        if (approved === undefined) return refuse('APPROVAL_REQUIRED', 400);
        if (approved !== maximumCost(job.contract)) return refuse('APPROVAL_DOES_NOT_MATCH_COST', 409);
        // M1-A/B: a live run needs a proven request bound and the Human's passkey assertion for this run's payload.
        if (!offline()) {
          try { assertLiveRequestBound(job.contract); } catch (error) { return refuse(codeOf(error), 409); }
          if (!parsed.data.passkey) return refuse('PASSKEY_APPROVAL_REQUIRED', 400);
        }
        // Refuse before activation when the cumulative ceiling cannot hold this job's worst case (the Worker re-checks
        // at reservation). Reservations are conservative and are not released when a job completes.
        const ledger = options.store.read();
        if (ledger.jobs.reduce((sum, j) => sum + j.reservedMicroUsd, 0) + maximumCost(job.contract) > ledger.ceilingMicroUsd) return refuse('TOTAL_COST_LIMIT', 409);
        observe(projectId,parsed.data.requestId,'START_APPROVED',id);
        try { await options.runtime.execute(job.contract, offline() ? undefined : parsed.data.passkey); }
        catch (error) { return refuse(codeOf(error), 409); }
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
