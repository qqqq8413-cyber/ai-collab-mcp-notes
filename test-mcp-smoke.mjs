// Exercises the MCP layer itself -- server boot, tool registration, and input schema --
// without spending an API call. Unknown agent ids are rejected in resolveWorkers, which
// runs after schema validation but before any model is contacted, so an intentionally
// bad roster proves the schema accepted the call shape and cost nothing.
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}\n      ${err.message.split('\n')[0]}`);
    failed++;
  }
}

const transport = new StdioClientTransport({ command: 'node', args: ['dist/index.js'] });
const client = new Client({ name: 'mcp-smoke', version: '1.0.0' });
await client.connect(transport);

console.log('\nMCP server');

const toolNames = (await client.listTools()).tools.map((t) => t.name);

await check('registers every tool', () => {
  for (const name of [
    'list_providers',
    'list_agents',
    'list_models',
    'run_pipeline',
    'run_orchestrator',
    'run_debate',
  ]) {
    assert.ok(toolNames.includes(name), `missing tool: ${name}`);
  }
});

await check('list_agents reports the roster with provider bindings', async () => {
  const res = await client.callTool({ name: 'list_agents', arguments: {} });
  const text = res.content[0].text;
  assert.match(text, /business_strategist — claude/);
  assert.match(text, /market_researcher — gemini/);
  assert.match(text, /brand_creative — openai/);
});

await check('list_agents marks the specialist whose model can actually retrieve', async () => {
  const res = await client.callTool({ name: 'list_agents', arguments: {} });
  const text = res.content[0].text;
  assert.match(text, /market_researcher — gemini \[evidence-gathering\]/);
  assert.doesNotMatch(text, /INTENDED — bound model cannot retrieve/);
});

await check('list_models separates what a vendor offers from what is wired up', async () => {
  const res = await client.callTool({ name: 'list_models', arguments: {} });
  const text = res.content[0].text;
  assert.match(text, /Grounded retrieval enabled on: gemini-3\.1-pro-preview/);
  assert.match(text, /NOT WIRED UP \(vendor offers it\)/, 'claude/openai search is offered, not wired');
  assert.match(text, /Offered by the vendor but not wired up here/);
  assert.match(text, /PARTIALLY_GROUNDED at best/, 'must not promise claim-level validation');
});

await check('list_models refuses to invent pricing', async () => {
  const res = await client.callTool({ name: 'list_models', arguments: {} });
  const text = res.content[0].text;
  assert.match(text, /pricing: unverified/);
  assert.doesNotMatch(text, /\$\d/, 'no invented prices');
});

console.log('\nrun_orchestrator worker refs');

// Both accepted shapes must survive schema validation and reach agent resolution.
for (const [label, workers] of [
  ['bare id', ['no_such_agent']],
  ['object with overrides', [{ id: 'no_such_agent', provider: 'claude' }]],
]) {
  await check(`${label} passes schema validation and reaches agent resolution`, async () => {
    const res = await client.callTool({
      name: 'run_orchestrator',
      arguments: { task: 'x', orchestrator: { provider: 'openai' }, workers },
    });
    const text = res.content.map((c) => c.text).join('\n');
    assert.match(text, /Unknown agent "no_such_agent"/);
    assert.match(text, /business_strategist/, 'the error should list the registered agents');
  });
}

await client.close();

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
