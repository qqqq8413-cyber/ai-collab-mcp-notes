import { domainToASCII } from 'node:url';

// The one canonical form of a network egress destination: `hostname:port`, where the
// hostname is a lower-case ASCII DNS name of at least two labels and the port is a
// decimal 1..65535 without leading zeros. Nothing else is a destination: no scheme,
// path, query, fragment, userinfo, wildcard, IP literal, trailing dot, whitespace, or
// control character. Input is never normalized here. A spelling that would normalize
// to something else is refused, so every layer that stores or compares a destination
// sees the same bytes, and exact equality of two sets is equality of their arrays.

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PORT = /^[1-9][0-9]{0,4}$/;
const MAX_HOSTNAME = 253;
/** An egress destination set is at most this long. */
export const MAX_EGRESS_DESTINATIONS = 16;

/** Whether `value` is exactly one canonical `hostname:port` destination. */
export function isCanonicalEgressDestination(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_HOSTNAME + 6) return false;
  const colon = value.lastIndexOf(':');
  if (colon <= 0) return false;
  const host = value.slice(0, colon);
  const port = value.slice(colon + 1);
  if (!PORT.test(port) || Number(port) > 65_535) return false;
  if (host.length > MAX_HOSTNAME) return false;
  const labels = host.split('.');
  // At least two labels: a single-label name is completed by DNS search domains, so it
  // names no one host. A numeric last label would make it an IP literal.
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label)) || /^[0-9]+$/.test(labels.at(-1)!)) return false;
  // IDNA: the stored spelling must already be the ASCII form (punycode labels included).
  return domainToASCII(host) === host;
}

/**
 * Whether `value` is a canonical egress destination set: an array of canonical
 * destinations, strictly ascending in code-unit order (so sorted and without
 * duplicates), at most MAX_EGRESS_DESTINATIONS long, and non-empty unless `allowEmpty`.
 */
export function isCanonicalEgressSet(value: unknown, options: { allowEmpty?: boolean } = {}): value is string[] {
  if (!Array.isArray(value) || value.length > MAX_EGRESS_DESTINATIONS) return false;
  if (value.length === 0) return options.allowEmpty === true;
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index) || !isCanonicalEgressDestination(value[index])) return false;
    if (index > 0 && !(value[index - 1] < value[index])) return false;
  }
  return true;
}

/** A frozen copy of a canonical non-empty egress set. Throws on anything else; nothing is repaired. */
export function parseEgressSet(value: unknown): readonly string[] {
  if (!isCanonicalEgressSet(value)) {
    throw new TypeError('Egress destinations must be a non-empty, sorted, duplicate-free set of canonical hostname:port values');
  }
  return Object.freeze([...value]);
}

/** Exact equality of two canonical sets. Both must be canonical; anything else is unequal. */
export function sameEgressSet(left: unknown, right: unknown): boolean {
  if (!isCanonicalEgressSet(left, { allowEmpty: true }) || !isCanonicalEgressSet(right, { allowEmpty: true })) return false;
  return left.length === right.length && left.every((destination, index) => destination === right[index]);
}
