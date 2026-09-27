import { canonicalSerialize, contextFingerprint, fingerprintSerialized, serializePayload } from './fingerprint.js';
import { assertContextPackPayload, exactRecord, nonempty, ownData } from './schema.js';
import type {
  ArtifactExcerpt,
  ContextPack,
  ContextPackBinding,
  ContextPackPayload,
  ContextPackPolicy,
  ContextPackQuestion,
  ContextPackSelection,
  ContextPackSource,
} from './types.js';

export const CONTEXT_PACK_SCHEMA_VERSION = 'E0-R6_CONTEXT_PACK_V1' as const;

/** A pack that is malformed or whose payload no longer matches its own fingerprint. Never merely stale. */
export class InvalidContextPackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidContextPackError';
  }
}

/** Required context, or an optional excerpt, does not fit the composition's budget. Nothing is dropped instead. */
export class ContextPackBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContextPackBudgetError';
  }
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const member of Object.values(value)) deepFreeze(member);
    Object.freeze(value);
  }
  return value;
}

/** Snapshotted once at composition. A finite, positive, safe integer; there is no default. */
export function snapshotContextPackPolicy(value: unknown): Readonly<ContextPackPolicy> {
  const data = ownData(value, ['maxSerializedChars'], 'ContextPackPolicy');
  const max = data.maxSerializedChars;
  if (typeof max !== 'number' || !Number.isSafeInteger(max) || max <= 0) {
    throw new TypeError('ContextPackPolicy.maxSerializedChars must be a finite positive integer');
  }
  return Object.freeze({ maxSerializedChars: max });
}

/**
 * Caller intent only: an attempt, and optional artifact offsets. Anything that states a
 * canonical fact (hashes, ids, route, refs, excerpt text) is refused, not ignored.
 */
export function snapshotContextPackSelection(value: unknown): ContextPackSelection {
  const data = ownData(value, ['attemptId', 'artifactSelection'], 'ContextPackSelection');
  if (!nonempty(data.attemptId)) throw new TypeError('ContextPackSelection.attemptId must be a non-empty string');
  const selection: ContextPackSelection = { attemptId: data.attemptId };
  if (Object.hasOwn(data, 'artifactSelection')) {
    const range = ownData(data.artifactSelection, ['startChar', 'endChar'], 'ContextPackSelection.artifactSelection');
    if (!Number.isSafeInteger(range.startChar) || !Number.isSafeInteger(range.endChar)) {
      throw new TypeError('ContextPackSelection.artifactSelection needs integer startChar and endChar');
    }
    selection.artifactSelection = { startChar: range.startChar as number, endChar: range.endChar as number };
  }
  return deepFreeze(selection);
}

export interface ContextPackParts {
  binding: ContextPackBinding;
  question: ContextPackQuestion;
  sources: ContextPackSource[];
  artifact?: ArtifactExcerpt;
}

/**
 * Detaches and freezes the projection, checks it against the pack schema, enforces the
 * budget on the same canonical text the fingerprint is taken from, and returns the
 * sealed pack. Required context is atomic: if it does not fit, the build fails. An
 * excerpt must fit whole or the build fails. Nothing is dropped, shortened,
 * summarized, or reordered to fit.
 */
export function sealContextPack(parts: ContextPackParts, policy: Readonly<ContextPackPolicy>, capturedAt: string): ContextPack {
  const detached = structuredClone(parts);
  const required: ContextPackPayload = {
    schemaVersion: CONTEXT_PACK_SCHEMA_VERSION,
    binding: detached.binding,
    question: detached.question,
    sources: detached.sources,
  };
  const payload: ContextPackPayload = detached.artifact ? { ...required, artifact: detached.artifact } : required;
  assertContextPackPayload(payload as unknown as Record<string, unknown>, CONTEXT_PACK_SCHEMA_VERSION);
  const requiredChars = serializePayload(required).length;
  if (requiredChars > policy.maxSerializedChars) {
    throw new ContextPackBudgetError(
      `Required route context needs ${requiredChars} canonical characters; the policy allows ${policy.maxSerializedChars}. ` +
        'It is not truncated or reduced to fit.'
    );
  }
  deepFreeze(payload);
  const serialized = serializePayload(payload);
  if (serialized.length > policy.maxSerializedChars) {
    throw new ContextPackBudgetError(
      `The artifact excerpt brings the pack to ${serialized.length} canonical characters; the policy allows ` +
        `${policy.maxSerializedChars}. An excerpt is never truncated to fit.`
    );
  }
  return deepFreeze({ ...payload, contextFingerprint: fingerprintSerialized(serialized), capturedAt });
}

const PACK_REQUIRED = ['schemaVersion', 'binding', 'question', 'sources', 'contextFingerprint', 'capturedAt'];

/**
 * Self-integrity: the offered pack must be plain data (no accessor is run), its
 * detached copy must satisfy the one pack schema, and its fingerprint must match its
 * own payload. Any failure is an invalid pack, which is a different finding from a
 * valid pack that has gone stale, and it is decided before currentness is looked at.
 */
export function readContextPack(value: unknown): ContextPack {
  let copy: unknown;
  try {
    canonicalSerialize(value);
    copy = structuredClone(value);
  } catch (error) {
    throw new InvalidContextPackError(`ContextPack is not plain data: ${(error as Error).message}`);
  }
  try {
    const data = exactRecord(copy, PACK_REQUIRED, ['artifact'], 'ContextPack');
    assertContextPackPayload(data, CONTEXT_PACK_SCHEMA_VERSION);
    if (typeof data.contextFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(data.contextFingerprint)) {
      throw new TypeError('ContextPack.contextFingerprint is invalid');
    }
    if (typeof data.capturedAt !== 'string' || Number.isNaN(Date.parse(data.capturedAt))) {
      throw new TypeError('ContextPack.capturedAt is invalid');
    }
  } catch (error) {
    throw new InvalidContextPackError(`ContextPack is malformed: ${(error as Error).message}`);
  }
  const pack = deepFreeze(copy as ContextPack);
  if (contextFingerprint(pack) !== pack.contextFingerprint) {
    throw new InvalidContextPackError('ContextPack contextFingerprint does not match its payload: the pack was altered after it was built');
  }
  return pack;
}
