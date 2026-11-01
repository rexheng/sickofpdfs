// PDFium glyphs → pdf.js-style text items for the text layer (text-layer.ts). Task 22 ports this file.
//
// Geometry: everything is in CSS px at `scale` (CSS px per point) in the unrotated page's frame (origin top-left,
// y down); the page's /Rotate is applied to the whole layer, not here. A text direction θ is clockwise as
// displayed (Glyph.angle): the text runs along û = (cos θ, sin θ) and "down" from its ascender to its descender
// is v̂ = (−sin θ, cos θ). u and v below are coordinates along û and v̂.
import type { PageGlyphs, Rect } from '../engine/spike-native';

export interface TextItem {
  /** The text the span shows: Glyph.text of chars [start, start + str.length), generated spaces included. */
  str: string;
  dir: 'ltr' | 'rtl';
  /**
   * [fs·cosθ, fs·sinθ, −fs·sinθ, fs·cosθ, x, y]: fs is the PDF font size in CSS px, θ the text direction, and
   * (x, y) the item box's corner at the start of û and the top of v̂ (top-left for horizontal text).
   */
  transform: [number, number, number, number, number, number];
  /** Extent along û: the span is scaled to exactly this width. */
  width: number;
  /** Extent along v̂ (PDFium's loose box: the font's ascent to descent): the span's content area is scaled to it. */
  height: number;
  /** A PDFium line break follows (its '\r\n' chars are not shown; the layer adds a <br>). */
  hasEOL: boolean;
  /** PDFium char index of str[0]. */
  start: number;
}

/** The layer's font, bundled with the extension (pdf/NotoSans-Regular.ttf); Hebrew and other scripts fall back. */
export const TEXT_LAYER_FONT_FAMILY = '"sop-text-layer", sans-serif';
export const cssFont = (sizePx: number) => `${sizePx}px ${TEXT_LAYER_FONT_FAMILY}`;
/** FPDFText_GetText's mark for a line-end hyphen that PDFium joins across the break; getTextRange drops it. */
export const PDFIUM_HYPHEN = '￾';
/** Largest predicted-vs-PDFium edge error allowed inside one item before it is split. */
export const DRIFT_PX = 0.5;

/**
 * One character as the text layer sees it: a code point (an astral char is two PDFium chars), with its own box.
 * Chars that share one PDFium box (ligature expansions such as "ffi") get equal shares of its width along û.
 */
export interface GlyphUnit {
  start: number;
  /** Exclusive. */
  end: number;
  text: string;
  /** Points, unrotated page space; null for a generated char or an empty box. */
  box: Rect | null;
  angle: number;
  fontSize: number;
  generated: boolean;
  /** '\r' or '\n': a line break, not shown. */
  lineBreak: boolean;
  /** PDFium's joined line-end hyphen (PDFIUM_HYPHEN): shown, but not selectable or copied. */
  hyphen: boolean;
}

const isHigh = (s: string) => s.length === 1 && s.charCodeAt(0) >= 0xd800 && s.charCodeAt(0) <= 0xdbff;
const isLow = (s: string) => s.length === 1 && s.charCodeAt(0) >= 0xdc00 && s.charCodeAt(0) <= 0xdfff;
const sameBox = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const RTL_SCRIPT = /[֐-ࣿיִ-﷿ﹰ-ﻼ]|\ud802[\udc00-\udfff]|\ud83a[\udc00-\udfff]/;

/** The page's chars as units: surrogate pairs joined, ligature boxes split equally. */
export function glyphUnits(g: PageGlyphs): GlyphUnit[] {
  const units: GlyphUnit[] = [];
  const glyphs = g.glyphs;
  for (let i = 0; i < glyphs.length; i++) {
    const c = glyphs[i]!;
    const pair = isHigh(c.text) && i + 1 < glyphs.length && isLow(glyphs[i + 1]!.text);
    const lineBreak = c.text === '\r' || c.text === '\n';
    const hasBox = !c.generated && !lineBreak && c.box.width > 0 && c.box.height > 0;
    units.push({
      start: i,
      end: pair ? i + 2 : i + 1,
      text: pair ? c.text + glyphs[i + 1]!.text : c.text,
      box: hasBox ? { ...c.box } : null,
      angle: c.angle,
      fontSize: c.fontSize,
      generated: c.generated,
      lineBreak,
      hyphen: c.text === PDFIUM_HYPHEN,
    });
    if (pair) i++;
  }
  // Ligature expansions: consecutive units with the very same PDFium box share it equally along û.
  for (let i = 0; i < units.length; ) {
    let j = i + 1;
    const box = units[i]!.box;
    if (box) while (j < units.length && units[j]!.box && sameBox(units[j]!.box!, box) && units[j]!.angle === units[i]!.angle) j++;
    if (j - i > 1) splitAlongText(units.slice(i, j), box!, units[i]!.angle);
    i = j;
  }
  return units;
}

function splitAlongText(cluster: GlyphUnit[], box: Rect, angle: number): void {
  const t = (angle * Math.PI) / 180;
  const k = cluster.length;
  const horizontal = Math.abs(Math.cos(t)) >= Math.abs(Math.sin(t));
  const forward = horizontal ? Math.cos(t) > 0 : Math.sin(t) > 0; // û points +x (or +y)
  cluster.forEach((u, j) => {
    const slot = forward ? j : k - 1 - j;
    u.box = horizontal
      ? { x: box.x + (slot * box.width) / k, y: box.y, width: box.width / k, height: box.height }
      : { x: box.x, y: box.y + (slot * box.height) / k, width: box.width, height: box.height / k };
  });
}

/** cos and sin of a direction in degrees, exact for multiples of 90°. */
export function direction(angle: number): [number, number] {
  const q = angle / 90;
  if (Math.abs(q - Math.round(q)) < 1e-6) return [[1, 0, -1, 0][((Math.round(q) % 4) + 4) % 4]!, [0, 1, 0, -1][((Math.round(q) % 4) + 4) % 4]!];
  const t = (angle * Math.PI) / 180;
  return [Math.cos(t), Math.sin(t)];
}

/** A unit laid out for one scale: its interval along û and v̂ in CSS px. */
interface Placed {
  unit: GlyphUnit;
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  fsPx: number;
  angle: number;
}

function place(unit: GlyphUnit, box: Rect, scale: number, angle: number, fontSize: number): Placed {
  const [c, s] = direction(angle);
  const xs = [box.x, box.x + box.width].map((x) => x * scale);
  const ys = [box.y, box.y + box.height].map((y) => y * scale);
  const us: number[] = [];
  const vs: number[] = [];
  for (const x of xs) for (const y of ys) {
    us.push(x * c + y * s);
    vs.push(-x * s + y * c);
  }
  return { unit, u0: Math.min(...us), u1: Math.max(...us), v0: Math.min(...vs), v1: Math.max(...vs), fsPx: fontSize * scale, angle };
}

/** Two units can sit in one span: same direction, size (within 2%) and line band. */
function compatible(a: Placed, b: Placed): boolean {
  const da = Math.abs(a.angle - b.angle) % 360;
  if (Math.min(da, 360 - da) > 0.5) return false;
  if (Math.abs(a.fsPx - b.fsPx) > 0.02 * Math.max(a.fsPx, b.fsPx)) return false;
  const tol = 0.2 * Math.max(a.fsPx, b.fsPx);
  return Math.abs(a.v0 - b.v0) <= tol && Math.abs(a.v1 - b.v1) <= tol;
}

/**
 * Splits the page into text items with the "drift-split" rule: a span keeps growing while one horizontal
 * scale (its width over the measured width of its text) puts every char's both edges within DRIFT_PX of
 * PDFium's box; otherwise the span is emitted and the char starts the next one.
 * - Runs are not split points. PageGlyphs.runs are PDFium text objects, and Chromium's PDF output makes one
 *   text object per glyph cluster, so honouring them would make every glyph its own span (and an absolutely
 *   positioned span is its own block, which ends double-click word selection at it). Spans split instead where
 *   the direction, font size or line band changes, at PDFium line breaks, and wherever the drift rule says.
 * - A generated space is placed in the gap between its neighbours; '\r\n' ends the item (hasEOL).
 * - PDFium's joined line-end hyphen is an item of its own (the layer shows it unselectable).
 * - A span's direction comes from its first two chars' order along û (rtl when the second lies before the
 *   first); a one-char span is rtl when its char is in an RTL script.
 * `measure(text, cssFont)` must measure like the layer renders: font-kerning none, ligatures none, white-space pre.
 */
export function buildTextItems(g: PageGlyphs, measure: (text: string, cssFont: string) => number, scale: number): TextItem[] {
  const units = glyphUnits(g);
  const placed: (Placed | null)[] = units.map((u) => (u.box ? place(u, u.box, scale, u.angle, u.fontSize) : null));
  // A unit with no box (a generated space) takes the gap between its neighbours on the line.
  for (let i = 0; i < units.length; i++) {
    const u = units[i]!;
    if (placed[i] || u.lineBreak) continue;
    let p = i - 1;
    while (p >= 0 && !placed[p] && !units[p]!.lineBreak) p--;
    let n = i + 1;
    while (n < units.length && !placed[n] && !units[n]!.lineBreak) n++;
    const prev = p >= 0 && !units[p]!.lineBreak ? placed[p] : null;
    const next = n < units.length && !units[n]!.lineBreak ? placed[n] : null;
    const ref = prev ?? next;
    if (!ref) continue; // nowhere to put it: not shown
    let u0 = prev ? prev.u1 : next!.u0;
    let u1 = u0;
    if (prev && next && compatible(prev, next)) {
      if (next.u0 >= prev.u1) [u0, u1] = [prev.u1, next.u0];
      else if (next.u1 <= prev.u0) [u0, u1] = [next.u1, prev.u0];
    }
    placed[i] = { ...ref, unit: u, u0, u1 };
  }

  const items: TextItem[] = [];
  let span: Placed[] = [];
  let widths: number[] = []; // widths[k]: measured width of the text of span[0..k]
  let sign = 1;
  const emit = () => {
    if (span.length > 0) items.push(toItem(span, sign));
    span = [];
    widths = [];
  };
  const fits = (cand: Placed[], w: number[], s: number) => {
    const first = cand[0]!;
    const last = cand[cand.length - 1]!;
    const start = s > 0 ? first.u0 : first.u1;
    const end = s > 0 ? last.u1 : last.u0;
    const total = w[w.length - 1]!;
    if (!(total > 0)) return false;
    const sx = Math.abs(end - start) / total;
    for (let k = 0; k < cand.length; k++) {
      const near = start + s * sx * (k > 0 ? w[k - 1]! : 0);
      const far = start + s * sx * w[k]!;
      const p = cand[k]!;
      if (Math.abs(near - (s > 0 ? p.u0 : p.u1)) > DRIFT_PX || Math.abs(far - (s > 0 ? p.u1 : p.u0)) > DRIFT_PX) return false;
    }
    return true;
  };
  const text = (p: Placed) => p.unit.text;

  for (let i = 0; i < units.length; i++) {
    const u = units[i]!;
    if (u.lineBreak) {
      emit();
      const last = items[items.length - 1];
      if (last) last.hasEOL = true;
      continue;
    }
    const p = placed[i];
    if (!p) continue;
    if (u.hyphen) {
      emit();
      span = [p];
      emit();
      continue;
    }
    if (span.length === 0) {
      span = [p];
      widths = [measure(text(p), cssFont(p.fsPx))];
      continue;
    }
    if (!compatible(span[span.length - 1]!, p)) {
      emit();
      span = [p];
      widths = [measure(text(p), cssFont(p.fsPx))];
      continue;
    }
    const cand = [...span, p];
    const s = span.length === 1 ? (p.u0 + p.u1 >= span[0]!.u0 + span[0]!.u1 ? 1 : -1) : sign;
    const w = [...widths, measure(cand.map(text).join(''), cssFont(span[0]!.fsPx))];
    if (fits(cand, w, s)) {
      span = cand;
      widths = w;
      sign = s;
    } else {
      emit();
      span = [p];
      widths = [measure(text(p), cssFont(p.fsPx))];
    }
  }
  emit();
  return items;

  function toItem(ps: Placed[], s: number): TextItem {
    const first = ps[0]!;
    const str = ps.map(text).join('');
    const dir = ps.length > 1 ? (s > 0 ? 'ltr' : 'rtl') : RTL_SCRIPT.test(str) ? 'rtl' : 'ltr';
    const u0 = Math.min(...ps.map((p) => p.u0));
    const u1 = Math.max(...ps.map((p) => p.u1));
    const v0 = Math.min(...ps.map((p) => p.v0));
    const v1 = Math.max(...ps.map((p) => p.v1));
    const [c, sn] = direction(first.angle);
    const fs = first.fsPx;
    return {
      str,
      dir,
      transform: [fs * c, fs * sn, -fs * sn, fs * c, u0 * c - v0 * sn, u0 * sn + v0 * c],
      width: u1 - u0,
      height: v1 - v0,
      hasEOL: false,
      start: first.unit.start,
    };
  }
}
