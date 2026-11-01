// Mark geometry: PDFium's line rects turned into clean mark shapes (R44), and the maths between page space, 0–1 anchor
// space and CSS pixels at any rotation. Pure; no DOM.
//
// Where the rects come from. A mark is built from PageTextProvider.rects (PdfBackend.getTextRangeRects): PDFium's own
// line rectangles, the ones Chrome's viewer paints. Their heights follow the ink of each line, so one paragraph gives
// rects between 8.2 and 10.6 pt tall (a line with no ascenders is shorter) and neighbouring lines can touch or overlap.
// `normalizeLineRects` gives every line the same height from its font size, centred on its baseline, and cuts any
// overlap between neighbouring lines in half. Highlights, underlines and strikes then all use the same rects, in one
// SVG path per style and colour, so nothing is darker where two rects meet.
//
// Spaces. Page space (PdfRect) is points, unrotated, origin at the top-left of the crop box, y down. Anchor space
// (NormRect) is 0–1 of the crop box in that same unrotated space. CSS space is the displayed page: the unrotated page
// turned clockwise by `rotation` (the page's /Rotate plus the viewer's own turn) and scaled by `scale` CSS px a point.
import type { Anchor, NormRect } from '../../../core/src/model/anchor';
import type { MarkColor } from '../../../core/src/model/rows';
import type { Glyph, PdfRect, Rotation } from '../backend/types';

/** A rectangle by its top-left corner and size. In CSS px for everything drawn, in points for PdfRect. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------------------------------------------------
// Page space ↔ anchor space ↔ CSS px
// ---------------------------------------------------------------------------------------------------------------------

/**
 * A page's unrotated crop box in points. `x` and `y` are where its top-left corner is in the space the rects are in;
 * the engine's rects are already relative to that corner, so they are 0 (the default).
 */
export interface PageDims {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Points → 0–1 of the crop box, clipped to the page. */
export function pdfRectToNorm(r: PdfRect, page: PageDims): NormRect {
  const ox = page.x ?? 0;
  const oy = page.y ?? 0;
  return [clamp01((r.x - ox) / page.width), clamp01((r.y - oy) / page.height), clamp01((r.x + r.width - ox) / page.width), clamp01((r.y + r.height - oy) / page.height)];
}

/** 0–1 of the crop box → points. */
export function normToPdfRect(n: NormRect, page: PageDims): PdfRect {
  const ox = page.x ?? 0;
  const oy = page.y ?? 0;
  return { x: ox + n[0] * page.width, y: oy + n[1] * page.height, width: (n[2] - n[0]) * page.width, height: (n[3] - n[1]) * page.height };
}

/** The size of the displayed page in CSS px. */
export function displaySize(page: PageDims, scale: number, rotation: Rotation): { width: number; height: number } {
  const sideways = rotation === 90 || rotation === 270;
  return { width: (sideways ? page.height : page.width) * scale, height: (sideways ? page.width : page.height) * scale };
}

/** 0–1 of the crop box → the box it covers on the displayed page, in CSS px. */
export function normToCss(n: NormRect, page: PageDims, scale: number, rotation: Rotation): Box {
  const { width: w, height: h } = displaySize(page, scale, rotation);
  const [u0, v0, u1, v1] = n;
  let x0: number, y0: number, x1: number, y1: number;
  switch (rotation) {
    case 90:
      [x0, y0, x1, y1] = [1 - v1, u0, 1 - v0, u1];
      break;
    case 180:
      [x0, y0, x1, y1] = [1 - u1, 1 - v1, 1 - u0, 1 - v0];
      break;
    case 270:
      [x0, y0, x1, y1] = [v0, 1 - u1, v1, 1 - u0];
      break;
    default:
      [x0, y0, x1, y1] = [u0, v0, u1, v1];
  }
  return { x: x0 * w, y: y0 * h, width: (x1 - x0) * w, height: (y1 - y0) * h };
}

/** A point on the displayed page (CSS px) → where it is in 0–1 of the unrotated crop box. The inverse of normToCss. */
export function cssToNorm(p: { x: number; y: number }, page: PageDims, scale: number, rotation: Rotation): [u: number, v: number] {
  const { width: w, height: h } = displaySize(page, scale, rotation);
  const x = p.x / w;
  const y = p.y / h;
  switch (rotation) {
    case 90:
      return [y, 1 - x];
    case 180:
      return [1 - x, 1 - y];
    case 270:
      return [1 - y, x];
    default:
      return [x, y];
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Line rects: uniform height, no overlap
// ---------------------------------------------------------------------------------------------------------------------

/**
 * A line is drawn from this far above its baseline to this far below it, in font sizes. The sum, 1.2, is the line pitch
 * of ordinary 10/12 text, so the lines of a paragraph tile with no gap; the split is the ascent and descent of the
 * common text fonts (0.93 and 0.27 in the Times-like font of the ResNet paper), enough for tall letters and descenders.
 */
export const LINE_ASCENT = 0.93;
export const LINE_DESCENT = 0.27;

/** How a line of text runs on the unrotated page: the angle of its glyphs. */
type Direction = 0 | 90 | 180 | 270;

/** What the normaliser found for one line rect: where its glyphs sit and how big they are. */
export interface LineInfo {
  /** The line as PDFium gave it (or as the vertical runs were joined). */
  rect: PdfRect;
  /** Null when the glyphs run at no right angle, or the rect holds none: the rect is then left as it is. */
  direction: Direction | null;
  /** Points. The size most of the line's glyphs have. 0 when unknown. */
  fontSize: number;
  /** Where the glyphs sit: the baseline's y for text that runs sideways, its x for text that runs up or down. */
  baseline: number;
  /** How many glyphs the numbers come from. */
  glyphs: number;
}

interface Prepared {
  rect: PdfRect;
  glyphs: Glyph[];
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

function directionOf(angle: number): Direction | null {
  const a = ((angle % 360) + 360) % 360;
  const nearest = (Math.round(a / 90) % 4) * 90;
  const off = Math.min(Math.abs(a - nearest), 360 - Math.abs(a - nearest));
  return off <= 5 ? (nearest as Direction) : null;
}

/** The glyph's own "up" is along: 0 → −y, 90 → +x, 180 → +y, 270 → −x. The baseline is on the glyph's low side. */
function baselineOf(g: Glyph, dir: Direction): number {
  const t = g.tight;
  switch (dir) {
    case 0:
      return t.y + t.height;
    case 90:
      return t.x;
    case 180:
      return t.y;
    case 270:
      return t.x + t.width;
  }
}

/**
 * Puts each glyph of the range in the smallest rect that holds the centre of its ink (a comma that PDFium gave a rect of
 * its own is then in that rect, not in the line's), or the nearest rect if it is close.
 */
function assign(rects: readonly PdfRect[], glyphs: readonly Glyph[]): Glyph[][] {
  const out: Glyph[][] = rects.map(() => []);
  for (const g of glyphs) {
    if (g.generated || g.fontSize <= 0) continue;
    const ink = g.tight.width > 0 && g.tight.height > 0 ? g.tight : g.box;
    const cx = ink.x + ink.width / 2;
    const cy = ink.y + ink.height / 2;
    let best = -1;
    let bestDistance = Infinity;
    let bestArea = Infinity;
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      const dx = cx < r.x ? r.x - cx : cx > r.x + r.width ? cx - (r.x + r.width) : 0;
      const dy = cy < r.y ? r.y - cy : cy > r.y + r.height ? cy - (r.y + r.height) : 0;
      const d = Math.hypot(dx, dy);
      const area = r.width * r.height;
      if (d < bestDistance || (d === bestDistance && d === 0 && area < bestArea)) {
        bestDistance = d;
        bestArea = area;
        best = i;
      }
    }
    // A glyph far from every rect (outside the requested range) belongs to none.
    if (best >= 0 && bestDistance <= g.fontSize * 0.5) out[best].push(g);
  }
  return out;
}

/**
 * PDFium joins the rects of text that runs sideways into lines, but not those of text that runs up or down (a rotated
 * table header comes back as one rect per char, and a space in it as a rect with no width). Joins neighbouring rects of
 * such text that are on one line: glyphs whose centres are on one line, a gap along it of at most a font size, and
 * spaces (rects with no glyph of their own and no thickness) that fall between two pieces of one line.
 */
function joinVertical(items: Prepared[]): Prepared[] {
  const dirOf = (p: Prepared): Direction | null => (p.glyphs.length > 0 ? directionOf(p.glyphs[0].angle) : null);
  const centreX = (p: Prepared): number => median(p.glyphs.map((g) => g.box.x + g.box.width / 2));
  const out: Prepared[] = [];
  for (const p of items) {
    const prev = out[out.length - 1];
    if (prev) {
      const d = dirOf(prev);
      if (d === 90 || d === 270) {
        const a = prev.rect;
        const b = p.rect;
        const fontSize = prev.glyphs[0].fontSize;
        const along = Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height));
        const space = p.glyphs.length === 0 && b.width < 0.5;
        const sameLine = space
          ? b.x >= a.x - fontSize * 0.5 && b.x <= a.x + a.width + fontSize * 0.5
          : dirOf(p) === d && Math.abs(centreX(p) - centreX(prev)) <= 0.35 * fontSize;
        if (sameLine && along <= fontSize) {
          const x = Math.min(a.x, b.x);
          const y = Math.min(a.y, b.y);
          prev.rect = { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
          prev.glyphs = prev.glyphs.concat(p.glyphs);
          continue;
        }
      }
    }
    out.push({ rect: { ...p.rect }, glyphs: p.glyphs.slice() });
  }
  return out;
}

/**
 * The glyphs of the whole line a rect is on, not just the ones the rect holds: every glyph of the page that runs the same
 * way, is the same size and has the same line box (the loose box PDFium gives every glyph of a font and size is the same
 * from one glyph of a line to the next). A selection of one letter, or of a comma, then gets the baseline of its line,
 * and every selection of one line gets the same band. Falls back to the rect's own glyphs.
 */
function lineMates(own: Glyph[], dir: Direction, size: number, context: readonly Glyph[]): Glyph[] {
  const horizontal = dir === 0 || dir === 180;
  const across = (g: Glyph) => (horizontal ? g.box.y : g.box.x);
  const thick = (g: Glyph) => (horizontal ? g.box.height : g.box.width);
  const at = median(own.map(across));
  const span = median(own.map(thick));
  const mates = context.filter(
    (g) =>
      !g.generated &&
      g.tight.width > 0 &&
      g.tight.height > 0 &&
      directionOf(g.angle) === dir &&
      Math.abs(g.fontSize - size) <= 0.12 * size &&
      Math.abs(across(g) - at) <= 0.08 * size &&
      Math.abs(thick(g) - span) <= 0.1 * size,
  );
  return mates.length >= own.length ? mates : own;
}

function describe(p: Prepared, context: readonly Glyph[]): LineInfo {
  const unknown: LineInfo = { rect: p.rect, direction: null, fontSize: 0, baseline: 0, glyphs: 0 };
  if (p.glyphs.length === 0) return unknown;
  // The direction most glyphs run in.
  const votes = new Map<Direction | null, number>();
  for (const g of p.glyphs) {
    const d = directionOf(g.angle);
    votes.set(d, (votes.get(d) ?? 0) + 1);
  }
  let direction: Direction | null = null;
  let most = 0;
  for (const [d, n] of votes) {
    if (n > most) {
      most = n;
      direction = d;
    }
  }
  if (direction === null) return unknown;
  const dir = direction;
  const inkful = p.glyphs.filter((g) => g.tight.width > 0 && g.tight.height > 0 && directionOf(g.angle) === dir);
  if (inkful.length === 0) return unknown;
  // The size most of the glyphs have; a tie goes to the bigger.
  const sizes = new Map<number, number>();
  for (const g of inkful) {
    const k = Math.round(g.fontSize * 10) / 10;
    sizes.set(k, (sizes.get(k) ?? 0) + 1);
  }
  let size = 0;
  let count = 0;
  for (const [k, n] of sizes) {
    if (n > count || (n === count && k > size)) {
      size = k;
      count = n;
    }
  }
  const same = inkful.filter((g) => Math.abs(g.fontSize - size) <= 0.12 * size);
  const line = lineMates(same, dir, size, context);
  return { rect: p.rect, direction: dir, fontSize: size, baseline: median(line.map((g) => baselineOf(g, dir))), glyphs: same.length };
}

/** The rect of a line of `info.fontSize` text on `info.baseline`: its own length, the standard height. */
function band(info: LineInfo): PdfRect {
  const { rect: r, direction, fontSize: fs, baseline: b } = info;
  if (direction === null || fs <= 0) return { ...r };
  switch (direction) {
    case 0:
      return { x: r.x, y: b - LINE_ASCENT * fs, width: r.width, height: (LINE_ASCENT + LINE_DESCENT) * fs };
    case 180:
      return { x: r.x, y: b - LINE_DESCENT * fs, width: r.width, height: (LINE_ASCENT + LINE_DESCENT) * fs };
    case 90:
      return { x: b - LINE_DESCENT * fs, y: r.y, width: (LINE_ASCENT + LINE_DESCENT) * fs, height: r.height };
    case 270:
      return { x: b - LINE_ASCENT * fs, y: r.y, width: (LINE_ASCENT + LINE_DESCENT) * fs, height: r.height };
  }
}

/**
 * Cuts the overlap between neighbouring lines in half. Two rects are neighbours when they run the same way, share part
 * of their length (so the two columns of a page never touch) and overlap across it. A line that is cut on one side only
 * (the first or the last of a paragraph) is cut by the same amount on its free side, so that every line of a block is
 * as tall as the ones between its neighbours.
 */
function separate(rects: PdfRect[], infos: LineInfo[]): void {
  const cutLow = new Array<number>(rects.length).fill(0);
  const cutHigh = new Array<number>(rects.length).fill(0);
  for (const horizontal of [true, false]) {
    const idx = rects.map((_, i) => i).filter((i) => (horizontal ? infos[i].direction === 0 || infos[i].direction === 180 : infos[i].direction === 90 || infos[i].direction === 270));
    const lo = (i: number) => (horizontal ? rects[i].y : rects[i].x);
    const hi = (i: number) => (horizontal ? rects[i].y + rects[i].height : rects[i].x + rects[i].width);
    const along0 = (i: number) => (horizontal ? rects[i].x : rects[i].y);
    const along1 = (i: number) => (horizontal ? rects[i].x + rects[i].width : rects[i].y + rects[i].height);
    const setLo = (i: number, v: number) => {
      if (horizontal) {
        rects[i].height = hi(i) - v;
        rects[i].y = v;
      } else {
        rects[i].width = hi(i) - v;
        rects[i].x = v;
      }
    };
    const setHi = (i: number, v: number) => {
      if (horizontal) rects[i].height = v - rects[i].y;
      else rects[i].width = v - rects[i].x;
    };
    idx.sort((a, b) => lo(a) - lo(b));
    for (let p = 0; p < idx.length; p++) {
      for (let q = p + 1; q < idx.length; q++) {
        const a = idx[p];
        const b = idx[q];
        // Sorted by start: once one starts at or below a's end, every later one does too.
        if (lo(b) >= hi(a)) break;
        if (Math.min(along1(a), along1(b)) - Math.max(along0(a), along0(b)) <= 0.5) continue; // not above each other
        // Only an ordinary overlap is cut: a starts first and ends inside b.
        if (!(lo(a) < lo(b) && hi(a) < hi(b))) continue;
        const mid = (hi(a) + lo(b)) / 2;
        cutHigh[a] += hi(a) - mid;
        cutLow[b] += mid - lo(b);
        setHi(a, mid);
        setLo(b, mid);
      }
    }
    for (const i of idx) {
      if (cutLow[i] > 0 && cutHigh[i] === 0) setHi(i, hi(i) - cutLow[i]);
      else if (cutHigh[i] > 0 && cutLow[i] === 0) setLo(i, lo(i) + cutHigh[i]);
    }
  }
}

/**
 * A rect with only a glyph or two (a comma or a full stop that PDFium gave a rect of its own, a space in a rotated line)
 * has no baseline worth trusting: a comma's ink hangs below it. It takes the size and baseline of a line it sits on,
 * the nearest rect that runs the same way, overlaps it across the line and is within a font size of it along the line.
 */
const WEAK_GLYPHS = 3;

function adoptNeighbours(infos: LineInfo[]): LineInfo[] {
  return infos.map((weak) => {
    if (weak.glyphs >= WEAK_GLYPHS) return weak;
    const r = weak.rect;
    let best: LineInfo | null = null;
    let bestAlong = Infinity;
    for (const l of infos) {
      if (l === weak || l.glyphs < WEAK_GLYPHS || l.direction === null) continue;
      if (weak.direction !== null && weak.direction !== l.direction) continue;
      const horizontal = l.direction === 0 || l.direction === 180;
      const a = l.rect;
      const across = horizontal ? Math.min(a.y + a.height, r.y + r.height) - Math.max(a.y, r.y) : Math.min(a.x + a.width, r.x + r.width) - Math.max(a.x, r.x);
      const thin = horizontal ? r.height : r.width;
      // A comma hangs below the baseline, so it may share little with a line that has no descenders: it counts as on the
      // line when it lies within a third of a font size of the line's rect.
      const slack = 0.3 * l.fontSize;
      const within = horizontal ? r.y >= a.y - slack && r.y + r.height <= a.y + a.height + slack : r.x >= a.x - slack && r.x + r.width <= a.x + a.width + slack;
      const along = horizontal ? Math.max(r.x - (a.x + a.width), a.x - (r.x + r.width)) : Math.max(r.y - (a.y + a.height), a.y - (r.y + r.height));
      if ((across >= 0.5 * thin || within) && along <= l.fontSize && along < bestAlong) {
        best = l;
        bestAlong = along;
      }
    }
    return best ? { ...weak, direction: best.direction, fontSize: best.fontSize, baseline: best.baseline } : weak;
  });
}

/** What the normaliser sees in each line (for tools and tests); `normalizeLineRects` is these lines drawn at one height. */
export function analyzeLines(rects: readonly PdfRect[], glyphs: readonly Glyph[], context: readonly Glyph[] = glyphs): LineInfo[] {
  const lines = joinVertical(assign(rects, glyphs).map((g, i) => ({ rect: rects[i], glyphs: g })));
  return sameBaselines(adoptNeighbours(lines.map((l) => describe(l, context))));
}

/**
 * Pieces of one line (the rects either side of a comma, the two columns of a page) measure their baselines a hair apart,
 * because round letters overshoot it by different amounts. Rects of one size that run the same way with baselines within
 * an eighth of a font size of each other take the baseline of the one with the most glyphs, so that they join with no seam.
 */
function sameBaselines(infos: LineInfo[]): LineInfo[] {
  const out = infos.map((l) => ({ ...l }));
  const idx = out.map((_, i) => i).filter((i) => out[i].direction !== null && out[i].fontSize > 0);
  for (const dir of [0, 90, 180, 270] as const) {
    const group = idx.filter((i) => out[i].direction === dir).sort((a, b) => out[a].baseline - out[b].baseline);
    let chain: number[] = [];
    const flush = () => {
      if (chain.length > 1) {
        const main = chain.reduce((best, i) => (out[i].glyphs > out[best].glyphs ? i : best), chain[0]);
        for (const i of chain) out[i].baseline = out[main].baseline;
      }
      chain = [];
    };
    for (const i of group) {
      const prev = chain[chain.length - 1];
      if (prev !== undefined && out[i].baseline - out[prev].baseline <= 0.125 * out[i].fontSize && Math.abs(out[i].fontSize - out[prev].fontSize) <= 0.12 * out[i].fontSize) chain.push(i);
      else {
        flush();
        chain = [i];
      }
    }
    flush();
  }
  return out;
}

/**
 * Pieces of one line that PDFium left as separate rects (the two sides of a comma, a word either side of a wide space) are
 * one rect once they have the same band: same direction, size and baseline, and no more than 0.6 font sizes between them.
 * A column gap is wider than that, so the columns of a page stay apart.
 */
function joinLinePieces(infos: LineInfo[], bands: PdfRect[]): [LineInfo[], PdfRect[]] {
  const groups = new Map<string, number[]>();
  infos.forEach((l, i) => {
    if (l.direction === null || l.fontSize <= 0) return;
    const key = `${l.direction}:${Math.round(l.baseline * 100)}:${Math.round(l.fontSize * 10)}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(i);
  });
  const into = new Map<number, number>(); // member → the first piece of its line
  const rects = bands.map((r) => ({ ...r }));
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const horizontal = infos[members[0]].direction === 0 || infos[members[0]].direction === 180;
    const start = (i: number) => (horizontal ? bands[i].x : bands[i].y);
    const end = (i: number) => (horizontal ? bands[i].x + bands[i].width : bands[i].y + bands[i].height);
    const byPosition = members.slice().sort((a, b) => start(a) - start(b));
    let head = byPosition[0];
    let reach = end(head);
    for (const i of byPosition.slice(1)) {
      if (start(i) - reach <= 0.6 * infos[head].fontSize) {
        into.set(i, head);
        reach = Math.max(reach, end(i));
        if (horizontal) rects[head].width = reach - rects[head].x;
        else rects[head].height = reach - rects[head].y;
      } else {
        head = i;
        reach = end(i);
      }
    }
  }
  const keep = bands.map((_, i) => i).filter((i) => !into.has(i));
  return [keep.map((i) => infos[i]), keep.map((i) => rects[i])];
}

/**
 * PDFium's line rects for a range of chars, every one made as tall as its font size says: from 0.93 font sizes above the
 * baseline to 0.27 below it. `glyphs` are the range's glyphs from PageGlyphs (more are fine). `context` is the whole page's
 * glyphs, which give a short selection (a letter, a comma) the baseline of its line; without it only `glyphs` are read.
 * Rects of sideways text that
 * PDFium left in pieces are joined into lines first. A line with no glyphs, or glyphs at an odd angle, keeps its rect.
 * Neighbouring lines that would overlap are cut at the middle of the overlap, so they touch and never overlap.
 * The result is in reading order, one rect per line (per column where a line crosses a column gap).
 */
export function normalizeLineRects(rects: readonly PdfRect[], glyphs: readonly Glyph[], context: readonly Glyph[] = glyphs): PdfRect[] {
  const all = analyzeLines(rects, glyphs, context);
  const [infos, out] = joinLinePieces(all, all.map(band));
  separate(out, infos);
  // A rect with no thickness (the space inside a rotated line that was not joined) draws nothing.
  return out.filter((r) => r.width >= 0.5 && r.height >= 0.5);
}

/** The minimum of PageTextProvider that `markLineRects` reads. */
export interface RectSource {
  rects(pageIndex: number, start: number, count: number): Promise<PdfRect[]>;
  glyphs(pageIndex: number): Promise<{ glyphs: Glyph[] }>;
}

/**
 * The rects a mark or a selection is drawn with for chars [start, start + count) of a page: PDFium's line rects at one
 * height per line (see normalizeLineRects). Glyphs are read from the cache the text layer fills, so this adds no engine
 * call for a page that is on screen.
 */
export async function markLineRects(text: RectSource, pageIndex: number, start: number, count: number): Promise<PdfRect[]> {
  const [rects, page] = await Promise.all([text.rects(pageIndex, start, count), text.glyphs(pageIndex)]);
  return normalizeLineRects(rects, page.glyphs.slice(Math.max(0, start), Math.max(0, start) + Math.max(0, count)), page.glyphs);
}

// ---------------------------------------------------------------------------------------------------------------------
// SVG paths: one per style and colour
// ---------------------------------------------------------------------------------------------------------------------

export interface PathOptions {
  /** Device pixels per CSS px. When given, every edge snaps to a whole device pixel, so edges are crisp. */
  pixelRatio?: number;
}

const fmt = (v: number): string => String(Math.round(v * 1000) / 1000);

function snapper(o: PathOptions | undefined): (v: number) => number {
  const r = o?.pixelRatio;
  return r && r > 0 ? (v) => Math.round(v * r) / r : (v) => v;
}

/** One closed rectangle, always drawn the same way round, so that overlapping rects in one path fill as one shape. */
function rectD(x0: number, y0: number, x1: number, y1: number): string {
  return `M${fmt(x0)} ${fmt(y0)}H${fmt(x1)}V${fmt(y1)}H${fmt(x0)}Z`;
}

/** A highlight: the rects themselves. */
export function highlightPath(rects: readonly Box[], o?: PathOptions): string {
  const s = snapper(o);
  return rects.map((r) => rectD(s(r.x), s(r.y), s(r.x + r.width), s(r.y + r.height))).join('');
}

/** An underline: a bar of `thickness` CSS px (default 1) on the bottom edge of each rect. */
export function underlinePath(rects: readonly Box[], o?: PathOptions & { thickness?: number }): string {
  const s = snapper(o);
  const t = o?.thickness ?? 1;
  return rects.map((r) => rectD(s(r.x), s(r.y + r.height - t), s(r.x + r.width), s(r.y + r.height))).join('');
}

/** A strikethrough: a bar of `thickness` CSS px (default 1) through the middle of each rect. */
export function strikePath(rects: readonly Box[], o?: PathOptions & { thickness?: number }): string {
  const s = snapper(o);
  const t = o?.thickness ?? 1;
  return rects.map((r) => rectD(s(r.x), s(r.y + r.height / 2 - t / 2), s(r.x + r.width), s(r.y + r.height / 2 + t / 2))).join('');
}

/**
 * The dotted underline of a comment whose text has no style left: square dots of `thickness` CSS px (default 1.5) with
 * a gap of the same size between them, on the bottom edge of the same rects an underline uses.
 */
export function dottedUnderlinePath(rects: readonly Box[], o?: PathOptions & { thickness?: number }): string {
  const s = snapper(o);
  const t = o?.thickness ?? 1.5;
  const parts: string[] = [];
  for (const r of rects) {
    const y1 = r.y + r.height;
    const y0 = y1 - t;
    for (let x = r.x; x < r.x + r.width - 1e-6; x += 2 * t) {
      parts.push(rectD(s(x), s(y0), s(Math.min(x + t, r.x + r.width)), s(y1)));
    }
  }
  return parts.join('');
}

export type ShapeStyle = 'highlight' | 'underline' | 'strike' | 'dotted';

export interface MarkShape {
  style: ShapeStyle;
  /** The colour slot (tokens --sop-mark-1 … 5). Null for a dotted underline, which has no colour of its own. */
  color: MarkColor | null;
  /** In CSS px on the displayed page, as normToCss gives them. */
  rects: readonly Box[];
}

export interface MarkPath {
  /** `${style}:${color}`, a stable key for the SVG element. */
  key: string;
  style: ShapeStyle;
  color: MarkColor | null;
  d: string;
}

const DRAW_ORDER: ShapeStyle[] = ['highlight', 'underline', 'strike', 'dotted'];

/**
 * The shapes of a page grouped into one path for each style and colour, so overlapping marks of one colour never draw
 * darker. Highlights come first (they sit under), then underlines, strikes and dotted underlines.
 */
export function markPaths(shapes: readonly MarkShape[], o?: PathOptions & { thickness?: number }): MarkPath[] {
  const groups = new Map<string, { style: ShapeStyle; color: MarkColor | null; rects: Box[] }>();
  for (const s of shapes) {
    const key = `${s.style}:${s.color ?? 0}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { style: s.style, color: s.color, rects: [] }));
    g.rects.push(...s.rects);
  }
  const build = (style: ShapeStyle, rects: Box[]): string =>
    style === 'highlight' ? highlightPath(rects, o) : style === 'underline' ? underlinePath(rects, o) : style === 'strike' ? strikePath(rects, o) : dottedUnderlinePath(rects, o);
  return [...groups.entries()]
    .sort(([, a], [, b]) => DRAW_ORDER.indexOf(a.style) - DRAW_ORDER.indexOf(b.style) || (a.color ?? 0) - (b.color ?? 0))
    .map(([key, g]) => ({ key, style: g.style, color: g.color, d: build(g.style, g.rects) }));
}

// ---------------------------------------------------------------------------------------------------------------------
// Hit test and order
// ---------------------------------------------------------------------------------------------------------------------

export function boxContains(r: Box, p: { x: number; y: number }, pad = 0): boolean {
  return p.x >= r.x - pad && p.x <= r.x + r.width + pad && p.y >= r.y - pad && p.y <= r.y + r.height + pad;
}

/**
 * The ids of the marks under a point (CSS px on the displayed page), the one drawn last first. `pad` grows every rect by
 * that many CSS px, for a finger or a thin underline.
 */
export function hitTest(items: readonly { id: string; rects: readonly Box[] }[], p: { x: number; y: number }, pad = 0): string[] {
  const hits: string[] = [];
  for (let i = items.length - 1; i >= 0; i--) if (items[i].rects.some((r) => boxContains(r, p, pad))) hits.push(items[i].id);
  return hits;
}

/**
 * The value a mark or a note sorts by inside its page (the schema's `sort_key`): the top of its first rect, 0–1 of the
 * page, so that rows come out in reading order (page, then top to bottom). A text anchor without rects (a comment made
 * in claude.ai) uses where it starts in the page's text, `start.index ÷ pageTextLength`, or 0 when that length is
 * not given. A document note has no place on a page, so it has no key.
 */
export function sortKey(anchor: Anchor, o: { pageTextLength?: number } = {}): number | null {
  switch (anchor.kind) {
    case 'text': {
      const first = anchor.rects.find((r) => r.rects.length > 0);
      if (first) return clamp01(first.rects[0][1]);
      return o.pageTextLength && o.pageTextLength > 0 ? clamp01(anchor.start.index / o.pageTextLength) : 0;
    }
    case 'area':
    case 'figure':
      return clamp01(anchor.rect[1]);
    case 'point':
      return clamp01(anchor.point[1]);
    case 'page':
      return 0;
    case 'document':
      return null;
  }
}
