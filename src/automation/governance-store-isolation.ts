import { lstatSync, realpathSync, statSync, type BigIntStats } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, relative } from 'node:path';

// G1-R4T-1: raw governance storage is never agent, model or generated-code filesystem.
//
// The protected governance roots are the Controller store (runs and R4L admission) and
// the Authority Archive (DIRECT_AUTHORITY). A checksum is no substitute for keeping them
// out of reach: a process that can rewrite a record can rewrite its checksum too. So the
// live composition refuses any configuration in which a path an agent, a model process or
// generated code can see overlaps a protected root, and each sandbox boundary checks its
// own effective paths again before anything runs.
//
// Path identity is alias-aware. A path is resolved through its nearest existing ancestor
// (realpath), and overlap is decided both by filesystem identity (device and inode of
// every existing ancestor, so a symlink, firmlink or other alias cannot hide containment)
// and by component-wise comparison of the canonical paths ("/a/store" never overlaps
// "/a/store-old"). Anything whose identity cannot be established fails closed.
//
// This is capability and storage isolation inside one trusted host account. It is not
// Human authentication, it does not make hashes authentic, and it does not protect
// against the kernel, root, the host account itself, or code already running inside the
// trusted Chief host process.

export type GovernanceRootKind = 'CONTROLLER_STORE' | 'AUTHORITY_ARCHIVE';

/** A configuration or invocation that would expose a protected governance root. Fails closed; nothing is repaired. */
export class GovernanceStoreIsolationError extends Error {
  readonly code = 'GOVERNANCE_STORE_ISOLATION';
  constructor(message: string) {
    super(`GOVERNANCE_STORE_ISOLATION: ${message}`);
    this.name = 'GovernanceStoreIsolationError';
  }
}

type Node = string; // `${dev}:${ino}`
interface PathIdentity {
  /** Canonical path: the realpath of the nearest existing ancestor joined with the remaining components. */
  path: string;
  /** The path's own identity, when it exists. */
  node: Node | undefined;
  /** Identities of the nearest existing ancestor (or the path itself) and every ancestor up to the root. */
  chain: Node[];
}

const fail = (message: string) => new GovernanceStoreIsolationError(message);
const nodeOf = (stats: BigIntStats): Node => `${stats.dev}:${stats.ino}`;

function within(path: string, root: string): boolean {
  const rest = relative(root, path);
  return rest === '' || (rest !== '..' && !rest.startsWith('../') && !isAbsolute(rest));
}

function absent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/** The alias-aware identity of an absolute, normalised path. Throws when it cannot be established. */
function identify(label: string, path: unknown): PathIdentity {
  if (typeof path !== 'string' || !isAbsolute(path) || /[\u0000-\u001f]/.test(path) ||
      normalize(path) !== path || (path.length > 1 && path.endsWith('/'))) {
    throw fail(`${label} is not an absolute, normalised path`);
  }
  const remainder: string[] = [];
  let existing = path;
  for (;;) {
    try { lstatSync(existing); break; }
    catch (error) {
      if (!absent(error) || existing === '/') throw fail(`${label}: identity cannot be established`);
      remainder.unshift(basename(existing));
      existing = dirname(existing);
    }
  }
  let real: string;
  const chain: Node[] = [];
  try {
    real = realpathSync.native(existing);
    for (let current = real; ; current = dirname(current)) {
      chain.push(nodeOf(statSync(current, { bigint: true })));
      if (current === dirname(current)) break;
    }
  } catch { throw fail(`${label}: identity cannot be established`); }
  return { path: remainder.length ? join(real, ...remainder) : real, node: remainder.length ? undefined : chain[0], chain };
}

/** Whether two identities share any part of the tree: equal, one inside the other, or an alias of either. */
function overlapping(a: PathIdentity, b: PathIdentity): boolean {
  return (a.node !== undefined && b.chain.includes(a.node)) || (b.node !== undefined && a.chain.includes(b.node)) ||
    within(a.path, b.path) || within(b.path, a.path);
}

// `birth` also tells a recreated root from the original where an inode number is reused.
interface ProtectedRoot { kind: GovernanceRootKind; identity: PathIdentity; birth: bigint }

/**
 * A protected root as LIVE composition requires it: an existing, real directory (not a
 * symlink), owned by the host account where the platform reports ownership, and not
 * writable by group or others. Never created, chmodded or otherwise repaired.
 */
function protectedRoot(kind: GovernanceRootKind, path: unknown): ProtectedRoot {
  const identity = identify(kind, path);
  let stats: BigIntStats;
  try { stats = lstatSync(path as string, { bigint: true }); }
  catch (error) { throw fail(absent(error) ? `${kind} root does not exist; LIVE composition provisions nothing` : `${kind} root cannot be inspected`); }
  if (stats.isSymbolicLink()) throw fail(`${kind} root is a symlink`);
  if (!stats.isDirectory()) throw fail(`${kind} root is not a directory`);
  if (typeof process.getuid === 'function' && stats.uid !== BigInt(process.getuid())) throw fail(`${kind} root is not owned by the host account`);
  if ((stats.mode & 0o022n) !== 0n) throw fail(`${kind} root is writable by group or others`);
  return { kind, identity, birth: stats.birthtimeNs };
}

/**
 * The two protected governance roots and the overlap rule against them. Holds no
 * capability to either store: it can only say whether a path would expose one.
 */
export class GovernanceStoreIsolation {
  readonly #roots: readonly ProtectedRoot[];

  private constructor(roots: readonly ProtectedRoot[]) {
    this.#roots = Object.freeze(roots);
    Object.freeze(this);
  }

  /** The protected roots of a LIVE composition: both must already be safe, and they must be mutually disjoint. */
  static forLiveRoots(input: { controllerStoreDirectory: unknown; authorityArchiveDirectory: unknown }): GovernanceStoreIsolation {
    const controller = protectedRoot('CONTROLLER_STORE', input?.controllerStoreDirectory);
    const authority = protectedRoot('AUTHORITY_ARCHIVE', input?.authorityArchiveDirectory);
    if (overlapping(controller.identity, authority.identity)) throw fail('CONTROLLER_STORE and AUTHORITY_ARCHIVE roots overlap');
    return new GovernanceStoreIsolation([controller, authority]);
  }

  /**
   * Refuses a path an agent, model process or generated code could see when it is, contains, lies
   * inside, or aliases a protected root. Each call re-establishes both roots, so a root replaced
   * after composition fails closed.
   */
  assertDisjoint(label: string, path: unknown): void {
    const candidate = identify(label, path);
    for (const root of this.#roots) {
      const current = protectedRoot(root.kind, root.identity.path);
      if (current.identity.node !== root.identity.node || current.birth !== root.birth) {
        throw fail(`${root.kind} root changed after composition`);
      }
      if (overlapping(current.identity, candidate)) throw fail(`${label} overlaps the protected ${root.kind} root`);
    }
  }

  /** Refuses a fixed sandbox literal (a single readable or writable entry) that is a protected root. */
  assertNotRoot(label: string, path: unknown): void {
    const candidate = identify(label, path);
    for (const root of this.#roots) {
      if (candidate.node !== undefined && candidate.node === root.identity.node) throw fail(`${label} is the protected ${root.kind} root`);
    }
  }
}
Object.freeze(GovernanceStoreIsolation);
Object.freeze(GovernanceStoreIsolation.prototype);
