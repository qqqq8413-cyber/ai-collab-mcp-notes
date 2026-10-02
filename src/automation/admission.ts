import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isInstant } from './time.js';
import type { Clock } from './types.js';

// CHIEF-GOV/1 run admission (G1-R4L-1): one change, exactly one ROOT run, ever. A second
// run for a change would start again from zero counters, call budget, stop state and
// lifecycle, so every ControllerStore refuses it in create, before the run exists,
// whichever path asks: the controller, the store directly, another store instance or
// another process.
//
// A change is ChangeRefV1 { kind: 'SLICE', changeId: sliceId } in one repository. The
// identity is exact: it is checked against a strict grammar and refused when it is not
// canonical. It is never trimmed, case-folded or otherwise rewritten, so no spelling can
// name a second change ("A" and "a" are two changes).
//
// This is a structural invariant, not authorization. It cannot tell whether two
// different sliceIds are the same real work. Before any run-creation surface goes live,
// new change identities must come from a governed change-mint/adoption process, and who
// may start a change's run is decided at the governed authorization boundary.
// Continuation is reserved and not implemented: a record holds exactly one ROOT.

export const ADMISSION_RULESET = 'CHIEF-GOV/1';
/** The exact persisted sliceId. Case-sensitive. */
export const SLICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** owner/name, as the live composition and the GitHub reality port accept it; compared exactly. */
export const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const HEX64 = /^[0-9a-f]{64}$/;

export interface ChangeIdentity { repository: string; sliceId: string }

export class InvalidChangeIdentityError extends Error {
  readonly code = 'INVALID_CHANGE_IDENTITY';
  readonly field: keyof ChangeIdentity;
  constructor(field: keyof ChangeIdentity) {
    super(`Non-canonical ${field}: a change identity is exact and is never normalised`);
    this.name = 'InvalidChangeIdentityError';
    this.field = field;
  }
}

/** Returns the same two strings or throws. Nothing is normalised. */
export function parseChangeIdentity(input: { repository: unknown; sliceId: unknown }): ChangeIdentity {
  const { repository, sliceId } = input ?? {};
  if (typeof repository !== 'string' || !REPOSITORY_PATTERN.test(repository)) throw new InvalidChangeIdentityError('repository');
  if (typeof sliceId !== 'string' || !SLICE_ID_PATTERN.test(sliceId)) throw new InvalidChangeIdentityError('sliceId');
  return { repository, sliceId };
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** sha256("chief.change.v1\0" + repository + "\0" + sliceId), over the exact identity. */
export function changeKeyOf(input: { repository: unknown; sliceId: unknown }): string {
  const { repository, sliceId } = parseChangeIdentity(input);
  return sha256(`chief.change.v1\0${repository}\0${sliceId}`);
}

export type AdmissionIntegrityCode =
  | 'LEGACY_UNINDEXED_RUN' | 'ADMISSION_REGISTRY_MISMATCH' | 'ADMISSION_RECORD_INVALID' | 'ADMISSION_CLAIM_UNAVAILABLE';

/** Admission state cannot be trusted or established. Fails closed; nothing is repaired or backfilled. */
export class RunAdmissionIntegrityError extends Error {
  readonly code: AdmissionIntegrityCode;
  readonly changeKey?: string;
  constructor(code: AdmissionIntegrityCode, message: string, changeKey?: string) {
    super(message);
    this.name = 'RunAdmissionIntegrityError';
    this.code = code;
    if (changeKey !== undefined) this.changeKey = changeKey;
  }
}

interface RefusalDetails {
  changeKey: string; repository: string; sliceId: string; existingRootRunId: string; requestedRunId: string;
}

/** A second run for a change was refused before it existed. */
export class RunAdmissionRefusedError extends Error {
  readonly code = 'SECOND_RUN_FOR_CHANGE';
  readonly ruleset = ADMISSION_RULESET;
  readonly changeKey: string;
  readonly repository: string;
  readonly sliceId: string;
  readonly existingRootRunId: string;
  readonly requestedRunId: string;
  /** Whether the refusal's operational record was persisted. It never affects the refusal. */
  readonly evidenceRecorded: boolean;
  constructor(details: RefusalDetails & { evidenceRecorded: boolean }) {
    super('Run admission refused: CHIEF-GOV/1 admits exactly one run per change, and this change already has its ROOT run');
    this.name = 'RunAdmissionRefusedError';
    this.changeKey = details.changeKey;
    this.repository = details.repository;
    this.sliceId = details.sliceId;
    this.existingRootRunId = details.existingRootRunId;
    this.requestedRunId = details.requestedRunId;
    this.evidenceRecorded = details.evidenceRecorded;
  }
}

/**
 * The admission of a change's ROOT run. Governance integrity state of the operational
 * kind: it is not authority and not an AUTHORITY_ARCHIVE entry. Written once, never
 * rewritten.
 */
export interface AdmissionRecord {
  schemaVersion: 1;
  kind: 'CHANGE_ADMISSION';
  recordClass: 'OPERATIONAL_RECORD';
  ruleset: typeof ADMISSION_RULESET;
  changeKey: string;
  repository: string;
  sliceId: string;
  rootRunId: string;
  admittedAt: string;
  lineage: [{ runId: string; relation: 'ROOT' }];
  reserved: { continuations: [] };
}

/** Best-effort evidence of one refused second run. Operational only; it grants nothing. */
export interface AdmissionRefusalRecord extends RefusalDetails {
  schemaVersion: 1;
  kind: 'CHANGE_ADMISSION_REFUSAL';
  recordClass: 'OPERATIONAL_RECORD';
  ruleset: typeof ADMISSION_RULESET;
  code: 'SECOND_RUN_FOR_CHANGE';
  refusedAt: string;
}

// The run stores accept any runId with a non-blank character; records hold it exactly.
const runId = z.string().refine((value) => value.trim().length > 0);
const instant = z.string().refine(isInstant);
const head = <K extends string>(kind: K) => ({
  schemaVersion: z.literal(1),
  kind: z.literal(kind),
  recordClass: z.literal('OPERATIONAL_RECORD'),
  ruleset: z.literal(ADMISSION_RULESET),
  changeKey: z.string().regex(HEX64),
  repository: z.string().regex(REPOSITORY_PATTERN),
  sliceId: z.string().regex(SLICE_ID_PATTERN),
});
const derived = (record: { changeKey: string; repository: string; sliceId: string }) => record.changeKey === changeKeyOf(record);
const admissionSchema = z.strictObject({
  ...head('CHANGE_ADMISSION'),
  rootRunId: runId,
  admittedAt: instant,
  // Exactly one ROOT. GOV/1 has no other relation, so no successor can be appended.
  lineage: z.tuple([z.strictObject({ runId, relation: z.literal('ROOT') })]),
  // Reserved for a later ruleset; GOV/1 requires it empty.
  reserved: z.strictObject({ continuations: z.tuple([]) }),
}).refine((record) => derived(record) && record.lineage[0].runId === record.rootRunId);
const refusalSchema = z.strictObject({
  ...head('CHANGE_ADMISSION_REFUSAL'),
  code: z.literal('SECOND_RUN_FOR_CHANGE'),
  existingRootRunId: runId,
  requestedRunId: runId,
  refusedAt: instant,
}).refine(derived);

export function parseAdmissionRecord(input: unknown): AdmissionRecord {
  const parsed = admissionSchema.safeParse(input);
  if (!parsed.success) throw new RunAdmissionIntegrityError('ADMISSION_RECORD_INVALID', 'Not a valid CHIEF-GOV/1 admission record');
  return parsed.data as AdmissionRecord;
}
export function parseAdmissionRefusalRecord(input: unknown): AdmissionRefusalRecord {
  const parsed = refusalSchema.safeParse(input);
  if (!parsed.success) throw new RunAdmissionIntegrityError('ADMISSION_RECORD_INVALID', 'Not a valid CHIEF-GOV/1 refusal record');
  return parsed.data as AdmissionRefusalRecord;
}

export function admissionRecordOf(change: ChangeIdentity, rootRunId: string, admittedAt: string): AdmissionRecord {
  const { repository, sliceId } = parseChangeIdentity(change);
  return parseAdmissionRecord({ schemaVersion: 1, kind: 'CHANGE_ADMISSION', recordClass: 'OPERATIONAL_RECORD',
    ruleset: ADMISSION_RULESET, changeKey: changeKeyOf({ repository, sliceId }), repository, sliceId, rootRunId, admittedAt,
    lineage: [{ runId: rootRunId, relation: 'ROOT' }], reserved: { continuations: [] } });
}

/** A checksummed envelope, as the run store writes runs. */
export function sealAdmissionRecord(record: AdmissionRecord | AdmissionRefusalRecord): string {
  const payload = JSON.stringify(record);
  return JSON.stringify({ checksum: sha256(payload), record: JSON.parse(payload) });
}
function unseal(text: string): unknown {
  let envelope: unknown;
  try { envelope = JSON.parse(text); }
  catch { throw new RunAdmissionIntegrityError('ADMISSION_RECORD_INVALID', 'Corrupt admission storage JSON'); }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
      Object.keys(envelope).sort().join(',') !== 'checksum,record') {
    throw new RunAdmissionIntegrityError('ADMISSION_RECORD_INVALID', 'Invalid admission storage envelope');
  }
  const stored = envelope as { checksum: unknown; record: unknown };
  if (typeof stored.checksum !== 'string' || stored.checksum !== sha256(JSON.stringify(stored.record))) {
    throw new RunAdmissionIntegrityError('ADMISSION_RECORD_INVALID', 'Admission storage checksum mismatch');
  }
  return stored.record;
}
export function openAdmissionRecord(text: string): AdmissionRecord { return parseAdmissionRecord(unseal(text)); }
export function openAdmissionRefusalRecord(text: string): AdmissionRefusalRecord { return parseAdmissionRefusalRecord(unseal(text)); }

/**
 * Against an existing claim, only the run that owns it may still be created, and only
 * while its run does not exist yet (the caller has checked that): a claim left by a crash
 * before its run was written. Anything else is a second run.
 */
export function admissionDecision(record: AdmissionRecord, change: ChangeIdentity, requestedRunId: string):
  'ROOT_PENDING' | 'SECOND_RUN_FOR_CHANGE' {
  return record.rootRunId === requestedRunId && record.repository === change.repository && record.sliceId === change.sliceId
    ? 'ROOT_PENDING' : 'SECOND_RUN_FOR_CHANGE';
}

/**
 * Throws the refusal. It is decided before any evidence is attempted: `persist` is offered
 * the operational record best-effort, and nothing it does (fail, throw, meet a bad clock)
 * can turn the refusal into an admission.
 */
export function refuseSecondRun(record: AdmissionRecord, change: ChangeIdentity, requestedRunId: string, clock: Clock,
  persist: (refusal: AdmissionRefusalRecord) => void): never {
  const details: RefusalDetails = { changeKey: record.changeKey, repository: change.repository, sliceId: change.sliceId,
    existingRootRunId: record.rootRunId, requestedRunId };
  let evidenceRecorded = false;
  try {
    persist(parseAdmissionRefusalRecord({ schemaVersion: 1, kind: 'CHANGE_ADMISSION_REFUSAL', recordClass: 'OPERATIONAL_RECORD',
      ruleset: ADMISSION_RULESET, code: 'SECOND_RUN_FOR_CHANGE', ...details, refusedAt: clock.now() }));
    evidenceRecorded = true;
  } catch { evidenceRecorded = false; }
  throw new RunAdmissionRefusedError({ ...details, evidenceRecorded });
}
