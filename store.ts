// The forge's single in-memory store, shared by the REST, GraphQL, MCP and git surfaces.
// Everything in here is deterministic: ids come from counters and timestamps from a fixed
// base (MAKEFUN_TRIAL_NOW when the harness sets it, else the scenario epoch) advanced by a
// per-store sequence, never from the wall clock, so two identical request sequences produce
// byte-identical state.

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export interface LabelRec {
  name: string;
  color: string;
  description: string;
}

export interface CommentRec {
  id: number;
  body: string;
  author: string;
  createdAt: string;
  updatedAt: string;
}

export interface IssueRec {
  number: number;
  dbId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  author: string;
  createdAt: string;
  updatedAt: string;
  comments: CommentRec[];
  isPull: false;
}

export interface PullRec {
  number: number;
  dbId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  headOid: string | null;
  mergeCommitSha: string | null;
  author: string;
  createdAt: string;
  updatedAt: string;
  comments: CommentRec[];
  isPull: true;
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  head: string;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  labels: Map<string, LabelRec>;
  nextNumber: number;
}

export interface Viewer {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

export interface Store {
  readonly viewer: Viewer;
  readonly repos: Map<string, RepoRec>;
  seq: number;
  nextRepoId: number;
  nextIssueDbId: number;
  nextCommentId: number;
  readonly baseMs: number;
}

/** The trial's fixed opening time in epoch ms; falls back to 2025-01-01T00:00:00Z. */
function trialBaseMs(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw !== '') {
    if (/^\d+$/.test(raw)) {
      const n = Number(raw);
      return n > 1_000_000_000_000 ? n : n * 1000;
    }
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 1_735_689_600_000;
}

export function createStore(): Store {
  return {
    viewer: { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' },
    repos: new Map(),
    seq: 0,
    nextRepoId: 1,
    nextIssueDbId: 1,
    nextCommentId: 1,
    baseMs: trialBaseMs(),
  };
}

/** Advance the deterministic clock one second and answer the new instant both ways. */
export function tick(store: Store): { iso: string; epochSec: number } {
  store.seq += 1;
  const ms = store.baseMs + store.seq * 1000;
  return { iso: new Date(ms).toISOString(), epochSec: Math.floor(ms / 1000) };
}

/** A GraphQL global id: opaque (never the bare database id), stable, and decodable. */
export function nodeId(kind: string, dbId: number): string {
  return Buffer.from(`forge:${kind}:${dbId}`, 'utf8').toString('base64url');
}

/** Decode a global id back to its kind and database id, or null when it is not one of ours. */
export function parseNodeId(id: string): { kind: string; dbId: number } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const match = /^forge:([A-Za-z]+):(\d+)$/.exec(text);
    if (match === null) return null;
    return { kind: match[1], dbId: Number(match[2]) };
  } catch {
    return null;
  }
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function getRepo(store: Store, owner: string, name: string): RepoRec | undefined {
  return store.repos.get(repoKey(owner, name));
}

export function createRepo(
  store: Store,
  input: { owner: string; name: string; description?: string; isPrivate?: boolean },
): RepoRec {
  const stamp = tick(store);
  const repo: RepoRec = {
    id: store.nextRepoId,
    owner: input.owner,
    name: input.name,
    fullName: repoKey(input.owner, input.name),
    description: input.description ?? '',
    isPrivate: input.isPrivate ?? false,
    defaultBranch: 'main',
    createdAt: stamp.iso,
    updatedAt: stamp.iso,
    objects: new Map(),
    refs: new Map(),
    head: 'refs/heads/main',
    issues: new Map(),
    pulls: new Map(),
    labels: new Map(),
    nextNumber: 1,
  };
  store.nextRepoId += 1;
  store.repos.set(repo.fullName, repo);
  return repo;
}
