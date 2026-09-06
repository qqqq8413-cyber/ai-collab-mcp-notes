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
 * ## Why the SDK identity has to be in the artifact
 *
 * One of these dependencies is load-bearing for a claim. `@google/generative-ai` has no
 * retry knob because it has no retry, so "one logical Gemini call is one HTTP attempt" is
 * a property of the installed bytes rather than of an option this code sets. A capture
 * that does not name the version it ran against cannot support that claim later, and an
 * upgrade between the proof and the run would break it without leaving a trace.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PACKAGE_LOCK = join(REPO_ROOT, 'package-lock.json');

/** The provider SDKs a capture can actually reach. Nothing else is attested here. */
export const PROVIDER_PACKAGES = Object.freeze(['openai', '@anthropic-ai/sdk', '@google/generative-ai']);

/**
 * The exact versions the deterministic transport test was run against.
 *
 * `test-m2b-transport-policy.mjs` proves one-HTTP-attempt behaviour against these and
 * only these. A live capture on anything else is unproven, so the preflight refuses it
 * rather than assuming the property survived the upgrade. Changing a version here without
 * re-running that test is the one edit this file exists to prevent.
 */
export const TRANSPORT_PROVEN_VERSIONS = Object.freeze({
  'openai': '7.10.0',
  '@anthropic-ai/sdk': '0.123.0',
  '@google/generative-ai': '0.24.1',
});

export class DependencyProvenanceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DependencyProvenanceError';
    this.code = 'DEPENDENCY_PROVENANCE_MISMATCH';
  }
}

const lockedVersionOf = (lock, name) => lock.packages?.[`node_modules/${name}`]?.version ?? null;

function installedManifest(name) {
  const path = join(REPO_ROOT, 'node_modules', name, 'package.json');
  if (!existsSync(path)) return null;
  const bytes = readFileSync(path, 'utf8');
  return { path, bytes, json: JSON.parse(bytes) };
}

/**
 * Resolves the file Node will actually load for a bare import of `name`.
 *
 * Recorded because the version in package.json is a label, and the entrypoint hash is the
 * bytes. A patched or hand-edited install keeps its version string.
 */
async function resolvedEntrypoint(name) {
  try {
    const url = await import.meta.resolve(name);
    const path = fileURLToPath(url);
    if (!existsSync(path)) return { path: null, sha256: null };
    return { path: path.startsWith(REPO_ROOT) ? path.slice(REPO_ROOT.length) : path, sha256: sha256(readFileSync(path)) };
  } catch {
    return { path: null, sha256: null };
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
    const installed = installedManifest(name);
    const entrypoint = await resolvedEntrypoint(name);
    packages.push({
      name,
      lockedVersion: lockedVersionOf(lock, name),
      installedVersion: installed?.json.version ?? null,
      installedManifestSha256: installed ? sha256(installed.bytes) : null,
      resolvedEntrypoint: entrypoint.path,
      resolvedEntrypointSha256: entrypoint.sha256,
      transportProvenVersion: TRANSPORT_PROVEN_VERSIONS[name] ?? null,
    });
  }

  return {
    packageLockSha256: sha256(lockBytes),
    lockfileVersion: lock.lockfileVersion ?? null,
    nodeVersion: process.version,
    packages,
  };
}

/**
 * The preflight a live capture must pass before its first provider call.
 *
 * Three separate failures, all fail-closed: a package that is not installed, an install
 * that disagrees with the lockfile, and an install that disagrees with the version the
 * transport proof was run against. The last one is the point — it is what stops
 * "the test passed on SDK X and the capture quietly used SDK Y".
 *
 * Never runs npm. A mismatch is returned to a person to resolve deliberately.
 */
export async function assertDependenciesMatchLock(provenance = null) {
  const record = provenance ?? (await dependencyProvenance());
  const problems = [];

  for (const pkg of record.packages) {
    if (pkg.installedVersion === null) {
      problems.push(`${pkg.name} is not installed`);
      continue;
    }
    if (pkg.lockedVersion === null) {
      problems.push(`${pkg.name} is absent from package-lock.json`);
      continue;
    }
    if (pkg.lockedVersion !== pkg.installedVersion) {
      problems.push(`${pkg.name}: package-lock says ${pkg.lockedVersion}, installed is ${pkg.installedVersion}`);
    }
    if (pkg.transportProvenVersion !== null && pkg.installedVersion !== pkg.transportProvenVersion) {
      problems.push(
        `${pkg.name}: installed ${pkg.installedVersion} is not the ${pkg.transportProvenVersion} `
          + 'the transport no-retry test was proven against; re-run test-m2b-transport-policy.mjs and update TRANSPORT_PROVEN_VERSIONS',
      );
    }
    if (pkg.resolvedEntrypointSha256 === null) {
      problems.push(`${pkg.name}: could not resolve the entrypoint Node would load`);
    }
  }

  if (problems.length) {
    throw new DependencyProvenanceError(
      `Refusing to run: dependency provenance does not check out.\n  - ${problems.join('\n  - ')}`,
    );
  }
  return record;
}

export { sha256 };
