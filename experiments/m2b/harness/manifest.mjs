/**
 * Experiment manifest schema and validator (protocol §18.3).
 *
 * A manifest missing a mandatory field is not a warning. The field list is exactly the
 * set of things that, if unknown, make a run uninterpretable afterwards — which model
 * answered, which fixture, which code produced the prompt. A run without them cannot
 * enter evaluation, because there would be no way to say later what it was a run *of*.
 */
import { createHash } from 'node:crypto';

export class ManifestInvalid extends Error {
  constructor(problems) {
    super(`manifest is invalid: ${problems.join('; ')}`);
    this.name = 'ManifestInvalid';
    this.problems = problems;
  }
}

/** Protocol v0.2 §18.3 "必要(缺一則該 run 無效)". */
export const MANDATORY_FIELDS = Object.freeze([
  'experimentId',
  'protocolVersion',
  'fixtureId',
  'fixtureSha256',
  'snapshotSha256',
  'arm',
  'runIndex',
  'pins',
  'temperature',
  'retrievalPolicy',
  'evidenceLabelBaseline',
  'runtimeCommit',
  'promptSourceCommit',
  'chunkerVersion',
  'peerExcerptChars',
  // H-04: a manifest with no seal cannot be bound to a run. Protocol v0.2 §18.3 already
  // listed it; leaving it optional meant a run could claim pins nothing could check.
  'manifestSha256',
]);

export const ARMS = Object.freeze(['B', 'B_prime', 'C', 'D1']);

/** Which stages each arm must pin. An unpinned stage would fall to an adapter default. */
export const REQUIRED_PINS = Object.freeze({
  B: ['synthesis'],
  B_prime: ['synthesis_gate'],
  C: ['synthesis_gate', 'round2_worker', 'decision_synthesis'],
  D1: ['synthesis_gate', 'self_review', 'decision_synthesis'],
});

const SHA256 = /^[0-9a-f]{64}$/;

export function canonicalize(manifest) {
  const { manifestSha256: _drop, ...rest } = manifest;
  const sortDeep = (v) =>
    Array.isArray(v)
      ? v.map(sortDeep)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]))
        : v;
  return JSON.stringify(sortDeep(rest));
}

export function sealManifest(manifest) {
  return { ...manifest, manifestSha256: createHash('sha256').update(canonicalize(manifest)).digest('hex') };
}

/** @returns the manifest when valid; throws `ManifestInvalid` listing every problem found. */
export function validateManifest(manifest) {
  const problems = [];
  if (!manifest || typeof manifest !== 'object') throw new ManifestInvalid(['manifest is not an object']);

  for (const field of MANDATORY_FIELDS) {
    if (manifest[field] === undefined || manifest[field] === null || manifest[field] === '') {
      problems.push(`missing mandatory field "${field}"`);
    }
  }

  if (manifest.protocolVersion !== 'M2B-PROTOCOL-0.2') {
    problems.push(`protocolVersion must be "M2B-PROTOCOL-0.2", got ${JSON.stringify(manifest.protocolVersion)}`);
  }
  if (manifest.retrievalPolicy !== 'all-off') {
    problems.push(`retrievalPolicy must be "all-off", got ${JSON.stringify(manifest.retrievalPolicy)}`);
  }
  if (!ARMS.includes(manifest.arm)) {
    problems.push(`arm must be one of ${ARMS.join(', ')}, got ${JSON.stringify(manifest.arm)}`);
  }
  if (!Number.isInteger(manifest.runIndex) || manifest.runIndex < 1) {
    problems.push('runIndex must be a positive integer');
  }
  for (const field of ['fixtureSha256', 'snapshotSha256']) {
    if (manifest[field] !== undefined && !SHA256.test(String(manifest[field]))) {
      problems.push(`${field} must be a 64-character lowercase sha256`);
    }
  }
  if (!(manifest.temperature === 'unsupported' || typeof manifest.temperature === 'number')) {
    problems.push('temperature must be a number or the string "unsupported"');
  }

  const pins = manifest.pins ?? {};
  for (const stage of REQUIRED_PINS[manifest.arm] ?? []) {
    const pin = pins[stage];
    if (!pin) {
      problems.push(`arm ${manifest.arm} requires a pin for stage "${stage}"`);
      continue;
    }
    if (!pin.provider) problems.push(`pin for "${stage}" has no provider`);
    // The whole point of E2: an absent model means the adapter default decides silently.
    if (!pin.requestedModel) problems.push(`pin for "${stage}" has no requestedModel (adapter default is not a pin)`);
  }

  // Present-and-correct, not present-or-skip. An unsealed manifest is invalid (H-04).
  if (manifest.manifestSha256 === undefined) {
    problems.push('missing manifestSha256; an unsealed manifest cannot be bound to a run');
  } else {
    const expected = createHash('sha256').update(canonicalize(manifest)).digest('hex');
    if (manifest.manifestSha256 !== expected) {
      problems.push(`manifestSha256 does not match its contents (expected ${expected})`);
    }
  }

  if (problems.length) throw new ManifestInvalid(problems);
  return manifest;
}
