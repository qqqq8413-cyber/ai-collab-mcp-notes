import assert from 'node:assert/strict';
// Child processes and fs fault injection are test machinery only: they race real
// archive instances and simulate crashes. Nothing here reaches production code.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as admission from './dist/automation/admission.js';
import * as documentModule from './dist/automation/authority/document.js';
import * as archiveModule from './dist/automation/authority/file-archive.js';
import { FileControllerStore } from './dist/automation/durable-store.js';
import { canonicalJson } from './dist/automation/invocation-journal.js';

const { AuthorityArchiveError } = documentModule;
const { openAuthorityArchiveAppender, openAuthorityArchiveReader } = archiveModule;
const ROOT = dirname(fileURLToPath(import.meta.url));
const B = 'b'.repeat(40), A = 'a'.repeat(40), T = '2026-10-05T00:00:00.000Z', REPO = 'synthetic/example';

const tests = [];
const check = (name, fn) => tests.push({ name, fn });
const sha = (text) => createHash('sha256').update(text).digest('hex');
const keyOf = (kind, id) => sha(`chief.authority.v1\0${kind}\0${id}`);
const recordFile = (root, kind, id, version) => join(root, 'records', keyOf(kind, id), `${String(version).padStart(8, '0')}.json`);
function fails(fn, code) {
  let caught;
  try { fn(); } catch (error) { caught = error; }
  assert.ok(caught instanceof AuthorityArchiveError, `expected ${code}, got ${caught?.stack ?? 'no error'}`);
  assert.equal(caught.code, code, caught.message);
}
function withFs(name, replace, fn) {
  const original = fs[name];
  fs[name] = replace(original); syncBuiltinESMExports();
  try { return fn(); } finally { fs[name] = original; syncBuiltinESMExports(); }
}
function walk(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? [path, ...walk(path)] : [path];
  });
}

// ---------------------------------------------------------------- fixtures (canonical bodies)
const BODIES = {
  IMPLEMENTATION_PACKET: (overrides = {}) => ({ packetId: 'packet-1', packetVersion: 1, sliceId: 'slice-1', expectedBaseSha: A,
    targetBranch: 'work/synthetic-1', objective: 'Offline fixture', allowedAreas: ['src/automation'], forbiddenChanges: ['src/stress-test'],
    invariants: ['human authority'], acceptanceCriteria: ['checks pass'],
    validationCommands: [{ commandId: 'test', executable: 'npm', args: ['test'], cwd: '.', classification: 'OFFLINE_VALIDATION' }],
    networkAuthorization: { level: 'WRITE_EXTERNAL', destinations: ['main', 'work/synthetic-1'], purpose: 'fixture', budget: 1 },
    providerCallAuthorization: { allowed: false, calls: [], maxCalls: 0, budget: 0 }, destructiveOperationAuthorization: { allowed: false },
    iterationBudget: { maxImplementationIterationsPerSlice: 3, maxAcceptanceFailuresPerSlice: 3, maxRuntimeMinutesPerIteration: 60,
      maxParallelImplementationAgents: 1 }, ...overrides }),
  CORRECTION_PACKET: (overrides = {}) => ({ correctionPacketId: 'correction-1', originalPacketId: 'packet-1', originalPacketHash: 'd'.repeat(64),
    rejectedSha: B, reviewerFindings: ['finding'], allowedCorrectionAreas: ['src/automation'], unchangedInvariantReferences: ['human authority'],
    expectedBaseSha: B, correctionIteration: 1, maxCorrectionIteration: 3, ...overrides }),
  ACCEPTANCE_DECISION: (overrides = {}) => ({ reviewId: 'review-1', actor: 'GPT_ARCHITECT', packetId: 'packet-1', packetHash: 'd'.repeat(64),
    reviewedSha: B, decision: 'ACCEPT', findings: [], evidenceReferences: ['remote diff'], issuedAt: T, ...overrides }),
  AUTHORIZATION: (overrides = {}) => ({ authorizationId: 'auth-promote', actorRole: 'HUMAN', operation: 'FAST_FORWARD_MAIN', target: 'main',
    runId: 'run-1', packetId: 'packet-1', issuedAt: T, reason: 'synthetic authorization', ...overrides }),
};
const KINDS = Object.keys(BODIES);
const ID_FIELD = { IMPLEMENTATION_PACKET: 'packetId', CORRECTION_PACKET: 'correctionPacketId', ACCEPTANCE_DECISION: 'reviewId',
  AUTHORIZATION: 'authorizationId' };
const ROLE = { IMPLEMENTATION_PACKET: 'GPT_ARCHITECT', CORRECTION_PACKET: 'GPT_ARCHITECT', ACCEPTANCE_DECISION: 'GPT_ARCHITECT', AUTHORIZATION: 'HUMAN' };
function doc(kind, body = BODIES[kind](), extra = {}) {
  return { schemaVersion: 1, recordClass: 'DIRECT_AUTHORITY', kind, authorityId: body[ID_FIELD[kind]], version: 1, issuedAt: T,
    issuer: { role: ROLE[kind], principalRef: ROLE[kind] === 'HUMAN' ? 'human-owner' : 'gpt-architect' },
    subject: kind === 'IMPLEMENTATION_PACKET' ? { repository: REPO, sliceId: body.sliceId } : { repository: REPO },
    supersedes: null, body, ...extra };
}
const packetDoc = (overrides = {}, extra = {}) => doc('IMPLEMENTATION_PACKET', BODIES.IMPLEMENTATION_PACKET(overrides), extra);
const after = (ref, document) => ({ ...document, version: ref.version + 1, supersedes: ref });
/** A record sealed outside the archive: hashes computed exactly as the archive does. */
function forge(document) {
  const bodyHash = sha(canonicalJson(document.body));
  const withBody = { ...document, bodyHash };
  return { ...withBody, recordHash: sha(canonicalJson(withBody)) };
}
function rewrite(root, kind, id, version, mutate, { reseal = false } = {}) {
  const file = recordFile(root, kind, id, version);
  const record = JSON.parse(readFileSync(file, 'utf8'));
  mutate(record);
  const { bodyHash: _b, recordHash: _r, ...document } = record;
  writeFileSync(file, canonicalJson(reseal ? forge(document) : record));
}

// ---------------------------------------------------------------- basic
for (const [index, kind] of KINDS.entries()) {
  check(`${index + 1}. append and read ${kind}`, (root) => {
    const appender = openAuthorityArchiveAppender(root);
    const ref = appender.append(doc(kind));
    assert.deepEqual(Object.keys(ref).sort(), ['authorityId', 'kind', 'recordHash', 'version']);
    assert.equal(ref.version, 1);
    const reader = openAuthorityArchiveReader(root);
    const record = reader.get(ref);
    assert.deepEqual({ ...record, bodyHash: undefined, recordHash: undefined }, { ...doc(kind), bodyHash: undefined, recordHash: undefined });
    assert.equal(record.recordClass, 'DIRECT_AUTHORITY');
    assert.equal(record.bodyHash, sha(canonicalJson(doc(kind).body)));
    assert.deepEqual(reader.listVersions(kind, ref.authorityId), [ref]);
    assert.deepEqual(reader.latest(kind, ref.authorityId), record);
  });
}
check('5. a reopened archive returns identical refs and content', (root) => {
  const appender = openAuthorityArchiveAppender(root);
  const refs = KINDS.map((kind) => appender.append(doc(kind)));
  const first = refs.map((ref) => canonicalJson(openAuthorityArchiveReader(root).get(ref)));
  const again = openAuthorityArchiveReader(root);
  assert.deepEqual(refs.map((ref) => canonicalJson(again.get(ref))), first);
  assert.deepEqual(KINDS.map((kind, i) => again.listVersions(kind, refs[i].authorityId)), refs.map((ref) => [ref]));
  assert.deepEqual(KINDS.map((kind) => openAuthorityArchiveAppender(root).append(doc(kind))), refs);
});

// ---------------------------------------------------------------- identity
check('6. invalid authority ids are refused', (root) => {
  const appender = openAuthorityArchiveAppender(root);
  for (const id of ['', ' packet', 'packet ', 'packet 1', '../x', '..', 'a/b', 'a\\b', '.hidden', '-x', 'x\n', 'x\0', 'pä', 'a'.repeat(129)]) {
    fails(() => appender.append(packetDoc({ packetId: id })), 'INVALID_DOCUMENT');
    fails(() => openAuthorityArchiveReader(root).listVersions('IMPLEMENTATION_PACKET', id), 'INVALID_DOCUMENT');
  }
  // The authorityId is the body's own identifier: another spelling of it is refused.
  fails(() => appender.append({ ...packetDoc(), authorityId: 'packet-2' }), 'INVALID_DOCUMENT');
  assert.deepEqual(readdirSync(join(root, 'records')), []);
  appender.append(packetDoc({ packetId: 'a'.repeat(128) }));
});
check('7. authority ids are case-sensitive', (root) => {
  const appender = openAuthorityArchiveAppender(root);
  const lower = appender.append(packetDoc({ packetId: 'packet-1' }));
  const upper = appender.append(packetDoc({ packetId: 'Packet-1' }));
  assert.notEqual(lower.recordHash, upper.recordHash);
  const reader = openAuthorityArchiveReader(root);
  assert.equal(reader.listVersions('IMPLEMENTATION_PACKET', 'packet-1').length, 1);
  assert.equal(reader.listVersions('IMPLEMENTATION_PACKET', 'Packet-1').length, 1);
  assert.equal(reader.listVersions('IMPLEMENTATION_PACKET', 'PACKET-1').length, 0);
  assert.equal(readdirSync(join(root, 'records')).length, 2);
});
check('8. path traversal is impossible: everything stays under records/<key>/', (root) => {
  const appender = openAuthorityArchiveAppender(root);
  for (const id of ['../../escape', '..', '/etc/passwd', 'a/../../b']) fails(() => appender.append(packetDoc({ packetId: id })), 'INVALID_DOCUMENT');
  appender.append(packetDoc());
  assert.deepEqual(readdirSync(dirname(root)), ['archive'], 'something was written beside the archive');
  for (const path of walk(root)) {
    const parts = relative(root, path).split('/');
    assert.equal(parts[0], 'records');
    if (parts[1]) assert.match(parts[1], /^[0-9a-f]{64}$/);
    if (parts[2]) assert.match(parts[2], /^[0-9]{8}\.json$/);
  }
});
check('9. the raw authorityId never names a path', (root) => {
  const appender = openAuthorityArchiveAppender(root);
  for (const kind of KINDS) appender.append(doc(kind, BODIES[kind]({ [ID_FIELD[kind]]: `needle.${kind.toLowerCase()}` })));
  assert.ok(walk(root).every((path) => !path.includes('needle')));
  assert.ok(existsSync(recordFile(root, 'AUTHORIZATION', 'needle.authorization', 1)));
});

// ---------------------------------------------------------------- idempotency
check('10. an identical retry returns the same ref and writes nothing new', (root) => {
  const appender = openAuthorityArchiveAppender(root);
  const ref = appender.append(packetDoc());
  const bytes = readFileSync(recordFile(root, 'IMPLEMENTATION_PACKET', 'packet-1', 1), 'utf8');
  assert.deepEqual(appender.append(packetDoc()), ref);
  assert.deepEqual(openAuthorityArchiveAppender(root).append(structuredClone(packetDoc())), ref);
  assert.equal(readFileSync(recordFile(root, 'IMPLEMENTATION_PACKET', 'packet-1', 1), 'utf8'), bytes);
  assert.deepEqual(readdirSync(join(root, 'records', keyOf('IMPLEMENTATION_PACKET', 'packet-1'))), ['00000001.json']);
});
check('11. the same version with a different body fails closed and never overwrites', (root) => {
  const appender = openAuthorityArchiveAppender(root);
  const ref = appender.append(packetDoc());
  fails(() => appender.append(packetDoc({ objective: 'Something else' })), 'VERSION_CONFLICT');
  fails(() => appender.append(packetDoc({ packetVersion: 2 })), 'VERSION_CONFLICT');
  assert.deepEqual(openAuthorityArchiveReader(root).get(ref).body, BODIES.IMPLEMENTATION_PACKET());
});
check('12. the same version with different metadata fails closed', (root) => {
  const appender = openAuthorityArchiveAppender(root);
  const ref = appender.append(packetDoc());
  fails(() => appender.append(packetDoc({}, { issuedAt: '2026-10-05T00:00:01.000Z' })), 'VERSION_CONFLICT');
  fails(() => appender.append(packetDoc({}, { issuer: { role: 'GPT_ARCHITECT', principalRef: 'someone-else' } })), 'VERSION_CONFLICT');
  fails(() => appender.append(packetDoc({}, { subject: { repository: 'synthetic/other', sliceId: 'slice-1' } })), 'VERSION_CONFLICT');
  assert.deepEqual(openAuthorityArchiveReader(root).listVersions('IMPLEMENTATION_PACKET', 'packet-1'), [ref]);
});

// ---------------------------------------------------------------- versioning
check('13-14. version 1, then a valid version 2 superseding it', (root) => {
  const appender = openAuthorityArchiveAppender(root);
  const v1 = appender.append(packetDoc());
  const v2 = appender.append(after(v1, packetDoc({ objective: 'Revised objective' })));
  assert.equal(v2.version, 2);
  const reader = openAuthorityArchiveReader(root);
  assert.deepEqual(reader.listVersions('IMPLEMENTATION_PACKET', 'packet-1'), [v1, v2]);
  assert.deepEqual(reader.latest('IMPLEMENTATION_PACKET', 'packet-1').supersedes, v1);
  assert.equal(reader.latest('IMPLEMENTATION_PACKET', 'packet-1').body.objective, 'Revised objective');
});
check('15. a version gap is refused', (root) => {
  const appender = openAuthorityArchiveAppender(root);
  const v1 = appender.append(packetDoc());
  fails(() => appender.append({ ...packetDoc(), version: 3, supersedes: { ...v1, version: 2 } }), 'VERSION_GAP');
  fails(() => appender.append({ ...packetDoc({ packetId: 'packet-9' }), version: 2,
    supersedes: { ...v1, authorityId: 'packet-9' } }), 'VERSION_GAP');
  assert.equal(openAuthorityArchiveReader(root).listVersions('IMPLEMENTATION_PACKET', 'packet-1').length, 1);
});
check('16. a wrong previous record hash is refused', (root) => {
  const appender = openAuthorityArchiveAppender(root);
  const v1 = appender.append(packetDoc());
  fails(() => appender.append(after({ ...v1, recordHash: 'e'.repeat(64) }, packetDoc({ objective: 'x' }))), 'INVALID_SUPERSESSION');
  const v2 = appender.append(after(v1, packetDoc({ objective: 'x' })));
  // Stale: superseding v1 again once v2 exists is a fork.
  fails(() => appender.append({ ...after(v1, packetDoc({ objective: 'y' })), version: 3 }), 'INVALID_SUPERSESSION');
  fails(() => appender.append(after(v1, packetDoc({ objective: 'y' }))), 'VERSION_CONFLICT');
  assert.deepEqual(openAuthorityArchiveReader(root).listVersions('IMPLEMENTATION_PACKET', 'packet-1'), [v1, v2]);
});
check('17-18. cross-kind and cross-authority supersession are refused; version 1 supersedes nothing', (root) => {
  const appender = openAuthorityArchiveAppender(root);
  const packet = appender.append(packetDoc());
  const correction = appender.append(doc('CORRECTION_PACKET'));
  fails(() => appender.append(after({ ...correction, version: 1 }, packetDoc({ objective: 'x' }))), 'INVALID_SUPERSESSION');
  fails(() => appender.append(after({ ...packet, kind: 'CORRECTION_PACKET' }, packetDoc({ objective: 'x' }))), 'INVALID_SUPERSESSION');
  const other = appender.append(packetDoc({ packetId: 'packet-2' }));
  fails(() => appender.append(after(other, packetDoc({ objective: 'x' }))), 'INVALID_SUPERSESSION');
  fails(() => appender.append({ ...packetDoc({ packetId: 'packet-3' }), supersedes: packet }), 'INVALID_SUPERSESSION');
  assert.equal(openAuthorityArchiveReader(root).listVersions('IMPLEMENTATION_PACKET', 'packet-1').length, 1);
});
check('19. old versions stay readable and byte-identical', (root) => {
  const appender = openAuthorityArchiveAppender(root);
  const v1 = appender.append(packetDoc());
  const bytes = readFileSync(recordFile(root, 'IMPLEMENTATION_PACKET', 'packet-1', 1), 'utf8');
  let previous = v1;
  for (let i = 2; i <= 4; i++) previous = appender.append(after(previous, packetDoc({ objective: `Revision ${i}` })));
  assert.equal(readFileSync(recordFile(root, 'IMPLEMENTATION_PACKET', 'packet-1', 1), 'utf8'), bytes);
  assert.equal(openAuthorityArchiveReader(root).get(v1).body.objective, 'Offline fixture');
  assert.equal(openAuthorityArchiveReader(root).listVersions('IMPLEMENTATION_PACKET', 'packet-1').length, 4);
  fails(() => openAuthorityArchiveReader(root).get({ ...v1, recordHash: previous.recordHash }), 'REF_MISMATCH');
  assert.equal(openAuthorityArchiveReader(root).get({ ...v1, version: 9 }), undefined);
});

// ---------------------------------------------------------------- integrity (every open fails closed)
function tampered(name, mutate, setup = (appender) => appender.append(packetDoc())) {
  check(name, (root) => {
    setup(openAuthorityArchiveAppender(root));
    mutate(root);
    fails(() => openAuthorityArchiveReader(root), 'ARCHIVE_INTEGRITY');
    fails(() => openAuthorityArchiveAppender(root), 'ARCHIVE_INTEGRITY');
  });
}
tampered('20. a tampered body is detected', (root) =>
  rewrite(root, 'IMPLEMENTATION_PACKET', 'packet-1', 1, (record) => { record.body.objective = 'Tampered'; }));
tampered('21. a tampered envelope is detected', (root) =>
  rewrite(root, 'IMPLEMENTATION_PACKET', 'packet-1', 1, (record) => { record.issuer.principalRef = 'someone-else'; }));
tampered('22a. a malformed record fails closed', (root) =>
  writeFileSync(recordFile(root, 'IMPLEMENTATION_PACKET', 'packet-1', 1), '{"schemaVersion":1,'));
tampered('22b. a record not in canonical form fails closed', (root) => {
  const file = recordFile(root, 'IMPLEMENTATION_PACKET', 'packet-1', 1);
  writeFileSync(file, JSON.stringify(JSON.parse(readFileSync(file, 'utf8')), null, 2));
});
tampered('22c. an invalid stored timestamp, kind or identity fails closed even with recomputed hashes', (root) => {
  rewrite(root, 'IMPLEMENTATION_PACKET', 'packet-1', 1, (record) => { record.issuedAt = '2026-02-30T00:00:00Z'; }, { reseal: true });
});
tampered('22d. a stored body that is not its kind fails closed even with recomputed hashes', (root) => {
  rewrite(root, 'IMPLEMENTATION_PACKET', 'packet-1', 1, (record) => { record.kind = 'CORRECTION_PACKET'; }, { reseal: true });
});
tampered('23. an unsupported schema or record class fails closed', (root) => {
  rewrite(root, 'IMPLEMENTATION_PACKET', 'packet-1', 1, (record) => { record.schemaVersion = 2; }, { reseal: true });
});
tampered('23b. an operational record class stored as authority fails closed', (root) => {
  rewrite(root, 'IMPLEMENTATION_PACKET', 'packet-1', 1, (record) => { record.recordClass = 'OPERATIONAL_RECORD'; }, { reseal: true });
});
tampered('24a. a record in another logical directory fails closed', (root) => {
  const target = join(root, 'records', keyOf('IMPLEMENTATION_PACKET', 'packet-2'));
  mkdirSync(target);
  renameSync(recordFile(root, 'IMPLEMENTATION_PACKET', 'packet-1', 1), join(target, '00000001.json'));
});
tampered('24b. a record filed under another version fails closed', (root) => {
  renameSync(recordFile(root, 'IMPLEMENTATION_PACKET', 'packet-1', 2), recordFile(root, 'IMPLEMENTATION_PACKET', 'packet-1', 3));
}, (appender) => appender.append(after(appender.append(packetDoc()), packetDoc({ objective: 'x' }))));
tampered('24c. a gap in a stored chain fails closed', (root) => {
  rmSync(recordFile(root, 'IMPLEMENTATION_PACKET', 'packet-1', 1));
}, (appender) => appender.append(after(appender.append(packetDoc()), packetDoc({ objective: 'x' }))));
tampered('24d. a stored fork (a version not superseding its predecessor) fails closed', (root) => {
  const other = forge({ ...packetDoc({ objective: 'Fork' }), version: 2,
    supersedes: { kind: 'IMPLEMENTATION_PACKET', authorityId: 'packet-1', version: 1, recordHash: 'e'.repeat(64) } });
  writeFileSync(recordFile(root, 'IMPLEMENTATION_PACKET', 'packet-1', 2), canonicalJson(other));
});
tampered('24e. an unknown entry in the archive fails closed', (root) => {
  writeFileSync(join(root, 'records', keyOf('IMPLEMENTATION_PACKET', 'packet-1'), 'notes.txt'), 'x');
});

// ---------------------------------------------------------------- crash safety
function crashChild(root, patch) {
  const script = `
    import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    import { openAuthorityArchiveAppender } from './dist/automation/authority/file-archive.js';
    const appender = openAuthorityArchiveAppender(process.argv[1]);
    fs.${patch} = () => process.exit(9); syncBuiltinESMExports();
    appender.append(JSON.parse(process.argv[2]));`;
  return new Promise((resolve) => spawn(process.execPath, ['--input-type=module', '-e', script, root, JSON.stringify(packetDoc())],
    { cwd: ROOT }).on('close', resolve));
}
check('25. a crash before canonical publication leaves no authority', async (root) => {
  assert.equal(await crashChild(root, 'linkSync'), 9);
  const directory = join(root, 'records', keyOf('IMPLEMENTATION_PACKET', 'packet-1'));
  assert.ok(readdirSync(directory).some((name) => name.endsWith('.tmp')), 'the killed writer left its temp');
  assert.deepEqual(openAuthorityArchiveReader(root).listVersions('IMPLEMENTATION_PACKET', 'packet-1'), []);
  const ref = openAuthorityArchiveAppender(root).append(packetDoc());
  assert.equal(ref.version, 1);
});
check('26-27. published authority survives a crash and restart; a retry adds no duplicate', async (root) => {
  // The writer dies after link + directory fsync, while removing its temp name.
  assert.equal(await crashChild(root, 'unlinkSync'), 9);
  const reader = openAuthorityArchiveReader(root);
  const [ref] = reader.listVersions('IMPLEMENTATION_PACKET', 'packet-1');
  assert.equal(ref.version, 1);
  assert.deepEqual(openAuthorityArchiveAppender(root).append(packetDoc()), ref);
  const names = readdirSync(join(root, 'records', keyOf('IMPLEMENTATION_PACKET', 'packet-1')));
  assert.deepEqual(names.filter((name) => name.endsWith('.json')), ['00000001.json']);
});
check('28. a stale temp never becomes authority, even when it holds a valid sealed record', (root) => {
  const directory = join(root, 'records', keyOf('IMPLEMENTATION_PACKET', 'packet-1'));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, '00000001.00000000-0000-4000-8000-000000000000.tmp'), canonicalJson(forge(packetDoc({ objective: 'Stale' }))));
  assert.deepEqual(openAuthorityArchiveReader(root).listVersions('IMPLEMENTATION_PACKET', 'packet-1'), []);
  const ref = openAuthorityArchiveAppender(root).append(packetDoc());
  assert.equal(openAuthorityArchiveReader(root).get(ref).body.objective, 'Offline fixture');
});
check('28b. without exclusive link publication an append fails closed, with no fallback', (root) => {
  const appender = openAuthorityArchiveAppender(root);
  for (const code of ['EPERM', 'ENOTSUP', 'EXDEV', 'EIO']) {
    withFs('linkSync', () => () => { throw Object.assign(new Error(`link: ${code}`), { code }); },
      () => fails(() => appender.append(packetDoc()), 'PUBLICATION_UNAVAILABLE'));
    assert.deepEqual(readdirSync(join(root, 'records', keyOf('IMPLEMENTATION_PACKET', 'packet-1'))), [], `${code} left a file`);
  }
  assert.equal(appender.append(packetDoc()).version, 1);
});

// ---------------------------------------------------------------- concurrency (separate processes)
const WORKER = `
  import { openAuthorityArchiveAppender } from './dist/automation/authority/file-archive.js';
  const [root, payload, goAt] = process.argv.slice(1);
  const appender = openAuthorityArchiveAppender(root);
  const late = Date.now() > Number(goAt);
  while (Date.now() < Number(goAt)) { /* start together */ }
  let out;
  try { out = { ok: true, ref: appender.append(JSON.parse(payload)) }; }
  catch (error) { out = { ok: false, code: error.code ?? error.message }; }
  console.log(JSON.stringify({ ...out, late }));`;
function race(root, documents) {
  const goAt = String(Date.now() + 2500);
  return Promise.all(documents.map((document) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', WORKER, root, JSON.stringify(document), goAt], { cwd: ROOT });
    let out = '', err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (status) => (status === 0 ? resolve(JSON.parse(out.trim().split('\n').at(-1))) : reject(new Error(err))));
  })));
}
const contention = [];
check('29. many identical v1 appenders in separate processes: exactly one canonical record, one ref', async (root) => {
  const results = await race(root, Array.from({ length: 12 }, () => packetDoc()));
  assert.ok(results.every((result) => result.ok), JSON.stringify(results));
  assert.equal(new Set(results.map((result) => canonicalJson(result.ref))).size, 1);
  assert.deepEqual(readdirSync(join(root, 'records', keyOf('IMPLEMENTATION_PACKET', 'packet-1'))), ['00000001.json']);
  contention.push(`identical ${results.filter((r) => !r.late).length}/12`);
});
check('30. conflicting v1 appenders in separate processes: one winner, the rest fail closed', async (root) => {
  const results = await race(root, Array.from({ length: 12 }, (_, i) => packetDoc({ objective: `Candidate ${i}` })));
  const winners = results.filter((result) => result.ok);
  assert.equal(winners.length, 1, JSON.stringify(results));
  assert.ok(results.every((result) => result.ok || result.code === 'VERSION_CONFLICT'), JSON.stringify(results));
  assert.deepEqual(openAuthorityArchiveReader(root).listVersions('IMPLEMENTATION_PACKET', 'packet-1'), [winners[0].ref]);
  contention.push(`conflicting ${results.filter((r) => !r.late).length}/12`);
});
check('31. concurrent v2 appenders cannot branch the chain', async (root) => {
  const v1 = openAuthorityArchiveAppender(root).append(packetDoc());
  const results = await race(root, Array.from({ length: 12 }, (_, i) => after(v1, packetDoc({ objective: `Revision ${i}` }))));
  const winners = results.filter((result) => result.ok);
  assert.equal(winners.length, 1, JSON.stringify(results));
  assert.ok(results.every((result) => result.ok || result.code === 'VERSION_CONFLICT'), JSON.stringify(results));
  assert.deepEqual(openAuthorityArchiveReader(root).listVersions('IMPLEMENTATION_PACKET', 'packet-1'), [v1, winners[0].ref]);
  assert.deepEqual(readdirSync(join(root, 'records', keyOf('IMPLEMENTATION_PACKET', 'packet-1'))).sort(), ['00000001.json', '00000002.json']);
  contention.push(`v2 ${results.filter((r) => !r.late).length}/12`);
});

// ---------------------------------------------------------------- capabilities and authority semantics
const FORBIDDEN_NAMES = /update|replace|delete|remove|truncate|rewrite|setlatest|import|promote|backfill|repair|move|rename/i;
check('32. the read capability cannot mutate', (root) => {
  const ref = openAuthorityArchiveAppender(root).append(packetDoc());
  const reader = openAuthorityArchiveReader(root);
  assert.deepEqual(Object.keys(reader).sort(), ['get', 'latest', 'listVersions']);
  assert.ok(Object.isFrozen(reader));
  assert.equal(reader.append, undefined);
  assert.throws(() => { reader.append = () => {}; });
  const record = reader.get(ref); record.body.objective = 'changed'; record.version = 7;
  reader.latest('IMPLEMENTATION_PACKET', 'packet-1').body.objective = 'changed';
  assert.throws(() => { reader.listVersions('IMPLEMENTATION_PACKET', 'packet-1').push(ref); });
  assert.equal(openAuthorityArchiveReader(root).get(ref).body.objective, 'Offline fixture');
});
check('33. no update, replace, delete or other rewriting API exists', (root) => {
  const appender = openAuthorityArchiveAppender(root);
  assert.deepEqual(Object.keys(appender), ['append']);
  assert.ok(Object.isFrozen(appender));
  for (const module of [documentModule, archiveModule]) {
    assert.deepEqual(Object.keys(module).filter((name) => FORBIDDEN_NAMES.test(name)), []);
  }
  assert.deepEqual(Object.keys(archiveModule).sort(), ['openAuthorityArchiveAppender', 'openAuthorityArchiveReader']);
});
check('34. an invocation journal record can never become authority', (root) => {
  const appender = openAuthorityArchiveAppender(root);
  const journalRecord = { invocationId: 'f'.repeat(64), runId: 'run-1', sliceId: 'slice-1', packetId: 'packet-1', packetHash: 'd'.repeat(64),
    implementationIteration: 1, actorKind: 'IMPLEMENTATION', state: 'APPLIED', history: [{ state: 'PREPARED', at: T }] };
  for (const kind of KINDS) {
    fails(() => appender.append({ ...doc(kind), body: journalRecord }), 'INVALID_DOCUMENT');
    fails(() => appender.append({ ...doc(kind), recordClass: 'OPERATIONAL_RECORD' }), 'INVALID_DOCUMENT');
  }
  assert.deepEqual(readdirSync(join(root, 'records')), []);
});
check('35. R4L admission and refusal records can never become authority', (root) => {
  const appender = openAuthorityArchiveAppender(root);
  const admitted = admission.admissionRecordOf({ repository: REPO, sliceId: 'slice-1' }, 'run-1', T);
  assert.equal(admitted.recordClass, 'OPERATIONAL_RECORD');
  const refusal = { ...admitted, kind: 'CHANGE_ADMISSION_REFUSAL', code: 'SECOND_RUN_FOR_CHANGE' };
  for (const kind of KINDS) for (const body of [admitted, refusal]) fails(() => appender.append({ ...doc(kind), body }), 'INVALID_DOCUMENT');
  // A controller audit entry or a CI observation is not a body either.
  fails(() => appender.append({ ...doc('AUTHORIZATION'), body: { sequence: 1, runId: 'run-1', action: 'AUTHORIZE_PROMOTION', role: 'HUMAN' } }), 'INVALID_DOCUMENT');
  fails(() => appender.append({ ...doc('ACCEPTANCE_DECISION'), body: { repository: REPO, branch: 'main', sha: B, workflowStatus: 'SUCCESS' } }), 'INVALID_DOCUMENT');
  assert.deepEqual(readdirSync(join(root, 'records')), []);
});
check('36. a matching hash is integrity, never authenticity', (root) => {
  openAuthorityArchiveAppender(root);
  // A writer around the archive can seal a record whose hashes verify, naming any principal.
  const forged = forge(doc('AUTHORIZATION', BODIES.AUTHORIZATION({ authorizationId: 'auth-forged' }), {
    issuer: { role: 'HUMAN', principalRef: 'not-the-human' } }));
  mkdirSync(join(root, 'records', keyOf('AUTHORIZATION', 'auth-forged')));
  writeFileSync(recordFile(root, 'AUTHORIZATION', 'auth-forged', 1), canonicalJson(forged));
  const record = openAuthorityArchiveReader(root).latest('AUTHORIZATION', 'auth-forged');
  assert.equal(record.issuer.principalRef, 'not-the-human');
  assert.deepEqual(Object.keys(record).sort(), ['authorityId', 'body', 'bodyHash', 'issuedAt', 'issuer', 'kind', 'recordClass',
    'recordHash', 'schemaVersion', 'subject', 'supersedes', 'version']);
  const source = readFileSync(join(ROOT, 'src/automation/authority/document.ts'), 'utf8');
  assert.match(source, /not a signature, not Human authentication/);
});
check('storage separation: the archive refuses a root it shares with another store', (root) => {
  new FileControllerStore(root).create({ runId: 'run-1', sliceId: 'slice-1', repository: REPO, state: 'IDLE',
    implementationIterations: 0, acceptanceFailures: 0, audit: [] });
  fails(() => openAuthorityArchiveAppender(root), 'ARCHIVE_INTEGRITY');
  fails(() => openAuthorityArchiveReader(root), 'ARCHIVE_INTEGRITY');
  const reader = openAuthorityArchiveReader(join(root, 'absent'));
  assert.deepEqual(reader.listVersions('AUTHORIZATION', 'auth-promote'), []);
  assert.equal(existsSync(join(root, 'absent')), false, 'a reader created the archive');
});
check('the archive is wired into no runtime surface', () => {
  const sources = walk(join(ROOT, 'src')).filter((path) => path.endsWith('.ts') && !path.includes('/automation/authority/'));
  const users = sources.filter((path) => /from ['"][^'"]*authority\/(document|file-archive)\.js['"]/.test(readFileSync(path, 'utf8')));
  assert.deepEqual(users, []);
});

let passed = 0, failed = 0;
for (const { name, fn } of tests) {
  const dir = mkdtempSync(join(tmpdir(), 'chief-r4p-'));
  try { await fn(join(dir, 'archive')); console.log(`  PASS ${name}`); passed++; }
  catch (error) { console.error(`  FAIL ${name}: ${error.stack}`); failed++; }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
if (contention.length) console.log(`  (races started together: ${contention.join('; ')})`);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
