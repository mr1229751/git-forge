// The GitHub REST v3 surface of the forge, as one pure function over the shared store.
//
//   handleRest(store, method, path, query, body) -> Reply
//
// `path` is the full pathname (it starts with /api/v3), `query` the parsed query string and
// `body` the raw request body (possibly empty). The reply body is JSON text for every status
// except 204 (empty). Every reply carries a JSON content type and a non-empty
// X-GitHub-Request-Id header, as RULES.txt's wire contract requires.
//
// Two contract points cannot be settled inside this function and belong to the HTTP
// dispatcher that calls it:
//   * Authentication. handleRest receives no headers, so it cannot see whether an
//     Authorization token arrived. The dispatcher must answer 401 {"message": ...} itself
//     (JSON content type, request-id header) for a request with no token, before dispatch;
//     every request that reaches this function is the viewer's. Ownership then falls out of
//     the store: repositories live under the viewer's login only, so the same name under
//     another owner is a plain 404 here, never a 403.
//   * Pagination Link URLs. This function knows no origin, so the Link header it returns
//     carries path-absolute URLs (</api/v3/user/repos?per_page=10&page=2>; rel="next").
//     The checks follow rel="next" only when it stays on the entry's own origin and reject
//     a relative URL outright, so the dispatcher must absolutise the Link header against
//     the request's Host before sending.
//
// Determinism: no wall clock and no randomness anywhere; timestamps come from store.tick()
// and ids from the store's counters, exactly like the rest of the forge.

import {
  createRepo as storeCreateRepo,
  getRepo,
  nodeId,
  tick,
  type CommentRec,
  type IssueRec,
  type PullRec,
  type RepoRec,
  type Store,
} from './store.ts';
import {
  commitClosure,
  flattenTree,
  makeCommit,
  parseCommit,
  parseTree,
  peelToCommit,
  putObject,
  treeFromFlat,
  treeGet,
  treeSet,
  ZERO_OID,
  type TreeEntry,
} from './gitobj.ts';

export interface Reply {
  status: number;
  headers?: Record<string, string>;
  body: string | Buffer;
}

type Json = Record<string, unknown>;

/** One flattened tree entry, as gitobj.flattenTree reports it. */
type FlatEntry = { oid: string; mode: string };

// ---------------------------------------------------------------------------------------------
// Reply plumbing

const requestCounters = new WeakMap<Store, number>();

function nextRequestId(store: Store): string {
  const next = (requestCounters.get(store) ?? 0) + 1;
  requestCounters.set(store, next);
  return `forge-${next.toString(36)}`;
}

function jsonReply(status: number, value: unknown, headers: Record<string, string> = {}): Reply {
  return { status, headers, body: `${JSON.stringify(value)}\n` };
}

function errorReply(status: number, message: string): Reply {
  return jsonReply(status, { message });
}

function notFound(): Reply {
  return errorReply(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// Small field helpers over parsed JSON bodies

function strField(body: Json, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

function boolField(body: Json, key: string): boolean | undefined {
  const value = body[key];
  return typeof value === 'boolean' ? value : undefined;
}

function strArrayField(body: Json, key: string): string[] | undefined {
  const value = body[key];
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

/** Parse a request body: an empty body is {}, a malformed one is the 400 the protocol checks want. */
function parseJsonBody(body: Buffer): { ok: true; value: Json } | { ok: false } {
  if (body.length === 0) return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { ok: false };
  }
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return { ok: true, value: parsed as Json };
  return { ok: true, value: {} };
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// ---------------------------------------------------------------------------------------------
// JSON shapes

function userJson(store: Store, login: string): Json {
  const isViewer = login === store.viewer.login;
  return {
    login,
    id: isViewer ? store.viewer.id : 0,
    node_id: nodeId('User', isViewer ? store.viewer.id : 0),
    type: 'User',
    site_admin: false,
    name: isViewer ? store.viewer.name : login,
    email: isViewer ? store.viewer.email : `${login}@example.invalid`,
    url: `/api/v3/users/${login}`,
    html_url: `/${login}`,
  };
}

function viewerJson(store: Store): Json {
  return {
    ...userJson(store, store.viewer.login),
    url: '/api/v3/user',
    created_at: new Date(store.baseMs).toISOString(),
    updated_at: new Date(store.baseMs).toISOString(),
  };
}

function repoJson(store: Store, repo: RepoRec): Json {
  let openIssues = 0;
  for (const issue of repo.issues.values()) if (issue.state === 'open') openIssues += 1;
  for (const pull of repo.pulls.values()) if (pull.state === 'open') openIssues += 1;
  return {
    id: repo.id,
    node_id: nodeId('Repository', repo.id),
    name: repo.name,
    full_name: repo.fullName,
    owner: userJson(store, repo.owner),
    private: repo.isPrivate,
    html_url: `/${repo.fullName}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.fullName}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    open_issues_count: openIssues,
    default_branch: repo.defaultBranch,
    visibility: repo.isPrivate ? 'private' : 'public',
    archived: false,
    disabled: false,
  };
}

function labelJson(repo: RepoRec, name: string): Json {
  const label = repo.labels.get(name);
  return {
    name,
    color: label?.color ?? 'ededed',
    description: label?.description ?? '',
    default: false,
    url: `/api/v3/repos/${repo.fullName}/labels/${encodeURIComponent(name)}`,
  };
}

function issueJson(store: Store, repo: RepoRec, issue: IssueRec): Json {
  return {
    id: issue.dbId,
    node_id: nodeId('Issue', issue.dbId),
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.fullName}`,
    html_url: `/${repo.fullName}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: userJson(store, issue.author),
    labels: issue.labels.map((name) => labelJson(repo, name)),
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
  };
}

/**
 * Serialised issue bodies, cached per record. The read workload asks for one issue
 * thousands of times, so the JSON is rebuilt only when a cheap fingerprint of everything
 * issueJson serialises — state, title, body, labels, comments count, updatedAt — changes.
 * The fingerprint keeps the cache honest no matter which surface mutated the record
 * (REST PATCH, a comment, or GraphQL's closeIssue all move at least one fingerprinted
 * field), without enumerating the writers.
 */
const issueBodyCache = new WeakMap<IssueRec, { fingerprint: string; body: string }>();

function issueReply(status: number, store: Store, repo: RepoRec, issue: IssueRec): Reply {
  const fingerprint = `${issue.state}|${issue.updatedAt}|${issue.comments.length}|${issue.title}|${issue.body}|${issue.labels.join(',')}`;
  const cached = issueBodyCache.get(issue);
  if (cached !== undefined && cached.fingerprint === fingerprint) return { status, body: cached.body };
  const body = `${JSON.stringify(issueJson(store, repo, issue))}\n`;
  issueBodyCache.set(issue, { fingerprint, body });
  return { status, body };
}

function commentJson(store: Store, repo: RepoRec, issueNumber: number, comment: CommentRec): Json {
  return {
    id: comment.id,
    node_id: nodeId('IssueComment', comment.id),
    url: `/api/v3/repos/${repo.fullName}/issues/comments/${comment.id}`,
    html_url: `/${repo.fullName}/issues/${issueNumber}#issuecomment-${comment.id}`,
    issue_url: `/api/v3/repos/${repo.fullName}/issues/${issueNumber}`,
    body: comment.body,
    user: userJson(store, comment.author),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

/** The base tip a pull request was opened against; PullRec keeps no field for it. */
const pullBaseTips = new WeakMap<PullRec, string>();

function pullJson(store: Store, repo: RepoRec, pull: PullRec): Json {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headOid ?? ZERO_OID;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pullBaseTips.get(pull) ?? ZERO_OID;
  return {
    id: pull.dbId,
    node_id: nodeId('PullRequest', pull.dbId),
    url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
    html_url: `/${repo.fullName}/pull/${pull.number}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userJson(store, pull.author),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    merged_at: pull.merged ? pull.updatedAt : null,
    merged: pull.merged,
    merge_commit_sha: pull.mergeCommitSha,
    draft: false,
    comments: pull.comments.length,
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: headSha,
      user: userJson(store, repo.owner),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: baseSha,
      user: userJson(store, repo.owner),
    },
  };
}

interface Ident {
  name: string;
  email: string;
  date: string;
}

/** Parse a git ident line ("Name <email> epochSec +0000") into the REST author shape. */
function parseIdent(line: string): Ident {
  const match = /^(.*) <([^>]*)> (\d+) [+-]\d{4}$/.exec(line.trim());
  if (match === null) return { name: line, email: '', date: '' };
  return { name: match[1] as string, email: match[2] as string, date: new Date(Number(match[3]) * 1000).toISOString() };
}

function commitJson(repo: RepoRec, oid: string): Json {
  const object = repo.objects.get(oid);
  const info = object !== undefined && object.type === 'commit' ? parseCommit(object.data) : null;
  return {
    sha: oid,
    url: `/api/v3/repos/${repo.fullName}/commits/${oid}`,
    html_url: `/${repo.fullName}/commit/${oid}`,
    commit: {
      author: info === null ? { name: '', email: '', date: '' } : parseIdent(info.author),
      committer: info === null ? { name: '', email: '', date: '' } : parseIdent(info.committer),
      // Git stores the message with its trailing newline; the API (and the checks) want it bare.
      message: info === null ? '' : info.message.replace(/\n+$/, ''),
      tree: { sha: info?.tree ?? ZERO_OID },
      comment_count: 0,
    },
    parents: (info?.parents ?? []).map((sha) => ({ sha })),
  };
}

// ---------------------------------------------------------------------------------------------
// Git lookups over the store

/** Peel a ref target (or a raw oid) to its commit, or null. */
function peel(repo: RepoRec, oid: string): string | null {
  return peelToCommit(repo, oid);
}

/** Resolve a branch name, a full ref or a commit oid to a commit oid. */
function resolveCommit(repo: RepoRec, refLike: string | undefined): string | null {
  if (refLike === undefined || refLike === '') {
    const head = repo.refs.get(repo.head);
    return head === undefined ? null : peel(repo, head);
  }
  const direct = repo.refs.get(refLike) ?? repo.refs.get(`refs/heads/${refLike}`) ?? repo.refs.get(`refs/tags/${refLike}`);
  const oid = direct ?? (/^[0-9a-f]{40}$/i.test(refLike) ? refLike : undefined);
  return oid === undefined ? null : peel(repo, oid);
}

function commitTree(repo: RepoRec, commitOid: string): string {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return ZERO_OID;
  return parseCommit(object.data).tree;
}

/** The tree entry at a path: its mode and oid, or null when absent. */
function treeEntryAt(repo: RepoRec, treeOid: string, segments: readonly string[]): { mode: string; oid: string } | null {
  let current = treeOid;
  for (let depth = 0; depth < segments.length; depth += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[depth]);
    if (entry === undefined) return null;
    if (depth === segments.length - 1) return { mode: entry.mode, oid: entry.oid };
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/** A common ancestor of two commits (breadth-first from `b` over `a`'s ancestry), or null. */
function mergeBase(repo: RepoRec, a: string, b: string): string | null {
  const ancestors = commitClosure(repo, a);
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestors.has(oid)) return oid;
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'commit') queue.push(...parseCommit(object.data).parents);
  }
  return null;
}

function flatEq(a: FlatEntry | undefined, b: FlatEntry | undefined): boolean {
  return (a?.oid ?? null) === (b?.oid ?? null) && (a?.mode ?? null) === (b?.mode ?? null);
}

/** Lines in a blob's bytes, for the pull-request file counts. */
function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n').length;
  return text.endsWith('\n') ? lines - 1 : lines;
}

/** One contents-API commit on a branch: new tree in, commit made, ref moved. Answers the commit oid. */
function commitOnBranch(
  store: Store,
  repo: RepoRec,
  input: { branch: string; tree: string; message: string },
): { commitOid: string; stampIso: string } {
  const stamp = tick(store);
  const ident = `${store.viewer.name} <${store.viewer.email}> ${stamp.epochSec} +0000`;
  const tip = repo.refs.get(`refs/heads/${input.branch}`);
  const tipCommit = tip === undefined ? null : peel(repo, tip);
  const commitOid = makeCommit(repo, {
    tree: input.tree,
    parents: tipCommit === null ? [] : [tipCommit],
    ident,
    message: input.message,
  });
  repo.refs.set(`refs/heads/${input.branch}`, commitOid);
  repo.updatedAt = stamp.iso;
  return { commitOid, stampIso: stamp.iso };
}

/** The {content, commit} pair the contents PUT and DELETE answer with. */
function contentCommitJson(store: Store, repo: RepoRec, commitOid: string, stampIso: string): Json {
  const info = parseCommit((repo.objects.get(commitOid) as { data: Buffer }).data);
  const ident: Ident = { name: store.viewer.name, email: store.viewer.email, date: stampIso };
  return {
    sha: commitOid,
    node_id: nodeId('Commit', 0),
    author: ident,
    committer: ident,
    message: info.message.replace(/\n+$/, ''),
    tree: { sha: info.tree },
    parents: info.parents.map((sha) => ({ sha })),
    url: `/api/v3/repos/${repo.fullName}/commits/${commitOid}`,
    html_url: `/${repo.fullName}/commit/${commitOid}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Pagination

interface Page<T> {
  items: T[];
  headers: Record<string, string>;
}

/** Slice a list by per_page/page and build the Link header GitHub paginates with. */
function paginate<T>(items: readonly T[], query: URLSearchParams, basePath: string): Page<T> {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = Number.parseInt(query.get('page') ?? '', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const lastPage = Math.max(1, Math.ceil(items.length / perPage));
    const params = new URLSearchParams(query);
    params.set('per_page', String(perPage));
    params.set('page', String(page + 1));
    const next = `${basePath}?${params.toString()}`;
    params.set('page', String(lastPage));
    const last = `${basePath}?${params.toString()}`;
    headers.link = `<${next}>; rel="next", <${last}>; rel="last"`;
  }
  return { items: slice, headers };
}

// ---------------------------------------------------------------------------------------------
// Root, meta, user

function rootReply(): Reply {
  return jsonReply(
    200,
    {
      current_user_url: '/api/v3/user',
      current_user_repositories_url: '/api/v3/user/repos',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      issue_url: '/api/v3/repos/{owner}/{repo}/issues/{number}',
      meta_url: '/api/v3/meta',
    },
    { 'x-oauth-scopes': 'repo, read:org' },
  );
}

function listUserRepos(store: Store, query: URLSearchParams): Reply {
  const owned = [...store.repos.values()].filter((repo) => repo.owner === store.viewer.login);
  const page = paginate(owned.map((repo) => repoJson(store, repo)), query, '/api/v3/user/repos');
  return jsonReply(200, page.items, page.headers);
}

function createUserRepo(store: Store, body: Json): Reply {
  const name = strField(body, 'name');
  if (name === undefined || name === '' || name.includes('/')) {
    return errorReply(422, 'Repository creation failed: a valid name is required.');
  }
  if (getRepo(store, store.viewer.login, name) !== undefined) {
    return errorReply(422, 'Repository creation failed: the name already exists on this account.');
  }
  const repo = storeCreateRepo(store, {
    owner: store.viewer.login,
    name,
    description: strField(body, 'description') ?? '',
    isPrivate: boolField(body, 'private') ?? false,
  });
  return jsonReply(201, repoJson(store, repo));
}

// ---------------------------------------------------------------------------------------------
// Repository routes

function patchRepo(store: Store, repo: RepoRec, body: Json): Reply {
  const description = strField(body, 'description');
  if (description !== undefined) repo.description = description;
  const isPrivate = boolField(body, 'private');
  if (isPrivate !== undefined) repo.isPrivate = isPrivate;
  repo.updatedAt = tick(store).iso;
  return jsonReply(200, repoJson(store, repo));
}

function createRef(repo: RepoRec, body: Json): Reply {
  const ref = strField(body, 'ref');
  const shaRaw = strField(body, 'sha');
  if (ref === undefined || !ref.startsWith('refs/')) return errorReply(422, 'A ref starting with refs/ is required.');
  if (shaRaw === undefined || !/^[0-9a-f]{40}$/i.test(shaRaw)) return errorReply(422, 'A 40-hex object sha is required.');
  const sha = shaRaw.toLowerCase();
  const object = repo.objects.get(sha);
  if (object === undefined) return errorReply(422, `Object ${sha} does not exist in this repository.`);
  if (repo.refs.has(ref)) return errorReply(422, `Reference ${ref} already exists.`);
  repo.refs.set(ref, sha);
  return jsonReply(201, { ref, node_id: nodeId('Ref', 0), object: { type: object.type, sha, url: `/api/v3/repos/${repo.fullName}/git/commits/${sha}` } });
}

function listBranches(repo: RepoRec): Reply {
  const branches: Json[] = [];
  for (const [ref, oid] of repo.refs) {
    if (!ref.startsWith('refs/heads/')) continue;
    branches.push({
      name: ref.slice('refs/heads/'.length),
      commit: { sha: oid, url: `/api/v3/repos/${repo.fullName}/commits/${oid}` },
      protected: false,
    });
  }
  return jsonReply(200, branches);
}

function listCommits(repo: RepoRec, query: URLSearchParams): Reply {
  const start = resolveCommit(repo, query.get('sha') ?? undefined);
  if (start === null) return jsonReply(200, []);
  const out: Json[] = [];
  const seen = new Set<string>();
  let current: string | null = start;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    out.push(commitJson(repo, current));
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'commit') break;
    const parents = parseCommit(object.data).parents;
    current = parents[0] ?? null;
  }
  return jsonReply(200, out);
}

// ---------------------------------------------------------------------------------------------
// Contents

function contentsEntryJson(repo: RepoRec, entry: TreeEntry, prefix: string): Json {
  const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
  const isDir = entry.mode === '40000';
  const object = repo.objects.get(entry.oid);
  return {
    type: isDir ? 'dir' : 'file',
    name: entry.name,
    path,
    sha: entry.oid,
    size: isDir || object === undefined ? 0 : object.data.length,
    url: `/api/v3/repos/${repo.fullName}/contents/${path}`,
    html_url: `/${repo.fullName}/blob/${repo.defaultBranch}/${path}`,
    git_url: `/api/v3/repos/${repo.fullName}/git/blobs/${entry.oid}`,
    download_url: null,
  };
}

function getContents(repo: RepoRec, segments: readonly string[], query: URLSearchParams): Reply {
  const commitOid = resolveCommit(repo, query.get('ref') ?? undefined);
  if (commitOid === null) return notFound();
  const treeOid = commitTree(repo, commitOid);
  if (segments.length === 0) {
    const object = repo.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') return notFound();
    return jsonReply(200, parseTree(object.data).map((entry) => contentsEntryJson(repo, entry, '')));
  }
  const hit = treeEntryAt(repo, treeOid, segments);
  if (hit === null) return notFound();
  const path = segments.join('/');
  if (hit.mode === '40000') {
    const object = repo.objects.get(hit.oid);
    if (object === undefined || object.type !== 'tree') return notFound();
    return jsonReply(200, parseTree(object.data).map((entry) => contentsEntryJson(repo, entry, path)));
  }
  const blob = repo.objects.get(hit.oid);
  if (blob === undefined || blob.type !== 'blob') return notFound();
  return jsonReply(200, {
    type: 'file',
    encoding: 'base64',
    content: blob.data.toString('base64'),
    sha: hit.oid,
    size: blob.data.length,
    name: segments[segments.length - 1] as string,
    path,
    url: `/api/v3/repos/${repo.fullName}/contents/${path}`,
    html_url: `/${repo.fullName}/blob/${repo.defaultBranch}/${path}`,
    git_url: `/api/v3/repos/${repo.fullName}/git/blobs/${hit.oid}`,
    download_url: null,
  });
}

function putContents(store: Store, repo: RepoRec, segments: readonly string[], body: Json): Reply {
  if (segments.length === 0) return errorReply(422, 'A file path is required.');
  const contentB64 = strField(body, 'content');
  if (contentB64 === undefined) return errorReply(422, 'The content field is required.');
  const bytes = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
  const branch = strField(body, 'branch') ?? repo.defaultBranch;
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  if (tip === undefined && branch !== repo.defaultBranch) return errorReply(404, `Branch ${branch} does not exist.`);
  const tipCommit = tip === undefined ? null : peel(repo, tip);
  if (tip !== undefined && tipCommit === null) return errorReply(422, `Branch ${branch} does not point at a commit.`);
  const treeOid = tipCommit === null ? null : commitTree(repo, tipCommit);
  const existing = treeOid === null ? null : treeGet(repo, treeOid, segments);
  const providedSha = strField(body, 'sha');
  let created: boolean;
  if (existing !== null) {
    if (providedSha === undefined) return errorReply(422, 'The sha of the file being replaced is required.');
    if (providedSha.toLowerCase() !== existing.toLowerCase()) {
      return errorReply(409, 'The sha provided does not match the sha of the current file.');
    }
    created = false;
  } else {
    created = true;
  }
  const blobOid = putObject(repo, 'blob', bytes);
  const newTree = treeSet(repo, treeOid, segments, blobOid);
  const message = strField(body, 'message') ?? `Update ${segments.join('/')}`;
  const { commitOid, stampIso } = commitOnBranch(store, repo, { branch, tree: newTree, message });
  const path = segments.join('/');
  return jsonReply(created ? 201 : 200, {
    content: {
      type: 'file',
      encoding: 'base64',
      sha: blobOid,
      size: bytes.length,
      name: segments[segments.length - 1] as string,
      path,
      url: `/api/v3/repos/${repo.fullName}/contents/${path}`,
      html_url: `/${repo.fullName}/blob/${branch}/${path}`,
      git_url: `/api/v3/repos/${repo.fullName}/git/blobs/${blobOid}`,
      download_url: null,
    },
    commit: contentCommitJson(store, repo, commitOid, stampIso),
  });
}

function deleteContents(store: Store, repo: RepoRec, segments: readonly string[], body: Json): Reply {
  if (segments.length === 0) return notFound();
  const branch = strField(body, 'branch') ?? repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) return notFound();
  const tipCommit = peel(repo, tip);
  if (tipCommit === null) return notFound();
  const treeOid = commitTree(repo, tipCommit);
  const existing = treeGet(repo, treeOid, segments);
  if (existing === null) return notFound();
  const providedSha = strField(body, 'sha');
  if (providedSha !== undefined && providedSha.toLowerCase() !== existing.toLowerCase()) {
    return errorReply(409, 'The sha provided does not match the sha of the current file.');
  }
  const newTree = treeSet(repo, treeOid, segments, null);
  const message = strField(body, 'message') ?? `Delete ${segments.join('/')}`;
  const { commitOid, stampIso } = commitOnBranch(store, repo, { branch, tree: newTree, message });
  return jsonReply(200, { content: null, commit: contentCommitJson(store, repo, commitOid, stampIso) });
}

// ---------------------------------------------------------------------------------------------
// Labels

function createLabel(repo: RepoRec, body: Json): Reply {
  const name = strField(body, 'name');
  if (name === undefined || name === '') return errorReply(422, 'A label name is required.');
  if (repo.labels.has(name)) return errorReply(422, `A label named ${name} already exists in this repository.`);
  repo.labels.set(name, {
    name,
    color: strField(body, 'color') ?? 'ededed',
    description: strField(body, 'description') ?? '',
  });
  return jsonReply(201, labelJson(repo, name));
}

// ---------------------------------------------------------------------------------------------
// Issues and comments

/** Validate label names against the repository's labels; the 422 detail, or null. */
function unknownLabel(repo: RepoRec, names: readonly string[]): string | null {
  for (const name of names) {
    if (!repo.labels.has(name)) return `Label '${name}' does not exist in this repository.`;
  }
  return null;
}

function createIssue(store: Store, repo: RepoRec, body: Json): Reply {
  const title = strField(body, 'title');
  if (title === undefined) return errorReply(422, 'An issue title is required.');
  const labelNames = strArrayField(body, 'labels') ?? [];
  const problem = unknownLabel(repo, labelNames);
  if (problem !== null) return errorReply(422, problem);
  const stamp = tick(store);
  const issue: IssueRec = {
    number: repo.nextNumber,
    dbId: store.nextIssueDbId,
    title,
    body: strField(body, 'body') ?? '',
    state: 'open',
    labels: [...labelNames],
    author: store.viewer.login,
    createdAt: stamp.iso,
    updatedAt: stamp.iso,
    comments: [],
    isPull: false,
  };
  repo.nextNumber += 1;
  store.nextIssueDbId += 1;
  repo.issues.set(issue.number, issue);
  return issueReply(201, store, repo, issue);
}

function listIssues(store: Store, repo: RepoRec, query: URLSearchParams): Reply {
  const state = query.get('state') ?? 'open';
  let list = [...repo.issues.values()];
  if (state === 'open') list = list.filter((issue) => issue.state === 'open');
  else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
  // Creation order is number order (one shared per-repo sequence, handed out in order).
  list.sort((a, b) => a.number - b.number);
  if ((query.get('direction') ?? 'desc') !== 'asc') list.reverse();
  const page = paginate(list.map((issue) => issueJson(store, repo, issue)), query, `/api/v3/repos/${repo.fullName}/issues`);
  return jsonReply(200, page.items, page.headers);
}

function patchIssue(store: Store, repo: RepoRec, issue: IssueRec, body: Json): Reply {
  const state = strField(body, 'state');
  if (state !== undefined) {
    if (state !== 'open' && state !== 'closed') return errorReply(422, `State must be "open" or "closed".`);
    issue.state = state;
  }
  const title = strField(body, 'title');
  if (title !== undefined) issue.title = title;
  const text = strField(body, 'body');
  if (text !== undefined) issue.body = text;
  const labelNames = strArrayField(body, 'labels');
  if (labelNames !== undefined) {
    const problem = unknownLabel(repo, labelNames);
    if (problem !== null) return errorReply(422, problem);
    issue.labels = [...labelNames];
  }
  issue.updatedAt = tick(store).iso;
  return issueReply(200, store, repo, issue);
}

/** The issue or pull request a comments route addresses (GitHub serves PR comments here too). */
function commentTarget(repo: RepoRec, number: number): IssueRec | PullRec | undefined {
  return repo.issues.get(number) ?? repo.pulls.get(number);
}

function createComment(store: Store, repo: RepoRec, target: IssueRec | PullRec, body: Json): Reply {
  const text = strField(body, 'body');
  if (text === undefined) return errorReply(422, 'A comment body is required.');
  const stamp = tick(store);
  const comment: CommentRec = {
    id: store.nextCommentId,
    body: text,
    author: store.viewer.login,
    createdAt: stamp.iso,
    updatedAt: stamp.iso,
  };
  store.nextCommentId += 1;
  target.comments.push(comment);
  return jsonReply(201, commentJson(store, repo, target.number, comment));
}

// ---------------------------------------------------------------------------------------------
// Pull requests

function createPull(store: Store, repo: RepoRec, body: Json): Reply {
  const title = strField(body, 'title');
  const headRaw = strField(body, 'head');
  const baseRaw = strField(body, 'base');
  if (title === undefined || headRaw === undefined || baseRaw === undefined) {
    return errorReply(422, 'Title, head and base are required.');
  }
  const headRef = headRaw.includes(':') ? (headRaw.split(':').pop() as string) : headRaw;
  const baseRef = baseRaw.includes(':') ? (baseRaw.split(':').pop() as string) : baseRaw;
  if (headRef === baseRef) return errorReply(422, 'Head and base must be different branches.');
  const headTip = repo.refs.get(`refs/heads/${headRef}`);
  if (headTip === undefined) return errorReply(422, `Head branch ${headRef} does not exist.`);
  const baseTip = repo.refs.get(`refs/heads/${baseRef}`);
  if (baseTip === undefined) return errorReply(422, `Base branch ${baseRef} does not exist.`);
  const stamp = tick(store);
  const pull: PullRec = {
    number: repo.nextNumber,
    dbId: store.nextIssueDbId,
    title,
    body: strField(body, 'body') ?? '',
    state: 'open',
    merged: false,
    headRef,
    baseRef,
    headOid: peel(repo, headTip) ?? headTip,
    mergeCommitSha: null,
    author: store.viewer.login,
    createdAt: stamp.iso,
    updatedAt: stamp.iso,
    comments: [],
    isPull: true,
  };
  repo.nextNumber += 1;
  store.nextIssueDbId += 1;
  pullBaseTips.set(pull, peel(repo, baseTip) ?? baseTip);
  repo.pulls.set(pull.number, pull);
  return jsonReply(201, pullJson(store, repo, pull));
}

function listPulls(store: Store, repo: RepoRec, query: URLSearchParams): Reply {
  const state = query.get('state') ?? 'open';
  let list = [...repo.pulls.values()];
  if (state === 'open') list = list.filter((pull) => pull.state === 'open');
  else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
  list.sort((a, b) => b.number - a.number);
  const page = paginate(list.map((pull) => pullJson(store, repo, pull)), query, `/api/v3/repos/${repo.fullName}/pulls`);
  return jsonReply(200, page.items, page.headers);
}

function pullFiles(repo: RepoRec, pull: PullRec): Reply {
  const headTipRaw = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headOid;
  if (headTipRaw === null) return jsonReply(200, []);
  const headTip = peel(repo, headTipRaw) ?? headTipRaw;
  const baseTipRaw = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pullBaseTips.get(pull);
  const baseTip = baseTipRaw === undefined ? null : (peel(repo, baseTipRaw) ?? baseTipRaw);
  const base = baseTip === null ? null : mergeBase(repo, headTip, baseTip);
  const baseFlat = base === null ? new Map<string, FlatEntry>() : flattenTree(repo, commitTree(repo, base));
  const headFlat = flattenTree(repo, commitTree(repo, headTip));
  const paths = [...new Set([...baseFlat.keys(), ...headFlat.keys()])].sort();
  const files: Json[] = [];
  for (const path of paths) {
    const before = baseFlat.get(path);
    const after = headFlat.get(path);
    if (flatEq(before, after)) continue;
    const beforeData = before === undefined ? null : (repo.objects.get(before.oid)?.data ?? null);
    const afterData = after === undefined ? null : (repo.objects.get(after.oid)?.data ?? null);
    let status: string;
    let additions: number;
    let deletions: number;
    if (before === undefined && after !== undefined) {
      status = 'added';
      additions = afterData === null ? 0 : lineCount(afterData);
      deletions = 0;
    } else if (before !== undefined && after === undefined) {
      status = 'removed';
      additions = 0;
      deletions = beforeData === null ? 0 : lineCount(beforeData);
    } else {
      status = 'modified';
      additions = afterData === null ? 0 : lineCount(afterData);
      deletions = beforeData === null ? 0 : lineCount(beforeData);
    }
    files.push({
      sha: (after ?? before)?.oid ?? ZERO_OID,
      filename: path,
      status,
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return jsonReply(200, files);
}

function mergePull(store: Store, repo: RepoRec, pull: PullRec, body: Json): Reply {
  if (pull.state !== 'open' || pull.merged) return errorReply(405, 'Pull Request is not mergeable: it is not open.');
  const headTipRaw = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headOid;
  const baseTipRaw = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headTipRaw === null || baseTipRaw === undefined) return errorReply(405, 'Pull Request is not mergeable: a branch is gone.');
  const headTip = peel(repo, headTipRaw) ?? headTipRaw;
  const baseTip = peel(repo, baseTipRaw) ?? baseTipRaw;

  // Three-way merge of the flattened trees: a path changed on exactly one side since the
  // merge-base takes that side; changed on both sides to different contents is a conflict.
  const base = mergeBase(repo, headTip, baseTip);
  const baseFlat = base === null ? new Map<string, FlatEntry>() : flattenTree(repo, commitTree(repo, base));
  const headFlat = flattenTree(repo, commitTree(repo, headTip));
  const currentFlat = flattenTree(repo, commitTree(repo, baseTip));
  const merged = new Map<string, FlatEntry>();
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys(), ...currentFlat.keys()]);
  for (const path of paths) {
    const atBase = baseFlat.get(path);
    const atHead = headFlat.get(path);
    const atCurrent = currentFlat.get(path);
    const headChanged = !flatEq(atHead, atBase);
    const baseChanged = !flatEq(atCurrent, atBase);
    if (headChanged && baseChanged && !flatEq(atHead, atCurrent)) {
      return errorReply(405, 'Pull Request is not mergeable: the same path changed on both branches.');
    }
    const chosen = headChanged ? atHead : atCurrent;
    if (chosen !== undefined) merged.set(path, chosen);
  }
  const mergedTree = treeFromFlat(repo, merged);

  const stamp = tick(store);
  const ident = `${store.viewer.name} <${store.viewer.email}> ${stamp.epochSec} +0000`;
  const method = strField(body, 'merge_method') ?? 'merge';
  let commitOid: string;
  if (method === 'merge') {
    commitOid = makeCommit(repo, {
      tree: mergedTree,
      parents: [baseTip, headTip],
      ident,
      message: `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`,
    });
  } else {
    // Squash (and the fallback for anything else): one commit on the base tip with the merged tree.
    const titleLine = strField(body, 'commit_title') ?? `${pull.title} (#${pull.number})`;
    const extra = strField(body, 'commit_message') ?? (pull.body === '' ? undefined : pull.body);
    commitOid = makeCommit(repo, {
      tree: mergedTree,
      parents: [baseTip],
      ident,
      message: extra === undefined ? titleLine : `${titleLine}\n\n${extra}`,
    });
  }
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
  repo.updatedAt = stamp.iso;
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = commitOid;
  pull.updatedAt = stamp.iso;
  return jsonReply(200, { sha: commitOid, merged: true, message: 'Pull Request successfully merged' });
}

// ---------------------------------------------------------------------------------------------
// Routing

function repoRoute(
  store: Store,
  method: string,
  owner: string,
  name: string,
  sub: readonly string[],
  query: URLSearchParams,
  body: Json,
): Reply {
  const repo = getRepo(store, owner, name);
  if (repo === undefined) return notFound();

  if (sub.length === 0) {
    if (method === 'GET') return jsonReply(200, repoJson(store, repo));
    if (method === 'PATCH') return patchRepo(store, repo, body);
    if (method === 'DELETE') {
      store.repos.delete(repo.fullName);
      return { status: 204, body: '' };
    }
    return notFound();
  }

  const [head, ...rest] = sub as [string, ...string[]];

  if (head === 'git' && rest.length === 1 && rest[0] === 'refs' && method === 'POST') return createRef(repo, body);
  if (head === 'branches' && rest.length === 0 && method === 'GET') return listBranches(repo);
  if (head === 'commits' && rest.length === 0 && method === 'GET') return listCommits(repo, query);

  if (head === 'contents') {
    if (method === 'GET') return getContents(repo, rest, query);
    if (method === 'PUT') return putContents(store, repo, rest, body);
    if (method === 'DELETE') return deleteContents(store, repo, rest, body);
    return notFound();
  }

  if (head === 'labels') {
    if (rest.length === 0) {
      if (method === 'POST') return createLabel(repo, body);
      if (method === 'GET') return jsonReply(200, [...repo.labels.keys()].map((labelName) => labelJson(repo, labelName)));
      return notFound();
    }
    const labelName = rest.join('/');
    if (method === 'GET') return repo.labels.has(labelName) ? jsonReply(200, labelJson(repo, labelName)) : notFound();
    if (method === 'DELETE') {
      if (!repo.labels.delete(labelName)) return notFound();
      return { status: 204, body: '' };
    }
    return notFound();
  }

  if (head === 'issues') {
    if (rest.length === 0) {
      if (method === 'POST') return createIssue(store, repo, body);
      if (method === 'GET') return listIssues(store, repo, query);
      return notFound();
    }
    if (!/^\d+$/.test(rest[0])) return notFound();
    const number = Number(rest[0]);
    if (rest.length === 1) {
      const issue = repo.issues.get(number);
      if (issue === undefined) return notFound();
      if (method === 'GET') return issueReply(200, store, repo, issue);
      if (method === 'PATCH') return patchIssue(store, repo, issue, body);
      return notFound();
    }
    if (rest.length === 2 && rest[1] === 'comments') {
      const target = commentTarget(repo, number);
      if (target === undefined) return notFound();
      if (method === 'POST') return createComment(store, repo, target, body);
      if (method === 'GET') return jsonReply(200, target.comments.map((comment) => commentJson(store, repo, number, comment)));
      return notFound();
    }
    return notFound();
  }

  if (head === 'pulls') {
    if (rest.length === 0) {
      if (method === 'POST') return createPull(store, repo, body);
      if (method === 'GET') return listPulls(store, repo, query);
      return notFound();
    }
    if (!/^\d+$/.test(rest[0])) return notFound();
    const number = Number(rest[0]);
    const pull = repo.pulls.get(number);
    if (rest.length === 1) {
      if (pull === undefined) return notFound();
      if (method === 'GET') return jsonReply(200, pullJson(store, repo, pull));
      return notFound();
    }
    if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
      if (pull === undefined) return notFound();
      return pullFiles(repo, pull);
    }
    if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
      if (pull === undefined) return notFound();
      return mergePull(store, repo, pull, body);
    }
    return notFound();
  }

  return notFound();
}

function route(store: Store, method: string, segments: readonly string[], query: URLSearchParams, body: Json): Reply {
  if (segments.length === 0) {
    return method === 'GET' ? rootReply() : notFound();
  }
  const [head, ...rest] = segments as [string, ...string[]];
  if (head === 'meta' && rest.length === 0 && method === 'GET') {
    return jsonReply(200, { installed_version: '1.0.0' });
  }
  if (head === 'user') {
    if (rest.length === 0 && method === 'GET') return jsonReply(200, viewerJson(store));
    if (rest.length === 1 && rest[0] === 'repos') {
      if (method === 'GET') return listUserRepos(store, query);
      if (method === 'POST') return createUserRepo(store, body);
    }
    return notFound();
  }
  if (head === 'repos' && rest.length >= 2) {
    return repoRoute(store, method, rest[0] as string, rest[1] as string, rest.slice(2), query, body);
  }
  return notFound();
}

/**
 * The REST v3 entry point. `path` is the full pathname starting /api/v3; `body` the raw
 * request body. A malformed JSON body on a write is a 400 before any routing, as the
 * protocol checks require; every reply leaves with a JSON content type and a request id.
 */
export function handleRest(store: Store, method: string, path: string, query: URLSearchParams, body: Buffer): Reply {
  const requestId = nextRequestId(store);
  const upper = method.toUpperCase();
  let reply: Reply;
  const writes = upper === 'POST' || upper === 'PUT' || upper === 'PATCH' || upper === 'DELETE';
  const parsed = writes ? parseJsonBody(body) : { ok: true as const, value: {} as Json };
  if (!parsed.ok) {
    reply = errorReply(400, 'The request body is not valid JSON.');
  } else {
    const tail = path.startsWith('/api/v3') ? path.slice('/api/v3'.length) : path;
    const segments = tail.split('/').filter((segment) => segment !== '').map(decodeSegment);
    reply = route(store, upper, segments, query, parsed.value);
  }
  return {
    status: reply.status,
    body: reply.body,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-github-request-id': requestId,
      ...(reply.headers ?? {}),
    },
  };
}
