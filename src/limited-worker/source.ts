import { execFileSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { hash } from './contract.js';

export function readPinnedReadme(repositoryPath: string, sha: string) {
  if (!/^[a-f0-9]{40}$/.test(sha) || lstatSync(repositoryPath).isSymbolicLink()) throw new Error('SOURCE_REFUSED');
  const root = realpathSync(repositoryPath);
  const git = (args: string[], maxBuffer = 32768) => execFileSync('/usr/bin/git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', root, ...args], {
    encoding: 'utf8', maxBuffer, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' } });
  if (git(['rev-parse', '--show-toplevel']).trim() !== root || git(['rev-parse', '--verify', sha + '^{commit}']).trim() !== sha) throw new Error('SOURCE_REFUSED');
  const tree = git(['ls-tree', '-z', sha, '--', 'README.md']);
  const match = /^100644 blob ([a-f0-9]{40})\tREADME\.md\0$/.exec(tree);
  if (!match) throw new Error('SOURCE_NOT_REGULAR_README');
  const size = Number(git(['cat-file', '-s', match[1]]).trim());
  if (!Number.isSafeInteger(size) || size < 1 || size > 16384) throw new Error('SOURCE_SIZE_LIMIT');
  const text = git(['cat-file', 'blob', match[1]], 16385);
  if (Buffer.byteLength(text) !== size || text.includes('\ufffd') || text.includes('\0')) throw new Error('SOURCE_ENCODING');
  return Object.freeze({ text, sha, path: 'README.md' as const, bytes: size, hash: hash(Buffer.from(text)) });
}
