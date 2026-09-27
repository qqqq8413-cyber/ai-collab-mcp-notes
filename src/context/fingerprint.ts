import { createHash } from 'node:crypto';
import type { ContextPackPayload } from './types.js';

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function write(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`${path} is not a finite number`);
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new TypeError(`${path} is not plain data`);
  }
  const keys = Reflect.ownKeys(value as object);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      if (Array.isArray(value) && key === 'length') continue;
      throw new TypeError(`${path} has a non-data member`);
    }
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || keys.length !== value.length + 1) {
      throw new TypeError(`${path} is not a plain array`);
    }
    return `[${value.map((item, index) => {
      if (item === undefined) throw new TypeError(`${path}[${index}] is undefined`);
      return write(item, `${path}[${index}]`);
    }).join(',')}]`;
  }
  if (!isPlainObject(value as object)) throw new TypeError(`${path} is not a plain object`);
  const record = value as Record<string, unknown>;
  // Code-unit key order, independent of insertion order. An undefined member is the
  // same data as an absent one, as in JSON.
  const members = (keys as string[]).sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${write(record[key], `${path}.${key}`)}`);
  return `{${members.join(',')}}`;
}

/**
 * The one canonical representation of pack content: JSON text with object members in
 * code-unit order of their keys, arrays in order, and no whitespace. The size budget
 * and the fingerprint both read this string, so they cannot drift apart. Only plain
 * data is accepted: no accessors, functions, symbols, class instances, or non-finite
 * numbers.
 */
export function canonicalSerialize(value: unknown): string {
  return write(value, 'value');
}

/**
 * The canonical text of exactly the payload fields. `contextFingerprint` and `capturedAt`
 * are never part of it, even when a whole pack is passed in.
 */
export function serializePayload(value: ContextPackPayload): string {
  const payload: Record<string, unknown> = {
    schemaVersion: value.schemaVersion,
    binding: value.binding,
    question: value.question,
    sources: value.sources,
  };
  if (value.artifact !== undefined) payload.artifact = value.artifact;
  return canonicalSerialize(payload);
}

/** SHA-256 of the canonical payload text: integrity binding, not authentication. */
export function fingerprintSerialized(serialized: string): string {
  return createHash('sha256').update(serialized, 'utf8').digest('hex');
}

/** Anyone can recompute this, so it proves consistency, never who produced the pack. */
export function contextFingerprint(value: ContextPackPayload): string {
  return fingerprintSerialized(serializePayload(value));
}
