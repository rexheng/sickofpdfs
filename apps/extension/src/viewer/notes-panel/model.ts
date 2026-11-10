// What the notes panel lists, in what order, and how each note is labelled (plan S15). Pure: it reads the annotation
// session's state and nothing else.
//
// - Every thread is listed, the ones that could not be placed in this copy of the PDF included ("Couldn't place").
// - Order is the reading order of this copy: whole-document notes first, then by page, then top to bottom. A note
//   is ordered by where it was placed here (the in-memory Resolution), not by where it was stored.
// - R108: pages are in the order the owner put them in (the tab's page order), and labels say the page numbers shown.
// - "Mine" is the notes the owner started. A note Claude started (through the connector, Release 2) is in All only.
import { type Anchor, type CommentRow, type PageOrder, positionOfPage, type Resolution, shownPageNumber, type ThreadId, type ThreadRow } from '@sop/core';
import type { CardPlacement } from '@sop/ui';
import type { AnnotationState } from '../annotations/session';
import { currentPageOrder } from '../page-order/shown';

export type NotesFilter = 'all' | 'mine';

/** Where a note is on its page: the top-left corner of what it is on, 0–1 of the unrotated crop box. */
export interface NoteSpot {
  pageIndex: number;
  x: number;
  y: number;
}

export interface NoteEntry {
  id: ThreadId;
  thread: ThreadRow;
  /** The sent comments, first comment first. Empty for a new note whose first comment is still being written. */
  comments: CommentRow[];
  /** This tab's unsent text for the thread: the first comment of a new note, or a reply. */
  draft: CommentRow | null;
  placement: CardPlacement;
  /** Where it is in this copy of the PDF. Null for a whole-document note and for one that couldn't be placed. */
  spot: NoteSpot | null;
  /** What it is on: "Page 4", "Whole document", "Area · Page 4", "Figure 2 · Page 4" (never "p. 4": R74). */
  label: string | null;
  /** The words it is on, for a note on a passage. */
  quote: string | null;
  /** The owner started it. */
  mine: boolean;
}

export interface NoteList {
  /** Notes on this copy, in reading order. */
  placed: NoteEntry[];
  /** Notes whose passage or figure is not in this copy. Nothing is drawn for them on the pages. */
  unplaced: NoteEntry[];
}

/** Every note of the session, split into the ones placed in this copy and the ones that could not be placed. */
export function listNotes(s: AnnotationState, filter: NotesFilter = 'all', order: PageOrder = currentPageOrder()): NoteList {
  const sent = new Map<ThreadId, CommentRow[]>();
  for (const c of s.comments) {
    const list = sent.get(c.threadId);
    if (list) list.push(c);
    else sent.set(c.threadId, [c]);
  }
  const drafts = new Map<ThreadId, CommentRow>();
  for (const d of s.drafts) drafts.set(d.threadId, d);

  const placed: NoteEntry[] = [];
  const unplaced: NoteEntry[] = [];
  for (const thread of s.threads) {
    const comments = sent.get(thread.id) ?? [];
    const draft = drafts.get(thread.id) ?? null;
    if (comments.length === 0 && draft === null) continue; // a thread with nothing in it is not a note
    const entry = noteEntry(thread, comments, draft, s.placement.get(thread.id), order);
    if (filter === 'mine' && !entry.mine) continue;
    (entry.placement === 'unplaced' ? unplaced : placed).push(entry);
  }
  const pos = (page: number | null | undefined) => (page === null || page === undefined ? -1 : positionOfPage(order, page));
  placed.sort((a, b) => pos(a.spot?.pageIndex) - pos(b.spot?.pageIndex) || byReadingOrder(a, b));
  unplaced.sort((a, b) => pos(a.thread.pageIndex) - pos(b.thread.pageIndex) || byStoredOrder(a, b));
  return { placed, unplaced };
}

function noteEntry(thread: ThreadRow, comments: CommentRow[], draft: CommentRow | null, res: Resolution | undefined, order: PageOrder): NoteEntry {
  const placement = placementOf(res);
  // Until the session has placed a note (it does that as the PDF opens), it is shown where it was stored.
  const here = res?.placed ? res.anchor : thread.anchor;
  const first = comments[0] ?? draft;
  return {
    id: thread.id,
    thread,
    comments,
    draft,
    placement,
    spot: placement === 'unplaced' ? null : spotOf(here, thread),
    // The page it is on in this copy (a moved note says where it is now); a note that couldn't place says where it was.
    label: labelOf(here, order),
    quote: thread.anchor.kind === 'text' ? thread.anchor.quote.quote : null,
    mine: first?.author === 'me',
  };
}

/**
 * How the card shows the placement: not found is "Couldn't place"; a close match (`fuzzy`, `caption`, `image`) is the
 * quiet "Moved" label (contracts D7); anything else is placed.
 */
export function placementOf(res: Resolution | undefined): CardPlacement {
  if (res === undefined) return 'placed';
  if (!res.placed) return 'unplaced';
  return res.by === 'fuzzy' || res.by === 'caption' || res.by === 'image' ? 'moved' : 'placed';
}

/** The top-left corner of what a note is on. A whole-document note has no spot. */
export function spotOf(a: Anchor, thread?: Pick<ThreadRow, 'sortKey'>): NoteSpot | null {
  switch (a.kind) {
    case 'text': {
      const onStart = a.rects.find((r) => r.page === a.start.page && r.rects.length > 0) ?? a.rects.find((r) => r.rects.length > 0);
      const r = onStart?.rects[0];
      // A passage with no rects yet (a note made in claude.ai) sits at its stored sort key until it is placed.
      return r ? { pageIndex: onStart.page, x: r[0], y: r[1] } : { pageIndex: a.start.page, x: 0, y: thread?.sortKey ?? 0 };
    }
    case 'area':
      return { pageIndex: a.page, x: a.rect[0], y: a.rect[1] };
    case 'figure': {
      const [x0, y0, x1, y1] = a.rect;
      const sub = a.sub?.point ?? (a.sub?.rect ? [a.sub.rect[0], a.sub.rect[1]] : null);
      // Pins and sub-areas are stored relative to the figure (spec "Figure and area anchor").
      return sub ? { pageIndex: a.page, x: x0 + sub[0] * (x1 - x0), y: y0 + sub[1] * (y1 - y0) } : { pageIndex: a.page, x: x0, y: y0 };
    }
    case 'point':
      return { pageIndex: a.page, x: a.point[0], y: a.point[1] };
    case 'page':
      return { pageIndex: a.page, x: 0, y: 0 };
    case 'document':
      return null;
  }
}

/** The line above a card's text: what the note is on, in plain words, the page always as "Page N" (R74). Page numbers count from 1. */
export function labelOf(a: Anchor, order: PageOrder = currentPageOrder()): string | null {
  const n = (page: number) => shownPageNumber(order, page);
  switch (a.kind) {
    case 'text':
      return `Page ${n(a.start.page)}`;
    case 'area':
      return `Area · Page ${n(a.page)}`;
    case 'figure':
      return `${a.figure.label ?? 'Figure'} · Page ${n(a.page)}`;
    case 'point':
      return `Page ${n(a.page)}`;
    case 'page':
      return `Page ${n(a.page)}`;
    case 'document':
      return 'Whole document';
  }
}

/** Whole-document notes first, then by page, then top to bottom, then left to right; ties by age. */
function byReadingOrder(a: NoteEntry, b: NoteEntry): number {
  const pa = a.spot?.pageIndex ?? -1;
  const pb = b.spot?.pageIndex ?? -1;
  return pa - pb || (a.spot?.y ?? 0) - (b.spot?.y ?? 0) || (a.spot?.x ?? 0) - (b.spot?.x ?? 0) || a.thread.createdAt - b.thread.createdAt;
}

/** Notes that could not be placed: in the order they were stored (page, then top to bottom), then by age. */
function byStoredOrder(a: NoteEntry, b: NoteEntry): number {
  return (a.thread.pageIndex ?? -1) - (b.thread.pageIndex ?? -1) || (a.thread.sortKey ?? 0) - (b.thread.sortKey ?? 0) || a.thread.createdAt - b.thread.createdAt;
}
