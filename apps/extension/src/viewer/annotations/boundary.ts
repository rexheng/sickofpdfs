/**
 * The one seam between the annotation session and the slices that have not merged onto this branch.
 *
 * Everything the session consumes comes through this file. Three kinds of thing live here:
 *
 * 1. Core types (Anchor, MarkRow ...). They exist on this branch. They are re-exported by relative path because
 *    apps/extension does not depend on @sop/core yet (Task 20 adds it). Then these lines become
 *    `export type { ... } from '@sop/core'`.
 * 2. Copies of contract shapes whose owner has not merged: S3 (reanchor, marks), S7 (page text), S8 (drafts, tab
 *    presence), S2 and Task 28 (the store), Task 22 (CharRange), Task 23 and 30 (the save controller). Each one is
 *    copied word for word from docs/superpowers/contracts/2026-11-01-cross-phase-contracts.md or the plan, and names
 *    its owner. When the owner merges, replace the copy with an import from the owner and delete the copy.
 * 3. `planStyle` and `resolveAnchor`, re-exported from S3 (@sop/core). The session also takes optional `planStyle` and
 *    `resolveAnchor` in its dependencies, so tests and the wiring can pass any version.
 *
 * Nothing in this file has behaviour of its own.
 */

import type {
  Anchor,
  Author,
  CharPos,
  CommentId,
  CommentRow,
  DocumentId,
  MarkColor,
  MarkId,
  MarkRow,
  MarkStyle,
  NormRect,
  PageFigure,
  TabId,
  ThreadId,
  ThreadRow,
} from '../../../../../packages/core/src/index';
import type { PageGlyphs, PdfRect, SearchHit } from '../../../../../packages/viewer/src/backend/types';

export type {
  Anchor,
  Author,
  CharPos,
  CommentId,
  CommentRow,
  DocumentId,
  MarkColor,
  MarkId,
  MarkRow,
  MarkStyle,
  NormRect,
  PageFigure,
  TabId,
  ThreadId,
  ThreadRow,
};

// ---------------------------------------------------------------- Task 22 (text layer)

/** `end` is exclusive. */
export interface CharRange {
  pageIndex: number;
  start: number;
  end: number;
}

// ---------------------------------------------------------------- Task 23 and 30 (save decision)

export type SaveState =
  | { kind: 'checking' }
  | { kind: 'saved'; documentId: DocumentId; undoable: boolean }
  | { kind: 'unsure'; reasons: string[] }
  | { kind: 'not-learning'; reasons: string[] }
  | { kind: 'asking' }
  | { kind: 'memory-only' }
  | { kind: 'incognito' };

export interface SaveController {
  readonly state: SaveState;
  subscribe(cb: (s: SaveState) => void): () => void;
  start(): Promise<void>;
  requestSave(): Promise<void>;
  /**
   * R67 (c, f): `undoable: false` when the save carries note text, or more than one mark was made before it began.
   * `rows`: how many mark rows the first mark made; Undo removes no more than these (R67 tightened 1).
   */
  firstMark(o?: { undoable?: boolean; rows?: number; content?: boolean }): Promise<void>;
  undo(): Promise<void>;
  answerAsk(save: boolean): Promise<void>;
  // R67 additions (contracts §3, "Saving"). Optional, so a controller without them still fits.
  /** The effect running now ("Saving…" or Undo), if any. */
  readonly busy?: 'save' | 'forget' | null;
  /**
   * R67 (c): there is more than the first mark here (another mark, an open or typed note): no Undo, here or in any tab.
   * `content: false` for an empty note box (N1): it ends the Undo chip but is not content.
   */
  endUndo?(o?: { content?: boolean }): void;
  /** R67 tightened (1): this tab has content now: every other tab on this PDF, or on a copy still being identified, loses its Undo. */
  announce?(o?: { content?: boolean }): void;
  /** R67 tightened (4): a save left by a tab that closed or crashed is being finished (N2: its record stays while it asks). */
  readonly resuming?: boolean;
  /** R67 (b): the note that started this tab's save was emptied and closed before anything else was made: forget the save. */
  withdraw?(): Promise<void>;
  /** R67 (a): completes a save the owner started in a tab that closed or crashed before it finished. Never with an Undo. */
  resumeSave?(): Promise<void>;
}

// ---------------------------------------------------------------- S7 and S3 (text access, anchoring)

export interface PageTextProvider {
  source(pageIndex: number): string;
  text(pageIndex: number): Promise<string>;
  glyphs(pageIndex: number): Promise<PageGlyphs>;
  rects(pageIndex: number, start: number, count: number): Promise<PdfRect[]>;
  search(pageIndex: number, query: string, o: { matchCase: boolean; wholeWord: boolean }): Promise<SearchHit[]>;
}

export type PlacedBy = 'stored' | 'same-page' | 'fuzzy' | 'figure-match' | 'caption' | 'image';
export type Resolution =
  | { placed: true; by: PlacedBy; score: number; anchor: Anchor }
  | { placed: false; reason: 'quote-not-found' | 'below-threshold' | 'figure-not-found' | 'no-text' };

export interface AnchorContext {
  pageCount: number;
  text: PageTextProvider;
  figures(pageIndex: number): Promise<PageFigure[]>;
  dHash(pageIndex: number, rect: NormRect): Promise<string>;
}

export interface StylePlan {
  create: { style: MarkStyle; color: MarkColor | null; start: CharPos; end: CharPos }[];
  shrink: { id: MarkId; start: CharPos; end: CharPos }[];
  remove: MarkId[];
}

export type PlanStyleFn = (
  existing: readonly MarkRow[],
  target: { start: CharPos; end: CharPos },
  style: Exclude<MarkStyle, 'area'>,
  color: MarkColor | null,
) => StylePlan;
export type ResolveAnchorFn = (a: Anchor, ctx: AnchorContext) => Promise<Resolution>;

// S3 has merged: its two functions come from @sop/core (the S13 wiring also passes them to createAnnotationSession).
export { planStyle, resolveAnchor } from '@sop/core';

// ---------------------------------------------------------------- S2 and Task 28 (the store)

export type StoreTable =
  | 'documents'
  | 'aliases'
  | 'locations'
  | 'page_text'
  | 'history'
  | 'marks'
  | 'threads'
  | 'comments'
  | 'settings'
  | 'page_figures'
  | 'page_ocr'
  | 'tags'
  | 'reading_tags'
  | 'auto_tag_removed';
export interface StoreChange {
  table: StoreTable;
  ids: string[];
  op: 'upsert' | 'delete';
  documentId?: DocumentId;
  origin?: 'tab' | 'sync' | 'restore';
  tabId?: TabId;
}

export type AnnotationTable = 'marks' | 'threads' | 'comments';
export interface AnnotationOp {
  table: AnnotationTable;
  op: 'upsert' | 'soft-delete' | 'restore';
  row: MarkRow | ThreadRow | CommentRow;
}

/** What the session uses of StoreClient. A StoreClient is assignable to it. */
export interface SessionStore {
  listAnnotations(documentId: DocumentId): Promise<{ marks: MarkRow[]; threads: ThreadRow[]; comments: CommentRow[] }>;
  writeAnnotations(ops: AnnotationOp[], o?: { tabId?: TabId }): Promise<void>;
  onChange(cb: (c: StoreChange) => void): () => void;
}

// ---------------------------------------------------------------- S8 (drafts and tab presence)

export interface TabPresence {
  readonly tabId: TabId;
  liveTabs(timeoutMs?: number): Promise<TabId[]>;
  close(): void;
}

// S8 has merged: the keeper is its own (drafts.ts), with the R54 edit calls (changeEdit, dropEdit, editDrafts).
export type { DraftKeeper } from './drafts';
export type { EditDraft } from '../../store/annotations';
