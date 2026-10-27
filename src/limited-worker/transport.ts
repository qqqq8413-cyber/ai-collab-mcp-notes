import { request } from 'node:https';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { API_VERSION, MODEL, PRICE_URL, EXE, checkQuote, hash, messageBody, serializeRequest, assertInputReady, type Contract, type Quote } from './contract.js';

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
/** Synchronous last local boundary. No await is allowed between validation and the write callback. */
export function dispatchGuarded(signal:AbortSignal,beforeSend:(()=>void)|undefined,send:()=>void) {
  if(signal.aborted)throw new Error('REQUEST_ABORTED');
  const result:unknown=beforeSend?.();
  if(result&&typeof result==='object'&&'then' in result)throw new Error('ASYNC_SEND_GUARD_FORBIDDEN');
  if(signal.aborted)throw new Error('REQUEST_ABORTED');
  send();
}
const modelMetadataSchema=z.object({id:z.literal(MODEL),type:z.literal('model'),lifecycle:z.literal('active'),
  max_input_tokens:z.literal(200000),max_tokens:z.number().int().min(2048),
  capabilities:z.object({thinking:z.object({types:z.object({disabled:z.object({supported:z.literal(true)})})})})});
export function boundedHttps(url: string, options: { method: 'GET' | 'POST'; signal: AbortSignal; headers?: Record<string, string>; body?: string;beforeSend?:()=>void;
  /** M1-C: the provider's request-id response header, for evidence. */ onRequestId?(id: string): void },requester:typeof request=request): Promise<string> {
  const target = new URL(url);
  const allowed = url === PRICE_URL || url === `https://api.anthropic.com/v1/models/${MODEL}` || url === 'https://api.anthropic.com/v1/messages';
  if (!allowed || target.username || target.password || options.signal.aborted ||
    (url.endsWith('/v1/messages') ? options.method !== 'POST' || !options.body : options.method !== 'GET' || options.body !== undefined)) return Promise.reject(new Error('TRANSPORT_REFUSED'));
  return new Promise((resolve, reject) => {
    try{options.beforeSend?.();}catch{reject(new Error('FINAL_SEND_GUARD_REFUSED'));return;}
    const req = requester(target, { method: options.method, signal: options.signal, agent: false, headers: options.headers }, response => {
      const requestId = response.headers?.['request-id'];
      if (typeof requestId === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(requestId)) options.onRequestId?.(requestId);
      if (response.statusCode !== 200) { response.resume(); reject(new Error('PROVIDER_HTTP_REFUSED')); return; }
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', b => { size += b.length; if (size > 512 * 1024) req.destroy(new Error('PROVIDER_OUTPUT_BYTES')); else chunks.push(b); });
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); response.on('error', reject);
    });
    req.once('error', () => reject(new Error(options.signal.aborted ? 'REQUEST_ABORTED' : 'PROVIDER_TRANSPORT_UNCERTAIN')));
    req.once('socket',socket=>{
      const send=()=>{try{dispatchGuarded(options.signal,options.beforeSend,()=>{if(options.body)req.write(options.body);req.end();});}
        catch{req.destroy(new Error('FINAL_SEND_GUARD_REFUSED'));}};
      if(socket.connecting||(socket as unknown as {secureConnecting?:boolean}).secureConnecting)socket.once('secureConnect',send);
      else send();
    });
  });
}
export async function fetchOfficialQuote(now: string): Promise<Quote> {
  return tariffFromMarkdown(await boundedHttps(PRICE_URL, { method: 'GET', signal: AbortSignal.timeout(10000) }), now);
}
const preflightSchema = z.strictObject({ evidenceClass: z.enum(['LIVE_PROVIDER','OFFLINE_SYNTHETIC']), model: z.literal(MODEL), apiVersion: z.literal(API_VERSION),
  maxInputTokens: z.literal(200000), maxOutputTokens: z.literal(2048), priceSourceHash: z.string().regex(/^[a-f0-9]{64}$/), observedAt: z.iso.datetime(),
  requestHash:z.string().regex(/^[a-f0-9]{64}$/).optional(),contractHash:z.string().regex(/^[a-f0-9]{64}$/).optional() });
export type PreflightFact = z.infer<typeof preflightSchema>;
export function parsePreflight(v: unknown): PreflightFact { return preflightSchema.parse(v); }
export interface ProviderReply { id: string; model: string; content: Array<{ type: string; text?: string }>; stop_reason: string;
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number; service_tier: string };
  /** M1-C: the provider's request-id header, when the transport saw one (evidence, never trusted for binding). */
  requestId?: string }
export interface WorkerTransport {
  readonly kind: 'LIVE_PROVIDER' | 'OFFLINE_SYNTHETIC';
  preflight(c: Contract, signal: AbortSignal,payload?:{objective:string;source:string}): Promise<PreflightFact>;
  generate(c: Contract, objective: string, source: string, signal: AbortSignal,beforeSend?:()=>void): Promise<ProviderReply>;
}
export function verifyAnthropicPreflight(c:Contract,input:{priceDocument:string;model:unknown;objective:string;source:string},now:string,kind:'LIVE_PROVIDER'|'OFFLINE_SYNTHETIC'):PreflightFact {
  assertInputReady(c);checkQuote(c.quote,now);
  if(hash(input.priceDocument)!==c.quote.sourceSha256)throw new Error('PRICE_SNAPSHOT_CHANGED');
  tariffFromMarkdown(input.priceDocument,now);
  const metadata=modelMetadataSchema.safeParse(input.model);
  if(!metadata.success||metadata.data.max_tokens<c.maxOutputTokens)throw new Error('ACCOUNT_MODEL_NOT_VERIFIED');
  const wire=serializeRequest(messageBody(c,input.objective,input.source));
  return parsePreflight({evidenceClass:kind,model:MODEL,apiVersion:API_VERSION,maxInputTokens:200000,maxOutputTokens:2048,
    priceSourceHash:c.quote.sourceSha256,observedAt:now,requestHash:hash(wire),contractHash:hash(c)});
}
/** No built-in network or credential lookup. Trusted test I/O supplies explicitly synthetic responses. */
export function offlineAnthropicTransport(io:{price(c:Contract,signal:AbortSignal):Promise<string>;model(c:Contract,signal:AbortSignal):Promise<unknown>;
  send(c:Contract,wire:string,signal:AbortSignal):Promise<ProviderReply>;ready?(signal:AbortSignal):Promise<void>;now():string}):WorkerTransport {
  return Object.freeze({kind:'OFFLINE_SYNTHETIC' as const,
    async preflight(c:Contract,signal:AbortSignal,payload?:{objective:string;source:string}){if(!payload)throw new Error('PREFLIGHT_INPUT_REQUIRED');
      const priceDocument=await io.price(c,signal),model=await io.model(c,signal);
      return verifyAnthropicPreflight(c,{...payload,priceDocument,model},io.now(),'OFFLINE_SYNTHETIC');},
    async generate(c:Contract,objective:string,source:string,signal:AbortSignal,beforeSend?:()=>void){if(!beforeSend)throw new Error('FINAL_SEND_GUARD_REQUIRED');
      const wire=serializeRequest(messageBody(c,objective,source));let sent:Promise<ProviderReply>|undefined;
      await io.ready?.(signal);
      dispatchGuarded(signal,beforeSend,()=>{sent=io.send(c,wire,signal);});return sent!;},
  });
}
/**
 * Trusted host only; API credentials never enter prompts, files, journals, UI or error messages. No SDK, retry, redirect or tool loop.
 * `requester` replaces node:https only in tests (a local TLS server); production passes nothing.
 */
export function nativeAnthropicTransport(apiKey: () => string, options: { requester?: typeof request } = {}): WorkerTransport {
  const requester = options.requester ?? request;
  const headers = () => {
    const key = apiKey(); if (!key || /[\r\n]/.test(key)) throw new Error('CREDENTIAL_NOT_CONFIGURED');
    return { 'x-api-key': key, 'anthropic-version': API_VERSION, 'content-type': 'application/json' };
  };
  return Object.freeze({ kind: 'LIVE_PROVIDER' as const,
    async preflight(c: Contract, signal: AbortSignal,payload?:{objective:string;source:string}) {
      if (EXE === 'HOLD') throw new Error('EXE_HOLD');
      assertInputReady(c);
      if(!payload)throw new Error('PREFLIGHT_INPUT_REQUIRED');
      messageBody(c,payload.objective,payload.source);checkQuote(c.quote,new Date().toISOString());
      const doc = await boundedHttps(PRICE_URL, { method: 'GET', signal }, requester);
      if (hash(doc) !== c.quote.sourceSha256) throw new Error('PRICE_SNAPSHOT_CHANGED');
      tariffFromMarkdown(doc, new Date().toISOString());
      const model = JSON.parse(await boundedHttps(`https://api.anthropic.com/v1/models/${MODEL}`, { method: 'GET', signal, headers: headers() }, requester));
      return verifyAnthropicPreflight(c,{...payload,priceDocument:doc,model},new Date().toISOString(),'LIVE_PROVIDER');
    },
    async generate(c: Contract, objective: string, source: string, signal: AbortSignal,beforeSend?:()=>void) {
      if (EXE === 'HOLD') throw new Error('EXE_HOLD');
      assertInputReady(c);
      if(!beforeSend)throw new Error('FINAL_SEND_GUARD_REQUIRED');
      const body=serializeRequest(messageBody(c,objective,source)),credentialHeaders=headers();
      let requestId: string | undefined;
      const reply = JSON.parse(await boundedHttps('https://api.anthropic.com/v1/messages', { method: 'POST', signal, headers:credentialHeaders,body,beforeSend,
        onRequestId: (id) => { requestId = id; } }, requester)) as ProviderReply;
      return requestId && reply && typeof reply === 'object' ? { ...reply, requestId } : reply;
    },
  });
}
/**
 * M0: one transport per agent. Every transport must be the same kind, so a Host is wholly OFFLINE_SYNTHETIC or
 * wholly LIVE_PROVIDER and the kind the service reports is never mixed.
 */
export function agentTransports(transports: Readonly<Partial<Record<Contract['agentId'], WorkerTransport>>>): WorkerTransport {
  const kinds = new Set(Object.values(transports).map((t) => t!.kind));
  if (kinds.size !== 1) throw new Error('TRANSPORT_KIND_MIXED');
  const pick = (c: Contract) => { const t = transports[c.agentId]; if (!t) throw new Error('AGENT_TRANSPORT_UNAVAILABLE'); return t; };
  return Object.freeze({ kind: [...kinds][0]!,
    preflight: async (c: Contract, signal: AbortSignal, payload?: { objective: string; source: string }) => pick(c).preflight(c, signal, payload),
    generate: async (c: Contract, objective: string, source: string, signal: AbortSignal, beforeSend?: () => void) => pick(c).generate(c, objective, source, signal, beforeSend) });
}
/** A live agent this Host has not configured: under EXE HOLD it reports the hold first, otherwise the missing setup. */
export function unconfiguredLiveTransport(reason: string): WorkerTransport {
  const refuse = async (): Promise<never> => { throw new Error(EXE === 'HOLD' ? 'EXE_HOLD' : reason); };
  return Object.freeze({ kind: 'LIVE_PROVIDER' as const, preflight: refuse, generate: refuse });
}
