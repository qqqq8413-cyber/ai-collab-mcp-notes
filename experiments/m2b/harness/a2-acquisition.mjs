/**
 * Real-capture -> clean-room A2 acquisition packet builder, validator and slot resolver.
 *
 * ## Why this is a separate module from `cleanroom.mjs`
 *
 * `cleanroom.mjs` is the legacy synthetic path: it hardcodes `fx-03/fx-01/fx-04/fx-02`,
 * reads only `experiments/m2b/fixtures/`, and its scanner treats the word `archetype` as
 * a leak. Protocol 0.3 changed both ends of that. Acquisition annotates *real* captures,
 * and A2 is now explicitly allowed to see the formal output schema — which necessarily
 * contains `conflictArchetype` and its enum. Bending the legacy scanner to fit would
 * weaken the guard that still protects the historical evidence, so this is a new path and
 * the legacy one is left exactly as it was.
 *
 * ## Why every rule here is executable before Wave 1 runs
 *
 * Each decision below — who is admitted, what order they appear in, what A2 may see, what
 * a valid annotation looks like, when a slot is filled — is a decision that would be
 * contaminated if it were made after reading Round 1 output. Ordering is the clearest
 * case: any rule chosen once the outputs are visible can be chosen, consciously or not,
 * to put the convenient case first. So ordering is a pure function of the frozen task
 * bytes, fixed here, before there is anything to look at.
 *
 * Nothing in this module calls a provider, and nothing in it authorizes a call.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { segmentAll } from '../../../dist/agents/collaboration.js';
import {
  ARCHETYPE_SLOTS, NEGATIVE_CONTROL, PROTOCOL_VERSION, fillsArchetypeSlot,
} from '../protocol/amendment-0-3.mjs';

const sha256 = (v) => createHash('sha256').update(v).digest('hex');
const canonical = (v) => JSON.stringify(v, null, 2);

/** One logical annotator across every acquisition wave. Never A3, never one per wave. */
export const A2_SESSION_ID = 'A2-ACQUISITION-1';

/** Frozen before any Round 1 output exists. See the module header. */
export const ORDERING_RULE = 'task-sha256-lexical-ascending';

export const CONFLICT_ARCHETYPES = Object.freeze([
  'STRATEGY', 'EXECUTION_CONSTRAINT', 'EVIDENCE_INTERPRETATION', 'OTHER',
]);

/** `OTHER` is a real material-conflict class. It just never closes a preregistered slot. */
export const SLOT_FILLING_ARCHETYPES = Object.freeze(Object.keys(ARCHETYPE_SLOTS));

export const NEGATIVE_CONTROL_FIXTURE_ID = NEGATIVE_CONTROL.fixtureId;

/** fxr-08 already exists, captured under protocol 0.2. It is read, never re-run. */
export const NEGATIVE_CONTROL_CAPTURE_DIR = fileURLToPath(
  new URL(`../fixtures-real-r2/${NEGATIVE_CONTROL.fixtureId}/`, import.meta.url),
);

/**
 * The two capture shapes production can seal.
 *
 * A capture that died before Round 1 existed is legal one-shot evidence, not a broken
 * file: the planning call failed, the attempt is spent, and it may not be retried. It has
 * no snapshot and no report because there was never a round to snapshot.
 */
export const ROUND1_PRESENT = 'ROUND1_PRESENT';
export const PRE_ROUND1_FATAL = 'PRE_ROUND1_FATAL';

export const NO_A2_BATCH = 'NO_A2_BATCH';
export const A2_BATCH = 'A2_BATCH';
export const NO_F4_ELIGIBLE_CANDIDATES = 'NO_F4_ELIGIBLE_CANDIDATES';
export const STOP_REQUIRED = 'STOP_REQUIRED';
export const NEGATIVE_CONTROL_UNEXPECTED_TRUE = 'NEGATIVE_CONTROL_UNEXPECTED_TRUE';

export class A2CaptureError extends Error { constructor(m) { super(m); this.name = 'A2CaptureError'; } }
export class A2ProvenanceError extends Error { constructor(m) { super(m); this.name = 'A2ProvenanceError'; } }
export class A2LeakageDetected extends Error {
  constructor(term, context) {
    super(`A2 acquisition packet contains "${term}" — ${context}. Packet is INVALID.`);
    this.name = 'A2LeakageDetected';
    this.term = term;
  }
}

// ---------------------------------------------------------------------------
// Admission (D-2)
// ---------------------------------------------------------------------------

/**
 * Reads one committed real capture and recomputes what the packet builder depends on.
 *
 * Every byte this returns is checked against the hash the capture sealed for it. The
 * manifest's own `eligibility`, `captureStatus` and `failureReasons` are read only to be
 * cross-checked — admission is decided from the artifacts, because a status field is a
 * claim about a run and the artifacts are the run.
 */
export function loadRealCapture(captureDir) {
  const read = (name) => {
    const path = join(captureDir, name);
    if (!existsSync(path)) throw new A2CaptureError(`capture at ${captureDir} is missing ${name}`);
    return readFileSync(path, 'utf8');
  };

  const manifestBytes = read('capture-manifest.json');
  const manifest = JSON.parse(manifestBytes);

  const { manifestSha256, ...rest } = manifest;
  if (sha256(canonical(rest)) !== manifestSha256) {
    throw new A2CaptureError(`capture manifest for ${manifest.fixtureId} does not match its own seal`);
  }

  // Every file the packet will quote from has to hash to what the capture recorded, or
  // the packet would be built on text nobody sealed.
  const files = {};
  for (const [name, expected] of Object.entries(manifest.fileHashes)) {
    const content = read(name);
    const actual = sha256(content);
    if (actual !== expected) {
      throw new A2CaptureError(`${manifest.fixtureId}/${name} does not match its sealed hash`);
    }
    files[name] = content;
  }

  const task = files['task.txt'];
  if (typeof task !== 'string') {
    throw new A2CaptureError(`${manifest.fixtureId}: capture does not seal task.txt`);
  }

  // Which shape is this? The sealed manifest decides, not the directory listing: a
  // capture that *declares* a round and is missing it is corrupt, and a capture that
  // never had one is evidence. Collapsing those two would turn a tampered artifact into
  // an ordinary ineligible candidate, which is the one mistake that cannot be noticed
  // later — the packet would simply be built from a smaller set.
  const declaresSnapshot = 'snapshot.json' in manifest.fileHashes;
  const declaresReport = 'report.json' in manifest.fileHashes;
  const fatalError = manifest.fatalError ?? null;

  if (declaresSnapshot !== declaresReport) {
    throw new A2CaptureError(
      `${manifest.fixtureId}: capture seals only one of snapshot.json / report.json; the shape is not one production produces`,
    );
  }

  if (!declaresSnapshot) {
    // Everything below has to agree, or this is not the legal fatal shape.
    const inconsistent = [
      fatalError === null || String(fatalError).length === 0 ? 'no fatalError recorded' : null,
      manifest.snapshotSha256 != null ? 'snapshotSha256 is set' : null,
      manifest.round1Status != null ? 'round1Status is set' : null,
      manifest.actualComplexity != null ? 'actualComplexity is set' : null,
      manifest.agentOrder != null ? 'agentOrder is set' : null,
      manifest.successfulWorkerCount !== 0 ? 'successfulWorkerCount is not zero' : null,
      Array.isArray(manifest.workers) && manifest.workers.length !== 0 ? 'workers is not empty' : null,
      manifest.captureStatus !== 'FAILED' ? `captureStatus is ${manifest.captureStatus}` : null,
    ].filter(Boolean);
    if (inconsistent.length) {
      throw new A2CaptureError(
        `${manifest.fixtureId}: capture has no Round 1 but does not match the fatal shape (${inconsistent.join('; ')})`,
      );
    }

    return Object.freeze({
      fixtureId: manifest.fixtureId,
      captureDir,
      captureOutcome: PRE_ROUND1_FATAL,
      fatalError: String(fatalError),
      task,
      taskSha256: sha256(task),
      manifestSha256,
      agentOrder: [],
      workerResults: [],
      // A candidate with no Round 1 reaches no eligibility boundary. It is spent evidence,
      // never a retry and never a repair.
      eligibility: Object.freeze({ F1: false, F2: false, F3: false }),
      admitted: false,
      reportedEligibility: manifest.eligibility ?? null,
      reportedCaptureStatus: manifest.captureStatus ?? null,
    });
  }

  const snapshot = JSON.parse(files['snapshot.json']);
  const report = JSON.parse(files['report.json']);

  // The specialists that actually produced text. Not the ones that were asked.
  const workerResults = snapshot.workerResults
    .filter((r) => typeof r.output === 'string' && r.output.trim().length > 0)
    .map((r) => ({ agentId: r.agentId, mission: r.mission, output: r.output }));

  for (const r of workerResults) {
    const missionFile = files[`mission-${r.agentId}.txt`];
    const outputFile = files[`round1-${r.agentId}.md`];
    if (missionFile !== r.mission || outputFile !== r.output) {
      throw new A2CaptureError(`${manifest.fixtureId}: snapshot text disagrees with the sealed files for ${r.agentId}`);
    }
  }

  if (report.successfulWorkers !== workerResults.length) {
    throw new A2CaptureError(
      `${manifest.fixtureId}: report claims ${report.successfulWorkers} successful workers, artifacts show ${workerResults.length}`,
    );
  }

  const eligibility = Object.freeze({
    F1: snapshot.complexity === 'deep',
    F2: workerResults.length >= 2,
    F3: report.status === 'SUCCESS',
  });

  return Object.freeze({
    fixtureId: manifest.fixtureId,
    captureDir,
    captureOutcome: ROUND1_PRESENT,
    fatalError,
    task,
    taskSha256: sha256(task),
    manifestSha256,
    agentOrder: snapshot.agentOrder.filter((id) => workerResults.some((r) => r.agentId === id)),
    workerResults,
    eligibility,
    admitted: eligibility.F1 && eligibility.F2 && eligibility.F3,
    /** What the capture said about itself, kept only so a caller can compare. */
    reportedEligibility: manifest.eligibility ?? null,
    reportedCaptureStatus: manifest.captureStatus ?? null,
  });
}

/** F1, F2 and F3 all true. Nothing below that boundary is worth an annotator's attention. */
export function isAdmissible(capture) {
  return capture.eligibility.F1 && capture.eligibility.F2 && capture.eligibility.F3;
}

// ---------------------------------------------------------------------------
// Passages (D-9)
// ---------------------------------------------------------------------------

/**
 * Passage ids from production segmentation, never a second splitter.
 *
 * A locally-written paragraph parser would drift from `segmentAll` the first time either
 * changed, and the passage ids A2 cites are the ids the Gate is later measured against.
 */
export function passagesForCapture(capture) {
  const chunks = segmentAll(capture.workerResults);
  const out = {};
  for (const [agentId, list] of Object.entries(chunks)) {
    out[agentId] = list.map((c) => ({ passageId: `${agentId}:${c.id}`, text: c.text }));
  }
  return out;
}

export function passageIdsForCapture(capture) {
  const passages = passagesForCapture(capture);
  return capture.agentOrder.flatMap((id) => (passages[id] ?? []).map((p) => p.passageId));
}

// ---------------------------------------------------------------------------
// Ordering and opaque aliases (D-6, D-7)
// ---------------------------------------------------------------------------

export const caseIdFor = (index) => `case-${String(index + 1).padStart(2, '0')}`;

/**
 * Orders the batch by the SHA-256 of the frozen task text, ascending.
 *
 * The sort key is fixed before Round 1 exists and is independent of everything the
 * builder could otherwise be tempted by: slot id, archetype, provider, model, which
 * specialists ran, what they said, and which case is the negative control. The negative
 * control sorts by the same key as everything else, which is the point — it must not be
 * findable by position.
 */
export function orderCases(captures) {
  const seen = new Map();
  for (const c of captures) {
    if (seen.has(c.taskSha256)) {
      throw new A2CaptureError(
        `two candidates share one task hash (${seen.get(c.taskSha256)} and ${c.fixtureId}); ordering would be ambiguous`,
      );
    }
    seen.set(c.taskSha256, c.fixtureId);
  }
  return [...captures]
    .sort((a, b) => (a.taskSha256 < b.taskSha256 ? -1 : 1))
    .map((capture, index) => ({ caseId: caseIdFor(index), capture }));
}

// ---------------------------------------------------------------------------
// Acquisition-specific leakage validation (D-8, D-14)
// ---------------------------------------------------------------------------

/**
 * Terms that must not appear in a dynamic case payload.
 *
 * Derived from the legacy list, minus the four schema words protocol 0.3 now allows A2 to
 * see, plus the things a real capture can leak that a synthetic fixture could not:
 * provider names, model names and the role description the registry carries.
 *
 * The legacy list itself is untouched. Anything that must stay forbidden everywhere is
 * repeated here rather than imported-and-filtered, so a later edit to either list cannot
 * silently widen the other.
 */
export const CASE_PAYLOAD_FORBIDDEN_TERMS = Object.freeze([
  // what the Gate did
  'selectedIssue', 'sourceRef', 'challengeText', 'peer_challenge', 'collaborationIssues',
  'synthesis_gate', 'round2', 'round2_worker', 'decision_synthesis', 'self_review',
  'Gate selected', 'gate output',
  // experiment structure
  'Replay #3', 'Replay #4', 'controlled-replay',
  'B_prime', "B'", 'D1', 'D₁', 'arm C', 'arm B', 'M2-A', 'M2-B', 'HANDOFF',
  'peer challenge', 'Targeted Peer-Challenge', 'claims ladder',
  // which case is which
  'negative control', 'negativeControl', 'positive fixture',
  'intended archetype', 'intendedArchetype', 'preregistered',
  // real-capture metadata the synthetic path never carried
  'claude', 'gemini', 'openai', 'gpt-5', 'sonnet', 'anthropic',
  'providerRequested', 'providerResolved', 'modelRequested', 'modelResolved',
  'captureStatus', 'evidenceCapable', 'providesEvidence',
  'complexity', 'eligibility', 'Critical Analyst', 'Research Analyst',
]);

/** Internal identities, forbidden anywhere in the packet including the instructions. */
export const INTERNAL_IDENTITY_PATTERN = /\b(?:S[123]|E[123]|I[123]|fxr-\d+|fx-\d+)\b/g;

export function scanCasePayload(text) {
  const haystack = text.toLowerCase();
  const hits = [];
  for (const term of CASE_PAYLOAD_FORBIDDEN_TERMS) {
    const at = haystack.indexOf(term.toLowerCase());
    if (at !== -1) {
      hits.push({ term, context: text.slice(Math.max(0, at - 40), at + term.length + 40).replace(/\s+/g, ' ') });
    }
  }
  return hits;
}

export function scanInternalIdentities(text) {
  INTERNAL_IDENTITY_PATTERN.lastIndex = 0;
  const hits = [];
  let m;
  while ((m = INTERNAL_IDENTITY_PATTERN.exec(text)) !== null) {
    hits.push({ term: m[0], context: text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40).replace(/\s+/g, ' ') });
  }
  return hits;
}

/**
 * Scans a built packet: identities everywhere, metadata terms in the case payloads only.
 *
 * Lexical, and claimed as nothing more. It proves the named terms are absent; it cannot
 * prove the absence of a subtle steer.
 */
export function assertA2PacketClean({ instructions, caseBlocks }) {
  const whole = [instructions, ...caseBlocks].join('\n');
  const identityHits = scanInternalIdentities(whole);
  if (identityHits.length) throw new A2LeakageDetected(identityHits[0].term, identityHits[0].context);

  for (const block of caseBlocks) {
    const hits = scanCasePayload(block);
    if (hits.length) throw new A2LeakageDetected(hits[0].term, hits[0].context);
  }
  return {
    scannedTerms: CASE_PAYLOAD_FORBIDDEN_TERMS.length,
    scannedBlocks: caseBlocks.length,
    clean: true,
    lexicalOnly: true,
  };
}

// ---------------------------------------------------------------------------
// The A2-visible packet (D-8, D-10, D-11, D-12, D-13)
// ---------------------------------------------------------------------------

export const A2_INSTRUCTIONS = `# 標註任務 —— 跨專家分歧判定

你會看到若干份彼此獨立的決策情境。每一份包含：原始任務、每位專家各自的任務指派
(mission)、以及每位專家各自的完整書面意見。每段意見都已切成有編號的段落。

**請只根據這些內容作答。** 不要推測任何後續系統、模型或流程可能會怎麼處理它們，
也不要推測這些情境是為了什麼目的被收集。

對每一份情境，請判斷：

**是否存在 material、cross-agent、decision-sensitive 的分歧？**

- *material*：實質的，不是措辭、語氣、強調或呈現方式的差異
- *cross-agent*：分歧存在於兩位以上專家之間，不是同一位專家內部的猶豫
- *decision-sensitive*：如果這個分歧被解決，最終決策（選哪個選項、或決策的關鍵條件）
  有實質可能改變

**重要判準：相同決策 + 不同推理，不自動構成 material conflict。**
兩位專家若指向同一個結論，只是理由不同、切入角度不同、或強調的風險不同，
這不是 material conflict。除非他們對「該怎麼做」本身有實質分歧。

各情境彼此獨立，判斷不需要一致，也不需要湊出特定比例。
如果某一份情境沒有這樣的分歧，就據實回答沒有。

## 分類

若判定為有分歧，請從下列擇一填入 \`conflictArchetype\`：

- \`STRATEGY\` —— 分歧在於該採取哪一個方向或哪一個選項
- \`EXECUTION_CONSTRAINT\` —— 分歧在於資源、時程、產能或執行可行性的限制
- \`EVIDENCE_INTERPRETATION\` —— 分歧在於同一份證據該怎麼解讀、或證據是否足夠
- \`OTHER\` —— 確實是 material conflict，但不屬於上面三類

\`OTHER\` 是合法答案。如果分歧不乾淨地落在前三類，請用 \`OTHER\`，不要勉強歸類。

## 輸出格式

請輸出一個 JSON 陣列，每份情境一個物件，順序與下方情境一致：

\`\`\`json
[
  {
    "caseId": "case-01",
    "materialConflict": true,
    "conflictArchetype": "STRATEGY",
    "summary": "一句話描述這個分歧",
    "passageIds": ["<agentId>:pN", "<agentId>:pN"]
  }
]
\`\`\`

規則：

- \`materialConflict\` = \`false\` 時，其餘三欄必須是
  \`conflictArchetype: null\`、\`summary: null\`、\`passageIds: []\`
- \`materialConflict\` = \`true\` 時，\`summary\` 不得為空，
  且 \`passageIds\` 必須引用**至少兩位不同專家**的段落
  （因為判定的是跨專家分歧，只引用一位專家不足以支持）
- \`passageIds\` 只能使用各情境實際列出的段落編號，格式必須完全一致

JSON 之後可以附上簡短的中文說明。`;

function renderCaseBlock(caseId, capture) {
  const passages = passagesForCapture(capture);
  const parts = [`\n# 情境 ${caseId}\n`];
  parts.push(`## 原始任務\n\n${capture.task.trim()}\n`);
  for (const agentId of capture.agentOrder) {
    const result = capture.workerResults.find((r) => r.agentId === agentId);
    parts.push(`\n## 專家 \`${agentId}\`\n`);
    parts.push(`**任務指派:** ${result.mission.trim()}\n`);
    parts.push(`**書面意見(依段落編號):**\n`);
    for (const p of passages[agentId]) {
      parts.push(`\n\`${p.passageId}\`\n${p.text}\n`);
    }
  }
  parts.push('\n---\n');
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Batch construction (D-3, D-4, D-5, D-15)
// ---------------------------------------------------------------------------

/**
 * Whether the negative control has already gone out in an earlier batch.
 *
 * Read from prior hidden provenance, never from an operator's recollection: the whole
 * reason fxr-08 works as a control is that it appears exactly once, and "did we already
 * send it?" is precisely the kind of question a person answers wrongly three waves later.
 */
export function negativeControlAlreadyUsed(priorProvenance = []) {
  return priorProvenance.some((p) => p.negativeControlIncluded === true);
}

/**
 * Validates the chain of earlier batches before any of it is allowed to decide anything.
 *
 * Prior provenance is protocol state, not a note from whoever ran the last wave. It
 * decides whether the negative control has already been spent, what this batch's index
 * is, and whether A2 is being started or continued — so a chain that is merely *asserted*
 * would let a single wrong flag either send the control twice or never send it at all,
 * and neither is visible in the resulting annotations. Every entry is therefore
 * re-verified against the captures on disk, and anything that does not add up stops the
 * build rather than being reset to a default.
 */
export function validatePriorProvenanceChain(priorProvenance = []) {
  if (!Array.isArray(priorProvenance)) {
    throw new A2ProvenanceError('prior provenance must be an array of earlier batch manifests');
  }

  let negativeControlUsed = false;
  priorProvenance.forEach((entry, index) => {
    const at = `prior batch ${index + 1}`;
    if (!entry || typeof entry !== 'object') throw new A2ProvenanceError(`${at}: not a provenance manifest`);
    if (entry.protocolVersion !== PROTOCOL_VERSION) {
      throw new A2ProvenanceError(`${at}: protocolVersion is "${entry.protocolVersion}", expected ${PROTOCOL_VERSION}`);
    }
    if (entry.a2SessionId !== A2_SESSION_ID) {
      throw new A2ProvenanceError(`${at}: a2SessionId is "${entry.a2SessionId}", expected ${A2_SESSION_ID}`);
    }
    if (entry.orderingRule !== ORDERING_RULE) {
      throw new A2ProvenanceError(`${at}: orderingRule is "${entry.orderingRule}", expected ${ORDERING_RULE}`);
    }
    if (entry.batchIndex !== index + 1) {
      throw new A2ProvenanceError(`${at}: batchIndex is ${entry.batchIndex}, expected ${index + 1}`);
    }
    const expectedStart = index === 0 ? 'FRESH' : 'CONTINUE';
    if (entry.a2SessionStart !== expectedStart) {
      throw new A2ProvenanceError(`${at}: a2SessionStart is "${entry.a2SessionStart}", expected ${expectedStart}`);
    }
    if (entry.negativeControlIncluded === true) {
      // Twice is not a stricter control, it is a different experiment.
      if (negativeControlUsed) throw new A2ProvenanceError(`${at}: the negative control is already recorded as used in an earlier batch`);
      negativeControlUsed = true;
    }
    const verification = verifyProvenance(entry);
    if (!verification.ok) {
      throw new A2ProvenanceError(`${at}: provenance does not recompute (${verification.failures.map((f) => f.id).join(', ')})`);
    }
  });

  const last = priorProvenance[priorProvenance.length - 1] ?? null;
  return Object.freeze({
    batchCount: priorProvenance.length,
    lastBatchIndex: last ? last.batchIndex : 0,
    negativeControlUsed,
    sessionStart: priorProvenance.length === 0 ? 'FRESH' : 'CONTINUE',
  });
}

/**
 * Builds one acquisition batch, or refuses to build one.
 *
 * @param {object} args
 * @param {string[]} args.candidateCaptureDirs  P03 captures from the wave that just ran
 * @param {object[]} args.priorProvenance       hidden manifests of every earlier batch
 */
export function buildA2AcquisitionBatch({
  candidateCaptureDirs,
  priorProvenance = [],
  negativeControlCaptureDir = NEGATIVE_CONTROL_CAPTURE_DIR,
  builderCommit = null,
  executionHead = null,
}) {
  // Validated before it is read, and before any capture is loaded: a corrupt chain must
  // stop the build outright, not quietly change what this batch contains.
  const chain = validatePriorProvenanceChain(priorProvenance);

  const candidates = candidateCaptureDirs.map(loadRealCapture);
  const admitted = candidates.filter(isAdmissible);
  const rejected = candidates
    .filter((c) => !isAdmissible(c))
    .map((c) => ({
      fixtureId: c.fixtureId,
      eligibility: c.eligibility,
      captureOutcome: c.captureOutcome,
      // Kept for the hidden rejection record only. It can name a provider or a model, so
      // it must never travel with anything A2 sees.
      fatalError: c.fatalError ?? null,
    }));

  // D-3. An empty batch is a real outcome, not a reason to send the control alone: a
  // control annotated by itself tells the annotator what it is.
  if (admitted.length === 0) {
    return Object.freeze({
      status: NO_A2_BATCH,
      reason: NO_F4_ELIGIBLE_CANDIDATES,
      admitted: [],
      rejected,
      negativeControlIncluded: false,
      packet: null,
      provenance: null,
    });
  }

  const includeNegativeControl = !chain.negativeControlUsed;
  const negativeControl = includeNegativeControl ? loadRealCapture(negativeControlCaptureDir) : null;
  const ordered = orderCases(includeNegativeControl ? [...admitted, negativeControl] : admitted);

  const caseBlocks = ordered.map(({ caseId, capture }) => renderCaseBlock(caseId, capture));
  const scan = assertA2PacketClean({ instructions: A2_INSTRUCTIONS, caseBlocks });

  const text = [A2_INSTRUCTIONS, '\n---\n', ...caseBlocks].join('\n');
  const packetSha256 = sha256(text);

  const provenance = Object.freeze({
    protocolVersion: PROTOCOL_VERSION,
    a2SessionId: A2_SESSION_ID,
    a2SessionStart: chain.sessionStart,
    batchIndex: chain.lastBatchIndex + 1,
    packetSha256,
    packetBytes: Buffer.byteLength(text),
    orderingRule: ORDERING_RULE,
    negativeControlIncluded: includeNegativeControl,
    negativeControlFixtureId: includeNegativeControl ? NEGATIVE_CONTROL_FIXTURE_ID : null,
    builderCommit,
    executionHead,
    cases: ordered.map(({ caseId, capture }) => ({
      caseId,
      internalFixtureId: capture.fixtureId,
      isNegativeControl: capture.fixtureId === NEGATIVE_CONTROL_FIXTURE_ID,
      taskSha256: capture.taskSha256,
      sourceCaptureManifestSha256: capture.manifestSha256,
      captureDir: capture.captureDir,
      agentOrder: [...capture.agentOrder],
      missionSha256: Object.fromEntries(capture.workerResults.map((r) => [r.agentId, sha256(r.mission)])),
      round1OutputSha256: Object.fromEntries(capture.workerResults.map((r) => [r.agentId, sha256(r.output)])),
      passageIds: passageIdsForCapture(capture),
    })),
    rejected,
  });

  return Object.freeze({
    status: A2_BATCH,
    reason: null,
    admitted: admitted.map((c) => c.fixtureId),
    rejected,
    negativeControlIncluded: includeNegativeControl,
    packet: Object.freeze({ text, sha256: packetSha256, bytes: Buffer.byteLength(text), scan }),
    provenance,
  });
}

// ---------------------------------------------------------------------------
// Annotation validation (D-10, D-11, D-12) and case-set validation (T-11, T-12)
// ---------------------------------------------------------------------------

/** Validates one annotation against the case it claims to be about. */
export function validateAnnotation(annotation, caseRecord) {
  const errors = [];
  const valid = new Set(caseRecord.passageIds);

  if (typeof annotation.materialConflict !== 'boolean') {
    errors.push('materialConflict must be true or false');
    return { caseId: caseRecord.caseId, ok: false, errors };
  }

  if (annotation.materialConflict === false) {
    // D-11. Exactly one legal shape, so a "no" cannot smuggle in a half-answer.
    if (annotation.conflictArchetype !== null) errors.push('conflictArchetype must be null when materialConflict is false');
    if (annotation.summary !== null) errors.push('summary must be null when materialConflict is false');
    if (!Array.isArray(annotation.passageIds) || annotation.passageIds.length !== 0) {
      errors.push('passageIds must be empty when materialConflict is false');
    }
    return { caseId: caseRecord.caseId, ok: errors.length === 0, errors };
  }

  if (!CONFLICT_ARCHETYPES.includes(annotation.conflictArchetype)) {
    errors.push(`conflictArchetype must be one of ${CONFLICT_ARCHETYPES.join(', ')}`);
  }
  if (typeof annotation.summary !== 'string' || annotation.summary.trim().length === 0) {
    errors.push('summary must be a non-empty string when materialConflict is true');
  }
  if (!Array.isArray(annotation.passageIds) || annotation.passageIds.length === 0) {
    errors.push('passageIds must cite at least one passage when materialConflict is true');
    return { caseId: caseRecord.caseId, ok: false, errors };
  }

  const unknown = annotation.passageIds.filter((id) => !valid.has(id));
  if (unknown.length) errors.push(`passage id(s) not present in this case: ${unknown.join(', ')}`);

  // F4 is a *cross-agent* disagreement. One specialist quoted twice is one voice.
  const agents = new Set(annotation.passageIds.filter((id) => valid.has(id)).map((id) => id.slice(0, id.lastIndexOf(':'))));
  if (agents.size < 2) errors.push('a material conflict must cite passages from at least two distinct agents');

  return { caseId: caseRecord.caseId, ok: errors.length === 0, errors };
}

/**
 * Validates a whole returned annotation set against the batch it answers.
 *
 * Unknown, duplicated and missing cases are all rejected: a set that does not correspond
 * one-to-one with the packet cannot be resolved against the hidden mapping.
 */
export function validateAnnotationSet(annotations, provenance) {
  const errors = [];
  if (!Array.isArray(annotations)) {
    return { ok: false, errors: ['annotations must be an array'], perCase: [] };
  }

  const expected = provenance.cases.map((c) => c.caseId);
  const seen = new Set();
  for (const a of annotations) {
    if (!a || typeof a.caseId !== 'string') { errors.push('every annotation needs a caseId'); continue; }
    if (!expected.includes(a.caseId)) errors.push(`unknown caseId "${a.caseId}"`);
    if (seen.has(a.caseId)) errors.push(`duplicate annotation for "${a.caseId}"`);
    seen.add(a.caseId);
  }
  for (const caseId of expected) {
    if (!seen.has(caseId)) errors.push(`missing annotation for "${caseId}"`);
  }

  const perCase = [];
  for (const caseRecord of provenance.cases) {
    const annotation = annotations.find((a) => a && a.caseId === caseRecord.caseId);
    if (!annotation) continue;
    const result = validateAnnotation(annotation, caseRecord);
    perCase.push(result);
    for (const e of result.errors) errors.push(`${caseRecord.caseId}: ${e}`);
  }

  return { ok: errors.length === 0, errors, perCase };
}

// ---------------------------------------------------------------------------
// Negative control (D-16) and slot-fill resolution (D-17)
// ---------------------------------------------------------------------------

/**
 * Checks the control through the hidden mapping. A2 never learns which case this was.
 *
 * An unexpected `true` is not a bad draw to be re-rolled. It says the annotator finds a
 * material conflict where the design says there is none, which invalidates the reading
 * of every other case in the same batch — so the only allowed response is to stop.
 */
export function assessNegativeControl(annotations, provenance) {
  const control = provenance.cases.find((c) => c.isNegativeControl);
  if (!control) return { status: 'OK', assessed: false, reason: null, caseId: null };

  const annotation = annotations.find((a) => a && a.caseId === control.caseId);
  if (!annotation) {
    return { status: STOP_REQUIRED, assessed: false, reason: 'NEGATIVE_CONTROL_NOT_ANNOTATED', caseId: control.caseId };
  }
  if (annotation.materialConflict === true) {
    return { status: STOP_REQUIRED, assessed: true, reason: NEGATIVE_CONTROL_UNEXPECTED_TRUE, caseId: control.caseId };
  }
  return { status: 'OK', assessed: true, reason: null, caseId: control.caseId };
}

export function preregisteredArchetypeOf(fixtureId) {
  const entry = Object.entries(ARCHETYPE_SLOTS).find(([, slots]) => slots.includes(fixtureId));
  return entry ? entry[0] : null;
}

/**
 * Resolves which preregistered slots the batch filled.
 *
 * This is the only place the intended archetype is read, and it runs strictly after
 * annotation. A2 answered a question about the text; this asks whether that answer
 * matches what the task was written to produce. Keeping the two apart is what stops F4
 * from becoming a label the annotator was asked to confirm.
 */
export function resolveSlotFills(annotations, provenance) {
  return provenance.cases
    .filter((c) => !c.isNegativeControl)
    .map((c) => {
      const annotation = annotations.find((a) => a && a.caseId === c.caseId) ?? null;
      const preregisteredArchetype = preregisteredArchetypeOf(c.internalFixtureId);
      const fillsSlot = annotation !== null
        && preregisteredArchetype !== null
        && fillsArchetypeSlot(annotation, preregisteredArchetype);
      return {
        caseId: c.caseId,
        internalFixtureId: c.internalFixtureId,
        preregisteredArchetype,
        materialConflict: annotation ? annotation.materialConflict : null,
        conflictArchetype: annotation ? annotation.conflictArchetype : null,
        fillsSlot,
      };
    });
}

/**
 * The whole post-annotation pipeline, in the order the protocol requires.
 *
 * Validation first, because an invalid set cannot be read at all. The control next,
 * because a failed control invalidates the batch. Slot resolution last, and only then.
 */
export function resolveAnnotations({ annotations, provenance }) {
  const validation = validateAnnotationSet(annotations, provenance);
  if (!validation.ok) {
    return { status: 'INVALID_ANNOTATIONS', validation, negativeControl: null, slots: null };
  }
  const negativeControl = assessNegativeControl(annotations, provenance);
  if (negativeControl.status === STOP_REQUIRED) {
    return { status: STOP_REQUIRED, validation, negativeControl, slots: null };
  }
  const slots = resolveSlotFills(annotations, provenance);
  return {
    status: 'RESOLVED',
    validation,
    negativeControl,
    slots,
    filledArchetypes: [...new Set(slots.filter((s) => s.fillsSlot).map((s) => s.preregisteredArchetype))],
  };
}

// ---------------------------------------------------------------------------
// Provenance verification (D-15, T-17)
// ---------------------------------------------------------------------------

/**
 * Recomputes every hash in a hidden manifest from the committed captures on disk.
 *
 * Reads nothing from the manifest except which files to open, so a manifest that
 * disagrees with the artifacts fails here rather than being taken at its word.
 */
export function verifyProvenance(provenance) {
  const failures = [];
  const q = (id, ok, detail) => { if (!ok) failures.push({ id, detail }); };

  q('protocolVersion', provenance.protocolVersion === PROTOCOL_VERSION, provenance.protocolVersion);
  q('a2SessionId', provenance.a2SessionId === A2_SESSION_ID, provenance.a2SessionId);
  q('orderingRule', provenance.orderingRule === ORDERING_RULE, provenance.orderingRule);

  const rebuilt = [];
  for (const c of provenance.cases) {
    const capture = loadRealCapture(c.captureDir);
    q(`${c.caseId}/fixtureId`, capture.fixtureId === c.internalFixtureId, capture.fixtureId);
    q(`${c.caseId}/taskSha256`, capture.taskSha256 === c.taskSha256, capture.taskSha256);
    q(`${c.caseId}/manifestSha256`, capture.manifestSha256 === c.sourceCaptureManifestSha256, capture.manifestSha256);
    q(`${c.caseId}/passageIds`,
      JSON.stringify(passageIdsForCapture(capture)) === JSON.stringify(c.passageIds),
      'passage ids differ from production segmentation');
    for (const r of capture.workerResults) {
      q(`${c.caseId}/mission/${r.agentId}`, sha256(r.mission) === c.missionSha256[r.agentId], 'mission hash');
      q(`${c.caseId}/round1/${r.agentId}`, sha256(r.output) === c.round1OutputSha256[r.agentId], 'round1 hash');
    }
    rebuilt.push({ caseId: c.caseId, capture });
  }

  // The ordering rule has to reproduce the aliases that were actually issued.
  const reordered = orderCases(rebuilt.map((r) => r.capture));
  q('ordering',
    JSON.stringify(reordered.map((r) => [r.caseId, r.capture.fixtureId]))
      === JSON.stringify(provenance.cases.map((c) => [c.caseId, c.internalFixtureId])),
    'case ids do not reproduce under the frozen ordering rule');

  const caseBlocks = reordered.map(({ caseId, capture }) => renderCaseBlock(caseId, capture));
  const text = [A2_INSTRUCTIONS, '\n---\n', ...caseBlocks].join('\n');
  q('packetSha256', sha256(text) === provenance.packetSha256, sha256(text));

  const controls = provenance.cases.filter((c) => c.isNegativeControl);
  q('negativeControlCount', controls.length === (provenance.negativeControlIncluded ? 1 : 0), `${controls.length}`);

  return { ok: failures.length === 0, failures, checked: provenance.cases.length };
}

export { sha256, canonical, renderCaseBlock };
