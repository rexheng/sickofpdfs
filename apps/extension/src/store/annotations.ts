// The Phase 2 annotation methods of the store (contracts §3): marks, threads, comments and drafts.
//
// Wiring (Task 28's `createStoreApi`): `StoreApi extends AnnotationsApi`, and the object it returns spreads
// `createAnnotationsApi(db, deps)`. `protocol.ts` and `client.ts` serve and proxy `ANNOTATION_METHODS`.
//
// Rules this file keeps:
// - The store stamps `hlc` on every write and keeps `rev` as it is (0 for a new row); the caller's values are ignored.
// - A draft is a comment (or a new thread) with `draft_of_tab` set. Drafts never reach the outbox, `comments_fts` or a
//   published change. The only way in is `saveDraft`. The ways out: `sendDraft`; a `writeAnnotations` upsert of the same id
//   with `draftOfTab` null (the session sends a note as one batch: mark, thread, comment), which turns the stored draft
//   live in place; and `discardDraft`.
// - Sent text is never overwritten by a draft, and a draft is never overwritten by another tab.
// - JSON columns (`anchor`, `meta`) are stored and returned as they are, so fields this version does not know survive.
// - Every write is one transaction, and a change event is published only after it commits.

import type { Author, CommentId, CommentRow, DocumentId, HlcStamp, MarkId, MarkRow, TabId, ThreadId, ThreadRow } from '@sop/core';
import { isReadOnly, type SqlDb, type SqlValue } from './schema-v2';

export type AnnotationTable = 'marks' | 'threads' | 'comments';

/** One write. `row` is the full row; `table` says which kind it is (contracts §3). */
export interface AnnotationOp {
  table: AnnotationTable;
  op: 'upsert' | 'soft-delete' | 'restore';
  row: MarkRow | ThreadRow | CommentRow;
}

/** The change events this file publishes: a subtype of contracts §4's `StoreChange`. */
export interface AnnotationChange {
  table: AnnotationTable | 'page_figures';
  ids: string[];
  op: 'upsert' | 'delete';
  documentId: DocumentId;
  origin?: 'tab' | 'sync' | 'restore';
  tabId?: TabId;
}

export interface AnnotationsApi {
  /** Live, non-draft rows of one document. */
  listAnnotations(documentId: DocumentId): Promise<{ marks: MarkRow[]; threads: ThreadRow[]; comments: CommentRow[] }>;
  /**
   * One transaction. `o.tabId` goes into the published events so the writing tab can ignore its own echo.
   * Upserting a thread or comment whose id is a stored draft (and whose row has `draftOfTab` null) sends it: the draft marker
   * is cleared on that same row, so the draft and the live note are never both there and the text is never absent.
   */
  writeAnnotations(ops: AnnotationOp[], o?: { tabId?: TabId }): Promise<void>;
  /** Saves (or updates) an unsent comment, with its new thread when there is one. Publishes nothing and queues nothing. */
  saveDraft(row: CommentRow & { draftOfTab: TabId }, thread?: ThreadRow): Promise<void>;
  /** Clears `draft_of_tab` on the comment and its new thread in one transaction. Sending twice is harmless. */
  sendDraft(commentId: CommentId): Promise<void>;
  listDrafts(documentId: DocumentId, tabId: TabId): Promise<CommentRow[]>;
  /** Hands the drafts of tabs that are gone to `tabId`. Returns the comments it adopted. */
  claimDrafts(documentId: DocumentId, tabId: TabId, liveTabs: TabId[]): Promise<CommentRow[]>;
  /** Addition to the contract: the new threads of a tab's drafts, so a restored draft knows where it sits. */
  listDraftThreads(documentId: DocumentId, tabId: TabId): Promise<ThreadRow[]>;
  /** Addition to the contract: deletes an unsent draft (and its new thread). Does nothing to a comment that was sent. */
  discardDraft(commentId: CommentId): Promise<void>;
}

/** The method names `protocol.ts` serves and `client.ts` proxies. */
export const ANNOTATION_METHODS = [
  'listAnnotations',
  'writeAnnotations',
  'saveDraft',
  'sendDraft',
  'listDrafts',
  'claimDrafts',
  'listDraftThreads',
  'discardDraft',
] as const satisfies readonly (keyof AnnotationsApi)[];

export type AnnotationErrorCode =
  | 'read-only'
  | 'bad-row'
  | 'not-found'
  | 'not-a-draft'
  | 'draft-owned-elsewhere'
  | 'use-save-draft'
  | 'document-missing'
  | 'thread-missing'
  | 'immutable-field';

/** The message starts with the code, so it can still be told apart after it crosses a message port as plain text. */
export class AnnotationStoreError extends Error {
  readonly code: AnnotationErrorCode;
  constructor(code: AnnotationErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'AnnotationStoreError';
    this.code = code;
  }
}

/** Errors that retrying cannot fix. Works on the error object and on its text after a port. */
export function isPermanentAnnotationError(e: unknown): boolean {
  const text = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  return /\b(read-only|bad-row|not-a-draft|draft-owned-elsewhere|use-save-draft|document-missing|thread-missing|immutable-field): /.test(text);
}

export interface AnnotationDeps {
  now(): number;
  hlc: { tick(): HlcStamp };
  publish(c: AnnotationChange): void;
}

type Row = Record<string, SqlValue>;
const DOC_ID = /^[0-9a-f]{64}$/;
const MARK_KINDS = new Set(['text', 'area', 'figure']);
const ANCHOR_KINDS = new Set(['text', 'area', 'figure', 'point', 'page', 'document']);

function fail(code: AnnotationErrorCode, message: string): never {
  throw new AnnotationStoreError(code, message);
}

/** Runs `f` and returns its result as a promise, so a thrown error is a rejection and never a throw at the call site. */
function attempt<T>(f: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    try {
      resolve(f());
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

// ---- reading cells -----------------------------------------------------------------------------------------------------

function text(r: Row, col: string): string {
  const v = r[col];
  if (typeof v !== 'string') throw new Error(`column ${col} is not text`);
  return v;
}
function num(r: Row, col: string): number {
  const v = r[col];
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  throw new Error(`column ${col} is not a number`);
}
function numOrNull(r: Row, col: string): number | null {
  return r[col] == null ? null : num(r, col);
}
function textOrNull(r: Row, col: string): string | null {
  return r[col] == null ? null : text(r, col);
}

function markFromRow(r: Row): MarkRow {
  return {
    id: text(r, 'id') as MarkId,
    documentId: text(r, 'document_id') as DocumentId,
    style: text(r, 'style') as MarkRow['style'],
    color: numOrNull(r, 'color') as MarkRow['color'],
    anchor: JSON.parse(text(r, 'anchor')) as MarkRow['anchor'],
    pageIndex: num(r, 'page_index'),
    sortKey: num(r, 'sort_key'),
    author: text(r, 'author') as Author,
    createdAt: num(r, 'created_at'),
    updatedAt: num(r, 'updated_at'),
    deletedAt: numOrNull(r, 'deleted_at'),
    rev: num(r, 'rev'),
    hlc: text(r, 'hlc'),
  };
}

function threadFromRow(r: Row): ThreadRow {
  return {
    id: text(r, 'id') as ThreadId,
    documentId: text(r, 'document_id') as DocumentId,
    anchor: JSON.parse(text(r, 'anchor')) as ThreadRow['anchor'],
    pageIndex: numOrNull(r, 'page_index'),
    sortKey: numOrNull(r, 'sort_key'),
    placement: text(r, 'placement') as ThreadRow['placement'],
    draftOfTab: textOrNull(r, 'draft_of_tab') as TabId | null,
    createdAt: num(r, 'created_at'),
    updatedAt: num(r, 'updated_at'),
    deletedAt: numOrNull(r, 'deleted_at'),
    rev: num(r, 'rev'),
    hlc: text(r, 'hlc'),
  };
}

function commentFromRow(r: Row): CommentRow {
  return {
    id: text(r, 'id') as CommentId,
    threadId: text(r, 'thread_id') as ThreadId,
    documentId: text(r, 'document_id') as DocumentId,
    author: text(r, 'author') as Author,
    body: text(r, 'body'),
    draftOfTab: textOrNull(r, 'draft_of_tab') as TabId | null,
    meta: JSON.parse(text(r, 'meta')) as CommentRow['meta'],
    createdAt: num(r, 'created_at'),
    editedAt: numOrNull(r, 'edited_at'),
    deletedAt: numOrNull(r, 'deleted_at'),
    rev: num(r, 'rev'),
    hlc: text(r, 'hlc'),
  };
}

/** Maps rows, skipping (and counting) a row whose JSON cannot be read. The row stays in the database untouched. */
function mapRows<T>(rows: Row[], map: (r: Row) => T, what: string): T[] {
  const out: T[] = [];
  let skipped = 0;
  for (const r of rows) {
    try {
      out.push(map(r));
    } catch {
      skipped += 1;
    }
  }
  if (skipped > 0) console.warn(`sickofpdfs: ${skipped} ${what} could not be read and were left as they are`);
  return out;
}

// ---- checking what comes in --------------------------------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function checkCommon(row: { id: unknown; documentId: unknown; createdAt: unknown }, what: string): void {
  if (!nonEmpty(row.id)) fail('bad-row', `${what} has no id`);
  if (typeof row.documentId !== 'string' || !DOC_ID.test(row.documentId)) fail('bad-row', `${what} has no document`);
  if (!isFiniteNum(row.createdAt)) fail('bad-row', `${what} has no created time`);
}

function checkMark(row: MarkRow): void {
  checkCommon(row, 'mark');
  if (!isObject(row.anchor) || !MARK_KINDS.has(String(row.anchor.kind))) fail('bad-row', 'a mark needs a text, area or figure anchor');
  if (!isInt(row.pageIndex) || !isFiniteNum(row.sortKey)) fail('bad-row', 'mark position is not a number');
  if (!isFiniteNum(row.updatedAt)) fail('bad-row', 'mark has no updated time');
  if (row.author !== 'me' && row.author !== 'claude') fail('bad-row', 'mark author must be me or claude');
}

function checkThread(row: ThreadRow): void {
  checkCommon(row, 'thread');
  if (!isObject(row.anchor) || !ANCHOR_KINDS.has(String(row.anchor.kind))) fail('bad-row', 'thread has no anchor');
  if (row.pageIndex !== null && !isInt(row.pageIndex)) fail('bad-row', 'thread page is not a whole number');
  if (row.sortKey !== null && !isFiniteNum(row.sortKey)) fail('bad-row', 'thread sort key is not a number');
  if (row.placement !== 'placed' && row.placement !== 'unplaced') fail('bad-row', 'thread placement is not known');
  if (!isFiniteNum(row.updatedAt)) fail('bad-row', 'thread has no updated time');
}

function checkComment(row: CommentRow): void {
  checkCommon(row, 'comment');
  if (!nonEmpty(row.threadId)) fail('bad-row', 'comment has no thread');
  if (row.author !== 'me' && row.author !== 'claude') fail('bad-row', 'comment author must be me or claude');
  if (typeof row.body !== 'string') fail('bad-row', 'comment body is not text');
  if (!isObject(row.meta)) fail('bad-row', 'comment meta is not an object');
  if (row.editedAt !== null && !isFiniteNum(row.editedAt)) fail('bad-row', 'comment edited time is not a number');
}

// ---- the store -----------------------------------------------------------------------------------------------------------

export function createAnnotationsApi(db: SqlDb, deps: AnnotationDeps): AnnotationsApi {
  const one = (sql: string, bind: SqlValue[]): Row | undefined => db.selectObjects(sql, bind)[0];
  const run = (sql: string, bind: SqlValue[]): void => void db.exec({ sql, bind });

  const assertWritable = (): void => {
    if (isReadOnly(db)) fail('read-only', 'Update sickofpdfs. This library was saved by a newer version, so it cannot be changed.');
  };

  const documentExists = (id: string): boolean => one('SELECT 1 AS x FROM documents WHERE id = ?', [id]) !== undefined;

  /** Collects what a transaction touched, so one event per table and document goes out after the commit. */
  const touched = new Map<string, AnnotationChange>();
  const touch = (table: AnnotationTable, documentId: DocumentId, id: string, tabId?: TabId): void => {
    const key = `${table}\u0000${documentId}`;
    let c = touched.get(key);
    if (!c) {
      c = { table, ids: [], op: 'upsert', documentId, ...(tabId ? { tabId } : {}) };
      touched.set(key, c);
    }
    if (!c.ids.includes(id)) c.ids.push(id);
  };
  const publishTouched = (): void => {
    const events = [...touched.values()];
    touched.clear();
    for (const e of events) {
      try {
        deps.publish(e);
      } catch {
        // The write is committed. A failed broadcast must not make it look failed; other tabs catch up on their next load.
      }
    }
  };

  /** Deletes an unsent draft comment, and its thread when that thread is a new one with nothing left in it. */
  const deleteDraftComment = (commentId: string, threadId: string): void => {
    run('DELETE FROM comments WHERE id = ? AND draft_of_tab IS NOT NULL', [commentId]);
    run(
      'DELETE FROM threads WHERE id = ? AND draft_of_tab IS NOT NULL AND NOT EXISTS (SELECT 1 FROM comments WHERE thread_id = threads.id)',
      [threadId],
    );
  };

  // -- marks --

  function writeMark(o: AnnotationOp, tabId: TabId | undefined): void {
    const row = o.row as MarkRow;
    checkMark(row);
    const now = deps.now();
    const cur = one('SELECT document_id, author FROM marks WHERE id = ?', [row.id]);
    if (cur) {
      if (cur.document_id !== row.documentId) fail('immutable-field', 'a mark cannot move to another document');
      if (cur.author !== row.author) fail('immutable-field', 'the author of a mark never changes');
      if (o.op === 'soft-delete') {
        run('UPDATE marks SET deleted_at = ?, updated_at = ?, hlc = ? WHERE id = ?', [row.deletedAt ?? now, now, deps.hlc.tick(), row.id]);
      } else if (o.op === 'restore') {
        run('UPDATE marks SET deleted_at = NULL, updated_at = ?, hlc = ? WHERE id = ?', [now, deps.hlc.tick(), row.id]);
      } else {
        run(
          `UPDATE marks SET style = ?, color = ?, anchor = ?, page_index = ?, sort_key = ?, updated_at = ?, deleted_at = ?, hlc = ? WHERE id = ?`,
          [row.style, row.color, JSON.stringify(row.anchor), row.pageIndex, row.sortKey, row.updatedAt, row.deletedAt, deps.hlc.tick(), row.id],
        );
      }
    } else {
      if (!documentExists(row.documentId)) fail('document-missing', 'marks are only stored for saved documents');
      const deletedAt = o.op === 'soft-delete' ? (row.deletedAt ?? now) : o.op === 'restore' ? null : row.deletedAt;
      run(
        `INSERT INTO marks (id, document_id, style, color, anchor, page_index, sort_key, author, created_at, updated_at, deleted_at, rev, hlc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        [row.id, row.documentId, row.style, row.color, JSON.stringify(row.anchor), row.pageIndex, row.sortKey, row.author, row.createdAt, row.updatedAt, deletedAt, deps.hlc.tick()],
      );
    }
    touch('marks', row.documentId, row.id, tabId);
  }

  // -- threads --

  function writeThread(o: AnnotationOp, tabId: TabId | undefined): void {
    const row = o.row as ThreadRow;
    checkThread(row);
    const now = deps.now();
    const cur = one('SELECT document_id, draft_of_tab FROM threads WHERE id = ?', [row.id]);
    if (row.draftOfTab != null) fail('use-save-draft', 'a thread with an unsent draft is written with saveDraft');
    if (cur?.draft_of_tab != null) {
      if (o.op === 'soft-delete') {
        // A draft was never synced, so deleting it leaves nothing to tell anyone about. It goes for good, with its comments.
        run('DELETE FROM comments WHERE thread_id = ? AND draft_of_tab IS NOT NULL', [row.id]);
        run('DELETE FROM threads WHERE id = ? AND draft_of_tab IS NOT NULL', [row.id]);
        return;
      }
      if (o.op === 'restore') fail('use-save-draft', 'this thread is an unsent draft; there is nothing to restore');
      // An upsert of a stored draft thread (this row is not a draft) sends it: same id, the draft marker cleared, and the
      // row queued for sync by the trigger, all in this transaction.
      if (cur.document_id !== row.documentId) fail('immutable-field', 'a thread cannot move to another document');
      run(
        `UPDATE threads SET draft_of_tab = NULL, anchor = ?, page_index = ?, sort_key = ?, placement = ?, updated_at = ?, deleted_at = ?, hlc = ? WHERE id = ?`,
        [JSON.stringify(row.anchor), row.pageIndex, row.sortKey, row.placement, row.updatedAt, row.deletedAt, deps.hlc.tick(), row.id],
      );
      touch('threads', row.documentId, row.id, tabId);
      return;
    }
    if (cur) {
      if (cur.document_id !== row.documentId) fail('immutable-field', 'a thread cannot move to another document');
      if (o.op === 'soft-delete') {
        run('UPDATE threads SET deleted_at = ?, updated_at = ?, hlc = ? WHERE id = ?', [row.deletedAt ?? now, now, deps.hlc.tick(), row.id]);
      } else if (o.op === 'restore') {
        run('UPDATE threads SET deleted_at = NULL, updated_at = ?, hlc = ? WHERE id = ?', [now, deps.hlc.tick(), row.id]);
      } else {
        run(
          `UPDATE threads SET anchor = ?, page_index = ?, sort_key = ?, placement = ?, updated_at = ?, deleted_at = ?, hlc = ? WHERE id = ?`,
          [JSON.stringify(row.anchor), row.pageIndex, row.sortKey, row.placement, row.updatedAt, row.deletedAt, deps.hlc.tick(), row.id],
        );
      }
    } else {
      if (!documentExists(row.documentId)) fail('document-missing', 'threads are only stored for saved documents');
      const deletedAt = o.op === 'soft-delete' ? (row.deletedAt ?? now) : o.op === 'restore' ? null : row.deletedAt;
      run(
        `INSERT INTO threads (id, document_id, anchor, page_index, sort_key, placement, draft_of_tab, created_at, updated_at, deleted_at, rev, hlc)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 0, ?)`,
        [row.id, row.documentId, JSON.stringify(row.anchor), row.pageIndex, row.sortKey, row.placement, row.createdAt, row.updatedAt, deletedAt, deps.hlc.tick()],
      );
    }
    touch('threads', row.documentId, row.id, tabId);
  }

  // -- comments --

  function writeComment(o: AnnotationOp, tabId: TabId | undefined): void {
    const row = o.row as CommentRow;
    checkComment(row);
    const now = deps.now();
    const cur = one('SELECT document_id, thread_id, author, draft_of_tab FROM comments WHERE id = ?', [row.id]);
    if (row.draftOfTab != null) fail('use-save-draft', 'an unsent draft is written with saveDraft');
    if (cur?.draft_of_tab != null) {
      if (o.op === 'soft-delete') {
        deleteDraftComment(row.id, text(cur, 'thread_id'));
        return;
      }
      if (o.op === 'restore') fail('use-save-draft', 'this comment is an unsent draft; there is nothing to restore');
      // An upsert of a stored draft (this row is not a draft) sends it: same id, the draft marker cleared, the final text
      // stored, and the row queued for sync and search by the triggers, all in this transaction.
      if (cur.document_id !== row.documentId || cur.thread_id !== row.threadId) fail('immutable-field', 'a comment cannot move to another thread');
      if (cur.author !== row.author) fail('immutable-field', 'the author of a comment never changes');
      run('UPDATE comments SET draft_of_tab = NULL, body = ?, meta = ?, edited_at = ?, deleted_at = ?, hlc = ? WHERE id = ?', [
        row.body,
        JSON.stringify(row.meta),
        row.editedAt,
        row.deletedAt,
        deps.hlc.tick(),
        row.id,
      ]);
      touch('comments', row.documentId, row.id, tabId);
      return;
    }
    if (cur) {
      if (cur.document_id !== row.documentId || cur.thread_id !== row.threadId) fail('immutable-field', 'a comment cannot move to another thread');
      if (cur.author !== row.author) fail('immutable-field', 'the author of a comment never changes');
      if (o.op === 'soft-delete') {
        run('UPDATE comments SET deleted_at = ?, hlc = ? WHERE id = ?', [row.deletedAt ?? now, deps.hlc.tick(), row.id]);
      } else if (o.op === 'restore') {
        run('UPDATE comments SET deleted_at = NULL, hlc = ? WHERE id = ?', [deps.hlc.tick(), row.id]);
      } else {
        run('UPDATE comments SET body = ?, meta = ?, edited_at = ?, deleted_at = ?, hlc = ? WHERE id = ?', [
          row.body,
          JSON.stringify(row.meta),
          row.editedAt,
          row.deletedAt,
          deps.hlc.tick(),
          row.id,
        ]);
      }
    } else {
      if (!documentExists(row.documentId)) fail('document-missing', 'comments are only stored for saved documents');
      if (!one('SELECT 1 AS x FROM threads WHERE id = ?', [row.threadId])) fail('thread-missing', 'the comment has no thread to sit in');
      const deletedAt = o.op === 'soft-delete' ? (row.deletedAt ?? now) : o.op === 'restore' ? null : row.deletedAt;
      run(
        `INSERT INTO comments (id, thread_id, document_id, author, body, draft_of_tab, meta, created_at, edited_at, deleted_at, rev, hlc)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 0, ?)`,
        [row.id, row.threadId, row.documentId, row.author, row.body, JSON.stringify(row.meta), row.createdAt, row.editedAt, deletedAt, deps.hlc.tick()],
      );
    }
    touch('comments', row.documentId, row.id, tabId);
  }

  return {
    listAnnotations: (documentId) =>
      attempt(() => {
        const marks = mapRows(
          db.selectObjects('SELECT * FROM marks WHERE document_id = ? AND deleted_at IS NULL ORDER BY page_index, sort_key, created_at, id', [documentId]),
          markFromRow,
          'marks',
        );
        const threads = mapRows(
          db.selectObjects(
            `SELECT * FROM threads WHERE document_id = ? AND deleted_at IS NULL AND draft_of_tab IS NULL
             ORDER BY page_index, sort_key, created_at, id`,
            [documentId],
          ),
          threadFromRow,
          'threads',
        );
        const comments = mapRows(
          db.selectObjects(
            'SELECT * FROM comments WHERE document_id = ? AND deleted_at IS NULL AND draft_of_tab IS NULL ORDER BY created_at, rowid',
            [documentId],
          ),
          commentFromRow,
          'comments',
        );
        return { marks, threads, comments };
      }),

    writeAnnotations: (ops, o) =>
      attempt(() => {
        assertWritable();
        for (const op of ops) {
          if (op.op !== 'upsert' && op.op !== 'soft-delete' && op.op !== 'restore') fail('bad-row', `unknown operation ${String(op.op)}`);
          if (op.table !== 'marks' && op.table !== 'threads' && op.table !== 'comments') fail('bad-row', `unknown table ${String(op.table)}`);
        }
        touched.clear();
        try {
          db.savepoint(() => {
            for (const op of ops) {
              if (op.table === 'marks') writeMark(op, o?.tabId);
              else if (op.table === 'threads') writeThread(op, o?.tabId);
              else writeComment(op, o?.tabId);
            }
            // Whatever the order of the ops, a note is sent whole: no sent comment may be left in a thread that is still a draft.
            const sentIds = [...touched.values()].filter((c) => c.table === 'comments').flatMap((c) => c.ids);
            if (sentIds.length > 0) {
              const stranded = one(
                `SELECT c.id FROM comments c JOIN threads t ON t.id = c.thread_id
                 WHERE c.id IN (${sentIds.map(() => '?').join(', ')}) AND c.draft_of_tab IS NULL AND t.draft_of_tab IS NOT NULL`,
                sentIds,
              );
              if (stranded) fail('bad-row', 'a sent comment cannot sit in a thread that is still a draft; send the thread in the same batch');
            }
          });
        } catch (e) {
          touched.clear();
          throw e;
        }
        publishTouched();
      }),

    saveDraft: (row, thread) =>
      attempt(() => {
        assertWritable();
        checkComment(row);
        if (!nonEmpty(row.draftOfTab)) fail('bad-row', 'a draft needs the tab that owns it');
        if (thread) {
          checkThread(thread);
          if (thread.id !== row.threadId || thread.documentId !== row.documentId) fail('bad-row', 'the draft and its thread do not belong together');
        }
        const tab = row.draftOfTab;
        db.savepoint(() => {
          if (!documentExists(row.documentId)) fail('document-missing', 'drafts are only stored for saved documents');

          const cur = one('SELECT document_id, thread_id, author, draft_of_tab FROM comments WHERE id = ?', [row.id]);
          if (cur) {
            // Sent text is never replaced by a draft, and one tab never takes a draft from another that is still alive.
            if (cur.draft_of_tab == null) fail('not-a-draft', 'this comment was already sent');
            if (cur.draft_of_tab !== tab) fail('draft-owned-elsewhere', 'another tab owns this draft');
            if (cur.document_id !== row.documentId || cur.thread_id !== row.threadId) fail('immutable-field', 'a draft cannot move to another thread');
            if (cur.author !== row.author) fail('immutable-field', 'the author of a comment never changes');
          }

          // The thread goes first: the comment's foreign key needs it.
          if (thread) {
            const curT = one('SELECT draft_of_tab FROM threads WHERE id = ?', [thread.id]);
            if (!curT) {
              run(
                `INSERT INTO threads (id, document_id, anchor, page_index, sort_key, placement, draft_of_tab, created_at, updated_at, deleted_at, rev, hlc)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?)`,
                [thread.id, thread.documentId, JSON.stringify(thread.anchor), thread.pageIndex, thread.sortKey, thread.placement, tab, thread.createdAt, thread.updatedAt, deps.hlc.tick()],
              );
            } else if (curT.draft_of_tab != null) {
              if (curT.draft_of_tab !== tab) fail('draft-owned-elsewhere', 'another tab owns this draft');
              run('UPDATE threads SET anchor = ?, page_index = ?, sort_key = ?, placement = ?, updated_at = ?, hlc = ? WHERE id = ?', [
                JSON.stringify(thread.anchor),
                thread.pageIndex,
                thread.sortKey,
                thread.placement,
                thread.updatedAt,
                deps.hlc.tick(),
                thread.id,
              ]);
            }
            // A thread that was already sent stays as it is: only a new thread is ever a draft.
          } else if (!one('SELECT 1 AS x FROM threads WHERE id = ?', [row.threadId])) {
            fail('thread-missing', 'the draft has no thread to sit in');
          }

          if (cur) {
            run('UPDATE comments SET body = ?, meta = ?, edited_at = ?, hlc = ? WHERE id = ?', [row.body, JSON.stringify(row.meta), row.editedAt, deps.hlc.tick(), row.id]);
          } else {
            run(
              `INSERT INTO comments (id, thread_id, document_id, author, body, draft_of_tab, meta, created_at, edited_at, deleted_at, rev, hlc)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?)`,
              [row.id, row.threadId, row.documentId, row.author, row.body, tab, JSON.stringify(row.meta), row.createdAt, row.editedAt, deps.hlc.tick()],
            );
          }
        });
      }),

    sendDraft: (commentId) =>
      attempt(() => {
        assertWritable();
        touched.clear();
        try {
          db.savepoint(() => {
            const c = one('SELECT thread_id, document_id, draft_of_tab FROM comments WHERE id = ?', [commentId]);
            if (!c) fail('not-found', 'there is no such draft');
            if (c.draft_of_tab == null) return; // already sent: a replayed request changes nothing
            const documentId = text(c, 'document_id') as DocumentId;
            const tabId = text(c, 'draft_of_tab') as TabId;
            const threadId = text(c, 'thread_id');
            const t = one('SELECT draft_of_tab FROM threads WHERE id = ?', [threadId]);
            // The thread first, so the outbox queues it before its comment.
            if (t?.draft_of_tab != null) {
              run('UPDATE threads SET draft_of_tab = NULL, updated_at = ?, hlc = ? WHERE id = ?', [deps.now(), deps.hlc.tick(), threadId]);
              touch('threads', documentId, threadId, tabId);
            }
            run('UPDATE comments SET draft_of_tab = NULL, hlc = ? WHERE id = ?', [deps.hlc.tick(), commentId]);
            touch('comments', documentId, commentId, tabId);
          });
        } catch (e) {
          touched.clear();
          throw e;
        }
        publishTouched();
      }),

    discardDraft: (commentId) =>
      attempt(() => {
        assertWritable();
        db.savepoint(() => {
          const c = one('SELECT thread_id, draft_of_tab FROM comments WHERE id = ?', [commentId]);
          // Not a draft (sent, or gone): nothing to do. Sent text is never deleted from here.
          if (!c || c.draft_of_tab == null) return;
          deleteDraftComment(commentId, text(c, 'thread_id'));
        });
      }),

    listDrafts: (documentId, tabId) =>
      attempt(() =>
        mapRows(
          db.selectObjects(
            `SELECT c.* FROM comments c JOIN threads t ON t.id = c.thread_id
             WHERE c.document_id = ? AND c.draft_of_tab = ? AND c.deleted_at IS NULL AND t.deleted_at IS NULL
             ORDER BY c.created_at, c.rowid`,
            [documentId, tabId],
          ),
          commentFromRow,
          'drafts',
        ),
      ),

    listDraftThreads: (documentId, tabId) =>
      attempt(() =>
        mapRows(
          db.selectObjects('SELECT * FROM threads WHERE document_id = ? AND draft_of_tab = ? AND deleted_at IS NULL ORDER BY created_at, id', [documentId, tabId]),
          threadFromRow,
          'draft threads',
        ),
      ),

    claimDrafts: (documentId, tabId, liveTabs) =>
      attempt(() => {
        assertWritable();
        // The caller's own tab is always alive, whatever the roll call said.
        const keep: SqlValue[] = [...new Set([tabId, ...liveTabs.filter((t) => typeof t === 'string' && t.length > 0)])];
        const marks = keep.map(() => '?').join(', ');
        let claimed: CommentRow[] = [];
        db.savepoint(() => {
          const ids = db
            .selectObjects(
              `SELECT c.id FROM comments c JOIN threads t ON t.id = c.thread_id
               WHERE c.document_id = ? AND c.draft_of_tab IS NOT NULL AND c.draft_of_tab NOT IN (${marks})
                 AND c.deleted_at IS NULL AND t.deleted_at IS NULL`,
              [documentId, ...keep],
            )
            .map((r) => text(r, 'id'));
          // The new threads of the same tabs move with them (a new note is a thread plus its first comment).
          const threadIds = db
            .selectObjects(
              `SELECT id FROM threads WHERE document_id = ? AND draft_of_tab IS NOT NULL AND draft_of_tab NOT IN (${marks}) AND deleted_at IS NULL`,
              [documentId, ...keep],
            )
            .map((r) => text(r, 'id'));
          for (const id of threadIds) run('UPDATE threads SET draft_of_tab = ?, hlc = ? WHERE id = ?', [tabId, deps.hlc.tick(), id]);
          for (const id of ids) run('UPDATE comments SET draft_of_tab = ?, hlc = ? WHERE id = ?', [tabId, deps.hlc.tick(), id]);
          if (ids.length > 0) {
            claimed = mapRows(
              db.selectObjects(`SELECT * FROM comments WHERE id IN (${ids.map(() => '?').join(', ')}) ORDER BY created_at, rowid`, ids),
              commentFromRow,
              'drafts',
            );
          }
        });
        return claimed;
      }),
  };
}
