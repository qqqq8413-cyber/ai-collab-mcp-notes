/**
 * CBRP authoring round 0 — five initial sessions, one logical call each.
 *
 * Calls the vendor SDKs directly rather than going through src/providers so that the
 * resolved model identity in the response body can be recorded. CWP-8D allows
 * `modelResolved: null` when identity is unobservable; observing it is strictly better
 * evidence, and it is what makes the requested-vs-resolved STOP in CWP-9A §8 mean
 * anything at all.
 *
 * Raw responses are written before any parsing. Extraction happens in a separate offline
 * pass, so an extraction failure still leaves the author's bytes on disk.
 *
 * STOP semantics: the first failure halts the run. Later blocks are NOT attempted, and
 * no model is ever substituted.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const MODEL_PIN_VERSION = 'CBRP-SESSION-MODEL-PINS-1';
const MAX_TOKENS = 32000;

/** Byte-identical to every session, by construction: read once, sent unchanged. */
const BRIEF = fs.readFileSync(path.join(DIR, 'BRIEF_SENT.txt'), 'utf8');
const BRIEF_SHA = sha256(BRIEF);

const SESSIONS = [
  { authorBlockId: 'AUTHOR-B01', actualAuthorSessionId: 'AUTHOR-B01-S00', provider: 'claude', model: 'claude-sonnet-5',  modelFamily: 'CLAUDE_FAMILY' },
  { authorBlockId: 'AUTHOR-B02', actualAuthorSessionId: 'AUTHOR-B02-S00', provider: 'gemini', model: 'gemini-3.7-flash', modelFamily: 'GEMINI_FAMILY' },
  { authorBlockId: 'AUTHOR-B03', actualAuthorSessionId: 'AUTHOR-B03-S00', provider: 'claude', model: 'claude-sonnet-5',  modelFamily: 'CLAUDE_FAMILY' },
  { authorBlockId: 'AUTHOR-B04', actualAuthorSessionId: 'AUTHOR-B04-S00', provider: 'gemini', model: 'gemini-3.7-flash', modelFamily: 'GEMINI_FAMILY' },
  { authorBlockId: 'AUTHOR-B05', actualAuthorSessionId: 'AUTHOR-B05-S00', provider: 'claude', model: 'claude-sonnet-5',  modelFamily: 'CLAUDE_FAMILY' },
];

function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * One logical call, one HTTP attempt: transport retry is disabled where the SDK has it.
 *
 * Streamed because the SDK refuses a non-streaming request at this max_tokens before it
 * dispatches anything. Lowering max_tokens instead would trade a client-side guard for a
 * real truncation risk, and a truncated authoring response is an unrecoverable STOP under
 * CWP-9A §7. `finalMessage()` returns the same assembled message a non-streaming call
 * would have, so the recorded evidence is unchanged.
 */
async function callClaudeOnce(model, prompt) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
  const stream = client.messages.stream({
    model,
    max_tokens: MAX_TOKENS,
    messages: [{ role: 'user', content: prompt }],
  });
  const response = await stream.finalMessage();
  if (response.stop_reason === 'max_tokens') {
    throw new Error(`TRUNCATED: stop_reason=max_tokens at max_tokens=${MAX_TOKENS}`);
  }
  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  return {
    text,
    raw: response,
    modelResolved: response.model ?? null,
    providerResolved: 'claude',
    stopReason: response.stop_reason ?? null,
  };
}

/**
 * @google/generative-ai 0.24.1 has no retry to disable: makeRequest awaits fetch once.
 * That is the property proven against these exact bytes in test-m2b-transport-policy.mjs.
 */
async function callGeminiOnce(model, prompt) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const genModel = genAI.getGenerativeModel({ model });
  const result = await genModel.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: MAX_TOKENS },
  });
  const response = result.response;
  const finishReason = response.candidates?.[0]?.finishReason ?? null;
  if (finishReason && finishReason !== 'STOP') {
    throw new Error(`TRUNCATED OR BLOCKED: finishReason=${finishReason}`);
  }
  return {
    text: response.text(),
    raw: response,
    // The legacy SDK surfaces modelVersion only on some API versions; null when absent.
    modelResolved: response.modelVersion ?? null,
    providerResolved: 'gemini',
    stopReason: finishReason,
  };
}

const records = [];
let stopped = null;

for (const session of SESSIONS) {
  const startedAt = new Date().toISOString();
  const base = {
    modelPinVersion: MODEL_PIN_VERSION,
    authorBlockId: session.authorBlockId,
    actualAuthorSessionId: session.actualAuthorSessionId,
    sessionType: 'INITIAL',
    providerRequested: session.provider,
    modelRequested: session.model,
    modelFamily: session.modelFamily,
    freshContextConfirmed: true,
    freshContextBasis:
      'OPERATOR ATTESTATION — one stateless API request carrying only the frozen brief; ' +
      'no conversation id, no prior turns, no system prompt. NOT independently verified.',
    authoringBriefSha256: BRIEF_SHA,
    maxTokensRequested: MAX_TOKENS,
    temperatureRequested: null,
    transportMaxRetries: session.provider === 'claude' ? 0 : 'n/a — SDK has no retry',
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
  const rawPath = path.join(DIR, 'raw', `${session.actualAuthorSessionId}.txt`);
  fs.writeFileSync(rawPath, out.text, 'utf8');
  fs.writeFileSync(
    path.join(DIR, 'raw', `${session.actualAuthorSessionId}.response.json`),
    JSON.stringify(out.raw, null, 2),
    'utf8'
  );

  const mismatch =
    out.modelResolved !== null && out.modelResolved !== session.model;

  const record = {
    ...base,
    settledAt: new Date().toISOString(),
    providerResolved: out.providerResolved,
    modelResolved: out.modelResolved,
    resolvedIdentityObservable: out.modelResolved !== null,
    pinStatus: out.modelResolved === null ? 'OPERATOR ATTESTATION' : 'OBSERVED',
    stopReason: out.stopReason ?? null,
    rawResponseSha256: sha256(out.text),
    rawResponseBytes: Buffer.byteLength(out.text, 'utf8'),
    outcome: mismatch ? 'STOP_MODEL_PIN_MISMATCH' : 'RESPONSE_PRESERVED',
  };
  records.push(record);
  process.stderr.write(
    `  resolved=${out.modelResolved ?? 'null'}  bytes=${record.rawResponseBytes}  sha=${record.rawResponseSha256.slice(0, 12)}\n`
  );

  if (mismatch) {
    stopped = record;
    process.stderr.write(`STOP: resolved ${out.modelResolved} != requested ${session.model}\n`);
    break;
  }
}

fs.writeFileSync(
  path.join(DIR, 'SESSIONS.json'),
  JSON.stringify(
    {
      runId: 'CBRP-AUTHORING-ROUND-0',
      modelPinVersion: MODEL_PIN_VERSION,
      authoringBriefSha256: BRIEF_SHA,
      authoringBriefBytes: Buffer.byteLength(BRIEF, 'utf8'),
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

process.stderr.write(`\nrun status: ${stopped ? 'INCOMPLETE' : 'COMPLETE'}  attempted ${records.length}/${SESSIONS.length}\n`);
process.exit(stopped ? 1 : 0);
