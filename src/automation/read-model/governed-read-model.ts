import { isAbsolute, normalize, sep } from 'node:path';
import { ADMISSION_RULESET, changeKeyOf, openAdmissionRecord, parseChangeIdentity, type AdmissionRecord } from '../admission.js';
import {
  AUTHORITY_ID_PATTERN, AUTHORITY_KINDS, authorityBodyHash, authorityRefOf, type AuthorityKindV1, type AuthorityRecordV1,
  type AuthorityRefV1, type JsonObject,
} from '../authority/document.js';
import { openAuthorityArchiveReader } from '../authority/file-archive.js';
import { openStoredRun, storedRunFileName } from '../durable-store.js';
import { isStopState, isTerminalState } from '../lifecycle.js';
import { SYSTEM_CLOCK, isInstant } from '../time.js';
import type { AuditEntry, Authorization, Clock, ControllerRun, ControllerState, Role, StopClass } from '../types.js';
import { GovernedReadError, takeSourceSnapshot, type SourceSnapshot } from './source-snapshot.js';

// CHIEF governed read model (G1-R4A0), ruleset CHIEF-GOV/1. A read-only projection of
// what the governance roots actually hold: the Controller runs that exist, the change
// each belongs to, its recorded lifecycle state, the direct authority R4P holds, the
// structural anomalies, and the NextAction the ruleset allows.
//
// Boundaries:
// - Read only. It never constructs FileControllerStore (whose constructor creates
//   directories) and never opens an archive appender. See source-snapshot.ts.
// - Runs come from the Controller store and are canonical only after the store's own
//   envelope, checksum, identity-binding and lifecycle-invariant checks (openStoredRun).
//   A run file that fails them fails the whole read closed: its change, state and
//   authority are unknown, so no projection of the store could be complete.
// - The R4L admission registry is operational integrity support, not authority and not
//   the source of what exists. Its contradictions are reported, never repaired.
// - Direct authority comes only from the R4P AUTHORITY_ARCHIVE through the reader
//   capability. A Controller run's packet, correction, decision or grant is an
//   operational copy; it is matched to the archived version whose body hash it records,
//   never to the latest version, and never becomes authority by itself. Invocation
//   journals, run status, Git, CI and model output are not read at all.
// - CHIEF-GOV/1 has no continuation: lineage is UNAVAILABLE, a change has no head, and
//   a second run of one change is UNLINKED_SIBLING_RUN, never a successor.
//
// Wired into nothing: no Workspace, API, runner, controller or model process uses it.

export { GovernedReadError } from './source-snapshot.js';

export const GOVERNED_READ_MODEL_SCHEMA = 'chief.governed-read-model';

export type AnomalyCode = 'UNLINKED_SIBLING_RUN' | 'LEGACY_UNINDEXED_RUN' | 'ADMISSION_REGISTRY_MISMATCH' | 'ADMISSION_RECORD_INVALID';
export interface AnomalyV1 {
  code: AnomalyCode;
  /** The change it concerns, when a canonical change key is known. */
  changeKey: string | null;
  runIds: string[];
  /** Display text only. */
  detail: string;
}
/** R4L's change reference; the repository is carried beside it. */
export interface ChangeRefV1 { kind: 'SLICE'; changeId: string }
/** CHIEF-GOV/1 has no continuation lineage. */
export interface RunLineageV1 { kind: 'UNAVAILABLE'; admission: 'NOT_IMPLEMENTED'; predecessor: null; successor: null }
export type AuthorityResolution =
  | 'RESOLVED' | 'NOT_ARCHIVED' | 'VERSION_NOT_FOUND' | 'SUBJECT_MISMATCH' | 'AMBIGUOUS' | 'HASH_NOT_RECORDED';
/** A run's reference to a direct-authority document and what the archive holds for it. */
export interface AuthorityReferenceV1 {
  kind: AuthorityKindV1;
  authorityId: string;
  /** The body hash the run records; null when the run records only the id. */
  bodyHash: string | null;
  /** Where the run records it (a run field or `audit#<sequence>`): an operational record, never authority. */
  locator: string;
  /** Retained by the run as evidence of its current position, so the position needs it to be direct authority. */
  required: boolean;
  resolution: AuthorityResolution;
  /** The exact archived version, only when RESOLVED. */
  authority: AuthorityRefV1 | null;
}
export interface AuthorityFactV1 {
  ref: AuthorityRefV1;
  recordClass: 'DIRECT_AUTHORITY';
  issuedAt: string;
  /** Stated by the document, not authenticated. */
  issuer: { role: 'HUMAN' | 'GPT_ARCHITECT'; principalRef: string };
  subject: { repository: string; sliceId: string | null };
  bodyHash: string;
}
export type AdmissionStatus = 'ROOT' | 'NOT_ROOT' | 'NO_RECORD' | 'RECORD_INVALID' | 'NO_CANONICAL_IDENTITY';
interface AuditMarkV1 { sequence: number; action: string; at: string }
export interface GovernedRunV1 {
  runId: string;
  repository: string;
  sliceId: string;
  /** Null when the recorded identity is not a canonical change identity; never normalised. */
  change: ChangeRefV1 | null;
  changeKey: string | null;
  state: ControllerState;
  interruptedState: ControllerState | null;
  stopClass: StopClass | null;
  terminal: boolean;
  /** The Controller's display text; never parsed. */
  stopReason: string | null;
  externalRecheckRequired: boolean;
  counters: { implementationIterations: number; maxImplementationIterations: number | null;
    acceptanceFailures: number; maxAcceptanceFailures: number | null };
  packet: { packetId: string; packetVersion: number; packetHash: string; targetBranch: string; expectedBaseSha: string } | null;
  audit: { length: number; first: AuditMarkV1 | null; last: AuditMarkV1 | null };
  /** R4L admission as recorded: operational integrity data, not authority. */
  admission: { recordClass: 'OPERATIONAL_RECORD'; status: AdmissionStatus; rootRunId: string | null; admittedAt: string | null };
  lineage: RunLineageV1;
  authority: AuthorityReferenceV1[];
  anomalies: AnomalyV1[];
}
export interface NextMoveV1 { action: string; role: Role; toState: ControllerState }
export interface NextActionConflictV1 {
  scope: 'CHANGE' | 'CONTROLLER_STORE' | 'AUTHORITY';
  code: AnomalyCode | AuthorityResolution;
  locator: string | null;
}
export type CapabilityGap = 'CHANGE_ABANDONMENT_NOT_IMPLEMENTED' | 'CONTINUATION_NOT_IN_RULESET';
export interface NextActionV1 {
  determinacy: 'DETERMINATE' | 'INDETERMINATE';
  /**
   * DETERMINATE: the lifecycle moves the recorded facts allow next, each with the one role
   * that may take it; several moves of one role when facts not recorded (time, repository
   * reality) decide between them; none for a terminal run. Every active state may also stop
   * (STOP, FAIL_CLOSED); those exits are not listed. INDETERMINATE: none.
   */
  moves: NextMoveV1[];
  /** CHIEF-GOV/1 defines no NextAction rule identifiers. */
  ruleId: null;
  conflicts: NextActionConflictV1[];
  capabilityGaps: CapabilityGap[];
}
export interface ChangeViewV1 {
  change: ChangeRefV1;
  repository: string;
  changeKey: string;
  /** No continuation in CHIEF-GOV/1, so no head run. */
  head: null;
  runs: { runId: string; state: ControllerState; lineage: RunLineageV1 }[];
  /** Direct authority for this change: resolved references of its runs and archived documents whose subject is exactly this change. */
  authority: AuthorityRefV1[];
  anomalies: AnomalyV1[];
  nextAction: NextActionV1;
}
export interface GovernedReadModelV1 {
  schema: typeof GOVERNED_READ_MODEL_SCHEMA;
  schemaVersion: 1;
  rulesetRef: typeof ADMISSION_RULESET;
  observedAt: string;
  snapshot: { id: string; controllerStore: 'PRESENT' | 'ABSENT'; authorityArchive: 'PRESENT' | 'ABSENT' };
  continuation: 'NOT_IMPLEMENTED';
  runs: GovernedRunV1[];
  changes: ChangeViewV1[];
  /** Every direct-authority document version in the archive. */
  authority: AuthorityFactV1[];
  anomalies: AnomalyV1[];
}
export interface GovernedReadRoots { controllerStoreDirectory: string; authorityArchiveDirectory: string }

const LINEAGE: RunLineageV1 = Object.freeze({ kind: 'UNAVAILABLE', admission: 'NOT_IMPLEMENTED', predecessor: null, successor: null });
const HUMAN_STOP_GAPS: CapabilityGap[] = ['CHANGE_ABANDONMENT_NOT_IMPLEMENTED', 'CONTINUATION_NOT_IN_RULESET'];
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function checkRoots(input: GovernedReadRoots): GovernedReadRoots {
  const { controllerStoreDirectory: controller, authorityArchiveDirectory: archive } = input ?? {};
  for (const path of [controller, archive]) {
    if (typeof path !== 'string' || !isAbsolute(path) || normalize(path) !== path || path === sep || path.endsWith(sep)) {
      throw new GovernedReadError('INVALID_ROOTS', 'Governance roots must be absolute, normalised paths');
    }
  }
  const within = (inner: string, outer: string) => inner === outer || inner.startsWith(outer + sep);
  if (within(controller, archive) || within(archive, controller)) {
    throw new GovernedReadError('INVALID_ROOTS', 'The Controller store and the authority archive must be disjoint');
  }
  return { controllerStoreDirectory: controller, authorityArchiveDirectory: archive };
}

function canonicalRuns(snapshot: SourceSnapshot): ControllerRun[] {
  const runs: ControllerRun[] = [];
  for (const [name, text] of snapshot.runFiles) {
    try { runs.push(openStoredRun(text, (runId) => typeof runId === 'string' && storedRunFileName(runId) === name)); }
    catch (error) {
      throw new GovernedReadError('CONTROLLER_RUN_INVALID', `Controller run file ${name} is not a canonical run: ${(error as Error).message}`);
    }
  }
  return runs.sort((a, b) => compare(a.runId, b.runId));
}

/** Every archived version, validated by the R4P reader, keyed by kind and authorityId. */
function authorityIndex(root: string, snapshot: SourceSnapshot): Map<string, AuthorityRecordV1[]> {
  let reader;
  try { reader = openAuthorityArchiveReader(root); }
  catch (error) { throw new GovernedReadError('AUTHORITY_ARCHIVE_INVALID', `Authority archive refused: ${(error as Error).message}`); }
  // The reader lists versions of a known document; which documents exist is learnt from
  // the record files the snapshot read, and every record comes back through the reader.
  const documents = new Map<string, [AuthorityKindV1, string]>();
  for (const text of snapshot.authorityFiles.values()) {
    let stored: { kind?: unknown; authorityId?: unknown };
    try { stored = JSON.parse(text); } catch { throw new GovernedReadError('AUTHORITY_ARCHIVE_INVALID', 'Unreadable authority record'); }
    const { kind, authorityId } = stored ?? {};
    if (!AUTHORITY_KINDS.includes(kind as AuthorityKindV1) || typeof authorityId !== 'string' || !AUTHORITY_ID_PATTERN.test(authorityId)) {
      throw new GovernedReadError('AUTHORITY_ARCHIVE_INVALID', 'An authority record names no valid kind and authorityId');
    }
    documents.set(`${kind}\0${authorityId}`, [kind as AuthorityKindV1, authorityId]);
  }
  const index = new Map<string, AuthorityRecordV1[]>();
  try {
    for (const [key, [kind, authorityId]] of documents) {
      index.set(key, reader.listVersions(kind, authorityId).map((ref) => {
        const record = reader.get(ref);
        if (!record) throw new Error('A listed authority version is missing');
        return record;
      }));
    }
  } catch (error) {
    throw new GovernedReadError('AUTHORITY_ARCHIVE_INVALID', `Authority archive refused: ${(error as Error).message}`);
  }
  return index;
}

const bodyHashOf = (body: object) => authorityBodyHash(body as unknown as JsonObject);

/** The direct-authority documents a run refers to, most specific first, without duplicates. */
function referencesOf(run: ControllerRun): Omit<AuthorityReferenceV1, 'resolution' | 'authority'>[] {
  const references: Omit<AuthorityReferenceV1, 'resolution' | 'authority'>[] = [];
  const seen = new Set<string>();
  const push = (kind: AuthorityKindV1, authorityId: string, bodyHash: string | null, locator: string, required: boolean) => {
    const key = `${kind}\0${authorityId}\0${bodyHash}`;
    if (seen.has(key)) return;
    seen.add(key);
    references.push({ kind, authorityId, bodyHash, locator, required });
  };
  // Retained bodies: the evidence the run's current position rests on.
  if (run.activePacket) push('IMPLEMENTATION_PACKET', run.activePacket.packetId, run.activePacketHash!, 'activePacket', true);
  if (run.correctionPacket) {
    push('CORRECTION_PACKET', run.correctionPacket.correctionPacketId, bodyHashOf(run.correctionPacket), 'correctionPacket', true);
  }
  if (run.acceptance) push('ACCEPTANCE_DECISION', run.acceptance.reviewId, bodyHashOf(run.acceptance), 'acceptance', true);
  const grants = new Map<string, string>();
  for (const [locator, grant] of [['promotionAuthorization', run.promotionAuthorization],
    ['humanResumeAuthorization', run.humanResumeAuthorization]] as [string, Authorization | undefined][]) {
    if (!grant) continue;
    const hash = bodyHashOf(grant);
    grants.set(grant.authorizationId, hash);
    push('AUTHORIZATION', grant.authorizationId, hash, locator, true);
  }
  // Historical references in the audit: packets by id and hash, grants by id only (their
  // bodies are retained only for the current promotion and the latest resume).
  for (const entry of run.audit) {
    if (entry.packetId && entry.packetHash) push('IMPLEMENTATION_PACKET', entry.packetId, entry.packetHash, `audit#${entry.sequence}`, false);
    if (entry.authorizationReference) {
      push('AUTHORIZATION', entry.authorizationReference, grants.get(entry.authorizationReference) ?? null, `audit#${entry.sequence}`, false);
    }
  }
  return references;
}

/** The exact archived version a reference records, never another version of the document. */
function resolve(index: Map<string, AuthorityRecordV1[]>, reference: Omit<AuthorityReferenceV1, 'resolution' | 'authority'>,
  run: ControllerRun): Pick<AuthorityReferenceV1, 'resolution' | 'authority'> {
  const none = (resolution: AuthorityResolution) => ({ resolution, authority: null });
  const versions = AUTHORITY_ID_PATTERN.test(reference.authorityId) ? index.get(`${reference.kind}\0${reference.authorityId}`) ?? [] : [];
  if (!versions.length) return none('NOT_ARCHIVED');
  if (reference.bodyHash === null) return none('HASH_NOT_RECORDED');
  const matches = versions.filter((record) => record.bodyHash === reference.bodyHash);
  if (!matches.length) return none('VERSION_NOT_FOUND');
  if (matches.length > 1) return none('AMBIGUOUS');
  const [record] = matches;
  if (record.subject.repository !== run.repository || (record.subject.sliceId !== undefined && record.subject.sliceId !== run.sliceId)) {
    return none('SUBJECT_MISMATCH');
  }
  return { resolution: 'RESOLVED', authority: authorityRefOf(record) };
}

/**
 * The lifecycle moves CHIEF-GOV/1 allows from a run's recorded facts: the transition table
 * in lifecycle.ts as the controller applies it. Only guards decidable from the record are
 * applied; guards on time or repository reality leave every candidate of the one role.
 */
function movesOf(run: ControllerRun): NextMoveV1[] {
  const move = (action: string, role: Role, toState: ControllerState): NextMoveV1 => ({ action, role, toState });
  const max = run.activePacket?.iterationBudget.maxImplementationIterationsPerSlice;
  const budgetSpent = max !== undefined && run.implementationIterations >= max;
  switch (run.state) {
    case 'CLOSED':
    case 'FAILED_CLOSED':
      return [];
    case 'HUMAN_STOP':
      // Only the Human resume to the interrupted state; abandonment and continuation do not exist.
      return [move('RESUME_HUMAN_STOP', 'HUMAN', run.interruptedState!)];
    case 'ARCHITECTURE_STOP':
      return [move('RETURN_TO_ARCHITECTURE', 'GPT_ARCHITECT', 'ARCHITECTURE')];
    case 'SOFT_STOP': {
      // resumeSoft: no packet, or an interrupted PACKET_READY with the iteration budget spent,
      // can only exhaust the budget; an interrupted IMPLEMENTING depends on elapsed runtime.
      const exhausted = move('BUDGET_EXHAUSTED', 'CONTROLLER', 'HUMAN_STOP');
      const resume = move('RESUME_SOFT_WITH_REPAIR', 'CONTROLLER', run.interruptedState!);
      if (!run.activePacket || (run.interruptedState === 'PACKET_READY' && budgetSpent)) return [exhausted];
      return run.interruptedState === 'IMPLEMENTING' ? [resume, exhausted] : [resume];
    }
    default:
      break;
  }
  // Active states. A pending external recheck (set by every Human resume) blocks the
  // controller's evidence-bearing actions until RECHECK_EXTERNAL_REALITY clears it.
  const recheck = run.externalRecheckRequired === true ? [move('RECHECK_EXTERNAL_REALITY', 'CONTROLLER', run.state)] : [];
  switch (run.state) {
    case 'IDLE': return [move('ENTER_ARCHITECTURE', 'GPT_ARCHITECT', 'ARCHITECTURE'), ...recheck];
    case 'ARCHITECTURE': return [move('ISSUE_PACKET', 'GPT_ARCHITECT', 'PACKET_READY'), ...recheck];
    case 'IMPLEMENTING': return [move('REPORT_IMPLEMENTATION_COMPLETE', 'CODEX_IMPLEMENTER', 'IMPLEMENTATION_COMPLETE'), ...recheck];
    default: if (recheck.length) return recheck;
  }
  switch (run.state) {
    case 'PACKET_READY':
    case 'CORRECTION_REQUIRED':
      // beginImplementation halts to HUMAN_STOP once the iteration budget is spent, before
      // it looks for a correction; a correction could not be issued past that budget either.
      if (budgetSpent) return [move('STOP', 'CONTROLLER', 'HUMAN_STOP')];
      if (run.state === 'CORRECTION_REQUIRED' && run.correctionPacket?.rejectedSha !== run.remoteSha?.sha) {
        return [move('ISSUE_CORRECTION_PACKET', 'GPT_ARCHITECT', 'CORRECTION_REQUIRED')];
      }
      return [move('BEGIN_IMPLEMENTATION', 'CODEX_IMPLEMENTER', 'IMPLEMENTING')];
    case 'IMPLEMENTATION_COMPLETE': return [move('RECORD_REMOTE_SHA', 'CODEX_IMPLEMENTER', 'REMOTE_SHA_READY')];
    case 'REMOTE_SHA_READY': return [move('BEGIN_REMOTE_ACCEPTANCE', 'GPT_ARCHITECT', 'ACCEPTANCE_REVIEW')];
    case 'ACCEPTANCE_REVIEW':
      return [move('ACCEPT_EXACT_SHA', 'GPT_ARCHITECT', 'ACCEPTED'), move('REJECT_EXACT_SHA', 'GPT_ARCHITECT', 'CORRECTION_REQUIRED')];
    case 'ACCEPTED': return [move('AUTHORIZE_PROMOTION', 'HUMAN', 'PROMOTION_READY')];
    case 'PROMOTION_READY': return [move('MARK_PROMOTING', 'CONTROLLER', 'PROMOTING')];
    case 'PROMOTING':
      return [move('RECORD_PROMOTED_MAIN', 'CONTROLLER', 'CANONICAL_CI'), move('RECOVER_PROMOTED_MAIN', 'CONTROLLER', 'CANONICAL_CI')];
    case 'CANONICAL_CI':
      return [move('CLOSE_VERIFIED_RUN', 'CONTROLLER', 'CLOSED'), move('RECONCILE_PENDING', 'CONTROLLER', 'CANONICAL_CI'),
        move('RECOVER_CLOSE', 'CONTROLLER', 'CLOSED')];
    default:
      throw new Error(`No CHIEF-GOV/1 move is defined for ${run.state}`);
  }
}

function nextActionOf(runs: ControllerRun[], references: Map<string, AuthorityReferenceV1[]>, own: AnomalyV1[],
  all: AnomalyV1[]): NextActionV1 {
  const conflicts: NextActionConflictV1[] = [];
  const seen = new Set<string>();
  const conflict = (entry: NextActionConflictV1) => {
    const key = JSON.stringify(entry);
    if (!seen.has(key)) { seen.add(key); conflicts.push(entry); }
  };
  for (const anomaly of own) conflict({ scope: 'CHANGE', code: anomaly.code, locator: anomaly.changeKey });
  // A store holding any admission contradiction does not open (R4L-1 C1-B), so no
  // lifecycle action can be taken on any run in it, this change's included.
  for (const anomaly of all) {
    if (!own.includes(anomaly)) conflict({ scope: 'CONTROLLER_STORE', code: anomaly.code, locator: anomaly.changeKey ?? anomaly.runIds[0] ?? null });
  }
  const run = runs.length === 1 ? runs[0] : undefined;
  const capabilityGaps = run?.state === 'HUMAN_STOP' ? [...HUMAN_STOP_GAPS] : [];
  const indeterminate = (): NextActionV1 => ({ determinacy: 'INDETERMINATE', moves: [], ruleId: null, conflicts, capabilityGaps });
  if (conflicts.length || !run) return indeterminate();
  if (isTerminalState(run.state)) return { determinacy: 'DETERMINATE', moves: [], ruleId: null, conflicts, capabilityGaps };
  for (const reference of references.get(run.runId) ?? []) {
    if (reference.required && reference.resolution !== 'RESOLVED') {
      conflict({ scope: 'AUTHORITY', code: reference.resolution, locator: `${run.runId}:${reference.locator}` });
    }
  }
  if (conflicts.length) return indeterminate();
  return { determinacy: 'DETERMINATE', moves: movesOf(run), ruleId: null, conflicts, capabilityGaps };
}

const mark = (entry: AuditEntry | undefined): AuditMarkV1 | null =>
  entry ? { sequence: entry.sequence, action: entry.action, at: entry.timestamp } : null;

function project(roots: GovernedReadRoots, snapshot: SourceSnapshot, observedAt: string): GovernedReadModelV1 {
  const runs = canonicalRuns(snapshot);
  const index = authorityIndex(roots.authorityArchiveDirectory, snapshot);

  // Change identity: R4L's exact grammar and key; a non-canonical identity has no change.
  const identities = new Map<string, { changeKey: string } | null>();
  for (const run of runs) {
    try { identities.set(run.runId, { changeKey: changeKeyOf(parseChangeIdentity(run)) }); }
    catch { identities.set(run.runId, null); }
  }
  const claimants = (changeKey: string) => runs.filter((run) => identities.get(run.runId)?.changeKey === changeKey).map((run) => run.runId);
  const byId = new Map(runs.map((run) => [run.runId, run]));

  // R4L admission checks, in both directions, reported instead of thrown.
  const anomalies: AnomalyV1[] = [];
  const add = (code: AnomalyCode, changeKey: string | null, runIds: string[], detail: string) =>
    anomalies.push({ code, changeKey, runIds: [...new Set(runIds)].sort(compare), detail });
  const claims = new Map<string, AdmissionRecord | null>();
  for (const [changeKey, text] of snapshot.claimFiles) {
    try { claims.set(changeKey, openAdmissionRecord(text)); } catch { claims.set(changeKey, null); }
  }
  const owners = new Map<string, string[]>();
  for (const [changeKey, record] of claims) {
    if (!record) {
      add('ADMISSION_RECORD_INVALID', changeKey, claimants(changeKey), 'The admission record is unreadable or not a CHIEF-GOV/1 record');
      continue;
    }
    if (record.changeKey !== changeKey) {
      add('ADMISSION_REGISTRY_MISMATCH', changeKey, [...claimants(changeKey), ...(byId.has(record.rootRunId) ? [record.rootRunId] : [])],
        'An admission record is filed under another change');
      continue;
    }
    owners.set(record.rootRunId, [...(owners.get(record.rootRunId) ?? []), changeKey]);
    const root = byId.get(record.rootRunId);
    if (root && (root.repository !== record.repository || root.sliceId !== record.sliceId)) {
      add('ADMISSION_REGISTRY_MISMATCH', changeKey, [root.runId], 'An admitted ROOT run belongs to another change');
    }
  }
  for (const [runId, changeKeys] of owners) {
    if (changeKeys.length < 2) continue;
    for (const changeKey of changeKeys) {
      add('ADMISSION_REGISTRY_MISMATCH', changeKey, byId.has(runId) ? [runId] : [], 'One runId is claimed as ROOT by two changes');
    }
  }
  const admissions = new Map<string, GovernedRunV1['admission']>();
  for (const run of runs) {
    const admission = (status: AdmissionStatus, record?: AdmissionRecord) => admissions.set(run.runId,
      { recordClass: 'OPERATIONAL_RECORD', status, rootRunId: record?.rootRunId ?? null, admittedAt: record?.admittedAt ?? null });
    const identity = identities.get(run.runId);
    if (!identity) {
      admission('NO_CANONICAL_IDENTITY');
      add('LEGACY_UNINDEXED_RUN', null, [run.runId], 'The run has no canonical change identity; it predates admission');
      continue;
    }
    if (!claims.has(identity.changeKey)) {
      admission('NO_RECORD');
      add('LEGACY_UNINDEXED_RUN', identity.changeKey, [run.runId], 'The run has no admission record');
      continue;
    }
    const record = claims.get(identity.changeKey);
    if (!record || record.changeKey !== identity.changeKey) { admission('RECORD_INVALID'); continue; }
    if (record.rootRunId !== run.runId) {
      admission('NOT_ROOT', record);
      add('ADMISSION_REGISTRY_MISMATCH', identity.changeKey, [run.runId], 'The run is not the admitted ROOT of its change');
      continue;
    }
    admission('ROOT', record);
  }
  // GOV/1 structural anomaly: more than one observed run for one exact change.
  const changeKeys = [...new Set(runs.map((run) => identities.get(run.runId)?.changeKey).filter((key): key is string => Boolean(key)))];
  for (const changeKey of changeKeys) {
    const siblings = claimants(changeKey);
    if (siblings.length > 1) {
      add('UNLINKED_SIBLING_RUN', changeKey, siblings, 'More than one run exists for this exact change; CHIEF-GOV/1 has no lineage linking them');
    }
  }
  anomalies.sort((a, b) => compare(a.code, b.code) || compare(a.changeKey ?? '', b.changeKey ?? '') ||
    compare(a.runIds.join(','), b.runIds.join(',')) || compare(a.detail, b.detail));

  const references = new Map<string, AuthorityReferenceV1[]>(runs.map((run) =>
    [run.runId, referencesOf(run).map((reference) => ({ ...reference, ...resolve(index, reference, run) }))]));
  const projectedRuns: GovernedRunV1[] = runs.map((run) => {
    const identity = identities.get(run.runId);
    const packet = run.activePacket;
    return {
      runId: run.runId, repository: run.repository, sliceId: run.sliceId,
      change: identity ? { kind: 'SLICE', changeId: run.sliceId } : null,
      changeKey: identity?.changeKey ?? null,
      state: run.state,
      interruptedState: run.interruptedState ?? null,
      stopClass: isStopState(run.state) ? run.state as StopClass : null,
      terminal: isTerminalState(run.state),
      stopReason: run.stopReason ?? null,
      externalRecheckRequired: run.externalRecheckRequired === true,
      counters: { implementationIterations: run.implementationIterations,
        maxImplementationIterations: packet?.iterationBudget.maxImplementationIterationsPerSlice ?? null,
        acceptanceFailures: run.acceptanceFailures, maxAcceptanceFailures: packet?.iterationBudget.maxAcceptanceFailuresPerSlice ?? null },
      packet: packet ? { packetId: packet.packetId, packetVersion: packet.packetVersion, packetHash: run.activePacketHash!,
        targetBranch: packet.targetBranch, expectedBaseSha: packet.expectedBaseSha } : null,
      audit: { length: run.audit.length, first: mark(run.audit[0]), last: mark(run.audit.at(-1)) },
      admission: admissions.get(run.runId)!,
      lineage: { ...LINEAGE },
      authority: references.get(run.runId)!,
      anomalies: anomalies.filter((anomaly) => anomaly.runIds.includes(run.runId)),
    };
  });

  const facts: AuthorityFactV1[] = [...index.values()].flat().map((record) => ({
    ref: authorityRefOf(record), recordClass: 'DIRECT_AUTHORITY' as const, issuedAt: record.issuedAt,
    issuer: { role: record.issuer.role, principalRef: record.issuer.principalRef },
    subject: { repository: record.subject.repository, sliceId: record.subject.sliceId ?? null }, bodyHash: record.bodyHash,
  })).sort((a, b) => compare(a.ref.kind, b.ref.kind) || compare(a.ref.authorityId, b.ref.authorityId) || a.ref.version - b.ref.version);

  const changes: ChangeViewV1[] = changeKeys.map((changeKey) => {
    const members = runs.filter((run) => identities.get(run.runId)?.changeKey === changeKey);
    const { repository, sliceId } = members[0];
    const memberIds = new Set(members.map((run) => run.runId));
    const own = anomalies.filter((anomaly) => anomaly.changeKey === changeKey || anomaly.runIds.some((id) => memberIds.has(id)));
    const refs = new Map<string, AuthorityRefV1>();
    for (const run of members) {
      for (const reference of references.get(run.runId)!) if (reference.authority) refs.set(reference.authority.recordHash, reference.authority);
    }
    for (const fact of facts) {
      if (fact.subject.repository === repository && fact.subject.sliceId === sliceId) refs.set(fact.ref.recordHash, fact.ref);
    }
    return {
      change: { kind: 'SLICE' as const, changeId: sliceId }, repository, changeKey, head: null,
      runs: members.map((run) => ({ runId: run.runId, state: run.state, lineage: { ...LINEAGE } })),
      authority: [...refs.values()].sort((a, b) => compare(a.kind, b.kind) || compare(a.authorityId, b.authorityId) || a.version - b.version),
      anomalies: own,
      nextAction: nextActionOf(members, references, own, anomalies),
    };
  }).sort((a, b) => compare(a.repository, b.repository) || compare(a.change.changeId, b.change.changeId));

  return {
    schema: GOVERNED_READ_MODEL_SCHEMA, schemaVersion: 1, rulesetRef: ADMISSION_RULESET, observedAt,
    snapshot: { id: snapshot.id, controllerStore: snapshot.present.CONTROLLER_STORE ? 'PRESENT' : 'ABSENT',
      authorityArchive: snapshot.present.AUTHORITY_ARCHIVE ? 'PRESENT' : 'ABSENT' },
    continuation: 'NOT_IMPLEMENTED',
    runs: projectedRuns, changes, authority: facts, anomalies,
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

/**
 * Reads the governed projection of one Controller store and one authority archive.
 * Read only; fails closed (GovernedReadError) when a source is invalid or changed while
 * it was read.
 */
export function readGovernedModel(input: GovernedReadRoots, clock: Clock = SYSTEM_CLOCK): GovernedReadModelV1 {
  const roots = checkRoots(input);
  const observedAt = clock.now();
  if (!isInstant(observedAt)) throw new Error('Read model clock returned an invalid timestamp');
  const before = takeSourceSnapshot(roots.controllerStoreDirectory, roots.authorityArchiveDirectory);
  const changed = () => takeSourceSnapshot(roots.controllerStoreDirectory, roots.authorityArchiveDirectory).signature !== before.signature;
  let model: GovernedReadModelV1;
  try { model = project(roots, before, observedAt); }
  catch (error) {
    // A source that moved under the read explains the failure better than the failure does.
    let moved: boolean;
    try { moved = changed(); } catch { moved = true; }
    if (moved) throw new GovernedReadError('SNAPSHOT_INCONSISTENT', 'A governance source changed while it was read');
    throw error;
  }
  if (changed()) throw new GovernedReadError('SNAPSHOT_INCONSISTENT', 'A governance source changed while it was read');
  return deepFreeze(model);
}
