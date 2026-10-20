import { z } from 'zod';
import type { FileGoalStore } from '../workspace/goal-store.js';
import type { GoalGovernancePort } from '../workspace/goal-governance-port.js';
import type { GoalRunAdmissionPort } from '../workspace/goal-run-admission-port.js';
import type { HumanPrincipalV1 } from '../identity/canonical.js';
import { LimitedWorkerRequestError, type LimitedWorkerPort } from '../workspace/limited-worker-port.js';
import { EXE, MODEL, API_VERSION, REPOSITORY, hash, parseContract, maximumCost, packetFor, checkQuote, type Quote } from './contract.js';
import { packetHash } from '../automation/packet.js';
import { WorkerStore, type Job } from './store.js';
import type { composeLimitedWorker } from './composition.js';
import type { readPinnedReadme } from './source.js';

const createInput = z.strictObject({ requestId: z.string().uuid(), goalId: z.string().regex(/^goal-[a-f0-9-]{36}$/), agentId: z.literal('limited-readme-worker') });
const actions = z.strictObject({ requestId: z.string().uuid(), action: z.enum(['CHECK', 'START', 'CANCEL']) });
export interface LimitedServiceOptions {
  goals: FileGoalStore; governance: GoalGovernancePort; admission: GoalRunAdmissionPort;
  projects: readonly string[]; store: WorkerStore; quote: Quote | null;
  source(): ReturnType<typeof readPinnedReadme>;
  identity(): { sha: string; codeHash: string; clean: boolean };
  runtime: ReturnType<typeof composeLimitedWorker>; now(): string;
}
export function createLimitedWorkerService(options: LimitedServiceOptions): LimitedWorkerPort {
  const projects = new Set(options.projects), quote = options.quote ? structuredClone(options.quote) : null;
  const refuse = (code: string, status = 409): never => { throw new LimitedWorkerRequestError(code, status); };
  const goal = (projectId: string, goalId: string, human: HumanPrincipalV1) => {
    if (!projects.has(projectId)) refuse('UNKNOWN_PROJECT', 404);
    const g = options.goals.read(projectId).goals.find(g => g.goalId === goalId);
    if (!g) return refuse('UNKNOWN_GOAL', 404);
    if (g.submittedBy?.principalRef !== human.principalRef || human.kind !== 'HUMAN') refuse('GOAL_PRINCIPAL_MISMATCH', 403);
    return g;
  };
  const view = (j: Job, human: HumanPrincipalV1) => {
    const g = goal(j.contract.projectId, j.contract.goalId, human), conditions = ['EXE_HOLD', 'H1_H9_NOT_GRANTED', 'ACCOUNT_MODEL_UNVERIFIED'];
    if (hash(g.text) !== j.contract.objectiveHash) refuse('GOAL_BINDING_MISMATCH');
    try { checkQuote(j.contract.quote, options.now()); } catch { conditions.push('PRICE_QUOTE_EXPIRED'); }
    const identity = options.identity(); if (identity.sha !== j.contract.implementationSha || identity.codeHash !== j.contract.workerCodeHash || !identity.clean) conditions.push('IMPLEMENTATION_NOT_ACCEPTED_OR_CHANGED');
    let permit: unknown = null, authorityStatus = 'MISSING_OR_INVALID';
    try { permit = options.runtime.permit(j.contract); authorityStatus = 'ARCHIVED_BINDING_VALID'; } catch { conditions.push('LIMITED_PERMIT_MISSING_OR_INVALID'); }
    const observed = options.runtime.inspect(j.contract);
    const applied = options.store.reportIsValid(j) && observed.journal.some(r => r.invocationId === j.invocationId && r.state === 'APPLIED') && observed.driver.state === 'IMPLEMENTATION_COMPLETE';
    return { ...j, objective: g.text, conditions, authorityStatus, authority: permit, driver: observed.driver, invocations: observed.journal,
      effectiveState: j.state === 'COMPLETED' && !applied ? 'RESULT_REQUIRES_RECONCILIATION' : j.state,
      resultApplied: applied, exe: EXE, modelAccountAvailability: j.modelPreflight?.evidenceClass === 'LIVE_PROVIDER' ? 'ACCOUNT_METADATA_VERIFIED' : 'UNVERIFIED_NO_ACCOUNT_CALL',
      maximumReservationMicroUsd: maximumCost(j.contract), report: j.report, notice: 'Operational evidence, not authority. OFFLINE_SYNTHETIC is not real AI acceptance.' };
  };
  const read = (projectId: string, human: HumanPrincipalV1) => {
    if (!projects.has(projectId)) refuse('UNKNOWN_PROJECT', 404);
    const data = options.store.read();
    return { exe: EXE, recordClass: 'OPERATIONAL_RECORD', model: MODEL, provider: 'anthropic', apiVersion: API_VERSION,
      agentId: 'limited-readme-worker', quote, accountAvailability: 'UNVERIFIED',
      totalReservedMicroUsd: data.jobs.reduce((sum,j) => sum+j.reservedMicroUsd,0), totalCeilingMicroUsd: data.ceilingMicroUsd,
      jobs: data.jobs.filter(j => j.contract.projectId === projectId).map(j => view(j, human)) };
  };
  return Object.freeze({ read,
    async prepare(projectId: string, input: unknown, human: HumanPrincipalV1) {
      const parsed = createInput.safeParse(input); if (!parsed.success) return refuse('INVALID_WORKER_PLAN', 400);
      const g = goal(projectId, parsed.data.goalId, human);
      const prior = options.store.read().jobs.find(j => j.contract.projectId === projectId && j.contract.goalId === g.goalId);
      if (prior) return read(projectId, human);
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
        maxInputTokens: 200000, maxOutputTokens: 2048, maxCalls: 1, maxRetries: 0, maxCostMicroUsd: 1000000, totalCostMicroUsd: 1000000, timeoutSeconds: 300, quote });
      options.store.create(c, options.now()); return read(projectId, human);
    },
    async action(projectId: string, id: string, input: unknown, human: HumanPrincipalV1) {
      const parsed = actions.safeParse(input); if (!parsed.success) return refuse('INVALID_WORKER_ACTION', 400);
      const job = options.store.read().jobs.find(j => j.id === id && j.contract.projectId === projectId); if (!job) return refuse('UNKNOWN_JOB', 404);
      goal(projectId, job.contract.goalId, human);
      if (parsed.data.action === 'START') {
        if (EXE === 'HOLD') return refuse('EXE_HOLD', 403);
        await options.runtime.execute(job.contract);
      }
      if (parsed.data.action === 'CANCEL') {
        const active = options.runtime.cancel(job.contract);
        if (!active && job.state === 'PREPARED') options.store.change(id, j => { j.state = 'CANCELLED'; j.reason = 'USER_CANCEL_BEFORE_REQUEST'; j.events.push({ at: options.now(), kind: 'USER_CANCEL_BEFORE_REQUEST' }); });
      }
      return read(projectId, human);
    },
  });
}
export function pilotPacket(job: Job, sliceId: string) {
  const packet = packetFor(job.contract, sliceId);
  return { state: 'UNISSUED_NOT_AUTHORITY', exe: EXE, contract: job.contract, contractHash: hash(job.contract), implementationPacket: packet,
    packetHash: packetHash(packet), requiredHumanOperations: ['LIVE_PROVIDER_MODEL_CALL', 'LIMITED_README_WORKER'],
    limitedPermitTarget: hash(job.contract), issuedAt: null, expiresAt: null, maxValiditySeconds: 3600 };
}
