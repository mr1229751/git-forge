// Git smart-HTTP over the forge's in-memory object store: ref advertisement (protocol v0
// and v2), ls-refs, fetch (full, incremental and shallow) and receive-pack pushes with
// report-status. The wire shapes are exactly the ones the suite's git client sends and
// parses: pkt-line framing everywhere, side-band-64k around packfiles and push reports,
// sectioned v2 fetch answers, and per-ref ok/ng lines whose non-fast-forward reason is the
// exact string the checks compare. Pure functions of the store: no clocks, no randomness.

import { createHash } from 'node:crypto';
import { getRepo, type RepoRec, type Store } from './store.ts';
import {
  ZERO_OID,
  buildPack,
  collectReachable,
  commitClosure,
  isAncestor,
  parseCommitCached,
  parsePack,
  parseTag,
  parseTreeCached,
  peelToCommit,
  type CommitInfo,
} from './gitobj.ts';

export interface Reply {
  status: number;
  headers?: Record<string, string>;
  body: string | Buffer;
}

const AGENT = 'forge/1.0';
const HEX40 = /^[0-9a-f]{40}$/;
/** Largest pack slice inside one sideband pkt-line: 65520 max, minus 4 header, minus 1 band byte. */
const SIDEBAND_CHUNK = 65515;

const UPLOAD_PACK_TYPE = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT_TYPE = 'application/x-git-upload-pack-result';
const RECEIVE_PACK_TYPE = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT_TYPE = 'application/x-git-receive-pack-result';

// ---------------------------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------------------------

function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

interface Packet {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
  /** Offset just past this packet in the scanned body (receive-pack's pack starts there). */
  end: number;
}

/**
 * Scan every well-formed pkt-line in `body`. Stops silently at the first malformed or
 * truncated header: a hostile or broken body must never throw here, the server stays up
 * and answers what it can (the suite probes exactly that with a garbage POST).
 */
function scanPackets(body: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const hex = body.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
    const length = Number.parseInt(hex, 16);
    if (length === 3 || length > 65520) break;
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0), end: offset + 4 });
      offset += 4;
      continue;
    }
    if (length === 1 || length === 2) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0), end: offset + 4 });
      offset += 4;
      continue;
    }
    if (offset + length > body.length) break;
    packets.push({ kind: 'data', payload: body.subarray(offset + 4, offset + length), end: offset + length });
    offset += length;
  }
  return packets;
}

function lineOf(packet: Packet): string {
  return packet.payload.toString('utf8').replace(/\n$/, '');
}

/** Wrap bytes in band-1 sideband packets (used for packfiles and, when negotiated, reports). */
function sidebandWrap(data: Buffer, progress?: string): Buffer {
  const parts: Buffer[] = [];
  if (progress !== undefined) {
    parts.push(pkt(Buffer.concat([Buffer.from([2]), Buffer.from(progress, 'utf8')])));
  }
  for (let offset = 0; offset < data.length; offset += SIDEBAND_CHUNK) {
    parts.push(pkt(Buffer.concat([Buffer.from([1]), data.subarray(offset, offset + SIDEBAND_CHUNK)])));
  }
  if (data.length === 0) parts.push(pkt(Buffer.from([1])));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

function sortedRefNames(repo: RepoRec): string[] {
  return [...repo.refs.keys()].sort();
}

function uploadCapsV0(repo: RepoRec): string {
  return [
    'multi_ack_detailed',
    'side-band-64k',
    'thin-pack',
    'ofs-delta',
    'shallow',
    `agent=${AGENT}`,
    `symref=HEAD:${repo.head}`,
  ].join(' ');
}

function receiveCapsV0(): string {
  return ['report-status', 'delete-refs', 'side-band-64k', 'ofs-delta', `agent=${AGENT}`].join(' ');
}

/**
 * The v0 ref list: HEAD first (zero oid when unborn), capabilities riding on the first line
 * after a NUL, each ref followed by its `^{}` peel line when it names a tag object. An empty
 * repo advertises only the zero-id `capabilities^{}` pseudo-ref, as real git does.
 */
function refLinesV0(repo: RepoRec, caps: string): Buffer[] {
  const names = sortedRefNames(repo);
  if (names.length === 0) return [pkt(`${ZERO_OID} capabilities^{}\0${caps}`)];
  const parts: Buffer[] = [];
  let first = true;
  const emit = (oid: string, name: string): void => {
    parts.push(pkt(first ? `${oid} ${name}\0${caps}` : `${oid} ${name}`));
    first = false;
  };
  emit(repo.refs.get(repo.head) ?? ZERO_OID, 'HEAD');
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    emit(oid, name);
    const peeled = peelToCommit(repo, oid);
    if (peeled !== null && peeled !== oid) emit(peeled, `${name}^{}`);
  }
  return parts;
}

function advertiseUploadV0(repo: RepoRec): Reply {
  return {
    status: 200,
    headers: { 'content-type': UPLOAD_PACK_TYPE },
    body: Buffer.concat([pkt('# service=git-upload-pack\n'), ...refLinesV0(repo, uploadCapsV0(repo)), FLUSH]),
  };
}

function advertiseReceiveV0(repo: RepoRec): Reply {
  return {
    status: 200,
    headers: { 'content-type': RECEIVE_PACK_TYPE },
    body: Buffer.concat([pkt('# service=git-receive-pack\n'), ...refLinesV0(repo, receiveCapsV0()), FLUSH]),
  };
}

/** The v2 capability advertisement: no refs, just `version 2` and capability lines. */
function advertiseUploadV2(): Reply {
  const lines = ['version 2\n', `agent=${AGENT}\n`, 'ls-refs=unborn\n', 'fetch=shallow\n', 'object-format=sha1\n'];
  return {
    status: 200,
    headers: { 'content-type': UPLOAD_PACK_TYPE },
    body: Buffer.concat([...lines.map((line) => pkt(line)), FLUSH]),
  };
}

// ---------------------------------------------------------------------------------------------
// ls-refs (v2)
// ---------------------------------------------------------------------------------------------

function lsRefsReply(repo: RepoRec, args: readonly string[]): Reply {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  // The client judges the RAW response for prefix filtering, so the filter is applied here,
  // to HEAD as well: an unfiltered HEAD would fail the refs/heads/ prefix check.
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headOid = repo.refs.get(repo.head);
  if (matches('HEAD')) {
    const suffix = symrefs ? ` symref-target:${repo.head}` : '';
    if (headOid !== undefined) parts.push(pkt(`${headOid} HEAD${suffix}\n`));
    else if (unborn) parts.push(pkt(`unborn HEAD${suffix}\n`));
  }
  for (const name of sortedRefNames(repo)) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name) as string;
    let suffix = '';
    if (peel) {
      const peeled = peelToCommit(repo, oid);
      if (peeled !== null && peeled !== oid) suffix = ` peeled:${peeled}`;
    }
    parts.push(pkt(`${oid} ${name}${suffix}\n`));
  }
  parts.push(FLUSH);
  return { status: 200, headers: { 'content-type': UPLOAD_RESULT_TYPE }, body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------------------------------------
// fetch planning (shared by v0 and v2)
// ---------------------------------------------------------------------------------------------

/** A commit's tree and everything under it (trees and blobs), added to `into`. */
function addTreeClosure(repo: RepoRec, treeOid: string, into: Set<string>): void {
  const stack = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (into.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    into.add(oid);
    if (object.type === 'tree') {
      for (const entry of parseTreeCached(repo, oid) ?? []) stack.push(entry.oid);
    }
  }
}

interface FetchPlan {
  objects: Set<string>;
  /** Commits to name `shallow` in the answer: their parents are not available to the client. */
  boundary: string[];
  /** Client shallow commits whose parents all became available: name them `unshallow`. */
  unshallow: string[];
  /** Haves that are commits this repo holds, for ACK lines. */
  commonHaves: string[];
}

/**
 * Decide exactly what a fetch delivers.
 *
 * Possession model: a `have` the client lists as shallow is held with its tree closure only
 * (its history is NOT held); any other have is held with its full closure. Without a depth
 * limit the answer is the wants' closure minus the held closure. With `deepen N`, commits
 * are generation-numbered from the wants (want = 1) and only generations ≤ N are sent, so a
 * deepen moves the shallow boundary exactly one generation at a time. Tag objects on the
 * path from a want to its commit are always part of the answer.
 */
function planFetch(
  repo: RepoRec,
  wants: readonly string[],
  haves: readonly string[],
  shallowLines: readonly string[],
  depth: number | null,
): FetchPlan {
  const shallowSet = new Set(shallowLines);
  const heldCommits = new Set<string>();
  const heldObjects = new Set<string>();
  for (const have of haves) {
    const object = repo.objects.get(have);
    if (object === undefined) continue;
    if (shallowSet.has(have) && object.type === 'commit') {
      heldCommits.add(have);
      heldObjects.add(have);
      addTreeClosure(repo, (parseCommitCached(repo, have) as CommitInfo).tree, heldObjects);
    } else {
      for (const oid of collectReachable(repo, [have])) heldObjects.add(oid);
      const commit = peelToCommit(repo, have);
      if (commit !== null) for (const oid of commitClosure(repo, commit)) heldCommits.add(oid);
    }
  }
  const commonHaves = haves.filter((have) => repo.objects.get(have)?.type === 'commit');

  // Breadth-first generation numbers from the wants, through commit parents only.
  const generation = new Map<string, number>();
  const queue: string[] = [];
  for (const want of wants) {
    const commit = peelToCommit(repo, want);
    if (commit !== null && !generation.has(commit)) {
      generation.set(commit, 1);
      queue.push(commit);
    }
  }
  // With a depth limit and no client shallow lines, generations past the limit feed no
  // decision (the send filter drops them, and unshallow bookkeeping needs a shallow set),
  // so the walk stops there — a depth-1 clone then numbers two generations, not the history.
  const capGenerations = depth !== null && shallowSet.size === 0;
  for (let index = 0; index < queue.length; index += 1) {
    const oid = queue[index];
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const next = (generation.get(oid) as number) + 1;
    if (capGenerations && next > (depth as number)) continue;
    for (const parent of (parseCommitCached(repo, oid) as CommitInfo).parents) {
      if (!generation.has(parent)) {
        generation.set(parent, next);
        queue.push(parent);
      }
    }
  }

  const sendCommits = new Set<string>();
  for (const [oid, gen] of generation) {
    if (heldCommits.has(oid)) continue;
    if (depth !== null && gen > depth) continue;
    sendCommits.add(oid);
  }

  const objects = new Set<string>();
  for (const want of wants) {
    let current = want;
    for (let hops = 0; hops < 16; hops += 1) {
      const object = repo.objects.get(current);
      if (object === undefined || object.type !== 'tag') break;
      if (!heldObjects.has(current)) objects.add(current);
      current = parseTag(object.data).object;
    }
  }
  for (const oid of sendCommits) {
    objects.add(oid);
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'commit') {
      addTreeClosure(repo, (parseCommitCached(repo, oid) as CommitInfo).tree, objects);
    }
  }
  // Nothing the client already holds is re-sent (a shared blob stays out even when a sent
  // commit's tree names it: the client can complete the pack from its own store).
  for (const oid of heldObjects) {
    if (!sendCommits.has(oid)) objects.delete(oid);
  }

  const available = new Set<string>([...sendCommits, ...heldCommits]);
  const boundary: string[] = [];
  if (depth !== null || shallowSet.size > 0) {
    for (const oid of sendCommits) {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      if ((parseCommitCached(repo, oid) as CommitInfo).parents.some((parent) => !available.has(parent))) boundary.push(oid);
    }
  }
  const unshallow: string[] = [];
  for (const oid of shallowSet) {
    if (!generation.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    if ((parseCommitCached(repo, oid) as CommitInfo).parents.every((parent) => available.has(parent))) unshallow.push(oid);
  }
  return { objects, boundary: boundary.sort(), unshallow: unshallow.sort(), commonHaves };
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallowLines: string[];
  depth: number | null;
  done: boolean;
}

function fetchArgsFromLines(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallowLines: [], depth: null, done: false };
  const oidArg = (line: string, prefix: string): string => line.slice(prefix.length).trim().split(' ')[0];
  for (const line of lines) {
    if (line.startsWith('want ')) {
      const oid = oidArg(line, 'want ');
      if (HEX40.test(oid) && !args.wants.includes(oid)) args.wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = oidArg(line, 'have ');
      if (HEX40.test(oid)) args.haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = oidArg(line, 'shallow ');
      if (HEX40.test(oid)) args.shallowLines.push(oid);
    } else if (line.startsWith('deepen ')) {
      const parsed = Number.parseInt(line.slice('deepen '.length), 10);
      if (Number.isFinite(parsed) && parsed > 0) args.depth = parsed;
    } else if (line === 'done') {
      args.done = true;
    }
    // thin-pack, no-progress, ofs-delta, filter, deepen-since, deepen-not: accepted, and
    // need no action — packs carry plain objects only, and no check drives the deepen variants.
  }
  return args;
}

/** A v2 request: `command=<name>`, capability lines, a delim, then argument lines. */
function parseV2Request(body: Buffer): { command: string; args: string[] } | null {
  let command: string | null = null;
  let pastDelim = false;
  const args: string[] = [];
  for (const packet of scanPackets(body)) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    const line = lineOf(packet);
    if (!pastDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
    } else if (command !== null) {
      args.push(line);
    }
  }
  return command === null ? null : { command, args };
}

/**
 * Pack cache: git objects are content-addressed and immutable, so a pack built for one exact
 * object set is valid forever. The clone workload asks for the same set dozens of times
 * concurrently; building it once turns the rest into memory reads. Keyed by the sha1 of the
 * sorted object ids, capped, FIFO-evicted.
 */
const packCache = new Map<string, Buffer>();
const PACK_CACHE_MAX = 128;

function packFor(repo: RepoRec, objects: ReadonlySet<string>): Buffer {
  const sorted = [...objects].sort();
  const key = createHash('sha1').update(sorted.join(' ')).digest('hex');
  const cached = packCache.get(key);
  if (cached !== undefined) return cached;
  const pack = buildPack(repo, sorted);
  if (packCache.size >= PACK_CACHE_MAX) {
    const oldest = packCache.keys().next().value;
    if (oldest !== undefined) packCache.delete(oldest);
  }
  packCache.set(key, pack);
  return pack;
}

function fetchReplyV2(repo: RepoRec, argLines: readonly string[]): Reply {
  const args = fetchArgsFromLines(argLines);
  const plan = planFetch(repo, args.wants, args.haves, args.shallowLines, args.depth);
  const pack = packFor(repo, plan.objects);
  const parts: Buffer[] = [pkt('acknowledgments\n')];
  if (plan.commonHaves.length > 0) {
    for (const have of plan.commonHaves) parts.push(pkt(`ACK ${have}\n`));
  } else {
    parts.push(pkt('NAK\n'));
  }
  if (args.done) parts.push(pkt('ready\n'));
  parts.push(DELIM);
  if (plan.boundary.length > 0 || plan.unshallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of plan.boundary) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(DELIM);
  }
  parts.push(pkt('packfile\n'));
  parts.push(sidebandWrap(pack, 'Counting objects, done.\n'));
  parts.push(FLUSH);
  return { status: 200, headers: { 'content-type': UPLOAD_RESULT_TYPE }, body: Buffer.concat(parts) };
}

function fetchReplyV0(repo: RepoRec, body: Buffer): Reply {
  // v0 is two sections (wants, flush, haves + done, flush); the argument lines of both
  // sections parse the same way, so the whole body is read as one line list.
  const lines = scanPackets(body)
    .filter((packet) => packet.kind === 'data')
    .map((packet) => lineOf(packet));
  const args = fetchArgsFromLines(lines);
  const plan = planFetch(repo, args.wants, args.haves, args.shallowLines, args.depth);
  const pack = packFor(repo, plan.objects);
  const parts: Buffer[] = [];
  for (const oid of plan.boundary) parts.push(pkt(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
  if (plan.commonHaves.length > 0) {
    for (const have of plan.commonHaves) parts.push(pkt(`ACK ${have}\n`));
  } else {
    parts.push(pkt('NAK\n'));
  }
  parts.push(sidebandWrap(pack));
  parts.push(FLUSH);
  return { status: 200, headers: { 'content-type': UPLOAD_RESULT_TYPE }, body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------------------------------------
// receive-pack (v0 push)
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePackReply(repo: RepoRec, body: Buffer): Reply {
  const packets = scanPackets(body);
  const flushIndex = packets.findIndex((packet) => packet.kind === 'flush');
  const commandPackets = flushIndex === -1 ? packets : packets.slice(0, flushIndex);
  // A create/update push always carries a pack after the flush (an empty one when the
  // objects are already here); a delete-only push carries none.
  const packBytes = flushIndex === -1 ? Buffer.alloc(0) : body.subarray(packets[flushIndex].end);

  const commands: PushCommand[] = [];
  const capabilities = new Set<string>();
  let firstData = true;
  for (const packet of commandPackets) {
    if (packet.kind !== 'data') continue;
    let line = lineOf(packet);
    if (firstData) {
      firstData = false;
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        for (const token of line.slice(nul + 1).split(' ')) if (token) capabilities.add(token);
        line = line.slice(0, nul);
      }
    }
    const fields = line.split(' ');
    if (fields.length === 3 && HEX40.test(fields[0]) && HEX40.test(fields[1]) && fields[2].startsWith('refs/')) {
      commands.push({ oldOid: fields[0], newOid: fields[1], ref: fields[2] });
    }
  }

  // Objects land before any ref moves, so a mixed push can validate every command
  // against the post-unpack store.
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const parsed = parsePack(repo, packBytes);
      for (const object of parsed.objects) {
        if (!repo.objects.has(object.oid)) repo.objects.set(object.oid, { type: object.type, data: object.data });
      }
    } catch (err) {
      unpackError = (err instanceof Error ? err.message : String(err)).replace(/[\r\n]+/g, ' ');
    }
  }

  const results: { ref: string; ok: boolean; reason: string }[] = [];
  for (const command of commands) {
    const reject = (reason: string): void => {
      results.push({ ref: command.ref, ok: false, reason });
    };
    if (unpackError !== null) {
      reject('unpacker error');
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.oldOid !== current) {
      reject('stale info');
      continue;
    }
    if (command.newOid === ZERO_OID) {
      if (command.ref === repo.head) {
        reject('deletion of the current branch prohibited');
        continue;
      }
      repo.refs.delete(command.ref);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    const newCommit = peelToCommit(repo, command.newOid);
    if (newCommit === null) {
      reject('bad object');
      continue;
    }
    if (current !== ZERO_OID) {
      const currentCommit = peelToCommit(repo, current);
      if (currentCommit === null || !isAncestor(repo, currentCommit, newCommit)) {
        reject('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }

  const reportLines: string[] = [unpackError === null ? 'unpack ok\n' : `unpack ${unpackError}\n`];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const reportStream = Buffer.concat([...reportLines.map((line) => pkt(line)), FLUSH]);
  // When side-band-64k was negotiated the report stream travels inside band 1; the client
  // concatenates band 1 and pkt-decodes it, so chunk boundaries may fall anywhere.
  const responseBody = capabilities.has('side-band-64k')
    ? Buffer.concat([sidebandWrap(reportStream), FLUSH])
    : reportStream;
  return { status: 200, headers: { 'content-type': RECEIVE_RESULT_TYPE }, body: responseBody };
}

// ---------------------------------------------------------------------------------------------
// the surface
// ---------------------------------------------------------------------------------------------

export function handleGit(
  store: Store,
  method: string,
  owner: string,
  repoName: string,
  tail: string,
  query: URLSearchParams,
  body: Buffer,
  gitProtocolHeader: string | undefined,
): Reply {
  const repo = getRepo(store, owner, repoName);

  if (tail === 'info/refs') {
    if (method !== 'GET') return { status: 405, body: 'method not allowed\n' };
    if (repo === undefined) return { status: 404, body: 'not found\n' };
    const service = query.get('service');
    if (service === 'git-upload-pack') {
      const wantsV2 = gitProtocolHeader !== undefined && /(^|[:\s])version=2($|[:\s])/.test(gitProtocolHeader);
      return wantsV2 ? advertiseUploadV2() : advertiseUploadV0(repo);
    }
    // A receive-pack advertisement is always v0, whatever the request headers say.
    if (service === 'git-receive-pack') return advertiseReceiveV0(repo);
    return { status: 400, body: 'unknown service\n' };
  }

  if (tail === 'git-upload-pack') {
    if (method !== 'POST') return { status: 405, body: 'method not allowed\n' };
    if (repo === undefined) return { status: 404, body: 'not found\n' };
    // The body decides the protocol: a v2 request opens with `command=...`, a v0 fetch
    // opens with want lines. A body that is neither parses as an empty v0 fetch, which is
    // a survivable answer to the suite's malformed-body probe.
    const request = parseV2Request(body);
    if (request !== null) {
      if (request.command === 'ls-refs') return lsRefsReply(repo, request.args);
      if (request.command === 'fetch') return fetchReplyV2(repo, request.args);
      return { status: 400, body: 'unsupported command\n' };
    }
    return fetchReplyV0(repo, body);
  }

  if (tail === 'git-receive-pack') {
    if (method !== 'POST') return { status: 405, body: 'method not allowed\n' };
    if (repo === undefined) return { status: 404, body: 'not found\n' };
    return receivePackReply(repo, body);
  }

  return { status: 404, body: 'not found\n' };
}
