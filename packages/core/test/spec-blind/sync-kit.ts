// Test support only (spec-blind tests for CL2, the pure sync protocol and merge). Written from contracts §7 and CA10,
// the Phase 5–6 plan's CL2 slice and its carried requirements (R57, replay memory), research 05 §3 and the published
// interface. It never saw the code.
//
// The CL2 functions are imported in this one place and re-typed locally with the shapes of the interface file, so the
// tests compile against whatever exact TypeScript types the implementation exports, as long as the names are there.
import * as sync from '../../src/sync/index';

// ---------------------------------------------------------------------------------------------------------------
// The published shapes (interface file), typed loosely on purpose

export type Wire = Record<string, unknown>;
export type Table = 'documents' | 'aliases' | 'locations' | 'marks' | 'threads' | 'comments' | 'history' | 'settings';

/** contracts §7 `ChangeEntry`. */
export interface Entry {
  table: Table;
  id: string;
  baseRev: number;
  hlc: string;
  row: Wire;
  label?: string;
}

/** What the server holds for one row: `{ table, id, rev, hlc, device, row }`, `row` in wire form. */
export interface ServerRow {
  table: Table;
  id: string;
  rev: number;
  hlc: string;
  device: string;
  row: Wire;
}

export interface MergeCtx {
  device: string;
  now: number;
  documentState?(id: string): 'known' | 'unknown' | 'forgotten';
  processedUpTo?(table: Table, id: string): string | null;
}

export interface ConflictCopy {
  table: 'comments';
  row: Wire;
  hlc: string;
  rev: number;
  of: string;
  device: string;
  createOnly: boolean;
}

export type Apply = { kind: 'apply'; row: Wire; hlc: string; rev: number; rebase: unknown; why: string; conflictCopy: ConflictCopy | null };
export type Noop = { kind: 'noop'; why: string; rebase: unknown; conflictCopy: ConflictCopy | null };
export type Reject = { kind: 'reject'; code: string; message: string; retryable: boolean };
export type MergeResult = Apply | Noop | Reject;

type MergeFn = (server: ServerRow | null, entry: Entry, ctx: MergeCtx) => MergeResult;
type ClampFn = (stamp: string, now: number, maxSkewMs?: number) => string;
type ReparentFn = (loser: string, winner: string, rows: ReparentRows) => Record<string, unknown>;

export interface ReparentRows {
  marks: Wire[];
  threads: Wire[];
  comments: Wire[];
  locations: Wire[];
  aliases: Wire[];
  history: Wire[];
}

export const mergeEntry = sync.mergeEntry as unknown as MergeFn;
export const clampHlc: ClampFn = sync.clampHlc;
export const planReparent = sync.planReparent as unknown as ReparentFn;

// ---------------------------------------------------------------------------------------------------------------
// Clocks and stamps: `${ms padded to 13}-${counter in hex padded to 4}-${device}` (Task 28's format)

/** 2 Nov 2026, 09:00 UTC. Every fixture stamp is near this. */
export const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);
/** The server's clock in the table tests: a day later, so no fixture stamp is ahead of it. */
export const NOW = T0 + 86_400_000;
export const MIN = 60_000;
export const SKEW_DEFAULT = 300_000;

export function stamp(ms: number, counter: number, device: string): string {
  return `${String(ms).padStart(13, '0')}-${counter.toString(16).padStart(4, '0')}-${device}`;
}
export const STAMP_RE = /^\d{13}-[0-9a-f]{4}-.+$/;
export const msOf = (s: string): number => Number(s.slice(0, 13));
export const counterOf = (s: string): number => parseInt(s.slice(14, 18), 16);
export const deviceOf = (s: string): string => s.slice(19);
export function compareStamps(a: string, b: string): number {
  return msOf(a) - msOf(b) || counterOf(a) - counterOf(b) || (deviceOf(a) < deviceOf(b) ? -1 : deviceOf(a) > deviceOf(b) ? 1 : 0);
}

// ---------------------------------------------------------------------------------------------------------------
// Ids and rows (wire form: camelCase, JSON columns parsed, no rev or hlc; documents leave without the local-only blobStored)

export const hex64 = (pair: string): string => pair.repeat(32);
export const DOC = hex64('d0');
export const THREAD = '7a000000-0000-4000-8000-000000000001';
export const uuid = (n: number, prefix = 'c'): string => `${prefix.padEnd(8, '0').slice(0, 8)}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

export function documentRow(id: string, o: Wire = {}): Wire {
  return {
    id, pageCount: 12, byteSize: 482_113, title: 'Do parallel trends hold?', authors: ['A. Author'], year: 2024, doi: null, arxivId: null,
    pdfId: null, kind: 'paper', hasText: true, encrypted: false, indexText: true, starred: false, saveReasons: ['learning'],
    createdAt: T0, updatedAt: T0, deletedAt: null, ...o,
  };
}

export function threadRow(o: Wire = {}): Wire {
  return {
    id: THREAD, documentId: DOC, anchor: { kind: 'page', page: 2 }, pageIndex: 2, sortKey: 0, placement: 'placed', draftOfTab: null,
    createdAt: T0, updatedAt: T0, deletedAt: null, ...o,
  };
}

export function commentRow(o: Wire & { id: string; body: string }): Wire {
  return {
    threadId: THREAD, documentId: DOC, author: 'me', draftOfTab: null, meta: {}, createdAt: T0, editedAt: null, deletedAt: null, ...o,
  };
}

export function claudeMeta(): Wire {
  return {
    kind: 'claude-reply', v: 1, role: null, status: 'done', error: null, questionId: null, citations: [], webSources: [], usage: null,
    scope: 'passages', figureLabels: [], via: 'connector',
  };
}

export function markRow(o: Wire & { id: string }): Wire {
  return {
    documentId: DOC, style: 'highlight', color: 1,
    anchor: { kind: 'text', quote: { quote: 'parallel trends', prefix: 'we test ', suffix: ' before' }, start: { page: 2, index: 120 }, end: { page: 2, index: 135 }, rects: [] },
    pageIndex: 2, sortKey: 0.31, author: 'me', createdAt: T0, updatedAt: T0, deletedAt: null, ...o,
  };
}

export function historyRow(documentId: string, o: Wire = {}): Wire {
  return {
    documentId, firstOpened: T0, lastOpened: T0, openCount: 1, readingMs: 0, lastPosition: null, pagesVisited: bitset([]), ...o,
  };
}

export function locationRow(o: Wire & { id: string }): Wire {
  return {
    documentId: DOC, kind: 'url', canonical: 'https://arxiv.org/pdf/2401.00001', raw: 'https://arxiv.org/pdf/2401.00001', viaPage: null,
    firstSeen: T0, lastSeen: T0, ...o,
  };
}

export function aliasRow(sha256: string, documentId: string, o: Wire = {}): Wire {
  return { sha256, documentId, similarity: 0.998, createdAt: T0, ...o };
}

export function entry(table: Table, id: string, baseRev: number, hlc: string, row: Wire, extra: Partial<Entry> = {}): Entry {
  return { table, id, baseRev, hlc, row, ...extra };
}

// ---------------------------------------------------------------------------------------------------------------
// pagesVisited: a base64 bitset, bit i = page i. The tests never depend on the bit order inside a byte: a union is a
// byte-wise OR whichever order the code uses, as long as it decodes and encodes the same way.

export function bitset(pages: number[]): string {
  const bytes = new Uint8Array(pages.length ? (Math.max(...pages) >> 3) + 1 : 0);
  for (const p of pages) bytes[p >> 3] |= 1 << (p & 7);
  return Buffer.from(bytes).toString('base64');
}
export function bytesOf(b64: unknown): number[] {
  const out = [...Buffer.from(typeof b64 === 'string' ? b64 : '', 'base64')];
  while (out.length && out[out.length - 1] === 0) out.pop();
  return out;
}
export function orBytes(...b64s: string[]): number[] {
  const all = b64s.map(bytesOf);
  const out = new Array<number>(Math.max(...all.map((b) => b.length))).fill(0);
  for (const b of all) b.forEach((v, i) => (out[i] |= v));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// A server that runs mergeEntry the way CL4 must (plan CL4 and the carried requirement on replay memory):
// - apply: store the row with the result's rev and hlc;
// - a conflict copy is created only if its id is new (`createOnly`);
// - after every apply or noop, remember entry.hlc per (device, table, id) and answer processedUpTo from it;
// - documentState: 'forgotten' for forgotten ids, 'known' when a documents row exists (trashed ones too), else 'unknown'.

const key = (table: string, id: string) => `${table}/${id}`;
const clone = <T>(v: T): T => structuredClone(v);

export interface Pushed {
  device: string;
  entry: Entry;
  result: MergeResult;
}

export class FakeServer {
  rows = new Map<string, ServerRow>();
  applied = new Map<string, string>();
  forgotten = new Set<string>();
  log: Pushed[] = [];
  constructor(private readonly o: { replayMemory?: boolean; documentState?: boolean } = {}) {}

  seed(table: Table, id: string, rev: number, hlc: string, device: string, row: Wire): this {
    this.rows.set(key(table, id), { table, id, rev, hlc, device, row: clone(row) });
    return this;
  }
  seedDocument(id = DOC): this {
    return this.seed('documents', id, 1, stamp(T0 - MIN, 0, 'devA'), 'devA', documentRow(id));
  }
  get(table: Table, id: string): ServerRow | null {
    return this.rows.get(key(table, id)) ?? null;
  }
  all(table: Table): ServerRow[] {
    return [...this.rows.values()].filter((r) => r.table === table);
  }
  ctx(device: string, now: number): MergeCtx {
    const ctx: MergeCtx = { device, now };
    if (this.o.documentState !== false) {
      ctx.documentState = (id) => (this.forgotten.has(id) ? 'forgotten' : this.rows.has(key('documents', id)) ? 'known' : 'unknown');
    }
    if (this.o.replayMemory !== false) {
      ctx.processedUpTo = (table, id) => this.applied.get(`${device}|${table}|${id}`) ?? null;
    }
    return ctx;
  }
  push(device: string, e: Entry, now: number = NOW): MergeResult {
    const k = key(e.table, e.id);
    const cur = this.rows.get(k) ?? null;
    const r = mergeEntry(cur ? clone(cur) : null, clone(e), this.ctx(device, now));
    if (r.kind === 'apply') this.rows.set(k, { table: e.table, id: e.id, rev: r.rev, hlc: r.hlc, device, row: clone(r.row) });
    if (r.kind !== 'reject' && r.conflictCopy) {
      const c = r.conflictCopy;
      const id = String(c.row.id);
      if (!this.rows.has(key('comments', id))) this.rows.set(key('comments', id), { table: 'comments', id, rev: c.rev, hlc: c.hlc, device: c.device, row: clone(c.row) });
    }
    if (r.kind !== 'reject') {
      const mk = `${device}|${e.table}|${e.id}`;
      const prev = this.applied.get(mk);
      if (!prev || compareStamps(e.hlc, prev) > 0) this.applied.set(mk, e.hlc);
    }
    this.log.push({ device, entry: clone(e), result: r });
    return r;
  }
  /** Every comment that is a conflict copy (meta.kind 'conflict-copy'). */
  copies(): ServerRow[] {
    return this.all('comments').filter((r) => (r.row.meta as Wire | undefined)?.kind === 'conflict-copy');
  }
  snapshot(): string {
    return JSON.stringify([...this.rows.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
  }
  fork(): FakeServer {
    const f = new FakeServer(this.o);
    f.rows = clone(this.rows);
    f.applied = clone(this.applied);
    f.forgotten = clone(this.forgotten);
    return f;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Tolerant readers for the parts of planReparent's result whose inner shape the interface leaves open
// (`moves`, `repointAliases` and `leftInPlace` may be ids, rows, `{ table, id }` items, or keyed by table).

const ID_RE = /^([0-9a-f]{64}|[0-9a-z]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
export function idsIn(x: unknown): Set<string> {
  const out = new Set<string>();
  const visit = (v: unknown): void => {
    if (typeof v === 'string') {
      if (ID_RE.test(v)) out.add(v);
      return;
    }
    if (Array.isArray(v)) return v.forEach(visit);
    if (v && typeof v === 'object') {
      const o = v as Wire;
      const row = o.row && typeof o.row === 'object' ? (o.row as Wire) : null;
      const id = o.id ?? o.rowId ?? o.sha256 ?? row?.id ?? row?.sha256;
      if (typeof id === 'string') {
        out.add(id);
        return;
      }
      Object.values(o).forEach(visit);
    }
  };
  visit(x);
  return out;
}

/** The document a move item says the row goes to, when the item says it. */
export function targetsIn(x: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(visit);
    if (v && typeof v === 'object') {
      const o = v as Wire;
      const row = o.row && typeof o.row === 'object' ? (o.row as Wire) : null;
      const t = o.documentId ?? o.to ?? row?.documentId;
      if (typeof t === 'string') out.push(t);
      else Object.values(o).forEach(visit);
    }
  };
  visit(x);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// A small seeded generator (mulberry32), so every random run can be replayed from its seed.

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
export function shuffle<T>(r: () => number, xs: readonly T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
