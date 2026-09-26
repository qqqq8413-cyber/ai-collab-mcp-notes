import type { ReviewFinding, SemanticIssue } from './types.js';

/**
 * Exact reference resolution for id-keyed record maps. A reference resolves
 * only when the map OWNS exactly that key, the value stored there has the
 * expected record shape, and that record's own `id` equals the requested id.
 *
 * Truthiness of `map[id]` is never existence: on any plain object,
 * `map['constructor']`, `map['toString']` and `map['__proto__']` are
 * inherited values, and an owned key can still hold a record carrying a
 * different id. Module-internal; not re-exported from the package index.
 */
export type ExactLookup<T> =
  | { found: true; record: T }
  | { found: false; reason: 'NOT_OWNED' | 'MALFORMED' | 'ID_MISMATCH' };

export function lookupExactRecord<T extends { id: string }>(
  map: Readonly<Record<string, T>>,
  id: unknown,
  hasShape: (value: object) => boolean = () => true
): ExactLookup<T> {
  if (typeof id !== 'string' || id.length === 0 || map === null || typeof map !== 'object' || !Object.hasOwn(map, id)) {
    return { found: false, reason: 'NOT_OWNED' };
  }
  const value: unknown = map[id];
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !hasShape(value)) {
    return { found: false, reason: 'MALFORMED' };
  }
  if ((value as { id?: unknown }).id !== id) return { found: false, reason: 'ID_MISMATCH' };
  return { found: true, record: value as T };
}

/** The resolved record, or undefined for any failure `lookupExactRecord` distinguishes. */
export function resolveExactRecord<T extends { id: string }>(
  map: Readonly<Record<string, T>>,
  id: unknown,
  hasShape?: (value: object) => boolean
): T | undefined {
  const lookup = lookupExactRecord(map, id, hasShape);
  return lookup.found ? lookup.record : undefined;
}

const isString = (value: unknown): value is string => typeof value === 'string';

/** Runtime shape of a stored ReviewFinding (field types only; value vocabularies are checked where they are used). */
export function isReviewFindingShape(value: object): boolean {
  const finding = value as Partial<Record<keyof ReviewFinding, unknown>>;
  return (
    isString(finding.id) &&
    isString(finding.reviewerRunId) &&
    isString(finding.type) &&
    isString(finding.title) &&
    isString(finding.artifactLocation) &&
    isString(finding.evidenceState) &&
    isString(finding.whyMaterial) &&
    isString(finding.likelyRecipientChallenge) &&
    isString(finding.minimumBeforeSendAction) &&
    isString(finding.createdAt) &&
    (finding.rawText === undefined || isString(finding.rawText))
  );
}

/** Runtime shape of a stored SemanticIssue. */
export function isSemanticIssueShape(value: object): boolean {
  const issue = value as Partial<Record<keyof SemanticIssue, unknown>>;
  return (
    isString(issue.id) &&
    isString(issue.title) &&
    isString(issue.description) &&
    Array.isArray(issue.findingIds) &&
    issue.findingIds.every(isString) &&
    isString(issue.evidenceState) &&
    isString(issue.status)
  );
}
