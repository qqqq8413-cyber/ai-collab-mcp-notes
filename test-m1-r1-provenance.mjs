import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXE, MODEL, REPOSITORY, READER_TURNS, hash, packetFor, parseContract, resourceInputPolicy } from './dist/limited-worker/contract.js';
import { tariffFromMarkdown } from './dist/limited-worker/transport.js';
import { REHEARSAL_PRICE_DOCUMENT } from './dist/limited-worker/rehearsal.js';
import { CLASS_ACCEPTANCE_DOMAIN, acceptanceHashOf, attestationVerifier, challengeOf, classDelegationVerifier, derivationOf, keyIdOf, parsePayload,
  passkeyPublicKey, readApprovalRecord, verifyAssertion, workerClass, workerClassHash, writeApprovalRecord } from './dist/limited-worker/run-approval.js';
import { draftRunDocuments, recordHashOf, verifyPacketProvenance, verifyPermit } from './dist/limited-worker/governance.js';
import { CLASS_DELEGATION_RULE, openAuthorityRecord, parseAuthorityDocument, sealAuthorityRecord } from './dist/automation/authority/document.js';
import { canonicalJson } from './dist/automation/invocation-journal.js';

// M1-R1: Architect Authority provenance (R-1) and first live pilot readiness. Everything is local and synthetic:
// software P-256 passkeys, a local TLS fake provider inside a child process, and "EXE lifted" runs on a patched COPY
// of dist in a temporary directory (the repository's source and dist keep EXE = 'HOLD'). No credential, account,
// provider or paid call exists in this file.
const ROOT = process.cwd();
let passed = 0, failed = 0;
// M1R1_ONLY=<name prefix> runs only the matching tests (used by regressions/m1/mutate-r1.py).
const ONLY = process.env.M1R1_ONLY;
async function test(name, fn) {
  if (ONLY && !name.startsWith(ONLY)) return;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'chief-m1r1-')));
  try { await fn(dir); passed++; console.log('  PASS ' + name); }
  catch (e) { failed++; console.error('  FAIL ' + name + ': ' + e.stack); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
const refusal = (f) => { try { f(); return 'NO_REFUSAL'; } catch (e) { return e.message; } };
const README = '# CHIEF\n\n說明文件。\n';
const source = { text: README, sha: 'a'.repeat(40), bytes: Buffer.byteLength(README), hash: hash(Buffer.from(README)) };
const contract = (agentId = 'limited-readme-worker', extra = {}) => parseContract({ schemaVersion: 1, kind: 'LIMITED_README_WORKER', repository: REPOSITORY,
  projectId: 'chief', goalId: `goal-${randomUUID()}`, objectiveHash: hash('goal'), runId: 'run-m1r1', implementationSha: 'c'.repeat(40), workerCodeHash: hash('code'),
  sourceSha: source.sha, sourcePath: 'README.md', sourceHash: source.hash, sourceBytes: source.bytes, agentId,
  ...(agentId === 'claude-code-reader' ? { maxTurns: READER_TURNS } : {}), provider: 'anthropic', model: MODEL, apiVersion: '2023-06-01',
  tools: ['READ_PINNED_README', 'WRITE_ISOLATED_REPORT'], outputKey: hash('out'), storageIdentity: hash('storage'), maxInputTokens: 200000,
  maxOutputTokens: 2048, maxCalls: 1, maxRetries: 0, maxCostMicroUsd: 1000000, totalCostMicroUsd: 1000000, timeoutSeconds: 300,
  quote: tariffFromMarkdown(REHEARSAL_PRICE_DOCUMENT, new Date().toISOString()), inputPolicy: resourceInputPolicy(), ...extra });
const ARCHITECT = 'architect:m1r1';
const acceptance = (c, over = {}) => ({ schema: 'chief-architect-class-acceptance.v1', recordClass: 'ARCHITECT_CLASS_ACCEPTANCE',
  delegationRule: 'ARCHITECT_CLASS_DELEGATION_V1', architectPrincipalRef: ARCHITECT, agentId: 'limited-readme-worker',
  classSchema: 'chief-limited-worker-class.v1', classHash: workerClassHash(c), implementationSha: c.implementationSha, acceptanceVersion: 1, supersedes: null,
  source: { kind: 'ARCHITECT_REVIEW_DECISION', reviewRef: 'GPT-6 M1-R1 review', decisionSha256: hash('GPT-6: ACCEPTED') }, acceptedAt: '2026-10-27T00:00:00.000Z', ...over });
const approverOf = (a) => ({ architectAcceptance: a, acceptanceHash: acceptanceHashOf(a) });
const window = () => { const now = Date.now(); return { issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 600000).toISOString(), nonce: randomUUID() }; };
const derivedDocs = (c, approver, principal = ARCHITECT) => draftRunDocuments(c, packetFor(c, 'slice-1'), { architectPrincipalRef: principal, humanPrincipalRef: 'human:m1r1',
  ...window(), derivation: derivationOf(approver) });
const recordView = (doc) => ({ issuer: doc.issuer, derivation: doc.derivation, version: doc.version });

// ================================================================ R-1: three different things, never confused
await test('R-1 record classes: a derived record is a version 1 packet with one derivation; direct authority carries none; grants are never derived', async () => {
  const c = contract(), approver = approverOf(acceptance(c)), [packet, live, limited] = derivedDocs(c, approver);
  assert.deepEqual([packet.recordClass, live.recordClass, limited.recordClass], ['CLASS_DERIVED_AUTHORITY', 'DIRECT_AUTHORITY', 'DIRECT_AUTHORITY']);
  assert.deepEqual(packet.derivation, { rule: CLASS_DELEGATION_RULE, derivedBy: 'CHIEF_TRUSTED_HOST', acceptanceHash: approver.acceptanceHash,
    classHash: workerClassHash(c), implementationSha: c.implementationSha });
  assert.equal(packet.issuer.principalRef, ARCHITECT, 'the issuer is the accepting principal (delegator)');
  assert.equal('derivation' in live || 'derivation' in limited, false);
  const invalid = (doc) => refusal(() => parseAuthorityDocument(doc));
  assert.match(invalid({ ...packet, recordClass: 'DIRECT_AUTHORITY' }), /derivation/);
  const { derivation: _d, ...bare } = packet;
  assert.match(invalid(bare), /derivation/);
  assert.match(invalid({ ...live, recordClass: 'CLASS_DERIVED_AUTHORITY', derivation: packet.derivation }), /Only a version 1 implementation packet/);
  assert.match(invalid({ ...packet, derivation: { ...packet.derivation, rule: 'SOMETHING_ELSE' } }), /AuthorityDocumentV1/);
  assert.match(invalid({ ...packet, derivation: { ...packet.derivation, extra: 1 } }), /AuthorityDocumentV1/);
  // Direct records are byte-for-byte what they were before R-1 (no derivation key, same hashing).
  const sealed = sealAuthorityRecord(live), text = canonicalJson(sealed);
  assert.equal(text.includes('derivation'), false);
  assert.equal(openAuthorityRecord(text).recordHash, sealed.recordHash);
  // A stored derived record whose class is flipped to DIRECT (or whose derivation is edited) fails its integrity check.
  const stored = sealAuthorityRecord(packet), flipped = { ...stored, recordClass: 'DIRECT_AUTHORITY' }; delete flipped.derivation;
  assert.match(refusal(() => openAuthorityRecord(canonicalJson(flipped))), /hash mismatch/);
  assert.match(refusal(() => openAuthorityRecord(canonicalJson({ ...stored, derivation: { ...stored.derivation, acceptanceHash: 'f'.repeat(64) } }))), /hash mismatch/);
  const asDirect = { ...packet, recordClass: 'DIRECT_AUTHORITY' }; delete asDirect.derivation;
  assert.notEqual(recordHashOf(packet), sealAuthorityRecord(asDirect).recordHash, 'a derived record and a direct record with the same body differ');
});

await test('R-1 standing acceptance: domain-separated hash over source and version; every field binds; the version chain is explicit', async () => {
  const c = contract(), a = acceptance(c), h = acceptanceHashOf(a);
  assert.equal(CLASS_ACCEPTANCE_DOMAIN, 'CHIEF-ARCHITECT-CLASS-ACCEPTANCE-V1\n');
  assert.equal(h, createHash('sha256').update(CLASS_ACCEPTANCE_DOMAIN + canonicalJson(a)).digest('hex'));
  const changed = { architectPrincipalRef: 'architect:other', classHash: 'f'.repeat(64), implementationSha: 'd'.repeat(40), acceptedAt: '2026-10-28T00:00:00.000Z',
    source: { ...a.source, decisionSha256: hash('another decision') }, sourceRef: { ...a.source, reviewRef: 'another review' } };
  for (const [name, value] of Object.entries(changed)) {
    const key = name === 'sourceRef' ? 'source' : name;
    assert.notEqual(acceptanceHashOf({ ...a, [key]: value }), h, name);
  }
  assert.notEqual(acceptanceHashOf({ ...a, acceptanceVersion: 2, supersedes: h }), h);
  // The chain: version 1 supersedes nothing; a later version names the one it supersedes.
  assert.equal(refusal(() => acceptanceHashOf({ ...a, acceptanceVersion: 2, supersedes: null })), 'CLASS_ACCEPTANCE_INVALID');
  assert.equal(refusal(() => acceptanceHashOf({ ...a, supersedes: h })), 'CLASS_ACCEPTANCE_INVALID');
  for (const bad of [{ classSchema: 'chief-limited-worker-class.v2' }, { delegationRule: 'ANY' }, { agentId: 'claude-code-reader' }, { recordClass: 'DIRECT_AUTHORITY' },
    { architectPrincipalRef: ' architect:m1r1' }, { source: { ...a.source, kind: 'CHAT_MESSAGE' } }, { extra: true }]) {
    assert.equal(refusal(() => acceptanceHashOf({ ...a, ...bad })), 'CLASS_ACCEPTANCE_INVALID', JSON.stringify(bad));
  }
});

await test('R-1 class-delegation rule: admits exactly the derived packet the pinned acceptance allows; source, version, issuer and packet substitutions are refused', async () => {
  const c = contract(), a = acceptance(c), approver = approverOf(a), rule = classDelegationVerifier(approver), [doc] = derivedDocs(c, approver);
  const packet = doc.body;
  assert.doesNotThrow(() => rule(recordView(doc), packet));
  const r = (record, p = packet) => refusal(() => rule(record, p));
  // Issuer: another principal, another role (a Human), or a later version.
  assert.equal(r({ ...recordView(doc), issuer: { role: 'GPT_ARCHITECT', principalRef: 'architect:someone-else' } }), 'DELEGATION_ISSUER_MISMATCH');
  assert.equal(r({ ...recordView(doc), issuer: { role: 'HUMAN', principalRef: ARCHITECT } }), 'DELEGATION_ISSUER_MISMATCH');
  assert.equal(r({ ...recordView(doc), version: 2 }), 'DELEGATION_ISSUER_MISMATCH');
  // Source substitution: a derivation naming another acceptance (another decision text, review or version).
  for (const other of [acceptance(c, { source: { ...a.source, decisionSha256: hash('forged decision') } }), acceptance(c, { source: { ...a.source, reviewRef: 'another review' } }),
    acceptance(c, { acceptanceVersion: 2, supersedes: approver.acceptanceHash })]) {
    assert.equal(r({ ...recordView(doc), derivation: derivationOf(approverOf(other)) }), 'DELEGATION_ACCEPTANCE_MISMATCH');
  }
  assert.equal(r({ ...recordView(doc), derivation: { ...doc.derivation, derivedBy: 'SOMEONE' } }), 'DELEGATION_ACCEPTANCE_MISMATCH');
  // Version mismatch: the derivation states another class or SHA than the acceptance it names.
  assert.equal(r({ ...recordView(doc), derivation: { ...doc.derivation, classHash: 'f'.repeat(64) } }), 'WORKER_CLASS_NOT_ACCEPTED');
  assert.equal(r({ ...recordView(doc), derivation: { ...doc.derivation, implementationSha: 'd'.repeat(40) } }), 'IMPLEMENTATION_NOT_ACCEPTED');
  // Packet substitution: a contract at another SHA, another class (other README pin), the reader, or a packet not exactly packetFor.
  const atOtherSha = contract('limited-readme-worker', { implementationSha: 'd'.repeat(40) });
  assert.equal(r(recordView(doc), packetFor(atOtherSha, 'slice-1')), 'IMPLEMENTATION_NOT_ACCEPTED');
  assert.equal(r(recordView(doc), packetFor(contract('limited-readme-worker', { sourceSha: 'b'.repeat(40) }), 'slice-1')), 'WORKER_CLASS_NOT_ACCEPTED');
  assert.equal(r(recordView(doc), packetFor(contract('claude-code-reader'), 'slice-1')), 'WORKER_CLASS_NOT_ACCEPTED');
  assert.equal(r(recordView(doc), { ...packet, invariants: ['READ_ONLY_SOURCE'] }), 'DELEGATION_PACKET_NOT_DERIVED');
  assert.equal(r(recordView(doc), { ...packet, objective: '{}' }), 'DELEGATION_PACKET_NOT_DERIVED');
  // A pinned acceptance whose stated hash is not its own content's hash builds no rule at all.
  assert.equal(refusal(() => classDelegationVerifier({ architectAcceptance: a, acceptanceHash: 'f'.repeat(64) })), 'CLASS_ACCEPTANCE_HASH_MISMATCH');
  // A rule from another acceptance (the Human pinned a different decision) refuses this record.
  const otherRule = classDelegationVerifier(approverOf(acceptance(c, { source: { ...a.source, decisionSha256: hash('different') } })));
  assert.equal(refusal(() => otherRule(recordView(doc), packet)), 'DELEGATION_ACCEPTANCE_MISMATCH');
});

await test('R-1 governance verification: a derived packet record is never treated as direct authority; without the explicit rule it is refused', async () => {
  const c = contract(), approver = approverOf(acceptance(c)), [doc] = derivedDocs(c, approver), rule = classDelegationVerifier(approver);
  const fact = { recordClass: doc.recordClass, issuer: doc.issuer, derivation: doc.derivation, version: 1 };
  assert.equal(refusal(() => verifyPacketProvenance(fact, doc.body, undefined, 'X_REFUSED')), 'X_REFUSED');
  assert.doesNotThrow(() => verifyPacketProvenance(fact, doc.body, rule, 'X_REFUSED'));
  // A direct record passes unchanged; a direct record carrying a derivation, or an unknown class, is refused.
  assert.doesNotThrow(() => verifyPacketProvenance({ recordClass: 'DIRECT_AUTHORITY', issuer: doc.issuer, version: 1 }, doc.body, undefined, 'X_REFUSED'));
  assert.equal(refusal(() => verifyPacketProvenance({ ...fact, recordClass: 'DIRECT_AUTHORITY' }, doc.body, rule, 'X_REFUSED')), 'X_REFUSED');
  assert.equal(refusal(() => verifyPacketProvenance({ ...fact, recordClass: 'OPERATIONAL_RECORD' }, doc.body, rule, 'X_REFUSED')), 'X_REFUSED');
  // verifyPermit (every Worker check, including the final send guard) reads the archived class from the read model.
  const sealed = sealAuthorityRecord(doc);
  const model = { anomalies: [], runs: [{ runId: c.runId, repository: c.repository, sliceId: 'slice-1', anomalies: [] }],
    authority: [{ ref: { kind: 'IMPLEMENTATION_PACKET', authorityId: doc.authorityId, version: 1, recordHash: sealed.recordHash }, recordClass: sealed.recordClass,
      derivation: sealed.derivation, issuedAt: sealed.issuedAt, issuer: sealed.issuer, subject: { repository: c.repository, sliceId: 'slice-1' }, bodyHash: sealed.bodyHash }] };
  const permit = (classDelegation) => refusal(() => verifyPermit(c, { grant: null, liveGrant: null, model, packet: doc.body, humanPrincipalRef: 'human:m1r1',
    architectPrincipalRef: ARCHITECT, now: new Date().toISOString(), classDelegation }));
  assert.equal(permit(undefined), 'PACKET_AUTHORITY_DERIVED_WITHOUT_DELEGATION');
  // With the rule the packet check passes and verification proceeds to the Human grants (absent here).
  assert.equal(permit(rule), 'LIMITED_PERMIT_NOT_BOUND_OR_EXPIRED');
  const otherRule = classDelegationVerifier(approverOf(acceptance(c, { acceptanceVersion: 2, supersedes: approver.acceptanceHash })));
  assert.equal(permit(otherRule), 'DELEGATION_ACCEPTANCE_MISMATCH');
});

// ================================================================ WebAuthn: forgery and replay at the record level
function authenticator() {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), id = randomBytes(16);
  const spki = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const approver = { passkey: { rpId: 'localhost', origins: ['http://localhost:4876'], credentialId: id.toString('base64url'), publicKeySpki: spki, algorithm: 'ES256' },
    publicKey: passkeyPublicKey(spki), keyId: keyIdOf(spki) };
  let count = 0;
  const parts = (challenge, { flags = 0x05, origin = 'http://localhost:4876', extra = {} } = {}) => {
    const authData = Buffer.concat([createHash('sha256').update('localhost').digest(), Buffer.from([flags]), Buffer.alloc(4)]); authData.writeUInt32BE(++count, 33);
    const client = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: challenge.toString('base64url'), origin, crossOrigin: false, ...extra }));
    return { authData, client };
  };
  const signed = ({ authData, client }, key = keys.privateKey) => ({ credentialId: id.toString('base64url'), authenticatorData: authData.toString('base64url'),
    clientDataJSON: client.toString('base64url'), signature: sign('sha256', Buffer.concat([authData, createHash('sha256').update(client).digest()]), { key, dsaEncoding: 'der' }).toString('base64url') });
  return { approver, parts, signed, assertion: (challenge, o) => signed(parts(challenge, o)) };
}
await test('WebAuthn forgery: bytes changed after signing, a forged or truncated signature, a borrowed credential id and another signer are all refused', async () => {
  const a = authenticator(), challenge = createHash('sha256').update('m1r1').digest(), v = (input) => refusal(() => verifyAssertion(a.approver, input, challenge));
  const ok = a.assertion(challenge); assert.doesNotThrow(() => verifyAssertion(a.approver, ok, challenge));
  // UV switched on after signing a UV-less assertion: the signature no longer covers the bytes.
  const noUv = a.parts(challenge, { flags: 0x01 }), signedNoUv = a.signed(noUv), flipped = Buffer.from(signedNoUv.authenticatorData, 'base64url'); flipped[32] = 0x05;
  assert.equal(v({ ...signedNoUv, authenticatorData: flipped.toString('base64url') }), 'PASSKEY_SIGNATURE_INVALID');
  // Sign count rewritten, client data extended after signing (the challenge and origin still match).
  const counted = Buffer.from(ok.authenticatorData, 'base64url'); counted.writeUInt32BE(999999, 33);
  assert.equal(v({ ...ok, authenticatorData: counted.toString('base64url') }), 'PASSKEY_SIGNATURE_INVALID');
  const client = JSON.parse(Buffer.from(ok.clientDataJSON, 'base64url').toString()); client.tokenBinding = { status: 'present' };
  assert.equal(v({ ...ok, clientDataJSON: Buffer.from(JSON.stringify(client)).toString('base64url') }), 'PASSKEY_SIGNATURE_INVALID');
  // Truncated, zeroed, raw (non-DER) and empty signatures.
  const sig = Buffer.from(ok.signature, 'base64url');
  for (const bad of [sig.subarray(0, sig.length - 4), Buffer.alloc(sig.length), Buffer.alloc(64, 1)]) assert.equal(v({ ...ok, signature: bad.toString('base64url') }), 'PASSKEY_SIGNATURE_INVALID');
  assert.equal(v({ ...ok, signature: '' }), 'PASSKEY_ASSERTION_INVALID');
  // Another key signs while claiming the pinned credential id; or the pinned key's assertion is relabelled with another id.
  const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
  assert.equal(v(a.signed(a.parts(challenge), other)), 'PASSKEY_SIGNATURE_INVALID');
  assert.equal(v({ ...ok, credentialId: randomBytes(16).toString('base64url') }), 'PASSKEY_CREDENTIAL_MISMATCH');
  // A valid assertion for another challenge (another payload) is not this approval.
  assert.equal(refusal(() => verifyAssertion(a.approver, a.assertion(createHash('sha256').update('other run').digest()), challenge)), 'PASSKEY_CHALLENGE_MISMATCH');
});
await test('WebAuthn replay: one consumed approval per job; a record copied to another job, re-pinned to another acceptance or edited is refused', async (dir) => {
  const a = authenticator(), c = contract(), approver = { ...a.approver, ...approverOf(acceptance(c)) }, w = window();
  const payload = parsePayload({ payloadSchema: 'chief-activation-attestation.v1', policyVersion: 'M1_PASSKEY_RUN_V1', setHash: 'a'.repeat(64), runId: c.runId,
    repository: REPOSITORY, contractHash: hash(c), packetId: 'limited-x', packetHash: 'b'.repeat(64), packetRecordClass: 'CLASS_DERIVED_AUTHORITY',
    packetRecordHash: '9'.repeat(64), acceptanceHash: approver.acceptanceHash, implementationSha: c.implementationSha, workerCodeHash: c.workerCodeHash,
    operations: ['LIMITED_README_WORKER', 'LIVE_PROVIDER_MODEL_CALL'], grants: [{ operation: 'LIMITED_README_WORKER', authorityId: 'l', version: 1, recordHash: 'd'.repeat(64) },
      { operation: 'LIVE_PROVIDER_MODEL_CALL', authorityId: 'v', version: 1, recordHash: 'e'.repeat(64) }], classHash: workerClassHash(c), agentId: 'limited-readme-worker',
    model: MODEL, maxModelRequests: 1, maxRetries: 0, approvedMaxReservationMicroUsd: 210240, signerKeyId: a.approver.keyId, rpId: 'localhost', ...w });
  const challenge = challengeOf(payload), passkey = a.assertion(challenge), verified = verifyAssertion(a.approver, passkey, challenge);
  const record = { jobId: hash(c), payload, challenge: challenge.toString('base64url'), assertion: passkey, assertionHash: verified.assertionHash, keyId: a.approver.keyId,
    signCount: verified.signCount, verifiedAt: new Date().toISOString() };
  writeApprovalRecord(dir, record);
  assert.equal(refusal(() => writeApprovalRecord(dir, record)), 'APPROVAL_ALREADY_USED', 'the same approval twice');
  assert.equal(refusal(() => writeApprovalRecord(dir, { ...record, assertion: a.assertion(challenge) })), 'APPROVAL_ALREADY_USED', 'a fresh assertion for a used job');
  const verify = attestationVerifier(dir, approver, () => new Date().toISOString());
  assert.doesNotThrow(() => verify(c, payload.setHash));
  // Copied under another job's name: refused as that job's approval.
  const other = contract('limited-readme-worker', { runId: 'run-other' });
  writeFileSync(join(dir, 'm1-approvals', `${hash(other)}.json`), readFileSync(join(dir, 'm1-approvals', `${hash(c)}.json`)), { mode: 0o600 });
  assert.equal(refusal(() => readApprovalRecord(dir, hash(other))), 'APPROVAL_RECORD_CORRUPT');
  // Another pinned acceptance (source or version substituted after the approval) no longer verifies the same record.
  const v2 = approverOf(acceptance(c, { acceptanceVersion: 2, supersedes: approver.acceptanceHash }));
  assert.equal(refusal(() => attestationVerifier(dir, { ...a.approver, ...v2 }, () => new Date().toISOString())(c, payload.setHash)), 'ATTESTATION_BINDING_MISMATCH');
  // The payload in the record edited to name another acceptance: the signed challenge no longer matches.
  const file = join(dir, 'm1-approvals', `${hash(c)}.json`), stored = JSON.parse(readFileSync(file, 'utf8'));
  rmSync(file); writeFileSync(file, JSON.stringify({ ...stored, payload: { ...stored.payload, packetRecordHash: 'f'.repeat(64) } }), { mode: 0o600 });
  assert.equal(refusal(() => verify(c, payload.setHash)), 'ATTESTATION_BINDING_MISMATCH');
  // The payload schema itself: only a derived packet record can be named.
  assert.equal(refusal(() => parsePayload({ ...payload, packetRecordClass: 'DIRECT_AUTHORITY' })), 'APPROVAL_PAYLOAD_INVALID');
  const { acceptanceHash: _x, ...noAcceptance } = payload;
  assert.equal(refusal(() => parsePayload(noAcceptance)), 'APPROVAL_PAYLOAD_INVALID');
});

// ================================================================ first live pilot profile and EXE HOLD
await test('Pilot profile: the accepted class pins the README Worker, one Messages request, 0 retries, 300 s, 2,048 output tokens, US$1, no Git, no deploy', async () => {
  const k = workerClass(contract());
  assert.deepEqual([k.agentId, k.provider, k.model, k.maxCalls, k.maxRetries, k.requestBound.maxModelRequests, k.requestBound.proof, k.timeoutSeconds,
    k.maxOutputTokens, k.maxCostMicroUsd, k.totalCostMicroUsd, k.sourcePath, k.tools],
    ['limited-readme-worker', 'anthropic', MODEL, 1, 0, 1, 'ONE_NATIVE_HTTPS_REQUEST_NO_SDK_NO_RETRY', 300, 2048, 1000000, 1000000, 'README.md', ['READ_PINNED_README', 'WRITE_ISOLATED_REPORT']]);
  assert.deepEqual(k.packetTemplate.allowedAreas, ['README.md']);
  for (const forbidden of ['ALL_SOURCE_WRITES', 'GIT_WRITE', 'PUSH', 'DEPLOY', 'AUTHORITY_WRITE', 'SHELL', 'OTHER_AGENTS']) assert.ok(k.packetTemplate.forbiddenChanges.includes(forbidden), forbidden);
  assert.deepEqual([k.packetTemplate.providerCallAuthorization.maxCalls, k.packetTemplate.destructiveOperationAuthorization.allowed, k.packetTemplate.networkAuthorization.destinations],
    [1, false, ['api.anthropic.com:443', 'platform.claude.com:443']]);
  // Any other bound is not a contract at all (schema literals), so it cannot be accepted or derived.
  for (const over of [{ maxOutputTokens: 4096 }, { timeoutSeconds: 600 }, { maxRetries: 1 }, { maxCalls: 2 }, { totalCostMicroUsd: 2000000 }]) {
    assert.notEqual(refusal(() => contract('limited-readme-worker', over)), 'NO_REFUSAL', JSON.stringify(over));
  }
  // The Claude Code reader is another class and never derivable under a README acceptance (no proven request bound).
  const approver = approverOf(acceptance(contract()));
  assert.notEqual(workerClassHash(contract('claude-code-reader')), approver.architectAcceptance.classHash);
  // The real Host: no CLI reader, the public API with no injected requester, and the key only from the Host environment.
  const main = readFileSync(join(ROOT, 'src/limited-worker/main.ts'), 'utf8');
  assert.match(main, /'claude-code-reader':unconfiguredLiveTransport\('READER_REQUEST_BOUND_UNPROVEN'\)/);
  assert.match(main, /nativeAnthropicTransport\(\(\)=>\{\s*const key=process\.env\.CHIEF_LIMITED_ANTHROPIC_KEY;[^}]*\}\)/);
  assert.doesNotMatch(main, /requester/);
  assert.match(main, /\| EXE \$\{EXE\} \|/, 'the Host states the real EXE value at startup');
});
await test('EXE HOLD cannot be lifted by an agent: one source constant, no environment, flag, config, file or HTTP action changes it', async () => {
  const files = (dir) => readdirSync(join(ROOT, dir), { recursive: true }).map(String).filter((p) => p.endsWith('.ts')).map((p) => join(dir, p));
  const src = files('src').map((p) => [p, readFileSync(join(ROOT, p), 'utf8')]);
  assert.deepEqual(src.filter(([, t]) => /export const EXE\b/.test(t)).map(([p, t]) => [p, t.match(/export const EXE = [^;]+;/)[0]]),
    [['src/limited-worker/contract.ts', "export const EXE = 'HOLD' as const;"]]);
  assert.deepEqual(src.filter(([, t]) => /\bEXE\s*=[^=]/.test(t.replace(/export const EXE = 'HOLD' as const;/, ''))).map(([p]) => p), [], 'no other assignment');
  assert.deepEqual(src.filter(([, t]) => /LIVE_PILOT/.test(t)).map(([p]) => p), [], 'no code names the lifted value');
  // The limited worker reads exactly one environment variable: the Host's API key.
  const envReads = src.filter(([p]) => p.startsWith('src/limited-worker/')).flatMap(([p, t]) => [...t.matchAll(/process\.env(?:\.([A-Z_]+)|\[)/g)].map((m) => `${p}:${m[1] ?? '['}`));
  assert.deepEqual([...new Set(envReads)].filter((r) => !r.startsWith('src/limited-worker/claude-code-reader.ts')), ['src/limited-worker/main.ts:CHIEF_LIMITED_ANTHROPIC_KEY']);
  assert.match(readFileSync(join(ROOT, 'src/limited-worker/main.ts'), 'utf8'), /allowed = \['--host-config','--port','--approver-config','--measurement-mode'\]/);
  assert.match(readFileSync(join(ROOT, 'src/limited-worker/service.ts'), 'utf8'), /action: z\.enum\(\['CHECK', 'START', 'CANCEL','RECONCILE','REQUEST_APPROVAL'\]\)/);
  assert.equal(EXE, 'HOLD');
  assert.equal(readFileSync(join(ROOT, 'dist/limited-worker/contract.js'), 'utf8').includes("export const EXE = 'HOLD';"), true);
});

// ================================================================ over HTTP: real build (HOLD) and EXE-lifted copy
const harness = join(ROOT, 'regressions/m1/lifted-host.mjs');
const runHarness = (dist, scenario, dir, env = {}) => {
  const work = join(dir, scenario); mkdirSync(work, { recursive: true });
  const out = execFileSync(process.execPath, [harness, dist, scenario, work], { encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  const facts = JSON.parse(out.trim().split('\n').at(-1));
  assert.equal(facts.error, undefined, facts.error);
  return facts;
};
let lifted = null;
const liftedDist = () => {
  if (lifted) return lifted;
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'chief-m1r1-lifted-')));
  for (const p of ['dist', 'workspace-ui', 'package.json']) cpSync(join(ROOT, p), join(base, p), { recursive: true });
  symlinkSync(join(ROOT, 'node_modules'), join(base, 'node_modules'));
  const file = join(base, 'dist/limited-worker/contract.js'), text = readFileSync(file, 'utf8');
  assert.equal(text.split("export const EXE = 'HOLD';").length, 2, 'exactly one EXE declaration');
  writeFileSync(file, text.replace("export const EXE = 'HOLD';", "export const EXE = 'LIVE_PILOT';"));
  lifted = { base, dist: join(base, 'dist') };
  return lifted;
};
await test('Real build (EXE HOLD), valid candidate, agent-set environment: the runtime called directly still refuses EXE_HOLD before any write', async (dir) => {
  const f = runHarness(join(ROOT, 'dist'), 'hold', dir, { EXE: 'LIVE_PILOT', CHIEF_EXE: 'LIVE_PILOT', CHIEF_LIMITED_EXE: 'LIVE_PILOT' });
  assert.deepEqual(f.holdDirect, { request: 'EXE_HOLD', execute: 'EXE_HOLD', envSeen: ['EXE', 'CHIEF_EXE', 'CHIEF_LIMITED_EXE'] });
  assert.deepEqual([f.hold.request, f.hold.start, f.status.classAccepted, f.status.implementationAccepted, f.status.refusal], ['EXE_HOLD', 'EXE_HOLD', true, true, null]);
  assert.deepEqual([f.holdArchive, f.holdRecords, f.holdSets, f.provider.messages, f.provider.models, f.provider.price], [0, false, false, 0, 0, 0]);
});
await test('EXE-lifted copy: only the run the Human approved executes; unrequested, passkey-less, replayed, copied-record and archive-planted runs never send', async (dir) => {
  const f = runHarness(liftedDist().dist, 'only-approved', dir);
  assert.equal(f.runA, 'COMPLETED');
  assert.deepEqual(f.runB, { notRequested: 'APPROVAL_NOT_REQUESTED', noPasskey: 'PASSKEY_APPROVAL_REQUIRED', replayA: 'PASSKEY_CHALLENGE_MISMATCH',
    copiedRecord: 'APPROVAL_RECORD_CORRUPT', direct: 'PASSKEY_APPROVAL_REQUIRED' });
  assert.deepEqual(f.runC, { planted: ['CLASS_DERIVED_AUTHORITY'], start: 'APPROVAL_NOT_REQUESTED', direct: 'APPROVAL_NOT_REQUESTED', state: 'PREPARED' });
  assert.deepEqual(f.states, { A: 'COMPLETED', B: 'PREPARED', C: 'PREPARED' });
  assert.deepEqual(f.consumed, f.expectedConsumed);
  assert.deepEqual([f.provider.messages, f.provider.models, f.provider.price], [1, 1, 1], 'exactly one Messages request in total: run A');
});
await test('EXE-lifted copy: substituting the acceptance source, its version, the accepted SHA or the Architect principal after approval sends nothing', async (dir) => {
  const f = runHarness(liftedDist().dist, 'substitution', dir);
  assert.deepEqual(f.sourceSubstituted, { acceptanceChanged: true, start: 'APPROVAL_BINDING_MISMATCH' });
  assert.deepEqual(f.versionSuperseded, { acceptanceChanged: true, start: 'APPROVAL_BINDING_MISMATCH' });
  assert.deepEqual(f.otherSha, { start: 'IMPLEMENTATION_NOT_ACCEPTED', request: 'IMPLEMENTATION_NOT_ACCEPTED' });
  assert.deepEqual(f.otherArchitect, { start: 'APPROVER_PRINCIPAL_MISMATCH', request: 'APPROVER_PRINCIPAL_MISMATCH' });
  assert.equal(f.otherClassSchema, 'APPROVER_CONFIG_INVALID');
  assert.deepEqual([f.afterSubstitution.archive, f.afterSubstitution.records, f.afterSubstitution.sets, f.afterSubstitution.messages], [0, false, false, 0]);
  assert.deepEqual(f.restored, { acceptanceIsV1: true, state: 'COMPLETED', messages: 1 });
});
if (lifted) rmSync(lifted.base, { recursive: true, force: true });
assert.equal(readFileSync(join(ROOT, 'dist/limited-worker/contract.js'), 'utf8').includes("export const EXE = 'HOLD';"), true, 'the repository build keeps HOLD');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
