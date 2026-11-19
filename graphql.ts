// The GraphQL v4 surface (POST /api/graphql): a small, purpose-built executor for the
// documents gh and github-mcp-server send — viewer, repository reads, issue and pull-request
// reads, the create/close/merge/comment mutations, Relay node(id:), __type introspection and
// operation batching. No GraphQL library: a lexer, a parser, a schema-driven validator (an
// unknown field is a 200 with an errors array naming it, never an HTTP error) and a resolver
// walk over the one shared store, so every mutation lands in the same records REST reads.
//
// Deterministic by construction: global ids come from store.nodeId over the store's counters,
// cursors are encodings of issue numbers, and created entities are stamped with store.tick() —
// never the wall clock, never randomness.

import { getRepo, nodeId, parseNodeId, tick, type CommentRec, type IssueRec, type PullRec, type RepoRec, type Store } from './store.ts';
import { commitClosure, flattenTree, makeCommit, parseCommit, peelToCommit, treeFromFlat } from './gitobj.ts';

export interface Reply {
  status: number;
  headers?: Record<string, string>;
  body: string | Buffer;
}

// ---------------------------------------------------------------------------
// Small shared helpers.

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** An id argument as a string (GraphQL ID may arrive as a JSON string or number). */
function idString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** A GraphQL-level failure: answered 200 with an errors array, per the wire rules. */
class GqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GqlError';
  }
}

// ---------------------------------------------------------------------------
// Lexer.

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

const PUNCT = new Set(['{', '}', '(', ')', '[', ']', ':', '=', '$', '!', '@', '|', '&']);

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[_A-Za-z]/.test(c);
  const isNameChar = (c: string): boolean => /[_0-9A-Za-z]/.test(c);
  while (i < source.length) {
    const c = source[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if (PUNCT.has(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new ParseError('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      for (;;) {
        if (j >= source.length) throw new ParseError('unterminated string');
        const ch = source[j] as string;
        if (ch === '"') break;
        if (ch === '\\') {
          const esc = source[j + 1] as string;
          if (esc === 'u') {
            out += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
            continue;
          }
          const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          out += map[esc] ?? esc;
          j += 2;
          continue;
        }
        out += ch;
        j += 1;
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[-0-9]/.test(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      const text = source.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number.parseInt(text, 10) });
      i = j;
      continue;
    }
    throw new ParseError(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser: operations, fields with aliases and arguments, inline fragments,
// fragment definitions, variable definitions, and every literal value shape
// the suite sends (enums, lists, input objects, null, variables).

type ValueNode =
  | { t: 'var'; name: string }
  | { t: 'int'; value: number }
  | { t: 'float'; value: number }
  | { t: 'string'; value: string }
  | { t: 'bool'; value: boolean }
  | { t: 'null' }
  | { t: 'enum'; value: string }
  | { t: 'list'; items: ValueNode[] }
  | { t: 'object'; fields: { name: string; value: ValueNode }[] };

interface ArgumentNode {
  name: string;
  value: ValueNode;
}

type Selection =
  | { kind: 'field'; alias: string | null; name: string; args: ArgumentNode[]; selections: Selection[] }
  | { kind: 'inline'; typeCondition: string | null; selections: Selection[] }
  | { kind: 'spread'; name: string };

interface VarDef {
  name: string;
  defaultValue: ValueNode | null;
}

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  varDefs: VarDef[];
  selections: Selection[];
}

interface FragmentDef {
  typeCondition: string;
  selections: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, FragmentDef>;
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = lex(source);
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  private eatPunct(value: string): boolean {
    if (!this.atPunct(value)) return false;
    this.pos += 1;
    return true;
  }

  private expectPunct(value: string): void {
    if (!this.eatPunct(value)) throw new ParseError(`expected "${value}"`);
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new ParseError('expected a name');
    return token.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDef>();
    for (;;) {
      const token = this.peek();
      if (token.kind === 'eof') break;
      if (this.atPunct('{')) {
        operations.push({ type: 'query', name: null, varDefs: [], selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new ParseError('expected an operation or fragment definition');
      if (token.value === 'query' || token.value === 'mutation') {
        this.next();
        operations.push(this.parseOperation(token.value));
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new ParseError('expected "on" in a fragment definition');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(name, { typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      throw new ParseError(`unexpected definition "${token.value}"`);
    }
    if (operations.length === 0) throw new ParseError('the document holds no operation');
    return { operations, fragments };
  }

  private parseOperation(type: 'query' | 'mutation'): Operation {
    let name: string | null = null;
    if (this.peek().kind === 'name') name = this.expectName();
    const varDefs = this.atPunct('(') ? this.parseVarDefs() : [];
    this.skipDirectives();
    return { type, name, varDefs, selections: this.parseSelectionSet() };
  }

  private parseVarDefs(): VarDef[] {
    const defs: VarDef[] = [];
    this.expectPunct('(');
    while (!this.atPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.eatPunct('=')) defaultValue = this.parseValue();
      this.skipDirectives();
      defs.push({ name, defaultValue });
    }
    this.expectPunct(')');
    return defs;
  }

  private parseType(): void {
    if (this.eatPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.eatPunct('!');
  }

  private skipDirectives(): void {
    while (this.eatPunct('@')) {
      this.expectName();
      if (this.atPunct('(')) this.parseArguments();
    }
  }

  private parseArguments(): ArgumentNode[] {
    const args: ArgumentNode[] = [];
    this.expectPunct('(');
    while (!this.atPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseSelectionSet(): Selection[] {
    const selections: Selection[] = [];
    this.expectPunct('{');
    while (!this.atPunct('}')) {
      if (this.peek().kind === 'eof') throw new ParseError('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    if (this.eatPunct('...')) {
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      if (token.kind === 'name') {
        const name = this.expectName();
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      return { kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.eatPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args = this.atPunct('(') ? this.parseArguments() : [];
    this.skipDirectives();
    const selections = this.atPunct('{') ? this.parseSelectionSet() : [];
    return { kind: 'field', alias, name, args, selections };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'int') return { t: 'int', value: token.value };
    if (token.kind === 'float') return { t: 'float', value: token.value };
    if (token.kind === 'string') return { t: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { t: 'bool', value: true };
      if (token.value === 'false') return { t: 'bool', value: false };
      if (token.value === 'null') return { t: 'null' };
      return { t: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '$') return { t: 'var', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!this.atPunct(']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { t: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.atPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { t: 'object', fields };
    }
    throw new ParseError('expected a value');
  }
}

function parseDocument(source: string): Document {
  return new Parser(source).parseDocument();
}

/** Materialise an argument value: variables resolve from the operation's variable map. */
function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.t) {
    case 'var':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'bool':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((item) => evalValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) {
        const value = evalValue(field.value, variables);
        if (value !== undefined) out[field.name] = value;
      }
      return out;
    }
  }
}

type Args = Record<string, unknown>;

function evalArgs(list: ArgumentNode[], variables: Record<string, unknown>): Args {
  const out: Args = {};
  for (const arg of list) {
    const value = evalValue(arg.value, variables);
    if (value !== undefined) out[arg.name] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The schema: field -> return type per type. The validator walks documents
// against it (an unknown field is an error naming the field), the introspection
// answers are read off it, and the resolvers below cover exactly these fields.

const SCHEMA: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  Node: { id: 'ID' },
  User: { id: 'ID', login: 'String', name: 'String' },
  Repository: {
    id: 'ID',
    databaseId: 'Int',
    name: 'String',
    nameWithOwner: 'String',
    description: 'String',
    isPrivate: 'Boolean',
    createdAt: 'String',
    updatedAt: 'String',
    owner: 'User',
    defaultBranchRef: 'Ref',
    viewerPermission: 'String',
    hasIssuesEnabled: 'Boolean',
    issue: 'Issue',
    issues: 'IssueConnection',
    pullRequest: 'PullRequest',
    pullRequests: 'PullRequestConnection',
  },
  Ref: { name: 'String' },
  Issue: {
    id: 'ID',
    number: 'Int',
    title: 'String',
    body: 'String',
    state: 'String',
    author: 'User',
    createdAt: 'String',
    updatedAt: 'String',
    repository: 'Repository',
  },
  IssueConnection: { nodes: '[Issue]', pageInfo: 'PageInfo', totalCount: 'Int' },
  PageInfo: { hasNextPage: 'Boolean', hasPreviousPage: 'Boolean', startCursor: 'String', endCursor: 'String' },
  PullRequest: {
    id: 'ID',
    number: 'Int',
    title: 'String',
    body: 'String',
    state: 'String',
    merged: 'Boolean',
    mergeable: 'String',
    headRefName: 'String',
    baseRefName: 'String',
    author: 'User',
    createdAt: 'String',
    updatedAt: 'String',
    baseRef: 'Ref',
    headRef: 'Ref',
    files: 'PullRequestChangedFileConnection',
  },
  PullRequestConnection: { nodes: '[PullRequest]', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestChangedFileConnection: { nodes: '[PullRequestChangedFile]', totalCount: 'Int' },
  PullRequestChangedFile: { path: 'String', additions: 'Int', deletions: 'Int', changeType: 'String' },
  IssueComment: { id: 'ID', body: 'String', author: 'User', createdAt: 'String', updatedAt: 'String' },
  IssueCommentEdge: { node: 'IssueComment', cursor: 'String' },
  CreateIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CloseIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  MergePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge', clientMutationId: 'String' },
  __Type: { name: 'String', kind: 'String', description: 'String', fields: '[__Field]', enumValues: '[__EnumValue]' },
  __Field: { name: 'String', description: 'String' },
  __EnumValue: { name: 'String', description: 'String' },
};

/** Enum types and their values, for __type(name:) on an enum (SearchType must list ISSUE). */
const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

const SCALAR_TYPES = new Set(['String', 'Int', 'Float', 'Boolean', 'ID']);

function baseType(type: string): string {
  return type.replace(/[\[\]!\s]/g, '');
}

function validateSelections(typeName: string, selections: Selection[], doc: Document, errors: string[], depth: number): void {
  if (depth > 64) return;
  const fields = SCHEMA[typeName];
  for (const sel of selections) {
    if (sel.kind === 'field') {
      if (sel.name === '__typename') continue;
      const returned = fields === undefined ? undefined : fields[sel.name];
      if (returned === undefined) {
        errors.push(`Field '${sel.name}' doesn't exist on type '${typeName}'`);
        continue;
      }
      if (sel.selections.length > 0) validateSelections(baseType(returned), sel.selections, doc, errors, depth + 1);
    } else if (sel.kind === 'inline') {
      validateSelections(sel.typeCondition ?? typeName, sel.selections, doc, errors, depth + 1);
    } else {
      const fragment = doc.fragments.get(sel.name);
      if (fragment !== undefined) validateSelections(fragment.typeCondition, fragment.selections, doc, errors, depth + 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Store lookups by global id parts.

function findRepoByDbId(store: Store, dbId: number): RepoRec | null {
  for (const repo of store.repos.values()) if (repo.id === dbId) return repo;
  return null;
}

function findIssueByDbId(store: Store, dbId: number): { repo: RepoRec; issue: IssueRec } | null {
  for (const repo of store.repos.values()) {
    for (const issue of repo.issues.values()) if (issue.dbId === dbId) return { repo, issue };
  }
  return null;
}

function findPullByDbId(store: Store, dbId: number): { repo: RepoRec; pull: PullRec } | null {
  for (const repo of store.repos.values()) {
    for (const pull of repo.pulls.values()) if (pull.dbId === dbId) return { repo, pull };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Git-derived reads: branch tips, changed files, three-way merges. These read
// the repository's object map exactly as the git and REST surfaces leave it.

type FlatTree = Map<string, { oid: string; mode: string }>;

function refCommit(repo: RepoRec, branch: string): string | null {
  const oid = repo.refs.get(`refs/heads/${branch}`);
  if (oid === undefined) return null;
  return peelToCommit(repo, oid);
}

function commitTreeFlat(repo: RepoRec, commitOid: string): FlatTree {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return new Map();
  return flattenTree(repo, parseCommit(object.data).tree);
}

function blobLines(repo: RepoRec, oid: string): string[] {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'blob') return [];
  const text = object.data.toString('utf8');
  return text === '' ? [] : text.split('\n');
}

/** Line counts added/removed between two blob versions, by line-multiset difference. */
function lineDiff(repo: RepoRec, baseOid: string | undefined, headOid: string | undefined): { additions: number; deletions: number } {
  const count = (lines: string[]): Map<string, number> => {
    const map = new Map<string, number>();
    for (const line of lines) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const base = count(baseOid === undefined ? [] : blobLines(repo, baseOid));
  const head = count(headOid === undefined ? [] : blobLines(repo, headOid));
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of head) additions += Math.max(0, n - (base.get(line) ?? 0));
  for (const [line, n] of base) deletions += Math.max(0, n - (head.get(line) ?? 0));
  return { additions, deletions };
}

interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
  changeType: string;
}

/** The paths whose blob differs between the pull's base and head branch tips. */
function changedFiles(repo: RepoRec, pull: PullRec): ChangedFile[] {
  const baseTip = refCommit(repo, pull.baseRef);
  let headTip = refCommit(repo, pull.headRef);
  if (headTip === null && pull.headOid !== null) headTip = peelToCommit(repo, pull.headOid);
  if (baseTip === null || headTip === null) return [];
  const baseFlat = commitTreeFlat(repo, baseTip);
  const headFlat = commitTreeFlat(repo, headTip);
  const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
  const out: ChangedFile[] = [];
  for (const path of [...paths].sort()) {
    const base = baseFlat.get(path);
    const head = headFlat.get(path);
    if (base !== undefined && head !== undefined && base.oid === head.oid && base.mode === head.mode) continue;
    const diff = lineDiff(repo, base?.oid, head?.oid);
    out.push({
      path,
      additions: diff.additions,
      deletions: diff.deletions,
      changeType: base === undefined ? 'ADDED' : head === undefined ? 'DELETED' : 'MODIFIED',
    });
  }
  return out;
}

/** The newest commit that is an ancestor of both tips, or null when the histories are unrelated. */
function findMergeBase(repo: RepoRec, a: string, b: string): string | null {
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

function sameEntry(x: { oid: string; mode: string } | undefined, y: { oid: string; mode: string } | undefined): boolean {
  if (x === undefined || y === undefined) return x === y;
  return x.oid === y.oid && x.mode === y.mode;
}

/** Three-way merge of the head tree into the base tree over their merge base. */
function mergeFlats(repo: RepoRec, baseCommit: string, oursCommit: string, theirsCommit: string): { flat: FlatTree; conflict: boolean } {
  const base = commitTreeFlat(repo, baseCommit);
  const ours = commitTreeFlat(repo, oursCommit);
  const theirs = commitTreeFlat(repo, theirsCommit);
  const result: FlatTree = new Map(ours);
  let conflict = false;
  const paths = new Set<string>([...base.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const baseEntry = base.get(path);
    const oursEntry = ours.get(path);
    const theirsEntry = theirs.get(path);
    if (sameEntry(theirsEntry, baseEntry)) continue; // the head did not touch it
    if (sameEntry(oursEntry, baseEntry)) {
      if (theirsEntry === undefined) result.delete(path);
      else result.set(path, theirsEntry);
    } else if (!sameEntry(oursEntry, theirsEntry)) {
      conflict = true;
    }
  }
  return { flat: result, conflict };
}

/** GitHub's mergeable verdict for an open pull: a clean three-way merge, a conflict, or unknown. */
function mergeableOf(repo: RepoRec, pull: PullRec): string {
  if (pull.merged || pull.state === 'closed') return 'UNKNOWN';
  const baseTip = refCommit(repo, pull.baseRef);
  const headTip = refCommit(repo, pull.headRef);
  if (baseTip === null || headTip === null) return 'UNKNOWN';
  const mergeBase = findMergeBase(repo, baseTip, headTip);
  if (mergeBase === null) return 'UNKNOWN';
  return mergeFlats(repo, mergeBase, baseTip, headTip).conflict ? 'CONFLICTING' : 'MERGEABLE';
}

// ---------------------------------------------------------------------------
// Object wrappers: the values the executor walks. Each carries its GraphQL
// type name; scalars travel as plain JS values.

interface RootObj {
  gqlType: 'Query' | 'Mutation';
}
interface UserObj {
  gqlType: 'User';
  login: string;
}
interface RepoObj {
  gqlType: 'Repository';
  repo: RepoRec;
}
interface RefObj {
  gqlType: 'Ref';
  name: string;
}
interface IssueObj {
  gqlType: 'Issue';
  repo: RepoRec;
  issue: IssueRec;
}
interface PullObj {
  gqlType: 'PullRequest';
  repo: RepoRec;
  pull: PullRec;
}
interface PageInfoObj {
  gqlType: 'PageInfo';
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}
interface IssueConnObj {
  gqlType: 'IssueConnection';
  nodes: IssueObj[];
  pageInfo: PageInfoObj;
  totalCount: number;
}
interface PullConnObj {
  gqlType: 'PullRequestConnection';
  nodes: PullObj[];
  pageInfo: PageInfoObj;
  totalCount: number;
}
interface FileObj {
  gqlType: 'PullRequestChangedFile';
  path: string;
  additions: number;
  deletions: number;
  changeType: string;
}
interface FileConnObj {
  gqlType: 'PullRequestChangedFileConnection';
  nodes: FileObj[];
  totalCount: number;
}
interface CommentObj {
  gqlType: 'IssueComment';
  comment: CommentRec;
}
interface CommentEdgeObj {
  gqlType: 'IssueCommentEdge';
  node: CommentObj;
  cursor: string;
}
interface CreateIssuePayloadObj {
  gqlType: 'CreateIssuePayload';
  issue: IssueObj;
  clientMutationId: string | null;
}
interface CloseIssuePayloadObj {
  gqlType: 'CloseIssuePayload';
  issue: IssueObj;
  clientMutationId: string | null;
}
interface CreatePullPayloadObj {
  gqlType: 'CreatePullRequestPayload';
  pullRequest: PullObj;
  clientMutationId: string | null;
}
interface MergePullPayloadObj {
  gqlType: 'MergePullRequestPayload';
  pullRequest: PullObj;
  clientMutationId: string | null;
}
interface AddCommentPayloadObj {
  gqlType: 'AddCommentPayload';
  commentEdge: CommentEdgeObj;
  clientMutationId: string | null;
}
interface TypeObj {
  gqlType: '__Type';
  typeName: string;
}
interface FieldObj {
  gqlType: '__Field';
  fieldName: string;
}
interface EnumValueObj {
  gqlType: '__EnumValue';
  valueName: string;
}

type GObj =
  | RootObj
  | UserObj
  | RepoObj
  | RefObj
  | IssueObj
  | PullObj
  | PageInfoObj
  | IssueConnObj
  | PullConnObj
  | FileObj
  | FileConnObj
  | CommentObj
  | CommentEdgeObj
  | CreateIssuePayloadObj
  | CloseIssuePayloadObj
  | CreatePullPayloadObj
  | MergePullPayloadObj
  | AddCommentPayloadObj
  | TypeObj
  | FieldObj
  | EnumValueObj;

function isGObj(value: unknown): value is GObj {
  return isRecord(value) && typeof value.gqlType === 'string';
}

function userObj(login: string): UserObj {
  return { gqlType: 'User', login };
}

function repoObj(repo: RepoRec): RepoObj {
  return { gqlType: 'Repository', repo };
}

function issueObj(repo: RepoRec, issue: IssueRec): IssueObj {
  return { gqlType: 'Issue', repo, issue };
}

function pullObj(repo: RepoRec, pull: PullRec): PullObj {
  return { gqlType: 'PullRequest', repo, pull };
}

/** A deterministic opaque id for a login (only the viewer's id is ever round-tripped). */
function userGlobalId(store: Store, login: string): string {
  if (login === store.viewer.login) return nodeId('User', store.viewer.id);
  let hash = 0x811c9dc5;
  for (let i = 0; i < login.length; i += 1) {
    hash ^= login.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return nodeId('User', (hash >>> 0) % 900_000 + 1);
}

// ---------------------------------------------------------------------------
// Connections: filtering, ordering and cursor paging.

function encodeCursor(key: number): string {
  return Buffer.from(`cursor:${key}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number | null {
  try {
    const match = /^cursor:(\d+)$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

interface Page<T> {
  slice: T[];
  pageInfo: PageInfoObj;
}

/** A `first`/`after` window over an ordered list; the cursor names an item's number key. */
function paginate<T>(items: readonly T[], args: Args, keyOf: (item: T) => number): Page<T> {
  let start = 0;
  const after = args.after;
  if (typeof after === 'string' && after !== '') {
    const key = decodeCursor(after);
    if (key !== null) {
      const index = items.findIndex((item) => keyOf(item) === key);
      if (index >= 0) start = index + 1;
    }
  }
  const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.floor(args.first)) : items.length;
  const slice = items.slice(start, start + first);
  return {
    slice,
    pageInfo: {
      gqlType: 'PageInfo',
      hasNextPage: start + slice.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: slice.length > 0 ? encodeCursor(keyOf(slice[0] as T)) : null,
      endCursor: slice.length > 0 ? encodeCursor(keyOf(slice[slice.length - 1] as T)) : null,
    },
  };
}

function stringList(value: unknown): string[] | null {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
  return null;
}

function issueConnection(repo: RepoRec, args: Args): IssueConnObj {
  let list = [...repo.issues.values()];
  const states = stringList(args.states);
  if (states !== null) {
    const wanted = new Set(states.map((state) => state.toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
  if (orderBy !== null) {
    // CREATED_AT DESC breaks createdAt ties by number DESC (ASC mirrors it), per the rules.
    const field = typeof orderBy.field === 'string' ? orderBy.field : 'CREATED_AT';
    const sign = orderBy.direction === 'ASC' ? 1 : -1;
    list.sort((a, b) => {
      let cmp: number;
      if (field === 'COMMENTS') cmp = a.comments.length - b.comments.length;
      else if (field === 'UPDATED_AT') cmp = a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0;
      else cmp = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
      if (cmp === 0) cmp = a.number - b.number;
      return cmp * sign;
    });
  } else {
    // No orderBy: creation order, so a first page is the first issues created.
    list.sort((a, b) => a.number - b.number);
  }
  const page = paginate(list, args, (issue) => issue.number);
  return {
    gqlType: 'IssueConnection',
    nodes: page.slice.map((issue) => issueObj(repo, issue)),
    pageInfo: page.pageInfo,
    totalCount: list.length,
  };
}

function pullConnection(repo: RepoRec, args: Args): PullConnObj {
  let list = [...repo.pulls.values()];
  const states = stringList(args.states);
  if (states !== null) {
    const wanted = new Set(states);
    list = list.filter((pull) => {
      if (pull.merged) return wanted.has('MERGED');
      return wanted.has(pull.state.toUpperCase());
    });
  }
  list.sort((a, b) => b.number - a.number);
  const page = paginate(list, args, (pull) => pull.number);
  return {
    gqlType: 'PullRequestConnection',
    nodes: page.slice.map((pull) => pullObj(repo, pull)),
    pageInfo: page.pageInfo,
    totalCount: list.length,
  };
}

function fileConnection(repo: RepoRec, pull: PullRec, args: Args): FileConnObj {
  const all = changedFiles(repo, pull);
  const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.floor(args.first)) : all.length;
  return {
    gqlType: 'PullRequestChangedFileConnection',
    nodes: all.slice(0, first).map((file) => ({ gqlType: 'PullRequestChangedFile' as const, ...file })),
    totalCount: all.length,
  };
}

// ---------------------------------------------------------------------------
// Mutations: each writes the store records REST reads, sharing the per-repo
// number sequence (repo.nextNumber) between issues and pull requests.

interface ExecCtx {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDef>;
}

function inputOf(args: Args): Record<string, unknown> {
  return isRecord(args.input) ? args.input : {};
}

function clientMutationIdOf(input: Record<string, unknown>): string | null {
  return typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
}

function repoFromGlobalId(store: Store, raw: unknown, what: string): RepoRec {
  const id = idString(raw);
  const parsed = id === null ? null : parseNodeId(id);
  const repo = parsed !== null && parsed.kind === 'Repository' ? findRepoByDbId(store, parsed.dbId) : null;
  if (repo === null) throw new GqlError(`Could not resolve to a Repository with the global id of '${stringOf(raw)}' for ${what}`);
  return repo;
}

function mutateCreateIssue(ctx: ExecCtx, args: Args): CreateIssuePayloadObj {
  const input = inputOf(args);
  const repo = repoFromGlobalId(ctx.store, input.repositoryId, 'createIssue');
  const stamp = tick(ctx.store);
  const issue: IssueRec = {
    number: repo.nextNumber,
    dbId: ctx.store.nextIssueDbId,
    title: stringOf(input.title),
    body: stringOf(input.body),
    state: 'open',
    labels: [],
    author: ctx.store.viewer.login,
    createdAt: stamp.iso,
    updatedAt: stamp.iso,
    comments: [],
    isPull: false,
  };
  repo.nextNumber += 1;
  ctx.store.nextIssueDbId += 1;
  repo.issues.set(issue.number, issue);
  return { gqlType: 'CreateIssuePayload', issue: issueObj(repo, issue), clientMutationId: clientMutationIdOf(input) };
}

function mutateCloseIssue(ctx: ExecCtx, args: Args): CloseIssuePayloadObj {
  const input = inputOf(args);
  const id = idString(input.issueId);
  const parsed = id === null ? null : parseNodeId(id);
  const found = parsed !== null && parsed.kind === 'Issue' ? findIssueByDbId(ctx.store, parsed.dbId) : null;
  if (found === null) throw new GqlError(`Could not resolve to an Issue with the global id of '${stringOf(input.issueId)}'`);
  found.issue.state = 'closed';
  found.issue.updatedAt = tick(ctx.store).iso;
  return { gqlType: 'CloseIssuePayload', issue: issueObj(found.repo, found.issue), clientMutationId: clientMutationIdOf(input) };
}

function mutateCreatePullRequest(ctx: ExecCtx, args: Args): CreatePullPayloadObj {
  const input = inputOf(args);
  const repo = repoFromGlobalId(ctx.store, input.repositoryId, 'createPullRequest');
  const headRef = stringOf(input.headRefName);
  const baseRef = stringOf(input.baseRefName);
  const stamp = tick(ctx.store);
  const pull: PullRec = {
    number: repo.nextNumber,
    dbId: ctx.store.nextIssueDbId,
    title: stringOf(input.title),
    body: stringOf(input.body),
    state: 'open',
    merged: false,
    headRef,
    baseRef,
    headOid: refCommit(repo, headRef),
    mergeCommitSha: null,
    author: ctx.store.viewer.login,
    createdAt: stamp.iso,
    updatedAt: stamp.iso,
    comments: [],
    isPull: true,
  };
  repo.nextNumber += 1;
  ctx.store.nextIssueDbId += 1;
  repo.pulls.set(pull.number, pull);
  return { gqlType: 'CreatePullRequestPayload', pullRequest: pullObj(repo, pull), clientMutationId: clientMutationIdOf(input) };
}

function mutateMergePullRequest(ctx: ExecCtx, args: Args): MergePullPayloadObj {
  const input = inputOf(args);
  const id = idString(input.pullRequestId);
  const parsed = id === null ? null : parseNodeId(id);
  const found = parsed !== null && parsed.kind === 'PullRequest' ? findPullByDbId(ctx.store, parsed.dbId) : null;
  if (found === null) throw new GqlError(`Could not resolve to a PullRequest with the global id of '${stringOf(input.pullRequestId)}'`);
  const { repo, pull } = found;
  if (!pull.merged) {
    const baseTip = refCommit(repo, pull.baseRef);
    const headTip = refCommit(repo, pull.headRef);
    if (baseTip !== null && headTip !== null) {
      const mergeBase = findMergeBase(repo, baseTip, headTip) ?? baseTip;
      const merged = mergeFlats(repo, mergeBase, baseTip, headTip);
      if (merged.conflict) throw new GqlError('Pull Request is not mergeable');
      const stamp = tick(ctx.store);
      const ident = `${ctx.store.viewer.name} <${ctx.store.viewer.email}> ${stamp.epochSec} +0000`;
      const parents = input.mergeMethod === 'MERGE' ? [baseTip, headTip] : [baseTip];
      const tree = treeFromFlat(repo, merged.flat);
      const sha = makeCommit(repo, { tree, parents, ident, message: pull.title });
      repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
      pull.mergeCommitSha = sha;
      pull.updatedAt = stamp.iso;
    } else {
      pull.updatedAt = tick(ctx.store).iso;
    }
    pull.merged = true;
    pull.state = 'closed';
  }
  return { gqlType: 'MergePullRequestPayload', pullRequest: pullObj(repo, pull), clientMutationId: clientMutationIdOf(input) };
}

function mutateAddComment(ctx: ExecCtx, args: Args): AddCommentPayloadObj {
  const input = inputOf(args);
  const id = idString(input.subjectId);
  const parsed = id === null ? null : parseNodeId(id);
  let comments: CommentRec[] | null = null;
  if (parsed !== null && parsed.kind === 'Issue') {
    const found = findIssueByDbId(ctx.store, parsed.dbId);
    if (found !== null) comments = found.issue.comments;
  } else if (parsed !== null && parsed.kind === 'PullRequest') {
    const found = findPullByDbId(ctx.store, parsed.dbId);
    if (found !== null) comments = found.pull.comments;
  }
  if (comments === null) throw new GqlError(`Could not resolve to a node with the global id of '${stringOf(input.subjectId)}'`);
  const stamp = tick(ctx.store);
  const comment: CommentRec = {
    id: ctx.store.nextCommentId,
    body: stringOf(input.body),
    author: ctx.store.viewer.login,
    createdAt: stamp.iso,
    updatedAt: stamp.iso,
  };
  ctx.store.nextCommentId += 1;
  comments.push(comment);
  return {
    gqlType: 'AddCommentPayload',
    commentEdge: {
      gqlType: 'IssueCommentEdge',
      node: { gqlType: 'IssueComment', comment },
      cursor: Buffer.from(`commentcursor:${comment.id}`, 'utf8').toString('base64url'),
    },
    clientMutationId: clientMutationIdOf(input),
  };
}

// ---------------------------------------------------------------------------
// Introspection and node resolution.

function typeObjFor(name: unknown): TypeObj | null {
  if (typeof name !== 'string') return null;
  if (SCHEMA[name] !== undefined || TYPE_ENUMS[name] !== undefined || SCALAR_TYPES.has(name)) {
    return { gqlType: '__Type', typeName: name };
  }
  return null;
}

function typeKind(name: string): string {
  if (TYPE_ENUMS[name] !== undefined) return 'ENUM';
  if (SCALAR_TYPES.has(name)) return 'SCALAR';
  if (name === 'Node') return 'INTERFACE';
  return 'OBJECT';
}

function resolveNode(ctx: ExecCtx, raw: unknown): GObj | null {
  const id = idString(raw);
  const parsed = id === null ? null : parseNodeId(id);
  if (parsed === null) return null;
  if (parsed.kind === 'Repository') {
    const repo = findRepoByDbId(ctx.store, parsed.dbId);
    return repo === null ? null : repoObj(repo);
  }
  if (parsed.kind === 'Issue') {
    const found = findIssueByDbId(ctx.store, parsed.dbId);
    return found === null ? null : issueObj(found.repo, found.issue);
  }
  if (parsed.kind === 'PullRequest') {
    const found = findPullByDbId(ctx.store, parsed.dbId);
    return found === null ? null : pullObj(found.repo, found.pull);
  }
  if (parsed.kind === 'User') {
    return parsed.dbId === ctx.store.viewer.id ? userObj(ctx.store.viewer.login) : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Field resolution. Every field SCHEMA names has exactly one case here.

function resolveField(ctx: ExecCtx, obj: GObj, field: string, args: Args): unknown {
  const store = ctx.store;
  switch (obj.gqlType) {
    case 'Query':
      switch (field) {
        case 'viewer':
          return userObj(store.viewer.login);
        case 'repository': {
          const repo = getRepo(store, stringOf(args.owner), stringOf(args.name));
          return repo === undefined ? null : repoObj(repo);
        }
        case 'node':
          return resolveNode(ctx, args.id);
        case '__type':
          return typeObjFor(args.name);
        default:
          return null;
      }
    case 'Mutation':
      switch (field) {
        case 'createIssue':
          return mutateCreateIssue(ctx, args);
        case 'closeIssue':
          return mutateCloseIssue(ctx, args);
        case 'createPullRequest':
          return mutateCreatePullRequest(ctx, args);
        case 'mergePullRequest':
          return mutateMergePullRequest(ctx, args);
        case 'addComment':
          return mutateAddComment(ctx, args);
        default:
          return null;
      }
    case 'User':
      switch (field) {
        case 'id':
          return userGlobalId(store, obj.login);
        case 'login':
          return obj.login;
        case 'name':
          return obj.login === store.viewer.login ? store.viewer.name : obj.login;
        default:
          return null;
      }
    case 'Repository': {
      const repo = obj.repo;
      switch (field) {
        case 'id':
          return nodeId('Repository', repo.id);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return repo.fullName;
        case 'description':
          return repo.description;
        case 'isPrivate':
          return repo.isPrivate;
        case 'createdAt':
          return repo.createdAt;
        case 'updatedAt':
          return repo.updatedAt;
        case 'owner':
          return userObj(repo.owner);
        case 'defaultBranchRef':
          return repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? { gqlType: 'Ref', name: repo.defaultBranch } : null;
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'issue': {
          const issue = typeof args.number === 'number' ? repo.issues.get(args.number) : undefined;
          return issue === undefined ? null : issueObj(repo, issue);
        }
        case 'issues':
          return issueConnection(repo, args);
        case 'pullRequest': {
          const pull = typeof args.number === 'number' ? repo.pulls.get(args.number) : undefined;
          return pull === undefined ? null : pullObj(repo, pull);
        }
        case 'pullRequests':
          return pullConnection(repo, args);
        default:
          return null;
      }
    }
    case 'Ref':
      return field === 'name' ? obj.name : null;
    case 'Issue': {
      const issue = obj.issue;
      switch (field) {
        case 'id':
          return nodeId('Issue', issue.dbId);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issue.state.toUpperCase();
        case 'author':
          return userObj(issue.author);
        case 'createdAt':
          return issue.createdAt;
        case 'updatedAt':
          return issue.updatedAt;
        case 'repository':
          return repoObj(obj.repo);
        default:
          return null;
      }
    }
    case 'IssueConnection':
      switch (field) {
        case 'nodes':
          return obj.nodes;
        case 'pageInfo':
          return obj.pageInfo;
        case 'totalCount':
          return obj.totalCount;
        default:
          return null;
      }
    case 'PageInfo':
      switch (field) {
        case 'hasNextPage':
          return obj.hasNextPage;
        case 'hasPreviousPage':
          return obj.hasPreviousPage;
        case 'startCursor':
          return obj.startCursor;
        case 'endCursor':
          return obj.endCursor;
        default:
          return null;
      }
    case 'PullRequest': {
      const pull = obj.pull;
      switch (field) {
        case 'id':
          return nodeId('PullRequest', pull.dbId);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged':
          return pull.merged;
        case 'mergeable':
          return mergeableOf(obj.repo, pull);
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'author':
          return userObj(pull.author);
        case 'createdAt':
          return pull.createdAt;
        case 'updatedAt':
          return pull.updatedAt;
        case 'baseRef':
          return { gqlType: 'Ref', name: pull.baseRef };
        case 'headRef':
          return { gqlType: 'Ref', name: pull.headRef };
        case 'files':
          return fileConnection(obj.repo, pull, args);
        default:
          return null;
      }
    }
    case 'PullRequestConnection':
      switch (field) {
        case 'nodes':
          return obj.nodes;
        case 'pageInfo':
          return obj.pageInfo;
        case 'totalCount':
          return obj.totalCount;
        default:
          return null;
      }
    case 'PullRequestChangedFileConnection':
      switch (field) {
        case 'nodes':
          return obj.nodes;
        case 'totalCount':
          return obj.totalCount;
        default:
          return null;
      }
    case 'PullRequestChangedFile':
      switch (field) {
        case 'path':
          return obj.path;
        case 'additions':
          return obj.additions;
        case 'deletions':
          return obj.deletions;
        case 'changeType':
          return obj.changeType;
        default:
          return null;
      }
    case 'IssueComment':
      switch (field) {
        case 'id':
          return nodeId('IssueComment', obj.comment.id);
        case 'body':
          return obj.comment.body;
        case 'author':
          return userObj(obj.comment.author);
        case 'createdAt':
          return obj.comment.createdAt;
        case 'updatedAt':
          return obj.comment.updatedAt;
        default:
          return null;
      }
    case 'IssueCommentEdge':
      switch (field) {
        case 'node':
          return obj.node;
        case 'cursor':
          return obj.cursor;
        default:
          return null;
      }
    case 'CreateIssuePayload':
      return field === 'issue' ? obj.issue : field === 'clientMutationId' ? obj.clientMutationId : null;
    case 'CloseIssuePayload':
      return field === 'issue' ? obj.issue : field === 'clientMutationId' ? obj.clientMutationId : null;
    case 'CreatePullRequestPayload':
      return field === 'pullRequest' ? obj.pullRequest : field === 'clientMutationId' ? obj.clientMutationId : null;
    case 'MergePullRequestPayload':
      return field === 'pullRequest' ? obj.pullRequest : field === 'clientMutationId' ? obj.clientMutationId : null;
    case 'AddCommentPayload':
      return field === 'commentEdge' ? obj.commentEdge : field === 'clientMutationId' ? obj.clientMutationId : null;
    case '__Type':
      switch (field) {
        case 'name':
          return obj.typeName;
        case 'kind':
          return typeKind(obj.typeName);
        case 'description':
          return null;
        case 'fields': {
          const fields = SCHEMA[obj.typeName];
          if (fields === undefined) return null;
          return Object.keys(fields).map((fieldName): FieldObj => ({ gqlType: '__Field', fieldName }));
        }
        case 'enumValues': {
          const values = TYPE_ENUMS[obj.typeName];
          if (values === undefined) return null;
          return values.map((valueName): EnumValueObj => ({ gqlType: '__EnumValue', valueName }));
        }
        default:
          return null;
      }
    case '__Field':
      return field === 'name' ? obj.fieldName : null;
    case '__EnumValue':
      return field === 'name' ? obj.valueName : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Execution: walk a selection set over a resolved object, honouring aliases
// and inline fragments (a fragment applies when its type condition names the
// object's type, or the Node interface every node type implements).

const NODE_TYPES = new Set(['Repository', 'Issue', 'PullRequest', 'IssueComment', 'User']);

function fragmentApplies(runtimeType: string, typeCondition: string | null): boolean {
  if (typeCondition === null) return true;
  if (typeCondition === runtimeType) return true;
  if (typeCondition === 'Node') return NODE_TYPES.has(runtimeType);
  return false;
}

function completeValue(ctx: ExecCtx, value: unknown, selections: Selection[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(ctx, entry, selections));
  if (isGObj(value)) {
    if (selections.length === 0) return null;
    return executeFields(ctx, value, selections);
  }
  return value;
}

function executeFields(ctx: ExecCtx, obj: GObj, selections: Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'field') {
      const key = sel.alias ?? sel.name;
      if (sel.name === '__typename') {
        out[key] = obj.gqlType;
        continue;
      }
      const args = evalArgs(sel.args, ctx.variables);
      const value = resolveField(ctx, obj, sel.name, args);
      out[key] = completeValue(ctx, value, sel.selections);
    } else if (sel.kind === 'inline') {
      if (fragmentApplies(obj.gqlType, sel.typeCondition)) Object.assign(out, executeFields(ctx, obj, sel.selections));
    } else {
      const fragment = ctx.fragments.get(sel.name);
      if (fragment !== undefined && fragmentApplies(obj.gqlType, fragment.typeCondition)) {
        Object.assign(out, executeFields(ctx, obj, fragment.selections));
      }
    }
  }
  return out;
}

function executeOperation(store: Store, raw: unknown): Record<string, unknown> {
  if (!isRecord(raw) || typeof raw.query !== 'string') {
    return { errors: [{ message: 'each operation must be an object with a string "query"' }] };
  }
  let doc: Document;
  try {
    doc = parseDocument(raw.query);
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operationName = typeof raw.operationName === 'string' ? raw.operationName : null;
  let operation: Operation | undefined;
  if (operationName !== null) operation = doc.operations.find((op) => op.name === operationName);
  else if (doc.operations.length === 1) operation = doc.operations[0];
  if (operation === undefined) {
    return {
      errors: [
        {
          message:
            operationName !== null
              ? `Unknown operation named "${operationName}"`
              : 'Must provide an operation name when the document holds more than one operation',
        },
      ],
    };
  }
  const variables: Record<string, unknown> = isRecord(raw.variables) ? { ...raw.variables } : {};
  for (const def of operation.varDefs) {
    if (variables[def.name] === undefined && def.defaultValue !== null) variables[def.name] = evalValue(def.defaultValue, variables);
  }
  const errors: string[] = [];
  validateSelections(operation.type === 'mutation' ? 'Mutation' : 'Query', operation.selections, doc, errors, 0);
  if (errors.length > 0) return { data: null, errors: errors.map((message) => ({ message })) };
  const ctx: ExecCtx = { store, variables, fragments: doc.fragments };
  const root: RootObj = { gqlType: operation.type === 'mutation' ? 'Mutation' : 'Query' };
  try {
    return { data: executeFields(ctx, root, operation.selections) };
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}

function jsonReply(status: number, payload: unknown): Reply {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(payload) };
}

/**
 * Answer one POST /api/graphql body. A single operation answers one envelope;
 * a JSON array of operations (GitHub's operation batching) answers an array of
 * envelopes in the same order. GraphQL-level failures are 200 with an errors
 * array; only a body that is not JSON at all is an HTTP 400.
 */
export function handleGraphQL(store: Store, body: Buffer): Reply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return jsonReply(400, { errors: [{ message: 'the request body is not valid JSON' }] });
  }
  if (Array.isArray(parsed)) return jsonReply(200, parsed.map((entry) => executeOperation(store, entry)));
  if (isRecord(parsed)) return jsonReply(200, executeOperation(store, parsed));
  return jsonReply(400, { errors: [{ message: 'the request body must be a JSON object or an array of operations' }] });
}
