/**
 * CBRP-DUPLICATE-AUDIT-DUP-R00-PRELIVE-MANIFEST-1
 *
 * Assembles the deterministic OFFLINE DUP-R00 pre-live manifest (CWP-12C
 * §F): a snapshot of everything a real DUP-R00 D1/D2 dispatch would use --
 * the canonical corpus binding, the exact D1/D2 prompt bytes, the frozen
 * generation envelope, and the expected call budget -- computed entirely
 * from already-committed evidence and frozen constants. No provider call.
 *
 * This is PRE-LIVE evidence, not a duplicate-audit round result: it is not
 * written into a `duplicate-audit-round-NN` namespace, carries no session
 * IDs or reservations, and `buildDupR00PreflightManifest()` is a pure
 * function of the repository's current committed state -- calling it twice
 * against the same evidence produces byte-identical JSON.
 */
import crypto from 'node:crypto';

import {
  CANONICAL_AUTHORING_PATH,
  CANONICAL_FINAL_DECISIONS_PATH,
  CANONICAL_VALIDATION_PATH,
  loadCanonicalDupR00Corpus,
  assertDupR00ScopeInvariant,
} from './duplicate-audit-corpus-binding-v1.mjs';
import { computePairUniverse, pairUniverseHash } from './duplicate-audit-order-v1.mjs';
import {
  D1D2_WRAPPER_VERSION,
  EXPECTED_LAYER_A_BYTE_COUNT,
  EXPECTED_LAYER_A_SHA256,
  loadFrozenLayerABytes,
  buildD1D2Prompt,
} from './duplicate-audit-prompt-v1.mjs';
import { D3_VERSION } from './duplicate-audit-decision-v1.mjs';
import {
  PROTOCOL_VERSION,
  D1_PIN,
  D2_PIN,
  CALL_BUDGET,
  DUP_R00_GENERATION_ENVELOPES,
  DUP_R00_GENERATION_ENVELOPE_VERSION,
} from './duplicate-audit-runner.mjs';
import { HARNESS_VERSION, DUP_R00_ROUND_ID } from './duplicate-audit-live-harness-v1.mjs';

export const PREFLIGHT_VERSION = 'CBRP-DUPLICATE-AUDIT-DUP-R00-PRELIVE-MANIFEST-1';

const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * Builds the complete pre-live manifest from the real committed evidence.
 * Throws (does not fail closed silently) on any corpus-binding or
 * scope-invariant violation -- exactly as a real LIVE dispatch would STOP
 * before ever reaching a provider.
 */
export function buildDupR00PreflightManifest() {
  const canonicalCorpus = loadCanonicalDupR00Corpus();
  const auditScopeIds = canonicalCorpus.corpusTaskIds;
  const pairUniverse = computePairUniverse({ corpusTaskIds: canonicalCorpus.corpusTaskIds, auditScopeIds });
  assertDupR00ScopeInvariant({ corpusTaskIds: canonicalCorpus.corpusTaskIds, auditScopeIds, pairUniverse });

  const layerABytes = loadFrozenLayerABytes();
  const prompt = buildD1D2Prompt({ corpusTasks: canonicalCorpus.corpusTasks, auditScopeIds, layerABytes });

  return {
    preflightVersion: PREFLIGHT_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    harnessVersion: HARNESS_VERSION,
    roundId: DUP_R00_ROUND_ID,
    canonicalSources: {
      authoring: { path: CANONICAL_AUTHORING_PATH, sha256: canonicalCorpus.sourceHashes[CANONICAL_AUTHORING_PATH] },
      structuralFinalDecisions: { path: CANONICAL_FINAL_DECISIONS_PATH, sha256: canonicalCorpus.sourceHashes[CANONICAL_FINAL_DECISIONS_PATH] },
      structuralValidation: { path: CANONICAL_VALIDATION_PATH, sha256: canonicalCorpus.sourceHashes[CANONICAL_VALIDATION_PATH] },
    },
    candidateCount: canonicalCorpus.corpusTaskIds.length,
    candidateIdListHash: sha256(JSON.stringify(canonicalCorpus.corpusTaskIds)),
    corpusTaskTextBindingHash: sha256(JSON.stringify(canonicalCorpus.corpusTasks)),
    scopeCount: auditScopeIds.length,
    auditScopeIdsHash: sha256(JSON.stringify(auditScopeIds)),
    pairUniverseCount: pairUniverse.length,
    pairUniverseHash: pairUniverseHash(pairUniverse),
    layerA: { bytes: EXPECTED_LAYER_A_BYTE_COUNT, sha256: EXPECTED_LAYER_A_SHA256 },
    d1d2WrapperVersion: D1D2_WRAPPER_VERSION,
    d1d2Prompt: { bytes: prompt.promptBytes, sha256: prompt.promptSha256 },
    d1: { provider: D1_PIN.provider, model: D1_PIN.model },
    d2: { provider: D2_PIN.provider, model: D2_PIN.model },
    generationEnvelopeVersion: DUP_R00_GENERATION_ENVELOPE_VERSION,
    generationEnvelope: DUP_R00_GENERATION_ENVELOPES,
    d3RoutingVersion: D3_VERSION,
    expectedMandatoryInitialCalls: CALL_BUDGET.mandatoryD1D2PerRound,
    d3Calls: 'UNKNOWN_UNTIL_D1D2_COMPLETE',
    providerCallsPerformed: 0,
  };
}
