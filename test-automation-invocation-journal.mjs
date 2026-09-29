import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileInvocationJournal } from './dist/automation/file-invocation-journal.js';
import {
  InvocationJournalIntegrityError, MAX_RESULT_BYTES, invocationIdOf, readStoredOutcome, sha256Hex,
} from './dist/automation/invocation-journal.js';

const T = '2026-09-28T00:00:00.000Z';
const clock = { now: () => T };
const tests = [];
const check = (name, fn) => tests.push([name, fn]);
function withDir(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chief-journal-'));
    try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
}
const EGRESS = ['api.anthropic.com:443', 'platform.claude.com:443'];
function identity(overrides = {}) {
  return { runId: 'run-1', sliceId: 'slice-1', packetId: 'packet-1', packetHash: 'd'.repeat(64),
    occurrence: { sequence: 4, action: 'BEGIN_IMPLEMENTATION', timestamp: T }, actorKind: 'IMPLEMENTATION',
    provider: 'anthropic', model: 'claude-opus-5-5', egressDestinations: EGRESS, authorizationId: 'auth-live-impl', ...overrides };
}
const at = (sequence, kind = 'IMPLEMENTATION') => identity({ occurrence: { sequence, action: 'BEGIN_IMPLEMENTATION', timestamp: T }, actorKind: kind });
const files = (dir) => readdirSync(dir).filter((name) => name.endsWith('.json'));
const fileOf = (dir, id) => join(dir, `${id}.json`);
function reseal(dir, id, change) {
  const envelope = JSON.parse(readFileSync(fileOf(dir, id), 'utf8'));
  change(envelope.record);
  envelope.checksum = sha256Hex(JSON.stringify(envelope.record));
  writeFileSync(fileOf(dir, id), JSON.stringify(envelope));
}

check('prepare records exact intent under the one id for its run, occurrence, and actor', withDir((dir) => {
  const journal = new FileInvocationJournal(dir, clock);
  const record = journal.prepare(identity());
  assert.equal(record.invocationId, invocationIdOf('run-1', 4, 'IMPLEMENTATION'));
  assert.deepEqual([record.state, record.history], ['PREPARED', [{ state: 'PREPARED', at: T }]]);
  assert.deepEqual(record.identity, identity());
  assert.deepEqual(journal.find('run-1', 4, 'IMPLEMENTATION'), record);
  journal.get(record.invocationId).identity.model = 'changed';
  assert.equal(journal.get(record.invocationId).identity.model, 'claude-opus-5-5');
  assert.ok(Object.isFrozen(journal) && Object.isFrozen(FileInvocationJournal.prototype));
}));
check('the identity schema is strict and nothing is written for a refused identity', withDir((dir) => {
  const journal = new FileInvocationJournal(dir, clock);
  for (const bad of [{ ...identity(), token: 'x' }, { ...identity(), authorizationId: undefined }, identity({ packetHash: 'short' }),
    identity({ occurrence: { sequence: 0, action: 'BEGIN_IMPLEMENTATION', timestamp: T } }), identity({ actorKind: 'HUMAN' }),
    identity({ model: ' claude-opus-5-5' }), identity({ occurrence: { sequence: 4, action: 'X', timestamp: 'later' } }),
    { ...identity(), authorization: { actorRole: 'HUMAN', reason: 'grant text' } }]) {
    assert.throws(() => journal.prepare(bad));
  }
  assert.deepEqual(files(dir), []);
}));
check('one occurrence and actor kind have at most one invocation identity', withDir((dir) => {
  const journal = new FileInvocationJournal(dir, clock);
  journal.prepare(identity());
  assert.throws(() => journal.prepare(identity({ provider: 'other', authorizationId: 'auth-other' })), /Duplicate invocation identity/);
  assert.equal(journal.prepare(identity({ actorKind: 'ARCHITECT_REVIEW' })).identity.actorKind, 'ARCHITECT_REVIEW');
  assert.equal(journal.get(invocationIdOf('run-1', 4, 'IMPLEMENTATION')).identity.provider, 'anthropic');
}));
check('only legal transitions are written, and a refused one leaves the bytes unchanged', withDir((dir) => {
  const journal = new FileInvocationJournal(dir, clock);
  const id = journal.prepare(identity()).invocationId;
  const bytes = () => readFileSync(fileOf(dir, id), 'utf8');
  let before = bytes();
  assert.throws(() => journal.complete(id, { ok: true, value: 1 }));
  assert.throws(() => journal.markApplied(id, { sequence: 5, action: 'X' }));
  assert.throws(() => journal.markUncertain(id, 'x'));
  assert.equal(bytes(), before);
  assert.equal(journal.start(id, 5).status, 'STARTED');
  before = bytes();
  assert.throws(() => journal.abandon(id, 'x'));
  assert.throws(() => journal.markApplied(id, { sequence: 5, action: 'X' }));
  assert.equal(bytes(), before);
  journal.complete(id, { ok: true, value: { status: 'COMPLETED' } });
  assert.throws(() => journal.markApplied(id, { sequence: 9, action: 'X' }), /next controller entry/);
  const applied = journal.markApplied(id, { sequence: 5, action: 'REPORT_IMPLEMENTATION_COMPLETE' });
  assert.deepEqual(applied.history.map((entry) => entry.state), ['PREPARED', 'STARTED', 'COMPLETED', 'APPLIED']);
  before = bytes();
  for (const change of [() => journal.abandon(id, 'x'), () => journal.markUncertain(id, 'x'), () => journal.start(id, 5).status === 'STARTED' || (() => { throw new Error('not started'); })()]) {
    assert.throws(change);
  }
  assert.equal(bytes(), before);
  for (const terminal of ['UNCERTAIN', 'ABANDONED']) {
    const other = journal.prepare(at(terminal === 'UNCERTAIN' ? 10 : 12)).invocationId;
    if (terminal === 'UNCERTAIN') { journal.start(other, 5); journal.markUncertain(other, 'unknown'); } else journal.abandon(other, 'left');
    assert.throws(() => journal.complete(other, { ok: true, value: 1 }));
    assert.equal(journal.start(other, 5).status, 'NOT_PREPARED');
  }
}));
check('corrupted bytes fail closed: checksum, JSON, version, illegal history, foreign id', withDir((dir) => {
  const journal = new FileInvocationJournal(dir, clock);
  const id = journal.prepare(identity()).invocationId;
  const file = fileOf(dir, id);
  const original = readFileSync(file, 'utf8');
  writeFileSync(file, original.replace('anthropic', 'anthropiC'));
  assert.throws(() => journal.get(id), InvocationJournalIntegrityError);
  writeFileSync(file, '{not json');
  assert.throws(() => journal.get(id), InvocationJournalIntegrityError);
  writeFileSync(file, original.replace('"schemaVersion":2', '"schemaVersion":3'));
  assert.throws(() => journal.get(id), InvocationJournalIntegrityError);
  writeFileSync(file, original);
  reseal(dir, id, (record) => { record.state = 'APPLIED'; record.history.push({ state: 'APPLIED', at: T }); record.application = { sequence: 5, action: 'X' }; });
  assert.throws(() => journal.get(id), InvocationJournalIntegrityError);
  writeFileSync(file, original);
  reseal(dir, id, (record) => { record.identity.occurrence.sequence = 5; });
  assert.throws(() => journal.get(id), InvocationJournalIntegrityError);
  assert.throws(() => journal.list('run-1'), InvocationJournalIntegrityError);
  assert.throws(() => journal.start(id, 5), InvocationJournalIntegrityError);
}));
check('persistence is atomic: a sealed envelope, owner-only mode, no temp left, orphan temp ignored', withDir((dir) => {
  const journal = new FileInvocationJournal(dir, clock);
  const id = journal.prepare(identity()).invocationId;
  journal.start(id, 5);
  const envelope = JSON.parse(readFileSync(fileOf(dir, id), 'utf8'));
  assert.deepEqual(Object.keys(envelope).sort(), ['checksum', 'record', 'schemaVersion']);
  assert.equal(envelope.checksum, sha256Hex(JSON.stringify(envelope.record)));
  assert.equal(statSync(fileOf(dir, id)).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.tmp') || name.endsWith('.lock')), []);
  writeFileSync(join(dir, `${id}.json.orphan.tmp`), 'partial');
  assert.equal(journal.list('run-1').length, 1);
}));
check('the writer lock is exclusive and a leftover lock is never removed', withDir((dir) => {
  const journal = new FileInvocationJournal(dir, clock);
  const id = journal.prepare(identity()).invocationId;
  writeFileSync(join(dir, '.journal.lock'), 'uncertain writer');
  assert.throws(() => journal.start(id, 5), /EEXIST/);
  assert.throws(() => journal.prepare(at(8)), /EEXIST/);
  assert.equal(readFileSync(join(dir, '.journal.lock'), 'utf8'), 'uncertain writer');
  assert.equal(journal.get(id).state, 'PREPARED');
  rmSync(join(dir, '.journal.lock'));
  assert.equal(journal.start(id, 5).status, 'STARTED');
}));
check('PREPARED consumes no call; every call that ever STARTED counts, per run and packet', withDir((dir) => {
  const journal = new FileInvocationJournal(dir, clock);
  const [a, b, c, d] = [4, 8, 12, 16].map((sequence) => journal.prepare(at(sequence)).invocationId);
  const abandoned = journal.prepare(at(20)).invocationId;
  journal.abandon(abandoned, 'never dispatched');
  const otherPacket = journal.prepare(identity({ packetId: 'packet-2', occurrence: { sequence: 24, action: 'BEGIN_IMPLEMENTATION', timestamp: T } })).invocationId;
  assert.equal(journal.start(otherPacket, 1).status, 'STARTED');
  assert.equal(journal.start(a, 2).status, 'STARTED');
  journal.markUncertain(a, 'crashed');
  assert.equal(journal.start(b, 2).status, 'STARTED');
  const exhausted = journal.start(c, 2);
  assert.deepEqual([exhausted.status, exhausted.used, journal.get(c).state], ['BUDGET_EXHAUSTED', 2, 'PREPARED']);
  assert.equal(journal.start(d, 3).status, 'STARTED');
  assert.throws(() => journal.start(c, -1));
  assert.throws(() => journal.start(c, 1.5));
}));
check('a stored result is detached, hashed, bounded plain data, and its digest is checked on read', withDir((dir) => {
  const journal = new FileInvocationJournal(dir, clock);
  const id = journal.prepare(identity()).invocationId;
  journal.start(id, 5);
  const value = { status: 'COMPLETED', validationEvidence: ['npm test: exit 0'] };
  for (const bad of [{ ok: true, value: { get status() { return 'COMPLETED'; } } }, { ok: true, value: () => 1 },
    { ok: true, value: 'x'.repeat(MAX_RESULT_BYTES) }, { ok: true, value: Number.NaN }, { ok: false }, { ok: true, value: 1, extra: 1 }]) {
    assert.throws(() => journal.complete(id, bad));
  }
  assert.equal(journal.get(id).state, 'STARTED');
  const record = journal.complete(id, { ok: true, value });
  value.status = 'changed';
  assert.deepEqual(readStoredOutcome(record), { ok: true, value: { status: 'COMPLETED', validationEvidence: ['npm test: exit 0'] } });
  assert.equal(record.result.sha256, sha256Hex(record.result.serialized));
  assert.deepEqual(record.result.metadata, { provider: 'anthropic', model: 'claude-opus-5-5', egressDestinations: EGRESS,
    authorizationId: 'auth-live-impl' });
  reseal(dir, id, (stored) => { stored.result.serialized = stored.result.serialized.replace('exit 0', 'exit 1'); });
  assert.throws(() => journal.get(id), /digest/);
  reseal(dir, id, (stored) => { stored.result.sha256 = sha256Hex(stored.result.serialized); });
  assert.match(readStoredOutcome(journal.get(id)).value.validationEvidence[0], /exit 1/);
}));
check('only the authorization id is stored: no grant, environment, or credential field exists', withDir((dir) => {
  const journal = new FileInvocationJournal(dir, clock);
  const id = journal.prepare(identity()).invocationId;
  journal.start(id, 5);
  journal.complete(id, { ok: true, value: { status: 'COMPLETED', validationEvidence: ['pass'] } });
  const text = readFileSync(fileOf(dir, id), 'utf8');
  assert.match(text, /auth-live-impl/);
  const record = JSON.parse(text).record;
  assert.deepEqual(Object.keys(record).sort(), ['history', 'identity', 'invocationId', 'result', 'state']);
  assert.deepEqual(Object.keys(record.identity).sort(), ['actorKind', 'authorizationId', 'egressDestinations', 'model', 'occurrence', 'packetHash',
    'packetId', 'provider', 'runId', 'sliceId']);
  assert.doesNotMatch(text, /actorRole|issuedAt|expiresAt|reason|env|token|secret|password|api_?key/i);
}));
check('list is per run; a corrupt record anywhere fails the listing closed', withDir((dir) => {
  const journal = new FileInvocationJournal(dir, clock);
  journal.prepare(identity());
  journal.prepare(identity({ runId: 'run-2' }));
  assert.deepEqual(journal.list('run-1').map((record) => record.identity.runId), ['run-1']);
  writeFileSync(fileOf(dir, invocationIdOf('run-2', 4, 'IMPLEMENTATION')), 'corrupt');
  assert.throws(() => journal.list('run-1'), InvocationJournalIntegrityError);
}));
check('two journal instances: the second start of one invocation never starts it again', withDir((dir) => {
  const first = new FileInvocationJournal(dir, clock);
  const second = new FileInvocationJournal(dir, clock);
  const id = first.prepare(identity()).invocationId;
  assert.equal(second.get(id).state, 'PREPARED');
  assert.equal(first.start(id, 5).status, 'STARTED');
  const lost = second.start(id, 5);
  assert.deepEqual([lost.status, lost.record.state], ['NOT_PREPARED', 'STARTED']);
  assert.equal(first.get(id).history.filter((entry) => entry.state === 'STARTED').length, 1);
}));
check('two processes racing PREPARED -> STARTED: exactly one wins', withDir(async (dir) => {
  const journal = new FileInvocationJournal(dir, clock);
  const id = journal.prepare(identity()).invocationId;
  const script = `import { FileInvocationJournal } from ${JSON.stringify(new URL('./dist/automation/file-invocation-journal.js', import.meta.url).href)};
    const journal = new FileInvocationJournal(${JSON.stringify(dir)}, { now: () => ${JSON.stringify(T)} });
    const until = Date.now() + 2000; let result;
    while (Date.now() < until) { try { result = journal.start(${JSON.stringify(id)}, 5).status; break; } catch (error) { if (!String(error.message).includes('EEXIST')) { result = 'ERROR'; break; } } }
    process.stdout.write(result ?? 'TIMEOUT');`;
  const race = () => new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('close', () => resolve(out));
  });
  const results = await Promise.all([race(), race(), race()]);
  assert.equal(results.filter((result) => result === 'STARTED').length, 1, results.join());
  assert.equal(results.filter((result) => result === 'NOT_PREPARED').length, 2, results.join());
  assert.equal(journal.get(id).history.filter((entry) => entry.state === 'STARTED').length, 1);
}));

// ---------------------------------------------------------------- G1-R3C: exact egress sets, schema version 2
check('the exact canonical egress set is stored; a non-canonical, empty, or logical set is refused at prepare', withDir((dir) => {
  const journal = new FileInvocationJournal(dir, clock);
  const record = journal.prepare(identity());
  assert.deepEqual(record.identity.egressDestinations, EGRESS);
  assert.deepEqual(JSON.parse(readFileSync(fileOf(dir, record.invocationId), 'utf8')).record.identity.egressDestinations, EGRESS);
  const refused = [[], ['platform.claude.com:443', 'api.anthropic.com:443'], ['api.anthropic.com:443', 'api.anthropic.com:443'], ['anthropic'],
    ['api.anthropic.com'], ['API.anthropic.com:443'], ['https://api.anthropic.com:443'], ['*.anthropic.com:443'], ['api.anthropic.com:0443'],
    'api.anthropic.com:443', undefined];
  for (const [index, egressDestinations] of refused.entries()) {
    assert.throws(() => journal.prepare({ ...at(10 + index), egressDestinations }), undefined, JSON.stringify(egressDestinations));
  }
  assert.throws(() => journal.prepare({ ...at(30), destination: 'api.anthropic.com' }), undefined, 'the single-destination identity is not representable');
  assert.deepEqual(files(dir), [`${record.invocationId}.json`]);
}));
check('stored metadata must bind exactly the identity egress set; a mismatch fails closed', withDir((dir) => {
  const journal = new FileInvocationJournal(dir, clock);
  const id = journal.prepare(identity()).invocationId;
  journal.start(id, 5);
  journal.complete(id, { ok: true, value: { status: 'COMPLETED', validationEvidence: ['pass'] } });
  for (const set of [['api.anthropic.com:443'], [...EGRESS, 'statsig.anthropic.com:443'], ['api.anthropic.com:443', 'platform.claude.com:8443']]) {
    reseal(dir, id, (stored) => { stored.result.metadata.egressDestinations = set; });
    assert.throws(() => journal.get(id), /metadata does not match/, JSON.stringify(set));
  }
  reseal(dir, id, (stored) => { stored.result.metadata.egressDestinations = [...EGRESS]; });
  assert.equal(journal.get(id).state, 'COMPLETED');
}));
check('version 2 envelopes carry the checksum; a version 1 record fails closed as unsupported and is never migrated', withDir((dir) => {
  const journal = new FileInvocationJournal(dir, clock);
  const id = journal.prepare(identity()).invocationId;
  const envelope = JSON.parse(readFileSync(fileOf(dir, id), 'utf8'));
  assert.equal(envelope.schemaVersion, 2);
  assert.equal(envelope.checksum, sha256Hex(JSON.stringify(envelope.record)));
  // A version 1 record as R3B wrote it: one destination string, correctly sealed for its version.
  const legacy = { ...envelope.record, identity: { ...envelope.record.identity, destination: 'api.anthropic.com' } };
  delete legacy.identity.egressDestinations;
  const v1 = JSON.stringify({ schemaVersion: 1, record: legacy, checksum: sha256Hex(JSON.stringify(legacy)) });
  writeFileSync(fileOf(dir, id), v1);
  assert.throws(() => journal.get(id), /Unsupported invocation journal version 1; records are never migrated/);
  assert.throws(() => journal.list('run-1'), InvocationJournalIntegrityError);
  assert.throws(() => journal.start(id, 5), InvocationJournalIntegrityError);
  assert.equal(readFileSync(fileOf(dir, id), 'utf8'), v1, 'the version 1 bytes are left exactly as they were');
  // Relabelled as version 2, the single-destination shape is still refused.
  writeFileSync(fileOf(dir, id), JSON.stringify({ schemaVersion: 2, record: legacy, checksum: sha256Hex(JSON.stringify(legacy)) }));
  assert.throws(() => journal.get(id), /malformed/);
}));

let passed = 0, failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`  PASS ${name}`); passed++; }
  catch (error) { console.error(`  FAIL ${name}: ${error.stack}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
