import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGovernedLimitedWorker } from '../automation/live/governed-execution.js';
import { startTrustedWorkspaceHost } from '../intake/workspace-host.js';
import { parseTrustedWorkspaceHostConfig } from '../intake/workspace-host-config.js';
import type { Clock } from '../automation/types.js';
import type { RunningWorkspace } from '../workspace/server.js';
import { claudeCodeReaderTransport, offlineReaderRunner } from './claude-code-reader.js';
import { limitedLedgerEvidence } from './composition.js';
import { MODEL, REPOSITORY, SCOPE, canonical, hash, packetFor, type Contract } from './contract.js';
import { createLimitedWorkerService } from './service.js';
import { WorkerStore } from './store.js';
import { agentTransports, offlineAnthropicTransport, tariffFromMarkdown, type ProviderReply } from './transport.js';

// M0 OFFLINE_SYNTHETIC rehearsal Host. It runs the real Workspace, Goal/GC1/RA1, trusted activation (archive,
// ACTIVATION_SET, AP1), Controller, Driver, Runner, Invocation Journal and Worker exactly as the trusted Host would,
// but in its own data directory, under synthetic principals, with offline agents only: no provider, network route,
// credential or paid call exists here. When the Human approves a job, this Host itself writes that job's three
// documents as OFFLINE_SYNTHETIC rehearsal records; they name the rehearsal principals, are never Human or
// Architect authority, and an unsigned set is never live-eligible. Nothing here can reach a real data directory,
// and the real Host (main.ts) never loads this module.

export const REHEARSAL_HUMAN = 'human:offline-synthetic-rehearsal';
export const REHEARSAL_ARCHITECT = 'architect:offline-synthetic-rehearsal';
export const REHEARSAL_PROJECT = 'chief';
export const REHEARSAL_PRICE_DOCUMENT = `### Model IDs\n| Platform | Model ID |\n|---|---|\n| Claude API | ${MODEL} |\n### Pricing\n| Feature | Value |\n|---|---|\n| Input | $1 / MTok |\n| Output | $5 / MTok |\n### Capabilities\n| Feature | Value |\n|---|---|\n| Context window | 200K tokens |\n### Availability\n| Feature | Value |\n|---|---|\n| Status | Active (legacy) |`;
const MODEL_METADATA = Object.freeze({ id: MODEL, type: 'model', lifecycle: 'active', max_input_tokens: 200000, max_tokens: 64000,
  capabilities: { thinking: { types: { disabled: { supported: true } } } } });
const HERE = dirname(fileURLToPath(import.meta.url));
export const OFFLINE_READER_EXECUTABLE = join(HERE, 'offline-claude-code-reader.js');

type Source = { text: string; sha: string; path: 'README.md'; bytes: number; hash: string };
type GovernedWorker = ReturnType<typeof createGovernedLimitedWorker>;

/** The rehearsal's data layout: every store is a fresh directory under one root. */
export function rehearsalLayout(dataDirectory: string) {
  const at = (...parts: string[]) => join(dataDirectory, ...parts);
  return { goals: at('goals'), registry: at('governance', 'registry'), controller: at('governance', 'controller'), authority: at('governance', 'authority'),
    results: at('worker', 'results'), journal: at('worker', 'journal'), readerWorkspaces: at('worker', 'reader-workspaces'),
    copies: at('rehearsal', 'issued-documents'), readerRuns: at('rehearsal', 'offline-reader-runs.log') };
}

/** A deterministic, plainly labelled README review for the offline README Worker (no model). */
function syntheticReadmeReply(wire: string): ProviderReply {
  const body = JSON.parse(wire) as { messages: Array<{ content: string }> };
  const input = JSON.parse(body.messages[0].content) as { goal: string; source: { text: string } };
  const lines = input.source.text.split('\n'), headings = lines.map((line, i) => [i + 1, line] as const).filter(([, line]) => /^#{1,6} /.test(line)).slice(0, 12);
  const text = ['# OFFLINE_SYNTHETIC README 審查', '', '> **OFFLINE_SYNTHETIC**：離線合成回覆，只用來驗證流程，**不是真實 AI 成果，沒有呼叫任何模型。**', '',
    '## 任務', '', `> ${input.goal.replace(/[\r\n]+/g, ' ').slice(0, 400)}`, '', '## 文件結構', '',
    ...(headings.length ? headings.map(([n, line]) => `- 第 ${n} 行：${line.replace(/^#+\s*/, '').slice(0, 200)}`) : ['- 沒有找到 Markdown 標題。']), ''].join('\n');
  return { id: `offline-synthetic-${randomUUID()}`, model: MODEL, stop_reason: 'end_turn', content: [{ type: 'text', text }],
    usage: { input_tokens: Math.ceil(wire.length / 4), output_tokens: Math.min(2048, Math.ceil(text.length / 2)), cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0, service_tier: 'standard' } };
}

/**
 * The Workspace runtime for the rehearsal: one trusted governed Worker per approved job (its synthetic grants are
 * per job), plus one without grants for views. START writes the job's rehearsal documents once, stages them
 * through the trusted activation (idempotent) and executes.
 */
function rehearsalRuntime(common: Omit<Parameters<typeof createGovernedLimitedWorker>[0], 'liveCallGrant' | 'limitedGrant'>, copies: string) {
  const base = createGovernedLimitedWorker({ ...common, liveCallGrant: null, limitedGrant: null });
  const issued = new Map<string, GovernedWorker>();
  const fileOf = (c: Contract) => join(copies, `${hash(c)}.json`);
  type Copy = { bundle: { implementationPacket: { body: unknown }; liveCallAuthorizations: [{ body: unknown }] }; limitedDocument: { body: unknown } };
  const copyOf = (c: Contract): Copy | null => existsSync(fileOf(c)) ? JSON.parse(readFileSync(fileOf(c), 'utf8')) as Copy : null;
  const workerFor = (c: Contract): GovernedWorker | null => {
    const known = issued.get(hash(c)); if (known) return known;
    const copy = copyOf(c); if (!copy) return null;
    const worker = createGovernedLimitedWorker({ ...common, liveCallGrant: copy.bundle.liveCallAuthorizations[0].body, limitedGrant: copy.limitedDocument.body });
    issued.set(hash(c), worker);
    return worker;
  };
  const issue = (c: Contract): Copy => {
    const sliceId = base.inspect(c).driver.change?.changeId;
    if (!sliceId) throw new Error('REHEARSAL_RUN_NOT_ADMITTED');
    const packet = packetFor(c, sliceId), now = common.clock.now(), expiresAt = new Date(Date.parse(now) + 30 * 60_000).toISOString(), key = hash(c).slice(0, 24);
    const grant = (operation: string, target: string, authorizationId: string) => ({ authorizationId, actorRole: 'HUMAN', operation, target,
      runId: c.runId, packetId: packet.packetId, scope: { ...SCOPE, egressDestinations: [...SCOPE.egressDestinations] }, issuedAt: now, expiresAt,
      reason: 'OFFLINE_SYNTHETIC rehearsal record: not Human authority, never live-eligible' });
    const document = (kind: 'IMPLEMENTATION_PACKET' | 'AUTHORIZATION', body: { packetId?: string; authorizationId?: string }) => ({
      schemaVersion: 1, recordClass: 'DIRECT_AUTHORITY', kind, authorityId: kind === 'IMPLEMENTATION_PACKET' ? body.packetId : body.authorizationId,
      version: 1, issuedAt: now, issuer: kind === 'IMPLEMENTATION_PACKET' ? { role: 'GPT_ARCHITECT', principalRef: REHEARSAL_ARCHITECT } : { role: 'HUMAN', principalRef: REHEARSAL_HUMAN },
      subject: { repository: c.repository, sliceId: packet.sliceId }, supersedes: null, body });
    const copy = { evidenceClass: 'OFFLINE_SYNTHETIC', notice: 'Rehearsal records written by the offline rehearsal Host; not authority.',
      bundle: { implementationPacket: document('IMPLEMENTATION_PACKET', packet), liveCallAuthorizations: [document('AUTHORIZATION', grant('LIVE_PROVIDER_MODEL_CALL', 'live-provider-model-call', `rehearsal-live-${key}`))] },
      limitedDocument: document('AUTHORIZATION', grant('LIMITED_README_WORKER', hash(c), `rehearsal-limited-${key}`)) };
    mkdirSync(copies, { recursive: true, mode: 0o700 });
    writeFileSync(fileOf(c), JSON.stringify(copy), { mode: 0o600, flag: 'wx' });
    return copy as unknown as Copy;
  };
  return Object.freeze({ transportKind: 'OFFLINE_SYNTHETIC' as const,
    permit: (c: Contract) => (workerFor(c) ?? base).permit(c),
    inspect: (c: Contract) => base.inspect(c),
    resultConsistency: (c: Contract) => base.resultConsistency(c),
    cancel: (c: Contract) => (workerFor(c) ?? base).cancel(c),
    activateIssued(): never { throw new Error('REHEARSAL_ACTIVATES_ON_START'); },
    async execute(c: Contract) {
      const copy = copyOf(c) ?? issue(c), worker = workerFor(c)!;
      worker.activateIssued(c, copy.bundle, copy.limitedDocument);
      return worker.execute(c);
    } });
}

export interface RehearsalHostOptions {
  dataDirectory: string; port: number; uiDirectory: string; clock?: Clock;
  /** The running implementation (Git SHA, compiled Worker code hash, clean tree): bound into every contract. */
  identity(): { sha: string; codeHash: string; clean: boolean };
  /** The pinned README for new plans, and for a contract's source SHA. */
  source(): Source; readSource(c: Contract): Source;
}
export interface RehearsalHost { readonly url: string; readonly port: number; readonly workspace: RunningWorkspace; close(): Promise<void> }

export async function startRehearsalHost(options: RehearsalHostOptions): Promise<RehearsalHost> {
  const layout = rehearsalLayout(options.dataDirectory), clock = options.clock ?? { now: () => new Date().toISOString() };
  for (const path of [layout.goals, layout.registry, layout.controller, layout.authority, dirname(layout.results), dirname(layout.copies)]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  const config = parseTrustedWorkspaceHostConfig({ schemaVersion: 1,
    workspace: { schemaVersion: 1, dataDirectory: layout.goals, humanPrincipal: { principalRef: REHEARSAL_HUMAN },
      projects: [{ projectId: REHEARSAL_PROJECT, displayName: 'CHIEF（OFFLINE_SYNTHETIC 演練）', repository: REPOSITORY }] },
    governance: { changeRegistryDirectory: layout.registry, controllerStoreDirectory: layout.controller,
      repositories: [{ projectId: REHEARSAL_PROJECT, repository: REPOSITORY }],
      executionStatus: { authorityArchiveDirectory: layout.authority, architectPrincipalRef: REHEARSAL_ARCHITECT } } }, options.dataDirectory);
  const roots = { controllerStoreDirectory: layout.controller, authorityArchiveDirectory: layout.authority, changeRegistryDirectory: layout.registry };
  const store = new WorkerStore(layout.results, { initializationEvidence: limitedLedgerEvidence(roots, clock) });
  // Startup recovery runs under the runtime lease and releases it: the trusted governed Worker takes that same lease
  // around every activation and execution (and recovers again inside it), so a process-long lease would refuse them.
  const startup = store.lease();
  try { store.recover(clock.now()); } finally { startup(); }
  {
    const io = { price: async () => REHEARSAL_PRICE_DOCUMENT, model: async () => structuredClone(MODEL_METADATA), now: () => clock.now() };
    const readerSha256 = createHash('sha256').update(readFileSync(OFFLINE_READER_EXECUTABLE)).digest('hex');
    const transport = agentTransports({
      'limited-readme-worker': offlineAnthropicTransport({ ...io, send: async (_c, wire) => syntheticReadmeReply(wire) }),
      'claude-code-reader': claudeCodeReaderTransport({ executable: OFFLINE_READER_EXECUTABLE, executableSha256: readerSha256, workspaceRoot: layout.readerWorkspaces },
        offlineReaderRunner({ onRun: (request) => appendFileSync(layout.readerRuns, `${canonical({ at: clock.now(), invocationKey: request.invocationKey })}\n`, { mode: 0o600 }) }), io),
    });
    const identity = options.identity();
    const workspace = await startTrustedWorkspaceHost({ config, uiDirectory: options.uiDirectory, port: options.port,
      limitedWorkerFactory: (ports) => {
        // As in the real Host: the goal text comes from the Workspace Goal Store and must be the rehearsal Human's.
        const runtime = rehearsalRuntime({ ...roots, journalDirectory: layout.journal, resultDirectory: layout.results,
          architectPrincipalRef: REHEARSAL_ARCHITECT, humanPrincipalRef: REHEARSAL_HUMAN, implementationSha: identity.sha, workerCodeHash: identity.codeHash,
          clock, transport, currentImplementation: options.identity, readSource: options.readSource,
          readGoal: (c) => {
            const goal = ports.store.read(c.projectId).goals.find((g) => g.goalId === c.goalId);
            if (!goal || goal.submittedBy?.principalRef !== REHEARSAL_HUMAN) throw new Error('GOAL_BINDING_MISMATCH');
            return goal.text;
          } }, layout.copies);
        return createLimitedWorkerService({ goals: ports.store, governance: ports.governance, admission: ports.runAdmission, projects: [REHEARSAL_PROJECT],
          store, quote: () => tariffFromMarkdown(REHEARSAL_PRICE_DOCUMENT, clock.now()), source: options.source, identity: options.identity,
          runtime, now: () => clock.now(), measurementClass: 'OFFLINE_SYNTHETIC', allowOfflineStart: true });
      } });
    return Object.freeze({ url: workspace.url, port: workspace.port, workspace, close: () => workspace.close() });
  }
}
