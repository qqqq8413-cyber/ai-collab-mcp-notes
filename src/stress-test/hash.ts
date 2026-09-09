import { createHash } from 'node:crypto';
import type { AuthorContext, AuthorContextItem } from './types.js';

/** SHA-256 of raw text, hex-encoded — used for the frozen artifact hash. */
export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Sorts an AuthorContextItem array by id so the hash is stable regardless of
 * insertion order, then serializes with fixed key order — deliberately not
 * `JSON.stringify` on the object as-is, whose key order is insertion order.
 */
function canonicalItems(items: AuthorContextItem[]): string {
  return JSON.stringify(
    [...items]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((item) => ({
        id: item.id,
        text: item.text,
        sourceType: item.sourceType,
        status: item.status,
        createdAt: item.createdAt,
      }))
  );
}

/** SHA-256 of a canonical (order-independent) serialization of an AuthorContext. */
export function sha256AuthorContext(context: AuthorContext): string {
  const canonical = JSON.stringify({
    confirmedFacts: canonicalItems(context.confirmedFacts),
    knownRisks: canonicalItems(context.knownRisks),
    openQuestions: canonicalItems(context.openQuestions),
    constraints: canonicalItems(context.constraints),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
