/**
 * CBRP Authoring v2 Round 0: five fresh initial sessions, one logical call each.
 *
 * Raw provider evidence is persisted before the response is parsed. Mechanical
 * validation then runs before the next session, so a malformed response stops the
 * acquisition without spending later calls.
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { assertDependenciesMatchLock } from '../../capture/dependency-provenance.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CENSUS_DIR = path.dirname(DIR);
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SOURCE_BRIEF = path.join(CENSUS_DIR, 'CBRP_AUTHORING_BRIEF_V2_PREREG_DRAFT.md');
const EXPECTED_BRANCH = 'experimental/m2a-peer-challenge';
const EXPECTED_BASE = '08cd0200ecbd4642dd394e8377362ce18a23566a';
const RUN_ID = 'CBRP-AUTHORING-V2-ROUND-0';
const PROTOCOL_VERSION = 'CBRP-AUTHORING-PROTOCOL-2';
const BRIEF_VERSION = 'CBRP-AUTHORING-BRIEF-2';
const MODEL_PIN_VERSION = 'CBRP-SESSION-MODEL-PINS-1';
const EXPECTED_BRIEF_SHA = 'a9da93fd5d4dd059c0faebdf3e29713abe2035191af5aac26a5b73eb17842336';
const EXPECTED_BRIEF_BYTES = 8114;
const MAX_TOKENS = 32000;
const START_MARKER = '> ### Paste from here.';
const END_MARKER = '> ### Paste to here.';

const STRATA = [
  'Strategy / Commitment',
  'Operations / Execution',
  'Brand / Creative',
  'Evidence Interpretation',
  'Product / Service Design',
  'Finance / Resource Allocation',
];

const SESSIONS = [
  { authorBlockId: 'AUTHOR2-B01', actualAuthorSessionId: 'AUTHOR2-B01-S00', provider: 'claude', model: 'claude-sonnet-5', modelFamily: 'CLAUDE_FAMILY' },
  { authorBlockId: 'AUTHOR2-B02', actualAuthorSessionId: 'AUTHOR2-B02-S00', provider: 'gemini', model: 'gemini-3.7-flash', modelFamily: 'GEMINI_FAMILY' },
  { authorBlockId: 'AUTHOR2-B03', actualAuthorSessionId: 'AUTHOR2-B03-S00', provider: 'claude', model: 'claude-sonnet-5', modelFamily: 'CLAUDE_FAMILY' },
  { authorBlockId: 'AUTHOR2-B04', actualAuthorSessionId: 'AUTHOR2-B04-S00', provider: 'gemini', model: 'gemini-3.7-flash', modelFamily: 'GEMINI_FAMILY' },
  { authorBlockId: 'AUTHOR2-B05', actualAuthorSessionId: 'AUTHOR2-B05-S00', provider: 'claude', model: 'claude-sonnet-5', modelFamily: 'CLAUDE_FAMILY' },
];

const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();

function extractFrozenBrief(document) {
  const start = document.indexOf(START_MARKER);
  const end = document.indexOf(END_MARKER);
  if (start < 0 || end < 0 || end <= start) throw new Error('PRE_DISPATCH_BRIEF_MARKERS_INVALID');
  if (document.indexOf(START_MARKER, start + START_MARKER.length) >= 0
      || document.indexOf(END_MARKER, end + END_MARKER.length) >= 0) {
    throw new Error('PRE_DISPATCH_BRIEF_MARKERS_NOT_UNIQUE');
  }
  return document.slice(start + START_MARKER.length, end).trim() + '\n';
}

function unwrapOneOuterFence(raw) {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*)\r?\n```$/i);
  return match ? match[1] : trimmed;
}

function validateMechanically(raw) {
  let parsed;
  try {
    parsed = JSON.parse(unwrapOneOuterFence(raw));
  } catch (error) {
    return { ok: false, errors: [`JSON_PARSE: ${error.message}`] };
  }
  const errors = [];
  if (!Array.isArray(parsed)) return { ok: false, errors: ['PAYLOAD_NOT_ARRAY'] };
  if (parsed.length !== 12) errors.push(`SCENARIO_COUNT_${parsed.length}_EXPECTED_12`);
  const counts = Object.fromEntries(STRATA.map((stratum) => [stratum, 0]));
  parsed.forEach((entry, index) => {
    if (typeof entry?.stratum !== 'string' || typeof entry?.text !== 'string') {
      errors.push(`ENTRY_${index}_MISSING_STRING_STRATUM_OR_TEXT`);
      return;
    }
    if (!Object.hasOwn(counts, entry.stratum)) errors.push(`ENTRY_${index}_INVALID_STRATUM_${JSON.stringify(entry.stratum)}`);
    else counts[entry.stratum] += 1;
  });
  for (const [stratum, count] of Object.entries(counts)) {
    if (count !== 2) errors.push(`STRATUM_${JSON.stringify(stratum)}_COUNT_${count}_EXPECTED_2`);
  }
  return { ok: errors.length === 0, errors, scenarioCount: parsed.length, stratumCounts: counts };
}

async function callClaudeOnce(model, prompt) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
  const stream = client.messages.stream({
    model,
    max_tokens: MAX_TOKENS,
    messages: [{ role: 'user', content: prompt }],
  });
  const response = await stream.finalMessage();
  if (response.stop_reason === 'max_tokens') throw new Error(`TRUNCATED: stop_reason=max_tokens at ${MAX_TOKENS}`);
  return {
    text: response.content.filter((block) => block.type === 'text').map((block) => block.text).join(''),
    raw: response,
    providerResolved: 'claude',
    modelResolved: response.model ?? null,
    stopReason: response.stop_reason ?? null,
  };
}

async function callGeminiOnce(model, prompt) {
  const client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const response = (await client.getGenerativeModel({ model }).generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: MAX_TOKENS },
  })).response;
  const finishReason = response.candidates?.[0]?.finishReason ?? null;
  if (finishReason && finishReason !== 'STOP') throw new Error(`TRUNCATED_OR_BLOCKED: finishReason=${finishReason}`);
  return {
    text: response.text(),
    raw: response,
    providerResolved: 'gemini',
    modelResolved: response.modelVersion ?? null,
    stopReason: finishReason,
  };
}

const brief = extractFrozenBrief(fs.readFileSync(SOURCE_BRIEF, 'utf8'));
const promptSha256 = sha256(brief);
const promptBytes = Buffer.byteLength(brief, 'utf8');
if (promptSha256 !== EXPECTED_BRIEF_SHA || promptBytes !== EXPECTED_BRIEF_BYTES) {
  throw new Error(`PRE_DISPATCH_BRIEF_MISMATCH: ${promptSha256}/${promptBytes}`);
}
if (git('branch', '--show-current') !== EXPECTED_BRANCH || git('rev-parse', 'HEAD') !== EXPECTED_BASE) {
  throw new Error('PRE_DISPATCH_BASE_MISMATCH');
}
if (!process.env.ANTHROPIC_API_KEY || !process.env.GEMINI_API_KEY) throw new Error('PRE_DISPATCH_API_KEY_MISSING');
await assertDependenciesMatchLock();

for (const name of ['BRIEF_SENT.txt', 'SESSIONS.json', 'CANDIDATES.json', 'VALIDATION.json']) {
  if (fs.existsSync(path.join(DIR, name))) throw new Error(`PRE_DISPATCH_EXISTING_ARTIFACT: ${name}`);
}
fs.mkdirSync(path.join(DIR, 'raw'), { recursive: true });
fs.mkdirSync(path.join(DIR, 'candidates'), { recursive: true });
fs.writeFileSync(path.join(DIR, 'BRIEF_SENT.txt'), brief, 'utf8');

const state = {
  runId: RUN_ID,
  protocolVersion: PROTOCOL_VERSION,
  briefVersion: BRIEF_VERSION,
  modelPinVersion: MODEL_PIN_VERSION,
  baseSha: EXPECTED_BASE,
  promptSha256,
  promptBytes,
  sessionsAuthorized: SESSIONS.length,
  sessionsAttempted: 0,
  logicalProviderCalls: 0,
  preDispatchRefusals: [],
  ambiguousDispatches: [],
  runStatus: 'IN_PROGRESS',
  stoppedAt: null,
  sessions: [],
};
const persistState = () => fs.writeFileSync(path.join(DIR, 'SESSIONS.json'), JSON.stringify(state, null, 2) + '\n', 'utf8');
persistState();

for (const session of SESSIONS) {
  const startedAt = new Date().toISOString();
  const base = {
    protocolVersion: PROTOCOL_VERSION,
    briefVersion: BRIEF_VERSION,
    modelPinVersion: MODEL_PIN_VERSION,
    authorBlockId: session.authorBlockId,
    actualAuthorSessionId: session.actualAuthorSessionId,
    sessionType: 'INITIAL',
    providerRequested: session.provider,
    modelRequested: session.model,
    modelFamily: session.modelFamily,
    freshContextConfirmed: true,
    freshContextBasis: 'OPERATOR ATTESTATION - new SDK client, one stateless request containing only BRIEF_SENT.txt, no system prompt or prior turns. NOT independently verified.',
    promptSha256,
    promptBytes,
    maxTokensRequested: MAX_TOKENS,
    temperatureRequested: null,
    transportRetrySetting: session.provider === 'claude' ? 'maxRetries=0' : 'SDK 0.24.1 single-fetch path; no retry option',
    startedAt,
  };

  const record = { ...base, settledAt: null, outcome: 'DISPATCH_RESERVED' };
  state.sessions.push(record);
  state.sessionsAttempted += 1;
  state.logicalProviderCalls += 1;
  persistState();
  process.stderr.write(`\n--- ${session.actualAuthorSessionId} ${session.provider}/${session.model}\n`);

  let output;
  try {
    output = session.provider === 'claude'
      ? await callClaudeOnce(session.model, brief)
      : await callGeminiOnce(session.model, brief);
  } catch (error) {
    Object.assign(record, {
      settledAt: new Date().toISOString(),
      outcome: 'STOP_PROVIDER_ERROR',
      errorName: error?.name ?? null,
      errorStatus: error?.status ?? null,
      errorMessage: String(error?.message ?? error),
    });
    fs.writeFileSync(path.join(DIR, 'raw', `${session.actualAuthorSessionId}.error.json`), JSON.stringify(record, null, 2) + '\n', 'utf8');
    state.runStatus = 'INCOMPLETE';
    state.stoppedAt = session.actualAuthorSessionId;
    persistState();
    process.stderr.write(`STOP: ${record.errorMessage}\n`);
    process.exit(1);
  }

  const rawTextPath = path.join(DIR, 'raw', `${session.actualAuthorSessionId}.txt`);
  const rawResponsePath = path.join(DIR, 'raw', `${session.actualAuthorSessionId}.response.json`);
  fs.writeFileSync(rawTextPath, output.text, 'utf8');
  fs.writeFileSync(rawResponsePath, JSON.stringify(output.raw, null, 2), 'utf8');

  const modelMismatch = output.modelResolved !== null && output.modelResolved !== session.model;
  const validation = validateMechanically(output.text);
  Object.assign(record, {
    settledAt: new Date().toISOString(),
    providerResolved: output.providerResolved,
    modelResolved: output.modelResolved,
    resolvedIdentityObservable: output.modelResolved !== null,
    pinStatus: output.modelResolved === null ? 'OPERATOR_ATTESTATION' : 'OBSERVED',
    stopReason: output.stopReason,
    rawResponseSha256: sha256(output.text),
    rawResponseBytes: Buffer.byteLength(output.text, 'utf8'),
    mechanicalValidation: validation,
    outcome: modelMismatch
      ? 'STOP_MODEL_PIN_MISMATCH'
      : validation.ok ? 'RESPONSE_PRESERVED' : 'STOP_MALFORMED_RESPONSE',
  });
  persistState();

  if (modelMismatch || !validation.ok) {
    state.runStatus = 'INCOMPLETE';
    state.stoppedAt = session.actualAuthorSessionId;
    persistState();
    process.stderr.write(`STOP: ${record.outcome}\n`);
    process.exit(1);
  }
  process.stderr.write(`  bytes=${record.rawResponseBytes} sha=${record.rawResponseSha256.slice(0, 12)} count=${validation.scenarioCount}\n`);
}

state.runStatus = 'COMPLETE';
persistState();
process.stderr.write(`\nrun status: COMPLETE attempted ${state.sessionsAttempted}/${state.sessionsAuthorized}\n`);
