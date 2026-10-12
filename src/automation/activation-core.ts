import {
  authorityBodyHash, isAuthorityPrincipalRef, parseAuthorityDocument, type AuthorityDocumentV1, type AuthorityKindV1,
  type AuthorityRefV1, type JsonObject,
} from './authority/document.js';
import { AuthorityPreservationError, type DirectAuthorityPreserver } from './authority/preserver.js';
import { ChangeMintError, parseChangeSourceIdentity, type ChangeMintRecordV1, type ChangeSourceIdentityV1 } from './change-mint.js';
import { openChangeRegistryReader } from './change-registry.js';
import { AutomationController } from './controller.js';
import { sameEgressSet } from './egress-destination.js';
import { parseHumanPrincipalV1 } from '../identity/canonical.js';
import { packetHash, parseCorrection, parsePacket, validateCorrection } from './packet.js';
import { LIVE_PROVIDER_MODEL_CALL_TARGET, parseAuthorization } from './policy.js';
import {
  GOVERNED_READ_MODEL_SCHEMA, GovernedReadError, readGovernedModel, type ChangeViewV1, type GovernedReadModelV1, type GovernedRunV1,
} from './read-model/governed-read-model.js';
import { SYSTEM_CLOCK } from './time.js';
import {
  ACTOR_KINDS, type ActivationBinding, type Actor, type ActorKind, type AuditEntry, type Clock, type ControllerOccurrenceGuard, type ControllerRun,
  type ControllerState, type ImplementationPacket,
} from './types.js';

// G1-AP1: the governed activation core. It takes an existing CM1 Change's admitted RA1 ROOT
// run from IDLE to PACKET_READY, and nothing further: no runner step, no model call.
//
// Activation is direct authority first, Controller second. The caller supplies complete
// DIRECT_AUTHORITY documents (the Architect's IMPLEMENTATION_PACKET and the Human's
// LIVE_PROVIDER_MODEL_CALL grants); nothing is constructed from context. Every document is
// checked against protected facts before anything is written: the packet's issuer is the
// configured Architect principal and its subject the exact CM1 Change; each grant's issuer is
// the Human the CM1 record attributes the Goal to, it binds this run, this packet and exactly
// one packet call entry, and the packet's call entries are covered exactly once. Then every
// document is preserved in R4P (durable before preserve returns), and only then does the
// Controller enter architecture and issue the packet. Authority may be ahead of the
// Controller, never behind it: a crash anywhere leaves archived authority the Controller does
// not yet use, and an exact retry converges (idempotent preservation, then the transitions
// still missing). Nothing archived is deleted, nothing in the Controller is reset.
//
// G1-AP1-C1: the architecture entry is bound to the exact activation intent. The Controller
// writes ENTER_ARCHITECTURE and the binding { packetId, packetHash } in one write
// (enterArchitectureForActivation), and refuses any other packet as the ISSUE_PACKET directly
// after it. Recovery continues only from an ARCHITECTURE (or PACKET_READY) this path created:
// the binding present, both entries the configured Architect's, the binding equal to the
// supplied packet, the bound packet archived before the entry. A generic or foreign entry is
// ACTIVATION_ALREADY_ADVANCED; another intent is ACTIVATION_CONFLICT. The binding is read from
// the Controller after R4A0's gate, never from the archive; it is an operational record.
//
// applyCorrection is the narrow recovery for an Architect correction: only where R4A0's exact
// next move is ISSUE_CORRECTION_PACKET, preserved first, then issued.
//
// The target names only the Workspace Goal source and the run; repository, slice and
// changeKey come from the CM1 record and R4A0. The Architect principal is configured, not
// authenticated. Errors are bounded codes: no path, body or grant.

export const ACTIVATION_ERROR_CODES = Object.freeze(['ACTIVATION_TARGET_INVALID', 'ACTIVATION_CHANGE_NOT_FOUND',
  'ACTIVATION_REGISTRY_INTEGRITY', 'ACTIVATION_RUN_NOT_FOUND', 'ACTIVATION_TARGET_MISMATCH', 'ACTIVATION_ADMISSION_INVALID',
  'ACTIVATION_READ_MODEL_CONFLICT', 'ACTIVATION_CONFLICT', 'ACTIVATION_ALREADY_ADVANCED', 'ACTIVATION_INCOMPLETE',
  'AUTHORITY_DOCUMENT_INVALID', 'AUTHORITY_SUBJECT_MISMATCH', 'AUTHORITY_ISSUER_MISMATCH', 'HUMAN_PRINCIPAL_MISMATCH',
  'PACKET_BINDING_MISMATCH', 'LIVE_CALL_GRANT_MISSING', 'LIVE_CALL_GRANT_EXTRA', 'LIVE_CALL_GRANT_DUPLICATE',
  'LIVE_CALL_GRANT_NOT_BOUND', 'AUTHORITY_VERSION_CONFLICT', 'AUTHORITY_PRESERVATION_FAILED', 'CORRECTION_NOT_APPLICABLE'] as const);
export type ActivationErrorCode = typeof ACTIVATION_ERROR_CODES[number];

/** Activation refused or incomplete. Nothing the refusal names was written after it was decided. */
export class GovernedActivationError extends Error {
  constructor(readonly code: ActivationErrorCode, readonly reason: string | null = null) {
    super(reason ? `${code}: ${reason}` : code);
    this.name = 'GovernedActivationError';
  }
}

export interface GovernedActivationTargetV1 { source: ChangeSourceIdentityV1; runId: string }
export interface ActivationBundleV1 { implementationPacket: AuthorityDocumentV1; liveCallAuthorizations: AuthorityDocumentV1[] }

export interface ActivationInspectionV1 {
  recordClass: 'OPERATIONAL_RECORD';
  /**
   * IDLE: activatable. ARCHITECTURE_ENTERED: an interrupted activation, bound to one intent, that
   * only its exact retry completes. PACKET_READY: that activation completed. ADVANCED: anything
   * else, including an architecture entry this path did not create.
   */
  position: 'IDLE' | 'ARCHITECTURE_ENTERED' | 'PACKET_READY' | 'ADVANCED';
  target: GovernedActivationTargetV1;
  change: { kind: 'SLICE'; changeId: string };
  changeKey: string;
  repository: string;
  /** The Human the CM1 record attributes the Goal to: the only issuer a live-call grant may state. */
  humanPrincipalRef: string;
  snapshotId: string;
  state: ControllerState;
  packet: { packetId: string; packetVersion: number; packetHash: string } | null;
  /** The activation intent the run's architecture entry is bound to, as the Controller records it; operational, never authority. */
  activationBinding: ActivationBinding | null;
}
export interface ActivationResultV1 {
  recordClass: 'OPERATIONAL_RECORD';
  status: 'ACTIVATED' | 'ALREADY_ACTIVATED';
  target: GovernedActivationTargetV1;
  changeKey: string;
  preSnapshotId: string;
  preState: ControllerState;
  postSnapshotId: string;
  state: 'PACKET_READY';
  packet: { packetId: string; packetVersion: number; packetHash: string };
  authority: { implementationPacket: AuthorityRefV1; liveCallAuthorizations: { actorKind: ActorKind; authority: AuthorityRefV1 }[] };
}
export interface CorrectionResultV1 {
  recordClass: 'OPERATIONAL_RECORD';
  status: 'APPLIED' | 'ALREADY_APPLIED';
  target: GovernedActivationTargetV1;
  changeKey: string;
  preSnapshotId: string;
  postSnapshotId: string;
  state: 'CORRECTION_REQUIRED';
  correction: { correctionPacketId: string; authority: AuthorityRefV1 };
}

export interface GovernedActivationCore {
  inspect(target: unknown): ActivationInspectionV1;
  activate(target: unknown, bundle: unknown): ActivationResultV1;
  applyCorrection(target: unknown, correction: unknown): CorrectionResultV1;
}

export interface GovernedActivationOptions {
  controllerStoreDirectory: string;
  authorityArchiveDirectory: string;
  changeRegistryDirectory: string;
  /** The live composition's Controller; never handed out. */
  controller: AutomationController;
  preserver: DirectAuthorityPreserver;
  /** Trusted configuration: the GPT_ARCHITECT principal reference. Stated, not authenticated. */
  architectPrincipalRef: string;
  clock?: Clock;
}

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const fail = (code: ActivationErrorCode, reason: string | null = null): never => { throw new GovernedActivationError(code, reason); };
const moveKeys = (view: ChangeViewV1) => view.nextAction.moves.map(({ action, role, toState }) => `${action}/${role}/${toState}`);
const same = (left: string[], right: string[]) => left.length === right.length && left.every((item, index) => item === right[index]);
const ENTER = ['ENTER_ARCHITECTURE/GPT_ARCHITECT/ARCHITECTURE'];
const ISSUE = ['ISSUE_PACKET/GPT_ARCHITECT/PACKET_READY'];
const ISSUE_CORRECTION = ['ISSUE_CORRECTION_PACKET/GPT_ARCHITECT/CORRECTION_REQUIRED'];
const BEGIN = ['BEGIN_IMPLEMENTATION/CODEX_IMPLEMENTER/IMPLEMENTING'];

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

function parseTarget(input: unknown): GovernedActivationTargetV1 {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('ACTIVATION_TARGET_INVALID');
  const { source, runId, ...rest } = input as Record<string, unknown>;
  if (Object.keys(rest).length || typeof runId !== 'string' || !RUN_ID.test(runId)) return fail('ACTIVATION_TARGET_INVALID');
  try {
    const parsed = parseChangeSourceIdentity(source);
    return { source: { kind: parsed.kind, projectId: parsed.projectId, goalId: parsed.goalId }, runId };
  } catch { return fail('ACTIVATION_TARGET_INVALID'); }
}

/** A complete canonical direct-authority document of one kind and issuer role, parsed by R4P's rules. */
function documentOf(input: unknown, kind: AuthorityKindV1, role: 'HUMAN' | 'GPT_ARCHITECT'): AuthorityDocumentV1 {
  let document: AuthorityDocumentV1;
  try { document = parseAuthorityDocument(input); }
  catch {
    // R4P refuses a body whose stated issuer role is not its kind's; name that plainly.
    let stated: { kind?: unknown; issuer?: { role?: unknown } } | undefined;
    try { stated = { kind: (input as AuthorityDocumentV1)?.kind, issuer: { role: (input as AuthorityDocumentV1)?.issuer?.role } }; }
    catch { stated = undefined; }
    if (stated?.kind === kind && stated.issuer?.role !== undefined && stated.issuer.role !== role) return fail('AUTHORITY_ISSUER_MISMATCH');
    return fail('AUTHORITY_DOCUMENT_INVALID');
  }
  if (document.kind !== kind) return fail('AUTHORITY_DOCUMENT_INVALID', 'wrong kind');
  if (document.issuer.role !== role) return fail('AUTHORITY_ISSUER_MISMATCH');
  return document;
}

export function openGovernedActivationCore(options: GovernedActivationOptions): GovernedActivationCore {
  const controller = options?.controller;
  if (!(controller instanceof AutomationController)) throw new TypeError('The activation core requires the live AutomationController');
  if (typeof options.preserver?.preserve !== 'function') throw new TypeError('The activation core requires a direct authority preserver');
  if (!isAuthorityPrincipalRef(options.architectPrincipalRef)) throw new TypeError('architectPrincipalRef must be an exact principal reference');
  const preserver = options.preserver;
  const principalRef = options.architectPrincipalRef;
  const architect: Readonly<Actor> = Object.freeze({ id: principalRef, role: 'GPT_ARCHITECT' });
  const roots = { controllerStoreDirectory: options.controllerStoreDirectory, authorityArchiveDirectory: options.authorityArchiveDirectory };
  const registry = openChangeRegistryReader(options.changeRegistryDirectory);
  const clock = options.clock ?? SYSTEM_CLOCK;

  interface Context { target: GovernedActivationTargetV1; record: ChangeMintRecordV1; human: string; model: GovernedReadModelV1;
    run: GovernedRunV1; view: ChangeViewV1 }
  /** The exact CM1 Change and its admitted ROOT run, read from protected evidence only. */
  const resolve = (input: unknown): Context => {
    const target = parseTarget(input);
    let record: ChangeMintRecordV1 | undefined;
    try { record = registry.getBySource(target.source); }
    catch (error) {
      return fail(error instanceof ChangeMintError && error.code === 'INVALID_CHANGE_SOURCE' ? 'ACTIVATION_TARGET_INVALID' : 'ACTIVATION_REGISTRY_INTEGRITY');
    }
    if (!record) return fail('ACTIVATION_CHANGE_NOT_FOUND');
    let human: string;
    try { human = parseHumanPrincipalV1(record.source.submittedBy).principalRef; }
    catch { return fail('HUMAN_PRINCIPAL_MISMATCH', 'the Change has no attributed Human'); }
    let model: GovernedReadModelV1;
    try { model = readGovernedModel(roots, clock); }
    catch (error) { return fail('ACTIVATION_READ_MODEL_CONFLICT', error instanceof GovernedReadError ? error.code : null); }
    if (model.schema !== GOVERNED_READ_MODEL_SCHEMA || model.schemaVersion !== 1 || model.rulesetRef !== 'CHIEF-GOV/1' ||
        model.continuation !== 'NOT_IMPLEMENTED') return fail('ACTIVATION_READ_MODEL_CONFLICT', 'READ_MODEL_CONTRACT');
    const runs = model.runs.filter((run) => run.runId === target.runId);
    if (!runs.length) return fail('ACTIVATION_RUN_NOT_FOUND');
    if (runs.length > 1) return fail('ACTIVATION_READ_MODEL_CONFLICT', 'RUN_DUPLICATED');
    const run = runs[0];
    if (run.repository !== record.repository || run.sliceId !== record.sliceId || run.changeKey !== record.changeKey) {
      return fail('ACTIVATION_TARGET_MISMATCH');
    }
    if (run.admission.status !== 'ROOT' || run.admission.rootRunId !== run.runId) return fail('ACTIVATION_ADMISSION_INVALID');
    const views = model.changes.filter((view) => view.changeKey === record.changeKey);
    if (views.length !== 1 || !views[0].runs.some((member) => member.runId === run.runId)) {
      return fail('ACTIVATION_READ_MODEL_CONFLICT', 'CHANGE_VIEW_INVALID');
    }
    const view = views[0];
    if (run.anomalies.length || view.anomalies.length || view.nextAction.conflicts.length || view.nextAction.determinacy !== 'DETERMINATE') {
      return fail('ACTIVATION_READ_MODEL_CONFLICT', view.nextAction.conflicts.every((conflict) => conflict.scope === 'AUTHORITY') &&
        !run.anomalies.length && !view.anomalies.length && view.nextAction.conflicts.length ? 'AUTHORITY_UNRESOLVED' : 'GOVERNANCE_ANOMALY');
    }
    return { target, record, human, model, run, view };
  };

  interface Lineage {
    /** The Controller's binding of the run's architecture entry; null when the entry was not an activation's. */
    binding: ActivationBinding | null;
    /** The bound entry and the packet issue directly after it, if any, are the configured Architect's. */
    owned: boolean;
    /** The exact bound ENTER_ARCHITECTURE occurrence, while it is still the run's last entry. */
    entered: ControllerOccurrenceGuard | null;
  }
  const guardOf = (entry: AuditEntry): ControllerOccurrenceGuard =>
    ({ runId: entry.runId, sequence: entry.sequence, action: entry.action, timestamp: entry.timestamp });
  const byArchitect = (entry: AuditEntry | undefined) => entry?.role === 'GPT_ARCHITECT' && entry.actor === principalRef;
  const lineageIn = (full: ControllerRun): Lineage => {
    const [entered, issued] = full.audit;
    const binding = full.activationBinding ? { packetId: full.activationBinding.packetId, packetHash: full.activationBinding.packetHash } : null;
    const owned = binding !== null && entered?.action === 'ENTER_ARCHITECTURE' && byArchitect(entered) &&
      (issued === undefined || (issued.action === 'ISSUE_PACKET' && byArchitect(issued)));
    return { binding, owned, entered: owned && full.audit.length === 1 ? guardOf(entered) : null };
  };
  /**
   * The Controller's own record of how the run entered architecture (the actor ids and the
   * binding R4A0 does not project), read after R4A0's gate. Two reads: the run must still be
   * exactly where R4A0 saw it, or it moved in between and neither read decides anything.
   */
  const lineageOf = (context: Context): Lineage => {
    let full: ControllerRun;
    try { full = controller.get(context.run.runId); }
    catch { return fail('ACTIVATION_READ_MODEL_CONFLICT', 'CONTROLLER_RUN_UNREADABLE'); }
    const last = full.audit.at(-1), mark = context.run.audit.last;
    if (full.state !== context.run.state || full.audit.length !== context.run.audit.length ||
        last?.sequence !== mark?.sequence || last?.action !== mark?.action || last?.timestamp !== mark?.at) {
      return fail('ACTIVATION_READ_MODEL_CONFLICT', 'RUN_MOVED');
    }
    return lineageIn(full);
  };
  const sameIntent = (binding: ActivationBinding | null, intent: ActivationBinding) =>
    binding !== null && binding.packetId === intent.packetId && binding.packetHash === intent.packetHash;

  const positionOf = (context: Context, lineage: Lineage): ActivationInspectionV1['position'] => {
    const { run, view } = context;
    if (run.state === 'IDLE' && !run.packet && run.audit.length === 0 && same(moveKeys(view), ENTER)) return 'IDLE';
    // Past IDLE, only an architecture entry this path created is an activation's.
    if (!lineage.owned) return 'ADVANCED';
    if (run.state === 'ARCHITECTURE' && !run.packet && run.audit.length === 1 && run.audit.last?.action === 'ENTER_ARCHITECTURE' &&
        same(moveKeys(view), ISSUE)) return 'ARCHITECTURE_ENTERED';
    if (run.state === 'PACKET_READY' && run.packet && run.audit.length === 2 && run.audit.last?.action === 'ISSUE_PACKET' &&
        sameIntent(lineage.binding, run.packet)) return 'PACKET_READY';
    return 'ADVANCED';
  };
  /** The archived versions of the bound packet document that carry the supplied body. */
  const archivedWith = (context: Context, document: AuthorityDocumentV1) => {
    const bodyHash = authorityBodyHash(document.body as JsonObject);
    return context.model.authority.filter((fact) => fact.ref.kind === 'IMPLEMENTATION_PACKET' &&
      fact.ref.authorityId === document.authorityId && fact.bodyHash === bodyHash);
  };

  /** Every check on the supplied documents, before anything is written. */
  const checkBundle = (input: unknown, context: Context) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('AUTHORITY_DOCUMENT_INVALID', 'bundle');
    const { implementationPacket, liveCallAuthorizations, ...rest } = input as Record<string, unknown>;
    if (Object.keys(rest).length || !Array.isArray(liveCallAuthorizations)) return fail('AUTHORITY_DOCUMENT_INVALID', 'bundle');
    const { record, human, target } = context;
    const packetDocument = documentOf(implementationPacket, 'IMPLEMENTATION_PACKET', 'GPT_ARCHITECT');
    if (packetDocument.issuer.principalRef !== principalRef) return fail('AUTHORITY_ISSUER_MISMATCH');
    if (packetDocument.subject.repository !== record.repository || packetDocument.subject.sliceId !== record.sliceId) {
      return fail('AUTHORITY_SUBJECT_MISMATCH');
    }
    let packet: ImplementationPacket;
    try { packet = parsePacket(packetDocument.body); } catch { return fail('AUTHORITY_DOCUMENT_INVALID'); }
    if (packet.sliceId !== record.sliceId || packetDocument.authorityId !== packet.packetId) return fail('PACKET_BINDING_MISMATCH');
    const calls = packet.providerCallAuthorization.allowed ? packet.providerCallAuthorization.calls : [];
    const grants = new Map<ActorKind, AuthorityDocumentV1>();
    for (const item of liveCallAuthorizations) {
      const document = documentOf(item, 'AUTHORIZATION', 'HUMAN');
      if (document.issuer.principalRef !== human) return fail('HUMAN_PRINCIPAL_MISMATCH');
      if (document.subject.repository !== record.repository || document.subject.sliceId !== record.sliceId) {
        return fail('AUTHORITY_SUBJECT_MISMATCH');
      }
      const grant = parseAuthorization(document.body);
      if (!grant || grant.actorRole !== 'HUMAN' || grant.operation !== 'LIVE_PROVIDER_MODEL_CALL' ||
          grant.target !== LIVE_PROVIDER_MODEL_CALL_TARGET || grant.runId !== target.runId || grant.packetId !== packet.packetId ||
          !grant.scope) return fail('LIVE_CALL_GRANT_NOT_BOUND');
      const entry = calls.find((candidate) => candidate.actorKind === grant.scope!.actorKind);
      if (!entry) return fail('LIVE_CALL_GRANT_EXTRA');
      if (entry.provider !== grant.scope.provider || entry.model !== grant.scope.model ||
          !sameEgressSet(entry.egressDestinations, grant.scope.egressDestinations)) return fail('LIVE_CALL_GRANT_NOT_BOUND');
      if (grants.has(entry.actorKind)) return fail('LIVE_CALL_GRANT_DUPLICATE');
      grants.set(entry.actorKind, document);
    }
    for (const entry of calls) if (!grants.has(entry.actorKind)) return fail('LIVE_CALL_GRANT_MISSING');
    return { packetDocument, packet, hash: packetHash(packet),
      grants: ACTOR_KINDS.filter((kind) => grants.has(kind)).map((kind) => ({ actorKind: kind, document: grants.get(kind)! })) };
  };

  const preserve = (document: AuthorityDocumentV1): AuthorityRefV1 => {
    try { return preserver.preserve(document); }
    catch (error) {
      if (error instanceof AuthorityPreservationError) return fail(error.code, error.archiveCode);
      return fail('AUTHORITY_PRESERVATION_FAILED');
    }
  };

  const packetFacts = (packet: ImplementationPacket, hash: string) => ({ packetId: packet.packetId, packetVersion: packet.packetVersion, packetHash: hash });

  return Object.freeze({
    inspect(input: unknown): ActivationInspectionV1 {
      const context = resolve(input);
      const lineage = lineageOf(context);
      const { run, record } = context;
      return deepFreeze({ recordClass: 'OPERATIONAL_RECORD', position: positionOf(context, lineage), target: context.target,
        change: { kind: 'SLICE', changeId: record.sliceId }, changeKey: record.changeKey, repository: record.repository,
        humanPrincipalRef: context.human, snapshotId: context.model.snapshot.id, state: run.state,
        packet: run.packet ? { packetId: run.packet.packetId, packetVersion: run.packet.packetVersion, packetHash: run.packet.packetHash } : null,
        activationBinding: lineage.binding });
    },

    activate(input: unknown, bundleInput: unknown): ActivationResultV1 {
      const before = resolve(input);
      const lineage = lineageOf(before);
      const position = positionOf(before, lineage);
      if (position === 'ADVANCED') return fail('ACTIVATION_ALREADY_ADVANCED');
      const bundle = checkBundle(bundleInput, before);
      const intent: ActivationBinding = { packetId: bundle.packet.packetId, packetHash: bundle.hash };
      // Past IDLE the run is bound to one intent: only its exact retry may continue.
      if (position !== 'IDLE' && !sameIntent(lineage.binding, intent)) return fail('ACTIVATION_CONFLICT');
      // The bound packet must already be archived, before the entry: an exact retry supplies that very document.
      let archived: AuthorityRefV1 | null = null;
      if (position === 'ARCHITECTURE_ENTERED') {
        const facts = archivedWith(before, bundle.packetDocument);
        if (!facts.length) return fail('ACTIVATION_ALREADY_ADVANCED', 'INTENT_WITHOUT_AUTHORITY');
        if (facts.length !== 1 || facts[0].ref.version !== bundle.packetDocument.version) return fail('ACTIVATION_CONFLICT');
        archived = facts[0].ref;
      }
      // Direct authority first: durable in R4P before the Controller may rely on any of it.
      const packetRef = preserve(bundle.packetDocument);
      if (archived && archived.recordHash !== packetRef.recordHash) return fail('ACTIVATION_CONFLICT');
      const grantRefs = bundle.grants.map(({ actorKind, document }) => ({ actorKind, authority: preserve(document) }));
      // Then the transitions still missing, each bound to the exact occurrence it follows. A refusal
      // here is re-read, never repaired.
      const runId = before.target.runId;
      let entered = lineage.entered;
      if (position === 'IDLE') {
        try { entered = guardOf(controller.enterArchitectureForActivation(runId, architect, intent).audit[0]); }
        catch {
          // Another writer moved the run first: continue only on its entry for this exact intent.
          try {
            const current = lineageIn(controller.get(runId));
            entered = current.entered && sameIntent(current.binding, intent) ? current.entered : null;
          } catch { entered = null; }
        }
      }
      if (position !== 'PACKET_READY' && entered) {
        try { controller.issuePacketForOccurrence(runId, architect, entered, bundle.packet); } catch { /* decided by the re-read below */ }
      }
      let after: Context;
      let afterLineage: Lineage;
      try { after = resolve(input); afterLineage = lineageOf(after); }
      catch (error) {
        if (error instanceof GovernedActivationError && error.code === 'ACTIVATION_READ_MODEL_CONFLICT') return fail('ACTIVATION_INCOMPLETE', error.reason);
        throw error;
      }
      const afterPosition = positionOf(after, afterLineage);
      const packetRefOfRun = after.run.authority.find((reference) => reference.kind === 'IMPLEMENTATION_PACKET' && reference.locator === 'activePacket');
      if (afterPosition !== 'PACKET_READY' || !sameIntent(afterLineage.binding, intent) ||
          packetRefOfRun?.resolution !== 'RESOLVED' || packetRefOfRun.authority?.recordHash !== packetRef.recordHash) {
        if ((afterLineage.binding && !sameIntent(afterLineage.binding, intent)) || afterPosition === 'PACKET_READY') return fail('ACTIVATION_CONFLICT');
        return fail(afterPosition === 'ADVANCED' ? 'ACTIVATION_ALREADY_ADVANCED' : 'ACTIVATION_INCOMPLETE');
      }
      return deepFreeze({ recordClass: 'OPERATIONAL_RECORD', status: position === 'PACKET_READY' ? 'ALREADY_ACTIVATED' : 'ACTIVATED',
        target: before.target, changeKey: before.record.changeKey, preSnapshotId: before.model.snapshot.id, preState: before.run.state,
        postSnapshotId: after.model.snapshot.id, state: 'PACKET_READY', packet: packetFacts(bundle.packet, bundle.hash),
        authority: { implementationPacket: packetRef, liveCallAuthorizations: grantRefs } });
    },

    applyCorrection(input: unknown, correctionInput: unknown): CorrectionResultV1 {
      const before = resolve(input);
      const { run, record, view } = before;
      if (run.state !== 'CORRECTION_REQUIRED' || !run.packet) return fail('CORRECTION_NOT_APPLICABLE');
      const document = documentOf(correctionInput, 'CORRECTION_PACKET', 'GPT_ARCHITECT');
      if (document.issuer.principalRef !== principalRef) return fail('AUTHORITY_ISSUER_MISMATCH');
      if (document.subject.repository !== record.repository || document.subject.sliceId !== record.sliceId) return fail('AUTHORITY_SUBJECT_MISMATCH');
      const correction = parseCorrection(document.body);
      const bodyHash = authorityBodyHash(document.body as JsonObject);
      const facts = (status: CorrectionResultV1['status'], after: Context, authority: AuthorityRefV1): CorrectionResultV1 => deepFreeze({
        recordClass: 'OPERATIONAL_RECORD', status, target: before.target, changeKey: record.changeKey, preSnapshotId: before.model.snapshot.id,
        postSnapshotId: after.model.snapshot.id, state: 'CORRECTION_REQUIRED',
        correction: { correctionPacketId: correction.correctionPacketId, authority } });
      const current = (context: Context) => context.run.authority.find((reference) => reference.kind === 'CORRECTION_PACKET' &&
        reference.locator === 'correctionPacket' && reference.bodyHash === bodyHash && reference.resolution === 'RESOLVED');
      // An exact retry after the correction was issued: nothing to write.
      const applied = current(before);
      if (applied && same(moveKeys(view), BEGIN)) return facts('ALREADY_APPLIED', before, applied.authority!);
      if (!same(moveKeys(view), ISSUE_CORRECTION)) return fail('CORRECTION_NOT_APPLICABLE');
      // The Controller's operational copies, whose packet and decision R4A0 has just resolved exactly.
      const full = controller.get(run.runId);
      if (full.activePacketHash !== run.packet.packetHash || !full.activePacket || !full.remoteSha || full.acceptance?.decision !== 'REJECT') {
        return fail('CORRECTION_NOT_APPLICABLE');
      }
      try {
        validateCorrection(correction, full.activePacket, full.activePacketHash, full.remoteSha.sha, full.acceptance.findings,
          full.implementationIterations + 1);
      } catch { return fail('PACKET_BINDING_MISMATCH'); }
      const authority = preserve(document);
      try { controller.issueCorrection(run.runId, architect, correction); } catch { /* decided by the re-read below */ }
      const after = resolve(input);
      if (!current(after) || !same(moveKeys(after.view), BEGIN)) return fail('ACTIVATION_INCOMPLETE');
      return facts('APPLIED', after, authority);
    },
  });
}
