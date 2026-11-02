import { isAbsolute, join, relative, resolve } from 'node:path';

// The M2-0 data directory: everything lives under one absolute root outside the repository.
//   <data>/goals            Workspace goal queue (the Workspace needs one; M2-0 does not use goals)
//   <data>/tasks            the CHIEF task ledger shared by the Workspace and the MCP server
//   <data>/claude-mcp.json  the MCP configuration the Host writes for `claude --mcp-config`

export function m2Layout(dataDirectory: string) {
  return { root: dataDirectory, goals: join(dataDirectory, 'goals'), tasks: join(dataDirectory, 'tasks'), mcpConfig: join(dataDirectory, 'claude-mcp.json') };
}

/** An absolute, normalized directory that is not inside the repository (so nothing here is ever committed or read as code). */
export function checkDataDirectory(dataDirectory: string | undefined, repositoryRoot: string): string {
  if (!dataDirectory || !isAbsolute(dataDirectory) || resolve(dataDirectory) !== dataDirectory) throw new Error('DATA_DIR_MUST_BE_ABSOLUTE');
  const inside = relative(resolve(repositoryRoot), dataDirectory);
  if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) throw new Error('DATA_DIR_INSIDE_REPOSITORY');
  return dataDirectory;
}

/** Strict `--name value` pairs, each name at most once and only from `allowed`. */
export function parseArgs(argv: readonly string[], allowed: readonly string[]): Map<string, string> {
  if (argv.length % 2) throw new Error('INVALID_ARGS');
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i], value = argv[i + 1];
    if (!allowed.includes(name) || !value || out.has(name)) throw new Error('INVALID_ARGS');
    out.set(name, value);
  }
  return out;
}
