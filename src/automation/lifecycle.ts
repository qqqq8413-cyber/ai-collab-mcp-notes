import { z } from 'zod';
import { isPacketHash, isSha, packetHash, tryParsePacket, validateCorrection } from './packet.js';
import { authorizationBinds, matchAuthorization, parseAuthorization } from './policy.js';
import { isInstant, parseInstant } from './time.js';
import {
  STATES, STOP_CLASSES, type AcceptanceDecision, type AuditEntry, type ControllerRun, type ControllerState,
  type PostPromotionFacts, type PromotionPreflightFacts, type RemoteShaEvidence, type Role,
} from './types.js';

// The single definition of a legal controller transition. The controller checks every
// commit against it, and the store enforces it again on replace, so no public path —
// a controller method, a direct store write, or a future adapter — can reach a state
// by a route or with evidence the lifecycle does not allow.

const text = z.string().trim().min(1);
const sha = z.string().refine(isSha);
const date = z.string().refine(isInstant);
const remoteSchema = z.strictObject({ repository: text, branch: text, sha, observedAt: date, source: z.literal('GITHUB') });
const decisionSchema = z.strictObject({
  reviewId: text, actor: z.literal('GPT_ARCHITECT'), packetId: text, packetHash: z.string().refine(isPacketHash),
  reviewedSha: sha, decision: z.enum(['ACCEPT', 'REJECT']), findings: z.array(text),
  evidenceReferences: z.array(text).min(1), issuedAt: date,
});
const preflightSchema = z.strictObject({
  expectedMainSha: sha, observedMainSha: sha, acceptedSha: sha,
  aheadBy: z.number().int().nonnegative(), behindBy: z.number().int().nonnegative(),
  hasMainOnlyCommits: z.boolean(), acceptedShaCiPassed: z.boolean(),
  requiredCheckPassed: z.boolean(), mainProtected: z.boolean(),
});
const postSchema = z.strictObject({
  observedMainSha: sha, expectedAcceptedSha: sha,
  mainCiPassed: z.boolean(), requiredCheckPassed: z.boolean(), mainProtected: z.boolean(),
});

export function parseRemoteSha(input: unknown): RemoteShaEvidence { return remoteSchema.parse(input) as RemoteShaEvidence; }
export function parseAcceptanceDecision(input: unknown): AcceptanceDecision { return decisionSchema.parse(input) as AcceptanceDecision; }
export function parsePromotionPreflight(input: unknown): PromotionPreflightFacts { return preflightSchema.parse(input) as PromotionPreflightFacts; }
export function parsePostPromotion(input: unknown): PostPromotionFacts { return postSchema.parse(input) as PostPromotionFacts; }

const states = (...list: ControllerState[]) => new Set<ControllerState>(list);
const STOPS = states(...STOP_CLASSES);
const TERMINAL = states('CLOSED', 'FAILED_CLOSED');
const ACTIVE = states(...STATES.filter((state) => !STOPS.has(state) && !TERMINAL.has(state)));
const WITH_PACKET = states('PACKET_READY', 'IMPLEMENTING', 'IMPLEMENTATION_COMPLETE', 'REMOTE_SHA_READY',
  'ACCEPTANCE_REVIEW', 'CORRECTION_REQUIRED', 'ACCEPTED', 'PROMOTION_READY', 'PROMOTING', 'CANONICAL_CI', 'CLOSED');
const WITH_ITERATION = states('IMPLEMENTING', 'IMPLEMENTATION_COMPLETE');
const WITH_REMOTE = states('REMOTE_SHA_READY', 'ACCEPTANCE_REVIEW', 'CORRECTION_REQUIRED', 'ACCEPTED',
  'PROMOTION_READY', 'PROMOTING', 'CANONICAL_CI', 'CLOSED');
const WITH_ACCEPTANCE = states('ACCEPTED', 'PROMOTION_READY', 'PROMOTING', 'CANONICAL_CI', 'CLOSED');
const WITH_PROMOTION = states('PROMOTION_READY', 'PROMOTING', 'CANONICAL_CI', 'CLOSED');
const WITH_PROMOTED_MAIN = states('CANONICAL_CI', 'CLOSED');

export function isActiveState(state: unknown): boolean { return ACTIVE.has(state as ControllerState); }
export function isStopState(state: unknown): boolean { return STOPS.has(state as ControllerState); }
export function isTerminalState(state: unknown): boolean { return TERMINAL.has(state as ControllerState); }

// Every mutable run field. A transition may change only the fields its rule lists.
const FRAMED = ['activePacket', 'activePacketHash', 'correctionPacket', 'remoteSha', 'acceptance',
  'promotionAuthorization', 'promotionPreflight', 'observedPromotedMainSha', 'implementationIterations',
  'iterationStartedAt', 'acceptanceFailures', 'interruptedState', 'stopReason', 'stopId',
  'externalRecheckRequired', 'humanResumeAuthorization'] as const;
type Framed = typeof FRAMED[number];
const RUN_KEYS = new Set<string>(['runId', 'sliceId', 'repository', 'state', 'audit', ...FRAMED]);
const ENTRY_KEYS = new Set<string>(['sequence', 'runId', 'sliceId', 'actor', 'role', 'action', 'timestamp',
  'previousState', 'nextState', 'repository', 'branch', 'baseSHA', 'resultingSHA', 'authorizationReference',
  'packetId', 'packetHash', 'acceptanceSHA', 'stopReason', 'stopId']);

interface Rule { roles: readonly Role[]; moves: ReadonlySet<string>; changes: readonly Framed[] }
const move = (from: ControllerState, to: ControllerState) => `${from}>${to}`;
const rule = (roles: Role[], moves: [ControllerState, ControllerState][], changes: Framed[] = []): Rule =>
  ({ roles, moves: new Set(moves.map(([from, to]) => move(from, to))), changes });
const STOP_FIELDS: Framed[] = ['interruptedState', 'stopReason', 'stopId'];
const fromActive = (to: (state: ControllerState) => ControllerState[]) =>
  [...ACTIVE].flatMap((state) => to(state).map((next): [ControllerState, ControllerState] => [state, next]));

const RULES: Readonly<Record<string, Rule>> = Object.freeze(Object.assign(Object.create(null), {
  ENTER_ARCHITECTURE: rule(['GPT_ARCHITECT'], [['IDLE', 'ARCHITECTURE']]),
  ISSUE_PACKET: rule(['GPT_ARCHITECT'], [['ARCHITECTURE', 'PACKET_READY']], ['activePacket', 'activePacketHash',
    'correctionPacket', 'remoteSha', 'acceptance', 'promotionAuthorization', 'promotionPreflight', 'observedPromotedMainSha']),
  BEGIN_IMPLEMENTATION: rule(['CODEX_IMPLEMENTER'], [['PACKET_READY', 'IMPLEMENTING'], ['CORRECTION_REQUIRED', 'IMPLEMENTING']],
    ['implementationIterations', 'iterationStartedAt', 'remoteSha', 'acceptance']),
  REPORT_IMPLEMENTATION_COMPLETE: rule(['CODEX_IMPLEMENTER'], [['IMPLEMENTING', 'IMPLEMENTATION_COMPLETE']]),
  RECORD_REMOTE_SHA: rule(['CODEX_IMPLEMENTER'], [['IMPLEMENTATION_COMPLETE', 'REMOTE_SHA_READY']], ['remoteSha']),
  BEGIN_REMOTE_ACCEPTANCE: rule(['GPT_ARCHITECT'], [['REMOTE_SHA_READY', 'ACCEPTANCE_REVIEW']]),
  // The only move into ACCEPTED from anywhere but a stop of an already-accepted run.
  ACCEPT_EXACT_SHA: rule(['GPT_ARCHITECT'], [['ACCEPTANCE_REVIEW', 'ACCEPTED']], ['acceptance']),
  REJECT_EXACT_SHA: rule(['GPT_ARCHITECT'], [['ACCEPTANCE_REVIEW', 'CORRECTION_REQUIRED']], ['acceptance', 'acceptanceFailures']),
  ISSUE_CORRECTION_PACKET: rule(['GPT_ARCHITECT'], [['CORRECTION_REQUIRED', 'CORRECTION_REQUIRED']], ['correctionPacket']),
  AUTHORIZE_PROMOTION: rule(['HUMAN'], [['ACCEPTED', 'PROMOTION_READY']], ['promotionAuthorization', 'promotionPreflight']),
  MARK_PROMOTING: rule(['CONTROLLER'], [['PROMOTION_READY', 'PROMOTING']]),
  RECORD_PROMOTED_MAIN: rule(['CONTROLLER'], [['PROMOTING', 'CANONICAL_CI']], ['observedPromotedMainSha']),
  CLOSE_VERIFIED_RUN: rule(['CONTROLLER'], [['CANONICAL_CI', 'CLOSED']]),
  STOP: rule(['HUMAN', 'GPT_ARCHITECT', 'CONTROLLER'], fromActive(() => [...STOP_CLASSES]), STOP_FIELDS),
  BUDGET_EXHAUSTED: rule(['CONTROLLER'], [['SOFT_STOP', 'HUMAN_STOP']], ['stopReason', 'stopId']),
  RESUME_SOFT_WITH_REPAIR: rule(['CONTROLLER'], [...ACTIVE].map((state): [ControllerState, ControllerState] => ['SOFT_STOP', state]), STOP_FIELDS),
  RETURN_TO_ARCHITECTURE: rule(['GPT_ARCHITECT'], [['ARCHITECTURE_STOP', 'ARCHITECTURE']], STOP_FIELDS),
  RESUME_HUMAN_STOP: rule(['HUMAN'], [...ACTIVE].map((state): [ControllerState, ControllerState] => ['HUMAN_STOP', state]),
    [...STOP_FIELDS, 'externalRecheckRequired', 'humanResumeAuthorization']),
  FAIL_CLOSED: rule(['CONTROLLER'], STATES.filter((state) => !TERMINAL.has(state))
    .map((state): [ControllerState, ControllerState] => [state, 'FAILED_CLOSED']), ['stopReason', 'stopId']),
}));

/** Key-order-independent comparison of plain data. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item) ?? 'undefined';
}
function fail(why: string): never {
  throw new Error(`Controller lifecycle violation: ${why}`);
}
const nonEmpty = (value: unknown) => typeof value === 'string' && value.trim().length > 0;

function promotionBinding(run: ControllerRun) {
  return { role: 'HUMAN' as const, operation: 'FAST_FORWARD_MAIN', target: 'main',
    runId: run.runId, packetId: run.activePacket?.packetId };
}

/** True when the facts show `run`'s accepted SHA may be promoted onto its packet's expected main. */
export function preflightPasses(facts: PromotionPreflightFacts, run: ControllerRun): boolean {
  return facts.expectedMainSha === run.activePacket?.expectedBaseSha &&
    facts.observedMainSha === facts.expectedMainSha &&
    facts.acceptedSha === run.acceptance?.reviewedSha && facts.acceptedSha === run.remoteSha?.sha &&
    facts.aheadBy >= 1 && facts.behindBy === 0 && !facts.hasMainOnlyCommits &&
    facts.acceptedShaCiPassed && facts.requiredCheckPassed && facts.mainProtected;
}

/** The only shape a run may be created in. */
export function assertFreshRun(run: ControllerRun): void {
  if (Object.keys(run).sort().join(',') !== 'acceptanceFailures,audit,implementationIterations,repository,runId,sliceId,state' ||
      !nonEmpty(run.runId) || !nonEmpty(run.sliceId) || !nonEmpty(run.repository) || run.state !== 'IDLE' ||
      run.implementationIterations !== 0 || run.acceptanceFailures !== 0 || !Array.isArray(run.audit) || run.audit.length) {
    fail('a run must be created empty in IDLE');
  }
}

/** Evidence each state requires, checked on every commit and every load. */
export function assertRunInvariants(run: ControllerRun): void {
  if (!run || typeof run !== 'object' || Object.keys(run).some((key) => !RUN_KEYS.has(key))) fail('unrecognised run shape');
  const state = run.state;
  if (!STATES.includes(state)) fail('unknown state');
  if (!Number.isSafeInteger(run.implementationIterations) || run.implementationIterations < 0 ||
      !Number.isSafeInteger(run.acceptanceFailures) || run.acceptanceFailures < 0) fail('invalid counters');
  if (!Array.isArray(run.audit) || run.audit.some((entry, index) => entry?.sequence !== index + 1)) fail('audit sequence broken');
  const last = run.audit.at(-1);
  if (last ? last.nextState !== state : state !== 'IDLE') fail('state does not match the audit trail');
  const packet = run.activePacket;
  if (packet !== undefined || run.activePacketHash !== undefined) {
    let hash: string | undefined;
    try { hash = packet && packetHash(packet); } catch { hash = undefined; }
    if (!hash || hash !== run.activePacketHash) fail('active packet substitution detected');
  }
  if (STOPS.has(state)) {
    if (!ACTIVE.has(run.interruptedState!) || !nonEmpty(run.stopReason) || run.stopId !== `stop-${last!.sequence}`) {
      fail('stop state without its interrupted state, reason, and occurrence id');
    }
  } else {
    if (run.stopId !== undefined) fail('stop occurrence id outside a stop state');
    if (ACTIVE.has(state) && (run.interruptedState !== undefined || run.stopReason !== undefined)) fail('stale stop data on an active state');
    if (state === 'FAILED_CLOSED' && !nonEmpty(run.stopReason)) fail('FAILED_CLOSED without a reason');
  }
  if (WITH_PACKET.has(state) && !packet) fail(`${state} requires an active packet`);
  if (WITH_ITERATION.has(state) && (!isInstant(run.iterationStartedAt) || run.implementationIterations < 1)) {
    fail(`${state} requires a started iteration`);
  }
  if (WITH_REMOTE.has(state)) {
    const remote = remoteSchema.safeParse(run.remoteSha);
    if (!remote.success || remote.data.repository !== run.repository || remote.data.branch !== packet!.targetBranch) {
      fail(`${state} requires remote SHA evidence for the packet branch`);
    }
  }
  const decisionBinds = (kind: 'ACCEPT' | 'REJECT') => {
    const decision = decisionSchema.safeParse(run.acceptance);
    return decision.success && decision.data.decision === kind && decision.data.packetId === packet!.packetId &&
      decision.data.packetHash === run.activePacketHash && decision.data.reviewedSha === run.remoteSha!.sha &&
      (kind === 'ACCEPT' || decision.data.findings.length > 0);
  };
  if (state === 'CORRECTION_REQUIRED' && !decisionBinds('REJECT')) fail('CORRECTION_REQUIRED requires a GPT rejection of the remote SHA');
  if (WITH_ACCEPTANCE.has(state) && !decisionBinds('ACCEPT')) fail(`${state} requires a GPT acceptance of the exact remote SHA`);
  if (WITH_PROMOTION.has(state)) {
    const auth = parseAuthorization(run.promotionAuthorization);
    const facts = preflightSchema.safeParse(run.promotionPreflight);
    if (!auth || !authorizationBinds(auth, promotionBinding(run)) || !facts.success ||
        !preflightPasses(facts.data as PromotionPreflightFacts, run)) {
      fail(`${state} requires exact human promotion authorization and passing preflight`);
    }
  }
  if (WITH_PROMOTED_MAIN.has(state) && run.observedPromotedMainSha !== run.acceptance!.reviewedSha) {
    fail(`${state} requires promoted main to equal the accepted SHA`);
  }
}

/** Throws unless `after` is `before` advanced by exactly one legal, fully evidenced transition. */
export function assertTransition(before: ControllerRun, after: ControllerRun): void {
  if (!after || typeof after !== 'object' || after.runId !== before.runId || after.sliceId !== before.sliceId ||
      after.repository !== before.repository) fail('run identity changed');
  if (!Array.isArray(after.audit) || after.audit.length !== before.audit.length + 1 ||
      before.audit.some((entry, index) => stable(entry) !== stable(after.audit[index]))) {
    fail('audit must be append-only, one entry per transition');
  }
  const entry: AuditEntry = after.audit[after.audit.length - 1];
  if (!entry || typeof entry !== 'object' || Object.keys(entry).some((key) => !ENTRY_KEYS.has(key))) fail('unrecognised audit entry');
  const spec = Object.hasOwn(RULES, entry.action) ? RULES[entry.action] : undefined;
  if (!spec) fail('unknown action');
  if (entry.sequence !== before.audit.length + 1 || entry.runId !== after.runId || entry.sliceId !== after.sliceId ||
      entry.repository !== after.repository || entry.previousState !== before.state || entry.nextState !== after.state ||
      !nonEmpty(entry.actor) || !isInstant(entry.timestamp)) fail('audit entry does not describe this transition');
  if (!spec.roles.includes(entry.role)) fail(`${entry.action} is not permitted for ${String(entry.role)}`);
  if (!spec.moves.has(move(before.state, after.state))) fail(`${entry.action} cannot move ${before.state} to ${String(after.state)}`);
  for (const field of FRAMED) {
    if (!spec.changes.includes(field) && stable(before[field]) !== stable(after[field])) fail(`${entry.action} cannot change ${field}`);
  }
  if (after.implementationIterations !== before.implementationIterations + (entry.action === 'BEGIN_IMPLEMENTATION' ? 1 : 0) ||
      after.acceptanceFailures !== before.acceptanceFailures + (entry.action === 'REJECT_EXACT_SHA' ? 1 : 0)) {
    fail('counters change only by one, on their own action');
  }
  if (entry.packetId !== after.activePacket?.packetId || entry.packetHash !== after.activePacketHash) fail('audit packet reference');
  if (entry.stopId !== (STOPS.has(after.state) ? after.stopId : undefined) ||
      entry.stopReason !== (STOPS.has(after.state) || after.state === 'FAILED_CLOSED' ? after.stopReason : undefined)) {
    fail('audit stop reference');
  }
  if (entry.authorizationReference !== undefined &&
      (!['AUTHORIZE_PROMOTION', 'RESUME_HUMAN_STOP'].includes(entry.action) ||
       before.audit.some((earlier) => earlier.authorizationReference === entry.authorizationReference))) {
    fail('an authorization is consumed at most once, by an action that takes one');
  }
  const at = parseInstant(entry.timestamp)!;
  const packet = after.activePacket;
  const runtimeExceeded = () => !packet || !isInstant(after.iterationStartedAt) ||
    at - parseInstant(after.iterationStartedAt)! > packet.iterationBudget.maxRuntimeMinutesPerIteration * 60_000;

  switch (entry.action) {
    case 'ISSUE_PACKET': {
      const parsed = tryParsePacket(packet);
      if (!parsed || parsed.sliceId !== after.sliceId ||
          (before.activePacket && (parsed.packetId === before.activePacket.packetId ||
            parsed.packetVersion <= before.activePacket.packetVersion))) fail('packet identity/version mismatch');
      if (after.correctionPacket || after.remoteSha || after.acceptance || after.promotionAuthorization ||
          after.promotionPreflight || after.observedPromotedMainSha) fail('a new packet starts without prior evidence');
      break;
    }
    case 'BEGIN_IMPLEMENTATION':
      if (after.remoteSha || after.acceptance || parseInstant(after.iterationStartedAt) !== at ||
          after.implementationIterations > packet!.iterationBudget.maxImplementationIterationsPerSlice) {
        fail('implementation start outside budget or with stale evidence');
      }
      if (before.state === 'CORRECTION_REQUIRED' && (before.correctionPacket?.rejectedSha !== before.remoteSha?.sha ||
          before.correctionPacket?.correctionIteration !== after.implementationIterations)) {
        fail('current rejection requires an exact correction packet');
      }
      break;
    case 'REPORT_IMPLEMENTATION_COMPLETE':
      if (runtimeExceeded()) fail('implementation runtime budget exhausted');
      break;
    case 'RECORD_REMOTE_SHA':
      if (parseInstant(after.remoteSha?.observedAt)! > at || entry.resultingSHA !== after.remoteSha?.sha) fail('remote SHA evidence');
      break;
    case 'ACCEPT_EXACT_SHA':
    case 'REJECT_EXACT_SHA':
      if (parseInstant(after.acceptance?.issuedAt)! > at || entry.acceptanceSHA !== after.acceptance?.reviewedSha) fail('acceptance evidence');
      break;
    case 'ISSUE_CORRECTION_PACKET':
      if (before.correctionPacket?.rejectedSha === before.remoteSha?.sha || !after.correctionPacket) fail('correction already recorded or missing');
      validateCorrection(after.correctionPacket, packet!, after.activePacketHash!, after.remoteSha!.sha,
        after.acceptance!.findings, after.implementationIterations + 1);
      break;
    case 'AUTHORIZE_PROMOTION': {
      const grant = matchAuthorization(after.promotionAuthorization, promotionBinding(after), entry.timestamp);
      if (!grant || entry.authorizationReference !== grant.authorizationId ||
          entry.acceptanceSHA !== after.acceptance?.reviewedSha) fail('promotion needs an exact, current human grant');
      break;
    }
    case 'MARK_PROMOTING':
      // The grant must still be inside its window when promotion actually begins.
      if (!matchAuthorization(after.promotionAuthorization, promotionBinding(after), entry.timestamp)) {
        fail('promotion authorization is no longer valid');
      }
      break;
    case 'RECORD_PROMOTED_MAIN':
      if (entry.resultingSHA !== after.observedPromotedMainSha) fail('promoted main reference');
      break;
    case 'STOP':
      if (after.interruptedState !== before.state) fail('a stop records the state it interrupted');
      break;
    case 'RESUME_SOFT_WITH_REPAIR':
      if (after.state !== before.interruptedState ||
          (after.state === 'IMPLEMENTING' && runtimeExceeded()) ||
          (after.state === 'PACKET_READY' && after.implementationIterations >= packet!.iterationBudget.maxImplementationIterationsPerSlice)) {
        fail('soft resume returns only to the interrupted state, inside budget');
      }
      break;
    case 'RESUME_HUMAN_STOP': {
      // The grant must name this stop occurrence, not merely the run.
      const grant = matchAuthorization(after.humanResumeAuthorization, { role: 'HUMAN', operation: 'RESUME_HUMAN_STOP',
        target: before.stopId, runId: after.runId, packetId: packet?.packetId }, entry.timestamp);
      if (after.state !== before.interruptedState || !grant || entry.authorizationReference !== grant.authorizationId ||
          after.externalRecheckRequired !== true) fail('human resume needs an exact, unused grant for this stop occurrence');
      break;
    }
    default:
      break;
  }
  assertRunInvariants(after);
}
