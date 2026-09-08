/**
 * CBRP-DUPLICATE-AUDIT-LIVE-HARNESS-1
 *
 * Offline-tested transport and evidence boundary for future
 * CBRP-CORPUS-DUPLICATE-AUDIT-PROTOCOL-1 execution. Importing this module
 * performs no I/O and no provider call. The real transport is reachable only
 * through `dispatchLiveDuplicateAudit()`, which requires an explicit LIVE
 * flag, authorized base SHA, exact artifact namespace, credentials,
 * runtime/source revalidation, and a durable exclusive reservation for every
 * call -- mirroring `structural-review-live-harness-v1.mjs`'s guarded-stub
 * shape (CWP-10G/10H), adapted for this instrument's round-scoped D1/D2
 * sessions and pair-scoped D3 sessions instead of per-task R1/R2/R3.
 *
 * CWP-12B: implemented and offline-verified only. DUP-R00 has not run and
 * this module makes zero provider calls when imported or exercised by the
 * offline conformance suite -- every test injects a fake `transport`.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';

import {
  PROTOCOL_VERSION,
  ROUND_STATES,
  D1_PIN,
  D2_PIN,
  computeD1D2SessionPlan,
  computeD3RoutePlan,
  buildD3RouteManifest,
} from './duplicate-audit-runner.mjs';
import {
  EXPECTED_LAYER_A_BYTE_COUNT,
  EXPECTED_LAYER_A_SHA256,
  loadFrozenLayerABytes,
} from './duplicate-audit-prompt-v1.mjs';
import { extractDuplicateAuditResponse } from './duplicate-audit-extractor-v1.mjs';
import {
  validateD1D2Response,
  validateD3Response,
  deriveD1D2Outcome,
  finalPairDecision,
  computeDuplicateD3Selector,
  applyRetention,
} from './duplicate-audit-decision-v1.mjs';
import { validateCorpusAndScope, pairKey } from './duplicate-audit-order-v1.mjs';

export const HARNESS_VERSION = 'CBRP-DUPLICATE-AUDIT-LIVE-HARNESS-1';
export const MODEL_PIN_VERSION = 'CBRP-SESSION-MODEL-PINS-1';
export const D1D2_STAGE = 'D1D2';
export const D3_STAGE = 'D3';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(DIR, '../../../..');
const CENSUS_DIR = path.resolve(DIR, '..');

/**
 * Every frozen upstream file this harness depends on for correctness --
 * mirrors structural-review-live-harness-v1.mjs's SOURCE_HASHES exactly in
 * purpose: if any of these change without this constant being updated to
 * match, a real LIVE dispatch must fail closed (STOP_SOURCE_DRIFT) rather
 * than silently run against a stale assumption. The harness/runner modules
 * that consume these are deliberately NOT self-referenced here, matching
 * structural review's own convention.
 */
const SOURCE_HASHES = Object.freeze({
  'experiments/m2b/census/CBRP_CORPUS_DUPLICATE_AUDIT_PROTOCOL_1.md': 'cbac540b7214afcf6e6352fb81dd8bda68171707eed0ac5197ac9555e8c64555',
  'experiments/m2b/census/duplicate-audit-protocol/duplicate-audit-prompt-v1.mjs': 'a5abab6b0e20d0234c44c985224a1b8953473826abd34bf96aa71be0fa88debd',
  'experiments/m2b/census/duplicate-audit-protocol/duplicate-audit-order-v1.mjs': 'dd25109b8571e42f5f51d222bd6fec03eeb441dac9b500364c19df923fb52772',
  'experiments/m2b/census/duplicate-audit-protocol/duplicate-audit-extractor-v1.mjs': '1025b478b6308dac0639b4bf9268bdf18ce36c1d13445aea9f7f999d0ce366e8',
  'experiments/m2b/census/duplicate-audit-protocol/duplicate-audit-decision-v1.mjs': '16fb3e3b2cb3c7888350402675e88de180fa82577693d1db24cb91948b4e6d03',
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

export class DuplicateAuditStop extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'DuplicateAuditStop';
    this.code = code;
    this.details = details;
  }
}

function stop(code, message, details) {
  return new DuplicateAuditStop(code, message, details);
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

const ROUND_ID_PATTERN = /^DUP-R\d{2}$/;

/** `DUP-R00` -> `experiments/m2b/census/duplicate-audit-round-00/`. */
function liveArtifactPaths(roundId) {
  if (!ROUND_ID_PATTERN.test(roundId ?? '')) {
    throw stop('STOP_ROUND_INVALID', `unrecognized roundId ${JSON.stringify(roundId)}`);
  }
  const dirName = `duplicate-audit-round-${roundId.slice(6)}`;
  const absolute = path.join(CENSUS_DIR, dirName);
  return { absolute, relative: path.relative(REPO_ROOT, absolute) + '/' };
}

/** Captures the facts that are revalidated immediately before each LIVE call. */
export function captureRuntimeSnapshot(roundId = 'DUP-R00') {
  const layerA = loadFrozenLayerABytes();
  const sourceHashes = Object.fromEntries(
    Object.keys(SOURCE_HASHES).map((relative) => [
      relative,
      sha256(fs.readFileSync(path.join(REPO_ROOT, relative))),
    ])
  );
  const driftPaths = workingTreePaths();
  const { relative: liveArtifactRelative } = liveArtifactPaths(roundId);
  return {
    capturedAt: nowIso(),
    head: git('rev-parse', 'HEAD'),
    nodeVersion: process.version,
    packageLockSha256: sha256(fs.readFileSync(path.join(REPO_ROOT, 'package-lock.json'))),
    anthropicSdkVersion: readPackageVersion(path.join(REPO_ROOT, 'node_modules', '@anthropic-ai', 'sdk', 'package.json')),
    geminiSdkVersion: readPackageVersion(path.join(REPO_ROOT, 'node_modules', '@google', 'generative-ai', 'package.json')),
    layerABytes: Buffer.byteLength(layerA, 'utf8'),
    layerASha256: sha256(layerA),
    sourceHashes,
    workingTreePaths: driftPaths,
    unexpectedWorkingTreePaths: driftPaths.filter((entry) => !entry.startsWith(liveArtifactRelative)),
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
  if (snapshot.layerABytes !== EXPECTED_LAYER_A_BYTE_COUNT
      || snapshot.layerASha256 !== EXPECTED_LAYER_A_SHA256) {
    throw stop('STOP_RUBRIC_DRIFT', 'frozen Layer A bytes/hash mismatch');
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

export function createLiveRevalidator({ authorizedBaseSha, roundId = 'DUP-R00' }) {
  return async () => assertRuntimeSnapshot(captureRuntimeSnapshot(roundId), { authorizedBaseSha });
}

function isMaxTokensStopReason(stopReason) {
  return typeof stopReason === 'string' && stopReason.toUpperCase() === 'MAX_TOKENS';
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

function safeSessionFileName(sessionId) {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId ?? '')) {
    throw stop('STOP_SESSION_ID_INVALID', `unsafe sessionId ${JSON.stringify(sessionId)}`);
  }
  return sessionId;
}

/** Durable evidence store: raw-first persistence + one-attempt reservations. */
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
    assertRawPersistenceReady(sessionId) {
      const safe = safeSessionFileName(sessionId);
      const probe = path.join(rawDir, `.probe-${safe}-${crypto.randomBytes(4).toString('hex')}`);
      writeDurableExclusive(probe, 'probe');
      fs.unlinkSync(probe);
      fsyncDirectory(rawDir);
    },
    reserve(sessionId, reservation) {
      const safe = safeSessionFileName(sessionId);
      const reservationPath = path.join(reservationsDir, `${safe}.json`);
      try {
        writeDurableExclusive(reservationPath, canonical(reservation));
      } catch (error) {
        if (error?.code === 'EEXIST') {
          throw stop(
            'STOP_AMBIGUOUS_OR_CONSUMED_RESERVATION',
            `reservation already exists for ${sessionId}; attempt is consumed and must not be dispatched again`,
            { sessionId, reservationPath }
          );
        }
        throw error;
      }
      return reservationPath;
    },
    persistRaw(sessionId, text, rawProviderResponse) {
      const safe = safeSessionFileName(sessionId);
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

function expectedRoute(session) {
  if (session.role === 'D1') return D1_PIN;
  if (session.role === 'D2') return D2_PIN;
  if (session.role === 'D3') return computeDuplicateD3Selector(session.a, session.b);
  throw stop('STOP_SESSION_ROLE_INVALID', `unknown role ${JSON.stringify(session.role)}`);
}

export function assertSessionRoute(session) {
  const expectedSessionId = session.role === 'D3'
    ? `${session.roundId}-D3-${session.a}__${session.b}`
    : `${session.roundId}-${session.role}`;
  if (session.sessionId !== expectedSessionId) {
    throw stop('STOP_SESSION_ID_INVALID', `${session.sessionId} != ${expectedSessionId}`);
  }
  const expected = expectedRoute(session);
  if (session.provider !== expected.provider || session.model !== expected.model
      || session.modelFamily !== expected.modelFamily) {
    throw stop('STOP_SESSION_ROUTE_MISMATCH', `${session.role} route does not match its frozen pin`, {
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
  store.writeJson('SESSIONS.json', { sessions: state.sessions });
  store.writeJson('RESULTS.json', { results: state.results });
}

/**
 * Executes exactly one D1, D2, or D3 session: raw-first persistence before
 * parsing, a durable exclusive reservation before dispatch, the MAX_TOKENS
 * fail-closed rule (provider-agnostic, applied before extraction, even if the
 * visible truncated text is syntactically valid JSON -- identical posture to
 * `CBRP-STRUCTURAL-REVIEW-PROTOCOL-1`'s rule), then extraction and strict
 * schema validation. One attempt; every failure is a `DuplicateAuditStop`
 * that preserves whatever evidence had already been durably written.
 *
 * @param {{ session: object, store: object, state: {sessions: object[], results: object[]},
 *           transport: Function, credentials: object, revalidate: Function,
 *           corpusTaskIds?: string[], pairUniverse?: Array<{a:string,b:string}>,
 *           maxOutputTokens: number, thinkingLevel?: string|null, clock?: Function }} input
 */
export async function executeDuplicateAuditSession({
  session,
  store,
  state,
  transport,
  credentials,
  revalidate,
  corpusTaskIds,
  pairUniverse,
  maxOutputTokens,
  thinkingLevel = null,
  clock = nowIso,
}) {
  if (typeof transport !== 'function') throw new TypeError('executeDuplicateAuditSession: injected transport is required');
  if (typeof revalidate !== 'function') throw new TypeError('executeDuplicateAuditSession: revalidate is required');
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0) {
    throw new TypeError('executeDuplicateAuditSession: maxOutputTokens must be a positive integer');
  }
  assertSessionRoute(session);
  requireCredential(session.provider, credentials);
  const runtimeProvenance = await revalidate();
  try {
    store.assertRawPersistenceReady(session.sessionId);
  } catch (error) {
    throw stop('STOP_RAW_PERSISTENCE_UNAVAILABLE', String(error?.message ?? error));
  }

  const reservationTimestamp = clock();
  const reservation = {
    harnessVersion: HARNESS_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    sessionId: session.sessionId,
    roundId: session.roundId,
    role: session.role,
    providerRequested: session.provider,
    modelRequested: session.model,
    reservationTimestamp,
    status: 'RESERVED_ATTEMPT_CONSUMED_ON_DISPATCH',
  };
  store.reserve(session.sessionId, reservation);

  const record = {
    ...reservation,
    modelFamily: session.modelFamily,
    modelPinVersion: MODEL_PIN_VERSION,
    freshContextConfirmed: true,
    freshContextBasis: 'OPERATOR ATTESTATION — one stateless API request containing only the frozen model-visible prompt; no system prompt, prior turns, conversation id, or continuation. NOT independently verified.',
    wrapperVersion: session.prompt.wrapperVersion,
    layerAVersion: session.prompt.layerAVersion,
    layerASha256: session.prompt.layerASha256,
    promptSha256: session.prompt.promptSha256,
    promptBytes: session.prompt.promptBytes,
    maxTokensRequested: maxOutputTokens,
    thinkingLevelRequested: thinkingLevel,
    temperatureRequested: null,
    transportRetryConfiguration: session.provider === 'claude'
      ? 'maxRetries: 0'
      : 'SDK 0.24.1 single generateContent request; no retry/fallback layer',
    d3SelectorInput: session.d3SelectorInput ?? null,
    d3Selector: session.d3Selector ?? null,
    a: session.a ?? null,
    b: session.b ?? null,
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
      maxOutputTokens,
      thinkingLevel,
      temperature: null,
      sessionId: session.sessionId,
      role: session.role,
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
    rawPaths = store.persistRaw(session.sessionId, response.text, response.raw);
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

  // MAX_TOKENS fail-closed rule: checked immediately after raw evidence is
  // durably persisted and before anything else -- a truncated response is
  // never extracted, schema-admitted, retried, or followed by a later call,
  // even if the visible truncated text happens to parse as valid JSON.
  if (isMaxTokensStopReason(record.stopReason)) {
    record.outcome = 'STOP_MAX_TOKENS_TRUNCATED';
    persistRunState(store, state);
    throw stop(
      record.outcome,
      `provider terminated on max output tokens (stopReason=${JSON.stringify(record.stopReason)}); response is not extracted or admitted regardless of apparent JSON validity`,
      { record }
    );
  }

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

  const extraction = extractDuplicateAuditResponse(response.text);
  Object.assign(record, {
    extractorVersion: extraction.extractorVersion,
    representationDetected: extraction.representationDetected,
    normalizedJsonSha256: extraction.normalizedJsonSha256,
  });
  if (!extraction.ok) {
    record.outcome = 'STOP_MALFORMED_RESPONSE';
    persistRunState(store, state);
    throw stop(record.outcome, 'duplicate-audit extractor rejected response', { record });
  }

  const validation = session.role === 'D3'
    ? validateD3Response(extraction.parsed)
    : validateD1D2Response(extraction.parsed, { corpusTaskIds, pairUniverse });
  record.mechanicalValidation = validation.ok ? { ok: true } : { ok: false, reason: validation.reason };
  if (!validation.ok) {
    record.parsedResponse = extraction.parsed;
    record.outcome = 'STOP_SCHEMA_VIOLATION';
    persistRunState(store, state);
    throw stop(record.outcome, validation.reason, { record });
  }

  record.parsedResponse = extraction.parsed;
  record.outcome = 'SESSION_VALIDATED';
  const result = session.role === 'D3'
    ? { sessionId: session.sessionId, role: session.role, a: session.a, b: session.b, isDuplicate: validation.isDuplicate, reason: validation.reason }
    : { sessionId: session.sessionId, role: session.role, positivePairs: validation.positivePairs };
  state.results.push(result);
  persistRunState(store, state);
  return record;
}

/**
 * Runs one round's complete D1/D2 stage: both sessions in sequence (D1 then
 * D2 -- §8.4 steps 1-4), then derives the §7.3/§7.4 outcome and disagreement
 * set. Refuses to redispatch if a reservation already exists (no
 * initial-stage restart after a partial run).
 */
export async function runD1D2Stage({
  authorizedBaseSha,
  roundId,
  corpusTasks,
  auditScopeIds,
  artifactDir,
  transport,
  credentials,
  revalidate,
  store: suppliedStore,
  clock,
  maxOutputTokens,
  thinkingLevel = null,
}) {
  if (!ROUND_ID_PATTERN.test(roundId ?? '')) {
    throw stop('STOP_ROUND_INVALID', `unrecognized roundId ${JSON.stringify(roundId)}`);
  }
  if (!/^[0-9a-f]{40}$/.test(authorizedBaseSha ?? '')) {
    throw stop('STOP_AUTHORIZED_BASE_REQUIRED', 'authorizedBaseSha must be an explicit full lowercase commit SHA');
  }
  const corpusTaskIds = corpusTasks.map((t) => t.candidateId);
  const scopeValidation = validateCorpusAndScope({ corpusTaskIds, auditScopeIds });
  if (!scopeValidation.ok) {
    throw stop('STOP_SCOPE_INVALID', scopeValidation.reason);
  }

  const store = suppliedStore ?? createArtifactStore(artifactDir);
  store.initialize();
  const existingReservations = store.listReservations();
  if (existingReservations.length > 0) {
    throw stop(
      'STOP_AMBIGUOUS_OR_CONSUMED_RESERVATION',
      'one or more session reservations already exist; no D1/D2-stage redispatch is allowed',
      { reservations: existingReservations }
    );
  }

  const layerABytes = loadFrozenLayerABytes();
  const plan = computeD1D2SessionPlan({ roundId, corpusTasks, auditScopeIds, layerABytes });

  store.writeTextExclusive('LAYER_A_SENT.txt', layerABytes);
  store.writeJson('CORPUS.json', {
    corpusTaskIds: plan.corpusTaskIds,
    corpusTaskCount: plan.corpusTaskIds.length,
  });
  store.writeJson('CORPUS_TASKS.json', {
    corpusTasks: [...corpusTasks]
      .map((t) => ({ candidateId: t.candidateId, taskText: t.taskText }))
      .sort((x, y) => (x.candidateId < y.candidateId ? -1 : x.candidateId > y.candidateId ? 1 : 0)),
  });
  store.writeJson('SCOPE.json', {
    auditScopeIds: plan.auditScopeIds,
    scopeCount: plan.auditScopeIds.length,
  });
  store.writeJson('PAIR_UNIVERSE.json', {
    pairCount: plan.pairUniverse.length,
    pairUniverseHash: sha256(JSON.stringify(plan.pairUniverse)),
    pairs: plan.pairUniverse,
  });
  store.writeJson('D1D2_PROMPT_MANIFEST.json', {
    harnessVersion: HARNESS_VERSION,
    wrapperVersion: plan.d1.prompt.wrapperVersion,
    promptBytes: plan.d1.prompt.promptBytes,
    promptSha256: plan.d1.prompt.promptSha256,
  });

  const state = { sessions: [], results: [] };
  persistRunState(store, state);
  store.writeJson('VALIDATION.json', {
    harnessVersion: HARNESS_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    status: ROUND_STATES.PRE_DISPATCH,
    roundId,
  });

  const sessionArgs = { corpusTaskIds: plan.corpusTaskIds, pairUniverse: plan.pairUniverse, maxOutputTokens, thinkingLevel, clock };
  try {
    await executeDuplicateAuditSession({ session: { ...plan.d1, roundId }, store, state, transport, credentials, revalidate, ...sessionArgs });
    store.writeJson('VALIDATION.json', { harnessVersion: HARNESS_VERSION, protocolVersion: PROTOCOL_VERSION, status: ROUND_STATES.D1_COMPLETE, roundId });
    await executeDuplicateAuditSession({ session: { ...plan.d2, roundId }, store, state, transport, credentials, revalidate, ...sessionArgs });
  } catch (error) {
    store.writeJson('VALIDATION.json', {
      harnessVersion: HARNESS_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      status: ROUND_STATES.FAILED_CLOSED,
      roundId,
      stopCode: error?.code ?? 'STOP_UNEXPECTED_ERROR',
      stopMessage: String(error?.message ?? error),
      sessionsRecorded: state.sessions.length,
    });
    throw error;
  }

  const [d1Result, d2Result] = state.results;
  const outcome = deriveD1D2Outcome({
    pairUniverse: plan.pairUniverse,
    d1PositivePairs: d1Result.positivePairs,
    d2PositivePairs: d2Result.positivePairs,
  });
  store.writeJson('D1D2_OUTCOME.json', outcome);

  const finalStatus = outcome.disagreementSet.length > 0 ? ROUND_STATES.D3_REQUIRED : ROUND_STATES.D3_COMPLETE;
  store.writeJson('VALIDATION.json', {
    harnessVersion: HARNESS_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    status: finalStatus,
    roundId,
    pairUniverseCount: plan.pairUniverse.length,
    confirmedCount: outcome.confirmedPairs.length,
    disagreementCount: outcome.disagreementSet.length,
    d3Dispatched: false,
  });

  return { status: finalStatus, roundId, plan, outcome, calls: state.sessions.length };
}

/**
 * Runs one round's D3 stage: materializes the complete route manifest
 * durably (§8.4 steps 5-8) -- including a reload-and-exact-verification pass
 * after the write, per CWP-12B's requirement 11 -- before the first D3
 * dispatch becomes eligible, then executes every disputed pair's session in
 * the disagreement set's order. Requires the D1/D2 stage to have completed
 * with `D3_REQUIRED`; an existing mismatched manifest STOPs without ever
 * overwriting it.
 */
export async function runD3Stage({
  authorizedBaseSha,
  roundId,
  artifactDir,
  transport,
  credentials,
  revalidate,
  store: suppliedStore,
  clock,
  maxOutputTokens,
  thinkingLevel = null,
}) {
  if (!ROUND_ID_PATTERN.test(roundId ?? '')) {
    throw stop('STOP_ROUND_INVALID', `unrecognized roundId ${JSON.stringify(roundId)}`);
  }
  if (!/^[0-9a-f]{40}$/.test(authorizedBaseSha ?? '')) {
    throw stop('STOP_AUTHORIZED_BASE_REQUIRED', 'authorizedBaseSha must be an explicit full lowercase commit SHA');
  }
  const store = suppliedStore ?? createArtifactStore(artifactDir);
  store.initialize();
  const validation = store.readJson('VALIDATION.json');
  if (validation.status !== ROUND_STATES.D3_REQUIRED) {
    throw stop('STOP_D1D2_STAGE_NOT_READY', 'D3 requires a D1/D2 stage that completed with D3_REQUIRED');
  }
  const outcome = store.readJson('D1D2_OUTCOME.json');
  const layerABytes = loadFrozenLayerABytes();
  const taskById = new Map(store.readJson('CORPUS_TASKS.json').corpusTasks.map((t) => [t.candidateId, t]));

  const d3RoutePlan = computeD3RoutePlan({ roundId, disagreementSet: outcome.disagreementSet, taskById, layerABytes });
  const manifest = buildD3RouteManifest({ roundId, d3RoutePlan });

  if (store.exists('D3_ROUTE_MANIFEST.json')) {
    const existing = store.readJson('D3_ROUTE_MANIFEST.json');
    if (JSON.stringify(existing) !== JSON.stringify(manifest)) {
      throw stop('STOP_D3_ROUTE_MANIFEST_MISMATCH', 'existing D3_ROUTE_MANIFEST.json does not match the recomputed frozen plan; refusing to overwrite or repair it');
    }
  } else {
    try {
      store.writeJson('D3_ROUTE_MANIFEST.json', manifest);
    } catch (error) {
      throw stop('STOP_D3_ROUTE_MANIFEST_PERSISTENCE_FAILED', String(error?.message ?? error));
    }
    // Reload and exact-verify the just-written manifest before any dispatch
    // becomes eligible (§8.4 step 8) -- not merely trusting the write call
    // succeeded, but reading the durable copy back and comparing it.
    let reloaded;
    try {
      reloaded = store.readJson('D3_ROUTE_MANIFEST.json');
    } catch (error) {
      throw stop('STOP_D3_ROUTE_MANIFEST_PERSISTENCE_FAILED', `reload failed: ${String(error?.message ?? error)}`);
    }
    if (JSON.stringify(reloaded) !== JSON.stringify(manifest)) {
      throw stop('STOP_D3_ROUTE_MANIFEST_PERSISTENCE_FAILED', 'reloaded manifest does not exactly match the manifest just written');
    }
  }

  const state = { sessions: store.exists('SESSIONS.json') ? store.readJson('SESSIONS.json').sessions : [], results: store.exists('RESULTS.json') ? store.readJson('RESULTS.json').results : [] };
  const sessionArgs = { maxOutputTokens, thinkingLevel, clock };
  try {
    for (const entry of d3RoutePlan) {
      await executeDuplicateAuditSession({
        session: { sessionId: entry.sessionId, roundId, role: 'D3', a: entry.a, b: entry.b, provider: entry.provider, model: entry.model, modelFamily: entry.modelFamily, d3SelectorInput: entry.d3SelectorInput, d3Selector: entry.d3Selector, prompt: entry.prompt },
        store, state, transport, credentials, revalidate, ...sessionArgs,
      });
    }
  } catch (error) {
    store.writeJson('VALIDATION.json', { ...validation, status: ROUND_STATES.FAILED_CLOSED, stopCode: error?.code ?? 'STOP_UNEXPECTED_ERROR', stopMessage: String(error?.message ?? error) });
    throw error;
  }

  const d3ByPair = new Map(state.results.filter((r) => r.role === 'D3').map((r) => [pairKey(r), r.isDuplicate]));
  const finalDecisions = outcome.results.map((r) => {
    if (r.outcome !== 'D3_REQUIRED') {
      return { a: r.a, b: r.b, finalIsDuplicate: r.d1, source: r.outcome };
    }
    const d3 = d3ByPair.get(pairKey(r));
    if (d3 === undefined) throw stop('STOP_D3_RESULT_MISSING', `no D3 result recorded for pair ${pairKey(r)}`);
    return { a: r.a, b: r.b, finalIsDuplicate: finalPairDecision({ d1: r.d1, d2: r.d2, d3 }), source: 'D3_MAJORITY' };
  });
  store.writeJson('FINAL_DECISIONS.json', { decisions: finalDecisions });
  store.writeJson('VALIDATION.json', {
    ...validation,
    status: ROUND_STATES.D3_COMPLETE,
    d3Dispatched: true,
    d3Expected: d3RoutePlan.length,
    d3Completed: d3RoutePlan.length,
  });

  return { status: ROUND_STATES.D3_COMPLETE, roundId, finalDecisions, calls: d3RoutePlan.length };
}

/**
 * Applies §11 retention to a round once its final pair decisions are known
 * (either vacuously, straight from the D1/D2 outcome when no disagreement
 * occurred, or after `runD3Stage`). Pure with respect to the filesystem
 * beyond reading/writing this round's own evidence -- `incumbents`/`focusSet`
 * are supplied by the caller, never invented here (round 0 supplies an empty
 * incumbents set; an incremental round supplies the real prior-round survivors).
 */
export function finalizeRound({ artifactDir, store: suppliedStore, incumbents, focusSet }) {
  const store = suppliedStore ?? createArtifactStore(artifactDir);
  const validation = store.readJson('VALIDATION.json');
  if (validation.status !== ROUND_STATES.D3_COMPLETE) {
    throw stop('STOP_ROUND_NOT_READY_TO_FINALIZE', 'finalizeRound requires a D3_COMPLETE round (vacuously or via runD3Stage)');
  }
  const confirmedPairs = store.exists('FINAL_DECISIONS.json')
    ? store.readJson('FINAL_DECISIONS.json').decisions.filter((d) => d.finalIsDuplicate).map(({ a, b }) => ({ a, b }))
    : store.readJson('D1D2_OUTCOME.json').confirmedPairs;

  const retention = applyRetention({ confirmedPairs, incumbents, focusSet });
  store.writeJson('RETENTION.json', retention);
  store.writeJson('VALIDATION.json', {
    ...validation,
    status: ROUND_STATES.ROUND_COMPLETE,
    vacanciesCreated: retention.rejected.length,
  });
  return { status: ROUND_STATES.ROUND_COMPLETE, retention };
}

export function createRealProviderTransport(credentials) {
  return async ({ provider, model, prompt, maxOutputTokens, thinkingLevel }) => {
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
      const generationConfig = { maxOutputTokens };
      if (thinkingLevel != null) generationConfig.thinkingConfig = { thinkingLevel };
      const response = (await client.getGenerativeModel({ model }).generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig,
      })).response;
      return {
        text: response.text(),
        raw: response,
        providerResolved: 'gemini',
        modelResolved: response.modelVersion ?? null,
        stopReason: response.candidates?.[0]?.finishReason ?? null,
      };
    }
    throw stop('STOP_SESSION_ROUTE_MISMATCH', `unsupported provider ${JSON.stringify(provider)}`);
  };
}

/**
 * Explicit real entrypoint. Requires `liveExecution: true` and a valid
 * `authorizedBaseSha`; a caller lacking either gets STOP_LIVE_FLAG_REQUIRED /
 * STOP_AUTHORIZED_BASE_REQUIRED before anything else runs. No CWP has
 * authorized a call to this function yet -- DUP-R00 has not executed, and
 * this offline conformance suite never calls it with `liveExecution: true`.
 */
export async function dispatchLiveDuplicateAudit({
  liveExecution,
  authorizedBaseSha,
  roundId,
  stage,
  corpusTasks,
  auditScopeIds,
  maxOutputTokens,
  thinkingLevel = null,
} = {}) {
  if (liveExecution !== true) {
    throw stop('STOP_LIVE_FLAG_REQUIRED', 'LIVE dispatch is not authorized without liveExecution: true');
  }
  if (!/^[0-9a-f]{40}$/.test(authorizedBaseSha ?? '')) {
    throw stop('STOP_AUTHORIZED_BASE_REQUIRED', 'authorizedBaseSha must be an explicit full lowercase commit SHA');
  }
  if (!ROUND_ID_PATTERN.test(roundId ?? '')) {
    throw stop('STOP_ROUND_INVALID', `roundId must match DUP-R\\d\\d, got ${JSON.stringify(roundId)}`);
  }
  const credentials = {
    claude: process.env.ANTHROPIC_API_KEY ?? '',
    gemini: process.env.GEMINI_API_KEY ?? '',
  };
  requireCredential('claude', credentials);
  requireCredential('gemini', credentials);
  const transport = createRealProviderTransport(credentials);
  const revalidate = createLiveRevalidator({ authorizedBaseSha, roundId });
  const { absolute: artifactDir } = liveArtifactPaths(roundId);
  if (stage === D1D2_STAGE) {
    return runD1D2Stage({ authorizedBaseSha, roundId, corpusTasks, auditScopeIds, artifactDir, transport, credentials, revalidate, maxOutputTokens, thinkingLevel });
  }
  if (stage === D3_STAGE) {
    return runD3Stage({ authorizedBaseSha, roundId, artifactDir, transport, credentials, revalidate, maxOutputTokens, thinkingLevel });
  }
  throw stop('STOP_STAGE_INVALID', `stage must be ${D1D2_STAGE} or ${D3_STAGE}`);
}
