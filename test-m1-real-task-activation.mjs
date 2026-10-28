import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXE, MODEL, REPOSITORY, READER_TURNS, assertLiveRequestBound, hash, maximumCost, packetFor, parseContract, requestBound, resourceInputPolicy }
  from './dist/limited-worker/contract.js';
import { tariffFromMarkdown } from './dist/limited-worker/transport.js';
import { claudeCodeReaderTransport, readerEnvironment, seatbeltReaderRunner } from './dist/limited-worker/claude-code-reader.js';
import { REHEARSAL_PRICE_DOCUMENT } from './dist/limited-worker/rehearsal.js';
import { M1_SIGNATURE_POLICY, SIGNATURE_POLICY, liveEligibility } from './dist/limited-worker/activation-set.js';
import { APPROVAL_DOMAIN, MAX_APPROVAL_SECONDS, attestationVerifier, challengeOf, keyIdOf, loadApprover, parsePayload, passkeyPublicKey, readApprovalRecord,
  verifyAssertion, verifyRegistration, workerClass, workerClassHash, writeApprovalRecord } from './dist/limited-worker/run-approval.js';
import { LIVE_AUTHORIZATION_STEPS, approvalPreview } from './dist/limited-worker/service.js';
import { jobsHTML, workerHTML } from './workspace-ui/limited-worker.js';

// M1 REAL TASK ACTIVATION. No real credential, provider, account or paid call exists in this file: passkeys are
// software P-256 test keys, the provider is a local TLS fake inside a child process. M1-LIFT-P0: the repository's source
// and dist are the LIVE_PILOT candidate; the HOLD runs use a COPY of dist patched back to EXE = 'HOLD' in a temporary directory.
const ROOT = process.cwd();
let passed = 0, failed = 0;
async function test(name, fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'chief-m1-')));
  try { await fn(dir); passed++; console.log('  PASS ' + name); }
  catch (e) { failed++; console.error('  FAIL ' + name + ': ' + e.stack); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
const README = '# CHIEF\n\n說明文件。\n';
const source = { text: README, sha: 'a'.repeat(40), bytes: Buffer.byteLength(README), hash: hash(Buffer.from(README)) };
const contract = (agentId, extra = {}) => parseContract({ schemaVersion: 1, kind: 'LIMITED_README_WORKER', repository: REPOSITORY, projectId: 'chief',
  goalId: `goal-${randomUUID()}`, objectiveHash: hash('goal'), runId: 'run-m1', implementationSha: 'c'.repeat(40), workerCodeHash: hash('code'),
  sourceSha: source.sha, sourcePath: 'README.md', sourceHash: source.hash, sourceBytes: source.bytes, agentId,
  ...(agentId === 'claude-code-reader' ? { maxTurns: READER_TURNS } : {}), provider: 'anthropic', model: MODEL, apiVersion: '2023-06-01',
  tools: ['READ_PINNED_README', 'WRITE_ISOLATED_REPORT'], outputKey: hash('out'), storageIdentity: hash('storage'), maxInputTokens: 200000,
  maxOutputTokens: 2048, maxCalls: 1, maxRetries: 0, maxCostMicroUsd: 1000000, totalCostMicroUsd: 1000000, timeoutSeconds: 300,
  quote: tariffFromMarkdown(REHEARSAL_PRICE_DOCUMENT, new Date().toISOString()), inputPolicy: resourceInputPolicy(), ...extra });

// M1-R1: a valid standing ARCHITECT_CLASS_ACCEPTANCE record (synthetic values).
const acceptance = (over = {}) => ({ schema: 'chief-architect-class-acceptance.v1', recordClass: 'ARCHITECT_CLASS_ACCEPTANCE',
  delegationRule: 'ARCHITECT_CLASS_DELEGATION_V1', architectPrincipalRef: 'architect:m1', agentId: 'limited-readme-worker',
  classSchema: 'chief-limited-worker-class.v1', classHash: 'e'.repeat(64), implementationSha: 'c'.repeat(40), acceptanceVersion: 1, supersedes: null,
  source: { kind: 'ARCHITECT_REVIEW_DECISION', reviewRef: 'M1', decisionSha256: 'd'.repeat(64) }, acceptedAt: '2026-10-27T00:00:00.000Z', ...over });
const R1_PAYLOAD = { packetRecordClass: 'CLASS_DERIVED_AUTHORITY', packetRecordHash: '9'.repeat(64), acceptanceHash: '8'.repeat(64) };

// ---------------------------------------------------------------- software passkey (test authenticator only)
const rpHash = (rpId = 'localhost') => createHash('sha256').update(rpId).digest();
function authenticator() {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), id = randomBytes(16);
  const spki = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  let count = 0;
  const approver = { passkey: { rpId: 'localhost', origins: ['http://localhost:4876'], credentialId: id.toString('base64url'), publicKeySpki: spki, algorithm: 'ES256' },
    publicKey: passkeyPublicKey(spki), keyId: keyIdOf(spki) };
  const assert_ = (challenge, { origin = 'http://localhost:4876', flags = 0x05, rpId = 'localhost', key = keys.privateKey, type = 'webauthn.get', crossOrigin = false } = {}) => {
    const authData = Buffer.concat([rpHash(rpId), Buffer.from([flags]), Buffer.alloc(4)]); authData.writeUInt32BE(++count, 33);
    const client = Buffer.from(JSON.stringify({ type, challenge: Buffer.isBuffer(challenge) ? challenge.toString('base64url') : challenge, origin, crossOrigin }));
    return { credentialId: id.toString('base64url'), authenticatorData: authData.toString('base64url'), clientDataJSON: client.toString('base64url'),
      signature: sign('sha256', Buffer.concat([authData, createHash('sha256').update(client).digest()]), { key, dsaEncoding: 'der' }).toString('base64url') };
  };
  /** A registration response: attested credential data with this key as a COSE_Key (kty 2, alg -7, crv 1, x, y). */
  const register = (challenge, { flags = 0x45, coseOf = keys.publicKey, alg = -7 } = {}) => {
    const jwk = coseOf.export({ format: 'jwk' }), x = Buffer.from(jwk.x, 'base64url'), y = Buffer.from(jwk.y, 'base64url');
    const cose = Buffer.concat([Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), x, Buffer.from([0x22, 0x58, 0x20]), y]);
    const authData = Buffer.concat([rpHash(), Buffer.from([flags]), Buffer.alloc(4), Buffer.alloc(16), Buffer.from([0, id.length]), id, cose]);
    const client = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: challenge.toString('base64url'), origin: 'http://localhost:4878', crossOrigin: false }));
    return { credentialId: id.toString('base64url'), clientDataJSON: client.toString('base64url'), authenticatorData: authData.toString('base64url'),
      publicKeySpki: Buffer.from(spki, 'base64').toString('base64url'), algorithm: alg };
  };
  return { keys, approver, spki, assertion: assert_, register };
}
const refusal = (f) => { try { f(); return 'NO_REFUSAL'; } catch (e) { return e.message; } };

// ---------------------------------------------------------------- M1-A: one consistent request bound
await test('M1-A request bound: the README Worker is 1 request and 0 retries; the Claude Code reader has no proven bound and no live request', async () => {
  const readme = contract('limited-readme-worker'), reader = contract('claude-code-reader');
  assert.deepEqual(requestBound(readme), { agentId: 'limited-readme-worker', maxModelRequests: 1, maxRetries: 0, liveEligible: true,
    proof: 'ONE_NATIVE_HTTPS_REQUEST_NO_SDK_NO_RETRY', refusal: null });
  assert.deepEqual(requestBound(reader), { agentId: 'claude-code-reader', maxModelRequests: null, maxRetries: 0, liveEligible: false,
    proof: 'CLI_TURN_LIMIT_IS_NOT_A_REQUEST_LIMIT', refusal: 'READER_REQUEST_BOUND_UNPROVEN' });
  assert.doesNotThrow(() => assertLiveRequestBound(readme));
  assert.equal(refusal(() => assertLiveRequestBound(reader)), 'READER_REQUEST_BOUND_UNPROVEN');
  // The README Worker packet keeps its pre-M0 invariants byte for byte; the reader no longer claims ONE_MODEL_REQUEST.
  assert.deepEqual(packetFor(readme, 'slice-1').invariants, ['READ_ONLY_SOURCE', 'ONE_MODEL_REQUEST', 'EXE_HOLD_UNTIL_SEPARATE_HUMAN_AUTHORITY']);
  const readerPacket = packetFor(reader, 'slice-1');
  assert.ok(!readerPacket.invariants.includes('ONE_MODEL_REQUEST'));
  assert.ok(readerPacket.invariants.includes('CLI_TURN_LIMIT_IS_NOT_A_REQUEST_LIMIT') && readerPacket.invariants.includes('NO_LIVE_PROVIDER_REQUEST_UNTIL_REQUEST_BOUND_PROVEN'));
  // providerCallAuthorization.maxCalls counts governed invocations (one), for both agents; it is not a request count.
  assert.equal(readerPacket.providerCallAuthorization.maxCalls, 1);
  assert.equal(maximumCost(readme), 210240);
});
await test('M1-A reader: zero retries, no non-streaming second request and no thinking by environment; a live reader is refused before any process', async () => {
  const env = readerEnvironment(contract('claude-code-reader'));
  assert.deepEqual([env.CLAUDE_CODE_MAX_RETRIES, env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK, env.CLAUDE_CODE_DISABLE_THINKING, env.MAX_THINKING_TOKENS], ['0', '1', '1', '0']);
  let ran = 0;
  const live = claudeCodeReaderTransport({ executable: '/nonexistent', executableSha256: 'a'.repeat(64), workspaceRoot: '/nonexistent' },
    seatbeltReaderRunner({ runModel: async () => { ran++; throw new Error('NEVER'); } }), { price: async () => '', model: async () => ({}), now: () => new Date().toISOString() });
  await assert.rejects(live.generate(contract('claude-code-reader'), 'goal', README, new AbortController().signal, () => {}), /READER_REQUEST_BOUND_UNPROVEN/);
  assert.equal(ran, 0);
});
await test('M1-C real CLI evidence (non-paid): the pinned binary accepted the M0 argv, and under --max-turns 3 it still sent 4 requests (no request bound)', async () => {
  const probe = JSON.parse(readFileSync(join(ROOT, 'regressions/m1/cli-probe-result.json'), 'utf8'));
  assert.equal(probe.evidenceClass, 'REAL_CLI_FAKE_LOCAL_PROVIDER');
  assert.match(probe.executable.version, /^2\.1\.283 \(Claude Code\)$/); assert.match(probe.executable.sha256, /^[a-f0-9]{64}$/);
  const s = Object.fromEntries(probe.scenarios.map((x) => [x.name, x]));
  assert.match(s['unknown-flag-calibration'].stderrHead, /unknown option '--chief-nonexistent-flag'/); assert.equal(s['unknown-flag-calibration'].messagesRequests, 0);
  assert.ok(!/unknown option/.test(s['m0-direct-answer'].stderrHead)); assert.equal(s['m0-direct-answer'].messagesRequests, 1);
  // M0 environment: one 529 is retried, an empty stream is re-sent without streaming: two requests for one turn.
  assert.equal(s['m0-one-529'].messagesRequests, 2); assert.equal(s['m0-empty-stream'].messagesRequests, 2);
  // Strict environment: failures are single requests, the tool loop stops at 3, but max_tokens continuations do not.
  for (const name of ['strict-one-529', 'strict-empty-stream', 'strict-always-500']) assert.equal(s[name].messagesRequests, 1, name);
  assert.equal(s['strict-always-tool'].messagesRequests, 3);
  assert.equal(s['strict-always-max-tokens-stop'].messagesRequests, 4, 'more requests than --max-turns 3');
  // No real provider was reachable: every recorded model request carried the dummy key to the local fake.
  assert.ok(probe.scenarios.flatMap((x) => x.requests).filter((r) => r.method === 'POST').every((r) => r.apiKeyIsDummy));
});

// ---------------------------------------------------------------- M1-B: the Human's passkey
await test('M1-B passkey assertion: only the pinned key, this challenge, an allowed origin, the RP ID, user presence and user verification pass', async () => {
  const a = authenticator(), challenge = createHash('sha256').update('payload').digest();
  const ok = verifyAssertion(a.approver, a.assertion(challenge), challenge);
  assert.ok(ok.signCount >= 1 && /^[a-f0-9]{64}$/.test(ok.assertionHash));
  const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
  const cases = { PASSKEY_CHALLENGE_MISMATCH: a.assertion(Buffer.alloc(32, 9)), PASSKEY_ORIGIN_MISMATCH: a.assertion(challenge, { origin: 'http://127.0.0.1:4876' }),
    PASSKEY_RP_ID_MISMATCH: a.assertion(challenge, { rpId: 'example.com' }), PASSKEY_USER_NOT_PRESENT: a.assertion(challenge, { flags: 0x04 }),
    PASSKEY_USER_NOT_VERIFIED: a.assertion(challenge, { flags: 0x01 }), PASSKEY_SIGNATURE_INVALID: a.assertion(challenge, { key: other }),
    PASSKEY_CLIENT_DATA_TYPE: a.assertion(challenge, { type: 'webauthn.create' }), PASSKEY_CROSS_ORIGIN: a.assertion(challenge, { crossOrigin: true }) };
  for (const [code, input] of Object.entries(cases)) assert.equal(refusal(() => verifyAssertion(a.approver, input, challenge)), code, code);
  assert.equal(refusal(() => verifyAssertion(a.approver, { ...a.assertion(challenge), credentialId: randomBytes(16).toString('base64url') }, challenge)), 'PASSKEY_CREDENTIAL_MISMATCH');
  assert.equal(refusal(() => verifyAssertion(a.approver, { ...a.assertion(challenge), extra: 1 }, challenge)), 'PASSKEY_ASSERTION_INVALID');
  const tampered = a.assertion(challenge), sig = Buffer.from(tampered.signature, 'base64url'); sig[sig.length - 1] ^= 1;
  assert.equal(refusal(() => verifyAssertion(a.approver, { ...tampered, signature: sig.toString('base64url') }, challenge)), 'PASSKEY_SIGNATURE_INVALID');
});
await test('M1-B passkey enrollment: a registration needs user verification and the credential\'s own ES256 key; the result is only a draft', async () => {
  const a = authenticator(), challenge = randomBytes(32), expected = { challenge, rpId: 'localhost', origins: ['http://localhost:4878'] };
  const ok = verifyRegistration(a.register(challenge), expected);
  assert.deepEqual(ok, { rpId: 'localhost', credentialId: a.approver.passkey.credentialId, publicKeySpki: a.spki, algorithm: 'ES256', keyId: a.approver.keyId });
  assert.equal(refusal(() => verifyRegistration(a.register(challenge, { flags: 0x41 }), expected)), 'PASSKEY_USER_NOT_VERIFIED');
  assert.equal(refusal(() => verifyRegistration(a.register(challenge, { flags: 0x05 }), expected)), 'PASSKEY_ATTESTED_DATA_MISSING');
  assert.equal(refusal(() => verifyRegistration(a.register(challenge, { coseOf: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey }), expected)), 'PASSKEY_PUBLIC_KEY_MISMATCH');
  assert.equal(refusal(() => verifyRegistration(a.register(challenge, { alg: -8 }), expected)), 'PASSKEY_ALGORITHM_UNSUPPORTED');
  assert.equal(refusal(() => verifyRegistration(a.register(randomBytes(32)), expected)), 'PASSKEY_CHALLENGE_MISMATCH');
});
await test('M1-B approver file: root-owned for the live Host, never group/other writable, never a link, a public P-256 key only, no placeholders', async (dir) => {
  const a = authenticator(), path = join(dir, 'approver.json');
  const config = (over = {}) => ({ schemaVersion: 1, kind: 'CHIEF_LIVE_RUN_APPROVER', policy: 'M1_PASSKEY_RUN_V1', humanPrincipalRef: 'human:m1',
    passkey: { ...a.approver.passkey }, architectAcceptance: acceptance(),
    approvalValiditySeconds: 600, ...over });
  const put = (value, mode = 0o644) => { rmSync(path, { force: true }); writeFileSync(path, JSON.stringify(value)); chmodSync(path, mode); };
  put(config());
  assert.equal(refusal(() => loadApprover(path)), 'APPROVER_CONFIG_UNSAFE', 'the live Host accepts only a root-owned file');
  const loaded = loadApprover(path, [process.getuid()]);
  assert.deepEqual([loaded.protection, loaded.keyId], ['SAME_ACCOUNT_OWNED', a.approver.keyId]);
  put(config(), 0o664); assert.equal(refusal(() => loadApprover(path, [process.getuid()])), 'APPROVER_CONFIG_UNSAFE');
  put(config()); symlinkSync(path, join(dir, 'link.json')); assert.equal(refusal(() => loadApprover(join(dir, 'link.json'), [process.getuid()])), 'APPROVER_CONFIG_UNSAFE');
  // EXE-AR1 F2: a private key where the public key belongs is refused, as is another curve.
  const pkcs8 = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  put(config({ passkey: { ...a.approver.passkey, publicKeySpki: pkcs8 } })); assert.equal(refusal(() => loadApprover(path, [process.getuid()])), 'APPROVER_KEY_INVALID');
  const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  put(config({ passkey: { ...a.approver.passkey, publicKeySpki: p384 } })); assert.equal(refusal(() => loadApprover(path, [process.getuid()])), 'APPROVER_KEY_INVALID');
  const FILL = 'FILL_IN_AFTER_ARCHITECT_ACCEPTANCE';
  put(config({ architectAcceptance: acceptance({ architectPrincipalRef: FILL, classHash: FILL, implementationSha: FILL, acceptedAt: FILL,
    source: { kind: 'ARCHITECT_REVIEW_DECISION', reviewRef: FILL, decisionSha256: FILL } }) }));
  assert.equal(refusal(() => loadApprover(path, [process.getuid()])), 'APPROVER_CONFIG_INVALID', 'an enrollment draft grants nothing');
  put(config({ approvalValiditySeconds: MAX_APPROVAL_SECONDS + 1 })); assert.equal(refusal(() => loadApprover(path, [process.getuid()])), 'APPROVER_CONFIG_INVALID');
  put(config({ passkey: { ...a.approver.passkey, origins: ['http://127.0.0.1:4876'] } })); assert.equal(refusal(() => loadApprover(path, [process.getuid()])), 'APPROVER_CONFIG_INVALID');
});
await test('M1-B class and payload: the class omits only per-run fields; the signed bytes are domain separated and the window is at most 15 minutes', async () => {
  const one = contract('limited-readme-worker'), two = contract('limited-readme-worker', { runId: 'run-other', objectiveHash: hash('other'), outputKey: hash('o2') });
  assert.equal(workerClassHash(one), workerClassHash(two), 'per-run fields do not change the class');
  assert.notEqual(workerClassHash(one), workerClassHash(contract('limited-readme-worker', { sourceSha: 'b'.repeat(40) })));
  assert.notEqual(workerClassHash(one), workerClassHash(contract('claude-code-reader')));
  assert.deepEqual(workerClass(one).requestBound.maxModelRequests, 1); assert.equal(workerClass(one).reservationMicroUsd, 210240);
  const now = Date.now(), payload = { payloadSchema: 'chief-activation-attestation.v1', policyVersion: 'M1_PASSKEY_RUN_V1', setHash: 'a'.repeat(64), runId: 'run-m1',
    repository: REPOSITORY, contractHash: hash(one), packetId: 'limited-x', packetHash: 'b'.repeat(64), ...R1_PAYLOAD, implementationSha: 'c'.repeat(40), workerCodeHash: hash('code'),
    operations: ['LIMITED_README_WORKER', 'LIVE_PROVIDER_MODEL_CALL'],
    grants: [{ operation: 'LIMITED_README_WORKER', authorityId: 'm1-limited-1', version: 1, recordHash: 'd'.repeat(64) },
      { operation: 'LIVE_PROVIDER_MODEL_CALL', authorityId: 'm1-live-1', version: 1, recordHash: 'e'.repeat(64) }],
    classHash: workerClassHash(one), agentId: 'limited-readme-worker', model: MODEL, maxModelRequests: 1, maxRetries: 0, approvedMaxReservationMicroUsd: 210240,
    signerKeyId: 'f'.repeat(64), rpId: 'localhost', issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 600000).toISOString(), nonce: randomUUID() };
  assert.deepEqual(parsePayload(payload), payload);
  assert.equal(APPROVAL_DOMAIN, 'CHIEF-ACTIVATION-ATTESTATION-V1\n');
  assert.ok(challengeOf(payload).equals(challengeOf(structuredClone(payload)))); assert.ok(!challengeOf(payload).equals(challengeOf({ ...payload, nonce: randomUUID() })));
  assert.equal(refusal(() => parsePayload({ ...payload, expiresAt: new Date(now + 901000).toISOString() })), 'APPROVAL_PAYLOAD_INVALID');
  assert.equal(refusal(() => parsePayload({ ...payload, grants: [payload.grants[1], payload.grants[0]] })), 'APPROVAL_PAYLOAD_INVALID');
  assert.equal(refusal(() => parsePayload({ ...payload, agentId: 'claude-code-reader' })), 'APPROVAL_PAYLOAD_INVALID');
  assert.equal(refusal(() => parsePayload({ ...payload, maxModelRequests: 3 })), 'APPROVAL_PAYLOAD_INVALID');
});
await test('M1-B live eligibility: an S1 set is never eligible; an M1 set only with a verifier that accepts its setHash', async () => {
  const s1 = { setHash: 'a'.repeat(64), signed: false, policy: SIGNATURE_POLICY.version }, m1 = { ...s1, policy: M1_SIGNATURE_POLICY.version };
  assert.deepEqual(liveEligibility(s1, () => {}), { eligible: false, reason: 'ACTIVATION_SET_NOT_SIGNED' });
  assert.deepEqual(liveEligibility({ ...s1, signed: true }, () => {}), { eligible: false, reason: 'ACTIVATION_SET_NOT_SIGNED' });
  assert.deepEqual(liveEligibility(m1), { eligible: false, reason: 'ACTIVATION_ATTESTATION_MISSING' });
  assert.deepEqual(liveEligibility(m1, () => { throw new Error('ATTESTATION_EXPIRED'); }), { eligible: false, reason: 'ATTESTATION_EXPIRED' });
  let seen; assert.deepEqual(liveEligibility(m1, (h) => { seen = h; }), { eligible: true, reason: null }); assert.equal(seen, m1.setHash);
  assert.deepEqual(liveEligibility(null, () => {}), { eligible: false, reason: 'ACTIVATION_SET_MISSING' });
});
await test('M1-B consumed approval record: once per job (exclusive 0600 file), re-verified against the set, the payload and the window', async (dir) => {
  const a = authenticator(), c = contract('limited-readme-worker'), now = Date.now();
  const payload = parsePayload({ payloadSchema: 'chief-activation-attestation.v1', policyVersion: 'M1_PASSKEY_RUN_V1', setHash: 'a'.repeat(64), runId: c.runId,
    repository: REPOSITORY, contractHash: hash(c), packetId: 'limited-x', packetHash: 'b'.repeat(64), ...R1_PAYLOAD, implementationSha: c.implementationSha, workerCodeHash: c.workerCodeHash,
    operations: ['LIMITED_README_WORKER', 'LIVE_PROVIDER_MODEL_CALL'], grants: [{ operation: 'LIMITED_README_WORKER', authorityId: 'l', version: 1, recordHash: 'd'.repeat(64) },
      { operation: 'LIVE_PROVIDER_MODEL_CALL', authorityId: 'v', version: 1, recordHash: 'e'.repeat(64) }], classHash: workerClassHash(c), agentId: 'limited-readme-worker',
    model: MODEL, maxModelRequests: 1, maxRetries: 0, approvedMaxReservationMicroUsd: 210240, signerKeyId: a.approver.keyId, rpId: 'localhost',
    issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 600000).toISOString(), nonce: randomUUID() });
  const challenge = challengeOf(payload), passkey = a.assertion(challenge), verified = verifyAssertion(a.approver, passkey, challenge);
  const record = { jobId: hash(c), payload, challenge: challenge.toString('base64url'), assertion: passkey, assertionHash: verified.assertionHash, keyId: a.approver.keyId,
    signCount: verified.signCount, verifiedAt: new Date().toISOString() };
  writeApprovalRecord(dir, record);
  assert.equal(refusal(() => writeApprovalRecord(dir, record)), 'APPROVAL_ALREADY_USED');
  const approver = { ...a.approver, acceptanceHash: R1_PAYLOAD.acceptanceHash };
  const verify = attestationVerifier(dir, approver, () => new Date().toISOString());
  assert.doesNotThrow(() => verify(c, payload.setHash));
  assert.equal(refusal(() => verify(c, 'f'.repeat(64))), 'ATTESTATION_BINDING_MISMATCH');
  assert.equal(refusal(() => attestationVerifier(dir, approver, () => new Date(now + 601000).toISOString())(c, payload.setHash)), 'ATTESTATION_EXPIRED');
  // M1-R1: the record names one standing acceptance; another pinned acceptance (source or version substituted) fails.
  assert.equal(refusal(() => attestationVerifier(dir, { ...approver, acceptanceHash: '7'.repeat(64) }, () => new Date().toISOString())(c, payload.setHash)), 'ATTESTATION_BINDING_MISMATCH');
  // A record rewritten after consumption (another reservation) no longer matches its own signed challenge.
  const file = join(dir, 'm1-approvals', `${hash(c)}.json`), stored = JSON.parse(readFileSync(file, 'utf8'));
  rmSync(file); writeFileSync(file, JSON.stringify({ ...stored, payload: { ...stored.payload, approvedMaxReservationMicroUsd: 1000000 } }), { mode: 0o600 });
  assert.equal(refusal(() => verify(c, payload.setHash)), 'ATTESTATION_BINDING_MISMATCH');
  chmodSync(file, 0o644); assert.equal(refusal(() => readApprovalRecord(dir, hash(c))), 'APPROVAL_RECORD_UNSAFE');
  rmSync(file); assert.equal(refusal(() => verify(c, payload.setHash)), 'APPROVAL_RECORD_MISSING');
});

// ---------------------------------------------------------------- the real Host and the panel
await test('M1-B real Host: trusted live runtime, root-owned approver, startup-only lease, no rehearsal, no untrusted composition, reader unconfigured', async () => {
  const main = readFileSync(join(ROOT, 'src/limited-worker/main.ts'), 'utf8');
  assert.match(main, /createLiveRuntime\(/); assert.match(main, /loadApprover\(approverPath,\[0\]\)/);
  assert.match(main, /'claude-code-reader':unconfiguredLiveTransport\('READER_REQUEST_BOUND_UNPROVEN'\)/);
  assert.doesNotMatch(main, /composeLimitedWorker|rehearsal|offlineReaderRunner|offlineAnthropicTransport|--permit-config|loadGrantCopies/);
  assert.doesNotMatch(main, /release=workerStore\.lease\(\)/, 'no process-long runtime lease');
  assert.match(main, /const startup=workerStore\.lease\(\);\s*try\{workerStore\.recover\(clock\.now\(\)\);\}finally\{startup\(\);\}/);
  assert.doesNotMatch(readFileSync(join(ROOT, 'dist/limited-worker/main.js'), 'utf8'), /rehearsal/);
  assert.equal(EXE, 'LIVE_PILOT');
  assert.ok(LIVE_AUTHORIZATION_STEPS.some((s) => /EXE／H1–H9 HOLD/.test(s)) && LIVE_AUTHORIZATION_STEPS.some((s) => /root/.test(s)) && LIVE_AUTHORIZATION_STEPS.some((s) => /支出上限/.test(s)));
});
await test('M1-B/D panel: before approval the Human sees task, data scope, model and budget; the live Host shows the passkey step, LOCKED under EXE HOLD', async () => {
  const c = contract('limited-readme-worker'), preview = approvalPreview(c, '請說明 README');
  assert.deepEqual([preview.task, preview.model, preview.dataScope.path, preview.maxReservationMicroUsd, preview.requestBound.maxModelRequests],
    ['請說明 README', MODEL, 'README.md', 210240, 1]);
  const job = { id: 'f'.repeat(64), objective: '請說明 README', state: 'PREPARED', effectiveState: 'PREPARED', evidenceClass: 'LIVE_PROVIDER', contract: c,
    maximumReservationMicroUsd: 210240, actualCostMicroUsd: null, usage: null, driver: { state: 'IDLE' }, invocations: [], readiness: { checks: [] }, events: [],
    approvalPreview: preview, liveApproval: { configured: true, keyId: 'a'.repeat(64), protection: 'ROOT_OWNED', classAccepted: true, implementationAccepted: true, refusal: null } };
  const base = { totalCeilingMicroUsd: 1000000, totalReservedMicroUsd: 0, jobs: [job] };
  const locked = jobsHTML({ ...base, execution: { evidenceClass: 'LIVE_PROVIDER', startAvailable: false, authorizationSteps: [...LIVE_AUTHORIZATION_STEPS], approvalMethod: 'PASSKEY_PER_RUN' } });
  assert.match(locked, /批准前請確認/); assert.match(locked, /請說明 README/); assert.match(locked, /claude-haiku-4-5-20251001/); assert.match(locked, /US\$0\.210240/);
  assert.match(locked, /最多 1 次、零重試/); assert.match(locked, /以通行金鑰批准並執行 · LOCKED/); assert.doesNotMatch(locked, /data-worker-passkey|data-worker-start/);
  globalThis.location = { hostname: 'localhost', port: '4876', pathname: '/', hash: '' };
  const open = jobsHTML({ ...base, execution: { evidenceClass: 'LIVE_PROVIDER', startAvailable: true, authorizationSteps: [], approvalMethod: 'PASSKEY_PER_RUN' } });
  assert.match(open, /data-worker-passkey="f{64}"[^>]*disabled/); assert.match(open, /data-approve="f{64}"/); assert.match(open, /設定檔 root 擁有/);
  assert.match(jobsHTML({ ...base, execution: { evidenceClass: 'LIVE_PROVIDER', startAvailable: true, authorizationSteps: [], approvalMethod: 'PASSKEY_PER_RUN' } }, new Set([job.id])),
    /data-worker-passkey="f{64}" data-max="210240" >/);
  globalThis.location = { hostname: '127.0.0.1', port: '4876', pathname: '/', hash: '' };
  assert.match(jobsHTML({ ...base, execution: { evidenceClass: 'LIVE_PROVIDER', startAvailable: true, authorizationSteps: [], approvalMethod: 'PASSKEY_PER_RUN' } }, new Set([job.id])),
    /通行金鑰只能在/);
  delete globalThis.location;
  assert.match(workerHTML(), /<option value="limited-readme-worker">/);
});

// ---------------------------------------------------------------- end to end over HTTP: EXE LIVE_PILOT (repository build) and EXE HOLD (patched copy)
const harness = join(ROOT, 'regressions/m1/lifted-host.mjs');
const runHarness = (dist, scenario, dir) => {
  const work = join(dir, scenario); mkdirSync(work, { recursive: true });
  const out = execFileSync(process.execPath, [harness, dist, scenario, work], { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
  const facts = JSON.parse(out.trim().split('\n').at(-1));
  assert.equal(facts.error, undefined, facts.error);
  return facts;
};
let held = null;
const holdDist = () => {
  if (held) return held;
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'chief-m1-hold-')));
  for (const p of ['dist', 'workspace-ui', 'package.json']) cpSync(join(ROOT, p), join(base, p), { recursive: true });
  symlinkSync(join(ROOT, 'node_modules'), join(base, 'node_modules'));
  const file = join(base, 'dist/limited-worker/contract.js'), text = readFileSync(file, 'utf8');
  assert.equal(text.split("export const EXE = 'LIVE_PILOT';").length, 2, 'exactly one EXE declaration');
  writeFileSync(file, text.replace("export const EXE = 'LIVE_PILOT';", "export const EXE = 'HOLD';"));
  held = { base, dist: join(base, 'dist') };
  return held;
};
await test('M1 HOLD copy over HTTP (EXE patched back to HOLD): the Human sees the run; approval and START refuse before any write, verification or request', async (dir) => {
  const f = runHarness(holdDist().dist, 'hold', dir);
  assert.deepEqual([f.hold.request, f.hold.start, f.noApprover, f.readerPlan], ['EXE_HOLD', 'EXE_HOLD', 'EXE_HOLD', 'READER_REQUEST_BOUND_UNPROVEN']);
  assert.deepEqual(f.holdJob, { state: 'PREPARED', approvalRequest: null, approval: null, reserved: 0, events: ['PREPARED_NO_EXECUTION'], driver: 'IDLE' });
  assert.deepEqual([f.holdArchive, f.holdRecords, f.holdSets], [0, false, false]);
  assert.deepEqual([f.provider.messages, f.provider.models, f.provider.price], [0, 0, 0]);
  assert.equal(f.execution.startAvailable, false); assert.equal(f.preview.model, MODEL); assert.equal(f.status.classAccepted, true);
  assert.deepEqual(f.agentAvailability, { 'limited-readme-worker': 'LIVE_REQUIRES_APPROVAL', 'claude-code-reader': 'READER_REQUEST_BOUND_UNPROVEN' });
});
// M1-LIFT-P0: the layers below the Host that the older suites checked for EXE_HOLD on the repository build are checked on the HOLD copy.
await test('M1 HOLD copy below the Host: service, composition, adapter, native transport, Seatbelt runner, live reader, unconfigured agent and readiness all refuse as EXE_HOLD', async (dir) => {
  const load = (p) => import(join(holdDist().dist, p));
  const [{ EXE: heldExe }, transport, reader, readiness, composition, adapter] = await Promise.all(['limited-worker/contract.js', 'limited-worker/transport.js',
    'limited-worker/claude-code-reader.js', 'limited-worker/readiness.js', 'limited-worker/composition.js', 'limited-worker/adapter.js'].map(load));
  assert.equal(heldExe, 'HOLD');
  const c = contract('limited-readme-worker');
  let sent = 0, keys = 0; const seen = [];
  const counting = { kind: 'LIVE_PROVIDER', preflight: async () => { sent++; throw new Error('NEVER'); }, generate: async () => { sent++; throw new Error('NEVER'); } };
  const roots = Object.fromEntries(['controllerStoreDirectory', 'authorityArchiveDirectory', 'changeRegistryDirectory', 'journalDirectory', 'resultDirectory']
    .map((k) => { const p = join(dir, k); mkdirSync(p, { mode: 0o700 }); return [k, p]; }));
  const composed = composition.composeLimitedWorker({ ...roots, architectPrincipalRef: 'architect:m1-hold-copy', humanPrincipalRef: 'human:m1-hold-copy',
    implementationSha: c.implementationSha, workerCodeHash: c.workerCodeHash, clock: { now: () => new Date().toISOString() }, transport: counting,
    currentImplementation: () => ({ sha: c.implementationSha, codeHash: c.workerCodeHash, clean: true }), liveCallGrant: null, limitedGrant: null,
    readSource: () => source, readGoal: () => 'goal' });
  await assert.rejects(composed.execute(c), /EXE_HOLD/);
  assert.deepEqual(await new adapter.LimitedReadmeWorker({ transport: counting }).execute({ packet: packetFor(c, 'slice-1') }),
    { status: 'HUMAN_STOP', reason: 'EXE_HOLD_NO_PROVIDER_REQUEST' });
  // The native transport with a full payload and a send guard: the requester only records and refuses, so no network is possible.
  const native = transport.nativeAnthropicTransport(() => { keys++; throw new Error('NO_KEY'); }, { requester: (u) => { seen.push(String(u)); throw new Error('NO_NETWORK_IN_TEST'); } });
  await assert.rejects(native.preflight(c, new AbortController().signal, { objective: 'goal', source: README }), /EXE_HOLD/);
  await assert.rejects(native.generate(c, 'goal', README, new AbortController().signal, () => {}), /EXE_HOLD/);
  let models = 0; const executor = { async runModel() { models++; throw new Error('NEVER'); } };
  await assert.rejects(reader.seatbeltReaderRunner(executor).run({}), /EXE_HOLD/);
  const live = reader.claudeCodeReaderTransport({ executable: '/nonexistent', executableSha256: 'a'.repeat(64), workspaceRoot: join(dir, 'reader') },
    reader.seatbeltReaderRunner(executor), { price: async () => '', model: async () => ({}), now: () => new Date().toISOString() });
  await assert.rejects(live.preflight(contract('claude-code-reader'), new AbortController().signal, { objective: 'goal', source: README }), /EXE_HOLD/);
  await assert.rejects(live.generate(contract('claude-code-reader'), 'goal', README, new AbortController().signal, () => {}), /EXE_HOLD/);
  const unconfigured = transport.unconfiguredLiveTransport('CLAUDE_CODE_READER_NOT_CONFIGURED');
  await assert.rejects(unconfigured.preflight(c), /EXE_HOLD/); await assert.rejects(unconfigured.generate(c), /EXE_HOLD/);
  assert.equal(readiness.planConditions(c, new Date().toISOString(), { sha: c.implementationSha, codeHash: c.workerCodeHash, clean: true }, 0)[0], 'EXE_HOLD');
  // The service's own check, with a runtime that has no EXE check of its own: 403 EXE_HOLD before the runtime is called, even with an amount and a passkey.
  const [{ WorkerStore }, { createLimitedWorkerService }] = await Promise.all(['limited-worker/store.js', 'limited-worker/service.js'].map(load));
  const store = new WorkerStore(join(dir, 'service')), sc = parseContract({ ...c, storageIdentity: store.identity() });
  store.create(sc, new Date().toISOString());
  let runtimeCalls = 0;
  const human = { schemaVersion: 1, kind: 'HUMAN', principalRef: 'human:m1-hold-copy' };
  const service = createLimitedWorkerService({ goals: { read: () => ({ goals: [{ goalId: sc.goalId, text: 'goal', submittedBy: human, createdAt: new Date().toISOString() }] }) },
    governance: {}, admission: {}, projects: ['chief'], store, quote: null, source: () => source, now: () => new Date().toISOString(),
    identity: () => ({ sha: sc.implementationSha, codeHash: sc.workerCodeHash, clean: true }),
    runtime: { transportKind: 'LIVE_PROVIDER', permit() { throw new Error('NO_PERMIT'); }, inspect: () => ({ driver: { state: 'IDLE', change: null }, journal: [], job: null }),
      resultConsistency: () => false, cancel: () => false, async execute() { runtimeCalls++; }, requestApproval() { runtimeCalls++; } } });
  assert.equal(service.read('chief', human).execution.startAvailable, false);
  const approval = { maxReservationMicroUsd: maximumCost(sc) }, passkey = { credentialId: 'x', authenticatorData: 'x', clientDataJSON: 'x', signature: 'x' };
  for (const action of ['REQUEST_APPROVAL', 'START']) {
    await assert.rejects(service.action('chief', hash(sc), { requestId: randomUUID(), action, approval, passkey }, human), (e) => e.code === 'EXE_HOLD' && e.status === 403);
  }
  assert.deepEqual([runtimeCalls, store.read().jobs[0].state], [0, 'PREPARED']);
  assert.deepEqual([sent, keys, seen.length, models, existsSync(join(dir, 'reader'))], [0, 0, 0, 0, false]);
});
await test('M1 LIFT build over HTTP: passkey approval, three preserved documents, M1 set, exactly one provider request, evidence kept, no resend', async (dir) => {
  const f = runHarness(join(ROOT, 'dist'), 'happy', dir);
  // M1-LIFT-P0: the repository build is the LIVE_PILOT candidate: START is offered only with the per-run passkey; the reader stays unavailable.
  assert.deepEqual([f.execution.startAvailable, f.execution.approvalMethod, f.agentAvailability['claude-code-reader']], [true, 'PASSKEY_PER_RUN', 'READER_REQUEST_BOUND_UNPROVEN']);
  assert.deepEqual([f.noApprover, f.readerPlan, f.noPasskeyStart, f.wrongAmount], ['APPROVER_NOT_CONFIGURED', 'READER_REQUEST_BOUND_UNPROVEN', 'PASSKEY_APPROVAL_REQUIRED', 'APPROVAL_DOES_NOT_MATCH_COST']);
  assert.deepEqual([f.pending.rpId, f.pending.credentialMatches, f.pending.challengeMatches, f.pending.payload.maxModelRequests, f.pending.payload.approvedMaxReservationMicroUsd],
    ['localhost', true, true, 1, 210240]);
  assert.ok(Date.parse(f.pending.payload.expiresAt) - Date.parse(f.pending.payload.issuedAt) <= 600000);
  assert.deepEqual([f.done.state, f.done.effectiveState, f.done.resultApplied, f.done.driver], ['COMPLETED', 'COMPLETED', true, 'IMPLEMENTATION_COMPLETE']);
  assert.deepEqual(f.done.invocations, ['APPLIED']);
  assert.deepEqual(f.done.usage, { inputTokens: 812, outputTokens: 64 }); assert.equal(f.done.actualCostMicroUsd, 812 + 64 * 5);
  assert.match(f.done.providerMessageId, /^msg_m1_/); assert.match(f.done.providerRequestId, /^req_m1_/); assert.equal(f.done.reserved, 210240);
  assert.deepEqual(f.done.events.slice(1, 4), ['PASSKEY_APPROVAL_REQUESTED', 'PASSKEY_APPROVAL_VERIFIED_AND_CONSUMED', 'WORST_CASE_RESERVED']);
  // Exactly one Messages request (plus the existing price and model preflight reads), with the fixed body.
  assert.deepEqual([f.provider.messages, f.provider.models, f.provider.price, f.provider.other], [1, 1, 1, 0]);
  assert.deepEqual(f.provider.bodies, [{ model: MODEL, max_tokens: 2048, stream: false, thinking: { type: 'disabled' }, tools: null, service_tier: 'standard_only' }]);
  assert.deepEqual(f.provider.apiKeys, ['DUMMY']); assert.equal(f.keyInFiles, 0, 'the credential is in no stored file');
  // M1-R1: the run packet is archived as CLASS_DERIVED_AUTHORITY naming the pinned acceptance; the two grants are the Human's direct authority.
  assert.deepEqual(f.archive.map((d) => [d.kind, d.issuer.role, d.recordClass]).sort(), [['AUTHORIZATION', 'HUMAN', 'DIRECT_AUTHORITY'], ['AUTHORIZATION', 'HUMAN', 'DIRECT_AUTHORITY'],
    ['IMPLEMENTATION_PACKET', 'GPT_ARCHITECT', 'CLASS_DERIVED_AUTHORITY']]);
  const derivedFact = f.archive.find((d) => d.kind === 'IMPLEMENTATION_PACKET');
  assert.deepEqual(derivedFact.derivation, { rule: 'ARCHITECT_CLASS_DELEGATION_V1', derivedBy: 'CHIEF_TRUSTED_HOST', acceptanceHash: f.acceptanceHash,
    classHash: f.classHash, implementationSha: 'c'.repeat(40) });
  assert.deepEqual([f.pending.payload.packetRecordClass, f.pending.payload.acceptanceHash, f.pending.payload.packetRecordHash], ['CLASS_DERIVED_AUTHORITY', f.acceptanceHash, derivedFact.recordHash]);
  assert.deepEqual([f.status.packetProvenance, f.status.acceptanceHash, f.status.acceptanceVersion], ['CLASS_DERIVED_AUTHORITY', f.acceptanceHash, 1]);
  // M1-R1: the fake provider is labelled as such on the job; it never counts as the account's model metadata.
  assert.deepEqual([f.done.providerEndpoint, f.done.modelAccountAvailability], ['INJECTED_TEST_REQUESTER', 'TEST_REQUESTER_NOT_ACCOUNT']);
  assert.deepEqual(f.sets, [{ policy: { version: 'M1_PASSKEY_RUN_V1', humanSignatureRequired: true }, setHash: f.pending.payload.setHash, attestations: 0 }]);
  assert.deepEqual(f.records.map((r) => [r.mode, r.payloadSetHash]), [['600', f.pending.payload.setHash]]);
  assert.deepEqual([f.again, f.replayOnOtherRun, f.afterRestart], ['WORK_ALREADY_STARTED_OR_TERMINAL', 'PASSKEY_CHALLENGE_MISMATCH', 'WORK_ALREADY_STARTED_OR_TERMINAL']);
  assert.deepEqual([f.restarted.state, f.restarted.resultApplied, f.restarted.invocations, f.restarted.report], ['COMPLETED', true, ['APPLIED'], f.done.report]);
});
await test('M1 LIFT build: a wrong, foreign or unverified assertion and an expired approval preserve nothing and send nothing', async (dir) => {
  const f = runHarness(join(ROOT, 'dist'), 'tampered', dir);
  assert.deepEqual(f.tampered, { otherChallenge: 'PASSKEY_CHALLENGE_MISMATCH', otherOrigin: 'PASSKEY_ORIGIN_MISMATCH', otherRpId: 'PASSKEY_RP_ID_MISMATCH',
    notVerified: 'PASSKEY_USER_NOT_VERIFIED', notPresent: 'PASSKEY_USER_NOT_PRESENT', otherKey: 'PASSKEY_SIGNATURE_INVALID', otherCredential: 'PASSKEY_CREDENTIAL_MISMATCH' });
  assert.equal(f.expired, 'APPROVAL_EXPIRED');
  assert.deepEqual([f.archivedAfterTampered, f.recordsAfterTampered, f.provider.messages, f.provider.models], [0, false, 0, 0]);
});
await test('M1 LIFT build: a browser that disconnects mid-request does not stop or repeat the run; the Host finishes it once', async (dir) => {
  const f = runHarness(join(ROOT, 'dist'), 'disconnect', dir);
  assert.match(f.clientAborted, /abort/i); assert.equal(f.stateAfterDisconnect, 'COMPLETED'); assert.equal(f.provider.messages, 1);
});
await test('M1 LIFT build: a class the Architect did not accept cannot be approved', async (dir) => {
  const f = runHarness(join(ROOT, 'dist'), 'class-not-accepted', dir);
  assert.equal(f.request, 'WORKER_CLASS_NOT_ACCEPTED'); assert.equal(f.status.classAccepted, false); assert.equal(f.provider.messages, 0);
});
if (held) rmSync(held.base, { recursive: true, force: true });
assert.equal(readFileSync(join(ROOT, 'dist/limited-worker/contract.js'), 'utf8').includes("export const EXE = 'LIVE_PILOT';"), true, 'the repository build is the LIVE_PILOT candidate');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
