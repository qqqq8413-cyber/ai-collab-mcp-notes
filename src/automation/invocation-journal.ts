import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isCanonicalEgressSet, sameEgressSet } from './egress-destination.js';
import { isInstant, parseInstant } from './time.js';
import { ACTOR_KINDS, type ActorKind } from './types.js';

// Operational coordination state for external actor calls: was this exact call
// prepared, started, completed, applied? It records no authority. It is not an
// acceptance, an authorization, a repository fact, a provider fact, or a controller
// store; the controller's occurrence guard still decides whether a result may apply.

export const INVOCATION_STATES = Object.freeze(['PREPARED', 'STARTED', 'COMPLETED', 'APPLIED', 'UNCERTAIN', 'ABANDONED'] as const);
export type InvocationState = typeof INVOCATION_STATES[number];
export { ACTOR_KINDS, type ActorKind };

/** A stored result is at most this many bytes of canonical JSON. */
export const MAX_RESULT_BYTES = 256 * 1024;

/**
 * PREPARED records intent; nothing has been dispatched. STARTED is written before
 * dispatch and consumes a call. COMPLETED holds the detached result, stored before it
 * is applied. APPLIED, UNCERTAIN, and ABANDONED are final.
 */
const TRANSITIONS: Readonly<Record<InvocationState, readonly InvocationState[]>> = Object.freeze({
  PREPARED: ['STARTED', 'ABANDONED'],
  STARTED: ['COMPLETED', 'UNCERTAIN'],
  COMPLETED: ['APPLIED', 'ABANDONED'],
  APPLIED: [],
  UNCERTAIN: [],
  ABANDONED: [],
});

export interface InvocationOccurrence { sequence: number; action: string; timestamp: string }
export interface InvocationIdentity {
  runId: string;
  sliceId: string;
  packetId: string;
  packetHash: string;
  occurrence: InvocationOccurrence;
  actorKind: ActorKind;
  provider: string;
  model: string;
  /** The exact canonical egress destination set the call was authorized and bound to. */
  egressDestinations: string[];
  /** Linkage to the caller-supplied grant; the grant itself is never stored. */
  authorizationId: string;
}
export interface InvocationTransition { state: InvocationState; at: string; note?: string }
export interface StoredResult {
  serialized: string;
  sha256: string;
  completedAt: string;
  metadata: { provider: string; model: string; egressDestinations: string[]; authorizationId: string };
}
export interface InvocationRecord {
  invocationId: string;
  identity: InvocationIdentity;
  state: InvocationState;
  history: InvocationTransition[];
  result?: StoredResult;
  /** APPLIED only: the controller entry the result became. */
  application?: { sequence: number; action: string };
}
/** What an actor call produced: a validated result, or why it was unusable. Either way, it is applied. */
export type StoredOutcome = { ok: true; value: unknown } | { ok: false; error: string };

export type StartResult =
  | { status: 'STARTED'; record: InvocationRecord }
  | { status: 'BUDGET_EXHAUSTED'; used: number }
  | { status: 'NOT_PREPARED'; record: InvocationRecord };

export interface InvocationJournal {
  /** Records intent for one occurrence and actor kind. A second identity for the same key is refused. */
  prepare(identity: InvocationIdentity): InvocationRecord;
  get(invocationId: string): InvocationRecord | undefined;
  find(runId: string, sequence: number, actorKind: ActorKind): InvocationRecord | undefined;
  list(runId: string): InvocationRecord[];
  /** PREPARED -> STARTED only while fewer than `maxCalls` calls of the same run and packet have ever started. */
  start(invocationId: string, maxCalls: number): StartResult;
  complete(invocationId: string, outcome: StoredOutcome): InvocationRecord;
  markUncertain(invocationId: string, note: string): InvocationRecord;
  abandon(invocationId: string, note: string): InvocationRecord;
  markApplied(invocationId: string, application: { sequence: number; action: string }): InvocationRecord;
}

/** Stored bytes that fail their own integrity check. Never repaired, never read around. */
export class InvocationJournalIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvocationJournalIntegrityError';
  }
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** The one identifier per run, occurrence sequence, and actor kind. */
export function invocationIdOf(runId: string, sequence: number, actorKind: ActorKind): string {
  return sha256Hex(JSON.stringify([runId, sequence, actorKind]));
}

/**
 * Canonical JSON of plain data: object members in code-unit key order, undefined
 * members absent. Accessors, functions, symbols, sparse arrays, non-plain objects,
 * and non-finite numbers are refused, and no getter is run.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Non-finite number is not plain data');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (!descriptor || !('value' in descriptor) || descriptor.value === undefined) throw new TypeError('Array is not plain data');
      items.push(canonicalJson(descriptor.value));
    }
    return `[${items.join(',')}]`;
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Object is not plain data');
    if (Object.getOwnPropertySymbols(value).length) throw new TypeError('Symbol keys are not plain data');
    const members: string[] = [];
    for (const key of Object.getOwnPropertyNames(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!('value' in descriptor) || !descriptor.enumerable) throw new TypeError(`Member ${key} is not plain data`);
      if (descriptor.value === undefined) continue;
      members.push(`${JSON.stringify(key)}:${canonicalJson(descriptor.value)}`);
    }
    return `{${members.join(',')}}`;
  }
  throw new TypeError(`${typeof value} is not plain data`);
}

const exact = z.string().min(1).refine((value) => value.trim() === value && !value.includes('\0'));
const instant = z.string().refine(isInstant);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const egressSet = z.array(z.string()).refine((set) => isCanonicalEgressSet(set));
const identitySchema = z.strictObject({
  runId: exact, sliceId: exact, packetId: exact, packetHash: hex64,
  occurrence: z.strictObject({ sequence: z.number().int().positive(), action: exact, timestamp: instant }),
  actorKind: z.enum(ACTOR_KINDS), provider: exact, model: exact, egressDestinations: egressSet, authorizationId: exact,
});
const transitionSchema = z.strictObject({ state: z.enum(INVOCATION_STATES), at: instant, note: z.string().max(2000).optional() });
const resultSchema = z.strictObject({
  serialized: z.string(), sha256: hex64, completedAt: instant,
  metadata: z.strictObject({ provider: exact, model: exact, egressDestinations: egressSet, authorizationId: exact }),
});
const recordSchema = z.strictObject({
  invocationId: hex64, identity: identitySchema, state: z.enum(INVOCATION_STATES),
  history: z.array(transitionSchema).min(1).max(8), result: resultSchema.optional(),
  application: z.strictObject({ sequence: z.number().int().positive(), action: exact }).optional(),
});
const outcomeSchema = z.union([
  z.strictObject({ ok: z.literal(true), value: z.unknown() }),
  z.strictObject({ ok: z.literal(false), error: z.string().min(1).max(4000) }),
]);

export function parseInvocationIdentity(value: unknown): InvocationIdentity {
  return identitySchema.parse(value) as InvocationIdentity;
}

function integrity(condition: boolean, why: string): void {
  if (!condition) throw new InvocationJournalIntegrityError(`Invocation journal record ${why}`);
}

/** A validated copy of a stored record, with every internal invariant checked. */
export function parseInvocationRecord(value: unknown): InvocationRecord {
  const parsed = recordSchema.safeParse(value);
  integrity(parsed.success, 'is malformed');
  const record = parsed.data as InvocationRecord;
  const { identity } = record;
  integrity(record.invocationId === invocationIdOf(identity.runId, identity.occurrence.sequence, identity.actorKind), 'has a foreign id');
  integrity(record.history[0].state === 'PREPARED', 'does not start PREPARED');
  let previousAt = -Infinity;
  for (let index = 0; index < record.history.length; index++) {
    const at = parseInstant(record.history[index].at)!;
    integrity(at >= previousAt, 'history goes back in time');
    previousAt = at;
    if (index > 0) integrity(TRANSITIONS[record.history[index - 1].state].includes(record.history[index].state), 'history has an illegal transition');
  }
  integrity(record.history.at(-1)!.state === record.state, 'state does not match its history');
  const completed = record.history.some((entry) => entry.state === 'COMPLETED');
  integrity(completed === (record.result !== undefined), 'result does not match its history');
  if (record.result) {
    integrity(Buffer.byteLength(record.result.serialized) <= MAX_RESULT_BYTES, 'result exceeds its bound');
    integrity(record.result.sha256 === sha256Hex(record.result.serialized), 'result digest does not match');
    const metadata = record.result.metadata;
    integrity(metadata.provider === identity.provider && metadata.model === identity.model &&
      sameEgressSet(metadata.egressDestinations, identity.egressDestinations) && metadata.authorizationId === identity.authorizationId,
    'result metadata does not match its identity');
  }
  integrity((record.state === 'APPLIED') === (record.application !== undefined), 'application does not match its state');
  if (record.application) integrity(record.application.sequence === identity.occurrence.sequence + 1, 'application is not the next controller entry');
  return record;
}

/** Throws unless `after` is `before` advanced by exactly one legal transition, with identity and any stored result unchanged. */
export function assertInvocationTransition(before: InvocationRecord, after: InvocationRecord): void {
  const next = parseInvocationRecord(after);
  integrity(next.invocationId === before.invocationId && canonicalJson(next.identity) === canonicalJson(before.identity), 'identity changed');
  integrity(next.history.length === before.history.length + 1 &&
    before.history.every((entry, index) => canonicalJson(entry) === canonicalJson(next.history[index])), 'history is not append-only');
  integrity(TRANSITIONS[before.state].includes(next.state), `cannot move ${before.state} to ${next.state}`);
  if (before.result) integrity(canonicalJson(before.result) === canonicalJson(next.result), 'stored result changed');
}

/** The stored outcome, after checking its digest again. */
export function readStoredOutcome(record: InvocationRecord): StoredOutcome {
  const result = record.result;
  integrity(result !== undefined, 'has no stored result');
  integrity(result!.sha256 === sha256Hex(result!.serialized), 'result digest does not match');
  let parsed: unknown;
  try { parsed = JSON.parse(result!.serialized); } catch { parsed = undefined; }
  const outcome = outcomeSchema.safeParse(parsed);
  integrity(outcome.success, 'result is not a stored outcome');
  return outcome.data as StoredOutcome;
}

/** Canonical, bounded serialization of an outcome for storage. Throws if it is not bounded plain data. */
export function serializeOutcome(outcome: StoredOutcome): string {
  const shaped = outcomeSchema.parse(outcome);
  const serialized = canonicalJson(shaped);
  if (Buffer.byteLength(serialized) > MAX_RESULT_BYTES) throw new RangeError(`Stored result exceeds ${MAX_RESULT_BYTES} bytes`);
  return serialized;
}

export function legalInvocationTransition(from: InvocationState, to: InvocationState): boolean {
  return TRANSITIONS[from].includes(to);
}
