import { createHash } from 'node:crypto';
import { z } from 'zod';
import { GOAL_ID, PROJECT_ID, humanPrincipalSchema, type HumanPrincipalV1 } from '../identity/canonical.js';
import { ADMISSION_RULESET, REPOSITORY_PATTERN, SLICE_ID_PATTERN, changeKeyOf } from './admission.js';
import { isInstant } from './time.js';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const goalInstant = z.string().refine((value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const objective = z.string().refine((value) => value.trim().length > 0 && value.length <= 2000 &&
  !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value));
const sourceIdentitySchema = z.strictObject({ kind: z.literal('WORKSPACE_GOAL'), projectId: z.string().regex(PROJECT_ID),
  goalId: z.string().regex(GOAL_ID) });
const sourceSchema = z.strictObject({ schemaVersion: z.literal(1), ...sourceIdentitySchema.shape, createdAt: goalInstant,
  submittedBy: humanPrincipalSchema, objective });
const requestSchema = z.strictObject({ repository: z.string().regex(REPOSITORY_PATTERN), source: sourceSchema });
const recordSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal('CHANGE_MINT'), recordClass: z.literal('OPERATIONAL_RECORD'),
  ruleset: z.literal(ADMISSION_RULESET), sourceKey: hex64,
  source: z.strictObject({ ...sourceIdentitySchema.shape, createdAt: goalInstant, submittedBy: humanPrincipalSchema,
    objectiveHash: hex64 }),
  repository: z.string().regex(REPOSITORY_PATTERN), sliceId: z.string().regex(SLICE_ID_PATTERN), changeKey: hex64,
  mintedAt: z.string().refine(isInstant),
});

export type ChangeSourceIdentityV1 = z.infer<typeof sourceIdentitySchema>;
export type ChangeSourceV1 = Omit<z.infer<typeof sourceSchema>, 'submittedBy'> & { submittedBy: HumanPrincipalV1 };
export type ChangeMintRequestV1 = { repository: string; source: ChangeSourceV1 };
export type ChangeMintRecordV1 = z.infer<typeof recordSchema>;
export interface ChangeRefV1 { kind: 'SLICE'; changeId: string }
export type ChangeMintErrorCode = 'INVALID_CHANGE_SOURCE' | 'UNATTRIBUTED_SOURCE' | 'CHANGE_SOURCE_BINDING_CONFLICT' |
  'REGISTRY_INTEGRITY' | 'PUBLICATION_UNAVAILABLE';

export class ChangeMintError extends Error {
  constructor(readonly code: ChangeMintErrorCode, message: string) {
    super(message);
    this.name = 'ChangeMintError';
  }
}

export function parseChangeSourceIdentity(input: unknown): ChangeSourceIdentityV1 {
  const parsed = sourceIdentitySchema.safeParse(input);
  if (!parsed.success) throw new ChangeMintError('INVALID_CHANGE_SOURCE', 'Invalid Workspace Goal source identity');
  return parsed.data;
}

export function parseChangeMintRequest(input: unknown): ChangeMintRequestV1 {
  if (input && typeof input === 'object' && 'source' in input && input.source && typeof input.source === 'object' &&
      'submittedBy' in input.source && input.source.submittedBy === null) {
    throw new ChangeMintError('UNATTRIBUTED_SOURCE', 'A legacy Goal without Human attribution cannot be minted');
  }
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) throw new ChangeMintError('INVALID_CHANGE_SOURCE', 'Invalid governed Change source request');
  return parsed.data;
}

export function sourceKeyOf(input: unknown): string {
  const { kind, projectId, goalId } = parseChangeSourceIdentity(input);
  return sha256(`chief.change.source.v1\0${kind}\0${projectId}\0${goalId}`);
}

export function objectiveHashOf(text: string): string {
  const parsed = objective.safeParse(text);
  if (!parsed.success) throw new ChangeMintError('INVALID_CHANGE_SOURCE', 'Invalid exact Goal objective');
  return sha256(`chief.goal.objective.v1\0${parsed.data}`);
}

export function parseChangeMintRecord(input: unknown): ChangeMintRecordV1 {
  const parsed = recordSchema.safeParse(input);
  if (!parsed.success) throw new ChangeMintError('REGISTRY_INTEGRITY', 'Invalid Change Mint record');
  const record = parsed.data;
  if (record.sourceKey !== sourceKeyOf({ kind: record.source.kind, projectId: record.source.projectId,
    goalId: record.source.goalId }) || record.sliceId !== `goal-${record.sourceKey}` ||
      record.changeKey !== changeKeyOf({ repository: record.repository, sliceId: record.sliceId })) {
    throw new ChangeMintError('REGISTRY_INTEGRITY', 'Change Mint record identity does not derive from its source');
  }
  return record;
}

export function changeMintRecordOf(input: unknown, mintedAt: string): ChangeMintRecordV1 {
  const request = parseChangeMintRequest(input);
  const sourceKey = sourceKeyOf({ kind: request.source.kind, projectId: request.source.projectId, goalId: request.source.goalId });
  const sliceId = `goal-${sourceKey}`;
  return parseChangeMintRecord({ schemaVersion: 1, kind: 'CHANGE_MINT', recordClass: 'OPERATIONAL_RECORD',
    ruleset: ADMISSION_RULESET, sourceKey,
    source: { kind: request.source.kind, projectId: request.source.projectId, goalId: request.source.goalId,
      createdAt: request.source.createdAt, submittedBy: request.source.submittedBy,
      objectiveHash: objectiveHashOf(request.source.objective) },
    repository: request.repository, sliceId, changeKey: changeKeyOf({ repository: request.repository, sliceId }), mintedAt });
}

export function changeRefOf(record: ChangeMintRecordV1): ChangeRefV1 {
  const valid = parseChangeMintRecord(record);
  return { kind: 'SLICE', changeId: valid.sliceId };
}

/** Shared CM1 binding check, usable by read projections without obtaining a minter. */
export function requireSameChangeBinding(record: ChangeMintRecordV1, input: ChangeMintRequestV1): ChangeMintRecordV1 {
  const valid = parseChangeMintRecord(record);
  const request = parseChangeMintRequest(input);
  const source = request.source;
  if (valid.repository !== request.repository || valid.source.kind !== source.kind ||
      valid.source.projectId !== source.projectId || valid.source.goalId !== source.goalId ||
      valid.source.createdAt !== source.createdAt || valid.source.submittedBy.schemaVersion !== source.submittedBy.schemaVersion ||
      valid.source.submittedBy.kind !== source.submittedBy.kind ||
      valid.source.submittedBy.principalRef !== source.submittedBy.principalRef ||
      valid.source.objectiveHash !== objectiveHashOf(source.objective)) {
    throw new ChangeMintError('CHANGE_SOURCE_BINDING_CONFLICT', 'This Workspace Goal already has a different governed Change binding');
  }
  return valid;
}
