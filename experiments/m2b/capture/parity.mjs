/**
 * Offline production-parity capture for the runRound1Stage extraction.
 *
 * Run once before the refactor and once after. The extraction is only acceptable if the
 * two captures are byte-identical: for identical injected responses, runOrchestrator must
 * be observationally equivalent before and after. Anything else means the refactor moved
 * production behaviour, which is the one thing it must not do.
 *
 * Deterministic throughout — injected `call`, frozen clock, no provider, no network.
 *
 *   node experiments/m2b/capture/parity.mjs before
 *   node experiments/m2b/capture/parity.mjs after
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runOrchestrator } from '../../../dist/modes/orchestrator.js';

const phase = process.argv[2];
assert.ok(['before', 'after'].includes(phase), 'usage: parity.mjs before|after');

const WORKERS = [
  { id: 'alpha', provider: 'openai', model: 'stub-alpha', role: 'Alpha role', evidenceCapable: false },
  { id: 'beta', provider: 'claude', model: 'stub-beta', role: 'Beta role', evidenceCapable: false },
  { id: 'gamma', provider: 'gemini', model: 'stub-gamma', role: 'Gamma role', evidenceCapable: true },
];
const TASK = 'Decide whether to open a second production studio next year.';

const plan = (complexity, ids, extra = {}) => ({
  complexity,
  requiredCapabilities: ['reasoning'],
  requiresRedTeam: false,
  reason: 'Offline parity fixture',
  assignments: ids.map((agentId) => ({ agentId, mission: `Mission for ${agentId}`, priority: 'high' })),
  ...extra,
});

const GATE_ISSUE = {
  targetAgentId: 'beta',
  sourceRef: 'alpha:p1',
  challenge: 'Does the capacity assumption hold?',
  decisionSensitive: true,
  action: 'peer_challenge',
};
const GATE_TEXT =
  'PROVISIONAL: open it.\n\nSecond paragraph of the provisional answer.\n\n```json\n' +
  JSON.stringify({ collaborationIssues: [GATE_ISSUE] }) +
  '\n```';

/** Multi-paragraph so the chunker produces referenceable passages. */
const workerText = (id) => `${id.toUpperCase()}-OUTPUT: first paragraph.\n\nSecond paragraph from ${id}.`;

function makeCall(planObject, { gateText, failWorker } = {}) {
  const calls = [];
  return {
    calls,
    call: async (provider, prompt, options) => {
      calls.push({ provider, prompt, options });
      const stage = options.stage;
      if (stage === 'planning') return { provider, model: options.model, text: JSON.stringify(planObject) };
      if (stage === 'round1_worker') {
        const id = WORKERS.find((w) => w.role === options.system)?.id ?? 'unknown';
        if (failWorker === id) throw new Error(`offline worker failure: ${id}`);
        return { provider, model: options.model, text: workerText(id) };
      }
      if (stage === 'synthesis' || stage === 'synthesis_gate') {
        return { provider, model: options.model, text: gateText ?? 'SYNTHESIS-OUTPUT: the answer.' };
      }
      if (stage === 'round2_worker') return { provider, model: options.model, text: 'REVISED-OUTPUT.' };
      if (stage === 'decision_synthesis') return { provider, model: options.model, text: 'DECISION-OUTPUT.' };
      throw new Error(`unexpected stage in parity capture: ${stage}`);
    },
  };
}

const CASES = [
  ['A_simple_direct_delivery', { planObject: plan('simple', ['alpha']) }],
  ['B_normal_synthesis', { planObject: plan('normal', ['alpha', 'beta']) }],
  ['C_deep_collaboration_omitted', { planObject: plan('deep', ['alpha', 'beta']) }],
  ['D_deep_collaboration_disabled', { planObject: plan('deep', ['alpha', 'beta']), experimental: { collaboration: { enabled: false } } }],
  ['E_deep_collaboration_enabled', { planObject: plan('deep', ['alpha', 'beta']), experimental: { collaboration: { enabled: true } }, gateText: GATE_TEXT }],
  ['F_deep_worker_failure_degraded', { planObject: plan('deep', ['alpha', 'beta', 'gamma']), failWorker: 'gamma' }],
  ['G_all_workers_failed', { planObject: plan('deep', ['alpha']), failWorker: 'alpha' }],
];

const originalNow = Date.now;
let tick = 1000;
Date.now = () => (tick += 1000);

const observations = [];
try {
  for (const [name, config] of CASES) {
    tick = 1000;
    const dispatcher = makeCall(config.planObject, { gateText: config.gateText, failWorker: config.failWorker });
    let result = null;
    let thrown = null;
    try {
      result = await runOrchestrator({
        task: TASK,
        orchestrator: { provider: 'openai', model: 'stub-chief' },
        synthesizer: { provider: 'openai', model: 'stub-synth' },
        workers: WORKERS,
        call: dispatcher.call,
        ...(config.experimental ? { experimental: config.experimental } : {}),
      });
    } catch (error) {
      thrown = String(error);
    }
    observations.push({
      case: name,
      stages: dispatcher.calls.map((c) => c.options.stage),
      calls: dispatcher.calls,
      thrown,
      result,
    });
  }

  // Planning that cannot be parsed must keep failing the same way it does today.
  tick = 1000;
  const bad = makeCall(null);
  let malformed = null;
  try {
    await runOrchestrator({
      task: TASK,
      orchestrator: { provider: 'openai', model: 'stub-chief' },
      workers: WORKERS,
      call: async (provider, prompt, options) => {
        bad.calls.push({ provider, prompt, options });
        if (options.stage === 'planning') return { provider, model: options.model, text: 'not json at all' };
        throw new Error('planning should have failed before any other stage');
      },
    });
  } catch (error) {
    malformed = { message: String(error).split('\n')[0], stages: bad.calls.map((c) => c.options.stage) };
  }
  observations.push({ case: 'H_planning_malformed', malformed });
} finally {
  Date.now = originalNow;
}

const bytes = Buffer.from(JSON.stringify(observations, null, 2) + '\n');
const path = fileURLToPath(new URL(`parity-${phase}.json`, import.meta.url));
if (phase === 'after') {
  const before = readFileSync(fileURLToPath(new URL('parity-before.json', import.meta.url)));
  assert.deepEqual(bytes, before, 'POST-REFACTOR capture differs from PRE-REFACTOR: the extraction moved production behaviour');
}
writeFileSync(path, bytes);
console.log(
  JSON.stringify({
    phase,
    cases: observations.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteIdenticalToBefore: phase === 'after' ? true : null,
  })
);
