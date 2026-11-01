// The reader's own view of the pages in one tab (Task 26, R81): rotation, two-page view and presentation mode. None of
// it is saved: the PDF reopens upright, one page a row, as in Chrome. The file itself is never changed.
import type { PageSize, Rotation } from '../backend/types';
import type { PageBox, PageLayout } from '../layout/page-layout';
import { displayedSize, PT_TO_CSS } from '../layout/zoom';

export type { Rotation };

/** The next quarter turn clockwise (1, Ctrl+]) or counter-clockwise (−1, Ctrl+[). All pages turn together. */
export function rotate(r: Rotation, dir: 1 | -1): Rotation {
  return ((((r + dir * 90) % 360) + 360) % 360) as Rotation;
}

/** Presentation mode: the page on screen, 0-based. Null while not presenting. */
export interface Presenting {
  page: number;
}

/** CSS px a point at `scale` (1 = 100%). */
const cssAt = (pt: number, scale: number) => (pt * scale * 96) / 72;

/** The scale (1 = 100%) that fits page `index` whole in `viewport`, edge to edge, turned as shown. */
function fitScale(page: PageSize, viewport: { width: number; height: number }, viewRotation: Rotation): number {
  const d = displayedSize(page, viewRotation);
  return Math.min(viewport.width / (d.width * PT_TO_CSS), viewport.height / (d.height * PT_TO_CSS));
}

/**
 * Presentation mode's one scale for all pages: page `index` fits the screen edge to edge, and so do the pages either
 * side of it (a larger neighbour makes it a little smaller), so no neighbour ever reaches into the page on screen. A
 * deck of one page size fits every slide exactly. Never below 1%.
 */
export function presentationScale(pages: readonly PageSize[], index: number, viewport: { width: number; height: number }, viewRotation: Rotation): number {
  if (pages.length === 0 || viewport.width <= 0 || viewport.height <= 0) return 1;
  const i = Math.min(pages.length - 1, Math.max(0, index));
  let best = Infinity;
  for (let k = Math.max(0, i - 1); k <= Math.min(pages.length - 1, i + 1); k++) best = Math.min(best, fitScale(pages[k], viewport, viewRotation));
  return Number.isFinite(best) && best > 0 ? Math.max(0.01, best) : 1;
}

/**
 * Presentation mode's layout: one screen per page. Page i fills the slot [i·H, (i+1)·H) of a viewport W × H, centred
 * in it both ways, on the black page area, so showing page i is scrolling to i·H (presentationTop) and no other page
 * is in view.
 */
export function presentationLayout(pages: readonly PageSize[], o: { scale: number; viewRotation: Rotation; viewport: { width: number; height: number } }): PageLayout {
  const { width: W, height: H } = o.viewport;
  const boxes: PageBox[] = pages.map((p, i) => {
    const d = displayedSize(p, o.viewRotation);
    const width = cssAt(d.width, o.scale);
    const height = cssAt(d.height, o.scale);
    return { index: i, top: i * H + (H - height) / 2, left: (W - width) / 2, width, height, rotation: d.rotation };
  });
  return { boxes, width: W, height: pages.length * H };
}

/** The scroll position that shows page `index` in presentation mode (presentationLayout). */
export const presentationTop = (index: number, viewportHeight: number): number => index * viewportHeight;
