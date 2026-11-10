// Where the reader is (a ViewPosition), and moving the page list to a position or to a link's destination.
// It takes the page list structurally (PageListApi has every method), so this module never pulls in a stylesheet.
import type { LinkTarget, PageSize } from '../backend/types';
import type { ViewPosition } from '../contracts';
import type { PageBox } from '../layout/page-layout';
import { cssPerPoint, pageToDisplayed } from '../layout/page-space';
import type { ZoomMode } from '../layout/zoom';

/** What these helpers use of the page list (PageListApi). */
export interface PageScroller {
  scrollTop(): number;
  pageBoxes(): PageBox[];
  zoomTo(mode: ZoomMode): void;
  goToPage(index: number): Promise<void>;
  scrollToOffset(index: number, offset: number, left?: number): Promise<void>;
}

type Pages = Pick<PageScroller, 'scrollTop' | 'pageBoxes'>;

/** The reader's position: the page under the top edge of the view (or the next one, in a gap), how far down it, the zoom. */
export function viewPosition(api: Pages, scale: number): ViewPosition {
  const top = api.scrollTop();
  const b = pageUnderTop(api.pageBoxes(), top);
  if (b === null) return { pageIndex: 0, offset: 0, scale };
  return { pageIndex: b.index, offset: (top - b.top) / b.height, scale };
}

/**
 * The box under `top` (a scroll position): the last row that starts at or above it, unless `top` is in the gap below
 * that row (then the next row), and the first page of a two-page row. `boxes[i]` is page i's box; their tops follow the
 * order the pages are shown in (R108), which need not be page order, so they are searched rather than bisected.
 */
export function pageUnderTop(boxes: readonly PageBox[], top: number): PageBox | null {
  let b: PageBox | null = null;
  let next: PageBox | null = null;
  for (const box of boxes) {
    if (box.top <= top) {
      if (b === null || box.top > b.top || (box.top === b.top && box.left < b.left)) b = box;
    } else if (next === null || box.top < next.top || (box.top === next.top && box.left < next.left)) next = box;
  }
  if (b === null) return next;
  if (top > b.top + b.height && next !== null) return next;
  return b;
}

/** Back to a position: its zoom (only if it changed), then its page and offset. */
export function restorePosition(api: Pick<PageScroller, 'zoomTo' | 'scrollToOffset'>, scale: number, p: ViewPosition): Promise<void> {
  if (Math.abs(scale - p.scale) > 1e-6) api.zoomTo({ kind: 'scale', scale: p.scale });
  return api.scrollToOffset(p.pageIndex, p.offset);
}

/**
 * Follows a link or outline destination, as Chrome's viewer does: the destination point goes to the top of the view
 * (and to its left edge, when the pages are wider than the view). A destination with no point shows its page from the
 * top.
 */
export function goToTarget(api: Pick<PageScroller, 'pageBoxes' | 'goToPage' | 'scrollToOffset'>, pages: PageSize[], t: LinkTarget & { kind: 'page' }): Promise<void> {
  const box = api.pageBoxes()[t.pageIndex];
  const page = pages[t.pageIndex];
  if (!box || !page || (t.top === null && t.left === null)) return api.goToPage(t.pageIndex);
  const k = cssPerPoint(box, page);
  const d = pageToDisplayed(t.left ?? 0, t.top ?? 0, box.rotation, page.width, page.height);
  return api.scrollToOffset(t.pageIndex, t.top === null ? 0 : (d.y * k) / box.height, t.left === null ? undefined : d.x * k);
}
