// Next and previous note (Ctrl+Alt+N, Ctrl+Alt+P), and going to a note from the panel (plan S15).
//
// - "Next" starts from where the reader is (ruling R70): the first note at or below the top of the view is next, and the
//   last note above it is previous. The active note is the starting point only while it is still in view (the caller
//   passes it as active only then), so after scrolling away, next and previous follow the page, not the last note.
// - It wraps: after the last note comes the first again.
// - Only notes with a place on a page take part. Whole-document notes and notes that could not be placed are in the
//   panel only.
// - A jump goes through the jump history (Task 24), collapsed: a run of jumps is one history entry, so Back returns to
//   where the reader was before the first one (spec "Jumps inside a document … are kept in the page's history state
//   and collapsed").
import type { JumpHistory, LinkTarget, PageBox, PageSize, ViewPosition } from '@sop/viewer';
import { cssToNorm, normToCss, pageUnderTop } from '@sop/viewer';
import type { ThreadId } from '@sop/core';
import type { NoteEntry, NoteSpot } from './model';

/** A note that can be gone to. */
export interface NoteStop extends NoteSpot {
  id: ThreadId;
}

/** The notes with a place on a page, in reading order (the order of `entries`). */
export function noteStops(entries: readonly NoteEntry[]): NoteStop[] {
  const stops: NoteStop[] = [];
  for (const e of entries) if (e.spot !== null) stops.push({ id: e.id, ...e.spot });
  return stops;
}

/** A note this close to the top of the view (CSS px) counts as being at it. */
const AT_TOP_PX = 2;

export interface Step {
  stop: NoteStop;
  /** Its place among the stops, from 0. */
  index: number;
  /** The step went past the last note to the first (or past the first to the last). */
  wrapped: boolean;
}

/**
 * The note to go to. `below(stop)` is how far the note sits below the top of the view, in CSS px (negative when it is
 * above it); it is only asked when no note is active.
 */
export function stepNote(stops: readonly NoteStop[], dir: 1 | -1, active: ThreadId | null, below: (s: NoteStop) => number): Step | null {
  const n = stops.length;
  if (n === 0) return null;
  const at = active === null ? -1 : stops.findIndex((s) => s.id === active);
  if (at >= 0) {
    const index = (at + dir + n) % n;
    return { stop: stops[index], index, wrapped: dir === 1 ? index <= at : index >= at };
  }
  if (dir === 1) {
    const index = stops.findIndex((s) => below(s) >= -AT_TOP_PX);
    return index >= 0 ? { stop: stops[index], index, wrapped: false } : { stop: stops[0], index: 0, wrapped: true };
  }
  for (let index = n - 1; index >= 0; index--) if (below(stops[index]) < -AT_TOP_PX) return { stop: stops[index], index, wrapped: false };
  return { stop: stops[n - 1], index: n - 1, wrapped: true };
}

/** What the page list offers that this file uses (PageListApi has all of it). */
export interface PageScroller {
  scrollTop(): number;
  viewportHeight(): number;
  pageBoxes(): PageBox[];
  goToPage(index: number): Promise<void>;
}

/** CSS px a point for a page's box (a box keeps the page's aspect ratio). */
function cssPerPoint(box: PageBox, page: PageSize): number {
  return box.width / (box.rotation % 180 === 0 ? page.width : page.height);
}

/** Where a spot is on its displayed page, in CSS px from the page's top-left. */
function spotOnPage(spot: NoteSpot, box: PageBox, page: PageSize): { x: number; y: number } {
  const b = normToCss([spot.x, spot.y, spot.x, spot.y], page, cssPerPoint(box, page), box.rotation);
  return { x: b.x, y: b.y };
}

/** How far a note sits below the top of the view, in CSS px; +Infinity when the pages are not laid out yet. */
export function distanceBelowTop(spot: NoteSpot, pages: readonly PageSize[], api: Pick<PageScroller, 'scrollTop' | 'pageBoxes'>): number {
  const box = api.pageBoxes()[spot.pageIndex];
  const page = pages[spot.pageIndex];
  if (box === undefined || page === undefined) return Number.POSITIVE_INFINITY;
  return box.top + spotOnPage(spot, box, page).y - api.scrollTop();
}

/** A note lands this far down the view, so the lines above it show too. */
const LAND_AT = 0.25;

/**
 * The jump to a note: its page, and the point that goes to the top of the view, a quarter of the view above the note.
 * `left` is set only on a turned page, where the page's own "top" is not up on the screen.
 */
export function jumpTarget(spot: NoteSpot, pages: readonly PageSize[], api: Pick<PageScroller, 'pageBoxes' | 'viewportHeight'>): LinkTarget & { kind: 'page' } {
  const box = api.pageBoxes()[spot.pageIndex];
  const page = pages[spot.pageIndex];
  if (box === undefined || page === undefined) return { kind: 'page', pageIndex: spot.pageIndex, top: null, left: null };
  const k = cssPerPoint(box, page);
  const on = spotOnPage(spot, box, page);
  const [u, v] = cssToNorm({ x: on.x, y: Math.max(0, on.y - api.viewportHeight() * LAND_AT) }, page, k, box.rotation);
  return { kind: 'page', pageIndex: spot.pageIndex, top: v * page.height, left: box.rotation === 0 ? null : u * page.width };
}

/**
 * Where the reader is: the page under the top of the view (the next one, in the gap between two), how far down it, and
 * the zoom. Task 24's `viewPosition` in @sop/viewer computes the same; this file can use it once Task 24 has merged.
 */
export function readingPosition(api: Pick<PageScroller, 'scrollTop' | 'pageBoxes'>, scale: number): ViewPosition {
  const top = api.scrollTop();
  // R108: the boxes' tops follow the order the pages are shown in, which may not be page order.
  const b = pageUnderTop(api.pageBoxes(), top);
  if (b === null) return { pageIndex: 0, offset: 0, scale };
  return { pageIndex: b.index, offset: (top - b.top) / b.height, scale };
}

/**
 * Shows a note: through the jump history when there is one (Task 24), so Back returns; until then, its page from the
 * top.
 */
export function goToSpot(spot: NoteSpot, o: { jumps: JumpHistory | null; api: PageScroller; pages: readonly PageSize[]; scale: number }): void {
  if (o.jumps === null) {
    void o.api.goToPage(spot.pageIndex);
    return;
  }
  o.jumps.jumpTo(jumpTarget(spot, o.pages, o.api), readingPosition(o.api, o.scale));
}
