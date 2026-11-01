// Where every page sits in the scroll area, in CSS px. A pure function of the page sizes, the scale, the rotation, the
// spread and the viewport width, so the page list, the thumbnail rail and tests share one answer.
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

/** All the boxes, and the size of the scroll area that holds them. */
export interface PageLayout {
  boxes: PageBox[];
  width: number;
  height: number;
}

/** Points at `scale` in CSS px. Multiplied before the division, so 612 pt at 1 is exactly 816. */
const css = (pt: number, scale: number) => (pt * scale * 96) / 72;

/**
 * Pages top to bottom with PAGE_GAP above, between and below them. A row (one page, or two in a spread) is centred in
 * the scroll area, which is the viewport's width or, when a row is wider, that row plus PAGE_GAP on each side. The two
 * pages of a spread are PAGE_GAP apart and top-aligned.
 */
export function computeLayout(pages: PageSize[], o: { scale: number; viewRotation: Rotation; spread: Spread; viewportWidth: number }): PageLayout {
  const shown = pages.map((p) => {
    const d = displayedSize(p, o.viewRotation);
    return { width: css(d.width, o.scale), height: css(d.height, o.scale), rotation: d.rotation };
  });
  const rows = rowsOf(pages.length, o.spread).map((indices) => ({
    indices,
    width: indices.reduce((sum, i) => sum + shown[i].width, 0) + (indices.length - 1) * PAGE_GAP,
    height: Math.max(...indices.map((i) => shown[i].height)),
  }));
  const width = Math.max(o.viewportWidth, ...rows.map((r) => r.width + 2 * PAGE_GAP));
  const boxes: PageBox[] = [];
  let top = PAGE_GAP;
  for (const row of rows) {
    let left = (width - row.width) / 2;
    for (const i of row.indices) {
      const s = shown[i];
      boxes.push({ index: i, top, left, width: s.width, height: s.height, rotation: s.rotation });
      left += s.width + PAGE_GAP;
    }
    top += row.height + PAGE_GAP;
  }
  return { boxes, width, height: rows.length === 0 ? 0 : top };
}

/**
 * The pages whose boxes meet the band [scrollTop, scrollTop + viewportHeight), widened by `overscan` pages on each
 * side (in page order, clamped to the document). An empty band, or no pages, gives { first: 0, last: -1 }.
 */
export function visibleRange(l: PageLayout, scrollTop: number, viewportHeight: number, overscan: number): { first: number; last: number } {
  const b = l.boxes;
  const bottom = scrollTop + viewportHeight;
  if (b.length === 0 || viewportHeight <= 0) return { first: 0, last: -1 };
  // Boxes are in page order and rows never go back up, so box tops are non-decreasing: binary search for the first
  // box whose bottom is below the band's top. A page of a spread may be shorter than its neighbour, so step back to
  // the start of its row.
  let lo = 0;
  let hi = b.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (b[mid].top + rowBottomOffset(b, mid) <= scrollTop) lo = mid + 1;
    else hi = mid;
  }
  let first = lo;
  // lo is b.length when the band lies below the last page (a zoom anchored under a short document's only page).
  while (first > 0 && first < b.length && b[first - 1].top === b[first].top) first--;
  if (first >= b.length || b[first].top >= bottom) return { first: 0, last: -1 };
  let last = first;
  while (last + 1 < b.length && b[last + 1].top < bottom) last++;
  return { first: Math.max(0, first - overscan), last: Math.min(b.length - 1, last + overscan) };
}

/** The height of box i's row (the tallest box sharing its top). */
function rowBottomOffset(b: PageBox[], i: number): number {
  let h = b[i].height;
  for (let k = i - 1; k >= 0 && b[k].top === b[i].top; k--) h = Math.max(h, b[k].height);
  for (let k = i + 1; k < b.length && b[k].top === b[i].top; k++) h = Math.max(h, b[k].height);
  return h;
}
