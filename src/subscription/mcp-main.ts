#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { billingEnvPresent } from './contract.js';
import { checkDataDirectory, m2Layout, parseArgs } from './layout.js';
import { createChiefTaskMcpServer } from './mcp-server.js';
import { SubscriptionTaskStore } from './task-store.js';

// The CHIEF MCP server over stdio, started by the Human's Claude Code:
//   node dist/subscription/mcp-main.js --data-dir <absolute M2 data directory>
// stdout carries only the MCP protocol; problems go to stderr as one code.

async function main() {
  const args = parseArgs(process.argv.slice(2), ['--data-dir']);
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const data = checkDataDirectory(args.get('--data-dir'), root);
  const store = new SubscriptionTaskStore(m2Layout(data).tasks);
  const present = billingEnvPresent(process.env);
  if (present.length) console.error(`CHIEF MCP: BILLING_GUARD_API_ENV_PRESENT (${present.join(', ')}); every tool refuses`);
  const server = createChiefTaskMcpServer({ store, now: () => new Date().toISOString(), billingEnvPresent: present });
  await server.connect(new StdioServerTransport());
}
main().catch((error: unknown) => {
  console.error(error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : 'CHIEF_MCP_START_FAILED');
  process.exit(1);
});
