import type { ClaudeReplyMeta, ConflictCopyMeta } from '../claude/types';
import type { HlcStamp } from '../hlc';
import type { Author, CommentId, DocumentId, LocationId, LocationKind, MarkId, TabId, ThreadId } from '../ids';
import type { Anchor } from './anchor';

export type MarkStyle = 'highlight' | 'underline' | 'bold' | 'strike' | 'area';

/** A slot: tokens --sop-mark-1 … --sop-mark-5 in packages/ui. Hex values live only in the token file. */
export type MarkColor = 1 | 2 | 3 | 4 | 5;

interface Synced {
  rev: number;
  hlc: HlcStamp;
  deletedAt: number | null;
}

export interface MarkRow extends Synced {
  id: MarkId;
  documentId: DocumentId;
  style: MarkStyle;
  /** Null for bold and area. */
  color: MarkColor | null;
  /** 'text' | 'area' | 'figure'. */
  anchor: Anchor;
  pageIndex: number;
  sortKey: number;
  /** v2. Never changes after creation. */
  author: Author;
  createdAt: number;
  updatedAt: number;
}

export interface ThreadRow extends Synced {
  id: ThreadId;
  documentId: DocumentId;
  /** Any kind. */
  anchor: Anchor;
  pageIndex: number | null;
  sortKey: number | null;
  placement: 'placed' | 'unplaced';
  /** v2. Non-null means a new thread whose first comment is unsent. Never synced. */
  draftOfTab: TabId | null;
  createdAt: number;
  updatedAt: number;
}

export interface CommentRow extends Synced {
  id: CommentId;
  threadId: ThreadId;
  documentId: DocumentId;
  author: Author;
  /** Markdown. */
  body: string;
  draftOfTab: TabId | null;
  meta: CommentMeta;
  createdAt: number;
  editedAt: number | null;
}

/** '{}' for an owner comment. */
export type CommentMeta = Record<string, never> | ClaudeReplyMeta | ConflictCopyMeta;

// ---- the library (Phase 1, Task 28): camelCase mirrors of the v1 columns ----

export interface DocumentRow {
  id: DocumentId;
  pageCount: number;
  byteSize: number;
  title: string | null;
  authors: string[];
  year: number | null;
  doi: string | null;
  arxivId: string | null;
  /** The trailer /ID[0], as hex. */
  pdfId: string | null;
  kind: 'paper' | 'book' | 'slides' | 'other';
  hasText: boolean;
  encrypted: boolean;
  /** False when the owner asked for this document's text to stay out of search. */
  indexText: boolean;
  /** True when the PDF's bytes are kept in the extension's file storage. */
  blobStored: boolean;
  starred: boolean;
  saveReasons: string[];
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  rev: number;
  hlc: HlcStamp;
}

/** A place a document was opened from. Its id is the SHA-256 of `<kind>:<canonical>`. */
export interface LocationRow {
  id: LocationId;
  documentId: DocumentId;
  kind: LocationKind;
  canonical: string;
  /** For a web link, the link with tracking and session parts removed; for a file, its file URL. */
  raw: string;
  /** The canonical link of the page that led here (Referer or embedding page). */
  viaPage: string | null;
  firstSeen: number;
  lastSeen: number;
}

/** One search hit: a page of a library document. `snippet` marks matched words with <b>…</b>; split it, never render it as HTML. */
export interface PageHit {
  documentId: DocumentId;
  pageIndex: number;
  snippet: string;
  /** FTS5's bm25 score: lower is a better match, and hits come best first. */
  rank: number;
}

/** Row counts, for tests and the library's health check. */
export interface StoreStats {
  documents: number;
  aliases: number;
  locations: number;
  pageText: number;
  history: number;
  outbox: number;
}
