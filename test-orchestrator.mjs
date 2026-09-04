import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync } from 'node:fs';
import { BENCHMARK_TASK, BENCHMARK_ROSTER } from './benchmark-task.mjs';

const RUNS = Number(process.argv[2] ?? 3);

const args = {
  task: BENCHMARK_TASK,
  orchestrator: { provider: 'openai', model: 'gpt-5' },
  // Registered in src/agents/registry.ts — see the list_agents tool.
  workers: BENCHMARK_ROSTER,
  synthesizer: { provider: 'openai', model: 'gpt-5' },
};

const transport = new StdioClientTransport({ command: 'node', args: ['dist/index.js'] });
const client = new Client({ name: 'orchestrator-test', version: '1.0.0' });
await client.connect(transport);

const summary = [];

for (let i = 1; i <= RUNS; i++) {
  console.log(`\n########## RUN ${i}/${RUNS} ##########`);
  const res = await client.callTool({ name: 'run_orchestrator', arguments: args }, undefined, {
    timeout: 900000,
  });
  const p = JSON.parse(res.content[0].text);

  const row = {
    run: i,
    complexity: p.plan.complexity,
    capabilities: p.plan.requiredCapabilities,
    agents: p.plan.assignments.map((a) => a.agentId),
    missionCount: p.plan.assignments.length,
    // Count scheduled model calls from policy; the status guard alone is insufficient.
    apiCalls: 1 + p.plan.assignments.length + ((p.report.policy?.synthesize ?? p.report.synthesisAllowed) ? 1 : 0),
    policy: p.report.policy,
    requiresRedTeam: p.plan.requiresRedTeam,
    adjustments: p.planningAdjustments,
    status: p.report.status,
    evidenceLabel: p.report.evidenceLabel,
    failures: p.report.failures.map((f) => f.agentId),
    finalChars: p.finalOutput?.length ?? 0,
    timings: p.timings,
  };
  summary.push(row);

  console.log('status          :', row.status, '| evidence:', row.evidenceLabel);
  console.log('policy          :', row.policy ?? 'legacy report');
  console.log('complexity      :', row.complexity);
  console.log('capabilities    :', row.capabilities.join(', '));
  console.log('agents          :', row.agents.join(', '));
  console.log('missions        :', row.missionCount, '| API calls:', row.apiCalls);
  console.log('requiresRedTeam :', row.requiresRedTeam);
  console.log('adjustments     :', row.adjustments.length ? row.adjustments : 'none');
  console.log(
    'workers         :',
    `${p.report.successfulWorkers}/${p.report.requestedWorkers} returned`,
    row.failures.length ? `| failed: ${row.failures.join(', ')}` : ''
  );
  for (const note of p.report.notes) console.log('note            :', note);
  console.log('final output    :', row.finalChars, 'chars');
  console.log(
    'timings         : plan',
    (row.timings.planningMs / 1000).toFixed(1) + 's',
    '| workers',
    (row.timings.workersMs / 1000).toFixed(1) + 's',
    '| synth',
    (row.timings.synthesisMs / 1000).toFixed(1) + 's',
    '| total',
    (row.timings.totalMs / 1000).toFixed(1) + 's'
  );

  writeFileSync(`orchestrator-run-${i}.json`, JSON.stringify(p, null, 2));
}

console.log('\n\n########## STABILITY COMPARISON ##########');
console.table(
  summary.map((s) => ({
    run: s.run,
    status: s.status,
    evidence: s.evidenceLabel,
    complexity: s.complexity,
    missions: s.missionCount,
    apiCalls: s.apiCalls,
    agents: s.agents.join('+'),
    adjustments: s.adjustments.length,
    failures: s.failures.length,
    finalChars: s.finalChars,
    totalSec: (s.timings.totalMs / 1000).toFixed(1),
  }))
);

const counts = summary.map((s) => s.missionCount);
console.log(`mission count across runs: ${counts.join(', ')} (min ${Math.min(...counts)}, max ${Math.max(...counts)})`);

await client.close();
