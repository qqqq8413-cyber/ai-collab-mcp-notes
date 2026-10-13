import { authorityBodyHash, type AuthorityRefV1, type JsonObject } from './authority/document.js';
import { ChangeMintError, parseChangeSourceIdentity, type ChangeMintRecordV1, type ChangeSourceIdentityV1 } from './change-mint.js';
import { openChangeRegistryReader } from './change-registry.js';
import { parseEgressSet } from './egress-destination.js';
import { LIVE_PROVIDER_MODEL_CALL_TARGET, authorizationBinds, parseAuthorization } from './policy.js';
import {
  GOVERNED_READ_MODEL_SCHEMA, GovernedReadError, readGovernedModel, type GovernedReadModelV1, type GovernedRunV1,
  type NextActionConflictV1,
} from './read-model/governed-read-model.js';
import { RUNNER_OUTCOMES, type RunnerOutcome, type RunnerPositionGuard, type RunnerResult } from './runner.js';
import { SYSTEM_CLOCK } from './time.js';
import { ACTOR_KINDS, type ActorKind, type Clock, type ControllerState, type ProviderCallScope, type Role } from './types.js';

// G1-LD1: the governed one-step execution driver. Between an admitted RA1 ROOT run and the
// existing live AutomationRunner it decides one thing: may this exact governed work take
// exactly one runner step now. It answers from protected evidence only:
//
// - The target names a Workspace Goal source and the run expected for it. Repository, slice
//   and changeKey are never supplied: they come from the CM1 record the Change Registry holds
//   for that source, and the run must be that Change's admitted R4L ROOT.
// - Readiness is R4A0's (readGovernedModel): the run and its Change exist once, no store
//   anomaly, NextAction DETERMINATE with no conflict, so every authority body the run
//   retains resolves to its exact archived version. Lifecycle rules are not re-derived here.
// - The runner is called only where R4A0's exact next moves are the runner protocol's own
//   for that state. Every other move is someone else's and is reported, never taken.
// - A step that prepares or dispatches a model call also needs the configured live-call
//   grant for that actor to bind this run, its active packet and the exact actor scope, and
//   to be archived in R4P as that exact HUMAN AUTHORIZATION version for this Change. The
//   runner's own dispatch gate (time, packet entry, egress, budget) still runs unchanged.
//
// G1-RP1-C1: current state and resolved authority are not provenance. A runner move is READY
// only when R4A0's operational provenance shows the governed lineage of what it executes on:
// the active packet issued by the AP1-bound architecture entry of the configured Architect
// principal (binding present, both entries that principal's, active packet = binding), no later
// architecture entry, packet issue or return to architecture (no governed re-activation path
// exists), and every review entry, decision and correction in the run's history that principal's,
// each correction directly after the rejection it answers. inspect and step share this gate.
//
// One step() calls runner.step at most once, bound to the exact audit position the gate
// read, so a run another writer moved is never stepped from a position nobody gated. There
// is no loop, retry or continuation. Nothing here mints a Change, creates a run, writes a
// Controller transition itself, or appends authority. Results are operational records:
// identifiers, states and bounded reason codes, never a path, a body, a grant or a payload.

export const EXECUTION_READINESS = Object.freeze(['READY', 'BLOCKED_AUTHORITY', 'BLOCKED_PROVENANCE', 'WAITING_EXTERNAL_ACTOR', 'WAITING_HUMAN',
  'TERMINAL', 'EXECUTION_TARGET_INVALID', 'EXECUTION_CHANGE_NOT_FOUND', 'EXECUTION_RUN_NOT_FOUND', 'EXECUTION_TARGET_MISMATCH',
  'EXECUTION_ADMISSION_INVALID', 'EXECUTION_REGISTRY_INTEGRITY', 'EXECUTION_READ_MODEL_CONFLICT'] as const);
export type ExecutionReadiness = typeof EXECUTION_READINESS[number];

export interface GovernedExecutionTargetV1 { source: ChangeSourceIdentityV1; runId: string }

/** The exact archived Human grant a model-call step rests on. */
export interface LiveCallGrantProofV1 { actorKind: ActorKind; authority: AuthorityRefV1 }

export interface ExecutionInspectionV1 {
  recordClass: 'OPERATIONAL_RECORD';
  readiness: ExecutionReadiness;
  /** A bounded reason code; null when READY. */
  reason: string | null;
  target: GovernedExecutionTargetV1 | null;
  change: { kind: 'SLICE'; changeId: string } | null;
  changeKey: string | null;
  repository: string | null;
  /** The R4A0 snapshot the answer was read from. */
  snapshotId: string | null;
  state: ControllerState | null;
  /** R4A0's NextAction moves for the run, as read. */
  nextMoves: { action: string; role: Role }[];
  /** R4A0 conflicts behind a BLOCKED_AUTHORITY or EXECUTION_READ_MODEL_CONFLICT answer. */
  conflicts: NextActionConflictV1[];
  /** READY only: the runner protocol's move and, for a model-call step, the grant it rests on. */
  step: { moves: string[]; liveCall: LiveCallGrantProofV1 | null } | null;
}

export type ExecutionStepStatus = 'STEPPED' | 'NOT_STEPPED' | 'STALE_OR_ADVANCED';
export interface ExecutionStepResultV1 {
  recordClass: 'OPERATIONAL_RECORD';
  status: ExecutionStepStatus;
  target: GovernedExecutionTargetV1 | null;
  changeKey: string | null;
  preSnapshotId: string | null;
  preState: ControllerState | null;
  /** 0 or 1. */
  runnerCalls: number;
  /** The runner's outcome code; RUNNER_REFUSED when its step threw; null when it was not called. */
  runnerOutcome: RunnerOutcome | 'RUNNER_REFUSED' | null;
  postSnapshotId: string | null;
  postState: ControllerState | null;
  /** Readiness after the step, read again from protected evidence; the gate's answer when nothing was stepped. */
  readiness: ExecutionInspectionV1;
}

export interface GovernedExecutionDriver {
  inspect(target: unknown): ExecutionInspectionV1;
  step(target: unknown): Promise<ExecutionStepResultV1>;
}

/** The runner's one-step entry. The driver calls it at most once per step(), always bound to a position. */
export interface RunnerStepPort { step(runId: string, expected: RunnerPositionGuard): Promise<RunnerResult> }

export interface GovernedExecutionDriverOptions {
  controllerStoreDirectory: string;
  authorityArchiveDirectory: string;
  changeRegistryDirectory: string;
  runner: RunnerStepPort;
  /** The live-call grants the runner was composed with, per actor. */
  liveCallAuthorizations: Readonly<Partial<Record<ActorKind, unknown>>>;
  /** The exact scope each actor's adapter calls. */
  scopes: Readonly<Record<ActorKind, ProviderCallScope>>;
  /** Trusted configuration: the GPT_ARCHITECT principal whose lineage a governed run must carry. Stated, not authenticated. */
  architectPrincipalRef: string;
  clock?: Clock;
}

// The runner protocol: the exact R4A0 moves under which a runner step is the governed next
// move, and the actor whose model call that step prepares or dispatches.
interface Protocol { moves: string[]; actor: ActorKind | null }
const PROTOCOL: Readonly<Partial<Record<ControllerState, Protocol>>> = Object.freeze({
  PACKET_READY: { moves: ['BEGIN_IMPLEMENTATION/CODEX_IMPLEMENTER/IMPLEMENTING'], actor: 'IMPLEMENTATION' },
  CORRECTION_REQUIRED: { moves: ['BEGIN_IMPLEMENTATION/CODEX_IMPLEMENTER/IMPLEMENTING'], actor: 'IMPLEMENTATION' },
  IMPLEMENTING: { moves: ['REPORT_IMPLEMENTATION_COMPLETE/CODEX_IMPLEMENTER/IMPLEMENTATION_COMPLETE'], actor: 'IMPLEMENTATION' },
  IMPLEMENTATION_COMPLETE: { moves: ['RECORD_REMOTE_SHA/CODEX_IMPLEMENTER/REMOTE_SHA_READY'], actor: null },
  REMOTE_SHA_READY: { moves: ['BEGIN_REMOTE_ACCEPTANCE/GPT_ARCHITECT/ACCEPTANCE_REVIEW'], actor: 'ARCHITECT_REVIEW' },
  ACCEPTANCE_REVIEW: { moves: ['ACCEPT_EXACT_SHA/GPT_ARCHITECT/ACCEPTED', 'REJECT_EXACT_SHA/GPT_ARCHITECT/CORRECTION_REQUIRED'],
    actor: 'ARCHITECT_REVIEW' },
});
// Runner outcomes that mean the run left the gated position or another writer holds the work.
const RACE_OUTCOMES: ReadonlySet<string> = new Set(['STALE_OCCURRENCE', 'INVOCATION_CLAIMED', 'ACTOR_RESULT_DISCARDED',
  'PROVENANCE_MISMATCH']);
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const REISSUES: ReadonlySet<string> = new Set(['ENTER_ARCHITECTURE', 'ISSUE_PACKET', 'RETURN_TO_ARCHITECTURE']);
const DECISIONS: ReadonlySet<string> = new Set(['BEGIN_REMOTE_ACCEPTANCE', 'ACCEPT_EXACT_SHA', 'REJECT_EXACT_SHA', 'ISSUE_CORRECTION_PACKET']);

/** Why the run's recorded provenance is not the governed lineage a runner step may execute on; null when it is. */
function lineageRefusal(run: GovernedRunV1, principalRef: string): string | null {
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

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

function parseTarget(input: unknown): GovernedExecutionTargetV1 | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const { source, runId, ...rest } = input as Record<string, unknown>;
  if (Object.keys(rest).length || typeof runId !== 'string' || !RUN_ID.test(runId)) return undefined;
  try {
    const parsed = parseChangeSourceIdentity(source);
    return { source: { kind: parsed.kind, projectId: parsed.projectId, goalId: parsed.goalId }, runId };
  } catch { return undefined; }
}

function snapshotScopes(input: GovernedExecutionDriverOptions['scopes']): Readonly<Record<ActorKind, ProviderCallScope>> {
  const scope = (kind: ActorKind): ProviderCallScope => {
    const { actorKind, provider, model, egressDestinations } = (input?.[kind] ?? {}) as ProviderCallScope;
    if (actorKind !== kind) throw new TypeError(`The ${kind} call scope must bind actor kind ${kind}`);
    for (const part of [provider, model]) {
      if (typeof part !== 'string' || !part || part.trim() !== part) throw new TypeError('A call scope needs exact provider and model');
    }
    return Object.freeze({ actorKind: kind, provider, model, egressDestinations: [...parseEgressSet(egressDestinations)] });
  };
  return Object.freeze(Object.fromEntries(ACTOR_KINDS.map((kind) => [kind, scope(kind)])) as Record<ActorKind, ProviderCallScope>);
}

const moveKey = ({ action, role, toState }: { action: string; role: Role; toState: ControllerState }) => `${action}/${role}/${toState}`;

/** Opens the driver over the three protected roots. Nothing is created or written by opening it. */
export function openGovernedExecutionDriver(options: GovernedExecutionDriverOptions): GovernedExecutionDriver {
  const roots = { controllerStoreDirectory: options?.controllerStoreDirectory, authorityArchiveDirectory: options?.authorityArchiveDirectory };
  const registry = openChangeRegistryReader(options?.changeRegistryDirectory);
  const step = options?.runner?.step;
  if (typeof step !== 'function') throw new TypeError('The execution driver requires a runner step entry');
  const runner = options.runner;
  const callRunner = (runId: string, expected: RunnerPositionGuard) => step.call(runner, runId, expected);
  const scopes = snapshotScopes(options.scopes);
  const principalRef = options.architectPrincipalRef;
  if (typeof principalRef !== 'string' || !principalRef || principalRef.trim() !== principalRef || principalRef.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(principalRef)) throw new TypeError('The execution driver requires an exact architectPrincipalRef');
  // Snapshotted, like the runner's own copy: a grant changed after composition is not the grant supplied.
  const grants = deepFreeze(structuredClone({ IMPLEMENTATION: options.liveCallAuthorizations?.IMPLEMENTATION,
    ARCHITECT_REVIEW: options.liveCallAuthorizations?.ARCHITECT_REVIEW }));
  const clock = options.clock ?? SYSTEM_CLOCK;

  type Gate = { view: ExecutionInspectionV1; position?: RunnerPositionGuard };
  const gate = (input: unknown): Gate => {
    const facts: Omit<ExecutionInspectionV1, 'recordClass' | 'readiness' | 'reason'> = { target: null, change: null, changeKey: null,
      repository: null, snapshotId: null, state: null, nextMoves: [], conflicts: [], step: null };
    const answer = (readiness: ExecutionReadiness, reason: string | null, position?: RunnerPositionGuard): Gate =>
      ({ view: deepFreeze({ recordClass: 'OPERATIONAL_RECORD', readiness, reason, ...structuredClone(facts) }), position });

    const target = parseTarget(input);
    if (!target) return answer('EXECUTION_TARGET_INVALID', 'TARGET_MALFORMED');
    facts.target = target;

    // 1. The exact CM1 Change of the exact source. Never a mint.
    let record: ChangeMintRecordV1 | undefined;
    try { record = registry.getBySource(target.source); }
    catch (error) {
      if (error instanceof ChangeMintError && error.code === 'INVALID_CHANGE_SOURCE') return answer('EXECUTION_TARGET_INVALID', 'SOURCE_INVALID');
      return answer('EXECUTION_REGISTRY_INTEGRITY', 'REGISTRY_INTEGRITY');
    }
    if (!record) return answer('EXECUTION_CHANGE_NOT_FOUND', 'CHANGE_NOT_MINTED');
    Object.assign(facts, { change: { kind: 'SLICE', changeId: record.sliceId }, changeKey: record.changeKey, repository: record.repository });

    // 2. R4A0: the one governed read of the Controller store and the authority archive.
    let model: GovernedReadModelV1;
    try { model = readGovernedModel(roots as { controllerStoreDirectory: string; authorityArchiveDirectory: string }, clock); }
    catch (error) {
      return answer('EXECUTION_READ_MODEL_CONFLICT', error instanceof GovernedReadError ? `READ_MODEL_${error.code}` : 'READ_MODEL_FAILED');
    }
    if (model.schema !== GOVERNED_READ_MODEL_SCHEMA || model.schemaVersion !== 1 || model.rulesetRef !== 'CHIEF-GOV/1' ||
        model.continuation !== 'NOT_IMPLEMENTED') return answer('EXECUTION_READ_MODEL_CONFLICT', 'READ_MODEL_CONTRACT');
    facts.snapshotId = model.snapshot.id;

    // 3. The run, exactly once, belonging to exactly this Change, as its admitted ROOT.
    const runs = model.runs.filter((run) => run.runId === target.runId);
    if (!runs.length) return answer('EXECUTION_RUN_NOT_FOUND', 'RUN_NOT_IN_STORE');
    if (runs.length > 1) return answer('EXECUTION_READ_MODEL_CONFLICT', 'RUN_DUPLICATED');
    const [run] = runs as [GovernedRunV1];
    if (run.repository !== record.repository || run.sliceId !== record.sliceId || run.changeKey !== record.changeKey) {
      return answer('EXECUTION_TARGET_MISMATCH', 'RUN_OF_ANOTHER_CHANGE');
    }
    facts.state = run.state;
    if (run.admission.status !== 'ROOT' || run.admission.rootRunId !== run.runId) {
      return answer('EXECUTION_ADMISSION_INVALID', `ADMISSION_${run.admission.status}`);
    }
    const views = model.changes.filter((view) => view.changeKey === record.changeKey);
    if (views.length !== 1 || views[0].repository !== record.repository || views[0].change.changeId !== record.sliceId ||
        !views[0].runs.some((member) => member.runId === run.runId)) return answer('EXECUTION_READ_MODEL_CONFLICT', 'CHANGE_VIEW_INVALID');
    const { nextAction, anomalies } = views[0];
    facts.nextMoves = nextAction.moves.map(({ action, role }) => ({ action, role }));
    facts.conflicts = [...nextAction.conflicts];

    // 4. Governed readiness, exactly as R4A0 states it.
    if (run.anomalies.length || anomalies.length || nextAction.conflicts.some((conflict) => conflict.scope !== 'AUTHORITY')) {
      return answer('EXECUTION_READ_MODEL_CONFLICT', 'GOVERNANCE_ANOMALY');
    }
    if (nextAction.conflicts.length) return answer('BLOCKED_AUTHORITY', 'AUTHORITY_UNRESOLVED');
    if (nextAction.determinacy !== 'DETERMINATE') return answer('EXECUTION_READ_MODEL_CONFLICT', 'INDETERMINATE');
    if (run.terminal) return answer('TERMINAL', 'TERMINAL_STATE');

    // 5. Only the runner protocol's own move is taken; every other move belongs to someone else.
    const protocol = PROTOCOL[run.state];
    const moves = nextAction.moves.map(moveKey);
    if (!protocol || moves.length !== protocol.moves.length || moves.some((move, index) => move !== protocol.moves[index])) {
      const human = nextAction.moves.length > 0 && nextAction.moves.every((move) => move.role === 'HUMAN');
      return answer(human ? 'WAITING_HUMAN' : 'WAITING_EXTERNAL_ACTOR', 'NOT_A_RUNNER_MOVE');
    }

    // 5b. G1-RP1-C1: what the step executes on must carry the governed lineage, not merely look valid.
    const refusal = lineageRefusal(run, principalRef);
    if (refusal) return answer('BLOCKED_PROVENANCE', refusal);

    // 6. A model-call step also rests on the exact archived Human grant for this actor.
    let liveCall: LiveCallGrantProofV1 | null = null;
    if (protocol.actor) {
      const actor = protocol.actor;
      if (!run.packet) return answer('EXECUTION_READ_MODEL_CONFLICT', 'PACKET_MISSING');
      const grant = parseAuthorization(grants[actor]);
      if (!grant) return answer('BLOCKED_AUTHORITY', 'LIVE_CALL_GRANT_MISSING');
      if (!authorizationBinds(grant, { role: 'HUMAN', operation: 'LIVE_PROVIDER_MODEL_CALL', target: LIVE_PROVIDER_MODEL_CALL_TARGET,
        runId: run.runId, packetId: run.packet.packetId, scope: scopes[actor] })) return answer('BLOCKED_AUTHORITY', 'LIVE_CALL_GRANT_NOT_BOUND');
      let bodyHash: string;
      try { bodyHash = authorityBodyHash(grant as unknown as JsonObject); }
      catch { return answer('BLOCKED_AUTHORITY', 'LIVE_CALL_GRANT_NOT_CANONICAL'); }
      const versions = model.authority.filter((fact) => fact.ref.kind === 'AUTHORIZATION' && fact.ref.authorityId === grant.authorizationId);
      if (!versions.length) return answer('BLOCKED_AUTHORITY', 'LIVE_CALL_GRANT_NOT_ARCHIVED');
      const exact = versions.filter((fact) => fact.bodyHash === bodyHash);
      if (!exact.length) return answer('BLOCKED_AUTHORITY', 'LIVE_CALL_GRANT_VERSION_NOT_FOUND');
      if (exact.length > 1) return answer('BLOCKED_AUTHORITY', 'LIVE_CALL_GRANT_AMBIGUOUS');
      const [fact] = exact;
      if (fact.issuer.role !== 'HUMAN' || fact.subject.repository !== run.repository || fact.subject.sliceId !== run.sliceId) {
        return answer('BLOCKED_AUTHORITY', 'LIVE_CALL_GRANT_SUBJECT_MISMATCH');
      }
      liveCall = { actorKind: actor, authority: { ...fact.ref } };
    }

    // 7. The exact position the runner must still find.
    const last = run.audit.last;
    if (!last) return answer('EXECUTION_READ_MODEL_CONFLICT', 'POSITION_UNKNOWN');
    facts.step = { moves: [...protocol.moves], liveCall };
    return answer('READY', null, { state: run.state, sequence: last.sequence, action: last.action, timestamp: last.at });
  };

  return Object.freeze({
    inspect(target: unknown): ExecutionInspectionV1 {
      return gate(target).view;
    },
    async step(target: unknown): Promise<ExecutionStepResultV1> {
      const before = gate(target);
      const pre = before.view;
      const result = (status: ExecutionStepStatus, runnerCalls: number, runnerOutcome: ExecutionStepResultV1['runnerOutcome'],
        after: ExecutionInspectionV1 | null): ExecutionStepResultV1 => deepFreeze({
        recordClass: 'OPERATIONAL_RECORD', status, target: pre.target, changeKey: pre.changeKey,
        preSnapshotId: pre.snapshotId, preState: pre.state, runnerCalls, runnerOutcome,
        postSnapshotId: after?.snapshotId ?? null, postState: after?.state ?? null, readiness: after ?? pre });
      if (pre.readiness !== 'READY' || !before.position) return result('NOT_STEPPED', 0, null, null);
      // Exactly one runner call, never retried. Governance roots are not locked around it.
      let outcome: ExecutionStepResultV1['runnerOutcome'];
      try {
        const stepped = await callRunner(pre.target!.runId, before.position);
        outcome = (RUNNER_OUTCOMES as readonly string[]).includes(stepped?.outcome) ? stepped.outcome : 'RUNNER_REFUSED';
      } catch { outcome = 'RUNNER_REFUSED'; }
      const after = gate(target).view;
      return result(outcome === 'RUNNER_REFUSED' || RACE_OUTCOMES.has(outcome) ? 'STALE_OR_ADVANCED' : 'STEPPED', 1, outcome, after);
    },
  });
}
