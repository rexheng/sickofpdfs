// Appearance streams for "Download with notes" (slice 8.2; spike 8.0's recipes). Pure text, no engine.
//
// FPDFAnnot_SetAP stores a stream with /BBox = the annotation's /Rect and no /Resources (spike report, "Two dead ends"),
// so these streams use only operators that need no resource: colours, line width, dash and paths. Coordinates are PDF
// user space (y up), the space /Rect is in, so the appearance lands where it was drawn.
import type { PdfUserRect } from '@sop/core';
import type { ApFill } from '../types';

/** An appearance that draws nothing: replies (sample A, decision D8.1). */
export const EMPTY_STREAM = 'q Q';

const f = (n: number): string => String(Math.round(n * 1000) / 1000 + 0); // + 0 turns -0 into 0
const unit = (v: number): string => f(v / 255);

/**
 * The dotted underline of a comment on text that has no highlight (contracts §9: "an /Underline with a dotted /AP,
 * matching the viewer"). The viewer draws square dots `thickness` wide with gaps of the same size along each line's
 * bottom edge (marks/geometry.ts dottedUnderlinePath, 1.5 CSS px = 1.125 pt). "Bottom" is as the page is displayed:
 * `quads` are the eight /QuadPoints numbers of each line in Acrobat's order (top-left, top-right, bottom-left,
 * bottom-right), so the line runs from the quad's bottom-left to its bottom-right, moved half a dot towards its top.
 */
export function dottedUnderlineStream(quads: readonly (readonly number[])[], rgb: readonly [number, number, number], thickness = 1.125): string {
  const out = ['q', `${unit(rgb[0])} ${unit(rgb[1])} ${unit(rgb[2])} RG`, `${f(thickness)} w`, '0 J', `[${f(thickness)} ${f(thickness)}] 0 d`];
  for (const q of quads) {
    const [tlx, tly, , , blx, bly, brx, bry] = q;
    const up = Math.hypot(tlx - blx, tly - bly);
    if (!(up > 0)) continue;
    const dx = ((tlx - blx) / up) * (thickness / 2);
    const dy = ((tly - bly) / up) * (thickness / 2);
    out.push(`${f(blx + dx)} ${f(bly + dy)} m ${f(brx + dx)} ${f(bry + dy)} l S`);
  }
  out.push('Q');
  return out.join('\n');
}

/**
 * Filled shapes, one colour at a time (nonzero fill, as the viewer's canvas fills bold): bold marks' emboldened glyphs.
 * Shapes of one colour are one path, so glyphs that touch (kerning, ligatures) fill once.
 */
export function fillStream(fills: readonly ApFill[]): string {
  const byColour = new Map<string, number[][]>();
  for (const fill of fills) {
    const key = `${unit(fill.rgb[0])} ${unit(fill.rgb[1])} ${unit(fill.rgb[2])}`;
    const list = byColour.get(key);
    if (list) list.push(fill.path);
    else byColour.set(key, [fill.path]);
  }
  const out = ['q'];
  for (const [colour, paths] of byColour) {
    out.push(`${colour} rg`);
    for (const path of paths) out.push(pathOps(path));
    out.push('f');
  }
  out.push('Q');
  return out.join('\n');
}

/** PDFium path segments ([type, x, y, close] each: 2 move, 0 line, 1 cubic point) as PDF path operators. */
export function pathOps(path: ArrayLike<number>): string {
  const n = Math.floor(path.length / 4);
  const ops: string[] = [];
  for (let s = 0; s < n; s++) {
    const type = path[4 * s];
    const x = path[4 * s + 1];
    const y = path[4 * s + 2];
    if (type === 2) ops.push(`${f(x)} ${f(y)} m`);
    else if (type === 1 && s + 2 < n) {
      ops.push(`${f(x)} ${f(y)} ${f(path[4 * s + 5])} ${f(path[4 * s + 6])} ${f(path[4 * s + 9])} ${f(path[4 * s + 10])} c`);
      s += 2;
    } else ops.push(`${f(x)} ${f(y)} l`);
    if (path[4 * s + 3]) ops.push('h');
  }
  return ops.join(' ');
}

/** The smallest user-space rect holding every point of `fills` (a bold appearance must not be clipped by its /Rect). */
export function fillBounds(fills: readonly ApFill[]): PdfUserRect | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const { path } of fills) {
    for (let s = 0; s + 3 < path.length; s += 4) {
      const x = path[s + 1];
      const y = path[s + 2];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}
