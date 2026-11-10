// "Opens where you stopped" (S16): when a PDF the library already holds is opened, the page list goes back to the spot the
// reader left it at (page, how far down it, zoom), and a quiet note offers "Start from page 1".
//
// The rules, all kept here:
// - The link wins. A link that names its own page (`#page=N`) or its own note goes there, and no spot is resumed.
// - The reader wins. Nothing moves once they have moved: the store answers a moment after the first page is drawn, and a
//   reader who has already scrolled, zoomed or paged must not be pulled away.
// - A spot at the very start of page 1 is not a spot: there is nothing to resume, so there is no note either.
// - Nothing is read or written here. The tracker (reading-tracker.ts) reads the spot from the library and calls this.
import { clampScale, restorePosition, viewPosition, type ViewerStore, type ViewPosition, type ZoomMode } from '@sop/viewer';
import type { PageListApi } from '@sop/viewer/react';
import type { ReadingState } from '../../store/library-api';

/**
 * What the address the viewer was opened with asks for. `note` (a note's thread) and `q` (the first search term to find) are
 * what the search palette's links carry (Phase 3, S15); they are optional here until `ViewerParams` has them.
 */
export interface OpenLink {
  /** 1-based page, from `#page=N`. */
  page: number | null;
  note?: string | null;
  q?: string | null;
}

/** True when the link says where to go, so the last spot is not used. */
export function linkHasTarget(link: OpenLink): boolean {
  return link.page !== null || (link.note ?? null) !== null || (link.q ?? null) !== null;
}

/** The library's resume spot: a 0-based page, 0–1 of the way down it, and the scale (1 = 100%). */
export type Spot = NonNullable<ReadingState['lastPosition']>;

/** A spot on page 1 above this much of the way down counts as read; above the line it is just "the start". */
const START_OFFSET = 0.1;
/** The zoom is only changed when it differs from the zoom the viewer opened with by more than this share. */
const ZOOM_TOLERANCE = 0.02;
/** The reader has moved when the page list has scrolled further than this from where it opened. */
const MOVED_PX = 80;

/** The view's top edge this far down a page (or further, in the gap below it) counts as the top of the next page. */
const NEXT_PAGE_OFFSET = 0.97;

/**
 * Where the reader is, as the library keeps it: the page under the top edge of the view and how far down it. A top edge in
 * the gap between two pages, or in the last sliver of one, is the top of the next page ("I stopped on page 7"), so the
 * spot never reads as the foot of page 6 when the reader is looking at page 7.
 */
export function readerSpot(api: Pick<PageListApi, 'scrollTop' | 'pageBoxes'>, scale: number, pageCount: number): ViewPosition {
  const p = viewPosition(api, scale);
  if (p.offset >= NEXT_PAGE_OFFSET && p.pageIndex + 1 < pageCount) {
    // The next page as shown (R108: the reader may have moved pages), the first of the next row in two-page view.
    const boxes = api.pageBoxes();
    const at = boxes[p.pageIndex];
    let next: (typeof boxes)[number] | null = null;
    for (const b of boxes) if (at && b.top > at.top && (next === null || b.top < next.top || (b.top === next.top && b.left < next.left))) next = b;
    if (next !== null) return { pageIndex: next.index, offset: 0, scale };
  }
  return { ...p, offset: Math.max(0, p.offset) };
}

/** The spot worth going back to in a document of `pageCount` pages, or null. */
export function spotToResume(spot: Spot | null | undefined, pageCount: number): Spot | null {
  if (spot === null || spot === undefined) return null;
  const { page, offset, zoom } = spot;
  if (!Number.isInteger(page) || page < 0 || page >= pageCount) return null;
  if (!Number.isFinite(offset) || !Number.isFinite(zoom) || zoom <= 0) return null;
  if (page === 0 && offset < START_OFFSET) return null;
  return { page, offset: Math.min(1, Math.max(0, offset)), zoom: clampScale(zoom) };
}

/** Where the viewer stood when the document opened, to tell later whether the reader has moved. */
export interface Opening {
  page: number;
  scrollTop: number;
  zoom: ZoomMode;
}

export function openingSpot(view: Pick<ViewerStore, 'get'>, pageList: Pick<PageListApi, 'scrollTop'>): Opening {
  const s = view.get();
  return { page: s.currentPage, scrollTop: pageList.scrollTop(), zoom: s.zoom };
}

const sameZoom = (a: ZoomMode, b: ZoomMode): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Whether the reader has scrolled, zoomed, changed page, or started presenting since the document opened. */
export function readerHasMoved(open: Opening, view: Pick<ViewerStore, 'get'>, pageList: Pick<PageListApi, 'scrollTop'>): boolean {
  const s = view.get();
  return s.presenting !== null || s.currentPage !== open.page || !sameZoom(s.zoom, open.zoom) || Math.abs(pageList.scrollTop() - open.scrollTop) > MOVED_PX;
}

/** A resume that happened. */
export interface Resumed {
  /** The 0-based page it went to. */
  page: number;
  /** "Start from page 1": the zoom the viewer opened with, and the top of page 1. */
  startOver(): Promise<void>;
}

export interface ResumeInput {
  link: OpenLink;
  reading: ReadingState | null;
  pageCount: number;
  opening: Opening;
  view: Pick<ViewerStore, 'get'>;
  /** The page list now; null when it is gone. */
  pageList(): PageListApi | null;
}

/** Goes back to the saved spot, when the link, the spot and the reader allow it. Resolves once the page is on screen. */
export async function resumeReading(i: ResumeInput): Promise<Resumed | null> {
  if (linkHasTarget(i.link)) return null;
  const spot = spotToResume(i.reading?.lastPosition, i.pageCount);
  const api = i.pageList();
  if (spot === null || api === null || readerHasMoved(i.opening, i.view, api)) return null;
  const here = i.view.get();
  const sameEnough = Math.abs(spot.zoom - here.scale) <= here.scale * ZOOM_TOLERANCE;
  await restorePosition(api, here.scale, { pageIndex: spot.page, offset: spot.offset, scale: sameEnough ? here.scale : spot.zoom });
  return {
    page: spot.page,
    async startOver() {
      const now = i.pageList();
      if (now === null) return;
      if (!sameZoom(i.view.get().zoom, here.zoom)) now.zoomTo(here.zoom);
      await now.goToPage(0);
    },
  };
}
