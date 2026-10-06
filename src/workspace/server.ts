import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { parseHumanPrincipalV1, type HumanPrincipalV1, type WorkspaceConfig, type WorkspaceProject } from './config.js';
import { FileGoalStore, GoalQueueRequestError, GoalStoreIntegrityError, type GoalQueue, type QueueChange } from './goal-store.js';

// The local Workspace server (WS-L1). It serves the Workspace UI and a small API over
// the non-authoritative goal queue, from one origin, on the IPv4 loopback address only.
//
// What it can do: list configured projects; read, add, reorder, and remove queued goals;
// stream those changes over Server-Sent Events. What it cannot do: create or step a run,
// issue a packet, call a model, record an authorization, or read Controller state. There
// is no route for any of that, and the module graph is guarded by test-workspace-boundary.
//
// Request isolation is not Human authentication. It only keeps other web pages and other
// host names from driving these localhost endpoints: the Host header must name this
// loopback listener, a mutation must come from this exact origin with a JSON body and the
// Workspace request header, and no CORS response header is ever sent.

export const HOST = '127.0.0.1';
export const READ_MODEL_VERSION = 'workspace.v0';
export const API_ROUTES = Object.freeze([
  'GET /api/v0/projects',
  'GET /api/v0/projects/:projectId/goals',
  'POST /api/v0/projects/:projectId/goals',
  'POST /api/v0/projects/:projectId/goals/order',
  'DELETE /api/v0/projects/:projectId/goals/:goalId',
  'GET /api/v0/stream',
] as const);
const MAX_BODY_BYTES = 16 * 1024;
const MAX_STREAMS = 32;
const HEARTBEAT_MS = 20_000;
const REQUEST_HEADER = 'x-chief-workspace';
const SESSION_COOKIE = 'chief_workspace_session';
const MAX_SESSIONS = 1024;
const NOTICE = 'Local operator input. Non-authoritative. Execution has not started and cannot be started from the Workspace in this version.';

const STATIC: Readonly<Record<string, { file: string; type: string }>> = Object.freeze({
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/live.js': { file: 'live.js', type: 'text/javascript; charset=utf-8' },
  '/demo.js': { file: 'demo.js', type: 'text/javascript; charset=utf-8' },
  '/collaboration.js': { file: 'collaboration.js', type: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
});
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export interface WorkspaceServerOptions {
  config: WorkspaceConfig;
  uiDirectory: string;
  /** 0 picks a free port (tests). */
  port: number;
  store?: FileGoalStore;
  clock?: { now(): string };
}

export interface RunningWorkspace {
  readonly server: Server;
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload), 'X-Content-Type-Options': 'nosniff' });
  response.end(payload);
}

function queueView(project: WorkspaceProject, queue: GoalQueue) {
  return { readModelVersion: READ_MODEL_VERSION, provenance: 'LOCAL_OPERATOR_INPUT', authority: 'NON_AUTHORITATIVE', notice: NOTICE,
    projectId: project.projectId, revision: queue.revision, goals: queue.goals, history: queue.history };
}

function changeEvent(projectId: string, change: QueueChange): { name: string; data: unknown } {
  const { queue, event } = change;
  const base = { readModelVersion: READ_MODEL_VERSION, projectId, revision: queue.revision, at: event.at };
  if (event.kind === 'GOAL_ADDED') return { name: 'goal.created', data: { ...base, goal: queue.goals.find((goal) => goal.goalId === event.goal.goalId) } };
  if (event.kind === 'QUEUE_REORDERED') return { name: 'queue.reordered', data: { ...base, order: event.order } };
  return { name: 'goal.removed', data: { ...base, goalId: event.goalId } };
}

export function startWorkspaceServer(options: WorkspaceServerOptions): Promise<RunningWorkspace> {
  const { config } = options;
  const principal = parseHumanPrincipalV1(config.humanPrincipal);
  const store = options.store ?? new FileGoalStore(config.dataDirectory, options.clock ? { clock: options.clock } : {});
  const projects = new Map(config.projects.map((project) => [project.projectId, project]));
  const ui = new Map(Object.entries(STATIC).map(([path, entry]) => [path, { ...entry, body: readFileSync(join(options.uiDirectory, entry.file)) }]));
  const streams = new Set<ServerResponse>();
  const sessions = new Map<string, HumanPrincipalV1>();
  let port = 0;

  const origins = () => [`http://${HOST}:${port}`, `http://localhost:${port}`];
  const project = (id: string): WorkspaceProject => {
    const found = projects.get(id);
    if (!found) throw new HttpError(404, 'UNKNOWN_PROJECT', 'This project is not in the Workspace configuration.');
    return found;
  };
  const broadcast = (name: string, data: unknown) => {
    const frame = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const stream of streams) stream.write(frame);
  };
  const sessionOf = (request: IncomingMessage): HumanPrincipalV1 | undefined => {
    const cookies = (request.headers.cookie ?? '').split(';').map((part) => part.trim())
      .filter((part) => part.startsWith(`${SESSION_COOKIE}=`));
    if (cookies.length !== 1) return undefined;
    return sessions.get(cookies[0].slice(SESSION_COOKIE.length + 1));
  };
  const bindSession = (request: IncomingMessage, response: ServerResponse) => {
    if (sessionOf(request)) return;
    if (sessions.size >= MAX_SESSIONS) throw new HttpError(503, 'SESSION_LIMIT', 'Too many local Workspace sessions.');
    const token = randomUUID();
    sessions.set(token, principal);
    response.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`);
  };
  const requireSession = (request: IncomingMessage): HumanPrincipalV1 => {
    const bound = sessionOf(request);
    if (!bound) throw new HttpError(401, 'NO_LOCAL_SESSION', 'Open the Workspace page to start a local session.');
    return bound;
  };

  // DNS rebinding and cross-site requests stop here, before any route runs.
  const isolate = (request: IncomingMessage, mutation: boolean) => {
    const host = request.headers.host;
    if (host !== `${HOST}:${port}` && host !== `localhost:${port}`) throw new HttpError(421, 'WRONG_HOST', 'This server answers only on its loopback address.');
    const site = request.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'CROSS_SITE', 'Requests from other sites are refused.');
    if (!mutation) return;
    if (!origins().includes(String(request.headers.origin))) throw new HttpError(403, 'WRONG_ORIGIN', 'Changes are accepted only from the Workspace page itself.');
    if (request.headers[REQUEST_HEADER] !== '1') throw new HttpError(403, 'MISSING_HEADER', 'Changes must be sent by the Workspace page.');
  };

  const readJson = (request: IncomingMessage): Promise<Record<string, unknown>> => new Promise((done, fail) => {
    const type = String(request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') { fail(new HttpError(415, 'NOT_JSON', 'Send the change as JSON.')); request.resume(); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    let refused = false;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES && !refused) { refused = true; fail(new HttpError(413, 'TOO_LARGE', 'The request is too large.')); }
      if (!refused) chunks.push(chunk);
    });
    request.on('end', () => {
      if (refused) return;
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
        done(value as Record<string, unknown>);
      } catch {
        fail(new HttpError(400, 'BAD_JSON', 'The request body is not a JSON object.'));
      }
    });
    request.on('error', () => fail(new HttpError(400, 'BAD_REQUEST', 'The request could not be read.')));
  });
  const only = (body: Record<string, unknown>, keys: string[]) => {
    const extra = Object.keys(body).filter((key) => !keys.includes(key));
    if (extra.length) throw new HttpError(400, 'UNKNOWN_FIELD', `Unknown field: ${extra[0]}`);
  };

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const method = request.method ?? 'GET';
    const path = new URL(request.url ?? '/', 'http://local').pathname;
    const mutation = method === 'POST' || method === 'DELETE';
    if (!['GET', 'HEAD', 'POST', 'DELETE'].includes(method)) throw new HttpError(405, 'METHOD', 'Method not allowed.');
    isolate(request, mutation);

    if (!path.startsWith('/api/')) {
      const asset = ui.get(path);
      if (!asset || mutation) throw new HttpError(404, 'NOT_FOUND', 'Not found.');
      if (method === 'GET' && (path === '/' || path === '/index.html')) bindSession(request, response);
      response.writeHead(200, { 'Content-Type': asset.type, 'Content-Length': asset.body.length, 'Cache-Control': 'no-store',
        'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' });
      response.end(method === 'HEAD' ? undefined : asset.body);
      return;
    }

    let parts: string[];
    try { parts = path.split('/').filter(Boolean).map(decodeURIComponent); } catch { throw new HttpError(400, 'BAD_PATH', 'The address is not valid.'); }
    if (parts[0] !== 'api' || parts[1] !== 'v0') throw new HttpError(404, 'NOT_FOUND', 'Not found.');
    const submittedBy = requireSession(request);
    const rest = parts.slice(2);

    if (method === 'GET' && rest.length === 1 && rest[0] === 'stream') {
      if (streams.size >= MAX_STREAMS) throw new HttpError(503, 'TOO_MANY_STREAMS', 'Too many open Workspace windows.');
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'keep-alive',
        'X-Content-Type-Options': 'nosniff' });
      const revisions = Object.fromEntries(config.projects.map((item) => [item.projectId, store.read(item.projectId).revision]));
      response.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ readModelVersion: READ_MODEL_VERSION, revisions })}\n\n`);
      streams.add(response);
      const beat = setInterval(() => response.write(': keep-alive\n\n'), HEARTBEAT_MS);
      beat.unref();
      request.on('close', () => { clearInterval(beat); streams.delete(response); });
      return;
    }
    if (method === 'GET' && rest.length === 1 && rest[0] === 'projects') {
      json(response, 200, { readModelVersion: READ_MODEL_VERSION, provenance: 'LOCAL_CONFIGURATION',
        projects: config.projects.map((item) => ({ ...item, queued: store.read(item.projectId).goals.length })) });
      return;
    }
    if (rest[0] === 'projects' && rest.length >= 3 && rest[2] === 'goals') {
      const current = project(rest[1]);
      if (rest.length === 3 && method === 'GET') { json(response, 200, queueView(current, store.read(current.projectId))); return; }
      if (rest.length === 3 && method === 'POST') {
        const body = await readJson(request);
        only(body, ['text']);
        const change = store.addGoal(current.projectId, body.text, submittedBy);
        const event = changeEvent(current.projectId, change);
        broadcast(event.name, event.data);
        json(response, 201, { ...(event.data as object), notice: NOTICE });
        return;
      }
      if (rest.length === 4 && rest[3] === 'order' && method === 'POST') {
        const body = await readJson(request);
        only(body, ['order', 'expectedRevision']);
        if (body.expectedRevision !== undefined && !Number.isSafeInteger(body.expectedRevision)) throw new HttpError(400, 'BAD_REVISION', 'expectedRevision must be an integer.');
        const change = store.reorder(current.projectId, body.order, body.expectedRevision as number | undefined);
        const event = changeEvent(current.projectId, change);
        broadcast(event.name, event.data);
        json(response, 200, event.data);
        return;
      }
      if (rest.length === 4 && rest[3] !== 'order' && method === 'DELETE') {
        if (request.headers['content-type'] !== undefined || request.headers['transfer-encoding'] !== undefined ||
            (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0')) {
          throw new HttpError(400, 'UNEXPECTED_BODY', 'A goal removal does not accept request fields.');
        }
        const change = store.removeGoal(current.projectId, rest[3]);
        const event = changeEvent(current.projectId, change);
        broadcast(event.name, event.data);
        json(response, 200, event.data);
        return;
      }
    }
    throw new HttpError(404, 'NOT_FOUND', 'Not found.');
  };

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (response.headersSent) { response.end(); return; }
      if (error instanceof HttpError) { json(response, error.status, { error: { code: error.code, message: error.message } }); return; }
      if (error instanceof GoalQueueRequestError) {
        json(response, error.code === 'UNKNOWN_GOAL' ? 404 : error.code === 'STALE_REVISION' ? 409 : 400, { error: { code: error.code, message: error.message } });
        return;
      }
      if (error instanceof GoalStoreIntegrityError) {
        json(response, 500, { error: { code: 'STORE_INTEGRITY', message: `The goal queue on disk failed its integrity check and was not changed: ${error.message}` } });
        return;
      }
      json(response, 500, { error: { code: 'INTERNAL', message: 'The Workspace server could not complete the request.' } });
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;

  return new Promise((done, fail) => {
    server.once('error', fail);
    // Loopback only. There is no option to listen on another address.
    server.listen(options.port, HOST, () => {
      server.off('error', fail);
      // server.address() is string | AddressInfo | null; a TCP listener yields the object form.
      const address = server.address();
      if (address === null || typeof address === 'string') { fail(new Error('Workspace server did not bind a TCP port')); return; }
      port = address.port;
      done(Object.freeze({
        server, port, url: `http://${HOST}:${port}/`,
        close: () => new Promise<void>((closed) => {
          for (const stream of streams) stream.end();
          streams.clear();
          sessions.clear();
          server.close(() => closed());
          server.closeAllConnections();
        }),
      }));
    });
  });
}
