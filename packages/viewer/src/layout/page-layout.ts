// Where every page sits in the scroll area, in CSS px. A pure function of the page sizes, the scale, the rotation, the
// spread and the viewport width, so the page list, the thumbnail rail and tests share one answer.
import { positionOfPage } from '@sop/core/page-order';
import type { PageSize, Rotation } from '../backend/types';
import { displayedSize, PAGE_GAP, rowsOf, type Spread } from './zoom';

/** One page's box in the scroll area, CSS px. `rotation` is how the page is drawn: its /Rotate plus the view rotation. */
export interface PageBox {
  index: number;
  top: number;
  left: number;
  width: number;
  height: number;
  rotation: Rotation;
}

/**
 * All the boxes, and the size of the scroll area that holds them. `boxes[i]` is always page i's box (an original page
 * index, as every note and every page number stored is). R108: with a page order the boxes are placed in that order, and
 * `order` lists the page at each position (top to bottom); without one, the positions are the page indices.
 */
export interface PageLayout {
  boxes: PageBox[];
  width: number;
  height: number;
  /** The original page index at each position, when the reader has reordered the pages. */
  order?: readonly number[];
}

/** The page at `position` of a layout. */
export const pageAt = (l: Pick<PageLayout, 'order'>, position: number): number => (l.order ? (l.order[position] ?? position) : position);

/** The box at `position` of a layout (top to bottom). */
export const boxAt = (l: PageLayout, position: number): PageBox => l.boxes[pageAt(l, position)];

/** The position of page `index` in a layout. */
export const positionIn = (l: Pick<PageLayout, 'order'>, index: number): number => positionOfPage(l.order ?? null, index);

/** Points at `scale` in CSS px. Multiplied before the division, so 612 pt at 1 is exactly 816. */
const css = (pt: number, scale: number) => (pt * scale * 96) / 72;

/**
 * Pages top to bottom with PAGE_GAP above, between and below them. A row (one page, or two in a spread) is centred in
 * the scroll area, which is the viewport's width or, when a row is wider, that row plus PAGE_GAP on each side. The two
 * pages of a spread are PAGE_GAP apart and top-aligned.
 */
export function computeLayout(
  pages: PageSize[],
  o: { scale: number; viewRotation: Rotation; spread: Spread; viewportWidth: number; order?: readonly number[] | null },
): PageLayout {
  const order = o.order && o.order.length === pages.length ? o.order : null;
  const at = (position: number) => (order ? order[position] : position);
  const shown = pages.map((p) => {
    const d = displayedSize(p, o.viewRotation);
    return { width: css(d.width, o.scale), height: css(d.height, o.scale), rotation: d.rotation };
  });
  // A row is positions (two-page view pairs the pages as they are shown); its pages are what is shown there.
  const rows = rowsOf(pages.length, o.spread).map((positions) => {
    const indices = positions.map(at);
    return {
      indices,
      width: indices.reduce((sum, i) => sum + shown[i].width, 0) + (indices.length - 1) * PAGE_GAP,
      height: Math.max(...indices.map((i) => shown[i].height)),
    };
  });
  const width = Math.max(o.viewportWidth, ...rows.map((r) => r.width + 2 * PAGE_GAP));
  const boxes: PageBox[] = new Array<PageBox>(pages.length);
  let top = PAGE_GAP;
  for (const row of rows) {
    let left = (width - row.width) / 2;
    for (const i of row.indices) {
      const s = shown[i];
      boxes[i] = { index: i, top, left, width: s.width, height: s.height, rotation: s.rotation };
      left += s.width + PAGE_GAP;
    }
    top += row.height + PAGE_GAP;
  }
  return { boxes, width, height: rows.length === 0 ? 0 : top, ...(order ? { order } : {}) };
}

/**
 * The positions whose boxes meet the band [scrollTop, scrollTop + viewportHeight), widened by `overscan` positions on
 * each side (in the order the pages are shown, clamped to the document; pageAt gives the page at a position). An empty
 * band, or no pages, gives { first: 0, last: -1 }.
 */
export function visibleRange(l: PageLayout, scrollTop: number, viewportHeight: number, overscan: number): { first: number; last: number } {
  const n = l.boxes.length;
  const b = (position: number) => boxAt(l, position);
  const bottom = scrollTop + viewportHeight;
  if (n === 0 || viewportHeight <= 0) return { first: 0, last: -1 };
  // Positions go top to bottom and rows never go back up, so box tops are non-decreasing: binary search for the first
  // box whose bottom is below the band's top. A page of a spread may be shorter than its neighbour, so step back to
  // the start of its row.
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (b(mid).top + rowBottomOffset(l, mid) <= scrollTop) lo = mid + 1;
    else hi = mid;
  }
  let first = lo;
  // lo is n when the band lies below the last page (a zoom anchored under a short document's only page).
  while (first > 0 && first < n && b(first - 1).top === b(first).top) first--;
  if (first >= n || b(first).top >= bottom) return { first: 0, last: -1 };
  let last = first;
  while (last + 1 < n && b(last + 1).top < bottom) last++;
  return { first: Math.max(0, first - overscan), last: Math.min(n - 1, last + overscan) };
}

/** The height of the row at position i (the tallest box sharing its top). */
function rowBottomOffset(l: PageLayout, i: number): number {
  const n = l.boxes.length;
  const top = boxAt(l, i).top;
  let h = boxAt(l, i).height;
  for (let k = i - 1; k >= 0 && boxAt(l, k).top === top; k--) h = Math.max(h, boxAt(l, k).height);
  for (let k = i + 1; k < n && boxAt(l, k).top === top; k++) h = Math.max(h, boxAt(l, k).height);
  return h;
}
