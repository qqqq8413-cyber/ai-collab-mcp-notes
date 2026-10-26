import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash } from './contract.js';
import { startRehearsalHost } from './rehearsal.js';
import { readPinnedReadme } from './source.js';

// M0 offline rehearsal Host: `npm run workspace:m0-rehearsal -- --data-dir <absolute path> [--port 4877]`.
// OFFLINE_SYNTHETIC only: no provider request, credential or paid call is possible. Run it from a clean checkout of
// the exact SHA under review; the Worker binds that SHA and its compiled code hash into every plan.

const PINNED_README = 'a3164fd12d6d3129978da32ea024854d6e9b5cdc';

async function main() {
  const args = process.argv.slice(2), allowed = ['--data-dir', '--port'];
  if (args.length % 2 || new Set(args.filter((_, i) => i % 2 === 0)).size !== args.length / 2) throw new Error('INVALID_ARGS');
  for (let i = 0; i < args.length; i += 2) if (!allowed.includes(args[i]) || !args[i + 1]) throw new Error('INVALID_ARGS');
  const arg = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const data = arg('--data-dir');
  if (!data || !isAbsolute(data) || resolve(data) !== data) throw new Error('DATA_DIR_MUST_BE_ABSOLUTE');
  const port = Number(arg('--port') ?? '4877');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('INVALID_PORT');
  const here = dirname(fileURLToPath(import.meta.url)), root = join(here, '../..');
  const identity = () => {
    const git = (...a: string[]) => execFileSync('/usr/bin/git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', root, ...a], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' } }).trim();
    return { sha: git('rev-parse', 'HEAD'), clean: git('status', '--porcelain', '--untracked-files=normal') === '',
      codeHash: hash(readdirSync(here).filter((p) => p.endsWith('.js')).sort().map((p) => [p, hash(readFileSync(join(here, p)))])) };
  };
  const host = await startRehearsalHost({ dataDirectory: data, port, uiDirectory: join(root, 'workspace-ui'), identity,
    source: () => readPinnedReadme(root, PINNED_README), readSource: (c) => readPinnedReadme(root, c.sourceSha) });
  console.log(`CHIEF M0 offline rehearsal: ${host.url} | OFFLINE_SYNTHETIC | no model, no credential, no paid call`);
  let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; void host.close().then(() => process.exit(0), () => process.exit(1)); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
main().catch((error: unknown) => { console.error(error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : 'REHEARSAL_START_FAILED'); process.exit(1); });
