// PDFium glyphs → pdf.js-style text items for the text layer (text-layer.ts), and the page's text model: what the layer
// shows and what Copy writes. Ported from the Phase 0 spike (P0-4), which passed with every char edge within about
// 0.5 px of PDFium's box and 20/20 seeded drags on nine pages.
//
// Geometry: everything is in CSS px at `scale` (CSS px per point) in the unrotated page's frame (origin top-left,
// y down); the page's /Rotate is applied to the whole layer, not here. A text direction θ is clockwise as displayed
// (Glyph.angle): the text runs along û = (cos θ, sin θ) and "down" from its ascender to its descender is
// v̂ = (−sin θ, cos θ). u and v below are coordinates along û and v̂.
//
// The text model. The layer shows PDFium's text (FPDFText_GetText), so selecting and copying give what Chrome's viewer
// gives (R26), with one repair: PDFium sometimes puts a generated line break between glyphs that sit on one line (every
// glyph of a rotated table cell is its own text object, and every superscript starts a "line" of its own), so a rotated
// header copies as "Statio⏎n⏎D⏎e⏎pth" and x² as "x⏎2". Such a break is joined when the glyph after it continues the
// same baseline or the same word (lineBreakJoins): it is dropped, or shown as one space when the glyphs are a word gap
// or more apart. The layer and Copy use the same joins, so the text a reader copies is the text a screen reader reads.
import type { Glyph, PageGlyphs, PdfRect } from '../backend/types';

export interface TextItem {
  /** The text the span shows: the chars [start, start + str.length) as the text model has them. */
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
export const PDFIUM_HYPHEN = '\ufffe';
/**
 * PageGlyphs.text for a char that has no single UTF-16 unit of text (a maths italic letter beyond the BMP, or a glyph
 * whose font maps it to nothing); getTextRange drops it.
 */
export const NO_TEXT = '\uffff';
/** Largest predicted-vs-PDFium edge error allowed inside one item before it is split. */
export const DRIFT_PX = 0.5;

/** What getTextRange removes from FPDFText_GetText (EmbedPDF's stripPdfUnwantedMarkers): soft hyphen, ZWSP, word joiner, BOM, U+FFFE, U+FFFF. */
const NOT_TEXT = /[\u00ad\u200b\u2060\ufeff\ufffe\uffff]/g;
const LIGATURES: Record<string, string> = { '\ufb00': 'ff', '\ufb01': 'fi', '\ufb02': 'fl', '\ufb03': 'ffi', '\ufb04': 'ffl', '\ufb05': 'st', '\ufb06': 'st' };

/** Copied text as a reader wants it: the ligature chars U+FB00–U+FB06 as their letters, and no U+0000. */
export function normalizeCopiedText(s: string): string {
  return s.replace(/[\ufb00-\ufb06]/g, (c) => LIGATURES[c] ?? c).replaceAll('\u0000', '');
}

/**
 * One character as the text layer sees it: a code point (an astral char is two PDFium chars), with its own box.
 * Chars that share one PDFium box (ligature expansions such as "ffi") get equal shares of its width along û.
 */
export interface GlyphUnit {
  start: number;
  /** Exclusive. */
  end: number;
  /** What the layer shows for it (a joined line break shown as a space is ' '). */
  text: string;
  /** Points, unrotated page space; null for a generated char or an empty box. */
  box: PdfRect | null;
  angle: number;
  fontSize: number;
  generated: boolean;
  /** '\r' or '\n': a line break, not shown (the layer adds a <br>). */
  lineBreak: boolean;
  /** Part of a joined line break that shows nothing: not in the layer, and not copied. */
  hidden: boolean;
  /**
   * PDFium's joined line-end hyphen (PDFIUM_HYPHEN), or a char with no text (NO_TEXT): an item of its own, shown but not
   * selectable or copied, as getTextRange drops it.
   */
  hyphen: boolean;
}

const isHigh = (s: string) => s.length === 1 && s.charCodeAt(0) >= 0xd800 && s.charCodeAt(0) <= 0xdbff;
const isLow = (s: string) => s.length === 1 && s.charCodeAt(0) >= 0xdc00 && s.charCodeAt(0) <= 0xdfff;
const isBreak = (g: Glyph) => g.text === '\r' || g.text === '\n';
const isSpace = (g: Glyph | undefined) => g !== undefined && /^\s$/.test(g.text);
const sameBox = (a: PdfRect, b: PdfRect) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const hasBox = (g: Glyph) => !g.generated && !isBreak(g) && g.box.width > 0 && g.box.height > 0;
const RTL_SCRIPT = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]|\ud802[\udc00-\udfff]|\ud83a[\udc00-\udfff]/;

/** cos and sin of a direction in degrees, exact for multiples of 90°. */
export function direction(angle: number): [number, number] {
  const q = angle / 90;
  if (Math.abs(q - Math.round(q)) < 1e-6) {
    const k = ((Math.round(q) % 4) + 4) % 4;
    return [[1, 0, -1, 0][k], [0, 1, 0, -1][k]];
  }
  const t = (angle * Math.PI) / 180;
  return [Math.cos(t), Math.sin(t)];
}

/** A box's interval along û and across it (v̂), in its own units. */
function frame(box: PdfRect, angle: number): { u0: number; u1: number; v0: number; v1: number } {
  const [c, s] = direction(angle);
  const us: number[] = [];
  const vs: number[] = [];
  for (const x of [box.x, box.x + box.width]) {
    for (const y of [box.y, box.y + box.height]) {
      us.push(x * c + y * s);
      vs.push(-x * s + y * c);
    }
  }
  return { u0: Math.min(...us), u1: Math.max(...us), v0: Math.min(...vs), v1: Math.max(...vs) };
}

const angleDelta = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
};

const joinCache = new WeakMap<PageGlyphs, Map<number, string>>();

/**
 * PDFium's generated line breaks that the text model joins, keyed by the index of the break's first char ('\r'), with
 * what it is shown and copied as: '' or ' '. The other chars of a joined break show nothing. A break is joined when the
 * glyph after it (n) continues the line of the glyph before it (p), in the same direction:
 * - n continues p's word: it starts within 0.12 line heights after p ends and shares at least 0.3 of the smaller line
 *   height across (a superscript after its base, the next letter of a rotated word) → '';
 * - n is on p's baseline band (they share 0.7 of the smaller height, centres within 0.25), up to 10 line heights away
 *   (the next cell of a rotated table header) → ' ';
 * - n follows p within 1.5 line heights, sharing 0.3 across (the word after a superscript) → ' '.
 * "Line height" is the smaller of the two loose-box heights. Where a space is already there (p or n is one), nothing is
 * added. A break between lines (the next glyph starts the next line) is kept.
 */
export function lineBreakJoins(g: PageGlyphs): Map<number, string> {
  const hit = joinCache.get(g);
  if (hit) return hit;
  const joins = new Map<number, string>();
  const glyphs = g.glyphs;
  for (let i = 0; i < glyphs.length; i++) {
    const first = glyphs[i];
    if (!isBreak(first) || !first.generated) continue;
    let after = i;
    while (after < glyphs.length && isBreak(glyphs[after]) && glyphs[after].generated) after++;
    const join = breakJoin(glyphs, i, after);
    if (join !== null) joins.set(i, join);
    i = after - 1;
  }
  joinCache.set(g, joins);
  return joins;
}

function breakJoin(glyphs: Glyph[], at: number, after: number): string | null {
  let pi = at - 1;
  while (pi >= 0 && !hasBox(glyphs[pi]) && !isBreak(glyphs[pi])) pi--;
  const p = glyphs[pi];
  const n = glyphs[after];
  if (!p || !n || !hasBox(p) || !hasBox(n) || angleDelta(p.angle, n.angle) > 0.5) return null;
  const a = frame(p.box, p.angle);
  const b = frame(n.box, p.angle);
  const size = Math.min(a.v1 - a.v0, b.v1 - b.v0);
  if (!(size > 0)) return null;
  const across = Math.min(a.v1, b.v1) - Math.max(a.v0, b.v0);
  const gap = Math.max(b.u0 - a.u1, a.u0 - b.u1);
  const forward = b.u0 + b.u1 > a.u0 + a.u1;
  const aligned = across >= 0.7 * size && Math.abs((a.v0 + a.v1) / 2 - (b.v0 + b.v1) / 2) <= 0.25 * size;
  const touching = forward && across >= 0.3 * size;
  const space = isSpace(glyphs[at - 1]) || isSpace(n) ? '' : ' ';
  if (touching && gap <= 0.12 * size) return '';
  if (aligned && gap <= 10 * size) return gap <= 0.12 * size ? '' : space;
  if (touching && gap <= 1.5 * size) return space;
  return null;
}

/**
 * What each char contributes to the text model: its text, or for a joined line break, the join text on its first char
 * and nothing on the others.
 */
const modelCache = new WeakMap<PageGlyphs, string[]>();

function modelChars(g: PageGlyphs): string[] {
  const hit = modelCache.get(g);
  if (hit) return hit;
  const glyphs = g.glyphs;
  const joins = lineBreakJoins(g);
  const out = glyphs.map((c) => c.text);
  for (const [at, join] of joins) {
    out[at] = join;
    for (let k = at + 1; k < glyphs.length && isBreak(glyphs[k]) && glyphs[k].generated; k++) out[k] = '';
  }
  modelCache.set(g, out);
  return out;
}

/**
 * The text of chars [start, end) as Copy writes it: PDFium's text (cleaned as getTextRange cleans it), with the joined
 * line breaks of lineBreakJoins, and normalizeCopiedText.
 */
export function textModelRange(g: PageGlyphs, start: number, end: number): string {
  const chars = modelChars(g);
  return normalizeCopiedText(chars.slice(Math.max(0, start), Math.max(0, end)).join('').replace(NOT_TEXT, ''));
}

/** The page's chars as units: surrogate pairs joined, ligature boxes split equally, joined line breaks applied. */
export function glyphUnits(g: PageGlyphs): GlyphUnit[] {
  const units: GlyphUnit[] = [];
  const glyphs = g.glyphs;
  const joins = lineBreakJoins(g);
  for (let i = 0; i < glyphs.length; i++) {
    const c = glyphs[i];
    const join = joins.get(i);
    if (join !== undefined) {
      // A joined break: its first char shows `join` (a space, placed in the gap like a generated space) or nothing.
      let end = i + 1;
      while (end < glyphs.length && isBreak(glyphs[end]) && glyphs[end].generated) end++;
      for (let k = i; k < end; k++) {
        const shown = k === i && join !== '';
        units.push({ start: k, end: k + 1, text: shown ? join : '', box: null, angle: c.angle, fontSize: c.fontSize, generated: true, lineBreak: false, hidden: !shown, hyphen: false });
      }
      i = end - 1;
      continue;
    }
    const pair = isHigh(c.text) && i + 1 < glyphs.length && isLow(glyphs[i + 1].text);
    const lineBreak = isBreak(c);
    units.push({
      start: i,
      end: pair ? i + 2 : i + 1,
      text: pair ? c.text + glyphs[i + 1].text : c.text,
      box: hasBox(c) ? { ...c.box } : null,
      angle: c.angle,
      fontSize: c.fontSize,
      generated: c.generated,
      lineBreak,
      hidden: false,
      hyphen: c.text === PDFIUM_HYPHEN || c.text === NO_TEXT,
    });
    if (pair) i++;
  }
  // Ligature expansions: consecutive units with the very same PDFium box share it equally along û.
  for (let i = 0; i < units.length; ) {
    let j = i + 1;
    const box = units[i].box;
    if (box) while (j < units.length && units[j].box && sameBox(units[j].box!, box) && units[j].angle === units[i].angle) j++;
    if (j - i > 1) splitAlongText(units.slice(i, j), box!, units[i].angle);
    i = j;
  }
  return units;
}

function splitAlongText(cluster: GlyphUnit[], box: PdfRect, angle: number): void {
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

function place(unit: GlyphUnit, box: PdfRect, scale: number, angle: number, fontSize: number): Placed {
  const f = frame({ x: box.x * scale, y: box.y * scale, width: box.width * scale, height: box.height * scale }, angle);
  return { unit, ...f, fsPx: fontSize * scale, angle };
}

/** Two units can sit in one span: same direction, size (within 2%) and line band. */
function compatible(a: Placed, b: Placed): boolean {
  if (angleDelta(a.angle, b.angle) > 0.5) return false;
  if (Math.abs(a.fsPx - b.fsPx) > 0.02 * Math.max(a.fsPx, b.fsPx)) return false;
  const tol = 0.2 * Math.max(a.fsPx, b.fsPx);
  return Math.abs(a.v0 - b.v0) <= tol && Math.abs(a.v1 - b.v1) <= tol;
}

/**
 * Splits the page into text items with the "drift-split" rule: a span keeps growing while one horizontal scale (its
 * width over the measured width of its text) puts every char's both edges within DRIFT_PX of PDFium's box; otherwise
 * the span is emitted and the char starts the next one.
 * - Runs are not split points. PageGlyphs.runs are PDFium text objects, and Chromium's PDF output makes one text object
 *   per glyph cluster, so honouring them would make every glyph its own span. Spans split instead where the direction,
 *   font size or line band changes, at line breaks, and wherever the drift rule says.
 * - A generated space (or a joined line break shown as a space) is placed in the gap between its neighbours; '\r\n'
 *   ends the item (hasEOL). The chars of a joined break that show nothing end the item without a line break.
 * - PDFium's joined line-end hyphen, and a char with no text, is an item of its own (the layer shows it unselectable).
 * - A span's direction comes from its first two chars' order along û (rtl when the second lies before the first); a
 *   one-char span is rtl when its char is in an RTL script.
 * `measure(text, cssFont)` must measure like the layer renders: font-kerning none, ligatures none, white-space pre.
 */
export function buildTextItems(g: PageGlyphs, measure: (text: string, cssFont: string) => number, scale: number): TextItem[] {
  const units = glyphUnits(g);
  const placed: (Placed | null)[] = units.map((u) => (u.box ? place(u, u.box, scale, u.angle, u.fontSize) : null));
  // A unit with no box (a generated space) takes the gap between its neighbours on the line.
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (placed[i] || u.lineBreak || u.hidden) continue;
    let p = i - 1;
    while (p >= 0 && !placed[p] && !units[p].lineBreak) p--;
    let n = i + 1;
    while (n < units.length && !placed[n] && !units[n].lineBreak) n++;
    const prev = p >= 0 && !units[p].lineBreak ? placed[p] : null;
    const next = n < units.length && !units[n].lineBreak ? placed[n] : null;
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
    const first = cand[0];
    const last = cand[cand.length - 1];
    const start = s > 0 ? first.u0 : first.u1;
    const end = s > 0 ? last.u1 : last.u0;
    const total = w[w.length - 1];
    if (!(total > 0)) return false;
    const sx = Math.abs(end - start) / total;
    for (let k = 0; k < cand.length; k++) {
      const near = start + s * sx * (k > 0 ? w[k - 1] : 0);
      const far = start + s * sx * w[k];
      const p = cand[k];
      if (Math.abs(near - (s > 0 ? p.u0 : p.u1)) > DRIFT_PX || Math.abs(far - (s > 0 ? p.u1 : p.u0)) > DRIFT_PX) return false;
    }
    return true;
  };
  const text = (p: Placed) => p.unit.text;

  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (u.lineBreak) {
      emit();
      const last = items[items.length - 1];
      if (last) last.hasEOL = true;
      continue;
    }
    if (u.hidden) {
      emit(); // char indices skip here, so the span cannot go on
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
    if (!compatible(span[span.length - 1], p)) {
      emit();
      span = [p];
      widths = [measure(text(p), cssFont(p.fsPx))];
      continue;
    }
    const cand = [...span, p];
    const s = span.length === 1 ? (p.u0 + p.u1 >= span[0].u0 + span[0].u1 ? 1 : -1) : sign;
    const w = [...widths, measure(cand.map(text).join(''), cssFont(span[0].fsPx))];
    if (fits(cand, w, s)) {
      span = cand;
      widths = w;
      sign = s;
      continue;
    }
    emit();
    span = [p];
    widths = [measure(text(p), cssFont(p.fsPx))];
  }
  emit();
  builtAt.set(items, scale);
  return items;

  function toItem(ps: Placed[], s: number): TextItem {
    const first = ps[0];
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

/** The scale each buildTextItems result was built at (renderTextLayer reads it to place the items in points). */
const builtAt = new WeakMap<TextItem[], number>();

/** The `scale` buildTextItems was called with for these items; undefined for items made some other way. */
export function itemsScale(items: TextItem[]): number | undefined {
  return builtAt.get(items);
}

/**
 * The word a double-click on char `charIndex` selects (R28), as chars [start, end): Intl.Segmenter's word around it
 * over the text model, where PDFium's joined line-end hyphen and the joined breaks show nothing, so a word hyphenated
 * across two lines is one word. A double-click on a space selects the run of spaces, as in a web page.
 */
export function wordAt(g: PageGlyphs, charIndex: number): { start: number; end: number } | null {
  const chars = modelChars(g);
  if (charIndex < 0 || charIndex >= chars.length) return null;
  const at: number[] = []; // at[i]: char i's offset in `text`
  let text = '';
  for (let i = 0; i < chars.length; i++) {
    at.push(text.length);
    text += chars[i].replace(NOT_TEXT, '');
  }
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
  const seg = segmenter.segment(text).containing(at[charIndex]);
  if (!seg) return null;
  const s0 = seg.index;
  const s1 = seg.index + seg.segment.length;
  let start = -1;
  let end = -1;
  for (let i = 0; i < chars.length; i++) {
    const len = chars[i].replace(NOT_TEXT, '').length;
    if (len === 0) continue;
    if (at[i] >= s0 && at[i] < s1) {
      if (start < 0) start = i;
      end = i + 1;
    }
  }
  return start < 0 ? null : { start, end };
}

/**
 * The line a triple-click on char `charIndex` selects: the chars between the text model's line breaks around it. A line
 * that ends in PDFium's joined hyphen ends there (PDFium joins the word across the break with no line break of its own).
 */
export function lineAt(g: PageGlyphs, charIndex: number): { start: number; end: number } | null {
  const chars = modelChars(g);
  if (charIndex < 0 || charIndex >= chars.length) return null;
  const isBreakChar = (i: number) => chars[i] === '\r' || chars[i] === '\n';
  let start = charIndex;
  while (start > 0 && !isBreakChar(start - 1) && chars[start - 1] !== PDFIUM_HYPHEN) start--;
  let end = charIndex;
  while (end < chars.length && !isBreakChar(end) && chars[end] !== PDFIUM_HYPHEN) end++;
  if (end < chars.length && chars[end] === PDFIUM_HYPHEN) end++;
  return end > start ? { start, end } : null;
}
