import { routeForRootCause, type RootCauseCategory } from '../stress-test/deliberation.js';
import type {
  AuthorContextItemStatus,
  AuthorContextSourceType,
  EvidenceState,
  FindingType,
  SemanticIssueStatus,
} from '../stress-test/types.js';
import type { AuthorContextCategory, ContextPackRoute } from './types.js';

/**
 * The one runtime schema of a ContextPack payload. Reading an offered pack, sealing a
 * pack, and projecting canonical records into a pack all validate with these functions,
 * so a record that would be refused on read can never be written into a pack, and the
 * reverse. Every failure is a TypeError; callers decide what it means at their boundary.
 */

/** Runtime list of every member of a string union: a missing or unknown member fails to compile. */
function members<U extends string>(record: Record<U, true>): readonly string[] {
  return Object.keys(record);
}

const FINDING_TYPES = members<FindingType>({ CLAIM: true, ASSUMPTION: true, AMBIGUITY: true, EXECUTION_RISK: true });
const EVIDENCE_STATES = members<EvidenceState>({
  SUPPORTED_IN_MATERIAL: true, PARTIALLY_SUPPORTED: true, UNSUPPORTED_IN_MATERIAL: true, NOT_APPLICABLE: true,
});
const ISSUE_STATUSES = members<SemanticIssueStatus>({ OPEN: true, ADJUDICATED: true });
const SOURCE_TYPES = members<AuthorContextSourceType>({ ARTIFACT: true, AUTHOR: true, EXTERNAL_SOURCE: true });
const ITEM_STATUSES = members<AuthorContextItemStatus>({ CURRENT: true, RESOLVED: true, SUPERSEDED: true });
export const AUTHOR_CONTEXT_CATEGORIES = members<AuthorContextCategory>({
  confirmedFacts: true, knownRisks: true, openQuestions: true, constraints: true,
}) as readonly AuthorContextCategory[];
const ROUTES = members<ContextPackRoute>({ ADD_REVIEWER: true, REPLICATE: true });
const REF_KINDS = ['FINDING', 'SEMANTIC_ISSUE', 'AUTHOR_CONTEXT_ITEM'];

const FINDING_FIELDS = ['id', 'reviewerRunId', 'type', 'title', 'artifactLocation', 'evidenceState', 'whyMaterial',
  'likelyRecipientChallenge', 'minimumBeforeSendAction', 'createdAt'];
const ISSUE_FIELDS = ['id', 'title', 'description', 'findingIds', 'evidenceState', 'status'];
const ITEM_FIELDS = ['id', 'text', 'sourceType', 'status', 'createdAt'];
const BINDING_FIELDS = ['deliberationStateId', 'sessionId', 'artifactHash', 'authorContextHash', 'attemptId', 'decisionId',
  'questionId', 'route', 'inputRefs'];
const SHA256_HEX = /^[0-9a-f]{64}$/;

export const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const isTimestamp = (value: unknown): boolean => typeof value === 'string' && !Number.isNaN(Date.parse(value));
const oneOf = (value: unknown, allowed: readonly string[]): boolean => typeof value === 'string' && allowed.includes(value);

/**
 * The own data fields of a plain object, read from their descriptors: accessors,
 * symbols, inherited or unknown fields fail, and no getter is ever run.
 */
export function ownData(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
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

/** Exactly `required` plus any of `optional`, all own data fields. */
export function exactRecord(value: unknown, required: readonly string[], optional: readonly string[], label: string): Record<string, unknown> {
  const data = ownData(value, [...required, ...optional], label);
  for (const key of required) if (!Object.hasOwn(data, key)) throw new TypeError(`${label}.${key} is missing`);
  return data;
}

/** The elements of a plain array, read from their descriptors. */
function dataArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError(`${label} must be an array`);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) throw new TypeError(`${label} must be a dense array with no extra fields`);
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError(`${label}[${index}] is not a data element`);
    return descriptor.value;
  });
}

export function assertReviewFindingValue(value: unknown, id: string, label: string): void {
  const finding = exactRecord(value, FINDING_FIELDS, ['rawText'], label);
  if (finding.id !== id) throw new TypeError(`${label}.id is not the id its ref names`);
  for (const key of ['reviewerRunId', 'title', 'artifactLocation', 'whyMaterial', 'likelyRecipientChallenge', 'minimumBeforeSendAction']) {
    if (typeof finding[key] !== 'string') throw new TypeError(`${label}.${key} must be a string`);
  }
  if (!oneOf(finding.type, FINDING_TYPES)) throw new TypeError(`${label}.type ${JSON.stringify(finding.type)} is not a finding type`);
  if (!oneOf(finding.evidenceState, EVIDENCE_STATES)) {
    throw new TypeError(`${label}.evidenceState ${JSON.stringify(finding.evidenceState)} is not an evidence state`);
  }
  if (!isTimestamp(finding.createdAt)) throw new TypeError(`${label}.createdAt is not a valid timestamp`);
  if (Object.hasOwn(finding, 'rawText') && typeof finding.rawText !== 'string') throw new TypeError(`${label}.rawText must be a string`);
}

/** The issue keeps its own provenance list; its findings are never merged into it. */
export function assertSemanticIssueValue(value: unknown, id: string, label: string): void {
  const issue = exactRecord(value, ISSUE_FIELDS, [], label);
  if (issue.id !== id) throw new TypeError(`${label}.id is not the id its ref names`);
  if (typeof issue.title !== 'string' || typeof issue.description !== 'string') {
    throw new TypeError(`${label}.title and description must be strings`);
  }
  const findingIds = dataArray(issue.findingIds, `${label}.findingIds`);
  if (findingIds.length === 0 || !findingIds.every(nonempty) || new Set(findingIds).size !== findingIds.length) {
    throw new TypeError(`${label}.findingIds must be a non-empty list of distinct finding ids`);
  }
  if (!oneOf(issue.evidenceState, EVIDENCE_STATES)) {
    throw new TypeError(`${label}.evidenceState ${JSON.stringify(issue.evidenceState)} is not an evidence state`);
  }
  if (!oneOf(issue.status, ISSUE_STATUSES)) throw new TypeError(`${label}.status ${JSON.stringify(issue.status)} is not an issue status`);
}

/** Source type and status are lifecycle facts only: AUTHOR is not verified, CURRENT is not true. */
export function assertAuthorContextItemValue(value: unknown, id: string, label: string): void {
  const item = exactRecord(value, ITEM_FIELDS, [], label);
  if (item.id !== id) throw new TypeError(`${label}.id is not the id its ref names`);
  if (typeof item.text !== 'string') throw new TypeError(`${label}.text must be a string`);
  if (!oneOf(item.sourceType, SOURCE_TYPES)) throw new TypeError(`${label}.sourceType ${JSON.stringify(item.sourceType)} is not a source type`);
  if (!oneOf(item.status, ITEM_STATUSES)) throw new TypeError(`${label}.status ${JSON.stringify(item.status)} is not an item status`);
  if (!isTimestamp(item.createdAt)) throw new TypeError(`${label}.createdAt is not a valid timestamp`);
}

export function assertAuthorContextCategory(value: unknown, label: string): void {
  if (!oneOf(value, AUTHOR_CONTEXT_CATEGORIES)) throw new TypeError(`${label} ${JSON.stringify(value)} is not an author context category`);
}

/** One route source record of the kind its ref names. */
export function assertContextPackSourceValue(kind: string, value: unknown, id: string, label: string): void {
  if (kind === 'FINDING') assertReviewFindingValue(value, id, label);
  else if (kind === 'SEMANTIC_ISSUE') assertSemanticIssueValue(value, id, label);
  else if (kind === 'AUTHOR_CONTEXT_ITEM') assertAuthorContextItemValue(value, id, label);
  else throw new TypeError(`${label} has unsupported ref kind ${JSON.stringify(kind)}`);
}

function assertRef(value: unknown, label: string): { kind: string; id: string } {
  const ref = exactRecord(value, ['kind', 'id'], [], label);
  if (!oneOf(ref.kind, REF_KINDS) || !nonempty(ref.id)) throw new TypeError(`${label} is not a route input ref`);
  return ref as { kind: string; id: string };
}

/**
 * V1 routes exist only for their own root cause, by the canonical mapping
 * (COVERAGE_GAP -> ADD_REVIEWER, STABILITY_QUESTION -> REPLICATE).
 */
export function assertContextPackQuestion(route: unknown, value: unknown, label: string): void {
  const question = exactRecord(value, ['rootCause', 'materialityReason'], [], label);
  let mapped: unknown;
  try {
    mapped = typeof question.rootCause === 'string' ? routeForRootCause(question.rootCause as RootCauseCategory) : undefined;
  } catch {
    mapped = undefined;
  }
  if (!oneOf(route, ROUTES) || mapped !== route) {
    throw new TypeError(`${label}.rootCause ${JSON.stringify(question.rootCause)} is not the root cause of route ${JSON.stringify(route)}`);
  }
  if (!nonempty(question.materialityReason)) throw new TypeError(`${label}.materialityReason must be a non-empty string`);
}

/**
 * Every payload field of a pack: schemaVersion, binding, question, sources in ref
 * order, and the optional excerpt. Fingerprint and capture time are not payload.
 */
export function assertContextPackPayload(payload: Record<string, unknown>, schemaVersion: string): void {
  if (payload.schemaVersion !== schemaVersion) throw new TypeError('ContextPack.schemaVersion is not supported');

  const binding = exactRecord(payload.binding, BINDING_FIELDS, [], 'ContextPack.binding');
  for (const key of BINDING_FIELDS.slice(0, 7)) {
    if (!nonempty(binding[key])) throw new TypeError(`ContextPack.binding.${key} is invalid`);
  }
  for (const key of ['artifactHash', 'authorContextHash']) {
    if (!SHA256_HEX.test(binding[key] as string)) throw new TypeError(`ContextPack.binding.${key} is not a SHA-256 hex digest`);
  }
  if (!oneOf(binding.route, ROUTES)) throw new TypeError('ContextPack.binding.route is not supported');
  const refs = dataArray(binding.inputRefs, 'ContextPack.binding.inputRefs')
    .map((ref, index) => assertRef(ref, `ContextPack.binding.inputRefs[${index}]`));
  if (refs.length === 0) throw new TypeError('ContextPack.binding.inputRefs is empty');

  assertContextPackQuestion(binding.route, payload.question, 'ContextPack.question');

  const sources = dataArray(payload.sources, 'ContextPack.sources');
  if (sources.length !== refs.length) throw new TypeError('ContextPack.sources must hold exactly one source per route input ref');
  sources.forEach((entry, index) => {
    const label = `ContextPack.sources[${index}]`;
    const isAuthor = refs[index].kind === 'AUTHOR_CONTEXT_ITEM';
    const source = exactRecord(entry, isAuthor ? ['ref', 'category', 'value'] : ['ref', 'value'], [], label);
    const ref = assertRef(source.ref, `${label}.ref`);
    if (ref.kind !== refs[index].kind || ref.id !== refs[index].id) throw new TypeError(`${label}.ref is not the route ref at its position`);
    if (isAuthor) assertAuthorContextCategory(source.category, `${label}.category`);
    assertContextPackSourceValue(ref.kind, source.value, ref.id, `${label}.value`);
  });

  if (Object.hasOwn(payload, 'artifact') && payload.artifact !== undefined) {
    const artifact = exactRecord(payload.artifact, ['selectionScope', 'startChar', 'endChar', 'text'], [], 'ContextPack.artifact');
    const { startChar, endChar, text } = artifact;
    if (artifact.selectionScope !== 'EXCERPT' || !Number.isSafeInteger(startChar) || !Number.isSafeInteger(endChar) ||
        (startChar as number) < 0 || (startChar as number) >= (endChar as number) || typeof text !== 'string' ||
        text.length !== (endChar as number) - (startChar as number)) {
      throw new TypeError('ContextPack.artifact is not an exact excerpt');
    }
  }
}
