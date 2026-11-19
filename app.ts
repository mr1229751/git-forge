// The forge's HTTP surface: one server, four protocols, one store. main.ts owns the
// entry <-> env lifecycle; this file owns routing and the cross-cutting wire rules:
//   - GET /healthz answers without auth (the env's boot probe);
//   - every other surface requires Authorization: Bearer <$MAKEFUN_SHOP_TOKEN> when that
//     variable is set — a request without it is a 401 JSON error;
//   - every reply carries a non-empty X-GitHub-Request-Id header;
//   - REST Link headers are absolutised against the request's Host, because the suite
//     follows rel="next" only when it stays on the entry's origin;
//   - /api/v3/* is REST (rest.ts), /api/graphql is GraphQL (graphql.ts), /mcp is MCP
//     (mcp.ts), and /{owner}/{repo}.git/* is git smart HTTP (gitproto.ts);
//   - anything else is a JSON 404, never HTML.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createStore, type Store } from './store.ts';
import { handleRest, type Reply } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './gitproto.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

let requestSeq = 0;

function writeReply(req: IncomingMessage, res: ServerResponse, reply: Reply): void {
  requestSeq += 1;
  const body: Buffer = typeof reply.body === 'string' ? Buffer.from(reply.body, 'utf8') : reply.body;
  const headers: Record<string, string> = { ...(reply.headers ?? {}) };
  if (headers['content-type'] === undefined && typeof reply.body === 'string') headers['content-type'] = JSON_TYPE;
  if (headers['link'] !== undefined) {
    const host = req.headers['host'];
    if (host !== undefined && host !== '') {
      headers['link'] = headers['link'].replace(/<(\/[^>]*)>/g, `<http://${host}$1>`);
    }
  }
  headers['x-github-request-id'] = `forge-${requestSeq}`;
  headers['content-length'] = String(body.length);
  res.writeHead(reply.status, headers);
  res.end(body);
}

function jsonReply(status: number, value: unknown): Reply {
  return { status, body: `${JSON.stringify(value)}\n` };
}

function urlOf(req: IncomingMessage): URL {
  try {
    return new URL(req.url ?? '/', 'http://entry');
  } catch {
    return new URL('/', 'http://entry');
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

async function dispatch(store: Store, req: IncomingMessage): Promise<Reply> {
  const method = req.method ?? 'GET';
  const url = urlOf(req);
  const path = url.pathname;

  if (method === 'GET' && path === '/healthz') return jsonReply(200, { ok: true });

  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (token !== '') {
    const presented = req.headers['authorization'];
    if (presented !== `Bearer ${token}`) return jsonReply(401, { message: 'Bad credentials' });
  }

  if (path === '/mcp') {
    return handleMcp(store, await readBody(req), req.headers);
  }
  if (path === '/api/graphql') {
    return handleGraphQL(store, await readBody(req));
  }
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
    return handleRest(store, method, path, url.searchParams, body);
  }
  const gitMatch = GIT_PATH.exec(path);
  if (gitMatch !== null) {
    const body = method === 'GET' ? Buffer.alloc(0) : await readBody(req);
    const protocol = req.headers['git-protocol'];
    return handleGit(
      store,
      method,
      decodeURIComponent(gitMatch[1]),
      decodeURIComponent(gitMatch[2]),
      gitMatch[3],
      url.searchParams,
      body,
      typeof protocol === 'string' ? protocol : undefined,
    );
  }
  return jsonReply(404, { message: 'Not Found' });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = createStore();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    dispatch(store, req).then(
      (reply) => writeReply(req, res, reply),
      () => writeReply(req, res, jsonReply(500, { message: 'Internal Server Error' })),
    );
  });
  server.keepAliveTimeout = 30_000;
  server.headersTimeout = 35_000;
  return server;
}
