// Offline control capture: no provider call. Run before and after the prompt edit.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runOrchestrator } from '../../../dist/modes/orchestrator.js';

const phase = process.argv[2];
assert.ok(['before', 'after'].includes(phase));
const originalNow = Date.now;
Date.now = () => 1000;
const observations = [];
try {
  for (const complexity of ['simple', 'normal', 'deep']) {
    for (const enabled of [undefined, false]) {
      for (const status of ['SUCCESS', 'DEGRADED', 'FAILED']) {
        if (complexity === 'simple' && status === 'DEGRADED') continue;
        const ids = complexity === 'simple' ? ['a'] : ['a', 'b'];
        const calls = [];
        const workers = ids.map((id) => ({ id, provider: 'openai', model: 'offline', role: id }));
        const result = await runOrchestrator({
          task: 'Compare the options using only supplied facts.',
          workers,
          orchestrator: { provider: 'openai', model: 'offline' },
          ...(enabled === undefined ? {} : { experimental: { collaboration: { enabled } } }),
          call: async (provider, prompt, options) => {
            calls.push({ provider, prompt, options });
            if (options.stage === 'planning') return {
              provider, model: 'offline', text: JSON.stringify({
                complexity, requiredCapabilities: [], requiresRedTeam: false, reason: 'Offline control',
                assignments: ids.map((agentId) => ({ agentId, mission: 'Evaluate ' + agentId, priority: 'high' })),
              }),
            };
            if (options.stage === 'round1_worker' &&
                (status === 'FAILED' || (status === 'DEGRADED' && options.system === 'b'))) {
              throw new Error('Offline worker failure');
            }
            return { provider, model: 'offline', text: '  Unchanged answer\nwith whitespace.\n' };
          },
        });
        assert.equal(result.report.status, status);
        assert.equal(result.collaboration, undefined);
        assert.ok(calls.every(({ options }) => !['synthesis_gate', 'round2_worker', 'decision_synthesis'].includes(options.stage)));
        observations.push({ complexity, config: enabled === undefined ? 'omitted' : 'disabled', status, calls, result });
      }
    }
  }
} finally {
  Date.now = originalNow;
}
const bytes = Buffer.from(JSON.stringify(observations, null, 2) + '\n');
const path = fileURLToPath(new URL('control-' + phase + '.json', import.meta.url));
if (phase === 'after') assert.deepEqual(bytes, readFileSync(new URL('control-before.json', import.meta.url)));
writeFileSync(path, bytes, { flag: 'wx' });
console.log(JSON.stringify({ phase, cases: observations.length, sha256: createHash('sha256').update(bytes).digest('hex'), byteEquivalent: phase === 'after' ? true : null }));
