// How much of a glyph a picture of its page shows (ruling R90: bold word starts draw only what the page shows). A PDF
// can hold text it never shows: text clipped away, text under an image or a white box, text in the colour behind it,
// a scan's own words under its picture. The engine leaves out what it can tell from the PDF itself (invisible render
// modes, clip paths, the page box); this is the last check, on the page's picture, for everything else.
//
// A glyph's ink is read where its outline is: the picture's pixels whose centres fall inside the outline (nonzero
// winding, as glyphs are filled), against the ground just around it (the median of the other pixels of its box, one
// pixel out). Each inside pixel counts by how far it is from the ground towards the glyph's own fill: 1 where the
// picture shows the fill, 0 where it shows the ground. A glyph whose fill is too close to its ground (white on white)
// shows nothing.
import type { PdfColor } from '../backend/types';
import type { TurnMatrix } from '../view/page-transform';

/** A picture of a page, as luminance (one byte a pixel, 0 black to 255 white, row by row), and how the page maps to it. */
export interface InkPicture {
  lum: Uint8Array;
  width: number;
  height: number;
  /** Unrotated page points (top-left origin, y down) → the picture's px: pageToDevice. */
  device: TurnMatrix;
}

/** A fill this close to its ground (of 255, luminance) cannot be seen: the glyph shows nothing. */
const MIN_CONTRAST = 40;
/** At most this many sample rows and columns a glyph: a large glyph is read on a coarser grid. */
const MAX_SAMPLES_ACROSS = 32;
/** Fewer inside samples than this: the glyph is too small to read. */
const MIN_SAMPLES = 2;
/** Each cubic is read as this many straight pieces. */
const CURVE_STEPS = 4;

/** The luminance of an RGBA picture (Rec. 709 weights on the 8-bit values). */
export function luminanceOf(rgba: ArrayLike<number>, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) out[i] = (54 * rgba[p] + 183 * rgba[p + 1] + 19 * rgba[p + 2] + 128) >> 8;
  return out;
}

const fillLuminance = ([r, g, b]: PdfColor) => (54 * r + 183 * g + 19 * b) / 256;

// Scratch space, grown as needed: the outline's edges in picture px (x0, y0, x1, y1), a row's crossings and the inside mask.
let edges = new Float64Array(1024);
let crossX = new Float64Array(64);
let crossW = new Int8Array(64);
let mask = new Uint8Array(4096);
const ground = new Uint32Array(256);

/**
 * The glyph's ink in `pic`, 0 to 1, rounded to hundredths: its em outline `em` ([type, x, y, close] per segment, ems,
 * y up: 2 move, 0 line, 1 cubic point), placed by `m` (ems → unrotated page points, y down) at (`x`, `y`), filled with
 * `fill`. Undefined when the glyph is too small in the picture to read, or off it.
 */
export function glyphInk(pic: InkPicture, em: Float32Array, m: readonly [number, number, number, number], x: number, y: number, fill: PdfColor): number | undefined {
  const [A, B, C, D, E, F] = pic.device;
  const a = A * m[0] + C * m[1];
  const b = B * m[0] + D * m[1];
  const c = A * m[2] + C * m[3];
  const d = B * m[2] + D * m[3];
  const e = A * x + C * y + E;
  const f = B * x + D * y + F;
  const n = flatten(em, a, b, c, d, e, f);
  if (n === 0) return undefined;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let k = 0; k < 4 * n; k += 2) {
    x0 = Math.min(x0, edges[k]);
    x1 = Math.max(x1, edges[k]);
    y0 = Math.min(y0, edges[k + 1]);
    y1 = Math.max(y1, edges[k + 1]);
  }
  // The box one px out, on the picture.
  const bx0 = Math.max(0, Math.floor(x0) - 1);
  const by0 = Math.max(0, Math.floor(y0) - 1);
  const bx1 = Math.min(pic.width, Math.ceil(x1) + 1);
  const by1 = Math.min(pic.height, Math.ceil(y1) + 1);
  if (bx1 <= bx0 || by1 <= by0) return undefined;
  const step = Math.max(1, Math.floor(Math.min(bx1 - bx0, by1 - by0) / MAX_SAMPLES_ACROSS));
  const cols = Math.ceil((bx1 - bx0) / step);
  const rows = Math.ceil((by1 - by0) / step);
  if (mask.length < cols * rows) mask = new Uint8Array(2 * cols * rows);
  mask.fill(0, 0, cols * rows);
  // Which sample pixels are inside: per row, the outline's crossings at the pixel centres' height, nonzero winding.
  let inside = 0;
  for (let r = 0; r < rows; r++) {
    const py = by0 + r * step + 0.5;
    let count = 0;
    for (let k = 0; k < n; k++) {
      const ex0 = edges[4 * k];
      const ey0 = edges[4 * k + 1];
      const ex1 = edges[4 * k + 2];
      const ey1 = edges[4 * k + 3];
      if (ey0 <= py === ey1 <= py) continue;
      if (count === crossX.length) {
        crossX = grow(crossX);
        const w = new Int8Array(2 * crossW.length);
        w.set(crossW);
        crossW = w;
      }
      // Sorted as they come (a row crosses a glyph a few times).
      const cx = ex0 + ((py - ey0) * (ex1 - ex0)) / (ey1 - ey0);
      const cw = ey1 > ey0 ? 1 : -1;
      let j = count++;
      while (j > 0 && crossX[j - 1] > cx) {
        crossX[j] = crossX[j - 1];
        crossW[j] = crossW[j - 1];
        j--;
      }
      crossX[j] = cx;
      crossW[j] = cw;
    }
    let winding = 0;
    let from = 0;
    for (let j = 0; j < count; j++) {
      const before = winding;
      winding += crossW[j];
      if (before === 0 && winding !== 0) from = crossX[j];
      else if (before !== 0 && winding === 0) {
        // Sample columns whose centre is in [from, crossX[j]).
        const lo = Math.max(0, Math.ceil((from - 0.5 - bx0) / step));
        const hi = Math.min(cols, Math.ceil((crossX[j] - 0.5 - bx0) / step));
        for (let col = lo; col < hi; col++) {
          if (mask[r * cols + col] === 0) inside++;
          mask[r * cols + col] = 1;
        }
      }
    }
  }
  if (inside < MIN_SAMPLES) return undefined;
  // The ground: the median of the samples outside the outline.
  ground.fill(0);
  let outside = 0;
  for (let r = 0; r < rows; r++) {
    const row = (by0 + r * step) * pic.width;
    for (let col = 0; col < cols; col++) {
      if (mask[r * cols + col] !== 0) continue;
      ground[pic.lum[row + bx0 + col * step]]++;
      outside++;
    }
  }
  if (outside === 0) return undefined;
  let bg = 0;
  for (let seen = 0; bg < 255; bg++) {
    seen += ground[bg];
    if (2 * seen >= outside) break;
  }
  const contrast = (bg - fillLuminance(fill)) * ((fill[3] ?? 255) / 255);
  if (Math.abs(contrast) < MIN_CONTRAST) return 0;
  let sum = 0;
  for (let r = 0; r < rows; r++) {
    const row = (by0 + r * step) * pic.width;
    for (let col = 0; col < cols; col++) {
      if (mask[r * cols + col] === 0) continue;
      const t = (bg - pic.lum[row + bx0 + col * step]) / contrast;
      sum += t <= 0 ? 0 : t >= 1 ? 1 : t;
    }
  }
  return Math.round((100 * sum) / inside) / 100;
}

function grow(a: Float64Array<ArrayBuffer>): Float64Array<ArrayBuffer> {
  const out = new Float64Array(2 * a.length);
  out.set(a);
  return out;
}

/** The outline's edges in picture px, under ems → px (a b c d e f), every contour closed. Returns how many. */
function flatten(em: Float32Array, a: number, b: number, c: number, d: number, e: number, f: number): number {
  let n = 0;
  let sx = 0;
  let sy = 0;
  let cx = 0;
  let cy = 0;
  let open = false;
  const add = (px: number, py: number) => {
    if (4 * n + 4 > edges.length) edges = grow(edges);
    edges[4 * n] = cx;
    edges[4 * n + 1] = cy;
    edges[4 * n + 2] = px;
    edges[4 * n + 3] = py;
    n++;
    cx = px;
    cy = py;
  };
  const close = () => {
    if (open && (cx !== sx || cy !== sy)) add(sx, sy);
    open = false;
  };
  const segments = em.length / 4;
  for (let s = 0; s < segments; s++) {
    const type = em[4 * s];
    const px = a * em[4 * s + 1] + c * em[4 * s + 2] + e;
    const py = b * em[4 * s + 1] + d * em[4 * s + 2] + f;
    if (type === 2) {
      close();
      sx = cx = px;
      sy = cy = py;
      open = true;
    } else if (type === 1 && s + 2 < segments) {
      const qx = a * em[4 * s + 5] + c * em[4 * s + 6] + e;
      const qy = b * em[4 * s + 5] + d * em[4 * s + 6] + f;
      const rx = a * em[4 * s + 9] + c * em[4 * s + 10] + e;
      const ry = b * em[4 * s + 9] + d * em[4 * s + 10] + f;
      const ox = cx;
      const oy = cy;
      for (let k = 1; k <= CURVE_STEPS; k++) {
        const t = k / CURVE_STEPS;
        const u = 1 - t;
        add(u * u * u * ox + 3 * u * u * t * px + 3 * u * t * t * qx + t * t * t * rx, u * u * u * oy + 3 * u * u * t * py + 3 * u * t * t * qy + t * t * t * ry);
      }
      open = true;
      s += 2;
      if (em[4 * s + 3]) close();
      continue;
    } else {
      add(px, py);
      open = true;
    }
    if (em[4 * s + 3]) close();
  }
  close();
  return n;
}
