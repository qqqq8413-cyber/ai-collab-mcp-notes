/**
 * Source-to-dist execution binding for a census session — CENSUS-REQ-04.
 *
 * ## The gap this closes
 *
 * `runtime-fingerprint.mjs` hashes `src/**` and `dist/**` and proves neither moved during
 * a run. It does not prove the second was compiled from the first. A stale `dist/`, or one
 * built from uncommitted edits, produces a perfectly stable fingerprint while the code
 * that actually ran is not the code the execution head names — and every provenance claim
 * downstream inherits that error silently.
 *
 * So this rebuilds. The authorized commit's `src/` and build config are extracted to a
 * temporary directory, compiled with the repository's own pinned compiler, and the result
 * is digested and compared against the `dist/` that would execute. A mismatch is refused
 * before any call.
 *
 * The historical `runtimeFingerprint` is left exactly as it is. Widening its meaning would
 * retroactively re-describe every artifact that already carries one; this is a separate
 * record with a separate name, as dependency provenance was.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, lstatSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** What the build reads. A change to any of these can change `dist/` without touching `src/`. */
export const BUILD_INPUTS = Object.freeze(['tsconfig.json', 'package.json']);
export const BUILD_COMMAND = Object.freeze(['node_modules/.bin/tsc', '--project', 'tsconfig.json']);

export class BuildBindingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BuildBindingError';
    this.code = 'BUILD_BINDING_MISMATCH';
  }
}

const git = (...args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();

/**
 * A deterministic digest over a compiled tree: sorted relative paths, each file's own
 * hash, then a hash of that canonical text. Same shape as the dependency digest, and for
 * the same reason — an entrypoint hash would miss every other emitted file.
 */
export function treeDigest(root, { extensions = null } = {}) {
  const entries = [];
  const walk = (dir) => {
    for (const dirent of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(dir, dirent.name);
      if (lstatSync(path).isSymbolicLink()) throw new BuildBindingError(`refusing to digest a symlink: ${path}`);
      if (dirent.isDirectory()) walk(path);
      else if (dirent.isFile()) {
        const rel = relative(root, path).split(sep).join('/');
        if (extensions && !extensions.some((ext) => rel.endsWith(ext))) continue;
        entries.push([rel, sha256(readFileSync(path))]);
      }
    }
  };
  walk(root);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return { digest: sha256(entries.map(([p, h]) => `${p}\n${h}`).join('\n')), fileCount: entries.length };
}

/** The identity of the source the build is supposed to have come from. */
export function sourceTreeIdentity(head = 'HEAD') {
  const treeSha = git('rev-parse', `${head}:src`);
  const configHashes = Object.fromEntries(
    BUILD_INPUTS.map((name) => [name, sha256(git('show', `${head}:${name}`))]),
  );
  return { head: git('rev-parse', head), srcTreeSha: treeSha, configHashes };
}

/**
 * Rebuilds the authorized commit in a temp directory and digests the result.
 *
 * The commit is extracted with `git archive` rather than copied from the working tree, so
 * an uncommitted edit cannot slip into the reference build — which is the exact drift this
 * check exists to catch. `node_modules` is reused from the repository because the compiler
 * itself is pinned by `package-lock.json` and attested separately by census provenance.
 */
export function referenceBuild(head = 'HEAD') {
  const scratch = mkdtempSync(join(tmpdir(), 'cbrp-build-'));
  try {
    const archive = execFileSync('git', ['archive', '--format=tar', head, 'src', ...BUILD_INPUTS],
      { cwd: REPO_ROOT, maxBuffer: 256 * 1024 * 1024 });
    execFileSync('tar', ['-x', '-C', scratch], { input: archive });

    // The compiler and the type declarations it reads are pinned by package-lock.json and
    // attested separately by census dependency provenance, so they are linked in rather
    // than reinstalled: a fresh install would be a different tree and would make this
    // check depend on the registry being reachable.
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(scratch, 'node_modules'), 'dir');

    const [bin, ...args] = BUILD_COMMAND;
    try {
      execFileSync(join(REPO_ROOT, bin), [...args, '--outDir', join(scratch, 'dist-reference')], {
        cwd: scratch,
        env: { ...process.env, NODE_ENV: 'production' },
        stdio: 'pipe',
      });
    } catch (err) {
      const detail = String(err.stdout ?? '') + String(err.stderr ?? '');
      throw new BuildBindingError(`the reference build failed to compile:\n${detail.trim().slice(0, 2000)}`);
    }


    const built = join(scratch, 'dist-reference');
    if (!existsSync(built)) throw new BuildBindingError('the reference build produced no output directory');
    return treeDigest(built, { extensions: ['.js'] });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The digest of the `dist/` that would actually execute. */
export const executionBuild = (distRoot = join(REPO_ROOT, 'dist')) => treeDigest(distRoot, { extensions: ['.js'] });

/**
 * The full record, computed rather than asserted.
 *
 * Returns the evidence including `match`, so a caller can store the refusal as well as the
 * pass. `assertBuildBinding` is the fail-closed wrapper.
 */
export function buildBinding(head = 'HEAD', distRoot = join(REPO_ROOT, 'dist')) {
  const source = sourceTreeIdentity(head);
  const reference = referenceBuild(head);
  const execution = executionBuild(distRoot);
  return {
    executionHead: source.head,
    srcTreeSha: source.srcTreeSha,
    configHashes: source.configHashes,
    buildCommand: [...BUILD_COMMAND],
    referenceDistDigest: reference.digest,
    referenceDistFileCount: reference.fileCount,
    executionDistDigest: execution.digest,
    executionDistFileCount: execution.fileCount,
    match: reference.digest === execution.digest && reference.fileCount === execution.fileCount,
  };
}

export function assertBuildBinding(binding = null, head = 'HEAD', distRoot = join(REPO_ROOT, 'dist')) {
  const record = binding ?? buildBinding(head, distRoot);
  if (!record.match) {
    throw new BuildBindingError(
      'Refusing to run: the executable dist/ was not built from the authorized source.\n'
        + `  executionHead        ${record.executionHead}\n`
        + `  reference dist       ${record.referenceDistDigest} (${record.referenceDistFileCount} files)\n`
        + `  execution dist       ${record.executionDistDigest} (${record.executionDistFileCount} files)\n`
        + '  Rebuild from the authorized commit and re-verify; do not adjust the expectation.',
    );
  }
  return record;
}

export { sha256 };
