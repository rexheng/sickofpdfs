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
 * Presentation mode's scale (1 = 100%): page `index` fits the screen edge to edge, turned as shown. One scale is drawn at
 * a time, so stepping to a page of another size changes it. Never below 1%.
 */
export function presentationScale(pages: readonly PageSize[], index: number, viewport: { width: number; height: number }, viewRotation: Rotation): number {
  if (pages.length === 0 || viewport.width <= 0 || viewport.height <= 0) return 1;
  const fit = fitScale(pages[Math.min(pages.length - 1, Math.max(0, index))], viewport, viewRotation);
  return Number.isFinite(fit) && fit > 0 ? Math.max(0.01, fit) : 1;
}

/**
 * Presentation mode's layout: one slot per page, each centred in its slot both ways, on the black page area. A slot is
 * the viewport's height, or the tallest page's at this scale when that is taller (pages of other sizes), so with the
 * page shown centred in the view (presentationTop) no other page reaches into it.
 */
export function presentationLayout(pages: readonly PageSize[], o: { scale: number; viewRotation: Rotation; viewport: { width: number; height: number } }): PageLayout {
  const { width: W, height: H } = o.viewport;
  const shown = pages.map((p) => {
    const d = displayedSize(p, o.viewRotation);
    return { width: cssAt(d.width, o.scale), height: cssAt(d.height, o.scale), rotation: d.rotation };
  });
  const slot = Math.max(H, ...shown.map((s) => s.height));
  const boxes: PageBox[] = shown.map((s, i) => ({ index: i, top: i * slot + (slot - s.height) / 2, left: (W - s.width) / 2, width: s.width, height: s.height, rotation: s.rotation }));
  return { boxes, width: W, height: pages.length * slot };
}

/** The scroll position that shows page box `box` centred in a view `viewportHeight` tall (presentation mode). */
export const presentationTop = (box: PageBox, viewportHeight: number): number => box.top + box.height / 2 - viewportHeight / 2;
