import { ACCEPTED_SUBSCRIPTIONS, CLAUDE_TOOL_NAMES } from './contract.js';

// M2-0 launcher rules, shared by process-once.ts and its tests: the exact Claude Code arguments and the login check.
// Every flag below is listed by `claude --help` of Claude Code 2.1.283; none is --bare, --dangerously-skip-permissions,
// bypassPermissions or a key. The prompt goes on stdin (process-once.ts), so no option can swallow it.

/** Reads Claude Code may never make, even inside the allowed directory: credentials and private config. */
export const SENSITIVE_READ_DENY = Object.freeze(['Read(~/.ssh/**)', 'Read(~/.aws/**)', 'Read(~/.config/**)', 'Read(~/.gnupg/**)', 'Read(~/.claude/**)',
  'Read(~/.claude.json)', 'Read(~/.netrc)', 'Read(~/.npmrc)', 'Read(~/Library/**)', 'Read(./.git/**)', 'Read(**/.env)', 'Read(**/.env.*)']);
export const ALLOWED_TOOLS = Object.freeze([...CLAUDE_TOOL_NAMES, 'Read(./**)', 'Glob', 'Grep']);
export const DENIED_TOOLS = Object.freeze(['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch']);

export function claudeArguments(mcpConfig: string): string[] {
  const permissions = { allow: [...ALLOWED_TOOLS], deny: [...SENSITIVE_READ_DENY, ...DENIED_TOOLS], disableBypassPermissionsMode: 'disable' };
  return ['-p', '--output-format', 'text',
    // Only Read/Glob/Grep exist as built-in tools; user/project/local settings (hooks, plugins, apiKeyHelper) are ignored.
    '--restricted', '--tools', 'Read,Glob,Grep',
    // Anything not pre-approved is denied; nobody answers prompts; bypass mode cannot be entered.
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--settings', JSON.stringify({ permissions }),
    '--allowedTools', ALLOWED_TOOLS.join(','), '--disallowedTools', DENIED_TOOLS.join(','),
    // Only the CHIEF MCP server.
    '--mcp-config', mcpConfig, '--strict-mcp-config',
    '--disable-slash-commands', '--no-chrome', '--no-session-persistence'];
}

/** The login check. Returns null when Claude Code is signed in with an accepted subscription, else a refusal code. */
export function subscriptionRefusal(status: unknown): string | null {
  if (!status || typeof status !== 'object') return 'AUTH_STATUS_UNREADABLE';
  const s = status as Record<string, unknown>;
  if (s.loggedIn !== true) return 'CLAUDE_CODE_NOT_LOGGED_IN';
  if (s.apiProvider !== 'firstParty') return 'AUTH_NOT_FIRST_PARTY';
  if (s.authMethod !== 'claude.ai') return 'AUTH_NOT_SUBSCRIPTION';
  if (s.apiKeySource !== undefined) return 'AUTH_API_KEY_SOURCE_PRESENT';
  if (!ACCEPTED_SUBSCRIPTIONS.includes(s.subscriptionType as (typeof ACCEPTED_SUBSCRIPTIONS)[number])) return 'SUBSCRIPTION_NOT_PRO_OR_MAX';
  return null;
}
