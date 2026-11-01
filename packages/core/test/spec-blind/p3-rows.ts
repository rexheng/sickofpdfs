// Test support only (spec-blind tests for Phase 3 packs T2 and T3: the Markdown export and the backup core). Written from
// the spec ("Library and knowledge base", "Viewer and commenting", "Storage, sync and backup"), contracts section 5 (and
// sections 2, 3 and 4 for the row shapes) and the Phase 3 plan's "Test packs" and "Contract additions". It never saw the code.
//
// Row builders only: camelCase rows as the library holds them (rows.ts), with every field filled in, so a test states only
// what it is about.
import type { HlcStamp } from '../../src/hlc';
import type { Author, CommentId, DocumentId, LocationId, MarkId, ThreadId } from '../../src/ids';
import type { Anchor, NormRect } from '../../src/model/anchor';
import type { ClaudeReplyMeta } from '../../src/claude/types';
import type { CommentMeta, CommentRow, DocumentRow, LocationRow, MarkColor, MarkRow, MarkStyle, ThreadRow } from '../../src/model/rows';

// ---------------------------------------------------------------------------------------------------------------
// Time and stamps. A stamp is `${ms padded to 13}-${counter in lower-case hex padded to 4}-${device}` (Task 28's format).

/** 2 Nov 2026, 09:00 UTC. Every fixture time is near this. */
export const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);
export const MIN = 60_000;
export const DAY = 86_400_000;

export function stamp(ms: number, device = 'dev-a', counter = 0): HlcStamp {
  return `${String(ms).padStart(13, '0')}-${counter.toString(16).padStart(4, '0')}-${device}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Ids

/** 64 lower-case hex characters made of a repeated byte pair, so a test can read which document it is. */
export const hex64 = (pair: string): DocumentId => pair.repeat(32) as DocumentId;
export const uuid = (n: number, kind = 'a'): string => `${kind.padEnd(8, '0').slice(0, 8)}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

export const DOC = hex64('d0');
export const OTHER_DOC = hex64('e1');

// ---------------------------------------------------------------------------------------------------------------
// Library rows

export function documentRow(id: DocumentId = DOC, o: Partial<DocumentRow> = {}): DocumentRow {
  return {
    id,
    pageCount: 12,
    byteSize: 482_113,
    title: 'Do Parallel Trends Hold?',
    authors: ['Ada Lovelace', 'Alan Turing'],
    year: 2024,
    doi: '10.1257/aer.20180779',
    arxivId: null,
    pdfId: null,
    kind: 'paper',
    hasText: true,
    encrypted: false,
    indexText: true,
    blobStored: true,
    starred: false,
    saveReasons: ['learning'],
    createdAt: T0,
    updatedAt: T0,
    deletedAt: null,
    rev: 1,
    hlc: stamp(T0),
    ...o,
  };
}

/** A synced location row: the schema gives `locations` a rev and an hlc like the other synced tables. */
export type LocationRowLike = LocationRow & { rev: number; hlc: HlcStamp };

export function locationRow(documentId: DocumentId, o: Partial<LocationRowLike> & { canonical: string }): LocationRowLike {
  const kind = o.kind ?? 'url';
  return {
    rev: 1,
    hlc: stamp(T0),
    id: (o.id ?? `${kind}-${o.canonical}`.padEnd(64, '0').slice(0, 64)) as LocationId,
    documentId,
    kind,
    raw: o.canonical,
    viaPage: null,
    firstSeen: T0,
    lastSeen: T0,
    ...o,
  };
}

/** The shapes below are the camelCase mirrors of the v1 columns (schema.ts) that rows.ts does not name. */
export interface AliasRowLike {
  sha256: string;
  documentId: DocumentId;
  similarity: number;
  createdAt: number;
  rev: number;
  hlc: HlcStamp;
}
export interface HistoryRowLike {
  documentId: DocumentId;
  firstOpened: number;
  lastOpened: number;
  openCount: number;
  readingMs: number;
  lastPosition: { page: number; offset: number; zoom: number } | null;
  /** triage: a base64 bitset, bit i = page i, as the sync wire and the backup format (`HistoryRow`) hold it. */
  pagesVisited: string;
  rev: number;
  hlc: HlcStamp;
}
export interface SettingRowLike {
  key: string;
  value: string;
  rev: number;
  hlc: HlcStamp;
}

export function aliasRow(sha256: string, documentId: DocumentId, o: Partial<AliasRowLike> = {}): AliasRowLike {
  return { sha256, documentId, similarity: 0.9991, createdAt: T0, rev: 1, hlc: stamp(T0), ...o };
}

export function historyRow(documentId: DocumentId, o: Partial<HistoryRowLike> = {}): HistoryRowLike {
  return {
    documentId,
    firstOpened: T0,
    lastOpened: T0 + 5 * MIN,
    openCount: 2,
    readingMs: 12 * MIN,
    lastPosition: { page: 3, offset: 0.25, zoom: 1 },
    pagesVisited: 'Dw==', // pages 0 to 3
    rev: 1,
    hlc: stamp(T0),
    ...o,
  };
}

export function settingRow(key: string, value: string, o: Partial<SettingRowLike> = {}): SettingRowLike {
  return { key, value, rev: 1, hlc: stamp(T0), ...o };
}

// ---------------------------------------------------------------------------------------------------------------
// Anchors, marks, threads and comments (contract section 2)

/** One line of text at height `y` (0 to 1) on a page. */
export const lineRect = (y: number, x0 = 0.1, x1 = 0.9): NormRect => [x0, y, x1, y + 0.02];

/** A text anchor on one page, `start`..`end` being PDFium char indices on that page. */
export function textAnchor(page: number, quote: string, o: { start?: number; end?: number; endPage?: number; y?: number } = {}): Anchor {
  const start = o.start ?? 100;
  const endPage = o.endPage ?? page;
  const rects = [{ page, rects: [lineRect(o.y ?? 0.2)] }];
  if (endPage !== page) rects.push({ page: endPage, rects: [lineRect(0.1)] });
  return {
    kind: 'text',
    quote: { quote, prefix: 'before ', suffix: ' after' },
    start: { page, index: start },
    end: { page: endPage, index: o.end ?? start + quote.length },
    rects,
  };
}

export interface MarkInput {
  id: string;
  documentId?: DocumentId;
  page: number;
  sortKey?: number;
  style?: MarkStyle;
  color?: MarkColor | null;
  quote?: string;
  anchor?: Anchor;
  createdAt?: number;
  deletedAt?: number | null;
  hlc?: HlcStamp;
  author?: Author;
}

export function markRow(m: MarkInput): MarkRow {
  const style = m.style ?? 'highlight';
  const sortKey = m.sortKey ?? 0.2;
  const anchor: Anchor =
    m.anchor ??
    (style === 'area'
      ? { kind: 'area', page: m.page, rect: [0.1, sortKey, 0.5, sortKey + 0.2], dHash: '0'.repeat(16) }
      : textAnchor(m.page, m.quote ?? `quote of ${m.id}`, { y: sortKey, start: Math.round(sortKey * 1000) }));
  return {
    id: m.id as MarkId,
    documentId: m.documentId ?? DOC,
    style,
    color: m.color !== undefined ? m.color : style === 'bold' || style === 'area' ? null : 1,
    anchor,
    pageIndex: m.page,
    sortKey,
    author: m.author ?? 'me',
    createdAt: m.createdAt ?? T0,
    updatedAt: m.createdAt ?? T0,
    deletedAt: m.deletedAt ?? null,
    rev: 1,
    hlc: m.hlc ?? stamp(m.createdAt ?? T0),
  };
}

export interface ThreadInput {
  id: string;
  documentId?: DocumentId;
  /** 0-based; omit for a document thread. */
  page?: number | null;
  sortKey?: number | null;
  anchor?: Anchor;
  quote?: string;
  createdAt?: number;
  deletedAt?: number | null;
  hlc?: HlcStamp;
}

export function threadRow(t: ThreadInput): ThreadRow {
  const page = t.page === undefined ? 0 : t.page;
  const sortKey = t.sortKey === undefined ? 0.2 : t.sortKey;
  const anchor: Anchor = t.anchor ?? (page === null ? { kind: 'document' } : textAnchor(page, t.quote ?? `quote of ${t.id}`, { y: sortKey ?? 0.2, start: Math.round((sortKey ?? 0.2) * 1000) }));
  return {
    id: t.id as ThreadId,
    documentId: t.documentId ?? DOC,
    anchor,
    pageIndex: page,
    sortKey: page === null ? null : sortKey,
    placement: 'placed',
    draftOfTab: null,
    createdAt: t.createdAt ?? T0,
    updatedAt: t.createdAt ?? T0,
    deletedAt: t.deletedAt ?? null,
    rev: 1,
    hlc: t.hlc ?? stamp(t.createdAt ?? T0),
  };
}

export interface CommentInput {
  id: string;
  documentId?: DocumentId;
  threadId: string;
  body: string;
  author?: Author;
  createdAt?: number;
  deletedAt?: number | null;
  meta?: CommentMeta;
  hlc?: HlcStamp;
}

export function commentRow(c: CommentInput): CommentRow {
  return {
    id: c.id as CommentId,
    threadId: c.threadId as ThreadId,
    documentId: c.documentId ?? DOC,
    author: c.author ?? 'me',
    body: c.body,
    draftOfTab: null,
    meta: c.meta ?? {},
    createdAt: c.createdAt ?? T0,
    editedAt: null,
    deletedAt: c.deletedAt ?? null,
    rev: 1,
    hlc: c.hlc ?? stamp(c.createdAt ?? T0),
  };
}

/** What Claude's reply carries beside its text (contract section 3). */
export function claudeMeta(o: Partial<ClaudeReplyMeta> = {}): ClaudeReplyMeta {
  return {
    kind: 'claude-reply',
    v: 1,
    role: 'default',
    status: 'done',
    error: null,
    questionId: null,
    citations: [],
    webSources: [],
    usage: null,
    scope: 'passages',
    figureLabels: [],
    via: 'viewer',
    ...o,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Freezing: a pure function must not edit what it is given

export function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

export function clone<T>(o: T): T {
  return structuredClone(o);
}
