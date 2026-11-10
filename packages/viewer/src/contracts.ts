// The shared shapes of the ViewerContext slots that later tasks fill: jump history (Task 24), find (Task 25) and the
// library save (Task 30). Task 23 declares them here so the viewer chrome can hold the slots before those tasks land;
// each task imports its interface from this file and does not declare it again. Types only.
import type { SaveState } from '@sop/core/save';
import type { LinkTarget, SearchHit } from './backend/types';

export type { SaveState };

/** Where the reader is: a page, how far down it (0 = its top, 1 = its bottom) and the zoom. */
export interface ViewPosition {
  pageIndex: number;
  /** 0–1 of the page's height. */
  offset: number;
  scale: number;
}

/**
 * Jumps inside the document (links, search results, next note), kept in the page's history so Back returns (Task 24).
 * Thumbnail and outline clicks are not jumps.
 */
export interface JumpHistory {
  jumpTo(target: LinkTarget & { kind: 'page' }, from: ViewPosition): void;
  dispose(): void;
}

export interface FindState {
  query: string;
  hits: SearchHit[];
  /** 0-based index into `hits`; −1 when there is none. */
  current: number;
  /** Every page has been searched. */
  complete: boolean;
  /** Every page has been searched and none has any text (a scan without recognised text): there is nothing to find. */
  noText?: boolean;
}

/** Ctrl+F (Task 25). */
export interface FindController {
  /** 150 ms debounce; searches from startPage(), wraps, streams hits; a new query cancels the old one. */
  setQuery(q: string): void;
  next(): SearchHit | null;
  previous(): SearchHit | null;
  readonly state: FindState;
  subscribe(cb: (s: FindState) => void): () => void;
  /** Phase 7: the page's text changed (its recognised text arrived): it is read again, and searched again for the open query. */
  refreshPage?(pageIndex: number): void;
  /** R108: the reader moved pages. The open search starts again, so its hits are in the new order. */
  orderChanged?(): void;
  dispose(): void;
}

/** The library save and its status chip (Task 30). */
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
  /**
   * R67 (a): completes a save the owner started in a tab that closed or crashed before it finished. Never with an Undo. R105b: `cause`
   * is what started it, from the tab's save-pending record; null when the record does not say, and then the save is not the owner's own
   * choice.
   */
  resumeSave?(o?: { cause: 'owner' | 'filter' | 'first-note' | 'first-mark' | null }): Promise<void>;
  /** R105b: what started the save running now (`busy === 'save'`), for the save-pending record; null when it is not known. */
  readonly savingCause?: 'owner' | 'filter' | 'first-note' | 'first-mark' | null;
}
