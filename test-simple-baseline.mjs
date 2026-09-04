// Baseline measurement: what does the current three-stage orchestrator cost on a task
// that needs none of it? Measurement only — nothing here changes behaviour.
//
//   node test-simple-baseline.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync } from 'node:fs';
import { SIMPLE_TASK, BENCHMARK_ROSTER } from './benchmark-task.mjs';

const transport = new StdioClientTransport({ command: 'node', args: ['dist/index.js'] });
const client = new Client({ name: 'simple-baseline', version: '1.0.0' });
await client.connect(transport);

console.log('task:\n' + SIMPLE_TASK + '\n');

const res = await client.callTool(
  {
    name: 'run_orchestrator',
    arguments: {
      task: SIMPLE_TASK,
      orchestrator: { provider: 'openai', model: 'gpt-5' },
      workers: BENCHMARK_ROSTER,
      synthesizer: { provider: 'openai', model: 'gpt-5' },
    },
  },
  undefined,
  { timeout: 900000 }
);

const p = JSON.parse(res.content[0].text);
const s = (ms) => (ms / 1000).toFixed(1) + 's';
const t = p.timings;

console.log('complexity      :', p.plan.complexity);
console.log('capabilities    :', p.plan.requiredCapabilities.join(', '));
console.log('assignments     :', p.plan.assignments.map((a) => a.agentId).join(', '));
console.log('API calls       :', 1 + p.plan.assignments.length + (p.report.synthesisAllowed ? 1 : 0));
console.log('status          :', p.report.status, '| evidence:', p.report.evidenceLabel);
console.log('adjustments     :', p.planningAdjustments.length ? p.planningAdjustments : 'none');
console.log('reason          :', p.plan.reason);

console.log('\ntimings');
console.log('  planning      :', s(t.planningMs), `(${((t.planningMs / t.totalMs) * 100).toFixed(0)}%)`);
console.log('  workers       :', s(t.workersMs), `(${((t.workersMs / t.totalMs) * 100).toFixed(0)}%)`);
console.log('  synthesis     :', s(t.synthesisMs), `(${((t.synthesisMs / t.totalMs) * 100).toFixed(0)}%)`);
console.log('  total         :', s(t.totalMs));

// The question Step 7 turns on: with one specialist, is synthesis doing work, or is it
// paying a full model turn to restate an answer that was already complete?
console.log('\nwhat synthesis actually did');
for (const w of p.workerResults) {
  console.log(`  ${w.agentId} output: ${w.output?.length ?? 0} chars`);
}
console.log('  final output   :', p.finalOutput?.length ?? 0, 'chars');
if (p.workerResults.length === 1 && p.finalOutput) {
  const worker = p.workerResults[0].output ?? '';
  console.log('\n--- specialist output ---\n' + worker.slice(0, 700));
  console.log('\n--- final output after synthesis ---\n' + p.finalOutput.slice(0, 700));
}

writeFileSync('simple-baseline.json', JSON.stringify(p, null, 2));
console.log('\nfull result written to simple-baseline.json');

await client.close();
