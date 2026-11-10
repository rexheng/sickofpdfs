// The seams between the Worker's areas (contract addition CA1). Types only: each slice implements one side and the others code
// against these. A change here is a contract change; ask the controller.

import type { Author, CommentRow, MarkRow, Sha256, ThreadRow } from '@sop/core';
import type { ChangeEntry, PullResponse, PushResponse } from '@sop/core/sync';
import type { Env } from './env';

/** Who is calling and what they may do. Set by the sign-in code (CL3) for every /api and /mcp request. */
export interface AuthContext {
  kind: 'bearer' | 'cookie';
  /** The numeric GitHub id. Checked against ALLOWED_GITHUB_ID at sign-in and again on every request. */
  uid: string;
  /** The OAuth client (null for the web's cookie session). */
  clientId: string | null;
  scopes: string[];
  /** The sync device this token was registered for (null for connectors and the cookie session until a device is chosen). */
  device: string | null;
}

/** The sync API (CL4). `mergeEntry` from `@sop/core/sync` decides each entry; this runs it in one D1 batch and assigns `seq`. */
export interface SyncService {
  /** The newest `seq`. */
  head(): Promise<number>;
  pull(since: number, limit: number): Promise<PullResponse>;
  /** `device` comes from the authenticated token, never from the body. The `claude` device is the connector. */
  push(device: string, entries: ChangeEntry[]): Promise<PushResponse>;
  /** Hard delete: the blob, the text, the notes and every row of the document (Forget, and Trash after 30 days). */
  purgeDocument(sha: Sha256): Promise<void>;
}

// ─── Library queries (CL5). Inside the Worker `Author` is 'me' | 'claude' and pages are 0-based; 'user' and 1-based pages
// ─── appear only at the MCP edge (CL6). The meaning is Phase 3's local queries (contracts §5).

/** A document as the library shows it: the synced columns, with `blobStored` meaning "the PDF is in R2". */
export interface DocumentSummary {
  id: Sha256;
  title: string | null;
  authors: string[];
  year: number | null;
  doi: string | null;
  arxivId: string | null;
  kind: 'paper' | 'book' | 'slides' | 'other';
  pageCount: number;
  byteSize: number;
  starred: boolean;
  hasText: boolean;
  blobStored: boolean;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface LibraryQuery {
  view: 'all' | 'recent' | 'starred' | 'trash';
  sort: { by: 'title' | 'lastOpened' | 'added' | 'pages'; dir: 'asc' | 'desc' };
  filter?: { starred?: boolean; hasNotes?: boolean; readFrom?: number; readTo?: number; kind?: DocumentSummary['kind'][]; titleContains?: string };
  limit: number;
  cursor?: string;
}

export interface LibraryItem {
  doc: DocumentSummary;
  firstOpened: number;
  lastOpened: number;
  readingMs: number;
  noteCount: number;
  locations: { kind: 'url' | 'file'; canonical: string }[];
}

export type SearchHit =
  | { kind: 'reading'; documentId: Sha256; title: string; snippet: string; rank: number }
  | { kind: 'page'; documentId: Sha256; pageIndex: number; snippet: string; rank: number }
  | { kind: 'note'; documentId: Sha256; threadId: string; commentId: string; author: Author; pageIndex: number | null; snippet: string; rank: number };

export interface ActivityItem {
  at: number;
  kind: 'opened' | 'added' | 'note' | 'claude-note';
  documentId: Sha256;
  title: string;
  pageIndex?: number;
  snippet?: string;
}

export interface QueryApi {
  /** Pages across every text shard merged by bm25, plus notes and titles. FTS input is split into quoted terms, never raw MATCH. */
  search(q: { text: string; documentId?: Sha256; kinds?: SearchHit['kind'][]; limit: number }): Promise<SearchHit[]>;
  listDocuments(q: LibraryQuery): Promise<{ items: LibraryItem[]; nextCursor: string | null; total: number }>;
  getDocument(id: Sha256): Promise<{ doc: DocumentSummary; locations: LibraryItem['locations']; notesByPage: Record<number, number>; textAvailable: boolean } | null>;
  /** `fromIndex`..`toIndex` inclusive, cut at `maxChars`; `nextFromIndex` continues. */
  readPages(id: Sha256, o: { fromIndex: number; toIndex: number; maxChars: number }): Promise<{ pages: { pageIndex: number; text: string }[]; nextFromIndex: number | null }>;
  getAnnotations(
    id: Sha256,
    o: { pageFrom?: number; pageTo?: number; author?: 'any' | Author; limit: number; cursor?: string },
  ): Promise<{ marks: MarkRow[]; threads: { thread: ThreadRow; comments: CommentRow[] }[]; nextCursor: string | null }>;
  recentActivity(o: { days: number; limit: number }): Promise<ActivityItem[]>;
  listNotes(o: { author?: Author; limit: number; cursor?: string }): Promise<{ items: { thread: ThreadRow; comments: CommentRow[]; title: string }[]; nextCursor: string | null }>;
}

// ─── Wiring (CL5/CL6 by interface, plugged in at merge) ──────────────────────────────────────────────────────────────────────
// CL3 and CL4 are built at the same time as the connector. Until their code is merged these two slots are empty and the
// connector refuses (401 without a sign-in; "writes are not ready" for comments). The slice that owns each side fills its slot
// once, at module load: CL3 sets `wiring.authenticate`, CL4 sets `wiring.syncService`. A CL3 middleware that already sets
// `c.get('auth')` makes the first slot unnecessary.

/** CL3's `authenticate(req, env)`: the signed-in owner, or the 401/403/429/503 Response to send back. */
export type Authenticate = (req: Request, env: Env) => Promise<AuthContext | Response>;

export const wiring: { authenticate: Authenticate | null; syncService: ((env: Env) => SyncService) | null } = {
  authenticate: null,
  syncService: null,
};
