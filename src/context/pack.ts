import { contextFingerprint, fingerprintSerialized, serializePayload } from './fingerprint.js';
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

const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/**
 * The own data fields of a plain object, read from their descriptors: accessors,
 * symbols, inherited or unknown fields fail, and nothing is read twice.
 */
function ownData(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const data: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !allowed.includes(key) || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${label} has an unexpected or non-data field ${String(key)}`);
    }
    data[key] = descriptor.value;
  }
  return data;
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
 * Detaches and freezes the projection, enforces the budget on the same canonical text
 * the fingerprint is taken from, and returns the sealed pack. Required context is
 * atomic: if it does not fit, the build fails. An excerpt must fit whole or the build
 * fails. Nothing is dropped, shortened, summarized, or reordered to fit.
 */
export function sealContextPack(parts: ContextPackParts, policy: Readonly<ContextPackPolicy>, capturedAt: string): ContextPack {
  const detached = structuredClone(parts);
  const required: ContextPackPayload = {
    schemaVersion: CONTEXT_PACK_SCHEMA_VERSION,
    binding: detached.binding,
    question: detached.question,
    sources: detached.sources,
  };
  const requiredChars = serializePayload(required).length;
  if (requiredChars > policy.maxSerializedChars) {
    throw new ContextPackBudgetError(
      `Required route context needs ${requiredChars} canonical characters; the policy allows ${policy.maxSerializedChars}. ` +
        'It is not truncated or reduced to fit.'
    );
  }
  const payload: ContextPackPayload = detached.artifact ? { ...required, artifact: detached.artifact } : required;
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

const PACK_KEYS = ['schemaVersion', 'binding', 'question', 'sources', 'artifact', 'contextFingerprint', 'capturedAt'];
const BINDING_KEYS = ['deliberationStateId', 'sessionId', 'artifactHash', 'authorContextHash', 'attemptId', 'decisionId',
  'questionId', 'route', 'inputRefs'];
const REF_KINDS = ['FINDING', 'SEMANTIC_ISSUE', 'AUTHOR_CONTEXT_ITEM'];
const CATEGORIES = ['confirmedFacts', 'knownRisks', 'openQuestions', 'constraints'];

function requireKeys(data: Record<string, unknown>, keys: readonly string[], label: string): void {
  for (const key of keys) if (!Object.hasOwn(data, key)) throw new TypeError(`${label}.${key} is missing`);
}

function assertRef(value: unknown, label: string): { kind: string; id: string } {
  const ref = ownData(value, ['kind', 'id'], label);
  if (!REF_KINDS.includes(ref.kind as string) || !nonempty(ref.id)) throw new TypeError(`${label} is not a route input ref`);
  return ref as { kind: string; id: string };
}

/** Structure only; content is judged by the fingerprint and by current canonical facts. */
function assertPackShape(value: unknown): void {
  const pack = ownData(value, PACK_KEYS, 'ContextPack');
  requireKeys(pack, PACK_KEYS.filter((key) => key !== 'artifact'), 'ContextPack');
  if (pack.schemaVersion !== CONTEXT_PACK_SCHEMA_VERSION) throw new TypeError('ContextPack.schemaVersion is not supported');

  const binding = ownData(pack.binding, BINDING_KEYS, 'ContextPack.binding');
  requireKeys(binding, BINDING_KEYS, 'ContextPack.binding');
  for (const key of BINDING_KEYS.slice(0, 7)) {
    if (!nonempty(binding[key])) throw new TypeError(`ContextPack.binding.${key} is invalid`);
  }
  if (binding.route !== 'ADD_REVIEWER' && binding.route !== 'REPLICATE') throw new TypeError('ContextPack.binding.route is not supported');
  if (!Array.isArray(binding.inputRefs) || binding.inputRefs.length === 0) throw new TypeError('ContextPack.binding.inputRefs is invalid');
  const refs = binding.inputRefs.map((ref, index) => assertRef(ref, `ContextPack.binding.inputRefs[${index}]`));

  const question = ownData(pack.question, ['rootCause', 'materialityReason'], 'ContextPack.question');
  requireKeys(question, ['rootCause', 'materialityReason'], 'ContextPack.question');
  if (!nonempty(question.rootCause) || !nonempty(question.materialityReason)) throw new TypeError('ContextPack.question is invalid');

  if (!Array.isArray(pack.sources) || pack.sources.length !== refs.length) {
    throw new TypeError('ContextPack.sources must hold exactly one source per route input ref');
  }
  pack.sources.forEach((entry, index) => {
    const label = `ContextPack.sources[${index}]`;
    const isAuthor = refs[index].kind === 'AUTHOR_CONTEXT_ITEM';
    const keys = isAuthor ? ['ref', 'category', 'value'] : ['ref', 'value'];
    const source = ownData(entry, keys, label);
    requireKeys(source, keys, label);
    const ref = assertRef(source.ref, `${label}.ref`);
    if (ref.kind !== refs[index].kind || ref.id !== refs[index].id) throw new TypeError(`${label}.ref is not the route ref at its position`);
    if (isAuthor && !CATEGORIES.includes(source.category as string)) throw new TypeError(`${label}.category is invalid`);
    const record = source.value;
    if (record === null || typeof record !== 'object' || Array.isArray(record) || (record as { id?: unknown }).id !== ref.id) {
      throw new TypeError(`${label}.value is not the record its ref names`);
    }
  });

  if (Object.hasOwn(pack, 'artifact')) {
    const artifact = ownData(pack.artifact, ['selectionScope', 'startChar', 'endChar', 'text'], 'ContextPack.artifact');
    requireKeys(artifact, ['selectionScope', 'startChar', 'endChar', 'text'], 'ContextPack.artifact');
    const { startChar, endChar, text } = artifact;
    if (artifact.selectionScope !== 'EXCERPT' || !Number.isSafeInteger(startChar) || !Number.isSafeInteger(endChar) ||
        (startChar as number) < 0 || (startChar as number) >= (endChar as number) || typeof text !== 'string' ||
        text.length !== (endChar as number) - (startChar as number)) {
      throw new TypeError('ContextPack.artifact is not an exact excerpt');
    }
  }
  if (typeof pack.contextFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(pack.contextFingerprint)) {
    throw new TypeError('ContextPack.contextFingerprint is invalid');
  }
  if (typeof pack.capturedAt !== 'string' || Number.isNaN(Date.parse(pack.capturedAt))) {
    throw new TypeError('ContextPack.capturedAt is invalid');
  }
}

/**
 * Self-integrity: a detached copy of the offered pack, its shape checked, and its
 * fingerprint recomputed from its own payload. Any failure is an invalid pack, which is
 * a different finding from a valid pack that has gone stale.
 */
export function readContextPack(value: unknown): ContextPack {
  let copy: unknown;
  try {
    copy = structuredClone(value);
  } catch {
    throw new InvalidContextPackError('ContextPack is not plain data');
  }
  try {
    assertPackShape(copy);
  } catch (error) {
    throw new InvalidContextPackError(`ContextPack is malformed: ${(error as Error).message}`);
  }
  const pack = deepFreeze(copy as ContextPack);
  let recomputed: string;
  try {
    recomputed = contextFingerprint(pack);
  } catch (error) {
    throw new InvalidContextPackError(`ContextPack payload is not canonical data: ${(error as Error).message}`);
  }
  if (recomputed !== pack.contextFingerprint) {
    throw new InvalidContextPackError('ContextPack contextFingerprint does not match its payload: the pack was altered after it was built');
  }
  return pack;
}
