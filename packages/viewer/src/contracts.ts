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

/** Jumps inside the document (links, outline, search results), kept in the page's history so Back returns (Task 24). */
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
}

/** Ctrl+F (Task 25). */
export interface FindController {
  /** 150 ms debounce; searches from startPage(), wraps, streams hits; a new query cancels the old one. */
  setQuery(q: string): void;
  next(): SearchHit | null;
  previous(): SearchHit | null;
  readonly state: FindState;
  subscribe(cb: (s: FindState) => void): () => void;
  dispose(): void;
}

/** The library save and its status chip (Task 30). */
export interface SaveController {
  readonly state: SaveState;
  subscribe(cb: (s: SaveState) => void): () => void;
  start(): Promise<void>;
  requestSave(): Promise<void>;
  firstMark(): Promise<void>;
  undo(): Promise<void>;
  answerAsk(save: boolean): Promise<void>;
}
