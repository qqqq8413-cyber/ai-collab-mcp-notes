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

/**
 * The build toolchain — CENSUS-REQ-07.
 *
 * Both entries are needed, and the second is the one that would have been missed.
 * TypeScript 7 is the native port: `typescript/bin/tsc` is a two-line shim that resolves
 * a platform binary out of `@typescript/typescript-<platform>-<arch>` and execs it. The
 * bytes that actually compile `dist/` are that binary, so attesting only the `typescript`
 * package would attest a launcher and call it a compiler.
 */
export const CENSUS_TOOLCHAIN_PACKAGES = Object.freeze(['typescript', '@typescript/typescript-darwin-arm64']);

/**
 * The Node runtime the census was reviewed and rehearsed under — CENSUS-REQ-08.
 *
 * `process.version` is pinned and fail-closed. The rest is recorded context, not a
 * guarantee: the same Node version does not make behaviour bit-identical across machines,
 * and claiming it would be a stronger statement than the evidence supports. The narrow
 * purpose is that a census must not silently run under a different runtime generation
 * than the one that was reviewed.
 */
export const APPROVED_NODE_VERSION = 'v24.15.0';
export const NODE_CONTEXT_FIELDS = Object.freeze(['platform', 'arch', 'v8', 'modules']);

/** The compiler executable the build binding must actually invoke, by package-relative identity. */
export const APPROVED_COMPILER = Object.freeze({
  package: '@typescript/typescript-darwin-arm64',
  executableRelative: 'node_modules/@typescript/typescript-darwin-arm64/lib/tsc',
  executableSha256: 'a82f731365ad69d5c4c15f5e18fba4584bf3b7b839960172a76c3462b5114bf2',
  launcherRelative: 'node_modules/.bin/tsc',
});

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
    'typescript': Object.freeze({
      lockedVersion: '7.0.2',
      lockIntegrity: 'sha512-8FYau96o3NKOhbjKi/qNvG/W5jhzxkbdm5sj9AbZ/5T5sWqn3hJgLfGx27sRKZWTvyzCP8dLRBTf5tBTSRVUNA==',
      installedManifestSha256: '3722b30210616a13a3213ded11575ba6b2dbab10c32a5ef67afca8513e27017e',
      runtimeEntrypointRelative: 'lib/version.cjs',
      runtimePackageDigest: '2681b5b29b8b50b532287288d676b3d319310554526c04d0f19fee64aea87640',
      runtimePackageFileCount: 416,
      role: 'compiler launcher; resolves and execs the native binary below',
    }),
    '@typescript/typescript-darwin-arm64': Object.freeze({
      lockedVersion: '7.0.2',
      lockIntegrity: 'sha512-gowzar9MwS/aRWp6f3a4KUqzRjAZjOsmGNCM6LcTgXum+dBfgsBVMN+AgvOCCbguXyick6LJhpBszxMebJ8syA==',
      installedManifestSha256: 'e88558e22e3db6c4da920e15a60eb2bbea801732b94aedb67e972be2a7f485b8',
      runtimeEntrypointRelative: null,
      runtimePackageDigest: '119d596ea13a77feec98dfc0bbc78c7ed3c874031f9038f305a531cab0d07443',
      runtimePackageFileCount: 113,
      role: 'the native compiler that actually produces dist/',
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
  for (const name of [...CENSUS_PACKAGES, ...CENSUS_TOOLCHAIN_PACKAGES]) {
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
    node: nodeProvenance(),
    compiler: await compilerProvenance(),
    packages,
  };
}

/** Pinned version, plus context that is recorded and deliberately not claimed as a guarantee. */
export function nodeProvenance() {
  return {
    version: process.version,
    approvedVersion: APPROVED_NODE_VERSION,
    context: Object.fromEntries([
      ['platform', process.platform],
      ['arch', process.arch],
      ...NODE_CONTEXT_FIELDS.filter((f) => f in process.versions).map((f) => [f, process.versions[f]]),
    ]),
  };
}

/**
 * Resolves the compiler the build would actually run, and checks it lands where expected.
 *
 * `node_modules/.bin/tsc` is a symlink whose name proves nothing; the launcher resolves
 * the real executable through `getExePath()`, so that is what is asked. The result is
 * required to sit inside the approved native package, which is what stops a path that
 * merely looks right from being accepted.
 */
export async function compilerProvenance() {
  const launcher = join(REPO_ROOT, 'node_modules', '.bin', 'tsc');
  try {
    const getExePath = (await import(new URL('../../../node_modules/typescript/lib/getExePath.js', import.meta.url).href)).default;
    const absolute = resolve(getExePath());
    const packageRoot = resolve(join(REPO_ROOT, 'node_modules', APPROVED_COMPILER.package));
    const inside = absolute === packageRoot || absolute.startsWith(packageRoot + sep);
    return {
      launcherRelative: relative(REPO_ROOT, launcher).split(sep).join('/'),
      launcherExists: existsSync(launcher),
      executableRelative: relative(REPO_ROOT, absolute).split(sep).join('/'),
      executableSha256: existsSync(absolute) ? sha256(readFileSync(absolute)) : null,
      resolvesInsideApprovedPackage: inside,
      escapedTo: inside ? null : absolute,
    };
  } catch (err) {
    return {
      launcherRelative: relative(REPO_ROOT, launcher).split(sep).join('/'),
      launcherExists: existsSync(launcher),
      executableRelative: null,
      executableSha256: null,
      resolvesInsideApprovedPackage: false,
      escapedTo: null,
      error: String(err),
    };
  }
}

/** Differences from the census baseline, returned so preflight and verifier share one comparison. */
export function matchesCensusBaseline(record, baseline = CENSUS_DEPENDENCY_BASELINE) {
  const problems = [];

  // CENSUS-REQ-08. Pinned and fail-closed; the context fields are never compared.
  if (record?.node?.version !== APPROVED_NODE_VERSION) {
    problems.push(`node runtime is ${record?.node?.version ?? 'unrecorded'}, approved is ${APPROVED_NODE_VERSION}`);
  }

  // CENSUS-REQ-07. The executable, not the path that names it.
  const compiler = record?.compiler;
  if (!compiler) problems.push('no compiler provenance recorded');
  else {
    if (!compiler.resolvesInsideApprovedPackage) {
      problems.push(`tsc resolves outside ${APPROVED_COMPILER.package}${compiler.escapedTo ? ` (${compiler.escapedTo})` : ''}`);
    }
    if (compiler.executableRelative !== APPROVED_COMPILER.executableRelative) {
      problems.push(`compiler.executableRelative is ${compiler.executableRelative}, approved is ${APPROVED_COMPILER.executableRelative}`);
    }
    if (compiler.executableSha256 !== APPROVED_COMPILER.executableSha256) {
      problems.push(`compiler.executableSha256 is ${compiler.executableSha256}, approved is ${APPROVED_COMPILER.executableSha256}`);
    }
  }

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
