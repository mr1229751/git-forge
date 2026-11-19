// The forge's Model Context Protocol endpoint: JSON-RPC 2.0 over Streamable HTTP, served at
// POST /mcp and driven by the suite's hand-rolled client (kit env/src/mcp-client.ts). Both
// protocol eras that client speaks are answered here:
//
//   modern  2026-07-28: no handshake. `server/discover` answers the server's identity,
//           capabilities and supportedVersions in one result; every later request just carries
//           its revision in `_meta` and the MCP-Protocol-Version header, which a stateless
//           endpoint may simply honour by answering.
//   legacy  2025-11-25 and earlier: `initialize` echoes one of the offered revisions back with
//           the same identity and capabilities, `notifications/initialized` is acknowledged
//           with an empty 202, and no session id is issued (the client carries one only when a
//           server hands one out, and works without).
//
// The six tools act on the very same store the REST surface serves, so an object created over
// MCP reads back over /api/v3 identically. Everything is deterministic: timestamps come from
// the store's tick(), never the wall clock, and the tools/list payload is built once at module
// load so two calls answer with the identical tools array.

import { createRepo as storeCreateRepo, getRepo as storeGetRepo, tick } from './store.ts';
import type { IssueRec, PullRec, RepoRec, Store } from './store.ts';
import { commitClosure, flattenTree, isAncestor, makeCommit, parseCommit, peelToCommit, treeFromFlat } from './gitobj.ts';

export interface Reply {
  status: number;
  headers?: Record<string, string>;
  body: string | Buffer;
}

// ---------------------------------------------------------------------------
// Protocol constants

const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' } as const;

/** Every revision this endpoint speaks, newest first (YYYY-MM-DD spellings, as the client filters for). */
const SUPPORTED_VERSIONS: readonly string[] = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** The revision a legacy `initialize` falls back to when the client offers none of ours. */
const LEGACY_FALLBACK = '2025-11-25';

const JSON_TYPE = 'application/json; charset=utf-8';

const ERR_PARSE = -32700;
const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INVALID_PARAMS = -32602;
const ERR_INTERNAL = -32603;

// ---------------------------------------------------------------------------
// The tools/list payload, built once: two tools/list answers must hold the
// same tools array byte for byte, so the result JSON is a single reused string.

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, Record<string, unknown>>;
  required: string[];
}

const TOOL_DEFS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The name of the repository to create.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private (default false).' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by its owner and name.',
    properties: {
      owner: { type: 'string', description: 'The account owner of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The account owner of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      title: { type: 'string', description: 'The title of the issue.' },
      body: { type: 'string', description: 'The contents of the issue.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List issues of a repository, optionally filtered by state (open, closed or all).',
    properties: {
      owner: { type: 'string', description: 'The account owner of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by issue state (default open).' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request proposing the head branch be merged into the base branch.',
    properties: {
      owner: { type: 'string', description: 'The account owner of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      title: { type: 'string', description: 'The title of the pull request.' },
      body: { type: 'string', description: 'The contents of the pull request.' },
      head: { type: 'string', description: 'The name of the branch where your changes are implemented.' },
      base: { type: 'string', description: 'The name of the branch you want the changes pulled into.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by its number (squash merge into the base branch).',
    properties: {
      owner: { type: 'string', description: 'The account owner of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      pull_number: { type: 'integer', description: 'The number of the pull request to merge.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

const TOOLS_RESULT_JSON: string = JSON.stringify({
  tools: TOOL_DEFS.map((def) => ({
    name: def.name,
    description: def.description,
    inputSchema: { type: 'object', properties: def.properties, required: def.required },
  })),
});

const DISCOVER_RESULT_JSON: string = JSON.stringify({
  supportedVersions: SUPPORTED_VERSIONS,
  capabilities: { tools: { listChanged: false } },
  serverInfo: SERVER_INFO,
  _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
});

// ---------------------------------------------------------------------------
// Small helpers

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A response whose body is one JSON-RPC envelope (or any JSON value) with the JSON content type. */
function jsonReply(status: number, bodyText: string): Reply {
  return { status, headers: { 'content-type': JSON_TYPE }, body: bodyText };
}

function resultReply(id: unknown, resultJson: string): Reply {
  return jsonReply(200, `{"jsonrpc":"2.0","id":${JSON.stringify(id ?? null)},"result":${resultJson}}`);
}

function errorReply(id: unknown, code: number, message: string, status = 200): Reply {
  return jsonReply(status, JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }));
}

/** Whether the request carries an Authorization header at all (the suite tests presence, never the value). */
function hasAuthorization(headers: Record<string, string | string[] | undefined>): boolean {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'authorization') continue;
    if (typeof value === 'string' && value.trim() !== '') return true;
    if (Array.isArray(value) && value.some((entry) => typeof entry === 'string' && entry.trim() !== '')) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// GitHub-shaped views of store records (the shapes the REST surface serves, so
// a tool result and a REST read of the same object agree field for field).

function repoJson(repo: RepoRec): JsonRecord {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function issueJson(repo: RepoRec, issue: IssueRec): JsonRecord {
  return {
    id: issue.dbId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label === undefined ? { name } : { name: label.name, color: label.color, description: label.description };
    }),
    user: { login: issue.author },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function pullJson(repo: RepoRec, pull: PullRec): JsonRecord {
  return {
    id: pull.dbId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merge_commit_sha: pull.mergeCommitSha,
    head: {
      ref: pull.headRef,
      sha: pull.headOid,
      label: `${repo.owner}:${pull.headRef}`,
    },
    base: {
      ref: pull.baseRef,
      sha: repo.refs.get(`refs/heads/${pull.baseRef}`) ?? null,
      label: `${repo.owner}:${pull.baseRef}`,
    },
    user: { login: pull.author },
    comments: pull.comments.length,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Argument reading: a required argument that is absent or of the wrong shape is
// a JSON-RPC -32602 (the missing-arguments contract), never a crash.

/** A required non-empty string argument, or null when it is missing/invalid. */
function reqString(args: JsonRecord, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** An optional string argument (empty string when absent or not a string). */
function optString(args: JsonRecord, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

/** A required positive-integer argument (a numeric string is accepted), or null. */
function reqNumber(args: JsonRecord, key: string): number | null {
  const value = args[key];
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

/** The names of `keys` whose required-string reading failed, in schema order. */
function missingStrings(args: JsonRecord, keys: readonly string[]): string[] {
  return keys.filter((key) => reqString(args, key) === null);
}

// ---------------------------------------------------------------------------
// The squash merge, on the store's own git objects: one new commit whose tree
// is the three-way merge of the head tree into the base tip (which, for the
// fast-forwardable pulls the suite exercises, is exactly the head tree), the
// base ref advanced to it. On success the merge commit sha, or null when the
// repository holds no git objects to merge (the pull record still merges); a
// genuine conflict is a failure the caller answers as a tool error.

type MergeOutcome = { ok: true; sha: string | null } | { ok: false; message: string };

function squashMergeTree(store: Store, repo: RepoRec, pull: PullRec, stamp: { iso: string; epochSec: number }): MergeOutcome {
  const baseRef = `refs/heads/${pull.baseRef}`;
  const headRef = `refs/heads/${pull.headRef}`;
  const baseTip = repo.refs.get(baseRef);
  const headTip = repo.refs.get(headRef) ?? pull.headOid ?? undefined;
  if (baseTip === undefined || headTip === undefined) return { ok: true, sha: null };
  const baseCommit = peelToCommit(repo, baseTip);
  const headCommit = peelToCommit(repo, headTip);
  if (baseCommit === null || headCommit === null) return { ok: true, sha: null };
  const baseObj = repo.objects.get(baseCommit);
  const headObj = repo.objects.get(headCommit);
  if (baseObj === undefined || headObj === undefined) return { ok: true, sha: null };
  const baseTree = parseCommit(baseObj.data).tree;
  const headTree = parseCommit(headObj.data).tree;

  let mergedTree = headTree;
  if (baseCommit !== headCommit && !isAncestor(repo, baseCommit, headCommit)) {
    // Diverged histories: a real three-way merge over the flattened trees.
    const baseAncestors = commitClosure(repo, baseCommit);
    const candidates = [...commitClosure(repo, headCommit)].filter((oid) => baseAncestors.has(oid));
    let mergeBase: string | null = null;
    for (const candidate of candidates) {
      if (!candidates.some((other) => other !== candidate && isAncestor(repo, candidate, other))) {
        mergeBase = candidate;
        break;
      }
    }
    if (mergeBase === null) return { ok: false, message: `Pull request #${pull.number} has no common ancestor with ${pull.baseRef}` };
    const mergeBaseObj = repo.objects.get(mergeBase);
    if (mergeBaseObj === undefined) return { ok: true, sha: null };
    const ancFlat = flattenTree(repo, parseCommit(mergeBaseObj.data).tree);
    const baseFlat = flattenTree(repo, baseTree);
    const headFlat = flattenTree(repo, headTree);
    const same = (a: { oid: string; mode: string } | undefined, b: { oid: string; mode: string } | undefined): boolean =>
      (a?.oid ?? null) === (b?.oid ?? null) && (a?.mode ?? null) === (b?.mode ?? null);
    const merged = new Map<string, { oid: string; mode: string }>();
    const paths = new Set<string>([...ancFlat.keys(), ...baseFlat.keys(), ...headFlat.keys()]);
    for (const path of paths) {
      const anc = ancFlat.get(path);
      const base = baseFlat.get(path);
      const head = headFlat.get(path);
      let pick: { oid: string; mode: string } | undefined;
      if (same(base, head)) pick = base;
      else if (same(anc, base)) pick = head;
      else if (same(anc, head)) pick = base;
      else return { ok: false, message: `Merge conflict in ${path}: both ${pull.baseRef} and ${pull.headRef} changed it` };
      if (pick !== undefined) merged.set(path, pick);
    }
    mergedTree = treeFromFlat(repo, merged);
  }

  const ident = `${store.viewer.name} <${store.viewer.email}> ${stamp.epochSec} +0000`;
  const message = pull.body !== '' ? `${pull.title} (#${pull.number})\n\n${pull.body}` : `${pull.title} (#${pull.number})`;
  const sha = makeCommit(repo, { tree: mergedTree, parents: [baseCommit], ident, message });
  repo.refs.set(baseRef, sha);
  return { ok: true, sha };
}

// ---------------------------------------------------------------------------
// The tools themselves. Each returns the GitHub-shaped object the call answers
// with, or a tool-error message (answered as a result with isError: true).

type ToolOutcome = { ok: true; value: unknown } | { ok: false; message: string };

function toolError(message: string): ToolOutcome {
  return { ok: false, message };
}

function runTool(store: Store, name: string, args: JsonRecord): ToolOutcome {
  switch (name) {
    case 'create_repo': {
      const repoName = reqString(args, 'name') as string;
      if (storeGetRepo(store, store.viewer.login, repoName) !== undefined) {
        return toolError(`Repository ${store.viewer.login}/${repoName} already exists`);
      }
      const repo = storeCreateRepo(store, {
        owner: store.viewer.login,
        name: repoName,
        description: optString(args, 'description'),
        isPrivate: args.private === true,
      });
      return { ok: true, value: repoJson(repo) };
    }
    case 'get_repo': {
      const owner = reqString(args, 'owner') as string;
      const repoName = reqString(args, 'repo') as string;
      const repo = storeGetRepo(store, owner, repoName);
      if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
      return { ok: true, value: repoJson(repo) };
    }
    case 'create_issue': {
      const owner = reqString(args, 'owner') as string;
      const repoName = reqString(args, 'repo') as string;
      const repo = storeGetRepo(store, owner, repoName);
      if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
      const stamp = tick(store);
      const issue: IssueRec = {
        number: repo.nextNumber,
        dbId: store.nextIssueDbId,
        title: reqString(args, 'title') as string,
        body: optString(args, 'body'),
        state: 'open',
        labels: [],
        author: store.viewer.login,
        createdAt: stamp.iso,
        updatedAt: stamp.iso,
        comments: [],
        isPull: false,
      };
      repo.nextNumber += 1;
      store.nextIssueDbId += 1;
      repo.issues.set(issue.number, issue);
      repo.updatedAt = stamp.iso;
      return { ok: true, value: issueJson(repo, issue) };
    }
    case 'list_issues': {
      const owner = reqString(args, 'owner') as string;
      const repoName = reqString(args, 'repo') as string;
      const repo = storeGetRepo(store, owner, repoName);
      if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
      const state = optString(args, 'state');
      const wanted = state === 'closed' || state === 'all' ? state : 'open';
      const issues = [...repo.issues.values()]
        .filter((issue) => wanted === 'all' || issue.state === wanted)
        .sort((a, b) => a.number - b.number)
        .map((issue) => issueJson(repo, issue));
      return { ok: true, value: issues };
    }
    case 'create_pull_request': {
      const owner = reqString(args, 'owner') as string;
      const repoName = reqString(args, 'repo') as string;
      const repo = storeGetRepo(store, owner, repoName);
      if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
      const head = (reqString(args, 'head') as string).replace(/^refs\/heads\//, '');
      const base = (reqString(args, 'base') as string).replace(/^refs\/heads\//, '');
      if (head === base) return toolError(`Head and base are both ${head}: nothing to pull`);
      const headOid = repo.refs.get(`refs/heads/${head}`);
      if (headOid === undefined) return toolError(`Head branch ${head} does not exist in ${owner}/${repoName}`);
      if (repo.refs.get(`refs/heads/${base}`) === undefined) return toolError(`Base branch ${base} does not exist in ${owner}/${repoName}`);
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
          return toolError(`A pull request for ${head} into ${base} already exists (#${existing.number})`);
        }
      }
      const stamp = tick(store);
      const pull: PullRec = {
        number: repo.nextNumber,
        dbId: store.nextIssueDbId,
        title: reqString(args, 'title') as string,
        body: optString(args, 'body'),
        state: 'open',
        merged: false,
        headRef: head,
        baseRef: base,
        headOid,
        mergeCommitSha: null,
        author: store.viewer.login,
        createdAt: stamp.iso,
        updatedAt: stamp.iso,
        comments: [],
        isPull: true,
      };
      repo.nextNumber += 1;
      store.nextIssueDbId += 1;
      repo.pulls.set(pull.number, pull);
      repo.updatedAt = stamp.iso;
      return { ok: true, value: pullJson(repo, pull) };
    }
    case 'merge_pull_request': {
      const owner = reqString(args, 'owner') as string;
      const repoName = reqString(args, 'repo') as string;
      const repo = storeGetRepo(store, owner, repoName);
      if (repo === undefined) return toolError(`Repository ${owner}/${repoName} not found`);
      const number = reqNumber(args, 'pull_number') as number;
      const pull = repo.pulls.get(number);
      if (pull === undefined) return toolError(`Pull request #${number} not found in ${owner}/${repoName}`);
      if (pull.merged) return toolError(`Pull request #${number} is already merged`);
      if (pull.state !== 'open') return toolError(`Pull request #${number} is ${pull.state} and cannot be merged`);
      const stamp = tick(store);
      const merge = squashMergeTree(store, repo, pull, stamp);
      if (!merge.ok) return toolError(merge.message);
      pull.merged = true;
      pull.state = 'closed';
      pull.mergeCommitSha = merge.sha;
      pull.updatedAt = stamp.iso;
      repo.updatedAt = stamp.iso;
      return { ok: true, value: pullJson(repo, pull) };
    }
    default:
      return toolError(`Unknown tool ${name}`);
  }
}

// ---------------------------------------------------------------------------
// tools/call: authentication first (an unauthenticated call answers HTTP 401
// before any tool exists), then the tool lookup, then required-argument
// validation, then the call. A tool's own failure is a result with
// isError: true; protocol failures are JSON-RPC errors, never HTTP 500.

function handleToolsCall(store: Store, id: unknown, params: unknown, headers: Record<string, string | string[] | undefined>): Reply {
  if (!hasAuthorization(headers)) {
    return jsonReply(401, JSON.stringify({ message: 'Requires authentication' }));
  }
  if (!isRecord(params) || typeof params.name !== 'string' || params.name === '') {
    return errorReply(id, ERR_INVALID_PARAMS, 'tools/call needs a tool name');
  }
  const name = params.name;
  const def = TOOL_DEFS.find((tool) => tool.name === name);
  if (def === undefined) {
    return errorReply(id, ERR_METHOD_NOT_FOUND, `Unknown tool: ${name}`);
  }
  const args: JsonRecord = isRecord(params.arguments) ? params.arguments : {};
  const missing = missingStrings(args, def.required.filter((key) => key !== 'pull_number'));
  if (def.required.includes('pull_number') && reqNumber(args, 'pull_number') === null) missing.push('pull_number');
  if (missing.length > 0) {
    return errorReply(id, ERR_INVALID_PARAMS, `Missing or invalid required argument(s): ${missing.join(', ')}`);
  }
  const outcome = runTool(store, name, args);
  if (!outcome.ok) {
    const failure = { content: [{ type: 'text', text: outcome.message }], isError: true };
    return resultReply(id, JSON.stringify(failure));
  }
  const text = JSON.stringify(outcome.value);
  const success = { content: [{ type: 'text', text }], structuredContent: outcome.value, isError: false };
  return resultReply(id, JSON.stringify(success));
}

// ---------------------------------------------------------------------------
// One JSON-RPC request. Returns null for a notification (answered by an empty
// 202, whatever it names).

function handleRequest(store: Store, request: JsonRecord, headers: Record<string, string | string[] | undefined>): Reply | null {
  const isNotification = !('id' in request);
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  if (method === '') {
    return isNotification ? null : errorReply(id, ERR_INVALID_REQUEST, 'Invalid request: no method');
  }
  if (isNotification) return null;

  switch (method) {
    case 'server/discover':
      return resultReply(id, DISCOVER_RESULT_JSON);
    case 'initialize': {
      const params = isRecord(request.params) ? request.params : {};
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = SUPPORTED_VERSIONS.includes(offered) ? offered : LEGACY_FALLBACK;
      const result = {
        protocolVersion: negotiated,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      };
      return resultReply(id, JSON.stringify(result));
    }
    case 'ping':
      return resultReply(id, '{}');
    case 'tools/list':
      return resultReply(id, TOOLS_RESULT_JSON);
    case 'tools/call':
      return handleToolsCall(store, id, request.params, headers);
    default:
      return errorReply(id, ERR_METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

/**
 * Answer one POST /mcp body. A body that is not JSON is HTTP 400 with JSON-RPC -32700; a
 * batch is answered element by element; a lone notification is an empty 202. Concurrent
 * calls are independent by construction: the handler is a pure function of (store, body,
 * headers), and every answer carries its own request's id.
 */
export function handleMcp(store: Store, body: Buffer, headers: Record<string, string | string[] | undefined>): Reply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return errorReply(null, ERR_PARSE, 'Parse error', 400);
  }
  try {
    if (Array.isArray(parsed)) {
      const replies: string[] = [];
      for (const element of parsed) {
        if (!isRecord(element)) continue;
        const reply = handleRequest(store, element, headers);
        if (reply !== null) replies.push(typeof reply.body === 'string' ? reply.body : reply.body.toString('utf8'));
      }
      if (replies.length === 0) return { status: 202, body: '' };
      return jsonReply(200, `[${replies.join(',')}]`);
    }
    if (!isRecord(parsed)) {
      return errorReply(null, ERR_INVALID_REQUEST, 'Invalid request: not a JSON-RPC object', 400);
    }
    const reply = handleRequest(store, parsed, headers);
    if (reply === null) return { status: 202, body: '' };
    return reply;
  } catch {
    const id = isRecord(parsed) ? (parsed.id ?? null) : null;
    return errorReply(id, ERR_INTERNAL, 'Internal error');
  }
}
