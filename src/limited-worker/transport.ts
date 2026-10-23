import { request } from 'node:https';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { API_VERSION, MODEL, PRICE_URL, EXE, checkQuote, hash, messageBody, assertInputReady, type Contract, type Quote } from './contract.js';

type Token = { type: string; content: string; children?: Token[] };
const MarkdownIt = createRequire(import.meta.url)('markdown-it') as new (options: object) => { parse(text: string, env: object): Token[] };
const markdown = new MarkdownIt({ html: false });
const plain = (t: Token): string => t.children ? t.children.map(plain).join('') : ['text', 'code_inline'].includes(t.type) ? t.content : '';
export function tariffFromMarkdown(text: string, now: string): Quote {
  const tokens = markdown.parse(text, {}), tables = new Map<string, Map<string, string>>();
  let section = '', cells: string[] = [], row = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'heading_open') section = plain(tokens[i + 1]);
    if (t.type === 'tr_open') { row = true; cells = []; }
    if (row && t.type === 'inline') cells.push(plain(t));
    if (t.type === 'tr_close') {
      row = false; if (cells.length !== 2) continue;
      if (!tables.has(section)) tables.set(section, new Map());
      const table = tables.get(section)!; if (table.has(cells[0])) throw new Error('PRICE_DOCUMENT_AMBIGUOUS'); table.set(cells[0], cells[1]);
    }
  }
  if (tables.get('Model IDs')?.get('Claude API') !== MODEL || tables.get('Pricing')?.get('Input') !== '$1 / MTok' ||
    tables.get('Pricing')?.get('Output') !== '$5 / MTok' || tables.get('Capabilities')?.get('Context window') !== '200K tokens' ||
    tables.get('Availability')?.get('Status') !== 'Active (legacy)') throw new Error('MODEL_OR_PRICE_NOT_VERIFIED');
  return checkQuote({ model: MODEL, apiVersion: API_VERSION, sourceUrl: PRICE_URL, sourceSha256: hash(text), checkedAt: now,
    validUntil: new Date(Date.parse(now) + 3600000).toISOString(), inputMicroUsdPerToken: 1, outputMicroUsdPerToken: 5,
    maxInputTokens: 200000, maxOutputTokens: 2048 }, now);
}
export function boundedHttps(url: string, options: { method: 'GET' | 'POST'; signal: AbortSignal; headers?: Record<string, string>; body?: string }): Promise<string> {
  const target = new URL(url);
  const allowed = url === PRICE_URL || url === `https://api.anthropic.com/v1/models/${MODEL}` || url === 'https://api.anthropic.com/v1/messages';
  if (!allowed || target.username || target.password || options.signal.aborted ||
    (url.endsWith('/v1/messages') ? options.method !== 'POST' || !options.body : options.method !== 'GET' || options.body !== undefined)) return Promise.reject(new Error('TRANSPORT_REFUSED'));
  return new Promise((resolve, reject) => {
    const req = request(target, { method: options.method, signal: options.signal, agent: false, headers: options.headers }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error('PROVIDER_HTTP_REFUSED')); return; }
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', b => { size += b.length; if (size > 512 * 1024) req.destroy(new Error('PROVIDER_OUTPUT_BYTES')); else chunks.push(b); });
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); response.on('error', reject);
    });
    req.once('error', () => reject(new Error(options.signal.aborted ? 'REQUEST_ABORTED' : 'PROVIDER_TRANSPORT_UNCERTAIN')));
    if (options.body) req.write(options.body); req.end();
  });
}
export async function fetchOfficialQuote(now: string): Promise<Quote> {
  return tariffFromMarkdown(await boundedHttps(PRICE_URL, { method: 'GET', signal: AbortSignal.timeout(10000) }), now);
}
const preflightSchema = z.strictObject({ evidenceClass: z.enum(['LIVE_PROVIDER','OFFLINE_SYNTHETIC']), model: z.literal(MODEL), apiVersion: z.literal(API_VERSION),
  maxInputTokens: z.literal(200000), maxOutputTokens: z.literal(2048), priceSourceHash: z.string().regex(/^[a-f0-9]{64}$/), observedAt: z.iso.datetime() });
export type PreflightFact = z.infer<typeof preflightSchema>;
export function parsePreflight(v: unknown): PreflightFact { return preflightSchema.parse(v); }
export interface ProviderReply { id: string; model: string; content: Array<{ type: string; text?: string }>; stop_reason: string;
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number; service_tier: string } }
export interface WorkerTransport {
  readonly kind: 'LIVE_PROVIDER' | 'OFFLINE_SYNTHETIC';
  preflight(c: Contract, signal: AbortSignal): Promise<PreflightFact>;
  generate(c: Contract, objective: string, source: string, signal: AbortSignal): Promise<ProviderReply>;
}
/** Trusted host only; API credentials never enter prompts, files, journals, UI or error messages. No SDK, retry, redirect or tool loop. */
export function nativeAnthropicTransport(apiKey: () => string): WorkerTransport {
  const headers = () => {
    const key = apiKey(); if (!key || /[\r\n]/.test(key)) throw new Error('CREDENTIAL_NOT_CONFIGURED');
    return { 'x-api-key': key, 'anthropic-version': API_VERSION, 'content-type': 'application/json' };
  };
  return Object.freeze({ kind: 'LIVE_PROVIDER' as const,
    async preflight(c: Contract, signal: AbortSignal) {
      if (EXE === 'HOLD') throw new Error('EXE_HOLD');
      assertInputReady(c);
      const doc = await boundedHttps(PRICE_URL, { method: 'GET', signal });
      if (hash(doc) !== c.quote.sourceSha256) throw new Error('PRICE_SNAPSHOT_CHANGED');
      tariffFromMarkdown(doc, new Date().toISOString());
      const model = JSON.parse(await boundedHttps(`https://api.anthropic.com/v1/models/${MODEL}`, { method: 'GET', signal, headers: headers() }));
      if (model.id !== MODEL || model.type !== 'model' || ('lifecycle' in model && model.lifecycle !== 'active') || model.max_input_tokens !== 200000 ||
        !Number.isSafeInteger(model.max_tokens) || model.max_tokens < c.maxOutputTokens || model.capabilities?.thinking?.types?.disabled?.supported !== true) throw new Error('ACCOUNT_MODEL_NOT_VERIFIED');
      return parsePreflight({ evidenceClass:'LIVE_PROVIDER',model:MODEL,apiVersion:API_VERSION,maxInputTokens:200000,maxOutputTokens:2048,
        priceSourceHash:c.quote.sourceSha256,observedAt:new Date().toISOString() });
    },
    async generate(c: Contract, objective: string, source: string, signal: AbortSignal) {
      if (EXE === 'HOLD') throw new Error('EXE_HOLD');
      assertInputReady(c);
      return JSON.parse(await boundedHttps('https://api.anthropic.com/v1/messages', { method: 'POST', signal, headers: headers(), body: JSON.stringify(messageBody(c, objective, source)) })) as ProviderReply;
    },
  });
}
