/**
 * Dependency provenance for a live capture, and the fail-closed check that precedes one.
 *
 * ## Why this exists separately from the runtime fingerprint
 *
 * `runtime-fingerprint.mjs` hashes `src/**` and `dist/**`. That is a real guarantee and a
 * narrow one: it says the project's own code did not move mid-capture, and it says nothing
 * at all about the provider SDKs the calls actually went through. Broadening the
 * fingerprint's meaning after the fact would silently re-describe every historical
 * artifact that carries one, so the fingerprint keeps its scope and this records the rest.
 *
 * ## Why a version string is not enough
 *
 * The claim this has to support is behavioural: one logical capture call is at most one
 * HTTP attempt. For Gemini that is a property of the installed bytes rather than of any
 * option we set, and for OpenAI and Anthropic the retry logic lives in `client.js` and its
 * neighbours rather than in the entrypoint. A version string is a label a local edit does
 * not change, and an entrypoint hash misses every other file that runs. So the unit of
 * identity here is a digest over the whole installed package, and the check is equality
 * against a committed baseline rather than mere presence.
 *
 * ## Why the baseline is committed rather than discovered
 *
 * Recording what is installed proves only that something was installed. The baseline below
 * is the exact tree the deterministic transport proof was run against; a live capture that
 * does not match it is running on unproven bytes, and that is refused rather than noted.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PACKAGE_LOCK = join(REPO_ROOT, 'package-lock.json');

/** The provider SDKs a capture can actually reach. Nothing else is attested here. */
export const PROVIDER_PACKAGES = Object.freeze(['openai', '@anthropic-ai/sdk', '@google/generative-ai']);

/**
 * The dependency tree the transport no-retry proof was run against, in full.
 *
 * Every field is compared for equality before a live capture starts. Changing any value
 * here without re-running `test-m2b-transport-policy.mjs` against the new tree is the one
 * edit this file exists to prevent: it would move the baseline to match reality instead of
 * refusing reality that does not match the proof.
 *
 * Paths are package-relative so the baseline is not tied to one machine.
 */
export const APPROVED_DEPENDENCY_BASELINE = Object.freeze({
  packageLockSha256: '4fde57dc2c3102c081674bd6286dbc77aa9f8ecd128aa43450568edff840c5e1',
  packages: Object.freeze({
    'openai': Object.freeze({
      lockedVersion: '7.10.0',
      lockIntegrity: 'sha512-sn9t2Kls7O52PwuF9BUTYNu4Gk/r0lXJyrgaNht4TNRlZFb3dJIGO0RciSgjARGCBRtWjySubAQFJttlzUvGQQ==',
      transportProvenVersion: '7.10.0',
      installedManifestSha256: '2d8da1ce54163c3e475e9f3a03cc103547054b590f9c0b642e9c16d074f39ad6',
      runtimeEntrypointRelative: 'index.mjs',
      runtimePackageDigest: '51f945fb0e27ed7106a8c11e26ee1a33eea546b46dcd4ac79d0c246abfb54644',
      runtimePackageFileCount: 2953,
    }),
    '@anthropic-ai/sdk': Object.freeze({
      lockedVersion: '0.123.0',
      lockIntegrity: 'sha512-Y9oX9mPNGZClHQOFqrWRk43Srcu/UHuPq3rfxxOq7JgW0gi+lJA2MAOK4Ul3k/+AUrwRWFJvd0tK3oC0Pw25dw==',
      transportProvenVersion: '0.123.0',
      installedManifestSha256: '50fd5b7f7909f5aca75572f37fc6456f14fa11eaf77da18d6add98ea96240896',
      runtimeEntrypointRelative: 'index.mjs',
      runtimePackageDigest: '4a06e4ccb9072d2de9b9f40cf586299e50aea1d2b9a87618bbb0c0fad0824d55',
      runtimePackageFileCount: 1735,
    }),
    '@google/generative-ai': Object.freeze({
      lockedVersion: '0.24.1',
      lockIntegrity: 'sha512-MqO+MLfM6kjxcKoy0p1wRzG3b4ZZXtPI+z2IE26UogS2Cm/XHO+7gGRBh6gcJsOiIVoH93UwKvW4HdgiOZCy9Q==',
      transportProvenVersion: '0.24.1',
      installedManifestSha256: 'ce0271fa0d7a83b83cb080166b45dc954aa4d9942fb4581669633251fb5fb302',
      runtimeEntrypointRelative: 'dist/index.mjs',
      runtimePackageDigest: '0a9fca0c7bfe5985886b7376fdd2978f97ea0bd95eb6ab861d6c1d1d783cc1b0',
      runtimePackageFileCount: 81,
    }),
  }),
});

/** Kept for readers and for the artifact; the baseline above is the enforcement. */
export const TRANSPORT_PROVEN_VERSIONS = Object.freeze(
  Object.fromEntries(Object.entries(APPROVED_DEPENDENCY_BASELINE.packages)
    .map(([name, pkg]) => [name, pkg.transportProvenVersion])),
);

export class DependencyProvenanceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DependencyProvenanceError';
    this.code = 'DEPENDENCY_PROVENANCE_MISMATCH';
  }
}

const lockEntry = (lock, name) => lock.packages?.[`node_modules/${name}`] ?? null;

/**
 * A deterministic digest over one installed package's bytes.
 *
 * Sorted package-relative paths, each with the sha256 of its own bytes, joined into one
 * canonical text and hashed. Two properties matter: the same tree always produces the same
 * digest regardless of filesystem order, and a change to any file the SDK might load
 * changes it — which the entrypoint hash alone would miss, since OpenAI's and Anthropic's
 * retry logic lives in `client.js` rather than in `index.mjs`.
 *
 * Never follows a symlink. A link inside the package could point anywhere, and a digest
 * that silently absorbed whatever it aimed at would not be a digest of this package.
 */
export function packageRuntimeDigest(packageRoot) {
  const entries = [];
  const walk = (dir) => {
    for (const dirent of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(dir, dirent.name);
      if (lstatSync(path).isSymbolicLink()) {
        throw new DependencyProvenanceError(`refusing to digest a symlink inside ${packageRoot}: ${path}`);
      }
      if (dirent.isDirectory()) walk(path);
      else if (dirent.isFile()) entries.push([relative(packageRoot, path).split(sep).join('/'), sha256(readFileSync(path))]);
    }
  };
  walk(packageRoot);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return {
    digest: sha256(entries.map(([path, hash]) => `${path}\n${hash}`).join('\n')),
    fileCount: entries.length,
  };
}

/**
 * Where Node would actually load this package from, expressed relative to its own root.
 *
 * Package-relative so the value is comparable across machines, and checked for containment
 * so a resolution that escapes the package directory is a failure rather than a path with
 * `..` in it.
 */
async function resolvedEntrypoint(name, packageRoot) {
  try {
    const absolute = resolve(fileURLToPath(await import.meta.resolve(name)));
    const root = resolve(packageRoot);
    if (absolute !== root && !absolute.startsWith(root + sep)) {
      return { relative: null, escaped: absolute, sha256: null };
    }
    if (!existsSync(absolute)) return { relative: null, escaped: null, sha256: null };
    return {
      relative: relative(root, absolute).split(sep).join('/'),
      escaped: null,
      sha256: sha256(readFileSync(absolute)),
    };
  } catch {
    return { relative: null, escaped: null, sha256: null };
  }
}

/**
 * Everything a later reader needs to identify which SDK bytes took part in a capture.
 *
 * Pure reading. Never installs, never repairs, never mutates the dependency tree.
 */
export async function dependencyProvenance() {
  const lockBytes = readFileSync(PACKAGE_LOCK, 'utf8');
  const lock = JSON.parse(lockBytes);

  const packages = [];
  for (const name of PROVIDER_PACKAGES) {
    const packageRoot = join(REPO_ROOT, 'node_modules', name);
    const installed = existsSync(join(packageRoot, 'package.json'))
      ? readFileSync(join(packageRoot, 'package.json'), 'utf8')
      : null;
    const entry = installed ? await resolvedEntrypoint(name, packageRoot) : { relative: null, escaped: null, sha256: null };
    const runtime = installed ? packageRuntimeDigest(packageRoot) : { digest: null, fileCount: null };
    const locked = lockEntry(lock, name);

    packages.push({
      name,
      lockedVersion: locked?.version ?? null,
      lockIntegrity: locked?.integrity ?? null,
      installedVersion: installed ? JSON.parse(installed).version : null,
      installedManifestSha256: installed ? sha256(installed) : null,
      runtimeEntrypointRelative: entry.relative,
      runtimeEntrypointEscapedTo: entry.escaped,
      runtimeEntrypointSha256: entry.sha256,
      runtimePackageDigest: runtime.digest,
      runtimePackageFileCount: runtime.fileCount,
      transportProvenVersion: TRANSPORT_PROVEN_VERSIONS[name] ?? null,
    });
  }

  return {
    packageLockSha256: sha256(lockBytes),
    lockfileVersion: lock.lockfileVersion ?? null,
    nodeVersion: process.version,
    approvedBaselineMatched: matchesApprovedBaseline({ packageLockSha256: sha256(lockBytes), packages }).length === 0,
    packages,
  };
}

/**
 * Compares one provenance record against the committed baseline.
 *
 * Returns the list of differences rather than throwing, so the verifier can reuse exactly
 * the comparison the preflight runs instead of reimplementing it slightly differently.
 */
export function matchesApprovedBaseline(record, baseline = APPROVED_DEPENDENCY_BASELINE) {
  const problems = [];

  if (record?.packageLockSha256 !== baseline.packageLockSha256) {
    problems.push(`package-lock.json sha256 is ${record?.packageLockSha256 ?? 'absent'}, approved is ${baseline.packageLockSha256}`);
  }

  for (const [name, approved] of Object.entries(baseline.packages)) {
    const pkg = (record?.packages ?? []).find((entry) => entry.name === name);
    if (!pkg) { problems.push(`${name}: no provenance recorded`); continue; }
    if (pkg.installedVersion === null) { problems.push(`${name} is not installed`); continue; }
    if (pkg.runtimeEntrypointEscapedTo) {
      problems.push(`${name}: entrypoint resolves outside the package root (${pkg.runtimeEntrypointEscapedTo})`);
    }
    // Internal consistency first: a tree that disagrees with its own lockfile is broken
    // regardless of what the baseline says.
    if (pkg.lockedVersion !== pkg.installedVersion) {
      problems.push(`${name}: package-lock says ${pkg.lockedVersion}, installed is ${pkg.installedVersion}`);
    }
    for (const field of [
      'lockedVersion', 'lockIntegrity', 'installedManifestSha256',
      'runtimeEntrypointRelative', 'runtimePackageDigest', 'runtimePackageFileCount',
    ]) {
      if (pkg[field] !== approved[field]) {
        problems.push(`${name}.${field}: ${String(pkg[field])} does not match the approved ${String(approved[field])}`);
      }
    }
    if (pkg.installedVersion !== approved.transportProvenVersion) {
      problems.push(
        `${name}: installed ${pkg.installedVersion} is not the ${approved.transportProvenVersion} `
          + 'the transport no-retry test was proven against',
      );
    }
  }

  return problems;
}

/**
 * The preflight a live capture must pass before its first provider call.
 *
 * Fail-closed on every difference from the approved tree, and deliberately silent about
 * how to fix it: `npm install` is a decision a person makes after deciding whether the new
 * tree still satisfies the transport proof, not something a preflight does on their behalf.
 */
export async function assertDependenciesMatchLock(provenance = null) {
  const record = provenance ?? (await dependencyProvenance());
  const problems = matchesApprovedBaseline(record);
  if (problems.length) {
    throw new DependencyProvenanceError(
      'Refusing to run: the installed dependency tree is not the one the transport no-retry proof was run against.\n'
        + `  - ${problems.join('\n  - ')}\n`
        + '  Re-run experiments/m2b/test-m2b-transport-policy.mjs against the new tree and update '
        + 'APPROVED_DEPENDENCY_BASELINE deliberately; do not adjust the baseline to match an unproven install.',
    );
  }
  return record;
}

export { sha256 };
