/**
 * Census dependency provenance — CENSUS-REQ-05, and the census's own baseline.
 *
 * ## Why Zod is here and was not before
 *
 * The M2-B capture attested the three provider SDKs, because those were the packages a
 * capture's claims depended on. A census's central claim depends on one more:
 * `plan.assignments.length` is the formal event, and that array is produced by
 * `planSchema.parse()` — Zod. A change to Zod's coercion or its handling of defaults could
 * move an event without touching a version string, `src/`, or any provider.
 *
 * ## Why the census has its own baseline
 *
 * Reusing the capture baseline object would tie two studies together: a future capture
 * upgrade would silently move the census's expectation, or the census would block a
 * capture change that has nothing to do with it. The *mechanism* is reused; the expected
 * values are the census's own, and they are compared for equality, never regenerated
 * during a session.
 *
 * Historical CAPTURE-2 and CAPTURE-3 claims are untouched by anything here.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageRuntimeDigest } from '../capture/dependency-provenance.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PACKAGE_LOCK = join(REPO_ROOT, 'package-lock.json');

/** Everything on the path from a task to an event: the planner's route, and its parser. */
export const CENSUS_PACKAGES = Object.freeze(['openai', '@anthropic-ai/sdk', '@google/generative-ai', 'zod']);

export const CENSUS_PROVENANCE_VERSION = 'CBRP-CENSUS-DEPS-1';

/**
 * The census's own approved tree. Compared for equality before any call.
 *
 * Deliberately a separate constant from the capture baseline even where the values agree:
 * two studies that share an expectation object cannot be changed independently, and the
 * first upgrade that suits one would silently move the other.
 */
export const CENSUS_DEPENDENCY_BASELINE = Object.freeze({
  version: CENSUS_PROVENANCE_VERSION,
  packageLockSha256: '4fde57dc2c3102c081674bd6286dbc77aa9f8ecd128aa43450568edff840c5e1',
  packages: Object.freeze({
    'openai': Object.freeze({
      lockedVersion: '7.10.0',
      lockIntegrity: 'sha512-sn9t2Kls7O52PwuF9BUTYNu4Gk/r0lXJyrgaNht4TNRlZFb3dJIGO0RciSgjARGCBRtWjySubAQFJttlzUvGQQ==',
      installedManifestSha256: '2d8da1ce54163c3e475e9f3a03cc103547054b590f9c0b642e9c16d074f39ad6',
      runtimeEntrypointRelative: 'index.mjs',
      runtimePackageDigest: '51f945fb0e27ed7106a8c11e26ee1a33eea546b46dcd4ac79d0c246abfb54644',
      runtimePackageFileCount: 2953,
      role: 'planning provider SDK',
    }),
    '@anthropic-ai/sdk': Object.freeze({
      lockedVersion: '0.123.0',
      lockIntegrity: 'sha512-Y9oX9mPNGZClHQOFqrWRk43Srcu/UHuPq3rfxxOq7JgW0gi+lJA2MAOK4Ul3k/+AUrwRWFJvd0tK3oC0Pw25dw==',
      installedManifestSha256: '50fd5b7f7909f5aca75572f37fc6456f14fa11eaf77da18d6add98ea96240896',
      runtimeEntrypointRelative: 'index.mjs',
      runtimePackageDigest: '4a06e4ccb9072d2de9b9f40cf586299e50aea1d2b9a87618bbb0c0fad0824d55',
      runtimePackageFileCount: 1735,
      role: 'installed but not on the census planning route',
    }),
    '@google/generative-ai': Object.freeze({
      lockedVersion: '0.24.1',
      lockIntegrity: 'sha512-MqO+MLfM6kjxcKoy0p1wRzG3b4ZZXtPI+z2IE26UogS2Cm/XHO+7gGRBh6gcJsOiIVoH93UwKvW4HdgiOZCy9Q==',
      installedManifestSha256: 'ce0271fa0d7a83b83cb080166b45dc954aa4d9942fb4581669633251fb5fb302',
      runtimeEntrypointRelative: 'dist/index.mjs',
      runtimePackageDigest: '0a9fca0c7bfe5985886b7376fdd2978f97ea0bd95eb6ab861d6c1d1d783cc1b0',
      runtimePackageFileCount: 81,
      role: 'installed but not on the census planning route',
    }),
    'zod': Object.freeze({
      lockedVersion: '4.5.4',
      lockIntegrity: 'sha512-sC95tT5iHHH9gtpj6A81kh+NEaRAUFN+qlUPDUbRfOMvNf5QCBqsb3WgvnpVtK5Y+4UfA6KqufotuTvMGiTlsA==',
      installedManifestSha256: '5a1983857f982cc7d69336f32053ac7e38780de313d9e18ca3f7b9b7f2f94298',
      runtimeEntrypointRelative: 'index.js',
      runtimePackageDigest: '99c4c9aecfee2b709843b748f22c021c6ad23aa1113f0e6a5a7be33cf46740f7',
      runtimePackageFileCount: 828,
      role: 'parses the planner response; produces the array the formal event counts',
    }),
  }),
});

export class CensusProvenanceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CensusProvenanceError';
    this.code = 'CENSUS_DEPENDENCY_MISMATCH';
  }
}

async function resolvedEntrypoint(name, packageRoot) {
  try {
    const absolute = resolve(fileURLToPath(await import.meta.resolve(name)));
    const root = resolve(packageRoot);
    if (absolute !== root && !absolute.startsWith(root + sep)) return { relative: null, escaped: absolute };
    return { relative: relative(root, absolute).split(sep).join('/'), escaped: null };
  } catch {
    return { relative: null, escaped: null };
  }
}

/** Pure reading. Never installs, never repairs, never regenerates the baseline. */
export async function censusDependencyProvenance() {
  const lockBytes = readFileSync(PACKAGE_LOCK, 'utf8');
  const lock = JSON.parse(lockBytes);

  const packages = [];
  for (const name of CENSUS_PACKAGES) {
    const packageRoot = join(REPO_ROOT, 'node_modules', name);
    const manifestPath = join(packageRoot, 'package.json');
    const installed = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : null;
    const entry = installed ? await resolvedEntrypoint(name, packageRoot) : { relative: null, escaped: null };
    const runtime = installed ? packageRuntimeDigest(packageRoot) : { digest: null, fileCount: null };
    const locked = lock.packages?.[`node_modules/${name}`] ?? null;
    packages.push({
      name,
      lockedVersion: locked?.version ?? null,
      lockIntegrity: locked?.integrity ?? null,
      installedVersion: installed ? JSON.parse(installed).version : null,
      installedManifestSha256: installed ? sha256(installed) : null,
      runtimeEntrypointRelative: entry.relative,
      runtimeEntrypointEscapedTo: entry.escaped,
      runtimePackageDigest: runtime.digest,
      runtimePackageFileCount: runtime.fileCount,
    });
  }

  return {
    version: CENSUS_PROVENANCE_VERSION,
    packageLockSha256: sha256(lockBytes),
    lockfileVersion: lock.lockfileVersion ?? null,
    nodeVersion: process.version,
    packages,
  };
}

/** Differences from the census baseline, returned so preflight and verifier share one comparison. */
export function matchesCensusBaseline(record, baseline = CENSUS_DEPENDENCY_BASELINE) {
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
  }
  return problems;
}

/**
 * Fail-closed preflight. No repair, no install, no baseline regeneration mid-session.
 */
export async function assertCensusDependencies(provenance = null) {
  const record = provenance ?? (await censusDependencyProvenance());
  const problems = matchesCensusBaseline(record);
  if (problems.length) {
    throw new CensusProvenanceError(
      'Refusing to run: the installed tree is not the census-approved one.\n'
        + `  - ${problems.join('\n  - ')}\n`
        + '  Re-verify the affected behaviour and update CENSUS_DEPENDENCY_BASELINE deliberately; '
        + 'a baseline may never be regenerated during a session to make it pass.',
    );
  }
  return record;
}
