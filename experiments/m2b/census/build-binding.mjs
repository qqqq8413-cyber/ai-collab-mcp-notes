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
import {
  APPROVED_COMPILER, APPROVED_NODE_VERSION, assertCensusDependencies, censusDependencyProvenance,
} from './census-provenance.mjs';

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
 * The toolchain slice of the record, and the check that the build may proceed at all.
 *
 * A matching reference and execution digest proves the two trees agree; it does not prove
 * either was produced by an approved compiler. Both could have come from the same wrong
 * one. So the toolchain identity is verified before the reference build runs, and the
 * evidence travels in the binding artifact rather than being implied by it.
 */
export async function toolchainRecord() {
  const provenance = await assertCensusDependencies();
  const typescript = provenance.packages.find((p) => p.name === 'typescript');
  const nativeCompiler = provenance.packages.find((p) => p.name === APPROVED_COMPILER.package);
  return {
    nodeVersion: provenance.node.version,
    approvedNodeVersion: APPROVED_NODE_VERSION,
    nodeContext: provenance.node.context,
    packageLockSha256: provenance.packageLockSha256,
    typescriptLockedVersion: typescript?.lockedVersion ?? null,
    typescriptInstalledVersion: typescript?.installedVersion ?? null,
    typescriptManifestSha256: typescript?.installedManifestSha256 ?? null,
    typescriptPackageDigest: typescript?.runtimePackageDigest ?? null,
    typescriptFileCount: typescript?.runtimePackageFileCount ?? null,
    compilerPackage: APPROVED_COMPILER.package,
    compilerPackageDigest: nativeCompiler?.runtimePackageDigest ?? null,
    compilerPackageFileCount: nativeCompiler?.runtimePackageFileCount ?? null,
    compilerExecutableRelative: provenance.compiler.executableRelative,
    compilerExecutableSha256: provenance.compiler.executableSha256,
    compilerLauncherRelative: provenance.compiler.launcherRelative,
    compilerResolvesInsideApprovedPackage: provenance.compiler.resolvesInsideApprovedPackage,
  };
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
export async function buildBinding(head = 'HEAD', distRoot = join(REPO_ROOT, 'dist')) {
  // Fail closed before compiling anything: an unapproved Node or compiler makes the
  // reference build worthless as evidence, so it is not worth producing.
  const toolchain = await toolchainRecord();
  const source = sourceTreeIdentity(head);
  const reference = referenceBuild(head);
  const execution = executionBuild(distRoot);
  return {
    executionHead: source.head,
    srcTreeSha: source.srcTreeSha,
    configHashes: source.configHashes,
    toolchain,
    buildCommand: [...BUILD_COMMAND],
    referenceDistDigest: reference.digest,
    referenceDistFileCount: reference.fileCount,
    executionDistDigest: execution.digest,
    executionDistFileCount: execution.fileCount,
    match: reference.digest === execution.digest && reference.fileCount === execution.fileCount,
  };
}

/** The toolchain half of the proof, checkable on an artifact without rebuilding. */
export function toolchainProblems(toolchain) {
  const problems = [];
  if (!toolchain) return ['no toolchain record'];
  if (toolchain.nodeVersion !== APPROVED_NODE_VERSION) {
    problems.push(`node runtime is ${toolchain.nodeVersion}, approved is ${APPROVED_NODE_VERSION}`);
  }
  if (toolchain.compilerExecutableRelative !== APPROVED_COMPILER.executableRelative) {
    problems.push(`compiler is ${toolchain.compilerExecutableRelative}, approved is ${APPROVED_COMPILER.executableRelative}`);
  }
  if (toolchain.compilerExecutableSha256 !== APPROVED_COMPILER.executableSha256) {
    problems.push(`compiler bytes ${toolchain.compilerExecutableSha256} do not match the approved ${APPROVED_COMPILER.executableSha256}`);
  }
  if (toolchain.compilerResolvesInsideApprovedPackage !== true) {
    problems.push(`the compiler does not resolve inside ${APPROVED_COMPILER.package}`);
  }
  const baseline = CENSUS_TOOLCHAIN_EXPECTATIONS;
  for (const [field, expected] of Object.entries(baseline)) {
    if (toolchain[field] !== expected) problems.push(`${field} is ${toolchain[field]}, approved is ${expected}`);
  }
  return problems;
}

/** Pinned here so an artifact can be judged without re-reading node_modules. */
export const CENSUS_TOOLCHAIN_EXPECTATIONS = Object.freeze({
  typescriptLockedVersion: '7.0.2',
  typescriptInstalledVersion: '7.0.2',
  typescriptManifestSha256: '3722b30210616a13a3213ded11575ba6b2dbab10c32a5ef67afca8513e27017e',
  typescriptPackageDigest: '2681b5b29b8b50b532287288d676b3d319310554526c04d0f19fee64aea87640',
  typescriptFileCount: 416,
  compilerPackageDigest: '119d596ea13a77feec98dfc0bbc78c7ed3c874031f9038f305a531cab0d07443',
  compilerPackageFileCount: 113,
  packageLockSha256: '4fde57dc2c3102c081674bd6286dbc77aa9f8ecd128aa43450568edff840c5e1',
});

export async function assertBuildBinding(binding = null, head = 'HEAD', distRoot = join(REPO_ROOT, 'dist')) {
  const record = binding ?? (await buildBinding(head, distRoot));
  const toolchain = toolchainProblems(record.toolchain);
  if (toolchain.length) {
    throw new BuildBindingError(
      'Refusing to run: the build toolchain is not the approved one.\n'
        + `  - ${toolchain.join('\n  - ')}\n`
        + '  A matching dist digest proves both trees agree, not that an approved compiler made them.',
    );
  }
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
