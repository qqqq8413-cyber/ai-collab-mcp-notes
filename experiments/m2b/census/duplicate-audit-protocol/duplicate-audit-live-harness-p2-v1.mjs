/**
 * CBRP-DUPLICATE-AUDIT-LIVE-HARNESS-P2-1
 *
 * The real LIVE entrypoint for CBRP-CORPUS-DUPLICATE-AUDIT-PROTOCOL-2
 * (`CBRP_CORPUS_DUPLICATE_AUDIT_PROTOCOL_2.md`). This module does not fork
 * or re-implement the session-execution engine, the artifact store, the
 * real provider transport, or the Claude non-streaming timeout repair --
 * it imports and reuses `duplicate-audit-live-harness-v1.mjs`'s
 * `createArtifactStore`, `executeDuplicateAuditSession`, `runD1D2Stage`,
 * `createRealProviderTransport`, and `computeClaudeNonstreamingTimeoutMillis`
 * directly (CWP-12F §A: "reuse the existing verified pure mechanisms
 * wherever possible ... prefer composition over copy-paste"). It likewise
 * reuses `duplicate-audit-runner.mjs`'s `computeD1D2SessionPlan` and
 * `dupR00EnvelopeFor`, and `duplicate-audit-corpus-binding-v1.mjs`'s
 * `loadCanonicalDupR00Corpus`/`assertDupR00ScopeInvariant` unchanged --
 * Protocol-2's corpus is required to be exactly Protocol-1's intended
 * canonical DUP-R00 corpus (CWP-12F §E), so there is nothing to
 * reimplement there either.
 *
 * What this module owns, and only this: Protocol-2's own identity
 * (`PROTOCOL_2_VERSION`, `DUP_P2_R00_ROUND_ID`), its own round-ID pattern
 * and artifact-namespace mapping (`duplicate-audit-p2-round-NN/`, never
 * Protocol-1's `duplicate-audit-round-0/` or `duplicate-audit-round-00/`),
 * its own source-drift manifest (binding Protocol-2's own spec, Protocol-1
 * as baseline, every shared pure/implementation module Protocol-2 reuses,
 * the three canonical evidence files, and the model-pins prereg source),
 * and the hardened real entrypoint `dispatchLiveDuplicateAuditP2()`.
 *
 * Importing this module may bootstrap environment configuration (`.env`,
 * via `dotenv/config`) but performs no provider call and creates no
 * research evidence. Protocol-1's own real entrypoint
 * (`dispatchLiveDuplicateAudit`) and its `STOP_HISTORICAL_ATTEMPT_CONSUMED`
 * guard are untouched by this module and remain exactly as CWP-12D-2R left
 * them -- Protocol-1's DUP-R00 stays FAILED CLOSED / TERMINAL and
 * unresumable (`CBRP_CORPUS_DUPLICATE_AUDIT_PROTOCOL_2.md` §2).
 *
 * CWP-12F: implemented and offline-verified only. Protocol-2 has not run
 * and this module makes zero provider calls when imported or exercised by
 * the offline conformance suite -- every test injects a fake `transport`.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  HARNESS_VERSION,
  EXPECTED_RUNTIME,
  DuplicateAuditStop,
  createArtifactStore,
  executeDuplicateAuditSession,
  runD1D2Stage,
  createRealProviderTransport,
  git,
  workingTreePaths,
  readPackageVersion,
} from './duplicate-audit-live-harness-v1.mjs';
import {
  PROTOCOL_VERSION as PROTOCOL_1_VERSION,
  D1_PIN,
  D2_PIN,
  dupR00EnvelopeFor,
} from './duplicate-audit-runner.mjs';
import {
  EXPECTED_LAYER_A_BYTE_COUNT,
  EXPECTED_LAYER_A_SHA256,
  loadFrozenLayerABytes,
} from './duplicate-audit-prompt-v1.mjs';
import { computePairUniverse } from './duplicate-audit-order-v1.mjs';
import {
  loadCanonicalDupR00Corpus,
  assertDupR00ScopeInvariant,
} from './duplicate-audit-corpus-binding-v1.mjs';

export const PROTOCOL_2_VERSION = 'CBRP-CORPUS-DUPLICATE-AUDIT-PROTOCOL-2';
/** Same execution engine as Protocol-1 -- reused, not forked (see module doc above). */
export const P2_HARNESS_VERSION = HARNESS_VERSION;
export const D1D2_STAGE = 'D1D2';
export const D3_STAGE = 'D3';
export const DUP_P2_R00_ROUND_ID = 'DUP-P2-R00';
/** `CBRP_CORPUS_DUPLICATE_AUDIT_PROTOCOL_2.md` §8's explicit attempt boundary. */
export const P2_ATTEMPT_BOUNDARY_VERSION = 'CBRP-DUPLICATE-AUDIT-PROTOCOL-2-ATTEMPT-BOUNDARY-1';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(DIR, '../../../..');
const CENSUS_DIR = path.resolve(DIR, '..');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const nowIso = () => new Date().toISOString();

function stop(code, message, details) {
  return new DuplicateAuditStop(code, message, details);
}

function requireCredential(provider, credentials) {
  if (typeof credentials?.[provider] !== 'string' || !credentials[provider]) {
    throw stop('STOP_CREDENTIAL_MISSING', `required ${provider} credential is missing`);
  }
}

/** `DUP-P2-R00` -> `DUP-P2-R01` -> ... ; never `DUP-R00`/`DUP-R\d\d` (Protocol-1's own pattern). */
export const P2_ROUND_ID_PATTERN = /^DUP-P2-R(\d{2})$/;

/**
 * Pure, testable extraction of a Protocol-2 round ID's two-digit suffix, via
 * the same capture-group technique `dupRoundSuffix` (CWP-12D-2R) uses for
 * Protocol-1 -- never a hardcoded string index, so validation and namespace
 * derivation are mechanically incapable of disagreeing.
 */
export function dupP2RoundSuffix(roundId) {
  const match = P2_ROUND_ID_PATTERN.exec(roundId ?? '');
  if (!match) {
    throw stop('STOP_ROUND_INVALID', `unrecognized Protocol-2 roundId ${JSON.stringify(roundId)}`);
  }
  return match[1];
}

/**
 * `DUP-P2-R00` -> `experiments/m2b/census/duplicate-audit-p2-round-00/`.
 * Structurally incapable of colliding with either of Protocol-1's
 * namespaces: `duplicate-audit-round-0/` (immutable historical DUP-R00
 * failure evidence) and `duplicate-audit-round-00/` (Protocol-1's
 * permanently retired, never-reused intended namespace) both begin with a
 * different literal prefix (`duplicate-audit-round-`, not
 * `duplicate-audit-p2-round-`) than anything this function can produce.
 */
export function liveArtifactPathsP2(roundId) {
  const dirName = `duplicate-audit-p2-round-${dupP2RoundSuffix(roundId)}`;
  const absolute = path.join(CENSUS_DIR, dirName);
  return { absolute, relative: path.relative(REPO_ROOT, absolute) + '/' };
}

/**
 * Every frozen upstream file a Protocol-2 LIVE dispatch depends on for
 * correctness (CWP-12F §K): Protocol-2's own spec, Protocol-1 as its frozen
 * baseline, every shared pure module Protocol-2 reuses unmodified (prompt,
 * order, extractor, decision), every shared *implementation* module
 * Protocol-2 reuses as its execution engine (corpus-binding, runner, and
 * the Protocol-1 live harness itself -- CWP-12F §K: "If a shared Protocol-1
 * implementation module is reused, bind its source hash too"), the three
 * canonical DUP-R00 evidence files, and the model-pins prereg source. This
 * module's own file is deliberately NOT self-referenced here, matching
 * Protocol-1's and structural review's own convention.
 */
const P2_SOURCE_HASHES = Object.freeze({
  'experiments/m2b/census/CBRP_CORPUS_DUPLICATE_AUDIT_PROTOCOL_2.md': '0111b1c5a7b701c3c650c97efc835f0b49414897e7681a8340f80fa4d1b5a5f3',
  'experiments/m2b/census/CBRP_CORPUS_DUPLICATE_AUDIT_PROTOCOL_1.md': 'cbac540b7214afcf6e6352fb81dd8bda68171707eed0ac5197ac9555e8c64555',
  'experiments/m2b/census/CBRP_MODEL_PINS_PREREG_DRAFT.md': '141432c59640e6d69d7a8cfee58a39c9c9817685c4bf5efa26c6a0e7a5ce9bbd',
  'experiments/m2b/census/duplicate-audit-protocol/duplicate-audit-prompt-v1.mjs': 'a5abab6b0e20d0234c44c985224a1b8953473826abd34bf96aa71be0fa88debd',
  'experiments/m2b/census/duplicate-audit-protocol/duplicate-audit-order-v1.mjs': 'dd25109b8571e42f5f51d222bd6fec03eeb441dac9b500364c19df923fb52772',
  'experiments/m2b/census/duplicate-audit-protocol/duplicate-audit-extractor-v1.mjs': '78aee59362768e5ee36fe56952184de6eca505ad8e52f7c405f101d84d1a5eeb',
  'experiments/m2b/census/duplicate-audit-protocol/duplicate-audit-decision-v1.mjs': '16fb3e3b2cb3c7888350402675e88de180fa82577693d1db24cb91948b4e6d03',
  'experiments/m2b/census/duplicate-audit-protocol/duplicate-audit-corpus-binding-v1.mjs': '6939f6a07fb5d08f715b97de108cc1c85b39e33581eeb13c5c67a9086827eef5',
  'experiments/m2b/census/duplicate-audit-protocol/duplicate-audit-runner.mjs': 'e858703c1824e0beacad7bc92708201f8586ab86c5a11274744fbd09ca7c1afa',
  'experiments/m2b/census/duplicate-audit-protocol/duplicate-audit-live-harness-v1.mjs': '2fb644d43e791f8a61bb791f3a236f149c354906e88d60dc618effbe040e4d19',
  'experiments/m2b/census/authoring-v2p1-round-0/CANDIDATES.json': '05bb612aa85c95fdcc9e4dbf077ebc50b2977e0fe41df8179c127e2d9dc98368',
  'experiments/m2b/census/structural-review-round-2/FINAL_DECISIONS.json': '1fbd7bab3a64a1750a4d571653b5299ed87242a4b72a5ac53b3c1c3e07878402',
  'experiments/m2b/census/structural-review-round-2/VALIDATION.json': '5fc03db72f7a67843b6797f80da3cddae56f4fc04b0ba9694eea2ecff35c6f42',
});

/** Node/package-lock/provider-SDK expectations are repository-wide facts, not protocol-specific -- reused directly from Protocol-1's `EXPECTED_RUNTIME` rather than re-typed. */
export const P2_EXPECTED_RUNTIME = Object.freeze({
  nodeVersion: EXPECTED_RUNTIME.nodeVersion,
  packageLockSha256: EXPECTED_RUNTIME.packageLockSha256,
  anthropicSdkVersion: EXPECTED_RUNTIME.anthropicSdkVersion,
  geminiSdkVersion: EXPECTED_RUNTIME.geminiSdkVersion,
  sourceHashes: P2_SOURCE_HASHES,
});

/** Protocol-2 analogue of `captureRuntimeSnapshot`, bound to `P2_SOURCE_HASHES`/`liveArtifactPathsP2`. */
export function captureRuntimeSnapshotP2(roundId = DUP_P2_R00_ROUND_ID) {
  const layerA = loadFrozenLayerABytes();
  const sourceHashes = Object.fromEntries(
    Object.keys(P2_SOURCE_HASHES).map((relative) => [
      relative,
      sha256(fs.readFileSync(path.join(REPO_ROOT, relative))),
    ])
  );
  const driftPaths = workingTreePaths();
  const { relative: liveArtifactRelative } = liveArtifactPathsP2(roundId);
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

/** Protocol-2 analogue of `assertRuntimeSnapshot`, pure, fail-closed. */
export function assertRuntimeSnapshotP2(snapshot, { authorizedBaseSha }) {
  if (!/^[0-9a-f]{40}$/.test(authorizedBaseSha ?? '')) {
    throw stop('STOP_AUTHORIZED_BASE_REQUIRED', 'authorizedBaseSha must be an explicit full lowercase commit SHA');
  }
  if (snapshot.head !== authorizedBaseSha) {
    throw stop('STOP_BASE_SHA_MISMATCH', `HEAD ${snapshot.head} != authorized ${authorizedBaseSha}`);
  }
  if (snapshot.nodeVersion !== P2_EXPECTED_RUNTIME.nodeVersion) {
    throw stop('STOP_RUNTIME_DRIFT', `Node ${snapshot.nodeVersion} != ${P2_EXPECTED_RUNTIME.nodeVersion}`);
  }
  if (snapshot.packageLockSha256 !== P2_EXPECTED_RUNTIME.packageLockSha256) {
    throw stop('STOP_SOURCE_DRIFT', 'package-lock hash mismatch');
  }
  if (snapshot.anthropicSdkVersion !== P2_EXPECTED_RUNTIME.anthropicSdkVersion
      || snapshot.geminiSdkVersion !== P2_EXPECTED_RUNTIME.geminiSdkVersion) {
    throw stop('STOP_RUNTIME_DRIFT', 'installed provider SDK version mismatch');
  }
  if (snapshot.layerABytes !== EXPECTED_LAYER_A_BYTE_COUNT
      || snapshot.layerASha256 !== EXPECTED_LAYER_A_SHA256) {
    throw stop('STOP_RUBRIC_DRIFT', 'frozen Layer A bytes/hash mismatch');
  }
  for (const [relative, expected] of Object.entries(P2_SOURCE_HASHES)) {
    if (snapshot.sourceHashes?.[relative] !== expected) {
      throw stop('STOP_SOURCE_DRIFT', `${relative} hash mismatch`);
    }
  }
  if ((snapshot.unexpectedWorkingTreePaths ?? []).length > 0) {
    throw stop('STOP_WORKTREE_DRIFT', 'working-tree drift exists outside the authorized Protocol-2 LIVE artifact namespace', {
      paths: snapshot.unexpectedWorkingTreePaths,
    });
  }
  return snapshot;
}

export function createLiveRevalidatorP2({ authorizedBaseSha, roundId = DUP_P2_R00_ROUND_ID }) {
  return async () => assertRuntimeSnapshotP2(captureRuntimeSnapshotP2(roundId), { authorizedBaseSha });
}

/**
 * The complete set of options `dispatchLiveDuplicateAuditP2` accepts.
 * Anything else -- `corpusTasks`, `auditScopeIds`, `maxOutputTokens`,
 * `thinkingLevel`, `temperature`, `provider`, `model`, `artifactDir` most
 * pointedly -- is rejected outright: Protocol-2's corpus, scope, generation
 * envelope, and artifact namespace are bound internally, never from a
 * caller (mirrors Protocol-1's `dispatchLiveDuplicateAudit` exactly).
 */
const ALLOWED_DISPATCH_OPTION_KEYS = Object.freeze(['liveExecution', 'authorizedBaseSha', 'roundId', 'stage']);

/**
 * Explicit real entrypoint for Protocol-2. Requires `liveExecution: true`
 * and a valid `authorizedBaseSha`; a caller lacking either gets
 * STOP_LIVE_FLAG_REQUIRED / STOP_AUTHORIZED_BASE_REQUIRED before anything
 * else runs. This function has never been called with `liveExecution: true`
 * -- Protocol-2 has not executed, and this offline conformance suite never
 * calls it that way either.
 *
 * Layers of binding, each fail-closed before any provider transport:
 *
 *   1. option allow-list    -- no corpus/scope/envelope/namespace override
 *                             is even reachable.
 *   2. roundId === DUP-P2-R00 -- exactly; DUP-R00 (Protocol-1's own round,
 *                             permanently closed) is rejected by
 *                             `P2_ROUND_ID_PATTERN` not even matching it;
 *                             DUP-P2-R01+ requires its own future,
 *                             separately GPT-reviewed amendment.
 *   3. stage === D1D2       -- this entrypoint dispatches D1/D2 only; D3
 *                             remains a separately authorized future stage
 *                             and is never auto-chained after D1/D2.
 *   4. canonical corpus     -- `loadCanonicalDupR00Corpus()`, REUSED
 *                             unchanged from Protocol-1 (CWP-12F §E:
 *                             Protocol-2's corpus must be exactly
 *                             Protocol-1's intended canonical DUP-R00
 *                             corpus).
 *   5. scope invariant      -- `assertDupR00ScopeInvariant`, likewise
 *                             reused unchanged.
 *
 * The generation envelope is looked up per-provider from the same frozen
 * `DUP_R00_GENERATION_ENVELOPES` table Protocol-1 uses (via `dupR00EnvelopeFor`,
 * imported and reused, not re-declared) -- CWP-12F §F requires the exact
 * same values, and reusing the same lookup function is what makes a
 * caller-supplied override impossible by construction rather than merely by
 * convention. D1/D2 model-visible prompt bytes are produced by the same
 * `runD1D2Stage` -> `computeD1D2SessionPlan` -> `buildD1D2Prompt` chain
 * Protocol-1 uses, unmodified, against the identical corpus -- so they are
 * byte-identical to Protocol-1's by construction, not merely by requirement
 * (CWP-12F §D; see the direct byte-comparison regression in
 * `test-duplicate-audit-live-harness-p2.mjs`).
 */
export async function dispatchLiveDuplicateAuditP2(options = {}) {
  const suppliedKeys = Object.keys(options);
  const forbiddenKeys = suppliedKeys.filter((key) => !ALLOWED_DISPATCH_OPTION_KEYS.includes(key));
  if (forbiddenKeys.length > 0) {
    throw stop(
      'STOP_UNAUTHORIZED_OVERRIDE',
      `dispatchLiveDuplicateAuditP2 does not accept operator-supplied ${JSON.stringify(forbiddenKeys)}; ` +
      'Protocol-2 corpus, scope, generation envelope, and artifact namespace are bound internally and cannot be overridden',
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
  if (!P2_ROUND_ID_PATTERN.test(roundId ?? '')) {
    throw stop('STOP_ROUND_INVALID', `roundId must match DUP-P2-R\\d\\d, got ${JSON.stringify(roundId)}`);
  }
  if (roundId !== DUP_P2_R00_ROUND_ID) {
    throw stop(
      'STOP_ROUND_NOT_LIVE_READY',
      `this Protocol-2 LIVE entrypoint is authorized to understand only ${DUP_P2_R00_ROUND_ID}; ${JSON.stringify(roundId)} requires its own future GPT-reviewed amendment`
    );
  }
  if (stage !== D1D2_STAGE) {
    throw stop(
      'STOP_STAGE_NOT_LIVE_READY',
      `this Protocol-2 LIVE entrypoint dispatches ${D1D2_STAGE} only for ${DUP_P2_R00_ROUND_ID}; D3 is a separately authorized future stage and is never auto-chained after D1/D2`
    );
  }

  const credentials = {
    claude: process.env.ANTHROPIC_API_KEY ?? '',
    gemini: process.env.GEMINI_API_KEY ?? '',
  };
  requireCredential('claude', credentials);
  requireCredential('gemini', credentials);
  const transport = createRealProviderTransport(credentials);
  const revalidate = createLiveRevalidatorP2({ authorizedBaseSha, roundId });
  const { absolute: artifactDir } = liveArtifactPathsP2(roundId);

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
    protocolVersion: PROTOCOL_2_VERSION,
    roundIdPattern: P2_ROUND_ID_PATTERN,
  });
}

export { D1_PIN, D2_PIN, createArtifactStore, executeDuplicateAuditSession, DuplicateAuditStop, PROTOCOL_1_VERSION };
