/**
 * CBRP-DUPLICATE-AUDIT-P2-R00-PRELIVE-MANIFEST-1
 *
 * Assembles the deterministic OFFLINE Protocol-2 Round 0 pre-live manifest
 * (CWP-12F §L): a snapshot of everything a real Protocol-2 D1/D2 dispatch
 * would use -- the canonical corpus binding (reused unchanged from
 * Protocol-1, CWP-12F §E), the exact D1/D2 prompt bytes (byte-identical to
 * Protocol-1's by construction, CWP-12F §D), and the frozen generation
 * envelope (reused unchanged from Protocol-1, CWP-12F §F) -- computed
 * entirely from already-committed evidence and frozen constants. No
 * provider call.
 *
 * Mirrors `duplicate-audit-preflight-v1.mjs`'s shape and construction
 * exactly, differing only in which protocol/round identity it stamps and
 * which canonical evidence sources it inherits from a reused, not forked,
 * corpus binding. This is PRE-LIVE evidence, not a duplicate-audit round
 * result: it is not written into a `duplicate-audit-p2-round-NN` namespace,
 * carries no session reservations, and `buildP2R00PreflightManifest()` is a
 * pure function of the repository's current committed state -- calling it
 * twice against the same evidence produces byte-identical JSON.
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
import { CALL_BUDGET, DUP_R00_GENERATION_ENVELOPES, DUP_R00_GENERATION_ENVELOPE_VERSION } from './duplicate-audit-runner.mjs';
import {
  PROTOCOL_2_VERSION,
  PROTOCOL_1_VERSION,
  P2_HARNESS_VERSION,
  P2_ATTEMPT_BOUNDARY_VERSION,
  DUP_P2_R00_ROUND_ID,
} from './duplicate-audit-live-harness-p2-v1.mjs';

export const P2_PREFLIGHT_VERSION = 'CBRP-DUPLICATE-AUDIT-P2-R00-PRELIVE-MANIFEST-1';

const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * Builds the complete Protocol-2 Round 0 pre-live manifest from the real
 * committed evidence. Throws (does not fail closed silently) on any
 * corpus-binding or scope-invariant violation -- exactly as a real
 * Protocol-2 LIVE dispatch would STOP before ever reaching a provider.
 */
export function buildP2R00PreflightManifest() {
  const canonicalCorpus = loadCanonicalDupR00Corpus();
  const auditScopeIds = canonicalCorpus.corpusTaskIds;
  const pairUniverse = computePairUniverse({ corpusTaskIds: canonicalCorpus.corpusTaskIds, auditScopeIds });
  assertDupR00ScopeInvariant({ corpusTaskIds: canonicalCorpus.corpusTaskIds, auditScopeIds, pairUniverse });

  const layerABytes = loadFrozenLayerABytes();
  const prompt = buildD1D2Prompt({ corpusTasks: canonicalCorpus.corpusTasks, auditScopeIds, layerABytes });

  return {
    preflightVersion: P2_PREFLIGHT_VERSION,
    protocolVersion: PROTOCOL_2_VERSION,
    baselineProtocolVersion: PROTOCOL_1_VERSION,
    harnessVersion: P2_HARNESS_VERSION,
    roundId: DUP_P2_R00_ROUND_ID,
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
    d1: {
      sessionId: `${DUP_P2_R00_ROUND_ID}-D1`,
      provider: DUP_R00_GENERATION_ENVELOPES.claude.provider,
      model: DUP_R00_GENERATION_ENVELOPES.claude.model,
      envelope: DUP_R00_GENERATION_ENVELOPES.claude,
    },
    d2: {
      sessionId: `${DUP_P2_R00_ROUND_ID}-D2`,
      provider: DUP_R00_GENERATION_ENVELOPES.gemini.provider,
      model: DUP_R00_GENERATION_ENVELOPES.gemini.model,
      envelope: DUP_R00_GENERATION_ENVELOPES.gemini,
    },
    generationEnvelopeVersion: DUP_R00_GENERATION_ENVELOPE_VERSION,
    d3RoutingVersion: D3_VERSION,
    artifactNamespace: 'experiments/m2b/census/duplicate-audit-p2-round-00/',
    attemptPolicyVersion: P2_ATTEMPT_BOUNDARY_VERSION,
    expectedMandatoryInitialCalls: CALL_BUDGET.mandatoryD1D2PerRound,
    d3Calls: 'UNKNOWN_UNTIL_D1D2_COMPLETE',
    providerCallsPerformed: 0,
  };
}
