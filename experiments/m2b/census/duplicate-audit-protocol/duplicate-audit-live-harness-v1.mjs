/**
 * CBRP-DUPLICATE-AUDIT-LIVE-HARNESS-1
 *
 * Offline-tested transport and evidence boundary for future
 * CBRP-CORPUS-DUPLICATE-AUDIT-PROTOCOL-1 execution. Importing this module may
 * bootstrap environment configuration (repository `.env`, via `dotenv/config`,
 * mirroring `structural-review-live-harness-v1.mjs`) but performs no provider
 * call and creates no research evidence. The real transport is reachable only
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
 *
 * CWP-12D-R: added the `dotenv/config` bootstrap below (previously missing,
 * unlike the structural-review harness) after a real DUP-R00 D1/D2 dispatch
 * attempt (CWP-12D) STOPped on STOP_CREDENTIAL_MISSING even though the
 * repository `.env` held valid credentials -- this module simply never
 * loaded it when invoked from a fresh process. Zero provider calls were made
 * under CWP-12D; this repair only restores the credential bootstrap.
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
  ROUND_STATES,
  D1_PIN,
  D2_PIN,
  computeD1D2SessionPlan,
  computeD3RoutePlan,
  buildD3RouteManifest,
  dupR00EnvelopeFor,
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
import { validateCorpusAndScope, pairKey, computePairUniverse } from './duplicate-audit-order-v1.mjs';
import {
  loadCanonicalDupR00Corpus,
  assertDupR00ScopeInvariant,
} from './duplicate-audit-corpus-binding-v1.mjs';

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
 *
 * CWP-12C extends this beyond protocol/module source to DUP-R00's three
 * canonical evidence files (§C): the exact authoring population and the
 * exact Structural Review ROUND_2 outcome LIVE must be bound to. A change
 * to any of these three -- even one that would otherwise look like a
 * legitimate later state -- must STOP a DUP-R00 dispatch rather than be
 * silently picked up, because "which 60 tasks" and "which structural
 * decisions" are exactly what DUP-R00's corpus binding exists to fix.
 */
const SOURCE_HASHES = Object.freeze({
  'experiments/m2b/census/CBRP_CORPUS_DUPLICATE_AUDIT_PROTOCOL_1.md': 'cbac540b7214afcf6e6352fb81dd8bda68171707eed0ac5197ac9555e8c64555',
  'experiments/m2b/census/duplicate-audit-protocol/duplicate-audit-prompt-v1.mjs': 'a5abab6b0e20d0234c44c985224a1b8953473826abd34bf96aa71be0fa88debd',
  'experiments/m2b/census/duplicate-audit-protocol/duplicate-audit-order-v1.mjs': 'dd25109b8571e42f5f51d222bd6fec03eeb441dac9b500364c19df923fb52772',
  'experiments/m2b/census/duplicate-audit-protocol/duplicate-audit-extractor-v1.mjs': '78aee59362768e5ee36fe56952184de6eca505ad8e52f7c405f101d84d1a5eeb',
  'experiments/m2b/census/duplicate-audit-protocol/duplicate-audit-decision-v1.mjs': '16fb3e3b2cb3c7888350402675e88de180fa82577693d1db24cb91948b4e6d03',
  'experiments/m2b/census/authoring-v2p1-round-0/CANDIDATES.json': '05bb612aa85c95fdcc9e4dbf077ebc50b2977e0fe41df8179c127e2d9dc98368',
  'experiments/m2b/census/structural-review-round-2/FINAL_DECISIONS.json': '1fbd7bab3a64a1750a4d571653b5299ed87242a4b72a5ac53b3c1c3e07878402',
  'experiments/m2b/census/structural-review-round-2/VALIDATION.json': '5fc03db72f7a67843b6797f80da3cddae56f4fc04b0ba9694eea2ecff35c6f42',
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

/** Exported (CWP-12F) for the same reason as `git` above. */
export function readPackageVersion(packagePath) {
  return JSON.parse(fs.readFileSync(packagePath, 'utf8')).version;
}

/** Exported (CWP-12F) so a sibling protocol harness can build its own runtime snapshot from the same primitive instead of re-shelling out independently. */
export function git(...args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

/** Exported (CWP-12F) for the same reason as `git` above. */
export function workingTreePaths() {
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

const ROUND_ID_PATTERN = /^DUP-R(\d{2})$/;

/**
 * Pure, testable extraction of a round ID's two-digit suffix, via the same
 * capture group `ROUND_ID_PATTERN` already uses to validate the ID -- never
 * a hardcoded string index. `roundId.slice(6)` (CWP-12B..12D-2) silently
 * dropped the leading digit of the suffix (`DUP-R00` -> `0`, not `00`)
 * because `'DUP-R'` is 5 characters, not 6; a real LIVE dispatch (CWP-12D-2)
 * wrote genuine evidence to `duplicate-audit-round-0/` instead of the
 * intended `duplicate-audit-round-00/` before this was caught. Deriving the
 * suffix from the validation regex's own capture group makes the two
 * mechanically incapable of disagreeing.
 */
export function dupRoundSuffix(roundId) {
  const match = ROUND_ID_PATTERN.exec(roundId ?? '');
  if (!match) {
    throw stop('STOP_ROUND_INVALID', `unrecognized roundId ${JSON.stringify(roundId)}`);
  }
  return match[1];
}

/** `DUP-R00` -> `experiments/m2b/census/duplicate-audit-round-00/`. */
export function liveArtifactPaths(roundId) {
  const dirName = `duplicate-audit-round-${dupRoundSuffix(roundId)}`;
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
 * `envelopeForProvider(provider)` is looked up per session by
 * `session.provider` -- never a single flat value applied uniformly --
 * because D1 (claude) and D2 (gemini) legitimately need different
 * maxOutputTokens/thinkingLevel, mirroring
 * `generationEnvelopeFor(roundId, provider)` in
 * structural-review-live-harness-v1.mjs exactly. This is also what makes a
 * caller-supplied flat override impossible by construction: the value is
 * always derived from the injected lookup function, never accepted as a
 * session-level number.
 *
 * `protocolVersion` (CWP-12F) defaults to this module's own frozen
 * `PROTOCOL_VERSION` (Protocol-1) so every existing call site's persisted
 * evidence is byte-for-byte unchanged; a sibling protocol harness (e.g.
 * Protocol-2's `duplicate-audit-live-harness-p2-v1.mjs`) passes its own
 * protocol identifier explicitly so its evidence self-identifies correctly
 * instead of silently claiming Protocol-1.
 *
 * @param {{ session: object, store: object, state: {sessions: object[], results: object[]},
 *           transport: Function, credentials: object, revalidate: Function,
 *           corpusTaskIds?: string[], pairUniverse?: Array<{a:string,b:string}>,
 *           envelopeForProvider: (provider: string) => {maxOutputTokens: number, thinkingLevel?: string|null},
 *           clock?: Function, protocolVersion?: string }} input
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
  envelopeForProvider,
  clock = nowIso,
  protocolVersion = PROTOCOL_VERSION,
}) {
  if (typeof transport !== 'function') throw new TypeError('executeDuplicateAuditSession: injected transport is required');
  if (typeof revalidate !== 'function') throw new TypeError('executeDuplicateAuditSession: revalidate is required');
  if (typeof envelopeForProvider !== 'function') throw new TypeError('executeDuplicateAuditSession: envelopeForProvider function is required');
  assertSessionRoute(session);
  const envelope = envelopeForProvider(session.provider);
  const maxOutputTokens = envelope?.maxOutputTokens;
  const thinkingLevel = envelope?.thinkingLevel ?? null;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0) {
    throw new TypeError(`executeDuplicateAuditSession: envelopeForProvider(${JSON.stringify(session.provider)}) did not return a positive integer maxOutputTokens`);
  }
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
    protocolVersion,
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
 *
 * `protocolVersion`/`roundIdPattern` (CWP-12F) default to Protocol-1's own
 * frozen values, so every existing Protocol-1 call site is unaffected. A
 * sibling protocol harness supplies its own protocol identifier and
 * round-ID pattern so this same, otherwise-unmodified function can be
 * reused by composition instead of being forked -- exactly the
 * `computeD1D2SessionPlan`/`computeD3RoutePlan` pattern in
 * `duplicate-audit-runner.mjs`, which already took `roundId` as a plain
 * parameter and needed no change at all.
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
  envelopeForProvider,
  protocolVersion = PROTOCOL_VERSION,
  roundIdPattern = ROUND_ID_PATTERN,
}) {
  if (!roundIdPattern.test(roundId ?? '')) {
    throw stop('STOP_ROUND_INVALID', `unrecognized roundId ${JSON.stringify(roundId)}`);
  }
  if (!/^[0-9a-f]{40}$/.test(authorizedBaseSha ?? '')) {
    throw stop('STOP_AUTHORIZED_BASE_REQUIRED', 'authorizedBaseSha must be an explicit full lowercase commit SHA');
  }
  if (typeof envelopeForProvider !== 'function') {
    throw new TypeError('runD1D2Stage: envelopeForProvider function is required');
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
    protocolVersion,
    status: ROUND_STATES.PRE_DISPATCH,
    roundId,
  });

  const sessionArgs = { corpusTaskIds: plan.corpusTaskIds, pairUniverse: plan.pairUniverse, envelopeForProvider, clock, protocolVersion };
  try {
    await executeDuplicateAuditSession({ session: { ...plan.d1, roundId }, store, state, transport, credentials, revalidate, ...sessionArgs });
    store.writeJson('VALIDATION.json', { harnessVersion: HARNESS_VERSION, protocolVersion, status: ROUND_STATES.D1_COMPLETE, roundId });
    await executeDuplicateAuditSession({ session: { ...plan.d2, roundId }, store, state, transport, credentials, revalidate, ...sessionArgs });
  } catch (error) {
    store.writeJson('VALIDATION.json', {
      harnessVersion: HARNESS_VERSION,
      protocolVersion,
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
    protocolVersion,
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
  envelopeForProvider,
}) {
  if (!ROUND_ID_PATTERN.test(roundId ?? '')) {
    throw stop('STOP_ROUND_INVALID', `unrecognized roundId ${JSON.stringify(roundId)}`);
  }
  if (!/^[0-9a-f]{40}$/.test(authorizedBaseSha ?? '')) {
    throw stop('STOP_AUTHORIZED_BASE_REQUIRED', 'authorizedBaseSha must be an explicit full lowercase commit SHA');
  }
  if (typeof envelopeForProvider !== 'function') {
    throw new TypeError('runD3Stage: envelopeForProvider function is required');
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
  const sessionArgs = { envelopeForProvider, clock };
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

/**
 * CWP-12D-2R: mirrors the installed `@anthropic-ai/sdk` (0.123.0)'s own
 * `Client#calculateNonstreamingTimeout` formula
 * (`node_modules/@anthropic-ai/sdk/src/client.ts`), which
 * `Messages#create()` calls -- and lets throw
 * `"Streaming is required for operations that may take longer than 10
 * minutes"` (observed in CWP-12D-2) -- ONLY when the caller has not already
 * supplied an explicit `timeout` (`messages.ts`: `if (!body.stream &&
 * timeout == null) { ... }`). Supplying a non-null `timeout` here makes
 * `create()` skip calling that guard entirely; it changes nothing about
 * provider, model, prompt, or generation semantics, only how long this one
 * stateless non-streaming request is allowed to run. Clamped to the SDK's
 * own bounds: never below its 10-minute default, never above the 60-minute
 * ceiling its formula treats as the outer limit for a non-streaming
 * request.
 */
export function computeClaudeNonstreamingTimeoutMillis(maxOutputTokens) {
  const MIN_TIMEOUT_MILLIS = 10 * 60 * 1000;
  const MAX_TIMEOUT_MILLIS = 60 * 60 * 1000;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0) {
    throw new TypeError('computeClaudeNonstreamingTimeoutMillis: maxOutputTokens must be a positive integer');
  }
  const expectedMillis = Math.ceil((MAX_TIMEOUT_MILLIS * maxOutputTokens) / 128_000);
  return Math.min(MAX_TIMEOUT_MILLIS, Math.max(MIN_TIMEOUT_MILLIS, expectedMillis));
}

export function createRealProviderTransport(credentials) {
  return async ({ provider, model, prompt, maxOutputTokens, thinkingLevel }) => {
    if (provider === 'claude') {
      const client = new Anthropic({
        apiKey: credentials.claude,
        maxRetries: 0,
        timeout: computeClaudeNonstreamingTimeoutMillis(maxOutputTokens),
      });
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

/** The only round this real LIVE entrypoint is architecturally authorized to understand (§D). */
export const DUP_R00_ROUND_ID = 'DUP-R00';

/**
 * CWP-12D-2R: a closed, frozen list of provider-transport attempts already
 * consumed under Protocol-1's one-attempt rule whose durable reservation/
 * session evidence lives at a path a correctly-namespaced future dispatch
 * would never look at. Specifically: CWP-12D-2's real DUP-R00-D1 attempt
 * entered `transport()` and was rejected by the Anthropic SDK
 * (STOP_PROVIDER_ERROR) while `liveArtifactPaths()` still had the off-by-one
 * bug fixed above, so its reservation/session records were durably written
 * under the OLD `duplicate-audit-round-0/` path (preserved as historical
 * evidence, CWP-12D-2F) rather than the now-correct
 * `duplicate-audit-round-00/`. Fixing the namespace bug alone would make
 * DUP-R00-D1 look never-attempted to any code that only ever reads
 * `duplicate-audit-round-00/`, silently defeating the one-attempt rule.
 * This list exists to prevent exactly that -- it is not a general recovery
 * mechanism, and it is not something a future round or session can add
 * itself to; extending it requires its own GPT-reviewed packet.
 */
export const HISTORICAL_CONSUMED_SESSIONS = Object.freeze([
  Object.freeze({
    sessionId: 'DUP-R00-D1',
    roundId: 'DUP-R00',
    role: 'D1',
    evidenceRelativePath: 'experiments/m2b/census/duplicate-audit-round-0/reservations/DUP-R00-D1.json',
    consumedBy: 'CWP-12D-2',
    stopCode: 'STOP_PROVIDER_ERROR',
  }),
]);

/**
 * Fail-closed guard for the real LIVE entrypoint only (§ below) -- not
 * wired into `executeDuplicateAuditSession`/`runD1D2Stage`/`runD3Stage`
 * themselves, so the offline conformance suite's synthetic sessions (which
 * legitimately reuse names like `DUP-R00-D1` against fake artifact
 * directories and a fake transport) remain independently testable and
 * unaffected. Throws `STOP_HISTORICAL_ATTEMPT_CONSUMED` if `sessionId` is a
 * historically consumed real attempt; throws
 * `STOP_HISTORICAL_EVIDENCE_MISSING` if the guard's own depended-upon
 * evidence file is absent (fail closed rather than silently treating an
 * unverifiable historical attempt as if it never happened).
 */
export function assertNoHistoricalAttemptConflict({ roundId, sessionId }) {
  const match = HISTORICAL_CONSUMED_SESSIONS.find(
    (entry) => entry.roundId === roundId && entry.sessionId === sessionId
  );
  if (!match) return;
  const evidenceAbsolute = path.join(REPO_ROOT, match.evidenceRelativePath);
  if (!fs.existsSync(evidenceAbsolute)) {
    throw stop(
      'STOP_HISTORICAL_EVIDENCE_MISSING',
      `expected historical evidence at ${match.evidenceRelativePath} for ${sessionId} is missing; refusing to proceed without independent confirmation that the ${sessionId} attempt was never made`,
      { sessionId, roundId, evidenceRelativePath: match.evidenceRelativePath }
    );
  }
  throw stop(
    'STOP_HISTORICAL_ATTEMPT_CONSUMED',
    `${sessionId} (${match.roundId} ${match.role}) already consumed its one provider-transport attempt under ${match.consumedBy} (${match.stopCode}); historical evidence preserved at ${match.evidenceRelativePath}. A future GPT-reviewed recovery protocol must define a separate execution identity rather than redispatching this session.`,
    { sessionId, roundId, evidenceRelativePath: match.evidenceRelativePath, consumedBy: match.consumedBy, priorStopCode: match.stopCode }
  );
}

/**
 * The complete set of options `dispatchLiveDuplicateAudit` accepts. Anything
 * else -- most pointedly `corpusTasks`, `auditScopeIds`, `maxOutputTokens`,
 * `thinkingLevel`, `temperature` -- is rejected outright (§B, §E): DUP-R00's
 * corpus, scope, and generation envelope are bound internally from the
 * canonical evidence and the frozen envelope table, never from a caller.
 */
const ALLOWED_DISPATCH_OPTION_KEYS = Object.freeze(['liveExecution', 'authorizedBaseSha', 'roundId', 'stage']);

/**
 * Explicit real entrypoint, hardened by CWP-12C. Requires `liveExecution:
 * true` and a valid `authorizedBaseSha`; a caller lacking either gets
 * STOP_LIVE_FLAG_REQUIRED / STOP_AUTHORIZED_BASE_REQUIRED before anything
 * else runs. CWP-12D-2 called this function once, real, with `stage:
 * 'D1D2'`: D1 reserved, entered transport, and STOPped
 * (STOP_PROVIDER_ERROR) before any provider response; D2 was never
 * attempted. DUP-R00 remains INCOMPLETE / FAILED CLOSED (0/1770 pair
 * judgments) -- this offline conformance suite still never calls this
 * function with `liveExecution: true`.
 *
 * Six layers of binding, each fail-closed before any provider transport:
 *
 *   0. historical-attempt guard -- `assertNoHistoricalAttemptConflict`
 *                            (CWP-12D-2R) STOPs before D1 if the session
 *                            about to be dispatched already consumed its
 *                            one attempt under prior historical evidence.
 *   1. option allow-list  -- no corpus/scope/envelope override is even
 *                            reachable; an unexpected key STOPs immediately.
 *   2. roundId === DUP-R00 -- exactly, not merely DUP-R\d\d (§D); DUP-R01+
 *                            requires a future, separately GPT-reviewed
 *                            amendment (replacement rounds have different
 *                            canonical population/provenance inputs).
 *   3. stage === D1D2      -- this entrypoint dispatches D1/D2 only; a D3
 *                            request STOPs rather than running, and D1/D2
 *                            never auto-chains into D3 (§G). D3 remains a
 *                            separately authorized future stage, after GPT
 *                            inspects the D1/D2 results and disagreement set.
 *   4. canonical corpus     -- `loadCanonicalDupR00Corpus()`'s ten-point
 *                            mechanical check (§A) against the real
 *                            committed authoring/structural-review evidence.
 *   5. scope invariant      -- `assertDupR00ScopeInvariant` re-verifies
 *                            corpus=60/scope=60/scope==corpus/pairs=1770
 *                            in depth, even though construction (auditScopeIds
 *                            := corpusTaskIds) already guarantees it (§B).
 *
 * The generation envelope (§E) is looked up per-provider from
 * `DUP_R00_GENERATION_ENVELOPES` inside `executeDuplicateAuditSession` via
 * the injected `envelopeForProvider` closure below -- never a value this
 * function receives from a caller and passes through.
 */
export async function dispatchLiveDuplicateAudit(options = {}) {
  const suppliedKeys = Object.keys(options);
  const forbiddenKeys = suppliedKeys.filter((key) => !ALLOWED_DISPATCH_OPTION_KEYS.includes(key));
  if (forbiddenKeys.length > 0) {
    throw stop(
      'STOP_UNAUTHORIZED_OVERRIDE',
      `dispatchLiveDuplicateAudit does not accept operator-supplied ${JSON.stringify(forbiddenKeys)}; ` +
      'DUP-R00 corpus, scope, and generation envelope are bound internally and cannot be overridden',
      { forbiddenKeys }
    );
  }
  const { liveExecution, authorizedBaseSha, roundId, stage = D1D2_STAGE } = options;
  if (liveExecution !== true) {
    throw stop('STOP_LIVE_FLAG_REQUIRED', 'LIVE dispatch is not authorized without liveExecution: true');
  }
  if (!/^[0-9a-f]{40}$/.test(authorizedBaseSha ?? '')) {
    throw stop('STOP_AUTHORIZED_BASE_REQUIRED', 'authorizedBaseSha must be an explicit full lowercase commit SHA');
  }
  if (!ROUND_ID_PATTERN.test(roundId ?? '')) {
    throw stop('STOP_ROUND_INVALID', `roundId must match DUP-R\\d\\d, got ${JSON.stringify(roundId)}`);
  }
  if (roundId !== DUP_R00_ROUND_ID) {
    throw stop(
      'STOP_ROUND_NOT_LIVE_READY',
      `this LIVE entrypoint is authorized to understand only ${DUP_R00_ROUND_ID}; ${JSON.stringify(roundId)} requires its own future GPT-reviewed amendment (replacement rounds have different canonical population/provenance inputs)`
    );
  }
  if (stage !== D1D2_STAGE) {
    throw stop(
      'STOP_STAGE_NOT_LIVE_READY',
      `this LIVE entrypoint dispatches ${D1D2_STAGE} only for ${DUP_R00_ROUND_ID}; D3 is a separately authorized future stage and is never auto-chained after D1/D2`
    );
  }
  assertNoHistoricalAttemptConflict({ roundId, sessionId: `${roundId}-D1` });

  const credentials = {
    claude: process.env.ANTHROPIC_API_KEY ?? '',
    gemini: process.env.GEMINI_API_KEY ?? '',
  };
  requireCredential('claude', credentials);
  requireCredential('gemini', credentials);
  const transport = createRealProviderTransport(credentials);
  const revalidate = createLiveRevalidator({ authorizedBaseSha, roundId });
  const { absolute: artifactDir } = liveArtifactPaths(roundId);

  let canonicalCorpus;
  try {
    canonicalCorpus = loadCanonicalDupR00Corpus();
  } catch (error) {
    throw stop(error?.code ?? 'STOP_CORPUS_BINDING_INVALID', String(error?.message ?? error));
  }
  const auditScopeIds = canonicalCorpus.corpusTaskIds;
  const pairUniverse = computePairUniverse({ corpusTaskIds: canonicalCorpus.corpusTaskIds, auditScopeIds });
  try {
    assertDupR00ScopeInvariant({ corpusTaskIds: canonicalCorpus.corpusTaskIds, auditScopeIds, pairUniverse });
  } catch (error) {
    throw stop(error?.code ?? 'STOP_SCOPE_INVALID', String(error?.message ?? error));
  }

  const envelopeForProvider = (provider) => dupR00EnvelopeFor(provider);

  return runD1D2Stage({
    authorizedBaseSha,
    roundId,
    corpusTasks: canonicalCorpus.corpusTasks,
    auditScopeIds,
    artifactDir,
    transport,
    credentials,
    revalidate,
    envelopeForProvider,
  });
}
