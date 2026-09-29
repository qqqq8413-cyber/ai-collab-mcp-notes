import { isIP } from 'node:net';
import { z } from 'zod';
import { isCanonicalEgressDestination, isCanonicalEgressSet } from './egress-destination.js';
import { canonicalJson } from './invocation-journal.js';
import { isInstant, parseInstant } from './time.js';

// Operational evidence of what one model process's egress broker did: one session per
// invocation, bound to the exact provider, model, and authorized egress set, holding an
// append-only list of connection decisions. It is not an authorization, a
// HumanAdjudication, an acceptance, a RouteOutcome, repository truth, or provider truth,
// and it drives no lifecycle. An event holds bounded, non-secret metadata only: which
// canonical destination was asked for, what the broker decided, the address it connected
// to, and a reason code. Headers, bodies, credentials, and free text are not representable.

export const EGRESS_SESSION_STATES = Object.freeze(['OPEN', 'CLOSED'] as const);
export type EgressSessionState = typeof EGRESS_SESSION_STATES[number];
export const EGRESS_RESULTS = Object.freeze(['DENIED', 'CONNECTED', 'CONNECT_FAILED'] as const);
export type EgressResult = typeof EGRESS_RESULTS[number];

// Each reason belongs to one result, and says whether the event names a destination.
const REASONS = Object.freeze({
  // The upstream TCP connection exists.
  ALLOWLISTED: { result: 'CONNECTED', destination: 'ALLOWED' },
  // The broker refused; nothing was connected upstream.
  NOT_ALLOWLISTED: { result: 'DENIED', destination: 'OUTSIDE' },
  UNSAFE_ADDRESS: { result: 'DENIED', destination: 'ALLOWED' },
  NOT_CANONICAL: { result: 'DENIED', destination: 'NONE' },
  NOT_CONNECT: { result: 'DENIED', destination: 'NONE' },
  MALFORMED_REQUEST: { result: 'DENIED', destination: 'NONE' },
  HEADER_LIMIT: { result: 'DENIED', destination: 'NONE' },
  HANDSHAKE_TIMEOUT: { result: 'DENIED', destination: 'NONE' },
  CONNECTION_LIMIT: { result: 'DENIED', destination: 'NONE' },
  BROKER_CLOSING: { result: 'DENIED', destination: 'NONE' },
  // An allowlisted destination that could not be reached.
  RESOLUTION_FAILED: { result: 'CONNECT_FAILED', destination: 'ALLOWED' },
  UPSTREAM_UNREACHABLE: { result: 'CONNECT_FAILED', destination: 'ALLOWED' },
} as const satisfies Record<string, { result: EgressResult; destination: 'ALLOWED' | 'OUTSIDE' | 'NONE' }>);
export type EgressReason = keyof typeof REASONS;
export const EGRESS_REASONS = Object.freeze(Object.keys(REASONS) as EgressReason[]);

/** A session holds at most this many events; the broker refuses connections beyond it. */
export const MAX_EGRESS_EVENTS = 4096;

export interface EgressSessionIdentity {
  invocationId: string;
  provider: string;
  model: string;
  /** The exact canonical set the broker enforces for this invocation. */
  egressDestinations: string[];
}
export interface EgressEventInput {
  result: EgressResult;
  reason: EgressReason;
  /** The canonical destination asked for, or null when the request named none (or none canonically). */
  requested: string | null;
  /** CONNECTED only: the validated IP address the tunnel was connected to. */
  address?: string;
}
export interface EgressEvent extends EgressEventInput { sequence: number; at: string }
export interface EgressSession {
  sessionId: string;
  identity: EgressSessionIdentity;
  state: EgressSessionState;
  openedAt: string;
  closedAt?: string;
  events: EgressEvent[];
}
export interface EgressSummary {
  sessionId: string;
  allowlist: string[];
  closed: boolean;
  connected: number;
  denied: number;
  connectFailed: number;
}

export interface EgressJournal {
  /** Opens the one session of an invocation. A second session for it is refused. */
  open(identity: EgressSessionIdentity): EgressSession;
  /** Appends one event, durably, before returning. Refused once the session is closed. */
  record(sessionId: string, event: EgressEventInput): EgressEvent;
  /** OPEN -> CLOSED. Final. */
  close(sessionId: string): EgressSession;
  get(sessionId: string): EgressSession | undefined;
}

/** Stored bytes that fail their own integrity check. Never repaired, never read around. */
export class EgressJournalIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EgressJournalIntegrityError';
  }
}

const exact = z.string().min(1).max(200).refine((value) => value.trim() === value && !/[\u0000-\u001f]/.test(value));
const instant = z.string().refine(isInstant);
const identitySchema = z.strictObject({
  invocationId: z.string().regex(/^[0-9a-f]{64}$/), provider: exact, model: exact,
  egressDestinations: z.array(z.string()).refine((set) => isCanonicalEgressSet(set)),
});
const eventSchema = z.strictObject({
  sequence: z.number().int().positive(), at: instant, result: z.enum(EGRESS_RESULTS), reason: z.enum(EGRESS_REASONS as [EgressReason, ...EgressReason[]]),
  requested: z.string().refine(isCanonicalEgressDestination).nullable(), address: z.string().refine((value) => isIP(value) !== 0).optional(),
});
const sessionSchema = z.strictObject({
  sessionId: z.string().regex(/^[0-9a-f]{64}$/), identity: identitySchema, state: z.enum(EGRESS_SESSION_STATES),
  openedAt: instant, closedAt: instant.optional(), events: z.array(eventSchema).max(MAX_EGRESS_EVENTS),
});

function integrity(condition: boolean, why: string): void {
  if (!condition) throw new EgressJournalIntegrityError(`Egress session ${why}`);
}

export function parseEgressIdentity(value: unknown): EgressSessionIdentity {
  return identitySchema.parse(value) as EgressSessionIdentity;
}

/** Throws unless the event is consistent with its reason and with the session's allowlist. */
function checkEvent(event: EgressEventInput, allowlist: readonly string[]): void {
  const rule = REASONS[event.reason];
  integrity(rule !== undefined && rule.result === event.result, `event reason ${String(event.reason)} does not belong to ${String(event.result)}`);
  const inside = event.requested !== null && allowlist.includes(event.requested);
  if (rule.destination === 'NONE') integrity(event.requested === null, 'event names a destination its reason cannot have');
  if (rule.destination === 'ALLOWED') integrity(inside, 'event names no allowlisted destination');
  if (rule.destination === 'OUTSIDE') integrity(event.requested !== null && !inside, 'a refused destination is on the allowlist');
  integrity((event.result === 'CONNECTED') === (event.address !== undefined), 'event address does not match its result');
}

/** A validated copy of an event to append. Throws on anything outside the bounded schema. */
export function parseEgressEvent(value: unknown, allowlist: readonly string[]): EgressEventInput {
  const parsed = eventSchema.omit({ sequence: true, at: true }).safeParse(value);
  integrity(parsed.success, 'event is malformed');
  const event = parsed.data as EgressEventInput;
  checkEvent(event, allowlist);
  return event;
}

/** A validated copy of a stored session, with every internal invariant checked. */
export function parseEgressSession(value: unknown): EgressSession {
  const parsed = sessionSchema.safeParse(value);
  integrity(parsed.success, 'is malformed');
  const session = parsed.data as EgressSession;
  integrity(session.sessionId === session.identity.invocationId, 'has a foreign id');
  integrity((session.state === 'CLOSED') === (session.closedAt !== undefined), 'close does not match its state');
  let previous = parseInstant(session.openedAt)!;
  for (const [index, event] of session.events.entries()) {
    integrity(event.sequence === index + 1, 'events are not in sequence');
    const at = parseInstant(event.at)!;
    integrity(at >= previous, 'events go back in time');
    previous = at;
    checkEvent(event, session.identity.egressDestinations);
  }
  if (session.closedAt !== undefined) integrity(parseInstant(session.closedAt)! >= previous, 'closes before its last event');
  return session;
}

/** Throws unless `after` is `before` with exactly one event appended, or `before` closed; identity, opening, and every earlier event unchanged. */
export function assertEgressTransition(before: EgressSession, after: EgressSession): void {
  const next = parseEgressSession(after);
  integrity(before.state === 'OPEN', 'is closed; a closed session is final');
  integrity(next.sessionId === before.sessionId && canonicalJson(next.identity) === canonicalJson(before.identity) &&
    next.openedAt === before.openedAt, 'identity changed');
  integrity(next.events.length >= before.events.length &&
    before.events.every((event, index) => canonicalJson(event) === canonicalJson(next.events[index])), 'events are not append-only');
  const appended = next.events.length === before.events.length + 1 && next.state === 'OPEN';
  const closed = next.events.length === before.events.length && next.state === 'CLOSED';
  integrity(appended || closed, 'changed by more than one event or a close');
}

/** Counts of a validated session's decisions. */
export function summarizeEgress(session: EgressSession): EgressSummary {
  const count = (result: EgressResult) => session.events.filter((event) => event.result === result).length;
  return { sessionId: session.sessionId, allowlist: [...session.identity.egressDestinations], closed: session.state === 'CLOSED',
    connected: count('CONNECTED'), denied: count('DENIED'), connectFailed: count('CONNECT_FAILED') };
}
