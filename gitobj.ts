// Git object primitives over a repository's in-memory object map: hashing, tree and commit
// (de)serialisation, reachability, ancestry, path updates, pack building and pack parsing
// (including ofs/ref delta application). Pure functions of the store — no clocks, no randomness.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, GitObjectType, RepoRec } from './store.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

export function putObject(repo: RepoRec, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.toString('utf8', offset, space);
    const nul = data.indexOf(0x00, space);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Serialise tree entries in git's order: by name, directories as if suffixed with '/'. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/**
 * Parsed-object caches: git objects are immutable and content-addressed, so a parse of one
 * oid is valid for the life of its repository. Ancestor walks and fetch planning re-parse
 * the same commits hundreds of times without this; with it they become map reads.
 */
const commitParseCache = new WeakMap<RepoRec, Map<string, CommitInfo>>();
const treeParseCache = new WeakMap<RepoRec, Map<string, TreeEntry[]>>();

export function parseCommitCached(repo: RepoRec, oid: string): CommitInfo | null {
  let perRepo = commitParseCache.get(repo);
  if (perRepo === undefined) {
    perRepo = new Map();
    commitParseCache.set(repo, perRepo);
  }
  const hit = perRepo.get(oid);
  if (hit !== undefined) return hit;
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return null;
  const parsed = parseCommit(object.data);
  perRepo.set(oid, parsed);
  return parsed;
}

export function parseTreeCached(repo: RepoRec, oid: string): TreeEntry[] | null {
  let perRepo = treeParseCache.get(repo);
  if (perRepo === undefined) {
    perRepo = new Map();
    treeParseCache.set(repo, perRepo);
  }
  const hit = perRepo.get(oid);
  if (hit !== undefined) return hit;
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'tree') return null;
  const parsed = parseTree(object.data);
  perRepo.set(oid, parsed);
  return parsed;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const info: TagInfo = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) info.object = line.slice(7).trim();
    else if (line.startsWith('type ')) info.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) info.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) info.tagger = line.slice(7);
  }
  return info;
}

/** Peel a ref target to its commit: follow tag objects until a commit (or null). */
export function peelToCommit(repo: RepoRec, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = repo.objects.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** Every object reachable from the tips (commits, their trees and blobs, tags), minus `haves` closures. */
export function collectReachable(
  repo: RepoRec,
  tips: Iterable<string>,
  exclude: ReadonlySet<string> = new Set(),
): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid) || exclude.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommitCached(repo, oid) as CommitInfo;
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTreeCached(repo, oid) as TreeEntry[]) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** The closure of commit oids reachable from `tip` (commits only). */
export function commitClosure(repo: RepoRec, tip: string): Set<string> {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const commit = parseCommitCached(repo, oid);
    if (commit === null) continue;
    seen.add(oid);
    for (const parent of commit.parents) stack.push(parent);
  }
  return seen;
}

export function isAncestor(repo: RepoRec, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return commitClosure(repo, descendant).has(ancestor);
}

/** Commits reachable from `tip` but not from any of `stops`, newest-first by walk order. */
export function commitsBetween(repo: RepoRec, tip: string, stops: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid) || stops.has(oid)) continue;
    const commit = parseCommitCached(repo, oid);
    if (commit === null) continue;
    seen.add(oid);
    out.push(oid);
    for (const parent of commit.parents) stack.push(parent);
  }
  return out;
}

/** The blob oid at a path inside a tree, or null. */
export function treeGet(repo: RepoRec, treeOid: string, segments: readonly string[]): string | null {
  let current = treeOid;
  for (let depth = 0; depth < segments.length; depth += 1) {
    const entries = parseTreeCached(repo, current);
    if (entries === null) return null;
    const entry = entries.find((candidate) => candidate.name === segments[depth]);
    if (entry === undefined) return null;
    if (depth === segments.length - 1) return entry.mode === '40000' ? null : entry.oid;
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/** Set (or, with blobOid null, remove) a path in a tree, writing new trees; answers the new root tree oid. */
export function treeSet(
  repo: RepoRec,
  treeOid: string | null,
  segments: readonly string[],
  blobOid: string | null,
  mode = '100644',
): string {
  const entries: TreeEntry[] = treeOid === null ? [] : parseTree((repo.objects.get(treeOid) as GitObject).data);
  const head = segments[0];
  const kept = entries.filter((entry) => entry.name !== head);
  if (segments.length === 1) {
    if (blobOid !== null) kept.push({ mode, name: head, oid: blobOid });
  } else {
    const existing = entries.find((entry) => entry.name === head && entry.mode === '40000');
    const child = treeSet(repo, existing === undefined ? null : existing.oid, segments.slice(1), blobOid, mode);
    kept.push({ mode: '40000', name: head, oid: child });
  }
  return putObject(repo, 'tree', buildTree(kept));
}

/** A path -> blob oid snapshot of a whole tree (for merges and comparisons). */
export function flattenTree(repo: RepoRec, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const entries = parseTreeCached(repo, treeOid);
  if (entries === null) return out;
  for (const entry of entries) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [childPath, child] of flattenTree(repo, entry.oid, path)) out.set(childPath, child);
    } else {
      out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  }
  return out;
}

/** Build a tree from a flattened path map. */
export function treeFromFlat(repo: RepoRec, flat: ReadonlyMap<string, { oid: string; mode: string }>): string {
  let root: string | null = null;
  const paths = [...flat.keys()].sort();
  for (const path of paths) {
    const entry = flat.get(path) as { oid: string; mode: string };
    root = treeSet(repo, root, path.split('/'), entry.oid, entry.mode);
  }
  if (root === null) root = putObject(repo, 'tree', buildTree([]));
  return root;
}

/** Commit a tree on top of parents with the given identity line and message. */
export function makeCommit(
  repo: RepoRec,
  input: { tree: string; parents: string[]; ident: string; message: string },
): string {
  const data = buildCommit({
    tree: input.tree,
    parents: input.parents,
    author: input.ident,
    committer: input.ident,
    message: input.message.endsWith('\n') ? input.message : `${input.message}\n`,
  });
  return putObject(repo, 'commit', data);
}

// ---------------------------------------------------------------------------
// packfiles

/** Serialise objects into a complete packfile (version 2, no deltas). */
export function buildPack(repo: RepoRec, oids: Iterable<string>): Buffer {
  const list = [...oids];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'utf8');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const oid of list) {
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    const compressed = deflateSync(object.data);
    let size = object.data.length;
    const first = ((TYPE_CODES[object.type] & 0x07) << 4) | (size & 0x0f);
    size >>= 4;
    const bytes: number[] = [];
    if (size > 0) {
      bytes.push(first | 0x80);
      while (size > 0) {
        let byte = size & 0x7f;
        size >>= 7;
        if (size > 0) byte |= 0x80;
        bytes.push(byte);
      }
    } else {
      bytes.push(first);
    }
    parts.push(Buffer.from(bytes));
    parts.push(compressed);
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset];
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  readVarint(); // base size
  const targetSize = readVarint();
  const out: Buffer[] = [];
  while (offset < delta.length) {
    const op = delta[offset];
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset |= delta[offset] << (8 * bit);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          copySize |= delta[offset] << (8 * bit);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
    } else if (op > 0) {
      out.push(delta.subarray(offset, offset + op));
      offset += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize) throw new Error('delta size mismatch');
  return result;
}

export interface ParsedPack {
  objects: { oid: string; type: GitObjectType; data: Buffer }[];
  count: number;
}

/**
 * Inflate exactly one zlib stream starting at `offset` and answer its data plus its byte length.
 * Node's sync inflate ignores trailing bytes but reports no consumed count, so the stream's end
 * is found by binary search: the shortest slice that inflates successfully is the stream itself
 * (a truncated DEFLATE stream always throws; the format's final-block bit ends it exactly).
 */
function inflateOne(pack: Buffer, offset: number): { data: Buffer; length: number } {
  const rest = pack.length - offset;
  // Exponential probes bracket the stream's end quickly for the small objects packs carry,
  // then a binary search inside the bracket pins it exactly; the winning probe's own
  // inflation is the data, so nothing is inflated twice.
  let lo = 1;
  let hi = rest;
  let probe = 16;
  let data: Buffer | null = null;
  while (probe < rest) {
    try {
      data = inflateSync(pack.subarray(offset, offset + probe));
      hi = probe;
      break;
    } catch {
      lo = probe + 1;
      probe *= 4;
    }
  }
  if (data === null) data = inflateSync(pack.subarray(offset));
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(pack.subarray(offset, offset + mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return { data, length: lo };
}

/** Parse a packfile received over receive-pack, resolving ofs/ref deltas against the pack and the repo. */
export function parsePack(repo: RepoRec, pack: Buffer): ParsedPack {
  if (pack.length < 12 + 20 || pack.toString('utf8', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  let offset = 12;
  const raw: { type: GitObjectType | 'ofs' | 'ref'; data: Buffer; baseOffset?: number; baseOid?: string; start: number }[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = offset;
    let byte = pack[offset];
    offset += 1;
    const code = (byte >> 4) & 0x07;
    while (byte & 0x80) {
      byte = pack[offset];
      offset += 1;
    }
    if (code === 6) {
      let back = pack[offset];
      offset += 1;
      let value = back & 0x7f;
      while (back & 0x80) {
        back = pack[offset];
        offset += 1;
        value = ((value + 1) << 7) | (back & 0x7f);
      }
      const inflated = inflateOne(pack, offset);
      raw.push({ type: 'ofs', data: inflated.data, baseOffset: start - value, start });
      offset += inflated.length;
    } else if (code === 7) {
      const baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
      const inflated = inflateOne(pack, offset);
      raw.push({ type: 'ref', data: inflated.data, baseOid, start });
      offset += inflated.length;
    } else {
      const type = CODE_TYPES[code];
      if (type === undefined) throw new Error(`pack object code ${code}`);
      const inflated = inflateOne(pack, offset);
      raw.push({ type, data: inflated.data, start });
      offset += inflated.length;
    }
  }
  const byOffset = new Map<number, { oid: string; type: GitObjectType; data: Buffer }>();
  const resolved: { oid: string; type: GitObjectType; data: Buffer }[] = [];
  const resolve = (entry: (typeof raw)[number]): { oid: string; type: GitObjectType; data: Buffer } => {
    if (entry.type !== 'ofs' && entry.type !== 'ref') {
      const done = { oid: hashObject(entry.type, entry.data), type: entry.type, data: entry.data };
      byOffset.set(entry.start, done);
      return done;
    }
    let base: { type: GitObjectType; data: Buffer };
    if (entry.type === 'ofs') {
      const found = byOffset.get(entry.baseOffset as number);
      if (found === undefined) throw new Error('ofs delta base missing');
      base = found;
    } else {
      const inPack = resolved.find((candidate) => candidate.oid === entry.baseOid);
      const inRepo = inPack === undefined ? repo.objects.get(entry.baseOid as string) : undefined;
      if (inPack !== undefined) base = inPack;
      else if (inRepo !== undefined) base = inRepo;
      else throw new Error('ref delta base missing');
    }
    const data = applyDelta(base.data, entry.data);
    const done = { oid: hashObject(base.type, data), type: base.type, data };
    byOffset.set(entry.start, done);
    return done;
  };
  for (const entry of raw) {
    const done = resolve(entry);
    resolved.push(done);
  }
  return { objects: resolved, count };
}
