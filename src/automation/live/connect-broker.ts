import { promises as dns } from 'node:dns';
import { BlockList, connect, createServer, isIP, type AddressInfo, type Server, type Socket } from 'node:net';
import { isCanonicalEgressDestination, parseEgressSet, sameEgressSet } from '../egress-destination.js';
import type { EgressEventInput, EgressJournal, EgressReason } from '../egress-journal.js';

// The invocation-scoped egress broker. It listens on 127.0.0.1 only, on a port the
// operating system picks, and accepts exactly one kind of request: HTTP CONNECT to a
// canonical hostname:port on the invocation's exact allowlist. Everything else is
// refused. It is a TCP tunnel: after the 200 it copies bytes both ways without reading
// them, so TLS stays end to end between the model CLI and the provider, and no
// certificate, plaintext, header value, or credential is ever held here.
//
// Every decision is written to the egress journal before the client hears it: a refusal
// is recorded durably before the refusal is sent, and CONNECTED is recorded only once the
// upstream socket exists. The hostname is resolved here, the addresses are checked, and
// the tunnel connects to a checked address; it is never resolved again, so a later DNS
// answer cannot redirect it.

export const BROKER_BIND_ADDRESS = '127.0.0.1';

export interface BrokerLimits {
  /** Bytes of request line and headers read before the request is refused. */
  maxHeaderBytes: number;
  /** Time from accept to a complete request head. */
  handshakeTimeoutMs: number;
  /** Time for resolution, and again for each upstream connection attempt. */
  connectTimeoutMs: number;
  /** Concurrent client connections, handshaking or tunnelled. */
  maxConnections: number;
  /** Time open tunnels get to drain once the broker is closing. */
  closeGraceMs: number;
}
export const DEFAULT_BROKER_LIMITS: Readonly<BrokerLimits> = Object.freeze({ maxHeaderBytes: 8192, handshakeTimeoutMs: 10_000,
  connectTimeoutMs: 15_000, maxConnections: 32, closeGraceMs: 2_000 });

export interface ResolvedAddress { address: string; family: 4 | 6 }
/** Resolves one allowlisted hostname to addresses the broker may connect to. Throws UnsafeAddressError for an address it must not. */
export interface EgressResolver { resolve(hostname: string): Promise<ResolvedAddress[]> }
/** Opens one TCP connection to an IP address. */
export interface EgressDialer { dial(address: ResolvedAddress, port: number, timeoutMs: number): Promise<Socket> }

export class UnsafeAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeAddressError';
  }
}

// Address space a public provider hostname must never resolve into: this host, private
// and shared networks, link-local (including cloud metadata at 169.254.169.254),
// multicast, broadcast, reserved, and IPv6 forms that embed or translate an IPv4 address.
// One list per family: a BlockList matches IPv4 against IPv4-mapped IPv6 rules, so a
// shared list would let `::ffff:0:0/96` swallow every IPv4 address.
const REFUSED_V4 = new BlockList();
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) REFUSED_V4.addSubnet(network, prefix, 'ipv4');
const REFUSED_V6 = new BlockList();
for (const [network, prefix] of [['::', 96], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]] as const) REFUSED_V6.addSubnet(network, prefix, 'ipv6');
REFUSED_V6.addAddress('::1', 'ipv6');

/** Whether an IP address is one a provider hostname may resolve to. Anything that is not an IP literal is not. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !REFUSED_V4.check(address, 'ipv4');
  if (family === 6) return !REFUSED_V6.check(address, 'ipv6');
  return false;
}

type Lookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

/**
 * The production resolver. Every answer must be a public address; one unsafe answer
 * refuses the name, since which of several answers a connection would use is not a
 * choice to leave to chance. `lookup` is injectable for tests only.
 */
export class PublicAddressResolver implements EgressResolver {
  readonly #lookup: Lookup;
  constructor(dependencies: { lookup?: Lookup } = {}) {
    this.#lookup = dependencies.lookup ?? ((hostname) => dns.lookup(hostname, { all: true, verbatim: true }));
    Object.freeze(this);
  }
  async resolve(hostname: string): Promise<ResolvedAddress[]> {
    if (!isCanonicalEgressDestination(`${hostname}:1`)) throw new Error('not a canonical hostname');
    const answers = await this.#lookup(hostname);
    if (!Array.isArray(answers) || answers.length === 0) throw new Error('no address');
    const unsafe = answers.find((answer) => !isPublicAddress(answer?.address));
    if (unsafe) throw new UnsafeAddressError(`${hostname} resolves to a refused address`);
    return answers.map((answer) => ({ address: answer.address, family: isIP(answer.address) as 4 | 6 }));
  }
}
Object.freeze(PublicAddressResolver);
Object.freeze(PublicAddressResolver.prototype);

/** The production dialer: a TCP connection to an IP literal, so nothing is resolved again. */
export class TcpDialer implements EgressDialer {
  constructor() { Object.freeze(this); }
  dial(target: ResolvedAddress, port: number, timeoutMs: number): Promise<Socket> {
    return new Promise((resolve, reject) => {
      if (isIP(target.address) === 0) { reject(new Error('dial target is not an IP address')); return; }
      const socket = connect({ host: target.address, port, family: isIP(target.address) });
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('connect timeout')); }, timeoutMs);
      socket.once('connect', () => { clearTimeout(timer); socket.removeAllListeners('error'); resolve(socket); });
      socket.once('error', (error) => { clearTimeout(timer); socket.destroy(); reject(error); });
    });
  }
}
Object.freeze(TcpDialer);
Object.freeze(TcpDialer.prototype);

const STATUS: Readonly<Record<number, string>> = Object.freeze({ 400: 'Bad Request', 403: 'Forbidden', 405: 'Method Not Allowed',
  408: 'Request Timeout', 431: 'Request Header Fields Too Large', 502: 'Bad Gateway', 503: 'Service Unavailable' });
const REQUEST_LINE = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/;
const HEADER_LINE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+:[\t ]*[\x20-\x7e\t]*$/;

// Plaintext proxy-head fields that carry credentials. The broker needs none of them, and a
// head bearing one is refused whole; the header's name and value are never kept anywhere.
const CREDENTIAL_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'x-api-key', 'api-key']);

/** Whether any header line of a parsed CONNECT head names a credential-shaped field. */
export function hasCredentialHeader(headers: readonly string[]): boolean {
  return headers.some((header) => CREDENTIAL_HEADERS.has(header.slice(0, header.indexOf(':')).toLowerCase()));
}

export type HeadStep = { kind: 'more' } | { kind: 'head'; head: string; rest: Buffer } | { kind: 'limit' };

/**
 * Accumulates one request head without ever retaining more than `maxHeaderBytes` of it,
 * however large a single chunk is: bytes past the bound are never copied, and bytes past
 * the end of the head are handed back as `rest` (tunnel payload), not kept here.
 */
export class HeadAccumulator {
  readonly #max: number;
  #held: Buffer = Buffer.alloc(0);

  constructor(maxHeaderBytes: number) {
    if (!Number.isSafeInteger(maxHeaderBytes) || maxHeaderBytes < 4) throw new RangeError('maxHeaderBytes must be an integer of at least 4');
    this.#max = maxHeaderBytes;
  }

  /** The head bytes held so far; never more than maxHeaderBytes. */
  get retained(): number { return this.#held.length; }

  push(chunk: Buffer): HeadStep {
    const before = this.#held.length;
    const taken = chunk.subarray(0, this.#max - before);
    this.#held = Buffer.concat([this.#held, taken]);
    const end = this.#held.indexOf('\r\n\r\n', Math.max(0, before - 3));
    if (end !== -1) return { kind: 'head', head: this.#held.subarray(0, end).toString('latin1'), rest: chunk.subarray(end + 4 - before) };
    return this.#held.length >= this.#max ? { kind: 'limit' } : { kind: 'more' };
  }
}

type Head = { kind: 'head'; head: string } | { kind: 'refused'; reason: EgressReason; status: number } | { kind: 'silent' };

/**
 * Reads one request head from a fresh client connection, within the byte and time bounds.
 * Bytes the client sent past the head go back onto the socket, unread and unchanged.
 */
function readHead(socket: Socket, limits: BrokerLimits): Promise<Head> {
  return new Promise((resolve) => {
    const accumulator = new HeadAccumulator(limits.maxHeaderBytes);
    let bytes = 0;
    const done = (head: Head) => {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('end', onEnd);
      socket.removeListener('close', onEnd);
      socket.pause();
      resolve(head);
    };
    const onData = (chunk: Buffer) => {
      bytes += chunk.length;
      const step = accumulator.push(chunk);
      if (step.kind === 'head') {
        done({ kind: 'head', head: step.head });
        if (step.rest.length) socket.unshift(step.rest);
      } else if (step.kind === 'limit') done({ kind: 'refused', reason: 'HEADER_LIMIT', status: 431 });
    };
    const onEnd = () => done(bytes === 0 ? { kind: 'silent' } : { kind: 'refused', reason: 'MALFORMED_REQUEST', status: 400 });
    const timer = setTimeout(() => done({ kind: 'refused', reason: 'HANDSHAKE_TIMEOUT', status: 408 }), limits.handshakeTimeoutMs);
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('close', onEnd);
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); })])
    .finally(() => clearTimeout(timer));
}

export class ConnectBroker {
  readonly #server: Server;
  readonly #bound: AddressInfo;
  readonly #sessionId: string;
  readonly #allow: ReadonlySet<string>;
  readonly #journal: EgressJournal;
  readonly #resolver: EgressResolver;
  readonly #dialer: EgressDialer;
  readonly #limits: BrokerLimits;
  readonly #clients = new Set<Socket>();
  readonly #upstreams = new Set<Socket>();
  readonly #pending = new Set<Promise<void>>();
  #closing = false;
  #faults = 0;

  private constructor(server: Server, bound: AddressInfo, input: { sessionId: string; allowlist: readonly string[]; journal: EgressJournal;
    resolver: EgressResolver; dialer: EgressDialer; limits: BrokerLimits }) {
    this.#server = server;
    this.#bound = Object.freeze({ ...bound });
    this.#sessionId = input.sessionId;
    this.#allow = new Set(input.allowlist);
    this.#journal = input.journal;
    this.#resolver = input.resolver;
    this.#dialer = input.dialer;
    this.#limits = input.limits;
    server.on('connection', (socket) => this.#accept(socket));
  }

  /**
   * Starts a broker for one open egress session whose authorized set is exactly
   * `allowlist`. It listens on 127.0.0.1 and nowhere else; if that cannot be proven, it
   * does not start.
   */
  static async start(input: { sessionId: string; allowlist: readonly string[]; journal: EgressJournal; resolver: EgressResolver;
    dialer?: EgressDialer; limits?: Partial<BrokerLimits> }): Promise<ConnectBroker> {
    const allowlist = parseEgressSet(input.allowlist);
    const session = input.journal.get(input.sessionId);
    if (!session || session.state !== 'OPEN' || !sameEgressSet(session.identity.egressDestinations, allowlist)) {
      throw new Error('Egress broker refuses: no open egress session binds exactly this allowlist');
    }
    if (typeof input.resolver?.resolve !== 'function') throw new Error('Egress broker requires a resolver');
    const limits = { ...DEFAULT_BROKER_LIMITS, ...input.limits };
    for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Egress broker limits must be positive integers');
    const server = createServer({ pauseOnConnect: false, allowHalfOpen: false });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: BROKER_BIND_ADDRESS, port: 0, exclusive: true }, () => { server.removeListener('error', reject); resolve(); });
    });
    const bound = server.address() as AddressInfo | null;
    if (!bound || bound.address !== BROKER_BIND_ADDRESS || bound.family !== 'IPv4') {
      server.close();
      throw new Error('Egress broker did not bind 127.0.0.1 only');
    }
    return new ConnectBroker(server, bound, { sessionId: input.sessionId, allowlist, journal: input.journal, resolver: input.resolver,
      dialer: input.dialer ?? new TcpDialer(), limits });
  }

  /** The address and port it actually bound at start; after close, where it listened. */
  get port(): number { return this.#bound.port; }
  get address(): string { return this.#bound.address; }
  /** Connections whose evidence could not be written, or that did not settle while closing. Any fault makes the session's record incomplete. */
  get faults(): number { return this.#faults; }

  /** New connections are refused by the operating system from now on. */
  stopAccepting(): void {
    this.#closing = true;
    if (this.#server.listening) this.#server.close();
  }

  /** Stops accepting, lets open tunnels drain for the grace period, closes the rest, and waits for every decision to settle. */
  async close(): Promise<void> {
    this.stopAccepting();
    const settle = (ms: number) => Promise.race([Promise.allSettled([...this.#pending]), new Promise((resolve) => setTimeout(resolve, ms))]);
    await settle(this.#limits.closeGraceMs);
    for (const socket of [...this.#clients, ...this.#upstreams]) socket.destroy();
    await settle(this.#limits.connectTimeoutMs);
    if (this.#pending.size > 0) this.#faults += this.#pending.size;
  }

  #accept(client: Socket): void {
    if (this.#closing) { client.destroy(); return; }
    if (this.#clients.size >= this.#limits.maxConnections) {
      this.#refuse(client, { result: 'DENIED', reason: 'CONNECTION_LIMIT', requested: null }, 503);
      return;
    }
    this.#clients.add(client);
    client.on('error', () => undefined);
    client.once('close', () => this.#clients.delete(client));
    const task = this.#handshake(client).catch(() => { this.#faults += 1; client.destroy(); });
    this.#pending.add(task);
    void task.finally(() => this.#pending.delete(task));
  }

  /** Durable evidence first; the client hears nothing until it is written. A failed write is a fault and the connection is dropped. */
  #record(event: EgressEventInput): boolean {
    try {
      this.#journal.record(this.#sessionId, event);
      return true;
    } catch {
      this.#faults += 1;
      return false;
    }
  }

  #refuse(client: Socket, event: EgressEventInput, status: number): void {
    if (!this.#record(event)) { client.destroy(); return; }
    client.end(`HTTP/1.1 ${status} ${STATUS[status]}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
  }

  async #handshake(client: Socket): Promise<void> {
    const read = await readHead(client, this.#limits);
    if (read.kind === 'silent') { client.destroy(); return; }
    const deny = (reason: EgressReason, status: number, requested: string | null = null) =>
      this.#refuse(client, { result: 'DENIED', reason, requested }, status);
    if (read.kind === 'refused') return deny(read.reason, read.status);
    const [line, ...headers] = read.head.split('\r\n');
    const request = REQUEST_LINE.exec(line);
    if (!request || !headers.every((header) => HEADER_LINE.test(header))) return deny('MALFORMED_REQUEST', 400);
    // Header lines are checked for syntax and for credential-shaped names only: none is
    // kept, used as authority, or forwarded.
    if (hasCredentialHeader(headers)) return deny('CREDENTIAL_HEADER', 400);
    if (request[1] !== 'CONNECT') return deny('NOT_CONNECT', 405);
    const authority = request[2];
    if (!isCanonicalEgressDestination(authority)) return deny('NOT_CANONICAL', 400);
    if (!this.#allow.has(authority)) return deny('NOT_ALLOWLISTED', 403, authority);
    if (this.#closing) return deny('BROKER_CLOSING', 503);

    const colon = authority.lastIndexOf(':');
    const hostname = authority.slice(0, colon);
    const port = Number(authority.slice(colon + 1));
    let addresses: ResolvedAddress[];
    try {
      addresses = await withTimeout(this.#resolver.resolve(hostname), this.#limits.connectTimeoutMs);
      if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some((entry) => isIP(entry?.address) === 0)) throw new Error('no address');
    } catch (error) {
      if (error instanceof UnsafeAddressError) return deny('UNSAFE_ADDRESS', 403, authority);
      return this.#refuse(client, { result: 'CONNECT_FAILED', reason: 'RESOLUTION_FAILED', requested: authority }, 502);
    }
    let upstream: Socket | undefined;
    let chosen: ResolvedAddress | undefined;
    for (const address of addresses) {
      try {
        upstream = await this.#dialer.dial(address, port, this.#limits.connectTimeoutMs);
        chosen = address;
        break;
      } catch { /* the next validated address, if any */ }
    }
    if (!upstream || !chosen) return this.#refuse(client, { result: 'CONNECT_FAILED', reason: 'UPSTREAM_UNREACHABLE', requested: authority }, 502);
    // The upstream socket exists: that is what CONNECTED records, whatever happens next.
    this.#upstreams.add(upstream);
    upstream.on('error', () => undefined);
    upstream.once('close', () => this.#upstreams.delete(upstream));
    if (!this.#record({ result: 'CONNECTED', reason: 'ALLOWLISTED', requested: authority, address: chosen.address })) {
      upstream.destroy();
      client.destroy();
      return;
    }
    if (client.destroyed || this.#closing) {
      upstream.destroy();
      client.destroy();
      return;
    }
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    // Anything the client sent past its head was put back on the socket; the pipe carries it first, as sent.
    client.pipe(upstream);
    upstream.pipe(client);
    client.once('close', () => upstream!.destroy());
    upstream.once('close', () => client.destroy());
    client.resume();
  }
}
Object.freeze(ConnectBroker);
Object.freeze(ConnectBroker.prototype);
