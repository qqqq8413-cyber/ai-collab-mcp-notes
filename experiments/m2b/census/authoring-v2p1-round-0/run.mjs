/**
 * CBRP-AUTHORING-V2P1-ROUND-0 — five initial sessions, one logical call each, in
 * deterministic block order. A NEW acquisition under CBRP-AUTHORING-PROTOCOL-2.1 — not
 * a retry or continuation of Protocol 2's CBRP-AUTHORING-V2-ROUND-0.
 *
 * Calls the vendor SDKs directly (as CWP-9A/10B did) so resolved model identity in the
 * response body can be recorded. Raw responses are written before any extraction, and
 * extraction is delegated entirely to CBRP-AUTHOR-EXTRACTOR-2.1 — no custom parsing,
 * no fallback, no ad-hoc repair, per CWP-10E §12.
 *
 * STOP semantics: the first frozen STOP condition halts the run. Later sessions are NOT
 * attempted, and no model is ever substituted. Each authorized session gets exactly one
 * logical call; a dispatched response consumes that attempt regardless of result.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { EXTRACTOR_VERSION, extractCbrpAuthorResponse } from '../extractor-2.1/cbrp-author-extractor.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const RUN_ID = 'CBRP-AUTHORING-V2P1-ROUND-0';
const PROTOCOL_VERSION = 'CBRP-AUTHORING-PROTOCOL-2.1';
const BRIEF_VERSION = 'CBRP-AUTHORING-BRIEF-2';
const MODEL_PIN_VERSION = 'CBRP-SESSION-MODEL-PINS-1';
const EXPECTED_PROMPT_SHA256 = 'a9da93fd5d4dd059c0faebdf3e29713abe2035191af5aac26a5b73eb17842336';
const MAX_TOKENS = 32000;

const STRATA = new Map([
  ['Strategy / Commitment', 'SC'],
  ['Operations / Execution', 'OP'],
  ['Brand / Creative', 'BC'],
  ['Evidence Interpretation', 'EI'],
  ['Product / Service Design', 'PS'],
  ['Finance / Resource Allocation', 'FR'],
]);

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/** Byte-identical to every session, by construction: read once, sent unchanged. */
const BRIEF = fs.readFileSync(path.join(DIR, 'BRIEF_SENT.txt'), 'utf8');
const BRIEF_SHA = sha256(BRIEF);
if (BRIEF_SHA !== EXPECTED_PROMPT_SHA256) {
  process.stderr.write(`STOP PRE-DISPATCH: prompt hash ${BRIEF_SHA} != expected ${EXPECTED_PROMPT_SHA256}\n`);
  process.exit(1);
}

const SESSIONS = [
  { authorBlockId: 'AUTHOR21-B01', actualAuthorSessionId: 'AUTHOR21-B01-S00', provider: 'claude', model: 'claude-sonnet-5',  modelFamily: 'CLAUDE_FAMILY' },
  { authorBlockId: 'AUTHOR21-B02', actualAuthorSessionId: 'AUTHOR21-B02-S00', provider: 'gemini', model: 'gemini-3.7-flash', modelFamily: 'GEMINI_FAMILY' },
  { authorBlockId: 'AUTHOR21-B03', actualAuthorSessionId: 'AUTHOR21-B03-S00', provider: 'claude', model: 'claude-sonnet-5',  modelFamily: 'CLAUDE_FAMILY' },
  { authorBlockId: 'AUTHOR21-B04', actualAuthorSessionId: 'AUTHOR21-B04-S00', provider: 'gemini', model: 'gemini-3.7-flash', modelFamily: 'GEMINI_FAMILY' },
  { authorBlockId: 'AUTHOR21-B05', actualAuthorSessionId: 'AUTHOR21-B05-S00', provider: 'claude', model: 'claude-sonnet-5',  modelFamily: 'CLAUDE_FAMILY' },
];

/**
 * Streamed because the SDK refuses a non-streaming request at this max_tokens before it
 * dispatches anything (a client-side guard, no HTTP attempt — CWP-9A precedent).
 * `finalMessage()` returns the same assembled message a non-streaming call would have.
 */
async function callClaudeOnce(model, prompt) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
  const stream = client.messages.stream({
    model,
    max_tokens: MAX_TOKENS,
    messages: [{ role: 'user', content: prompt }],
  });
  const response = await stream.finalMessage();
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return {
    text,
    raw: response,
    modelResolved: response.model ?? null,
    providerResolved: 'claude',
    stopReason: response.stop_reason ?? null,
  };
}

/** @google/generative-ai 0.24.1 has no retry to disable: makeRequest awaits fetch once. */
async function callGeminiOnce(model, prompt) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const genModel = genAI.getGenerativeModel({ model });
  const result = await genModel.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: MAX_TOKENS },
  });
  const response = result.response;
  const finishReason = response.candidates?.[0]?.finishReason ?? null;
  return {
    text: response.text(),
    raw: response,
    modelResolved: response.modelVersion ?? null,
    providerResolved: 'gemini',
    stopReason: finishReason,
  };
}

const records = [];
const allCandidates = [];
let stopped = null;

for (const session of SESSIONS) {
  const startedAt = new Date().toISOString();
  const base = {
    runId: RUN_ID,
    protocolVersion: PROTOCOL_VERSION,
    extractorVersion: EXTRACTOR_VERSION,
    briefVersion: BRIEF_VERSION,
    modelPinVersion: MODEL_PIN_VERSION,
    authorBlockId: session.authorBlockId,
    actualAuthorSessionId: session.actualAuthorSessionId,
    sessionType: 'INITIAL',
    providerRequested: session.provider,
    modelRequested: session.model,
    modelFamily: session.modelFamily,
    freshContextConfirmed: true,
    freshContextBasis:
      'OPERATOR ATTESTATION — one stateless API request carrying only BRIEF_SENT.txt; ' +
      'no conversation id, no prior turns, no system prompt, no session/block identity in ' +
      'the model-visible prompt. NOT independently verified.',
    promptSha256: BRIEF_SHA,
    promptBytes: Buffer.byteLength(BRIEF, 'utf8'),
    maxTokensRequested: MAX_TOKENS,
    temperatureRequested: null,
    transportRetryConfiguration: session.provider === 'claude'
      ? 'maxRetries: 0'
      : 'SDK 0.24.1 single-fetch path; no retry option',
    providerDispatchCount: 1,
    startedAt,
  };

  process.stderr.write(`\n--- ${session.actualAuthorSessionId}  ${session.provider}/${session.model}\n`);

  let out;
  try {
    out = session.provider === 'claude'
      ? await callClaudeOnce(session.model, BRIEF)
      : await callGeminiOnce(session.model, BRIEF);
  } catch (error) {
    stopped = {
      ...base,
      settledAt: new Date().toISOString(),
      outcome: 'STOP_PROVIDER_ERROR',
      errorName: error?.name ?? null,
      errorStatus: error?.status ?? null,
      errorMessage: String(error?.message ?? error),
    };
    records.push(stopped);
    process.stderr.write(`STOP: ${stopped.errorMessage}\n`);
    break;
  }

  // Raw bytes hit disk before anything reads them.
  fs.writeFileSync(path.join(DIR, 'raw', `${session.actualAuthorSessionId}.txt`), out.text, 'utf8');
  fs.writeFileSync(
    path.join(DIR, 'raw', `${session.actualAuthorSessionId}.response.json`),
    JSON.stringify(out.raw, null, 2),
    'utf8'
  );
  const rawResponseSha256 = sha256(out.text);
  const rawResponseBytes = Buffer.byteLength(out.text, 'utf8');

  const modelMismatch = out.modelResolved !== null && out.modelResolved !== session.model;
  if (modelMismatch) {
    stopped = {
      ...base,
      settledAt: new Date().toISOString(),
      providerResolved: out.providerResolved,
      modelResolved: out.modelResolved,
      resolvedIdentityObservable: true,
      pinStatus: 'MISMATCH',
      rawResponseSha256,
      rawResponseBytes,
      stopReason: out.stopReason ?? null,
      outcome: 'STOP_MODEL_PIN_MISMATCH',
    };
    records.push(stopped);
    process.stderr.write(`STOP: resolved ${out.modelResolved} != requested ${session.model}\n`);
    break;
  }

  // Extractor 2.1 is authoritative. No custom extraction, no fallback, no repair.
  const extraction = extractCbrpAuthorResponse(out.text);
  const record = {
    ...base,
    settledAt: new Date().toISOString(),
    providerResolved: out.providerResolved,
    modelResolved: out.modelResolved,
    resolvedIdentityObservable: out.modelResolved !== null,
    pinStatus: out.modelResolved === null ? 'OPERATOR ATTESTATION' : 'OBSERVED',
    rawResponseSha256,
    rawResponseBytes,
    stopReason: out.stopReason ?? null,
    extractorRepresentation: extraction.representationDetected,
    extractorOk: extraction.ok,
    normalizedJsonSha256: extraction.normalizedJsonSha256,
  };

  if (!extraction.ok) {
    record.outcome = 'STOP_MALFORMED_RESPONSE';
    records.push(record);
    process.stderr.write(`STOP: CBRP-AUTHOR-EXTRACTOR-2.1 rejected the response (no accepted representation)\n`);
    stopped = record;
    break;
  }

  // Mechanical validation only: count, declared-label validity, per-stratum count.
  // No semantic judgement (stratumCorrect, realistic, selfContained, etc.) is performed.
  const candidates = [];
  const problems = [];
  const counters = new Map();
  const blockNum = session.authorBlockId.replace('AUTHOR21-', '');
  extraction.parsed.forEach((entry, index) => {
    if (typeof entry?.stratum !== 'string' || typeof entry?.text !== 'string') {
      problems.push(`[${index}]: missing string stratum/text`);
      return;
    }
    const code = STRATA.get(entry.stratum);
    if (!code) { problems.push(`[${index}]: invalid declared stratum ${JSON.stringify(entry.stratum)}`); return; }
    const n = (counters.get(code) ?? 0) + 1;
    counters.set(code, n);
    candidates.push({
      taskCandidateId: `V21-${blockNum}-S00-${code}-${String(n).padStart(2, '0')}`,
      authorBlockId: session.authorBlockId,
      actualAuthorSessionId: session.actualAuthorSessionId,
      stratumDeclaredByAuthor: entry.stratum,
      stratumCode: code,
      indexInResponse: index,
      taskText: entry.text,
      taskBytes: Buffer.byteLength(entry.text, 'utf8'),
      taskSha256: sha256(entry.text),
    });
  });

  const stratumCounts = Object.fromEntries([...STRATA.values()].map((c) => [c, candidates.filter((x) => x.stratumCode === c).length]));
  if (candidates.length !== 12) problems.push(`candidate count ${candidates.length}, expected 12`);
  for (const [code, count] of Object.entries(stratumCounts)) if (count !== 2) problems.push(`stratum ${code}: ${count}, expected 2`);

  fs.writeFileSync(
    path.join(DIR, 'candidates', `${session.actualAuthorSessionId}.json`),
    JSON.stringify({ actualAuthorSessionId: session.actualAuthorSessionId, extractorRepresentation: extraction.representationDetected, candidates }, null, 2) + '\n',
    'utf8'
  );

  record.candidateCount = candidates.length;
  record.stratumCounts = stratumCounts;
  record.mechanicalProblems = problems;

  if (problems.length > 0) {
    record.outcome = 'STOP_MECHANICAL_VALIDATION_FAILED';
    records.push(record);
    process.stderr.write(`STOP: mechanical validation failed: ${problems.join('; ')}\n`);
    stopped = record;
    break;
  }

  record.outcome = 'RESPONSE_PRESERVED';
  records.push(record);
  allCandidates.push(...candidates);
  process.stderr.write(
    `  representation=${extraction.representationDetected}  resolved=${out.modelResolved ?? 'null'}  ` +
    `bytes=${rawResponseBytes}  candidates=${candidates.length}  sha=${rawResponseSha256.slice(0, 12)}\n`
  );
}

fs.writeFileSync(
  path.join(DIR, 'SESSIONS.json'),
  JSON.stringify(
    {
      runId: RUN_ID,
      protocolVersion: PROTOCOL_VERSION,
      extractorVersion: EXTRACTOR_VERSION,
      briefVersion: BRIEF_VERSION,
      modelPinVersion: MODEL_PIN_VERSION,
      promptSha256: BRIEF_SHA,
      promptBytes: Buffer.byteLength(BRIEF, 'utf8'),
      sessionsAuthorized: SESSIONS.length,
      sessionsAttempted: records.length,
      runStatus: stopped ? 'INCOMPLETE' : 'COMPLETE',
      stoppedAt: stopped ? stopped.actualAuthorSessionId : null,
      sessions: records,
    },
    null,
    2
  ) + '\n',
  'utf8'
);

fs.writeFileSync(
  path.join(DIR, 'CANDIDATES.json'),
  JSON.stringify(
    {
      runId: RUN_ID,
      status: stopped
        ? `INCOMPLETE / PARTIAL PROTOCOL-2.1 PROVISIONAL EVIDENCE / UNREVIEWED / NOT ADMISSIBLE (${allCandidates.length}/60)`
        : '60 PROTOCOL-2.1 PROVISIONAL / UNREVIEWED CANDIDATES',
      candidates: allCandidates,
    },
    null,
    2
  ) + '\n',
  'utf8'
);

process.stderr.write(`\nrun status: ${stopped ? 'INCOMPLETE' : 'COMPLETE'}  attempted ${records.length}/${SESSIONS.length}  candidates ${allCandidates.length}/60\n`);
process.exit(stopped ? 1 : 0);
