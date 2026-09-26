import { createHash } from 'node:crypto';
import type { ExecutionRequest, ProviderBinding } from './types.js';

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  throw new TypeError('Execution fingerprint input must be canonical data');
}

/** Integrity binding for fixed request facts, not authentication of a caller. */
export function executionRequestFingerprint(request: ExecutionRequest, binding: ProviderBinding): string {
  return createHash('sha256').update(canonical({ request, binding })).digest('hex');
}
