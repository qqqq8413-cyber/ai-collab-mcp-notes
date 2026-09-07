/**
 * CBRP-STRUCTURAL-REVIEW-LIVE-HARNESS-1
 *
 * Offline-tested transport and evidence boundary for future Protocol 1 review
 * execution. Importing this module performs no I/O and no provider call. The real
 * transport is reachable only through dispatchStructuralReviewLive(), which requires
 * an explicit LIVE flag, authorized base SHA, exact artifact namespace, credentials,
 * runtime/source revalidation, and a durable exclusive reservation for every call.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';

import {
  PROTOCOL_VERSION,
  REVIEWER_PINS,
  CALL_BUDGET,
  computeInitialReviewPlan,
  computeR3Plan,
} from './structural-review-runner.mjs';
import {
  PROMPT_VERSION,
  RUBRIC_VERSION,
  EXPECTED_RUBRIC_BYTE_COUNT,
  EXPECTED_RUBRIC_SHA256,
  loadFrozenRubricPasteBytes,
} from './structural-review-prompt-v1.mjs';
import {
  EXTRACTOR_VERSION,
  extractStructuralReviewResponse,
} from './structural-review-extractor-v1.mjs';
import {
  D3_VERSION,
  computeStructuralD3Selector,
  describeCheckLevelDisagreement,
  validateReviewObject,
  decideStructuralReview,
} from './structural-review-decision-v1.mjs';
import { ORDER_VERSION } from './structural-review-order-v1.mjs';

export const HARNESS_VERSION = 'CBRP-STRUCTURAL-REVIEW-LIVE-HARNESS-1';
export const MAX_OUTPUT_TOKENS = 4096;
export const MODEL_PIN_VERSION = 'CBRP-SESSION-MODEL-PINS-1';
export const INITIAL_STAGE = 'INITIAL';
export const R3_STAGE = 'R3';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(DIR, '../../../..');
const CENSUS_DIR = path.resolve(DIR, '..');
const LIVE_ARTIFACT_DIR = path.join(CENSUS_DIR, 'structural-review-round-0');
const LIVE_ARTIFACT_RELATIVE = 'experiments/m2b/census/structural-review-round-0/';
const CANDIDATE_PATH = path.join(CENSUS_DIR, 'authoring-v2p1-round-0', 'CANDIDATES.json');

const STRATA = Object.freeze(['SC', 'OP', 'BC', 'EI', 'PS', 'FR']);
const SOURCE_HASHES = Object.freeze({
  'experiments/m2b/census/CBRP_STRUCTURAL_REVIEW_PROTOCOL_1.md': '21a8e979f9c8793fb3a95f6aa0006aed8583d92a6f68773d81fae9a12d5528e0',
  'experiments/m2b/census/CBRP_STRUCTURAL_REVIEW_RUBRIC_DRAFT.md': '72bc339e058f05e7cfd74fa9b4b13189f0d86a52323b00713fbf6994a7cb184c',
  'experiments/m2b/census/structural-review-protocol/structural-review-prompt-v1.mjs': 'c84121f9ae847b57e50b697e2cb45125785daebb3f4d5fc715f00a2d37a57542',
  'experiments/m2b/census/structural-review-protocol/structural-review-extractor-v1.mjs': 'a16b61d71cbee8d34ad94f9c2cc00e7640061fe3342d6231e17ec8ec896ade00',
  'experiments/m2b/census/structural-review-protocol/structural-review-decision-v1.mjs': '58e2c6483d46a2a011f1b9e10c05e77ff80efd7c88dd044ccb352ef781f1e1fa',
  'experiments/m2b/census/structural-review-protocol/structural-review-order-v1.mjs': '21917109ba80436c121983e290c07467fb0e24e0f32a3251dfada90c602ade01',
});

export const EXPECTED_RUNTIME = Object.freeze({
  nodeVersion: 'v24.15.0',
  packageLockSha256: '4fde57dc2c3102c081674bd6286dbc77aa9f8ecd128aa43450568edff840c5e1',
  anthropicSdkVersion: '0.123.0',
  geminiSdkVersion: '0.24.1',
  sourceHashes: SOURCE_HASHES,
});

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const canonical = (value) => JSON.stringify(value, null, 2) + '\n';
const nowIso = () => new Date().toISOString();

export class StructuralReviewStop extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'StructuralReviewStop';
    this.code = code;
    this.details = details;
  }
}

function stop(code, message, details) {
  return new StructuralReviewStop(code, message, details);
}

function readPackageVersion(packagePath) {
  return JSON.parse(fs.readFileSync(packagePath, 'utf8')).version;
}

function git(...args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

function workingTreePaths() {
  const raw = execFileSync(
    'git',
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  );
  const tokens = raw.split('\0');
  const paths = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (!tokens[i]) continue;
    const status = tokens[i].slice(0, 2);
    paths.push(tokens[i].slice(3));
    if (status.includes('R') || status.includes('C')) {
      i += 1;
      if (tokens[i]) paths.push(tokens[i]);
    }
  }
  return paths;
}

/** Captures the facts that are revalidated immediately before each LIVE call. */
export function captureRuntimeSnapshot() {
  const rubric = loadFrozenRubricPasteBytes();
  const sourceHashes = Object.fromEntries(
    Object.keys(SOURCE_HASHES).map((relative) => [
      relative,
      sha256(fs.readFileSync(path.join(REPO_ROOT, relative))),
    ])
  );
  const driftPaths = workingTreePaths();
  return {
    capturedAt: nowIso(),
    head: git('rev-parse', 'HEAD'),
    nodeVersion: process.version,
    packageLockSha256: sha256(fs.readFileSync(path.join(REPO_ROOT, 'package-lock.json'))),
    anthropicSdkVersion: readPackageVersion(path.join(REPO_ROOT, 'node_modules', '@anthropic-ai', 'sdk', 'package.json')),
    geminiSdkVersion: readPackageVersion(path.join(REPO_ROOT, 'node_modules', '@google', 'generative-ai', 'package.json')),
    rubricBytes: Buffer.byteLength(rubric, 'utf8'),
    rubricSha256: sha256(rubric),
    sourceHashes,
    workingTreePaths: driftPaths,
    unexpectedWorkingTreePaths: driftPaths.filter((entry) => !entry.startsWith(LIVE_ARTIFACT_RELATIVE)),
  };
}

/** Pure fail-closed comparison, separately testable with synthetic snapshots. */
export function assertRuntimeSnapshot(snapshot, { authorizedBaseSha }) {
  if (!/^[0-9a-f]{40}$/.test(authorizedBaseSha ?? '')) {
    throw stop('STOP_AUTHORIZED_BASE_REQUIRED', 'authorizedBaseSha must be an explicit full lowercase commit SHA');
  }
  if (snapshot.head !== authorizedBaseSha) {
    throw stop('STOP_BASE_SHA_MISMATCH', `HEAD ${snapshot.head} != authorized ${authorizedBaseSha}`);
  }
  if (snapshot.nodeVersion !== EXPECTED_RUNTIME.nodeVersion) {
    throw stop('STOP_RUNTIME_DRIFT', `Node ${snapshot.nodeVersion} != ${EXPECTED_RUNTIME.nodeVersion}`);
  }
  if (snapshot.packageLockSha256 !== EXPECTED_RUNTIME.packageLockSha256) {
    throw stop('STOP_SOURCE_DRIFT', 'package-lock hash mismatch');
  }
  if (snapshot.anthropicSdkVersion !== EXPECTED_RUNTIME.anthropicSdkVersion
      || snapshot.geminiSdkVersion !== EXPECTED_RUNTIME.geminiSdkVersion) {
    throw stop('STOP_RUNTIME_DRIFT', 'installed provider SDK version mismatch');
  }
  if (snapshot.rubricBytes !== EXPECTED_RUBRIC_BYTE_COUNT
      || snapshot.rubricSha256 !== EXPECTED_RUBRIC_SHA256) {
    throw stop('STOP_RUBRIC_DRIFT', 'frozen rubric bytes/hash mismatch');
  }
  for (const [relative, expected] of Object.entries(SOURCE_HASHES)) {
    if (snapshot.sourceHashes?.[relative] !== expected) {
      throw stop('STOP_SOURCE_DRIFT', `${relative} hash mismatch`);
    }
  }
  if ((snapshot.unexpectedWorkingTreePaths ?? []).length > 0) {
    throw stop('STOP_WORKTREE_DRIFT', 'working-tree drift exists outside the authorized LIVE artifact namespace', {
      paths: snapshot.unexpectedWorkingTreePaths,
    });
  }
  return snapshot;
}

export function createLiveRevalidator({ authorizedBaseSha }) {
  return async () => assertRuntimeSnapshot(captureRuntimeSnapshot(), { authorizedBaseSha });
}

/** Mechanical CWP-10E pool validation only; never judges scenario content. */
export function validateCandidatePool(pool) {
  const problems = [];
  if (!Array.isArray(pool)) throw stop('STOP_POOL_INVALID', 'candidate pool must be an array');
  if (pool.length !== 60) problems.push(`candidate count ${pool.length}, expected 60`);
  const ids = new Set();
  const counts = Object.fromEntries(STRATA.map((code) => [code, 0]));
  for (const [index, task] of pool.entries()) {
    if (typeof task?.taskCandidateId !== 'string' || !task.taskCandidateId) problems.push(`[${index}] invalid taskCandidateId`);
    else if (ids.has(task.taskCandidateId)) problems.push(`[${index}] duplicate taskCandidateId ${task.taskCandidateId}`);
    else ids.add(task.taskCandidateId);
    if (!Object.hasOwn(counts, task?.stratumCode)) problems.push(`[${index}] invalid stratumCode ${JSON.stringify(task?.stratumCode)}`);
    else counts[task.stratumCode] += 1;
    if (typeof task?.taskText !== 'string' || !task.taskText) problems.push(`[${index}] invalid taskText`);
    else {
      if (sha256(task.taskText) !== task.taskSha256) problems.push(`[${index}] taskSha256 mismatch`);
      if (Buffer.byteLength(task.taskText, 'utf8') !== task.taskBytes) problems.push(`[${index}] taskBytes mismatch`);
    }
  }
  for (const [code, count] of Object.entries(counts)) {
    if (count !== 10) problems.push(`${code} count ${count}, expected 10`);
  }
  if (problems.length > 0) throw stop('STOP_POOL_INVALID', problems.join('; '), { problems });
  return { candidateCount: pool.length, candidateIdsUnique: ids.size === pool.length, stratumCounts: counts };
}

function fsyncDirectory(directory) {
  let fd;
  try {
    fd = fs.openSync(directory, 'r');
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function writeDurableExclusive(filePath, content) {
  const fd = fs.openSync(filePath, 'wx');
  try {
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fsyncDirectory(path.dirname(filePath));
}

function writeDurableReplace(filePath, content) {
  const temp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  writeDurableExclusive(temp, content);
  fs.renameSync(temp, filePath);
  fsyncDirectory(path.dirname(filePath));
}

function safeSessionFileName(reviewSessionId) {
  if (!/^[A-Za-z0-9._-]+$/.test(reviewSessionId ?? '')) {
    throw stop('STOP_REVIEW_SESSION_ID_INVALID', `unsafe reviewSessionId ${JSON.stringify(reviewSessionId)}`);
  }
  return reviewSessionId;
}

export function createArtifactStore(artifactDir) {
  const absolute = path.resolve(artifactDir);
  const rawDir = path.join(absolute, 'raw');
  const reservationsDir = path.join(absolute, 'reservations');
  const file = (name) => path.join(absolute, name);
  return {
    artifactDir: absolute,
    initialize() {
      fs.mkdirSync(rawDir, { recursive: true });
      fs.mkdirSync(reservationsDir, { recursive: true });
    },
    writeTextExclusive(name, value) {
      writeDurableExclusive(file(name), value);
    },
    writeJson(name, value) {
      writeDurableReplace(file(name), canonical(value));
    },
    readJson(name) {
      return JSON.parse(fs.readFileSync(file(name), 'utf8'));
    },
    exists(name) {
      return fs.existsSync(file(name));
    },
    listReservations() {
      return fs.readdirSync(reservationsDir).filter((name) => name.endsWith('.json')).sort();
    },
    assertRawPersistenceReady(reviewSessionId) {
      const safe = safeSessionFileName(reviewSessionId);
      const probe = path.join(rawDir, `.probe-${safe}-${crypto.randomBytes(4).toString('hex')}`);
      writeDurableExclusive(probe, 'probe');
      fs.unlinkSync(probe);
      fsyncDirectory(rawDir);
    },
    reserve(reviewSessionId, reservation) {
      const safe = safeSessionFileName(reviewSessionId);
      const reservationPath = path.join(reservationsDir, `${safe}.json`);
      try {
        writeDurableExclusive(reservationPath, canonical(reservation));
      } catch (error) {
        if (error?.code === 'EEXIST') {
          throw stop(
            'STOP_AMBIGUOUS_OR_CONSUMED_RESERVATION',
            `reservation already exists for ${reviewSessionId}; attempt is consumed and must not be dispatched again`,
            { reviewSessionId, reservationPath }
          );
        }
        throw error;
      }
      return reservationPath;
    },
    persistRaw(reviewSessionId, text, rawProviderResponse) {
      const safe = safeSessionFileName(reviewSessionId);
      const textPath = path.join(rawDir, `${safe}.txt`);
      const responsePath = path.join(rawDir, `${safe}.response.json`);
      const serialized = JSON.stringify(rawProviderResponse, null, 2);
      if (serialized === undefined) throw new TypeError('raw provider response is not JSON-serializable');
      writeDurableExclusive(textPath, text);
      writeDurableExclusive(responsePath, serialized + '\n');
      return {
        rawTextPath: path.relative(absolute, textPath),
        rawProviderResponsePath: path.relative(absolute, responsePath),
      };
    },
  };
}

function expectedRoute(taskCandidateId, reviewRole) {
  if (reviewRole === 'R1' || reviewRole === 'R2') return REVIEWER_PINS[reviewRole];
  if (reviewRole === 'R3') return computeStructuralD3Selector(taskCandidateId);
  throw stop('STOP_REVIEW_ROLE_INVALID', `unknown reviewRole ${JSON.stringify(reviewRole)}`);
}

export function assertReviewRoute(session) {
  const expectedSessionId = `${session.taskCandidateId}-${session.reviewRole}`;
  if (session.reviewSessionId !== expectedSessionId) {
    throw stop('STOP_REVIEW_SESSION_ID_INVALID', `${session.reviewSessionId} != ${expectedSessionId}`);
  }
  const expected = expectedRoute(session.taskCandidateId, session.reviewRole);
  if (session.provider !== expected.provider || session.model !== expected.model
      || session.modelFamily !== expected.modelFamily) {
    throw stop('STOP_REVIEW_ROUTE_MISMATCH', `${session.reviewRole} route does not match its frozen pin`, {
      requested: { provider: session.provider, model: session.model, modelFamily: session.modelFamily },
      expected: { provider: expected.provider, model: expected.model, modelFamily: expected.modelFamily },
    });
  }
  return expected;
}

function requireCredential(provider, credentials) {
  if (typeof credentials?.[provider] !== 'string' || !credentials[provider]) {
    throw stop('STOP_CREDENTIAL_MISSING', `required ${provider} credential is missing`);
  }
}

function persistRunState(store, state) {
  store.writeJson('SESSIONS.json', {
    harnessVersion: HARNESS_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    modelPinVersion: MODEL_PIN_VERSION,
    sessions: state.sessions,
  });
  store.writeJson('REVIEWS.json', {
    harnessVersion: HARNESS_VERSION,
    reviews: state.reviews,
  });
}

function stopOutcomeFromValidation(reason) {
  if (/taskId .*expected blindTaskId/.test(reason)) return 'STOP_BLIND_TASK_ID_MISMATCH';
  if (/overallPass .*AND of the six checks/.test(reason)) return 'STOP_OVERALL_PASS_INVARIANT_MISMATCH';
  return 'STOP_SCHEMA_VALIDATION_FAILED';
}

/** One reserved, raw-first, one-attempt review call. Exported for focused fail-closed tests. */
export async function executeReviewSession({
  session,
  store,
  state,
  transport,
  credentials,
  revalidate,
  clock = nowIso,
}) {
  if (typeof transport !== 'function') throw new TypeError('executeReviewSession: injected transport is required');
  if (typeof revalidate !== 'function') throw new TypeError('executeReviewSession: revalidate is required');
  assertReviewRoute(session);
  requireCredential(session.provider, credentials);
  const runtimeProvenance = await revalidate();
  try {
    store.assertRawPersistenceReady(session.reviewSessionId);
  } catch (error) {
    throw stop('STOP_RAW_PERSISTENCE_UNAVAILABLE', String(error?.message ?? error));
  }

  const reservationTimestamp = clock();
  const reservation = {
    harnessVersion: HARNESS_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    reviewSessionId: session.reviewSessionId,
    taskCandidateId: session.taskCandidateId,
    blindTaskId: session.blindTaskId,
    reviewRole: session.reviewRole,
    providerRequested: session.provider,
    modelRequested: session.model,
    reservationTimestamp,
    status: 'RESERVED_ATTEMPT_CONSUMED_ON_DISPATCH',
  };
  store.reserve(session.reviewSessionId, reservation);

  const record = {
    ...reservation,
    trueTaskCandidateId: session.taskCandidateId,
    modelFamily: session.modelFamily,
    modelPinVersion: MODEL_PIN_VERSION,
    freshContextConfirmed: true,
    freshContextBasis: 'OPERATOR ATTESTATION — one stateless API request containing only the frozen model-visible prompt; no system prompt, prior turns, conversation id, or continuation. NOT independently verified.',
    rubricVersion: session.prompt.rubricVersion,
    rubricSha256: session.prompt.rubricSha256,
    promptVersion: session.prompt.promptVersion,
    promptSha256: session.prompt.promptSha256,
    promptBytes: session.prompt.promptBytes,
    maxTokensRequested: MAX_OUTPUT_TOKENS,
    temperatureRequested: null,
    transportRetryConfiguration: session.provider === 'claude'
      ? 'maxRetries: 0'
      : 'SDK 0.24.1 single generateContent request; no retry/fallback layer',
    d3SelectorInput: session.d3SelectorInput ?? null,
    d3Selector: session.d3Selector ?? null,
    runtimeProvenance,
    startedAt: clock(),
    settledAt: null,
    providerDispatchCount: 1,
    outcome: 'DISPATCHING',
  };
  state.sessions.push(record);
  persistRunState(store, state);

  let response;
  try {
    response = await transport({
      provider: session.provider,
      model: session.model,
      prompt: session.prompt.modelVisiblePrompt,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      temperature: null,
      reviewSessionId: session.reviewSessionId,
      reviewRole: session.reviewRole,
      blindTaskId: session.blindTaskId,
    });
  } catch (error) {
    Object.assign(record, {
      settledAt: clock(),
      outcome: 'STOP_PROVIDER_ERROR',
      errorName: error?.name ?? null,
      errorStatus: error?.status ?? null,
      errorMessage: String(error?.message ?? error),
    });
    persistRunState(store, state);
    throw stop(record.outcome, record.errorMessage, { record });
  }

  if (typeof response?.text !== 'string') {
    Object.assign(record, { settledAt: clock(), outcome: 'STOP_PROVIDER_RESPONSE_INVALID' });
    persistRunState(store, state);
    throw stop(record.outcome, 'provider transport did not return string text', { record });
  }

  let rawPaths;
  try {
    rawPaths = store.persistRaw(session.reviewSessionId, response.text, response.raw);
  } catch (error) {
    Object.assign(record, {
      settledAt: clock(),
      outcome: 'STOP_RAW_PERSISTENCE_FAILED',
      errorMessage: String(error?.message ?? error),
    });
    persistRunState(store, state);
    throw stop(record.outcome, record.errorMessage, { record });
  }

  Object.assign(record, {
    settledAt: clock(),
    providerResolved: response.providerResolved ?? null,
    modelResolved: response.modelResolved ?? null,
    resolvedIdentityObservable: response.modelResolved != null,
    pinStatus: response.modelResolved == null ? 'OPERATOR_ATTESTATION' : 'OBSERVED',
    stopReason: response.stopReason ?? null,
    rawResponseSha256: sha256(response.text),
    rawResponseBytes: Buffer.byteLength(response.text, 'utf8'),
    ...rawPaths,
  });

  if (record.providerResolved !== null && record.providerResolved !== session.provider) {
    record.pinStatus = 'MISMATCH';
    record.outcome = 'STOP_PROVIDER_PIN_MISMATCH';
    persistRunState(store, state);
    throw stop(record.outcome, `resolved ${record.providerResolved} != requested ${session.provider}`, { record });
  }

  if (record.modelResolved !== null && record.modelResolved !== session.model) {
    record.pinStatus = 'MISMATCH';
    record.outcome = 'STOP_MODEL_PIN_MISMATCH';
    persistRunState(store, state);
    throw stop(record.outcome, `resolved ${record.modelResolved} != requested ${session.model}`, { record });
  }

  const extraction = extractStructuralReviewResponse(response.text);
  Object.assign(record, {
    extractorVersion: extraction.extractorVersion,
    representationDetected: extraction.representationDetected,
    normalizedJsonSha256: extraction.normalizedJsonSha256,
  });
  if (!extraction.ok) {
    record.mechanicalValidation = { ok: false, reason: 'extractor rejected response' };
    record.outcome = 'STOP_MALFORMED_RESPONSE';
    persistRunState(store, state);
    throw stop(record.outcome, 'structural-review extractor rejected response', { record });
  }

  const validation = validateReviewObject(extraction.parsed, { expectedBlindTaskId: session.blindTaskId });
  record.mechanicalValidation = validation.ok ? { ok: true } : { ok: false, reason: validation.reason };
  if (!validation.ok) {
    record.parsedReview = extraction.parsed;
    record.outcome = stopOutcomeFromValidation(validation.reason);
    persistRunState(store, state);
    throw stop(record.outcome, validation.reason, { record });
  }

  record.parsedReview = validation.review;
  record.outcome = 'REVIEW_VALIDATED';
  state.reviews.push({
    taskCandidateId: session.taskCandidateId,
    blindTaskId: session.blindTaskId,
    reviewSessionId: session.reviewSessionId,
    reviewRole: session.reviewRole,
    review: validation.review,
  });
  persistRunState(store, state);
  return record;
}

function initialSession(planEntry, role) {
  const planned = role === 'R1' ? planEntry.r1 : planEntry.r2;
  return {
    taskCandidateId: planEntry.taskCandidateId,
    blindTaskId: planEntry.blindTaskId,
    reviewSessionId: planned.reviewId,
    reviewRole: role,
    provider: planned.provider,
    model: planned.model,
    modelFamily: planned.modelFamily,
    prompt: planned.prompt,
  };
}

function r3Session(planEntry) {
  return {
    taskCandidateId: planEntry.taskCandidateId,
    blindTaskId: planEntry.blindTaskId,
    reviewSessionId: planEntry.r3.reviewId,
    reviewRole: 'R3',
    provider: planEntry.r3.provider,
    model: planEntry.r3.model,
    modelFamily: planEntry.r3.modelFamily,
    prompt: planEntry.r3.prompt,
    d3SelectorInput: planEntry.r3.d3SelectorInput,
    d3Selector: planEntry.r3.d3Selector,
  };
}

function manifestFromPlan(initialPlan) {
  return initialPlan.map((entry) => ({
    taskCandidateId: entry.taskCandidateId,
    reviewOrderKey: entry.reviewOrderKey,
    blindTaskId: entry.blindTaskId,
    prompt: entry.r1.prompt,
  }));
}

function reviewMap(reviews) {
  const map = new Map();
  for (const entry of reviews) {
    const current = map.get(entry.taskCandidateId) ?? {};
    if (entry.reviewRole === 'R1') current.r1Review = entry.review;
    if (entry.reviewRole === 'R2') current.r2Review = entry.review;
    if (entry.reviewRole === 'R3') current.r3Review = entry.review;
    map.set(entry.taskCandidateId, current);
  }
  return map;
}

function writeStoppedValidation(store, stage, error, state) {
  store.writeJson('VALIDATION.json', {
    harnessVersion: HARNESS_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    status: `${stage}_INCOMPLETE`,
    stopCode: error?.code ?? 'STOP_UNEXPECTED_ERROR',
    stopMessage: String(error?.message ?? error),
    sessionsRecorded: state.sessions.length,
    reviewsValidated: state.reviews.length,
    providerDispatches: state.sessions.filter((record) => record.providerDispatchCount === 1).length,
  });
}

export async function runInitialStructuralReviewStage({
  authorizedBaseSha,
  pool,
  rubricPasteBytes,
  artifactDir,
  transport,
  credentials,
  revalidate,
  store: suppliedStore,
  clock,
}) {
  if (!/^[0-9a-f]{40}$/.test(authorizedBaseSha ?? '')) {
    throw stop('STOP_AUTHORIZED_BASE_REQUIRED', 'authorizedBaseSha must be an explicit full lowercase commit SHA');
  }
  const poolValidation = validateCandidatePool(pool);
  if (typeof rubricPasteBytes !== 'string' || sha256(rubricPasteBytes) !== EXPECTED_RUBRIC_SHA256
      || Buffer.byteLength(rubricPasteBytes, 'utf8') !== EXPECTED_RUBRIC_BYTE_COUNT) {
    throw stop('STOP_RUBRIC_DRIFT', 'rubric bytes do not match the frozen value');
  }
  const store = suppliedStore ?? createArtifactStore(artifactDir);
  store.initialize();
  const existingReservations = store.listReservations();
  if (existingReservations.length > 0) {
    throw stop(
      'STOP_AMBIGUOUS_OR_CONSUMED_RESERVATION',
      'one or more review reservations already exist; no initial-stage redispatch is allowed',
      { reservations: existingReservations }
    );
  }
  store.writeTextExclusive('RUBRIC_SENT.txt', rubricPasteBytes);

  const initialPlan = computeInitialReviewPlan({ pool, rubricPasteBytes });
  const manifest = manifestFromPlan(initialPlan);
  store.writeJson('PROMPT_MANIFEST.json', { harnessVersion: HARNESS_VERSION, prompts: manifest });
  store.writeJson('BLIND_ID_MAP.json', {
    blindIdVersion: 'CBRP-STRUCTURAL-BLIND-ID-v1',
    mappings: manifest.map(({ taskCandidateId, blindTaskId }) => ({ taskCandidateId, blindTaskId })),
  });
  store.writeJson('REVIEW_ORDER.json', {
    orderVersion: ORDER_VERSION,
    order: manifest.map(({ taskCandidateId, reviewOrderKey }) => ({ taskCandidateId, reviewOrderKey })),
  });

  const state = { sessions: [], reviews: [] };
  persistRunState(store, state);
  try {
    for (const entry of initialPlan) {
      await executeReviewSession({ session: initialSession(entry, 'R1'), store, state, transport, credentials, revalidate, clock });
      await executeReviewSession({ session: initialSession(entry, 'R2'), store, state, transport, credentials, revalidate, clock });
    }
  } catch (error) {
    writeStoppedValidation(store, INITIAL_STAGE, error, state);
    throw error;
  }

  const byTask = reviewMap(state.reviews);
  const disagreements = initialPlan
    .filter((entry) => byTask.get(entry.taskCandidateId).r1Review.overallPass
      !== byTask.get(entry.taskCandidateId).r2Review.overallPass)
    .map((entry) => ({
      taskCandidateId: entry.taskCandidateId,
      blindTaskId: entry.blindTaskId,
      reviewOrderKey: entry.reviewOrderKey,
      r1OverallPass: byTask.get(entry.taskCandidateId).r1Review.overallPass,
      r2OverallPass: byTask.get(entry.taskCandidateId).r2Review.overallPass,
      checkLevelDisagreement: describeCheckLevelDisagreement(
        byTask.get(entry.taskCandidateId).r1Review,
        byTask.get(entry.taskCandidateId).r2Review
      ),
    }));
  const finalDecisions = initialPlan.map((entry) => {
    const result = decideStructuralReview(byTask.get(entry.taskCandidateId));
    return result.r3Required
      ? { taskCandidateId: entry.taskCandidateId, status: 'PENDING_R3' }
      : { taskCandidateId: entry.taskCandidateId, status: 'FINAL', finalPass: result.finalPass, decision: result };
  });
  store.writeJson('DISAGREEMENTS.json', { count: disagreements.length, disagreements });
  store.writeJson('FINAL_DECISIONS.json', { decisions: finalDecisions });
  store.writeJson('VALIDATION.json', {
    harnessVersion: HARNESS_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    status: 'INITIAL_COMPLETE',
    poolValidation,
    initialReviewSessionsExpected: CALL_BUDGET.mandatoryTotal,
    sessionsRecorded: state.sessions.length,
    reviewsValidated: state.reviews.length,
    providerDispatches: state.sessions.length,
    disagreementCount: disagreements.length,
    automaticR3Dispatched: false,
  });
  return {
    status: 'INITIAL_COMPLETE',
    calls: state.sessions.length,
    disagreements,
    automaticR3Dispatched: false,
  };
}

function reconstructInitialPlan(promptManifest) {
  return promptManifest.prompts.map((entry) => ({
    taskCandidateId: entry.taskCandidateId,
    reviewOrderKey: entry.reviewOrderKey,
    blindTaskId: entry.blindTaskId,
    r1: { reviewId: `${entry.taskCandidateId}-R1`, reviewRole: 'R1', ...REVIEWER_PINS.R1, prompt: entry.prompt },
    r2: { reviewId: `${entry.taskCandidateId}-R2`, reviewRole: 'R2', ...REVIEWER_PINS.R2, prompt: entry.prompt },
  }));
}

export async function runR3StructuralReviewStage({
  authorizedBaseSha,
  artifactDir,
  transport,
  credentials,
  revalidate,
  store: suppliedStore,
  clock,
}) {
  if (!/^[0-9a-f]{40}$/.test(authorizedBaseSha ?? '')) {
    throw stop('STOP_AUTHORIZED_BASE_REQUIRED', 'authorizedBaseSha must be an explicit full lowercase commit SHA');
  }
  const store = suppliedStore ?? createArtifactStore(artifactDir);
  store.initialize();
  const validation = store.readJson('VALIDATION.json');
  if (validation.status !== 'INITIAL_COMPLETE' || validation.sessionsRecorded !== 120
      || validation.reviewsValidated !== 120 || validation.automaticR3Dispatched !== false) {
    throw stop('STOP_INITIAL_STAGE_NOT_COMPLETE', 'R3 requires a completed 120-review initial artifact set');
  }
  const promptManifest = store.readJson('PROMPT_MANIFEST.json');
  const initialPlan = reconstructInitialPlan(promptManifest);
  const sessionsFile = store.readJson('SESSIONS.json');
  const reviewsFile = store.readJson('REVIEWS.json');
  const state = { sessions: sessionsFile.sessions, reviews: reviewsFile.reviews };
  const byTask = reviewMap(state.reviews);
  if (initialPlan.length !== 60 || state.sessions.length !== 120 || state.reviews.length !== 120) {
    throw stop('STOP_INITIAL_STAGE_NOT_COMPLETE', 'initial artifacts have the wrong cardinality');
  }
  const r3Plan = computeR3Plan({ initialPlan, reviewResultsByTaskId: byTask });
  const frozenDisagreements = store.readJson('DISAGREEMENTS.json');
  const expectedIds = r3Plan.map((entry) => entry.taskCandidateId);
  const recordedIds = frozenDisagreements.disagreements.map((entry) => entry.taskCandidateId);
  if (JSON.stringify(expectedIds) !== JSON.stringify(recordedIds)) {
    throw stop('STOP_DISAGREEMENT_SET_MISMATCH', 'recorded disagreement set differs from frozen derivation');
  }

  try {
    for (const entry of r3Plan) {
      await executeReviewSession({ session: r3Session(entry), store, state, transport, credentials, revalidate, clock });
    }
  } catch (error) {
    writeStoppedValidation(store, R3_STAGE, error, state);
    throw error;
  }

  const completedMap = reviewMap(state.reviews);
  const decisions = initialPlan.map((entry) => {
    const reviews = completedMap.get(entry.taskCandidateId);
    const decision = decideStructuralReview(reviews);
    if (!decision.ok) throw stop('STOP_FINAL_DECISION_INVALID', decision.reason);
    return { taskCandidateId: entry.taskCandidateId, status: 'FINAL', finalPass: decision.finalPass, decision };
  });
  store.writeJson('FINAL_DECISIONS.json', { decisions });
  store.writeJson('VALIDATION.json', {
    ...validation,
    status: 'R3_COMPLETE',
    sessionsRecorded: state.sessions.length,
    reviewsValidated: state.reviews.length,
    providerDispatches: state.sessions.length,
    r3Expected: r3Plan.length,
    r3Dispatched: r3Plan.length,
    finalDecisionCount: decisions.length,
  });
  return { status: 'R3_COMPLETE', calls: r3Plan.length, decisions };
}

export function createRealProviderTransport(credentials) {
  return async ({ provider, model, prompt, maxOutputTokens }) => {
    if (provider === 'claude') {
      const client = new Anthropic({ apiKey: credentials.claude, maxRetries: 0 });
      const response = await client.messages.create({
        model,
        max_tokens: maxOutputTokens,
        messages: [{ role: 'user', content: prompt }],
      });
      return {
        text: response.content.filter((block) => block.type === 'text').map((block) => block.text).join(''),
        raw: response,
        providerResolved: 'claude',
        modelResolved: response.model ?? null,
        stopReason: response.stop_reason ?? null,
      };
    }
    if (provider === 'gemini') {
      const client = new GoogleGenerativeAI(credentials.gemini);
      const response = (await client.getGenerativeModel({ model }).generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens },
      })).response;
      return {
        text: response.text(),
        raw: response,
        providerResolved: 'gemini',
        modelResolved: response.modelVersion ?? null,
        stopReason: response.candidates?.[0]?.finishReason ?? null,
      };
    }
    throw stop('STOP_REVIEW_ROUTE_MISMATCH', `unsupported provider ${JSON.stringify(provider)}`);
  };
}

/** Explicit real entrypoint. Tests call the injected core stages instead. */
export async function dispatchStructuralReviewLive({
  liveExecution,
  authorizedBaseSha,
  stage,
} = {}) {
  if (liveExecution !== true) {
    throw stop('STOP_LIVE_FLAG_REQUIRED', 'LIVE dispatch is not authorized without liveExecution: true');
  }
  if (!/^[0-9a-f]{40}$/.test(authorizedBaseSha ?? '')) {
    throw stop('STOP_AUTHORIZED_BASE_REQUIRED', 'authorizedBaseSha must be an explicit full lowercase commit SHA');
  }
  const credentials = {
    claude: process.env.ANTHROPIC_API_KEY ?? '',
    gemini: process.env.GEMINI_API_KEY ?? '',
  };
  requireCredential('claude', credentials);
  requireCredential('gemini', credentials);
  const transport = createRealProviderTransport(credentials);
  const revalidate = createLiveRevalidator({ authorizedBaseSha });
  if (stage === INITIAL_STAGE) {
    const candidateArtifact = JSON.parse(fs.readFileSync(CANDIDATE_PATH, 'utf8'));
    return runInitialStructuralReviewStage({
      authorizedBaseSha,
      pool: candidateArtifact.candidates,
      rubricPasteBytes: loadFrozenRubricPasteBytes(),
      artifactDir: LIVE_ARTIFACT_DIR,
      transport,
      credentials,
      revalidate,
    });
  }
  if (stage === R3_STAGE) {
    return runR3StructuralReviewStage({
      authorizedBaseSha,
      artifactDir: LIVE_ARTIFACT_DIR,
      transport,
      credentials,
      revalidate,
    });
  }
  throw stop('STOP_STAGE_INVALID', `stage must be ${INITIAL_STAGE} or ${R3_STAGE}`);
}
