// Caret browsing (ruling R93): where a text cursor can stand on a page, and how it moves, from PDFium's glyphs.
//
// The caret is a position between two chars on the selection's own char model (CharPos: just before char `charIndex`),
// with a side for where it is drawn: 'before' at the leading edge of char `charIndex`, 'after' at the trailing edge of
// char `charIndex − 1`. The side matters only where one char index is both the end of a line and the start of the next
// (a word PDFium joined across a line-end hyphen, or two columns on one PDFium line): the end of the first line is
// 'after', the start of the next is 'before'. A Shift+key selection runs from the anchor to the caret's CharPos, so it
// is exactly a mouse selection.
//
// Lines. A page's chars are cut into lines in PDFium's char order (its reading order: down one column, then the next)
// as the pointer meets them (TextLayer's linesOf): at PDFium's line breaks, after its joined line-end hyphen, where the
// direction changes, where the next glyph leaves the line's band, and at a gap wider than 1.5 line heights. Generated
// spaces (no box) sit in the gap between their neighbours, as the text layer places them. A line's stops are the
// position before each char that can be selected, then its end (after its last char). Chars that show nothing (the
// hidden parts of joined breaks) and chars that cannot be selected (the joined hyphen, chars with no text) get no stop
// of their own.
//
// Geometry is in points, unrotated page space, along each line's own direction (frame(): u along the text, v across it).
import type { PageGlyphs } from '../backend/types';
import { direction, frame, type GlyphUnit, glyphUnits, PDFIUM_HYPHEN, textModel, textModelSlice, wordSegments } from './items';

export type CaretSide = 'before' | 'after';

/** The text cursor: between two chars of a page (CharPos), drawn on `side` (see the file comment). */
export interface CaretPos {
  pageIndex: number;
  charIndex: number;
  side: CaretSide;
}

/** One place on a line the caret can stand. */
export interface CaretStop {
  charIndex: number;
  side: CaretSide;
  /** Its line, as an index into the page's lines. */
  line: number;
  /** Where it is along the line (û, points). */
  u: number;
  /** The caret's extent across the line (v̂, points): the loose box of the glyph beside it. */
  v0: number;
  v1: number;
}

export interface CaretLine {
  angle: number;
  /** In char order; the last is the line's end (side 'after'). */
  stops: CaretStop[];
  /** The index of its first stop in PageCaret.stops. */
  firstStop: number;
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  /** The line's text, for a screen reader. */
  text: string;
}

/** A page's caret stops, by line and all together in reading order. */
export interface PageCaret {
  lines: CaretLine[];
  stops: CaretStop[];
}

/** A gap along a line wider than this many line heights splits it (as TextLayer's LINE_SPLIT_GAP). */
const LINE_SPLIT_GAP = 1.5;

const cache = new WeakMap<PageGlyphs, PageCaret>();

interface Member {
  unit: GlyphUnit;
  /** Extent along û, and across (v̂), in the line's frame; null for a char with no box until it is placed. */
  a: number;
  b: number;
  v0: number;
  v1: number;
  boxed: boolean;
}

/** The page's caret lines and stops (cached per page). */
export function pageCaret(g: PageGlyphs): PageCaret {
  const hit = cache.get(g);
  if (hit) return hit;
  const lines: CaretLine[] = [];
  const chars = textModel(g);
  let cur: { angle: number; members: Member[] } | null = null;
  let stopCount = 0;
  const close = () => {
    if (cur) finish(cur.members, cur.angle);
    cur = null;
  };
  const finish = (members: Member[], angle: number) => {
    // Generated chars at the end of a line (PDFium's space before a break) have nowhere to be shown.
    while (members.length > 0 && !members[members.length - 1].boxed) members.pop();
    const boxed = members.filter((m) => m.boxed);
    if (boxed.length === 0) return;
    const first = boxed[0];
    const last = boxed[boxed.length - 1];
    const forward = boxed.length === 1 ? true : last.a + last.b >= first.a + first.b;
    const lead = (m: Member) => (forward ? m.a : m.b);
    const trail = (m: Member) => (forward ? m.b : m.a);
    // Chars with no box take the gap between their neighbours (buildTextItems does the same). The first member has a
    // box (a line starts with a glyph), and so has the last (trailing generated chars were dropped).
    let prev = members[0];
    for (let k = 0; k < members.length; k++) {
      const m = members[k];
      if (m.boxed) {
        prev = m;
        continue;
      }
      let n = k + 1;
      while (!members[n].boxed) n++;
      const from = trail(prev);
      const to = lead(members[n]);
      [m.a, m.b] = forward ? [from, Math.max(from, to)] : [Math.min(from, to), from];
      m.v0 = prev.v0;
      m.v1 = prev.v1;
    }
    const index = lines.length;
    const stops: CaretStop[] = [];
    for (const m of members) {
      if (m.unit.hyphen) continue; // shown, but never selected or copied
      stops.push({ charIndex: m.unit.start, side: 'before', line: index, u: lead(m), v0: m.v0, v1: m.v1 });
    }
    if (stops.length === 0) return;
    const end = members[members.length - 1];
    stops.push({ charIndex: end.unit.end, side: 'after', line: index, u: trail(end), v0: end.v0, v1: end.v1 });
    lines.push({
      angle,
      stops,
      firstStop: stopCount,
      u0: Math.min(...boxed.map((m) => m.a)),
      u1: Math.max(...boxed.map((m) => m.b)),
      v0: Math.min(...boxed.map((m) => m.v0)),
      v1: Math.max(...boxed.map((m) => m.v1)),
      text: textModelSlice(chars, members[0].unit.start, end.unit.end).replace(/\s+/gu, ' ').trim(),
    });
    stopCount += stops.length;
  };

  for (const u of glyphUnits(g)) {
    if (u.lineBreak) {
      close();
      continue;
    }
    if (u.hidden) continue;
    if (!u.box) {
      // A generated space (or a joined break shown as one): on the line it is in; none before a line's first glyph.
      cur?.members.push({ unit: u, a: 0, b: 0, v0: 0, v1: 0, boxed: false });
      continue;
    }
    if (cur) {
      const c: { angle: number; members: Member[] } = cur;
      const prev = c.members.findLast((m) => m.boxed)!;
      const f = frame(u.box, c.angle);
      const delta = Math.abs(u.angle - c.angle) % 360;
      const across = Math.min(prev.v1, f.v1) - Math.max(prev.v0, f.v0);
      const height = Math.min(prev.v1 - prev.v0, f.v1 - f.v0);
      const gap = Math.max(f.u0 - prev.b, prev.a - f.u1);
      if (Math.min(delta, 360 - delta) > 0.5 || across < 0.3 * height || gap > LINE_SPLIT_GAP * (prev.v1 - prev.v0)) close();
    }
    cur ??= { angle: u.angle, members: [] };
    const f = frame(u.box, cur.angle);
    cur.members.push({ unit: u, a: f.u0, b: f.u1, v0: f.v0, v1: f.v1, boxed: true });
    if (u.text === PDFIUM_HYPHEN) close();
  }
  close();
  const out = { lines, stops: lines.flatMap((l) => l.stops) };
  cache.set(g, out);
  return out;
}

/** The stop for a caret position: the one with its char index and side, else the first at or after it, else the last. */
export function stopIndexOf(p: PageCaret, charIndex: number, side: CaretSide = 'before'): number {
  const s = p.stops;
  if (s.length === 0) return -1;
  // The first stop at or after charIndex (stops are in char order).
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (s[mid].charIndex < charIndex) lo = mid + 1;
    else hi = mid;
  }
  if (lo >= s.length) return s.length - 1;
  // A shared char index: the end of one line ('after') comes before the start of the next ('before').
  if (s[lo].charIndex === charIndex && s[lo].side !== side && lo + 1 < s.length && s[lo + 1].charIndex === charIndex) return lo + 1;
  return lo;
}

/** A page point (x, y) in a line's frame. */
function along(angle: number, x: number, y: number): { u: number; v: number } {
  const f = frame({ x, y, width: 0, height: 0 }, angle);
  return { u: f.u0, v: f.v0 };
}

/** A stop's caret as a segment in page points, from its top (v0) to its bottom (v1). */
export function stopSegment(s: CaretStop, angle: number): { x0: number; y0: number; x1: number; y1: number } {
  const [c, sn] = direction(angle);
  const at = (v: number) => ({ x: s.u * c - v * sn, y: s.u * sn + v * c });
  const a = at(s.v0);
  const b = at(s.v1);
  return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
}

/** The middle of a stop's caret, in page points. */
export function stopPoint(s: CaretStop, angle: number): { x: number; y: number } {
  const g = stopSegment(s, angle);
  return { x: (g.x0 + g.x1) / 2, y: (g.y0 + g.y1) / 2 };
}

/** On line `line`, the stop nearest along it to page point (x, y): ↑/↓ keep the goal position across. */
export function stopOnLine(p: PageCaret, line: number, x: number, y: number): number {
  const l = p.lines[line];
  const { u } = along(l.angle, x, y);
  let best = 0;
  let bestD = Infinity;
  l.stops.forEach((s, j) => {
    const d = Math.abs(s.u - u);
    if (d < bestD) {
      bestD = d;
      best = j;
    }
  });
  return l.firstStop + best;
}

/**
 * The stop nearest page point (x, y): on the line level with it (the white space beside a line belongs to it) nearest
 * along, else on the nearest line; then the stop nearest along that line. A click on a glyph lands before or after it,
 * whichever edge is nearer. −1 for a page with no text.
 */
export function stopNear(p: PageCaret, x: number, y: number): number {
  let best = -1;
  let bestKey: [number, number] = [Infinity, Infinity];
  p.lines.forEach((l, k) => {
    const { u, v } = along(l.angle, x, y);
    const du = Math.max(l.u0 - u, 0, u - l.u1);
    const dv = Math.max(l.v0 - v, 0, v - l.v1);
    const key: [number, number] = dv === 0 ? [0, du] : [1, Math.hypot(du, dv)];
    if (key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
      best = k;
      bestKey = key;
    }
  });
  return best < 0 ? -1 : stopOnLine(p, best, x, y);
}

/** The next stop to the right (+1) or left (−1) in reading order: the next with another char index; −1 past the page. */
export function stepChar(p: PageCaret, from: number, dir: 1 | -1): number {
  const ci = p.stops[from]?.charIndex;
  if (ci === undefined) return -1;
  for (let k = from + dir; k >= 0 && k < p.stops.length; k += dir) {
    if (dir > 0 ? p.stops[k].charIndex > ci : p.stops[k].charIndex < ci) return k;
  }
  return -1;
}

/**
 * Ctrl+→ (+1): the start of the next word after the caret, as Chrome does on Windows; past the last word, the end of the
 * page's text. Ctrl+← (−1): the start of the word the caret is in or after; −1 when there is none before it on the page.
 * Words are the double-click's (wordSegments). −1 when the caret is at the page's end already (+1).
 */
export function stepWord(p: PageCaret, g: PageGlyphs, from: number, dir: 1 | -1): number {
  const ci = p.stops[from]?.charIndex;
  if (ci === undefined) return -1;
  const words = wordSegments(g).filter((w) => w.wordLike && w.start >= 0);
  if (dir > 0) {
    const next = words.find((w) => w.start > ci);
    if (next) return stopIndexOf(p, next.start, 'before');
    const last = p.stops.length - 1;
    return last > from && p.stops[last].charIndex > ci ? last : -1;
  }
  const prev = words.findLast((w) => w.start < ci);
  return prev ? stopIndexOf(p, prev.start, 'before') : -1;
}

/** Text a screen reader hears for the line of stop `k`. */
export function lineTextOf(p: PageCaret, k: number): string {
  const s = p.stops[k];
  return s ? (p.lines[s.line]?.text ?? '') : '';
}

/** The caret position of stop `k` of page `pageIndex`. */
export function caretAt(p: PageCaret, pageIndex: number, k: number): CaretPos {
  const s = p.stops[k];
  return { pageIndex, charIndex: s.charIndex, side: s.side };
}
