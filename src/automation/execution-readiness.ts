import { GOVERNED_READ_MODEL_SCHEMA, type GovernedReadModelV1, type GovernedRunV1, type NextActionConflictV1 } from './read-model/governed-read-model.js';
import type { ActorKind, ControllerState, Role } from './types.js';

// The governed readiness of one exact run, decided from one R4A0 snapshot alone. It is the one
// interpretation of R4A0's NextAction for the runner protocol and of RP1 operational
// provenance (G1-RP1-C1): the LD1 execution driver acts on it, and the read-only Workspace
// execution status bridge (G1-WE1-R0) reports it. It is pure: it reads nothing, writes
// nothing, holds no store, runner or grant, and never decides whether a model call is
// authorized (that needs the live-call grants only LD1 holds). RUNNER_MOVE means only that
// the runner protocol owns the next move and the run's lineage is governed.

/** The runner protocol: the exact R4A0 moves under which a runner step is the governed next move, and whose model call it is. */
export interface RunnerProtocolV1 { moves: string[]; actor: ActorKind | null }
const PROTOCOL: Readonly<Partial<Record<ControllerState, RunnerProtocolV1>>> = Object.freeze({
  PACKET_READY: { moves: ['BEGIN_IMPLEMENTATION/CODEX_IMPLEMENTER/IMPLEMENTING'], actor: 'IMPLEMENTATION' },
  CORRECTION_REQUIRED: { moves: ['BEGIN_IMPLEMENTATION/CODEX_IMPLEMENTER/IMPLEMENTING'], actor: 'IMPLEMENTATION' },
  IMPLEMENTING: { moves: ['REPORT_IMPLEMENTATION_COMPLETE/CODEX_IMPLEMENTER/IMPLEMENTATION_COMPLETE'], actor: 'IMPLEMENTATION' },
  IMPLEMENTATION_COMPLETE: { moves: ['RECORD_REMOTE_SHA/CODEX_IMPLEMENTER/REMOTE_SHA_READY'], actor: null },
  REMOTE_SHA_READY: { moves: ['BEGIN_REMOTE_ACCEPTANCE/GPT_ARCHITECT/ACCEPTANCE_REVIEW'], actor: 'ARCHITECT_REVIEW' },
  ACCEPTANCE_REVIEW: { moves: ['ACCEPT_EXACT_SHA/GPT_ARCHITECT/ACCEPTED', 'REJECT_EXACT_SHA/GPT_ARCHITECT/CORRECTION_REQUIRED'],
    actor: 'ARCHITECT_REVIEW' },
});
const REISSUES: ReadonlySet<string> = new Set(['ENTER_ARCHITECTURE', 'ISSUE_PACKET', 'RETURN_TO_ARCHITECTURE']);
const DECISIONS: ReadonlySet<string> = new Set(['BEGIN_REMOTE_ACCEPTANCE', 'ACCEPT_EXACT_SHA', 'REJECT_EXACT_SHA', 'ISSUE_CORRECTION_PACKET']);

/** The bounded G1-RP1-C1 reasons a run's provenance is not the governed lineage. */
export const PROVENANCE_REFUSALS = Object.freeze(['ACTIVATION_LINEAGE_MISSING', 'ACTIVATION_LINEAGE_FOREIGN', 'ACTIVATION_PACKET_MISMATCH',
  'PACKET_REISSUED', 'REVIEW_LINEAGE_FOREIGN', 'CORRECTION_LINEAGE_FOREIGN', 'CORRECTION_LINEAGE_UNBOUND'] as const);
export type ProvenanceRefusal = typeof PROVENANCE_REFUSALS[number];

/**
 * Why the run's recorded provenance is not the governed lineage a runner step may execute on; null when it is.
 * PACKET_READY or any later state is not provenance: the active packet must have been issued by the AP1-bound
 * architecture entry of the configured Architect, with no later re-entry, re-issue or return to architecture, and
 * every review entry, decision and correction that principal's, each correction directly after its rejection.
 */
export function lineageRefusal(run: GovernedRunV1, principalRef: string): ProvenanceRefusal | null {
  const { activationBinding: binding, architectEntries: entries } = run.provenance;
  const [entered, issued] = entries;
  if (!binding || entered?.sequence !== 1 || entered.action !== 'ENTER_ARCHITECTURE' || issued?.sequence !== 2 ||
      issued.action !== 'ISSUE_PACKET') return 'ACTIVATION_LINEAGE_MISSING';
  if (entered.actor !== principalRef || issued.actor !== principalRef) return 'ACTIVATION_LINEAGE_FOREIGN';
  for (const entry of entries.slice(2)) {
    if (REISSUES.has(entry.action)) return 'PACKET_REISSUED';
    if (!DECISIONS.has(entry.action)) continue;
    if (entry.actor !== principalRef) return entry.action === 'ISSUE_CORRECTION_PACKET' ? 'CORRECTION_LINEAGE_FOREIGN' : 'REVIEW_LINEAGE_FOREIGN';
    if (entry.action === 'ISSUE_CORRECTION_PACKET' &&
        entries.find((prior) => prior.sequence === entry.sequence - 1)?.action !== 'REJECT_EXACT_SHA') return 'CORRECTION_LINEAGE_UNBOUND';
  }
  if (issued.packetId !== binding.packetId || issued.packetHash !== binding.packetHash || run.packet?.packetId !== binding.packetId ||
      run.packet.packetHash !== binding.packetHash) return 'ACTIVATION_PACKET_MISMATCH';
  return null;
}

export type GovernedRunOutcome = 'RUNNER_MOVE' | 'BLOCKED_AUTHORITY' | 'BLOCKED_PROVENANCE' | 'WAITING_EXTERNAL_ACTOR' | 'WAITING_HUMAN' |
  'TERMINAL' | 'RUN_NOT_FOUND' | 'TARGET_MISMATCH' | 'ADMISSION_INVALID' | 'READ_MODEL_CONFLICT';

export interface GovernedRunAssessmentV1 {
  outcome: GovernedRunOutcome;
  /** A bounded reason code; null for RUNNER_MOVE. */
  reason: string | null;
  /** The R4A0 snapshot read, once its contract holds. */
  snapshotId: string | null;
  /** The run, once it is known to be exactly this Change's. */
  run: GovernedRunV1 | null;
  state: ControllerState | null;
  /** R4A0's NextAction moves and conflicts for the run's Change, once its view is valid. */
  nextMoves: { action: string; role: Role }[];
  conflicts: NextActionConflictV1[];
  /** RUNNER_MOVE only. */
  protocol: RunnerProtocolV1 | null;
}

const moveKey = ({ action, role, toState }: { action: string; role: Role; toState: ControllerState }) => `${action}/${role}/${toState}`;

/** The readiness of `runId` as the exact ROOT run of `change`, from one R4A0 snapshot and the configured Architect principal. */
export function assessGovernedRun(model: GovernedReadModelV1, change: { repository: string; sliceId: string; changeKey: string },
  runId: string, principalRef: string): GovernedRunAssessmentV1 {
  const facts: Omit<GovernedRunAssessmentV1, 'outcome' | 'reason'> = { snapshotId: null, run: null, state: null, nextMoves: [],
    conflicts: [], protocol: null };
  const answer = (outcome: GovernedRunOutcome, reason: string | null): GovernedRunAssessmentV1 => ({ outcome, reason, ...facts });

  if (model.schema !== GOVERNED_READ_MODEL_SCHEMA || model.schemaVersion !== 1 || model.rulesetRef !== 'CHIEF-GOV/1' ||
      model.continuation !== 'NOT_IMPLEMENTED') return answer('READ_MODEL_CONFLICT', 'READ_MODEL_CONTRACT');
  facts.snapshotId = model.snapshot.id;

  // The run, exactly once, belonging to exactly this Change, as its admitted ROOT.
  const runs = model.runs.filter((run) => run.runId === runId);
  if (!runs.length) return answer('RUN_NOT_FOUND', 'RUN_NOT_IN_STORE');
  if (runs.length > 1) return answer('READ_MODEL_CONFLICT', 'RUN_DUPLICATED');
  const [run] = runs as [GovernedRunV1];
  if (run.repository !== change.repository || run.sliceId !== change.sliceId || run.changeKey !== change.changeKey) {
    return answer('TARGET_MISMATCH', 'RUN_OF_ANOTHER_CHANGE');
  }
  facts.run = run;
  facts.state = run.state;
  if (run.admission.status !== 'ROOT' || run.admission.rootRunId !== run.runId) return answer('ADMISSION_INVALID', `ADMISSION_${run.admission.status}`);
  const views = model.changes.filter((view) => view.changeKey === change.changeKey);
  if (views.length !== 1 || views[0].repository !== change.repository || views[0].change.changeId !== change.sliceId ||
      !views[0].runs.some((member) => member.runId === run.runId)) return answer('READ_MODEL_CONFLICT', 'CHANGE_VIEW_INVALID');
  const { nextAction, anomalies } = views[0];
  facts.nextMoves = nextAction.moves.map(({ action, role }) => ({ action, role }));
  facts.conflicts = [...nextAction.conflicts];

  // Governed readiness, exactly as R4A0 states it.
  if (run.anomalies.length || anomalies.length || nextAction.conflicts.some((conflict) => conflict.scope !== 'AUTHORITY')) {
    return answer('READ_MODEL_CONFLICT', 'GOVERNANCE_ANOMALY');
  }
  if (nextAction.conflicts.length) return answer('BLOCKED_AUTHORITY', 'AUTHORITY_UNRESOLVED');
  if (nextAction.determinacy !== 'DETERMINATE') return answer('READ_MODEL_CONFLICT', 'INDETERMINATE');
  if (run.terminal) return answer('TERMINAL', 'TERMINAL_STATE');

  // Only the runner protocol's own move is the runner's; every other move belongs to someone else.
  const protocol = PROTOCOL[run.state];
  const moves = nextAction.moves.map(moveKey);
  if (!protocol || moves.length !== protocol.moves.length || moves.some((move, index) => move !== protocol.moves[index])) {
    const human = nextAction.moves.length > 0 && nextAction.moves.every((move) => move.role === 'HUMAN');
    return answer(human ? 'WAITING_HUMAN' : 'WAITING_EXTERNAL_ACTOR', 'NOT_A_RUNNER_MOVE');
  }

  // G1-RP1-C1: what a runner step executes on must carry the governed lineage, not merely look valid.
  const refusal = lineageRefusal(run, principalRef);
  if (refusal) return answer('BLOCKED_PROVENANCE', refusal);
  facts.protocol = { moves: [...protocol.moves], actor: protocol.actor };
  return answer('RUNNER_MOVE', null);
}
