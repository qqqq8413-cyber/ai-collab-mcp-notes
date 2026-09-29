import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EGRESS_REASONS, EgressJournalIntegrityError, assertEgressTransition, parseEgressSession, summarizeEgress,
} from './dist/automation/egress-journal.js';
import { FileEgressJournal } from './dist/automation/file-egress-journal.js';
import { sha256Hex } from './dist/automation/invocation-journal.js';
import {
  BROKER_BIND_ADDRESS, ConnectBroker, DEFAULT_BROKER_LIMITS, HeadAccumulator, PublicAddressResolver, TcpDialer, UnsafeAddressError,
  hasCredentialHeader, isPublicAddress,
} from './dist/automation/live/connect-broker.js';

// G1-R3C egress evidence and the CONNECT broker. Offline: every socket is on 127.0.0.1
// and every upstream is a local fake provider this test owns. Hostnames reach the broker
// only through an injected deterministic resolver (the production resolver is exercised
// with an injected lookup and never resolves a real name). No provider or model endpoint
// is contacted, and no credential exists.

const T = '2026-09-29T00:00:00.000Z';
const clock = { now: () => T };
const ID = 'a'.repeat(64), OTHER = 'b'.repeat(64);
const tests = [];
const check = (name, fn) => tests.push([name, fn]);
function withDir(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chief-egress-'));
    try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
}
const identity = (overrides = {}) => ({ invocationId: ID, provider: 'anthropic', model: 'claude-opus-5-5',
  egressDestinations: ['api.anthropic.com:443', 'platform.claude.com:443'], ...overrides });
const fileOf = (dir, id = ID) => join(dir, `${id}.json`);
function reseal(dir, change, id = ID) {
  const envelope = JSON.parse(readFileSync(fileOf(dir, id), 'utf8'));
  change(envelope.session);
  envelope.checksum = sha256Hex(JSON.stringify(envelope.session));
  writeFileSync(fileOf(dir, id), JSON.stringify(envelope));
}

// ---------------------------------------------------------------- egress journal
check('a session is bound to one invocation, provider, model, and exact set; a second session is refused', withDir((dir) => {
  const journal = new FileEgressJournal(dir, clock);
  const session = journal.open(identity());
  assert.deepEqual(session, { sessionId: ID, identity: identity(), state: 'OPEN', openedAt: T, events: [] });
  assert.throws(() => journal.open(identity()), /Duplicate egress session/);
  assert.throws(() => journal.open(identity({ provider: 'openai' })), /Duplicate egress session/);
  for (const bad of [identity({ egressDestinations: [] }), identity({ egressDestinations: ['platform.claude.com:443', 'api.anthropic.com:443'] }),
    identity({ egressDestinations: ['anthropic'] }), identity({ invocationId: 'x' }), { ...identity(), destination: 'api.anthropic.com' }]) {
    assert.throws(() => journal.open({ ...bad, invocationId: bad.invocationId === ID ? OTHER : bad.invocationId }));
  }
  assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.json')), [`${ID}.json`]);
}));
check('events are appended in sequence with bounded fields only; reasons, results, destinations, and addresses must agree', withDir((dir) => {
  const journal = new FileEgressJournal(dir, clock);
  journal.open(identity());
  const events = [
    { result: 'DENIED', reason: 'NOT_ALLOWLISTED', requested: 'statsig.anthropic.com:443' },
    { result: 'CONNECTED', reason: 'ALLOWLISTED', requested: 'api.anthropic.com:443', address: '160.79.104.10' },
    { result: 'CONNECT_FAILED', reason: 'UPSTREAM_UNREACHABLE', requested: 'platform.claude.com:443' },
    { result: 'DENIED', reason: 'NOT_CONNECT', requested: null },
  ];
  events.forEach((event, index) => assert.deepEqual(journal.record(ID, event), { sequence: index + 1, at: T, ...event }));
  assert.deepEqual(summarizeEgress(journal.get(ID)), { sessionId: ID, allowlist: identity().egressDestinations, closed: false, connected: 1, denied: 2, connectFailed: 1 });
  const refused = [
    { result: 'CONNECTED', reason: 'NOT_ALLOWLISTED', requested: 'x.y:443' },
    { result: 'CONNECTED', reason: 'ALLOWLISTED', requested: 'api.anthropic.com:443' },
    { result: 'DENIED', reason: 'NOT_ALLOWLISTED', requested: 'api.anthropic.com:443' },
    { result: 'DENIED', reason: 'NOT_CONNECT', requested: 'api.anthropic.com:443' },
    { result: 'DENIED', reason: 'NOT_ALLOWLISTED', requested: 'API.anthropic.com:443' },
    { result: 'DENIED', reason: 'NOT_ALLOWLISTED', requested: null, address: '1.2.3.4' },
    { result: 'CONNECT_FAILED', reason: 'RESOLUTION_FAILED', requested: 'evil.example:443' },
    { result: 'DENIED', reason: 'MADE_UP', requested: null },
    // A credential-header refusal never names a destination, and is never anything but DENIED.
    { result: 'DENIED', reason: 'CREDENTIAL_HEADER', requested: 'api.anthropic.com:443' },
    { result: 'CONNECT_FAILED', reason: 'CREDENTIAL_HEADER', requested: null },
    { result: 'CONNECTED', reason: 'ALLOWLISTED', requested: 'api.anthropic.com:443', address: 'api.anthropic.com' },
    // Nothing secret-shaped is representable: headers, bodies, tokens, and free text are refused.
    { result: 'DENIED', reason: 'NOT_CONNECT', requested: null, headers: { 'proxy-authorization': 'Basic x' } },
    { result: 'DENIED', reason: 'NOT_CONNECT', requested: null, body: 'x' },
    { result: 'DENIED', reason: 'NOT_CONNECT', requested: null, token: 'sk-x' },
    { result: 'DENIED', reason: 'NOT_CONNECT', requested: null, note: 'free text' },
  ];
  for (const event of refused) assert.throws(() => journal.record(ID, event), EgressJournalIntegrityError, JSON.stringify(event));
  assert.equal(journal.get(ID).events.length, events.length, 'a refused event writes nothing');
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(fileOf(dir), 'utf8')).session.events[1]).sort(), ['address', 'at', 'reason', 'requested', 'result', 'sequence']);
  assert.ok(EGRESS_REASONS.includes('NOT_ALLOWLISTED') && Object.isFrozen(EGRESS_REASONS));
}));
check('close is final: nothing is appended after it and it cannot be closed again', withDir((dir) => {
  const journal = new FileEgressJournal(dir, clock);
  journal.open(identity());
  journal.record(ID, { result: 'CONNECTED', reason: 'ALLOWLISTED', requested: 'api.anthropic.com:443', address: '160.79.104.10' });
  const closed = journal.close(ID);
  assert.deepEqual([closed.state, closed.closedAt], ['CLOSED', T]);
  const before = readFileSync(fileOf(dir), 'utf8');
  assert.throws(() => journal.record(ID, { result: 'DENIED', reason: 'NOT_CONNECT', requested: null }), /closed session is final/);
  assert.throws(() => journal.close(ID), /closed session is final/);
  assert.equal(readFileSync(fileOf(dir), 'utf8'), before);
  assert.throws(() => journal.record(OTHER, { result: 'DENIED', reason: 'NOT_CONNECT', requested: null }), /Unknown egress session/);
}));
check('transitions are append-only: identity, opening, and earlier events never change; one event or one close at a time', () => {
  const base = parseEgressSession({ sessionId: ID, identity: identity(), state: 'OPEN', openedAt: T,
    events: [{ sequence: 1, at: T, result: 'DENIED', reason: 'NOT_CONNECT', requested: null }] });
  const next = (change) => { const copy = structuredClone(base); change(copy); return copy; };
  const add = (session) => session.events.push({ sequence: session.events.length + 1, at: T, result: 'DENIED', reason: 'NOT_CONNECT', requested: null });
  assertEgressTransition(base, next(add));
  assertEgressTransition(base, next((s) => { s.state = 'CLOSED'; s.closedAt = T; }));
  for (const [label, change] of [
    ['identity', (s) => { add(s); s.identity.egressDestinations = ['api.anthropic.com:443']; }],
    ['model', (s) => { add(s); s.identity.model = 'claude-other'; }],
    ['opening', (s) => { add(s); s.openedAt = '2026-09-29T00:00:01.000Z'; }],
    ['mutated event', (s) => { add(s); s.events[0].reason = 'MALFORMED_REQUEST'; }],
    ['removed event', (s) => { s.events = []; }],
    ['two events', (s) => { add(s); add(s); }],
    ['event and close', (s) => { add(s); s.state = 'CLOSED'; s.closedAt = T; }],
    ['nothing', () => undefined],
  ]) assert.throws(() => assertEgressTransition(base, next(change)), EgressJournalIntegrityError, label);
  const closed = next((s) => { s.state = 'CLOSED'; s.closedAt = T; });
  assert.throws(() => assertEgressTransition(closed, next(add)), /final/);
});
check('corruption fails closed: checksum, JSON, envelope, version, reordered or renumbered events, foreign id', withDir((dir) => {
  const journal = new FileEgressJournal(dir, clock);
  journal.open(identity());
  for (const requested of ['a.example:443', 'b.example:443']) journal.record(ID, { result: 'DENIED', reason: 'NOT_ALLOWLISTED', requested });
  const original = readFileSync(fileOf(dir), 'utf8');
  const corrupt = [original.replace('a.example', 'c.example'), '{not json', JSON.stringify({ ...JSON.parse(original), extra: 1 }),
    original.replace('"schemaVersion":1', '"schemaVersion":2')];
  for (const bytes of corrupt) {
    writeFileSync(fileOf(dir), bytes);
    assert.throws(() => journal.get(ID), EgressJournalIntegrityError);
    assert.throws(() => journal.record(ID, { result: 'DENIED', reason: 'NOT_CONNECT', requested: null }), EgressJournalIntegrityError);
  }
  for (const change of [(s) => { s.events.reverse(); }, (s) => { s.events[1].sequence = 3; }, (s) => { s.sessionId = OTHER; },
    (s) => { s.events[0].at = '2026-09-28T00:00:00.000Z'; }, (s) => { s.state = 'CLOSED'; }, (s) => { s.events[0].requested = 'api.anthropic.com:443'; }]) {
    writeFileSync(fileOf(dir), original);
    reseal(dir, change);
    assert.throws(() => journal.get(ID), EgressJournalIntegrityError);
  }
  writeFileSync(fileOf(dir), original);
  assert.equal(journal.get(ID).events.length, 2);
}));
check('persistence is atomic and owner-only; the writer lock is exclusive and a foreign lock is never removed', withDir((dir) => {
  const journal = new FileEgressJournal(dir, clock);
  journal.open(identity());
  const envelope = JSON.parse(readFileSync(fileOf(dir), 'utf8'));
  assert.deepEqual(Object.keys(envelope).sort(), ['checksum', 'schemaVersion', 'session']);
  assert.equal(envelope.checksum, sha256Hex(JSON.stringify(envelope.session)));
  assert.equal(statSync(fileOf(dir)).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.tmp') || name.endsWith('.lock')), []);
  writeFileSync(join(dir, '.egress.lock'), 'another writer');
  assert.throws(() => journal.record(ID, { result: 'DENIED', reason: 'NOT_CONNECT', requested: null }), /EEXIST/);
  assert.equal(readFileSync(join(dir, '.egress.lock'), 'utf8'), 'another writer', 'the foreign lock is left in place');
  assert.equal(journal.get(ID).events.length, 0);
  rmSync(join(dir, '.egress.lock'));
  journal.record(ID, { result: 'DENIED', reason: 'NOT_CONNECT', requested: null });
  writeFileSync(join(dir, `${ID}.json.orphan.tmp`), 'partial');
  assert.equal(journal.get(ID).events.length, 1);
}));

// ---------------------------------------------------------------- broker (loopback only)
/** A local fake provider: echoes bytes and counts connections. */
async function upstream() {
  const server = createServer((socket) => { server.connections += 1; socket.on('data', (chunk) => { server.received.push(chunk); socket.write(chunk); }); socket.on('error', () => undefined); });
  server.connections = 0;
  server.received = [];
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}
const mapResolver = (map, spy = []) => ({ async resolve(hostname) {
  spy.push(hostname);
  if (!(hostname in map)) throw new Error('unknown');
  return [{ address: map[hostname], family: 4 }];
} });
async function broker(dir, { allow, resolver, dialer, limits, journal } = {}) {
  const provider = await upstream();
  const port = provider.address().port;
  const allowlist = allow ?? [`allowed.test:${port}`, `second.test:${port}`];
  const egress = journal ?? new FileEgressJournal(join(dir, 'egress'), clock);
  egress.open(identity({ egressDestinations: allowlist }));
  const resolved = [];
  const running = await ConnectBroker.start({ sessionId: ID, allowlist, journal: egress,
    resolver: resolver ?? mapResolver({ 'allowed.test': '127.0.0.1', 'second.test': '127.0.0.1', 'denied.test': '127.0.0.1', 'sub.allowed.test': '127.0.0.1' }, resolved),
    ...(dialer ? { dialer } : {}), limits: { handshakeTimeoutMs: 2_000, connectTimeoutMs: 2_000, closeGraceMs: 50, ...limits } });
  const stop = async () => { await running.close(); provider.close(); };
  return { broker: running, provider, port, journal: egress, allowlist, resolved, stop, events: () => egress.get(ID).events };
}
/** Sends raw bytes to the broker; resolves with the response head, and a socket for tunnel use. `onFirst` runs synchronously on the first response bytes. */
function send(port, bytes, { onFirst } = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    let text = '';
    let first = true;
    socket.on('data', (chunk) => {
      if (first) { first = false; onFirst?.(); }
      text += chunk.toString('latin1');
      const end = text.indexOf('\r\n\r\n');
      if (end !== -1) { socket.removeAllListeners('data'); resolve({ status: Number(text.split(' ')[1]), head: text.slice(0, end), rest: text.slice(end + 4), socket }); }
    });
    socket.on('error', reject);
    socket.on('close', () => resolve({ status: 0, head: text, rest: '', socket }));
    socket.write(bytes);
  });
}
const connectTo = (authority, headers = '') => `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${headers}\r\n`;
const until = async (predicate, ms = 2_000) => { const end = Date.now() + ms; while (!predicate()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); } };

check('the broker binds 127.0.0.1 only, on an OS-chosen port, and starts only for an open session bound to exactly its allowlist', withDir(async (dir) => {
  const b = await broker(dir);
  try {
    assert.equal(BROKER_BIND_ADDRESS, '127.0.0.1');
    assert.deepEqual([b.broker.address, typeof b.broker.port], ['127.0.0.1', 'number']);
    assert.notEqual(b.broker.port, 0);
    const v6 = await new Promise((resolve) => { const s = connect({ host: '::1', port: b.broker.port }); s.on('connect', () => { s.destroy(); resolve('CONNECTED'); }); s.on('error', (e) => resolve(e.code)); });
    assert.notEqual(v6, 'CONNECTED', 'nothing listens on the IPv6 loopback');
    const egress = new FileEgressJournal(join(dir, 'other'), clock);
    const allowlist = [`allowed.test:${b.port}`];
    await assert.rejects(ConnectBroker.start({ sessionId: ID, allowlist, journal: egress, resolver: mapResolver({}) }), /no open egress session/);
    egress.open(identity({ egressDestinations: allowlist }));
    await assert.rejects(ConnectBroker.start({ sessionId: ID, allowlist: [...allowlist, `second.test:${b.port}`], journal: egress, resolver: mapResolver({}) }), /no open egress session/);
    await assert.rejects(ConnectBroker.start({ sessionId: ID, allowlist: [allowlist[0], allowlist[0]], journal: egress, resolver: mapResolver({}) }), /sorted, duplicate-free/);
    await assert.rejects(ConnectBroker.start({ sessionId: ID, allowlist: ['*.test:443'], journal: egress, resolver: mapResolver({}) }), /canonical/);
    egress.close(ID);
    await assert.rejects(ConnectBroker.start({ sessionId: ID, allowlist, journal: egress, resolver: mapResolver({}) }), /no open egress session/);
  } finally { await b.stop(); }
}));
check('an exact allowlisted host:port is tunnelled end to end: bytes pass unread, CONNECTED names the validated address', withDir(async (dir) => {
  const b = await broker(dir);
  try {
    const opened = await send(b.broker.port, connectTo(`allowed.test:${b.port}`));
    assert.equal(opened.status, 200);
    // Opaque bytes (a fragment shaped like a TLS ClientHello) reach the provider unchanged, and its reply comes back.
    const hello = Buffer.from([0x16, 0x03, 0x01, 0x00, 0x05, 0x01, 0x00, 0x00, 0x01, 0xff]);
    const echoed = await new Promise((resolve) => { opened.socket.once('data', resolve); opened.socket.write(hello); });
    assert.deepEqual([...echoed], [...hello]);
    assert.deepEqual([...Buffer.concat(b.provider.received)], [...hello]);
    opened.socket.destroy();
    assert.deepEqual(b.events(), [{ sequence: 1, at: T, result: 'CONNECTED', reason: 'ALLOWLISTED', requested: `allowed.test:${b.port}`, address: '127.0.0.1' }]);
    assert.equal(b.provider.connections, 1);
  } finally { await b.stop(); }
}));
check('near misses are refused before any upstream connection: wrong port, subdomain, parent domain, other host', withDir(async (dir) => {
  const b = await broker(dir);
  try {
    const misses = [`allowed.test:${b.port + 1 > 65535 ? b.port - 1 : b.port + 1}`, `sub.allowed.test:${b.port}`, `test.test:${b.port}`, `denied.test:${b.port}`, 'allowed.test:443'];
    for (const authority of misses) {
      const reply = await send(b.broker.port, connectTo(authority));
      assert.equal(reply.status, 403, authority);
    }
    assert.deepEqual(b.events().map((event) => [event.result, event.reason, event.requested]), misses.map((authority) => ['DENIED', 'NOT_ALLOWLISTED', authority]));
    assert.deepEqual([b.provider.connections, b.resolved], [0, []], 'nothing was resolved or connected');
  } finally { await b.stop(); }
}));
check('non-canonical, wildcard, scheme, path, userinfo, and mixed-case authorities are refused, the same way every time', withDir(async (dir) => {
  const b = await broker(dir);
  try {
    const refused = ['*.test:443', `*:${b.port}`, `http://allowed.test:${b.port}`, `allowed.test:${b.port}/path`, `user:secret@allowed.test:${b.port}`,
      `ALLOWED.test:${b.port}`, `Allowed.Test:${b.port}`, `allowed.test.:${b.port}`, 'allowed.test', `127.0.0.1:${b.port}`, `[::1]:${b.port}`, `allowed.test:0${b.port}`];
    for (const authority of [...refused, `ALLOWED.test:${b.port}`]) {
      const reply = await send(b.broker.port, connectTo(authority));
      assert.equal(reply.status, 400, authority);
    }
    assert.ok(b.events().every((event) => event.result === 'DENIED' && event.reason === 'NOT_CANONICAL' && event.requested === null));
    assert.equal(b.events().length, refused.length + 1);
    assert.doesNotMatch(readFileSync(fileOf(join(dir, 'egress')), 'utf8'), /secret|user:/, 'no userinfo reaches the journal');
    assert.equal(b.provider.connections, 0);
  } finally { await b.stop(); }
}));
check('only CONNECT is served: forward-proxy requests of every method and malformed requests are refused', withDir(async (dir) => {
  const b = await broker(dir);
  try {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
      assert.equal((await send(b.broker.port, `${method} http://allowed.test:${b.port}/v1/messages HTTP/1.1\r\nHost: allowed.test\r\n\r\n`)).status, 405, method);
    }
    assert.equal((await send(b.broker.port, `GET / HTTP/1.1\r\nHost: allowed.test:${b.port}\r\n\r\n`)).status, 405, 'origin-form');
    for (const malformed of [`CONNECT allowed.test:${b.port}\r\n\r\n`, `CONNECT allowed.test:${b.port} HTTP/2\r\n\r\n`, `connect allowed.test:${b.port} HTTP/1.1\r\n\r\n`,
      `CONNECT  allowed.test:${b.port} HTTP/1.1\r\n\r\n`, `CONNECT allowed.test:${b.port} HTTP/1.1\r\nbad header line\r\n\r\n`, 'garbage\r\n\r\n',
      `CONNECT allowed.test:${b.port} HTTP/1.1\r\nX: \u0001\r\n\r\n`]) {
      assert.equal((await send(b.broker.port, malformed)).status, 400, JSON.stringify(malformed));
    }
    // A request cut off before its head ends is malformed, not silent.
    const cut = connect({ host: '127.0.0.1', port: b.broker.port });
    cut.on('error', () => undefined);
    cut.end(`CONNECT allowed.test:${b.port} HTTP/1.1\r\n`);
    await until(() => b.events().length === 16);
    const reasons = b.events().map((event) => event.reason);
    assert.deepEqual([reasons.filter((r) => r === 'NOT_CONNECT').length, reasons.filter((r) => r === 'MALFORMED_REQUEST').length], [8, 8]);
    assert.equal(b.provider.connections, 0);
  } finally { await b.stop(); }
}));
check('an oversized head, a silent client, and too many connections are bounded and refused', withDir(async (dir) => {
  const b = await broker(dir, { limits: { maxHeaderBytes: 512, handshakeTimeoutMs: 200 } });
  try {
    const big = await send(b.broker.port, `CONNECT allowed.test:${b.port} HTTP/1.1\r\nX-Pad: ${'a'.repeat(600)}\r\n\r\n`);
    assert.equal(big.status, 431);
    big.socket.destroy();
    const started = Date.now();
    const silent = await send(b.broker.port, '');
    assert.equal(silent.status, 408);
    silent.socket.destroy();
    assert.ok(Date.now() - started < 1_500, 'the handshake is bounded');
    assert.deepEqual(b.events().map((event) => event.reason), ['HEADER_LIMIT', 'HANDSHAKE_TIMEOUT']);
    assert.equal(b.provider.connections, 0);
  } finally { await b.stop(); }
  const c = await broker(join(dir, 'limit'), { limits: { maxConnections: 2, handshakeTimeoutMs: 10_000 } });
  const idle = [connect({ host: '127.0.0.1', port: c.broker.port }), connect({ host: '127.0.0.1', port: c.broker.port })];
  try {
    await Promise.all(idle.map((socket) => new Promise((resolve) => socket.once('connect', resolve))));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const third = await send(c.broker.port, connectTo(`allowed.test:${c.port}`));
    assert.equal(third.status, 503);
    third.socket.destroy();
    assert.deepEqual(c.events().map((event) => [event.result, event.reason]), [['DENIED', 'CONNECTION_LIMIT']]);
    assert.equal(c.provider.connections, 0);
  } finally { idle.forEach((socket) => socket.destroy()); await c.stop(); }
}));
check('a refusal is durable before the client hears it; CONNECTED exists only after the upstream socket does', withDir(async (dir) => {
  let atDial;
  const journalRef = {};
  const dialer = { async dial(address, port, timeoutMs) {
    atDial = journalRef.journal.get(ID).events.map((event) => event.result);
    return new TcpDialer().dial(address, port, timeoutMs);
  } };
  const b = await broker(dir, { dialer, journal: (journalRef.journal = new FileEgressJournal(join(dir, 'egress'), clock)) });
  try {
    let seenAtResponse;
    const denied = await send(b.broker.port, connectTo(`denied.test:${b.port}`), { onFirst: () => { seenAtResponse = b.events().map((event) => event.reason); } });
    assert.equal(denied.status, 403);
    assert.deepEqual(seenAtResponse, ['NOT_ALLOWLISTED'], 'DENIED was on disk when the first response byte arrived');
    let connectedAtResponse;
    const ok = await send(b.broker.port, connectTo(`allowed.test:${b.port}`), { onFirst: () => { connectedAtResponse = b.events().at(-1); } });
    assert.equal(ok.status, 200);
    ok.socket.destroy();
    assert.deepEqual(atDial, ['DENIED'], 'no CONNECTED before the dial');
    assert.equal(connectedAtResponse.result, 'CONNECTED', 'CONNECTED was on disk before the 200');
  } finally { await b.stop(); }
  // An allowlisted destination whose upstream refuses: CONNECT_FAILED, never CONNECTED.
  const closed = await upstream();
  const deadPort = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  const c = await broker(join(dir, 'dead'), { allow: [`allowed.test:${deadPort}`] });
  try {
    assert.equal((await send(c.broker.port, connectTo(`allowed.test:${deadPort}`))).status, 502);
    assert.deepEqual(c.events().map((event) => [event.result, event.reason]), [['CONNECT_FAILED', 'UPSTREAM_UNREACHABLE']]);
  } finally { await c.stop(); }
}));
check('resolution is bounded; a failed or hung resolution is CONNECT_FAILED and connects nothing', withDir(async (dir) => {
  const hung = { resolve: () => new Promise(() => undefined) };
  const b = await broker(dir, { resolver: hung, limits: { connectTimeoutMs: 200 } });
  try {
    const started = Date.now();
    assert.equal((await send(b.broker.port, connectTo(`allowed.test:${b.port}`))).status, 502);
    assert.ok(Date.now() - started < 1_500);
    assert.deepEqual(b.events().map((event) => [event.result, event.reason]), [['CONNECT_FAILED', 'RESOLUTION_FAILED']]);
    assert.equal(b.provider.connections, 0);
  } finally { await b.stop(); }
}));
check('ordinary bounded CONNECT headers are accepted and stored nowhere; tunnel bytes are never read as headers', withDir(async (dir) => {
  const b = await broker(dir);
  try {
    const headers = 'User-Agent: UA-SENTINEL/1.0\r\nProxy-Connection: Keep-Alive\r\n';
    const ok = await send(b.broker.port, connectTo(`allowed.test:${b.port}`, headers));
    assert.equal(ok.status, 200);
    // After the 200 the stream is the client's: header-shaped bytes inside the tunnel are opaque payload.
    ok.socket.write('Authorization: Bearer TUNNEL-SENTINEL\r\n');
    await until(() => Buffer.concat(b.provider.received).includes('TUNNEL-SENTINEL'));
    ok.socket.destroy();
    assert.deepEqual(b.events().map((event) => [event.result, event.reason]), [['CONNECTED', 'ALLOWLISTED']]);
    const stored = readdirSync(join(dir, 'egress')).map((name) => readFileSync(join(dir, 'egress', name), 'utf8')).join('\n');
    assert.doesNotMatch(stored, /UA-SENTINEL|TUNNEL-SENTINEL|Keep-Alive|Bearer|user-agent|proxy-connection|authorization/i);
    for (const event of b.events()) assert.deepEqual(Object.keys(event).filter((key) => !['sequence', 'at', 'result', 'reason', 'requested', 'address'].includes(key)), []);
  } finally { await b.stop(); }
}));
check('G1-R3C-C1: a CONNECT head with a credential-shaped header is DENIED whole; the value is stored, answered, and resolved nowhere', withDir(async (dir) => {
  const b = await broker(dir);
  const cases = [
    'Authorization: Bearer sk-ant-AUTH-SENTINEL', 'Proxy-Authorization: Basic UFJPWFktU0VOVElORUw=', 'Cookie: session=COOKIE-SENTINEL',
    'aUtHoRiZaTiOn: Bearer MIXED-SENTINEL', 'PROXY-AUTHORIZATION: Basic UPPER-SENTINEL', 'cookie:LOWER-SENTINEL',
    'X-Api-Key: sk-ant-KEY-SENTINEL', 'api-key: AZURE-SENTINEL',
  ];
  try {
    const answers = [];
    for (const [index, header] of cases.entries()) {
      // Allowlisted and outside destinations alike: the credential check comes before any destination decision.
      for (const authority of [`allowed.test:${b.port}`, `denied.test:${b.port}`]) {
        const refused = await send(b.broker.port, connectTo(authority, `User-Agent: ua\r\n${header}\r\n`));
        assert.equal(refused.status, 400, `${index} ${authority}`);
        answers.push(refused.head, refused.rest);
        refused.socket.destroy();
      }
    }
    assert.deepEqual(b.events().map((event) => [event.result, event.reason, event.requested]),
      cases.flatMap(() => [['DENIED', 'CREDENTIAL_HEADER', null], ['DENIED', 'CREDENTIAL_HEADER', null]]));
    assert.deepEqual([b.provider.connections, b.resolved.length, b.broker.faults], [0, 0, 0], 'nothing was resolved or connected');
    const stored = readdirSync(join(dir, 'egress')).map((name) => readFileSync(join(dir, 'egress', name), 'utf8')).join('\n');
    const secrets = /SENTINEL|UFJPWFkt|sk-ant|Bearer|Basic|session=|authorization|cookie|api-key/i;
    assert.doesNotMatch(stored, secrets, 'the egress journal holds no header name or value');
    assert.doesNotMatch(answers.join('\n'), secrets, 'the refusal the client hears names nothing it sent');
    assert.doesNotMatch(JSON.stringify(summarizeEgress(b.journal.get(ID))), secrets, 'the evidence summary names nothing it sent');
  } finally { await b.stop(); }
  // The same refusal as a pure check: names only, any case, never values.
  assert.ok(hasCredentialHeader(['Host: a.b:443', 'Cookie: x']) && hasCredentialHeader(['PROXY-AUTHORIZATION: x']) && hasCredentialHeader(['authorization:']));
  assert.ok(!hasCredentialHeader(['Host: a.b:443', 'User-Agent: authorization cookie', 'Proxy-Connection: Keep-Alive', 'X-Authorization-Hint: 1']));
}));
check('G1-R3C-C1: the head accumulator never holds more than maxHeaderBytes, however large a single chunk is', () => {
  const max = DEFAULT_BROKER_LIMITS.maxHeaderBytes;
  const huge = Buffer.alloc(1024 * 1024, 0x61);
  const flood = new HeadAccumulator(max);
  assert.deepEqual(flood.push(huge), { kind: 'limit' });
  assert.equal(flood.retained, max, 'a 1 MiB chunk leaves exactly the bound held, not the chunk');
  // A complete head followed, in the same chunk, by a large payload: the payload is handed back, not held.
  const head = Buffer.from('CONNECT allowed.test:443 HTTP/1.1\r\nHost: allowed.test:443\r\n\r\n');
  const piped = new HeadAccumulator(max);
  const step = piped.push(Buffer.concat([head, huge]));
  assert.equal(step.kind, 'head');
  assert.equal(step.head, 'CONNECT allowed.test:443 HTTP/1.1\r\nHost: allowed.test:443');
  assert.equal(step.rest.length, huge.length);
  assert.ok(piped.retained <= max, `held ${piped.retained}`);
  // The terminator may be split across chunks; one byte at a time still finds it, and still within the bound.
  const bytewise = new HeadAccumulator(max);
  let last;
  for (const byte of head) last = bytewise.push(Buffer.from([byte]));
  assert.deepEqual([last.kind, last.head, last.rest.length], ['head', step.head, 0]);
  // A head that ends exactly at the bound is read; one byte more is HEADER_LIMIT.
  const exact = (size) => Buffer.from(`CONNECT a.b:1 HTTP/1.1\r\nX: ${'p'.repeat(size - 'CONNECT a.b:1 HTTP/1.1\r\nX: \r\n\r\n'.length)}\r\n\r\n`);
  assert.equal(exact(64).length, 64);
  assert.equal(new HeadAccumulator(64).push(exact(64)).kind, 'head');
  const over = new HeadAccumulator(64);
  assert.deepEqual([over.push(exact(65)).kind, over.retained], ['limit', 64]);
  for (const bad of [0, 3, 1.5, Number.NaN, -1]) assert.throws(() => new HeadAccumulator(bad), RangeError, String(bad));
});
check('G1-R3C-C1: through the broker, one oversized write is HEADER_LIMIT with no content in the refusal', withDir(async (dir) => {
  const b = await broker(dir, { limits: { maxHeaderBytes: 512 } });
  try {
    const flood = await send(b.broker.port, `CONNECT allowed.test:${b.port} HTTP/1.1\r\nX-Pad: ${'FLOOD-SENTINEL'.repeat(80_000)}\r\n\r\n`);
    assert.equal(flood.status, 431);
    assert.doesNotMatch(flood.head + flood.rest, /FLOOD-SENTINEL|allowed\.test/);
    flood.socket.destroy();
    assert.deepEqual(b.events().map((event) => [event.result, event.reason, event.requested]), [['DENIED', 'HEADER_LIMIT', null]]);
    assert.deepEqual([b.provider.connections, b.resolved.length], [0, 0]);
  } finally { await b.stop(); }
}));
check('G1-R3C-C1: bytes sent in the same write as the CONNECT head reach the provider after the 200, unchanged', withDir(async (dir) => {
  const b = await broker(dir);
  try {
    const hello = Buffer.from([0x16, 0x03, 0x01, 0x02, 0x00, 0x01, 0x00, 0x01, 0xfc, 0x03, 0x03, 0x0d, 0x0a, 0x0d, 0x0a, 0xff]);
    const opened = await send(b.broker.port, Buffer.concat([Buffer.from(connectTo(`allowed.test:${b.port}`)), hello]));
    assert.equal(opened.status, 200);
    await until(() => Buffer.concat(b.provider.received).length >= hello.length);
    assert.deepEqual([...Buffer.concat(b.provider.received)], [...hello], 'the provider received exactly the pipelined bytes, once');
    opened.socket.destroy();
    assert.deepEqual(b.events().map((event) => event.reason), ['ALLOWLISTED']);
  } finally { await b.stop(); }
}));
check('G1-R3C-C1: each actor\'s broker admits only that actor\'s set; the other actor\'s destinations and the union are refused', withDir(async (dir) => {
  const provider = await upstream();
  const port = provider.address().port;
  const sets = { IMPLEMENTATION: [`api.impl.test:${port}`, `platform.impl.test:${port}`], ARCHITECT_REVIEW: [`auth.review.test:${port}`, `chat.review.test:${port}`] };
  const union = [...sets.IMPLEMENTATION, ...sets.ARCHITECT_REVIEW].sort();
  const names = Object.fromEntries(union.map((authority) => [authority.slice(0, authority.lastIndexOf(':')), '127.0.0.1']));
  const journal = new FileEgressJournal(join(dir, 'egress'), clock);
  const brokers = {};
  try {
    for (const [kind, id] of [['IMPLEMENTATION', ID], ['ARCHITECT_REVIEW', OTHER]]) {
      journal.open(identity({ invocationId: id, egressDestinations: sets[kind] }));
      await assert.rejects(ConnectBroker.start({ sessionId: id, allowlist: union, journal, resolver: mapResolver(names) }), /no open egress session/, `${kind}: union`);
      brokers[kind] = await ConnectBroker.start({ sessionId: id, allowlist: sets[kind], journal, resolver: mapResolver(names),
        limits: { closeGraceMs: 50 } });
    }
    for (const [kind, other] of [['IMPLEMENTATION', 'ARCHITECT_REVIEW'], ['ARCHITECT_REVIEW', 'IMPLEMENTATION']]) {
      for (const authority of sets[other]) {
        const refused = await send(brokers[kind].port, connectTo(authority));
        assert.equal(refused.status, 403, `${kind} broker, ${authority}`);
        refused.socket.destroy();
      }
      const own = await send(brokers[kind].port, connectTo(sets[kind][0]));
      assert.equal(own.status, 200, `${kind} broker, own destination`);
      own.socket.destroy();
    }
    assert.equal(provider.connections, 2, 'one connection per actor, each to its own destination');
    for (const [kind, id, other] of [['IMPLEMENTATION', ID, 'ARCHITECT_REVIEW'], ['ARCHITECT_REVIEW', OTHER, 'IMPLEMENTATION']]) {
      assert.deepEqual(journal.get(id).events.map((event) => [event.result, event.requested]),
        [...sets[other].map((authority) => ['DENIED', authority]), ['CONNECTED', sets[kind][0]]], kind);
    }
  } finally {
    for (const running of Object.values(brokers)) await running.close();
    provider.close();
  }
}));
check('closing stops new connections, closes open tunnels, and settles every decision before the session is closed', withDir(async (dir) => {
  const b = await broker(dir);
  try {
    const tunnel = await send(b.broker.port, connectTo(`allowed.test:${b.port}`));
    assert.equal(tunnel.status, 200);
    const closed = new Promise((resolve) => tunnel.socket.once('close', resolve));
    await b.broker.close();
    await closed;
    const late = await new Promise((resolve) => { const s = connect({ host: '127.0.0.1', port: b.broker.port }); s.on('connect', () => { s.destroy(); resolve('CONNECTED'); }); s.on('error', (e) => resolve(e.code)); });
    assert.equal(late, 'ECONNREFUSED');
    assert.equal(b.broker.faults, 0);
    b.journal.close(ID);
    assert.deepEqual(summarizeEgress(b.journal.get(ID)), { sessionId: ID, allowlist: b.allowlist, closed: true, connected: 1, denied: 0, connectFailed: 0 });
  } finally { await b.stop(); }
}));
check('an evidence write that fails is a fault: the client gets nothing and nothing is connected', withDir(async (dir) => {
  const inner = new FileEgressJournal(join(dir, 'egress'), clock);
  const failing = { open: (x) => inner.open(x), get: (x) => inner.get(x), close: (x) => inner.close(x), record() { throw new Error('disk full'); } };
  const b = await broker(dir, { journal: failing });
  try {
    for (const authority of [`denied.test:${b.port}`, `allowed.test:${b.port}`]) {
      const reply = await send(b.broker.port, connectTo(authority));
      assert.equal(reply.status, 0, `${authority}: the connection is dropped without an answer`);
    }
    assert.equal(b.broker.faults, 2);
    await until(() => b.provider.connections <= 1);
  } finally { await b.stop(); }
}));

// ---------------------------------------------------------------- SSRF: the production resolver policy
check('refused address classes: loopback, unspecified, private, shared, link-local, metadata, multicast, broadcast, IPv6 local and embedded forms', () => {
  const refused = ['127.0.0.1', '127.255.255.254', '0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.254', '192.168.0.1', '192.168.255.255',
    '169.254.0.1', '169.254.169.254', '100.64.0.1', '100.127.255.254', '100.100.100.200', '224.0.0.1', '239.255.255.250', '255.255.255.255', '240.0.0.1',
    '192.0.0.192', '198.18.0.1', '::1', '::', 'fc00::1', 'fd00:ec2::254', 'fdff::1', 'fe80::1', 'febf::1', 'ff02::1', 'ff0e::1', '::ffff:127.0.0.1',
    '::ffff:10.0.0.1', '::ffff:169.254.169.254', '64:ff9b::a9fe:a9fe', '2002:a9fe:a9fe::1', '::127.0.0.1', 'localhost', 'api.anthropic.com', '', '1.2.3'];
  for (const address of refused) assert.equal(isPublicAddress(address), false, address);
  // Public values are checked as policy values only; nothing connects to them.
  for (const address of ['160.79.104.10', '104.18.32.47', '8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e']) {
    assert.equal(isPublicAddress(address), true, address);
  }
});
check('the production resolver refuses a name with any unsafe answer, before anything connects', async () => {
  const lookups = [];
  const lookup = (answers) => async (hostname) => { lookups.push(hostname); return answers; };
  await assert.rejects(new PublicAddressResolver({ lookup: lookup([{ address: '10.0.0.1', family: 4 }]) }).resolve('api.anthropic.com'), UnsafeAddressError);
  await assert.rejects(new PublicAddressResolver({ lookup: lookup([{ address: '160.79.104.10', family: 4 }, { address: '169.254.169.254', family: 4 }]) })
    .resolve('api.anthropic.com'), UnsafeAddressError, 'one unsafe answer among public ones refuses the name');
  await assert.rejects(new PublicAddressResolver({ lookup: lookup([]) }).resolve('api.anthropic.com'), /no address/);
  const before = lookups.length;
  await assert.rejects(new PublicAddressResolver({ lookup: lookup([{ address: '160.79.104.10', family: 4 }]) }).resolve('API.anthropic.com'), /canonical/);
  assert.equal(lookups.length, before, 'a non-canonical name is never looked up');
  assert.deepEqual(await new PublicAddressResolver({ lookup: lookup([{ address: '160.79.104.10', family: 4 }, { address: '2606:4700::1', family: 6 }]) })
    .resolve('api.anthropic.com'), [{ address: '160.79.104.10', family: 4 }, { address: '2606:4700::1', family: 6 }]);
});
check('through the broker: a name resolving to a refused address is DENIED and never dialled; the dial uses the validated address without resolving again', withDir(async (dir) => {
  const dials = [];
  const spyDialer = { async dial(address, port, timeoutMs) { dials.push(address.address); return new TcpDialer().dial(address, port, timeoutMs); } };
  const lookups = [];
  const rebinding = new PublicAddressResolver({ lookup: async (hostname) => { lookups.push(hostname); return [{ address: '127.0.0.1', family: 4 }]; } });
  const b = await broker(dir, { resolver: rebinding, dialer: spyDialer });
  try {
    assert.equal((await send(b.broker.port, connectTo(`allowed.test:${b.port}`))).status, 403);
    assert.deepEqual(b.events().map((event) => [event.result, event.reason, event.requested]), [['DENIED', 'UNSAFE_ADDRESS', `allowed.test:${b.port}`]]);
    assert.deepEqual([dials, lookups, b.provider.connections], [[], ['allowed.test'], 0]);
  } finally { await b.stop(); }
  // A test mapping (never production) reaches the local fake provider; the dialer gets exactly the resolved address, once.
  const resolved = [];
  const c = await broker(join(dir, 'c'), { resolver: mapResolver({ 'allowed.test': '127.0.0.1' }, resolved), dialer: spyDialer });
  try {
    const opened = await send(c.broker.port, connectTo(`allowed.test:${c.port}`));
    assert.equal(opened.status, 200);
    opened.socket.destroy();
    assert.deepEqual([resolved, dials], [['allowed.test'], ['127.0.0.1']]);
  } finally { await c.stop(); }
  await assert.rejects(new TcpDialer().dial({ address: 'allowed.test', family: 4 }, 443, 100), /not an IP address/);
}));
check('the broker source terminates no TLS and reads no credential', () => {
  // Code only: comments may say what the broker never does. The one place credential header
  // names appear is the fixed set of names whose presence refuses a head.
  const code = readFileSync('src/automation/live/connect-broker.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const refusal = /const CREDENTIAL_HEADERS = new Set\(\[[^\]]*\]\);/;
  assert.match(code, refusal);
  const source = code.replace(refusal, '');
  assert.doesNotMatch(source, /node:tls|node:https|node:http['"]|createSecureContext|TLSSocket|certificate|\.pem|authorization|cookie|api-key/i);
  assert.doesNotMatch(source, /console\.|process\.env|process\.stdout|readFileSync|writeFileSync/);
});

let passed = 0, failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`  PASS ${name}`); passed++; }
  catch (error) { console.error(`  FAIL ${name}: ${error.stack}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
