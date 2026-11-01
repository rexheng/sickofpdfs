// The one turn every layer over a page uses (R81). A page is drawn turned clockwise by its /Rotate plus the viewer's
// own rotation (PageBox.rotation); everything laid over it (the text layer, the selection, marks, bold, figures, find,
// links, pins and the margin cards) turns with it through the functions here, and nowhere else, so no layer can drift
// from the page or from another layer at any rotation.
//
// Spaces. Unrotated page space: the page's crop box as the PDF stores it, origin top-left, y down, W × H (points, CSS
// px or 0–1: any unit, the same in and out). Displayed space: that box turned clockwise by `r` about its top-left and
// moved back into view, so it is W × H at 0 and 180 and H × W at 90 and 270. Turning clockwise by 90 sends (x, y) to
// (H − y, x).
//
// The sums are written out per rotation (no multiplying by 0 and 1), so an upright page's numbers are exactly the
// numbers it had before any rotation was possible.
import type { Rotation } from '../backend/types';

/** A rectangle by its top-left corner and size, in whatever unit the page is in. */
export interface TurnRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f (the SVG, canvas and DOMMatrix order). */
export type TurnMatrix = [number, number, number, number, number, number];

/** A page's turn, ready for a layer. Sizes are in the unit of the size it was made from. */
export interface PageTransform {
  /** Clockwise: the page's /Rotate plus the view's. */
  rotation: Rotation;
  /** The page as displayed. */
  width: number;
  height: number;
  /** Unrotated → displayed; null when there is no turn. */
  matrix: TurnMatrix | null;
  /**
   * The same turn as CSS, for an element the size of the unrotated page with `transform-origin: 0 0` (pdf.js's rules):
   * '' when there is no turn.
   */
  css: string;
}

/** Whether pages turned by `r` show sideways (their width and height swap). */
export const isSideways = (r: Rotation): boolean => r === 90 || r === 270;

/** The total turn of a page: its /Rotate plus the view's rotation, both clockwise. */
export function totalRotation(pageRotation: Rotation, viewRotation: Rotation): Rotation {
  return ((pageRotation + viewRotation) % 360) as Rotation;
}

/** The turn for a page of unrotated size `page` shown turned by `rotation`. */
export function pageTransform(page: { width: number; height: number }, rotation: Rotation): PageTransform {
  const { width: w, height: h } = page;
  const sideways = isSideways(rotation);
  return { rotation, width: sideways ? h : w, height: sideways ? w : h, matrix: turnMatrix(rotation, w, h), css: TURN_CSS[rotation] };
}

/** Unrotated → displayed as a matrix (SVG `matrix()`, canvas setTransform), or null for no turn. */
export function turnMatrix(r: Rotation, W: number, H: number): TurnMatrix | null {
  switch (r) {
    case 90:
      return [0, 1, -1, 0, H, 0];
    case 180:
      return [-1, 0, 0, -1, W, H];
    case 270:
      return [0, -1, 1, 0, 0, W];
    default:
      return null;
  }
}

/** pdf.js's text-layer rules (pdf_viewer.css): the turn as CSS on an element the size of the unrotated page. */
export const turnCss = (r: Rotation): string => TURN_CSS[r] ?? '';

const TURN_CSS: Record<Rotation, string> = {
  0: '',
  90: 'rotate(90deg) translateY(-100%)',
  180: 'rotate(180deg) translate(-100%, -100%)',
  270: 'rotate(270deg) translateX(-100%)',
};

/** A point in unrotated space → where it shows on the displayed page. */
export function turnPoint(x: number, y: number, r: Rotation, W: number, H: number): { x: number; y: number } {
  switch (r) {
    case 90:
      return { x: H - y, y: x };
    case 180:
      return { x: W - x, y: H - y };
    case 270:
      return { x: y, y: W - x };
    default:
      return { x, y };
  }
}

/** A point on the displayed page → where it is in unrotated space. The inverse of turnPoint. */
export function unturnPoint(dx: number, dy: number, r: Rotation, W: number, H: number): { x: number; y: number } {
  switch (r) {
    case 90:
      return { x: dy, y: H - dx };
    case 180:
      return { x: W - dx, y: H - dy };
    case 270:
      return { x: W - dy, y: dx };
    default:
      return { x: dx, y: dy };
  }
}

/**
 * A rectangle given by its corners in unrotated space ([x0, y0, x1, y1], x0 ≤ x1, y0 ≤ y1) → its corners on the
 * displayed page, in the same form.
 */
export function turnCorners(c: readonly [number, number, number, number], r: Rotation, W: number, H: number): [number, number, number, number] {
  const [x0, y0, x1, y1] = c;
  switch (r) {
    case 90:
      return [H - y1, x0, H - y0, x1];
    case 180:
      return [W - x1, H - y1, W - x0, H - y0];
    case 270:
      return [y0, W - x1, y1, W - x0];
    default:
      return [x0, y0, x1, y1];
  }
}

/** A rectangle in unrotated space → the rectangle it covers on the displayed page. */
export function turnRect(rect: TurnRect, r: Rotation, W: number, H: number): TurnRect {
  const a = turnPoint(rect.x, rect.y, r, W, H);
  const b = turnPoint(rect.x + rect.width, rect.y + rect.height, r, W, H);
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

/** A rectangle on the displayed page → the rectangle it covers in unrotated space. The inverse of turnRect. */
export function unturnRect(d: TurnRect, r: Rotation, W: number, H: number): TurnRect {
  switch (r) {
    case 90:
      return { x: d.y, y: H - d.x - d.width, width: d.height, height: d.width };
    case 180:
      return { x: W - d.x - d.width, y: H - d.y - d.height, width: d.width, height: d.height };
    case 270:
      return { x: W - d.y - d.height, y: d.x, width: d.height, height: d.width };
    default:
      return { ...d };
  }
}
