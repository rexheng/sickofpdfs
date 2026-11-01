// Between a page's box on screen (CSS px, as displayed: turned by /Rotate plus the view rotation) and its own space
// (points, unrotated, origin at the crop box's top-left, y down: the space every PdfRect is in).
import type { PageSize, PdfRect, Rotation } from '../backend/types';
import { turnPoint, unturnPoint, unturnRect } from '../view/page-transform';
import type { PageBox } from './page-layout';

/** A point in a page's own space: points, unrotated, top-left origin. */
export interface PagePoint {
  pageIndex: number;
  x: number;
  y: number;
}

/**
 * A point in unrotated page space for a point (dx, dy) in displayed points (the page as shown, top-left origin).
 * `r` is the total clockwise rotation; W × H the unrotated size. The page's one turn (view/page-transform.ts).
 */
export const displayedToPage: (dx: number, dy: number, r: Rotation, W: number, H: number) => { x: number; y: number } = unturnPoint;

/** The inverse of displayedToPage. */
export const pageToDisplayed: (x: number, y: number, r: Rotation, W: number, H: number) => { x: number; y: number } = turnPoint;

/** A rectangle in displayed points as a rectangle in unrotated page space. */
export const displayedRectToPage: (d: PdfRect, r: Rotation, W: number, H: number) => PdfRect = unturnRect;

/** CSS px per point for a box (the same both ways: boxes keep the page's aspect ratio). */
export function cssPerPoint(box: PageBox, page: PageSize): number {
  const displayedWidth = box.rotation % 180 === 0 ? page.width : page.height;
  return box.width / displayedWidth;
}

/** Page space → the point's position in the scroll content (CSS px). Points outside the page map outside the box. */
export function pagePointToContent(box: PageBox, page: PageSize, p: { x: number; y: number }): { x: number; y: number } {
  const k = cssPerPoint(box, page);
  const d = pageToDisplayed(p.x, p.y, box.rotation, page.width, page.height);
  return { x: box.left + d.x * k, y: box.top + d.y * k };
}

/** The scroll content's point (CSS px) in `box`'s page space; outside the box it extends the page's space. */
export function contentPointToPage(box: PageBox, page: PageSize, c: { x: number; y: number }): { x: number; y: number } {
  const k = cssPerPoint(box, page);
  return displayedToPage((c.x - box.left) / k, (c.y - box.top) / k, box.rotation, page.width, page.height);
}
