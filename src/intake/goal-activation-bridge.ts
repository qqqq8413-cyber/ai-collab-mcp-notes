import type { GovernedActivationCore } from '../automation/activation-core.js';
import type { HumanPrincipalV1 } from '../identity/canonical.js';
import { GoalActivationError, type GoalActivationPort, type GoalActivationView, type GoalActivationResult } from '../workspace/goal-activation-port.js';
import type { GoalExecutionStatusPort } from '../workspace/goal-execution-status-port.js';
import type { FileGoalStore } from '../workspace/goal-store.js';
import { goalSourceOf } from './goal-change-binding.js';
import type { TrustedActivationPlan } from './activation-plan-preflight.js';

// The ONLY input from a browser is its Goal path. The pre-provisioned complete
// authority documents never leave this bridge. A Workspace cookie is not Human
// authentication, and this bridge never issues or edits a document.
export function createGoalActivationBridge(options: {
  status: GoalExecutionStatusPort;
  activation: GovernedActivationCore;
  store: FileGoalStore;
  plans: readonly TrustedActivationPlan[];
  architectPrincipalRef: string;
}): GoalActivationPort {
  const plans = new Map(options.plans.map((plan) => [JSON.stringify([plan.projectId, plan.goalId]), plan]));
  const busy = new Set<string>();
  const inspect = (projectId: string, goalId: string, human: HumanPrincipalV1) => {
    // Always validate the durable Goal attribution and exact governed Change first,
    // including where no plan exists. Never use a browser-supplied run identity.
    const observed = options.status.inspect(projectId, goalId, human);
    const plan = plans.get(JSON.stringify([projectId, goalId]));
    const run = observed.run?.admission === 'ROOT' && observed.change && observed.status !== 'GOVERNANCE_CONFLICT'
      ? observed.run : null;
    const target = run ? { source: goalSourceOf(projectId, goalId), runId: run.runId } : null;
    const view = (readiness: GoalActivationView['readiness'], state: string | null, reason: string | null): GoalActivationView => ({
      recordClass: 'OPERATIONAL_RECORD', authority: 'NOT_EXECUTION_AUTHORITY',
      readiness, canActivate: !!plan && (readiness === 'READY' || readiness === 'RETRY_REQUIRED'),
      state, packetId: plan?.bundle.implementationPacket.authorityId ?? null, reason,
    });
    if (!target) return { target: null, plan, view: view('NO_ROOT', observed.run?.state ?? null, observed.reason ?? observed.status) };
    if (!plan) return { target, plan, view: view('NO_APPROVED_PLAN', run!.state, null) };
    // AP1 inspects R4A0 and Controller lineage without mutating either.
    const position = options.activation.inspect(target);
    if (position.changeKey !== observed.change!.changeKey || position.repository !== observed.change!.repository ||
        position.humanPrincipalRef !== human.principalRef || position.target.runId !== target.runId) {
      throw new GoalActivationError('ACTIVATION_BINDING_CONFLICT');
    }
    const packet = plan.bundle.implementationPacket;
    const subject = { repository: position.repository, sliceId: position.change.changeId };
    const all = [packet, ...plan.bundle.liveCallAuthorizations];
    if (packet.issuer.role !== 'GPT_ARCHITECT' || packet.issuer.principalRef !== options.architectPrincipalRef ||
        packet.body.sliceId !== subject.sliceId || all.some((doc) => doc.subject.repository !== subject.repository ||
          doc.subject.sliceId !== subject.sliceId) ||
        plan.bundle.liveCallAuthorizations.some((doc) => doc.issuer.role !== 'HUMAN' ||
          doc.issuer.principalRef !== human.principalRef)) {
      return { target, plan, changeKey: observed.change!.changeKey, view: view('PLAN_MISMATCH', position.state,
        'HOST_DOCUMENT_BINDING_MISMATCH') };
    }
    const readiness = ({ IDLE: 'READY', ARCHITECTURE_ENTERED: 'RETRY_REQUIRED',
      PACKET_READY: 'ALREADY_ACTIVATED', ADVANCED: 'ADVANCED' } as const)[position.position];
    return { target, plan, changeKey: observed.change!.changeKey, view: view(readiness, position.state, null) };
  };
  return Object.freeze({
    inspect(projectId: string, goalId: string, human: HumanPrincipalV1) {
      return inspect(projectId, goalId, human).view;
    },
    async activate(projectId: string, goalId: string, human: HumanPrincipalV1): Promise<GoalActivationResult> {
      const key = JSON.stringify([projectId, goalId]);
      if (busy.has(key)) throw new GoalActivationError('ACTIVATION_BUSY');
      busy.add(key);
      try {
        // This same Goal lock serializes GC1, RA1, removal and this activation.
        // There are no implicit retries of an uncertain external side effect.
        return await options.store.withLockedGoal(projectId, goalId, () => {
          const before = inspect(projectId, goalId, human);
          if (before.view.readiness === 'ALREADY_ACTIVATED' && before.plan) {
            // AP1's exact bound lineage has already been checked by inspect.
            // No authority is re-issued and no Controller transition is repeated.
            return { recordClass: 'OPERATIONAL_RECORD', authority: 'NOT_EXECUTION_AUTHORITY',
              status: 'ALREADY_ACTIVATED', readiness: before.view } as const;
          }
          if (!before.view.canActivate || !before.target || !before.plan) {
            return { recordClass: 'OPERATIONAL_RECORD', authority: 'NOT_EXECUTION_AUTHORITY',
              status: 'NOT_ACTIVATED', readiness: before.view } as const;
          }
          try {
            const result = options.activation.activate(before.target, before.plan.bundle);
            if (result.target.runId !== before.target.runId || result.changeKey !== before.changeKey) {
              throw new GoalActivationError('ACTIVATION_BINDING_CONFLICT');
            }
            let after: GoalActivationView;
            try { after = inspect(projectId, goalId, human).view; }
            catch { after = { ...before.view, canActivate: false, reason: 'POST_ACTIVATION_OBSERVATION_UNAVAILABLE' }; }
            return { recordClass: 'OPERATIONAL_RECORD', authority: 'NOT_EXECUTION_AUTHORITY',
              status: result.status, readiness: after } as const;
          } catch (error) {
            if (error instanceof GoalActivationError) throw error;
            // AP1 returns bounded codes; no body, issuer or trusted path is disclosed.
            throw new GoalActivationError('ACTIVATION_REFUSED');
          }
        });
      } finally { busy.delete(key); }
    },
  });
}
