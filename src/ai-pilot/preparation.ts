import { z } from 'zod';
import { parseHumanPrincipalV1, type HumanPrincipalV1 } from '../identity/canonical.js';
import type { ExecutionInspectionV1 } from '../automation/execution-driver.js';
import { digest } from '../pilot/store.js';
import { AiPilotRequestError, type AiPilotPort } from '../workspace/ai-pilot-port.js';
import type { FileGoalStore, GoalRecord } from '../workspace/goal-store.js';
import type { GoalGovernancePort } from '../workspace/goal-governance-port.js';
import type { GoalRunAdmissionPort } from '../workspace/goal-run-admission-port.js';
import type { GoalExecutionStatusPort } from '../workspace/goal-execution-status-port.js';
import { AGENTS, planInput, PreparationStore, type Plan } from './plans.js';

const actions = z.strictObject({ action: z.enum(['PREPARE', 'CHECK', 'START']), requestId: z.string().uuid() });
export interface PreparationOptions {
  dataDirectory: string;
  repositories: Readonly<Record<string, string>>;
  store: FileGoalStore;
  governance?: GoalGovernancePort;
  runAdmission?: GoalRunAdmissionPort;
  executionStatus?: GoalExecutionStatusPort;
  /** Only inspect/list leave the trusted composition; no step or journal writer is accepted. */
  driverInspection?: { inspect(target: unknown): ExecutionInspectionV1 };
  invocationInspection?: { list(runId: string): Array<{ invocationId: string; state: string }> };
  clock?: () => string;
}

export function createAiPilotPreparation(options: PreparationOptions): AiPilotPort {
  const plans = new PreparationStore(options.dataDirectory);
  const repositories = Object.freeze({ ...options.repositories });
  const now = options.clock ?? (() => new Date().toISOString());
  const project = (projectId: string) => {
    if (!Object.hasOwn(repositories, projectId)) throw new AiPilotRequestError('UNKNOWN_PROJECT', 404, 'AI Pilot 未綁定此專案。');
    return repositories[projectId];
  };
  const goalOf = (projectId: string, goalId: string, principal: HumanPrincipalV1): GoalRecord => {
    project(projectId); const human = parseHumanPrincipalV1(principal);
    const goal = options.store.read(projectId).goals.find(g => g.goalId === goalId);
    if (!goal) throw new AiPilotRequestError('UNKNOWN_GOAL', 404, '找不到此工作的原始目標。');
    if (!goal.submittedBy || goal.submittedBy.principalRef !== human.principalRef) throw new AiPilotRequestError('GOAL_PRINCIPAL_MISMATCH', 403, '目標不屬於目前的 Human。');
    return goal;
  };
  const planOf = (projectId: string, planId: string, principal: HumanPrincipalV1) => {
    const plan = plans.read(projectId).find(p => p.requestId === planId);
    if (!plan) throw new AiPilotRequestError('UNKNOWN_PLAN', 404, '找不到工作準備紀錄。');
    const goal = goalOf(projectId, plan.goalId, principal);
    if (plan.principalRef !== principal.principalRef || plan.objectiveHash !== digest(goal.text)) throw new AiPilotRequestError('PLAN_BINDING_CONFLICT', 409, '準備紀錄與原始目標不一致；不採納或修補。');
    return { plan, goal };
  };
  const inspect = (projectId: string, plan: Plan, principal: HumanPrincipalV1) => {
    let goal: GoalRecord | undefined;
    try { goal = planOf(projectId, plan.requestId, principal).goal; }
    catch (error) {
      if (!(error instanceof AiPilotRequestError) || error.code !== 'UNKNOWN_GOAL') throw error;
    }
    const governed = goal ? options.governance?.lookup(projectId, goal.goalId, principal) ?? null : null;
    const admitted = goal ? options.runAdmission?.lookup(projectId, goal.goalId, principal) ?? null : null;
    const execution = goal ? options.executionStatus?.inspect(projectId, goal.goalId, principal) ?? null : null;
    const target = admitted?.runId ? { source: { kind: 'WORKSPACE_GOAL' as const, projectId, goalId: plan.goalId }, runId: admitted.runId } : null;
    const driver = target && options.driverInspection ? options.driverInspection.inspect(target) : null;
    const journal = target && options.invocationInspection ? options.invocationInspection.list(target.runId).map(r => ({ invocationId: r.invocationId, state: r.state })) : null;
    const agent = AGENTS.find(a => a.id === plan.agentId)!;
    const blockers = ['EXE_HOLD', 'H1_H9_NOT_GRANTED', 'MODEL_BINDING_NOT_PROBED', 'COST_ENFORCEMENT_NOT_IMPLEMENTED', 'SINGLE_TASK_ADAPTER_NOT_AVAILABLE'];
    if (!goal) blockers.push('SOURCE_GOAL_REMOVED');
    if (!options.governance) blockers.push('GOVERNANCE_NOT_CONFIGURED');
    if (!options.runAdmission) blockers.push('ADMISSION_NOT_CONFIGURED');
    if (!options.executionStatus) blockers.push('AUTHORITY_STATUS_NOT_CONFIGURED');
    if (!options.driverInspection) blockers.push('DRIVER_NOT_COMPOSED');
    if (!options.invocationInspection) blockers.push('INVOCATION_READER_NOT_COMPOSED');
    if (agent.adapterRole === 'IMPLEMENTATION') blockers.push('IMPLEMENTATION_ADAPTER_REQUIRES_BRANCH_WRITES');
    else blockers.push('REVIEW_ADAPTER_REQUIRES_IMPLEMENTATION_LINEAGE');
    return { ...plan, objective: goal?.text ?? null, sourceMissing: !goal, agent, exe: 'HOLD', modelCallsIssuedByPreparation: 0, authorityIssuedByPreparation: false,
      governance: governed, admission: admitted, execution, driverInspection: driver, invocations: journal,
      readiness: 'BLOCKED', blockers,
      permit: { kind: 'AI_PILOT_PERMIT_PROPOSAL', state: 'DRAFT_NOT_AUTHORITY', repository: project(projectId), goalId: plan.goalId,
        objectiveHash: plan.objectiveHash, agentId: plan.agentId, provider: agent.provider, requestedModel: plan.requestedModel,
        modelVerification: 'NOT_PROBED', baseSha: '913385b0e1b8f8c529152a091255f46cad67787a',
        taskType: 'READ_ONLY_DOCUMENT_REVIEW', sourceFiles: ['README.md'], maxSourceBytes: 16384,
        tools: ['READ_BOUND_SOURCE', 'WRITE_ISOLATED_RESULT'], allowedWrite: 'ONE_ISOLATED_OUTPUT_DIRECTORY',
        forbidden: ['SOURCE_WRITE', 'GIT_WRITE', 'PUSH', 'DEPLOY', 'HUMAN_AUTHORITY_WRITE', 'SHELL', 'AI_TO_AI', 'WEB_SEARCH'],
        externalSideEffects: ['ONE_EXACT_MODEL_REQUEST_IF_LATER_AUTHORIZED'], maxCostUsd: 1, pricing: null, costEnforced: false,
        maxInputTokens: 4096, maxOutputTokens: 2048, maxCalls: 1, timeoutSeconds: 300, maxRetries: 0, mode: 'MANUAL',
        validity: { durationSeconds: 3600, notBefore: null, expiresAt: null, state: 'UNISSUED' },
        stop: 'CANCEL_MODEL_PROCESS_AND_WAIT_FOR_HUMAN', formalAuthority: 'EXISTING_AUTHORITY_ARCHIVE_ONLY' } };
  };
  return Object.freeze({
    list(projectId: string, principal: HumanPrincipalV1) {
      project(projectId); parseHumanPrincipalV1(principal);
      return { recordClass: 'OPERATIONAL_RECORD', exe: 'HOLD', agents: AGENTS, plans: plans.read(projectId)
        .filter(p => p.principalRef === principal.principalRef).map(p => inspect(projectId, p, principal)) };
    },
    create(projectId: string, input: unknown, principal: HumanPrincipalV1) {
      const parsed = planInput.safeParse(input);
      if (!parsed.success) throw new AiPilotRequestError('INVALID_PLAN', 400, '只接受既有目標與指定 Agent，不接受授權、工具或預算覆寫。');
      const goal = goalOf(projectId, parsed.data.goalId, principal), agent = AGENTS.find(a => a.id === parsed.data.agentId)!;
      plans.add(projectId, { ...parsed.data, objectiveHash: digest(goal.text), createdAt: now(), principalRef: principal.principalRef,
        recordClass: 'OPERATIONAL_RECORD', state: 'PERMIT_DRAFT', requestedModel: agent.requestedModel });
      return this.list(projectId, principal);
    },
    async action(projectId: string, planId: string, input: unknown, principal: HumanPrincipalV1) {
      const parsed = actions.safeParse(input);
      if (!parsed.success) throw new AiPilotRequestError('INVALID_PLAN_ACTION', 400, '不接受未定義操作或授權欄位。');
      const { goal } = planOf(projectId, planId, principal);
      if (parsed.data.action === 'START') throw new AiPilotRequestError('EXE_HOLD', 403, 'EXE HOLD：這是權限申請草案，不是 Human 授權；未呼叫 Driver 或模型。');
      if (parsed.data.action === 'PREPARE') {
        if (!options.governance || !options.runAdmission) throw new AiPilotRequestError('PREPARATION_NOT_CONFIGURED', 503, '尚未接通既有治理／admission；不以模擬資料補上。');
        await options.governance.govern(projectId, goal.goalId, principal);
        await options.runAdmission.admit(projectId, goal.goalId, principal);
      }
      return this.list(projectId, principal);
    },
  });
}
