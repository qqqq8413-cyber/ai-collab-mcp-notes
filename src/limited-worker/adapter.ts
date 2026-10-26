import { z } from 'zod';
import type { ImplementationAgentPort, ImplementationInput, ImplementationResult } from '../automation/bridge.js';
import type { ControllerRun } from '../automation/types.js';
import type { InvocationJournal } from '../automation/invocation-journal.js';
import type { GovernedReadModelV1 } from '../automation/read-model/governed-read-model.js';
import { EXE, MODEL, contractOf, hash, maximumCost, checkQuote, assertInputReady, messageBody,serializeRequest, turnsOf, type Contract } from './contract.js';
import { verifyInvocation, verifyPermit } from './governance.js';
import { WorkerStore } from './store.js';
import { parsePreflight, type WorkerTransport } from './transport.js';
import { liveEligibility, verifyActivationSet } from './activation-set.js';

// M0: usage covers the whole invocation, so its bounds scale with the contract's request limit (1, or the reader's turns).
const replySchemaFor = (c: Contract) => z.object({ id: z.string().min(1).max(200), model: z.literal(MODEL), stop_reason: z.literal('end_turn'),
  content: z.array(z.object({ type: z.literal('text'), text: z.string(), citations: z.null().optional() }).strict()).min(1).max(20),
  usage: z.object({ input_tokens: z.number().int().min(0).max(c.maxInputTokens * turnsOf(c)), output_tokens: z.number().int().min(0).max(c.maxOutputTokens * turnsOf(c)),
    cache_creation_input_tokens: z.literal(0), cache_read_input_tokens: z.literal(0), service_tier: z.literal('standard') }) });
const safeReason = (e: unknown) => e instanceof Error && /^[A-Z0-9_]{1,100}$/.test(e.message) ? e.message : 'WORKER_FAILED_CLOSED';
export interface WorkerDependencies {
  store: WorkerStore; journal: InvocationJournal; transport: WorkerTransport; humanGrant: unknown; liveGrant: unknown;
  humanPrincipalRef: string; architectPrincipalRef:string; now(): string;
  readModel(): GovernedReadModelV1;
  readRun(runId: string): ControllerRun;
  readSource(c: Contract): { text: string; sha: string; path: string; bytes: number; hash: string };
  readGoal(c: Contract): string;
  implementationSha: string; workerCodeHash: string;
  currentImplementation(): { sha: string; codeHash: string; clean: boolean };
  /** Only tightens the fixed 300 second bound, for deterministic timeout tests. */
  deadlineMs?: number;
  /** S1: where committed ACTIVATION_SETs live, and whether this worker (the trusted Host's) requires one. */
  activationSetRoot?: string; requireActivationSet?: boolean;
}
export class LimitedReadmeWorker implements ImplementationAgentPort {
  readonly #d: WorkerDependencies;
  readonly #active = new Map<string, AbortController>();
  constructor(deps: WorkerDependencies) {
    if (deps.deadlineMs !== undefined && (!Number.isInteger(deps.deadlineMs) || deps.deadlineMs < 1 || deps.deadlineMs > 300000)) throw new Error('DEADLINE_LIMIT');
    this.#d = { ...deps, humanGrant: structuredClone(deps.humanGrant), liveGrant: structuredClone(deps.liveGrant) };
  }
  cancel(id: string): boolean { const active = this.#active.get(id); if (!active) return false; active.abort(new Error('USER_CANCEL')); return true; }
  async execute(input: Readonly<ImplementationInput>): Promise<ImplementationResult> {
    const d = this.#d, c = contractOf(input.packet), id = hash(c);
    if (d.transport.kind === 'LIVE_PROVIDER' && EXE === 'HOLD') return { status: 'HUMAN_STOP', reason: 'EXE_HOLD_NO_PROVIDER_REQUEST' };
    const check = () => {
      if (c.inputPolicy || d.transport.kind === 'LIVE_PROVIDER') assertInputReady(c);
      const identity = d.currentImplementation();
      if (!identity.clean || identity.sha !== c.implementationSha || identity.codeHash !== c.workerCodeHash) throw new Error('IMPLEMENTATION_CHANGED');
      if (c.implementationSha !== d.implementationSha || c.workerCodeHash !== d.workerCodeHash || c.storageIdentity !== d.store.identity() || input.runId !== c.runId || input.implementationIteration !== 1 || input.correction) throw new Error('IMPLEMENTATION_BINDING_MISMATCH');
      checkQuote(c.quote, d.now());
      const model = d.readModel();
      verifyPermit(c, { grant: d.humanGrant, liveGrant: d.liveGrant, model, packet: input.packet, humanPrincipalRef: d.humanPrincipalRef,architectPrincipalRef:d.architectPrincipalRef, now: d.now() });
      // S1: the trusted Host's worker (and any live provider call) re-verifies the complete committed set at every check,
      // including the final send guard; an unsigned set is never eligible for a live provider call.
      if (d.requireActivationSet || d.transport.kind === 'LIVE_PROVIDER') {
        const set = verifyActivationSet(d.activationSetRoot ?? d.store.directory, { contract: c, packet: input.packet, model, liveGrant: d.liveGrant, limitedGrant: d.humanGrant });
        if (d.transport.kind === 'LIVE_PROVIDER') { const live = liveEligibility(set); if (!live.eligible) throw new Error(live.reason); }
      }
      const record = input.invocationId ? d.journal.get(input.invocationId) : undefined;
      verifyInvocation(c, input.packet, d.readRun(c.runId), record);
      const source = d.readSource(c), objective = d.readGoal(c);
      if (source.sha !== c.sourceSha || source.path !== 'README.md' || source.bytes !== c.sourceBytes || Buffer.byteLength(source.text) !== c.sourceBytes || source.hash !== c.sourceHash || hash(Buffer.from(source.text)) !== c.sourceHash || hash(objective) !== c.objectiveHash) throw new Error('SOURCE_OR_GOAL_MISMATCH');
      messageBody(c, objective, source.text);
      return { source, objective };
    };
    let reserved = false, claimed = false;
    const abort = new AbortController();
    const grantExpiry = Date.parse((d.humanGrant as { expiresAt?: string } | null)?.expiresAt ?? '');
    const liveExpiry = Date.parse((d.liveGrant as { expiresAt?: string } | null)?.expiresAt ?? '');
    const duration = Math.max(1, Math.min(d.deadlineMs ?? 300000, grantExpiry - Date.parse(d.now()), liveExpiry - Date.parse(d.now()), Date.parse(c.quote.validUntil) - Date.parse(d.now())));
    const started = performance.now();
    const timer = setTimeout(() => abort.abort(new Error('WORKER_TIMEOUT')), Number.isFinite(duration) ? duration : 1);
    const bounded = async <T>(promise: Promise<T>) => Promise.race([promise, new Promise<never>((_, reject) => {
      if (abort.signal.aborted) reject(abort.signal.reason);
      else abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true });
    })]);
    try {
      const { source, objective } = check();
      d.store.reserve(id, maximumCost(c), input.invocationId!, d.now(), d.transport.kind === 'OFFLINE_SYNTHETIC'); reserved = true;
      this.#active.set(id, abort);
      const preflight = parsePreflight(await bounded(d.transport.preflight(c, abort.signal,{objective,source:source.text})));
      if ((preflight.requestHash&&preflight.requestHash!==hash(serializeRequest(messageBody(c,objective,source.text))))||
        (preflight.contractHash&&preflight.contractHash!==hash(c))||
        (d.transport.kind==='LIVE_PROVIDER'&&(!preflight.requestHash||!preflight.contractHash))||
        preflight.priceSourceHash !== c.quote.sourceSha256 || preflight.evidenceClass !== d.transport.kind ||
        Date.parse(preflight.observedAt) > Date.parse(d.now()) || Date.parse(d.now()) - Date.parse(preflight.observedAt) > 300000) throw new Error('PREFLIGHT_NOT_BOUND');
      d.store.change(id, j => { j.modelPreflight = preflight; j.events.push({ at: d.now(), kind: 'MODEL_PRICE_PREFLIGHT_VERIFIED' }); });
      check();
      if (performance.now() - started >= duration) abort.abort(new Error('WORKER_TIMEOUT'));
      if (abort.signal.aborted) throw abort.signal.reason;
      d.store.change(id, j => { if (j.generationClaimed) throw new Error('REQUEST_NOT_REPLAYABLE'); j.generationClaimed = true; j.events.push({ at: d.now(), kind: 'ONE_GENERATION_CLAIMED_BEFORE_SEND' }); });
      claimed = true;
      const beforeSend=()=>{
        check();
        const job=d.store.read().jobs.find(j=>j.id===id);
        if(!job||job.state!=='RUNNING'||!job.generationClaimed||job.invocationId!==input.invocationId||job.reservedMicroUsd!==maximumCost(c))throw new Error('FINAL_SEND_CLAIM_NOT_BOUND');
        if(performance.now()-started>=duration)abort.abort(new Error('WORKER_TIMEOUT'));
        if(abort.signal.aborted)throw abort.signal.reason;
      };
      beforeSend();
      const response = replySchemaFor(c).parse(await bounded(d.transport.generate(c, objective, source.text, abort.signal,beforeSend)));
      if (abort.signal.aborted) throw abort.signal.reason;
      const report = response.content.map(b => b.text).join('\n');
      if (!report.trim() || Buffer.byteLength(report) > 65536) throw new Error('REPORT_BYTES_LIMIT');
      const usage = { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
      const actualCostMicroUsd = usage.inputTokens * c.quote.inputMicroUsdPerToken + usage.outputTokens * c.quote.outputMicroUsdPerToken;
      if (actualCostMicroUsd > maximumCost(c)) throw new Error('USAGE_EXCEEDED_RESERVED_BOUND');
      d.store.writeReport(c, report);
      d.store.change(id, j => { j.state = 'COMPLETED'; j.report = report; j.reportHash = hash(report); j.usage = usage;
        j.actualCostMicroUsd = actualCostMicroUsd; j.providerMessageId = response.id; j.events.push({ at: d.now(), kind: 'RESULT_PERSISTED_NOT_AUTHORITY' }); });
      return { status: 'COMPLETED', validationEvidence: [`limited-worker:${id}`, `report-sha256:${hash(report)}`,
        `evidence-class:${d.transport.kind}`, `reserved-micro-usd:${maximumCost(c)}`, 'No Git writes, delivery, tools or other agents'] };
    } catch (error) {
      const reason = safeReason(abort.signal.aborted ? abort.signal.reason : error);
      if (reserved) d.store.change(id, j => { j.state = claimed ? 'UNCERTAIN' : reason === 'USER_CANCEL' ? 'CANCELLED' : reason === 'WORKER_TIMEOUT' ? 'TIMED_OUT' : 'BLOCKED';
        j.reason = reason; j.events.push({ at: d.now(), kind: claimed ? 'UNCERTAIN_NO_REPLAY_RESERVATION_RETAINED' : 'STOPPED_BEFORE_GENERATION' }); });
      else d.store.change(id, j => { if (j.state === 'PREPARED' && !j.invocationId) { j.state='BLOCKED';j.reason=reason;j.events.push({at:d.now(),kind:'REFUSED_BEFORE_RESERVATION'}); } });
      if (claimed) throw new Error(reason);
      return { status: 'HUMAN_STOP', reason };
    } finally { clearTimeout(timer); this.#active.delete(id); }
  }
}
